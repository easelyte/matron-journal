// Two-factor sign-in: TOTP codes from an authenticator app (RFC 6238 —
// HMAC-SHA1, 6 digits, 30-second steps, the defaults every authenticator
// app reads from an otpauth:// QR code), plus single-use recovery codes.
//
// What it guards: every password sign-in (POST /login). A user with two-
// factor on gets a short-lived sign-in ticket instead of a token, and
// trades it for one at POST /login/2fa with a code. Tokens that already
// exist, agent tokens and Link a Device are untouched: the last is approved
// on one of the user's own signed-in devices, which is a second factor of
// its own.
//
// Storage: the TOTP secret is sealed with the journal's token box
// (token-box.js, MATRON_TOKEN_KEY) and never stored in the clear — without
// a key the journal refuses to enrol anyone. Recovery codes are 80-bit
// random strings, so only their SHA-256 is kept.
import crypto from 'node:crypto'

export const STEP_MS = 30000
const DIGITS = 6
const SECRET_BYTES = 20
const RECOVERY_CODE_COUNT = 10
// A setup that was started (QR shown) but never confirmed with a code goes
// stale after this; the user starts again and gets a fresh secret.
export const PENDING_TTL_MS = 15 * 60000

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    const i = B32.indexOf(ch)
    if (i < 0) throw new Error('bad_base32')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

// RFC 4226 HOTP: the code for one counter value.
export function hotp(key, counter) {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = crypto.createHmac('sha1', key).update(msg).digest()
  const off = mac[mac.length - 1] & 0xf
  const n = (mac.readUInt32BE(off) & 0x7fffffff) % 10 ** DIGITS
  return String(n).padStart(DIGITS, '0')
}

export const totpStep = (now = Date.now()) => Math.floor(now / STEP_MS)

// The time step a code belongs to, or null. One step either side of now is
// accepted for clock drift, and only a step after `lastStep`: a code that
// already signed someone in cannot be replayed inside its 30 seconds.
export function matchTotp(key, code, { now = Date.now(), lastStep = 0, window = 1 } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null
  const step = totpStep(now)
  const given = Buffer.from(code)
  for (let s = step - window; s <= step + window; s++) {
    if (s <= lastStep) continue
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, s)), given)) return s
  }
  return null
}

export function otpauthUri({ issuer, account, secret }) {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_MS / 1000) })
  return `otpauth://totp/${label}?${q}`
}

// Recovery codes: 16 base32 characters (80 bits) in groups of four, lower
// case so they read cleanly when written down.
export function newRecoveryCode() {
  const raw = base32Encode(crypto.randomBytes(10)).toLowerCase()
  return raw.match(/.{4}/g).join('-')
}

const normalizeRecovery = (code) => String(code).toLowerCase().replace(/[\s-]/g, '')
export const hashRecoveryCode = (code) => crypto.createHash('sha256').update(normalizeRecovery(code)).digest('hex')

// What the user typed at the code step: a 6-digit TOTP code (spaces
// allowed, as some apps show "123 456") or a recovery code.
export function classifyCode(code) {
  if (typeof code !== 'string') return null
  const digits = code.replace(/\s/g, '')
  if (/^\d{6}$/.test(digits)) return { kind: 'totp', code: digits }
  const r = normalizeRecovery(code)
  if (/^[a-z2-7]{16}$/.test(r)) return { kind: 'recovery', code: r }
  return null
}

// ---- Stored state -------------------------------------------------------

export function twoFactorState(db, userId) {
  const row = db.prepare('SELECT secret, enabled_at FROM two_factor WHERE user_id=?').get(userId)
  const enabled = !!(row && row.secret)
  const left = enabled
    ? db.prepare('SELECT COUNT(*) AS n FROM two_factor_recovery WHERE user_id=? AND used_at IS NULL').get(userId).n
    : 0
  return { enabled, enabledAt: enabled ? row.enabled_at : null, recoveryCodesLeft: left }
}

export const isTwoFactorEnabled = (db, userId) =>
  !!db.prepare('SELECT 1 FROM two_factor WHERE user_id=? AND secret IS NOT NULL').get(userId)

// Start (or restart) enrolment: a fresh secret, parked as pending until the
// user proves their app has it. An existing active secret stays in force
// meanwhile, so moving to a new phone never leaves a window without one.
export function beginSetup(db, box, userId, now = Date.now()) {
  if (!box.enabled) return { ok: false, reason: 'unavailable' }
  const secret = base32Encode(crypto.randomBytes(SECRET_BYTES))
  const sealed = box.seal(secret)
  db.prepare(`INSERT INTO two_factor(user_id, pending_secret, pending_at) VALUES(?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET pending_secret=excluded.pending_secret, pending_at=excluded.pending_at`).run(userId, sealed, now)
  return { ok: true, secret }
}

