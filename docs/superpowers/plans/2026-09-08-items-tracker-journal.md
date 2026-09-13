# Items Tracker (journal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the task & decision tracker's server side to matron-journal: `items` / `item_comments` tables, the nine HTTP routes, the `item` marker event on the origin conversation (with wake and push rules), documentation, and a conformance fixture.

**Architecture:** A pure-SQL module (`src/items.js`) owns every state transition and the rank math; a route module (`src/items-http.js`) does validation, auth, marker emission, wake, and push, and is called from `http.js`'s dispatcher after Bearer auth. The conversation log only ever carries `item` marker events written by the journal itself; the tables are the source of truth. Nothing else in the journal changes shape except: `push.js` learns to classify `item`, `wake.js` gains a shared `wakeConvoAgent`, and `db.js` gains three tables.

**Tech Stack:** Node ≥ 20 ESM, better-sqlite3, `node:test` + `node:assert/strict`, in-process test server via `test/helpers.js` (`startTestServer`, `makeWsClient`).

**Spec:** `docs/superpowers/specs/2026-09-08-task-decision-tracker-design.md` (sections *Data model*, *HTTP API*, *Marker event*, and the journal half of *Routing*, *Error handling*, *Testing*, *Rollout*).

## Global Constraints

- Ids: `items.id = 'it_' + 16 hex`, `item_comments.id = 'ic_' + 16 hex` (from `crypto.randomBytes(8).toString('hex')`).
- `kind IN ('task','question','decision')`; `state IN ('open','closed')`; `resolution IN ('done','answered','decided','reversed','cancelled')`; `awaiting IN ('user','agent')` or NULL.
- Limits: title ≤ 200 chars (after trim, non-empty), body ≤ 32 KiB, comment body ≤ 32 KiB, ≤ 20 attachments per comment (and per item body), ≤ 50 labels (each ≤ 40 chars), ≤ 50 links (each `{url ≤ 2048 chars, title? ≤ 200}`). Over-limit → 400 `bad_request`.
- Rank: new item = `max(rank) + 1024` (or `1024` for the first); `position:'top'` = `min(rank) - 1024`; `after`/`before` = midpoint. Renormalise all of the user's **open** items to `1024·n` when the two neighbours differ by < `1e-6`.
- List: default `limit` 100, max 500; `sort` ∈ `rank` | `updated` (default `rank` asc, then `num` asc as tiebreak; `updated` = `updated_at` desc, `num` desc).
- Marker event type is the string `'item'`; it is **not** in `MESSAGE_TYPES`, **not** in `AGENT_PUBLISH_TYPES`, and never client-only.
- Every route answers with the existing shapes: `{ error: 'bad_request' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' }`.
- Unknown ids and other users' rows are indistinguishable (404).
- All timestamps are `Date.now()` integers (ms).
- Every task ends with `npm test` green (`node --test --test-timeout=30000 'test/**/*.js'`).

---

## File map

| File | Responsibility |
|---|---|
| `src/db.js` (modify) | Three `CREATE TABLE IF NOT EXISTS` blocks + indexes appended to `SCHEMA`. |
| `src/items.js` (create) | Constants, validation, `createItem`, `getItem`, `listItems`, `updateItem`, `addComment`, `setAttachmentTranscript`, `closeItem`, `reopenItem`, `rerankItem`, `itemsNeedingUserCount`. Pure DB, no HTTP, no hub. |
| `src/items-http.js` (create) | `handleItemsRoute(ctx, req, res, url, who)` → `true` when it answered. Validation, sieve, marker emit, wake, push. |
| `src/http.js` (modify) | Import + one call to `handleItemsRoute` right after `who` is resolved; `makeHttpHandler` accepts `waker`. |
| `src/server.js` (modify) | Passes `waker: resolvedWaker` into `makeHttpHandler`. |
| `src/wake.js` (modify) | New export `wakeConvoAgent({ db, hub, waker }, userId, convoId)`; `ws.js` delegates to it. |
| `src/ws.js` (modify) | `wakeIfOffline` / `wakeConvoAgent` closures replaced by calls into `wake.js`. |
| `src/push.js` (modify) | `classify` handles `item`; `journal.js` `snippetOf` handles `item`. |
| `docs/protocol.md` (modify) | New `## Items (task & decision tracker)` section. |
| `test/fixtures/conformance/14_items_roundtrip.json` (create) | Golden exchange. |
| `test/items.test.js`, `test/items-http.test.js` (create); `test/push.test.js`, `test/wake.test.js`, `test/retention.test.js` (modify) | Tests. |

---

### Task 1: Schema

**Files:**
- Modify: `src/db.js` (inside the `SCHEMA` template literal, after the `agent_spawn_requests` index at ~line 111, before the search-index comment block)
- Test: `test/items.test.js` (new)

**Interfaces:**
- Produces: tables `items`, `item_comments`, `item_counters` exactly as below. Every later task reads these column names verbatim.

- [ ] **Step 1: Write the failing test**

```js
// test/items.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'

test('schema: items, item_comments, item_counters exist with the expected columns', () => {
  const db = openDb(':memory:')
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
  assert.deepEqual(cols('items'), [
    'id', 'user_id', 'num', 'kind', 'state', 'resolution', 'awaiting', 'rank', 'title', 'body',
    'labels', 'links', 'supersedes', 'origin_convo_id', 'origin_device_id', 'created_by',
    'idem_key', 'created_at', 'updated_at', 'closed_at',
  ])
  assert.deepEqual(cols('item_comments'), [
    'id', 'item_id', 'user_id', 'author', 'device_id', 'kind', 'body', 'attachments', 'meta', 'idem_key', 'created_at',
  ])
  assert.deepEqual(cols('item_counters'), ['user_id', 'next_num'])
  // (user_id, num) is unique
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  const ins = db.prepare(`INSERT INTO items(id,user_id,num,kind,state,rank,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at)
    VALUES(?,1,1,'task','open',1024,'t','c1',1,'user',0,0)`)
  ins.run('it_a')
  assert.throws(() => ins.run('it_b'), /UNIQUE/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/items.test.js`
Expected: FAIL — `PRAGMA table_info(items)` returns `[]` so the deepEqual fails.

- [ ] **Step 3: Add the tables to `SCHEMA`**

In `src/db.js`, immediately after `CREATE INDEX IF NOT EXISTS idx_spawn_state ON agent_spawn_requests(state, from_device_id);` add:

```sql
-- Task & decision tracker (spec: 2026-09-08 task-decision-tracker). Tables
-- are the source of truth; the conversation log only carries 'item' marker
-- events written by src/items-http.js. CHECKs list every value src/items.js
-- writes (the convo_agents lesson: an unlisted value fails silently).
CREATE TABLE IF NOT EXISTS items(
  id               TEXT PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  num              INTEGER NOT NULL,
  kind             TEXT NOT NULL CHECK(kind IN ('task','question','decision')),
  state            TEXT NOT NULL CHECK(state IN ('open','closed')),
  resolution       TEXT CHECK(resolution IN ('done','answered','decided','reversed','cancelled')),
  awaiting         TEXT CHECK(awaiting IN ('user','agent')),
  rank             REAL NOT NULL,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL DEFAULT '',
  labels           TEXT NOT NULL DEFAULT '[]',
  links            TEXT NOT NULL DEFAULT '[]',
  supersedes       TEXT REFERENCES items(id),
  origin_convo_id  TEXT NOT NULL,
  origin_device_id INTEGER NOT NULL,
  created_by       TEXT NOT NULL CHECK(created_by IN ('user','agent')),
  idem_key         TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  closed_at        INTEGER,
  UNIQUE(user_id, num),
  UNIQUE(user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_items_user_state ON items(user_id, state, rank);
CREATE INDEX IF NOT EXISTS idx_items_convo ON items(origin_convo_id, state);
CREATE INDEX IF NOT EXISTS idx_items_updated ON items(user_id, updated_at);
CREATE TABLE IF NOT EXISTS item_comments(
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES items(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  author      TEXT NOT NULL CHECK(author IN ('user','agent')),
  device_id   INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK(kind IN ('comment','status')),
  body        TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '[]',
  meta        TEXT,
  idem_key    TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE(user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_item_comments_item ON item_comments(item_id, created_at);
CREATE TABLE IF NOT EXISTS item_counters(
  user_id  INTEGER PRIMARY KEY,
  next_num INTEGER NOT NULL
);
```

Note: SQLite treats NULLs as distinct in UNIQUE, so rows without an idempotency key never collide.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/items.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/items.test.js
git commit -m "items: schema for the task & decision tracker"
```

---

### Task 2: `src/items.js` — constants, validation, create, get, list

**Files:**
- Create: `src/items.js`
- Test: `test/items.test.js` (append)

**Interfaces:**
- Produces (all `export`):
  - `ITEM_KINDS = ['task','question','decision']`, `RESOLUTIONS = [...]`, `AWAITING = ['user','agent']`, `TITLE_MAX = 200`, `BODY_MAX = 32768`, `LABELS_MAX = 50`, `LABEL_MAX = 40`, `LINKS_MAX = 50`, `URL_MAX = 2048`, `ATTACHMENTS_MAX = 20`, `RANK_GAP = 1024`, `RANK_EPSILON = 1e-6`.
  - `validateItemFields({ title, body, labels, links, attachments }, { partial = false })` → `{ ok: true, value: {…normalised} }` or `{ ok: false }`. Normalised: title trimmed; labels deduped; links `[{url, title?}]`; attachments `[{blob_ref, mime, name, size, transcript?}]`.
  - `createItem(db, { userId, kind, title, body, labels, links, attachments, awaiting, position, after, before, originConvoId, originDeviceId, createdBy, supersedes, idemKey, now })` → `{ item, duplicate }` (`duplicate: true` returns the pre-existing row for the same `idemKey`). Throws `Error('bad_after_before')` when `after`/`before` name an item that is not the user's or is closed.
  - `getItem(db, userId, idOrNum)` → row (parsed JSON columns) or `null`. `idOrNum` accepts `'it_…'`, `'#12'`, `'12'`, or the integer `12`.
  - `listItems(db, userId, { convoId, kind, state, awaiting, label, sort, since, limit, cursor, excludePrivateOwned })` → `{ items: [...rows with comment_count, last_comment_at, has_image], next_cursor }`.
  - `rowToItem(row)` → parsed shape (labels/links arrays, `attachments` array).

- [ ] **Step 1: Write the failing tests**

Append to `test/items.test.js`:

```js
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { createItem, getItem, listItems, validateItemFields } from '../src/items.js'

async function seed() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const pat = await createUser(db, 'pat', 'pw')
  const agent = createAgent(db, dan.id, 'dev-2')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(db, { id: 'c2', ownerUserId: dan.id, title: 'C2', agentDeviceId: agent.deviceId })
  return { db, dan, pat, agent }
}

const base = (o = {}) => ({
  kind: 'task', title: 'Do the thing', originConvoId: 'c1', originDeviceId: 1, createdBy: 'agent', ...o,
})

test('validateItemFields: trims, caps, dedupes, rejects junk', () => {
  assert.equal(validateItemFields({ title: '  ' }).ok, false)
  assert.equal(validateItemFields({ title: 'x'.repeat(201) }).ok, false)
  assert.equal(validateItemFields({ title: 't', body: 'x'.repeat(32769) }).ok, false)
  assert.equal(validateItemFields({ title: 't', labels: ['a', 'a', 'b'] }).value.labels.join(), 'a,b')
  assert.equal(validateItemFields({ title: 't', labels: 'nope' }).ok, false)
  assert.equal(validateItemFields({ title: 't', links: [{ url: 'https://x' }] }).value.links[0].url, 'https://x')
  assert.equal(validateItemFields({ title: 't', links: [{ url: 'javascript:alert(1)' }] }).ok, false)
  assert.equal(validateItemFields({ title: 't', attachments: [{ blob_ref: 'b', mime: 'image/png', name: 'a.png', size: 3 }] }).value.attachments[0].mime, 'image/png')
  assert.equal(validateItemFields({ title: 't', attachments: [{ mime: 'image/png' }] }).ok, false)
  // partial: title may be absent
  assert.equal(validateItemFields({ body: 'b' }, { partial: true }).ok, true)
})

test('createItem numbers per user, ranks at the bottom, and honours position/after/before', async () => {
  const { db, dan, pat } = await seed()
  const a = createItem(db, base({ userId: dan.id })).item
  const b = createItem(db, base({ userId: dan.id, title: 'B' })).item
  const p = createItem(db, base({ userId: pat.id, originConvoId: 'c1' })).item
  assert.equal(a.num, 1); assert.equal(b.num, 2); assert.equal(p.num, 1)
  assert.equal(a.rank, 1024); assert.equal(b.rank, 2048)
  const top = createItem(db, base({ userId: dan.id, title: 'T', position: 'top' })).item
  assert.equal(top.rank, 0)
  const mid = createItem(db, base({ userId: dan.id, title: 'M', after: a.id, before: b.id })).item
  assert.equal(mid.rank, 1536)
  assert.throws(() => createItem(db, base({ userId: dan.id, after: p.id })), /bad_after_before/)
  assert.equal(a.state, 'open'); assert.equal(a.awaiting, 'agent') // task default
  const q = createItem(db, base({ userId: dan.id, kind: 'question' })).item
  assert.equal(q.awaiting, 'user')
  const d = createItem(db, base({ userId: dan.id, kind: 'decision' })).item
  assert.equal(d.awaiting, null)
})

