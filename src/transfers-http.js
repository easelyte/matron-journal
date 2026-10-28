// HTTP surface of agent-to-agent file transfers (src/transfers.js):
//   POST   /transfers                  create (the sender)
//   PUT    /transfers/:id/chunks/:n    one chunk, header x-chunk-sha256 (the sender)
//   GET    /transfers/:id              status and received chunks (sender or recipients)
//   DELETE /transfers/:id              cancel (the sender)
//   POST   /transfers/:id/complete     every chunk in, whole-file sha256 checked (the sender)
//   GET    /transfers/:id/content      the bytes, Range-able, once released (recipients)
//   POST   /transfers/:id/received     {sha256}: the receiver verified its copy (recipients)
//   POST   /transfers/:id/failed       {reason}: the receiver could not save it (recipients)
//   GET    /transfers?for=me           released, undelivered transfers for the caller (recipients)
// Agent devices only: a client gets 403. A transfer the caller may not see
// is 404, never 403, so its id confirms nothing. A refusal before a chunk
// body is read closes the connection (rejectEarly), so unread bytes never
// desync a keep-alive socket.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { json, readBody } from './http-body.js'
import { sanitizePeerText, plainText } from './peer-text.js'
import { receiveToPath } from './media.js'
import {
  TRANSFER_CHUNK_BYTES, TRANSFER_MAX_BYTES_DEFAULT, TRANSFER_USER_QUOTA_BYTES_DEFAULT, TRANSFER_MAX_AWAITING_PER_SENDER_DEFAULT, SCAN_VERDICTS,
  isTransferId, chunkCount, expectedChunkSize, transferChunkPath, createTransfer, getTransfer, recordChunk,
  receivedChunks, forgetChunks, reservedTransferBytes, recipientCandidates, transferRecipients, deleteTransferFiles, setTransferState,
  isPersonRoom, TRANSFER_DELIVERED_GRACE_MS, awaitingTransfersOf,
} from './transfers.js'
import { joinedAgentIds } from './participants.js'
import { fileTransferConsentItem, closeTransferConsentItem, releaseIfReady, readyTransferView, humanSize } from './transfer-consent.js'
import { nudgeCoordinator } from './consent.js'
import { causesFromFrame } from './ask-causes.js'
import { codeSpan } from './consent-items.js'
import { appendAndBroadcast } from './journal.js'

export const TRANSFER_NAME_MAX = 255
export const TRANSFER_REASON_MAX = 1000
export const TRANSFER_FINDINGS_MAX = 50
export const TRANSFER_FAILED_REASON_MAX = 200
const FINDING_KIND_MAX = 64
const FINDING_LINE_MAX = 300
const CONTENT_TYPE_MAX = 255
const ID_MAX = 128
const SHA_RE = /^[0-9a-f]{64}$/

// Transfer ids whose /complete is hashing the chunks right now. While one
// is held, a second /complete is 409 hashing and a chunk PUT is 409
// closed, so the bytes cannot change under the hash. In memory only: a
// restart drops the hold along with the request that held it.
export const hashingTransfers = new Set()

// Transfer id -> how many of its chunk PUTs are reading a body or renaming
// it into place right now. While any is, /complete is 409 hashing, so the
// hash never runs over a chunk that is about to change. In memory only,
// like hashingTransfers.
export const chunkPutsInFlight = new Map()
const putStarted = (id) => chunkPutsInFlight.set(id, (chunkPutsInFlight.get(id) ?? 0) + 1)
function putEnded(id) {
  const n = (chunkPutsInFlight.get(id) ?? 1) - 1
  if (n > 0) chunkPutsInFlight.set(id, n)
  else chunkPutsInFlight.delete(id)
}

const conflict = (res, detail, message) => { json(res, 409, { error: 'conflict', detail, ...(message ? { message } : {}) }); return true }

const bad = (res) => { json(res, 400, { error: 'bad_request' }); return true }
const notFound = (res) => { json(res, 404, { error: 'not_found' }); return true }

const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= ID_MAX

