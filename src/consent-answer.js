// Applying a consent decision — the one code path behind the user's tap
// (POST /agent-chat/answer, POST /agent-spawn/answer) and the
// Coordinator's answer (POST /consent/answer). `decidedBy` is
// {kind:'user', deviceId} for a tap, or {kind:'coordinator', deviceId,
// convoId, reason, causeKind?, causeRef?, verifierNote?} — the cause fields
// only on the Coordinator's approval of an ask it made itself. The
// Coordinator form additionally stamps the row (answered_by /
// answer_reason), records the decision for the caps, and appends a client-only `consent_decision` event on the card's
// conversation so the apps can show "approved by the Coordinator".
// Returns {status, body} for the route to send.
import { answerParkedInvite, getParticipant } from './participants.js'
import { closeChatConsentItem, closeSpawnConsentItem, CONSENT_ACTIONS } from './consent-items.js'
import { deliverPendingInvites } from './invite-delivery.js'
import { getSpawn, denySpawn, claimApprove, approveSpawn, emitSpawnOutcome } from './spawns.js'
import { wakeIfOffline } from './wake.js'
import { appendAndBroadcast } from './journal.js'
import { recordConsentDecision, CONSENT_DECISION_EVENT_TYPE } from './consent.js'

const byCoordinator = (decidedBy) => decidedBy?.kind === 'coordinator'
const stamp = (decidedBy) => (byCoordinator(decidedBy) ? { answeredBy: 'coordinator', answerReason: decidedBy.reason } : {})

// Exported for the transfer kind (src/transfer-consent.js), which answers
// through its own module but records and announces exactly like these two.
export function recordAndAnnounce({ db, hub }, { userId, kind, askId, decision, decidedBy, convoId, payload }) {
  if (!byCoordinator(decidedBy)) return
  try {
    recordConsentDecision(db, {
      userId, kind, askId, decision, convoId: decidedBy.convoId, reason: decidedBy.reason,
      causeKind: decidedBy.causeKind ?? null, causeRef: decidedBy.causeRef ?? null, verifierNote: decidedBy.verifierNote ?? null,
    })
  } catch (err) {
    // The answer stands; the counters reading this table do not.
    console.error(`journal: consent decision not recorded (${err?.name}) for ${kind} ${askId} — fire and routine caps will under-count`)
  }
  try {
    appendAndBroadcast(db, hub, {
      userId, convoId, sender: 'journal', type: CONSENT_DECISION_EVENT_TYPE,
      payload: {
        kind, ...payload, decision, by: 'coordinator', convo_id: decidedBy.convoId, reason: decidedBy.reason,
        cause: decidedBy.causeKind ? { kind: decidedBy.causeKind, ref: decidedBy.causeRef } : null,
      },
    })
  } catch (err) {
    console.error('consent: consent_decision append failed (the answer stands)', err)
  }
}

