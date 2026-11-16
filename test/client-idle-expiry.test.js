// Client tokens idle out: unused for 30 days (MATRON_CLIENT_IDLE_DAYS), the
// token stops working and the device signs in again; agent tokens never do.
// The row stays, and the account's approval key stays enrolled for the app to
// re-attach after signing in.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgent, authToken } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { resolveClientIdleMs } from '../src/server.js'
import { startApprovalServer, startWithKey, signTap, signAccount, signIn } from './approval-helpers.js'
import { startTestServer, makeWsClient } from './helpers.js'

const DAY = 24 * 60 * 60 * 1000
const age = (s, deviceId, days) => {
  const t = Date.now() - days * DAY
  s.db.prepare('UPDATE devices SET last_seen_at=?, created_at=? WHERE id=?').run(t, t, deviceId)
  return t
}
const seen = (s, id) => s.db.prepare('SELECT last_seen_at FROM devices WHERE id=?').get(id).last_seen_at

test('a client token works at 29 days idle and is refused at 31; the row stays', async (t) => {
  const { s, token, deviceId } = await startApprovalServer(t)
  age(s, deviceId, 29)
  assert.equal((await s.http('/devices', { token })).status, 200)
  age(s, deviceId, 31)
  const r = await s.http('/devices', { token })
  assert.deepEqual([r.status, r.json], [401, { error: 'unauthenticated' }])
  assert.ok(s.db.prepare('SELECT 1 FROM devices WHERE id=?').get(deviceId))
})

test('using a client token at day 29 resets the clock', async (t) => {
  let now = Date.now()
  const { s, token } = await startApprovalServer(t, { clientIdleClock: () => now })
  now += 29 * DAY
  assert.equal((await s.http('/devices', { token })).status, 200)
  now += 2 * DAY
  assert.equal((await s.http('/devices', { token })).status, 200)
  now += 31 * DAY
  assert.equal((await s.http('/devices', { token })).status, 401)
})

test('use refreshes last_seen_at at most once an hour; an expired token never refreshes it', async (t) => {
  const { s, token, deviceId } = await startApprovalServer(t)
  const recent = Date.now() - 60000
  s.db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(recent, deviceId)
  await s.http('/devices', { token })
  assert.equal(seen(s, deviceId), recent)
  const old = age(s, deviceId, 31)
  assert.equal((await s.http('/devices', { token })).status, 401)
  assert.equal(seen(s, deviceId), old)
})

test('an agent token works after 400 days', async (t) => {
  const { s, alice } = await startApprovalServer(t)
  const box = createAgent(s.db, alice.id, 'box-a')
  age(s, box.deviceId, 400)
  assert.equal((await s.http('/roster', { token: box.token })).status, 200)
  assert.ok(authToken(s.db, box.token, { clientIdleMs: DAY }))
})

test('a null last_seen_at counts from created_at', async (t) => {
  const { s, token, deviceId } = await startApprovalServer(t)
  s.db.prepare('UPDATE devices SET last_seen_at=NULL, created_at=? WHERE id=?').run(Date.now() - 31 * DAY, deviceId)
  assert.equal((await s.http('/devices', { token })).status, 401)
  s.db.prepare('UPDATE devices SET last_seen_at=NULL, created_at=? WHERE id=?').run(Date.now() - 29 * DAY, deviceId)
  assert.equal((await s.http('/devices', { token })).status, 200)
})

test('MATRON_CLIENT_IDLE_DAYS=0 disables the expiry; a fraction sets it; the injected clock is used', async (t) => {
  const off = await startApprovalServer(t, { clientIdleDays: 0 })
  age(off.s, off.deviceId, 4000)
  assert.equal((await off.s.http('/devices', { token: off.token })).status, 200)
  let now = Date.now()
  const short = await startApprovalServer(t, { clientIdleDays: 0.5, clientIdleClock: () => now })
  assert.equal((await short.s.http('/devices', { token: short.token })).status, 200)
  now += DAY
  assert.equal((await short.s.http('/devices', { token: short.token })).status, 401)
})

