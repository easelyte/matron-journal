# Live Tool-Output Streaming — matron-journal Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the server half of the spec at `docs/superpowers/specs/2026-07-13-tool-output-streaming-design.md` — a `stream_append` agent op with server-side live buffers, viewing-time sync frames, finalize integration, and TTL deletion of full-log blobs.

**Architecture:** A new in-memory `makeToolStreamStore` module holds one capped buffer per live command stream; `ws.js` wires a `stream_append` op (offset-reconciled, self-healing via a `stream_resync` control frame), sync-frame delivery in the `viewing` handler, and buffer-free on `finalize`; `hub.js` learns to concatenate (not latest-wins) pending tool-stream appends; `retention.js` gains a second pass that deletes `live_log` blobs after a TTL.

**Tech Stack:** Node.js ≥20, ES modules, `ws`, better-sqlite3, `node:test` + `node:assert/strict`. No new dependencies.

## Global Constraints

- Offsets are **UTF-8 byte** positions in the command's logical output stream; the store keeps `Buffer` chunks internally and decodes only when producing sync content. Chunk boundaries always fall on character boundaries (the bridge guarantees this; the server never splits mid-chunk except at previously seen boundaries).
- Live chunks are NEVER written to the journal (`events` table) — ephemeral fan-out only.
- Defaults (each env-tunable, validated like existing knobs): per-buffer cap 1 MiB (`MATRON_TOOL_STREAM_MAX_BYTES`), buffer count cap 64 (`MATRON_TOOL_STREAM_MAX_BUFFERS`), idle age 30 min (`MATRON_TOOL_STREAM_IDLE_MS`), blob TTL 24 h (`MATRON_TOOL_LOG_TTL_HOURS`, 0/invalid disables, mirroring `MATRON_RETENTION_DAYS` semantics).
- `meta.command` is truncated server-side at 2 000 chars; `meta.tool` at 40 chars.
- Error frames use the existing shape: `{kind:'control', op:'error', code, ref:<op>}` with codes `forbidden` / `bad_request` only.
- Ephemeral tool-stream frames carry a `tool_stream` object and are distinguished from text overlays (`text`/`replace_text`) and `activity` frames by that key.
- Test runner: `npm test` runs `node --test 'test/**/*.js'`. Run single files with `node --test test/<file>.js`.
- Commit style: `feat:`/`test:`/`docs:` prefixes, one commit per green test cycle.

---

### Task 1: `src/tool-stream.js` — the live buffer store

**Files:**
- Create: `src/tool-stream.js`
- Test: `test/tool-stream.test.js`

**Interfaces:**
- Consumes: nothing (pure module, injected clock).
- Produces (used by Tasks 3, 4, 5, 6):
  - `makeToolStreamStore({ maxBytes = 1048576, maxBuffers = 64, idleMs = 1800000, now = Date.now } = {})` returning:
    - `append({ userId, convoId, ref, offset, chunk, meta }) ->`
      - `{ status: 'created'|'appended', offset: <byte offset of accepted text>, accepted: <string>, evicted: [entry] }`
      - `{ status: 'duplicate' }` (chunk entirely already held — nothing to fan out)
      - `{ status: 'resync', have: <number> }` (gap: caller sends `stream_resync`)
      - `{ status: 'need_meta' }` (buffer-creating frame without an object `meta` — caller maps to `bad_request`)
    - `buffersFor(userId, convoId) -> [{ ref, meta, start, end, content, headTruncated }]` (content is a decoded string)
    - `free(convoId, ref) -> entry|undefined`
    - `sweepIdle() -> [entry]` (freed stale entries)
    - `size() -> number`
  - `entry` objects expose `{ userId, convoId, ref, meta, start, end, lastAppendAt }`.

- [ ] **Step 1: Write the failing test**

Create `test/tool-stream.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeToolStreamStore } from '../src/tool-stream.js'

const META = { tool: 'Bash', command: 'npm test' }

test('create requires meta; offset>0 with no buffer asks resync from 0', () => {
  const s = makeToolStreamStore()
  assert.deepEqual(s.append({ userId: 1, convoId: 'c1', ref: 'r1', offset: 5, chunk: 'x', meta: META }), { status: 'resync', have: 0 })
  assert.equal(s.append({ userId: 1, convoId: 'c1', ref: 'r1', offset: 0, chunk: 'x' }).status, 'need_meta')
  const r = s.append({ userId: 1, convoId: 'c1', ref: 'r1', offset: 0, chunk: 'hello', meta: META })
  assert.equal(r.status, 'created')
  assert.equal(r.offset, 0)
  assert.equal(r.accepted, 'hello')
  assert.equal(s.size(), 1)
})

test('offset reconciliation: contiguous append, overlap trim, duplicate, gap', () => {
  const s = makeToolStreamStore()
  s.append({ userId: 1, convoId: 'c1', ref: 'r1', offset: 0, chunk: 'hello', meta: META })
  const r1 = s.append({ userId: 1, convoId: 'c1', ref: 'r1', offset: 5, chunk: ' world' })
  assert.deepEqual({ status: r1.status, offset: r1.offset, accepted: r1.accepted }, { status: 'appended', offset: 5, accepted: ' world' })
  // retry resends the last chunk plus new text — overlap trimmed
  const r2 = s.append({ userId: 1, convoId: 'c1', ref: 'r1', offset: 5, chunk: ' world!' })
  assert.deepEqual({ offset: r2.offset, accepted: r2.accepted }, { offset: 11, accepted: '!' })
  // fully-seen chunk is a duplicate — no fan-out
  assert.equal(s.append({ userId: 1, convoId: 'c1', ref: 'r1', offset: 0, chunk: 'hello' }).status, 'duplicate')
  // gap → resync with current end
  assert.deepEqual(s.append({ userId: 1, convoId: 'c1', ref: 'r1', offset: 99, chunk: 'x' }), { status: 'resync', have: 12 })
  const [b] = s.buffersFor(1, 'c1')
  assert.deepEqual({ start: b.start, end: b.end, content: b.content, headTruncated: b.headTruncated },
    { start: 0, end: 12, content: 'hello world!', headTruncated: false })
})

test('offsets are utf-8 bytes, not JS chars', () => {
  const s = makeToolStreamStore()
  s.append({ userId: 1, convoId: 'c1', ref: 'r1', offset: 0, chunk: 'é', meta: META }) // 2 bytes
  const r = s.append({ userId: 1, convoId: 'c1', ref: 'r1', offset: 2, chunk: '!' })
  assert.equal(r.status, 'appended')
  assert.equal(s.buffersFor(1, 'c1')[0].end, 3)
})

test('per-buffer cap drops the head; start advances; sync flags head_truncated', () => {
  const s = makeToolStreamStore({ maxBytes: 10 })
  s.append({ userId: 1, convoId: 'c1', ref: 'r1', offset: 0, chunk: '0123456789', meta: META })
  s.append({ userId: 1, convoId: 'c1', ref: 'r1', offset: 10, chunk: 'abcde' })
  const [b] = s.buffersFor(1, 'c1')
  assert.deepEqual({ start: b.start, end: b.end, content: b.content, headTruncated: b.headTruncated },
    { start: 5, end: 15, content: '56789abcde', headTruncated: true })
})

test('buffer count cap evicts oldest-idle; evicted entries are reported', () => {
  let t = 1000
  const s = makeToolStreamStore({ maxBuffers: 2, now: () => t })
  s.append({ userId: 1, convoId: 'c1', ref: 'a', offset: 0, chunk: 'x', meta: META })
  t = 2000
  s.append({ userId: 1, convoId: 'c1', ref: 'b', offset: 0, chunk: 'x', meta: META })
  t = 3000
  const r = s.append({ userId: 1, convoId: 'c2', ref: 'c', offset: 0, chunk: 'x', meta: META })
  assert.equal(r.evicted.length, 1)
  assert.equal(r.evicted[0].ref, 'a')
  assert.equal(s.size(), 2)
})

test('meta is sanitized: command truncated at 2000, tool at 40; buffersFor scoped by user', () => {
  const s = makeToolStreamStore()
  s.append({ userId: 1, convoId: 'c1', ref: 'r1', offset: 0, chunk: 'x', meta: { tool: 'T'.repeat(50), command: 'c'.repeat(3000) } })
  const [b] = s.buffersFor(1, 'c1')
  assert.equal(b.meta.command.length, 2000)
  assert.equal(b.meta.tool.length, 40)
  assert.deepEqual(s.buffersFor(2, 'c1'), []) // another user never sees it
})

test('free removes; sweepIdle frees only stale buffers and returns them', () => {
  let t = 0
  const s = makeToolStreamStore({ idleMs: 100, now: () => t })
  s.append({ userId: 1, convoId: 'c1', ref: 'a', offset: 0, chunk: 'x', meta: META })
  t = 50
  s.append({ userId: 1, convoId: 'c1', ref: 'b', offset: 0, chunk: 'x', meta: META })
  t = 149 // a is 149 old (< nothing — 149 > 100: stale), b is 99 old (fresh)
  const swept = s.sweepIdle()
  assert.deepEqual(swept.map((e) => e.ref), ['a'])
  assert.equal(s.size(), 1)
  assert.ok(s.free('c1', 'b'))
  assert.equal(s.size(), 0)
})

test('empty accepted remainder is a duplicate, never a zero-byte fan-out', () => {
  const s = makeToolStreamStore()
  s.append({ userId: 1, convoId: 'c1', ref: 'r1', offset: 0, chunk: 'abc', meta: META })
  assert.equal(s.append({ userId: 1, convoId: 'c1', ref: 'r1', offset: 3, chunk: '' }).status, 'duplicate')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tool-stream.test.js`
