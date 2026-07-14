# Tool-Output Purge After TTL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After `MATRON_TOOL_LOG_TTL_HOURS` (default 24h), purge tool output entirely — snippet as well as blob — leaving a tombstone that keeps only command, exit code, and flags.

**Architecture:** Extend the existing `runExpireLogs` sweep (src/retention.js) to rewrite payloads to a tombstone and scrub the conversation-list preview; add a `$ <command>` branch to `snippetOf`; update the protocol doc's retention section with the tombstone shape and binding client-cache rules.

**Tech Stack:** Node ≥ 22 ESM, better-sqlite3 (JSON1 available), `node --test` runner (`npm test` runs `node --test 'test/**/*.js'`).

**Spec:** `docs/superpowers/specs/2026-07-14-tool-output-purge-design.md`

## Global Constraints

- Tombstone payload shape, exactly: `{message_ref, command, exit_code, denied, truncated, live_log: true, expired: true, blob_ref: null}` — the `snippet` and `blob_expired` keys are absent (removed, not nulled). Fields are carried verbatim from the old payload.
- `expired: true` is the single client-facing flag; nothing new writes `blob_expired`.
- Journal `events` rows are never deleted; only payloads are rewritten. Seq continuity is inviolable.
- Only `live_log: true` payloads are governed by this TTL (offload-created and legacy viewer-era rows carry no output and are untouched).
- Knob semantics unchanged: `MATRON_TOOL_LOG_TTL_HOURS` default 24; 0/invalid disables the sweep; boot + 6-hourly schedule and `matron-admin expire-logs [--hours N]` interfaces unchanged (no changes to src/server.js or bin/matron-admin.js).
- Blob row deletion and payload rewrite stay in one transaction per row; file unlink after commit (existing stance).
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `snippetOf` command branch

**Files:**
- Modify: `src/journal.js` (the `snippetOf` function, ~line 7)
- Test: `test/journal.test.js`

**Interfaces:**
- Produces: `snippetOf('tool_output', p)` returns `` `$ ${p.command}` `` (120-char cap) when `p.snippet` is absent/falsy and `p.command` is present. Task 2's convo-preview scrub relies on exactly this.
- Existing behavior preserved: payloads with a `snippet` still return the snippet slice; all other types unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `test/journal.test.js` (it already imports `snippetOf`):

```js
test('snippetOf tool_output falls back to `$ command` when snippet is absent', () => {
  assert.equal(snippetOf('tool_output', { command: 'make test', expired: true }), '$ make test')
  // snippet still wins when present
  assert.equal(snippetOf('tool_output', { command: 'make', snippet: 'tail line' }), 'tail line')
  // no command, no snippet -> generic placeholder (unchanged)
  assert.equal(snippetOf('tool_output', { expired: true }), '[tool_output]')
  // 120-char cap
  const long = 'x'.repeat(300)
  const s = snippetOf('tool_output', { command: long })
  assert.equal(s.length, 120)
  assert.ok(s.startsWith('$ x'))
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/journal.test.js`
Expected: the new test FAILS (`'[tool_output]'` !== `'$ make test'`); all others pass.

- [ ] **Step 3: Implement**

In `src/journal.js`, `snippetOf` — add one line between the `p.snippet` check and the fallback:

```js
  if (p.snippet) return String(p.snippet).slice(0, 120)
  if (type === 'tool_output' && p.command) return `$ ${String(p.command)}`.slice(0, 120)
  return `[${type}]`
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/journal.test.js`
Expected: PASS (all tests in file).

- [ ] **Step 5: Commit**

```bash
git add src/journal.js test/journal.test.js
git commit -m "feat: snippetOf falls back to \$ command for snippetless tool_output"
```

---

### Task 2: `runExpireLogs` tombstone + convo preview scrub + offload skip

**Files:**
- Modify: `src/retention.js` (`runExpireLogs` ~79-103; `runOffload` skip ~51-53)
- Test: `test/retention.test.js`

**Interfaces:**
- Consumes: `snippetOf('tool_output', tombstone)` from Task 1 (→ `$ <command>`); `snippetOf` is already imported in retention.js.
- Produces: `runExpireLogs(db, { hours, mediaDir })` — signature unchanged; return `{ expired }` counts tombstoned rows (with or without a blob).

- [ ] **Step 1: Update the existing expire test to the tombstone shape**

In `test/retention.test.js`, replace the body of the test
`'runExpireLogs deletes old live_log blobs, rewrites payload, NULLs the column'`
assertions section (keep the seeding lines) so the payload checks become:

```js
  const oldRow = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(userId, old.seq)
  assert.equal(oldRow.blob_ref, null)
  const p = JSON.parse(oldRow.payload)
  assert.deepEqual(p, {
    message_ref: 'tu-x', command: 'make', exit_code: 0, denied: false,
    truncated: false, live_log: true, expired: true, blob_ref: null,
  }) // snippet and blob_expired keys gone, everything else carried verbatim
  assert.equal(getBlob(db, old.blob.id), undefined)
  assert.equal(fs.existsSync(old.blob.diskPath), false)
```

