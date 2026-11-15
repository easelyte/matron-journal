import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestServer } from './helpers.js'
import { checkEndpoint } from '../src/webpush.js'
import { resolveWebPushClient } from '../src/server.js'
import { openDb, setWebPushSubscription, clearWebPushSubscription, pruneWebPushSubscription, clientDevicesForPush } from '../src/db.js'
import { createUser, createAgent, createClientDevice } from '../src/auth.js'

const envVars = ['MATRON_WEBPUSH_EXTRA_HOSTS', 'MATRON_WEBPUSH_VAPID_KEY_FILE', 'MATRON_WEBPUSH_SUBJECT', 'MATRON_WEBPUSH_DISABLED', 'MATRON_APNS_KEY_FILE', 'MATRON_APNS_KEY_ID', 'MATRON_APNS_TEAM_ID', 'MATRON_APNS_TOPIC', 'MATRON_PUSH_GATEWAY_URL']

function withEnv(t, values = {}) {
  const saved = Object.fromEntries(envVars.map((k) => [k, process.env[k]]))
  for (const k of envVars) delete process.env[k]
  Object.assign(process.env, values)
  t.after(() => {
    for (const k of envVars) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })
}

function subscription(name = 'alice') {
  const ua = crypto.createECDH('prime256v1')
  ua.generateKeys()
  return { endpoint: `https://push.example.com/${name}`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } }
}

async function setup(t, { off = false, dbPath = ':memory:' } = {}) {
  withEnv(t)
  const publicKey = subscription().keys.p256dh
  const client = { publicKey, checkEndpoint: (value) => checkEndpoint(value, ['push.example.com', '*.custom.example.com']), send: async () => ({ status: 201 }), close() {} }
  const s = await startTestServer({ dbPath, webPushClient: off ? undefined : client })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const device = createClientDevice(s.db, alice.id, 'browser')
  const agent = createAgent(s.db, alice.id, 'bridge')
  const post = (body, token = device.token) => s.http('/push/web/register', { method: 'POST', token, body })
  return { ...s, alice, device, agent, publicKey, client, post }
}

function requireTable(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='web_push_subscriptions'").get()
  assert.ok(row, 'additive migration creates web_push_subscriptions')
}

test('vapid-key returns the injected client public key', async (t) => {
  const s = await setup(t)
  assert.deepEqual(await s.http('/push/web/vapid-key', { token: s.device.token }), { status: 200, json: { public_key: s.publicKey } })
})

test('registration is idempotent, replacement updates the row and null unregisters', async (t) => {
  const s = await setup(t)
  const sub = subscription()
  assert.deepEqual(await s.post(sub), { status: 200, json: { ok: true } })
  requireTable(s.db)
  const rows = () => s.db.prepare('SELECT * FROM web_push_subscriptions WHERE device_id=?').all(s.device.deviceId)
  const first = rows()
  assert.equal(first.length, 1)
  assert.equal(first[0].endpoint, sub.endpoint)
  assert.equal(first[0].p256dh, sub.keys.p256dh)
  assert.equal(first[0].auth, sub.keys.auth)
  assert.equal(typeof first[0].created_at, 'number')
  // A fixed old timestamp catches an implementation that resets it even
  // when the two registrations happen in the same millisecond.
  s.db.prepare('UPDATE web_push_subscriptions SET created_at=123 WHERE device_id=?').run(s.device.deviceId)
  assert.equal((await s.post(sub)).status, 200)
  assert.equal(rows().length, 1)
  assert.equal(rows()[0].created_at, 123)
  const replacement = subscription('bob')
  assert.equal((await s.post(replacement)).status, 200)
  assert.equal(rows().length, 1)
  assert.equal(rows()[0].endpoint, replacement.endpoint)
  assert.equal(rows()[0].p256dh, replacement.keys.p256dh)
  assert.equal((await s.post({ endpoint: null })).status, 200)
  assert.equal(rows().length, 0)
})

test('agent devices cannot read the key or register browser subscriptions', async (t) => {
  const s = await setup(t)
  assert.equal((await s.post(subscription(), s.agent.token)).status, 403)
  assert.equal((await s.http('/push/web/vapid-key', { token: s.agent.token })).status, 403)
  assert.equal((await s.post({ endpoint: null }, s.agent.token)).status, 403)
})