Expected: FAIL — `Cannot find module '.../src/tool-stream.js'`

- [ ] **Step 3: Write the implementation**

Create `src/tool-stream.js`:

```js
// In-memory live buffers for tool-output streaming (spec
// docs/superpowers/specs/2026-07-13-tool-output-streaming-design.md §6).
// One capped buffer per (convo, message_ref) while a command runs; chunks
// arrive via the `stream_append` op and NEVER touch the journal. Offsets are
// UTF-8 byte positions — chunks are stored as Buffers so byte math stays
// honest regardless of multi-byte characters; decode happens only in
// content() for sync frames. Nothing here survives a restart on purpose:
// the `stream_resync` control frame recovers the stream from the bridge's
// log file.

export const DEFAULT_MAX_BYTES = 1048576 // 1 MiB per buffer
export const DEFAULT_MAX_BUFFERS = 64
export const DEFAULT_IDLE_MS = 30 * 60 * 1000 // 30 min

const COMMAND_MAX_CHARS = 2000
const TOOL_MAX_CHARS = 40

const keyOf = (convoId, ref) => `${convoId} ${ref}`

export function makeToolStreamStore({
  maxBytes = DEFAULT_MAX_BYTES, maxBuffers = DEFAULT_MAX_BUFFERS,
  idleMs = DEFAULT_IDLE_MS, now = Date.now,
} = {}) {
  const buffers = new Map() // key -> entry

  const entryView = (e) => ({
    userId: e.userId, convoId: e.convoId, ref: e.ref, meta: e.meta,
    start: e.start, end: e.end, lastAppendAt: e.lastAppendAt,
  })

  function dropHead(e) {
    while (e.end - e.start > maxBytes) {
      const first = e.chunks[0]
      const excess = e.end - e.start - maxBytes
      if (first.length <= excess) {
        e.chunks.shift()
        e.start += first.length
      } else {
        e.chunks[0] = first.subarray(excess)
        e.start += excess
      }
    }
  }

  function evictOldest() {
    let oldest = null
    for (const e of buffers.values()) {
      if (!oldest || e.lastAppendAt < oldest.lastAppendAt) oldest = e
    }
    buffers.delete(keyOf(oldest.convoId, oldest.ref))
    return entryView(oldest)
  }

  return {
    append({ userId, convoId, ref, offset, chunk, meta }) {
      const key = keyOf(convoId, ref)
      let e = buffers.get(key)
      if (!e) {
        if (offset > 0) return { status: 'resync', have: 0 }
        if (!meta || typeof meta !== 'object') return { status: 'need_meta' }
        const evicted = []
        while (buffers.size >= maxBuffers) evicted.push(evictOldest())
        e = {
          userId, convoId, ref,
          meta: {
            tool: String(meta.tool ?? '').slice(0, TOOL_MAX_CHARS),
            command: String(meta.command ?? '').slice(0, COMMAND_MAX_CHARS),
          },
          start: 0, end: 0, chunks: [], lastAppendAt: now(),
        }
        buffers.set(key, e)
        const buf = Buffer.from(chunk, 'utf8')
        e.chunks.push(buf)
        e.end = buf.length
        dropHead(e)
        return { status: 'created', offset: 0, accepted: chunk, evicted }
      }
      if (offset > e.end) return { status: 'resync', have: e.end }
      const buf = Buffer.from(chunk, 'utf8')
      // Trim the already-held prefix (at-least-once retries resend overlap).
      // The cut lands at e.end, which is always a chunk boundary the bridge
      // previously sent — i.e. a character boundary — so decoding stays clean.
      const accepted = buf.subarray(e.end - offset)
      if (accepted.length === 0) return { status: 'duplicate' }
      const acceptedOffset = e.end
      e.chunks.push(accepted)
      e.end += accepted.length
      e.lastAppendAt = now()
      dropHead(e)
      return { status: 'appended', offset: acceptedOffset, accepted: accepted.toString('utf8'), evicted: [] }
    },

    buffersFor(userId, convoId) {
      const out = []
      for (const e of buffers.values()) {
        if (e.convoId !== convoId || e.userId !== userId) continue
        out.push({
          ref: e.ref, meta: e.meta, start: e.start, end: e.end,
          content: Buffer.concat(e.chunks).toString('utf8'),
          headTruncated: e.start > 0,
        })
      }
      return out
    },

    free(convoId, ref) {
      const key = keyOf(convoId, ref)
      const e = buffers.get(key)
      if (!e) return undefined
      buffers.delete(key)
      return entryView(e)
    },

    sweepIdle() {
      const cutoff = now() - idleMs
      const swept = []
      for (const [key, e] of buffers) {
        if (e.lastAppendAt < cutoff) {
          buffers.delete(key)
          swept.push(entryView(e))
        }
      }
      return swept
    },

    size() {
      return buffers.size
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tool-stream.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Run the full suite, then commit**

Run: `npm test`
Expected: all pass (no existing file imports the new module yet)

```bash
git add src/tool-stream.js test/tool-stream.test.js
git commit -m "feat: in-memory tool-stream buffer store (offset-reconciled, capped)"
```

---

### Task 2: `hub.js` — concatenating coalescing for tool-stream appends

**Files:**
- Modify: `src/hub.js` (the `sendEphemeral` method, ~lines 54–69)
- Test: `test/hub.test.js` (new file)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 3's fan-out):
  - `mergeEphemeral(prev, frame) -> frame` exported from `src/hub.js` — pure merge rule.
  - `hub.sendEphemeral` behaviour: pending tool-stream `append` frames for the same `(convo_id, message_ref)` merge by **concatenation** within the flush window; `sync`/`end`/legacy frames keep latest-wins.

- [ ] **Step 1: Write the failing test**

Create `test/hub.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeHub, mergeEphemeral } from '../src/hub.js'

