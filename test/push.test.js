import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, setApnsRegistration } from '../src/db.js'
import { makeHub } from '../src/hub.js'
import { makePushPipeline } from '../src/push.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { handleOp } from '../src/ws.js'
import { startTestServer, makeWsClient } from './helpers.js'

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
// hub.register/isViewing only touch userId/deviceId/viewingConvoId/ws.readyState.
function fakeConn({ userId, deviceId }) {
  return { userId, deviceId, viewingConvoId: null, ws: { readyState: 1 } }
}

async function setup(t, { apnsClient, coalesceMs } = {}) {
  const db = openDb(':memory:')
  const hub = makeHub()
  const dan = await createUser(db, 'dan', 'pw')
  const stub = apnsClient || makeStubApnsClient()
  const pipeline = makePushPipeline({ db, hub, apnsClient: stub, coalesceMs })
  t.after(() => pipeline.close())
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'convo one' })
  return { db, hub, dan, stub, pipeline }
}

function registerDevice(db, userId, name, { token = `${name}-token`, env = 'prod' } = {}) {
  const dev = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client',?,?,?)")
    .run(userId, name, `${name}-hash`, Date.now())
  const deviceId = dev.lastInsertRowid
  setApnsRegistration(db, deviceId, { apnsToken: token, apnsEnv: env })
  return deviceId
}

test('disabled mode (no apnsClient) is inert', async (t) => {
  const db = openDb(':memory:')
  const hub = makeHub()
  const dan = await createUser(db, 'dan', 'pw')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id })
  registerDevice(db, dan.id, 'phone')
  const pipeline = makePushPipeline({ db, hub, apnsClient: undefined })
  t.after(() => pipeline.close())

  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi' } })
  assert.doesNotThrow(() => pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body: 'hi' } }, null))
  assert.equal(pipeline.counters.sent, 0)
})

test('agent devices are never pushed to', async (t) => {
  const { db, dan, stub, pipeline } = await setup(t)
  const agentDeviceId = (await Promise.resolve(createAgent(db, dan.id, 'bridge'))).deviceId
  // Even if an agent device somehow had an apns_token set, kind='client' is
  // what clientDevicesForPush filters on.
  setApnsRegistration(db, agentDeviceId, { apnsToken: 'sneaky-token', apnsEnv: 'prod' })

  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:bridge', type: 'text', payload: { body: 'hi' } })
  pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:bridge', type: 'text', payload: { body: 'hi' } }, null)
  await new Promise((res) => setImmediate(res))
  assert.equal(stub.calls.length, 0)
})

test('type mapping: prompt/permission_request and session_status:done push priority 10, others priority 5', async (t) => {
  const { db, dan, stub, pipeline } = await setup(t, { coalesceMs: 50 })
  registerDevice(db, dan.id, 'phone')

  const send = (type, payload) => {
    const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type, payload })
    pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type, payload }, null)
    return r
  }

  send('prompt', { question: 'go ahead?' })
  send('permission_request', { description: 'write file' })
  send('session_status', { state: 'done' })
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

test('convo_meta and non-done session_status never push at all (no alert, no background)', async (t) => {
  const { db, dan, stub, pipeline } = await setup(t, { coalesceMs: 30 })
  registerDevice(db, dan.id, 'phone')

  const send = (type, payload) => {
    const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type, payload })
    pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type, payload }, null)
  }

  send('convo_meta', { title: 'renamed while you were away' })
  send('session_status', { state: 'running' })
  send('session_status', { state: 'waiting' })
  // Long enough for both an immediate send AND a would-be trailing
  // coalesced push to have fired if these were (wrongly) classified routine.
  await new Promise((res) => setTimeout(res, 80))
  assert.equal(stub.calls.length, 0, 'convo_meta / non-done session_status are journal-sync material, not notifications')

  // ...and they must not have claimed the coalescing slot either: a real
  // routine event right after still gets its immediate leading push.
  send('text', { body: 'actual content' })
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].payload.aps.alert.body, 'actual content')
})

