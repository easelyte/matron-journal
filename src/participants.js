// Participants ("grants") for agent chat rooms — the convo_agents table
// (spec: 2026-08-06 agent-to-agent chat design, Phase 2). A row means this
// agent device has been drawn into this conversation's lifecycle; only
// state='joined' confers delivery and write rights (see authorizeAgentWrite
// in auth.js and the fan-out in ws.js). initiator_device_id records who
// started the invite — the room owner (invite) or the participant itself
// (join request) — because the OTHER party is the one entitled to answer.

// Renewable states: an old outcome must not block a fresh invite, but a
// pending or accepted row must (double-invite is a caller bug worth
// surfacing, not silently resetting). 'denied' is renewable for the same
// reason 'refused' is — a user's past no must not permanently bar a
// legitimate later ask. 'awaiting_user' is deliberately NOT renewable: a
// pending ask that could simply be renewed is a re-request loop against the
// user's attention, not a fresh ask (see parkInvite/answerParkedInvite).
const RENEWABLE = new Set(['refused', 'denied', 'left', 'expired'])

// Shared upsert behind inviteParticipant/parkInvite: same renew-or-reject
// gate, same conflict target, differing only in which state (and topic) the
// row lands in. `delivered_at` is always reset to NULL here — a renewed row
// is a brand new ask, not a continuation of whatever was or wasn't delivered
// before.
function upsertRow(db, { convoId, agentDeviceId, initiatorDeviceId, state, justification, topic, targetConvoId = null }) {
  const existing = db.prepare(
    'SELECT * FROM convo_agents WHERE convo_id=? AND agent_device_id=?'
  ).get(convoId, agentDeviceId)
  if (existing && !RENEWABLE.has(existing.state)) return { ok: false, state: existing.state }
  db.prepare(`
    INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, justification, topic, target_convo_id, created_at, answered_at, delivered_at)
    VALUES(?,?,?,?,?,?,?,?,NULL,NULL)
    ON CONFLICT(convo_id, agent_device_id) DO UPDATE SET
      initiator_device_id=excluded.initiator_device_id,
      state=excluded.state,
      justification=excluded.justification,
      topic=excluded.topic,
      target_convo_id=excluded.target_convo_id,
      created_at=excluded.created_at,
      answered_at=NULL,
      delivered_at=NULL
  `).run(convoId, agentDeviceId, initiatorDeviceId, state, justification, topic, targetConvoId, Date.now())
  return { ok: true, prior: existing ?? null }
}

// Returns `{ok:true, prior}` where `prior` is the full row as it stood
// BEFORE this call (null if no row existed) — a caller whose delivery then
// fails needs the WHOLE prior row, not just its state, to restore it exactly
// rather than erasing it (see undoInvite below).
export function inviteParticipant(db, { convoId, agentDeviceId, initiatorDeviceId, justification = '', targetConvoId = null }) {
  return upsertRow(db, { convoId, agentDeviceId, initiatorDeviceId, state: 'invited', justification, topic: '', targetConvoId })
}

// Parks a request awaiting the user's consent — same renew/conflict
// semantics as inviteParticipant, but the row lands in 'awaiting_user'
// (never delivered to the target) and carries the topic the user will see
// on the approval card. See answerParkedInvite for how a park resolves.
export function parkInvite(db, { convoId, agentDeviceId, initiatorDeviceId, justification = '', topic = '', targetConvoId = null }) {
  return upsertRow(db, { convoId, agentDeviceId, initiatorDeviceId, state: 'awaiting_user', justification, topic, targetConvoId })
}

// A direct joined row, no invite round-trip — the spawn approval path
// (spec: "records both agents as joined; approving the spawn approved the
// pair"). The room owner is recorded on conversations.agent_device_id as
// everywhere else, so only the NON-owner participant gets a row here.
export function recordJoined(db, { convoId, agentDeviceId, initiatorDeviceId }) {
  return upsertRow(db, { convoId, agentDeviceId, initiatorDeviceId, state: 'joined', justification: '', topic: '' })
}

