# Push Relay + Notification Settings v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let self-hosted Matron journals deliver push notifications through a stateless, content-blind relay at push.matron.chat, with per-device notification preferences enforced server-side.

**Architecture:** Three pieces, all in matron-journal: (1) a relay HTTP service (`src/relay.js` + `bin/matron-push-relay.js`) that holds the APNs key and maps a content-free `{category, …}` request to a fixed-string APNs alert; (2) a gateway client (`src/gateway.js`) with the exact `makeApnsClient` contract, injected into the existing push pipeline for journals with no APNs key; (3) a `push_prefs` column on `devices` enforced in the pipeline's device loop and settable via `PUT /push/prefs`. Dan's own journal keeps using direct APNs — behavior unchanged.

**Tech Stack:** Node >= 20 ESM, `node:test` + `node:assert/strict`, `node:http` / `node:http2`, better-sqlite3. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-07-16-push-relay-and-notification-settings-design.md` (same repo). Work on branch `feat/push-relay`.

## Global Constraints

- Privacy is structural: the relay wire protocol has **no field** that can carry a title, body, snippet, or conversation name. The gateway client must never serialize `payload.aps.alert`.
- Relay alert strings, verbatim: title `Matron`; bodies `Your agent needs you` (attention), `Session finished` (done), `New activity from your agent` (activity). All three alert categories set `mutable-content: 1`. Category `wake` sends `{"content-available": 1}` as a background push.
- Relay abuse controls: per-device-token token bucket burst 20, refill 1 token/minute, 429 when empty; request body limit 1 KB; unknown JSON fields → 400; never log more than an 8-char token prefix; never log request bodies.
- Client contract (shared by `makeApnsClient` and `makeGatewayClient`): `send(opts)` resolves `{status, reason}`, **never rejects**; transport failure → `{status: 0, reason: 'transport'}`; timeout → `{status: 0, reason: 'timeout'}`; `close()` exists.
- `wake` pushes (read_marker badge sync) are never filtered by prefs. Child conversations stay exempt from all push (existing behavior, don't touch).
- `push_prefs` NULL means all-on (every device predating the column). Stored shape: `{"attention":bool,"done":bool,"activity":bool}`, always all three keys.
- Env vars: relay uses the same four `MATRON_APNS_*` vars plus `MATRON_RELAY_PORT` (default 9821) and `MATRON_RELAY_BIND` (default 127.0.0.1). Journal gateway mode: `MATRON_PUSH_GATEWAY_URL`.
- DB migrations are in-place `ALTER TABLE` guarded by `PRAGMA table_info` (the `apns_env` pattern in `openDb`) — never a destructive rebuild.
- Run tests with `npm test` (runs `node --test 'test/**/*.js'`) or targeted `node --test test/<file>.test.js`. Every task's test run must end with a `pass`/`fail` summary line — do not pipe through grep/tail in a way that can mask a failure.
- Match the codebase's comment style: comments explain constraints and product decisions, not what the next line does.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/db.js` | modify | `push_prefs` column migration + `parsePushPrefs`/`setPushPrefs`; include `push_prefs` in `clientDevicesForPush` and `listDevices` |
| `src/push.js` | modify | `classify()` gains `kind`; `category` threaded into send opts; prefs enforcement in the device loop |
| `src/gateway.js` | create | `makeGatewayClient({url, fetchImpl})` — relay wire client, `makeApnsClient` contract |
| `src/server.js` | modify | `resolveApnsClient` three-way selection: direct APNs → gateway → disabled |
| `src/relay.js` | create | `makeRelayHandler` + `startRelay` + token-bucket limiter |
| `bin/matron-push-relay.js` | create | Relay entry point (env config, process wiring) |
| `src/http.js` | modify | `PUT /push/prefs`; echo prefs from `POST /push/register` |
| `test/apns-helpers.js` | create | `makeTestKey` + `makeFakeApnsServer` extracted from `test/apns.test.js` for reuse |
| `test/db.test.js`, `test/push.test.js`, `test/http.test.js` | modify | New coverage per task |
| `test/gateway.test.js`, `test/relay.test.js`, `test/server-push-selection.test.js` | create | New coverage per task |
| `README.md`, `package.json` | modify | Env-var table rows, relay bin entry |

---

### Task 1: `push_prefs` column + prefs helpers in db.js

**Files:**
- Modify: `src/db.js`
- Test: `test/db.test.js`

**Interfaces:**
- Produces: `parsePushPrefs(text) → {attention, done, activity}` (booleans, all-on for NULL/garbage); `setPushPrefs(db, deviceId, partial) → merged prefs object`; `clientDevicesForPush` rows gain a `push_prefs` column (raw TEXT or null); `listDevices` rows gain `push_prefs` (parsed object).

- [ ] **Step 1: Write the failing tests**

Append to `test/db.test.js`:

```js
test('push_prefs: NULL and garbage parse as all-on; setPushPrefs merges partial updates', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const dev = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','phone','h1',?)")
    .run(dan.id, Date.now())
  const deviceId = dev.lastInsertRowid

  // Column exists (migration ran) and NULL = all-on.
  assert.deepEqual(parsePushPrefs(null), { attention: true, done: true, activity: true })
  // Garbage stored by a buggy/older writer must fail open, not throw.
  assert.deepEqual(parsePushPrefs('not json'), { attention: true, done: true, activity: true })
  assert.deepEqual(parsePushPrefs('[1,2]'), { attention: true, done: true, activity: true })

  // Partial update merges over the current state and returns the full shape.
  const merged1 = setPushPrefs(db, deviceId, { activity: false })
  assert.deepEqual(merged1, { attention: true, done: true, activity: false })
  const merged2 = setPushPrefs(db, deviceId, { done: false })
  assert.deepEqual(merged2, { attention: true, done: false, activity: false })

  // The stored row round-trips through parsePushPrefs.
  const row = db.prepare('SELECT push_prefs FROM devices WHERE id=?').get(deviceId)
  assert.deepEqual(parsePushPrefs(row.push_prefs), { attention: true, done: false, activity: false })
})

test('clientDevicesForPush and listDevices expose push_prefs', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const dev = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','phone','h2',?)")
    .run(dan.id, Date.now())
  const deviceId = dev.lastInsertRowid
  setApnsRegistration(db, deviceId, { apnsToken: 'tok', apnsEnv: 'prod' })
  setPushPrefs(db, deviceId, { attention: false })

  const pushRows = clientDevicesForPush(db, dan.id)
  assert.equal(pushRows.length, 1)
  assert.deepEqual(parsePushPrefs(pushRows[0].push_prefs), { attention: false, done: true, activity: true })

  const roster = listDevices(db, dan.id)
  assert.deepEqual(roster[0].push_prefs, { attention: false, done: true, activity: true })
})
```

