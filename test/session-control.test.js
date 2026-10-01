import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { validateSessionControl } from '../src/session-control.js'

// Coordinator session control (spec: matron-bridge
// 2026-09-29-coordinator-session-control-design.md, "Decisions"): the
// Coordinator's bridge sends `session_control`; the journal checks the
// caller IS the Coordinator, resolves the target session's box, acks,
// issues a journal-originated RPC and relays the reply as a result frame.

// parent = the Coordinator's bridge (dev-6, owns 'parent-convo');
// target = the bridge running the session being controlled (eric, 'tgt').
async function fleet(t, { connectTarget = true, serverOpts = {}, coordinator = true } = {}) {
  // A short relay timeout: an RPC a test leaves unanswered must not hold a
  // ref'd 30 s broker timer past the file's own timeout.
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

test('session_control: Coordinator -> journal -> target bridge -> result frame', async (t) => {
  const { parent, target } = await fleet(t)
  parent.send({ op: 'session_control', request_id: 'r1', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'compact', reason: 'context at 92%' })
  const sent = await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'sent')
  assert.equal(sent.request_id, 'r1')
  assert.equal('target_waking' in sent, false)
  const req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control')
  assert.equal(req.request.from_device_id, 0)
  assert.deepEqual(req.request.params, { convo_id: 'tgt', action: 'compact', reason: 'context at 92%', from_convo_id: 'parent-convo', from_name: 'dev-6' })
  target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'deferred', box: 'eric' } })
  const res = await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'result')
  assert.deepEqual(res, { kind: 'session_control', event: 'result', request_id: 'r1', ok: true, result: { applied: 'deferred', box: 'eric' } })
})

test('session_control: set_model carries model and agent; carry_on carries message and when; strings are sanitised', async (t) => {
  const { parent, target } = await fleet(t)
  parent.send({ op: 'session_control', request_id: 'r2', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'set_model', model: 'sonnet\u0007', agent: 'claude' })
  let req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control')
  assert.deepEqual(req.request.params, { convo_id: 'tgt', action: 'set_model', model: 'sonnet', agent: 'claude', from_convo_id: 'parent-convo', from_name: 'dev-6' })
  target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: false, error: { code: 'bad_model', detail: 'unknown alias\u001b[0m' } })
  const err = await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'result' && f.request_id === 'r2')
  assert.deepEqual(err, { kind: 'session_control', event: 'result', request_id: 'r2', ok: false, error: { code: 'bad_model', detail: 'unknown alias [0m' } })
  target.frames.length = 0
  parent.send({ op: 'session_control', request_id: 'r3', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'carry_on', message: '  carry on with the tests ', when: 'after_limit_reset' })
  req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control')
  assert.deepEqual(req.request.params, { convo_id: 'tgt', action: 'carry_on', message: 'carry on with the tests', when: 'after_limit_reset', from_convo_id: 'parent-convo', from_name: 'dev-6' })
  target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'scheduled' } })
  await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'result' && f.request_id === 'r3')
})

