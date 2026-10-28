// Forgot password over HTTP (docs/protocol.md "Password reset by email").
// The forgot and reset routes are unauthenticated, so they sit ahead of
// Bearer auth with their own per-IP budget. "Forgot" answers the same
// whether or not the account exists or has an address, and mails
// in the background so the reply time says nothing either.
import { json, readBody } from './http-body.js'
import { normaliseEmail, setUserEmail, getUserEmail, findResetTarget, issueResetToken, resetPassword, resetEmail, EMAIL_MAX } from './password-reset.js'
import { verifyUserPassword } from './auth.js'

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
    const r = await resetPassword(db, token, new_password)
    if (!r.ok) { json(res, 400, { error: 'invalid_token' }); return true }
    // Whoever was guessing the old password is no longer a reason to keep
    // the owner out with the new one.
    loginGuard.ok(r.name)
    // Nor may a two-factor sign-in started with the old password finish.
    signInTickets.dropUser(r.userId)
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
    return setUserEmail(db, who.userId, clean)
  })
  if (r.gate) return lockedOut(res, r.gate)
  if (r.badPassword) { json(res, 401, { error: 'bad_password' }); return true }
  if (r.conflict) { json(res, 409, { error: 'email_taken' }); return true }
  json(res, 200, { email: clean })
  return true
}