Extend the import line at the top of `test/db.test.js` to include the new names (keep whatever it already imports):

```js
import { openDb, setApnsRegistration, clientDevicesForPush, listDevices, parsePushPrefs, setPushPrefs } from '../src/db.js'
```

If `createUser` is not already imported there, add `import { createUser } from '../src/auth.js'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/db.test.js`
Expected: FAIL — `parsePushPrefs` is not exported.

- [ ] **Step 3: Implement**

In `src/db.js`, inside `openDb`, right after the existing `apns_env` migration block (after line 83), add:

```js
  // Per-device notification prefs (spec: push relay + notification settings).
  // JSON {"attention":bool,"done":bool,"activity":bool}; NULL (every device
  // predating this column) means all-on. Same in-place ALTER pattern as
  // apns_env above.
  if (!deviceCols.some((c) => c.name === 'push_prefs')) {
    db.exec('ALTER TABLE devices ADD COLUMN push_prefs TEXT')
  }
```

Change `clientDevicesForPush` to select the new column:

```js
export function clientDevicesForPush(db, userId) {
  return db.prepare(
    "SELECT id, apns_token, apns_env, cursor, push_prefs FROM devices WHERE user_id=? AND kind='client' AND apns_token IS NOT NULL"
  ).all(userId)
}
```

Change `listDevices` to select and parse it:

```js
export function listDevices(db, userId) {
  const head = db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(userId)
  const headSeq = head ? head.seq : 0
  return db.prepare(
    'SELECT id AS device_id, kind, name, created_at, cursor, last_seen_at, push_prefs FROM devices WHERE user_id=? ORDER BY id'
  ).all(userId).map((d) => ({ ...d, lag: headSeq - d.cursor, push_prefs: parsePushPrefs(d.push_prefs) }))
}
```

Add the two helpers next to `setApnsRegistration`:

```js
// Notification prefs, per device (that's where the APNs token lives too).
// NULL / unparseable / non-object all mean "all on" — prefs must fail open:
// a corrupt row silencing every push would be far worse than a spurious one.
export function parsePushPrefs(text) {
  const prefs = { attention: true, done: true, activity: true }
  if (!text) return prefs
  let parsed
  try { parsed = JSON.parse(text) } catch { return prefs }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return prefs
  for (const k of Object.keys(prefs)) {
    if (parsed[k] === false) prefs[k] = false
  }
  return prefs
}

// Partial update: only boolean fields in `partial` override the stored
// state; everything else keeps its current value. Always writes the full
// three-key shape so a stored row never depends on merge-at-read.
export function setPushPrefs(db, deviceId, partial) {
  const row = db.prepare('SELECT push_prefs FROM devices WHERE id=?').get(deviceId)
  const merged = parsePushPrefs(row ? row.push_prefs : null)
  for (const k of Object.keys(merged)) {
    if (typeof partial[k] === 'boolean') merged[k] = partial[k]
  }
  db.prepare('UPDATE devices SET push_prefs=? WHERE id=?').run(JSON.stringify(merged), deviceId)
  return merged
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/db.test.js`
Expected: PASS, including all pre-existing db tests.

- [ ] **Step 5: Full suite, then commit**

Run: `npm test`
Expected: PASS (listDevices gained a field — devices.test.js/http.test.js must not have broken; if a test asserts an exact device-row shape, update it to include `push_prefs: { attention: true, done: true, activity: true }`).

```bash
git add src/db.js test/db.test.js
git commit -m "feat(db): per-device push_prefs column + fail-open prefs helpers"
```

---

### Task 2: Thread `category` through the push pipeline

**Files:**
- Modify: `src/push.js`
- Test: `test/push.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: every `apnsClient.send(opts)` call now includes `category: 'attention' | 'done' | 'activity' | 'wake'`. `classify()` returns `{priority, coalesce, kind}`. The direct APNs client ignores the extra field (its `send` destructures only the fields it knows).

- [ ] **Step 1: Write the failing test**

Append to `test/push.test.js`:

```js
test('category threading: classify kind reaches apnsClient.send as opts.category', async (t) => {
  const { db, dan, stub, pipeline } = await setup(t, { coalesceMs: 50 })
  const deviceId = registerDevice(db, dan.id, 'phone')

  const send = (type, payload, sender = 'agent:a') => {
    const r = append(db, { userId: dan.id, convoId: 'c1', sender, type, payload })
    pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender, type, payload }, null)
    return r
  }

  send('prompt', { question: 'go?' })                 // attention
  send('permission_request', { description: 'write' }) // attention
  send('session_status', { state: 'done' })            // done
  send('text', { body: 'hi' })                          // activity (leading send)
  await new Promise((res) => setImmediate(res))
  assert.deepEqual(stub.calls.map((c) => c.category), ['attention', 'attention', 'done', 'activity'])

  // read_marker background push carries category 'wake'. It must come from a
  // DIFFERENT device so origin-device exclusion doesn't eat it.
  const other = registerDevice(db, dan.id, 'ipad')
  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'user:dan', type: 'read_marker', payload: { convo_id: 'c1', up_to_seq: 1 } })
  pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'user:dan', type: 'read_marker', payload: { convo_id: 'c1', up_to_seq: 1 } }, other)
  await new Promise((res) => setImmediate(res))
  const wake = stub.calls[stub.calls.length - 1]
  assert.equal(wake.category, 'wake')
  assert.equal(wake.pushType, 'background')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/push.test.js`
Expected: FAIL — `c.category` is `undefined`.

- [ ] **Step 3: Implement**

In `src/push.js`, change `classify()`'s three non-null returns to carry `kind` (the doc comment above it stays):

```js
  if (typeof sender === 'string' && sender.startsWith('user:')) return null
  if (type === 'prompt' || type === 'permission_request') return { priority: 10, coalesce: false, kind: 'attention' }
  if (type === 'session_status') {
    return payload && payload.state === 'done' ? { priority: 10, coalesce: false, kind: 'done' } : null
  }
  if (type === 'convo_meta') return null
  // Routine content: text/tool_output/diff/prompt_reply/file/image/etc. —
  // batched so a busy session is one updating notification, not hundreds.
  return { priority: 5, coalesce: true, kind: 'activity' }
```

In `onAppend`, add `category: 'wake'` to the read_marker send:

```js
        doSend(device, userId, {
          payload: { aps: { 'content-available': 1 } },
          priority: 5,
          pushType: 'background',
          category: 'wake',
        })
