# Agent-chat allowance removal — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete standing "always allow A → B" consent from agent chat, so that every agent-chat invite and join asks the user, every time.

**Architecture:** This is a deletion, not a feature. One behavioural change carries the whole thing — `ws.js` stops consulting `isAllowed`, so the pre-approval fast path disappears and every ask parks in `awaiting_user`. Everything after that is removing the surfaces that wrote, read, or administered the rows the gate no longer consults: the `always_allow` field on the answer endpoint, two HTTP endpoints, an admin CLI subcommand, the module, and the table.

**Tech Stack:** Node 22 ESM, `better-sqlite3`, `node:test` (no framework), plain `node:http`.

## Why this ships first

It is a prerequisite for `docs/superpowers/specs/2026-08-09-agent-spawns-session-design.md` (approved 2026-08-09, PR #53). That spec establishes every-time consent for spawns and states the same rule for chat, so the allowance code becomes dead code that still reads like a live security control. It ships as its own PR so the spawn PR's diff is the spawn feature and nothing else.

## Global Constraints

- **Every ask parks. There is no fast path.** After Task 1 there must be no code path from an `agent_invite` frame to `hub.sendRpcRequest` that does not pass through `parkInvite` and a user answer.
- **The per-requester cap still applies.** `awaitingCount(db, conn.deviceId) >= MAX_AWAITING_PER_REQUESTER` → `fail('conflict', 'too many requests awaiting user approval')`. Removing the fast path routes *more* traffic through this check, not less; do not weaken it.
- **A removed field is rejected, not ignored.** `POST /agent-chat/answer` must answer `400 {error:'bad_request'}` when the body carries `always_allow`. A silently ignored `always_allow: true` would let a caller believe it granted standing consent that does not exist — the exact failure this removal exists to prevent.
- **Removed endpoints answer 404, and stay client-gated on the way there.** No route may start answering an agent device something it could not read before.
- **Migration is a plain `DROP TABLE`,** run unconditionally at `openDb` alongside the existing migrations in `src/db.js`. No data is preserved: a standing consent that no longer means anything must not survive as a row that looks like it does.
- **Tests are `node --test`.** Run the whole suite with `npm test`; run one file with `node --test test/<file>.test.js`. Both must be run from the repo root with `node_modules` installed (`npm install` in a fresh worktree — worktrees do not share `node_modules`).
- **This repo has no CI.** `npm test` passing locally is the only green signal. Record the count (`# pass N`) in each commit's test step; a task is not done on a suite with new failures.

## Compatibility note for the reviewer

Shipped App Store builds (Apple 1.0.3, Android v0.1.5) contain an allowances screen that calls `GET /agent-chat/allowances`. After Task 3 that screen gets a 404 and shows its error state until those apps are updated. This is accepted: the screen can only ever have listed rows that no longer exist.

That screen is not the only break, and not the important one. The live consent card itself carries an "always allow" toggle on both shipped platforms — `MatronShared/Sources/DesignSystem/AgentChatRequestCard.swift:102` (iOS/Mac) and `app/src/main/java/chat/matron/android/designsystem/AgentChatRequestCard.kt:116` (Android). Both clients send the field only when that toggle is on: `if alwaysAllow, decision == .approve { body["always_allow"] = true }` (`JournalAPI.swift:503`) and `if (alwaysAllow && decision == AgentChatDecision.APPROVE) put("always_allow", true)` (`JournalApi.kt:408`). Both default the toggle to off, so an ordinary approval from shipped Apple 1.0.3 / Android v0.1.5 never sets the field and keeps working unchanged. But a user who flips the toggle and taps Approve now gets `400 {error:'bad_request'}` from `POST /agent-chat/answer` (per the global constraint above) and **cannot approve the request at all** — a broken primary action, not a broken settings screen. It fails closed, which is correct, but it is a real regression for any user who has that toggle on, until the app is updated.

Consequence: this journal change must land after, or alongside, the per-platform app PRs that remove the toggle. Do not deploy this journal change first and leave shipped apps carrying a live "always allow" switch that 400s.

**Deploy note — mid-upgrade window.** `DROP TABLE IF EXISTS agent_chat_allowances` runs on every `openDb`. If a new-code process (a new `matron-admin` CLI invocation, or a new server) opens the live database while an old server process is still running, the table vanishes under the old process and its `isAllowed` prepared statement throws `no such table`, surfacing as `{code:'internal'}` on every `agent_invite` until the old process restarts. This is transient, restart-scoped, and fails closed, so it does not change the code — but it does mean: **stop the service before running any new-code CLI against the database**, and deploy the new server binary as a restart, not a rolling window where old and new processes share the database.

## File Structure

| File | Change | Responsibility after |
|---|---|---|
| `src/ws.js` | Modify — drop the `isAllowed` import and the pre-approval branch | Every `agent_invite` parks for consent |
| `src/http.js` | Modify — drop the `allowances.js` import, the `always_allow` branch, both `/agent-chat/allowances*` routes, and the `forgetDeviceAllowances` call | Answer endpoint records a decision and nothing else |
| `bin/matron-admin.js` | Modify — drop the `agent-chat allowances` subcommand and its usage line | Admin CLI keeps `pending`/`approve`/`deny` only |
| `src/allowances.js` | **Delete** | — |
| `src/db.js` | Modify — drop the `agent_chat_allowances` DDL, add a `DROP TABLE` migration | Schema carries no allowance table |
| `src/participants.js:128` | Modify — the comment cites `forgetDeviceAllowances` as a sibling; drop that clause | Comment describes only what exists |
| `test/allowances.test.js` | **Delete** | — |
| `test/agent-chat-consent.test.js` | Modify — replace the six always_allow/allowances tests with the new every-time assertions | Pins that consent is always asked |
| `test/admin.test.js` | Modify — drop the two allowances CLI tests and the `listAllowances` import | — |
| `README.md`, `docs/protocol.md` | Modify — drop allowance references | Docs describe the shipped protocol |

Tasks are ordered so the suite is green at every commit: behaviour first, then the writer, then the readers, then the module and table.

---

### Task 1: Every invite parks — remove the pre-approval gate

**Files:**
- Modify: `src/ws.js` (the `isAllowed` import at line 6; the `if (isAllowed(...))` branch beginning at line 822)
- Test: `test/agent-chat-consent.test.js`

**Interfaces:**
- Consumes: `addAllowance(db, {userId, fromDeviceId, targetDeviceId})` and `isAllowed(db, userId, fromDeviceId, targetDeviceId)` from `src/allowances.js` — still present in this task, deleted in Task 6.
- Produces: nothing new. After this task `isAllowed` has no production caller.

- [ ] **Step 1: Write the failing test**

Append to `test/agent-chat-consent.test.js`. It seeds an allowance directly (the row still exists in this task) and proves the gate ignores it.

```js
test('a pre-existing allowance no longer relays: the invite parks and the user still gets a card', async (t) => {
  const { s, dan, agA, agB, client, a } = await roomFleet(t)
  // The row the old fast path keyed on. Seeded directly rather than via
  // always_allow:true so this test survives Task 2 deleting that field.
  addAllowance(s.db, { userId: dan.id, fromDeviceId: agA.deviceId, targetDeviceId: agB.deviceId })

  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'work together', topic: 'x' })

  const card = await client.waitFor((f) => f.kind === 'journal' && f.type === 'permission_request')
  assert.equal(card.payload.request, 'invite')
  assert.equal(card.payload.target_device_id, agB.deviceId)
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'awaiting_user')
})

test('a pre-existing allowance does not deliver to the target socket', async (t) => {
  const { s, dan, agA, agB, b, a } = await roomFleet(t)
  addAllowance(s.db, { userId: dan.id, fromDeviceId: agA.deviceId, targetDeviceId: agB.deviceId })
  b.frames.length = 0

  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'work together', topic: 'x' })
  // Give any erroneous relay a chance to arrive before asserting absence.
  await a.waitFor((f) => f.kind === 'invite' || f.op === 'error' || f.kind === 'journal')

  assert.equal(b.frames.filter((f) => f.kind === 'invite' && f.event === 'request').length, 0)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/agent-chat-consent.test.js`
Expected: both new tests FAIL. The first times out waiting for a `permission_request` (the gate relayed instead of parking); the second finds one `invite`/`request` frame on `b`.

- [ ] **Step 3: Remove the gate**

In `src/ws.js`, delete the import on line 6:

```js
import { isAllowed } from './allowances.js'
```

Then delete the entire `if (isAllowed(db, conn.userId, conn.deviceId, msg.target_device_id)) { ... }` block that begins after the `if (!justification) return fail('bad_request', 'bad justification')` line — from the `if (isAllowed(` line through its closing `}` and the `break` inside it. The next surviving line is the comment `// No standing allowance for this directed pair: park for the user's`. Rewrite that comment, since there is no longer such a thing as a standing allowance:

```js
        // Every ask parks for the user's consent — there is no standing
        // allowance and no fast path, so nothing reaches the target's socket
        // before a human answers. Capped per requester device so one chatty
        // agent can't flood the user's attention queue with asks.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/agent-chat-consent.test.js`
Expected: PASS, including the two new tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: pass. Two pre-existing tests in this file — `'always_allow:true on approve records the directed pair; a following agent_invite between them relays immediately'` and `'always_allow JOIN direction: approving a join request records (joiner -> room owner), never the reverse'` — assert the relay behaviour just removed. Delete the first outright; it is the fast path. Keep the second only as far as it asserts `isAllowed` direction, which Task 2 removes — so delete it too, and note in the commit that its direction rule (joiner → room owner) is preserved by the `isJoin` branch until Task 2 removes that as well.

- [ ] **Step 6: Commit**

```bash
git add src/ws.js test/agent-chat-consent.test.js
git commit -m "feat(agent-chat): every invite parks for consent, with no standing-allowance fast path"
```

---

### Task 2: `always_allow` is rejected, not honoured

**Files:**
- Modify: `src/http.js` (the `always_allow` destructure and the `if (always_allow === true) { addAllowance(...) }` branch in `POST /agent-chat/answer`, around lines 428-440)
- Test: `test/agent-chat-consent.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `POST /agent-chat/answer` now answers `400 {error:'bad_request'}` for a body carrying `always_allow`, at any value.

- [ ] **Step 1: Write the failing test**

```js
test('POST /agent-chat/answer rejects always_allow rather than ignoring it', async (t) => {
  const { s, agA, agB, clientToken, a } = await roomFleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'j', topic: 'x' })
  await new Promise((r) => setTimeout(r, 50))

  for (const value of [true, false]) {
    const r = await s.http('/agent-chat/answer', {
      method: 'POST', token: clientToken,
      body: { room_id: 'room', target_device_id: agB.deviceId, decision: 'approve', always_allow: value },
    })
    assert.equal(r.status, 400, `always_allow:${value} must be rejected, never ignored`)
    assert.equal(r.json.error, 'bad_request')
  }
  // The rejected calls must not have answered the row either.
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'awaiting_user')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/agent-chat-consent.test.js`
Expected: FAIL — the endpoint answers 200 and approves the row.

- [ ] **Step 3: Reject the field**

In `src/http.js`, in the `POST /agent-chat/answer` handler, remove `always_allow` from the destructured body and add the rejection immediately after the existing `decision`/`room_id`/`target_device_id` validation:

```js
        // `always_allow` was the standing-consent grant. It is gone, and a
        // body still carrying it is rejected rather than ignored: a caller
        // that believes it granted standing consent which does not exist is
        // worse off than one told plainly that the field is not accepted.
        if ('always_allow' in body) return json(res, 400, { error: 'bad_request' })
