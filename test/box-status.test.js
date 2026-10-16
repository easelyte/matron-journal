import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { deviceStatuses } from '../src/db.js'

// Box status lives in the journal (spec 2026-09-21): a bridge reports its
// own box's usage/allowances/disk/account with `box_status`; the journal
// persists it per device, fans it to the user's client sockets, and serves
// it from GET /devices and GET /roster — so every client sees every box's
// last known state, including one that is asleep or that this client has
// never talked to. spawn_targets lists an offline box with its stored blocks.

const LIMITS = { as_of: 1758460000000, lines: [{ id: '5h', label: 'Current session', percent: 42, resets: 'in 2h' }] }
const ACTIVITY = { live_sessions: 2, last_hour: [{ path: '/home/alice/app', sessions: 1 }] }
const DISK = { free_bytes: 10, total_bytes: 100 }
const VITALS = { cpu_pct: 12.5, ram_pct: 63.1, sampled_at_ms: 1758460000000 }

async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const agDev = createAgent(s.db, alice.id, 'jade')
  const otherDev = createAgent(s.db, alice.id, 'opal')
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  const clientToken = login.json.token
  const agent = await makeWsClient(s.base, { token: agDev.token, cursor: null })
  const client = await makeWsClient(s.base, { token: clientToken, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { agent.close(); client.close() })
  agent.frames.length = 0
  client.frames.length = 0
  return { s, alice, agDev, otherDev, clientToken, agent, client }
}

test('box_status persists per device, fans to client sockets, and shows on /devices and /roster', async (t) => {
  const { s, alice, agDev, clientToken, agent, client } = await fleet(t)
  agent.send({ op: 'box_status', activity: ACTIVITY, limits: LIMITS, disk: DISK, account: { email: 'alice@example.com' } })
  const live = await client.waitFor((f) => f.kind === 'box_status')
  assert.equal(live.device_id, agDev.deviceId)
  assert.ok(Number.isInteger(live.reported_at))
  assert.deepEqual(live.limits, LIMITS)
  assert.deepEqual(live.activity, ACTIVITY)
  assert.deepEqual(live.disk, DISK)
  assert.deepEqual(live.account, { email: 'alice@example.com' })
  // The agent's own socket never hears it (not a conversation frame).
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(agent.frames.find((f) => f.kind === 'box_status'), undefined)
  const stored = deviceStatuses(s.db, alice.id).get(agDev.deviceId)
  assert.deepEqual(stored.limits, LIMITS)
  const devs = await s.http('/devices', { token: clientToken })
  const row = devs.json.devices.find((d) => d.device_id === agDev.deviceId)
  assert.deepEqual(row.status.limits, LIMITS)
  assert.equal(row.status.reported_at, live.reported_at)
  // A device that never reported has no status key at all.
  const mac = devs.json.devices.find((d) => d.kind === 'client')
  assert.equal('status' in mac, false)
  const roster = await s.http('/roster', { token: clientToken })
  const rAgent = roster.json.agents.find((d) => d.device_id === agDev.deviceId)
  assert.deepEqual(rAgent.status.activity, ACTIVITY)
  assert.equal('status' in roster.json.agents.find((d) => d.name === 'opal'), false)
})

test('box_status: latest wins, a malformed block is dropped but the rest kept, an empty report is refused, clients are forbidden', async (t) => {
  const { s, alice, agDev, agent, client } = await fleet(t)
  agent.send({ op: 'box_status', limits: LIMITS })
  await client.waitFor((f) => f.kind === 'box_status')
  client.frames.length = 0
  // Second report: limits malformed (percent out of range), disk fine.
  agent.send({ op: 'box_status', limits: { as_of: 1, lines: [{ id: 'x', label: 'y', percent: 5000 }] }, disk: DISK })
  const second = await client.waitFor((f) => f.kind === 'box_status')
  assert.equal('limits' in second, false)
  assert.deepEqual(second.disk, DISK)
  const stored = deviceStatuses(s.db, alice.id).get(agDev.deviceId)
  assert.equal('limits' in stored, false, 'latest report replaces the whole row')
  assert.deepEqual(stored.disk, DISK)
  // Nothing valid at all: refused, row untouched.
  agent.send({ op: 'box_status', limits: 'nope' })
  const err = await agent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'bad_request')
  assert.deepEqual(deviceStatuses(s.db, alice.id).get(agDev.deviceId).disk, DISK)
  client.send({ op: 'box_status', disk: DISK })
  const forb = await client.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(forb.code, 'forbidden')
})

