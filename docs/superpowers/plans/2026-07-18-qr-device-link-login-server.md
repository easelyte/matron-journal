# QR Device-Link Login — Server Implementation Plan (matron-journal)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the server side of QR device-link login: a `/link/*` endpoint family that lets a signed-in ("starter") device show a short code, a new ("claimant") device claim it, and the starter approve — minting a `kind='client'` device for the claimant.

**Architecture:** New in-memory `makeLinkStore` in `src/link.js`, closely modeled on `src/pairing.js`'s `makePairStore` (sweep-on-touch expiry, Crockford codes, one-shot identity handoff). Six new handlers in `src/http.js` following the existing `/pair/*` conventions. Spec: `docs/superpowers/specs/2026-07-18-qr-device-link-login-design.md` (§1 Server, §6 Security, §7 Testing).

**Tech Stack:** Node.js ≥20 ESM, `node:test` + `node:assert/strict`, better-sqlite3 (existing), no new dependencies.

## Global Constraints

Copied from the spec — every task's requirements implicitly include these:

- Link session TTL **120 s** from start; on successful claim `expiresAt` extends to `max(current expiresAt, now + 60 s)`.
- Global pending cap **64**; hitting it returns the same `429 {error:'rate_limited'}` shape as the IP limiter.
- **One active session per starter device** — a new `/link/start` from the same device replaces (deletes) its previous session, whatever state it was in.
- Codes: 8 chars from the existing 30-char alphabet `0123456789BCDFGHJKMNPQRSTVWXYZ`, displayed `XXXX-XXXX`, compared via the existing `normalizeCode`. Claim tokens: 256-bit hex (`crypto.randomBytes(32).toString('hex')`).
- First claim wins; sessions are one-shot (deleted before the claimant sees the minted token); a `denied` session is kept until observed once via poll (or TTL), then deleted.
- `/link/claim` shares the **same `rateLimiter` instance** as `/login` and `/pair/start` (per-IP, `cf-connecting-ip` fallback chain). `/link/poll` is deliberately **not** rate-limited (high-entropy key lookup, same stance as `/pair/claim`). `/link/start`, `/link/status`, `/link/approve`, `/link/deny` are Bearer-authenticated, `kind='client'` only (`403 {error:'forbidden'}` otherwise).
- `/link/status`, `/link/approve`, `/link/deny` are bound to the **starter device** (`who.deviceId`), never merely the same user.
- `device_name`: required, string, trimmed, non-empty after trim, max **64** chars.
- Anti-enumeration: unknown and expired merge into `404 {error:'not_found'}` everywhere. `409 {error:'conflict'}` is allowed on `/link/claim` (already claimed) and `/link/approve` (not in `claimed` state).
- The approved poll response MUST include `username` (looked up from the `users` table) — the client apps store the typed username as `UserSession.userID` and a link claimant never types one.
- Minted device is `kind='client'` via the same issuance path `/login` uses (`issueDevice` in `src/auth.js`).
- Response bodies use snake_case field names exactly as tabled in the spec (`link_code`, `expires_in`, `claim_token`, `device_name`, `requester_ip`, `device_id`, `user_id`, `username`).
- Match existing code style: factory functions, terse comments explaining *why*, no classes, no TypeScript.
- Test commands: focused `node --test test/link.test.js` (or `test/link-http.test.js`); full suite `npm test`.

## File Structure

- `src/link.js` (create) — `makeLinkStore({ttlMs, claimExtensionMs, maxPending})`; owns all session state and state-machine rules. No HTTP or DB knowledge.
- `src/pairing.js` (modify) — export the existing private `randomCode` so `link.js` reuses it (DRY with the alphabet comment it sits under).
- `src/auth.js` (modify) — add `createClientDevice(db, userId, name)` beside `createAgent` (same `issueDevice` path, `kind='client'`).
- `src/http.js` (modify) — two unauthenticated handlers (`/link/claim`, `/link/poll`) beside `/pair/claim`; four authenticated handlers (`/link/start`, `/link/status`, `/link/approve`, `/link/deny`) beside `/pair/approve`.
- `src/server.js` (modify) — accept a `links` opt (tests inject short-TTL stores), default `makeLinkStore()`, pass to `makeHttpHandler`.
- `test/link.test.js` (create) — store unit tests, mirroring `test/pairing.test.js`.
- `test/link-http.test.js` (create) — endpoint tests, mirroring `test/pairing-http.test.js`.
- `docs/protocol.md` (modify) — endpoint list entries + a "Device link (QR sign-in)" section beside "Agent pairing (device authorization)".

---

### Task 1: Link store (`src/link.js`)

**Files:**
- Create: `src/link.js`
- Modify: `src/pairing.js:11` (export `randomCode`)
- Test: `test/link.test.js`

