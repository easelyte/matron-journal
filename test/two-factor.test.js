import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { runAdmin } from '../bin/matron-admin.js'
import {
  base32Encode, base32Decode, hotp, matchTotp, totpStep, classifyCode, newRecoveryCode,
  otpauthUri, makeTwoFactorTickets, STEP_MS,
} from '../src/two-factor.js'

const KEY = 'ab'.repeat(32)

// ---- RFC 6238 and helpers ----------------------------------------------

test('TOTP matches the RFC 6238 SHA-1 test vectors (6-digit truncation)', () => {
  const key = Buffer.from('12345678901234567890')
  // RFC 6238 Appendix B, last six digits of the 8-digit values.
  for (const [t, want] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']]) {
    assert.equal(hotp(key, Math.floor(t / 30)), want, `T=${t}`)
  }
})

test('base32 round-trips and decodes what authenticator apps are given', () => {
  const buf = Buffer.from('12345678901234567890')
  assert.equal(base32Encode(buf), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  assert.deepEqual(base32Decode('gezd gnbv-gy3tqojqgezdgnbvgy3tqojq'), buf)
  assert.throws(() => base32Decode('not base32!'))
})

test('matchTotp accepts one step of drift either way and never a used step', () => {
  const key = Buffer.from('12345678901234567890')
  const now = 1234567890 * 1000
  const step = totpStep(now)
  assert.equal(matchTotp(key, hotp(key, step), { now }), step)
  assert.equal(matchTotp(key, hotp(key, step - 1), { now }), step - 1)
  assert.equal(matchTotp(key, hotp(key, step + 1), { now }), step + 1)
  assert.equal(matchTotp(key, hotp(key, step - 2), { now }), null)
  assert.equal(matchTotp(key, hotp(key, step), { now, lastStep: step }), null, 'replay inside the same step')
  assert.equal(matchTotp(key, '12345', { now }), null)
})

test('classifyCode tells TOTP codes from recovery codes', () => {
  assert.deepEqual(classifyCode('123 456'), { kind: 'totp', code: '123456' })
  const rc = newRecoveryCode()
  assert.match(rc, /^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/)
  assert.equal(classifyCode(rc.toUpperCase()).kind, 'recovery')
  assert.equal(classifyCode('nope'), null)
  assert.equal(classifyCode(42), null)
})

test('otpauthUri carries the secret, issuer and parameters', () => {
  const u = new URL(otpauthUri({ issuer: 'Matron', account: 'alice@example.com', secret: 'ABC' }))
  assert.equal(u.protocol, 'otpauth:')
  assert.equal(u.host, 'totp')
  assert.equal(decodeURIComponent(u.pathname), '/Matron:alice@example.com')
  assert.equal(u.searchParams.get('secret'), 'ABC')
  assert.equal(u.searchParams.get('issuer'), 'Matron')
  assert.equal(u.searchParams.get('period'), '30')
})

test('sign-in tickets expire after their attempts and are single-use', () => {
  const tickets = makeTwoFactorTickets({ maxAttempts: 2 })
  const { ticket } = tickets.issue({ userId: 1, username: 'alice', deviceName: 'x', purpose: 'verify' })
  assert.equal(tickets.get(ticket).userId, 1)
  assert.equal(tickets.fail(ticket), true)
  assert.equal(tickets.fail(ticket), false)
  assert.equal(tickets.get(ticket), null)
  const b = tickets.issue({ userId: 1, username: 'alice', deviceName: 'x', purpose: 'verify' })
  tickets.consume(b.ticket)
  assert.equal(tickets.get(b.ticket), null)
  assert.equal(tickets.get(undefined), null)
})

// ---- Over HTTP ---------------------------------------------------------

const codeFor = (secret, offset = 0) => hotp(base32Decode(secret), totpStep() + offset)

async function setup(t, opts = {}) {
  const s = await startTestServer({ tokenKey: KEY, ...opts })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'hunter22')
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'hunter22', device_name: 'web' } })
  return { s, alice, token: login.json.token, deviceId: login.json.device_id }
}

