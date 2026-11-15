// The replay coordinator (tools/conformance/coordinator.js): cross-role
// ordering, per-step failure attribution, schema refusal, capability skips,
// and a platform runner in another process that plays only the client role.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootFixtureServer } from '../tools/conformance/server.js'
import { createActor } from '../tools/conformance/actor.js'
import { replayFixture } from '../tools/conformance/coordinator.js'
import { spawnRunner } from '../tools/conformance/stdio-runner.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'conformance')
const STUB = path.join(__dirname, '..', 'tools', 'conformance', 'stub-runner.js')
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8'))

async function withServer(t, fixture) {
  const booted = await bootFixtureServer(fixture)
  t.after(() => booted.close())
  return booted
}

test('a stub runner in another process that plays only the client role passes 13_tool_stream.json', async (t) => {
  const fixture = load('13_tool_stream.json')
  const booted = await withServer(t, fixture)
  const runner = await spawnRunner({ command: process.execPath, args: [STUB], base: booted.base, fixture: fixture.name })
  t.after(() => runner.close())
  const result = await replayFixture({
    fixture, base: booted.base, bindings: booted.bindings, control: booted.control,
    runner, play: ['client'],
  })
  assert.equal(result.status, 'pass', result.error)
})

test('without the cross-role barrier 13_tool_stream.json fails on an expect', async (t) => {
  const fixture = load('13_tool_stream.json')
  const booted = await withServer(t, fixture)
  const runner = createActor({ base: booted.base })
  t.after(() => runner.close())
  const result = await replayFixture({
    fixture, base: booted.base, bindings: booted.bindings, control: booted.control,
    runner, play: ['client'], barrier: false,
  })
  assert.equal(result.status, 'fail')
  // The lanes free-run: the second client says hello before the first client's
  // message exists, and the agent waits for a frame the stalled client lane never
  // sends. Whichever step gives up first (a timeout or a frame in the wrong
  // order), an expectation fails, and the same fixture passes with the barrier.
  assert.ok(result.failures.every((f) => fixture.steps[f.index].kind === 'ws_expect'))
})

test('a runner that reports a wrong frame fails that step, not a later one', async (t) => {
  const fixture = load('13_tool_stream.json')
  const booted = await withServer(t, fixture)
  // The runner's decoder garbles the first live tool-stream frame it sees.
  const runner = createActor({
    base: booted.base,
    mapReceived: (f) => (f.kind === 'ephemeral' && f.tool_stream ? { ...f, message_ref: 'garbled' } : f),
  })
  t.after(() => runner.close())
  const collect = {}
  const result = await replayFixture({
    fixture, base: booted.base, bindings: booted.bindings, control: booted.control,
    runner, play: ['client'], collect,
  })
  const firstEphemeral = fixture.steps.findIndex((s) => s.kind === 'ws_expect' && s.frame.kind === 'ephemeral')
  assert.equal(result.status, 'fail')
  assert.equal(result.failedStep, firstEphemeral)
  assert.match(result.error, new RegExp(`^step\\[${firstEphemeral}\\]`))
  assert.match(result.error, /message_ref/)
  // Nothing after the failed step ran on the runner's lane.
  const laterClientSteps = fixture.steps.map((s, i) => i).filter((i) => i > firstEphemeral && fixture.steps[i].role === 'client')
  for (const i of laterClientSteps) assert.equal(collect[i], undefined, `step ${i} ran after the failure`)
})

test('the coordinator refuses a fixture that fails the schema', async (t) => {
  const fixture = load('01_login.json')
  delete fixture.steps[0].role
  const booted = await withServer(t, load('01_login.json'))
  const result = await replayFixture({ fixture, base: booted.base, bindings: booted.bindings, control: booted.control, runner: createActor({ base: booted.base }), play: ['client'] })
  assert.equal(result.status, 'invalid')
  assert.match(result.error, /role/)
})

test('a fixture needing a capability the runner lacks is skipped, as is one newer than the client protocol', async (t) => {
  const fixture = load('01_login.json')
  const modelFixture = { ...fixture, steps: [...fixture.steps, { kind: 'expect_model', role: 'client', expect: {} }] }
  const booted = await withServer(t, fixture)
  const runner = createActor({ base: booted.base })
  const a = await replayFixture({ fixture: modelFixture, base: booted.base, bindings: booted.bindings, control: booted.control, runner, play: ['client'] })
  assert.equal(a.status, 'skip')
  assert.match(a.reason, /expect_model/)
  const newer = { ...fixture, protocol: 3, since: 3 }
  const b = await replayFixture({ fixture: newer, base: booted.base, bindings: booted.bindings, control: booted.control, runner, play: ['client'], clientProtocol: 2 })
  assert.equal(b.status, 'skip')
  assert.match(b.reason, /since 3/)
})

