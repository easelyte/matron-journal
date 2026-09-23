import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { getSpawn } from '../src/spawns.js'
import { getParticipant } from '../src/participants.js'

// Wake-before-spawn: a target box with no live socket is asleep, not gone,
// when the journal has a wake command. A spawn ask against it parks as
// usual (the box is started meanwhile), an approval waits for the box to
// attach before issuing `start`, and an invite/join aimed at it starts the
// box while the user's consent is pending.

function fakeWaker() {
  const calls = []
  return { calls, enabled: true, wake: (name) => { calls.push(name); return true } }
}

// One user, a parent agent (dev-6), a target agent (eric) that is NOT
// connected, and a client. Parent owns 'parent-convo'.
async function sleepyFleet(t, { waker = fakeWaker(), serverOpts = {} } = {}) {
  const s = await startTestServer({ waker, ...serverOpts })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const parentDev = createAgent(s.db, dan.id, 'dev-6')
  const targetDev = createAgent(s.db, dan.id, 'eric')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const clientToken = login.json.token
  const parent = await makeWsClient(s.base, { token: parentDev.token, cursor: null })
  const client = await makeWsClient(s.base, { token: clientToken, cursor: null })
  await parent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { parent.close(); client.close() })
  parent.send({ op: 'convo_upsert', convo_id: 'parent-convo', title: 'parent session', session_state: 'running' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  parent.frames.length = 0
  client.frames.length = 0
  const connectTarget = async () => {
    const target = await makeWsClient(s.base, { token: targetDev.token, cursor: null })
    await target.waitFor((f) => f.op === 'hello_ok')
    t.after(() => target.close())
    return target
  }
  return { s, dan, waker, parentDev, targetDev, clientToken, parent, client, connectTarget }
}

const isSpawnCard = (f) => f.kind === 'journal' && f.type === 'permission_request' && f.payload?.kind === 'agent_spawn'

function sendSpawn(parent, targetDev) {
  parent.send({
    op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo',
    target_device_id: targetDev.deviceId, workdir: '/w', task: 'do it', topic: 'job',
  })
}

test('spawn_request against an asleep box wakes it and parks the ask, acking target_waking', async (t) => {
  const { s, waker, targetDev, parent, client } = await sleepyFleet(t)
  sendSpawn(parent, targetDev)
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  assert.equal(ack.target_waking, true)
  assert.deepEqual(waker.calls, ['eric'])
  assert.equal(getSpawn(s.db, ack.spawn_id).state, 'awaiting_user')
  const card = await client.waitFor(isSpawnCard)
  assert.equal(card.payload.request_id, ack.spawn_id)
})

test('spawn_request against an online box acks pending without target_waking and fires no wake', async (t) => {
  const { waker, targetDev, parent, connectTarget } = await sleepyFleet(t)
  await connectTarget()
  sendSpawn(parent, targetDev)
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  assert.equal('target_waking' in ack, false)
  assert.deepEqual(waker.calls, [])
})

test('spawn_request against an offline box that cannot be woken is still refused before any card', async (t) => {
  const { s, targetDev, parent, client } = await sleepyFleet(t, { waker: { enabled: false, wake: () => false } })
  sendSpawn(parent, targetDev)
  const err = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'agent_unreachable')
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM agent_spawn_requests').get().c, 0)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(client.frames.find(isSpawnCard), undefined)
})

test('approval of a spawn whose target is asleep waits for the box to attach, then starts it', async (t) => {
  const { s, waker, targetDev, clientToken, parent, client, connectTarget } = await sleepyFleet(t, { serverOpts: { spawnWakeWaitMs: 3000, spawnStartTimeoutMs: 2000 } })
  sendSpawn(parent, targetDev)
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  await client.waitFor(isSpawnCard)
  waker.calls.length = 0
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: ack.spawn_id, decision: 'approve' } })
  assert.equal(r.status, 200)
  // The tap fired a wake and the row sits in 'approved' while the box boots.
  await new Promise((res) => setTimeout(res, 150))
  assert.deepEqual(waker.calls, ['eric'])
  assert.equal(getSpawn(s.db, ack.spawn_id).state, 'approved')
  // The box comes up: the start rpc lands on its fresh socket.
  const target = await connectTarget()
  const req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start', 3000)
  assert.equal(req.request.params.prompt, 'do it')
  target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child-convo-1' } })
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 3000)
  assert.equal(out.outcome, 'started')
  assert.equal(out.child_convo_id, 'child-convo-1')
  assert.equal(getSpawn(s.db, ack.spawn_id).state, 'started')
})

