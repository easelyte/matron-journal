import fs from 'node:fs'

// GET /metrics response builder. Scoping rule (see the brief's self-review
// note): the `user` section carries ONLY the calling device's own user's
// data (head seq, per-device cursor lag/kind/last_seen_at) — never another
// user's devices or username. `sockets_connected`, `journal_row_count`,
// `db_file_size_bytes` and `push` are global aggregates (bare numbers/
// counters, no identity attached), safe to return to any authenticated
// caller regardless of whose device asked.
export function buildMetrics(db, { hub, pushPipeline, dbPath, userId }) {
  const head = db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(userId)
  const headSeq = head ? head.seq : 0
  const devices = db.prepare(
    'SELECT id AS device_id, kind, cursor, last_seen_at FROM devices WHERE user_id=? ORDER BY id'
  ).all(userId).map((d) => ({ ...d, lag: headSeq - d.cursor }))

  const journalRowCount = db.prepare('SELECT COUNT(*) n FROM events').get().n
  const socketsConnected = hub && typeof hub.totalConnections === 'function' ? hub.totalConnections() : 0

  let dbFileSizeBytes = 0
  try {
    if (dbPath && dbPath !== ':memory:') dbFileSizeBytes = fs.statSync(dbPath).size
  } catch { /* file missing/unreadable — report 0 rather than fail the whole endpoint */ }

  // Task 3's pipeline always exposes {sent,failed,pruned,byReason}, but the
  // brief calls out that server.js may wire the disabled no-op instead —
  // this must not throw either way.
  const counters = (pushPipeline && pushPipeline.counters) || { sent: 0, failed: 0, pruned: 0, byReason: {} }

  return {
    user: { head_seq: headSeq, devices },
    sockets_connected: socketsConnected,
    journal_row_count: journalRowCount,
    db_file_size_bytes: dbFileSizeBytes,
    push: { sent: counters.sent, failed: counters.failed, pruned: counters.pruned, by_reason: counters.byReason },
  }
}
