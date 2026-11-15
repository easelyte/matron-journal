import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { validateSessionControl, CARRY_ON_USER_ONLY_WINDOW_MS, WHY_CARRY_ON_USER_ONLY } from '../src/session-control.js'
import { append, upsertConversation } from '../src/journal.js'
import { createRoutine } from '../src/routines.js'
import { createSpawnRequest } from '../src/spawns.js'
import { setDeviceConsentUserOnly, setDeviceProtected } from '../src/db.js'

// Coordinator session control (spec: matron-bridge
// 2026-09-29-coordinator-session-control-design.md, "Decisions"): the
// Coordinator's bridge sends `session_control`; the journal checks the
// caller IS the Coordinator, resolves the target session's box, acks,
// issues a journal-originated RPC and relays the reply as a result frame.

// parent = the Coordinator's bridge (box-6, owns 'parent-convo');
// target = the bridge running the session being controlled (opal, 'tgt').
async function fleet(t, { connectTarget = true, serverOpts = {}, coordinator = true } = {}) {
  // A short relay timeout: an RPC a test leaves unanswered must not hold a
  // ref'd 30 s broker timer past the file's own timeout.
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

test('session_control: Coordinator -> journal -> target bridge -> result frame', async (t) => {
  const { parent, target } = await fleet(t)
  parent.send({ op: 'session_control', request_id: 'r1', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'compact', reason: 'context at 92%' })
  const sent = await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'sent')
  assert.equal(sent.request_id, 'r1')
  assert.equal('target_waking' in sent, false)
  const req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control')
  assert.equal(req.request.from_device_id, 0)
  assert.deepEqual(req.request.params, { convo_id: 'tgt', action: 'compact', reason: 'context at 92%', from_convo_id: 'parent-convo', from_name: 'box-6' })
  target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'deferred', box: 'opal' } })
  const res = await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'result')
  assert.deepEqual(res, { kind: 'session_control', event: 'result', request_id: 'r1', ok: true, result: { applied: 'deferred', box: 'opal' } })
})

test('session_control: set_model carries model and agent; carry_on carries message and when; strings are sanitised', async (t) => {
  const { s, parent, target } = await fleet(t)
  parent.send({ op: 'session_control', request_id: 'r2', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'set_model', model: 'sonnet\u0007', agent: 'claude' })
  let req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control')
  assert.deepEqual(req.request.params, { convo_id: 'tgt', action: 'set_model', model: 'sonnet', agent: 'claude', from_convo_id: 'parent-convo', from_name: 'box-6' })
  target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: false, error: { code: 'bad_model', detail: 'unknown alias\u001b[0m' } })
  const err = await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'result' && f.request_id === 'r2')
  assert.deepEqual(err, { kind: 'session_control', event: 'result', request_id: 'r2', ok: false, error: { code: 'bad_model', detail: 'unknown alias [0m' } })
  target.frames.length = 0
  const causes = [{ kind: 'user_message', ref: 'parent-convo:3', at: 1 }]
  parent.send({ op: 'session_control', request_id: 'r3', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'carry_on', message: '  carry on with the tests ', when: 'after_limit_reset', causes })
  req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control')
  const { carry_on_id: carryOnId, ...rest } = req.request.params
  assert.deepEqual(rest, { convo_id: 'tgt', action: 'carry_on', message: 'carry on with the tests', when: 'after_limit_reset', from_convo_id: 'parent-convo', from_name: 'box-6' })
  // The carry-on is on record, with the Coordinator turn's causes, for the
  // target's turn to name (src/cause-hops.js); the causes are never relayed.
  assert.match(carryOnId, /^co_[0-9a-f]{16}$/)
  const hop = s.db.prepare('SELECT * FROM cause_hops WHERE key=?').get(`carry_on:${carryOnId}`)
  assert.equal(hop.from_convo_id, 'parent-convo')
  assert.equal(hop.to_convo_id, 'tgt')
  assert.equal(hop.coordinator, 1)
  assert.deepEqual(JSON.parse(hop.causes), causes)
  target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'scheduled' } })
  await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'result' && f.request_id === 'r3')
})

