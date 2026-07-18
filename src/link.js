import crypto from 'node:crypto'
import { normalizeCode, randomCode } from './pairing.js'

// In-memory link-session store (spec §1: QR device-link login). Same
// in-memory-factory shape as makePairStore: a restart forgets pending
// links, which is fine — the show side auto-regenerates, and nothing
// durable exists until the approved poll mints the device.
//
// Keyed by starterDeviceId because "one active session per starter" is a
// store invariant — the Map key enforces it structurally, and start() is a
// plain replace. claim() scans for the low-entropy code and poll() scans
// for the 256-bit claimToken; both scans are bounded by maxPending (≤64).
export function makeLinkStore({ ttlMs = 120000, claimExtensionMs = 60000, maxPending = 64, preapprovedTtlMs = 600000 } = {}) {
  const sessions = new Map() // starterDeviceId (or 'preapproved:<random>') -> { code, userId, status, preapproved, claimToken, deviceName, requesterIp, expiresAt }

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
      let code
      do { code = randomCode() } while ([...sessions.values()].some((s) => s.code === code))
      sessions.set(starterDeviceId, {
        code, userId, status: 'waiting', claimToken: null, deviceName: null, requesterIp: null, expiresAt: now + ttlMs,
      })
      return { linkCode: `${code.slice(0, 4)}-${code.slice(4)}`, expiresIn: Math.floor(ttlMs / 1000) }
    },
    // Root-on-the-box provisioning (spec §3): the session is born approved —
    // claim() jumps straight to 'approved', so the claimant's first poll
    // returns the device token with no approve tap (at provisioning time
    // there is no other device to tap on). Synthetic starter key: numeric
    // device ids can never collide with the 'preapproved:' string form, and
    // status/approve/deny key on real device ids so they can't touch these.
    startPreapproved(userId) {
      const now = Date.now()
      sweep(now)
      if (sessions.size >= maxPending) return null
      let code
      do { code = randomCode() } while ([...sessions.values()].some((s) => s.code === code))
      sessions.set(`preapproved:${crypto.randomBytes(8).toString('hex')}`, {
        code, userId, status: 'waiting', preapproved: true, claimToken: null, deviceName: null, requesterIp: null, expiresAt: now + preapprovedTtlMs,
      })
      return { linkCode: `${code.slice(0, 4)}-${code.slice(4)}`, expiresIn: Math.floor(preapprovedTtlMs / 1000) }
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
