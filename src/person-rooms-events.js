// Side effects of rooms between two people (spec 2026-10-02 matron-to-matron
// sharing, phase 2) and of session shares: the cards and their tracker
// mirrors, the frames each side's agent is owed, the copy of every message
// into the other person's room, and teardown. src/person-rooms.js decides
// what happened; everything here runs after its transaction committed and
// is best-effort, like sharing-events.js — a card or a frame that fails is
// logged and the row stands.
//
// The rules of sharing-events.js hold here too. Cards and mirrors are
// client-only, so no agent, the Coordinator included, can see or answer one.
// Each person's log gets its own copy. The other person's words are peer text.
//
// One more rule: a message crosses only as a copy written by the journal,
// under the sender `person:<name>`. publish refuses that prefix to agents and
// a client's sender is always `user:`, so a bridge can trust `person:` as
// "this came from another person" and restrict the turn it starts.
import { append, appendAndBroadcast, toEventShape } from './journal.js'
import { sanitizePeerText, plainText as plain } from './peer-text.js'
import { participantIds, participantConvoIds } from './participants.js'
import { wakeIfOffline, wakeConvoAgent } from './wake.js'
import { deliverPendingInvites } from './invite-delivery.js'
import { consentLink } from './consent-items.js'
import { card, fileMirror, closeMirror, audit, changed, peopleConvo, OWNER_ACTIONS, PEER_ACTIONS } from './sharing-events.js'
import { linkOfRoom, setRoomItem, setShareItem, getPersonRoom, endPersonRoom, linksBetween, linksOnGrant, detachMission, PERSON_SENDER_PREFIX } from './person-rooms.js'

export const ROOM_CARD_KIND = 'person_room'
export const SESSION_SHARE_CARD_KIND = 'session_share'
// What a copy of a message can carry. A room message is a short exchange
// between agents; anything longer is cut, and said to be.
export const COPY_BODY_MAX = 16000
const JOURNAL = 'journal'
const TITLE_CAP = 120

export const safely = (what, fn) => { try { return fn() } catch (err) { console.error(`person rooms: ${what} failed (the row stands)`, err); return null } }
export const t = (s, n = TITLE_CAP) => plain(sanitizePeerText(s ?? '', n))
export const deviceName = (db, id) => db.prepare('SELECT name FROM devices WHERE id=?').get(id)?.name ?? 'agent'
const sessionTitle = (db, convoId) => db.prepare('SELECT title FROM conversations WHERE id=?').get(convoId)?.title ?? ''
export const roomLink = (id) => ({ url: consentLink('room', id), title: 'Room with another person' })
const shareLink = (id) => ({ url: consentLink('session', id), title: 'Session share' })
export const missionWords = (l) => (l.mission_id ? `mission #${l.mission_num} ${t(l.mission_title)}` : null)

// A frame for one agent device, routed by that device's OWN user — the hub
// keeps each user's sockets apart, and the two agents of a person room
// belong to two users.
function toDevice({ hub }, userId, deviceId, frame) {
  safely('agent frame', () => hub.sendToDevice(userId, deviceId, frame))
}

function fanParticipants({ db, hub }, userId, roomId) {
  safely('participants meta', () => appendAndBroadcast(db, hub, {
    userId, convoId: roomId, sender: JOURNAL, type: 'convo_meta',
    payload: { participants: participantIds(db, roomId), participant_convos: participantConvoIds(db, roomId) },
  }))
}

// What the room's members can do in a turn the other person started, in the
// words both cards use.
export function scopeWords(l, side) {
  const m = missionWords(l)
  if (side === 'owner') {
    return m
      ? `In a turn started by ${t(l.guest_name)}'s side, your agent may only reply in the room and use the tracker on ${m}. Anything more needs your tap.`
      : `In a turn started by ${t(l.guest_name)}'s side, your agent may only reply in the room. Anything more needs your tap.`
  }
  return m
    ? `In a turn started by ${t(l.owner_name)}'s side, your agent may only reply in the room and read the shared mission "${t(l.mission_title)}". Anything more needs your tap.`
    : `In a turn started by ${t(l.owner_name)}'s side, your agent may only reply in the room. Anything more needs your tap.`
}

