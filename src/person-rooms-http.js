// HTTP surface of session shares and rooms between people (spec 2026-10-02
// matron-to-matron sharing, phase 2; docs/protocol.md "Rooms between
// people").
//
//   GET    /session-shares[?convo_id=]          my shared sessions
//   POST   /session-shares {convo_id, contact}  share a session with a contact
//                                                (agent: parks for my approval)
//   DELETE /session-shares/:id                  stop sharing (agent or client)
//   POST   /session-shares/:id/answer {decision} approve | decline (client only)
//   GET    /person-rooms[?room_id=]             my rooms with other people; an
//                                                agent names a room it is in
//   POST   /person-rooms/:id/answer {decision}  approve|decline (owner) or
//                                                accept|decline (guest), client only;
//                                                a talk request's guest accepts with
//                                                target 'coordinator'|'new_session'
//                                                or convo_id
//   DELETE /person-rooms/:id                    end a room (client of either side)
//
// The room ask itself is the ordinary `agent_invite` op aimed at a shared
// session of a contact (ws.js); this file answers it. Every answer is a
// client's: no agent — the Coordinator included — can approve or accept
// anything that crosses to another person.
import { json, readBody } from './http-body.js'
import { badRequest, notFound, conflict } from './http-who.js'
import { authorizeAgentWrite } from './auth.js'
import { writableConvo } from './missions-http.js'
import { getItem } from './items.js'
import {
  shareSession, answerSessionShare, revokeSessionShare, listSessionShares, sessionShareRow,
  answerPersonRoom, getPersonRoom, linkOfRoom, listPersonRooms, personRoomRow, guestSees,
} from './person-rooms.js'
import { shareAsk, onShareAnswered, onShareEnded, onPersonRoomOutcome, endAndNotify } from './person-rooms-events.js'
import { answerTalkOwner, answerTalkGuest, pickedConvo, CHOICE } from './talk-requests.js'
import { onTalkOwnerOutcome, onTalkGuestOutcome, talkQuestionActions, recordFollowUpTap } from './talk-requests-events.js'

const forbidden = (res) => { json(res, 403, { error: 'forbidden' }); return true }
const SHARE_CONFLICTS = new Set(['private_session', 'not_contact', 'pending', 'too_many_asks', 'not_pending', 'not_active'])
const ROOM_CONFLICTS = new Set(['not_pending', 'not_available'])
const DECISIONS = new Set(['approve', 'accept', 'decline'])
// A talk request guest's accept names where their side talks.
function talkTargetOf(body) {
  if (typeof body.convo_id === 'string' && body.convo_id) return { convoId: body.convo_id }
  if (body.target === 'coordinator') return 'coordinator'
  if (body.target === 'new_session') return 'new'
  return null
}

export function applyShareAnswer(ctx, who, shareId, decision) {
  let out
  try { out = answerSessionShare(ctx.db, { userId: who.userId, shareId, decision }) } catch (err) {
    if (SHARE_CONFLICTS.has(err.message)) return { status: 409, body: { error: 'conflict', blocked_by: err.message } }
    throw err
  }
  if (!out) return { status: 404, body: { error: 'not_found' } }
  const closed = onShareAnswered(ctx, who, out)
  if (out.outcome === 'expired') return { status: 409, body: { error: 'conflict', blocked_by: 'expired' }, closed }
  return { status: 200, body: { session_share: sessionShareRow(ctx.db, out.share) }, closed }
}

export function applyRoomAnswer(ctx, who, linkId, decision) {
  let out
  try { out = answerPersonRoom(ctx.db, { userId: who.userId, linkId, decision: decision === 'decline' ? 'decline' : 'approve' }) } catch (err) {
    if (ROOM_CONFLICTS.has(err.message)) return { status: 409, body: { error: 'conflict', blocked_by: err.message } }
    throw err
  }
  if (!out) return { status: 404, body: { error: 'not_found' } }
  const closed = onPersonRoomOutcome(ctx, who, out)
  if (out.outcome === 'expired') return { status: 409, body: { error: 'conflict', blocked_by: 'expired' }, closed }
  const side = out.link.owner_user_id === who.userId ? 'owner' : 'guest'
  return { status: 200, body: { person_room: personRoomRow(out.link, side) }, closed }
}

// A talk request's answer, from either side. `choice` for the guest:
// 'decline' | 'coordinator' | 'pick' | 'new' | {convoId}; for the owner
// 'approve' | 'decline'.
export function applyTalkAnswer(ctx, who, link, choice) {
  const owner = link.owner_user_id === who.userId
  let out
  try {
    out = owner
      ? answerTalkOwner(ctx.db, { userId: who.userId, linkId: link.id, decision: choice === 'decline' ? 'decline' : 'approve' })
      : answerTalkGuest(ctx.db, { userId: who.userId, linkId: link.id, choice })
  } catch (err) {
    if (ROOM_CONFLICTS.has(err.message)) return { status: 409, body: { error: 'conflict', blocked_by: err.message } }
    throw err
  }
  if (!out) return { status: 404, body: { error: 'not_found' } }
  let closed = null
  let comment = null
  if (owner) {
    closed = onTalkOwnerOutcome(ctx, who, out)
    comment = closed?.comment ?? null
  } else {
    ({ closed = null, comment = null } = onTalkGuestOutcome(ctx, who, out) ?? {})
  }
  if (out.outcome === 'expired') return { status: 409, body: { error: 'conflict', blocked_by: 'expired' }, closed, comment }
  return { status: 200, body: { person_room: personRoomRow(out.link, owner ? 'owner' : 'guest') }, closed, comment }
}

