# Agent Chat Consent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent-to-agent chat request parks in the journal and reaches the target agent only after the user approves it — the requester's text is never transmitted to the target beforehand.

**Architecture:** `ws.js`'s `agent_invite`/`agent_join` handlers stop relaying to the target bridge. They park the request in `convo_agents` (new `awaiting_user` state), publish a client-only `permission_request` card into the room conversation, and ack the requester with the existing `delivered` frame. A client-gated HTTP endpoint (and a `matron-admin` fallback) flips the row to `invited`/`denied`; a single delivery pump — called from HTTP approve, agent hello, and the sweep timer — relays approved requests to targets whenever they are connected, tracked by a new `delivered_at` column.

**Tech Stack:** Node ESM, `better-sqlite3`, `node:test` + `node:assert/strict`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-07-agent-chat-consent-design.md`

## Global Constraints

- Repo: **matron-journal**. Bridge/app changes are out of scope (see final section).
- Run tests with `npm test` (whole suite) or `node --test test/<file>` (one file). Every task ends with the **whole suite** green — this repo's tests are fast.
- The security property is *absence of transmission*: tests must assert the target device's socket/hub mock received **no** frame, not merely that DB state looks right.
- All peer-written text (`from_name`, `topic`, `justification`) is sanitised before it is stored or published: control characters (including `\n`) become spaces, collapsed, trimmed, capped. Caps: reuse `INVITE_TOPIC_MAX_CHARS` (200) and `INVITE_TEXT_MAX_CHARS` (1000) from `src/ws.js:52-53`.
- `'denied'`, `'refused'` and `'expired'` must be indistinguishable to the requesting agent: every user-originated rejection frame uses `reason: 'refused'`.
- Existing frame names (`delivered`, `ack`, `answer`, `request`, `join_request`) keep their shapes — bridge master (`cd24956`) already speaks them. `delivered` semantics widen to "accepted into the system", which its tool copy already tolerates ("do NOT wait or poll").
- Constants (all in `src/ws.js` next to the existing invite constants): `AWAITING_USER_TTL_MS = 24 * 3600_000`, `MAX_AWAITING_PER_REQUESTER = 3`.

## Design decisions locked here (deviations from the spec, fold back into it in Task 10)

1. **The card is published into the room conversation**, not "the target agent's session conversation". The journal cannot know which session conversation the target bridge would choose — that mapping lives bridge-side — while the room is a real, user-visible conversation and is where the chat will happen if approved. Push (`permission_request` → `attention`, already wired in `push.js:37`) deep-links the user there.
2. **`delivered_at` column** on `convo_agents` records actual relay to the recipient. Approval and delivery become separate facts, which makes offline targets, `matron-admin` approvals (a separate process that cannot touch the hub), and retries all collapse into one mechanism: a pump that scans `state='invited' AND delivered_at IS NULL` and relays to whoever is connected.
3. **The 30-minute answer TTL runs from `delivered_at`, not `created_at`** — an approved invite whose target is offline must not expire before the target ever saw it. `awaiting_user` rows expire on their own 24h TTL from `created_at`.

## File Structure

- Modify: `src/db.js` — schema + `convo_agents` rebuild migration + `agent_chat_allowances` table
- Create: `src/peer-text.js` — `sanitizePeerText`
- Modify: `src/journal.js` — `isClientOnlyEvent`, card case in `snippetOf`
- Modify: `src/participants.js` — park/answer/deliver/expire state machine
- Create: `src/allowances.js` — always-allow pairs
- Create: `src/invite-delivery.js` — the delivery pump
- Modify: `src/ws.js` — handler rewrite, client-only exclusion (fan-out + replay), hello hook, sweep additions
- Modify: `src/http.js` — `/agent-chat/pending`, `/agent-chat/answer`, messages filter
- Modify: `bin/matron-admin.js` — `agent-chat` subcommands
- Tests: `test/db.test.js`, `test/peer-text.test.js` (new), `test/journal.test.js`, `test/participants.test.js`, `test/allowances.test.js` (new), `test/agent-chat-consent.test.js` (new), `test/invites.test.js` (rewrite of relay expectations), `test/http.test.js`, `test/admin.test.js`

---

### Task 1: Schema — `convo_agents` rebuild + `agent_chat_allowances`

**Files:**
- Modify: `src/db.js` (SCHEMA string ~line 67, migration block after the `PRAGMA table_info` migrations ~line 130)
- Test: `test/db.test.js`

**Interfaces:**
- Produces: `convo_agents` with states `('awaiting_user','invited','joined','refused','denied','left','expired')`, new columns `topic TEXT NOT NULL DEFAULT ''` and `delivered_at INTEGER`; table `agent_chat_allowances(user_id, from_device_id, target_device_id, created_at, PRIMARY KEY(user_id, from_device_id, target_device_id))`.

SQLite cannot ALTER a CHECK constraint, so existing databases need a table rebuild. Fresh databases get the new definition from SCHEMA directly; the rebuild detects the old definition via `sqlite_master.sql` and is skipped when the new one is already present — so it runs exactly once per old database and never on new ones.

- [ ] **Step 1: Write the failing tests**

Append to `test/db.test.js`:

```js
test('convo_agents accepts the consent states and columns', () => {
  const d = openDb(':memory:')
  d.prepare(`INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, justification, topic, created_at, delivered_at)
             VALUES('r', 2, 1, 'awaiting_user', 'j', 't', 5, NULL)`).run()
  d.prepare("UPDATE convo_agents SET state='denied' WHERE convo_id='r'").run()
  assert.equal(d.prepare("SELECT state FROM convo_agents WHERE convo_id='r'").get().state, 'denied')
  assert.throws(() => d.prepare("UPDATE convo_agents SET state='bogus' WHERE convo_id='r'").run())
})