```

Then delete the `if (always_allow === true) { addAllowance(...) }` block, and the now-unused `const isJoin = row.initiator_device_id === target_device_id` if nothing below it reads `isJoin`. Check first — if a later line uses `isJoin`, keep it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/agent-chat-consent.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: pass. Every remaining test that posts `always_allow: true` to seed a pair must be changed to call `addAllowance(s.db, {...})` directly (it still exists until Task 6) or deleted with its endpoint in Task 4.

- [ ] **Step 6: Commit**

```bash
git add src/http.js test/agent-chat-consent.test.js
git commit -m "feat(agent-chat): reject always_allow on the answer endpoint"
```

---

### Task 3: Remove the allowance HTTP endpoints

**Files:**
- Modify: `src/http.js` (`GET /agent-chat/allowances` and `POST /agent-chat/allowances/revoke`, around lines 371-400; the `listAllowances`/`removeAllowance` names in the import on line 9)
- Test: `test/agent-chat-consent.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: both paths answer `404 {error:'not_found'}` for a client token.

- [ ] **Step 1: Write the failing test**

```js
test('the allowance endpoints are gone for clients and agents alike', async (t) => {
  const { s, agA, clientToken } = await roomFleet(t)
  const cases = [
    ['/agent-chat/allowances', {}],
    ['/agent-chat/allowances/revoke', { method: 'POST', body: { from_device_id: 1, target_device_id: 2 } }],
  ]
  for (const [path, opts] of cases) {
    const asClient = await s.http(path, { ...opts, token: clientToken })
    assert.equal(asClient.status, 404, `${path} must be gone`)
    // An agent must not learn more from the removal than a client does.
    const asAgent = await s.http(path, { ...opts, token: agA.token })
    assert.ok(asAgent.status === 404 || asAgent.status === 403, `${path} must not become readable to agents`)
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/agent-chat-consent.test.js`
Expected: FAIL — `GET /agent-chat/allowances` answers 200 for the client.

