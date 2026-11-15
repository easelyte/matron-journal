// Memory proposals: the side of a memory write that waits for the user
// (docs/protocol.md "Memory proposals"). src/memory-proposals.js holds the
// rows; this file decides which agent writes need the user's answer, files
// the question, acts on the user's tap, and tells the proposing session how
// it ended.
//
// Which writes wait (needsUserAnswer):
//  - an agent on a user-only or protected device (src/consent.js
//    userOnlyDevice): always;
//  - any other agent: unless the turn that made the write was started by the
//    user in that agent's own conversation — words they typed or spoke
//    there, or their comment or tap on an item it owns — and recently. The
//    bridge sends the turn's causes with the write and they are resolved by
//    the journal's own record (src/ask-cause.js), never taken on trust;
//  - the user's own apps: never.
//
// The question is a consent mirror (items.js isConsentMirror, consent
// 'memory'): an ordinary `question` item awaiting the user, with two buttons,
// that no agent — the proposing one and the Coordinator included — can read,
// edit, close or tap. Its body is rendered from the stored proposal and an
// approval applies that same row, so what the user reads is what is saved.
// The proposed text is the agent's: it is shown inside fenced blocks, never
// as part of the sentences around it.
//
// Every outcome is told to the proposing conversation by a `memory_proposal`
// event, sender `journal` (a sender no device can publish under): its bridge
// turns that into a turn for the agent.
import { appendAndBroadcast, toEventShape } from './journal.js'
import { json } from './http-body.js'
import { senderOf, conflict } from './http-who.js'
import { createItem, closeItem, getItem, TITLE_MAX } from './items.js'
import { itemMarkerPayload, ITEM_EVENT_TYPE } from './items-marker.js'
import { CONSENT_LABEL, fenced } from './consent-items.js'
import { userOnlyDevice } from './consent.js'
import { getCoordinatorConvoId } from './coordinator.js'
import { ensurePeopleConvo, PEOPLE_TITLE, PEOPLE_SYSTEM } from './people-convo.js'
import { sanitizePeerText, plainText as plain, PEER_NAME_CAP } from './peer-text.js'
import { resolveAskCause } from './ask-cause.js'
import { getMemory, upsertMemory, deleteMemory } from './memories.js'
import { emitMemoryMarker } from './memories-http.js'
import {
  recordProposal, setProposalItem, settleProposal, expireProposals, pruneProposals, proposalOfItem, labelsFor, isStale, markTold, owedFollowUps,
} from './memory-proposals.js'

export const MEMORY_CONSENT = 'memory'
export const MEMORY_PROPOSAL_EVENT_TYPE = 'memory_proposal'
// How old the user's words (or their comment or tap) may be for an agent's
// write to apply directly: a save follows what the user said closely.
export const MEMORY_DIRECT_WINDOW_MS = 30 * 60 * 1000
const JOURNAL = 'journal'
const TITLE_CAP = 120

const safely = (what, fn) => { try { return fn() } catch (err) { console.error(`memory proposal: ${what} failed (the proposal stands)`, err); return null } }
const t = (s, n = TITLE_CAP) => plain(sanitizePeerText(s ?? '', n))

// → null when the write may apply now, else why it waits for the user.
// `causes` is the normalised list from the request (null = none sent),
// `convoId` the conversation the write names (null = none).
export function needsUserAnswer(db, who, { convoId, causes, now = Date.now() }) {
  if (who.kind !== 'agent') return null
  if (userOnlyDevice(db, who.userId, who.deviceId)) return 'this box takes changes only on the user\'s own say'
  if (!convoId) return 'the write names no conversation'
  // A spawn outcome stands for the turn that asked for the spawn, which may
  // be long over: it does not carry the user's words to a memory.
  if (Array.isArray(causes) && causes.some((c) => c.kind === 'spawn_outcome')) return 'started by spawn_outcome'
  const r = resolveAskCause(db, { who, userId: who.userId, causes, createdAt: now, fromConvoId: convoId })
  if (!r.ok) return r.why
  if (r.root.kind !== 'user' && r.root.kind !== 'item') return `started by a ${r.root.kind}`
  if (r.root.at < now - MEMORY_DIRECT_WINDOW_MS) return 'the user\'s input is older than 30 minutes'
  return null
}