test('the setting parses like its neighbours: default 30 days, invalid warns and falls back', (t) => {
  const savedEnv = process.env.MATRON_CLIENT_IDLE_DAYS
  delete process.env.MATRON_CLIENT_IDLE_DAYS
  t.after(() => { if (savedEnv === undefined) delete process.env.MATRON_CLIENT_IDLE_DAYS; else process.env.MATRON_CLIENT_IDLE_DAYS = savedEnv })
  const warns = []
  t.mock.method(console, 'warn', (m) => warns.push(m))
  assert.equal(resolveClientIdleMs(undefined), 30 * DAY)
  assert.equal(resolveClientIdleMs(null), 30 * DAY)
  assert.equal(resolveClientIdleMs(0), 0)
  assert.equal(resolveClientIdleMs('7'), 7 * DAY)
  assert.equal(warns.length, 0)
  for (const bad of ['abc', '-1', 'NaN', 'Infinity']) assert.equal(resolveClientIdleMs(bad), 30 * DAY)
  assert.equal(warns.length, 4)
})

test('a short idle limit still refreshes: the hourly throttle is clamped to half the limit', async (t) => {
  let now = Date.now()
  const { s, token } = await startApprovalServer(t, { clientIdleDays: 1 / 24, clientIdleClock: () => now }) // 1 hour
  for (let i = 0; i < 6; i++) {
    now += 40 * 60 * 1000
    assert.equal((await s.http('/devices', { token })).status, 200, `use ${i}`)
  }
})

test('the device list marks an idle-expired client and nothing else', async (t) => {
  const { s, alice, token, deviceId } = await startApprovalServer(t)
  const other = signIn(s, alice.id, 'tablet')
  const box = createAgent(s.db, alice.id, 'box-a')
  age(s, other.deviceId, 31)
  age(s, box.deviceId, 400)
  const r = await s.http('/devices', { token })
  const by = Object.fromEntries(r.json.devices.map((d) => [d.device_id, d.idle_expired]))
  assert.deepEqual(by, { [deviceId]: false, [other.deviceId]: true, [box.deviceId]: false })
})

test('an open socket of a device that idles out is closed as revoked at the next sweep', async (t) => {
  const { s, token, deviceId } = await startApprovalServer(t, { revocationSweepMs: 30 })
  const c = await makeWsClient(s.base, { token, cursor: 0 })
  t.after(() => c.ws.close())
  await c.waitFor((f) => f.op === 'hello_ok')
  let code = null
  c.ws.on('close', (x) => { code = x })
  age(s, deviceId, 31)
  await c.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'revoked', 3000)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(code, 4001)
})

test('after expiry, a fresh sign-in plus attach lets the same key sign a tap; another device\'s key stays wrong_device', async (t) => {
  const w = await startWithKey(t)
  const { s, alice, key } = w
  const box = createAgent(s.db, alice.id, 'box-a')
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: box.deviceId })
  const tablet = signIn(s, alice.id, 'tablet')
  const item = (await s.http('/items', { method: 'POST', token: box.token, body: { convo_id: 'c1', kind: 'question', title: 'Wire it?', body: 'Pay', actions: ['Approve', 'Deny'], step_up: true, subject: { payee: 'Acme' } } })).json.item
  age(s, w.deviceId, 31)
  assert.equal((await s.http('/devices', { token: w.token })).status, 401)
  // The key stays enrolled, detached or still on the idle row; signing in again is a new device.
  const again = signIn(s, alice.id, 'phone')
  const tapWithout = await signTap(s, { token: again.token, key, item, action: 'Approve' })
  const refused = await s.http(`/items/${item.id}/comments`, { method: 'POST', token: again.token, body: { action: 'Approve', approval: tapWithout } })
  assert.equal(refused.json.reason, 'wrong_device')
  const approval = await signAccount(s, { token: again.token, key, subject: { op: 'attach_key', key_id: key.keyId } })
  const att = await s.http('/approval-keys/attach', { method: 'POST', token: again.token, body: { approval } })
  assert.equal(att.status, 200, JSON.stringify(att.json))
  const tap = await signTap(s, { token: again.token, key, item, action: 'Approve' })
  const ok = await s.http(`/items/${item.id}/comments`, { method: 'POST', token: again.token, body: { action: 'Approve', approval: tap } })
  assert.equal(ok.status, 201, JSON.stringify(ok.json))
  // A device that never attached the key still cannot use it.
  const tapT = await signTap(s, { token: tablet.token, key, item, action: 'Deny' })
  const no = await s.http(`/items/${item.id}/comments`, { method: 'POST', token: tablet.token, body: { action: 'Deny', approval: tapT } })
  assert.equal(no.json?.reason, 'wrong_device')
})