**Interfaces:**
- Consumes: `normalizeCode`, `randomCode` from `src/pairing.js`.
- Produces (Task 2 relies on these exact shapes):
  - `makeLinkStore({ ttlMs = 120000, claimExtensionMs = 60000, maxPending = 64 } = {})` returning:
  - `start(starterDeviceId, userId)` → `null` (cap) | `{ linkCode: 'XXXX-XXXX', expiresIn }`
  - `claim(codeInput, { deviceName, requesterIp = null })` → `{status:'not_found'}` | `{status:'conflict'}` | `{status:'claimed', claimToken, expiresIn}`
  - `poll(claimToken)` → `{status:'not_found'}` | `{status:'pending'}` | `{status:'denied'}` (session deleted) | `{status:'approved', userId, deviceName}` (session deleted — one-shot)
  - `status(starterDeviceId)` → `null` | `{status:'waiting', expiresIn}` | `{status:'claimed', deviceName, requesterIp, expiresIn}`
  - `approve(starterDeviceId, codeInput)` → `'not_found'` | `'conflict'` | `'approved'`
  - `deny(starterDeviceId, codeInput)` → `'not_found'` | `'denied'`
  - `size()` → number

- [ ] **Step 1: Export `randomCode` from `src/pairing.js`**

In `src/pairing.js`, change line 11 from:

```js
const randomCode = () => Array.from({ length: CODE_LEN }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('')
```

to:

```js
// Exported for src/link.js: link codes share the pairing alphabet exactly.
export const randomCode = () => Array.from({ length: CODE_LEN }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('')
```

- [ ] **Step 2: Write the failing store tests**

