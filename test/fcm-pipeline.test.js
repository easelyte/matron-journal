import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, setFcmRegistration, clearFcmRegistration, clientDevicesForPush, setApnsRegistration } from '../src/db.js'
import { createUser, createAgent, createClientDevice, revokeDevice } from '../src/auth.js'
import { makeHub } from '../src/hub.js'
import { makePushPipeline } from '../src/push.js'
import { openBox } from '../src/push-box.js'
import { upsertConversation, append } from '../src/journal.js'
import { setNotifyPrefs, setDeviceLevel, NOTIFY_EVENTS } from '../src/notify.js'
import { buildMetrics } from '../src/metrics.js'
import { startTestServer } from './helpers.js'
import { RECIPIENT, keyPairFrom } from './push-box-fixture.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Polls instead of guessing how long a coalescing window takes on a busy runner.
async function until(check, ms = 5000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await pause(10)
  }
}
const TOKEN = 'fcm-token-alice-phone-0001'

async function setup(t, { answer = () => ({ status: 200, reason: null }), key = RECIPIENT.key, coalesceMs = 40, apns = false } = {}) {
  const db = openDb(':memory:')
  const hub = makeHub()
  const alice = await createUser(db, 'alice', 'pw')
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, title: 'Release notes' })
  setNotifyPrefs(db, alice.id, { mode: 'custom', events: Object.fromEntries(NOTIFY_EVENTS.map((k) => [k, true])) })
  const phone = createClientDevice(db, alice.id, 'android')
  setFcmRegistration(db, phone.deviceId, { token: TOKEN, pushKey: key })
  const sends = []
  const apnsCalls = []
  const fcmClient = { send: async (opts) => { sends.push(opts); return answer(opts, sends.length) }, close() {} }
  const apnsClient = apns ? { send: async (opts) => { apnsCalls.push(opts); return { status: 200 } } } : undefined
  const pipeline = makePushPipeline({ db, hub, fcmClient, apnsClient, coalesceMs })
  t.after(() => { pipeline.close(); hub.close(); db.close() })
  function send({ type = 'permission_request', payload = { description: 'needs you' }, sender = 'agent:alice', origin = null } = {}) {
    const r = append(db, { userId: alice.id, convoId: 'c1', sender, type, payload })
    pipeline.onAppend(alice.id, { seq: r.seq, ts: r.ts, convo_id: 'c1', sender, type, payload }, origin)
    return r
  }
  return { db, hub, alice, phone, pipeline, sends, apnsCalls, send }
}

test('an alert goes to the phone as a data-only, high-priority message with the content sealed to its key', async (t) => {
  const s = await setup(t)
  const r = s.send()
  await tick()
  assert.equal(s.sends.length, 1)
  const { token, data, priority, ttlSeconds } = s.sends[0]
  assert.equal(token, TOKEN)
  assert.equal(priority, 'high')
  assert.equal(ttlSeconds, 86400)
  assert.deepEqual(Object.keys(data).sort(), ['badge', 'box', 'convo_id', 'kind', 'seq', 'type'])
  assert.equal(data.type, 'alert')
  assert.equal(data.convo_id, 'c1')
  assert.equal(data.seq, String(r.seq))
  assert.equal(data.kind, 'attention')
  // FCM's rule: every data value is a string.
  for (const v of Object.values(data)) assert.equal(typeof v, 'string')
  // Nothing readable travels outside the box.
  assert.ok(!JSON.stringify(data).includes('Release notes'))
  const opened = JSON.parse(openBox(RECIPIENT, data.box))
  assert.equal(opened.title, 'Release notes')
  assert.equal(opened.convo_id, 'c1')
  assert.equal(opened.seq, r.seq)
  assert.equal(opened.kind, 'attention')
})

