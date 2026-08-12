# Rendezvous Offer Encryption — Journal (relay) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the relay's rendezvous store into a blind mailbox — it accepts and returns an opaque, app-encrypted `box` string instead of a cleartext `{server, code}` offer, so the relay operator can no longer read or forge a login offer.

**Architecture:** Two changes, both in `matron-journal/src`. The in-memory store (`rendezvous.js`) stores one opaque `box` string per entry in place of `{server, code}`; the HTTP layer (`relay.js`) validates the offer body as `{ box: string }` (non-empty, length-capped) and returns `{ box }` on poll. No decryption, parsing, or normalization happens relay-side. This is a hard `v=2` cutover — no cleartext offer path is kept.

**Tech Stack:** Node.js ESM, `node:test` + `node:assert/strict`, no new dependencies.

## Global Constraints

- **Hard `v=2` cutover** — no cleartext `{server, code}` offer path is retained anywhere.
- The relay **never** decrypts, parses, validates, or normalizes the box — it is opaque bytes to the relay.
- Box length cap: **≤ 1024 chars**; empty/missing/oversized/extra-field bodies → `400` with a machine reason that **never echoes caller input** (relay convention).
- Existing behaviours unchanged: `create()` (rid, 256-bit poll secret, TTL 180 s, `maxPending` 256), first-offer-wins conflict semantics, not-one-shot poll (survives to TTL), constant-time secret compare, the `413` body-size guard, and both rate limiters.
- Deploy order across the whole feature: **journal first** (this plan), then the apps.

---

### Task 1: Rendezvous store holds an opaque box

**Files:**
- Modify: `src/rendezvous.js`
- Test: `test/rendezvous.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `create()` → `{ rid, secret, expiresIn }` (unchanged).
  - `offer(rid, box)` where `box` is a `string`; returns `'not_found' | 'conflict' | 'offered'`. First-box-wins. Stores `box` verbatim, no parsing.
  - `poll(rid, secret)` → `{ status: 'not_found' }` | `{ status: 'forbidden' }` | `{ status: 'waiting' }` | `{ status: 'offered', box }`.

- [ ] **Step 1: Rewrite the store's lifecycle tests to carry a box**

Replace the two lifecycle/round-trip tests in `test/rendezvous.test.js` with the box shape. The other tests (create shape, unknown rid, wrong secret, expiry, maxPending) change only where they call `offer`/read `poll` results — update those call sites in the same edit. Full new file:

```javascript
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeRendezvousStore } from '../src/rendezvous.js'

const BOX = 'q4Jc0FZKpQ2example_opaque_base64url_box_value'

test('create returns a 26-char alphabet rid, 256-bit hex secret, and expiry seconds', () => {
  const store = makeRendezvousStore()
  const r = store.create()
  assert.match(r.rid, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{26}$/)
  assert.match(r.secret, /^[0-9a-f]{64}$/)
  assert.equal(r.expiresIn, 180)
  assert.notEqual(store.create().rid, r.rid)
  assert.equal(store.size(), 2)
})

test('lifecycle: waiting → first box wins → offered survives repeat polls; second box conflicts', () => {
  const store = makeRendezvousStore()
  const { rid, secret } = store.create()
  assert.deepEqual(store.poll(rid, secret), { status: 'waiting' })
  assert.equal(store.offer(rid, BOX), 'offered')
  assert.deepEqual(store.poll(rid, secret), { status: 'offered', box: BOX })
  // NOT one-shot: a dropped poll response must be retryable until TTL
  assert.deepEqual(store.poll(rid, secret), { status: 'offered', box: BOX })
  assert.equal(store.offer(rid, 'a-different-box'), 'conflict')
  // the conflict must not have overwritten the first box
  assert.equal(store.poll(rid, secret).box, BOX)
})

test('unknown rid: offer and poll are not_found', () => {
  const store = makeRendezvousStore()
  assert.equal(store.offer('Z'.repeat(26), BOX), 'not_found')
  assert.deepEqual(store.poll('Z'.repeat(26), 'f'.repeat(64)), { status: 'not_found' })
})

test('wrong secret is forbidden and leaks nothing (waiting and offered look identical)', () => {
  const store = makeRendezvousStore()
  const { rid } = store.create()
  assert.deepEqual(store.poll(rid, 'f'.repeat(64)), { status: 'forbidden' })
  store.offer(rid, BOX)
  assert.deepEqual(store.poll(rid, 'f'.repeat(64)), { status: 'forbidden' })
  assert.deepEqual(store.poll(rid, 'short'), { status: 'forbidden' })
})

