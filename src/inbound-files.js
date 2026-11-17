// Files an inbound source (src/inbound.js) sends with a report.
//
// A source's own files (a chart it drew, a PDF it wrote) sit behind its
// user's sign-in there, so a link to one is no use here: the bytes have to
// come. A file is uploaded first and named by a later report:
//
//   - with the source's key: POST /inbound/files;
//   - without it: the source asks for a one-file upload address
//     (the `request_upload` tool) and sends the bytes there. An assistant
//     that reaches this server through a connector never holds the key,
//     only an address that takes one file for a few minutes.
//
// Guards that are not settings:
//   - a short list of types, decided by the file's own first bytes, never
//     by the name or the type the sender claims;
//   - a size cap, at most FILES_PER_REPORT_MAX files per report, and a cap
//     on files of that many times the source's report caps;
//   - a file no report names within FILE_ATTACH_MS is never shown, and the
//     media reaper deletes it as it does any blob nothing names;
//   - the bytes count against the user's media quota.
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { sanitizeConsentText } from './peer-text.js'

export const FILE_MAX_BYTES = 50 * 1024 * 1024
export const FILES_PER_REPORT_MAX = 4
export const UPLOAD_TICKET_MS = 15 * 60 * 1000
export const FILE_ATTACH_MS = 60 * 60 * 1000
export const FILE_NAME_MAX = 120
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

// The type, from the first bytes. Anything else is refused.
export function sniffType(buf) {
  const at = (i, s) => buf.length >= i + s.length && buf.toString('latin1', i, i + s.length) === s
  if (at(0, '\x89PNG\r\n\x1a\n')) return { contentType: 'image/png', ext: 'png' }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { contentType: 'image/jpeg', ext: 'jpg' }
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return { contentType: 'image/gif', ext: 'gif' }
  if (at(0, 'RIFF') && at(8, 'WEBP')) return { contentType: 'image/webp', ext: 'webp' }
  if (at(0, '%PDF-')) return { contentType: 'application/pdf', ext: 'pdf' }
  return null
}
export function sniffFile(diskPath) {
  let fd
  try {
    fd = fs.openSync(diskPath, 'r')
    const buf = Buffer.alloc(16)
    const n = fs.readSync(fd, buf, 0, 16, 0)
    return sniffType(buf.subarray(0, n))
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

// A bare, plain file name whose ending says what the bytes are.
export function cleanFileName(name, ext) {
  const base = sanitizeConsentText(String(name ?? '').split(/[\\/]/).pop(), FILE_NAME_MAX)
    .replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/^[ .]+|[ .]+$/g, '')
  return `${base || 'file'}.${ext}`
}

export const fileCaps = (source) => ({ hourly: source.hourly_max * FILES_PER_REPORT_MAX, daily: source.daily_max * FILES_PER_REPORT_MAX })

// A place for one file. With `ticket`, also a secret that lets its holder
// send that one file without the key. {status:'ok', id, secret?} or
// {status:'rate_limited', retryAfter}.
export function reserveFile(db, source, { name = '', ticket = false, now = Date.now() } = {}) {
  return db.transaction(() => {
    // The caller's row was loaded before this write: its key may have been
    // replaced, or the source disabled, since.
    const live = db.prepare('SELECT token_hash, enabled FROM inbound_sources WHERE id=?').get(source.id)
    if (!live || !live.enabled || live.token_hash !== source.token_hash) return { status: 'gone' }
    // Rows of files that were shown stay: they are what keeps an agent
    // from reading the blob (isInboundFileBlob).
    db.prepare('DELETE FROM inbound_files WHERE source_id=? AND created_at<=? AND used_at IS NULL').run(source.id, now - 2 * DAY)
    const caps = fileCaps(source)
    for (const [windowMs, max] of [[HOUR, caps.hourly], [DAY, caps.daily]]) {
      const w = db.prepare('SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM inbound_files WHERE source_id=? AND created_at>?').get(source.id, now - windowMs)
      if (w.n >= max) return { status: 'rate_limited', retryAfter: Math.max(1, Math.ceil((w.oldest + windowMs - now) / 1000)) }
    }
    const id = `mif_${randomBytes(12).toString('hex')}`
    const secret = ticket ? randomBytes(32).toString('base64url') : null
    db.prepare('INSERT INTO inbound_files(id, source_id, secret_hash, name, created_at) VALUES(?,?,?,?,?)')
      .run(id, source.id, secret ? sha256(secret) : null, String(name ?? '').slice(0, 400), now)
    return { status: 'ok', id, ...(secret ? { secret } : {}) }
  })()
}

// The file an upload address is for, while it is still waiting for its
// bytes, in time, and its source enabled. Null otherwise.
export function fileForSecret(db, secret, { now = Date.now() } = {}) {
  if (typeof secret !== 'string' || !secret) return null
  return db.prepare(`SELECT f.* FROM inbound_files f JOIN inbound_sources s ON s.id = f.source_id
    WHERE f.secret_hash=? AND f.blob_id IS NULL AND f.created_at>? AND s.enabled=1`).get(sha256(secret), now - UPLOAD_TICKET_MS) ?? null
}

// The bytes have arrived (a blobs row exists). False when the place was
// filled or withdrawn meanwhile: the caller deletes what it stored.
export function fillFile(db, fileId, { blobId, contentType, ext, size }) {
  const row = db.prepare('SELECT name FROM inbound_files WHERE id=? AND blob_id IS NULL').get(fileId)
  if (!row) return false
  return db.prepare('UPDATE inbound_files SET blob_id=?, content_type=?, size=?, name=? WHERE id=? AND blob_id IS NULL')
    .run(blobId, contentType, size, cleanFileName(row.name, ext), fileId).changes > 0
}

// Inside acceptReport's transaction: the files a report names, each this
// source's, uploaded, recent and not yet shown. {ok, files} or {ok:false, detail}.
export function takeFiles(db, source, ids, { now = Date.now() } = {}) {
  const files = []
  for (const id of new Set(ids)) {
    const f = db.prepare(`SELECT f.*, b.sha256, b.width, b.height FROM inbound_files f JOIN blobs b ON b.id = f.blob_id
      WHERE f.id=? AND f.source_id=? AND f.used_at IS NULL AND f.created_at>?`).get(id, source.id, now - FILE_ATTACH_MS)
    if (!f) return { ok: false, detail: `file ${String(id).slice(0, 40)} is not an uploaded file of this source, or it was uploaded over an hour ago or already posted` }
    files.push(f)
  }
  return { ok: true, files }
}
export const markFilesUsed = (db, files, now) => { for (const f of files) db.prepare('UPDATE inbound_files SET used_at=? WHERE id=?').run(now, f.id) }
export const isInboundFileBlob = (db, blobId) => !!db.prepare('SELECT 1 FROM inbound_files WHERE blob_id=?').get(blobId)

// The sha256 of each file a report names, shown already or not, in the
// order takeFiles gives them. Null when one is not this source's uploaded file.
export function fileSums(db, source, ids) {
  const sums = []
  for (const id of new Set(ids)) {
    const f = db.prepare('SELECT b.sha256 FROM inbound_files f JOIN blobs b ON b.id = f.blob_id WHERE f.id=? AND f.source_id=?').get(id, source.id)
    if (!f) return null
    sums.push(f.sha256)
  }
  return sums
}

// Places still waiting for their bytes: withdrawn when the key is replaced.
export const dropUploadAddresses = (db, sourceId) => db.prepare('DELETE FROM inbound_files WHERE source_id=? AND blob_id IS NULL').run(sourceId).changes
