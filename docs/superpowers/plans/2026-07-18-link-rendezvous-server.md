# Link Rendezvous — Server (journal + relay) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add relay-side rendezvous endpoints (so a camera-less signed-out device can be handed `{server, code}` by a signed-in phone), pre-approved link codes minted by root on the box, and a `matron-admin link-code` command that prints a terminal QR.

**Architecture:** A new in-memory rendezvous store lives inside the existing push-relay process (`src/relay.js`, same `bin/matron-push-relay.js` binary and systemd unit). On the journal side, `makeLinkStore` gains a pre-approved session type whose claim jumps straight to `approved`, exposed via a loopback-only `POST /link/preapprove` endpoint, driven by a new `matron-admin link-code` subcommand. The relay never carries tokens — only `{server, code}`, the same two values the shipped QR displays on screen.

**Tech Stack:** Node ≥ 20, ESM, `node:test`, zero runtime deps for the relay; one new dependency `qrcode-terminal` (MIT, zero-dep) for matron-admin.

**Spec:** `docs/superpowers/specs/2026-07-18-link-rendezvous-design.md` (approved). Read it before starting.

## Global Constraints

- Repo: `/Users/danbarker/Dev/matron-journal`, branch `feat/link-rendezvous` (already exists — commit onto it).
- Wire fields are snake_case (`expires_in`, `link_code`) — matching every existing endpoint.
- Relay error bodies use the relay convention `{ status, reason }` with short machine reasons; journal error bodies use `{ error: '...' }`. Validation NEVER echoes caller-supplied values in responses or logs.
- `rid`: exactly 26 chars from the pairing alphabet `0123456789BCDFGHJKMNPQRSTVWXYZ` (~128 bits). `secret`: 64 hex chars (256 bits, `crypto.randomBytes(32)`).
- Rendezvous TTL 180 000 ms, `maxPending` 256. Pre-approved link TTL 600 000 ms.
- Rendezvous limiter tuning: per-IP burst 10, refill 1 per 30 s; global burst 100, refill 1 per 100 ms. Creation consumes per-IP + global; offer and poll consume global only.
- Secret comparison on poll is constant-time (`crypto.timingSafeEqual` after a length check — the secret's length is public, 64 hex chars).
- `POST /link/preapprove` accepted ONLY when the socket remote address is loopback AND no `x-forwarded-*`, `forwarded`, or `cf-connecting-ip` header is present; everything else gets 404.
- The QR URI format is exactly `matron://link?v=1&server=<encodeURIComponent(serverUrl)>&code=XXXX-XXXX` (dashed code; both apps' `LinkURI` parsers already accept this — do not invent a new format).
- The `server` value in an offer follows the apps' validator stance: `https:` from any host, `http:` only to `localhost`/`127.0.0.1`/`::1`/`[::1]`; length ≤ 200.
- The rendezvous entry is NOT one-shot on poll: it survives until TTL so a dropped poll response can be retried. (Contrast: link/pair polls are one-shot — those release credentials; this releases none.)
- TDD, red-green per step. Run a single test file with `node --test test/<file>.js`; the full suite with `npm test`.
- Commit messages end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Rendezvous store (`makeRendezvousStore`)

**Files:**
- Modify: `src/pairing.js` (export `randomChars` and `CODE_ALPHABET`)
- Create: `src/rendezvous.js`
- Test: `test/rendezvous.test.js`

**Interfaces:**
- Consumes: `randomChars(len)` from `src/pairing.js` (added here).
- Produces (used by Task 3):
  - `makeRendezvousStore({ ttlMs = 180000, maxPending = 256 } = {})` →
    - `create()` → `{ rid, secret, expiresIn }` or `null` (capped)
    - `offer(rid, { server, code })` → `'offered' | 'conflict' | 'not_found'`
    - `poll(rid, secret)` → `{ status: 'waiting' } | { status: 'offered', server, code } | { status: 'forbidden' } | { status: 'not_found' }`
    - `sweep()`, `size()`
  - `CODE_ALPHABET` (the string `'0123456789BCDFGHJKMNPQRSTVWXYZ'`) exported from `src/pairing.js`.

- [ ] **Step 1: Refactor `src/pairing.js` exports (no behavior change)**

Replace lines 7–12 of `src/pairing.js` (the `ALPHABET`/`CODE_LEN`/`randomCode` block) with:

```js
export const CODE_ALPHABET = '0123456789BCDFGHJKMNPQRSTVWXYZ'
const CODE_LEN = 8

// crypto.randomInt is unbiased (rejection sampling), unlike bytes % 30.
// randomChars is exported for src/rendezvous.js (26-char rids) and
// randomCode for src/link.js (link codes share the pairing alphabet).
export const randomChars = (len) => Array.from({ length: len }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('')
export const randomCode = () => randomChars(CODE_LEN)
```

(Keep the existing alphabet-explaining comment above it; `ALPHABET` is renamed to `CODE_ALPHABET` — it had no other in-file uses.)

Run: `npm test` — Expected: PASS (pure refactor; existing pairing/link tests still green).

- [ ] **Step 2: Write failing store tests**

Create `test/rendezvous.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeRendezvousStore } from '../src/rendezvous.js'

test('create returns a 26-char alphabet rid, 256-bit hex secret, and expiry seconds', () => {
  const store = makeRendezvousStore()
  const r = store.create()
  assert.match(r.rid, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{26}$/)
  assert.match(r.secret, /^[0-9a-f]{64}$/)
  assert.equal(r.expiresIn, 180)
  assert.notEqual(store.create().rid, r.rid)
  assert.equal(store.size(), 2)
})

test('lifecycle: waiting → first offer wins → offered survives repeat polls; second offer conflicts', () => {
  const store = makeRendezvousStore()
  const { rid, secret } = store.create()
  assert.deepEqual(store.poll(rid, secret), { status: 'waiting' })
  assert.equal(store.offer(rid, { server: 'https://j.example.com', code: '2345-6789' }), 'offered')
  assert.deepEqual(store.poll(rid, secret), { status: 'offered', server: 'https://j.example.com', code: '2345-6789' })
  // NOT one-shot: a dropped poll response must be retryable until TTL
  assert.deepEqual(store.poll(rid, secret), { status: 'offered', server: 'https://j.example.com', code: '2345-6789' })
  assert.equal(store.offer(rid, { server: 'https://evil.example.com', code: '9999-9999' }), 'conflict')
  // the conflict must not have overwritten the first offer
  assert.equal(store.poll(rid, secret).server, 'https://j.example.com')
})

test('unknown rid: offer and poll are not_found', () => {
  const store = makeRendezvousStore()
  assert.equal(store.offer('Z'.repeat(26), { server: 'https://x.example.com', code: '2345-6789' }), 'not_found')
  assert.deepEqual(store.poll('Z'.repeat(26), 'f'.repeat(64)), { status: 'not_found' })
})

test('wrong secret is forbidden and leaks nothing (waiting and offered look identical)', () => {
  const store = makeRendezvousStore()
  const { rid } = store.create()
  assert.deepEqual(store.poll(rid, 'f'.repeat(64)), { status: 'forbidden' })
  store.offer(rid, { server: 'https://j.example.com', code: '2345-6789' })
  assert.deepEqual(store.poll(rid, 'f'.repeat(64)), { status: 'forbidden' })
  assert.deepEqual(store.poll(rid, 'short'), { status: 'forbidden' })
})

test('expiry: entries die at TTL for offer and poll, and sweep() removes them', async () => {
  const store = makeRendezvousStore({ ttlMs: 20 })
  const { rid, secret } = store.create()
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(store.offer(rid, { server: 'https://j.example.com', code: '2345-6789' }), 'not_found')
  assert.deepEqual(store.poll(rid, secret), { status: 'not_found' })
  store.create()
  store.sweep()
  assert.equal(store.size(), 1)
})

test('maxPending caps creation; expiry frees capacity', async () => {
  const store = makeRendezvousStore({ ttlMs: 20, maxPending: 1 })
  assert.ok(store.create())
  assert.equal(store.create(), null)
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(store.create(), 'sweep-on-create frees the expired slot')
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/rendezvous.test.js`
Expected: FAIL — `Cannot find module '../src/rendezvous.js'`.

- [ ] **Step 4: Implement `src/rendezvous.js`**

```js
import crypto from 'node:crypto'
import { randomChars } from './pairing.js'

// In-memory rendezvous store (spec §1: link rendezvous). Lives in the relay
// process. Holds at most {server URL, link code} per entry for ≤ ttlMs —
// never a token, never an account name (structural privacy, like /push).
//
// Keyed by rid (~128 bits from the pairing alphabet — unguessable, no
// lookalike glyphs, safe to show in a QR). The creator's poll is gated by a
// separate 256-bit secret so a bystander photographing the QR (which
// carries only the rid) cannot read the offer back.
export function makeRendezvousStore({ ttlMs = 180000, maxPending = 256 } = {}) {
  const entries = new Map() // rid -> { secret, server, code, expiresAt }

  const sweep = (now = Date.now()) => {
    for (const [k, e] of entries) if (now >= e.expiresAt) entries.delete(k)
  }

  return {
    create() {
      const now = Date.now()
      sweep(now)
      if (entries.size >= maxPending) return null
      const rid = randomChars(26) // ~128 bits: collisions are not a real event
      const secret = crypto.randomBytes(32).toString('hex')
      entries.set(rid, { secret, server: null, code: null, expiresAt: now + ttlMs })
      return { rid, secret, expiresIn: Math.floor(ttlMs / 1000) }
    },
    offer(rid, { server, code }) {
      const e = entries.get(rid)
      if (!e || Date.now() >= e.expiresAt) {
        if (e) entries.delete(rid)
        return 'not_found'
      }
      // First offer wins — a conflict never overwrites (the desktop may
      // already be acting on the first offer).
      if (e.server !== null) return 'conflict'
      e.server = server
      e.code = code
      return 'offered'
    },
    poll(rid, secret) {
      const e = entries.get(rid)
      if (!e || Date.now() >= e.expiresAt) {
        if (e) entries.delete(rid)
        return { status: 'not_found' }
      }
      if (!secretMatches(e.secret, secret)) return { status: 'forbidden' }
      if (e.server === null) return { status: 'waiting' }
      // NOT one-shot: the entry survives until TTL so a dropped poll
      // response can be retried. Nothing credential-granting is released
      // here — {server, code} still requires the phone's approve tap.
      return { status: 'offered', server: e.server, code: e.code }
    },
    sweep,
    size() { return entries.size },
  }
}

// Constant-time compare. The length check leaks only the secret's length,
// which is public (always 64 hex chars).
function secretMatches(expected, given) {
  const a = Buffer.from(String(expected))
  const b = Buffer.from(String(given))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/rendezvous.test.js` — Expected: PASS (6/6).
Run: `npm test` — Expected: PASS (no regressions from the pairing.js refactor).

- [ ] **Step 6: Commit**

```bash
git add src/pairing.js src/rendezvous.js test/rendezvous.test.js
git commit -m "Add in-memory rendezvous store for the relay

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Relay HTTP endpoints (create / offer / poll)

**Files:**
- Modify: `src/relay.js`
- Test: `test/relay-rendezvous.test.js` (new)

**Interfaces:**
- Consumes: `makeRendezvousStore` from Task 1; `CODE_ALPHABET`, `normalizeCode` from `src/pairing.js`.
- Produces (used by the apps):
  - `POST /link/rendezvous` (empty body or `{}`) → `201 { rid, secret, expires_in }` | `429`
  - `POST /link/rendezvous/:rid/offer` `{ server, code }` → `204` | `409` | `404` | `400` | `429`
  - `GET /link/rendezvous/:rid?secret=<hex>` → `204` (waiting) | `200 { server, code }` | `403` | `404` | `429`
  - `makeRendezvousLimiter(opts)` and `makeRelayLimiter(...).allowGlobal()` exported from `src/relay.js` (used by tests and `startRelay`).
- `startRelay` gains opts `rendezvous` and `rendezvousLimiter` (defaults constructed inside); `bin/matron-push-relay.js` needs NO change.

- [ ] **Step 1: Write failing tests**

Create `test/relay-rendezvous.test.js`:

```js
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
  const s = await startTestRelay(t)
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/relay-rendezvous.test.js`
Expected: FAIL — `makeRendezvousLimiter` is not exported (SyntaxError on import).

- [ ] **Step 3: Implement in `src/relay.js`**

Three changes:

**(a)** Add `allowGlobal` to `makeRelayLimiter` — insert after the `allow` function (before `sweep`), and add it to the returned object:

```js
  // Global-bucket-only gate, for surfaces that must not carry a per-key
  // bucket (rendezvous offers/polls: a poller hits every 2 s for minutes,
  // and rid existence already bounds what a request can do).
  function allowGlobal() {
    const t = now()
    refill(global, globalBurst, globalRefillMs, t)
    if (global.tokens <= 0) {
      globalDenied += 1
      return false
    }
    global.tokens -= 1
    return true
  }
```

Return: `return { allow, allowGlobal, sweep, _buckets: buckets }`

**(b)** Add imports, the tuned limiter factory, offer validation, and a shared body reader:

```js
import { makeRendezvousStore } from './rendezvous.js'
import { CODE_ALPHABET, normalizeCode } from './pairing.js'
```

```js
// Rendezvous creation is the relay's second unauthenticated surface. One
// sign-in needs exactly one creation, so the per-IP budget is tiny; the
// global ceiling (10/s sustained) is far above legitimate volume and
// bounds offers/polls too (spec §1).
export const makeRendezvousLimiter = (opts = {}) =>
  makeRelayLimiter({ burst: 10, refillMs: 30000, globalBurst: 100, globalRefillMs: 100, ...opts })

const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{8}$`)
const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

// null = valid; otherwise a machine reason (relay convention: never echoes
// caller values). Mirrors the apps' server-URL stance: https from any
// host, http only to localhost-ish dev hosts.
function validateOffer(body) {
  for (const k of Object.keys(body)) {
    if (k !== 'server' && k !== 'code') return 'unknown_field'
  }
  if (body.server === undefined || body.code === undefined) return 'missing_field'
  if (typeof body.server !== 'string' || body.server.length > 200) return 'bad_server'
  let u
  try { u = new URL(body.server) } catch { return 'bad_server' }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCALHOST_HOSTS.has(u.hostname))) return 'bad_server'
  if (typeof body.code !== 'string' || !CODE_RE.test(normalizeCode(body.code))) return 'bad_code'
  return null
}
```

**(c)** Restructure `makeRelayHandler`. New signature and body (the `/push` handling moves verbatim into `handlePush`; `readJsonBody` is the existing streaming read extracted so all three POST routes share the 1 KB cap and keep-alive-safe 413):

```js
export function makeRelayHandler({ apnsClient, limiter = makeRelayLimiter(), rendezvous = makeRendezvousStore(), rendezvousLimiter = makeRendezvousLimiter() }) {
  const respond = (res, httpStatus, obj) => {
    res.writeHead(httpStatus, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  const empty = (res, httpStatus) => {
    res.writeHead(httpStatus)
    res.end()
  }

  // Streaming JSON body read under BODY_LIMIT. Resolves the parsed object,
  // or null after having already responded (413/400). An empty body
  // resolves {} (creation POSTs carry no fields).
  const readJsonBody = (req, res) => new Promise((resolve) => {
    let data = ''
    let overflowed = false
    req.setEncoding('utf8')
    req.on('data', (c) => {
      data += c
      if (data.length > BODY_LIMIT) {
        overflowed = true
        req.removeAllListeners('data')
        req.pause()
        // Partially-unconsumed body: never reuse this socket (same
        // keep-alive desync concern as the journal's readBody 413 path).
        res.setHeader('Connection', 'close')
        respond(res, 413, { status: 413, reason: 'too_large' })
        resolve(null)
      }
    })
    req.on('error', () => resolve(null)) // peer went away: nothing to respond to
    req.on('end', () => {
      if (overflowed) return
      if (!data) { resolve({}); return }
      let body
      try {
        body = JSON.parse(data)
      } catch {
        respond(res, 400, { status: 400, reason: 'bad_json' })
        resolve(null)
        return
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        respond(res, 400, { status: 400, reason: 'bad_json' })
        resolve(null)
        return
      }
      resolve(body)
    })
  })

  async function handlePush(req, res) {
    const body = await readJsonBody(req, res)
    if (body === null) return
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
  }

  async function handleRendezvousCreate(req, res) {
    const body = await readJsonBody(req, res)
    if (body === null) return
    if (Object.keys(body).length > 0) return respond(res, 400, { status: 400, reason: 'unknown_field' })
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown'
    if (!rendezvousLimiter.allow(ip)) return respond(res, 429, { status: 429, reason: 'rate_limited' })
    const r = rendezvous.create()
    // Pending-map cap: same envelope as the limiter — a caller can't tell
    // which throttle it hit, and shouldn't need to.
    if (!r) return respond(res, 429, { status: 429, reason: 'rate_limited' })
    return respond(res, 201, { rid: r.rid, secret: r.secret, expires_in: r.expiresIn })
  }

  async function handleOffer(req, res, rid) {
    const body = await readJsonBody(req, res)
    if (body === null) return
    const invalid = validateOffer(body)
    if (invalid) return respond(res, 400, { status: 400, reason: invalid })
    if (!rendezvousLimiter.allowGlobal()) return respond(res, 429, { status: 429, reason: 'rate_limited' })
    const code = normalizeCode(body.code)
    const r = rendezvous.offer(rid, { server: body.server, code: `${code.slice(0, 4)}-${code.slice(4)}` })
    if (r === 'not_found') return respond(res, 404, { status: 404, reason: 'not_found' })
    if (r === 'conflict') return respond(res, 409, { status: 409, reason: 'conflict' })
    return empty(res, 204)
  }

  function handlePoll(req, res, rid, secret) {
    if (!rendezvousLimiter.allowGlobal()) return respond(res, 429, { status: 429, reason: 'rate_limited' })
    const p = rendezvous.poll(rid, secret)
    if (p.status === 'not_found') return respond(res, 404, { status: 404, reason: 'not_found' })
    if (p.status === 'forbidden') return respond(res, 403, { status: 403, reason: 'forbidden' })
    if (p.status === 'waiting') return empty(res, 204)
    return respond(res, 200, { server: p.server, code: p.code })
  }

  return (req, res) => {
    const url = new URL(req.url, 'http://relay')
    if (req.method === 'POST' && url.pathname === '/push') return handlePush(req, res)
    if (req.method === 'POST' && url.pathname === '/link/rendezvous') return handleRendezvousCreate(req, res)
    const om = url.pathname.match(/^\/link\/rendezvous\/([0-9A-Z]{26})\/offer$/)
    if (req.method === 'POST' && om) return handleOffer(req, res, om[1])
    const pm = url.pathname.match(/^\/link\/rendezvous\/([0-9A-Z]{26})$/)
    if (req.method === 'GET' && pm) return handlePoll(req, res, pm[1], url.searchParams.get('secret'))
    return respond(res, 404, { status: 404, reason: 'not_found' })
  }
}
```

(The old inline `/push` body-reading block is deleted — `handlePush` + `readJsonBody` replace it with identical behavior. Keep `validate`, `buildPayload`, `APS_ALERTS`, `BODY_LIMIT` untouched.)

**(d)** `startRelay` owns the instances so the sweep timer sweeps the same objects the handler uses:

```js
export function startRelay({ apnsClient, port = 0, bind = '127.0.0.1', limiter = makeRelayLimiter(), rendezvous = makeRendezvousStore(), rendezvousLimiter = makeRendezvousLimiter() } = {}) {
  const server = http.createServer(makeRelayHandler({ apnsClient, limiter, rendezvous, rendezvousLimiter }))
  const sweepTimer = setInterval(() => {
    limiter.sweep()
    rendezvousLimiter.sweep()
    rendezvous.sweep()
  }, SWEEP_INTERVAL_MS)
  ...
```

(rest of `startRelay` unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/relay-rendezvous.test.js` — Expected: PASS (11/11).
Run: `npm test` — Expected: PASS, especially `test/relay.test.js` (the /push refactor must be behavior-identical).

- [ ] **Step 5: Commit**

```bash
git add src/relay.js test/relay-rendezvous.test.js
git commit -m "Add rendezvous endpoints to the push relay

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Pre-approved link sessions in `makeLinkStore`

**Files:**
- Modify: `src/link.js`
- Test: `test/link.test.js` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 4): `makeLinkStore` gains opt `preapprovedTtlMs = 600000` and method `startPreapproved(userId)` → `{ linkCode, expiresIn }` or `null` (capped). `claim()` on a pre-approved session returns the normal `{ status: 'claimed', claimToken, expiresIn }` shape but the session lands in `approved`, so the claimant's FIRST `poll()` returns `{ status: 'approved', userId, deviceName }`.

- [ ] **Step 1: Write failing store tests**

Append to `test/link.test.js`:

```js
test('preapproved: claim jumps straight to approved — first poll releases the identity, once', () => {
  const links = makeLinkStore()
  const r = links.startPreapproved(42)
  assert.match(r.linkCode, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4}$/)
  assert.equal(r.expiresIn, 600) // pairing-store pacing, not the 120 s link TTL

  const c = links.claim(r.linkCode, { deviceName: 'First Phone' })
  assert.equal(c.status, 'claimed') // same shape the claimant flow already handles
  const p = links.poll(c.claimToken)
  assert.deepEqual(p, { status: 'approved', userId: 42, deviceName: 'First Phone' })
  assert.deepEqual(links.poll(c.claimToken), { status: 'not_found' }) // one-shot
})

test('preapproved: first claim wins; a later claim of the used code conflicts', () => {
  const links = makeLinkStore()
  const r = links.startPreapproved(42)
  links.claim(r.linkCode, { deviceName: 'x' })
  assert.deepEqual(links.claim(r.linkCode, { deviceName: 'y' }), { status: 'conflict' })
})

test('preapproved: expires on its own 10-minute clock', async () => {
  const links = makeLinkStore({ preapprovedTtlMs: 30 })
  const r = links.startPreapproved(42)
  await new Promise((res) => setTimeout(res, 60))
  assert.deepEqual(links.claim(r.linkCode, { deviceName: 'x' }), { status: 'not_found' })
})

test('preapproved sessions count toward maxPending and coexist with normal ones', () => {
  const links = makeLinkStore({ maxPending: 2 })
  assert.ok(links.startPreapproved(1))
  assert.ok(links.start(7, 1)) // normal session, starter device 7
  assert.equal(links.startPreapproved(1), null) // capped
  assert.equal(links.size(), 2)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/link.test.js`
Expected: FAIL — `links.startPreapproved is not a function`.

- [ ] **Step 3: Implement in `src/link.js`**

Change the factory signature:

```js
export function makeLinkStore({ ttlMs = 120000, claimExtensionMs = 60000, maxPending = 64, preapprovedTtlMs = 600000 } = {}) {
```

Update the Map comment to note the second key form:

```js
  const sessions = new Map() // starterDeviceId (or 'preapproved:<random>') -> { code, userId, status, preapproved, claimToken, deviceName, requesterIp, expiresAt }
```

Add `startPreapproved` right after `start` (the code-uniqueness loop matches `start`):

```js
    // Root-on-the-box provisioning (spec §3): the session is born approved —
    // claim() jumps straight to 'approved', so the claimant's first poll
    // returns the device token with no approve tap (at provisioning time
    // there is no other device to tap on). Synthetic starter key: numeric
    // device ids can never collide with the 'preapproved:' string form, and
    // status/approve/deny key on real device ids so they can't touch these.
    startPreapproved(userId) {
      const now = Date.now()
      sweep(now)
      if (sessions.size >= maxPending) return null
      let code
      do { code = randomCode() } while ([...sessions.values()].some((s) => s.code === code))
      sessions.set(`preapproved:${crypto.randomBytes(8).toString('hex')}`, {
        code, userId, status: 'waiting', preapproved: true, claimToken: null, deviceName: null, requesterIp: null, expiresAt: now + preapprovedTtlMs,
      })
      return { linkCode: `${code.slice(0, 4)}-${code.slice(4)}`, expiresIn: Math.floor(preapprovedTtlMs / 1000) }
    },
```

In `claim()`, replace the line `s.status = 'claimed'` with:

```js
        s.status = s.preapproved ? 'approved' : 'claimed'
```

(Everything else in `claim()` — claimToken mint, deviceName/requesterIp capture, expiry extension, return shape — stays identical. Normal sessions never set `preapproved`, so `s.preapproved` is `undefined` → falsy for them.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/link.test.js` — Expected: PASS (all, including the pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/link.js test/link.test.js
git commit -m "Add pre-approved link sessions to the link store

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `POST /link/preapprove` endpoint (loopback-guarded)

**Files:**
- Modify: `src/http.js`
- Test: `test/link-http.test.js` (append)

**Interfaces:**
- Consumes: `links.startPreapproved(userId)` from Task 3; `db` (user lookup by name, same query shape as `bin/matron-admin.js`).
- Produces (used by Task 5): `POST /link/preapprove` `{ username }` → `200 { link_code, expires_in }` | `404` (unknown user, or non-local caller — indistinguishable) | `400` | `429` (cap).

- [ ] **Step 1: Write failing HTTP tests**

Append to `test/link-http.test.js`:

```js
test('preapprove: mints a code that signs a claimant in with no approve tap', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'hunter22')

  const pre = await s.http('/link/preapprove', { method: 'POST', body: { username: 'dan' } })
  assert.equal(pre.status, 200)
  assert.match(pre.json.link_code, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4}$/)
  assert.equal(pre.json.expires_in, 600)

  const claim = await s.http('/link/claim', { method: 'POST', body: { link_code: pre.json.link_code, device_name: 'First Phone' } })
  assert.equal(claim.status, 200)
  // no /link/approve happens — the very first poll mints the device
  const poll = await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })
  assert.equal(poll.status, 200)
  assert.equal(poll.json.status, 'approved')
  assert.match(poll.json.token, /^[0-9a-f]{64}$/)
  assert.equal(poll.json.username, 'dan')
  // one-shot: second poll 404
  assert.equal((await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })).status, 404)
  // the minted device is a working client bearer
  assert.equal((await s.http('/devices', { token: poll.json.token })).status, 200)
})

