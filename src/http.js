import fs from 'node:fs'
import { login, authToken, changePassword } from './auth.js'
import { snapshot, messagesBefore, toEventShape } from './journal.js'
import { insertBlob, getBlob, setApnsRegistration } from './db.js'
import { receiveBlob } from './media.js'
import { buildMetrics } from './metrics.js'

const json = (res, status, obj) => {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

const readBody = (req) => new Promise((resolve, reject) => {
  let data = ''
  let settled = false
  const fail = (err) => { if (!settled) { settled = true; reject(err) } }
  req.setEncoding('utf8')
  req.on('data', (c) => {
    data += c
    if (data.length > 1e6) {
      req.removeAllListeners('data')
      req.pause()
      fail(Object.assign(new Error('body too large'), { statusCode: 413 }))
    }
  })
  req.on('end', () => {
    if (settled) return
    settled = true
    if (!data) { resolve({}); return }
    let parsed
    try {
      parsed = JSON.parse(data)
    } catch {
      reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }))
      return
    }
    // Shared guard for every POST handler below: any JSON value that isn't a
    // plain object (literal `null`, an array, or a bare string/number/bool)
    // would otherwise reach a handler's `const {x} = body` destructure and
    // either throw outright (null → 500) or silently produce `undefined`
    // fields that fail deeper and less legibly (e.g. as a DB bind-type
    // error → 500).
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      reject(Object.assign(new Error('request body must be a JSON object'), { statusCode: 400 }))
      return
    }
    resolve(parsed)
  })
  req.on('close', () => fail(new Error('connection closed')))
  req.on('error', fail)
})

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer /, '') || null

// For a reject that fires BEFORE anything has ever read the request body
// (rate-limited /login, unauthenticated everything-else) — the body (if
// any) is sitting there unconsumed. Draining it with `req.resume()` would
// work but reads an attacker-controlled, potentially unbounded body to
// completion before the socket could be reused (no size cap applies pre-auth
// here, unlike readBody's own 413 path). Simpler and safer: send the
// response, then destroy the connection once it's flushed — this also
// avoids leaving unread bytes on a keep-alive socket to desync the next
// request's parse, same concern as readBody's existing 413 handling below.
const rejectEarly = (req, res, status, obj) => {
  res.on('finish', () => req.destroy())
  return json(res, status, obj)
}