test('spawn_targets: a live recent_folders reply is stored as the box status; an offline box is listed with its stored blocks and reported_at', async (t) => {
  const { s, alice, agDev, otherDev, agent } = await fleet(t)
  // opal reported earlier, then went to sleep.
  const opal = await makeWsClient(s.base, { token: otherDev.token, cursor: null })
  await opal.waitFor((f) => f.op === 'hello_ok')
  opal.send({ op: 'box_status', limits: LIMITS, disk: DISK })
  await new Promise((r) => setTimeout(r, 80))
  opal.close()
  await new Promise((r) => setTimeout(r, 80))
  // jade answers its own recent_folders with capacity blocks.
  const answer = agent.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders', 3000)
    .then((req) => agent.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [], activity: ACTIVITY, disk: DISK } }))
  agent.send({ op: 'spawn_targets', request_id: 'q1' })
  await answer
  const reply = await agent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets', 5000)
  const me = reply.boxes.find((b) => b.device_id === agDev.deviceId)
  assert.equal(me.online, true)
  assert.deepEqual(me.activity, ACTIVITY)
  assert.ok(Number.isInteger(me.reported_at))
  assert.deepEqual(deviceStatuses(s.db, alice.id).get(agDev.deviceId).activity, ACTIVITY, 'the live reply was persisted')
  const asleep = reply.boxes.find((b) => b.device_id === otherDev.deviceId)
  assert.equal(asleep.online, false)
  assert.deepEqual(asleep.limits, LIMITS, 'stored blocks ride along for an offline box')
  assert.deepEqual(asleep.disk, DISK)
  assert.ok(Number.isInteger(asleep.reported_at))
  assert.deepEqual(asleep.folders, [])
})

test('spawn_targets: a live reply refreshes the blocks it carries and keeps the ones it omits (account never rides recent_folders)', async (t) => {
  const { s, alice, agDev, clientToken, agent } = await fleet(t)
  agent.send({ op: 'box_status', limits: LIMITS, disk: { free_bytes: 1, total_bytes: 100 }, account: { email: 'alice@example.com' } })
  await new Promise((r) => setTimeout(r, 80))
  const before = deviceStatuses(s.db, alice.id).get(agDev.deviceId)
  assert.deepEqual(before.account, { email: 'alice@example.com' })
  await new Promise((r) => setTimeout(r, 5))
  // The recent_folders reply carries activity and a newer disk, no limits, no account.
  const answer = agent.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders', 3000)
    .then((req) => agent.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [], activity: ACTIVITY, disk: DISK } }))
  agent.send({ op: 'spawn_targets', request_id: 'q2' })
  await answer
  await agent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets', 5000)
  const after = deviceStatuses(s.db, alice.id).get(agDev.deviceId)
  assert.deepEqual(after.activity, ACTIVITY, 'carried block refreshed')
  assert.deepEqual(after.disk, DISK, 'carried block replaced, not merged inside')
  assert.deepEqual(after.limits, LIMITS, 'omitted block kept')
  assert.deepEqual(after.account, { email: 'alice@example.com' }, 'account kept: recent_folders never carries it')
  assert.ok(after.reported_at > before.reported_at)
  const devs = await s.http('/devices', { token: clientToken })
  const row = devs.json.devices.find((d) => d.device_id === agDev.deviceId)
  assert.deepEqual(row.status.account, { email: 'alice@example.com' })
  assert.deepEqual(row.status.limits, LIMITS)
})

