# Memories (journal half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the journal a per-user `memories` table with `GET/PUT/DELETE /memories` routes and a `memory` marker event, so agents and apps share one durable memory the Coordinator's bridge can inject at spawn.

**Architecture:** `src/memories.js` is the pure DB half (validation, list/get/upsert/delete, privacy sieve); `src/memories-http.js` owns auth, routes and the marker append+broadcast after commit — the items.js / items-http.js split. `http.js` mounts the handler in its route chain; `help.js` and `docs/protocol.md` document it.

**Tech Stack:** Node ≥20 ESM, better-sqlite3, `node:test` + `node:assert/strict` (`npm test`, or `node --test test/memories.test.js`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-27-memories-design.md`

## Global Constraints

- Name: `^[a-z0-9][a-z0-9-]{0,63}$`, unique per user. Description: 1–200 chars, one line (no C0/C1 control chars, no U+2028/2029), trimmed. Body: markdown ≤ 8192 UTF-8 bytes, may be empty. Type ∈ `user | feedback | project | reference`, default `feedback` on create, kept on update when omitted.
- At most 200 memories per user: a creating `PUT` past that is 409 `{error:'too_many'}`; updates never refused.
- `PUT` is an upsert by name: omitted `body` on an update clears it. No `Idempotency-Key`.
- `convo_id` on `PUT`: agents only (client sending it → 400); goes through `authorizeAgentWrite` (→ 404) and the private-owned sieve for filtered agents (→ 404).
- Privacy: a memory whose `origin_device_id` is a private device is invisible (absent from list, 404 on get/put/delete) to a filtered agent (`filteredAgent(db, who)`).
- Marker `memory` `{memory_id, action:'saved'|'deleted', created:boolean, by:'user'|'agent', name?, type?, description?}` appended after commit to (1) the writer's `convo_id` if given, else the memory's `origin_convo_id`, and (2) the Coordinator conversation when set and different. Name/type/description dropped when the origin device is private and the target conversation is not private-owned.
- `memory` is not in `MESSAGE_TYPES`, not in `AGENT_PUBLISH_TYPES`, never pushes, never wakes, no text fallback.
- Errors: 400 `bad_request`, 404 `not_found`, 409 `too_many`; the http-who.js responders.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **A name that exists but is hidden** (private origin, filtered agent PUTs the same name): expected 404, no second row, no marker — Task 2 test "filtered agent cannot see, update or delete a private-origin memory".
2. **A body of exactly 8192 bytes of multibyte text**: expected accepted; 8193 bytes rejected — Task 1 validation test uses `'é'.repeat(4096)` (8192 bytes) and `+ 'a'`.
3. **Writer convo equals the Coordinator convo**: expected one marker, not two — Task 2 test "marker lands once when the writer's conversation is the Coordinator's".
4. **An agent DELETE of a memory it did not create**: expected allowed (memories are the user's, any of their devices may edit), marker to the stored origin convo + Coordinator — Task 2 delete test.
5. **A deleted origin conversation**: expected the row write stands and the marker failure is logged, response still 200/201 — Task 2 test "marker append failure does not fail the request" (delete the convo row before the PUT).

---

## File Structure

- Create `src/memories.js` — constants, `validateMemoryFields`, `getMemory`, `listMemories`, `upsertMemory`, `deleteMemory`, `privateOrigin`.
- Create `src/memories-http.js` — `handleMemoriesRoute`, `emitMemoryMarker`, `MEMORY_EVENT_TYPE`.
- Modify `src/db.js` — `memories` table in the base schema block.
- Modify `src/http.js` — mount the handler after missions.
- Modify `src/help.js` — "Memories" section.
- Modify `docs/protocol.md` — "Memories" section between Coordinator and Missions.
- Create `test/memories.test.js`, `test/memories-http.test.js`.

---

### Task 1: Schema and pure module

**Files:**
- Modify: `src/db.js` (base schema block, after `user_settings`)
- Create: `src/memories.js`
- Test: `test/memories.test.js`

**Interfaces:**
- Produces: `MEMORY_TYPES`, `NAME_RE`, `DESCRIPTION_MAX`, `BODY_MAX`, `MEMORIES_MAX`, `validName(v) -> boolean`, `validateMemoryFields(body) -> {ok:true, value:{description, body, type|undefined}} | {ok:false}`, `getMemory(db, userId, key) -> memory|null` (key = `me_…` id or name), `listMemories(db, userId, {excludePrivateOwned}) -> memory[]` ordered by name, `upsertMemory(db, {userId, name, description, body, type, originConvoId, originDeviceId, by, now}) -> {memory, created}` (throws `Error('too_many')`), `deleteMemory(db, userId, id) -> memory|null`, `privateOrigin(db, memory) -> boolean`.

- [ ] **Step 1: Add the table to `src/db.js`** right after the `user_settings` table in the base `CREATE TABLE IF NOT EXISTS` string:

```sql
-- Memories (spec: 2026-09-27 memories): the user's shared agent memory.
-- One row per name; PUT /memories/:name overwrites. origin_convo_id is
-- deliberately not a foreign key — deleting the conversation a memory was
-- saved from must not delete the memory (same stance as
-- user_settings.coordinator_convo_id).
CREATE TABLE IF NOT EXISTS memories(
  id               TEXT PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  name             TEXT NOT NULL,
  type             TEXT NOT NULL CHECK(type IN ('user','feedback','project','reference')),
  description      TEXT NOT NULL,
  body             TEXT NOT NULL DEFAULT '',
  origin_convo_id  TEXT,
  origin_device_id INTEGER,
  created_by       TEXT NOT NULL CHECK(created_by IN ('user','agent')),
  updated_by       TEXT NOT NULL CHECK(updated_by IN ('user','agent')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, updated_at);
```

- [ ] **Step 2: Write the failing tests** `test/memories.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, pinDevicePrivate } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import {
  validateMemoryFields, validName, upsertMemory, getMemory, listMemories, deleteMemory, privateOrigin, MEMORIES_MAX,
} from '../src/memories.js'

async function seed() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const pat = await createUser(db, 'pat', 'pw')
  const agent = createAgent(db, dan.id, 'dev-2')
  const priv = createAgent(db, dan.id, 'priv-box')
  pinDevicePrivate(db, priv.deviceId, true)
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  return { db, dan, pat, agent, priv }
}
const save = (db, userId, over = {}) => upsertMemory(db, {
  userId, name: 'avoid-eric', description: 'Never use eric.', body: '', type: undefined,
  originConvoId: 'c1', originDeviceId: null, by: 'agent', now: 1000, ...over,
})

