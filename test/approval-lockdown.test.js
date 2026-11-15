// Lockdown after failures, and the journal's part of locked boxes.
//
// - Two invalid approvals from one client device within ten minutes sign
//   that device out (its approval key goes with it), with a notice and a
//   push; other devices are untouched; a missing approval does not count.
//   Every family of guarded route counts, though its own transaction rolls
//   back on the refusal.
// - Three wrong passwords or codes on the password-and-code path within an
//   hour lock it for the account (1 h, then 6 h, then 24 h), in the
//   database, so a restart does not lift it. Enrolment approved by a key
//   still works.
// - A user's event delivered to an agent carries approval_key_id, stamped
//   by the journal; a bridge reports `locked`; unlock/lock/clear_lockdown
//   are ordinary RPCs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { startTestServer, makeWsClient } from './helpers.js'
import { createAgent, createUser } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import {
  hasActiveKey, requireApproval, recordEnrolmentFailure, enrolmentLockedUntil,
  DEVICE_FAILURE_WINDOW_MS, ENROL_FAILURE_WINDOW_MS,
} from '../src/approval-keys.js'
import {
  startWithKey, startApprovalServer, signIn, signAccount, signApproval, enableTwoFactor, enrolKeyByPassword,
  generateApprovalKey, totpCode, TEST_JOURNAL, TEST_PASSWORD, TEST_PUBLIC_URL, TEST_TOKEN_KEY,
} from './approval-helpers.js'

const GARBAGE = { statement: 'not a statement', signature: 'AAAA' }
const HOUR = 3600000
const notices = (s, userId) => s.db.prepare("SELECT title, body FROM items WHERE user_id=? AND kind='notice' ORDER BY num").all(userId)
const failures = (s, deviceId) => s.db.prepare('SELECT * FROM approval_failures WHERE device_id=? ORDER BY id').all(deviceId)
const signedIn = async (s, token) => (await s.http('/approval-keys', { token })).status === 200
const tick = () => new Promise((r) => setTimeout(r, 30))

function makeStubApnsClient() {
  const calls = []
  return { calls, send(opts) { calls.push(opts); return Promise.resolve({ status: 200, reason: null }) } }
}

// alice with a key on her phone, a box with one conversation, the box's
// bridge connected.
async function world(t, opts = {}) {
  const base = await startWithKey(t, opts)
  const { s, alice } = base
  const box = createAgent(s.db, alice.id, 'box-a')
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: box.deviceId })
  const agentWs = await makeWsClient(s.base, { token: box.token, cursor: null })
  await agentWs.waitFor((f) => f.op === 'hello_ok')
  const sockets = [agentWs]
  t.after(() => { for (const w of sockets) { try { w.close() } catch { /* closed */ } } })
  const clientWs = async (token, hello = {}) => {
    const w = await makeWsClient(s.base, { token, cursor: null, hello })
    sockets.push(w)
    await w.waitFor((f) => f.op === 'hello_ok')
    return w
  }
  const protect = async (deviceId = box.deviceId) => {
    const approval = await signAccount(s, { token: base.token, key: base.key, subject: { op: 'protect_device', device: String(deviceId), on: 'true' } })
    const r = await s.http(`/devices/${deviceId}/protected`, { method: 'POST', token: base.token, body: { on: true, approval } })
    assert.equal(r.status, 200, JSON.stringify(r.json))
  }
  return { ...base, box, agentWs, clientWs, protect }
}

const invalid = (r, reason) => assert.deepEqual([r.status, r.json], [400, { error: 'approval_invalid', reason }])
const refused = (r, reason) => assert.deepEqual(r, { ok: false, status: 400, body: { error: 'approval_invalid', reason } })

// ---- Per device ------------------------------------------------------------

// A statement the journal accepts in every way but its signature.
const badSignature = async (s, token, key, subject) => {
  const a = await signAccount(s, { token, key, subject })
  return { ...a, signature: a.signature.slice(0, -6) + 'AAAAAA' }
}

test('two invalid approvals from one device sign it out: its key detached, not revoked; a notice naming the reasons, and a push; other devices untouched', async (t) => {
  const apns = makeStubApnsClient()
  const w = await world(t, { apnsClient: apns })
  const { s, alice } = w
  const laptop = signIn(s, alice.id, 'laptop')
  await s.http('/push/register', { method: 'POST', token: laptop.token, body: { apns_token: 'laptop-token', environment: 'prod' } })
  const laptopKey = await enrolKeyByPassword(s, { token: laptop.token, userId: alice.id, secret: w.secret, name: 'laptop' })

  invalid(await s.http('/approval-keys/attach', { method: 'POST', token: w.token, body: { approval: GARBAGE } }), 'bad_statement')
  assert.equal(await signedIn(s, w.token), true, 'one failure is not enough')
  assert.deepEqual(failures(s, w.deviceId).map((f) => [f.user_id, f.reason, f.device_name]), [[alice.id, 'bad_statement', 'phone']])

  // The second one is still answered as itself.
  const subject = { op: 'protect_device', device: String(w.box.deviceId), on: 'true' }
  invalid(await s.http(`/devices/${w.box.deviceId}/protected`, { method: 'POST', token: w.token, body: { on: true, approval: await badSignature(s, w.token, w.key, subject) } }), 'signature')

  assert.equal(await signedIn(s, w.token), false, 'the phone is signed out')
  assert.equal(s.db.prepare('SELECT 1 FROM devices WHERE id=?').get(w.deviceId), undefined)
  assert.equal(await signedIn(s, laptop.token), true, 'the laptop is not')
  const keys = s.db.prepare('SELECT key_id, device_id, revoked_at FROM approval_keys ORDER BY id').all()
  assert.deepEqual(keys.find((k) => k.key_id === w.key.keyId), { key_id: w.key.keyId, device_id: null, revoked_at: null }, 'the phone\'s key stays enrolled, attached to no device')
  assert.equal(keys.find((k) => k.key_id === laptopKey.keyId).revoked_at, null)

  const n = notices(s, alice.id)
  const out = n.find((x) => x.title === 'Signed out phone: invalid approval signatures')
  assert.ok(out, JSON.stringify(n.map((x) => x.title)))
  assert.match(out.body, new RegExp(w.key.keyId.slice(0, 8)))
  assert.match(out.body, /stays enrolled/)
  assert.match(out.body, /attach/i)
  assert.match(out.body, /malformed statement/)
  assert.match(out.body, /signature that does not verify/)
  assert.equal(n.some((x) => x.title.startsWith('Approval key removed')), false, 'no key was removed')
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(apns.calls.some((c) => c.deviceToken === 'laptop-token' && /Signed out phone/.test(JSON.stringify(c.payload))), 'pushed to the other devices')
  // Reviewable later: both failures and their reasons stay, no longer tied
  // to a device id the next sign-in may be given.
  assert.deepEqual(s.db.prepare("SELECT device_id, reason FROM approval_failures WHERE device_name='phone' ORDER BY id").all(),
    [{ device_id: null, reason: 'bad_statement' }, { device_id: null, reason: 'signature' }])

  // Signed in again, the phone re-attaches its key with the key's own signature.
  const again = signIn(s, alice.id, 'phone')
  const approval = await signAccount(s, { token: again.token, key: w.key, subject: { op: 'attach_key', key_id: w.key.keyId } })
  assert.equal((await s.http('/approval-keys/attach', { method: 'POST', token: again.token, body: { approval } })).status, 200)
})