```

And add `category: cls.kind` to `buildOpts`:

```js
      const buildOpts = () => ({
        payload: { aps: { alert: { title, body }, 'thread-id': event.convo_id } },
        priority: cls.priority,
        pushType: 'alert',
        collapseId: event.convo_id,
        category: cls.kind,
      })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/push.test.js`
Expected: PASS (all pre-existing push tests too — `category` is additive; the stub records whole opts objects, and `makeApnsClient.send` destructures only known fields, so nothing else notices).

- [ ] **Step 5: Commit**

```bash
git add src/push.js test/push.test.js
git commit -m "feat(push): thread event category (attention/done/activity/wake) into send opts"
```

---

### Task 3: Enforce push_prefs in the device loop

**Files:**
- Modify: `src/push.js`
- Test: `test/push.test.js`

**Interfaces:**
- Consumes: `parsePushPrefs` from `src/db.js` (Task 1), `cls.kind` (Task 2), `device.push_prefs` on `clientDevicesForPush` rows (Task 1).
- Produces: a device whose prefs disable the event's category is skipped for alert pushes; `wake` is never filtered.

- [ ] **Step 1: Write the failing test**

Append to `test/push.test.js`:

```js
test('push_prefs: a disabled category skips that device only; wake is never filtered', async (t) => {
  const { db, dan, stub, pipeline } = await setup(t, { coalesceMs: 50 })
  const muted = registerDevice(db, dan.id, 'phone')
  const open = registerDevice(db, dan.id, 'ipad', { token: 'ipad-token' })
  setPushPrefs(db, muted, { attention: false, activity: false })

  const fire = (type, payload, sender = 'agent:a', origin = null) => {
    const r = append(db, { userId: dan.id, convoId: 'c1', sender, type, payload })
    pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender, type, payload }, origin)
  }

  // attention off on `muted`: only `open` gets the prompt push.
  fire('prompt', { question: 'go?' })
  await new Promise((res) => setImmediate(res))
  assert.deepEqual(stub.calls.map((c) => c.deviceToken), ['ipad-token'])

  // done still on for both.
  fire('session_status', { state: 'done' })
  await new Promise((res) => setImmediate(res))
  assert.equal(stub.calls.length, 3)

  // activity off on `muted`: routine event reaches only `open`.
  fire('text', { body: 'hi' })
  await new Promise((res) => setImmediate(res))
  assert.equal(stub.calls.length, 4)
  assert.equal(stub.calls[3].deviceToken, 'ipad-token')

  // wake (read_marker from `open`) still reaches `muted` despite its prefs —
  // badge sync is invisible to the user and never filtered.
  fire('read_marker', { convo_id: 'c1', up_to_seq: 1 }, 'user:dan', open)
  await new Promise((res) => setImmediate(res))
  const wakes = stub.calls.filter((c) => c.category === 'wake')
  assert.equal(wakes.length, 1)
  assert.equal(wakes[0].deviceToken, 'phone-token')
})
```

Extend the db.js import in `test/push.test.js`:

```js
import { openDb, setApnsRegistration, setPushPrefs } from '../src/db.js'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/push.test.js`
Expected: FAIL — the muted phone still receives the prompt push (2 calls where 1 expected).

- [ ] **Step 3: Implement**

In `src/push.js`, extend the db.js import:

```js
import { clientDevicesForPush, parsePushPrefs, pruneApnsToken, unreadBadge } from './db.js'
```

In the alert-path device loop in `onAppend`, add a prefs check after the origin/env guards (the read_marker branch above it stays untouched — wake is never filtered):

```js
      if (device.id === originDeviceId) continue
      if (!device.apns_env) continue
      // Per-device notification prefs: skip the device when its prefs
      // disable this event's category. Deliberately BEFORE the
      // isViewing/cursor checks (cheapest first) and only on the alert path —
      // read_marker wakes above are invisible to the user and never filtered.
      if (!parsePushPrefs(device.push_prefs)[cls.kind]) continue
      if (hub.isViewing(userId, device.id, event.convo_id)) continue
      if (device.cursor >= event.seq) continue
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/push.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/push.js test/push.test.js
git commit -m "feat(push): enforce per-device push_prefs in the alert device loop"
```

---

### Task 4: Gateway client (`src/gateway.js`)

**Files:**
- Create: `src/gateway.js`
- Test: `test/gateway.test.js`

**Interfaces:**
- Consumes: send opts produced by `push.js` (`{deviceToken, env, payload, collapseId, priority, pushType, category}`).
- Produces: `makeGatewayClient({url, fetchImpl = fetch, requestTimeoutMs = 30000}) → {send, close}` with the exact `makeApnsClient` contract. Wire body fields: `device_token, env, category, priority, push_type` always; `badge, thread_id, collapse_id` when present. **Never** a title/body/alert.

- [ ] **Step 1: Write the failing tests**

Create `test/gateway.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeGatewayClient } from '../src/gateway.js'

// fetch stub recording every request; `respond` maps a call to a Response.
function makeFetchStub(respond = () => new Response(JSON.stringify({ status: 200, reason: null }), { status: 200 })) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), init })
    return respond()
  }
  return { calls, fetchImpl }
}

const ALERT_OPTS = {
  deviceToken: 'a'.repeat(64),
  env: 'prod',
  payload: { aps: { alert: { title: 'SECRET TITLE', body: 'SECRET BODY' }, 'thread-id': 'convo-1', badge: 3 } },
  collapseId: 'convo-1',
  priority: 10,
  pushType: 'alert',
  category: 'attention',
}

test('serializes only content-free fields — the alert text never crosses the wire', async () => {
  const { calls, fetchImpl } = makeFetchStub()
  const client = makeGatewayClient({ url: 'https://push.matron.chat', fetchImpl })

  const result = await client.send(ALERT_OPTS)
  assert.deepEqual(result, { status: 200, reason: null })
  assert.equal(calls[0].url, 'https://push.matron.chat/push')
  assert.deepEqual(calls[0].body, {
    device_token: 'a'.repeat(64),
    env: 'prod',
    category: 'attention',
    priority: 10,
    push_type: 'alert',
    badge: 3,
    thread_id: 'convo-1',
    collapse_id: 'convo-1',
  })
  // Belt and braces: no value anywhere in the body contains the alert text.
  assert.ok(!JSON.stringify(calls[0].body).includes('SECRET'))
})

test('background wake serializes without alert-only fields', async () => {
  const { calls, fetchImpl } = makeFetchStub()
  const client = makeGatewayClient({ url: 'https://push.matron.chat', fetchImpl })
  await client.send({
    deviceToken: 'b'.repeat(64), env: 'sandbox',
    payload: { aps: { 'content-available': 1, badge: 0 } },
    priority: 5, pushType: 'background', category: 'wake',
  })
  assert.deepEqual(calls[0].body, {
    device_token: 'b'.repeat(64), env: 'sandbox', category: 'wake',
    priority: 5, push_type: 'background', badge: 0,
  })
})

