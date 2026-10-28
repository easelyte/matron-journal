import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startTestServer } from './helpers.js'
import { createUser, createAgent, setPassword, login, changePassword } from '../src/auth.js'
import { openDb } from '../src/db.js'
import { normaliseEmail, issueResetToken, resetPassword, findResetTarget, setUserEmail, RESETS_PER_USER_HOUR, RESET_TTL_MS } from '../src/password-reset.js'
import { makeConfiguredMailer, makeResendMailer, parsePublicUrl } from '../src/mailer.js'

// A mailer that keeps what it was asked to send.
function fakeMailer({ fail = false } = {}) {
  const sent = []
  return {
    sent,
    publicUrl: 'https://journal.example.com',
    async send(m) { if (fail) throw new Error('resend: HTTP 500'); sent.push(m) },
  }
}
const tokenFrom = (mail) => mail.text.match(/#token=([A-Za-z0-9_-]+)/)[1]
const settle = () => new Promise((r) => setImmediate(r))

async function journal(t, opts = {}) {
  const mailer = opts.mailer === undefined ? fakeMailer() : opts.mailer
  const s = await startTestServer({ mailer })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'hunter22')
  setUserEmail(s.db, alice.id, 'Alice@Example.com')
  await createUser(s.db, 'bob', 'hunter22') // no address
  const signIn = async (username, password = 'hunter22', device_name = 'mac') =>
    s.http('/login', { method: 'POST', body: { username, password, device_name } })
  return { s, mailer, alice, signIn }
}

test('GET /password/forgot says whether reset by email is on', async (t) => {
  const on = await journal(t)
  assert.deepEqual((await on.s.http('/password/forgot')).json, { enabled: true })
  const off = await journal(t, { mailer: null })
  assert.deepEqual((await off.s.http('/password/forgot')).json, { enabled: false })
  const r = await off.s.http('/password/forgot', { method: 'POST', body: { identifier: 'alice' } })
  assert.equal(r.status, 503)
})

test('forgot: the same answer for an account with an address, one without, and none; only the first gets mail', async (t) => {
  const { s, mailer } = await journal(t)
  const bad = await s.http('/password/forgot', { method: 'POST', body: { identifier: '' } })
  assert.equal(bad.status, 400)
  for (const identifier of ['alice', 'bob', 'nobody@example.com', 'ALICE@example.COM']) {
    const r = await s.http('/password/forgot', { method: 'POST', body: { identifier } })
    assert.equal(r.status, 200, identifier)
    assert.deepEqual(r.json, { ok: true }, identifier)
  }
  await settle()
  assert.equal(mailer.sent.length, 2, 'by username and by address, case-insensitive')
  assert.equal(mailer.sent[0].to, 'Alice@Example.com')
  assert.match(mailer.sent[0].subject, /Reset your Matron password/)
  assert.match(mailer.sent[0].text, /https:\/\/journal\.example\.com\/app\/reset-password#token=/)
  assert.match(mailer.sent[0].text, /"alice"/)
})

test('forgot: tokens are stored hashed, and a newer link replaces an older one', async (t) => {
  const { s, mailer } = await journal(t)
  await s.http('/password/forgot', { method: 'POST', body: { identifier: 'alice' } })
  await s.http('/password/forgot', { method: 'POST', body: { identifier: 'alice' } })
  await settle()
  const [first, second] = mailer.sent.map(tokenFrom)
  const rows = s.db.prepare('SELECT token_hash FROM password_resets').all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].token_hash, crypto.createHash('sha256').update(second).digest('hex'))
  assert.ok(!JSON.stringify(rows).includes(second), 'the token itself is never stored')
  const old = await s.http('/password/reset', { method: 'POST', body: { token: first, new_password: 'brand-new-pw' } })
  assert.equal(old.status, 400)
  assert.deepEqual(old.json, { error: 'invalid_token' })
})