// Enrol alice from her signed-in web session; returns the secret and codes.
async function enrol(s, token, body = {}) {
  const st = await s.http('/2fa/setup', { method: 'POST', token, body: { password: 'hunter22' } })
  assert.equal(st.status, 200)
  const en = await s.http('/2fa/enable', { method: 'POST', token, body: { code: codeFor(st.json.secret), ...body } })
  assert.equal(en.status, 200)
  return { secret: st.json.secret, recoveryCodes: en.json.recovery_codes, enable: en.json, setup: st.json }
}

test('enrolment: setup returns a secret and QR URI, enable needs a right code and returns ten recovery codes', async (t) => {
  const { s, token } = await setup(t)
  assert.deepEqual((await s.http('/2fa', { token })).json, { enabled: false, enabled_at: null, recovery_codes_left: 0, required: false, available: true })

  assert.equal((await s.http('/2fa/setup', { method: 'POST', token, body: { password: 'wrong' } })).status, 401)
  assert.equal((await s.http('/2fa/enable', { method: 'POST', token, body: { code: '000000' } })).status, 409, 'nothing pending yet')

  const st = await s.http('/2fa/setup', { method: 'POST', token, body: { password: 'hunter22' }, headers: { 'x-forwarded-host': 'journal.example.com:8443' } })
  assert.equal(st.status, 200)
  assert.match(st.json.secret, /^[A-Z2-7]{32}$/)
  assert.equal(st.json.account, 'alice@journal.example.com')
  assert.ok(st.json.otpauth_uri.startsWith('otpauth://totp/Matron%3Aalice%40journal.example.com?'))
  // Pending is not enabled: sign-in still takes the password alone.
  assert.equal((await s.http('/2fa', { token })).json.enabled, false)

  const wrong = String((Number(codeFor(st.json.secret)) + 1) % 1e6).padStart(6, '0')
  assert.equal((await s.http('/2fa/enable', { method: 'POST', token, body: { code: wrong } })).status, 403)
  const en = await s.http('/2fa/enable', { method: 'POST', token, body: { code: codeFor(st.json.secret) } })
  assert.equal(en.status, 200)
  assert.equal(en.json.recovery_codes.length, 10)
  assert.equal(new Set(en.json.recovery_codes).size, 10)
  assert.equal(en.json.signed_out, 0)

  const state = (await s.http('/2fa', { token })).json
  assert.equal(state.enabled, true)
  assert.equal(state.recovery_codes_left, 10)
  assert.equal((await s.http('/me', { token })).json.two_factor.enabled, true)
})

test('the secret is sealed at rest and recovery codes are stored only as hashes', async (t) => {
  const { s, token, alice } = await setup(t)
  const { secret, recoveryCodes } = await enrol(s, token)
  const row = s.db.prepare('SELECT secret FROM two_factor WHERE user_id=?').get(alice.id)
  assert.ok(row.secret.startsWith('enc1:'))
  assert.ok(!row.secret.includes(secret))
  const hashes = s.db.prepare('SELECT code_hash FROM two_factor_recovery WHERE user_id=?').all(alice.id).map((r) => r.code_hash)
  for (const c of recoveryCodes) assert.ok(!hashes.includes(c))
})

