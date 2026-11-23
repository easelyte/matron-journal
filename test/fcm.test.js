import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeFcmClient, parseServiceAccount, readServiceAccount, fcmConfigFromEnv, fcmErrorReason } from '../src/fcm.js'
import { resolveFcmClient } from '../src/server.js'

// One RSA key for the whole file: generating one per test is slow.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' })

function accountJson(tokenUri, extra = {}) {
  return {
    type: 'service_account', project_id: 'demo-project', private_key_id: 'kid-1',
    private_key: PEM, client_email: 'push@demo-project.example.com', token_uri: tokenUri, ...extra,
  }
}

// A fake of Google's token endpoint and FCM's send endpoint on one local
// server. `onToken` and `onSend` answer each request; every request is
// recorded with its parsed body.
async function fakeGoogle(t, { onToken, onSend } = {}) {
  const tokens = []
  const sends = []
  let minted = 0
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const reply = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.url === '/token') {
        const form = Object.fromEntries(new URLSearchParams(raw))
        tokens.push({ headers: req.headers, form })
        const answer = onToken?.(form, tokens.length)
        if (answer) return reply(answer.status, answer.body)
        minted += 1
        return reply(200, { access_token: `access-${minted}`, expires_in: 3599, token_type: 'Bearer' })
      }
      const send = { url: req.url, headers: req.headers, body: JSON.parse(raw) }
      sends.push(send)
      const answer = onSend?.(send, sends.length)
      if (answer === 'drop') return req.socket.destroy()
      if (answer) return reply(answer.status, answer.body)
      return reply(200, { name: `projects/demo-project/messages/${sends.length}` })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, tokens, sends, tokenUri: `${base}/token` }
}

function client(fake, opts = {}) {
  return makeFcmClient({ serviceAccount: parseServiceAccount(accountJson(fake.tokenUri)), apiBase: fake.base, ...opts })
}

const DATA = { type: 'alert', convo_id: 'c1', seq: '7', kind: 'attention', box: 'b'.repeat(80), badge: '2' }

test('mints an RS256 service-account assertion and sends a data-only, high-priority message', async (t) => {
  const fake = await fakeGoogle(t)
  const fcm = client(fake)
  const result = await fcm.send({ token: 'device-token-alice-0001', data: DATA, priority: 'high', ttlSeconds: 86400 })
  assert.deepEqual(result, { status: 200, reason: null })

  assert.equal(fake.tokens.length, 1)
  const { form } = fake.tokens[0]
  assert.equal(form.grant_type, 'urn:ietf:params:oauth:grant-type:jwt-bearer')
  const [h, c, sig] = form.assertion.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT', kid: 'kid-1' })
  const claims = JSON.parse(Buffer.from(c, 'base64url'))
  assert.equal(claims.iss, 'push@demo-project.example.com')
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging')
  assert.equal(claims.aud, fake.tokenUri)
  assert.equal(claims.exp - claims.iat, 3600)
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url')))

  assert.equal(fake.sends.length, 1)
  const send = fake.sends[0]
  assert.equal(send.url, '/v1/projects/demo-project/messages:send')
  assert.equal(send.headers.authorization, 'Bearer access-1')
  assert.deepEqual(send.body, {
    message: { token: 'device-token-alice-0001', data: DATA, android: { priority: 'HIGH', ttl: '86400s' } },
  })
  // Data only: no `notification` block, so the app draws every notification.
  assert.equal(send.body.message.notification, undefined)
})

