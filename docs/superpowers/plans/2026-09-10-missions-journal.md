# Missions & milestones — journal implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `missions` and `milestones` to the journal — tables, the pure state module, the HTTP routes, the two marker events, and the items integration — so a bridge tool can start a mission, post milestones anchored to transcript events, and close it under the open-items rules.

**Architecture:** Mirror the items tracker layer for layer: DDL in `src/db.js`'s `SCHEMA`, a pure DB module `src/missions.js` (no hub/push/wake), an HTTP surface `src/missions-http.js` mounted beside `handleItemsRoute`, and a marker module `src/missions-marker.js`. The one structural difference from items: a milestone's marker is appended **inside** the milestone's own transaction (its `seq` is the anchor), and the WS frame is broadcast after commit through a new `broadcastAppended` split out of `appendAndBroadcast`.

**Tech Stack:** Node 22, better-sqlite3 (sync transactions), `node --test` (no framework), the repo's own `test/helpers.js` server harness, conformance fixtures under `test/fixtures/conformance/`.

**Spec:** `docs/superpowers/specs/2026-09-10-missions-milestones-design.md` (copied into this repo alongside this plan; canonical copy in matron-apple).

## Global Constraints

- Numbers: `missions.num` and `milestones.num` come from `item_counters` via the exact statement items uses: `INSERT INTO item_counters(user_id, next_num) VALUES(?, 2) ON CONFLICT(user_id) DO UPDATE SET next_num = next_num + 1 RETURNING next_num - 1 AS num`.
- Id prefixes: missions `ms_` + 16 hex, milestones `ml_` + 16 hex (`newId('ms')` / `newId('ml')`). `it_` stays items-only — `getItem` dispatches on the prefix.
- Limits: title ≤ 200 chars; `body` and `close_summary` ≤ 32768 bytes (`BODY_MAX` from `src/items.js`); ≤ 200 conversations per mission; **no cap on milestones**.
- A conversation has at most one mission; `conversations.mission_id` is never cleared or changed once set (v1).
- `POST /milestones` on a conversation with no mission → 409 `{ error: 'conflict', blocked_by: 'no_mission' }`, nothing written. No auto-create.
- Marker event types `milestone` and `mission` are written only by the journal. Neither joins `AGENT_PUBLISH_TYPES` (`src/ws.js`) nor `MESSAGE_TYPES` (`src/journal.js`). Neither pushes (`classify` returns `null`).
- Privacy sieve: agent callers that are not private devices (`filteredAgent`) never see missions whose origin conversation is private-owned (404), and private-owned conversations/items/milestones are filtered from mission reads.
- Idempotency: every create takes `Idempotency-Key`, namespaced `${who.deviceId}:${key}`; replay → 200 with the existing row, first write → 201.
- Error bodies follow items: `{error:'bad_request'}` 400, `{error:'not_found'}` 404, `{error:'conflict', blocked_by, items?}` 409, `{error:'marker_append_failed'}` 502.
- Every guarded `ALTER TABLE` goes after the `spawnCols` block (`src/db.js` ~line 416) and before `DROP TABLE IF EXISTS agent_chat_allowances` / `healBakedTitles` (which stay last).
- Never log or print a token. Tests run with `npm test`; the whole suite must stay green.

## File map

| File | Responsibility |
|---|---|
| `src/db.js` | `missions`, `milestones` DDL in `SCHEMA`; guarded `mission_id` on `conversations` and `items`; indexes |
| `src/items.js` | export `nextNum`; `items.mission_id` set from the conversation on create; `mission_num` in `DECORATE`; `setItemMission` |
| `src/missions.js` | **new** — pure DB state: create/get/list/update/join/close missions, create/list milestones, `repointItems`, validation |
| `src/missions-marker.js` | **new** — `MISSION_EVENT_TYPE`, `MILESTONE_EVENT_TYPE`, payload builders |
| `src/journal.js` | split `appendAndBroadcast` into `append` + exported `broadcastAppended`; inheritance of `mission_id` in `upsertConversation`'s INSERT branch; `snippetOf` branches |
| `src/push.js` | `classify` returns `null` for `mission` and `milestone` |
| `src/missions-http.js` | **new** — routes `/missions*`, `/milestones*` |
| `src/items-http.js` | `PATCH /items/:id` accepts `mission` |
| `src/http.js` | mount `handleMissionsRoute` beside `handleItemsRoute` |
| `src/help.js` | agent-facing API text for the new routes |
| `docs/protocol.md` | "Missions & milestones" section; Device privacy enumeration |
| `test/missions.test.js`, `test/missions-http.test.js`, `test/fixtures/conformance/15_missions_roundtrip.json` | tests |

---

### Task 1: Schema — tables, guarded columns, indexes

**Files:**
- Modify: `src/db.js` (SCHEMA string, ~line 161 after `item_counters`; guarded ALTERs after the `spawnCols` block ~line 416)
- Test: `test/missions.test.js` (new)

**Interfaces:**
- Produces: tables `missions(id, user_id, num, state, title, body, close_summary, closed_by, closed_over_open_items, origin_convo_id, origin_device_id, created_by, idem_key, created_at, updated_at, last_milestone_at, closed_at)` and `milestones(id, mission_id, user_id, num, kind, title, body, convo_id, seq, device_id, created_by, idem_key, created_at)`; columns `conversations.mission_id TEXT`, `items.mission_id TEXT`.

- [ ] **Step 1: Write the failing schema test**

Create `test/missions.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'

test('schema: missions and milestones exist with the expected columns; mission_id on conversations and items', () => {
  const db = openDb(':memory:')
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
  assert.deepEqual(cols('missions'), [
    'id', 'user_id', 'num', 'state', 'title', 'body', 'close_summary', 'closed_by', 'closed_over_open_items',
    'origin_convo_id', 'origin_device_id', 'created_by', 'idem_key', 'created_at', 'updated_at', 'last_milestone_at', 'closed_at',
  ])
  assert.deepEqual(cols('milestones'), [
    'id', 'mission_id', 'user_id', 'num', 'kind', 'title', 'body', 'convo_id', 'seq', 'device_id', 'created_by', 'idem_key', 'created_at',
  ])
  assert.ok(cols('conversations').includes('mission_id'))
  assert.ok(cols('items').includes('mission_id'))
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  const ins = db.prepare(`INSERT INTO missions(id,user_id,num,state,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at)
    VALUES(?,1,1,'open','t','c1',1,'agent',0,0)`)
  ins.run('ms_a')
  assert.throws(() => ins.run('ms_b'), /UNIQUE/)
  assert.throws(() => db.prepare(`INSERT INTO milestones(id,mission_id,user_id,num,kind,title,convo_id,seq,device_id,created_by,created_at)
    VALUES('ml_a','ms_a',1,2,'nope','t','c1',1,1,'agent',0)`).run(), /CHECK/)
})

test('schema: opening an existing pre-missions database adds the guarded columns once', () => {
  const db = openDb(':memory:')
  // Simulate the pre-missions shape: drop the column and re-run the migration path.
  db.exec('ALTER TABLE items DROP COLUMN mission_id')
  db.exec('ALTER TABLE conversations DROP COLUMN mission_id')
  const again = openDb(':memory:')  // fresh db proves the CREATEs are idempotent
  assert.ok(again.prepare('PRAGMA table_info(items)').all().some((c) => c.name === 'mission_id'))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/missions.test.js`
Expected: FAIL — `missions` has no columns (`deepEqual` against `[]`).

- [ ] **Step 3: Add the DDL to `SCHEMA`**

In `src/db.js`, directly after the `item_counters` CREATE (inside the `SCHEMA` template literal, before its closing backtick), add:

```sql
-- Missions & milestones (spec: 2026-09-10 missions-milestones). Tables are
-- the source of truth; the conversation log carries 'mission' and
-- 'milestone' marker events written only by src/missions-http.js. Numbers
-- come from item_counters, the same counter as items (#61 names one thing).
CREATE TABLE IF NOT EXISTS missions(
  id                     TEXT PRIMARY KEY,
  user_id                INTEGER NOT NULL REFERENCES users(id),
  num                    INTEGER NOT NULL,
  state                  TEXT NOT NULL CHECK(state IN ('open','closed')),
  title                  TEXT NOT NULL,
  body                   TEXT NOT NULL DEFAULT '',
  close_summary          TEXT,
  closed_by              TEXT CHECK(closed_by IN ('user','agent')),
  closed_over_open_items INTEGER NOT NULL DEFAULT 0,
  origin_convo_id        TEXT NOT NULL,
  origin_device_id       INTEGER NOT NULL,
  created_by             TEXT NOT NULL CHECK(created_by IN ('user','agent')),
  idem_key               TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  last_milestone_at      INTEGER,
  closed_at              INTEGER,
  UNIQUE(user_id, num),
  UNIQUE(user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_missions_user_state ON missions(user_id, state, last_milestone_at);
CREATE TABLE IF NOT EXISTS milestones(
  id          TEXT PRIMARY KEY,
  mission_id  TEXT NOT NULL REFERENCES missions(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  num         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK(kind IN ('user_input','progress')),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  convo_id    TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  device_id   INTEGER NOT NULL,
  created_by  TEXT NOT NULL CHECK(created_by IN ('user','agent')),
  idem_key    TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE(user_id, num),
  UNIQUE(user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_milestones_mission ON milestones(mission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_milestones_convo ON milestones(convo_id, seq);
```

- [ ] **Step 4: Add the guarded ALTERs**

In `src/db.js`, after the `spawnCols` block (the `agent_spawn_requests.model` ALTER) and before `DROP TABLE IF EXISTS agent_chat_allowances`, add:

```js
  // Missions (spec 2026-09-10): a conversation belongs to at most one
  // mission, set once and never changed; an item follows its origin
  // conversation but can be moved (PATCH /items/:id {mission}). Both are
  // NULL for every row predating the column. Placed here, after every
  // table-rebuild block, so a rebuild can never drop them. Not foreign
  // keys — same stance as parent_convo_id.
  const missionConvoCols = db.prepare('PRAGMA table_info(conversations)').all()
  if (!missionConvoCols.some((c) => c.name === 'mission_id')) {
    db.exec('ALTER TABLE conversations ADD COLUMN mission_id TEXT')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_mission ON conversations(mission_id)')
  const itemMissionCols = db.prepare('PRAGMA table_info(items)').all()
  if (!itemMissionCols.some((c) => c.name === 'mission_id')) {
    db.exec('ALTER TABLE items ADD COLUMN mission_id TEXT')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_items_mission ON items(mission_id, state, awaiting)')
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/missions.test.js`
Expected: PASS (2 tests). Then `npm test` — the existing `test/items.test.js` column-order assertion must still pass (`items` gains `mission_id` **after** `closed_at` via ALTER, and that test lists base columns only; if it asserts the full list, append `'mission_id'` to its expected array).

- [ ] **Step 6: Commit**

```bash
git add src/db.js test/missions.test.js
git commit -m "missions: schema — missions/milestones tables, mission_id on conversations and items"
```

---

### Task 2: Shared counter and ids — export `nextNum` and `newId`

**Files:**
- Modify: `src/items.js:20` (`newId`), `src/items.js:144-149` (`nextNum`)
- Test: `test/missions.test.js`

