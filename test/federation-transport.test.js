import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createUser } from '../src/auth.js'
import { makeTokenBox } from '../src/token-box.js'
import { ensureFederationKey, wellKnownDocument, WELL_KNOWN_PATH } from '../src/federation-identity.js'
import {
  generateFederationKey, exportPublicKey, keyFingerprint, newOpId, signEnvelope, verifyResponse, MAX_ENVELOPE_BYTES,
} from '../src/federation-envelope.js'
import { isBlockedAddress, makeFederationClient } from '../src/federation-client.js'
import { pruneReceipts, RECEIPT_TTL_MS, PING_OP } from '../src/federation-inbound.js'
import { startTestServer } from './helpers.js'

const KEY = 'c'.repeat(64)

// --- The destination policy -------------------------------------------------

test('addresses: private, loopback, link-local, CGNAT, ULA, metadata and embedded IPv4 are refused', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::1', '2001:db8::1', 'not-an-ip']) {
    assert.equal(isBlockedAddress(a), true, a)
  }
  for (const a of ['93.184.216.34', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '2a00:1450:4009::200e']) {
    assert.equal(isBlockedAddress(a), false, a)
  }
})

const fakeLookup = (table, calls = []) => (host, opts, cb) => {
  calls.push(host)
  const addrs = table[host]
  if (!addrs) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))
  cb(null, addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })))
}

test('destinations: https only, public addresses only, unless the operator allows the host', async () => {
  const lookup = fakeLookup({
    'public.example': ['93.184.216.34'], 'lan.example': ['192.168.1.20'], 'mixed.example': ['93.184.216.34', '10.0.0.5'],
  })
  const c = makeFederationClient({ lookup })
  const refused = (url, why) => assert.rejects(c.resolveDestination(new URL(url)), (e) => e.message === 'destination_refused' && e.why === why, url)
  await refused('http://public.example/', 'scheme')
  await refused('ftp://public.example/', 'scheme')
  await refused('https://user:pw@public.example/', 'credentials')
  await refused('https://lan.example/', 'address')
  await refused('https://mixed.example/', 'address')
  await refused('https://127.0.0.1/', 'address')
  await refused('https://[::1]/', 'address')
  await refused('https://169.254.169.254/', 'address')
  await assert.rejects(c.resolveDestination(new URL('https://nowhere.example/')), { message: 'network' })
  assert.equal((await c.resolveDestination(new URL('https://public.example/'))).address, '93.184.216.34')
  const lan = makeFederationClient({ lookup, allowHosts: ['LAN.example'] })
  assert.equal((await lan.resolveDestination(new URL('https://lan.example/'))).address, '192.168.1.20')
})

async function fakePeer(handler) {
  const server = http.createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}

test('requests: connect to the checked address, resolve once, keep the Host name, never follow redirects', async (t) => {
  const seen = []
  const peer = await fakePeer((req, res) => {
    seen.push(req.headers.host)
    if (req.url === '/moved') { res.writeHead(302, { location: 'http://169.254.169.254/' }); return res.end() }
    res.end('hello')
  })
  t.after(peer.close)
  const calls = []
  const c = makeFederationClient({ allowHttp: true, allowHosts: ['peer.test'], lookup: fakeLookup({ 'peer.test': ['127.0.0.1'] }, calls) })
  const r = await c.request(`http://peer.test:${peer.port}/x`)
  assert.equal(r.status, 200)
  assert.equal(r.body.toString(), 'hello')
  assert.deepEqual(calls, ['peer.test'])
  assert.equal(seen[0], `peer.test:${peer.port}`)
  const moved = await c.request(`http://peer.test:${peer.port}/moved`)
  assert.equal(moved.status, 302)
  assert.equal(seen.length, 2)
})

