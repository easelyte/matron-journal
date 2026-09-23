import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { makeWaker, wakeConvoAgent } from '../src/wake.js'
import { makeHub } from '../src/hub.js'
import { openDb } from '../src/db.js'
import { upsertConversation } from '../src/journal.js'
import { recordJoined } from '../src/participants.js'

// Wake-on-message (src/wake.js): traffic addressed to an agent device with no
// live socket fires the operator-configured wake command for that device's
// box, so an idle-stopped VM boots when someone talks to it. The op's own
// answer never changes — these tests pin both halves.

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))
const until = async (pred, ms = 2000) => {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('until timeout')
    await settle(20)
  }
}

// --- makeWaker unit ---------------------------------------------------------

const quietLog = { log: () => {}, error: () => {} }

test('waker is disabled without a command and refuses bad box names', () => {
  const off = makeWaker({ cmd: '', log: quietLog })
  assert.equal(off.enabled, false)
  assert.equal(off.wake('henry'), false)

  const on = makeWaker({ cmd: `${process.execPath} -e process.exit(0)`, log: quietLog })
  assert.equal(on.enabled, true)
  assert.equal(on.wake(''), false)
  assert.equal(on.wake('Henry'), false)
  assert.equal(on.wake('a;rm -rf /'), false)
  assert.equal(on.wake(42), false)
})

test('waker appends the box name to the argv and debounces per box', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wake-'))
  const out = path.join(dir, 'calls')
  const script = path.join(dir, 'capture.js')
  writeFileSync(out, '')
  writeFileSync(script, "require('fs').appendFileSync(process.argv[2], process.argv[3] + '\\n')")

  const w = makeWaker({ cmd: `${process.execPath} ${script} ${out}`, debounceMs: 60000, log: quietLog })
  assert.equal(w.wake('henry'), true)
  assert.equal(w.wake('henry'), true) // debounced: no second spawn
  assert.equal(w.wake('mavis'), true) // separate box, separate debounce

  await until(() => readFileSync(out, 'utf8').split('\n').filter(Boolean).length === 2)
  assert.deepEqual(readFileSync(out, 'utf8').split('\n').filter(Boolean).sort(), ['henry', 'mavis'])
})

test('a transient wake failure retries after the failure backoff, not on the next message', async () => {
  let errors = 0
  let fired = 0
  const log = { log: () => { fired++ }, error: () => { errors++ } }
  const w = makeWaker({ cmd: `${process.execPath} -e process.exit(1)`, debounceMs: 60000, failBackoffMs: 200, log })
  assert.equal(w.wake('henry'), true)
  await until(() => errors === 1)
  assert.equal(w.wake('henry'), true) // still inside the backoff: suppressed
  assert.equal(fired, 1)
  await settle(250)
  assert.equal(w.wake('henry'), true) // backoff elapsed: fires again
  await until(() => errors === 2)
  assert.equal(fired, 2)
})

test('a refused wake (exit 2) keeps the full debounce window', async () => {
  let errors = 0
  let fired = 0
  const log = { log: () => { fired++ }, error: () => { errors++ } }
  const w = makeWaker({ cmd: `${process.execPath} -e process.exit(2)`, debounceMs: 400, failBackoffMs: 50, log })
  assert.equal(w.wake('dev-j'), true)
  await until(() => errors === 1)
  await settle(100) // past the failure backoff, inside the debounce
  assert.equal(w.wake('dev-j'), true)
  assert.equal(fired, 1, 'a refusal is not retried on the next message')
  await settle(350)
  assert.equal(w.wake('dev-j'), true)
  await until(() => errors === 2)
  assert.equal(fired, 2, 'retried once the window elapsed')
})

// --- ws integration ---------------------------------------------------------

function stubWaker() {
  const calls = []
  return { enabled: true, wake: (box) => { calls.push(box); return true }, calls }
}

async function boot(t) {
  const waker = stubWaker()
  const s = await startTestServer({ waker })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agent = createAgent(s.db, dan.id, 'henry')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await client.waitFor((f) => f.op === 'hello_ok')
  t.after(() => client.close())
  return { s, dan, agent, client, waker }
}

