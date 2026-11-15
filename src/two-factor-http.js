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
import { json, readBody, recheckCaller } from './http-body.js'
import { verifyUserPassword, createClientDevice } from './auth.js'
import { panicLock, lockedBody } from './panic.js'
import { isAdmin } from './users-http.js'
import { guardedAccountAction, hasActiveKey, refuse } from './approval-keys.js'
import { securityLogOf, deviceTarget } from './security-log.js'
import {
  twoFactorState, isTwoFactorEnabled, beginSetup, finishSetup, verifySecondFactor, disableTwoFactor,
  regenerateRecoveryCodes, isTwoFactorRequired, setTwoFactorRequired, isTwoFactorExempt, otpauthUri,
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

// A two-factor change, once it has committed (the security log): from a
// signed-in device, or (no device yet) at sign-in.
const recordChange = (ctx, userId, action, who = null) =>
  securityLogOf(ctx).record(userId, 'two_factor_changed', { deviceId: who?.deviceId ?? null, deviceName: who?.name ?? null, target: action, decidedBy: 'user' })
const recordSignIn = (ctx, userId, d) =>
  securityLogOf(ctx).record(userId, 'client_signin', { deviceId: d.deviceId, target: deviceTarget(d.deviceId), decidedBy: 'user' })

// Two-factor can only be required when it can be set up: without the token
// box key nobody could enrol, and requiring it would lock everyone out.
// This is the journal-wide switch; what holds one user is below.
export const twoFactorPolicyNow = (db, tokenBox) => tokenBox.enabled && isTwoFactorRequired(db)

// Whether the requirement holds this user: the switch is on and the
// operator has not exempted them (users.two_factor_exempt). An exempt user
// who has set two-factor up is still asked for their code at sign-in; this
// only says whether they must have it.
export function twoFactorRequiredNow(db, tokenBox, userId) {
  if (!Number.isInteger(userId)) throw new TypeError('twoFactorRequiredNow needs a user id')
  return twoFactorPolicyNow(db, tokenBox) && !isTwoFactorExempt(db, userId)
}

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
  // A panic-locked account (src/panic.js): 423 before any code is checked
  // or the lockout counts anything, on every step.
  const lock = panicLock(db, t.userId)
  if (lock) { json(res, 423, lockedBody(lock)); return true }
  // An enrol ticket is for a user who had no two-factor when it was issued.
  // Once they have it (enrolled from another tab or device meanwhile), the
  // password-only ticket must not be able to replace their secret.
  if (wantPurpose === 'enrol' && isTwoFactorEnabled(db, t.userId)) {
    tickets.consume(ticket)
    json(res, 401, { error: 'two_factor_ticket_invalid' })
    return true
  }
  // An account with an approval key sets two-factor up only from a
  // signed-in device, with a signature (the guarded /2fa/setup and
  // /2fa/enable). At sign-in the password alone would otherwise buy a new
  // authenticator, and password plus TOTP can remove every key.
  if (wantPurpose === 'enrol' && hasActiveKey(db, t.userId)) { json(res, 403, { error: 'approval_required' }); return true }

  if (path === '/login/2fa/setup') {
    const s = beginSetup(db, tokenBox, t.userId)
    if (!s.ok) { unavailable(res); return true }
    recordChange(ctx, t.userId, 'setup')
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
    recordChange(ctx, t.userId, 'enable')
    const d = createClientDevice(db, t.userId, t.deviceName)
    recordSignIn(ctx, t.userId, d)
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
  recordSignIn(ctx, t.userId, d)
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
export async function confirmIdentity(ctx, res, who, { password, code, needCode }) {
  if (!(await confirmPassword(ctx, res, who, password))) return false
  if (!needCode) return true
  const refused = secondFactorRefusal(ctx, who, code)
  if (refused) { json(res, refused.status, refused.body); return false }
  return true
}

// confirmIdentity's two halves, for a route that checks the code inside its
// write's transaction (the guarded routes below): the password (async;
// false with the answer sent), and the code (synchronous; null, or the
// {status, body} to answer). A good code is spent where it is checked, so
// inside a transaction a refusal later in it leaves the code unspent.
async function confirmPassword(ctx, res, who, password) {
  const { db, loginGuard } = ctx
  const user = db.prepare('SELECT name FROM users WHERE id=?').get(who.userId)
  if (!guardAllows(loginGuard, res, user.name)) return false
  if (typeof password !== 'string' || !password) { json(res, 400, { error: 'bad_request' }); return false }
  if (!(await verifyUserPassword(db, who.userId, password))) {
    loginGuard.fail(user.name)
    json(res, 401, { error: 'bad_password' })
    return false
  }
  return true
}

function secondFactorRefusal(ctx, who, code) {
  const { db, tokenBox, loginGuard } = ctx
  if (typeof code !== 'string' || !code) return { status: 400, body: { error: 'bad_request' } }
  const v = verifySecondFactor(db, tokenBox, who.userId, code)
  if (v.ok) return null
  if (v.reason === 'unavailable') return { status: 503, body: { error: 'two_factor_unavailable' } }
  loginGuard.fail(db.prepare('SELECT name FROM users WHERE id=?').get(who.userId).name)
  return { status: 403, body: { error: 'bad_code' } }
}

// The code check as a guarded transaction's `check` step.
const codeCheck = (ctx, who, code) => () => {
  const refused = secondFactorRefusal(ctx, who, code)
  if (refused) refuse(refused.status, refused.body)
}

// A two-factor change is an account action: once the user has an approval
// key it is signed too, {op:'two_factor', action}, on top of the password
// and code it asks for today. The code is checked (and spent) in `check`,
// in the same transaction as the guard and the write and ahead of the
// guard, so a bad code never spends the nonce and a refused request never
// spends the code (src/approval-keys.js guardedAccountAction).
// → {ok:true, value}, or {ok:false} with the answer sent.
function guardedTwoFactor(ctx, res, who, body, action, { check, write }) {
  const g = guardedAccountAction({ db: ctx.db, journalHost: ctx.journalHost ?? null }, who, body, { op: 'two_factor', action }, { check, write })
  if (!g.ok) json(res, g.status, g.body)
  return g
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
      required: twoFactorRequiredNow(db, tokenBox, who.userId), exempt: isTwoFactorExempt(db, who.userId),
      available: tokenBox.enabled,
    })
    return true
  }

  if (path === '/2fa/setup' && req.method === 'POST') {
    const body = await readBody(req)
    const { password, code } = body
    if (!tokenBox.enabled) { unavailable(res); return true }
    // Moving to a new authenticator app while two-factor is on needs a code
    // from the old one (or a recovery code) as well as the password.
    const enabled = twoFactorState(db, who.userId).enabled
    if (!(await confirmPassword(ctx, res, who, password))) return true
    // Signed out, or the account locked, while the password was checked.
    recheckCaller(req)
    const g = guardedTwoFactor(ctx, res, who, body, 'setup', {
      check: enabled ? codeCheck(ctx, who, code) : undefined,
      write: () => {
        const begun = beginSetup(db, tokenBox, who.userId)
        if (!begun.ok) refuse(503, { error: 'two_factor_unavailable' })
        return begun.secret
      },
    })
    if (!g.ok) return true
    recordChange(ctx, who.userId, 'setup', who)
    const user = db.prepare('SELECT name FROM users WHERE id=?').get(who.userId)
    json(res, 200, setupBody(req, user.name, g.value))
    return true
  }

  if (path === '/2fa/enable' && req.method === 'POST') {
    const body = await readBody(req)
    const { code, sign_out_others = false } = body
    if (typeof code !== 'string' || !code || typeof sign_out_others !== 'boolean') { json(res, 400, { error: 'bad_request' }); return true }
    // Wrong codes here count against the username's lockout like any other
    // code, so a session cannot grind a pending secret's six digits.
    const user = db.prepare('SELECT name FROM users WHERE id=?').get(who.userId)
    if (!guardAllows(ctx.loginGuard, res, user.name)) return true
    // The pending secret's code is today's check, made (and the secret
    // switched in) inside the guarded transaction ahead of the guard.
    let r
    const g = guardedTwoFactor(ctx, res, who, body, 'enable', {
      check: () => {
        r = finishSetup(db, tokenBox, who.userId, code)
        if (r.ok) return
        if (r.reason === 'unavailable') refuse(503, { error: 'two_factor_unavailable' })
        if (r.reason === 'no_pending') refuse(409, { error: 'no_pending_setup' })
        ctx.loginGuard.fail(user.name)
        refuse(403, { error: 'bad_code' })
      },
      // Optional: sign out the user's other web and app sessions, which were
      // signed in with the password alone. Boxes (agent devices) are never
      // touched — they were paired from a signed-in client, not a password.
      write: () => (sign_out_others
        ? db.prepare("DELETE FROM devices WHERE user_id=? AND kind='client' AND id<>? RETURNING id").all(who.userId, who.deviceId).map((d) => d.id).sort((a, b) => a - b)
        : []),
    })
    if (!g.ok) return true
    recordChange(ctx, who.userId, 'enable', who)
    // Each client it signed out (the security log).
    for (const id of g.value) securityLogOf(ctx).record(who.userId, 'device_revoked', { deviceId: who.deviceId, deviceName: who.name, target: deviceTarget(id), decidedBy: 'user' })
    json(res, 200, { recovery_codes: r.recoveryCodes, signed_out: g.value.length })
    return true
  }

  if (path === '/2fa/disable' && req.method === 'POST') {
    const body = await readBody(req)
    const { password, code } = body
    if (!twoFactorState(db, who.userId).enabled) { json(res, 409, { error: 'not_enabled' }); return true }
    if (twoFactorRequiredNow(db, tokenBox, who.userId)) { json(res, 409, { error: 'two_factor_required' }); return true }
    if (!(await confirmPassword(ctx, res, who, password))) return true
    // Signed out, or the account locked, while the password was checked.
    recheckCaller(req)
    const g = guardedTwoFactor(ctx, res, who, body, 'disable', { check: codeCheck(ctx, who, code), write: () => disableTwoFactor(db, who.userId) })
    if (!g.ok) return true
    recordChange(ctx, who.userId, 'disable', who)
    json(res, 200, { ok: true })
    return true
  }

  if (path === '/2fa/recovery-codes' && req.method === 'POST') {
    const body = await readBody(req)
    const { password, code } = body
    if (!twoFactorState(db, who.userId).enabled) { json(res, 409, { error: 'not_enabled' }); return true }
    if (!(await confirmPassword(ctx, res, who, password))) return true
    // Signed out, or the account locked, while the password was checked.
    recheckCaller(req)
    const g = guardedTwoFactor(ctx, res, who, body, 'recovery_codes', { check: codeCheck(ctx, who, code), write: () => regenerateRecoveryCodes(db, who.userId) })
    if (!g.ok) return true
    recordChange(ctx, who.userId, 'recovery_codes', who)
    json(res, 200, { recovery_codes: g.value })
    return true
  }

  if (path === '/2fa/policy' && req.method === 'PUT') {
    const { required } = await readBody(req)
    if (!isAdmin(db, who)) { json(res, 403, { error: 'forbidden' }); return true }
    if (typeof required !== 'boolean') { json(res, 400, { error: 'bad_request' }); return true }
    if (required && !tokenBox.enabled) { unavailable(res); return true }
    setTwoFactorRequired(db, required)
    json(res, 200, { required: twoFactorPolicyNow(db, tokenBox) })
    return true
  }

  json(res, 404, { error: 'not_found' })
  return true
}