test('old-schema convo_agents is rebuilt in place, rows preserved, delivered_at backfilled', () => {
  const Database = require('better-sqlite3') // if the file is ESM, import Database at top instead
  const raw = new Database(':memory:')
  raw.exec(`CREATE TABLE convo_agents(
    convo_id TEXT NOT NULL, agent_device_id INTEGER NOT NULL, initiator_device_id INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('invited','joined','refused','left','expired')),
    justification TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, answered_at INTEGER,
    PRIMARY KEY(convo_id, agent_device_id));
    INSERT INTO convo_agents VALUES('r', 2, 1, 'joined', 'why', 111, 222);`)
  migrate(raw) // whatever name db.js's migration entry has — openDb(path) runs it; export the migration so this test can run it on a prepared handle
  const row = raw.prepare("SELECT * FROM convo_agents WHERE convo_id='r'").get()
  assert.equal(row.state, 'joined')
  assert.equal(row.justification, 'why')
  assert.equal(row.topic, '')
  assert.equal(row.delivered_at, 111) // backfilled = created_at: old-flow rows were delivered at creation
})

test('agent_chat_allowances table exists with its composite key', () => {
  const d = openDb(':memory:')
  d.prepare('INSERT INTO agent_chat_allowances(user_id, from_device_id, target_device_id, created_at) VALUES(1,2,3,4)').run()
  assert.throws(() => d.prepare('INSERT INTO agent_chat_allowances(user_id, from_device_id, target_device_id, created_at) VALUES(1,2,3,5)').run())
})
```

Check how `test/db.test.js` imports and how `openDb` structures its migrations first; if migrations are inline in `openDb`, export a `migrate(db)` (or make the second test open a temp file with the old schema, close, reopen via `openDb`). Match the file's existing style.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/db.test.js`
Expected: FAIL — CHECK rejects `awaiting_user`, `topic` column missing, `agent_chat_allowances` missing.

- [ ] **Step 3: Implement**

In SCHEMA, replace the `convo_agents` definition:

```sql
CREATE TABLE IF NOT EXISTS convo_agents(
  convo_id TEXT NOT NULL,
  agent_device_id INTEGER NOT NULL,
  initiator_device_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('awaiting_user','invited','joined','refused','denied','left','expired')),
  justification TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  delivered_at INTEGER,
  PRIMARY KEY(convo_id, agent_device_id)
);
CREATE TABLE IF NOT EXISTS agent_chat_allowances(
  user_id INTEGER NOT NULL,
  from_device_id INTEGER NOT NULL,
  target_device_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, from_device_id, target_device_id)
);
```

After the existing `PRAGMA table_info` migrations, add the rebuild (with a comment explaining SQLite can't ALTER a CHECK, and that `delivered_at = created_at` backfill is correct because the pre-consent flow delivered at creation or undid the row):

```js
const caDef = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='convo_agents'").get()
if (caDef && !caDef.sql.includes('awaiting_user')) {
  db.exec(`
    CREATE TABLE convo_agents_new(
      convo_id TEXT NOT NULL,
      agent_device_id INTEGER NOT NULL,
      initiator_device_id INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('awaiting_user','invited','joined','refused','denied','left','expired')),
      justification TEXT NOT NULL DEFAULT '',
      topic TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      answered_at INTEGER,
      delivered_at INTEGER,
      PRIMARY KEY(convo_id, agent_device_id)
    );
    INSERT INTO convo_agents_new(convo_id, agent_device_id, initiator_device_id, state, justification, created_at, answered_at, delivered_at)
      SELECT convo_id, agent_device_id, initiator_device_id, state, justification, created_at, answered_at, created_at FROM convo_agents;
    DROP TABLE convo_agents;
    ALTER TABLE convo_agents_new RENAME TO convo_agents;
  `)
}
```

- [ ] **Step 4: Run tests** — `node --test test/db.test.js` then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add src/db.js test/db.test.js && git commit -m "convo_agents: consent states, topic + delivered_at, allowances table"`

---

### Task 2: `sanitizePeerText`

**Files:**
- Create: `src/peer-text.js`
- Test: `test/peer-text.test.js`

**Interfaces:**
- Produces: `sanitizePeerText(value, max) -> string` — coerces to string (`''` for null/undefined), replaces every control character (U+0000–U+001F, U+007F) with a space, collapses whitespace runs to one space, trims, truncates to `max`.

The journal is about to interpolate remote-agent text into an event it publishes in its own right; a `\n` in a justification must not be able to forge a second line. This mirrors the bridge's `peerField` (matron-bridge `lib/peer-text.js`) — kept as a copy, not a shared package, same stance as `matron-admin`'s hand-synced `isValidServerUrl`.

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizePeerText } from '../src/peer-text.js'

test('flattens control characters and newlines to single spaces', () => {
  assert.equal(sanitizePeerText('a\nb\r\nc\td\x00e', 100), 'a b c d e')
})
test('collapses runs, trims, caps', () => {
  assert.equal(sanitizePeerText('  a \n\n  b  ', 100), 'a b')
  assert.equal(sanitizePeerText('x'.repeat(10), 4), 'xxxx')
})
test('non-strings coerce, nullish becomes empty', () => {
  assert.equal(sanitizePeerText(null, 10), '')
  assert.equal(sanitizePeerText(undefined, 10), '')
  assert.equal(sanitizePeerText(42, 10), '42')
})
```

- [ ] **Step 2: Run** — `node --test test/peer-text.test.js` — FAIL (module missing).
- [ ] **Step 3: Implement**

```js
// Flatten peer-written text to one safe line before storing or publishing
// it in the journal's own voice. A remote agent writes from_name/topic/
// justification; a '\n' in any of them is line forgery in the user's chat,
// not cosmetics. Mirror of matron-bridge lib/peer-text.js peerField —
// hand-synced copy, same stance as matron-admin's isValidServerUrl.
export function sanitizePeerText(value, max) {
  if (value == null) return ''
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}
```

- [ ] **Step 4: Run** — `node --test test/peer-text.test.js` then `npm test`. PASS.
- [ ] **Step 5: Commit** — `git add src/peer-text.js test/peer-text.test.js && git commit -m "journal-side peer text sanitiser"`

---

### Task 3: `isClientOnlyEvent` + neutral card snippet

**Files:**
- Modify: `src/journal.js` (`snippetOf` ~line 7; new export next to `MESSAGE_TYPES`)
- Test: `test/journal.test.js`

**Interfaces:**
- Produces: `isClientOnlyEvent(type, payload) -> boolean` — true iff `type === 'permission_request'` and `payload?.kind === 'agent_chat'`. Consumed by Task 6 (fan-out, replay, HTTP filter).
- Produces: `snippetOf('permission_request', {kind:'agent_chat', ...})` returns the fixed string `'🤝 Agent chat request'`.

