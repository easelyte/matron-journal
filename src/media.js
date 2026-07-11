import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// <root>/<id[0:2]>/<id> — two-hex-char sharding keeps any single directory
// from accumulating unboundedly many entries as the store grows.
export function shardedPath(root, id) {
  return path.join(root, id.slice(0, 2), id)
}

// Streams `req` to a temp file under `root`, hashing and counting bytes as
// they arrive so the body is never buffered whole in memory. On success the
// temp file is atomically renamed into its sharded final path. Rejects with
// a `code`-tagged Error for the two statuses http.js maps directly
// ('too_large' | 'empty'); any other error (disk I/O, dropped connection)
// propagates as-is.
export function receiveBlob(req, { root, maxBytes }) {
  const id = crypto.randomBytes(16).toString('hex')
  const finalPath = shardedPath(root, id)
  const tmpPath = `${finalPath}.tmp`

  return fs.promises.mkdir(path.dirname(finalPath), { recursive: true }).then(() => new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath)
    const hash = crypto.createHash('sha256')
    let size = 0
    let settled = false

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
        abort(Object.assign(new Error('media upload exceeds size cap'), { code: 'too_large' }))
        return
      }
      hash.update(chunk)
      if (!out.write(chunk)) req.pause()
    })
    out.on('drain', () => { if (!settled) req.resume() })

    req.on('end', () => {
      if (settled) return
      settled = true
      out.end(() => {
        if (size === 0) {
          fs.promises.unlink(tmpPath).catch(() => {})
            .finally(() => reject(Object.assign(new Error('empty media upload'), { code: 'empty' })))
          return
        }
        fs.promises.rename(tmpPath, finalPath)
          .then(() => resolve({ id, size, sha256: hash.digest('hex'), diskPath: finalPath }))
          .catch((err) => { fs.promises.unlink(tmpPath).catch(() => {}); reject(err) })
      })
    })
    req.on('error', abort)
    req.on('close', () => abort(new Error('connection closed')))
    out.on('error', abort)
  }))
}
