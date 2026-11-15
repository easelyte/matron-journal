import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encryptPayload, vapidAuthorization, checkEndpoint, isPublicAddress, makeWebPushClient, webPushConfigFromEnv } from '../src/webpush.js'

const vector = JSON.parse(fs.readFileSync(new URL('./fixtures/webpush-rfc8291-vector.json', import.meta.url)))
const decode = (s) => Buffer.from(s, 'base64url')
const endpoint = 'https://push.example.com/send/alice'

function subscription() {
  const ua = crypto.createECDH('prime256v1')
  ua.generateKeys()
  const auth = crypto.randomBytes(16)
  return { ua, auth, p256dh: ua.getPublicKey().toString('base64url') }
}

// Independent receiver: use HKDF from node:crypto, never sender internals.
function decrypt(body, ua, auth) {
  assert.ok(Buffer.isBuffer(body))
  assert.equal(body.readUInt32BE(16), 4096)
  assert.equal(body[20], 65)
  const sender = body.subarray(21, 86)
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), sender])
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ua.computeSecret(sender), auth, info, 32))
  const salt = body.subarray(0, 16)
  const key = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  const cipher = crypto.createDecipheriv('aes-128-gcm', key, nonce)
  cipher.setAuthTag(body.subarray(-16))
  const plain = Buffer.concat([cipher.update(body.subarray(86, -16)), cipher.final()])
  assert.equal(plain.at(-1), 2)
  return plain.subarray(0, -1)
}

function setup(t, { lookup, respond = () => ({ status: 201, headers: {} }), ...opts } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpush-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' })
  const privateKeyFile = path.join(dir, 'vapid.pem')
  fs.writeFileSync(privateKeyFile, pem, { mode: 0o600 })
  const requests = []
  const lookups = []
  const client = makeWebPushClient({
    privateKeyFile, subject: 'mailto:alice@example.com', extraHosts: ['push.example.com'],
    lookup: async (...args) => {
      lookups.push(args)
      return lookup ? lookup(...args) : [{ address: '93.184.216.34', family: 4 }]
    },
    request: async (request) => { requests.push(request); return respond(request) },
    ...opts,
  })
  t.after(() => client.close())
  const sub = subscription()
  const payload = Buffer.from('private notification for alice')
  const send = (overrides = {}) => client.send({ endpoint, p256dh: sub.p256dh, auth: sub.auth.toString('base64url'), payload, urgency: 'high', topic: 'convo-one', ttl: 86400, ...overrides })
  return { client, requests, lookups, send, sub, payload, pem, keys, privateKeyFile }
}

test('encryptPayload matches RFC 8291 Appendix A bytes', () => {
  const body = encryptPayload({ payload: Buffer.from(vector.plaintext), p256dh: vector.ua_public, auth: vector.auth_secret, salt: decode(vector.salt), ephemeral: { publicKey: decode(vector.as_public), privateKey: decode(vector.as_private) } })
  assert.deepEqual(body, decode(vector.body))
})

test('aes128gcm round trip and single-record size boundary', () => {
  const { ua, auth, p256dh } = subscription()
  const args = { p256dh, auth: auth.toString('base64url') }
  const payload = crypto.randomBytes(3993)
  const body = encryptPayload({ ...args, payload })
  assert.ok(Buffer.isBuffer(body), 'encryption returns a record')
  assert.deepEqual(decrypt(body, ua, auth), payload)
  assert.throws(() => encryptPayload({ ...args, payload: Buffer.alloc(3994) }))
})