Create `test/link.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeLinkStore } from '../src/link.js'

test('start returns a well-formed session; status is waiting; poll is unknown until claim', () => {
  const store = makeLinkStore()
  const s = store.start(10, 7)
  assert.match(s.linkCode, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4}$/)
  assert.equal(s.expiresIn, 120)
  const st = store.status(10)
  assert.equal(st.status, 'waiting')
  assert.ok(st.expiresIn > 0 && st.expiresIn <= 120)
  assert.deepEqual(store.poll('f'.repeat(64)), { status: 'not_found' })
  assert.equal(store.size(), 1)
})

test('claim flips to claimed, records name+ip, issues a 256-bit token; poll is pending', () => {
  const store = makeLinkStore()
  const s = store.start(10, 7)
  const c = store.claim(s.linkCode, { deviceName: 'Pixel 9', requesterIp: '198.51.100.7' })
  assert.equal(c.status, 'claimed')
  assert.match(c.claimToken, /^[0-9a-f]{64}$/)
  assert.ok(c.expiresIn > 0)
  const st = store.status(10)
  assert.deepEqual(st, { status: 'claimed', deviceName: 'Pixel 9', requesterIp: '198.51.100.7', expiresIn: st.expiresIn })
  assert.deepEqual(store.poll(c.claimToken), { status: 'pending' })
})

test('claim normalizes user-typed codes (lowercase, hyphens, spaces)', () => {
  const store = makeLinkStore()
  const s = store.start(10, 7)
  const sloppy = ` ${s.linkCode.toLowerCase().replace('-', ' ')} `
  assert.equal(store.claim(sloppy, { deviceName: 'x' }).status, 'claimed')
})

test('first claim wins: second claim of the same code is conflict and mutates nothing', () => {
  const store = makeLinkStore()
  const s = store.start(10, 7)
  const c1 = store.claim(s.linkCode, { deviceName: 'first', requesterIp: '1.1.1.1' })
  const c2 = store.claim(s.linkCode, { deviceName: 'second', requesterIp: '2.2.2.2' })
  assert.deepEqual(c2, { status: 'conflict' })
  assert.equal(store.status(10).deviceName, 'first')
  assert.deepEqual(store.poll(c1.claimToken), { status: 'pending' })
})

test('approve → poll returns identity exactly once, then not_found (one-shot)', () => {
  const store = makeLinkStore()
  const s = store.start(10, 7)
  const c = store.claim(s.linkCode, { deviceName: 'Pixel 9' })
  assert.equal(store.approve(10, s.linkCode), 'approved')
  assert.deepEqual(store.poll(c.claimToken), { status: 'approved', userId: 7, deviceName: 'Pixel 9' })
  assert.deepEqual(store.poll(c.claimToken), { status: 'not_found' })
  assert.equal(store.size(), 0)
})

test('approve requires the claimed state: waiting is conflict, resolved is not_found-or-conflict', () => {
  const store = makeLinkStore()
  const s = store.start(10, 7)
  assert.equal(store.approve(10, s.linkCode), 'conflict') // nothing claimed yet
  const c = store.claim(s.linkCode, { deviceName: 'x' })
  assert.equal(store.approve(10, s.linkCode), 'approved')
  assert.equal(store.approve(10, s.linkCode), 'conflict') // already resolved
  store.poll(c.claimToken) // consumes the session
  assert.equal(store.approve(10, s.linkCode), 'not_found') // session gone
})

test('approve and deny are bound to the starter device and to the exact active code', () => {
  const store = makeLinkStore()
  const s = store.start(10, 7)
  store.claim(s.linkCode, { deviceName: 'x' })
  assert.equal(store.approve(99, s.linkCode), 'not_found') // other device, same user — no session
  assert.equal(store.approve(10, 'ZZZZ-ZZZZ'), 'not_found') // right device, wrong code
  assert.equal(store.deny(99, s.linkCode), 'not_found')
  assert.equal(store.approve(10, s.linkCode), 'approved')
})

test('deny → poll observes denied exactly once, then not_found', () => {
  const store = makeLinkStore()
  const s = store.start(10, 7)
  const c = store.claim(s.linkCode, { deviceName: 'x' })
  assert.equal(store.deny(10, s.linkCode), 'denied')
  assert.deepEqual(store.poll(c.claimToken), { status: 'denied' })
  assert.deepEqual(store.poll(c.claimToken), { status: 'not_found' })
  assert.equal(store.size(), 0)
})

test('deny works on a waiting session too; an approved session cannot be denied', () => {
  const store = makeLinkStore()
  const s = store.start(10, 7)
  assert.equal(store.deny(10, s.linkCode), 'denied') // waiting → denied
  const s2 = store.start(11, 7)
  const c2 = store.claim(s2.linkCode, { deviceName: 'x' })
  store.approve(11, s2.linkCode)
  assert.equal(store.deny(11, s2.linkCode), 'not_found') // approved is already resolved
  assert.equal(store.poll(c2.claimToken).status, 'approved') // deny attempt mutated nothing
})

test('one active session per starter: a new start replaces the old one', () => {
  const store = makeLinkStore()
  const s1 = store.start(10, 7)
  const s2 = store.start(10, 7)
  assert.equal(store.size(), 1)
  assert.deepEqual(store.claim(s1.linkCode, { deviceName: 'x' }), { status: 'not_found' })
  assert.equal(store.claim(s2.linkCode, { deviceName: 'x' }).status, 'claimed')
})

test('expiry: claim, poll, status, approve all see an expired session as gone', async () => {
  const store = makeLinkStore({ ttlMs: 20, claimExtensionMs: 0 })
  const s = store.start(10, 7)
  const c = store.claim(s.linkCode, { deviceName: 'x' })
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(store.poll(c.claimToken), { status: 'not_found' })
  assert.equal(store.status(10), null)
  assert.equal(store.approve(10, s.linkCode), 'not_found')
  assert.deepEqual(store.claim(s.linkCode, { deviceName: 'x' }), { status: 'not_found' })
})

test('claim extends the TTL to at least claimExtensionMs from now', async () => {
  // Generous margins so a setTimeout overshoot can't turn this into a flake:
  // the claim lands well inside the 150ms TTL, and the second sleep lands
  // well past the ORIGINAL expiry but far from the 5s extension.
  const store = makeLinkStore({ ttlMs: 150, claimExtensionMs: 5000 })
  const s = store.start(10, 7)
  await new Promise((r) => setTimeout(r, 50))
  const c = store.claim(s.linkCode, { deviceName: 'x' })
  assert.equal(c.status, 'claimed')
  await new Promise((r) => setTimeout(r, 150)) // past the ORIGINAL expiry
  assert.deepEqual(store.poll(c.claimToken), { status: 'pending' }) // still alive: extension applied
  assert.equal(store.approve(10, s.linkCode), 'approved')
})

test('claim never shortens a longer remaining TTL', () => {
  const store = makeLinkStore({ ttlMs: 120000, claimExtensionMs: 60000 })
  const s = store.start(10, 7)
  const c = store.claim(s.linkCode, { deviceName: 'x' })
  // full 120s remained at claim; max(remaining, now+60s) keeps ~120s
  assert.ok(c.expiresIn > 60, `expiresIn ${c.expiresIn} should reflect the untouched 120s TTL`)
})

test('cap: start returns null at maxPending; expired sessions free slots; replacement is exempt', async () => {
  const store = makeLinkStore({ ttlMs: 20, maxPending: 2 })
  assert.ok(store.start(1, 7))
  assert.ok(store.start(2, 7))
  assert.equal(store.start(3, 7), null) // cap hit
  assert.ok(store.start(1, 7)) // same starter replaces its own — never blocked by the cap
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(store.start(3, 7)) // sweep reclaimed the expired slots
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/danbarker/Dev/matron-journal && node --test test/link.test.js`
Expected: FAIL — `Cannot find module '../src/link.js'` (ERR_MODULE_NOT_FOUND).

- [ ] **Step 4: Implement `src/link.js`**