test('spawn_targets: a box_status that lands while recent_folders is in flight wins over the delayed reply', async (t) => {
  const { s, alice, agDev, agent } = await fleet(t)
  const NEWER = { ...LIMITS, lines: [{ id: '5h', label: 'Current session', percent: 77, resets: 'in 1h' }] }
  let reportedAt = null
  const answer = agent.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders', 3000)
    .then(async (req) => {
      // RPC issued; the bridge's own report arrives before it answers.
      agent.send({ op: 'box_status', limits: NEWER, account: { email: 'alice@example.com' } })
      await new Promise((r) => setTimeout(r, 80))
      reportedAt = deviceStatuses(s.db, alice.id).get(agDev.deviceId).reported_at
      agent.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [], limits: LIMITS, disk: DISK } })
    })
  agent.send({ op: 'spawn_targets', request_id: 'q3' })
  await answer
  const reply = await agent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets', 5000)
  const me = reply.boxes.find((b) => b.device_id === agDev.deviceId)
  assert.deepEqual(me.limits, NEWER, 'the listing carries the newer report, not the stale reply')
  assert.equal(me.reported_at, reportedAt)
  assert.equal('disk' in me, false, 'the stale reply contributes nothing')
  const stored = deviceStatuses(s.db, alice.id).get(agDev.deviceId)
  assert.deepEqual(stored.limits, NEWER, 'the stale reply did not overwrite the row')
  assert.deepEqual(stored.account, { email: 'alice@example.com' })
  assert.equal(stored.reported_at, reportedAt)
})

test('box_status: a vitals block persists, fans live, and shows on /devices and /roster; a vitals-only report is accepted', async (t) => {
  const { s, alice, agDev, clientToken, agent, client } = await fleet(t)
  agent.send({ op: 'box_status', vitals: { ...VITALS, junk: 'x' } })
  const live = await client.waitFor((f) => f.kind === 'box_status')
  assert.equal(live.device_id, agDev.deviceId)
  assert.deepEqual(live.vitals, VITALS)
  assert.deepEqual(deviceStatuses(s.db, alice.id).get(agDev.deviceId).vitals, VITALS)
  const devs = await s.http('/devices', { token: clientToken })
  assert.deepEqual(devs.json.devices.find((d) => d.device_id === agDev.deviceId).status.vitals, VITALS)
  const roster = await s.http('/roster', { token: clientToken })
  assert.deepEqual(roster.json.agents.find((d) => d.device_id === agDev.deviceId).status.vitals, VITALS)
  // A malformed vitals block is dropped alone; the rest of the report stands.
  client.frames.length = 0
  agent.send({ op: 'box_status', disk: DISK, vitals: { ...VITALS, cpu_pct: 101 } })
  const second = await client.waitFor((f) => f.kind === 'box_status')
  assert.equal('vitals' in second, false)
  assert.deepEqual(second.disk, DISK)
})

// Planned-restart state: a bridge publishes where a restart stands so a
// fleet watcher sees it from the journal. Capped on the way in, and kept
// across later reports that do not mention it (box_status otherwise
// replaces the whole row).
// Shapes copied from what a bridge emits: waiting_on carries nested quiet /
// preflight / collect objects and an unwarned list; results carries a
// verdicts map (id -> outcome) next to no_note and code_mismatch.
const RESTART = {
  id: '5b1f2c0e-7d34-4a8e-9a55-0c1f6e2d9b10',
  state: 'pending',
  requests: [{ sha: 'deadbeefcafe', reason: 'deploy' }],
  pending_since: 1760000000000,
  waiting_on: {
    quiet: { holders: [{ convoId: 'c-1', why: 'turn in progress' }], probe_error: null },
    code: null,
    preflight: { error: 'config invalid' },
    collect: { remaining_ms: 12000 },
    unwarned: ['c-2'],
  },
  expected_sha: 'deadbeefcafe',
}
const RESTART_BACK = {
  ...RESTART,
  state: 'back',
  waiting_on: { quiet: { holders: [], probe_error: null }, code: null, preflight: { unknown: true }, collect: null, unwarned: [] },
  results: {
    verdicts: { 'c-1': 'resumed', 'c-2': 'failed', 'c-3': 'possibly_delivered' },
    no_note: ['c-4'],
    code_mismatch: false,
  },
  truncated: { requests: 3 },
}

