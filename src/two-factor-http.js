// Two-factor sign-in routes (src/two-factor.js; docs/protocol.md
// "Two-factor sign-in").
//
// Unauthenticated, after POST /login answered `two_factor_required` or
// `two_factor_enrolment_required` with a sign-in ticket:
//   POST /login/2fa         {ticket, code}  → a device token
//   POST /login/2fa/setup   {ticket}        → secret + otpauth URI (enrol tickets)
//   POST /login/2fa/enable  {ticket, code}  → a device token + recovery codes
//
// Bearer, client devices only (an agent never holds a user's password):
//   GET  /2fa                                → state
//   POST /2fa/setup          {password, code?}
//   POST /2fa/enable         {code, sign_out_others?}
//   POST /2fa/disable        {password, code}
//   POST /2fa/recovery-codes {password, code}
//   PUT  /2fa/policy         {required}     (admins only)
import { json, readBody } from './http-body.js'
import { verifyUserPassword, createClientDevice } from './auth.js'
import { isAdmin } from './users-http.js'
import {
  twoFactorState, isTwoFactorEnabled, beginSetup, finishSetup, verifySecondFactor, disableTwoFactor,
  regenerateRecoveryCodes, isTwoFactorRequired, setTwoFactorRequired, otpauthUri,
} from './two-factor.js'

const ISSUER = 'Matron'

const clientIp = (req) => req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown'

// The label an authenticator app shows: the user's name and the journal's
// host, so two journals (or two accounts) stay apart in the app.
function accountLabel(req, username) {
  const raw = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
  const host = raw.replace(/:\d+$/, '')
  return host ? `${username}@${host}` : username
}

const setupBody = (req, username, secret) => ({
  secret,
  otpauth_uri: otpauthUri({ issuer: ISSUER, account: accountLabel(req, username), secret }),
  issuer: ISSUER,
  account: accountLabel(req, username),
})

const deviceBody = (d, userId) => ({ token: d.token, device_id: d.deviceId, user_id: userId })

const unavailable = (res) => json(res, 503, { error: 'two_factor_unavailable' })

// Two-factor can only be required when it can be set up: without the token
// box key nobody could enrol, and requiring it would lock everyone out.
export const twoFactorRequiredNow = (db, tokenBox) => tokenBox.enabled && isTwoFactorRequired(db)