export function cardPayload(db, l, direction) {
  return {
    kind: ROOM_CARD_KIND, direction, room_link_id: l.id,
    person: { name: direction === 'out' ? l.guest_name : l.owner_name },
    session_title: sanitizePeerText(sessionTitle(db, l.guest_convo_id), TITLE_CAP),
    topic: sanitizePeerText(l.topic, 200), justification: sanitizePeerText(l.justification, 1000),
    mission: l.mission_id ? { num: direction === 'out' ? l.mission_num : null, title: sanitizePeerText(l.mission_title, TITLE_CAP) } : null,
  }
}

// --- The two cards ----------------------------------------------------------

export function ownerAsk(ctx, l) {
  const { db } = ctx
  const box = deviceName(db, l.owner_device_id)
  const to = t(l.guest_name)
  safely('owner card', () => {
    card(ctx, { userId: l.owner_user_id, convoId: l.owner_room_id, sender: `agent:${box}`, payload: { ...cardPayload(db, l, 'out'), from_device_id: l.owner_device_id, from_name: sanitizePeerText(box, 80) } })
    const item = fileMirror(ctx, {
      userId: l.owner_user_id, convoId: l.owner_room_id, deviceId: l.owner_device_id, sender: `agent:${box}`, consent: 'room',
      title: `Approve a room with ${to}'s agent${l.topic ? ` — ${t(l.topic, 80)}` : ''}`,
      body: [
        `**${t(box, 80)}** asks to talk with **${to}**'s agent, in ${to}'s session "${t(sessionTitle(db, l.guest_convo_id))}".`,
        '',
        ...(l.topic ? [`- **Topic:** ${t(l.topic, 200)}`] : []),
        `- **Why:** ${t(l.justification, 1000)}`,
        ...(missionWords(l) ? [`- **Attached to:** ${missionWords(l)}, which ${to} can already read.`] : []),
        `- **What crosses:** the room's messages, both ways. Files do not.`,
        `- ${scopeWords(l, 'owner')}`,
        '',
        `**To answer:** tap **Approve** or **Decline**. If you approve, ${to} gets a card to accept. Unanswered, the request expires 24 h after it was made.`,
      ].join('\n'),
      link: roomLink(l.id), actions: OWNER_ACTIONS, idemKey: `consent:room:${l.id}:owner:${l.updated_at}`,
    })
    if (item) setRoomItem(db, l.id, 'owner', item.id)
  })
}

function guestAsk(ctx, l) {
  const { db } = ctx
  const from = t(l.owner_name)
  safely('guest card', () => {
    const convoId = peopleConvo(ctx, l.guest_user_id)
    card(ctx, { userId: l.guest_user_id, convoId, sender: JOURNAL, payload: cardPayload(db, l, 'in') })
    const item = fileMirror(ctx, {
      userId: l.guest_user_id, convoId, deviceId: 0, sender: JOURNAL, consent: 'room',
      title: `${from}'s agent wants to talk with your session "${t(sessionTitle(db, l.guest_convo_id), 80)}"`,
      body: [
        `Your contact **${from}** has approved their agent talking with your agent in your session "${t(sessionTitle(db, l.guest_convo_id))}".`,
        '',
        ...(l.topic ? [`- **Topic:** ${t(l.topic, 200)}`] : []),
        `- **Why, in their agent's words:** ${t(l.justification, 1000)}`,
        ...(l.mission_id ? [`- **Attached to:** ${from}'s mission "${t(l.mission_title)}", which they share with you.`] : []),
        `- **What crosses:** the room's messages, both ways. Files do not.`,
        `- ${scopeWords(l, 'guest')}`,
        '- Either of you can end it by removing the contact.',
        '',
        '**To answer:** tap **Accept** or **Decline**.',
      ].join('\n'),
      link: roomLink(l.id), actions: PEER_ACTIONS, idemKey: `consent:room:${l.id}:guest:${l.updated_at}`,
    })
    if (item) setRoomItem(db, l.id, 'guest', item.id)
  })
}

