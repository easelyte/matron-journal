import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, setApnsRegistration, setWebPushSubscription, clientDevicesForPush } from '../src/db.js'
import { createUser, createClientDevice } from '../src/auth.js'
import { makeHub } from '../src/hub.js'
import { makePushPipeline } from '../src/push.js'
import { makeWebPushClient } from '../src/webpush.js'
import { upsertConversation, append } from '../src/journal.js'
import { setNotifyPrefs, setConvoNotify, setDeviceLevel, NOTIFY_EVENTS } from '../src/notify.js'
import { buildMetrics } from '../src/metrics.js'

const shape = JSON.parse(fs.readFileSync(new URL('./fixtures/webpush-payload.json', import.meta.url)))
const tick = () => new Promise((resolve) => setImmediate(resolve))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Receiver owns the UA private key and decrypts only fake transport bodies.
function receive(body, ua, auth) {
  assert.ok(Buffer.isBuffer(body))
  assert.equal(body.readUInt32BE(16), 4096)
  assert.equal(body[20], 65)
  const sender = body.subarray(21, 86)
  const ikm = crypto.hkdfSync('sha256', ua.computeSecret(sender), auth,
    Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), sender]), 32)
  const salt = body.subarray(0, 16)
  const key = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  const cipher = crypto.createDecipheriv('aes-128-gcm', key, nonce)
  cipher.setAuthTag(body.subarray(-16))
  const plain = Buffer.concat([cipher.update(body.subarray(86, -16)), cipher.final()])
  assert.equal(plain.at(-1), 2)
  return JSON.parse(plain.subarray(0, -1).toString())
}

