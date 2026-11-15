// Approval keys: storage, nonces, and the one guard every dangerous action
// calls (requireApproval). The statement format and the crypto live in
// src/approvals.js; the routes in src/approval-keys-http.js.
//
// An account with no active key behaves exactly as before: requireApproval
// lets everything through with `approval: null`. Once a key is enrolled,
// every guarded action needs a statement signed by one of the account's
// active keys, attached to the calling device, over a journal-issued nonce
// that was handed to that same device and is spent by the check.
import crypto from 'node:crypto'
import { parseStatement, verifySignature } from './approvals.js'
import { signOutOwnedDevice } from './auth.js'
import { securityLogFor, deviceTarget } from './security-log.js'

export const ALG = 'ES256'
export const NONCE_TTL_MS = 5 * 60000
export const KEY_REQUEST_TTL_MS = 10 * 60000

// Lockdown after failures (a genuine app never sends a bad signature):
// two invalid approvals from one client device within ten minutes sign it
// out; three wrong passwords or codes on the password-and-code path within
// an hour lock that path for the account, 1 h, then 6 h, then 24 h, back
// to 1 h after seven days without a lock. Failure rows are kept seven days.
export const DEVICE_FAILURE_WINDOW_MS = 10 * 60000
export const DEVICE_FAILURE_LIMIT = 2
// The reasons that count towards a device's sign-out: what only a forged or
// tampered request sends. The others are stored but never count: `nonce` (a
// slow network, a retry), `mismatch` (an agent edited the question while the
// user signed) and `revoked_key` (revoked from another device meanwhile)
// can each come from an honest app, and must not let an agent or a flaky
// connection sign a phone out.
export const COUNTED_REASONS = Object.freeze(['signature', 'bad_statement', 'unknown_key', 'wrong_device'])
const COUNTED_SQL = COUNTED_REASONS.map((r) => `'${r}'`).join(',')
export const ENROL_FAILURE_WINDOW_MS = 60 * 60000
export const ENROL_FAILURE_LIMIT = 3
export const ENROL_LOCK_MS = [1, 6, 24].map((h) => h * 60 * 60000)
export const ENROL_LEVEL_RESET_MS = 7 * 24 * 60 * 60000
const FAILURE_KEEP_MS = 7 * 24 * 60 * 60000

// A subject's values are strings of at most 200 characters
// (src/approvals.js validSubject). boundedSubject builds one from `fields`
// in order, any value over the limit going in as the lowercase hex SHA-256
// of its UTF-8 bytes under `<name>_sha256`: the rule for every subject the
// journal builds (the account actions', src/consent-subject.js's).
export const SUBJECT_VALUE_MAX = 200
export const sha256Hex = (text) => crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
export function boundedSubject(fields) {
  const out = {}
  for (const [k, v] of Object.entries(fields)) {
    const s = String(v ?? '')
    if (s.length > SUBJECT_VALUE_MAX) out[`${k}_sha256`] = sha256Hex(s)
    else out[k] = s
  }
  return out
}

export function hasActiveKey(db, userId) {
  return !!db.prepare('SELECT 1 FROM approval_keys WHERE user_id=? AND revoked_at IS NULL').get(userId)
}

// The row of one of the user's keys that is not revoked, or null.
export function activeKeyFor(db, userId, keyId) {
  return db.prepare('SELECT * FROM approval_keys WHERE user_id=? AND key_id=? AND revoked_at IS NULL').get(userId, keyId) ?? null
}

// A device's live keys (for the notices when the device is revoked).
export function activeKeysOfDevice(db, userId, deviceId) {
  return db.prepare('SELECT * FROM approval_keys WHERE user_id=? AND device_id=? AND revoked_at IS NULL ORDER BY id').all(userId, deviceId)
}

// A nonce for the calling device: 32 random bytes, base64url, good for
// five minutes and one statement. Spent and expired nonces are swept here,
// and with them the lockdown counters nothing reads any more.
export function issueNonce(db, who, now = Date.now()) {
  const nonce = crypto.randomBytes(32).toString('base64url')
  db.transaction(() => {
    db.prepare('DELETE FROM approval_nonces WHERE created_at <= ?').run(now - NONCE_TTL_MS)
    sweepLockdownCounters(db, now)
    db.prepare('INSERT INTO approval_nonces(nonce, user_id, device_id, created_at) VALUES(?,?,?,?)').run(nonce, who.userId, who.deviceId, now)
  })()
  return { nonce, expires_at: now + NONCE_TTL_MS }
}