test('a lockdown sign-out is no way back to unsigned: the only keyed device signed out, the account still has its key and a step-up tap still needs a signature', async (t) => {
  const w = await world(t)
  const { s, alice } = w
  const laptop = signIn(s, alice.id, 'laptop')
  invalid(await s.http('/approval-keys/attach', { method: 'POST', token: w.token, body: { approval: GARBAGE } }), 'bad_statement')
  invalid(await s.http('/approval-keys/attach', { method: 'POST', token: w.token, body: { approval: GARBAGE } }), 'bad_statement')
  assert.equal(await signedIn(s, w.token), false)
  assert.equal(hasActiveKey(s.db, alice.id), true)
  const item = (await s.http('/items', { method: 'POST', token: w.box.token, body: { convo_id: 'c1', kind: 'question', title: 'Go?', body: 'b', actions: ['Yes', 'No'], step_up: true } })).json.item
  const r = await s.http(`/items/${item.id}/comments`, { method: 'POST', token: laptop.token, body: { action: 'Yes' } })
  assert.deepEqual([r.status, r.json], [403, { error: 'approval_required' }])
})

test('only signature, bad_statement, unknown_key and wrong_device count; nonce, mismatch and revoked_key are stored but never sign a device out', async (t) => {
  const w = await world(t)
  const { s, alice } = w
  const laptop = signIn(s, alice.id, 'laptop')
  const laptopKey = await enrolKeyByPassword(s, { token: laptop.token, userId: alice.id, secret: w.secret, name: 'laptop' })
  const subject = { op: 'protect_device', device: String(w.box.deviceId), on: 'true' }
  const protect = (token, approval) => s.http(`/devices/${w.box.deviceId}/protected`, { method: 'POST', token, body: { on: true, approval } })
  // An agent editing the question while the user signs, a retry, a key
  // revoked elsewhere: an honest app can send each of these.
  for (let i = 0; i < 3; i++) {
    invalid(await protect(w.token, await signAccount(s, { token: w.token, key: w.key, subject: { ...subject, on: 'false' } })), 'mismatch')
    const used = await signAccount(s, { token: w.token, key: w.key, subject })
    s.db.prepare('UPDATE approval_nonces SET used_at=? WHERE nonce=?').run(Date.now(), JSON.parse(used.statement).nonce)
    invalid(await protect(w.token, used), 'nonce')
  }
  const revokeLaptop = await signAccount(s, { token: laptop.token, key: laptopKey, subject: { op: 'revoke_key', key_id: laptopKey.keyId } })
  const old = await signAccount(s, { token: laptop.token, key: laptopKey, subject })
  assert.equal((await s.http(`/approval-keys/${laptopKey.keyId}/revoke`, { method: 'POST', token: laptop.token, body: { approval: revokeLaptop } })).status, 200)
  invalid(await protect(laptop.token, old), 'revoked_key')
  invalid(await protect(laptop.token, await signAccount(s, { token: laptop.token, key: laptopKey, subject })), 'revoked_key')
  assert.equal(await signedIn(s, w.token), true)
  assert.equal(await signedIn(s, laptop.token), true)
  assert.deepEqual(failures(s, w.deviceId).map((f) => f.reason), ['mismatch', 'nonce', 'mismatch', 'nonce', 'mismatch', 'nonce'])
  assert.deepEqual(failures(s, laptop.deviceId).map((f) => f.reason), ['revoked_key', 'revoked_key'])

  // Three that count, from fresh devices, two of a kind each.
  const stranger = generateApprovalKey()
  const kinds = {
    bad_statement: async () => GARBAGE,
    unknown_key: (d) => signAccount(s, { token: d.token, key: stranger, subject }),
    wrong_device: (d) => signAccount(s, { token: d.token, key: w.key, subject }),
  }
  for (const [reason, make] of Object.entries(kinds)) {
    const d = signIn(s, alice.id, `dev-${reason}`)
    invalid(await protect(d.token, await make(d)), reason)
    assert.equal(await signedIn(s, d.token), true, reason)
    invalid(await protect(d.token, await make(d)), reason)
    assert.equal(await signedIn(s, d.token), false, `${reason} counts`)
  }
  // And signature, from the phone itself (the key's own device), after the
  // mismatches and nonces that did not count.
  invalid(await protect(w.token, await badSignature(s, w.token, w.key, subject)), 'signature')
  assert.equal(await signedIn(s, w.token), true, 'mismatch and nonce before it did not count')
  invalid(await protect(w.token, await badSignature(s, w.token, w.key, subject)), 'signature')
  assert.equal(await signedIn(s, w.token), false)
})

