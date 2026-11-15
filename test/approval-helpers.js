// Test-only helpers for approval keys: key generation and statement signing,
// and the setup most approval tests share (a journal with a public URL, a
// signed-in user with two-factor on, a first key enrolled).
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { canonicalize } from '../src/federation-jcs.js'
import { promptDigest } from '../src/approvals.js'
import { startTestServer } from './helpers.js'
import { createUser, createClientDevice } from '../src/auth.js'
import { base32Decode, hotp, totpStep } from '../src/two-factor.js'

// A fresh P-256 key as { privateKeyPem, publicKey (base64url of the 65-byte
// uncompressed point), keyId (lowercase hex SHA-256 of those 65 bytes) }.
export function generateApprovalKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: point.toString('base64url'),
    keyId: crypto.createHash('sha256').update(point).digest('hex'),
  }
}

// Canonicalise a statement object and sign it (ES256, DER signature).
export function signForTest(privateKeyPem, statementObject) {
  const statement = canonicalize(statementObject)
  const signature = crypto.sign('sha256', Buffer.from(statement, 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64url')
  return { statement, signature }
}

export const TEST_PUBLIC_URL = 'https://journal.example'
export const TEST_JOURNAL = 'journal.example'
export const TEST_TOKEN_KEY = 'ab'.repeat(32)
export const TEST_PASSWORD = 'hunter22'

// A journal with approval keys switched on (a token box for two-factor and
// a public URL), and alice signed in from a client device.
export async function startApprovalServer(t, opts = {}) {
  const s = await startTestServer({ tokenKey: TEST_TOKEN_KEY, publicUrl: TEST_PUBLIC_URL, ...opts })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', TEST_PASSWORD)
  const { token, deviceId } = signIn(s, alice.id, 'phone')
  return { s, alice, token, deviceId }
}

// A fresh client device of the user, as a sign-in makes (with two-factor
// on, /login alone would only give a ticket): { token, deviceId }.
export function signIn(s, userId, deviceName) {
  return createClientDevice(s.db, userId, deviceName)
}

// Turn two-factor on for the signed-in user; returns its secret.
export async function enableTwoFactor(s, token) {
  const st = await s.http('/2fa/setup', { method: 'POST', token, body: { password: TEST_PASSWORD } })
  assert.equal(st.status, 200)
  const en = await s.http('/2fa/enable', { method: 'POST', token, body: { code: hotp(base32Decode(st.json.secret), totpStep()) } })
  assert.equal(en.status, 200)
  return { secret: st.json.secret, recoveryCodes: en.json.recovery_codes }
}

// A TOTP code the journal will accept now. A code's 30-second step can be
// spent only once, and a test spends several in the same step, so the
// replay guard is wound back first.
export function totpCode(s, userId, secret) {
  s.db.prepare('UPDATE two_factor SET last_step=0 WHERE user_id=?').run(userId)
  return hotp(base32Decode(secret), totpStep())
}

// Enrol a key for the calling device by password and TOTP (the bootstrap).
export async function enrolKeyByPassword(s, { token, userId, secret, name = 'phone', key = generateApprovalKey() }) {
  const r = await s.http('/approval-keys', {
    method: 'POST', token, body: { public_key: key.publicKey, name, password: TEST_PASSWORD, code: totpCode(s, userId, secret) },
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  return key
}

// startApprovalServer, plus two-factor on and a first key on the phone.
export async function startWithKey(t, opts = {}) {
  const base = await startApprovalServer(t, opts)
  const { secret } = await enableTwoFactor(base.s, base.token)
  const key = await enrolKeyByPassword(base.s, { token: base.token, userId: base.alice.id, secret })
  return { ...base, secret, key }
}

// Ask for a nonce with `token` and sign a statement with `key`: the
// `approval` field of a request. `fields` carries type and subject (and,
// for a tap, item, action and prompt_digest); any common field can be
// overridden there too.
export async function signApproval(s, { token, key, user = 'alice', journal = TEST_JOURNAL, ...fields }) {
  const n = await s.http('/approvals/nonce', { method: 'POST', token })
  assert.equal(n.status, 200, JSON.stringify(n.json))
  return signForTest(key.privateKeyPem, {
    v: 1, journal, user, key_id: key.keyId, nonce: n.json.nonce, signed_at: Date.now(), ...fields,
  })
}

// An account statement for `subject`, signed as above.
export const signAccount = (s, { token, key, subject, ...rest }) => signApproval(s, { token, key, type: 'account', subject, ...rest })

// A consent statement for `subject` (the ask's, as GET /consent/pending or
// its consent item publishes it), signed as above.
export const signConsent = (s, { token, key, subject, ...rest }) => signApproval(s, { token, key, type: 'consent', subject, ...rest })

// A signed tap: the `approval` for tapping `action` on `item` (as the journal
// returns it), or on the follow-up `comment`'s buttons when one is given.
// The digest and subject follow the journal's rule (a step-up comment's own
// subject, else the item's, else {}); any statement field can be overridden.
export function signTap(s, { token, key, item, action, comment = null, ...rest }) {
  const subject = (comment?.step_up ? comment.subject : item.subject) ?? {}
  const prompt_digest = comment ? promptDigest({ body: comment.body }) : promptDigest({ title: item.title, body: item.body })
  return signApproval(s, {
    token, key, type: 'item_tap', item: { id: item.id, num: item.num, reply_to: comment ? comment.id : null },
    action, prompt_digest, subject, ...rest,
  })
}

// Lockdown (src/approval-keys.js): two invalid approvals from one device
// within ten minutes sign it out. A test that sends several on purpose, to
// check each refusal, forgets the ones recorded so far before the next.
export function forgetApprovalFailures(s) {
  s.db.prepare('DELETE FROM approval_failures').run()
}

// Likewise for the password-and-code path's lock.
export function forgetEnrolmentFailures(s) {
  s.db.prepare('DELETE FROM approval_enrol_failures').run()
  s.db.prepare('DELETE FROM approval_enrol_locks').run()
}

// A panic lock freezes a device, and lets it unlock, only with a key
// enrolled at least a day before the lock (src/panic.js). Move every key's
// enrolment (or one key's) back by `ms`.
export function backdateApprovalKeys(s, { keyId = null, ms = 25 * 60 * 60000 } = {}) {
  if (keyId) s.db.prepare('UPDATE approval_keys SET created_at = created_at - ? WHERE key_id=?').run(ms, keyId)
  else s.db.prepare('UPDATE approval_keys SET created_at = created_at - ?').run(ms)
}
