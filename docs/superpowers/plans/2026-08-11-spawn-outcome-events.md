# Durable Spawn Outcomes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Journal every agent-spawn resolution as a durable `spawn_outcome` event in the parent conversation, alongside (never instead of) the existing ephemeral outcome frame.

**Architecture:** One new helper `emitSpawnOutcome` in `src/spawns.js` (best-effort `appendAndBroadcast` + unconditional `hub.sendToDevice`), routed through by all five terminal-transition sites. One RETURNING addition (`expireApproved` gains `from_convo_id`). One `snippetOf` mapping. No schema change, no new endpoint.

**Tech Stack:** Node 22 ESM, better-sqlite3, `node:test` + `node:assert/strict`. Spec: `docs/superpowers/specs/2026-08-11-spawn-outcome-events-design.md`.

## Global Constraints

- Exactly-once **emission** stays guarded by the callers' state-scoped UPDATEs — `emitSpawnOutcome` itself must contain no state logic and no dedupe.
- A failed durable append must NEVER suppress the ephemeral frame (epitaph precedent, `src/spawns.js` `fail()`).
- `spawn_outcome` is server-minted only: NOT added to `AGENT_PUBLISH_TYPES` (`src/ws.js`), NOT added to `isClientOnlyEvent` (`src/journal.js`) — agent-visible by design.
- Payload field names mirror the ephemeral frame exactly: `request_id`, `outcome`, `room_id` (started only), `child_convo_id` (started only), `error_code` (failed only). Absent fields are omitted, never null.
- Full suite must stay green: `npm test` (glob `'test/**/*.js'`; bare `test/` fails MODULE_NOT_FOUND). Under load the runner sometimes cancels whole files (testTimeoutFailure) — re-run the file alone to confirm a flake.
- Commit style: `feat(spawn): …` / `test(spawn): …`, matching repo history.

---

### Task 1: `emitSpawnOutcome` + five call sites + snippet

**Files:**
- Modify: `src/spawns.js` (new export; two internal call sites in `approveSpawn`)
- Modify: `src/http.js` (deny branch of `/agent-spawn/answer`, ~line 435)
- Modify: `src/ws.js` (the two sweep loops, ~lines 271–303)
- Modify: `src/journal.js` (`snippetOf`)
- Test: `test/agent-spawn.test.js` (extend), snippet assertion beside existing snippetOf coverage

**Interfaces:**
- Produces: `emitSpawnOutcome(db, hub, { userId, fromDeviceId, fromConvoId, requestId, outcome, roomId?, childConvoId?, errorCode? })` — exported from `src/spawns.js`; Task 2's tests consume it only indirectly (via the ops/sweeps).
- Consumes: `appendAndBroadcast` (`src/journal.js`), `hub.sendToDevice` — both already imported/available in `spawns.js`.

- [ ] **Step 1: Write the failing tests** — extend `test/agent-spawn.test.js` using the existing `spawnFleet`/`parkedSpawn` fixtures (`test/agent-spawn.test.js:9,238`) and the hand-rolled bridge-side `start` reply pattern (`:285-311`). Helper + five cases:

```js
// Shared predicate for the new durable event.
const isOutcomeEvent = (f, spawnId) => f.kind === 'journal' && f.type === 'spawn_outcome'
  && f.payload?.request_id === spawnId

// 1. started: approve, answer the start RPC ok — client sees the event in
//    the PARENT convo with room_id + child_convo_id; payload has no error_code.
// 2. declined: deny via POST /agent-spawn/answer — event {outcome:'declined'},
//    no room_id/child_convo_id/error_code keys at all (assert via
//    Object.keys(payload).sort()).
// 3. failed: bridge answers the start RPC with an error — event
//    {outcome:'failed', error_code:<code>}.
// 4. expired: park, then run the sweep with a tiny TTL (existing expiry test
//    at :390 shows the drive pattern) — event {outcome:'expired'}.
// 5. orphaned: claim approve directly in the DB then sweep (existing orphan
//    tests :400,:499 show the pattern) — event {outcome:'failed',
//    error_code:'orphaned'}.
// Each case also asserts the ephemeral {kind:'spawn',event:'outcome'} frame
// still arrives at the parent agent — the durable event is additive.
```

