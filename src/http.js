import crypto from 'node:crypto'
import fs from 'node:fs'
import { login, authToken, changePassword, revokeOwnedDevice, renameOwnedDevice, createAgent, createClientDevice, authorizeAgentWrite } from './auth.js'
import { snapshot, messagesBefore, messagesAround, messagesAroundIndexed, toEventShape, isClientOnlyEvent } from './journal.js'
import { insertBlob, getBlob, setApnsRegistration, listDevices, userBlobBytes, setPushPrefs, getPushPrefs, isPrivateDevice } from './db.js'
import { receiveBlob } from './media.js'
import { buildMetrics } from './metrics.js'
import { listAwaiting, answerParkedInvite, getParticipant } from './participants.js'
import { sanitizePeerText, PEER_NAME_CAP } from './peer-text.js'
import { deliverPendingInvites } from './invite-delivery.js'
import { searchMessages, indexableBody } from './search.js'
import { getSpawn, denySpawn, claimApprove, approveSpawn } from './spawns.js'

// A device name on its way to a client: same sieve and cap the live consent
// card's `from_name` gets. NULL stays null rather than collapsing to '' —
// "this device is gone" and "this device is named the empty string" are
// different facts, and the apps render the id instead for the former.
const deviceName = (raw) => (raw == null ? null : sanitizePeerText(raw, PEER_NAME_CAP))

// User-facing device-name cap. Deliberately tighter than PEER_NAME_CAP (80,
// the sanitiser's bound for peer-written text): a device name is a chip
// label in the apps, and 40 chars is already more than a chip can show.
const DEVICE_NAME_MAX = 40

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

