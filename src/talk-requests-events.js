// Side effects of talk requests (src/talk-requests.js): the two cards and
// their tracker mirrors, the guest's follow-up questions on the same item,
// starting a new session for the guest, and the sweep. Everything after a
// decision reuses person-rooms-events.js, so a talk that has a guest
// session behaves exactly like a room with a shared session from there on.
//
// The rules of sharing-events.js hold: cards, mirrors and their comments
// are client-only (the mirror carries `consent`), so no agent — either
// person's Coordinator included — sees or answers one; each person's log
// gets its own copy; the other person's words are peer text.
import { appendAndBroadcast, upsertConversation, CONVO_ID_MAX_CHARS } from './journal.js'
import { addComment, getItem } from './items.js'
import { itemMarkerPayload, ITEM_EVENT_TYPE } from './items-marker.js'
import { sanitizePeerText, plainText as plain } from './peer-text.js'
import { wakeIfOffline } from './wake.js'
import { card, fileMirror, closeMirror, audit, changed, peopleConvo, onContactOutcome } from './sharing-events.js'
import {
  onPersonRoomOutcome, refuseToOwner, roomAudit, scopeWords, cardPayload, missionWords, roomLink, deviceName, safely, t,
} from './person-rooms-events.js'
import { setRoomItem, getPersonRoom, guestSees, expirePersonRoomAsks } from './person-rooms.js'
import {
  OWNER_TALK_ACTIONS, CHOICE, guestChoices, contactPending, completeTalkStart, failTalkStart, expireTalkAsks, TALK_GUEST_TTL_MS,
} from './talk-requests.js'

const JOURNAL = 'journal'
const DAYS = Math.round(TALK_GUEST_TTL_MS / (24 * 60 * 60 * 1000))
const topicSuffix = (l) => (l.topic ? ` — ${t(l.topic, 80)}` : '')

export function talkCardPayload(db, l, direction, choices) {
  return { ...cardPayload(db, l, direction), session_title: null, talk: true, contact_pending: contactPending(db, l), choices }
}

// The task the new session starts with: what it is for, and that the
// other person's turns are restricted.
export function talkTask(l) {
  const about = l.topic ? `about ${plain(sanitizePeerText(l.topic, 200))}` : 'about a topic their agent will give'
  return `This session was started for a talk with ${plain(l.owner_name)}, another person, ${about}. Their agent's room invite arrives next; reply there. Their turns are restricted.`
}
export const talkSessionTitle = (l) => `Talk with ${l.owner_name}${l.topic ? ` — ${plain(sanitizePeerText(l.topic, 120))}` : ''}`.slice(0, 200)

// --- The owner's card -------------------------------------------------------

export function ownerTalkAsk(ctx, l) {
  const { db } = ctx
  const box = deviceName(db, l.owner_device_id)
  const to = t(l.guest_name)
  const pending = contactPending(db, l)
  safely('talk owner card', () => {
    card(ctx, { userId: l.owner_user_id, convoId: l.owner_room_id, sender: `agent:${box}`, payload: { ...talkCardPayload(db, l, 'out', OWNER_TALK_ACTIONS), from_device_id: l.owner_device_id, from_name: sanitizePeerText(box, 80) } })
    const item = fileMirror(ctx, {
      userId: l.owner_user_id, convoId: l.owner_room_id, deviceId: l.owner_device_id, sender: `agent:${box}`, consent: 'room',
      title: `Ask ${to} to talk${topicSuffix(l)}`,
      body: [
        `**${t(box, 80)}** asks to talk with **${to}**'s agent in this room.`,
        '',
        ...(l.topic ? [`- **Topic:** ${t(l.topic, 200)}`] : []),
        `- **Why:** ${t(l.justification, 1000)}`,
        ...(missionWords(l) ? [`- **Attached to:** ${missionWords(l)}, which ${to} can already read.`] : []),
        `- **What happens:** ${to} gets one card and chooses where their side talks: a new session, their Coordinator, or one of their sessions.`,
        ...(pending ? [`- This also sends ${to} a contact request.`] : []),
        `- **What crosses:** the room's messages, both ways. Files do not.`,
        `- ${scopeWords(l, 'owner')}`,
        '',
        `**To answer:** tap **Send** or **Cancel**. Unanswered, the request expires 24 h after it was made.`,
      ].join('\n'),
      link: roomLink(l.id), actions: OWNER_TALK_ACTIONS, idemKey: `consent:room:${l.id}:owner:${l.updated_at}`,
    })
    if (item) setRoomItem(db, l.id, 'owner', item.id)
  })
}