Also add the snippet assertion (same file or wherever `'🤝 Agent spawn request'` is asserted today):

```js
assert.equal(snippetOf('spawn_outcome', { outcome: 'started' }), '🚀 Spawned session started')
assert.equal(snippetOf('spawn_outcome', { outcome: 'declined' }), '🚫 Spawn declined')
assert.equal(snippetOf('spawn_outcome', { outcome: 'expired' }), '⌛ Spawn request expired')
assert.equal(snippetOf('spawn_outcome', { outcome: 'failed' }), '❌ Spawn failed')
assert.equal(snippetOf('spawn_outcome', {}), '[spawn_outcome]')
```

- [ ] **Step 2: Run the new tests, verify they fail** — `node --test test/agent-spawn.test.js` → the five new cases fail (no `spawn_outcome` event ever appended); snippet case fails with `[spawn_outcome]`.

- [ ] **Step 3: Implement.** In `src/spawns.js`:

```js
// Durable outcome + ephemeral frame, in that order — the settlement
// reporter every terminal transition routes through. The append is
// best-effort: from_convo_id may point at a conversation deleted since the
// ask was parked (append() throws on a missing/foreign conversation), and
// telling the parent is the one thing this tail cannot skip — so a failed
// append is logged and the frame still goes out. Exactly-once emission
// stays the CALLER's job (the state-scoped UPDATEs): by the time this
// runs, the caller has already won the transition. Agent-visible on
// purpose (not in isClientOnlyEvent): the parent owns from_convo_id, so
// replay hands it the outcome durably — the fix for the at-most-once
// delivery gap protocol.md used to document.
export function emitSpawnOutcome(db, hub, { userId, fromDeviceId, fromConvoId, requestId, outcome, roomId, childConvoId, errorCode }) {
  const extras = {
    ...(roomId ? { room_id: roomId } : {}),
    ...(childConvoId ? { child_convo_id: childConvoId } : {}),
    ...(errorCode ? { error_code: errorCode } : {}),
  }
  try {
    appendAndBroadcast(db, hub, {
      userId, convoId: fromConvoId, sender: 'journal', type: 'spawn_outcome',
      payload: { request_id: requestId, outcome, ...extras },
    })
  } catch (err) {
    console.error('emitSpawnOutcome: durable outcome append failed', err)
  }
  hub.sendToDevice(userId, fromDeviceId, { kind: 'spawn', event: 'outcome', request_id: requestId, outcome, ...extras })
}
```

Replace the five existing `hub.sendToDevice` outcome sends (each keeps its surrounding comments; only the send call changes — the epitaph writes stay exactly where they are):

1. `src/spawns.js` `fail()`:
   `emitSpawnOutcome(db, hub, { userId: row.user_id, fromDeviceId: row.from_device_id, fromConvoId: row.from_convo_id, requestId: row.id, outcome: 'failed', errorCode: safeCode })`
2. `src/spawns.js` started branch:
   `emitSpawnOutcome(db, hub, { userId: row.user_id, fromDeviceId: row.from_device_id, fromConvoId: row.from_convo_id, requestId: row.id, outcome: 'started', roomId, childConvoId: r.result.convo_id })`
3. `src/http.js` deny branch (add `emitSpawnOutcome` to the `./spawns.js` import):
   `emitSpawnOutcome(db, hub, { userId: who.userId, fromDeviceId: row.from_device_id, fromConvoId: row.from_convo_id, requestId: request_id, outcome: 'declined' })`
