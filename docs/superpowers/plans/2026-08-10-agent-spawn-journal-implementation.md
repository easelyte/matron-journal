# Agent-Spawned Sessions — matron-journal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the journal side of the approved agent-spawned-sessions spec (`docs/superpowers/specs/2026-08-09-agent-spawns-session-design.md`): durable spawn requests, per-tap consent cards, journal-brokered `start` RPC, and parent/child room creation.

**Architecture:** The journal parks a `spawn_request` from a parent agent in a durable `agent_spawn_requests` row, publishes a consent card into the parent's own conversation, and on the user's approval (over `POST /agent-spawn/answer`) creates the parent/child room and issues the existing `start` RPC to the target bridge **itself** — which requires a new journal-side pending-request broker that can await RPC replies. Ship-order step 2 of 4; the bridge tools (`agent_boxes`, `agent_session_start`) are a separate follow-up plan in matron-bridge.

**Tech Stack:** Node 20+, better-sqlite3, `ws`, `node:test` (`npm test` — 611 passing at baseline). No new dependencies.

## Global Constraints

- Every spawn asks the user, every time — no standing permission, no `always_allow` (spec §Consent; a body carrying `always_allow` is rejected `400`, mirroring `/agent-chat/answer`).
- Caps copied verbatim from spec: `task` ≤ 2000 chars, `topic` ≤ 200 (`INVITE_TOPIC_MAX_CHARS`), both flattened through `sanitizePeerText` before reaching the card.
- Pending-ask cap counts **both** tables: one `countPendingAsks(db, fromDeviceId)` sums `awaiting_user` rows across `convo_agents` and `agent_spawn_requests`, checked against the shared `MAX_AWAITING_PER_REQUESTER` (3) on all three ask surfaces (`agent_invite`, `agent_join`, `spawn_request`).
- State machine CHECK lists every state the code can write: `awaiting_user`, `approved`, `started`, `denied`, `expired`, `failed` (the `convo_agents` lesson — an unlisted value fails silently).
- A denial is reported plainly as `declined` (unlike chat's `refused` masking) — spec §Two deliberate differences.
- Ownership checks on the two new agent ops inherit `agent_request`'s stance verbatim: unknown device, another user's device, and a client-kind device are indistinguishable `not_found`.
- An unreachable target box is refused at request time, before any card is published — never spend the user's tap on something that cannot work.
- Two approve taps spawn once: state-scoped `UPDATE … WHERE id=? AND state='awaiting_user'`, second caller gets `409`.
- **Ordering is load-bearing:** room first, then spawn.
- Every request resolves exactly once and the parent is told exactly once.
- `awaiting_user` TTL: the existing 24h `AWAITING_USER_TTL_MS` + half-TTL sweep; non-renewable.
- House test style: `node:test`, `startTestServer`/`makeWsClient` from `test/helpers.js`, fleet-style setup functions copied from `test/agent-chat-consent.test.js`.

## File Structure

| File | Responsibility |
|---|---|
| `src/db.js` (modify) | `agent_spawn_requests` table + index |
| `src/spawns.js` (create) | Spawn-request store (create/claim/deny/expire/started/failed), `countPendingAsks`, `approveSpawn` orchestration |
| `src/rpc-broker.js` (create) | Journal-originated RPC: pending map keyed by `request_id`, timeout, unreachable, spoof guard |
| `src/participants.js` (modify) | `recordJoined` (direct `joined` row, no invite round-trip) |
| `src/journal.js` (modify) | `isClientOnlyEvent` covers `agent_spawn` cards; `snippetOf` branch; `appendAndBroadcast` (append + fan for journal-authored events, usable outside ws.js's closure) |
| `src/ws.js` (modify) | `spawn_request` + `spawn_targets` ops; `agent_response` broker branch; sweep expiry loop; cap swap to `countPendingAsks` |
| `src/http.js` (modify) | `POST /agent-spawn/answer` |
| `src/server.js` (modify) | Construct broker; thread `spawnStartTimeoutMs`/`spawnFoldersTimeoutMs` opts |
| `test/spawns.test.js` (create) | Store + cap unit tests (in-memory db, no server) |
| `test/rpc-broker.test.js` (create) | Broker unit tests (fake hub) |
| `test/agent-spawn.test.js` (create) | End-to-end ws/http tests (fleet harness) |
| `docs/protocol.md` (modify) | Protocol doc for the new ops/endpoint/frames |

Wire vocabulary produced here (the bridge plan consumes it):
- Ack to `spawn_request`: `{kind:'spawn', event:'pending', request_id, spawn_id}`
- Reply to `spawn_targets`: `{kind:'spawn', event:'targets', request_id, boxes:[{device_id, name, online, folders:[{path,last_used}]}]}`
- Outcome to the parent device: `{kind:'spawn', event:'outcome', request_id:<spawn row id>, outcome:'started'|'declined'|'expired'|'failed', room_id?, child_convo_id?, error_code?}`
- `start` RPC params gain `prompt` and `room_id`; journal-originated requests carry `from_device_id: 0`.

---

### Task 1: Schema + spawn-request store

**Files:**
- Modify: `src/db.js` (schema block at top; table creation is idempotent `CREATE TABLE IF NOT EXISTS`, matching every other table — no migration machinery exists or is needed)
- Create: `src/spawns.js`
- Test: `test/spawns.test.js`

**Interfaces:**
- Produces: `createSpawnRequest(db, {id, userId, fromDeviceId, fromConvoId, targetDeviceId, workdir, task, topic, now})`, `getSpawn(db, id) → row|undefined`, `denySpawn(db, id, now) → boolean`, `claimApprove(db, id, now) → boolean`, `markStarted(db, id, {roomId, childConvoId, now}) → boolean`, `markFailed(db, id, now) → boolean`, `expireSpawns(db, ttlMs, now) → rows`

- [ ] **Step 1: Write the failing tests**

```js
// test/spawns.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import {
  createSpawnRequest, getSpawn, denySpawn, claimApprove,
  markStarted, markFailed, expireSpawns,
} from '../src/spawns.js'

async function seed() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const parent = createAgent(db, dan.id, 'dev-6')
  const target = createAgent(db, dan.id, 'eric')
  return { db, dan, parent, target }
}

function makeRow(db, dan, parent, target, id = 'spawn-1', now = 1000) {
  createSpawnRequest(db, {
    id, userId: dan.id, fromDeviceId: parent.deviceId, fromConvoId: 'parent-convo',
    targetDeviceId: target.deviceId, workdir: '/home/dan/proj', task: 'do the thing', topic: 'thing', now,
  })
}

test('createSpawnRequest lands in awaiting_user with every field', async () => {
  const { db, dan, parent, target } = seed ? await seed() : {}
  makeRow(db, dan, parent, target)
  const row = getSpawn(db, 'spawn-1')
  assert.equal(row.state, 'awaiting_user')
  assert.equal(row.user_id, dan.id)
  assert.equal(row.from_device_id, parent.deviceId)
  assert.equal(row.from_convo_id, 'parent-convo')
  assert.equal(row.target_device_id, target.deviceId)
  assert.equal(row.workdir, '/home/dan/proj')
  assert.equal(row.task, 'do the thing')
  assert.equal(row.topic, 'thing')
  assert.equal(row.created_at, 1000)
  assert.equal(row.answered_at, null)
  assert.equal(row.resolved_at, null)
})

test('claimApprove wins exactly once; denySpawn cannot follow a claim', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target)
  assert.equal(claimApprove(db, 'spawn-1', 2000), true)
  assert.equal(getSpawn(db, 'spawn-1').state, 'approved')
  assert.equal(getSpawn(db, 'spawn-1').answered_at, 2000)
  assert.equal(claimApprove(db, 'spawn-1', 2001), false) // second tap loses
  assert.equal(denySpawn(db, 'spawn-1', 2002), false)    // deny after claim loses too
})

test('denySpawn resolves an awaiting row; approve cannot follow', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target)
  assert.equal(denySpawn(db, 'spawn-1', 2000), true)
  const row = getSpawn(db, 'spawn-1')
  assert.equal(row.state, 'denied')
  assert.equal(row.answered_at, 2000)
  assert.equal(row.resolved_at, 2000)
  assert.equal(claimApprove(db, 'spawn-1', 2001), false)
})

test('markStarted/markFailed only fire from approved, and record the terminal facts', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target)
  assert.equal(markStarted(db, 'spawn-1', { roomId: 'r', childConvoId: 'c', now: 3000 }), false) // not approved yet
  claimApprove(db, 'spawn-1', 2000)
  assert.equal(markStarted(db, 'spawn-1', { roomId: 'room-1', childConvoId: 'child-1', now: 3000 }), true)
  const row = getSpawn(db, 'spawn-1')
  assert.equal(row.state, 'started')
  assert.equal(row.room_id, 'room-1')
  assert.equal(row.child_convo_id, 'child-1')
  assert.equal(row.resolved_at, 3000)
  assert.equal(markFailed(db, 'spawn-1', 3001), false) // already terminal

  makeRow(db, dan, parent, target, 'spawn-2')
  claimApprove(db, 'spawn-2', 2000)
  assert.equal(markFailed(db, 'spawn-2', 3000), true)
  assert.equal(getSpawn(db, 'spawn-2').state, 'failed')
})

test('expireSpawns flips only stale awaiting rows and reports who to tell', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target, 'old', 1000)
  makeRow(db, dan, parent, target, 'fresh', 900000)
  makeRow(db, dan, parent, target, 'claimed', 1000)
  claimApprove(db, 'claimed', 2000)
  const expired = expireSpawns(db, 100000, 500000) // ttl 100s at t=500s: only 'old' is stale
  assert.deepEqual(expired.map((r) => r.id), ['old'])
  assert.equal(expired[0].user_id, dan.id)
  assert.equal(expired[0].from_device_id, parent.deviceId)
  assert.equal(getSpawn(db, 'old').state, 'expired')
  assert.equal(getSpawn(db, 'fresh').state, 'awaiting_user')
  assert.equal(getSpawn(db, 'claimed').state, 'approved') // never expires a claimed row
})

test('an unknown state can never be written (CHECK constraint)', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target)
  assert.throws(() => db.prepare("UPDATE agent_spawn_requests SET state='ended' WHERE id='spawn-1'").run())
})
```

Note: fix the first test's guard line to a plain `const { db, dan, parent, target } = await seed()` when writing the file — shown here only to keep the snippet self-contained.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/matron-journal && node --test test/spawns.test.js`
Expected: FAIL — `Cannot find module '../src/spawns.js'`

- [ ] **Step 3: Implement schema + store**

In `src/db.js`, append to the schema string (after the `convo_agents` table, before the indexes at the bottom of the block):

```sql
CREATE TABLE IF NOT EXISTS agent_spawn_requests(
  id                TEXT PRIMARY KEY,
  user_id           INTEGER NOT NULL,
  from_device_id    INTEGER NOT NULL,
  from_convo_id     TEXT NOT NULL,
  target_device_id  INTEGER NOT NULL,
  workdir           TEXT NOT NULL,
  task              TEXT NOT NULL,
  topic             TEXT NOT NULL DEFAULT '',
  state             TEXT NOT NULL CHECK(state IN
                      ('awaiting_user','approved','started',
                       'denied','expired','failed')),
  room_id           TEXT,
  child_convo_id    TEXT,
  created_at        INTEGER NOT NULL,
  answered_at       INTEGER,
  resolved_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_spawn_state ON agent_spawn_requests(state, from_device_id);
```

Create `src/spawns.js`:

```js
// Durable spawn requests (spec: 2026-08-09 agent-spawned sessions). A row is
// the journal-brokered ask "may this agent start a session on that box" —
// parked across human latency, which the stateless RPC relay deliberately
// cannot do. State machine: awaiting_user → approved → started|failed,
// awaiting_user → denied|expired. The CHECK in db.js lists every state this
// file writes — the convo_agents lesson, where an unlisted value made an
// upsert fail silently.

export function createSpawnRequest(db, { id, userId, fromDeviceId, fromConvoId, targetDeviceId, workdir, task, topic = '', now = Date.now() }) {
  db.prepare(`
    INSERT INTO agent_spawn_requests(id, user_id, from_device_id, from_convo_id, target_device_id,
      workdir, task, topic, state, created_at)
    VALUES(?,?,?,?,?,?,?,?,'awaiting_user',?)
  `).run(id, userId, fromDeviceId, fromConvoId, targetDeviceId, workdir, task, topic, now)
  return { id }
}

export function getSpawn(db, id) {
  return db.prepare('SELECT * FROM agent_spawn_requests WHERE id=?').get(id)
}

// The user's "no", reported to the parent plainly as 'declined' (spec: no
// peer to hide behind here, unlike chat's 'refused' masking).
export function denySpawn(db, id, now = Date.now()) {
  return db.prepare(
    "UPDATE agent_spawn_requests SET state='denied', answered_at=?, resolved_at=? WHERE id=? AND state='awaiting_user'"
  ).run(now, now, id).changes > 0
}

// The approve tap CLAIMS the row — state-scoped so exactly one caller wins
// and everything expensive (room, live agent on another box) starts at most
// once. The loser's zero row-count is the 409 the failure table promises.
export function claimApprove(db, id, now = Date.now()) {
  return db.prepare(
    "UPDATE agent_spawn_requests SET state='approved', answered_at=? WHERE id=? AND state='awaiting_user'"
  ).run(now, id).changes > 0
}

export function markStarted(db, id, { roomId, childConvoId, now = Date.now() }) {
  return db.prepare(
    "UPDATE agent_spawn_requests SET state='started', room_id=?, child_convo_id=?, resolved_at=? WHERE id=? AND state='approved'"
  ).run(roomId, childConvoId, now, id).changes > 0
}

export function markFailed(db, id, now = Date.now()) {
  return db.prepare(
    "UPDATE agent_spawn_requests SET state='failed', resolved_at=? WHERE id=? AND state='approved'"
  ).run(now, id).changes > 0
}

// Sweep-driven 24h TTL, mirroring participants.expireAwaiting: flip stale
// parked rows and report them so the sweep can tell each parent its ask
// timed out. RETURNING keeps flip-and-report atomic. user_id/from_device_id
// ride along so the caller needs no per-row lookups.
export function expireSpawns(db, ttlMs, now = Date.now()) {
  return db.prepare(
    "UPDATE agent_spawn_requests SET state='expired', answered_at=?, resolved_at=? WHERE state='awaiting_user' AND created_at<=? RETURNING id, user_id, from_device_id, from_convo_id"
  ).all(now, now, now - ttlMs)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/spawns.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/db.js src/spawns.js test/spawns.test.js
git commit -m "feat(spawn): agent_spawn_requests schema + state-machine store"
```

---

### Task 2: Cross-table pending-ask cap

**Files:**
- Modify: `src/spawns.js`, `src/ws.js` (the `agent_invite` handler ~line 825 and `agent_join` handler ~line 889)
- Test: `test/spawns.test.js` (append)

**Interfaces:**
- Consumes: Task 1's store; `participants.js` `parkInvite` (existing).
- Produces: `countPendingAsks(db, fromDeviceId) → number` — sums `awaiting_user` rows across `convo_agents` (as `initiator_device_id`) and `agent_spawn_requests` (as `from_device_id`). Replaces `awaitingCount` at both ws.js call sites (the function itself stays exported from participants.js for `listAwaiting` neighbours; only the cap checks move).

- [ ] **Step 1: Write the failing test** (the spec's named test: spawn rows alone, chat rows alone, and a mix that trips the limit only when summed)

```js
// append to test/spawns.test.js
import { parkInvite } from '../src/participants.js'
import { upsertConversation } from '../src/journal.js'
import { countPendingAsks } from '../src/spawns.js'

test('countPendingAsks sums awaiting_user across BOTH tables', async () => {
  const { db, dan, parent, target } = await seed()
  upsertConversation(db, { id: 'room-x', ownerUserId: dan.id, title: 'x', sessionState: 'running', agentDeviceId: parent.deviceId })

  // spawn rows alone
  makeRow(db, dan, parent, target, 's1')
  makeRow(db, dan, parent, target, 's2')
  assert.equal(countPendingAsks(db, parent.deviceId), 2)

  // chat rows alone (fresh device so the count starts at zero)
  parkInvite(db, { convoId: 'room-x', agentDeviceId: target.deviceId, initiatorDeviceId: target.deviceId, justification: 'j' })
  assert.equal(countPendingAsks(db, target.deviceId), 1)

  // the mix: 2 spawn + 1 chat = 3 for parent once it also parks a chat ask
  parkInvite(db, { convoId: 'room-x', agentDeviceId: parent.deviceId, initiatorDeviceId: parent.deviceId, justification: 'j' })
  assert.equal(countPendingAsks(db, parent.deviceId), 3)

  // resolved rows drop out
  denySpawn(db, 's1')
  assert.equal(countPendingAsks(db, parent.deviceId), 2)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/spawns.test.js`
Expected: FAIL — `countPendingAsks` is not exported

- [ ] **Step 3: Implement**

Append to `src/spawns.js`:

```js
// The shared attention throttle (spec: cap on outstanding asks). Counts BOTH
// tables — pending spawn rows live here, pending chat asks in convo_agents —
// because what the user is being protected from is cards, not any one
// table's cards. An agent that exhausted its chat budget must not spawn
// freely, or vice versa. Checked against MAX_AWAITING_PER_REQUESTER on all
// three ask surfaces (agent_invite, agent_join, spawn_request).
export function countPendingAsks(db, fromDeviceId) {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM convo_agents WHERE state='awaiting_user' AND initiator_device_id=?)
      + (SELECT COUNT(*) FROM agent_spawn_requests WHERE state='awaiting_user' AND from_device_id=?) AS c
  `).get(fromDeviceId, fromDeviceId).c
}
```

In `src/ws.js`: add `countPendingAsks` to the existing `from './spawns.js'` import (create the import line if Task 5 hasn't landed yet), and replace both cap checks —

```js
        if (awaitingCount(db, conn.deviceId) >= MAX_AWAITING_PER_REQUESTER) {
```
becomes (at both the `agent_invite` and `agent_join` sites, keeping each one's comment but noting the sum):
```js
        if (countPendingAsks(db, conn.deviceId) >= MAX_AWAITING_PER_REQUESTER) {
```
Remove `awaitingCount` from the `participants.js` import in ws.js if now unused there.

- [ ] **Step 4: Run tests**

Run: `node --test test/spawns.test.js test/agent-chat-consent.test.js`
Expected: PASS (the consent suite pins the cap behaviour on the chat side; it must still pass with the summed counter)

- [ ] **Step 5: Commit**

```bash
git add src/spawns.js src/ws.js test/spawns.test.js
git commit -m "feat(spawn): shared pending-ask cap counted across chat and spawn tables"
```

---

### Task 3: RPC broker

**Files:**
- Create: `src/rpc-broker.js`
- Test: `test/rpc-broker.test.js`

**Interfaces:**
- Consumes: `hub.sendRpcRequest(userId, deviceId, frame) → boolean` (existing).
- Produces: `makeRpcBroker() → { issue(hub, userId, deviceId, method, params, {timeoutMs}) → Promise<{ok:true,result}|{ok:false,error:{code,detail?}}>, resolve(requestId, {userId, deviceId, msg}) → boolean, pendingCount() → number }`. Journal-originated request frames carry `from_device_id: 0`. `issue` never rejects — every failure is an `{ok:false}` resolution (`agent_unreachable`, `timeout`, or the bridge's own error).

- [ ] **Step 1: Write the failing tests**

```js
// test/rpc-broker.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeRpcBroker } from '../src/rpc-broker.js'

function fakeHub(delivered = true) {
  const sent = []
  return { sent, sendRpcRequest(userId, deviceId, frame) { sent.push({ userId, deviceId, frame }); return delivered } }
}

test('issue sends a journal-originated rpc frame and resolves on the reply', async () => {
  const broker = makeRpcBroker()
  const hub = fakeHub()
  const p = broker.issue(hub, 1, 42, 'start', { workdir: '/w', prompt: 'go', room_id: 'r' }, { timeoutMs: 5000 })
  assert.equal(hub.sent.length, 1)
  const { frame } = hub.sent[0]
  assert.equal(frame.kind, 'rpc')
  assert.equal(frame.request.from_device_id, 0) // journal-originated marker
  assert.equal(frame.request.method, 'start')
  assert.deepEqual(frame.request.params, { workdir: '/w', prompt: 'go', room_id: 'r' })
  const handled = broker.resolve(frame.request.request_id, { userId: 1, deviceId: 42, msg: { ok: true, result: { convo_id: 'child' } } })
  assert.equal(handled, true)
  assert.deepEqual(await p, { ok: true, result: { convo_id: 'child' } })
  assert.equal(broker.pendingCount(), 0)
})

test('unreachable target resolves immediately without waiting for the timeout', async () => {
  const broker = makeRpcBroker()
  const r = await broker.issue(fakeHub(false), 1, 42, 'start', {}, { timeoutMs: 60000 })
  assert.deepEqual(r, { ok: false, error: { code: 'agent_unreachable' } })
  assert.equal(broker.pendingCount(), 0)
})

test('timeout resolves {ok:false, code:timeout}; a late reply is then unclaimed', async () => {
  const broker = makeRpcBroker()
  const hub = fakeHub()
  const r = await broker.issue(hub, 1, 42, 'start', {}, { timeoutMs: 20 })
  assert.deepEqual(r, { ok: false, error: { code: 'timeout' } })
  const rid = hub.sent[0].frame.request.request_id
  assert.equal(broker.resolve(rid, { userId: 1, deviceId: 42, msg: { ok: true, result: {} } }), false)
})

test('a reply from the wrong device or user does not resolve (spoof guard)', async () => {
  const broker = makeRpcBroker()
  const hub = fakeHub()
  const p = broker.issue(hub, 1, 42, 'start', {}, { timeoutMs: 5000 })
  const rid = hub.sent[0].frame.request.request_id
  assert.equal(broker.resolve(rid, { userId: 1, deviceId: 99, msg: { ok: true, result: {} } }), false)
  assert.equal(broker.resolve(rid, { userId: 2, deviceId: 42, msg: { ok: true, result: {} } }), false)
  assert.equal(broker.pendingCount(), 1) // still waiting for the real device
  broker.resolve(rid, { userId: 1, deviceId: 42, msg: { ok: false, error: { code: 'bad_workdir' } } })
  assert.deepEqual(await p, { ok: false, error: { code: 'bad_workdir' } })
})

test('a bridge error reply passes through code and detail', async () => {
  const broker = makeRpcBroker()
  const hub = fakeHub()
  const p = broker.issue(hub, 1, 42, 'start', {}, { timeoutMs: 5000 })
  broker.resolve(hub.sent[0].frame.request.request_id, { userId: 1, deviceId: 42, msg: { ok: false, error: { code: 'spawn_failed', detail: 'boom' } } })
  assert.deepEqual(await p, { ok: false, error: { code: 'spawn_failed', detail: 'boom' } })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/rpc-broker.test.js`
Expected: FAIL — `Cannot find module '../src/rpc-broker.js'`

- [ ] **Step 3: Implement**

```js
// src/rpc-broker.js
//
// Journal-originated RPC (spec: 2026-08-09 agent-spawned sessions, "the
// journal must learn to await RPC responses"). Today's relay correlates
// nothing — it forwards a request and forwards whatever comes back. This
// broker is the pending-request map that lets the JOURNAL be the caller:
// issue() sends over the same single-consumer hub path the client relay
// uses, parks a resolver keyed by request_id, and resolves exactly once —
// on the bridge's reply, on timeout, or immediately when the target has no
// live socket. Never left hanging: a spawn stuck 'approved' forever is the
// failure mode this timeout exists to close.
//
// from_device_id: 0 marks a request as journal-originated. No device row
// ever has id 0 (SQLite AUTOINCREMENT starts at 1), so a bridge echoing it
// back as to_device_id can never collide with a real client device — and
// ws.js's agent_response handler checks the broker BEFORE the client-target
// lookup anyway.
import { randomUUID } from 'node:crypto'

export function makeRpcBroker() {
  const pending = new Map() // request_id -> { userId, deviceId, settle, timer }
  return {
    issue(hub, userId, deviceId, method, params, { timeoutMs }) {
      const requestId = randomUUID()
      return new Promise((resolve) => {
        const entry = {
          userId, deviceId,
          settle(outcome) {
            clearTimeout(entry.timer)
            pending.delete(requestId)
            resolve(outcome)
          },
          timer: setTimeout(() => entry.settle({ ok: false, error: { code: 'timeout' } }), timeoutMs),
        }
        entry.timer.unref?.()
        pending.set(requestId, entry)
        const delivered = hub.sendRpcRequest(userId, deviceId, {
          kind: 'rpc',
          request: { request_id: requestId, from_device_id: 0, method, params },
        })
        if (!delivered) entry.settle({ ok: false, error: { code: 'agent_unreachable' } })
      })
    },
    // Called from ws.js's agent_response handler. Returns whether this reply
    // belonged to a journal-originated request; false lets the handler fall
    // through to the ordinary client-forward path. Only the device the
    // request was sent to, on the user it was sent for, may settle it —
    // request ids are unguessable UUIDs, but unguessable is not a
    // substitute for checking.
    resolve(requestId, { userId, deviceId, msg }) {
      const entry = pending.get(requestId)
      if (!entry) return false
      if (entry.userId !== userId || entry.deviceId !== deviceId) return false
      entry.settle(msg.ok
        ? { ok: true, result: msg.result ?? null }
        : { ok: false, error: msg.error })
      return true
    },
    pendingCount() { return pending.size },
  }
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/rpc-broker.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/rpc-broker.js test/rpc-broker.test.js
git commit -m "feat(spawn): rpc broker — journal-originated requests with timeout and spoof guard"
```

---

### Task 4: `agent_response` broker branch + server wiring

**Files:**
- Modify: `src/server.js` (`startServer` ~line 220-280), `src/ws.js` (`attachWs` signature ~line 165, `agent_response` handler ~line 711), `src/http.js` (`makeHttpHandler` signature ~line 90)
- Test: `test/agent-spawn.test.js` (create, first tests)

**Interfaces:**
- Consumes: Task 3's `makeRpcBroker`.
- Produces: `startServer` opts gain `spawnStartTimeoutMs = 30000` and `spawnFoldersTimeoutMs = 4000`; one broker instance constructed in `startServer` and passed to BOTH `attachWs({ …, broker, spawnStartTimeoutMs, spawnFoldersTimeoutMs })` and `makeHttpHandler({ …, broker, spawnStartTimeoutMs })`. The test server exposes it: add `broker` to `startServer`'s returned object so tests can reach it via `s.broker`.

- [ ] **Step 1: Write the failing test**

```js
// test/agent-spawn.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { getSpawn, createSpawnRequest } from '../src/spawns.js'

// Fleet: one user, a parent agent (dev-6), a target agent (eric), a client.
// Parent owns 'parent-convo' — the conversation the consent card lands in.
async function spawnFleet(t, { connectTarget = true, serverOpts = {} } = {}) {
  const s = await startTestServer(serverOpts)
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const parentDev = createAgent(s.db, dan.id, 'dev-6')
  const targetDev = createAgent(s.db, dan.id, 'eric')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const clientToken = login.json.token
  const parent = await makeWsClient(s.base, { token: parentDev.token, cursor: null })
  const target = connectTarget ? await makeWsClient(s.base, { token: targetDev.token, cursor: null }) : null
  const client = await makeWsClient(s.base, { token: clientToken, cursor: null })
  await parent.waitFor((f) => f.op === 'hello_ok')
  if (target) await target.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { parent.close(); target?.close(); client.close() })
  parent.send({ op: 'convo_upsert', convo_id: 'parent-convo', title: 'parent session', session_state: 'running' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  parent.frames.length = 0
  if (target) target.frames.length = 0
  client.frames.length = 0
  return { s, dan, parentDev, targetDev, clientToken, parent, target, client }
}

test('a bridge reply to a journal-originated request settles the broker, not the client relay', async (t) => {
  const { s, dan, targetDev, target } = await spawnFleet(t)
  const p = s.broker.issue(s.hub, dan.id, targetDev.deviceId, 'start', { workdir: '/w', prompt: 'go', room_id: 'r' }, { timeoutMs: 5000 })
  const req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start')
  assert.equal(req.request.from_device_id, 0)
  target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: req.request.from_device_id, ok: true, result: { convo_id: 'child-1' } })
  assert.deepEqual(await p, { ok: true, result: { convo_id: 'child-1' } })
})

test('a spoofed reply from a different agent device falls through to not_found', async (t) => {
  const { s, dan, parentDev, targetDev, parent, target } = await spawnFleet(t)
  const p = s.broker.issue(s.hub, dan.id, targetDev.deviceId, 'start', {}, { timeoutMs: 1000 })
  const req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start')
  // parent (wrong device) tries to answer the target's request
  parent.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'evil' } })
  const err = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'not_found') // device 0 is no client device — anti-enumeration shape
  const r = await p // then times out (1s) — the spoof never settled it
  assert.deepEqual(r, { ok: false, error: { code: 'timeout' } })
})
```

`spawnFleet` needs `s.hub` too — add `hub` alongside `broker` to `startServer`'s returned object in the same edit.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/agent-spawn.test.js`
Expected: FAIL — `s.broker` is undefined

- [ ] **Step 3: Implement**

`src/server.js`: import `makeRpcBroker` from `./rpc-broker.js`; add `spawnStartTimeoutMs = 30000, spawnFoldersTimeoutMs = 4000` to `startServer`'s destructured opts; after `const hub = makeHub()` add `const broker = makeRpcBroker()`; pass `broker, spawnStartTimeoutMs` into `makeHttpHandler({...})` and `broker, spawnFoldersTimeoutMs` into `attachWs({...})`; add `broker, hub` to the returned object (find the `return {` at the end of `startServer` — it already returns `db`, `port`, `close`).

`src/ws.js`: add `broker` and `spawnFoldersTimeoutMs = 4000` to `attachWs`'s destructured params. In the `agent_response` handler, insert the broker branch **after** the serializability guard (the `try { JSON.stringify(msg) }` block, ~line 734) and **before** the `const target = db.prepare(...)` lookup:

```js
        // Journal-originated requests (spawn brokering, folder discovery)
        // resolve internally instead of being forwarded — the broker checks
        // that THIS device, on THIS user, is the one the request went to.
        // Unmatched replies fall through to the client-forward path below,
        // where to_device_id 0 lands in the same not_found every unknown
        // device gets.
        if (broker && broker.resolve(rid, { userId: conn.userId, deviceId: conn.deviceId, msg })) break
```

`src/http.js`: add `broker, spawnStartTimeoutMs = 30000` to `makeHttpHandler`'s destructured params (used in Task 7/8).

- [ ] **Step 4: Run tests**

Run: `node --test test/agent-spawn.test.js test/agent.test.js`
Expected: PASS (existing agent-RPC tests must be untouched by the new branch)

- [ ] **Step 5: Commit**

```bash
git add src/server.js src/ws.js src/http.js test/agent-spawn.test.js
git commit -m "feat(spawn): agent_response settles journal-originated requests via the broker"
```

---

### Task 5: `spawn_request` op + consent card

**Files:**
- Modify: `src/journal.js` (`isClientOnlyEvent` line 15, `snippetOf` line 19), `src/ws.js` (new case after `agent_request` ~line 709; new consts next to `INVITE_TOPIC_MAX_CHARS` ~line 60)
- Test: `test/agent-spawn.test.js` (append)

**Interfaces:**
- Consumes: Task 1 `createSpawnRequest`, Task 2 `countPendingAsks`.
- Produces: ws op `spawn_request {request_id, from_convo_id, target_device_id, workdir, task, topic?}` → ack `{kind:'spawn', event:'pending', request_id, spawn_id}`; a `permission_request` event with `payload.kind === 'agent_spawn'` appended into the parent's conversation. New ws.js consts: `SPAWN_TASK_MAX_CHARS = 2000`, `SPAWN_WORKDIR_MAX_CHARS = 1024`.

- [ ] **Step 1: Extend `isClientOnlyEvent` + `snippetOf` (tiny, test-first inside the same suite)**

In `src/journal.js`:

```js
export function isClientOnlyEvent(type, payload) {
  return type === 'permission_request' && !!payload && typeof payload === 'object'
    && (payload.kind === 'agent_chat' || payload.kind === 'agent_spawn')
}
```

In `snippetOf`, replace the `isClientOnlyEvent` branch:

```js
  if (isClientOnlyEvent(type, payload)) {
    return p.kind === 'agent_spawn' ? '🤝 Agent spawn request' : '🤝 Agent chat request'
  }
```

This one predicate change buys, for free: card excluded from agent fan-out (`ws.js` fanOut line 561), excluded from agent hello-replay (line 374), unforgeable via `publish`/`finalize` (lines 1195/1311 answer `bad_request`), and hidden from agent HTTP message reads (http.js line ~602).

- [ ] **Step 2: Write the failing tests**

```js
// append to test/agent-spawn.test.js
const isSpawnCard = (f) => f.kind === 'journal' && f.type === 'permission_request' && f.payload?.kind === 'agent_spawn'

test('spawn_request parks a row, publishes a client-only card into the parent convo, acks pending', async (t) => {
  const { s, parentDev, targetDev, parent, target, client } = await spawnFleet(t)
  parent.send({
    op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo',
    target_device_id: targetDev.deviceId, workdir: '/home/dan/proj',
    task: 'fix the flaky test\nand report back', topic: 'flaky test',
  })
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  assert.equal(ack.request_id, 'q1')
  assert.ok(ack.spawn_id)
  const row = getSpawn(s.db, ack.spawn_id)
  assert.equal(row.state, 'awaiting_user')
  assert.equal(row.from_device_id, parentDev.deviceId)
  assert.equal(row.workdir, '/home/dan/proj')
  const card = await client.waitFor(isSpawnCard)
  assert.equal(card.convo_id, 'parent-convo')
  assert.equal(card.payload.request_id, ack.spawn_id)
  assert.equal(card.payload.from_name, 'dev-6')
  assert.equal(card.payload.target_name, 'eric')
  assert.equal(card.payload.workdir, '/home/dan/proj')
  assert.ok(!card.payload.task.includes('\n')) // peer-text discipline: no forged card lines
  // client-only: neither agent may ever see the card
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(parent.frames.find(isSpawnCard), undefined)
  assert.equal(target.frames.find(isSpawnCard), undefined)
})

test('spawn_request against an offline box is refused before any card exists', async (t) => {
  const { s, targetDev, parent, client } = await spawnFleet(t, { connectTarget: false })
  parent.send({
    op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo',
    target_device_id: targetDev.deviceId, workdir: '/w', task: 'x',
  })
  const err = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'agent_unreachable')
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM agent_spawn_requests').get().c, 0)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(client.frames.find(isSpawnCard), undefined)
})

test('spawn_request authorization: clients are forbidden; unknown/foreign/client targets are not_found; foreign from_convo_id is not_found', async (t) => {
  const { s, dan, targetDev, parent, client } = await spawnFleet(t)
  // client kind cannot issue the op
  client.send({ op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo', target_device_id: targetDev.deviceId, workdir: '/w', task: 'x' })
  const e1 = await client.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(e1.code, 'forbidden')
  // unknown target device
  parent.send({ op: 'spawn_request', request_id: 'q2', from_convo_id: 'parent-convo', target_device_id: 9999, workdir: '/w', task: 'x' })
  const e2 = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(e2.code, 'not_found')
  // a convo the parent does not own cannot front the ask
  parent.frames.length = 0
  parent.send({ op: 'spawn_request', request_id: 'q3', from_convo_id: 'someone-elses', target_device_id: targetDev.deviceId, workdir: '/w', task: 'x' })
  const e3 = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(e3.code, 'not_found')
})

test('spawn_request enforces the shared pending-ask cap', async (t) => {
  const { s, dan, parentDev, targetDev, parent } = await spawnFleet(t)
  for (const id of ['a', 'b', 'c']) {
    createSpawnRequest(s.db, { id, userId: dan.id, fromDeviceId: parentDev.deviceId, fromConvoId: 'parent-convo', targetDeviceId: targetDev.deviceId, workdir: '/w', task: 'x' })
  }
  parent.send({ op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo', target_device_id: targetDev.deviceId, workdir: '/w', task: 'x' })
  const err = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'conflict')
})

test('spawn cards are unforgeable via publish', async (t) => {
  const { parent } = await spawnFleet(t)
  parent.send({ op: 'publish', convo_id: 'parent-convo', type: 'permission_request', payload: { kind: 'agent_spawn', request_id: 'forged', task: 'evil' } })
  const err = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'bad_request')
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/agent-spawn.test.js`
Expected: FAIL — error frames report `bad_request`/unknown op (no `spawn_request` case exists)

- [ ] **Step 4: Implement the op**

In `src/ws.js`, add consts next to `INVITE_TOPIC_MAX_CHARS` (~line 60):

```js
// Spawn asks (spec: 2026-08-09 agent-spawned sessions). task is BOTH the
// child's seed prompt and the card text the user approves — one blob, so
// the text the user reads is the text that takes effect.
const SPAWN_TASK_MAX_CHARS = 2000
const SPAWN_WORKDIR_MAX_CHARS = 1024
```

Import from `./spawns.js`: `createSpawnRequest, countPendingAsks`. Import `randomUUID` from `node:crypto`. Add the case directly after `agent_response`:

```js
      case 'spawn_request': {
        if (conn.kind !== 'agent') return fail('forbidden')
        if (!conn.registered) return fail('not_ready')
        const rid = msg.request_id
        if (typeof rid !== 'string' || rid.length === 0 || rid.length > RPC_ID_MAX_CHARS) return fail('bad_request', 'bad request_id')
        if (typeof msg.workdir !== 'string' || !msg.workdir || msg.workdir.length > SPAWN_WORKDIR_MAX_CHARS) return fail('bad_request', 'bad workdir')
        if (typeof msg.task !== 'string' || !msg.task || msg.task.length > SPAWN_TASK_MAX_CHARS) return fail('bad_request', 'bad task')
        if (msg.topic != null && (typeof msg.topic !== 'string' || msg.topic.length > INVITE_TOPIC_MAX_CHARS)) return fail('bad_request', 'bad topic')
        if (!Number.isInteger(msg.target_device_id)) return fail('bad_request', 'bad target_device_id')
        if (msg.target_device_id === conn.deviceId) return fail('bad_request', 'cannot spawn on self')
        // Ownership stance copied from agent_request/agent_invite: unknown
        // id, another user's device, a client device — and a private device
        // seen by an ordinary agent — are indistinguishable not_found.
        const target = db.prepare('SELECT user_id, kind, private, name FROM devices WHERE id=?').get(msg.target_device_id)
        if (!target || target.user_id !== conn.userId || target.kind !== 'agent'
          || (target.private === 1 && !isPrivateDevice(db, conn.deviceId))) return fail('not_found')
        // Which of the parent's own conversations is asking — REQUIRED here
        // (the card and the outcome both land in it), same authorisation
        // shape as agent_invite's from_convo_id.
        if (typeof msg.from_convo_id !== 'string' || !msg.from_convo_id) return fail('bad_request', 'bad from_convo_id')
        const fromConvo = db.prepare(
          'SELECT owner_user_id, agent_device_id, parent_convo_id, title FROM conversations WHERE id=?'
        ).get(msg.from_convo_id)
        if (!fromConvo || fromConvo.owner_user_id !== conn.userId
          || fromConvo.agent_device_id !== conn.deviceId
          || fromConvo.parent_convo_id != null) return fail('not_found')
        // An unreachable box is refused BEFORE any card is published — never
        // spend the user's tap on something that cannot work. Same liveness
        // rule as hub.sendRpcRequest without sending anything.
        const online = hub.connsOf(conn.userId).some((c) => c.deviceId === msg.target_device_id && c.ws.readyState === 1)
        if (!online) return fail('agent_unreachable')
        const task = sanitizePeerText(msg.task, SPAWN_TASK_MAX_CHARS)
        if (!task) return fail('bad_request', 'bad task')
        const topic = sanitizePeerText(msg.topic, INVITE_TOPIC_MAX_CHARS)
        // Shared attention throttle — counts chat asks AND spawn asks.
        if (countPendingAsks(db, conn.deviceId) >= MAX_AWAITING_PER_REQUESTER) {
          return fail('conflict', 'too many requests awaiting user approval')
        }
        const spawnId = randomUUID()
        createSpawnRequest(db, {
          id: spawnId, userId: conn.userId, fromDeviceId: conn.deviceId,
          fromConvoId: msg.from_convo_id, targetDeviceId: msg.target_device_id,
          workdir: msg.workdir, task, topic,
        })
        // Client-only card (isClientOnlyEvent covers kind:'agent_spawn'),
        // published into the PARENT's own conversation — where the user is
        // already talking to the agent that is asking.
        appendAndFan({
          userId: conn.userId, convoId: msg.from_convo_id, sender: `agent:${conn.name}`, type: 'permission_request',
          payload: {
            kind: 'agent_spawn', request_id: spawnId,
            from_device_id: conn.deviceId, from_name: sanitizePeerText(conn.name, PEER_NAME_CAP),
            from_convo_id: msg.from_convo_id,
            from_convo_title: sanitizePeerText(fromConvo.title, CARD_TITLE_MAX_CHARS),
            target_device_id: msg.target_device_id, target_name: sanitizePeerText(target.name, PEER_NAME_CAP),
            workdir: msg.workdir, task, topic,
          },
        })
        conn.ws.send(JSON.stringify({ kind: 'spawn', event: 'pending', request_id: rid, spawn_id: spawnId }))
        break
      }
```

- [ ] **Step 5: Run tests**

Run: `node --test test/agent-spawn.test.js test/agent-chat-consent.test.js test/agent.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/journal.js src/ws.js test/agent-spawn.test.js
git commit -m "feat(spawn): spawn_request op — parked row + client-only consent card"
```

---

### Task 6: `spawn_targets` op (box discovery)

**Files:**
- Modify: `src/ws.js` (new case after `spawn_request`)
- Test: `test/agent-spawn.test.js` (append)

**Interfaces:**
- Consumes: Task 3's broker (`broker.issue(hub, userId, deviceId, 'recent_folders', null, {timeoutMs: spawnFoldersTimeoutMs})` — the bridge's existing `recent_folders` RPC answers `{folders:[{path,last_used}]}`).
- Produces: ws op `spawn_targets {request_id}` → `{kind:'spawn', event:'targets', request_id, boxes:[{device_id, name, online, folders}]}`. Self excluded; private boxes excluded for ordinary agents (roster stance); offline boxes listed with `folders: []`; a folder-RPC failure/timeout degrades to `folders: []`, never an error.