test('an account with no key: a failed check on the key routes is not recorded and never signs a device out', async (t) => {
  const { s, alice, token } = await startApprovalServer(t)
  for (let i = 0; i < 3; i++) {
    const r = await s.http('/approval-keys/attach', { method: 'POST', token, body: { approval: GARBAGE } })
    assert.equal(r.json.error, 'approval_invalid')
  }
  assert.equal(await signedIn(s, token), true)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM approval_failures').get().n, 0)
  assert.equal(notices(s, alice.id).length, 0)
})

test('a missing approval never counts; failures are per device', async (t) => {
  const w = await world(t)
  const { s, alice } = w
  const tablet = signIn(s, alice.id, 'tablet')
  for (let i = 0; i < 3; i++) {
    const r = await s.http(`/devices/${w.box.deviceId}/protected`, { method: 'POST', token: w.token, body: { on: true } })
    assert.deepEqual([r.status, r.json], [403, { error: 'approval_required' }])
  }
  invalid(await s.http('/approval-keys/attach', { method: 'POST', token: w.token, body: { approval: GARBAGE } }), 'bad_statement')
  invalid(await s.http('/approval-keys/attach', { method: 'POST', token: tablet.token, body: { approval: GARBAGE } }), 'bad_statement')
  assert.equal(await signedIn(s, w.token), true)
  assert.equal(await signedIn(s, tablet.token), true)
  assert.equal(notices(s, alice.id).some((x) => x.title.startsWith('Signed out')), false)
})

test('the window is ten minutes, on the injected clock; a nonce failure is recorded as such and does not count', async (t) => {
  const w = await world(t)
  const { s, alice } = w
  const tablet = signIn(s, alice.id, 'tablet')
  const who = { userId: alice.id, deviceId: tablet.deviceId, kind: 'client' }
  const expect = { type: 'account', subject: { op: 'x' } }
  const t0 = 1_800_000_000_000
  refused(requireApproval({ db: s.db, journalHost: TEST_JOURNAL, now: t0 }, who, { approval: GARBAGE }, expect), 'bad_statement')
  refused(requireApproval({ db: s.db, journalHost: TEST_JOURNAL, now: t0 + DEVICE_FAILURE_WINDOW_MS + 1 }, who, { approval: GARBAGE }, expect), 'bad_statement')
  assert.equal(await signedIn(s, tablet.token), true, 'ten minutes and a millisecond apart: not two within ten minutes')
  // A stale nonce: everything else about the statement is right.
  const approval = await signApproval(s, { token: w.token, key: w.key, type: 'account', subject: { op: 'x' } })
  const phone = { userId: alice.id, deviceId: w.deviceId, kind: 'client' }
  refused(requireApproval({ db: s.db, journalHost: TEST_JOURNAL, now: Date.now() + 10 * 60000 }, phone, { approval }, expect), 'nonce')
  assert.deepEqual(failures(s, w.deviceId).map((f) => f.reason), ['nonce'])
  refused(requireApproval({ db: s.db, journalHost: TEST_JOURNAL, now: Date.now() + 10 * 60000 + 1 }, phone, { approval: GARBAGE }, expect), 'bad_statement')
  assert.equal(await signedIn(s, w.token), true, 'a nonce and a bad statement: one that counts')
  refused(requireApproval({ db: s.db, journalHost: TEST_JOURNAL, now: t0 + DEVICE_FAILURE_WINDOW_MS + 2 }, who, { approval: GARBAGE }, expect), 'bad_statement')
  assert.equal(await signedIn(s, tablet.token), false, 'the third, a millisecond after the second')
  assert.equal(await signedIn(s, w.token), true)
})

test('every family of guarded route counts, though each rolls its own transaction back on the refusal', async (t) => {
  const w = await world(t, { spawnStartTimeoutMs: 2000 })
  const { s, alice } = w
  const target = createAgent(s.db, alice.id, 'box-b')
  const targetWs = await makeWsClient(s.base, { token: target.token, cursor: null })
  await targetWs.waitFor((f) => f.op === 'hello_ok')
  t.after(() => targetWs.close())
  await w.protect(target.deviceId)
  const item = (await s.http('/items', { method: 'POST', token: w.box.token, body: { convo_id: 'c1', kind: 'question', title: 'Wire it?', body: 'Pay', actions: ['Approve', 'Deny'], step_up: true } })).json.item
  let askN = 0
  const parkSpawn = async () => {
    const rid = `q${++askN}`
    w.agentWs.send({ op: 'spawn_request', request_id: rid, from_convo_id: 'c1', target_device_id: target.deviceId, workdir: '/w', task: 'do it', topic: 'x' })
    return (await w.agentWs.waitFor((x) => x.kind === 'spawn' && x.event === 'pending' && x.request_id === rid)).spawn_id
  }
  const families = {
    tap: (d) => s.http(`/items/${item.id}/comments`, { method: 'POST', token: d.token, body: { action: 'Approve', approval: GARBAGE } }),
    consent: async (d) => s.http('/agent-spawn/answer', { method: 'POST', token: d.token, body: { request_id: await parkSpawn(), decision: 'approve', approval: GARBAGE } }),
    account: (d) => s.http(`/devices/${w.box.deviceId}/protected`, { method: 'POST', token: d.token, body: { on: true, approval: GARBAGE } }),
    key_attach: (d) => s.http('/approval-keys/attach', { method: 'POST', token: d.token, body: { approval: GARBAGE } }),
    key_revoke: (d) => s.http(`/approval-keys/${w.key.keyId}/revoke`, { method: 'POST', token: d.token, body: { approval: GARBAGE } }),
    ws_start: async (d) => {
      const c = await w.clientWs(d.token)
      const rid = `r${d.deviceId}-${c.frames.length}`
      c.send({ op: 'agent_request', request_id: rid, agent_device_id: target.deviceId, method: 'start', params: { workdir: '/w', prompt: 'hi', approval: GARBAGE } })
      const e = await c.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.request_id === rid)
      return { status: 400, json: { error: e.code, reason: e.detail } }
    },
  }
  for (const [name, call] of Object.entries(families)) {
    const d = signIn(s, alice.id, `dev-${name}`)
    invalid(await call(d), 'bad_statement')
    assert.equal(failures(s, d.deviceId).length, 1, `${name}: the first failure is recorded`)
    assert.equal(await signedIn(s, d.token), true, `${name}: still signed in`)
    invalid(await call(d), 'bad_statement')
    await tick()
    assert.equal(await signedIn(s, d.token), false, `${name}: the second signs it out`)
  }
  assert.equal(await signedIn(s, w.token), true, 'the phone was never touched')
  assert.equal(hasActiveKey(s.db, alice.id), true)
})

