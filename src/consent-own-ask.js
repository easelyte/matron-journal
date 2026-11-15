// The Coordinator's own asks. An ask the Coordinator made itself — a spawn
// asked for from its own conversation, a chat it opened from it — is not
// its to approve on its own say-so: an injected turn could otherwise ask
// for anything and wave it through. POST /consent/answer approves one only
// when the ask's causes resolve (src/ask-cause.js) to a root the journal
// can vouch for:
//  - the user's words, or a reply or tap of theirs on one of the asking
//    conversation's items: approved as any other ask;
//  - a fire of one of the user's routines: only inside that routine's
//    envelope (spawns per fire, chats, boxes), only when the verifier
//    (src/verifier.js) finds the ask within the routine's remit and not
//    injected, and only under the rolling 24 h routine cap. The verifier
//    is consulted a few times per ask at most (VERIFIER_REFUSALS_MAX).
// Every check is a read; nothing is written until all of them pass.
// Declines are never gated and never come here.
//
// An ask ANOTHER session made is held to the same rule when the Coordinator
// had it made — by a carry-on, or a room message, however many sessions it
// passed through (src/cause-hops.js resolveRelayedAsk): each Coordinator hop
// behind it must resolve as the Coordinator's own ask would. Every other ask
// is answered as before.
import { resolveAskCause } from './ask-cause.js'
import { resolveRelayedAsk } from './cause-hops.js'
import { parseCauses } from './ask-causes.js'
import { getParticipant } from './participants.js'
import { getSpawn } from './spawns.js'
import { getRoutine } from './routines.js'
import {
  approvalsForFire, coordinatorRoutineApprovalsSince, CONSENT_ROUTINE_CAP_DEFAULT, CONSENT_DAILY_WINDOW_MS,
  getConsentEnabled, isUserOnlySpawn, isUserOnlyChat, deviceState,
} from './consent.js'

// The asking conversation is the Coordinator's: a spawn asked for from it,
// or a chat ask made from it (a bridge that predates from_convo_id names
// none, and then the asking box being the Coordinator's decides).
export function isOwnAsk(who, body, row) {
  if (body.kind === 'spawn') return row.from_convo_id === body.convo_id
  return row.initiator_convo_id === body.convo_id || (row.initiator_convo_id == null && row.initiator_device_id === who.deviceId)
}

const deviceName = (db, userId, deviceId) =>
  (Number.isInteger(deviceId) ? db.prepare('SELECT name FROM devices WHERE id=? AND user_id=?').get(deviceId, userId)?.name : null) ?? ''

// The ask as the gate needs it: whether it is the Coordinator's own, its
// causes and time, the box it reaches, and the fields the verifier judges.
export function spawnAsk(db, who, body, row) {
  const targetBox = deviceName(db, who.userId, row.target_device_id)
  return {
    kind: 'spawn', id: row.id, own: isOwnAsk(who, body, row), askConvoId: row.from_convo_id, causes: row.causes, createdAt: row.created_at, targetBox,
    verifier: { kind: 'spawn', task: row.task, target_box: targetBox, workdir: row.workdir, topic: row.topic || '' },
  }
}

// A chat ask still awaiting the user in one of the user's rooms, or null —
// the answer path then gives its own 404 / 409. The box it reaches is the
// invitee, or for a join the room's owner. `causes` and `createdAt` are the
// row's own (raw causes text): a chat ask is keyed only by (room, target),
// and a declined row is renewed in place, so they are what tells a later
// read whether it is still the same ask.
export function chatAsk(db, who, body, { roomId, targetDeviceId }) {
  const room = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(roomId)
  if (!room || room.owner_user_id !== who.userId) return null
  const row = getParticipant(db, roomId, targetDeviceId)
  if (!row || row.state !== 'awaiting_user') return null
  const isJoin = row.initiator_device_id === targetDeviceId
  const targetBox = deviceName(db, who.userId, isJoin ? room.agent_device_id : targetDeviceId)
  return {
    kind: 'chat', roomId, targetDeviceId, own: isOwnAsk(who, body, row), askConvoId: row.initiator_convo_id, causes: row.causes, createdAt: row.created_at, targetBox,
    verifier: { kind: 'chat', justification: row.justification, target_box: targetBox, topic: row.topic || '' },
  }
}

const refusal = (status, detail, extra) => ({
  ok: false, status, body: { error: status === 403 ? 'forbidden' : 'conflict', detail, ...extra },
})