test('createItem idempotency returns the original row', async () => {
  const { db, dan } = await seed()
  const r1 = createItem(db, base({ userId: dan.id, idemKey: 'k1' }))
  const r2 = createItem(db, base({ userId: dan.id, idemKey: 'k1', title: 'changed' }))
  assert.equal(r1.duplicate, false); assert.equal(r2.duplicate, true)
  assert.equal(r2.item.id, r1.item.id); assert.equal(r2.item.title, 'Do the thing')
})

test('getItem accepts id, #num, num; other user 404s', async () => {
  const { db, dan, pat } = await seed()
  const a = createItem(db, base({ userId: dan.id })).item
  assert.equal(getItem(db, dan.id, a.id).id, a.id)
  assert.equal(getItem(db, dan.id, '#1').id, a.id)
  assert.equal(getItem(db, dan.id, 1).id, a.id)
  assert.equal(getItem(db, pat.id, a.id), null)
  assert.deepEqual(getItem(db, dan.id, a.id).labels, [])
})

test('listItems filters, sorts, pages, and decorates', async () => {
  const { db, dan } = await seed()
  const a = createItem(db, base({ userId: dan.id, now: 1 })).item
  const b = createItem(db, base({ userId: dan.id, kind: 'question', originConvoId: 'c2', now: 2 })).item
  createItem(db, base({ userId: dan.id, kind: 'decision', labels: ['ui'], now: 3 }))
  assert.equal(listItems(db, dan.id, {}).items.length, 3)
  assert.equal(listItems(db, dan.id, { convoId: 'c2' }).items[0].id, b.id)
  assert.equal(listItems(db, dan.id, { kind: 'decision' }).items.length, 1)
  assert.equal(listItems(db, dan.id, { awaiting: 'user' }).items[0].id, b.id)
  assert.equal(listItems(db, dan.id, { label: 'ui' }).items.length, 1)
  assert.equal(listItems(db, dan.id, { since: 2 }).items.length, 2) // updated_at >= since
  const byRank = listItems(db, dan.id, { sort: 'rank' }).items.map((i) => i.num)
  assert.deepEqual(byRank, [1, 2, 3])
  const byUpd = listItems(db, dan.id, { sort: 'updated' }).items.map((i) => i.num)
  assert.deepEqual(byUpd, [3, 2, 1])
  const p1 = listItems(db, dan.id, { limit: 2 })
  assert.equal(p1.items.length, 2); assert.ok(p1.next_cursor)
  const p2 = listItems(db, dan.id, { limit: 2, cursor: p1.next_cursor })
  assert.equal(p2.items.length, 1); assert.equal(p2.next_cursor, null)
  assert.equal(p1.items[0].comment_count, 0)
  assert.equal(p1.items[0].has_image, false)
  assert.equal(listItems(db, dan.id, { state: 'open' }).items.length, 3)
  assert.equal(listItems(db, dan.id, { state: 'closed' }).items.length, 0)
  void a
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/items.test.js`
Expected: FAIL — `Cannot find module '../src/items.js'`.

- [ ] **Step 3: Create `src/items.js`**

```js
// Task & decision tracker — pure DB state (spec: 2026-09-08
// task-decision-tracker). Every transition lives here so the HTTP layer,
// tests, and any future WS op share one set of rules. No hub, no push, no
// wake: those are src/items-http.js's job.
import { randomBytes } from 'node:crypto'

export const ITEM_KINDS = ['task', 'question', 'decision']
export const RESOLUTIONS = ['done', 'answered', 'decided', 'reversed', 'cancelled']
export const AWAITING = ['user', 'agent']
export const TITLE_MAX = 200
export const BODY_MAX = 32768
export const LABELS_MAX = 50
export const LABEL_MAX = 40
export const LINKS_MAX = 50
export const URL_MAX = 2048
export const ATTACHMENTS_MAX = 20
export const RANK_GAP = 1024
export const RANK_EPSILON = 1e-6

const newId = (prefix) => `${prefix}_${randomBytes(8).toString('hex')}`

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function validateAttachments(list) {
  if (list === undefined) return { ok: true, value: [] }
  if (!Array.isArray(list) || list.length > ATTACHMENTS_MAX) return { ok: false }
  const out = []
  for (const a of list) {
    if (!isPlainObject(a)) return { ok: false }
    if (typeof a.blob_ref !== 'string' || !a.blob_ref || a.blob_ref.length > 128) return { ok: false }
    if (typeof a.mime !== 'string' || !a.mime || a.mime.length > 128) return { ok: false }
    if (typeof a.name !== 'string' || a.name.length > 255) return { ok: false }
    if (!Number.isInteger(a.size) || a.size < 0) return { ok: false }
    const att = { blob_ref: a.blob_ref, mime: a.mime, name: a.name, size: a.size }
    if (a.transcript !== undefined) {
      if (typeof a.transcript !== 'string' || a.transcript.length > BODY_MAX) return { ok: false }
      att.transcript = a.transcript
    }
    out.push(att)
  }
  return { ok: true, value: out }
}

// Normalises and bounds every user/agent-writable field. `partial` (PATCH)
// lets `title` be absent; a present field is always validated in full.
export function validateItemFields(fields, { partial = false } = {}) {
  if (!isPlainObject(fields)) return { ok: false }
  const value = {}
  if (fields.title !== undefined || !partial) {
    if (typeof fields.title !== 'string') return { ok: false }
    const t = fields.title.trim()
    if (!t || t.length > TITLE_MAX) return { ok: false }
    value.title = t
  }
  if (fields.body !== undefined) {
    if (typeof fields.body !== 'string' || fields.body.length > BODY_MAX) return { ok: false }
    value.body = fields.body
  }
  if (fields.labels !== undefined) {
    if (!Array.isArray(fields.labels) || fields.labels.length > LABELS_MAX) return { ok: false }
    const seen = new Set()
    for (const l of fields.labels) {
      if (typeof l !== 'string') return { ok: false }
      const s = l.trim()
      if (!s || s.length > LABEL_MAX) return { ok: false }
      seen.add(s)
    }
    value.labels = [...seen]
  }
  if (fields.links !== undefined) {
    if (!Array.isArray(fields.links) || fields.links.length > LINKS_MAX) return { ok: false }
    value.links = []
    for (const l of fields.links) {
      if (!isPlainObject(l) || typeof l.url !== 'string' || l.url.length > URL_MAX) return { ok: false }
      if (!/^https?:\/\//i.test(l.url)) return { ok: false }
      const link = { url: l.url }
      if (l.title !== undefined) {
        if (typeof l.title !== 'string' || l.title.length > TITLE_MAX) return { ok: false }
        link.title = l.title
      }
      value.links.push(link)
    }
  }
  const att = validateAttachments(fields.attachments)
  if (!att.ok) return { ok: false }
  if (fields.attachments !== undefined) value.attachments = att.value
  return { ok: true, value }
}

const parseJson = (s, fallback) => { try { return JSON.parse(s) } catch { return fallback } }

export function rowToItem(row) {
  if (!row) return null
  const { labels, links, attachments, ...rest } = row
  const out = {
    ...rest,
    labels: parseJson(labels, []),
    links: parseJson(links, []),
    attachments: parseJson(attachments ?? '[]', []),
  }
  if ('comment_count' in out) out.comment_count = Number(out.comment_count)
  if ('has_image' in out) out.has_image = !!out.has_image
  return out
}

export function rowToComment(row) {
  if (!row) return null
  const { attachments, meta, ...rest } = row
  return { ...rest, attachments: parseJson(attachments, []), meta: meta == null ? null : parseJson(meta, null) }
}

// Default `awaiting` per kind at creation (spec: Semantics).
export function defaultAwaiting(kind) {
  if (kind === 'question') return 'user'
  if (kind === 'task') return 'agent'
  return null
}

function nextNum(db, userId) {
  db.prepare('INSERT INTO item_counters(user_id, next_num) VALUES(?, 1) ON CONFLICT(user_id) DO NOTHING').run(userId)
  const row = db.prepare('UPDATE item_counters SET next_num = next_num + 1 WHERE user_id=? RETURNING next_num').get(userId)
  return row.next_num - 1
}

function rankBounds(db, userId) {
  return db.prepare("SELECT MIN(rank) AS lo, MAX(rank) AS hi FROM items WHERE user_id=? AND state='open'").get(userId)
}

function openRankOf(db, userId, id) {
  const r = db.prepare("SELECT rank FROM items WHERE id=? AND user_id=? AND state='open'").get(id, userId)
  return r ? r.rank : null
}

// Renormalise every open item of the user to 1024·n in rank order. Called
// only when a midpoint would land within RANK_EPSILON of a neighbour.
export function renormaliseRanks(db, userId) {
  const rows = db.prepare("SELECT id FROM items WHERE user_id=? AND state='open' ORDER BY rank ASC, num ASC").all(userId)
  const upd = db.prepare('UPDATE items SET rank=? WHERE id=?')
  rows.forEach((r, i) => upd.run(RANK_GAP * (i + 1), r.id))
}

// Resolves a target rank from {position, after, before}. Throws
// Error('bad_after_before') when a named neighbour is not one of the user's
// OPEN items. `excludeId` keeps a reorder from using itself as a neighbour.
export function resolveRank(db, userId, { position, after, before, excludeId = null }) {
  const bounds = rankBounds(db, userId)
  if (after == null && before == null) {
    if (position === 'top') return bounds.lo == null ? RANK_GAP : bounds.lo - RANK_GAP
    return bounds.hi == null ? RANK_GAP : bounds.hi + RANK_GAP
  }
  let lo = null, hi = null
  if (after != null) {
    if (after === excludeId) throw new Error('bad_after_before')
    lo = openRankOf(db, userId, after)
    if (lo == null) throw new Error('bad_after_before')
  }
  if (before != null) {
    if (before === excludeId) throw new Error('bad_after_before')
    hi = openRankOf(db, userId, before)
    if (hi == null) throw new Error('bad_after_before')
  }
  if (lo == null) {
    // "before X" only: sit between X's predecessor and X.
    const prev = db.prepare("SELECT MAX(rank) AS r FROM items WHERE user_id=? AND state='open' AND rank < ? AND id<>?").get(userId, hi, excludeId ?? '').r
    lo = prev == null ? hi - RANK_GAP * 2 : prev
  }
  if (hi == null) {
    const next = db.prepare("SELECT MIN(rank) AS r FROM items WHERE user_id=? AND state='open' AND rank > ? AND id<>?").get(userId, lo, excludeId ?? '').r
    hi = next == null ? lo + RANK_GAP * 2 : next
  }
  if (hi - lo < RANK_EPSILON) {
    renormaliseRanks(db, userId)
    return resolveRank(db, userId, { position, after, before, excludeId })
  }
  return (lo + hi) / 2
}

export function createItem(db, {
  userId, kind, title, body = '', labels = [], links = [], attachments = [], awaiting, position, after, before,
  originConvoId, originDeviceId, createdBy, supersedes = null, idemKey = null, now = Date.now(),
}) {
  return db.transaction(() => {
    if (idemKey) {
      const dup = db.prepare('SELECT * FROM items WHERE user_id=? AND idem_key=?').get(userId, idemKey)
      if (dup) return { item: rowToItem(dup), duplicate: true }
    }
    if (supersedes != null) {
      const sup = db.prepare('SELECT 1 FROM items WHERE id=? AND user_id=?').get(supersedes, userId)
      if (!sup) throw new Error('bad_supersedes')
    }
    const rank = resolveRank(db, userId, { position, after, before })
    const id = newId('it')
    const num = nextNum(db, userId)
    const aw = awaiting === undefined ? defaultAwaiting(kind) : awaiting
    db.prepare(`INSERT INTO items(id,user_id,num,kind,state,resolution,awaiting,rank,title,body,labels,links,supersedes,
      origin_convo_id,origin_device_id,created_by,idem_key,created_at,updated_at)
      VALUES(?,?,?,?,'open',NULL,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, userId, num, kind, aw, rank, title, body, JSON.stringify(labels), JSON.stringify(links), supersedes,
        originConvoId, originDeviceId, createdBy, idemKey, now, now)
    if (attachments.length) {
      // Item-body attachments ride on a synthetic first comment of kind
      // 'status' with meta.role='body' so the thread has one place for
      // blob refs; rowToItem exposes them as item.attachments via listItems'
      // decoration query. Simpler than a fourth table.
      db.prepare(`INSERT INTO item_comments(id,item_id,user_id,author,device_id,kind,body,attachments,meta,created_at)
        VALUES(?,?,?,?,?,'status','',?,?,?)`)
        .run(newId('ic'), id, userId, createdBy, originDeviceId, JSON.stringify(attachments), JSON.stringify({ role: 'body' }), now)
    }
    return { item: getItem(db, userId, id), duplicate: false }
  })()
}

const DECORATE = `
  (SELECT COUNT(*) FROM item_comments c WHERE c.item_id = i.id AND c.kind='comment') AS comment_count,
  (SELECT MAX(created_at) FROM item_comments c WHERE c.item_id = i.id AND c.kind='comment') AS last_comment_at,
  (SELECT COALESCE(attachments,'[]') FROM item_comments c WHERE c.item_id = i.id AND c.kind='status' AND c.meta LIKE '%"role":"body"%' LIMIT 1) AS attachments,
  EXISTS(SELECT 1 FROM item_comments c WHERE c.item_id = i.id AND c.attachments LIKE '%"mime":"image/%') AS has_image
`

export function getItem(db, userId, idOrNum) {
  let row
  if (typeof idOrNum === 'string' && idOrNum.startsWith('it_')) {
    row = db.prepare(`SELECT i.*, ${DECORATE} FROM items i WHERE i.id=? AND i.user_id=?`).get(idOrNum, userId)
  } else {
    const n = Number(String(idOrNum).replace(/^#/, ''))
    if (!Number.isInteger(n) || n < 1) return null
    row = db.prepare(`SELECT i.*, ${DECORATE} FROM items i WHERE i.num=? AND i.user_id=?`).get(n, userId)
  }
  return rowToItem(row)
}

export function listComments(db, itemId) {
  return db.prepare("SELECT * FROM item_comments WHERE item_id=? AND NOT (kind='status' AND meta LIKE '%\"role\":\"body\"%') ORDER BY created_at ASC, id ASC")
    .all(itemId).map(rowToComment)
}

// Cursor = base64url of JSON [sortKey, num]; opaque to callers.
const encCursor = (a) => Buffer.from(JSON.stringify(a)).toString('base64url')
const decCursor = (s) => { try { const v = JSON.parse(Buffer.from(String(s), 'base64url').toString()); return Array.isArray(v) && v.length === 2 ? v : null } catch { return null } }

export function listItems(db, userId, {
  convoId = null, kind = null, state = null, awaiting = null, label = null, sort = 'rank', since = null,
  limit = 100, cursor = null, excludePrivateOwned = false,
} = {}) {
  const where = ['i.user_id = ?']
  const args = [userId]
  if (convoId != null) { where.push('i.origin_convo_id = ?'); args.push(convoId) }
  if (kind != null) { where.push('i.kind = ?'); args.push(kind) }
  if (state != null) { where.push('i.state = ?'); args.push(state) }
  if (awaiting != null) { where.push('i.awaiting = ?'); args.push(awaiting) }
  if (label != null) { where.push("EXISTS (SELECT 1 FROM json_each(i.labels) WHERE value = ?)"); args.push(label) }
  if (since != null) { where.push('i.updated_at >= ?'); args.push(since) }
  if (excludePrivateOwned) {
    // Same predicate as /search's excludePrivateOwned (src/search.js): an
    // item born in a conversation managed by a private device is invisible
    // to an ordinary agent caller.
    where.push(`NOT EXISTS (SELECT 1 FROM conversations cv JOIN devices d ON d.id = cv.agent_device_id
      WHERE cv.id = i.origin_convo_id AND COALESCE(d.private, 0) = 1)`)
  }
  const cur = cursor ? decCursor(cursor) : null
  if (cursor && !cur) return { badCursor: true }
  let order
  if (sort === 'updated') {
    order = 'i.updated_at DESC, i.num DESC'
    if (cur) { where.push('(i.updated_at < ? OR (i.updated_at = ? AND i.num < ?))'); args.push(cur[0], cur[0], cur[1]) }
  } else {
    order = 'i.rank ASC, i.num ASC'
    if (cur) { where.push('(i.rank > ? OR (i.rank = ? AND i.num > ?))'); args.push(cur[0], cur[0], cur[1]) }
  }
  const rows = db.prepare(`SELECT i.*, ${DECORATE} FROM items i WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`)
    .all(...args, limit + 1)
  const page = rows.slice(0, limit).map(rowToItem)
  const last = page[page.length - 1]
  const next_cursor = rows.length > limit && last
    ? encCursor([sort === 'updated' ? last.updated_at : last.rank, last.num])
    : null
  return { items: page, next_cursor }
}

// "Needs you" count per origin conversation — the chat-list badge feed.
export function needsUserCounts(db, userId) {
  return db.prepare("SELECT origin_convo_id AS convo_id, COUNT(*) AS n FROM items WHERE user_id=? AND state='open' AND awaiting='user' GROUP BY origin_convo_id").all(userId)
}
```

`devices.private` (INTEGER 0/1, added by the migration at `src/db.js:189`) is the column `isPrivateDevice` reads; `private_pinned` is a different flag and must not be used here.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/items.test.js`
Expected: PASS (7 tests). If `RETURNING` is unsupported by the bundled SQLite, replace `nextNum` with an `UPDATE` followed by a `SELECT next_num`.

- [ ] **Step 5: Commit**

```bash
git add src/items.js test/items.test.js
git commit -m "items: create/get/list with per-user numbering, ranks, filters, cursors"
```

---

### Task 3: `src/items.js` — comments, close, reopen, update, transcript

**Files:**
- Modify: `src/items.js`
- Test: `test/items.test.js` (append)

**Interfaces:**
- Consumes: Task 2's `getItem`, `rowToComment`, `validateItemFields`.
- Produces (all `export`):
  - `addComment(db, { userId, itemId, author, deviceId, body, attachments, idemKey, now })` → `{ item, comment, duplicate }`. Applies the awaiting flip: author `user` → `awaiting='agent'` (any kind, and reopens a closed item: `state='open'`, `resolution=NULL`, `closed_at=NULL`); author `agent` → unchanged `awaiting` unless the item is a question or task awaiting the agent, in which case it stays as is (agents change `awaiting` explicitly via `updateItem`).
  - `closeItem(db, { userId, itemId, resolution, author, deviceId, comment, now })` → `{ item, comment }` or `null` when already closed (409 at the route). Writes a `status` comment with `meta = { from: {state, resolution, awaiting}, to: {…} }` plus the optional text in `body`. Sets `awaiting=NULL`.
  - `reopenItem(db, { userId, itemId, author, deviceId, comment, now })` → `{ item, comment }` or `null` when already open. `awaiting` = `defaultAwaiting(kind)` except: a decision reopened is back in force with `awaiting=NULL`.
  - `updateItem(db, { userId, itemId, fields, now })` → item or `null`. `fields` is the normalised `validateItemFields(...).value` plus optional `awaiting` (validated by the caller: `'user' | 'agent' | null`).
  - `setAttachmentTranscript(db, { userId, itemId, commentId, blobRef, transcript, now })` → comment or `null`.

- [ ] **Step 1: Write the failing tests**

Append to `test/items.test.js`:

```js
import { addComment, closeItem, reopenItem, updateItem, setAttachmentTranscript, listComments } from '../src/items.js'

test('addComment flips awaiting to agent for user comments and reopens closed items', async () => {
  const { db, dan } = await seed()
  const q = createItem(db, base({ userId: dan.id, kind: 'question' })).item
  const r = addComment(db, { userId: dan.id, itemId: q.id, author: 'user', deviceId: 9, body: 'use A' })
  assert.equal(r.item.awaiting, 'agent'); assert.equal(r.comment.kind, 'comment'); assert.equal(r.duplicate, false)
  const a = addComment(db, { userId: dan.id, itemId: q.id, author: 'agent', deviceId: 1, body: 'ok' })
  assert.equal(a.item.awaiting, 'agent') // agent comments never flip by themselves
  closeItem(db, { userId: dan.id, itemId: q.id, resolution: 'answered', author: 'agent', deviceId: 1 })
  const again = addComment(db, { userId: dan.id, itemId: q.id, author: 'user', deviceId: 9, body: 'actually…' })
  assert.equal(again.item.state, 'open'); assert.equal(again.item.resolution, null); assert.equal(again.item.awaiting, 'agent')
  assert.equal(listComments(db, q.id).length, 4) // comment, comment, status(close), comment
  // idempotent
  const k1 = addComment(db, { userId: dan.id, itemId: q.id, author: 'user', deviceId: 9, body: 'x', idemKey: 'c1' })
  const k2 = addComment(db, { userId: dan.id, itemId: q.id, author: 'user', deviceId: 9, body: 'y', idemKey: 'c1' })
  assert.equal(k2.duplicate, true); assert.equal(k2.comment.id, k1.comment.id)
  assert.equal(addComment(db, { userId: 999, itemId: q.id, author: 'user', deviceId: 9, body: 'x' }), null)
})

test('closeItem / reopenItem write status comments and enforce state', async () => {
  const { db, dan } = await seed()
  const t = createItem(db, base({ userId: dan.id })).item
  const c = closeItem(db, { userId: dan.id, itemId: t.id, resolution: 'done', author: 'agent', deviceId: 1, comment: 'shipped' })
  assert.equal(c.item.state, 'closed'); assert.equal(c.item.resolution, 'done'); assert.equal(c.item.awaiting, null)
  assert.ok(c.item.closed_at)
  assert.equal(c.comment.kind, 'status'); assert.equal(c.comment.body, 'shipped')
  assert.deepEqual(c.comment.meta.to, { state: 'closed', resolution: 'done', awaiting: null })
  assert.equal(closeItem(db, { userId: dan.id, itemId: t.id, resolution: 'done', author: 'agent', deviceId: 1 }), null)
  const r = reopenItem(db, { userId: dan.id, itemId: t.id, author: 'user', deviceId: 9 })
  assert.equal(r.item.state, 'open'); assert.equal(r.item.awaiting, 'agent'); assert.equal(r.item.closed_at, null)
  assert.equal(reopenItem(db, { userId: dan.id, itemId: t.id, author: 'user', deviceId: 9 }), null)
  const d = createItem(db, base({ userId: dan.id, kind: 'decision' })).item
  closeItem(db, { userId: dan.id, itemId: d.id, resolution: 'reversed', author: 'user', deviceId: 9 })
  assert.equal(reopenItem(db, { userId: dan.id, itemId: d.id, author: 'agent', deviceId: 1 }).item.awaiting, null)
})

test('updateItem patches fields and awaiting; bumps updated_at', async () => {
  const { db, dan } = await seed()
  const t = createItem(db, base({ userId: dan.id, now: 5 })).item
  const u = updateItem(db, { userId: dan.id, itemId: t.id, fields: { title: 'New', labels: ['x'], awaiting: 'user' }, now: 6 })
  assert.equal(u.title, 'New'); assert.deepEqual(u.labels, ['x']); assert.equal(u.awaiting, 'user'); assert.equal(u.updated_at, 6)
  assert.equal(updateItem(db, { userId: dan.id, itemId: t.id, fields: { awaiting: null } }).awaiting, null)
  assert.equal(updateItem(db, { userId: 999, itemId: t.id, fields: { title: 'x' } }), null)
})

test('setAttachmentTranscript writes into exactly one attachment', async () => {
  const { db, dan } = await seed()
  const t = createItem(db, base({ userId: dan.id })).item
  const c = addComment(db, { userId: dan.id, itemId: t.id, author: 'user', deviceId: 9, body: '',
    attachments: [{ blob_ref: 'b1', mime: 'audio/mp4', name: 'v.m4a', size: 10 }, { blob_ref: 'b2', mime: 'image/png', name: 'p.png', size: 1 }] }).comment
  const out = setAttachmentTranscript(db, { userId: dan.id, itemId: t.id, commentId: c.id, blobRef: 'b1', transcript: 'hello' })
  assert.equal(out.attachments[0].transcript, 'hello'); assert.equal(out.attachments[1].transcript, undefined)
  assert.equal(setAttachmentTranscript(db, { userId: dan.id, itemId: t.id, commentId: c.id, blobRef: 'nope', transcript: 'x' }), null)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/items.test.js`
Expected: FAIL — `addComment` etc. are not exported.

- [ ] **Step 3: Append to `src/items.js`**

```js
function touch(db, itemId, now) {
  db.prepare('UPDATE items SET updated_at=? WHERE id=?').run(now, itemId)
}

function insertComment(db, { itemId, userId, author, deviceId, kind, body, attachments, meta, idemKey, now }) {
  const id = newId('ic')
  db.prepare(`INSERT INTO item_comments(id,item_id,user_id,author,device_id,kind,body,attachments,meta,idem_key,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, itemId, userId, author, deviceId, kind, body, JSON.stringify(attachments ?? []), meta == null ? null : JSON.stringify(meta), idemKey, now)
  return rowToComment(db.prepare('SELECT * FROM item_comments WHERE id=?').get(id))
}

const ownedRow = (db, userId, itemId) => db.prepare('SELECT * FROM items WHERE id=? AND user_id=?').get(itemId, userId)

export function addComment(db, { userId, itemId, author, deviceId, body = '', attachments = [], idemKey = null, now = Date.now() }) {
  return db.transaction(() => {
    const row = ownedRow(db, userId, itemId)
    if (!row) return null
    if (idemKey) {
      const dup = db.prepare('SELECT * FROM item_comments WHERE user_id=? AND idem_key=?').get(userId, idemKey)
      if (dup) return { item: getItem(db, userId, itemId), comment: rowToComment(dup), duplicate: true }
    }
    const comment = insertComment(db, { itemId, userId, author, deviceId, kind: 'comment', body, attachments, meta: null, idemKey, now })
    if (author === 'user') {
      // The user's words always hand the ball to the agent, and wake a
      // closed item back up (spec: "any further user comment on a closed
      // item reopens it awaiting the agent").
      db.prepare("UPDATE items SET state='open', resolution=NULL, closed_at=NULL, awaiting='agent', updated_at=? WHERE id=?").run(now, itemId)
    } else {
      touch(db, itemId, now)
    }
    return { item: getItem(db, userId, itemId), comment, duplicate: false }
  })()
}

const statusOf = (row) => ({ state: row.state, resolution: row.resolution, awaiting: row.awaiting })

export function closeItem(db, { userId, itemId, resolution, author, deviceId, comment = '', now = Date.now() }) {
  return db.transaction(() => {
    const row = ownedRow(db, userId, itemId)
    if (!row || row.state === 'closed') return null
    const to = { state: 'closed', resolution, awaiting: null }
    db.prepare("UPDATE items SET state='closed', resolution=?, awaiting=NULL, closed_at=?, updated_at=? WHERE id=?").run(resolution, now, now, itemId)
    const c = insertComment(db, { itemId, userId, author, deviceId, kind: 'status', body: comment, attachments: [], meta: { from: statusOf(row), to }, idemKey: null, now })
    return { item: getItem(db, userId, itemId), comment: c }
  })()
}

export function reopenItem(db, { userId, itemId, author, deviceId, comment = '', now = Date.now() }) {
  return db.transaction(() => {
    const row = ownedRow(db, userId, itemId)
    if (!row || row.state === 'open') return null
    const awaiting = row.kind === 'decision' ? null : defaultAwaiting(row.kind)
    const to = { state: 'open', resolution: null, awaiting }
    db.prepare("UPDATE items SET state='open', resolution=NULL, awaiting=?, closed_at=NULL, updated_at=? WHERE id=?").run(awaiting, now, itemId)
    const c = insertComment(db, { itemId, userId, author, deviceId, kind: 'status', body: comment, attachments: [], meta: { from: statusOf(row), to }, idemKey: null, now })
    return { item: getItem(db, userId, itemId), comment: c }
  })()
}

export function updateItem(db, { userId, itemId, fields, now = Date.now() }) {
  return db.transaction(() => {
    const row = ownedRow(db, userId, itemId)
    if (!row) return null
    const sets = ['updated_at=?']
    const args = [now]
    if (fields.title !== undefined) { sets.push('title=?'); args.push(fields.title) }
    if (fields.body !== undefined) { sets.push('body=?'); args.push(fields.body) }
    if (fields.labels !== undefined) { sets.push('labels=?'); args.push(JSON.stringify(fields.labels)) }
    if (fields.links !== undefined) { sets.push('links=?'); args.push(JSON.stringify(fields.links)) }
    if (fields.awaiting !== undefined) { sets.push('awaiting=?'); args.push(fields.awaiting) }
    db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id=?`).run(...args, itemId)
    return getItem(db, userId, itemId)
  })()
}

export function setAttachmentTranscript(db, { userId, itemId, commentId, blobRef, transcript, now = Date.now() }) {
  return db.transaction(() => {
    const c = db.prepare('SELECT * FROM item_comments WHERE id=? AND item_id=? AND user_id=?').get(commentId, itemId, userId)
    if (!c) return null
    const atts = parseJson(c.attachments, [])
    const target = atts.find((a) => a.blob_ref === blobRef)
    if (!target) return null
    target.transcript = transcript
    db.prepare('UPDATE item_comments SET attachments=? WHERE id=?').run(JSON.stringify(atts), commentId)
    touch(db, itemId, now)
    return rowToComment(db.prepare('SELECT * FROM item_comments WHERE id=?').get(commentId))
  })()
}

export function rerankItem(db, { userId, itemId, position, after, before, now = Date.now() }) {
  return db.transaction(() => {
    const row = ownedRow(db, userId, itemId)
    if (!row) return null
    const rank = resolveRank(db, userId, { position, after, before, excludeId: itemId })
    db.prepare('UPDATE items SET rank=?, updated_at=? WHERE id=?').run(rank, now, itemId)
    return getItem(db, userId, itemId)
  })()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/items.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/items.js test/items.test.js
git commit -m "items: comments with awaiting flips, close/reopen status rows, patch, transcripts"
```

---

### Task 4: Rank math — reorder and renormalisation

**Files:**
- Modify: `src/items.js` (already has `rerankItem`, `resolveRank`, `renormaliseRanks` from Tasks 2–3)
- Test: `test/items.test.js` (append)

**Interfaces:**
- Consumes: `rerankItem`, `renormaliseRanks`, `RANK_GAP`, `RANK_EPSILON`.

- [ ] **Step 1: Write the failing tests**

```js
import { rerankItem, renormaliseRanks, RANK_GAP } from '../src/items.js'

test('rerankItem: midpoints, top, bottom, self-neighbour rejected, closed neighbour rejected', async () => {
  const { db, dan } = await seed()
  const [a, b, c] = ['A', 'B', 'C'].map((t) => createItem(db, base({ userId: dan.id, title: t })).item)
  assert.equal(rerankItem(db, { userId: dan.id, itemId: c.id, after: a.id, before: b.id }).rank, (a.rank + b.rank) / 2)
  assert.equal(rerankItem(db, { userId: dan.id, itemId: c.id, position: 'top' }).rank, a.rank - RANK_GAP)
  assert.equal(rerankItem(db, { userId: dan.id, itemId: c.id, position: 'bottom' }).rank, b.rank + RANK_GAP)
  // "before b" alone lands between its predecessor (a) and b
  assert.equal(rerankItem(db, { userId: dan.id, itemId: c.id, before: b.id }).rank, (a.rank + b.rank) / 2)
  // "after b" alone with nothing after b → b + 1024
  assert.equal(rerankItem(db, { userId: dan.id, itemId: c.id, after: b.id }).rank, b.rank + RANK_GAP)
  assert.throws(() => rerankItem(db, { userId: dan.id, itemId: c.id, after: c.id }), /bad_after_before/)
  closeItem(db, { userId: dan.id, itemId: a.id, resolution: 'done', author: 'agent', deviceId: 1 })
  assert.throws(() => rerankItem(db, { userId: dan.id, itemId: c.id, after: a.id }), /bad_after_before/)
  assert.equal(rerankItem(db, { userId: 999, itemId: c.id, position: 'top' }), null)
})

test('rerankItem renormalises when the gap is exhausted', async () => {
  const { db, dan } = await seed()
  const a = createItem(db, base({ userId: dan.id, title: 'A' })).item
  const b = createItem(db, base({ userId: dan.id, title: 'B' })).item
  const c = createItem(db, base({ userId: dan.id, title: 'C' })).item
  db.prepare('UPDATE items SET rank=? WHERE id=?').run(1, a.id)
  db.prepare('UPDATE items SET rank=? WHERE id=?').run(1 + 1e-7, b.id)
  const moved = rerankItem(db, { userId: dan.id, itemId: c.id, after: a.id, before: b.id })
  const ranks = db.prepare("SELECT id, rank FROM items WHERE user_id=? AND state='open' ORDER BY rank").all(dan.id)
  assert.deepEqual(ranks.map((r) => r.id), [a.id, moved.id, b.id])
  assert.ok(ranks.every((r, i) => i === 0 || ranks[i].rank - ranks[i - 1].rank >= 1))
})

test('renormaliseRanks preserves order and spaces by RANK_GAP', async () => {
  const { db, dan } = await seed()
  const ids = ['x', 'y', 'z'].map((t) => createItem(db, base({ userId: dan.id, title: t })).item.id)
  db.prepare('UPDATE items SET rank=0.5 WHERE id=?').run(ids[2])
  renormaliseRanks(db, dan.id)
  const rows = db.prepare("SELECT id, rank FROM items WHERE user_id=? ORDER BY rank").all(dan.id)
  assert.deepEqual(rows.map((r) => r.id), [ids[2], ids[0], ids[1]])
  assert.deepEqual(rows.map((r) => r.rank), [1024, 2048, 3072])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/items.test.js`
Expected: The first test's `position: 'bottom'` line fails (resolveRank treats any non-`'top'` as bottom — this should pass) — the expected failure is the closed-neighbour assertion or the renormalise ordering. Read the actual failure; if all three pass on the first run, `resolveRank` already meets the contract and you skip Step 3.

- [ ] **Step 3: Adjust `resolveRank` until the tests pass**

Likely fix: in `resolveRank`, when `after`/`before` are both given, do not apply the `excludeId` guard to the SQL `id<>?` lookups (it is only needed for the one-sided neighbour queries), and ensure `renormaliseRanks` runs inside the caller's transaction (it does: `rerankItem` wraps it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/items.test.js`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add src/items.js test/items.test.js
git commit -m "items: rank reorder with midpoint and renormalisation"
```

---

### Task 5: Marker event shape, push classification, snippet

**Files:**
- Modify: `src/push.js` (`classify`, ~line 33), `src/journal.js` (`snippetOf`, ~line 43)
- Create: `src/items-marker.js`
- Test: `test/push.test.js` (append), `test/items.test.js` (append)

**Interfaces:**
- Produces: `itemMarkerPayload({ item, action, by, comment })` in `src/items-marker.js` → the payload object documented in the spec (*Marker event*). `ITEM_EVENT_TYPE = 'item'`.
- Push rule: `classify('item', payload, sender)` → `{ priority: 10, coalesce: false, kind: 'attention' }` when `payload.awaiting === 'user'` and `payload.action ∈ {created, commented, reopened}`; otherwise `null`. (User-sender events already return `null` first.)
- Snippet: `snippetOf('item', p)` → `` `${glyph} #${p.num} ${p.title}` `` with glyph ❓ question, ☐ task, ⚖ decision; ≤ 120 chars.

- [ ] **Step 1: Write the failing tests**

Append to `test/items.test.js`:

```js
import { itemMarkerPayload, ITEM_EVENT_TYPE } from '../src/items-marker.js'
import { snippetOf } from '../src/journal.js'

test('itemMarkerPayload carries the spec fields and trims the comment', async () => {
  const { db, dan } = await seed()
  const q = createItem(db, base({ userId: dan.id, kind: 'question', title: 'Which auth?' })).item
  const r = addComment(db, { userId: dan.id, itemId: q.id, author: 'user', deviceId: 9, body: 'use A',
    attachments: [{ blob_ref: 'b', mime: 'audio/mp4', name: 'v.m4a', size: 1 }] })
  const p = itemMarkerPayload({ item: r.item, action: 'commented', by: 'user', comment: r.comment })
  assert.equal(ITEM_EVENT_TYPE, 'item')
  assert.deepEqual(Object.keys(p).sort(), ['action', 'awaiting', 'by', 'comment', 'item_id', 'kind', 'num', 'resolution', 'title'])
  assert.equal(p.comment.body, 'use A'); assert.equal(p.comment.attachments[0].transcript, null)
  const created = itemMarkerPayload({ item: q, action: 'created', by: 'agent' })
  assert.equal(created.comment, undefined); assert.equal(created.awaiting, 'user')
})

test('snippetOf renders item markers', () => {
  assert.equal(snippetOf('item', { kind: 'question', num: 12, title: 'Which auth library?' }), '❓ #12 Which auth library?')
  assert.equal(snippetOf('item', { kind: 'task', num: 3, title: 'T' }), '☐ #3 T')
  assert.equal(snippetOf('item', { kind: 'decision', num: 4, title: 'D' }), '⚖ #4 D')
})
```

Append to `test/push.test.js` (look at its existing imports first: it constructs `makePushPipeline` with a fake `apnsClient` that records sends; reuse that helper — grep `fakeApns` or the first test's setup and copy its pattern):

```js
test('item markers: agent-created question pushes as attention; user-authored and reorder markers are silent', async (t) => {
  // Use the same fixture setup as the test above this one: a user, a client
  // device with an apns token, a conversation, and a pipeline with a fake
  // APNs client that records `sent` payloads.
  const { db, hub, pipeline, sent, dan, convoId, clientDevice } = await setupPipeline(t)
  const base = { item_id: 'it_x', num: 1, kind: 'question', title: 'Which auth?', by: 'agent', awaiting: 'user', resolution: null }
  pipeline.onAppend(dan.id, { seq: 10, convo_id: convoId, ts: 1, sender: 'agent:dev-2', type: 'item', payload: { ...base, action: 'created' } }, 0)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].payload.aps.alert.body, '❓ #1 Which auth?')
  assert.equal(sent[0].category, 'attention')
  pipeline.onAppend(dan.id, { seq: 11, convo_id: convoId, ts: 2, sender: 'agent:dev-2', type: 'item', payload: { ...base, action: 'closed', awaiting: null, resolution: 'answered' } }, 0)
  pipeline.onAppend(dan.id, { seq: 12, convo_id: convoId, ts: 3, sender: 'agent:dev-2', type: 'item', payload: { ...base, action: 'reordered', awaiting: 'user' } }, 0)
  pipeline.onAppend(dan.id, { seq: 13, convo_id: convoId, ts: 4, sender: 'user:dan', type: 'item', payload: { ...base, action: 'commented', by: 'user', awaiting: 'agent' } }, clientDevice.id)
  assert.equal(sent.length, 1)
  void hub; void db
})
```

If `test/push.test.js` has no reusable `setupPipeline`, write one at the top of the file that mirrors the first existing test's setup exactly (create user, `createClientDevice`, `setApnsRegistration`, `upsertConversation`, `makePushPipeline({ db, hub: makeHub(), apnsClient: fake })`), returning `{ db, hub, pipeline, sent, dan, convoId, clientDevice }`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/items.test.js test/push.test.js`
Expected: FAIL — missing module `items-marker.js`; snippet returns `[item]`; push test sends 0 (classify returns activity/coalesced, so `sent` is 0 or 2, not 1).

- [ ] **Step 3: Implement**

Create `src/items-marker.js`:

```js
// The 'item' marker event: what the conversation log carries about a
// tracker item (spec: Marker event). Written only by src/items-http.js;
// never publishable by an agent. Not a MESSAGE_TYPE (no unread/snippet
// column impact) — push.js and journal.js's snippetOf special-case it.
export const ITEM_EVENT_TYPE = 'item'
export const ITEM_ACTIONS = ['created', 'commented', 'closed', 'reopened', 'reordered']

export function itemMarkerPayload({ item, action, by, comment = null }) {
  const payload = {
    item_id: item.id,
    num: item.num,
    kind: item.kind,
    title: item.title,
    action,
    by,
    awaiting: item.awaiting ?? null,
    resolution: item.resolution ?? null,
  }
  if (comment && (comment.body || (comment.attachments && comment.attachments.length))) {
    payload.comment = {
      id: comment.id,
      body: comment.body,
      attachments: (comment.attachments || []).map((a) => ({
        blob_ref: a.blob_ref, mime: a.mime, name: a.name, size: a.size, transcript: a.transcript ?? null,
      })),
    }
  }
  return payload
}
```

In `src/push.js` `classify`, after the `summary` line add:

```js
  // Tracker markers (spec: task-decision-tracker). Only "the agent needs
  // you" pushes: a new/reopened/commented item left awaiting the user. Agent
  // closes, reorders, and every user-authored marker are journal-sync only
  // (the user:* rule above already covers the latter).
  if (type === 'item') {
    const p = payload && typeof payload === 'object' ? payload : {}
    const needsUser = p.awaiting === 'user' && (p.action === 'created' || p.action === 'commented' || p.action === 'reopened')
    return needsUser ? { priority: 10, coalesce: false, kind: 'attention' } : null
  }
```

In `src/journal.js` `snippetOf`, before the `if (p.snippet)` line add:

```js
  if (type === 'item') {
    const glyph = p.kind === 'question' ? '❓' : p.kind === 'decision' ? '⚖' : '☐'
    return `${glyph} #${Number(p.num) || 0} ${String(p.title || '')}`.slice(0, 120)
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/items.test.js test/push.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/items-marker.js src/push.js src/journal.js test/items.test.js test/push.test.js
git commit -m "items: marker payload, attention push for needs-you markers, snippet"
```

---

### Task 6: Shared `wakeConvoAgent` in `wake.js`

**Files:**
- Modify: `src/wake.js`, `src/ws.js:667-684`
- Test: `test/wake.test.js` (append)

**Interfaces:**
- Produces: `export function wakeIfOffline({ db, hub, waker }, userId, agentDeviceId)` and `export function wakeConvoAgent({ db, hub, waker }, userId, convoId)` — identical semantics to the closures in `ws.js` today (no-op when `waker` is absent/disabled; same-user scoping; agent kind only; skip when a live socket exists).

- [ ] **Step 1: Write the failing test**

Append to `test/wake.test.js` (it already has a fake waker pattern — reuse `makeWaker`'s injectable shape or a `{ enabled: true, wake: (name) => calls.push(name) }` stub):

```js
import { wakeConvoAgent } from '../src/wake.js'
import { makeHub } from '../src/hub.js'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'

test('wakeConvoAgent resolves the managing agent and wakes it only when offline', async () => {
  const db = openDb(':memory:')
  const hub = makeHub()
  const dan = await createUser(db, 'dan', 'pw')
  const agent = createAgent(db, dan.id, 'dev-2')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'T', agentDeviceId: agent.deviceId })
  const calls = []
  const waker = { enabled: true, wake: (name) => calls.push(name) }
  wakeConvoAgent({ db, hub, waker }, dan.id, 'c1')
  assert.deepEqual(calls, ['dev-2'])
  wakeConvoAgent({ db, hub, waker }, dan.id + 1, 'c1') // foreign user: nothing
  wakeConvoAgent({ db, hub, waker: { enabled: false, wake: () => calls.push('x') } }, dan.id, 'c1')
  wakeConvoAgent({ db, hub, waker: null }, dan.id, 'c1')
  assert.deepEqual(calls, ['dev-2'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/wake.test.js`
Expected: FAIL — `wakeConvoAgent` is not exported from `wake.js`.

- [ ] **Step 3: Move the helpers**

Append to `src/wake.js`:

```js
// Shared by ws.js (send / prompt_reply / agent_request / spawn_request) and
// items-http.js (user-authored item markers): traffic for an agent device
// with no live socket asks the infra layer to start its box. Same-user
// scoping mirrors the anti-enumeration stance of every call site.
export function wakeIfOffline({ db, hub, waker }, userId, agentDeviceId) {
  if (!waker || !waker.enabled || !Number.isInteger(agentDeviceId)) return
  const online = hub.connsOf(userId).some((c) => c.deviceId === agentDeviceId && c.ws.readyState === 1)
  if (online) return
  const dev = db.prepare('SELECT name, kind FROM devices WHERE id=? AND user_id=?').get(agentDeviceId, userId)
  if (!dev || dev.kind !== 'agent') return
  waker.wake(dev.name)
}

export function wakeConvoAgent({ db, hub, waker }, userId, convoId) {
  if (!waker || !waker.enabled) return
  const row = db.prepare('SELECT agent_device_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
  if (row && row.agent_device_id != null) wakeIfOffline({ db, hub, waker }, userId, row.agent_device_id)
}
```

In `src/ws.js`, replace the two closure bodies (keep the names so call sites are untouched) with delegations, and add the import:

```js
import { wakeIfOffline as wakeIfOfflineShared, wakeConvoAgent as wakeConvoAgentShared } from './wake.js'
// …inside handleOp, replacing the two const closures:
  const wakeIfOffline = (agentDeviceId) => wakeIfOfflineShared({ db, hub, waker }, conn.userId, agentDeviceId)
  const wakeConvoAgent = (convoId) => wakeConvoAgentShared({ db, hub, waker }, conn.userId, convoId)
```

Keep the explanatory comment above them, shortened to point at `wake.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — including the existing wake-on-message tests in `test/wake.test.js` that exercise `send`/`prompt_reply` through the WS.

- [ ] **Step 5: Commit**

```bash
git add src/wake.js src/ws.js test/wake.test.js
git commit -m "wake: share wakeIfOffline/wakeConvoAgent so HTTP routes can wake a box"
```

---

### Task 7: Routes — list, get, create, patch (with marker, wake, push, sieve)

**Files:**
- Create: `src/items-http.js`
- Modify: `src/http.js` (import; one dispatcher call after `who`; `makeHttpHandler` signature gains `waker`), `src/server.js` (pass `waker: resolvedWaker`)
- Test: `test/items-http.test.js` (new)

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces: `export async function handleItemsRoute({ db, hub, pushPipeline, waker }, req, res, url, who)` → `true` when the request was answered, `false` when the path is not an items route. Internal `emitMarker(ctx, { who, item, action, comment })` appends the `item` event to `item.origin_convo_id` with `sender` = `user:<username>` for clients / `agent:<device name>` for agents, broadcasts via `appendAndBroadcast`, calls `pushPipeline.onAppend(userId, frame, who.deviceId)`, and for client-authored `created|commented|closed|reopened` calls `wakeConvoAgent`.
- Response shapes: `GET /items` → `{ items, next_cursor }`; `GET /items/:id` → `{ item, comments }`; `POST /items` → `{ item }` (201, or 200 when idempotent-duplicate); `PATCH /items/:id` → `{ item }`.

- [ ] **Step 1: Write the failing tests**

```js
// test/items-http.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { pinDevicePrivate } from '../src/db.js'

// Fleet: dan (client 'mac' + agent dev-2 managing c1), pat (own agent, own convo).
async function fleet(t, serverOpts = {}) {
  const calls = []
  const waker = { enabled: true, wake: (name) => calls.push(name) }
  const s = await startTestServer({ waker, ...serverOpts })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  const patAgent = createAgent(s.db, pat.id, 'pat-box')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'c2', ownerUserId: dan.id, title: 'C2', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'p1', ownerUserId: pat.id, title: 'P1', agentDeviceId: patAgent.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  return { s, dan, pat, agent, patAgent, client: login.json.token, clientDeviceId: login.json.device_id, wakeCalls: calls }
}

const mkItem = (s, token, body) => s.http('/items', { method: 'POST', token, body: { kind: 'question', title: 'Which auth?', convo_id: 'c1', ...body } })

test('POST /items: agent creates a question in its convo; marker fans out to the client; 400s on junk', async (t) => {
  const { s, agent, client } = await fleet(t)
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await mkItem(s, agent.token, { body: 'A or B?', labels: ['auth'] })
  assert.equal(r.status, 201)
  assert.equal(r.json.item.num, 1); assert.equal(r.json.item.awaiting, 'user'); assert.equal(r.json.item.created_by, 'agent')
  assert.equal(r.json.item.origin_convo_id, 'c1')
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item')
  assert.equal(marker.convo_id, 'c1'); assert.equal(marker.sender, 'agent:dev-2')
  assert.equal(marker.payload.action, 'created'); assert.equal(marker.payload.num, 1); assert.equal(marker.payload.by, 'agent')
  ws.close()
  assert.equal((await mkItem(s, agent.token, { kind: 'nope' })).status, 400)
  assert.equal((await mkItem(s, agent.token, { title: '' })).status, 400)
  assert.equal((await mkItem(s, agent.token, { convo_id: 'p1' })).status, 404) // not ours
  assert.equal((await mkItem(s, agent.token, { after: 'it_nope' })).status, 400)
  assert.equal((await s.http('/items', { method: 'POST', token: agent.token, body: [] })).status, 400)
})

test('POST /items: client creates a task, agent gets woken, marker sender is user:dan', async (t) => {
  const { s, client, agent, wakeCalls } = await fleet(t)
  const aws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await aws.waitFor((f) => f.op === 'hello_ok')
  aws.close()
  await new Promise((r) => setTimeout(r, 50)) // let the socket drop so the box counts as offline
  const r = await mkItem(s, client, { kind: 'task', title: 'Do X' })
  assert.equal(r.status, 201); assert.equal(r.json.item.created_by, 'user'); assert.equal(r.json.item.awaiting, 'agent')
  assert.deepEqual(wakeCalls, ['dev-2'])
  const ev = s.db.prepare("SELECT sender, payload FROM events WHERE type='item' ORDER BY seq DESC LIMIT 1").get()
  assert.equal(ev.sender, 'user:dan')
  assert.equal(JSON.parse(ev.payload).by, 'user')
})

test('POST /items on_behalf_of: agent files a user-created task; clients may not send the field', async (t) => {
  const { s, agent, client, wakeCalls } = await fleet(t)
  const r = await mkItem(s, agent.token, { kind: 'task', title: 'From queue', on_behalf_of: 'user' })
  assert.equal(r.status, 201); assert.equal(r.json.item.created_by, 'user')
  const ev = s.db.prepare("SELECT sender, payload FROM events WHERE type='item' ORDER BY seq DESC LIMIT 1").get()
  assert.equal(ev.sender, 'agent:dev-2'); assert.equal(JSON.parse(ev.payload).by, 'user')
  assert.equal(wakeCalls.length, 0)
  assert.equal((await mkItem(s, client, { on_behalf_of: 'user' })).status, 400)
  assert.equal((await mkItem(s, agent.token, { on_behalf_of: 'agent' })).status, 400)
})

test('POST /items idempotency header', async (t) => {
  const { s, agent } = await fleet(t)
  const a = await s.http('/items', { method: 'POST', token: agent.token, headers: { 'idempotency-key': 'k1' }, body: { kind: 'task', title: 'T', convo_id: 'c1' } })
  const b = await s.http('/items', { method: 'POST', token: agent.token, headers: { 'idempotency-key': 'k1' }, body: { kind: 'task', title: 'T2', convo_id: 'c1' } })
  assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(b.json.item.id, a.json.item.id)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='item'").get().n, 1)
})

test('GET /items and GET /items/:id: filters, #num, other user 404, comments included', async (t) => {
  const { s, agent, client, pat, patAgent } = await fleet(t)
  await mkItem(s, agent.token, {})
  await mkItem(s, agent.token, { kind: 'task', title: 'T', convo_id: 'c2' })
  await s.http('/items', { method: 'POST', token: patAgent.token, body: { kind: 'task', title: 'P', convo_id: 'p1' } })
  const all = await s.http('/items', { token: client })
  assert.equal(all.status, 200); assert.equal(all.json.items.length, 2)
  assert.equal((await s.http('/items?convo=c2', { token: client })).json.items.length, 1)
  assert.equal((await s.http('/items?awaiting=user', { token: client })).json.items.length, 1)
  assert.equal((await s.http('/items?kind=bogus', { token: client })).status, 400)
  assert.equal((await s.http('/items?limit=0', { token: client })).status, 400)
  assert.equal((await s.http('/items?cursor=!!', { token: client })).status, 400)
  const one = await s.http('/items/%231', { token: client })
  assert.equal(one.status, 200); assert.equal(one.json.item.num, 1); assert.deepEqual(one.json.comments, [])
  assert.equal((await s.http(`/items/${all.json.items[0].id}`, { token: patAgent.token })).status, 404)
  assert.equal((await s.http('/items/it_nope', { token: client })).status, 404)
  void pat
})

test('privacy sieve: an ordinary agent cannot see items born in a private device\'s convo; clients and private agents can', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret', ownerUserId: dan.id, title: 'S', agentDeviceId: priv.deviceId })
  const made = await s.http('/items', { method: 'POST', token: priv.token, body: { kind: 'decision', title: 'Hidden', convo_id: 'secret' } })
  assert.equal(made.status, 201)
  assert.equal((await s.http('/items', { token: agent.token })).json.items.length, 0)
  assert.equal((await s.http(`/items/${made.json.item.id}`, { token: agent.token })).status, 404)
  assert.equal((await s.http('/items', { token: client })).json.items.length, 1)
  assert.equal((await s.http('/items', { token: priv.token })).json.items.length, 1)
})

test('PATCH /items/:id updates fields; marker not emitted for pure edits; awaiting validated', async (t) => {
  const { s, agent, client } = await fleet(t)
  const made = await mkItem(s, agent.token, {})
  const id = made.json.item.id
  const before = s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='item'").get().n
  const r = await s.http(`/items/${id}`, { method: 'PATCH', token: client, body: { title: 'Renamed', awaiting: null } })
  assert.equal(r.status, 200); assert.equal(r.json.item.title, 'Renamed'); assert.equal(r.json.item.awaiting, null)
  assert.equal((await s.http(`/items/${id}`, { method: 'PATCH', token: client, body: { awaiting: 'nobody' } })).status, 400)
  assert.equal((await s.http(`/items/${id}`, { method: 'PATCH', token: client, body: { title: '' } })).status, 400)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='item'").get().n, before)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/items-http.test.js`
Expected: FAIL — every route 404s (unknown path) or the import of `pinDevicePrivate` fails (if so, use the exact export name from `src/db.js:471`).

Also check `startTestServer` forwards `waker` into `startServer` (it spreads `opts`, and `server.js` has `waker || makeWaker()` — confirmed).

- [ ] **Step 3: Create `src/items-http.js`**

```js
// HTTP surface of the task & decision tracker (spec: HTTP API). Validation,
// auth, and the three side effects the pure module must not know about:
// the 'item' marker event on the origin conversation, wake-on-message for
// user-authored writes, and the push pipeline.
import { appendAndBroadcast, toEventShape } from './journal.js'
import { isPrivateDevice } from './db.js'
import { wakeConvoAgent } from './wake.js'
import {
  ITEM_KINDS, RESOLUTIONS, AWAITING, validateItemFields, createItem, getItem, listItems, listComments,
  updateItem, addComment, setAttachmentTranscript, closeItem, reopenItem, rerankItem,
} from './items.js'
import { itemMarkerPayload, ITEM_EVENT_TYPE } from './items-marker.js'

const json = (res, status, obj) => {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

// Duplicated from http.js on purpose (that one is module-private); same
// 1 MB cap, same JSON-object guard.
const readBody = (req) => new Promise((resolve, reject) => {
  let data = ''
  let settled = false
  const fail = (err) => { if (!settled) { settled = true; reject(err) } }
  req.setEncoding('utf8')
  req.on('data', (c) => {
    data += c
    if (data.length > 1e6) { req.removeAllListeners('data'); req.pause(); fail(Object.assign(new Error('body too large'), { statusCode: 413 })) }
  })
  req.on('end', () => {
    if (settled) return
    settled = true
    if (!data) { resolve({}); return }
    let parsed
    try { parsed = JSON.parse(data) } catch { reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 })); return }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { reject(Object.assign(new Error('request body must be a JSON object'), { statusCode: 400 })); return }
    resolve(parsed)
  })
  req.on('close', () => fail(new Error('connection closed')))
  req.on('error', fail)
})

const idemKeyOf = (req, who) => {
  const k = req.headers['idempotency-key']
  if (typeof k !== 'string' || !k || k.length > 128) return null
  return `${who.deviceId}:${k}`
}

const senderOf = (db, who) => who.kind === 'agent'
  ? `agent:${who.name}`
  : `user:${db.prepare('SELECT name FROM users WHERE id=?').get(who.userId).name}`

// Ordinary-agent predicate shared with /roster, /search, /snapshot.
const filteredAgent = (db, who) => who.kind === 'agent' && !isPrivateDevice(db, who.deviceId)

// Visible = owned by the caller's user and, for an ordinary agent, not born
// in a private device's conversation. Same 404 for every failure.
function visibleItem(db, who, idOrNum) {
  const item = getItem(db, who.userId, idOrNum)
  if (!item) return null
  if (filteredAgent(db, who)) {
    const owner = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(item.origin_convo_id)?.agent_device_id
    if (owner != null && isPrivateDevice(db, owner)) return null
  }
  return item
}

function emitMarker({ db, hub, pushPipeline, waker }, who, { item, action, comment = null, by = null }) {
  if (by == null) by = who.kind === 'agent' ? 'agent' : 'user'
  const payload = itemMarkerPayload({ item, action, by, comment })
  const sender = senderOf(db, who)
  let r
  try {
    r = appendAndBroadcast(db, hub, { userId: who.userId, convoId: item.origin_convo_id, sender, type: ITEM_EVENT_TYPE, payload })
  } catch (err) {
    // The table write already committed; a marker on a since-deleted
    // conversation must not fail the request (same stance as spawns.js).
    console.error('items: marker append failed (item write already committed)', err)
    return
  }
  try {
    pushPipeline.onAppend(who.userId, toEventShape({ seq: r.seq, convo_id: item.origin_convo_id, ts: r.ts, sender, type: ITEM_EVENT_TYPE, payload }), who.deviceId)
  } catch (err) {
    console.error('items: push onAppend failed', err)
  }
  // Wake keys off the WRITER's device kind, not `by`: an agent filing on
  // behalf of the user is already awake.
  if (who.kind !== 'agent' && action !== 'reordered') wakeConvoAgent({ db, hub, waker }, who.userId, item.origin_convo_id)
}

const oneOf = (v, list) => v == null ? null : (list.includes(v) ? v : undefined)

export async function handleItemsRoute(ctx, req, res, url, who) {
  const { db } = ctx
  const path = url.pathname
  if (path !== '/items' && !path.startsWith('/items/')) return false

  if (req.method === 'GET' && path === '/items') {
    const q = url.searchParams
    const kind = oneOf(q.get('kind'), ITEM_KINDS)
    const state = oneOf(q.get('state'), ['open', 'closed'])
    const awaiting = oneOf(q.get('awaiting'), AWAITING)
    const sort = q.has('sort') ? oneOf(q.get('sort'), ['rank', 'updated']) : 'rank'
    if (kind === undefined || state === undefined || awaiting === undefined || sort === undefined) { json(res, 400, { error: 'bad_request' }); return true }
    let since = null
    if (q.has('since')) { since = Number(q.get('since')); if (!Number.isInteger(since) || since < 0) { json(res, 400, { error: 'bad_request' }); return true } }
    const rawLimit = q.has('limit') ? Number(q.get('limit')) : 100
    if (!Number.isInteger(rawLimit) || rawLimit < 1) { json(res, 400, { error: 'bad_request' }); return true }
    const label = q.get('label')
    if (label != null && (!label || label.length > 40)) { json(res, 400, { error: 'bad_request' }); return true }
    const r = listItems(db, who.userId, {
      convoId: q.get('convo'), kind, state, awaiting, label, sort, since,
      limit: Math.min(rawLimit, 500), cursor: q.get('cursor'), excludePrivateOwned: filteredAgent(db, who),
    })
    if (r.badCursor) { json(res, 400, { error: 'bad_request' }); return true }
    json(res, 200, { items: r.items, next_cursor: r.next_cursor })
    return true
  }

  if (req.method === 'POST' && path === '/items') {
    const body = await readBody(req)
    if (!ITEM_KINDS.includes(body.kind)) { json(res, 400, { error: 'bad_request' }); return true }
    const v = validateItemFields(body)
    if (!v.ok) { json(res, 400, { error: 'bad_request' }); return true }
    const awaiting = body.awaiting === undefined ? undefined : oneOf(body.awaiting, AWAITING)
    if (awaiting === undefined && body.awaiting !== undefined && body.awaiting !== null) { json(res, 400, { error: 'bad_request' }); return true }
    if (body.position !== undefined && body.position !== 'top' && body.position !== 'bottom') { json(res, 400, { error: 'bad_request' }); return true }
    for (const k of ['after', 'before', 'supersedes', 'convo_id']) {
      if (body[k] !== undefined && (typeof body[k] !== 'string' || !body[k] || body[k].length > 128)) { json(res, 400, { error: 'bad_request' }); return true }
    }
    if (typeof body.convo_id !== 'string') { json(res, 400, { error: 'bad_request' }); return true }
    // The origin conversation must be the caller's user's. Agents additionally
    // hit the sieve: an ordinary agent cannot file into a private convo.
    const convo = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(body.convo_id)
    if (!convo || convo.owner_user_id !== who.userId) { json(res, 404, { error: 'not_found' }); return true }
    if (filteredAgent(db, who) && convo.agent_device_id != null && isPrivateDevice(db, convo.agent_device_id)) { json(res, 404, { error: 'not_found' }); return true }
    // on_behalf_of:'user' lets the bridge file a task the USER asked for (the
    // queued-card "Make task" tap) as user-created: created_by and the
    // marker's `by` read 'user', so the apps show who really filed it. The
    // marker's sender stays the agent device (no wake, no self-prompt).
    if (body.on_behalf_of !== undefined && (body.on_behalf_of !== 'user' || who.kind !== 'agent')) { json(res, 400, { error: 'bad_request' }); return true }
    const createdBy = body.on_behalf_of === 'user' || who.kind !== 'agent' ? 'user' : 'agent'
    let out
    try {
      out = createItem(db, {
        userId: who.userId, kind: body.kind, ...v.value,
        awaiting: body.awaiting === null ? null : awaiting,
        position: body.position, after: body.after, before: body.before,
        originConvoId: body.convo_id, originDeviceId: who.deviceId,
        createdBy,
        supersedes: body.supersedes ?? null, idemKey: idemKeyOf(req, who),
      })
    } catch (err) {
      if (err.message === 'bad_after_before' || err.message === 'bad_supersedes') { json(res, 400, { error: 'bad_request' }); return true }
      throw err
    }
    if (!out.duplicate) emitMarker(ctx, who, { item: out.item, action: 'created', by: createdBy })
    json(res, out.duplicate ? 200 : 201, { item: out.item })
    return true
  }

  const m = path.match(/^\/items\/([^/]+)(?:\/(comments|close|reopen|rank))?(?:\/([^/]+))?$/)
  if (!m) return false
  let idOrNum
  try { idOrNum = decodeURIComponent(m[1]) } catch { json(res, 400, { error: 'bad_request' }); return true }
  const sub = m[2] || null
  const subId = m[3] || null

  const item = visibleItem(db, who, idOrNum)
  if (!item) { json(res, 404, { error: 'not_found' }); return true }

  if (req.method === 'GET' && !sub) {
    json(res, 200, { item, comments: listComments(db, item.id) })
    return true
  }

  if (req.method === 'PATCH' && !sub) {
    const body = await readBody(req)
    const v = validateItemFields(body, { partial: true })
    if (!v.ok) { json(res, 400, { error: 'bad_request' }); return true }
    const fields = { ...v.value }
    delete fields.attachments // body attachments are set at create only (v1)
    if (body.awaiting !== undefined) {
      if (body.awaiting !== null && !AWAITING.includes(body.awaiting)) { json(res, 400, { error: 'bad_request' }); return true }
      fields.awaiting = body.awaiting
    }
    if (Object.keys(fields).length === 0) { json(res, 400, { error: 'bad_request' }); return true }
    json(res, 200, { item: updateItem(db, { userId: who.userId, itemId: item.id, fields }) })
    return true
  }

  // Sub-routes land in Task 8.
  return handleItemSubRoute(ctx, req, res, who, item, sub, subId)
}

async function handleItemSubRoute() { return false }
```

(Keep the `handleItemSubRoute` stub; Task 8 replaces it.)

In `src/http.js`:

```js
import { handleItemsRoute } from './items-http.js'
// signature:
export function makeHttpHandler({ db, rateLimiter, loginGuard, mediaDir, mediaMaxBytes, mediaUserQuotaBytes = Infinity, hub, pushPipeline, dbPath, pairs, links, preapproveKey, broker, spawnStartTimeoutMs = 30000, waker = null }) {
// right after: if (!who) return rejectEarly(req, res, 401, { error: 'unauthenticated' })
      if (await handleItemsRoute({ db, hub, pushPipeline, waker }, req, res, url, who)) return
```

In `src/server.js`, add `waker: resolvedWaker,` to the `makeHttpHandler({...})` call. The outer `catch` in `makeHttpHandler` (`src/http.js:789-798`) already maps `err.statusCode` 413 and 400 to the matching JSON error, so `readBody`'s throws inside `handleItemsRoute` need no extra handling.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/items-http.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/items-http.js src/http.js src/server.js test/items-http.test.js
git commit -m "items: HTTP list/get/create/patch with marker events, wake, push, privacy sieve"
```

---

### Task 8: Routes — comments, transcript, close, reopen, rank

**Files:**
- Modify: `src/items-http.js` (replace the `handleItemSubRoute` stub)
- Test: `test/items-http.test.js` (append)

**Interfaces:**
- `POST /items/:id/comments` `{body?, attachments?}` → 201 `{ item, comment }` (200 on idempotent duplicate); at least one of body/attachments required; marker `commented` with the comment; client-authored → wake.
- `PATCH /items/:id/comments/:cid` `{ blob_ref, transcript }` → agent-only (403 for clients) → 200 `{ comment }`; no marker.
- `POST /items/:id/close` `{ resolution, comment? }` → 200 `{ item, comment }`; 409 when already closed; marker `closed`.
- `POST /items/:id/reopen` `{ comment? }` → 200; 409 when already open; marker `reopened`.
- `POST /items/:id/rank` `{ position? | after? | before? }` → 200 `{ item }`; marker `reordered` (no wake, no push).

- [ ] **Step 1: Write the failing tests**

```js
test('comments: user comment flips awaiting, emits a commented marker with the body, wakes the box', async (t) => {
  const { s, agent, client, wakeCalls } = await fleet(t)
  const made = await mkItem(s, agent.token, {})
  const id = made.json.item.id
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: { body: 'use A', attachments: [{ blob_ref: 'b1', mime: 'audio/mp4', name: 'v.m4a', size: 3 }] } })
  assert.equal(r.status, 201); assert.equal(r.json.item.awaiting, 'agent'); assert.equal(r.json.comment.attachments[0].blob_ref, 'b1')
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === 'commented')
  assert.equal(marker.sender, 'user:dan'); assert.equal(marker.payload.comment.body, 'use A'); assert.equal(marker.payload.awaiting, 'agent')
  assert.equal(marker.payload.comment.attachments[0].transcript, null)
  ws.close()
  assert.deepEqual(wakeCalls, ['dev-2'])
  assert.equal((await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: {} })).status, 400)
  assert.equal((await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: { body: 'x'.repeat(32769) } })).status, 400)
  // agent comment: no wake, awaiting unchanged
  const a = await s.http(`/items/${id}/comments`, { method: 'POST', token: agent.token, body: { body: 'noted' } })
  assert.equal(a.status, 201); assert.equal(a.json.item.awaiting, 'agent'); assert.equal(wakeCalls.length, 1)
})

test('comments idempotency and transcript patch (agent-only)', async (t) => {
  const { s, agent, client } = await fleet(t)
  const id = (await mkItem(s, agent.token, {})).json.item.id
  const h = { 'idempotency-key': 'c-1' }
  const a = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, headers: h, body: { body: 'x', attachments: [{ blob_ref: 'b1', mime: 'audio/mp4', name: 'v', size: 1 }] } })
  const b = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, headers: h, body: { body: 'y' } })
  assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(b.json.comment.id, a.json.comment.id)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='item' AND payload LIKE '%commented%'").get().n, 1)
  const cid = a.json.comment.id
  assert.equal((await s.http(`/items/${id}/comments/${cid}`, { method: 'PATCH', token: client, body: { blob_ref: 'b1', transcript: 'hi' } })).status, 403)
  const p = await s.http(`/items/${id}/comments/${cid}`, { method: 'PATCH', token: agent.token, body: { blob_ref: 'b1', transcript: 'hi' } })
  assert.equal(p.status, 200); assert.equal(p.json.comment.attachments[0].transcript, 'hi')
  assert.equal((await s.http(`/items/${id}/comments/${cid}`, { method: 'PATCH', token: agent.token, body: { blob_ref: 'zz', transcript: 'hi' } })).status, 404)
  assert.equal((await s.http(`/items/${id}/comments/${cid}`, { method: 'PATCH', token: agent.token, body: { blob_ref: 'b1' } })).status, 400)
})

test('close / reopen: state machine, 409s, markers, agent close does not wake', async (t) => {
  const { s, agent, client, wakeCalls } = await fleet(t)
  const id = (await mkItem(s, agent.token, {})).json.item.id
  const c = await s.http(`/items/${id}/close`, { method: 'POST', token: agent.token, body: { resolution: 'answered', comment: 'done' } })
  assert.equal(c.status, 200); assert.equal(c.json.item.state, 'closed'); assert.equal(c.json.comment.kind, 'status')
  assert.equal((await s.http(`/items/${id}/close`, { method: 'POST', token: agent.token, body: { resolution: 'answered' } })).status, 409)
  assert.equal((await s.http(`/items/${id}/close`, { method: 'POST', token: agent.token, body: { resolution: 'meh' } })).status, 400)
  assert.equal(wakeCalls.length, 0)
  const r = await s.http(`/items/${id}/reopen`, { method: 'POST', token: client, body: { comment: 'not yet' } })
  assert.equal(r.status, 200); assert.equal(r.json.item.state, 'open'); assert.equal(r.json.item.awaiting, 'user')
  assert.equal(wakeCalls.length, 1)
  assert.equal((await s.http(`/items/${id}/reopen`, { method: 'POST', token: client, body: {} })).status, 409)
  const actions = s.db.prepare("SELECT payload FROM events WHERE type='item' ORDER BY seq").all().map((e) => JSON.parse(e.payload).action)
  assert.deepEqual(actions, ['created', 'closed', 'reopened'])
})

test('rank: reorder emits a silent reordered marker and never wakes', async (t) => {
  const { s, agent, client, wakeCalls } = await fleet(t)
  const a = (await mkItem(s, agent.token, { kind: 'task', title: 'A' })).json.item
  const b = (await mkItem(s, agent.token, { kind: 'task', title: 'B' })).json.item
  const r = await s.http(`/items/${b.id}/rank`, { method: 'POST', token: client, body: { position: 'top' } })
  assert.equal(r.status, 200); assert.ok(r.json.item.rank < a.rank)
  assert.equal(wakeCalls.length, 0)
  assert.equal((await s.http(`/items/${b.id}/rank`, { method: 'POST', token: client, body: { after: b.id } })).status, 400)
  assert.equal((await s.http(`/items/${b.id}/rank`, { method: 'POST', token: client, body: {} })).status, 400)
  const last = JSON.parse(s.db.prepare("SELECT payload FROM events WHERE type='item' ORDER BY seq DESC LIMIT 1").get().payload)
  assert.equal(last.action, 'reordered')
})

test('sub-routes on a foreign or hidden item are 404, never 403', async (t) => {
  const { s, agent, patAgent } = await fleet(t)
  const id = (await mkItem(s, agent.token, {})).json.item.id
  for (const sub of ['comments', 'close', 'reopen', 'rank']) {
    assert.equal((await s.http(`/items/${id}/${sub}`, { method: 'POST', token: patAgent.token, body: { resolution: 'done', body: 'x', position: 'top' } })).status, 404)
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/items-http.test.js`
Expected: FAIL — sub-routes return `false` → 404 from the dispatcher, so the 201/200 assertions fail.

- [ ] **Step 3: Replace the stub**

```js
async function handleItemSubRoute(ctx, req, res, who, item, sub, subId) {
  const { db } = ctx
  const author = who.kind === 'agent' ? 'agent' : 'user'

  if (sub === 'comments' && subId == null && req.method === 'POST') {
    const body = await readBody(req)
    const v = validateItemFields({ body: body.body ?? '', attachments: body.attachments }, { partial: true })
    if (!v.ok) { json(res, 400, { error: 'bad_request' }); return true }
    const text = v.value.body ?? ''
    const attachments = v.value.attachments ?? []
    if (!text.trim() && attachments.length === 0) { json(res, 400, { error: 'bad_request' }); return true }
    const out = addComment(db, { userId: who.userId, itemId: item.id, author, deviceId: who.deviceId, body: text, attachments, idemKey: idemKeyOf(req, who) })
    if (!out) { json(res, 404, { error: 'not_found' }); return true }
    if (!out.duplicate) emitMarker(ctx, who, { item: out.item, action: 'commented', comment: out.comment })
    json(res, out.duplicate ? 200 : 201, { item: out.item, comment: out.comment })
    return true
  }

  if (sub === 'comments' && subId != null && req.method === 'PATCH') {
    // Transcript write-back is the bridge's job after it transcribes a
    // voice-note attachment; a client never patches a comment.
    if (who.kind !== 'agent') { json(res, 403, { error: 'forbidden' }); return true }
    const body = await readBody(req)
    if (typeof body.blob_ref !== 'string' || !body.blob_ref || typeof body.transcript !== 'string' || body.transcript.length > 32768) { json(res, 400, { error: 'bad_request' }); return true }
    const c = setAttachmentTranscript(db, { userId: who.userId, itemId: item.id, commentId: subId, blobRef: body.blob_ref, transcript: body.transcript })
    if (!c) { json(res, 404, { error: 'not_found' }); return true }
    json(res, 200, { comment: c })
    return true
  }

  if (sub === 'close' && req.method === 'POST') {
    const body = await readBody(req)
    if (!RESOLUTIONS.includes(body.resolution)) { json(res, 400, { error: 'bad_request' }); return true }
    if (body.comment !== undefined && (typeof body.comment !== 'string' || body.comment.length > 32768)) { json(res, 400, { error: 'bad_request' }); return true }
    const out = closeItem(db, { userId: who.userId, itemId: item.id, resolution: body.resolution, author, deviceId: who.deviceId, comment: body.comment ?? '' })
    if (!out) { json(res, 409, { error: 'conflict' }); return true }
    emitMarker(ctx, who, { item: out.item, action: 'closed', comment: out.comment })
    json(res, 200, { item: out.item, comment: out.comment })
    return true
  }

  if (sub === 'reopen' && req.method === 'POST') {
    const body = await readBody(req)
    if (body.comment !== undefined && (typeof body.comment !== 'string' || body.comment.length > 32768)) { json(res, 400, { error: 'bad_request' }); return true }
    const out = reopenItem(db, { userId: who.userId, itemId: item.id, author, deviceId: who.deviceId, comment: body.comment ?? '' })
    if (!out) { json(res, 409, { error: 'conflict' }); return true }
    emitMarker(ctx, who, { item: out.item, action: 'reopened', comment: out.comment })
    json(res, 200, { item: out.item, comment: out.comment })
    return true
  }

  if (sub === 'rank' && req.method === 'POST') {
    const body = await readBody(req)
    const hasPos = body.position !== undefined
    if (hasPos && body.position !== 'top' && body.position !== 'bottom') { json(res, 400, { error: 'bad_request' }); return true }
    for (const k of ['after', 'before']) {
      if (body[k] !== undefined && (typeof body[k] !== 'string' || !body[k])) { json(res, 400, { error: 'bad_request' }); return true }
    }
    if (!hasPos && body.after === undefined && body.before === undefined) { json(res, 400, { error: 'bad_request' }); return true }
    let out
    try {
      out = rerankItem(db, { userId: who.userId, itemId: item.id, position: body.position, after: body.after, before: body.before })
    } catch (err) {
      if (err.message === 'bad_after_before') { json(res, 400, { error: 'bad_request' }); return true }
      throw err
    }
    if (!out) { json(res, 404, { error: 'not_found' }); return true }
    emitMarker(ctx, who, { item: out, action: 'reordered' })
    json(res, 200, { item: out })
    return true
  }

  return false
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/items-http.test.js`
Expected: PASS (12 tests).

- [ ] **Step 5: Full suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/items-http.js test/items-http.test.js
git commit -m "items: comment, transcript, close, reopen, rank routes"
```

---

### Task 9: Reaper guard test, protocol doc, conformance fixture

**Files:**
- Test: `test/retention.test.js` (append)
- Modify: `docs/protocol.md` (new section before `## Device privacy`)
- Create: `test/fixtures/conformance/14_items_roundtrip.json`

- [ ] **Step 1: Write the reaper test**

Append to `test/retention.test.js` (mirror the existing `runReapMedia` test's setup: it creates a user, writes blob files into a temp `mediaDir`, inserts `blobs` rows, and appends `image` events referencing them; copy that helper and add one blob referenced only from an item comment):

```js
import { createItem, addComment } from '../src/items.js'

test('media reap never touches a blob referenced only by an item comment', async () => {
  // Same setup as the reap test above: two blobs of equal size for one user,
  // quota chosen so exactly one must go. Blob A is attached to an image
  // event; blob B only to an item comment.
  const { db, dan, blobA, blobB, mediaDir, quota } = await reapFixture()
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'T' })
  const it = createItem(db, { userId: dan.id, kind: 'task', title: 'T', originConvoId: 'c1', originDeviceId: 1, createdBy: 'agent' }).item
  addComment(db, { userId: dan.id, itemId: it.id, author: 'user', deviceId: 1, body: '', attachments: [{ blob_ref: blobB, mime: 'image/png', name: 'p', size: 10 }] })
  runReapMedia(db, { quotaBytes: quota, highPct: 50, lowPct: 10 })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blobs WHERE id=?').get(blobB).n, 1)
  void blobA; void mediaDir
})
```

If the existing test file has no reusable fixture builder, extract one (`reapFixture`) from the existing reap test so both share it; do not duplicate the disk setup.

- [ ] **Step 2: Run it**

Run: `node --test test/retention.test.js`
Expected: PASS on the first run — the candidate query joins `events`, so an item-only blob is never a candidate. This test exists to pin that. (If it fails, the reaper has changed; add `AND NOT EXISTS (SELECT 1 FROM item_comments ic WHERE ic.attachments LIKE '%"' || b.id || '"%')` to the candidates query.)

- [ ] **Step 3: Document the protocol**

Insert into `docs/protocol.md` before `## Device privacy`:

````markdown
## Items (task & decision tracker)

Spec: `docs/superpowers/specs/2026-09-08-task-decision-tracker-design.md`.

Items are journal-owned rows (`items`, `item_comments`), scoped to the
user like everything else, with a per-user `#num`. The conversation log
carries only **marker events** of type `item`, written by the journal
itself on every mutating route — agents cannot `publish` one.

### Routes (Bearer, either device kind)

| Route | Body / query | Response |
|---|---|---|
| `GET /items` | `convo, kind, state, awaiting, label, sort=rank\|updated, since, limit≤500, cursor` | `{items:[…], next_cursor}` |
| `GET /items/:id` | `:id` = `it_…` or `#num` (URL-encode `#`) | `{item, comments:[…]}` |
| `POST /items` | `{kind, title, body?, labels?, links?, attachments?, awaiting?, position?, after?, before?, convo_id, supersedes?, on_behalf_of?:'user' (agent callers only)}` + optional `Idempotency-Key` | 201 `{item}` (200 on replay) |
| `PATCH /items/:id` | `{title?, body?, labels?, links?, awaiting?}` | `{item}` |
| `POST /items/:id/comments` | `{body?, attachments?}` (one required) + optional `Idempotency-Key` | 201 `{item, comment}` |
| `PATCH /items/:id/comments/:cid` | `{blob_ref, transcript}` — agent only | `{comment}` |
| `POST /items/:id/close` | `{resolution, comment?}` | `{item, comment}`; 409 if closed |
| `POST /items/:id/reopen` | `{comment?}` | `{item, comment}`; 409 if open |
| `POST /items/:id/rank` | `{position:'top'\|'bottom'} \| {after} \| {before} \| {after, before}` | `{item}` |

Item shape: `{id, user_id, num, kind, state, resolution, awaiting, rank,
title, body, labels[], links[{url,title?}], attachments[], supersedes,
origin_convo_id, origin_device_id, created_by, created_at, updated_at,
closed_at, comment_count, last_comment_at, has_image}`. Comment shape:
`{id, item_id, author, device_id, kind:'comment'|'status', body,
attachments[{blob_ref,mime,name,size,transcript?}], meta, created_at}`.

Rules: a `question` starts `awaiting:'user'`, a `task` `awaiting:'agent'`,
a `decision` `null`. A **user** comment always sets `awaiting:'agent'` and
reopens a closed item. Close clears `awaiting`. Reopen restores the kind
default (decision → `null`). `rank` is one order per user; midpoint
insertion, server-side renormalisation.

Visibility: an ordinary (non-private) agent never sees an item whose origin
conversation is managed by a private device — list omits it, every other
route 404s — same predicate as `/search`. Unknown ids, other users' items,
and sieved items are all 404.

### Marker event

```json
{ "type": "item", "sender": "user:dan" | "agent:dev-2",
  "payload": { "item_id": "it_…", "num": 12, "kind": "question", "title": "…",
    "action": "created|commented|closed|reopened|reordered", "by": "user|agent",
    "awaiting": "user|agent|null", "resolution": "…|null",
    "comment": { "id": "ic_…", "body": "…", "attachments": [ … ] } } }
```

`comment` is present when the action carried text or attachments. The
event's `sender` is the writer's device, so a client-authored marker is a
user event on the origin conversation: the wake-on-message path fires for
`created|commented|closed|reopened`, and bridges treat those as inbound
turns. `reordered` never wakes and never pushes. Push: `attention` when an
agent leaves an item `awaiting:'user'` via `created|commented|reopened`;
everything else is journal-sync only. Not a message type: no unread or
snippet effect.
````

- [ ] **Step 4: Write the conformance fixture**

`test/fixtures/conformance/14_items_roundtrip.json`:

```json
{
  "name": "items: agent files a question; client reads, answers, agent closes; markers land in the origin convo",
  "description": "Exercises POST/GET /items, POST /items/:id/comments, POST /items/:id/close and the 'item' marker events a client sees on the WS. Per-user numbering starts at 1; a user comment flips awaiting to agent; close clears it.",
  "server": { "tmpDb": true },
  "seed": {
    "users": [ { "as": "dan", "name": "dan", "password": "fixture-pw-15" } ],
    "agents": [ { "as": "bridge", "user": "dan", "name": "dev-2" } ],
    "conversations": [ { "id": "c1", "owner": "dan", "title": "Session", "sessionState": "running", "agent": "bridge" } ]
  },
  "steps": [
    { "kind": "http", "method": "POST", "path": "/login",
      "body": { "username": "dan", "password": "fixture-pw-15", "device_name": "mac" },
      "expect": { "status": 200, "body": { "token": { "$bind": "dan_token" }, "device_id": { "$type": "integer" }, "user_id": { "$ref": "dan.user_id" } } } },

    { "kind": "http", "method": "POST", "path": "/items", "token": { "$ref": "bridge.token" },
      "body": { "kind": "question", "title": "Which auth library?", "body": "A or B?", "convo_id": "c1" },
      "expect": { "status": 201, "body": { "item": {
        "id": { "$bind": "item_id" }, "user_id": { "$ref": "dan.user_id" }, "num": 1, "kind": "question",
        "state": "open", "resolution": null, "awaiting": "user", "rank": 1024,
        "title": "Which auth library?", "body": "A or B?", "labels": [], "links": [], "attachments": [], "supersedes": null,
        "origin_convo_id": "c1", "origin_device_id": { "$ref": "bridge.device_id" }, "created_by": "agent",
        "idem_key": null, "created_at": { "$type": "integer" }, "updated_at": { "$type": "integer" }, "closed_at": null,
        "comment_count": 0, "last_comment_at": null, "has_image": false } } } },

    { "kind": "http", "method": "GET", "path": "/items?awaiting=user", "token": { "$ref": "dan_token" },
      "expect": { "status": 200, "body": { "items": [ { "id": { "$ref": "item_id" }, "num": 1, "$ignore_rest": true } ], "next_cursor": null } } },

    { "kind": "http", "method": "POST", "path": "/items/${item_id}/comments", "token": { "$ref": "dan_token" },
      "body": { "body": "Use A" },
      "expect": { "status": 201, "body": { "item": { "id": { "$ref": "item_id" }, "awaiting": "agent", "$ignore_rest": true },
                                            "comment": { "id": { "$bind": "comment_id" }, "author": "user", "kind": "comment", "body": "Use A", "$ignore_rest": true } } } },

    { "kind": "http", "method": "POST", "path": "/items/${item_id}/close", "token": { "$ref": "bridge.token" },
      "body": { "resolution": "answered" },
      "expect": { "status": 200, "body": { "item": { "state": "closed", "resolution": "answered", "awaiting": null, "$ignore_rest": true },
                                            "comment": { "kind": "status", "$ignore_rest": true } } } },

    { "kind": "http", "method": "GET", "path": "/convo/c1/messages?limit=10", "token": { "$ref": "dan_token" },
      "expect": { "status": 200, "body": { "events": [
        { "seq": { "$type": "integer" }, "convo_id": "c1", "ts": { "$type": "integer" }, "sender": "agent:dev-2", "type": "item",
          "payload": { "item_id": { "$ref": "item_id" }, "num": 1, "kind": "question", "title": "Which auth library?", "action": "created", "by": "agent", "awaiting": "user", "resolution": null } },
        { "seq": { "$type": "integer" }, "convo_id": "c1", "ts": { "$type": "integer" }, "sender": "user:dan", "type": "item",
          "payload": { "item_id": { "$ref": "item_id" }, "num": 1, "kind": "question", "title": "Which auth library?", "action": "commented", "by": "user", "awaiting": "agent", "resolution": null,
                       "comment": { "id": { "$ref": "comment_id" }, "body": "Use A", "attachments": [] } } },
        { "seq": { "$type": "integer" }, "convo_id": "c1", "ts": { "$type": "integer" }, "sender": "agent:dev-2", "type": "item",
          "payload": { "item_id": { "$ref": "item_id" }, "num": 1, "kind": "question", "title": "Which auth library?", "action": "closed", "by": "agent", "awaiting": null, "resolution": "answered" } }
      ], "$ignore_rest": true } } }
  ]
}
```

Two runner changes this fixture needs:

(a) The seeder at `test/conformance.test.js:172-176` does not set `agent_device_id`. Extend it so `seed.conversations[].agent` (an `as` name from `seed.agents`) is passed through: `upsertConversation(s.db, { id: c.id, ownerUserId: owner.id, title: c.title, sessionState: c.sessionState, agentDeviceId: c.agent ? bindings[`${c.agent}.device_id`] : undefined })` (use whatever map the seeder already keeps agent bindings in). Document the new field in the README's `seed` block.

(b) The matcher has exactly four rules and no `$ignore_rest`. Do **not** add one: spell out every key in the three expectations above that use it (the item shape is fixed and listed in the `POST /items` expectation; copy it). The fixture is the contract.

Also confirm whether `/convo/:id/messages` returns oldest-first or newest-first (read `messagesBefore` in `src/journal.js:317`) and order the three events accordingly.

- [ ] **Step 5: Run the conformance suite and the whole suite**

Run: `node --test test/conformance.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/retention.test.js docs/protocol.md test/fixtures/conformance/14_items_roundtrip.json test/conformance.test.js
git commit -m "items: reaper guard test, protocol doc, conformance fixture"
```

---

### Task 10: Backlog note, final verification, PR

**Files:**
- Modify: `docs/BACKLOG.md` (one line under the relevant heading: "Items tracker v2: due dates, assignees, GitHub sync — see spec non-goals")

- [ ] **Step 1: Run everything once more from a clean tree**

Run: `git status --porcelain && npm test`
Expected: clean tree, all tests pass. Note the `# tests N # pass N # fail 0` summary line and keep it for the PR description.

- [ ] **Step 2: Smoke the routes by hand against a temp server**

```bash
MATRON_DB=/tmp/items-smoke.db node src/server.js & sleep 1
# mint a user + agent with bin/matron-admin.js (see its --help), then:
curl -s -X POST localhost:8080/items -H "authorization: Bearer $AGENT" -H 'content-type: application/json' \
  -d '{"kind":"question","title":"Smoke?","convo_id":"<convo>"}' | jq .item.num
kill %1
```

Expected: `1`.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin items-tracker
gh pr create --title "Items: task & decision tracker (journal side)" --body "$(cat <<'EOF'
Implements the journal half of docs/superpowers/specs/2026-09-08-task-decision-tracker-design.md:
- items / item_comments / item_counters tables
- GET/POST /items, GET/PATCH /items/:id, comments (+ transcript patch), close, reopen, rank
- 'item' marker events on the origin conversation; wake for user-authored writes; attention push for needs-you markers
- privacy sieve for ordinary agents; idempotency keys; per-user #num; float rank with renormalisation
- protocol.md section + conformance fixture 14

Deploy note: back up the DB first (docs/superpowers technique: journal deploy on dev-2); tables are created idempotently on open.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review against the spec

- **Data model** → Task 1 (tables), Task 2 (numbering, rank, defaults), Task 3 (lifecycle rules, transcript), Task 4 (rank math). Attachments on the item body ride a hidden `status` comment (`meta.role='body'`) rather than a column; the API shape is what the spec promises (`item.attachments`).
- **HTTP API** → Tasks 7–8, every route in the table; `since` watermark, cursor, limits, idempotency, sieve.
- **Marker event** → Task 5 (payload, push, snippet), Task 7 (`emitMarker`, sender = writer's device, not client-only, not publishable).
- **Routing (journal half)** → Task 6 + Task 7 (`wakeConvoAgent` after user-authored writes except `reordered`).
- **Error handling** → 400/404/409 conventions in Tasks 7–8; marker failure logged, never fails the request.
- **Testing** → route, numbering, filters, cursor, since, flips, close/reopen, rank, idempotency, limits, sieve, reaper, markers, push, conformance: all present.
- **Rollout** → Task 10 PR + deploy note.
- Not in this plan by design: bridge tools, synthetic turn, "Make task", apps — separate plans.
