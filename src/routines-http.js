// HTTP surface of Coordinator routines (spec 2026-10-01 coordinator
// routines): the list any device may read, the writes the user (a client
// token) or the user's Coordinator may make — create and delete included —
// and `run`, which fires a routine now through the same path the sweep
// uses (src/routines-sweep.js). Validation lives in routines.js; this layer
// owns auth, the status mapping and the marker.
//
// Provenance: the Coordinator's create, its rewrite of what a routine does
// (prompt, schedule, trigger, envelope) and its run-now need the user's own
// ask behind them — the bridge stamps each request with the causes of the
// turn that made it, and those must resolve (src/ask-cause.js) to the user's
// words in the Coordinator conversation or the user's comment on one of its
// items. A routine fire is not enough: an injected turn could otherwise
// write a routine with its own prompt and envelope, run it, and approve its
// own asks inside the fire. Pausing, retitling, a zone change and delete
// stay open — none of them widens what a routine may do.
import { json, readBody } from './http-body.js'
import { badRequest, notFound, senderOf } from './http-who.js'
import { closingConvo, refusedCloser, byOf } from './missions-http.js'
import {
  validateRoutineFields, createRoutine, updateRoutine, deleteRoutine, getRoutine, listRoutines, markRun, NAME_RE,
} from './routines.js'
import { emitRoutineMarker } from './routines-marker.js'
import { coordinatorDevice } from './consent.js'
import { currentSubjects, fireMessage } from './routines-triggers.js'
import { causesFromFrame } from './ask-causes.js'
import { resolveAskCause } from './ask-cause.js'

// The PATCH fields that change what a routine does when it fires.
const GATED_FIELDS = ['prompt', 'schedule', 'trigger', 'envelope']
export const WHY_ROUTINE_ROOT = 'a routine fire cannot create, rewrite or run routines'
const badCauses = (res) => { json(res, 400, { error: 'bad_request', detail: 'bad causes' }); return true }

const conflict = (res, blockedBy) => { json(res, 409, { error: 'conflict', blocked_by: blockedBy }); return true }

// The Coordinator gate on agent writes: the same rule project close/merge
// use — an agent must name its own conversation and it must be the user's
// Coordinator (403 not_coordinator), a conversation it does not own is 404,
// a malformed convo_id 400. A client token passes with no convo_id.
// → the closer ({convoId}: null for a client token), or null when answered.
// Bad causes are 400 on every write, delete included, whoever sends them.
function gate(db, who, res, body) {
  const closer = closingConvo(db, who, body.convo_id, { required: true })
  if (refusedCloser(res, closer)) return null
  const causes = causesFromFrame(body)
  if (!causes.ok) { badCauses(res); return null }
  return { convoId: closer.convoId, causes: causes.causes }
}

// The provenance check for a Coordinator write (a client token is the user).
// True when it answered 403.
function unverified(db, who, res, closer) {
  if (closer.convoId == null) return false
  const r = resolveAskCause(db, { who, userId: who.userId, causes: closer.causes, createdAt: Date.now(), fromConvoId: closer.convoId })
  if (r.ok && (r.root.kind === 'user' || r.root.kind === 'item')) return false
  json(res, 403, { error: 'forbidden', detail: 'routine_write_unverified', why: r.ok ? WHY_ROUTINE_ROOT : r.why })
  return true
}

export async function handleRoutinesRoute(ctx, req, res, url, who) {
  const { db } = ctx
  if (url.pathname === '/routines') {
    if (req.method === 'GET') { json(res, 200, { routines: listRoutines(db, who.userId) }); return true }
    if (req.method !== 'POST') return false
    const body = await readBody(req)
    const closer = gate(db, who, res, body)
    if (!closer) return true
    const v = validateRoutineFields(body)
    if (!v.ok) return badRequest(res)
    if (unverified(db, who, res, closer)) return true
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
    const closer = gate(db, who, res, body)
    if (!closer) return true
    const routine = getRoutine(db, who.userId, key)
    if (!routine) return notFound(res)
    if (unverified(db, who, res, closer)) return true
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
    const message = routine.trigger ? fireMessage(db, row, currentSubjects(db, row, { now: Date.now() })) : null
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
    const closer = gate(db, who, res, body)
    if (!closer) return true
    const v = validateRoutineFields(body, { partial: true })
    if (!v.ok || Object.keys(v.value).length === 0) return badRequest(res)
    if (GATED_FIELDS.some((k) => k in v.value) && unverified(db, who, res, closer)) return true
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
    // The same gate as the other writes: the user, or the Coordinator
    // naming its own conversation (the Coordinator creates and deletes
    // routines itself). The marker says who, as for a save.
    const body = await readBody(req)
    if (!gate(db, who, res, body)) return true
    const routine = deleteRoutine(db, who.userId, key)
    if (!routine) return notFound(res)
    emitRoutineMarker(ctx, who.userId, { routine, action: 'deleted', by: byOf(who), sender: senderOf(db, who) })
    json(res, 200, { ok: true })
    return true
  }
  return false
}
