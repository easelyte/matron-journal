# Coordinator redesign — journal (matron-journal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store one Coordinator conversation per user on the journal, announce role changes as `coordinator` events, let a mission be created without joining its creator (`attach: false`), and let a spawn request put its child session on a mission from the start.

**Architecture:** A new `user_settings` table with a pure module (`src/coordinator.js`) and an HTTP module (`src/coordinator-http.js`) mounted beside the missions routes, following the `missions.js` / `missions-http.js` split: the pure module owns state, the HTTP module owns auth and the events. `createMission` gains an `attach` flag. Spawn rows gain `mission_num`: `spawn_request` in `src/ws.js` validates it, `approveSpawn` in `src/spawns.js` re-checks it, sends it in `start`, and joins the child's conversation as soon as the `start` reply names it. Every change adds to the protocol and changes nothing that already exists. Old clients and bridges see the same behaviour as before.

**Tech Stack:** Node ≥ 20 ESM, `better-sqlite3`, `ws`, `node:test` + `node:assert/strict`. Test command: `npm test` (= `node --test --test-timeout=30000 'test/**/*.js'`); a single file: `node --test --test-timeout=30000 test/<file>.test.js`; a single test: add `--test-name-pattern '<regex>'`.

**Spec:** matron-apple `docs/superpowers/specs/2026-09-23-coordinator-redesign-design.md` (§1 Journal, Rollout order, Testing — journal line). The cross-repo contract fixed for all three plans was `/tmp/coord-plan/contract.md`. Its journal half is copied verbatim into Global Constraints below, so this plan stands alone.

## Global Constraints

- Table `user_settings(user_id … PRIMARY KEY REFERENCES users(id), coordinator_convo_id TEXT NULL, updated_at INTEGER NOT NULL)`. `users.id` is `INTEGER` in this schema (`src/db.js:6`), so `user_id` is `INTEGER`. The contract's `TEXT` would never match a foreign key to an integer id.
- `GET /coordinator` (user or agent bearer) → 200 `{"convo_id": string|null}`.
- `PUT /coordinator` body `{"convo_id": string|null}`. USER (client) token only: an agent gets 403 `{"error":"forbidden"}`. Success → 200 `{"convo_id": …}`. A conversation the user does not own → 404 `{"error":"not_found"}`. An unchanged value is a 200 no-op that emits no events.
- On a change: append event type `"coordinator"` with payload `{"role":"assigned"}` into the new conversation and `{"role":"released"}` into the previous one (if any), through `appendAndBroadcast`. The sender is `senderOf(db, who)`, i.e. `user:<name>`, the same as the mission markers.
- The ws `hello_ok` frame (and `GET /snapshot`) gains `coordinator_convo_id` (string|null).
- `POST /missions` accepts an optional `"attach": false` (default `true`). With `false`, the mission row is created with `origin_convo_id = body.convo_id`, and neither `conversations.mission_id` nor any item is touched. Idempotency (`Idempotency-Key` → `idem_key`) still works. The "convo already has a mission → return it" short-circuit does NOT apply when `attach` is `false`. The contract calls the route `POST /missions/create`. The real create route is `POST /missions` (the bridge's `lib/missions-client.js` posts there), so `/missions/create` is added as an alias of the same handler.
- A mission counts as unassigned when `state == "open"` and `conversations == 0`. Clients derive this; the journal adds no new field.
- `agent_spawn_requests.mission_num INTEGER NULL`. `spawn_request` accepts an optional `mission_num`. A missing mission → error code `no_mission`; a closed one → `mission_closed`. The request is rejected and nothing is spawned. When the spawned session's conversation is known, the journal runs `joinMission` for it before anything else is delivered, and it passes `mission_num` in the `start` rpc params.
- Additive only. A client that sends no `attach` and a bridge that sends no `mission_num` see byte-identical behaviour, apart from the new key in `hello_ok` and `/snapshot`.
- No new dependencies. Commit with `git -c user.email=dan@yearbookmachine.com -c user.name="Dan Barker" commit …`. Never run `git config user.*` in this worktree.
- Rollout: the journal deploys first (spec "Rollout order" 1). The bridge and the apps follow and depend on these routes.

## Review Focus

1. **Coordinator on a private box.** An ordinary (non-private) agent must not learn the id of a private-owned conversation through `GET /coordinator`, `hello_ok` or `/snapshot`. It reads `null`; the owner and private agents read the id. Tests: Task 1 (`coordinatorFor`), Task 2 (GET), Task 3 (hello/snapshot).
2. **Forged role change.** An agent `publish` of type `coordinator` must be refused (`bad_request`). Otherwise a bridge could crown itself. The existing `AGENT_PUBLISH_TYPES` allowlist already covers this; the test pins it. Test: Task 2.
3. **Junk `attach`.** `attach: "false"`, `0` or `null` must be 400, not silently read as "attach". Test: Task 4.
4. **Mission closed between the ask and the tap.** Approval must fail with `mission_closed` without sending `start`. Test: Task 6.
5. **Child row created by the journal before its bridge publishes it.** The bridge's own `convo_upsert` must land on that row (title set, owner kept) and must not clear the mission. Test: Task 6.

---

## File Structure

- Create `src/coordinator.js`: pure DB state for the setting (`getCoordinatorConvoId`, `setCoordinatorConvoId`, `coordinatorFor`, `COORDINATOR_EVENT_TYPE`).
- Create `src/coordinator-http.js`: `GET`/`PUT /coordinator` and the role events.
- Modify `src/db.js`: the `user_settings` table in `SCHEMA` and the `agent_spawn_requests.mission_num` migration.
- Modify `src/http.js`: mount the coordinator route and add `coordinator_convo_id` to `/snapshot`.
- Modify `src/ws.js`: `hello_ok` field; `spawn_request` `mission_num` validation, row and card.
- Modify `src/missions.js`, `src/missions-http.js`: `attach` and the `/missions/create` alias.
- Modify `src/spawns.js`: `createSpawnRequest` `missionNum`, the approval re-check, the `start` param, and `joinSpawnMission`.
- Modify `src/consent-items.js`: a mission line on the spawn consent item.
- Modify `src/help.js`, `docs/protocol.md`: document everything above.
- Tests: create `test/coordinator.test.js`; modify `test/missions-http.test.js`, `test/agent-spawn.test.js`, `test/spawns.test.js`, `test/db.test.js`, `test/help.test.js`, and the conformance fixtures under `test/fixtures/conformance/`.

---

### Task 1: `user_settings` table and the pure coordinator module

**Files:**
- Modify: `src/db.js:245-252` (end of `SCHEMA`)
- Create: `src/coordinator.js`
- Test: `test/coordinator.test.js` (new)

**Interfaces:**
- Consumes: `privateOwnedConvo(db, convoId)` from `src/privacy.js:14`.
- Produces:
  - `COORDINATOR_EVENT_TYPE = 'coordinator'`
  - `getCoordinatorConvoId(db, userId) → string|null`
  - `setCoordinatorConvoId(db, userId, convoId: string|null, now = Date.now()) → { previous: string|null, current: string|null, changed: boolean }`, which throws `Error('no_convo')` when `convoId` is non-null and not owned by `userId`
  - `coordinatorFor(db, userId, { excludePrivateOwned = false } = {}) → string|null`

- [ ] **Step 1: Write the failing tests**

Create `test/coordinator.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, pinDevicePrivate } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { getCoordinatorConvoId, setCoordinatorConvoId, coordinatorFor } from '../src/coordinator.js'

async function seedDb() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const pat = await createUser(db, 'pat', 'pw')
  const agent = createAgent(db, dan.id, 'dev-2')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(db, { id: 'c2', ownerUserId: dan.id, title: 'C2', agentDeviceId: agent.deviceId })
  upsertConversation(db, { id: 'p1', ownerUserId: pat.id, title: 'P1' })
  return { db, dan, pat, agent }
}

test('user_settings exists with the contract columns', () => {
  const db = openDb(':memory:')
  const cols = db.prepare('PRAGMA table_info(user_settings)').all().map((c) => c.name)
  assert.deepEqual(cols, ['user_id', 'coordinator_convo_id', 'updated_at'])
})

test('coordinator setting: unset reads null; set, unchanged, switch and clear report previous/current/changed', async () => {
  const { db, dan } = await seedDb()
  assert.equal(getCoordinatorConvoId(db, dan.id), null)
  assert.deepEqual(setCoordinatorConvoId(db, dan.id, 'c1', 1000), { previous: null, current: 'c1', changed: true })
  assert.equal(getCoordinatorConvoId(db, dan.id), 'c1')
  assert.deepEqual(setCoordinatorConvoId(db, dan.id, 'c1', 2000), { previous: 'c1', current: 'c1', changed: false })
  assert.equal(db.prepare('SELECT updated_at FROM user_settings WHERE user_id=?').get(dan.id).updated_at, 1000, 'an unchanged write touches nothing')
  assert.deepEqual(setCoordinatorConvoId(db, dan.id, 'c2', 3000), { previous: 'c1', current: 'c2', changed: true })
  assert.deepEqual(setCoordinatorConvoId(db, dan.id, null, 4000), { previous: 'c2', current: null, changed: true })
  assert.equal(getCoordinatorConvoId(db, dan.id), null)
  assert.deepEqual(setCoordinatorConvoId(db, dan.id, null, 5000), { previous: null, current: null, changed: false })
})

test('coordinator setting: a conversation the user does not own is no_convo and writes nothing', async () => {
  const { db, dan } = await seedDb()
  assert.throws(() => setCoordinatorConvoId(db, dan.id, 'p1'), /no_convo/)
  assert.throws(() => setCoordinatorConvoId(db, dan.id, 'nope'), /no_convo/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_settings').get().n, 0)
})

test('coordinatorFor hides a private-owned coordinator from a filtered caller only', async () => {
  const { db, dan } = await seedDb()
  const priv = createAgent(db, dan.id, 'secret-box')
  pinDevicePrivate(db, priv.deviceId, true)
  upsertConversation(db, { id: 's1', ownerUserId: dan.id, title: 'S1', agentDeviceId: priv.deviceId })
  setCoordinatorConvoId(db, dan.id, 's1')
  assert.equal(coordinatorFor(db, dan.id), 's1')
  assert.equal(coordinatorFor(db, dan.id, { excludePrivateOwned: true }), null)
  setCoordinatorConvoId(db, dan.id, 'c1')
  assert.equal(coordinatorFor(db, dan.id, { excludePrivateOwned: true }), 'c1')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=30000 test/coordinator.test.js`
Expected: FAIL with `Cannot find module '…/src/coordinator.js'`.

- [ ] **Step 3: Add the table**

In `src/db.js`, inside `SCHEMA`, directly after `CREATE INDEX IF NOT EXISTS idx_device_status_user ON device_status(user_id);` (line 251) and before the closing backtick (line 252), add:

```sql
-- Per-user settings (spec 2026-09-23 coordinator redesign §1a). A table, not
-- a users column, so later per-user settings have a home. No row = every
-- setting at its default. coordinator_convo_id is not a foreign key — same
-- stance as conversations.mission_id; ownership is checked on write.
CREATE TABLE IF NOT EXISTS user_settings(
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  coordinator_convo_id TEXT,
  updated_at INTEGER NOT NULL
);
```

`SCHEMA` runs on every `openDb` (`src/db.js:268`), so an existing database gains the table on its next start. No `ALTER` is needed.

- [ ] **Step 4: Write the module**

Create `src/coordinator.js`:

```js
// The user's Coordinator (spec 2026-09-23 coordinator redesign §1a): one
// conversation per user, stored here so every device and every bridge reads
// the same answer. Pure DB state — src/coordinator-http.js owns auth and the
// `coordinator` role events, the same split as missions.js / missions-http.js.
import { privateOwnedConvo } from './privacy.js'

export const COORDINATOR_EVENT_TYPE = 'coordinator'

export function getCoordinatorConvoId(db, userId) {
  return db.prepare('SELECT coordinator_convo_id FROM user_settings WHERE user_id=?').get(userId)?.coordinator_convo_id ?? null
}

// What a given caller may be told. An ordinary (filtered) agent never learns
// the id of a private-owned conversation — the same rule /snapshot and
// /roster apply — so it reads null, exactly as if no Coordinator were set.
export function coordinatorFor(db, userId, { excludePrivateOwned = false } = {}) {
  const id = getCoordinatorConvoId(db, userId)
  if (id && excludePrivateOwned && privateOwnedConvo(db, id)) return null
  return id
}

// One transaction: ownership check, read of the previous value, write. An
// unchanged value writes nothing (the route turns `changed: false` into "no
// events"). `null` clears.
export function setCoordinatorConvoId(db, userId, convoId, now = Date.now()) {
  return db.transaction(() => {
    if (convoId !== null) {
      const owned = db.prepare('SELECT 1 FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
      if (!owned) throw new Error('no_convo')
    }
    const previous = getCoordinatorConvoId(db, userId)
    if (previous === convoId) return { previous, current: convoId, changed: false }
    db.prepare(`INSERT INTO user_settings(user_id, coordinator_convo_id, updated_at) VALUES(?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET coordinator_convo_id=excluded.coordinator_convo_id, updated_at=excluded.updated_at`)
      .run(userId, convoId, now)
    return { previous, current: convoId, changed: true }
  })()
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test --test-timeout=30000 test/coordinator.test.js test/db.test.js`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add src/db.js src/coordinator.js test/coordinator.test.js
git -c user.email=dan@yearbookmachine.com -c user.name="Dan Barker" commit -m "coordinator: user_settings table and the per-user setting"
```

---

### Task 2: `GET`/`PUT /coordinator` and the role events

**Files:**
- Create: `src/coordinator-http.js`
- Modify: `src/http.js:17` (import), `src/http.js:245` (mount)
- Test: `test/coordinator.test.js` (append)

**Interfaces:**
- Consumes: Task 1's `COORDINATOR_EVENT_TYPE`, `coordinatorFor`, `setCoordinatorConvoId`; `appendAndBroadcast(db, hub, {userId, convoId, sender, type, payload})` (`src/journal.js:277`); `CONVO_ID_MAX_CHARS` (`src/journal.js`, already imported by `src/ws.js:5`); `json`, `readBody` (`src/http-body.js`); `senderOf`, `badRequest`, `notFound` (`src/http-who.js`); `filteredAgent` (`src/privacy.js:11`).
- Produces: `handleCoordinatorRoute(ctx: {db, hub}, req, res, url, who) → Promise<boolean>`. The wire contract is in Global Constraints.

- [ ] **Step 1: Write the failing tests**

Append to `test/coordinator.test.js` (add the two imports at the top of the file, next to the others):

```js
import { startTestServer, makeWsClient } from './helpers.js'
```

```js
async function fleet(t) {
  const s = await startTestServer({})
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'c2', ownerUserId: dan.id, title: 'C2', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'p1', ownerUserId: pat.id, title: 'P1' })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  return { s, dan, agent, client: login.json.token }
}
const put = (s, token, convoId) => s.http('/coordinator', { method: 'PUT', token, body: { convo_id: convoId } })
const roleEvents = (s) => s.db.prepare("SELECT convo_id, sender, payload FROM events WHERE type='coordinator' ORDER BY seq").all()
  .map((e) => ({ convo_id: e.convo_id, sender: e.sender, role: JSON.parse(e.payload).role }))