test('the access token is cached until shortly before it expires, and concurrent sends share one mint', async (t) => {
  const fake = await fakeGoogle(t)
  let clock = 1_000_000
  const fcm = client(fake, { now: () => clock })
  await Promise.all([1, 2, 3].map(() => fcm.send({ token: 'device-token-alice-0001', data: DATA })))
  assert.equal(fake.tokens.length, 1)
  clock += 50 * 60 * 1000 // inside the hour, before the five-minute margin
  await fcm.send({ token: 'device-token-alice-0001', data: DATA })
  assert.equal(fake.tokens.length, 1)
  clock += 6 * 60 * 1000 // past expires_in minus the margin
  await fcm.send({ token: 'device-token-alice-0001', data: DATA })
  assert.equal(fake.tokens.length, 2)
  assert.equal(fake.sends.at(-1).headers.authorization, 'Bearer access-2')
})

test('normal priority, collapse key and project id override', async (t) => {
  const fake = await fakeGoogle(t)
  const fcm = makeFcmClient({ serviceAccount: parseServiceAccount(accountJson(fake.tokenUri)), projectId: 'other-project', apiBase: fake.base })
  await fcm.send({ token: 'device-token-alice-0001', data: { type: 'read', convo_id: 'c1' }, priority: 'normal', ttlSeconds: 3600, collapseKey: 'read:c1' })
  assert.equal(fake.sends[0].url, '/v1/projects/other-project/messages:send')
  assert.deepEqual(fake.sends[0].body.message.android, { priority: 'NORMAL', ttl: '3600s', collapse_key: 'read:c1' })
})

test('an UNREGISTERED answer reaches the caller with its error code', async (t) => {
  const fake = await fakeGoogle(t, {
    onSend: () => ({ status: 404, body: { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND',
      details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } } }),
  })
  assert.deepEqual(await client(fake).send({ token: 'device-token-alice-0001', data: DATA }), { status: 404, reason: 'UNREGISTERED' })
  assert.equal(fake.sends.length, 1)
})

test('error reasons: the FcmError code first, then the rpc status, else null', () => {
  assert.equal(fcmErrorReason({ error: { status: 'INVALID_ARGUMENT', details: [{ errorCode: 'SENDER_ID_MISMATCH' }] } }), 'SENDER_ID_MISMATCH')
  assert.equal(fcmErrorReason({ error: { status: 'UNAVAILABLE' } }), 'UNAVAILABLE')
  assert.equal(fcmErrorReason({ nope: 1 }), null)
  assert.equal(fcmErrorReason(null), null)
})

test('a 401 drops the cached token and retries once with a fresh one', async (t) => {
  const fake = await fakeGoogle(t, {
    onSend: (send) => (send.headers.authorization === 'Bearer access-1' ? { status: 401, body: { error: { status: 'UNAUTHENTICATED' } } } : null),
  })
  const result = await client(fake).send({ token: 'device-token-alice-0001', data: DATA })
  assert.deepEqual(result, { status: 200, reason: null })
  assert.equal(fake.tokens.length, 2)
  assert.equal(fake.sends.length, 2)
})

test('a dropped connection is retried once, and only once', async (t) => {
  const once = await fakeGoogle(t, { onSend: (_s, n) => (n === 1 ? 'drop' : null) })
  assert.deepEqual(await client(once).send({ token: 'device-token-alice-0001', data: DATA }), { status: 200, reason: null })
  assert.equal(once.sends.length, 2)

  const always = await fakeGoogle(t, { onSend: () => 'drop' })
  assert.deepEqual(await client(always).send({ token: 'device-token-alice-0001', data: DATA }), { status: 0, reason: 'transport' })
  assert.equal(always.sends.length, 2)
})

test('an unreachable token endpoint is a transport failure: retried once, with no back-off', async (t) => {
  const fake = await fakeGoogle(t)
  let tokenCalls = 0
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/token')) {
      tokenCalls += 1
      if (tokenCalls === 1) throw new TypeError('fetch failed')
    }
    return fetch(url, init)
  }
  const original = console.error
  console.error = () => {}
  t.after(() => { console.error = original })
  const fcm = client(fake, { fetchImpl })
  assert.deepEqual(await fcm.send({ token: 'device-token-alice-0001', data: DATA }), { status: 200, reason: null })
  assert.equal(tokenCalls, 2)
})