test('preapprove guard: any proxy-forwarding header (or unknown user, or bad body) is rejected', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'hunter22')

  // Loopback without forwarding headers is the accept path (covered above).
  // Each forwarding header alone must 404 — external traffic always arrives
  // via the reverse proxy, which adds one of these.
  for (const headers of [
    { 'x-forwarded-for': '203.0.113.9' },
    { 'x-forwarded-proto': 'https' },
    { forwarded: 'for=203.0.113.9' },
    { 'cf-connecting-ip': '203.0.113.9' },
  ]) {
    const r = await fetch(`${s.base}/link/preapprove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ username: 'dan' }),
    })
    assert.equal(r.status, 404, JSON.stringify(headers))
    assert.deepEqual(await r.json(), { error: 'not_found' })
  }

  assert.equal((await s.http('/link/preapprove', { method: 'POST', body: { username: 'nobody' } })).status, 404)
  for (const body of [{}, { username: 7 }, { username: '' }]) {
    assert.equal((await s.http('/link/preapprove', { method: 'POST', body })).status, 400, JSON.stringify(body))
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/link-http.test.js`
Expected: FAIL — the two new tests 404 on `/link/preapprove` (route doesn't exist).

- [ ] **Step 3: Implement in `src/http.js`**

Insert after the `POST /link/poll` block (still in the unauthenticated section, before the `bearer` check):

```js
      if (req.method === 'POST' && url.pathname === '/link/preapprove') {
        // Root-on-the-box only (spec §3): accepted ONLY from a loopback
        // socket with no proxy-forwarding header. External traffic always
        // arrives via the reverse proxy, which adds X-Forwarded-* (or
        // cf-connecting-ip through the tunnel) — so a forwarded request can
        // never look local. To the outside world this endpoint does not
        // exist: everything rejected is a plain 404.
        const remote = req.socket.remoteAddress
        const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
        const forwarded = Object.keys(req.headers).some((h) => h.startsWith('x-forwarded-')) ||
          req.headers.forwarded !== undefined || req.headers['cf-connecting-ip'] !== undefined
        if (!loopback || forwarded) return rejectEarly(req, res, 404, { error: 'not_found' })
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/link-http.test.js` — Expected: PASS.
Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http.js test/link-http.test.js
git commit -m "Add loopback-only POST /link/preapprove

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `matron-admin link-code` + protocol docs

**Files:**
- Modify: `bin/matron-admin.js`, `package.json`, `docs/protocol.md`
- Test: `test/admin.test.js` (append)

**Interfaces:**
- Consumes: `POST /link/preapprove` from Task 4 (over `127.0.0.1:<port>`; the admin CLI is a separate process from the server, so an HTTP call is the only way to reach the in-memory link store).
- Produces (used by dev-boxer): `matron-admin link-code <username> --server-url <url> [--port <n>]` — prints an ANSI QR of `matron://link?v=1&server=<encoded>&code=XXXX-XXXX`, plus the code and server as a manual fallback. `--port` defaults to `MATRON_PORT` or 9810.

- [ ] **Step 1: Add the dependency**

```bash
npm install qrcode-terminal@^0.12.0
```

Verify `package.json` gained `"qrcode-terminal": "^0.12.0"` under `dependencies`.

- [ ] **Step 2: Write failing tests**

Append to `test/admin.test.js` (it already imports `runAdmin`; add the imports it lacks — `startTestServer` from `./helpers.js` and `createUser` from `../src/auth.js` — to the existing import lines if not present):

```js
test('link-code: prints a QR + manual fallback whose code signs a claimant in with no tap', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'hunter22')

  const out = await runAdmin(s.db, ['link-code', 'dan', '--server-url', 'https://chat.example.com', '--port', String(s.port)])
  const code = out.match(/code:\s+([0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4})/)?.[1]
  assert.ok(code, `expected a dashed code in output:\n${out}`)
  assert.match(out, /server:\s+https:\/\/chat\.example\.com/)
  assert.ok(out.includes(`matron://link?v=1&server=${encodeURIComponent('https://chat.example.com')}&code=${code}`))
  assert.match(out, /▄|█/) // an ANSI QR actually rendered

  // the printed code really is pre-approved: claim → first poll mints the device
  const claim = await s.http('/link/claim', { method: 'POST', body: { link_code: code, device_name: 'First Phone' } })
  assert.equal(claim.status, 200)
  const poll = await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })
  assert.equal(poll.json.status, 'approved')
  assert.equal(poll.json.username, 'dan')
})

