// Signed account actions: once the account has an approval key, the routes
// that widen access — change the password, approve a bridge pairing, link a
// device, change the Coordinator or its consent switches, change two-factor —
// need an `account` statement over the action's subject as well as every
// check they make today. The guard runs in the write's own transaction: a
// refused request changes nothing (a second-factor code it checked is not
// spent), and a request that fails today's checks or its write does not
// spend the nonce. An account with no key behaves exactly as before.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { createAgent, createUser, verifyUserPassword } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { base32Decode, hotp, totpStep, isTwoFactorEnabled, setTwoFactorRequired } from '../src/two-factor.js'
import {
  startApprovalServer, enableTwoFactor, enrolKeyByPassword, signAccount, signIn, totpCode, forgetApprovalFailures, TEST_PASSWORD,
} from './approval-helpers.js'

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const NEW_PW = 'brand-new-pw-1'
const invalid = (r, reason) => assert.deepEqual([r.status, r.json], [400, { error: 'approval_invalid', reason }])
const required = (r) => assert.deepEqual([r.status, r.json], [403, { error: 'approval_required' }])

// alice signed in on her phone with two-factor on, and (by default) an
// approval key on the phone; two conversations of hers on box-a.
async function world(t, { withKey = true } = {}) {
  const base = await startApprovalServer(t)
  const { s, alice, token } = base
  const { secret, recoveryCodes } = await enableTwoFactor(s, token)
  const key = withKey ? await enrolKeyByPassword(s, { token, userId: alice.id, secret }) : null
  const box = createAgent(s.db, alice.id, 'box-a')
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'One', agentDeviceId: box.deviceId })
  upsertConversation(s.db, { id: 'c2', ownerUserId: alice.id, title: 'Two', agentDeviceId: box.deviceId })
  // Each request on its own: these tests send several invalid approvals
  // from the phone on purpose, and two would sign it out
  // (test/approval-lockdown.test.js).
  const post = (path, body, method = 'POST') => { forgetApprovalFailures(s); return s.http(path, { method, token, body }) }
  const sign = (subject) => signAccount(s, { token, key, subject })
  const code = () => totpCode(s, alice.id, secret)
  const spentNonces = () => s.db.prepare('SELECT COUNT(*) n FROM approval_nonces WHERE used_at IS NOT NULL').get().n
  const twoFactor = async () => (await s.http('/2fa', { token })).json
  return { ...base, secret, recoveryCodes, key, box, post, sign, code, spentNonces, twoFactor }
}

// ---- Password ------------------------------------------------------------

test('POST /password with a key: the signature comes on top of the current password; a refused change changes nothing and spends nothing', async (t) => {
  const w = await world(t)
  const body = { old_password: TEST_PASSWORD, new_password: NEW_PW }
  required(await w.post('/password', body))
  invalid(await w.post('/password', { ...body, approval: await w.sign({ op: 'two_factor', action: 'setup' }) }), 'mismatch')
  assert.ok(await verifyUserPassword(w.s.db, w.alice.id, TEST_PASSWORD), 'unchanged')

  const approval = await w.sign({ op: 'change_password' })
  // The current password is still asked for, and still checked first: a
  // wrong one with a valid signature is today's 401 and leaves the nonce.
  const noOld = await w.post('/password', { new_password: NEW_PW, approval })
  assert.deepEqual([noOld.status, noOld.json], [400, { error: 'bad_request' }])
  const wrong = await w.post('/password', { ...body, old_password: 'not-the-password', approval })
  assert.deepEqual([wrong.status, wrong.json], [401, { error: 'bad_password' }])
  assert.equal(w.spentNonces(), 0)

  const ok = await w.post('/password', { ...body, approval })
  assert.deepEqual([ok.status, ok.json], [200, { ok: true, signed_out: 0 }])
  assert.ok(await verifyUserPassword(w.s.db, w.alice.id, NEW_PW))
  invalid(await w.post('/password', { old_password: NEW_PW, new_password: 'third-pw-12', approval }), 'nonce')
  assert.ok(await verifyUserPassword(w.s.db, w.alice.id, NEW_PW))
})

// ---- Bridge pairing ------------------------------------------------------

