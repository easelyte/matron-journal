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
const ACTIVITY = { live_sessions: 2, last_hour: [{ path: '/home/dan/app', sessions: 1 }] }
const DISK = { free_bytes: 10, total_bytes: 100 }
const VITALS = { cpu_pct: 12.5, ram_pct: 63.1, sampled_at_ms: 1758460000000 }

async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agDev = createAgent(s.db, dan.id, 'gene')
  const otherDev = createAgent(s.db, dan.id, 'eric')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const clientToken = login.json.token
  const agent = await makeWsClient(s.base, { token: agDev.token, cursor: null })
  const client = await makeWsClient(s.base, { token: clientToken, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { agent.close(); client.close() })
  agent.frames.length = 0
  client.frames.length = 0
  return { s, dan, agDev, otherDev, clientToken, agent, client }
}

test('box_status persists per device, fans to client sockets, and shows on /devices and /roster', async (t) => {
  const { s, dan, agDev, clientToken, agent, client } = await fleet(t)
  agent.send({ op: 'box_status', activity: ACTIVITY, limits: LIMITS, disk: DISK, account: { email: 'dan@example.com' } })
  const live = await client.waitFor((f) => f.kind === 'box_status')
  assert.equal(live.device_id, agDev.deviceId)
  assert.ok(Number.isInteger(live.reported_at))
  assert.deepEqual(live.limits, LIMITS)
  assert.deepEqual(live.activity, ACTIVITY)
  assert.deepEqual(live.disk, DISK)
  assert.deepEqual(live.account, { email: 'dan@example.com' })
  // The agent's own socket never hears it (not a conversation frame).
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(agent.frames.find((f) => f.kind === 'box_status'), undefined)
  const stored = deviceStatuses(s.db, dan.id).get(agDev.deviceId)
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
  assert.equal('status' in roster.json.agents.find((d) => d.name === 'eric'), false)
})

test('box_status: latest wins, a malformed block is dropped but the rest kept, an empty report is refused, clients are forbidden', async (t) => {
  const { s, dan, agDev, agent, client } = await fleet(t)
  agent.send({ op: 'box_status', limits: LIMITS })
  await client.waitFor((f) => f.kind === 'box_status')
  client.frames.length = 0
  // Second report: limits malformed (percent out of range), disk fine.
  agent.send({ op: 'box_status', limits: { as_of: 1, lines: [{ id: 'x', label: 'y', percent: 5000 }] }, disk: DISK })
  const second = await client.waitFor((f) => f.kind === 'box_status')
  assert.equal('limits' in second, false)
  assert.deepEqual(second.disk, DISK)
  const stored = deviceStatuses(s.db, dan.id).get(agDev.deviceId)
  assert.equal('limits' in stored, false, 'latest report replaces the whole row')
  assert.deepEqual(stored.disk, DISK)
  // Nothing valid at all: refused, row untouched.
  agent.send({ op: 'box_status', limits: 'nope' })
  const err = await agent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'bad_request')
  assert.deepEqual(deviceStatuses(s.db, dan.id).get(agDev.deviceId).disk, DISK)
  client.send({ op: 'box_status', disk: DISK })
  const forb = await client.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(forb.code, 'forbidden')
})

test('spawn_targets: a live recent_folders reply is stored as the box status; an offline box is listed with its stored blocks and reported_at', async (t) => {
  const { s, dan, agDev, otherDev, agent } = await fleet(t)
  // eric reported earlier, then went to sleep.
  const eric = await makeWsClient(s.base, { token: otherDev.token, cursor: null })
  await eric.waitFor((f) => f.op === 'hello_ok')
  eric.send({ op: 'box_status', limits: LIMITS, disk: DISK })
  await new Promise((r) => setTimeout(r, 80))
  eric.close()
  await new Promise((r) => setTimeout(r, 80))
  // gene answers its own recent_folders with capacity blocks.
  const answer = agent.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders', 3000)
    .then((req) => agent.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [], activity: ACTIVITY, disk: DISK } }))
  agent.send({ op: 'spawn_targets', request_id: 'q1' })
  await answer
  const reply = await agent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets', 5000)
  const me = reply.boxes.find((b) => b.device_id === agDev.deviceId)
  assert.equal(me.online, true)
  assert.deepEqual(me.activity, ACTIVITY)
  assert.ok(Number.isInteger(me.reported_at))
  assert.deepEqual(deviceStatuses(s.db, dan.id).get(agDev.deviceId).activity, ACTIVITY, 'the live reply was persisted')
  const asleep = reply.boxes.find((b) => b.device_id === otherDev.deviceId)
  assert.equal(asleep.online, false)
  assert.deepEqual(asleep.limits, LIMITS, 'stored blocks ride along for an offline box')
  assert.deepEqual(asleep.disk, DISK)
  assert.ok(Number.isInteger(asleep.reported_at))
  assert.deepEqual(asleep.folders, [])
})