test('session_control: refused for a non-Coordinator, a client, a foreign or private target, self, and bad params', async (t) => {
  const { s, alice, parent, target, client, parentDev } = await fleet(t, { coordinator: false })
  const base = { op: 'session_control', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'compact' }
  parent.send({ ...base, request_id: 'n1' })
  let e = await errorFrame(parent, 'n1'); assert.equal(e.code, 'forbidden'); assert.equal(e.detail, 'not_coordinator')
  setCoordinatorConvoId(s.db, alice.id, 'parent-convo')
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
  s.db.prepare('UPDATE devices SET private=1 WHERE name=?').run('opal')
  parent.send({ ...base, request_id: 'n6' })
  e = await errorFrame(parent, 'n6'); assert.equal(e.code, 'not_found')
  // …but visible to a Coordinator on a private box
  s.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(parentDev.deviceId)
  parent.send({ ...base, request_id: 'n7' })
  await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'sent' && f.request_id === 'n7')
  const n7req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control')
  target.send({ op: 'agent_response', request_id: n7req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'now' } })
  await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'result' && f.request_id === 'n7')
  s.db.prepare('UPDATE devices SET private=0 WHERE name IN (?, ?)').run('opal', 'box-6')
  // a sub-conversation cannot be the Coordinator's from_convo_id
  s.db.prepare("INSERT INTO conversations(id, owner_user_id, title, session_state, last_seq, unread_count, snippet, created_at, agent_device_id, parent_convo_id) VALUES('sub', ?, 'sub', 'waiting', 0, 0, '', 1, ?, 'parent-convo')").run(alice.id, parentDev.deviceId)
  parent.send({ ...base, request_id: 'n7b', from_convo_id: 'sub' })
  e = await errorFrame(parent, 'n7b'); assert.equal(e.code, 'not_found')
  // self
  parent.send({ ...base, request_id: 'n8', target_convo_id: 'parent-convo' })
  e = await errorFrame(parent, 'n8'); assert.equal(e.code, 'bad_request')
  // bad params, each with request_id echoed
  const bad = [
    { action: 'reboot' }, { action: 'set_model' }, { action: 'set_model', agent: 'gemini' }, { action: 'set_model', model: 'x'.repeat(65) },
    { action: 'carry_on' }, { action: 'carry_on', message: '   ' }, { action: 'carry_on', message: 'go', when: 'later' }, { action: 'compact', reason: 'r'.repeat(201) },
    { action: 'carry_on', message: 'go', causes: [{ kind: 'nonsense' }] }, { action: 'carry_on', message: 'go', causes: 'x' },
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
  assert.deepEqual(validateSessionControl({ request_id: 'a', from_convo_id: 'c', target_convo_id: 't', action: 'compact' }), { ok: true, rid: 'a', params: { convo_id: 't', action: 'compact' }, causes: null })
  // A carry-on's causes are handed back beside the params, never inside them.
  const co = validateSessionControl({ request_id: 'a', from_convo_id: 'c', target_convo_id: 't', action: 'carry_on', message: 'go', causes: [{ kind: 'routine', ref: 'routine:x@2026-01-01T00:00:00.000Z' }] })
  assert.deepEqual(co.causes, [{ kind: 'routine', ref: 'routine:x@2026-01-01T00:00:00.000Z' }])
  assert.equal('causes' in co.params, false)
  assert.equal(validateSessionControl({ request_id: 'a', from_convo_id: 'c', target_convo_id: 't', action: 'set_model', agent: 'codex' }).params.agent, 'codex')
  assert.equal(validateSessionControl({}).code, 'bad_request')
  // Effort on its own is a whole set_model; the level is the bridge's call.
  assert.deepEqual(validateSessionControl({ request_id: 'a', from_convo_id: 'c', target_convo_id: 't', action: 'set_model', effort: 'high\u0007' }).params, { convo_id: 't', action: 'set_model', effort: 'high' })
  assert.equal(validateSessionControl({ request_id: 'a', from_convo_id: 'c', target_convo_id: 't', action: 'set_model', effort: 'e'.repeat(17) }).code, 'bad_request')
  assert.equal(validateSessionControl({ request_id: 'a', from_convo_id: 'c', target_convo_id: 't', action: 'set_model', effort: 4 }).code, 'bad_request')
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

// A user-only box (devices.consent_user_only) takes new work only on the
// user's own say: a carry-on, whose message becomes a turn in the session,
// is refused there. set_model and compact carry no turn text and still go.
test('session_control: a carry-on into a session on a user-only box is refused user_only, now or after a limit reset', async (t) => {
  const { s, parent, target, targetDev } = await fleet(t)
  setDeviceConsentUserOnly(s.db, targetDev.deviceId, true)
  for (const [rid, when] of [['u1', undefined], ['u2', 'now'], ['u3', 'after_limit_reset']]) {
    parent.send({ op: 'session_control', request_id: rid, from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'carry_on', message: 'carry on', ...(when ? { when } : {}) })
    const err = await errorFrame(parent, rid)
    assert.deepEqual([err.code, err.detail], ['forbidden', 'user_only'])
  }
  // Nothing reached the box, nothing was acked, and no carry-on is on record.
  assert.equal(target.frames.some((f) => f.kind === 'rpc'), false)
  assert.equal(parent.frames.some((f) => f.kind === 'session_control'), false)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM cause_hops WHERE key LIKE 'carry_on:%'").get().n, 0)
})

test('session_control: set_model and compact still reach a session on a user-only box', async (t) => {
  const { s, parent, target, targetDev } = await fleet(t)
  setDeviceConsentUserOnly(s.db, targetDev.deviceId, true)
  const sends = [
    ['m1', { action: 'compact', reason: 'context at 92%' }],
    ['m2', { action: 'set_model', model: 'sonnet', effort: 'high' }],
  ]
  for (const [rid, extra] of sends) {
    target.frames.length = 0
    parent.send({ op: 'session_control', request_id: rid, from_convo_id: 'parent-convo', target_convo_id: 'tgt', ...extra })
    const req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control')
    assert.deepEqual(req.request.params, { convo_id: 'tgt', ...extra, from_convo_id: 'parent-convo', from_name: 'box-6' })
    target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'now' } })
    const res = await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'result' && f.request_id === rid)
    assert.equal(res.ok, true)
  }
})