// The /login/2fa* routes. Returns true when it handled the request.
export async function handleTwoFactorLogin(ctx, req, res, url, { rejectEarly }) {
  const { db, tokenBox, tickets, twoFactorLimiter, loginGuard } = ctx
  const path = url.pathname
  if (req.method !== 'POST' || (path !== '/login/2fa' && path !== '/login/2fa/setup' && path !== '/login/2fa/enable')) return false
  // Its own per-IP budget rather than /login's: one sign-in is a password
  // request and a code request (and two more when enrolling), and a typo
  // must not trip the password limiter. Guessing is bounded per ticket and
  // per username below.
  if (!twoFactorLimiter.allow(clientIp(req))) { rejectEarly(req, res, 429, { error: 'rate_limited' }); return true }
  const { ticket, code } = await readBody(req)
  const t = tickets.get(ticket)
  const wantPurpose = path === '/login/2fa' ? 'verify' : 'enrol'
  if (!t || t.purpose !== wantPurpose) { json(res, 401, { error: 'two_factor_ticket_invalid' }); return true }
  // An enrol ticket is for a user who had no two-factor when it was issued.
  // Once they have it (enrolled from another tab or device meanwhile), the
  // password-only ticket must not be able to replace their secret.
  if (wantPurpose === 'enrol' && isTwoFactorEnabled(db, t.userId)) {
    tickets.consume(ticket)
    json(res, 401, { error: 'two_factor_ticket_invalid' })
    return true
  }

  if (path === '/login/2fa/setup') {
    const s = beginSetup(db, tokenBox, t.userId)
    if (!s.ok) { unavailable(res); return true }
    json(res, 200, setupBody(req, t.username, s.secret))
    return true
  }

  if (typeof code !== 'string' || !code) { json(res, 400, { error: 'bad_request' }); return true }

  if (path === '/login/2fa/enable') {
    const r = finishSetup(db, tokenBox, t.userId, code)
    if (!r.ok) {
      if (r.reason === 'unavailable') { unavailable(res); return true }
      if (r.reason === 'no_pending') { json(res, 409, { error: 'no_pending_setup' }); return true }
      const alive = tickets.fail(ticket)
      json(res, 403, { error: 'bad_code', ticket_valid: alive })
      return true
    }
    tickets.consume(ticket)
    loginGuard.ok(t.username)
    const d = createClientDevice(db, t.userId, t.deviceName)
    json(res, 200, { ...deviceBody(d, t.userId), recovery_codes: r.recoveryCodes })
    return true
  }

  // POST /login/2fa: the username's lockout covers codes as well as
  // passwords, so rotating tickets (each needs the password) or IPs buys an
  // attacker nothing.
  if (!guardAllows(loginGuard, res, t.username)) return true
  const v = verifySecondFactor(db, tokenBox, t.userId, code)
  if (!v.ok) {
    if (v.reason === 'unavailable') { unavailable(res); return true }
    if (v.reason === 'not_enabled') { tickets.consume(ticket); json(res, 401, { error: 'two_factor_ticket_invalid' }); return true }
    loginGuard.fail(t.username)
    const alive = tickets.fail(ticket)
    json(res, 403, { error: 'bad_code', ticket_valid: alive })
    return true
  }
  tickets.consume(ticket)
  loginGuard.ok(t.username)
  const d = createClientDevice(db, t.userId, t.deviceName)
  const left = twoFactorState(db, t.userId).recoveryCodesLeft
  json(res, 200, { ...deviceBody(d, t.userId), used_recovery_code: v.method === 'recovery', recovery_codes_left: left })
  return true
}

// The username's lockout (auth.js makeLoginGuard): false, with a 429 sent,
// while it is locked.
function guardAllows(loginGuard, res, username) {
  const gate = loginGuard.check(username)
  if (gate.allowed) return true
  const retryAfter = Math.ceil(gate.retryAfterMs / 1000)
  res.setHeader('Retry-After', retryAfter)
  json(res, 429, { error: 'locked_out', retry_after: retryAfter })
  return false
}

// Password (and, when two-factor is on, a code) before a security change.
// Wrong guesses count against the username's lockout like a sign-in, so a
// stolen token cannot be used to grind the password here.
async function confirmIdentity(ctx, res, who, { password, code, needCode }) {
  const { db, tokenBox, loginGuard } = ctx
  const user = db.prepare('SELECT name FROM users WHERE id=?').get(who.userId)
  if (!guardAllows(loginGuard, res, user.name)) return false
  if (typeof password !== 'string' || !password) { json(res, 400, { error: 'bad_request' }); return false }
  if (!(await verifyUserPassword(db, who.userId, password))) {
    loginGuard.fail(user.name)
    json(res, 401, { error: 'bad_password' })
    return false
  }
  if (!needCode) return true
  if (typeof code !== 'string' || !code) { json(res, 400, { error: 'bad_request' }); return false }
  const v = verifySecondFactor(db, tokenBox, who.userId, code)
  if (!v.ok) {
    if (v.reason === 'unavailable') { unavailable(res); return false }
    loginGuard.fail(user.name)
    json(res, 403, { error: 'bad_code' })
    return false
  }
  return true
}