// Confirm enrolment with a code from the pending secret. The pending secret
// becomes the active one and a new set of recovery codes replaces any old
// set; the codes come back here once and are never readable again.
export function finishSetup(db, box, userId, code, now = Date.now()) {
  const row = db.prepare('SELECT pending_secret, pending_at FROM two_factor WHERE user_id=?').get(userId)
  if (!row || !row.pending_secret || now - row.pending_at > PENDING_TTL_MS) return { ok: false, reason: 'no_pending' }
  let secret
  try { secret = box.open(row.pending_secret) } catch { return { ok: false, reason: 'unavailable' } }
  const c = classifyCode(code)
  const step = c && c.kind === 'totp' ? matchTotp(base32Decode(secret), c.code, { now }) : null
  if (step == null) return { ok: false, reason: 'bad_code' }
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode)
  db.transaction(() => {
    db.prepare(`UPDATE two_factor SET secret=pending_secret, enabled_at=?, last_step=?, pending_secret=NULL, pending_at=NULL
      WHERE user_id=?`).run(now, step, userId)
    replaceRecoveryCodes(db, userId, codes)
  })()
  return { ok: true, recoveryCodes: codes }
}

function replaceRecoveryCodes(db, userId, codes) {
  db.prepare('DELETE FROM two_factor_recovery WHERE user_id=?').run(userId)
  const ins = db.prepare('INSERT INTO two_factor_recovery(user_id, code_hash) VALUES(?,?)')
  for (const code of codes) ins.run(userId, hashRecoveryCode(code))
}

export function regenerateRecoveryCodes(db, userId) {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode)
  db.transaction(() => replaceRecoveryCodes(db, userId, codes))()
  return codes
}

// Check a second factor for a user who has two-factor on. A TOTP match
// advances last_step with a compare-and-set, so two requests racing with
// the same code cannot both win; a recovery code is spent the same way.
export function verifySecondFactor(db, box, userId, code, now = Date.now()) {
  const row = db.prepare('SELECT secret, last_step FROM two_factor WHERE user_id=?').get(userId)
  if (!row || !row.secret) return { ok: false, reason: 'not_enabled' }
  const c = classifyCode(code)
  if (!c) return { ok: false, reason: 'bad_code' }
  if (c.kind === 'recovery') {
    const r = db.prepare('UPDATE two_factor_recovery SET used_at=? WHERE user_id=? AND code_hash=? AND used_at IS NULL')
      .run(now, userId, hashRecoveryCode(c.code))
    return r.changes > 0 ? { ok: true, method: 'recovery' } : { ok: false, reason: 'bad_code' }
  }
  let secret
  try { secret = box.open(row.secret) } catch { return { ok: false, reason: 'unavailable' } }
  const step = matchTotp(base32Decode(secret), c.code, { now, lastStep: row.last_step })
  if (step == null) return { ok: false, reason: 'bad_code' }
  const r = db.prepare('UPDATE two_factor SET last_step=? WHERE user_id=? AND last_step < ?').run(step, userId, step)
  return r.changes > 0 ? { ok: true, method: 'totp' } : { ok: false, reason: 'bad_code' }
}

// Turn two-factor off: the user's own choice (with password and code), an
// admin's reset, or the operator's `matron-admin user 2fa-reset`.
export function disableTwoFactor(db, userId) {
  return db.transaction(() => {
    db.prepare('DELETE FROM two_factor_recovery WHERE user_id=?').run(userId)
    return db.prepare('DELETE FROM two_factor WHERE user_id=?').run(userId).changes > 0
  })()
}

// The journal-wide "everyone must use two-factor" switch. Off by default;
// when on, a user without two-factor is taken through enrolment at their
// next password sign-in before they get a token.
export function isTwoFactorRequired(db) {
  const row = db.prepare("SELECT value FROM journal_settings WHERE key='two_factor_required'").get()
  return !!row && row.value === '1'
}

export function setTwoFactorRequired(db, on) {
  db.prepare(`INSERT INTO journal_settings(key, value) VALUES('two_factor_required', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(on ? '1' : '0')
}

// ---- Sign-in tickets ----------------------------------------------------

// In-memory, like the pair and link stores: a restart forgets them and the
// user types their password again. A ticket is what a correct password buys
// a two-factor user — the right to try a code for this user for five
// minutes, five times. purpose 'verify' trades a code for a token;
// 'enrol' (two-factor required, user not enrolled) allows setting up first.
export function makeTwoFactorTickets({ ttlMs = 5 * 60000, maxAttempts = 5, maxPending = 1000 } = {}) {
  const tickets = new Map() // ticket -> { userId, username, deviceName, purpose, attempts, expiresAt }
  const sweep = (now) => { for (const [k, t] of tickets) if (now >= t.expiresAt) tickets.delete(k) }
  return {
    issue({ userId, username, deviceName, purpose }) {
      const now = Date.now()
      sweep(now)
      if (tickets.size >= maxPending) return null
      const ticket = crypto.randomBytes(32).toString('hex')
      tickets.set(ticket, { userId, username, deviceName, purpose, attempts: 0, expiresAt: now + ttlMs })
      return { ticket, expiresIn: Math.round(ttlMs / 1000) }
    },
    get(ticket) {
      if (typeof ticket !== 'string') return null
      const t = tickets.get(ticket)
      if (!t) return null
      if (Date.now() >= t.expiresAt) { tickets.delete(ticket); return null }
      return t
    },
    // A wrong code: true while the ticket still has attempts left.
    fail(ticket) {
      const t = tickets.get(ticket)
      if (!t) return false
      t.attempts += 1
      if (t.attempts >= maxAttempts) { tickets.delete(ticket); return false }
      return true
    },
    consume(ticket) { tickets.delete(ticket) },
    // A password change or reset: a ticket earned with the old password
    // must not still finish a sign-in.
    dropUser(userId) { for (const [k, t] of tickets) if (t.userId === userId) tickets.delete(k) },
  }
}