// {kind, line} only: line is a 1-based line number, or a short label —
// `member:line` inside an archive, or a bare member name for a finding
// about the file name itself (kind sensitive_file). Anything else on a finding (a matched value) is dropped.
function parseScan(scan) {
  if (scan === undefined || scan === null) return { verdict: 'not_scanned', findings: [] }
  if (typeof scan !== 'object' || !SCAN_VERDICTS.includes(scan.verdict)) return null
  const raw = scan.findings ?? []
  if (!Array.isArray(raw) || raw.length > TRANSFER_FINDINGS_MAX) return null
  const findings = []
  for (const f of raw) {
    if (!f || typeof f !== 'object' || typeof f.kind !== 'string') return null
    const kind = sanitizePeerText(f.kind, FINDING_KIND_MAX)
    if (!kind) return null
    let line
    if (Number.isSafeInteger(f.line) && f.line >= 1) line = f.line
    else if (typeof f.line === 'string' && f.line.length <= FINDING_LINE_MAX && sanitizePeerText(f.line, FINDING_LINE_MAX)) line = sanitizePeerText(f.line, FINDING_LINE_MAX)
    else return null
    findings.push({ kind, line })
  }
  return { verdict: scan.verdict, findings }
}

// The create body, normalised, or null for a bad shape.
function parseCreate(body) {
  const { room_id: roomId, from_convo_id: fromConvoId, name, size, sha256, content_type: contentType, reason } = body
  if (!isId(roomId) || !isId(fromConvoId)) return null
  if (typeof name !== 'string' || name.length > TRANSFER_NAME_MAX) return null
  const cleanName = sanitizePeerText(name, TRANSFER_NAME_MAX)
  // A file name, never a path: the receiver writes it into its inbox.
  if (!cleanName || cleanName === '.' || cleanName === '..' || /[/\\]/.test(cleanName)) return null
  if (!Number.isSafeInteger(size) || size < 1) return null
  if (typeof sha256 !== 'string' || !SHA_RE.test(sha256)) return null
  if (contentType !== undefined && (typeof contentType !== 'string' || contentType.length > CONTENT_TYPE_MAX)) return null
  if (reason !== undefined && reason !== null && typeof reason !== 'string') return null
  const scan = parseScan(body.scan)
  if (!scan) return null
  // The asking turn's causes, same rules as a chat or spawn ask frame's:
  // absent or null is none, anything else must normalise or it is a 400.
  const causes = causesFromFrame(body)
  if (!causes.ok) return null
  return {
    roomId, fromConvoId, name: cleanName, size, sha256,
    contentType: sanitizePeerText(contentType, CONTENT_TYPE_MAX) || 'application/octet-stream',
    reason: sanitizePeerText(reason, TRANSFER_REASON_MAX),
    scan, causes: causes.causes,
  }
}

// The caller's device is the room's recorded owner or a joined participant.
function isRoomMember(db, room, roomId, deviceId) {
  return room.agent_device_id === deviceId || joinedAgentIds(db, roomId).includes(deviceId)
}

const isRecipient = (db, row, deviceId) => transferRecipients(db, row).includes(deviceId)

// The row, when the caller may see it: the sender's device, or (unless
// senderOnly) the transfer's recipient device; with recipientOnly, the
// recipient device only (in a same-device room it is the sender's device).
// Always of the row's own user.
function visibleTransfer(db, who, id, { senderOnly = false, recipientOnly = false } = {}) {
  if (!isTransferId(id)) return null
  const row = getTransfer(db, id)
  if (!row || row.user_id !== who.userId) return null
  if (recipientOnly) return isRecipient(db, row, who.deviceId) ? row : null
  if (row.sender_device_id === who.deviceId) return row
  if (senderOnly) return null
  return isRecipient(db, row, who.deviceId) ? row : null
}

const statusView = (db, row, chunkBytes) => ({
  id: row.id, phase: row.phase, consent: row.consent, upload: row.upload, size: row.size,
  chunk_bytes: chunkBytes, chunks: chunkCount(row.size, chunkBytes), received: receivedChunks(db, row.id),
})

