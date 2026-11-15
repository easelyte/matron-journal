// Journal user administration (spec 2026-09-23 tracker web/teams, "User
// administration"). The web app's admin page and nothing else: client
// devices whose user carries users.is_admin=1. Everyone else — a plain
// user, and every agent whatever its user's flag — gets one 403 for every
// verb, before any id is looked up, so the surface leaks nothing. Mirrors
// matron-admin: create, reset password, admin flag, clear a GitHub link,
// mint a pairing code.
import { json, readBody, recheckCaller } from './http-body.js'
import { badRequest, notFound, conflict } from './http-who.js'
import { hashPassword } from './auth.js'
import { deleteGithubAccount } from './github-accounts.js'
import { disableTwoFactor } from './two-factor.js'
import { normaliseEmail, setUserEmail } from './password-reset.js'
import { guardedAccountAction, hasActiveKey, refuse, boundedSubject, sha256Hex } from './approval-keys.js'
import { securityLogOf } from './security-log.js'

// A journal name is a URL path segment in shareable links (/u/<name>/<n>)
// and a sender prefix (user:<name>), so it is ASCII, starts alphanumeric,
// and is at most 64 characters.
export const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const PASSWORD_MIN = 8
const TTL_MIN_S = 60
const TTL_MAX_S = 86400

const forbidden = (res) => { json(res, 403, { error: 'forbidden' }); return true }
const weakPassword = (res) => { json(res, 400, { error: 'weak_password' }); return true }

export function isAdmin(db, who) {
  if (!who || who.kind !== 'client') return false
  const row = db.prepare('SELECT is_admin FROM users WHERE id=?').get(who.userId)
  return !!(row && row.is_admin)
}

// Authorisation is checked again after the body await: a demotion or a
// device revocation that lands while a slow body is still uploading must
// not complete a mutation that started with admin rights.
function stillAdmin(db, who) {
  return !!db.prepare('SELECT 1 FROM devices WHERE id=?').get(who.deviceId) && isAdmin(db, who)
}

// An admin's change to an account that widens access to it (a password, a
// two-factor reset, a pre-approved link code, the reset address): an
// account action (src/approval-keys.js). An admin with an active approval
// key signs it, `subject` naming the target by name; an admin with no key
// cannot change an account that has one (403 approval_required: that
// account's protection is not the web admin's to lift; `matron-admin` on
// the host still can); neither with a key is today's behaviour. The admin
// check is made again in the write's transaction. → as guardedAccountAction.
//
// The same guard covers what makes or unmakes an admin: creating any user
// (target null: there is no account yet whose key could refuse a keyless
// admin) and the admin flag, so a keyed admin's stolen token cannot mint a
// keyless admin to act for it.
function adminAccountAction(ctx, who, body, target, subject, write) {
  const { db } = ctx
  return guardedAccountAction({ db, journalHost: ctx.journalHost ?? null }, who, body, boundedSubject(subject), {
    check: () => {
      if (!stillAdmin(db, who)) refuse(403, { error: 'forbidden' })
      if (target && !hasActiveKey(db, who.userId) && hasActiveKey(db, target.id)) refuse(403, { error: 'approval_required' })
    },
    write,
  })
}

// The web admin's change to an account, recorded on that account once it has
// committed (the security log), naming the admin's own device.
const recordAdmin = (ctx, who, target, event, fields = {}) =>
  securityLogOf(ctx).record(target.id, event, { deviceId: who.deviceId, deviceName: who.name, decidedBy: 'admin', ...fields })

// guardedAccountAction's answer as the response: true when it refused.
const refused = (res, g) => { if (g.ok) return false; json(res, g.status, g.body); return true }

const USER_SQL = `SELECT u.id, u.name, u.email, u.is_admin, u.unlisted, u.two_factor_exempt, u.created_at,
    (SELECT COUNT(*) FROM two_factor tf WHERE tf.user_id = u.id AND tf.secret IS NOT NULL) AS two_factor,
    ga.login AS github_login, ga.state AS github_state, ga.host AS github_host
  FROM users u LEFT JOIN github_accounts ga ON ga.user_id = u.id`