test('mirrors the relay {status, reason} — a 410 reaches the caller for token pruning', async () => {
  const { fetchImpl } = makeFetchStub(() =>
    new Response(JSON.stringify({ status: 410, reason: 'Unregistered' }), { status: 410 }))
  const client = makeGatewayClient({ url: 'https://push.matron.chat', fetchImpl })
  const result = await client.send(ALERT_OPTS)
  assert.equal(result.status, 410)
  assert.equal(result.reason, 'Unregistered')
})

test('a fetch that rejects resolves {status: 0, reason: "transport"} — never rejects', async () => {
  const client = makeGatewayClient({
    url: 'https://push.matron.chat',
    fetchImpl: async () => { throw new TypeError('fetch failed') },
  })
  const result = await client.send(ALERT_OPTS)
  assert.deepEqual(result, { status: 0, reason: 'transport' })
})

test('a fetch aborted by the timeout resolves {status: 0, reason: "timeout"}', async () => {
  const client = makeGatewayClient({
    url: 'https://push.matron.chat',
    requestTimeoutMs: 20,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason))
    }),
  })
  const result = await client.send(ALERT_OPTS)
  assert.deepEqual(result, { status: 0, reason: 'timeout' })
})

test('a non-JSON response body still resolves with the HTTP status and reason null', async () => {
  const { fetchImpl } = makeFetchStub(() => new Response('<html>cloudflare error</html>', { status: 502 }))
  const client = makeGatewayClient({ url: 'https://push.matron.chat', fetchImpl })
  const result = await client.send(ALERT_OPTS)
  assert.deepEqual(result, { status: 502, reason: null })
})

test('close() is a no-op that does not throw', () => {
  const client = makeGatewayClient({ url: 'https://push.matron.chat' })
  assert.doesNotThrow(() => client.close())
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/gateway.test.js`
Expected: FAIL — cannot find module `../src/gateway.js`.

- [ ] **Step 3: Implement**

Create `src/gateway.js`:

```js
// Gateway client for self-hosted journals: speaks the push.matron.chat relay
// protocol instead of APNs directly. Exact makeApnsClient contract —
// send(opts) resolves {status, reason} and NEVER rejects; transport failure
// resolves {status: 0, reason: 'transport'}, timeout {status: 0, reason:
// 'timeout'} — so makePushPipeline (and its 410-prune / 400-env-mismatch
// handleResult logic) works against a relay unchanged.
//
// Privacy is structural: only the content-free fields below are ever
// serialized. The full payload.aps.alert built by push.js stays in-process
// and is dropped here — a title, body, or conversation name has no field it
// could travel in.
export function makeGatewayClient({ url, fetchImpl = fetch, requestTimeoutMs = 30000 }) {
  const endpoint = new URL('/push', url).toString()

  async function send({ deviceToken, env, payload, collapseId, priority, pushType, category }) {
    const aps = (payload && payload.aps) || {}
    const body = {
      device_token: deviceToken,
      env,
      // push.js always sets category (Task 2); the fallback keeps a stale
      // caller safe rather than sending an unclassifiable request.
      category: category || (pushType === 'background' ? 'wake' : 'activity'),
      priority,
      push_type: pushType,
    }
    if (typeof aps.badge === 'number') body.badge = aps.badge
    if (typeof aps['thread-id'] === 'string') body.thread_id = aps['thread-id']
    if (collapseId) body.collapse_id = collapseId

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
    if (timer.unref) timer.unref()
    let res
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch {
      return { status: 0, reason: controller.signal.aborted ? 'timeout' : 'transport' }
    } finally {
      clearTimeout(timer)
    }
    let reason = null
    try {
      const parsed = await res.json()
      if (parsed && typeof parsed.reason === 'string') reason = parsed.reason
    } catch { /* non-JSON body (proxy error page): status alone is enough */ }
    return { status: res.status, reason }
  }

  // Nothing to tear down — fetch owns its connections — but the pipeline
  // calls close() on shutdown, so honor the contract.
  function close() {}

  return { send, close }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/gateway.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/gateway.js test/gateway.test.js
git commit -m "feat(gateway): content-free relay client with the makeApnsClient contract"
```

---

### Task 5: Client selection order in server.js

**Files:**
- Modify: `src/server.js` (the `resolveApnsClient` function, currently lines 157–172)
- Test: `test/server-push-selection.test.js` (create)

**Interfaces:**
- Consumes: `makeGatewayClient` from Task 4.
- Produces: `resolveApnsClient(injected)` exported (for tests); selection order: injected → all four `MATRON_APNS_*` → `MATRON_PUSH_GATEWAY_URL` → disabled.

- [ ] **Step 1: Write the failing tests**

Create `test/server-push-selection.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveApnsClient } from '../src/server.js'

const APNS_VARS = ['MATRON_APNS_KEY_FILE', 'MATRON_APNS_KEY_ID', 'MATRON_APNS_TEAM_ID', 'MATRON_APNS_TOPIC', 'MATRON_PUSH_GATEWAY_URL']

// Every test rewrites push-related env; snapshot and restore around each so
// test order (and the developer's own shell env) can't leak in.
function withEnv(t, vars) {
  const saved = {}
  for (const k of APNS_VARS) { saved[k] = process.env[k]; delete process.env[k] }
  Object.assign(process.env, vars)
  t.after(() => {
    for (const k of APNS_VARS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })
}

function writeTestKey() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-key-'))
  const keyFile = path.join(dir, 'AuthKey_TEST.p8')
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  return keyFile
}

test('no push env at all → disabled (undefined client)', (t) => {
  withEnv(t, {})
  const { client, owned } = resolveApnsClient(undefined)
  assert.equal(client, undefined)
  assert.equal(owned, false)
})

test('an injected client always wins', (t) => {
  withEnv(t, { MATRON_PUSH_GATEWAY_URL: 'https://push.matron.chat' })
  const sentinel = { send: async () => ({ status: 200, reason: null }), close: () => {} }
  const { client, owned } = resolveApnsClient(sentinel)
  assert.equal(client, sentinel)
  assert.equal(owned, false)
})

test('MATRON_PUSH_GATEWAY_URL alone → gateway client that POSTs /push to that URL', async (t) => {
  const hits = []
  const relay = http.createServer((req, res) => {
    hits.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 200, reason: null }))
  })
  await new Promise((res) => relay.listen(0, '127.0.0.1', res))
  t.after(() => relay.close())

  withEnv(t, { MATRON_PUSH_GATEWAY_URL: `http://127.0.0.1:${relay.address().port}` })
  const { client, owned } = resolveApnsClient(undefined)
  assert.equal(owned, true)
  t.after(() => client.close())
  const result = await client.send({
    deviceToken: 'a'.repeat(64), env: 'prod',
    payload: { aps: { alert: { title: 't', body: 'b' } } },
    priority: 10, pushType: 'alert', category: 'attention',
  })
  assert.equal(result.status, 200)
  assert.deepEqual(hits, ['/push'])
})