async function create(ctx, req, res, who) {
  const { db, transferMaxBytes, transferUserQuotaBytes, transferMaxAwaitingPerSender, chunkBytes } = ctx
  const t = parseCreate(await readBody(req))
  if (!t) return bad(res)
  const room = db.prepare('SELECT owner_user_id, agent_device_id, system FROM conversations WHERE id=?').get(t.roomId)
  if (!room || room.owner_user_id !== who.userId || room.system != null || !isRoomMember(db, room, t.roomId, who.deviceId)) return notFound(res)
  const from = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(t.fromConvoId)
  if (!from || from.owner_user_id !== who.userId || from.agent_device_id !== who.deviceId) return notFound(res)
  if (isPersonRoom(db, t.roomId)) { json(res, 403, { error: 'person_room' }); return true }
  if (t.size > transferMaxBytes) { json(res, 413, { error: 'too_large' }); return true }
  // One recipient device per transfer: delivery (the receipt, a failed
  // save) is tracked per transfer, so a second recipient would lose the
  // file the moment the first settled it.
  const recipients = recipientCandidates(db, t.roomId, who.deviceId)
  if (recipients.length === 0) return conflict(res, 'no_recipients', 'Nobody else in this room can receive a file.')
  if (recipients.length > 1) return conflict(res, 'multiple_recipients', 'A file goes to exactly one other box; this room has more than one. Send it from a room with just the receiving box.')
  if (awaitingTransfersOf(db, who.deviceId) >= transferMaxAwaitingPerSender) {
    return conflict(res, 'too_many_awaiting', `Too many transfers (${transferMaxAwaitingPerSender}) are already waiting for the user's approval.`)
  }
  // Check and insert with no await between them: the quota read and the
  // reservation are one synchronous step, so two creates cannot both pass.
  if (reservedTransferBytes(db, who.userId) + t.size > transferUserQuotaBytes) { json(res, 413, { error: 'quota_exceeded' }); return true }
  const row = createTransfer(db, {
    userId: who.userId, roomId: t.roomId, senderDeviceId: who.deviceId, recipientDeviceId: recipients[0], fromConvoId: t.fromConvoId,
    name: t.name, size: t.size, sha256: t.sha256, contentType: t.contentType, reason: t.reason, scan: t.scan, causes: t.causes,
  })
  console.log(`journal: transfer created id=${row.id} room=${row.room_id} device=${who.deviceId} size=${row.size} scan=${row.scan_verdict}`)
  // The user's card, then a nudge to the Coordinator (skipped when it is
  // the sender). Both best-effort: the transfer stands without them.
  fileTransferConsentItem(ctx, row)
  nudgeCoordinator(ctx, who.userId, { kind: 'transfer', id: row.id }, { askerConvoId: row.from_convo_id })
  json(res, 201, { transfer_id: row.id, chunk_bytes: chunkBytes, chunks: chunkCount(row.size, chunkBytes) })
  return true
}

const writable = (row) => row && row.phase === 'open' && row.upload === 'uploading'

// Phases whose bytes are gone for good (the route that ended it deleted
// them): a chunk PUT still in flight clears whatever it left behind. Not
// open, released or delivered: their chunks are the verified file.
const BYTES_GONE = new Set(['cancelled', 'declined', 'failed', 'expired'])

async function putChunk(ctx, req, res, who, id, nRaw, rejectEarly) {
  const { db, chunkBytes } = ctx
  const early = (status, error) => { rejectEarly(req, res, status, { error }); return true }
  const row = visibleTransfer(db, who, id, { senderOnly: true })
  if (!row) return early(404, 'not_found')
  const n = /^\d{1,9}$/.test(nRaw) ? Number(nRaw) : -1
  const digest = String(req.headers['x-chunk-sha256'] ?? '').toLowerCase()
  if (n < 0 || n >= chunkCount(row.size, chunkBytes) || !SHA_RE.test(digest)) return early(400, 'bad_request')
  if (!writable(row) || hashingTransfers.has(id)) return early(409, 'closed')
  const expected = expectedChunkSize(row.size, n, chunkBytes)
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) !== expected) return early(400, 'chunk_mismatch')
  // Counted from here (no await since the checks above) until the chunk is
  // in place or refused, so a /complete cannot start hashing meanwhile.
  putStarted(id)
  try {
    return await receiveChunk(ctx, req, res, id, n, expected, digest, early)
  } finally {
    putEnded(id)
  }
}

