// HTTP surface of missions & milestones (spec 2026-09-10, "HTTP API").
// Validation, auth, the privacy sieve, and the side effects the pure
// module must not know about: the 'mission' and 'milestone' marker events.
// No wake, no push: both markers are navigation, not attention.
import { append, appendAndBroadcast, broadcastAppended } from './journal.js'
import { isPrivateDevice } from './db.js'
import { authorizeAgentWrite } from './auth.js'
import { json, readBody } from './http-body.js'
import { idemKeyOf, senderOf, badRequest, notFound, conflict } from './http-who.js'
import { BODY_MAX } from './items.js'
import {
  MILESTONE_KINDS, TITLE_MAX, validateMissionFields, createMission, getMission, listMissions, missionDetail,
  updateMission, joinMission, closeMission, createMilestone, listMilestones, milestoneRow,
} from './missions.js'
import { MISSION_EVENT_TYPE, MILESTONE_EVENT_TYPE, missionMarkerPayload, milestoneMarkerPayload } from './missions-marker.js'
import { filteredAgent, privateOwnedConvo, markerTitleAllowed } from './privacy.js'

const STATES = ['open', 'closed']

const byOf = (who) => (who.kind === 'agent' ? 'agent' : 'user')

// Visible = owned by the caller's user and, for an ordinary agent, not born
// in a private device's conversation. Same 404 for every failure. Exported
// (Task 7 review, Critical 3) so items-http.js's PATCH /items/:id {mission}
// gates a move target through the exact same rule GET /missions/:id uses —
// a mission invisible to a GET must not become reachable as a move target,
// or as an existence oracle, through a different route.
//
// A thin wrapper now (final review, C1): the origin sieve itself moved into
// getMission, so the routes that resolve a mission from a CONVERSATION
// instead of from an :id — POST /missions, POST /milestones — are gated by
// the same rule without having to remember to call this.
export const visibleMission = (db, who, idOrNum) =>
  getMission(db, who.userId, idOrNum, { excludePrivateOwned: filteredAgent(db, who) })

// The conversation gate for the two routes that target a conversation
// rather than an already-visible mission (create, milestone, join).
function writableConvo(db, who, convoId) {
  if (typeof convoId !== 'string' || !convoId) return false
  const convo = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(convoId)
  if (!convo || convo.owner_user_id !== who.userId) return false
  if (who.kind === 'agent' && !authorizeAgentWrite(db, who.userId, who.deviceId, convoId)) return false
  if (filteredAgent(db, who) && convo.agent_device_id != null && isPrivateDevice(db, convo.agent_device_id)) return false
  return true
}

// Mission markers are written AFTER the mission's transaction committed —
// never inside it (same stance as items' emitMarker).
//
// `withTitle` (fix round 2, Critical): `joined` is appended into whatever
// conversation the user joined, which may be PUBLIC while the mission was
// born private — the title is dropped there. `created`/`updated`/`closed`
// always target the origin conversation, so the predicate is a no-op for
// them; it is applied uniformly anyway rather than per-action, so a future
// action written elsewhere is covered by construction.
function emitMissionMarker({ db, hub }, who, { mission, action, convoId, openItemNums = null }) {
  const payload = missionMarkerPayload({
    mission, action, by: byOf(who), openItemNums,
    withTitle: markerTitleAllowed(db, mission.origin_convo_id, convoId),
  })
  try {
    appendAndBroadcast(db, hub, { userId: who.userId, convoId, sender: senderOf(db, who), type: MISSION_EVENT_TYPE, payload })
  } catch (err) {
    console.error('missions: marker append failed (mission write already committed)', err)
  }
}

async function handleCreate(ctx, req, res, who) {
  const { db } = ctx
  const body = await readBody(req)
  const v = validateMissionFields(body)
  if (!v.ok) return badRequest(res)
  const idemKey = idemKeyOf(req, who)
  if (idemKey === undefined) return badRequest(res)
  if (!writableConvo(db, who, body.convo_id)) return notFound(res)
  let out
  try {
    out = createMission(db, {
      userId: who.userId, deviceId: who.deviceId, createdBy: byOf(who), convoId: body.convo_id,
      title: v.value.title, body: v.value.body ?? '', idemKey, excludePrivateOwned: filteredAgent(db, who),
    })
  } catch (err) {
    // TOCTOU: writableConvo just confirmed the convo, but it can vanish
    // between that check and this write (never a real 500).
    if (err.message === 'no_convo') return notFound(res)
    throw err
  }
  // getMission sieved the row away: the conversation belongs to a mission
  // this caller may not see (final review, C1). Same 404 as an unknown
  // mission — answering "existing, but here is nothing" would still confirm
  // that a hidden mission owns this conversation. Nothing was written on
  // either of those two branches, so there is nothing to undo. (The freshly
  // created branch cannot be null: writableConvo already refused a
  // private-owned conversation for a filtered caller.)
  if (!out.mission) return notFound(res)
  if (out.existing) { json(res, 200, { mission: out.mission, existing: true }); return true }
  if (out.duplicate) { json(res, 200, { mission: out.mission }); return true }
  emitMissionMarker(ctx, who, { mission: out.mission, action: 'created', convoId: body.convo_id })
  json(res, 201, { mission: out.mission })
  return true
}

