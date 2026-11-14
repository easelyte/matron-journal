import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, setApnsRegistration } from '../src/db.js'
import { makeHub } from '../src/hub.js'
import { makePushPipeline, classify } from '../src/push.js'
import { setNotifyPrefs, NOTIFY_EVENTS } from '../src/notify.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { handleOp } from '../src/ws.js'
import { makeGatewayClient } from '../src/gateway.js'
import { startTestServer, makeWsClient } from './helpers.js'
import { createItem } from '../src/items.js'
import { itemMarkerPayload } from '../src/items-marker.js'
import { openBox } from '../src/push-box.js'
import { RECIPIENT, keyPairFrom } from './push-box-fixture.js'

// Peer_message is a routine coalesced activity push (priority 5), not an
// attention alert and never silent — asserted explicitly, not via fallthrough.

// A stub apnsClient recording every send() call. `respond` maps a call to a
// {status, reason} result (default: 200 success); tests override it to
// simulate 410/400/etc. Never throws, matching the real client's contract.
function makeStubApnsClient(respond = () => ({ status: 200, reason: null })) {
  const calls = []
  return {
    calls,
    send(opts) {
      calls.push(opts)
      return Promise.resolve(respond(opts))
    },
  }
}

// A fake WS connection registered directly with the hub (no real socket) —
// hub.register/isViewing only touch userId/deviceId/viewingConvoIds/ws.readyState.
function fakeConn({ userId, deviceId }) {
  return { userId, deviceId, viewingConvoIds: new Set(), ws: { readyState: 1 } }
}

async function setup(t, { apnsClient, coalesceMs } = {}) {
  const db = openDb(':memory:')
  const hub = makeHub()
  const alice = await createUser(db, 'alice', 'pw')
  const stub = apnsClient || makeStubApnsClient()
  const pipeline = makePushPipeline({ db, hub, apnsClient: stub, coalesceMs })
  t.after(() => pipeline.close())
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, title: 'convo one' })
  // Most of this file predates the notification settings and exercises
  // pipeline mechanics against a user who receives everything; the settings
  // themselves are covered in test/notify.test.js.
  setNotifyPrefs(db, alice.id, { mode: 'custom', events: Object.fromEntries(NOTIFY_EVENTS.map((k) => [k, true])) })
  return { db, hub, alice, stub, pipeline }
}

function registerDevice(db, userId, name, { token = `${name}-token`, env = 'prod' } = {}) {
  const dev = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client',?,?,?)")
    .run(userId, name, `${name}-hash`, Date.now())
  const deviceId = dev.lastInsertRowid
  setApnsRegistration(db, deviceId, { apnsToken: token, apnsEnv: env })
  return deviceId
}

// Thin wrapper around `setup(t)` for tests that also need one registered
// client push device: adds that device and exposes `stub.calls` as `sent`
// (same recording the rest of this file inspects as `stub.calls`) plus the
// convo id `setup` already creates ('c1').
async function setupPipeline(t) {
  const { db, hub, alice, stub, pipeline } = await setup(t)
  const clientDeviceId = registerDevice(db, alice.id, 'phone')
  return { db, hub, pipeline, sent: stub.calls, alice, convoId: 'c1', clientDevice: { id: clientDeviceId } }
}

test('disabled mode (no apnsClient) is inert', async (t) => {
  const db = openDb(':memory:')
  const hub = makeHub()
  const alice = await createUser(db, 'alice', 'pw')
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id })
  registerDevice(db, alice.id, 'phone')
  const pipeline = makePushPipeline({ db, hub, apnsClient: undefined })
  t.after(() => pipeline.close())

  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi' } })
  assert.doesNotThrow(() => pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body: 'hi' } }, null))
  assert.equal(pipeline.counters.sent, 0)
})

test('agent devices are never pushed to', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t)
  const agentDeviceId = (await Promise.resolve(createAgent(db, alice.id, 'bridge'))).deviceId
  // Even if an agent device somehow had an apns_token set, kind='client' is
  // what clientDevicesForPush filters on.
  setApnsRegistration(db, agentDeviceId, { apnsToken: 'sneaky-token', apnsEnv: 'prod' })

  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:bridge', type: 'text', payload: { body: 'hi' } })
  pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:bridge', type: 'text', payload: { body: 'hi' } }, null)
  await new Promise((res) => setImmediate(res))
  assert.equal(stub.calls.length, 0)
})

test('child conversations (parent_convo_id set) are silent: onAppend never pushes', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t, { coalesceMs: 50 })
  registerDevice(db, alice.id, 'phone')
  upsertConversation(db, { id: 'child', ownerUserId: alice.id, title: 'sub', parentConvoId: 'c1' })

  // An alert-worthy event (prompt) in a child convo pushes nothing...
  const r = append(db, { userId: alice.id, convoId: 'child', sender: 'agent:a', type: 'prompt', payload: { question: 'go?' } })
  pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'child', ts: r.ts, sender: 'agent:a', type: 'prompt', payload: { question: 'go?' } }, null)
  // ...nor does a read_marker in a child trigger a background push.
  const rm = append(db, { userId: alice.id, convoId: 'child', sender: 'user:alice', type: 'read_marker', payload: { convo_id: 'child', up_to_seq: r.seq } })
  pipeline.onAppend(alice.id, { seq: rm.seq, convo_id: 'child', ts: rm.ts, sender: 'user:alice', type: 'read_marker', payload: { convo_id: 'child', up_to_seq: r.seq } }, null)
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(stub.calls.length, 0, 'no push of any kind for a child convo')

  // Control: the same prompt in the normal parent convo DOES push.
  const p = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'prompt', payload: { question: 'go?' } })
  pipeline.onAppend(alice.id, { seq: p.seq, convo_id: 'c1', ts: p.ts, sender: 'agent:a', type: 'prompt', payload: { question: 'go?' } }, null)
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(stub.calls.length, 1)
})

test('type mapping: prompt/permission_request and turn-finished session_status push priority 10, others priority 5', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t, { coalesceMs: 50 })
  registerDevice(db, alice.id, 'phone')

  const send = (type, payload, hint) => {
    const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type, payload })
    pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type, payload }, null, hint)
    return r
  }

  send('prompt', { question: 'go ahead?' })
  send('permission_request', { description: 'write file' })
  send('session_status', { state: 'done' }, { prevSessionState: 'running' })
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(stub.calls.length, 3, 'prompt/permission_request/session_status:done must not be coalesced')
  for (const c of stub.calls) {
    assert.equal(c.priority, 10)
    assert.equal(c.pushType, 'alert')
    assert.equal(c.collapseId, 'c1')
  }

  // A routine type is priority 5 and coalesced (leading send, since idle).
  const before = stub.calls.length
  send('text', { body: 'routine update' })
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(stub.calls.length, before + 1)
  const routine = stub.calls[stub.calls.length - 1]
  assert.equal(routine.priority, 5)
  assert.equal(routine.pushType, 'alert')
  assert.equal(routine.collapseId, 'c1')
})

test('convo_meta and non-turn-finished session_status never push at all (no alert, no background)', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t, { coalesceMs: 30 })
  registerDevice(db, alice.id, 'phone')

  const send = (type, payload, hint) => {
    const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type, payload })
    pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type, payload }, null, hint)
  }

  send('convo_meta', { title: 'renamed while you were away' })
  send('session_status', { state: 'running' }, { prevSessionState: 'waiting' })
  // waiting -> done: teardown of an already-idle session (idle reaper,
  // /stop) — the user was already told the turn finished; silent.
  send('session_status', { state: 'done' }, { prevSessionState: 'waiting' })
  // No hint at all (a call site that can't know the previous state) fails
  // closed for session_status, even at state 'done'.
  send('session_status', { state: 'done' })
  // Long enough for both an immediate send AND a would-be trailing
  // coalesced push to have fired if these were (wrongly) classified routine.
  await new Promise((res) => setTimeout(res, 80))
  assert.equal(stub.calls.length, 0, 'convo_meta / non-turn-finished session_status are journal-sync material, not notifications')

  // ...and they must not have claimed the coalescing slot either: a real
  // routine event right after still gets its immediate leading push.
  send('text', { body: 'actual content' })
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].payload.aps.alert.body, 'actual content')
})