// putChunk once counted in flight.
async function receiveChunk(ctx, req, res, id, n, expected, digest, early) {
  const { db, mediaDir } = ctx
  const finalPath = transferChunkPath(mediaDir, id, n)
  // A temp name of its own per request, so two retries of one chunk in
  // flight at once never write into the same file.
  const tmpPath = `${finalPath}.${crypto.randomBytes(6).toString('hex')}.tmp`
  const mismatch = () => Object.assign(new Error('chunk mismatch'), { code: 'chunk_mismatch' })
  const closed = () => Object.assign(new Error('transfer closed'), { code: 'closed' })
  // Refused after the body was read: the transfer stopped taking chunks. A
  // terminal end clears the directory (this request may have recreated it
  // after the route that ended it deleted it); a finished upload keeps its
  // verified chunks, and only this request's temp file (already removed by
  // receiveToPath) goes.
  const refuse = (send) => {
    if (BYTES_GONE.has(getTransfer(db, id)?.phase)) deleteTransferFiles(mediaDir, id)
    return send(409, 'closed')
  }
  try {
    await receiveToPath(req, {
      tmpPath, finalPath, maxBytes: expected,
      accept: ({ size, sha256 }) => {
        if (size !== expected || sha256 !== digest) throw mismatch()
        // The body took a while: re-check before the rename. A cancel ends
        // it; a /complete hashing now (the in-flight count should already
        // have refused one) must not see the chunk change under it.
        if (hashingTransfers.has(id) || !writable(getTransfer(db, id))) throw closed()
      },
    })
  } catch (e) {
    if (e.code === 'closed' || !writable(getTransfer(db, id))) return refuse(e.code === 'closed' ? sendJson(res) : early)
    if (e.code === 'too_large') return early(400, 'chunk_mismatch')
    if (e.code === 'chunk_mismatch') { json(res, 400, { error: 'chunk_mismatch' }); return true }
    throw e
  }
  if (!writable(getTransfer(db, id))) return refuse(sendJson(res))
  recordChunk(db, id, n, expected)
  json(res, 200, { n })
  return true
}

const sendJson = (res) => (status, error) => { json(res, status, { error }); return true }

function cancel(ctx, res, who, id) {
  const { db, mediaDir } = ctx
  const row = visibleTransfer(db, who, id, { senderOnly: true })
  if (!row) return notFound(res)
  if (row.phase === 'cancelled') { json(res, 200, { id, phase: 'cancelled' }); return true }
  if (!setTransferState(db, id, { phase: 'cancelled', deleted_at: Date.now() })) { json(res, 409, { error: 'closed' }); return true }
  deleteTransferFiles(mediaDir, id)
  forgetChunks(db, id)
  closeTransferConsentItem(ctx, id, { outcome: 'cancelled' })
  console.log(`journal: transfer cancelled id=${id} device=${who.deviceId}`)
  json(res, 200, { id, phase: 'cancelled' })
  return true
}

// Stream chunks [first, last] of a transfer in order, each read only over
// the slice of [start, end] (inclusive, file offsets) it holds.
async function* chunkBytes(mediaDir, row, chunkSize, start, end) {
  for (let n = Math.floor(start / chunkSize); n * chunkSize <= end; n++) {
    const base = n * chunkSize
    const from = Math.max(start, base) - base
    const to = Math.min(end, base + expectedChunkSize(row.size, n, chunkSize) - 1) - base
    yield* fs.createReadStream(transferChunkPath(mediaDir, row.id, n), { start: from, end: to })
  }
}

const progress = (row) => ({ id: row.id, consent: row.consent, upload: row.upload, phase: row.phase })

