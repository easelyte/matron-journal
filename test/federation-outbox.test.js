import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { makeTokenBox } from '../src/token-box.js'
import { ensureFederationKey } from '../src/federation-identity.js'
import { exportPublicKey, generateFederationKey, verifyEnvelope, MAX_ENVELOPE_BYTES } from '../src/federation-envelope.js'
import { makeFederationClient } from '../src/federation-client.js'
import {
  backoffMs, enqueue, cancelSubject, makeOutbox, listOutbox, resendDead, discardDead,
  BACKOFF_BASE_MS, BACKOFF_CAP_MS, OUTBOX_MAX_AGE_MS, PEER_LIVE_CAP,
} from '../src/federation-outbox.js'
import { startTestServer } from './helpers.js'
import { RESEND_WINDOW_MS } from '../src/federation-outbox.js'

const KEY = 'd'.repeat(64)
const quietLog = { log() {}, error() {}, warn() {} }

// A journal (a.example) with user alice, sending to b.example through a
// scripted client. `answers` is a queue of what postEnvelope returns (or
// throws); an empty queue answers a signed 200.
async function rig({ peerState = 'active' } = {}) {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const self = generateFederationKey()
  const peerKey = generateFederationKey()
  db.prepare('INSERT INTO fed_peers(host, base_url, key_pub, state, first_seen) VALUES(?,?,?,?,?)')
    .run('b.example', 'https://b.example', exportPublicKey(peerKey.publicKey), peerState, 1)
  let clock = 1_700_000_000_000
  const sent = []
  const answers = []
  const client = {
    async postEnvelope(baseUrl, envelope, key) {
      sent.push({ baseUrl, envelope })
      assert.equal(exportPublicKey(key), exportPublicKey(peerKey.publicKey))
      const a = answers.shift() ?? { status: 200, body: { ok: true, result: { applied: true } }, signed: true }
      if (a instanceof Error) throw a
      return a
    },
  }
  const ops = {}
  const outbox = makeOutbox({ db, federation: { key: { privateKey: self.privateKey } }, client, ops, now: () => clock, random: () => 1, log: quietLog })
  const q = (over = {}) => enqueue(db, { userId: alice.id, from: 'alice@a.example', to: 'bob@b.example', op: 'test.op', body: { n: 1 }, subject: 'mission:m1', now: clock, ...over })
  const row = (id) => db.prepare('SELECT * FROM fed_outbox WHERE id=?').get(id)
  return {
    db, alice, self, sent, answers, ops, outbox, q, row,
    advance: (ms) => { clock += ms },
    now: () => clock,
    notices: () => db.prepare("SELECT * FROM items WHERE user_id=? AND kind='notice'").all(alice.id),
  }
}

test('backoff: 30 s doubling to 1 h, jittered into the upper half', () => {
  assert.equal(backoffMs(1, () => 1), BACKOFF_BASE_MS)
  assert.equal(backoffMs(1, () => 0), BACKOFF_BASE_MS / 2)
  assert.equal(backoffMs(2, () => 1), 2 * BACKOFF_BASE_MS)
  assert.equal(backoffMs(5, () => 1), 16 * BACKOFF_BASE_MS)
  assert.equal(backoffMs(30, () => 1), BACKOFF_CAP_MS)
  assert.equal(backoffMs(30, () => 0), BACKOFF_CAP_MS / 2)
})