// The owner agent's ask was refused somewhere along the way: the same
// synthetic answer an expired or refused same-user invite gets.
export function refuseToOwner(ctx, l, reason) {
  toDevice(ctx, l.owner_user_id, l.owner_device_id, {
    kind: 'invite', event: 'answer', room_id: l.owner_room_id, peer_device_id: l.guest_device_id, accept: false, reason,
    person: { name: l.guest_name },
  })
}

export const roomAudit = (ctx, userId, l, side, event, summary, by = null) => audit(ctx, userId, {
  event, summary, by,
  extra: { room_link_id: l.id, person: { name: side === 'owner' ? l.guest_name : l.owner_name }, room_id: side === 'owner' ? l.owner_room_id : l.guest_room_id },
})

// After parkPersonRoom or answerPersonRoom. `who` is the tapping client
// (or null for the sweep). Returns the closed mirror of the card answered.
export function onPersonRoomOutcome(ctx, who, out) {
  const { db, hub } = ctx
  const l = out.link
  const before = out.before ?? l
  const to = t(l.guest_name)
  const from = t(l.owner_name)
  const tap = (userId, itemId, comment, resolution = 'decided') => closeMirror(ctx, {
    userId, itemId, consent: 'room', resolution, author: who ? 'user' : 'agent', deviceId: who?.deviceId ?? 0, comment,
  })
  let closed = null
  switch (out.outcome) {
    case 'parked':
      ownerAsk(ctx, l)
      break
    case 'sent':
      closed = tap(l.owner_user_id, before.owner_item_id, `Approved — ${to} has been asked to accept.`)
      roomAudit(ctx, l.owner_user_id, l, 'owner', 'room.offered', `You asked ${to}'s agent into a room`, 'you')
      guestAsk(ctx, l)
      roomAudit(ctx, l.guest_user_id, l, 'guest', 'room.received', `${from} asked for their agent to talk with yours`)
      changed(ctx, l.guest_user_id, { room_link_id: l.id })
      break
    case 'withdrawn':
      closed = tap(l.owner_user_id, before.owner_item_id, 'Declined — nothing was sent.')
      refuseToOwner(ctx, l, 'refused')
      break
    case 'unavailable':
      closed = who?.userId === l.guest_user_id
        ? tap(l.guest_user_id, before.guest_item_id, 'This can no longer go ahead: the contact or the session share has ended.', 'cancelled')
        : tap(l.owner_user_id, before.owner_item_id, 'This can no longer go ahead: the contact or the session share has ended.', 'cancelled')
      refuseToOwner(ctx, l, 'refused')
      break
    case 'expired':
      closeMirror(ctx, { userId: l.owner_user_id, itemId: before.owner_item_id, consent: 'room', resolution: 'cancelled', author: 'agent', deviceId: l.owner_device_id, comment: 'Expired — no answer within 24 h. Nothing was sent.' })
      refuseToOwner(ctx, l, 'expired')
      break
    case 'accepted':
      closed = tap(l.guest_user_id, before.guest_item_id, `Accepted — your agent is being asked to join. The room is listed as "${t(l.owner_name)}" in your chats.`)
      // The twin, announced to the guest's apps before anything lands in it.
      safely('twin announce', () => appendAndBroadcast(db, hub, {
        userId: l.guest_user_id, convoId: l.guest_room_id, sender: JOURNAL, type: 'convo_meta',
        payload: { title: db.prepare('SELECT title FROM conversations WHERE id=?').get(l.guest_room_id)?.title ?? '', parent_convo_id: null, person: { name: l.owner_name } },
      }))
      // What was said in the owner's room before the guest arrived (the
      // owner agent opens a room WITH its first message), copied in first
      // so the guest agent's join backlog has it. The owner approved sending
      // this room's messages to the guest; nothing older than the room crosses.
      backfillTwin(ctx, l)
      roomAudit(ctx, l.guest_user_id, l, 'guest', 'room.accepted', `You let ${from}'s agent talk with yours`, 'you')
      roomAudit(ctx, l.owner_user_id, l, 'owner', 'room.accepted', `${to} accepted — their agent is being asked to join`)
      safely('invite delivery', () => deliverPendingInvites(db, hub, { deviceId: l.guest_device_id }))
      safely('wake', () => wakeIfOffline(ctx, l.guest_user_id, l.guest_device_id))
      changed(ctx, l.owner_user_id, { room_link_id: l.id })
      break
    case 'refused':
      closed = tap(l.guest_user_id, before.guest_item_id, 'Declined.')
      roomAudit(ctx, l.guest_user_id, l, 'guest', 'room.declined', `You declined ${from}'s room`, 'you')
      roomAudit(ctx, l.owner_user_id, l, 'owner', 'room.declined', `${to} declined the room`)
      refuseToOwner(ctx, l, 'refused')
      changed(ctx, l.owner_user_id, { room_link_id: l.id })
      break
    default: break
  }
  return closed
}

