// Pure DB state for rooms between two people's agents (matron-to-matron
// sharing, phase 2: "Joint rooms"). No hub,
// cards, items or frames here — src/person-rooms-events.js owns the side
// effects. Same stance as contacts.js: every recoverable failure is a tagged
// Error the caller maps to one answer; anything else is a bug.
//
// Two things live here:
//
//   Session shares. A person lets ONE contact's agents address ONE of their
//   sessions (spec: "sessions the contact has opted to expose by name, never
//   the whole roster"). Only a shared session is listed on the contact's
//   roster, and only a shared session can be invited.
//
//   Person rooms. The journal keeps each user's events in that user's own
//   log, so a room between Alice's agent and Bob's agent is TWO conversations:
//   Alice's room (the owner room, in Alice's log) and its twin in Bob's log
//   (the guest room), created when Bob accepts. Each side's convo_agents rows
//   look exactly like a same-user room to the agents and their bridges; the
//   journal copies every text message from one room into the other under a
//   `person:<name>` sender that only it can write (person-rooms-events.js).
//
// The twin's agent_device_id is the OWNER's device: that keeps the guest
// agent a participant (so every room op it already knows works unchanged on
// the twin), keeps "only the owner may invite" true, and — since the hub
// only ever iterates the twin owner's own sockets — never reaches the
// owner's device through the twin.
import { randomBytes } from 'node:crypto'
import { newId } from './items.js'
import { getContactRaw, isMutual, peerRowOf, OWN_ASK_TTL_MS, MAX_PARKED_PER_DEVICE } from './contacts.js'
import { getMission } from './missions.js'
import { isPrivateDevice } from './db.js'
import { recordJoined } from './participants.js'

export const SHARE_STATES = ['awaiting_user', 'active', 'declined', 'revoked', 'expired']
export const ROOM_STATES = ['awaiting_owner', 'awaiting_guest', 'starting', 'invited', 'joined', 'declined', 'refused', 'withdrawn', 'left', 'expired']
export const LIVE_ROOM_STATES = ['awaiting_owner', 'awaiting_guest', 'starting', 'invited', 'joined']
const LIVE_SQL = `('${LIVE_ROOM_STATES.join("','")}')`
export const PERSON_SENDER_PREFIX = 'person:'

const fail = (code) => { throw new Error(code) }
const userName = (db, id) => db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name ?? null

// --- Session shares ---------------------------------------------------------

const shareById = (db, id) => db.prepare('SELECT * FROM session_shares WHERE id=?').get(id)

export function sessionShareRow(db, row) {
  if (!row) return null
  const contact = db.prepare('SELECT peer_user, peer_journal FROM contacts WHERE id=?').get(row.contact_id)
  const convo = db.prepare('SELECT title FROM conversations WHERE id=?').get(row.convo_id)
  return {
    id: row.id,
    convo_id: row.convo_id,
    title: convo?.title ?? '',
    contact_id: row.contact_id,
    contact: contact ? (contact.peer_journal ? `${contact.peer_user}@${contact.peer_journal}` : contact.peer_user) : null,
    state: row.state,
    requested_by: row.requested_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    revoked_at: row.revoked_at ?? null,
  }
}

// A session that can be shared: a top-level, non-system conversation of the
// user, managed by one of the user's own agent devices that is not private
// (a private box's sessions are invisible even to the user's own ordinary
// agents, so they are certainly not offered to another person).
export function shareableSession(db, userId, convoId) {
  if (typeof convoId !== 'string' || !convoId) return null
  const c = db.prepare(`SELECT c.id, c.agent_device_id FROM conversations c JOIN devices d ON d.id = c.agent_device_id
    WHERE c.id=? AND c.owner_user_id=? AND c.parent_convo_id IS NULL AND c.system IS NULL AND d.user_id = c.owner_user_id AND d.kind='agent'`).get(convoId, userId)
  if (!c) return null
  if (isPrivateDevice(db, c.agent_device_id)) fail('private_session')
  // A twin is the guest side of someone else's room, not a session.
  if (db.prepare('SELECT 1 FROM person_rooms WHERE guest_room_id=?').get(convoId)) return null
  return c
}

