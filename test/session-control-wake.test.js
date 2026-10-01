import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'

// Coordinator session control (spec: matron-bridge
// 2026-09-29-coordinator-session-control-design.md, "Decisions"): the
// Coordinator's bridge sends `session_control`; the journal checks the
// caller IS the Coordinator, resolves the target session's box, acks,
// issues a journal-originated RPC and relays the reply as a result frame.

// parent = the Coordinator's bridge (dev-6, owns 'parent-convo');
// target = the bridge running the session being controlled (eric, 'tgt').
async function fleet(t, { connectTarget = true, serverOpts = {}, coordinator = true } = {}) {
  const s = await startTestServer({ sessionControlTimeoutMs: 2000, ...serverOpts })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const parentDev = createAgent(s.db, dan.id, 'dev-6')
  const targetDev = createAgent(s.db, dan.id, 'eric')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const parent = await makeWsClient(s.base, { token: parentDev.token, cursor: null })
  const target = connectTarget ? await makeWsClient(s.base, { token: targetDev.token, cursor: null }) : null
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: null })
  await parent.waitFor((f) => f.op === 'hello_ok')
  if (target) await target.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { parent.close(); target?.close(); client.close() })
  parent.send({ op: 'convo_upsert', convo_id: 'parent-convo', title: 'coordinator', session_state: 'running' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status' && f.convo_id === 'parent-convo')
  // The target session's conversation, owned by the target box.
  s.db.prepare("INSERT INTO conversations(id, owner_user_id, title, session_state, last_seq, unread_count, snippet, created_at, agent_device_id) VALUES('tgt', ?, 'work', 'waiting', 0, 0, '', 1, ?)").run(dan.id, targetDev.deviceId)
  if (coordinator) setCoordinatorConvoId(s.db, dan.id, 'parent-convo')
  parent.frames.length = 0; target && (target.frames.length = 0); client.frames.length = 0
  return { s, dan, parentDev, targetDev, clientToken: login.json.token, parent, target, client }
}

const errorFrame = (conn, rid) => conn.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.ref === 'session_control' && (rid === undefined || f.request_id === rid))

test('session_control: an asleep wakeable target is acked with target_waking and the RPC goes out once it connects; an unwakeable one is agent_unreachable', async (t) => {
  const calls = []
  const waker = { enabled: true, wake: (name) => { calls.push(name); return true } }
  const { s, parent, targetDev } = await fleet(t, { connectTarget: false, serverOpts: { waker, spawnWakeWaitMs: 5000 } })
  parent.send({ op: 'session_control', request_id: 'w1', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'compact' })
  const sent = await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'sent' && f.request_id === 'w1')
  assert.equal(sent.target_waking, true)
  assert.deepEqual(calls, ['eric'])
  const target = await makeWsClient(s.base, { token: targetDev.token, cursor: null })
  t.after(() => target.close())
  await target.waitFor((f) => f.op === 'hello_ok')
  const req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control', 4000)
  target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'now' } })
  const res = await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'result' && f.request_id === 'w1')
  assert.equal(res.ok, true)
})

test('session_control: an offline target that cannot be woken is agent_unreachable; a silent target relays timeout', async (t) => {
  const { parent } = await fleet(t, { connectTarget: false, serverOpts: { waker: { enabled: false, wake: () => false } } })
  parent.send({ op: 'session_control', request_id: 'u1', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'compact' })
  const e = await errorFrame(parent, 'u1'); assert.equal(e.code, 'agent_unreachable')
  const f2 = await fleet(t, { serverOpts: { sessionControlTimeoutMs: 200 } })
  f2.parent.send({ op: 'session_control', request_id: 'u2', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'compact' })
  await f2.target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control')
  const res = await f2.parent.waitFor((f) => f.kind === 'session_control' && f.event === 'result' && f.request_id === 'u2', 3000)
  assert.deepEqual(res, { kind: 'session_control', event: 'result', request_id: 'u2', ok: false, error: { code: 'timeout' } })
})


test('session_control: a wake that never completes relays agent_unreachable as the result', async (t) => {
  const waker = { enabled: true, wake: () => true }
  const { parent } = await fleet(t, { connectTarget: false, serverOpts: { waker, spawnWakeWaitMs: 100 } })
  parent.send({ op: 'session_control', request_id: 'w2', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'compact' })
  await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'sent' && f.request_id === 'w2')
  const res = await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'result' && f.request_id === 'w2', 3000)
  assert.deepEqual(res, { kind: 'session_control', event: 'result', request_id: 'w2', ok: false, error: { code: 'agent_unreachable' } })
})