```js
import crypto from 'node:crypto'
import { normalizeCode, randomCode } from './pairing.js'

// In-memory link-session store (spec §1: QR device-link login). Same
// in-memory-factory shape as makePairStore: a restart forgets pending
// links, which is fine — the show side auto-regenerates, and nothing
// durable exists until the approved poll mints the device.
//
// Keyed by starterDeviceId because "one active session per starter" is a
// store invariant — the Map key enforces it structurally, and start() is a
// plain replace. claim() scans for the low-entropy code and poll() scans
// for the 256-bit claimToken; both scans are bounded by maxPending (≤64).
export function makeLinkStore({ ttlMs = 120000, claimExtensionMs = 60000, maxPending = 64 } = {}) {
  const sessions = new Map() // starterDeviceId -> { code, userId, status, claimToken, deviceName, requesterIp, expiresAt }

  const sweep = (now) => {
    for (const [k, s] of sessions) if (now >= s.expiresAt) sessions.delete(k)
  }

  return {
    start(starterDeviceId, userId) {
      const now = Date.now()
      // Replace-before-cap-check: a starter refreshing its own session must
      // never be blocked by the cap its old session helped fill.
      sessions.delete(starterDeviceId)
      sweep(now)
      if (sessions.size >= maxPending) return null
      let code
      do { code = randomCode() } while ([...sessions.values()].some((s) => s.code === code))
      sessions.set(starterDeviceId, {
        code, userId, status: 'waiting', claimToken: null, deviceName: null, requesterIp: null, expiresAt: now + ttlMs,
      })
      return { linkCode: `${code.slice(0, 4)}-${code.slice(4)}`, expiresIn: Math.floor(ttlMs / 1000) }
    },
    claim(codeInput, { deviceName, requesterIp = null }) {
      const now = Date.now()
      sweep(now)
      const code = normalizeCode(codeInput)
      for (const s of sessions.values()) {
        if (s.code !== code) continue
        // First claim wins; any later claim of a used code learns only that
        // it was used (spec §6: telling the truth here leaks nothing useful).
        if (s.status !== 'waiting') return { status: 'conflict' }
        s.status = 'claimed'
        s.claimToken = crypto.randomBytes(32).toString('hex')
        s.deviceName = deviceName
        s.requesterIp = requesterIp
        // A last-second scan still leaves time for the approve tap.
        s.expiresAt = Math.max(s.expiresAt, now + claimExtensionMs)
        return { status: 'claimed', claimToken: s.claimToken, expiresIn: Math.ceil((s.expiresAt - now) / 1000) }
      }
      return { status: 'not_found' }
    },
    poll(claimToken) {
      const now = Date.now()
      for (const [k, s] of sessions) {
        if (s.claimToken !== claimToken || s.claimToken === null) continue
        if (now >= s.expiresAt) { sessions.delete(k); return { status: 'not_found' } }
        if (s.status === 'claimed') return { status: 'pending' }
        // denied and approved are both observe-once: delete before returning
        // (one-shot — the identity is gone before the caller sees it).
        sessions.delete(k)
        if (s.status === 'denied') return { status: 'denied' }
        return { status: 'approved', userId: s.userId, deviceName: s.deviceName }
      }
      return { status: 'not_found' }
    },
    status(starterDeviceId) {
      const now = Date.now()
      const s = sessions.get(starterDeviceId)
      if (!s || now >= s.expiresAt) {
        if (s) sessions.delete(starterDeviceId)
        return null
      }
      const expiresIn = Math.ceil((s.expiresAt - now) / 1000)
      if (s.status === 'waiting') return { status: 'waiting', expiresIn }
      if (s.status === 'claimed') return { status: 'claimed', deviceName: s.deviceName, requesterIp: s.requesterIp, expiresIn }
      // approved/denied: terminal for the show side — nothing actionable left.
      return null
    },
    approve(starterDeviceId, codeInput) {
      const s = activeOwn(starterDeviceId, codeInput)
      if (!s) return 'not_found'
      // Only a claimed session can be approved: approving before anyone
      // claimed would blind-sign whoever claims next.
      if (s.status !== 'claimed') return 'conflict'
      s.status = 'approved'
      return 'approved'
    },
    deny(starterDeviceId, codeInput) {
      const s = activeOwn(starterDeviceId, codeInput)
      if (!s) return 'not_found'
      // waiting is deniable too (the user can kill a code pre-claim), but an
      // approved session is already resolved.
      if (s.status !== 'waiting' && s.status !== 'claimed') return 'not_found'
      s.status = 'denied'
      return 'denied'
    },
    size() { return sessions.size },
  }

  // The starter-device binding (spec §6): the session must belong to this
  // device AND the supplied code must match — a belt-and-braces intent
  // check so a stale approve tap can't act on a newer session. Expired,
  // missing, other-device, and wrong-code all collapse to null (→ 404).
  function activeOwn(starterDeviceId, codeInput) {
    const now = Date.now()
    const s = sessions.get(starterDeviceId)
    if (!s) return null
    if (now >= s.expiresAt) { sessions.delete(starterDeviceId); return null }
    if (s.code !== normalizeCode(codeInput)) return null
    return s
  }
}
```

Note: `activeOwn` is a function declaration after the `return` — hoisting makes this valid; if the implementer prefers, define it as a `const` above the `return` instead. Either way it must not be exported.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/danbarker/Dev/matron-journal && node --test test/link.test.js`
Expected: PASS, 14/14.

- [ ] **Step 6: Run the pairing tests to confirm the `randomCode` export changed nothing**

Run: `cd /Users/danbarker/Dev/matron-journal && node --test test/pairing.test.js`
Expected: PASS, all tests.

- [ ] **Step 7: Commit**

```bash
git add src/link.js src/pairing.js test/link.test.js
git commit -m "Add makeLinkStore for QR device-link sessions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: HTTP endpoints + wiring

