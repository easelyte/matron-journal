import http from 'node:http'

// The push.matron.chat relay: the one piece of shared infrastructure Matron
// runs. Holds the APNs key for the chat.matron.app bundle id and forwards
// pushes on behalf of self-hosted journals (which cannot have that key).
//
// Privacy is structural, not policy: the wire protocol below has NO field
// that can carry a title, body, snippet, or conversation name — the relay
// maps a category to one of three fixed strings. mutable-content: 1 is set
// on every alert now so the v2 NSE fetch can enrich these on-device without
// any relay change.
//
// The endpoint is deliberately open (a self-hosted journal has nowhere to
// pre-register): possession of a device token — an unguessable 32-byte value
// known only to that user's own journal — is the credential, and the
// per-token bucket below bounds what a stolen token is worth.

const BODY_LIMIT = 1024

const APS_ALERTS = {
  attention: { title: 'Matron', body: 'Your agent needs you' },
  done: { title: 'Matron', body: 'Session finished' },
  activity: { title: 'Matron', body: 'New activity from your agent' },
}

const REQUIRED = ['device_token', 'env', 'category', 'priority', 'push_type']
const OPTIONAL = ['badge', 'thread_id', 'collapse_id']
const KNOWN = new Set([...REQUIRED, ...OPTIONAL])

// Two token buckets gate every send:
//
// Per-device-token — burst 20, refill 1 per 10s. Sustained activity+wake
// traffic can reach ~5+/min even with journal-side coalescing — this refill
// rate covers that with headroom while still capping abuse at ~6/min
// sustained once the burst is spent. Buckets live in memory only (the relay
// is stateless by design); a full-capacity bucket is indistinguishable from
// an absent one, so those are evicted on sweep and the map stays bounded by
// the number of RECENTLY throttled tokens.
//
// Global — burst 200, refill 1 per 20ms (50/s sustained). The per-token
// bucket is useless against a spray of unique fabricated tokens (each gets a
// fresh bucket), and every sprayed send would reach APNs as BadDeviceToken —
// sustained streams of those get the relay's APNs connection terminated for
// abuse. The global ceiling bounds what the relay can emit toward APNs no
// matter the traffic shape; it is far above legit v1 volume.
export function makeRelayLimiter({ burst = 20, refillMs = 10000, globalBurst = 200, globalRefillMs = 20, now = Date.now } = {}) {
  const buckets = new Map()
  const global = { tokens: globalBurst, at: now() }
  let globalDenied = 0

  function refill(b, cap, perMs, t) {
    const refilled = Math.floor((t - b.at) / perMs)
    if (refilled > 0) {
      b.tokens = Math.min(cap, b.tokens + refilled)
      b.at = b.tokens === cap ? t : b.at + refilled * perMs
    }
  }

  function allow(token) {
    const t = now()
    let b = buckets.get(token)
    if (!b) {
      b = { tokens: burst, at: t }
      buckets.set(token, b)
    } else {
      refill(b, burst, refillMs, t)
    }
    // Per-token check first, and only a fully allowed request consumes the
    // global budget — a flood against one exhausted token must not starve
    // everyone else.
    if (b.tokens <= 0) return false
    refill(global, globalBurst, globalRefillMs, t)
    if (global.tokens <= 0) {
      globalDenied += 1
      return false
    }
    b.tokens -= 1
    global.tokens -= 1
    return true
  }

  function sweep() {
    const t = now()
    for (const [token, b] of buckets) {
      const refilled = Math.floor((t - b.at) / refillMs)
      if (b.tokens + refilled >= burst) buckets.delete(token)
    }
    // The global ceiling tripping at all is the early-warning signal for a
    // token-spray attack — surface it, but at sweep cadence, never per hit.
    if (globalDenied > 0) {
      console.error(`relay: global rate ceiling denied ${globalDenied} requests since last sweep`)
      globalDenied = 0
    }
  }

  return { allow, sweep, _buckets: buckets }
}

