// Durable spawn requests (spec: 2026-08-09 agent-spawned sessions). A row is
// the journal-brokered ask "may this agent start a session on that box" —
// parked across human latency, which the stateless RPC relay deliberately
// cannot do. State machine: awaiting_user → approved → started|failed,
// awaiting_user → denied|expired. The CHECK in db.js lists every state this
// file writes — the convo_agents lesson, where an unlisted value made an
// upsert fail silently.

import { randomUUID } from 'node:crypto'
import { upsertConversation, appendAndBroadcast, CONVO_ID_MAX_CHARS } from './journal.js'
import { recordJoined } from './participants.js'
import { sanitizePeerText, PEER_NAME_CAP } from './peer-text.js'

export function createSpawnRequest(db, { id, userId, fromDeviceId, fromConvoId, targetDeviceId, workdir, task, topic = '', now = Date.now() }) {
  db.prepare(`
    INSERT INTO agent_spawn_requests(id, user_id, from_device_id, from_convo_id, target_device_id,
      workdir, task, topic, state, created_at)
    VALUES(?,?,?,?,?,?,?,?,'awaiting_user',?)
  `).run(id, userId, fromDeviceId, fromConvoId, targetDeviceId, workdir, task, topic, now)
  return { id }
}

export function getSpawn(db, id) {
  return db.prepare('SELECT * FROM agent_spawn_requests WHERE id=?').get(id)
}

// The user's "no", reported to the parent plainly as 'declined' (spec: no
// peer to hide behind here, unlike chat's 'refused' masking).
export function denySpawn(db, id, now = Date.now()) {
  return db.prepare(
    "UPDATE agent_spawn_requests SET state='denied', answered_at=?, resolved_at=? WHERE id=? AND state='awaiting_user'"
  ).run(now, now, id).changes > 0
}

// The approve tap CLAIMS the row — state-scoped so exactly one caller wins
// and everything expensive (room, live agent on another box) starts at most
// once. The loser's zero row-count is the 409 the failure table promises.
export function claimApprove(db, id, now = Date.now()) {
  return db.prepare(
    "UPDATE agent_spawn_requests SET state='approved', answered_at=? WHERE id=? AND state='awaiting_user'"
  ).run(now, id).changes > 0
}

export function markStarted(db, id, { roomId, childConvoId, now = Date.now() }) {
  return db.prepare(
    "UPDATE agent_spawn_requests SET state='started', room_id=?, child_convo_id=?, resolved_at=? WHERE id=? AND state='approved'"
  ).run(roomId, childConvoId, now, id).changes > 0
}

export function markFailed(db, id, now = Date.now()) {
  return db.prepare(
    "UPDATE agent_spawn_requests SET state='failed', resolved_at=? WHERE id=? AND state='approved'"
  ).run(now, id).changes > 0
}

// Sweep-driven 24h TTL, mirroring participants.expireAwaiting: flip stale
// parked rows and report them so the sweep can tell each parent its ask
// timed out. RETURNING keeps flip-and-report atomic. user_id/from_device_id
// ride along so the caller needs no per-row lookups.
export function expireSpawns(db, ttlMs, now = Date.now()) {
  return db.prepare(
    "UPDATE agent_spawn_requests SET state='expired', answered_at=?, resolved_at=? WHERE state='awaiting_user' AND created_at<=? RETURNING id, user_id, from_device_id, from_convo_id"
  ).all(now, now, now - ttlMs)
}