The snippet rule is load-bearing, not cosmetic: `append()` writes `snippetOf(...)` into `conversations.snippet`, and `/snapshot` hands every conversation's snippet to **any authenticated device including agents** (`http.js:240` has no kind gate). Without this, a fragment of the justification leaks to every agent through the snippet — around the client-only event exclusion.

- [ ] **Step 1: Write the failing tests**

Append to `test/journal.test.js` (match its imports):

```js
test('agent_chat permission_request is client-only; everything else is not', () => {
  assert.equal(isClientOnlyEvent('permission_request', { kind: 'agent_chat' }), true)
  assert.equal(isClientOnlyEvent('permission_request', { kind: 'tool_use' }), false)
  assert.equal(isClientOnlyEvent('permission_request', null), false)
  assert.equal(isClientOnlyEvent('text', { kind: 'agent_chat' }), false)
})

test('agent_chat card snippet is fixed — never the justification', () => {
  const s = snippetOf('permission_request', { kind: 'agent_chat', justification: 'SECRET-DO-NOT-LEAK' })
  assert.equal(s, '🤝 Agent chat request')
  assert.ok(!s.includes('SECRET'))
})
```

- [ ] **Step 2: Run** — `node --test test/journal.test.js` — FAIL.
- [ ] **Step 3: Implement**

In `src/journal.js`:

```js
// Events that must never reach an agent device, live or replayed. The
// agent-chat approval card carries a peer agent's justification — the whole
// consent design exists to keep that text away from agents until the user
// approves, and the target agent MANAGES the room conversation the card sits
// in, so the default fan-out would hand it straight over. One predicate,
// consumed by ws.js fanOut, ws.js hello replay, and http.js message reads —
// inlining the check at each site is how they drift apart.
export function isClientOnlyEvent(type, payload) {
  return type === 'permission_request' && !!payload && typeof payload === 'object' && payload.kind === 'agent_chat'
}
```

In `snippetOf`, before the generic handling:

```js
if (isClientOnlyEvent(type, payload)) return '🤝 Agent chat request'
```

- [ ] **Step 4: Run** — `node --test test/journal.test.js` then `npm test`. PASS.
- [ ] **Step 5: Commit** — `git add src/journal.js test/journal.test.js && git commit -m "client-only event predicate + neutral agent-chat card snippet"`

---

### Task 4: Participants state machine — park, answer, deliver, expire

**Files:**
- Modify: `src/participants.js`
- Test: `test/participants.test.js`

