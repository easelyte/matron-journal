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
import { consentApproval, chatAskRow, approvalColumn } from './consent-subject.js'
import { ApprovalRefused } from './approval-keys.js'
import { securityLogOf, boxTarget } from './security-log.js'
import { lockedApprovalRefusal } from './panic.js'

// Approvals of an ask aimed at a protected box (src/consent-subject.js):
// the signature check and the state change it guards run in ONE
// transaction, so a refusal writes nothing (the nonce stays unspent) and a
// check that passed cannot be left without its change, nor a change
// without its check. `apply(approval)` makes the change and answers whether
// it won; a lost race is the 409 and rolls the nonce back too. → null when
// applied, else the {status, body} to answer. Exported for the transfer
// kind (src/transfer-consent.js).
export const CONFLICT = Object.freeze({ ok: false, status: 409, body: { error: 'conflict' } })
export function guardedApprove(db, check, apply) {
  try {
    db.transaction(() => {
      const g = check()
      if (!g.ok) throw new ApprovalRefused(g)
      if (!apply(g.approval)) throw new ApprovalRefused(CONFLICT)
    })()
    return null
  } catch (err) {
    if (err instanceof ApprovalRefused) return err.refusal
    throw err
  }
}

const byCoordinator = (decidedBy) => decidedBy?.kind === 'coordinator'

// An approval that has committed (the security log): by the user's tap or
// the Coordinator's answer, from the device that sent it. `target` names
// what it lets through: the box by its current name (box:<name>), or the
// transfer (transfer:<id>). Exported for the transfer kind.
export function recordApproved(ctx, userId, event, decidedBy, target) {
  securityLogOf(ctx).record(userId, event, {
    deviceId: decidedBy?.deviceId ?? null, target, decidedBy: byCoordinator(decidedBy) ? 'coordinator' : 'user',
  })
}
const stamp = (decidedBy) => (byCoordinator(decidedBy) ? { answeredBy: 'coordinator', answerReason: decidedBy.reason } : {})

// Exported for the transfer kind (src/transfer-consent.js), which answers
// through its own module but records and announces exactly like these two.
export function recordAndAnnounce({ db, hub }, { userId, kind, askId, decision, decidedBy, convoId, payload }) {
  if (!byCoordinator(decidedBy)) return
  try {
    // Automatic spawn claims already recorded their decision atomically.
    if (!decidedBy.recorded) recordConsentDecision(db, {
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
        ...(decidedBy.automatic === true ? { auto: true } : {}),
        cause: decidedBy.causeKind ? { kind: decidedBy.causeKind, ref: decidedBy.causeRef } : null,
      },
    })
  } catch (err) {
    console.error('consent: consent_decision append failed (the answer stands)', err)
  }
}

// `approval` (the user's signed approval, src/consent-subject.js) counts
// only on an approval of an ask aimed at a protected box; it is ignored on
// a decline and on every other ask.
export function answerChatAsk({ db, hub, waker, journalHost = null, securityLog }, { userId, roomId, targetDeviceId, decision, decidedBy, approval = null }) {
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
  const refused = guardedApprove(db,
    () => {
      // A panic-locked account (src/panic.js): no approval, whoever gives it.
      const locked = lockedApprovalRefusal(db, userId)
      if (locked) return locked
      // Re-read inside the transaction: an ask answered meanwhile is the
      // 409 a lost race gives, before any signature is looked at.
      const now = chatAskRow(db, userId, roomId, targetDeviceId)
      if (now?.state !== 'awaiting_user') return CONFLICT
      return consentApproval({ db, journalHost }, userId, decidedBy, 'chat', now, approval)
    },
    (signed) => answerParkedInvite(db, { convoId: roomId, agentDeviceId: targetDeviceId, approve: true, ...stamp(decidedBy), approval: approvalColumn(signed) }))
  if (refused) return refused
  recordApproved({ db, securityLog }, userId, 'chat_approved', decidedBy, boxTarget(db, targetDeviceId))
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

export function answerSpawnAsk({ db, hub, broker, waker, spawnStartTimeoutMs, spawnWakeWaitMs, journalHost = null, securityLog }, { userId, requestId, decision, decidedBy, approval = null }) {
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
  // For a spawn onto a protected box the claim also checks and stores the
  // user's signed approval, which the `start` params then carry. Automatic
  // approvals must consume their hourly allowance durably before any session
  // starts: the decision is written inside the same guarded transaction as
  // the claim, so a failed write rolls the claim back.
  // Set only by the journal's own automatic path (src/ws.js); never derived
  // from the reason text, which the Coordinator can send itself.
  const automatic = byCoordinator(decidedBy) && decidedBy.automatic === true
  const refused = guardedApprove(db,
    () => {
      const locked = lockedApprovalRefusal(db, userId)
      if (locked) return locked
      // An ask already answered is the 409 a lost claim gives, before any
      // signature is looked at.
      const now = getSpawn(db, requestId)
      if (now?.state !== 'awaiting_user') return CONFLICT
      return consentApproval({ db, journalHost }, userId, decidedBy, 'spawn', now, approval)
    },
    (signed) => {
      if (!claimApprove(db, requestId, Date.now(), { ...stamp(decidedBy), approval: signed })) return false
      if (automatic) recordConsentDecision(db, {
        userId, kind: 'spawn', askId: requestId, decision, convoId: decidedBy.convoId,
        reason: decidedBy.reason, causeKind: decidedBy.causeKind, causeRef: decidedBy.causeRef,
      })
      return true
    })
  if (refused) return refused
  if (automatic) decidedBy = { ...decidedBy, recorded: true }
  recordApproved({ db, securityLog }, userId, 'spawn_approved', decidedBy, boxTarget(db, row.target_device_id))
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
export function consentItemTapAnswer(ctx, who, item, action, approval = null) {
  if (who.kind !== 'client') return { status: 403, body: { error: 'forbidden' } }
  const { db } = ctx
  if (item.consent === 'spawn') {
    const row = db.prepare('SELECT id, state FROM agent_spawn_requests WHERE item_id=? AND user_id=?').get(item.id, who.userId)
    if (!row || row.state !== 'awaiting_user') return staleTap(row?.state)
    if (!CONSENT_ACTIONS.includes(action)) return { status: 400, body: { error: 'unknown_action' } }
    return withStaleMessage(answerSpawnAsk(ctx, { userId: who.userId, requestId: row.id, decision: tapDecision(action), decidedBy: { kind: 'user', deviceId: who.deviceId }, approval }), () => getSpawn(db, row.id)?.state)
  }
  const row = db.prepare('SELECT convo_id, agent_device_id, state FROM convo_agents WHERE item_id=?').get(item.id)
  if (!row || row.state !== 'awaiting_user') return staleTap(row ? CHAT_STALE[row.state] : undefined)
  if (!CONSENT_ACTIONS.includes(action)) return { status: 400, body: { error: 'unknown_action' } }
  return withStaleMessage(answerChatAsk(ctx, { userId: who.userId, roomId: row.convo_id, targetDeviceId: row.agent_device_id, decision: tapDecision(action), decidedBy: { kind: 'user', deviceId: who.deviceId }, approval }), () => CHAT_STALE[getParticipant(db, row.convo_id, row.agent_device_id)?.state])
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