test('a body that breaks after the headers is a transport failure, not a refused key', async (t) => {
  const fake = await fakeGoogle(t)
  let tokenCalls = 0
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/token') && ++tokenCalls === 1) {
      return { status: 200, text: async () => { throw new TypeError('terminated') } }
    }
    return fetch(url, init)
  }
  const original = console.error
  console.error = () => {}
  t.after(() => { console.error = original })
  const fcm = client(fake, { fetchImpl })
  assert.deepEqual(await fcm.send({ token: 'device-token-alice-0001', data: DATA }), { status: 200, reason: null })
  assert.equal(tokenCalls, 2)
})

test('a late 401 for an old token does not throw away a newer one', async (t) => {
  let releaseFirst, markFirstArrived
  const firstHeld = new Promise((resolve) => { releaseFirst = resolve })
  const firstArrived = new Promise((resolve) => { markFirstArrived = resolve })
  const fake = await fakeGoogle(t)
  let clock = 1_000_000
  const fetchImpl = async (url, init) => {
    if (String(url).includes('messages:send') && init.headers.authorization === 'Bearer access-1') {
      markFirstArrived()
      await firstHeld
      return { status: 401, text: async () => JSON.stringify({ error: { status: 'UNAUTHENTICATED' } }) }
    }
    return fetch(url, init)
  }
  const fcm = client(fake, { fetchImpl, now: () => clock })
  const first = fcm.send({ token: 'device-token-alice-0001', data: DATA })
  await firstArrived // access-1 is minted and in use before the clock moves
  clock += 60 * 60 * 1000 // access-1 expires; the next send mints access-2
  assert.deepEqual(await fcm.send({ token: 'device-token-alice-0001', data: DATA }), { status: 200, reason: null })
  assert.equal(fake.tokens.length, 2)
  releaseFirst()
  assert.deepEqual(await first, { status: 200, reason: null })
  // The late 401 retried with access-2, still cached: no third mint.
  assert.equal(fake.tokens.length, 2)
})

test('server errors are not retried', async (t) => {
  const fake = await fakeGoogle(t, { onSend: () => ({ status: 503, body: { error: { status: 'UNAVAILABLE' } } }) })
  assert.deepEqual(await client(fake).send({ token: 'device-token-alice-0001', data: DATA }), { status: 503, reason: 'UNAVAILABLE' })
  assert.equal(fake.sends.length, 1)
})

test('a refused service account fails fast for a minute, and the log names no token', async (t) => {
  const fake = await fakeGoogle(t, { onToken: () => ({ status: 400, body: { error: 'invalid_grant' } }) })
  const logged = []
  const original = console.error
  console.error = (...args) => logged.push(args.join(' '))
  t.after(() => { console.error = original })
  let clock = 5_000_000
  const fcm = client(fake, { now: () => clock })
  assert.deepEqual(await fcm.send({ token: 'device-token-alice-0001', data: DATA }), { status: 0, reason: 'auth' })
  assert.deepEqual(await fcm.send({ token: 'device-token-alice-0001', data: DATA }), { status: 0, reason: 'auth' })
  assert.equal(fake.tokens.length, 1)
  assert.equal(fake.sends.length, 0)
  clock += 61 * 1000
  await fcm.send({ token: 'device-token-alice-0001', data: DATA })
  assert.equal(fake.tokens.length, 2)
  assert.ok(logged.some((l) => l.includes('invalid_grant')))
  assert.ok(!logged.some((l) => l.includes('device-token-alice') || l.includes('eyJ')))
})

test('a send that never answers times out', async (t) => {
  const server = http.createServer(() => { /* never answers */ })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)) })
  const fake = await fakeGoogle(t)
  const fcm = makeFcmClient({
    serviceAccount: parseServiceAccount(accountJson(fake.tokenUri)),
    apiBase: `http://127.0.0.1:${server.address().port}`, requestTimeoutMs: 100,
  })
  assert.deepEqual(await fcm.send({ token: 'device-token-alice-0001', data: DATA }), { status: 0, reason: 'timeout' })
})