// ---- Enrolment by password and code ----------------------------------------

test('three wrong codes lock password-and-code enrolment, with a notice; the lock survives a restart; key-approved enrolment still works', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lockdown-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'journal.db')
  const opts = { dbPath, tokenKey: TEST_TOKEN_KEY, publicUrl: TEST_PUBLIC_URL }
  let s = await startTestServer(opts)
  let open = true
  t.after(() => open && s.close())
  const alice = await createUser(s.db, 'alice', TEST_PASSWORD)
  const phone = signIn(s, alice.id, 'phone')
  const { secret, recoveryCodes } = await enableTwoFactor(s, phone.token)
  const key = generateApprovalKey()
  const enrol = (body, token = phone.token) => s.http('/approval-keys', { method: 'POST', token, body: { public_key: key.publicKey, name: 'phone', password: TEST_PASSWORD, ...body } })
  const right = () => totpCode(s, alice.id, secret)
  const wrongCode = () => (right() === '000000' ? '000001' : '000000')

  // Neither a malformed request nor a recovery code is a guess.
  assert.equal((await enrol({ password: undefined, code: right() })).status, 400)
  for (let i = 0; i < 3; i++) assert.deepEqual((await enrol({ code: recoveryCodes[0] })).json, { error: 'totp_required' })
  assert.equal((await enrol({ code: wrongCode() })).status, 403)
  assert.equal((await enrol({ password: 'nope', code: right() })).status, 401)
  const before = Date.now()
  assert.equal((await enrol({ code: wrongCode() })).status, 403, 'the third failure is still answered as itself')

  const locked = await enrol({ code: right() })
  assert.equal(locked.status, 429)
  assert.deepEqual(Object.keys(locked.json).sort(), ['error', 'retry_at'])
  assert.equal(locked.json.error, 'enrolment_locked')
  assert.ok(locked.json.retry_at >= before + HOUR && locked.json.retry_at <= Date.now() + HOUR, String(locked.json.retry_at))
  assert.equal(hasActiveKey(s.db, alice.id), false)
  const n = notices(s, alice.id)
  assert.equal(n.length, 1)
  assert.match(n[0].title, /^Approval key enrolment locked until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/)
  assert.match(n[0].body, /three/i)
  assert.match(n[0].body, /remov/i, 'says removing a key by password is locked too')

  // A restart on the same database file does not lift it.
  await s.close()
  open = false
  s = await startTestServer(opts)
  open = true
  const again = await enrol({ code: right() })
  assert.deepEqual([again.status, again.json], [429, { error: 'enrolment_locked', retry_at: locked.json.retry_at }])

  // An enrolment approved by a key is unaffected: give the account a key
  // the way an operator could, then approve a new device's key with it.
  const seed = generateApprovalKey()
  s.db.prepare(`INSERT INTO approval_keys(user_id, key_id, public_key, alg, name, device_id, enrolled_via, enrolled_by, created_at)
    VALUES(?,?,?,'ES256','seed',?,'password',NULL,?)`).run(alice.id, seed.keyId, seed.publicKey, phone.deviceId, Date.now())
  const tablet = signIn(s, alice.id, 'tablet')
  const asked = await s.http('/approval-keys/requests', { method: 'POST', token: tablet.token, body: { public_key: key.publicKey, name: 'tablet' } })
  assert.equal(asked.status, 200, JSON.stringify(asked.json))
  const approval = await signAccount(s, { token: phone.token, key: seed, subject: { op: 'enrol_key', key_id: key.keyId } })
  const ok = await s.http(`/approval-keys/requests/${asked.json.id}/approve`, { method: 'POST', token: phone.token, body: { approval } })
  assert.equal(ok.status, 200, JSON.stringify(ok.json))
})

test('a password-and-code revoke shares the lock: its failures count, and it is refused while locked', async (t) => {
  const { s, alice, token, secret, key } = await startWithKey(t)
  const revoke = (body) => s.http(`/approval-keys/${key.keyId}/revoke`, { method: 'POST', token, body: { password: TEST_PASSWORD, ...body } })
  const wrong = () => (totpCode(s, alice.id, secret) === '000000' ? '000001' : '000000')
  for (let i = 0; i < 3; i++) assert.equal((await revoke({ code: wrong() })).status, 403)
  const r = await revoke({ code: totpCode(s, alice.id, secret) })
  assert.equal(r.status, 429)
  assert.equal(r.json.error, 'enrolment_locked')
  assert.equal(hasActiveKey(s.db, alice.id), true)
  const other = generateApprovalKey()
  const e = await s.http('/approval-keys', { method: 'POST', token, body: { public_key: other.publicKey, name: 'x', password: TEST_PASSWORD, code: totpCode(s, alice.id, secret) } })
  assert.equal(e.status, 429, 'the same lock as enrolment')
  // A signed revoke is not the password path.
  const approval = await signAccount(s, { token, key, subject: { op: 'revoke_key', key_id: key.keyId } })
  assert.equal((await s.http(`/approval-keys/${key.keyId}/revoke`, { method: 'POST', token, body: { approval } })).status, 200)
})