// --- The guest's card -------------------------------------------------------

function guestTalkAsk(ctx, l) {
  const { db } = ctx
  const from = t(l.owner_name)
  const choices = guestChoices(db, l)
  const pending = contactPending(db, l)
  safely('talk guest card', () => {
    const convoId = peopleConvo(ctx, l.guest_user_id)
    card(ctx, { userId: l.guest_user_id, convoId, sender: JOURNAL, payload: talkCardPayload(db, l, 'in', choices) })
    const item = fileMirror(ctx, {
      userId: l.guest_user_id, convoId, deviceId: 0, sender: JOURNAL, consent: 'room',
      title: `${from}'s agent wants to talk${topicSuffix(l)}`,
      body: [
        `**${from}** asks for their agent to talk with one of your agents.`,
        '',
        ...(l.topic ? [`- **Topic:** ${t(l.topic, 200)}`] : []),
        `- **Why, in their agent's words:** ${t(l.justification, 1000)}`,
        ...(l.mission_id ? [`- **Attached to:** ${from}'s mission "${t(l.mission_title)}", which they share with you.`] : []),
        ...(pending ? [`- Accepting also makes ${from} a contact.`] : []),
        `- **What crosses:** the room's messages, both ways. Files do not.`,
        `- ${scopeWords(l, 'guest')}`,
        '- Either of you can end it at any time, and removing the contact ends it too.',
        '',
        `**To answer:** choose where your side talks${choices.includes(CHOICE.new) ? ' (**New session** starts a fresh session just for this talk)' : ''}, or tap **Decline**. Unanswered, it expires after ${DAYS} days.`,
      ].join('\n'),
      link: roomLink(l.id), actions: choices, idemKey: `consent:room:${l.id}:guest:${l.updated_at}`,
    })
    if (item) setRoomItem(db, l.id, 'guest', item.id)
  })
}

// A journal question on the guest's mirror, with its own buttons (the
// comment-actions contract): the tap comes back with `reply_to`.
function guestQuestion(ctx, l, body, actions) {
  const { db, hub } = ctx
  return safely('talk follow-up', () => {
    const out = addComment(db, { userId: l.guest_user_id, itemId: l.guest_item_id, author: 'agent', deviceId: 0, body, actions, keepStatus: true })
    if (!out) return null
    appendAndBroadcast(db, hub, {
      userId: l.guest_user_id, convoId: out.item.origin_convo_id, sender: JOURNAL, type: ITEM_EVENT_TYPE,
      payload: itemMarkerPayload({ item: out.item, action: 'commented', by: 'agent', comment: out.comment, extra: { consent: 'room' } }),
    })
    return out
  })
}

// Is `commentId` a journal question on this item? Only the journal writes
// comments on a consent mirror as device 0, so a look-alike cannot be planted.
export function talkQuestionActions(db, itemId, commentId) {
  if (typeof commentId !== 'string' || !commentId) return null
  const c = db.prepare("SELECT actions FROM item_comments WHERE id=? AND item_id=? AND kind='comment' AND device_id=0 AND author='agent'").get(commentId, itemId)
  if (!c) return null
  try { return JSON.parse(c.actions ?? '[]') } catch { return null }
}

// The tap on a follow-up's button, recorded on the thread so the app shows
// which one was chosen. Best-effort: the answer itself is already made.
export function recordFollowUpTap(ctx, who, itemId, action, replyTo) {
  safely('follow-up tap', () => addComment(ctx.db, { userId: who.userId, itemId, author: 'user', deviceId: who.deviceId, body: action, action, replyTo, keepStatus: true }))
}

// --- Outcomes ---------------------------------------------------------------