test('POST /pair/approve with a key: signed over the code and the name; refused, the pair stays pending', async (t) => {
  const w = await world(t)
  const start = (await w.s.http('/pair/start', { method: 'POST', body: {} })).json
  const claim = async () => (await w.s.http('/pair/claim', { method: 'POST', body: { poll_token: start.poll_token } })).json
  const body = { pair_code: start.pair_code, agent_name: 'box-b' }
  required(await w.post('/pair/approve', body))
  invalid(await w.post('/pair/approve', { ...body, approval: await w.sign({ op: 'pair_bridge', code: start.pair_code, name: 'box-c' }) }), 'mismatch')
  invalid(await w.post('/pair/approve', { ...body, approval: await w.sign({ op: 'pair_bridge', code: 'ZZZZ-ZZZZ', name: 'box-b' }) }), 'mismatch')
  assert.deepEqual(await claim(), { status: 'pending' })

  const ok = await w.post('/pair/approve', { ...body, approval: await w.sign({ op: 'pair_bridge', code: start.pair_code, name: 'box-b' }) })
  assert.deepEqual([ok.status, ok.json], [200, { status: 'approved' }])
  const claimed = await claim()
  assert.equal(claimed.status, 'approved')
  assert.equal(w.s.db.prepare('SELECT name FROM devices WHERE id=?').get(claimed.device_id).name, 'box-b')
})

test('POST /pair/approve with a key: an unknown code is today\'s 404 and spends no nonce; a name over 200 characters is signed as name_sha256', async (t) => {
  const w = await world(t)
  const lost = await w.post('/pair/approve', { pair_code: 'ZZZZ-ZZZZ', agent_name: 'box-b', approval: await w.sign({ op: 'pair_bridge', code: 'ZZZZ-ZZZZ', name: 'box-b' }) })
  assert.deepEqual([lost.status, lost.json], [404, { error: 'not_found' }])
  assert.equal(w.spentNonces(), 0)

  const start = (await w.s.http('/pair/start', { method: 'POST', body: {} })).json
  const name = 'b'.repeat(250)
  invalid(await w.post('/pair/approve', { pair_code: start.pair_code, agent_name: name, approval: await w.sign({ op: 'pair_bridge', code: start.pair_code, name }) }), 'bad_statement')
  const ok = await w.post('/pair/approve', { pair_code: start.pair_code, agent_name: name, approval: await w.sign({ op: 'pair_bridge', code: start.pair_code, name_sha256: sha(name) }) })
  assert.equal(ok.status, 200, JSON.stringify(ok.json))
})

// ---- Device link ---------------------------------------------------------

test('POST /link/approve with a key: signed over the link code; a refused approval leaves the link claimed; a too-early one spends no nonce', async (t) => {
  const w = await world(t)
  const start = (await w.post('/link/start', {})).json
  const approval = await w.sign({ op: 'link_device', code: start.link_code })
  // Nothing claimed yet: today's 409, and the statement is still good.
  const early = await w.post('/link/approve', { link_code: start.link_code, approval })
  assert.deepEqual([early.status, early.json], [409, { error: 'conflict' }])
  assert.equal(w.spentNonces(), 0)

  const claim = (await w.s.http('/link/claim', { method: 'POST', body: { link_code: start.link_code, device_name: 'laptop' } })).json
  required(await w.post('/link/approve', { link_code: start.link_code }))
  invalid(await w.post('/link/approve', { link_code: start.link_code, approval: await w.sign({ op: 'link_device', code: 'ZZZZ-ZZZZ' }) }), 'mismatch')
  assert.equal((await w.post('/link/status', {})).json.status, 'claimed')

  const ok = await w.post('/link/approve', { link_code: start.link_code, approval })
  assert.deepEqual([ok.status, ok.json], [200, { status: 'approved' }])
  const polled = await w.s.http('/link/poll', { method: 'POST', body: { claim_token: claim.claim_token } })
  assert.equal(polled.json.status, 'approved')
})

// ---- Coordinator ---------------------------------------------------------

