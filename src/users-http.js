// Journal user administration (spec 2026-09-23 tracker web/teams, "User
// administration"). The web app's admin page and nothing else: client
// devices whose user carries users.is_admin=1. Everyone else — a plain
// user, and every agent whatever its user's flag — gets one 403 for every
// verb, before any id is looked up, so the surface leaks nothing. Mirrors
// matron-admin: create, reset password, admin flag, clear a GitHub link,
// mint a pairing code.
import { json, readBody } from './http-body.js'
import { badRequest, notFound, conflict } from './http-who.js'
import { createUser, setPassword } from './auth.js'
import { deleteGithubAccount } from './github-accounts.js'

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

const USER_SQL = `SELECT u.id, u.name, u.is_admin, u.created_at,
    ga.login AS github_login, ga.state AS github_state, ga.host AS github_host
  FROM users u LEFT JOIN github_accounts ga ON ga.user_id = u.id`
const userRow = (db, id) => db.prepare(`${USER_SQL} WHERE u.id=?`).get(id)
const shape = (r) => ({
  id: r.id, name: r.name, is_admin: !!r.is_admin, created_at: r.created_at,
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
    const { name, password, is_admin = false } = await readBody(req)
    if (!stillAdmin(db, who)) return forbidden(res)
    if (typeof name !== 'string' || !USERNAME_RE.test(name)) return badRequest(res)
    if (typeof is_admin !== 'boolean') return badRequest(res)
    if (typeof password !== 'string' || password.length < PASSWORD_MIN) return weakPassword(res)
    if (db.prepare('SELECT 1 FROM users WHERE name=?').get(name)) return conflict(res)
    let u
    try {
      u = await createUser(db, name, password)
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return conflict(res)
      throw err
    }
    if (is_admin) db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(u.id)
    json(res, 201, { user: shape(userRow(db, u.id)) })
    return true
  }

  const m = path.match(/^\/users\/(\d+)(?:\/(password|github-link|link-code))?$/)
  if (!m) return notFound(res)
  const target = userRow(db, Number(m[1]))
  if (!target) return notFound(res)
  const sub = m[2]

  if (!sub && req.method === 'PATCH') {
    const { is_admin } = await readBody(req)
    if (!stillAdmin(db, who)) return forbidden(res)
    const fresh = userRow(db, target.id); if (!fresh) return notFound(res)
    if (typeof is_admin !== 'boolean') return badRequest(res)
    // The admin surface must never become unreachable from inside the app:
    // the last admin cannot demote themselves (or be demoted).
    if (!is_admin) {
      const r = db.prepare(`UPDATE users SET is_admin=0 WHERE id=? AND (is_admin=0 OR (SELECT COUNT(*) FROM users WHERE is_admin=1 AND id<>?) > 0)`).run(fresh.id, fresh.id)
      if (r.changes === 0) return conflict(res, { reason: 'last_admin' })
    } else {
      db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(fresh.id)
    }
    json(res, 200, { user: shape(userRow(db, fresh.id)) })
    return true
  }
  if (sub === 'password' && req.method === 'POST') {
    const { password } = await readBody(req)
    if (!stillAdmin(db, who)) return forbidden(res)
    const fresh = userRow(db, target.id); if (!fresh) return notFound(res)
    if (typeof password !== 'string' || password.length < PASSWORD_MIN) return weakPassword(res)
    // Same semantics as `matron-admin user passwd`: device tokens stay valid.
    await setPassword(db, fresh.name, password)
    json(res, 200, { ok: true })
    return true
  }
  if (sub === 'github-link' && req.method === 'DELETE') {
    if (!deleteGithubAccount(db, target.id)) return notFound(res)
    json(res, 200, { ok: true })
    return true
  }
  if (sub === 'link-code' && req.method === 'POST') {
    const { ttl_seconds } = await readBody(req)
    if (!stillAdmin(db, who)) return forbidden(res)
    const fresh = userRow(db, target.id); if (!fresh) return notFound(res)
    if (ttl_seconds !== undefined && (!Number.isInteger(ttl_seconds) || ttl_seconds < TTL_MIN_S || ttl_seconds > TTL_MAX_S)) return badRequest(res)
    // The same pre-approved session POST /link/preapprove mints for the
    // CLI; the web app builds the matron://link URI from its own origin.
    const l = links.startPreapproved(fresh.id, ttl_seconds !== undefined ? { ttlMs: ttl_seconds * 1000 } : {})
    if (!l) { json(res, 429, { error: 'rate_limited' }); return true }
    json(res, 200, { link_code: l.linkCode, expires_in: l.expiresIn })
    return true
  }
  return notFound(res)
}
