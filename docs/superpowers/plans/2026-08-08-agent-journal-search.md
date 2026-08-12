# Agent Journal Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A prose-only FTS5 index over the journal's `events` table, a `GET /search` endpoint, and an `around_seq` context mode on the existing messages endpoint — so an agent can look up "what happened with X" across the user's whole history.

**Architecture:** One `indexableBody(type, payload)` function feeds both the live append path (inside `append()`'s existing transaction) and a resumable startup backfill. The index is a content-table FTS5 pair (`search_messages` + `search_fts`) with an insert trigger only — `events` is append-only, so no update/delete triggers exist by design. `GET /search` quotes each query term (implicit AND over literals) so human input can never 500. Agents reading context around a hit in a conversation they don't manage see exactly what the index can see (`indexableBody` non-null) — nothing else.

**Tech Stack:** Node ≥20 ESM, better-sqlite3 ^11 (SQLite 3.49.2, FTS5 compiled in — confirmed), `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-07-agent-journal-search-design.md` (phase 1, journal only — the bridge tools are a separate matron-bridge plan; the apps deep-link is phase 3, deferred).

## Global Constraints

- Never `INSERT OR REPLACE` into any search table — `REPLACE` skips delete triggers and is the exact corruption that hit the app-side index (matron-apple #106). Backfill uses `INSERT OR IGNORE`; the live path uses plain `INSERT`.
- No update or delete triggers on `search_messages` — `events` is append-only (plain `INSERT` at src/journal.js:118-120, no `DELETE FROM events` anywhere; retention only rewrites `tool_output` payloads, which are never indexed). State this invariant in code comments where the schema is declared.
- `tool_output` must never enter the index or an agent's foreign-conversation context window — it is where credentials land. This is the privacy property; it has dedicated tests.
- HTTP error shapes follow the repo convention: `json(res, code, { error })`, unauthorized/missing merged into 404 (never 403 — anti-enumeration), bad input → 400 with `error: 'bad_request'`.
- Tests use `node:test` + `assert/strict`; server tests use `startTestServer()` from `test/helpers.js`; DB-level tests use `openDb(':memory:')`.
- No new npm dependencies.
- Run tests per-file during tasks (`node --test test/search.test.js`), full suite (`npm test`) before each commit's final verification. Assert the run actually executed tests — a destination/glob error can look like a pass.

## Locked decisions (fold into the spec in Task 7)

These resolve the spec's open edges; they are called out in the PR body for Dan:

1. **Agent context access (the spec-conflict fix).** The spec says `around_seq` "reuses the endpoint's existing authorisation unchanged", but the existing route also carries the Phase-2 agent gate (`authorizeAgentWrite`, src/http.js:486) that 404s any conversation an agent doesn't manage or hasn't joined — which would make context reads impossible for exactly the hits `/search` returns. Resolution: in `around_seq` mode, an agent may read a conversation it doesn't manage, but the response is filtered to events where `indexableBody(type, payload)` is non-null (text + diff prose — exactly the indexed set, one shared rule). An agent's `around_seq` on a conversation it DOES manage, and everything a client does, is unchanged. `before_seq` mode keeps the tightened gate exactly as it is.
2. **Diffs stay in the index** (spec open question 1) — "what did we change to fix X" is a real question. Dropping them later is a one-line change to `indexableBody`.
3. **Backfill cursor.** Resumability is `INSERT OR IGNORE` + a one-row `search_backfill_state` table storing the last scanned `events.rowid` — so a restart resumes where it left off and a completed backfill costs one row read per boot, not a full re-scan. Any event appended after the schema exists is indexed by the live path, so the cursor can never miss rows.
4. **`/search` is open to both device kinds** (the spec's scoping is user-only). Clients may use it later; the visibility/privacy plan adds agent-caller filtering on top.
5. **Snippet highlight markers are `**` … `**`** (markdown bold — agents and the apps both render markdown).

## File Structure

- **Create `src/search.js`** — `indexableBody`, `ftsQueryFor`, `searchMessages`, `backfillSearchIndex`. All of search's logic in one focused file; `journal.js` and `http.js` import from it.
- **Modify `src/db.js`** — search tables + insert trigger + backfill-state table appended to `SCHEMA` (all `IF NOT EXISTS`, so fresh and existing DBs converge identically).
- **Modify `src/journal.js`** — `append()` gains the index insert inside its existing transaction; new `messagesAround()` beside `messagesBefore()`.
- **Modify `src/http.js`** — `GET /search` route; `around_seq` mode on `GET /convo/:id/messages`.
- **Modify `src/server.js`** — kick off the backfill after `server.listen`, fire-and-forget with a stop hook for `close()`.
- **Modify `docs/protocol.md`** — document both API surfaces.
- **Create `test/search.test.js`** — everything search-specific; small additions to `test/db.test.js`.

---

### Task 1: `indexableBody` — the single indexability rule

**Files:**
- Create: `src/search.js`
- Test: `test/search.test.js`

**Interfaces:**
- Produces: `indexableBody(type, payload) -> string | null` — the indexable text for an event, or null for everything the index must never contain. Consumed by Task 3 (live append), Task 4 (backfill), and Task 6 (agent context filter).

- [ ] **Step 1: Write the failing tests**

```js
// test/search.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { indexableBody } from '../src/search.js'

test('indexableBody: text events index their body', () => {
  assert.equal(indexableBody('text', { body: 'why did we drop SQLCipher' }), 'why did we drop SQLCipher')
})

test('indexableBody: text with empty/whitespace/missing/non-string body is not indexed', () => {
  assert.equal(indexableBody('text', { body: '' }), null)
  assert.equal(indexableBody('text', { body: '   \n ' }), null)
  assert.equal(indexableBody('text', {}), null)
  assert.equal(indexableBody('text', { body: 42 }), null)
})

test('indexableBody: diff events index payload.diff, falling back to payload.snippet', () => {
  assert.equal(indexableBody('diff', { diff: '-a\n+b' }), '-a\n+b')
  assert.equal(indexableBody('diff', { snippet: 'changed StoragePaths' }), 'changed StoragePaths')
  assert.equal(indexableBody('diff', { diff: 'full', snippet: 'short' }), 'full')
  assert.equal(indexableBody('diff', {}), null)
})

test('indexableBody: tool_output is NEVER indexed — the privacy property', () => {
  assert.equal(indexableBody('tool_output', { command: 'env', body: 'SECRET=hunter2' }), null)
  assert.equal(indexableBody('tool_output', { snippet: 'SECRET=hunter2' }), null)
})

test('indexableBody: every other type returns null', () => {
  for (const type of ['prompt', 'file', 'image', 'permission_request', 'session_status', 'read_marker', 'convo_meta']) {
    assert.equal(indexableBody(type, { body: 'x', question: 'x', description: 'x' }), null, type)
  }
})

test('indexableBody: tolerates malformed payloads', () => {
  assert.equal(indexableBody('text', null), null)
  assert.equal(indexableBody('text', undefined), null)
  assert.equal(indexableBody('text', 'bare string'), null)
  assert.equal(indexableBody('diff', 7), null)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/search.test.js`
Expected: FAIL — `Cannot find module '../src/search.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/search.js
// Single source of truth for what the search index can see (spec: prose
// only — docs/superpowers/specs/2026-08-07-agent-journal-search-design.md).
// Called by BOTH the live append path (journal.js, inside the append
// transaction) and the startup backfill, and by the agent context filter in
// http.js — one function, three consumers, zero drift. This copies the app
// side's searchableBody discipline for the same reason the apps needed it.
//
// tool_output is deliberately null: command output is retrieval noise for
// "why did we do this" questions, and it is where credentials land. If a
// new prose-bearing event type is ever added, extend HERE and nowhere else.
export function indexableBody(type, payload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  if (type === 'text') {
    const body = typeof p.body === 'string' ? p.body : ''
    return body.trim() ? body : null
  }
  if (type === 'diff') {
    const text = typeof p.diff === 'string' && p.diff
      ? p.diff
      : (typeof p.snippet === 'string' ? p.snippet : '')
    return text.trim() ? text : null
  }
  return null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/search.test.js`
Expected: PASS, all tests above.

- [ ] **Step 5: Commit**

```bash
git add src/search.js test/search.test.js
git commit -m "search: indexableBody — the single prose-only indexability rule"
```

---

### Task 2: Search schema — content-table FTS5 pair, insert trigger only

**Files:**
- Modify: `src/db.js` (append to the `SCHEMA` template string, after the `agent_chat_allowances` table)
- Test: `test/db.test.js`

**Interfaces:**
- Produces: tables `search_messages(rowid, user_id, convo_id, seq, ts, sender, body, UNIQUE(user_id, seq))`, `search_fts` (FTS5, `content='search_messages'`), trigger `search_messages_ai`, table `search_backfill_state(id=1, last_events_rowid)`. Consumed by Tasks 3–6.

- [ ] **Step 1: Write the failing tests**

Add to `test/db.test.js` (it already imports `openDb`; follow its existing style):

```js
test('search schema: tables, insert trigger, and NOTHING else', () => {
  const db = openDb(':memory:')
  // content table + fts + backfill state all exist
  db.prepare("INSERT INTO search_messages(user_id, convo_id, seq, ts, sender, body) VALUES(1,'c1',1,1,'user:dan','hello sqlite search')").run()
  const hit = db.prepare("SELECT rowid FROM search_fts WHERE search_fts MATCH 'sqlite'").get()
  assert.ok(hit, 'insert trigger populates the FTS index')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_backfill_state').get().n, 0)
  // The append-only invariant, pinned: exactly ONE trigger (after-insert) on
  // search_messages — a future update/delete trigger means someone added a
  // mutation path to events and must revisit the whole design.
  const triggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='search_messages'"
  ).all()
  assert.deepEqual(triggers.map((t) => t.name), ['search_messages_ai'])
  db.close()
})

test('search schema: UNIQUE(user_id, seq) makes re-inserts with OR IGNORE no-ops', () => {
  const db = openDb(':memory:')
  const ins = db.prepare("INSERT OR IGNORE INTO search_messages(user_id, convo_id, seq, ts, sender, body) VALUES(1,'c1',1,1,'user:dan','hello')")
  assert.equal(ins.run().changes, 1)
  assert.equal(ins.run().changes, 0)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM search_fts WHERE search_fts MATCH 'hello'").get().n, 1)
  db.close()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/db.test.js`
Expected: FAIL — `no such table: search_messages`

- [ ] **Step 3: Extend `SCHEMA` in `src/db.js`**

Append inside the `SCHEMA` template string (after `agent_chat_allowances`):

```sql
CREATE TABLE IF NOT EXISTS search_messages(
  rowid     INTEGER PRIMARY KEY,
  user_id   INTEGER NOT NULL,
  convo_id  TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  sender    TEXT NOT NULL,
  body      TEXT NOT NULL,
  UNIQUE(user_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_search_messages_convo ON search_messages(convo_id, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  body,
  content='search_messages',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS search_messages_ai AFTER INSERT ON search_messages BEGIN
  INSERT INTO search_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TABLE IF NOT EXISTS search_backfill_state(
  id INTEGER PRIMARY KEY CHECK(id=1),
  last_events_rowid INTEGER NOT NULL
);
```

And add this comment directly above that block, inside the template string as SQL comments or immediately above `SCHEMA` — match the file's existing comment style (JS comments above the string are fine):

```js
// Search index (spec: agent journal search). Deliberately INSERT-trigger
// only: `events` is append-only — plain INSERT in journal.js append(), no
// DELETE anywhere, and retention only rewrites tool_output payloads, which
// indexableBody never indexes — so no update/delete trigger can ever be
// needed. If a delete/update path is ever added to `events`, this schema
// must be revisited (external-content FTS corrupts when content rows change
// without the matching fts delete — matron-apple #106). Never INSERT OR
// REPLACE into search_messages for the same reason.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/db.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite (schema changes touch everything)**

Run: `npm test 2>&1 | tail -8`
Expected: `# pass` equals the total and `# fail 0`, test count ≥ 499.

- [ ] **Step 6: Commit**

```bash
git add src/db.js test/db.test.js
git commit -m "search: schema — content-table FTS5 pair, insert trigger only, backfill cursor"
```

---

### Task 3: Live append indexing — inside the existing transaction

**Files:**
- Modify: `src/journal.js` (the `append()` transaction, immediately after the `INSERT INTO events` at src/journal.js:118-120)
- Test: `test/search.test.js`

**Interfaces:**
- Consumes: `indexableBody` from Task 1, schema from Task 2.
- Produces: every `append()` of an indexable event also writes its `search_messages` row atomically. Consumed by Task 5's endpoint tests.

- [ ] **Step 1: Write the failing tests**

Add to `test/search.test.js`:

```js
import { openDb } from '../src/db.js'
import { append, upsertConversation } from '../src/journal.js'
import { runExpireLogs, runOffload } from '../src/retention.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function seedUserAndConvo(db, { userId = 1, convoId = 'c1' } = {}) {
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(?, ?, 'x', 0)")
    .run(userId, `u${userId}`)
  upsertConversation(db, { id: convoId, ownerUserId: userId, title: 'T', sessionState: 'running' })
  return { userId, convoId }
}

const ftsCount = (db, term) =>
  db.prepare('SELECT COUNT(*) n FROM search_fts WHERE search_fts MATCH ?').get(`"${term}"`).n

test('append: text and diff events are indexed in the same transaction', () => {
  const db = openDb(':memory:')
  const { userId, convoId } = seedUserAndConvo(db)
  append(db, { userId, convoId, sender: 'user:dan', type: 'text', payload: { body: 'sqlcipher attempt deferred' } })
  append(db, { userId, convoId, sender: 'agent:kit', type: 'diff', payload: { diff: '+used xchacha instead' } })
  assert.equal(ftsCount(db, 'sqlcipher'), 1)
  assert.equal(ftsCount(db, 'xchacha'), 1)
  const row = db.prepare('SELECT * FROM search_messages WHERE user_id=? ORDER BY seq').get(userId)
  assert.equal(row.convo_id, convoId)
  assert.equal(row.sender, 'user:dan')
  db.close()
})

test('append: tool_output and other non-prose types never reach the index', () => {
  const db = openDb(':memory:')
  const { userId, convoId } = seedUserAndConvo(db)
  append(db, { userId, convoId, sender: 'agent:kit', type: 'tool_output', payload: { command: 'env', snippet: 'SECRET=hunter2' } })
  append(db, { userId, convoId, sender: 'agent:kit', type: 'session_status', payload: { state: 'waiting' } })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_messages').get().n, 0)
  db.close()
})

test('append: a failed append indexes nothing (transactionality)', () => {
  const db = openDb(':memory:')
  seedUserAndConvo(db)
  assert.throws(() => append(db, { userId: 1, convoId: 'nope', sender: 'user:dan', type: 'text', payload: { body: 'ghost' } }))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_messages').get().n, 0)
  db.close()
})

test('retention rewriting tool_output leaves the index untouched', () => {
  const db = openDb(':memory:')
  const { userId, convoId } = seedUserAndConvo(db)
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-retention-'))
  append(db, { userId, convoId, sender: 'user:dan', type: 'text', payload: { body: 'the only indexed row' } })
  append(db, { userId, convoId, sender: 'agent:kit', type: 'tool_output', payload: { command: 'ls', snippet: 'out', live_log: true } })
  append(db, { userId, convoId, sender: 'agent:kit', type: 'tool_output', payload: { command: 'ls', snippet: 'old out' } })
  // Age both tool_output rows past every retention window
  db.prepare("UPDATE events SET ts=1 WHERE type='tool_output'").run()
  runExpireLogs(db, { hours: 24, mediaDir })
  runOffload(db, { days: 30, mediaDir })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_messages').get().n, 1)
  assert.equal(ftsCount(db, 'indexed'), 1)
  db.close()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/search.test.js`
Expected: the four new tests FAIL (`search_messages` count 0 where 1+ expected); Task 1's tests still pass.

- [ ] **Step 3: Wire the index insert into `append()`**

In `src/journal.js`: add the import at the top —

```js
import { indexableBody } from './search.js'
```

— and inside `append()`'s transaction, immediately after the `INSERT INTO events` `.run(...)` (src/journal.js:118-120), before the `if (type === 'session_status')` branch:

```js
    // Search index feed (spec: agent journal search) — same transaction as
    // the event row, so the index can never hold a row the journal doesn't
    // (or vice versa). Plain INSERT, never OR REPLACE/OR IGNORE: a duplicate
    // (user_id, seq) is impossible for a freshly-minted seq, and failing
    // loudly beats silently corrupting the external-content FTS pair.
    const searchBody = indexableBody(type, payload)
    if (searchBody != null) {
      db.prepare(
        'INSERT INTO search_messages(user_id, convo_id, seq, ts, sender, body) VALUES(?,?,?,?,?,?)'
      ).run(userId, convoId, seq, ts, sender, searchBody)
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/search.test.js`
Expected: PASS. If the transactionality test fails with a bind error, check the VALUES column order against the schema.

- [ ] **Step 5: Run the full suite**

Run: `npm test 2>&1 | tail -8`
Expected: `# fail 0`. (`append()` is on every hot path — the whole suite is the regression net.)

- [ ] **Step 6: Commit**

```bash
git add src/journal.js test/search.test.js
git commit -m "search: index prose events at append time, inside the append transaction"
```

---

### Task 4: Backfill — resumable, idempotent, kicked off at server start

**Files:**
- Modify: `src/search.js` (add `backfillSearchIndex`)
- Modify: `src/server.js` (kick off after `listen`, stop on `close`)
- Test: `test/search.test.js`

**Interfaces:**
- Consumes: `indexableBody` (Task 1), `search_backfill_state` (Task 2).
- Produces: `backfillSearchIndex(db, { batchSize?, log?, shouldStop? }) -> Promise<{ scanned, indexed }>`. `startServer` result gains `searchBackfill` (the promise) so tests can await completion.

- [ ] **Step 1: Write the failing tests**

Add to `test/search.test.js`:

```js
import { backfillSearchIndex } from '../src/search.js'

// Simulates a pre-search DB: rows written straight into `events`, bypassing
// append() and therefore the live index feed — exactly what history looks
// like when the schema first arrives.
function insertRawEvent(db, { userId, convoId, seq, type, payload, sender = 'user:dan' }) {
  db.prepare('INSERT INTO user_seq(user_id, seq) VALUES(?, ?) ON CONFLICT(user_id) DO UPDATE SET seq=MAX(seq, excluded.seq)').run(userId, seq)
  db.prepare(
    'INSERT INTO events(user_id, seq, convo_id, ts, sender, type, payload) VALUES(?,?,?,?,?,?,?)'
  ).run(userId, seq, convoId, seq, sender, type, JSON.stringify(payload))
}

test('backfill: indexes historical prose, skips everything else, and reports progress', async () => {
  const db = openDb(':memory:')
  seedUserAndConvo(db)
  insertRawEvent(db, { userId: 1, convoId: 'c1', seq: 1, type: 'text', payload: { body: 'ancient decision' } })
  insertRawEvent(db, { userId: 1, convoId: 'c1', seq: 2, type: 'tool_output', payload: { snippet: 'SECRET=hunter2' } })
  insertRawEvent(db, { userId: 1, convoId: 'c1', seq: 3, type: 'diff', payload: { diff: '+ancient change' } })
  const lines = []
  const r = await backfillSearchIndex(db, { batchSize: 2, log: (l) => lines.push(l) })
  assert.equal(r.scanned, 3)
  assert.equal(r.indexed, 2)
  assert.ok(lines.length >= 1, 'progress is logged')
  assert.equal(ftsCount(db, 'ancient'), 2)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM search_messages WHERE body LIKE '%SECRET%'").get().n, 0)
  db.close()
})

test('backfill: running twice changes nothing (idempotent)', async () => {
  const db = openDb(':memory:')
  seedUserAndConvo(db)
  insertRawEvent(db, { userId: 1, convoId: 'c1', seq: 1, type: 'text', payload: { body: 'once only' } })
  await backfillSearchIndex(db)
  const r2 = await backfillSearchIndex(db)
  assert.equal(r2.indexed, 0)
  assert.equal(ftsCount(db, 'once'), 1)
  db.close()
})

test('backfill: interrupt and re-run reaches the same state (resumable)', async () => {
  const db = openDb(':memory:')
  seedUserAndConvo(db)
  for (let i = 1; i <= 10; i++) insertRawEvent(db, { userId: 1, convoId: 'c1', seq: i, type: 'text', payload: { body: `note ${i}` } })
  let batches = 0
  const r1 = await backfillSearchIndex(db, { batchSize: 3, shouldStop: () => ++batches > 1 })
  assert.ok(r1.scanned < 10, 'stopped early')
  const r2 = await backfillSearchIndex(db, { batchSize: 3 })
  assert.equal(r1.scanned + r2.scanned, 10, 'resume starts where the interrupt left off, no re-scan')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_messages').get().n, 10)
  db.close()
})

test('backfill: rows the live path already indexed are not duplicated', async () => {
  const db = openDb(':memory:')
  const { userId, convoId } = seedUserAndConvo(db)
  append(db, { userId, convoId, sender: 'user:dan', type: 'text', payload: { body: 'live row' } })
  const r = await backfillSearchIndex(db)
  assert.equal(r.indexed, 0)
  assert.equal(ftsCount(db, 'live'), 1)
  db.close()
})

test('startServer kicks off the backfill and exposes its promise', async () => {
  const { startTestServer } = await import('./helpers.js')
  const s = await startTestServer()
  assert.ok(s.searchBackfill instanceof Promise)
  await s.searchBackfill
  await s.close()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/search.test.js`
Expected: FAIL — `backfillSearchIndex` is not exported.

- [ ] **Step 3: Implement `backfillSearchIndex` in `src/search.js`**

```js
// Startup backfill (spec: agent journal search, "Backfill"). Walks `events`
// by rowid in batches, indexing every row indexableBody accepts. Three
// safety properties, each load-bearing:
//   - INSERT OR IGNORE on UNIQUE(user_id, seq) — never OR REPLACE (the
//     external-content corruption trap, matron-apple #106) — so overlap
//     with the live append path or a re-run is a no-op, not a duplicate.
//   - The cursor row (search_backfill_state) advances per committed batch,
//     so an interrupted run resumes where it stopped and a completed one
//     costs a single row read at next boot. Rows appended after the schema
//     exists are indexed live by append(), so the cursor can never miss.
//   - One batch per event-loop turn (the await below): better-sqlite3 is
//     synchronous, and a multi-GB history must not starve the server's
//     sockets while it indexes. Search returns partial results until the
//     walk finishes — acceptable and self-healing (spec).
export async function backfillSearchIndex(db, { batchSize = 1000, log = () => {}, shouldStop = () => false } = {}) {
  const state = db.prepare('SELECT last_events_rowid FROM search_backfill_state WHERE id=1').get()
  let cursor = state ? state.last_events_rowid : 0
  const saveCursor = db.prepare(
    'INSERT INTO search_backfill_state(id, last_events_rowid) VALUES(1, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET last_events_rowid=excluded.last_events_rowid'
  )
  const selectBatch = db.prepare(
    'SELECT rowid, user_id, convo_id, seq, ts, sender, type, payload FROM events WHERE rowid>? ORDER BY rowid LIMIT ?'
  )
  const insert = db.prepare(
    'INSERT OR IGNORE INTO search_messages(user_id, convo_id, seq, ts, sender, body) VALUES(?,?,?,?,?,?)'
  )
  let scanned = 0
  let indexed = 0
  for (;;) {
    if (shouldStop()) break
    const rows = selectBatch.all(cursor, batchSize)
    if (rows.length === 0) break
    db.transaction(() => {
      for (const row of rows) {
        let payload
        try { payload = JSON.parse(row.payload) } catch { payload = null }
        const body = indexableBody(row.type, payload)
        if (body != null) indexed += insert.run(row.user_id, row.convo_id, row.seq, row.ts, row.sender, body).changes
      }
      cursor = rows[rows.length - 1].rowid
      saveCursor.run(cursor)
    })()
    scanned += rows.length
    log(`search backfill: scanned ${scanned} events, indexed ${indexed}`)
    await new Promise((r) => setImmediate(r))
  }
  return { scanned, indexed }
}
```

- [ ] **Step 4: Kick it off in `src/server.js`**

Import at the top: `import { backfillSearchIndex } from './search.js'`.

Inside `startServer`, add a stop flag next to the interval declarations (`let retentionInterval = null`):

```js
  let closing = false
```

Inside the `server.listen` callback, next to `scheduleRetention(...)`:

```js
      // Fire-and-forget: search serves partial results until this finishes
      // (self-healing — spec). shouldStop lets close() end the walk cleanly
      // instead of racing a closed DB handle.
      const searchBackfill = backfillSearchIndex(db, {
        log: (l) => console.log(l),
        shouldStop: () => closing,
      }).catch((err) => { console.error('search backfill failed', err) })
```

Add `searchBackfill` to the resolved server object, and in `close()` set the flag and await the walk before `db.close()`:

```js
        close: () => new Promise((r) => {
          closing = true
          if (retentionInterval) clearInterval(retentionInterval)
          if (walCheckpointInterval) clearInterval(walCheckpointInterval)
          wss.close()
          for (const c of wss.clients) c.terminate()
          pushPipeline.close()
          if (ownsApnsClient) resolvedApnsClient.close()
          server.close(() => { searchBackfill.then(() => { db.close(); r() }) })
        }),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/search.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full suite (server close path changed — everything exercises it)**

Run: `npm test 2>&1 | tail -8`
Expected: `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/search.js src/server.js test/search.test.js
git commit -m "search: resumable startup backfill over historical events"
```

---

### Task 5: `GET /search` — quoted-term queries, user-scoped, ranked

**Files:**
- Modify: `src/search.js` (add `ftsQueryFor`, `searchMessages`)
- Modify: `src/http.js` (add the route, after the `/agent-chat/answer` block)
- Test: `test/search.test.js`

**Interfaces:**
- Consumes: schema (Task 2), indexed rows (Tasks 3–4).
- Produces:
  - `ftsQueryFor(raw) -> string | null` — quoted-literal FTS5 MATCH string, null for empty input.
  - `searchMessages(db, userId, { query, limit, convoId? }) -> { badQuery: true } | { hits: [{ convo_id, title, seq, ts, sender, snippet, live }] }`.
  - `GET /search?q=&limit=&convo_id=` → `200 { hits }` / `400 { error: 'bad_request' }`.
  - The visibility/privacy plan extends `searchMessages` with an agent-caller exclusion — keep its options object extensible.

- [ ] **Step 1: Write the failing tests**

Add to `test/search.test.js` (server-level). New imports at the top of the file: `startTestServer` from `./helpers.js`, `createUser` from `../src/auth.js`. Seeding drives `s.db` directly with the `upsertConversation`/`append` imports Task 3 already added:

```js
import { startTestServer } from './helpers.js'
import { createUser } from '../src/auth.js'

test('GET /search: ranked hits with title, snippet, and live flag', async () => {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })
  const { token } = login.json
  const userId = login.json.user_id
  upsertConversation(s.db, { id: 'battery', ownerUserId: userId, title: 'Battery pass', sessionState: 'running' })
  upsertConversation(s.db, { id: 'old', ownerUserId: userId, title: 'Old work', sessionState: 'done' })
  append(s.db, { userId, convoId: 'battery', sender: 'agent:kit', type: 'text', payload: { body: 'cut the websocket ping cadence for battery' } })
  append(s.db, { userId, convoId: 'old', sender: 'user:dan', type: 'text', payload: { body: 'battery mentioned once in passing' } })

  const r = await s.http('/search?q=battery', { token })
  assert.equal(r.status, 200)
  assert.equal(r.json.hits.length, 2)
  const hit = r.json.hits.find((h) => h.convo_id === 'battery')
  assert.equal(hit.title, 'Battery pass')
  assert.equal(hit.live, true)
  assert.ok(hit.snippet.includes('**battery**'), `snippet highlights the match: ${hit.snippet}`)
  assert.equal(r.json.hits.find((h) => h.convo_id === 'old').live, false)
  await s.close()
})

test('GET /search: cross-user isolation — A cannot match B text', async () => {
  const s = await startTestServer()
  for (const name of ['alice', 'bob']) {
    await createUser(s.db, name, 'password-123')
  }
  const a = (await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'password-123' } })).json
  const b = (await s.http('/login', { method: 'POST', body: { username: 'bob', password: 'password-123' } })).json
  upsertConversation(s.db, { id: 'bc', ownerUserId: b.user_id, title: 'B', sessionState: 'done' })
  append(s.db, { userId: b.user_id, convoId: 'bc', sender: 'user:bob', type: 'text', payload: { body: 'wombat sighting confirmed' } })

  const r = await s.http('/search?q=wombat', { token: a.token })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.hits, [])
  const rb = await s.http('/search?q=wombat', { token: b.token })
  assert.equal(rb.json.hits.length, 1)
  await s.close()
})