**Interfaces:**
- Consumes: schema from Task 1.
- Produces (all `(db, ...)`, following the file's existing style):
  - `parkInvite(db, {convoId, agentDeviceId, initiatorDeviceId, justification, topic}) -> {ok:true, prior} | {ok:false, state}` — like `inviteParticipant` but `state='awaiting_user'`, stores `topic`, `delivered_at=NULL`.
  - `answerParkedInvite(db, {convoId, agentDeviceId, approve, now}) -> boolean` — flips only an `awaiting_user` row: approve → `invited` (with `created_at=now`, `delivered_at` stays NULL), deny → `denied` (`answered_at=now`).
  - `markDelivered(db, {convoId, agentDeviceId, now}) -> boolean` — sets `delivered_at=now` on an `invited` row where it is NULL.
  - `undeliveredInvites(db) -> [{convo_id, agent_device_id, initiator_device_id, justification, topic, owner_user_id, room_agent_device_id}]` — every `invited AND delivered_at IS NULL` row joined to `conversations` (`owner_user_id`, `agent_device_id AS room_agent_device_id`). The pump computes the recipient: a self-initiated row (`initiator_device_id === agent_device_id`) is a join request → recipient is `room_agent_device_id`; otherwise it is an owner-invite → recipient is `agent_device_id`.
  - `awaitingCount(db, initiatorDeviceId) -> number` — `awaiting_user` rows by initiator, across all convos.
  - `listAwaiting(db, userId) -> rows` — `awaiting_user` rows joined to `conversations` (title) for the pending endpoint/CLI.
  - `expireAwaiting(db, ttlMs, now) -> [{convo_id, agent_device_id, initiator_device_id}]` — `awaiting_user` older than ttl by `created_at` → `expired`, RETURNING, mirroring `expireInvites`.
- Changes: `RENEWABLE` gains `'denied'` (a user's past no must not permanently bar a legitimate later ask — same reasoning as `'refused'`). It must **not** gain `'awaiting_user'` (a pending ask that could be renewed is a re-request loop against the user's attention). `inviteParticipant`'s upsert column list gains `topic=''`/`delivered_at=NULL` resets. `expireInvites` changes its predicate from `state='invited' AND created_at<=?` to `state='invited' AND delivered_at IS NOT NULL AND delivered_at<=?` — the 30-minute answer clock must start when the target actually received the ask, and an approved-but-undelivered invite must never expire out from under an offline target.

- [ ] **Step 1: Write the failing tests** (append to `test/participants.test.js`; follow its `db()` helper style):

```js
test('parkInvite creates awaiting_user with topic, no delivery stamp', () => {
  const d = db()
  const r = parkInvite(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'help', topic: 'ci' })
  assert.deepEqual(r, { ok: true, prior: null })
  const row = getParticipant(d, 'room', 2)
  assert.equal(row.state, 'awaiting_user')
  assert.equal(row.topic, 'ci')
  assert.equal(row.delivered_at, null)
})

test('awaiting_user is not renewable; denied is', () => {
  const d = db()
  parkInvite(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x', topic: '' })
  assert.deepEqual(parkInvite(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'y', topic: '' }),
    { ok: false, state: 'awaiting_user' })
  answerParkedInvite(d, { convoId: 'room', agentDeviceId: 2, approve: false })
  assert.equal(getParticipant(d, 'room', 2).state, 'denied')
  assert.equal(parkInvite(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'z', topic: '' }).ok, true)
})

test('approve flips to invited and restarts created_at; deny stamps answered_at', () => {
  const d = db()
  parkInvite(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x', topic: '' })
  assert.equal(answerParkedInvite(d, { convoId: 'room', agentDeviceId: 2, approve: true, now: 999 }), true)
  const row = getParticipant(d, 'room', 2)
  assert.equal(row.state, 'invited')
  assert.equal(row.created_at, 999)
  assert.equal(row.delivered_at, null)
  // answering a non-parked row is a no-op
  assert.equal(answerParkedInvite(d, { convoId: 'room', agentDeviceId: 2, approve: false }), false)
})

test('expireInvites only reaps DELIVERED invited rows, clocked by delivered_at', () => {
  const d = db()
  parkInvite(d, { convoId: 'a', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x', topic: '' })
  answerParkedInvite(d, { convoId: 'a', agentDeviceId: 2, approve: true, now: 0 })
  // undelivered and ancient: must survive
  assert.deepEqual(expireInvites(d, 1000, 1_000_000), [])
  markDelivered(d, { convoId: 'a', agentDeviceId: 2, now: 1_000_000 })
  assert.deepEqual(expireInvites(d, 1000, 1_000_500), [])            // inside window
  assert.equal(expireInvites(d, 1000, 1_002_000).length, 1)          // past window from delivered_at
})

test('expireAwaiting reaps parked rows by created_at', () => {
  const d = db()
  parkInvite(d, { convoId: 'a', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x', topic: '' })
  assert.deepEqual(expireAwaiting(d, 24 * 3600_000, Date.now()), [])
  const rows = expireAwaiting(d, 0, Date.now() + 1)
  assert.equal(rows.length, 1)
  assert.equal(getParticipant(d, 'a', 2).state, 'expired')
})

test('awaitingCount counts across convos by initiator', () => {
  const d = db()
  parkInvite(d, { convoId: 'a', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x', topic: '' })
  parkInvite(d, { convoId: 'b', agentDeviceId: 3, initiatorDeviceId: 1, justification: 'x', topic: '' })
  parkInvite(d, { convoId: 'c', agentDeviceId: 4, initiatorDeviceId: 9, justification: 'x', topic: '' })
  assert.equal(awaitingCount(d, 1), 2)
  assert.equal(awaitingCount(d, 9), 1)
})
```

Also add an `undeliveredInvites` test: create a conversation row (`upsertConversation` or raw INSERT matching how this test file seeds convos — it may need `conversations` populated for the join), park+approve one owner-invite and one self-initiated join row, assert both appear with `owner_user_id`/`room_agent_device_id` and that delivered rows drop out after `markDelivered`.

Check `expireInvites`'s current signature (`expireInvites(db, ttlMs, now = Date.now())`) and keep parameter order consistent for the new functions.

- [ ] **Step 2: Run** — `node --test test/participants.test.js` — FAIL.
- [ ] **Step 3: Implement** in `src/participants.js`. Refactor the shared upsert:

```js
function upsertRow(db, { convoId, agentDeviceId, initiatorDeviceId, state, justification, topic }) {
  const existing = db.prepare('SELECT * FROM convo_agents WHERE convo_id=? AND agent_device_id=?').get(convoId, agentDeviceId)
  if (existing && !RENEWABLE.has(existing.state)) return { ok: false, state: existing.state }
  db.prepare(`
    INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, justification, topic, created_at, answered_at, delivered_at)
    VALUES(?,?,?,?,?,?,?,NULL,NULL)
    ON CONFLICT(convo_id, agent_device_id) DO UPDATE SET
      initiator_device_id=excluded.initiator_device_id,
      state=excluded.state,
      justification=excluded.justification,
      topic=excluded.topic,
      created_at=excluded.created_at,
      answered_at=NULL,
      delivered_at=NULL
  `).run(convoId, agentDeviceId, initiatorDeviceId, state, justification, topic, Date.now())
  return { ok: true, prior: existing ?? null }
}
```

`inviteParticipant` delegates with `state:'invited', topic:''` (preserving its exact current return contract — the existing tests pin it); `parkInvite` delegates with `state:'awaiting_user'`. Then:

```js
export function answerParkedInvite(db, { convoId, agentDeviceId, approve, now = Date.now() }) {
  const r = approve
    ? db.prepare("UPDATE convo_agents SET state='invited', created_at=?, answered_at=NULL WHERE convo_id=? AND agent_device_id=? AND state='awaiting_user'").run(now, convoId, agentDeviceId)
    : db.prepare("UPDATE convo_agents SET state='denied', answered_at=? WHERE convo_id=? AND agent_device_id=? AND state='awaiting_user'").run(now, convoId, agentDeviceId)
  return r.changes === 1
}

export function markDelivered(db, { convoId, agentDeviceId, now = Date.now() }) {
  return db.prepare("UPDATE convo_agents SET delivered_at=? WHERE convo_id=? AND agent_device_id=? AND state='invited' AND delivered_at IS NULL")
    .run(now, convoId, agentDeviceId).changes === 1
}

export function undeliveredInvites(db) {
  return db.prepare(`
    SELECT ca.convo_id, ca.agent_device_id, ca.initiator_device_id, ca.justification, ca.topic,
           c.owner_user_id, c.agent_device_id AS room_agent_device_id
    FROM convo_agents ca JOIN conversations c ON c.id = ca.convo_id
    WHERE ca.state='invited' AND ca.delivered_at IS NULL
  `).all()
}

export function awaitingCount(db, initiatorDeviceId) {
  return db.prepare("SELECT COUNT(*) c FROM convo_agents WHERE state='awaiting_user' AND initiator_device_id=?").get(initiatorDeviceId).c
}

export function listAwaiting(db, userId) {
  return db.prepare(`
    SELECT ca.convo_id, ca.agent_device_id, ca.initiator_device_id, ca.justification, ca.topic, ca.created_at, c.title
    FROM convo_agents ca JOIN conversations c ON c.id = ca.convo_id
    WHERE ca.state='awaiting_user' AND c.owner_user_id=? ORDER BY ca.created_at
  `).all(userId)
}

export function expireAwaiting(db, ttlMs, now = Date.now()) {
  return db.prepare(
    "UPDATE convo_agents SET state='expired', answered_at=? WHERE state='awaiting_user' AND created_at<=? RETURNING convo_id, agent_device_id, initiator_device_id"
  ).all(now, now - ttlMs)
}
```

