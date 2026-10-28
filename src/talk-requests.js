// Pure DB state for talk requests: a room between two people's agents asked
// for by PERSON, not by a session the other person shares (docs/protocol.md
// "Rooms between people"). Same stance as person-rooms.js, whose rows these
// are (kind 'talk'): every recoverable failure is a tagged Error the caller
// maps to one answer, and src/talk-requests-events.js owns the side effects.
//
// The whole consent is two taps:
//   1. the owner's Send on their own agent's ask, which also sends the
//      contact request when the two are not contacts yet;
//   2. the guest's choice of where their side talks (a new session, their
//      Coordinator, or one of their sessions), which also accepts that
//      contact request — or Decline, which declines it.
// No session share is created: the guest's consent to this one room is the
// share, and it lives and dies with the room.
import { newId } from './items.js'
import { requestContact, answerContact, isMutual, OWN_ASK_TTL_MS, MAX_PARKED_PER_DEVICE } from './contacts.js'
import { getMission } from './missions.js'
import { isPrivateDevice } from './db.js'
import { getCoordinatorConvoId } from './coordinator.js'
import {
  getPersonRoom, isGuestRoom, isFreshRoom, parkedPeopleAsks, inviteGuest, stillAllowed, isShareableSession, guestSees, endTalkContact, LIVE_ROOM_STATES,
} from './person-rooms.js'

// The guest's card waits a week: people take days.
export const TALK_GUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000
// A new session that never reported back (the journal restarted mid-start).
export const TALK_START_STUCK_MS = 15 * 60 * 1000
// How many of the guest's sessions "Pick a session" offers.
export const PICK_MAX = 3
export const LABEL_MAX = 40

export const OWNER_TALK_ACTIONS = ['Send', 'Cancel']
export const CHOICE = { new: 'New session', coordinator: 'My Coordinator', pick: 'Pick a session', decline: 'Decline' }

const LIVE_SQL = `('${LIVE_ROOM_STATES.join("','")}')`
const fail = (code) => { throw new Error(code) }
const contactRow = (db, userId, peerUserId) =>
  db.prepare('SELECT * FROM contacts WHERE user_id=? AND peer_user_id=? AND peer_journal IS NULL').get(userId, peerUserId) ?? null

// The guest's Coordinator conversation, when it runs on one of their own
// non-private agent devices: both "New session" (on that box) and
// "My Coordinator" need it.
export function coordinatorTarget(db, userId) {
  const id = getCoordinatorConvoId(db, userId)
  if (!id) return null
  const c = db.prepare(`SELECT c.id, c.agent_device_id FROM conversations c JOIN devices d ON d.id = c.agent_device_id
    WHERE c.id=? AND c.owner_user_id=? AND d.user_id=? AND d.kind='agent'`).get(id, userId, userId)
  if (!c || isPrivateDevice(db, c.agent_device_id)) return null
  return { convoId: c.id, deviceId: c.agent_device_id }
}

// The guest's sessions "Pick a session" offers, most recently active
// first: shareable sessions (top-level, not private, not a twin) that are
// not the Coordinator and not an agent-chat room.
export function pickableSessions(db, userId, limit = PICK_MAX) {
  const coord = getCoordinatorConvoId(db, userId)
  return db.prepare(`SELECT c.id, c.title, c.agent_device_id FROM conversations c JOIN devices d ON d.id = c.agent_device_id
    WHERE c.owner_user_id=@u AND d.user_id=@u AND d.kind='agent' AND d.private=0
      AND c.parent_convo_id IS NULL AND c.system IS NULL AND c.session_state <> 'archived'
      AND NOT EXISTS(SELECT 1 FROM person_rooms pr WHERE pr.guest_room_id = c.id OR pr.owner_room_id = c.id)
      AND NOT EXISTS(SELECT 1 FROM convo_agents ca WHERE ca.convo_id = c.id)
    ORDER BY c.last_seq DESC, c.created_at DESC`).all({ u: userId })
    .filter((c) => c.id !== coord && isShareableSession(db, userId, c.id))
    .slice(0, limit)
}

