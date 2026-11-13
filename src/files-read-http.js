// Owner-only file viewer reads, jailed to pinned roots and secret-path policy.
import path from 'node:path'
import os from 'node:os'
import { readlinkSync } from 'node:fs'
import { resolvePreapproveKeyPath } from './preapprove-key.js'
import { parseOwnerUserId } from './owner-user-id.js'
import { json } from './http-body.js'
import { openGuarded, metaGuarded, contentTypeFor, FileLinkDenied, denialToStatus,
  MAX_VIEW_BYTES, MAX_DOWNLOAD_BYTES, pinAllowedRootsSync, withReadPolicy } from './file-guard.js'

export const isFilesPath = (pathname) => pathname === '/files' || pathname.startsWith('/files/')
const dispositionFilename = (name) => String(name).replace(/["\\\r\n]/g, '_')

function serviceUserHome() {
  try { return os.userInfo().homedir } catch { return os.homedir() }
}

export function resolveFileReads({ fileReadRoots, fileOwnerUserId, procSelfFdAvailable, fileHomeDir, dbPath: resolvedDbPath, mediaDir: resolvedMediaDir, preapproveKeyPath }) {
  const fileRootsConfigured = fileReadRoots !== undefined
    ? fileReadRoots
    : (process.env.MATRON_FILE_READ_ROOTS !== undefined
        ? process.env.MATRON_FILE_READ_ROOTS.split(':').filter(Boolean)
        : null)
  const procFdOk = procSelfFdAvailable ?? (() => {
    try { readlinkSync('/proc/self/fd/0'); return true } catch { return false }
  })()
  let resolvedFileReadRoots = null
  if (Array.isArray(fileRootsConfigured) && fileRootsConfigured.length > 0) {
    if (!procFdOk) {
      console.warn('file API: disabled — /proc/self/fd unavailable; refusing the racy realpath fallback (set up on a Linux host to enable)')
    } else {
      resolvedFileReadRoots = pinAllowedRootsSync(fileRootsConfigured)
    }
  } else if (Array.isArray(fileRootsConfigured)) {
    console.warn('file API: disabled — configured read-root list is empty')
  }
  const serverStatePaths = [
    resolvedDbPath === ':memory:' ? null : resolvedDbPath,
    resolvedDbPath === ':memory:' ? null : `${resolvedDbPath}-wal`,
    resolvedDbPath === ':memory:' ? null : `${resolvedDbPath}-shm`,
    resolvedDbPath === ':memory:' ? null : resolvePreapproveKeyPath(resolvedDbPath, preapproveKeyPath),
    resolvedMediaDir,
  ].filter(Boolean)
  // The server state is refused to reads: the database holds
  // every transcript and device-token hash, and its directory also holds the
  // bridge's agent credentials. The named state files are always denied; the
  // data directory is a denied TREE, which yields only inside a root that was
  // configured within it (a broader root never reaches into it).
  const readPolicy = {
    denyPaths: serverStatePaths,
    denyTrees: resolvedDbPath === ':memory:' ? [] : [path.dirname(resolvedDbPath)],
    homeDir: fileHomeDir !== undefined ? fileHomeDir : serviceUserHome(),
  }
  if (resolvedFileReadRoots) resolvedFileReadRoots = withReadPolicy(resolvedFileReadRoots, readPolicy)
  // File viewer owner (MATRON_FILE_OWNER_USER_ID): the one user whose client
  // devices may use /files*. Authentication proves a device is ours; this is
  // the authorization dimension — the read roots are the server's disk,
  // not a per-user space, so no other user (admin or not) may reach them.
  // Fails closed: absent/unparseable leaves the routes answering 500.
  const resolvedFileOwnerUserId = parseOwnerUserId(
    fileOwnerUserId !== undefined
      ? (fileOwnerUserId === null ? undefined : String(fileOwnerUserId))
      : process.env.MATRON_FILE_OWNER_USER_ID
  )
  if (resolvedFileReadRoots && resolvedFileOwnerUserId === null) {
    console.error('file API: MATRON_FILE_OWNER_USER_ID is absent or is not a positive integer — every /files request will be refused until it is set')
  }
  return { fileReadRoots: resolvedFileReadRoots, fileOwnerUserId: resolvedFileOwnerUserId }
}

export function makeFilesReadHandler({ fileReadRoots, fileOwnerUserId = null } = {}) {
  const fileOwnerId = typeof fileOwnerUserId === 'number'
    ? (Number.isSafeInteger(fileOwnerUserId) && fileOwnerUserId > 0 ? fileOwnerUserId : null)
    : parseOwnerUserId(fileOwnerUserId)
  return async (req, res, url, who, rejectEarly) => {
    if (!fileReadRoots || !isFilesPath(url.pathname)) return false
    if (who.kind !== 'client') { rejectEarly(req, res, 403, { error: 'forbidden' }); return true }
    if (fileOwnerId === null) {
      console.error('file viewer reads: MATRON_FILE_OWNER_USER_ID is absent or invalid')
      rejectEarly(req, res, 500, { error: 'internal' }); return true
    }
    if (who.userId !== fileOwnerId) { rejectEarly(req, res, 403, { error: 'forbidden' }); return true }
    if (req.method !== 'GET' || !['/files/meta', '/files/content'].includes(url.pathname)) {
      json(res, 404, { error: 'not_found' }); return true
    }
    await (async () => {
    if (fileReadRoots && req.method === 'GET' && url.pathname === '/files/meta') {
      if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
      const p = url.searchParams.get('path')
      if (typeof p !== 'string' || !path.isAbsolute(p)) return json(res, 400, { error: 'bad_request' })
      let meta
      try {
        meta = await metaGuarded(p, { allowedRoots: fileReadRoots })
      } catch (e) {
        if (e instanceof FileLinkDenied) return json(res, denialToStatus(e.reason), { error: 'denied' })
        return json(res, 404, { error: 'not_found' })
      }
      return json(res, 200, {
        path: meta.realPath,
        kind: meta.kind,
        size: meta.size,
        mtime: meta.mtime,
        mime: meta.mime,
        is_text: meta.is_text,
      })
    }
    if (fileReadRoots && req.method === 'GET' && url.pathname === '/files/content') {
      if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
      const p = url.searchParams.get('path')
      if (typeof p !== 'string' || !path.isAbsolute(p)) return json(res, 400, { error: 'bad_request' })
      const attachment = url.searchParams.get('disposition') === 'attachment'
      const maxBytes = attachment ? MAX_DOWNLOAD_BYTES : MAX_VIEW_BYTES
      // Single idempotent fd-close covering EVERY terminal path (denial,
      // cap/416 rejects, empty body, stream end/error, AND a client abort at
      // any point — including while openGuarded() is still awaiting). `fd` is
      // filled once the handle is validated; `streaming` gates whether an
      // abort should close the fd directly (pre-stream) or tear the stream
      // down and let its 'close' close the fd (mid-stream — closing the fd
      // under an active read would error it).
      let fd = null
      let fdClosed = false
      let streaming = false
      let aborted = false
      const closeFd = () => { if (fdClosed || !fd) return; fdClosed = true; fd.close().catch(() => {}) }
      const onEarlyAbort = () => { aborted = true; if (!streaming) closeFd() }
      res.on('close', onEarlyAbort)
      try {
        let opened
        try {
          // openGuarded checks fd-pinned, symlink-proof containment and
          // sensitivity checks and returns the OPEN fd
          // WITHOUT reading — we STREAM it with backpressure, never
          // buffering the whole file. Never readBody (JSON/1MB).
          opened = await openGuarded(p, { allowedRoots: fileReadRoots })
        } catch (e) {
          res.removeListener('close', onEarlyAbort)
          // Guard contract: map ANY throw to a denial (404 default), not just
          // FileLinkDenied — an unexpected fs error must not leak/500.
          if (e instanceof FileLinkDenied) return json(res, denialToStatus(e.reason), { error: 'denied' })
          return json(res, 404, { error: 'not_found' })
        }
        fd = opened.fd
        const { size, realPath } = opened
        // The client may have disconnected WHILE openGuarded was awaiting —
        // onEarlyAbort ran with fd still null (no close), so close the now-
        // validated fd and bail before writing anything.
        if (aborted || res.destroyed) { res.removeListener('close', onEarlyAbort); closeFd(); return }
        // Cap on the FULL file size, decided from fstat BEFORE any byte is
        // read (so an oversized download never allocates or streams).
        if (size > maxBytes) { res.removeListener('close', onEarlyAbort); closeFd(); return json(res, 413, { error: 'too_large' }) }
        const { type, inlineSafe } = contentTypeFor(realPath)
        // Force download for a non-inline-safe type even if inline was asked
        // (nothing script-capable renders inline on this origin).
        const disposition = attachment || !inlineSafe ? 'attachment' : 'inline'
        const headers = {
          'content-type': type,
          'cache-control': 'private',
          'x-content-type-options': 'nosniff',
          'accept-ranges': 'bytes',
          'content-disposition': `${disposition}; filename="${dispositionFilename(path.basename(realPath))}"`,
        }
        // Compute the Range window from `size` BEFORE reading — only the
        // selected interval is streamed (createReadStream end is inclusive).
        let statusCode = 200
        let start = 0
        let end = size > 0 ? size - 1 : 0
        const range = req.headers.range
        if (range) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(range)
          if (!m || (m[1] === '' && m[2] === '')) {
            res.removeListener('close', onEarlyAbort)
            closeFd()
            res.writeHead(416, { 'content-range': `bytes */${size}` })
            return res.end()
          }
          let s = m[1] === '' ? null : Number(m[1])
          let e = m[2] === '' ? null : Number(m[2])
          if (s === null) {
            // suffix range: last `e` bytes
            s = Math.max(0, size - e)
            e = size - 1
          } else if (e === null || e >= size) {
            e = size - 1
          }
          if (!Number.isInteger(s) || s > e || s >= size || s < 0) {
            res.removeListener('close', onEarlyAbort)
            closeFd()
            res.writeHead(416, { 'content-range': `bytes */${size}` })
            return res.end()
          }
          statusCode = 206
          start = s
          end = e
          headers['content-range'] = `bytes ${start}-${end}/${size}`
        }
        const length = size === 0 ? 0 : (end - start + 1)
        res.writeHead(statusCode, { ...headers, 'content-length': String(length) })
        if (length === 0) { res.removeListener('close', onEarlyAbort); closeFd(); return res.end() }
        await new Promise((resolve) => {
          // Hand off from the pre-stream abort listener to stream teardown:
          // once streaming, an abort must destroy the stream (its 'close'
          // then closes the fd) rather than close the fd out from under it.
          res.removeListener('close', onEarlyAbort)
          streaming = true
          const stream = fd.createReadStream({ start, end, autoClose: false })
          let settled = false
          const finish = () => { if (settled) return; settled = true; closeFd(); resolve() }
          stream.on('error', () => { res.destroy(); finish() })
          stream.on('close', finish)
          res.on('close', () => stream.destroy())
          // Race guard: the socket may already have closed between the check
          // above and attaching the listener — tear down immediately if so.
          if (res.destroyed) stream.destroy()
          stream.pipe(res)
        })
        return
      } catch (e) {
        res.removeListener('close', onEarlyAbort)
        closeFd()
        throw e
      }
    }
    })()
    return true
  }
}
