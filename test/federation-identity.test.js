import test from 'node:test'
import assert from 'node:assert/strict'
import { sign } from 'node:crypto'
import { openDb } from '../src/db.js'
import { makeTokenBox } from '../src/token-box.js'
import { importPublicKey, keyFingerprint, signEnvelope, verifyEnvelope, newOpId, MAX_ENVELOPE_BYTES } from '../src/federation-envelope.js'
import {
  resolveFederationConfig, journalAllowed, ensureFederationKey, storedFederationKeyInfo, loadFederation, WELL_KNOWN_PATH,
} from '../src/federation-identity.js'
import { runAdmin } from '../bin/matron-admin.js'
import { startTestServer } from './helpers.js'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const quiet = () => {
  const lines = []
  return { lines, log: { log: (l) => lines.push(l), error: (l) => lines.push(l), warn: (l) => lines.push(l) } }
}

test('config: off unless switched on with an https public URL', () => {
  assert.deepEqual(resolveFederationConfig({}), { enabled: false, reason: 'off' })
  assert.deepEqual(resolveFederationConfig({ federation: 'off', publicUrl: 'https://a.example' }), { enabled: false, reason: 'off' })
  assert.deepEqual(resolveFederationConfig({ federation: 'yes', publicUrl: 'https://a.example' }), { enabled: false, reason: 'bad_switch' })
  assert.deepEqual(resolveFederationConfig({ federation: 'on' }), { enabled: false, reason: 'no_public_url' })
  assert.deepEqual(resolveFederationConfig({ federation: 'on', publicUrl: 'http://a.example' }), { enabled: false, reason: 'no_public_url' })
  assert.deepEqual(resolveFederationConfig({ federation: 'on', publicUrl: 'https://Journal.Example.com/some/path' }),
    { enabled: true, baseUrl: 'https://journal.example.com', host: 'journal.example.com', allowJournals: [], denyJournals: [] })
  assert.deepEqual(resolveFederationConfig({ federation: 'ON', publicUrl: 'https://a.example:8443' }),
    { enabled: true, baseUrl: 'https://a.example:8443', host: 'a.example:8443', allowJournals: [], denyJournals: [] })
})

test('config: the allow and deny lists of other journals', () => {
  const on = (lists) => resolveFederationConfig({ federation: 'on', publicUrl: 'https://a.example', ...lists })
  const open = on({})
  assert.equal(journalAllowed(open, 'b.example'), true)
  assert.equal(journalAllowed(open, 'a.example'), false, 'never with itself')
  assert.equal(journalAllowed({ enabled: false }, 'b.example'), false)
  const denied = on({ denyJournals: ' B.example , c.example' })
  assert.deepEqual(denied.denyJournals, ['b.example', 'c.example'])
  assert.equal(journalAllowed(denied, 'b.example'), false)
  assert.equal(journalAllowed(denied, 'd.example'), true)
  const allowed = on({ allowJournals: 'b.example', denyJournals: 'b.example' })
  assert.equal(journalAllowed(allowed, 'b.example'), false, 'deny wins')
  assert.equal(journalAllowed(on({ allowJournals: 'b.example' }), 'c.example'), false)
  assert.equal(journalAllowed(on({ allowJournals: 'b.example' }), 'B.EXAMPLE'), true)
})

test('key: made once, sealed at rest, the same key on every later start', () => {
  const db = openDb(':memory:')
  const box = makeTokenBox(KEY_A)
  const first = ensureFederationKey(db, box, { now: () => 1700000000000 })
  const stored = db.prepare("SELECT value FROM journal_settings WHERE key='federation_key'").get().value
  assert.match(stored, /^enc1:/)
  assert.ok(!stored.includes('PRIVATE KEY'))
  const again = ensureFederationKey(db, box, { now: () => 1800000000000 })
  assert.equal(again.pub, first.pub)
  assert.equal(again.fingerprint, keyFingerprint(first.pub))
  assert.equal(again.createdAt, 1700000000000)
  const sig = sign(null, Buffer.from('x'), again.privateKey)
  assert.ok(sig.length === 64)
  assert.deepEqual(storedFederationKeyInfo(db, box), { readable: true, pub: first.pub, fingerprint: first.fingerprint, createdAt: 1700000000000 })
})

test('key: never stored unsealed; a different token key cannot open it', () => {
  const db = openDb(':memory:')
  assert.throws(() => ensureFederationKey(db, makeTokenBox(null)), { message: 'no_token_key' })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM journal_settings WHERE key LIKE 'federation%'").get().n, 0)
  ensureFederationKey(db, makeTokenBox(KEY_A))
  assert.throws(() => ensureFederationKey(db, makeTokenBox(KEY_B)), { message: 'key_unreadable' })
  assert.equal(storedFederationKeyInfo(db, makeTokenBox(KEY_B)).readable, false)
  assert.equal(storedFederationKeyInfo(openDb(':memory:'), makeTokenBox(KEY_A)), null)
})

