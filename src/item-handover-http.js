// HTTP surface of item handover (src/item-handover.js), mounted under
// /items/:id/handover by src/items-http.js:
//
//   POST /items/:id/handover           {to_convo_id, note?}   offer
//   POST /items/:id/handover/accept                           target session
//   POST /items/:id/handover/decline   {reason?}              target session
//   POST /items/:id/handover/withdraw  {reason?}              offering side
//
// plus the user's tap on the approval question, which src/items-http.js hands
// to handleApprovalTap before its ordinary comment path.
//
// Who may do what:
//   offer, withdraw — the owner's session, the user's Coordinator, or the
//     user from an app.
//   accept, decline — the target conversation's session.
// An agent names its own session in `as_convo_id` (the bridge fills it in
// from the calling session), and must be able to write that conversation.
// A box hosts many sessions under one device token, so the device alone
// cannot tell the target's session from an unrelated one on the same box.
//
// Every outcome is told to the sessions concerned by a quiet `updated` item
// marker, sender `journal`, carrying `handover: {id, stage, ...}`: a bridge
// turns it into a 📌 turn (an agent can never publish an item marker, so the
// sender cannot be forged), an app refreshes the item from it. The target's
// box is woken for an offer.
import { appendAndBroadcast, toEventShape } from './journal.js'
import { authorizeAgentWrite } from './auth.js'
import { wakeConvoAgent } from './wake.js'
import { json, readBody } from './http-body.js'
import { badRequest } from './http-who.js'
import { getItem, addComment } from './items.js'
import { itemMarkerPayload, ITEM_EVENT_TYPE } from './items-marker.js'
import { getCoordinatorConvoId } from './coordinator.js'
import { ApprovalRefused } from './approval-keys.js'
import {
  HANDOVER_NOTE_MAX, APPROVE_LABEL, KEEP_LABEL, APPROVAL_ROLE,
  offerHandover, answerApproval, acceptHandover, settleHandover, refusedLine, expireHandovers, pendingHandover, getHandover, convoLabel,
} from './item-handover.js'

const JOURNAL = 'journal'
const ID_MAX = 128
const ERRORS = {
  not_found: 404,
  bad_target: 404,
  consent_item: 409,
  item_closed: 409,
  same_owner: 409,
  privacy_mismatch: 409,
  no_offer: 409,
  handover_settled: 409,
}

function answerError(res, err) {
  const status = ERRORS[err && err.message]
  if (!status) return false
  json(res, status, { error: err.message })
  return true
}

// What the bridge and the apps need to word and render one stage, without a
// fetch: both conversations, their labels, the note or reason.
function handoverExtra(db, userId, h, stage, by = null) {
  return {
    handover: {
      id: h.id, stage, ...(by ? { by } : {}),
      from_convo_id: h.from_convo_id, from_label: convoLabel(db, userId, h.from_convo_id),
      to_convo_id: h.to_convo_id, to_label: convoLabel(db, userId, h.to_convo_id),
      offered_by: h.offered_by, offered_by_convo_id: h.offered_by_convo_id ?? null, note: h.note || '', reason: h.reason || '',
      expires_at: h.expires_at,
    },
  }
}

function marker({ db, hub, waker }, { userId, convoId, item, comment, h, stage, by = null, wake = false }) {
  try {
    appendAndBroadcast(db, hub, {
      userId, convoId, sender: JOURNAL, type: ITEM_EVENT_TYPE,
      payload: itemMarkerPayload({ item, action: 'updated', by: 'agent', comment, extra: handoverExtra(db, userId, h, stage, by) }),
    })
  } catch (err) {
    // The table write already committed (same stance as emitMarker).
    console.error('handover: marker append failed', err)
    return
  }
  if (wake) {
    try { wakeConvoAgent({ db, hub, waker }, userId, convoId) } catch (err) { console.error('handover: wake failed', err) }
  }
}

// Somebody other than the owner made the offer (the Coordinator): it hears
// how it ended too, on its own conversation — unless that IS one of the two
// sides, which already heard.
function toOfferer(ctx, { userId, item, comment, h, stage, by = null }) {
  const c = h.offered_by_convo_id
  if (!c || c === h.from_convo_id || c === h.to_convo_id) return
  marker(ctx, { userId, convoId: c, item, comment, h, stage, by })
}