// The whole file's sha256 over its chunks on disk, in order. → the hex
// digest, or {missing: n} when a recorded chunk's file has gone.
async function hashChunks(mediaDir, row, chunkSize) {
  const h = crypto.createHash('sha256')
  for (let n = 0; n < chunkCount(row.size, chunkSize); n++) {
    try {
      await pipeline(fs.createReadStream(transferChunkPath(mediaDir, row.id, n)), async (source) => {
        for await (const b of source) h.update(b)
      })
    } catch (e) {
      if (e.code === 'ENOENT') return { missing: n }
      throw e
    }
  }
  return h.digest('hex')
}

// The upload failed its whole-file check: end the transfer, delete its
// bytes, close the card and tell the sender. → false when something else
// ended it first.
function failUpload(ctx, row) {
  const { db, hub, mediaDir } = ctx
  if (!setTransferState(db, row.id, { upload: 'failed', phase: 'failed', deleted_at: Date.now() })) return false
  deleteTransferFiles(mediaDir, row.id)
  forgetChunks(db, row.id)
  closeTransferConsentItem(ctx, row.id, { outcome: 'failed' })
  hub.sendToDevice(row.user_id, row.sender_device_id, { kind: 'transfer', event: 'failed', transfer_id: row.id, reason: 'sha256_mismatch' })
  console.log(`journal: transfer failed id=${row.id} reason=sha256_mismatch`)
  return true
}

async function completeUpload(ctx, res, who, id) {
  const { db, mediaDir, chunkBytes: chunkSize } = ctx
  const row = visibleTransfer(db, who, id, { senderOnly: true })
  if (!row) return notFound(res)
  if (row.upload === 'uploaded' && row.phase !== 'failed') { json(res, 200, progress(row)); return true }
  if (!writable(row)) { json(res, 409, { error: 'closed' }); return true }
  if (hashingTransfers.has(id)) return conflict(res, 'hashing', 'This transfer is already being checked; try again shortly.')
  if (chunkPutsInFlight.has(id)) return conflict(res, 'hashing', 'A chunk of this transfer is still uploading; try again shortly.')
  hashingTransfers.add(id)
  try {
    return await completeHeld(ctx, res, row)
  } finally {
    hashingTransfers.delete(id)
  }
}

// completeUpload with the hashing hold taken.
async function completeHeld(ctx, res, row) {
  const { db, mediaDir, chunkBytes: chunkSize } = ctx
  const { id } = row
  const have = new Set(receivedChunks(db, id))
  const missing = []
  for (let n = 0; n < chunkCount(row.size, chunkSize); n++) if (!have.has(n)) missing.push(n)
  if (missing.length) { json(res, 409, { error: 'missing_chunks', missing }); return true }
  const digest = await hashChunks(mediaDir, row, chunkSize)
  // The hash took a while: re-read the row before acting on it.
  const now = getTransfer(db, id)
  if (now.upload === 'uploaded' && now.phase !== 'failed') { json(res, 200, progress(now)); return true }
  if (!writable(now)) { json(res, 409, { error: 'closed' }); return true }
  if (typeof digest === 'object') {
    db.prepare('DELETE FROM transfer_chunks WHERE transfer_id=? AND n=?').run(id, digest.missing)
    json(res, 409, { error: 'missing_chunks', missing: [digest.missing] })
    return true
  }
  if (digest !== row.sha256) {
    if (!failUpload(ctx, now)) { json(res, 409, { error: 'closed' }); return true }
    json(res, 422, { error: 'sha256_mismatch' })
    return true
  }
  if (setTransferState(db, id, { upload: 'uploaded', uploaded_at: Date.now() })) {
    console.log(`journal: transfer uploaded id=${id}`)
    releaseIfReady(ctx, id)
  }
  json(res, 200, progress(getTransfer(db, id)))
  return true
}

// Downloadable: released, or delivered less than the grace period ago.
const downloadable = (row, now = Date.now()) => row.phase === 'released'
  || (row.phase === 'delivered' && row.deleted_at == null && row.delivered_at != null && now - row.delivered_at < TRANSFER_DELIVERED_GRACE_MS)

