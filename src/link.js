import crypto from 'node:crypto'
import { normalizeCode, randomCode } from './pairing.js'

const MIN_PREAPPROVED_TTL_MS = 60000
const MAX_PREAPPROVED_TTL_MS = 86400000

// Only the SHA-256 of a pre-approved code touches disk — a leaked backup
// exposes only hashes of ~39-bit codes (brute-forceable offline while a row
// is live, but never readable directly).
const hashCode = (code) => crypto.createHash('sha256').update(code).digest('hex')

// In-memory link-session store (spec §1: QR device-link login). Same
// in-memory-factory shape as makePairStore: a restart forgets pending
// links, which is fine — the show side auto-regenerates, and nothing
// durable exists until the approved poll mints the device.
//
// Keyed by starterDeviceId because "one active session per starter" is a
// store invariant — the Map key enforces it structurally, and start() is a
// plain replace. claim() scans for the low-entropy code and poll() scans
// for the 256-bit claimToken; both scans are bounded by maxPending (≤64).
export function makeLinkStore({ ttlMs = 120000, claimExtensionMs = 60000, maxPending = 64, preapprovedTtlMs = 600000, db = null } = {}) {
  const sessions = new Map() // starterDeviceId (or 'preapproved:<random>') -> { code, userId, status, preapproved, claimToken, deviceName, requesterIp, expiresAt }

  // Boot sweep: the server builds its store once at startup, so sweeping
  // here means a journal that was down past a code's expiry doesn't carry
  // dead rows until the next mint.
  if (db) db.prepare('DELETE FROM link_preapprovals WHERE expires_at <= ?').run(Date.now())

  const sweep = (now) => {
    for (const [k, s] of sessions) if (now >= s.expiresAt) sessions.delete(k)
  }

  return {
    start(starterDeviceId, userId) {
      const now = Date.now()
      // Replace-before-cap-check: a starter refreshing its own session must
      // never be blocked by the cap its old session helped fill.
      sessions.delete(starterDeviceId)
      sweep(now)
      if (sessions.size >= maxPending) return null
      // Claim scans in-memory sessions before the db (see claim() below), so
      // an interactive code must also exclude any live db-backed preapproved
      // row — otherwise it would silently shadow that row and attach the
      // hand-off recipient to this stranger's session instead.
      let code
      do { code = randomCode() } while (
        [...sessions.values()].some((s) => s.code === code) ||
        (db && db.prepare('SELECT 1 FROM link_preapprovals WHERE code_hash = ?').get(hashCode(code)))
      )
      sessions.set(starterDeviceId, {
        code, userId, status: 'waiting', claimToken: null, deviceName: null, requesterIp: null, expiresAt: now + ttlMs,
      })
      return { linkCode: `${code.slice(0, 4)}-${code.slice(4)}`, expiresIn: Math.floor(ttlMs / 1000) }
    },
    // Root-on-the-box provisioning (spec §3): the session is born approved —
    // claim() jumps straight to 'approved', so the claimant's first poll
    // returns the device token with no approve tap (at provisioning time
    // there is no other device to tap on). With a db handle the code lives
    // in link_preapprovals INSTEAD of the map (one source of truth) so a
    // long-lived hand-off code survives a restart; only its hash is stored.
    startPreapproved(userId, { ttlMs: requestedTtlMs } = {}) {
      const now = Date.now()
      // Only an explicit per-call override is clamped to [1min, 24h] — the
      // factory-configured preapprovedTtlMs default is trusted as-is (it's
      // how tests exercise sub-minute expiry deterministically).
      const ttl = requestedTtlMs == null
        ? preapprovedTtlMs
        : Math.min(MAX_PREAPPROVED_TTL_MS, Math.max(MIN_PREAPPROVED_TTL_MS, requestedTtlMs))
      if (!db) {
        sweep(now)
        if (sessions.size >= maxPending) return null
        let code
        do { code = randomCode() } while ([...sessions.values()].some((s) => s.code === code))
        sessions.set(`preapproved:${crypto.randomBytes(8).toString('hex')}`, {
          code, userId, status: 'waiting', preapproved: true, claimToken: null, deviceName: null, requesterIp: null, expiresAt: now + ttl,
        })
        return { linkCode: `${code.slice(0, 4)}-${code.slice(4)}`, expiresIn: Math.floor(ttl / 1000) }
      }
      // Sweep-then-cap, same shape as the in-memory path. The cap is
      // independent of the interactive-session cap: both are 64, neither
      // can starve the other.
      db.prepare('DELETE FROM link_preapprovals WHERE expires_at <= ?').run(now)
      if (db.prepare('SELECT COUNT(*) n FROM link_preapprovals').get().n >= maxPending) return null
      // Claim must stay unambiguous across both stores, so the code may
      // collide with neither a live row nor a live in-memory session.
      let code
      do { code = randomCode() } while (
        [...sessions.values()].some((s) => s.code === code) ||
        db.prepare('SELECT 1 FROM link_preapprovals WHERE code_hash=?').get(hashCode(code))
      )
      db.prepare('INSERT INTO link_preapprovals(user_id, code_hash, expires_at, created_at) VALUES(?,?,?,?)')
        .run(userId, hashCode(code), now + ttl, now)
      return { linkCode: `${code.slice(0, 4)}-${code.slice(4)}`, expiresIn: Math.floor(ttl / 1000) }
    },
    claim(codeInput, { deviceName, requesterIp = null }) {
      const now = Date.now()
      sweep(now)
      const code = normalizeCode(codeInput)
      for (const s of sessions.values()) {
        if (s.code !== code) continue
        // First claim wins; any later claim of a used code learns only that
        // it was used (spec §6: telling the truth here leaks nothing useful).
        if (s.status !== 'waiting') return { status: 'conflict' }
        s.status = s.preapproved ? 'approved' : 'claimed'
        s.claimToken = crypto.randomBytes(32).toString('hex')
        s.deviceName = deviceName
        s.requesterIp = requesterIp
        // A last-second scan still leaves time for the approve tap.
        s.expiresAt = Math.max(s.expiresAt, now + claimExtensionMs)
        return { status: 'claimed', claimToken: s.claimToken, expiresIn: Math.ceil((s.expiresAt - now) / 1000) }
      }
      if (db) {
        // Atomic consume: one statement, so two concurrent claims can never
        // both get the row — single-use is enforced by SQLite, not by us.
        // Deleting at claim (not at poll) means a crash in the seconds
        // between claim and poll burns the code unused; the alternative
        // would leave an already-scanned code replayable after a crash.
        const row = db.prepare(
          'DELETE FROM link_preapprovals WHERE code_hash=? AND expires_at > ? RETURNING user_id'
        ).get(hashCode(code), now)
        if (row) {
          // Synthetic approved session: from here the existing poll()
          // machinery mints the device with zero changes. code is
          // deliberately null (not the plaintext code) — the row is already
          // gone from link_preapprovals, and this entry must stay invisible
          // to the claim() scan above, or a second claim of the same code
          // would hit it and return 'conflict' instead of 'not_found'.
          const claimToken = crypto.randomBytes(32).toString('hex')
          sessions.set(`preapproved:${crypto.randomBytes(8).toString('hex')}`, {
            code: null, userId: row.user_id, status: 'approved', preapproved: true, claimToken,
            deviceName, requesterIp, expiresAt: now + claimExtensionMs,
          })
          return { status: 'claimed', claimToken, expiresIn: Math.ceil(claimExtensionMs / 1000) }
        }
      }
      return { status: 'not_found' }
    },
    poll(claimToken) {
      const now = Date.now()
      for (const [k, s] of sessions) {
        if (s.claimToken !== claimToken || s.claimToken === null) continue
        if (now >= s.expiresAt) { sessions.delete(k); return { status: 'not_found' } }
        if (s.status === 'claimed') return { status: 'pending' }
        // denied and approved are both observe-once: delete before returning
        // (one-shot — the identity is gone before the caller sees it).
        sessions.delete(k)
        if (s.status === 'denied') return { status: 'denied' }
        return { status: 'approved', userId: s.userId, deviceName: s.deviceName }
      }
      return { status: 'not_found' }
    },
    status(starterDeviceId) {
      const now = Date.now()
      const s = sessions.get(starterDeviceId)
      if (!s || now >= s.expiresAt) {
        if (s) sessions.delete(starterDeviceId)
        return null
      }
      const expiresIn = Math.ceil((s.expiresAt - now) / 1000)
      if (s.status === 'waiting') return { status: 'waiting', expiresIn }
      if (s.status === 'claimed') return { status: 'claimed', deviceName: s.deviceName, requesterIp: s.requesterIp, expiresIn }
      // approved/denied: terminal for the show side — nothing actionable left.
      return null
    },
    approve(starterDeviceId, codeInput) {
      const s = activeOwn(starterDeviceId, codeInput)
      if (!s) return 'not_found'
      // Only a claimed session can be approved: approving before anyone
      // claimed would blind-sign whoever claims next.
      if (s.status !== 'claimed') return 'conflict'
      s.status = 'approved'
      return 'approved'
    },
    deny(starterDeviceId, codeInput) {
      const s = activeOwn(starterDeviceId, codeInput)
      if (!s) return 'not_found'
      // waiting is deniable too (the user can kill a code pre-claim), but an
      // approved session is already resolved.
      if (s.status !== 'waiting' && s.status !== 'claimed') return 'not_found'
      s.status = 'denied'
      return 'denied'
    },
    size() { return sessions.size },
  }

  // The starter-device binding (spec §6): the session must belong to this
  // device AND the supplied code must match — a belt-and-braces intent
  // check so a stale approve tap can't act on a newer session. Expired,
  // missing, other-device, and wrong-code all collapse to null (→ 404).
  function activeOwn(starterDeviceId, codeInput) {
    const now = Date.now()
    const s = sessions.get(starterDeviceId)
    if (!s) return null
    if (now >= s.expiresAt) { sessions.delete(starterDeviceId); return null }
    if (s.code !== normalizeCode(codeInput)) return null
    return s
  }
}
