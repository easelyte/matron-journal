import { undeliveredInvites, markDelivered } from './participants.js'

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
    const from = db.prepare('SELECT name FROM devices WHERE id=?').get(row.initiator_device_id)
    const frame = isJoin
      ? { kind: 'invite', event: 'join_request', room_id: row.convo_id,
          from_device_id: row.initiator_device_id, from_name: from?.name ?? '', justification: row.justification }
      : { kind: 'invite', event: 'request', room_id: row.convo_id,
          from_device_id: row.initiator_device_id, from_name: from?.name ?? '',
          topic: row.topic, justification: row.justification,
          // Which of the recipient's OWN conversations this ask was aimed at
          // — the receiving bridge binds the room to that session instead of
          // guessing at its most recently active one. Omitted (never null)
          // for a pre-3.5 requester that stored no target, so the receiver
          // can tell "not addressed" from "addressed to nothing".
          ...(row.target_convo_id ? { target_convo_id: row.target_convo_id } : {}) }
    if (hub.sendRpcRequest(row.owner_user_id, recipient, frame)) {
      markDelivered(db, { convoId: row.convo_id, agentDeviceId: row.agent_device_id })
      sent += 1
    }
  }
  return sent
}
