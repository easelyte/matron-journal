// Agent-to-agent file transfers, the DB half: rows, the guarded state
// machine, the per-user quota and where chunk bytes live on disk. No hub,
// cards or HTTP here (src/transfers-http.js owns the routes).
//
// A transfer is one file a session sends into a room it belongs to. Its row
// moves along three axes at once:
//   consent  awaiting_user -> approved | declined        (the user's card)
//   upload   uploading     -> uploaded | failed          (the sender's chunks)
//   phase    open -> released -> delivered, or a terminal end
//            (expired | cancelled | failed | declined)
// Bytes are stored as fixed-size chunks under <mediaDir>/transfers/<id>/<n>,
// never assembled: a download streams them in order.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { joinedAgentIds } from './participants.js'

// 32 MiB: every chunk body stays far below the 100 MB request-body limit a
// fronting proxy may enforce.
export const TRANSFER_CHUNK_BYTES = 33554432
export const TRANSFER_MAX_BYTES_DEFAULT = 10737418240 // 10 GB per file
export const TRANSFER_USER_QUOTA_BYTES_DEFAULT = 21474836480 // 20 GB per user
// How many of one sender device's transfers may wait on the user's card at
// once (consent awaiting_user, phase open); the next create is refused.
export const TRANSFER_MAX_AWAITING_PER_SENDER_DEFAULT = 50

export const TRANSFER_STATES = Object.freeze({
  consent: Object.freeze(['awaiting_user', 'approved', 'declined']),
  upload: Object.freeze(['uploading', 'uploaded', 'failed']),
  phase: Object.freeze(['open', 'released', 'delivered', 'expired', 'cancelled', 'failed', 'declined']),
})
// Phases still waiting to be collected: they accept state changes and can
// expire. A delivered transfer is no longer live, but its bytes stay on
// disk for TRANSFER_DELIVERED_GRACE_MS, so it keeps its quota reservation
// until retention deletes them (reservedTransferBytes).
export const LIVE_PHASES = Object.freeze(['open', 'released'])
export const isTerminalPhase = (phase) => !LIVE_PHASES.includes(phase)

// How long a delivered transfer can still be downloaded again (a receiver
// that crashed between its verify and its own write), and when retention
// deletes the journal's copy.
export const TRANSFER_DELIVERED_GRACE_MS = 3600000

// How long an open or released transfer waits, uncollected, before
// retention gives up on it (runExpireTransfers).
export const TRANSFER_EXPIRE_MS = 7 * 86400000

export const SCAN_VERDICTS = Object.freeze(['clean', 'flagged', 'not_scanned'])

// The allowed prior states for each target value. A move to the value the
// row already holds is never allowed, so a second identical call is a
// no-op false (the "exactly once" a racing release or answer relies on).
const TRANSITIONS = {
  consent: { approved: ['awaiting_user'], declined: ['awaiting_user'] },
  upload: { uploaded: ['uploading'], failed: ['uploading'] },
  phase: {
    released: ['open'],
    delivered: ['released'],
    expired: ['open', 'released', 'delivered'],
    cancelled: ['open', 'released'],
    failed: ['open', 'released'],
    declined: ['open'],
  },
}
// Columns a patch may set besides the three state axes.
const PATCH_COLUMNS = new Set(['item_id', 'decided_by', 'decided_reason', 'approved_at', 'uploaded_at', 'released_at', 'delivered_at', 'deleted_at'])

const ID_RE = /^tr_[0-9a-f]{32}$/
export const isTransferId = (id) => typeof id === 'string' && ID_RE.test(id)

export function chunkCount(size, chunkBytes = TRANSFER_CHUNK_BYTES) {
  return Math.ceil(size / chunkBytes)
}

// The exact byte length chunk `n` must have.
export function expectedChunkSize(size, n, chunkBytes = TRANSFER_CHUNK_BYTES) {
  return Math.min(chunkBytes, size - n * chunkBytes)
}

export function transferDir(mediaDir, id) {
  if (!isTransferId(id)) throw new Error('bad transfer id')
  return path.join(mediaDir, 'transfers', id)
}

export function transferChunkPath(mediaDir, id, n) {
  if (!Number.isInteger(n) || n < 0) throw new Error('bad chunk number')
  return path.join(transferDir(mediaDir, id), String(n))
}

export function deleteTransferFiles(mediaDir, id) {
  fs.rmSync(transferDir(mediaDir, id), { recursive: true, force: true })
}