test('an item that needs the user carries its id, and its buttons in the box', async (t) => {
  const s = await setup(t)
  s.db.prepare("INSERT INTO items(id, user_id, num, kind, title, body, state, awaiting, rank, origin_convo_id, origin_device_id, created_by, created_at, updated_at) VALUES ('it_1', ?, 12, 'question', 'Ship it?', 'Now or later.', 'open', 'user', 1, 'c1', ?, 'agent', 0, 0)").run(s.alice.id, s.phone.deviceId)
  s.send({ type: 'item', payload: { action: 'created', item_id: 'it_1', num: 12, kind: 'question', title: 'Ship it?', awaiting: 'user', by: 'agent', actions: ['Ship', 'Wait'] } })
  await tick()
  assert.equal(s.sends.length, 1)
  assert.equal(s.sends[0].data.item_id, 'it_1')
  const opened = JSON.parse(openBox(RECIPIENT, s.sends[0].data.box))
  assert.equal(opened.title, 'Ship it?')
  assert.deepEqual(opened.item, { id: 'it_1', num: 12, kind: 'question', actions: ['Ship', 'Wait'] })
})

test('a phone that registered no key gets the title and text in the clear', async (t) => {
  const plain = await setup(t, { key: null })
  plain.send()
  await tick()
  assert.equal(plain.sends[0].data.title, 'Release notes')
  assert.equal(plain.sends[0].data.body, 'permission: needs you')
  assert.equal(plain.sends[0].data.box, undefined)
})

test('routine activity is coalesced per conversation and sent at normal TTL', async (t) => {
  const s = await setup(t, { coalesceMs: 30 })
  s.send({ type: 'text', payload: { body: 'one' } })
  s.send({ type: 'text', payload: { body: 'two' } })
  s.send({ type: 'text', payload: { body: 'three' } })
  await tick()
  assert.equal(s.sends.length, 1)
  assert.equal(s.sends[0].ttlSeconds, 3600)
  await until(() => s.sends.length === 2)
  assert.equal(JSON.parse(openBox(RECIPIENT, s.sends[1].data.box)).body, 'three')
})

test('the badge is the unread count at send time', async (t) => {
  const s = await setup(t)
  s.send({ type: 'text', payload: { body: 'hello' } })
  await tick()
  assert.equal(s.sends[0].data.badge, '1')
})

test('the device level applies: Off sends nothing, Needs me drops routine activity', async (t) => {
  const s = await setup(t)
  setDeviceLevel(s.db, s.phone.deviceId, 'needs_me')
  s.send({ type: 'text', payload: { body: 'routine' } })
  await tick()
  assert.equal(s.sends.length, 0)
  s.send()
  await tick()
  assert.equal(s.sends.length, 1)
  setDeviceLevel(s.db, s.phone.deviceId, 'off')
  s.send()
  await tick()
  assert.equal(s.sends.length, 1)
})

test('a user\'s own message never pushes', async (t) => {
  const s = await setup(t)
  s.send({ type: 'text', payload: { body: 'mine' }, sender: 'user:alice' })
  await tick()
  assert.equal(s.sends.length, 0)
})

test('a read elsewhere sends a quiet read message to the phone, never to the device that read', async (t) => {
  const s = await setup(t)
  const tablet = createClientDevice(s.db, s.alice.id, 'tablet')
  const r = s.send({ type: 'text', payload: { body: 'hi' } })
  await until(() => s.pipeline._coalesceState.size === 0)
  s.sends.length = 0
  s.send({ type: 'read_marker', payload: { convo_id: 'c1', up_to_seq: r.seq }, sender: 'user:alice', origin: tablet.deviceId })
  await tick()
  assert.equal(s.sends.length, 1)
  const { badge, ...rest } = s.sends[0].data
  assert.deepEqual(rest, { type: 'read', convo_id: 'c1' })
  assert.match(badge, /^\d+$/)
  assert.equal(s.sends[0].priority, 'normal')
  s.send({ type: 'read_marker', payload: { convo_id: 'c1', up_to_seq: r.seq }, sender: 'user:alice', origin: s.phone.deviceId })
  await tick()
  assert.equal(s.sends.length, 1)
})

