// Storage for GitHub account links (spec 2026-09-23 tracker web/teams,
// "GitHub account linking"). Pure DB functions; the HTTP layer and the
// refresh job call these. The token column is written here and read by
// listGithubAccounts (the refresh job) — no view ever returns it.
import { randomBytes } from 'node:crypto'
import { PLAIN_BOX, isSealed, tokenHash } from './token-box.js'

export const LINK_FLOW_TTL_MS = 10 * 60 * 1000

export function githubAccountView(db, userId) {
  const row = db.prepare('SELECT host, login, state, checked_at, linked_at FROM github_accounts WHERE user_id=?').get(userId)
  if (!row) return null
  const orgs = db.prepare('SELECT scope FROM github_orgs WHERE user_id=? ORDER BY scope').all(userId).map((r) => r.scope)
  return { host: row.host, login: row.login, orgs, state: row.state, checked_at: row.checked_at, linked_at: row.linked_at }
}

// One GitHub identity per journal user, one journal user per identity.
export function saveGithubIdentity(db, { userId, host, identity, token, now = Date.now(), box = PLAIN_BOX }) {
  return db.transaction(() => {
    const other = db.prepare('SELECT user_id FROM github_accounts WHERE host=? AND github_id=? AND user_id<>?').get(host, identity.github_id, userId)
    if (other) throw new Error('github_conflict')
    db.prepare(`INSERT INTO github_accounts(user_id, host, github_id, login, token, token_hash, state, checked_at, linked_at)
      VALUES(?,?,?,?,?,?,'ok',?,?)
      ON CONFLICT(user_id) DO UPDATE SET host=excluded.host, github_id=excluded.github_id, login=excluded.login,
        token=excluded.token, token_hash=excluded.token_hash, state='ok', checked_at=excluded.checked_at`)
      .run(userId, host, identity.github_id, identity.login, box.seal(token), tokenHash(token), now, now)
    db.prepare('DELETE FROM github_orgs WHERE user_id=?').run(userId)
    const ins = db.prepare('INSERT INTO github_orgs(user_id, scope) VALUES(?,?)')
    for (const scope of new Set(identity.scopes)) ins.run(userId, scope)
    return githubAccountView(db, userId)
  })()
}

// Refresh-path write: only touches the row that still holds the token the
// refresh was started with, so an unlink or re-link that landed while
// GitHub was being asked is never undone. Returns the view, or null when
// nothing matched.
export function updateGithubIdentity(db, { userId, tokenHash: hash, identity, now = Date.now() }) {
  return db.transaction(() => {
    const r = db.prepare(`UPDATE github_accounts SET github_id=?, login=?, state='ok', checked_at=?
      WHERE user_id=? AND token_hash=?`).run(identity.github_id, identity.login, now, userId, hash)
    if (r.changes === 0) return null
    db.prepare('DELETE FROM github_orgs WHERE user_id=?').run(userId)
    const ins = db.prepare('INSERT INTO github_orgs(user_id, scope) VALUES(?,?)')
    for (const scope of new Set(identity.scopes)) ins.run(userId, scope)
    return githubAccountView(db, userId)
  })()
}

// Is this GitHub identity already linked to a different journal user? The
// web-flow callback asks before parking a token, so a doomed link never
// shows a confirm page.
export function githubIdentityBoundElsewhere(db, { host, githubId, userId }) {
  return !!db.prepare('SELECT 1 FROM github_accounts WHERE host=? AND github_id=? AND user_id<>?').get(host, githubId, userId)
}

// `tokenHash`, when given, scopes the write to the row that still holds the
// token the caller started its refresh/check with — the same "only touch
// the row we asked about" guard as updateGithubIdentity, so a stale-mark
// racing an unlink or re-link never lands on the wrong row.
export function markGithubStale(db, userId, { tokenHash: hash = null, now = Date.now() } = {}) {
  if (hash != null) {
    db.prepare("UPDATE github_accounts SET state='stale', checked_at=? WHERE user_id=? AND token_hash=?").run(now, userId, hash)
  } else {
    db.prepare("UPDATE github_accounts SET state='stale', checked_at=? WHERE user_id=?").run(now, userId)
  }
}

export function deleteGithubAccount(db, userId) {
  return db.prepare('DELETE FROM github_accounts WHERE user_id=?').run(userId).changes > 0
}

export function listGithubAccounts(db) {
  return db.prepare('SELECT user_id, host, token, token_hash FROM github_accounts ORDER BY user_id').all()
}