// --- The guest agent's half -------------------------------------------------

// The guest agent acked its invite on the twin: the owner agent hears it
// on its own room, as from a same-user peer.
export function onGuestAck(ctx, guestRoomId, sessionState) {
  const hit = linkOfRoom(ctx.db, guestRoomId)
  if (!hit || hit.side !== 'guest' || hit.link.state !== 'invited') return
  const l = hit.link
  toDevice(ctx, l.owner_user_id, l.owner_device_id, {
    kind: 'invite', event: 'ack', room_id: l.owner_room_id, from_device_id: l.guest_device_id, session_state: sessionState,
  })
}

// After onGuestAgentAnswer: the owner agent hears the answer on its room.
export function onGuestAnswered(ctx, l, accept, reason = null) {
  if (!l) return
  if (accept) fanParticipants(ctx, l.owner_user_id, l.owner_room_id)
  toDevice(ctx, l.owner_user_id, l.owner_device_id, {
    kind: 'invite', event: 'answer', room_id: l.owner_room_id, peer_device_id: l.guest_device_id, accept,
    from_device_id: l.guest_device_id, person: { name: l.guest_name },
    ...(typeof reason === 'string' && reason ? { reason } : {}),
  })
  if (accept) {
    roomAudit(ctx, l.owner_user_id, l, 'owner', 'room.joined', `${t(l.guest_name)}'s agent joined the room`)
    roomAudit(ctx, l.guest_user_id, l, 'guest', 'room.joined', `Your agent joined ${t(l.owner_name)}'s room`)
  }
  changed(ctx, l.owner_user_id, { room_link_id: l.id })
}

// The twin's invite expired unanswered.
export function onGuestExpired(ctx, l) {
  if (l) refuseToOwner(ctx, l, 'expired')
}

// --- Teardown ---------------------------------------------------------------

const ENDED_WORDS = {
  owner_agent: (l, side) => (side === 'owner' ? 'Your agent ended the room.' : `${t(l.owner_name)}'s agent ended the room.`),
  guest_agent: (l, side) => (side === 'owner' ? `${t(l.guest_name)}'s agent left the room.` : 'Your agent left the room.'),
  owner_user: (l, side) => (side === 'owner' ? 'You ended the room.' : `${t(l.owner_name)} ended the room.`),
  guest_user: (l, side) => (side === 'owner' ? `${t(l.guest_name)} ended the room.` : 'You ended the room.'),
  contact_removed: () => 'The contact ended, so the room ended with it.',
}

