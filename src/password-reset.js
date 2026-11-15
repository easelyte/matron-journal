// Forgot password (docs/protocol.md "Password reset by email"): an account's
// optional email address, and single-use reset links sent to it. Only a
// SHA-256 of each link's token is stored; the token itself exists only in
// the email. Using a link sets the new password and signs every client
// device out.
import crypto from 'node:crypto'
import argon2 from 'argon2'

export const RESET_TTL_MS = 30 * 60 * 1000
// Links mailed to one account per hour, whoever asks: a cap on how much
// mail a stranger can make the journal send to someone.
export const RESETS_PER_USER_HOUR = 3
export const EMAIL_MAX = 254
// Deliberately loose: one @, something either side, a dot in the domain,
// no spaces or angle brackets. The provider is the real check.
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
// What a link is good for: the account's password and address as they were
// when it was mailed. A later password change (by anyone, any route) or a
// new address makes every earlier link stop working.
const accountState = (db, userId) => {
  const u = db.prepare('SELECT password_hash, email FROM users WHERE id=?').get(userId)
  return u ? sha256(`${u.password_hash}\0${u.email ?? ''}`) : null
}

// The stored form of an address (trimmed), or null when it is not one.
export function normaliseEmail(raw) {
  if (typeof raw !== 'string') return null
  const e = raw.trim()
  if (!e || e.length > EMAIL_MAX || !EMAIL_RE.test(e)) return null
  return e
}

// { ok:true } | { conflict:true } (another account has it). null clears.
// Uniqueness is case-insensitive (users_email_lower index in db.js).
export function setUserEmail(db, userId, email) {
  try {
    db.prepare('UPDATE users SET email=? WHERE id=?').run(email, userId)
    return { ok: true }
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return { conflict: true }
    throw err
  }
}

export function getUserEmail(db, userId) {
  return db.prepare('SELECT email FROM users WHERE id=?').get(userId)?.email ?? null
}

// A username, or an email address (case-insensitive): the account a
// "Forgot password?" request names, if it has an address to mail.
export function findResetTarget(db, identifier) {
  const id = identifier.trim()
  const row = id.includes('@')
    ? db.prepare('SELECT id, name, email FROM users WHERE lower(email)=lower(?)').get(id)
    : db.prepare('SELECT id, name, email FROM users WHERE name=?').get(id)
  return row && row.email ? row : null
}

// A fresh token for the user, or null when the hourly cap is spent. Any
// earlier unused link for the user stops working: only the newest counts.
export function issueResetToken(db, userId, now = Date.now()) {
  return db.transaction(() => {
    db.prepare('DELETE FROM password_resets WHERE expires_at<=?').run(now)
    const recent = db.prepare('SELECT COUNT(*) AS n FROM password_reset_sends WHERE user_id=? AND sent_at>?').get(userId, now - 3600000).n
    if (recent >= RESETS_PER_USER_HOUR) return null
    db.prepare('DELETE FROM password_reset_sends WHERE sent_at<=?').run(now - 3600000)
    db.prepare('INSERT INTO password_reset_sends(user_id, sent_at) VALUES(?,?)').run(userId, now)
    db.prepare('DELETE FROM password_resets WHERE user_id=?').run(userId)
    const token = crypto.randomBytes(32).toString('base64url')
    db.prepare('INSERT INTO password_resets(token_hash, user_id, created_at, expires_at, account_state) VALUES(?,?,?,?,?)')
      .run(sha256(token), userId, now, now + RESET_TTL_MS, accountState(db, userId))
    return token
  })()
}

// The account a token would reset, without spending it: a token that is
// known, unexpired and of the account as it was; else null.
export function resetTokenOwner(db, token, now = Date.now()) {
  if (typeof token !== 'string' || !token || token.length > 128) return null
  const r = db.prepare('SELECT user_id, expires_at, account_state FROM password_resets WHERE token_hash=?').get(sha256(token))
  return r && r.expires_at > now && r.account_state === accountState(db, r.user_id) ? r.user_id : null
}

// Spend a token: { ok:true, userId, name, signedOut } or { ok:false } for a
// token that is unknown, used or expired (one answer for all three).
// `refuse(userId)`: checked in the write's transaction (after the slow
// hash); truthy refuses the write with {ok:false, refused} and leaves the
// token as it was, usable later.
//
// The token is spent in the write's transaction, together with the new
// password, after it is checked again there: of two uses racing through
// the hash, the first to write wins and the second finds it gone; a token
// replaced meanwhile (a newer link) is gone too.
export async function resetPassword(db, token, newPassword, now = Date.now(), { refuse = null } = {}) {
  if (typeof token !== 'string' || !token || token.length > 128) return { ok: false }
  const valid = () => {
    const r = db.prepare('SELECT user_id, expires_at, account_state FROM password_resets WHERE token_hash=?').get(sha256(token))
    return r && r.expires_at > now && r.account_state === accountState(db, r.user_id) ? r : null
  }
  const row = valid()
  if (!row) return { ok: false }
  const hash = await argon2.hash(newPassword, { type: argon2.argon2id })
  return db.transaction(() => {
    const again = valid()
    if (!again || again.user_id !== row.user_id) return { ok: false }
    const user = db.prepare('SELECT name FROM users WHERE id=?').get(row.user_id)
    if (!user) return { ok: false }
    const refused = refuse?.(row.user_id)
    if (refused) return { ok: false, refused }
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, row.user_id)
    db.prepare('DELETE FROM password_resets WHERE user_id=?').run(row.user_id)
    // The ids too, for the security log's device_revoked per device.
    const signedOutIds = db.prepare("DELETE FROM devices WHERE user_id=? AND kind='client' RETURNING id").all(row.user_id).map((r) => r.id).sort((a, b) => a - b)
    return { ok: true, userId: row.user_id, name: user.name, signedOut: signedOutIds.length, signedOutIds }
  })()
}

export function resetEmail({ name, link }) {
  const minutes = Math.round(RESET_TTL_MS / 60000)
  const text = [
    `Someone asked to reset the password for the Matron account "${name}".`,
    '',
    `To choose a new password, open this link within ${minutes} minutes. It works once:`,
    link,
    '',
    'Resetting your password signs you out of Matron on every device. Your agent boxes stay connected.',
    '',
    "If you didn't ask for this, you can ignore this email. Your password hasn't changed.",
  ].join('\n')
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const html = `<p>Someone asked to reset the password for the Matron account <b>${esc(name)}</b>.</p>
<p>To choose a new password, open this link within ${minutes} minutes. It works once:</p>
<p><a href="${esc(link)}">Reset your password</a></p>
<p>Resetting your password signs you out of Matron on every device. Your agent boxes stay connected.</p>
<p>If you didn't ask for this, you can ignore this email. Your password hasn't changed.</p>`
  return { subject: 'Reset your Matron password', text, html }
}