test('GET /search: human-typed FTS syntax is treated as literal terms, never a 500', async () => {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const { token, user_id } = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })).json
  upsertConversation(s.db, { id: 'c', ownerUserId: user_id, title: 'C', sessionState: 'done' })
  append(s.db, { userId: user_id, convoId: 'c', sender: 'user:dan', type: 'text', payload: { body: "don't use NEAR the edge *" } })
  for (const q of ['don"t', '*', 'NEAR(', '"unbalanced', 'a AND OR']) {
    const r = await s.http(`/search?q=${encodeURIComponent(q)}`, { token })
    assert.notEqual(r.status, 500, `q=${q} must never 500`)
    assert.ok([200, 400].includes(r.status), `q=${q} → ${r.status}`)
  }
  // Quoting makes syntax characters literal: NEAR matches the stored text as a word
  const near = await s.http('/search?q=NEAR', { token })
  assert.equal(near.status, 200)
  assert.equal(near.json.hits.length, 1)
  await s.close()
})

test('GET /search: bad inputs → 400; limit is clamped to 50', async () => {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const { token } = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })).json
  assert.equal((await s.http('/search', { token })).status, 400)
  assert.equal((await s.http('/search?q=%20%20', { token })).status, 400)
  assert.equal((await s.http(`/search?q=${'x'.repeat(300)}`, { token })).status, 400)
  assert.equal((await s.http('/search?q=a&limit=0', { token })).status, 400)
  assert.equal((await s.http('/search?q=a&limit=nope', { token })).status, 400)
  assert.equal((await s.http('/search?q=a&limit=100000', { token })).status, 200)
  await s.close()
})