function handleList(ctx, res, url, who) {
  const { db } = ctx
  const state = url.searchParams.get('state')
  if (state != null && !STATES.includes(state)) return badRequest(res)
  let since = null
  if (url.searchParams.has('since')) {
    since = Number(url.searchParams.get('since'))
    if (!Number.isFinite(since) || since < 0) return badRequest(res)
  }
  json(res, 200, { missions: listMissions(db, who.userId, { state, since, excludePrivateOwned: filteredAgent(db, who) }) })
  return true
}

async function handlePatch(ctx, req, res, who, mission) {
  const { db } = ctx
  const body = await readBody(req)
  const v = validateMissionFields(body, { partial: true })
  if (!v.ok || Object.keys(v.value).length === 0) return badRequest(res)
  let updated
  try {
    updated = updateMission(db, { userId: who.userId, missionId: mission.id, fields: v.value, excludePrivateOwned: filteredAgent(db, who) })
  } catch (err) { if (err.message === 'closed') return conflict(res, { blocked_by: 'closed' }); throw err }
  if (!updated) return notFound(res)
  emitMissionMarker(ctx, who, { mission: updated, action: 'updated', convoId: updated.origin_convo_id })
  json(res, 200, { mission: updated })
  return true
}

async function handleJoin(ctx, req, res, who, mission) {
  const { db } = ctx
  const body = await readBody(req)
  if (!writableConvo(db, who, body.convo_id)) return notFound(res)
  const already = db.prepare('SELECT mission_id FROM conversations WHERE id=?').get(body.convo_id)?.mission_id
  let joined
  try {
    joined = joinMission(db, { userId: who.userId, missionId: mission.id, convoId: body.convo_id, excludePrivateOwned: filteredAgent(db, who) })
  } catch (err) {
    if (err.message === 'closed' || err.message === 'other_mission') return conflict(res, { blocked_by: err.message })
    if (err.message === 'too_many_convos') return badRequest(res)
    // TOCTOU: the mission/convo were confirmed a moment ago (visibleMission,
    // writableConvo) but either can vanish before this write.
    if (err.message === 'no_mission' || err.message === 'no_convo') return notFound(res)
    throw err
  }
  // Only reachable if the mission vanished inside its own transaction.
  if (!joined) return notFound(res)
  if (already !== joined.id) emitMissionMarker(ctx, who, { mission: joined, action: 'joined', convoId: body.convo_id })
  json(res, 200, { mission: joined })
  return true
}

async function handleClose(ctx, req, res, who, mission) {
  const { db } = ctx
  const body = await readBody(req)
  if (typeof body.summary !== 'string' || !body.summary.trim() || Buffer.byteLength(body.summary, 'utf8') > BODY_MAX) return badRequest(res)
  let out
  try {
    out = closeMission(db, { userId: who.userId, missionId: mission.id, by: byOf(who), summary: body.summary, excludePrivateOwned: filteredAgent(db, who) })
  } catch (err) {
    if (err.message === 'closed') return conflict(res, { blocked_by: 'closed' })
    if (err.message === 'user_items' || err.message === 'agent_items') return conflict(res, { blocked_by: err.message, items: err.items })
    // TOCTOU: the mission existed at visibleMission a moment ago.
    if (err.message === 'no_mission') return notFound(res)
    throw err
  }
  emitMissionMarker(ctx, who, {
    mission: out.mission, action: 'closed', convoId: out.mission.origin_convo_id,
    openItemNums: who.kind === 'agent' ? null : out.openItemNums,
  })
  json(res, 200, { mission: out.mission })
  return true
}