// The same, as a yes/no: a private session is simply not one.
export function isShareableSession(db, userId, convoId) {
  try { return !!shareableSession(db, userId, convoId) } catch { return false }
}

// Parked asks one agent device holds across contacts, grants, session
// shares and person rooms — the phase 1 cap, widened.
export function parkedPeopleAsks(db, deviceId) {
  return db.prepare(`SELECT
      (SELECT COUNT(*) FROM contacts WHERE origin_device_id=@d AND state='awaiting_user')
    + (SELECT COUNT(*) FROM grants WHERE origin_device_id=@d AND (state='awaiting_owner' OR pending_state='awaiting_owner'))
    + (SELECT COUNT(*) FROM session_shares WHERE origin_device_id=@d AND state='awaiting_user')
    + (SELECT COUNT(*) FROM person_rooms WHERE owner_device_id=@d AND state='awaiting_owner') AS n`).get({ d: deviceId }).n
}

// `by` 'agent' parks for the user's approval; 'user' (a client) is the tap.
// Throws: no_session, private_session, not_contact, pending, too_many_asks.
// Returns {outcome: 'parked'|'shared'|'existing', share}.
export function shareSession(db, { userId, convoId, contact, by, deviceId = null, now = Date.now() }) {
  return db.transaction(() => {
    const session = shareableSession(db, userId, convoId)
    if (!session) fail('no_session')
    const own = getContactRaw(db, userId, contact)
    if (!own || !isMutual(db, own)) fail('not_contact')
    const cur = db.prepare('SELECT * FROM session_shares WHERE convo_id=? AND contact_id=?').get(session.id, own.id)
    if (cur?.state === 'active') return { outcome: 'existing', share: cur }
    if (cur?.state === 'awaiting_user') fail('pending')
    if (by === 'agent' && parkedPeopleAsks(db, deviceId) >= MAX_PARKED_PER_DEVICE) fail('too_many_asks')
    const state = by === 'agent' ? 'awaiting_user' : 'active'
    let id = cur?.id
    if (cur) {
      db.prepare(`UPDATE session_shares SET state=?, requested_by=?, origin_device_id=?, item_id=NULL, updated_at=?, revoked_at=NULL WHERE id=?`)
        .run(state, by, deviceId, now, cur.id)
    } else {
      id = newId('ss')
      db.prepare(`INSERT INTO session_shares(id,user_id,convo_id,contact_id,state,requested_by,origin_device_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, userId, session.id, own.id, state, by, deviceId, now, now)
    }
    return { outcome: by === 'agent' ? 'parked' : 'shared', share: shareById(db, id) }
  })()
}

// The user's answer to their own agent's ask. null = not theirs.
// Outcomes: 'shared' | 'withdrawn' | 'expired' | 'unavailable'.
export function answerSessionShare(db, { userId, shareId, decision, now = Date.now() }) {
  return db.transaction(() => {
    const row = shareById(db, shareId)
    if (!row || row.user_id !== userId) return null
    if (row.state !== 'awaiting_user') fail('not_pending')
    const done = (outcome, state, extra = '') => {
      db.prepare(`UPDATE session_shares SET state=?, updated_at=? ${extra} WHERE id=?`).run(state, now, row.id)
      return { outcome, share: shareById(db, row.id), before: row }
    }
    if (now - row.updated_at > OWN_ASK_TTL_MS) return done('expired', 'expired')
    if (decision === 'decline') return done('withdrawn', 'declined')
    const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(row.contact_id)
    if (!isMutual(db, contact)) return done('unavailable', 'revoked', `, revoked_at=${Number(now)}`)
    return done('shared', 'active')
  })()
}

// Either an agent or a client of the sharer ends a share (it only reduces
// access). Existing rooms stand; removing the contact ends those.
export function revokeSessionShare(db, { userId, shareId, now = Date.now() }) {
  return db.transaction(() => {
    const row = shareById(db, shareId)
    if (!row || row.user_id !== userId) return null
    if (!['awaiting_user', 'active'].includes(row.state)) fail('not_active')
    db.prepare("UPDATE session_shares SET state='revoked', updated_at=?, revoked_at=? WHERE id=?").run(now, now, row.id)
    return { share: shareById(db, row.id), before: row }
  })()
}

export function listSessionShares(db, userId, { convoId = null } = {}) {
  const rows = convoId
    ? db.prepare("SELECT * FROM session_shares WHERE user_id=? AND convo_id=? AND state IN ('awaiting_user','active') ORDER BY updated_at DESC").all(userId, convoId)
    : db.prepare("SELECT * FROM session_shares WHERE user_id=? AND state IN ('awaiting_user','active') ORDER BY updated_at DESC").all(userId)
  return rows.map((r) => sessionShareRow(db, r))
}

// The sessions other people share with `viewerUserId`, for the roster:
// active shares, both contact rows active, the session's device not private
// (a box made private after the share stops being offered). Only what the
// sharer chose to show: the person, the session's title and the two ids an
// invite needs. Never a box name.
export function sessionsSharedWith(db, viewerUserId) {
  return db.prepare(`SELECT ss.convo_id, c.title, c.agent_device_id, c.session_state, c.created_at,
      sc.peer_user_id AS viewer_id, su.name AS person, su.id AS person_user_id
    FROM session_shares ss
    JOIN contacts sc ON sc.id = ss.contact_id AND sc.state='active' AND sc.peer_journal IS NULL
    JOIN contacts vc ON vc.user_id = sc.peer_user_id AND vc.peer_user_id = sc.user_id AND vc.peer_journal IS NULL AND vc.state='active'
    JOIN conversations c ON c.id = ss.convo_id AND c.owner_user_id = ss.user_id
    JOIN devices d ON d.id = c.agent_device_id AND d.user_id = ss.user_id AND d.private = 0
    JOIN users su ON su.id = ss.user_id
    WHERE ss.state='active' AND sc.peer_user_id = ?
    ORDER BY su.name COLLATE NOCASE, c.created_at DESC`).all(viewerUserId)
}

// Is `convoId` (managed by `deviceId`) a session its owner shares with
// `viewerUserId` right now? The authorisation behind a cross-person invite.
export function sharedSessionFor(db, { viewerUserId, convoId, deviceId }) {
  return sessionsSharedWith(db, viewerUserId).find((s) => s.convo_id === convoId && s.agent_device_id === deviceId) ?? null
}

export function expireSessionShareAsks(db, now = Date.now()) {
  return db.transaction(() => {
    const rows = db.prepare("SELECT * FROM session_shares WHERE state='awaiting_user' AND updated_at < ?").all(now - OWN_ASK_TTL_MS)
    for (const r of rows) db.prepare("UPDATE session_shares SET state='expired', updated_at=? WHERE id=?").run(now, r.id)
    return rows
  })()
}

export function setShareItem(db, shareId, itemId) {
  db.prepare('UPDATE session_shares SET item_id=? WHERE id=?').run(itemId, shareId)
}

// Revoke every live share between two contact rows (contact removed or
// blocked). Returns the rows as they stood.
export function revokeSharesBetween(db, contactIds, now = Date.now()) {
  const ids = contactIds.filter(Boolean)
  if (!ids.length) return []
  const marks = ids.map(() => '?').join(',')
  const rows = db.prepare(`SELECT * FROM session_shares WHERE contact_id IN (${marks}) AND state IN ('awaiting_user','active')`).all(...ids)
  if (rows.length) {
    db.prepare(`UPDATE session_shares SET state='revoked', updated_at=?, revoked_at=? WHERE contact_id IN (${marks}) AND state IN ('awaiting_user','active')`).run(now, now, ...ids)
  }
  return rows
}

// --- Person rooms -----------------------------------------------------------

const RAW = `SELECT pr.*, ou.name AS owner_name, gu.name AS guest_name,
    m.num AS mission_num, m.title AS mission_title
  FROM person_rooms pr
  JOIN users ou ON ou.id = pr.owner_user_id
  JOIN users gu ON gu.id = pr.guest_user_id
  LEFT JOIN missions m ON m.id = pr.mission_id`

export const getPersonRoom = (db, id) => (typeof id === 'string' && id.startsWith('pr_') ? db.prepare(`${RAW} WHERE pr.id=?`).get(id) ?? null : null)

// The live link a room takes part in, from either side, with which side
// that room is. null for an ordinary room. A room holds at most one live
// link (parkPersonRoom refuses a second).
export function linkOfRoom(db, roomId) {
  if (typeof roomId !== 'string' || !roomId) return null
  const owner = db.prepare(`${RAW} WHERE pr.owner_room_id=? AND pr.state IN ${LIVE_SQL} ORDER BY pr.updated_at DESC LIMIT 1`).get(roomId)
  if (owner) return { link: owner, side: 'owner' }
  const guest = db.prepare(`${RAW} WHERE pr.guest_room_id=? ORDER BY pr.updated_at DESC LIMIT 1`).get(roomId)
  if (guest) return { link: guest, side: 'guest' }
  return null
}

// Every guest room, live or ended: a twin stays a twin (no second agent,
// no re-invite through it) after the room ends.
export const isGuestRoom = (db, roomId) => !!db.prepare('SELECT 1 FROM person_rooms WHERE guest_room_id=?').get(roomId)

// The wire shape, from one side. Names the other person and the session
// titles; never a box name or the other side's device.
export function personRoomRow(link, side) {
  if (!link) return null
  const owner = side === 'owner'
  return {
    id: link.id,
    role: side,
    room_id: owner ? link.owner_room_id : link.guest_room_id,
    person: owner ? link.guest_name : link.owner_name,
    state: link.state,
    kind: link.kind ?? 'session',
    topic: link.topic,
    mission: link.mission_id ? { id: link.mission_id, num: link.mission_num, title: link.mission_title, owner: link.owner_name } : null,
    created_at: link.created_at,
    updated_at: link.updated_at,
  }
}

// A person room must be a FRESH room: everything said in it crosses to the
// other person, so it cannot be a conversation with a history of its own
// (the agent's session, a room with earlier talk). Fresh = nothing a person
// typed, no session turns, no other sender, and at most FRESH_TEXT_MAX
// messages — the opening an agent_chat_start posts before it invites. The
// room's own consent mirrors (an earlier ask on it that was declined or
// expired) are not history: they are what a re-ask renews.
//
// A session turn shows as a `running` status. The bridge creates every room
// with a `waiting` one (and marks a room it gave up on `done`), so a status
// in any other state says nothing about history; counting those refused
// every room an agent_chat_start made.
//
// `+user_id`: the unary plus keeps SQLite on idx_events_convo (the room's
// few events) instead of the events primary key (user_id, seq), which it
// otherwise prefers without ANALYZE statistics, reading every event the
// user has. On a large log that took long enough for the asking bridge to
// give up waiting for the answer.
export const FRESH_TEXT_MAX = 5
// Exported for the query-plan test.
export const FRESH_ROOM_SQL = `SELECT
      SUM(type='text') AS texts,
      SUM(type IN ('prompt_reply','file','image','milestone','summary')
        OR (type='session_status' AND COALESCE(json_extract(payload,'$.state'),'') = 'running')
        OR (type='item' AND COALESCE(json_extract(payload,'$.consent'),'') <> 'room')) AS session_like,
      SUM(type='text' AND sender <> @s) AS others
    FROM events WHERE +user_id=@u AND convo_id=@r`
export function isFreshRoom(db, { userId, roomId, ownerSender }) {
  const r = db.prepare(FRESH_ROOM_SQL).get({ u: userId, r: roomId, s: ownerSender })
  return (r.texts ?? 0) <= FRESH_TEXT_MAX && !(r.session_like > 0) && !(r.others > 0)
}

// The owner's agent asks to bring a contact's shared session into its room.
// Throws: not_found (no such target, not a contact, session not shared —
// one answer, so nothing is confirmed), room_busy (the room already has
// other members or another person), pending, too_many_asks, no_mission,
// mission_not_shared, private_box, not_fresh.
// Returns the parked row.
export function parkPersonRoom(db, { ownerUserId, roomId, ownerDeviceId, ownerSender, ownerConvoId = null, targetDeviceId, targetConvoId, missionRef = null, topic = '', justification = '', now = Date.now() }) {
  return db.transaction(() => {
    if (isPrivateDevice(db, ownerDeviceId)) fail('private_box')
    const target = db.prepare("SELECT user_id FROM devices WHERE id=? AND kind='agent'").get(targetDeviceId)
    if (!target || target.user_id === ownerUserId) fail('not_found')
    if (typeof targetConvoId !== 'string' || !targetConvoId) fail('not_found')
    if (!sharedSessionFor(db, { viewerUserId: ownerUserId, convoId: targetConvoId, deviceId: targetDeviceId })) fail('not_found')
    const own = db.prepare('SELECT * FROM contacts WHERE user_id=? AND peer_user_id=? AND peer_journal IS NULL').get(ownerUserId, target.user_id)
    if (!own || !isMutual(db, own)) fail('not_found')
    if (isGuestRoom(db, roomId)) fail('room_busy')
    // A retry of an ask still in flight is `pending`, before the twin and
    // fresh-room checks (its own mirror and twin are not history).
    const live = db.prepare(`SELECT * FROM person_rooms WHERE owner_room_id=? AND state IN ${LIVE_SQL}`).all(roomId)
    if (live.some((l) => l.guest_device_id === targetDeviceId)) fail('pending')
    if (live.length) fail('room_busy')
    // A room that already had a twin is never re-used: its old twin must
    // stay a twin (isGuestRoom), and a fresh room is one agent_chat_start
    // away.
    if (db.prepare('SELECT 1 FROM person_rooms WHERE owner_room_id=? AND guest_room_id IS NOT NULL').get(roomId)) fail('room_busy')
    if (!isFreshRoom(db, { userId: ownerUserId, roomId, ownerSender })) fail('not_fresh')
    // Exactly two agents: the guest consented to talking with this one
    // session, not to whoever else the owner later adds.
    const members = db.prepare("SELECT COUNT(*) n FROM convo_agents WHERE convo_id=? AND state IN ('awaiting_user','invited','joined')").get(roomId).n
    if (members > 0) fail('room_busy')
    if (parkedPeopleAsks(db, ownerDeviceId) >= MAX_PARKED_PER_DEVICE) fail('too_many_asks')
    let missionId = null
    if (missionRef != null) {
      const m = getMission(db, ownerUserId, missionRef, { excludePrivateOwned: true })
      if (!m) fail('no_mission')
      const g = db.prepare("SELECT 1 FROM grants WHERE subject_kind='mission' AND subject_id=? AND contact_id=? AND state='active' AND level <> 'owner'").get(m.id, own.id)
      if (!g) fail('mission_not_shared')
      missionId = m.id
    }
    const cur = db.prepare('SELECT id FROM person_rooms WHERE owner_room_id=? AND guest_device_id=?').get(roomId, targetDeviceId)
    const id = cur?.id ?? newId('pr')
    if (cur) {
      db.prepare(`UPDATE person_rooms SET owner_device_id=?, owner_convo_id=?, owner_contact_id=?, guest_user_id=?, guest_convo_id=?, guest_room_id=NULL,
          mission_id=?, state='awaiting_owner', topic=?, justification=?, owner_item_id=NULL, guest_item_id=NULL, ended_by=NULL,
          created_at=?, updated_at=?, answered_at=NULL, kind='session', contact_by_talk=0, pick_options=NULL, spawn_id=NULL WHERE id=?`)
        .run(ownerDeviceId, ownerConvoId, own.id, target.user_id, targetConvoId, missionId, topic, justification, now, now, id)
    } else {
      db.prepare(`INSERT INTO person_rooms(id,owner_user_id,owner_room_id,owner_device_id,owner_convo_id,owner_contact_id,guest_user_id,guest_device_id,guest_convo_id,
          mission_id,state,topic,justification,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'awaiting_owner',?,?,?,?)`)
        .run(id, ownerUserId, roomId, ownerDeviceId, ownerConvoId, own.id, target.user_id, targetDeviceId, targetConvoId, missionId, topic, justification, now, now)
    }
    return getPersonRoom(db, id)
  })()
}

const setRoomState = (db, id, state, now, extra = '') =>
  db.prepare(`UPDATE person_rooms SET state=?, updated_at=? ${extra} WHERE id=?`).run(state, now, id)

// Still allowed to go ahead: both contact rows active and the session
// still shared with the owner. A talk request has no share: the guest's
// consent to this one room is the share, so its target need only still be
// a session the guest could share (not private, not a twin).
export function stillAllowed(db, link) {
  const own = link.owner_contact_id ? db.prepare('SELECT * FROM contacts WHERE id=?').get(link.owner_contact_id) : null
  if (!isMutual(db, own)) return false
  if (link.kind === 'talk') {
    if (link.guest_convo_id == null) return true
    const c = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(link.guest_convo_id)
    return c?.agent_device_id === link.guest_device_id && isShareableSession(db, link.guest_user_id, link.guest_convo_id)
  }
  return !!sharedSessionFor(db, { viewerUserId: link.owner_user_id, convoId: link.guest_convo_id, deviceId: link.guest_device_id })
}

// The twin in the guest's log. Titled with the other person's name and the
// topic; session_state 'running' like any agent-made conversation.
function createGuestRoom(db, link, now) {
  const id = `room_${randomBytes(12).toString('hex')}`
  const title = `${link.owner_name}${link.topic ? ` — ${link.topic}` : ''}`.slice(0, 200)
  db.prepare(`INSERT INTO conversations(id, owner_user_id, title, session_state, created_at, agent_device_id)
    VALUES(?,?,?,'running',?,?)`).run(id, link.guest_user_id, title, now, link.owner_device_id)
  return id
}

// The guest person accepted: the twin, and the guest agent's invite into
// it, exactly a same-user owner invite (the guest agent is the
// non-initiator, so it is the one that acks and answers). Caller holds the
// transaction and has fixed the guest device and session on `link`.
export function inviteGuest(db, link, now) {
  const guestRoomId = createGuestRoom(db, link, now)
  db.prepare(`INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, justification, topic, target_convo_id, created_at)
    VALUES(?,?,?,'invited',?,?,?,?)`).run(guestRoomId, link.guest_device_id, link.owner_device_id, link.justification, link.topic, link.guest_convo_id, now)
  db.prepare(`UPDATE person_rooms SET state='invited', guest_room_id=?, updated_at=?, answered_at=? WHERE id=?`).run(guestRoomId, now, now, link.id)
  return guestRoomId
}

// One person's answer to one of the two cards. null = neither side's.
// Outcomes:
//   owner:  'sent' (now with the guest) | 'withdrawn' | 'expired' | 'unavailable'
//   guest:  'accepted' (twin created, invite queued for the guest agent) |
//           'refused' | 'unavailable'
export function answerPersonRoom(db, { userId, linkId, decision, now = Date.now() }) {
  return db.transaction(() => {
    const link = getPersonRoom(db, linkId)
    if (!link) return null
    const isOwner = link.owner_user_id === userId
    if (!isOwner && link.guest_user_id !== userId) return null
    // The guest has never been told of an ask its owner has not approved.
    if (!isOwner && !guestSees(db, link)) return null
    const done = (outcome) => ({ outcome, link: getPersonRoom(db, link.id), before: link })
    if (isOwner && link.state === 'awaiting_owner') {
      if (now - link.updated_at > OWN_ASK_TTL_MS) { setRoomState(db, link.id, 'expired', now); return done('expired') }
      if (decision === 'decline') { setRoomState(db, link.id, 'declined', now, `, answered_at=${Number(now)}, ended_by='owner'`); return done('withdrawn') }
      if (!stillAllowed(db, link)) { setRoomState(db, link.id, 'withdrawn', now, ", ended_by='contact_removed'"); return done('unavailable') }
      setRoomState(db, link.id, 'awaiting_guest', now)
      return done('sent')
    }
    if (!isOwner && link.state === 'awaiting_guest') {
      if (decision === 'decline') { setRoomState(db, link.id, 'refused', now, `, answered_at=${Number(now)}, ended_by='guest'`); return done('refused') }
      if (!stillAllowed(db, link)) { setRoomState(db, link.id, 'withdrawn', now, ", ended_by='contact_removed'"); return done('unavailable') }
      inviteGuest(db, link, now)
      return done('accepted')
    }
    fail('not_pending')
  })()
}

// The guest agent answered its invite on the twin (agent_invite_answer).
// On accept the guest device joins the owner room too — the row the owner's
// bridge sees, the same shape a same-user join leaves. Returns the link, or
// null when the room is not a twin.
export function onGuestAgentAnswer(db, { guestRoomId, accept, now = Date.now() }) {
  return db.transaction(() => {
    const link = db.prepare(`${RAW} WHERE pr.guest_room_id=? AND pr.state='invited'`).get(guestRoomId)
    if (!link) return null
    if (accept) {
      recordJoined(db, { convoId: link.owner_room_id, agentDeviceId: link.guest_device_id, initiatorDeviceId: link.owner_device_id })
      setRoomState(db, link.id, 'joined', now)
    } else {
      setRoomState(db, link.id, 'refused', now, ", ended_by='guest_agent'")
    }
    return getPersonRoom(db, link.id)
  })()
}

// End one link on both sides: the owner room's row for the guest device and
// the twin's row both read 'left' (or nothing, for a link that never got
// that far). `to` is the link's final state; `by` who ended it. Returns the
// link as it stood before, or null when it was not live.
export function endPersonRoom(db, { linkId, to = 'left', by, now = Date.now() }) {
  return db.transaction(() => {
    const link = getPersonRoom(db, linkId)
    if (!link || !LIVE_ROOM_STATES.includes(link.state)) return null
    db.prepare(`UPDATE person_rooms SET state=?, updated_at=?, ended_by=? WHERE id=?`).run(to, now, by, link.id)
    // A talk that ends before its guest chose takes its own contact request
    // with it: the guest only ever saw it on the talk's card.
    if (['awaiting_guest', 'starting'].includes(link.state)) link.ended_contact = endTalkContact(db, link, 'removed', now)
    db.prepare("UPDATE convo_agents SET state='left', answered_at=? WHERE convo_id=? AND agent_device_id=? AND state IN ('invited','joined')")
      .run(now, link.owner_room_id, link.guest_device_id)
    if (link.guest_room_id) {
      db.prepare("UPDATE convo_agents SET state='left', answered_at=? WHERE convo_id=? AND agent_device_id=? AND state IN ('invited','joined')")
        .run(now, link.guest_room_id, link.guest_device_id)
    }
    return link
  })()
}

// The contact request a talk's Send made (contact_by_talk), ended with the
// talk when the guest never chose: the owner's pending_out row and the
// guest's pending_in row both go to `to` ('expired' or 'removed'). A guest
// row the guest blocked stays theirs. Anything else (already contacts, a
// request that was not the talk's, one answered meanwhile) is left alone.
// Caller holds the transaction. Returns {own, peer} (peer null when the
// guest's row was not touched), or null.
export function endTalkContact(db, link, to, now = Date.now()) {
  if (link.kind !== 'talk' || !link.contact_by_talk) return null
  const row = (u, p) => db.prepare('SELECT * FROM contacts WHERE user_id=? AND peer_user_id=? AND peer_journal IS NULL').get(u, p)
  const own = row(link.owner_user_id, link.guest_user_id)
  if (own?.state !== 'pending_out') return null
  const theirs = row(link.guest_user_id, link.owner_user_id)
  const end = (id) => db.prepare('UPDATE contacts SET state=?, updated_at=?, revoked_at=? WHERE id=?').run(to, now, now, id)
  end(own.id)
  const touchPeer = theirs?.state === 'pending_in'
  if (touchPeer) end(theirs.id)
  return { own: { ...own, state: to }, peer: touchPeer ? { ...theirs, state: to } : null }
}

// Every live link between two people, either way round.
export function linksBetween(db, userA, userB) {
  return db.prepare(`${RAW} WHERE pr.state IN ${LIVE_SQL}
    AND ((pr.owner_user_id=@a AND pr.guest_user_id=@b) OR (pr.owner_user_id=@b AND pr.guest_user_id=@a))`).all({ a: userA, b: userB })
}

// Live links attached to a mission held through one contact row's grant.
export function linksOnGrant(db, { missionId, contactId }) {
  return db.prepare(`${RAW} WHERE pr.state IN ${LIVE_SQL} AND pr.mission_id=? AND pr.owner_contact_id=?`).all(missionId, contactId)
}

export function detachMission(db, linkId, now = Date.now()) {
  db.prepare('UPDATE person_rooms SET mission_id=NULL, updated_at=? WHERE id=?').run(now, linkId)
}

export function expirePersonRoomAsks(db, now = Date.now()) {
  return db.transaction(() => {
    const rows = db.prepare(`${RAW} WHERE pr.state='awaiting_owner' AND pr.updated_at < ?`).all(now - OWN_ASK_TTL_MS)
    for (const r of rows) setRoomState(db, r.id, 'expired', now)
    return rows
  })()
}

// The twin's invite expired with its guest agent never answering
// (expireInvites flipped its convo_agents row). Returns the link.
export function onGuestInviteExpired(db, { guestRoomId, now = Date.now() }) {
  const link = db.prepare(`${RAW} WHERE pr.guest_room_id=? AND pr.state='invited'`).get(guestRoomId)
  if (!link) return null
  setRoomState(db, link.id, 'expired', now, ", ended_by='guest_agent'")
  return link
}

export function setRoomItem(db, linkId, side, itemId) {
  db.prepare(`UPDATE person_rooms SET ${side === 'owner' ? 'owner_item_id' : 'guest_item_id'}=? WHERE id=?`).run(itemId, linkId)
}

// The rooms another person's messages reach for `viewerUserId`, keyed by
// their own room id, with that side's view. For GET /person-rooms.
export function listPersonRooms(db, userId) {
  return db.prepare(`${RAW} WHERE (pr.owner_user_id=@u OR (pr.guest_user_id=@u AND pr.state <> 'awaiting_owner')) AND pr.state IN ${LIVE_SQL}
    ORDER BY pr.updated_at DESC`).all({ u: userId })
    .filter((l) => l.owner_user_id === userId || guestSees(db, l))
    .map((l) => personRoomRow(l, l.owner_user_id === userId ? 'owner' : 'guest'))
}

// May the guest person know of this link at all? Not before the owner
// approved it, and never a talk request from someone the guest has blocked:
// it was parked and "sent" like any other (a block is not an oracle) but
// never delivered.
export function guestSees(db, link) {
  if (!link || link.state === 'awaiting_owner') return false
  if (link.kind !== 'talk') return true
  const theirs = db.prepare('SELECT state FROM contacts WHERE user_id=? AND peer_user_id=? AND peer_journal IS NULL').get(link.guest_user_id, link.owner_user_id)
  return theirs?.state !== 'blocked'
}

export { userName, peerRowOf }