test('GET/PUT /coordinator gates: both kinds read; agent PUT 403; foreign/unknown 404; junk 400; nothing written', async (t) => {
  const { s, agent, client } = await fleet(t)
  assert.deepEqual((await s.http('/coordinator', { token: client })).json, { convo_id: null })
  const asAgentGet = await s.http('/coordinator', { token: agent.token })
  assert.equal(asAgentGet.status, 200); assert.deepEqual(asAgentGet.json, { convo_id: null })
  assert.equal((await s.http('/coordinator')).status, 401)
  const asAgent = await put(s, agent.token, 'c1')
  assert.equal(asAgent.status, 403); assert.deepEqual(asAgent.json, { error: 'forbidden' })
  assert.equal((await put(s, client, 'p1')).status, 404, "another user's conversation is not_found")
  assert.equal((await put(s, client, 'nope')).status, 404)
  assert.equal((await s.http('/coordinator', { method: 'PUT', token: client, body: {} })).status, 400)
  assert.equal((await put(s, client, 42)).status, 400)
  assert.equal((await put(s, client, '')).status, 400)
  assert.equal((await put(s, client, 'x'.repeat(10_000))).status, 400)
  assert.deepEqual(roleEvents(s), [])
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM user_settings').get().n, 0)
})

test('PUT /coordinator: assign emits assigned live to the owning bridge; unchanged emits nothing; switch releases then assigns; clear emits released only', async (t) => {
  const { s, agent, client } = await fleet(t)
  const bridge = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await bridge.waitFor((f) => f.op === 'hello_ok')
  let r = await put(s, client, 'c1')
  assert.equal(r.status, 200); assert.deepEqual(r.json, { convo_id: 'c1' })
  const live = await bridge.waitFor((f) => f.kind === 'journal' && f.type === 'coordinator')
  assert.equal(live.convo_id, 'c1'); assert.deepEqual(live.payload, { role: 'assigned' }); assert.equal(live.sender, 'user:dan')
  bridge.close()
  assert.deepEqual(roleEvents(s), [{ convo_id: 'c1', sender: 'user:dan', role: 'assigned' }])

  r = await put(s, client, 'c1')
  assert.equal(r.status, 200); assert.deepEqual(r.json, { convo_id: 'c1' })
  assert.equal(roleEvents(s).length, 1, 'an unchanged PUT emits no events')

  r = await put(s, client, 'c2')
  assert.deepEqual(r.json, { convo_id: 'c2' })
  assert.deepEqual(roleEvents(s).slice(1), [
    { convo_id: 'c1', sender: 'user:dan', role: 'released' },
    { convo_id: 'c2', sender: 'user:dan', role: 'assigned' },
  ])

  r = await put(s, client, null)
  assert.equal(r.status, 200); assert.deepEqual(r.json, { convo_id: null })
  assert.deepEqual(roleEvents(s).slice(3), [{ convo_id: 'c2', sender: 'user:dan', role: 'released' }], 'clearing emits released only')
  await put(s, client, null)
  assert.equal(roleEvents(s).length, 4, 'clearing twice emits nothing the second time')
  assert.deepEqual((await s.http('/coordinator', { token: agent.token })).json, { convo_id: null })
})