test('summary events never push', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t, { coalesceMs: 30 })
  registerDevice(db, alice.id, 'phone')

  const send = (type, payload, hint) => {
    const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type, payload })
    pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type, payload }, null, hint)
  }

  send('summary', { toc: 'x', detail: 'y', model: 'm' })
  // Long enough for both an immediate send AND a would-be trailing
  // coalesced push to have fired if this were (wrongly) classified routine.
  await new Promise((res) => setTimeout(res, 80))
  assert.equal(stub.calls.length, 0, 'summary events are journal-sync material, not notifications')

  // ...and they must not have claimed the coalescing slot either: a real
  // routine event right after still gets its immediate leading push.
  send('text', { body: 'actual content' })
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].payload.aps.alert.body, 'actual content')
})

test('a client "send" (sender user:*) never triggers an alert push, not even to the user\'s OTHER devices', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t, { coalesceMs: 30 })
  const originDeviceId = registerDevice(db, alice.id, 'origin-phone')
  const otherDeviceId = registerDevice(db, alice.id, 'other-laptop')

  // A user's own words/actions must not ring ANY of their devices — origin
  // exclusion alone isn't enough here (that only covers the SAME device);
  // classify() must return null for a `user:*` sender outright. (T2)
  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'user:alice', type: 'text', payload: { body: 'my own message' } })
  pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'user:alice', type: 'text', payload: { body: 'my own message' } }, originDeviceId)
  // Long enough for both an immediate AND a would-be trailing coalesced push.
  await new Promise((res) => setTimeout(res, 80))
  assert.equal(stub.calls.length, 0, 'a user\'s own message must not alert-push any of their devices')

  // ...and it must not have claimed the coalescing slot either: a real
  // (agent-sourced) routine event right after still gets its leading push —
  // to BOTH registered devices (two devices, two independent coalescing
  // slots keyed by device id).
  const r2 = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'actual content' } })
  pipeline.onAppend(alice.id, { seq: r2.seq, convo_id: 'c1', ts: r2.ts, sender: 'agent:a', type: 'text', payload: { body: 'actual content' } }, null)
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(stub.calls.length, 2)
  assert.ok(stub.calls.every((c) => c.payload.aps.alert.body === 'actual content'))
  assert.deepEqual(stub.calls.map((c) => c.deviceToken).sort(), ['origin-phone-token', 'other-laptop-token'].sort())
  void otherDeviceId
})

// Old-client fallback (spec: "Old-client fallback"): the marker already
// decided whether this action pushes; the flagged text mirroring it must
// not double it.
test('classify: a flagged item fallback text never pushes, even from an agent sender', () => {
  assert.equal(classify('text', { body: '📌 x', fallback_for: 'item' }, 'agent:box-2', undefined), null)
  // A silent event of any type pushes nothing; only a strict true is silent.
  assert.equal(classify('prompt', { question: 'Reminder set', options: ['Send now', 'Cancel'], blocking: false, silent: true }, 'agent:box-2', undefined), null)
  assert.equal(classify('text', { body: 'x', silent: true }, 'agent:box-2', undefined), null)
  assert.equal(classify('prompt', { question: 'Pick', options: ['A'], silent: 'true' }, 'agent:box-2', undefined).kind, 'attention')
})

test('origin-device exclusion applies to every push type, not just read_marker (defensive: a push recipient device that is also the event\'s origin is skipped)', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t)
  const originDeviceId = registerDevice(db, alice.id, 'origin-phone')
  const otherDeviceId = registerDevice(db, alice.id, 'other-laptop')

  // Hand-crafted: an alert-classified, agent-sourced event (so it's not
  // suppressed by the user:* rule) whose originDeviceId happens to be a
  // registered client push device. In practice today only read_marker's own
  // device is ever also a push recipient, but the exclusion must hold
  // uniformly for every push type — not asymmetrically special-cased to
  // read_marker alone.
  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'prompt', payload: { question: '?' } })
  pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'prompt', payload: { question: '?' } }, originDeviceId)
  await new Promise((res) => setImmediate(res))

  assert.equal(stub.calls.length, 1, 'only the non-origin device should be pushed to')
  assert.equal(stub.calls[0].deviceToken, 'other-laptop-token')
  void otherDeviceId
})

test('alert body: title falls back to convo id, body is the event snippet, badge is the owner unread sum', async (t) => {
  const db = openDb(':memory:')
  const hub = makeHub()
  const alice = await createUser(db, 'alice', 'pw')
  const stub = makeStubApnsClient()
  const pipeline = makePushPipeline({ db, hub, apnsClient: stub })
  t.after(() => pipeline.close())
  upsertConversation(db, { id: 'no-title-convo', ownerUserId: alice.id }) // title stays ''
  upsertConversation(db, { id: 'c2', ownerUserId: alice.id })
  registerDevice(db, alice.id, 'phone')
  setNotifyPrefs(db, alice.id, { mode: 'custom', events: { activity: true } })

  append(db, { userId: alice.id, convoId: 'c2', sender: 'agent:a', type: 'text', payload: { body: 'unread elsewhere' } })
  const r = append(db, { userId: alice.id, convoId: 'no-title-convo', sender: 'agent:a', type: 'text', payload: { body: 'hello there, this is the body' } })
  pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'no-title-convo', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body: 'hello there, this is the body' } }, null)
  await new Promise((res) => setImmediate(res))

  assert.equal(stub.calls.length, 1)
  const call = stub.calls[0]
  assert.equal(call.payload.aps.alert.title, 'no-title-convo')
  assert.equal(call.payload.aps.alert.body, 'hello there, this is the body')
  assert.equal(call.payload.aps['thread-id'], 'no-title-convo')
  assert.equal(call.payload.seq, r.seq) // read state: a tap reports this message as seen
  // both convos now have unread_count 1 (both messages from an agent sender)
  assert.equal(call.payload.aps.badge, 2)
})

test('viewing suppression: a device connected and viewing the convo is skipped', async (t) => {
  const { db, hub, alice, stub, pipeline } = await setup(t)
  const deviceId = registerDevice(db, alice.id, 'phone')
  const conn = fakeConn({ userId: alice.id, deviceId })
  hub.register(conn)
  conn.viewingConvoIds = new Set(['c1'])

  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi' } })
  pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body: 'hi' } }, null)
  await new Promise((res) => setImmediate(res))
  assert.equal(stub.calls.length, 0)

  // viewing a different convo: not suppressed
  conn.viewingConvoIds = new Set(['somewhere-else'])
  const r2 = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi again' } })
  pipeline.onAppend(alice.id, { seq: r2.seq, convo_id: 'c1', ts: r2.ts, sender: 'agent:a', type: 'text', payload: { body: 'hi again' } }, null)
  await new Promise((res) => setImmediate(res))
  assert.equal(stub.calls.length, 1)
})

test('acked-past suppression: a device whose cursor already covers the event seq is skipped', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t)
  const deviceId = registerDevice(db, alice.id, 'phone')

  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi' } })
  db.prepare('UPDATE devices SET cursor=? WHERE id=?').run(r.seq, deviceId) // already acked past
  pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body: 'hi' } }, null)
  await new Promise((res) => setImmediate(res))
  assert.equal(stub.calls.length, 0)

  const r2 = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi2' } })
  pipeline.onAppend(alice.id, { seq: r2.seq, convo_id: 'c1', ts: r2.ts, sender: 'agent:a', type: 'text', payload: { body: 'hi2' } }, null)
  await new Promise((res) => setImmediate(res))
  assert.equal(stub.calls.length, 1, 'a seq beyond the acked cursor must still push')
})

// Fires one routine agent event through the pipeline and waits for every
// send's result to be handled.
async function pushOnce(db, pipeline, userId, body = 'hi') {
  const r = append(db, { userId, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body } })
  pipeline.onAppend(userId, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body } }, null)
  await new Promise((res) => setTimeout(res, 10))
}

const tokenOf = (db, deviceId) => db.prepare('SELECT apns_token, apns_env FROM devices WHERE id=?').get(deviceId)

test('a 410 Unregistered response prunes the device apns_token/apns_env, keeping the device', async (t) => {
  const logs = t.mock.method(console, 'error', () => {})
  const stub = makeStubApnsClient(() => ({ status: 410, reason: 'Unregistered' }))
  const { db, alice, pipeline } = await setup(t, { apnsClient: stub })
  const deviceId = registerDevice(db, alice.id, 'dead-phone', { token: 'dead-token' })

  await pushOnce(db, pipeline, alice.id)

  assert.deepEqual({ ...tokenOf(db, deviceId) }, { apns_token: null, apns_env: null })
  assert.ok(db.prepare('SELECT 1 FROM devices WHERE id=?').get(deviceId), 'the device itself is kept')
  assert.equal(pipeline.counters.pruned, 1)
  assert.equal(pipeline.counters.failed, 1)
  assert.equal(logs.mock.calls.filter((c) => /pruned/.test(String(c.arguments[0]))).length, 1)
})