export function makeHttpHandler({ db, rateLimiter, loginGuard, mediaDir, mediaMaxBytes, mediaUserQuotaBytes = Infinity, hub, pushPipeline, dbPath, pairs, links, preapproveKey, broker, spawnStartTimeoutMs = 30000 }) {
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
        const { username, ttl_seconds } = await readBody(req)
        if (typeof username !== 'string' || !username) return json(res, 400, { error: 'bad_request' })
        // Optional hand-off TTL (spec §3): bounded here so the store clamp
        // is belt-and-braces, not the operator's error report.
        if (ttl_seconds !== undefined &&
            (!Number.isInteger(ttl_seconds) || ttl_seconds < 60 || ttl_seconds > 86400)) {
          return json(res, 400, { error: 'bad_request' })
        }
        const user = db.prepare('SELECT id FROM users WHERE name=?').get(username)
        if (!user) return json(res, 404, { error: 'not_found' })
        const l = links.startPreapproved(user.id, ttl_seconds !== undefined ? { ttlMs: ttl_seconds * 1000 } : {})
        // Pending-map cap: same envelope as the limiter — a caller can't
        // tell which throttle it hit, and shouldn't need to.
        if (!l) return json(res, 429, { error: 'rate_limited' })
        return json(res, 200, { link_code: l.linkCode, expires_in: l.expiresIn })
      }
      const who = bearer(req) && authToken(db, bearer(req))
      if (!who) return rejectEarly(req, res, 401, { error: 'unauthenticated' })
      if (req.method === 'GET' && url.pathname === '/snapshot') {
        // Two independent rules layered on top of the client shape (spec:
        // agent visibility & privacy, task 8):
        //   - snippet omitted for EVERY agent caller, private or not — it can
        //     carry tool_output text (credentials), same reason /roster omits
        //     it. A managing agent losing its own convo's snippet is
        //     acceptable: no agent consumer of /snapshot exists.
        //   - private-owned conversations excluded for a FILTERED (ordinary)
        //     agent only — same one-caller-rule predicate as /roster and
        //     /search, so /snapshot can't be used as an end-run around them.
        const filtered = who.kind === 'agent' && !isPrivateDevice(db, who.deviceId)
        return json(res, 200, snapshot(db, who.userId, { omitSnippet: who.kind === 'agent', excludePrivateOwned: filtered }))
      }
      if (req.method === 'GET' && url.pathname === '/metrics') {
        // Any valid device (client or agent) — no admin-only concept in v1.
        // Scoping (no cross-user leakage) is enforced inside buildMetrics.
        // Privacy filter (spec: agent visibility & privacy): same
        // one-caller-rule predicate as /roster and /search — an ORDINARY
        // agent caller's device list omits private devices; a client or a
        // private agent caller sees the full list, unchanged.
        const filtered = who.kind === 'agent' && !isPrivateDevice(db, who.deviceId)
        return json(res, 200, buildMetrics(db, { hub, pushPipeline, dbPath, userId: who.userId, excludePrivateDevices: filtered }))
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
      if (req.method === 'GET' && url.pathname === '/roster') {
        // Targeting surface for agent chat (spec: phase 2 roster) — unlike
        // /devices (management, client-gated) this is deliberately open to
        // agent tokens, and deliberately NARROWER: agent devices only
        // (an agent still has no business enumerating its user's client
        // devices), no cursor/lag/push_prefs, and only top-level
        // conversations (children are silenced sub-chats, never chat
        // targets). Same owner_user_id scoping as every other read.
        const live = new Set(hub.connsOf(who.userId).filter((c) => c.ws.readyState === 1).map((c) => c.deviceId))
        // Privacy filter (spec: agent visibility & privacy): applies only to
        // an ORDINARY agent caller. Clients always see everything; a private
        // agent is invisible, not blinded (one-directional, deliberately) —
        // which also resolves "can two private agents see each other" as yes.
        const filtered = who.kind === 'agent' && !isPrivateDevice(db, who.deviceId)
        const agents = db.prepare(
          `SELECT id AS device_id, name, created_at, last_seen_at FROM devices
           WHERE user_id=? AND kind='agent'${filtered ? ' AND private=0' : ''} ORDER BY id`
        ).all(who.userId).map((d) => ({ ...d, connected: live.has(d.device_id) }))
        const conversations = db.prepare(
          `SELECT id, title, session_state, last_seq, summary, agent_device_id, created_at,
                  (SELECT ts FROM events e WHERE e.convo_id = conversations.id
                   ORDER BY e.seq DESC LIMIT 1) AS last_ts
           FROM conversations WHERE owner_user_id=? AND parent_convo_id IS NULL${filtered
             ? ` AND (agent_device_id IS NULL OR NOT EXISTS(
                    SELECT 1 FROM devices d WHERE d.id=conversations.agent_device_id AND d.private=1))`
             : ''}
           ORDER BY last_seq DESC`
        ).all(who.userId)
        return json(res, 200, { agents, conversations })
      }
      if (req.method === 'GET' && url.pathname === '/agent-chat/pending') {
        // The consent-card surface for clients that missed the live card (or
        // want a durable inbox of asks) — client-gated like every other
        // decision-making endpoint here; an agent has no business reading
        // its own or another agent's pending asks over HTTP.
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        // Device names go out through the same sieve the live card's
        // `from_name` does: they land in a card in the user's app, and a
        // newline in a device name is line forgery there just as it is in the
        // journal's own voice.
        const pending = listAwaiting(db, who.userId).map((r) => ({
          ...r,
          initiator_name: deviceName(r.initiator_name),
          agent_name: deviceName(r.agent_name),
        }))
        return json(res, 200, { pending })
      }
      if (req.method === 'POST' && url.pathname === '/agent-chat/answer') {
        // Client-gated: an agent must never answer a consent ask, including
        // one addressed to itself — the whole point of parking is that only
        // the human decides.
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        const body = await readBody(req)
        const { room_id, target_device_id, decision } = body
        if (decision !== 'approve' && decision !== 'deny') return json(res, 400, { error: 'bad_request' })
        if (typeof room_id !== 'string' || !Number.isInteger(target_device_id)) return json(res, 400, { error: 'bad_request' })
        // `always_allow` was the standing-consent grant. It is gone, and a
        // body still carrying it is rejected rather than ignored: a caller
        // that believes it granted standing consent which does not exist is
        // worse off than one told plainly that the field is not accepted.
        if ('always_allow' in body) return json(res, 400, { error: 'bad_request' })
        const room = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(room_id)
        // Unknown room and a room owned by someone else are indistinguishable
        // (404, never 403) — same anti-enumeration stance as
        // GET /convo/:id/messages.
        if (!room || room.owner_user_id !== who.userId) return json(res, 404, { error: 'not_found' })
        const row = getParticipant(db, room_id, target_device_id)
        if (!row || row.state !== 'awaiting_user') return json(res, 409, { error: 'conflict' })
        if (decision === 'deny') {
          answerParkedInvite(db, { convoId: room_id, agentDeviceId: target_device_id, approve: false })
          // Indistinguishable from a peer refusal — reason 'refused', never
          // 'denied' (a requester must never learn the human said no).
          hub.sendToDevice(who.userId, row.initiator_device_id, {
            kind: 'invite', event: 'answer', room_id, peer_device_id: target_device_id, accept: false, reason: 'refused',
          })
          return json(res, 200, { ok: true })
        }
        answerParkedInvite(db, { convoId: room_id, agentDeviceId: target_device_id, approve: true })
        // Join requests self-target (row.initiator_device_id ===
        // target_device_id, the joiner) — the recipient of THIS row's relay
        // (and, below, the directed-pair target) is the room owner, not the
        // joiner itself.
        const isJoin = row.initiator_device_id === target_device_id
        // Scoped to this row's own recipient: the unscoped pump sweeps every
        // undelivered row system-wide, so an unrelated row's successful
        // delivery could otherwise make `sent > 0` true while THIS row's
        // target is still offline. Even scoped, `sent` could reflect a
        // different row addressed to the same recipient device — so the
        // response flag is read back off the answered row itself, which is
        // exact.
        deliverPendingInvites(db, hub, { deviceId: isJoin ? room.agent_device_id : target_device_id })
        const delivered = getParticipant(db, room_id, target_device_id)?.delivered_at != null
        return json(res, 200, { ok: true, delivered })
      }
      if (req.method === 'POST' && url.pathname === '/agent-spawn/answer') {
        // Client-gated: an agent must never answer a consent ask, including
        // one addressed to itself — the whole point of parking is that only
        // the human decides. Same stance as /agent-chat/answer.
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        const body = await readBody(req)
        const { request_id, decision } = body
        if (decision !== 'approve' && decision !== 'deny') return json(res, 400, { error: 'bad_request' })
        if (typeof request_id !== 'string' || !request_id) return json(res, 400, { error: 'bad_request' })
        // No standing consent exists for spawns and never has — but reject
        // the field rather than ignore it, exactly as /agent-chat/answer
        // does: a caller that believes it granted something must be told.
        if ('always_allow' in body) return json(res, 400, { error: 'bad_request' })
        const row = getSpawn(db, request_id)
        // Unknown id and another user's row are indistinguishable.
        if (!row || row.user_id !== who.userId) return json(res, 404, { error: 'not_found' })
        if (decision === 'deny') {
          if (!denySpawn(db, request_id)) return json(res, 409, { error: 'conflict' })
          // Reported plainly (spec: no peer to hide behind) — 'declined',
          // never a fabricated box-side failure.
          hub.sendToDevice(who.userId, row.from_device_id, { kind: 'spawn', event: 'outcome', request_id, outcome: 'declined' })
          return json(res, 200, { ok: true })
        }
        // The tap CLAIMS the row; a zero row-count means another tap already
        // won — 409, and nothing expensive has started (spec failure table:
        // two approve taps spawn once).
        if (!claimApprove(db, request_id)) return json(res, 409, { error: 'conflict' })
        // Everything after the claim is expensive and externally visible;
        // it runs off the request cycle — the app needs its 200 now, the
        // outcome reaches the parent as a turn. Errors are contained: the
        // broker timeout guarantees approveSpawn itself always settles.
        approveSpawn({ db, hub, broker, startTimeoutMs: spawnStartTimeoutMs }, getSpawn(db, request_id))
          .catch((err) => console.error('agent-spawn approve orchestration failed', err))
        return json(res, 200, { ok: true })
      }
      if (req.method === 'GET' && url.pathname === '/search') {
        // User-scoped full-text search (spec: agent journal search). Open to
        // both device kinds: agents are the design's audience, clients may
        // ride it later; scoping is by the authenticated user either way.
        const q = url.searchParams.get('q')
        if (typeof q !== 'string' || !q.trim() || q.length > 256) return json(res, 400, { error: 'bad_request' })
        const rawLimit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 20
        if (!Number.isInteger(rawLimit) || rawLimit < 1) return json(res, 400, { error: 'bad_request' })
        const limit = Math.min(rawLimit, 50)
        // convo_id narrows results; an id the user can't see yields the same
        // empty set an unmatched query does (user scoping already guarantees
        // it) — no existence oracle, nothing extra to check.
        const convoId = url.searchParams.get('convo_id') || null
        // Privacy filter (spec: agent visibility & privacy): same
        // one-caller-rule predicate the roster uses — applies only to an
        // ORDINARY agent caller, never to clients or private agents.
        const filtered = who.kind === 'agent' && !isPrivateDevice(db, who.deviceId)
        const r = searchMessages(db, who.userId, { query: q, limit, convoId, excludePrivateOwned: filtered })
        if (r.badQuery) return json(res, 400, { error: 'bad_request' })
        return json(res, 200, { hits: r.hits })
      }
      const dm = url.pathname.match(/^\/devices\/(\d+)\/revoke$/)
      if (req.method === 'POST' && dm) {
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        // Deleting the row IS the revocation (docs/protocol.md "Device
        // revocation"): HTTP 401s on the next call, WS closes next-frame or
        // via the ≤60s sweep. Not-owned and nonexistent are indistinguishable.
        const revokedId = Number(dm[1])
        if (!revokeOwnedDevice(db, who.userId, revokedId)) return json(res, 404, { error: 'not_found' })
        // Room membership goes with it, via the convo_agents cascade in
        // db.js — not a call here. This route used to do the cleanup itself,
        // which left `matron-admin device revoke` quietly not doing it.
        return json(res, 200, { ok: true })
      }
      const rn = url.pathname.match(/^\/devices\/(\d+)\/rename$/)
      if (req.method === 'POST' && rn) {
        // Client-gated like /devices and /password: an agent has no business
        // renaming its user's devices (or itself — the name is the user's
        // label for the box, not the box's self-description).
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        const { name } = await readBody(req)
        if (typeof name !== 'string') return json(res, 400, { error: 'bad_request' })
        // Sanitise BEFORE measuring: the cap is on what we store, and the
        // sieve (control chars -> space, whitespace collapsed, trimmed) is
        // the same one every peer-written name goes through.
        const clean = deviceName(name)
        if (!clean || clean.length > DEVICE_NAME_MAX) return json(res, 400, { error: 'bad_request' })
        const renamedId = Number(rn[1])
        if (!renameOwnedDevice(db, who.userId, renamedId, clean)) return json(res, 404, { error: 'not_found' })
        for (const c of hub.connsOf(who.userId)) {
          // A live socket carries the device name it authenticated with
          // (ws.js hello: `conn = { ws, ...who }`), and everything that
          // names the producing device reads it from there — journal
          // `sender` strings (`agent:dev-2`), and the `from_name` baked into
          // an agent-chat/agent-spawn consent card. Leave it and a connected
          // bridge keeps minting the pre-rename name until it reconnects,
          // which for a long-lived box is days. Patch the connection, not
          // just the row.
          if (c.deviceId === renamedId) c.name = clean
          // Live roster patch for the user's other apps. Transient (not a
          // journal event): a device name is not conversation history, and a
          // client that was offline picks the new name up from its next
          // /snapshot `agents` list. Clients only — an agent keeps no roster.
          if (c.kind === 'client' && c.ws.readyState === 1) {
            c.ws.send(JSON.stringify({ kind: 'device_meta', device_id: renamedId, name: clean }))
          }
        }
        return json(res, 200, { ok: true, device: { device_id: renamedId, name: clean } })
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
        let aroundSeq = null
        if (url.searchParams.has('around_seq')) {
          aroundSeq = Number(url.searchParams.get('around_seq'))
          if (!Number.isInteger(aroundSeq)) return json(res, 400, { error: 'bad_request' })
        }
        // The two paging modes are mutually exclusive by design — a request
        // carrying both has a confused caller, and picking one silently
        // would hide the bug.
        if (aroundSeq != null && beforeSeq != null) return json(res, 400, { error: 'bad_request' })
        const rawLimit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50
        if (!Number.isInteger(rawLimit) || rawLimit < 1) return json(res, 400, { error: 'bad_request' })
        const limit = Math.min(rawLimit, 200)
        // Two agent read regimes (locked decision, search spec fold-in):
        //  - before_seq (and default) paging keeps the Phase-2 gate: an agent
        //    reads full transcripts only for conversations it manages or has
        //    joined (authorizeAgentWrite) — 404 otherwise, same as ever.
        //  - around_seq on a conversation OUTSIDE that set is the search
        //    context surface: allowed (it is the feature /search exists to
        //    serve), but windowed over exactly what the index can see
        //    (search_messages: text + diff prose) rather than over every
        //    event with a post-hoc filter, so a limited window is never
        //    starved down to a few rows by interleaved tool_output. The
        //    limit is clamped to 30 (a search-hit-orientation read, not bulk
        //    extraction) and every read is logged server-side. tool_output —
        //    the credential surface — and every other type never appear,
        //    which also covers the client-only consent card (indexableBody
        //    is null for permission_request).
        const agentForeign = who.kind === 'agent' && !authorizeAgentWrite(db, who.userId, who.deviceId, convoId)
        if (agentForeign && aroundSeq == null) {
          return json(res, 404, { error: 'not_found' })
        }
        try {
          let events
          if (agentForeign && aroundSeq != null) {
            // Privacy gate (spec: agent visibility & privacy): a conversation
            // owned by a private device does not exist for an ordinary
            // agent's context reads — same 404 as missing/unauthorized, and
            // it must fire before the audit log line below so a refused read
            // is never logged as a successful foreign read. A private caller
            // bypasses this, same one-directional rule as everywhere else.
            const owner = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(convoId)?.agent_device_id
            if (owner != null && isPrivateDevice(db, owner) && !isPrivateDevice(db, who.deviceId)) {
              return json(res, 404, { error: 'not_found' })
            }
            // Window over the indexed (prose) set directly, not over every
            // event with a post-hoc filter — in a tool_output-heavy convo,
            // filtering after windowing can starve a small limit down to a
            // couple of rows before the caller ever sees them (final
            // review). The limit is also clamped: a foreign agent's context
            // read is meant to orient around one search hit, not extract a
            // conversation wholesale.
            const clampedLimit = Math.min(limit, 30)
            events = messagesAroundIndexed(db, who.userId, convoId, { aroundSeq, limit: clampedLimit })
            console.log(`journal: foreign-agent context read convo=${convoId} device=${who.deviceId} anchor=${aroundSeq}`)
          } else if (aroundSeq != null) {
            events = messagesAround(db, who.userId, convoId, { aroundSeq, limit })
          } else {
            events = messagesBefore(db, who.userId, convoId, { beforeSeq, limit })
          }
          if (agentForeign) {
            // Belt-and-braces against drift between the index and the rule:
            // messagesAroundIndexed already returns only indexable rows, so
            // this should be a no-op in practice.
            events = events.filter((e) => indexableBody(e.type, e.payload) != null)
          } else if (who.kind !== 'client') {
            // Client-only events (the agent-chat approval card) never reach an
            // agent device by any read path — this is the HTTP-pagination half
            // of the guarantee ws.js's fanOut and hello replay also enforce.
            events = events.filter((e) => !isClientOnlyEvent(e.type, e.payload))
          }
          return json(res, 200, { events: events.map(toEventShape) })
        } catch (e) {
          // Unauthorized and missing are indistinguishable: both 404, same
          // body as GET /media/:id's unknown-id response — never 403 (that
          // would confirm the convo id exists to a caller who can't read it).
          if (/not authorized/.test(e.message)) return json(res, 404, { error: 'not_found' })
          throw e
        }
      }
      if (req.method === 'POST' && url.pathname === '/media') {
        // Per-user disk quota (finding: media has no TTL, so unbounded uploads
        // fill the disk). Read the user's current footprint once, up front:
        // if it's already at/over quota, reject BEFORE streaming a body we'd
        // only delete (rejectEarly closes the socket since the body is unread).
        // The precise `used + size` check comes after receiveBlob knows the
        // size — a single upload can overshoot by at most mediaMaxBytes, which
        // is fine (the ceiling is a safety valve, not a byte-exact accountant),
        // and concurrent same-user uploads can each pass this snapshot read, a
        // bounded soft-overrun we accept rather than serializing uploads.
        const usedBytes = userBlobBytes(db, who.userId)
        if (usedBytes >= mediaUserQuotaBytes) return rejectEarly(req, res, 413, { error: 'quota_exceeded' })
        let received
        try {
          received = await receiveBlob(req, { root: mediaDir, maxBytes: mediaMaxBytes })
        } catch (e) {
          if (e.code === 'empty') return json(res, 400, { error: 'empty' })
          if (e.code === 'too_large') throw Object.assign(new Error('too large'), { statusCode: 413 })
          throw e
        }
        if (usedBytes + received.size > mediaUserQuotaBytes) {
          // Body is fully consumed by now (receiveBlob resolved), so a plain
          // json() reject is right — no keep-alive desync concern. Delete the
          // just-written blob file so a rejected upload leaves nothing behind.
          await fs.promises.unlink(received.diskPath).catch(() => {})
          return json(res, 413, { error: 'quota_exceeded' })
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
          // The content-type is uploader-chosen and echoed verbatim, on the
          // same origin as the API. nosniff stops a browser from re-sniffing a
          // mislabeled blob into active content, and attachment forces a
          // download rather than inline rendering — so a blob can never execute
          // as script/HTML in this origin even though media is owner-scoped.
          'x-content-type-options': 'nosniff',
          'content-disposition': 'attachment',
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
