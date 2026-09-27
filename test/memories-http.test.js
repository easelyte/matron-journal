import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { pinDevicePrivate } from '../src/db.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'

async function fleet(t) {
  const calls = []
  const waker = { enabled: true, wake: (name) => calls.push(name) }
  const s = await startTestServer({ waker })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  const priv = createAgent(s.db, dan.id, 'priv-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  const patAgent = createAgent(s.db, pat.id, 'pat-box')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'coord', ownerUserId: dan.id, title: 'Coordinator', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'pc', ownerUserId: dan.id, title: 'Private', agentDeviceId: priv.deviceId })
  upsertConversation(s.db, { id: 'p1', ownerUserId: pat.id, title: 'P1', agentDeviceId: patAgent.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  return { s, dan, pat, agent, priv, patAgent, client: login.json.token, wakeCalls: calls }
}
const put = (s, token, name, body) => s.http(`/memories/${encodeURIComponent(name)}`, { method: 'PUT', token, body: { description: 'Never use eric.', ...body } })
const markers = (s) => s.db.prepare("SELECT convo_id, sender, payload FROM events WHERE type='memory' ORDER BY seq").all().map((r) => ({ ...r, payload: JSON.parse(r.payload) }))

test('PUT /memories/:name: agent creates (201) then updates (200); marker on the writer convo; 400s on junk', async (t) => {
  const { s, agent, client } = await fleet(t)
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await put(s, agent.token, 'avoid-eric', { body: '**Why:** reserved.', type: 'feedback', convo_id: 'c1' })
  assert.equal(r.status, 201)
  assert.equal(r.json.memory.name, 'avoid-eric'); assert.equal(r.json.memory.created_by, 'agent'); assert.equal(r.json.memory.origin_convo_id, 'c1')
  const live = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'memory')
  assert.equal(live.convo_id, 'c1'); assert.equal(live.sender, 'agent:dev-2')
  assert.deepEqual(live.payload, { memory_id: r.json.memory.id, name: 'avoid-eric', type: 'feedback', description: 'Never use eric.', action: 'saved', created: true, by: 'agent' })
  ws.close()
  const u = await put(s, agent.token, 'avoid-eric', { description: 'Eric is reserved.', convo_id: 'c1' })
  assert.equal(u.status, 200); assert.equal(u.json.memory.id, r.json.memory.id); assert.equal(u.json.memory.body, ''); assert.equal(u.json.memory.type, 'feedback')
  assert.equal(markers(s).length, 2); assert.equal(markers(s)[1].payload.created, false)
  for (const [name, body] of [['Bad Name', {}], ['ok', { description: '' }], ['ok', { description: 'a\nb' }], ['ok', { type: 'rule' }], ['ok', { body: 'é'.repeat(4097) }], ['ok', { convo_id: 42 }]]) {
    assert.equal((await put(s, agent.token, name, body)).status, 400, `${name} ${JSON.stringify(body)}`)
  }
  assert.equal((await s.http('/memories/ok', { method: 'PUT', token: agent.token, body: [] })).status, 400)
  assert.equal((await put(s, agent.token, 'ok', { convo_id: 'p1' })).status, 404) // not ours
  assert.equal((await put(s, agent.token, 'ok', { convo_id: 'pc' })).status, 404) // private-owned, filtered agent
  assert.equal((await put(s, agent.token, 'ok', { convo_id: 'nope' })).status, 404)
  assert.equal((await put(s, client, 'ok', { convo_id: 'c1' })).status, 400) // clients never send convo_id
  const noAuth = await s.http('/memories/ok', { method: 'PUT', body: { description: 'x' } })
  assert.equal(noAuth.status, 401)
  assert.equal(markers(s).length, 2)
})

test('PUT by a client: no convo_id, created_by user, marker only on the Coordinator convo when one is set', async (t) => {
  const { s, dan, client, wakeCalls } = await fleet(t)
  const r0 = await put(s, client, 'no-coordinator', {})
  assert.equal(r0.status, 201); assert.equal(r0.json.memory.created_by, 'user'); assert.equal(r0.json.memory.origin_convo_id, null)
  assert.deepEqual(markers(s), [])
  setCoordinatorConvoId(s.db, dan.id, 'coord')
  const r = await put(s, client, 'with-coordinator', {})
  assert.equal(r.status, 201)
  const m = markers(s)
  assert.equal(m.length, 1); assert.equal(m[0].convo_id, 'coord'); assert.equal(m[0].sender, 'user:dan'); assert.equal(m[0].payload.by, 'user')
  assert.deepEqual(wakeCalls, []) // never wakes
})

test('marker lands on the writer convo AND the Coordinator convo, once each; once only when they coincide', async (t) => {
  const { s, dan, agent } = await fleet(t)
  setCoordinatorConvoId(s.db, dan.id, 'coord')
  await put(s, agent.token, 'two', { convo_id: 'c1' })
  assert.deepEqual(markers(s).map((m) => m.convo_id), ['c1', 'coord'])
  await put(s, agent.token, 'one', { convo_id: 'coord' })
  assert.deepEqual(markers(s).map((m) => m.convo_id), ['c1', 'coord', 'coord'])
})

test('GET /memories and /memories/:key; 409 too_many at the cap', async (t) => {
  const { s, agent, client } = await fleet(t)
  await put(s, agent.token, 'b-two', { convo_id: 'c1' }); await put(s, client, 'a-one', {})
  const list = await s.http('/memories', { token: client })
  assert.equal(list.status, 200); assert.deepEqual(list.json.memories.map((m) => m.name), ['a-one', 'b-two'])
  const byName = await s.http('/memories/a-one', { token: agent.token })
  assert.equal(byName.status, 200); assert.equal(byName.json.memory.name, 'a-one')
  const byId = await s.http(`/memories/${byName.json.memory.id}`, { token: client })
  assert.equal(byId.status, 200)
  assert.equal((await s.http('/memories/nope', { token: client })).status, 404)
  assert.equal((await s.http('/memories/Bad%20Name', { token: client })).status, 400)
  assert.equal((await s.http('/memories', { method: 'POST', token: client, body: {} })).status, 404)
  for (let i = 0; i < 198; i++) assert.equal((await put(s, client, `m-${i}`, {})).status, 201)
  const over = await put(s, client, 'one-more', {})
  assert.equal(over.status, 409); assert.equal(over.json.error, 'too_many')
  assert.equal((await put(s, client, 'a-one', { description: 'still fine' })).status, 200)
})

test('DELETE /memories/:key: 200 with the row, marker deleted to origin + Coordinator, then 404', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  setCoordinatorConvoId(s.db, dan.id, 'coord')
  const r = await put(s, agent.token, 'gone', { convo_id: 'c1' })
  const d = await s.http('/memories/gone', { method: 'DELETE', token: client })
  assert.equal(d.status, 200); assert.equal(d.json.memory.id, r.json.memory.id)
  const m = markers(s).slice(2)
  assert.deepEqual(m.map((x) => x.convo_id), ['c1', 'coord'])
  assert.equal(m[0].payload.action, 'deleted'); assert.equal(m[0].payload.by, 'user'); assert.equal(m[0].payload.created, false)
  assert.equal((await s.http('/memories/gone', { method: 'DELETE', token: client })).status, 404)
  assert.equal((await s.http('/memories', { token: client })).json.memories.length, 0)
})

test('privacy: a filtered agent cannot see, update or delete a private-origin memory; clients and private agents can', async (t) => {
  const { s, dan, agent, priv, client } = await fleet(t)
  setCoordinatorConvoId(s.db, dan.id, 'coord')
  const r = await put(s, priv.token, 'secret', { convo_id: 'pc', body: 'hush' })
  assert.equal(r.status, 201)
  // Marker into the public Coordinator convo carries the id only.
  const coordMarker = markers(s).find((m) => m.convo_id === 'coord')
  assert.deepEqual(coordMarker.payload, { memory_id: r.json.memory.id, action: 'saved', created: true, by: 'agent' })
  assert.equal(markers(s).find((m) => m.convo_id === 'pc').payload.name, 'secret')
  assert.deepEqual((await s.http('/memories', { token: agent.token })).json.memories, [])
  assert.equal((await s.http('/memories/secret', { token: agent.token })).status, 404)
  assert.equal((await put(s, agent.token, 'secret', { convo_id: 'c1' })).status, 404)
  assert.equal((await s.http('/memories/secret', { method: 'DELETE', token: agent.token })).status, 404)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 1)
  assert.equal((await s.http('/memories/secret', { token: client })).json.memory.body, 'hush')
  assert.equal((await s.http('/memories/secret', { token: priv.token })).status, 200)
  assert.equal((await put(s, client, 'secret', { description: 'edited by dan' })).status, 200)
})

test('a memory is per user: pat cannot read dan\'s', async (t) => {
  const { s, client, patAgent } = await fleet(t)
  await put(s, client, 'mine', {})
  assert.equal((await s.http('/memories/mine', { token: patAgent.token })).status, 404)
  assert.deepEqual((await s.http('/memories', { token: patAgent.token })).json.memories, [])
})

test('marker append failure (origin convo gone) does not fail the write', async (t) => {
  const { s, agent, client } = await fleet(t)
  await put(s, agent.token, 'orphan', { convo_id: 'c1' })
  s.db.prepare("DELETE FROM events WHERE convo_id='c1'").run()
  s.db.prepare("DELETE FROM conversations WHERE id='c1'").run()
  const r = await put(s, client, 'orphan', { description: 'edited' })
  assert.equal(r.status, 200); assert.equal(r.json.memory.description, 'edited')
})

test('memory is not an agent publish type', async (t) => {
  const { s, agent } = await fleet(t)
  const bridge = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await bridge.waitFor((f) => f.op === 'hello_ok')
  bridge.send({ op: 'publish', convo_id: 'c1', type: 'memory', payload: { action: 'saved' } })
  const err = await bridge.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'bad_request')
  bridge.close()
  assert.deepEqual(markers(s), [])
})
