import crypto from 'node:crypto'
import fs from 'node:fs'
import { login, authToken, changePassword, revokeOwnedDevice, createAgent, createClientDevice } from './auth.js'
import { snapshot, messagesBefore, toEventShape } from './journal.js'
import { insertBlob, getBlob, setApnsRegistration, listDevices, setPushPrefs, getPushPrefs } from './db.js'
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

// Constant-time compare, same idiom as src/rendezvous.js's secretMatches:
// the length check leaks only the key's length, which is public (always 64
// hex chars minted by ensurePreapproveKey).
function preapproveKeyMatches(expected, given) {
  const a = Buffer.from(String(expected))
  const b = Buffer.from(String(given))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

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

export function makeHttpHandler({ db, rateLimiter, loginGuard, mediaDir, mediaMaxBytes, hub, pushPipeline, dbPath, pairs, links, preapproveKey }) {
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
        // device_name is optional (login() defaults it), but when present it
        // must be a string or null — a non-primitive would otherwise 500 in
        // issueDevice's INSERT bind, and even with valid credentials a 500
        // there is wrong. Numbers previously bound fine (200); rejecting
        // them too is a deliberate tightening to one canonical shape.
        if (typeof username !== 'string' || !username ||
            typeof password !== 'string' || !password ||
            (device_name != null && typeof device_name !== 'string')) {
          return json(res, 400, { error: 'bad_request' })
        }
        const gate = loginGuard.check(username)
        if (!gate.allowed) {
          const retryAfter = Math.ceil(gate.retryAfterMs / 1000)
          res.setHeader('Retry-After', retryAfter)
          return json(res, 429, { error: 'locked_out', retry_after: retryAfter })
        }
        const s = await login(db, { username, password, deviceName: device_name })
        if (!s) { loginGuard.fail(username); return json(res, 403, { error: 'bad_credentials' }) }
        loginGuard.ok(username)
        return json(res, 200, { token: s.token, device_id: s.deviceId, user_id: s.userId })
      }
      if (req.method === 'POST' && url.pathname === '/pair/start') {
        // Unauthenticated by design: this grants nothing — the pair becomes
        // an agent only if an authenticated client approves the code, and
        // it binds to whichever user approves. Shares /login's per-IP
        // limiter instance (spec: same budget class) so the whole
        // unauthenticated surface sits under one throttle.
        const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown'
        if (!rateLimiter.allow(ip)) return rejectEarly(req, res, 429, { error: 'rate_limited' })
        await readBody(req) // no fields today; still drains/validates the body
        // The requester IP rides along on the pending pair so /pair/preview
        // can show the approval screen who is asking.
        const p = pairs.start({ requesterIp: ip })
        // Pending-map cap: same envelope as the limiter — a caller can't
        // tell which throttle it hit, and shouldn't need to.
        if (!p) return json(res, 429, { error: 'rate_limited' })
        return json(res, 200, { pair_code: p.pairCode, poll_token: p.pollToken, expires_in: p.expiresIn })
      }
      if (req.method === 'POST' && url.pathname === '/pair/claim') {
        // Deliberately not rate-limited: the box polls this every few
        // seconds for up to the TTL, and each miss costs one Map.get on a
        // 256-bit key — guessing poll_tokens is not a realistic attack.
        const { poll_token } = await readBody(req)
        if (typeof poll_token !== 'string' || !poll_token) return json(res, 400, { error: 'bad_request' })
        const c = pairs.claim(poll_token)
        if (c.status === 'not_found') return json(res, 404, { error: 'not_found' })
        if (c.status === 'pending') return json(res, 200, { status: 'pending' })
        // Mint at claim (spec): the devices row first exists HERE. The pair
        // is already deleted; if createAgent somehow threw, the box retries
        // with a fresh code and no orphan row exists either way.
        const d = createAgent(db, c.userId, c.agentName)
        return json(res, 200, { status: 'approved', token: d.token, device_id: d.deviceId })
      }
      if (req.method === 'POST' && url.pathname === '/link/claim') {
        // Unauthenticated by design: claiming grants nothing — the session
        // signs a device in only after the starter approves on its own
        // screen. Shares /login's per-IP limiter instance so the whole
        // unauthenticated surface sits under one throttle.
        const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown'
        if (!rateLimiter.allow(ip)) return rejectEarly(req, res, 429, { error: 'rate_limited' })
        const { link_code, device_name } = await readBody(req)
        const name = typeof device_name === 'string' ? device_name.trim() : ''
        if (typeof link_code !== 'string' || !link_code || !name || name.length > 64) {
          return json(res, 400, { error: 'bad_request' })
        }
        const c = links.claim(link_code, { deviceName: name, requesterIp: ip })
        // conflict (already claimed) is distinguishable from 404: telling
        // the second claimant the code was used leaks nothing useful and
        // produces the right UI message. Unknown/expired stay merged.
        if (c.status === 'not_found') return json(res, 404, { error: 'not_found' })
        if (c.status === 'conflict') return json(res, 409, { error: 'conflict' })
        return json(res, 200, { status: 'claimed', claim_token: c.claimToken, expires_in: c.expiresIn })
      }
      if (req.method === 'POST' && url.pathname === '/link/poll') {
        // Deliberately not rate-limited: the claimant polls every few
        // seconds for up to the TTL, and each miss costs one bounded scan
        // keyed on a 256-bit token — same stance as /pair/claim.
        const { claim_token } = await readBody(req)
        if (typeof claim_token !== 'string' || !claim_token) return json(res, 400, { error: 'bad_request' })
        const p = links.poll(claim_token)
        if (p.status === 'not_found') return json(res, 404, { error: 'not_found' })
        if (p.status === 'pending') return json(res, 200, { status: 'pending' })
        if (p.status === 'denied') return json(res, 200, { status: 'denied' })
        // Mint at poll (spec §1): the devices row first exists HERE, and the
        // session is already deleted (one-shot). username rides along because
        // the apps store the typed username as UserSession.userID and a link
        // claimant never types one.
        const user = db.prepare('SELECT name FROM users WHERE id=?').get(p.userId)
        if (!user) return json(res, 404, { error: 'not_found' }) // user row gone mid-flow; claimant rescans
        const d = createClientDevice(db, p.userId, p.deviceName)
        return json(res, 200, { status: 'approved', token: d.token, device_id: d.deviceId, user_id: p.userId, username: user.name })
      }
      if (req.method === 'POST' && url.pathname === '/link/preapprove') {
        // Root-on-the-box only (spec §3): accepted ONLY from a loopback
        // socket with no proxy-forwarding header. External traffic always
        // arrives via the reverse proxy, which adds X-Forwarded-*, X-Real-IP,
        // or cf-connecting-ip through the tunnel — so a forwarded request can
        // never look local. To the outside world this endpoint does not
        // exist: everything rejected is a plain 404.
        //
        // That guard alone is defeated by a headerless reverse proxy (a
        // default-config nginx `proxy_pass` with no `proxy_set_header`
        // lines adds none of the above) — traffic proxied straight through
        // to a loopback-bound journal would then pass unnoticed (Bugbot
        // finding, PR #29). x-preapprove-key is the independent second
        // factor: a 64-hex-char secret auto-minted next to the DB
        // (src/preapprove-key.js) that never leaves the box except via a
        // local file read, so a headerless proxy still can't forge it.
        // Missing/wrong key gets the exact same 404 as the other guard
        // failures — indistinguishable from the outside.
        const remote = req.socket.remoteAddress
        const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
        const forwarded = Object.keys(req.headers).some((h) => h.startsWith('x-forwarded-')) ||
          req.headers.forwarded !== undefined || req.headers['cf-connecting-ip'] !== undefined ||
          req.headers['x-real-ip'] !== undefined
        const suppliedKey = req.headers['x-preapprove-key']
        const keyOk = typeof suppliedKey === 'string' && suppliedKey.length > 0 &&
          preapproveKeyMatches(preapproveKey, suppliedKey)
        if (!loopback || forwarded || !keyOk) return rejectEarly(req, res, 404, { error: 'not_found' })
        const { username } = await readBody(req)
        if (typeof username !== 'string' || !username) return json(res, 400, { error: 'bad_request' })
        const user = db.prepare('SELECT id FROM users WHERE name=?').get(username)
        if (!user) return json(res, 404, { error: 'not_found' })
        const l = links.startPreapproved(user.id)
        // Pending-map cap: same envelope as the limiter — a caller can't
        // tell which throttle it hit, and shouldn't need to.
        if (!l) return json(res, 429, { error: 'rate_limited' })
        return json(res, 200, { link_code: l.linkCode, expires_in: l.expiresIn })
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
          return json(res, 200, { ok: true, push_prefs: getPushPrefs(db, who.deviceId) })
        }
        if (typeof apns_token !== 'string' || !apns_token) return json(res, 400, { error: 'bad_request' })
        if (environment !== 'sandbox' && environment !== 'prod') return json(res, 400, { error: 'bad_request' })
        setApnsRegistration(db, who.deviceId, { apnsToken: apns_token, apnsEnv: environment })
        return json(res, 200, { ok: true, push_prefs: getPushPrefs(db, who.deviceId) })
      }
      if (req.method === 'PUT' && url.pathname === '/push/prefs') {
        // Prefs live on the device row next to the APNs token they gate —
        // same client-only surface as /push/register.
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        const body = await readBody(req)
        for (const [k, v] of Object.entries(body)) {
          if (!['attention', 'done', 'activity'].includes(k) || typeof v !== 'boolean') {
            return json(res, 400, { error: 'bad_request' })
          }
        }
        return json(res, 200, { ok: true, push_prefs: setPushPrefs(db, who.deviceId, body) })
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
      if (req.method === 'GET' && url.pathname === '/devices') {
        // Management surface: client devices only, same gating as /password —
        // an agent has no business enumerating its user's other devices.
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        // connected = has a live WS right now (hub scan, no persistence) —
        // the roster's "which agents can I start a session on" signal.
        const live = new Set(hub.connsOf(who.userId).filter((c) => c.ws.readyState === 1).map((c) => c.deviceId))
        const devices = listDevices(db, who.userId).map((d) => ({
          ...d, is_self: d.device_id === who.deviceId, connected: live.has(d.device_id),
        }))
        return json(res, 200, { devices })
      }
      const dm = url.pathname.match(/^\/devices\/(\d+)\/revoke$/)
      if (req.method === 'POST' && dm) {
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        // Deleting the row IS the revocation (docs/protocol.md "Device
        // revocation"): HTTP 401s on the next call, WS closes next-frame or
        // via the ≤60s sweep. Not-owned and nonexistent are indistinguishable.
        if (!revokeOwnedDevice(db, who.userId, Number(dm[1]))) return json(res, 404, { error: 'not_found' })
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && url.pathname === '/pair/approve') {
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        const { pair_code, agent_name } = await readBody(req)
        if (typeof pair_code !== 'string' || !pair_code ||
            typeof agent_name !== 'string' || !agent_name) {
          return json(res, 400, { error: 'bad_request' })
        }
        const r = pairs.approve(pair_code, { userId: who.userId, agentName: agent_name })
        // conflict (already approved) is distinguishable — the caller is
        // authenticated, so this leaks nothing exploitable and tells a
        // double-tapping user the truth. Unknown and expired stay merged
        // into 404, same anti-enumeration stance as everywhere else.
        if (r === 'conflict') return json(res, 409, { error: 'conflict' })
        if (r === 'not_found') return json(res, 404, { error: 'not_found' })
        return json(res, 200, { status: 'approved' })
      }
      if (req.method === 'POST' && url.pathname === '/pair/preview') {
        // The approval screen calls this before /pair/approve to show who is
        // asking (the spec's security analysis requires the requesting IP on
        // the screen). Client devices only, same gating as approve.
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        const { pair_code } = await readBody(req)
        if (typeof pair_code !== 'string' || !pair_code) return json(res, 400, { error: 'bad_request' })
        // Unknown, expired, and already-approved all merge into 404 —
        // anti-enumeration as everywhere else, and an approved pair can't be
        // approved again so there is nothing useful left to preview. Code
        // enumeration through this endpoint would mean an authenticated
        // client grinding a 39-bit code space one HTTP round-trip at a time,
        // for a payoff of one IP address — not a realistic attack.
        const v = pairs.preview(pair_code)
        if (!v) return json(res, 404, { error: 'not_found' })
        return json(res, 200, { requester_ip: v.requesterIp, expires_in: v.expiresIn })
      }
      if (req.method === 'POST' && url.pathname === '/link/start') {
        // Show-QR side. Client devices only: an agent can't invite devices.
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        await readBody(req) // no fields today; still drains/validates the body
        const l = links.start(who.deviceId, who.userId)
        // Pending-map cap: same envelope as the limiter — a caller can't
        // tell which throttle it hit, and shouldn't need to.
        if (!l) return json(res, 429, { error: 'rate_limited' })
        return json(res, 200, { link_code: l.linkCode, expires_in: l.expiresIn })
      }
      if (req.method === 'POST' && url.pathname === '/link/status') {
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        await readBody(req)
        // Starter-device bound: keyed by who.deviceId, so another device of
        // the same user simply has no session here (404, not 403).
        const st = links.status(who.deviceId)
        if (!st) return json(res, 404, { error: 'not_found' })
        if (st.status === 'waiting') return json(res, 200, { status: 'waiting', expires_in: st.expiresIn })
        return json(res, 200, { status: 'claimed', device_name: st.deviceName, requester_ip: st.requesterIp, expires_in: st.expiresIn })
      }
      if (req.method === 'POST' && url.pathname === '/link/approve') {
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        const { link_code } = await readBody(req)
        if (typeof link_code !== 'string' || !link_code) return json(res, 400, { error: 'bad_request' })
        const r = links.approve(who.deviceId, link_code)
        // conflict = "nothing claimed yet, or already resolved" — the caller
        // is the authenticated starter, so the truth leaks nothing.
        if (r === 'conflict') return json(res, 409, { error: 'conflict' })
        if (r === 'not_found') return json(res, 404, { error: 'not_found' })
        return json(res, 200, { status: 'approved' })
      }
      if (req.method === 'POST' && url.pathname === '/link/deny') {
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        const { link_code } = await readBody(req)
        if (typeof link_code !== 'string' || !link_code) return json(res, 400, { error: 'bad_request' })
        const r = links.deny(who.deviceId, link_code)
        if (r === 'not_found') return json(res, 404, { error: 'not_found' })
        return json(res, 200, { status: 'denied' })
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
