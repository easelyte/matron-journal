import fs from 'node:fs'
import { isPrivateDevice } from './db.js'

// GET /metrics response builder. Scoping rule (see the brief's self-review
// note): the `user` section carries ONLY the calling device's own user's
// data (head seq, per-device cursor lag/kind/last_seen_at) — never another
// user's devices or username. `sockets_connected`, `journal_row_count`,
// `db_file_size_bytes` and `push` are global aggregates (bare numbers/
// counters, no identity attached), safe to return to any authenticated
// caller regardless of whose device asked.
export function buildMetrics(db, { hub, pushPipeline, dbPath, userId, excludePrivateDevices = false, summariser = null }) {
  const head = db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(userId)
  const headSeq = head ? head.seq : 0
  // Privacy filter (spec: agent visibility & privacy), same one-caller-rule
  // predicate /roster and /search apply — an ORDINARY agent caller's device
  // list must not enumerate private devices (id, kind, cursor, last_seen_at
  // is enough to identify and fingerprint activity on a device the caller
  // has no business seeing at all). Clients and private-agent callers pass
  // `excludePrivateDevices: false` and get the unfiltered list, unchanged.
  const devices = db.prepare(
    `SELECT id AS device_id, kind, cursor, last_seen_at FROM devices WHERE user_id=?${excludePrivateDevices ? ' AND private=0' : ''} ORDER BY id`
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

  // POST /summarise usage (src/summarise.js): global totals like `push`,
  // plus per-device spend for the caller's own user's devices only, with
  // private devices dropped for a filtered caller exactly as `devices` is.
  const summarise = summariser
    ? summariser.metrics(userId, (id) => !excludePrivateDevices || !isPrivateDevice(db, id))
    : { enabled: false, model: null, requests: 0, outcomes: {}, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, devices: [] }

  return {
    user: { head_seq: headSeq, devices },
    sockets_connected: socketsConnected,
    journal_row_count: journalRowCount,
    db_file_size_bytes: dbFileSizeBytes,
    push: { sent: counters.sent, failed: counters.failed, pruned: counters.pruned, by_reason: counters.byReason },
    summarise,
  }
}