// Lifecycle steps (disconnect, reconnect_from_cursor, advance_clock), with one
// client played by the runner and the other by the coordinator. The frame
// shapes are the ones 04_client_send_echo_idem.json records.
const hello = (client, token, cursor) => [
  { kind: 'ws_open', role: 'client', client, conn: client },
  { kind: 'ws_send', role: 'client', client, conn: client, frame: { op: 'hello', token: { $ref: token }, cursor } },
  { kind: 'ws_expect', role: 'client', client, conn: client, frame: { kind: 'control', op: 'hello_ok', coordinator_convo_id: null, settings: { notices: true, auto_approve_coordinator_spawns: false, auto_archive_days: 30 }, pins: [], seq: { $type: 'integer' }, device_id: { $type: 'integer' }, name: client } },
]
const login = (client, tokenName) => ({
  kind: 'http', role: 'client', client, method: 'POST', path: '/login',
  body: { username: 'alice', password: 'fixture-pw-7', device_name: client },
  expect: { status: 200, body: { token: { $bind: tokenName }, device_id: { $bind: `${client}_device_id` }, user_id: { $ref: 'alice.user_id' } } },
})
// A live echo carries sender_device_id; a frame replayed after hello does not.
const journal = (client, seq, body, replayed = false) => ({
  kind: 'ws_expect', role: 'client', client, conn: client,
  frame: { kind: 'journal', seq, convo_id: 'c1', ts: { $type: 'integer' }, sender: 'user:alice', ...(replayed ? {} : { sender_device_id: { $ref: 'mac_device_id' } }), type: 'text', payload: { body } },
})
const send = (client, body, local_id) => ({ kind: 'ws_send', role: 'client', client, conn: client, frame: { op: 'send', convo_id: 'c1', payload: { body }, local_id } })

function lifecycleFixture(reconnectStep) {
  return {
    name: 'phone drops, mac sends while it is away, phone reconnects from its cursor',
    description: 'The reconnecting client replays only what it missed.',
    protocol: 1,
    seed: { users: [{ as: 'alice', name: 'alice', password: 'fixture-pw-7' }], conversations: [{ id: 'c1', owner: 'alice' }] },
    steps: [
      login('mac', 'mac_token'), login('phone', 'phone_token'),
      ...hello('mac', 'mac_token', 0), ...hello('phone', 'phone_token', 0),
      send('mac', 'one', 'l1'), journal('mac', 1, 'one'), journal('phone', 1, 'one'),
      { kind: 'disconnect', role: 'client', client: 'phone', conn: 'phone' },
      { kind: 'advance_clock', role: 'client', client: 'phone', ms: 30000 },
      send('mac', 'two', 'l2'), journal('mac', 2, 'two'),
      reconnectStep,
      { kind: 'ws_expect', role: 'client', client: 'phone', conn: 'phone', frame: { kind: 'control', op: 'hello_ok', coordinator_convo_id: null, settings: { notices: true, auto_approve_coordinator_spawns: false, auto_archive_days: 30 }, pins: [], seq: 2, device_id: { $type: 'integer' }, name: 'phone' } },
      journal('phone', 2, 'two', true),
      { kind: 'ws_expect_none', role: 'client', client: 'phone', conn: 'phone', ms: 150 },
    ],
  }
}

for (const [label, reconnect, expectStatus] of [
  ['the cursor defaults to the last seq the client applied', { kind: 'reconnect_from_cursor', role: 'client', client: 'phone', conn: 'phone' }, 'pass'],
  ['an explicit cursor is used as given (cursor 0 replays seq 1 first)', { kind: 'reconnect_from_cursor', role: 'client', client: 'phone', conn: 'phone', cursor: 0 }, 'fail'],
]) {
  test(`lifecycle steps, runner plays one client, coordinator the other: ${label}`, async (t) => {
    const fixture = lifecycleFixture(reconnect)
    const booted = await withServer(t, fixture)
    const runner = createActor({ base: booted.base })
    t.after(() => runner.close())
    const result = await replayFixture({ fixture, base: booted.base, bindings: booted.bindings, control: booted.control, runner, play: ['client:phone'] })
    assert.equal(result.status, expectStatus, result.error)
    if (expectStatus === 'fail') assert.match(result.error, /expected "two", got "one"/)
    if (expectStatus === 'pass') assert.equal(runner.clockMs, 30000)
  })
}

