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

export function makeRateLimiter({ max = 5, windowMs = 60000 } = {}) {
  const hits = new Map()
  return {
    allow(key) {
      const now = Date.now()
      const list = (hits.get(key) || []).filter((t) => now - t < windowMs)
      if (list.length >= max) { hits.set(key, list); return false }
      list.push(now)
      hits.set(key, list)
      return true
    },
  }
}