`RENEWABLE = new Set(['refused', 'denied', 'left', 'expired'])` with the comment extended: denied is renewable for the same reason refused is; `awaiting_user` deliberately is not (re-request loop = DoS on the user's attention). `expireInvites` predicate → `state='invited' AND delivered_at IS NOT NULL AND delivered_at<=?`.

- [ ] **Step 4: Run** — `node --test test/participants.test.js` then `npm test`. The existing `expireInvites` test may fail if it never sets `delivered_at` — update it to `markDelivered` first (that is the new contract, not a regression). PASS.
- [ ] **Step 5: Commit** — `git add src/participants.js test/participants.test.js && git commit -m "participants: awaiting_user park/answer, delivery stamps, split expiry clocks"`

---

### Task 5: Allowances

**Files:**
- Create: `src/allowances.js`
- Test: `test/allowances.test.js`

**Interfaces:**
- Consumes: `agent_chat_allowances` table (Task 1).
- Produces: `isAllowed(db, userId, fromDeviceId, targetDeviceId) -> boolean`; `addAllowance(db, {userId, fromDeviceId, targetDeviceId}) -> void` (idempotent); `removeAllowance(db, {userId, fromDeviceId, targetDeviceId}) -> boolean`; `listAllowances(db, userId) -> rows`.

Pairs are **directed**: allowing A→B says nothing about B→A. The user approved a specific asker reaching a specific target; the reverse is a different judgement.

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { isAllowed, addAllowance, removeAllowance, listAllowances } from '../src/allowances.js'

test('directed pair: A→B does not imply B→A, add is idempotent, remove reports', () => {
  const d = openDb(':memory:')
  assert.equal(isAllowed(d, 1, 2, 3), false)
  addAllowance(d, { userId: 1, fromDeviceId: 2, targetDeviceId: 3 })
  addAllowance(d, { userId: 1, fromDeviceId: 2, targetDeviceId: 3 })
  assert.equal(isAllowed(d, 1, 2, 3), true)
  assert.equal(isAllowed(d, 1, 3, 2), false)   // reverse direction
  assert.equal(isAllowed(d, 9, 2, 3), false)   // different user — cross-user isolation
  assert.equal(listAllowances(d, 1).length, 1)
  assert.equal(removeAllowance(d, { userId: 1, fromDeviceId: 2, targetDeviceId: 3 }), true)
  assert.equal(removeAllowance(d, { userId: 1, fromDeviceId: 2, targetDeviceId: 3 }), false)
})
```

(Fix the stray non-English word in the comment when copying: "different user — cross-user isolation".)

- [ ] **Step 2: Run** — FAIL (module missing).
- [ ] **Step 3: Implement** — `INSERT OR IGNORE`, `SELECT 1`, `DELETE` with `.changes`, `SELECT * ... WHERE user_id=? ORDER BY created_at`.
- [ ] **Step 4: Run** — file then `npm test`. PASS.
- [ ] **Step 5: Commit** — `git add src/allowances.js test/allowances.test.js && git commit -m "directed agent-chat allowances"`

---

### Task 6: Client-only exclusion — fan-out, replay, HTTP reads

**Files:**
- Modify: `src/ws.js` (`fanOut` ~line 427; hello replay loop ~line 294)
- Modify: `src/http.js` (`GET /convo/:id/messages` ~line 380)
- Test: `test/agent-chat-consent.test.js` (new; copy the server+ws harness pattern from the top of `test/invites.test.js` — start a server, register a client conn and an agent conn for the same user)

**Interfaces:**
- Consumes: `isClientOnlyEvent` (Task 3).
- Produces: the guarantee Tasks 7–9 build on — a client-only event reaches no agent device by any read path (live fan-out, hello replay, HTTP pagination).

Three read paths, three holes; the test must cover all three, because plugging live delivery while replay hands the card to a reconnecting agent as history is a durability bug, not a partial win.

- [ ] **Step 1: Write the failing tests**

In the harness, append a client-only event (`append(db, { userId, convoId, sender: 'probe', type: 'permission_request', payload: { kind: 'agent_chat', justification: 'SECRET' } })` via a helper, or by the ws op a later task adds — at this task, call `append` directly and trigger fan-out with the ws-layer helper if the harness exposes one; otherwise drive it end-to-end after Task 7 and mark the live-path assertion `todo` until then). Assert:

```js
// 1. live: the client socket receives the journal frame; the agent socket receives nothing
// 2. replay: agent reconnects with cursor 0 → replayed frames exclude the card; client replay includes it
// 3. http: GET /convo/:id/messages as the agent token omits the card; as the client token includes it
// and in all agent-visible frames/bodies: no 'SECRET' anywhere (assert on the raw JSON string)
```

The "no SECRET anywhere in what the agent saw" string assertion is the belt-and-braces form — it catches leak paths the shape assertions don't anticipate.

- [ ] **Step 2: Run** — FAIL (agent currently receives the frame: it manages the convo).
- [ ] **Step 3: Implement**

`src/ws.js` `fanOut` — replace the targets computation:

```js
const ownerId = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(frame.convo_id)?.agent_device_id ?? null
const targets = isClientOnlyEvent(frame.type, frame.payload)
  ? new Set()                       // empty set ≠ null: null means legacy broadcast-to-all
  : (ownerId == null ? null : new Set([ownerId, ...joinedAgentIds(db, frame.convo_id)]))
```

Hello replay loop — inside the per-event loop, before `ws.send`:

```js
if (who.kind === 'agent' && isClientOnlyEvent(e.type, e.payload)) continue
```

`src/http.js` messages route — after `messagesBefore` succeeds:

```js
let events = messagesBefore(db, who.userId, convoId, { beforeSeq, limit })
if (who.kind !== 'client') events = events.filter((e) => !isClientOnlyEvent(e.type, e.payload))
return json(res, 200, { events: events.map(toEventShape) })
```

- [ ] **Step 4: Run** — file then `npm test`. PASS.
- [ ] **Step 5: Commit** — `git add src/ws.js src/http.js test/agent-chat-consent.test.js && git commit -m "client-only events never reach agent devices: fan-out, replay, http"`

---

### Task 7: Park instead of relay — `agent_invite` / `agent_join` rewrite

**Files:**
- Modify: `src/ws.js` (`case 'agent_invite'` ~line 601, `case 'agent_join'` ~line 640)
- Test: `test/agent-chat-consent.test.js` (extend), `test/invites.test.js` (update relay expectations)

**Interfaces:**
- Consumes: `parkInvite`, `awaitingCount` (Task 4), `isAllowed` (Task 5), `sanitizePeerText` (Task 2), `appendAndFan` (existing, ws.js ~line 447), constants `AWAITING_USER_TTL_MS`, `MAX_AWAITING_PER_REQUESTER`.
- Produces: the parked flow Tasks 8–9 answer. Card payload shape (pinned here, consumed by apps later):

```js
{ kind: 'agent_chat', request: 'invite' | 'join', room_id,
  from_device_id, from_name, target_device_id, topic, justification }
```

- [ ] **Step 1: Write the failing tests** (extend `test/agent-chat-consent.test.js`):

```js
// agent_invite parks: target socket receives NO frame (the security property —
//   assert zero frames on the target's socket after a settle delay)
// requester still receives {kind:'invite', event:'delivered'} (bridge-compat ack)
// a permission_request event lands in the room convo: client sees it, agents do not
// card payload: sanitised from_name/topic/justification (feed 'evil\nname'), request:'invite'
// row state: awaiting_user with topic stored
// 4th outstanding request from one device → {op:'error'} conflict frame
// allowance path: addAllowance(user, requester, target) first → target DOES
//   receive the request frame immediately, row is invited+delivered, no card published
// agent_join symmetric: parks, card request:'join', room owner receives nothing
```

Follow `test/invites.test.js`'s existing frame-assertion helpers. `agent_invite` frames need `target_device_id`; `agent_join` needs a room owned by a different agent device.

- [ ] **Step 2: Run** — FAIL (current code relays immediately).
- [ ] **Step 3: Implement** — in `case 'agent_invite'`, keep everything up to and including the anti-enumeration target lookup, then replace the invite+send block:

```js
const topic = sanitizePeerText(msg.topic, INVITE_TOPIC_MAX_CHARS)
const justification = sanitizePeerText(msg.justification, INVITE_TEXT_MAX_CHARS)
if (isAllowed(db, conn.userId, conn.deviceId, msg.target_device_id)) {
  // User pre-approved this directed pair: the pre-consent flow, verbatim —
  // invite, immediate delivery attempt, undo+offline on a dead socket.
  const r = inviteParticipant(db, { convoId: msg.room_id, agentDeviceId: msg.target_device_id, initiatorDeviceId: conn.deviceId, justification })
  if (!r.ok) return fail('conflict', `already ${r.state}`)
  const delivered = hub.sendRpcRequest(conn.userId, msg.target_device_id, {
    kind: 'invite', event: 'request', room_id: msg.room_id,
    from_device_id: conn.deviceId, from_name: conn.name, topic, justification,
  })
  if (!delivered) { undoInvite(db, msg.room_id, msg.target_device_id, r.prior); return fail('offline') }
  markDelivered(db, { convoId: msg.room_id, agentDeviceId: msg.target_device_id })
  conn.ws.send(JSON.stringify({ kind: 'invite', event: 'delivered', room_id: msg.room_id, target_device_id: msg.target_device_id }))
  break
}
if (awaitingCount(db, conn.deviceId) >= MAX_AWAITING_PER_REQUESTER) {
  return fail('conflict', 'too many requests awaiting user approval')
}
const r = parkInvite(db, { convoId: msg.room_id, agentDeviceId: msg.target_device_id, initiatorDeviceId: conn.deviceId, justification, topic })
if (!r.ok) return fail('conflict', `already ${r.state}`)
appendAndFan({
  userId: conn.userId, convoId: msg.room_id, sender: conn.name, type: 'permission_request',
  payload: { kind: 'agent_chat', request: 'invite', room_id: msg.room_id,
    from_device_id: conn.deviceId, from_name: sanitizePeerText(conn.name, PEER_NAME_CAP),
    target_device_id: msg.target_device_id, topic, justification },
})
// Same ack as a relayed request: to the bridge, delivered means "accepted
// into the system" — its tool copy already says pending is normal and the
// answer arrives as a later turn. A distinct 'parked' event would let a
// requester distinguish gated targets from ungated ones.
conn.ws.send(JSON.stringify({ kind: 'invite', event: 'delivered', room_id: msg.room_id, target_device_id: msg.target_device_id }))
break
```

Add `const PEER_NAME_CAP = 80` beside the other invite constants. `case 'agent_join'` gets the same treatment with `request: 'join'`, `target_device_id: room.agent_device_id`, allowance check `isAllowed(db, conn.userId, conn.deviceId, room.agent_device_id)`, and the card's `from_device_id: conn.deviceId`. Note the card append happens on the room convo, which `loadRoom` already validated belongs to this user — `append()`'s own authorization check makes it a no-op risk.

Update `test/invites.test.js`: tests that asserted immediate relay now either (a) seed an allowance to keep exercising the relay path, or (b) become park-path assertions. Do not delete coverage — every existing scenario (busy ack, refuse, accept, offline undo) still exists behind the allowance path.

- [ ] **Step 4: Run** — both files, then `npm test`. PASS.
- [ ] **Step 5: Commit** — `git add src/ws.js test/agent-chat-consent.test.js test/invites.test.js && git commit -m "agent_invite/agent_join park for user consent; allowance pairs bypass"`

---

### Task 8: Delivery pump + hello hook + sweep

**Files:**
- Create: `src/invite-delivery.js`
- Modify: `src/ws.js` (hello registration path ~line 250-330; sweep timer ~line 153)
- Test: `test/agent-chat-consent.test.js` (extend), plus a direct unit test of the pump with a stub hub

**Interfaces:**
- Consumes: `undeliveredInvites`, `markDelivered`, `expireAwaiting` (Task 4).
- Produces: `deliverPendingInvites(db, hub, { deviceId = null } = {}) -> number` — scans undelivered approved invites, sends the request frame to each row's recipient, stamps `delivered_at` on success. `deviceId` narrows to one recipient (the hello hook); omitted, it tries everyone (sweep, HTTP approve, admin-approved rows).

```js
import { undeliveredInvites, markDelivered } from './participants.js'

// One delivery mechanism for approved agent-chat invites, no matter who
// approved (HTTP endpoint, matron-admin) or when the target comes online.
// Called from: http approve (immediate attempt), agent hello (catch-up for
// this device), the ws sweep timer (catch-all, e.g. admin approvals while
// the target is already connected). Exactly-once per row: markDelivered's
// delivered_at IS NULL predicate makes the stamp atomic, and sendRpcRequest
// is single-socket, so a hello racing the sweep double-sends only if both
// read NULL before either stamps — serialize by stamping FIRST and undoing
// on send failure? No: send first, stamp after, accept the benign race —
// better-sqlite3 is synchronous and single-threaded per process, so two
// pump calls cannot interleave within one server.
export function deliverPendingInvites(db, hub, { deviceId = null } = {}) {
  let sent = 0
  for (const row of undeliveredInvites(db)) {
    const isJoin = row.initiator_device_id === row.agent_device_id
    const recipient = isJoin ? row.room_agent_device_id : row.agent_device_id
    if (recipient == null) continue
    if (deviceId != null && recipient !== deviceId) continue
    const from = db.prepare('SELECT name FROM devices WHERE id=?').get(row.initiator_device_id)
    const frame = isJoin
      ? { kind: 'invite', event: 'join_request', room_id: row.convo_id,
          from_device_id: row.initiator_device_id, from_name: from?.name ?? '', justification: row.justification }
      : { kind: 'invite', event: 'request', room_id: row.convo_id,
          from_device_id: row.initiator_device_id, from_name: from?.name ?? '',
          topic: row.topic, justification: row.justification }
    if (hub.sendRpcRequest(row.owner_user_id, recipient, frame)) {
      markDelivered(db, { convoId: row.convo_id, agentDeviceId: row.agent_device_id })
      sent += 1
    }
  }
  return sent
}
```

- [ ] **Step 1: Write the failing tests**

Unit (stub hub `{ sendRpcRequest: (u, d, f) => { calls.push([u, d, f]); return online.has(d) } }`): park→approve→pump with target offline sends nothing and stamps nothing; target online sends the exact request frame (topic and justification from the stored row) and stamps; second pump call sends nothing (exactly-once); join-direction row routes to `room_agent_device_id`.

Integration (harness): park → approve via `answerParkedInvite` directly → target agent connects (hello) → target receives the `request` frame; a second reconnect receives nothing.

Sweep: park with `created_at` forced 25h old (raw UPDATE), run one sweep tick (the harness can call the sweep body or wait on a short-interval server option — check how existing tests exercise `expireInvites`, `test/invites.test.js` covers expiry today) → row `expired`, requester receives `{event:'answer', accept:false, reason:'refused'}`.

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — module above; in ws.js hello handling, after `hub.register(conn)` for `who.kind === 'agent'`, add `deliverPendingInvites(db, hub, { deviceId: conn.deviceId })`. In the sweep timer, next to the existing `expireInvites` block:

```js
deliverPendingInvites(db, hub)
for (const row of expireAwaiting(db, AWAITING_USER_TTL_MS)) {
  const convo = ownerLookup.get(row.convo_id)
  if (!convo) continue
  hub.sendToDevice(convo.owner_user_id, row.initiator_device_id, {
    kind: 'invite', event: 'answer', room_id: row.convo_id,
    peer_device_id: row.agent_device_id, accept: false, reason: 'refused',
  })
}
```

(`reason: 'refused'`, not `'expired'` — a user-side timeout must read exactly like a user deny, which reads exactly like a peer refusal.)

- [ ] **Step 4: Run** — file then `npm test`. PASS.
- [ ] **Step 5: Commit** — `git add src/invite-delivery.js src/ws.js test/agent-chat-consent.test.js && git commit -m "single delivery pump for approved invites; awaiting_user TTL sweep"`

---

### Task 9: HTTP — `/agent-chat/pending` and `/agent-chat/answer`

**Files:**
- Modify: `src/http.js` (new routes beside the other client-gated POSTs ~line 250)
- Test: `test/http.test.js` (or the consent test file if http.test.js lacks a hub — the answer route needs one; `makeHttpHandler`'s deps include `hub`, check its signature at the top of `src/http.js`)

**Interfaces:**
- Consumes: `listAwaiting`, `answerParkedInvite` (Task 4), `addAllowance` (Task 5), `deliverPendingInvites` (Task 8).
- Produces (consumed by the apps and `matron-admin` later):
  - `GET /agent-chat/pending` → `{ pending: [{ convo_id, agent_device_id, initiator_device_id, justification, topic, created_at, title }] }`
  - `POST /agent-chat/answer` `{ room_id, target_device_id, decision: 'approve'|'deny', always_allow?: boolean }` → `{ ok: true, delivered: boolean }` (approve) / `{ ok: true }` (deny)

- [ ] **Step 1: Write the failing tests**

```js
// both routes: agent token → 403 (the who.kind gate — an agent must never
//   answer, including its own request), unknown room → 404, room owned by
//   another user → 404 (anti-enumeration parity with /convo/:id/messages)
// pending: lists a parked row with title+topic; empty after answer
// answer approve (target offline): row → invited, {ok:true, delivered:false}
// answer approve (target online in hub): target receives request frame, delivered:true
// answer deny: row → denied; requester device receives answer frame reason 'refused'
// answer on a non-awaiting row → 409
// bad decision value → 400
// always_allow:true on approve records the directed pair; a following
//   agent_invite for the same pair relays immediately (integration with Task 7)
// always_allow direction for a JOIN request: from=initiator (the joiner),
//   target=room owner device — assert the pair recorded is (joiner → owner)
```

- [ ] **Step 2: Run** — FAIL (404s).
- [ ] **Step 3: Implement**

```js
if (req.method === 'GET' && url.pathname === '/agent-chat/pending') {
  if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
  return json(res, 200, { pending: listAwaiting(db, who.userId) })
}
if (req.method === 'POST' && url.pathname === '/agent-chat/answer') {
  if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
  const body = await readBody(req)
  const { room_id, target_device_id, decision, always_allow } = body
  if (decision !== 'approve' && decision !== 'deny') return json(res, 400, { error: 'bad_request' })
  if (typeof room_id !== 'string' || !Number.isInteger(target_device_id)) return json(res, 400, { error: 'bad_request' })
  const room = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(room_id)
  if (!room || room.owner_user_id !== who.userId) return json(res, 404, { error: 'not_found' })
  const row = getParticipant(db, room_id, target_device_id)
  if (!row || row.state !== 'awaiting_user') return json(res, 409, { error: 'conflict' })
  if (decision === 'deny') {
    answerParkedInvite(db, { convoId: room_id, agentDeviceId: target_device_id, approve: false })
    // Indistinguishable from a peer refusal — reason 'refused', never 'denied'.
    hub.sendToDevice(who.userId, row.initiator_device_id, {
      kind: 'invite', event: 'answer', room_id, peer_device_id: target_device_id, accept: false, reason: 'refused',
    })
    return json(res, 200, { ok: true })
  }
  answerParkedInvite(db, { convoId: room_id, agentDeviceId: target_device_id, approve: true })
  if (always_allow === true) {
    const isJoin = row.initiator_device_id === target_device_id
    addAllowance(db, { userId: who.userId, fromDeviceId: row.initiator_device_id,
      targetDeviceId: isJoin ? room.agent_device_id : target_device_id })
  }
  const delivered = deliverPendingInvites(db, hub) > 0
  return json(res, 200, { ok: true, delivered })
}
```

Imports at the top of http.js; confirm `hub` is in `makeHttpHandler`'s deps (push registration paths suggest it is — if not, thread it from `server.js` the same way `pushPipeline` is threaded).

- [ ] **Step 4: Run** — file then `npm test`. PASS.
- [ ] **Step 5: Commit** — `git add src/http.js test/http.test.js test/agent-chat-consent.test.js && git commit -m "client-gated agent-chat pending/answer endpoints"`

---

### Task 10: `matron-admin agent-chat` + docs + spec sync

**Files:**
- Modify: `bin/matron-admin.js` (USAGE + `runAdmin` dispatch)
- Modify: `docs/protocol.md` (invite section — the parked flow, the client-only card, the answer endpoints)
- Modify: `docs/superpowers/specs/2026-08-07-agent-chat-consent-design.md` (fold in the three locked decisions: room-convo card, `delivered_at` + pump, delivered-ack semantics)
- Test: `test/admin.test.js`

**Interfaces:**
- Consumes: `listAwaiting`, `answerParkedInvite` (Task 4), allowances (Task 5).
- Produces CLI (v1 approval surface until the apps grow the card UI):

```
matron-admin agent-chat pending <username>
matron-admin agent-chat approve <username> <room_id> <device_id> [--always-allow]
matron-admin agent-chat deny <username> <room_id> <device_id>
matron-admin agent-chat allowances <username> [--revoke <from_id>:<to_id>]
```

The CLI writes the DB directly (the `runAdmin(db, argv, deps)` pattern) and cannot reach the hub — an admin-approved invite is picked up by the server's sweep-tick pump within one sweep interval, and an admin deny cannot push an answer frame to the requester (its waiter simply times out to pending; the state tells the story on any later attempt). Say both in the command's output so the operator isn't left wondering.

- [ ] **Step 1: Write the failing tests** — follow `test/admin.test.js`'s existing `runAdmin` harness: seed user+devices+room+parked row, then `pending` output contains the room id and topic; `approve` flips to invited and prints the sweep-delivery note; `deny` flips to denied; `--always-allow` records the pair; `allowances --revoke 2:3` removes it; unknown username exits non-zero.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — dispatch on `a === 'agent-chat'`, resolve `username → userId` the way existing subcommands do, print one row per pending ask: `room_id  device <id> (<name>)  topic: …  justification: …  asked <relative time>`. Approve/deny call `answerParkedInvite` after verifying the row belongs to that user (join `conversations.owner_user_id` — the CLI must not skip the ownership check just because it is trusted; it takes a username precisely so the check exists). Update USAGE. Update `docs/protocol.md` and the spec.
- [ ] **Step 4: Run** — file then `npm test`. PASS.
- [ ] **Step 5: Commit** — `git add bin/matron-admin.js test/admin.test.js docs/protocol.md docs/superpowers/specs/2026-08-07-agent-chat-consent-design.md && git commit -m "matron-admin agent-chat; protocol + spec sync"`

---

## Follow-on work in other repos (not this plan)

- **matron-bridge:** drop (or reduce to a post-approval one-liner) `formatInviteRequestNotice`'s publication — the ask now reaches the user as the journal's card before the bridge ever sees the frame, so the bridge-side notice would tell the user what they just decided. Add one clause to `agent_chat_start`'s tool copy: pending may mean the user hasn't answered yet. Two-line diff + copy change; do as part of the Phase 3 deploy PR.
- **matron-apple / matron-android:** render the `kind:'agent_chat'` permission card (payload shape pinned in Task 7) with Approve / Deny / always-allow wired to `POST /agent-chat/answer`, and an allowances list in settings. Until then `matron-admin agent-chat` is the approval surface.
- **Deploy note:** this must reach dev-2 **before or with** the Phase 3 bridge deploy (task #72) — that is the entire point of the sequencing.

## Self-review notes

- Spec coverage: park-not-relay (T7), client-only card + replay durability (T3/T6), sanitisation (T2/T7), state machine + non-renewable `awaiting_user` + renewable `denied` (T4), TTL split + 24h (T4/T8), offline-at-approval hold (T4/T8), indistinguishable deny/refuse/expire (T8/T9), cap (T7), always-allow directed pairs (T5/T9), push (already wired — verified `push.js:37` classifies `permission_request` as `attention`, no change needed), anti-enumeration parity (T9 404s), bridge compat (`delivered` ack kept, T7).
- Deviation from spec (card location, delivered_at, pump) is recorded up top and folded back into the spec in T10.
- Type consistency: `parkInvite`/`answerParkedInvite`/`markDelivered`/`undeliveredInvites`/`awaitingCount`/`listAwaiting`/`expireAwaiting` named identically at definition (T4) and every use (T7/T8/T9/T10); `sanitizePeerText` (T2) used in T7; `deliverPendingInvites` (T8) used in T8/T9; card payload shape pinned once (T7) and referenced by T9/follow-on.