test('reset: sets the password, signs every client device out, keeps agents, and works once', async (t) => {
  const { s, mailer, alice, signIn } = await journal(t)
  const mac = (await signIn('alice')).json.token
  const box = createAgent(s.db, alice.id, 'box-a')
  await s.http('/password/forgot', { method: 'POST', body: { identifier: 'alice' } })
  await settle()
  const token = tokenFrom(mailer.sent[0])
  const weak = await s.http('/password/reset', { method: 'POST', body: { token, new_password: 'short' } })
  assert.deepEqual(weak.json, { error: 'weak_password' })
  const ok = await s.http('/password/reset', { method: 'POST', body: { token, new_password: 'brand-new-pw' } })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json, { ok: true, signed_out: 1 })
  assert.equal((await s.http('/snapshot', { token: mac })).status, 401, 'existing sessions end')
  assert.equal((await s.http('/snapshot', { token: box.token })).status, 200, 'agent boxes stay connected')
  assert.equal((await signIn('alice')).status, 403, 'the old password is gone')
  assert.equal((await signIn('alice', 'brand-new-pw')).status, 200)
  const again = await s.http('/password/reset', { method: 'POST', body: { token, new_password: 'another-pw-1' } })
  assert.deepEqual(again.json, { error: 'invalid_token' }, 'single use')
})

test('reset: an expired link fails, and so does a made-up one', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'hunter22')
  setUserEmail(db, alice.id, 'alice@example.com')
  const t0 = Date.now()
  const token = issueResetToken(db, alice.id, t0)
  assert.deepEqual(await resetPassword(db, token, 'brand-new-pw', t0 + RESET_TTL_MS + 1), { ok: false })
  assert.deepEqual(await resetPassword(db, 'not-a-token', 'brand-new-pw'), { ok: false })
  assert.deepEqual(await resetPassword(db, 'x'.repeat(500), 'brand-new-pw'), { ok: false })
})

test('reset: two uses of the same link at once — exactly one wins', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'hunter22')
  setUserEmail(db, alice.id, 'alice@example.com')
  const token = issueResetToken(db, alice.id)
  const r = await Promise.all([resetPassword(db, token, 'first-pw-123'), resetPassword(db, token, 'second-pw-12')])
  assert.deepEqual(r.map((x) => x.ok).sort(), [false, true])
})

test('issueResetToken: at most a few links an hour per account, however many people ask', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'hunter22')
  const t0 = Date.now()
  for (let i = 0; i < RESETS_PER_USER_HOUR; i++) assert.ok(issueResetToken(db, alice.id, t0 + i))
  assert.equal(issueResetToken(db, alice.id, t0 + 10), null)
  assert.ok(issueResetToken(db, alice.id, t0 + 3600001), 'the cap rolls over after an hour')
})

test('forgot and reset share a per-IP budget', async (t) => {
  const { s } = await journal(t)
  const codes = []
  for (let i = 0; i < 7; i++) codes.push((await s.http('/password/forgot', { method: 'POST', body: { identifier: `x${i}` } })).status)
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429])
  const r = await s.http('/password/reset', { method: 'POST', body: { token: 'abc', new_password: 'brand-new-pw' } })
  assert.equal(r.status, 429)
})

test('forgot: a mail provider failure is logged, and the answer is still the same', async (t) => {
  const { s } = await journal(t, { mailer: fakeMailer({ fail: true }) })
  const r = await s.http('/password/forgot', { method: 'POST', body: { identifier: 'alice' } })
  assert.deepEqual(r.json, { ok: true })
})