// `bytes=a-` or `bytes=a-b` → {start, end} (inclusive, end clamped to the
// file), null for no Range header, or 'bad' for any other form or a start
// past the end.
function parseRange(header, size) {
  if (header === undefined) return null
  const m = /^bytes=(\d{1,15})-(\d{0,15})$/.exec(String(header).trim())
  if (!m) return 'bad'
  const start = Number(m[1])
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  if (start >= size || end < start) return 'bad'
  return { start, end }
}

// The stored content type when it is a plain ASCII header value, else
// octet-stream (a peer-chosen type may carry characters no header takes).
const headerSafe = (type) => (/^[\x20-\x7e]+$/.test(type) ? type : 'application/octet-stream')

async function content(ctx, req, res, who, id) {
  const { db, mediaDir, chunkBytes: chunkSize } = ctx
  const row = visibleTransfer(db, who, id, { recipientOnly: true })
  if (!row || !downloadable(row)) return notFound(res)
  const range = parseRange(req.headers.range, row.size)
  if (range === 'bad') {
    res.writeHead(416, { 'content-range': `bytes */${row.size}`, 'content-length': '0' })
    res.end()
    return true
  }
  const { start, end } = range ?? { start: 0, end: row.size - 1 }
  // Every chunk the range touches must be on disk at its exact size; a
  // short or missing one is a clean 500, not a truncated 200.
  for (let n = Math.floor(start / chunkSize); n * chunkSize <= end; n++) {
    let size = -1
    try { size = fs.statSync(transferChunkPath(mediaDir, id, n)).size } catch { /* missing */ }
    if (size !== expectedChunkSize(row.size, n, chunkSize)) {
      console.error(`transfer: ${id} chunk ${n} is missing or the wrong size on disk`)
      json(res, 500, { error: 'internal' })
      return true
    }
  }
  res.writeHead(range ? 206 : 200, {
    'content-type': headerSafe(row.content_type),
    'content-length': String(end - start + 1),
    ...(range ? { 'content-range': `bytes ${start}-${end}/${row.size}` } : {}),
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    // The content type is sender-chosen: never sniffed, never rendered.
    'x-content-type-options': 'nosniff',
    'content-disposition': 'attachment',
  })
  // pipeline, so a client abort mid-body closes the open chunk's fd.
  await pipeline(chunkBytes(mediaDir, row, chunkSize, start, end), res).catch(() => {})
  return true
}

async function receipt(ctx, req, res, who, id) {
  const { db, hub } = ctx
  const row = visibleTransfer(db, who, id, { recipientOnly: true })
  if (!row) return notFound(res)
  const { sha256 } = await readBody(req)
  if (typeof sha256 !== 'string' || sha256.toLowerCase() !== row.sha256) return bad(res)
  if (row.phase === 'delivered') { json(res, 200, progress(row)); return true }
  if (row.phase !== 'released') { json(res, 409, { error: 'closed' }); return true }
  if (!setTransferState(db, id, { phase: 'delivered', delivered_at: Date.now() })) {
    const now = getTransfer(db, id)
    if (now.phase === 'delivered') { json(res, 200, progress(now)); return true }
    json(res, 409, { error: 'closed' })
    return true
  }
  hub.sendToDevice(row.user_id, row.sender_device_id, { kind: 'transfer', event: 'delivered', transfer_id: id })
  try {
    appendAndBroadcast(db, hub, {
      userId: row.user_id, convoId: row.room_id, sender: 'journal', type: 'text',
      payload: { body: `Delivered ${codeSpan(row.name)} (${humanSize(row.size)}), sha256 verified.` },
    })
  } catch (err) {
    console.error(`transfer: delivered notice for ${id} failed (the receipt stands)`, err)
  }
  console.log(`journal: transfer delivered id=${id} device=${who.deviceId}`)
  json(res, 200, progress(getTransfer(db, id)))
  return true
}