test('requests: the body is capped and a peer that never answers times out', async (t) => {
  const peer = await fakePeer((req, res) => {
    if (req.url === '/big') { res.write(Buffer.alloc(MAX_ENVELOPE_BYTES)); res.end(Buffer.alloc(10)); return }
    // /hang: never answers
  })
  t.after(() => { peer.server.closeAllConnections(); return peer.close() })
  const c = makeFederationClient({ allowHttp: true, allowHosts: ['127.0.0.1'], totalTimeoutMs: 300 })
  await assert.rejects(c.request(`http://127.0.0.1:${peer.port}/big`), { message: 'too_large' })
  const ok = await c.request(`http://127.0.0.1:${peer.port}/big`, { maxBytes: MAX_ENVELOPE_BYTES + 10 })
  assert.equal(ok.body.length, MAX_ENVELOPE_BYTES + 10)
  await assert.rejects(c.request(`http://127.0.0.1:${peer.port}/hang`), (e) => e.message === 'timeout' && e.why === 'total')
})

test('well-known: a document is accepted only if it names the host it came from and its key id is the fingerprint', async (t) => {
  const { privateKey, publicKey } = generateFederationKey()
  let doc = null
  const peer = await fakePeer((req, res) => {
    if (req.url !== WELL_KNOWN_PATH) { res.writeHead(404); return res.end() }
    res.setHeader('content-type', 'application/json')
    res.end(typeof doc === 'string' ? doc : JSON.stringify(doc))
  })
  t.after(peer.close)
  const host = `127.0.0.1:${peer.port}`
  const pub = exportPublicKey(publicKey)
  const good = wellKnownDocument({ host, baseUrl: `http://${host}`, key: { pub, fingerprint: keyFingerprint(pub), privateKey } })
  const c = makeFederationClient({ allowHttp: true, allowHosts: ['127.0.0.1'] })
  doc = good
  const w = await c.fetchWellKnown(host, { scheme: 'http' })
  assert.equal(w.pub, pub)
  assert.equal(w.fingerprint, keyFingerprint(pub))
  const other = exportPublicKey(generateFederationKey().publicKey)
  for (const bad of [
    { ...good, journal: 'elsewhere.example' }, { ...good, v: 2 }, { ...good, key: { ...good.key, id: keyFingerprint(other) } },
    { ...good, key: { ...good.key, alg: 'rsa' } }, { ...good, key: { ...good.key, pub: 'x' } },
    { ...good, base_url: 'http://elsewhere.example' }, { ...good, base_url: `http://${host}/path` },
    '{"v":1,"v":1}', 'not json',
  ]) {
    doc = bad
    await assert.rejects(c.fetchWellKnown(host, { scheme: 'http' }), { message: 'bad_well_known' }, JSON.stringify(bad))
  }
})

// --- The inbound endpoint ---------------------------------------------------

// Journal B (b.example, user bob) receiving from journal A (a.example),
// whose key B has pinned.
async function setup(t, { ops, peerState = 'active' } = {}) {
  const b = await startTestServer({ tokenKey: KEY, federationEnv: { federation: 'on', publicUrl: 'https://b.example' }, ...(ops ? { federationOps: ops } : {}) })
  t.after(() => b.close())
  await createUser(b.db, 'bob', 'pw')
  const a = generateFederationKey()
  b.db.prepare('INSERT INTO fed_peers(host, base_url, key_pub, state, first_seen) VALUES(?,?,?,?,?)')
    .run('a.example', 'https://a.example', exportPublicKey(a.publicKey), peerState, Date.now())
  const bKey = ensureFederationKey(b.db, makeTokenBox(KEY))
  const client = makeFederationClient({ allowHttp: true, allowHosts: ['127.0.0.1'] })
  const envelope = (over = {}) => signEnvelope({ from: 'alice@a.example', to: 'bob@b.example', op: 'ping', id: newOpId(), body: {}, ...over }, over.key ?? a.privateKey)
  const post = (e) => client.postEnvelope(b.base, e, bKey.publicKey)
  const raw = async (body) => {
    const r = await fetch(b.base + '/federation/v1', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    return { status: r.status, json: await r.json() }
  }
  return { b, a, bKey, envelope, post, raw }
}

const counter = () => {
  const op = { applied: 0, refuse: false, apply: () => { if (op.refuse) throw new Error('grant_revoked'); op.applied += 1; return { n: op.applied } }, errors: { grant_revoked: 403 } }
  return op
}

test('inbound: 404 while federation is off', async (t) => {
  const s = await startTestServer({ tokenKey: KEY, federationEnv: {} })
  t.after(() => s.close())
  const r = await fetch(s.base + '/federation/v1', { method: 'POST', body: '{}' })
  assert.equal(r.status, 404)
})

test('inbound: a ping from a known journal is applied and the answer is signed for that op', async (t) => {
  const { envelope, post, bKey } = await setup(t)
  const e = envelope()
  const r = await post(e)
  assert.equal(r.status, 200)
  assert.equal(r.signed, true)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.result.pong, true)
  assert.equal(typeof r.body.result.clock, 'number')
  assert.equal(verifyResponse({ id: newOpId(), status: r.status, body: r.body, sig: 'x'.repeat(86) }, bKey.publicKey), false)
})