const ts = (obj) => ({ kind: 'ephemeral', convo_id: 'c1', message_ref: 'r1', tool_stream: obj })

test('mergeEphemeral: contiguous appends concatenate; sync absorbs a contiguous append', () => {
  const a = ts({ event: 'append', offset: 0, chunk: 'ab' })
  const b = ts({ event: 'append', offset: 2, chunk: 'cd' })
  assert.deepEqual(mergeEphemeral(a, b).tool_stream, { event: 'append', offset: 0, chunk: 'abcd' })
  const sync = ts({ event: 'sync', meta: { tool: 'Bash', command: 'x' }, offset: 0, content: 'ab', head_truncated: false })
  const merged = mergeEphemeral(sync, b)
  assert.equal(merged.tool_stream.event, 'sync')
  assert.equal(merged.tool_stream.content, 'abcd')
})

test('mergeEphemeral: byte-based contiguity (multi-byte chars)', () => {
  const a = ts({ event: 'append', offset: 0, chunk: 'é' }) // 2 utf-8 bytes
  const b = ts({ event: 'append', offset: 2, chunk: '!' })
  assert.equal(mergeEphemeral(a, b).tool_stream.chunk, 'é!')
})

test('mergeEphemeral: end/sync/legacy/non-contiguous fall back to latest-wins', () => {
  const a = ts({ event: 'append', offset: 0, chunk: 'ab' })
  const end = ts({ event: 'end', reason: 'stale' })
  assert.equal(mergeEphemeral(a, end).tool_stream.event, 'end')
  const gap = ts({ event: 'append', offset: 99, chunk: 'z' })
  assert.equal(mergeEphemeral(a, gap).tool_stream.chunk, 'z')
  const act = { kind: 'ephemeral', convo_id: 'c1', activity: { state: 'thinking' } }
  const act2 = { kind: 'ephemeral', convo_id: 'c1', activity: { state: 'idle' } }
  assert.deepEqual(mergeEphemeral(act, act2), act2)
  assert.deepEqual(mergeEphemeral(null, a), a)
})

test('sendEphemeral flush delivers concatenated appends; text overlays still latest-wins', async () => {
  const hub = makeHub({ coalesceMs: 20 })
  const sent = []
  const conn = { userId: 1, deviceId: 7, kind: 'client', viewingConvoId: 'c1', ws: { readyState: 1, send: (d) => sent.push(JSON.parse(d)) } }
  hub.register(conn)
  hub.sendEphemeral(1, 'c1', ts({ event: 'append', offset: 0, chunk: 'ab' }))
  hub.sendEphemeral(1, 'c1', ts({ event: 'append', offset: 2, chunk: 'cd' }))
  hub.sendEphemeral(1, 'c1', { kind: 'ephemeral', convo_id: 'c1', message_ref: 'txt', replace_text: 'one' })
  hub.sendEphemeral(1, 'c1', { kind: 'ephemeral', convo_id: 'c1', message_ref: 'txt', replace_text: 'two' })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[0].tool_stream, { event: 'append', offset: 0, chunk: 'abcd' })
  assert.equal(sent[1].replace_text, 'two')
  hub.unregister(conn)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/hub.test.js`
Expected: FAIL — `mergeEphemeral` is not exported / SyntaxError on import

- [ ] **Step 3: Write the implementation**

In `src/hub.js`, add above `makeHub`:

```js
const byteLen = (s) => Buffer.byteLength(s, 'utf8')

// Coalescing rule for one pending slot. Legacy ephemerals (text overlays,
// activity) keep latest-wins — every frame carries full replacement state.
// Tool-stream appends are DELTAS, so latest-wins would drop output: a
// pending append (or sync) absorbs a contiguous next append by
// concatenation instead. Anything else — end frames, a fresh sync, a
// non-contiguous append (defensive; the store fans out contiguously) —
// replaces the slot.
export function mergeEphemeral(prev, frame) {
  if (!prev) return frame
  const p = prev.tool_stream
  const f = frame.tool_stream
  if (p && f && f.event === 'append') {
    if (p.event === 'append' && p.offset + byteLen(p.chunk) === f.offset) {
      return { ...prev, tool_stream: { ...p, chunk: p.chunk + f.chunk } }
    }
    if (p.event === 'sync' && p.offset + byteLen(p.content) === f.offset) {
      return { ...prev, tool_stream: { ...p, content: p.content + f.chunk } }
    }
  }
  return frame
}
```

Then change the body of `sendEphemeral` — replace the line

```js
        c._pending.set(key, frame) // latest wins
```

with

```js
        c._pending.set(key, mergeEphemeral(c._pending.get(key), frame))
```

(keep the comment on the `key` line above it; everything else in the method is unchanged).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/hub.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full suite (existing `stream`/`activity` behaviour must be untouched), then commit**

Run: `npm test`
Expected: all pass — `activity.test.js`, `ws.test.js`, `conformance.test.js` green

```bash
git add src/hub.js test/hub.test.js
git commit -m "feat: hub concatenates pending tool-stream appends instead of latest-wins"
```

---

### Task 3: `ws.js` — the `stream_append` op

**Files:**
- Modify: `src/ws.js` (imports; `attachWs` signature ~line 49; `handleOp` signature ~line 258; new case after `case 'stream'` ~line 392)
- Modify: `src/server.js` (create the store, pass to `attachWs`, expose on the handle, ~lines 151–170)
- Test: `test/tool-stream-ws.test.js` (new file)

**Interfaces:**
- Consumes: `makeToolStreamStore` (Task 1), `mergeEphemeral`-aware `sendEphemeral` (Task 2).
- Produces (used by Tasks 4–6 and the bridge):
  - Agent op `{op:'stream_append', convo_id, message_ref, offset, chunk, meta?}`.
  - Control reply `{kind:'control', op:'stream_resync', convo_id, message_ref, have}`.
  - Ephemeral `{kind:'ephemeral', convo_id, message_ref, tool_stream:{event:'append', offset, chunk}}`.
  - `notifyStale(hub, entry)` helper in `ws.js` (also used by Task 6's sweep): sends `tool_stream:{event:'end', reason:'stale'}`.
  - `attachWs({..., toolStreams})` and `handleOp({..., toolStreams})` parameters; `startServer` returns `toolStreams` on its handle.

- [ ] **Step 1: Write the failing test**

Create `test/tool-stream-ws.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'

async function setup(t, opts = {}) {
  const s = await startTestServer(opts)
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  agent.send({ op: 'convo_upsert', convo_id: 'sess-ts' })
  // barrier: convo_upsert applied once a subsequent journalled op round-trips
  agent.send({ op: 'read_marker', convo_id: 'sess-ts', up_to_seq: null })
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker')
  return { s, dan, ag, agent, client }
}

test('append fans out to the viewing client only; chunks reach it live', async (t) => {
  const { agent, client } = await setup(t)
  client.send({ op: 'viewing', convo_id: 'sess-ts' })
  // barrier: viewing applied once a journalled op on the same conn round-trips
  client.send({ op: 'read_marker', convo_id: 'sess-ts', up_to_seq: null })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker' && f.sender === 'user:dan')

  agent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu1', offset: 0, chunk: '$ npm test\n', meta: { tool: 'Bash', command: 'npm test' } })
  const f1 = await client.waitFor((f) => f.tool_stream?.event === 'append')
  assert.equal(f1.message_ref, 'tu1')
  assert.equal(f1.tool_stream.offset, 0)
  assert.equal(f1.tool_stream.chunk, '$ npm test\n')

  agent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu1', offset: 11, chunk: 'ok\n' })
  await client.waitFor((f) => f.tool_stream?.event === 'append' && f.tool_stream.chunk.includes('ok'))
})

test('gap triggers stream_resync with have; unknown buffer at offset>0 asks from 0', async (t) => {
  const { agent } = await setup(t)
  agent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu2', offset: 0, chunk: 'abc', meta: { tool: 'Bash', command: 'x' } })
  agent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu2', offset: 999, chunk: 'zzz' })
  const rs = await agent.waitFor((f) => f.op === 'stream_resync')
  assert.deepEqual({ ref: rs.message_ref, have: rs.have }, { ref: 'tu2', have: 3 })
  agent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'never-seen', offset: 50, chunk: 'x' })
  const rs2 = await agent.waitFor((f) => f.op === 'stream_resync' && f.message_ref === 'never-seen')
  assert.equal(rs2.have, 0)
})