test('box_status.restart is stored and relayed; a frame without it keeps the stored one', async (t) => {
  const { s, alice, agDev, clientToken, agent, client } = await fleet(t)
  // A report carrying only the restart block is valid.
  agent.send({ op: 'box_status', restart: RESTART })
  const live = await client.waitFor((f) => f.kind === 'box_status')
  assert.deepEqual(live.restart, RESTART)
  assert.deepEqual(deviceStatuses(s.db, alice.id).get(agDev.deviceId).restart, RESTART)

  // A later usage refresh with no restart: replaces the other blocks, keeps restart.
  client.frames.length = 0
  agent.send({ op: 'box_status', limits: LIMITS, disk: DISK })
  const second = await client.waitFor((f) => f.kind === 'box_status')
  assert.deepEqual(second.limits, LIMITS)
  assert.deepEqual(second.restart, RESTART)
  const stored = deviceStatuses(s.db, alice.id).get(agDev.deviceId)
  assert.deepEqual(stored.restart, RESTART)
  assert.deepEqual(stored.limits, LIMITS)
  const devs = await s.http('/devices', { token: clientToken })
  assert.deepEqual(devs.json.devices.find((d) => d.device_id === agDev.deviceId).status.restart, RESTART)

  // A later frame with a new restart state replaces it; the kept one moves on.
  client.frames.length = 0
  const back = RESTART_BACK
  agent.send({ op: 'box_status', limits: LIMITS, restart: back })
  const third = await client.waitFor((f) => f.kind === 'box_status')
  assert.deepEqual(third.restart, back)
  // Other blocks still replace: a frame without limits drops limits, not restart.
  client.frames.length = 0
  agent.send({ op: 'box_status', disk: DISK })
  const fourth = await client.waitFor((f) => f.kind === 'box_status')
  assert.equal('limits' in fourth, false)
  assert.deepEqual(fourth.restart, back)
})