test('the lock escalates 1 h, 6 h, 24 h and stays at 24 h; seven days without a lock start again at 1 h; old failures fall out of the hour', async (t) => {
  const { s, alice } = await startApprovalServer(t)
  const who = { userId: alice.id, deviceId: 1 }
  const t0 = 1_800_000_000_000
  // Three failures, the first more than an hour before the third: no lock.
  assert.equal(recordEnrolmentFailure(s.db, who, 'bad_code', t0), null)
  assert.equal(recordEnrolmentFailure(s.db, who, 'bad_code', t0 + ENROL_FAILURE_WINDOW_MS - 10), null)
  assert.equal(recordEnrolmentFailure(s.db, who, 'bad_code', t0 + ENROL_FAILURE_WINDOW_MS + 1), null)
  let now = t0 + ENROL_FAILURE_WINDOW_MS + 2
  const lockAt = (n) => {
    let out = null
    for (let i = 0; i < 3; i++) out = recordEnrolmentFailure(s.db, who, 'bad_password', n + i)
    return out
  }
  // The window's two failures and one more lock it.
  const first = recordEnrolmentFailure(s.db, who, 'bad_password', now)
  assert.deepEqual(first, { level: 1, until: now + HOUR })
  assert.equal(enrolmentLockedUntil(s.db, alice.id, now + HOUR - 1), now + HOUR)
  assert.equal(enrolmentLockedUntil(s.db, alice.id, now + HOUR), null)
  now += HOUR
  const second = lockAt(now)
  assert.deepEqual(second, { level: 2, until: now + 2 + 6 * HOUR })
  now = second.until
  const third = lockAt(now)
  assert.deepEqual(third, { level: 3, until: now + 2 + 24 * HOUR })
  now = third.until
  const fourth = lockAt(now)
  assert.deepEqual(fourth, { level: 4, until: now + 2 + 24 * HOUR })
  now = fourth.until + 7 * 24 * HOUR
  assert.deepEqual(lockAt(now), { level: 1, until: now + 2 + HOUR })
})

// ---- approval_key_id ---------------------------------------------------------

test('a user\'s event reaches the agent with the sending device\'s key: on a send, an item tap and a comment; null without one; never the client\'s', async (t) => {
  const w = await world(t)
  const { s, alice } = w
  const laptop = signIn(s, alice.id, 'laptop')
  const phoneWs = await w.clientWs(w.token)
  const laptopWs = await w.clientWs(laptop.token)
  const agentGets = (pred) => w.agentWs.waitFor((f) => f.kind === 'journal' && pred(f))

  phoneWs.send({ op: 'send', convo_id: 'c1', approval_key_id: 'forged', payload: { body: 'from the phone' } })
  const a = await agentGets((f) => f.payload?.body === 'from the phone')
  assert.equal(a.approval_key_id, w.key.keyId)
  // The client's own copy is today's frame.
  const own = await phoneWs.waitFor((f) => f.kind === 'journal' && f.payload?.body === 'from the phone')
  assert.equal('approval_key_id' in own, false)

  laptopWs.send({ op: 'send', convo_id: 'c1', approval_key_id: w.key.keyId, payload: { body: 'from the laptop' } })
  const b = await agentGets((f) => f.payload?.body === 'from the laptop')
  assert.equal(b.approval_key_id, null, 'a device with no key: null, whatever it claims')

  // Taps and comments on an item reach the agent the same way.
  const item = (await s.http('/items', { method: 'POST', token: w.box.token, body: { convo_id: 'c1', kind: 'question', title: 'Go?', body: 'b', actions: ['Yes', 'No'] } })).json.item
  assert.equal((await s.http(`/items/${item.id}/comments`, { method: 'POST', token: w.token, body: { action: 'Yes' } })).status, 201)
  const tap = await agentGets((f) => f.type === 'item' && f.payload?.comment?.action === 'Yes')
  assert.equal(tap.approval_key_id, w.key.keyId)
  assert.equal((await s.http(`/items/${item.id}/comments`, { method: 'POST', token: laptop.token, body: { body: 'and another thing' } })).status, 201)
  const comment = await agentGets((f) => f.type === 'item' && f.payload?.comment?.body === 'and another thing')
  assert.equal(comment.approval_key_id, null)

  // An agent's own events carry no stamp at all.
  const created = w.agentWs.frames.find((f) => f.kind === 'journal' && f.type === 'item' && f.payload?.action === 'created')
  assert.equal('approval_key_id' in created, false)

  // A revoked key stamps nothing.
  const approval = await signAccount(s, { token: w.token, key: w.key, subject: { op: 'revoke_key', key_id: w.key.keyId } })
  assert.equal((await s.http(`/approval-keys/${w.key.keyId}/revoke`, { method: 'POST', token: w.token, body: { approval } })).status, 200)
  phoneWs.send({ op: 'send', convo_id: 'c1', payload: { body: 'after the revoke' } })
  assert.equal((await agentGets((f) => f.payload?.body === 'after the revoke')).approval_key_id, null)

  // Replayed history cannot say which device sent it: null.
  const again = await makeWsClient(s.base, { token: w.box.token, cursor: 0 })
  t.after(() => again.close())
  const replayed = await again.waitFor((f) => f.kind === 'journal' && f.payload?.body === 'from the phone')
  assert.equal(replayed.approval_key_id, null)
})

test('an account with no key: user events reach the agent with approval_key_id null and nothing else changes', async (t) => {
  const { s, alice, token } = await startApprovalServer(t)
  const box = createAgent(s.db, alice.id, 'box-a')
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: box.deviceId })
  const agent = await makeWsClient(s.base, { token: box.token, cursor: null })
  const client = await makeWsClient(s.base, { token, cursor: null })
  t.after(() => { agent.close(); client.close() })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  client.send({ op: 'send', convo_id: 'c1', payload: { body: 'hello' } })
  const f = await agent.waitFor((x) => x.kind === 'journal' && x.payload?.body === 'hello')
  const own = await client.waitFor((x) => x.kind === 'journal' && x.payload?.body === 'hello')
  const { approval_key_id: stamp, ...rest } = f
  assert.equal(stamp, null)
  assert.deepEqual(rest, own)
})

// ---- locked ------------------------------------------------------------------