export function answerChatAsk({ db, hub, waker }, { userId, roomId, targetDeviceId, decision, decidedBy }) {
  const room = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(roomId)
  // Unknown room and a room owned by someone else are indistinguishable
  // (404, never 403) — same anti-enumeration stance as GET /convo/:id/messages.
  if (!room || room.owner_user_id !== userId) return { status: 404, body: { error: 'not_found' } }
  const row = getParticipant(db, roomId, targetDeviceId)
  if (!row || row.state !== 'awaiting_user') return { status: 409, body: { error: 'conflict' } }
  const answeredByDeviceId = decidedBy?.deviceId ?? null
  if (decision === 'decline') {
    answerParkedInvite(db, { convoId: roomId, agentDeviceId: targetDeviceId, approve: false, ...stamp(decidedBy) })
    // The tracker mirror (spec: 2026-09-22 consent-items), best-effort.
    closeChatConsentItem({ db, hub }, roomId, targetDeviceId, { outcome: 'denied', answeredByDeviceId })
    recordAndAnnounce({ db, hub }, { userId, kind: 'chat', askId: `${roomId}/${targetDeviceId}`, decision, decidedBy, convoId: roomId, payload: { room_id: roomId, target_device_id: targetDeviceId } })
    // Indistinguishable from a peer refusal — reason 'refused', never
    // 'denied' (a requester must never learn who said no, or that it was a
    // person at all).
    hub.sendToDevice(userId, row.initiator_device_id, {
      kind: 'invite', event: 'answer', room_id: roomId, peer_device_id: targetDeviceId, accept: false, reason: 'refused',
    })
    return { status: 200, body: { ok: true } }
  }
  answerParkedInvite(db, { convoId: roomId, agentDeviceId: targetDeviceId, approve: true, ...stamp(decidedBy) })
  closeChatConsentItem({ db, hub }, roomId, targetDeviceId, { outcome: 'approved', answeredByDeviceId })
  recordAndAnnounce({ db, hub }, { userId, kind: 'chat', askId: `${roomId}/${targetDeviceId}`, decision, decidedBy, convoId: roomId, payload: { room_id: roomId, target_device_id: targetDeviceId } })
  // Join requests self-target (row.initiator_device_id === targetDeviceId,
  // the joiner) — the recipient of THIS row's relay (and, below, the
  // directed-pair target) is the room owner, not the joiner itself.
  const isJoin = row.initiator_device_id === targetDeviceId
  const recipient = isJoin ? room.agent_device_id : targetDeviceId
  // Scoped to this row's own recipient: the unscoped pump sweeps every
  // undelivered row system-wide, so an unrelated row's successful delivery
  // could otherwise make `sent > 0` true while THIS row's target is still
  // offline. Even scoped, `sent` could reflect a different row addressed to
  // the same recipient device — so the response flag is read back off the
  // answered row itself, which is exact.
  deliverPendingInvites(db, hub, { deviceId: recipient })
  const delivered = getParticipant(db, roomId, targetDeviceId)?.delivered_at != null
  // Undelivered means the recipient has no live socket — most often a box
  // the host idle-stopped since the ask was parked. Wake it: the approved
  // row is pumped again the moment its bridge says hello
  // (deliverPendingInvites on register), so nothing is lost meanwhile.
  if (!delivered) wakeIfOffline({ db, hub, waker }, userId, recipient)
  return { status: 200, body: { ok: true, delivered } }
}

export function answerSpawnAsk({ db, hub, broker, waker, spawnStartTimeoutMs, spawnWakeWaitMs }, { userId, requestId, decision, decidedBy }) {
  const row = getSpawn(db, requestId)
  // Unknown id and another user's row are indistinguishable.
  if (!row || row.user_id !== userId) return { status: 404, body: { error: 'not_found' } }
  const answeredByDeviceId = decidedBy?.deviceId ?? null
  if (decision === 'decline') {
    if (!denySpawn(db, requestId, Date.now(), stamp(decidedBy))) return { status: 409, body: { error: 'conflict' } }
    recordAndAnnounce({ db, hub }, { userId, kind: 'spawn', askId: requestId, decision, decidedBy, convoId: row.from_convo_id, payload: { request_id: requestId } })
    // Reported plainly (spec: no peer to hide behind) — 'declined', never a
    // fabricated box-side failure.
    emitSpawnOutcome(db, hub, { userId, fromDeviceId: row.from_device_id, fromConvoId: row.from_convo_id, requestId, outcome: 'declined', answeredByDeviceId })
    return { status: 200, body: { ok: true } }
  }
  // The answer CLAIMS the row; a zero row-count means another answer
  // already won — 409, and nothing expensive has started (spec failure
  // table: two approve taps spawn once).
  if (!claimApprove(db, requestId, Date.now(), stamp(decidedBy))) return { status: 409, body: { error: 'conflict' } }
  // The ask stopped waiting at the claim, so its tracker item closes now —
  // not at the outcome, which can be minutes away when the target box has
  // to be woken first. Left open, the item sits in the user's Decisions
  // list offering an Approve that can only answer 409. The outcome adds how
  // the start went (closeSpawnConsentItem). Best-effort, like every mirror
  // write.
  closeSpawnConsentItem({ db, hub }, requestId, { outcome: 'approved', answeredByDeviceId })
  recordAndAnnounce({ db, hub }, { userId, kind: 'spawn', askId: requestId, decision, decidedBy, convoId: row.from_convo_id, payload: { request_id: requestId } })
  // Everything after the claim is expensive and externally visible; it runs
  // off the request cycle — the caller needs its 200 now, the outcome
  // reaches the parent as a turn. Errors are contained: the broker timeout
  // guarantees approveSpawn itself always settles. wake-before-spawn: a
  // target that went to sleep between the card and the answer is woken and
  // waited for (up to spawnWakeWaitMs) before the start RPC.
  approveSpawn({
    db, hub, broker, startTimeoutMs: spawnStartTimeoutMs, answeredByDeviceId,
    wakeWaitMs: spawnWakeWaitMs,
    wakeTarget: () => wakeIfOffline({ db, hub, waker }, userId, row.target_device_id),
  }, getSpawn(db, requestId))
    .catch((err) => console.error('agent-spawn approve orchestration failed', err))
  return { status: 200, body: { ok: true } }
}