test('a 400 BadDeviceToken response prunes the token (logged once, with its env), keeping the device', async (t) => {
  const logs = t.mock.method(console, 'error', () => {})
  const stub = makeStubApnsClient(() => ({ status: 400, reason: 'BadDeviceToken' }))
  const { db, alice, pipeline } = await setup(t, { apnsClient: stub, coalesceMs: 1000 })
  const deviceId = registerDevice(db, alice.id, 'bad-phone', { token: 'bad-token', env: 'sandbox' })

  await pushOnce(db, pipeline, alice.id)
  assert.deepEqual({ ...tokenOf(db, deviceId) }, { apns_token: null, apns_env: null })
  assert.ok(db.prepare('SELECT 1 FROM devices WHERE id=?').get(deviceId), 'the device itself is kept')
  assert.equal(pipeline.counters.pruned, 1)
  const pruneLogs = logs.mock.calls.filter((c) => /pruned/.test(String(c.arguments[0])))
  assert.equal(pruneLogs.length, 1)
  assert.match(String(pruneLogs[0].arguments[0]), /BadDeviceToken/)
  assert.match(String(pruneLogs[0].arguments[0]), /sandbox/)

  // The pruned token is never tried again.
  stub.calls.length = 0
  await pushOnce(db, pipeline, alice.id, 'again')
  assert.equal(stub.calls.length, 0)
})

test('failures that do not mean a dead token never prune it', async (t) => {
  t.mock.method(console, 'error', () => {})
  const results = {
    'token-500': { status: 500, reason: 'InternalServerError' },
    'token-503': { status: 503, reason: 'ServiceUnavailable' },
    'token-429': { status: 429, reason: 'TooManyRequests' },
    'token-403': { status: 403, reason: 'ExpiredProviderToken' },
    'token-400-topic': { status: 400, reason: 'DeviceTokenNotForTopic' },
    'token-400-other': { status: 400, reason: 'BadCollapseId' },
    'token-400-none': { status: 400, reason: null },
    // The relay's own request validation, not an APNs verdict.
    'token-400-relay': { status: 400, reason: 'bad_device_token' },
    'token-transport': { status: 0, reason: 'transport' },
    'token-timeout': { status: 0, reason: 'timeout' },
  }
  const stub = makeStubApnsClient((opts) => results[opts.deviceToken])
  const { db, alice, pipeline } = await setup(t, { apnsClient: stub })
  const ids = Object.keys(results).map((token) => [token, registerDevice(db, alice.id, `phone-${token}`, { token })])

  await pushOnce(db, pipeline, alice.id)

  assert.equal(stub.calls.length, ids.length)
  for (const [token, id] of ids) assert.equal(tokenOf(db, id).apns_token, token, `${token} must be kept`)
  assert.equal(pipeline.counters.pruned, 0)
  assert.equal(pipeline.counters.failed, ids.length)
})

test('re-registering a pruned token restores pushes to it', async (t) => {
  t.mock.method(console, 'error', () => {})
  let dead = true
  const stub = makeStubApnsClient(() => (dead ? { status: 400, reason: 'BadDeviceToken' } : { status: 200, reason: null }))
  const { db, alice, pipeline } = await setup(t, { apnsClient: stub, coalesceMs: 1 })
  const deviceId = registerDevice(db, alice.id, 'phone', { token: 'phone-token' })

  await pushOnce(db, pipeline, alice.id)
  assert.equal(tokenOf(db, deviceId).apns_token, null)

  dead = false
  setApnsRegistration(db, deviceId, { apnsToken: 'phone-token', apnsEnv: 'prod' })
  stub.calls.length = 0
  await pushOnce(db, pipeline, alice.id, 'back')

  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].deviceToken, 'phone-token')
  assert.equal(pipeline.counters.sent, 1)
  assert.deepEqual({ ...tokenOf(db, deviceId) }, { apns_token: 'phone-token', apns_env: 'prod' })
})

test('a late dead-token result never prunes a token registered since, and concurrent failures log once', async (t) => {
  const logs = t.mock.method(console, 'error', () => {})
  const pending = []
  const stub = {
    calls: [],
    send(opts) {
      this.calls.push(opts)
      return new Promise((resolve) => pending.push(() => resolve({ status: 410, reason: 'Unregistered' })))
    },
  }
  const { db, alice, pipeline } = await setup(t, { apnsClient: stub })
  const deviceId = registerDevice(db, alice.id, 'phone', { token: 'old-token' })

  // Two attention pushes in flight to the old token at once.
  for (const body of ['one', 'two']) {
    const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'prompt', payload: { body } })
    pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'prompt', payload: { body } }, null)
  }
  assert.equal(stub.calls.length, 2)

  // The first answer prunes; the app then registers a fresh token before the
  // second answer for the old token arrives.
  pending[0]()
  await new Promise((res) => setTimeout(res, 5))
  assert.equal(tokenOf(db, deviceId).apns_token, null)
  setApnsRegistration(db, deviceId, { apnsToken: 'new-token', apnsEnv: 'prod' })
  pending[1]()
  await new Promise((res) => setTimeout(res, 5))

  assert.deepEqual({ ...tokenOf(db, deviceId) }, { apns_token: 'new-token', apns_env: 'prod' })
  assert.equal(pipeline.counters.pruned, 1)
  assert.equal(logs.mock.calls.filter((c) => /pruned/.test(String(c.arguments[0]))).length, 1)
})

test('a late BadDeviceToken from the old environment never prunes the same token re-registered with a corrected environment', async (t) => {
  const logs = t.mock.method(console, 'error', () => {})
  const pending = []
  const stub = {
    calls: [],
    send(opts) {
      this.calls.push(opts)
      return new Promise((resolve) => pending.push(() => resolve({ status: 400, reason: 'BadDeviceToken' })))
    },
  }
  const { db, alice, pipeline } = await setup(t, { apnsClient: stub })
  const deviceId = registerDevice(db, alice.id, 'phone', { token: 'phone-token', env: 'prod' })

  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'prompt', payload: { body: 'one' } })
  pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'prompt', payload: { body: 'one' } }, null)
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].env, 'prod')

  // The app corrects its environment before the prod push's answer arrives.
  setApnsRegistration(db, deviceId, { apnsToken: 'phone-token', apnsEnv: 'sandbox' })
  pending[0]()
  await new Promise((res) => setTimeout(res, 5))

  assert.deepEqual({ ...tokenOf(db, deviceId) }, { apns_token: 'phone-token', apns_env: 'sandbox' })
  assert.equal(pipeline.counters.pruned, 0)
  assert.equal(logs.mock.calls.filter((c) => /pruned/.test(String(c.arguments[0]))).length, 0)
})

test('through the push gateway, a relayed 400 BadDeviceToken prunes the token', async (t) => {
  t.mock.method(console, 'error', () => {})
  const fetchImpl = async () => new Response(JSON.stringify({ status: 400, reason: 'BadDeviceToken' }), { status: 400 })
  const client = makeGatewayClient({ url: 'https://push.example.com', fetchImpl })
  const { db, alice, pipeline } = await setup(t, { apnsClient: client })
  const deviceId = registerDevice(db, alice.id, 'phone', { token: 'a'.repeat(64) })

  await pushOnce(db, pipeline, alice.id)

  assert.deepEqual({ ...tokenOf(db, deviceId) }, { apns_token: null, apns_env: null })
  assert.equal(pipeline.counters.pruned, 1)
})

test('coalescing: two routine events within the window produce one leading push then one trailing push', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t, { coalesceMs: 100 })
  registerDevice(db, alice.id, 'phone')

  const send = (body) => {
    const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body } })
    pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body } }, null)
  }

  send('first') // idle -> leading send
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].payload.aps.alert.body, 'first')

  send('second') // within window -> held
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(stub.calls.length, 1, 'a routine event within the coalescing window must not push immediately')

  await new Promise((res) => setTimeout(res, 130)) // let the trailing timer fire
  assert.equal(stub.calls.length, 2)
  assert.equal(stub.calls[1].payload.aps.alert.body, 'second')
})