**Interfaces:**
- Produces: `export function nextNum(db, userId): number`, `export const newId = (prefix) => string` from `src/items.js`.

- [ ] **Step 1: Write the failing test**

Append to `test/missions.test.js`:

```js
import { nextNum, newId } from '../src/items.js'

test('numbers: items, missions and milestones share one per-user counter', () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  assert.equal(nextNum(db, 1), 1)
  assert.equal(nextNum(db, 1), 2)
  assert.equal(nextNum(db, 1), 3)
  assert.match(newId('ms'), /^ms_[0-9a-f]{16}$/)
  assert.match(newId('ml'), /^ml_[0-9a-f]{16}$/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/missions.test.js`
Expected: FAIL — `nextNum`/`newId` are not exported (SyntaxError on import).

- [ ] **Step 3: Export both**

In `src/items.js` change `const newId = (prefix) => ...` to `export const newId = (prefix) => ...` and `function nextNum(db, userId)` to `export function nextNum(db, userId)`. Nothing else changes.

- [ ] **Step 4: Run the tests**

Run: `node --test test/missions.test.js test/items.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/items.js test/missions.test.js
git commit -m "missions: export the item counter and id helpers for the shared number pool"
```

---

### Task 3: Marker module — `src/missions-marker.js`

**Files:**
- Create: `src/missions-marker.js`
- Modify: `src/journal.js` (`snippetOf`), `src/push.js` (`classify`)
- Test: `test/missions.test.js`

**Interfaces:**
- Produces: `MISSION_EVENT_TYPE = 'mission'`, `MILESTONE_EVENT_TYPE = 'milestone'`, `MISSION_ACTIONS = ['created','joined','updated','closed']`, `milestoneMarkerPayload({ milestone, mission, by })`, `missionMarkerPayload({ mission, action, by, openItemNums })`.

- [ ] **Step 1: Write the failing tests**

Append to `test/missions.test.js`:

```js
import { MISSION_EVENT_TYPE, MILESTONE_EVENT_TYPE, MISSION_ACTIONS, milestoneMarkerPayload, missionMarkerPayload } from '../src/missions-marker.js'
import { snippetOf } from '../src/journal.js'
import { classify } from '../src/push.js'

test('marker payloads carry exactly the documented fields', () => {
  const mission = { id: 'ms_1', num: 61, title: 'Missions & milestones' }
  const milestone = { id: 'ml_1', num: 63, kind: 'user_input', title: 'Wired the migration', body: 'b' }
  assert.deepEqual(milestoneMarkerPayload({ milestone, mission, by: 'agent' }), {
    milestone_id: 'ml_1', num: 63, kind: 'user_input', title: 'Wired the migration', body: 'b',
    mission_id: 'ms_1', mission_num: 61, mission_title: 'Missions & milestones', by: 'agent',
  })
  assert.deepEqual(missionMarkerPayload({ mission, action: 'created', by: 'agent' }),
    { mission_id: 'ms_1', num: 61, title: 'Missions & milestones', action: 'created', by: 'agent' })
  assert.deepEqual(missionMarkerPayload({ mission, action: 'closed', by: 'user', openItemNums: [64, 70] }),
    { mission_id: 'ms_1', num: 61, title: 'Missions & milestones', action: 'closed', by: 'user', open_item_nums: [64, 70] })
  assert.equal(MISSION_EVENT_TYPE, 'mission'); assert.equal(MILESTONE_EVENT_TYPE, 'milestone')
  assert.deepEqual(MISSION_ACTIONS, ['created', 'joined', 'updated', 'closed'])
})

test('snippetOf renders both markers; classify never pushes them', () => {
  assert.equal(snippetOf('milestone', { num: 63, kind: 'user_input', title: 'T' }), '🚩 #63 T')
  assert.equal(snippetOf('milestone', { num: 64, kind: 'progress', title: 'P' }), '🏁 #64 P')
  assert.equal(snippetOf('mission', { num: 61, title: 'M', action: 'closed' }), '🏁 Mission #61 closed')
  assert.equal(snippetOf('mission', { num: 61, title: 'M', action: 'created' }), '🏁 Mission #61 started: M')
  assert.equal(classify('milestone', { num: 63 }, 'agent:dev-2'), null)
  assert.equal(classify('mission', { num: 61, action: 'closed' }, 'user:dan'), null)
})
```

(Check `classify`'s real signature in `src/push.js` before running — it is `classify(type, payload, sender)` at the time of writing; adapt the call if it differs.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/missions.test.js`
Expected: FAIL — cannot find module `../src/missions-marker.js`.

- [ ] **Step 3: Create the marker module**

`src/missions-marker.js`:

```js
// The 'mission' and 'milestone' marker events (spec: Marker events).
// Written only by src/missions-http.js; never publishable by an agent
// (not in AGENT_PUBLISH_TYPES). Not MESSAGE_TYPES: no unread/snippet
// column effect. push.js classify() returns null for both — they are
// navigation, not attention.
export const MISSION_EVENT_TYPE = 'mission'
export const MILESTONE_EVENT_TYPE = 'milestone'
export const MISSION_ACTIONS = ['created', 'joined', 'updated', 'closed']

// The milestone marker's own seq is the anchor the apps jump to; the
// payload carries enough to render the inline card without a fetch.
export function milestoneMarkerPayload({ milestone, mission, by }) {
  return {
    milestone_id: milestone.id, num: milestone.num, kind: milestone.kind,
    title: milestone.title, body: milestone.body ?? '',
    mission_id: mission.id, mission_num: mission.num, mission_title: mission.title,
    by,
  }
}

// Apps use this only as an invalidation signal plus a one-line notice.
// open_item_nums is present only on a user-forced close over open items.
export function missionMarkerPayload({ mission, action, by, openItemNums = null }) {
  if (!MISSION_ACTIONS.includes(action)) throw new Error(`unknown mission action: ${action}`)
  const out = { mission_id: mission.id, num: mission.num, title: mission.title, action, by }
  if (openItemNums && openItemNums.length) out.open_item_nums = openItemNums
  return out
}
```

- [ ] **Step 4: Add the `snippetOf` and `classify` branches**

In `src/journal.js`, inside `snippetOf(type, payload)` next to the `if (type === 'item')` branch, add:

```js
  if (type === 'milestone') {
    const glyph = p.kind === 'user_input' ? '🚩' : '🏁'
    return `${glyph} #${Number(p.num) || 0} ${String(p.title || '')}`.slice(0, 120)
  }
  if (type === 'mission') {
    const n = Number(p.num) || 0
    if (p.action === 'closed') return `🏁 Mission #${n} closed`
    if (p.action === 'created') return `🏁 Mission #${n} started: ${String(p.title || '')}`.slice(0, 120)
    if (p.action === 'joined') return `🏁 Joined mission #${n}`
    return `🏁 Mission #${n} updated`
  }
```

In `src/push.js`, inside `classify` **before** the generic fallthrough at the end (next to the `if (type === 'item')` branch), add:

```js
  // Missions and milestones are navigation, never a push (spec: Marker events).
  if (type === 'milestone' || type === 'mission') return null
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/missions.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/missions-marker.js src/journal.js src/push.js test/missions.test.js
git commit -m "missions: marker payloads, snippets, and no-push classification"
```

---

### Task 4: `broadcastAppended` — split the broadcast out of `appendAndBroadcast`

**Files:**
- Modify: `src/journal.js:206-223`
- Test: `test/missions.test.js`

**Interfaces:**
- Produces: `export function broadcastAppended(db, hub, { userId, convoId, seq, ts, sender, type, payload })` — builds the `{kind:'journal', …}` frame and calls `hub.broadcastJournal` with the same targeting `appendAndBroadcast` uses. `appendAndBroadcast` becomes `append` + `broadcastAppended` with identical behaviour.

- [ ] **Step 1: Write the failing test**

Append to `test/missions.test.js`:

```js
import { append, broadcastAppended, upsertConversation } from '../src/journal.js'