test('approval of a spawn whose target never comes up fails with agent_unreachable after the wake wait', async (t) => {
  const { s, targetDev, clientToken, parent, client } = await sleepyFleet(t, { serverOpts: { spawnWakeWaitMs: 300, spawnStartTimeoutMs: 1000 } })
  sendSpawn(parent, targetDev)
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  await client.waitFor(isSpawnCard)
  const t0 = Date.now()
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: ack.spawn_id, decision: 'approve' } })
  assert.equal(r.status, 200)
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 3000)
  assert.equal(out.outcome, 'failed')
  assert.equal(out.error_code, 'agent_unreachable')
  assert.ok(Date.now() - t0 >= 300, 'the wake window was actually waited')
  assert.equal(getSpawn(s.db, ack.spawn_id).state, 'failed')
})

test('close() while an approval waits for a woken box releases the wait: the row is failed and nothing holds the process for the window', async (t) => {
  // A file-backed DB so the row can be read back after close() has shut the
  // journal's own handle.
  const dir = mkdtempSync(join(tmpdir(), 'mj-wake-close-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'j.db')
  const waker = fakeWaker()
  const s = await startTestServer({ waker, dbPath, spawnWakeWaitMs: 600000, spawnStartTimeoutMs: 1000 })
  const dan = await createUser(s.db, 'dan', 'pw')
  const parentDev = createAgent(s.db, dan.id, 'dev-6')
  const targetDev = createAgent(s.db, dan.id, 'eric')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const parent = await makeWsClient(s.base, { token: parentDev.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: null })
  await parent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  parent.send({ op: 'convo_upsert', convo_id: 'parent-convo', title: 'parent session', session_state: 'running' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  sendSpawn(parent, targetDev)
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  await client.waitFor(isSpawnCard)
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: login.json.token, body: { request_id: ack.spawn_id, decision: 'approve' } })
  assert.equal(r.status, 200)
  await new Promise((res) => setTimeout(res, 150))
  assert.equal(getSpawn(s.db, ack.spawn_id).state, 'approved')
  const t0 = Date.now()
  await s.close()
  assert.ok(Date.now() - t0 < 5000, 'close() did not wait out the wake window')
  parent.close(); client.close()
  // The orchestration settled its row on the way down instead of being
  // abandoned with a ref'd timer: the durable outcome is there.
  const db = new Database(dbPath, { readonly: true })
  t.after(() => db.close())
  assert.equal(getSpawn(db, ack.spawn_id).state, 'failed')
  const outcome = db.prepare("SELECT payload FROM events WHERE convo_id='parent-convo' AND type='spawn_outcome'").get()
  assert.ok(outcome, 'a spawn_outcome event was journaled')
  assert.equal(JSON.parse(outcome.payload).error_code, 'agent_unreachable')
})

test('approval with no wake possible fails at once, as before', async (t) => {
  const { s, waker, targetDev, clientToken, parent, client } = await sleepyFleet(t, { serverOpts: { spawnWakeWaitMs: 5000 } })
  sendSpawn(parent, targetDev)
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  await client.waitFor(isSpawnCard)
  // The waker refuses at approval time (box unknown to every host now).
  waker.wake = () => false
  const t0 = Date.now()
  await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: ack.spawn_id, decision: 'approve' } })
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 3000)
  assert.equal(out.outcome, 'failed')
  assert.equal(out.error_code, 'agent_unreachable')
  assert.ok(Date.now() - t0 < 2000, 'no wake window was waited')
})

test('spawn_targets and /roster mark an asleep box wakeable, never an online one', async (t) => {
  const { s, targetDev, parentDev, parent } = await sleepyFleet(t)
  parent.send({ op: 'spawn_targets', request_id: 'q1' })
  const reply = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets', 5000)
  const eric = reply.boxes.find((b) => b.device_id === targetDev.deviceId)
  assert.equal(eric.online, false)
  assert.equal(eric.wakeable, true)
  const me = reply.boxes.find((b) => b.device_id === parentDev.deviceId)
  assert.equal(me.online, true)
  assert.equal('wakeable' in me, false)
  const roster = await s.http('/roster', { token: parentDev.token })
  assert.equal(roster.status, 200)
  const rEric = roster.json.agents.find((d) => d.device_id === targetDev.deviceId)
  assert.equal(rEric.connected, false)
  assert.equal(rEric.wakeable, true)
  const rMe = roster.json.agents.find((d) => d.device_id === parentDev.deviceId)
  assert.equal('wakeable' in rMe, false)
})