test('session_control: the user-only rule looks at the target box only; a carry-on to another box is unaffected', async (t) => {
  const { s, parent, target, parentDev } = await fleet(t)
  // The Coordinator's own box being user-only does not stop it reaching an
  // ordinary one.
  setDeviceConsentUserOnly(s.db, parentDev.deviceId, true)
  parent.send({ op: 'session_control', request_id: 'a1', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'carry_on', message: 'carry on' })
  const req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control')
  assert.equal(req.request.params.message, 'carry on')
  assert.match(req.request.params.carry_on_id, /^co_[0-9a-f]{16}$/)
})

test('session_control: a protected box is refused protected_device for every action, user-only or not', async (t) => {
  const { s, parent, target, targetDev } = await fleet(t)
  setDeviceProtected(s.db, targetDev.deviceId, true)
  setDeviceConsentUserOnly(s.db, targetDev.deviceId, true)
  const sends = [['p1', { action: 'carry_on', message: 'carry on' }], ['p2', { action: 'compact' }], ['p3', { action: 'set_model', model: 'sonnet' }]]
  for (const [rid, extra] of sends) {
    parent.send({ op: 'session_control', request_id: rid, from_convo_id: 'parent-convo', target_convo_id: 'tgt', ...extra })
    const err = await errorFrame(parent, rid)
    assert.deepEqual([err.code, err.detail], ['forbidden', 'protected_device'])
  }
  assert.equal(target.frames.some((f) => f.kind === 'rpc'), false)
})

test('session_control: a non-Coordinator learns nothing about a user-only target', async (t) => {
  const { s, parent, targetDev } = await fleet(t, { coordinator: false })
  setDeviceConsentUserOnly(s.db, targetDev.deviceId, true)
  parent.send({ op: 'session_control', request_id: 'n1', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'carry_on', message: 'carry on' })
  const err = await errorFrame(parent, 'n1')
  assert.deepEqual([err.code, err.detail], ['forbidden', 'not_coordinator'])
})

