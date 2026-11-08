import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFederationLimiter } from '../src/federation-inbound.js'
import { generateFederationKey, signEnvelope, newOpId } from '../src/federation-envelope.js'
import { MAX_PENDING_OFFERS } from '../src/federation-grants.js'
import { createUser } from '../src/auth.js'
import { startTestServer } from './helpers.js'
import { world, KEY } from './federation-world.js'

const raw = (s, envelope, path = '/federation/v1') => fetch(s.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) })
  .then(async (r) => ({ status: r.status, json: await r.json() }))

test('limiter: a journal gets its burst, then one request a second', () => {
  let t = 0
  const l = makeFederationLimiter({ peerBurst: 3, peerPerSec: 1, now: () => t })
  assert.deepEqual([1, 2, 3, 4].map(() => l.take('a.example')), [true, true, true, false])
  assert.equal(l.take('b.example'), true, 'another journal has its own bucket')
  t += 1000
  assert.equal(l.take('a.example'), true)
  assert.equal(l.take('a.example'), false)
})

test('limiter: strangers share one bucket, and it is not any peer\'s', () => {
  const l = makeFederationLimiter({ peerBurst: 2, strangerBurst: 5, strangerPerSec: 1, now: () => 0 })
  assert.equal(Array.from({ length: 8 }, () => l.takeStranger()).filter(Boolean).length, 5)
  assert.equal(l.take('a.example'), true, 'a peer is not slowed by strangers')
})

test('POST /federation/v1: strangers get 429 past their shared burst', async (t) => {
  const s = await startTestServer({ tokenKey: KEY, federationEnv: { federation: 'on', publicUrl: 'https://b.example' }, federationLimits: { strangerBurst: 2 } })
  t.after(() => s.close())
  await createUser(s.db, 'bob', 'pw')
  const k = generateFederationKey()
  const send = () => raw(s, signEnvelope({ from: 'x@m.example', to: 'bob@b.example', op: 'ping', id: newOpId(), body: {} }, k.privateKey))
  const statuses = []
  for (let i = 0; i < 3; i++) statuses.push((await send()).status)
  assert.deepEqual(statuses, [403, 403, 429])
})

test('POST /federation/v1: a stranger cannot tell a user here from a name that does not exist', async (t) => {
  const s = await startTestServer({ tokenKey: KEY, federationEnv: { federation: 'on', publicUrl: 'https://b.example' } })
  t.after(() => s.close())
  const u = await createUser(s.db, 'reviewer', 'pw')
  s.db.prepare('UPDATE users SET unlisted=1 WHERE id=?').run(u.id)
  await createUser(s.db, 'bob', 'pw')
  const k = generateFederationKey()
  const probe = (name) => raw(s, signEnvelope({ from: 'x@m.example', to: `${name}@b.example`, op: 'ping', id: newOpId(), body: {} }, k.privateKey))
  const answers = [await probe('bob'), await probe('reviewer'), await probe('nobody')]
  assert.deepEqual(answers.map((a) => [a.status, a.json.error]), Array(3).fill([403, 'unknown_journal']))
})

test('POST /federation/v1: a known journal draws on its own bucket, and asks about users only once proved', async (t) => {
  const w = await world(t)
  const key = w.a.federation.key.privateKey
  const ping = (to) => raw(w.b, signEnvelope({ from: 'alice@a.example', to, op: 'ping', id: newOpId(), body: {} }, key))
  assert.equal((await ping('bob@b.example')).status, 200)
  assert.deepEqual((await ping('nobody@b.example')).json, { error: 'not_here' })
})