test('a bridge reports locked in its hello and later updates; the device list shows it as reported; malformed is ignored; only its own device', async (t) => {
  const { s, alice, token } = await startApprovalServer(t)
  const box = createAgent(s.db, alice.id, 'box-a')
  const other = createAgent(s.db, alice.id, 'box-b')
  const lockedOf = async (deviceId) => (await s.http('/devices', { token })).json.devices.find((d) => d.device_id === deviceId).locked
  const L = (on, until = null, lockdownUntil = null) => ({ on, until, lockdown_until: lockdownUntil })
  assert.equal(await lockedOf(box.deviceId), null)
  // A client socket hears each change as device_meta; a box never does.
  const app = await makeWsClient(s.base, { token, cursor: null })
  t.after(() => app.close())
  await app.waitFor((f) => f.op === 'hello_ok')
  const metas = () => app.frames.filter((f) => f.kind === 'device_meta')
  const agent = await makeWsClient(s.base, { token: box.token, cursor: null, hello: { locked: { on: true, until: null } } })
  t.after(() => agent.close())
  await agent.waitFor((f) => f.op === 'hello_ok')
  assert.deepEqual(await lockedOf(box.deviceId), L(true))
  assert.equal(await lockedOf(other.deviceId), null)
  assert.equal((await s.http('/devices', { token })).json.devices.find((d) => d.kind === 'client').locked, null)
  await app.waitFor((f) => f.kind === 'device_meta')
  assert.deepEqual(metas(), [{ kind: 'device_meta', device_id: box.deviceId, name: 'box-a', tag_char: null, locked: L(true) }])

  // An unlock window: on:false with its end, kept as reported.
  const until = Date.now() + 30 * 60000
  agent.send({ op: 'box_status', locked: { on: false, until }, device_id: other.deviceId })
  await tick()
  assert.deepEqual(await lockedOf(box.deviceId), L(false, until))
  assert.equal(await lockedOf(other.deviceId), null, 'never another device')
  assert.deepEqual(metas().at(-1).locked, L(false, until))
  // The same report again: nothing changed, no frame.
  const n = metas().length
  agent.send({ op: 'box_status', locked: { on: false, until } })
  await tick()
  assert.equal(metas().length, n)
  const bads = ['yes', { on: 'true' }, { on: true, until: -1 }, { on: true, until: 1.5 }, [true], { on: true, lockdown_until: -5 }, { on: true, lockdown_until: 'soon' }, { until: 5 }]
  for (const bad of bads) agent.send({ op: 'box_status', locked: bad })
  await tick()
  assert.deepEqual(await lockedOf(box.deviceId), L(false, until), 'malformed reports change nothing')
  assert.equal(agent.frames.filter((f) => f.op === 'error' && f.ref === 'box_status' && f.code === 'bad_request').length, bads.length,
    'and a box_status with nothing valid in it is a bad_request, as before')
  assert.equal(metas().length, n)
  // A malformed `locked` beside a valid report: the report lands, the lock stays.
  agent.send({ op: 'box_status', locked: 'yes', disk: { free_bytes: 1, total_bytes: 2 } })
  await tick()
  assert.deepEqual(await lockedOf(box.deviceId), L(false, until))

  // A lockdown, with its end; extra keys are dropped.
  const lockdownUntil = Date.now() + 3600000
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: box.deviceId })
  agent.send({ op: 'status', convo_id: 'c1', status: { model: 'x' }, locked: { on: true, until: null, lockdown_until: lockdownUntil, reason: 'bad signatures' } })
  await tick()
  assert.deepEqual(await lockedOf(box.deviceId), L(true, null, lockdownUntil))
  assert.deepEqual(metas().at(-1).locked, L(true, null, lockdownUntil))
  // Times in the past are shown as reported: the journal does not expire them.
  agent.send({ op: 'box_status', locked: { on: false, until: Date.now() - 1 } })
  await tick()
  assert.equal((await lockedOf(box.deviceId)).until < Date.now(), true)
  assert.equal((await lockedOf(box.deviceId)).on, false)
  // An explicit null clears it, on box_status alone (no bad_request) and on status.
  const errors = agent.frames.filter((f) => f.op === 'error').length
  agent.send({ op: 'box_status', locked: null })
  await tick()
  assert.equal(await lockedOf(box.deviceId), null, 'locked: null clears it')
  assert.equal(agent.frames.filter((f) => f.op === 'error').length, errors)
  assert.equal(metas().at(-1).locked, null)
  agent.send({ op: 'status', convo_id: 'c1', status: { model: 'x' }, locked: { on: true } })
  await tick()
  assert.deepEqual(await lockedOf(box.deviceId), L(true))
  agent.send({ op: 'status', convo_id: 'c1', status: { model: 'x' }, locked: null })
  await tick()
  assert.equal(await lockedOf(box.deviceId), null)
  assert.ok(!agent.frames.some((f) => f.kind === 'device_meta'), 'a box keeps no roster')

  // A client cannot report one, and a hello that is malformed only there
  // still connects.
  const client = await makeWsClient(s.base, { token, cursor: null, hello: { locked: { on: true, until: null } } })
  t.after(() => client.close())
  await client.waitFor((f) => f.op === 'hello_ok')
  assert.equal((await s.http('/devices', { token })).json.devices.find((d) => d.kind === 'client').locked, null)
  const bad = await makeWsClient(s.base, { token: other.token, cursor: null, hello: { locked: 'yes' } })
  t.after(() => bad.close())
  await bad.waitFor((f) => f.op === 'hello_ok')
  assert.equal(await lockedOf(other.deviceId), null)
})

test('a hello without locked, or with locked: null, clears what an earlier one reported', async (t) => {
  const { s, alice, token } = await startApprovalServer(t)
  const box = createAgent(s.db, alice.id, 'box-a')
  const lockedOf = async () => (await s.http('/devices', { token })).json.devices.find((d) => d.device_id === box.deviceId).locked
  const until = Date.now() + 60000
  for (const hello of [{}, { locked: null }]) {
    const one = await makeWsClient(s.base, { token: box.token, cursor: null, hello: { locked: { on: false, until } } })
    await one.waitFor((f) => f.op === 'hello_ok')
    assert.deepEqual(await lockedOf(), { on: false, until, lockdown_until: null })
    one.close()
    const two = await makeWsClient(s.base, { token: box.token, cursor: null, hello })
    t.after(() => two.close())
    await two.waitFor((f) => f.op === 'hello_ok')
    assert.equal(await lockedOf(), null, JSON.stringify(hello))
    two.close()
  }
})

// ---- unlock / lock / clear_lockdown ------------------------------------------