test('reset clears the account\'s password lockout', async (t) => {
  const { s, mailer, signIn } = await journal(t)
  const mac = (await signIn('alice')).json.token
  const setEmail = (password) => s.http('/account/email', { method: 'PUT', token: mac, body: { password, email: null } })
  for (let i = 0; i < 5; i++) assert.equal((await setEmail(`wrong-${i}`)).status, 401)
  assert.equal((await s.http('/account/email', { method: 'PUT', token: mac, body: { password: 'hunter22', email: null } })).status, 429, 'locked')
  await s.http('/password/forgot', { method: 'POST', body: { identifier: 'alice' } })
  await settle()
  await s.http('/password/reset', { method: 'POST', body: { token: tokenFrom(mailer.sent[0]), new_password: 'brand-new-pw' } })
  assert.equal((await signIn('alice', 'brand-new-pw')).status, 200, 'the new password works at once')
})

test('account email: read, set with the current password, clear; bad address, wrong password, taken address', async (t) => {
  const { s, signIn } = await journal(t)
  const bob = (await signIn('bob')).json.token
  assert.deepEqual((await s.http('/account/email', { token: bob })).json, { email: null, reset_by_email: true })
  const put = (body) => s.http('/account/email', { method: 'PUT', token: bob, body })
  assert.deepEqual((await put({ password: 'hunter22', email: 'not an address' })).json, { error: 'bad_email' })
  assert.deepEqual((await put({ password: 'wrong-pw', email: 'bob@example.com' })).json, { error: 'bad_password' })
  const taken = await put({ password: 'hunter22', email: 'alice@EXAMPLE.com' })
  assert.equal(taken.status, 409)
  assert.deepEqual((await put({ password: 'hunter22', email: ' bob@example.com ' })).json, { email: 'bob@example.com' })
  assert.equal((await s.http('/account/email', { token: bob })).json.email, 'bob@example.com')
  assert.deepEqual((await put({ password: 'hunter22', email: null })).json, { email: null })
  const bobUser = s.db.prepare("SELECT id FROM users WHERE name='bob'").get()
  const agent = createAgent(s.db, bobUser.id, 'box-b')
  assert.equal((await s.http('/account/email', { token: agent.token })).status, 403)
})

test('normaliseEmail and findResetTarget', () => {
  assert.equal(normaliseEmail(' a@b.co '), 'a@b.co')
  for (const bad of ['', 'a', 'a@b', 'a b@c.d', '<a@b.c>', 'a@b.c,d@e.f', 42, null, `${'a'.repeat(250)}@b.co`]) assert.equal(normaliseEmail(bad), null, String(bad))
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(name, password_hash, created_at, email) VALUES('carol','x',1,'carol@example.com'),('dave','x',1,NULL)").run()
  assert.equal(findResetTarget(db, 'carol').name, 'carol')
  assert.equal(findResetTarget(db, 'CAROL@example.com').name, 'carol')
  assert.equal(findResetTarget(db, 'dave'), null, 'no address, nothing to mail')
  assert.equal(findResetTarget(db, 'Carol'), null, 'usernames are exact')
})

test('mailer: Resend request shape, failure, and config resolution', async () => {
  const calls = []
  const ok = makeResendMailer({ apiKey: 're_test', from: 'Matron <no-reply@example.com>', fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 } } })
  await ok.send({ to: 'a@example.com', subject: 's', text: 't', html: '<p>h</p>' })
  assert.equal(calls[0].url, 'https://api.resend.com/emails')
  assert.equal(calls[0].init.headers.authorization, 'Bearer re_test')
  assert.deepEqual(JSON.parse(calls[0].init.body), { from: 'Matron <no-reply@example.com>', to: ['a@example.com'], subject: 's', text: 't', html: '<p>h</p>' })
  const bad = makeResendMailer({ apiKey: 're_test', from: 'x@example.com', fetchImpl: async () => ({ ok: false, status: 422 }) })
  await assert.rejects(bad.send({ to: 'a@example.com', subject: 's', text: 't', html: 'h' }), (err) => /HTTP 422/.test(err.message) && !err.message.includes('re_test'))

  const quiet = { log() {}, error() {} }
  assert.equal(makeConfiguredMailer({ env: {}, log: quiet }), null)
  assert.equal(makeConfiguredMailer({ env: { MATRON_RESEND_API_KEY: 'k', MATRON_MAIL_FROM: 'x@example.com' }, log: quiet }), null, 'no public URL, off')
  assert.equal(makeConfiguredMailer({ env: { MATRON_RESEND_API_KEY: 'k', MATRON_MAIL_FROM: 'x@example.com', MATRON_PUBLIC_URL: 'http://journal.example.com' }, log: quiet }), null, 'plain http, off')
  const m = makeConfiguredMailer({ env: { MATRON_RESEND_API_KEY: 'k', MATRON_MAIL_FROM: 'x@example.com', MATRON_PUBLIC_URL: 'https://journal.example.com/some/path' }, log: quiet })
  assert.equal(m.publicUrl, 'https://journal.example.com')
  assert.equal(parsePublicUrl('http://localhost:9810'), 'http://localhost:9810')
  assert.equal(parsePublicUrl('not a url'), null)
})

