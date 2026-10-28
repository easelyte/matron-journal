import test from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { startTestServer } from './helpers.js'
import { createUser, createAgent, revokeDevice } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { pinDevicePrivate, unpinDevicePrivate, isPrivateDevice } from '../src/db.js'
import { fleet, parkSpawn, pending, answer, settle } from './consent-fleet.js'

// The private-device tier: only the box's first hello (or the operator) can
// make it private, and the surfaces below keep a private box out of an
// ordinary agent's sight — box defaults, the Coordinator's consent list and
// answers — while the Coordinator conversation itself cannot change hands.

// A socket whose hello carries an explicit private field (makeWsClient only
// sends token+cursor). Resolves once hello_ok arrives.
function hello(base, token, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
    const frames = []
    ws.on('message', (d) => {
      const f = JSON.parse(d)
      frames.push(f)
      if (f.op === 'hello_ok') resolve({
        ws, frames,
        send: (obj) => ws.send(JSON.stringify(obj)),
        waitFor(pred, ms = 2000) {
          return new Promise((res, rej) => {
            const t0 = Date.now()
            const iv = setInterval(() => {
              const hit = frames.find(pred)
              if (hit) { clearInterval(iv); res(hit) } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('waitFor timeout')) }
            }, 10)
          })
        },
      })
    })
    ws.on('error', reject)
    ws.on('open', () => ws.send(JSON.stringify({ op: 'hello', token, ...extra })))
  })
}
const reconnect = async (s, token, extra) => { const c = await hello(s.base, token, extra); c.ws.close(); await settle(50) }

async function oneBox(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  return { s, alice, box: createAgent(s.db, alice.id, 'box-a') }
}

test('hello: a box that first came up ordinary cannot make itself private later', async (t) => {
  const { s, box } = await oneBox(t)
  await reconnect(s, box.token)
  await reconnect(s, box.token, { private: true })
  assert.equal(isPrivateDevice(s.db, box.deviceId), false)
})

test('hello: the first hello decides; a private box may lower its flag and raise it again', async (t) => {
  const { s, box } = await oneBox(t)
  await reconnect(s, box.token, { private: true })
  assert.equal(isPrivateDevice(s.db, box.deviceId), true)
  await reconnect(s, box.token)
  assert.equal(isPrivateDevice(s.db, box.deviceId), false)
  await reconnect(s, box.token, { private: true })
  assert.equal(isPrivateDevice(s.db, box.deviceId), true)
})

test('hello: the operator pin sets whether the bridge may raise the flag after auto', async (t) => {
  const { s, box } = await oneBox(t)
  await reconnect(s, box.token)
  pinDevicePrivate(s.db, box.deviceId, true)
  unpinDevicePrivate(s.db, box.deviceId)
  await reconnect(s, box.token)
  await reconnect(s, box.token, { private: true })
  assert.equal(isPrivateDevice(s.db, box.deviceId), true, 'pinned on, then auto: eligible')
  pinDevicePrivate(s.db, box.deviceId, false)
  unpinDevicePrivate(s.db, box.deviceId)
  await reconnect(s, box.token, { private: true })
  assert.equal(isPrivateDevice(s.db, box.deviceId), false, 'pinned off, then auto: not eligible')
})

test('box defaults: an ordinary agent gets 404 for a private box; the app and a private agent do not', async (t) => {
  const { s, alice, box } = await oneBox(t)
  const priv = createAgent(s.db, alice.id, 'box-b')
  const priv2 = createAgent(s.db, alice.id, 'box-c')
  pinDevicePrivate(s.db, priv.deviceId, true)
  pinDevicePrivate(s.db, priv2.deviceId, true)
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  const path = `/devices/${priv.deviceId}/defaults`
  assert.equal((await s.http(path, { token: box.token })).status, 404)
  assert.equal((await s.http(path, { method: 'PUT', token: box.token, body: { default_agent: 'codex' } })).status, 404)
  assert.equal(s.db.prepare('SELECT default_agent FROM devices WHERE id=?').get(priv.deviceId).default_agent, null, 'nothing written')
  assert.equal((await s.http(path, { token: login.json.token })).status, 200)
  assert.equal((await s.http(path, { token: priv2.token })).status, 200)
})

