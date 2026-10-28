// HTTP surface of contributors (src/contribute.js; docs/protocol.md
// "Contributors"). Mounted inside the routes a contributor already uses for
// their own tracker — POST /milestones, POST /items, POST /items/:id/
// comments|close|reopen, PATCH /missions/:id — at the point where the
// target turns out to be another person's mission they contribute to.
//
// Two deliveries cross the person boundary, both as the ordinary 'item'
// marker an item reply turn is built from, with sender `person:<name>` — a
// sender only the journal writes, which a bridge treats as another
// person's words and runs as a restricted (foreign) turn:
//   - a contributor's comment, close or reopen on one of the owner's items
//     goes to that item's origin conversation, in the owner's log;
//   - the owner's comment, close or reopen (by the owner or one of their
//     agents) on an item a contributor filed goes to the conversation that
//     filed it, in the contributor's log, as the contributor's view of the
//     item (the owner's number, no conversation or device of the owner's).
// Both carry `person: {name, via}` and `mission_id`; the second also
// `shared_by: {user_id, name}`, the owner, for the tools that take it.
import { appendAndBroadcast, broadcastAppended, append, toEventShape } from './journal.js'
import { json, readBody } from './http-body.js'
import { badRequest, notFound, conflict } from './http-who.js'
import { validateItemFields, getSharedItem, requestTurn, RESOLUTIONS, BODY_MAX } from './items.js'
import { itemMarkerPayload, ITEM_EVENT_TYPE } from './items-marker.js'
import { MISSION_EVENT_TYPE, MILESTONE_EVENT_TYPE, missionMarkerPayload, milestoneMarkerPayload } from './missions-marker.js'
import { MILESTONE_KINDS, TITLE_MAX, validateMissionFields, getMission, getGrantedMission, milestoneRow } from './missions.js'
import { missionAccess } from './visibility.js'
import { wakeConvoAgent } from './wake.js'
import { strayInlineRef } from './inline-refs.js'
import { withdrawOnClose } from './item-handover-http.js'
import { notifyGrantees } from './sharing-events.js'
import { PEOPLE_TITLE, PEOPLE_SYSTEM } from './people-convo.js'
import {
  CONTRIBUTE_KINDS, contributorOf, contributableMission, contributableItem,
  contributeMilestone, contributeItem, contributeComment, contributeClose, contributeReopen, contributeStatus,
} from './contribute.js'

const forbidden = (res) => { json(res, 403, { error: 'forbidden' }); return true }
// The same rule the owner's own routes apply: an inline ref may only place
// one of the write's own attachments, and a contributor's writes have none.
function strayRef(res, text) {
  const ref = strayInlineRef(text, [])
  if (ref == null) return false
  json(res, 400, { error: 'invalid_attachment_ref', ref })
  return true
}
// A share that ended while the body arrived (contribute.js 'gone'): the
// same 404 a fresh request would get.
// A mission closed meanwhile is the 409 a fresh request would get.
function gone(res, fn) {
  try { return { out: fn() } } catch (err) {
    if (err.message === 'gone') { notFound(res); return null }
    if (err.message === 'closed') { conflict(res, { blocked_by: 'closed' }); return null }
    throw err
  }
}
const personSender = (name) => `person:${name}`
const WAKES = new Set(['commented', 'closed', 'reopened'])

// The contributor's own conversation an ask names: the same gate as every
// agent-authored write. undefined = absent, null = not theirs.
function ownConvo(db, who, convoId, writableConvo) {
  if (convoId === undefined || convoId === null) return undefined
  return writableConvo(db, who, convoId) ? convoId : null
}

// Resolves the mission a contributor names. Answers the refusal itself and
// returns null when it did.
function missionFor(db, res, who, missionId) {
  let m
  try { m = contributableMission(db, who.userId, missionId) } catch (err) {
    if (err.message === 'read_only') { forbidden(res); return null }
    throw err
  }
  if (!m) { notFound(res); return null }
  if (m.state !== 'open') { conflict(res, { blocked_by: 'closed' }); return null }
  return m
}

// A comment as the contributor reads it: their grantee view of the thread.
const grantedComment = (c) => ({ ...c, device_id: 0, device_name: null, convo_id: null, convo_title: null, actions: [], chosen_action: null })