test('a contact journal cannot keep raising share cards: at most MAX_PENDING_OFFERS wait', async (t) => {
  const w = await world(t)
  const key = w.a.federation.key.privateKey
  const statuses = []
  for (let i = 0; i < MAX_PENDING_OFFERS + 3; i++) {
    const r = await raw(w.b, signEnvelope({
      from: 'alice@a.example', to: 'bob@b.example', op: 'grant.offer', id: newOpId(),
      body: { grant: `gr_many${i}`, level: 'read', sent: Date.now(), mission: { num: i + 1, title: `Mission ${i}` }, preview: {} },
    }, key))
    statuses.push(r.status === 200 ? 200 : r.json.error)
  }
  assert.deepEqual(statuses, [...Array(MAX_PENDING_OFFERS).fill(200), 'too_many_offers', 'too_many_offers', 'too_many_offers'])
  const cards = w.b.db.prepare("SELECT COUNT(*) AS n FROM items WHERE user_id=? AND consent='share' AND state='open'").get(w.users.bob.id).n
  assert.equal(cards, MAX_PENDING_OFFERS)
})

test('a peer\'s bucket is not drained by its envelopes replayed stale or sent to another journal', async (t) => {
  const w = await world(t, { federationLimits: { peerBurst: 3 } })
  const key = w.a.federation.key.privateKey
  const env = (over = {}) => signEnvelope({ from: 'alice@a.example', to: 'bob@b.example', op: 'ping', id: newOpId(), body: {}, ...over }, key)
  for (let i = 0; i < 10; i++) {
    assert.equal((await raw(w.b, env({ ts: Date.now() - 3600_000 }))).status, 401, 'stale')
    assert.equal((await raw(w.b, env({ to: 'carol@c.example' }))).status, 403, 'meant for another journal')
  }
  assert.equal((await raw(w.b, env())).status, 200, 'alice@a.example still has her bucket')
})

test('an attachment pull that meets the peer\'s limit waits once, then answers 503 peer_busy', async () => {
  const { makeReplicaMedia } = await import('../src/federation-media.js')
  const s = await startTestServer({ tokenKey: KEY, federationEnv: { federation: 'on', publicUrl: 'https://b.example' } })
  try {
    const u = await createUser(s.db, 'bob', 'pw')
    const d = s.db
    d.prepare("INSERT INTO fed_peers(host, base_url, key_pub, state, first_seen) VALUES('a.example','https://a.example',?,'active',0)").run(s.federation.key.pub)
    d.prepare(`INSERT INTO contacts(id,user_id,peer_user,peer_journal,peer_journal_key,peer_user_id,display_name,state,requested_by,created_at,updated_at)
      VALUES('ct_1',?,'alice','a.example',?,NULL,'alice','active',NULL,0,0)`).run(u.id, s.federation.key.pub)
    d.prepare(`INSERT INTO fed_grants_in(id,user_id,contact_id,peer_host,peer_grant_ref,owner_name,level,mission_title,mission_num,state,created_at,updated_at)
      VALUES('fg_1',?,'ct_1','a.example','gr_1','alice','read','M',1,'active',0,0)`).run(u.id)
    const id = 'ab'.repeat(16)
    d.prepare("INSERT INTO fed_media(id, fg_id, user_id, ref, mime, size, sha256, created_at) VALUES(?, 'fg_1', ?, 'blob1', 'image/png', 3, ?, 0)").run(id, u.id, 'c'.repeat(64))
    d.prepare(`INSERT INTO fed_replica_items(id, fg_id, user_id, ref, num, kind, state, title, body, created_at, updated_at, labels, links, comment_count, comments, attachments)
      VALUES('it_1','fg_1',?,'it_r',1,'task','open','t','',0,0,'[]','[]',0,'[]',?)`).run(u.id, JSON.stringify([{ blob_ref: id }]))
    let calls = 0
    const client = { request: async () => { calls++; return { status: 429, headers: { 'retry-after': '0' }, body: Buffer.alloc(0) } } }
    const media = makeReplicaMedia({ db: d, federation: s.federation, client, mediaDir: '/nonexistent', mediaMaxBytes: 1e6 })
    let status = null
    const res = { writeHead(st) { status = st }, end() {} }
    assert.equal(await media.serve({}, res, { userId: u.id }, id), true)
    assert.deepEqual([status, calls], [503, 2])
  } finally { await s.close() }
})