// The contact half of the owner's Send. The guest gets no separate contact
// card: the talk card covers it. `crossed` / `accepted` are the ordinary
// mutual-at-once paths.
function contactFromSend(ctx, who, c) {
  if (!c) return
  if (c.outcome === 'crossed' || c.outcome === 'accepted') { onContactOutcome(ctx, who, c); return }
  const own = c.contact
  const peer = plain(own.peer_user)
  // Their agent's own unapproved ask for us is overtaken, as with any send.
  if (c.outcome === 'sent' && c.superseded) {
    closeMirror(ctx, { userId: c.peer.user_id, itemId: c.superseded.item_id, consent: 'contact', resolution: 'cancelled', author: 'agent', comment: `${plain(c.peer.peer_user)} asked you first — answer their request instead.` })
  }
  if (c.before?.item_id) closeMirror(ctx, { userId: own.user_id, itemId: c.before.item_id, consent: 'contact', resolution: 'decided', author: 'user', deviceId: who.deviceId, comment: `Approved with a talk request — the request went to ${peer}.` })
  audit(ctx, own.user_id, { event: 'contact.requested', summary: `You asked ${peer} to be your contact`, contact: own, by: 'user' })
  if (c.outcome === 'sent' && c.peer) {
    audit(ctx, c.peer.user_id, { event: 'contact.received', summary: `${plain(c.peer.peer_user)} asked to be your contact`, contact: c.peer })
    changed(ctx, c.peer.user_id, { contact_id: c.peer.id })
  }
  changed(ctx, own.user_id, { contact_id: own.id })
}

// After answerTalkOwner. Returns the closed mirror of the card answered.
export function onTalkOwnerOutcome(ctx, who, out) {
  if (out.outcome !== 'sent') return onPersonRoomOutcome(ctx, who, out)
  const l = out.link
  const to = t(l.guest_name)
  // Exactly the same words whether or not it reaches the guest: a block is
  // not an oracle.
  const closed = closeMirror(ctx, { userId: l.owner_user_id, itemId: out.before.owner_item_id, consent: 'room', resolution: 'decided', author: 'user', deviceId: who.deviceId, comment: `Sent — ${to} has been asked to choose where to talk.` })
  contactFromSend(ctx, who, out.contact)
  roomAudit(ctx, l.owner_user_id, l, 'owner', 'room.offered', `You asked ${to} to talk`, 'you')
  if (guestSees(ctx.db, l)) {
    guestTalkAsk(ctx, l)
    roomAudit(ctx, l.guest_user_id, l, 'guest', 'room.received', `${t(l.owner_name)} asked for their agent to talk with yours`)
    changed(ctx, l.guest_user_id, { room_link_id: l.id })
  }
  changed(ctx, l.owner_user_id, { room_link_id: l.id })
  return closed
}

// After answerTalkGuest (or a start completing). Returns {closed, comment}:
// the closed mirror, or the follow-up comment the tap produced.
export function onTalkGuestOutcome(ctx, who, out) {
  const l = out.link
  if (out.contact) onContactOutcome(ctx, who, out.contact)
  switch (out.outcome) {
    case 'expired': {
      onTalkGuestExpired(ctx, out.before, out.endedContact)
      return { closed: null, comment: null }
    }
    case 'pick': {
      const q = guestQuestion(ctx, l, 'Which session should talk with them?', [...Object.keys(out.options), CHOICE.decline])
      return { comment: q?.comment ?? null }
    }
    case 'starting': {
      const q = guestQuestion(ctx, l, `Starting a new session on ${t(deviceName(ctx.db, out.target.deviceId), 80)} for this talk…`, [])
      startTalkSession(ctx, l, out.target, out.spawnId, who)
        .catch((err) => console.error('talk request: new session orchestration failed', err))
      return { comment: q?.comment ?? null }
    }
    default: {
      const closed = onPersonRoomOutcome(ctx, who, out)
      return { closed, comment: closed?.comment ?? null }
    }
  }
}

// --- New session ------------------------------------------------------------