test('unlock, lock and clear_lockdown are ordinary RPCs: forwarded with params unchanged, even to a protected box', async (t) => {
  const w = await world(t)
  await w.protect()
  const phoneWs = await w.clientWs(w.token)
  const approval = await signAccount(w.s, { token: w.token, key: w.key, subject: { op: 'unlock_box', box: 'box-a', minutes: '30' } })
  for (const [i, method] of ['unlock', 'lock', 'clear_lockdown'].entries()) {
    const params = method === 'lock' ? {} : { approval, minutes: 30 }
    phoneWs.send({ op: 'agent_request', request_id: `u${i}`, agent_device_id: w.box.deviceId, method, params })
    const got = await w.agentWs.waitFor((f) => f.kind === 'rpc' && f.request?.request_id === `u${i}`)
    assert.equal(got.request.method, method)
    assert.deepEqual(got.request.params, params)
  }
  // The journal did not check the signature: its nonce is unspent.
  assert.equal(w.s.db.prepare('SELECT used_at FROM approval_nonces WHERE nonce=?').get(JSON.parse(approval.statement).nonce).used_at, null)
})

test('client RPCs reach the agent with approval_key_id: the calling device\'s key or null, never the client\'s', async (t) => {
  const w = await world(t)
  const { s, alice } = w
  await w.protect()
  const laptop = signIn(s, alice.id, 'laptop')
  const phoneWs = await w.clientWs(w.token)
  const laptopWs = await w.clientWs(laptop.token)
  const approval = await signAccount(s, { token: w.token, key: w.key, subject: { op: 'unlock_box', box: 'box-a', minutes: '30' } })
  phoneWs.send({ op: 'agent_request', request_id: 'u1', agent_device_id: w.box.deviceId, method: 'unlock', approval_key_id: 'forged', params: { approval } })
  const u1 = await w.agentWs.waitFor((f) => f.kind === 'rpc' && f.request?.request_id === 'u1')
  assert.equal(u1.request.approval_key_id, w.key.keyId)
  assert.equal(u1.request.from_device_id, w.deviceId)
  laptopWs.send({ op: 'agent_request', request_id: 'u2', agent_device_id: w.box.deviceId, method: 'unlock', params: { approval } })
  assert.equal((await w.agentWs.waitFor((f) => f.kind === 'rpc' && f.request?.request_id === 'u2')).request.approval_key_id, null)
  // A start on the protected box, signed: the request carries the stamp too.
  const prompt = 'look at the logs'
  const sha = (x) => crypto.createHash('sha256').update(x, 'utf8').digest('hex')
  const startApproval = await signAccount(s, { token: w.token, key: w.key, subject: { op: 'start', box: 'box-a', workdir: '/w', prompt_sha256: sha(prompt) } })
  phoneWs.send({ op: 'agent_request', request_id: 's1', agent_device_id: w.box.deviceId, method: 'start', params: { workdir: '/w', prompt, approval: startApproval } })
  const s1 = await w.agentWs.waitFor((f) => f.kind === 'rpc' && f.request?.request_id === 's1')
  assert.equal(s1.request.approval_key_id, w.key.keyId)
  assert.deepEqual(s1.request.params, { workdir: '/w', prompt, approval: startApproval })
})

test('password-and-code guesses are taken one at a time: ten at once verify at most three, the rest are refused as locked', async (t) => {
  const { s, alice, token } = await startApprovalServer(t)
  const { secret } = await enableTwoFactor(s, token)
  const wrong = totpCode(s, alice.id, secret) === '000000' ? '000001' : '000000'
  const key = generateApprovalKey()
  const all = await Promise.all(Array.from({ length: 10 }, () => s.http('/approval-keys', {
    method: 'POST', token, body: { public_key: key.publicKey, name: 'phone', password: TEST_PASSWORD, code: wrong },
  })))
  const statuses = all.map((r) => r.status)
  assert.equal(statuses.filter((x) => x === 403).length, 3, JSON.stringify(statuses))
  assert.ok(all.filter((r) => r.status === 429).every((r) => r.json.error === 'enrolment_locked'), JSON.stringify(all.map((r) => r.json)))
  assert.equal(statuses.filter((x) => x === 429).length, 7)
})

// ---- POST /devices/:id/revoke --------------------------------------------------

test('with a key on the account, revoking another device is signed; unsigned changes nothing; signed revokes it with its key', async (t) => {
  const w = await world(t)
  const { s, alice } = w
  const tablet = signIn(s, alice.id, 'tablet')
  const tabletKey = await enrolKeyByPassword(s, { token: tablet.token, userId: alice.id, secret: w.secret, name: 'tablet' })
  // Even the account's only other keyed device cannot strip the phone's key.
  const r = await s.http(`/devices/${w.deviceId}/revoke`, { method: 'POST', token: tablet.token })
  assert.deepEqual([r.status, r.json], [403, { error: 'approval_required' }])
  assert.equal(await signedIn(s, w.token), true)
  assert.equal(s.db.prepare('SELECT revoked_at FROM approval_keys WHERE key_id=?').get(w.key.keyId).revoked_at, null)
  // Not owned and nonexistent stay the same 404, before any signature.
  const bob = await createUser(s.db, 'bob', 'pw')
  const bobBox = createAgent(s.db, bob.id, 'box-c')
  assert.equal((await s.http(`/devices/${bobBox.deviceId}/revoke`, { method: 'POST', token: w.token })).status, 404)
  // The subject names the device.
  const other = await signAccount(s, { token: w.token, key: w.key, subject: { op: 'revoke_device', device: String(w.box.deviceId) } })
  invalid(await s.http(`/devices/${tablet.deviceId}/revoke`, { method: 'POST', token: w.token, body: { approval: other } }), 'mismatch')
  const approval = await signAccount(s, { token: w.token, key: w.key, subject: { op: 'revoke_device', device: String(tablet.deviceId) } })
  const ok = await s.http(`/devices/${tablet.deviceId}/revoke`, { method: 'POST', token: w.token, body: { approval } })
  assert.deepEqual([ok.status, ok.json], [200, { ok: true }])
  assert.equal(await signedIn(s, tablet.token), false)
  assert.ok(s.db.prepare('SELECT revoked_at FROM approval_keys WHERE key_id=?').get(tabletKey.keyId).revoked_at > 0)
  assert.ok(notices(s, alice.id).some((n) => n.title === `Approval key removed: tablet ${tabletKey.keyId.slice(0, 8)}`))
  // A bridge too.
  const unsignedBox = await s.http(`/devices/${w.box.deviceId}/revoke`, { method: 'POST', token: w.token })
  assert.deepEqual([unsignedBox.status, unsignedBox.json], [403, { error: 'approval_required' }])
  const boxApproval = await signAccount(s, { token: w.token, key: w.key, subject: { op: 'revoke_device', device: String(w.box.deviceId) } })
  assert.equal((await s.http(`/devices/${w.box.deviceId}/revoke`, { method: 'POST', token: w.token, body: { approval: boxApproval } })).status, 200)
  assert.equal(s.db.prepare('SELECT 1 FROM devices WHERE id=?').get(w.box.deviceId), undefined)
})