test('with two-factor on, a password alone gets a ticket, and the code step gets the token', async (t) => {
  const { s, token } = await setup(t)
  const { secret } = await enrol(s, token)

  const first = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'hunter22', device_name: 'phone' } })
  assert.equal(first.status, 401)
  assert.equal(first.json.error, 'two_factor_required')
  assert.equal(first.json.token, undefined)
  assert.equal(first.json.expires_in, 300)
  const ticket = first.json.two_factor_ticket
  assert.match(ticket, /^[0-9a-f]{64}$/)

  // Wrong password still says bad_credentials, never mentions two-factor.
  const bad = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'nope' } })
  assert.deepEqual(bad.json, { error: 'bad_credentials' })

  assert.equal((await s.http('/login/2fa', { method: 'POST', body: { ticket: 'f'.repeat(64), code: '123456' } })).status, 401)
  assert.equal((await s.http('/login/2fa', { method: 'POST', body: { ticket } })).status, 400)

  // Enable already used the current step, so the next code is the one.
  const ok = await s.http('/login/2fa', { method: 'POST', body: { ticket, code: codeFor(secret, 1) } })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.used_recovery_code, false)
  assert.equal(ok.json.recovery_codes_left, 10)
  const me = await s.http('/me', { token: ok.json.token })
  assert.equal(me.json.user.name, 'alice')
  const dev = s.db.prepare('SELECT name, kind FROM devices WHERE id=?').get(ok.json.device_id)
  assert.deepEqual({ ...dev }, { name: 'phone', kind: 'client' })

  // The ticket is spent, and the code cannot be replayed with a new one.
  assert.equal((await s.http('/login/2fa', { method: 'POST', body: { ticket, code: codeFor(secret, 1) } })).status, 401)
  const again = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'hunter22' } })
  const replay = await s.http('/login/2fa', { method: 'POST', body: { ticket: again.json.two_factor_ticket, code: codeFor(secret, 1) } })
  assert.equal(replay.status, 403)
  assert.equal(replay.json.error, 'bad_code')
})

test('a recovery code signs in once, in place of a code', async (t) => {
  const { s, token } = await setup(t)
  const { recoveryCodes } = await enrol(s, token)
  const signIn = async () => (await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'hunter22' } })).json.two_factor_ticket
  const ok = await s.http('/login/2fa', { method: 'POST', body: { ticket: await signIn(), code: recoveryCodes[3].toUpperCase() } })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.used_recovery_code, true)
  assert.equal(ok.json.recovery_codes_left, 9)
  const reuse = await s.http('/login/2fa', { method: 'POST', body: { ticket: await signIn(), code: recoveryCodes[3] } })
  assert.equal(reuse.status, 403)
})

test('five wrong codes kill the ticket, and wrong codes lock the username out', async (t) => {
  const { s, token } = await setup(t)
  const { secret } = await enrol(s, token)
  const wrong = String((Number(codeFor(secret, 1)) + 500000) % 1e6).padStart(6, '0')
  const ticket = (await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'hunter22' } })).json.two_factor_ticket
  for (let i = 1; i <= 5; i++) {
    const r = await s.http('/login/2fa', { method: 'POST', body: { ticket, code: wrong } })
    assert.equal(r.status, 403, `attempt ${i}`)
    assert.equal(r.json.ticket_valid, i < 5)
  }
  assert.equal((await s.http('/login/2fa', { method: 'POST', body: { ticket, code: codeFor(secret, 1) } })).status, 401)
  // The login guard counted all five: the username is now locked, even
  // with the right password.
  const locked = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'hunter22' } })
  assert.equal(locked.status, 429)
  assert.equal(locked.json.error, 'locked_out')
})

test('an enrol ticket cannot be used at the code step, and a verify ticket cannot enrol', async (t) => {
  const { s, token } = await setup(t)
  await enrol(s, token)
  const ticket = (await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'hunter22' } })).json.two_factor_ticket
  assert.equal((await s.http('/login/2fa/setup', { method: 'POST', body: { ticket } })).status, 401)
  assert.equal((await s.http('/login/2fa/enable', { method: 'POST', body: { ticket, code: '123456' } })).status, 401)
})