// Button labels for sessions: their titles, trimmed to LABEL_MAX and made
// unique, never colliding with the fixed choices.
export function sessionLabels(sessions) {
  const taken = new Set(Object.values(CHOICE))
  const out = {}
  for (const s of sessions) {
    const base = (String(s.title ?? '').replace(/\s+/g, ' ').trim() || 'Untitled session')
    let label = base.length > LABEL_MAX ? `${base.slice(0, LABEL_MAX - 1)}…` : base
    for (let n = 2; taken.has(label); n++) {
      const suffix = ` (${n})`
      const room = LABEL_MAX - suffix.length
      label = `${base.length > room ? `${base.slice(0, room - 1)}…` : base}${suffix}`
    }
    taken.add(label)
    out[label] = s.id
  }
  return out
}

// What the guest's card offers, in order, each only when available.
export function guestChoices(db, link, { withNew = true } = {}) {
  const coord = coordinatorTarget(db, link.guest_user_id)
  return [
    ...(coord && withNew ? [CHOICE.new] : []),
    ...(coord ? [CHOICE.coordinator] : []),
    ...(pickableSessions(db, link.guest_user_id, 1).length ? [CHOICE.pick] : []),
    CHOICE.decline,
  ]
}

// Is the guest's acceptance also going to make the two contacts?
export function contactPending(db, link) {
  const own = link.owner_contact_id
    ? db.prepare('SELECT * FROM contacts WHERE id=?').get(link.owner_contact_id)
    : contactRow(db, link.owner_user_id, link.guest_user_id)
  return !isMutual(db, own)
}

// The owner's agent asks to talk with `person` in its room. Throws:
// not_found (unknown, self, unlisted, or a person the owner has blocked —
// one answer), pending (a live talk from this device to this person),
// room_busy, not_fresh, too_many_asks, no_mission, mission_not_shared,
// private_box. Returns the parked row.
export function parkTalk(db, { ownerUserId, roomId, ownerDeviceId, ownerSender, ownerConvoId = null, person, missionRef = null, topic = '', justification = '', now = Date.now() }) {
  return db.transaction(() => {
    if (isPrivateDevice(db, ownerDeviceId)) fail('private_box')
    const peer = typeof person === 'string' && person ? db.prepare('SELECT id, unlisted FROM users WHERE name=?').get(person) : null
    const me = db.prepare('SELECT unlisted FROM users WHERE id=?').get(ownerUserId)
    if (!peer || peer.id === ownerUserId || peer.unlisted || me?.unlisted) fail('not_found')
    const own = contactRow(db, ownerUserId, peer.id)
    if (own?.state === 'blocked') fail('not_found')
    // A retry, from this room or another of this device's, is pending.
    const mine = db.prepare(`SELECT 1 FROM person_rooms WHERE kind='talk' AND owner_device_id=? AND guest_user_id=? AND state IN ${LIVE_SQL}`).get(ownerDeviceId, peer.id)
    if (mine) fail('pending')
    if (isGuestRoom(db, roomId)) fail('room_busy')
    if (db.prepare(`SELECT 1 FROM person_rooms WHERE owner_room_id=? AND state IN ${LIVE_SQL}`).get(roomId)) fail('room_busy')
    if (db.prepare('SELECT 1 FROM person_rooms WHERE owner_room_id=? AND guest_room_id IS NOT NULL').get(roomId)) fail('room_busy')
    if (!isFreshRoom(db, { userId: ownerUserId, roomId, ownerSender })) fail('not_fresh')
    const members = db.prepare("SELECT COUNT(*) n FROM convo_agents WHERE convo_id=? AND state IN ('awaiting_user','invited','joined')").get(roomId).n
    if (members > 0) fail('room_busy')
    if (parkedPeopleAsks(db, ownerDeviceId) >= MAX_PARKED_PER_DEVICE) fail('too_many_asks')
    let missionId = null
    if (missionRef != null) {
      const m = getMission(db, ownerUserId, missionRef, { excludePrivateOwned: true })
      if (!m) fail('no_mission')
      // A mission needs an active grant to an existing contact — one that
      // lets them read it: a hand-over's owner-level row stays active but
      // confers nothing (the same rule as parkPersonRoom).
      const g = own && isMutual(db, own)
        ? db.prepare("SELECT 1 FROM grants WHERE subject_kind='mission' AND subject_id=? AND contact_id=? AND state='active' AND level <> 'owner'").get(m.id, own.id)
        : null
      if (!g) fail('mission_not_shared')
      missionId = m.id
    }
    const contactId = own && isMutual(db, own) ? own.id : null
    const cur = db.prepare("SELECT id FROM person_rooms WHERE owner_room_id=? AND kind='talk' AND guest_user_id=?").get(roomId, peer.id)
    const id = cur?.id ?? newId('pr')
    if (cur) {
      db.prepare(`UPDATE person_rooms SET owner_device_id=?, owner_convo_id=?, owner_contact_id=?, guest_device_id=NULL, guest_convo_id=NULL, guest_room_id=NULL,
          mission_id=?, state='awaiting_owner', topic=?, justification=?, owner_item_id=NULL, guest_item_id=NULL, ended_by=NULL,
          contact_by_talk=0, pick_options=NULL, spawn_id=NULL, created_at=?, updated_at=?, answered_at=NULL WHERE id=?`)
        .run(ownerDeviceId, ownerConvoId, contactId, missionId, topic, justification, now, now, id)
    } else {
      db.prepare(`INSERT INTO person_rooms(id,owner_user_id,owner_room_id,owner_device_id,owner_convo_id,owner_contact_id,guest_user_id,
          mission_id,state,topic,justification,created_at,updated_at,kind)
        VALUES(?,?,?,?,?,?,?,?,'awaiting_owner',?,?,?,?,'talk')`)
        .run(id, ownerUserId, roomId, ownerDeviceId, ownerConvoId, contactId, peer.id, missionId, topic, justification, now, now)
    }
    return getPersonRoom(db, id)
  })()
}