test('coalescing: a burst of routine events within the window collapses to exactly one trailing push (latest wins)', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t, { coalesceMs: 100 })
  registerDevice(db, alice.id, 'phone')
  const send = (body) => {
    const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body } })
    pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body } }, null)
  }
  send('e1')
  await new Promise((res) => setTimeout(res, 5))
  send('e2'); send('e3'); send('e4')
  await new Promise((res) => setTimeout(res, 150))
  assert.equal(stub.calls.length, 2)
  assert.equal(stub.calls[0].payload.aps.alert.body, 'e1')
  assert.equal(stub.calls[1].payload.aps.alert.body, 'e4')
})

test('coalescing state is evicted once a (device, convo) pair goes idle', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t, { coalesceMs: 40 })
  registerDevice(db, alice.id, 'phone')
  const send = (body) => {
    const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body } })
    pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body } }, null)
  }

  send('first')
  assert.equal(pipeline._coalesceState.size, 1, 'a leading send should latch coalescing state for its window')

  // Once the window elapses with nothing pending, the entry must be evicted —
  // otherwise every (device, convo) pair ever pushed to accumulates forever.
  await new Promise((res) => setTimeout(res, 120))
  assert.equal(pipeline._coalesceState.size, 0, 'idle coalescing entries must be evicted, not retained forever')

  // A later event on the same pair behaves like a fresh idle pair: immediate
  // leading push again.
  send('after idle')
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(stub.calls.length, 2)
  assert.equal(stub.calls[1].payload.aps.alert.body, 'after idle')
})

test('coalesced/deferred pushes compute the badge at SEND time, not at the time the push was scheduled (avoids a stale badge)', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t, { coalesceMs: 60 })
  registerDevice(db, alice.id, 'phone')

  const send = (body) => {
    const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body } })
    pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body } }, null)
    return r
  }

  send('first') // idle -> leading send, badge should be 1 (one unread event so far)
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].payload.aps.badge, 1)

  send('second') // within window -> held as the pending trailing build (badge was 2 at this point)
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(stub.calls.length, 1, 'still just the leading send so far')

  // More unread activity arrives BEFORE the trailing push actually fires.
  // The trailing push (built back when the badge was 2) must report the
  // CURRENT badge (3) at the moment it is transmitted, not the value that
  // was true when it was scheduled/built.
  append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'third, arrives before trailing fires' } })

  await new Promise((res) => setTimeout(res, 90)) // let the trailing timer fire
  assert.equal(stub.calls.length, 2)
  assert.equal(stub.calls[1].payload.aps.badge, 3, 'trailing push must report the badge as of send time, not schedule/build time')
})

test('read_marker triggers a background badge-clearing push to other devices, never back to the originating device', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t)
  const originDeviceId = registerDevice(db, alice.id, 'origin-phone')
  const otherDeviceId = registerDevice(db, alice.id, 'other-laptop')

  const r = append(db, {
    userId: alice.id, convoId: 'c1', sender: 'user:alice', type: 'read_marker',
    payload: { convo_id: 'c1', up_to_seq: 0 },
  })
  pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'user:alice', type: 'read_marker', payload: { convo_id: 'c1', up_to_seq: 0 } }, originDeviceId)
  await new Promise((res) => setImmediate(res))

  assert.equal(stub.calls.length, 1)
  const call = stub.calls[0]
  assert.equal(call.deviceToken, 'other-laptop-token')
  assert.notEqual(call.deviceToken, 'origin-phone-token')
  assert.equal(call.pushType, 'background')
  assert.equal(call.priority, 5)
  assert.equal(call.payload.aps['content-available'], 1)
  assert.equal(call.payload.aps.alert, undefined)
  void otherDeviceId
})

test('a device with a legacy apns_token but no apns_env (pre-migration row) is skipped, not crashed on', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t)
  // Simulate a live-DB row from before this feature's migration: apns_token
  // was already being written, apns_env did not exist yet.
  const legacy = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at, apns_token) VALUES(?,'client','legacy',?,?, 'legacy-token')")
    .run(alice.id, 'legacy-hash', Date.now())
  void legacy
  registerDevice(db, alice.id, 'modern-phone')

  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi' } })
  assert.doesNotThrow(() => pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body: 'hi' } }, null))
  await new Promise((res) => setImmediate(res))

  assert.equal(stub.calls.length, 1, 'only the modern, fully-registered device should be pushed to')
  assert.equal(stub.calls[0].deviceToken, 'modern-phone-token')
})

test('read_marker with no other devices pushes nothing (and never throws)', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t)
  const originDeviceId = registerDevice(db, alice.id, 'only-phone')
  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'user:alice', type: 'read_marker', payload: { convo_id: 'c1', up_to_seq: 0 } })
  assert.doesNotThrow(() => pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'user:alice', type: 'read_marker', payload: { convo_id: 'c1', up_to_seq: 0 } }, originDeviceId))
  await new Promise((res) => setImmediate(res))
  assert.equal(stub.calls.length, 0)
})

test('counters track sent and failed pushes', async (t) => {
  let call = 0
  const stub = makeStubApnsClient(() => (call++ % 2 === 0 ? { status: 200 } : { status: 500, reason: 'InternalServerError' }))
  const { db, alice, pipeline } = await setup(t, { apnsClient: stub, coalesceMs: 5 })
  registerDevice(db, alice.id, 'a')
  registerDevice(db, alice.id, 'b')

  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:x', type: 'prompt', payload: { question: '?' } })
  pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:x', type: 'prompt', payload: { question: '?' } }, null)
  await new Promise((res) => setTimeout(res, 10))

  assert.equal(pipeline.counters.sent, 1)
  assert.equal(pipeline.counters.failed, 1)
  assert.equal(pipeline.counters.byReason.InternalServerError, 1)
})

test('a pipeline that throws in onAppend never surfaces an error frame after a successful append', async (t) => {
  const db = openDb(':memory:')
  const hub = makeHub()
  const alice = await createUser(db, 'alice', 'pw')
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id })

  // The publishing agent connection: capture everything sent back to it.
  const agentFrames = []
  const agentConn = {
    ws: { readyState: 1, send: (s) => agentFrames.push(JSON.parse(s)) },
    userId: alice.id, deviceId: 7, kind: 'agent', name: 'box-2', viewingConvoIds: new Set(), registered: true,
  }
  // A second (client) connection registered with the hub, to prove the
  // broadcast itself still went out despite the pipeline blowing up.
  const clientFrames = []
  const clientConn = {
    ws: { readyState: 1, send: (s) => clientFrames.push(JSON.parse(s)) },
    userId: alice.id, deviceId: 8, viewingConvoIds: new Set(),
  }
  hub.register(clientConn)
  t.after(() => hub.unregister(clientConn))

  const throwingPipeline = { onAppend() { throw new Error('pipeline boom') } }
  const mute = t.mock.method(console, 'error', () => {}) // the catch is expected to log

  assert.doesNotThrow(() => handleOp({
    db, hub, conn: agentConn, pushPipeline: throwingPipeline,
    msg: { op: 'publish', convo_id: 'c1', type: 'text', payload: { body: 'still lands' } },
  }))

  // The append landed and was broadcast normally...
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type='text'").get().n, 1)
  assert.equal(clientFrames.filter((f) => f.kind === 'journal' && f.type === 'text').length, 1)
  // ...and the publisher got no spurious error frame for its successful op.
  assert.deepEqual(agentFrames.filter((f) => f.kind === 'control' && f.op === 'error'), [])
  assert.ok(mute.mock.callCount() >= 1, 'the swallowed pipeline error should still be logged')
})