**Files:**
- Modify: `src/auth.js` (add `createClientDevice` beside `createAgent`, ~line 74)
- Modify: `src/http.js` (imports line 2; factory signature line 70; unauth handlers after `/pair/claim` ends ~line 145; auth handlers after `/pair/preview` ends ~line 247)
- Modify: `src/server.js` (import ~line 7; opts ~line 194; resolved store ~line 213; handler args ~line 228)
- Test: `test/link-http.test.js`

**Interfaces:**
- Consumes: the exact `makeLinkStore` API from Task 1; `issueDevice`/`createAgent` pattern in `src/auth.js`; `startTestServer(opts)` from `test/helpers.js` (opts spread straight into `startServer`, so `startTestServer({ links: makeLinkStore({...}) })` works once `startServer` accepts `links`).
- Produces: the six wire endpoints exactly as the spec §1 table (consumed by both app plans):
  - `POST /link/start` (Bearer client) → `200 {link_code, expires_in}` | `429 {error:'rate_limited'}`
  - `POST /link/claim` (unauth, IP-limited) → `200 {status:'claimed', claim_token, expires_in}` | `400/404/409/429`
  - `POST /link/poll` (unauth, unlimited) → `200 {status:'pending'}` | `200 {status:'approved', token, device_id, user_id, username}` | `200 {status:'denied'}` | `400/404`
  - `POST /link/status` (Bearer client, starter only) → `200 {status:'waiting', expires_in}` | `200 {status:'claimed', device_name, requester_ip, expires_in}` | `404`
  - `POST /link/approve` (Bearer client, starter only) → `200 {status:'approved'}` | `400/404/409`
  - `POST /link/deny` (Bearer client, starter only) → `200 {status:'denied'}` | `400/404`
  - `createClientDevice(db, userId, name)` → `{token, deviceId}` in `src/auth.js`

- [ ] **Step 1: Write the failing HTTP tests**