test('GET /search: convo_id narrows to one conversation; unknown/foreign convo_id is just zero hits', async () => {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const { token, user_id } = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })).json
  upsertConversation(s.db, { id: 'c1', ownerUserId: user_id, title: 'One', sessionState: 'done' })
  upsertConversation(s.db, { id: 'c2', ownerUserId: user_id, title: 'Two', sessionState: 'done' })
  append(s.db, { userId: user_id, convoId: 'c1', sender: 'user:dan', type: 'text', payload: { body: 'shared keyword' } })
  append(s.db, { userId: user_id, convoId: 'c2', sender: 'user:dan', type: 'text', payload: { body: 'shared keyword' } })
  const r = await s.http('/search?q=shared&convo_id=c1', { token })
  assert.equal(r.json.hits.length, 1)
  assert.equal(r.json.hits[0].convo_id, 'c1')
  // No existence oracle: a convo_id the user cannot see returns the same
  // empty set an unmatched query does (results are user-scoped regardless).
  const foreign = await s.http('/search?q=shared&convo_id=someone-elses', { token })
  assert.equal(foreign.status, 200)
  assert.deepEqual(foreign.json.hits, [])
  await s.close()
})

test('GET /search: porter stemming finds morphological variants', async () => {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const { token, user_id } = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })).json
  upsertConversation(s.db, { id: 'c', ownerUserId: user_id, title: 'C', sessionState: 'done' })
  append(s.db, { userId: user_id, convoId: 'c', sender: 'user:dan', type: 'text', payload: { body: 'we dropped the sqlcipher plan' } })
  const r = await s.http('/search?q=dropping', { token })
  assert.equal(r.json.hits.length, 1)
  await s.close()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/search.test.js`
Expected: the new endpoint tests FAIL with 404s (route doesn't exist).

- [ ] **Step 3: Implement `ftsQueryFor` + `searchMessages` in `src/search.js`**

```js
// Human input → FTS5 MATCH string. Raw MATCH syntax throws on things people
// actually type (an unbalanced quote, a bare *, a stray NEAR) — so every
// whitespace-separated term is double-quoted (FTS5 escapes an embedded " by
// doubling it), giving an implicit AND over literal terms. Returns null for
// input with no terms; the route maps that to 400.
export function ftsQueryFor(raw) {
  const terms = String(raw).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return null
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ')
}