test('registration rejects bad endpoints and keys including invalid curve points', async (t) => {
  const s = await setup(t)
  const sub = subscription()
  const invalidPoint = Buffer.alloc(65)
  invalidPoint[0] = 4
  const bodies = [
    { ...sub, endpoint: 'http://push.example.com/alice' },
    { ...sub, endpoint: 'https://127.0.0.1/alice' },
    { ...sub, endpoint: 'https://169.254.169.254/alice' },
    { ...sub, endpoint: 'https://user:pw@push.example.com/alice' },
    { ...sub, endpoint: 'https://push.example.com:8443/alice' },
    { ...sub, keys: { ...sub.keys, p256dh: 'bad' } },
    { ...sub, keys: { ...sub.keys, p256dh: Buffer.alloc(65).toString('base64url') } },
    { ...sub, keys: { ...sub.keys, p256dh: invalidPoint.toString('base64url') } },
    { ...sub, keys: { ...sub.keys, auth: Buffer.alloc(15).toString('base64url') } },
    { ...sub, keys: { ...sub.keys, auth: Buffer.alloc(17).toString('base64url') } },
    { endpoint: sub.endpoint }, { endpoint: sub.endpoint, keys: null }, {},
  ]
  for (const body of bodies) assert.deepEqual(await s.post(body), { status: 400, json: { error: 'bad_request' } })
  assert.equal((await s.post(sub)).status, 200, 'valid registration remains possible')
})

test('sender off returns disabled for key and registration but allows unregister', async (t) => {
  const s = await setup(t, { off: true })
  assert.deepEqual(await s.http('/push/web/vapid-key', { token: s.device.token }), { status: 404, json: { error: 'web_push_disabled' } })
  assert.deepEqual(await s.post(subscription()), { status: 404, json: { error: 'web_push_disabled' } })
  assert.deepEqual(await s.post({ endpoint: null }), { status: 200, json: { ok: true } })
})

test('db helpers claim endpoints, join web-only devices and prune only the held endpoint', async (t) => {
  const db = openDb(':memory:')
  t.after(() => db.close())
  const alice = await createUser(db, 'alice', 'pw')
  const bob = await createUser(db, 'bob', 'pw')
  const a = createClientDevice(db, alice.id, 'browser')
  const b = createClientDevice(db, bob.id, 'browser')
  const agent = createAgent(db, alice.id, 'bridge')
  const sub = subscription()
  const flat = { endpoint: sub.endpoint, ...sub.keys }
  setWebPushSubscription(db, a.deviceId, flat)
  const joined = clientDevicesForPush(db, alice.id)
  assert.equal(joined.length, 1, 'web-only clients participate in the shared pipeline')
  assert.equal(joined[0].wp_endpoint, sub.endpoint)
  assert.equal(joined[0].wp_p256dh, sub.keys.p256dh)
  assert.equal(joined[0].wp_auth, sub.keys.auth)
  setWebPushSubscription(db, agent.deviceId, { ...flat, endpoint: 'https://push.example.com/agent' })
  assert.equal(clientDevicesForPush(db, alice.id).length, 1)
  setWebPushSubscription(db, b.deviceId, flat)
  assert.equal(clientDevicesForPush(db, alice.id).length, 0)
  assert.equal(clientDevicesForPush(db, bob.id).length, 1)
  assert.equal(pruneWebPushSubscription(db, b.deviceId, 'https://push.example.com/old'), false)
  assert.equal(clientDevicesForPush(db, bob.id).length, 1)
  assert.equal(pruneWebPushSubscription(db, b.deviceId, sub.endpoint), true)
  assert.equal(pruneWebPushSubscription(db, b.deviceId, sub.endpoint), false)
  setWebPushSubscription(db, b.deviceId, flat)
  clearWebPushSubscription(db, b.deviceId)
  assert.equal(clientDevicesForPush(db, bob.id).length, 0)
  requireTable(db)
  setWebPushSubscription(db, b.deviceId, flat)
  db.prepare('DELETE FROM devices WHERE id=?').run(b.deviceId)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM web_push_subscriptions WHERE device_id=?').get(b.deviceId).n, 0)
})