test('a read elsewhere drops a routine alert still waiting in that conversation', async (t) => {
  const s = await setup(t, { coalesceMs: 30 })
  const tablet = createClientDevice(s.db, s.alice.id, 'tablet')
  s.send({ type: 'text', payload: { body: 'one' } })
  const r = s.send({ type: 'text', payload: { body: 'two' } })
  await tick()
  assert.equal(s.sends.length, 1)
  s.send({ type: 'read_marker', payload: { convo_id: 'c1', up_to_seq: r.seq }, sender: 'user:alice', origin: tablet.deviceId })
  await until(() => s.pipeline._coalesceState.size === 0)
  assert.deepEqual(s.sends.map((x) => x.data.type), ['alert', 'read'])
})

test('a read on the phone itself drops its own waiting alert too', async (t) => {
  const s = await setup(t, { coalesceMs: 30 })
  s.send({ type: 'text', payload: { body: 'one' } })
  const r = s.send({ type: 'text', payload: { body: 'two' } })
  await tick()
  s.send({ type: 'read_marker', payload: { convo_id: 'c1', up_to_seq: r.seq }, sender: 'user:alice', origin: s.phone.deviceId })
  await until(() => s.pipeline._coalesceState.size === 0)
  assert.deepEqual(s.sends.map((x) => x.data.type), ['alert'])
})

test('404 UNREGISTERED prunes the token; other failures keep it', async (t) => {
  const s = await setup(t, {
    answer: (_o, n) => (n === 1 ? { status: 400, reason: 'SENDER_ID_MISMATCH' } : { status: 404, reason: 'UNREGISTERED' }),
  })
  const logged = []
  const original = console.error
  console.error = (...args) => logged.push(args.join(' '))
  t.after(() => { console.error = original })
  s.send()
  await tick()
  assert.equal(clientDevicesForPush(s.db, s.alice.id).length, 1)
  s.send()
  await tick()
  assert.equal(clientDevicesForPush(s.db, s.alice.id).length, 0)
  assert.deepEqual(s.pipeline.fcmCounters, { sent: 0, failed: 2, pruned: 1, byReason: { SENDER_ID_MISMATCH: 1, UNREGISTERED: 1 } })
  // Logs name the device, never its token.
  assert.ok(logged.some((l) => l.includes(`device ${s.phone.deviceId}`)))
  assert.ok(!logged.some((l) => l.includes(TOKEN)))
  assert.equal(buildMetrics(s.db, { hub: s.hub, pushPipeline: s.pipeline, userId: s.alice.id }).push.fcm.pruned, 1)
})

test('a prune that lands after a new registration leaves the new one alone', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const s = await setup(t, { answer: async () => { await gate; return { status: 404, reason: 'UNREGISTERED' } } })
  s.send()
  await tick()
  setFcmRegistration(s.db, s.phone.deviceId, { token: 'fcm-token-alice-phone-0002', pushKey: RECIPIENT.key })
  release()
  await tick()
  await tick()
  assert.equal(clientDevicesForPush(s.db, s.alice.id)[0].fcm_token, 'fcm-token-alice-phone-0002')
})

test('a push queued before the phone unregistered or changed key is not sent with stale state', async (t) => {
  const s = await setup(t, { coalesceMs: 30 })
  s.send({ type: 'text', payload: { body: 'one' } })
  s.send({ type: 'text', payload: { body: 'two' } })
  await tick()
  assert.equal(s.sends.length, 1)
  // A new key while the trailing push waits: the box is sealed to it.
  const next = keyPairFrom('alice phone, second key')
  setFcmRegistration(s.db, s.phone.deviceId, { token: TOKEN, pushKey: next.key })
  await until(() => s.sends.length === 2)
  assert.equal(JSON.parse(openBox(next, s.sends[1].data.box)).body, 'two')
  // A new token while one waits: it goes to the new token.
  s.send({ type: 'text', payload: { body: 'three' } })
  setFcmRegistration(s.db, s.phone.deviceId, { token: 'fcm-token-alice-phone-0002', pushKey: next.key })
  await until(() => s.sends.length === 3)
  assert.equal(s.sends[2].token, 'fcm-token-alice-phone-0002')
  // Unregistered while the next one waits: nothing goes.
  s.send({ type: 'text', payload: { body: 'four' } })
  clearFcmRegistration(s.db, s.phone.deviceId)
  await until(() => s.pipeline._coalesceState.size === 0)
  assert.equal(s.sends.length, 3)
})