- [ ] **Step 1: Write the failing tests**

```js
// append to test/agent-spawn.test.js
test('spawn_targets lists other agent boxes with online flags and brokered folders', async (t) => {
  const { s, targetDev, parent, target } = await spawnFleet(t)
  // answer the folder RPC like a bridge would
  target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders').then((req) => {
    target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [{ path: '/home/dan/app', last_used: 5 }] } })
  })
  parent.send({ op: 'spawn_targets', request_id: 'q1' })
  const reply = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets')
  assert.equal(reply.request_id, 'q1')
  const eric = reply.boxes.find((b) => b.device_id === targetDev.deviceId)
  assert.equal(eric.name, 'eric')
  assert.equal(eric.online, true)
  assert.deepEqual(eric.folders, [{ path: '/home/dan/app', last_used: 5 }])
  // self is never listed
  assert.equal(reply.boxes.some((b) => b.name === 'dev-6'), false)
})

test('spawn_targets: offline box listed with no folders; folder timeout degrades to empty', async (t) => {
  const { s, dan, targetDev, parent } = await spawnFleet(t, { connectTarget: false, serverOpts: { spawnFoldersTimeoutMs: 50 } })
  const silent = createAgent(s.db, dan.id, 'mute-box')
  const mute = await makeWsClient(s.base, { token: silent.token, cursor: null })
  await mute.waitFor((f) => f.op === 'hello_ok')
  t.after(() => mute.close())
  parent.send({ op: 'spawn_targets', request_id: 'q1' })
  const reply = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets', 5000)
  const eric = reply.boxes.find((b) => b.device_id === targetDev.deviceId)
  assert.equal(eric.online, false)      // offline: no RPC even attempted
  assert.deepEqual(eric.folders, [])
  const muteBox = reply.boxes.find((b) => b.name === 'mute-box')
  assert.equal(muteBox.online, true)    // online but never answered: timeout → []
  assert.deepEqual(muteBox.folders, [])
})

test('spawn_targets is agent-only and hides private boxes from ordinary agents', async (t) => {
  const { s, dan, parent, client } = await spawnFleet(t)
  client.send({ op: 'spawn_targets', request_id: 'q1' })
  const err = await client.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'forbidden')
  const priv = createAgent(s.db, dan.id, 'secret-box')
  s.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(priv.deviceId)
  parent.frames.length = 0
  parent.send({ op: 'spawn_targets', request_id: 'q2' })
  const reply = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets')
  assert.equal(reply.boxes.some((b) => b.name === 'secret-box'), false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/agent-spawn.test.js`