test('all four MATRON_APNS_* set beats the gateway URL (direct APNs wins)', async (t) => {
  // If the gateway were (wrongly) selected, it would POST here — it must not.
  const hits = []
  const relay = http.createServer((req, res) => { hits.push(req.url); res.end('{}') })
  await new Promise((res) => relay.listen(0, '127.0.0.1', res))
  t.after(() => relay.close())

  withEnv(t, {
    MATRON_APNS_KEY_FILE: writeTestKey(),
    MATRON_APNS_KEY_ID: 'KID',
    MATRON_APNS_TEAM_ID: 'TEAM',
    MATRON_APNS_TOPIC: 'chat.matron.app',
    MATRON_PUSH_GATEWAY_URL: `http://127.0.0.1:${relay.address().port}`,
  })
  const { client, owned } = resolveApnsClient(undefined)
  assert.equal(owned, true)
  t.after(() => client.close())
  // Direct client with an unreachable connect target: resolves a transport
  // failure (never rejects) — and, decisively, never touched the relay.
  const result = await client.send({
    deviceToken: 'a'.repeat(64), env: 'prod', payload: {}, priority: 5, pushType: 'alert',
  })
  assert.ok(result.status === 0 || result.status >= 400)
  assert.deepEqual(hits, [])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/server-push-selection.test.js`
Expected: FAIL — `resolveApnsClient` is not exported from `../src/server.js`.

Note on the "direct APNs wins" test: `client.send` will try to reach the real APNs host and fail as transport/timeout — the assertion tolerates any failure status; the real check is `hits` staying empty. If the send hangs near the 30s default timeout, pass `requestTimeoutMs` is not injectable through `resolveApnsClient`, so instead drop the `client.send` call entirely and keep only the `hits` assertion after a `setImmediate` tick — selection (not transport) is what this test pins.

- [ ] **Step 3: Implement**

In `src/server.js`, add the import at the top next to `makeApnsClient`:

```js
import { makeGatewayClient } from './gateway.js'
```

Replace `resolveApnsClient` (keep its position; add `export`):

```js
// Push client selection, in strict priority order:
//   1. injected (tests) — caller owns its lifecycle.
//   2. all four MATRON_APNS_* set → direct APNs (Dan's journal: full-content
//      alerts, exactly the pre-relay behavior).
//   3. MATRON_PUSH_GATEWAY_URL set → the push.matron.chat relay (self-hosted
//      journals with no APNs key; generic alert text, content never leaves
//      the box — see src/gateway.js).
//   4. neither → push disabled, one warn log at boot, pipeline is inert.
// Exported for the selection-order tests only.
export function resolveApnsClient(injected) {
  if (injected) return { client: injected, owned: false }
  const { MATRON_APNS_KEY_FILE, MATRON_APNS_KEY_ID, MATRON_APNS_TEAM_ID, MATRON_APNS_TOPIC, MATRON_PUSH_GATEWAY_URL } = process.env
  if (MATRON_APNS_KEY_FILE && MATRON_APNS_KEY_ID && MATRON_APNS_TEAM_ID && MATRON_APNS_TOPIC) {
    const client = makeApnsClient({
      keyFile: MATRON_APNS_KEY_FILE, keyId: MATRON_APNS_KEY_ID,
      teamId: MATRON_APNS_TEAM_ID, topic: MATRON_APNS_TOPIC,
    })
    return { client, owned: true }
  }
  if (MATRON_PUSH_GATEWAY_URL) {
    return { client: makeGatewayClient({ url: MATRON_PUSH_GATEWAY_URL }), owned: true }
  }
  console.warn('push: disabled — set all four MATRON_APNS_* vars (direct APNs) or MATRON_PUSH_GATEWAY_URL (relay) to enable')
  return { client: undefined, owned: false }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/server-push-selection.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Full suite, then commit**

Run: `npm test`
Expected: PASS. (Watch for pre-existing server tests that grep the old warn text `apns: MATRON_APNS_KEY_FILE/...` — if one asserts on it, update it to the new `push: disabled` message.)

```bash
git add src/server.js test/server-push-selection.test.js
git commit -m "feat(server): three-way push client selection — direct APNs, relay gateway, disabled"
```

---

### Task 6: Relay service (`src/relay.js`)

**Files:**
- Create: `src/relay.js`
- Create: `test/apns-helpers.js` (extract `makeTestKey` + `makeFakeApnsServer` from `test/apns.test.js`)
- Modify: `test/apns.test.js` (import the extracted helpers instead of defining them)
- Test: `test/relay.test.js`

**Interfaces:**
- Consumes: an `apnsClient` with the `makeApnsClient` contract (injected; the bin wires a real one).
- Produces: `makeRelayHandler({apnsClient, limiter}) → (req, res) handler`; `makeRelayLimiter({burst = 20, refillMs = 60000, now = Date.now}) → {allow(token) → bool}`; `startRelay({apnsClient, port = 0, bind = '127.0.0.1', limiter}) → Promise<{port, server, close}>`.
- Wire protocol (spec §Component 1): `POST /push`, required `device_token` (hex 16–200 chars), `env` (`prod`|`sandbox`), `category` (`attention`|`done`|`activity`|`wake`), `priority` (5 or 10), `push_type` (`alert`|`background`, must match category: wake ↔ background, others ↔ alert); optional `badge` (integer ≥ 0), `thread_id`, `collapse_id` (non-empty strings ≤ 200 chars). Unknown fields → 400. Body > 1024 bytes → 413. Response body always `{status, reason}` with HTTP status = APNs status; APNs `{status: 0}` (transport/timeout to Apple) maps to HTTP 502 with body `{status: 0, reason}`.

- [ ] **Step 1: Extract the fake-APNs test helpers**

Create `test/apns-helpers.js` by moving `makeTestKey` (test/apns.test.js lines 13–21) and `makeFakeApnsServer` (lines 24–43) verbatim, with their comments, adding `export` to both, plus the imports they need:

```js
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http2 from 'node:http2'
```

In `test/apns.test.js`, delete the two moved functions and their now-unused imports (`os`, `path` — keep `crypto`, `fs`? check: `fs` is no longer used either once `makeTestKey` moves; `crypto` is still used by `base64urlDecode` verification), and add:

```js
import { makeTestKey, makeFakeApnsServer } from './apns-helpers.js'
```

Run: `node --test test/apns.test.js`
Expected: PASS — pure refactor, all 9 existing tests green.

```bash
git add test/apns-helpers.js test/apns.test.js
git commit -m "test: extract fake-APNs helpers for reuse by the relay tests"
```

- [ ] **Step 2: Write the failing tests**

Create `test/relay.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import http2 from 'node:http2'
import { startRelay, makeRelayLimiter } from '../src/relay.js'
import { makeApnsClient } from '../src/apns.js'
import { makeTestKey, makeFakeApnsServer } from './apns-helpers.js'

// Stub APNs client (push.test.js pattern): records calls, configurable result.
function makeStubApnsClient(respond = () => ({ status: 200, reason: null })) {
  const calls = []
  return { calls, send: async (opts) => { calls.push(opts); return respond(opts) }, close() {} }
}

async function startTestRelay(t, { apnsClient = makeStubApnsClient(), limiter } = {}) {
  const relay = await startRelay({ apnsClient, port: 0, limiter })
  t.after(() => relay.close())
  const post = async (body, { raw = null } = {}) => {
    const r = await fetch(`http://127.0.0.1:${relay.port}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw !== null ? raw : JSON.stringify(body),
    })
    let j = null
    try { j = await r.json() } catch { /* empty */ }
    return { status: r.status, json: j }
  }
  return { relay, post, stub: apnsClient }
}