// The offer is with the target now: tell it (and wake its box), and tell the
// owner's session when somebody else made the offer for it.
function announceOffered(ctx, { userId, item, comment, h }) {
  marker(ctx, { userId, convoId: h.to_convo_id, item, comment, h, stage: 'offered', wake: true })
  if (h.offered_by !== 'owner') marker(ctx, { userId, convoId: h.from_convo_id, item, comment, h, stage: 'offered' })
}

// A withdrawn offer: the target hears it if the offer had reached it, and
// the owner hears it with who took it back (`by`: owner | coordinator | user
// | closed) — its bridge stays quiet when the owner did it itself.
function announceWithdrawn(ctx, { userId, item, comment, h, before, by }) {
  marker(ctx, { userId, convoId: before.from_convo_id, item, comment, h, stage: 'withdrawn', by })
  if (before.state === 'offered') marker(ctx, { userId, convoId: before.to_convo_id, item, comment, h, stage: 'withdrawn', by })
  toOfferer(ctx, { userId, item, comment, h, stage: 'withdrawn', by })
}

// The item was closed with an offer still pending: the offer goes with it
// (nothing can take on a closed item). Called by the close routes after
// their own write. Returns the item as it now reads when an offer was
// withdrawn, else null; never throws.
export function withdrawOnClose(ctx, userId, itemId) {
  try {
    if (!pendingHandover(ctx.db, itemId)) return null
    const out = settleHandover(ctx.db, { userId, itemId, outcome: 'withdrawn', reason: 'the item was closed' })
    const item = getItem(ctx.db, userId, itemId)
    announceWithdrawn(ctx, { userId, item, comment: out.comment, h: out.handover, before: out.before, by: 'closed' })
    return item
  } catch (err) {
    if (err?.message !== 'no_offer') console.error('handover: withdraw on close failed', err)
    return null
  }
}

// The approval question is an ordinary "needs you" comment as far as the apps
// and push are concerned: a `commented` marker, by 'agent', awaiting the user.
function announceApprovalQuestion({ db, hub, pushPipeline }, { userId, item, comment, h }) {
  const payload = itemMarkerPayload({ item, action: 'commented', by: 'agent', comment, extra: handoverExtra(db, userId, h, 'awaiting_user') })
  try {
    const r = appendAndBroadcast(db, hub, { userId, convoId: h.from_convo_id, sender: JOURNAL, type: ITEM_EVENT_TYPE, payload })
    try {
      pushPipeline?.onAppend(userId, toEventShape({ seq: r.seq, convo_id: h.from_convo_id, ts: r.ts, sender: JOURNAL, type: ITEM_EVENT_TYPE, payload }), null)
    } catch (err) {
      console.error('handover: push onAppend failed', err)
    }
  } catch (err) {
    console.error('handover: approval marker append failed', err)
  }
}

// Who is asking, as an offering side: 'owner', 'coordinator', 'user', or null.
function offeringSide(db, who, item, asConvo) {
  if (who.kind !== 'agent') return 'user'
  if (!authorizeAgentWrite(db, who.userId, who.deviceId, asConvo)) return null
  if (asConvo === item.origin_convo_id) return 'owner'
  if (asConvo === getCoordinatorConvoId(db, who.userId)) return 'coordinator'
  return null
}

// The calling agent's own conversation: required of an agent, ignored for
// the user. undefined = malformed.
function asConvoOf(who, body) {
  if (who.kind !== 'agent') return null
  const v = body.as_convo_id
  return typeof v === 'string' && v && v.length <= ID_MAX ? v : undefined
}

const forbidden = (res, error = 'forbidden') => { json(res, 403, { error }); return true }
const okText = (v, max) => v === undefined || v === null || (typeof v === 'string' && v.length <= max)