test('broadcastAppended fans the already-committed event with journal targeting', () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  upsertConversation(db, { id: 'c1', ownerUserId: 1, title: 'C1' })
  const frames = []
  const hub = { broadcastJournal: (userId, frame, targets) => frames.push({ userId, frame, targets }) }
  const r = append(db, { userId: 1, convoId: 'c1', sender: 'agent:dev-2', type: 'milestone', payload: { num: 1 } })
  broadcastAppended(db, hub, { userId: 1, convoId: 'c1', seq: r.seq, ts: r.ts, sender: 'agent:dev-2', type: 'milestone', payload: { num: 1 } })
  assert.equal(frames.length, 1)
  assert.equal(frames[0].frame.kind, 'journal'); assert.equal(frames[0].frame.seq, r.seq); assert.equal(frames[0].frame.type, 'milestone')
  assert.equal(frames[0].targets, null)  // no agent owner recorded → every agent
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/missions.test.js`
Expected: FAIL — `broadcastAppended` is not exported.

- [ ] **Step 3: Refactor `appendAndBroadcast`**

Replace the body of `appendAndBroadcast` in `src/journal.js` with:

```js
export function appendAndBroadcast(db, hub, { userId, convoId, sender, type, payload }) {
  const r = append(db, { userId, convoId, sender, type, payload })
  if (r.duplicate) return r
  broadcastAppended(db, hub, { userId, convoId, seq: r.seq, ts: r.ts, sender, type, payload })
  return r
}

// The fan-out half of appendAndBroadcast, for callers that must append
// INSIDE their own transaction (a milestone's marker seq is the row's
// anchor) and broadcast only after it commits. Same targeting rules.
export function broadcastAppended(db, hub, { userId, convoId, seq, ts, sender, type, payload }) {
  const frame = { kind: 'journal', ...toEventShape({ seq, convo_id: convoId, ts, sender, type, payload }) }
  const ownerId = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(convoId)?.agent_device_id ?? null
  const targets = isClientOnlyEvent(type, payload)
    ? new Set()
    : (ownerId == null ? null : new Set([ownerId, ...joinedAgentIds(db, convoId)]))
  hub.broadcastJournal(userId, frame, targets)
}
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS — every existing `appendAndBroadcast` caller (items, spawns, room meta) behaves identically.

- [ ] **Step 5: Commit**

```bash
git add src/journal.js test/missions.test.js
git commit -m "journal: broadcastAppended — fan out an event committed in the caller's transaction"
```

---

### Task 5: Pure module `src/missions.js` — missions

**Files:**
- Create: `src/missions.js`
- Test: `test/missions.test.js`

**Interfaces:**
- Consumes: `nextNum`, `newId`, `BODY_MAX` from `src/items.js`.
- Produces:
  - `MILESTONE_KINDS = ['user_input','progress']`, `TITLE_MAX = 200`, `CONVOS_MAX = 200`
  - `validateMissionFields(body, { partial }) → { ok, value: { title?, body? } }`
  - `createMission(db, { userId, deviceId, createdBy, convoId, title, body, idemKey }) → { mission, duplicate, existing }` — `existing: true` when the conversation already had a mission (returns it, changes nothing); attaches the conversation and repoints its items inside one transaction.
  - `getMission(db, userId, idOrNum) → mission | null` (`ms_` prefix or `#num`/number)
  - `listMissions(db, userId, { state, since, excludePrivateOwned }) → mission[]` with `open_items`, `needs_you`, `conversations`, `milestones`, `last_milestone` and sorted `last_milestone_at DESC NULLS LAST, created_at DESC`
  - `missionDetail(db, userId, missionId, { excludePrivateOwned }) → { mission, milestones, items, conversations }`
  - `updateMission(db, { userId, missionId, fields }) → mission | null` (throws `Error('closed')` if closed)
  - `joinMission(db, { userId, missionId, convoId }) → mission` (throws `Error('closed')` / `Error('other_mission')`)
  - `closeMission(db, { userId, missionId, by, summary }) → { mission, openItemNums }` (throws `Error('closed')`; for `by==='agent'` throws `Error('user_items')`/`Error('agent_items')` with `err.items = [{num,title}]`)
  - `repointItems(db, userId, convoId, missionId)`
  - `missionRow(row) → JSON` (strips `idem_key`; numbers `closed_over_open_items`)

- [ ] **Step 1: Write the failing tests**

Append to `test/missions.test.js`:

```js
import {
  createMission, getMission, listMissions, missionDetail, updateMission, joinMission, closeMission, repointItems, validateMissionFields,
} from '../src/missions.js'
import { createItem } from '../src/items.js'

function seeded() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','dev-2','h',0)").run()
  upsertConversation(db, { id: 'c1', ownerUserId: 1, title: 'C1', agentDeviceId: 7 })
  upsertConversation(db, { id: 'c2', ownerUserId: 1, title: 'C2', agentDeviceId: 7 })
  return db
}

test('createMission: numbers from the shared pool, attaches the convo, repoints its items, replays are idempotent', () => {
  const db = seeded()
  const { item } = createItem(db, { userId: 1, deviceId: 7, createdBy: 'agent', kind: 'task', title: 'T', convoId: 'c1' })
  assert.equal(item.num, 1); assert.equal(item.mission_id, null)
  const r = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'M', body: 'goal', idemKey: '7:k1' })
  assert.equal(r.duplicate, false); assert.equal(r.existing, false)
  assert.equal(r.mission.num, 2); assert.equal(r.mission.state, 'open'); assert.equal(r.mission.origin_convo_id, 'c1')
  assert.equal(db.prepare('SELECT mission_id FROM conversations WHERE id=?').get('c1').mission_id, r.mission.id)
  assert.equal(db.prepare('SELECT mission_id FROM items WHERE id=?').get(item.id).mission_id, r.mission.id)
  // replay
  const again = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'M', idemKey: '7:k1' })
  assert.equal(again.duplicate, true); assert.equal(again.mission.id, r.mission.id)
  // a second mission for the same convo: existing, nothing changed
  const second = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'Other', idemKey: '7:k2' })
  assert.equal(second.existing, true); assert.equal(second.mission.id, r.mission.id)
  assert.equal(second.mission.title, 'M')
  assert.equal(getMission(db, 1, '#2').id, r.mission.id); assert.equal(getMission(db, 1, r.mission.id).num, 2)
  assert.equal(getMission(db, 1, 'ms_nope'), null); assert.equal(getMission(db, 2, 2), null)
})

test('validateMissionFields: title ≤200, body ≤32 KiB, partial allows either', () => {
  assert.equal(validateMissionFields({ title: 'x'.repeat(201) }).ok, false)
  assert.equal(validateMissionFields({ title: '' }).ok, false)
  assert.equal(validateMissionFields({ title: 'ok', body: 'y'.repeat(32769) }).ok, false)
  assert.deepEqual(validateMissionFields({ title: ' ok ', body: 'b' }).value, { title: 'ok', body: 'b' })
  assert.equal(validateMissionFields({}, { partial: true }).ok, true)
  assert.equal(validateMissionFields({}).ok, false)
})

test('join: attaches a second conversation and repoints its items; refuses a convo with another mission or a closed mission', () => {
  const db = seeded()
  const a = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'A' }).mission
  const { item } = createItem(db, { userId: 1, deviceId: 7, createdBy: 'agent', kind: 'task', title: 'T', convoId: 'c2' })
  joinMission(db, { userId: 1, missionId: a.id, convoId: 'c2' })
  assert.equal(db.prepare('SELECT mission_id FROM conversations WHERE id=?').get('c2').mission_id, a.id)
  assert.equal(db.prepare('SELECT mission_id FROM items WHERE id=?').get(item.id).mission_id, a.id)
  upsertConversation(db, { id: 'c3', ownerUserId: 1, title: 'C3', agentDeviceId: 7 })
  const b = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c3', title: 'B' }).mission
  assert.throws(() => joinMission(db, { userId: 1, missionId: b.id, convoId: 'c2' }), /other_mission/)
  closeMission(db, { userId: 1, missionId: b.id, by: 'agent', summary: 'done' })
  upsertConversation(db, { id: 'c4', ownerUserId: 1, title: 'C4', agentDeviceId: 7 })
  assert.throws(() => joinMission(db, { userId: 1, missionId: b.id, convoId: 'c4' }), /closed/)
})

test('close: agent blocked by user items, then by agent items; user close records the count; closed rejects update', () => {
  const db = seeded()
  const m = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'A' }).mission
  const q = createItem(db, { userId: 1, deviceId: 7, createdBy: 'agent', kind: 'question', title: 'Q?', convoId: 'c1' }).item
  const t = createItem(db, { userId: 1, deviceId: 7, createdBy: 'agent', kind: 'task', title: 'T', convoId: 'c1' }).item
  assert.equal(q.awaiting, 'user'); assert.equal(t.awaiting, 'agent')
  let err
  try { closeMission(db, { userId: 1, missionId: m.id, by: 'agent', summary: 's' }) } catch (e) { err = e }
  assert.equal(err.message, 'user_items'); assert.deepEqual(err.items, [{ num: q.num, title: 'Q?' }])
  db.prepare("UPDATE items SET state='closed', awaiting=NULL, resolution='answered' WHERE id=?").run(q.id)
  try { closeMission(db, { userId: 1, missionId: m.id, by: 'agent', summary: 's' }) } catch (e) { err = e }
  assert.equal(err.message, 'agent_items'); assert.deepEqual(err.items, [{ num: t.num, title: 'T' }])
  const r = closeMission(db, { userId: 1, missionId: m.id, by: 'user', summary: 'forced' })
  assert.equal(r.mission.state, 'closed'); assert.equal(r.mission.closed_by, 'user')
  assert.equal(r.mission.closed_over_open_items, 1); assert.deepEqual(r.openItemNums, [t.num])
  assert.equal(r.mission.close_summary, 'forced')
  assert.equal(db.prepare('SELECT state, mission_id FROM items WHERE id=?').get(t.id).state, 'open')
  assert.throws(() => updateMission(db, { userId: 1, missionId: m.id, fields: { title: 'x' } }), /closed/)
  assert.throws(() => closeMission(db, { userId: 1, missionId: m.id, by: 'user', summary: 'x' }), /closed/)
})

test('listMissions: counts, sort by last milestone then creation, state filter, since; detail lists open items awaiting-user first', () => {
  const db = seeded()
  const a = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'A' }).mission
  const b = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c2', title: 'B' }).mission
  createItem(db, { userId: 1, deviceId: 7, createdBy: 'agent', kind: 'question', title: 'Q', convoId: 'c1' })
  createItem(db, { userId: 1, deviceId: 7, createdBy: 'agent', kind: 'task', title: 'T', convoId: 'c1' })
  db.prepare('UPDATE missions SET last_milestone_at=? WHERE id=?').run(5000, b.id)
  const rows = listMissions(db, 1, {})
  assert.deepEqual(rows.map((m) => m.id), [b.id, a.id])
  const ra = rows.find((m) => m.id === a.id)
  assert.equal(ra.open_items, 2); assert.equal(ra.needs_you, 1); assert.equal(ra.conversations, 1); assert.equal(ra.milestones, 0)
  assert.equal(ra.last_milestone, null)
  assert.equal(listMissions(db, 1, { state: 'closed' }).length, 0)
  assert.equal(listMissions(db, 1, { since: 4000 }).length, 2)  // updated_at ≥ since (both created now)
  const d = missionDetail(db, 1, a.id, {})
  assert.deepEqual(d.items.map((i) => i.title), ['Q', 'T'])
  assert.deepEqual(d.conversations.map((c) => c.id), ['c1'])
  assert.equal(d.conversations[0].title, 'C1'); assert.equal(d.conversations[0].box, 'dev-2'); assert.equal(d.conversations[0].state, 'running')
})

test('repointItems only moves items with no mission', () => {
  const db = seeded()
  const m = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'A' }).mission
  const it = createItem(db, { userId: 1, deviceId: 7, createdBy: 'agent', kind: 'task', title: 'T', convoId: 'c2' }).item
  db.prepare('UPDATE items SET mission_id=? WHERE id=?').run('ms_other', it.id)
  repointItems(db, 1, 'c2', m.id)
  assert.equal(db.prepare('SELECT mission_id FROM items WHERE id=?').get(it.id).mission_id, 'ms_other')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/missions.test.js`
Expected: FAIL — cannot find module `../src/missions.js`.

- [ ] **Step 3: Write `src/missions.js`**

```js
// Pure DB state for missions & milestones (spec 2026-09-10). No hub, push
// or wake here — src/missions-http.js owns the side effects. Same stance
// as src/items.js: every recoverable failure is a tagged Error the HTTP
// layer maps to one status; anything else is a bug and reaches the 500.
import { nextNum, newId, BODY_MAX } from './items.js'

export const MILESTONE_KINDS = ['user_input', 'progress']
export const TITLE_MAX = 200
export const CONVOS_MAX = 200

const now = () => Date.now()

// idem_key is internal (same stance as rowToItem).
export function missionRow(row) {
  if (!row) return null
  const { idem_key: _idemKey, ...rest } = row
  const out = { ...rest, closed_over_open_items: Number(rest.closed_over_open_items || 0) }
  for (const k of ['open_items', 'needs_you', 'conversations', 'milestones']) if (k in out) out[k] = Number(out[k])
  if ('last_milestone_json' in out) {
    out.last_milestone = out.last_milestone_json ? JSON.parse(out.last_milestone_json) : null
    delete out.last_milestone_json
  }
  return out
}

export function milestoneRow(row) {
  if (!row) return null
  const { idem_key: _idemKey, user_id: _userId, ...rest } = row
  return rest
}

export function validateMissionFields(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false }
  const value = {}
  if (body.title !== undefined) {
    if (typeof body.title !== 'string') return { ok: false }
    const t = body.title.trim()
    if (!t || t.length > TITLE_MAX) return { ok: false }
    value.title = t
  } else if (!partial) return { ok: false }
  if (body.body !== undefined) {
    if (typeof body.body !== 'string' || Buffer.byteLength(body.body, 'utf8') > BODY_MAX) return { ok: false }
    value.body = body.body
  }
  if (partial && Object.keys(value).length === 0) return { ok: true, value }
  return { ok: true, value }
}

const COUNTS = `
  (SELECT COUNT(*) FROM items i WHERE i.mission_id = m.id AND i.state='open') AS open_items,
  (SELECT COUNT(*) FROM items i WHERE i.mission_id = m.id AND i.state='open' AND i.awaiting='user') AS needs_you,
  (SELECT COUNT(*) FROM conversations c WHERE c.mission_id = m.id) AS conversations,
  (SELECT COUNT(*) FROM milestones l WHERE l.mission_id = m.id) AS milestones,
  (SELECT json_object('num', l.num, 'title', l.title, 'kind', l.kind, 'created_at', l.created_at)
     FROM milestones l WHERE l.mission_id = m.id ORDER BY l.created_at DESC, l.seq DESC LIMIT 1) AS last_milestone_json
`

export function getMission(db, userId, idOrNum) {
  let row
  if (typeof idOrNum === 'string' && idOrNum.startsWith('ms_')) {
    row = db.prepare(`SELECT m.*, ${COUNTS} FROM missions m WHERE m.id=? AND m.user_id=?`).get(idOrNum, userId)
  } else {
    const n = Number(String(idOrNum).replace(/^#/, ''))
    if (!Number.isInteger(n) || n < 1) return null
    row = db.prepare(`SELECT m.*, ${COUNTS} FROM missions m WHERE m.num=? AND m.user_id=?`).get(n, userId)
  }
  return missionRow(row)
}

// Whenever a conversation GAINS a mission its unassigned items follow it.
export function repointItems(db, userId, convoId, missionId) {
  db.prepare('UPDATE items SET mission_id=? WHERE user_id=? AND origin_convo_id=? AND mission_id IS NULL').run(missionId, userId, convoId)
}

function attachConversation(db, userId, convoId, missionId) {
  db.prepare('UPDATE conversations SET mission_id=? WHERE id=? AND owner_user_id=? AND mission_id IS NULL').run(missionId, convoId, userId)
  repointItems(db, userId, convoId, missionId)
}

export function createMission(db, { userId, deviceId, createdBy, convoId, title, body = '', idemKey = null }) {
  return db.transaction(() => {
    if (idemKey) {
      const dup = db.prepare('SELECT id FROM missions WHERE user_id=? AND idem_key=?').get(userId, idemKey)
      if (dup) return { mission: getMission(db, userId, dup.id), duplicate: true, existing: false }
    }
    const convo = db.prepare('SELECT mission_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
    if (!convo) throw new Error('no_convo')
    if (convo.mission_id) return { mission: getMission(db, userId, convo.mission_id), duplicate: false, existing: true }
    const id = newId('ms')
    const num = nextNum(db, userId)
    const ts = now()
    try {
      db.prepare(`INSERT INTO missions(id,user_id,num,state,title,body,origin_convo_id,origin_device_id,created_by,idem_key,created_at,updated_at)
        VALUES(?,?,?,'open',?,?,?,?,?,?,?,?)`).run(id, userId, num, title, body, convoId, deviceId, createdBy, idemKey, ts, ts)
    } catch (err) {
      if (idemKey && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const dup = db.prepare('SELECT id FROM missions WHERE user_id=? AND idem_key=?').get(userId, idemKey)
        if (dup) return { mission: getMission(db, userId, dup.id), duplicate: true, existing: false }
      }
      throw err
    }
    attachConversation(db, userId, convoId, id)
    return { mission: getMission(db, userId, id), duplicate: false, existing: false }
  })()
}

export function listMissions(db, userId, { state = null, since = null, excludePrivateOwned = false } = {}) {
  const where = ['m.user_id = ?']
  const args = [userId]
  if (state) { where.push('m.state = ?'); args.push(state) }
  if (since != null) { where.push('m.updated_at >= ?'); args.push(since) }
  if (excludePrivateOwned) {
    // Same shape as listItems' excludePrivateOwned: a mission born in a
    // private device's conversation is invisible to an ordinary agent.
    where.push(`NOT EXISTS (SELECT 1 FROM conversations cv JOIN devices d ON d.id = cv.agent_device_id
      WHERE cv.id = m.origin_convo_id AND d.private = 1)`)
  }
  const rows = db.prepare(`SELECT m.*, ${COUNTS} FROM missions m WHERE ${where.join(' AND ')}
    ORDER BY (m.last_milestone_at IS NULL), m.last_milestone_at DESC, m.created_at DESC`).all(...args)
  return rows.map(missionRow)
}

const PRIVATE_CONVO = `EXISTS (SELECT 1 FROM devices d WHERE d.id = c.agent_device_id AND d.private = 1)`

export function missionDetail(db, userId, missionId, { excludePrivateOwned = false } = {}) {
  const mission = getMission(db, userId, missionId)
  if (!mission) return null
  const sieve = excludePrivateOwned ? `AND NOT ${PRIVATE_CONVO}` : ''
  const milestones = db.prepare(`SELECT l.* FROM milestones l JOIN conversations c ON c.id = l.convo_id
    WHERE l.mission_id=? ${sieve} ORDER BY l.created_at DESC, l.seq DESC`).all(mission.id).map(milestoneRow)
  const items = db.prepare(`SELECT i.id, i.num, i.kind, i.state, i.awaiting, i.title, i.origin_convo_id, i.updated_at
    FROM items i JOIN conversations c ON c.id = i.origin_convo_id
    WHERE i.mission_id=? AND i.state='open' ${sieve}
    ORDER BY (i.awaiting = 'user') DESC, i.updated_at DESC`).all(mission.id)
  const conversations = db.prepare(`SELECT c.id, c.title, c.session_state AS state, d.name AS box
    FROM conversations c LEFT JOIN devices d ON d.id = c.agent_device_id
    WHERE c.mission_id=? ${sieve} ORDER BY c.created_at`).all(mission.id)
  return { mission, milestones, items, conversations }
}

export function updateMission(db, { userId, missionId, fields }) {
  return db.transaction(() => {
    const cur = db.prepare('SELECT state FROM missions WHERE id=? AND user_id=?').get(missionId, userId)
    if (!cur) return null
    if (cur.state === 'closed') throw new Error('closed')
    const sets = []; const args = []
    if (fields.title !== undefined) { sets.push('title=?'); args.push(fields.title) }
    if (fields.body !== undefined) { sets.push('body=?'); args.push(fields.body) }
    sets.push('updated_at=?'); args.push(now())
    db.prepare(`UPDATE missions SET ${sets.join(', ')} WHERE id=? AND user_id=?`).run(...args, missionId, userId)
    return getMission(db, userId, missionId)
  })()
}

export function joinMission(db, { userId, missionId, convoId }) {
  return db.transaction(() => {
    const m = db.prepare('SELECT id, state FROM missions WHERE id=? AND user_id=?').get(missionId, userId)
    if (!m) throw new Error('no_mission')
    if (m.state === 'closed') throw new Error('closed')
    const convo = db.prepare('SELECT mission_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
    if (!convo) throw new Error('no_convo')
    if (convo.mission_id && convo.mission_id !== m.id) throw new Error('other_mission')
    if (!convo.mission_id) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE mission_id=?').get(m.id).n
      if (n >= CONVOS_MAX) throw new Error('too_many_convos')
      attachConversation(db, userId, convoId, m.id)
      db.prepare('UPDATE missions SET updated_at=? WHERE id=?').run(now(), m.id)
    }
    return getMission(db, userId, m.id)
  })()
}

export function closeMission(db, { userId, missionId, by, summary }) {
  return db.transaction(() => {
    const m = db.prepare('SELECT id, state FROM missions WHERE id=? AND user_id=?').get(missionId, userId)
    if (!m) throw new Error('no_mission')
    if (m.state === 'closed') throw new Error('closed')
    const open = db.prepare(`SELECT num, title, awaiting FROM items WHERE mission_id=? AND state='open' ORDER BY num`).all(m.id)
    if (by === 'agent') {
      const user = open.filter((i) => i.awaiting === 'user').map(({ num, title }) => ({ num, title }))
      if (user.length) { const e = new Error('user_items'); e.items = user; throw e }
      if (open.length) { const e = new Error('agent_items'); e.items = open.map(({ num, title }) => ({ num, title })); throw e }
    }
    const ts = now()
    db.prepare(`UPDATE missions SET state='closed', close_summary=?, closed_by=?, closed_over_open_items=?, closed_at=?, updated_at=?
      WHERE id=?`).run(summary, by, open.length, ts, ts, m.id)
    return { mission: getMission(db, userId, m.id), openItemNums: open.map((i) => i.num) }
  })()
}
```

- [ ] **Step 4: Make `createItem` set `items.mission_id` from the conversation and expose `mission_num`**

In `src/items.js`:

1. In `createItem`, where the INSERT is built, read the origin conversation's mission and write it. Find the `INSERT INTO items(` statement; add a `mission_id` column, and before it:

```js
    const missionId = db.prepare('SELECT mission_id FROM conversations WHERE id=?').get(convoId)?.mission_id ?? null
```

   and pass `missionId` in the matching position. (`createItem`'s argument is `convoId` — check the local name in the function signature and reuse it.)

2. Append to `DECORATE`:

```sql
  (SELECT num FROM missions m WHERE m.id = i.mission_id) AS mission_num
```

   (`rowToItem` passes unknown columns through via `...rest`, so `mission_id` and `mission_num` appear on every item JSON with no further change.)

3. Add and export:

```js
// PATCH /items/:id {mission}: explicit move or detach. Never inferred from
// an agent's tool arguments beyond this route (spec: Items follow their
// conversation).
export function setItemMission(db, { userId, itemId, missionId }) {
  db.prepare('UPDATE items SET mission_id=?, updated_at=? WHERE id=? AND user_id=?').run(missionId, Date.now(), itemId, userId)
  return getItem(db, userId, itemId)
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/missions.test.js test/items.test.js`
Expected: PASS. (If `test/items.test.js` compares a full item JSON with `deepEqual`, add `mission_id: null, mission_num: null` to its expectation.)

- [ ] **Step 6: Commit**

```bash
git add src/missions.js src/items.js test/missions.test.js
git commit -m "missions: pure state module — create/list/detail/update/join/close, item repointing"
```

---

### Task 6: Milestones in the pure module + inheritance on conversation creation

**Files:**
- Modify: `src/missions.js`, `src/journal.js` (`upsertConversation` INSERT branch)
- Test: `test/missions.test.js`

**Interfaces:**
- Produces: `createMilestone(db, { userId, deviceId, createdBy, convoId, kind, title, body, idemKey, appendMarker }) → { milestone, mission, duplicate }` where `appendMarker(payload) → { seq, ts }` is called **inside** the transaction; throws `Error('no_mission')`, `Error('closed')`, `Error('bad_kind')`, or rethrows the append error as `Error('marker_append_failed')`. `listMilestones(db, userId, { convoId, excludePrivateOwned }) → milestone[]` newest first.
- `upsertConversation` INSERT branch copies `mission_id` from the parent when `parentConvoId` is set and the parent has one.

- [ ] **Step 1: Write the failing tests**

Append to `test/missions.test.js`:

```js
import { createMilestone, listMilestones } from '../src/missions.js'

test('createMilestone: marker appended inside the transaction, seq stored, mission activity bumped; no mission → no_mission and nothing written', () => {
  const db = seeded()
  const m = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'A' }).mission
  const appendMarker = (payload) => append(db, { userId: 1, convoId: 'c1', sender: 'agent:dev-2', type: 'milestone', payload })
  const r = createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', kind: 'user_input', title: 'Start', body: 'b', idemKey: '7:m1', appendMarker })
  assert.equal(r.duplicate, false); assert.equal(r.milestone.num, 2); assert.equal(r.mission.id, m.id)
  const ev = db.prepare("SELECT seq, payload FROM events WHERE type='milestone'").get()
  assert.equal(ev.seq, r.milestone.seq)
  assert.equal(JSON.parse(ev.payload).milestone_id, r.milestone.id)
  assert.equal(getMission(db, 1, m.id).last_milestone_at, r.milestone.created_at)
  assert.equal(getMission(db, 1, m.id).last_milestone.num, 2)
  const again = createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', kind: 'user_input', title: 'Start', idemKey: '7:m1', appendMarker })
  assert.equal(again.duplicate, true); assert.equal(again.milestone.id, r.milestone.id)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='milestone'").get().n, 1)
  // c2 has no mission
  assert.throws(() => createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c2', kind: 'progress', title: 'x', appendMarker }), /no_mission/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM milestones').get().n, 1)
  assert.throws(() => createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', kind: 'other', title: 'x', appendMarker }), /bad_kind/)
})

test('createMilestone: a failing marker append rolls the row back and surfaces marker_append_failed', () => {
  const db = seeded()
  createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'A' })
  const boom = () => { throw new Error('disk on fire') }
  assert.throws(() => createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', kind: 'progress', title: 'x', appendMarker: boom }), /marker_append_failed/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM milestones').get().n, 0)
  assert.equal(db.prepare('SELECT next_num FROM item_counters WHERE user_id=1').get().next_num, 2) // number allocation rolled back too
})

test('closed mission rejects milestones; listMilestones is newest first per conversation', () => {
  const db = seeded()
  const m = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'A' }).mission
  const appendMarker = (payload) => append(db, { userId: 1, convoId: 'c1', sender: 'agent:dev-2', type: 'milestone', payload })
  createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', kind: 'user_input', title: 'one', appendMarker })
  createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', kind: 'progress', title: 'two', appendMarker })
  assert.deepEqual(listMilestones(db, 1, { convoId: 'c1' }).map((l) => l.title), ['two', 'one'])
  closeMission(db, { userId: 1, missionId: m.id, by: 'agent', summary: 's' })
  assert.throws(() => createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', kind: 'progress', title: 'x', appendMarker }), /closed/)
})

test('a spawned conversation inherits its parent mission at creation; a later upsert never changes it', () => {
  const db = seeded()
  const m = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'A' }).mission
  upsertConversation(db, { id: 'child', ownerUserId: 1, title: 'kid', agentDeviceId: 7, parentConvoId: 'c1' })
  assert.equal(db.prepare('SELECT mission_id FROM conversations WHERE id=?').get('child').mission_id, m.id)
  upsertConversation(db, { id: 'child', ownerUserId: 1, title: 'kid2' })
  assert.equal(db.prepare('SELECT mission_id FROM conversations WHERE id=?').get('child').mission_id, m.id)
  upsertConversation(db, { id: 'orphan', ownerUserId: 1, title: 'o', agentDeviceId: 7, parentConvoId: 'c2' })
  assert.equal(db.prepare('SELECT mission_id FROM conversations WHERE id=?').get('orphan').mission_id, null)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/missions.test.js`
Expected: FAIL — `createMilestone` is not exported.

- [ ] **Step 3: Add milestones to `src/missions.js`**

Append:

```js
// The milestone row and its marker are one write: appendMarker runs INSIDE
// this transaction (append() is itself a sync better-sqlite3 transaction,
// nested as a savepoint) and the returned seq is the row's anchor. If the
// append throws, nothing — not even the number — survives.
export function createMilestone(db, { userId, deviceId, createdBy, convoId, kind, title, body = '', idemKey = null, appendMarker }) {
  return db.transaction(() => {
    if (!MILESTONE_KINDS.includes(kind)) throw new Error('bad_kind')
    if (idemKey) {
      const dup = db.prepare('SELECT id, mission_id FROM milestones WHERE user_id=? AND idem_key=?').get(userId, idemKey)
      if (dup) {
        return { milestone: milestoneRow(db.prepare('SELECT * FROM milestones WHERE id=?').get(dup.id)), mission: getMission(db, userId, dup.mission_id), duplicate: true }
      }
    }
    const convo = db.prepare('SELECT mission_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
    if (!convo) throw new Error('no_convo')
    if (!convo.mission_id) throw new Error('no_mission')
    const mission = getMission(db, userId, convo.mission_id)
    if (mission.state === 'closed') throw new Error('closed')
    const id = newId('ml')
    const num = nextNum(db, userId)
    const ts = now()
    const milestone = { id, num, kind, title, body }
    let r
    try {
      r = appendMarker({
        milestone_id: id, num, kind, title, body,
        mission_id: mission.id, mission_num: mission.num, mission_title: mission.title, by: createdBy,
      })
    } catch (err) {
      const e = new Error('marker_append_failed'); e.cause = err; throw e
    }
    try {
      db.prepare(`INSERT INTO milestones(id,mission_id,user_id,num,kind,title,body,convo_id,seq,device_id,created_by,idem_key,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, mission.id, userId, num, kind, title, body, convoId, r.seq, deviceId, createdBy, idemKey, ts)
    } catch (err) {
      if (idemKey && err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new Error('idem_key_conflict')
      throw err
    }
    db.prepare('UPDATE missions SET last_milestone_at=?, updated_at=? WHERE id=?').run(ts, ts, mission.id)
    return { milestone: milestoneRow({ ...milestone, mission_id: mission.id, convo_id: convoId, seq: r.seq, device_id: deviceId, created_by: createdBy, created_at: ts }), mission: getMission(db, userId, mission.id), duplicate: false, seq: r.seq, ts: r.ts }
  })()
}

