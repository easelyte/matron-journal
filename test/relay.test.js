import test from 'node:test'
import assert from 'node:assert/strict'
import http2 from 'node:http2'
import { startRelay, makeRelayLimiter } from '../src/relay.js'
import { makeApnsClient } from '../src/apns.js'
import { makeTestKey, makeFakeApnsServer } from './apns-helpers.js'

// Stub APNs client (push.test.js pattern): records calls, configurable result.
function makeStubApnsClient(respond = () => ({ status: 200, reason: null })) {
  const calls = []
  return { calls, send: async (opts) => { calls.push(opts); return respond(opts) }, close() {} }
}

async function startTestRelay(t, { apnsClient = makeStubApnsClient(), limiter } = {}) {
  const relay = await startRelay({ apnsClient, port: 0, limiter })
  t.after(() => relay.close())
  const post = async (body, { raw = null } = {}) => {
    const r = await fetch(`http://127.0.0.1:${relay.port}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw !== null ? raw : JSON.stringify(body),
    })
    let j = null
    try { j = await r.json() } catch { /* empty */ }
    return { status: r.status, json: j }
  }
  return { relay, post, stub: apnsClient }
}

const GOOD = {
  device_token: 'ab'.repeat(32),
  env: 'prod',
  category: 'attention',
  badge: 3,
  thread_id: 'convo-1',
  collapse_id: 'convo-1',
  priority: 10,
  push_type: 'alert',
}

test('category → fixed-string payload table, with mutable-content on every alert', async (t) => {
  const { post, stub } = await startTestRelay(t)

  await post(GOOD)
  await post({ ...GOOD, category: 'done' })
  await post({ ...GOOD, category: 'activity' })
  await post({ device_token: GOOD.device_token, env: 'prod', category: 'wake', priority: 5, push_type: 'background', badge: 0 })

  const [attention, done, activity, wake] = stub.calls
  assert.deepEqual(attention.payload.aps.alert, { title: 'Matron', body: 'Your agent needs you' })
  assert.deepEqual(done.payload.aps.alert, { title: 'Matron', body: 'Session finished' })
  assert.deepEqual(activity.payload.aps.alert, { title: 'Matron', body: 'New activity from your agent' })
  for (const call of [attention, done, activity]) {
    assert.equal(call.payload.aps['mutable-content'], 1)
    assert.equal(call.payload.aps['thread-id'], 'convo-1')
    assert.equal(call.payload.aps.badge, 3)
    assert.equal(call.pushType, 'alert')
    assert.equal(call.collapseId, 'convo-1')
  }
  assert.deepEqual(wake.payload.aps, { 'content-available': 1, badge: 0 })
  assert.equal(wake.pushType, 'background')
  assert.equal(wake.deviceToken, GOOD.device_token)
  assert.equal(wake.env, 'prod')
})

test('optional fields really are optional', async (t) => {
  const { post, stub } = await startTestRelay(t)
  const { status } = await post({ device_token: 'cd'.repeat(32), env: 'sandbox', category: 'done', priority: 10, push_type: 'alert' })
  assert.equal(status, 200)
  assert.equal(stub.calls[0].payload.aps.badge, undefined)
  assert.equal(stub.calls[0].payload.aps['thread-id'], undefined)
  assert.equal(stub.calls[0].collapseId, undefined)
})

test('validation 400s: unknown field, bad enum values, category/push_type mismatch, missing required', async (t) => {
  const { post, stub } = await startTestRelay(t)
  const bad = [
    { ...GOOD, title: 'sneaky content' },                 // unknown field — the privacy guarantee
    { ...GOOD, body: 'sneaky content' },                  // unknown field
    { ...GOOD, env: 'production' },                        // bad enum
    { ...GOOD, category: 'urgent' },                       // bad enum
    { ...GOOD, priority: 7 },                              // bad enum
    { ...GOOD, push_type: 'voip' },                        // bad enum
    { ...GOOD, category: 'wake' },                          // wake must be background
    { ...GOOD, push_type: 'background' },                   // attention must be alert
    { ...GOOD, device_token: 'not-hex!' },                  // token shape
    { ...GOOD, badge: -1 },                                 // bad badge
    { ...GOOD, badge: 1.5 },                                // bad badge
    { ...GOOD, thread_id: '' },                             // empty string
    (({ device_token, ...rest }) => rest)(GOOD),            // missing required
  ]
  for (const body of bad) {
    const r = await post(body)
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body).slice(0, 80)}`)
  }
  const nonObject = await post(null, { raw: '[1,2,3]' })
  assert.equal(nonObject.status, 400)
  const notJson = await post(null, { raw: 'not json' })
  assert.equal(notJson.status, 400)
  assert.equal(stub.calls.length, 0, 'nothing invalid may reach APNs')
})

test('body over 1 KB → 413 without touching APNs', async (t) => {
  const { post, stub } = await startTestRelay(t)
  const r = await post(null, { raw: JSON.stringify({ ...GOOD, thread_id: 'x'.repeat(2000) }) })
  assert.equal(r.status, 413)
  assert.equal(stub.calls.length, 0)
})

