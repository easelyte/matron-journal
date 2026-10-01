// HTTP surface of Coordinator routines (spec 2026-10-01 coordinator
// routines): the list any device may read, the writes the user (a client
// token) or the user's Coordinator may make, the delete only the user may,
// and `run`, which fires a routine now through the same path the sweep
// uses (src/routines-sweep.js). Validation lives in routines.js; this layer
// owns auth, the status mapping and the marker.
import { json, readBody } from './http-body.js'
import { badRequest, notFound, senderOf } from './http-who.js'
import { closingConvo, refusedCloser, byOf } from './missions-http.js'
import {
  validateRoutineFields, createRoutine, updateRoutine, deleteRoutine, getRoutine, listRoutines, markRun, NAME_RE,
} from './routines.js'
import { emitRoutineMarker } from './routines-marker.js'
import { coordinatorDevice } from './consent.js'
import { currentSubjects, trigMessage } from './routines-triggers.js'

const conflict = (res, blockedBy) => { json(res, 409, { error: 'conflict', blocked_by: blockedBy }); return true }

// The Coordinator gate on agent writes: the same rule project close/merge
// use — an agent must name its own conversation and it must be the user's
// Coordinator (403 not_coordinator), a conversation it does not own is 404,
// a malformed convo_id 400. A client token passes with no convo_id.
function gate(db, who, res, body) {
  return refusedCloser(res, closingConvo(db, who, body.convo_id, { required: true }))
}

export async function handleRoutinesRoute(ctx, req, res, url, who) {
  const { db } = ctx
  if (url.pathname === '/routines') {
    if (req.method === 'GET') { json(res, 200, { routines: listRoutines(db, who.userId) }); return true }
    if (req.method !== 'POST') return false
    const body = await readBody(req)
    if (gate(db, who, res, body)) return true
    const v = validateRoutineFields(body)
    if (!v.ok) return badRequest(res)
    let routine
    try {
      routine = createRoutine(db, { userId: who.userId, origin: byOf(who), fields: v.value })
    } catch (err) {
      if (err.message === 'conflict') return conflict(res, 'name')
      if (err.message === 'cap') return conflict(res, 'cap')
      throw err
    }
    emitRoutineMarker(ctx, who.userId, { routine, action: 'saved', by: byOf(who), created: true, sender: senderOf(db, who) })
    json(res, 201, { routine })
    return true
  }
  const m = /^\/routines\/([^/]+)(\/run)?$/.exec(url.pathname)
  if (!m) return false
  let key
  try { key = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  if (!(key.startsWith('rt_') || NAME_RE.test(key))) return badRequest(res)
  if (m[2]) {
    if (req.method !== 'POST') return false
    const body = await readBody(req)
    if (gate(db, who, res, body)) return true
    const routine = getRoutine(db, who.userId, key)
    if (!routine) return notFound(res)
    const row = { ...routine, user_id: who.userId }
    if (!ctx.routineFirer) { json(res, 202, { delivered: false, reason: 'no_firer' }); return true }
    if (ctx.routineFirer.busy()) { json(res, 202, { delivered: false, reason: 'busy' }); return true }
    // Resolve the Coordinator here so the body can say so: the firer records
    // the same outcome either way.
    if (!coordinatorDevice(db, who.userId)) {
      await ctx.routineFirer.fire(row)
      json(res, 202, { delivered: false, reason: 'no_coordinator' })
      return true
    }
    markRun(db, routine.id)
    json(res, 202, { accepted: true })
    // A triggered routine run by hand carries whatever is tripped right now
    // (state untouched, so the sweep's own bookkeeping is unaffected).
    const message = routine.trigger ? trigMessage(routine.prompt, currentSubjects(db, row, { now: Date.now() })) : null
    void ctx.routineFirer.fire(row, { message, onOutcome: (outcome) => db.prepare('UPDATE routines SET last_outcome=? WHERE id=?').run(outcome, routine.id) })
      .catch((err) => console.error(`routines: run of ${routine.name} failed`, err))
    return true
  }
  if (req.method === 'GET') {
    const routine = getRoutine(db, who.userId, key)
    if (!routine) return notFound(res)
    json(res, 200, { routine })
    return true
  }
  if (req.method === 'PATCH') {
    const body = await readBody(req)
    if (gate(db, who, res, body)) return true
    const v = validateRoutineFields(body, { partial: true })
    if (!v.ok || Object.keys(v.value).length === 0) return badRequest(res)
    let routine
    try {
      routine = updateRoutine(db, { userId: who.userId, key, fields: v.value })
    } catch (err) {
      if (err.message === 'bad_schedule' || err.message === 'mixed') return badRequest(res)
      throw err
    }
    if (!routine) return notFound(res)
    emitRoutineMarker(ctx, who.userId, { routine, action: 'saved', by: byOf(who), created: false, sender: senderOf(db, who) })
    json(res, 200, { routine })
    return true
  }
  if (req.method === 'DELETE') {
    // The user's list, the user's delete: an agent — the Coordinator
    // included — may pause a routine, never remove it.
    if (who.kind !== 'client') { json(res, 403, { error: 'forbidden' }); return true }
    const routine = deleteRoutine(db, who.userId, key)
    if (!routine) return notFound(res)
    emitRoutineMarker(ctx, who.userId, { routine, action: 'deleted', by: 'user', sender: senderOf(db, who) })
    json(res, 200, { ok: true })
    return true
  }
  return false
}