// Resolves a parked row per the user's decision. Approve restarts
// created_at (the 30-minute answer-from-target clock has not started yet —
// delivered_at stays NULL until markDelivered fires) and clears answered_at
// so the row reads as freshly pending, not previously answered. Deny is
// terminal and stamps answered_at, same shape as answerInvite's refusal.
// Scoped to state='awaiting_user' so answering twice, or answering a row
// that was never parked, is a no-op false rather than a silent state stomp.
export function answerParkedInvite(db, { convoId, agentDeviceId, approve, now = Date.now() }) {
  const r = approve
    ? db.prepare("UPDATE convo_agents SET state='invited', created_at=?, answered_at=NULL WHERE convo_id=? AND agent_device_id=? AND state='awaiting_user'").run(now, convoId, agentDeviceId)
    : db.prepare("UPDATE convo_agents SET state='denied', answered_at=? WHERE convo_id=? AND agent_device_id=? AND state='awaiting_user'").run(now, convoId, agentDeviceId)
  return r.changes === 1
}

// Stamps actual relay to the recipient — called by whichever of the pump's
// three callers (HTTP approve, agent hello, sweep timer) actually got the
// frame onto a live socket. The delivered_at IS NULL guard makes repeat
// calls (a hello racing the sweep) a no-op rather than clobbering an earlier
// stamp, and scoping to state='invited' keeps a row that has since moved on
// (left/expired) from being stamped after the fact.
export function markDelivered(db, { convoId, agentDeviceId, now = Date.now() }) {
  return db.prepare("UPDATE convo_agents SET delivered_at=? WHERE convo_id=? AND agent_device_id=? AND state='invited' AND delivered_at IS NULL")
    .run(now, convoId, agentDeviceId).changes === 1
}

// Every approved invite the delivery pump still owes a relay to. Joined to
// conversations for the two facts the pump needs but convo_agents doesn't
// carry: which user owns the room (to scope the hub lookup) and which
// device manages it (the recipient for a self-initiated JOIN REQUEST row,
// where agent_device_id names the joiner, not the target — see
// deliverPendingInvites in invite-delivery.js for the routing logic this
// feeds).
export function undeliveredInvites(db) {
  return db.prepare(`
    SELECT ca.convo_id, ca.agent_device_id, ca.initiator_device_id, ca.justification, ca.topic, ca.target_convo_id,
           c.owner_user_id, c.agent_device_id AS room_agent_device_id
    FROM convo_agents ca JOIN conversations c ON c.id = ca.convo_id
    WHERE ca.state='invited' AND ca.delivered_at IS NULL
  `).all()
}

// Outstanding parked asks for one requester, across every room — the cap
// that keeps a single device from flooding the user's attention with asks
// (MAX_AWAITING_PER_REQUESTER in ws.js).
export function awaitingCount(db, initiatorDeviceId) {
  return db.prepare("SELECT COUNT(*) c FROM convo_agents WHERE state='awaiting_user' AND initiator_device_id=?").get(initiatorDeviceId).c
}

// Every row awaiting this user's decision, joined to conversations for the
// title the pending endpoint/CLI displays alongside the ask, and to devices
// for the two names the ask is ABOUT. The live consent card carries
// `from_name` in its payload; a client reading this durable inbox instead
// (it was offline when the card was minted) gets the same fact here rather
// than having to reconstruct it from the room title. LEFT JOIN so a row
// whose device was revoked mid-ask still lists, with a null name.
export function listAwaiting(db, userId) {
  return db.prepare(`
    SELECT ca.convo_id, ca.agent_device_id, ca.initiator_device_id, ca.justification, ca.topic, ca.created_at, c.title,
           di.name AS initiator_name, dt.name AS agent_name
    FROM convo_agents ca JOIN conversations c ON c.id = ca.convo_id
    LEFT JOIN devices di ON di.id = ca.initiator_device_id AND di.user_id = c.owner_user_id
    LEFT JOIN devices dt ON dt.id = ca.agent_device_id AND dt.user_id = c.owner_user_id
    WHERE ca.state='awaiting_user' AND c.owner_user_id=? ORDER BY ca.created_at
  `).all(userId)
}

// Sweep half of the 24h awaiting_user TTL, mirroring expireInvites below:
// flip stale parked rows and report them so the caller can tell the
// requester its ask timed out. RETURNING keeps flip-and-report atomic.
export function expireAwaiting(db, ttlMs, now = Date.now()) {
  return db.prepare(
    "UPDATE convo_agents SET state='expired', answered_at=? WHERE state='awaiting_user' AND created_at<=? RETURNING convo_id, agent_device_id, initiator_device_id"
  ).all(now, now - ttlMs)
}

