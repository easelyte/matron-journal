import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, pinDevicePrivate } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { getCoordinatorConvoId, setCoordinatorConvoId, coordinatorFor } from '../src/coordinator.js'
import { startTestServer, makeWsClient } from './helpers.js'

async function seedDb() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const pat = await createUser(db, 'pat', 'pw')
  const agent = createAgent(db, dan.id, 'dev-2')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(db, { id: 'c2', ownerUserId: dan.id, title: 'C2', agentDeviceId: agent.deviceId })
  upsertConversation(db, { id: 'p1', ownerUserId: pat.id, title: 'P1' })
  return { db, dan, pat, agent }
}

test('user_settings exists with the contract columns', () => {
  const db = openDb(':memory:')
  const cols = db.prepare('PRAGMA table_info(user_settings)').all().map((c) => c.name)
  assert.deepEqual(cols, ['user_id', 'coordinator_convo_id', 'updated_at'])
})

test('coordinator setting: unset reads null; set, unchanged, switch and clear report previous/current/changed', async () => {
  const { db, dan } = await seedDb()
  assert.equal(getCoordinatorConvoId(db, dan.id), null)
  assert.deepEqual(setCoordinatorConvoId(db, dan.id, 'c1', 1000), { previous: null, current: 'c1', changed: true })
  assert.equal(getCoordinatorConvoId(db, dan.id), 'c1')
  assert.deepEqual(setCoordinatorConvoId(db, dan.id, 'c1', 2000), { previous: 'c1', current: 'c1', changed: false })
  assert.equal(db.prepare('SELECT updated_at FROM user_settings WHERE user_id=?').get(dan.id).updated_at, 1000, 'an unchanged write touches nothing')
  assert.deepEqual(setCoordinatorConvoId(db, dan.id, 'c2', 3000), { previous: 'c1', current: 'c2', changed: true })
  assert.deepEqual(setCoordinatorConvoId(db, dan.id, null, 4000), { previous: 'c2', current: null, changed: true })
  assert.equal(getCoordinatorConvoId(db, dan.id), null)
  assert.deepEqual(setCoordinatorConvoId(db, dan.id, null, 5000), { previous: null, current: null, changed: false })
})

test('coordinator setting: a conversation the user does not own is no_convo and writes nothing', async () => {
  const { db, dan } = await seedDb()
  assert.throws(() => setCoordinatorConvoId(db, dan.id, 'p1'), /no_convo/)
  assert.throws(() => setCoordinatorConvoId(db, dan.id, 'nope'), /no_convo/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_settings').get().n, 0)
})

test('coordinatorFor hides a private-owned coordinator from a filtered caller only', async () => {
  const { db, dan } = await seedDb()
  const priv = createAgent(db, dan.id, 'secret-box')
  pinDevicePrivate(db, priv.deviceId, true)
  upsertConversation(db, { id: 's1', ownerUserId: dan.id, title: 'S1', agentDeviceId: priv.deviceId })
  setCoordinatorConvoId(db, dan.id, 's1')
  assert.equal(coordinatorFor(db, dan.id), 's1')
  assert.equal(coordinatorFor(db, dan.id, { excludePrivateOwned: true }), null)
  setCoordinatorConvoId(db, dan.id, 'c1')
  assert.equal(coordinatorFor(db, dan.id, { excludePrivateOwned: true }), 'c1')
})

async function fleet(t) {
  const s = await startTestServer({})
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'c2', ownerUserId: dan.id, title: 'C2', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'p1', ownerUserId: pat.id, title: 'P1' })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  return { s, dan, agent, client: login.json.token }
}
const put = (s, token, convoId) => s.http('/coordinator', { method: 'PUT', token, body: { convo_id: convoId } })
const roleEvents = (s) => s.db.prepare("SELECT convo_id, sender, payload FROM events WHERE type='coordinator' ORDER BY seq").all()
  .map((e) => ({ convo_id: e.convo_id, sender: e.sender, role: JSON.parse(e.payload).role }))