test('a client "send" (sender user:*) never triggers an alert push, not even to the user\'s OTHER devices', async (t) => {
  const { db, dan, stub, pipeline } = await setup(t, { coalesceMs: 30 })
  const originDeviceId = registerDevice(db, dan.id, 'origin-phone')
  const otherDeviceId = registerDevice(db, dan.id, 'other-laptop')

  // A user's own words/actions must not ring ANY of their devices — origin
  // exclusion alone isn't enough here (that only covers the SAME device);
  // classify() must return null for a `user:*` sender outright. (T2)
  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'user:dan', type: 'text', payload: { body: 'my own message' } })
  pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'user:dan', type: 'text', payload: { body: 'my own message' } }, originDeviceId)
  // Long enough for both an immediate AND a would-be trailing coalesced push.
  await new Promise((res) => setTimeout(res, 80))
  assert.equal(stub.calls.length, 0, 'a user\'s own message must not alert-push any of their devices')

  // ...and it must not have claimed the coalescing slot either: a real
  // (agent-sourced) routine event right after still gets its leading push —
  // to BOTH registered devices (two devices, two independent coalescing
  // slots keyed by device id).
  const r2 = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'actual content' } })
  pipeline.onAppend(dan.id, { seq: r2.seq, convo_id: 'c1', ts: r2.ts, sender: 'agent:a', type: 'text', payload: { body: 'actual content' } }, null)
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(stub.calls.length, 2)
  assert.ok(stub.calls.every((c) => c.payload.aps.alert.body === 'actual content'))
  assert.deepEqual(stub.calls.map((c) => c.deviceToken).sort(), ['origin-phone-token', 'other-laptop-token'].sort())
  void otherDeviceId
})

test('origin-device exclusion applies to every push type, not just read_marker (defensive: a push recipient device that is also the event\'s origin is skipped)', async (t) => {
  const { db, dan, stub, pipeline } = await setup(t)
  const originDeviceId = registerDevice(db, dan.id, 'origin-phone')
  const otherDeviceId = registerDevice(db, dan.id, 'other-laptop')

  // Hand-crafted: an alert-classified, agent-sourced event (so it's not
  // suppressed by the user:* rule) whose originDeviceId happens to be a
  // registered client push device. In practice today only read_marker's own
  // device is ever also a push recipient, but the exclusion must hold
  // uniformly for every push type — not asymmetrically special-cased to
  // read_marker alone.
  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'prompt', payload: { question: '?' } })
  pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'prompt', payload: { question: '?' } }, originDeviceId)
  await new Promise((res) => setImmediate(res))

  assert.equal(stub.calls.length, 1, 'only the non-origin device should be pushed to')
  assert.equal(stub.calls[0].deviceToken, 'other-laptop-token')
  void otherDeviceId
})

test('alert body: title falls back to convo id, body is the event snippet, badge is the owner unread sum', async (t) => {
  const db = openDb(':memory:')
  const hub = makeHub()
  const dan = await createUser(db, 'dan', 'pw')
  const stub = makeStubApnsClient()
  const pipeline = makePushPipeline({ db, hub, apnsClient: stub })
  t.after(() => pipeline.close())
  upsertConversation(db, { id: 'no-title-convo', ownerUserId: dan.id }) // title stays ''
  upsertConversation(db, { id: 'c2', ownerUserId: dan.id })
  registerDevice(db, dan.id, 'phone')

  append(db, { userId: dan.id, convoId: 'c2', sender: 'agent:a', type: 'text', payload: { body: 'unread elsewhere' } })
  const r = append(db, { userId: dan.id, convoId: 'no-title-convo', sender: 'agent:a', type: 'text', payload: { body: 'hello there, this is the body' } })
  pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'no-title-convo', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body: 'hello there, this is the body' } }, null)
  await new Promise((res) => setImmediate(res))

  assert.equal(stub.calls.length, 1)
  const call = stub.calls[0]
  assert.equal(call.payload.aps.alert.title, 'no-title-convo')
  assert.equal(call.payload.aps.alert.body, 'hello there, this is the body')
  assert.equal(call.payload.aps['thread-id'], 'no-title-convo')
  // both convos now have unread_count 1 (both messages from an agent sender)
  assert.equal(call.payload.aps.badge, 2)
})

test('viewing suppression: a device connected and viewing the convo is skipped', async (t) => {
  const { db, hub, dan, stub, pipeline } = await setup(t)
  const deviceId = registerDevice(db, dan.id, 'phone')
  const conn = fakeConn({ userId: dan.id, deviceId })
  hub.register(conn)
  conn.viewingConvoId = 'c1'

  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi' } })
  pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body: 'hi' } }, null)
  await new Promise((res) => setImmediate(res))
  assert.equal(stub.calls.length, 0)

  // viewing a different convo: not suppressed
  conn.viewingConvoId = 'somewhere-else'
  const r2 = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi again' } })
  pipeline.onAppend(dan.id, { seq: r2.seq, convo_id: 'c1', ts: r2.ts, sender: 'agent:a', type: 'text', payload: { body: 'hi again' } }, null)
  await new Promise((res) => setImmediate(res))
  assert.equal(stub.calls.length, 1)
})