test('sender encrypts every payload and supplies transport headers', async (t) => {
  const s = setup(t)
  assert.equal((await s.send()).status, 201)
  assert.equal(s.requests.length, 1)
  const r = s.requests[0]
  assert.equal(r.body.includes(s.payload), false)
  assert.deepEqual(decrypt(r.body, s.sub.ua, s.sub.auth), s.payload)
  const headers = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
  assert.equal(headers.ttl, '86400')
  assert.equal(headers['content-encoding'], 'aes128gcm')
  assert.equal(headers['content-type'], 'application/octet-stream')
  assert.equal(headers['content-length'], String(r.body.length))
  assert.match(headers.authorization, /^vapid t=.+, k=.+$/)
  assert.equal(headers.urgency, 'high')
  assert.equal(headers.topic, 'convo-one')
  assert.equal(r.hostname, 'push.example.com')
  assert.equal(Number(r.port), 443)
  assert.equal(r.path, '/send/alice')
  assert.equal(r.timeoutMs, 10000)
  await s.send({ urgency: 'normal', topic: undefined, ttl: 3600 })
  const h = Object.fromEntries(Object.entries(s.requests[1].headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
  assert.equal(h.urgency, 'normal')
  assert.equal(h.ttl, '3600')
  assert.equal(Object.hasOwn(h, 'topic'), false)
})

test('encryption failure resolves fail-closed with zero requests', async (t) => {
  const s = setup(t)
  assert.deepEqual(await s.send({ p256dh: 'malformed' }), { status: 0, reason: 'encrypt_failed' })
  assert.equal(s.requests.length, 0)
  assert.deepEqual(await s.send({ payload: Buffer.alloc(3994) }), { status: 0, reason: 'encrypt_failed' })
  assert.equal(s.requests.length, 0)
})

test('endpoint guard accepts public HTTPS and rejects unsafe URLs without DNS', () => {
  const good = checkEndpoint(endpoint, ['push.example.com'])
  assert.equal(good.ok, true)
  assert.ok(good.url instanceof URL)
  assert.equal(checkEndpoint('https://93.184.216.34/x', ['93.184.216.34']).ok, true)
  assert.equal(checkEndpoint('https://push.example.com:443/x', ['push.example.com']).ok, true)
  const blocked = [
    'http://push.example.com/x', 'https://127.0.0.1/x', 'https://10.0.0.1/x',
    'https://169.254.169.254/x', 'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x',
    'https://[fd00::1]/x', 'https://user@10.0.0.1/x', 'https://user:pw@push.example.com/x',
    'https://10.0.0.1:8443/x', 'https://push.example.com:8443/x', 'https://localhost/x',
    'https://foo.localhost/x', 'https://foo.local/x', 'https://foo.internal/x',
    'https://2130706433/x', 'https://0x7f000001/x', 'https://0177.0.0.1/x',
    'https://203.0.113.5/x', 'not a URL', `https://push.example.com/${'a'.repeat(2048)}`,
  ]
  for (const url of blocked) assert.equal(checkEndpoint(url, ['push.example.com', '127.0.0.1', '10.0.0.1', '169.254.169.254', '203.0.113.5', 'localhost', '*.localhost', '*.local', '*.internal']).ok, false, url)
})

test('address guard covers public addresses and non-public IPv4, IPv6 and embedded IPv4', () => {
  for (const ip of ['93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip)
  for (const ip of [
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.1.2.3', '192.0.0.1',
    '192.0.2.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd00::1', 'fe80::1', 'febf::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:a00:1', '::192.168.1.1', '::a00:1',
    '64:ff9b::10.0.0.1', '64:ff9b::a00:1', 'garbage', '',
    '2002:a00:1::', '2001::1', '64:ff9b:1::1', '::ffff:0:a00:1', 'fec0::1', '100::1', '192.88.99.1',
  ]) assert.equal(isPublicAddress(ip), false, ip)
})

for (const addresses of [
  [{ address: '10.0.0.5', family: 4 }],
  [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
]) test(`DNS blocks any non-public answer: ${addresses.length} answers`, async (t) => {
  const s = setup(t, { lookup: async () => addresses })
  assert.deepEqual(await s.send(), { status: 0, reason: 'blocked_address' })
  assert.equal(s.requests.length, 0)
})

test('DNS rebinding cannot change the address after its single checked lookup', async (t) => {
  let calls = 0
  const s = setup(t, { lookup: async () => [{ address: ++calls === 1 ? '93.184.216.34' : '10.0.0.5', family: 4 }] })
  assert.equal((await s.send()).status, 201)
  assert.equal(calls, 1)
  assert.deepEqual(s.lookups[0], ['push.example.com', { all: true }])
  assert.equal(s.requests[0].address, '93.184.216.34')
  assert.equal(s.requests[0].family, 4)
})

test('redirects are reported without following Location', async (t) => {
  const s = setup(t, { respond: () => ({ status: 302, headers: { location: 'http://10.0.0.1/' } }) })
  assert.deepEqual(await s.send(), { status: 302, reason: 'redirect' })
  assert.equal(s.requests.length, 1)
})

test('transport rejection resolves a short failure instead of rejecting send', async (t) => {
  const s = setup(t, { respond: () => { throw new Error('fake transport unavailable') } })
  const result = await s.send()
  assert.equal(result.status, 0)
  assert.match(result.reason ?? '', /^[a-z_]{1,64}$/)
  assert.equal(s.requests.length, 1)
})

test('logs never expose private keys, JWTs, content, endpoint paths or auth secrets', async (t) => {
  const s = setup(t, { respond: () => ({ status: s.requests.length === 1 ? 201 : 500, headers: {} }) })
  const lines = []
  const saved = Object.fromEntries(['log', 'info', 'warn', 'error'].map((k) => [k, console[k]]))
  try {
    for (const k of Object.keys(saved)) console[k] = (...args) => lines.push(args.join(' '))
    await s.send()
    await s.send()
    await s.send({ endpoint: 'https://10.0.0.1/private' })
    await s.send({ p256dh: 'malformed' })
  } finally {
    Object.assign(console, saved)
  }
  assert.equal(s.requests.length, 2, 'success and service failure both reached the fake service')
  const headers = Object.fromEntries(Object.entries(s.requests[0].headers).map(([k, v]) => [k.toLowerCase(), v]))
  const jwt = String(headers.authorization).match(/t=([^, ]+)/)?.[1]
  assert.ok(jwt)
  for (const secret of [s.pem.split('\n')[1], jwt, s.payload.toString(), s.sub.auth.toString('base64url'), '/send/alice']) {
    for (const line of lines) assert.equal(line.includes(secret), false, 'log exposed confidential material')
  }
})

test('VAPID JWT signature, endpoint origin, subject and expiration', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const publicKeyB64u = Buffer.concat([Buffer.from([4]), decode(jwk.x), decode(jwk.y)]).toString('base64url')
  const now = 1800000000000
  const authorization = vapidAuthorization({ endpoint, privateKey, publicKeyB64u, subject: 'mailto:alice@example.com', now })
  assert.equal(typeof authorization, 'string')
  const match = authorization.match(/^vapid t=([^, ]+), k=(.+)$/)
  assert.ok(match)
  assert.equal(match[2], publicKeyB64u)
  const [header, payload, signature] = match[1].split('.')
  assert.equal(JSON.parse(decode(header)).alg, 'ES256')
  assert.equal(crypto.verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, decode(signature)), true)
  const claims = JSON.parse(decode(payload))
  assert.equal(claims.aud, 'https://push.example.com')
  assert.equal(claims.sub, 'mailto:alice@example.com')
  assert.equal(claims.exp, now / 1000 + 12 * 3600)
  assert.ok(claims.exp <= now / 1000 + 86400)
})

test('environment config enables only complete pairs and kill switch overrides them', () => {
  const config = { MATRON_WEBPUSH_VAPID_KEY_FILE: '/tmp/example-vapid.pem', MATRON_WEBPUSH_SUBJECT: 'mailto:alice@example.com' }
  assert.equal(webPushConfigFromEnv({}), null)
  assert.deepEqual(webPushConfigFromEnv(config), { privateKeyFile: config.MATRON_WEBPUSH_VAPID_KEY_FILE, subject: config.MATRON_WEBPUSH_SUBJECT, extraHosts: [] })
  for (const value of ['1', 'true']) assert.equal(webPushConfigFromEnv({ ...config, MATRON_WEBPUSH_DISABLED: value }), null)
  assert.equal(webPushConfigFromEnv({ MATRON_WEBPUSH_VAPID_KEY_FILE: config.MATRON_WEBPUSH_VAPID_KEY_FILE, MATRON_WEBPUSH_DISABLED: '1' }), null)
})

test('partial environment config names the missing variable', () => {
  assert.throws(() => webPushConfigFromEnv({ MATRON_WEBPUSH_VAPID_KEY_FILE: '/tmp/example-vapid.pem' }), /MATRON_WEBPUSH_SUBJECT/)
  assert.throws(() => webPushConfigFromEnv({ MATRON_WEBPUSH_SUBJECT: 'mailto:alice@example.com' }), /MATRON_WEBPUSH_VAPID_KEY_FILE/)
})

test('client construction rejects unreadable and non-P-256 signing keys', (t) => {
  const s = setup(t)
  assert.throws(() => makeWebPushClient({ privateKeyFile: path.join(path.dirname(s.privateKeyFile), 'missing.pem'), subject: 'mailto:alice@example.com' }))
  const wrong = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey
  fs.writeFileSync(s.privateKeyFile, wrong.export({ type: 'pkcs8', format: 'pem' }))
  assert.throws(() => makeWebPushClient({ privateKeyFile: s.privateKeyFile, subject: 'mailto:alice@example.com' }))
})

test('a lookup that never answers is cut off at the timeout and sends nothing', async (t) => {
  const s = setup(t, { lookup: () => new Promise(() => {}), timeoutMs: 50 })
  assert.deepEqual(await s.send(), { status: 0, reason: 'transport' })
  assert.equal(s.requests.length, 0)
})

test('an unrecognised kill switch value fails loudly instead of leaving web push on', () => {
  const base = { MATRON_WEBPUSH_VAPID_KEY_FILE: '/k.pem', MATRON_WEBPUSH_SUBJECT: 'mailto:alice@example.com' }
  for (const v of ['yes', 'on', 'TRUE', '2']) assert.throws(() => webPushConfigFromEnv({ ...base, MATRON_WEBPUSH_DISABLED: v }), /MATRON_WEBPUSH_DISABLED/, v)
  for (const v of [undefined, '', '0', 'false']) assert.deepEqual(webPushConfigFromEnv({ ...base, MATRON_WEBPUSH_DISABLED: v }), { privateKeyFile: '/k.pem', subject: 'mailto:alice@example.com', extraHosts: [] }, String(v))
  for (const v of ['1', 'true']) assert.equal(webPushConfigFromEnv({ ...base, MATRON_WEBPUSH_DISABLED: v }), null, v)
})

const defaultEndpoints = [
  'https://fcm.googleapis.com/fcm/send/x',
  'https://updates.push.services.mozilla.com/wpush/v2/x',
  'https://web.push.apple.com/x',
  'https://wns2-par02p.notify.windows.com/x',
]

test('default push-service hosts pass the endpoint policy and send', async (t) => {
  const s = setup(t, { extraHosts: [] })
  for (const endpoint of defaultEndpoints) {
    assert.equal(checkEndpoint(endpoint).ok, true, endpoint)
    assert.equal(s.client.checkEndpoint(endpoint).ok, true, endpoint)
    assert.equal((await s.send({ endpoint })).status, 201, endpoint)
  }
})

test('unlisted public hosts fail before DNS or transport, including wildcard apexes and lookalikes', async (t) => {
  const s = setup(t, { extraHosts: ['*.custom.example.com'] })
  for (const endpoint of [
    'https://example.org/x', 'https://push.example.com/x',
    'https://push.apple.com/x', 'https://notify.windows.com/x',
    'https://custom.example.com/x', 'https://fakecustom.example.com/x',
    'https://web.push.apple.com.example.org/x', 'https://93.184.216.34/x',
  ]) {
    assert.equal(s.client.checkEndpoint(endpoint).ok, false, endpoint)
    assert.deepEqual(await s.send({ endpoint }), { status: 0, reason: 'bad_endpoint' }, endpoint)
  }
  assert.equal(s.lookups.length, 0)
  assert.equal(s.requests.length, 0)
})

test('extra exact and wildcard hosts extend both client checking and sending', async (t) => {
  const s = setup(t, { extraHosts: ['push.example.com', '*.custom.example.com', '93.184.216.34', '10.0.0.1'] })
  for (const endpoint of ['https://push.example.com/x', 'https://one.custom.example.com/x', 'https://one.two.custom.example.com/x', 'https://93.184.216.34/x']) {
    assert.equal(s.client.checkEndpoint(endpoint).ok, true, endpoint)
    assert.equal((await s.send({ endpoint })).status, 201, endpoint)
  }
  assert.deepEqual(await s.send({ endpoint: 'https://10.0.0.1/x' }), { status: 0, reason: 'bad_endpoint' })
  assert.equal(checkEndpoint('https://93.184.216.34/x', ['*.216.34']).ok, false)
})

test('extra-host environment entries are trimmed, lowercased and validated at startup', (t) => {
  const base = { MATRON_WEBPUSH_VAPID_KEY_FILE: '/k.pem', MATRON_WEBPUSH_SUBJECT: 'mailto:alice@example.com' }
  assert.deepEqual(webPushConfigFromEnv({ ...base, MATRON_WEBPUSH_EXTRA_HOSTS: ' PUSH.Example.COM, , *.Custom.Example.COM,,' }).extraHosts,
    ['push.example.com', '*.custom.example.com'])
  const s = setup(t)
  for (const entry of ['https://push.example.com', 'push.example.com/path', 'push.example.com:443', 'push example.com', '*example.com', 'foo.*.example.com', '.example.com', 'example..com', '-example.com']) {
    assert.throws(() => webPushConfigFromEnv({ ...base, MATRON_WEBPUSH_EXTRA_HOSTS: entry }), /MATRON_WEBPUSH_EXTRA_HOSTS/, entry)
    assert.throws(() => makeWebPushClient({ privateKeyFile: s.privateKeyFile, subject: base.MATRON_WEBPUSH_SUBJECT, extraHosts: [entry] }), /MATRON_WEBPUSH_EXTRA_HOSTS/, entry)
  }
})