// --- The item ----------------------------------------------------------------

// A memory's text is many lines, and consent-items.js `fenced` holds only
// a single line safely (a fence closes on a line of its own). So before the
// text goes in the fence: line separators other than \n become \n, other
// control characters are dropped, and a line that itself starts with a fence
// gets a zero-width space in front. The fence is still longer than any run
// in the text; the last step covers a renderer that closes on any fence.
export function fencedBlock(text) {
  return fenced(String(text ?? '')
    .replace(/\r\n?|[\u2028\u2029\u0085\u000b\u000c]/g, '\n')
    .replace(/[\u0000-\u0009\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/^(\s*)(`{3,}|~{3,})/gm, '$1\u200b$2'))
}

const boxName = (db, userId, deviceId) => db.prepare('SELECT name FROM devices WHERE id=? AND user_id=?').get(deviceId, userId)?.name ?? 'an agent'
const convoTitle = (db, userId, convoId) => (convoId ? db.prepare('SELECT title FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)?.title ?? '' : '')

// Title, body and buttons of the question, from the proposal row and the
// memory it was made against, read in the write that recorded it. The scope
// and type shown are the row's own: the ones an approval applies.
export function proposalItemFields(db, p) {
  const box = t(boxName(db, p.user_id, p.from_device_id), PEER_NAME_CAP)
  const title = t(convoTitle(db, p.user_id, p.from_convo_id))
  const where = p.from_convo_id ? `, from the conversation "${title || 'untitled'}"` : ''
  const current = getMemory(db, p.user_id, p.memory_id ?? p.name)
  const [yes, no] = labelsFor(p.action)
  const lines = []
  if (p.action === 'delete') {
    lines.push(`**${box}** proposes to delete a memory${where}.`, '')
    lines.push(`- **Name:** \`${p.name}\``)
    if (current) {
      lines.push(`- **Scope:** ${current.scope}`, `- **Type:** ${current.type}`, '', '**The memory as it stands — description:**', '', fencedBlock(current.description), '', '**Body:**', '', fencedBlock(current.body || '(empty)'))
    } else {
      lines.push('', 'That memory no longer exists.')
    }
    lines.push('', `**To answer:** tap **${yes}** to delete it, or **${no}**. Nothing is deleted unless you approve. Unanswered, the proposal lapses after 7 days.`)
  } else {
    lines.push(`**${box}** proposes to ${current ? 'change' : 'save'} a memory${where}.`, '')
    lines.push(`- **Name:** \`${p.name}\``)
    lines.push(`- **Scope:** ${p.scope}${current && p.scope !== current.scope ? ` (now ${current.scope})` : ''}`)
    lines.push(`- **Type:** ${p.type}${current && p.type !== current.type ? ` (now ${current.type})` : ''}`)
    lines.push('', '**Proposed description:**', '', fencedBlock(p.description))
    if (current) lines.push('', '**Current description:**', '', fencedBlock(current.description))
    lines.push('', '**Proposed body:**', '', fencedBlock(p.body || '(empty)'))
    lines.push('', `**To answer:** tap **${yes}** to ${current ? 'replace the memory with this' : 'save it as shown'}, or **${no}**. Nothing is saved unless you approve. Unanswered, the proposal lapses after 7 days.`)
  }
  const head = p.action === 'delete' ? `Delete the memory "${p.name}"?` : `${current ? 'Change' : 'Save'} the memory "${p.name}"?`
  return { title: `${head} — proposed by ${box}`.slice(0, TITLE_MAX), body: lines.join('\n'), actions: [yes, no] }
}

// Where the question lives: the proposing conversation, else the user's
// Coordinator conversation, else their People conversation.
function homeConvo({ db, hub }, userId, convoId) {
  if (convoId) return convoId
  const coord = getCoordinatorConvoId(db, userId)
  if (coord) return coord
  const { id, created } = ensurePeopleConvo(db, userId)
  if (created) {
    safely('people convo announce', () => appendAndBroadcast(db, hub, {
      userId, convoId: id, sender: JOURNAL, type: 'convo_meta', payload: { title: PEOPLE_TITLE, parent_convo_id: null, system: PEOPLE_SYSTEM },
    }))
  }
  return id
}

// An item marker for the mirror: client-only (it carries `consent`). A new
// or changed question also pushes, as an item an agent files for the user
// does — there is no card beside it to do that.
function itemMarker({ db, hub, pushPipeline }, { userId, sender, item, action, by, comment = null, push = false }) {
  safely('item marker', () => {
    const payload = itemMarkerPayload({ item, action, by, comment, extra: { consent: MEMORY_CONSENT } })
    const r = appendAndBroadcast(db, hub, { userId, convoId: item.origin_convo_id, sender, type: ITEM_EVENT_TYPE, payload })
    if (push && pushPipeline && !r.duplicate) {
      safely('push', () => pushPipeline.onAppend(userId, toEventShape({ seq: r.seq, convo_id: item.origin_convo_id, ts: r.ts, sender, type: ITEM_EVENT_TYPE, payload }), null))
    }
  })
}

// What the proposing conversation hears. `outcome` is the state the proposal
// settled in: approved | declined | replaced | expired | stale. Nothing of
// the memory's text travels: the name only. The row is marked told once the
// event is written (at once when there is no conversation to tell); one that
// could not be written is tried again by the sweep.
function tellProposer({ db, hub }, p, item) {
  const told = !p.from_convo_id || safely('outcome event', () => appendAndBroadcast(db, hub, {
    userId: p.user_id, convoId: p.from_convo_id, sender: JOURNAL, type: MEMORY_PROPOSAL_EVENT_TYPE,
    payload: { proposal_id: p.id, name: p.name, action: p.action, outcome: p.state, item: item ? { id: item.id, num: item.num } : null },
  }))
  if (told) safely('told mark', () => markTold(db, p.id))
}

// The thread line an item closes with, by how its proposal ended. A close is
// a database write only (closeItem), so it goes in the same transaction as
// the settlement; the marker follows the commit (closedMarker).
const STALE_LINE = 'Not applied: the memory changed after this was asked, so what is shown here is no longer what would happen. Nothing was changed; the agent can propose it again.'
const EXPIRED_LINE = 'Lapsed: no answer within 7 days. Nothing was changed.'
function closedMarker(ctx, p, out, { by = 'agent', sender = JOURNAL } = {}) {
  if (out) itemMarker(ctx, { userId: p.user_id, sender, item: out.item, action: 'closed', by, comment: out.comment })
}
const closeAs = (db, p, { resolution, author = 'agent', deviceId = 0, comment }) =>
  (p.item_id ? closeItem(db, { userId: p.user_id, itemId: p.item_id, resolution, author, deviceId, comment }) : null)

const view = (p) => ({ id: p.id, name: p.name, action: p.action, state: p.state, expires_at: p.expires_at })

// Record an agent's write as a proposal and put the question in front of the
// user. The proposal and its item are one write; the markers follow it. A
// pending proposal for the same name is set aside, never rewritten: its item
// closes in that same write and the new proposal gets a new one, so a tap
// already on its way to the older item finds it closed.
// → { proposal, item }. Throws Error('too_many_asks') at a cap.
export function fileProposal(ctx, who, { name, action, fields, memoryId = null, convoId = null }) {
  const { db } = ctx
  const userId = who.userId
  const sender = senderOf(db, who)
  const out = db.transaction(() => {
    const r = recordProposal(db, { userId, name, action, fields, memoryId, fromDeviceId: who.deviceId, fromConvoId: convoId })
    const f = proposalItemFields(db, r.proposal)
    const { item } = createItem(db, {
      userId, kind: 'question', title: f.title, body: f.body, labels: [CONSENT_LABEL], actions: f.actions,
      awaiting: 'user', position: 'top', originConvoId: homeConvo(ctx, userId, convoId), originDeviceId: who.deviceId, createdBy: 'agent', consent: MEMORY_CONSENT,
    })
    setProposalItem(db, r.proposal.id, item.id)
    const closed = r.replaced?.item_id
      ? closeItem(db, { userId, itemId: r.replaced.item_id, resolution: 'cancelled', author: 'agent', deviceId: 0, comment: `Set aside: a newer proposal for this memory took its place (#${item.num}). Nothing was changed.` })
      : null
    return { ...r, proposal: { ...r.proposal, item_id: item.id }, item, closed }
  })()
  if (out.replaced) {
    if (out.closed) itemMarker(ctx, { userId, sender: JOURNAL, item: out.closed.item, action: 'closed', by: 'agent', comment: out.closed.comment })
    tellProposer(ctx, out.replaced, out.closed?.item ?? null)
  }
  itemMarker(ctx, { userId, sender, item: out.item, action: 'created', by: 'agent', push: true })
  return { proposal: out.proposal, item: out.item }
}

// The 202 an agent's parked write is answered with.
export function answerPending(res, { proposal, item }) {
  json(res, 202, { pending: 'owner', proposal: view(proposal), item: { id: item.id, num: item.num } })
  return true
}

// --- The user's answer -------------------------------------------------------

// Apply an approved proposal as a direct write would have, with exactly the
// row's fields: the memory records the proposing conversation and device as
// its origin and the agent as its author; the marker says the user decided.
// → { line, marker }: the thread line, and the marker to emit once the
// write has committed.
function applyProposal(db, p) {
  const extra = { proposal: { id: p.id, proposed_by: 'agent' } }
  if (p.action === 'delete') {
    const gone = deleteMemory(db, p.user_id, p.memory_id)
    return { line: 'Deleted.', marker: { memory: gone, action: 'deleted', created: false, writerConvoId: p.from_convo_id, extra } }
  }
  const out = upsertMemory(db, {
    userId: p.user_id, name: p.name, description: p.description, body: p.body, type: p.type, scope: p.scope,
    originConvoId: p.from_convo_id, originDeviceId: p.from_device_id, by: 'agent',
  })
  return {
    line: out.created ? 'Saved.' : 'Saved: the memory now reads as proposed.',
    marker: { memory: out.memory, action: 'saved', created: out.created, writerConvoId: p.from_convo_id, extra },
  }
}

// A tap on a memory proposal's item (POST /items/:id/comments {action}) IS
// the answer. Client only: items-http refuses an agent's `action` before it
// gets here, and no agent can see the item at all.
//
// One write does all of it: the proposal settles, the memory changes, the
// item closes. An approval of a proposal whose memory is no longer as it was
// when the question was filed (isStale) applies nothing: the proposal
// settles as `stale`, the item closes saying so, and the answer is 409.
export function handleMemoryProposalTap(ctx, res, who, item, action, replyTo = null) {
  const { db } = ctx
  if (who.kind === 'agent') { json(res, 403, { error: 'forbidden' }); return true }
  if (replyTo != null || !item.actions.includes(action)) { json(res, 400, { error: 'unknown_action' }); return true }
  const p = proposalOfItem(db, who.userId, item.id)
  if (!p || p.state !== 'pending' || item.state !== 'open') return conflict(res)
  const approve = action === labelsFor(p.action)[0]
  let settled = null
  let applied = null
  let closed = null
  try {
    db.transaction(() => {
      const state = !approve ? 'declined' : (isStale(db, p) ? 'stale' : 'approved')
      settled = settleProposal(db, { userId: who.userId, id: p.id, itemId: item.id, state })
      if (!settled) return
      if (state === 'approved') applied = applyProposal(db, settled)
      closed = state === 'stale'
        ? closeAs(db, settled, { resolution: 'cancelled', comment: STALE_LINE })
        : closeAs(db, settled, {
          resolution: 'decided', author: 'user', deviceId: who.deviceId,
          comment: applied ? applied.line : (settled.action === 'delete' ? 'Kept: the memory was not deleted.' : 'Declined: nothing was saved.'),
        })
    })()
  } catch (err) {
    // At the cap: the proposal stays for the user to answer once there is room.
    if (err?.message === 'too_many') { json(res, 409, { error: 'too_many' }); return true }
    throw err
  }
  if (!settled) return conflict(res)
  if (applied) emitMemoryMarker(ctx, who, applied.marker)
  const stale = settled.state === 'stale'
  closedMarker(ctx, settled, closed, stale ? {} : { by: 'user', sender: senderOf(db, who) })
  tellProposer(ctx, settled, closed?.item ?? item)
  const body = { item: closed?.item ?? getItem(db, who.userId, item.id) ?? item, comment: closed?.comment ?? null, proposal: view(settled) }
  if (stale) json(res, 409, { error: 'conflict', blocked_by: 'memory_changed', ...body })
  else json(res, 200, body)
  return true
}

// The user closed the question by hand: that is a "no". Called by the close
// route after its own write; never throws.
export function declineOnClose(ctx, userId, item) {
  if (item?.consent !== MEMORY_CONSENT) return
  safely('decline on close', () => {
    const p = proposalOfItem(ctx.db, userId, item.id)
    if (!p || p.state !== 'pending') return
    const settled = settleProposal(ctx.db, { userId: p.user_id, id: p.id, itemId: item.id, state: 'declined' })
    if (settled) tellProposer(ctx, settled, item)
  })
}

// Does this memory mirror live on the conversation that proposed it? Then the
// user's typed reply on it reaches that agent as a turn (items-http.js
// replyReachesAsker), which is how they say "word it differently".
export function proposerOwnsMirror(db, item) {
  const p = db.prepare('SELECT from_convo_id FROM memory_proposals WHERE item_id=? ORDER BY created_at DESC LIMIT 1').get(item.id)
  return !!p && p.from_convo_id != null && p.from_convo_id === item.origin_convo_id
}

// The sweep's half (src/ws.js). Proposals nobody answered in 7 days expire
// and their items close in one write, all of them or none. Then whatever a
// settled proposal is still owed is made good: an item left open is closed,
// a proposer not yet told is told. Each of those is tried again on the next
// sweep until it is done (for a day), so a failure part-way loses nothing.
const OWED_LINES = {
  expired: EXPIRED_LINE, stale: STALE_LINE,
  replaced: 'Set aside: a newer proposal for this memory took its place. Nothing was changed.',
  approved: 'Approved.', declined: 'Declined: nothing was changed.',
}
export function sweepMemoryProposals(ctx, now = Date.now()) {
  const { db } = ctx
  const expired = db.transaction(() => expireProposals(db, now).map((p) => ({ p, closed: closeAs(db, p, { resolution: 'cancelled', comment: EXPIRED_LINE }) })))()
  for (const { p, closed } of expired) closedMarker(ctx, p, closed)
  for (const p of owedFollowUps(db, now)) {
    safely('follow-up', () => {
      const decided = p.state === 'approved' || p.state === 'declined'
      const closed = closeAs(db, p, { resolution: decided ? 'decided' : 'cancelled', comment: OWED_LINES[p.state] ?? '' })
      closedMarker(ctx, p, closed)
      if (p.told_at == null) tellProposer(ctx, p, closed?.item ?? (p.item_id ? getItem(db, p.user_id, p.item_id) : null))
    })
  }
  pruneProposals(db, now)
}