test('acked-past suppression: a device whose cursor already covers the event seq is skipped', async (t) => {
  const { db, dan, stub, pipeline } = await setup(t)
  const deviceId = registerDevice(db, dan.id, 'phone')

  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi' } })
  db.prepare('UPDATE devices SET cursor=? WHERE id=?').run(r.seq, deviceId) // already acked past
  pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body: 'hi' } }, null)
  await new Promise((res) => setImmediate(res))
  assert.equal(stub.calls.length, 0)

  const r2 = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi2' } })
  pipeline.onAppend(dan.id, { seq: r2.seq, convo_id: 'c1', ts: r2.ts, sender: 'agent:a', type: 'text', payload: { body: 'hi2' } }, null)
  await new Promise((res) => setImmediate(res))
  assert.equal(stub.calls.length, 1, 'a seq beyond the acked cursor must still push')
})

test('a 410 response prunes the device apns_token/apns_env; a 400 keeps it', async (t) => {
  const respond = (opts) => (opts.deviceToken === 'dead-token' ? { status: 410, reason: 'Unregistered' } : { status: 400, reason: 'BadDeviceToken' })
  const stub = makeStubApnsClient(respond)
  const { db, dan, pipeline } = await setup(t, { apnsClient: stub })
  const deadDeviceId = registerDevice(db, dan.id, 'dead-phone', { token: 'dead-token' })
  const wrongEnvDeviceId = registerDevice(db, dan.id, 'wrong-env-phone', { token: 'wrong-env-token' })

  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi' } })
  pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body: 'hi' } }, null)
  await new Promise((res) => setTimeout(res, 10))

  const dead = db.prepare('SELECT apns_token, apns_env FROM devices WHERE id=?').get(deadDeviceId)
  assert.equal(dead.apns_token, null)
  assert.equal(dead.apns_env, null)
  assert.equal(pipeline.counters.pruned, 1)

  const wrongEnv = db.prepare('SELECT apns_token, apns_env FROM devices WHERE id=?').get(wrongEnvDeviceId)
  assert.equal(wrongEnv.apns_token, 'wrong-env-token')
  assert.equal(wrongEnv.apns_env, 'prod')
  assert.equal(pipeline.counters.failed, 2)
})

test('coalescing: two routine events within the window produce one leading push then one trailing push', async (t) => {
  const { db, dan, stub, pipeline } = await setup(t, { coalesceMs: 100 })
  registerDevice(db, dan.id, 'phone')

  const send = (body) => {
    const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body } })
    pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body } }, null)
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
  const { db, dan, stub, pipeline } = await setup(t, { coalesceMs: 100 })
  registerDevice(db, dan.id, 'phone')
  const send = (body) => {
    const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body } })
    pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body } }, null)
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
  const { db, dan, stub, pipeline } = await setup(t, { coalesceMs: 40 })
  registerDevice(db, dan.id, 'phone')
  const send = (body) => {
    const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body } })
    pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body } }, null)
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
  const { db, dan, stub, pipeline } = await setup(t, { coalesceMs: 60 })
  registerDevice(db, dan.id, 'phone')

  const send = (body) => {
    const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body } })
    pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body } }, null)
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
  append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'third, arrives before trailing fires' } })

  await new Promise((res) => setTimeout(res, 90)) // let the trailing timer fire
  assert.equal(stub.calls.length, 2)
  assert.equal(stub.calls[1].payload.aps.badge, 3, 'trailing push must report the badge as of send time, not schedule/build time')
})

test('read_marker triggers a background badge-clearing push to other devices, never back to the originating device', async (t) => {
  const { db, dan, stub, pipeline } = await setup(t)
  const originDeviceId = registerDevice(db, dan.id, 'origin-phone')
  const otherDeviceId = registerDevice(db, dan.id, 'other-laptop')

  const r = append(db, {
    userId: dan.id, convoId: 'c1', sender: 'user:dan', type: 'read_marker',
    payload: { convo_id: 'c1', up_to_seq: 0 },
  })
  pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'user:dan', type: 'read_marker', payload: { convo_id: 'c1', up_to_seq: 0 } }, originDeviceId)
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
  const { db, dan, stub, pipeline } = await setup(t)
  // Simulate a live-DB row from before this feature's migration: apns_token
  // was already being written, apns_env did not exist yet.
  const legacy = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at, apns_token) VALUES(?,'client','legacy',?,?, 'legacy-token')")
    .run(dan.id, 'legacy-hash', Date.now())
  void legacy
  registerDevice(db, dan.id, 'modern-phone')

  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi' } })
  assert.doesNotThrow(() => pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body: 'hi' } }, null))
  await new Promise((res) => setImmediate(res))

  assert.equal(stub.calls.length, 1, 'only the modern, fully-registered device should be pushed to')
  assert.equal(stub.calls[0].deviceToken, 'modern-phone-token')
})