export async function handleTwoFactorRoute(ctx, req, res, url, who) {
  const { db, tokenBox } = ctx
  const path = url.pathname
  if (path !== '/2fa' && !path.startsWith('/2fa/')) return false
  if (who.kind !== 'client') { json(res, 403, { error: 'forbidden' }); return true }

  if (path === '/2fa' && req.method === 'GET') {
    const s = twoFactorState(db, who.userId)
    json(res, 200, {
      enabled: s.enabled, enabled_at: s.enabledAt, recovery_codes_left: s.recoveryCodesLeft,
      required: twoFactorRequiredNow(db, tokenBox), available: tokenBox.enabled,
    })
    return true
  }

  if (path === '/2fa/setup' && req.method === 'POST') {
    const { password, code } = await readBody(req)
    if (!tokenBox.enabled) { unavailable(res); return true }
    // Moving to a new authenticator app while two-factor is on needs a code
    // from the old one (or a recovery code) as well as the password.
    const enabled = twoFactorState(db, who.userId).enabled
    if (!(await confirmIdentity(ctx, res, who, { password, code, needCode: enabled }))) return true
    const s = beginSetup(db, tokenBox, who.userId)
    if (!s.ok) { unavailable(res); return true }
    const user = db.prepare('SELECT name FROM users WHERE id=?').get(who.userId)
    json(res, 200, setupBody(req, user.name, s.secret))
    return true
  }

  if (path === '/2fa/enable' && req.method === 'POST') {
    const { code, sign_out_others = false } = await readBody(req)
    if (typeof code !== 'string' || !code || typeof sign_out_others !== 'boolean') { json(res, 400, { error: 'bad_request' }); return true }
    // Wrong codes here count against the username's lockout like any other
    // code, so a session cannot grind a pending secret's six digits.
    const user = db.prepare('SELECT name FROM users WHERE id=?').get(who.userId)
    if (!guardAllows(ctx.loginGuard, res, user.name)) return true
    const r = finishSetup(db, tokenBox, who.userId, code)
    if (!r.ok) {
      if (r.reason === 'unavailable') { unavailable(res); return true }
      if (r.reason === 'no_pending') { json(res, 409, { error: 'no_pending_setup' }); return true }
      ctx.loginGuard.fail(user.name)
      json(res, 403, { error: 'bad_code' })
      return true
    }
    // Optional: sign out the user's other web and app sessions, which were
    // signed in with the password alone. Boxes (agent devices) are never
    // touched — they were paired from a signed-in client, not a password.
    const signedOut = sign_out_others
      ? db.prepare("DELETE FROM devices WHERE user_id=? AND kind='client' AND id<>?").run(who.userId, who.deviceId).changes
      : 0
    json(res, 200, { recovery_codes: r.recoveryCodes, signed_out: signedOut })
    return true
  }

  if (path === '/2fa/disable' && req.method === 'POST') {
    const { password, code } = await readBody(req)
    if (!twoFactorState(db, who.userId).enabled) { json(res, 409, { error: 'not_enabled' }); return true }
    if (twoFactorRequiredNow(db, tokenBox)) { json(res, 409, { error: 'two_factor_required' }); return true }
    if (!(await confirmIdentity(ctx, res, who, { password, code, needCode: true }))) return true
    disableTwoFactor(db, who.userId)
    json(res, 200, { ok: true })
    return true
  }

  if (path === '/2fa/recovery-codes' && req.method === 'POST') {
    const { password, code } = await readBody(req)
    if (!twoFactorState(db, who.userId).enabled) { json(res, 409, { error: 'not_enabled' }); return true }
    if (!(await confirmIdentity(ctx, res, who, { password, code, needCode: true }))) return true
    json(res, 200, { recovery_codes: regenerateRecoveryCodes(db, who.userId) })
    return true
  }

  if (path === '/2fa/policy' && req.method === 'PUT') {
    const { required } = await readBody(req)
    if (!isAdmin(db, who)) { json(res, 403, { error: 'forbidden' }); return true }
    if (typeof required !== 'boolean') { json(res, 400, { error: 'bad_request' }); return true }
    if (required && !tokenBox.enabled) { unavailable(res); return true }
    setTwoFactorRequired(db, required)
    json(res, 200, { required: twoFactorRequiredNow(db, tokenBox) })
    return true
  }

  json(res, 404, { error: 'not_found' })
  return true
}