test('schema: memories table has the spec columns', async () => {
  const { db } = await seed()
  const cols = db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name)
  assert.deepEqual(cols, ['id', 'user_id', 'name', 'type', 'description', 'body', 'origin_convo_id', 'origin_device_id', 'created_by', 'updated_by', 'created_at', 'updated_at'])
})

test('validName: kebab slugs only', () => {
  for (const ok of ['a', 'avoid-eric', 'x1-2', 'a'.repeat(64)]) assert.equal(validName(ok), true, ok)
  for (const bad of ['', '-a', 'A', 'a b', 'a_b', 'a'.repeat(65), 'é', 42, null]) assert.equal(validName(bad), false, String(bad))
})

test('validateMemoryFields: description trimmed one-liner ≤200, body ≤8192 bytes (cleared when omitted), type enum', () => {
  const ok = validateMemoryFields({ description: '  Never use eric.  ', body: 'why', type: 'user' })
  assert.deepEqual(ok, { ok: true, value: { description: 'Never use eric.', body: 'why', type: 'user' } })
  assert.deepEqual(validateMemoryFields({ description: 'x' }), { ok: true, value: { description: 'x', body: '', type: undefined } })
  assert.equal(validateMemoryFields({ description: 'x', body: 'é'.repeat(4096) }).ok, true)
  assert.equal(validateMemoryFields({ description: 'x', body: 'é'.repeat(4096) + 'a' }).ok, false)
  for (const bad of [{}, { description: '' }, { description: '   ' }, { description: 'a'.repeat(201) }, { description: 'a\nb' }, { description: 'a b' },
    { description: 'x', body: 42 }, { description: 'x', type: 'rule' }, { description: 'x', type: '' }, { description: 42 }]) {
    assert.equal(validateMemoryFields(bad).ok, false, JSON.stringify(bad))
  }
})