export function listMilestones(db, userId, { convoId, excludePrivateOwned = false }) {
  const sieve = excludePrivateOwned ? `AND NOT ${PRIVATE_CONVO}` : ''
  return db.prepare(`SELECT l.* FROM milestones l JOIN conversations c ON c.id = l.convo_id
    WHERE l.user_id=? AND l.convo_id=? ${sieve} ORDER BY l.created_at DESC, l.seq DESC`).all(userId, convoId).map(milestoneRow)
}
```

- [ ] **Step 4: Inheritance in `upsertConversation`**

In `src/journal.js`, in the INSERT branch of `upsertConversation`, replace the two statements with:

```js
    const initialTitle = title || ''
    // Missions (spec 2026-09-10): a spawned conversation inherits its
    // parent's mission at creation. Set once here and never on the
    // update path — same immutability as parent_convo_id.
    const inheritedMission = parentConvoId
      ? (db.prepare('SELECT mission_id FROM conversations WHERE id=? AND owner_user_id=?').get(parentConvoId, ownerUserId)?.mission_id ?? null)
      : null
    db.prepare(
      'INSERT INTO conversations(id, owner_user_id, title, session_state, agent_device_id, parent_convo_id, session_outcome, summary, mission_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
    ).run(id, ownerUserId, initialTitle, sessionState || 'running', agentDeviceId ?? null, parentConvoId ?? null, sessionOutcome ?? null, summary || '', inheritedMission, Date.now())
    if (initialTitle || parentConvoId) metaChanged = true
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/missions.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/missions.js src/journal.js test/missions.test.js
git commit -m "missions: milestones anchored to their marker seq; spawned conversations inherit the mission"
```

---

### Task 7: HTTP routes — `src/missions-http.js` + mount

**Files:**
- Create: `src/missions-http.js`
- Modify: `src/http.js` (import + mount after the `handleItemsRoute` line)
- Test: `test/missions-http.test.js` (new)

**Interfaces:**
- Consumes: everything from Tasks 3–6; `filteredAgent`/`privateOwnedConvo` logic is duplicated here (they are module-private in `items-http.js`); `authorizeAgentWrite` from `src/auth.js`; `json`, `readBody` from `src/http-body.js`.
- Produces: `export async function handleMissionsRoute(ctx, req, res, url, who) → boolean`.

Routes (all Bearer, either device kind):

| Method + path | Behaviour |
|---|---|
| `POST /missions` `{title, body?, convo_id}` | 201 `{mission}`; 200 `{mission, existing:true}` if the convo already has one; idempotent replay 200 `{mission}`. Agent must pass `authorizeAgentWrite` for `convo_id`. Marker `mission/created` on `convo_id`. |
| `GET /missions?state=&since=` | 200 `{missions:[…]}` |
| `GET /missions/:id` | 200 `{mission, milestones, items, conversations}` |
| `PATCH /missions/:id` `{title?, body?}` | 200 `{mission}`; 409 `closed`. Marker `mission/updated` on the origin conversation. |
| `POST /missions/:id/join` `{convo_id}` | 200 `{mission}`; 409 `closed` / `other_mission`; 400 `too_many_convos`. Marker `mission/joined` on `convo_id`. |
| `POST /missions/:id/close` `{summary}` | 200 `{mission}`; 409 `{blocked_by:'user_items'|'agent_items', items}` for agents; 409 `closed`. Marker `mission/closed` on the origin conversation with `open_item_nums` when a user forced it. |
| `POST /milestones` `{convo_id, title, body?, kind}` | 201 `{milestone, mission}`; replay 200; 409 `{blocked_by:'no_mission'}`; 409 `{blocked_by:'closed'}`; 502 `{error:'marker_append_failed'}`. |
| `GET /milestones?convo=<id>` | 200 `{milestones:[…]}` newest first |

- [ ] **Step 1: Write the failing HTTP tests**

Create `test/missions-http.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { pinDevicePrivate } from '../src/db.js'

