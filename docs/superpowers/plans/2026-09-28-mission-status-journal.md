# Mission status (journal half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every mission a `status` (one markdown paragraph, plus who wrote it, from which conversation, and when) that `PATCH /missions/:id` sets or clears, and that every mission row returns, sieved for ordinary agents and colleagues exactly like the private conversation's milestones.

**Architecture:** Four wire columns and one internal column (`status_device_id`) are added to `missions` by a guarded `ALTER TABLE` migration in `src/db.js`. `src/missions.js` stays the pure half: `validateMissionFields` learns `status`, `updateMission` writes the columns as a set, and the existing `countsSql` / `sharedCountsSql` subquery lists gain a `status_hidden` verdict that `missionRow` turns into four nulls. `src/missions-http.js` resolves the optional `convo_id` attribution and passes `status_changed` to the existing `updated` mission marker (`src/missions-marker.js`).

**Tech Stack:** Node ≥20 ESM, better-sqlite3, `node:test` + `node:assert/strict`. Run one file with `node --test --test-timeout=30000 test/<file>.js`; the whole suite with `npm test`. No new dependencies.

**Spec:** `/Users/danbarker/Dev/matron-apple-mac-install/docs/superpowers/specs/2026-09-28-missions-dashboard-design.md`, §1 "Journal: mission status" only. §2 (bridge) and §3 (apps) are other plans.

## Global Constraints

- `status`: TEXT, "Markdown, 1–600 chars after trimming (UTF-16 length, as other limits)" — i.e. JS `.length` ≤ 600 after `.trim()`.
- `status_by`: `'user'` or `'agent'` — the caller's device kind (`who.kind === 'agent' ? 'agent' : 'user'`, the existing `byOf`).
- `status_convo_id`: "The writing agent's conversation (null for a client write)".
- `status_updated_at`: INTEGER ms epoch.
- Migration only, **no backfill**: every existing row reads all-null.
- `PATCH /missions/:id` accepts `status?: string | null` beside `title?` and `body?`. A string sets the four columns; empty after trimming or over 600 → 400 `bad_request`; control characters other than `\n`/`\t` rejected. `null` clears all four.
- `convo_id` in the PATCH body is "only honoured for agent callers and only if the conversation belongs to the caller's user; otherwise null".
- A closed mission → 409 `{blocked_by:'closed'}` (unchanged rule). A mission the caller can't see → 404 (unchanged rule). An ordinary agent may set the status of any mission it can see.
- A status-only PATCH "still bumps `updated_at` and appends the existing `mission` marker with `action: 'updated'` to the origin conversation"; the marker payload gains `status_changed: true` when the status changed.
- `GET /missions`, `GET /missions/:id`, and the `mission` object in every other response carry `status`, `status_by`, `status_convo_id`, `status_updated_at` (null when unset).
- Privacy sieve: "a status written from a private-owned conversation is withheld from ordinary agents exactly as milestone bodies are (fields returned as null). Clients always see it."
- Errors use the `src/http-who.js` responders: `badRequest` → `{error:'bad_request'}`, `notFound` → `{error:'not_found'}`, `conflict` → `{error:'conflict', blocked_by}`.
- Commits: `git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit …` (never `git config` in this worktree), message ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Do not deploy.** The implementer opens the PR and stops. Deployment to services-1 is a separate, later step (Rollout 1 in the spec) that Dan schedules; the bridge and apps depend on it landing first.

## Where the spec did not fit the code (decisions this plan makes)

1. **The sieve needs the writing device, not only the conversation.** Milestones are sieved by their conversation's `agent_device_id` being private. A status can be written with no `convo_id` (clients always, agents optionally), so a private agent that omits `convo_id` would store `status_convo_id = null` and leak past a conversation-only sieve. The plan stores a fifth, internal column `status_device_id` (stripped from the wire like `idem_key`) and withholds a status when the writing device is private **or** `status_convo_id` is private-owned.
2. **"Rejected as for item titles" does not exist.** Item titles only trim; control characters are refused only for item action labels (`ACTION_BAD_CHARS` in `src/items.js`) and memory descriptions. The status uses that same set minus `\n` and `\t`: `/[\u0000-\u0008\u000b-\u001f\u007f-\u009f  ]/`. A CRLF from a client text view is folded to `\n` first, so only a lone `\r` is refused.
3. **The marker already exists on a status-only PATCH.** `handlePatch` always appends `updated` to `origin_convo_id` and `updateMission` always bumps `updated_at`; the only change is the new `status_changed` flag. It is set whenever the PATCH carried `status` (set, same-text refresh, or clear), because `status_updated_at` / the clear is itself a change the apps render ("Updated 12m ago"). A title/body-only PATCH never carries it.
4. **Ordinary agents naming a private-owned `convo_id`.** Ownership alone would let an ordinary agent file its own status under a private conversation (hiding it from its peers, and confirming the id exists). For a filtered agent a private-owned `convo_id` records null, like any other unhonoured value. A non-string `convo_id` also records null — attribution is never a 400.
5. **Colleagues (shared missions) already receive `m.*`.** The spec leaves colleagues out of scope for the dashboard, but `listSharedMissions` / `getSharedMission` select `m.*`, so the new columns would reach them unsieved. The plan sieves them: a colleague sees the status only when it was written with no conversation by a non-private device (a client — like the title and body) or from a conversation that passes `sharedConvoSql` for them; otherwise four nulls.
6. **`status` on `POST /missions`** is ignored (not validated, not stored) — only PATCH writes it.
7. **Sieve granularity.** Milestones from a private conversation are *omitted* from arrays; a status cannot be omitted from a row, so its four fields read null — as the spec says. The rest of the row (title, counts) is untouched.

## Review Focus

1. **A private agent writes a status without `convo_id`** (or naming a public conversation): a reasonable person expects it still hidden from ordinary agents — pinned in Task 3 pure test (`[null, 9]`, `['c1', 9]` rows) and route test ("No convo_id from the private device").
2. **An ordinary agent passes a private-owned conversation as `convo_id`**: expected recorded as null, its status stays visible to its peers — Task 2 test "convo_id is recorded only for …" (`secret` case).
3. **A client text view sends CRLF line endings**: expected accepted with `\n`, not 400 — Task 1 validation test (`'one\r\ntwo'`) and Task 2 route test (`'Done:\r\n\t- migration'`).
4. **A colleague reads a shared mission whose status came from a conversation they cannot read**: expected four nulls, while the owner sees it — Task 3 shared test.
5. **Status PATCH on a closed mission, or with a bad status**: expected 409/400 with nothing written — no marker, `status_updated_at` unchanged — Task 2 validation test (`stamp` and `markersBefore` assertions).

---

## File Structure

