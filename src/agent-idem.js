import { append } from './journal.js'

export const AGENT_IDEM_TTL_MS = 120_000

// Durable, bounded idempotency for peer_message writes. This deliberately does
// not use events.idem_key: that column's UNIQUE index is permanent, while an
// identical coordination line is a legitimate new send after this window.
//
// The outer transaction contains the live-row lookup, append(), and dedup-row
// insert. append()'s nested better-sqlite3 transaction becomes a savepoint, so
// an exception before the dedup insert completes still rolls the event back
// with the outer transaction.
export function appendAgentIdempotent(db, { deviceId, key, appendArgs, now = Date.now() }) {
  return db.transaction(() => {
    // Sweeping before the lookup both bounds the durable table and makes an
    // expired key immediately available for a deliberate resend.
    db.prepare('DELETE FROM agent_idem WHERE expires_at<=?').run(now)
    const prior = db.prepare(
      'SELECT seq FROM agent_idem WHERE key=? AND device_id=? AND expires_at>?'
    ).get(key, deviceId, now)
    if (prior) return { seq: prior.seq, duplicate: true }

    // Never populate idx_events_idem for this path: its lifetime is permanent.
    const result = append(db, { ...appendArgs, idemKey: null })
    db.prepare(
      'INSERT INTO agent_idem(key, device_id, seq, expires_at) VALUES(?,?,?,?)'
    ).run(key, deviceId, result.seq, now + AGENT_IDEM_TTL_MS)
    return result
  })()
}
