// Coordinator consent approval (spec: matron-bridge
// docs/superpowers/specs/2026-09-29-coordinator-consent-design.md). The
// user's Coordinator may list and answer the parked chat and spawn asks
// that otherwise wait for a tap — under guardrails the journal enforces:
// the off switch (user_settings.coordinator_consent), a reason on every
// decision, a rolling 24 h cap on approvals, and no spawn approval into a
// box that is offline and cannot be woken. This module is the DB half
// (settings, the unified pending list, the decision record, the nudge);
// consent-answer.js applies a decision, consent-http.js owns the routes.
import { sanitizePeerText, PEER_NAME_CAP } from './peer-text.js'
import { getCoordinatorConvoId } from './coordinator.js'
import { isWakeableBoxName } from './wake.js'

export const CONSENT_REASON_MAX = 200
export const CONSENT_DAILY_CAP_DEFAULT = 20
export const CONSENT_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000
export const CONSENT_KINDS = new Set(['chat', 'spawn'])
export const CONSENT_DECISIONS = new Set(['approve', 'decline'])
export const CONSENT_DECISION_EVENT_TYPE = 'consent_decision'

// The off switch. No row, or a row from before the column, reads as ON —
// the default Dan chose (2026-09-29): the Coordinator approves unless told
// not to.
export function getConsentEnabled(db, userId) {
  const row = db.prepare('SELECT coordinator_consent FROM user_settings WHERE user_id=?').get(userId)
  return row ? Number(row.coordinator_consent) !== 0 : true
}

export function setConsentEnabled(db, userId, on, now = Date.now()) {
  db.prepare(`INSERT INTO user_settings(user_id, coordinator_consent, updated_at) VALUES(?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET coordinator_consent=excluded.coordinator_consent, updated_at=excluded.updated_at`)
    .run(userId, on ? 1 : 0, now)
}

// A chat ask is keyed (room, target device) — the same pair the consent
// link `matron://consent/chat/<room>/<device>` carries — so the tool-facing
// id is `<room_id>/<target_device_id>`; the LAST slash splits it (a room id
// never contains one, but a stranger's input might).
export const chatAskId = (roomId, targetDeviceId) => `${roomId}/${targetDeviceId}`
export function parseChatAskId(id) {
  if (typeof id !== 'string') return null
  const at = id.lastIndexOf('/')
  if (at <= 0 || at === id.length - 1) return null
  const dev = Number(id.slice(at + 1))
  if (!Number.isInteger(dev) || dev < 0) return null
  return { roomId: id.slice(0, at), targetDeviceId: dev }
}

// online: a live registered socket; asleep: no socket, but the box can be
// woken (a waker is configured and the device is a wakeable agent box);
// offline: neither — the state a spawn approval refuses on.
export function deviceState({ db, hub, waker }, userId, deviceId) {
  if (!Number.isInteger(deviceId)) return 'offline'
  const online = hub.connsOf(userId).some((c) => c.deviceId === deviceId && c.ws.readyState === 1)
  if (online) return 'online'
  const dev = db.prepare('SELECT name, kind FROM devices WHERE id=? AND user_id=?').get(deviceId, userId)
  if (waker?.enabled && dev && dev.kind === 'agent' && isWakeableBoxName(dev.name)) return 'asleep'
  return 'offline'
}

const name = (raw) => (raw == null ? '' : sanitizePeerText(raw, PEER_NAME_CAP))