- Modify `src/db.js` — guarded `ALTER TABLE missions ADD COLUMN` block for the five status columns (after the item action columns block, currently lines 596–602).
- Modify `src/missions.js` — `STATUS_MAX`, status validation in `validateMissionFields`, `statusWriter` in `updateMission`, `status_device_id` / `status_hidden` stripping and the null-out in `missionRow`, the `STATUS_PRIVATE` predicate and `status_hidden` in `countsSql` and `sharedCountsSql`.
- Modify `src/missions-marker.js` — `statusChanged` option on `missionMarkerPayload`.
- Modify `src/missions-http.js` — `statusConvoOf`, `handlePatch` passes the writer and `statusChanged`, `emitMissionMarker` forwards it.
- Modify `docs/protocol.md` — Missions: routes table, new *Status* subsection, row shapes, marker events, visibility.
- Modify `src/help.js` — the `PATCH /missions/:id` bullet.
- Tests: `test/missions.test.js` (pure), `test/missions-http.test.js` (routes), `test/help.test.js`.

---

### Task 1: Storage, validation and `updateMission`

**Files:**
- Modify: `src/db.js:596-602` (add a block right after the `chosen_action` ALTER, before the `DROP TABLE IF EXISTS agent_chat_allowances` comment)
- Modify: `src/missions.js:16-29` (`missionRow`), `src/missions.js:11-12` (constants), `src/missions.js:40-54` (`validateMissionFields`), `src/missions.js:205-217` (`updateMission`)
- Test: `test/missions.test.js:19-38` (schema test), new tests appended at the end of the file

**Interfaces:**
- Produces: `STATUS_MAX = 600` (exported from `src/missions.js`); `validateMissionFields(body, { partial: true })` → `value.status: string | null` when present (ignored when `partial` is false); `updateMission(db, { userId, missionId, fields, statusWriter = null, excludePrivateOwned = false })` where `statusWriter = { by: 'user'|'agent', convoId: string|null, deviceId: number }` is required when `fields.status` is a string (throws `Error('status_writer_required')` otherwise). Every mission row returned by `getMission` / `listMissions` / `missionDetail` / `createMission` / `closeMission` / `joinMission` now includes `status`, `status_by`, `status_convo_id`, `status_updated_at` and never `status_device_id`.

- [ ] **Step 0: Install dependencies (fresh worktree has no `node_modules`)**

Run: `cd /Users/danbarker/Dev/matron-journal-mission-status && npm ci`
Then: `node --test --test-timeout=30000 test/missions.test.js 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# pass 30` and `# fail 0`.

- [ ] **Step 1: Write the failing tests**

In `test/missions.test.js`, extend the expected `missions` column list in the first schema test (lines 21–24) so it reads:

```js
  assert.deepEqual(cols('missions'), [
    'id', 'user_id', 'num', 'state', 'title', 'body', 'close_summary', 'closed_by', 'closed_over_open_items',
    'origin_convo_id', 'origin_device_id', 'created_by', 'idem_key', 'created_at', 'updated_at', 'last_milestone_at', 'closed_at',
    'status', 'status_by', 'status_convo_id', 'status_updated_at', 'status_device_id',
  ])
```

Add `STATUS_MAX` to the `../src/missions.js` import (lines 12–15):

```js
import {
  createMission, getMission, listMissions, missionDetail, updateMission, joinMission, closeMission, repointItems, validateMissionFields,
  createMilestone, listMilestones, CONVOS_MAX, STATUS_MAX,
} from '../src/missions.js'
```

Append these tests at the end of the file:

```js
// Spec 2026-09-28 missions dashboard §1 — mission status.
const STATUS_FIELDS = ['status', 'status_by', 'status_convo_id', 'status_updated_at']

test('schema: an existing database gains the mission status columns once, all NULL on old rows', () => {
  const dbPath = path.join(os.tmpdir(), `mission-status-migration-${process.pid}-${Date.now()}.sqlite`)
  const cols = [...STATUS_FIELDS, 'status_device_id']
  try {
    const db1 = openDb(dbPath)
    db1.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
    db1.prepare(`INSERT INTO missions(id,user_id,num,state,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at)
      VALUES('ms_old',1,1,'open','t','c1',1,'agent',0,0)`).run()
    db1.close()
    // Simulate the pre-status shape on a raw handle.
    const raw = new Database(dbPath)
    for (const c of cols) raw.exec(`ALTER TABLE missions DROP COLUMN ${c}`)
    raw.close()

    const db2 = openDb(dbPath)
    const names = () => db2.prepare('PRAGMA table_info(missions)').all().map((c) => c.name)
    for (const c of cols) assert.ok(names().includes(c), c)
    const old = db2.prepare('SELECT * FROM missions WHERE id=?').get('ms_old')
    for (const c of cols) assert.equal(old[c], null, c)
    const after = names()
    db2.close()

    const db3 = openDb(dbPath)
    assert.deepEqual(db3.prepare('PRAGMA table_info(missions)').all().map((c) => c.name), after)
    assert.throws(() => db3.prepare("UPDATE missions SET status_by='robot' WHERE id='ms_old'").run(), /CHECK/)
    db3.close()
  } finally {
    fs.rmSync(dbPath, { force: true })
    fs.rmSync(`${dbPath}-wal`, { force: true })
    fs.rmSync(`${dbPath}-shm`, { force: true })
  }
})

test('validateMissionFields: status is PATCH-only, trimmed, 1–600 UTF-16 units, \\n and \\t allowed, other controls refused, null clears', () => {
  const p = (status) => validateMissionFields({ status }, { partial: true })
  assert.equal(STATUS_MAX, 600)
  assert.deepEqual(p('  Blocked on review.  ').value, { status: 'Blocked on review.' })
  assert.deepEqual(p(null).value, { status: null })
  assert.deepEqual(p('Done:\n\t- migration').value, { status: 'Done:\n\t- migration' })
  assert.deepEqual(p('one\r\ntwo').value, { status: 'one\ntwo' })
  assert.equal(p('').ok, false)
  assert.equal(p('   \n\t ').ok, false)
  assert.equal(p('x'.repeat(600)).ok, true)
  assert.equal(p('x'.repeat(601)).ok, false)
  assert.equal(p(`  ${'x'.repeat(600)}  `).ok, true, 'the limit applies after trimming')
  assert.equal(p('😀'.repeat(300)).ok, true, '600 UTF-16 code units')
  assert.equal(p('😀'.repeat(300) + 'x').ok, false)
  for (const bad of ['a\u0000b', 'a\u0007b', 'a\rb', 'a\u000bb', 'a\u001bb', 'a\u007fb', 'a\u0085b', 'a b', 'a b']) {
    assert.equal(p(bad).ok, false, JSON.stringify(bad))
  }
  for (const bad of [42, true, {}, []]) assert.equal(p(bad).ok, false, JSON.stringify(bad))
  assert.deepEqual(validateMissionFields({ title: ' T ', status: 'S' }, { partial: true }).value, { title: 'T', status: 'S' })
  assert.equal('status' in validateMissionFields({ title: 'T', status: 'ignored on create' }).value, false)
})

test('updateMission: status sets, overwrites and clears all four columns together; title-only leaves it; a string needs a writer; closed refuses', () => {
  const db = seeded()
  const m = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'M' }).mission
  for (const k of STATUS_FIELDS) assert.equal(m[k], null, k)
  assert.equal('status_device_id' in m, false)

  const set = updateMission(db, { userId: 1, missionId: m.id, fields: { status: 'Wiring the migration' }, statusWriter: { by: 'agent', convoId: 'c1', deviceId: 7 } })
  assert.equal(set.status, 'Wiring the migration'); assert.equal(set.status_by, 'agent'); assert.equal(set.status_convo_id, 'c1')
  assert.equal(typeof set.status_updated_at, 'number'); assert.equal(set.updated_at, set.status_updated_at)
  assert.equal(set.title, 'M')
  assert.equal('status_device_id' in set, false)
  assert.equal(db.prepare('SELECT status_device_id FROM missions WHERE id=?').get(m.id).status_device_id, 7)

  const over = updateMission(db, { userId: 1, missionId: m.id, fields: { status: 'Waiting on Dan' }, statusWriter: { by: 'user', convoId: null, deviceId: 7 } })
  assert.equal(over.status, 'Waiting on Dan'); assert.equal(over.status_by, 'user'); assert.equal(over.status_convo_id, null)

  const renamed = updateMission(db, { userId: 1, missionId: m.id, fields: { title: 'Renamed' } })
  assert.equal(renamed.status, 'Waiting on Dan'); assert.equal(renamed.status_updated_at, over.status_updated_at)
  assert.equal(getMission(db, 1, m.id).status, 'Waiting on Dan')
  assert.equal(listMissions(db, 1).find((x) => x.id === m.id).status, 'Waiting on Dan')
  assert.equal(missionDetail(db, 1, m.id).mission.status, 'Waiting on Dan')

  assert.throws(() => updateMission(db, { userId: 1, missionId: m.id, fields: { status: 'no writer' } }), /status_writer_required/)
  assert.equal(getMission(db, 1, m.id).status, 'Waiting on Dan')

  const cleared = updateMission(db, { userId: 1, missionId: m.id, fields: { status: null } })
  for (const k of STATUS_FIELDS) assert.equal(cleared[k], null, k)
  assert.equal(db.prepare('SELECT status_device_id FROM missions WHERE id=?').get(m.id).status_device_id, null)

  closeMission(db, { userId: 1, missionId: m.id, by: 'user', summary: 's' })
  assert.throws(() => updateMission(db, { userId: 1, missionId: m.id, fields: { status: 'late' }, statusWriter: { by: 'user', convoId: null, deviceId: 7 } }), /closed/)
  assert.equal(getMission(db, 1, m.id).status, null)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=30000 test/missions.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: 4 failures — `schema: missions and milestones exist…` (column list), `schema: an existing database gains the mission status columns…` (`no such column: status`), `validateMissionFields: status is PATCH-only…` (`STATUS_MAX` is `undefined`), `updateMission: status sets…`; `# pass 29`, `# fail 4`.

