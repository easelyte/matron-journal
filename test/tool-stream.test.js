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
  assert.equal(s.append({ userId: 1, convoId: 'c1', ref: 'rA', offset: 0, chunk: 'x', meta: ['Bash'] }).status, 'need_meta')
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

test('head drop never splits a multi-byte character', () => {
  const s = makeToolStreamStore({ maxBytes: 8 })
  s.append({ userId: 1, convoId: 'c1', ref: 'r1', offset: 0, chunk: '😀😀', meta: META }) // 8 bytes
  s.append({ userId: 1, convoId: 'c1', ref: 'r1', offset: 8, chunk: 'X' })
  const [b] = s.buffersFor(1, 'c1')
  assert.equal(b.content, '😀X')
  assert.equal(b.start, 4)
  assert.equal(b.end, 9)
  assert.equal(b.headTruncated, true)
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