Create `test/link-http.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { makeLinkStore } from '../src/link.js'

async function loggedInClient(s, username = 'dan', password = 'hunter22', deviceName = 'phone') {
  await createUser(s.db, username, password)
  const login = await s.http('/login', { method: 'POST', body: { username, password, device_name: deviceName } })
  return login.json
}

test('happy path: start → claim → status shows claimant → approve → poll mints a client device with username', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)

  const start = await s.http('/link/start', { method: 'POST', token: me.token, body: {} })
  assert.equal(start.status, 200)
  assert.match(start.json.link_code, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4}$/)
  assert.equal(start.json.expires_in, 120)

  // waiting before anyone claims
  const waiting = await s.http('/link/status', { method: 'POST', token: me.token, body: {} })
  assert.equal(waiting.json.status, 'waiting')

  const claim = await s.http('/link/claim', { method: 'POST', body: { link_code: start.json.link_code, device_name: '  Pixel 9  ' } })
  assert.equal(claim.status, 200)
  assert.equal(claim.json.status, 'claimed')
  assert.match(claim.json.claim_token, /^[0-9a-f]{64}$/)
  assert.ok(claim.json.expires_in > 0)

  // the approve screen sees the (trimmed) device name and requester IP
  const st = await s.http('/link/status', { method: 'POST', token: me.token, body: {} })
  assert.equal(st.json.status, 'claimed')
  assert.equal(st.json.device_name, 'Pixel 9')
  assert.equal(typeof st.json.requester_ip, 'string')
  assert.ok(st.json.requester_ip.length > 0)

  // pending before approve; and crucially NO device row exists yet
  const pending = await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })
  assert.deepEqual(pending.json, { status: 'pending' })
  let roster = await s.http('/devices', { token: me.token })
  assert.equal(roster.json.devices.length, 1) // just the phone

  const approve = await s.http('/link/approve', { method: 'POST', token: me.token, body: { link_code: start.json.link_code } })
  assert.equal(approve.status, 200)
  assert.deepEqual(approve.json, { status: 'approved' })
  // still no device row: mint happens at poll, not approve
  roster = await s.http('/devices', { token: me.token })
  assert.equal(roster.json.devices.length, 1)

  const poll = await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })
  assert.equal(poll.status, 200)
  assert.equal(poll.json.status, 'approved')
  assert.match(poll.json.token, /^[0-9a-f]{64}$/)
  assert.ok(Number.isInteger(poll.json.device_id))
  assert.equal(poll.json.user_id, me.user_id)
  assert.equal(poll.json.username, 'dan') // apps store this as UserSession.userID

  // exactly once: second poll is 404
  assert.equal((await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })).status, 404)

  // the minted device is a real client of the starter's user, named by the claimant…
  roster = await s.http('/devices', { token: me.token })
  const minted = roster.json.devices.find((d) => d.device_id === poll.json.device_id)
  assert.equal(minted.kind, 'client')
  assert.equal(minted.name, 'Pixel 9')
  // …and its token works as a full client bearer (client-only surface)
  const asNew = await s.http('/devices', { token: poll.json.token })
  assert.equal(asNew.status, 200)
})

test('starter-device binding: a second client of the same user cannot status/approve/deny the session', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)
  const other = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'hunter22', device_name: 'tablet' } })

  const start = await s.http('/link/start', { method: 'POST', token: me.token, body: {} })
  await s.http('/link/claim', { method: 'POST', body: { link_code: start.json.link_code, device_name: 'x' } })

  assert.equal((await s.http('/link/status', { method: 'POST', token: other.json.token, body: {} })).status, 404)
  assert.equal((await s.http('/link/approve', { method: 'POST', token: other.json.token, body: { link_code: start.json.link_code } })).status, 404)
  assert.equal((await s.http('/link/deny', { method: 'POST', token: other.json.token, body: { link_code: start.json.link_code } })).status, 404)
  // the true starter still can
  assert.equal((await s.http('/link/approve', { method: 'POST', token: me.token, body: { link_code: start.json.link_code } })).status, 200)
})

test('approve preconditions: 409 before any claim, 404 on a wrong code (intent check)', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)
  const start = await s.http('/link/start', { method: 'POST', token: me.token, body: {} })

  const early = await s.http('/link/approve', { method: 'POST', token: me.token, body: { link_code: start.json.link_code } })
  assert.equal(early.status, 409)
  assert.deepEqual(early.json, { error: 'conflict' })

  const wrong = await s.http('/link/approve', { method: 'POST', token: me.token, body: { link_code: 'ZZZZ-ZZZZ' } })
  assert.equal(wrong.status, 404)
})

test('deny: claimant polls denied exactly once, then 404; second claim of the code is 409', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)
  const start = await s.http('/link/start', { method: 'POST', token: me.token, body: {} })
  const claim = await s.http('/link/claim', { method: 'POST', body: { link_code: start.json.link_code, device_name: 'x' } })

  const second = await s.http('/link/claim', { method: 'POST', body: { link_code: start.json.link_code, device_name: 'y' } })
  assert.equal(second.status, 409)
  assert.deepEqual(second.json, { error: 'conflict' })

  const deny = await s.http('/link/deny', { method: 'POST', token: me.token, body: { link_code: start.json.link_code } })
  assert.equal(deny.status, 200)
  assert.deepEqual(deny.json, { status: 'denied' })

  assert.deepEqual((await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })).json, { status: 'denied' })
  assert.equal((await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })).status, 404)
  // denied leaves zero DB residue
  const roster = await s.http('/devices', { token: me.token })
  assert.equal(roster.json.devices.length, 1)
})

test('a new start replaces the previous session: the old code stops claiming', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)
  const first = await s.http('/link/start', { method: 'POST', token: me.token, body: {} })
  const second = await s.http('/link/start', { method: 'POST', token: me.token, body: {} })
  assert.equal((await s.http('/link/claim', { method: 'POST', body: { link_code: first.json.link_code, device_name: 'x' } })).status, 404)
  assert.equal((await s.http('/link/claim', { method: 'POST', body: { link_code: second.json.link_code, device_name: 'x' } })).status, 200)
})

test('expired session leaves zero DB residue and polls 404', async (t) => {
  const s = await startTestServer({ links: makeLinkStore({ ttlMs: 30, claimExtensionMs: 0 }) })
  t.after(() => s.close())
  const me = await loggedInClient(s)
  const start = await s.http('/link/start', { method: 'POST', token: me.token, body: {} })
  const claim = await s.http('/link/claim', { method: 'POST', body: { link_code: start.json.link_code, device_name: 'x' } })
  await s.http('/link/approve', { method: 'POST', token: me.token, body: { link_code: start.json.link_code } })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal((await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })).status, 404)
  const roster = await s.http('/devices', { token: me.token })
  assert.equal(roster.json.devices.length, 1) // no orphan client row, ever
})

test('gating: starter endpoints need a client bearer (401 unauth, 403 agent)', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await loggedInClient(s)
  const agent = createAgent(s.db, 1, 'existing-agent')

  for (const path of ['/link/start', '/link/status', '/link/approve', '/link/deny']) {
    const body = path === '/link/approve' || path === '/link/deny' ? { link_code: 'XXXX-XXXX' } : {}
    assert.equal((await s.http(path, { method: 'POST', body })).status, 401, path)
    assert.equal((await s.http(path, { method: 'POST', token: agent.token, body })).status, 403, path)
  }
})

test('validation: bad claim/poll/approve/deny bodies are 400', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)

  const longName = 'x'.repeat(65)
  for (const body of [
    {},
    { link_code: 'ABCD-1234' },                             // missing device_name
    { device_name: 'x' },                                   // missing link_code
    { link_code: 7, device_name: 'x' },                     // non-string code
    { link_code: 'ABCD-1234', device_name: 7 },             // non-string name
    { link_code: 'ABCD-1234', device_name: '' },            // empty name
    { link_code: 'ABCD-1234', device_name: '   ' },         // whitespace-only name
    { link_code: 'ABCD-1234', device_name: longName },      // > 64 chars
  ]) {
    const r = await s.http('/link/claim', { method: 'POST', body })
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.deepEqual(r.json, { error: 'bad_request' })
  }

  for (const body of [{}, { claim_token: 7 }, { claim_token: '' }]) {
    assert.equal((await s.http('/link/poll', { method: 'POST', body })).status, 400, JSON.stringify(body))
  }
  for (const path of ['/link/approve', '/link/deny']) {
    for (const body of [{}, { link_code: 7 }, { link_code: '' }]) {
      assert.equal((await s.http(path, { method: 'POST', token: me.token, body })).status, 400, `${path} ${JSON.stringify(body)}`)
    }
  }

  // anti-enumeration: unknown code and unknown token are plain 404s
  assert.equal((await s.http('/link/claim', { method: 'POST', body: { link_code: 'ZZZZ-ZZZZ', device_name: 'x' } })).status, 404)
  assert.equal((await s.http('/link/poll', { method: 'POST', body: { claim_token: 'f'.repeat(64) } })).status, 404)
  // status with no session at all is 404 too
  assert.equal((await s.http('/link/status', { method: 'POST', token: me.token, body: {} })).status, 404)
})

test('link/claim shares the per-IP limiter; link/poll is unlimited', async (t) => {
  // rateLimiter default: 5/min per IP. All test-client requests share 127.0.0.1.
  const s = await startTestServer()
  t.after(() => s.close())
  // burn the whole budget on claims of unknown codes (no login — that would spend budget)
  for (let i = 0; i < 5; i++) {
    const r = await s.http('/link/claim', { method: 'POST', body: { link_code: 'ZZZZ-ZZZZ', device_name: 'x' } })
    assert.equal(r.status, 404, `claim ${i} should be within budget`)
  }
  const limited = await s.http('/link/claim', { method: 'POST', body: { link_code: 'ZZZZ-ZZZZ', device_name: 'x' } })
  assert.equal(limited.status, 429)
  assert.deepEqual(limited.json, { error: 'rate_limited' })
  // poll is not limited: still 404 (not 429) after the budget is gone
  assert.equal((await s.http('/link/poll', { method: 'POST', body: { claim_token: 'f'.repeat(64) } })).status, 404)
})

test('store cap surfaces as the limiter 429 shape on start', async (t) => {
  const s = await startTestServer({ links: makeLinkStore({ maxPending: 1 }) })
  t.after(() => s.close())
  const me = await loggedInClient(s)
  const other = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'hunter22', device_name: 'tablet' } })
  assert.equal((await s.http('/link/start', { method: 'POST', token: me.token, body: {} })).status, 200)
  const capped = await s.http('/link/start', { method: 'POST', token: other.json.token, body: {} })
  assert.equal(capped.status, 429)
  assert.deepEqual(capped.json, { error: 'rate_limited' })
  // the first starter can still refresh its own session (replacement is cap-exempt)
  assert.equal((await s.http('/link/start', { method: 'POST', token: me.token, body: {} })).status, 200)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/danbarker/Dev/matron-journal && node --test test/link-http.test.js`