export function answerInvite(db, { convoId, agentDeviceId, accept, now = Date.now() }) {
  return db.prepare(
    "UPDATE convo_agents SET state=?, answered_at=? WHERE convo_id=? AND agent_device_id=? AND state='invited'"
  ).run(accept ? 'joined' : 'refused', now, convoId, agentDeviceId).changes > 0
}

export function leaveConvo(db, { convoId, agentDeviceId, now = Date.now() }) {
  return db.prepare(
    "UPDATE convo_agents SET state='left', answered_at=? WHERE convo_id=? AND agent_device_id=? AND state='joined'"
  ).run(now, convoId, agentDeviceId).changes > 0
}

// Unconditional delete — no restoration of any prior renewed row. Direct
// callers (tests, admin-style cleanup) that want that ought to use
// `isParticipant`/inspect the row themselves first; a bare delete here would
// erase a renewed row's prior history, which is what `undoInvite` below
// exists to avoid (see its doc comment).
export function removeParticipant(db, convoId, agentDeviceId) {
  db.prepare('DELETE FROM convo_agents WHERE convo_id=? AND agent_device_id=?').run(convoId, agentDeviceId)
}

// Restores whatever `prior` row `inviteParticipant` captured (a renewed
// `refused`/`left`/`expired` row) rather than erasing it — otherwise a
// refused device could wipe its own refusal history just by
// join-requesting. `prior: null` (inviteParticipant found no earlier row at
// all) means the row it just inserted was wholly new — delete it, same as
// the old behavior. This used to undo a failed delivery attempt in ws.js (a
// request frame sent to a target with no live socket); Task 1 removed that
// path — every ask parks instead of attempting delivery, so parking never
// fails and never needs undoing. `undoInvite` has no production caller left;
// it is retained as a helper for its own direct unit test in
// test/participants.test.js, which pins this restore-vs-delete behavior.
export function undoInvite(db, convoId, agentDeviceId, prior) {
  if (prior == null) {
    removeParticipant(db, convoId, agentDeviceId)
    return
  }
  db.prepare(`
    UPDATE convo_agents SET state=?, initiator_device_id=?, justification=?, topic=?, target_convo_id=?, created_at=?, answered_at=?, delivered_at=?
    WHERE convo_id=? AND agent_device_id=?
  `).run(prior.state, prior.initiator_device_id, prior.justification, prior.topic, prior.target_convo_id ?? null, prior.created_at, prior.answered_at, prior.delivered_at, convoId, agentDeviceId)
}

// Owner-leave dissolution (ws.js agent_leave): the recorded owner has no
// convo_agents row of its own, so an owner leaving means the whole room
// winds down — every LIVE row (state 'joined', 'invited', or
// 'awaiting_user') flips to 'left'. Scoped to those three states on
// purpose: 'refused'/'denied'/'expired' are terminal outcomes, i.e.
// history, and rewriting them to 'left' would destroy the record of a
// refusal (and make a later `already refused` conflict read as `already
// left`).
//
// Returns both halves of the notification duty, because the two are owed
// DIFFERENT frames:
//   - `joined`: device ids that were in the room, owed `event:'left'`.
//   - `pending`: every still-`invited`/`awaiting_user` row as
//     {agent_device_id, initiator_device_id}. Whoever INITIATED such a row
//     is blocked waiting for an answer that this dissolve has just made
//     impossible — a peer's answer for an 'invited' row, or the user's
//     consent decision for a parked 'awaiting_user' row — and neither the
//     expiry sweep nor the awaiting-TTL sweep can rescue it (their
//     predicates are state='invited'/state='awaiting_user', which the flip
//     has erased). ws.js turns each row whose initiator is not the leaving
//     owner into a synthetic refusal.
//
// SELECT-then-UPDATE instead of a single RETURNING statement because
// RETURNING reports post-update values, which can't tell a
// previously-joined row from a previously-invited/parked one; the two
// statements can't interleave (better-sqlite3 is synchronous). Idempotent:
// a room with nothing to flip returns empty lists.
export function leaveAllParticipants(db, convoId, now = Date.now()) {
  const live = db.prepare(
    "SELECT agent_device_id, initiator_device_id, state FROM convo_agents WHERE convo_id=? AND state IN ('invited','joined','awaiting_user')"
  ).all(convoId)
  db.prepare(
    "UPDATE convo_agents SET state='left', answered_at=? WHERE convo_id=? AND state IN ('invited','joined','awaiting_user')"
  ).run(now, convoId)
  return {
    joined: live.filter((r) => r.state === 'joined').map((r) => r.agent_device_id),
    pending: live.filter((r) => r.state !== 'joined')
      .map(({ agent_device_id, initiator_device_id }) => ({ agent_device_id, initiator_device_id })),
  }
}

