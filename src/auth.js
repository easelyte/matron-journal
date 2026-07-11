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

function issueDevice(db, userId, kind, name) {
  const token = newToken()
  const r = db.prepare(
    'INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,?,?,?,?)'
  ).run(userId, kind, name, sha256(token), Date.now())
  return { token, deviceId: r.lastInsertRowid }
}

export async function login(db, { username, password, deviceName }) {
  const user = db.prepare('SELECT id, password_hash FROM users WHERE name=?').get(username)
  if (!user) return null
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
