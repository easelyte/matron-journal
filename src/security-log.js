// Security events (docs/protocol.md "Security event feed"): one line per
// event, per account with a sequence number that starts at 1 and never
// skips or repeats, written to the database, to stdout and (when
// MATRON_SECURITY_LOG names a file) appended to that file, and read back
// by an external watcher through GET /security-events (src/http.js).
//
// A line names what happened, never what was said: no message or task
// text, passwords, codes, tokens, statements, signatures or public keys.
// `target` is a short identifier (device:<id>, key:<first 8 of key_id>,
// convo:<id>, spawns, transfers, a two-factor action, a lock length, a
// refusal reason), never free text, but for the panic's `source`, the
// watcher's own label, which only goes out JSON-encoded.
import fs from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { sharedTokenMatches } from './auth.js'

export const SECURITY_EVENTS = Object.freeze([
  'client_signin', 'device_linked', 'bridge_paired', 'device_revoked', 'password_changed', 'two_factor_changed',
  'password_reset_requested', 'coordinator_changed', 'consent_switch_changed', 'device_protection_changed',
  'spawn_approved', 'chat_approved', 'session_started_direct', 'coordinator_carry_on',
  'approval_key_enrolled', 'approval_key_revoked', 'approval_key_attached', 'approval_invalid',
  'device_signed_out_bad_signatures', 'enrolment_locked', 'transfer_approved',
  'panic_locked', 'panic_cleared',
])
const KNOWN = new Set(SECURITY_EVENTS)
export const DECIDERS = Object.freeze(['user', 'coordinator', 'admin', 'admin_cli', 'journal'])
const KNOWN_DECIDERS = new Set(DECIDERS)

// Rows are kept 30 days (swept by the retention schedule, src/server.js
// sweepSecurityEvents below); the per-account counter is kept apart from
// them, so a sweep never lets a sequence number be handed out again.
export const SECURITY_EVENT_KEEP_MS = 30 * 24 * 60 * 60000
export const FEED_LIMIT_DEFAULT = 100
export const FEED_LIMIT_MAX = 500
export const FEED_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/

export const deviceTarget = (id) => `device:${id}`
export const keyTarget = (keyId) => `key:${String(keyId).slice(0, 8)}`
export const convoTarget = (id) => `convo:${id}`
export const transferTarget = (id) => `transfer:${id}`
// A box by its name as it is now (looked up when the event is recorded);
// null for a device that is gone.
export function boxTarget(db, deviceId) {
  const name = deviceId == null ? null : db.prepare('SELECT name FROM devices WHERE id=?').get(deviceId)?.name
  return name == null ? null : `box:${name}`
}

// The request a recording happens under: its client address, the way
// src/http.js derives it (cf-connecting-ip behind the tunnel, else the
// socket's). Entered once per HTTP request (makeHttpHandler), so a
// recording deep in a guard (an invalid approval) knows it too; a
// WebSocket frame, the admin CLI and the journal's own work run outside
// one, and their lines carry null.
const requestScope = new AsyncLocalStorage()
export const requestSourceIp = (req) => req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || null
export function withRequestScope(req, fn) {
  return requestScope.run({ sourceIp: requestSourceIp(req) }, fn)
}

// The line, the stored row and the feed's object are one shape.
const lineOf = (row, account) => ({
  kind: 'matron_security', seq: row.seq, ts: row.ts, event: row.event, account,
  device_id: row.device_id ?? null, device_name: row.device_name ?? null, source_ip: row.source_ip ?? null,
  target: row.target ?? null, decided_by: row.decided_by ?? null,
})

const strOrNull = (v) => (v == null ? null : String(v))