test('PUT /coordinator with a key: choosing or clearing the Coordinator is signed over the conversation id', async (t) => {
  const w = await world(t)
  const coordinator = async () => (await w.s.http('/coordinator', { token: w.token })).json.convo_id
  required(await w.post('/coordinator', { convo_id: 'c1' }, 'PUT'))
  invalid(await w.post('/coordinator', { convo_id: 'c1', approval: await w.sign({ op: 'set_coordinator', convo: 'c2' }) }, 'PUT'), 'mismatch')
  assert.equal(await coordinator(), null)

  const ok = await w.post('/coordinator', { convo_id: 'c1', approval: await w.sign({ op: 'set_coordinator', convo: 'c1' }) }, 'PUT')
  assert.deepEqual([ok.status, ok.json], [200, { convo_id: 'c1', consent: true, transfer_consent: false }])
  assert.equal(await coordinator(), 'c1')

  // A conversation that is not hers: today's 404, the nonce not spent.
  const spent = w.spentNonces()
  const nope = await w.post('/coordinator', { convo_id: 'nope', approval: await w.sign({ op: 'set_coordinator', convo: 'nope' }) }, 'PUT')
  assert.deepEqual([nope.status, nope.json], [404, { error: 'not_found' }])
  assert.equal(w.spentNonces(), spent)

  required(await w.post('/coordinator', { convo_id: null }, 'PUT'))
  invalid(await w.post('/coordinator', { convo_id: null, approval: await w.sign({ op: 'set_coordinator', convo: 'c1' }) }, 'PUT'), 'mismatch')
  const cleared = await w.post('/coordinator', { convo_id: null, approval: await w.sign({ op: 'set_coordinator', convo: '' }) }, 'PUT')
  assert.deepEqual([cleared.status, cleared.json], [200, { convo_id: null, consent: true, transfer_consent: false }])
})

test('PUT /coordinator with a key: each consent switch is signed over which switch and its new value', async (t) => {
  const w = await world(t)
  const settings = async () => (await w.s.http('/coordinator', { token: w.token })).json
  // The Coordinator's consent is on by default: turning it off is signed.
  required(await w.post('/coordinator', { consent: false }, 'PUT'))
  invalid(await w.post('/coordinator', { consent: false, approval: await w.sign({ op: 'set_consent', which: 'spawns', on: 'true' }) }, 'PUT'), 'mismatch')
  invalid(await w.post('/coordinator', { consent: false, approval: await w.sign({ op: 'set_consent', which: 'transfers', on: 'false' }) }, 'PUT'), 'mismatch')
  assert.equal((await settings()).consent, true)
  const off = await w.post('/coordinator', { consent: false, approval: await w.sign({ op: 'set_consent', which: 'spawns', on: 'false' }) }, 'PUT')
  assert.deepEqual([off.status, off.json], [200, { convo_id: null, consent: false, transfer_consent: false }])
  // And so is turning it back on.
  required(await w.post('/coordinator', { consent: true }, 'PUT'))
  const on = await w.post('/coordinator', { consent: true, approval: await w.sign({ op: 'set_consent', which: 'spawns', on: 'true' }) }, 'PUT')
  assert.equal(on.json.consent, true)

  required(await w.post('/coordinator', { transfer_consent: true }, 'PUT'))
  invalid(await w.post('/coordinator', { transfer_consent: true, approval: await w.sign({ op: 'set_consent', which: 'spawns', on: 'true' }) }, 'PUT'), 'mismatch')
  assert.equal((await settings()).transfer_consent, false)
  const tr = await w.post('/coordinator', { transfer_consent: true, approval: await w.sign({ op: 'set_consent', which: 'transfers', on: 'true' }) }, 'PUT')
  assert.deepEqual([tr.status, tr.json], [200, { convo_id: null, consent: true, transfer_consent: true }])
})

test('PUT /coordinator with a key: one change per signed request; two at once is a 400 and changes nothing', async (t) => {
  const w = await world(t)
  const approval = await w.sign({ op: 'set_coordinator', convo: 'c1' })
  const both = await w.post('/coordinator', { convo_id: 'c1', consent: false, approval }, 'PUT')
  assert.deepEqual([both.status, both.json], [400, { error: 'bad_request', detail: 'one_change_per_approval' }])
  assert.deepEqual((await w.s.http('/coordinator', { token: w.token })).json, { convo_id: null, consent: true, transfer_consent: false })
  assert.equal(w.spentNonces(), 0)
  assert.equal((await w.post('/coordinator', { convo_id: 'c1', approval }, 'PUT')).status, 200)
})

// ---- Two-factor ----------------------------------------------------------

