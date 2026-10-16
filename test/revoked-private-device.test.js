// A private device's data stays private after the device is revoked.
// Revocation deletes the devices row, but what the box wrote (conversations,
// milestones, items, mission statuses, project origins) outlives it, and
// every read-time sieve asks whether the writing device is private. The
// tombstone (db.js, private_devices) keeps that answer "yes".
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { openDb, isPrivateDevice, pinDevicePrivate } from '../src/db.js'
import { createUser, createAgent, revokeDevice, revokeOwnedDevice } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'

test('revoking a private device leaves a tombstone: isPrivateDevice stays true; a public device leaves none', async () => {
  const db = openDb(':memory:')
  const u = await createUser(db, 'alice', 'pw')
  const priv = createAgent(db, u.id, 'private-box')
  const pub = createAgent(db, u.id, 'box-a')
  pinDevicePrivate(db, priv.deviceId, true)
  revokeOwnedDevice(db, u.id, priv.deviceId)
  revokeDevice(db, pub.deviceId)
  assert.equal(db.prepare('SELECT 1 FROM devices WHERE id=?').get(priv.deviceId), undefined)
  assert.equal(isPrivateDevice(db, priv.deviceId), true, 'a revoked private device is still private')
  assert.equal(isPrivateDevice(db, pub.deviceId), false, 'a revoked public device is not')
  assert.deepEqual(db.prepare('SELECT id, user_id FROM revoked_private_devices').all(), [{ id: priv.deviceId, user_id: u.id }])
  db.close()
})

test('a revoked private device\'s id is never handed to a new device', async () => {
  const db = openDb(':memory:')
  const u = await createUser(db, 'alice', 'pw')
  const priv = createAgent(db, u.id, 'private-box')
  pinDevicePrivate(db, priv.deviceId, true)
  // The highest id: SQLite's own rowid choice would hand it straight back.
  revokeDevice(db, priv.deviceId)
  const next = createAgent(db, u.id, 'box-a')
  assert.ok(next.deviceId > priv.deviceId, 'issueDevice allocates above the tombstone')
  assert.equal(isPrivateDevice(db, next.deviceId), false)
  // Any other insert path is refused outright.
  assert.throws(() => db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(?,?,'agent','x','h-x',0)").run(priv.deviceId, u.id),
    /revoked private device/)
  db.close()
})

test('the tombstone table, triggers and view are created idempotently on reopen', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'tomb-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'j.db')
  let db = openDb(file)
  const u = await createUser(db, 'alice', 'pw')
  const priv = createAgent(db, u.id, 'private-box')
  pinDevicePrivate(db, priv.deviceId, true)
  revokeDevice(db, priv.deviceId)
  db.close()
  db = openDb(file)
  assert.equal(isPrivateDevice(db, priv.deviceId), true)
  db.close()
})