const userRow = (db, id) => db.prepare(`${USER_SQL} WHERE u.id=?`).get(id)
const shape = (r) => ({
  id: r.id, name: r.name, email: r.email ?? null, is_admin: !!r.is_admin, unlisted: !!r.unlisted, two_factor_exempt: !!r.two_factor_exempt, created_at: r.created_at,
  two_factor: !!r.two_factor,
  github: r.github_login ? { login: r.github_login, state: r.github_state, host: r.github_host } : null,
})

export async function handleUsersRoute(ctx, req, res, url, who) {
  const { db, links } = ctx
  const path = url.pathname
  if (path !== '/users' && !path.startsWith('/users/')) return false
  if (!isAdmin(db, who)) return forbidden(res)

  if (path === '/users' && req.method === 'GET') {
    json(res, 200, { users: db.prepare(`${USER_SQL} ORDER BY u.id`).all().map(shape) })
    return true
  }
  if (path === '/users' && req.method === 'POST') {
    const body = await readBody(req)
    const { name, password, is_admin = false } = body
    if (!stillAdmin(db, who)) return forbidden(res)
    if (typeof name !== 'string' || !USERNAME_RE.test(name)) return badRequest(res)
    if (typeof is_admin !== 'boolean') return badRequest(res)
    if (typeof password !== 'string' || password.length < PASSWORD_MIN) return weakPassword(res)
    if (db.prepare('SELECT 1 FROM users WHERE name=?').get(name)) return conflict(res)
    // The hash first (it awaits); the row and its admin flag are written in
    // the guarded transaction, so a refused creation leaves no user behind.
    const hash = await hashPassword(password)
    // The admin signed out, or their account locked, during the hash.
    recheckCaller(req)
    const g = adminAccountAction(ctx, who, body, null, { op: 'admin_create_user', user: name, admin: String(is_admin) }, () => {
      try {
        return db.prepare('INSERT INTO users(name, password_hash, is_admin, created_at) VALUES(?,?,?,?)').run(name, hash, is_admin ? 1 : 0, Date.now()).lastInsertRowid
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') refuse(409, { error: 'conflict' })
        throw err
      }
    })
    if (refused(res, g)) return true
    json(res, 201, { user: shape(userRow(db, g.value)) })
    return true
  }

  const m = path.match(/^\/users\/(\d+)(?:\/(password|email|github-link|link-code|two-factor))?$/)
  if (!m) return notFound(res)
  const target = userRow(db, Number(m[1]))
  if (!target) return notFound(res)
  const sub = m[2]

  if (!sub && req.method === 'PATCH') {
    const body = await readBody(req)
    const { is_admin } = body
    if (!stillAdmin(db, who)) return forbidden(res)
    const fresh = userRow(db, target.id); if (!fresh) return notFound(res)
    if (typeof is_admin !== 'boolean') return badRequest(res)
    const g = adminAccountAction(ctx, who, body, fresh, { op: 'admin_set_admin', user: fresh.name, admin: String(is_admin) }, () => {
      // The admin surface must never become unreachable from inside the
      // app: the last admin cannot demote themselves (or be demoted).
      if (!is_admin) {
        const r = db.prepare(`UPDATE users SET is_admin=0 WHERE id=? AND (is_admin=0 OR (SELECT COUNT(*) FROM users WHERE is_admin=1 AND id<>?) > 0)`).run(fresh.id, fresh.id)
        if (r.changes === 0) refuse(409, { error: 'conflict', reason: 'last_admin' })
      } else {
        db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(fresh.id)
      }
    })
    if (refused(res, g)) return true
    json(res, 200, { user: shape(userRow(db, fresh.id)) })
    return true
  }
  if (sub === 'password' && req.method === 'POST') {
    const body = await readBody(req)
    const { password } = body
    if (!stillAdmin(db, who)) return forbidden(res)
    const fresh = userRow(db, target.id); if (!fresh) return notFound(res)
    if (typeof password !== 'string' || password.length < PASSWORD_MIN) return weakPassword(res)
    // Same semantics as `matron-admin user passwd`: device tokens stay valid.
    const hash = await hashPassword(password)
    // The admin signed out, or their account locked, during the hash.
    recheckCaller(req)
    const g = adminAccountAction(ctx, who, body, fresh, { op: 'admin_set_password', user: fresh.name }, () => {
      if (!db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, fresh.id).changes) refuse(404, { error: 'not_found' })
    })
    if (refused(res, g)) return true
    recordAdmin(ctx, who, fresh, 'password_changed')
    json(res, 200, { ok: true })
    return true
  }
  // The address a forgot-password link goes to; null clears it. Same as
  // `matron-admin user email`.
  if (sub === 'email' && req.method === 'PUT') {
    const body = await readBody(req)
    const { email } = body
    if (!stillAdmin(db, who)) return forbidden(res)
    const fresh = userRow(db, target.id); if (!fresh) return notFound(res)
    const clean = email === null ? null : normaliseEmail(email)
    if (email !== null && !clean) { json(res, 400, { error: 'bad_email' }); return true }
    // The subject names the address by the hash of the string as sent (''
    // for null, clearing it).
    const g = adminAccountAction(ctx, who, body, fresh, { op: 'admin_set_reset_email', user: fresh.name, email_sha256: sha256Hex(email ?? '') }, () => {
      if (setUserEmail(db, fresh.id, clean).conflict) refuse(409, { error: 'email_taken' })
    })
    if (refused(res, g)) return true
    json(res, 200, { user: shape(userRow(db, fresh.id)) })
    return true
  }
  if (sub === 'github-link' && req.method === 'DELETE') {
    if (!deleteGithubAccount(db, target.id)) return notFound(res)
    json(res, 200, { ok: true })
    return true
  }
  // An admin's reset for a user who lost their authenticator app and their
  // recovery codes: same effect as `matron-admin user 2fa-reset`.
  if (sub === 'two-factor' && req.method === 'DELETE') {
    const body = await readBody(req)
    if (!stillAdmin(db, who)) return forbidden(res)
    const fresh = userRow(db, target.id); if (!fresh) return notFound(res)
    const g = adminAccountAction(ctx, who, body, fresh, { op: 'admin_reset_two_factor', user: fresh.name }, () => {
      if (!disableTwoFactor(db, fresh.id)) refuse(404, { error: 'not_found' })
    })
    if (refused(res, g)) return true
    recordAdmin(ctx, who, fresh, 'two_factor_changed', { target: 'reset' })
    json(res, 200, { ok: true })
    return true
  }
  if (sub === 'link-code' && req.method === 'POST') {
    const body = await readBody(req)
    const { ttl_seconds } = body
    if (!stillAdmin(db, who)) return forbidden(res)
    const fresh = userRow(db, target.id); if (!fresh) return notFound(res)
    if (ttl_seconds !== undefined && (!Number.isInteger(ttl_seconds) || ttl_seconds < TTL_MIN_S || ttl_seconds > TTL_MAX_S)) return badRequest(res)
    // The same pre-approved session POST /link/preapprove mints for the
    // CLI; the web app builds the matron://link URI from its own origin.
    // With a db-backed link store the code's row is written in the guarded
    // transaction.
    const g = adminAccountAction(ctx, who, body, fresh, { op: 'admin_link_code', user: fresh.name }, () => {
      const l = links.startPreapproved(fresh.id, { ...(ttl_seconds !== undefined ? { ttlMs: ttl_seconds * 1000 } : {}), by: 'admin' })
      if (!l) refuse(429, { error: 'rate_limited' })
      return l
    })
    if (refused(res, g)) return true
    json(res, 200, { link_code: g.value.linkCode, expires_in: g.value.expiresIn })
    return true
  }
  return notFound(res)
}