test('POST /2fa/setup and /2fa/enable with a key: each signed; refused, the code checked is not spent and nothing changes', async (t) => {
  const w = await world(t)
  const pending = () => w.s.db.prepare('SELECT pending_secret FROM two_factor WHERE user_id=?').get(w.alice.id).pending_secret
  // A recovery code is spent by a request that goes through; a refused one
  // leaves it unspent.
  const [rc] = w.recoveryCodes
  required(await w.post('/2fa/setup', { password: TEST_PASSWORD, code: rc }))
  invalid(await w.post('/2fa/setup', { password: TEST_PASSWORD, code: rc, approval: await w.sign({ op: 'two_factor', action: 'enable' }) }), 'mismatch')
  assert.equal((await w.twoFactor()).recovery_codes_left, 10)
  assert.equal(pending(), null)

  // Today's checks first: a wrong password with a valid signature is a 401
  // and leaves the nonce.
  const approval = await w.sign({ op: 'two_factor', action: 'setup' })
  const badPw = await w.post('/2fa/setup', { password: 'not-the-password', code: rc, approval })
  assert.deepEqual([badPw.status, badPw.json], [401, { error: 'bad_password' }])
  const badCode = await w.post('/2fa/setup', { password: TEST_PASSWORD, code: '000000', approval })
  assert.deepEqual([badCode.status, badCode.json], [403, { error: 'bad_code' }])
  assert.equal(w.spentNonces(), 0)
  const setup = await w.post('/2fa/setup', { password: TEST_PASSWORD, code: rc, approval })
  assert.equal(setup.status, 200, JSON.stringify(setup.json))
  assert.equal((await w.twoFactor()).recovery_codes_left, 9)
  assert.ok(pending())

  // finishSetup matches the pending secret's code without a replay step, so
  // the same step's code serves every try.
  const newCode = () => hotp(base32Decode(setup.json.secret), totpStep())
  required(await w.post('/2fa/enable', { code: newCode() }))
  invalid(await w.post('/2fa/enable', { code: newCode(), approval: await w.sign({ op: 'two_factor', action: 'setup' }) }), 'mismatch')
  assert.ok(pending(), 'still pending')
  const enable = await w.post('/2fa/enable', { code: newCode(), approval: await w.sign({ op: 'two_factor', action: 'enable' }) })
  assert.equal(enable.status, 200, JSON.stringify(enable.json))
  assert.equal(enable.json.recovery_codes.length, 10)
  assert.equal(pending(), null)
})

test('POST /2fa/disable and /2fa/recovery-codes with a key: each signed; a bad code with a valid signature spends no nonce', async (t) => {
  const w = await world(t)
  required(await w.post('/2fa/recovery-codes', { password: TEST_PASSWORD, code: w.code() }))
  invalid(await w.post('/2fa/recovery-codes', { password: TEST_PASSWORD, code: w.code(), approval: await w.sign({ op: 'two_factor', action: 'disable' }) }), 'mismatch')
  const approval = await w.sign({ op: 'two_factor', action: 'recovery_codes' })
  const bad = await w.post('/2fa/recovery-codes', { password: TEST_PASSWORD, code: '000000', approval })
  assert.deepEqual([bad.status, bad.json], [403, { error: 'bad_code' }])
  assert.equal(w.spentNonces(), 0)
  const codes = await w.post('/2fa/recovery-codes', { password: TEST_PASSWORD, code: w.code(), approval })
  assert.equal(codes.status, 200)
  assert.ok(!codes.json.recovery_codes.includes(w.recoveryCodes[0]))

  required(await w.post('/2fa/disable', { password: TEST_PASSWORD, code: w.code() }))
  invalid(await w.post('/2fa/disable', { password: TEST_PASSWORD, code: w.code(), approval: await w.sign({ op: 'two_factor', action: 'recovery_codes' }) }), 'mismatch')
  assert.equal((await w.twoFactor()).enabled, true)
  const off = await w.post('/2fa/disable', { password: TEST_PASSWORD, code: w.code(), approval: await w.sign({ op: 'two_factor', action: 'disable' }) })
  assert.deepEqual([off.status, off.json], [200, { ok: true }])
  assert.equal((await w.twoFactor()).enabled, false)
})