test('upsertMemory: create then update by name; origin and created_* fixed, updated_* move, omitted type kept', async () => {
  const { db, dan, agent } = await seed()
  const c = save(db, dan.id, { originDeviceId: agent.deviceId, type: 'user', body: 'b1' })
  assert.equal(c.created, true)
  assert.match(c.memory.id, /^me_[0-9a-f]{16}$/)
  assert.equal(c.memory.type, 'user'); assert.equal(c.memory.created_by, 'agent'); assert.equal(c.memory.updated_by, 'agent')
  assert.equal(c.memory.origin_convo_id, 'c1'); assert.equal(c.memory.origin_device_id, agent.deviceId)
  const u = save(db, dan.id, { description: 'Eric is reserved.', body: '', originConvoId: 'other', originDeviceId: 999, by: 'user', now: 2000 })
  assert.equal(u.created, false); assert.equal(u.memory.id, c.memory.id)
  assert.equal(u.memory.description, 'Eric is reserved.'); assert.equal(u.memory.body, ''); assert.equal(u.memory.type, 'user')
  assert.equal(u.memory.origin_convo_id, 'c1'); assert.equal(u.memory.origin_device_id, agent.deviceId)
  assert.equal(u.memory.created_by, 'agent'); assert.equal(u.memory.updated_by, 'user')
  assert.equal(u.memory.created_at, 1000); assert.equal(u.memory.updated_at, 2000)
  assert.equal(save(db, dan.id, {}).memory.type, 'user')
  assert.equal(save(db, dan.id, { name: 'fresh' }).memory.type, 'feedback')
})

test('upsertMemory: the same name is a different row per user', async () => {
  const { db, dan, pat } = await seed()
  const a = save(db, dan.id); const b = save(db, pat.id)
  assert.notEqual(a.memory.id, b.memory.id); assert.equal(b.created, true)
})

test('upsertMemory: cap at MEMORIES_MAX creates; updates still fine', async () => {
  const { db, dan } = await seed()
  for (let i = 0; i < MEMORIES_MAX; i++) save(db, dan.id, { name: `m-${i}` })
  assert.throws(() => save(db, dan.id, { name: 'one-more' }), /too_many/)
  assert.equal(save(db, dan.id, { name: 'm-0', description: 'again' }).created, false)
})

test('getMemory by id or name; listMemories ordered by name with the privacy sieve; privateOrigin', async () => {
  const { db, dan, priv, agent } = await seed()
  const pub = save(db, dan.id, { name: 'b-public', originDeviceId: agent.deviceId }).memory
  const hid = save(db, dan.id, { name: 'a-private', originDeviceId: priv.deviceId }).memory
  assert.equal(getMemory(db, dan.id, pub.id).name, 'b-public')
  assert.equal(getMemory(db, dan.id, 'b-public').id, pub.id)
  assert.equal(getMemory(db, dan.id, 'nope'), null)
  assert.equal(getMemory(db, 999, pub.id), null)
  assert.deepEqual(listMemories(db, dan.id).map((m) => m.name), ['a-private', 'b-public'])
  assert.deepEqual(listMemories(db, dan.id, { excludePrivateOwned: true }).map((m) => m.name), ['b-public'])
  assert.equal(privateOrigin(db, hid), true); assert.equal(privateOrigin(db, pub), false)
  assert.equal(privateOrigin(db, { origin_device_id: null }), false)
})

test('deleteMemory returns the row once, then null', async () => {
  const { db, dan } = await seed()
  const m = save(db, dan.id).memory
  assert.equal(deleteMemory(db, dan.id, m.id).id, m.id)
  assert.equal(deleteMemory(db, dan.id, m.id), null)
  assert.equal(getMemory(db, dan.id, m.id), null)
})
```

- [ ] **Step 3: Run, expect failure** — `node --test test/memories.test.js` → "Cannot find module '../src/memories.js'".

- [ ] **Step 4: Create `src/memories.js`:**

```js
// Memories — pure DB state (spec: 2026-09-27 memories). The user's shared
// agent memory: one row per name, overwritten by PUT. No hub, no marker,
// no auth here: src/memories-http.js owns those, the items.js split.
import { randomBytes } from 'node:crypto'
import { isPrivateDevice } from './db.js'

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference']
export const DEFAULT_TYPE = 'feedback'
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const DESCRIPTION_MAX = 200
export const BODY_MAX = 8192 // bytes
export const MEMORIES_MAX = 200

// C0/C1 controls (covers \n, \r, \t) and the Unicode line/paragraph
// separators — the description is the one line the Coordinator sees at
// spawn, so it must stay a line. Same set the item-actions rule uses.
const LINE_BAD_CHARS = /[\u0000-\u001f\u007f-\u009f  ]/

export const newId = () => `me_${randomBytes(8).toString('hex')}`
export const validName = (v) => typeof v === 'string' && NAME_RE.test(v)

// {ok:false} on any bad field. body omitted → '' (a PUT is the whole memory).
// type omitted → undefined: upsertMemory keeps the stored type on an update
// and applies DEFAULT_TYPE on a create.
export function validateMemoryFields(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false }
  const { description, body: text, type } = body
  if (typeof description !== 'string') return { ok: false }
  const desc = description.trim()
  if (!desc || desc.length > DESCRIPTION_MAX || LINE_BAD_CHARS.test(desc)) return { ok: false }
  let value = ''
  if (text !== undefined) {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > BODY_MAX) return { ok: false }
    value = text
  }
  if (type !== undefined && !MEMORY_TYPES.includes(type)) return { ok: false }
  return { ok: true, value: { description: desc, body: value, type } }
}