// End a link and tell everyone what they are owed: each agent the frame a
// same-user peer leaving would send, each open card closed, one audit line
// per person. `before` is endPersonRoom's return.
export function onPersonRoomEnded(ctx, before, by) {
  if (!before) return
  const l = before
  const words = (side) => (ENDED_WORDS[by] ?? (() => 'The room ended.'))(l, side)
  if (l.state === 'awaiting_owner') {
    closeMirror(ctx, { userId: l.owner_user_id, itemId: l.owner_item_id, consent: 'room', resolution: 'cancelled', author: 'agent', comment: `${words('owner')} Nothing was sent.` })
    if (by !== 'owner_agent') refuseToOwner(ctx, l, 'left')
    return
  }
  if (l.state === 'awaiting_guest' || l.state === 'starting') {
    closeMirror(ctx, { userId: l.guest_user_id, itemId: l.guest_item_id, consent: 'room', resolution: 'cancelled', author: 'agent', comment: words('guest') })
    if (by !== 'owner_agent') refuseToOwner(ctx, l, 'left')
  }
  if (l.state === 'invited' || l.state === 'joined') {
    if (by !== 'owner_agent') {
      if (l.state === 'joined') {
        fanParticipants(ctx, l.owner_user_id, l.owner_room_id)
        toDevice(ctx, l.owner_user_id, l.owner_device_id, { kind: 'invite', event: 'left', room_id: l.owner_room_id, from_device_id: l.guest_device_id, person: { name: l.guest_name } })
      } else {
        refuseToOwner(ctx, l, 'left')
      }
    }
    if (by !== 'guest_agent' && l.guest_room_id) {
      fanParticipants(ctx, l.guest_user_id, l.guest_room_id)
      toDevice(ctx, l.guest_user_id, l.guest_device_id, { kind: 'invite', event: 'left', room_id: l.guest_room_id, from_device_id: l.owner_device_id, person: { name: l.owner_name } })
    }
  }
  roomAudit(ctx, l.owner_user_id, l, 'owner', 'room.ended', words('owner'))
  // Only a guest who was ever told of the link hears that it ended: not
  // before the owner's approval, and not a talk request held back because
  // the guest had blocked the owner (it never reached them; a frame naming
  // it would be the first they hear of it).
  const guestWasTold = l.state !== 'awaiting_owner' && (l.kind !== 'talk' || l.guest_item_id != null || l.guest_room_id != null)
  if (guestWasTold) roomAudit(ctx, l.guest_user_id, l, 'guest', 'room.ended', words('guest'))
  changed(ctx, l.owner_user_id, { room_link_id: l.id })
  if (guestWasTold) changed(ctx, l.guest_user_id, { room_link_id: l.id })
  // The contact request the talk made, ended with it (endPersonRoom).
  if (l.ended_contact) {
    changed(ctx, l.ended_contact.own.user_id, { contact_id: l.ended_contact.own.id })
    if (l.ended_contact.peer) changed(ctx, l.ended_contact.peer.user_id, { contact_id: l.ended_contact.peer.id })
  }
}

export function endAndNotify(ctx, linkId, by, to = 'left') {
  const before = safely('end', () => endPersonRoom(ctx.db, { linkId, to, by }))
  if (before) onPersonRoomEnded(ctx, before, by)
  return before
}

// A contact ended (removed or blocked): every room between the two people
// ends, both ways round.
export function onContactEndedRooms(ctx, userA, userB) {
  for (const l of safely('links', () => linksBetween(ctx.db, userA, userB)) ?? []) {
    endAndNotify(ctx, l.id, 'contact_removed', ['awaiting_owner', 'awaiting_guest', 'starting'].includes(l.state) ? 'withdrawn' : 'left')
  }
}