const setState = (db, id, state, now, extra = '') =>
  db.prepare(`UPDATE person_rooms SET state=?, updated_at=? ${extra} WHERE id=?`).run(state, now, id)

// The contact request the owner's Send makes, as the owner's OWN ask
// (contacts.js): `sent`, `crossed`/`accepted` (mutual at once) or `silent`
// (the guest blocked the owner — it reads exactly like `sent`). null when
// the two are already contacts or a request of the owner's is already out.
// Caller holds the transaction.
function contactForTalk(db, link, now) {
  const own = contactRow(db, link.owner_user_id, link.guest_user_id)
  if (own && isMutual(db, own)) return { contact: own, out: null }
  if (own?.state === 'pending_out') return { contact: own, out: null }
  if (own?.state === 'blocked') fail('blocked')
  // An ask the owner's own agent parked for the same person: the Send is
  // the owner's approval of it.
  const out = own?.state === 'awaiting_user'
    ? answerContact(db, { userId: link.owner_user_id, contactId: own.id, decision: 'approve', now })
    : requestContact(db, { userId: link.owner_user_id, peerName: link.guest_name, by: 'user', now })
  return { contact: out.contact, out }
}

// The owner's tap on their own agent's talk ask. null = not theirs.
// Outcomes: 'sent' (with `contact`, the contact outcome or null) |
// 'withdrawn' | 'expired' | 'unavailable'.
export function answerTalkOwner(db, { userId, linkId, decision, now = Date.now() }) {
  return db.transaction(() => {
    const link = getPersonRoom(db, linkId)
    if (!link || link.kind !== 'talk' || link.owner_user_id !== userId) return null
    if (link.state !== 'awaiting_owner') fail('not_pending')
    const done = (outcome, extra = {}) => ({ outcome, link: getPersonRoom(db, link.id), before: link, ...extra })
    if (now - link.updated_at > OWN_ASK_TTL_MS) { setState(db, link.id, 'expired', now); return done('expired') }
    if (decision === 'decline') { setState(db, link.id, 'declined', now, `, answered_at=${Number(now)}, ended_by='owner'`); return done('withdrawn') }
    let c
    try { c = contactForTalk(db, link, now) } catch (err) {
      if (['blocked', 'no_user', 'pending', 'pending_in', 'not_pending'].includes(err.message)) {
        setState(db, link.id, 'withdrawn', now, ", ended_by='contact_removed'")
        return done('unavailable')
      }
      throw err
    }
    const byTalk = c.out && (c.out.outcome === 'sent' || c.out.outcome === 'silent') ? 1 : 0
    db.prepare("UPDATE person_rooms SET state='awaiting_guest', owner_contact_id=?, contact_by_talk=?, updated_at=? WHERE id=?")
      .run(c.contact.id, byTalk, now, link.id)
    return done('sent', { contact: c.out })
  })()
}

