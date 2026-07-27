import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'

// The `host_vitals` op: the bridge (agent connection) samples the HOST
// machine (cpu/ram) and relays it with NO convo_id. Unlike `status`/`activity`
// (viewing-scoped), the server fans it out to EVERY one of the user's client
// connections regardless of what convo they're viewing, and never journals it
// (pure ephemeral). The last sample is cached per user and replayed on connect.

const VITALS = { cpu: 37.5, ram: 61.2, sampled_at_ms: 1721990000000 }

async function setup(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await agent.waitFor((f) => f.op === 'hello_ok')
  const clientHello = await client.waitFor((f) => f.op === 'hello_ok')
  return { s, dan, ag, login, agent, client, clientHello }
}

test('agent host_vitals reaches every client regardless of viewingConvoId', async (t) => {
  const { s, login, agent, client } = await setup(t)
  // client (client1) is viewing nothing at all.
  // client2 is viewing a specific convo — status would gate on that; vitals must not.
  const client2 = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await client2.waitFor((f) => f.op === 'hello_ok')
  client2.send({ op: 'viewing', convo_id: 'some-convo' })
  await new Promise((r) => setTimeout(r, 50))

  agent.send({ op: 'host_vitals', vitals: VITALS })
  const f1 = await client.waitFor((f) => f.kind === 'ephemeral' && f.host_vitals)
  const f2 = await client2.waitFor((f) => f.kind === 'ephemeral' && f.host_vitals)
  assert.deepEqual(f1.host_vitals, VITALS)
  assert.deepEqual(f2.host_vitals, VITALS)
  // Exact client-facing frame shape: { kind:'ephemeral', host_vitals:{...} } — no convo_id.
  assert.deepEqual(Object.keys(f1).sort(), ['host_vitals', 'kind'])
  assert.equal(f1.kind, 'ephemeral')
  agent.close(); client.close(); client2.close()
})

test('host_vitals is never journaled and is not echoed back to the agent', async (t) => {
  const { s, agent, client } = await setup(t)
  agent.send({ op: 'host_vitals', vitals: VITALS })
  await client.waitFor((f) => f.kind === 'ephemeral' && f.host_vitals)
  await new Promise((r) => setTimeout(r, 100))

  // No DB append — the events table is untouched.
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0)
  // No journal frame carrying vitals reached the client.
  assert.equal(client.frames.some((f) => f.kind === 'journal'), false)
  // The agent does not receive an echo of its own vitals (client-only fan-out).
  assert.equal(agent.frames.some((f) => f.host_vitals), false)
  agent.close(); client.close()
})

test('a non-agent (client) sender is rejected as forbidden', async (t) => {
  const { agent, client } = await setup(t)
  client.send({ op: 'host_vitals', vitals: VITALS })
  await client.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'forbidden' && f.ref === 'host_vitals')
  // A forbidden op must not spill to any other client either.
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(agent.frames.some((f) => f.host_vitals), false)
  assert.equal(client.frames.some((f) => f.kind === 'ephemeral' && f.host_vitals), false)
  assert.equal(client.ws.readyState, 1)
  agent.close(); client.close()
})

test('a missing or non-object vitals is bad_request; connection survives', async (t) => {
  const { agent } = await setup(t)
  agent.send({ op: 'host_vitals' })
  await agent.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'bad_request' && f.ref === 'host_vitals')
  agent.send({ op: 'host_vitals', vitals: 'not-an-object' })
  await agent.waitFor((f) =>
    agent.frames.filter((x) => x.kind === 'control' && x.op === 'error' && x.code === 'bad_request' && x.ref === 'host_vitals').length >= 2)
  agent.send({ op: 'host_vitals', vitals: null })
  await agent.waitFor((f) =>
    agent.frames.filter((x) => x.kind === 'control' && x.op === 'error' && x.code === 'bad_request' && x.ref === 'host_vitals').length >= 3)
  assert.equal(agent.ws.readyState, 1)
  agent.close()
})