test('with a key, a recovery code alone cannot turn two-factor off to make way for a new authenticator', async (t) => {
  // The path: a recovery code at /2fa/disable, then setup and enable with an
  // authenticator of one's own, then password plus TOTP enrolls a key. It
  // stops at the first step, and the recovery code is not spent.
  const w = await world(t)
  const [rc] = w.recoveryCodes
  required(await w.post('/2fa/disable', { password: TEST_PASSWORD, code: rc }))
  const state = await w.twoFactor()
  assert.equal(state.enabled, true)
  assert.equal(state.recovery_codes_left, 10)
  required(await w.post('/2fa/setup', { password: TEST_PASSWORD, code: rc }))
  assert.equal(w.s.db.prepare('SELECT pending_secret FROM two_factor WHERE user_id=?').get(w.alice.id).pending_secret, null)
})

test('POST /2fa/setup with a key and two-factor off: the signature is the only check after the password', async (t) => {
  const w = await world(t)
  const off = await w.post('/2fa/disable', { password: TEST_PASSWORD, code: w.code(), approval: await w.sign({ op: 'two_factor', action: 'disable' }) })
  assert.equal(off.status, 200, JSON.stringify(off.json))
  const pending = () => w.s.db.prepare('SELECT pending_secret FROM two_factor WHERE user_id=?').get(w.alice.id)?.pending_secret ?? null
  required(await w.post('/2fa/setup', { password: TEST_PASSWORD }))
  invalid(await w.post('/2fa/setup', { password: TEST_PASSWORD, approval: await w.sign({ op: 'two_factor', action: 'disable' }) }), 'mismatch')
  assert.equal(pending(), null)
  const setup = await w.post('/2fa/setup', { password: TEST_PASSWORD, approval: await w.sign({ op: 'two_factor', action: 'setup' }) })
  assert.equal(setup.status, 200, JSON.stringify(setup.json))
  assert.ok(pending())
})

// ---- Two-factor enrolment at sign-in -------------------------------------

// Sign in by password while two-factor is required and alice has none: an
// enrolment ticket.
async function enrolTicket(w) {
  setTwoFactorRequired(w.s.db, true)
  const r = await w.s.http('/login', { method: 'POST', body: { username: 'alice', password: TEST_PASSWORD, device_name: 'laptop' } })
  assert.equal(r.json.error, 'two_factor_enrolment_required', JSON.stringify(r.json))
  return r.json.two_factor_ticket
}

test('with a key, two-factor cannot be enrolled at sign-in: setup and enable are approval_required and write nothing', async (t) => {
  const w = await world(t)
  await w.post('/2fa/disable', { password: TEST_PASSWORD, code: w.code(), approval: await w.sign({ op: 'two_factor', action: 'disable' }) })
  // A setup left pending by the signed route on the phone: the sign-in path
  // cannot finish it either.
  const signed = await w.post('/2fa/setup', { password: TEST_PASSWORD, approval: await w.sign({ op: 'two_factor', action: 'setup' }) })
  const pendingNow = () => w.s.db.prepare('SELECT pending_secret FROM two_factor WHERE user_id=?').get(w.alice.id).pending_secret
  const before = pendingNow()
  const ticket = await enrolTicket(w)
  required(await w.s.http('/login/2fa/setup', { method: 'POST', body: { ticket } }))
  assert.equal(pendingNow(), before, 'no new pending secret')
  required(await w.s.http('/login/2fa/enable', { method: 'POST', body: { ticket, code: hotp(base32Decode(signed.json.secret), totpStep()) } }))
  assert.equal(isTwoFactorEnabled(w.s.db, w.alice.id), false)
  assert.equal(pendingNow(), before)
  const devices = w.s.db.prepare("SELECT COUNT(*) n FROM devices WHERE user_id=? AND kind='client'").get(w.alice.id).n
  assert.equal(devices, 1, 'no device signed in')
  // The signed route on a signed-in device still works.
  const enable = await w.post('/2fa/enable', { code: hotp(base32Decode(signed.json.secret), totpStep()), approval: await w.sign({ op: 'two_factor', action: 'enable' }) })
  assert.equal(enable.status, 200, JSON.stringify(enable.json))
})

test('without a key, enrolment at sign-in is as today', async (t) => {
  const w = await world(t, { withKey: false })
  await w.post('/2fa/disable', { password: TEST_PASSWORD, code: w.code() })
  const ticket = await enrolTicket(w)
  const setup = await w.s.http('/login/2fa/setup', { method: 'POST', body: { ticket } })
  assert.equal(setup.status, 200, JSON.stringify(setup.json))
  const enable = await w.s.http('/login/2fa/enable', { method: 'POST', body: { ticket, code: hotp(base32Decode(setup.json.secret), totpStep()) } })
  assert.equal(enable.status, 200, JSON.stringify(enable.json))
  assert.ok(enable.json.token)
  assert.equal(isTwoFactorEnabled(w.s.db, w.alice.id), true)
})