test('admin: set and clear a user\'s address over HTTP; the list shows it', async (t) => {
  const { s, alice, signIn } = await journal(t)
  s.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(alice.id)
  const tok = (await signIn('alice')).json.token
  const bob = s.db.prepare("SELECT id FROM users WHERE name='bob'").get()
  const r = await s.http(`/users/${bob.id}/email`, { method: 'PUT', token: tok, body: { email: 'bob@example.com' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.user.email, 'bob@example.com')
  assert.equal((await s.http(`/users/${bob.id}/email`, { method: 'PUT', token: tok, body: { email: 'alice@example.com' } })).status, 409)
  assert.equal((await s.http(`/users/${bob.id}/email`, { method: 'PUT', token: tok, body: { email: 'nope' } })).status, 400)
  const list = await s.http('/users', { token: tok })
  assert.equal(list.json.users.find((u) => u.name === 'bob').email, 'bob@example.com')
  assert.equal((await s.http(`/users/${bob.id}/email`, { method: 'PUT', token: tok, body: { email: null } })).json.user.email, null)
})

test('a link stops working once the account\'s password or address changes, by any route', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'hunter22')
  setUserEmail(db, alice.id, 'alice@example.com')
  const viaEmail = issueResetToken(db, alice.id)
  setUserEmail(db, alice.id, 'alice@example.org')
  assert.deepEqual(await resetPassword(db, viaEmail, 'brand-new-pw'), { ok: false }, 'new address')
  const viaAdmin = issueResetToken(db, alice.id)
  await setPassword(db, 'alice', 'admin-set-pw')
  assert.deepEqual(await resetPassword(db, viaAdmin, 'brand-new-pw'), { ok: false }, 'admin reset')
  const viaChange = issueResetToken(db, alice.id)
  const mac = await login(db, { username: 'alice', password: 'admin-set-pw', deviceName: 'mac' })
  assert.ok((await changePassword(db, alice.id, { oldPassword: 'admin-set-pw', newPassword: 'changed-pw-1', deviceId: mac.deviceId })).ok)
  assert.deepEqual(await resetPassword(db, viaChange, 'brand-new-pw'), { ok: false }, 'self-service change')
  db.prepare('DELETE FROM password_reset_sends').run() // past the hourly cap of three
  const fresh = issueResetToken(db, alice.id)
  assert.equal((await resetPassword(db, fresh, 'brand-new-pw')).ok, true)
})

test('account email: parallel wrong passwords are all counted before the next is checked', async (t) => {
  const { s, signIn } = await journal(t)
  const bob = (await signIn('bob')).json.token
  const r = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    s.http('/account/email', { method: 'PUT', token: bob, body: { password: `wrong-${i}`, email: 'bob@example.com' } })))
  assert.deepEqual(r.map((x) => x.status).sort(), [401, 401, 401, 401, 401, 429, 429, 429])
})
