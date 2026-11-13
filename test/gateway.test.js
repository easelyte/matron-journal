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

const BOX = 'b'.repeat(200)
const BOXED_OPTS = { ...ALERT_OPTS, payload: { ...ALERT_OPTS.payload, seq: 9, box: BOX } }

test('box: sealed content is forwarded as given; nothing else from the payload goes with it', async () => {
  const { calls, fetchImpl } = makeFetchStub()
  const client = makeGatewayClient({ url: 'https://push.matron.chat', fetchImpl })
  await client.send(BOXED_OPTS)
  assert.equal(calls[0].body.box, BOX)
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['badge', 'box', 'category', 'collapse_id', 'device_token', 'env', 'priority', 'push_type', 'thread_id'])
  assert.ok(!JSON.stringify(calls[0].body).includes('SECRET'))
})

test('box: a relay that does not know the field still delivers, without it, and is not asked again for a while', async () => {
  let clock = 1000
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    return 'box' in body
      ? new Response(JSON.stringify({ status: 400, reason: 'unknown_field' }), { status: 400 })
      : new Response(JSON.stringify({ status: 200, reason: null }), { status: 200 })
  }
  const client = makeGatewayClient({ url: 'https://push.matron.chat', fetchImpl, boxRetryMs: 500, now: () => clock })
  assert.deepEqual(await client.send(BOXED_OPTS), { status: 200, reason: null })
  assert.deepEqual(calls.map((b) => 'box' in b), [true, false])
  assert.deepEqual(await client.send(BOXED_OPTS), { status: 200, reason: null })
  assert.deepEqual(calls.map((b) => 'box' in b), [true, false, false], 'no second refusal inside the window')
  clock += 500
  await client.send(BOXED_OPTS)
  assert.deepEqual(calls.map((b) => 'box' in b), [true, false, false, true, false], 'tried again once the window has passed')
})

test('box: any other refusal is returned as it is, with no second send', async () => {
  const { calls, fetchImpl } = makeFetchStub(() => new Response(JSON.stringify({ status: 400, reason: 'bad_box' }), { status: 400 }))
  const client = makeGatewayClient({ url: 'https://push.matron.chat', fetchImpl })
  assert.deepEqual(await client.send(BOXED_OPTS), { status: 400, reason: 'bad_box' })
  assert.equal(calls.length, 1)
})

test('box: an older relay whose body limit the box exceeds (413) is treated the same way', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    return 'box' in body
      ? new Response(JSON.stringify({ status: 413, reason: 'too_large' }), { status: 413 })
      : new Response(JSON.stringify({ status: 200, reason: null }), { status: 200 })
  }
  const client = makeGatewayClient({ url: 'https://push.matron.chat', fetchImpl })
  assert.deepEqual(await client.send(BOXED_OPTS), { status: 200, reason: null })
  await client.send(BOXED_OPTS)
  assert.deepEqual(calls.map((b) => 'box' in b), [true, false, false])
})

test('a 413 for a push with no box is returned as it is', async () => {
  const { calls, fetchImpl } = makeFetchStub(() => new Response(JSON.stringify({ status: 413, reason: 'too_large' }), { status: 413 }))
  const client = makeGatewayClient({ url: 'https://push.matron.chat', fetchImpl })
  assert.deepEqual(await client.send(ALERT_OPTS), { status: 413, reason: 'too_large' })
  assert.equal(calls.length, 1)
})