export function makeSecurityLog({ db, out = (line) => process.stdout.write(line + '\n'), file = process.env.MATRON_SECURITY_LOG, now = Date.now }) {
  const allocate = db.prepare(`INSERT INTO security_event_seqs(user_id, seq) VALUES(?, 1)
    ON CONFLICT(user_id) DO UPDATE SET seq = seq + 1 RETURNING seq`)
  const insert = db.prepare(`INSERT INTO security_events(user_id, seq, ts, event, device_id, device_name, source_ip, target, decided_by)
    VALUES(?,?,?,?,?,?,?,?,?)`)
  const userName = db.prepare('SELECT name FROM users WHERE id=?')
  const deviceName = db.prepare('SELECT name FROM devices WHERE id=?')
  let fileFailed = false

  // The row: its number and the row in one transaction (a savepoint when
  // the caller's is open), the counter bumped under the write lock, so two
  // writers (the server and the admin CLI on the same file) never get the
  // same one. → {row, account}, or null when not recorded.
  const insertRow = (userId, event, fields) => {
    try {
      const account = userName.get(userId)?.name
      if (account == null) return null
      const row = {
        ts: now(), event,
        device_id: fields.deviceId ?? null,
        device_name: strOrNull(fields.deviceName),
        source_ip: strOrNull(fields.sourceIp),
        target: strOrNull(fields.target),
        decided_by: KNOWN_DECIDERS.has(fields.decidedBy) ? fields.decidedBy : null,
      }
      db.transaction(() => {
        row.seq = allocate.get(userId).seq
        insert.run(userId, row.seq, row.ts, row.event, row.device_id, row.device_name, row.source_ip, row.target, row.decided_by)
      })()
      return { row, account }
    } catch (err) {
      console.error(`security log: ${event} not recorded (${err?.message || err})`)
      return null
    }
  }
  // Is this exact row there now: its number AND every column, so a row
  // that rolled back is never taken for the one that got its number next.
  const stillThere = db.prepare(`SELECT 1 FROM security_events WHERE user_id=? AND seq=? AND ts=? AND event=?
    AND device_id IS ? AND device_name IS ? AND source_ip IS ? AND target IS ? AND decided_by IS ?`)

  // The line: stdout, then the file.
  const write = ({ row, account }) => {
    const line = JSON.stringify(lineOf(row, account))
    try { out(line) } catch (err) { console.error(`security log: writing a line failed (${err?.message || err})`) }
    if (!file) return
    try {
      fs.appendFileSync(file, line + '\n')
      fileFailed = false
    } catch (err) {
      // Once per outage: the event is in the database and on stdout.
      if (!fileFailed) console.error(`security log: appending to MATRON_SECURITY_LOG failed (${err?.code || err?.message || err}); events still go to the database and stdout`)
      fileFailed = true
    }
  }

  // Lines go out in seq order per account. While an account has a line
  // waiting for its transaction's outcome (`held`), its other lines queue
  // (`ready`, by seq) and all go out, in order, once none is waiting. A
  // number already queued is a committed row (written outside a
  // transaction, or checked after one): a waiting line for the same number
  // is a row that rolled back and is dropped.
  const pending = new Map() // userId -> { held, ready: Map<seq, entry> }
  const slot = (userId) => {
    let p = pending.get(userId)
    if (!p) { p = { held: 0, ready: new Map() }; pending.set(userId, p) }
    return p
  }
  const flush = (userId) => {
    const p = pending.get(userId)
    if (!p || p.held > 0) return
    pending.delete(userId)
    for (const seq of [...p.ready.keys()].sort((a, b) => a - b)) write(p.ready.get(seq))
  }
  const emit = (userId, r) => {
    const p = pending.get(userId)
    if (!p) { write(r); return }
    p.ready.set(r.row.seq, r)
  }

  return {
    // One event for the account `userId`. Never throws. `deviceName`
    // defaults to the device's current name; `sourceIp` to the request's.
    //
    // Outside a database transaction it is written at once. Inside one:
    // - an event for a change (the default) is written in that
    //   transaction, so it goes if the change rolls back; its line goes
    //   out a microtask later (by then the synchronous better-sqlite3
    //   transaction has committed or rolled back), only if its row is
    //   there, exactly as it was written;
    // - an event that describes the refusal itself (`evenIfRolledBack`:
    //   an invalid approval, the lockdown after it, the enrolment lock)
    //   waits for that microtask and is written in its own transaction, so
    //   the rollback of the request that caused it cannot lose it.
    // Either way an account's lines go out in seq order.
    record(userId, event, fields = {}, { evenIfRolledBack = false } = {}) {
      try {
        if (!KNOWN.has(event)) throw new Error(`unknown security event ${JSON.stringify(event)}`)
        const resolved = { ...fields }
        // Both resolved now, while the device (which may be on its way
        // out) and the request are still there.
        if (resolved.deviceName === undefined) resolved.deviceName = resolved.deviceId == null ? null : deviceName.get(resolved.deviceId)?.name ?? null
        if (resolved.sourceIp === undefined) resolved.sourceIp = requestScope.getStore()?.sourceIp ?? null
        if (!db.inTransaction) {
          const r = insertRow(userId, event, resolved)
          if (r) emit(userId, r)
        } else if (evenIfRolledBack) {
          queueMicrotask(() => {
            const r = insertRow(userId, event, resolved)
            if (r) emit(userId, r)
          })
        } else {
          const r = insertRow(userId, event, resolved)
          if (r) {
            const p = slot(userId)
            p.held += 1
            queueMicrotask(() => {
              try {
                const { row } = r
                if (!p.ready.has(row.seq) && stillThere.get(userId, row.seq, row.ts, row.event, row.device_id, row.device_name, row.source_ip, row.target, row.decided_by)) {
                  p.ready.set(row.seq, r)
                }
              } catch (err) {
                console.error(`security log: ${event}: ${err?.message || err}`)
              } finally {
                p.held -= 1
                flush(userId)
              }
            })
          }
        }
      } catch (err) {
        console.error(`security log: ${err?.message || err}`)
      }
    },
    read: (userId, opts) => readSecurityEvents(db, userId, opts),
  }
}