// Device failures after their review week; enrolment failures out of the
// hour; locks that ended more than a week ago (their level has reset).
function sweepLockdownCounters(db, now) {
  db.prepare('DELETE FROM approval_failures WHERE at <= ?').run(now - FAILURE_KEEP_MS)
  db.prepare('DELETE FROM approval_enrol_failures WHERE at <= ?').run(now - ENROL_FAILURE_WINDOW_MS)
  db.prepare('DELETE FROM approval_enrol_locks WHERE until <= ?').run(now - ENROL_LEVEL_RESET_MS)
}

// The approval key a user's event is stamped with when the journal delivers
// it to an agent (approval_key_id): the live key attached to the client
// device that sent it, the newest if somehow more than one, or null.
export function approvalKeyIdOfDevice(db, userId, deviceId) {
  if (deviceId == null) return null
  return db.prepare(`SELECT k.key_id FROM approval_keys k JOIN devices d ON d.id = k.device_id AND d.user_id = k.user_id AND d.kind = 'client'
    WHERE k.user_id=? AND k.device_id=? AND k.revoked_at IS NULL ORDER BY k.created_at DESC, k.id DESC LIMIT 1`).get(userId, deviceId)?.key_id ?? null
}

// ---- Lockdown: invalid approvals per device ---------------------------------

// What the journal does once a device is signed out for invalid approvals
// (the notices and pushes, src/approval-keys-http.js), per database: the
// sign-out itself happens here whether or not one is installed.
const signedOutListeners = new WeakMap()
export function onSignedOutForFailures(db, fn) { signedOutListeners.set(db, fn) }

// Record one invalid approval from `who` and, when it is the second from
// that client device within ten minutes with a reason that counts
// (COUNTED_REASONS), sign the device out: its row goes, its approval keys
// stay enrolled, detached (auth.js signOutOwnedDevice), so the lockdown is
// never a way back to an account with no key. Only client devices are
// recorded (an agent never signs). → {device: {id, name}, keys (detached),
// reasons (the counted ones, oldest first)} when it signed the device out,
// else null.
export function recordApprovalFailure(db, who, reason, now = Date.now()) {
  const out = db.transaction(() => {
    const device = db.prepare("SELECT id, name FROM devices WHERE id=? AND user_id=? AND kind='client'").get(who.deviceId, who.userId)
    if (!device) return null
    db.prepare('INSERT INTO approval_failures(user_id, device_id, device_name, reason, at) VALUES(?,?,?,?,?)')
      .run(who.userId, device.id, device.name, String(reason), now)
    // Rows of an earlier sign-in that had this id lost it with their device
    // (db.js devices_approval_failures_detach).
    const counted = db.prepare(`SELECT reason FROM approval_failures WHERE device_id=? AND user_id=? AND at > ? AND at <= ?
      AND reason IN (${COUNTED_SQL}) ORDER BY at, id`).all(device.id, who.userId, now - DEVICE_FAILURE_WINDOW_MS, now)
    if (counted.length < DEVICE_FAILURE_LIMIT) return null
    const keys = activeKeysOfDevice(db, who.userId, device.id)
    signOutOwnedDevice(db, who.userId, device.id)
    return { device: { id: device.id, name: device.name }, keys, reasons: counted.map((r) => r.reason) }
  })()
  if (out) {
    securityLogFor(db).record(who.userId, 'device_signed_out_bad_signatures', {
      deviceId: out.device.id, deviceName: out.device.name, target: deviceTarget(out.device.id), decidedBy: 'journal',
    }, { evenIfRolledBack: true })
    signedOutListeners.get(db)?.(who.userId, out)
  }
  return out
}

// An invalid approval, from wherever checkApproval was called. Most callers
// run the check inside the transaction of the write it guards, and roll that
// transaction back on the refusal: a counter written there would be rolled
// back with it. So inside a transaction the record waits for a microtask,
// which runs once the synchronous code that holds the transaction (better-
// sqlite3's are synchronous) has committed or rolled back, before any I/O:
// the refusal is answered first, the device is signed out before the
// caller's next request can be read. Outside one it is recorded at once.
// The security log's approval_invalid line goes out first, from the same
// place: the device is still there to be named (the failure may sign it out).
function noteInvalid(ctx, who, reason) {
  const { db } = ctx
  const now = ctx.now ?? Date.now()
  const run = () => {
    securityLogFor(db).record(who.userId, 'approval_invalid', { deviceId: who.deviceId ?? null, target: reason }, { evenIfRolledBack: true })
    try {
      recordApprovalFailure(db, who, reason, now)
    } catch (err) {
      console.error('approval keys: recording an invalid approval failed', err)
    }
  }
  if (db.inTransaction) queueMicrotask(run)
  else run()
}