// A recipient could not save a released file (disk full, a write error):
// the transfer ends as failed, its bytes go, the sender is told and the
// room gets a line. Already failed is a no-op 200; any other phase is 409.
async function receiverFailed(ctx, req, res, who, id) {
  const { db, hub, mediaDir } = ctx
  const row = visibleTransfer(db, who, id, { recipientOnly: true })
  if (!row) return notFound(res)
  const { reason: raw } = await readBody(req)
  if (raw !== undefined && raw !== null && typeof raw !== 'string') return bad(res)
  const reason = plainText(sanitizePeerText(raw, TRANSFER_FAILED_REASON_MAX)).trim() || 'no reason given'
  if (row.phase === 'failed') { json(res, 200, progress(row)); return true }
  if (row.phase !== 'released' || !setTransferState(db, id, { phase: 'failed', deleted_at: Date.now() })) {
    const now = getTransfer(db, id)
    if (now.phase === 'failed') { json(res, 200, progress(now)); return true }
    json(res, 409, { error: 'closed' })
    return true
  }
  deleteTransferFiles(mediaDir, id)
  forgetChunks(db, id)
  closeTransferConsentItem(ctx, id, { outcome: 'failed' })
  hub.sendToDevice(row.user_id, row.sender_device_id, { kind: 'transfer', event: 'failed', transfer_id: id, reason: `receiver: ${reason}` })
  try {
    appendAndBroadcast(db, hub, {
      userId: row.user_id, convoId: row.room_id, sender: 'journal', type: 'text',
      payload: { body: `Not received: ${codeSpan(row.name)} could not be saved on the receiving box: ${reason}` },
    })
  } catch (err) {
    console.error(`transfer: failed notice for ${id} failed (the failure stands)`, err)
  }
  console.log(`journal: transfer failed id=${id} reason=receiver device=${who.deviceId}`)
  json(res, 200, progress(getTransfer(db, id)))
  return true
}

// The bridge's catch-up on hello: every released, undelivered transfer of
// the caller's user that the caller's device is a recipient of.
function readyForMe(ctx, res, who) {
  const { db } = ctx
  const rows = db.prepare("SELECT * FROM transfers WHERE user_id=? AND phase='released' ORDER BY created_at, id").all(who.userId)
  json(res, 200, { transfers: rows.filter((r) => isRecipient(db, r, who.deviceId)).map((r) => readyTransferView(db, r)) })
  return true
}

export async function handleTransferRoute(ctx, req, res, url, who, { rejectEarly }) {
  const m = url.pathname.match(/^\/transfers(?:\/([^/]+)(?:\/chunks\/([^/]+)|\/(complete|content|received|failed))?)?$/)
  if (!m) return false
  const full = {
    ...ctx,
    transferMaxBytes: ctx.transferMaxBytes ?? TRANSFER_MAX_BYTES_DEFAULT,
    transferUserQuotaBytes: ctx.transferUserQuotaBytes ?? TRANSFER_USER_QUOTA_BYTES_DEFAULT,
    transferMaxAwaitingPerSender: ctx.transferMaxAwaitingPerSender ?? TRANSFER_MAX_AWAITING_PER_SENDER_DEFAULT,
    chunkBytes: ctx.transferChunkBytes ?? TRANSFER_CHUNK_BYTES,
  }
  const [, id, n, sub] = m
  if (who.kind !== 'agent') { rejectEarly(req, res, 403, { error: 'forbidden' }); return true }
  if (!id && req.method === 'POST') return create(full, req, res, who)
  if (!id && req.method === 'GET') return url.searchParams.get('for') === 'me' ? readyForMe(full, res, who) : bad(res)
  if (sub === 'complete' && req.method === 'POST') return completeUpload(full, res, who, id)
  if (sub === 'content' && req.method === 'GET') return content(full, req, res, who, id)
  if (sub === 'received' && req.method === 'POST') return receipt(full, req, res, who, id)
  if (sub === 'failed' && req.method === 'POST') return receiverFailed(full, req, res, who, id)
  if (sub) return false
  if (id && n !== undefined && req.method === 'PUT') return putChunk(full, req, res, who, id, n, rejectEarly)
  if (id && n === undefined && req.method === 'GET') {
    const row = visibleTransfer(full.db, who, id)
    if (!row) return notFound(res)
    json(res, 200, statusView(full.db, row, full.chunkBytes))
    return true
  }
  if (id && n === undefined && req.method === 'DELETE') return cancel(full, res, who, id)
  return false
}