// ---- Admin web routes ----------------------------------------------------

// alice is an admin, signed in on her phone, with or without a key; bob has
// two-factor on, with or without a key.
async function adminWorld(t, { adminKey, targetKey }) {
  const base = await startApprovalServer(t)
  const { s, alice, token } = base
  s.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(alice.id)
  let key = null
  if (adminKey) {
    const { secret } = await enableTwoFactor(s, token)
    key = await enrolKeyByPassword(s, { token, userId: alice.id, secret })
  }
  const bob = await createUser(s.db, 'bob', TEST_PASSWORD)
  const bobPhone = signIn(s, bob.id, 'bob-phone')
  const { secret: bobSecret } = await enableTwoFactor(s, bobPhone.token)
  if (targetKey) await enrolKeyByPassword(s, { token: bobPhone.token, userId: bob.id, secret: bobSecret })
  const sign = (subject) => signAccount(s, { token, key, subject })
  const spentNonces = () => s.db.prepare('SELECT COUNT(*) n FROM approval_nonces WHERE used_at IS NOT NULL').get().n
  return { ...base, key, bob, sign, spentNonces }
}

const BOB_EMAIL = 'bob@example.com'
const ADMIN_ROUTES = [
  {
    name: 'POST /users/:id/password', method: 'POST', path: (id) => `/users/${id}/password`, body: { password: 'admin-set-pw-1' },
    subject: (user) => ({ op: 'admin_set_password', user }),
    changed: (w) => verifyUserPassword(w.s.db, w.bob.id, 'admin-set-pw-1'),
    ok: (r) => assert.deepEqual([r.status, r.json], [200, { ok: true }]),
  },
  {
    name: 'DELETE /users/:id/two-factor', method: 'DELETE', path: (id) => `/users/${id}/two-factor`, body: null,
    subject: (user) => ({ op: 'admin_reset_two_factor', user }),
    changed: (w) => !isTwoFactorEnabled(w.s.db, w.bob.id),
    ok: (r) => assert.deepEqual([r.status, r.json], [200, { ok: true }]),
  },
  {
    name: 'POST /users/:id/link-code', method: 'POST', path: (id) => `/users/${id}/link-code`, body: {},
    subject: (user) => ({ op: 'admin_link_code', user }),
    changed: (w) => w.s.db.prepare('SELECT COUNT(*) n FROM link_preapprovals WHERE user_id=?').get(w.bob.id).n > 0,
    ok: (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); assert.ok(r.json.link_code) },
  },
  {
    name: 'PUT /users/:id/email', method: 'PUT', path: (id) => `/users/${id}/email`, body: { email: BOB_EMAIL },
    subject: (user) => ({ op: 'admin_set_reset_email', user, email_sha256: sha(BOB_EMAIL) }),
    changed: (w) => w.s.db.prepare('SELECT email FROM users WHERE id=?').get(w.bob.id).email === BOB_EMAIL,
    ok: (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.user.email, BOB_EMAIL) },
  },
  {
    name: 'PATCH /users/:id is_admin:true', method: 'PATCH', path: (id) => `/users/${id}`, body: { is_admin: true },
    subject: (user) => ({ op: 'admin_set_admin', user, admin: 'true' }),
    changed: (w) => w.s.db.prepare('SELECT is_admin FROM users WHERE id=?').get(w.bob.id).is_admin === 1,
    ok: (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.user.is_admin, true) },
  },
  {
    name: 'PATCH /users/:id is_admin:false', method: 'PATCH', path: (id) => `/users/${id}`, body: { is_admin: false },
    setup: (w) => w.s.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(w.bob.id),
    subject: (user) => ({ op: 'admin_set_admin', user, admin: 'false' }),
    changed: (w) => w.s.db.prepare('SELECT is_admin FROM users WHERE id=?').get(w.bob.id).is_admin === 0,
    ok: (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.user.is_admin, false) },
  },
]