// The user's own say can come through the Coordinator: a carry-on to a
// user-only box goes when the turn that sent it was started by the user's
// recent message in the Coordinator's conversation, or their comment or tap
// on an item that conversation owns.
const MIN = 60 * 1000
const iso = (ms) => new Date(ms).toISOString()
// The user's words in a conversation, `ago` ms old.
const userSays = (f, { convoId = 'parent-convo', ago = 0, sender = 'user:alice' } = {}) => {
  const { seq } = append(f.s.db, { userId: f.alice.id, convoId, sender, type: 'text', payload: { body: 'yes, tell it to carry on' } })
  if (ago) f.s.db.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(Date.now() - ago, f.alice.id, seq)
  return { kind: 'user_message', ref: `${convoId}:${seq}` }
}
let itemNum = 0
// An item owned by a conversation, and the user's tap (or plain reply) on it.
const userTaps = (f, { convoId = 'parent-convo', ago = 0, action = 'Send it' } = {}) => {
  const num = ++itemNum
  const at = Date.now() - ago
  f.s.db.prepare(`INSERT INTO items(id,user_id,num,kind,state,rank,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at)
    VALUES(?,?,?,'question','open',?,?,?,?,'agent',?,?)`).run(`it_${num}`, f.alice.id, num, num, 'The session on opal has stalled: send this message?', convoId, f.parentDev.deviceId, at, at)
  f.s.db.prepare(`INSERT INTO item_comments(id,item_id,user_id,author,device_id,kind,body,meta,created_at)
    VALUES(?,?,?,'user',?,'comment',?,?,?)`).run(`ic_${num}`, `it_${num}`, f.alice.id, f.parentDev.deviceId, action ?? 'go ahead', action ? JSON.stringify({ action }) : null, at)
  return { kind: action ? 'item_tap' : 'item_reply', ref: `item:${num}@${iso(at)}` }
}
const routineFired = (f, ago = MIN) => {
  const firedAt = Date.now() - ago
  createRoutine(f.s.db, { userId: f.alice.id, origin: 'user', fields: { name: 'sweep', title: 'A sweep', schedule: '0 8 * * *', tz: 'UTC', prompt: 'Do the sweep.', enabled: true } })
  f.s.db.prepare("UPDATE routines SET last_fired_at=? WHERE user_id=? AND name='sweep'").run(firedAt, f.alice.id)
  return { kind: 'routine', ref: `routine:sweep@${iso(firedAt)}` }
}
const userOnlyFleet = async (t) => {
  const f = await fleet(t)
  setDeviceConsentUserOnly(f.s.db, f.targetDev.deviceId, true)
  return f
}
const carryOn = (f, rid, causes, extra = {}) =>
  f.parent.send({ op: 'session_control', request_id: rid, from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'carry_on', message: 'carry on', ...(causes ? { causes } : {}), ...extra })
// The carry-on reaches the box and its result comes back.
const goes = async (f, rid) => {
  f.target.frames.length = 0
  const req = await f.target.waitFor((x) => x.kind === 'rpc' && x.request?.method === 'session_control')
  assert.equal(req.request.params.message, 'carry on')
  assert.match(req.request.params.carry_on_id, /^co_[0-9a-f]{16}$/)
  f.target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'now' } })
  const res = await f.parent.waitFor((x) => x.kind === 'session_control' && x.event === 'result' && x.request_id === rid)
  assert.equal(res.ok, true)
  return req
}
const refused = async (f, rid) => {
  const err = await errorFrame(f.parent, rid)
  assert.deepEqual([err.code, err.detail, err.why], ['forbidden', 'user_only', WHY_CARRY_ON_USER_ONLY], rid)
}

test('session_control: a carry-on to a user-only box goes through on the user\'s fresh message in the Coordinator\'s conversation', async (t) => {
  assert.equal(CARRY_ON_USER_ONLY_WINDOW_MS, 10 * MIN)
  const f = await userOnlyFleet(t)
  carryOn(f, 'g1', [userSays(f)])
  await goes(f, 'g1')
  // Nearly ten minutes old is still the user's word; the routine cause
  // beside it does not change whose turn it is.
  carryOn(f, 'g2', [routineFired(f), userSays(f, { ago: 9 * MIN })])
  await goes(f, 'g2')
  // Scheduled for after a limit reset: decided now, delivered by the box.
  carryOn(f, 'g3', [userSays(f)], { when: 'after_limit_reset' })
  const req = await goes(f, 'g3')
  assert.equal(req.request.params.when, 'after_limit_reset')
  assert.equal(f.s.db.prepare("SELECT COUNT(*) AS n FROM cause_hops WHERE key LIKE 'carry_on:%'").get().n, 3)
})