test('a phone with both an APNs and an FCM registration gets each once', async (t) => {
  const s = await setup(t, { apns: true })
  setApnsRegistration(s.db, s.phone.deviceId, { apnsToken: 'a'.repeat(64), apnsEnv: 'prod' })
  s.send()
  await tick()
  assert.equal(s.sends.length, 1)
  assert.equal(s.apnsCalls.length, 1)
})

test('registering claims the token from any other device, and a revoked device takes its registration with it', async (t) => {
  const db = openDb(':memory:')
  t.after(() => db.close())
  const alice = await createUser(db, 'alice', 'pw')
  const bob = await createUser(db, 'bob', 'pw')
  const old = createClientDevice(db, alice.id, 'android')
  const fresh = createClientDevice(db, bob.id, 'android')
  setFcmRegistration(db, old.deviceId, { token: TOKEN })
  setFcmRegistration(db, fresh.deviceId, { token: TOKEN, pushKey: RECIPIENT.key })
  assert.equal(clientDevicesForPush(db, alice.id).length, 0)
  assert.equal(clientDevicesForPush(db, bob.id)[0].fcm_key, RECIPIENT.key)
  revokeDevice(db, fresh.deviceId)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fcm_registrations').get().n, 0)
})

async function server(t, { fcm = true } = {}) {
  // Off means off, whatever the test process's own environment says.
  if (!fcm) {
    const saved = process.env.MATRON_FCM_DISABLED
    process.env.MATRON_FCM_DISABLED = '1'
    t.after(() => { if (saved === undefined) delete process.env.MATRON_FCM_DISABLED; else process.env.MATRON_FCM_DISABLED = saved })
  }
  const fcmClient = fcm ? { send: async () => ({ status: 200, reason: null }), close() {} } : undefined
  const s = await startTestServer({ fcmClient })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const phone = createClientDevice(s.db, alice.id, 'android')
  const agent = createAgent(s.db, alice.id, 'bridge')
  const post = (body, token = phone.token) => s.http('/push/fcm/register', { method: 'POST', token, body })
  const row = () => s.db.prepare('SELECT token, push_key FROM fcm_registrations WHERE device_id=?').get(phone.deviceId)
  return { ...s, alice, phone, agent, post, row }
}

test('POST /push/fcm/register stores the token and key, replaces them, and null unregisters', async (t) => {
  const s = await server(t)
  assert.deepEqual(await s.post({ token: TOKEN, push_key: RECIPIENT.key }), { status: 200, json: { ok: true } })
  assert.deepEqual(s.row(), { token: TOKEN, push_key: RECIPIENT.key })
  assert.deepEqual(await s.post({ token: 'fcm-token-alice-phone-0002' }), { status: 200, json: { ok: true } })
  assert.deepEqual(s.row(), { token: 'fcm-token-alice-phone-0002', push_key: null })
  assert.deepEqual(await s.post({ token: null }), { status: 200, json: { ok: true } })
  assert.equal(s.row(), undefined)
})

test('POST /push/fcm/register refuses agents, bad tokens and bad keys', async (t) => {
  const s = await server(t)
  assert.equal((await s.post({ token: TOKEN }, s.agent.token)).status, 403)
  for (const token of [undefined, '', 'short', 42, 'has spaces in it, sadly', 'x'.repeat(4097)]) {
    assert.deepEqual(await s.post({ token }), { status: 400, json: { error: 'bad_request' } }, String(token))
  }
  assert.deepEqual(await s.post({ token: TOKEN, push_key: 'not-a-key' }), { status: 400, json: { error: 'bad_request' } })
  assert.equal(s.row(), undefined)
})

test('with FCM off, registering is 404 fcm_disabled but unregistering still works', async (t) => {
  const s = await server(t, { fcm: false })
  assert.deepEqual(await s.post({ token: TOKEN }), { status: 404, json: { error: 'fcm_disabled' } })
  assert.deepEqual(await s.post({ token: null }), { status: 200, json: { ok: true } })
})