(The fresh-row and idempotency assertions at the end of that test stay as they are.)

- [ ] **Step 2: Rewrite the offload-skip test and add the new tests**

Replace the test `'runOffload skips blob_expired payloads (no pointless re-blob at 30d)'` with:

```js
test('runOffload skips expired tombstones (no pointless re-blob at 30d)', async () => {
  const { db, dan } = await setup()
  const userId = dan.id
  const convoId = 'c1'
  const mediaDir = tmpMediaDir()
  const old = seedLiveLog(db, mediaDir, { userId, convoId, ts: Date.now() - 40 * 86400000 })
  runExpireLogs(db, { hours: 24, mediaDir })
  const r = runOffload(db, { days: 30, mediaDir })
  assert.equal(r.offloaded, 0)
  const row = db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(userId, old.seq)
  assert.equal(JSON.parse(row.payload).expired, true) // untouched tombstone
})
```

Then append these three tests:

```js
test('runExpireLogs tombstones a pre-upgrade blob_expired row (snippet purged, no blob to delete)', async () => {
  const { db, dan } = await setup()
  const payload = {
    message_ref: 'tu-pre', command: 'npm ci', exit_code: 1, denied: false,
    truncated: false, snippet: 'old tail', blob_ref: null, blob_expired: true, live_log: true,
  }
  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:dev-2', type: 'tool_output', payload })
  db.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(Date.now() - 48 * 3600000, dan.id, r.seq)

  assert.equal(runExpireLogs(db, { hours: 24, mediaDir: tmpMediaDir() }).expired, 1)
  const row = db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(dan.id, r.seq)
  assert.deepEqual(JSON.parse(row.payload), {
    message_ref: 'tu-pre', command: 'npm ci', exit_code: 1, denied: false,
    truncated: false, live_log: true, expired: true, blob_ref: null,
  })
})

test('runExpireLogs scrubs the convo preview when the purged event is the latest', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  seedLiveLog(db, mediaDir, { userId: dan.id, convoId: 'c1', ts: Date.now() - 48 * 3600000 })
  assert.equal(db.prepare('SELECT snippet FROM conversations WHERE id=?').get('c1').snippet, 'tail')

  runExpireLogs(db, { hours: 24, mediaDir })
  assert.equal(db.prepare('SELECT snippet FROM conversations WHERE id=?').get('c1').snippet, '$ make')
})

test('runExpireLogs leaves the convo preview alone when a newer message exists', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  seedLiveLog(db, mediaDir, { userId: dan.id, convoId: 'c1', ts: Date.now() - 48 * 3600000 })
  append(db, { userId: dan.id, convoId: 'c1', sender: 'user:dan', type: 'text', payload: { body: 'newer message' } })

  runExpireLogs(db, { hours: 24, mediaDir })
  assert.equal(db.prepare('SELECT snippet FROM conversations WHERE id=?').get('c1').snippet, 'newer message')
})
```

