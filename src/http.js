import { login, authToken } from './auth.js'
import { snapshot, messagesBefore, toEventShape } from './journal.js'

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
    try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) }
  })
  req.on('close', () => fail(new Error('connection closed')))
  req.on('error', fail)
})

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer /, '') || null

export function makeHttpHandler({ db, rateLimiter, loginGuard }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      if (req.method === 'POST' && url.pathname === '/login') {
        // Behind the cloudflared tunnel, req.socket.remoteAddress is always 127.0.0.1
        // (the tunnel is the only route in, so this header is trustworthy here).
        // Fall back to remoteAddress for direct/local connections (e.g. tests).
        const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown'
        if (!rateLimiter.allow(ip)) return json(res, 429, { error: 'rate_limited' })
        const { username, password, device_name } = await readBody(req)
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
      if (!who) return json(res, 401, { error: 'unauthenticated' })
      if (req.method === 'GET' && url.pathname === '/snapshot') {
        return json(res, 200, snapshot(db, who.userId))
      }
      const m = url.pathname.match(/^\/convo\/([^/]+)\/messages$/)
      if (req.method === 'GET' && m) {
        const beforeSeq = url.searchParams.has('before_seq') ? Number(url.searchParams.get('before_seq')) : null
        const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200)
        try {
          const events = messagesBefore(db, who.userId, decodeURIComponent(m[1]), { beforeSeq, limit }).map(toEventShape)
          return json(res, 200, { events })
        } catch (e) {
          if (/not authorized/.test(e.message)) return json(res, 403, { error: 'forbidden' })
          throw e
        }
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
      return json(res, 500, { error: 'internal', message: e.message })
    }
  }
}