test('a runner command that does not exist fails to start without crashing the coordinator', async () => {
  await assert.rejects(
    spawnRunner({ command: '/nonexistent/runner', base: 'http://127.0.0.1:1', readyTimeoutMs: 2000 }),
    /ENOENT|exited|EPIPE/,
  )
})

test('a runner that drops a step fails that step instead of hanging the run', async (t) => {
  const fixture = load('01_login.json')
  const booted = await withServer(t, fixture)
  const silent = path.join(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'conf-silent-')), 'silent-runner.mjs')
  fs.writeFileSync(silent, `
    import readline from 'node:readline'
    const rl = readline.createInterface({ input: process.stdin })
    rl.on('line', (l) => {
      const m = JSON.parse(l)
      if (m.op === 'init') process.stdout.write(JSON.stringify({ op: 'ready', capabilities: ['http', 'ws'] }) + '\\n')
      if (m.op === 'close') process.exit(0)
    })
  `)
  t.after(() => fs.rmSync(path.dirname(silent), { recursive: true, force: true }))
  const runner = await spawnRunner({ command: process.execPath, args: [silent], base: booted.base, stepTimeoutMs: 300 })
  t.after(() => runner.close())
  const result = await replayFixture({ fixture, base: booted.base, bindings: booted.bindings, control: booted.control, runner, play: ['client'] })
  assert.equal(result.status, 'fail')
  assert.equal(result.failedStep, 0)
  assert.match(result.error, /did not answer step 0/)
})

test('--play names that match no client lane are refused rather than silently run by the coordinator', async (t) => {
  const fixture = load('01_login.json')
  const booted = await withServer(t, fixture)
  const runner = createActor({ base: booted.base })
  t.after(() => runner.close())
  for (const play of [['client:nobody'], ['agent'], []]) {
    const r = await replayFixture({ fixture, base: booted.base, bindings: booted.bindings, control: booted.control, runner, play })
    assert.equal(r.status, 'invalid', `play ${JSON.stringify(play)}`)
  }
})

test('the schema checks seed cross-references', async () => {
  const { validateFixture } = await import('../tools/conformance/schema.js')
  const f = load('13_tool_stream.json')
  f.seed.conversations[0].owner = 'nobody'
  assert.match(validateFixture(f).join(';'), /unknown user 'nobody'/)
})

test('a reconnect after a live-only hello stays live-only', async (t) => {
  const fixture = {
    name: 'live-only reconnect', description: 'cursor null stays null on reconnect', protocol: 1,
    seed: { users: [{ as: 'alice', name: 'alice', password: 'fixture-pw-7' }], conversations: [{ id: 'c1', owner: 'alice' }], events: [{ convo: 'c1', sender: 'agent:box-2', type: 'text', payload: { body: 'old' } }] },
    steps: [
      login('mac', 'mac_token'), ...hello('mac', 'mac_token', null),
      { kind: 'disconnect', role: 'client', client: 'mac', conn: 'mac' },
      { kind: 'reconnect_from_cursor', role: 'client', client: 'mac', conn: 'mac' },
      { kind: 'ws_expect', role: 'client', client: 'mac', conn: 'mac', frame: { kind: 'control', op: 'hello_ok', coordinator_convo_id: null, settings: { notices: true, auto_approve_coordinator_spawns: false, auto_archive_days: 30 }, pins: [], seq: 1, device_id: { $type: 'integer' }, name: 'mac' } },
      { kind: 'ws_expect_none', role: 'client', client: 'mac', conn: 'mac', ms: 150 },
    ],
  }
  const booted = await withServer(t, fixture)
  const runner = createActor({ base: booted.base })
  t.after(() => runner.close())
  const result = await replayFixture({ fixture, base: booted.base, bindings: booted.bindings, control: booted.control, runner, play: ['client'] })
  assert.equal(result.status, 'pass', result.error)
})