// A grant ended: rooms attached to that mission through that contact lose
// the attachment. The room itself stands; foreign turns lose the tracker.
export function onGrantEndedRooms(ctx, missionId, contactId) {
  for (const l of safely('links', () => linksOnGrant(ctx.db, { missionId, contactId })) ?? []) {
    safely('detach', () => detachMission(ctx.db, l.id))
  }
}

// --- Messages ---------------------------------------------------------------

// A message just landed in `convoId` (in `userId`'s log). If the room is
// joined to another person's, write the copy into theirs and deliver it
// as any append is delivered: to their apps, to their agent, as a push,
// waking the agent's box. Text only (files do not cross — publish refuses
// them up front). A copy is never copied back.
export function copyRoomMessage(ctx, { userId, convoId, sender, type, payload, seq }) {
  const { db, hub, pushPipeline, waker } = ctx
  if (type !== 'text' || typeof sender !== 'string') return null
  if (sender === JOURNAL || sender.startsWith(PERSON_SENDER_PREFIX)) return null
  const hit = linkOfRoom(db, convoId)
  if (!hit || hit.link.state !== 'joined') return null
  const l = hit.link
  const owner = hit.side === 'owner'
  if ((owner ? l.owner_user_id : l.guest_user_id) !== userId) return null
  const toUser = owner ? l.guest_user_id : l.owner_user_id
  const toRoom = owner ? l.guest_room_id : l.owner_room_id
  const person = owner ? l.owner_name : l.guest_name
  const raw = typeof payload?.body === 'string' ? payload.body : ''
  if (!raw.trim()) return null
  const body = raw.length > COPY_BODY_MAX ? `${raw.slice(0, COPY_BODY_MAX)}… [cut at ${COPY_BODY_MAX} characters]` : raw
  const copy = { body, person: { name: person }, via: sender.startsWith('user:') ? 'user' : 'agent' }
  const copySender = `${PERSON_SENDER_PREFIX}${person}`
  return safely('copy', () => {
    const r = append(db, { userId: toUser, convoId: toRoom, sender: copySender, type: 'text', payload: copy, idemKey: `person:${l.id}:${hit.side}:${seq}` })
    if (r.duplicate) return r
    const event = toEventShape({ seq: r.seq, convo_id: toRoom, ts: r.ts, sender: copySender, type: 'text', payload: copy })
    // Every agent the twin names that this user's hub holds: in practice
    // the room's own agent alone (the other person's device is in the other
    // user's bucket, which this broadcast never iterates).
    hub.broadcastJournal(toUser, { kind: 'journal', ...event }, new Set(participantIds(db, toRoom)))
    if (pushPipeline) safely('copy push', () => pushPipeline.onAppend(toUser, event, null))
    if (waker) safely('copy wake', () => wakeConvoAgent({ db, hub, waker }, toUser, toRoom))
    return r
  })
}

// The owner room's text so far, into a just-created twin: what was said in it
// since the owner agent opened it (parkPersonRoom only takes a FRESH room, so
// this is never older history). At most the last BACKFILL_MAX; same copy shape
// and idem keys as copyRoomMessage, so nothing is copied twice. No push or
// wake: the invite delivery that follows is what reaches the guest's agent,
// and its backlog read finds these.
export const BACKFILL_MAX = 50
// `+user_id` keeps the read on idx_events_convo, as isFreshRoom's.
function backfillTwin(ctx, l) {
  const { db, hub } = ctx
  safely('backfill', () => {
    const rows = db.prepare(`SELECT seq, sender, payload FROM events WHERE +user_id=? AND convo_id=? AND type='text'
      AND sender <> 'journal' AND sender NOT LIKE 'person:%' ORDER BY seq DESC LIMIT ?`).all(l.owner_user_id, l.owner_room_id, BACKFILL_MAX).reverse()
    const copySender = `${PERSON_SENDER_PREFIX}${l.owner_name}`
    for (const r of rows) {
      let p = null
      try { p = JSON.parse(r.payload) } catch { p = null }
      const raw = typeof p?.body === 'string' ? p.body : ''
      if (!raw.trim()) continue
      const body = raw.length > COPY_BODY_MAX ? `${raw.slice(0, COPY_BODY_MAX)}… [cut at ${COPY_BODY_MAX} characters]` : raw
      const copy = { body, person: { name: l.owner_name }, via: r.sender.startsWith('user:') ? 'user' : 'agent' }
      const a = append(db, { userId: l.guest_user_id, convoId: l.guest_room_id, sender: copySender, type: 'text', payload: copy, idemKey: `person:${l.id}:owner:${r.seq}` })
      if (!a.duplicate) hub.broadcastJournal(l.guest_user_id, { kind: 'journal', ...toEventShape({ seq: a.seq, convo_id: l.guest_room_id, ts: a.ts, sender: copySender, type: 'text', payload: copy }) }, new Set(participantIds(db, l.guest_room_id)))
    }
  })
}