- [ ] **Step 3: Delete both routes**

In `src/http.js`, delete both `if (req.method === ... url.pathname === '/agent-chat/allowances'...)` blocks in full, including their comment headers. Narrow the import on line 9 to only what is still used:

```js
import { forgetDeviceAllowances } from './allowances.js'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/agent-chat-consent.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: pass. Delete the four `GET /agent-chat/allowances` / revoke tests in `test/agent-chat-consent.test.js` (from the `// --- Client allowance management` header down to the last of them) — they test routes that no longer exist.

- [ ] **Step 6: Commit**

```bash
git add src/http.js test/agent-chat-consent.test.js
git commit -m "feat(agent-chat): remove the allowance list and revoke endpoints"
```

---

### Task 4: Remove the admin CLI subcommand

**Files:**
- Modify: `bin/matron-admin.js` (import on line 13; the usage line on line 28; the comment on line 91; the `if (a === 'agent-chat' && b === 'allowances')` block at line 436)
- Test: `test/admin.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `matron-admin agent-chat allowances <username>` exits non-zero with the CLI's standard unknown-command error.

- [ ] **Step 1: Write the failing test**

Replace the two allowances tests in `test/admin.test.js` (`'admin CLI: agent-chat allowances lists pairs...'` and the allowances arm of `'...with an unknown username exits non-zero'`) with:

```js
test('admin CLI: the agent-chat allowances subcommand is gone', async () => {
  const db = openDb(':memory:')
  await createUser(db, 'dan', 'pw')
  await assert.rejects(runAdmin(db, ['agent-chat', 'allowances', 'dan']))
})
```

Leave the unknown-username test's `pending`/`approve`/`deny` arms intact; delete only its `allowances` arm.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/admin.test.js`
Expected: FAIL — `runAdmin` resolves instead of rejecting, because the subcommand still exists.