test('load: each reason it stays off is logged once; on logs the host and fingerprint', () => {
  const on = { federation: 'on', publicUrl: 'https://a.example' }
  let q = quiet()
  assert.deepEqual(loadFederation(openDb(':memory:'), makeTokenBox(KEY_A), { ...q }), { enabled: false })
  assert.equal(q.lines.length, 0)
  q = quiet()
  assert.deepEqual(loadFederation(openDb(':memory:'), makeTokenBox(null), { ...on, ...q }), { enabled: false })
  assert.match(q.lines[0], /MATRON_TOKEN_KEY.*off/)
  q = quiet()
  assert.deepEqual(loadFederation(openDb(':memory:'), makeTokenBox(KEY_A), { federation: 'on', ...q }), { enabled: false })
  assert.match(q.lines[0], /MATRON_PUBLIC_URL/)
  const db = openDb(':memory:')
  ensureFederationKey(db, makeTokenBox(KEY_A))
  q = quiet()
  assert.deepEqual(loadFederation(db, makeTokenBox(KEY_B), { ...on, ...q }), { enabled: false })
  assert.match(q.lines[0], /does not open/)
  q = quiet()
  const f = loadFederation(openDb(':memory:'), makeTokenBox(KEY_A), { ...on, ...q })
  assert.equal(f.enabled, true)
  assert.equal(f.host, 'a.example')
  assert.match(q.lines[0], new RegExp(`on as a\\.example, key ${f.key.fingerprint}`))
})

test('well-known: 404 while off; the app-link files are unaffected', async (t) => {
  const s = await startTestServer({ tokenKey: KEY_A, federationEnv: {} })
  t.after(() => s.close())
  const r = await s.http(WELL_KNOWN_PATH)
  assert.equal(r.status, 404)
  assert.equal((await s.http('/.well-known/assetlinks.json')).status, 404)
})

test('well-known: serves the identity document, and the key in it verifies the journal\'s signatures', async (t) => {
  const s = await startTestServer({ tokenKey: KEY_A, federationEnv: { federation: 'on', publicUrl: 'http://localhost:8080' } })
  t.after(() => s.close())
  const res = await fetch(s.base + WELL_KNOWN_PATH)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/json')
  assert.match(res.headers.get('cache-control'), /public/)
  const doc = await res.json()
  assert.deepEqual(Object.keys(doc).sort(), ['base_url', 'federation', 'journal', 'key', 'v'])
  assert.equal(doc.v, 1)
  assert.equal(doc.journal, 'localhost:8080')
  assert.equal(doc.base_url, 'http://localhost:8080')
  assert.equal(doc.key.alg, 'ed25519')
  assert.equal(doc.key.id, keyFingerprint(doc.key.pub))
  assert.deepEqual(doc.federation, { max_envelope: MAX_ENVELOPE_BYTES })
  const key = ensureFederationKey(s.db, makeTokenBox(KEY_A))
  assert.equal(doc.key.pub, key.pub)
  const e = signEnvelope({ from: 'alice@localhost:8080', to: 'bob@b.example', op: 'ping', id: newOpId(), body: {} }, key.privateKey)
  assert.doesNotThrow(() => verifyEnvelope(e, importPublicKey(doc.key.pub)))
  const head = await fetch(s.base + WELL_KNOWN_PATH, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  assert.equal((await fetch(s.base + WELL_KNOWN_PATH, { method: 'POST' })).status !== 200, true)
})

test('admin: federation status reports the switch and the key', async () => {
  const db = openDb(':memory:')
  let out = await runAdmin(db, ['federation', 'status'], { env: {} })
  assert.match(out, /off in this shell/)
  assert.match(out, /key: none yet/)
  const key = ensureFederationKey(db, makeTokenBox(KEY_A), { now: () => 1700000000000 })
  out = await runAdmin(db, ['federation', 'status'], { env: { MATRON_FEDERATION: 'on', MATRON_PUBLIC_URL: 'https://a.example', MATRON_TOKEN_KEY: KEY_A } })
  assert.match(out, /on in this shell, as a\.example/)
  assert.ok(out.includes(`key: ${key.pub}`))
  assert.ok(out.includes(key.fingerprint.slice(0, 4) + ' '))
  assert.match(out, /made: 2023-11-14T/)
  out = await runAdmin(db, ['federation', 'status'], { env: { MATRON_TOKEN_KEY: KEY_B } })
  assert.match(out, /does not open under this MATRON_TOKEN_KEY/)
})
