// The persisted subset of a bridge's `status` op (spec 2026-09-29
// coordinator session control §1, in matron-bridge
// docs/superpowers/specs/2026-09-29-coordinator-session-control-design.md).
// The op itself stays opaque and in-memory for header replay (ws.js
// statusCache); this module keeps only what the roster and mission views
// need — model, context gauge, usage-limit stall, account meters —
// validated block by block so one malformed block never costs the others,
// and unknown keys (effort, workdir, email, vitals, model_options…) are
// never written.
import { sanitizeSpawnLimits } from './spawns.js'
import { sanitizePeerText } from './peer-text.js'

const MODEL_CAP = 64
const STALL_KINDS = new Set(['usage_limit'])
const ISO_CAP = 40
const MS_MAX = 4102444800000 // 2100-01-01

const nonNegInt = (n) => Number.isInteger(n) && n >= 0
// Bridge-originated strings are peer text: length-capped, then sanitised
// like every other persisted peer string (control characters stripped,
// whitespace-only rejected) — the bridge renders this block into agent
// prompts. Returns the clean string or null.
function peerStr(s, cap) {
  if (typeof s !== 'string' || !s || s.length > cap) return null
  return sanitizePeerText(s, cap) || null
}

function sanitizeContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { tokens, window, pct } = raw
  if (!nonNegInt(tokens) || !Number.isInteger(window) || window <= 0) return null
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) return null
  return { tokens, window, pct }
}

function sanitizeStall(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!STALL_KINDS.has(raw.kind)) return null
  const out = { kind: raw.kind }
  if (raw.model !== undefined) { const m = peerStr(raw.model, MODEL_CAP); if (!m) return null; out.model = m }
  if (raw.resets_at !== undefined) { const r = peerStr(raw.resets_at, ISO_CAP); if (!r) return null; out.resets_at = r }
  if (raw.since !== undefined) { if (!nonNegInt(raw.since) || raw.since > MS_MAX) return null; out.since = raw.since }
  return out
}

// A bridge frame's `limits` is the bare lines array (buildSessionStatus);
// sanitizeSpawnLimits speaks the {as_of, lines} block spawn_targets uses,
// so wrap it with the report time (`reportedAt`, the caller's clock — the
// same instant the row's reported_at is stamped with). Current bridges give
// every line a machine `id` (lib/usage-limits.js deriveLimitId, Codex's
// `codex:…`); a line that only carries a label — older bridges, and the
// status fixtures in this repo — gets one derived from its label rather
// than costing the whole block.
function withLineIds(lines) {
  if (!Array.isArray(lines)) return null
  return lines.map((l) => (l && typeof l === 'object' && l.id === undefined && typeof l.label === 'string'
    ? { ...l, id: l.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'other' }
    : l))
}

export function sanitizeConvoStatus(raw, reportedAt = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  const model = peerStr(raw.model, MODEL_CAP)
  if (model) out.model = model
  const context = sanitizeContext(raw.context)
  if (context) out.context = context
  const stall = sanitizeStall(raw.stall)
  if (stall) out.stall = stall
  const limits = Array.isArray(raw.limits) ? sanitizeSpawnLimits({ as_of: reportedAt, lines: withLineIds(raw.limits) }) : null
  if (limits) out.limits = limits
  return Object.keys(out).length ? out : null
}

// Latest wins, with one exception: a frame that OMITS `context` or `limits`
// keeps the stored ones. A bridge publishes a header at spawn and resume
// before any turn has run (model and meters, no gauge — index.js
// journalSpawnStatus), and a print-mode /model recreate does the same; a
// plain replacement would wipe the gauge this table exists to keep across
// exactly those events. `model` is always sent, and `stall` is deliberately
// replace-semantics: the bridge clears it by omitting it, so an omitted
// stall means "not stalled". Read-then-write is atomic (better-sqlite3 is
// synchronous; nothing yields between the two statements).
export function upsertConvoStatus(db, { userId, convoId, status, reportedAt = Date.now() }) {
  const prev = db.prepare('SELECT status FROM conversation_status WHERE convo_id=? AND user_id=?').get(convoId, userId)
  let merged = status
  if (prev) {
    try {
      const old = JSON.parse(prev.status)
      merged = {
        ...(old.context && !status.context ? { context: old.context } : {}),
        ...(old.limits && !status.limits ? { limits: old.limits } : {}),
        ...status,
      }
    } catch { /* unreadable row: replace it */ }
  }
  db.prepare(
    `INSERT INTO conversation_status(convo_id, user_id, reported_at, status) VALUES (?,?,?,?)
     ON CONFLICT(convo_id) DO UPDATE SET user_id=excluded.user_id, reported_at=excluded.reported_at, status=excluded.status`
  ).run(convoId, userId, reportedAt, JSON.stringify(merged))
}

function parseRow(r) {
  try { return { reported_at: r.reported_at, ...JSON.parse(r.status) } } catch { return null }
}

export function convoStatuses(db, userId) {
  const out = new Map()
  for (const r of db.prepare('SELECT convo_id, reported_at, status FROM conversation_status WHERE user_id=?').all(userId)) {
    const parsed = parseRow(r)
    if (parsed) out.set(r.convo_id, parsed)
  }
  return out
}

// User-scoped like getDeviceStatus, so a future route cannot pick it up
// unscoped.
export function convoStatus(db, userId, convoId) {
  const r = db.prepare('SELECT reported_at, status FROM conversation_status WHERE user_id=? AND convo_id=?').get(userId, convoId)
  return r ? parseRow(r) : null
}
