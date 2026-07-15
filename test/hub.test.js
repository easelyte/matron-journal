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

function rpcConn(userId, deviceId, kind) {
  const sent = []
  return { userId, deviceId, kind, sent, ws: { readyState: 1, send: (s) => sent.push(JSON.parse(s)) } }
}

test('sendRpcRequest delivers to the most recently registered live socket only', () => {
  const hub = makeHub()
  const older = rpcConn(1, 7, 'agent')
  const newer = rpcConn(1, 7, 'agent')
  hub.register(older)
  hub.register(newer)
  const delivered = hub.sendRpcRequest(1, 7, { kind: 'rpc', request: { request_id: 'r1' } })
  assert.equal(delivered, true)
  assert.equal(older.sent.length, 0)
  assert.equal(newer.sent.length, 1)
  assert.equal(newer.sent[0].request.request_id, 'r1')
})

test('sendRpcRequest falls back to an older live socket when the newest is closed', () => {
  const hub = makeHub()
  const older = rpcConn(1, 7, 'agent')
  const newer = rpcConn(1, 7, 'agent')
  hub.register(older)
  hub.register(newer)
  newer.ws.readyState = 3
  assert.equal(hub.sendRpcRequest(1, 7, { x: 1 }), true)
  assert.equal(older.sent.length, 1)
  assert.equal(newer.sent.length, 0)
})

test('sendRpcRequest returns false when no live socket matches the device', () => {
  const hub = makeHub()
  const wrongDevice = rpcConn(1, 8, 'agent')
  hub.register(wrongDevice)
  assert.equal(hub.sendRpcRequest(1, 7, { x: 1 }), false)   // no such device
  assert.equal(hub.sendRpcRequest(2, 8, { x: 1 }), false)   // wrong user
  assert.equal(wrongDevice.sent.length, 0)
})

test('sendRpcResponse multicasts to every live socket of the device, skipping closed ones', () => {
  const hub = makeHub()
  const a = rpcConn(1, 5, 'client')
  const b = rpcConn(1, 5, 'client')
  const closed = rpcConn(1, 5, 'client')
  const otherDevice = rpcConn(1, 6, 'client')
  for (const c of [a, b, closed, otherDevice]) hub.register(c)
  closed.ws.readyState = 3
  hub.sendRpcResponse(1, 5, { kind: 'rpc', response: { request_id: 'r1' } })
  assert.equal(a.sent.length, 1)
  assert.equal(b.sent.length, 1)
  assert.equal(closed.sent.length, 0)
  assert.equal(otherDevice.sent.length, 0)
})
