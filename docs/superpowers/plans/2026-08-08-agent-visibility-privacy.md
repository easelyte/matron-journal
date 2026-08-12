# Agent Visibility & Privacy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-device `private` flag that makes an agent device invisible and unreachable to other agent devices — absent from the roster, excluded from search and context reads, and untargetable by `agent_invite`/`agent_join` — while the user's own apps see everything unchanged.

**Architecture:** Two columns on `devices` (`private` + `private_pinned`), one caller predicate (`privacy filters apply iff the caller is a non-private agent`), enforced at exactly four surfaces: `GET /roster`, `GET /search`, the `around_seq` context mode, and the two chat ops. The bridge asserts its own flag on every WS hello (`MATRON_AGENT_PRIVATE`, bridge-side); `matron-admin` can pin the flag so a deploy that forgot the env var can never silently unmark a machine.

**Tech Stack:** Node ≥20 ESM, better-sqlite3 ^11, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-07-agent-visibility-privacy-design.md`.

**Dependency:** Tasks 1–5 stand alone. Task 6 modifies `searchMessages` and the `around_seq` route from the journal-search plan (`docs/superpowers/plans/2026-08-08-agent-journal-search.md`) — execute that plan first.

## Global Constraints

- A private device must be **byte-identical** on the wire to a nonexistent one for every filtered caller: `agent_invite`/`agent_join` answer `not_found` with exactly the frame an unknown id gets; `around_seq` answers the same 404 body as a missing conversation. A distinct "that agent is private" error would confirm existence — the thing being hidden.
- Every rule is conditioned on the caller: `kind='client'` callers are never filtered; a private agent caller is never filtered (it is invisible, not blinded — spec "one-directional, deliberately").
- Admin wins: a flag set by `matron-admin` (`private_pinned=1`) survives any number of bridge hellos asserting otherwise. Getting this backwards silently unmarks a machine — it is pinned by a dedicated test.
- HTTP/WS conventions as everywhere in this repo: `fail(code, detail)` control frames, `json(res, code, { error })`, 404-not-403 anti-enumeration.
- Tests: `node:test` + `assert/strict`, `openDb(':memory:')` for DB-level, `startTestServer()` + `makeWsClient()` from `test/helpers.js` for server-level.
- No new npm dependencies.
- Full suite (`npm test`) must pass before every commit; assert the run actually executed tests.

## Locked decisions (fold into the spec in Task 7)

Called out in the PR body for Dan:

1. **The bridge presents its flag on every WS hello** — an optional boolean `private` field on the hello frame, applied for agent connections only, ignored for clients. Rationale: agents are minted at `/pair/claim` (a one-shot poll with no operator present) and long-lived after that; hello is the only recurring moment the bridge can assert env-var config without re-pairing. The bridge-side change (read `MATRON_AGENT_PRIVATE`, send the field) is a separate matron-bridge task.
2. **Pin semantics.** `private_pinned=1` means matron-admin owns the flag and hello assertions are ignored. `matron-admin device private <id> on|off` sets value + pin; `auto` clears the pin (the value stays until the next hello asserts). An unpinned flag follows the hello assertion exactly — including hello-without-the-field, which asserts `false` (spec test: bridge-set privacy does NOT survive a re-register without the env var; admin-set does).
3. **Spec open question 1 (precedence): resolved as proposed — admin wins** (that is what the pin is).
4. **Spec open question 3 (can two private agents see each other): resolved as proposed — yes.** Implemented as: the privacy filter applies only when the caller is a non-private agent, at every surface uniformly (roster, search, context, chat). The spec's "can start chats with non-private agents" sentence is superseded by this — a private agent can also invite another private agent; "private is about the boundary with ordinary agents".
5. **Spec open question 2 (per-conversation privacy): out of scope**, unchanged.
6. **`GET /devices` is untouched** — it is already client-only (src/http.js:292), so a private device correctly remains visible there to the user.

## File Structure

- **Modify `src/db.js`** — the two `ALTER TABLE devices` migrations (existing `PRAGMA table_info` pattern) + three helpers: `isPrivateDevice`, `pinDevicePrivate`, `unpinDevicePrivate`, `applyBridgePrivate`.
- **Modify `src/ws.js`** — hello accepts/applies the `private` assertion; `agent_invite`/`agent_join` treat a filtered private target as `not_found`.
- **Modify `src/http.js`** — `GET /roster` filtering; `around_seq` refusal; passes the exclusion flag to `searchMessages`.
- **Modify `src/search.js`** — `searchMessages` gains `excludePrivateOwned` (Task 6).
- **Modify `bin/matron-admin.js`** — `device private <id> on|off|auto`; `device list` shows the flag.
- **Modify `docs/protocol.md`** + spec fold-in.
- **Create `test/privacy.test.js`** — the whole matrix in one place.

---

### Task 1: Schema + helpers — the flag pair

**Files:**
- Modify: `src/db.js`
- Test: `test/privacy.test.js`

**Interfaces:**
- Produces (all exported from `src/db.js`, consumed by Tasks 2–6):
  - `isPrivateDevice(db, deviceId) -> boolean`
  - `pinDevicePrivate(db, deviceId, value) -> void` — sets `private` and `private_pinned=1`
  - `unpinDevicePrivate(db, deviceId) -> void` — clears the pin only
  - `applyBridgePrivate(db, deviceId, value) -> void` — writes `private` only where `private_pinned=0`

- [ ] **Step 1: Write the failing tests**

```js
// test/privacy.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, isPrivateDevice, pinDevicePrivate, unpinDevicePrivate, applyBridgePrivate } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'

