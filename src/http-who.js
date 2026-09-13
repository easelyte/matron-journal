// The caller-shaped helpers every /items and /missions route needs: the
// `Idempotency-Key` header rule, the sender string, and the three responder
// shortcuts. Extracted from items-http.js and missions-http.js (final
// review minor), which carried byte-identical copies — the same reason
// privacy.js exists: one copy is the only way two surfaces cannot drift.
import { json } from './http-body.js'

export const IDEM_KEY_MAX = 128

// null = header absent, undefined = header present but unusable (→ 400).
// Never silently ignored: a client that believes its retry is being deduped
// would otherwise create a second row and never know.
export const idemKeyOf = (req, who) => {
  const k = req.headers['idempotency-key']
  if (k === undefined) return null
  if (typeof k !== 'string' || !k || k.length > IDEM_KEY_MAX) return undefined
  // Scoped to the calling device: two devices replaying the same key are two
  // different intents, and a key is only unique per (user_id, idem_key).
  return `${who.deviceId}:${k}`
}

export function senderOf(db, who) {
  if (who.kind === 'agent') return `agent:${who.name}`
  const row = db.prepare('SELECT name FROM users WHERE id=?').get(who.userId)
  // The `user:` prefix is load-bearing (push.js's own-event rule, journal.js's
  // unread predicate), so it survives even the impossible missing-row case.
  return `user:${row ? row.name : who.userId}`
}

export const badRequest = (res) => { json(res, 400, { error: 'bad_request' }); return true }
export const notFound = (res) => { json(res, 404, { error: 'not_found' }); return true }
// `extra` carries the missions routes' `blocked_by` (and its item list); an
// items caller passes nothing and gets the bare shape it always had.
export const conflict = (res, extra = {}) => { json(res, 409, { error: 'conflict', ...extra }); return true }