test('send to a convo owned by an offline agent wakes its box', async (t) => {
  const { s, agent, client, waker } = await boot(t)

  const a = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await a.waitFor((f) => f.op === 'hello_ok')
  a.send({ op: 'convo_upsert', convo_id: 'sess-1', title: 'work', session_state: 'running' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')

  // Online: no wake.
  client.send({ op: 'send', convo_id: 'sess-1', payload: { body: 'hi' } })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'text')
  assert.deepEqual(waker.calls, [])

  a.close()
  await settle()

  client.send({ op: 'send', convo_id: 'sess-1', payload: { body: 'you up?' } })
  await client.waitFor((f) => f.kind === 'journal' && f.payload?.body === 'you up?')
  assert.deepEqual(waker.calls, ['henry'])

  // The append still happened — wake is additive, not a gate.
  client.send({ op: 'prompt_reply', convo_id: 'sess-1', target_seq: 1, text: 'yes' })
  await until(() => waker.calls.length === 2)
  assert.deepEqual(waker.calls, ['henry', 'henry'])
})

test('agent_request to an offline agent still fails agent_unreachable but wakes the box', async (t) => {
  const { agent, client, waker } = await boot(t)

  client.send({ op: 'agent_request', request_id: 'r1', agent_device_id: agent.deviceId, method: 'start', params: {} })
  const err = await client.waitFor((f) => f.op === 'error' && f.request_id === 'r1')
  assert.equal(err.code, 'agent_unreachable')
  await until(() => waker.calls.length === 1)
  assert.deepEqual(waker.calls, ['henry'])
})

test('spawn_request to an offline target wakes the box and parks the ask (wake-before-spawn)', async (t) => {
  const { s, dan, agent, client, waker } = await boot(t)

  const parent = createAgent(s.db, dan.id, 'eric')
  const p = await makeWsClient(s.base, { token: parent.token, cursor: null })
  await p.waitFor((f) => f.op === 'hello_ok')
  t.after(() => p.close())
  p.send({ op: 'convo_upsert', convo_id: 'parent-1', title: 'parent', session_state: 'running' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')

  p.send({
    op: 'spawn_request', request_id: 's1', target_device_id: agent.deviceId,
    from_convo_id: 'parent-1', workdir: '/home/danbarker', task: 'do the thing',
  })
  const ack = await p.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  assert.equal(ack.target_waking, true)
  await until(() => waker.calls.length === 1)
  assert.deepEqual(waker.calls, ['henry'])
})

// --- wakeConvoAgent (shared helper, used by ws.js and, from Task 7, the
// HTTP items routes) ---------------------------------------------------------

test('wakeConvoAgent resolves the managing agent and wakes it only when offline', async () => {
  const db = openDb(':memory:')
  const hub = makeHub()
  const dan = await createUser(db, 'dan', 'pw')
  const agent = createAgent(db, dan.id, 'dev-2')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'T', agentDeviceId: agent.deviceId })
  const calls = []
  const waker = { enabled: true, wake: (name) => calls.push(name) }
  wakeConvoAgent({ db, hub, waker }, dan.id, 'c1')
  assert.deepEqual(calls, ['dev-2'])
  wakeConvoAgent({ db, hub, waker }, dan.id + 1, 'c1') // foreign user: nothing
  wakeConvoAgent({ db, hub, waker: { enabled: false, wake: () => calls.push('x') } }, dan.id, 'c1')
  wakeConvoAgent({ db, hub, waker: null }, dan.id, 'c1')
  assert.deepEqual(calls, ['dev-2'])
})

// --- rooms: every joined participant is a wake target ------------------------
//
// A room is a conversation with joined agent devices besides its owner. Until
// 2026-09-21 only the OWNER's box was ever woken, so a message into a room
// whose guest had idle-stopped sat unread until something else started that
// box (bridge rooms now survive the guest's sleep, which made this visible).

test('wakeConvoAgent wakes the joined participants of a room too, never the sender', async () => {
  const db = openDb(':memory:')
  const hub = makeHub()
  const dan = await createUser(db, 'dan', 'pw')
  const owner = createAgent(db, dan.id, 'dev-a')
  const guest = createAgent(db, dan.id, 'dev-b')
  const gone = createAgent(db, dan.id, 'dev-c')
  upsertConversation(db, { id: 'room', ownerUserId: dan.id, title: 'T', agentDeviceId: owner.deviceId })
  recordJoined(db, { convoId: 'room', agentDeviceId: guest.deviceId, initiatorDeviceId: owner.deviceId })
  // A participant that LEFT is not a target: only state 'joined' has delivery rights.
  recordJoined(db, { convoId: 'room', agentDeviceId: gone.deviceId, initiatorDeviceId: owner.deviceId })
  db.prepare("UPDATE convo_agents SET state='left' WHERE agent_device_id=?").run(gone.deviceId)
  const calls = []
  const waker = { enabled: true, wake: (name) => calls.push(name) }
  wakeConvoAgent({ db, hub, waker }, dan.id, 'room')
  assert.deepEqual(calls.sort(), ['dev-a', 'dev-b'])
  calls.length = 0
  // The writer is awake by definition — an agent posting into the room
  // must not fire a wake for its own box.
  wakeConvoAgent({ db, hub, waker }, dan.id, 'room', { exceptDeviceId: owner.deviceId })
  assert.deepEqual(calls, ['dev-b'])
  calls.length = 0
  wakeConvoAgent({ db, hub, waker }, dan.id + 1, 'room') // foreign user: nothing
  assert.deepEqual(calls, [])
})

test('an agent publishing text into a room wakes an offline joined peer, and only for message-like types', async (t) => {
  const { s, dan, agent: owner, client, waker } = await boot(t)
  const guest = createAgent(s.db, dan.id, 'dev-b')
  const a = await makeWsClient(s.base, { token: owner.token, cursor: null })
  await a.waitFor((f) => f.op === 'hello_ok')
  t.after(() => a.close())
  a.send({ op: 'convo_upsert', convo_id: 'room', title: 'room', session_state: 'running' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  recordJoined(s.db, { convoId: 'room', agentDeviceId: guest.deviceId, initiatorDeviceId: owner.deviceId })

  // A status-style publish is not a message: no wake.
  a.send({ op: 'publish', convo_id: 'room', type: 'summary', payload: { toc: 'x', detail: 'y' } })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'summary')
  assert.deepEqual(waker.calls, [])

  a.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'peer, are you there?' } })
  await client.waitFor((f) => f.kind === 'journal' && f.payload?.body === 'peer, are you there?')
  await until(() => waker.calls.length === 1)
  assert.deepEqual(waker.calls, ['dev-b'])

  // The user typing into the room wakes the offline guest as well (the
  // owner is online and is not woken).
  client.send({ op: 'send', convo_id: 'room', payload: { body: 'both of you: status?' } })
  await client.waitFor((f) => f.kind === 'journal' && f.payload?.body === 'both of you: status?')
  await until(() => waker.calls.length === 2)
  assert.deepEqual(waker.calls, ['dev-b', 'dev-b'])
})