test('expiry: entries die at TTL for offer and poll, and sweep() removes them', async () => {
  const store = makeRendezvousStore({ ttlMs: 20 })
  const { rid, secret } = store.create()
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(store.offer(rid, BOX), 'not_found')
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

- [ ] **Step 2: Run the store tests to verify they fail**

Run: `node --test test/rendezvous.test.js`
Expected: FAIL — the lifecycle test errors/asserts because `offer` still expects `{ server, code }` and `poll` still returns `{ server, code }`.

- [ ] **Step 3: Rewrite the store to hold an opaque box**

In `src/rendezvous.js`: update the entry comment and shape, and the three methods. Replace the entry map comment (lines 4–13 block) and the map initialiser + `create`/`offer`/`poll` bodies:

```javascript
import crypto from 'node:crypto'
import { randomChars } from './pairing.js'

// In-memory rendezvous store (spec §1: link rendezvous). Lives in the relay
// process. Holds at most one opaque, app-encrypted offer box per entry for
// ≤ ttlMs — never a token, never a server URL, never a link code. The relay
// cannot read or forge the box: the offer key lives only in the QR and the
// two legitimate devices (rendezvous-offer-encryption spec).
//
// Keyed by rid (~128 bits from the pairing alphabet — unguessable, no
// lookalike glyphs, safe to show in a QR). The creator's poll is gated by a
// separate 256-bit secret so a bystander photographing the QR (which
// carries only the rid) cannot read the box back.
export function makeRendezvousStore({ ttlMs = 180000, maxPending = 256 } = {}) {
  const entries = new Map() // rid -> { secret, box, expiresAt }

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
      entries.set(rid, { secret, box: null, expiresAt: now + ttlMs })
      return { rid, secret, expiresIn: Math.floor(ttlMs / 1000) }
    },
    offer(rid, box) {
      const e = entries.get(rid)
      if (!e || Date.now() >= e.expiresAt) {
        if (e) entries.delete(rid)
        return 'not_found'
      }
      // First box wins — a conflict never overwrites (the desktop may
      // already be acting on the first box).
      if (e.box !== null) return 'conflict'
      e.box = box
      return 'offered'
    },
    poll(rid, secret) {
      const e = entries.get(rid)
      if (!e || Date.now() >= e.expiresAt) {
        if (e) entries.delete(rid)
        return { status: 'not_found' }
      }
      if (!secretMatches(e.secret, secret)) return { status: 'forbidden' }
      if (e.box === null) return { status: 'waiting' }
      // NOT one-shot: the entry survives until TTL so a dropped poll
      // response can be retried. The box is opaque ciphertext and still
      // requires the phone's approve tap once decrypted and claimed.
      return { status: 'offered', box: e.box }
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

- [ ] **Step 4: Run the store tests to verify they pass**

Run: `node --test test/rendezvous.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/rendezvous.js test/rendezvous.test.js
git commit -m "Store an opaque offer box in the rendezvous entry

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Relay HTTP layer accepts and returns the box

**Files:**
- Modify: `src/relay.js`
- Test: `test/relay-rendezvous.test.js`

**Interfaces:**
- Consumes: `rendezvous.offer(rid, box)` and `rendezvous.poll(rid, secret) → { status, box? }` from Task 1.
- Produces (HTTP): `POST /link/rendezvous/:rid/offer` with body `{ box: string }` → `204` | `400` | `404` | `409` | `413` | `429`; `GET /link/rendezvous/:rid?secret=…` → `200 { box }` | `204` | `403` | `404` | `429`.

- [ ] **Step 1: Rewrite the relay HTTP tests to carry a box**

Rewrite `test/relay-rendezvous.test.js`. Keep every test that isn't about offer/poll *content* untouched in behaviour; change the `OFFER` constant, the offer/poll happy path, the validation cases, and the code-normalization test (which no longer applies — replace it with a box round-trip). Full new file:

```javascript
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

const BOX = 'q4Jc0FZKpQ2example_opaque_base64url_box_value'
const OFFER = { box: BOX }

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
  assert.deepEqual(got.json, { box: BOX })
  // dropped-response retry: still 200 with the same box
  assert.deepEqual((await s.poll(c.json.rid, c.json.secret)).json, got.json)

  const second = await s.offer(c.json.rid, { box: 'a-different-box' })
  assert.equal(second.status, 409)
  assert.deepEqual(second.json, { status: 409, reason: 'conflict' })
  assert.equal((await s.poll(c.json.rid, c.json.secret)).json.box, BOX)
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

test('unknown and malformed rids: offer/poll 404', async (t) => {
  const s = await startTestRelay(t)
  assert.equal((await s.offer('Z'.repeat(26), OFFER)).status, 404)
  assert.equal((await s.poll('Z'.repeat(26), 'f'.repeat(64))).status, 404)
  // wrong-shape rid never matches the route
  assert.equal((await s.offer('short', OFFER)).status, 404)
  assert.equal((await s.poll('short', 'f'.repeat(64))).status, 404)
})

test('offer validation 400s with machine reasons that never echo values', async (t) => {
  // Spends several creates on the same IP to exercise offer validation, not
  // creation limiting — raise the per-IP burst so it doesn't starve.
  const s = await startTestRelay(t, { rendezvousLimiter: makeRendezvousLimiter({ burst: 20 }) })
  const bad = [
    [{ box: BOX, extra: 'x' }, 'unknown_field'],
    [{}, 'missing_field'],
    [{ box: '' }, 'bad_box'],
    [{ box: 7 }, 'bad_box'],
    [{ box: 'x'.repeat(1025) }, 'bad_box'], // over the 1024 cap
  ]
  for (const [body, reason] of bad) {
    const c = await s.create()
    const r = await s.offer(c.json.rid, body)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.deepEqual(r.json, { status: 400, reason })
  }
  // a box exactly at the 1024 cap is accepted
  const cap = await s.create()
  assert.equal((await s.offer(cap.json.rid, { box: 'x'.repeat(1024) })).status, 204)
  // bad JSON / non-object / oversized bodies
  const c2 = await s.create()
  assert.equal((await s.offer(c2.json.rid, null, { raw: 'not json' })).status, 400)
  assert.equal((await s.offer(c2.json.rid, null, { raw: '[1]' })).status, 400)
  assert.equal((await s.offer(c2.json.rid, null, { raw: JSON.stringify({ box: 'x'.repeat(2000) }) })).status, 413)
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

- [ ] **Step 2: Run the relay tests to verify they fail**

Run: `node --test test/relay-rendezvous.test.js`
Expected: FAIL — `handleOffer` still runs `validateOffer` (rejects `{ box }` as `unknown_field`) and `handlePoll` still returns `{ server, code }`.

- [ ] **Step 3: Rewrite the relay offer/poll handlers and drop the cleartext validation**

In `src/relay.js`:

(a) The pairing import no longer needs `normalizeCode` — only `CODE_ALPHABET` was used by the offer regex, which is also going. Change line 3 from:

```javascript
import { CODE_ALPHABET, normalizeCode } from './pairing.js'
```

to:

```javascript
```

(remove the line entirely — `pairing.js` exports are no longer used in this file).

(b) Delete the now-dead `CODE_RE`, `LOCALHOST_HOSTS`, and `validateOffer` (the block at lines 122–139, from `const CODE_RE = …` through the end of `validateOffer`). Replace that whole block with the box validator:

```javascript
// null = valid; otherwise a machine reason (relay convention: never echoes
// caller values). The box is opaque app ciphertext — the relay checks only
// that it is a non-empty, length-capped string and never inspects it.
function validateOffer(body) {
  for (const k of Object.keys(body)) {
    if (k !== 'box') return 'unknown_field'
  }
  if (body.box === undefined) return 'missing_field'
  if (typeof body.box !== 'string' || body.box.length < 1 || body.box.length > 1024) return 'bad_box'
  return null
}
```

(c) Replace `handleOffer` (lines 277–288) with the box path — no `normalizeCode`, no dashed-code reconstruction:

```javascript
  async function handleOffer(req, res, rid) {
    const body = await readJsonBody(req, res)
    if (body === null) return
    const invalid = validateOffer(body)
    if (invalid) return respond(res, 400, { status: 400, reason: invalid })
    if (!rendezvousLimiter.allowGlobal()) return respond(res, 429, { status: 429, reason: 'rate_limited' })
    const r = rendezvous.offer(rid, body.box)
    if (r === 'not_found') return respond(res, 404, { status: 404, reason: 'not_found' })
    if (r === 'conflict') return respond(res, 409, { status: 409, reason: 'conflict' })
    return empty(res, 204)
  }
```

(d) Replace `handlePoll`'s success line (line 296) from:

```javascript
    return respond(res, 200, { server: p.server, code: p.code })
```

to:

```javascript
    return respond(res, 200, { box: p.box })
```

- [ ] **Step 4: Run the relay tests to verify they pass**

Run: `node --test test/relay-rendezvous.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full relay + rendezvous suite to confirm nothing else regressed**

Run: `node --test test/relay.test.js test/relay-rendezvous.test.js test/rendezvous.test.js`
Expected: PASS across all three (`relay.test.js` covers `/push` and is untouched by this change).

- [ ] **Step 6: Commit**

```bash
git add src/relay.js test/relay-rendezvous.test.js
git commit -m "Accept and return an opaque offer box at the relay HTTP layer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Notes for the executor

- **Threat-model doc update (spec §4):** the spec calls for rewriting link-rendezvous §4.2 in `docs/superpowers/specs/2026-07-18-link-rendezvous-design.md`. That is a docs-only edit; fold it into the PR as a final commit (no test cycle). Rewrite §4.2 to state the relay now holds only opaque authenticated ciphertext, never the offer key: it cannot read the offer (interception closed) nor forge/substitute one (a forged box fails AES-GCM auth); residual is denial-of-service only, and §4.1 QRLjacking is unchanged and still gated by the approve card.
- **Out of scope, do not touch:** `src/link.js` (the claim/approve flow), `POST /link/preapprove`, `dev-boxer`, `matron-admin`, the `matron://link` forward-claim path. Only the `matron://rlink` rendezvous offer is affected.