- [ ] **Step 3: Add the migration to `src/db.js`**

Insert right after the `chosen_action` block (after current line 602, before the `// Standing agent-chat consent` comment):

```js
  // Mission status (spec 2026-09-28 missions dashboard §1): one short
  // markdown paragraph agents keep current — who wrote it (status_by), from
  // which conversation (status_convo_id), and when. status_device_id is
  // internal and never on the wire: the privacy sieve keys on the WRITING
  // DEVICE as well as the conversation, so a private agent that names no
  // conversation is still withheld from ordinary agents. No backfill —
  // every existing row reads all NULL.
  const missionStatusCols = db.prepare('PRAGMA table_info(missions)').all()
  const addMissionCol = (name, ddl) => {
    if (!missionStatusCols.some((c) => c.name === name)) db.exec(`ALTER TABLE missions ADD COLUMN ${ddl}`)
  }
  addMissionCol('status', 'status TEXT')
  addMissionCol('status_by', "status_by TEXT CHECK(status_by IN ('user','agent'))")
  addMissionCol('status_convo_id', 'status_convo_id TEXT')
  addMissionCol('status_updated_at', 'status_updated_at INTEGER')
  addMissionCol('status_device_id', 'status_device_id INTEGER')
```

- [ ] **Step 4: Update `src/missions.js`**

After `export const CONVOS_MAX = 200` (line 12) add:

```js
export const STATUS_MAX = 600
// Status (spec 2026-09-28 missions dashboard §1) is markdown, so \n and \t
// stay; every other C0/C1 control and U+2028/2029 is refused — the set
// items' action labels refuse (ACTION_BAD_CHARS), minus the two a
// paragraph needs. CRLF is folded to \n before this runs, so only a LONE
// \r is refused.
const STATUS_BAD_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f  ]/
```

Replace `missionRow` (lines 16–29) with:

```js
// idem_key is internal (same stance as rowToItem). `sieved_last_milestone_at`
// (fix round 3, B2) is a sort key countsSql computes for listMissions' ORDER
// BY — never part of the wire shape. `status_device_id` (spec 2026-09-28
// missions dashboard §1) is internal too: the device that wrote the status,
// kept only so the privacy sieve can key on it.
export function missionRow(row) {
  if (!row) return null
  const { idem_key: _idemKey, sieved_last_milestone_at: _sievedLastMilestoneAt, status_device_id: _statusDeviceId, ...rest } = row
  const out = { ...rest, closed_over_open_items: Number(rest.closed_over_open_items || 0) }
  for (const k of ['open_items', 'needs_you', 'conversations', 'milestones']) if (k in out) out[k] = Number(out[k])
  if ('last_milestone_json' in out) {
    out.last_milestone = out.last_milestone_json ? JSON.parse(out.last_milestone_json) : null
    delete out.last_milestone_json
  }
  return out
}
```

Replace `validateMissionFields` (lines 40–54) with:

```js
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
  // PATCH only: POST /missions ignores a status rather than storing one.
  // null is the explicit clear; a string is trimmed, then 1–STATUS_MAX
  // UTF-16 code units (JS .length, like TITLE_MAX).
  if (partial && body.status !== undefined) {
    if (body.status === null) value.status = null
    else {
      if (typeof body.status !== 'string') return { ok: false }
      const s = body.status.replace(/\r\n/g, '\n').trim()
      if (!s || s.length > STATUS_MAX || STATUS_BAD_CHARS.test(s)) return { ok: false }
      value.status = s
    }
  }
  return { ok: true, value }
}
```

Replace `updateMission` (lines 205–217) with:

```js
// `statusWriter` {by, convoId, deviceId} (spec 2026-09-28 missions dashboard
// §1) is required whenever fields.status is a string: the status columns are
// always written as one set, never one of them alone, with the same `ts` as
// updated_at. A null status clears all of them, status_device_id included.
export function updateMission(db, { userId, missionId, fields, statusWriter = null, excludePrivateOwned = false }) {
  return db.transaction(() => {
    const cur = db.prepare('SELECT state FROM missions WHERE id=? AND user_id=?').get(missionId, userId)
    if (!cur) return null
    if (cur.state === 'closed') throw new Error('closed')
    const ts = now()
    const sets = []; const args = []
    if (fields.title !== undefined) { sets.push('title=?'); args.push(fields.title) }
    if (fields.body !== undefined) { sets.push('body=?'); args.push(fields.body) }
    if (fields.status !== undefined) {
      if (fields.status !== null && !statusWriter) throw new Error('status_writer_required')
      const w = fields.status === null ? { by: null, convoId: null, deviceId: null } : statusWriter
      sets.push('status=?', 'status_by=?', 'status_convo_id=?', 'status_device_id=?', 'status_updated_at=?')
      args.push(fields.status, w.by, w.convoId ?? null, w.deviceId ?? null, fields.status === null ? null : ts)
    }
    sets.push('updated_at=?'); args.push(ts)
    db.prepare(`UPDATE missions SET ${sets.join(', ')} WHERE id=? AND user_id=?`).run(...args, missionId, userId)
    return getMission(db, userId, missionId, { excludePrivateOwned })
  })()
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test --test-timeout=30000 test/missions.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# pass 33`, `# fail 0` (30 existing + 3 new; the schema test now passes too).

Run: `node --test --test-timeout=30000 test/missions-http.test.js 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# pass 30`, `# fail 0` (nothing regressed).

- [ ] **Step 6: Commit**

```bash
cd /Users/danbarker/Dev/matron-journal-mission-status
git add src/db.js src/missions.js test/missions.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -F - <<'EOF'
missions: status columns, validation and updateMission writes them as one set

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: `PATCH /missions/:id {status, convo_id}` and `status_changed` on the marker

**Files:**
- Modify: `src/missions-marker.js:33-44` (`missionMarkerPayload`)
- Modify: `src/missions-http.js:17` (import), `src/missions-http.js:58-68` (`emitMissionMarker`), `src/missions-http.js:129-142` (`handlePatch`, plus the new `statusConvoOf` directly above it)
- Test: `test/missions.test.js` (append), `test/missions-http.test.js` (append)

**Interfaces:**
- Consumes: `validateMissionFields(body, { partial: true })` → `value.status`; `updateMission(db, { …, statusWriter })` from Task 1.
- Produces: `missionMarkerPayload({ mission, action, by, openItemNums = null, withTitle = true, statusChanged = false })` → adds `status_changed: true` only when `statusChanged` is true. `emitMissionMarker(ctx, who, { mission, action, convoId, openItemNums = null, statusChanged = false })`. HTTP: `PATCH /missions/:id` body `{title?, body?, status?: string|null, convo_id?: string}`.

- [ ] **Step 1: Write the failing tests**

Append to `test/missions.test.js`:

```js
test('missionMarkerPayload: status_changed appears only when statusChanged is true, and never carries the status text', () => {
  const mission = { id: 'ms_1', num: 61, title: 'M', status: 'secret words' }
  assert.deepEqual(missionMarkerPayload({ mission, action: 'updated', by: 'agent', statusChanged: true }),
    { mission_id: 'ms_1', num: 61, title: 'M', action: 'updated', by: 'agent', status_changed: true })
  assert.equal('status_changed' in missionMarkerPayload({ mission, action: 'updated', by: 'agent' }), false)
  assert.equal('status_changed' in missionMarkerPayload({ mission, action: 'updated', by: 'agent', statusChanged: false }), false)
  assert.deepEqual(missionMarkerPayload({ mission, action: 'updated', by: 'user', statusChanged: true, withTitle: false }),
    { mission_id: 'ms_1', num: 61, action: 'updated', by: 'user', status_changed: true })
})
```

Append to `test/missions-http.test.js`:

```js
// Spec 2026-09-28 missions dashboard §1 — mission status.
const STATUS_FIELDS = ['status', 'status_by', 'status_convo_id', 'status_updated_at']
const patch = (s, token, id, body) => s.http(`/missions/${id}`, { method: 'PATCH', token, body })
const updatedMarkers = (s) => s.db.prepare(
  "SELECT convo_id, payload FROM events WHERE type='mission' AND json_extract(payload,'$.action')='updated' ORDER BY seq",
).all().map((r) => ({ convo_id: r.convo_id, ...JSON.parse(r.payload) }))

test('PATCH /missions/:id {status}: set, overwrite, clear; status_by follows the caller; GET list and detail carry the four fields; every status write marks status_changed', async (t) => {
  const { s, agent, client } = await fleet(t)
  const m = (await start(s, agent.token, {})).json.mission
  for (const k of STATUS_FIELDS) assert.equal(m[k], null, k)
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const before = Date.now()
  const set = await patch(s, agent.token, m.id, { status: '  Migration done; routes next.  ', convo_id: 'c1' })
  assert.equal(set.status, 200)
  assert.equal(set.json.mission.status, 'Migration done; routes next.')
  assert.equal(set.json.mission.status_by, 'agent'); assert.equal(set.json.mission.status_convo_id, 'c1')
  assert.ok(set.json.mission.status_updated_at >= before)
  assert.equal(set.json.mission.updated_at, set.json.mission.status_updated_at)
  assert.equal(set.json.mission.title, 'Missions'); assert.equal(set.json.mission.body, 'goal')
  assert.equal('status_device_id' in set.json.mission, false)
  const live = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.payload.action === 'updated')
  assert.equal(live.convo_id, 'c1'); assert.equal(live.payload.status_changed, true); assert.equal(live.payload.by, 'agent')
  assert.equal('status' in live.payload, false)
  ws.close()

  const listed = (await s.http('/missions', { token: client })).json.missions.find((x) => x.id === m.id)
  const detail = (await s.http(`/missions/${m.num}`, { token: agent.token })).json.mission
  for (const row of [listed, detail]) {
    assert.equal(row.status, 'Migration done; routes next.'); assert.equal(row.status_by, 'agent')
    assert.equal(row.status_convo_id, 'c1'); assert.equal(row.status_updated_at, set.json.mission.status_updated_at)
    assert.equal('status_device_id' in row, false)
  }

  const over = await patch(s, client, m.id, { status: 'Waiting on Dan', convo_id: 'c1' })
  assert.equal(over.status, 200)
  assert.equal(over.json.mission.status, 'Waiting on Dan'); assert.equal(over.json.mission.status_by, 'user')
  assert.equal(over.json.mission.status_convo_id, null, 'convo_id is honoured for agents only')
  const renamed = await patch(s, agent.token, m.id, { title: 'Renamed' })
  assert.equal(renamed.json.mission.status, 'Waiting on Dan')
  const cleared = await patch(s, agent.token, m.id, { status: null })
  assert.equal(cleared.status, 200)
  for (const k of STATUS_FIELDS) assert.equal(cleared.json.mission[k], null, k)

  assert.deepEqual(updatedMarkers(s).map((p) => [p.convo_id, p.by, p.status_changed ?? false]), [
    ['c1', 'agent', true], ['c1', 'user', true], ['c1', 'agent', false], ['c1', 'agent', true],
  ])
  const since = (await s.http(`/missions?since=${cleared.json.mission.updated_at}`, { token: client })).json.missions
  assert.deepEqual(since.map((x) => x.id), [m.id])
})