test('after close() nothing is sent', async (t) => {
  const fake = await fakeGoogle(t)
  const fcm = client(fake)
  fcm.close()
  assert.deepEqual(await fcm.send({ token: 'device-token-alice-0001', data: DATA }), { status: 0, reason: 'closed' })
  assert.equal(fake.sends.length, 0)
})

test('service account parsing refuses what is not a usable key file', () => {
  assert.throws(() => parseServiceAccount({ type: 'authorized_user' }), /service_account/)
  assert.throws(() => parseServiceAccount(accountJson('x', { client_email: '' })), /client_email/)
  assert.throws(() => parseServiceAccount(accountJson('x', { private_key: 'nope' })), /PEM/)
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' })
  assert.throws(() => parseServiceAccount(accountJson('x', { private_key: ec })), /RSA/)
  const parsed = parseServiceAccount(accountJson(undefined))
  assert.equal(parsed.tokenUri, 'https://oauth2.googleapis.com/token')
  assert.equal(parsed.projectId, 'demo-project')
  assert.throws(() => makeFcmClient({ serviceAccount: { ...parsed, projectId: null } }), /project id/)
})

const FCM_VARS = ['MATRON_FCM_SERVICE_ACCOUNT_FILE', 'MATRON_FCM_PROJECT_ID', 'MATRON_FCM_DISABLED']

function withEnv(t, vars) {
  const saved = Object.fromEntries(FCM_VARS.map((k) => [k, process.env[k]]))
  for (const k of FCM_VARS) delete process.env[k]
  Object.assign(process.env, vars)
  t.after(() => {
    for (const k of FCM_VARS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })
}

function writeAccount(t, json) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-fcm-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'service-account.json')
  fs.writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json), { mode: 0o600 })
  return file
}

test('config: absent is off, a key file turns it on, a bad one fails startup', (t) => {
  withEnv(t, {})
  assert.equal(fcmConfigFromEnv(process.env), null)
  assert.deepEqual(resolveFcmClient(undefined), { client: undefined, owned: false })

  const file = writeAccount(t, accountJson('https://oauth2.googleapis.com/token'))
  process.env.MATRON_FCM_SERVICE_ACCOUNT_FILE = file
  const { client: made, owned } = resolveFcmClient(undefined)
  assert.equal(owned, true)
  assert.equal(made.projectId, 'demo-project')
  made.close()
  process.env.MATRON_FCM_PROJECT_ID = 'override'
  assert.equal(fcmConfigFromEnv(process.env).projectId, 'override')

  process.env.MATRON_FCM_DISABLED = '1'
  assert.equal(fcmConfigFromEnv(process.env), null)
  process.env.MATRON_FCM_DISABLED = 'maybe'
  assert.throws(() => fcmConfigFromEnv(process.env), /MATRON_FCM_DISABLED/)
  delete process.env.MATRON_FCM_DISABLED

  process.env.MATRON_FCM_SERVICE_ACCOUNT_FILE = writeAccount(t, 'not json')
  assert.throws(() => fcmConfigFromEnv(process.env), /not readable JSON/)
  assert.throws(() => readServiceAccount(path.join(os.tmpdir(), 'matron-fcm-missing.json')), /not readable JSON/)

  delete process.env.MATRON_FCM_SERVICE_ACCOUNT_FILE
  assert.throws(() => fcmConfigFromEnv(process.env), /MATRON_FCM_PROJECT_ID is set/)
})

test('an injected client always wins', (t) => {
  withEnv(t, {})
  const sentinel = { send: async () => ({ status: 200, reason: null }), close() {} }
  assert.deepEqual(resolveFcmClient(sentinel), { client: sentinel, owned: false })
})