The tests `'runExpireLogs never touches offload-created blobs (no live_log flag)'` and all `runOffload` tests other than the one replaced above are unchanged and must still pass.

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/retention.test.js`
Expected: FAIL — the updated shape assertions and the three new tests fail against current code (`blob_expired`/snippet still present; convo snippet still `'tail'`; pre-upgrade row not selected because its `blob_ref` column is NULL).

- [ ] **Step 4: Implement**

In `src/retention.js`, replace `runExpireLogs` (keep the import block as is — `snippetOf` is already imported):

```js
// Purges tool output attached to live-streamed tool_output events older than
// `hours` (spec: docs/superpowers/specs/2026-07-14-tool-output-purge-design.md).
// The full-log blob is deleted AND the payload is rewritten to a tombstone —
// command, exit code, and flags survive forever; the snippet does not. Only
// payloads marked live_log:true are touched; offload-created blobs and legacy
// viewer-era rows never carry that flag. json_extract keeps the 6-hourly scan
// from re-parsing every historical row: already-tombstoned rows (`expired`)
// and non-live-log rows are excluded in SQL (all payloads are server-written
// JSON, so json_valid guards nothing real but keeps a hand-edited row from
// erroring the whole query). Blob-row delete, payload rewrite, and the convo
// preview scrub share one transaction per row; file unlink happens after
// commit — a crash between the two leaves an orphan file (same stance as
// runOffload's write-before-commit, in the opposite direction).
export function runExpireLogs(db, { hours = 24, mediaDir }) {
  const cutoff = Date.now() - hours * 3600000
  const rows = db.prepare(
    "SELECT user_id, seq, convo_id, payload, blob_ref FROM events WHERE type='tool_output' AND ts<? " +
    "AND json_valid(payload) AND json_extract(payload,'$.live_log') AND json_extract(payload,'$.expired') IS NULL"
  ).all(cutoff)

  let expired = 0
  const update = db.prepare('UPDATE events SET payload=?, blob_ref=NULL WHERE user_id=? AND seq=?')
  const deleteBlobRow = db.prepare('DELETE FROM blobs WHERE id=?')
  const convoLastSeq = db.prepare('SELECT last_seq FROM conversations WHERE id=?')
  const updateConvoSnippet = db.prepare('UPDATE conversations SET snippet=? WHERE id=?')

  for (const row of rows) {
    let payload
    try { payload = JSON.parse(row.payload) } catch { payload = null }
    if (!payload || payload.live_log !== true) continue // defense in depth; SQL already filters
    const blob = row.blob_ref ? getBlob(db, row.blob_ref) : null
    const tombstone = {
      message_ref: payload.message_ref,
      command: payload.command,
      exit_code: payload.exit_code,
      denied: payload.denied,
      truncated: payload.truncated,
      live_log: true,
      expired: true,
      blob_ref: null,
    }
    db.transaction(() => {
      if (row.blob_ref) deleteBlobRow.run(row.blob_ref)
      update.run(JSON.stringify(tombstone), row.user_id, row.seq)
      // Purged output must not linger in the conversation-list preview: if
      // this event is still the convo's latest, rewrite the preview from the
      // tombstone ($ <command>). A newer message owns the preview otherwise.
      const convo = convoLastSeq.get(row.convo_id)
      if (convo && convo.last_seq === row.seq) {
        updateConvoSnippet.run(snippetOf('tool_output', tombstone), row.convo_id)
      }
    })()
    if (blob) { try { fs.unlinkSync(blob.disk_path) } catch { /* already gone */ } }
    expired += 1
  }
  return { expired }
}
```

And in `runOffload`, replace the `blob_expired` skip (lines ~51-53) with:

```js
    // A live-log payload the TTL pass already tombstoned (`expired`), or one
    // in the pre-purge shape (`blob_expired`) that the next TTL pass will
    // tombstone: re-blobbing either would undo the purge for zero value.
    if (payload && (payload.expired || payload.blob_expired)) continue
```

- [ ] **Step 5: Run to verify pass**

Run: `node --test test/retention.test.js`
Expected: PASS (every test in the file, including the untouched offload ones).

- [ ] **Step 6: Commit**

```bash
git add src/retention.js test/retention.test.js
git commit -m "feat: purge tool-output snippets at TTL; scrub convo previews (tombstone keeps command/exit_code)"
```

---

### Task 3: Protocol doc + full suite

**Files:**
- Modify: `docs/protocol.md` (Retention section, ~lines 195-222)

**Interfaces:**
- Consumes: tombstone shape from Task 2, `$ <command>` preview from Task 1.

- [ ] **Step 1: Rewrite the live-log retention paragraph**

In `docs/protocol.md`, replace the paragraph beginning `Live-log blobs (`tool_output` payloads with `live_log: true`, …` (through `matron-admin expire-logs [--hours N]`.`) with:

```markdown
Live-streamed tool output (`tool_output` payloads with `live_log: true`,
uploaded by bridges at command completion) is purged entirely after
`MATRON_TOOL_LOG_TTL_HOURS` (default 24; 0/invalid disables): the blob file
and its `blobs` row are deleted and the payload is rewritten to the tombstone
`{message_ref, command, exit_code, denied, truncated, live_log: true,
expired: true, blob_ref: null}` — the snippet is removed; what a command ran
and whether it succeeded survive forever, what it printed does not. If the
purged event is the conversation's latest, the conversation-list preview is
rewritten to `$ <command>`. Offload skips `expired` payloads. Manual run:
`matron-admin expire-logs [--hours N]`.

Client rules (binding on all client implementations):

- Render `expired: true` as an "output expired" affordance — show command and
  exit code, no snippet area, no fetch button.
- Any client-side persistence of `tool_output` payloads must enforce the same
  TTL locally: drop a cached snippet once `ts + 24h` passes, without waiting
  for a server re-sync — otherwise the server purge is defeated by device
  caches. In-memory display of a currently-open conversation is exempt.
- The TTL is not communicated in-protocol; clients assume the 24h default.
```

- [ ] **Step 2: Check for other stale "snippet stays forever" claims**

Run: `grep -rn -i 'forever' docs/protocol.md README.md`
Expected: no remaining claim that tool-output snippets are kept forever (the tombstone's command/exit_code surviving forever is correct and stays).
Fix any stragglers found.

- [ ] **Step 3: Full suite**

Run: `npm test`
Expected: PASS — every test file, no failures, pristine output.

- [ ] **Step 4: Commit**

```bash
git add docs/protocol.md
git commit -m "docs: retention section — tool output purges at TTL, tombstone shape, client cache rules"
```