// Ranked, user-scoped search (spec: GET /search). bm25() ascending is
// best-first; ts DESC breaks ties toward recency. `live` is derived from the
// conversation's session_state so the caller can prefer talking to a working
// agent over reading its transcript. The try/catch is belt-and-braces: after
// quoting, a parse failure should be unreachable, but a SQLite error must
// surface as badQuery (→ 400), never a 500 with internals in it.
export function searchMessages(db, userId, { query, limit = 20, convoId = null } = {}) {
  const match = ftsQueryFor(query)
  if (match == null) return { badQuery: true }
  const sql = `
    SELECT sm.convo_id, c.title, sm.seq, sm.ts, sm.sender, c.session_state,
           snippet(search_fts, 0, '**', '**', '…', 12) AS snippet
    FROM search_fts
    JOIN search_messages sm ON sm.rowid = search_fts.rowid
    JOIN conversations c ON c.id = sm.convo_id
    WHERE search_fts MATCH ? AND sm.user_id = ?${convoId != null ? ' AND sm.convo_id = ?' : ''}
    ORDER BY bm25(search_fts), sm.ts DESC
    LIMIT ?`
  let rows
  try {
    rows = convoId != null
      ? db.prepare(sql).all(match, userId, convoId, limit)
      : db.prepare(sql).all(match, userId, limit)
  } catch {
    return { badQuery: true }
  }
  return {
    hits: rows.map((r) => ({
      convo_id: r.convo_id, title: r.title, seq: r.seq, ts: r.ts, sender: r.sender,
      snippet: r.snippet, live: r.session_state === 'running',
    })),
  }
}
```

- [ ] **Step 4: Add the route in `src/http.js`**

Import at the top: `import { searchMessages } from './search.js'`.

After the `/agent-chat/answer` block (src/http.js:378), add:

```js
      if (req.method === 'GET' && url.pathname === '/search') {
        // User-scoped full-text search (spec: agent journal search). Open to
        // both device kinds: agents are the design's audience, clients may
        // ride it later; scoping is by the authenticated user either way.
        const q = url.searchParams.get('q')
        if (typeof q !== 'string' || !q.trim() || q.length > 256) return json(res, 400, { error: 'bad_request' })
        const rawLimit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 20
        if (!Number.isInteger(rawLimit) || rawLimit < 1) return json(res, 400, { error: 'bad_request' })
        const limit = Math.min(rawLimit, 50)
        // convo_id narrows results; an id the user can't see yields the same
        // empty set an unmatched query does (user scoping already guarantees
        // it) — no existence oracle, nothing extra to check.
        const convoId = url.searchParams.get('convo_id')
        const r = searchMessages(db, who.userId, { query: q, limit, convoId })
        if (r.badQuery) return json(res, 400, { error: 'bad_request' })
        return json(res, 200, { hits: r.hits })
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/search.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/search.js src/http.js test/search.test.js
git commit -m "search: GET /search — quoted-term FTS queries, user-scoped, bm25-ranked"
```

---

### Task 6: `around_seq` context mode — read around a hit

**Files:**
- Modify: `src/journal.js` (add `messagesAround` beside `messagesBefore`)
- Modify: `src/http.js` (the `GET /convo/:id/messages` block, src/http.js:460-503)
- Test: `test/search.test.js`

**Interfaces:**
- Consumes: `authorize` (existing), `indexableBody` (Task 1), `authorizeAgentWrite` + `isClientOnlyEvent` (existing route logic).
- Produces: `messagesAround(db, userId, convoId, { aroundSeq, limit }) -> events[]` (ascending seq, ≤ limit rows, anchored on `aroundSeq`); `GET /convo/:id/messages?around_seq=&limit=` with the locked-decision authorization (agents may read foreign conversations in this mode, filtered to `indexableBody`-visible events).

- [ ] **Step 1: Write the failing tests**

Add to `test/search.test.js`. The fixture needs an agent device: mint one with `createAgent` and connect nothing (HTTP only).

```js
import { createAgent } from '../src/auth.js'

// Fixture: dan with a client token, two agent devices (kit manages 'work',
// rex manages nothing), prose + tool_output events in 'work'.
async function contextFixture() {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const { token: clientToken, user_id: userId } = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })).json
  const kit = createAgent(s.db, userId, 'kit')
  const rex = createAgent(s.db, userId, 'rex')
  upsertConversation(s.db, { id: 'work', ownerUserId: userId, title: 'Work', sessionState: 'running', agentDeviceId: kit.deviceId })
  const seqs = []
  const put = (type, payload) => {
    const r = append(s.db, { userId, convoId: 'work', sender: 'agent:kit', type, payload })
    seqs.push(r.seq)
    return r.seq
  }
  put('text', { body: 'first message' })
  put('tool_output', { command: 'env', snippet: 'SECRET=hunter2' })
  const anchor = put('text', { body: 'the decision happened here' })
  put('diff', { diff: '+the change itself' })
  put('text', { body: 'aftermath' })
  return { s, clientToken, userId, kit, rex, anchor, seqs }
}

