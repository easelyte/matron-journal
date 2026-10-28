// The causes of an ask: what, in the asking session's turn, led it to ask
// for a spawn or a chat room — the user's message, a reply or tap on an
// item, a routine firing, a peer's room message, and so on. The bridge
// stamps them on spawn_request / agent_invite / agent_join from the turn
// it is running; the journal stores them on the parked row and shows them
// on GET /consent/pending, so whoever answers the ask can see why it was
// made (and, later, check that claim against the journal's own record).
//
// Peer data like every other field on those frames: the asking bridge
// writes it, so it is bounded and sieved here, at the ws boundary. Strict
// on shape — one entry of a kind this journal does not know makes the
// whole list unusable rather than silently shorter, because a list with a
// cause quietly dropped would read as a complete account of the turn.
// Lenient only on `at`, a timestamp that is a hint, not a claim: an entry
// with an unusable one keeps its kind and ref and loses the time.
import { sanitizePeerText } from './peer-text.js'

export const CAUSE_KINDS = ['user_message', 'item_reply', 'item_tap', 'routine', 'spawn_outcome', 'room_message', 'reminder', 'carry_on', 'alert', 'handoff', 'other']
export const CAUSES_MAX = 8
export const CAUSE_REF_MAX = 200

const KINDS = new Set(CAUSE_KINDS)

// A clean list of {kind, ref?, at?}, or null for anything unusable: not an
// array, an empty one, more than CAUSES_MAX entries, an entry that is not
// an object of a known kind, a ref that is not a string or is over
// CAUSE_REF_MAX. Never an empty array — "no causes" is null everywhere, so
// a caller tests one value. It cannot tell an absent field from a bad one;
// the ws boundary uses causesFromFrame below for that.
export function normalizeCauses(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > CAUSES_MAX) return null
  const out = []
  for (const entry of raw) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return null
    if (typeof entry.kind !== 'string' || !KINDS.has(entry.kind)) return null
    const cause = { kind: entry.kind }
    if (entry.ref != null) {
      if (typeof entry.ref !== 'string' || entry.ref.length > CAUSE_REF_MAX) return null
      const ref = sanitizePeerText(entry.ref, CAUSE_REF_MAX)
      if (ref) cause.ref = ref
    }
    if (Number.isSafeInteger(entry.at) && entry.at >= 0) cause.at = entry.at
    out.push(cause)
  }
  return out
}

// The causes on a spawn_request / agent_invite / agent_join frame. Absent
// or null is a frame with no causes — a bridge that predates the field, or
// one with nothing to say — and stores NULL. Any other value is a claim
// about the turn, so it must normalise or the ask is refused: { ok: false }.
export function causesFromFrame(msg) {
  if (msg.causes == null) return { ok: true, causes: null }
  const causes = normalizeCauses(msg.causes)
  return causes ? { ok: true, causes } : { ok: false }
}

// The stored column back as a list, or null for NULL. Re-normalised rather
// than trusted: the column is only ever written from normalizeCauses, but a
// reader handing it on should not depend on that staying true.
export function parseCauses(text) {
  if (typeof text !== 'string' || !text) return null
  try {
    return normalizeCauses(JSON.parse(text))
  } catch {
    return null
  }
}