test('link-code: unknown user and unreachable journal produce actionable errors', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await assert.rejects(
    () => runAdmin(s.db, ['link-code', 'nobody', '--server-url', 'https://x.example.com', '--port', String(s.port)]),
    /no such user/
  )
  await assert.rejects(
    () => runAdmin(s.db, ['link-code', 'dan', '--server-url', 'https://x.example.com', '--port', '1']),
    /not reachable/
  )
  await assert.rejects(
    () => runAdmin(s.db, ['link-code', 'dan', '--server-url', 'not a url', '--port', String(s.port)]),
    /--server-url/
  )
  await assert.rejects(() => runAdmin(s.db, ['link-code']), /usage/)
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/admin.test.js`
Expected: FAIL — `link-code` falls through to `throw new Error(USAGE)`.

- [ ] **Step 4: Implement in `bin/matron-admin.js`**

Add the import at the top:

```js
import qrcode from 'qrcode-terminal'
```

Add to `USAGE` (after the `device revoke` line):

```
  matron-admin link-code <username> --server-url <url> [--port <n>]
```

Add the command branch inside `runAdmin` (before the `offload` branch):

```js
  if (a === 'link-code') {
    const username = argv[1]
    const serverUrl = flag(argv, '--server-url')
    if (!username || !serverUrl) throw new Error(USAGE)
    let parsed
    try { parsed = new URL(serverUrl) } catch { parsed = null }
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      throw new Error(`${USAGE}\n\n--server-url must be an http(s) URL (got ${JSON.stringify(serverUrl)})`)
    }
    const port = Number(flag(argv, '--port') ?? process.env.MATRON_PORT ?? 9810)
    if (!Number.isInteger(port) || port <= 0) throw new Error(`${USAGE}\n\n--port must be a positive integer`)
    // The pre-approved session lives in the RUNNING server's memory — the
    // admin CLI is a separate process, so this must be an HTTP call, and
    // /link/preapprove only answers loopback callers with no proxy headers.
    let r
    try {
      r = await fetch(`http://127.0.0.1:${port}/link/preapprove`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username }),
      })
    } catch {
      throw new Error(`journal not reachable on 127.0.0.1:${port} — is it running? (set --port or MATRON_PORT)`)
    }
    if (r.status === 404) throw new Error(`no such user: ${username}`)
    if (!r.ok) throw new Error(`journal refused the request (HTTP ${r.status})`)
    const { link_code, expires_in } = await r.json()
    const uri = `matron://link?v=1&server=${encodeURIComponent(serverUrl)}&code=${link_code}`
    const qr = await new Promise((resolve) => qrcode.generate(uri, { small: true }, resolve))
    return [
      qr,
      `Scan with the Matron app to sign in as ${username}.`,
      'Or enter it manually on the sign-in screen:',
      `  server: ${serverUrl}`,
      `  code:   ${link_code}`,
      `(${uri})`,
      `The code expires in ${Math.round(expires_in / 60)} minutes and works once.`,
    ].join('\n')
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/admin.test.js` — Expected: PASS.
Run: `npm test` — Expected: PASS.

- [ ] **Step 6: Update `docs/protocol.md`**

Two edits. First, append to the end of the "## Device link (QR sign-in)" section:

```markdown
### Pre-approved link codes (provisioning)