const rowToMemory = (r) => (r ? {
  id: r.id, user_id: r.user_id, name: r.name, type: r.type, description: r.description, body: r.body,
  origin_convo_id: r.origin_convo_id, origin_device_id: r.origin_device_id,
  created_by: r.created_by, updated_by: r.updated_by, created_at: r.created_at, updated_at: r.updated_at,
} : null)

// `key` is the id (me_…) or the name; both are unique per user.
export function getMemory(db, userId, key) {
  if (typeof key !== 'string' || !key) return null
  const col = key.startsWith('me_') ? 'id' : 'name'
  return rowToMemory(db.prepare(`SELECT * FROM memories WHERE user_id=? AND ${col}=?`).get(userId, key))
}

export function listMemories(db, userId, { excludePrivateOwned = false } = {}) {
  const sieve = excludePrivateOwned
    ? 'AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.id = m.origin_device_id AND d.private = 1)'
    : ''
  return db.prepare(`SELECT * FROM memories m WHERE m.user_id=? ${sieve} ORDER BY m.name`).all(userId).map(rowToMemory)
}

// Saved from a private device → hidden from an ordinary agent (the
// privateOwnedConvo rule, applied to the memory's own origin device).
export const privateOrigin = (db, memory) =>
  memory.origin_device_id != null && isPrivateDevice(db, memory.origin_device_id)