test('inbound: an op applies once; a repeat or a re-signed retry gets the stored answer; a reused id is 409', async (t) => {
  const op = counter()
  const { b, envelope, post } = await setup(t, { ops: { 'test.count': op } })
  const id = newOpId()
  const first = envelope({ op: 'test.count', id, body: { x: 1 } })
  const r1 = await post(first)
  assert.deepEqual([r1.status, r1.body], [200, { ok: true, result: { n: 1 } }])
  const r2 = await post(first)
  assert.deepEqual([r2.status, r2.body, r2.signed], [200, { ok: true, result: { n: 1 } }, true])
  const retry = envelope({ op: 'test.count', id, body: { x: 1 }, ts: Date.now() + 1000 })
  assert.deepEqual((await post(retry)).body, { ok: true, result: { n: 1 } })
  assert.equal(op.applied, 1)
  const reused = await post(envelope({ op: 'test.count', id, body: { x: 2 } }))
  assert.deepEqual([reused.status, reused.body, reused.signed], [409, { error: 'id_reused' }, true])
  assert.equal(op.applied, 1)
  assert.equal(b.db.prepare('SELECT COUNT(*) AS n FROM fed_receipts').get().n, 1)
  assert.ok(b.db.prepare('SELECT last_ok_at FROM fed_peers WHERE host=?').get('a.example').last_ok_at)
})

test('inbound: a refusal writes no receipt, so a resend is judged afresh', async (t) => {
  const op = counter()
  const { b, envelope, post } = await setup(t, { ops: { 'test.count': op } })
  op.refuse = true
  const e = envelope({ op: 'test.count' })
  const r = await post(e)
  assert.deepEqual([r.status, r.body, r.signed], [403, { error: 'grant_revoked' }, true])
  assert.equal(b.db.prepare('SELECT COUNT(*) AS n FROM fed_receipts').get().n, 0)
  op.refuse = false
  assert.equal((await post(envelope({ op: 'test.count', id: e.id, body: e.body }))).status, 200)
  assert.equal(op.applied, 1)
})

test('inbound: who may send, and to whom', async (t) => {
  const { envelope, post } = await setup(t)
  const cases = [
    [envelope({ to: 'bob@elsewhere.example' }), 403, 'not_here'],
    [envelope({ to: 'nobody@b.example' }), 403, 'not_here'],
    [envelope({ from: 'mallory@m.example' }), 403, 'unknown_journal'],
    [envelope({ key: generateFederationKey().privateKey }), 403, 'bad_signature'],
    [envelope({ op: 'no.such_op' }), 400, 'unknown_op'],
  ]
  for (const [e, status, error] of cases) {
    const r = await post(e)
    assert.deepEqual([r.status, r.body.error, r.signed], [status, error, true], error)
  }
})

test('inbound: a journal the operator blocked is refused', async (t) => {
  const { envelope, post } = await setup(t, { peerState: 'blocked' })
  const r = await post(envelope())
  assert.deepEqual([r.status, r.body.error], [403, 'peer_refused'])
})

