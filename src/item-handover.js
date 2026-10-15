// Item handover (mission: hand a tracker item from one session to another).
// Pure database transitions; the HTTP surface, markers and wakes live in
// src/item-handover-http.js.
//
// An item's origin_convo_id / origin_device_id is its OWNER: the user's
// replies and taps are markers on that conversation, which is what wakes its
// box and becomes its agent's 📌 turn, and what the apps show as the owner.
// A handover moves the owner, after an offer and an accept:
//
//   offer   — the owner's session (or the Coordinator, or the user) names a
//             target conversation. 'offered', or 'awaiting_user' when either
//             side is a user-only device (devices.consent_user_only), in
//             which case the user's tap on a question the journal writes in
//             the item's own thread lets it through.
//   accept  — the target session takes it: the owner moves, the thread says
//             so, and the conversation that first filed the item is kept in
//             filed_convo_id. Until then everything still goes to the owner.
//   decline / withdraw / refused (the user's "Keep it here") / expired —
//             nothing moves.
//
// Every thread line here is written by the journal (author 'agent', device
// 0), never as the user: src/said.js, and any agent checking what the user
// said, must not mistake one for the user's words.
import { newId, getItem, insertComment } from './items.js'
import { isPrivateDevice } from './db.js'

export const HANDOVER_TTL_MS = 24 * 60 * 60 * 1000
export const HANDOVER_NOTE_MAX = 2000
export const APPROVE_LABEL = 'Hand over'
export const KEEP_LABEL = 'Keep it here'
export const APPROVAL_ROLE = 'handover_approval'
const PENDING = ['awaiting_user', 'offered']
const JOURNAL_DEVICE = 0

// Tagged failures, mapped to HTTP by the route (ERRORS in
// src/item-handover-http.js). Anything else is a bug.
const fail = (code) => { throw new Error(code) }

export function pendingHandover(db, itemId) {
  return db.prepare("SELECT * FROM item_handovers WHERE item_id=? AND state IN ('awaiting_user','offered')").get(itemId) ?? null
}

export function getHandover(db, userId, id) {
  return db.prepare('SELECT * FROM item_handovers WHERE id=? AND user_id=?').get(id, userId) ?? null
}