// Stranded-`approved` recovery — the sweep's backstop for the gap between
// claimApprove flipping a row to 'approved' and the in-memory broker
// settling it (started/failed). Two ways in: (a) the process restarts
// between the claim and the broker settling — nothing left in memory will
// ever resolve the row; (b) approveSpawn throws before broker.issue (e.g. the
// room-creation writes fail) and the caller's own catch only logs. Either
// way the row would sit in 'approved' forever, breaking "every request
// resolves exactly once and the parent is told exactly once". TTL is
// measured off answered_at (the claim timestamp) and set well beyond the
// 30s default start timeout so this never races a live approveSpawn still
// legitimately in flight. State-scoped like expireSpawns above: RETURNING
// keeps flip-and-report atomic, and the WHERE state='approved' guarantees a
// row a live orchestration just resolved (started/failed) is never touched.
export function expireApproved(db, ttlMs, now = Date.now()) {
  return db.prepare(
    "UPDATE agent_spawn_requests SET state='failed', resolved_at=? WHERE state='approved' AND answered_at<=? RETURNING id, user_id, from_device_id, room_id"
  ).all(now, now - ttlMs)
}

// Undo for a spawn ask whose consent card never made it out: spawn_request
// inserts the row FIRST (the card must carry a real request_id), so a
// publish failure right after would otherwise leave a phantom
// awaiting_user row — no card for the user to answer, yet still counting
// against the shared MAX_AWAITING_PER_REQUESTER cap for the full 24h TTL.
// State-scoped DELETE: only an unanswered row is ever discarded.
export function discardSpawnRequest(db, id) {
  return db.prepare("DELETE FROM agent_spawn_requests WHERE id=? AND state='awaiting_user'").run(id).changes > 0
}

