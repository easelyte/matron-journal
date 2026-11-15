import { undeliveredInvites, markDelivered, answerInvite } from './participants.js'
import { storedApproval } from './consent-subject.js'
import { isPanicLocked } from './panic.js'

// Who else hears that an invite was refused for a lock: the rooms with
// another person's agent (src/person-rooms-events.js, on one journal;
// src/federation-rooms.js, across journals) register here when they load,
// rather than this module importing them, which import it. Each hook gets
// ({db, hub}, row) for every refused row and acts only on its own rooms.
// Kept on a hoisted function, so registering works whatever order the
// modules load in.
function refusalHooks() {
  refusalHooks.list ??= []
  return refusalHooks.list
}
export function onInviteRefusedForLock(hook) {
  refusalHooks().push(hook)
}

// An approved invite that never reached its box, finished as refused
// because its account was panic-locked (src/panic.js): nothing approved
// before the lock takes effect after the clear, and the asker can ask
// again. The initiator is told `refused`, exactly as a decline tells it;
// a room with another person's agent tells that person's agent as a
// refusal by the guest does. → true when this call finished it.
function refuseInvite({ db, hub }, row) {
  if (!answerInvite(db, { convoId: row.convo_id, agentDeviceId: row.agent_device_id, accept: false })) return false
  hub.sendToDevice(row.owner_user_id, row.initiator_device_id, {
    kind: 'invite', event: 'answer', room_id: row.convo_id, peer_device_id: row.agent_device_id, accept: false, reason: 'refused',
  })
  for (const hook of refusalHooks()) {
    try {
      hook({ db, hub }, row)
    } catch (err) {
      console.error('panic: telling another person\'s agent of a refused invite failed', err)
    }
  }
  return true
}

// Every approved, undelivered invite into a box of `userId`, refused (the
// lock's own step, src/panic.js lockAccount). → how many.
export function refuseLockedInvites({ db, hub }, userId) {
  let n = 0
  for (const row of undeliveredInvites(db)) {
    if (row.owner_user_id === userId && refuseInvite({ db, hub }, row)) n += 1
  }
  return n
}

// One delivery mechanism for approved agent-chat invites, no matter who
// approved (HTTP endpoint, matron-admin) or when the target comes online.
// Called from: http approve (immediate attempt), agent hello (catch-up for
// this device), the ws sweep timer (catch-all, e.g. admin approvals while
// the target is already connected). Exactly-once per row: markDelivered's
// delivered_at IS NULL predicate makes the stamp atomic, and sendRpcRequest
// is single-socket, so a hello racing the sweep double-sends only if both
// read NULL before either stamps — serialize by stamping FIRST and undoing
// on send failure? No: send first, stamp after, accept the benign race —
// better-sqlite3 is synchronous and single-threaded per process, so two
// pump calls cannot interleave within one server.
export function deliverPendingInvites(db, hub, { deviceId = null } = {}) {
  let sent = 0
  for (const row of undeliveredInvites(db)) {
    const isJoin = row.initiator_device_id === row.agent_device_id
    const recipient = isJoin ? row.room_agent_device_id : row.agent_device_id
    if (recipient == null) continue
    if (deviceId != null && recipient !== deviceId) continue
    // A panic-locked account (src/panic.js): an invite approved before the
    // lock is finished as refused, never delivered, now or after the clear.
    if (isPanicLocked(db, row.owner_user_id)) { refuseInvite({ db, hub }, row); continue }
    // The twin of a room with another person (person-rooms.js): the
    // inviter is the other person's agent. Its box name never crosses — the
    // frame names the person instead, and says so with `person`.
    // A room for another person's agent: on this journal (a twin), or on
    // another journal (src/federation-rooms.js), named by their address.
    const person = db.prepare('SELECT u.name FROM person_rooms pr JOIN users u ON u.id = pr.owner_user_id WHERE pr.guest_room_id=?').get(row.convo_id)
      ?? db.prepare("SELECT peer_name || '@' || peer_host AS name FROM fed_rooms WHERE room_id=? AND role='guest'").get(row.convo_id)
    const from = person ? { name: person.name } : db.prepare('SELECT name FROM devices WHERE id=?').get(row.initiator_device_id)
    // approved_by: who let this ask through — 'coordinator' when the user's
    // Coordinator answered the card on their behalf (spec: 2026-09-29
    // coordinator consent), so the receiving bridge can say so rather than
    // "your user approved this". Omitted for a tap (the pre-field shape).
    const approvedBy = row.answered_by === 'coordinator' ? { approved_by: 'coordinator' } : {}
    // approval: the user's signed approval of an invite to a protected box
    // ({statement, signature} as the app sent it, src/consent-subject.js),
    // for the box to check itself. Omitted for every other invite.
    const signed = storedApproval(row.approval)
    const frame = isJoin
      ? { kind: 'invite', event: 'join_request', room_id: row.convo_id,
          from_device_id: row.initiator_device_id, from_name: from?.name ?? '', justification: row.justification, ...approvedBy, ...signed }
      : { kind: 'invite', event: 'request', room_id: row.convo_id, ...approvedBy,
          from_device_id: row.initiator_device_id, from_name: from?.name ?? '',
          topic: row.topic, justification: row.justification,
          // Which of the recipient's OWN conversations this ask was aimed at
          // — the receiving bridge binds the room to that session instead of
          // guessing at its most recently active one. Omitted (never null)
          // for a pre-3.5 requester that stored no target, so the receiver
          // can tell "not addressed" from "addressed to nothing".
          ...(row.target_convo_id ? { target_convo_id: row.target_convo_id } : {}),
          // Which of the REQUESTER's conversations is asking, so the
          // receiving bridge can key its one-room-per-pair lookup on it and
          // reuse this room when the guest later calls the inviter back
          // instead of opening a second room in the other direction. Same
          // omitted-not-null discipline as target_convo_id.
          ...(row.initiator_convo_id ? { from_convo_id: row.initiator_convo_id } : {}),
          ...(person ? { person: { name: person.name } } : {}),
          ...signed }
    if (hub.sendRpcRequest(row.owner_user_id, recipient, frame)) {
      markDelivered(db, { convoId: row.convo_id, agentDeviceId: row.agent_device_id })
      sent += 1
    }
  }
  return sent
}
