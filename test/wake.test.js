import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { makeWaker } from '../src/wake.js'

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

test('a failed wake clears the debounce so the next message retries', async () => {
  let errors = 0
  const w = makeWaker({ cmd: `${process.execPath} -e process.exit(1)`, debounceMs: 60000, log: { log: () => {}, error: () => { errors++ } } })
  assert.equal(w.wake('henry'), true)
  await until(() => errors === 1)
  assert.equal(w.wake('henry'), true)
  await until(() => errors === 2)
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

test('spawn_request to an offline target wakes the box before refusing', async (t) => {
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
  const err = await p.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'agent_unreachable')
  await until(() => waker.calls.length === 1)
  assert.deepEqual(waker.calls, ['henry'])
})
