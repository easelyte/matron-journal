import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// <root>/<id[0:2]>/<id> — two-hex-char sharding keeps any single directory
// from accumulating unboundedly many entries as the store grows.
export function shardedPath(root, id) {
  return path.join(root, id.slice(0, 2), id)
}

// Shared storage-root resolution for anything that needs to read/write blobs
// outside a request handler (retention offload, the admin CLI) as well as
// server.js itself — one rule, not three copies of it: an explicit override
// wins, then MATRON_MEDIA_DIR, then `<dirname(dbPath)>/media`.
export function resolveMediaDir(dbPath, override) {
  return override || process.env.MATRON_MEDIA_DIR || path.join(path.dirname(dbPath), 'media')
}

// Writes `data` (a Buffer) as a new immutable blob under `root`, atomically
// (tmp file + rename, same pattern as receiveBlob). Used by retention offload,
// which already holds the full payload in memory (unlike a media upload,
// there's no request stream to pipe) — id/sha256/size are computed here
// rather than by the caller so this stays a single source of truth for the
// on-disk layout.
export function writeBlobSync(root, data) {
  const id = crypto.randomBytes(16).toString('hex')
  const finalPath = shardedPath(root, id)
  const tmpPath = `${finalPath}.tmp`
  fs.mkdirSync(path.dirname(finalPath), { recursive: true })
  fs.writeFileSync(tmpPath, data)
  fs.renameSync(tmpPath, finalPath) // atomic — see receiveBlob's comment on why
  const sha256 = crypto.createHash('sha256').update(data).digest('hex')
  return { id, size: data.length, sha256, diskPath: finalPath }
}

// Streams `req` to a temp file under `root`, hashing and counting bytes as
// they arrive so the body is never buffered whole in memory. On success the
// temp file is atomically renamed into its sharded final path. Rejects with
// a `code`-tagged Error for the two statuses http.js maps directly
// ('too_large' | 'empty'); any other error (disk I/O, dropped connection)
// propagates as-is. `createWriteStream` is injectable so tests can exercise
// flush-time disk errors (ENOSPC/EIO) without filling a real filesystem.
export function receiveBlob(req, { root, maxBytes, createWriteStream = fs.createWriteStream }) {
  const id = crypto.randomBytes(16).toString('hex')
  const finalPath = shardedPath(root, id)
  const accept = ({ size }) => {
    if (size === 0) throw Object.assign(new Error('empty media upload'), { code: 'empty' })
  }
  return receiveToPath(req, { tmpPath: `${finalPath}.tmp`, finalPath, maxBytes, accept, createWriteStream })
    .then(({ size, sha256 }) => ({ id, size, sha256, diskPath: finalPath }))
}

// The streaming half of receiveBlob, for any caller that picks its own
// paths (media blobs, transfer chunks): streams `req` to `tmpPath`, hashing
// and counting as it goes, and renames it to `finalPath` once the body is
// fully on disk. More than `maxBytes` rejects with code 'too_large' and
// stops reading (the socket is the caller's to close). `accept({size,
// sha256})` runs after the flush and before the rename: throwing there
// deletes the temp file and rejects with what it threw, so a body the caller
// does not want never appears at `finalPath`. The temp file never outlives
// a failure.
export function receiveToPath(req, { tmpPath, finalPath, maxBytes, accept = () => {}, createWriteStream = fs.createWriteStream }) {
  return fs.promises.mkdir(path.dirname(finalPath), { recursive: true }).then(() => new Promise((resolve, reject) => {
    const out = createWriteStream(tmpPath)
    const hash = crypto.createHash('sha256')
    let size = 0
    let settled = false
    let bodyDone = false // request body fully received; a later req 'close' is benign

    // Stop consuming the request body (mirrors http.js's readBody 413 handling):
    // we do NOT call req.destroy() here, since that would tear down the shared
    // socket and prevent the caller from ever writing the error response.
    const stopReading = () => {
      req.removeAllListeners('data')
      req.removeAllListeners('end')
      req.pause()
    }

    const abort = (err) => {
      if (settled) return
      settled = true
      stopReading()
      out.destroy()
      fs.promises.unlink(tmpPath).catch(() => {}).finally(() => reject(err))
    }

    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        abort(Object.assign(new Error('upload exceeds size cap'), { code: 'too_large' }))
        return
      }
      hash.update(chunk)
      if (!out.write(chunk)) req.pause()
    })
    out.on('drain', () => { if (!settled) req.resume() })

    req.on('end', () => {
      if (settled) return
      bodyDone = true
      // Not settled yet: the final flush is still pending and can fail
      // (ENOSPC/EIO). Settling only inside the callback keeps both failure
      // routes live — `out`'s 'error' handler aborts if it fires first, and
      // the callback's error argument aborts otherwise. Ignoring that
      // argument would rename a truncated temp file into place and report a
      // size/sha256 the on-disk bytes don't match.
      out.end((flushErr) => {
        if (settled) return
        if (flushErr) return abort(flushErr)
        settled = true
        const sha256 = hash.digest('hex')
        try {
          accept({ size, sha256 })
        } catch (err) {
          fs.promises.unlink(tmpPath).catch(() => {}).finally(() => reject(err))
          return
        }
        fs.promises.rename(tmpPath, finalPath)
          .then(() => resolve({ size, sha256, path: finalPath }))
          .catch((err) => { fs.promises.unlink(tmpPath).catch(() => {}); reject(err) })
      })
    })
    req.on('error', abort)
    // On a normally-completed request 'close' fires after 'end', while the
    // flush may still be in flight — only treat 'close' as a client abort
    // when the body never finished arriving.
    req.on('close', () => { if (!bodyDone) abort(new Error('connection closed')) })
    out.on('error', abort)
  }))
}