test('box_status.restart is capped and sanitised; a malformed block is dropped and the old one kept', async (t) => {
  const { s, alice, agDev, agent, client } = await fleet(t)
  const deep = { a: { b: { c: { d: { e: 1 } } } } }
  const big = {
    id: 'r1',
    state: 'pending',
    requests: Array.from({ length: 100 }, (_, i) => ({ conversation: `c${i}`, note: 'x'.repeat(500), nested: { a: 1 }, 'bad key': 1 })),
    pending_since: 1760000000000,
    waiting_on: {
      ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i % 2 ? 'y'.repeat(500) : Array.from({ length: 200 }, (_, j) => `s${j}`)])),
    },
    expected_sha: 'not a sha',
    results: { resumed: Array.from({ length: 500 }, (_, i) => `s${i}`), failed: 'nope', no_note: ['a\nb'], code_mismatch: true, extra: 1,
      verdicts: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`c${i}`, 'z'.repeat(500)])) },
    truncated: { requests: 3, 'bad key': 1, holders: -1 },
    extra: 'dropped',
  }
  agent.send({ op: 'box_status', restart: big })
  const live = await client.waitFor((f) => f.kind === 'box_status')
  const r = live.restart
  assert.equal(r.requests.length, 32)
  assert.deepEqual(Object.keys(r.requests[0]), ['conversation', 'note'])
  assert.equal(r.requests[0].note.length, 200)
  // 16 keys at most, and the 200-node budget cuts the tail of a chatty report.
  assert.ok(Object.keys(r.waiting_on).length > 0 && Object.keys(r.waiting_on).length <= 16)
  for (const v of Object.values(r.waiting_on)) assert.ok(Array.isArray(v) ? v.length <= 64 : v.length === 200)
  assert.ok(JSON.stringify(r.waiting_on).length < 12000)
  assert.equal(Object.keys(r.results.verdicts).length, 64)
  assert.ok(Object.values(r.results.verdicts).every((v) => v.length === 200))
  assert.deepEqual(r.truncated, { requests: 3 })
  assert.equal('expected_sha' in r, false)
  assert.equal(r.results.resumed.length, 64)
  assert.equal('failed' in r.results, false)
  assert.deepEqual(r.results.no_note, ['a b'])
  assert.equal(r.results.code_mismatch, true)
  assert.equal('extra' in r, false)
  assert.equal('extra' in r.results, false)

  // Bad state: the block is dropped, the stored one stays, other blocks land.
  client.frames.length = 0
  agent.send({ op: 'box_status', disk: DISK, restart: { id: 'r2', state: 'sideways' } })
  const next = await client.waitFor((f) => f.kind === 'box_status')
  assert.deepEqual(next.disk, DISK)
  assert.equal(next.restart.id, 'r1')
  // A frame whose only block is a bad restart is rejected, as an empty one is.
  agent.send({ op: 'box_status', restart: { id: '', state: 'back' } })
  const err = await agent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'bad_request')
  assert.equal(deviceStatuses(s.db, alice.id).get(agDev.deviceId).restart.id, 'r1')
})

test('box_status.restart nested values are bounded in depth and unknown result keys are dropped', async (t) => {
  const { agent, client } = await fleet(t)
  agent.send({ op: 'box_status', restart: { id: 'r1', state: 'pending',
    waiting_on: { quiet: { a: { b: { c: { d: { e: 1 } } } } }, other: [[[[['deep']]]]] },
    results: { verdicts: { 'c-1': 'resumed' }, secret: 'x' } } })
  const live = await client.waitFor((f) => f.kind === 'box_status')
  assert.deepEqual(live.restart.waiting_on.quiet, { a: { b: { c: {} } } })
  assert.deepEqual(live.restart.waiting_on.other, [[[[]]]])
  assert.deepEqual(live.restart.results, { verdicts: { 'c-1': 'resumed' } })
})

test('box_status.restart cancel path: pending -> cancelling -> cancelled is stored and relayed, and kept across omitting reports', async (t) => {
  const { s, alice, agDev, agent, client } = await fleet(t)
  agent.send({ op: 'box_status', restart: RESTART })
  assert.equal((await client.waitFor((f) => f.kind === 'box_status')).restart.state, 'pending')
  for (const state of ['cancelling', 'cancelled']) {
    client.frames.length = 0
    agent.send({ op: 'box_status', restart: { ...RESTART, state, requests: [] } })
    const f = await client.waitFor((fr) => fr.kind === 'box_status')
    assert.equal(f.restart.state, state)
    assert.deepEqual(f.restart.requests, [])
    assert.equal(deviceStatuses(s.db, alice.id).get(agDev.deviceId).restart.state, state)
  }
  // A later report that omits the field keeps the cancelled state (terminal
  // states persist until the next restart's block replaces them).
  client.frames.length = 0
  agent.send({ op: 'box_status', disk: DISK })
  const after = await client.waitFor((f) => f.kind === 'box_status')
  assert.equal(after.restart.state, 'cancelled')
  assert.equal(deviceStatuses(s.db, alice.id).get(agDev.deviceId).restart.state, 'cancelled')
  // A new restart supersedes it; abandoned is accepted too.
  agent.send({ op: 'box_status', restart: { ...RESTART_BACK, state: 'abandoned', id: 'next' } })
  assert.equal((await client.waitFor((f) => f.kind === 'box_status' && f.restart?.id === 'next')).restart.state, 'abandoned')
})
