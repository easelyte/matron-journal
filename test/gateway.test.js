import test from 'node:test'
import assert from 'node:assert/strict'
import { makeGatewayClient } from '../src/gateway.js'

// fetch stub recording every request; `respond` maps a call to a Response.
function makeFetchStub(respond = () => new Response(JSON.stringify({ status: 200, reason: null }), { status: 200 })) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), init })
    return respond()
  }
  return { calls, fetchImpl }
}

const ALERT_OPTS = {
  deviceToken: 'a'.repeat(64),
  env: 'prod',
  payload: { aps: { alert: { title: 'SECRET TITLE', body: 'SECRET BODY' }, 'thread-id': 'convo-1', badge: 3 } },
  collapseId: 'convo-1',
  priority: 10,
  pushType: 'alert',
  category: 'attention',
}

test('serializes only content-free fields — the alert text never crosses the wire', async () => {
  const { calls, fetchImpl } = makeFetchStub()
  const client = makeGatewayClient({ url: 'https://push.matron.chat', fetchImpl })

  const result = await client.send(ALERT_OPTS)
  assert.deepEqual(result, { status: 200, reason: null })
  assert.equal(calls[0].url, 'https://push.matron.chat/push')
  assert.deepEqual(calls[0].body, {
    device_token: 'a'.repeat(64),
    env: 'prod',
    category: 'attention',
    priority: 10,
    push_type: 'alert',
    badge: 3,
    thread_id: 'convo-1',
    collapse_id: 'convo-1',
  })
  // Belt and braces: no value anywhere in the body contains the alert text.
  assert.ok(!JSON.stringify(calls[0].body).includes('SECRET'))
})

test('background wake serializes without alert-only fields', async () => {
  const { calls, fetchImpl } = makeFetchStub()
  const client = makeGatewayClient({ url: 'https://push.matron.chat', fetchImpl })
  await client.send({
    deviceToken: 'b'.repeat(64), env: 'sandbox',
    payload: { aps: { 'content-available': 1, badge: 0 } },
    priority: 5, pushType: 'background', category: 'wake',
  })
  assert.deepEqual(calls[0].body, {
    device_token: 'b'.repeat(64), env: 'sandbox', category: 'wake',
    priority: 5, push_type: 'background', badge: 0,
  })
})

test('mirrors the relay {status, reason} — a 410 reaches the caller for token pruning', async () => {
  const { fetchImpl } = makeFetchStub(() =>
    new Response(JSON.stringify({ status: 410, reason: 'Unregistered' }), { status: 410 }))
  const client = makeGatewayClient({ url: 'https://push.matron.chat', fetchImpl })
  const result = await client.send(ALERT_OPTS)
  assert.equal(result.status, 410)
  assert.equal(result.reason, 'Unregistered')
})

test('a fetch that rejects resolves {status: 0, reason: "transport"} — never rejects', async () => {
  const client = makeGatewayClient({
    url: 'https://push.matron.chat',
    fetchImpl: async () => { throw new TypeError('fetch failed') },
  })
  const result = await client.send(ALERT_OPTS)
  assert.deepEqual(result, { status: 0, reason: 'transport' })
})

test('a fetch aborted by the timeout resolves {status: 0, reason: "timeout"}', async () => {
  const client = makeGatewayClient({
    url: 'https://push.matron.chat',
    requestTimeoutMs: 20,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason))
    }),
  })

  // The per-request timeout is deliberately unref'd (it must never keep the
  // server process alive), so in a bare test — unlike the real server, whose
  // listen handles keep the loop running — something ref'd has to hold the
  // event loop open long enough for it to fire.
  const keepAlive = setTimeout(() => {}, 5000)
  try {
    const result = await client.send(ALERT_OPTS)
    assert.deepEqual(result, { status: 0, reason: 'timeout' })
  } finally {
    clearTimeout(keepAlive)
  }
})

test('a non-JSON response body still resolves with the HTTP status and reason null', async () => {
  const { fetchImpl } = makeFetchStub(() => new Response('<html>cloudflare error</html>', { status: 502 }))
  const client = makeGatewayClient({ url: 'https://push.matron.chat', fetchImpl })
  const result = await client.send(ALERT_OPTS)
  assert.deepEqual(result, { status: 502, reason: null })
})

test('close() is a no-op that does not throw', () => {
  const client = makeGatewayClient({ url: 'https://push.matron.chat' })
  assert.doesNotThrow(() => client.close())
})

test('category defaults to "activity" when undefined with pushType "alert"', async () => {
  const { calls, fetchImpl } = makeFetchStub()
  const client = makeGatewayClient({ url: 'https://push.matron.chat', fetchImpl })
  await client.send({
    deviceToken: 'a'.repeat(64), env: 'prod',
    payload: { aps: {} },
    priority: 10, pushType: 'alert',
    // category intentionally omitted
  })
  assert.equal(calls[0].body.category, 'activity')
})

test('category defaults to "wake" when undefined with pushType "background"', async () => {
  const { calls, fetchImpl } = makeFetchStub()
  const client = makeGatewayClient({ url: 'https://push.matron.chat', fetchImpl })
  await client.send({
    deviceToken: 'a'.repeat(64), env: 'prod',
    payload: { aps: {} },
    priority: 5, pushType: 'background',
    // category intentionally omitted
  })
  assert.equal(calls[0].body.category, 'wake')
})