// The shared attention throttle (spec: cap on outstanding asks). Counts BOTH
// tables — pending spawn rows live here, pending chat asks in convo_agents —
// because what the user is being protected from is cards, not any one
// table's cards. An agent that exhausted its chat budget must not spawn
// freely, or vice versa. Checked against MAX_AWAITING_PER_REQUESTER on all
// three ask surfaces (agent_invite, agent_join, spawn_request).
export function countPendingAsks(db, fromDeviceId) {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM convo_agents WHERE state='awaiting_user' AND initiator_device_id=?)
      + (SELECT COUNT(*) FROM agent_spawn_requests WHERE state='awaiting_user' AND from_device_id=?) AS c
  `).get(fromDeviceId, fromDeviceId).c
}

// Spec step 4/5 — everything after the user's tap. Ordering is load-bearing:
// room first, then spawn. Spawning first would, on a room-creation failure,
// leave a live agent on another box with no channel and no provenance. The
// broker's timeout guarantees the `start` rpc itself settles; the try/catch
// below guarantees the ORCHESTRATION settles too, even if something throws
// before broker.issue is ever reached (e.g. upsertConversation/
// appendAndBroadcast hitting a DB error) — otherwise the row is left
// 'approved' forever with the caller's own `.catch(console.error)` the only
// thing that ever sees the failure. The stranded-'approved' sweep
// (expireApproved) is the remaining backstop for the case even this can't
// cover: the process dying mid-orchestration, taking this stack frame with
// it.
export async function approveSpawn({ db, hub, broker, startTimeoutMs, roomId = randomUUID() }, row) {
  // Exactly-once guard: markFailed is state-scoped (WHERE state='approved'),
  // so its changes-count tells us whether THIS call is the one resolving the
  // row out of 'approved'. A false here means someone else already did
  // (the orphan sweep, or — impossible in practice, but cheap to guard —
  // another concurrent path) and neither the epitaph nor the outcome frame
  // may be sent a second time.
  const fail = (code) => {
    if (!markFailed(db, row.id)) return 'failed'
    // Best-effort epitaph: normally the room already exists (both users can
    // see it, so it gets the same epitaph a dead chat room gets) — but a
    // throw from THIS call's own try block can land here before
    // upsertConversation ever ran, in which case there is no room row to
    // write into and appendAndBroadcast itself throws (append() requires an
    // existing, owned conversation). That must never swallow the outcome
    // frame below — telling the parent is the one thing this tail cannot
    // skip.
    // `code` here is the target bridge's own error_code (e.g. from a
    // failed `start` RPC reply, ws.js's RPC_NAME_MAX_CHARS=64-capped
    // msg.error.code) — peer-authored, not journal-composed — so it goes
    // through the same sanitizePeerText sieve as fromName below. Used for
    // BOTH the room epitaph and the outcome frame: the frame lands on the
    // parent bridge and, later, consent-card clients, so a raw code with
    // embedded newlines must never cross the wire either. Same 'unknown'
    // fallback for a missing code.
    const safeCode = sanitizePeerText(code, 64) || 'unknown'
    try {
      appendAndBroadcast(db, hub, {
        userId: row.user_id, convoId: roomId, sender: 'journal', type: 'text',
        payload: { body: `❌ spawn failed — ${safeCode}. This room's child session never started.` },
      })
    } catch (err) {
      console.error('approveSpawn: epitaph write failed (room likely never created)', err)
    }
    hub.sendToDevice(row.user_id, row.from_device_id, {
      kind: 'spawn', event: 'outcome', request_id: row.id, outcome: 'failed', error_code: safeCode,
    })
    return 'failed'
  }
  try {
    const title = row.topic || row.task.slice(0, 80)
    // The parent owns the room (conversations.agent_device_id), the target is
    // its joined participant — the same shape an accepted chat invite leaves.
    upsertConversation(db, { id: roomId, ownerUserId: row.user_id, title, sessionState: 'running', agentDeviceId: row.from_device_id })
    recordJoined(db, { convoId: roomId, agentDeviceId: row.target_device_id, initiatorDeviceId: row.from_device_id })
    // Live clients learn the room exists now, not at their next /snapshot —
    // the same two frames convo_upsert fans for a fresh conversation.
    appendAndBroadcast(db, hub, { userId: row.user_id, convoId: roomId, sender: 'journal', type: 'session_status', payload: { state: 'running' } })
    appendAndBroadcast(db, hub, { userId: row.user_id, convoId: roomId, sender: 'journal', type: 'convo_meta', payload: { title, parent_convo_id: null } })
    // Persist the room linkage NOW, before the `start` RPC — the row is
    // still 'approved', so a restart in the RPC gap leaves the sweep
    // (expireApproved) a room_id to report and write the epitaph into.
    // Without this, markStarted was the first writer of room_id and a
    // restart-orphaned row pointed at nothing: the user was left with an
    // unexplained dead room and the parent with an unlocatable failure.
    // State-scoped like every other write; markStarted re-setting the same
    // value later is harmless.
    db.prepare("UPDATE agent_spawn_requests SET room_id=? WHERE id=? AND state='approved'").run(roomId, row.id)
    // The parent device's name may be gone by approval time (deleted between
    // the ask and the tap) — omitted rather than forced, same as every other
    // optional wire field.
    const fromName = sanitizePeerText(
      db.prepare('SELECT name FROM devices WHERE id=?').get(row.from_device_id)?.name,
      PEER_NAME_CAP,
    )
    const r = await broker.issue(hub, row.user_id, row.target_device_id, 'start',
      { workdir: row.workdir, prompt: row.task, room_id: roomId, ...(fromName ? { from_name: fromName } : {}) },
      { timeoutMs: startTimeoutMs })
    // Bridge-returned convo_id, capped the same as every other externally-
    // supplied convo id (CONVO_ID_MAX_CHARS) — an oversized or non-string
    // reply is a bad reply, same 'bad_start_reply' the missing-field case
    // already gets below.
    if (r.ok && typeof r.result?.convo_id === 'string' && r.result.convo_id && r.result.convo_id.length <= CONVO_ID_MAX_CHARS) {
      // Exactly-once guard, mirroring fail()'s: markStarted is state-scoped
      // (WHERE state='approved'), so a false means something else — in
      // practice only the orphan sweep — already resolved this row and told
      // the parent 'failed'. A contradicting 'started' frame must not follow
      // it. Unreachable while startTimeoutMs stays under the orphan TTL, but
      // nothing enforces that relationship between the two configs.
      if (!markStarted(db, row.id, { roomId, childConvoId: r.result.convo_id })) {
        console.error('approveSpawn: start reply arrived after the row was already resolved — outcome frame suppressed')
        return 'failed'
      }
      hub.sendToDevice(row.user_id, row.from_device_id, {
        kind: 'spawn', event: 'outcome', request_id: row.id, outcome: 'started',
        room_id: roomId, child_convo_id: r.result.convo_id,
      })
      return 'started'
    }
    return fail(r.ok ? 'bad_start_reply' : (r.error?.code ?? 'unknown'))
  } catch (err) {
    console.error('approveSpawn orchestration threw before settling', err)
    return fail('internal')
  }
}

