import test from 'node:test'
import assert from 'node:assert/strict'
import { startRelay, makeRelayLimiter, makeRendezvousLimiter } from '../src/relay.js'
import { makeRendezvousStore } from '../src/rendezvous.js'

function makeStubApnsClient() {
  const calls = []
  return { calls, send: async (opts) => { calls.push(opts); return { status: 200, reason: null } }, close() {} }
}

async function startTestRelay(t, opts = {}) {
  const stub = makeStubApnsClient()
  const relay = await startRelay({ apnsClient: stub, port: 0, ...opts })
  t.after(() => relay.close())
  const base = `http://127.0.0.1:${relay.port}`
  const jsonOf = async (r) => { try { return await r.json() } catch { return null } }
  return {
    base,
    stub,
    async create({ raw } = {}) {
      const r = await fetch(`${base}/link/rendezvous`, { method: 'POST', body: raw })
      return { status: r.status, json: await jsonOf(r) }
    },
    async offer(rid, body, { raw } = {}) {
      const r = await fetch(`${base}/link/rendezvous/${rid}/offer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw !== undefined ? raw : JSON.stringify(body),
      })
      return { status: r.status, json: await jsonOf(r) }
    },
    async poll(rid, secret) {
      const r = await fetch(`${base}/link/rendezvous/${rid}?secret=${secret}`)
      return { status: r.status, json: await jsonOf(r) }
    },
  }
}

const OFFER = { server: 'https://j.example.com', code: '2345-6789' }

test('happy path: create → poll 204 → offer 204 → poll 200 (retryable) → second offer 409', async (t) => {
  const s = await startTestRelay(t)
  const c = await s.create()
  assert.equal(c.status, 201)
  assert.match(c.json.rid, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{26}$/)
  assert.match(c.json.secret, /^[0-9a-f]{64}$/)
  assert.equal(c.json.expires_in, 180)

  assert.equal((await s.poll(c.json.rid, c.json.secret)).status, 204)

  assert.equal((await s.offer(c.json.rid, OFFER)).status, 204)

  const got = await s.poll(c.json.rid, c.json.secret)
  assert.equal(got.status, 200)
  assert.deepEqual(got.json, { server: 'https://j.example.com', code: '2345-6789' })
  // dropped-response retry: still 200 with the same offer
  assert.deepEqual((await s.poll(c.json.rid, c.json.secret)).json, got.json)

  const second = await s.offer(c.json.rid, { server: 'https://evil.example.com', code: '9999-9999' })
  assert.equal(second.status, 409)
  assert.deepEqual(second.json, { status: 409, reason: 'conflict' })
  assert.equal((await s.poll(c.json.rid, c.json.secret)).json.server, 'https://j.example.com')
})

test('secret gating: wrong or missing secret → 403; the rid alone reads nothing back', async (t) => {
  const s = await startTestRelay(t)
  const c = await s.create()
  await s.offer(c.json.rid, OFFER)
  const wrong = await s.poll(c.json.rid, 'f'.repeat(64))
  assert.equal(wrong.status, 403)
  assert.deepEqual(wrong.json, { status: 403, reason: 'forbidden' })
  const missing = await fetch(`${s.base}/link/rendezvous/${c.json.rid}`)
  assert.equal(missing.status, 403)
})

test('unknown and malformed rids: offer/poll 404; the code is normalized before storage', async (t) => {
  const s = await startTestRelay(t)
  assert.equal((await s.offer('Z'.repeat(26), OFFER)).status, 404)
  assert.equal((await s.poll('Z'.repeat(26), 'f'.repeat(64))).status, 404)
  // wrong-shape rid never matches the route
  assert.equal((await s.offer('short', OFFER)).status, 404)
  assert.equal((await s.poll('short', 'f'.repeat(64))).status, 404)

  const c = await s.create()
  // lowercase + odd separators normalize to the canonical dashed form
  assert.equal((await s.offer(c.json.rid, { server: 'https://j.example.com', code: '2345 6789' })).status, 204)
  assert.equal((await s.poll(c.json.rid, c.json.secret)).json.code, '2345-6789')
})

test('offer validation 400s with machine reasons that never echo values', async (t) => {
  // This test spends 12 rendezvous creates on the same IP (10 bad cases +
  // 2 more below) to exercise offer validation, not creation limiting —
  // that's covered separately by the per-IP-limit test. The default
  // rendezvousLimiter's per-IP burst (10) is deliberately tiny for
  // production, so it would otherwise starve this test's own creates.
  const s = await startTestRelay(t, { rendezvousLimiter: makeRendezvousLimiter({ burst: 20 }) })
  const bad = [
    [{ ...OFFER, extra: 'x' }, 'unknown_field'],
    [{ server: OFFER.server }, 'missing_field'],
    [{ code: OFFER.code }, 'missing_field'],
    [{ server: 'http://j.example.com', code: OFFER.code }, 'bad_server'], // http to a non-local host
    [{ server: 'not a url', code: OFFER.code }, 'bad_server'],
    [{ server: 7, code: OFFER.code }, 'bad_server'],
    [{ server: `https://j.example.com/${'x'.repeat(200)}`, code: OFFER.code }, 'bad_server'],
    [{ server: OFFER.server, code: '2345-678' }, 'bad_code'],   // 7 chars
    [{ server: OFFER.server, code: '2345-678A' }, 'bad_code'],  // A not in alphabet
    [{ server: OFFER.server, code: 7 }, 'bad_code'],
  ]
  for (const [body, reason] of bad) {
    const c = await s.create()
    const r = await s.offer(c.json.rid, body)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.deepEqual(r.json, { status: 400, reason })
  }
  // dev carve-out: http to localhost is a valid server (mirrors the apps)
  const c = await s.create()
  assert.equal((await s.offer(c.json.rid, { server: 'http://localhost:9810', code: OFFER.code })).status, 204)
  // bad JSON / non-object / oversized bodies
  const c2 = await s.create()
  assert.equal((await s.offer(c2.json.rid, null, { raw: 'not json' })).status, 400)
  assert.equal((await s.offer(c2.json.rid, null, { raw: '[1]' })).status, 400)
  assert.equal((await s.offer(c2.json.rid, null, { raw: JSON.stringify({ ...OFFER, server: 'x'.repeat(2000) }) })).status, 413)
})

test('create validation: a non-empty body is rejected, an empty one accepted', async (t) => {
  const s = await startTestRelay(t)
  assert.equal((await s.create({ raw: '{}' })).status, 201)
  const r = await s.create({ raw: JSON.stringify({ sneaky: 'content' }) })
  assert.equal(r.status, 400)
  assert.deepEqual(r.json, { status: 400, reason: 'unknown_field' })
})

test('expiry: rendezvous dies at TTL', async (t) => {
  const s = await startTestRelay(t, { rendezvous: makeRendezvousStore({ ttlMs: 30 }) })
  const c = await s.create()
  await new Promise((r) => setTimeout(r, 60))
  assert.equal((await s.offer(c.json.rid, OFFER)).status, 404)
  assert.equal((await s.poll(c.json.rid, c.json.secret)).status, 404)
})

test('cap: maxPending surfaces as 429 on create', async (t) => {
  const s = await startTestRelay(t, { rendezvous: makeRendezvousStore({ maxPending: 1 }) })
  assert.equal((await s.create()).status, 201)
  const capped = await s.create()
  assert.equal(capped.status, 429)
  assert.deepEqual(capped.json, { status: 429, reason: 'rate_limited' })
})

test('per-IP limit gates creation only; polls ride the global bucket', async (t) => {
  let clock = 0
  const s = await startTestRelay(t, {
    rendezvousLimiter: makeRendezvousLimiter({ burst: 2, refillMs: 30000, now: () => clock }),
  })
  const a = await s.create()
  assert.equal(a.status, 201)
  assert.equal((await s.create()).status, 201)
  assert.equal((await s.create()).status, 429)
  // polling is NOT per-IP limited — a desktop polls every 2 s for minutes
  for (let i = 0; i < 5; i++) assert.equal((await s.poll(a.json.rid, a.json.secret)).status, 204)
  // one per-IP refill interval restores exactly one create
  clock += 30000
  assert.equal((await s.create()).status, 201)
  assert.equal((await s.create()).status, 429)
})

test('global ceiling bounds offers and polls too', async (t) => {
  const s = await startTestRelay(t, {
    rendezvousLimiter: makeRendezvousLimiter({ burst: 100, globalBurst: 3, globalRefillMs: 60000 }),
  })
  const c = await s.create() // consumes 1 global
  assert.equal((await s.poll(c.json.rid, c.json.secret)).status, 204) // 2
  assert.equal((await s.poll(c.json.rid, c.json.secret)).status, 204) // 3
  const limited = await s.poll(c.json.rid, c.json.secret)
  assert.equal(limited.status, 429)
})

test('limiter unit: allowGlobal consumes only the global bucket', () => {
  let clock = 0
  const limiter = makeRelayLimiter({ burst: 1, refillMs: 10000, globalBurst: 2, globalRefillMs: 10000, now: () => clock })
  assert.equal(limiter.allowGlobal(), true)
  assert.equal(limiter.allowGlobal(), true)
  assert.equal(limiter.allowGlobal(), false)
  clock += 10000
  assert.equal(limiter.allowGlobal(), true)
  // and it never created a per-token bucket
  assert.equal(limiter._buckets.size, 0)
})

test('routing: /push still works and unknown routes 404', async (t) => {
  const s = await startTestRelay(t)
  const push = await fetch(`${s.base}/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_token: 'ab'.repeat(32), env: 'prod', category: 'done', priority: 10, push_type: 'alert' }),
  })
  assert.equal(push.status, 200)
  assert.equal(s.stub.calls.length, 1)
  assert.equal((await fetch(`${s.base}/link/rendezvous`)).status, 404) // GET on create
  assert.equal((await fetch(`${s.base}/nope`, { method: 'POST', body: '{}' })).status, 404)
})