const GOOD = {
  device_token: 'ab'.repeat(32),
  env: 'prod',
  category: 'attention',
  badge: 3,
  thread_id: 'convo-1',
  collapse_id: 'convo-1',
  priority: 10,
  push_type: 'alert',
}

test('category → fixed-string payload table, with mutable-content on every alert', async (t) => {
  const { post, stub } = await startTestRelay(t)

  await post(GOOD)
  await post({ ...GOOD, category: 'done' })
  await post({ ...GOOD, category: 'activity' })
  await post({ device_token: GOOD.device_token, env: 'prod', category: 'wake', priority: 5, push_type: 'background', badge: 0 })

  const [attention, done, activity, wake] = stub.calls
  assert.deepEqual(attention.payload.aps.alert, { title: 'Matron', body: 'Your agent needs you' })
  assert.deepEqual(done.payload.aps.alert, { title: 'Matron', body: 'Session finished' })
  assert.deepEqual(activity.payload.aps.alert, { title: 'Matron', body: 'New activity from your agent' })
  for (const call of [attention, done, activity]) {
    assert.equal(call.payload.aps['mutable-content'], 1)
    assert.equal(call.payload.aps['thread-id'], 'convo-1')
    assert.equal(call.payload.aps.badge, 3)
    assert.equal(call.pushType, 'alert')
    assert.equal(call.collapseId, 'convo-1')
  }
  assert.deepEqual(wake.payload.aps, { 'content-available': 1, badge: 0 })
  assert.equal(wake.pushType, 'background')
  assert.equal(wake.deviceToken, GOOD.device_token)
  assert.equal(wake.env, 'prod')
})

test('optional fields really are optional', async (t) => {
  const { post, stub } = await startTestRelay(t)
  const { status } = await post({ device_token: 'cd'.repeat(32), env: 'sandbox', category: 'done', priority: 10, push_type: 'alert' })
  assert.equal(status, 200)
  assert.equal(stub.calls[0].payload.aps.badge, undefined)
  assert.equal(stub.calls[0].payload.aps['thread-id'], undefined)
  assert.equal(stub.calls[0].collapseId, undefined)
})

test('validation 400s: unknown field, bad enum values, category/push_type mismatch, missing required', async (t) => {
  const { post, stub } = await startTestRelay(t)
  const bad = [
    { ...GOOD, title: 'sneaky content' },                 // unknown field — the privacy guarantee
    { ...GOOD, body: 'sneaky content' },                  // unknown field
    { ...GOOD, env: 'production' },                        // bad enum
    { ...GOOD, category: 'urgent' },                       // bad enum
    { ...GOOD, priority: 7 },                              // bad enum
    { ...GOOD, push_type: 'voip' },                        // bad enum
    { ...GOOD, category: 'wake' },                          // wake must be background
    { ...GOOD, push_type: 'background' },                   // attention must be alert
    { ...GOOD, device_token: 'not-hex!' },                  // token shape
    { ...GOOD, badge: -1 },                                 // bad badge
    { ...GOOD, badge: 1.5 },                                // bad badge
    { ...GOOD, thread_id: '' },                             // empty string
    (({ device_token, ...rest }) => rest)(GOOD),            // missing required
  ]
  for (const body of bad) {
    const r = await post(body)
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body).slice(0, 80)}`)
  }
  const nonObject = await post(null, { raw: '[1,2,3]' })
  assert.equal(nonObject.status, 400)
  const notJson = await post(null, { raw: 'not json' })
  assert.equal(notJson.status, 400)
  assert.equal(stub.calls.length, 0, 'nothing invalid may reach APNs')
})

test('body over 1 KB → 413 without touching APNs', async (t) => {
  const { post, stub } = await startTestRelay(t)
  const r = await post(null, { raw: JSON.stringify({ ...GOOD, thread_id: 'x'.repeat(2000) }) })
  assert.equal(r.status, 413)
  assert.equal(stub.calls.length, 0)
})

test('non-POST-/push routes 404', async (t) => {
  const { relay } = await startTestRelay(t)
  const g = await fetch(`http://127.0.0.1:${relay.port}/push`)
  assert.equal(g.status, 404)
  const p = await fetch(`http://127.0.0.1:${relay.port}/`, { method: 'POST', body: '{}' })
  assert.equal(p.status, 404)
})

test('APNs status passthrough: 410 body/status reach the caller for pruning; APNs transport failure → 502', async (t) => {
  const dead = makeStubApnsClient(() => ({ status: 410, reason: 'Unregistered' }))
  const { post } = await startTestRelay(t, { apnsClient: dead })
  const r = await post(GOOD)
  assert.equal(r.status, 410)
  assert.deepEqual(r.json, { status: 410, reason: 'Unregistered' })

  const down = makeStubApnsClient(() => ({ status: 0, reason: 'transport' }))
  const { post: post2 } = await startTestRelay(t, { apnsClient: down })
  const r2 = await post2(GOOD)
  assert.equal(r2.status, 502)
  assert.deepEqual(r2.json, { status: 0, reason: 'transport' })
})

test('rate limit: burst then 429 per token, independent tokens unaffected, refill restores', async (t) => {
  let clock = 0
  const limiter = makeRelayLimiter({ burst: 3, refillMs: 60000, now: () => clock })
  const { post, stub } = await startTestRelay(t, { limiter })

  for (let i = 0; i < 3; i++) assert.equal((await post(GOOD)).status, 200)
  const limited = await post(GOOD)
  assert.equal(limited.status, 429)
  assert.equal(stub.calls.length, 3, 'a rate-limited request must not reach APNs')

  // A different device token has its own bucket.
  assert.equal((await post({ ...GOOD, device_token: 'ef'.repeat(32) })).status, 200)

  // One refill interval restores exactly one send.
  clock += 60000
  assert.equal((await post(GOOD)).status, 200)
  assert.equal((await post(GOOD)).status, 429)
})