// → why the ask falls outside the fire's envelope, or null. `routine` is
// the routine row as read (its envelope parsed), `root` the fire.
function outsideEnvelope(db, userId, root, routine, ask) {
  const env = routine.envelope
  if (!env) return `the routine "${routine.name}" has no envelope`
  if (ask.kind === 'chat' && !env.chats) return `the routine "${routine.name}" may not open chats`
  if (ask.kind === 'spawn' && approvalsForFire(db, userId, root.ref, 'spawn') >= env.spawns_per_fire) {
    return `the routine "${routine.name}" may start ${env.spawns_per_fire} spawn(s) per fire, and this fire has used them`
  }
  if (env.boxes && !env.boxes.includes(ask.targetBox)) return `the routine "${routine.name}" may not reach the box "${ask.targetBox}"`
  return null
}

// After the wait: the cheap preconditions the route checked before it,
// again and in the same order (the switch, the ask still awaiting and
// still the same ask — its time, causes, justification and topic —
// user_only, target_offline), with their own refusals. A changed or
// answered ask is the bare 409 a lost claim answers.
function changedWhileVerifying(ctx, who, ask) {
  const { db } = ctx
  if (!getConsentEnabled(db, who.userId)) return refusal(403, 'consent_disabled')
  if (ask.kind === 'spawn') {
    const row = getSpawn(db, ask.id)
    if (!row || row.state !== 'awaiting_user') return conflict()
    if (isUserOnlySpawn(db, who.userId, row)) return refusal(403, 'user_only')
    if (deviceState(ctx, who.userId, row.target_device_id) === 'offline') return refusal(409, 'target_offline')
    return null
  }
  if (isUserOnlyChat(db, who.userId, ask.roomId, ask.targetDeviceId)) return refusal(403, 'user_only')
  const row = getParticipant(db, ask.roomId, ask.targetDeviceId)
  if (!row || row.state !== 'awaiting_user' || row.created_at !== ask.createdAt || row.causes !== ask.causes) return conflict()
  // What the verifier judged must be what is approved.
  if (row.justification !== ask.verifier.justification || (row.topic || '') !== ask.verifier.topic) return conflict()
  return null
}
const conflict = () => ({ ok: false, status: 409, body: { error: 'conflict' } })

// The verifier's no. Its note is the user's to read, not the asker's: the
// answer carries a fixed reason, and the note is kept with the count
// (verifier_refusals.last_note). After VERIFIER_REFUSALS_MAX refusals of
// one ask the verifier is not consulted about it again: the approval is
// answered left_for_user and the ask stays on the user's card. One ask is
// one spawn request, or one chat ask as parked (a declined chat row asked
// again in place has a new created_at, and starts afresh).
export const VERIFIER_REFUSALS_MAX = 3
export const WHY_VERIFIER_REFUSED = 'the verifier did not confirm this ask; it stays for the user'
export const WHY_LEFT_FOR_USER = 'the verifier has not confirmed this ask; it is left for the user to answer'
const REFUSAL_TTL_MS = 30 * 24 * 60 * 60 * 1000

const askKey = (ask) => (ask.kind === 'spawn' ? ask.id : `${ask.roomId}/${ask.targetDeviceId}`)

export function refusalCount(db, userId, ask) {
  const row = db.prepare('SELECT ask_created_at, refusals FROM verifier_refusals WHERE user_id=? AND kind=? AND ask_id=?').get(userId, ask.kind, askKey(ask))
  return row && row.ask_created_at === ask.createdAt ? row.refusals : 0
}

export function recordRefusal(db, userId, ask, note, now = Date.now()) {
  // A call that outlived its ask (a chat ask declined and parked again while
  // the verifier was still answering) says nothing about the newer one.
  const stored = db.prepare('SELECT ask_created_at FROM verifier_refusals WHERE user_id=? AND kind=? AND ask_id=?').get(userId, ask.kind, askKey(ask))
  if (stored && stored.ask_created_at > ask.createdAt) return
  const refusals = refusalCount(db, userId, ask) + 1
  db.prepare(`
    INSERT INTO verifier_refusals(user_id, kind, ask_id, ask_created_at, refusals, last_note, updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(user_id, kind, ask_id) DO UPDATE SET ask_created_at=excluded.ask_created_at, refusals=excluded.refusals,
      last_note=excluded.last_note, updated_at=excluded.updated_at
  `).run(userId, ask.kind, askKey(ask), ask.createdAt, refusals, note || null, now)
  db.prepare('DELETE FROM verifier_refusals WHERE updated_at < ?').run(now - REFUSAL_TTL_MS)
}

// Verifier calls in flight, per ask (memory only: a call does not outlive
// the process). Counted with the refusals on record, so answers sent side
// by side cannot consult the verifier more often than one after another.
const inFlight = new Map()

async function askVerifier(verifier, args) {
  if (!verifier?.verify) return { ok: false, reason: 'disabled' }
  try {
    return (await verifier.verify(args)) ?? { ok: false, reason: 'error' }
  } catch {
    return { ok: false, reason: 'error' }
  }
}