export function makeHttpHandler({ db, rateLimiter, loginGuard, mediaDir, mediaMaxBytes, hub, pushPipeline, dbPath }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      if (req.method === 'POST' && url.pathname === '/login') {
        // Behind the cloudflared tunnel, req.socket.remoteAddress is always 127.0.0.1
        // (the tunnel is the only route in, so this header is trustworthy here).
        // Fall back to remoteAddress for direct/local connections (e.g. tests).
        const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown'
        if (!rateLimiter.allow(ip)) return rejectEarly(req, res, 429, { error: 'rate_limited' })
        const { username, password, device_name } = await readBody(req)
        // Structural validation BEFORE the login guard and user lookup: a
        // missing/non-string/empty username or password can never be valid
        // credentials, so rejecting here leaks nothing about which users
        // exist (anti-enumeration preserved) and keeps garbage out of the
        // guard's per-username state. Without this, undefined fields reach
        // login() and throw deep inside it (argon2/SQLite bind) → a 500
        // from the generic catch — on an endpoint whose own auth is the
        // only guard. Note readBody has already consumed the body, so a
        // plain json() reject is right here (rejectEarly is for pre-body
        // rejects only); the per-IP rate limiter above has already counted
        // this request, matching the existing convention for malformed
        // bodies (readBody's own 400s are counted the same way).
        if (typeof username !== 'string' || !username ||
            typeof password !== 'string' || !password) {
          return json(res, 400, { error: 'bad_request' })
        }
        const guardKey = String(username ?? '')
        const gate = loginGuard.check(guardKey)
        if (!gate.allowed) {
          const retryAfter = Math.ceil(gate.retryAfterMs / 1000)
          res.setHeader('Retry-After', retryAfter)
          return json(res, 429, { error: 'locked_out', retry_after: retryAfter })
        }
        const s = await login(db, { username, password, deviceName: device_name })
        if (!s) { loginGuard.fail(guardKey); return json(res, 403, { error: 'bad_credentials' }) }
        loginGuard.ok(guardKey)
        return json(res, 200, { token: s.token, device_id: s.deviceId, user_id: s.userId })
      }
      const who = bearer(req) && authToken(db, bearer(req))
      if (!who) return rejectEarly(req, res, 401, { error: 'unauthenticated' })
      if (req.method === 'GET' && url.pathname === '/snapshot') {
        return json(res, 200, snapshot(db, who.userId))
      }
      if (req.method === 'GET' && url.pathname === '/metrics') {
        // Any valid device (client or agent) — no admin-only concept in v1.
        // Scoping (no cross-user leakage) is enforced inside buildMetrics.
        return json(res, 200, buildMetrics(db, { hub, pushPipeline, dbPath, userId: who.userId }))
      }
      if (req.method === 'POST' && url.pathname === '/push/register') {
        // Only client devices carry push tokens — agents run on the dev box
        // itself and are never pushed to.
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        const body = await readBody(req)
        const { apns_token, environment } = body
        if (apns_token === null) {
          setApnsRegistration(db, who.deviceId, { apnsToken: null, apnsEnv: null })
          return json(res, 200, { ok: true })
        }
        if (typeof apns_token !== 'string' || !apns_token) return json(res, 400, { error: 'bad_request' })
        if (environment !== 'sandbox' && environment !== 'prod') return json(res, 400, { error: 'bad_request' })
        setApnsRegistration(db, who.deviceId, { apnsToken: apns_token, apnsEnv: environment })
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && url.pathname === '/password') {
        // Self-service change, client devices only — an agent (the bridge)
        // never holds/knows a user's password.
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        const { old_password, new_password } = await readBody(req)
        if (typeof old_password !== 'string' || !old_password) return json(res, 400, { error: 'bad_request' })
        if (typeof new_password !== 'string' || new_password.length < 8) return json(res, 400, { error: 'weak_password' })
        const r = await changePassword(db, who.userId, { oldPassword: old_password, newPassword: new_password })
        if (!r.ok) return json(res, 401, { error: 'bad_password' })
        return json(res, 200, { ok: true })
      }
      const m = url.pathname.match(/^\/convo\/([^/]+)\/messages$/)
      if (req.method === 'GET' && m) {
        let convoId
        try {
          convoId = decodeURIComponent(m[1])
        } catch (e) {
          if (e instanceof URIError) return json(res, 400, { error: 'bad_request' })
          throw e
        }
        let beforeSeq = null
        if (url.searchParams.has('before_seq')) {
          beforeSeq = Number(url.searchParams.get('before_seq'))
          if (!Number.isInteger(beforeSeq)) return json(res, 400, { error: 'bad_request' })
        }
        const rawLimit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50
        if (!Number.isInteger(rawLimit) || rawLimit < 1) return json(res, 400, { error: 'bad_request' })
        const limit = Math.min(rawLimit, 200)
        try {
          const events = messagesBefore(db, who.userId, convoId, { beforeSeq, limit }).map(toEventShape)
          return json(res, 200, { events })
        } catch (e) {
          // Unauthorized and missing are indistinguishable: both 404, same
          // body as GET /media/:id's unknown-id response — never 403 (that
          // would confirm the convo id exists to a caller who can't read it).
          if (/not authorized/.test(e.message)) return json(res, 404, { error: 'not_found' })
          throw e
        }
      }
      if (req.method === 'POST' && url.pathname === '/media') {
        let received
        try {
          received = await receiveBlob(req, { root: mediaDir, maxBytes: mediaMaxBytes })
        } catch (e) {
          if (e.code === 'empty') return json(res, 400, { error: 'empty' })
          if (e.code === 'too_large') throw Object.assign(new Error('too large'), { statusCode: 413 })
          throw e
        }
        const contentType = req.headers['content-type'] || 'application/octet-stream'
        try {
          insertBlob(db, {
            id: received.id,
            ownerUserId: who.userId,
            contentType,
            size: received.size,
            sha256: received.sha256,
            diskPath: received.diskPath,
          })
        } catch (e) {
          // receiveBlob already renamed the tmp file into its final sharded
          // path before this runs — if the DB insert throws (e.g. a
          // transient SQLite error), that file would otherwise be orphaned
          // on disk with no row ever pointing at it. Best-effort cleanup
          // (nothing more useful to do if the unlink itself fails) before
          // falling through to the outer catch's generic 500.
          await fs.promises.unlink(received.diskPath).catch(() => {})
          throw e
        }
        return json(res, 200, { media_id: received.id, size: received.size, content_type: contentType, sha256: received.sha256 })
      }
      const mm = url.pathname.match(/^\/media\/([^/]+)$/)
      if (req.method === 'GET' && mm) {
        // Missing and not-owned are made indistinguishable (404, never 403): a
        // media id is an unguessable random handle, so there is nothing an
        // owner learns from a 403 that a 404 doesn't already hide just as well,
        // and callers can't probe for the existence of someone else's blob.
        const blob = getBlob(db, mm[1])
        if (!blob || blob.owner_user_id !== who.userId) return json(res, 404, { error: 'not_found' })
        // Stat the file before ever committing to a 200: the DB row can
        // outlive/disagree with the file on disk (deleted out from under
        // it, truncated by a disk issue, etc). Catching that here means a
        // clean 500 instead of writeHead(200) + a declared content-length
        // followed by the stream erroring mid-flight and resetting the
        // connection.
        let stat
        try {
          stat = await fs.promises.stat(blob.disk_path)
        } catch (e) {
          console.error(`media: blob ${blob.id} row exists but its disk_path is unreadable`, e)
          return json(res, 500, { error: 'internal' })
        }
        if (stat.size !== blob.size) {
          console.error(`media: blob ${blob.id} on-disk size (${stat.size}) does not match the DB row (${blob.size})`)
          return json(res, 500, { error: 'internal' })
        }
        res.writeHead(200, {
          'content-type': blob.content_type,
          'content-length': String(blob.size),
          'cache-control': 'private, max-age=31536000, immutable',
        })
        await new Promise((resolve) => {
          const stream = fs.createReadStream(blob.disk_path)
          stream.on('error', () => { res.destroy(); resolve() })
          stream.on('close', resolve)
          stream.pipe(res)
        })
        return
      }
      return json(res, 404, { error: 'not_found' })
    } catch (e) {
      if (e.statusCode === 413) {
        // The request body was left partially unconsumed (readBody stopped
        // draining it once the size cap tripped), so this socket cannot be
        // safely reused for a subsequent keep-alive request — leftover body
        // bytes would desync the next request's parse, and Node will not
        // otherwise destroy the socket, leaking it indefinitely. Force close.
        res.setHeader('Connection', 'close')
        return json(res, 413, { error: 'too_large' })
      }
      if (e.statusCode === 400) return json(res, 400, { error: 'bad_request' })
      // Never leak e.message to the client (could echo internals like a SQL
      // error) — log it server-side instead.
      console.error('http handler error:', e)
      return json(res, 500, { error: 'internal' })
    }
  }
}
