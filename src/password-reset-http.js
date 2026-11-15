// Forgot password over HTTP (docs/protocol.md "Password reset by email").
// The forgot and reset routes are unauthenticated, so they sit ahead of
// Bearer auth with their own per-IP budget. "Forgot" answers the same
// whether or not the account exists or has an address, and mails
// in the background so the reply time says nothing either.
import { json, readBody, recheckCaller } from './http-body.js'
import { normaliseEmail, setUserEmail, getUserEmail, findResetTarget, issueResetToken, resetPassword, resetTokenOwner, resetEmail, EMAIL_MAX } from './password-reset.js'
import { panicLock, lockedBody } from './panic.js'
import { verifyUserPassword } from './auth.js'
import { securityLogOf, deviceTarget } from './security-log.js'

const PASSWORD_MIN = 8
const clientIp = (req) => req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown'

function lockedOut(res, gate) {
  const retryAfter = Math.ceil(gate.retryAfterMs / 1000)
  res.setHeader('Retry-After', retryAfter)
  json(res, 429, { error: 'locked_out', retry_after: retryAfter })
  return true
}

export async function handlePasswordResetRoute(ctx, req, res, url, { rejectEarly }) {
  const { db, mailer, resetLimiter, loginGuard, signInTickets, log = console } = ctx
  const path = url.pathname
  if (path === '/password/forgot' && req.method === 'GET') {
    json(res, 200, { enabled: !!mailer })
    return true
  }
  if (path === '/password/forgot' && req.method === 'POST') {
    if (!resetLimiter.allow(clientIp(req))) { rejectEarly(req, res, 429, { error: 'rate_limited' }); return true }
    const { identifier } = await readBody(req)
    if (typeof identifier !== 'string' || !identifier.trim() || identifier.length > EMAIL_MAX) { json(res, 400, { error: 'bad_request' }); return true }
    if (!mailer) { json(res, 503, { error: 'unavailable' }); return true }
    const target = findResetTarget(db, identifier)
    // Asked for an account that exists, whether or not it has an address
    // (the security log; anyone may ask, so no one is named as deciding):
    // looked up and recorded after the answer, so an existing account and
    // an unknown one take the same time to answer.
    setImmediate(() => {
      try {
        const account = target ?? (identifier.includes('@') ? null : db.prepare('SELECT id FROM users WHERE name=?').get(identifier.trim()))
        if (account) securityLogOf(ctx).record(account.id, 'password_reset_requested', {})
      } catch (err) {
        log.error(`security log: password_reset_requested not recorded (${err?.message || err})`)
      }
    })
    const token = target && issueResetToken(db, target.id)
    if (token) {
      const link = `${mailer.publicUrl}/app/reset-password#token=${token}`
      mailer.send({ to: target.email, ...resetEmail({ name: target.name, link }) })
        .catch((err) => log.error(`mail: reset link for user ${target.id} not sent: ${err.message}`))
    }
    json(res, 200, { ok: true })
    return true
  }
  if (path === '/password/reset' && req.method === 'POST') {
    if (!resetLimiter.allow(clientIp(req))) { rejectEarly(req, res, 429, { error: 'rate_limited' }); return true }
    const { token, new_password } = await readBody(req)
    if (typeof token !== 'string' || !token) { json(res, 400, { error: 'bad_request' }); return true }
    if (typeof new_password !== 'string' || new_password.length < PASSWORD_MIN) { json(res, 400, { error: 'weak_password' }); return true }
    // A panic-locked account (src/panic.js): 423, and the token is left
    // unused for after the clear. Only a valid token reaches this, so it
    // tells nothing to anyone without one. Checked again after the hash.
    const lock = panicLock(db, resetTokenOwner(db, token))
    if (lock) { json(res, 423, lockedBody(lock)); return true }
    const r = await resetPassword(db, token, new_password, Date.now(), { refuse: (userId) => panicLock(db, userId) })
    if (r.refused) { json(res, 423, lockedBody(r.refused)); return true }
    if (!r.ok) { json(res, 400, { error: 'invalid_token' }); return true }
    // Whoever was guessing the old password is no longer a reason to keep
    // the owner out with the new one.
    loginGuard.ok(r.name)
    // Nor may a two-factor sign-in started with the old password finish.
    signInTickets.dropUser(r.userId)
    securityLogOf(ctx).record(r.userId, 'password_changed', { decidedBy: 'user' })
    // Every client it signed out, by no device.
    for (const id of r.signedOutIds ?? []) securityLogOf(ctx).record(r.userId, 'device_revoked', { deviceId: null, target: deviceTarget(id), decidedBy: 'user' })
    json(res, 200, { ok: true, signed_out: r.signedOut })
    return true
  }
  return false
}

// The signed-in user's own address: client devices only, and a change
// needs the current password (an address is where a reset link goes).
export async function handleAccountEmailRoute(ctx, req, res, url, who) {
  const { db, mailer, loginGuard, passwordChecks } = ctx
  if (url.pathname !== '/account/email') return false
  if (who.kind !== 'client') { json(res, 403, { error: 'forbidden' }); return true }
  if (req.method === 'GET') {
    json(res, 200, { email: getUserEmail(db, who.userId), reset_by_email: !!mailer })
    return true
  }
  if (req.method !== 'PUT') return false
  const { password, email } = await readBody(req)
  if (typeof password !== 'string' || !password) { json(res, 400, { error: 'bad_request' }); return true }
  const clean = email === null ? null : normaliseEmail(email)
  if (email !== null && !clean) { json(res, 400, { error: 'bad_email' }); return true }
  // One check per user at a time, shared with POST /password, so parallel
  // guesses can't all pass the lockout gate before the first is counted.
  const r = await passwordChecks.run(who.userId, async () => {
    const user = db.prepare('SELECT name FROM users WHERE id=?').get(who.userId)
    const gate = loginGuard.check(user.name)
    if (!gate.allowed) return { gate }
    if (!(await verifyUserPassword(db, who.userId, password))) { loginGuard.fail(user.name); return { badPassword: true } }
    // Signed out, or the account locked, while the password was checked.
    recheckCaller(req)
    return setUserEmail(db, who.userId, clean)
  })
  if (r.gate) return lockedOut(res, r.gate)
  if (r.badPassword) { json(res, 401, { error: 'bad_password' }); return true }
  if (r.conflict) { json(res, 409, { error: 'email_taken' }); return true }
  json(res, 200, { email: clean })
  return true
}