// "Is this conversation a room at all?" — ANY convo_agents row, any state.
// The owner-dissolve branch of agent_leave needs this because convo_upsert
// stamps agent_device_id on EVERY agent-created conversation, so "caller is
// the recorded owner" alone would catch plain solo convos that never had a
// participant and turn their leave into a silent success. Deliberately
// state-agnostic (not just live rows) so a dissolved room stays idempotent
// on a repeat owner-leave. Same predicate convo_upsert's room-ownership
// gate uses.
export function hasParticipants(db, convoId) {
  return !!db.prepare('SELECT 1 FROM convo_agents WHERE convo_id=? LIMIT 1').get(convoId)
}

export function joinedAgentIds(db, convoId) {
  return db.prepare(
    "SELECT agent_device_id FROM convo_agents WHERE convo_id=? AND state='joined'"
  ).all(convoId).map((r) => r.agent_device_id)
}

export function getParticipant(db, convoId, agentDeviceId) {
  return db.prepare(
    'SELECT state, initiator_device_id, justification, topic, target_convo_id, created_at, answered_at, delivered_at FROM convo_agents WHERE convo_id=? AND agent_device_id=?'
  ).get(convoId, agentDeviceId) ?? null
}

export function isParticipant(db, convoId, agentDeviceId) {
  return !!db.prepare(
    'SELECT 1 FROM convo_agents WHERE convo_id=? AND agent_device_id=?'
  ).get(convoId, agentDeviceId)
}

// Room-privacy gate exemption (ws.js loadRoom) — deliberately narrower than
// isParticipant's "any row, any state". A convo_agents row only proves a
// caller legitimately already knows a private-owned room exists if the
// caller initiated the row themselves (a join request they sent — they
// already targeted this room's id), it was actually delivered to them
// (delivered_at set), or they're joined. An 'awaiting_user' row (parked for
// the user's consent, never relayed to the target's socket) and a 'denied'
// one (the user's refusal, never told to the target either) must NOT exempt
// an ordinary caller merely probing — either would leak a private room's
// existence to exactly the agent the user never approved or explicitly
// refused. 'expired' is ambiguous by which sweep produced it — expired from
// 'invited' (expireInvites) requires delivered_at IS NOT NULL, so it stays
// exempt; expired from 'awaiting_user' (expireAwaiting) never had
// delivered_at set, so it doesn't. delivered_at alone discriminates both
// cases correctly without inspecting how the row got to 'expired'.
export function isKnownParticipant(db, convoId, agentDeviceId) {
  const row = db.prepare(
    'SELECT initiator_device_id, state, delivered_at FROM convo_agents WHERE convo_id=? AND agent_device_id=?'
  ).get(convoId, agentDeviceId)
  if (!row) return false
  return row.initiator_device_id === agentDeviceId || row.delivered_at != null || row.state === 'joined'
}

// Sweep half of invite expiry (ws.js owns the timer and the caller
// notification): flip stale pending rows and report them. RETURNING keeps
// flip-and-report atomic — no separate SELECT that a concurrent answer
// could race. Clocked by delivered_at, not created_at: the 30-minute
// answer window is a window for the TARGET to answer, so it must not start
// ticking before the target has actually seen the ask — an
// approved-but-undelivered row (target offline, or an admin-approved park
// still waiting on the pump) is exempt (delivered_at IS NULL) so it can
// never expire out from under an offline target.
export function expireInvites(db, ttlMs, now = Date.now()) {
  return db.prepare(
    "UPDATE convo_agents SET state='expired', answered_at=? WHERE state='invited' AND delivered_at IS NOT NULL AND delivered_at<=? RETURNING convo_id, agent_device_id, initiator_device_id"
  ).all(now, now - ttlMs)
}