test('an oversized vitals is bad_request, not cached or broadcast', async (t) => {
  const { s, login, agent, client } = await setup(t)
  agent.send({ op: 'host_vitals', vitals: { blob: 'x'.repeat(5000) } })
  await agent.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'bad_request' && f.ref === 'host_vitals')
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(client.frames.some((f) => f.kind === 'ephemeral' && f.host_vitals), false)

  // Not cached: a freshly-connecting client gets no paint-on-connect replay.
  const fresh = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await fresh.waitFor((f) => f.op === 'hello_ok')
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(fresh.frames.some((f) => f.kind === 'ephemeral' && f.host_vitals), false)
  agent.close(); client.close(); fresh.close()
})

test('the last host_vitals is cached and replayed to a client on connect', async (t) => {
  const { s, login, agent } = await setup(t)
  agent.send({ op: 'host_vitals', vitals: { cpu: 1, ram: 2, sampled_at_ms: 1 } })
  // >1s gap so the second sample clears the min-interval throttle and becomes
  // the cached latest (a sub-second second frame would be dropped).
  await new Promise((r) => setTimeout(r, 1100))
  agent.send({ op: 'host_vitals', vitals: VITALS })
  await new Promise((r) => setTimeout(r, 50))

  // A client that connects AFTER the samples still paints immediately with the latest.
  const late = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await late.waitFor((f) => f.op === 'hello_ok')
  const frame = await late.waitFor((f) => f.kind === 'ephemeral' && f.host_vitals)
  assert.deepEqual(frame.host_vitals, VITALS)
  // Exactly one replay (the cached latest), not one per sample.
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(late.frames.filter((f) => f.kind === 'ephemeral' && f.host_vitals).length, 1)
  agent.close(); late.close()
})

test('a sub-interval flood is throttled: only the first frame is broadcast', async (t) => {
  const { agent, client } = await setup(t)
  client.send({ op: 'viewing', convo_id: 'anything' }) // proves it's not a viewing effect
  await new Promise((r) => setTimeout(r, 50))

  // Five frames fired back-to-back, all inside the 1s floor.
  for (let i = 0; i < 5; i++) agent.send({ op: 'host_vitals', vitals: { cpu: i, ram: i, sampled_at_ms: i } })
  await client.waitFor((f) => f.kind === 'ephemeral' && f.host_vitals)
  await new Promise((r) => setTimeout(r, 200))

  // Exactly one reached the client — the first; the rest were dropped silently
  // (no error frame back to the agent either).
  const got = client.frames.filter((f) => f.kind === 'ephemeral' && f.host_vitals)
  assert.equal(got.length, 1)
  assert.deepEqual(got[0].host_vitals, { cpu: 0, ram: 0, sampled_at_ms: 0 })
  assert.equal(agent.frames.some((f) => f.kind === 'control' && f.op === 'error'), false)
  agent.close(); client.close()
})

test('broadcastVitals skips a backed-up (slow) client instead of buffering unbounded', async (t) => {
  // Direct hub-level test: a client whose bufferedAmount exceeds the bound is
  // skipped for the sample (latest-wins telemetry never queues behind a slow
  // reader). Uses fake conns so we can drive bufferedAmount deterministically.
  const { makeHub } = await import('../src/hub.js')
  const hub = makeHub()
  const mkConn = (id, buffered) => {
    const sent = []
    return {
      conn: { userId: 1, deviceId: id, kind: 'client', viewingConvoId: null,
        ws: { readyState: 1, get bufferedAmount() { return buffered }, send: (p) => sent.push(p) } },
      sent,
    }
  }
  const fast = mkConn('fast', 0)
  const slow = mkConn('slow', 2 * 1024 * 1024) // 2 MB backlog — over the 256 KB bound
  hub.register(fast.conn)
  hub.register(slow.conn)

  hub.broadcastVitals(1, { kind: 'ephemeral', host_vitals: VITALS })
  assert.equal(fast.sent.length, 1) // healthy reader gets it
  assert.equal(slow.sent.length, 0) // backed-up reader is skipped, not queued

  // With an explicit high bound the same slow conn is no longer skipped —
  // confirms the skip is driven by the threshold, not some other filter.
  hub.broadcastVitals(1, { kind: 'ephemeral', host_vitals: VITALS }, 4 * 1024 * 1024)
  assert.equal(slow.sent.length, 1)
})