async function dbWithAgent() {
  const db = openDb(':memory:')
  const u = await createUser(db, 'dan', 'pw')
  const a = createAgent(db, u.id, 'kit')
  return { db, userId: u.id, deviceId: a.deviceId, token: a.token }
}

test('privacy flag: defaults to 0 and unpinned for every device', async () => {
  const { db, deviceId } = await dbWithAgent()
  assert.equal(isPrivateDevice(db, deviceId), false)
  const row = db.prepare('SELECT private, private_pinned FROM devices WHERE id=?').get(deviceId)
  assert.deepEqual(row, { private: 0, private_pinned: 0 })
  db.close()
})

test('privacy flag: bridge assertion applies only while unpinned', async () => {
  const { db, deviceId } = await dbWithAgent()
  applyBridgePrivate(db, deviceId, true)
  assert.equal(isPrivateDevice(db, deviceId), true)
  applyBridgePrivate(db, deviceId, false)
  assert.equal(isPrivateDevice(db, deviceId), false)
  pinDevicePrivate(db, deviceId, true)
  applyBridgePrivate(db, deviceId, false) // the forgot-the-env-var deploy
  assert.equal(isPrivateDevice(db, deviceId), true, 'admin pin survives a contrary hello')
  unpinDevicePrivate(db, deviceId)
  assert.equal(isPrivateDevice(db, deviceId), true, 'unpinning alone changes no value')
  applyBridgePrivate(db, deviceId, false)
  assert.equal(isPrivateDevice(db, deviceId), false, 'after unpin the bridge assertion applies again')
  db.close()
})

test('privacy flag: pin off is also pinned — admin can force-visible', async () => {
  const { db, deviceId } = await dbWithAgent()
  pinDevicePrivate(db, deviceId, false)
  applyBridgePrivate(db, deviceId, true)
  assert.equal(isPrivateDevice(db, deviceId), false)
  db.close()
})