// Ask the guest's Coordinator box to start a fresh Claude session for this
// talk (the spawn broker's `start` RPC, as an approved spawn issues it): no
// model, the box's default directory (an empty workdir), a fixed task.
// `talk: true` marks it as a talk spawn, the only kind a bridge starts with
// an empty workdir. The seam is `ctx.broker`; without one the start fails
// like any other.
export async function startTalkSession(ctx, l, target, spawnId, who) {
  const { db, hub, broker, spawnStartTimeoutMs = 30000, spawnWakeWaitMs = 0 } = ctx
  let code = null
  let convoId = null
  try {
    if (!broker) code = 'unavailable'
    else {
      if (spawnWakeWaitMs > 0) {
        let waking = false
        try { waking = wakeIfOffline(ctx, l.guest_user_id, target.deviceId) === true } catch (err) { console.error('talk request: wake threw', err) }
        if (waking) await hub.waitForDevice(l.guest_user_id, target.deviceId, spawnWakeWaitMs)
      }
      const r = await broker.issue(hub, l.guest_user_id, target.deviceId, 'start', { workdir: '', talk: true, prompt: talkTask(l), agent: 'claude' }, { timeoutMs: spawnStartTimeoutMs })
      const id = r.ok ? r.result?.convo_id : null
      if (typeof id === 'string' && id && id.length <= CONVO_ID_MAX_CHARS && sanitizePeerText(id, CONVO_ID_MAX_CHARS) === id) convoId = id
      else code = r.ok ? 'bad_start_reply' : sanitizePeerText(r.error?.code, 64) || 'unknown'
    }
  } catch (err) {
    console.error('talk request: start threw', err)
    code = 'internal'
  }
  if (convoId) {
    // The child's bridge normally announces its conversation itself; until
    // it does, the journal knows it as the talk's session on that box.
    safely('talk session row', () => {
      const cur = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(convoId)
      if (!cur) upsertConversation(db, { id: convoId, ownerUserId: l.guest_user_id, title: talkSessionTitle(l), agentDeviceId: target.deviceId })
    })
    const done = safely('talk start complete', () => completeTalkStart(db, { linkId: l.id, spawnId, deviceId: target.deviceId, convoId }))
    if (done?.outcome === 'start_failed') {
      offerAgain(ctx, done.link, "Couldn't start a session: bad_start_reply. Pick another option.")
      return 'failed'
    }
    if (done) { onTalkGuestOutcome(ctx, who, done); return 'started' }
    return 'stale'
  }
  const back = failTalkStart(db, { linkId: l.id, spawnId })
  if (back) offerAgain(ctx, back, `Couldn't start a session: ${code}. Pick another option.`)
  return 'failed'
}

// Back to the guest's choice, without New session.
function offerAgain(ctx, l, body) {
  guestQuestion(ctx, l, body, guestChoices(ctx.db, l, { withNew: false }))
}

// --- Sweep ------------------------------------------------------------------

// The guest's week ran out (the sweep, or a tap that came too late): the
// guest's card closes, the owner's agent hears 'expired', and a contact
// request the talk made ended with it.
export function onTalkGuestExpired(ctx, l, endedContact = null) {
  closeMirror(ctx, { userId: l.guest_user_id, itemId: l.guest_item_id, consent: 'room', resolution: 'cancelled', author: 'agent', comment: `Expired — no answer within ${DAYS} days.` })
  refuseToOwner(ctx, l, 'expired')
  roomAudit(ctx, l.owner_user_id, l, 'owner', 'room.expired', `${t(l.guest_name)} did not answer the talk request`)
  changed(ctx, l.owner_user_id, { room_link_id: l.id })
  talkContactEnded(ctx, endedContact)
}

// The people frames for a contact request that ended with its talk.
export function talkContactEnded(ctx, ended) {
  if (!ended) return
  changed(ctx, ended.own.user_id, { contact_id: ended.own.id })
  if (ended.peer) changed(ctx, ended.peer.user_id, { contact_id: ended.peer.id })
}

// Talk asks nobody answered: the owner's after 24 h (as any room ask), the
// guest's after TALK_GUEST_TTL_MS, and new sessions that never reported
// back. Best-effort like every sweep tail.
export function sweepTalkAsks(ctx, now = Date.now()) {
  for (const row of expirePersonRoomAsks(ctx.db, now)) onPersonRoomOutcome(ctx, null, { outcome: 'expired', link: row, before: row })
  const { expired, stuck } = expireTalkAsks(ctx.db, now)
  for (const l of expired) onTalkGuestExpired(ctx, l, l.ended_contact)
  for (const l of stuck) offerAgain(ctx, l, "Couldn't start a session: it did not report back. Pick another option.")
}

export { getPersonRoom, getItem }