test('end-to-end against the fake APNs h2 server: real makeApnsClient, real wire payload', async (t) => {
  const { keyFile } = makeTestKey()
  const { server, port, requests } = await makeFakeApnsServer(() => ({ status: 200 }))
  t.after(() => server.close())
  const apnsClient = makeApnsClient({
    keyFile, keyId: 'KID', teamId: 'TEAM', topic: 'chat.matron.app',
    connect: () => http2.connect(`http://127.0.0.1:${port}`),
  })
  t.after(() => apnsClient.close())
  const { post } = await startTestRelay(t, { apnsClient })

  const r = await post(GOOD)
  assert.equal(r.status, 200)
  assert.equal(requests[0].headers[':path'], `/3/device/${GOOD.device_token}`)
  assert.equal(requests[0].headers['apns-collapse-id'], 'convo-1')
  assert.equal(requests[0].headers['apns-priority'], '10')
  assert.equal(requests[0].headers['apns-push-type'], 'alert')
  assert.deepEqual(requests[0].payload.aps.alert, { title: 'Matron', body: 'Your agent needs you' })
  assert.equal(requests[0].payload.aps['mutable-content'], 1)
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/relay.test.js`
Expected: FAIL — cannot find module `../src/relay.js`.

- [ ] **Step 4: Implement**

Create `src/relay.js`:

```js
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

// Per-device-token token bucket: burst 20, refill 1/min. Journal-side
// coalescing keeps legitimate traffic far below this. Buckets live in
// memory only (the relay is stateless by design); a full-capacity bucket is
// indistinguishable from an absent one, so those are evicted on sweep and
// the map stays bounded by the number of RECENTLY throttled tokens.
export function makeRelayLimiter({ burst = 20, refillMs = 60000, now = Date.now } = {}) {
  const buckets = new Map()

  function allow(token) {
    const t = now()
    let b = buckets.get(token)
    if (!b) {
      b = { tokens: burst, at: t }
      buckets.set(token, b)
    } else {
      const refilled = Math.floor((t - b.at) / refillMs)
      if (refilled > 0) {
        b.tokens = Math.min(burst, b.tokens + refilled)
        b.at = b.tokens === burst ? t : b.at + refilled * refillMs
      }
    }
    if (b.tokens <= 0) return false
    b.tokens -= 1
    return true
  }

  function sweep() {
    const t = now()
    for (const [token, b] of buckets) {
      const refilled = Math.floor((t - b.at) / refillMs)
      if (b.tokens + refilled >= burst) buckets.delete(token)
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/relay.test.js`
Expected: PASS (8 tests).

- [ ] **Step 6: Full suite, then commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/relay.js test/relay.test.js
git commit -m "feat(relay): content-blind push relay — fixed-string payloads, strict validation, per-token rate limit"
```

---

### Task 7: Relay entry point + config docs

**Files:**
- Create: `bin/matron-push-relay.js`
- Modify: `package.json` (bin map), `README.md` (env table + relay section)

**Interfaces:**
- Consumes: `startRelay` (Task 6), `makeApnsClient` (existing).
- Produces: `npx matron-push-relay` / `node bin/matron-push-relay.js` — requires all four `MATRON_APNS_*`, listens on `MATRON_RELAY_BIND`:`MATRON_RELAY_PORT` (127.0.0.1:9821 default).

- [ ] **Step 1: Write the entry point**

Create `bin/matron-push-relay.js` (mode 755):

```js
#!/usr/bin/env node
import { makeApnsClient } from '../src/apns.js'
import { startRelay } from '../src/relay.js'

// The relay is useless without the APNs key — unlike the journal (where push
// is an optional feature that degrades to a warn log), missing config here
// is a hard startup error.
const { MATRON_APNS_KEY_FILE, MATRON_APNS_KEY_ID, MATRON_APNS_TEAM_ID, MATRON_APNS_TOPIC } = process.env
if (!(MATRON_APNS_KEY_FILE && MATRON_APNS_KEY_ID && MATRON_APNS_TEAM_ID && MATRON_APNS_TOPIC)) {
  console.error('matron-push-relay: MATRON_APNS_KEY_FILE, MATRON_APNS_KEY_ID, MATRON_APNS_TEAM_ID and MATRON_APNS_TOPIC must all be set')
  process.exit(1)
}

const apnsClient = makeApnsClient({
  keyFile: MATRON_APNS_KEY_FILE, keyId: MATRON_APNS_KEY_ID,
  teamId: MATRON_APNS_TEAM_ID, topic: MATRON_APNS_TOPIC,
})

const port = Number(process.env.MATRON_RELAY_PORT || 9821)
const bind = process.env.MATRON_RELAY_BIND || '127.0.0.1'
const relay = await startRelay({ apnsClient, port, bind })
console.log(`matron-push-relay listening on ${bind}:${relay.port}`)

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { relay.close(); process.exit(0) })
}
```

In `package.json`, change the bin map:

```json
  "bin": { "matron-admin": "bin/matron-admin.js", "matron-push-relay": "bin/matron-push-relay.js" },
```

- [ ] **Step 2: Smoke-test it manually**

```bash
chmod +x bin/matron-push-relay.js
node bin/matron-push-relay.js; echo "exit=$?"
```
Expected: the config error line and `exit=1`.

```bash
# Throwaway P-256 key standing in for the real .p8 — startup only, no send.
KEY=$(mktemp -d)/AuthKey_TEST.p8
node -e "const c=require('node:crypto');const{privateKey}=c.generateKeyPairSync('ec',{namedCurve:'P-256'});require('node:fs').writeFileSync(process.argv[1],privateKey.export({type:'pkcs8',format:'pem'}))" "$KEY"
MATRON_APNS_KEY_FILE=$KEY MATRON_APNS_KEY_ID=K MATRON_APNS_TEAM_ID=T MATRON_APNS_TOPIC=chat.matron.app MATRON_RELAY_PORT=0 node bin/matron-push-relay.js &
sleep 1
# Grab the actual port from the log line it printed, then:
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/anything   # expect 404
kill %1
```
Expected: prints the listening line; the curl returns 404.

- [ ] **Step 3: Document the config**

In `README.md`'s env-var table, add after the `MATRON_APNS_*` row:

```markdown
| `MATRON_PUSH_GATEWAY_URL` | unset | No APNs key? Point at a push relay (`https://push.matron.chat`) — pushes become generic-text alerts built by the relay; your message content never leaves this server |
| `MATRON_RELAY_PORT` / `MATRON_RELAY_BIND` | `9821` / `127.0.0.1` | matron-push-relay only |
```

And add a short section after the existing push/APNs docs (adjust placement to fit the README's flow):

```markdown
## Push relay (self-hosted journals)

Only the app author holds the APNs key for the `chat.matron.app` bundle id, so a
self-hosted journal cannot talk to Apple directly. Set
`MATRON_PUSH_GATEWAY_URL=https://push.matron.chat` and the journal sends each
push as a content-free event instead: device token, environment, a category
(`attention` / `done` / `activity` / `wake`), badge count, and conversation-id
routing fields. The relay maps the category to a fixed generic string ("Your
agent needs you", "Session finished", …) — your message content, titles, and
conversation names never leave your server, structurally: the relay protocol
has no field that could carry them.

Running your own relay (needs an Apple Developer membership and the app's APNs
key, so this is for the hosted one's operator):

    MATRON_APNS_KEY_FILE=… MATRON_APNS_KEY_ID=… MATRON_APNS_TEAM_ID=… \
    MATRON_APNS_TOPIC=chat.matron.app npx matron-push-relay
```

- [ ] **Step 4: Full suite, then commit**

Run: `npm test`
Expected: PASS (nothing in the suite touches the bin, but keep the count honest).

```bash
git add bin/matron-push-relay.js package.json README.md
git commit -m "feat(relay): matron-push-relay entry point + config docs"
```

---

### Task 8: `PUT /push/prefs` + prefs echo in HTTP responses

**Files:**
- Modify: `src/http.js`
- Test: `test/http.test.js`

**Interfaces:**
- Consumes: `setPushPrefs`, `parsePushPrefs` from Task 1 (and `listDevices` already echoes prefs via Task 1).
- Produces: `PUT /push/prefs` (client devices only) — body of optional booleans `{attention?, done?, activity?}`, partial merge, 200 `{ok: true, push_prefs: {…}}`; unknown fields / non-boolean values → 400. `POST /push/register` 200 responses gain `push_prefs`.

- [ ] **Step 1: Write the failing tests**

Append to `test/http.test.js` (reuse the file's existing setup helpers for creating a user + logging in; the shape below assumes `startTestServer` from `./helpers.js` and a logged-in client token — mirror however the existing `/push/register` tests in this file obtain `token`):

```js
test('PUT /push/prefs merges partial updates and echoes everywhere', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'password1')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password1', device_name: 'phone' } })
  const token = login.json.token

  // Defaults echo all-on from GET /devices.
  const before = await s.http('/devices', { token })
  assert.deepEqual(before.json.devices[0].push_prefs, { attention: true, done: true, activity: true })

  // Partial update merges.
  const r1 = await s.http('/push/prefs', { method: 'PUT', token, body: { activity: false } })
  assert.equal(r1.status, 200)
  assert.deepEqual(r1.json.push_prefs, { attention: true, done: true, activity: false })
  const r2 = await s.http('/push/prefs', { method: 'PUT', token, body: { done: false } })
  assert.deepEqual(r2.json.push_prefs, { attention: true, done: false, activity: false })

  // Echoed from /devices and /push/register.
  const after = await s.http('/devices', { token })
  assert.deepEqual(after.json.devices[0].push_prefs, { attention: true, done: false, activity: false })
  const reg = await s.http('/push/register', { method: 'POST', token, body: { apns_token: 'ab'.repeat(32), environment: 'prod' } })
  assert.equal(reg.status, 200)
  assert.deepEqual(reg.json.push_prefs, { attention: true, done: false, activity: false })
})

test('PUT /push/prefs validation: unknown fields, non-boolean values, agent devices', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'password1')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password1' } })
  const token = login.json.token

  assert.equal((await s.http('/push/prefs', { method: 'PUT', token, body: { wake: false } })).status, 400)
  assert.equal((await s.http('/push/prefs', { method: 'PUT', token, body: { attention: 'no' } })).status, 400)
  assert.equal((await s.http('/push/prefs', { method: 'PUT', token, body: {} })).status, 200, 'an empty body is a valid no-op')

  const agent = createAgent(s.db, login.json.user_id, 'bridge')
  assert.equal((await s.http('/push/prefs', { method: 'PUT', token: agent.token, body: { attention: false } })).status, 403)
})
```

Check the top of `test/http.test.js` for what it already imports; ensure `createUser` and `createAgent` come from `'../src/auth.js'` and `startTestServer` from `'./helpers.js'`. Teardown is `t.after(() => s.close())` — that is the method every existing test in this file uses, and `createAgent` is synchronous (no `await`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/http.test.js`
Expected: FAIL — `PUT /push/prefs` returns 404.

- [ ] **Step 3: Implement**

In `src/http.js`, extend the db.js import:

```js
import { insertBlob, getBlob, setApnsRegistration, listDevices, setPushPrefs, getPushPrefs } from './db.js'
```

Task 1 did not create `getPushPrefs` — add it to `src/db.js` next to `setPushPrefs` (it's the read half of the same pair):

```js
export function getPushPrefs(db, deviceId) {
  const row = db.prepare('SELECT push_prefs FROM devices WHERE id=?').get(deviceId)
  return parsePushPrefs(row ? row.push_prefs : null)
}
```

In the `/push/register` handler, echo prefs on both 200 paths:

```js
        if (apns_token === null) {
          setApnsRegistration(db, who.deviceId, { apnsToken: null, apnsEnv: null })
          return json(res, 200, { ok: true, push_prefs: getPushPrefs(db, who.deviceId) })
        }
        if (typeof apns_token !== 'string' || !apns_token) return json(res, 400, { error: 'bad_request' })
        if (environment !== 'sandbox' && environment !== 'prod') return json(res, 400, { error: 'bad_request' })
        setApnsRegistration(db, who.deviceId, { apnsToken: apns_token, apnsEnv: environment })
        return json(res, 200, { ok: true, push_prefs: getPushPrefs(db, who.deviceId) })
```

Directly after the `/push/register` block, add the new route:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/http.test.js`
Expected: PASS.

- [ ] **Step 5: Full suite, then commit**

Run: `npm test`
Expected: PASS — final green across the whole repo.

```bash
git add src/http.js src/db.js test/http.test.js
git commit -m "feat(http): PUT /push/prefs with partial merge; echo prefs from register/devices"
```

---

## Post-implementation (not tasks in this plan)

- Open the PR from `feat/push-relay` (spec + plan + implementation).
- Deploy: relay on Dan's journal box (launchd/systemd), cloudflared ingress `push.matron.chat → 127.0.0.1:9821`, `cloudflared tunnel route dns <tunnel> push.matron.chat`.
- matron-site: support-page push answer + privacy-policy line (relay receives a device push token and an event category, never message content).
- Friend onboarding doc (separate deliverable).
- v2 (matron-apple): settings toggles + NSE snippet fetch — separate spec section, next TestFlight build.
