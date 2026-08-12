import crypto from 'node:crypto'
import { randomChars } from './pairing.js'

// In-memory rendezvous store (spec §1: link rendezvous). Lives in the relay
// process. Holds at most one opaque, app-encrypted offer box per entry for
// ≤ ttlMs — never a token, never a server URL, never a link code. The relay
// cannot read or forge the box: the offer key lives only in the QR and the
// two legitimate devices (rendezvous-offer-encryption spec).
//
// Keyed by rid (~128 bits from the pairing alphabet — unguessable, no
// lookalike glyphs, safe to show in a QR). The creator's poll is gated by a
// separate 256-bit secret so a bystander photographing the QR (which
// carries only the rid) cannot read the box back.
export function makeRendezvousStore({ ttlMs = 180000, maxPending = 256 } = {}) {
  const entries = new Map() // rid -> { secret, box, expiresAt }

  const sweep = (now = Date.now()) => {
    for (const [k, e] of entries) if (now >= e.expiresAt) entries.delete(k)
  }

  return {
    create() {
      const now = Date.now()
      sweep(now)
      if (entries.size >= maxPending) return null
      const rid = randomChars(26) // ~128 bits: collisions are not a real event
      const secret = crypto.randomBytes(32).toString('hex')
      entries.set(rid, { secret, box: null, expiresAt: now + ttlMs })
      return { rid, secret, expiresIn: Math.floor(ttlMs / 1000) }
    },
    offer(rid, box) {
      const e = entries.get(rid)
      if (!e || Date.now() >= e.expiresAt) {
        if (e) entries.delete(rid)
        return 'not_found'
      }
      // First box wins — a conflict never overwrites (the desktop may
      // already be acting on the first box).
      if (e.box !== null) return 'conflict'
      e.box = box
      return 'offered'
    },
    poll(rid, secret) {
      const e = entries.get(rid)
      if (!e || Date.now() >= e.expiresAt) {
        if (e) entries.delete(rid)
        return { status: 'not_found' }
      }
      if (!secretMatches(e.secret, secret)) return { status: 'forbidden' }
      if (e.box === null) return { status: 'waiting' }
      // NOT one-shot: the entry survives until TTL so a dropped poll
      // response can be retried. The box is opaque ciphertext and still
      // requires the phone's approve tap once decrypted and claimed.
      return { status: 'offered', box: e.box }
    },
    sweep,
    size() { return entries.size },
  }
}

// Constant-time compare. The length check leaks only the secret's length,
// which is public (always 64 hex chars).
function secretMatches(expected, given) {
  const a = Buffer.from(String(expected))
  const b = Buffer.from(String(given))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