export function createTransfer(db, { userId, roomId, senderDeviceId, recipientDeviceId = null, fromConvoId, name, size, sha256, contentType, reason = '', scan = { verdict: 'not_scanned', findings: [] }, causes = null, now = Date.now() }) {
  const id = `tr_${crypto.randomBytes(16).toString('hex')}`
  db.prepare(`INSERT INTO transfers(id, user_id, room_id, sender_device_id, recipient_device_id, from_convo_id, name, size, sha256, content_type, reason, scan_verdict, scan_findings, causes, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, userId, roomId, senderDeviceId, recipientDeviceId, fromConvoId, name, size, sha256, contentType, reason, scan.verdict, JSON.stringify(scan.findings ?? []), causes ? JSON.stringify(causes) : null, now)
  return getTransfer(db, id)
}

export function getTransfer(db, id) {
  return db.prepare('SELECT * FROM transfers WHERE id=?').get(id)
}

export function recordChunk(db, id, n, size = 0) {
  db.prepare('INSERT INTO transfer_chunks(transfer_id, n, size) VALUES(?,?,?) ON CONFLICT(transfer_id, n) DO UPDATE SET size=excluded.size')
    .run(id, n, size)
}

export function receivedChunks(db, id) {
  return db.prepare('SELECT n FROM transfer_chunks WHERE transfer_id=? ORDER BY n').all(id).map((r) => r.n)
}

export function forgetChunks(db, id) {
  db.prepare('DELETE FROM transfer_chunks WHERE transfer_id=?').run(id)
}

// Declared bytes of the user's transfers that still hold or will hold
// files: reserved at create; kept through a delivered transfer's grace
// period (its bytes are still on disk until retention stamps deleted_at);
// released when any other phase ends it.
export function reservedTransferBytes(db, userId) {
  return db.prepare(`SELECT COALESCE(SUM(size), 0) AS n FROM transfers WHERE user_id=?
    AND (phase IN ('${LIVE_PHASES.join("','")}') OR (phase='delivered' AND deleted_at IS NULL))`).get(userId).n
}

// The sender device's transfers still waiting on the user's card.
export function awaitingTransfersOf(db, senderDeviceId) {
  return db.prepare("SELECT COUNT(*) AS n FROM transfers WHERE sender_device_id=? AND consent='awaiting_user' AND phase='open'").get(senderDeviceId).n
}

// The agent devices a transfer in `roomId` goes to: the room's recorded
// owner plus its joined participants, only agent devices of the room
// owner's own user. The sender's own device is left out, except in a
// same-device room (the device is both the owner and a joined participant:
// two sessions of one bridge share the room, and the other one receives).
export function recipientDevices(db, roomId, senderDeviceId) {
  const room = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(roomId)
  if (!room) return []
  const joined = joinedAgentIds(db, roomId)
  const sameDevice = room.agent_device_id === senderDeviceId && joined.includes(senderDeviceId)
  const ids = new Set(joined)
  if (room.agent_device_id != null) ids.add(room.agent_device_id)
  if (!sameDevice) ids.delete(senderDeviceId)
  const own = db.prepare("SELECT 1 FROM devices WHERE id=? AND user_id=? AND kind='agent'")
  return [...ids].filter((d) => own.get(d, room.owner_user_id)).sort((x, y) => x - y)
}

// The devices a new transfer from `senderDeviceId` into `roomId` could go
// to under the one-recipient rule: recipientDevices without the sender's
// own device, or, when that leaves none, the sender's device itself in a
// same-device room. A transfer is created only when this is exactly one
// device; that device is stored on the row (recipient_device_id).
export function recipientCandidates(db, roomId, senderDeviceId) {
  const all = recipientDevices(db, roomId, senderDeviceId)
  const others = all.filter((d) => d !== senderDeviceId)
  return others.length ? others : all
}

// The device a transfer goes to: the one stored at create, as a list. A
// row from before the column was added falls back to the room's
// recipientDevices as they are now.
export function transferRecipients(db, row) {
  if (row.recipient_device_id != null) return [row.recipient_device_id]
  return recipientDevices(db, row.room_id, row.sender_device_id)
}

// A guarded update. `patch` may set consent / upload / phase (each moved
// only from an allowed prior state, see TRANSITIONS) plus the timestamp and
// decision columns. Returns false when the row is missing or not in an
// allowed prior state for every axis the patch moves; nothing is written
// then. An unknown column throws (a caller bug, not a race).
export function setTransferState(db, id, patch) {
  const sets = []
  const where = ['id = @id']
  const params = { id }
  for (const [key, value] of Object.entries(patch)) {
    if (key in TRANSITIONS) {
      const from = TRANSITIONS[key][value]
      if (!from) throw new Error(`no transition to ${key}=${value}`)
      where.push(`${key} IN (${from.map((_, i) => `@${key}_from${i}`).join(',')})`)
      from.forEach((f, i) => { params[`${key}_from${i}`] = f })
    } else if (!PATCH_COLUMNS.has(key)) {
      throw new Error(`transfers: unknown column ${key}`)
    }
    sets.push(`${key} = @set_${key}`)
    params[`set_${key}`] = value
  }
  if (sets.length === 0) return false
  return db.prepare(`UPDATE transfers SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`).run(params).changes === 1
}

// Rooms between two people's agents: the owner side or the guest twin of a
// person_rooms link (any state: once a room has carried another person's
// agent it never carries files), or any member device of another user.
export function isPersonRoom(db, roomId) {
  if (db.prepare('SELECT 1 FROM person_rooms WHERE owner_room_id=? OR guest_room_id=? LIMIT 1').get(roomId, roomId)) return true
  const room = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(roomId)
  if (!room) return false
  const members = [room.agent_device_id, ...joinedAgentIds(db, roomId)].filter((d) => d != null)
  const userOf = db.prepare('SELECT user_id FROM devices WHERE id=?')
  return members.some((d) => {
    const dev = userOf.get(d)
    return dev != null && dev.user_id !== room.owner_user_id
  })
}

// The stored findings, {kind, line} each; a damaged column reads as none.
export function parseFindings(raw) {
  try {
    const list = JSON.parse(raw ?? '[]')
    return Array.isArray(list) ? list.filter((f) => f && typeof f === 'object').map((f) => ({ kind: f.kind, line: f.line })) : []
  } catch {
    return []
  }
}
