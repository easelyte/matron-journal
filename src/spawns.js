// Durable spawn requests (spec: 2026-08-09 agent-spawned sessions). A row is
// the journal-brokered ask "may this agent start a session on that box" —
// parked across human latency, which the stateless RPC relay deliberately
// cannot do. State machine: awaiting_user → approved → started|failed,
// awaiting_user → denied|expired. The CHECK in db.js lists every state this
// file writes — the convo_agents lesson, where an unlisted value made an
// upsert fail silently.

import { randomUUID } from 'node:crypto'
import { upsertConversation, appendAndBroadcast, CONVO_ID_MAX_CHARS } from './journal.js'
import { recordJoined, participantIds } from './participants.js'
import { sanitizePeerText, PEER_NAME_CAP } from './peer-text.js'
import { isPrivateDevice } from './db.js'
import { sessionShortFromTitle, sideTag, roomTitle } from './room-title.js'
import { closeSpawnConsentItem } from './consent-items.js'
import { getMission, joinMission } from './missions.js'
import { MISSION_EVENT_TYPE, missionMarkerPayload } from './missions-marker.js'
import { markerTitleAllowed } from './privacy.js'

// `model` is the optional Claude model the child session should run — an
// alias ('opus') or a full model id, defaulted to '' like topic so a caller
// that never mentions one writes the same falsy value rows predating the
// column carry (NULL). approveSpawn's relay is a falsy test, so the two are
// interchangeable there and nowhere has to distinguish them.
//
// `link` is whether approval also opens a chat room between the parent and
// the child (spec: 2026-09-17 spawn rooms opt-in). Off by default: a spawn
// is normally a clean break, and the parent can open a room later with an
// ordinary agent_chat_start if it turns out to need one. Stored 0/1 (SQLite
// has no boolean); read back with a truthiness test like model.
export function createSpawnRequest(db, { id, userId, fromDeviceId, fromConvoId, targetDeviceId, workdir, task, topic = '', model = '', link = false, missionNum = null, now = Date.now() }) {
  db.prepare(`
    INSERT INTO agent_spawn_requests(id, user_id, from_device_id, from_convo_id, target_device_id,
      workdir, task, topic, model, link, mission_num, state, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'awaiting_user',?)
  `).run(id, userId, fromDeviceId, fromConvoId, targetDeviceId, workdir, task, topic, model, link ? 1 : 0, missionNum, now)
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

// Durable outcome + ephemeral frame, in that order — the settlement
// reporter every terminal transition routes through. The append is
// best-effort: from_convo_id may point at a conversation deleted since the
// ask was parked (append() throws on a missing/foreign conversation), and
// telling the parent is the one thing this tail cannot skip — so a failed
// append is logged and the frame still goes out. Exactly-once emission
// stays the CALLER's job (the state-scoped UPDATEs): by the time this
// runs, the caller has already won the transition. Agent-visible on
// purpose (not in isClientOnlyEvent): the parent owns from_convo_id, so
// replay hands it the outcome durably — the fix for the at-most-once
// delivery gap protocol.md used to document.
//
// The consent item (src/consent-items.js) is closed here too — between the
// durable event and the frame, so the tracker is settled by the time the
// parent hears — because this is the ONE funnel every terminal transition
// passes through. `answeredByDeviceId` is the client that tapped, when a
// tap is what resolved the row; it only names the closing note's device.
export function emitSpawnOutcome(db, hub, { userId, fromDeviceId, fromConvoId, requestId, outcome, roomId, childConvoId, errorCode, answeredByDeviceId = null }) {
  const extras = {
    ...(roomId ? { room_id: roomId } : {}),
    ...(childConvoId ? { child_convo_id: childConvoId } : {}),
    ...(errorCode ? { error_code: errorCode } : {}),
  }
  try {
    appendAndBroadcast(db, hub, {
      userId, convoId: fromConvoId, sender: 'journal', type: 'spawn_outcome',
      payload: { request_id: requestId, outcome, ...extras },
    })
  } catch (err) {
    console.error('emitSpawnOutcome: durable outcome append failed', err)
  }
  closeSpawnConsentItem({ db, hub }, requestId, { outcome, errorCode, roomId, answeredByDeviceId })
  hub.sendToDevice(userId, fromDeviceId, { kind: 'spawn', event: 'outcome', request_id: requestId, outcome, ...extras })
}

// Sweep-driven 24h TTL, mirroring participants.expireAwaiting: flip stale
// parked rows and report them so the sweep can tell each parent its ask
// timed out. RETURNING keeps flip-and-report atomic. user_id/from_device_id/
// from_convo_id ride along so the caller needs no per-row lookups.
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
// user_id/from_device_id/room_id/from_convo_id ride along so the caller
// needs no per-row lookups.
export function expireApproved(db, ttlMs, now = Date.now()) {
  return db.prepare(
    "UPDATE agent_spawn_requests SET state='failed', resolved_at=? WHERE state='approved' AND answered_at<=? RETURNING id, user_id, from_device_id, room_id, from_convo_id"
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

// The title of a spawn room, in the bridge's own agent-chat room form —
// `D:ab ↔️ E:cd — topic` (src/room-title.js): the parent's tag, the
// child's tag, the topic. Each tag is the box letter (derived against the
// same roster the apps colour from, tag_char override honoured) plus the
// session short the owning bridge baked into that session's title. A side
// whose title has not earned a short yet — the child before its bridge
// publishes one, always the case at creation — falls back to the device
// name, exactly as chatStart's peer side does. `childShort` is the frozen
// child_short (see refreshSpawnRoomTitle), '' at creation. The roster the
// letters are struck against is the one the PARENT can see (private boxes stay
// invisible to an ordinary agent's room title as they are to its roster),
// with the pair's own names added should either be missing from it.
function spawnRoomTitle(db, row, childShort = '') {
  const excludePrivate = !isPrivateDevice(db, row.from_device_id)
  const agents = db.prepare(
    `SELECT id, name, tag_char FROM devices WHERE user_id=? AND kind='agent'${excludePrivate ? ' AND private=0' : ''} ORDER BY id`
  ).all(row.user_id).map((a) => ({ ...a, name: sanitizePeerText(a.name, PEER_NAME_CAP) }))
  const agentFor = (deviceId) => agents.find((a) => a.id === deviceId)
    || (() => { const d = db.prepare('SELECT id, name, tag_char FROM devices WHERE id=?').get(deviceId); return d ? { ...d, name: sanitizePeerText(d.name, PEER_NAME_CAP) } : null })()
  const parent = agentFor(row.from_device_id)
  const target = agentFor(row.target_device_id)
  const names = [...new Set([...agents.map((a) => a.name), parent?.name, target?.name].filter((n) => typeof n === 'string' && n))]
  const side = (agent, deviceId, short) => sideTag({
    name: agent?.name || null,
    short,
    names,
    override: agent?.tag_char ?? null,
    label: agent?.name || `device ${deviceId}`,
  })
  const parentShort = sessionShortFromTitle(db.prepare('SELECT title FROM conversations WHERE id=?').get(row.from_convo_id)?.title)
  return roomTitle(side(parent, row.from_device_id, parentShort), side(target, row.target_device_id, childShort), row.topic || '')
}

// Bring a started spawn room's title up to date once its child's bridge has
// published a title — called from ws.js on every titled convo_upsert,
// because the child's seed title normally lands AFTER the start reply (a
// bridge publishes it with its first state-transition upsert, not at spawn).
// The short is learned ONCE and frozen on the row (child_short): bridge
// rooms freeze the peer short at creation, and a room title that followed
// every later child rename would flap — to a different short after a
// resume, or back to the bare device name after an app-side rename that
// dropped the prefix. So: cheap when the convo is nobody's child (one
// indexed point lookup), a no-op once the short is known or while the
// child's title still carries none, and exactly one retitle otherwise.
// Returns whether a retitle happened. Best-effort by contract: callers log
// and carry on.
export function refreshSpawnRoomTitle(db, hub, childConvoId) {
  const row = db.prepare(
    "SELECT * FROM agent_spawn_requests WHERE child_convo_id=? AND room_id IS NOT NULL AND state='started'"
  ).get(childConvoId)
  if (!row || row.child_short) return false
  const short = sessionShortFromTitle(db.prepare('SELECT title FROM conversations WHERE id=?').get(childConvoId)?.title)
  if (!short) return false
  const room = db.prepare('SELECT owner_user_id, title FROM conversations WHERE id=?').get(row.room_id)
  if (!room) return false
  db.prepare('UPDATE agent_spawn_requests SET child_short=? WHERE id=?').run(short, row.id)
  const title = spawnRoomTitle(db, row, short)
  if (title === room.title) return false
  upsertConversation(db, { id: row.room_id, ownerUserId: room.owner_user_id, title })
  appendAndBroadcast(db, hub, { userId: row.user_id, convoId: row.room_id, sender: 'journal', type: 'convo_meta', payload: { title, parent_convo_id: null, participants: participantIds(db, row.room_id) } })
  return true
}

// Spec 2026-09-23 coordinator redesign §1c: a spawn that named a mission
// puts its child on it the moment the child's conversation id is known —
// the `start` reply — and before the parent hears `started`. The target
// bridge injects the opening turn just before it answers `start`, so the
// journal cannot order the join ahead of that write. What it can guarantee:
// the join commits synchronously on the reply, ahead of any journal traffic
// the child produces, and the bridge already knows the number from `start`'s
// mission_num param. The child's row may not exist yet — its bridge
// publishes convo_upsert on its own schedule — so it is created here, owned
// by the target box. The bridge's later upsert then updates it in place
// (same owner, so no takeover gate trips). Visibility is judged from the
// CHILD's side, the rule inheritableMission (journal.js) applies: an
// ordinary box is never handed a mission it cannot read. Best-effort: the
// session is already running, so a failure (the mission closed in the last
// few milliseconds, the 200-conversation cap) is logged and the spawn still
// reports started.
export function joinSpawnMission(db, hub, row, childConvoId) {
  if (!row.mission_num) return null
  try {
    const excludePrivateOwned = !isPrivateDevice(db, row.target_device_id)
    const mission = getMission(db, row.user_id, row.mission_num, { excludePrivateOwned })
    if (!mission || mission.state !== 'open') {
      console.error(`approveSpawn: mission #${row.mission_num} not joinable at start (${mission ? mission.state : 'not visible'}) — child runs unattached`)
      return null
    }
    // Final review finding 1: the bridge-reported childConvoId can already
    // name a conversation the user owns — normally its own earlier
    // convo_upsert, but a buggy/hostile target bridge could just as well
    // hand back the id of some OTHER conversation the user owns (the
    // Coordinator, or a private-owned one). owner_user_id alone is not
    // enough: convo_upsert's own takeover gate (ws.js ~1552) additionally
    // requires the row be unowned or owned by the caller's own device, and
    // this path — which writes the mission join and marker directly,
    // bypassing that gate — must honour the same rule. A row owned by a
    // different device is left untouched; the spawn still reports started
    // (this join is best-effort, same as every other failure branch here).
    const exists = db.prepare('SELECT agent_device_id FROM conversations WHERE id=? AND owner_user_id=?').get(childConvoId, row.user_id)
    if (exists && exists.agent_device_id != null && exists.agent_device_id !== row.target_device_id) {
      console.error(`approveSpawn: mission #${row.mission_num} join skipped — child convo ${childConvoId} is owned by a different device — child runs unattached`)
      return null
    }
    if (!exists) upsertConversation(db, { id: childConvoId, ownerUserId: row.user_id, sessionState: 'running', agentDeviceId: row.target_device_id })
    const joined = joinMission(db, { userId: row.user_id, missionId: mission.id, convoId: childConvoId, excludePrivateOwned })
    appendAndBroadcast(db, hub, {
      userId: row.user_id, convoId: childConvoId, sender: 'journal', type: MISSION_EVENT_TYPE,
      payload: missionMarkerPayload({ mission: joined, action: 'joined', by: 'agent', withTitle: markerTitleAllowed(db, joined.origin_convo_id, childConvoId) }),
    })
    return joined
  } catch (err) {
    console.error('approveSpawn: mission join failed (session already started)', err)
    return null
  }
}

// Spec step 4/5 — everything after the user's tap. Ordering is load-bearing
// for a LINKED row: room first, then spawn. Spawning first would, on a
// room-creation failure, leave a live agent on another box with no channel
// and no provenance. A detached row (row.link falsy, the default) mints no
// room at all: the child gets the task and its provenance in its opening
// turn, the parent gets the outcome frame, and that is the whole contract.
// The broker's timeout guarantees the `start` rpc itself settles; the
// try/catch below guarantees the ORCHESTRATION settles too, even if
// something throws before broker.issue is ever reached (e.g.
// upsertConversation/appendAndBroadcast hitting a DB error) — otherwise the
// row is left 'approved' forever with the caller's own `.catch(console.error)`
// the only thing that ever sees the failure. The stranded-'approved' sweep
// (expireApproved) is the remaining backstop for the case even this can't
// cover: the process dying mid-orchestration, taking this stack frame with
// it.
//
// `roomId` is a test seam (a caller-chosen id for a linked row); production
// mints one. It is ignored for a detached row — the flag on the row is the
// only thing that decides whether a room exists.
// wakeTarget / wakeWaitMs (wake-before-spawn): a target box with no live
// socket at approval time is usually asleep, not gone — the host idle-stops
// dev VMs and a wake command starts them again. When the caller supplies
// wakeTarget (which fires the wake and reports whether one is under way),
// the orchestration waits up to wakeWaitMs for the box's socket to register
// before issuing `start`, instead of failing on the spot. A box that never
// comes up still fails with agent_unreachable from the broker; the orphan
// sweep's TTL is derived to outlast wakeWaitMs + startTimeoutMs (ws.js).
export async function approveSpawn({ db, hub, broker, startTimeoutMs, roomId: roomIdOverride = null, answeredByDeviceId = null, wakeTarget = null, wakeWaitMs = 0 }, row) {
  const roomId = row.link ? (roomIdOverride || randomUUID()) : null
  // Exactly-once guard: markFailed is state-scoped (WHERE state='approved'),
  // so its changes-count tells us whether THIS call is the one resolving the
  // row out of 'approved'. A false here means someone else already did
  // (the orphan sweep, or — impossible in practice, but cheap to guard —
  // another concurrent path) and neither the epitaph nor the outcome frame
  // may be sent a second time.
  const fail = (code) => {
    if (!markFailed(db, row.id)) return 'failed'
    // `code` here is the target bridge's own error_code (e.g. from a
    // failed `start` RPC reply, ws.js's RPC_NAME_MAX_CHARS=64-capped
    // msg.error.code) — peer-authored, not journal-composed — so it goes
    // through the same sanitizePeerText sieve as fromName below. Used for
    // the room epitaph, the ephemeral outcome frame, AND the durable
    // spawn_outcome payload emitSpawnOutcome journals below: the frame
    // lands on the parent bridge and, later, consent-card clients, and the
    // durable event replays to both, so a raw code with embedded newlines
    // must never cross any of those wires. Same 'unknown' fallback for a
    // missing code.
    const safeCode = sanitizePeerText(code, 64) || 'unknown'
    // Best-effort epitaph for a linked row: normally the room already
    // exists (both users can see it, so it gets the same epitaph a dead
    // chat room gets) — but a throw from THIS call's own try block can land
    // here before upsertConversation ever ran, in which case there is no
    // room row to write into and appendAndBroadcast itself throws (append()
    // requires an existing, owned conversation). That must never swallow
    // the outcome frame below — telling the parent is the one thing this
    // tail cannot skip. A detached row has no room and gets no epitaph: the
    // outcome frame is its whole story.
    if (roomId) {
      try {
        appendAndBroadcast(db, hub, {
          userId: row.user_id, convoId: roomId, sender: 'journal', type: 'text',
          payload: { body: `❌ spawn failed — ${safeCode}. This room's child session never started.` },
        })
      } catch (err) {
        console.error('approveSpawn: epitaph write failed (room likely never created)', err)
      }
    }
    emitSpawnOutcome(db, hub, { userId: row.user_id, fromDeviceId: row.from_device_id, fromConvoId: row.from_convo_id, requestId: row.id, outcome: 'failed', errorCode: safeCode, answeredByDeviceId })
    return 'failed'
  }
  try {
    // The mission was open when the ask was parked; the tap can come hours
    // later. Re-checked through the ASKER's sieve (as at request time)
    // before anything is created or started: a mission closed or gone in
    // the meantime fails the spawn with a readable code instead of starting
    // an unattached session. For a linked row the room does not exist yet,
    // so fail()'s epitaph write fails and is logged, as its own comment
    // allows.
    if (row.mission_num) {
      const excludePrivateOwned = !isPrivateDevice(db, row.from_device_id) || !isPrivateDevice(db, row.target_device_id)
      const mission = getMission(db, row.user_id, row.mission_num, { excludePrivateOwned })
      if (!mission) return fail('no_mission')
      if (mission.state !== 'open') return fail('mission_closed')
    }
    if (roomId) {
      // Titled the way the bridge titles its own agent-chat rooms, so a
      // spawn room reads like every other room in the chat list. The child
      // side is the bare device name for now — its short arrives with the
      // child's first published title (refreshSpawnRoomTitle, via ws.js).
      const title = spawnRoomTitle(db, row)
      // The parent owns the room (conversations.agent_device_id), the target is
      // its joined participant — the same shape an accepted chat invite leaves.
      upsertConversation(db, { id: roomId, ownerUserId: row.user_id, title, sessionState: 'running', agentDeviceId: row.from_device_id })
      recordJoined(db, { convoId: roomId, agentDeviceId: row.target_device_id, initiatorDeviceId: row.from_device_id })
      // Live clients learn the room exists now, not at their next /snapshot —
      // the same two frames convo_upsert fans for a fresh conversation.
      appendAndBroadcast(db, hub, { userId: row.user_id, convoId: roomId, sender: 'journal', type: 'session_status', payload: { state: 'running' } })
      // participants rides the same meta so the spawn room chips both boxes
      // (parent owner + spawned target) the moment it appears (spec:
      // multi-agent room tags). Best-effort: the row's title and membership
      // are already committed (upsertConversation/recordJoined above) and
      // /snapshot serves both, so a failed live fan must log and let the
      // spawn proceed — not trip the outer catch into reporting a failed
      // outcome for a room that exists with joined membership.
      try {
        appendAndBroadcast(db, hub, { userId: row.user_id, convoId: roomId, sender: 'journal', type: 'convo_meta', payload: { title, parent_convo_id: null, participants: participantIds(db, roomId) } })
      } catch (err) {
        console.error('approveSpawn: room meta fan failed (title and membership already committed)', err)
      }
      // Persist the room linkage NOW, before the `start` RPC — the row is
      // still 'approved', so a restart in the RPC gap leaves the sweep
      // (expireApproved) a room_id to report and write the epitaph into.
      // Without this, markStarted was the first writer of room_id and a
      // restart-orphaned row pointed at nothing: the user was left with an
      // unexplained dead room and the parent with an unlocatable failure.
      // State-scoped like every other write; markStarted re-setting the same
      // value later is harmless.
      db.prepare("UPDATE agent_spawn_requests SET room_id=? WHERE id=? AND state='approved'").run(roomId, row.id)
    }
    // The parent device's name may be gone by approval time (deleted between
    // the ask and the tap) — omitted rather than forced, same as every other
    // optional wire field.
    const fromName = sanitizePeerText(
      db.prepare('SELECT name FROM devices WHERE id=?').get(row.from_device_id)?.name,
      PEER_NAME_CAP,
    )
    // `model` rides the same omit-when-absent rule as from_name: '' (nobody
    // asked) and NULL (a row predating the column) are both falsy, so a
    // target bridge only ever sees the key when the requester named a model.
    // Already sanitised and capped at the ws boundary before it was stored.
    // `room_id` likewise: absent means detached, and the target's opening
    // turn says so instead of naming a channel back.
    // Wake-and-wait before the start RPC. Only when a wake is actually under
    // way: a target that is offline with no wake possible fails fast below,
    // exactly as before, rather than holding the row for the whole window.
    if (wakeTarget && wakeWaitMs > 0) {
      let waking = false
      try { waking = wakeTarget() === true } catch (err) { console.error('approveSpawn: wake threw', err) }
      if (waking) await hub.waitForDevice(row.user_id, row.target_device_id, wakeWaitMs)
    }
    const r = await broker.issue(hub, row.user_id, row.target_device_id, 'start',
      {
        workdir: row.workdir, prompt: row.task, ...(roomId ? { room_id: roomId } : {}), ...(fromName ? { from_name: fromName } : {}), ...(row.model ? { model: row.model } : {}),
        // Omit-when-absent like model: a bridge predating the field never
        // sees the key; one that knows it names the mission in the opening turn.
        ...(row.mission_num ? { mission_num: row.mission_num } : {}),
      },
      { timeoutMs: startTimeoutMs })
    // Bridge-returned convo_id, capped the same as every other externally-
    // supplied convo id (CONVO_ID_MAX_CHARS) — an oversized or non-string
    // reply is a bad reply, same 'bad_start_reply' the missing-field case
    // already gets below. Sanitisation is a REJECT, not a rewrite: this id
    // now persists into the durable spawn_outcome payload and replays to
    // card-rendering clients, so control characters make it a bad reply —
    // but an id must never be silently mutated into a different id.
    if (r.ok && typeof r.result?.convo_id === 'string' && r.result.convo_id && r.result.convo_id.length <= CONVO_ID_MAX_CHARS
      && sanitizePeerText(r.result.convo_id, CONVO_ID_MAX_CHARS) === r.result.convo_id) {
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
      // Before the room retitle and the outcome: the parent (and every app)
      // must never hear `started` for a child that is not yet on its mission.
      joinSpawnMission(db, hub, row, r.result.convo_id)
      // The child's bridge may already have published its title (it does
      // when it flushes the seed before answering); if so the room can
      // carry the child's tag from the start. Best-effort like every fan.
      if (roomId) {
        try { refreshSpawnRoomTitle(db, hub, r.result.convo_id) } catch (err) { console.error('approveSpawn: room retitle failed', err) }
      }
      emitSpawnOutcome(db, hub, { userId: row.user_id, fromDeviceId: row.from_device_id, fromConvoId: row.from_convo_id, requestId: row.id, outcome: 'started', roomId, childConvoId: r.result.convo_id, answeredByDeviceId })
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

// Disk block: two byte counts, no peer strings. isSafeInteger, not
// isInteger — 2^60 passes isInteger (it is a representable float with no
// fraction) and would then survive into arithmetic downstream renderers do
// on it. free may equal total (fresh empty volume) but never exceed it, and
// a zero-total filesystem is nonsense, not data.
export function sanitizeSpawnDisk(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!Number.isSafeInteger(raw.free_bytes) || raw.free_bytes < 0) return null
  if (!Number.isSafeInteger(raw.total_bytes) || raw.total_bytes <= 0) return null
  if (raw.free_bytes > raw.total_bytes) return null
  return { free_bytes: raw.free_bytes, total_bytes: raw.total_bytes }
}

// Vitals block: the bridge's host-global CPU/RAM sample (hostVitals() in
// matron-bridge lib/session-status.js), persisted with the box's report so
// an ops view can show the last known load of a box that is asleep. All-or-
// nothing like every other block: two finite percentages in 0..100 and a
// sample time that is a positive integer ms no later than JS's Date ceiling
// (AS_OF_MAX_MS, same RangeError reason as limits.as_of). Only the three
// keys are copied; typeof 'number' already rules out nested objects/arrays.
function isPct(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 }

export function sanitizeBoxVitals(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!isPct(raw.cpu_pct) || !isPct(raw.ram_pct)) return null
  if (!Number.isInteger(raw.sampled_at_ms) || raw.sampled_at_ms <= 0 || raw.sampled_at_ms > AS_OF_MAX_MS) return null
  return { cpu_pct: raw.cpu_pct, ram_pct: raw.ram_pct, sampled_at_ms: raw.sampled_at_ms }
}

// A bridge's own box-status report (`box_status` op): the same optional
// capacity blocks a recent_folders reply may carry, plus the account it
// burns quota against and the host vitals sample. Each block is all-or-nothing on its own; a report
// with no valid block at all is rejected (nothing to store).
const ACCOUNT_EMAIL_CAP = 254

export function sanitizeBoxStatus(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const activity = sanitizeSpawnActivity(raw.activity)
  const limits = sanitizeSpawnLimits(raw.limits)
  const disk = sanitizeSpawnDisk(raw.disk)
  const vitals = sanitizeBoxVitals(raw.vitals)
  let account = null
  if (raw.account && typeof raw.account === 'object' && !Array.isArray(raw.account)
    && typeof raw.account.email === 'string' && raw.account.email.length <= ACCOUNT_EMAIL_CAP) {
    const email = sanitizePeerText(raw.account.email, ACCOUNT_EMAIL_CAP)
    if (email) account = { email }
  }
  if (!activity && !limits && !disk && !account && !vitals) return null
  return {
    ...(activity ? { activity } : {}),
    ...(limits ? { limits } : {}),
    ...(disk ? { disk } : {}),
    ...(account ? { account } : {}),
    ...(vitals ? { vitals } : {}),
  }
}

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