test('end-to-end wiring: real WS ops reach the push pipeline through both ws.js fanOut call sites', async (t) => {
  const stub = makeStubApnsClient()
  const s = await startTestServer({ apnsClient: stub })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const ag = createAgent(s.db, alice.id, 'box-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'phone' } })

  const regPhone = await s.http('/push/register', { method: 'POST', token: login.json.token, body: { apns_token: 'phone-token', environment: 'prod' } })
  assert.equal(regPhone.status, 200)
  // This test's `text` publish below is a routine (activity) event, which
  // is opt-in: turn the user-level switch (notification settings) on, off
  // in both presets.
  assert.equal((await s.http('/notify', { method: 'PUT', token: login.json.token, body: { mode: 'custom', events: { activity: true } } })).status, 200)

  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  // The titled upsert fans out a convo_meta event — which must NOT push (and
  // must not claim the coalescing slot); only the text publish below does.
  agent.send({ op: 'convo_upsert', convo_id: 'wire-1', title: 'wiring test' })
  agent.send({ op: 'publish', convo_id: 'wire-1', type: 'text', payload: { body: 'hello from agent' } })
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'text')
  await new Promise((res) => setTimeout(res, 50))

  // appendAndFan choke point: the agent's publish reached the pipeline and
  // pushed to the registered-but-disconnected phone device — exactly once
  // (the convo_meta from the titled upsert produced no push of its own).
  const publishCalls = stub.calls.filter((c) => c.deviceToken === 'phone-token' && c.payload.aps.alert)
  assert.equal(publishCalls.length, 1)
  assert.equal(publishCalls[0].payload.aps.alert.body, 'hello from agent')
  assert.equal(publishCalls[0].payload.aps.alert.title, 'wiring test')

  // Second device, registered but never connected — read_marker's fanOut
  // call site (which bypasses appendAndFan entirely) must be wired too.
  const login2 = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'laptop' } })
  await s.http('/push/register', { method: 'POST', token: login2.json.token, body: { apns_token: 'laptop-token', environment: 'prod' } })

  const phone = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await phone.waitFor((f) => f.op === 'hello_ok')
  const callsBeforeRead = stub.calls.length
  phone.send({ op: 'read_marker', convo_id: 'wire-1', up_to_seq: null })
  await phone.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker')
  await new Promise((res) => setTimeout(res, 50))

  const laptopBackground = stub.calls.filter((c) => c.deviceToken === 'laptop-token' && c.pushType === 'background')
  assert.equal(laptopBackground.length, 1, 'read_marker fanOut call site does not appear to be wired to the push pipeline')
  const phoneBackground = stub.calls.slice(callsBeforeRead).filter((c) => c.deviceToken === 'phone-token' && c.pushType === 'background')
  assert.equal(phoneBackground.length, 0, 'the originating device must never get a push about its own read_marker')

  agent.close(); phone.close()
})

test('end-to-end wiring: a client "send" (own message, sender user:*) never triggers an alert push to any of the user\'s registered devices', async (t) => {
  const stub = makeStubApnsClient()
  const s = await startTestServer({ apnsClient: stub })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  upsertConversation(s.db, { id: 'wire-2', ownerUserId: alice.id })

  const login1 = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'phone' } })
  await s.http('/push/register', { method: 'POST', token: login1.json.token, body: { apns_token: 'phone-token', environment: 'prod' } })
  const login2 = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'laptop' } })
  await s.http('/push/register', { method: 'POST', token: login2.json.token, body: { apns_token: 'laptop-token', environment: 'prod' } })

  const phone = await makeWsClient(s.base, { token: login1.json.token, cursor: null })
  await phone.waitFor((f) => f.op === 'hello_ok')
  phone.send({ op: 'send', convo_id: 'wire-2', payload: { body: 'hello from myself' } })
  await phone.waitFor((f) => f.kind === 'journal' && f.type === 'text')
  await new Promise((res) => setTimeout(res, 60))

  const alerts = stub.calls.filter((c) => c.payload.aps.alert)
  assert.equal(alerts.length, 0, 'a user\'s own "send" must not alert-push any device, including their own other ones')
  phone.close()
})

test('category threading: classify kind reaches apnsClient.send as opts.category', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t, { coalesceMs: 50 })
  const deviceId = registerDevice(db, alice.id, 'phone')

  const send = (type, payload, hint) => {
    const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type, payload })
    pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type, payload }, null, hint)
    return r
  }

  send('prompt', { question: 'go?' })                 // attention
  send('permission_request', { description: 'write' }) // attention
  send('session_status', { state: 'done' }, { prevSessionState: 'running' }) // done (turn finished)
  send('text', { body: 'hi' })                          // activity (leading send)
  await new Promise((res) => setImmediate(res))
  assert.deepEqual(stub.calls.map((c) => c.category), ['attention', 'attention', 'done', 'activity'])

  // read_marker background push carries category 'wake'. It must come from a
  // DIFFERENT device so origin-device exclusion doesn't eat it.
  const other = registerDevice(db, alice.id, 'ipad')
  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'user:alice', type: 'read_marker', payload: { convo_id: 'c1', up_to_seq: 1 } })
  pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'user:alice', type: 'read_marker', payload: { convo_id: 'c1', up_to_seq: 1 } }, other)
  await new Promise((res) => setImmediate(res))
  const wake = stub.calls[stub.calls.length - 1]
  assert.equal(wake.category, 'wake')
  assert.equal(wake.pushType, 'background')
})

test('a device\'s retired per-device prefs are ignored: the synced settings decide', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t)
  registerDevice(db, alice.id, 'phone')
  registerDevice(db, alice.id, 'ipad', { token: 'ipad-token' })
  // A row written by the old PUT /push/prefs, muting everything.
  db.prepare("UPDATE devices SET push_prefs='{\"attention\":false,\"done\":false,\"activity\":false}' WHERE name='phone'").run()

  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'prompt', payload: { question: 'go?' } })
  pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'prompt', payload: { question: 'go?' } }, null)
  await new Promise((res) => setImmediate(res))
  assert.deepEqual(stub.calls.map((c) => c.deviceToken).sort(), ['ipad-token', 'phone-token'])
})

test('a device follows the user\'s synced switches (default: activity off), attention/done still send', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t, { coalesceMs: 50 })
  registerDevice(db, alice.id, 'phone')
  // Back to the user defaults (no Coordinator set, so they behave as
  // every-session: activity off, turns on).
  db.prepare('UPDATE user_settings SET notify_prefs=NULL WHERE user_id=?').run(alice.id)

  const fire = (type, payload, hint) => {
    const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type, payload })
    pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type, payload }, null, hint)
  }

  // activity: default off. Long enough for both an immediate AND a would-be
  // trailing coalesced push.
  fire('text', { body: 'routine update' })
  await new Promise((res) => setTimeout(res, 80))
  assert.equal(stub.calls.length, 0, 'a device must not get routine activity pushes by default')

  // attention: default on.
  fire('prompt', { question: 'go?' })
  await new Promise((res) => setImmediate(res))
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].category, 'attention')

  // done: default on.
  fire('session_status', { state: 'done' }, { prevSessionState: 'running' })
  await new Promise((res) => setImmediate(res))
  assert.equal(stub.calls.length, 2)
  assert.equal(stub.calls[1].category, 'done')
})

test('a push kind unknown to the settings fails OPEN, not silently muted', async (t) => {
  // classify() today only ever returns attention/done/activity, so a real
  // "unknown kind" can't occur through the public onAppend surface — this
  // stubs classify (an injectable seam, see makePushPipeline) to simulate a
  // future category the settings haven't caught up to yet.
  const stubClassify = () => ({ priority: 5, coalesce: false, kind: 'some_future_kind' })
  const db = openDb(':memory:')
  const hub = makeHub()
  const alice = await createUser(db, 'alice', 'pw')
  const stub = makeStubApnsClient()
  const pipeline = makePushPipeline({ db, hub, apnsClient: stub, classify: stubClassify })
  t.after(() => pipeline.close())
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id })
  registerDevice(db, alice.id, 'phone')

  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi' } })
  pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body: 'hi' } }, null)
  await new Promise((res) => setImmediate(res))
  assert.equal(stub.calls.length, 1, 'an unknown kind must fail open, not be silently filtered')
  assert.equal(stub.calls[0].category, 'some_future_kind')
})

test('session_status pushes on the turn-finished TRANSITION, not the state alone', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t, { coalesceMs: 30 })
  registerDevice(db, alice.id, 'phone')

  const fire = (state, prevSessionState) => {
    const payload = { state }
    const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'session_status', payload })
    pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'session_status', payload },
      null, { prevSessionState })
  }

  // running -> waiting: the agent finished its turn — push, kind 'done',
  // with the fixed turn-finished body (matches the relay's 'done' string).
  fire('waiting', 'running')
  await new Promise((res) => setImmediate(res))
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].category, 'done')
  assert.equal(stub.calls[0].priority, 10)
  assert.equal(stub.calls[0].payload.aps.alert.body, 'Turn finished')

  // running -> done (crash/stop mid-work): also a turn ending — push.
  fire('done', 'running')
  await new Promise((res) => setImmediate(res))
  assert.equal(stub.calls.length, 2)
  assert.equal(stub.calls[1].category, 'done')

  // Silent transitions: teardown of an already-idle session, a turn
  // starting, an idle no-op, and a brand-new convo's first state.
  fire('done', 'waiting')
  fire('running', 'waiting')
  fire('waiting', 'waiting')
  fire('waiting', undefined)
  await new Promise((res) => setTimeout(res, 60))
  assert.equal(stub.calls.length, 2, 'only turn-finished transitions may push')
})