// The target of an offer: one of the user's own conversations with an agent
// session in it. The journal's own conversations (people-convo.js) and a
// conversation no agent owns cannot take an item: nobody would hear the
// user's replies there.
export function targetConvo(db, userId, convoId) {
  const c = db.prepare('SELECT id, title, agent_device_id, system FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
  if (!c || c.system != null || c.agent_device_id == null) return null
  return c
}

function deviceRow(db, userId, deviceId) {
  if (!Number.isInteger(deviceId)) return null
  return db.prepare('SELECT id, name, private, consent_user_only FROM devices WHERE id=? AND user_id=?').get(deviceId, userId) ?? null
}

// "Release notes (box-2)": the conversation's title and its box, for the
// thread lines and the agents' turns. Peer-controlled text (a title the agent
// set) is cut and flattened; it is shown, never interpreted.
export function convoLabel(db, userId, convoId) {
  const c = db.prepare('SELECT title, agent_device_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
  const title = String(c?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
  const box = c ? deviceRow(db, userId, c.agent_device_id)?.name : null
  const head = title || `conversation ${String(convoId).slice(0, 8)}`
  return box ? `${head} (${box})` : head
}

// Either side a user-only device: the user's tap, never an agent's (the
// Coordinator's included), lets the offer through — the same rule as every
// other ask such a device takes part in (src/consent.js).
export function needsUserTap(db, userId, fromDeviceId, toDeviceId) {
  return [fromDeviceId, toDeviceId].some((d) => !!deviceRow(db, userId, d)?.consent_user_only)
}

// A private box's items are withheld from ordinary agents (src/privacy.js).
// Moving one across that line would either show a private item to every
// agent or hide an ordinary one from them, so both sides must agree.
export function privacyMatches(db, userId, fromDeviceId, toDeviceId) {
  // isPrivateDevice, not the live row: a revoked private box's items stay private.
  const p = (d) => Number.isInteger(d) && isPrivateDevice(db, d)
  return p(fromDeviceId) === p(toDeviceId)
}

// A parked offer (awaiting_user) handed the item to the user for the
// approval question; whichever way it settles, the item goes back to
// awaiting what it was before (an open item only — a close cleared it).
// Only while nothing else has moved it: a user's reply (other than the tap
// on the approval question) or an agent's new question with buttons after the
// approval question owns `awaiting` now, and is left alone. A plain agent
// note changes nothing (addComment), so it doesn't count.
function restoreAwaiting(db, h, now) {
  if (h.state !== 'awaiting_user' || !h.approval_comment_id) return
  const moved = db.prepare(`SELECT 1 FROM item_comments
    WHERE item_id=? AND kind='comment' AND rowid > (SELECT rowid FROM item_comments WHERE id=?)
      AND ((author='user' AND COALESCE(json_extract(meta, '$.reply_to'), '') != ?)
        OR (author='agent' AND actions != '[]')) LIMIT 1`).get(h.item_id, h.approval_comment_id, h.approval_comment_id)
  if (moved) return
  db.prepare("UPDATE items SET awaiting=?, updated_at=? WHERE id=? AND state='open' AND awaiting='user'").run(h.prior_awaiting ?? null, now, h.item_id)
}

// Expired but not yet swept (the sweep runs once a tick): as good as gone.
const live = (h, now) => h && h.expires_at > now

// The device that hosts a conversation. The privacy and user-only rules are
// about the BOX the conversation lives on (src/privacy.js privateOwnedConvo),
// never items.origin_device_id at filing time, which is whichever device
// filed the item — the user's app, or an agent joined to the conversation.
function convoDevice(db, userId, convoId) {
  return db.prepare('SELECT agent_device_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)?.agent_device_id ?? null
}

function line(db, { userId, itemId, body, meta, actions = [], now }) {
  return insertComment(db, {
    itemId, userId, author: 'agent', deviceId: JOURNAL_DEVICE, kind: actions.length ? 'comment' : 'status',
    body, attachments: [], meta, actions, idemKey: null, now,
  })
}

const noteText = (note) => (note ? `\n\n> ${note.replace(/\n/g, '\n> ')}` : '')

// Offer the item to `toConvoId`. A pending offer is replaced (withdrawn) by
// the new one. Returns { handover, replaced, comment }: `comment` is the
// thread line, or the approval question when the user's tap is needed.
export function offerHandover(db, { userId, itemId, toConvoId, note = '', offeredBy, offeredByDeviceId, offeredByConvoId = null, now = Date.now() }) {
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM items WHERE id=? AND user_id=?').get(itemId, userId)
    if (!row) fail('not_found')
    if (row.consent != null) fail('consent_item')
    if (row.state !== 'open') fail('item_closed')
    if (row.origin_convo_id === toConvoId) fail('same_owner')
    const target = targetConvo(db, userId, toConvoId)
    if (!target) fail('bad_target')
    const fromDevice = convoDevice(db, userId, row.origin_convo_id) ?? row.origin_device_id
    if (!privacyMatches(db, userId, fromDevice, target.agent_device_id)) fail('privacy_mismatch')
    const replaced = pendingHandover(db, itemId)
    if (replaced) {
      db.prepare("UPDATE item_handovers SET state='withdrawn', reason='replaced by a new offer', updated_at=? WHERE id=?").run(now, replaced.id)
      restoreAwaiting(db, replaced, now)
    }
    const priorAwaiting = db.prepare('SELECT awaiting FROM items WHERE id=?').get(itemId).awaiting
    const parked = offeredBy !== 'user' && needsUserTap(db, userId, fromDevice, target.agent_device_id)
    const id = newId('ho')
    const from = convoLabel(db, userId, row.origin_convo_id)
    const to = convoLabel(db, userId, toConvoId)
    db.prepare(`INSERT INTO item_handovers(id,item_id,user_id,from_convo_id,from_device_id,to_convo_id,to_device_id,offered_by,offered_by_device_id,offered_by_convo_id,note,state,prior_awaiting,created_at,updated_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, itemId, userId, row.origin_convo_id, fromDevice, toConvoId, target.agent_device_id, offeredBy, offeredByDeviceId, offeredByConvoId, note,
        parked ? 'awaiting_user' : 'offered', priorAwaiting, now, now, now + HANDOVER_TTL_MS)
    const meta = { handover: { id, stage: parked ? 'awaiting_user' : 'offered', from_convo_id: row.origin_convo_id, to_convo_id: toConvoId } }
    let comment
    if (parked) {
      comment = line(db, {
        userId, itemId, now,
        body: `**Handover:** ${from} offers this item to ${to}.${noteText(note)}\n\nA session only you approve for is involved, so it needs your OK. Tap **${APPROVE_LABEL}** to let ${to} take it, or **${KEEP_LABEL}**.`,
        meta: { ...meta, role: APPROVAL_ROLE },
        actions: [APPROVE_LABEL, KEEP_LABEL],
      })
      db.prepare('UPDATE item_handovers SET approval_comment_id=? WHERE id=?').run(comment.id, id)
      db.prepare("UPDATE items SET awaiting='user', updated_at=? WHERE id=?").run(now, itemId)
    } else {
      comment = line(db, {
        userId, itemId, now, meta,
        body: `**Handover:** offered to ${to}.${noteText(note)}\n\nUntil ${to} accepts, replies still go to ${from}.`,
      })
      db.prepare('UPDATE items SET updated_at=? WHERE id=?').run(now, itemId)
    }
    return { handover: getHandover(db, userId, id), replaced, comment }
  })()
}

// The user's tap on the approval question. Returns the handover as it now
// stands: 'offered' (on its way to the target) or 'refused'.
export function answerApproval(db, { userId, handoverId, approve, now = Date.now() }) {
  return db.transaction(() => {
    const h = getHandover(db, userId, handoverId)
    if (!h || h.state !== 'awaiting_user' || !live(h, now)) fail('handover_settled')
    if (approve && db.prepare('SELECT state FROM items WHERE id=?').get(h.item_id)?.state !== 'open') fail('item_closed')
    db.prepare('UPDATE item_handovers SET state=?, reason=?, updated_at=? WHERE id=?')
      .run(approve ? 'offered' : 'refused', approve ? '' : 'kept here by the user', now, h.id)
    restoreAwaiting(db, h, now)
    return getHandover(db, userId, h.id)
  })()
}

// The target session takes the item. The owner moves to the target
// conversation and its agent box; filed_convo_id keeps the conversation that
// first filed it (the first handover only).
export function acceptHandover(db, { userId, itemId, now = Date.now() }) {
  return db.transaction(() => {
    const h = pendingHandover(db, itemId)
    if (!h || h.state !== 'offered' || !live(h, now)) fail('no_offer')
    const target = targetConvo(db, userId, h.to_convo_id)
    if (!target) fail('bad_target')
    const row = db.prepare('SELECT origin_convo_id, state FROM items WHERE id=?').get(itemId)
    if (row.state !== 'open') fail('item_closed')
    // The owner moved some other way while the offer waited: the offer was
    // made on behalf of a conversation that no longer holds the item.
    if (row.origin_convo_id !== h.from_convo_id) fail('no_offer')
    // turn_requested_at goes with the old owner: an ask made of that session
    // says nothing about when the new one will start a turn (items.js
    // itemWorking would read it against the new conversation's stamps).
    db.prepare(`UPDATE items SET origin_convo_id=?, origin_device_id=?, filed_convo_id=COALESCE(filed_convo_id, origin_convo_id), turn_requested_at=NULL, updated_at=? WHERE id=?`)
      .run(h.to_convo_id, target.agent_device_id, now, itemId)
    db.prepare("UPDATE item_handovers SET state='accepted', to_device_id=?, updated_at=? WHERE id=?").run(target.agent_device_id, now, h.id)
    const from = convoLabel(db, userId, h.from_convo_id)
    const to = convoLabel(db, userId, h.to_convo_id)
    const comment = line(db, {
      userId, itemId, now,
      meta: { handover: { id: h.id, stage: 'accepted', from_convo_id: h.from_convo_id, to_convo_id: h.to_convo_id } },
      body: `**Handed over** from ${from} to ${to}. Replies now go to ${to}.`,
    })
    return { item: getItem(db, userId, itemId), handover: getHandover(db, userId, h.id), comment }
  })()
}

// Decline (the target), withdraw (the offering side) — and the sweep's
// expiry. Nothing moves; the thread says why.
export function settleHandover(db, { userId, itemId, outcome, reason = '', now = Date.now() }) {
  return db.transaction(() => {
    const h = pendingHandover(db, itemId)
    if (!h || !live(h, now)) fail('no_offer')
    if (outcome === 'declined' && h.state !== 'offered') fail('no_offer')
    db.prepare('UPDATE item_handovers SET state=?, reason=?, updated_at=? WHERE id=?').run(outcome, reason, now, h.id)
    restoreAwaiting(db, h, now)
    return { handover: getHandover(db, userId, h.id), before: h, comment: settledLine(db, { userId, itemId, h, outcome, reason, now }) }
  })()
}

function settledLine(db, { userId, itemId, h, outcome, reason, now }) {
  const from = convoLabel(db, userId, h.from_convo_id)
  const to = convoLabel(db, userId, h.to_convo_id)
  const why = reason ? `: ${reason.replace(/\s+/g, ' ').trim()}` : '.'
  const body = {
    declined: `**Handover declined** by ${to}${why} ${from} keeps this item.`,
    withdrawn: `**Handover withdrawn**: the offer to ${to} is off${why} ${from} keeps this item.`,
    expired: `**Handover expired**: nobody ${h.state === 'awaiting_user' ? 'approved' : 'accepted'} the offer to ${to} within 24 hours. ${from} keeps this item.`,
    refused: `**Kept here**: ${from} keeps this item.`,
  }[outcome]
  return line(db, { userId, itemId, now, body, meta: { handover: { id: h.id, stage: outcome, from_convo_id: h.from_convo_id, to_convo_id: h.to_convo_id } } })
}

// The user's "Keep it here" tap, once answerApproval has recorded it.
export function refusedLine(db, { userId, handover, now = Date.now() }) {
  return settledLine(db, { userId, itemId: handover.item_id, h: handover, outcome: 'refused', reason: '', now })
}

// The sweep: offers nobody acted on in 24 h. Returns [{ handover (as it was),
// comment }] for the caller's markers.
export function expireHandovers(db, now = Date.now()) {
  const rows = db.prepare(`SELECT * FROM item_handovers WHERE state IN (${PENDING.map(() => '?').join(',')}) AND expires_at <= ?`).all(...PENDING, now)
  const out = []
  for (const h of rows) {
    const r = db.transaction(() => {
      const changed = db.prepare("UPDATE item_handovers SET state='expired', updated_at=? WHERE id=? AND state IN ('awaiting_user','offered')").run(now, h.id)
      if (!changed.changes) return null
      restoreAwaiting(db, h, now)
      return { handover: h, comment: settledLine(db, { userId: h.user_id, itemId: h.item_id, h, outcome: 'expired', reason: '', now }) }
    })()
    if (r) out.push(r)
  }
  return out
}