Expected: FAIL — every test hits `404 {error:'not_found'}` where it expects a link endpoint (the routes don't exist yet).

- [ ] **Step 3: Add `createClientDevice` to `src/auth.js`**

Immediately after `createAgent` (line 74-76):

```js
// The /link/* claimant mint: same issuance path /login uses (kind='client'),
// called at the first poll after approval — mirror of createAgent's role in
// the pairing flow.
export function createClientDevice(db, userId, name) {
  return issueDevice(db, userId, 'client', name)
}
```

- [ ] **Step 4: Wire the handlers into `src/http.js`**

Line 2 — extend the import:

```js
import { login, authToken, changePassword, revokeOwnedDevice, createAgent, createClientDevice } from './auth.js'
```

Line 70 — extend the factory signature:

```js
export function makeHttpHandler({ db, rateLimiter, loginGuard, mediaDir, mediaMaxBytes, hub, pushPipeline, dbPath, pairs, links }) {
```

After the `/pair/claim` handler's closing brace (line 145), before `const who = bearer(req) && authToken(db, bearer(req))`, insert the two unauthenticated handlers:

```js
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
```

After the `/pair/preview` handler's closing brace (line 247), insert the four authenticated handlers:

```js
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
```

- [ ] **Step 5: Wire the store into `src/server.js`**

Line 7 — extend the import:

```js
import { makePairStore } from './pairing.js'
import { makeLinkStore } from './link.js'
```

Line 191-195 — add `links` to the opts destructure:

```js
export function startServer({
  dbPath, port = 0, bind = '127.0.0.1', mediaDir, mediaMaxBytes, apnsClient, replayBackpressureBytes,
  retentionDays, retentionIntervalMs, maxReplay, revocationSweepMs, walCheckpointIntervalMs, toolStreamOpts,
  toolLogTtlHours, pairs, links,
} = {}) {
```

After `const resolvedPairs = pairs || makePairStore()` (line 213):

```js
  const resolvedLinks = links || makeLinkStore()
```

Line 226-229 — pass it to the handler:

```js
  const server = http.createServer(makeHttpHandler({
    db, rateLimiter, loginGuard, mediaDir: resolvedMediaDir, mediaMaxBytes: resolvedMediaMaxBytes,
    hub, pushPipeline, dbPath: resolvedDbPath, pairs: resolvedPairs, links: resolvedLinks,
  }))
```

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `cd /Users/danbarker/Dev/matron-journal && node --test test/link-http.test.js`
Expected: PASS, 10/10.

- [ ] **Step 7: Run the full suite**

Run: `cd /Users/danbarker/Dev/matron-journal && npm test`
Expected: PASS — no existing test touched `makeHttpHandler`'s signature positionally, so nothing else should move.

- [ ] **Step 8: Commit**

```bash
git add src/auth.js src/http.js src/server.js test/link-http.test.js
git commit -m "Add /link/* endpoints for QR device-link login

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Protocol documentation

**Files:**
- Modify: `docs/protocol.md` (endpoint list around lines 80-98; new section beside "Agent pairing (device authorization)" around line 257)

**Interfaces:**
- Consumes: the wire shapes produced by Task 2 (must match them exactly — this file is what the two app implementations read).
- Produces: nothing code-facing.

- [ ] **Step 1: Add the endpoint entries**

In the HTTP endpoint list (after the `POST /pair/claim` entry, ~line 98), add:

```markdown
- `POST /link/start` (Bearer, client devices only) -> `{link_code, expires_in}`.
  Starts a device-link session for QR sign-in (TTL 120s). One active session
  per starter device: a new start replaces the previous one. Store cap 64
  pending -> 429 `{error:'rate_limited'}`.
- `POST /link/claim {link_code, device_name}` (unauthenticated; shares
  /login's per-IP rate limit) -> `{status:'claimed', claim_token, expires_in}`.
  First claim wins: already-claimed is 409 `{error:'conflict'}`; unknown and
  expired merge into 404. `device_name` is trimmed, non-empty, max 64 chars.
  A successful claim extends the session TTL to at least 60s remaining.
- `POST /link/poll {claim_token}` (unauthenticated, not rate-limited) ->
  `{status:'pending'}` until the starter acts, then exactly once
  `{status:'approved', token, device_id, user_id, username}` (the `client`
  device is minted at this poll; the session is deleted first) or
  `{status:'denied'}` (observed once, then the session is deleted). Unknown /
  expired / already-observed: 404. `username` is included because link
  claimants never type one.
- `POST /link/status` (Bearer, client devices only; starter device only) ->
  `{status:'waiting', expires_in}` or
  `{status:'claimed', device_name, requester_ip, expires_in}`. 404 when the
  device has no active session (none started, expired, or already resolved).
- `POST /link/approve {link_code}` (Bearer, client devices only; starter
  device only, and the code must match its active session) ->
  `{status:'approved'}`. 409 `{error:'conflict'}` when the session is not in
  the `claimed` state (nothing to approve yet, or already resolved); 404 for
  unknown/expired/other-device.
- `POST /link/deny {link_code}` (Bearer, same binding as approve) ->
  `{status:'denied'}`. 404 for unknown/expired/other-device/already-resolved.
```

- [ ] **Step 2: Add the narrative section**

After the "Agent pairing (device authorization)" section (starts ~line 257), add a sibling section:

```markdown
## Device link (QR sign-in)

The reverse of agent pairing: here the *signed-in* side starts. A signed-in
client ("starter") calls `link/start` and renders the `link_code` as a QR
(`matron://link?v=1&server=<url-encoded base URL>&code=XXXX-XXXX`) plus the
code as text. The new device ("claimant") scans or types the code and calls
`link/claim` with its device name, then polls `link/poll` with its secret
`claim_token` (32 random bytes hex). The starter polls `link/status`, sees
`claimed` with the claimant's name and IP, and the user taps Approve
(`link/approve`) or Deny (`link/deny`). Scanning alone never signs anything
in: only the approve tap — from the starter device itself, holding a live
bearer — releases an identity.

Like pairing, no `devices` row exists before the final step: approve only
flips the in-memory session's state, and the `kind='client'` row is minted
at the claimant's next `link/poll`, exactly once (the session is deleted
before the token is returned). Sessions live 120s (extended to ≥60s
remaining on claim so a last-second scan still leaves time for the tap),
are in-memory only, and die with a restart or with the starter's token —
`link/approve` requires a live starter bearer at tap time, so a revoked or
signed-out starter can never complete a link.
```

- [ ] **Step 3: Verify the suite still passes (docs-only change, sanity)**

Run: `cd /Users/danbarker/Dev/matron-journal && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/protocol.md
git commit -m "Document /link/* device-link endpoints in protocol.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