// The owner-side marker of a contributor's write, in the owner's log.
function toOwner(ctx, { contributor, item, action, comment = null }) {
  const { db, hub, pushPipeline } = ctx
  const owner = item.user_id
  const ownerItem = db.prepare('SELECT origin_convo_id FROM items WHERE id=?').get(item.id)
  const convoId = ownerItem?.origin_convo_id
  if (!convoId) return
  const sender = personSender(contributor.name)
  // The owner-side row, decorated for the owner (contributor, never the
  // contributor's conversation).
  const full = db.prepare('SELECT i.* FROM items i WHERE i.id=?').get(item.id)
  const payload = { ...itemMarkerPayload({ item: { ...full, actions: JSON.parse(full.actions ?? '[]') }, action, by: contributor.via, comment }), person: { name: contributor.name, via: contributor.via }, mission_id: full.mission_id }
  let r
  try {
    r = appendAndBroadcast(db, hub, { userId: owner, convoId, sender, type: ITEM_EVENT_TYPE, payload })
  } catch (err) { console.error('contribute: owner marker failed (the write stands)', err); return }
  try { pushPipeline?.onAppend(owner, toEventShape({ seq: r.seq, convo_id: convoId, ts: r.ts, sender, type: ITEM_EVENT_TYPE, payload }), null) } catch (err) { console.error('contribute: push failed', err) }
  // As the owner's own item-reply path does (items-http.js emitMarker): the
  // item shows its session's turn as queued until it starts.
  if (WAKES.has(action)) {
    try { requestTurn(db, item.id) } catch (err) { console.error('contribute: turn request stamp failed', err) }
    wakeConvoAgent(ctx, owner, convoId)
  }
  notifyGrantees(ctx, full.mission_id, 'item')
}

// The owner (or one of the owner's agents) wrote on an item a contributor
// filed: their filing conversation hears it, while they still contribute.
// Called from items-http.js emitMarker for every owner-side item write;
// returns at once for any other item. Never throws.
export function forwardToContributor(ctx, who, item, { action, comment = null }) {
  if (!WAKES.has(action)) return
  const { db, hub, pushPipeline } = ctx
  try {
    const row = db.prepare('SELECT user_id, mission_id, contributor_user_id, contributor_convo_id FROM items WHERE id=?').get(item.id)
    if (!row?.contributor_user_id || !row.contributor_convo_id || who.userId !== row.user_id) return
    const to = row.contributor_user_id
    if (missionAccess(db, to, row.mission_id) !== 'contribute') return
    if (!db.prepare('SELECT 1 FROM conversations WHERE id=? AND owner_user_id=?').get(row.contributor_convo_id, to)) return
    const shared = getSharedItem(db, to, item.id)
    if (!shared) return
    const owner = db.prepare('SELECT id, name FROM users WHERE id=?').get(row.user_id)
    const sender = personSender(owner.name)
    const via = who.kind === 'agent' ? 'agent' : 'user'
    const payload = {
      ...itemMarkerPayload({ item: shared, action, by: via, comment }),
      person: { name: owner.name, via }, shared_by: { user_id: owner.id, name: owner.name }, mission_id: row.mission_id,
    }
    const r = appendAndBroadcast(db, hub, { userId: to, convoId: row.contributor_convo_id, sender, type: ITEM_EVENT_TYPE, payload })
    try { pushPipeline?.onAppend(to, toEventShape({ seq: r.seq, convo_id: row.contributor_convo_id, ts: r.ts, sender, type: ITEM_EVENT_TYPE, payload }), null) } catch (err) { console.error('contribute: push failed', err) }
    wakeConvoAgent(ctx, to, row.contributor_convo_id)
  } catch (err) {
    console.error('contribute: reply to the contributor failed (the write stands)', err)
  }
}