test('privacy flag: isPrivateDevice on an unknown/deleted id is false, never a throw', async () => {
  const { db } = await dbWithAgent()
  assert.equal(isPrivateDevice(db, 99999), false)
  db.close()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/privacy.test.js`
Expected: FAIL — the helpers are not exported / columns missing.

- [ ] **Step 3: Implement in `src/db.js`**

In `openDb`, next to the existing `deviceCols` migrations (src/db.js:106-116):

```js
  // Per-device agent-visibility flag (spec: agent visibility & privacy).
  // `private=1` = invisible and unreachable to OTHER agent devices — not to
  // the user's own client devices, which see everything unchanged. Enforced
  // at four surfaces: GET /roster, GET /search, around_seq context reads,
  // and agent_invite/agent_join targeting. `private_pinned=1` records that
  // matron-admin owns the flag: the bridge's per-hello assertion is ignored
  // while pinned, so a deploy that forgot MATRON_AGENT_PRIVATE can never
  // silently unmark a machine (admin wins — spec precedence decision).
  if (!deviceCols.some((c) => c.name === 'private')) {
    db.exec('ALTER TABLE devices ADD COLUMN private INTEGER NOT NULL DEFAULT 0')
  }
  if (!deviceCols.some((c) => c.name === 'private_pinned')) {
    db.exec('ALTER TABLE devices ADD COLUMN private_pinned INTEGER NOT NULL DEFAULT 0')
  }
```

At the bottom of the file, next to the other device helpers:

```js
// The privacy flag, read side. False for unknown ids: a caller checking a
// dangling/deleted device must fall through to the normal not_found path,
// not crash.
export function isPrivateDevice(db, deviceId) {
  return !!db.prepare('SELECT 1 FROM devices WHERE id=? AND private=1').get(deviceId)
}

// matron-admin's write: sets the value AND takes ownership (pin). Both
// directions pin — `off` is "force-visible", not "hands off".
export function pinDevicePrivate(db, deviceId, value) {
  db.prepare('UPDATE devices SET private=?, private_pinned=1 WHERE id=?').run(value ? 1 : 0, deviceId)
}

// Hands the flag back to the bridge's hello assertion. Deliberately does not
// touch the value — the next hello does.
export function unpinDevicePrivate(db, deviceId) {
  db.prepare('UPDATE devices SET private_pinned=0 WHERE id=?').run(deviceId)
}

// The bridge's per-hello assertion (MATRON_AGENT_PRIVATE on the bridge
// side). A no-op while pinned. Hello-without-the-field asserts false — a
// bridge-set flag does NOT survive a re-register without the env var; an
// admin-set one does (the pin).
export function applyBridgePrivate(db, deviceId, value) {
  db.prepare('UPDATE devices SET private=? WHERE id=? AND private_pinned=0').run(value ? 1 : 0, deviceId)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/privacy.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite (schema migration touches every opener)**

Run: `npm test 2>&1 | tail -8`
Expected: `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/db.js test/privacy.test.js
git commit -m "privacy: devices.private + private_pinned — flag pair with admin-wins precedence"
```

---

### Task 2: Hello assertion — the bridge presents its flag

**Files:**
- Modify: `src/ws.js` (the hello handler, src/ws.js:260-294)
- Test: `test/privacy.test.js`

**Interfaces:**
- Consumes: `applyBridgePrivate` (Task 1).
- Produces: hello frames may carry `private: boolean`; agent connections apply it before replay/registration; client connections ignore it; a non-boolean value is a `bad_request` hello error (socket closed), same as a bad cursor.

- [ ] **Step 1: Write the failing tests**

Add to `test/privacy.test.js`:

```js
import { startTestServer, makeWsClient } from './helpers.js'

async function serverWithAgent() {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })
  const userId = login.json.user_id
  const clientToken = login.json.token
  const agent = createAgent(s.db, userId, 'kit')
  return { s, userId, clientToken, agent }
}

// hello with an explicit private field needs a raw client — makeWsClient's
// hello only sends token+cursor, so drive the frame by hand.
function helloRaw(base, frame) {
  return new Promise((resolve, reject) => {
    import('ws').then(({ default: WebSocket }) => {
      const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
      const frames = []
      ws.on('message', (d) => frames.push(JSON.parse(d)))
      ws.on('error', reject)
      ws.on('close', () => resolve({ frames, closed: true }))
      ws.on('open', () => {
        ws.send(JSON.stringify(frame))
        setTimeout(() => { if (ws.readyState === 1) resolve({ frames, closed: false, ws }) }, 150)
      })
    })
  })
}

test('hello: an agent asserting private:true is marked private before registration', async () => {
  const { s, agent } = await serverWithAgent()
  const r = await helloRaw(s.base, { op: 'hello', token: agent.token, private: true })
  assert.ok(r.frames.some((f) => f.op === 'hello_ok'))
  assert.equal(s.db.prepare('SELECT private FROM devices WHERE id=?').get(agent.deviceId).private, 1)
  r.ws?.close()
  await s.close()
})

test('hello: omitting the field asserts visible — bridge-set privacy does not survive a re-register', async () => {
  const { s, agent } = await serverWithAgent()
  const r1 = await helloRaw(s.base, { op: 'hello', token: agent.token, private: true })
  r1.ws?.close()
  const r2 = await helloRaw(s.base, { op: 'hello', token: agent.token })
  assert.equal(s.db.prepare('SELECT private FROM devices WHERE id=?').get(agent.deviceId).private, 0)
  r2.ws?.close()
  await s.close()
})

test('hello: an admin-pinned flag survives a contrary hello', async () => {
  const { s, agent } = await serverWithAgent()
  const { pinDevicePrivate } = await import('../src/db.js')
  pinDevicePrivate(s.db, agent.deviceId, true)
  const r = await helloRaw(s.base, { op: 'hello', token: agent.token })
  assert.ok(r.frames.some((f) => f.op === 'hello_ok'))
  assert.equal(s.db.prepare('SELECT private FROM devices WHERE id=?').get(agent.deviceId).private, 1)
  r.ws?.close()
  await s.close()
})

test('hello: a client sending private is ignored; a non-boolean is rejected', async () => {
  const { s, clientToken } = await serverWithAgent()
  const ok = await helloRaw(s.base, { op: 'hello', token: clientToken, private: true })
  assert.ok(ok.frames.some((f) => f.op === 'hello_ok'), 'client hello unaffected')
  ok.ws?.close()
  const bad = await helloRaw(s.base, { op: 'hello', token: clientToken, private: 'yes' })
  assert.ok(bad.frames.some((f) => f.op === 'error' && f.code === 'bad_request' && f.ref === 'hello'))
  await s.close()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/privacy.test.js`
Expected: the four new tests FAIL (flag never written / no bad_request).

- [ ] **Step 3: Implement in `src/ws.js`**

Import `applyBridgePrivate` from `./db.js` (the file already imports from it — extend that import).

In the hello handler, directly after the cursor validation block (src/ws.js:274-278), add:

```js
          // Optional bridge assertion of its own visibility flag (spec:
          // agent visibility & privacy — MATRON_AGENT_PRIVATE, bridge-side).
          // Same reject shape as a bad cursor: a malformed hello dies here.
          if (msg.private !== undefined && typeof msg.private !== 'boolean') {
            ws.send(JSON.stringify({ kind: 'control', op: 'error', code: 'bad_request', ref: 'hello' }))
            ws.close()
            return
          }
          // Agents only — a client has no visibility flag to assert, and
          // silently ignoring it beats closing a working app's socket over a
          // field it should never send. Applied BEFORE replay/registration so
          // every read this connection triggers already sees the new state.
          // Absent field = asserts visible: an unpinned flag follows the env
          // var exactly, including its removal (admin pin is the override).
          if (who.kind === 'agent') applyBridgePrivate(db, who.deviceId, msg.private === true)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/privacy.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite (every WS test goes through hello)**

Run: `npm test 2>&1 | tail -8`
Expected: `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/ws.js test/privacy.test.js
git commit -m "privacy: hello carries the bridge's private assertion, admin pin wins"
```

---

### Task 3: matron-admin — `device private on|off|auto`, visible in `device list`

**Files:**
- Modify: `bin/matron-admin.js`
- Test: `test/admin.test.js` (follow its existing `runAdmin(db, argv)` style)

**Interfaces:**
- Consumes: `pinDevicePrivate`, `unpinDevicePrivate` (Task 1).
- Produces: `matron-admin device private <device_id> on|off|auto`; `device list` lines gain a `private=yes|no(+pinned)` marker.

- [ ] **Step 1: Write the failing tests**

Add to `test/admin.test.js` (it already has `runAdmin` + an in-memory DB fixture; follow the file's local helpers):

```js
test('device private: on pins private, off pins visible, auto releases the pin', async () => {
  const db = openDb(':memory:')
  const u = await createUser(db, 'dan', 'pw')
  const a = createAgent(db, u.id, 'kit')
  const out = await runAdmin(db, ['device', 'private', String(a.deviceId), 'on'])
  assert.match(out, /private/)
  assert.deepEqual(db.prepare('SELECT private, private_pinned FROM devices WHERE id=?').get(a.deviceId), { private: 1, private_pinned: 1 })
  await runAdmin(db, ['device', 'private', String(a.deviceId), 'off'])
  assert.deepEqual(db.prepare('SELECT private, private_pinned FROM devices WHERE id=?').get(a.deviceId), { private: 0, private_pinned: 1 })
  const auto = await runAdmin(db, ['device', 'private', String(a.deviceId), 'auto'])
  assert.match(auto, /bridge|hello|env/i, 'output explains the flag now follows the bridge')
  assert.equal(db.prepare('SELECT private_pinned FROM devices WHERE id=?').get(a.deviceId).private_pinned, 0)
  db.close()
})

test('device private: unknown device and bad mode are refused', async () => {
  const db = openDb(':memory:')
  await assert.rejects(() => runAdmin(db, ['device', 'private', '999', 'on']), /no such device/)
  const u = await createUser(db, 'dan', 'pw')
  const a = createAgent(db, u.id, 'kit')
  await assert.rejects(() => runAdmin(db, ['device', 'private', String(a.deviceId), 'maybe']), /usage/i)
  db.close()
})

test('device list: shows the private flag and its pin state', async () => {
  const db = openDb(':memory:')
  const u = await createUser(db, 'dan', 'pw')
  const a = createAgent(db, u.id, 'kit')
  await runAdmin(db, ['device', 'private', String(a.deviceId), 'on'])
  const out = await runAdmin(db, ['device', 'list', 'dan'])
  assert.match(out, /private=yes \(pinned\)/)
  db.close()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/admin.test.js`
Expected: FAIL — usage error for the unknown subcommand.

- [ ] **Step 3: Implement in `bin/matron-admin.js`**

Extend the `../src/db.js` import with `pinDevicePrivate, unpinDevicePrivate`. Add to `USAGE` after `device revoke`:

```
  matron-admin device private <device_id> on|off|auto
```

Add the handler after the `device revoke` block:

```js
  // Visibility flag override (spec: agent visibility & privacy). on/off PIN
  // the flag — the bridge's per-hello MATRON_AGENT_PRIVATE assertion is
  // ignored until `auto` releases it. This is what makes admin authoritative:
  // a deploy that forgot the env var cannot unmark a pinned machine.
  if (a === 'device' && b === 'private') {
    const deviceId = Number(argv[2])
    const mode = argv[3]
    if (!Number.isInteger(deviceId) || !['on', 'off', 'auto'].includes(mode)) throw new Error(USAGE)
    const existing = db.prepare('SELECT id FROM devices WHERE id=?').get(deviceId)
    if (!existing) throw new Error(`no such device: ${deviceId}`)
    if (mode === 'auto') {
      unpinDevicePrivate(db, deviceId)
      return `device ${deviceId} privacy unpinned — the flag now follows the bridge's hello assertion (MATRON_AGENT_PRIVATE) from its next connect`
    }
    pinDevicePrivate(db, deviceId, mode === 'on')
    return `device ${deviceId} pinned private=${mode} — the bridge's hello assertion is ignored until 'auto' releases it`
  }
```

Update the `device list` line format (bin/matron-admin.js:127-129) to select and render the flag:

```js
    const devices = db.prepare('SELECT id, kind, name, cursor, last_seen_at, private, private_pinned FROM devices WHERE user_id=? ORDER BY id').all(user.id)
    if (devices.length === 0) return `no devices for ${username}`
    return devices.map((d) =>
      `${d.id} kind=${d.kind} name=${d.name} cursor=${d.cursor} last_seen_at=${d.last_seen_at ?? 'never'}` +
      ` private=${d.private ? 'yes' : 'no'}${d.private_pinned ? ' (pinned)' : ''}`
    ).join('\n')
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/admin.test.js`
Expected: PASS (including the pre-existing admin tests — the `device list` format change may need their expectations updated; if an existing test pins the old line format, update it in the same commit).

- [ ] **Step 5: Commit**

```bash
git add bin/matron-admin.js test/admin.test.js
git commit -m "privacy: matron-admin device private on|off|auto + list marker"
```

---

### Task 4: Roster filtering — invisible to ordinary agents, visible to everyone else

**Files:**
- Modify: `src/http.js` (the `GET /roster` block, src/http.js:301-321)
- Test: `test/privacy.test.js`

**Interfaces:**
- Consumes: `isPrivateDevice` (Task 1).
- Produces: for a non-private agent caller, `GET /roster` omits private agent devices and every conversation whose `agent_device_id` is private. Client callers and private agent callers get the unfiltered roster.

- [ ] **Step 1: Write the failing tests**

Add to `test/privacy.test.js`:

```js
import { upsertConversation } from '../src/journal.js'

// Fixture: dan with a client, an ordinary agent (kit), and two private
// agents (ghost, wraith). ghost manages a conversation.
async function privacyFixture() {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })
  const userId = login.json.user_id
  const clientToken = login.json.token
  const kit = createAgent(s.db, userId, 'kit')
  const ghost = createAgent(s.db, userId, 'ghost')
  const wraith = createAgent(s.db, userId, 'wraith')
  const { pinDevicePrivate } = await import('../src/db.js')
  pinDevicePrivate(s.db, ghost.deviceId, true)
  pinDevicePrivate(s.db, wraith.deviceId, true)
  upsertConversation(s.db, { id: 'open-work', ownerUserId: userId, title: 'Open work', sessionState: 'running', agentDeviceId: kit.deviceId })
  upsertConversation(s.db, { id: 'ghost-work', ownerUserId: userId, title: 'Ghost work', sessionState: 'running', agentDeviceId: ghost.deviceId })
  upsertConversation(s.db, { id: 'legacy', ownerUserId: userId, title: 'Legacy', sessionState: 'done' }) // agent_device_id NULL
  return { s, userId, clientToken, kit, ghost, wraith }
}

test('roster: an ordinary agent cannot see private devices or their conversations', async () => {
  const { s, kit, ghost } = await privacyFixture()
  const r = await s.http('/roster', { token: kit.token })
  assert.equal(r.status, 200)
  const ids = r.json.agents.map((a) => a.device_id)
  assert.ok(ids.includes(kit.deviceId))
  assert.ok(!ids.includes(ghost.deviceId), 'private device absent')
  const convos = r.json.conversations.map((c) => c.id)
  assert.ok(convos.includes('open-work'))
  assert.ok(convos.includes('legacy'), 'NULL-owner conversations stay visible')
  assert.ok(!convos.includes('ghost-work'), 'private-owned conversation absent — the summaries are the point')
  await s.close()
})

test('roster: a client sees everything, unchanged', async () => {
  const { s, clientToken, ghost } = await privacyFixture()
  const r = await s.http('/roster', { token: clientToken })
  assert.ok(r.json.agents.some((a) => a.device_id === ghost.deviceId))
  assert.ok(r.json.conversations.some((c) => c.id === 'ghost-work'))
  await s.close()
})

test('roster: a private agent sees the whole roster — including another private agent', async () => {
  const { s, ghost, wraith } = await privacyFixture()
  const r = await s.http('/roster', { token: ghost.token })
  assert.ok(r.json.agents.some((a) => a.device_id === wraith.deviceId), 'two private agents see each other')
  assert.ok(r.json.conversations.some((c) => c.id === 'ghost-work'))
  await s.close()
})

test('roster: privacy is per-user — another user roster is unaffected either way', async () => {
  const { s, ghost } = await privacyFixture()
  await createUser(s.db, 'eve', 'password-123')
  const eve = (await s.http('/login', { method: 'POST', body: { username: 'eve', password: 'password-123' } })).json
  const eveAgent = createAgent(s.db, eve.user_id, 'evebot')
  const r = await s.http('/roster', { token: eveAgent.token })
  // dan's devices — private or not — were never visible to eve's agents and stay that way
  assert.ok(!r.json.agents.some((a) => a.device_id === ghost.deviceId))
  assert.deepEqual(r.json.conversations, [])
  await s.close()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/privacy.test.js`
Expected: the first test FAILS (ghost visible); the other two pass vacuously today — keep them, they pin the non-regression.

- [ ] **Step 3: Implement in `src/http.js`**

Extend the `./db.js` import with `isPrivateDevice`. In the `GET /roster` block, replace the two queries with:

```js
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
```

(Keep the existing `live` Set line above unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/privacy.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite (the roster is consumed by agent.test.js and bridge-shaped tests)**

Run: `npm test 2>&1 | tail -8`
Expected: `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/http.js test/privacy.test.js
git commit -m "privacy: roster omits private devices and their conversations for ordinary agents"
```

---

### Task 5: Chat surfaces — unreachable, byte-identical to nonexistent

**Files:**
- Modify: `src/ws.js` (`agent_invite` target check src/ws.js:664-665; `agent_join` owner check src/ws.js:730-731)
- Test: `test/privacy.test.js`

**Interfaces:**
- Consumes: `isPrivateDevice` (Task 1), fixture from Task 4.
- Produces: `agent_invite` targeting a private device and `agent_join` on a private-owned room both answer the exact `not_found` frame an unknown id gets — for ordinary agent callers only. A private caller passes.

- [ ] **Step 1: Write the failing tests**

Add to `test/privacy.test.js`. Room setup mirrors `test/agent-chat-consent.test.js` — connect agents with `makeWsClient`, create the room via `convo_upsert`, then drive `agent_invite`/`agent_join`:

```js
// Extends privacyFixture with live sockets for kit (ordinary) and ghost
// (private), and a room each manages.
async function chatPrivacyFixture() {
  const fx = await privacyFixture()
  const kitWs = await makeWsClient(fx.s.base, { token: fx.kit.token, cursor: 0 })
  await kitWs.waitFor((f) => f.op === 'hello_ok')
  const ghostWs = await makeWsClient(fx.s.base, { token: fx.ghost.token, cursor: 0 })
  await ghostWs.waitFor((f) => f.op === 'hello_ok')
  kitWs.send({ op: 'convo_upsert', convo_id: 'kit-room', title: 'Kit room', session_state: 'running' })
  ghostWs.send({ op: 'convo_upsert', convo_id: 'ghost-room', title: 'Ghost room', session_state: 'running' })
  await new Promise((r) => setTimeout(r, 100))
  return { ...fx, kitWs, ghostWs }
}

test('agent_invite: a private target answers not_found, byte-identical to an unknown id', async () => {
  const { s, kitWs, ghost } = await chatPrivacyFixture()
  kitWs.send({ op: 'agent_invite', room_id: 'kit-room', target_device_id: ghost.deviceId, justification: 'let me in' })
  const priv = await kitWs.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite')
  kitWs.send({ op: 'agent_invite', room_id: 'kit-room', target_device_id: 999999, justification: 'let me in' })
  const unknown = await kitWs.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite' && f !== priv)
  assert.equal(priv.code, 'not_found')
  const strip = ({ ...f }) => f
  assert.deepEqual(strip(priv), strip(unknown), 'frames identical — existence never confirmed')
  kitWs.close(); await s.close()
})

test('agent_join: a private-owned room answers not_found like a room that does not exist', async () => {
  const { s, kitWs } = await chatPrivacyFixture()
  kitWs.send({ op: 'agent_join', room_id: 'ghost-room', justification: 'curious' })
  const priv = await kitWs.waitFor((f) => f.op === 'error' && f.ref === 'agent_join')
  kitWs.send({ op: 'agent_join', room_id: 'no-such-room', justification: 'curious' })
  const unknown = await kitWs.waitFor((f) => f.op === 'error' && f.ref === 'agent_join' && f.room_id === 'no-such-room')
  assert.equal(priv.code, 'not_found')
  assert.equal(unknown.code, 'not_found')
  kitWs.close(); await s.close()
})

test('a private agent keeps full outbound capability: it can invite an ordinary agent', async () => {
  const { s, ghostWs, kit } = await chatPrivacyFixture()
  ghostWs.send({ op: 'agent_invite', room_id: 'ghost-room', target_device_id: kit.deviceId, justification: 'need your eyes' })
  const ack = await ghostWs.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  assert.equal(ack.room_id, 'ghost-room')
  ghostWs.close(); await s.close()
})

test('a private agent can invite another private agent (the boundary is with ordinary agents)', async () => {
  const { s, ghostWs, wraith } = await chatPrivacyFixture()
  ghostWs.send({ op: 'agent_invite', room_id: 'ghost-room', target_device_id: wraith.deviceId, justification: 'ghost to wraith' })
  const ack = await ghostWs.waitFor((f) => (f.kind === 'invite' && f.event === 'delivered') || f.op === 'error')
  assert.equal(ack.event, 'delivered')
  ghostWs.close(); await s.close()
})
```

**Note on the join test's room visibility:** `ghost-room` is created by ghost's own `convo_upsert`, so it exists and is owned by dan's user — kit's `agent_join` reaches the owner-privacy check, which is the point. The `no-such-room` control exercises `loadRoom`'s own 404.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/privacy.test.js`
Expected: the first two tests FAIL (invite parks / join parks instead of `not_found`); the outbound tests pass already — keep them as regression pins.

- [ ] **Step 3: Implement in `src/ws.js`**

Extend the `./db.js` import with `isPrivateDevice`.

`agent_invite` (src/ws.js:664-665): replace the target check with

```js
        // Unknown id, another user's device, a client device — and now a
        // private device seen by an ORDINARY agent — are indistinguishable
        // (spec: agent visibility & privacy; a distinct error would confirm
        // the existence being hidden). A private CALLER passes: invisible,
        // not blinded.
        const target = db.prepare('SELECT user_id, kind, private FROM devices WHERE id=?').get(msg.target_device_id)
        if (!target || target.user_id !== conn.userId || target.kind !== 'agent'
          || (target.private === 1 && !isPrivateDevice(db, conn.deviceId))) return fail('not_found')
```

`agent_join`: after the `room.agent_device_id === conn.deviceId` check (src/ws.js:731), add:

```js
        // A room owned by a private device does not exist for an ordinary
        // agent — same not_found loadRoom gives an unknown room id.
        if (isPrivateDevice(db, room.agent_device_id) && !isPrivateDevice(db, conn.deviceId)) return fail('not_found')
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/privacy.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite (invites are heavily tested — consent, invites, room-delivery suites)**

Run: `npm test 2>&1 | tail -8`
Expected: `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/ws.js test/privacy.test.js
git commit -m "privacy: private devices are untargetable — not_found identical to unknown ids"
```

---

### Task 6: Search surfaces — no hits from, no context into, private conversations

**Depends on the journal-search plan being implemented** (`searchMessages`, `around_seq` route).

**Files:**
- Modify: `src/search.js` (`searchMessages` gains `excludePrivateOwned`)
- Modify: `src/http.js` (`GET /search` passes it; `around_seq` refuses private-owned conversations for ordinary agents)
- Test: `test/privacy.test.js`

**Interfaces:**
- Consumes: `searchMessages(db, userId, { query, limit, convoId })` and the `agentForeign` branch of the messages route (journal-search plan Task 6); `isPrivateDevice` (Task 1).
- Produces: `searchMessages(db, userId, { ..., excludePrivateOwned: boolean })`; ordinary-agent `/search` excludes hits from private-owned conversations; ordinary-agent `around_seq` on a private-owned conversation → the standard 404.

- [ ] **Step 1: Write the failing tests**

Add to `test/privacy.test.js`:

```js
import { append } from '../src/journal.js'

async function searchPrivacyFixture() {
  const fx = await privacyFixture()
  append(fx.s.db, { userId: fx.userId, convoId: 'open-work', sender: 'agent:kit', type: 'text', payload: { body: 'heliotrope in the open' } })
  append(fx.s.db, { userId: fx.userId, convoId: 'ghost-work', sender: 'agent:ghost', type: 'text', payload: { body: 'heliotrope behind the veil' } })
  return fx
}

test('search: an ordinary agent gets no hits from private-owned conversations', async () => {
  const { s, kit } = await searchPrivacyFixture()
  const r = await s.http('/search?q=heliotrope', { token: kit.token })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.hits.map((h) => h.convo_id), ['open-work'])
  await s.close()
})

test('search: clients and private agents see hits from everywhere', async () => {
  const { s, clientToken, ghost } = await searchPrivacyFixture()
  for (const token of [clientToken, ghost.token]) {
    const r = await s.http('/search?q=heliotrope', { token })
    assert.equal(r.json.hits.length, 2, 'both conversations hit')
  }
  await s.close()
})

test('around_seq: a private-owned conversation is 404 for an ordinary agent, normal for a client', async () => {
  const { s, kit, clientToken, userId } = await searchPrivacyFixture()
  const anchor = s.db.prepare("SELECT seq FROM events WHERE convo_id='ghost-work' ORDER BY seq DESC LIMIT 1").get().seq
  const agentRead = await s.http(`/convo/ghost-work/messages?around_seq=${anchor}`, { token: kit.token })
  assert.equal(agentRead.status, 404)
  const missing = await s.http(`/convo/never-existed/messages?around_seq=${anchor}`, { token: kit.token })
  assert.deepEqual(agentRead.json, missing.json, 'indistinguishable from a missing conversation')
  const clientRead = await s.http(`/convo/ghost-work/messages?around_seq=${anchor}`, { token: clientToken })
  assert.equal(clientRead.status, 200)
  await s.close()
})

test('around_seq: a private agent reads foreign context like any other agent surface allows', async () => {
  const { s, ghost } = await searchPrivacyFixture()
  const anchor = s.db.prepare("SELECT seq FROM events WHERE convo_id='open-work' ORDER BY seq DESC LIMIT 1").get().seq
  const r = await s.http(`/convo/open-work/messages?around_seq=${anchor}`, { token: ghost.token })
  assert.equal(r.status, 200)
  await s.close()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/privacy.test.js`
Expected: the ordinary-agent search test and the 404 test FAIL.

- [ ] **Step 3: Extend `searchMessages` in `src/search.js`**

Add the option and the SQL predicate:

```js
export function searchMessages(db, userId, { query, limit = 20, convoId = null, excludePrivateOwned = false } = {}) {
```

and in the SQL, after the `sm.user_id = ?` (and optional convo_id) predicates:

```js
    ${excludePrivateOwned
      ? `AND (c.agent_device_id IS NULL OR NOT EXISTS(
            SELECT 1 FROM devices d WHERE d.id=c.agent_device_id AND d.private=1))`
      : ''}
```

(Bind parameters are unchanged — the predicate is self-contained.) Add a comment:

```js
  // excludePrivateOwned (spec: agent visibility & privacy): hits from
  // conversations owned by a private device vanish for ordinary agent
  // callers. NULL-owner (legacy) conversations are never private-owned.
```

- [ ] **Step 4: Wire the callers in `src/http.js`**

`GET /search`: compute the same predicate the roster uses and pass it through —

```js
        const filtered = who.kind === 'agent' && !isPrivateDevice(db, who.deviceId)
        const r = searchMessages(db, who.userId, { query: q, limit, convoId, excludePrivateOwned: filtered })
```

`around_seq` (the `agentForeign` branch from the journal-search plan): before running `messagesAround`, add the ownership check —

```js
        // A conversation owned by a private device does not exist for an
        // ordinary agent's context reads — same 404 as missing/unauthorized.
        if (agentForeign && aroundSeq != null) {
          const owner = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(convoId)?.agent_device_id
          if (owner != null && isPrivateDevice(db, owner) && !isPrivateDevice(db, who.deviceId)) {
            return json(res, 404, { error: 'not_found' })
          }
        }
```

(Note `agentForeign` already implies `who.kind === 'agent'`; the second `isPrivateDevice` call makes the private-caller bypass explicit and cheap — both are PK seeks.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/privacy.test.js && node --test test/search.test.js`
Expected: PASS — including the search plan's own suite (no regressions in unfiltered behavior).

- [ ] **Step 6: Run the full suite**

Run: `npm test 2>&1 | tail -8`
Expected: `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/search.js src/http.js test/privacy.test.js
git commit -m "privacy: search hits and context reads exclude private-owned conversations for ordinary agents"
```

---

### Task 7: Documentation — protocol.md + spec fold-in

**Files:**
- Modify: `docs/protocol.md`
- Modify: `docs/superpowers/specs/2026-08-07-agent-visibility-privacy-design.md`

- [ ] **Step 1: Document in `docs/protocol.md`**

In the file's existing voice, add a "Device privacy" section covering:

- The flag pair and what `private` means (invisible/unreachable to other agents; the user's clients unaffected; `GET /devices` untouched because it is already client-only).
- The hello `private` field: agent-only, boolean, absent-asserts-false, non-boolean → `bad_request` hello error; admin pin precedence and `matron-admin device private on|off|auto`.
- The four enforced surfaces and the one caller rule (ordinary agent callers only; private callers and clients bypass), with the byte-identical `not_found`/404 stance named explicitly.
- What it does NOT do (visibility not privilege; no retroactive hiding of text a private agent wrote in another agent's conversation; a compromised private agent gains nothing from the flag).

- [ ] **Step 2: Fold the locked decisions into the spec**

Add `## Locked decisions (2026-08-08 planning)` to `docs/superpowers/specs/2026-08-07-agent-visibility-privacy-design.md` with decisions 1–6 from this plan's header. Mark open questions 1 and 3 resolved (admin wins via the pin; yes, uniformly — private callers bypass all filtering), and open question 2 explicitly deferred.

- [ ] **Step 3: Verify and commit**

Run: `npm test 2>&1 | tail -8 && git status --short`
Expected: `# fail 0`; only the two docs files modified.

```bash
git add docs/protocol.md docs/superpowers/specs/2026-08-07-agent-visibility-privacy-design.md
git commit -m "docs: device privacy protocol section + locked decisions folded into the spec"
```

---

## Out of scope (do not build here)

- The bridge-side change (read `MATRON_AGENT_PRIVATE`, send `private: true` on hello) — matron-bridge follow-on, one small task, fold into the Phase-3 deploy PR.
- Per-conversation privacy (spec open question 2).
- Any change to write authorization, replay scoping, or room fan-out — a private device's conversations are already unreadable/undeliverable to non-participants by the Phase-2 gates; this plan only closes the discovery and first-contact surfaces.

## Execution note

Of Task 5's two per-op checks, only `agent_join`'s owner check turned out to need moving: gating it in `loadRoom` — the single lookup shared by all five room ops — instead of inside `agent_join` alone closes what would otherwise have been distinct error shapes on the other three ops (`agent_invite_ack`, `agent_invite_answer`, `agent_leave`), which had no privacy check of their own, for a private-owned room versus a nonexistent one. The `loadRoom` gate carries an `isKnownParticipant` exemption (initiator-self, actually-delivered, or joined; a merely parked `awaiting_user` or `denied` row does not exempt). `agent_invite`'s target-device check is unaffected — a different check (is the invite's target private, independent of the room owner) — and remains exactly as specified, per-op, unreplaced. Separately, a Task 8 covering `GET /snapshot` was added after this plan was written, by the search branch's final security review — `/snapshot` predates this feature and needed its own two rules (snippet omitted for every agent caller; private-owned conversations excluded for a filtered agent caller) that this plan's four-surface scope didn't originally cover. See `docs/superpowers/specs/2026-08-07-agent-visibility-privacy-design.md`'s "Implementation deltas" section for the full explanation of both.