async function setup(t, { status = 201, web = true, apns = false, coalesceMs = 40 } = {}) {
  const db = openDb(':memory:')
  const hub = makeHub()
  const alice = await createUser(db, 'alice', 'pw')
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, title: 'convo one' })
  setNotifyPrefs(db, alice.id, { mode: 'custom', events: Object.fromEntries(NOTIFY_EVENTS.map((k) => [k, true])) })
  const device = createClientDevice(db, alice.id, 'browser')
  const ua = crypto.createECDH('prime256v1')
  ua.generateKeys()
  const auth = crypto.randomBytes(16)
  const sub = { endpoint: 'https://push.example.com/alice', p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }
  setWebPushSubscription(db, device.deviceId, sub)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpush-pipeline-'))
  const privateKeyFile = path.join(dir, 'vapid.pem')
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  fs.writeFileSync(privateKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const requests = []
  const apnsCalls = []
  const webPushClient = makeWebPushClient({
    privateKeyFile, subject: 'mailto:alice@example.com', extraHosts: ['push.example.com'],
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (request) => { requests.push(request); return { status, headers: {} } },
  })
  const apnsClient = { send: async (opts) => { apnsCalls.push(opts); return { status: 200 } } }
  const pipeline = makePushPipeline({ db, hub, webPushClient: web ? webPushClient : undefined, apnsClient: apns ? apnsClient : undefined, coalesceMs })
  t.after(() => { pipeline.close(); webPushClient.close(); hub.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  function send({ type = 'permission_request', payload = { description: 'needs you' }, sender = 'agent:alice', origin = null, hint } = {}) {
    const r = append(db, { userId: alice.id, convoId: 'c1', sender, type, payload })
    pipeline.onAppend(alice.id, { seq: r.seq, ts: r.ts, convo_id: 'c1', sender, type, payload }, origin, hint)
    return r
  }
  return { db, hub, alice, deviceId: device.deviceId, sub, pipeline, requests, apnsCalls, send, decode: (r) => receive(r.body, ua, auth) }
}

test('web-only permission request delivers one decryptable payload with the fixture schema', async (t) => {
  const s = await setup(t, { apns: true })
  const event = s.send()
  await tick()
  assert.equal(s.requests.length, 1)
  assert.equal(s.apnsCalls.length, 0)
  const payload = s.decode(s.requests[0])
  assert.deepEqual(Object.keys(payload).sort(), Object.keys(shape).sort())
  for (const [key, value] of Object.entries(shape)) assert.equal(typeof payload[key], typeof value, key)
  assert.deepEqual(payload, { ...shape, seq: event.seq })
  const h = Object.fromEntries(Object.entries(s.requests[0].headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
  assert.equal(h.urgency, 'high')
  assert.equal(h.ttl, '86400')
  assert.equal(h.topic, crypto.createHash('sha256').update('c1').digest('base64url').slice(0, 32))
})

for (const filter of ['user sender', 'viewing', 'cursor', 'device off', 'convo mute', 'origin', 'user settings']) {
  test(`shared decision suppresses web for ${filter} and permits a control event`, async (t) => {
    const s = await setup(t)
    let options = {}
    let reset = () => {}
    if (filter === 'user sender') options = { sender: 'user:alice' }
    if (filter === 'viewing') {
      const conn = { userId: s.alice.id, deviceId: s.deviceId, viewingConvoIds: new Set(['c1']), ws: { readyState: 1 } }
      s.hub.register(conn)
      reset = () => { conn.viewingConvoIds.clear() }
    }
    if (filter === 'cursor') {
      s.db.prepare('UPDATE devices SET cursor=100 WHERE id=?').run(s.deviceId)
      reset = () => s.db.prepare('UPDATE devices SET cursor=0 WHERE id=?').run(s.deviceId)
    }
    // Existing device settings call the disabled level "off".
    if (filter === 'device off') {
      setDeviceLevel(s.db, s.deviceId, 'off')
      reset = () => setDeviceLevel(s.db, s.deviceId, 'all')
    }
    if (filter === 'convo mute') {
      setConvoNotify(s.db, s.alice.id, 'c1', { mute_until: Date.now() + 60000 })
      reset = () => setConvoNotify(s.db, s.alice.id, 'c1', { mute_until: null })
    }
    if (filter === 'origin') options = { origin: s.deviceId }
    if (filter === 'user settings') {
      // Prompts are forced on whatever the switches say, so the suppressed
      // event is routine activity, which its own switch controls.
      options = { type: 'text', payload: { body: 'routine' } }
      setNotifyPrefs(s.db, s.alice.id, { mode: 'custom', events: Object.fromEntries(NOTIFY_EVENTS.map((k) => [k, false])) })
      reset = () => setNotifyPrefs(s.db, s.alice.id, { mode: 'custom', events: Object.fromEntries(NOTIFY_EVENTS.map((k) => [k, true])) })
    }
    s.send(options)
    await tick()
    assert.equal(s.requests.length, 0)
    reset()
    s.send()
    await tick()
    assert.equal(s.requests.length, 1, 'positive control after removing suppression')
  })
}

test('routine web events coalesce into a leading and one trailing push', async (t) => {
  const s = await setup(t, { coalesceMs: 80 })
  s.send({ type: 'text', payload: { body: 'first' } })
  s.send({ type: 'text', payload: { body: 'middle' } })
  s.send({ type: 'text', payload: { body: 'last' } })
  await tick()
  assert.equal(s.requests.length, 1)
  await pause(110)
  assert.equal(s.requests.length, 2)
  assert.equal(s.decode(s.requests[1]).body, 'last')
  const h = Object.fromEntries(Object.entries(s.requests[1].headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
  assert.equal(h.urgency, 'normal')
  assert.equal(h.ttl, '3600')
  await pause(110)
  assert.equal(s.requests.length, 2)
})

for (const status of [404, 410, 500]) test(`web status ${status}: counters, pruning and metrics`, async (t) => {
  const s = await setup(t, { status })
  s.send()
  await tick()
  assert.equal(s.requests.length, 1)
  const dead = status !== 500
  assert.ok(s.pipeline.webCounters, 'pipeline exposes web counters')
  assert.equal(s.pipeline.webCounters.failed, 1)
  assert.equal(s.pipeline.webCounters.sent, 0)
  assert.equal(s.pipeline.webCounters.pruned, dead ? 1 : 0)
  assert.equal(Object.values(s.pipeline.webCounters.byReason).reduce((a, b) => a + b, 0), 1)
  const rows = clientDevicesForPush(s.db, s.alice.id)
  assert.equal(rows.some((r) => r.wp_endpoint === s.sub.endpoint), !dead)
  const metrics = buildMetrics(s.db, { hub: s.hub, pushPipeline: s.pipeline, userId: s.alice.id })
  assert.deepEqual(metrics.push.web, { sent: 0, failed: 1, pruned: dead ? 1 : 0, by_reason: s.pipeline.webCounters.byReason })
})

test('kill switch sends no web push while APNs works and web metrics remain zero', async (t) => {
  const s = await setup(t, { web: false, apns: true })
  setApnsRegistration(s.db, s.deviceId, { apnsToken: 'browser-token', apnsEnv: 'prod' })
  s.send()
  await tick()
  assert.equal(s.requests.length, 0)
  assert.equal(s.apnsCalls.length, 1)
  const metrics = buildMetrics(s.db, { hub: s.hub, pushPipeline: s.pipeline, userId: s.alice.id })
  assert.deepEqual(metrics.push.web, { sent: 0, failed: 0, pruned: 0, by_reason: {} })
})

test('one device with both transports receives both and independent coalescing windows', async (t) => {
  const s = await setup(t, { apns: true, coalesceMs: 80 })
  setApnsRegistration(s.db, s.deviceId, { apnsToken: 'browser-token', apnsEnv: 'prod' })
  s.send()
  await tick()
  assert.equal(s.apnsCalls.length, 1)
  assert.equal(s.requests.length, 1)
  s.send({ type: 'text', payload: { body: 'first' } })
  s.send({ type: 'text', payload: { body: 'last' } })
  await tick()
  assert.equal(s.apnsCalls.length, 2)
  assert.equal(s.requests.length, 2)
  await pause(110)
  assert.equal(s.apnsCalls.length, 3)
  assert.equal(s.requests.length, 3)
})

test('web never sends a silent wake or read-marker notification', async (t) => {
  const s = await setup(t)
  s.send({ type: 'read_marker', sender: 'user:alice', payload: { convo_id: 'c1', up_to_seq: 0 } })
  await tick()
  assert.equal(s.requests.length, 0)
  s.send()
  await tick()
  assert.equal(s.requests.length, 1)
  assert.equal(s.decode(s.requests[0]).kind, 'attention')
})

test('a trailing web push queued before a panic lock is dropped at the send', async (t) => {
  const s = await setup(t, { coalesceMs: 60 })
  s.send({ type: 'text', payload: { body: 'first' } })
  s.send({ type: 'text', payload: { body: 'queued' } })
  await tick()
  assert.equal(s.requests.length, 1)
  s.db.prepare('INSERT INTO panic_locks(user_id, since) VALUES(?,?)').run(s.alice.id, Date.now())
  await pause(100)
  assert.equal(s.requests.length, 1, 'the queued push is not sent to a frozen account')
  s.db.prepare('UPDATE panic_locks SET cleared_at=? WHERE user_id=?').run(Date.now(), s.alice.id)
  s.send()
  await tick()
  assert.equal(s.requests.length, 2, 'positive control after the lock is cleared')
})

test('a trailing web push queued before the device signed out is dropped at the send', async (t) => {
  const s = await setup(t, { coalesceMs: 60 })
  s.send({ type: 'text', payload: { body: 'first' } })
  s.send({ type: 'text', payload: { body: 'queued' } })
  await tick()
  assert.equal(s.requests.length, 1)
  s.db.prepare('DELETE FROM web_push_subscriptions WHERE device_id=?').run(s.deviceId)
  s.db.prepare('DELETE FROM devices WHERE id=?').run(s.deviceId)
  await pause(100)
  assert.equal(s.requests.length, 1)
})