// Two halves, because the verifier is a wait. verifyOwnAsk resolves the
// cause, checks the envelope and (for a routine root) asks the verifier;
// the route awaits it and then calls confirmOwnAsk SYNCHRONOUSLY, with
// nothing awaited between it, the daily cap and the decision row — so
// whatever changed during the wait (the ask answered or renewed, the
// switch, user_only, the target going offline, another approval of the
// same fire) is seen, and two approvals cannot both pass a count.
// Refusals, in order: own_ask_unverified, envelope, left_for_user,
// verifier_unavailable / verifier, then the re-checks, envelope again,
// routine_cap. `who` is the route's authenticated caller.
//
// For another session's ask: null when the Coordinator had no hand in it
// (nothing to check), else the same verdict an own ask gets.
//
// → { ok: true, root, cause: {causeKind, causeRef, verifierNote?} }
//   or { ok: false, status, body }, or null.
export async function verifyOwnAsk(ctx, { who, convoId, reason, ask }) {
  const { db } = ctx
  const causes = parseCauses(ask.causes)
  const res = ask.own
    ? resolveAskCause(db, { who, userId: who.userId, causes, createdAt: ask.createdAt, fromConvoId: convoId })
    : resolveRelayedAsk(db, { who, userId: who.userId, causes, createdAt: ask.createdAt, fromConvoId: ask.askConvoId })
  if (!ask.own && !res.relayed) return null
  if (!res.ok) return refusal(403, 'own_ask_unverified', { why: res.why })
  const { root } = res
  if (root.kind !== 'routine') return { ok: true, root, cause: { causeKind: root.kind, causeRef: root.ref } }
  const outside = outsideEnvelope(db, who.userId, root, root.routine, ask)
  if (outside) return refusal(403, 'envelope', { why: outside })
  // The routine's name and prompt only: the title is editable without the
  // user's ask, the prompt is the remit.
  const { name, prompt } = root.routine
  const flightKey = `${who.userId}:${ask.kind}:${askKey(ask)}:${ask.createdAt}`
  const flying = inFlight.get(flightKey) ?? 0
  if (refusalCount(db, who.userId, ask) + flying >= VERIFIER_REFUSALS_MAX) return refusal(403, 'left_for_user', { why: WHY_LEFT_FOR_USER })
  inFlight.set(flightKey, flying + 1)
  let verdict
  try {
    verdict = await askVerifier(ctx.verifier, { routine: { name, prompt }, ask: ask.verifier, reason })
  } finally {
    const left = inFlight.get(flightKey) - 1
    if (left > 0) inFlight.set(flightKey, left)
    else inFlight.delete(flightKey)
  }
  if (!verdict.ok) {
    const why = verdict.reason === 'disabled' ? 'no verifier is configured' : `the verifier could not answer${verdict.note ? ` (${verdict.note})` : ''}`
    return refusal(409, 'verifier_unavailable', { why })
  }
  if (!verdict.approve) {
    try { recordRefusal(db, who.userId, ask, verdict.note) } catch (err) {
      // Fails closed either way: the answer below is a refusal.
      console.error(`journal: verifier refusal not recorded (${err?.name})`)
    }
    return refusal(403, 'verifier', { why: WHY_VERIFIER_REFUSED })
  }
  return { ok: true, root, cause: { causeKind: 'routine', causeRef: root.ref, verifierNote: verdict.note ?? '' } }
}

// → a refusal, or null to go ahead. Synchronous by design (above).
export function confirmOwnAsk(ctx, { who, ask, verdict }) {
  const { db } = ctx
  const changed = changedWhileVerifying(ctx, who, ask)
  if (changed) return changed
  if (verdict.root.kind !== 'routine') return null
  // The routine as it is now, not as it was before the wait: the user may
  // have narrowed or cleared its envelope, or deleted it, meanwhile. By id,
  // so a routine deleted and made again under the same name is gone too.
  const routine = getRoutine(db, who.userId, verdict.root.routine.id)
  if (!routine) return refusal(403, 'envelope', { why: `the routine "${verdict.root.routine.name}" no longer exists` })
  const late = outsideEnvelope(db, who.userId, verdict.root, routine, ask)
  if (late) return refusal(403, 'envelope', { why: late })
  const cap = Number.isInteger(ctx.consentRoutineCap) && ctx.consentRoutineCap >= 0 ? ctx.consentRoutineCap : CONSENT_ROUTINE_CAP_DEFAULT
  if (cap > 0 && coordinatorRoutineApprovalsSince(db, who.userId, Date.now() - CONSENT_DAILY_WINDOW_MS) >= cap) {
    return refusal(409, 'routine_cap', { cap })
  }
  return null
}