// --- Session shares ---------------------------------------------------------

export function shareAsk(ctx, share, who) {
  const { db } = ctx
  const contact = db.prepare('SELECT peer_user FROM contacts WHERE id=?').get(share.contact_id)
  const to = t(contact?.peer_user ?? '')
  const title = t(sessionTitle(db, share.convo_id), 80)
  safely('share card', () => {
    card(ctx, {
      userId: share.user_id, convoId: share.convo_id, sender: `agent:${who.name}`,
      payload: { kind: SESSION_SHARE_CARD_KIND, direction: 'out', session_share_id: share.id, person: { name: contact?.peer_user ?? '' }, session_title: sanitizePeerText(sessionTitle(db, share.convo_id), TITLE_CAP), from_device_id: who.deviceId, from_name: sanitizePeerText(who.name, 80) },
    })
    const item = fileMirror(ctx, {
      userId: share.user_id, convoId: share.convo_id, deviceId: who.deviceId, sender: `agent:${who.name}`, consent: 'session',
      title: `Let ${to}'s agents talk to this session — "${title}"`,
      body: [
        `**${t(who.name, 80)}** asks to make this session, "${title}", reachable by your contact **${to}**'s agents.`,
        '',
        `- **What ${to}'s agents see:** this session's title on their roster, under your name. Never the box, its other sessions, or anything in them.`,
        `- **What it allows:** ${to}'s agents can ask for a room with this session. Each room still needs your approval and ${to}'s.`,
        '- You or this agent can stop sharing it at any time.',
        '',
        '**To answer:** tap **Approve** or **Decline**. Unanswered, the request expires 24 h after it was made.',
      ].join('\n'),
      link: shareLink(share.id), actions: OWNER_ACTIONS, idemKey: `consent:session:${share.id}:${share.updated_at}`,
    })
    if (item) setShareItem(db, share.id, item.id)
  })
}

export function onShareAnswered(ctx, who, out) {
  const s = out.share
  const comment = {
    shared: 'Approved — the session is now on their roster.',
    withdrawn: 'Declined — the session is not shared.',
    expired: 'Expired — no answer within 24 h. Not shared.',
    unavailable: 'This person is no longer a contact — not shared.',
  }[out.outcome]
  return closeMirror(ctx, {
    userId: s.user_id, itemId: out.before.item_id, consent: 'session',
    resolution: out.outcome === 'expired' ? 'cancelled' : 'decided',
    author: who ? 'user' : 'agent', deviceId: who?.deviceId ?? 0, comment,
  })
}

export function onShareEnded(ctx, before, who = null) {
  if (before.state === 'awaiting_user') {
    closeMirror(ctx, { userId: before.user_id, itemId: before.item_id, consent: 'session', resolution: 'cancelled', author: who?.kind === 'client' ? 'user' : 'agent', deviceId: who?.deviceId ?? 0, comment: 'Withdrawn — not shared.' })
  }
}

export { getPersonRoom }