test('around_seq: client gets the window either side, ascending, anchored', async () => {
  const { s, clientToken, anchor } = await contextFixture()
  const r = await s.http(`/convo/work/messages?around_seq=${anchor}&limit=4`, { token: clientToken })
  assert.equal(r.status, 200)
  const seqs = r.json.events.map((e) => e.seq)
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, 'ascending')
  assert.ok(r.json.events.some((e) => e.seq === anchor), 'anchor row included')
  assert.ok(r.json.events.length <= 4)
  assert.ok(r.json.events.some((e) => e.seq < anchor) && r.json.events.some((e) => e.seq > anchor), 'both sides present')
  await s.close()
})

test('around_seq: at either end of a conversation returns short, not an error', async () => {
  const { s, clientToken, seqs } = await contextFixture()
  const first = await s.http(`/convo/work/messages?around_seq=${seqs[0]}&limit=10`, { token: clientToken })
  assert.equal(first.status, 200)
  assert.equal(first.json.events.length, 5)
  const last = await s.http(`/convo/work/messages?around_seq=${seqs[seqs.length - 1] + 100}&limit=10`, { token: clientToken })
  assert.equal(last.status, 200)
  assert.ok(last.json.events.length > 0)
  await s.close()
})

test('around_seq: before_seq and around_seq together → 400', async () => {
  const { s, clientToken, anchor } = await contextFixture()
  const r = await s.http(`/convo/work/messages?around_seq=${anchor}&before_seq=${anchor}`, { token: clientToken })
  assert.equal(r.status, 400)
  await s.close()
})