for (const route of ADMIN_ROUTES) {
  const call = (w, approval) => w.s.http(route.path(w.bob.id), {
    method: route.method, token: w.token, body: approval === undefined ? route.body : { ...(route.body ?? {}), approval },
  })

  test(`${route.name}: an admin with a key signs it, over the target's name`, async (t) => {
    const w = await adminWorld(t, { adminKey: true, targetKey: false })
    route.setup?.(w)
    required(await call(w))
    invalid(await call(w, await w.sign(route.subject('carol'))), 'mismatch')
    assert.equal(await route.changed(w), false, 'nothing changed')
    assert.equal(w.spentNonces(), 0)
    route.ok(await call(w, await w.sign(route.subject('bob'))))
    assert.equal(await route.changed(w), true)
  })

  test(`${route.name}: an admin without a key cannot change an account that has one`, async (t) => {
    const w = await adminWorld(t, { adminKey: false, targetKey: true })
    route.setup?.(w)
    required(await call(w))
    assert.equal(await route.changed(w), false, 'nothing changed')
  })

  test(`${route.name}: neither with a key, as today`, async (t) => {
    const w = await adminWorld(t, { adminKey: false, targetKey: false })
    route.setup?.(w)
    route.ok(await call(w))
    assert.equal(await route.changed(w), true)
  })
}

test('PATCH /users/:id is_admin with a key: the last admin still cannot be demoted, and the refusal spends no nonce', async (t) => {
  const w = await adminWorld(t, { adminKey: true, targetKey: false })
  const approval = await w.sign({ op: 'admin_set_admin', user: 'alice', admin: 'false' })
  const r = await w.s.http(`/users/${w.alice.id}`, { method: 'PATCH', token: w.token, body: { is_admin: false, approval } })
  assert.deepEqual([r.status, r.json], [409, { error: 'conflict', reason: 'last_admin' }])
  assert.equal(w.spentNonces(), 0)
})

test('POST /users by an admin with a key: every creation is signed over the new name and its admin flag', async (t) => {
  const w = await adminWorld(t, { adminKey: true, targetKey: false })
  const create = (body) => w.s.http('/users', { method: 'POST', token: w.token, body: { password: 'carol-pw-123', ...body } })
  const exists = (name) => !!w.s.db.prepare('SELECT 1 FROM users WHERE name=?').get(name)
  required(await create({ name: 'carol' }))
  invalid(await create({ name: 'carol', is_admin: true, approval: await w.sign({ op: 'admin_create_user', user: 'carol', admin: 'false' }) }), 'mismatch')
  invalid(await create({ name: 'carol', approval: await w.sign({ op: 'admin_create_user', user: 'dave', admin: 'false' }) }), 'mismatch')
  assert.equal(exists('carol'), false)
  assert.equal(w.spentNonces(), 0)
  const plain = await create({ name: 'carol', approval: await w.sign({ op: 'admin_create_user', user: 'carol', admin: 'false' }) })
  assert.equal(plain.status, 201, JSON.stringify(plain.json))
  assert.equal(plain.json.user.is_admin, false)
  const admin = await create({ name: 'dave', is_admin: true, approval: await w.sign({ op: 'admin_create_user', user: 'dave', admin: 'true' }) })
  assert.equal(admin.status, 201, JSON.stringify(admin.json))
  assert.equal(admin.json.user.is_admin, true)
  // A taken name is today's 409 and spends nothing.
  const before = w.spentNonces()
  const taken = await create({ name: 'dave', approval: await w.sign({ op: 'admin_create_user', user: 'dave', admin: 'false' }) })
  assert.equal(taken.status, 409)
  assert.equal(w.spentNonces(), before)
})

test('POST /users by an admin with no key is as today, admin or not', async (t) => {
  const w = await adminWorld(t, { adminKey: false, targetKey: true })
  const r = await w.s.http('/users', { method: 'POST', token: w.token, body: { name: 'carol', password: 'carol-pw-123', is_admin: true } })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  assert.equal(r.json.user.is_admin, true)
})

test('PUT /users/:id/email with a key: the subject names the new address by its hash; clearing it is the hash of the empty string', async (t) => {
  const w = await adminWorld(t, { adminKey: true, targetKey: false })
  const put = async (email, subject) => w.s.http(`/users/${w.bob.id}/email`, { method: 'PUT', token: w.token, body: { email, approval: await w.sign(subject) } })
  invalid(await put(BOB_EMAIL, { op: 'admin_set_reset_email', user: 'bob', email_sha256: sha('eve@example.com') }), 'mismatch')
  assert.equal((await put(BOB_EMAIL, { op: 'admin_set_reset_email', user: 'bob', email_sha256: sha(BOB_EMAIL) })).status, 200)
  const cleared = await put(null, { op: 'admin_set_reset_email', user: 'bob', email_sha256: sha('') })
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json))
  assert.equal(cleared.json.user.email, null)
})

