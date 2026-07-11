import fs from 'node:fs'
import crypto from 'node:crypto'
import http2 from 'node:http2'

// Apple allows JWTs up to ~60 min old; re-mint well inside that so a
// borderline-stale token is never sent (no clock-skew retry in v1).
const JWT_TTL_MS = 45 * 60 * 1000

const HOSTS = {
  prod: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
}

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// direct APNs, no sygnal: ES256-signed provider JWT (node:crypto only) +
// node:http2 client sessions, one per environment host. `connect` is
// injectable so tests can run against an in-process fake h2 server instead
// of Apple.
export function makeApnsClient({ keyFile, keyId, teamId, topic, connect = http2.connect }) {
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'))

  let cachedJwt = null
  let mintedAt = 0
  function jwt() {
    const now = Date.now()
    if (cachedJwt && now - mintedAt < JWT_TTL_MS) return cachedJwt
    const header = { alg: 'ES256', kid: keyId }
    const claims = { iss: teamId, iat: Math.floor(now / 1000) }
    const signingInput = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(claims)))}`
    const signature = crypto.sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' })
    cachedJwt = `${signingInput}.${base64url(signature)}`
    mintedAt = now
    return cachedJwt
  }

  const sessions = {} // env -> live http2 session, lazily connected

  function teardown(env, session) {
    if (sessions[env] === session) delete sessions[env]
  }

  function connectEnv(env) {
    const session = connect(HOSTS[env])
    // Re-created lazily (on the next send()) rather than eagerly here.
    session.on('error', () => teardown(env, session))
    session.on('goaway', () => teardown(env, session))
    session.on('close', () => teardown(env, session))
    sessions[env] = session
    return session
  }

  function sessionFor(env) {
    const existing = sessions[env]
    if (existing && !existing.destroyed && !existing.closed) return existing
    return connectEnv(env)
  }

  // One HTTP/2 request/response cycle. Never rejects: any failure (session
  // gone mid-request, stream error, malformed response) resolves
  // {status: 0, reason: 'transport'} instead.
  function requestOnce(session, { deviceToken, topic: pushTopic, payload, collapseId, priority, pushType }) {
    return new Promise((resolve) => {
      let settled = false
      const settle = (result) => { if (!settled) { settled = true; resolve(result) } }

      const headers = {
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt()}`,
        'apns-topic': pushTopic || topic,
        'apns-push-type': pushType,
        'apns-priority': String(priority),
        'apns-expiration': '0',
      }
      if (collapseId) headers['apns-collapse-id'] = collapseId

      let req
      try {
        req = session.request(headers)
      } catch {
        return settle({ status: 0, reason: 'transport' })
      }

      let status = null
      let body = ''
      req.on('response', (h) => { status = h[':status'] })
      req.setEncoding('utf8')
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        let reason = null
        if (body) {
          try { reason = JSON.parse(body).reason || null } catch { /* non-JSON body: no reason */ }
        }
        settle({ status, reason })
      })
      req.on('error', () => settle({ status: 0, reason: 'transport' }))
      req.write(JSON.stringify(payload))
      req.end()
    })
  }

  // Resolves {status, reason} — never rejects, never retries the push
  // itself. A send that finds a dead session reconnects exactly once before
  // giving up (no unbounded retry loop).
  async function send({ deviceToken, env, topic: pushTopic, payload, collapseId, priority, pushType }) {
    let session
    try {
      session = sessionFor(env)
    } catch {
      return { status: 0, reason: 'transport' }
    }
    return requestOnce(session, { deviceToken, topic: pushTopic, payload, collapseId, priority, pushType })
  }

  function close() {
    for (const env of Object.keys(sessions)) {
      const s = sessions[env]
      delete sessions[env]
      try { s.close() } catch { /* already gone */ }
    }
  }

  return { send, close }
}