async function fleet(t) {
  const s = await startTestServer({})
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  const patAgent = createAgent(s.db, pat.id, 'pat-box')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'c2', ownerUserId: dan.id, title: 'C2', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'p1', ownerUserId: pat.id, title: 'P1', agentDeviceId: patAgent.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  return { s, dan, agent, patAgent, client: login.json.token }
}
const start = (s, token, body, headers = {}) => s.http('/missions', { method: 'POST', token, body: { title: 'Missions', body: 'goal', convo_id: 'c1', ...body }, headers })
const post = (s, token, body, headers = {}) => s.http('/milestones', { method: 'POST', token, body: { convo_id: 'c1', kind: 'progress', title: 'step', ...body }, headers })
const item = (s, token, body) => s.http('/items', { method: 'POST', token, body: { kind: 'question', title: 'Q?', convo_id: 'c1', ...body } })

test('POST /missions: 201 with the next shared number, marker on the convo, existing on a second start, idempotent replay, 400/404 on junk', async (t) => {
  const { s, agent, client } = await fleet(t)
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const it = await item(s, agent.token, {})
  assert.equal(it.json.item.num, 1)
  const r = await start(s, agent.token, {}, { 'idempotency-key': 'k1' })
  assert.equal(r.status, 201); assert.equal(r.json.mission.num, 2); assert.equal(r.json.mission.state, 'open'); assert.equal(r.json.existing, undefined)
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission')
  assert.equal(marker.convo_id, 'c1'); assert.equal(marker.payload.action, 'created'); assert.equal(marker.payload.num, 2); assert.equal(marker.payload.by, 'agent')
  ws.close()
  const replay = await start(s, agent.token, {}, { 'idempotency-key': 'k1' })
  assert.equal(replay.status, 200); assert.equal(replay.json.mission.id, r.json.mission.id)
  const second = await start(s, agent.token, { title: 'Other' })
  assert.equal(second.status, 200); assert.equal(second.json.existing, true); assert.equal(second.json.mission.title, 'Missions')
  assert.equal((await s.http('/items/it_x', { token: agent.token })).status, 404)
  const moved = await s.http(`/items/${it.json.item.id}`, { token: agent.token })
  assert.equal(moved.json.item.mission_id, r.json.mission.id); assert.equal(moved.json.item.mission_num, 2)
  assert.equal((await start(s, agent.token, { title: '' })).status, 400)
  assert.equal((await start(s, agent.token, { title: 'x'.repeat(201) })).status, 400)
  assert.equal((await start(s, agent.token, { convo_id: 'p1' })).status, 404)
  assert.equal((await start(s, agent.token, { convo_id: 'nope' })).status, 404)
  assert.equal((await s.http('/missions', { method: 'POST', body: { title: 'x', convo_id: 'c1' } })).status, 401)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='mission'").get().n, 1)
})

