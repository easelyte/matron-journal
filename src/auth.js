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
//
// signOutOthers: sign every OTHER client device of the user out (their rows
// deleted, as POST /devices/:id/revoke does). Agent devices are never touched: a bridge
// never held the password, so changing it is no reason to cut off a box.
//
// deviceId: the calling device. The write is a compare-and-swap on the hash
// that was verified, and needs that device to still exist: the hashing
// awaits leave room for another device to change the password (and sign
// this one out) first, and a stale check must not then overwrite it.
// { ok:false, revoked:true } means the caller was signed out meanwhile.
export async function changePassword(db, userId, { oldPassword, newPassword, deviceId, signOutOthers = false }) {
  const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId)
  // Defensive only: Bearer auth (authToken) already guarantees a devices row
  // whose user_id references a real users row — this should be unreachable.
  if (!user) return { ok: false }
  const verified = await argon2.verify(user.password_hash, oldPassword)
  if (!verified) return { ok: false }
  const hash = await argon2.hash(newPassword, { type: argon2.argon2id })
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM devices WHERE id=? AND user_id=?').get(deviceId, userId)) return { ok: false, revoked: true }
    const swapped = db.prepare('UPDATE users SET password_hash=? WHERE id=? AND password_hash=?').run(hash, userId, user.password_hash).changes
    if (!swapped) return { ok: false }
    const signedOut = signOutOthers
      ? db.prepare("DELETE FROM devices WHERE user_id=? AND kind='client' AND id<>?").run(userId, deviceId).changes
      : 0
    return { ok: true, signedOut }
  })()
}

function issueDevice(db, userId, kind, name, tagChar = null) {
  const token = newToken()
  const r = db.prepare(
    // The id is allocated above every revoked private device's tombstone as
    // well as every live device: SQLite's own choice (one past the highest
    // live rowid) would hand a just-revoked private box's id straight back
    // (db.js, private_devices). The AUTOINCREMENT high-water mark joins the
    // max so ids of revoked ordinary devices are not reused either (an
    // explicit id bypasses the sequence, which would otherwise take care of it).
    `INSERT INTO devices(id, user_id, kind, name, tag_char, token_hash, created_at)
     VALUES(1 + MAX((SELECT COALESCE(MAX(id), 0) FROM devices), (SELECT COALESCE(MAX(id), 0) FROM revoked_private_devices),
         (SELECT COALESCE(MAX(seq), 0) FROM sqlite_sequence WHERE name = 'devices')),
       ?,?,?,?,?,?)`
  ).run(userId, kind, name, tagChar, sha256(token), Date.now())
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

// The password half of a sign-in: the user's id, or null. POST /login
// calls this first so a two-factor user gets a sign-in ticket instead of a
// device (src/two-factor-http.js).
export async function checkPassword(db, { username, password }) {
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
  return { userId: user.id }
}

// Re-check the signed-in user's own password before a security change
// (turning two-factor on or off, new recovery codes).
export async function verifyUserPassword(db, userId, password) {
  const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId)
  if (!user || typeof password !== 'string' || !password) return false
  return argon2.verify(user.password_hash, password)
}

export async function login(db, { username, password, deviceName }) {
  const u = await checkPassword(db, { username, password })
  if (!u) return null
  const d = issueDevice(db, u.userId, 'client', deviceName || 'unnamed')
  return { ...d, userId: u.userId }
}

export function createAgent(db, userId, name, tagChar = null) {
  return issueDevice(db, userId, 'agent', name, tagChar)
}

// The /link/* claimant mint: same issuance path /login uses (kind='client'),
// called at the first poll after approval — mirror of createAgent's role in
// the pairing flow.
export function createClientDevice(db, userId, name) {
  return issueDevice(db, userId, 'client', name)
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

// Cosmetic rename, owner-scoped like revokeOwnedDevice. Returns false when
// the device is not this user's (or does not exist) — the caller cannot
// distinguish the two, same anti-enumeration stance as revoke. A remembered
// wake refusal was for the old name, so it goes with it.
export function renameOwnedDevice(db, userId, deviceId, name) {
  return db.prepare('UPDATE devices SET name=?, wake_refused_at=NULL WHERE id=? AND user_id=?').run(name, deviceId, userId).changes > 0
}

// Tag-character twin of renameOwnedDevice: same owner scoping, same merged
// not-owned/nonexistent false. NULL clears back to automatic.
export function setOwnedDeviceTag(db, userId, deviceId, tagChar) {
  return db.prepare('UPDATE devices SET tag_char=? WHERE id=? AND user_id=?').run(tagChar, deviceId, userId).changes > 0
}

// v1 owner check. Sharing later = extend this + a grants table (spec §7).
export function authorize(db, userId, convoId) {
  const row = db.prepare('SELECT owner_user_id FROM conversations WHERE id=?').get(convoId)
  return !!row && row.owner_user_id === userId
}

// Agent write gate (spec: agent chat phase 2, the wrong-conversation
// tightening). An agent device may write into a conversation iff it is the
// recorded managing device (conversations.agent_device_id), a joined
// participant (convo_agents), or the conversation predates ownership
// recording (agent_device_id IS NULL — legacy broadcast rows). User scoping
// comes first, same as authorize(). Inline SQL rather than importing
// participants.js — auth.js stays dependency-free below argon2/crypto.
export function authorizeAgentWrite(db, userId, deviceId, convoId) {
  const row = db.prepare('SELECT owner_user_id, agent_device_id, system FROM conversations WHERE id=?').get(convoId)
  if (!row || row.owner_user_id !== userId) return false
  // The journal's own conversations (people-convo.js): no agent writes there,
  // though the row has no recorded owner.
  if (row.system != null) return false
  if (row.agent_device_id == null || row.agent_device_id === deviceId) return true
  return !!db.prepare(
    "SELECT 1 FROM convo_agents WHERE convo_id=? AND agent_device_id=? AND state='joined'"
  ).get(convoId, deviceId)
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
    // Peek without recording a hit: for a route that charges only its
    // FAILED attempts (the Alertmanager webhook's bad tokens) but must
    // refuse everything — the right token included — once the budget is
    // spent, or a correct guess would still stand out from the 429s.
    blocked(key) {
      const now = Date.now()
      return (hits.get(key) || []).filter((t) => now - t < windowMs).length >= max
    },
  }
}

// Runs async jobs one at a time per key, in arrival order (POST /password's
// per-user check, so the lockout counts every guess before the next one).
// The map only holds keys with a job pending.
export function makeKeyedQueue() {
  const tails = new Map()
  return {
    run(key, job) {
      const prev = tails.get(key) || Promise.resolve()
      const result = prev.then(job, job)
      const tail = result.catch(() => {})
      tails.set(key, tail)
      tail.then(() => { if (tails.get(key) === tail) tails.delete(key) })
      return result
    },
  }
}