// Shape-validation for the capacity blocks a bridge may attach to its
// recent_folders reply (spec: 2026-08-10 bridge capacity design). All-or-
// nothing per block: one malformed entry drops the whole optional block —
// but never the box — because a half-validated capacity report is worse
// than none. Strings are flattened through sanitizePeerText: they originate
// from another box's `claude` output and filesystem, and render in an
// agent-facing reply.
const ACTIVITY_MAX_ENTRIES = 20
const LIMITS_MAX_LINES = 12
const LIMIT_STR_CAP = 100
const SESSIONS_SANE_MAX = 10000

export function sanitizeSpawnActivity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!Number.isInteger(raw.live_sessions) || raw.live_sessions < 0 || raw.live_sessions > SESSIONS_SANE_MAX) return null
  if (!Array.isArray(raw.last_hour)) return null
  const last_hour = []
  for (const e of raw.last_hour.slice(0, ACTIVITY_MAX_ENTRIES)) {
    if (!e || typeof e !== 'object') return null
    if (typeof e.path !== 'string' || !e.path || e.path.length > 1024) return null
    if (!Number.isInteger(e.sessions) || e.sessions < 1 || e.sessions > SESSIONS_SANE_MAX) return null
    const path = sanitizePeerText(e.path, 1024)
    if (!path) return null
    last_hour.push({ path, sessions: e.sessions })
  }
  return { live_sessions: raw.live_sessions, last_hour }
}

// JS's own ceiling on a representable time value (Number.MAX_SAFE_INTEGER-ish
// but tighter — the ECMA-262 spec's actual bound, ±8,640,000,000,000,000ms
// either side of the epoch). Below the lower check, an as_of that clears
// Number.isInteger and > 0 but exceeds THIS throws a RangeError out of
// `new Date(as_of).toISOString()` in every downstream renderer (e.g.
// matron-bridge lib/agent-boxes-format.js's formatBox) — reject it here
// instead of letting every reader guard against it separately.
const AS_OF_MAX_MS = 8640000000000000

export function sanitizeSpawnLimits(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!Number.isInteger(raw.as_of) || raw.as_of <= 0 || raw.as_of > AS_OF_MAX_MS) return null
  if (!Array.isArray(raw.lines)) return null
  const lines = []
  for (const l of raw.lines.slice(0, LIMITS_MAX_LINES)) {
    if (!l || typeof l !== 'object') return null
    if (typeof l.id !== 'string' || !l.id || l.id.length > LIMIT_STR_CAP) return null
    if (typeof l.label !== 'string' || !l.label || l.label.length > LIMIT_STR_CAP) return null
    if (!Number.isInteger(l.percent) || l.percent < 0 || l.percent > 1000) return null
    const id = sanitizePeerText(l.id, LIMIT_STR_CAP)
    const label = sanitizePeerText(l.label, LIMIT_STR_CAP)
    if (!id || !label) return null
    const out = { id, label, percent: l.percent }
    if (l.resets !== undefined) {
      if (typeof l.resets !== 'string' || l.resets.length > LIMIT_STR_CAP) return null
      const resets = sanitizePeerText(l.resets, LIMIT_STR_CAP)
      if (!resets) return null
      out.resets = resets
    }
    if (l.resets_at !== undefined) {
      if (typeof l.resets_at !== 'string' || l.resets_at.length > 40) return null
      const resets_at = sanitizePeerText(l.resets_at, 40)
      if (!resets_at) return null
      out.resets_at = resets_at
    }
    lines.push(out)
  }
  return { as_of: raw.as_of, lines }
}
