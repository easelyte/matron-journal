// Coordinator session control (spec: matron-bridge
// docs/superpowers/specs/2026-09-29-coordinator-session-control-design.md,
// "Decisions" section): the user's Coordinator asks the journal to have
// another session's bridge switch its model or backend, compact it, or tell
// it to carry on. The journal is the relay only — it validates, checks the
// caller IS the Coordinator (the one route the role gates), resolves the
// target to its box, wakes it if asleep, issues a journal-originated RPC and
// hands the reply back. Nothing is journaled here; the target bridge writes
// the visible record into the session's own chat.
import { sanitizePeerText } from './peer-text.js'
import { getCoordinatorConvoId } from './coordinator.js'
import { isPrivateDevice } from './db.js'

export const SESSION_CONTROL_ACTIONS = new Set(['set_model', 'compact', 'carry_on'])
export const SESSION_CONTROL_AGENTS = new Set(['claude', 'codex'])
export const SESSION_CONTROL_WHEN = new Set(['now', 'after_limit_reset'])
export const SESSION_CONTROL_MODEL_MAX = 64
export const SESSION_CONTROL_MESSAGE_MAX = 2000
export const SESSION_CONTROL_REASON_MAX = 200
const ID_MAX = 128

class BadParam extends Error {
  constructor(detail) { super(detail); this.code = 'bad_request'; this.detail = detail }
}

// Optional peer string: absent -> undefined; wrong type or over the cap ->
// bad_request; otherwise sanitised (control characters to spaces, trimmed),
// which may come back empty — the caller decides whether empty is allowed.
function peerStr(v, max, name) {
  if (v == null) return undefined
  if (typeof v !== 'string' || v.length > max) throw new BadParam(`bad ${name}`)
  return sanitizePeerText(v, max)
}

// Shape check only (no DB). Returns {ok, rid, params} — params is what the
// target bridge receives, minus from_convo_id/from_name which the op stamps —
// or {code, detail}. `rid` is set whenever request_id was usable so every
// later error can carry it.
export function validateSessionControl(msg) {
  const rid = msg?.request_id
  if (typeof rid !== 'string' || !rid || rid.length > ID_MAX) return { code: 'bad_request', detail: 'bad request_id' }
  try {
    if (!SESSION_CONTROL_ACTIONS.has(msg.action)) return { rid, code: 'bad_request', detail: 'bad action' }
    if (typeof msg.from_convo_id !== 'string' || !msg.from_convo_id || msg.from_convo_id.length > ID_MAX
      || typeof msg.target_convo_id !== 'string' || !msg.target_convo_id || msg.target_convo_id.length > ID_MAX) {
      return { rid, code: 'bad_request', detail: 'bad convo id' }
    }
    if (msg.target_convo_id === msg.from_convo_id) return { rid, code: 'bad_request', detail: 'target is the coordinator itself' }
    const params = { convo_id: msg.target_convo_id, action: msg.action }
    if (msg.action === 'set_model') {
      const model = peerStr(msg.model, SESSION_CONTROL_MODEL_MAX, 'model')
      if (model) params.model = model
      if (msg.agent != null) {
        if (!SESSION_CONTROL_AGENTS.has(msg.agent)) return { rid, code: 'bad_request', detail: 'bad agent' }
        params.agent = msg.agent
      }
      if (!params.model && !params.agent) return { rid, code: 'bad_request', detail: 'set_model needs model or agent' }
    }
    if (msg.action === 'carry_on') {
      const message = peerStr(msg.message, SESSION_CONTROL_MESSAGE_MAX, 'message')
      if (!message) return { rid, code: 'bad_request', detail: 'carry_on needs message' }
      params.message = message
      if (msg.when != null) {
        if (!SESSION_CONTROL_WHEN.has(msg.when)) return { rid, code: 'bad_request', detail: 'bad when' }
        params.when = msg.when
      }
    }
    const reason = peerStr(msg.reason, SESSION_CONTROL_REASON_MAX, 'reason')
    if (reason) params.reason = reason
    return { ok: true, rid, params }
  } catch (e) {
    if (e instanceof BadParam) return { rid, code: e.code, detail: e.detail }
    throw e
  }
}

// Ownership, role and target checks, in that order so a caller who is not
// the Coordinator learns nothing about the target. Returns {code, detail?}
// or {target: {device_id, name}}.
//   - from_convo_id must be a top-level conversation this device owns
//     (not_found otherwise, same stance as spawn_request) AND the user's
//     Coordinator (forbidden / not_coordinator).
//   - target_convo_id must exist, belong to the same user, be top-level,
//     have a box, and that box must not be a private device hidden from an
//     ordinary caller — all indistinguishable not_found (anti-enumeration).
export function authorizeSessionControl(db, conn, msg) {
  const from = db.prepare('SELECT owner_user_id, agent_device_id, parent_convo_id FROM conversations WHERE id=?').get(msg.from_convo_id)
  if (!from || from.owner_user_id !== conn.userId || from.agent_device_id !== conn.deviceId || from.parent_convo_id != null) return { code: 'not_found' }
  if (getCoordinatorConvoId(db, conn.userId) !== msg.from_convo_id) return { code: 'forbidden', detail: 'not_coordinator' }
  const tgt = db.prepare('SELECT owner_user_id, agent_device_id, parent_convo_id FROM conversations WHERE id=?').get(msg.target_convo_id)
  if (!tgt || tgt.owner_user_id !== conn.userId || tgt.parent_convo_id != null || tgt.agent_device_id == null) return { code: 'not_found' }
  if (isPrivateDevice(db, tgt.agent_device_id) && !isPrivateDevice(db, conn.deviceId)) return { code: 'not_found' }
  const dev = db.prepare("SELECT id AS device_id, name FROM devices WHERE id=? AND user_id=? AND kind='agent'").get(tgt.agent_device_id, conn.userId)
  if (!dev) return { code: 'not_found' }
  return { target: dev }
}

// The result frame relayed to the Coordinator's bridge, from the broker's
// settled reply. Error codes/details are bridge-originated peer text.
export function sessionControlResultFrame(rid, r) {
  if (r.ok) return { kind: 'session_control', event: 'result', request_id: rid, ok: true, result: r.result ?? null }
  const code = sanitizePeerText(String(r.error?.code || 'unknown'), 64) || 'unknown'
  const detail = r.error?.detail != null ? sanitizePeerText(String(r.error.detail), 300) : ''
  return { kind: 'session_control', event: 'result', request_id: rid, ok: false, error: { code, ...(detail ? { detail } : {}) } }
}