// POST /milestones {mission, kind, title, body?, convo_id?} on a mission of
// another person's. `body` is already read.
export function handleContributedMilestone(ctx, res, who, body, { writableConvo }) {
  const { db, hub } = ctx
  if (!MILESTONE_KINDS.includes(body.kind)) return badRequest(res)
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > TITLE_MAX) return badRequest(res)
  if (body.body !== undefined && (typeof body.body !== 'string' || Buffer.byteLength(body.body, 'utf8') > BODY_MAX)) return badRequest(res)
  if (ownConvo(db, who, body.convo_id, writableConvo) === null) return notFound(res)
  const mission = missionFor(db, res, who, body.mission)
  if (!mission) return true
  const contributor = contributorOf(db, who)
  const sender = personSender(contributor.name)
  const ownerMission = getMission(db, mission.user_id, mission.id)
  const markerOf = (row) => ({ ...milestoneMarkerPayload({ milestone: row, mission: ownerMission, by: contributor.via }), person: { name: contributor.name, via: contributor.via } })
  const r = gone(res, () => contributeMilestone(db, {
    mission, contributor, kind: body.kind, title: body.title.trim(), body: body.body ?? '',
    appendMarker: (convoId, row) => append(db, { userId: mission.user_id, convoId, sender, type: MILESTONE_EVENT_TYPE, payload: markerOf(row) }),
  }))
  if (!r) return true
  const { out } = r
  try {
    if (out.peopleCreated) appendAndBroadcast(db, hub, { userId: mission.user_id, convoId: out.convoId, sender: 'journal', type: 'convo_meta', payload: { title: PEOPLE_TITLE, parent_convo_id: null, system: PEOPLE_SYSTEM } })
    broadcastAppended(db, hub, { userId: mission.user_id, convoId: out.convoId, seq: out.seq, ts: out.ts, sender, type: MILESTONE_EVENT_TYPE, payload: markerOf(out.milestone) })
  } catch (err) { console.error('contribute: milestone broadcast failed (row and marker already committed)', err) }
  notifyGrantees(ctx, mission.id, 'milestone')
  const { convo_id: _c, seq: _s, device_id: _d, ...text } = milestoneRow(out.milestone)
  json(res, 201, { milestone: text, mission: getGrantedMission(db, who.userId, mission.id) })
  return true
}

// POST /items {mission, kind, title, body?, labels?, links?, convo_id?}.
// An agent names the conversation that files it (where the owner's replies
// will go); a client may. No attachments, no action buttons.
export function handleContributedItem(ctx, res, who, body, { writableConvo }) {
  const { db, hub } = ctx
  if (!CONTRIBUTE_KINDS.includes(body.kind)) return badRequest(res)
  // `attachments: []` is "none", as on a comment; anything in it is refused.
  if (body.attachments !== undefined && !(Array.isArray(body.attachments) && body.attachments.length === 0)) return badRequest(res)
  if (body.actions !== undefined || body.on_behalf_of !== undefined || body.supersedes !== undefined) return badRequest(res)
  const v = validateItemFields({ title: body.title, body: body.body, labels: body.labels, links: body.links })
  if (!v.ok) return badRequest(res)
  if (strayRef(res, v.value.body)) return true
  if (who.kind === 'agent' && (typeof body.convo_id !== 'string' || !body.convo_id)) return badRequest(res)
  const replyConvoId = ownConvo(db, who, body.convo_id, writableConvo)
  if (replyConvoId === null) return notFound(res)
  const mission = missionFor(db, res, who, body.mission)
  if (!mission) return true
  const contributor = contributorOf(db, who)
  const r = gone(res, () => contributeItem(db, { mission, contributor, replyConvoId: replyConvoId ?? null, kind: body.kind, ...v.value, labels: v.value.labels ?? [], links: v.value.links ?? [] }))
  if (!r) return true
  const { out } = r
  if (out.peopleConvo.created) {
    try { appendAndBroadcast(db, hub, { userId: mission.user_id, convoId: out.peopleConvo.id, sender: 'journal', type: 'convo_meta', payload: { title: PEOPLE_TITLE, parent_convo_id: null, system: PEOPLE_SYSTEM } }) } catch (err) { console.error('contribute: people convo announce failed', err) }
  }
  toOwner(ctx, { contributor, item: { id: out.itemId, user_id: mission.user_id }, action: 'created' })
  json(res, 201, { item: getSharedItem(db, who.userId, out.itemId) })
  return true
}