// A private box in the consent fleet, with a session of its own to ask from.
async function withPrivateAsker(t) {
  const f = await fleet(t)
  const privDev = createAgent(f.s.db, f.alice.id, 'box-p')
  upsertConversation(f.s.db, { id: 'priv-ask', ownerUserId: f.alice.id, title: 'Private work', agentDeviceId: privDev.deviceId })
  const priv = await hello(f.s.base, privDev.token, { private: true })
  t.after(() => { try { priv.ws.close() } catch { /* closed */ } })
  assert.equal(isPrivateDevice(f.s.db, privDev.deviceId), true)
  return { ...f, privDev, priv }
}

test('consent: an ordinary Coordinator neither lists nor is nudged about a private box\'s ask', async (t) => {
  const f = await withPrivateAsker(t)
  const id = await parkSpawn(f, { rid: 'p1', from: 'priv-ask', ws: f.priv })
  await settle()
  assert.ok(!f.coord.frames.some((x) => x.kind === 'consent' && x.event === 'pending'), 'no nudge')
  const r = await pending(f, f.coordDev.token)
  assert.equal(r.status, 200)
  assert.ok(!r.json.pending.some((a) => a.id === id))
  const ordinary = await parkSpawn(f, { rid: 'o1' })
  assert.ok((await pending(f, f.coordDev.token)).json.pending.some((a) => a.id === ordinary), 'other asks still listed')
})

test('consent: an ordinary Coordinator answering a private box\'s ask gets 404 and the ask stands', async (t) => {
  const f = await withPrivateAsker(t)
  const id = await parkSpawn(f, { rid: 'p2', from: 'priv-ask', ws: f.priv })
  for (const decision of ['approve', 'decline']) {
    const r = await answer(f, f.coordDev.token, { kind: 'spawn', id, decision, reason: 'tidy' })
    assert.equal(r.status, 404, decision)
  }
  assert.equal(f.s.db.prepare('SELECT state FROM agent_spawn_requests WHERE id=?').get(id).state, 'awaiting_user')
})

test('convo_upsert: no other device can take over the Coordinator conversation while its owner exists', async (t) => {
  const f = await fleet(t)
  f.asker.send({ op: 'convo_upsert', convo_id: 'coord', title: 'mine now', session_state: 'running' })
  const err = await f.asker.waitFor((x) => x.op === 'error' && x.ref === 'convo_upsert')
  assert.equal(err.code, 'forbidden')
  assert.equal(f.s.db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get('coord').agent_device_id, f.coordDev.deviceId)
  assert.equal((await pending(f, f.askerDev.token)).status, 404, 'still not the Coordinator')
  f.coord.close()
  revokeDevice(f.s.db, f.coordDev.deviceId)
  f.asker.frames.length = 0
  f.asker.send({ op: 'convo_upsert', convo_id: 'coord', title: 'Coordinator', session_state: 'running' })
  await settle()
  assert.ok(!f.asker.frames.some((x) => x.op === 'error' && x.ref === 'convo_upsert'))
  assert.equal(f.s.db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get('coord').agent_device_id, f.askerDev.deviceId, 'a revoked owner hands it on')
})

test('consent: answering a chat ask that does not exist is the same answer for a private and an ordinary device', async (t) => {
  const f = await withPrivateAsker(t)
  const priv = await answer(f, f.coordDev.token, { kind: 'chat', id: `room/${f.privDev.deviceId}`, decision: 'decline', reason: 'tidy' })
  const ordinary = await answer(f, f.coordDev.token, { kind: 'chat', id: `room/${f.targetDev.deviceId}`, decision: 'decline', reason: 'tidy' })
  assert.equal(priv.status, ordinary.status)
  assert.deepEqual(priv.json, ordinary.json)
})