`POST /link/preapprove {username}` mints a link session that is born
approved: the claimant runs the ordinary `link/claim` → `link/poll` flow
and the FIRST poll returns the device token — no approve tap (at
provisioning time there is no other device to tap on). The granting
authority is root on the box: the endpoint answers only loopback sockets
carrying no `X-Forwarded-*`/`Forwarded`/`CF-Connecting-IP` header (external
traffic always arrives via the reverse proxy, which adds one), and 404s
for everyone else. Codes live 10 minutes, are one-shot, and count toward
the same in-memory cap as normal link sessions. `matron-admin link-code
<username> --server-url <url>` wraps this and prints the
`matron://link?v=1&server=…&code=XXXX-XXXX` QR on the terminal.
```

Second, add a new section after the Device link section:

```markdown
## Link rendezvous (relay)

The reverse direction, for signed-out devices that can't scan (spec:
`docs/superpowers/specs/2026-07-18-link-rendezvous-design.md`). Served by
the push relay (`push.matron.chat`), NOT the journal — a brand-new install
has no configuration, and the shared relay is the one address every Matron
app knows. The relay never carries a token: only `{server, code}`, the
same two values the shipped QR displays on screen. The confirm-tap on the
signed-in phone remains the only credential-granting gate.

- `POST /link/rendezvous` (empty body) → `201 {rid, secret, expires_in}`.
  `rid`: 26 chars of the pairing alphabet (~128 bits), shown in the QR as
  `matron://rlink?v=1&rid=<rid>`. `secret`: 256-bit hex poll gate, never
  in the QR. TTL 3 minutes, in-memory only, `maxPending` 256. Per-IP
  token bucket (burst 10, refill 1/30 s) plus a global ceiling (burst
  100, refill 1/100 ms) that also bounds offers and polls.