Expected: FAIL — no `spawn_targets` case

- [ ] **Step 3: Implement**

Add after the `spawn_request` case in `src/ws.js`:

```js
      case 'spawn_targets': {
        if (conn.kind !== 'agent') return fail('forbidden')
        if (!conn.registered) return fail('not_ready')
        const rid = msg.request_id
        if (typeof rid !== 'string' || rid.length === 0 || rid.length > RPC_ID_MAX_CHARS) return fail('bad_request', 'bad request_id')
        // Same visibility rule as the roster: self excluded (a self-entry is
        // a self-spawn trap), private boxes hidden from ordinary agents.
        const callerPrivate = isPrivateDevice(db, conn.deviceId)
        const boxes = db.prepare(
          "SELECT id AS device_id, name, private FROM devices WHERE user_id=? AND kind='agent' AND id!=?"
        ).all(conn.userId, conn.deviceId)
          .filter((d) => callerPrivate || d.private !== 1)
        const live = new Set(hub.connsOf(conn.userId).filter((c) => c.ws.readyState === 1).map((c) => c.deviceId))
        // Folder discovery rides the broker (spec: "once it exists, folder
        // discovery rides it for free"). Offline boxes are listed with no
        // folders and no RPC; a box that fails or times out degrades to []
        // — discovery must never error because one box is sick.
        const out = await Promise.all(boxes.map(async (d) => {
          const online = live.has(d.device_id)
          let folders = []
          if (online) {
            const r = await broker.issue(hub, conn.userId, d.device_id, 'recent_folders', null, { timeoutMs: spawnFoldersTimeoutMs })
            if (r.ok && Array.isArray(r.result?.folders)) folders = r.result.folders
          }
          return { device_id: d.device_id, name: d.name, online, folders }
        }))
        conn.ws.send(JSON.stringify({ kind: 'spawn', event: 'targets', request_id: rid, boxes: out }))
        break
      }
```