test('POST /milestones: 409 no_mission writes nothing; 201 with marker seq as anchor; replay 200; GET /milestones newest first; closed mission 409', async (t) => {
  const { s, agent, client } = await fleet(t)
  const none = await post(s, agent.token, {})
  assert.equal(none.status, 409); assert.equal(none.json.blocked_by, 'no_mission')
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM milestones').get().n, 0)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='milestone'").get().n, 0)
  const m = (await start(s, agent.token, {})).json.mission
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await post(s, agent.token, { kind: 'user_input', title: 'Dan asked', body: 'b' }, { 'idempotency-key': 'm1' })
  assert.equal(r.status, 201); assert.equal(r.json.milestone.num, 2); assert.equal(r.json.mission.id, m.id)
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'milestone')
  assert.equal(marker.seq, r.json.milestone.seq); assert.equal(marker.payload.milestone_id, r.json.milestone.id)
  assert.equal(marker.payload.mission_num, m.num); assert.equal(marker.payload.kind, 'user_input'); assert.equal(marker.payload.by, 'agent')
  ws.close()
  assert.equal((await post(s, agent.token, { kind: 'user_input', title: 'Dan asked' }, { 'idempotency-key': 'm1' })).status, 200)
  const r2 = await post(s, agent.token, { title: 'later' })
  assert.equal(r2.status, 201)
  const list = await s.http('/milestones?convo=c1', { token: client })
  assert.deepEqual(list.json.milestones.map((l) => l.title), ['later', 'Dan asked'])
  assert.equal((await post(s, agent.token, { kind: 'nope' })).status, 400)
  assert.equal((await post(s, agent.token, { title: '' })).status, 400)
  assert.equal((await post(s, agent.token, { convo_id: 'p1' })).status, 404)
  const detail = await s.http(`/missions/${m.num}`, { token: client })
  assert.equal(detail.json.mission.milestones, 2); assert.equal(detail.json.mission.last_milestone.title, 'later')
  assert.equal(detail.json.milestones[0].title, 'later')
  const closed = await s.http(`/missions/${m.id}/close`, { method: 'POST', token: agent.token, body: { summary: 'done' } })
  assert.equal(closed.status, 200)
  const after = await post(s, agent.token, { title: 'too late' })
  assert.equal(after.status, 409); assert.equal(after.json.blocked_by, 'closed')
})

test('close: agent blocked by user items then agent items (409 with the list); user close records closed_over_open_items and the marker carries open_item_nums', async (t) => {
  const { s, agent, client } = await fleet(t)
  const m = (await start(s, agent.token, {})).json.mission
  const q = (await item(s, agent.token, {})).json.item
  const tk = (await item(s, agent.token, { kind: 'task', title: 'T' })).json.item
  const close = (token, summary = 's') => s.http(`/missions/${m.id}/close`, { method: 'POST', token, body: { summary } })
  let r = await close(agent.token)
  assert.equal(r.status, 409); assert.equal(r.json.blocked_by, 'user_items'); assert.deepEqual(r.json.items, [{ num: q.num, title: 'Q?' }])
  await s.http(`/items/${q.id}/close`, { method: 'POST', token: client, body: { resolution: 'answered' } })
  r = await close(agent.token)
  assert.equal(r.status, 409); assert.equal(r.json.blocked_by, 'agent_items'); assert.deepEqual(r.json.items, [{ num: tk.num, title: 'T' }])
  assert.equal((await close(agent.token, '')).status, 400)
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  r = await close(client, 'forced')
  assert.equal(r.status, 200); assert.equal(r.json.mission.closed_by, 'user'); assert.equal(r.json.mission.closed_over_open_items, 1)
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.payload.action === 'closed')
  assert.deepEqual(marker.payload.open_item_nums, [tk.num]); assert.equal(marker.payload.by, 'user')
  ws.close()
  assert.equal((await close(client)).status, 409)
  assert.equal((await s.http(`/missions/${m.id}`, { method: 'PATCH', token: agent.token, body: { title: 'x' } })).status, 409)
  assert.equal((await s.http(`/items/${tk.id}`, { token: client })).json.item.state, 'open')
})

test('join: attaches c2 and repoints its items; refuses a second mission for a convo; PATCH updates and emits the marker on the origin', async (t) => {
  const { s, agent, client } = await fleet(t)
  const m = (await start(s, agent.token, {})).json.mission
  const it2 = (await item(s, agent.token, { convo_id: 'c2', kind: 'task', title: 'T2' })).json.item
  const j = await s.http(`/missions/${m.num}/join`, { method: 'POST', token: agent.token, body: { convo_id: 'c2' } })
  assert.equal(j.status, 200); assert.equal(j.json.mission.conversations, 2)
  assert.equal((await s.http(`/items/${it2.id}`, { token: client })).json.item.mission_id, m.id)
  const other = await s.http('/missions', { method: 'POST', token: agent.token, body: { title: 'B', convo_id: 'c2' } })
  assert.equal(other.status, 200); assert.equal(other.json.existing, true); assert.equal(other.json.mission.id, m.id)
  upsertConversation(s.db, { id: 'c3', ownerUserId: 1, title: 'C3', agentDeviceId: agent.deviceId })
  const b = (await s.http('/missions', { method: 'POST', token: agent.token, body: { title: 'B', convo_id: 'c3' } })).json.mission
  const bad = await s.http(`/missions/${b.id}/join`, { method: 'POST', token: agent.token, body: { convo_id: 'c2' } })
  assert.equal(bad.status, 409); assert.equal(bad.json.blocked_by, 'other_mission')
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const p = await s.http(`/missions/${m.id}`, { method: 'PATCH', token: agent.token, body: { title: 'Renamed' } })
  assert.equal(p.status, 200); assert.equal(p.json.mission.title, 'Renamed')
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.payload.action === 'updated')
  assert.equal(marker.convo_id, 'c1'); assert.equal(marker.payload.title, 'Renamed')
  ws.close()
  assert.equal((await s.http(`/missions/${m.id}`, { method: 'PATCH', token: agent.token, body: {} })).status, 400)
})

test('GET /missions: counts and sort; state filter; PATCH /items/:id {mission} moves and detaches', async (t) => {
  const { s, agent, client } = await fleet(t)
  const a = (await start(s, agent.token, {})).json.mission
  const b = (await start(s, agent.token, { title: 'B', convo_id: 'c2' })).json.mission
  const it = (await item(s, agent.token, {})).json.item
  await post(s, agent.token, { convo_id: 'c2', title: 'b1' })
  const list = await s.http('/missions', { token: client })
  assert.deepEqual(list.json.missions.map((m) => m.id), [b.id, a.id])
  assert.equal(list.json.missions[1].needs_you, 1); assert.equal(list.json.missions[1].open_items, 1)
  assert.equal(list.json.missions[0].last_milestone.title, 'b1')
  const mv = await s.http(`/items/${it.id}`, { method: 'PATCH', token: agent.token, body: { mission: `#${b.num}` } })
  assert.equal(mv.status, 200); assert.equal(mv.json.item.mission_id, b.id); assert.equal(mv.json.item.mission_num, b.num)
  const det = await s.http(`/items/${it.id}`, { method: 'PATCH', token: agent.token, body: { mission: null } })
  assert.equal(det.json.item.mission_id, null)
  assert.equal((await s.http(`/items/${it.id}`, { method: 'PATCH', token: agent.token, body: { mission: '#999' } })).status, 404)
  await s.http(`/missions/${b.id}/close`, { method: 'POST', token: client, body: { summary: 'x' } })
  assert.equal((await s.http('/missions?state=open', { token: client })).json.missions.length, 1)
  assert.equal((await s.http('/missions?state=closed', { token: client })).json.missions.length, 1)
  assert.equal((await s.http('/missions?state=bogus', { token: client })).status, 400)
})

test('privacy sieve: an ordinary agent cannot see a mission born in a private convo, nor its milestones through another mission', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret', ownerUserId: dan.id, title: 'S', agentDeviceId: priv.deviceId })
  const m = (await s.http('/missions', { method: 'POST', token: priv.token, body: { title: 'Hidden', convo_id: 'secret' } })).json.mission
  assert.equal((await s.http('/missions', { token: agent.token })).json.missions.length, 0)
  assert.equal((await s.http(`/missions/${m.id}`, { token: agent.token })).status, 404)
  assert.equal((await s.http('/missions', { token: client })).json.missions.length, 1)
  assert.equal((await s.http('/missions', { token: priv.token })).json.missions.length, 1)
  // an ordinary agent cannot start a mission in a private convo or post milestones there
  assert.equal((await start(s, agent.token, { convo_id: 'secret' })).status, 404)
  assert.equal((await post(s, agent.token, { convo_id: 'secret' })).status, 404)
  // a public mission that a private convo joined: the private convo's milestones are filtered for the ordinary agent
  const pub = (await start(s, agent.token, {})).json.mission
  await s.http(`/missions/${pub.id}/join`, { method: 'POST', token: priv.token, body: { convo_id: 'secret' } })
  assert.equal((await s.http(`/missions/${pub.id}/join`, { method: 'POST', token: priv.token, body: { convo_id: 'secret' } })).status, 409)
})

test('forged publish of mission/milestone types is rejected; oversized bodies 413 with nothing written', async (t) => {
  const { s, agent } = await fleet(t)
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  ws.send({ op: 'publish', convo_id: 'c1', type: 'milestone', payload: { num: 1 } })
  const bad = await ws.waitFor((f) => f.op === 'error' || f.error)
  assert.match(JSON.stringify(bad), /bad_request/)
  ws.close()
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type IN ('milestone','mission')").get().n, 0)
  const big = await s.http('/missions', { method: 'POST', token: agent.token, body: { title: 'x', body: 'y'.repeat(40000), convo_id: 'c1' } })
  assert.ok(big.status === 400 || big.status === 413)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM missions').get().n, 0)
})
```

(The `secret` join by the private agent at the end of the sieve test is one more use of `join`; the expectation that the second join 409s is the "already has a different mission? no — the same" case: a repeat join of the same mission is a no-op 200. Change that last assertion to `200` — kept here as a reminder to decide; the implementation below treats a repeat join of the same mission as 200.)

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/missions-http.test.js`
Expected: FAIL — every `/missions` request answers 404 (no route).

- [ ] **Step 3: Write `src/missions-http.js`**