test('read_marker with no other devices pushes nothing (and never throws)', async (t) => {
  const { db, dan, stub, pipeline } = await setup(t)
  const originDeviceId = registerDevice(db, dan.id, 'only-phone')
  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'user:dan', type: 'read_marker', payload: { convo_id: 'c1', up_to_seq: 0 } })
  assert.doesNotThrow(() => pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'user:dan', type: 'read_marker', payload: { convo_id: 'c1', up_to_seq: 0 } }, originDeviceId))
  await new Promise((res) => setImmediate(res))
  assert.equal(stub.calls.length, 0)
})

test('counters track sent and failed pushes', async (t) => {
  let call = 0
  const stub = makeStubApnsClient(() => (call++ % 2 === 0 ? { status: 200 } : { status: 500, reason: 'InternalServerError' }))
  const { db, dan, pipeline } = await setup(t, { apnsClient: stub, coalesceMs: 5 })
  registerDevice(db, dan.id, 'a')
  registerDevice(db, dan.id, 'b')

  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:x', type: 'prompt', payload: { question: '?' } })
  pipeline.onAppend(dan.id, { seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:x', type: 'prompt', payload: { question: '?' } }, null)
  await new Promise((res) => setTimeout(res, 10))

  assert.equal(pipeline.counters.sent, 1)
  assert.equal(pipeline.counters.failed, 1)
  assert.equal(pipeline.counters.byReason.InternalServerError, 1)
})

test('a pipeline that throws in onAppend never surfaces an error frame after a successful append', async (t) => {
  const db = openDb(':memory:')
  const hub = makeHub()
  const dan = await createUser(db, 'dan', 'pw')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id })

  // The publishing agent connection: capture everything sent back to it.
  const agentFrames = []
  const agentConn = {
    ws: { readyState: 1, send: (s) => agentFrames.push(JSON.parse(s)) },
    userId: dan.id, deviceId: 7, kind: 'agent', name: 'dev-2', viewingConvoId: null, registered: true,
  }
  // A second (client) connection registered with the hub, to prove the
  // broadcast itself still went out despite the pipeline blowing up.
  const clientFrames = []
  const clientConn = {
    ws: { readyState: 1, send: (s) => clientFrames.push(JSON.parse(s)) },
    userId: dan.id, deviceId: 8, viewingConvoId: null,
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
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'phone' } })

  const regPhone = await s.http('/push/register', { method: 'POST', token: login.json.token, body: { apns_token: 'phone-token', environment: 'prod' } })
  assert.equal(regPhone.status, 200)

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
  const login2 = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'laptop' } })
  await s.http('/push/register', { method: 'POST', token: login2.json.token, body: { apns_token: 'laptop-token', environment: 'prod' } })

  const phone = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await phone.waitFor((f) => f.op === 'hello_ok')
  phone.send({ op: 'read_marker', convo_id: 'wire-1', up_to_seq: null })
  await phone.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker')
  await new Promise((res) => setTimeout(res, 50))

  const laptopBackground = stub.calls.filter((c) => c.deviceToken === 'laptop-token' && c.pushType === 'background')
  assert.equal(laptopBackground.length, 1, 'read_marker fanOut call site does not appear to be wired to the push pipeline')
  const phoneBackground = stub.calls.filter((c) => c.deviceToken === 'phone-token' && c.pushType === 'background')
  assert.equal(phoneBackground.length, 0, 'the originating device must never get a push about its own read_marker')

  agent.close(); phone.close()
})

test('end-to-end wiring: a client "send" (own message, sender user:*) never triggers an alert push to any of the user\'s registered devices', async (t) => {
  const stub = makeStubApnsClient()
  const s = await startTestServer({ apnsClient: stub })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  upsertConversation(s.db, { id: 'wire-2', ownerUserId: dan.id })

  const login1 = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'phone' } })
  await s.http('/push/register', { method: 'POST', token: login1.json.token, body: { apns_token: 'phone-token', environment: 'prod' } })
  const login2 = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'laptop' } })
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