- [ ] **Step 4: Run tests**

Run: `node --test test/agent-spawn.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ws.js test/agent-spawn.test.js
git commit -m "feat(spawn): spawn_targets op — box discovery with brokered folder listings"
```

---

### Task 7: `POST /agent-spawn/answer` — deny path and gates

**Files:**
- Modify: `src/http.js` (add route directly after the `/agent-chat/answer` block ~line 420)
- Test: `test/agent-spawn.test.js` (append)

**Interfaces:**
- Consumes: Task 1 `getSpawn`/`denySpawn`/`claimApprove`; Task 8 adds the approve orchestration call into this same route.
- Produces: `POST /agent-spawn/answer {request_id, decision:'approve'|'deny'}` — client-only (403 for agents *including the parent itself*), 404 anti-enumeration (unknown id ≡ another user's id), 409 for a non-awaiting row, 400 for a body carrying `always_allow`. Deny notifies the parent device: `{kind:'spawn', event:'outcome', request_id, outcome:'declined'}`.

- [ ] **Step 1: Write the failing tests**

```js
// append to test/agent-spawn.test.js
async function parkedSpawn(t, opts = {}) {
  const fleet = await spawnFleet(t, opts)
  const { targetDev, parent, client } = fleet
  parent.send({
    op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo',
    target_device_id: targetDev.deviceId, workdir: '/w', task: 'do it', topic: 'job',
  })
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  await client.waitFor(isSpawnCard)
  parent.frames.length = 0
  client.frames.length = 0
  return { ...fleet, spawnId: ack.spawn_id }
}

test('deny resolves the row and tells the parent plainly: declined', async (t) => {
  const { s, clientToken, parent, spawnId } = await parkedSpawn(t)
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'deny' } })
  assert.equal(r.status, 200)
  assert.equal(getSpawn(s.db, spawnId).state, 'denied')
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  assert.equal(out.request_id, spawnId)
  assert.equal(out.outcome, 'declined') // spec: no peer to hide behind — a plain no
  // second answer of any kind conflicts
  const again = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(again.status, 409)
})

test('answer endpoint gates: agent tokens 403 (even the parent), unknown id 404, always_allow 400', async (t) => {
  const { s, parentDev, clientToken, spawnId } = await parkedSpawn(t)
  const asAgent = await s.http('/agent-spawn/answer', { method: 'POST', token: parentDev.token, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(asAgent.status, 403)
  const unknown = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: 'no-such-row', decision: 'deny' } })
  assert.equal(unknown.status, 404)
  const standing = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve', always_allow: true } })
  assert.equal(standing.status, 400)
  assert.equal(getSpawn(s.db, spawnId).state, 'awaiting_user') // untouched by the three rejections
})

test("another user's client cannot see or answer the row (404, anti-enumeration)", async (t) => {
  const { s, spawnId } = await parkedSpawn(t)
  await createUser(s.db, 'eve', 'pw2')
  const evilLogin = await s.http('/login', { method: 'POST', body: { username: 'eve', password: 'pw2', device_name: 'phone' } })
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: evilLogin.json.token, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r.status, 404)
  assert.equal(getSpawn(s.db, spawnId).state, 'awaiting_user')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/agent-spawn.test.js`
Expected: FAIL — 404 from the unrouted path on every call

- [ ] **Step 3: Implement the route (deny complete; approve claims + stubs the orchestration call Task 8 fills in)**

In `src/http.js`, import `getSpawn, denySpawn, claimApprove, approveSpawn` from `./spawns.js`, and add after the `/agent-chat/answer` block:

```js
      if (req.method === 'POST' && url.pathname === '/agent-spawn/answer') {
        // Client-gated: an agent must never answer a consent ask, including
        // one addressed to itself — the whole point of parking is that only
        // the human decides. Same stance as /agent-chat/answer.
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        const body = await readBody(req)
        const { request_id, decision } = body
        if (decision !== 'approve' && decision !== 'deny') return json(res, 400, { error: 'bad_request' })
        if (typeof request_id !== 'string' || !request_id) return json(res, 400, { error: 'bad_request' })
        // No standing consent exists for spawns and never has — but reject
        // the field rather than ignore it, exactly as /agent-chat/answer
        // does: a caller that believes it granted something must be told.
        if ('always_allow' in body) return json(res, 400, { error: 'bad_request' })
        const row = getSpawn(db, request_id)
        // Unknown id and another user's row are indistinguishable.
        if (!row || row.user_id !== who.userId) return json(res, 404, { error: 'not_found' })
        if (decision === 'deny') {
          if (!denySpawn(db, request_id)) return json(res, 409, { error: 'conflict' })
          // Reported plainly (spec: no peer to hide behind) — 'declined',
          // never a fabricated box-side failure.
          hub.sendToDevice(who.userId, row.from_device_id, { kind: 'spawn', event: 'outcome', request_id, outcome: 'declined' })
          return json(res, 200, { ok: true })
        }
        // The tap CLAIMS the row; a zero row-count means another tap already
        // won — 409, and nothing expensive has started (spec failure table:
        // two approve taps spawn once).
        if (!claimApprove(db, request_id)) return json(res, 409, { error: 'conflict' })
        // Everything after the claim is expensive and externally visible;
        // it runs off the request cycle — the app needs its 200 now, the
        // outcome reaches the parent as a turn. Errors are contained: the
        // broker timeout guarantees approveSpawn itself always settles.
        approveSpawn({ db, hub, broker, startTimeoutMs: spawnStartTimeoutMs }, getSpawn(db, request_id))
          .catch((err) => console.error('agent-spawn approve orchestration failed', err))
        return json(res, 200, { ok: true })
      }
```

Until Task 8 lands, add a temporary `export async function approveSpawn() {}` stub to `src/spawns.js` so this module resolves — Task 8 replaces it (the deny/gate tests here never reach it).

- [ ] **Step 4: Run tests**

Run: `node --test test/agent-spawn.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/http.js src/spawns.js test/agent-spawn.test.js
git commit -m "feat(spawn): POST /agent-spawn/answer — deny path, claim, and consent gates"
```

---

### Task 8: Approve orchestration — room, start RPC, outcomes

**Files:**
- Modify: `src/spawns.js` (replace the stub), `src/participants.js` (add `recordJoined`), `src/journal.js` (add `appendAndBroadcast`)
- Test: `test/agent-spawn.test.js` (append)

**Interfaces:**
- Consumes: `upsertConversation` + `append` + `journalFrame` shape (journal.js), `joinedAgentIds` (participants.js), Task 3 broker, Task 4 wiring (`broker`, `spawnStartTimeoutMs` already reach http.js).
- Produces:
  - `participants.js`: `recordJoined(db, {convoId, agentDeviceId, initiatorDeviceId}) → {ok, prior}` — a direct `state:'joined'` row via the existing `upsertRow` (approving the spawn approved the pair; no second invite).
  - `journal.js`: `appendAndBroadcast(db, hub, {userId, convoId, sender, type, payload}) → append() result` — append + fan for journal-authored events from outside ws.js's closure. Computes agent targets exactly as ws.js `fanOut` does (client-only events → empty set; else recorded owner + joined participants); skips the push pipeline (journal-authored room lines are not attention-worthy pushes) and sets no `sender_device_id` (there is no producing connection).
  - `spawns.js`: `approveSpawn({db, hub, broker, startTimeoutMs, roomId?}, row) → Promise<'started'|'failed'>` implementing spec step 4/5. Room convo id defaults to `randomUUID()`; injectable for tests.

- [ ] **Step 1: Write the failing tests**

```js
// append to test/agent-spawn.test.js
test('approve: room exists BEFORE start rpc; started outcome carries room and child ids', async (t) => {
  const { s, dan, parentDev, targetDev, clientToken, parent, target, client, spawnId } = await parkedSpawn(t)
  // Bridge side of the start rpc: assert the room already exists when the
  // rpc arrives (ordering is load-bearing), then answer like journal-rpc.js
  const bridgeTurn = target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start').then((req) => {
    assert.equal(req.request.params.prompt, 'do it')
    assert.equal(req.request.params.workdir, '/w')
    const room = s.db.prepare('SELECT * FROM conversations WHERE id=?').get(req.request.params.room_id)
    assert.ok(room, 'room row must exist before the bridge is asked to spawn')
    assert.equal(room.agent_device_id, parentDev.deviceId) // parent owns the room
    target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child-convo-1' } })
    return req.request.params.room_id
  })
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r.status, 200)
  const roomId = await bridgeTurn
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  assert.equal(out.outcome, 'started')
  assert.equal(out.room_id, roomId)
  assert.equal(out.child_convo_id, 'child-convo-1')
  const row = getSpawn(s.db, spawnId)
  assert.equal(row.state, 'started')
  assert.equal(row.room_id, roomId)
  assert.equal(row.child_convo_id, 'child-convo-1')
  // both ends of the pair are in: parent as recorded owner, target joined
  const joined = s.db.prepare('SELECT agent_device_id, state FROM convo_agents WHERE convo_id=?').all(roomId)
  assert.deepEqual(joined, [{ agent_device_id: targetDev.deviceId, state: 'joined' }])
})

test('approve with the target gone by approval time: failed outcome, room gets the epitaph', async (t) => {
  const { s, clientToken, parent, target, spawnId } = await parkedSpawn(t, { serverOpts: { spawnStartTimeoutMs: 30000 } })
  target.close() // box dies between the card and the tap
  await new Promise((r) => setTimeout(r, 50))
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r.status, 200)
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 5000)
  assert.equal(out.outcome, 'failed')
  assert.equal(out.error_code, 'agent_unreachable')
  const row = getSpawn(s.db, spawnId)
  assert.equal(row.state, 'failed')
  // the epitaph line landed in the room (room_id stays null on the FAILED
  // row — it never started — so find the room via the epitaph event itself)
  const epitaph = s.db.prepare("SELECT payload FROM events WHERE type='text' AND sender='journal'").all()
    .map((e) => JSON.parse(e.payload))
  assert.ok(epitaph.some((p) => p.body.includes('spawn failed')))
})

test('start timeout resolves failed — never left hanging', async (t) => {
  const { s, clientToken, parent, spawnId } = await parkedSpawn(t, { serverOpts: { spawnStartTimeoutMs: 100 } })
  // target stays connected but never answers the start rpc
  await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 5000)
  assert.equal(out.outcome, 'failed')
  assert.equal(out.error_code, 'timeout')
  assert.equal(getSpawn(s.db, spawnId).state, 'failed')
})

test('two approve taps spawn once: the loser gets 409 and no second room appears', async (t) => {
  const { s, clientToken, target, spawnId } = await parkedSpawn(t)
  target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start').then((req) => {
    target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child-1' } })
  })
  const [a, b] = await Promise.all([
    s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } }),
    s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } }),
  ])
  assert.deepEqual([a.status, b.status].sort(), [200, 409])
  // exactly one room: the parked row's convo plus ONE new conversation
  await new Promise((r) => setTimeout(r, 200))
  const convos = s.db.prepare("SELECT COUNT(*) c FROM conversations WHERE id != 'parent-convo'").get().c
  assert.equal(convos, 1)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/agent-spawn.test.js`
Expected: FAIL — approve resolves nothing (stub), outcome frames never arrive

- [ ] **Step 3: Implement**

`src/participants.js` — after `parkInvite`:

```js
// A direct joined row, no invite round-trip — the spawn approval path
// (spec: "records both agents as joined; approving the spawn approved the
// pair"). The room owner is recorded on conversations.agent_device_id as
// everywhere else, so only the NON-owner participant gets a row here.
export function recordJoined(db, { convoId, agentDeviceId, initiatorDeviceId }) {
  return upsertRow(db, { convoId, agentDeviceId, initiatorDeviceId, state: 'joined', justification: '', topic: '' })
}
```

`src/journal.js` — after `append` (import `joinedAgentIds` from `./participants.js` at top; note `toEventShape` already lives in this file):

```js
// Append + fan for JOURNAL-authored events (spawn-room lines, room meta) —
// the ws.js fanOut lives inside a connection closure this caller doesn't
// have. Same agent-targeting rules as fanOut: client-only events reach no
// agent; otherwise the recorded owner + joined participants. Differences,
// both deliberate: no sender_device_id (there is no producing connection)
// and no push pipeline (a journal-authored room line is not an
// attention-worthy push).
export function appendAndBroadcast(db, hub, { userId, convoId, sender, type, payload }) {
  const r = append(db, { userId, convoId, sender, type, payload })
  if (r.duplicate) return r
  const frame = { kind: 'journal', ...toEventShape({ seq: r.seq, convo_id: convoId, ts: r.ts, sender, type, payload }) }
  const ownerId = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(convoId)?.agent_device_id ?? null
  const targets = isClientOnlyEvent(type, payload)
    ? new Set()
    : (ownerId == null ? null : new Set([ownerId, ...joinedAgentIds(db, convoId)]))
  hub.broadcastJournal(userId, frame, targets)
  return r
}
```

`src/spawns.js` — replace the Task 7 stub (imports at top: `randomUUID` from `node:crypto`, `upsertConversation, appendAndBroadcast` from `./journal.js`, `recordJoined` from `./participants.js`):

```js
// Spec step 4/5 — everything after the user's tap. Ordering is load-bearing:
// room first, then spawn. Spawning first would, on a room-creation failure,
// leave a live agent on another box with no channel and no provenance. The
// broker's timeout guarantees this settles; every path resolves the row and
// tells the parent exactly once.
export async function approveSpawn({ db, hub, broker, startTimeoutMs, roomId = randomUUID() }, row) {
  const title = row.topic || row.task.slice(0, 80)
  // The parent owns the room (conversations.agent_device_id), the target is
  // its joined participant — the same shape an accepted chat invite leaves.
  upsertConversation(db, { id: roomId, ownerUserId: row.user_id, title, sessionState: 'running', agentDeviceId: row.from_device_id })
  recordJoined(db, { convoId: roomId, agentDeviceId: row.target_device_id, initiatorDeviceId: row.from_device_id })
  // Live clients learn the room exists now, not at their next /snapshot —
  // the same two frames convo_upsert fans for a fresh conversation.
  appendAndBroadcast(db, hub, { userId: row.user_id, convoId: roomId, sender: 'journal', type: 'session_status', payload: { state: 'running' } })
  appendAndBroadcast(db, hub, { userId: row.user_id, convoId: roomId, sender: 'journal', type: 'convo_meta', payload: { title, parent_convo_id: null } })
  const r = await broker.issue(hub, row.user_id, row.target_device_id, 'start',
    { workdir: row.workdir, prompt: row.task, room_id: roomId }, { timeoutMs: startTimeoutMs })
  if (r.ok && typeof r.result?.convo_id === 'string' && r.result.convo_id) {
    markStarted(db, row.id, { roomId, childConvoId: r.result.convo_id })
    hub.sendToDevice(row.user_id, row.from_device_id, {
      kind: 'spawn', event: 'outcome', request_id: row.id, outcome: 'started',
      room_id: roomId, child_convo_id: r.result.convo_id,
    })
    return 'started'
  }
  const code = r.ok ? 'bad_start_reply' : (r.error?.code ?? 'unknown')
  markFailed(db, row.id)
  // The room already exists and both users can see it — it gets the same
  // epitaph a dead chat room gets, then the parent hears failed, once.
  appendAndBroadcast(db, hub, {
    userId: row.user_id, convoId: roomId, sender: 'journal', type: 'text',
    payload: { body: `❌ spawn failed — ${code}. This room's child session never started.` },
  })
  hub.sendToDevice(row.user_id, row.from_device_id, {
    kind: 'spawn', event: 'outcome', request_id: row.id, outcome: 'failed', error_code: code,
  })
  return 'failed'
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/agent-spawn.test.js`
Expected: PASS (all suites in the file)

- [ ] **Step 5: Commit**

```bash
git add src/spawns.js src/participants.js src/journal.js test/agent-spawn.test.js
git commit -m "feat(spawn): approve orchestration — room-first, brokered start, exactly-one outcome"
```

---

### Task 9: Expiry sweep, protocol docs, full suite

**Files:**
- Modify: `src/ws.js` (sweep timer body, after the `expireAwaiting` loop ~line 242), `docs/protocol.md`
- Test: `test/agent-spawn.test.js` (append)

**Interfaces:**
- Consumes: Task 1 `expireSpawns` (rows carry `id, user_id, from_device_id, from_convo_id` — no per-row lookups needed).
- Produces: expired spawns resolve on the existing sweep timer with outcome frame `{kind:'spawn', event:'outcome', request_id, outcome:'expired'}`.

- [ ] **Step 1: Write the failing test**

```js
// append to test/agent-spawn.test.js
test('an unanswered spawn ask expires on the sweep and the parent hears expired', async (t) => {
  const { s, parent, spawnId } = await parkedSpawn(t, { serverOpts: { revocationSweepMs: 100 } })
  // Age the row past the 24h TTL by hand; the next sweep tick must flip it.
  s.db.prepare('UPDATE agent_spawn_requests SET created_at = created_at - (25*60*60*1000) WHERE id=?').run(spawnId)
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 5000)
  assert.equal(out.request_id, spawnId)
  assert.equal(out.outcome, 'expired')
  assert.equal(getSpawn(s.db, spawnId).state, 'expired')
})
```

(Confirm `attachWs` already accepts `revocationSweepMs` as an opt threaded from `startServer` — the invites tests use exactly this pattern; if the opt name differs, match the existing invites-expiry test's server opts verbatim.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/agent-spawn.test.js`
Expected: FAIL — waitFor timeout (nothing sweeps spawn rows)