test('migration is additive: dropped web table leaves APNs intact and reopen recreates it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpush-db-'))
  const dbPath = path.join(dir, 'journal.sqlite')
  const s = await setup(t, { dbPath })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  requireTable(s.db)
  const before = s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'web_push_subscriptions' ORDER BY name").all()
  s.db.exec('DROP TABLE web_push_subscriptions')
  assert.deepEqual(s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'web_push_subscriptions' ORDER BY name").all(), before)
  assert.deepEqual(await s.http('/push/register', { method: 'POST', token: s.device.token, body: { apns_token: 'alice-token', environment: 'prod' } }), { status: 200, json: { ok: true } })
  assert.equal(s.db.prepare('SELECT apns_token FROM devices WHERE id=?').get(s.device.deviceId).apns_token, 'alice-token')
  // Open a second connection rather than closing the server twice.
  const reopened = openDb(dbPath)
  try {
    requireTable(reopened)
    assert.equal(reopened.prepare('SELECT apns_token FROM devices WHERE id=?').get(s.device.deviceId).apns_token, 'alice-token')
    const again = openDb(dbPath)
    try { requireTable(again) } finally { again.close() }
  } finally { reopened.close() }
})

test('server selection honors an injected web client without owning it', (t) => {
  withEnv(t, { MATRON_WEBPUSH_VAPID_KEY_FILE: '/tmp/example-vapid.pem' })
  const injected = { publicKey: 'example', send: async () => ({ status: 201 }), close() {} }
  assert.deepEqual(resolveWebPushClient(injected), { client: injected, owned: false })
})

test('startServer fails loudly for key file without subject', async (t) => {
  withEnv(t, { MATRON_WEBPUSH_VAPID_KEY_FILE: '/tmp/example-vapid.pem' })
  // Cleanup is registered if a broken implementation unexpectedly boots.
  await assert.rejects(async () => {
    const s = await startTestServer()
    t.after(() => s.close())
  }, /MATRON_WEBPUSH_SUBJECT/)
})

test('neither web env variable boots with web off quietly', async (t) => {
  withEnv(t)
  const lines = []
  const original = console.info
  let s
  try {
    console.info = (...args) => lines.push(args.join(' '))
    s = await startTestServer()
    t.after(() => s.close())
  } finally { console.info = original }
  assert.ok(s.port > 0)
  assert.deepEqual(resolveWebPushClient(undefined), { client: undefined, owned: false })
  assert.equal(lines.filter((line) => line.includes('web push')).length, 0)
})

test('an endpoint is stored in its parsed form, so one host spelled two ways is one endpoint', async (t) => {
  const s = await setup(t)
  const sub = subscription()
  assert.equal((await s.post({ ...sub, endpoint: 'https://PUSH.example.com/x' })).status, 200)
  assert.equal(s.db.prepare('SELECT endpoint FROM web_push_subscriptions WHERE device_id=?').get(s.device.deviceId).endpoint, 'https://push.example.com/x')
})

test('registration applies the client host policy for default hosts, extras and rejected hosts', async (t) => {
  const s = await setup(t)
  const sub = subscription()
  for (const endpoint of [
    'https://fcm.googleapis.com/fcm/send/x',
    'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://web.push.apple.com/x',
    'https://wns2-par02p.notify.windows.com/x',
    'https://push.example.com/x', 'https://one.custom.example.com/x',
  ]) assert.equal((await s.post({ ...sub, endpoint })).status, 200, endpoint)
  for (const endpoint of ['https://example.org/x', 'https://custom.example.com/x', 'https://push.apple.com/x']) {
    assert.deepEqual(await s.post({ ...sub, endpoint }), { status: 400, json: { error: 'bad_request' } }, endpoint)
  }
  assert.equal(s.db.prepare('SELECT endpoint FROM web_push_subscriptions WHERE device_id=?').get(s.device.deviceId).endpoint,
    'https://one.custom.example.com/x')
})

test('server startup rejects invalid extra-host configuration', async (t) => {
  withEnv(t, { MATRON_WEBPUSH_EXTRA_HOSTS: 'push.example.com/path' })
  await assert.rejects(async () => {
    const s = await startTestServer()
    t.after(() => s.close())
  }, /MATRON_WEBPUSH_EXTRA_HOSTS/)
})