test('DELETE /users/:id/two-factor re-checks the caller is still an admin after its body, like its neighbours', async (t) => {
  // The body (it may carry the approval) is a window: a demotion while it
  // is still arriving must be honoured.
  const w = await adminWorld(t, { adminKey: false, targetKey: false })
  const body = JSON.stringify({ pad: 'x'.repeat(200) })
  const r = await new Promise((resolve, reject) => {
    const req = http.request(`${w.s.base}/users/${w.bob.id}/two-factor`, {
      method: 'DELETE', agent: false,
      headers: { authorization: `Bearer ${w.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null }))
    })
    req.on('error', reject)
    req.write(body.slice(0, 100))
    setTimeout(() => {
      w.s.db.prepare('UPDATE users SET is_admin=0 WHERE id=?').run(w.alice.id)
      req.end(body.slice(100))
    }, 50)
  })
  assert.deepEqual([r.status, r.json], [403, { error: 'forbidden' }])
  assert.equal(isTwoFactorEnabled(w.s.db, w.bob.id), true)
})

// ---- No key, agents ------------------------------------------------------

test('no approval key: every one of these routes behaves as today, with no signature', async (t) => {
  const w = await world(t, { withKey: false })
  const ok = (r) => assert.equal(r.status, 200, JSON.stringify(r.json))
  ok(await w.post('/coordinator', { convo_id: 'c1', consent: false, transfer_consent: true }, 'PUT'))
  assert.deepEqual((await w.s.http('/coordinator', { token: w.token })).json, { convo_id: 'c1', consent: false, transfer_consent: true })
  ok(await w.post('/coordinator', { convo_id: null }, 'PUT'))
  const pair = (await w.s.http('/pair/start', { method: 'POST', body: {} })).json
  ok(await w.post('/pair/approve', { pair_code: pair.pair_code, agent_name: 'box-b' }))
  const link = (await w.post('/link/start', {})).json
  await w.s.http('/link/claim', { method: 'POST', body: { link_code: link.link_code, device_name: 'laptop' } })
  ok(await w.post('/link/approve', { link_code: link.link_code }))
  ok(await w.post('/2fa/recovery-codes', { password: TEST_PASSWORD, code: w.code() }))
  const setup = await w.post('/2fa/setup', { password: TEST_PASSWORD, code: w.code() })
  ok(setup)
  ok(await w.post('/2fa/enable', { code: hotp(base32Decode(setup.json.secret), totpStep()) }))
  w.s.db.prepare('UPDATE two_factor SET last_step=0 WHERE user_id=?').run(w.alice.id)
  ok(await w.post('/2fa/disable', { password: TEST_PASSWORD, code: hotp(base32Decode(setup.json.secret), totpStep()) }))
  ok(await w.post('/password', { old_password: TEST_PASSWORD, new_password: NEW_PW }))
  assert.equal(w.spentNonces(), 0)
})

test('agent tokens: these routes stay client-only, with or without a key', async (t) => {
  const w = await world(t)
  const asBox = (path, body, method = 'POST') => w.s.http(path, { method, token: w.box.token, body })
  for (const [path, body, method] of [
    ['/password', { old_password: TEST_PASSWORD, new_password: NEW_PW }],
    ['/pair/approve', { pair_code: 'ZZZZ-ZZZZ', agent_name: 'box-b' }],
    ['/link/approve', { link_code: 'ZZZZ-ZZZZ' }],
    ['/coordinator', { convo_id: 'c1' }, 'PUT'],
    ['/2fa/setup', { password: TEST_PASSWORD }],
    ['/2fa/enable', { code: '000000' }],
    ['/2fa/disable', { password: TEST_PASSWORD, code: '000000' }],
    ['/2fa/recovery-codes', { password: TEST_PASSWORD, code: '000000' }],
  ]) {
    const r = await asBox(path, body, method)
    assert.deepEqual([r.status, r.json], [403, { error: 'forbidden' }], path)
  }
})