- [ ] **Step 3: Implement**

In the sweep timer in `src/ws.js`, directly after the `expireAwaiting` loop (import `expireSpawns` from `./spawns.js`):

```js
      // Spawn-ask TTL — same 24h clock as chat's parked asks and the same
      // sweep tick. Unlike chat's masking ('refused', never 'expired'),
      // spawn asks report expiry honestly: spawn denials are already told
      // plainly as 'declined' (there is no peer to hide behind), so
      // distinguishing "the user never answered" from "the user said no"
      // reveals nothing the parent doesn't already learn from a denial.
      // The cap (countPendingAsks) is what stops a re-ask loop, not
      // ambiguity. Rows carry their own user/device ids — no lookups.
      for (const row of expireSpawns(db, AWAITING_USER_TTL_MS)) {
        hub.sendToDevice(row.user_id, row.from_device_id, {
          kind: 'spawn', event: 'outcome', request_id: row.id, outcome: 'expired',
        })
      }
```

- [ ] **Step 4: Document the protocol**

Add a section to `docs/protocol.md` after the agent-chat section, covering exactly what shipped: the two agent ops (`spawn_request`, `spawn_targets`) with field caps and error codes; `POST /agent-spawn/answer` (client-only, no `always_allow`, 404/409 semantics); the `{kind:'spawn'}` frame family (`pending`, `targets`, `outcome` with the five outcome words `started/declined/expired/failed` + `error_code`); the `start` RPC's new `prompt`/`room_id` params and `from_device_id: 0` marking journal-originated requests; the state machine table; the shared pending-ask cap. Follow the doc's existing voice — wire examples as fenced JSON, one paragraph of rationale per design choice, present tense ("the journal issues `start` itself").