test('end-to-end wiring: convo_upsert threads the previous session state into the push pipeline', async (t) => {
  const stub = makeStubApnsClient()
  const s = await startTestServer({ apnsClient: stub })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const ag = createAgent(s.db, alice.id, 'box-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'phone' } })
  await s.http('/push/register', { method: 'POST', token: login.json.token, body: { apns_token: 'phone-token', environment: 'prod' } })

  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  const upsert = async (state) => {
    agent.send({ op: 'convo_upsert', convo_id: 'wire-3', session_state: state })
    await agent.waitFor((f) => f.kind === 'journal' && f.type === 'session_status' && f.payload.state === state)
  }

  // Creation (first state 'running') is not a finished turn.
  await upsert('running')
  await new Promise((res) => setTimeout(res, 30))
  assert.equal(stub.calls.filter((c) => c.category === 'done').length, 0)

  // running -> waiting: turn finished, exactly one 'done' push.
  await upsert('waiting')
  await new Promise((res) => setTimeout(res, 30))
  const doneCalls = stub.calls.filter((c) => c.category === 'done')
  assert.equal(doneCalls.length, 1, 'running -> waiting must push through the real convo_upsert path')
  assert.equal(doneCalls[0].payload.aps.alert.body, 'Turn finished')

  // waiting -> done: already-idle teardown, still exactly one.
  await upsert('done')
  await new Promise((res) => setTimeout(res, 30))
  assert.equal(stub.calls.filter((c) => c.category === 'done').length, 1, 'waiting -> done must stay silent')

  agent.close()
})

test('item markers: agent-created question pushes as attention; user-authored, non-awaiting, and reorder markers are silent', async (t) => {
  // Use the same fixture setup as the test above this one: a user, a client
  // device with an apns token, a conversation, and a pipeline with a fake
  // APNs client that records `sent` payloads.
  const { db, hub, pipeline, sent, alice, convoId, clientDevice } = await setupPipeline(t)
  const base = { item_id: 'it_x', num: 1, kind: 'question', title: 'Which auth?', by: 'agent', awaiting: 'user', resolution: null }
  pipeline.onAppend(alice.id, { seq: 10, convo_id: convoId, ts: 1, sender: 'agent:box-2', type: 'item', payload: { ...base, action: 'created' } }, 0)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].payload.aps.alert.body, '❓ #1 Which auth?')
  assert.equal(sent[0].category, 'attention')
  pipeline.onAppend(alice.id, { seq: 11, convo_id: convoId, ts: 2, sender: 'agent:box-2', type: 'item', payload: { ...base, action: 'closed', awaiting: null, resolution: 'answered' } }, 0)
  pipeline.onAppend(alice.id, { seq: 12, convo_id: convoId, ts: 3, sender: 'agent:box-2', type: 'item', payload: { ...base, action: 'reordered', awaiting: 'user' } }, 0)
  // Isolates the `awaiting === 'user'` clause: a `created` marker NOT
  // awaiting the user must stay silent even though `action` alone would
  // otherwise satisfy the rule — deleting the awaiting check would wrongly
  // push this one.
  pipeline.onAppend(alice.id, { seq: 14, convo_id: convoId, ts: 5, sender: 'agent:box-2', type: 'item', payload: { ...base, action: 'created', awaiting: 'agent' } }, 0)
  assert.equal(sent.length, 1, 'created but not awaiting the user must stay silent')
  // Spec alignment (design spec ~:207-210, binding over the original brief):
  // commented/reopened only push when by='agent' — a user-authored comment
  // marker must not re-alert the user about their own words, even when
  // awaiting='user' and the sender label alone (agent:box-2) would not
  // otherwise silence it.
  pipeline.onAppend(alice.id, { seq: 15, convo_id: convoId, ts: 6, sender: 'agent:box-2', type: 'item', payload: { ...base, action: 'commented', by: 'user', awaiting: 'user' } }, 0)
  assert.equal(sent.length, 1, 'a commented marker authored by the user must stay silent even when awaiting the user')
  // An agent-authored reopen that hands the item back to the user does push.
  pipeline.onAppend(alice.id, { seq: 16, convo_id: convoId, ts: 7, sender: 'agent:box-2', type: 'item', payload: { ...base, action: 'reopened', by: 'agent', awaiting: 'user' } }, 0)
  assert.equal(sent.length, 2, 'an agent-reopened marker left awaiting the user must push')
  // The by='agent' guard covers `created` too: an on_behalf_of:'user' create
  // is the item the user just asked for, filed by the agent device (so the
  // user:* sender rule does NOT catch it) — buzzing their pocket about their
  // own request is the self-notification that rule exists to prevent.
  pipeline.onAppend(alice.id, { seq: 17, convo_id: convoId, ts: 8, sender: 'agent:box-2', type: 'item', payload: { ...base, action: 'created', by: 'user', awaiting: 'user' } }, 0)
  assert.equal(sent.length, 2, 'a created marker authored by the user must stay silent even when awaiting the user')
  // 'updated' (a PATCH) is journal-sync material like 'reordered': never a
  // push, however the edit left `awaiting`.
  pipeline.onAppend(alice.id, { seq: 18, convo_id: convoId, ts: 9, sender: 'agent:box-2', type: 'item', payload: { ...base, action: 'updated', by: 'agent', awaiting: 'user' } }, 0)
  assert.equal(sent.length, 2, 'an updated marker must never push')
  // The user-sender rule itself, isolated from origin-device exclusion: a
  // push-worthy marker (created, awaiting user) sent with sender `user:*`
  // must still be silenced by the early user-sender check. Origin device is
  // 0 here — NOT clientDevice.id — so the only device is not excluded by
  // being the event's origin; if the user-sender rule were removed, this
  // event would otherwise push.
  pipeline.onAppend(alice.id, { seq: 13, convo_id: convoId, ts: 4, sender: 'user:alice', type: 'item', payload: { ...base, action: 'created', awaiting: 'user' } }, 0)
  assert.equal(sent.length, 2, 'a user-authored marker must never push, even when action/awaiting alone would qualify')
  void hub; void db; void clientDevice
})

// ---- Background wakes ----------------------------------------------------

async function setupWakes(t, { wakeIntervalMs = 1000, now } = {}) {
  const db = openDb(':memory:')
  const hub = makeHub()
  const alice = await createUser(db, 'alice', 'pw')
  const stub = makeStubApnsClient()
  const pipeline = makePushPipeline({ db, hub, apnsClient: stub, backgroundWakeMs: wakeIntervalMs, now })
  t.after(() => pipeline.close())
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, title: 'convo one' })
  // Nothing alerts: the wake must not depend on the notification settings.
  setNotifyPrefs(db, alice.id, { mode: 'custom', events: Object.fromEntries(NOTIFY_EVENTS.map((k) => [k, false])) })
  const phone = registerDevice(db, alice.id, 'phone')
  const wakes = () => stub.calls.filter((c) => c.pushType === 'background')
  return { db, hub, alice, stub, pipeline, phone, wakes }
}

const textEvent = (seq, sender = 'agent:box-a') => ({ seq, convo_id: 'c1', ts: seq, sender, type: 'text', payload: { body: `m${seq}` } })

test('background wake: a new event wakes a phone with no live socket, silently', async (t) => {
  const { alice, pipeline, stub, wakes } = await setupWakes(t)
  pipeline.onAppend(alice.id, textEvent(1), null)
  assert.equal(wakes().length, 1)
  const wake = wakes()[0]
  assert.equal(wake.priority, 5)
  assert.equal(wake.payload.aps['content-available'], 1)
  assert.equal(wake.payload.aps.alert, undefined)
  assert.equal(wake.collapseId, undefined)
  assert.equal(stub.calls.length, 1, 'the settings turned every alert off')
})