test('validation and authz: client forbidden; non-owned convo forbidden; bad frames bad_request', async (t) => {
  const { s, agent, client } = await setup(t)
  client.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu3', offset: 0, chunk: 'x', meta: { tool: 'Bash', command: 'x' } })
  await client.waitFor((f) => f.op === 'error' && f.code === 'forbidden' && f.ref === 'stream_append')

  const eve = await createUser(s.db, 'eve', 'pw2')
  const evag = createAgent(s.db, eve.id, 'dev-9')
  const evilAgent = await makeWsClient(s.base, { token: evag.token, cursor: null })
  await evilAgent.waitFor((f) => f.op === 'hello_ok')
  evilAgent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu3', offset: 0, chunk: 'x', meta: { tool: 'Bash', command: 'x' } })
  await evilAgent.waitFor((f) => f.op === 'error' && f.code === 'forbidden')
  evilAgent.close()

  for (const bad of [
    { op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu4', offset: -1, chunk: 'x', meta: { tool: 'Bash', command: 'x' } },
    { op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu4', offset: 0, chunk: 42, meta: { tool: 'Bash', command: 'x' } },
    { op: 'stream_append', convo_id: 'sess-ts', offset: 0, chunk: 'x', meta: { tool: 'Bash', command: 'x' } },
    { op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu4', offset: 0, chunk: 'x' }, // creating frame, no meta
  ]) agent.send(bad)
  await agent.waitFor((f) =>
    agent.frames.filter((x) => x.op === 'error' && x.code === 'bad_request' && x.ref === 'stream_append').length >= 4)
  assert.equal(agent.ws.readyState, 1)
})

test('chunks never touch the journal', async (t) => {
  const { s, agent } = await setup(t)
  agent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu5', offset: 0, chunk: 'secret-live-bytes', meta: { tool: 'Bash', command: 'x' } })
  await new Promise((r) => setTimeout(r, 100))
  const rows = s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE payload LIKE '%secret-live-bytes%'").get()
  assert.equal(rows.n, 0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tool-stream-ws.test.js`
Expected: FAIL — `waitFor timeout` (op is silently ignored by the `default:` case; no error/resync/ephemeral ever arrives)

- [ ] **Step 3: Write the implementation**

In `src/server.js`:

```js
import { makeToolStreamStore } from './tool-stream.js'
```

In `startServer`, after `const hub = makeHub()` (~line 151), add (with `toolStreamOpts` added to the destructured options — `startServer({ ..., toolStreamOpts })`):

```js
  const toolStreams = makeToolStreamStore({
    maxBytes: resolveNumericEnv('MATRON_TOOL_STREAM_MAX_BYTES', process.env.MATRON_TOOL_STREAM_MAX_BYTES, 1048576),
    maxBuffers: resolveNumericEnv('MATRON_TOOL_STREAM_MAX_BUFFERS', process.env.MATRON_TOOL_STREAM_MAX_BUFFERS, 64),
    idleMs: resolveNumericEnv('MATRON_TOOL_STREAM_IDLE_MS', process.env.MATRON_TOOL_STREAM_IDLE_MS, 1800000),
    ...(toolStreamOpts || {}),
  })
```

Pass it to `attachWs` (`attachWs({ ..., toolStreams })`) and add `toolStreams` to the resolved handle object (next to `hub`).

In `src/ws.js`:

1. `attachWs` gains a `toolStreams` param and threads it to `handleOp` (`handleOp({ db, hub, conn, msg, pushPipeline, toolStreams })`).
2. `handleOp` signature becomes `handleOp({ db, hub, conn, msg, pushPipeline = noopPushPipeline, toolStreams })`.
3. Add the helper above `handleOp`:

```js
// A buffer freed WITHOUT a durable completion event (idle sweep, count-cap
// eviction) — tell anyone watching so the client doesn't render a live
// terminal forever. Normal completion needs no ephemeral: the finalized
// tool_output journal frame retires the overlay by message_ref.
export function notifyStale(hub, entry) {
  hub.sendEphemeral(entry.userId, entry.convoId, {
    kind: 'ephemeral', convo_id: entry.convoId, message_ref: entry.ref,
    tool_stream: { event: 'end', reason: 'stale' },
  })
}
```

4. Add the case after `case 'stream'` (~line 392):

```js
      case 'stream_append': {
        if (conn.kind !== 'agent') return fail('forbidden')
        if (!authorize(db, conn.userId, msg.convo_id)) return fail('forbidden')
        if (typeof msg.message_ref !== 'string' || !msg.message_ref) return fail('bad_request')
        if (typeof msg.chunk !== 'string' || !Number.isInteger(msg.offset) || msg.offset < 0) return fail('bad_request')
        const r = toolStreams.append({
          userId: conn.userId, convoId: msg.convo_id, ref: msg.message_ref,
          offset: msg.offset, chunk: msg.chunk, meta: msg.meta,
        })
        if (r.status === 'need_meta') return fail('bad_request', 'meta required on buffer-creating frame')
        if (r.status === 'resync') {
          conn.ws.send(JSON.stringify({
            kind: 'control', op: 'stream_resync',
            convo_id: msg.convo_id, message_ref: msg.message_ref, have: r.have,
          }))
          break
        }
        if (r.status === 'duplicate') break
        for (const ev of r.evicted) notifyStale(hub, ev)
        hub.sendEphemeral(conn.userId, msg.convo_id, {
          kind: 'ephemeral', convo_id: msg.convo_id, message_ref: msg.message_ref,
          tool_stream: { event: 'append', offset: r.offset, chunk: r.accepted },
        })
        break
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tool-stream-ws.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full suite, then commit**

Run: `npm test`
Expected: all pass

```bash
git add src/ws.js src/server.js test/tool-stream-ws.test.js
git commit -m "feat: stream_append agent op with offset reconciliation and resync"
```

---

### Task 4: `ws.js` — sync frames on `viewing`

**Files:**
- Modify: `src/ws.js` (`case 'viewing'`, ~line 292)
- Test: append to `test/tool-stream-ws.test.js`

**Interfaces:**
- Consumes: `toolStreams.buffersFor(userId, convoId)` (Task 1).
- Produces: `{kind:'ephemeral', convo_id, message_ref, tool_stream:{event:'sync', meta, offset, content, head_truncated}}` sent directly (uncoalesced) to the conn that sent `viewing` — one frame per active buffer, synchronously in the `viewing` handler (same event-loop turn, so no append can interleave before the sync).

- [ ] **Step 1: Write the failing test**

Append to `test/tool-stream-ws.test.js`:

```js
test('a client that starts viewing mid-command gets a sync frame with full scrollback', async (t) => {
  const { agent, client } = await setup(t)
  agent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu6', offset: 0, chunk: 'line one\n', meta: { tool: 'Bash', command: 'make build' } })
  agent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu6', offset: 9, chunk: 'line two\n' })
  // barrier on the agent conn: a journalled op round-trips → both appends applied
  agent.send({ op: 'read_marker', convo_id: 'sess-ts', up_to_seq: null })
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker')

  client.send({ op: 'viewing', convo_id: 'sess-ts' })
  const sync = await client.waitFor((f) => f.tool_stream?.event === 'sync')
  assert.equal(sync.message_ref, 'tu6')
  assert.deepEqual(sync.tool_stream.meta, { tool: 'Bash', command: 'make build' })
  assert.equal(sync.tool_stream.offset, 0)
  assert.equal(sync.tool_stream.content, 'line one\nline two\n')
  assert.equal(sync.tool_stream.head_truncated, false)
})

test('viewing a convo with no active streams sends no sync frames', async (t) => {
  const { client } = await setup(t)
  client.send({ op: 'viewing', convo_id: 'sess-ts' })
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(client.frames.some((f) => f.tool_stream), false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tool-stream-ws.test.js`
Expected: FAIL — first new test times out waiting for the sync frame

- [ ] **Step 3: Write the implementation**

Replace the `viewing` case in `handleOp`:

```js
      case 'viewing': {
        conn.viewingConvoId = msg.convo_id ?? null
        // Catch-up for live tool-output streams: whoever just started viewing
        // gets full scrollback-so-far, one sync frame per active buffer, sent
        // directly (not via hub coalescing) and synchronously — no append can
        // interleave before these because handleOp runs in one event-loop
        // turn. Scoped to the conn's own user; buffersFor enforces it too.
        if (conn.viewingConvoId && conn.kind === 'client') {
          for (const b of toolStreams.buffersFor(conn.userId, conn.viewingConvoId)) {
            conn.ws.send(JSON.stringify({
              kind: 'ephemeral', convo_id: conn.viewingConvoId, message_ref: b.ref,
              tool_stream: {
                event: 'sync', meta: b.meta, offset: b.start,
                content: b.content, head_truncated: b.headTruncated,
              },
            }))
          }
        }
        break
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tool-stream-ws.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full suite, then commit**

Run: `npm test`
Expected: all pass

```bash
git add src/ws.js test/tool-stream-ws.test.js
git commit -m "feat: sync frames deliver full scrollback when a client starts viewing"
```

---

### Task 5: `ws.js` — `finalize` gains `blob_ref` and frees the buffer

**Files:**
- Modify: `src/ws.js` (`case 'finalize'`, ~line 409)
- Test: append to `test/tool-stream-ws.test.js`

**Interfaces:**
- Consumes: `toolStreams.free(convoId, ref)` (Task 1).
- Produces: `finalize {convo_id, message_ref, type, payload, blob_ref?}` — `blob_ref` lands in the `events.blob_ref` column exactly like `publish`'s; a matching live buffer is freed after the append. The bridge's completion payload shape (spec §5.3) rides through unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/tool-stream-ws.test.js`:

```js
test('finalize retires the stream: buffer freed, blob_ref column set, overlay retired by journal frame', async (t) => {
  const { s, agent, client } = await setup(t)
  client.send({ op: 'viewing', convo_id: 'sess-ts' })
  client.send({ op: 'read_marker', convo_id: 'sess-ts', up_to_seq: null })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker' && f.sender === 'user:dan')

  agent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu7', offset: 0, chunk: 'building...\n', meta: { tool: 'Bash', command: 'make' } })
  await client.waitFor((f) => f.tool_stream?.event === 'append')

  agent.send({
    op: 'finalize', convo_id: 'sess-ts', message_ref: 'tu7', type: 'tool_output',
    blob_ref: 'blob-123',
    payload: { message_ref: 'tu7', command: 'make', exit_code: 0, denied: false, truncated: false, snippet: 'building...', blob_ref: 'blob-123', live_log: true },
  })
  const done = await client.waitFor((f) => f.kind === 'journal' && f.type === 'tool_output')
  assert.equal(done.payload.message_ref, 'tu7')
  assert.equal(done.payload.exit_code, 0)

  // the events row carries the blob_ref COLUMN (retention scans key on it)
  const row = s.db.prepare("SELECT blob_ref FROM events WHERE type='tool_output'").get()
  assert.equal(row.blob_ref, 'blob-123')

  // buffer is gone: a fresh viewing yields no sync frame for tu7
  assert.deepEqual(s.toolStreams.buffersFor(1, 'sess-ts'), [])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tool-stream-ws.test.js`
Expected: FAIL — `row.blob_ref` is `null` (finalize drops it today), and `buffersFor` still returns the tu7 buffer

- [ ] **Step 3: Write the implementation**

In the `finalize` case, change the `appendAndFan` call and add the free:

```js
        appendAndFan({
          userId: conn.userId, convoId: msg.convo_id,
          sender: `agent:${conn.name}`, type, payload: msg.payload,
          blobRef: msg.blob_ref ?? null,
          idemKey: `agent:${conn.deviceId}:fin:${msg.message_ref}`,
        })
        // Normal end-of-stream for a live tool-output overlay: the durable
        // event above retires the client's view (same message_ref in its
        // payload), so the buffer can go — no 'end' ephemeral needed. A no-op
        // for every finalize that never streamed.
        toolStreams.free(msg.convo_id, msg.message_ref)
        break
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tool-stream-ws.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Run the full suite, then commit**

Run: `npm test`
Expected: all pass (existing finalize tests unaffected — `blob_ref` is optional)

```bash
git add src/ws.js test/tool-stream-ws.test.js
git commit -m "feat: finalize passes blob_ref through and frees the live stream buffer"
```

---

### Task 6: `ws.js` — idle sweep wiring

**Files:**
- Modify: `src/ws.js` (the revocation `sweep` interval inside `attachWs`, ~lines 73–88)
- Test: append to `test/tool-stream-ws.test.js`

**Interfaces:**
- Consumes: `toolStreams.sweepIdle()` (Task 1), `notifyStale` (Task 3).
- Produces: stale buffers are freed on the existing 60 s sweep cadence (`revocationSweepMs` shrinks it in tests) and viewers receive `tool_stream:{event:'end', reason:'stale'}`.

- [ ] **Step 1: Write the failing test**

Append to `test/tool-stream-ws.test.js`:

```js
test('idle sweep frees stale buffers and notifies viewers with end{stale}', async (t) => {
  const { agent, client } = await setup(t, {
    revocationSweepMs: 50,
    toolStreamOpts: { idleMs: 1 }, // everything is stale immediately
  })
  client.send({ op: 'viewing', convo_id: 'sess-ts' })
  client.send({ op: 'read_marker', convo_id: 'sess-ts', up_to_seq: null })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker' && f.sender === 'user:dan')

  agent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu8', offset: 0, chunk: 'zzz', meta: { tool: 'Bash', command: 'sleep 999' } })
  const end = await client.waitFor((f) => f.tool_stream?.event === 'end')
  assert.equal(end.message_ref, 'tu8')
  assert.equal(end.tool_stream.reason, 'stale')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tool-stream-ws.test.js`
Expected: FAIL — timeout waiting for the `end` frame (nothing sweeps the store)

- [ ] **Step 3: Write the implementation**

In `attachWs`, inside the existing `sweep` interval callback, add as its FIRST statement (before the `hub.allConns()` early-return, which would skip the sweep when no conns exist — buffers must still expire):

```js
    // Tool-stream idle sweep piggybacks on this timer: a bridge that died
    // mid-command never finalizes, so its buffer must expire and any viewer
    // must learn the stream is dead. Runs before the early-return below —
    // buffers expire even when no connection is registered.
    for (const ev of toolStreams.sweepIdle()) notifyStale(hub, ev)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tool-stream-ws.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Run the full suite, then commit**

Run: `npm test`
Expected: all pass

```bash
git add src/ws.js test/tool-stream-ws.test.js
git commit -m "feat: idle sweep expires stale tool-stream buffers, notifying viewers"
```

---

### Task 7: `retention.js` — blob TTL pass (`runExpireLogs`) + offload guard

**Files:**
- Modify: `src/retention.js`
- Modify: `src/server.js` (`scheduleRetention`, ~lines 66–81; `startServer` opts)
- Test: append to `test/retention.test.js`

**Interfaces:**
- Consumes: `getBlob` from `src/db.js`.
- Produces (used by Task 8's CLI):
  - `runExpireLogs(db, { hours = 24, mediaDir }) -> { expired }` exported from `src/retention.js`.
  - `startServer` opt `toolLogTtlHours` (tests) / env `MATRON_TOOL_LOG_TTL_HOURS` (default 24; 0 or invalid disables with one warn line).

- [ ] **Step 1: Write the failing test**

Append to `test/retention.test.js` (match the file's existing imports/helpers — it already builds a db and seeds `tool_output` events for `runOffload`; reuse its patterns for user/convo seeding):

```js
import { runExpireLogs } from '../src/retention.js'
import { insertBlob, getBlob } from '../src/db.js'
import { writeBlobSync } from '../src/media.js'

// helper: append a finalized live-log tool_output event whose blob exists on disk
function seedLiveLog(db, mediaDir, { userId, convoId, ts, content = 'full log bytes' }) {
  const blob = writeBlobSync(mediaDir, Buffer.from(content, 'utf8'))
  insertBlob(db, { id: blob.id, ownerUserId: userId, contentType: 'text/plain', size: blob.size, sha256: blob.sha256, diskPath: blob.diskPath })
  const payload = { message_ref: 'tu-x', command: 'make', exit_code: 0, denied: false, truncated: false, snippet: 'tail', blob_ref: blob.id, live_log: true }
  const r = append(db, { userId, convoId, sender: 'agent:dev-2', type: 'tool_output', payload, blobRef: blob.id })
  db.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(ts, userId, r.seq)
  return { blob, seq: r.seq }
}

test('runExpireLogs deletes old live_log blobs, rewrites payload, NULLs the column', (t) => {
  const { db, mediaDir, userId, convoId } = freshDbWithConvo(t) // use this file's existing setup helper
  const old = seedLiveLog(db, mediaDir, { userId, convoId, ts: Date.now() - 48 * 3600000 })
  const fresh = seedLiveLog(db, mediaDir, { userId, convoId, ts: Date.now() - 1 * 3600000 })

  const r = runExpireLogs(db, { hours: 24, mediaDir })
  assert.equal(r.expired, 1)

  const oldRow = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(userId, old.seq)
  assert.equal(oldRow.blob_ref, null)
  const p = JSON.parse(oldRow.payload)
  assert.equal(p.blob_ref, null)
  assert.equal(p.blob_expired, true)
  assert.equal(p.snippet, 'tail') // rest of the payload preserved
  assert.equal(getBlob(db, old.blob.id), undefined)
  assert.equal(fs.existsSync(old.blob.diskPath), false)

  // the fresh one is untouched
  const freshRow = db.prepare('SELECT blob_ref FROM events WHERE user_id=? AND seq=?').get(userId, fresh.seq)
  assert.equal(freshRow.blob_ref, fresh.blob.id)
  assert.equal(fs.existsSync(fresh.blob.diskPath), true)

  // idempotent: second run finds nothing
  assert.equal(runExpireLogs(db, { hours: 24, mediaDir }).expired, 0)
})

test('runOffload skips blob_expired payloads (no pointless re-blob at 30d)', (t) => {
  const { db, mediaDir, userId, convoId } = freshDbWithConvo(t)
  const old = seedLiveLog(db, mediaDir, { userId, convoId, ts: Date.now() - 40 * 86400000 })
  runExpireLogs(db, { hours: 24, mediaDir })
  const r = runOffload(db, { days: 30, mediaDir })
  assert.equal(r.offloaded, 0)
  const row = db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(userId, old.seq)
  assert.equal(JSON.parse(row.payload).blob_expired, true) // untouched
})

test('runExpireLogs never touches offload-created blobs (no live_log flag)', (t) => {
  const { db, mediaDir, userId, convoId } = freshDbWithConvo(t)
  // an inline tool_output old enough for offload, which creates a NON-live_log blob
  const r0 = append(db, { userId, convoId, sender: 'agent:dev-2', type: 'tool_output', payload: { snippet: 'big', body: 'B'.repeat(500) } })
  db.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(Date.now() - 40 * 86400000, userId, r0.seq)
  runOffload(db, { days: 30, mediaDir })
  assert.equal(runExpireLogs(db, { hours: 24, mediaDir }).expired, 0)
})
```

Notes for the implementer: `test/retention.test.js` already has imports for `fs`, `append`, `runOffload`, and a setup helper that creates a temp `mediaDir`, a user, and a conversation — reuse its actual names (read the file first; if its helper differs from `freshDbWithConvo`, adapt the three tests to the local idiom rather than adding a duplicate helper).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/retention.test.js`
Expected: FAIL — `runExpireLogs` is not exported

- [ ] **Step 3: Write the implementation**

In `src/retention.js`, add imports:

```js
import fs from 'node:fs'
import { getBlob } from './db.js'
```

Add the guard in `runOffload`'s loop, directly after the `looksAlreadyOffloaded` check:

```js
    // A live-log payload whose blob the TTL pass already deleted: re-blobbing
    // the retained snippet payload would undo blob_expired for zero value.
    if (payload && payload.blob_expired) continue
```

Add the new pass at the bottom of the file:

```js
// Deletes full-log blobs attached to live-streamed tool_output events older
// than `hours` (spec §7 — retention parity with the old 24h viewer links).
// Only payloads marked live_log:true are touched; offload-created blobs
// never carry that flag. The payload keeps its snippet/command/exit_code and
// gains blob_expired:true; the blob_ref column is NULLed in the same
// transaction so no row ever references a deleted blob. File unlink happens
// after commit — a crash between the two leaves an orphan file (same stance
// as runOffload's write-before-commit, in the opposite direction).
export function runExpireLogs(db, { hours = 24, mediaDir }) {
  const cutoff = Date.now() - hours * 3600000
  const rows = db.prepare(
    "SELECT user_id, seq, payload, blob_ref FROM events WHERE type='tool_output' AND ts<? AND blob_ref IS NOT NULL"
  ).all(cutoff)

  let expired = 0
  const update = db.prepare('UPDATE events SET payload=?, blob_ref=NULL WHERE user_id=? AND seq=?')
  const deleteBlobRow = db.prepare('DELETE FROM blobs WHERE id=?')

  for (const row of rows) {
    let payload
    try { payload = JSON.parse(row.payload) } catch { payload = null }
    if (!payload || payload.live_log !== true) continue
    const blob = getBlob(db, row.blob_ref)
    const newPayload = JSON.stringify({ ...payload, blob_ref: null, blob_expired: true })
    db.transaction(() => {
      deleteBlobRow.run(row.blob_ref)
      update.run(newPayload, row.user_id, row.seq)
    })()
    if (blob) { try { fs.unlinkSync(blob.disk_path) } catch { /* already gone */ } }
    expired += 1
  }
  return { expired }
}
```

(`mediaDir` stays in the signature for parity with `runOffload`'s call sites even though the disk path comes from the blobs row.)

In `src/server.js`: import `runExpireLogs`; add a `resolveToolLogTtlHours(override)` mirroring `resolveRetentionDays` exactly (default 24, `MATRON_TOOL_LOG_TTL_HOURS` env, 0/invalid disables with one warn naming `MATRON_TOOL_LOG_TTL_HOURS`/`toolLogTtlHours`); extend `scheduleRetention` to take `toolLogTtlHours`, resolve both knobs, return `null` only when BOTH are disabled, and run each enabled pass in its `run()` with independent try/catch and its own log line (`retention: expired N live_log blob(s) older than Hh`). Add `toolLogTtlHours` to `startServer`'s destructured opts and thread it into the `scheduleRetention` call.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/retention.test.js`
Expected: PASS (existing offload tests + 3 new)

- [ ] **Step 5: Run the full suite, then commit**

Run: `npm test`
Expected: all pass

```bash
git add src/retention.js src/server.js test/retention.test.js
git commit -m "feat: 24h TTL deletion for live-log blobs with offload guard"
```

---

### Task 8: `matron-admin expire-logs`

**Files:**
- Modify: `bin/matron-admin.js` (USAGE string ~line 9, new command branch after the `offload` branch ~line 68)
- Test: append to `test/admin.test.js`

**Interfaces:**
- Consumes: `runExpireLogs` (Task 7).
- Produces: `matron-admin expire-logs [--hours N]` — manual run, same validation stance as `offload`'s `--days` (reject non-positive/non-integer values before computing a cutoff).

- [ ] **Step 1: Write the failing test**

Append to `test/admin.test.js` (mirror the file's existing `offload` test — it calls `runAdmin(db, [...])` and asserts on the returned string; reuse its db/seed helpers):

```js
test('admin expire-logs deletes old live_log blobs and reports the count', async (t) => {
  const { db, mediaDir, userId, convoId } = adminTestDb(t) // this file's existing setup idiom
  const blob = writeBlobSync(mediaDir, Buffer.from('log', 'utf8'))
  insertBlob(db, { id: blob.id, ownerUserId: userId, contentType: 'text/plain', size: blob.size, sha256: blob.sha256, diskPath: blob.diskPath })
  const r0 = append(db, {
    userId, convoId, sender: 'agent:dev-2', type: 'tool_output',
    payload: { snippet: 't', blob_ref: blob.id, live_log: true }, blobRef: blob.id,
  })
  db.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(Date.now() - 48 * 3600000, userId, r0.seq)

  const out = await runAdmin(db, ['expire-logs', '--hours', '24'])
  assert.match(out, /expired 1 live_log blob\(s\) older than 24h/)
})

test('admin expire-logs rejects a non-positive --hours', async (t) => {
  const { db } = adminTestDb(t)
  await assert.rejects(() => runAdmin(db, ['expire-logs', '--hours', '0']), /--hours must be a positive integer/)
})
```

(As in Task 7: read `test/admin.test.js` first and adapt the setup-helper name and `runAdmin` calling convention to what actually exists there.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/admin.test.js`
Expected: FAIL — unknown command (runAdmin returns/prints usage) or helper mismatch fixed during adaptation

- [ ] **Step 3: Write the implementation**

In `bin/matron-admin.js`: import `runExpireLogs` next to `runOffload`; add to USAGE:

```
  matron-admin expire-logs [--hours N]
```

Add after the `offload` branch, mirroring its structure and its validation stance (the offload branch's comment explains why a bad value must never reach the cutoff computation):

```js
  if (a === 'expire-logs') {
    const raw = flag(argv, '--hours') ?? '24'
    const hours = Number(raw)
    if (!Number.isInteger(hours) || hours <= 0) {
      throw new Error(`--hours must be a positive integer (got ${JSON.stringify(raw)})`)
    }
    const mediaDir = resolveMediaDir(dbPath)
    const r = runExpireLogs(db, { hours, mediaDir })
    return `expired ${r.expired} live_log blob(s) older than ${hours}h`
  }
```

(Match the `offload` branch's actual variable names for `dbPath`/`mediaDir` resolution — read the surrounding code and follow it exactly.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/admin.test.js`
Expected: PASS

- [ ] **Step 5: Run the full suite, then commit**

Run: `npm test`
Expected: all pass

```bash
git add bin/matron-admin.js test/admin.test.js
git commit -m "feat: matron-admin expire-logs command"
```

---

### Task 9: Conformance fixture + protocol docs

**Files:**
- Create: `test/fixtures/conformance/13_tool_stream.json`
- Modify: `docs/protocol.md` (WebSocket section + retention section)

**Interfaces:**
- Consumes: everything above.
- Produces: the golden wire-contract fixture matron-apple/matron-web build against, and the operational reference.

- [ ] **Step 1: Write the fixture (it IS the test)**

Create `test/fixtures/conformance/13_tool_stream.json`. Follow the `$bind`/`$ref`/`$type` conventions from `test/fixtures/conformance/README.md` and the barrier idiom from `10_activity.json` (per-connection FIFO: a journalled op round-tripping proves earlier fire-and-forget ops on the same conn were applied):

```json
{
  "name": "tool-output streaming: append fan-out to viewers, mid-join sync, resync on gap, finalize retires",
  "description": "stream_append chunks reach the viewing client as tool_stream append ephemerals and are never journaled. A device that starts viewing mid-command receives a sync frame with full scrollback (sent directly on the viewing conn — no barrier needed). An offset gap draws a stream_resync control frame with the server's high-water mark. finalize with blob_ref appends the durable tool_output completion (payload carries message_ref to retire the overlay) and frees the buffer — proven by a later viewing yielding no sync. Clients may not send stream_append (forbidden); a creating frame without meta is bad_request.",
  "seed": {
    "users": [{ "as": "dan", "name": "dan", "password": "fixture-pw-16" }],
    "agents": [{ "as": "bridge", "user": "dan", "name": "dev-2" }],
    "conversations": [{ "id": "c1", "owner": "dan" }]
  },
  "steps": [
    { "kind": "http", "method": "POST", "path": "/login",
      "body": { "username": "dan", "password": "fixture-pw-16", "device_name": "mac" },
      "expect": { "status": 200, "body": {
        "token": { "$bind": "mac_token" }, "device_id": { "$type": "integer" }, "user_id": { "$ref": "dan.user_id" }
      } } },
    { "kind": "http", "method": "POST", "path": "/login",
      "body": { "username": "dan", "password": "fixture-pw-16", "device_name": "ipad" },
      "expect": { "status": 200, "body": {
        "token": { "$bind": "ipad_token" }, "device_id": { "$type": "integer" }, "user_id": { "$ref": "dan.user_id" }
      } } },

    { "kind": "ws_open", "conn": "agent" },
    { "kind": "ws_send", "conn": "agent", "frame": { "op": "hello", "token": { "$ref": "bridge.token" }, "cursor": null } },
    { "kind": "ws_expect", "conn": "agent", "frame": { "kind": "control", "op": "hello_ok", "seq": 0 } },
    { "kind": "ws_open", "conn": "mac" },
    { "kind": "ws_send", "conn": "mac", "frame": { "op": "hello", "token": { "$ref": "mac_token" }, "cursor": 0 } },
    { "kind": "ws_expect", "conn": "mac", "frame": { "kind": "control", "op": "hello_ok", "seq": 0 } },

    { "kind": "ws_send", "conn": "mac", "frame": { "op": "viewing", "convo_id": "c1" } },
    { "kind": "ws_send", "conn": "mac", "frame": { "op": "send", "convo_id": "c1", "payload": { "body": "barrier: viewing applied" }, "local_id": "b1" } },
    { "kind": "ws_expect", "conn": "mac", "frame": {
      "kind": "journal", "seq": 1, "convo_id": "c1", "ts": { "$type": "integer" },
      "sender": "user:dan", "type": "text", "payload": { "body": "barrier: viewing applied" }
    } },

    { "kind": "ws_send", "conn": "agent", "frame": { "op": "stream_append", "convo_id": "c1", "message_ref": "tu1", "offset": 0, "chunk": "$ make\n", "meta": { "tool": "Bash", "command": "make" } } },
    { "kind": "ws_expect", "conn": "mac", "frame": {
      "kind": "ephemeral", "convo_id": "c1", "message_ref": "tu1",
      "tool_stream": { "event": "append", "offset": 0, "chunk": "$ make\n" }
    } },

    { "kind": "ws_open", "conn": "ipad" },
    { "kind": "ws_send", "conn": "ipad", "frame": { "op": "hello", "token": { "$ref": "ipad_token" }, "cursor": 1 } },
    { "kind": "ws_expect", "conn": "ipad", "frame": { "kind": "control", "op": "hello_ok", "seq": 1 } },
    { "kind": "ws_send", "conn": "ipad", "frame": { "op": "viewing", "convo_id": "c1" } },
    { "kind": "ws_expect", "conn": "ipad", "frame": {
      "kind": "ephemeral", "convo_id": "c1", "message_ref": "tu1",
      "tool_stream": { "event": "sync", "meta": { "tool": "Bash", "command": "make" }, "offset": 0, "content": "$ make\n", "head_truncated": false }
    } },

    { "kind": "ws_send", "conn": "agent", "frame": { "op": "stream_append", "convo_id": "c1", "message_ref": "tu1", "offset": 999, "chunk": "lost" } },
    { "kind": "ws_expect", "conn": "agent", "frame": {
      "kind": "control", "op": "stream_resync", "convo_id": "c1", "message_ref": "tu1", "have": 7
    } },

    { "kind": "ws_send", "conn": "mac", "frame": { "op": "stream_append", "convo_id": "c1", "message_ref": "tu9", "offset": 0, "chunk": "x", "meta": { "tool": "Bash", "command": "x" } } },
    { "kind": "ws_expect", "conn": "mac", "frame": { "kind": "control", "op": "error", "code": "forbidden", "ref": "stream_append" } },
    { "kind": "ws_send", "conn": "agent", "frame": { "op": "stream_append", "convo_id": "c1", "message_ref": "tu2", "offset": 0, "chunk": "no meta" } },
    { "kind": "ws_expect", "conn": "agent", "frame": { "kind": "control", "op": "error", "code": "bad_request", "ref": "stream_append", "detail": { "$ignore": true } } },

    { "kind": "ws_send", "conn": "agent", "frame": {
      "op": "finalize", "convo_id": "c1", "message_ref": "tu1", "type": "tool_output", "blob_ref": "blob-fixture",
      "payload": { "message_ref": "tu1", "command": "make", "exit_code": 0, "denied": false, "truncated": false, "snippet": "$ make", "blob_ref": "blob-fixture", "live_log": true }
    } },
    { "kind": "ws_expect", "conn": "mac", "frame": {
      "kind": "journal", "seq": 2, "convo_id": "c1", "ts": { "$type": "integer" },
      "sender": "agent:dev-2", "type": "tool_output",
      "payload": { "message_ref": "tu1", "command": "make", "exit_code": 0, "denied": false, "truncated": false, "snippet": "$ make", "blob_ref": "blob-fixture", "live_log": true }
    } },

    { "kind": "ws_send", "conn": "mac", "frame": { "op": "viewing", "convo_id": "c1" } },
    { "kind": "ws_expect_none", "conn": "mac", "ms": 250 }
  ]
}
```

Adapt mechanics to the runner as needed (read `test/fixtures/conformance/README.md` first): if `ws_expect` matches frames strictly, the `$ignore` on `detail` may need the README's actual wildcard convention; if the runner requires every expected frame field, drop optional ones to match what the server actually sends.

- [ ] **Step 2: Run the conformance suite**

Run: `node --test test/conformance.test.js`
Expected: PASS including `conformance: tool-output streaming... (13_tool_stream.json)`

- [ ] **Step 3: Update `docs/protocol.md`**

In the WebSocket section: add `stream_append` to the agent-ops list; then append these bullets after the `activity` bullet:

```markdown
- Agent `stream_append {convo_id, message_ref, offset, chunk, meta?}` streams
  live tool output (never journaled). `message_ref` is the tool_use_id;
  `offset` is the UTF-8 byte position of `chunk` in the command's output.
  The server holds a capped in-memory buffer per stream (1 MiB /
  `MATRON_TOOL_STREAM_MAX_BYTES`; 64 buffers /
  `MATRON_TOOL_STREAM_MAX_BUFFERS`; 30 min idle /
  `MATRON_TOOL_STREAM_IDLE_MS`). `meta {tool, command}` is required on the
  buffer-creating (offset-0) frame. Offset rules: `== end` appends, `< end`
  trims the overlap (idempotent retries), `> end` (or unknown buffer at
  offset > 0) draws `{kind:'control', op:'stream_resync', convo_id,
  message_ref, have}` — resend from byte `have`. Ownership as `activity`
  (`forbidden`); agent connections only.
- Viewing clients receive tool-stream ephemerals distinguished by the
  `tool_stream` key: `{event:'append', offset, chunk}` live (consecutive
  appends coalesce by concatenation, not latest-wins); on starting to view,
  one `{event:'sync', meta, offset, content, head_truncated}` per active
  stream (full scrollback so far — clients trim any append whose offset
  precedes their accumulated end); `{event:'end', reason:'stale'}` when the
  idle sweep frees a buffer whose bridge died. Normal completion sends no
  ephemeral: the durable `tool_output` event arrives with the same
  `message_ref` in its payload and retires the live view.
- `finalize` accepts an optional top-level `blob_ref` (same passthrough as
  `publish`) and frees the matching live-stream buffer.
```

In the retention section, append:

```markdown
Live-log blobs (`tool_output` payloads with `live_log: true`, uploaded by
bridges at command completion) are deleted after
`MATRON_TOOL_LOG_TTL_HOURS` (default 24; 0/invalid disables): the blob file
and its `blobs` row are removed and the payload is rewritten to
`{..., blob_ref: null, blob_expired: true}` — the snippet stays forever.
Offload skips `blob_expired` payloads. Manual run:
`matron-admin expire-logs [--hours N]`.
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/conformance/13_tool_stream.json docs/protocol.md
git commit -m "test: tool-stream conformance fixture; docs: protocol reference"
```

---

## Self-Review (run after writing, fixed inline)

- **Spec coverage:** §5.1 → Tasks 1+3; §5.2 sync/append/end → Tasks 2, 3, 4, 6; §5.3 finalize/blob_ref/message_ref → Task 5; §6 store+caps+sweep → Tasks 1, 3, 6; §7 TTL+offload guard+admin CLI → Tasks 7, 8; §11 conformance+docs → Task 9. Bridge-side items (§9) are the second plan (separate repo).
- **Types:** `append()` result statuses (`created/appended/duplicate/resync/need_meta`) used identically in Tasks 1 and 3; `buffersFor(userId, convoId)` two-arg form used in Tasks 4 and 5; `notifyStale(hub, entry)` defined Task 3, reused Task 6; `runExpireLogs(db, {hours, mediaDir})` defined Task 7, reused Task 8.
- **Known adaptation points (explicitly flagged in-task):** helper names in `test/retention.test.js` / `test/admin.test.js`, and the conformance runner's wildcard convention — the implementer reads the existing file first and follows the local idiom.