test('inbound: a stale attempt is 401 with our clock', async (t) => {
  const { envelope, post } = await setup(t)
  const r = await post(envelope({ ts: Date.now() - 10 * 60 * 1000 }))
  assert.equal(r.status, 401)
  assert.equal(r.body.error, 'stale')
  assert.ok(Math.abs(r.body.clock - Date.now()) < 60_000)
})

test('inbound: malformed, wrong version and oversized envelopes', async (t) => {
  const { envelope, raw } = await setup(t)
  const e = envelope()
  assert.deepEqual(await raw('not json'), { status: 400, json: { error: 'malformed' } })
  assert.deepEqual(await raw(JSON.stringify(e).replace('"op":', '"op":"x","op":')), { status: 400, json: { error: 'malformed' } })
  assert.deepEqual(await raw(JSON.stringify({ ...e, v: 2 })), { status: 400, json: { error: 'unsupported_version' } })
  assert.deepEqual(await raw(Buffer.from([0x7b, 0xff, 0x7d])), { status: 400, json: { error: 'malformed' } })
  const big = await raw(Buffer.alloc(MAX_ENVELOPE_BYTES + 1, 0x20))
  assert.equal(big.status, 413)
})

test('inbound: only POST', async (t) => {
  const { b } = await setup(t)
  const r = await fetch(b.base + '/federation/v1')
  assert.equal(r.status, 405)
})

test('receipts: kept 30 days, then pruned', async (t) => {
  const { b, envelope, post } = await setup(t)
  await post(envelope())
  const created = b.db.prepare('SELECT created_at FROM fed_receipts').get().created_at
  assert.equal(pruneReceipts(b.db, created + RECEIPT_TTL_MS - 1), 0)
  assert.equal(pruneReceipts(b.db, created + RECEIPT_TTL_MS + 1), 1)
})

test('ping: answers with the clock', () => {
  assert.deepEqual(PING_OP.apply({ now: 5 }), { pong: true, clock: 5 })
})

test('configured client: MATRON_FEDERATION_ALLOW_HOSTS lets listed hosts through', async () => {
  const { makeConfiguredFederationClient } = await import('../src/federation-client.js')
  const lookup = fakeLookup({ 'lan.example': ['192.168.1.20'], 'other.example': ['10.0.0.1'] })
  const c = makeConfiguredFederationClient({ env: { MATRON_FEDERATION_ALLOW_HOSTS: ' lan.example , 192.168.9.9' }, lookup })
  assert.equal((await c.resolveDestination(new URL('https://lan.example/'))).address, '192.168.1.20')
  assert.equal((await c.resolveDestination(new URL('https://192.168.9.9/'))).address, '192.168.9.9')
  await assert.rejects(c.resolveDestination(new URL('https://other.example/')), { message: 'destination_refused' })
  await assert.rejects(makeConfiguredFederationClient({ env: {}, lookup }).resolveDestination(new URL('https://lan.example/')), { message: 'destination_refused' })
})

test('inbound: an answer sent before the body was read closes the connection', async (t) => {
  const { b } = await setup(t)
  const net = await import('node:net')
  const { port } = new URL(b.base)
  for (const [method, len, want] of [['GET', 10, '405'], ['POST', MAX_ENVELOPE_BYTES + 100, '413']]) {
    const sock = net.connect(Number(port), '127.0.0.1')
    let got = ''
    sock.on('data', (d) => { got += d })
    const closed = new Promise((r) => sock.on('close', r))
    sock.write(`${method} /federation/v1 HTTP/1.1\r\nhost: x\r\ncontent-length: ${len}\r\n\r\n`)
    sock.write(Buffer.alloc(Math.min(len, MAX_ENVELOPE_BYTES + 10), 0x20), () => {})
    await closed
    assert.match(got, new RegExp(`^HTTP/1.1 ${want}`))
    assert.match(got, /connection: close/i)
  }
})