// POST /items/:id/comments|close|reopen on an item of a mission the caller
// contributes to. `shared` is the caller's grantee view of it. Anything else
// on such an item is 403, as for a read grantee.
export async function handleContributorItemSub(ctx, req, res, who, shared, sub, subId) {
  const { db } = ctx
  if (req.method !== 'POST' || subId != null || !['comments', 'close', 'reopen'].includes(sub)) return forbidden(res)
  const item = contributableItem(db, who.userId, shared.id)
  if (!item) return forbidden(res)
  const body = await readBody(req)
  // A closed mission takes no more writes, as for milestones and items.
  if (db.prepare('SELECT state FROM missions WHERE id=?').get(item.mission_id)?.state !== 'open') return conflict(res, { blocked_by: 'closed' })
  const contributor = contributorOf(db, who)
  const reply = (out) => {
    json(res, sub === 'comments' ? 201 : 200, { item: getSharedItem(db, who.userId, item.id), comment: grantedComment(out.comment ?? out) })
    return true
  }
  if (sub === 'comments') {
    // Words only: the buttons on the owner's items are the owner's to tap,
    // and a contributor offers none.
    if (body.action != null || body.reply_to != null) return forbidden(res)
    if (body.actions != null && !(Array.isArray(body.actions) && body.actions.length === 0)) return forbidden(res)
    if (body.attachments !== undefined && !(Array.isArray(body.attachments) && body.attachments.length === 0)) return badRequest(res)
    if (typeof body.body !== 'string' || !body.body.trim() || body.body.length > BODY_MAX) return badRequest(res)
    if (strayRef(res, body.body)) return true
    const r = gone(res, () => contributeComment(db, { item, contributor, body: body.body }))
    if (!r) return true
    toOwner(ctx, { contributor, item, action: 'commented', comment: r.out })
    return reply(r.out)
  }
  if (body.comment !== undefined && (typeof body.comment !== 'string' || body.comment.length > BODY_MAX)) return badRequest(res)
  if (strayRef(res, body.comment)) return true
  if (sub === 'close') {
    if (!RESOLUTIONS.includes(body.resolution)) return badRequest(res)
    const r = gone(res, () => contributeClose(db, { item, contributor, resolution: body.resolution, comment: body.comment ?? '' }))
    if (!r) return true
    const out = r.out
    if (!out) return conflict(res)
    // As the owner's close route does: a pending item hand-over goes with it.
    withdrawOnClose(ctx, item.user_id, item.id)
    toOwner(ctx, { contributor, item, action: 'closed', comment: out.comment })
    return reply(out)
  }
  const r = gone(res, () => contributeReopen(db, { item, contributor, comment: body.comment ?? '' }))
  if (!r) return true
  const out = r.out
  if (!out) return conflict(res)
  toOwner(ctx, { contributor, item, action: 'reopened', comment: out.comment })
  return reply(out)
}

// PATCH /missions/:id {status} — the one mission field a contributor sets.
// Any other field is 403. `granted` is the caller's grantee view.
export async function handleContributorMissionPatch(ctx, req, res, who, granted) {
  const { db, hub } = ctx
  let mission
  try { mission = contributableMission(db, who.userId, granted.id) } catch { return forbidden(res) }
  if (!mission) return forbidden(res)
  const body = await readBody(req)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res)
  if (Object.keys(body).some((k) => k !== 'status' && k !== 'convo_id') || body.status === undefined) return forbidden(res)
  const v = validateMissionFields({ status: body.status }, { partial: true })
  if (!v.ok) return badRequest(res)
  if (mission.state !== 'open') return conflict(res, { blocked_by: 'closed' })
  const contributor = contributorOf(db, who)
  const r = gone(res, () => contributeStatus(db, { mission, contributor, status: v.value.status }))
  if (!r) return true
  const updated = r.out
  // The owner's origin conversation is told, as for any status change: a
  // flag, never the text, from the other person.
  try {
    appendAndBroadcast(db, hub, {
      userId: mission.user_id, convoId: updated.origin_convo_id, sender: personSender(contributor.name), type: MISSION_EVENT_TYPE,
      payload: { ...missionMarkerPayload({ mission: updated, action: 'updated', by: contributor.via, statusChanged: true }), person: { name: contributor.name, via: contributor.via } },
    })
  } catch (err) { console.error('contribute: mission marker failed (the status stands)', err) }
  notifyGrantees(ctx, mission.id, 'mission')
  json(res, 200, { mission: getGrantedMission(db, who.userId, mission.id) })
  return true
}