export async function handleHandoverRoute(ctx, req, res, who, item, subId) {
  const { db } = ctx
  if (req.method !== 'POST') return false
  const body = await readBody(req)
  const userId = who.userId
  // Re-read after the await: the owner may have moved while the body
  // arrived, and who counts as the owner is decided from the live row.
  // Nothing below awaits before the write, so this read is the write's.
  item = getItem(db, userId, item.id)
  if (!item) return false
  const asConvo = asConvoOf(who, body)
  if (asConvo === undefined) return badRequest(res)

  if (subId == null) {
    if (typeof body.to_convo_id !== 'string' || !body.to_convo_id || body.to_convo_id.length > ID_MAX) return badRequest(res)
    if (!okText(body.note, HANDOVER_NOTE_MAX)) return badRequest(res)
    const side = offeringSide(db, who, item, asConvo)
    if (!side) return forbidden(res, 'not_owner')
    let out
    try {
      out = offerHandover(db, { userId, itemId: item.id, toConvoId: body.to_convo_id, note: (body.note ?? '').trim(), offeredBy: side, offeredByDeviceId: who.deviceId, offeredByConvoId: asConvo })
    } catch (err) {
      if (answerError(res, err)) return true
      throw err
    }
    const fresh = getItem(db, userId, item.id)
    if (out.replaced) {
      // The offer this one replaces: its target (if it had reached it) and
      // whoever else made it are told it is off. The caller knows already.
      const old = { ...out.replaced, reason: 'replaced by a new offer' }
      if (old.state === 'offered') marker(ctx, { userId, convoId: old.to_convo_id, item: fresh, comment: null, h: old, stage: 'withdrawn', by: side })
      if (old.offered_by_convo_id !== asConvo) toOfferer(ctx, { userId, item: fresh, comment: null, h: old, stage: 'withdrawn', by: side })
    }
    if (out.handover.state === 'awaiting_user') announceApprovalQuestion(ctx, { userId, item: fresh, comment: out.comment, h: out.handover })
    else announceOffered(ctx, { userId, item: fresh, comment: out.comment, h: out.handover })
    json(res, 201, { item: fresh, handover: out.handover })
    return true
  }

  if (subId === 'accept' || subId === 'decline') {
    if (who.kind !== 'agent') return forbidden(res)
    if (subId === 'decline' && !okText(body.reason, HANDOVER_NOTE_MAX)) return badRequest(res)
    const h = pendingHandover(db, item.id)
    if (!h || h.state !== 'offered') { json(res, 409, { error: 'no_offer' }); return true }
    if (asConvo !== h.to_convo_id || !authorizeAgentWrite(db, userId, who.deviceId, h.to_convo_id)) return forbidden(res, 'not_target')
    let out
    try {
      out = subId === 'accept'
        ? acceptHandover(db, { userId, itemId: item.id })
        : settleHandover(db, { userId, itemId: item.id, outcome: 'declined', reason: (body.reason ?? '').trim() })
    } catch (err) {
      if (answerError(res, err)) return true
      throw err
    }
    const fresh = out.item ?? getItem(db, userId, item.id)
    const stage = subId === 'accept' ? 'accepted' : 'declined'
    // Both sides hear it: the old owner that it is no longer its (or is
    // still its), the new owner that the move landed.
    marker(ctx, { userId, convoId: h.from_convo_id, item: fresh, comment: out.comment, h: out.handover, stage })
    marker(ctx, { userId, convoId: h.to_convo_id, item: fresh, comment: out.comment, h: out.handover, stage })
    toOfferer(ctx, { userId, item: fresh, comment: out.comment, h: out.handover, stage })
    json(res, 200, { item: fresh, handover: out.handover })
    return true
  }

  if (subId === 'withdraw') {
    if (!okText(body.reason, HANDOVER_NOTE_MAX)) return badRequest(res)
    const side = offeringSide(db, who, item, asConvo)
    if (!side) return forbidden(res, 'not_owner')
    let out
    try {
      out = settleHandover(db, { userId, itemId: item.id, outcome: 'withdrawn', reason: (body.reason ?? '').trim() })
    } catch (err) {
      if (answerError(res, err)) return true
      throw err
    }
    const fresh = getItem(db, userId, item.id)
    announceWithdrawn(ctx, { userId, item: fresh, comment: out.comment, h: out.handover, before: out.before, by: side })
    json(res, 200, { item: fresh, handover: out.handover })
    return true
  }

  return false
}