test('turning on can sign out the other web and app sessions, never the boxes', async (t) => {
  const { s, token, alice, deviceId } = await setup(t)
  const other = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'hunter22', device_name: 'old phone' } })
  const box = createAgent(s.db, alice.id, 'box-a')
  const { enable } = await enrol(s, token, { sign_out_others: true })
  assert.equal(enable.signed_out, 1)
  assert.equal((await s.http('/me', { token: other.json.token })).status, 401)
  assert.equal((await s.http('/me', { token })).status, 200)
  assert.ok(s.db.prepare('SELECT 1 FROM devices WHERE id=?').get(box.deviceId))
  assert.ok(s.db.prepare('SELECT 1 FROM devices WHERE id=?').get(deviceId))
})

test('disabling and new recovery codes need the password and a code', async (t) => {
  const { s, token } = await setup(t)
  const { secret, recoveryCodes } = await enrol(s, token)
  assert.equal((await s.http('/2fa/recovery-codes', { method: 'POST', token, body: { password: 'hunter22' } })).status, 400)
  assert.equal((await s.http('/2fa/recovery-codes', { method: 'POST', token, body: { password: 'nope', code: codeFor(secret, 1) } })).status, 401)
  const fresh = await s.http('/2fa/recovery-codes', { method: 'POST', token, body: { password: 'hunter22', code: codeFor(secret, 1) } })
  assert.equal(fresh.status, 200)
  assert.equal(fresh.json.recovery_codes.length, 10)
  // The old set is gone.
  assert.equal((await s.http('/2fa/disable', { method: 'POST', token, body: { password: 'hunter22', code: recoveryCodes[0] } })).status, 403)
  const off = await s.http('/2fa/disable', { method: 'POST', token, body: { password: 'hunter22', code: fresh.json.recovery_codes[0] } })
  assert.equal(off.status, 200)
  assert.equal((await s.http('/2fa', { token })).json.enabled, false)
  const plain = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'hunter22' } })
  assert.equal(plain.status, 200)
  assert.ok(plain.json.token)
})

test('moving to a new authenticator app needs a code from the old one; the old secret works until the new one is confirmed', async (t) => {
  const { s, token } = await setup(t)
  const { secret } = await enrol(s, token)
  assert.equal((await s.http('/2fa/setup', { method: 'POST', token, body: { password: 'hunter22' } })).status, 400)
  const st = await s.http('/2fa/setup', { method: 'POST', token, body: { password: 'hunter22', code: codeFor(secret, 1) } })
  assert.equal(st.status, 200)
  assert.notEqual(st.json.secret, secret)
  assert.equal((await s.http('/2fa', { token })).json.enabled, true)
  const en = await s.http('/2fa/enable', { method: 'POST', token, body: { code: codeFor(st.json.secret) } })
  assert.equal(en.status, 200)
  const ticket = (await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'hunter22' } })).json.two_factor_ticket
  assert.equal((await s.http('/login/2fa', { method: 'POST', body: { ticket, code: codeFor(st.json.secret, 1) } })).status, 200)
})

test('agents cannot touch two-factor settings', async (t) => {
  const { s, alice } = await setup(t)
  const box = createAgent(s.db, alice.id, 'box-a')
  for (const [method, path] of [['GET', '/2fa'], ['POST', '/2fa/setup'], ['POST', '/2fa/disable'], ['PUT', '/2fa/policy']]) {
    assert.equal((await s.http(path, { method, token: box.token, body: method === 'GET' ? null : {} })).status, 403, path)
  }
})

test('without a token key nobody can enrol, and two-factor cannot be required', async (t) => {
  const { s, token } = await setup(t, { tokenKey: null })
  s.db.prepare('UPDATE users SET is_admin=1').run()
  assert.equal((await s.http('/2fa', { token })).json.available, false)
  assert.equal((await s.http('/2fa/setup', { method: 'POST', token, body: { password: 'hunter22' } })).status, 503)
  assert.equal((await s.http('/2fa/policy', { method: 'PUT', token, body: { required: true } })).status, 503)
  // A requirement set from the shell is not enforced without the key.
  await runAdmin(s.db, ['two-factor', 'require', 'on'])
  assert.equal((await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'hunter22' } })).status, 200)
})