- [ ] **Step 5: Run the FULL suite**

Run: `cd ~/matron-journal && npm test`
Expected: all green — 611 baseline tests plus the new suites, zero failures. Fix anything the integration shook loose before committing.

- [ ] **Step 6: Commit**

```bash
git add src/ws.js docs/protocol.md test/agent-spawn.test.js
git commit -m "feat(spawn): expiry sweep + protocol docs"
```

---

## Self-Review (completed at plan time)

- **Spec coverage:** schema ✓ (T1 verbatim), state claims/409 ✓ (T1/T7/T8), cross-table cap with the spec's named three-way test ✓ (T2), broker + timeout ✓ (T3), `agent_response` journal branch ✓ (T4), `spawn_request` + unreachable-before-card + card discipline ✓ (T5), `spawn_targets` + private/self exclusion + folder brokering ✓ (T6), answer endpoint incl. agent-403/404/`always_allow` ✓ (T7), room-first ordering + joined pair + start RPC + epitaph + exactly-one outcome ✓ (T8), 24h expiry sweep ✓ (T9), anti-enumeration everywhere ✓ (T5/T7). Deliberately journal-only: the `agent_boxes`/`agent_session_start` MCP tools, the bridge's `start` prompt/room handling, and the app card are the next plans (ship order 3–4).
- **Decision made at plan time, worth flagging in the PR:** expiry is reported to the parent as `expired` (not masked as `declined`) — rationale in the T9 sweep comment; the spec lists `expired` as a distinct state and only mandates masking for chat.
- **Placeholder scan:** clean — every step carries runnable code or an exact command.
- **Type consistency:** `getSpawn`/`denySpawn`/`claimApprove`/`markStarted`/`markFailed`/`expireSpawns`/`countPendingAsks`/`approveSpawn` names and signatures match across T1/T2/T7/T8; wire vocabulary (`kind:'spawn'`, event/outcome words, `from_device_id: 0`) is identical in T3/T4/T5/T6/T8/T9 and the docs task.