// ---- Lockdown: the password-and-code path ------------------------------------

// When the account's password-and-code path unlocks (ms), or null while it
// is open.
export function enrolmentLockedUntil(db, userId, now = Date.now()) {
  const lock = db.prepare('SELECT until FROM approval_enrol_locks WHERE user_id=?').get(userId)
  return lock && lock.until > now ? lock.until : null
}

// Record a wrong password or code on that path (`outcome` 'bad_password' or
// 'bad_code'). The third within an hour locks it: → {level, until} for the
// new lock, else null. The level is one more than the last lock's when that
// one ended under seven days ago, else 1; it picks the length (1 h, 6 h,
// then 24 h for every later one). Failures made before the last lock ended
// never count towards the next.
export function recordEnrolmentFailure(db, who, outcome, now = Date.now()) {
  return db.transaction(() => {
    db.prepare('INSERT INTO approval_enrol_failures(user_id, device_id, outcome, at) VALUES(?,?,?,?)').run(who.userId, who.deviceId ?? null, outcome, now)
    const last = db.prepare('SELECT level, until FROM approval_enrol_locks WHERE user_id=?').get(who.userId)
    const n = db.prepare('SELECT COUNT(*) AS n FROM approval_enrol_failures WHERE user_id=? AND at > ? AND at <= ? AND at >= ?')
      .get(who.userId, now - ENROL_FAILURE_WINDOW_MS, now, last?.until ?? 0).n
    if (n < ENROL_FAILURE_LIMIT) return null
    const level = last && now - last.until < ENROL_LEVEL_RESET_MS ? last.level + 1 : 1
    const until = now + ENROL_LOCK_MS[Math.min(level, ENROL_LOCK_MS.length) - 1]
    db.prepare(`INSERT INTO approval_enrol_locks(user_id, level, locked_at, until) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET level=excluded.level, locked_at=excluded.locked_at, until=excluded.until`).run(who.userId, level, now, until)
    db.prepare('DELETE FROM approval_enrol_failures WHERE user_id=?').run(who.userId)
    return { level, until }
  })()
}

// Spend a nonce: true once, for the user and device it was issued to, while
// it is under five minutes old.
export function consumeNonce(db, who, nonce, now = Date.now()) {
  if (typeof nonce !== 'string') return false
  return db.prepare(`UPDATE approval_nonces SET used_at=?
    WHERE nonce=? AND user_id=? AND device_id=? AND used_at IS NULL AND created_at > ?`)
    .run(now, nonce, who.userId, who.deviceId, now - NONCE_TTL_MS).changes > 0
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// Same keys, same string values. Subjects are flat objects of strings
// (parseStatement has checked the statement's).
function sameSubject(a, b) {
  if (!isObj(a) || !isObj(b)) return false
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k])
}

function matchesExpect(st, expect) {
  if (st.type !== expect.type || !sameSubject(st.subject, expect.subject)) return false
  if (st.type !== 'item_tap') return true
  const it = expect.item
  return isObj(it) && st.item.id === it.id && st.item.num === it.num && st.item.reply_to === (it.reply_to ?? null)
    && st.action === expect.action && st.prompt_digest === expect.prompt_digest
}

// signed_at is the device's clock, which a box checks against its own
// window (tools/approval-verify.mjs). The journal's bound is a check on that
// clock, not a freshness window (the nonce's five minutes are): signed_at
// must be no more than a minute before its nonce was issued (it was signed
// after) and no more than a minute ahead of the journal's clock, or a box
// would see a wrong age. Refused as a mismatch (a skewed clock is an honest
// app's, so it does not count). A nonce that is not this device's is left
// to the nonce check.
export const SIGNED_AT_SKEW_MS = 60000
function signedInTime(db, who, st, now) {
  if (st.signed_at > now + SIGNED_AT_SKEW_MS) return false
  const issued = db.prepare('SELECT created_at FROM approval_nonces WHERE nonce=? AND user_id=? AND device_id=?').get(st.nonce, who.userId, who.deviceId)
  return !issued || st.signed_at >= issued.created_at - SIGNED_AT_SKEW_MS
}

const required = { ok: false, status: 403, body: { error: 'approval_required' } }
const invalid = (reason) => ({ ok: false, status: 400, body: { error: 'approval_invalid', reason } })