async function fleet(t) {
  const s = await startTestServer({})
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const agent = createAgent(s.db, alice.id, 'box-a')
  const priv = createAgent(s.db, alice.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'secret', ownerUserId: alice.id, title: 'Secret plan', agentDeviceId: priv.deviceId })
  upsertConversation(s.db, { id: 'secret2', ownerUserId: alice.id, title: 'Secret two', agentDeviceId: priv.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  return { s, alice, agent, priv, client: login.json.token }
}

test('after a private box is revoked, an ordinary agent still cannot read its missions, milestones, items, conversation titles or mission status', async (t) => {
  const { s, alice, agent, priv, client } = await fleet(t)
  const http = (path, token, opts = {}) => s.http(path, { token, ...opts })
  // What the private box writes while it is live.
  const hidden = (await http('/missions', priv.token, { method: 'POST', body: { title: 'Hidden mission', convo_id: 'secret' } })).json.mission
  assert.equal((await http('/milestones', priv.token, { method: 'POST', body: { convo_id: 'secret', kind: 'progress', title: 'private step' } })).status, 201)
  const secretItem = (await http('/items', priv.token, { method: 'POST', body: { kind: 'question', title: 'Private question?', convo_id: 'secret' } })).json.item
  // A public mission the private box joined, posted on and wrote the status of.
  const pub = (await http('/missions', agent.token, { method: 'POST', body: { title: 'Public mission', convo_id: 'c1' } })).json.mission
  assert.equal((await http(`/missions/${pub.id}/join`, priv.token, { method: 'POST', body: { convo_id: 'secret2' } })).status, 200)
  assert.equal((await http('/milestones', priv.token, { method: 'POST', body: { convo_id: 'secret2', kind: 'progress', title: 'private step on public' } })).status, 201)
  assert.equal((await http(`/missions/${pub.id}`, priv.token, { method: 'PATCH', body: { status: 'Private status', convo_id: 'secret2' } })).status, 200)

  const assertHidden = async (when) => {
    assert.equal((await http(`/missions/${hidden.id}`, agent.token)).status, 404, `${when}: private-origin mission`)
    assert.deepEqual((await http('/missions', agent.token)).json.missions.map((m) => m.id), [pub.id], `${when}: mission list`)
    assert.equal((await http('/milestones?convo=secret', agent.token)).status, 404, `${when}: milestones of a private conversation`)
    const pubAsAgent = (await http(`/missions/${pub.id}`, agent.token)).json
    assert.deepEqual(pubAsAgent.milestones.map((l) => l.title), [], `${when}: milestones from the private box`)
    assert.equal(pubAsAgent.mission.milestones, 0, `${when}: milestone count`)
    assert.equal(pubAsAgent.mission.last_milestone, null, `${when}: last milestone`)
    assert.equal(pubAsAgent.mission.status, null, `${when}: mission status written by the private box`)
    assert.deepEqual(pubAsAgent.conversations.map((c) => c.id), ['c1'], `${when}: mission conversations`)
    assert.equal((await http(`/items/${secretItem.id}`, agent.token)).status, 404, `${when}: private item`)
    assert.equal((await http('/items', agent.token)).json.items.some((i) => i.id === secretItem.id), false, `${when}: item list`)
    const roster = (await http('/roster', agent.token)).json
    const ids = roster.conversations.map((c) => c.id)
    assert.ok(!ids.includes('secret') && !ids.includes('secret2'), `${when}: roster conversations`)
    assert.ok(!JSON.stringify(roster).includes('Secret plan'), `${when}: no private title anywhere on the roster`)
    const snap = (await http('/snapshot', agent.token)).json
    assert.ok(!JSON.stringify(snap).includes('Secret plan'), `${when}: no private title in the snapshot`)
  }
  await assertHidden('while live')

  assert.equal((await http(`/devices/${priv.deviceId}/revoke`, client, { method: 'POST' })).status, 200)
  assert.equal(s.db.prepare('SELECT 1 FROM devices WHERE id=?').get(priv.deviceId), undefined)
  await assertHidden('after revoke')

  // The user still sees everything.
  assert.equal((await http(`/missions/${hidden.id}`, client)).status, 200)
  assert.equal((await http(`/missions/${pub.id}`, client)).json.mission.status, 'Private status')
  assert.equal((await http(`/items/${secretItem.id}`, client)).status, 200)

  // A public conversation the user joins to the private-origin mission
  // after the revoke is not renamed after it.
  upsertConversation(s.db, { id: 'c2', ownerUserId: alice.id, title: '[ab] Public work', agentDeviceId: agent.deviceId })
  assert.equal((await http(`/missions/${hidden.id}/join`, client, { method: 'POST', body: { convo_id: 'c2' } })).status, 200)
  const c2 = s.db.prepare('SELECT title FROM conversations WHERE id=?').get('c2')
  assert.ok(!c2.title.includes('Hidden mission'), `public title must not carry the private mission's title: ${c2.title}`)
  // Nor may an ordinary agent read around a message in it, or take it over.
  assert.equal((await http('/convo/secret/messages?around_seq=1', agent.token)).status, 404)
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  t.after(() => ws.close())
  await ws.waitFor((f) => f.op === 'hello_ok')
  ws.send({ op: 'convo_upsert', convo_id: 'secret', title: 'stolen', session_state: 'running' })
  assert.equal((await ws.waitFor((f) => f.op === 'error' && f.ref === 'convo_upsert')).code, 'forbidden')
  assert.equal(s.db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get('secret').agent_device_id, priv.deviceId)
})