// A tap on a spawn or chat consent item's own Approve / Decline (POST
// /items/:id/comments with `action`): the same answer the card gives, with
// the card route's gate (a client, never an agent). The ask is found from
// the row that points at this item, never from the item's agent-written
// link, so a tap answers exactly the ask the item was filed for. A row no
// longer waiting is 409 whatever the label says, with a message an app can
// show as it is ("already answered").
export function consentItemTapAnswer(ctx, who, item, action) {
  if (who.kind !== 'client') return { status: 403, body: { error: 'forbidden' } }
  const { db } = ctx
  if (item.consent === 'spawn') {
    const row = db.prepare('SELECT id, state FROM agent_spawn_requests WHERE item_id=? AND user_id=?').get(item.id, who.userId)
    if (!row || row.state !== 'awaiting_user') return staleTap(row?.state)
    if (!CONSENT_ACTIONS.includes(action)) return { status: 400, body: { error: 'unknown_action' } }
    return withStaleMessage(answerSpawnAsk(ctx, { userId: who.userId, requestId: row.id, decision: tapDecision(action), decidedBy: { kind: 'user', deviceId: who.deviceId } }), () => getSpawn(db, row.id)?.state)
  }
  const row = db.prepare('SELECT convo_id, agent_device_id, state FROM convo_agents WHERE item_id=?').get(item.id)
  if (!row || row.state !== 'awaiting_user') return staleTap(row ? CHAT_STALE[row.state] : undefined)
  if (!CONSENT_ACTIONS.includes(action)) return { status: 400, body: { error: 'unknown_action' } }
  return withStaleMessage(answerChatAsk(ctx, { userId: who.userId, roomId: row.convo_id, targetDeviceId: row.agent_device_id, decision: tapDecision(action), decidedBy: { kind: 'user', deviceId: who.deviceId } }), () => CHAT_STALE[getParticipant(db, row.convo_id, row.agent_device_id)?.state])
}

const tapDecision = (action) => (action === 'Decline' ? 'decline' : 'approve')
// A chat row's states in the spawn row's words, for the message.
const CHAT_STALE = { invited: 'approved', joined: 'approved', denied: 'denied', expired: 'expired' }
export function staleConsentMessage(state) {
  if (state === 'approved' || state === 'started' || state === 'failed') return 'Already answered: this request was approved.'
  if (state === 'denied') return 'Already answered: this request was declined.'
  if (state === 'expired') return 'This request expired before it was answered.'
  return 'This request is no longer waiting for an answer.'
}
const staleTap = (state) => ({ status: 409, body: { error: 'conflict', reason: 'already_answered', message: staleConsentMessage(state) } })
// The answer lost a race (another device, the card or the Coordinator got
// there first): the same 409, saying how the ask ended.
function withStaleMessage(r, stateNow) {
  return r.status === 409 ? staleTap(stateNow()) : r
}