test('background wake: at most one per device per interval', async (t) => {
  let clock = 1000000
  const { alice, pipeline, wakes } = await setupWakes(t, { wakeIntervalMs: 1000, now: () => clock })
  pipeline.onAppend(alice.id, textEvent(1), null)
  pipeline.onAppend(alice.id, textEvent(2), null)
  clock += 999
  pipeline.onAppend(alice.id, textEvent(3), null)
  assert.equal(wakes().length, 1)
  clock += 1
  pipeline.onAppend(alice.id, textEvent(4), null)
  assert.equal(wakes().length, 2)
})

test('background wake: a new token is not held to the old one\'s interval', async (t) => {
  const { db, alice, phone, pipeline, wakes } = await setupWakes(t)
  pipeline.onAppend(alice.id, textEvent(1), null)
  setApnsRegistration(db, phone, { apnsToken: 'reinstalled-token', apnsEnv: 'prod' })
  pipeline.onAppend(alice.id, textEvent(2), null)
  assert.deepEqual(wakes().map((c) => c.deviceToken), ['phone-token', 'reinstalled-token'])
})

test('background wake: a device already connected is not woken', async (t) => {
  const { alice, hub, phone, pipeline, wakes } = await setupWakes(t)
  hub.register(fakeConn({ userId: alice.id, deviceId: phone }))
  pipeline.onAppend(alice.id, textEvent(1), null)
  assert.equal(wakes().length, 0)
})

test('background wake: never for a device the event came from, or one already past it', async (t) => {
  const { db, alice, phone, pipeline, wakes } = await setupWakes(t)
  pipeline.onAppend(alice.id, textEvent(1, 'user:alice'), phone)
  assert.equal(wakes().length, 0)
  db.prepare('UPDATE devices SET cursor=? WHERE id=?').run(5, phone)
  pipeline.onAppend(alice.id, textEvent(5), null)
  assert.equal(wakes().length, 0)
})

test('background wake: a subagent child conversation wakes nobody', async (t) => {
  const { db, alice, pipeline, wakes } = await setupWakes(t)
  upsertConversation(db, { id: 'c1-child', ownerUserId: alice.id, parentConvoId: 'c1' })
  pipeline.onAppend(alice.id, { ...textEvent(1), convo_id: 'c1-child' }, null)
  assert.equal(wakes().length, 0)
})

test('background wake: a read marker\'s own wake counts against the interval', async (t) => {
  const { alice, pipeline, wakes } = await setupWakes(t)
  pipeline.onAppend(alice.id, { seq: 1, convo_id: 'c1', ts: 1, sender: 'user:alice', type: 'read_marker', payload: {} }, null)
  assert.equal(wakes().length, 1)
  pipeline.onAppend(alice.id, textEvent(2), null)
  assert.equal(wakes().length, 1)
})

test('background wake: off unless the pipeline is given an interval', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t)
  setNotifyPrefs(db, alice.id, { mode: 'custom', events: Object.fromEntries(NOTIFY_EVENTS.map((k) => [k, false])) })
  registerDevice(db, alice.id, 'phone')
  pipeline.onAppend(alice.id, textEvent(1), null)
  assert.equal(stub.calls.length, 0)
})

// ---- For-you-only phones (src/sync-scope.js) ------------------------------

test('background wake: a for_you phone is woken by tracker and Coordinator changes only', async (t) => {
  // Each read of the clock is a fresh interval, so pacing never hides a wake.
  let clock = 0
  const { db, alice, phone, pipeline, wakes } = await setupWakes(t, { wakeIntervalMs: 1000, now: () => (clock += 1000) })
  upsertConversation(db, { id: 'coord', ownerUserId: alice.id, title: 'Coordinator' })
  db.prepare("UPDATE devices SET sync_scope='for_you' WHERE id=?").run(phone)
  pipeline.onAppend(alice.id, textEvent(1), null)
  pipeline.onAppend(alice.id, { ...textEvent(2), type: 'convo_meta', payload: { title: 't' } }, null)
  assert.equal(wakes().length, 0, 'conversation content and metadata wake nothing')
  pipeline.onAppend(alice.id, { ...textEvent(3), type: 'item', payload: { item_id: 'it_1', action: 'created' } }, null)
  assert.equal(wakes().length, 1)
  db.prepare("INSERT INTO user_settings(user_id, coordinator_convo_id, updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET coordinator_convo_id=excluded.coordinator_convo_id").run(alice.id, 'coord', 1)
  pipeline.onAppend(alice.id, { ...textEvent(4), convo_id: 'coord' }, null)
  assert.equal(wakes().length, 2)
})

test('background wake: an everything phone is still woken by any event', async (t) => {
  const { alice, pipeline, wakes } = await setupWakes(t)
  pipeline.onAppend(alice.id, textEvent(1), null)
  assert.equal(wakes().length, 1)
})

test('background wake: a for_you phone\'s read-elsewhere wakes are paced like the others', async (t) => {
  let clock = 1000000
  const { db, alice, phone, pipeline, wakes } = await setupWakes(t, { wakeIntervalMs: 1000, now: () => clock })
  db.prepare("UPDATE devices SET sync_scope='for_you' WHERE id=?").run(phone)
  const read = (seq) => ({ seq, convo_id: 'c1', ts: seq, sender: 'user:alice', type: 'read_marker', payload: {} })
  pipeline.onAppend(alice.id, read(1), null)
  pipeline.onAppend(alice.id, read(2), null)
  assert.equal(wakes().length, 1)
  clock += 1000
  pipeline.onAppend(alice.id, read(3), null)
  assert.equal(wakes().length, 2)
})

// --- Sealed notification content (src/push-box.js) ---

function registerKeyedDevice(db, userId, name, pair = RECIPIENT) {
  const id = registerDevice(db, userId, name)
  setApnsRegistration(db, id, { apnsToken: `${name}-token`, apnsEnv: 'prod', pushKey: pair.key })
  return id
}
const opened = (call, pair = RECIPIENT) => JSON.parse(openBox(pair, call.payload.box))

test('a device with a key gets its content sealed: fixed visible text, the real text only in the box', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t)
  registerKeyedDevice(db, alice.id, 'phone')
  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'prompt', payload: { question: 'deploy to production?' } })
  pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'prompt', payload: { question: 'deploy to production?' } }, null)
  assert.equal(stub.calls.length, 1)
  const { payload, collapseId, category } = stub.calls[0]
  assert.deepEqual(payload.aps.alert, { title: 'Matron', body: 'Your agent needs you' })
  assert.equal(payload.aps['mutable-content'], 1)
  assert.equal(payload.aps['thread-id'], 'c1')
  assert.equal(collapseId, 'c1')
  assert.equal(category, 'attention')
  const { box, ...clear } = payload
  assert.ok(!JSON.stringify(clear).includes('deploy'), 'the question is nowhere outside the box')
  assert.ok(!JSON.stringify(clear).includes('convo one'), 'nor is the conversation name')
  assert.deepEqual(opened(stub.calls[0]), { v: 1, title: 'convo one', body: '? deploy to production?', convo_id: 'c1', seq: r.seq, kind: 'attention' })
})

test('a device without a key is pushed exactly as before', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t)
  registerDevice(db, alice.id, 'old-phone')
  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'prompt', payload: { question: 'go?' } })
  pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'prompt', payload: { question: 'go?' } }, null)
  assert.deepEqual(stub.calls[0].payload, { aps: { alert: { title: 'convo one', body: '? go?' }, 'thread-id': 'c1', badge: stub.calls[0].payload.aps.badge }, seq: r.seq })
  assert.equal(stub.calls[0].collapseId, 'c1')
})

test('each device gets a box only its own key opens', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t)
  const other = keyPairFrom('second phone')
  registerKeyedDevice(db, alice.id, 'phone')
  registerKeyedDevice(db, alice.id, 'tablet', other)
  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'prompt', payload: { question: 'go?' } })
  pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'prompt', payload: { question: 'go?' } }, null)
  const byToken = Object.fromEntries(stub.calls.map((c) => [c.deviceToken, c]))
  assert.equal(opened(byToken['phone-token']).body, '? go?')
  assert.equal(opened(byToken['tablet-token'], other).body, '? go?')
  assert.throws(() => opened(byToken['tablet-token']))
})