// Create or overwrite by name in one transaction. Throws Error('too_many')
// when a CREATE would pass MEMORIES_MAX; an update is never refused.
export function upsertMemory(db, { userId, name, description, body, type, originConvoId = null, originDeviceId = null, by, now = Date.now() }) {
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM memories WHERE user_id=? AND name=?').get(userId, name)
    if (existing) {
      db.prepare('UPDATE memories SET description=?, body=?, type=?, updated_by=?, updated_at=? WHERE id=?')
        .run(description, body, type ?? existing.type, by, now, existing.id)
      return { memory: getMemory(db, userId, existing.id), created: false }
    }
    const n = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id=?').get(userId).n
    if (n >= MEMORIES_MAX) throw new Error('too_many')
    const id = newId()
    db.prepare(`INSERT INTO memories(id, user_id, name, type, description, body, origin_convo_id, origin_device_id, created_by, updated_by, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, userId, name, type ?? DEFAULT_TYPE, description, body, originConvoId, originDeviceId, by, by, now, now)
    return { memory: getMemory(db, userId, id), created: true }
  })()
}

// The deleted row, or null when there was nothing to delete.
export function deleteMemory(db, userId, id) {
  return db.transaction(() => {
    const m = getMemory(db, userId, id)
    if (!m) return null
    db.prepare('DELETE FROM memories WHERE id=?').run(m.id)
    return m
  })()
}
```

- [ ] **Step 5: Run, expect pass** — `node --test test/memories.test.js`. Also `node --test test/db.test.js` (the schema test there lists tables; add `memories` if it enumerates them).

- [ ] **Step 6: Commit** — `git add src/db.js src/memories.js test/memories.test.js && git commit -m "memories: table and pure module (spec 2026-09-27)"`.

---

### Task 2: HTTP routes, marker, mount

**Files:**
- Create: `src/memories-http.js`
- Modify: `src/http.js` (import; mount after `handleMissionsRoute`)
- Test: `test/memories-http.test.js`

**Interfaces:**
- Consumes: Task 1 exports; `appendAndBroadcast, toEventShape` (journal.js); `authorizeAgentWrite` (auth.js); `json, readBody` (http-body.js); `senderOf, badRequest, notFound` (http-who.js); `filteredAgent, privateOwnedConvo` (privacy.js); `getCoordinatorConvoId` (coordinator.js); `isPrivateDevice` (db.js).
- Produces: `handleMemoriesRoute(ctx, req, res, url, who) -> Promise<boolean>`, `MEMORY_EVENT_TYPE = 'memory'`, `emitMemoryMarker(ctx, who, {memory, action, created, writerConvoId})`.

- [ ] **Step 1: Write the failing tests** `test/memories-http.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { pinDevicePrivate } from '../src/db.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'

async function fleet(t) {
  const calls = []
  const waker = { enabled: true, wake: (name) => calls.push(name) }
  const s = await startTestServer({ waker })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  const priv = createAgent(s.db, dan.id, 'priv-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  const patAgent = createAgent(s.db, pat.id, 'pat-box')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'coord', ownerUserId: dan.id, title: 'Coordinator', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'pc', ownerUserId: dan.id, title: 'Private', agentDeviceId: priv.deviceId })
  upsertConversation(s.db, { id: 'p1', ownerUserId: pat.id, title: 'P1', agentDeviceId: patAgent.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  return { s, dan, pat, agent, priv, patAgent, client: login.json.token, wakeCalls: calls }
}
const put = (s, token, name, body) => s.http(`/memories/${encodeURIComponent(name)}`, { method: 'PUT', token, body: { description: 'Never use eric.', ...body } })
const markers = (s) => s.db.prepare("SELECT convo_id, sender, payload FROM events WHERE type='memory' ORDER BY seq").all().map((r) => ({ ...r, payload: JSON.parse(r.payload) }))

test('PUT /memories/:name: agent creates (201) then updates (200); marker on the writer convo; 400s on junk', async (t) => {
  const { s, agent, client } = await fleet(t)
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await put(s, agent.token, 'avoid-eric', { body: '**Why:** reserved.', type: 'feedback', convo_id: 'c1' })
  assert.equal(r.status, 201)
  assert.equal(r.json.memory.name, 'avoid-eric'); assert.equal(r.json.memory.created_by, 'agent'); assert.equal(r.json.memory.origin_convo_id, 'c1')
  const live = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'memory')
  assert.equal(live.convo_id, 'c1'); assert.equal(live.sender, 'agent:dev-2')
  assert.deepEqual(live.payload, { memory_id: r.json.memory.id, name: 'avoid-eric', type: 'feedback', description: 'Never use eric.', action: 'saved', created: true, by: 'agent' })
  ws.close()
  const u = await put(s, agent.token, 'avoid-eric', { description: 'Eric is reserved.', convo_id: 'c1' })
  assert.equal(u.status, 200); assert.equal(u.json.memory.id, r.json.memory.id); assert.equal(u.json.memory.body, ''); assert.equal(u.json.memory.type, 'feedback')
  assert.equal(markers(s).length, 2); assert.equal(markers(s)[1].payload.created, false)
  for (const [name, body] of [['Bad Name', {}], ['ok', { description: '' }], ['ok', { description: 'a\nb' }], ['ok', { type: 'rule' }], ['ok', { body: 'é'.repeat(4097) }], ['ok', { convo_id: 42 }]]) {
    assert.equal((await put(s, agent.token, name, body)).status, 400, `${name} ${JSON.stringify(body)}`)
  }
  assert.equal((await s.http('/memories/ok', { method: 'PUT', token: agent.token, body: [] })).status, 400)
  assert.equal((await put(s, agent.token, 'ok', { convo_id: 'p1' })).status, 404) // not ours
  assert.equal((await put(s, agent.token, 'ok', { convo_id: 'pc' })).status, 404) // private-owned, filtered agent
  assert.equal((await put(s, agent.token, 'ok', { convo_id: 'nope' })).status, 404)
  assert.equal((await put(s, client, 'ok', { convo_id: 'c1' })).status, 400) // clients never send convo_id
  const noAuth = await s.http('/memories/ok', { method: 'PUT', body: { description: 'x' } })
  assert.equal(noAuth.status, 401)
  assert.equal(markers(s).length, 2)
})

test('PUT by a client: no convo_id, created_by user, marker only on the Coordinator convo when one is set', async (t) => {
  const { s, dan, client, wakeCalls } = await fleet(t)
  const r0 = await put(s, client, 'no-coordinator', {})
  assert.equal(r0.status, 201); assert.equal(r0.json.memory.created_by, 'user'); assert.equal(r0.json.memory.origin_convo_id, null)
  assert.deepEqual(markers(s), [])
  setCoordinatorConvoId(s.db, dan.id, 'coord')
  const r = await put(s, client, 'with-coordinator', {})
  assert.equal(r.status, 201)
  const m = markers(s)
  assert.equal(m.length, 1); assert.equal(m[0].convo_id, 'coord'); assert.equal(m[0].sender, 'user:dan'); assert.equal(m[0].payload.by, 'user')
  assert.deepEqual(wakeCalls, []) // never wakes
})

test('marker lands on the writer convo AND the Coordinator convo, once each; once only when they coincide', async (t) => {
  const { s, dan, agent } = await fleet(t)
  setCoordinatorConvoId(s.db, dan.id, 'coord')
  await put(s, agent.token, 'two', { convo_id: 'c1' })
  assert.deepEqual(markers(s).map((m) => m.convo_id), ['c1', 'coord'])
  await put(s, agent.token, 'one', { convo_id: 'coord' })
  assert.deepEqual(markers(s).map((m) => m.convo_id), ['c1', 'coord', 'coord'])
})

test('GET /memories and /memories/:key; 409 too_many at the cap', async (t) => {
  const { s, agent, client } = await fleet(t)
  await put(s, agent.token, 'b-two', { convo_id: 'c1' }); await put(s, client, 'a-one', {})
  const list = await s.http('/memories', { token: client })
  assert.equal(list.status, 200); assert.deepEqual(list.json.memories.map((m) => m.name), ['a-one', 'b-two'])
  const byName = await s.http('/memories/a-one', { token: agent.token })
  assert.equal(byName.status, 200); assert.equal(byName.json.memory.name, 'a-one')
  const byId = await s.http(`/memories/${byName.json.memory.id}`, { token: client })
  assert.equal(byId.status, 200)
  assert.equal((await s.http('/memories/nope', { token: client })).status, 404)
  assert.equal((await s.http('/memories/Bad%20Name', { token: client })).status, 400)
  assert.equal((await s.http('/memories', { method: 'POST', token: client, body: {} })).status, 404)
  for (let i = 0; i < 198; i++) assert.equal((await put(s, client, `m-${i}`, {})).status, 201)
  const over = await put(s, client, 'one-more', {})
  assert.equal(over.status, 409); assert.equal(over.json.error, 'too_many')
  assert.equal((await put(s, client, 'a-one', { description: 'still fine' })).status, 200)
})

test('DELETE /memories/:key: 200 with the row, marker deleted to origin + Coordinator, then 404', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  setCoordinatorConvoId(s.db, dan.id, 'coord')
  const r = await put(s, agent.token, 'gone', { convo_id: 'c1' })
  const d = await s.http('/memories/gone', { method: 'DELETE', token: client })
  assert.equal(d.status, 200); assert.equal(d.json.memory.id, r.json.memory.id)
  const m = markers(s).slice(2)
  assert.deepEqual(m.map((x) => x.convo_id), ['c1', 'coord'])
  assert.equal(m[0].payload.action, 'deleted'); assert.equal(m[0].payload.by, 'user'); assert.equal(m[0].payload.created, false)
  assert.equal((await s.http('/memories/gone', { method: 'DELETE', token: client })).status, 404)
  assert.equal((await s.http('/memories', { token: client })).json.memories.length, 0)
})

test('privacy: a filtered agent cannot see, update or delete a private-origin memory; clients and private agents can', async (t) => {
  const { s, dan, agent, priv, client } = await fleet(t)
  setCoordinatorConvoId(s.db, dan.id, 'coord')
  const r = await put(s, priv.token, 'secret', { convo_id: 'pc', body: 'hush' })
  assert.equal(r.status, 201)
  // Marker into the public Coordinator convo carries the id only.
  const coordMarker = markers(s).find((m) => m.convo_id === 'coord')
  assert.deepEqual(coordMarker.payload, { memory_id: r.json.memory.id, action: 'saved', created: true, by: 'agent' })
  assert.equal(markers(s).find((m) => m.convo_id === 'pc').payload.name, 'secret')
  assert.deepEqual((await s.http('/memories', { token: agent.token })).json.memories, [])
  assert.equal((await s.http('/memories/secret', { token: agent.token })).status, 404)
  assert.equal((await put(s, agent.token, 'secret', { convo_id: 'c1' })).status, 404)
  assert.equal((await s.http('/memories/secret', { method: 'DELETE', token: agent.token })).status, 404)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 1)
  assert.equal((await s.http('/memories/secret', { token: client })).json.memory.body, 'hush')
  assert.equal((await s.http('/memories/secret', { token: priv.token })).status, 200)
  assert.equal((await put(s, client, 'secret', { description: 'edited by dan' })).status, 200)
})

test('a memory is per user: pat cannot read dan\'s', async (t) => {
  const { s, client, patAgent } = await fleet(t)
  await put(s, client, 'mine', {})
  assert.equal((await s.http('/memories/mine', { token: patAgent.token })).status, 404)
  assert.deepEqual((await s.http('/memories', { token: patAgent.token })).json.memories, [])
})

test('marker append failure (origin convo gone) does not fail the write', async (t) => {
  const { s, agent, client } = await fleet(t)
  await put(s, agent.token, 'orphan', { convo_id: 'c1' })
  s.db.prepare("DELETE FROM events WHERE convo_id='c1'").run()
  s.db.prepare("DELETE FROM conversations WHERE id='c1'").run()
  const r = await put(s, client, 'orphan', { description: 'edited' })
  assert.equal(r.status, 200); assert.equal(r.json.memory.description, 'edited')
})

test('memory is not an agent publish type', async (t) => {
  const { s, agent } = await fleet(t)
  const bridge = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await bridge.waitFor((f) => f.op === 'hello_ok')
  bridge.send({ op: 'publish', convo_id: 'c1', type: 'memory', payload: { action: 'saved' } })
  const err = await bridge.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'bad_request')
  bridge.close()
  assert.deepEqual(markers(s), [])
})
```

- [ ] **Step 2: Run, expect failure** — `node --test test/memories-http.test.js` → 404s everywhere (route not mounted).

- [ ] **Step 3: Create `src/memories-http.js`:**

```js
// HTTP surface of memories (spec: 2026-09-27 memories). Auth, validation,
// and the one side effect the pure module must not know about: the `memory`
// marker on the writer's conversation and on the Coordinator's. No push, no
// wake, no old-client fallback — a memory change is quiet bookkeeping.
import { appendAndBroadcast } from './journal.js'
import { isPrivateDevice } from './db.js'
import { authorizeAgentWrite } from './auth.js'
import { json, readBody } from './http-body.js'
import { senderOf, badRequest, notFound } from './http-who.js'
import { filteredAgent, privateOwnedConvo } from './privacy.js'
import { getCoordinatorConvoId } from './coordinator.js'
import { validName, validateMemoryFields, getMemory, listMemories, upsertMemory, deleteMemory, privateOrigin } from './memories.js'

export const MEMORY_EVENT_TYPE = 'memory'
const ID_MAX = 128

const byOf = (who) => (who.kind === 'agent' ? 'agent' : 'user')

// Visible = the caller's user's and, for an ordinary agent, not saved from a
// private device. Same 404 for every failure.
function visibleMemory(db, who, key) {
  const m = getMemory(db, who.userId, key)
  if (!m) return null
  if (filteredAgent(db, who) && privateOrigin(db, m)) return null
  return m
}

// Called AFTER the row's transaction committed. Targets: the writer's
// conversation (an agent PUT's convo_id) or, failing that, the memory's
// origin conversation; plus the Coordinator's conversation when set and
// different. Across the privacy boundary (private origin device, public
// target) the marker carries the id and action only.
export function emitMemoryMarker({ db, hub }, who, { memory, action, created, writerConvoId = null }) {
  const targets = []
  const first = writerConvoId ?? memory.origin_convo_id
  if (first) targets.push(first)
  const coord = getCoordinatorConvoId(db, who.userId)
  if (coord && !targets.includes(coord)) targets.push(coord)
  const sender = senderOf(db, who)
  const hidden = privateOrigin(db, memory)
  for (const convoId of targets) {
    const withTitle = !hidden || privateOwnedConvo(db, convoId)
    const payload = { memory_id: memory.id, ...(withTitle ? { name: memory.name, type: memory.type, description: memory.description } : {}), action, created, by: byOf(who) }
    try {
      appendAndBroadcast(db, hub, { userId: who.userId, convoId, sender, type: MEMORY_EVENT_TYPE, payload })
    } catch (err) {
      // The row already committed; a marker on a since-deleted conversation
      // must not fail the request (same stance as items/missions).
      console.error('memories: marker append failed (memory write already committed)', err)
    }
  }
}

async function handlePut(ctx, req, res, who, name) {
  const { db } = ctx
  const body = await readBody(req)
  const v = validateMemoryFields(body)
  if (!v.ok) return badRequest(res)
  let convoId = null
  if (body.convo_id !== undefined) {
    // Only an agent has a conversation to attribute the write to.
    if (who.kind !== 'agent') return badRequest(res)
    if (typeof body.convo_id !== 'string' || !body.convo_id || body.convo_id.length > ID_MAX) return badRequest(res)
    convoId = body.convo_id
  }
  // Every body-only rule is settled, so a malformed field answers 400 even
  // when the conversation or the memory is one this caller may not see.
  if (convoId) {
    const convo = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(convoId)
    if (!convo || convo.owner_user_id !== who.userId) return notFound(res)
    if (!authorizeAgentWrite(db, who.userId, who.deviceId, convoId)) return notFound(res)
    if (filteredAgent(db, who) && convo.agent_device_id != null && isPrivateDevice(db, convo.agent_device_id)) return notFound(res)
  }
  // A name that exists but is hidden from this caller is a 404, not a second
  // row: UNIQUE(user_id, name) holds either way.
  const existing = getMemory(db, who.userId, name)
  if (existing && filteredAgent(db, who) && privateOrigin(db, existing)) return notFound(res)
  let out
  try {
    out = upsertMemory(db, {
      userId: who.userId, name, ...v.value,
      originConvoId: convoId, originDeviceId: who.deviceId, by: byOf(who),
    })
  } catch (err) {
    if (err.message === 'too_many') { json(res, 409, { error: 'too_many' }); return true }
    throw err
  }
  emitMemoryMarker(ctx, who, { memory: out.memory, action: 'saved', created: out.created, writerConvoId: convoId })
  json(res, out.created ? 201 : 200, { memory: out.memory })
  return true
}

export async function handleMemoriesRoute(ctx, req, res, url, who) {
  const { db } = ctx
  if (url.pathname === '/memories') {
    if (req.method !== 'GET') return false
    json(res, 200, { memories: listMemories(db, who.userId, { excludePrivateOwned: filteredAgent(db, who) }) })
    return true
  }
  const m = /^\/memories\/([^/]+)$/.exec(url.pathname)
  if (!m) return false
  let key
  try { key = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  if (req.method === 'PUT') {
    if (!validName(key)) return badRequest(res)
    return handlePut(ctx, req, res, who, key)
  }
  if (req.method === 'GET') {
    if (!key.startsWith('me_') && !validName(key)) return badRequest(res)
    const memory = visibleMemory(db, who, key)
    if (!memory) return notFound(res)
    json(res, 200, { memory })
    return true
  }
  if (req.method === 'DELETE') {
    if (!key.startsWith('me_') && !validName(key)) return badRequest(res)
    const memory = visibleMemory(db, who, key)
    if (!memory) return notFound(res)
    const gone = deleteMemory(db, who.userId, memory.id)
    if (!gone) return notFound(res)
    emitMemoryMarker(ctx, who, { memory: gone, action: 'deleted', created: false })
    json(res, 200, { memory: gone })
    return true
  }
  return false
}
```

- [ ] **Step 4: Mount in `src/http.js`** — add `import { handleMemoriesRoute } from './memories-http.js'` next to the missions import, and after the `handleMissionsRoute` line:

```js
      if (await handleMemoriesRoute({ db, hub }, req, res, url, who)) return
```

- [ ] **Step 5: Run, expect pass** — `node --test test/memories-http.test.js`, then `npm test` for the whole suite (the conformance/help tests may enumerate routes; fix any that list them).

- [ ] **Step 6: Commit** — `git add src/memories-http.js src/http.js test/memories-http.test.js && git commit -m "memories: GET/PUT/DELETE /memories with the memory marker"`.

---

### Task 3: Docs — protocol.md and /help

**Files:**
- Modify: `docs/protocol.md` (new "## Memories" section between "## Coordinator" and "## Missions & milestones")
- Modify: `src/help.js` (a "Memories" bullet group after the `GET /coordinator` bullet)
- Test: `test/help.test.js` (extend the existing assertion list with `/memories`)

- [ ] **Step 1: Add to `test/help.test.js`** an assertion that the text contains `` `PUT /memories/:name` `` (match the file's existing style).

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Write the protocol section** (verbatim from the spec: shape, limits, routes table, privacy, marker JSON and placement, "not a MESSAGE_TYPE / AGENT_PUBLISH_TYPE, never pushes or wakes, no fallback").

- [ ] **Step 4: Write the help digest:**

```
- \`GET /memories\` → \`{memories}\` — the user's shared agent memory:
  standing rules and facts, one row per kebab-case \`name\`, ordered by
  name. \`GET /memories/:name\` (or \`me_…\` id) → \`{memory}\`.
- \`PUT /memories/:name\` \`{description (≤200, one line), body? (markdown
  ≤8 KB), type?: user|feedback|project|reference, convo_id? (agents: your
  conversation)}\` → 201 created / 200 updated \`{memory}\`. Same name
  overwrites — the whole memory, so send the body back when updating. 409
  \`too_many\` at 200 memories. \`DELETE /memories/:name\` → 200 \`{memory}\`.
  Every change lands as a \`memory\` event on your conversation and the
  Coordinator's.
```

- [ ] **Step 5: Run `npm test`, expect pass. Commit** — `git add docs/protocol.md src/help.js test/help.test.js && git commit -m "memories: protocol and /help docs"`.

---

### Task 4: PR

- [ ] Push `feat/memories`, open the PR against master with the spec summary, wait for CI green and Bugbot `success`, address findings, merge.