- [ ] **Step 3: Delete the subcommand**

In `bin/matron-admin.js`: delete the `import { addAllowance, removeAllowance, listAllowances } from '../src/allowances.js'` line; delete the `matron-admin agent-chat allowances <username> [--revoke <from_id>:<to_id>]` usage line; delete the whole `if (a === 'agent-chat' && b === 'allowances') { ... }` block; and fix the line-91 comment, which reads that `created_at` "is printed in full by `agent-chat allowances`" — drop that clause, keeping whatever the sentence says about the surviving commands.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/admin.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add bin/matron-admin.js test/admin.test.js
git commit -m "feat(admin): drop the agent-chat allowances subcommand"
```

---

### Task 5: Drop the table and delete the module

**Files:**
- Modify: `src/db.js` (the `agent_chat_allowances` DDL around line 79; a new migration beside the existing ones)
- Modify: `src/http.js` (the `forgetDeviceAllowances` import and its call at the device-revoke route, around line 485)
- Modify: `src/participants.js:128` (comment)
- Delete: `src/allowances.js`
- Delete: `test/allowances.test.js`
- Test: `test/db.test.js`

**Interfaces:**
- Consumes: nothing. Every caller was removed in Tasks 1-4 except the `forgetDeviceAllowances` call removed here.
- Produces: no `agent_chat_allowances` table in a fresh or migrated database.

- [ ] **Step 1: Write the failing test**

Append to `test/db.test.js`. The second case follows the migration-test pattern already in that file: seed through a raw `new Database` handle so `openDb`'s own schema does not get in the way.

```js
test('openDb: agent_chat_allowances is gone from a fresh database', () => {
  const db = openDb(':memory:')
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_chat_allowances'").get()
  assert.equal(t, undefined)
})