test('PATCH /missions/:id {status}: 400 on empty, whitespace, over 600, control characters and non-strings with nothing written; CRLF folds; 409 closed; 404 invisible', async (t) => {
  const { s, dan, agent, patAgent, client } = await fleet(t)
  const m = (await start(s, agent.token, {})).json.mission
  const markersBefore = updatedMarkers(s).length
  for (const status of ['', '   ', '\n\t', 'x'.repeat(601), '😀'.repeat(300) + 'x', 'a\u0007b', 'a\rb', 'a b', 42, false, {}, []]) {
    const r = await patch(s, agent.token, m.id, { status })
    assert.equal(r.status, 400, JSON.stringify(status)); assert.equal(r.json.error, 'bad_request')
  }
  assert.equal(updatedMarkers(s).length, markersBefore)
  assert.equal(s.db.prepare('SELECT status FROM missions WHERE id=?').get(m.id).status, null)
  assert.equal((await patch(s, agent.token, m.id, { convo_id: 'c1' })).status, 400, 'convo_id alone is not an update')
  assert.equal((await patch(s, agent.token, m.id, { status: 'x'.repeat(600) })).status, 200)
  assert.equal((await patch(s, agent.token, m.id, { status: '😀'.repeat(300) })).status, 200)
  const crlf = await patch(s, client, m.id, { status: 'Done:\r\n\t- migration' })
  assert.equal(crlf.status, 200); assert.equal(crlf.json.mission.status, 'Done:\n\t- migration')

  assert.equal((await patch(s, patAgent.token, m.id, { status: 'foreign' })).status, 404)
  assert.equal((await patch(s, agent.token, 'ms_nope', { status: 'x' })).status, 404)
  assert.equal((await s.http(`/missions/${m.id}`, { method: 'PATCH', body: { status: 'x' } })).status, 401)
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret', ownerUserId: dan.id, title: 'S', agentDeviceId: priv.deviceId })
  const hidden = (await start(s, priv.token, { convo_id: 'secret', title: 'Hidden' })).json.mission
  assert.equal((await patch(s, agent.token, hidden.id, { status: 'peek' })).status, 404)
  assert.equal((await patch(s, agent.token, hidden.num, { status: 'peek' })).status, 404)
  assert.equal(s.db.prepare('SELECT status FROM missions WHERE id=?').get(hidden.id).status, null)

  await s.http(`/missions/${m.id}/close`, { method: 'POST', token: client, body: { summary: 'done' } })
  const stamp = s.db.prepare('SELECT status, status_updated_at FROM missions WHERE id=?').get(m.id)
  const markersAtClose = updatedMarkers(s).length
  const late = await patch(s, agent.token, m.id, { status: 'too late' })
  assert.equal(late.status, 409); assert.equal(late.json.blocked_by, 'closed')
  assert.equal((await patch(s, client, m.id, { status: null })).status, 409)
  assert.deepEqual(s.db.prepare('SELECT status, status_updated_at FROM missions WHERE id=?').get(m.id), stamp)
  assert.equal(updatedMarkers(s).length, markersAtClose)
})