// Is `replyTo` the journal's approval question on this item? Only the
// journal writes that meta (agents' comments carry none), so an agent cannot
// plant a look-alike whose tap the journal would act on.
export function approvalQuestionOf(db, itemId, replyTo) {
  if (typeof replyTo !== 'string' || !replyTo) return null
  const c = db.prepare("SELECT meta FROM item_comments WHERE id=? AND item_id=? AND kind='comment' AND device_id=0 AND author='agent'").get(replyTo, itemId)
  if (!c?.meta) return null
  try {
    const m = JSON.parse(c.meta)
    return m?.role === APPROVAL_ROLE && typeof m.handover?.id === 'string' ? m.handover.id : null
  } catch {
    return null
  }
}

// The user tapped Hand over / Keep it here. The tap is recorded in the thread
// like any other (and marks the button chosen), but it is the journal's to act
// on, not a turn for the owner's agent: a quiet `updated` marker carries it,
// then the offer goes on to the target or is settled as kept.
// `approve` is the items route's approval-key check (items-http.js
// tapApprover): on a step-up item the tap needs a signature like any other,
// checked in the same write, and a refusal settles nothing.
export function handleApprovalTap(ctx, res, who, item, { handoverId, action, replyTo, idemKey, approve = null }) {
  const { db } = ctx
  const userId = who.userId
  if (action !== APPROVE_LABEL && action !== KEEP_LABEL) { json(res, 400, { error: 'unknown_action' }); return true }
  const h = getHandover(db, userId, handoverId)
  if (!h || h.item_id !== item.id || h.state !== 'awaiting_user') { json(res, 409, { error: 'handover_settled' }); return true }
  // The tap and what it settles are ONE write: a tap stored against an offer
  // that settled under it (expired, withdrawn, the item closed) would read
  // as an answer nobody acted on.
  let tap, settled, comment
  try {
    db.transaction(() => {
      tap = addComment(db, { userId, itemId: item.id, author: 'user', deviceId: who.deviceId, body: action, action, replyTo, idemKey, keepStatus: true, approve })
      if (!tap || tap.duplicate) return
      settled = answerApproval(db, { userId, handoverId, approve: action === APPROVE_LABEL })
      comment = settled.state === 'refused' ? refusedLine(db, { userId, handover: settled }) : tap.comment
    })()
  } catch (err) {
    if (err instanceof ApprovalRefused) { json(res, err.refusal.status, err.refusal.body); return true }
    if (err?.message === 'unknown_action') { json(res, 400, { error: 'unknown_action' }); return true }
    if (err?.message === 'idem_key_conflict') { json(res, 409, { error: 'conflict' }); return true }
    if (answerError(res, err)) return true
    throw err
  }
  if (!tap) { json(res, 404, { error: 'not_found' }); return true }
  if (tap.duplicate) { json(res, 200, { item: tap.item, comment: tap.comment }); return true }
  const fresh = getItem(db, userId, item.id)
  if (settled.state === 'offered') {
    announceOffered(ctx, { userId, item: fresh, comment: tap.comment, h: settled })
    // The owner's session hears that the user approved, whoever offered.
    if (settled.offered_by === 'owner') marker(ctx, { userId, convoId: settled.from_convo_id, item: fresh, comment: tap.comment, h: settled, stage: 'approved' })
    toOfferer(ctx, { userId, item: fresh, comment: tap.comment, h: settled, stage: 'approved' })
  } else {
    marker(ctx, { userId, convoId: settled.from_convo_id, item: fresh, comment, h: settled, stage: 'refused' })
    toOfferer(ctx, { userId, item: fresh, comment, h: settled, stage: 'refused' })
  }
  json(res, 201, { item: fresh, comment: tap.comment })
  return true
}

// The sweep's half (src/ws.js): offers nobody acted on in 24 h.
export function sweepExpiredHandovers(ctx, now = Date.now()) {
  for (const { handover: h, comment } of expireHandovers(ctx.db, now)) {
    const item = getItem(ctx.db, h.user_id, h.item_id)
    if (!item) continue
    const settled = { ...h, state: 'expired' }
    marker(ctx, { userId: h.user_id, convoId: h.from_convo_id, item, comment, h: settled, stage: 'expired' })
    if (h.state === 'offered') marker(ctx, { userId: h.user_id, convoId: h.to_convo_id, item, comment, h: settled, stage: 'expired' })
    toOfferer(ctx, { userId: h.user_id, item, comment, h: settled, stage: 'expired' })
  }
}