// The feed's page for one account: events with seq > `since` (ascending,
// the first `limit`), or with `since` null the newest `limit` (still
// ascending). `last_seq` is the account's latest number, 0 when none.
// One read transaction, so `last_seq` and the rows are of the same moment.
export function readSecurityEvents(db, userId, { since = null, limit = FEED_LIMIT_DEFAULT } = {}) {
  return db.transaction(() => {
    const account = db.prepare('SELECT name FROM users WHERE id=?').get(userId)?.name ?? null
    const lastSeq = db.prepare('SELECT seq FROM security_event_seqs WHERE user_id=?').get(userId)?.seq ?? 0
    const rows = since == null
      ? db.prepare('SELECT * FROM security_events WHERE user_id=? ORDER BY seq DESC LIMIT ?').all(userId, limit).reverse()
      : db.prepare('SELECT * FROM security_events WHERE user_id=? AND seq > ? ORDER BY seq LIMIT ?').all(userId, since, limit)
    return { account, last_seq: lastSeq, events: rows.map((r) => lineOf(r, account)) }
  })()
}

// Rows past their 30 days (the retention schedule, src/server.js). The
// counter rows stay.
export function sweepSecurityEvents(db, now = Date.now()) {
  db.prepare('DELETE FROM security_events WHERE ts <= ?').run(now - SECURITY_EVENT_KEEP_MS)
}

// The journal's one log per database, for code that has the database but
// not the request's context (the approval guard, the lockdown): installed
// by startServer. Without one (a bare handler, a unit test), events are
// dropped.
const installed = new WeakMap()
const NOOP_LOG = Object.freeze({ record() {}, read: () => ({ account: null, last_seq: 0, events: [] }) })
export function installSecurityLog(db, log) { installed.set(db, log) }
export function securityLogFor(db) { return installed.get(db) ?? NOOP_LOG }
// A route's context's log (makeHttpHandler passes its own), else the one
// installed for its database.
export const securityLogOf = (ctx) => ctx.securityLog ?? securityLogFor(ctx.db)

// MATRON_SECURITY_FEED_TOKEN / MATRON_SECURITY_FEED_ACCOUNT: both set and
// the token well formed, or the feed is off (and a malformed token says so
// once, never printing it). → {token, account} or null.
export function resolveSecurityFeed({ token, account } = {}, { warn = console.warn } = {}) {
  if (!token && !account) return null
  if (!token || !account) {
    warn('security feed: MATRON_SECURITY_FEED_TOKEN and MATRON_SECURITY_FEED_ACCOUNT must both be set; GET /security-events is off')
    return null
  }
  if (!FEED_TOKEN_RE.test(token)) {
    warn('security feed: MATRON_SECURITY_FEED_TOKEN must be 32 to 128 characters of A-Z a-z 0-9 _ -; GET /security-events is off')
    return null
  }
  return { token, account }
}

// GET /security-events?since=&limit= with the feed's own Bearer token,
// ahead of device authentication (src/http.js). Off (feed null): 404, as
// any unknown path. A wrong or missing token is charged to the per-address
// budget /login and the alerts webhook share (`rateLimiter`), and once it is
// spent every request from that address is refused, the right token
// included, as the webhook does (src/alerts-http.js). The token is compared
// in constant time, by the webhook's helper (auth.js). → true when it answered.
export function handleSecurityFeed({ db, feed, json, rateLimiter = null }, req, res, url, { rejectEarly }) {
  if (url.pathname !== '/security-events' || req.method !== 'GET') return false
  if (!feed) { json(res, 404, { error: 'not_found' }); return true }
  const ip = requestSourceIp(req) || 'unknown'
  if (rateLimiter?.blocked?.(ip)) { rejectEarly(req, res, 429, { error: 'rate_limited' }); return true }
  const given = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1]
  if (!given || !sharedTokenMatches(feed.token, given)) {
    rateLimiter?.allow(ip)
    rejectEarly(req, res, 401, { error: 'unauthenticated' })
    return true
  }
  const user = db.prepare('SELECT id FROM users WHERE name=?').get(feed.account)
  if (!user) { json(res, 404, { error: 'not_found' }); return true }
  const int = (name) => {
    if (!url.searchParams.has(name)) return undefined
    const raw = url.searchParams.get(name)
    return /^\d{1,15}$/.test(raw) ? Number(raw) : null
  }
  const since = int('since')
  const limit = int('limit')
  if (since === null || limit === null || limit === 0) { json(res, 400, { error: 'bad_request' }); return true }
  const page = readSecurityEvents(db, user.id, { since: since ?? null, limit: Math.min(limit ?? FEED_LIMIT_DEFAULT, FEED_LIMIT_MAX) })
  json(res, 200, page)
  return true
}