4. `src/ws.js` `expireSpawns` loop (add `emitSpawnOutcome` to the `./spawns.js` import):
   `emitSpawnOutcome(db, hub, { userId: row.user_id, fromDeviceId: row.from_device_id, fromConvoId: row.from_convo_id, requestId: row.id, outcome: 'expired' })`
5. `src/ws.js` `expireApproved` loop:
   `emitSpawnOutcome(db, hub, { userId: row.user_id, fromDeviceId: row.from_device_id, fromConvoId: row.from_convo_id, requestId: row.id, outcome: 'failed', errorCode: 'orphaned' })`

In `src/spawns.js` `expireApproved`, extend RETURNING: `RETURNING id, user_id, from_device_id, room_id, from_convo_id` (update the doc comment's "no per-row lookups" list accordingly).

In `src/journal.js` `snippetOf`, before the generic `p.snippet` rule:

```js
if (type === 'spawn_outcome') {
  const m = { started: '🚀 Spawned session started', declined: '🚫 Spawn declined', expired: '⌛ Spawn request expired', failed: '❌ Spawn failed' }
  return m[p.outcome] || '[spawn_outcome]'
}
```

- [ ] **Step 4: Run the tests, verify they pass** — `node --test test/agent-spawn.test.js` and the snippet file.
- [ ] **Step 5: Commit** — `feat(spawn): journal every spawn resolution as a durable spawn_outcome event`

---

### Task 2: Hardening tests + protocol docs

**Files:**
- Test: `test/agent-spawn.test.js` (extend), `test/search.test.js` (extend)
- Modify: `docs/protocol.md` (Agent-spawned sessions → "Outcome frames" area)

**Interfaces:**
- Consumes: the wired behavior from Task 1 (no new exports).

- [ ] **Step 1: Write the failing/verifying tests:**

```js
// a. Unforgeable: an agent `publish` with type:'spawn_outcome' is rejected
//    bad_request (AGENT_PUBLISH_TYPES whitelist — mirror the forged-card
//    test at agent-spawn.test.js:135; also cover `finalize`).
// b. Append-failure resilience: park a spawn, then DELETE the parent
//    conversation row directly (db.prepare("DELETE FROM conversations
//    WHERE id=?")), then deny — the 200 still returns, the ephemeral
//    outcome frame still reaches the parent agent, no spawn_outcome event
//    exists, nothing throws (server still answers a subsequent request).
// c. Agent replay visibility: after a resolved spawn, a FRESH parent-agent
//    connection's hello replay contains the spawn_outcome event (contrast:
//    the card itself is absent — client-only). Mirror the replay test
//    shape at agent-chat-consent.test.js:104.
// d. Client replay visibility: a fresh client connection's replay contains
//    BOTH the card and the spawn_outcome event.
// e. Search: spawn_outcome bodies are not indexed — extend the non-indexed
//    types coverage in test/search.test.js (pattern at :32) with a
//    spawn_outcome event.
```

- [ ] **Step 2: Run them** — (a)–(e) should pass already if Task 1 is correct EXCEPT they must be verified to fail against intentionally broken code paths where practicable; at minimum run and confirm green with Task 1 in place, and confirm (b) fails if `emitSpawnOutcome`'s try/catch is temporarily removed (do not commit that).
- [ ] **Step 3: Update `docs/protocol.md`:** in the "Outcome frames" subsection, after the frame JSON: document the durable `spawn_outcome` event (shape mirrors the frame; appended best-effort into `from_convo_id`; sender `journal`; agent-visible — the parent receives it in fan-out and replay; unforgeable via the publish whitelist; snippet strings). Rewrite the "Emission is exactly-once; delivery is at-most-once" paragraph: frame delivery to live sockets remains at-most-once, but the journaled event is the durable record — replacing the "recorded follow-up" sentence, which this change implements.
- [ ] **Step 4: Full suite** — `npm test`, all green.
- [ ] **Step 5: Commit** — `test(spawn): pin spawn_outcome forgery, resilience, replay + document the durable outcome contract`
