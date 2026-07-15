import crypto from 'node:crypto'
import argon2 from 'argon2'

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
const newToken = () => crypto.randomBytes(32).toString('hex')

export async function createUser(db, name, password) {
  const hash = await argon2.hash(password, { type: argon2.argon2id })
  const r = db.prepare(
    'INSERT INTO users(name, password_hash, created_at) VALUES(?,?,?)'
  ).run(name, hash, Date.now())
  return { id: r.lastInsertRowid, name }
}

export async function setPassword(db, name, password) {
  const hash = await argon2.hash(password, { type: argon2.argon2id })
  const r = db.prepare('UPDATE users SET password_hash=? WHERE name=?').run(hash, name)
  if (r.changes === 0) throw new Error(`no such user: ${name}`)
}

// POST /password's server-side logic: verify old_password against the REAL
// hash unconditionally — unlike login() there's no user-enumeration oracle
// to close here (Bearer auth already proves who's asking, and every caller
// with a valid device token has a real password_hash row to verify
// against), so no dummy-hash path is needed. Returns {ok:false} on a bad
// old password rather than throwing, so http.js can map it to 401 cleanly.
export async function changePassword(db, userId, { oldPassword, newPassword }) {
  const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId)
  // Defensive only: Bearer auth (authToken) already guarantees a devices row
  // whose user_id references a real users row — this should be unreachable.
  if (!user) return { ok: false }
  const verified = await argon2.verify(user.password_hash, oldPassword)
  if (!verified) return { ok: false }
  const hash = await argon2.hash(newPassword, { type: argon2.argon2id })
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, userId)
  return { ok: true }
}

function issueDevice(db, userId, kind, name) {
  const token = newToken()
  const r = db.prepare(
    'INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,?,?,?,?)'
  ).run(userId, kind, name, sha256(token), Date.now())
  return { token, deviceId: r.lastInsertRowid }
}

// Precomputed at module load and reused for every unknown-username login
// attempt (see login() below). Deliberately NOT lazy: minting it on first
// use would make the FIRST unknown-username attempt after boot pay
// hash+verify (~2x the timing of every later one) — a one-shot
// user-enumeration oracle. Hashing is async, so this doesn't block startup.
const dummyHashPromise = argon2.hash(crypto.randomBytes(32).toString('hex'), { type: argon2.argon2id })
// argon2.hash with these fixed, valid inputs never rejects in practice; the
// no-op catch just guarantees a hypothetical rejection can't crash the
// process as an unhandled rejection before the first login awaits it (that
// login would then surface the same error itself, failing closed).
dummyHashPromise.catch(() => {})

export async function login(db, { username, password, deviceName }) {
  const user = db.prepare('SELECT id, password_hash FROM users WHERE name=?').get(username)
  if (!user) {
    // No user-enumeration timing oracle: verify against a fixed dummy hash
    // so "no such user" takes the same wall-clock time (one argon2.verify)
    // as "wrong password for a real user", instead of returning near-
    // instantly for unknown usernames.
    await argon2.verify(await dummyHashPromise, password)
    return null
  }
  if (!(await argon2.verify(user.password_hash, password))) return null
  const d = issueDevice(db, user.id, 'client', deviceName || 'unnamed')
  return { ...d, userId: user.id }
}

export function createAgent(db, userId, name) {
  return issueDevice(db, userId, 'agent', name)
}

export function authToken(db, token) {
  const row = db.prepare(
    'SELECT id, user_id, kind, name FROM devices WHERE token_hash=?'
  ).get(sha256(token))
  if (!row) return null
  db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(Date.now(), row.id)
  return { deviceId: row.id, userId: row.user_id, kind: row.kind, name: row.name }
}

export function revokeDevice(db, deviceId) {
  db.prepare('DELETE FROM devices WHERE id=?').run(deviceId)
}

// Owner-scoped revocation for POST /devices/:id/revoke. One atomic DELETE
// (no TOCTOU window): the WHERE clause is the ownership check, and the
// boolean lets the handler 404 nonexistent and not-owned identically.
export function revokeOwnedDevice(db, userId, deviceId) {
  return db.prepare('DELETE FROM devices WHERE id=? AND user_id=?').run(deviceId, userId).changes > 0
}

// v1 owner check. Sharing later = extend this + a grants table (spec §7).
export function authorize(db, userId, convoId) {
  const row = db.prepare('SELECT owner_user_id FROM conversations WHERE id=?').get(convoId)
  return !!row && row.owner_user_id === userId
}

// Per-username failed-login lockout with exponential backoff (spec §8). Complements
// the per-IP limiter: an attacker rotating IPs is still locked out of the username.
// Flip side: anyone who knows a username can keep its real owner locked out for the
// lockout window — acceptable for an internal team tool behind the tunnel.
// In-memory like makeRateLimiter: a restart forgets failure counts, which is fine.
export function makeLoginGuard({ threshold = 5, baseMs = 30000, capMs = 3600000 } = {}) {
  const state = new Map() // username -> { fails, lockedUntil }
  return {
    // Called before the argon2 verify, so a locked username costs no hashing work
    // and responds identically whether the guessed password was right or wrong.
    check(username) {
      const now = Date.now()
      // Same unbounded-key guard as makeRateLimiter: sweep expired locks when large.
      // Sub-threshold failure counts are swept too — bounded memory over perfect memory.
      if (state.size > 10000) {
        for (const [k, v] of state) if (now >= v.lockedUntil) state.delete(k)
      }
      const s = state.get(username)
      if (s && now < s.lockedUntil) return { allowed: false, retryAfterMs: s.lockedUntil - now }
      return { allowed: true }
    },
    fail(username) {
      const s = state.get(username) || { fails: 0, lockedUntil: 0 }
      s.fails += 1
      if (s.fails >= threshold) {
        s.lockedUntil = Date.now() + Math.min(baseMs * 2 ** (s.fails - threshold), capMs)
      }
      state.set(username, s)
    },
    ok(username) { state.delete(username) },
  }
}

export function makeRateLimiter({ max = 5, windowMs = 60000 } = {}) {
  const hits = new Map()
  return {
    allow(key) {
      const now = Date.now()
      // Unbounded key growth guard (e.g. many distinct IPs hitting /login once each):
      // once the map gets large, sweep out keys whose most recent hit has already
      // aged out of the window. Simple full-scan sweep is fine at this scale.
      if (hits.size > 10000) {
        for (const [k, list] of hits) {
          if (list.length === 0 || now - list[list.length - 1] >= windowMs) hits.delete(k)
        }
      }
      const list = (hits.get(key) || []).filter((t) => now - t < windowMs)
      if (list.length >= max) { hits.set(key, list); return false }
      list.push(now)
      hits.set(key, list)
      return true
    },
  }
}