test('a box whose name the wake command would refuse is never wakeable, and a spawn at it is refused, not parked', async (t) => {
  // Device names are free text (spaces, capitals, up to 40 chars); the wake
  // command only takes an incus instance name. The flag must follow the
  // same rule wakeIfOffline does, or a bridge would show "asleep" for a box
  // nothing can start.
  const { s, dan, waker, parentDev, parent, client } = await sleepyFleet(t)
  const mac = createAgent(s.db, dan.id, 'Dan MacBook')
  parent.send({ op: 'spawn_targets', request_id: 'q1' })
  const reply = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets', 5000)
  const box = reply.boxes.find((b) => b.device_id === mac.deviceId)
  assert.equal(box.online, false)
  assert.equal('wakeable' in box, false)
  const roster = await s.http('/roster', { token: parentDev.token })
  const rMac = roster.json.agents.find((d) => d.device_id === mac.deviceId)
  assert.equal(rMac.connected, false)
  assert.equal('wakeable' in rMac, false)
  sendSpawn(parent, mac)
  const err = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'agent_unreachable')
  assert.deepEqual(waker.calls, [], 'no wake was attempted for an unwakeable name')
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(client.frames.find(isSpawnCard), undefined)
})

test('spawn_targets and /roster omit wakeable when no wake command is configured', async (t) => {
  const { s, targetDev, parentDev, parent } = await sleepyFleet(t, { waker: { enabled: false, wake: () => false } })
  parent.send({ op: 'spawn_targets', request_id: 'q1' })
  const reply = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets', 5000)
  const eric = reply.boxes.find((b) => b.device_id === targetDev.deviceId)
  assert.equal(eric.online, false)
  assert.equal('wakeable' in eric, false)
  const roster = await s.http('/roster', { token: parentDev.token })
  assert.equal('wakeable' in roster.json.agents.find((d) => d.device_id === targetDev.deviceId), false)
})

// --- invites ---

async function roomFleet(t, { waker = fakeWaker() } = {}) {
  const s = await startTestServer({ waker })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agA = createAgent(s.db, dan.id, 'dev-a')
  const agB = createAgent(s.db, dan.id, 'dev-b')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const clientToken = login.json.token
  const a = await makeWsClient(s.base, { token: agA.token, cursor: null })
  const client = await makeWsClient(s.base, { token: clientToken, cursor: null })
  await a.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { a.close(); client.close() })
  a.send({ op: 'convo_upsert', convo_id: 'room', title: 'room', session_state: 'running' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  a.frames.length = 0
  client.frames.length = 0
  return { s, dan, waker, agA, agB, clientToken, a, client }
}

test('agent_invite aimed at an asleep box wakes it while the ask parks; approval with it still down wakes again', async (t) => {
  const { s, waker, agB, clientToken, a } = await roomFleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'pair on the fix', topic: 'fix' })
  const ack = await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  assert.equal(ack.target_device_id, agB.deviceId)
  assert.deepEqual(waker.calls, ['dev-b'])
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'awaiting_user')
  waker.calls.length = 0
  const r = await s.http('/agent-chat/answer', { method: 'POST', token: clientToken, body: { room_id: 'room', target_device_id: agB.deviceId, decision: 'approve' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.delivered, false)
  assert.deepEqual(waker.calls, ['dev-b'])
  // Nothing was lost: the approved row waits for dev-b's hello.
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).delivered_at, null)
})

test('agent_invite aimed at an online box fires no wake', async (t) => {
  const { s, waker, agB, a } = await roomFleet(t)
  const b = await makeWsClient(s.base, { token: agB.token, cursor: null })
  await b.waitFor((f) => f.op === 'hello_ok')
  t.after(() => b.close())
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'pair on the fix', topic: 'fix' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  assert.deepEqual(waker.calls, [])
})

test('agent_join aimed at a room whose owner box is asleep wakes the owner', async (t) => {
  const { s, waker, agA, agB, a } = await roomFleet(t)
  // Owner goes to sleep; joiner comes online and asks in.
  a.close()
  await new Promise((r) => setTimeout(r, 50))
  const b = await makeWsClient(s.base, { token: agB.token, cursor: null })
  await b.waitFor((f) => f.op === 'hello_ok')
  t.after(() => b.close())
  b.send({ op: 'agent_join', room_id: 'room', justification: 'I have the logs' })
  const ack = await b.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  assert.equal(ack.target_device_id, agA.deviceId)
  assert.deepEqual(waker.calls, ['dev-a'])
  assert.ok(s)
})