test('an item that needs the user reads as the item: title, its text, its buttons, and its own collapse id', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t)
  registerKeyedDevice(db, alice.id, 'phone')
  const { item } = createItem(db, {
    userId: alice.id, kind: 'question', title: 'Ship the release notes?',
    body: 'Two options:\n\n- ship now\n- wait for the screenshots', actions: ['Ship', 'Wait'],
    awaiting: 'user', originConvoId: 'c1', originDeviceId: createAgent(db, alice.id, 'box-a').deviceId, createdBy: 'agent',
  })
  const created = itemMarkerPayload({ item, action: 'created', by: 'agent' })
  pipeline.onAppend(alice.id, { seq: 5, convo_id: 'c1', ts: 1, sender: 'agent:a', type: 'item', payload: created }, null)
  assert.equal(stub.calls[0].collapseId, item.id)
  assert.equal(stub.calls[0].payload.aps['thread-id'], 'c1')
  assert.deepEqual(opened(stub.calls[0]), {
    v: 1, title: 'Ship the release notes?', subtitle: 'Question · convo one',
    body: 'Two options: - ship now - wait for the screenshots',
    convo_id: 'c1', seq: 5, kind: 'attention',
    item: { id: item.id, num: item.num, kind: 'question', actions: ['Ship', 'Wait'] },
  })

  // A follow-up that asks its own question: the comment's text and buttons,
  // answered against that comment.
  const comment = { id: 'ic_1', body: 'Screenshots are in. Ship now?', actions: ['Yes', 'No'], attachments: [] }
  pipeline.onAppend(alice.id, { seq: 6, convo_id: 'c1', ts: 2, sender: 'agent:a', type: 'item', payload: itemMarkerPayload({ item, action: 'commented', by: 'agent', comment }) }, null)
  assert.equal(stub.calls[1].collapseId, item.id, 'the follow-up replaces the item\'s earlier notification')
  const followUp = opened(stub.calls[1])
  assert.equal(followUp.body, 'Screenshots are in. Ship now?')
  assert.deepEqual(followUp.item, { id: item.id, num: item.num, kind: 'question', actions: ['Yes', 'No'], reply_to: 'ic_1' })

  // A plain comment after a button was tapped offers no buttons.
  const tapped = { ...item, chosen_action: 'Ship' }
  pipeline.onAppend(alice.id, { seq: 7, convo_id: 'c1', ts: 3, sender: 'agent:a', type: 'item', payload: itemMarkerPayload({ item: tapped, action: 'commented', by: 'agent', comment: { id: 'ic_2', body: 'Done.', attachments: [] } }) }, null)
  assert.deepEqual(opened(stub.calls[2]).item.actions, [])
})

test('a notice reads as something to read, with its Seen button', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t)
  registerKeyedDevice(db, alice.id, 'phone')
  const { item } = createItem(db, { userId: alice.id, kind: 'notice', title: 'Backup finished', body: 'All 3 volumes verified.', originConvoId: 'c1', originDeviceId: createAgent(db, alice.id, 'box-a').deviceId, createdBy: 'agent' })
  pipeline.onAppend(alice.id, { seq: 5, convo_id: 'c1', ts: 1, sender: 'agent:a', type: 'item', payload: itemMarkerPayload({ item, action: 'created', by: 'agent' }) }, null)
  const content = opened(stub.calls[0])
  assert.equal(content.subtitle, 'To read · convo one')
  assert.equal(content.body, 'All 3 volumes verified.')
  assert.deepEqual(content.item.actions, ['Seen'])
})

test('through the relay client the box is the only content on the wire', async (t) => {
  const bodies = []
  const fetchImpl = async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ status: 200, reason: null }), { status: 200 }) }
  const { db, alice, pipeline } = await setup(t, { apnsClient: makeGatewayClient({ url: 'https://push.matron.chat', fetchImpl }) })
  registerKeyedDevice(db, alice.id, 'phone')
  const { item } = createItem(db, { userId: alice.id, kind: 'question', title: 'Rotate the signing key?', body: 'It expires next week.', awaiting: 'user', originConvoId: 'c1', originDeviceId: createAgent(db, alice.id, 'box-a').deviceId, createdBy: 'agent' })
  pipeline.onAppend(alice.id, { seq: 5, convo_id: 'c1', ts: 1, sender: 'agent:a', type: 'item', payload: itemMarkerPayload({ item, action: 'created', by: 'agent' }) }, null)
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(bodies.length, 1)
  const { box, ...clear } = bodies[0]
  assert.deepEqual(clear, { device_token: 'phone-token', env: 'prod', category: 'attention', priority: 10, push_type: 'alert', badge: clear.badge, thread_id: 'c1', collapse_id: item.id })
  assert.equal(JSON.parse(openBox(RECIPIENT, box)).title, 'Rotate the signing key?')
})

test('registration: the key is replaced each time, and goes with the token', async (t) => {
  const { db, alice } = await setup(t)
  const id = registerKeyedDevice(db, alice.id, 'phone')
  const keyOf = (d) => db.prepare('SELECT push_key FROM devices WHERE id=?').get(d).push_key
  assert.equal(keyOf(id), RECIPIENT.key)
  setApnsRegistration(db, id, { apnsToken: 'phone-token', apnsEnv: 'prod' })
  assert.equal(keyOf(id), null, 'registering again without a key ends content')
  setApnsRegistration(db, id, { apnsToken: 'phone-token', apnsEnv: 'prod', pushKey: RECIPIENT.key })
  const second = registerDevice(db, alice.id, 'repaired', { token: 'phone-token' })
  assert.equal(keyOf(id), null, 'a claimed token takes the old row\'s key with it')
  assert.equal(keyOf(second), null)
  setApnsRegistration(db, second, { apnsToken: 'phone-token', apnsEnv: 'prod', pushKey: RECIPIENT.key })
  setApnsRegistration(db, second, { apnsToken: null, apnsEnv: null, pushKey: RECIPIENT.key })
  assert.equal(keyOf(second), null, 'no key without a token')
})

test('a keyed device whose box cannot be made gets the fixed text alone, never its content in the clear', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t)
  const id = registerDevice(db, alice.id, 'phone')
  // A low-order point: shaped like a key, but the seal refuses it.
  setApnsRegistration(db, id, { apnsToken: 'phone-token', apnsEnv: 'prod', pushKey: Buffer.alloc(32).toString('base64url') })
  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'prompt', payload: { question: 'deploy to production?' } })
  t.mock.method(console, 'error', () => {})
  pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'prompt', payload: { question: 'deploy to production?' } }, null)
  assert.equal(stub.calls.length, 1)
  assert.deepEqual(stub.calls[0].payload.aps.alert, { title: 'Matron', body: 'Your agent needs you' })
  assert.equal('box' in stub.calls[0].payload, false)
  assert.ok(!JSON.stringify(stub.calls[0].payload).includes('deploy'))
})

test('a push that waited out a coalescing window is sealed to the key registered by then', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t, { coalesceMs: 30 })
  const id = registerKeyedDevice(db, alice.id, 'phone')
  const later = keyPairFrom('re-registered')
  const text = (n) => {
    const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: `message ${n}` } })
    pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body: `message ${n}` } }, null)
  }
  text(1)
  text(2)
  setApnsRegistration(db, id, { apnsToken: 'phone-token', apnsEnv: 'prod', pushKey: later.key })
  await new Promise((res) => setTimeout(res, 80))
  assert.equal(stub.calls.length, 2)
  assert.equal(opened(stub.calls[0]).body, 'message 1')
  assert.equal(opened(stub.calls[1], later).body, 'message 2')
})

test('a keyed device whose token moved on while a push waited is not sent content in the clear', async (t) => {
  const { db, alice, stub, pipeline } = await setup(t, { coalesceMs: 30 })
  const id = registerKeyedDevice(db, alice.id, 'phone')
  const text = (n) => {
    const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: `message ${n}` } })
    pipeline.onAppend(alice.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body: `message ${n}` } }, null)
  }
  text(1)
  text(2)
  setApnsRegistration(db, id, { apnsToken: 'new-token', apnsEnv: 'prod', pushKey: RECIPIENT.key })
  await new Promise((res) => setTimeout(res, 80))
  assert.equal(stub.calls.length, 2)
  assert.deepEqual(stub.calls[1].payload.aps.alert, { title: 'Matron', body: 'New activity from your agent' })
  assert.equal('box' in stub.calls[1].payload, false)
  assert.ok(!JSON.stringify(stub.calls[1].payload).includes('message 2'))
})