test('GET/PUT /coordinator gates: both kinds read; agent PUT 403; foreign/unknown 404; junk 400; nothing written', async (t) => {
  const { s, agent, client } = await fleet(t)
  assert.deepEqual((await s.http('/coordinator', { token: client })).json, { convo_id: null })
  const asAgentGet = await s.http('/coordinator', { token: agent.token })
  assert.equal(asAgentGet.status, 200); assert.deepEqual(asAgentGet.json, { convo_id: null })
  assert.equal((await s.http('/coordinator')).status, 401)
  const asAgent = await put(s, agent.token, 'c1')
  assert.equal(asAgent.status, 403); assert.deepEqual(asAgent.json, { error: 'forbidden' })
  assert.equal((await put(s, client, 'p1')).status, 404, "another user's conversation is not_found")
  assert.equal((await put(s, client, 'nope')).status, 404)
  assert.equal((await s.http('/coordinator', { method: 'PUT', token: client, body: {} })).status, 400)
  assert.equal((await put(s, client, 42)).status, 400)
  assert.equal((await put(s, client, '')).status, 400)
  assert.equal((await put(s, client, 'x'.repeat(10_000))).status, 400)
  assert.deepEqual(roleEvents(s), [])
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM user_settings').get().n, 0)
})

test('PUT /coordinator: assign emits assigned live to the owning bridge; unchanged emits nothing; switch releases then assigns; clear emits released only', async (t) => {
  const { s, agent, client } = await fleet(t)
  const bridge = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await bridge.waitFor((f) => f.op === 'hello_ok')
  let r = await put(s, client, 'c1')
  assert.equal(r.status, 200); assert.deepEqual(r.json, { convo_id: 'c1' })
  const live = await bridge.waitFor((f) => f.kind === 'journal' && f.type === 'coordinator')
  assert.equal(live.convo_id, 'c1'); assert.deepEqual(live.payload, { role: 'assigned' }); assert.equal(live.sender, 'user:dan')
  bridge.close()
  assert.deepEqual(roleEvents(s), [{ convo_id: 'c1', sender: 'user:dan', role: 'assigned' }])

  r = await put(s, client, 'c1')
  assert.equal(r.status, 200); assert.deepEqual(r.json, { convo_id: 'c1' })
  assert.equal(roleEvents(s).length, 1, 'an unchanged PUT emits no events')

  r = await put(s, client, 'c2')
  assert.deepEqual(r.json, { convo_id: 'c2' })
  assert.deepEqual(roleEvents(s).slice(1), [
    { convo_id: 'c1', sender: 'user:dan', role: 'released' },
    { convo_id: 'c2', sender: 'user:dan', role: 'assigned' },
  ])

  r = await put(s, client, null)
  assert.equal(r.status, 200); assert.deepEqual(r.json, { convo_id: null })
  assert.deepEqual(roleEvents(s).slice(3), [{ convo_id: 'c2', sender: 'user:dan', role: 'released' }], 'clearing emits released only')
  await put(s, client, null)
  assert.equal(roleEvents(s).length, 4, 'clearing twice emits nothing the second time')
  assert.deepEqual((await s.http('/coordinator', { token: agent.token })).json, { convo_id: null })
})

test('a coordinator event cannot be forged through an agent publish', async (t) => {
  const { s, agent } = await fleet(t)
  const bridge = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await bridge.waitFor((f) => f.op === 'hello_ok')
  t.after(() => bridge.close())
  bridge.send({ op: 'publish', convo_id: 'c1', type: 'coordinator', payload: { role: 'assigned' } })
  const err = await bridge.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'bad_request')
  assert.deepEqual(roleEvents(s), [])
})

test('GET /coordinator hides a private-owned coordinator from an ordinary agent, not from a private one', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const priv = createAgent(s.db, dan.id, 'secret-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 's1', ownerUserId: dan.id, title: 'S1', agentDeviceId: priv.deviceId })
  assert.equal((await put(s, client, 's1')).status, 200)
  assert.deepEqual((await s.http('/coordinator', { token: client })).json, { convo_id: 's1' })
  assert.deepEqual((await s.http('/coordinator', { token: priv.token })).json, { convo_id: 's1' })
  assert.deepEqual((await s.http('/coordinator', { token: agent.token })).json, { convo_id: null })
})

