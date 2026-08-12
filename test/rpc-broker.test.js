import test from 'node:test'
import assert from 'node:assert/strict'
import { makeRpcBroker } from '../src/rpc-broker.js'

function fakeHub(delivered = true) {
  const sent = []
  return { sent, sendRpcRequest(userId, deviceId, frame) { sent.push({ userId, deviceId, frame }); return delivered } }
}

test('issue sends a journal-originated rpc frame and resolves on the reply', async () => {
  const broker = makeRpcBroker()
  const hub = fakeHub()
  const p = broker.issue(hub, 1, 42, 'start', { workdir: '/w', prompt: 'go', room_id: 'r' }, { timeoutMs: 5000 })
  assert.equal(hub.sent.length, 1)
  const { frame } = hub.sent[0]
  assert.equal(frame.kind, 'rpc')
  assert.equal(frame.request.from_device_id, 0) // journal-originated marker
  assert.equal(frame.request.method, 'start')
  assert.deepEqual(frame.request.params, { workdir: '/w', prompt: 'go', room_id: 'r' })
  const handled = broker.resolve(frame.request.request_id, { userId: 1, deviceId: 42, msg: { ok: true, result: { convo_id: 'child' } } })
  assert.equal(handled, true)
  assert.deepEqual(await p, { ok: true, result: { convo_id: 'child' } })
  assert.equal(broker.pendingCount(), 0)
})

test('unreachable target resolves immediately without waiting for the timeout', async () => {
  const broker = makeRpcBroker()
  const r = await broker.issue(fakeHub(false), 1, 42, 'start', {}, { timeoutMs: 60000 })
  assert.deepEqual(r, { ok: false, error: { code: 'agent_unreachable' } })
  assert.equal(broker.pendingCount(), 0)
})

test('hub.sendRpcRequest throwing resolves immediately with send_failed, not reject', async () => {
  const broker = makeRpcBroker()
  const badHub = { sendRpcRequest() { throw new Error('boom') } }
  const r = await broker.issue(badHub, 1, 42, 'start', {}, { timeoutMs: 60000 })
  assert.deepEqual(r, { ok: false, error: { code: 'send_failed' } })
  assert.equal(broker.pendingCount(), 0)
})

test('timeout resolves {ok:false, code:timeout}; a late reply is then unclaimed', async () => {
  const broker = makeRpcBroker()
  const hub = fakeHub()
  const r = await broker.issue(hub, 1, 42, 'start', {}, { timeoutMs: 20 })
  assert.deepEqual(r, { ok: false, error: { code: 'timeout' } })
  const rid = hub.sent[0].frame.request.request_id
  assert.equal(broker.resolve(rid, { userId: 1, deviceId: 42, msg: { ok: true, result: {} } }), false)
})

test('a reply from the wrong device or user does not resolve (spoof guard)', async () => {
  const broker = makeRpcBroker()
  const hub = fakeHub()
  const p = broker.issue(hub, 1, 42, 'start', {}, { timeoutMs: 5000 })
  const rid = hub.sent[0].frame.request.request_id
  assert.equal(broker.resolve(rid, { userId: 1, deviceId: 99, msg: { ok: true, result: {} } }), false)
  assert.equal(broker.resolve(rid, { userId: 2, deviceId: 42, msg: { ok: true, result: {} } }), false)
  assert.equal(broker.pendingCount(), 1) // still waiting for the real device
  broker.resolve(rid, { userId: 1, deviceId: 42, msg: { ok: false, error: { code: 'bad_workdir' } } })
  assert.deepEqual(await p, { ok: false, error: { code: 'bad_workdir' } })
})

test('a bridge error reply passes through code and detail', async () => {
  const broker = makeRpcBroker()
  const hub = fakeHub()
  const p = broker.issue(hub, 1, 42, 'start', {}, { timeoutMs: 5000 })
  broker.resolve(hub.sent[0].frame.request.request_id, { userId: 1, deviceId: 42, msg: { ok: false, error: { code: 'spawn_failed', detail: 'boom' } } })
  assert.deepEqual(await p, { ok: false, error: { code: 'spawn_failed', detail: 'boom' } })
})
