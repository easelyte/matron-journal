import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { setDeviceConsentUserOnly } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { append } from '../src/journal.js'
import { WHY_CARRY_ON_USER_ONLY } from '../src/session-control.js'

// Coordinator session control (spec: matron-bridge
// 2026-09-29-coordinator-session-control-design.md, "Decisions"): the
// Coordinator's bridge sends `session_control`; the journal checks the
// caller IS the Coordinator, resolves the target session's box, acks,
// issues a journal-originated RPC and relays the reply as a result frame.

// parent = the Coordinator's bridge (box-6, owns 'parent-convo');
// target = the bridge running the session being controlled (opal, 'tgt').
async function fleet(t, { connectTarget = true, serverOpts = {}, coordinator = true } = {}) {
  const s = await startTestServer({ sessionControlTimeoutMs: 2000, ...serverOpts })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const parentDev = createAgent(s.db, alice.id, 'box-6')
  const targetDev = createAgent(s.db, alice.id, 'opal')
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
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
  s.db.prepare("INSERT INTO conversations(id, owner_user_id, title, session_state, last_seq, unread_count, snippet, created_at, agent_device_id) VALUES('tgt', ?, 'work', 'waiting', 0, 0, '', 1, ?)").run(alice.id, targetDev.deviceId)
  if (coordinator) setCoordinatorConvoId(s.db, alice.id, 'parent-convo')
  parent.frames.length = 0; target && (target.frames.length = 0); client.frames.length = 0
  return { s, alice, parentDev, targetDev, clientToken: login.json.token, parent, target, client }
}

const errorFrame = (conn, rid) => conn.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.ref === 'session_control' && (rid === undefined || f.request_id === rid))

test('session_control: an asleep wakeable target is acked with target_waking and the RPC goes out once it connects; an unwakeable one is agent_unreachable', async (t) => {
  const calls = []
  const waker = { enabled: true, wake: (name) => { calls.push(name); return true } }
  const { s, parent, targetDev } = await fleet(t, { connectTarget: false, serverOpts: { waker, spawnWakeWaitMs: 5000 } })
  parent.send({ op: 'session_control', request_id: 'w1', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'compact' })
  const sent = await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'sent' && f.request_id === 'w1')
  assert.equal(sent.target_waking, true)
  assert.deepEqual(calls, ['opal'])
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

test('session_control: a box made user-only while it is being woken gets no carry-on; a compact still goes', async (t) => {
  const waker = { enabled: true, wake: () => true }
  const { s, parent, targetDev } = await fleet(t, { connectTarget: false, serverOpts: { waker, spawnWakeWaitMs: 5000 } })
  parent.send({ op: 'session_control', request_id: 'k1', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'carry_on', message: 'carry on' })
  parent.send({ op: 'session_control', request_id: 'k2', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'compact' })
  await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'sent' && f.request_id === 'k2')
  setDeviceConsentUserOnly(s.db, targetDev.deviceId, true)
  const target = await makeWsClient(s.base, { token: targetDev.token, cursor: null })
  t.after(() => target.close())
  await target.waitFor((f) => f.op === 'hello_ok')
  const res = await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'result' && f.request_id === 'k1', 4000)
  assert.deepEqual(res, { kind: 'session_control', event: 'result', request_id: 'k1', ok: false, error: { code: 'forbidden', detail: 'user_only', why: WHY_CARRY_ON_USER_ONLY } })
  const req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control', 4000)
  assert.equal(req.request.params.action, 'compact')
  assert.equal(target.frames.filter((f) => f.kind === 'rpc').length, 1)
})

// The user's words in the Coordinator's conversation, as a carry-on's cause.
const userSays = (f, ago = 0) => {
  const { seq } = append(f.s.db, { userId: f.alice.id, convoId: 'parent-convo', sender: 'user:alice', type: 'text', payload: { body: 'yes, tell it to carry on' } })
  if (ago) f.s.db.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(Date.now() - ago, f.alice.id, seq)
  return { seq, causes: [{ kind: 'user_message', ref: `parent-convo:${seq}` }] }
}

test('session_control: a carry-on on the user\'s own word reaches an asleep user-only box once it wakes; the window is measured from the request, not the wake', async (t) => {
  const waker = { enabled: true, wake: () => true }
  const f = await fleet(t, { connectTarget: false, serverOpts: { waker, spawnWakeWaitMs: 5000 } })
  const { s, parent, targetDev } = f
  setDeviceConsentUserOnly(s.db, targetDev.deviceId, true)
  // Nine and a half minutes old on arrival: inside the window then, and it
  // would be outside it if the wait were counted.
  const said = userSays(f, 10 * 60 * 1000 - 1500)
  parent.send({ op: 'session_control', request_id: 'v1', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'carry_on', message: 'carry on', causes: said.causes })
  const sent = await parent.waitFor((x) => x.kind === 'session_control' && x.event === 'sent' && x.request_id === 'v1')
  assert.equal(sent.target_waking, true)
  await new Promise((r) => setTimeout(r, 2000))
  const target = await makeWsClient(s.base, { token: targetDev.token, cursor: null })
  t.after(() => target.close())
  await target.waitFor((x) => x.op === 'hello_ok')
  const req = await target.waitFor((x) => x.kind === 'rpc' && x.request?.method === 'session_control', 4000)
  assert.equal(req.request.params.message, 'carry on')
  target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'now' } })
  const res = await parent.waitFor((x) => x.kind === 'session_control' && x.event === 'result' && x.request_id === 'v1')
  assert.equal(res.ok, true)
})

test('session_control: a box made user-only during the wake takes a carry-on that has the user\'s word behind it, and none whose cause no longer checks out', async (t) => {
  const waker = { enabled: true, wake: () => true }
  const f = await fleet(t, { connectTarget: false, serverOpts: { waker, spawnWakeWaitMs: 5000 } })
  const { s, parent, targetDev, alice } = f
  const kept = userSays(f)
  const gone = userSays(f)
  parent.send({ op: 'session_control', request_id: 'y1', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'carry_on', message: 'with the word', causes: kept.causes })
  parent.send({ op: 'session_control', request_id: 'y2', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'carry_on', message: 'without it', causes: gone.causes })
  await parent.waitFor((x) => x.kind === 'session_control' && x.event === 'sent' && x.request_id === 'y2')
  setDeviceConsentUserOnly(s.db, targetDev.deviceId, true)
  // The second carry-on's cited message is no longer the user's by the
  // journal's record when the wait ends.
  s.db.prepare("UPDATE events SET sender='agent:box-6' WHERE user_id=? AND seq=?").run(alice.id, gone.seq)
  const target = await makeWsClient(s.base, { token: targetDev.token, cursor: null })
  t.after(() => target.close())
  await target.waitFor((x) => x.op === 'hello_ok')
  const res = await parent.waitFor((x) => x.kind === 'session_control' && x.event === 'result' && x.request_id === 'y2', 4000)
  assert.deepEqual(res, { kind: 'session_control', event: 'result', request_id: 'y2', ok: false, error: { code: 'forbidden', detail: 'user_only', why: WHY_CARRY_ON_USER_ONLY } })
  const req = await target.waitFor((x) => x.kind === 'rpc' && x.request?.method === 'session_control', 4000)
  assert.equal(req.request.params.message, 'with the word')
  assert.equal(target.frames.filter((x) => x.kind === 'rpc').length, 1)
  target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'now' } })
  await parent.waitFor((x) => x.kind === 'session_control' && x.event === 'result' && x.request_id === 'y1')
})