// null = valid; otherwise a short machine reason (never echoes field VALUES —
// nothing caller-controlled is reflected or logged).
function validate(body) {
  for (const k of Object.keys(body)) {
    if (!KNOWN.has(k)) return 'unknown_field'
  }
  for (const k of REQUIRED) {
    if (body[k] === undefined) return 'missing_field'
  }
  if (typeof body.device_token !== 'string' || !/^[0-9a-f]{16,200}$/i.test(body.device_token)) return 'bad_device_token'
  if (body.env !== 'prod' && body.env !== 'sandbox') return 'bad_env'
  if (body.category !== 'wake' && !APS_ALERTS[body.category]) return 'bad_category'
  if (body.priority !== 5 && body.priority !== 10) return 'bad_priority'
  if (body.push_type !== 'alert' && body.push_type !== 'background') return 'bad_push_type'
  // The payload table is keyed by category; a push_type that disagrees with
  // it is a protocol violation, not a preference.
  if ((body.category === 'wake') !== (body.push_type === 'background')) return 'category_push_type_mismatch'
  if (body.badge !== undefined && (!Number.isInteger(body.badge) || body.badge < 0)) return 'bad_badge'
  for (const k of ['thread_id', 'collapse_id']) {
    if (body[k] !== undefined && (typeof body[k] !== 'string' || body[k].length < 1 || body[k].length > 200)) return `bad_${k}`
  }
  return null
}

function buildPayload({ category, badge, thread_id }) {
  if (category === 'wake') {
    const aps = { 'content-available': 1 }
    if (badge !== undefined) aps.badge = badge
    return { aps }
  }
  const aps = { alert: APS_ALERTS[category], 'mutable-content': 1 }
  if (badge !== undefined) aps.badge = badge
  if (thread_id !== undefined) aps['thread-id'] = thread_id
  return { aps }
}

// Every response body is {status, reason} with the HTTP status mirroring the
// APNs status, so the journal's existing handleResult logic (410 → prune
// token, 400 → env-mismatch warning) works against the relay unchanged. An
// APNs-side transport failure has status 0, which is not an HTTP status —
// surfaced as 502 with the true {status: 0, reason} in the body.
export function makeRelayHandler({ apnsClient, limiter = makeRelayLimiter() }) {
  const respond = (res, httpStatus, obj) => {
    res.writeHead(httpStatus, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }

  return (req, res) => {
    if (req.method !== 'POST' || req.url !== '/push') return respond(res, 404, { status: 404, reason: 'not_found' })

    let data = ''
    let overflowed = false
    req.setEncoding('utf8')
    req.on('data', (c) => {
      data += c
      if (data.length > BODY_LIMIT) {
        overflowed = true
        req.removeAllListeners('data')
        req.pause()
        // Partially-unconsumed body: never reuse this socket (same keep-alive
        // desync concern as the journal's readBody 413 path).
        res.setHeader('Connection', 'close')
        respond(res, 413, { status: 413, reason: 'too_large' })
      }
    })
    req.on('error', () => { /* peer went away: nothing to respond to */ })
    req.on('end', async () => {
      if (overflowed) return
      let body
      try {
        body = JSON.parse(data)
      } catch {
        return respond(res, 400, { status: 400, reason: 'bad_json' })
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return respond(res, 400, { status: 400, reason: 'bad_json' })
      }
      const invalid = validate(body)
      if (invalid) return respond(res, 400, { status: 400, reason: invalid })
      if (!limiter.allow(body.device_token)) return respond(res, 429, { status: 429, reason: 'rate_limited' })

      // apnsClient.send never rejects (contract) — the catch is a backstop so
      // a bug there can never crash the relay or hang the response.
      let result
      try {
        result = await apnsClient.send({
          deviceToken: body.device_token,
          env: body.env,
          payload: buildPayload(body),
          collapseId: body.collapse_id,
          priority: body.priority,
          pushType: body.push_type,
        })
      } catch (err) {
        console.error('relay: apns send threw unexpectedly', err)
        result = { status: 0, reason: 'internal' }
      }
      if (result.status < 200) {
        // Truncated token prefix only — a full token is a push credential.
        console.error(`relay: apns transport failure for token ${body.device_token.slice(0, 8)}… (${result.reason})`)
        return respond(res, 502, { status: result.status, reason: result.reason ?? null })
      }
      return respond(res, result.status, { status: result.status, reason: result.reason ?? null })
    })
  }
}

const SWEEP_INTERVAL_MS = 10 * 60 * 1000

export function startRelay({ apnsClient, port = 0, bind = '127.0.0.1', limiter = makeRelayLimiter() } = {}) {
  const server = http.createServer(makeRelayHandler({ apnsClient, limiter }))
  const sweepTimer = setInterval(() => limiter.sweep(), SWEEP_INTERVAL_MS)
  sweepTimer.unref()
  return new Promise((resolve) => {
    server.listen(port, bind, () => {
      resolve({
        port: server.address().port,
        server,
        close() {
          clearInterval(sweepTimer)
          server.close()
          apnsClient.close()
        },
      })
    })
  })
}