test('enqueue: refuses bad addresses, bodies that cannot be signed, and a full outbox', async () => {
  const r = await rig()
  assert.throws(() => r.q({ to: 'bob' }), { message: 'bad_address' })
  assert.throws(() => r.q({ body: { n: 1n } }), { message: 'not_canonical' })
  assert.throws(() => r.q({ body: { pad: 'x'.repeat(MAX_ENVELOPE_BYTES) } }), { message: 'too_large' })
  const ins = r.db.prepare(`INSERT INTO fed_outbox(id, user_id, peer_host, from_addr, to_addr, subject, op, body, next_at, expires_at, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
  r.db.transaction(() => { for (let i = 0; i < PEER_LIVE_CAP; i++) ins.run(`x${i}`, r.alice.id, 'b.example', 'a@a.example', 'b@b.example', `s${i}`, 'test.op', '{}', 0, 0, 0) })()
  assert.throws(() => r.q(), { message: 'outbox_full' })
  assert.ok(r.q({ urgent: true }), 'an urgent op is never refused for space')
  assert.ok(r.q({ to: 'carol@c.example' }), 'another peer has its own budget')
})

test('delivery: signed with the queued id and a fresh ts; a signed 2xx acknowledges it', async () => {
  const r = await rig()
  let acked = null
  r.ops['test.op'] = { onAcked: (db, entry, result) => { acked = { id: entry.id, result } } }
  const id = r.q()
  await r.outbox.tick()
  assert.equal(r.sent.length, 1)
  const e = r.sent[0].envelope
  assert.deepEqual([e.id, e.op, e.from, e.to, e.body, e.ts], [id, 'test.op', 'alice@a.example', 'bob@b.example', { n: 1 }, r.now()])
  assert.equal(r.sent[0].baseUrl, 'https://b.example')
  assert.doesNotThrow(() => verifyEnvelope(e, r.self.publicKey, { now: r.now() }))
  assert.equal(r.row(id).state, 'sent')
  assert.deepEqual(acked, { id, result: { applied: true } })
  await r.outbox.tick()
  assert.equal(r.sent.length, 1, 'nothing is sent twice')
})

test('retries keep the id and body, re-sign with a new ts, and wait out the backoff', async () => {
  const r = await rig()
  const id = r.q()
  r.answers.push({ status: 503, body: null, signed: false }, Object.assign(new Error('network'), { why: 'ECONNRESET' }), { status: 429, body: { error: 'rate_limited' }, signed: true })
  await r.outbox.tick()
  assert.equal(r.row(id).attempts, 1)
  assert.equal(r.row(id).next_at, r.now() + BACKOFF_BASE_MS)
  await r.outbox.tick()
  assert.equal(r.sent.length, 1, 'not before next_at')
  r.advance(BACKOFF_BASE_MS)
  await r.outbox.tick()
  assert.equal(r.row(id).next_at, r.now() + 2 * BACKOFF_BASE_MS)
  assert.equal(r.row(id).last_error, 'network: ECONNRESET')
  r.advance(2 * BACKOFF_BASE_MS)
  await r.outbox.tick()
  r.advance(4 * BACKOFF_BASE_MS)
  await r.outbox.tick()
  assert.equal(r.row(id).state, 'sent')
  assert.equal(r.sent.length, 4)
  assert.ok(r.sent.every((s) => s.envelope.id === id && s.envelope.body.n === 1))
  assert.equal(new Set(r.sent.map((s) => s.envelope.ts)).size, 4)
})

test('an unsigned answer is never the peer\'s word: a 2xx is not an acknowledgement and a 4xx is retried', async () => {
  const r = await rig()
  const a = r.q({ subject: 's-a' })
  const b = r.q({ subject: 's-b' })
  r.answers.push({ status: 200, body: { ok: true }, signed: false }, { status: 403, body: null, signed: false })
  await r.outbox.tick()
  assert.equal(r.row(a).state, 'queued')
  assert.equal(r.row(a).last_error, 'unsigned answer')
  assert.deepEqual([r.row(b).state, r.row(b).last_status, r.row(b).last_error], ['queued', 403, 'unsigned answer'])
})

test('FIFO per subject: a waiting entry holds back later ones on its subject only', async () => {
  const r = await rig()
  const first = r.q({ subject: 'mission:m1', body: { n: 1 } })
  const second = r.q({ subject: 'mission:m1', body: { n: 2 } })
  const other = r.q({ subject: 'mission:m2', body: { n: 3 } })
  r.answers.push({ status: 500, body: null, signed: false })
  await r.outbox.tick()
  assert.deepEqual(r.sent.map((s) => s.envelope.body.n), [1, 3])
  assert.equal(r.row(second).attempts, 0)
  assert.equal(r.row(other).state, 'sent')
  r.advance(BACKOFF_BASE_MS)
  await r.outbox.tick()
  assert.equal(r.row(first).state, 'sent')
  await r.outbox.tick()
  assert.deepEqual(r.sent.map((s) => s.envelope.body.n), [1, 3, 1, 2])
  assert.equal(r.row(second).state, 'sent')
})

test('dead: a permanent refusal blocks its subject, files one notice per peer, and Resend reuses the ids', async () => {
  const r = await rig()
  let deadHook = 0
  r.ops['test.op'] = { onDead: () => { deadHook += 1 } }
  const a = r.q({ subject: 's1', body: { n: 1 } })
  const behind = r.q({ subject: 's1', body: { n: 2 } })
  const b = r.q({ subject: 's2', body: { n: 3 } })
  r.answers.push({ status: 403, body: { error: 'grant_revoked' }, signed: true }, { status: 409, body: { error: 'id_reused' }, signed: true })
  await r.outbox.tick()
  assert.deepEqual([r.row(a).state, r.row(a).last_error, r.row(a).last_status], ['dead', 'grant_revoked', 403])
  assert.equal(r.row(b).state, 'dead')
  assert.equal(deadHook, 2)
  await r.outbox.tick()
  assert.equal(r.row(behind).state, 'queued', 'a dead entry blocks its subject')
  assert.equal(r.sent.length, 2)
  const notices = r.notices()
  assert.equal(notices.length, 1)
  assert.match(notices[0].title, /Couldn't deliver to b\.example/)
  assert.match(notices[0].body, /refused an update \(grant_revoked\)/)
  assert.deepEqual(listOutbox(r.db, r.alice.id).map((e) => e.id), [a, b])

  assert.deepEqual(resendDead(r.db, r.alice.id, 'b.example', r.now()), { resent: 2, too_old: 0 })
  await r.outbox.tick()
  await r.outbox.tick()
  assert.deepEqual(r.sent.slice(2).map((s) => s.envelope.id), [a, b, behind])
  assert.ok([a, b, behind].every((id) => r.row(id).state === 'sent'))
})

test('dead: Discard ends the entries and unblocks the subject; another user\'s entries are untouched', async () => {
  const r = await rig()
  const a = r.q({ subject: 's1' })
  const behind = r.q({ subject: 's1' })
  r.answers.push({ status: 400, body: { error: 'malformed' }, signed: true })
  await r.outbox.tick()
  assert.equal(discardDead(r.db, r.alice.id + 1, 'b.example', r.now()), 0)
  assert.equal(discardDead(r.db, r.alice.id, 'b.example', r.now()), 1)
  assert.equal(r.row(a).state, 'cancelled')
  await r.outbox.tick()
  assert.equal(r.row(behind).state, 'sent')
})

test('a signed 401 stale is retried at once with a fresh ts; skew that lasts three attempts is permanent', async () => {
  const r = await rig()
  const id = r.q()
  const stale = () => ({ status: 401, body: { error: 'stale', clock: r.now() + 600_000 }, signed: true })
  r.answers.push(stale())
  await r.outbox.tick()
  assert.equal(r.row(id).state, 'queued')
  assert.equal(r.row(id).next_at, r.now())
  assert.match(r.row(id).last_error, /stale: 600000 ms/)
  r.answers.push(stale(), stale())
  await r.outbox.tick()
  await r.outbox.tick()
  assert.equal(r.row(id).state, 'dead')
  assert.match(r.row(id).last_error, /^clock_skew: 600000 ms/)
  assert.equal(r.sent.length, 3)
})

test('seven days without an acknowledgement: dead, with a notice saying so', async () => {
  const r = await rig()
  const id = r.q()
  r.answers.push(...Array(400).fill({ status: 502, body: null, signed: false }))
  for (let i = 0; i < 300 && r.row(id).state === 'queued'; i++) {
    r.advance(BACKOFF_CAP_MS)
    await r.outbox.tick()
  }
  assert.equal(r.row(id).state, 'dead')
  assert.equal(r.row(id).last_error, 'expired')
  assert.ok(r.now() >= r.row(id).created_at + OUTBOX_MAX_AGE_MS)
  assert.match(r.notices()[0].body, /could not be reached for 7 days/)
})

test('the sender checks its own records before each attempt', async () => {
  const r = await rig()
  let allowed = true
  r.ops['test.op'] = { stillAllowed: () => allowed }
  const a = r.q({ subject: 's1' })
  allowed = false
  await r.outbox.tick()
  assert.equal(r.row(a).state, 'cancelled')
  assert.equal(r.row(a).last_error, 'no_longer_allowed')
  assert.equal(r.sent.length, 0)
})

test('urgent ops go first, and can cancel what is queued on their subject', async () => {
  const r = await rig()
  const normal = r.q({ subject: 'mission:m1', op: 'mission.event' })
  const queuedOnGrant = r.q({ subject: 'grant:g1', op: 'mission.event' })
  const revoke = r.q({ subject: 'grant:g1', op: 'grant.revoke', urgent: true, cancelSubject: true })
  assert.equal(r.row(queuedOnGrant).state, 'cancelled')
  await r.outbox.tick()
  assert.deepEqual(r.sent.map((s) => s.envelope.op), ['grant.revoke', 'mission.event'])
  assert.equal(r.row(revoke).state, 'sent')
  assert.equal(r.row(normal).state, 'sent')
  const later = r.q({ subject: 'mission:m9' })
  assert.equal(cancelSubject(r.db, { peerHost: 'b.example', subject: 'mission:m9', now: r.now() }), 1)
  assert.equal(r.row(later).state, 'cancelled')
})

test('an unknown or blocked peer, or a refused destination, is permanent; a network error is not', async () => {
  const r = await rig({ peerState: 'blocked' })
  const a = r.q()
  await r.outbox.tick()
  assert.deepEqual([r.row(a).state, r.row(a).last_error], ['dead', 'peer_blocked'])
  const u = r.q({ to: 'carol@c.example' })
  await r.outbox.tick()
  assert.deepEqual([r.row(u).state, r.row(u).last_error], ['dead', 'unknown_journal'])

  const r2 = await rig()
  const d = r2.q({ subject: 's1' })
  const n = r2.q({ subject: 's2' })
  r2.answers.push(Object.assign(new Error('destination_refused'), { why: 'address' }), Object.assign(new Error('timeout'), { why: 'total' }))
  await r2.outbox.tick()
  assert.deepEqual([r2.row(d).state, r2.row(d).last_error], ['dead', 'destination_refused: address'])
  assert.deepEqual([r2.row(n).state, r2.row(n).last_error], ['queued', 'timeout: total'])
})

// --- Two real journals --------------------------------------------------------

test('end to end: a lost acknowledgement is answered from the receipt, and the op applies once', async (t) => {
  let applied = 0
  const b = await startTestServer({
    tokenKey: KEY, federationEnv: { federation: 'on', publicUrl: 'https://b.example' },
    federationOps: { 'test.count': { apply: () => ({ n: ++applied }), errors: {} } },
  })
  t.after(() => b.close())
  const client = makeFederationClient({ allowHttp: true, allowHosts: ['127.0.0.1'] })
  const a = await startTestServer({ tokenKey: KEY, federationEnv: { federation: 'on', publicUrl: 'https://a.example' }, federationClient: client })
  t.after(() => a.close())
  const alice = await createUser(a.db, 'alice', 'pw')
  await createUser(b.db, 'bob', 'pw')
  const aKey = ensureFederationKey(a.db, makeTokenBox(KEY))
  const bKey = ensureFederationKey(b.db, makeTokenBox(KEY))
  a.db.prepare('INSERT INTO fed_peers(host, base_url, key_pub, first_seen) VALUES(?,?,?,?)').run('b.example', b.base, bKey.pub, Date.now())
  b.db.prepare('INSERT INTO fed_peers(host, base_url, key_pub, first_seen) VALUES(?,?,?,?)').run('a.example', a.base, aKey.pub, Date.now())

  const id = enqueue(a.db, { userId: alice.id, from: 'alice@a.example', to: 'bob@b.example', op: 'test.count', body: { x: 1 }, subject: 'mission:m1' })
  // The first attempt reaches B, but its answer is lost on the way back.
  const lossy = { postEnvelope: async (...args) => { await client.postEnvelope(...args); throw Object.assign(new Error('network'), { why: 'ECONNRESET' }) } }
  const lossyBox = makeOutbox({ db: a.db, federation: { key: aKey }, client: lossy, log: quietLog })
  await lossyBox.tick()
  assert.equal(applied, 1)
  assert.equal(a.db.prepare('SELECT state FROM fed_outbox WHERE id=?').get(id).state, 'queued')
  a.db.prepare('UPDATE fed_outbox SET next_at=0 WHERE id=?').run(id)
  await a.federationOutbox.tick()
  assert.equal(a.db.prepare('SELECT state FROM fed_outbox WHERE id=?').get(id).state, 'sent')
  assert.equal(applied, 1, 'the retry was answered from the receipt')
})

test('routes: a client lists, resends and discards its own undelivered entries; an agent cannot', async (t) => {
  const s = await startTestServer({ tokenKey: KEY, federationEnv: { federation: 'on', publicUrl: 'https://a.example' } })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const agent = createAgent(s.db, alice.id, 'box-a')
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'phone' } })
  const token = login.json.token
  const id = enqueue(s.db, { userId: alice.id, from: 'alice@a.example', to: 'bob@b.example', op: 'test.op', body: {} })
  s.db.prepare("UPDATE fed_outbox SET state='dead', last_error='grant_revoked' WHERE id=?").run(id)

  assert.equal((await s.http('/federation/outbox', { token: agent.token })).status, 403)
  const list = await s.http('/federation/outbox', { token })
  assert.equal(list.status, 200)
  assert.deepEqual(list.json.entries.map((e) => [e.id, e.peer, e.state, e.last_error]), [[id, 'b.example', 'dead', 'grant_revoked']])
  assert.ok(!('body' in list.json.entries[0]))
  assert.equal((await s.http('/federation/outbox?state=nope', { token })).status, 400)
  assert.equal((await s.http('/federation/outbox/resend', { method: 'POST', token, body: { peer: 'Bad Host' } })).status, 400)
  assert.deepEqual((await s.http('/federation/outbox/resend', { method: 'POST', token, body: { peer: 'b.example' } })).json, { resent: 1, too_old: 0 })
  s.db.prepare("UPDATE fed_outbox SET state='dead' WHERE id=?").run(id)
  assert.deepEqual((await s.http('/federation/outbox/discard', { method: 'POST', token, body: { peer: 'b.example' } })).json, { discarded: 1 })
  assert.equal((await s.http('/federation/outbox/discard', { method: 'POST', token: agent.token, body: { peer: 'b.example' } })).status, 403)
})

test('a pass with nothing due does not stop later passes', async () => {
  const r = await rig()
  await r.outbox.tick()
  await r.outbox.tick()
  const id = r.q()
  await r.outbox.tick()
  assert.equal(r.row(id).state, 'sent')
})

test('resend: only while the peer is sure to hold the receipt; blocked successors get a fresh 7 days', async () => {
  const r = await rig()
  const old = r.q({ subject: 's1' })
  const behind = r.q({ subject: 's1' })
  r.answers.push({ status: 403, body: { error: 'x' }, signed: true })
  await r.outbox.tick()
  const unrelated = r.q({ subject: 's9' })
  r.answers.push({ status: 503, body: null, signed: false })
  await r.outbox.tick()
  r.advance(6 * 24 * 3600 * 1000)
  assert.deepEqual(resendDead(r.db, r.alice.id, 'b.example', r.now()), { resent: 1, too_old: 0 })
  assert.equal(r.row(behind).expires_at, r.now() + OUTBOX_MAX_AGE_MS)
  assert.equal(r.row(unrelated).expires_at, r.row(unrelated).created_at + OUTBOX_MAX_AGE_MS, 'another subject keeps its own deadline')
  r.answers.push({ status: 403, body: { error: 'x' }, signed: true })
  await r.outbox.tick()
  assert.equal(r.row(old).state, 'dead')
  r.advance(10 * 24 * 3600 * 1000)
  resendDead(r.db, r.alice.id, 'b.example', r.now())
  assert.equal(r.row(behind).expires_at, r.now() + OUTBOX_MAX_AGE_MS, 'a never-attempted successor always gets a full 7 days')
  r.answers.push({ status: 403, body: { error: 'x' }, signed: true })
  await r.outbox.tick()
  r.advance(RESEND_WINDOW_MS)
  assert.deepEqual(resendDead(r.db, r.alice.id, 'b.example', r.now()), { resent: 0, too_old: 1 })
  assert.equal(r.row(old).state, 'dead')
})

test('a second death after a resend files a new notice', async () => {
  const r = await rig()
  r.q()
  r.answers.push({ status: 403, body: { error: 'x' }, signed: true })
  await r.outbox.tick()
  assert.equal(r.notices().length, 1)
  r.advance(1000)
  resendDead(r.db, r.alice.id, 'b.example', r.now())
  r.answers.push({ status: 403, body: { error: 'x' }, signed: true })
  await r.outbox.tick()
  assert.equal(r.notices().length, 2)
})

test('urgent ops do not wait behind an earlier op on their subject', async () => {
  const r = await rig()
  const early = r.q({ subject: 'contact:c1', op: 'mission.event' })
  r.answers.push({ status: 503, body: null, signed: false })
  await r.outbox.tick()
  const remove = r.q({ subject: 'contact:c1', op: 'contact.remove', urgent: true })
  await r.outbox.tick()
  assert.equal(r.row(remove).state, 'sent')
  assert.equal(r.row(early).state, 'queued')
})

test('a stillAllowed check that throws holds the op back for a retry', async () => {
  const r = await rig()
  r.ops['test.op'] = { stillAllowed: () => { throw new Error('boom') } }
  const id = r.q()
  await r.outbox.tick()
  assert.equal(r.sent.length, 0)
  assert.deepEqual([r.row(id).state, r.row(id).last_error], ['queued', 'check_failed'])
})

test('a cancellation made while an attempt is in flight stands, and a cancelled entry selected by the pass is not sent', async () => {
  const r = await rig()
  const a = r.q({ subject: 's1' })
  const b = r.q({ subject: 's2' })
  let release
  const gate = new Promise((res) => { release = res })
  const client = {
    postEnvelope: async (url, e) => {
      if (e.id === a) {
        // While a is in flight, both rows are cancelled here.
        r.db.prepare("UPDATE fed_outbox SET state='cancelled' WHERE id IN (?,?)").run(a, b)
        await gate
        return { status: 403, body: { error: 'x' }, signed: true }
      }
      r.sent.push(e)
      return { status: 200, body: { ok: true, result: {} }, signed: true }
    },
  }
  const box = makeOutbox({ db: r.db, federation: { key: { privateKey: r.self.privateKey } }, client, now: r.now, log: quietLog })
  const pass = box.tick()
  release()
  await pass
  assert.equal(r.row(a).state, 'cancelled')
  assert.equal(r.row(b).state, 'cancelled')
  assert.equal(r.sent.length, 0)
})

test('after stop, no pass starts', async () => {
  const r = await rig()
  await r.outbox.stop()
  const id = r.q()
  await r.outbox.tick()
  assert.equal(r.row(id).state, 'queued')
})

test('the first undelivered notice announces the People conversation to clients', async (t) => {
  const s = await startTestServer({ tokenKey: KEY, federationEnv: { federation: 'on', publicUrl: 'https://a.example' },
    federationClient: { postEnvelope: async () => ({ status: 403, body: { error: 'x' }, signed: true }) } })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  s.db.prepare('INSERT INTO fed_peers(host, base_url, key_pub, first_seen) VALUES(?,?,?,?)').run('b.example', 'https://b.example', exportPublicKey(generateFederationKey().publicKey), 1)
  enqueue(s.db, { userId: alice.id, from: 'alice@a.example', to: 'bob@b.example', op: 'test.op', body: {} })
  await s.federationOutbox.tick()
  const convo = s.db.prepare("SELECT id FROM conversations WHERE owner_user_id=? AND system='people'").get(alice.id)
  assert.ok(convo)
  const types = s.db.prepare('SELECT type FROM events WHERE convo_id=? ORDER BY seq').all(convo.id).map((e) => e.type)
  assert.equal(types[0], 'convo_meta')
  assert.ok(types.includes('item'))
})

test('hooks: onAcked commits with the acknowledgement, never runs for an entry cancelled in flight, and a throw retries', async () => {
  const r = await rig()
  const acked = []
  const after = []
  r.ops['test.op'] = {
    onAcked: (db, entry, result) => {
      if (entry.meta?.fail) throw new Error('boom')
      acked.push([entry.id, entry.meta, result])
      return () => after.push(entry.id)
    },
  }
  const ok = r.q({ meta: { key: 'k1' } })
  await r.outbox.tick()
  assert.deepEqual(acked, [[ok, { key: 'k1' }, { applied: true }]])
  assert.deepEqual(after, [ok])

  // Cancelled while the request was in flight: the answer changes nothing.
  const gone = r.q({ subject: 'mission:m2' })
  // The entry is cancelled while its request is out; the answer comes after.
  r.answers.push({ get status() { r.db.prepare("UPDATE fed_outbox SET state='cancelled' WHERE id=?").run(gone); return 200 }, body: { ok: true, result: {} }, signed: true })
  await r.outbox.tick()
  assert.equal(r.row(gone).state, 'cancelled')
  assert.equal(acked.length, 1)

  // A throwing onAcked rolls the acknowledgement back; the entry retries.
  const bad = r.q({ subject: 'mission:m3', meta: { fail: true } })
  await r.outbox.tick()
  assert.deepEqual([r.row(bad).state, r.row(bad).last_error], ['queued', 'ack_failed'])
})

test('hooks: a string from stillAllowed ends the entry dead with that error; a denied journal gets nothing more', async () => {
  const r = await rig()
  const dead = []
  r.ops['test.op'] = { stillAllowed: () => 'key_changed', onDead: (db, entry, info) => { dead.push(info.error); return 'discard' } }
  const id = r.q()
  await r.outbox.tick()
  assert.deepEqual([r.row(id).state, r.row(id).last_error, dead], ['cancelled', 'key_changed', ['key_changed']])
  assert.equal(r.sent.length, 0)
  assert.equal(r.notices().length, 0, 'a discarded entry files no undelivered notice')

  const denied = makeOutbox({ db: r.db, federation: { key: { privateKey: r.self.privateKey }, denyJournals: ['b.example'] }, client: { postEnvelope: async () => assert.fail('sent') }, log: quietLog, now: r.now })
  const d = r.q({ op: 'other.op', subject: 'x' })
  await denied.tick()
  assert.deepEqual([r.row(d).state, r.row(d).last_error], ['dead', 'journal_not_allowed'])
})
