import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-metrics-'))
  return path.join(dir, 'test.db')
}

test('GET /metrics requires a bearer token', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const r = await s.http('/metrics', {})
  assert.equal(r.status, 401)
})

test('GET /metrics: shape, and any valid device (client or agent) can call it', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })

  const r = await s.http('/metrics', { token: login.json.token })
  assert.equal(r.status, 200)
  assert.equal(typeof r.json.user.head_seq, 'number')
  assert.ok(Array.isArray(r.json.user.devices))
  assert.equal(typeof r.json.sockets_connected, 'number')
  assert.equal(typeof r.json.journal_row_count, 'number')
  assert.equal(typeof r.json.db_file_size_bytes, 'number')
  assert.deepEqual(Object.keys(r.json.push).sort(), ['by_reason', 'failed', 'pruned', 'sent'])

  const dev = r.json.user.devices.find((d) => d.device_id === login.json.device_id)
  assert.ok(dev, 'caller device missing from user.devices')
  assert.equal(dev.kind, 'client')
  assert.equal(dev.cursor, 0)
  assert.equal(dev.lag, r.json.user.head_seq)

  const ag = createAgent(s.db, dan.id, 'bridge')
  const ar = await s.http('/metrics', { token: ag.token })
  assert.equal(ar.status, 200)
})

test('GET /metrics numbers move after publish and ack', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const before = await s.http('/metrics', { token: login.json.token })
  assert.equal(before.json.user.head_seq, 0)
  assert.equal(before.json.journal_row_count, 0)

  const r = append(s.db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi' } })

  const after = await s.http('/metrics', { token: login.json.token })
  assert.equal(after.json.user.head_seq, r.seq)
  assert.equal(after.json.journal_row_count, 1)
  const devBefore = after.json.user.devices.find((d) => d.device_id === login.json.device_id)
  assert.equal(devBefore.cursor, 0)
  assert.equal(devBefore.lag, r.seq)

  const c = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await c.waitFor((f) => f.kind === 'journal' && f.seq === r.seq)
  c.send({ op: 'ack', cursor: r.seq })
  await new Promise((res) => setTimeout(res, 100))
  c.close()

  const afterAck = await s.http('/metrics', { token: login.json.token })
  const devAfter = afterAck.json.user.devices.find((d) => d.device_id === login.json.device_id)
  assert.equal(devAfter.cursor, r.seq)
  assert.equal(devAfter.lag, 0)
})

test('GET /metrics: per-user section is scoped to the caller only — no other user\'s device ids/names leak', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw2')
  const danLogin = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'dans-mac' } })
  const patLogin = await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'pw2', device_name: 'pats-phone' } })

  const r = await s.http('/metrics', { token: danLogin.json.token })
  assert.equal(r.status, 200)
  const deviceIds = r.json.user.devices.map((d) => d.device_id)
  assert.ok(deviceIds.includes(danLogin.json.device_id))
  assert.ok(!deviceIds.includes(patLogin.json.device_id), 'another user\'s device_id leaked into the caller\'s metrics')
  // no field anywhere should carry another user's username or device name
  const serialized = JSON.stringify(r.json)
  assert.ok(!serialized.includes('pat'), 'another user\'s username/device name leaked into /metrics')
  assert.ok(!serialized.includes('pats-phone'), 'another user\'s device name leaked into /metrics')
})

test('GET /metrics: global aggregates (sockets_connected, journal_row_count) reflect activity across all users', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw2')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id })
  upsertConversation(s.db, { id: 'c2', ownerUserId: pat.id })
  append(s.db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'from dan' } })
  append(s.db, { userId: pat.id, convoId: 'c2', sender: 'agent:a', type: 'text', payload: { body: 'from pat' } })

  const danLogin = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const patLogin = await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'pw2', device_name: 'phone' } })
  const c1 = await makeWsClient(s.base, { token: danLogin.json.token, cursor: 0 })
  const c2 = await makeWsClient(s.base, { token: patLogin.json.token, cursor: 0 })
  await c1.waitFor((f) => f.op === 'hello_ok')
  await c2.waitFor((f) => f.op === 'hello_ok')

  const r = await s.http('/metrics', { token: danLogin.json.token })
  assert.equal(r.json.journal_row_count, 2)
  assert.ok(r.json.sockets_connected >= 2, `expected at least 2 connected sockets, got ${r.json.sockets_connected}`)
  c1.close(); c2.close()
})

test('GET /metrics: db_file_size_bytes reflects a real db file (non-zero) and push counters are always present, even with push disabled', async (t) => {
  const dbPath = tmpDbPath()
  const s = await startTestServer({ dbPath })
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'pw')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const r = await s.http('/metrics', { token: login.json.token })
  assert.ok(r.json.db_file_size_bytes > 0)
  assert.deepEqual(r.json.push, { sent: 0, failed: 0, pruned: 0, by_reason: {} })
})