const helloOf = async (s, token) => {
  const c = await makeWsClient(s.base, { token, cursor: null })
  const hello = await c.waitFor((f) => f.op === 'hello_ok')
  c.close()
  return hello
}

test('hello_ok and /snapshot carry coordinator_convo_id: null until set, then the id; sieved for an ordinary agent', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  assert.equal((await helloOf(s, client)).coordinator_convo_id, null)
  const snap0 = (await s.http('/snapshot', { token: client })).json
  assert.ok('coordinator_convo_id' in snap0); assert.equal(snap0.coordinator_convo_id, null)
  await put(s, client, 'c1')
  assert.equal((await helloOf(s, client)).coordinator_convo_id, 'c1')
  assert.equal((await helloOf(s, agent.token)).coordinator_convo_id, 'c1')
  assert.equal((await s.http('/snapshot', { token: client })).json.coordinator_convo_id, 'c1')

  const priv = createAgent(s.db, dan.id, 'secret-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 's1', ownerUserId: dan.id, title: 'S1', agentDeviceId: priv.deviceId })
  await put(s, client, 's1')
  assert.equal((await helloOf(s, agent.token)).coordinator_convo_id, null)
  assert.equal((await s.http('/snapshot', { token: agent.token })).json.coordinator_convo_id, null)
  assert.equal((await helloOf(s, priv.token)).coordinator_convo_id, 's1')
  assert.equal((await helloOf(s, client)).coordinator_convo_id, 's1')
})

// CodeRabbit (PR #230-era finding on coordinator-http.js): the setting write
// and the released/assigned events must commit as one transaction. Before
// the fix, emitRole ran the event append AFTER the setting had already
// committed, so a failing assigned append left the setting switched with no
// assigned row — a repeat PUT of the same value is then setCoordinatorConvoId's
// own no-op, so the new owning bridge could miss `assigned` permanently.
// Force the SECOND events INSERT (the assigned row, since released is
// appended first) to fail and assert nothing survives: not the setting, not
// the released row, not the assigned row — and the response is an error.
test('PUT /coordinator: a failing assigned append during a switch rolls back the setting and the released row too', async (t) => {
  const { s, dan, client } = await fleet(t)
  const first = await put(s, client, 'c1')
  assert.equal(first.status, 200)
  assert.equal(roleEvents(s).length, 1, 'sanity: c1 assigned recorded')

  const realPrepare = s.db.prepare.bind(s.db)
  const EVENT_INSERT = 'INSERT INTO events(user_id, seq, convo_id, ts, sender, type, payload, blob_ref, idem_key) VALUES(?,?,?,?,?,?,?,?,?)'
  let inserts = 0
  s.db.prepare = (sql) => (sql === EVENT_INSERT
    ? { run: (...args) => { inserts += 1; if (inserts === 1) return realPrepare(sql).run(...args); throw new Error('disk on fire') } }
    : realPrepare(sql))
  const mute = t.mock.method(console, 'error', () => {}) // the catch is expected to log; keep test output clean
  let r
  try { r = await put(s, client, 'c2') } finally { s.db.prepare = realPrepare }
  assert.ok(r.status >= 500, `expected an error status, got ${r.status}`)
  assert.equal(getCoordinatorConvoId(s.db, dan.id), 'c1', 'the switch never committed — setting stays at c1')
  assert.deepEqual(roleEvents(s), [{ convo_id: 'c1', sender: 'user:dan', role: 'assigned' }], 'no released row for c1, no assigned row for c2')
  void mute

  // Next attempt, with the disk back, still works (nothing was wedged).
  const recovered = await put(s, client, 'c2')
  assert.equal(recovered.status, 200)
  assert.deepEqual(recovered.json, { convo_id: 'c2' })
})