test('session_control: refused for a non-Coordinator, a client, a foreign or private target, self, and bad params', async (t) => {
  const { s, dan, parent, target, client, parentDev } = await fleet(t, { coordinator: false })
  const base = { op: 'session_control', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'compact' }
  parent.send({ ...base, request_id: 'n1' })
  let e = await errorFrame(parent, 'n1'); assert.equal(e.code, 'forbidden'); assert.equal(e.detail, 'not_coordinator')
  setCoordinatorConvoId(s.db, dan.id, 'parent-convo')
  client.send({ ...base, request_id: 'n2' })
  e = await errorFrame(client); assert.equal(e.code, 'forbidden')
  // a conversation this device does not own as from_convo_id
  parent.send({ ...base, request_id: 'n3', from_convo_id: 'tgt', target_convo_id: 'parent-convo' })
  e = await errorFrame(parent, 'n3'); assert.equal(e.code, 'not_found')
  // unknown target / another user's target
  parent.send({ ...base, request_id: 'n4', target_convo_id: 'nope' })
  e = await errorFrame(parent, 'n4'); assert.equal(e.code, 'not_found')
  const other = await createUser(s.db, 'eve', 'pw')
  const otherDev = createAgent(s.db, other.id, 'evebox')
  s.db.prepare("INSERT INTO conversations(id, owner_user_id, title, session_state, last_seq, unread_count, snippet, created_at, agent_device_id) VALUES('eves', ?, 'x', 'waiting', 0, 0, '', 1, ?)").run(other.id, otherDev.deviceId)
  parent.send({ ...base, request_id: 'n5', target_convo_id: 'eves' })
  e = await errorFrame(parent, 'n5'); assert.equal(e.code, 'not_found')
  // a private box's session is hidden from an ordinary Coordinator
  s.db.prepare('UPDATE devices SET private=1 WHERE name=?').run('eric')
  parent.send({ ...base, request_id: 'n6' })
  e = await errorFrame(parent, 'n6'); assert.equal(e.code, 'not_found')
  // …but visible to a Coordinator on a private box
  s.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(parentDev.deviceId)
  parent.send({ ...base, request_id: 'n7' })
  await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'sent' && f.request_id === 'n7')
  const n7req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control')
  target.send({ op: 'agent_response', request_id: n7req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'now' } })
  await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'result' && f.request_id === 'n7')
  s.db.prepare('UPDATE devices SET private=0 WHERE name IN (?, ?)').run('eric', 'dev-6')
  // a sub-conversation cannot be the Coordinator's from_convo_id
  s.db.prepare("INSERT INTO conversations(id, owner_user_id, title, session_state, last_seq, unread_count, snippet, created_at, agent_device_id, parent_convo_id) VALUES('sub', ?, 'sub', 'waiting', 0, 0, '', 1, ?, 'parent-convo')").run(dan.id, parentDev.deviceId)
  parent.send({ ...base, request_id: 'n7b', from_convo_id: 'sub' })
  e = await errorFrame(parent, 'n7b'); assert.equal(e.code, 'not_found')
  // self
  parent.send({ ...base, request_id: 'n8', target_convo_id: 'parent-convo' })
  e = await errorFrame(parent, 'n8'); assert.equal(e.code, 'bad_request')
  // bad params, each with request_id echoed
  const bad = [
    { action: 'reboot' }, { action: 'set_model' }, { action: 'set_model', agent: 'gemini' }, { action: 'set_model', model: 'x'.repeat(65) },
    { action: 'carry_on' }, { action: 'carry_on', message: '   ' }, { action: 'carry_on', message: 'go', when: 'later' }, { action: 'compact', reason: 'r'.repeat(201) },
  ]
  for (const [i, b] of bad.entries()) {
    parent.send({ ...base, ...b, request_id: `b${i}` })
    e = await errorFrame(parent, `b${i}`); assert.equal(e.code, 'bad_request', JSON.stringify(b))
  }
  parent.frames.length = 0
  parent.send({ ...base, request_id: '' })
  e = await errorFrame(parent); assert.equal(e.code, 'bad_request'); assert.equal('request_id' in e, false)
})

test('validateSessionControl: pure shape checks', () => {
  assert.deepEqual(validateSessionControl({ request_id: 'a', from_convo_id: 'c', target_convo_id: 't', action: 'compact' }), { ok: true, rid: 'a', params: { convo_id: 't', action: 'compact' } })
  assert.equal(validateSessionControl({ request_id: 'a', from_convo_id: 'c', target_convo_id: 't', action: 'set_model', agent: 'codex' }).params.agent, 'codex')
  assert.equal(validateSessionControl({}).code, 'bad_request')
  assert.equal(validateSessionControl({ request_id: 'a', from_convo_id: 'c', target_convo_id: 't', action: 'compact', reason: 5 }).code, 'bad_request')
})

test('session_control: at most 8 requests in flight per connection', async (t) => {
  // Settlement is controlled here, not by a timer: the eight stay pending
  // until c8 has been refused, then the target answers them one by one.
  const { parent, target } = await fleet(t, { serverOpts: { sessionControlTimeoutMs: 10000 } })
  for (let i = 0; i < 9; i++) parent.send({ op: 'session_control', request_id: `c${i}`, from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'compact' })
  const e = await errorFrame(parent, 'c8'); assert.equal(e.code, 'conflict')
  for (let i = 0; i < 8; i++) await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'sent' && f.request_id === `c${i}`)
  const reqs = []
  await target.waitFor((f) => { if (f.kind === 'rpc' && f.request?.method === 'session_control' && !reqs.includes(f.request.request_id)) reqs.push(f.request.request_id); return reqs.length === 8 })
  for (const rid of reqs) target.send({ op: 'agent_response', request_id: rid, to_device_id: 0, ok: true, result: { applied: 'now' } })
  for (let i = 0; i < 8; i++) await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'result' && f.request_id === `c${i}`)
  parent.send({ op: 'session_control', request_id: 'c9', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'compact' })
  await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'sent' && f.request_id === 'c9')
  const req9 = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control' && !reqs.includes(f.request.request_id))
  target.send({ op: 'agent_response', request_id: req9.request.request_id, to_device_id: 0, ok: true, result: { applied: 'now' } })
  await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'result' && f.request_id === 'c9')
})