test('non-POST-/push routes 404', async (t) => {
  const { relay } = await startTestRelay(t)
  const g = await fetch(`http://127.0.0.1:${relay.port}/push`)
  assert.equal(g.status, 404)
  const p = await fetch(`http://127.0.0.1:${relay.port}/`, { method: 'POST', body: '{}' })
  assert.equal(p.status, 404)
})

test('APNs status passthrough: 410 body/status reach the caller for pruning; APNs transport failure → 502', async (t) => {
  const dead = makeStubApnsClient(() => ({ status: 410, reason: 'Unregistered' }))
  const { post } = await startTestRelay(t, { apnsClient: dead })
  const r = await post(GOOD)
  assert.equal(r.status, 410)
  assert.deepEqual(r.json, { status: 410, reason: 'Unregistered' })

  const down = makeStubApnsClient(() => ({ status: 0, reason: 'transport' }))
  const { post: post2 } = await startTestRelay(t, { apnsClient: down })
  const r2 = await post2(GOOD)
  assert.equal(r2.status, 502)
  assert.deepEqual(r2.json, { status: 0, reason: 'transport' })
})

test('rate limit: burst then 429 per token, independent tokens unaffected, refill restores', async (t) => {
  let clock = 0
  const limiter = makeRelayLimiter({ burst: 3, refillMs: 10000, now: () => clock })
  const { post, stub } = await startTestRelay(t, { limiter })

  for (let i = 0; i < 3; i++) assert.equal((await post(GOOD)).status, 200)
  const limited = await post(GOOD)
  assert.equal(limited.status, 429)
  assert.equal(stub.calls.length, 3, 'a rate-limited request must not reach APNs')

  // A different device token has its own bucket.
  assert.equal((await post({ ...GOOD, device_token: 'ef'.repeat(32) })).status, 200)

  // One refill interval restores exactly one send.
  clock += 10000
  assert.equal((await post(GOOD)).status, 200)
  assert.equal((await post(GOOD)).status, 429)
})

test('global ceiling: unique-token spray cannot exceed the global bucket', async (t) => {
  let clock = 0
  const limiter = makeRelayLimiter({ burst: 20, refillMs: 10000, globalBurst: 5, globalRefillMs: 1000, now: () => clock })
  const { post, stub } = await startTestRelay(t, { limiter })

  // 5 distinct tokens, each well under its per-token budget — the global
  // bucket is the only thing that can stop the 6th.
  for (let i = 0; i < 5; i++) {
    const r = await post({ ...GOOD, device_token: String(i).repeat(64) })
    assert.equal(r.status, 200)
  }
  const sprayed = await post({ ...GOOD, device_token: '5'.repeat(64) })
  assert.equal(sprayed.status, 429)
  assert.equal(stub.calls.length, 5, 'a globally limited request must not reach APNs')

  // One global refill interval restores exactly one send.
  clock += 1000
  assert.equal((await post({ ...GOOD, device_token: '6'.repeat(64) })).status, 200)
  assert.equal((await post({ ...GOOD, device_token: '7'.repeat(64) })).status, 429)
})

test('limiter unit: per-token denial does not consume the global budget', () => {
  let clock = 0
  const limiter = makeRelayLimiter({ burst: 1, refillMs: 10000, globalBurst: 2, globalRefillMs: 10000, now: () => clock })
  assert.equal(limiter.allow('aa'), true)
  // Token 'aa' is now empty; hammering it must not drain the global bucket.
  for (let i = 0; i < 10; i++) assert.equal(limiter.allow('aa'), false)
  assert.equal(limiter.allow('bb'), true, 'global budget must still have the 1 remaining send')
  assert.equal(limiter.allow('cc'), false, 'global budget (2) is now spent')
})

test('end-to-end against the fake APNs h2 server: real makeApnsClient, real wire payload', async (t) => {
  const { keyFile } = makeTestKey()
  const { server, port, requests } = await makeFakeApnsServer(() => ({ status: 200 }))
  t.after(() => server.close())
  const apnsClient = makeApnsClient({
    keyFile, keyId: 'KID', teamId: 'TEAM', topic: 'chat.matron.app',
    connect: () => http2.connect(`http://127.0.0.1:${port}`),
  })
  t.after(() => apnsClient.close())
  const { post } = await startTestRelay(t, { apnsClient })

  const r = await post(GOOD)
  assert.equal(r.status, 200)
  assert.equal(requests[0].headers[':path'], `/3/device/${GOOD.device_token}`)
  assert.equal(requests[0].headers['apns-collapse-id'], 'convo-1')
  assert.equal(requests[0].headers['apns-priority'], '10')
  assert.equal(requests[0].headers['apns-push-type'], 'alert')
  assert.deepEqual(requests[0].payload.aps.alert, { title: 'Matron', body: 'Your agent needs you' })
  assert.equal(requests[0].payload.aps['mutable-content'], 1)
})
