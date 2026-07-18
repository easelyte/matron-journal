import crypto from 'node:crypto'

// Pair-code alphabet: Crockford base32 (no I/L/O/U lookalikes) minus the
// remaining vowels A/E so codes can't spell words. 30 chars; 8 chars ≈ 39
// bits — plenty for a code that grants nothing without an authenticated
// approval and dies in ttlMs anyway.
export const CODE_ALPHABET = '0123456789BCDFGHJKMNPQRSTVWXYZ'
const CODE_LEN = 8

// crypto.randomInt is unbiased (rejection sampling), unlike bytes % 30.
// randomChars is exported for src/rendezvous.js (26-char rids) and
// randomCode for src/link.js (link codes share the pairing alphabet).
export const randomChars = (len) => Array.from({ length: len }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('')
export const randomCode = () => randomChars(CODE_LEN)

// Boxes display XXXX-XXXX; humans type variations. Comparison happens on
// this normal form only.
export function normalizeCode(input) {
  return String(input).toUpperCase().replace(/[^0-9A-Z]/g, '')
}

// In-memory pending-pair store (spec: device-authorization flow, mint at
// claim). Same in-memory-factory shape as makeRateLimiter/makeLoginGuard:
// a restart forgets pending pairs, which is fine — the box CLI retries
// with a fresh code, and nothing durable exists until claim.
//
// Keyed by pollToken (the 256-bit claim secret) so claim() is a direct
// Map.get on the high-entropy value. approve() scans for the low-entropy
// display code instead — bounded by maxPending (≤64) and only reachable
// with an authenticated client bearer, so the scan is fine.
export function makePairStore({ ttlMs = 600000, maxPending = 64 } = {}) {
  const pairs = new Map() // pollToken -> { code, userId, agentName, approved, requesterIp, expiresAt }

  const sweep = (now) => {
    for (const [k, p] of pairs) if (now >= p.expiresAt) pairs.delete(k)
  }

  return {
    start({ requesterIp = null } = {}) {
      const now = Date.now()
      sweep(now)
      if (pairs.size >= maxPending) return null
      let code
      do { code = randomCode() } while ([...pairs.values()].some((p) => p.code === code))
      const pollToken = crypto.randomBytes(32).toString('hex')
      pairs.set(pollToken, { code, userId: null, agentName: null, approved: false, requesterIp, expiresAt: now + ttlMs })
      return { pairCode: `${code.slice(0, 4)}-${code.slice(4)}`, pollToken, expiresIn: Math.floor(ttlMs / 1000) }
    },
    // Read-only look at a pending pair so the approval screen can show who
    // is asking (spec's security analysis: code + requester IP) before the
    // user commits. Unknown, expired, and already-approved all collapse to
    // null — an approved pair can't be approved again, so previewing it
    // serves no purpose and null keeps the surface minimal.
    preview(codeInput) {
      const now = Date.now()
      const code = normalizeCode(codeInput)
      for (const p of pairs.values()) {
        if (p.code !== code) continue
        if (now >= p.expiresAt || p.approved) break
        return { requesterIp: p.requesterIp, expiresIn: Math.ceil((p.expiresAt - now) / 1000) }
      }
      return null
    },
    approve(codeInput, { userId, agentName }) {
      const now = Date.now()
      const code = normalizeCode(codeInput)
      for (const p of pairs.values()) {
        if (p.code !== code) continue
        if (now >= p.expiresAt) break // expired is indistinguishable from unknown
        if (p.approved) return 'conflict'
        p.approved = true
        p.userId = userId
        p.agentName = agentName
        return 'approved'
      }
      return 'not_found'
    },
    claim(pollToken) {
      const p = pairs.get(pollToken)
      if (!p || Date.now() >= p.expiresAt) {
        if (p) pairs.delete(pollToken)
        return { status: 'not_found' }
      }
      if (!p.approved) return { status: 'pending' }
      pairs.delete(pollToken) // one-shot: the pair is gone before the caller sees the identity
      return { status: 'approved', userId: p.userId, agentName: p.agentName }
    },
    size() { return pairs.size },
  }
}