test('openDb: an existing agent_chat_allowances table is dropped on migrate', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'matron-allow-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'm.db')
  const raw = new Database(dbPath)
  raw.exec(`CREATE TABLE agent_chat_allowances(
    user_id INTEGER NOT NULL, from_device_id INTEGER NOT NULL,
    target_device_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, from_device_id, target_device_id))`)
  raw.prepare('INSERT INTO agent_chat_allowances VALUES(1,2,3,0)').run()
  raw.close()

  const db = openDb(dbPath)
  const found = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_chat_allowances'").get()
  assert.equal(found, undefined, 'the migration must drop the table, standing consent and all')
})
```

If `mkdtempSync`/`tmpdir`/`join`/`rmSync`/`Database` are not already imported at the top of `test/db.test.js`, copy the import lines from the existing migration test in that same file rather than inventing new ones.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/db.test.js`
Expected: both FAIL — the table is created by the schema and never dropped.

- [ ] **Step 3: Drop the table, delete the module**

In `src/db.js`, delete the `CREATE TABLE IF NOT EXISTS agent_chat_allowances(...)` statement, and add beside the other in-place migrations:

```js
  // Standing agent-chat consent ("always allow A -> B") is gone: every ask
  // parks for the user now. Dropped rather than left in place, because a
  // table of grants that nothing consults still reads like a live security
  // control to the next person who finds it.
  db.exec('DROP TABLE IF EXISTS agent_chat_allowances')
```

In `src/http.js`, delete the `forgetDeviceAllowances` import and its call in the device-revoke route, together with the comment above it about a new agent inheriting the revoked one's standing consent.

In `src/participants.js` line 128, the comment explains a rule by analogy to `forgetDeviceAllowances`. Rewrite it to state the rule directly — device ids are reused after a delete, so rows keyed on a stale id must be cleared — without naming the deleted function.

Then:

```bash
git rm src/allowances.js test/allowances.test.js
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/db.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: pass. `grep -rn "allowance" src bin test` must return nothing but the new `DROP TABLE` migration and its comment; anything else is a missed reference.

- [ ] **Step 6: Commit**

```bash
git add -A src bin test
git commit -m "feat(agent-chat): drop the allowances table and module"
```

---

### Task 6: Update the docs

**Files:**
- Modify: `README.md`
- Modify: `docs/protocol.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Find every reference**

Run: `grep -rn -i "allowance\|always_allow" README.md docs/protocol.md`
Expected: a list of lines describing the two endpoints, the `always_allow` field, and the standing-consent concept.

- [ ] **Step 2: Rewrite them**

For each hit: delete the endpoint and field documentation outright. Where prose describes the consent model, replace the standing-consent sentence with the rule that now holds — every agent-chat invite and join asks the user, every time, and there is no way to pre-approve a pair. Do not leave a "removed in a later version" note; the docs describe what the protocol is, not what it was.

Leave `docs/superpowers/plans/2026-08-07-agent-chat-consent.md` and `docs/superpowers/plans/2026-08-08-agent-journal-search.md` untouched — they are historical records of shipped work, not live documentation.

- [ ] **Step 3: Verify**

Run: `grep -rn -i "allowance\|always_allow" README.md docs/protocol.md`
Expected: no output.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: pass, unchanged from Task 5.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/protocol.md
git commit -m "docs: agent chat asks every time"
```

---

## Done when

- `npm test` passes with no allowance tests remaining and no new failures.
- `grep -rn -i "allowance\|always_allow" src bin test README.md docs/protocol.md` turns up no *live* allowance code and no *stale* documentation — not literally zero hits. Expect the `DROP TABLE agent_chat_allowances` migration and its comment in `src/db.js`, and prose that accurately describes the current behaviour: that there is no standing allowance and no fast path (e.g. `src/ws.js`'s `agent_invite`/`agent_join` comments), and that `always_allow` is rejected outright (e.g. `src/http.js`'s `POST /agent-chat/answer` handler and `bin/matron-admin.js`'s `--always-allow` rejection, plus the matching note in `docs/protocol.md`). Any hit that isn't one of those — a reachable allowance code path, or documentation of the old bypass, endpoints, or flag — is stale and must go.
- A seeded `agent_chat_allowances` row cannot change the behaviour of an `agent_invite`, because the table is gone.