export function createLinkFlow(db, { userId, deviceId, flow, deviceCode = null, state = null, ttlMs = LINK_FLOW_TTL_MS, now = Date.now() }) {
  const id = `gl_${randomBytes(8).toString('hex')}`
  db.prepare('INSERT INTO github_link_flows(id, user_id, device_id, flow, device_code, state, expires_at, created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, userId, deviceId, flow, deviceCode, state, now + ttlMs, now)
  return db.prepare('SELECT * FROM github_link_flows WHERE id=?').get(id)
}

// Returns the row and deletes it — a flow is finished by exactly one poll
// or one callback. Expired rows are swept on read and answer null.
export function takeLinkFlow(db, { id = null, state = null, now = Date.now() }) {
  return db.transaction(() => {
    db.prepare('DELETE FROM github_link_flows WHERE expires_at <= ?').run(now)
    const row = id != null
      ? db.prepare('SELECT * FROM github_link_flows WHERE id=?').get(id)
      : (state != null ? db.prepare("SELECT * FROM github_link_flows WHERE state=? AND flow='web'").get(state) : null)
    if (!row) return null
    db.prepare('DELETE FROM github_link_flows WHERE id=?').run(row.id)
    return row
  })()
}

// A web-flow result parked until the person on the confirm page says yes.
// The nonce is the page's only credential: single-use, unguessable, and
// swept with the same TTL as a flow. The token sits here for at most that
// long and is deleted on link, cancel or expiry.
export function createLinkConfirm(db, { userId, token, identity, ttlMs = LINK_FLOW_TTL_MS, now = Date.now(), box = PLAIN_BOX }) {
  const id = `gc_${randomBytes(8).toString('hex')}`
  const nonce = randomBytes(16).toString('hex')
  db.prepare('INSERT INTO github_link_confirms(id, user_id, nonce, token, identity_json, expires_at, created_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, userId, nonce, box.seal(token), JSON.stringify(identity), now + ttlMs, now)
  return { id, nonce }
}

// Returns {user_id, token, identity} and deletes the row — a confirm is
// finished by exactly one POST, link or cancel. Expired rows are swept on
// read and answer null.
export function takeLinkConfirm(db, { nonce, now = Date.now(), box = PLAIN_BOX }) {
  // The sweep, SELECT and DELETE all happen inside the transaction, but
  // box.open runs after it returns: a row sealed under a key this process
  // does not hold must still be consumed (deleted) rather than leave the
  // DELETE rolled back and the row retriable against a token nobody can
  // read anyway.
  const row = db.transaction(() => {
    db.prepare('DELETE FROM github_link_confirms WHERE expires_at <= ?').run(now)
    const r = db.prepare('SELECT user_id, token, identity_json FROM github_link_confirms WHERE nonce=?').get(nonce)
    if (!r) return null
    db.prepare('DELETE FROM github_link_confirms WHERE nonce=?').run(nonce)
    return r
  })()
  if (!row) return null
  return { user_id: row.user_id, token: box.open(row.token), identity: JSON.parse(row.identity_json) }
}

// Boot-time upgrade (server.js): seal every plaintext token when a key is
// configured, and backfill token_hash for rows written before the column
// existed. Idempotent; a key-less journal only backfills hashes.
export function sealStoredTokens(db, box) {
  // The plaintext must not linger on disk after sealing. secure_delete zeroes
  // the cells the UPDATEs free instead of leaving the old bytes in the page,
  // and a TRUNCATE checkpoint folds every WAL frame — including the ones that
  // carried the original plaintext INSERTs — into the main file and empties
  // the WAL. Both are no-ops on a :memory: database. Blocks freed at the
  // filesystem level are outside SQLite's reach; that is the disk's job.
  const prevSecureDelete = db.pragma('secure_delete', { simple: true })
  db.pragma('secure_delete = ON')
  let out
  try {
    out = sealInTransaction(db, box)
  } finally {
    db.pragma(`secure_delete = ${prevSecureDelete ? 'ON' : 'OFF'}`)
  }
  if (out.sealed > 0) db.pragma('wal_checkpoint(TRUNCATE)')
  return out
}

function sealInTransaction(db, box) {
  return db.transaction(() => {
    const out = { sealed: 0, hashed: 0, unreadable: 0 }
    for (const r of db.prepare('SELECT user_id, token, token_hash FROM github_accounts').all()) {
      if (isSealed(r.token)) {
        // Already sealed — but possibly under a key this box no longer
        // holds (rotated or removed MATRON_TOKEN_KEY). Never log the
        // value; just note it needs a re-link.
        try { box.open(r.token) } catch { out.unreadable++ }
        continue
      }
      const hash = r.token_hash ?? tokenHash(r.token)
      if (r.token_hash == null) out.hashed++
      const stored = box.seal(r.token)
      if (stored !== r.token) out.sealed++
      db.prepare('UPDATE github_accounts SET token=?, token_hash=? WHERE user_id=?').run(stored, hash, r.user_id)
    }
    for (const r of db.prepare('SELECT id, token FROM github_link_confirms').all()) {
      if (isSealed(r.token)) {
        try { box.open(r.token) } catch { out.unreadable++ }
        continue
      }
      const stored = box.seal(r.token)
      if (stored === r.token) continue
      out.sealed++
      db.prepare('UPDATE github_link_confirms SET token=? WHERE id=?').run(stored, r.id)
    }
    return out
  })()
}