async function handleMilestoneCreate(ctx, req, res, who) {
  const { db, hub } = ctx
  const body = await readBody(req)
  if (!MILESTONE_KINDS.includes(body.kind)) return badRequest(res)
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > TITLE_MAX) return badRequest(res)
  if (body.body !== undefined && (typeof body.body !== 'string' || Buffer.byteLength(body.body, 'utf8') > BODY_MAX)) return badRequest(res)
  const idemKey = idemKeyOf(req, who)
  if (idemKey === undefined) return badRequest(res)
  if (!writableConvo(db, who, body.convo_id)) return notFound(res)
  const sender = senderOf(db, who)
  const excludePrivateOwned = filteredAgent(db, who)
  let out
  try {
    out = createMilestone(db, {
      userId: who.userId, deviceId: who.deviceId, createdBy: byOf(who), convoId: body.convo_id,
      kind: body.kind, title: body.title.trim(), body: body.body ?? '', idemKey, excludePrivateOwned,
      appendMarker: (payload) => append(db, { userId: who.userId, convoId: body.convo_id, sender, type: MILESTONE_EVENT_TYPE, payload }),
    })
  } catch (err) {
    if (err.message === 'no_mission' || err.message === 'closed') return conflict(res, { blocked_by: err.message })
    // Unreachable through this route (MILESTONE_KINDS is checked above) —
    // kept mapped rather than dropped so the module's own guard, which other
    // callers rely on, can never surface as a 500 if the two ever drift.
    if (err.message === 'bad_kind') return badRequest(res)
    // TOCTOU: writableConvo just confirmed the convo, but it can vanish
    // between that check and createMilestone's own read of it (same stance
    // as handleCreate/handleJoin's no_convo catches above).
    if (err.message === 'no_convo') return notFound(res)
    if (err.message === 'idem_key_conflict') {
      // The row that collided belongs to whichever request's INSERT won —
      // this one's own transaction (marker included) has already rolled
      // back. Re-query the winner OUTSIDE any transaction and answer
      // exactly like an ordinary replay: 200, never a marker-less 409 (see
      // missions.js's createMilestone for why this can't be recovered
      // inside the transaction that just lost).
      const dup = db.prepare('SELECT id, mission_id FROM milestones WHERE user_id=? AND idem_key=?').get(who.userId, idemKey)
      if (dup) {
        const milestone = milestoneRow(db.prepare('SELECT * FROM milestones WHERE id=?').get(dup.id))
        const mission = getMission(db, who.userId, dup.mission_id, { excludePrivateOwned })
        // Sieved away (C1): answer as the fresh post would have.
        if (!mission) return conflict(res, { blocked_by: 'no_mission' })
        json(res, 200, { milestone, mission })
        return true
      }
      throw err
    }
    if (err.message === 'marker_append_failed') {
      console.error('missions: milestone marker append failed — milestone not created', err.cause)
      json(res, 502, { error: 'marker_append_failed' }); return true
    }
    throw err
  }
  if (out.duplicate) { json(res, 200, { milestone: out.milestone, mission: out.mission }); return true }
  // Broadcast only now: the marker committed with the row. Built with
  // milestoneMarkerPayload — the same function that shaped the STORED
  // marker inside missions.js's transaction — so the live frame and the
  // persisted event can never drift apart from hand-copied keys.
  // `markerWithTitle` comes back from that same transaction rather than
  // being re-derived here, for the same reason: one decision, one shape.
  try {
    broadcastAppended(db, hub, {
      userId: who.userId, convoId: body.convo_id, seq: out.seq, ts: out.ts, sender, type: MILESTONE_EVENT_TYPE,
      payload: milestoneMarkerPayload({ milestone: out.milestone, mission: out.mission, by: byOf(who), withTitle: out.markerWithTitle }),
    })
  } catch (err) { console.error('missions: milestone broadcast failed (row and marker already committed)', err) }
  json(res, 201, { milestone: out.milestone, mission: out.mission })
  return true
}

function handleMilestoneList(ctx, res, url, who) {
  const { db } = ctx
  const convoId = url.searchParams.get('convo')
  if (!convoId) return badRequest(res)
  const convo = db.prepare('SELECT owner_user_id FROM conversations WHERE id=?').get(convoId)
  if (!convo || convo.owner_user_id !== who.userId) return notFound(res)
  if (filteredAgent(db, who) && privateOwnedConvo(db, convoId)) return notFound(res)
  json(res, 200, { milestones: listMilestones(db, who.userId, { convoId, excludePrivateOwned: filteredAgent(db, who) }) })
  return true
}

export async function handleMissionsRoute(ctx, req, res, url, who) {
  const { db } = ctx
  const path = url.pathname
  if (path === '/milestones') {
    if (req.method === 'POST') return handleMilestoneCreate(ctx, req, res, who)
    if (req.method === 'GET') return handleMilestoneList(ctx, res, url, who)
    return false
  }
  if (path !== '/missions' && !path.startsWith('/missions/')) return false
  if (path === '/missions') {
    if (req.method === 'POST') return handleCreate(ctx, req, res, who)
    if (req.method === 'GET') return handleList(ctx, res, url, who)
    return false
  }
  // Nested sub segment on purpose (see items-http.js): /missions/:id/junk must not match.
  const m = path.match(/^\/missions\/([^/]+)(?:\/(join|close))?$/)
  if (!m) return false
  let idOrNum
  try { idOrNum = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  const sub = m[2] || null
  const mission = visibleMission(db, who, idOrNum)
  if (!mission) return notFound(res)
  if (!sub) {
    if (req.method === 'GET') {
      // Only null if the mission vanished between the gate above and this
      // re-read — 404 like any other missing mission, never `200 null`.
      const detail = missionDetail(db, who.userId, mission.id, { excludePrivateOwned: filteredAgent(db, who) })
      if (!detail) return notFound(res)
      json(res, 200, detail); return true
    }
    if (req.method === 'PATCH') return handlePatch(ctx, req, res, who, mission)
    return false
  }
  if (req.method !== 'POST') return false
  if (sub === 'join') return handleJoin(ctx, req, res, who, mission)
  return handleClose(ctx, req, res, who, mission)
}