// The guest's label, from the card's own buttons or a follow-up's.
function talkChoiceOf(link, label) {
  if (label === CHOICE.decline) return 'decline'
  if (label === CHOICE.coordinator) return 'coordinator'
  if (label === CHOICE.pick) return 'pick'
  if (label === CHOICE.new) return 'new'
  const convoId = pickedConvo(link, label)
  return convoId ? { convoId } : null
}

function handleTalkTap(ctx, res, who, item, action, replyTo, link) {
  const { db } = ctx
  const owner = link.owner_user_id === who.userId && link.owner_item_id === item.id
  let choice
  if (replyTo != null) {
    // A follow-up's button: only on the guest's mirror, only the journal's
    // own question, only one of its labels.
    const offered = owner ? null : talkQuestionActions(db, item.id, replyTo)
    if (!offered || !offered.includes(action)) { json(res, 400, { error: 'unknown_action' }); return true }
    choice = talkChoiceOf(link, action)
  } else {
    if (!item.actions.includes(action)) { json(res, 400, { error: 'unknown_action' }); return true }
    choice = owner ? (action === 'Cancel' ? 'decline' : 'approve') : talkChoiceOf(link, action)
  }
  if (!choice) { json(res, 400, { error: 'unknown_action' }); return true }
  const r = applyTalkAnswer(ctx, who, link, choice)
  if (r.status !== 200) { json(res, r.status, r.body); return true }
  if (replyTo != null) recordFollowUpTap(ctx, who, item.id, action, replyTo)
  json(res, 200, { item: getItem(db, who.userId, item.id) ?? item, comment: r.comment ?? null, ...r.body })
  return true
}

// A tap on a room or session-share mirror (POST /items/:id/comments
// {action}) IS the answer, like a contact or share mirror's. Client only
// (items-http refuses an agent's action before it gets here). `replyTo` is
// a talk request's follow-up question (the comment-actions contract).
export function handlePeopleRoomTap(ctx, res, who, item, action, replyTo = null) {
  const { db } = ctx
  if (item.consent === 'room') {
    const row = db.prepare('SELECT id, kind FROM person_rooms WHERE (owner_user_id=@u AND owner_item_id=@i) OR (guest_user_id=@u AND guest_item_id=@i)').get({ u: who.userId, i: item.id })
    if (row?.kind === 'talk') return handleTalkTap(ctx, res, who, item, action, replyTo, getPersonRoom(db, row.id))
  }
  if (replyTo != null) { json(res, 400, { error: 'unknown_action' }); return true }
  if (!item.actions.includes(action)) { json(res, 400, { error: 'unknown_action' }); return true }
  const decision = action === 'Decline' ? 'decline' : 'approve'
  let r
  if (item.consent === 'session') {
    const row = db.prepare('SELECT id FROM session_shares WHERE user_id=? AND item_id=?').get(who.userId, item.id)
    if (!row) return conflict(res)
    r = applyShareAnswer(ctx, who, row.id, decision)
  } else {
    const row = db.prepare('SELECT id FROM person_rooms WHERE (owner_user_id=@u AND owner_item_id=@i) OR (guest_user_id=@u AND guest_item_id=@i)').get({ u: who.userId, i: item.id })
    if (!row) return conflict(res)
    r = applyRoomAnswer(ctx, who, row.id, decision)
  }
  if (r.status !== 200) { json(res, r.status, r.body); return true }
  json(res, 200, { item: getItem(db, who.userId, item.id) ?? item, comment: r.closed?.comment ?? null, ...r.body })
  return true
}

export const isPeopleRoomMirror = (item) => item?.consent === 'room' || item?.consent === 'session'