// The guest's pending contact request from the owner, accepted with the
// choice (the ordinary accept). Returns the contact outcome or null.
function acceptContactForTalk(db, link, now) {
  const theirs = contactRow(db, link.guest_user_id, link.owner_user_id)
  if (theirs?.state !== 'pending_in') return null
  return answerContact(db, { userId: link.guest_user_id, contactId: theirs.id, decision: 'approve', now })
}

// May the guest's side talk from this conversation? One of their own
// shareable sessions (not private, not a twin) on `deviceId`, and not a
// room of any kind: an agent-chat room or a room with another person is
// not a session to bring into a new room. The same set "Pick a session"
// offers, so a choice made over HTTP cannot reach further than the buttons.
export function isTalkTarget(db, userId, convoId, deviceId) {
  if (typeof convoId !== 'string' || !convoId) return false
  const c = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(convoId)
  if (!c || c.agent_device_id !== deviceId) return false
  if (!isShareableSession(db, userId, convoId)) return false
  if (db.prepare('SELECT 1 FROM person_rooms WHERE owner_room_id=? OR guest_room_id=?').get(convoId, convoId)) return false
  if (db.prepare('SELECT 1 FROM convo_agents WHERE convo_id=?').get(convoId)) return false
  return true
}

// Resolve the guest's choice to a target {deviceId, convoId}, or throw
// not_available. `choice` is 'coordinator' or {convoId}.
function targetOf(db, link, choice) {
  if (choice === 'coordinator') {
    const t = coordinatorTarget(db, link.guest_user_id)
    if (!t) fail('not_available')
    return t
  }
  const convoId = choice?.convoId
  const c = typeof convoId === 'string' && convoId ? db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(convoId) : null
  if (!c || !isTalkTarget(db, link.guest_user_id, convoId, c.agent_device_id)) fail('not_available')
  return { deviceId: c.agent_device_id, convoId }
}

// Accept onto a target, in one transaction: the contact request (if one is
// pending), the guest session fixed on the row, then exactly the
// session-room guest accept (twin, invite). Caller holds the transaction.
// The target is checked FIRST: a tap that cannot land changes nothing, the
// contact request included.
function acceptOnto(db, link, target, now) {
  if (!isTalkTarget(db, link.guest_user_id, target.convoId, target.deviceId)) fail('not_available')
  const contact = acceptContactForTalk(db, link, now)
  // An earlier ask in this room that ended without a twin may hold the same
  // guest device (UNIQUE(owner_room_id, guest_device_id)). A re-ask renews
  // such a row (parkPersonRoom); here this talk replaces it.
  db.prepare(`DELETE FROM person_rooms WHERE owner_room_id=? AND guest_device_id=? AND id<>? AND guest_room_id IS NULL AND state NOT IN ${LIVE_SQL}`)
    .run(link.owner_room_id, target.deviceId, link.id)
  db.prepare('UPDATE person_rooms SET guest_device_id=?, guest_convo_id=?, spawn_id=NULL, updated_at=? WHERE id=?').run(target.deviceId, target.convoId, now, link.id)
  const fixed = getPersonRoom(db, link.id)
  if (!stillAllowed(db, fixed)) {
    setState(db, link.id, 'withdrawn', now, ", ended_by='contact_removed'")
    return { outcome: 'unavailable', contact }
  }
  inviteGuest(db, fixed, now)
  return { outcome: 'accepted', contact }
}