test('around_seq: a foreign agent sees ONLY what the index can see — the tool_output leak test', async () => {
  const { s, rex, anchor } = await contextFixture()
  const r = await s.http(`/convo/work/messages?around_seq=${anchor}&limit=10`, { token: rex.token })
  assert.equal(r.status, 200, 'foreign agent CAN read context around a hit — that is the feature')
  assert.ok(r.json.events.length >= 3)
  const raw = JSON.stringify(r.json)
  assert.ok(!raw.includes('SECRET'), 'tool_output never reaches a foreign agent')
  assert.ok(r.json.events.every((e) => ['text', 'diff'].includes(e.type)))
  await s.close()
})

test('around_seq: the managing agent still sees its own conversation unfiltered', async () => {
  const { s, kit, anchor } = await contextFixture()
  const r = await s.http(`/convo/work/messages?around_seq=${anchor}&limit=10`, { token: kit.token })
  assert.equal(r.status, 200)
  assert.ok(r.json.events.some((e) => e.type === 'tool_output'), 'own-conversation reads are unchanged')
  await s.close()
})

test('around_seq: before_seq keeps the existing agent gate — foreign agent still 404s', async () => {
  const { s, rex } = await contextFixture()
  const r = await s.http('/convo/work/messages?limit=10', { token: rex.token })
  assert.equal(r.status, 404)
  await s.close()
})