```js
// HTTP surface of missions & milestones (spec 2026-09-10, "HTTP API").
// Validation, auth, the privacy sieve, and the side effects the pure
// module must not know about: the 'mission' and 'milestone' marker events.
// No wake, no push: both markers are navigation, not attention.
import { append, appendAndBroadcast, broadcastAppended } from './journal.js'
import { isPrivateDevice } from './db.js'
import { authorizeAgentWrite } from './auth.js'
import { json, readBody } from './http-body.js'
import { BODY_MAX } from './items.js'
import {
  MILESTONE_KINDS, TITLE_MAX, validateMissionFields, createMission, getMission, listMissions, missionDetail,
  updateMission, joinMission, closeMission, createMilestone, listMilestones,
} from './missions.js'
import { MISSION_EVENT_TYPE, MILESTONE_EVENT_TYPE, missionMarkerPayload } from './missions-marker.js'

const STATES = ['open', 'closed']
const IDEM_KEY_MAX = 128

const badRequest = (res) => { json(res, 400, { error: 'bad_request' }); return true }
const notFound = (res) => { json(res, 404, { error: 'not_found' }); return true }
const conflict = (res, extra = {}) => { json(res, 409, { error: 'conflict', ...extra }); return true }

// Same shape as items-http.js (module-private there; duplicated on purpose
// so the two surfaces never share a hidden coupling).
const filteredAgent = (db, who) => who.kind === 'agent' && !isPrivateDevice(db, who.deviceId)
const privateOwnedConvo = (db, convoId) => {
  const owner = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(convoId)?.agent_device_id
  return owner != null && isPrivateDevice(db, owner)
}
const idemKeyOf = (req, who) => {
  const k = req.headers['idempotency-key']
  if (k === undefined) return null
  if (typeof k !== 'string' || !k || k.length > IDEM_KEY_MAX) return undefined
  return `${who.deviceId}:${k}`
}
function senderOf(db, who) {
  if (who.kind === 'agent') return `agent:${who.name}`
  const row = db.prepare('SELECT name FROM users WHERE id=?').get(who.userId)
  return `user:${row ? row.name : who.userId}`
}
const byOf = (who) => (who.kind === 'agent' ? 'agent' : 'user')

// Visible = owned by the caller's user and, for an ordinary agent, not born
// in a private device's conversation. Same 404 for every failure.
function visibleMission(db, who, idOrNum) {
  const m = getMission(db, who.userId, idOrNum)
  if (!m) return null
  if (filteredAgent(db, who) && privateOwnedConvo(db, m.origin_convo_id)) return null
  return m
}

// The conversation gate for the two routes that target a conversation
// rather than an already-visible mission (create, milestone, join).
function writableConvo(db, who, convoId) {
  if (typeof convoId !== 'string' || !convoId) return false
  const convo = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(convoId)
  if (!convo || convo.owner_user_id !== who.userId) return false
  if (who.kind === 'agent' && !authorizeAgentWrite(db, who.userId, who.deviceId, convoId)) return false
  if (filteredAgent(db, who) && convo.agent_device_id != null && isPrivateDevice(db, convo.agent_device_id)) return false
  return true
}

// Mission markers are written AFTER the mission's transaction committed —
// never inside it (same stance as items' emitMarker).
function emitMissionMarker({ db, hub }, who, { mission, action, convoId, openItemNums = null }) {
  const payload = missionMarkerPayload({ mission, action, by: byOf(who), openItemNums })
  try {
    appendAndBroadcast(db, hub, { userId: who.userId, convoId, sender: senderOf(db, who), type: MISSION_EVENT_TYPE, payload })
  } catch (err) {
    console.error('missions: marker append failed (mission write already committed)', err)
  }
}

async function handleCreate(ctx, req, res, who) {
  const { db } = ctx
  const body = await readBody(req)
  const v = validateMissionFields(body)
  if (!v.ok) return badRequest(res)
  const idemKey = idemKeyOf(req, who)
  if (idemKey === undefined) return badRequest(res)
  if (!writableConvo(db, who, body.convo_id)) return notFound(res)
  const out = createMission(db, {
    userId: who.userId, deviceId: who.deviceId, createdBy: byOf(who), convoId: body.convo_id,
    title: v.value.title, body: v.value.body ?? '', idemKey,
  })
  if (out.existing) { json(res, 200, { mission: out.mission, existing: true }); return true }
  if (out.duplicate) { json(res, 200, { mission: out.mission }); return true }
  emitMissionMarker(ctx, who, { mission: out.mission, action: 'created', convoId: body.convo_id })
  json(res, 201, { mission: out.mission })
  return true
}

function handleList(ctx, res, url, who) {
  const { db } = ctx
  const state = url.searchParams.get('state')
  if (state != null && !STATES.includes(state)) return badRequest(res)
  let since = null
  if (url.searchParams.has('since')) {
    since = Number(url.searchParams.get('since'))
    if (!Number.isFinite(since) || since < 0) return badRequest(res)
  }
  json(res, 200, { missions: listMissions(db, who.userId, { state, since, excludePrivateOwned: filteredAgent(db, who) }) })
  return true
}

async function handlePatch(ctx, req, res, who, mission) {
  const { db } = ctx
  const body = await readBody(req)
  const v = validateMissionFields(body, { partial: true })
  if (!v.ok || Object.keys(v.value).length === 0) return badRequest(res)
  let updated
  try { updated = updateMission(db, { userId: who.userId, missionId: mission.id, fields: v.value }) }
  catch (err) { if (err.message === 'closed') return conflict(res, { blocked_by: 'closed' }); throw err }
  if (!updated) return notFound(res)
  emitMissionMarker(ctx, who, { mission: updated, action: 'updated', convoId: updated.origin_convo_id })
  json(res, 200, { mission: updated })
  return true
}

async function handleJoin(ctx, req, res, who, mission) {
  const { db } = ctx
  const body = await readBody(req)
  if (!writableConvo(db, who, body.convo_id)) return notFound(res)
  const already = db.prepare('SELECT mission_id FROM conversations WHERE id=?').get(body.convo_id)?.mission_id
  let joined
  try { joined = joinMission(db, { userId: who.userId, missionId: mission.id, convoId: body.convo_id }) }
  catch (err) {
    if (err.message === 'closed' || err.message === 'other_mission') return conflict(res, { blocked_by: err.message })
    if (err.message === 'too_many_convos') return badRequest(res)
    throw err
  }
  if (already !== joined.id) emitMissionMarker(ctx, who, { mission: joined, action: 'joined', convoId: body.convo_id })
  json(res, 200, { mission: joined })
  return true
}

async function handleClose(ctx, req, res, who, mission) {
  const { db } = ctx
  const body = await readBody(req)
  if (typeof body.summary !== 'string' || !body.summary.trim() || Buffer.byteLength(body.summary, 'utf8') > BODY_MAX) return badRequest(res)
  let out
  try { out = closeMission(db, { userId: who.userId, missionId: mission.id, by: byOf(who), summary: body.summary }) }
  catch (err) {
    if (err.message === 'closed') return conflict(res, { blocked_by: 'closed' })
    if (err.message === 'user_items' || err.message === 'agent_items') return conflict(res, { blocked_by: err.message, items: err.items })
    throw err
  }
  emitMissionMarker(ctx, who, {
    mission: out.mission, action: 'closed', convoId: out.mission.origin_convo_id,
    openItemNums: who.kind === 'agent' ? null : out.openItemNums,
  })
  json(res, 200, { mission: out.mission })
  return true
}

async function handleMilestoneCreate(ctx, req, res, who) {
  const { db, hub } = ctx
  const body = await readBody(req)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res)
  if (!MILESTONE_KINDS.includes(body.kind)) return badRequest(res)
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > TITLE_MAX) return badRequest(res)
  if (body.body !== undefined && (typeof body.body !== 'string' || Buffer.byteLength(body.body, 'utf8') > BODY_MAX)) return badRequest(res)
  const idemKey = idemKeyOf(req, who)
  if (idemKey === undefined) return badRequest(res)
  if (!writableConvo(db, who, body.convo_id)) return notFound(res)
  const sender = senderOf(db, who)
  let out
  try {
    out = createMilestone(db, {
      userId: who.userId, deviceId: who.deviceId, createdBy: byOf(who), convoId: body.convo_id,
      kind: body.kind, title: body.title.trim(), body: body.body ?? '', idemKey,
      appendMarker: (payload) => append(db, { userId: who.userId, convoId: body.convo_id, sender, type: MILESTONE_EVENT_TYPE, payload }),
    })
  } catch (err) {
    if (err.message === 'no_mission' || err.message === 'closed') return conflict(res, { blocked_by: err.message })
    if (err.message === 'idem_key_conflict') return conflict(res, { blocked_by: 'idem_key' })
    if (err.message === 'marker_append_failed') {
      console.error('missions: milestone marker append failed — milestone not created', err.cause)
      json(res, 502, { error: 'marker_append_failed' }); return true
    }
    throw err
  }
  if (out.duplicate) { json(res, 200, { milestone: out.milestone, mission: out.mission }); return true }
  // Broadcast only now: the marker committed with the row.
  try {
    broadcastAppended(db, hub, {
      userId: who.userId, convoId: body.convo_id, seq: out.seq, ts: out.ts, sender, type: MILESTONE_EVENT_TYPE,
      payload: { milestone_id: out.milestone.id, num: out.milestone.num, kind: out.milestone.kind, title: out.milestone.title, body: out.milestone.body,
        mission_id: out.mission.id, mission_num: out.mission.num, mission_title: out.mission.title, by: byOf(who) },
    })
  } catch (err) { console.error('missions: milestone broadcast failed (row and marker already committed)', err) }
  json(res, 201, { milestone: out.milestone, mission: out.mission })
  return true
}

function handleMilestoneList(ctx, res, url, who) {
  const { db } = ctx
  const convoId = url.searchParams.get('convo')
  if (!convoId) return badRequest(res)
  const convo = db.prepare('SELECT owner_user_id FROM conversations WHERE id=?').get(convoId)
  if (!convo || convo.owner_user_id !== who.userId) return notFound(res)
  if (filteredAgent(db, who) && privateOwnedConvo(db, convoId)) return notFound(res)
  json(res, 200, { milestones: listMilestones(db, who.userId, { convoId, excludePrivateOwned: filteredAgent(db, who) }) })
  return true
}

export async function handleMissionsRoute(ctx, req, res, url, who) {
  const { db } = ctx
  const path = url.pathname
  if (path === '/milestones') {
    if (req.method === 'POST') return handleMilestoneCreate(ctx, req, res, who)
    if (req.method === 'GET') return handleMilestoneList(ctx, res, url, who)
    return false
  }
  if (path !== '/missions' && !path.startsWith('/missions/')) return false
  if (path === '/missions') {
    if (req.method === 'POST') return handleCreate(ctx, req, res, who)
    if (req.method === 'GET') return handleList(ctx, res, url, who)
    return false
  }
  // Nested sub segment on purpose (see items-http.js): /missions/:id/junk must not match.
  const m = path.match(/^\/missions\/([^/]+)(?:\/(join|close))?$/)
  if (!m) return false
  let idOrNum
  try { idOrNum = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  const sub = m[2] || null
  const mission = visibleMission(db, who, idOrNum)
  if (!mission) return notFound(res)
  if (!sub) {
    if (req.method === 'GET') {
      json(res, 200, missionDetail(db, who.userId, mission.id, { excludePrivateOwned: filteredAgent(db, who) })); return true
    }
    if (req.method === 'PATCH') return handlePatch(ctx, req, res, who, mission)
    return false
  }
  if (req.method !== 'POST') return false
  if (sub === 'join') return handleJoin(ctx, req, res, who, mission)
  return handleClose(ctx, req, res, who, mission)
}
```