test('PATCH /missions/:id {status, convo_id}: convo_id is recorded only for an agent naming a conversation of its own user (never a private-owned one for an ordinary agent); anything else records null', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const m = (await start(s, agent.token, {})).json.mission
  const convoOf = async (token, convoId) => {
    const r = await patch(s, token, m.id, { status: `from ${convoId}`, convo_id: convoId })
    assert.equal(r.status, 200)
    return r.json.mission.status_convo_id
  }
  assert.equal(await convoOf(agent.token, 'c2'), 'c2', 'any conversation of the same user — the Coordinator writes from its own')
  assert.equal(await convoOf(agent.token, 'p1'), null, "another user's conversation")
  assert.equal(await convoOf(agent.token, 'nope'), null)
  assert.equal(await convoOf(agent.token, 42), null)
  assert.equal(await convoOf(agent.token, undefined), null)
  assert.equal(await convoOf(client, 'c1'), null, 'a client write never carries a conversation')
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret', ownerUserId: dan.id, title: 'S', agentDeviceId: priv.deviceId })
  assert.equal(await convoOf(agent.token, 'secret'), null, 'an ordinary agent never files its status under a private-owned conversation')
  assert.equal(await convoOf(priv.token, 'secret'), 'secret')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=30000 test/missions.test.js test/missions-http.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: 4 failures — the marker payload test (`status_changed` missing), the set/overwrite/clear test (`status_by` is `undefined` → the route passes no writer, so `updateMission` throws `status_writer_required` and the PATCH is a 500), the validation test (same 500 on the first valid status), the convo_id test (500); `# fail 4`.

- [ ] **Step 3: Implement the marker flag**

In `src/missions-marker.js` replace `missionMarkerPayload` (lines 33–44) with:

```js
// Apps use this only as an invalidation signal plus a one-line notice.
// open_item_nums is present only on a user-forced close over open items.
// status_changed (spec 2026-09-28 missions dashboard §1) is present only on
// an `updated` whose PATCH carried `status` — a flag, never the text: the
// marker is replayed verbatim to every agent on the origin conversation,
// and the status may be one an ordinary agent must not read.
export function missionMarkerPayload({ mission, action, by, openItemNums = null, withTitle = true, statusChanged = false }) {
  if (!MISSION_ACTIONS.includes(action)) throw new Error(`unknown mission action: ${action}`)
  const out = {
    mission_id: mission.id, num: mission.num,
    ...(withTitle ? { title: mission.title } : {}),
    action, by,
  }
  if (openItemNums && openItemNums.length) out.open_item_nums = openItemNums
  if (statusChanged) out.status_changed = true
  return out
}
```

- [ ] **Step 4: Implement the route**

In `src/missions-http.js` line 17, the import already has `filteredAgent, privateOwnedConvo, markerTitleAllowed` — no change needed.

Replace `emitMissionMarker` (lines 58–68) with:

```js
function emitMissionMarker({ db, hub }, who, { mission, action, convoId, openItemNums = null, statusChanged = false }) {
  const payload = missionMarkerPayload({
    mission, action, by: byOf(who), openItemNums, statusChanged,
    withTitle: markerTitleAllowed(db, mission.origin_convo_id, convoId),
  })
  try {
    appendAndBroadcast(db, hub, { userId: who.userId, convoId, sender: senderOf(db, who), type: MISSION_EVENT_TYPE, payload })
  } catch (err) {
    console.error('missions: marker append failed (mission write already committed)', err)
  }
}
```

Replace `handlePatch` (lines 129–142) with:

```js
// Spec 2026-09-28 missions dashboard §1: `convo_id` on a status PATCH is
// attribution — the writing agent's conversation — never a gate. Honoured
// only for an agent, only for a conversation of the caller's own user, and
// for an ordinary agent never a private-owned one (that would file its own
// status behind the sieve, and confirm the id exists). Anything else —
// a client, a foreign or unknown id, a non-string — records null; never a 400.
function statusConvoOf(db, who, convoId) {
  if (who.kind !== 'agent' || typeof convoId !== 'string' || !convoId) return null
  const convo = db.prepare('SELECT owner_user_id FROM conversations WHERE id=?').get(convoId)
  if (!convo || convo.owner_user_id !== who.userId) return null
  if (filteredAgent(db, who) && privateOwnedConvo(db, convoId)) return null
  return convoId
}

async function handlePatch(ctx, req, res, who, mission) {
  const { db } = ctx
  const body = await readBody(req)
  const v = validateMissionFields(body, { partial: true })
  if (!v.ok || Object.keys(v.value).length === 0) return badRequest(res)
  const statusWriter = typeof v.value.status === 'string'
    ? { by: byOf(who), convoId: statusConvoOf(db, who, body.convo_id), deviceId: who.deviceId }
    : null
  let updated
  try {
    updated = updateMission(db, { userId: who.userId, missionId: mission.id, fields: v.value, statusWriter, excludePrivateOwned: filteredAgent(db, who) })
  } catch (err) { if (err.message === 'closed') return conflict(res, { blocked_by: 'closed' }); throw err }
  if (!updated) return notFound(res)
  emitMissionMarker(ctx, who, { mission: updated, action: 'updated', convoId: updated.origin_convo_id, statusChanged: v.value.status !== undefined })
  json(res, 200, { mission: updated })
  return true
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test --test-timeout=30000 test/missions.test.js test/missions-http.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# pass 67`, `# fail 0` (34 + 33).

- [ ] **Step 6: Commit**

```bash
cd /Users/danbarker/Dev/matron-journal-mission-status
git add src/missions-marker.js src/missions-http.js test/missions.test.js test/missions-http.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -F - <<'EOF'
missions: PATCH /missions/:id sets and clears the status; the updated marker says status_changed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: The privacy sieve — ordinary agents and colleagues

**Files:**
- Modify: `src/missions.js` — `missionRow` (null-out), a new `STATUS_PRIVATE` constant directly above `countsSql` (currently line 56), `countsSql` (lines 64–84), `sharedCountsSql` (lines 374–390)
- Test: `test/missions.test.js` (append), `test/missions-http.test.js` (append)

**Interfaces:**
- Consumes: the status columns and `updateMission({ statusWriter })` from Task 1; `PATCH /missions/:id {status, convo_id}` from Task 2.
- Produces: every row from `getMission` / `listMissions` / `missionDetail` (with `excludePrivateOwned: true`) and from `listSharedMissions` / `getSharedMission` returns the four status fields as `null` when withheld. `status_hidden` is an internal select column, never on the wire.

- [ ] **Step 1: Write the failing tests**

Append to `test/missions.test.js`:

```js
test('mission status sieve: withheld from a filtered reader when written from a private-owned conversation or by a private device; the unfiltered reader always sees it', () => {
  const db = seeded()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(9,1,'agent','priv-box','h2',0,1)").run()
  upsertConversation(db, { id: 'c3', ownerUserId: 1, title: 'C3', agentDeviceId: 9 })
  const m = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'Pub' }).mission
  const rows = (excludePrivateOwned) => [
    getMission(db, 1, m.id, { excludePrivateOwned }),
    listMissions(db, 1, { excludePrivateOwned }).find((x) => x.id === m.id),
    missionDetail(db, 1, m.id, { excludePrivateOwned }).mission,
  ]
  for (const [convoId, deviceId, withheld] of [
    ['c1', 7, false], [null, 7, false], ['c3', 9, true], [null, 9, true], ['c1', 9, true], ['c3', 7, true],
  ]) {
    const text = `by ${deviceId} in ${convoId}`
    updateMission(db, { userId: 1, missionId: m.id, fields: { status: text }, statusWriter: { by: 'agent', convoId, deviceId } })
    for (const row of rows(true)) {
      if (withheld) for (const k of STATUS_FIELDS) assert.equal(row[k], null, `${text}: ${k}`)
      else assert.equal(row.status, text)
      assert.equal(row.title, 'Pub', 'only the status is withheld')
      assert.equal('status_hidden' in row, false); assert.equal('status_device_id' in row, false)
    }
    for (const row of rows(false)) {
      assert.equal(row.status, text); assert.equal(row.status_convo_id, convoId); assert.equal(row.status_by, 'agent')
      assert.equal('status_hidden' in row, false)
    }
  }
})
```

Append to `test/missions-http.test.js`:

```js
test("mission status sieve over HTTP: a private agent's status is null for an ordinary agent in list, detail and its own PATCH response; the client and the private agent see it", async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret2', ownerUserId: dan.id, title: 'S2', agentDeviceId: priv.deviceId })
  const pub = (await start(s, agent.token, {})).json.mission
  assert.equal((await s.http(`/missions/${pub.id}/join`, { method: 'POST', token: priv.token, body: { convo_id: 'secret2' } })).status, 200)
  const own = await patch(s, priv.token, pub.id, { status: 'Private plan: rotate the keys', convo_id: 'secret2' })
  assert.equal(own.status, 200)
  assert.equal(own.json.mission.status, 'Private plan: rotate the keys'); assert.equal(own.json.mission.status_convo_id, 'secret2')
  const asAgent = async () => [
    (await s.http('/missions', { token: agent.token })).json.missions.find((x) => x.id === pub.id),
    (await s.http(`/missions/${pub.id}`, { token: agent.token })).json.mission,
  ]
  for (const row of await asAgent()) {
    for (const k of STATUS_FIELDS) assert.equal(row[k], null, k)
    assert.equal(row.title, 'Missions')
  }
  // The ordinary agent's own title PATCH hands back the sieved row too.
  const renamed = await patch(s, agent.token, pub.id, { title: 'Renamed' })
  assert.equal(renamed.status, 200); assert.equal(renamed.json.mission.status, null)
  for (const token of [client, priv.token]) {
    const row = (await s.http(`/missions/${pub.id}`, { token })).json.mission
    assert.equal(row.status, 'Private plan: rotate the keys'); assert.equal(row.status_by, 'agent'); assert.equal(row.status_convo_id, 'secret2')
  }
  // No convo_id from the private device: still withheld (the device rule).
  const bare = await patch(s, priv.token, pub.id, { status: 'Still private' })
  assert.equal(bare.json.mission.status_convo_id, null)
  for (const row of await asAgent()) assert.equal(row.status, null)
  // The marker never carries the status text, so its replay crosses nothing.
  for (const p of updatedMarkers(s)) assert.equal('status' in p, false)
  // An ordinary agent overwriting it makes it visible again.
  assert.equal((await patch(s, agent.token, pub.id, { status: 'Public again', convo_id: 'c1' })).status, 200)
  for (const row of await asAgent()) assert.equal(row.status, 'Public again')
})