// The checks alone, for a route where a signature is always needed (the key
// routes); requireApproval below is the guard for everything else. `ctx` is
// {db, journalHost, now?}; `approval` the request's {statement, signature}.
// `anyDevice` skips the wrong_device check: only for attaching a key to the
// calling device, where the key's own signature is the proof.
//
// Order: statement parses; journal and user; key known, live, on this
// device; expected fields; signed_at no more than a minute before the
// nonce's issue nor a minute ahead of now; signature; the nonce last, so a failed attempt does not
// spend it. On success `approval` is {statement, signature} as
// received, byte for byte, and `keyId` the key that signed.
//
// Every approval_invalid answer to an account with an active key is also
// recorded against the calling device (noteInvalid): the second of the
// reasons that count within ten minutes signs it out. An approval_required
// (nothing sent) is not recorded, nor is anything for an account with no
// active key (a key route's check there is today's, and nothing else).
export function checkApproval(ctx, who, approval, expect, opts) {
  const r = check(ctx, who, approval, expect, opts)
  if (!r.ok && r.body.error === 'approval_invalid' && hasActiveKey(ctx.db, who.userId)) noteInvalid(ctx, who, r.body.reason)
  return r
}

function check(ctx, who, approval, expect, { anyDevice = false } = {}) {
  const { db, journalHost, now = Date.now() } = ctx
  if (approval === undefined || approval === null) return required
  if (!isObj(approval) || Object.keys(approval).length !== 2
    || typeof approval.statement !== 'string' || typeof approval.signature !== 'string') return invalid('bad_statement')
  const st = parseStatement(approval.statement)
  if (!st) return invalid('bad_statement')
  // Without a public URL there is no journal a statement could name: fail
  // closed rather than fall back to unsigned for an account with keys.
  const user = db.prepare('SELECT name FROM users WHERE id=?').get(who.userId)
  if (!journalHost || st.journal !== journalHost || !user || st.user !== user.name) return invalid('mismatch')
  const key = db.prepare('SELECT * FROM approval_keys WHERE user_id=? AND key_id=?').get(who.userId, st.key_id)
  if (!key) return invalid('unknown_key')
  if (key.revoked_at != null) return invalid('revoked_key')
  if (!anyDevice && key.device_id !== who.deviceId) return invalid('wrong_device')
  if (!matchesExpect(st, expect)) return invalid('mismatch')
  if (!signedInTime(db, who, st, now)) return invalid('mismatch')
  if (!verifySignature(key.public_key, approval.statement, approval.signature)) return invalid('signature')
  if (!consumeNonce(db, who, st.nonce, now)) return invalid('nonce')
  return { ok: true, approval: { statement: approval.statement, signature: approval.signature }, keyId: key.key_id }
}

// The guard. `body.approval` is the request's field; `expect` is
// {type, subject, item?, action?, prompt_digest?} (item is {id, num,
// reply_to}), and the statement must match it exactly, subject key for key.
// No active key: {ok:true, approval:null} (today's behaviour). Otherwise
// {ok:true, approval, keyId} or {ok:false, status, body} to send as is.
// Call it once per request and act on its answer: whether the account has a
// key is decided here, once.
export function requireApproval(ctx, who, body, expect) {
  if (!hasActiveKey(ctx.db, who.userId)) return { ok: true, approval: null }
  return checkApproval(ctx, who, body?.approval, expect)
}

// A refusal thrown out of a guarded write's transaction, so nothing it
// wrote (a spent nonce, a spent second-factor code) stays written. Used by
// the account actions below and by the consent answers
// (src/consent-answer.js guardedApprove). `r` is {status, body} (a guard's
// failed answer will do).
export class ApprovalRefused extends Error {
  constructor({ status, body }) { super('approval_refused'); this.refusal = { status, body } }
}
export const refuse = (status, body) => { throw new ApprovalRefused({ status, body }) }

// An account action: the guard (type 'account' over `subject`) and the
// write it protects, in one synchronous transaction. `check` runs first:
// today's checks that cannot wait for the transaction (a second-factor
// code, which spends itself). `write` runs once the guard has passed; its
// return value is handed back. Either may refuse with refuse(); then
// everything the transaction wrote is undone, the nonce included, so a
// refused or failed request changes nothing and can be retried with the
// same statement. Async checks (a password hash) belong before the call.
// → {ok:true, value} or {ok:false, status, body} to send as is.
export function guardedAccountAction(ctx, who, body, subject, { check = () => {}, write }) {
  try {
    let value
    ctx.db.transaction(() => {
      check()
      const g = requireApproval(ctx, who, body, { type: 'account', subject })
      if (!g.ok) refuse(g.status, g.body)
      value = write()
    })()
    return { ok: true, value }
  } catch (err) {
    if (err instanceof ApprovalRefused) return { ok: false, ...err.refusal }
    throw err
  }
}