test('a coordinator event cannot be forged through an agent publish', async (t) => {
  const { s, agent } = await fleet(t)
  const bridge = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await bridge.waitFor((f) => f.op === 'hello_ok')
  t.after(() => bridge.close())
  bridge.send({ op: 'publish', convo_id: 'c1', type: 'coordinator', payload: { role: 'assigned' } })
  const err = await bridge.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'bad_request')
  assert.deepEqual(roleEvents(s), [])
})

test('GET /coordinator hides a private-owned coordinator from an ordinary agent, not from a private one', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const priv = createAgent(s.db, dan.id, 'secret-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 's1', ownerUserId: dan.id, title: 'S1', agentDeviceId: priv.deviceId })
  assert.equal((await put(s, client, 's1')).status, 200)
  assert.deepEqual((await s.http('/coordinator', { token: client })).json, { convo_id: 's1' })
  assert.deepEqual((await s.http('/coordinator', { token: priv.token })).json, { convo_id: 's1' })
  assert.deepEqual((await s.http('/coordinator', { token: agent.token })).json, { convo_id: null })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=30000 test/coordinator.test.js`
Expected: the four new tests FAIL (`/coordinator` answers 404 or falls through, not 200/403). The forgery test may already pass, because `AGENT_PUBLISH_TYPES` (`src/ws.js:26-29`) never listed `coordinator`. That is expected: it pins existing behaviour.

- [ ] **Step 3: Write the HTTP module**

Create `src/coordinator-http.js`:

```js
// HTTP surface of the Coordinator setting (spec 2026-09-23 coordinator
// redesign §1a). Either device kind may read; only the user (a client
// token) may choose. A change is announced into both conversations through
// the ordinary append+broadcast path, so the owning bridge and every open
// app hear it live and replay it later.
import { appendAndBroadcast, CONVO_ID_MAX_CHARS } from './journal.js'
import { json, readBody } from './http-body.js'
import { senderOf, badRequest, notFound } from './http-who.js'
import { filteredAgent } from './privacy.js'
import { COORDINATOR_EVENT_TYPE, coordinatorFor, setCoordinatorConvoId } from './coordinator.js'

// Written AFTER the setting committed, never inside it — same stance as
// missions-http.js's emitMissionMarker: the setting is the truth; a failed
// announcement is logged, not rolled back.
function emitRole({ db, hub }, who, convoId, role) {
  try {
    appendAndBroadcast(db, hub, { userId: who.userId, convoId, sender: senderOf(db, who), type: COORDINATOR_EVENT_TYPE, payload: { role } })
  } catch (err) {
    console.error('coordinator: role event append failed (setting already committed)', err)
  }
}

export async function handleCoordinatorRoute(ctx, req, res, url, who) {
  if (url.pathname !== '/coordinator') return false
  const { db } = ctx
  if (req.method === 'GET') {
    json(res, 200, { convo_id: coordinatorFor(db, who.userId, { excludePrivateOwned: filteredAgent(db, who) }) })
    return true
  }
  if (req.method !== 'PUT') return false
  if (who.kind !== 'client') { json(res, 403, { error: 'forbidden' }); return true }
  const body = await readBody(req)
  if (!('convo_id' in body)) return badRequest(res)
  const convoId = body.convo_id
  if (convoId !== null && (typeof convoId !== 'string' || !convoId || convoId.length > CONVO_ID_MAX_CHARS)) return badRequest(res)
  let out
  try {
    out = setCoordinatorConvoId(db, who.userId, convoId)
  } catch (err) {
    if (err.message === 'no_convo') return notFound(res)
    throw err
  }
  if (out.changed) {
    if (out.previous) emitRole(ctx, who, out.previous, 'released')
    if (out.current) emitRole(ctx, who, out.current, 'assigned')
  }
  json(res, 200, { convo_id: out.current })
  return true
}
```

`readBody` (`src/http-body.js:14`) always resolves a plain object: `{}` for an empty body, and it rejects non-objects with a 400. So `'convo_id' in body` is safe.

- [ ] **Step 4: Mount it**

In `src/http.js`, after the missions import (line 17) add:

```js
import { handleCoordinatorRoute } from './coordinator-http.js'
```

After `if (await handleMissionsRoute({ db, hub, pushPipeline, waker }, req, res, url, who)) return` (line 245) add:

```js
      if (await handleCoordinatorRoute({ db, hub }, req, res, url, who)) return
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test --test-timeout=30000 test/coordinator.test.js`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add src/coordinator-http.js src/http.js test/coordinator.test.js
git -c user.email=dan@yearbookmachine.com -c user.name="Dan Barker" commit -m "coordinator: GET/PUT /coordinator with assigned/released events"
```

---

### Task 3: `coordinator_convo_id` on `hello_ok` and `/snapshot`

**Files:**
- Modify: `src/ws.js:1-11` (import), `src/ws.js:410` (`hello_ok`)
- Modify: `src/http.js:262-263` (`/snapshot`)
- Modify: `test/fixtures/conformance/*.json` (22 `hello_ok` expectations, 6 `/snapshot` 200 bodies)
- Test: `test/coordinator.test.js` (append)

**Interfaces:**
- Consumes: Task 1's `coordinatorFor`; `isPrivateDevice` (already imported in `src/ws.js:4` and `src/http.js`).
- Produces: `hello_ok {seq, device_id, name, coordinator_convo_id}`; `/snapshot {conversations, agents, seq, coordinator_convo_id}`.

- [ ] **Step 1: Write the failing test**

Append to `test/coordinator.test.js`:

```js
const helloOf = async (s, token) => {
  const c = await makeWsClient(s.base, { token, cursor: null })
  const hello = await c.waitFor((f) => f.op === 'hello_ok')
  c.close()
  return hello
}

test('hello_ok and /snapshot carry coordinator_convo_id: null until set, then the id; sieved for an ordinary agent', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  assert.equal((await helloOf(s, client)).coordinator_convo_id, null)
  const snap0 = (await s.http('/snapshot', { token: client })).json
  assert.ok('coordinator_convo_id' in snap0); assert.equal(snap0.coordinator_convo_id, null)
  await put(s, client, 'c1')
  assert.equal((await helloOf(s, client)).coordinator_convo_id, 'c1')
  assert.equal((await helloOf(s, agent.token)).coordinator_convo_id, 'c1')
  assert.equal((await s.http('/snapshot', { token: client })).json.coordinator_convo_id, 'c1')

  const priv = createAgent(s.db, dan.id, 'secret-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 's1', ownerUserId: dan.id, title: 'S1', agentDeviceId: priv.deviceId })
  await put(s, client, 's1')
  assert.equal((await helloOf(s, agent.token)).coordinator_convo_id, null)
  assert.equal((await s.http('/snapshot', { token: agent.token })).json.coordinator_convo_id, null)
  assert.equal((await helloOf(s, priv.token)).coordinator_convo_id, 's1')
  assert.equal((await helloOf(s, client)).coordinator_convo_id, 's1')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=30000 --test-name-pattern 'hello_ok and /snapshot' test/coordinator.test.js`
Expected: FAIL (`undefined !== null` on `hello0.coordinator_convo_id`, then `'coordinator_convo_id' in snap0` false).

- [ ] **Step 3: Add the field to `hello_ok`**

In `src/ws.js`, add to the imports (after line 11):

```js
import { coordinatorFor } from './coordinator.js'
```

Replace line 410:

```js
          ws.send(JSON.stringify({ kind: 'control', op: 'hello_ok', seq: headSeq, device_id: who.deviceId, name: who.name }))
```

with:

```js
          // coordinator_convo_id (spec 2026-09-23 coordinator redesign §1a):
          // the user's Coordinator, so an app knows it on connect without a
          // separate GET /coordinator. Sieved exactly like that route — an
          // ordinary agent never learns a private-owned conversation's id.
          // applyBridgePrivate ran above, so the flag is already current.
          const coordinator = coordinatorFor(db, who.userId, { excludePrivateOwned: who.kind === 'agent' && !isPrivateDevice(db, who.deviceId) })
          ws.send(JSON.stringify({ kind: 'control', op: 'hello_ok', seq: headSeq, device_id: who.deviceId, name: who.name, coordinator_convo_id: coordinator }))
```

- [ ] **Step 4: Add the field to `/snapshot`**

In `src/http.js`, add `coordinatorFor` to the new coordinator import from Task 2:

```js
import { coordinatorFor } from './coordinator.js'
```

Replace line 263:

```js
        return json(res, 200, snapshot(db, who.userId, { omitSnippet: who.kind === 'agent', excludePrivateOwned: filtered }))
```

with:

```js
        return json(res, 200, {
          ...snapshot(db, who.userId, { omitSnippet: who.kind === 'agent', excludePrivateOwned: filtered }),
          coordinator_convo_id: coordinatorFor(db, who.userId, { excludePrivateOwned: filtered }),
        })
```

- [ ] **Step 5: Run the new test, then the conformance suite to see it break**

Run: `node --test --test-timeout=30000 test/coordinator.test.js test/conformance.test.js`
Expected: `coordinator.test.js` PASS. `conformance.test.js` FAILS on every fixture that expects `hello_ok` or a 200 `/snapshot` body. The matcher (`test/conformance.test.js:34`) requires exact key sets, so the new key is "extra".

- [ ] **Step 6: Update the fixtures**

```bash
cd /Users/danbarker/Dev/matron-journal-coordinator
perl -pi -e 's/"op": "hello_ok", /"op": "hello_ok", "coordinator_convo_id": null, /g' test/fixtures/conformance/*.json
perl -0pi -e 's/("path": "\/snapshot"[^\n]*\n\s*"expect": \{ "status": 200, "body": \{)/$1 "coordinator_convo_id": null,/g' test/fixtures/conformance/*.json
grep -o '"coordinator_convo_id": null' test/fixtures/conformance/*.json | wc -l
```

Expected count: `28` (22 `hello_ok` + 6 `/snapshot`; `12_revocation.json`'s `/snapshot` is a 401 and is correctly left alone). Every file must still parse:

```bash
for f in test/fixtures/conformance/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || echo "BROKEN $f"; done
```

Expected: no `BROKEN` lines.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS. Check the summary line reports `fail 0`, rather than grepping for PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ws.js src/http.js test/coordinator.test.js test/fixtures/conformance
git -c user.email=dan@yearbookmachine.com -c user.name="Dan Barker" commit -m "coordinator: coordinator_convo_id on hello_ok and /snapshot"
```

---

### Task 4: Unassigned missions: `attach: false`

**Files:**
- Modify: `src/missions.js:124-148` (`createMission`)
- Modify: `src/missions-http.js:68-101` (`handleCreate`), `src/missions-http.js:264-269` (route alias)
- Test: `test/missions-http.test.js` (append; reuses its `fleet`, `start` and `item` helpers at lines 10-24)

**Interfaces:**
- Consumes: the existing `createMission`, `attachConversation` and `getMission` in `src/missions.js`.
- Produces: `createMission(db, { …, attach = true })` with the same return shape `{ mission, duplicate, existing }`. HTTP: `POST /missions` and `POST /missions/create` accept `attach?: boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `test/missions-http.test.js`:

```js
test('POST /missions attach:false: a new unassigned mission even when the convo already has one; convo and items untouched; replay; /missions/create alias; default still attaches', async (t) => {
  const { s, agent, client } = await fleet(t)
  const a = (await start(s, agent.token, {})).json.mission
  const t2 = (await item(s, agent.token, { convo_id: 'c2', kind: 'task', title: 'T2' })).json.item
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')

  const b = await start(s, agent.token, { title: 'Unassigned B', attach: false }, { 'idempotency-key': 'u1' })
  assert.equal(b.status, 201); assert.equal(b.json.existing, undefined)
  assert.notEqual(b.json.mission.id, a.id)
  assert.equal(b.json.mission.origin_convo_id, 'c1'); assert.equal(b.json.mission.state, 'open'); assert.equal(b.json.mission.conversations, 0)
  assert.equal(s.db.prepare('SELECT mission_id FROM conversations WHERE id=?').get('c1').mission_id, a.id, 'c1 keeps its mission')
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.payload.num === b.json.mission.num)
  assert.equal(marker.convo_id, 'c1'); assert.equal(marker.payload.action, 'created')
  ws.close()

  const c = await s.http('/missions', { method: 'POST', token: agent.token, body: { title: 'C', convo_id: 'c2', attach: false } })
  assert.equal(c.status, 201)
  assert.equal(s.db.prepare('SELECT mission_id FROM conversations WHERE id=?').get('c2').mission_id, null, 'attach:false never attaches')
  assert.equal((await s.http(`/items/${t2.id}`, { token: client })).json.item.mission_id, null, 'attach:false never moves items')

  const replay = await start(s, agent.token, { title: 'Unassigned B', attach: false }, { 'idempotency-key': 'u1' })
  assert.equal(replay.status, 200); assert.equal(replay.json.mission.id, b.json.mission.id)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='mission' AND json_extract(payload,'$.num')=?").get(b.json.mission.num).n, 1, 'no second marker on replay')

  const listed = (await s.http('/missions?state=open', { token: client })).json.missions.find((m) => m.id === b.json.mission.id)
  assert.equal(listed.conversations, 0, 'unassigned = open with no conversations')

  const alias = await s.http('/missions/create', { method: 'POST', token: agent.token, body: { title: 'D', convo_id: 'c1', attach: false } })
  assert.equal(alias.status, 201); assert.equal(alias.json.mission.conversations, 0)
  assert.equal((await s.http('/missions/create', { token: agent.token })).status, 404, 'GET on the alias is not a mission lookup')

  const e = await s.http('/missions', { method: 'POST', token: agent.token, body: { title: 'E', convo_id: 'c2' } })
  assert.equal(e.status, 201)
  assert.equal(s.db.prepare('SELECT mission_id FROM conversations WHERE id=?').get('c2').mission_id, e.json.mission.id)
  assert.equal((await s.http(`/items/${t2.id}`, { token: client })).json.item.mission_id, e.json.mission.id)
})

test('POST /missions: a non-boolean attach is 400 and writes nothing', async (t) => {
  const { s, agent } = await fleet(t)
  for (const attach of ['false', 0, null]) {
    const r = await start(s, agent.token, { attach })
    assert.equal(r.status, 400, `attach: ${JSON.stringify(attach)}`)
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM missions').get().n, 0)
  assert.equal(s.db.prepare('SELECT mission_id FROM conversations WHERE id=?').get('c1').mission_id, null)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=30000 --test-name-pattern 'attach' test/missions-http.test.js`
Expected: FAIL. `b.status` is 200 with `existing: true` (the short-circuit), and `attach: 'false'` is accepted with 201.

- [ ] **Step 3: Add `attach` to `createMission`**

In `src/missions.js`, change the signature at line 124:

```js
export function createMission(db, { userId, deviceId, createdBy, convoId, title, body = '', idemKey = null, excludePrivateOwned = false, attach = true }) {
```

Replace line 132:

```js
    if (convo.mission_id) return { mission: getMission(db, userId, convo.mission_id, { excludePrivateOwned }), duplicate: false, existing: true }
```

with:

```js
    // attach:false (spec 2026-09-23 coordinator redesign §1b) creates an
    // UNASSIGNED mission: the conversation is only its provenance
    // (origin_convo_id), so whether it already belongs to a mission is
    // irrelevant — no short-circuit, and nothing below attaches it.
    if (attach && convo.mission_id) return { mission: getMission(db, userId, convo.mission_id, { excludePrivateOwned }), duplicate: false, existing: true }
```

Replace line 146:

```js
    attachConversation(db, userId, convoId, id, ts)
```

with:

```js
    if (attach) attachConversation(db, userId, convoId, id, ts)
```

The idem-key dedupe (lines 126-129 and 139-144) runs before either branch, so replays are unchanged.

- [ ] **Step 4: Validate and pass `attach` in the route, and add the alias**

In `src/missions-http.js` `handleCreate`, after `if (!v.ok) return badRequest(res)` (line 72) add:

```js
  // Optional, default true (today's behaviour). Anything but a boolean is a
  // bad ask, never coerced — `"false"` must not quietly attach.
  if (body.attach !== undefined && typeof body.attach !== 'boolean') return badRequest(res)
```

In the `createMission(db, { … })` call (lines 78-81), add `attach: body.attach !== false,` after `idemKey,` so the object reads:

```js
    out = createMission(db, {
      userId: who.userId, deviceId: who.deviceId, createdBy: byOf(who), convoId: body.convo_id,
      title: v.value.title, body: v.value.body ?? '', idemKey, attach: body.attach !== false,
      excludePrivateOwned: filteredAgent(db, who),
    })
```

In `handleMissionsRoute`, immediately before `if (path !== '/missions' && !path.startsWith('/missions/')) return false` (line 264), add:

```js
  // The cross-repo contract (coordinator redesign) names the create route
  // POST /missions/create; the real one is POST /missions. Same handler.
  // No mission id is ever 'create' (ids are ms_… or numbers), so this can
  // never shadow a /missions/:id lookup. Any other method falls through to
  // the ordinary 404.
  if (path === '/missions/create') return req.method === 'POST' ? handleCreate(ctx, req, res, who) : false
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test --test-timeout=30000 test/missions-http.test.js test/missions.test.js`
Expected: PASS (all tests, old and new).

- [ ] **Step 6: Commit**

```bash
git add src/missions.js src/missions-http.js test/missions-http.test.js
git -c user.email=dan@yearbookmachine.com -c user.name="Dan Barker" commit -m "missions: attach:false creates an unassigned mission; /missions/create alias"
```

---

### Task 5: `spawn_request` accepts `mission_num`

**Files:**
- Modify: `src/db.js:500-505` (spawn column migrations)
- Modify: `src/spawns.js:28-35` (`createSpawnRequest`)
- Modify: `src/ws.js:1-11` (import), `src/ws.js:905-906` (validation), `src/ws.js:927-931` (row), `src/ws.js:948-963` (card)
- Modify: `src/consent-items.js:57` (item body line)
- Test: `test/agent-spawn.test.js` (append), `test/db.test.js:505-512`, `test/consent-items.test.js` (append)

**Interfaces:**
- Consumes: `getMission(db, userId, idOrNum, { excludePrivateOwned })` (`src/missions.js:96`); `isPrivateDevice` (`src/ws.js:4`). The tests create missions with Task 4's `attach: false`.
- Produces: `createSpawnRequest(db, { …, missionNum = null })`; row column `mission_num`; card payload `mission_num` + `mission_title` (both omitted when absent); consent item body line `- **Joins mission #N** — <title>` (title dropped when empty); `spawn_request` error codes `no_mission` and `mission_closed`.

- [ ] **Step 1: Write the failing tests**

Append to `test/agent-spawn.test.js`:

```js
// A mission parked on the parent's own conversation WITHOUT joining it —
// the shape the Coordinator's mission_create produces (attach:false).
async function missionFor(s, token, { close = false } = {}) {
  const r = await s.http('/missions', { method: 'POST', token, body: { title: 'Spawned work', convo_id: 'parent-convo', attach: false } })
  assert.equal(r.status, 201)
  if (close) assert.equal((await s.http(`/missions/${r.json.mission.id}/close`, { method: 'POST', token, body: { summary: 'done' } })).status, 200)
  return r.json.mission
}
const isError = (f) => f.kind === 'control' && f.op === 'error'

test('spawn_request with mission_num: unknown → no_mission, closed → mission_closed, junk → bad_request; nothing parked, no card', async (t) => {
  const { s, parentDev, targetDev, parent, client } = await spawnFleet(t)
  const closed = await missionFor(s, parentDev.token, { close: true })
  const ask = (rid, missionNum) => parent.send({
    op: 'spawn_request', request_id: rid, from_convo_id: 'parent-convo',
    target_device_id: targetDev.deviceId, workdir: '/w', task: 'x', mission_num: missionNum,
  })
  ask('q1', 999)
  assert.equal((await parent.waitFor(isError)).code, 'no_mission')
  parent.frames.length = 0
  ask('q2', closed.num)
  assert.equal((await parent.waitFor(isError)).code, 'mission_closed')
  for (const junk of ['one', 0, 1.5]) {
    parent.frames.length = 0
    ask(`q-${junk}`, junk)
    assert.equal((await parent.waitFor(isError)).code, 'bad_request', `mission_num ${JSON.stringify(junk)}`)
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM agent_spawn_requests').get().c, 0)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(client.frames.find(isSpawnCard), undefined)
})

test('spawn_request with an open mission parks mission_num on the row, the card and the consent item; without one the card has no key', async (t) => {
  const { s, parentDev, targetDev, parent, client } = await spawnFleet(t)
  parent.send({ op: 'spawn_request', request_id: 'q0', from_convo_id: 'parent-convo', target_device_id: targetDev.deviceId, workdir: '/w', task: 'plain' })
  await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  const plainCard = await client.waitFor(isSpawnCard)
  assert.ok(!('mission_num' in plainCard.payload))
  parent.frames.length = 0; client.frames.length = 0

  const m = await missionFor(s, parentDev.token)
  parent.send({ op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo', target_device_id: targetDev.deviceId, workdir: '/w', task: 'mission work', mission_num: m.num })
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  assert.equal(getSpawn(s.db, ack.spawn_id).mission_num, m.num)
  const card = await client.waitFor(isSpawnCard)
  assert.equal(card.payload.mission_num, m.num)
  assert.equal(card.payload.mission_title, 'Spawned work')
  const body = s.db.prepare('SELECT i.body FROM items i JOIN agent_spawn_requests r ON r.item_id = i.id WHERE r.id=?').get(ack.spawn_id).body
  assert.ok(body.includes(`- **Joins mission #${m.num}** — Spawned work`), body)
})
```

In `test/db.test.js`, in the test `openDb adds agent_spawn_requests.link defaulting to 1 for pre-existing rows`, after `assert.ok(cols.includes('child_short'), …)` (line 511) add:

```js
  assert.ok(cols.includes('mission_num'), 'mission_num column missing after migration')
  assert.equal(db.prepare('SELECT mission_num FROM agent_spawn_requests WHERE id=?').get('old').mission_num, null)
```

Append to `test/consent-items.test.js` (it already defines the `card` fixture at lines 7-10 and imports `spawnConsentItemFields`):

```js
test('spawnConsentItemFields: a spawn onto a mission says "joins mission #N" with its title; without one the line is absent', () => {
  const plain = spawnConsentItemFields(card)
  assert.ok(!/joins mission/i.test(plain.body), 'no mission line without mission_num')
  const withMission = spawnConsentItemFields({ ...card, mission_num: 42, mission_title: 'Ship the *panel*' })
  // Title passed through plain(): markdown/control characters stripped, same as every other peer string here.
  assert.ok(withMission.body.includes('- **Joins mission #42** — Ship the panel'), withMission.body)
  const untitled = spawnConsentItemFields({ ...card, mission_num: 42 })
  assert.ok(untitled.body.includes('- **Joins mission #42**\n'), 'no dangling dash when the title is absent')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=30000 --test-name-pattern 'mission_num|link defaulting' test/agent-spawn.test.js test/db.test.js test/consent-items.test.js`
Expected: FAIL. The consent-item test fails (no mission line). The unknown mission is parked (a `pending` ack, not an error), and `mission_num column missing after migration`.

- [ ] **Step 3: Migrate the column**

In `src/db.js`, after the `item_id` block (lines 503-505) add:

```js
  // Spawning onto a mission (spec 2026-09-23 coordinator redesign §1c): the
  // per-user mission #num the child joins as soon as its conversation is
  // known. NULL = no mission (every row predating the column). A number,
  // not an id — it is what the asking agent named and what the card shows.
  if (!spawnCols.some((c) => c.name === 'mission_num')) {
    db.exec('ALTER TABLE agent_spawn_requests ADD COLUMN mission_num INTEGER')
  }
```

- [ ] **Step 4: Store it on the row**

In `src/spawns.js`, replace `createSpawnRequest` (lines 28-35) with:

```js
export function createSpawnRequest(db, { id, userId, fromDeviceId, fromConvoId, targetDeviceId, workdir, task, topic = '', model = '', link = false, missionNum = null, now = Date.now() }) {
  db.prepare(`
    INSERT INTO agent_spawn_requests(id, user_id, from_device_id, from_convo_id, target_device_id,
      workdir, task, topic, model, link, mission_num, state, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'awaiting_user',?)
  `).run(id, userId, fromDeviceId, fromConvoId, targetDeviceId, workdir, task, topic, model, link ? 1 : 0, missionNum, now)
  return { id }
}
```

- [ ] **Step 5: Validate in `spawn_request`**

In `src/ws.js`, add to the imports:

```js
import { getMission } from './missions.js'
```

Directly after the `fromConvo` check that ends `|| fromConvo.parent_convo_id != null) return fail('not_found')` (line 905), and before the wake comment (line 906), insert:

```js
        // Optional mission the child joins as soon as it exists (spec
        // 2026-09-23 coordinator redesign §1c). Checked BEFORE the wake below
        // so a doomed ask never starts a box, and before the card so the
        // user is never asked about it. Resolved through the visibility sieve
        // of BOTH ends: a mission the asker cannot see is no oracle
        // (no_mission, same as unknown), and one the child could never read
        // must not become its mission either. Unfiltered only when both are
        // private devices.
        let missionNum = null
        let missionTitle = ''
        if (msg.mission_num != null) {
          if (!Number.isInteger(msg.mission_num) || msg.mission_num < 1) return fail('bad_request', 'bad mission_num')
          const excludePrivateOwned = !isPrivateDevice(db, conn.deviceId) || !isPrivateDevice(db, msg.target_device_id)
          const mission = getMission(db, conn.userId, msg.mission_num, { excludePrivateOwned })
          if (!mission) return fail('no_mission', `mission #${msg.mission_num} not found`)
          if (mission.state !== 'open') return fail('mission_closed', `mission #${msg.mission_num} is closed`)
          missionNum = mission.num
          // Shown on the client-only card (agents never receive it), so the
          // user sees the mission they are sending the child to. Sieved like
          // from_convo_title.
          missionTitle = sanitizePeerText(mission.title, CARD_TITLE_MAX_CHARS)
        }
```

In the `createSpawnRequest(db, { … })` call (lines 927-931) add `missionNum,` after `workdir, task, topic, model, link,`:

```js
        createSpawnRequest(db, {
          id: spawnId, userId: conn.userId, fromDeviceId: conn.deviceId,
          fromConvoId: msg.from_convo_id, targetDeviceId: msg.target_device_id,
          workdir, task, topic, model, link, missionNum,
        })
```

In `cardPayload`, after `...(link ? { link: true } : {}),` (line 962) add:

```js
          // Same omit-when-absent stance: the card says "joins mission #N"
          // only for an ask that named one.
          ...(missionNum ? { mission_num: missionNum } : {}),
          ...(missionNum && missionTitle ? { mission_title: missionTitle } : {}),
```

- [ ] **Step 6: Name the mission on the consent item**

In `src/consent-items.js` `spawnConsentItemFields`, after the model line (line 57) add:

```js
    // "joins mission #N" (coordinator redesign §2d): the user approves the
    // child AND where it lands. The title rides the card as mission_title —
    // the mission was resolved through the asker's sieve, and this item
    // is the user's, so it may be shown; plain() strips markdown like every
    // other peer string in this body.
    ...(card.mission_num
      ? [`- **Joins mission #${Number(card.mission_num)}**${card.mission_title ? ` — ${plain(card.mission_title)}` : ''}`]
      : []),
```

`sanitizePeerText` and `CARD_TITLE_MAX_CHARS` are already in scope in `src/ws.js` (used for `from_convo_title`, line 951).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test --test-timeout=30000 test/agent-spawn.test.js test/db.test.js test/consent-items.test.js test/spawns.test.js`
Expected: PASS (all tests).

- [ ] **Step 8: Commit**

```bash
git add src/db.js src/spawns.js src/ws.js src/consent-items.js test/agent-spawn.test.js test/db.test.js test/consent-items.test.js
git -c user.email=dan@yearbookmachine.com -c user.name="Dan Barker" commit -m "spawns: spawn_request takes mission_num (no_mission / mission_closed)"
```

---

### Task 6: Approval re-checks the mission, sends it in `start`, and joins the child

**Files:**
- Modify: `src/spawns.js:9-15` (imports), `src/spawns.js:293` (re-check), `src/spawns.js:350-352` (`start` params), `src/spawns.js:368-375` (join), plus a new exported `joinSpawnMission`
- Test: `test/agent-spawn.test.js` (append; uses Task 5's `missionFor` and `isError`), `test/spawns.test.js:322-325`

**Interfaces:**
- Consumes: `getMission`, `joinMission(db, { userId, missionId, convoId, excludePrivateOwned })` (`src/missions.js:96`, `:208`); `MISSION_EVENT_TYPE`, `missionMarkerPayload({ mission, action, by, withTitle })` (`src/missions-marker.js`); `markerTitleAllowed(db, originConvoId, targetConvoId)` (`src/privacy.js`); `upsertConversation`, `appendAndBroadcast` (already imported, `src/spawns.js:10`); `isPrivateDevice` (already imported, `src/spawns.js:13`). Row column `mission_num` from Task 5.
- Produces: `joinSpawnMission(db, hub, row, childConvoId) → mission|null` (exported); `start` rpc params gain `mission_num` (omitted when absent); an approval of a mission that is now closed or gone fails with `error_code` `mission_closed` or `no_mission`.

- [ ] **Step 1: Write the failing tests**

Append to `test/agent-spawn.test.js`:

```js
async function missionSpawn(t) {
  const fleet = await spawnFleet(t)
  const { s, parentDev, targetDev, parent, client } = fleet
  const mission = await missionFor(s, parentDev.token)
  parent.send({
    op: 'spawn_request', request_id: 'qm', from_convo_id: 'parent-convo',
    target_device_id: targetDev.deviceId, workdir: '/w', task: 'do the mission work', mission_num: mission.num,
  })
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  await client.waitFor(isSpawnCard)
  parent.frames.length = 0
  client.frames.length = 0
  return { ...fleet, mission, spawnId: ack.spawn_id }
}
const approve = (s, clientToken, spawnId) => s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })

test('approve with a mission: start carries mission_num; the child is a mission member before the parent hears started; its bridge upsert lands on the row', async (t) => {
  const { s, targetDev, clientToken, parent, target, client, spawnId, mission } = await missionSpawn(t)
  const bridgeTurn = target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start').then((req) => {
    assert.equal(req.request.params.mission_num, mission.num)
    target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child-m1' } })
  })
  assert.equal((await approve(s, clientToken, spawnId)).status, 200)
  await bridgeTurn
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  assert.equal(out.outcome, 'started'); assert.equal(out.child_convo_id, 'child-m1')

  const child = s.db.prepare('SELECT mission_id, agent_device_id FROM conversations WHERE id=?').get('child-m1')
  assert.equal(child.mission_id, mission.id)
  assert.equal(child.agent_device_id, targetDev.deviceId, 'the pre-created row belongs to the target box')
  const seq = (type, convo) => s.db.prepare('SELECT seq FROM events WHERE type=? AND convo_id=?').get(type, convo).seq
  assert.ok(seq('mission', 'child-m1') < seq('spawn_outcome', 'parent-convo'), 'joined before the outcome was journaled')
  const joined = await target.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.convo_id === 'child-m1')
  assert.equal(joined.payload.action, 'joined'); assert.equal(joined.payload.num, mission.num)
  const detail = await s.http(`/missions/${mission.num}`, { token: clientToken })
  assert.deepEqual(detail.json.conversations.map((c) => c.id), ['child-m1'])
  assert.equal(detail.json.mission.conversations, 1, 'no longer unassigned')

  // The child's bridge publishes its conversation on its own schedule —
  // after the journal already created the row. It must land in place.
  target.send({ op: 'convo_upsert', convo_id: 'child-m1', title: 'child session', session_state: 'running' })
  const meta = await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta' && f.convo_id === 'child-m1')
  assert.equal(meta.payload.title, 'child session')
  assert.equal(s.db.prepare('SELECT mission_id FROM conversations WHERE id=?').get('child-m1').mission_id, mission.id)
})

test('approve after the mission closed: failed with mission_closed, no start rpc, nothing joined', async (t) => {
  const { s, clientToken, parent, target, spawnId, mission } = await missionSpawn(t)
  assert.equal((await s.http(`/missions/${mission.id}/close`, { method: 'POST', token: clientToken, body: { summary: 'called off' } })).status, 200)
  target.frames.length = 0
  assert.equal((await approve(s, clientToken, spawnId)).status, 200)
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  assert.equal(out.outcome, 'failed'); assert.equal(out.error_code, 'mission_closed')
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(target.frames.find((f) => f.kind === 'rpc' && f.request?.method === 'start'), undefined, 'nothing spawned')
  assert.equal(getSpawn(s.db, spawnId).state, 'failed')
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE mission_id=?').get(mission.id).n, 0)
})
```

In `test/spawns.test.js`, in `approveSpawn on a detached row: …`, after `assert.ok(!('room_id' in params[0]), …)` (line 323) add:

```js
  assert.ok(!('mission_num' in params[0]), 'a spawn that named no mission sends none')
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=30000 --test-name-pattern 'approve with a mission|approve after the mission closed|detached row' test/agent-spawn.test.js test/spawns.test.js`
Expected: FAIL. `params.mission_num` is `undefined`, and the closed-mission approval reports `started`.

- [ ] **Step 3: Imports**

In `src/spawns.js`, after line 15 add:

```js
import { getMission, joinMission } from './missions.js'
import { MISSION_EVENT_TYPE, missionMarkerPayload } from './missions-marker.js'
import { markerTitleAllowed } from './privacy.js'
```

- [ ] **Step 4: Add `joinSpawnMission`**

In `src/spawns.js`, directly above the comment block that introduces `approveSpawn` (line 223, `// Spec step 4/5 — everything after the user's tap.`), add:

```js
// Spec 2026-09-23 coordinator redesign §1c: a spawn that named a mission
// puts its child on it the moment the child's conversation id is known —
// the `start` reply — and before the parent hears `started`. The target
// bridge injects the opening turn just before it answers `start`, so the
// journal cannot order the join ahead of that write. What it can guarantee:
// the join commits synchronously on the reply, ahead of any journal traffic
// the child produces, and the bridge already knows the number from `start`'s
// mission_num param. The child's row may not exist yet — its bridge
// publishes convo_upsert on its own schedule — so it is created here, owned
// by the target box. The bridge's later upsert then updates it in place
// (same owner, so no takeover gate trips). Visibility is judged from the
// CHILD's side, the rule inheritableMission (journal.js) applies: an
// ordinary box is never handed a mission it cannot read. Best-effort: the
// session is already running, so a failure (the mission closed in the last
// few milliseconds, the 200-conversation cap) is logged and the spawn still
// reports started.
export function joinSpawnMission(db, hub, row, childConvoId) {
  if (!row.mission_num) return null
  try {
    const excludePrivateOwned = !isPrivateDevice(db, row.target_device_id)
    const mission = getMission(db, row.user_id, row.mission_num, { excludePrivateOwned })
    if (!mission || mission.state !== 'open') {
      console.error(`approveSpawn: mission #${row.mission_num} not joinable at start (${mission ? mission.state : 'not visible'}) — child runs unattached`)
      return null
    }
    const exists = db.prepare('SELECT 1 FROM conversations WHERE id=? AND owner_user_id=?').get(childConvoId, row.user_id)
    if (!exists) upsertConversation(db, { id: childConvoId, ownerUserId: row.user_id, sessionState: 'running', agentDeviceId: row.target_device_id })
    const joined = joinMission(db, { userId: row.user_id, missionId: mission.id, convoId: childConvoId, excludePrivateOwned })
    appendAndBroadcast(db, hub, {
      userId: row.user_id, convoId: childConvoId, sender: 'journal', type: MISSION_EVENT_TYPE,
      payload: missionMarkerPayload({ mission: joined, action: 'joined', by: 'agent', withTitle: markerTitleAllowed(db, joined.origin_convo_id, childConvoId) }),
    })
    return joined
  } catch (err) {
    console.error('approveSpawn: mission join failed (session already started)', err)
    return null
  }
}
```

- [ ] **Step 5: Re-check at approval, send it in `start`, join on the reply**

In `approveSpawn`, as the first statement inside `try {` (line 293), before `if (roomId) {`, insert:

```js
    // The mission was open when the ask was parked; the tap can come hours
    // later. Re-checked through the ASKER's sieve (as at request time)
    // before anything is created or started: a mission closed or gone in
    // the meantime fails the spawn with a readable code instead of starting
    // an unattached session. For a linked row the room does not exist yet,
    // so fail()'s epitaph write fails and is logged, as its own comment
    // allows.
    if (row.mission_num) {
      const excludePrivateOwned = !isPrivateDevice(db, row.from_device_id) || !isPrivateDevice(db, row.target_device_id)
      const mission = getMission(db, row.user_id, row.mission_num, { excludePrivateOwned })
      if (!mission) return fail('no_mission')
      if (mission.state !== 'open') return fail('mission_closed')
    }
```

Replace the `start` params object (line 351):

```js
      { workdir: row.workdir, prompt: row.task, ...(roomId ? { room_id: roomId } : {}), ...(fromName ? { from_name: fromName } : {}), ...(row.model ? { model: row.model } : {}) },
```

with:

```js
      {
        workdir: row.workdir, prompt: row.task, ...(roomId ? { room_id: roomId } : {}), ...(fromName ? { from_name: fromName } : {}), ...(row.model ? { model: row.model } : {}),
        // Omit-when-absent like model: a bridge predating the field never
        // sees the key; one that knows it names the mission in the opening turn.
        ...(row.mission_num ? { mission_num: row.mission_num } : {}),
      },
```

After the `markStarted` guard block closes (the `}` on line 371) and before `// The child's bridge may already have published its title` (line 372), insert:

```js
      // Before the room retitle and the outcome: the parent (and every app)
      // must never hear `started` for a child that is not yet on its mission.
      joinSpawnMission(db, hub, row, r.result.convo_id)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test --test-timeout=30000 test/agent-spawn.test.js test/spawns.test.js test/missions-http.test.js`
Expected: PASS (all tests).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: the summary reports `fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/spawns.js test/agent-spawn.test.js test/spawns.test.js
git -c user.email=dan@yearbookmachine.com -c user.name="Dan Barker" commit -m "spawns: approval re-checks the mission, sends mission_num, joins the child before started"
```

---

### Task 7: Document the protocol (`docs/protocol.md`, `/help`)

**Files:**
- Modify: `docs/protocol.md:372` (`hello_ok`), `:1486` (new section above Missions), `:1505-1507` (ways into a mission), `:1525` (`POST /missions` row), `:1127-1138` (`spawn_request` JSON), `:1145` (errors), and above the second `### Expiry` (`:1271`)
- Modify: `src/help.js:106-111` (Missions bullets)
- Test: `test/help.test.js:32-35`

**Interfaces:**
- Consumes: the behaviour from Tasks 1–6.
- Produces: documentation only. `/help` names `GET /coordinator` and `attach: false`.

- [ ] **Step 1: Write the failing test**

In `test/help.test.js`, extend the route list (lines 32-35) so it reads:

```js
  for (const route of [
    'POST /missions', 'GET /missions?state=', 'GET /missions/:id', 'PATCH /missions/:id',
    'POST /missions/:id/join', 'POST /missions/:id/close', 'POST /milestones', 'GET /milestones?convo=',
    'GET /coordinator',
  ]) assert.ok(body.includes(route), `/help must name ${route}`)
  assert.match(body, /attach: false/)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=30000 test/help.test.js`
Expected: FAIL with `/help must name GET /coordinator`.

- [ ] **Step 3: Update `/help`**

In `src/help.js`, replace the `POST /missions` bullet (lines 106-111, which starts `` - \`POST /missions\` \`{title, body?, convo_id}\` → 201 \`{mission}\` ``) with:

```js
- \`POST /missions\` \`{title, body?, convo_id, attach?}\` → 201 \`{mission}\`
  with the next \`#num\`; 200 \`{mission, existing: true}\` if that
  conversation already has one (nothing changes), or 404 if that existing
  mission is one you cannot see — same 404 as an unknown conversation, never
  an existence oracle. Attaches the conversation and repoints its unassigned
  items. With \`attach: false\` it creates a NEW, unassigned mission whose
  origin is that conversation but touches neither the conversation nor its
  items (no \`existing\` short-circuit). \`POST /missions/create\` is the
  same route.
- \`GET /coordinator\` → \`{convo_id}\` — the user's Coordinator
  conversation, or null. Only the user sets it; you hear a change as a
  \`coordinator\` event \`{role: 'assigned'|'released'}\` in the conversation.
```

- [ ] **Step 4: Update `docs/protocol.md`**

(a) Replace line 372's `` Server: `hello_ok {seq, device_id, name}`, then journal frames `> cursor`, `` with:

```markdown
  Server: `hello_ok {seq, device_id, name, coordinator_convo_id}`, then journal frames `> cursor`,
```

and add after the sentence ending `room titles).` (line 375):

```markdown
  `coordinator_convo_id` is the user's Coordinator (see *Coordinator*), or
  null — null too for an ordinary agent when that conversation is
  private-owned. `GET /snapshot` carries the same key.
```

(b) Insert a new section directly above `## Missions & milestones` (line 1486):

```markdown
## Coordinator

Spec: matron-apple `docs/superpowers/specs/2026-09-23-coordinator-redesign-design.md` §1a.

One conversation per user is the **Coordinator**, stored in `user_settings`
(`src/coordinator.js`, `src/coordinator-http.js`) so every device and every
bridge agrees which one it is.

| Route | Who | Body | Returns |
|---|---|---|---|
| `GET /coordinator` | client or agent | | 200 `{convo_id: string\|null}`. An ordinary agent reads `null` when the Coordinator is a private-owned conversation. |
| `PUT /coordinator` | client only (agent → **403** `forbidden`) | `{convo_id: string\|null}` | 200 `{convo_id}`. **404** for a conversation the user does not own; **400** when `convo_id` is absent, not a string/null, empty or over the id cap. `null` clears. An unchanged value is a 200 no-op. |

On a change the journal appends a `coordinator` event — payload
`{role: "assigned"}` into the conversation that gained the role,
`{role: "released"}` into the one that lost it — through the ordinary
append+broadcast path, `sender` `user:<name>`. Released is written first.
Clearing emits only `released`; an unchanged `PUT` emits nothing. Agents
cannot `publish` this type. It is not a `MESSAGE_TYPE` (no unread, no
snippet) and never pushes. `hello_ok` and `/snapshot` carry
`coordinator_convo_id` so an app knows the Coordinator on connect.
```

(c) In *Missions & milestones*, replace `A conversation gains a mission in exactly three ways: `POST /missions`
(which attaches its origin), `POST /missions/:id/join`, and **inheritance**` (lines 1505-1506) with:

```markdown
A conversation gains a mission in exactly four ways: `POST /missions`
(which attaches its origin unless `attach: false`), `POST /missions/:id/join`,
a spawn that named the mission (`spawn_request` `mission_num`, see
*Agent-spawned sessions*), and **inheritance**
```

Add at the end of that section's opening prose (after `its agent can `mission_start` its own.`, line 1519):

```markdown
A mission is **unassigned** while it is `open` and has no conversations
(`conversations: 0` on the list and detail rows) — typically one the
Coordinator created with `attach: false`. Clients derive it; there is no
column.
```

(d) In the routes table, replace the `POST /missions` row (line 1525) body cell `` `{title, body?, convo_id}` + optional `Idempotency-Key` `` with `` `{title, body?, convo_id, attach?: boolean}` + optional `Idempotency-Key` (also served at `POST /missions/create`) ``, and append to its Returns cell:

```markdown
 With `attach: false`: always a new mission (201; a replay 200), `origin_convo_id` = `convo_id`, and neither the conversation nor its items are touched — no `existing` short-circuit. A non-boolean `attach` is 400.
```

(e) In the `spawn_request` JSON block, after the `"link": …` line (line 1137) add:

```json
  "mission_num": "integer (optional — the child joins this mission as soon as its conversation exists)"
```

(and put a comma at the end of the `"link"` line).

(f) At the end of the **Errors.** paragraph (line 1145) append:

```markdown
 With `mission_num`: `bad_request` (`detail:'bad mission_num'`) unless it is a positive integer; `no_mission` when no mission with that number is visible to both the asker and the target box (unknown and hidden are indistinguishable); `mission_closed` when it is closed. All three are checked before the wake and before the card, so nothing is parked or woken for them. The card payload carries `mission_num` and `mission_title` (both omitted when absent) and the consent item says "Joins mission #N — <title>".
```

(g) Directly above the `### Expiry` heading that follows *Wake-before-spawn* (line 1271 — the second `### Expiry` in the file), insert:

```markdown
### Spawning onto a mission

(spec 2026-09-23 coordinator redesign §1c.) A row with `mission_num` is
re-checked at approval, before any room or `start`: a mission closed or
gone since the ask fails the spawn (`error_code` `mission_closed` /
`no_mission`) and nothing is started. `start` carries `mission_num`
(omitted when absent). On the `start` reply the journal creates the child's
conversation row if its bridge has not published it yet (owned by the
target box), runs `joinMission` for it, and appends a `mission` marker
`joined` (`sender: journal`, `by: agent`) into it — all before the
`started` outcome. The bridge injects the opening turn just before it
answers `start`, so the order is: opening turn written, `start` answered,
join committed, parent told; the bridge knows the mission from the `start`
param. A join that fails at that point (the mission closed in the gap, the
200-conversation cap, a mission the target box cannot see) is logged and
the child runs unattached; the spawn still reports `started`.
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: the summary reports `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/help.js docs/protocol.md test/help.test.js
git -c user.email=dan@yearbookmachine.com -c user.name="Dan Barker" commit -m "docs: coordinator, unassigned missions and spawn mission_num in protocol.md and /help"
```

---

## Self-Review

**Spec coverage (spec §1, Rollout, Testing):**
- §1a table, GET, PUT (user-only, ownership, `null` clears, idempotent) → Tasks 1–2. Events through `appendAndBroadcast` → Task 2. Snapshot/hello field → Task 3.
- §1b `attach` on `createMission` and the route, provenance via `origin_convo_id`, unassigned derived from `conversations` → Task 4 (tests assert the list row's `conversations: 0`).
- §1c `mission_num` column, join before the first turn, closed or missing mission fails visibly → Tasks 5–6. The one gap against the words "before the first turn" is explained below and in Task 6's comment.
- Testing (journal line): ownership, clear, events to both conversations (Task 2); attach:false leaves the conversation and items untouched and counts as unassigned (Task 4); spawn-with-mission joining and closed-mission rejection (Tasks 5–6). The caller's list: ownership 404 ✓, agent PUT 403 ✓, clear emits only released ✓, unchanged PUT emits nothing ✓, attach:false leaves the conversation and items untouched and creates a new mission when one exists ✓, idem replay ✓, closed mission rejected ✓, spawned conversation a member before the outcome ✓.
- Rollout: additive; old clients get one extra key (JSON decoders ignore unknown keys); old bridges send no `mission_num` and see no new `start` key.

**Contract deviations (deliberate, recorded):**
1. `user_settings.user_id` is `INTEGER`, not `TEXT`: `users.id` is `INTEGER`.
2. The create route is `POST /missions`, and `/missions/create` is an alias. Before this change, `/missions/create` resolved as `/missions/:id` → 404.
3. "Join before the first turn is delivered" cannot be strictly guaranteed from the journal. The bridge's `start` handler (`matron-bridge lib/journal-rpc.js`, `injectTurn` before `respond`) writes the opening turn before it returns the conversation id. The journal joins synchronously on the reply, before the outcome and before processing any of the child's frames, and hands `mission_num` to the bridge in `start` so the opening turn can name it. A strict guarantee would need the bridge to join or delay itself, or `start` to accept a journal-minted conversation id. That is a bridge-plan decision.

**Placeholder scan:** no TBD/TODO. Every code step shows its code. The docs step gives the literal text.

**Type consistency:** `setCoordinatorConvoId` returns `{previous, current, changed}` in Tasks 1 and 2. `coordinatorFor(db, userId, {excludePrivateOwned})` is used the same way in Tasks 1, 2 and 3. `missionNum` (JS) and `mission_num` (column and wire) are used consistently in Tasks 5 and 6. `joinSpawnMission(db, hub, row, childConvoId)` is defined and called in Task 6. `missionFor`/`isError` are defined in Task 5 and reused in Task 6 (same file). Task 6's `approve` helper is new, and its name does not clash with any existing top-level name in `test/agent-spawn.test.js` (checked: the file has no `approve` binding).

**Review Focus:** all five lines have tests in their owning tasks (1/2/3, 2, 4, 6, 6).