// The guest's tap. `choice`: 'decline' | 'coordinator' | 'pick' | 'new' |
// {convoId}. null = not theirs (or not theirs to see). Outcomes:
//   'refused'     declined (and the talk's own contact request with it)
//   'pick'        `options` (label -> convo id) stored for the follow-up
//   'starting'    a new session is to be started on `target.deviceId`
//   'accepted'    the twin and invite exist, the guest agent is asked
//   'unavailable' the contact ended under it
export function answerTalkGuest(db, { userId, linkId, choice, now = Date.now() }) {
  return db.transaction(() => {
    const link = getPersonRoom(db, linkId)
    if (!link || link.kind !== 'talk' || link.guest_user_id !== userId || !guestSees(db, link)) return null
    if (link.state !== 'awaiting_guest') fail('not_pending')
    const done = (outcome, extra = {}) => ({ outcome, link: getPersonRoom(db, link.id), before: link, ...extra })
    // Past its week: the same answer the sweep gives, committed here.
    if (now - link.updated_at > TALK_GUEST_TTL_MS) {
      setState(db, link.id, 'expired', now, ", ended_by='guest'")
      return done('expired', { endedContact: endTalkContact(db, link, 'expired', now) })
    }
    if (choice === 'decline') {
      setState(db, link.id, 'refused', now, `, answered_at=${Number(now)}, ended_by='guest'`)
      let contact = null
      const theirs = contactRow(db, link.guest_user_id, link.owner_user_id)
      if (link.contact_by_talk && theirs?.state === 'pending_in') {
        contact = answerContact(db, { userId: link.guest_user_id, contactId: theirs.id, decision: 'decline', now })
      }
      return done('refused', { contact })
    }
    if (choice === 'pick') {
      const options = sessionLabels(pickableSessions(db, userId))
      if (!Object.keys(options).length) fail('not_available')
      db.prepare('UPDATE person_rooms SET pick_options=? WHERE id=?').run(JSON.stringify(options), link.id)
      return done('pick', { options })
    }
    if (choice === 'new') {
      const coord = coordinatorTarget(db, userId)
      if (!coord) fail('not_available')
      // Nothing about the contact or the row's guest changes until the
      // session has started (completeTalkStart).
      const spawnId = newId('tsp')
      db.prepare("UPDATE person_rooms SET state='starting', spawn_id=?, updated_at=? WHERE id=?").run(spawnId, now, link.id)
      return done('starting', { target: coord, spawnId })
    }
    const r = acceptOnto(db, link, targetOf(db, link, choice), now)
    return done(r.outcome, { contact: r.contact })
  })()
}

// The started session is the guest target. null when the row moved on
// meanwhile (ended, or a stale start).
export function completeTalkStart(db, { linkId, spawnId, deviceId, convoId, now = Date.now() }) {
  return db.transaction(() => {
    const link = getPersonRoom(db, linkId)
    if (!link || link.state !== 'starting' || link.spawn_id !== spawnId) return null
    // The reply named something that is not a fresh session of theirs on
    // that box: a failed start, back to the guest's choice.
    if (!isTalkTarget(db, link.guest_user_id, convoId, deviceId)) {
      setState(db, link.id, 'awaiting_guest', now, ', spawn_id=NULL')
      return { outcome: 'start_failed', link: getPersonRoom(db, link.id), before: link }
    }
    const r = acceptOnto(db, { ...link }, { deviceId, convoId }, now)
    return { outcome: r.outcome, contact: r.contact, link: getPersonRoom(db, link.id), before: link }
  })()
}

// The start failed: back to waiting on the guest's choice. null when the
// row moved on meanwhile.
export function failTalkStart(db, { linkId, spawnId, now = Date.now() }) {
  const r = db.prepare("UPDATE person_rooms SET state='awaiting_guest', spawn_id=NULL, updated_at=? WHERE id=? AND state='starting' AND spawn_id=?").run(now, linkId, spawnId)
  return r.changes ? getPersonRoom(db, linkId) : null
}

// The guest's own label for a follow-up session button, from the row.
export function pickedConvo(link, label) {
  try { return JSON.parse(link.pick_options ?? '{}')?.[label] ?? null } catch { return null }
}

// Talk asks nobody answered: the guest's card after TALK_GUEST_TTL_MS
// (the owner's 24 h is person-rooms.js's sweep, shared with session rooms),
// and a start that never came back after TALK_START_STUCK_MS (returned
// separately: it goes back to the guest, not to expiry).
export function expireTalkAsks(db, now = Date.now()) {
  return db.transaction(() => {
    const expired = db.prepare("SELECT id FROM person_rooms WHERE kind='talk' AND state='awaiting_guest' AND updated_at < ?").all(now - TALK_GUEST_TTL_MS)
      .map((r) => getPersonRoom(db, r.id))
    for (const r of expired) {
      setState(db, r.id, 'expired', now, ", ended_by='guest'")
      r.ended_contact = endTalkContact(db, r, 'expired', now)
    }
    const stuck = db.prepare("SELECT id, spawn_id FROM person_rooms WHERE kind='talk' AND state='starting' AND updated_at < ?").all(now - TALK_START_STUCK_MS)
      .map((r) => failTalkStart(db, { linkId: r.id, spawnId: r.spawn_id, now })).filter(Boolean)
    return { expired, stuck }
  })()
}