async function handleShares(ctx, req, res, url, who) {
  const { db } = ctx
  const path = url.pathname
  if (path === '/session-shares') {
    if (req.method === 'GET') {
      const convoId = url.searchParams.get('convo_id')
      json(res, 200, { session_shares: listSessionShares(db, who.userId, { convoId }) })
      return true
    }
    if (req.method !== 'POST') return false
    const body = await readBody(req)
    if (typeof body.convo_id !== 'string' || !body.convo_id || typeof body.contact !== 'string' || !body.contact) return badRequest(res)
    // An agent shares only a session it manages, and its card goes there.
    if (who.kind === 'agent' && !writableConvo(db, who, body.convo_id)) return notFound(res)
    let out
    try {
      out = shareSession(db, { userId: who.userId, convoId: body.convo_id, contact: body.contact, by: who.kind === 'agent' ? 'agent' : 'user', deviceId: who.deviceId })
    } catch (err) {
      if (err.message === 'no_session') return notFound(res)
      if (SHARE_CONFLICTS.has(err.message)) return conflict(res, { blocked_by: err.message })
      throw err
    }
    if (out.outcome === 'parked') shareAsk(ctx, out.share, who)
    json(res, out.outcome === 'parked' ? 202 : (out.outcome === 'existing' ? 200 : 201), {
      session_share: sessionShareRow(db, out.share), ...(out.outcome === 'parked' ? { pending: 'owner' } : {}),
    })
    return true
  }
  const m = path.match(/^\/session-shares\/([^/]+)(?:\/(answer))?$/)
  if (!m) return false
  let id
  try { id = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  if (m[2] === 'answer') {
    if (req.method !== 'POST') return false
    if (who.kind !== 'client') return forbidden(res)
    const body = await readBody(req)
    if (!DECISIONS.has(body.decision)) return badRequest(res)
    const r = applyShareAnswer(ctx, who, id, body.decision)
    json(res, r.status, r.body)
    return true
  }
  if (req.method !== 'DELETE') return false
  let out
  try { out = revokeSessionShare(db, { userId: who.userId, shareId: id }) } catch (err) {
    if (SHARE_CONFLICTS.has(err.message)) return conflict(res, { blocked_by: err.message })
    throw err
  }
  if (!out) return notFound(res)
  onShareEnded(ctx, out.before, who)
  json(res, 200, { session_share: sessionShareRow(db, out.share) })
  return true
}

async function handleRooms(ctx, req, res, url, who) {
  const { db } = ctx
  const path = url.pathname
  if (path === '/person-rooms') {
    if (req.method !== 'GET') return false
    const roomId = url.searchParams.get('room_id')
    // The list is the person's: it names asks still waiting on them, which
    // no agent — the Coordinator included — hears of. An agent asks only
    // about a room it is in, by that room's id.
    if (roomId == null) {
      if (who.kind !== 'client') return forbidden(res)
      json(res, 200, { person_rooms: listPersonRooms(db, who.userId) })
      return true
    }
    // The bridge's question at the start of a turn the other person
    // started: who is on the other side, and which mission (if any) the
    // turn may use. An agent asks only about a room it may write into; an
    // ordinary room, or one it is not in, is the same 404.
    if (who.kind === 'agent' && !authorizeAgentWrite(db, who.userId, who.deviceId, roomId)) return notFound(res)
    const hit = linkOfRoom(db, roomId)
    if (!hit) return notFound(res)
    const mine = hit.side === 'owner' ? hit.link.owner_user_id === who.userId : hit.link.guest_user_id === who.userId
    if (!mine) return notFound(res)
    json(res, 200, { person_room: personRoomRow(hit.link, hit.side) })
    return true
  }
  const m = path.match(/^\/person-rooms\/([^/]+)(?:\/(answer))?$/)
  if (!m) return false
  // By id: the person's own devices only (see the list above).
  if (who.kind !== 'client') return forbidden(res)
  let id
  try { id = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  const link = getPersonRoom(db, id)
  const side = link?.owner_user_id === who.userId ? 'owner' : (link?.guest_user_id === who.userId && guestSees(db, link) ? 'guest' : null)
  if (!link || !side) return notFound(res)
  if (m[2] === 'answer') {
    if (req.method !== 'POST') return false
    if (who.kind !== 'client') return forbidden(res)
    const body = await readBody(req)
    if (!DECISIONS.has(body.decision)) return badRequest(res)
    if (link.kind === 'talk') {
      let choice = body.decision === 'decline' ? 'decline' : 'approve'
      if (side === 'guest' && choice !== 'decline') {
        choice = talkTargetOf(body)
        if (!choice) return badRequest(res)
      }
      const r = applyTalkAnswer(ctx, who, link, choice)
      json(res, r.status, r.body)
      return true
    }
    const r = applyRoomAnswer(ctx, who, id, body.decision)
    json(res, r.status, r.body)
    return true
  }
  if (req.method === 'GET') { json(res, 200, { person_room: personRoomRow(link, side) }); return true }
  if (req.method !== 'DELETE') return false
  // Either person ends a room from their own device. Agents leave through
  // agent_leave, like any room.
  if (who.kind !== 'client') return forbidden(res)
  const before = endAndNotify(ctx, id, side === 'owner' ? 'owner_user' : 'guest_user', ['awaiting_owner', 'awaiting_guest', 'starting'].includes(link.state) ? 'withdrawn' : 'left')
  if (!before) return conflict(res, { blocked_by: 'not_active' })
  json(res, 200, { person_room: personRoomRow(getPersonRoom(db, id), side) })
  return true
}

export async function handlePersonRoomRoute(ctx, req, res, url, who) {
  const path = url.pathname
  if (path === '/session-shares' || path.startsWith('/session-shares/')) return handleShares(ctx, req, res, url, who)
  if (path === '/person-rooms' || path.startsWith('/person-rooms/')) return handleRooms(ctx, req, res, url, who)
  return false
}