test('required for everyone: an unenrolled user sets up at sign-in before getting a token', async (t) => {
  const { s, token } = await setup(t)
  assert.equal((await s.http('/2fa/policy', { method: 'PUT', token, body: { required: true } })).status, 403, 'admins only')
  s.db.prepare('UPDATE users SET is_admin=1').run()
  assert.deepEqual((await s.http('/2fa/policy', { method: 'PUT', token, body: { required: true } })).json, { required: true })
  // Existing sessions stay signed in.
  assert.equal((await s.http('/me', { token })).json.two_factor.required, true)

  const r = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'hunter22', device_name: 'laptop' } })
  assert.equal(r.status, 401)
  assert.equal(r.json.error, 'two_factor_enrolment_required')
  const ticket = r.json.two_factor_ticket
  assert.equal((await s.http('/login/2fa', { method: 'POST', body: { ticket, code: '123456' } })).status, 401, 'enrol ticket is not a verify ticket')
  const st = await s.http('/login/2fa/setup', { method: 'POST', body: { ticket } })
  assert.equal(st.status, 200)
  const en = await s.http('/login/2fa/enable', { method: 'POST', body: { ticket, code: codeFor(st.json.secret) } })
  assert.equal(en.status, 200)
  assert.ok(en.json.token)
  assert.equal(en.json.recovery_codes.length, 10)
  assert.equal(s.db.prepare('SELECT name FROM devices WHERE id=?').get(en.json.device_id).name, 'laptop')

  // Now enrolled, and while required it cannot be turned off.
  const off = await s.http('/2fa/disable', { method: 'POST', token, body: { password: 'hunter22', code: codeFor(st.json.secret, 1) } })
  assert.equal(off.status, 409)
  assert.equal(off.json.error, 'two_factor_required')
})

test('admin reset and matron-admin user 2fa-reset turn two-factor off', async (t) => {
  const { s, token, alice } = await setup(t)
  await enrol(s, token)
  await createUser(s.db, 'bob', 'bobpass1')
  const bob = (await s.http('/login', { method: 'POST', body: { username: 'bob', password: 'bobpass1' } })).json.token
  assert.equal((await s.http(`/users/${alice.id}/two-factor`, { method: 'DELETE', token: bob })).status, 403)
  s.db.prepare("UPDATE users SET is_admin=1 WHERE name='bob'").run()
  const list = await s.http('/users', { token: bob })
  assert.equal(list.json.users.find((u) => u.name === 'alice').two_factor, true)
  assert.equal((await s.http(`/users/${alice.id}/two-factor`, { method: 'DELETE', token: bob })).status, 200)
  assert.equal((await s.http(`/users/${alice.id}/two-factor`, { method: 'DELETE', token: bob })).status, 404)
  assert.equal((await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'hunter22' } })).status, 200)

  await enrol(s, token)
  assert.match(await runAdmin(s.db, ['two-factor', 'status']), /alice\ton \(10 recovery codes left\)/)
  assert.match(await runAdmin(s.db, ['user', '2fa-reset', 'alice']), /turned off/)
  assert.match(await runAdmin(s.db, ['user', '2fa-reset', 'alice']), /did not have/)
  await assert.rejects(runAdmin(s.db, ['user', '2fa-reset', 'nobody']), /no such user/)
  assert.match(await runAdmin(s.db, ['two-factor', 'require', 'on']), /now required/)
  assert.match(await runAdmin(s.db, ['two-factor', 'status']), /required for everyone: yes/)
})

test('a stale setup expires and must be started again', async (t) => {
  const { s, token, alice } = await setup(t)
  const st = await s.http('/2fa/setup', { method: 'POST', token, body: { password: 'hunter22' } })
  s.db.prepare('UPDATE two_factor SET pending_at=pending_at-? WHERE user_id=?').run(16 * 60000, alice.id)
  assert.equal((await s.http('/2fa/enable', { method: 'POST', token, body: { code: codeFor(st.json.secret) } })).status, 409)
  assert.ok(STEP_MS === 30000)
})