test("mission status for a colleague: shown when written by the owner's client or from a conversation the colleague can read, null otherwise", async (t) => {
  const { s, dan, pat, agent, client } = await fleet(t)
  const link = (u, gid) => saveGithubIdentity(s.db, { userId: u.id, host: 'github.com', identity: { github_id: gid, login: u.name, scopes: ['github.com/matronhq'] }, token: `t${gid}`, now: 1 })
  link(dan, 1); link(pat, 2)
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, agentDeviceId: agent.deviceId, repo: 'github.com/matronhq/journal' })
  const patClient = (await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'pw', device_name: 'mac' } })).json.token
  const m = (await start(s, agent.token, { title: 'Shared mission' })).json.mission
  const asPat = async () => [
    (await s.http('/missions?scope=shared', { token: patClient })).json.missions.find((x) => x.id === m.id),
    (await s.http(`/missions/${m.id}`, { token: patClient })).json.mission,
  ]
  assert.equal((await patch(s, agent.token, m.id, { status: 'From the shared convo', convo_id: 'c1' })).status, 200)
  for (const row of await asPat()) { assert.equal(row.status, 'From the shared convo'); assert.equal(row.status_convo_id, 'c1') }
  assert.equal((await patch(s, client, m.id, { status: 'From Dan' })).status, 200)
  for (const row of await asPat()) { assert.equal(row.status, 'From Dan'); assert.equal(row.status_by, 'user') }
  assert.equal((await patch(s, agent.token, m.id, { status: 'From an unshared convo', convo_id: 'c2' })).status, 200)
  for (const row of await asPat()) {
    for (const k of STATUS_FIELDS) assert.equal(row[k], null, k)
    assert.equal(row.title, 'Shared mission')
  }
  assert.equal((await s.http(`/missions/${m.id}`, { token: client })).json.mission.status, 'From an unshared convo')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=30000 test/missions.test.js test/missions-http.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: 3 failures — `mission status sieve: withheld…` (the `['c3', 9, true]` row: expected null, got the text), `mission status sieve over HTTP…`, `mission status for a colleague…` (the `c2` case); `# fail 3`.

- [ ] **Step 3: Implement the sieve in `src/missions.js`**

In `missionRow` (as rewritten in Task 1), change the destructuring line and add the null-out just before `return out`:

```js
export function missionRow(row) {
  if (!row) return null
  const {
    idem_key: _idemKey, sieved_last_milestone_at: _sievedLastMilestoneAt,
    status_device_id: _statusDeviceId, status_hidden: statusHidden, ...rest
  } = row
  const out = { ...rest, closed_over_open_items: Number(rest.closed_over_open_items || 0) }
  for (const k of ['open_items', 'needs_you', 'conversations', 'milestones']) if (k in out) out[k] = Number(out[k])
  if ('last_milestone_json' in out) {
    out.last_milestone = out.last_milestone_json ? JSON.parse(out.last_milestone_json) : null
    delete out.last_milestone_json
  }
  // The sieve's verdict (STATUS_PRIVATE, below) — computed per caller by
  // countsSql / sharedCountsSql. A withheld status reads as four nulls, the
  // same shape as "never set", so its absence says nothing.
  if (Number(statusHidden || 0)) for (const k of STATUS_FIELDS) out[k] = null
  return out
}
```

and extend the comment above `missionRow` with one sentence: `` `status_hidden` is the per-caller sieve verdict countsSql/sharedCountsSql compute — never on the wire. ``

Directly under `STATUS_BAD_CHARS` (added in Task 1) add:

```js
const STATUS_FIELDS = ['status', 'status_by', 'status_convo_id', 'status_updated_at']
```

Directly above the `// Review fix (Task 7, Critical 1)` comment that precedes `countsSql`, add:

```js
// Spec 2026-09-28 missions dashboard §1, privacy: a status written from a
// private-owned conversation is withheld from an ordinary agent the way that
// conversation's milestones are. Keyed on the writing DEVICE too: a private
// agent that named no conversation (or a public one) wrote it all the same.
// Evaluated at read time against the current private flag, like every other
// private-owned sieve here.
const STATUS_PRIVATE = `(
  EXISTS (SELECT 1 FROM devices sd WHERE sd.id = m.status_device_id AND sd.private = 1)
  OR EXISTS (SELECT 1 FROM conversations sc JOIN devices sd ON sd.id = sc.agent_device_id
             WHERE sc.id = m.status_convo_id AND sd.private = 1)
)`
```

In `countsSql`, append one select column after `AS sieved_last_milestone_at` so the template's tail reads:

```js
    (SELECT l.created_at FROM milestones l WHERE l.mission_id = m.id ${milestoneSieve}
       ORDER BY l.created_at DESC, l.seq DESC LIMIT 1) AS sieved_last_milestone_at,
    ${excludePrivateOwned ? STATUS_PRIVATE : '0'} AS status_hidden
  `
```

In `sharedCountsSql`, append after its `AS sieved_last_milestone_at` in the same way, and add one sentence to the comment above it (`Status: hidden when privately written, or written from a conversation this viewer cannot read; a client write with no conversation is shared like the title and body.`):

```js
    (SELECT l.created_at FROM milestones l JOIN conversations mc ON mc.id = l.convo_id
       WHERE l.mission_id = m.id AND ${sharedConvoSql('mc')}
       ORDER BY l.created_at DESC, l.seq DESC LIMIT 1) AS sieved_last_milestone_at,
    (${STATUS_PRIVATE}
      OR (m.status_convo_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM conversations sc WHERE sc.id = m.status_convo_id AND ${sharedConvoSql('sc')}))) AS status_hidden
  `
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-timeout=30000 test/missions.test.js test/missions-http.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# pass 70`, `# fail 0` (35 + 35).

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-journal-mission-status
git add src/missions.js test/missions.test.js test/missions-http.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -F - <<'EOF'
missions: withhold a privately written status from ordinary agents and colleagues

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: `docs/protocol.md`, `src/help.js`, full suite, PR (no deploy)

**Files:**
- Modify: `docs/protocol.md:1753` (routes table PATCH row), after `:1763` (new *Status* subsection before `### Idempotency`), `:1765-1772` (row shapes), `:1819-1834` (mission marker), end of *Visibility* (before `## Shared visibility`, currently line 1915)
- Modify: `src/help.js:156-157` (the `PATCH /missions/:id` bullet)
- Test: `test/help.test.js` (the missions assertions after line 38)

**Interfaces:**
- Consumes: the behaviour of Tasks 1–3, exactly as tested.
- Produces: documentation only; `/help` text changes.

- [ ] **Step 1: Write the failing test**

In `test/help.test.js`, directly after `assert.match(body, /attach: false/)` add:

```js
  // Mission status (spec 2026-09-28 missions dashboard §1): a bridge session
  // learns the field, its clear, its attribution and the marker flag here.
  assert.ok(body.includes('status?: string|null'), '/help must document PATCH /missions/:id {status}')
  for (const field of ['status_by', 'status_convo_id', 'status_updated_at', 'status_changed']) {
    assert.ok(body.includes(field), `/help must name ${field}`)
  }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test --test-timeout=30000 test/help.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `not ok 1 - GET /help serves the API digest to authenticated devices only` with `/help must document PATCH /missions/:id {status}`; `# fail 1`.

- [ ] **Step 3: Update `src/help.js`**

Replace lines 156–157:

```
- \`PATCH /missions/:id\` \`{title?, body?}\` → 200 \`{mission}\`; 409
  once the mission is closed.
```

with:

```
- \`PATCH /missions/:id\` \`{title?, body?, status?: string|null,
  convo_id?}\` → 200 \`{mission}\`; 409 once the mission is closed.
  \`status\` is the mission's one-paragraph headline (markdown, 1–600
  chars after trimming, no control characters but newline and tab): a
  string replaces it, \`null\` clears it. Pass your own conversation as
  \`convo_id\` so the status is attributed to it. Every mission row carries
  \`status\`, \`status_by\` (user|agent), \`status_convo_id\` and
  \`status_updated_at\` — null when unset, or when it was written from a
  private conversation you cannot see. The \`updated\` mission marker
  carries \`status_changed: true\` when the PATCH wrote the status.
```

- [ ] **Step 4: Update `docs/protocol.md`**

Routes table (line 1753), replace the PATCH row with:

```markdown
| `PATCH /missions/:id` | `{title?, body?, status?: string\|null, convo_id?}` | 200 `{mission}`; 400 on a bad `status` (see *Status*); 409 `{blocked_by:'closed'}` |
```

Insert a new subsection immediately before `### Idempotency` (after the "Row shapes" paragraph):

```markdown
### Status

Spec: `docs/superpowers/specs/2026-09-28-missions-dashboard-design.md` §1.

A mission carries one **status**: a short markdown paragraph saying where
the work is, what's next and what is blocked — the headline on its card in
the apps. It is overwritten, never appended; there is no history.

- `PATCH /missions/:id {status: "…"}` sets it. The text is trimmed (CRLF
  folded to LF first) and must then be 1–600 UTF-16 code units with no
  control characters other than `\n` and `\t`, and no U+2028/U+2029 —
  else 400 `bad_request` and nothing is written. It combines with `title`
  / `body` in one PATCH. `status` on `POST /missions` is ignored.
- `{status: null}` clears it.
- The four fields are always written together: `status`, `status_by`
  (`'user'` for a client, `'agent'` for an agent), `status_convo_id`,
  `status_updated_at` (ms; the same instant as the new `updated_at`; null
  when cleared).
- `status_convo_id` comes from an optional `convo_id` in the same body. It
  is recorded only when the caller is an agent, the conversation belongs to
  the caller's user, and — for an ordinary agent — it is not private-owned.
  Anything else (a client, another user's or an unknown conversation, a
  non-string) records null: it is attribution, never a gate, never a 400.
- A closed mission is 409 `{blocked_by:'closed'}` and a mission the caller
  cannot see is 404 — the rules of every PATCH. An ordinary agent may set
  the status of any mission it can see (the Coordinator refreshes missions
  it is not on).
- Like every PATCH it bumps `updated_at` (so `GET /missions?since=` sees
  it) and appends the `updated` mission marker to the origin conversation,
  carrying `status_changed: true` (see *Marker events*).

Every mission row — `GET /missions`, `GET /missions/:id`, and the `mission`
object in every other response — carries the four fields, null when unset
or withheld (see *Visibility*).
```

Row shapes (lines 1765–1772), replace the paragraph with:

```markdown
Row shapes: a mission is `{id, user_id, num, state, title, body,
close_summary, closed_by, closed_over_open_items, origin_convo_id,
origin_device_id, created_by, created_at, updated_at, last_milestone_at,
closed_at, status, status_by, status_convo_id, status_updated_at}` plus the
counts listed against `GET /missions` above; a milestone is `{id,
mission_id, user_id, num, kind, title, body, convo_id, seq, device_id,
created_by, created_at}`. `idem_key` is an internal column on both and is
never returned — the same stance items take. The mission also stores
`status_device_id` (the device that wrote the status, used only by the
privacy sieve), likewise never returned; those are the only keys either
shape strips.
```

Mission marker (lines 1819–1825), replace the JSON block with:

```json
{ "type": "mission",
  "payload": { "mission_id": "ms_…", "num": 61, "title": "…",
               "action": "created" | "joined" | "updated" | "closed",
               "by": "user" | "agent",
               "open_item_nums": [64, 70],          // only on a user-forced close
               "status_changed": true } }           // only on an `updated` that wrote the status
```

and after the paragraph ending `("🏁 Mission #61 closed").` add:

```markdown
`status_changed: true` is present on an `updated` marker whenever that
PATCH carried `status` — set, re-set to the same text (its
`status_updated_at` still moves) or cleared — and absent otherwise. It is a
flag only: the marker never carries the status text, because the origin
conversation's agents replay it verbatim. Clients may ignore it; the marker
is already the refetch signal.
```

At the end of *Visibility* (after the "Markers written across the boundary carry numbers only." paragraph, before `## Shared visibility`), add:

```markdown
**Status.** A status written from a private-owned conversation — or by a
private device, whichever conversation it named, or none — reads as
`status`, `status_by`, `status_convo_id` and `status_updated_at` all null
for an ordinary agent: on the list, the detail, and every response carrying
the mission, that agent's own PATCH responses included. The rest of the row
is unchanged. Client devices and private agents always see it. The verdict
is taken at read time against the device's current private flag, like every
other sieve here. For a colleague (*Shared visibility*) the status shows
only when it was written with no conversation by a non-private device (a
client write — shared like the title and body) or from a conversation that
colleague can read under the shared rule; otherwise the four fields are
null.
```

- [ ] **Step 5: Run the help test, then the full suite**

Run: `node --test --test-timeout=30000 test/help.test.js 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# pass 1`, `# fail 0`.

Run: `npm test 2>&1 | grep -E '^not ok|^# (tests|pass|fail)'`
Expected: no `not ok` lines, `# fail 0`. (If a test outside `missions*`/`help` fails, run it alone on `origin/master` before touching it — a pre-existing flake is not this PR's to fix.)

- [ ] **Step 6: Commit**

```bash
cd /Users/danbarker/Dev/matron-journal-mission-status
git add docs/protocol.md src/help.js test/help.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -F - <<'EOF'
missions: document the mission status in protocol.md and /help

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 7: Open the PR — and stop. Do not deploy.**

Push the implementation branch and open a PR against `master` titled `missions: status on every mission (PATCH /missions/:id {status})`, body summarising the four wire fields, the internal `status_device_id`, the sieve (ordinary agents and colleagues), and the `status_changed` marker flag, ending with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**Do not deploy this PR to services-1 (or anywhere).** Deployment is Rollout step 1 in the spec and is run separately, after review and merge, with the journal deploy recipe (DB backup first). Report the PR URL and stop.