// Every ask awaiting this user's decision, both tables, oldest first. The
// shape is what the Coordinator's consent_list renders and what the nudge
// frame carries: enough to decide without opening the card, all of it
// peer text already sanitised at the ws boundary (names re-sieved here as
// the pending endpoint does).
export function listPendingAsks({ db, hub, waker }, userId) {
  const spawns = db.prepare(`
    SELECT r.id, r.from_device_id, r.from_convo_id, r.target_device_id, r.workdir, r.task, r.topic, r.model, r.link, r.mission_num, r.created_at,
           fd.name AS from_name, td.name AS target_name, fc.title AS from_convo_title, i.num AS item_num
    FROM agent_spawn_requests r
    LEFT JOIN devices fd ON fd.id = r.from_device_id
    LEFT JOIN devices td ON td.id = r.target_device_id
    LEFT JOIN conversations fc ON fc.id = r.from_convo_id
    LEFT JOIN items i ON i.id = r.item_id
    WHERE r.user_id=? AND r.state='awaiting_user'
  `).all(userId).map((r) => ({
    kind: 'spawn', id: r.id, created_at: r.created_at,
    from_device_id: r.from_device_id, from_name: name(r.from_name), from_convo_id: r.from_convo_id, from_convo_title: name(r.from_convo_title),
    target_device_id: r.target_device_id, target_name: name(r.target_name), target_state: deviceState({ db, hub, waker }, userId, r.target_device_id),
    workdir: r.workdir, task: r.task, topic: r.topic || '',
    ...(r.model ? { model: r.model } : {}),
    ...(r.link ? { link: true } : {}),
    ...(r.mission_num ? { mission_num: r.mission_num } : {}),
    ...(r.item_num != null ? { item_num: r.item_num } : {}),
  }))
  const chats = db.prepare(`
    SELECT ca.convo_id, ca.agent_device_id, ca.initiator_device_id, ca.initiator_convo_id, ca.target_convo_id, ca.justification, ca.topic, ca.created_at,
           c.title AS room_title, c.agent_device_id AS room_owner_id,
           di.name AS initiator_name, dt.name AS agent_name, od.name AS owner_name,
           ic.title AS initiator_convo_title, tc.title AS target_convo_title, i.num AS item_num
    FROM convo_agents ca JOIN conversations c ON c.id = ca.convo_id
    LEFT JOIN devices di ON di.id = ca.initiator_device_id AND di.user_id = c.owner_user_id
    LEFT JOIN devices dt ON dt.id = ca.agent_device_id AND dt.user_id = c.owner_user_id
    LEFT JOIN devices od ON od.id = c.agent_device_id AND od.user_id = c.owner_user_id
    LEFT JOIN conversations ic ON ic.id = ca.initiator_convo_id
    LEFT JOIN conversations tc ON tc.id = ca.target_convo_id
    LEFT JOIN items i ON i.id = ca.item_id
    WHERE ca.state='awaiting_user' AND c.owner_user_id=?
  `).all(userId).map((r) => {
    const join = r.initiator_device_id === r.agent_device_id
    // Who is being asked: the invitee, or (for a join) the room's owner.
    const askedDevice = join ? r.room_owner_id : r.agent_device_id
    return {
      kind: 'chat', id: chatAskId(r.convo_id, r.agent_device_id), created_at: r.created_at,
      request: join ? 'join' : 'invite', room_id: r.convo_id, room_title: name(r.room_title), target_device_id: r.agent_device_id,
      from_device_id: r.initiator_device_id, from_name: name(r.initiator_name),
      from_convo_id: r.initiator_convo_id || '', from_convo_title: name(r.initiator_convo_title),
      to_device_id: askedDevice, to_name: name(join ? r.owner_name : r.agent_name),
      to_convo_id: r.target_convo_id || '', to_convo_title: name(r.target_convo_title),
      target_state: deviceState({ db, hub, waker }, userId, askedDevice),
      topic: r.topic || '', justification: r.justification,
      ...(r.item_num != null ? { item_num: r.item_num } : {}),
    }
  })
  return [...spawns, ...chats].sort((a, b) => a.created_at - b.created_at)
}

// One row per Coordinator decision: the audit record and the daily cap's
// counter. Never written for a user's own tap.
export function recordConsentDecision(db, { userId, kind, askId, decision, convoId, reason, now = Date.now() }) {
  db.prepare('INSERT INTO consent_decisions(user_id, kind, ask_id, decision, convo_id, reason, created_at) VALUES(?,?,?,?,?,?,?)')
    .run(userId, kind, askId, decision, convoId, reason, now)
}

export function coordinatorApprovalsSince(db, userId, since) {
  return db.prepare("SELECT COUNT(*) c FROM consent_decisions WHERE user_id=? AND decision='approve' AND created_at>?").get(userId, since).c
}

// The Coordinator's own box, or null when none is set / its conversation
// has no box.
export function coordinatorDevice(db, userId) {
  const convoId = getCoordinatorConvoId(db, userId)
  if (!convoId) return null
  const row = db.prepare('SELECT agent_device_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
  return row?.agent_device_id != null ? { convoId, deviceId: row.agent_device_id } : null
}

// Tell the Coordinator's bridge that an ask just parked so it can decide
// promptly (the card still reaches the user first — it was journaled before
// this fires). Skipped for the Coordinator's own asks (its tool reply
// already says so), when the switch is off, and when no Coordinator is set.
// Ephemeral: a bridge that is asleep learns about the ask from consent_list
// at its next sweep instead. Never throws.
export function nudgeCoordinator({ db, hub, waker = null }, userId, ask, { askerConvoId = null, askerDeviceId = null } = {}) {
  try {
    if (!getConsentEnabled(db, userId)) return false
    const coord = coordinatorDevice(db, userId)
    if (!coord) return false
    if (askerConvoId != null ? askerConvoId === coord.convoId : askerDeviceId === coord.deviceId) return false
    const full = listPendingAsks({ db, hub, waker }, userId).find((a) => a.kind === ask.kind && a.id === ask.id)
    if (!full) return false
    hub.sendToDevice(userId, coord.deviceId, { kind: 'consent', event: 'pending', ask: full })
    return true
  } catch (err) {
    console.error('consent: nudge failed (the ask stands)', err)
    return false
  }
}