test('an enrol ticket goes dead once the user has two-factor, so it cannot replace the secret', async (t) => {
  const { s, token } = await setup(t)
  s.db.prepare('UPDATE users SET is_admin=1').run()
  await s.http('/2fa/policy', { method: 'PUT', token, body: { required: true } })
  // A password-only enrol ticket is minted, then the user enrols elsewhere.
  const stale = (await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'hunter22' } })).json.two_factor_ticket
  const { secret } = await enrol(s, token)
  assert.equal((await s.http('/login/2fa/setup', { method: 'POST', body: { ticket: stale } })).status, 401)
  assert.equal((await s.http('/login/2fa/enable', { method: 'POST', body: { ticket: stale, code: '123456' } })).status, 401)
  // The real secret still works.
  const ticket = (await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'hunter22' } })).json.two_factor_ticket
  assert.equal((await s.http('/login/2fa', { method: 'POST', body: { ticket, code: codeFor(secret, 1) } })).status, 200)
})

test('wrong codes at /2fa/enable count toward the lockout', async (t) => {
  const { s, token } = await setup(t)
  const st = await s.http('/2fa/setup', { method: 'POST', token, body: { password: 'hunter22' } })
  const wrong = String((Number(codeFor(st.json.secret)) + 500000) % 1e6).padStart(6, '0')
  for (let i = 0; i < 5; i++) {
    assert.equal((await s.http('/2fa/enable', { method: 'POST', token, body: { code: wrong } })).status, 403)
  }
  const locked = await s.http('/2fa/enable', { method: 'POST', token, body: { code: codeFor(st.json.secret) } })
  assert.equal(locked.status, 429)
  assert.equal(locked.json.error, 'locked_out')
})

test('a password change drops sign-in tickets earned with the old password', async (t) => {
  const { s, token } = await setup(t)
  const { secret } = await enrol(s, token)
  const first = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'hunter22', device_name: 'phone' } })
  const ticket = first.json.two_factor_ticket
  const changed = await s.http('/password', { method: 'POST', token, body: { old_password: 'hunter22', new_password: 'brand-new-pw' } })
  assert.equal(changed.status, 200)
  const late = await s.http('/login/2fa', { method: 'POST', body: { ticket, code: codeFor(secret, 1) } })
  assert.equal(late.status, 401, 'the ticket went with the old password')
})

test('makeTwoFactorTickets.dropUser drops only that user\'s tickets', () => {
  const tickets = makeTwoFactorTickets()
  const a = tickets.issue({ userId: 1, username: 'alice', deviceName: 'x', purpose: 'verify' })
  const b = tickets.issue({ userId: 2, username: 'bob', deviceName: 'x', purpose: 'verify' })
  tickets.dropUser(1)
  assert.equal(tickets.get(a.ticket), null)
  assert.equal(tickets.get(b.ticket).username, 'bob')
})

test('a password reset by email drops sign-in tickets earned with the old password', async (t) => {
  const sent = []
  const mailer = { publicUrl: 'https://journal.example.com', async send(m) { sent.push(m) } }
  const { s, alice, token } = await setup(t, { mailer })
  const { secret } = await enrol(s, token)
  s.db.prepare('UPDATE users SET email=? WHERE id=?').run('alice@example.com', alice.id)
  const ticket = (await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'hunter22', device_name: 'phone' } })).json.two_factor_ticket
  await s.http('/password/forgot', { method: 'POST', body: { identifier: 'alice' } })
  await new Promise((r) => setImmediate(r))
  const resetToken = sent[0].text.match(/#token=([A-Za-z0-9_-]+)/)[1]
  assert.equal((await s.http('/password/reset', { method: 'POST', body: { token: resetToken, new_password: 'brand-new-pw' } })).status, 200)
  const late = await s.http('/login/2fa', { method: 'POST', body: { ticket, code: codeFor(secret, 1) } })
  assert.equal(late.status, 401)
})