test('session_control: a carry-on to a user-only box goes through on the user\'s fresh tap or comment on one of the Coordinator\'s items', async (t) => {
  const f = await userOnlyFleet(t)
  carryOn(f, 'i1', [userTaps(f)])
  await goes(f, 'i1')
  carryOn(f, 'i2', [userTaps(f, { action: null, ago: MIN })])
  await goes(f, 'i2')
})

test('session_control: a carry-on to a user-only box stays refused without the user\'s own fresh word in that turn', async (t) => {
  const f = await userOnlyFleet(t)
  upsertConversation(f.s.db, { id: 'other-convo', ownerUserId: f.alice.id, title: 'elsewhere', agentDeviceId: f.parentDev.deviceId })
  const routine = routineFired(f)
  createSpawnRequest(f.s.db, { id: 'sp_prior', userId: f.alice.id, fromDeviceId: f.parentDev.deviceId, fromConvoId: 'parent-convo', targetDeviceId: f.targetDev.deviceId, workdir: '/w', task: 't', causes: [userSays(f)], now: Date.now() - 1000 })
  f.s.db.prepare("UPDATE agent_spawn_requests SET state='started' WHERE id='sp_prior'").run()
  const cases = [
    ['no causes', null],
    ['a routine fire', [routine]],
    ['a user message older than ten minutes', [userSays(f, { ago: 11 * MIN })]],
    ['a tap older than ten minutes', [userTaps(f, { ago: 11 * MIN })]],
    ['a message in another conversation', [userSays(f, { convoId: 'other-convo' })]],
    ['an item another conversation owns', [userTaps(f, { convoId: 'other-convo' })]],
    ['a room message beside the user\'s', [userSays(f), { kind: 'room_message', ref: 'room:r1@4' }]],
    ['a reminder beside the user\'s', [userSays(f), { kind: 'reminder' }]],
    ['an alert', [{ kind: 'alert' }]],
    ['another carry-on', [{ kind: 'carry_on', ref: 'carry_on:co_0123456789abcdef' }]],
    ['a spawn outcome, though the user asked for that spawn', [{ kind: 'spawn_outcome', ref: 'spawn:sp_prior' }]],
    ['a spawn outcome beside the user\'s', [userSays(f), { kind: 'spawn_outcome', ref: 'spawn:sp_prior' }]],
    ['an agent\'s message cited as the user\'s', [userSays(f, { sender: 'agent:box-6' })]],
    ['a message that does not exist', [{ kind: 'user_message', ref: 'parent-convo:99999' }]],
    ['a tap cited at the wrong time', [{ kind: 'item_tap', ref: `item:${itemNum}@${iso(Date.now())}` }]],
  ]
  for (const [name, causes] of cases) {
    const rid = `x-${name}`
    carryOn(f, rid, causes)
    await refused(f, rid)
  }
  // Nothing reached the box, nothing was acked, and no carry-on is on record.
  assert.equal(f.target.frames.some((x) => x.kind === 'rpc'), false)
  assert.equal(f.parent.frames.some((x) => x.kind === 'session_control'), false)
  assert.equal(f.s.db.prepare("SELECT COUNT(*) AS n FROM cause_hops WHERE key LIKE 'carry_on:%'").get().n, 0)
})

test('session_control: the user\'s word does not open a protected box, and an ordinary box needs none', async (t) => {
  const f = await fleet(t)
  // Not user-only: causes that would be refused there are not looked at.
  carryOn(f, 'o1', [{ kind: 'room_message', ref: 'room:r1@4' }])
  await goes(f, 'o1')
  carryOn(f, 'o2', null)
  await goes(f, 'o2')
  setDeviceProtected(f.s.db, f.targetDev.deviceId, true)
  f.target.frames.length = 0
  carryOn(f, 'o3', [userSays(f)])
  const err = await errorFrame(f.parent, 'o3')
  assert.deepEqual([err.code, err.detail], ['forbidden', 'protected_device'])
  assert.equal('why' in err, false)
  assert.equal(f.target.frames.some((x) => x.kind === 'rpc'), false)
})