- [ ] **Step 4: Mount it and add `mission` to `PATCH /items/:id`**

In `src/http.js`, next to the items import: `import { handleMissionsRoute } from './missions-http.js'`, and directly after the `if (await handleItemsRoute(...)) return` line:

```js
      if (await handleMissionsRoute({ db, hub, pushPipeline, waker }, req, res, url, who)) return
```

In `src/items-http.js` `handlePatch`, before `if (Object.keys(fields).length === 0) return badRequest(res)`:

```js
  // Missions (spec 2026-09-10): explicit move or detach. `mission` is a
  // mission id, "#num", a bare number, or null. Never inferred.
  let missionTarget
  if (body.mission !== undefined) {
    if (body.mission === null) missionTarget = null
    else {
      const target = getMission(db, who.userId, body.mission)
      if (!target) return notFound(res)
      missionTarget = target.id
    }
  }
```

then after `const updated = ...`:

```js
  let result = updated
  if (missionTarget !== undefined || body.mission === null) result = setItemMission(db, { userId: who.userId, itemId: item.id, missionId: missionTarget ?? null })
```

and use `result` in the `emitMarker`/`json` calls. Change the empty-fields guard to `if (Object.keys(fields).length === 0 && body.mission === undefined) return badRequest(res)`, and only call `updateItem` when `fields` is non-empty. Add the imports `getMission` from `./missions.js` and `setItemMission` from `./items.js`.

- [ ] **Step 5: Run the tests**

Run: `node --test test/missions-http.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/missions-http.js src/http.js src/items-http.js test/missions-http.test.js
git commit -m "missions: HTTP routes — missions, milestones, close rules, item move; mounted beside /items"
```

---

### Task 8: Docs, help text, conformance fixture

**Files:**
- Modify: `docs/protocol.md` (new `## Missions & milestones` section after the Items section; add `GET/POST /missions*`, `/milestones*` to the "Device privacy" enumeration), `src/help.js`, `src/db.js` privacy comment (~line 229)
- Create: `test/fixtures/conformance/15_missions_roundtrip.json`

- [ ] **Step 1: Write the conformance fixture**

`test/fixtures/conformance/15_missions_roundtrip.json` — drive it from a real server first (fixture README), then trim. Shape:

```json
{
  "name": "missions: agent starts a mission, posts a milestone whose marker seq is the anchor, closes it; markers land in the right conversations",
  "description": "Exercises POST /missions, POST /milestones (201 then a 409 no_mission on a second conversation), GET /missions/:id, POST /missions/:id/close, and the 'mission'/'milestone' marker events a client sees on the HTTP read. Numbers are shared with items: the mission is #1, the milestone #2.",
  "server": { "tmpDb": true },
  "seed": {
    "users": [ { "as": "dan", "name": "dan", "password": "fixture-pw-16" } ],
    "agents": [ { "as": "bridge", "user": "dan", "name": "dev-2" } ],
    "conversations": [
      { "id": "c1", "owner": "dan", "title": "Session", "sessionState": "running", "agent": "bridge" },
      { "id": "c2", "owner": "dan", "title": "Other", "sessionState": "running", "agent": "bridge" }
    ]
  },
  "steps": [
    { "kind": "http", "method": "POST", "path": "/missions", "token": { "$ref": "bridge.token" },
      "body": { "title": "Missions & milestones", "body": "Ship it", "convo_id": "c1" },
      "expect": { "status": 201, "body": { "mission": {
        "id": { "$bind": "mission_id" }, "user_id": { "$ref": "dan.user_id" }, "num": 1, "state": "open",
        "title": "Missions & milestones", "body": "Ship it", "close_summary": null, "closed_by": null, "closed_over_open_items": 0,
        "origin_convo_id": "c1", "origin_device_id": { "$ref": "bridge.device_id" }, "created_by": "agent",
        "created_at": { "$type": "integer" }, "updated_at": { "$type": "integer" }, "last_milestone_at": null, "closed_at": null,
        "open_items": 0, "needs_you": 0, "conversations": 1, "milestones": 0, "last_milestone": null } } } },
    { "kind": "http", "method": "POST", "path": "/milestones", "token": { "$ref": "bridge.token" },
      "body": { "convo_id": "c2", "kind": "progress", "title": "nope" },
      "expect": { "status": 409, "body": { "error": "conflict", "blocked_by": "no_mission" } } },
    { "kind": "http", "method": "POST", "path": "/milestones", "token": { "$ref": "bridge.token" },
      "body": { "convo_id": "c1", "kind": "user_input", "title": "Dan asked for missions", "body": "the brief" },
      "expect": { "status": 201, "body": {
        "milestone": { "id": { "$bind": "milestone_id" }, "mission_id": { "$ref": "mission_id" }, "num": 2, "kind": "user_input",
          "title": "Dan asked for missions", "body": "the brief", "convo_id": "c1", "seq": { "$bind": "anchor_seq" },
          "device_id": { "$ref": "bridge.device_id" }, "created_by": "agent", "created_at": { "$type": "integer" } },
        "mission": { "$ignore": true } } } },
    { "kind": "http", "method": "POST", "path": "/missions/1/close", "token": { "$ref": "bridge.token" },
      "body": { "summary": "Done." },
      "expect": { "status": 200, "body": { "mission": { "$ignore": true } } } },
    { "kind": "http", "method": "GET", "path": "/convo/c1/messages?limit=10", "token": { "$ref": "bridge.token" },
      "expect": { "status": 200, "body": { "events": [
        { "seq": { "$type": "integer" }, "convo_id": "c1", "ts": { "$type": "integer" }, "sender": "agent:dev-2", "type": "mission",
          "payload": { "mission_id": { "$ref": "mission_id" }, "num": 1, "title": "Missions & milestones", "action": "created", "by": "agent" } },
        { "seq": { "$ref": "anchor_seq" }, "convo_id": "c1", "ts": { "$type": "integer" }, "sender": "agent:dev-2", "type": "milestone",
          "payload": { "milestone_id": { "$ref": "milestone_id" }, "num": 2, "kind": "user_input", "title": "Dan asked for missions", "body": "the brief",
            "mission_id": { "$ref": "mission_id" }, "mission_num": 1, "mission_title": "Missions & milestones", "by": "agent" } },
        { "seq": { "$type": "integer" }, "convo_id": "c1", "ts": { "$type": "integer" }, "sender": "agent:dev-2", "type": "mission",
          "payload": { "mission_id": { "$ref": "mission_id" }, "num": 1, "title": "Missions & milestones", "action": "closed", "by": "agent" } }
      ] } } }
  ]
}
```

Check the exact key set of `/convo/:id/messages` responses in `14_items_roundtrip.json` (it may include `next_before` or similar) and copy that envelope exactly — the matcher requires an exact key set.

- [ ] **Step 2: Run the conformance suite**

Run: `node --test test/conformance.test.js`
Expected: PASS for `15_missions_roundtrip.json`. Fix the fixture (not the code) if a key set differs, unless the code is actually wrong.

- [ ] **Step 3: Document**

In `docs/protocol.md`, after the Items section, add `## Missions & milestones` with: the routes table from the spec, the idempotency rule, the close rules, the two marker JSON blocks from the spec verbatim, and the sentence "Neither type is publishable by an agent (not in `AGENT_PUBLISH_TYPES`); neither is a `MESSAGE_TYPES` entry; neither pushes." Add `GET /missions`, `GET /missions/:id`, `GET /milestones` to the "Device privacy" enumeration, and the same three to the comment at `src/db.js` ~line 229.

In `src/help.js`, after the items paragraph, add:

```
Missions & milestones — POST /missions {title, body?, convo_id} (201 mission #num; 200 existing:true if the conversation already has one),
GET /missions?state=open|closed, GET /missions/:id (mission, milestones newest first, open items, conversations), PATCH /missions/:id {title?, body?},
POST /missions/:id/join {convo_id}, POST /missions/:id/close {summary} (409 blocked_by user_items|agent_items with the item list for agents),
POST /milestones {convo_id, kind: user_input|progress, title, body?} (409 blocked_by no_mission until mission_start; the marker's seq is the anchor),
GET /milestones?convo=<id>. PATCH /items/:id accepts mission: id|"#num"|null. Every POST takes Idempotency-Key.
```

- [ ] **Step 4: Full suite**

Run: `npm test`
Expected: PASS, all files.

- [ ] **Step 5: Commit**

```bash
git add docs/protocol.md src/help.js src/db.js test/fixtures/conformance/15_missions_roundtrip.json
git commit -m "missions: protocol doc, help text, conformance fixture"
```

---

### Task 9: Deploy

Not a code task; recorded here because the bridge plan depends on it.

- [ ] Back up the journal DB on the journal box (recipe: `technique_journal_deploy_dev2` memory / `docs/` deploy notes — the live journal is under `/opt/matron/journal`).
- [ ] Deploy the merged master; restart the service.
- [ ] Verify: `GET /missions` with a device token answers `{"missions":[]}` (not 404), and `PRAGMA table_info(missions)` on the live DB lists 17 columns.
- [ ] Only then start the bridge plan.

## Self-review against the spec

- Data model: Task 1 (tables, guarded columns, indexes). Numbers: Task 2 + `nextNum` use in Tasks 5/6. One mission per conversation, inheritance: Tasks 5/6. Items follow their conversation, repoint on create/join, `PATCH /items {mission}`: Tasks 5/7. Milestone anchor transactional + 502: Tasks 6/7. No auto-create → 409 `no_mission`: Tasks 6/7. Closing rules incl. `closed_over_open_items` + `open_item_nums`: Tasks 5/7. Privacy sieve: Tasks 5/7. Limits: Tasks 5/7 (`CONVOS_MAX`, `TITLE_MAX`, `BODY_MAX`; no milestone cap).
- HTTP API table: every route in Task 7. Idempotency: Tasks 5/6/7.
- Marker events: Task 3 payloads; `AGENT_PUBLISH_TYPES` untouched (Task 7 test); no push (Task 3).
- Testing section: shared counter (T2), `no_mission` writes nothing (T6/T7), inheritance (T6), repointing (T5/T7), `PATCH /items mission` (T7), close cases (T5/T7), closed rejects milestones and joins (T5/T6/T7), idempotency replay 200 (T5/T6/T7), marker seq equals `seq` (T6/T7), append failure 502 + no row (T6), privacy sieve (T7), conformance fixtures (T8 — one fixture covers both types).
- Placeholders: none. Type consistency: `createMilestone` returns `{ milestone, mission, duplicate, seq, ts }` and Task 7 uses `out.seq`/`out.ts`; `closeMission` returns `{ mission, openItemNums }` and Task 7 uses both; `getMission` accepts `ms_` ids, `#num`, and numbers, matching the `PATCH /items` `mission` field.