test('spawn_targets: a live reply refreshes the blocks it carries and keeps the ones it omits (account never rides recent_folders)', async (t) => {
  const { s, dan, agDev, clientToken, agent } = await fleet(t)
  agent.send({ op: 'box_status', limits: LIMITS, disk: { free_bytes: 1, total_bytes: 100 }, account: { email: 'dan@example.com' } })
  await new Promise((r) => setTimeout(r, 80))
  const before = deviceStatuses(s.db, dan.id).get(agDev.deviceId)
  assert.deepEqual(before.account, { email: 'dan@example.com' })
  await new Promise((r) => setTimeout(r, 5))
  // The recent_folders reply carries activity and a newer disk, no limits, no account.
  const answer = agent.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders', 3000)
    .then((req) => agent.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [], activity: ACTIVITY, disk: DISK } }))
  agent.send({ op: 'spawn_targets', request_id: 'q2' })
  await answer
  await agent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets', 5000)
  const after = deviceStatuses(s.db, dan.id).get(agDev.deviceId)
  assert.deepEqual(after.activity, ACTIVITY, 'carried block refreshed')
  assert.deepEqual(after.disk, DISK, 'carried block replaced, not merged inside')
  assert.deepEqual(after.limits, LIMITS, 'omitted block kept')
  assert.deepEqual(after.account, { email: 'dan@example.com' }, 'account kept: recent_folders never carries it')
  assert.ok(after.reported_at > before.reported_at)
  const devs = await s.http('/devices', { token: clientToken })
  const row = devs.json.devices.find((d) => d.device_id === agDev.deviceId)
  assert.deepEqual(row.status.account, { email: 'dan@example.com' })
  assert.deepEqual(row.status.limits, LIMITS)
})

test('spawn_targets: a box_status that lands while recent_folders is in flight wins over the delayed reply', async (t) => {
  const { s, dan, agDev, agent } = await fleet(t)
  const NEWER = { ...LIMITS, lines: [{ id: '5h', label: 'Current session', percent: 77, resets: 'in 1h' }] }
  let reportedAt = null
  const answer = agent.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders', 3000)
    .then(async (req) => {
      // RPC issued; the bridge's own report arrives before it answers.
      agent.send({ op: 'box_status', limits: NEWER, account: { email: 'dan@example.com' } })
      await new Promise((r) => setTimeout(r, 80))
      reportedAt = deviceStatuses(s.db, dan.id).get(agDev.deviceId).reported_at
      agent.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [], limits: LIMITS, disk: DISK } })
    })
  agent.send({ op: 'spawn_targets', request_id: 'q3' })
  await answer
  const reply = await agent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets', 5000)
  const me = reply.boxes.find((b) => b.device_id === agDev.deviceId)
  assert.deepEqual(me.limits, NEWER, 'the listing carries the newer report, not the stale reply')
  assert.equal(me.reported_at, reportedAt)
  assert.equal('disk' in me, false, 'the stale reply contributes nothing')
  const stored = deviceStatuses(s.db, dan.id).get(agDev.deviceId)
  assert.deepEqual(stored.limits, NEWER, 'the stale reply did not overwrite the row')
  assert.deepEqual(stored.account, { email: 'dan@example.com' })
  assert.equal(stored.reported_at, reportedAt)
})

test('box_status: a vitals block persists, fans live, and shows on /devices and /roster; a vitals-only report is accepted', async (t) => {
  const { s, dan, agDev, clientToken, agent, client } = await fleet(t)
  agent.send({ op: 'box_status', vitals: { ...VITALS, junk: 'x' } })
  const live = await client.waitFor((f) => f.kind === 'box_status')
  assert.equal(live.device_id, agDev.deviceId)
  assert.deepEqual(live.vitals, VITALS)
  assert.deepEqual(deviceStatuses(s.db, dan.id).get(agDev.deviceId).vitals, VITALS)
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