test('with a key on the account, another device is revoked with the password and a TOTP code too: the stolen keyed phone from a keyless laptop', async (t) => {
  const w = await world(t)
  const { s, alice } = w
  const laptop = signIn(s, alice.id, 'laptop')
  const revoke = (body) => s.http(`/devices/${w.deviceId}/revoke`, { method: 'POST', token: laptop.token, body })
  const wrong = () => (totpCode(s, alice.id, w.secret) === '000000' ? '000001' : '000000')
  // A recovery code is refused before the password is checked, and guesses nothing.
  const rec = await revoke({ password: TEST_PASSWORD, code: 'abcd-efgh-ijkl-mnop' })
  assert.deepEqual([rec.status, rec.json], [400, { error: 'totp_required' }])
  assert.equal((await revoke({ password: 'wrong-password', code: totpCode(s, alice.id, w.secret) })).status, 401)
  assert.equal(await signedIn(s, w.token), true)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM approval_enrol_failures WHERE user_id=?').get(alice.id).n, 1, 'a wrong password counts towards the lock')
  // Not owned is the same 404, before the password.
  const bob = await createUser(s.db, 'bob', 'pw')
  const bobBox = createAgent(s.db, bob.id, 'box-c')
  assert.equal((await s.http(`/devices/${bobBox.deviceId}/revoke`, { method: 'POST', token: laptop.token, body: { password: TEST_PASSWORD, code: wrong() } })).status, 404)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM approval_enrol_failures WHERE user_id=?').get(alice.id).n, 1)
  const ok = await revoke({ password: TEST_PASSWORD, code: totpCode(s, alice.id, w.secret) })
  assert.deepEqual([ok.status, ok.json], [200, { ok: true }])
  assert.equal(await signedIn(s, w.token), false)
  assert.ok(s.db.prepare('SELECT revoked_at FROM approval_keys WHERE key_id=?').get(w.key.keyId).revoked_at > 0)
  assert.equal(hasActiveKey(s.db, alice.id), false)
  assert.ok(notices(s, alice.id).some((n) => n.title === `Approval key removed: phone ${w.key.keyId.slice(0, 8)}`))
})

test('a password-and-code device revoke shares the enrolment lock: wrong codes count, and it is refused while locked', async (t) => {
  const w = await world(t)
  const { s, alice } = w
  const laptop = signIn(s, alice.id, 'laptop')
  const revoke = (code) => s.http(`/devices/${w.deviceId}/revoke`, { method: 'POST', token: laptop.token, body: { password: TEST_PASSWORD, code } })
  const wrong = () => (totpCode(s, alice.id, w.secret) === '000000' ? '000001' : '000000')
  for (let i = 0; i < 3; i++) assert.equal((await revoke(wrong())).status, 403)
  const r = await revoke(totpCode(s, alice.id, w.secret))
  assert.deepEqual([r.status, r.json.error], [429, 'enrolment_locked'])
  assert.ok(r.json.retry_at > Date.now())
  assert.equal(await signedIn(s, w.token), true)
  // The same lock as the key routes' password path.
  const k = await s.http(`/approval-keys/${w.key.keyId}/revoke`, { method: 'POST', token: laptop.token, body: { password: TEST_PASSWORD, code: totpCode(s, alice.id, w.secret) } })
  assert.equal(k.status, 429)
  // A signed revoke is not the password path.
  const approval = await signAccount(s, { token: w.token, key: w.key, subject: { op: 'revoke_device', device: String(laptop.deviceId) } })
  assert.equal((await s.http(`/devices/${laptop.deviceId}/revoke`, { method: 'POST', token: w.token, body: { approval } })).status, 200)
})

test('signing yourself out needs no signature and detaches your key: the account keeps it', async (t) => {
  const w = await world(t)
  const { s, alice } = w
  const r = await s.http(`/devices/${w.deviceId}/revoke`, { method: 'POST', token: w.token })
  assert.deepEqual([r.status, r.json], [200, { ok: true }])
  assert.equal(await signedIn(s, w.token), false)
  assert.deepEqual(s.db.prepare('SELECT device_id, revoked_at FROM approval_keys WHERE key_id=?').get(w.key.keyId), { device_id: null, revoked_at: null })
  assert.equal(hasActiveKey(s.db, alice.id), true)
  assert.equal(notices(s, alice.id).some((n) => n.title.startsWith('Approval key removed')), false)
})

test('an account with no key: revoking any device is today\'s unsigned revoke', async (t) => {
  const { s, alice, token } = await startApprovalServer(t)
  const tablet = signIn(s, alice.id, 'tablet')
  const box = createAgent(s.db, alice.id, 'box-a')
  assert.equal((await s.http(`/devices/${tablet.deviceId}/revoke`, { method: 'POST', token })).status, 200)
  assert.equal((await s.http(`/devices/${box.deviceId}/revoke`, { method: 'POST', token })).status, 200)
  assert.equal(await signedIn(s, tablet.token), false)
  assert.equal((await s.http(`/devices/${s.db.prepare("SELECT id FROM devices WHERE name='phone'").get().id}/revoke`, { method: 'POST', token })).status, 200)
  assert.equal(await signedIn(s, token), false)
})