test('around_seq: cross-user is 404, indistinguishable from missing', async () => {
  const { s, anchor } = await contextFixture()
  await createUser(s.db, 'mallory', 'password-123')
  const m = (await s.http('/login', { method: 'POST', body: { username: 'mallory', password: 'password-123' } })).json
  const r = await s.http(`/convo/work/messages?around_seq=${anchor}`, { token: m.token })
  assert.equal(r.status, 404)
  const missing = await s.http(`/convo/no-such/messages?around_seq=${anchor}`, { token: m.token })
  assert.equal(missing.status, 404)
  assert.deepEqual(r.json, missing.json)
  await s.close()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/search.test.js`
Expected: FAIL — `around_seq` is ignored today, so windows/statuses come back wrong.

- [ ] **Step 3: Add `messagesAround` to `src/journal.js`**

Directly below `messagesBefore` (src/journal.js:181-187):

```js
// Context window for a search hit (spec: agent journal search, around_seq).
// floor(limit/2) rows strictly before the anchor, the remainder from the
// anchor up — so the anchor row itself is included when it exists, and
// either end of the conversation just yields a short window, never an
// error. Ascending order, same authorize() gate as messagesBefore.
export function messagesAround(db, userId, convoId, { aroundSeq, limit = 30 } = {}) {
  if (!authorize(db, userId, convoId)) throw new Error('not authorized')
  const before = Math.floor(limit / 2)
  const after = limit - before
  const rows = [
    ...db.prepare('SELECT * FROM events WHERE convo_id=? AND seq<? ORDER BY seq DESC LIMIT ?')
      .all(convoId, aroundSeq, before).reverse(),
    ...db.prepare('SELECT * FROM events WHERE convo_id=? AND seq>=? ORDER BY seq LIMIT ?')
      .all(convoId, aroundSeq, after),
  ]
  return rows.map(parseRow)
}
```

- [ ] **Step 4: Wire the mode into `src/http.js`**

Update the imports from `./journal.js` to include `messagesAround`, and from `./search.js` add `indexableBody`.

In the messages route (src/http.js:460-503), after the `before_seq` parsing and before the limit parsing, add:

```js
        let aroundSeq = null
        if (url.searchParams.has('around_seq')) {
          aroundSeq = Number(url.searchParams.get('around_seq'))
          if (!Number.isInteger(aroundSeq)) return json(res, 400, { error: 'bad_request' })
        }
        // The two paging modes are mutually exclusive by design — a request
        // carrying both has a confused caller, and picking one silently
        // would hide the bug.
        if (aroundSeq != null && beforeSeq != null) return json(res, 400, { error: 'bad_request' })
```

Replace the agent gate + read block (currently src/http.js:486-502) with:

```js
        // Two agent read regimes (locked decision, search spec fold-in):
        //  - before_seq (and default) paging keeps the Phase-2 gate: an agent
        //    reads full transcripts only for conversations it manages or has
        //    joined (authorizeAgentWrite) — 404 otherwise, same as ever.
        //  - around_seq on a conversation OUTSIDE that set is the search
        //    context surface: allowed (it is the feature /search exists to
        //    serve), but filtered to exactly what the index can see
        //    (indexableBody non-null: text + diff prose). tool_output — the
        //    credential surface — and every other type never appear, which
        //    also covers the client-only consent card (indexableBody is null
        //    for permission_request).
        const agentForeign = who.kind === 'agent' && !authorizeAgentWrite(db, who.userId, who.deviceId, convoId)
        if (agentForeign && aroundSeq == null) {
          return json(res, 404, { error: 'not_found' })
        }
        try {
          let events = aroundSeq != null
            ? messagesAround(db, who.userId, convoId, { aroundSeq, limit })
            : messagesBefore(db, who.userId, convoId, { beforeSeq, limit })
          if (agentForeign) {
            events = events.filter((e) => indexableBody(e.type, e.payload) != null)
          } else if (who.kind !== 'client') {
            // Client-only events (the agent-chat approval card) never reach an
            // agent device by any read path — this is the HTTP-pagination half
            // of the guarantee ws.js's fanOut and hello replay also enforce.
            events = events.filter((e) => !isClientOnlyEvent(e.type, e.payload))
          }
          return json(res, 200, { events: events.map(toEventShape) })
        } catch (e) {
          // Unauthorized and missing are indistinguishable: both 404, same
          // body as GET /media/:id's unknown-id response — never 403 (that
          // would confirm the convo id exists to a caller who can't read it).
          if (/not authorized/.test(e.message)) return json(res, 404, { error: 'not_found' })
          throw e
        }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/search.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full suite (the messages route is shared with the apps' paging)**

Run: `npm test 2>&1 | tail -8`
Expected: `# fail 0`, count ≥ 499 + the new tests.

- [ ] **Step 7: Commit**

```bash
git add src/journal.js src/http.js test/search.test.js
git commit -m "search: around_seq context mode — prose-only window for foreign-agent reads"
```

---

### Task 7: Documentation — protocol.md + spec fold-in

**Files:**
- Modify: `docs/protocol.md` (new "Journal search" section next to the existing messages-endpoint docs)
- Modify: `docs/superpowers/specs/2026-08-07-agent-journal-search-design.md` (fold the locked decisions in)

- [ ] **Step 1: Document the API in `docs/protocol.md`**

Add a section covering, in the file's existing voice:

- `GET /search?q=&limit=&convo_id=` — the response shape `{ hits: [{ convo_id, title, seq, ts, sender, snippet, live }] }`; term-quoting semantics (implicit AND over literals, `**` highlight markers, porter stemming); user scoping; limit clamp at 50; 400 for empty/oversized/unparseable queries; `convo_id` narrowing with no existence oracle.
- `around_seq` mode on `GET /convo/:id/messages` — mutual exclusion with `before_seq` (400); window shape (floor(limit/2) before, remainder from the anchor); short-at-the-ends behavior; and the two agent read regimes (foreign conversations readable in this mode only, filtered to `indexableBody`-visible events — name `tool_output` exclusion explicitly as the credential guarantee).
- The index invariants: prose-only (`text` body, `diff` diff/snippet), append-only (no update/delete triggers, why), retention never touches indexed rows, backfill is resumable and self-healing at startup.

- [ ] **Step 2: Fold the locked decisions into the spec**

Add a `## Locked decisions (2026-08-08 planning)` section to `docs/superpowers/specs/2026-08-07-agent-journal-search-design.md` recording decisions 1–5 from this plan's header, each with its one-line rationale. Update the spec's "API" section sentence "Reuses the endpoint's existing authorisation unchanged" to reference the two-regime resolution (decision 1). Mark open question 1 (diffs) as resolved: included.

- [ ] **Step 3: Verify the suite still passes and nothing is uncommitted**

Run: `npm test 2>&1 | tail -8 && git status --short`
Expected: `# fail 0`; only the two docs files modified.

- [ ] **Step 4: Commit**

```bash
git add docs/protocol.md docs/superpowers/specs/2026-08-07-agent-journal-search-design.md
git commit -m "docs: journal search API + locked decisions folded into the spec"
```

---

## Out of scope (do not build here)

- The bridge tools `journal_search` / `journal_context` and their display lines — separate matron-bridge plan.
- The apps' `matron://convo?id=…&seq=…` deep link — phase 3, deferred.
- Agent-caller privacy filtering on `/search` and `around_seq` — the visibility/privacy plan layers it on `searchMessages` and the messages route.
- Semantic/vector search, cross-user search, any write path, indexing tool output.