- `POST /link/rendezvous/:rid/offer {server, code}` — the scanning
  phone's move, after calling `link/start` on its own journal. First
  offer wins → 204; later offers 409; unknown/expired rid 404. `server`
  must be https (http allowed to localhost-ish dev hosts only), ≤ 200
  chars; `code` is normalized to `XXXX-XXXX`. Validation reasons are
  machine strings that never echo caller values.
- `GET /link/rendezvous/:rid?secret=<hex>` — the creator's 2 s poll.
  204 waiting; `200 {server, code}` once offered (NOT one-shot — the
  entry survives to TTL so a dropped response is retryable; it releases
  no credential); 403 on secret mismatch (constant-time); 404 after TTL.

A relay restart forgets pending rendezvous; the signed-out device
regenerates its QR, mirroring link-session behavior.
```

- [ ] **Step 7: Commit**

```bash
git add bin/matron-admin.js package.json package-lock.json test/admin.test.js docs/protocol.md
git commit -m "Add matron-admin link-code with terminal QR

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `npm test` — full suite green, no new warnings in output.
- [ ] `node bin/matron-push-relay.js` still starts (with APNs env vars set it boots; without them it exits with the config error — unchanged behavior).
- [ ] Manual smoke (optional): `MATRON_DB=/tmp/lr.db node src/server.js` + `matron-admin user add dan --password test1234` + `matron-admin link-code dan --server-url https://example.com` prints a scannable QR.
- [ ] Open a non-draft PR against `master` titled "Link rendezvous: relay endpoints, pre-approved link codes, matron-admin link-code" — body summarizes the three surfaces and links the spec; PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
