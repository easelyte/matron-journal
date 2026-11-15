// Coordinator session control: the user's Coordinator asks the journal to have
// another session's bridge switch its model or backend, compact it, or tell
// it to carry on. The journal is the relay only — it validates, checks the
// caller IS the Coordinator (the one route the role gates), resolves the
// target to its box, wakes it if asleep, issues a journal-originated RPC and
// hands the reply back. Nothing is journaled here; the target bridge writes
// the visible record into the session's own chat. (A carry-on is recorded
// for the consent guard, src/cause-hops.js, but that writes no event.)
import { sanitizePeerText } from './peer-text.js'
import { getCoordinatorConvoId } from './coordinator.js'
import { isPrivateDevice } from './db.js'
import { causesFromFrame } from './ask-causes.js'
import { resolveAskCause } from './ask-cause.js'
import { isProtectedDevice } from './consent-subject.js'
import { userOnlyDevice } from './consent.js'
import { panicLock } from './panic.js'

export const SESSION_CONTROL_ACTIONS = new Set(['set_model', 'compact', 'carry_on'])
export const SESSION_CONTROL_AGENTS = new Set(['claude', 'codex'])
export const SESSION_CONTROL_WHEN = new Set(['now', 'after_limit_reset'])
export const SESSION_CONTROL_MODEL_MAX = 64
// A reasoning effort level ('high'): the target bridge's vocabulary (Claude
// --effort levels, or the Codex model's own), so bounded, not allowlisted.
export const SESSION_CONTROL_EFFORT_MAX = 16
export const SESSION_CONTROL_MESSAGE_MAX = 2000
export const SESSION_CONTROL_REASON_MAX = 200
// How old the user's message, item comment or tap may be when a carry-on
// to a user-only box rests on it (see carryOnUserOnlyRefused below).
export const CARRY_ON_USER_ONLY_WINDOW_MS = 10 * 60 * 1000
// What the Coordinator is told with a user_only refusal. Fixed text: nothing
// of the request is echoed in it.
export const WHY_CARRY_ON_USER_ONLY = 'a carry-on to a user-only box needs the user\'s own message or tap in the turn that sends it'
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

// Shape check only (no DB). Returns {ok, rid, params, causes} — params is
// what the target bridge receives, minus from_convo_id/from_name (and a
// carry-on's carry_on_id) which the op stamps — or {code, detail}. `rid` is
// set whenever request_id was usable so every later error can carry it.
// `causes` (carry_on only) are the Coordinator turn's, as on a spawn
// request: never relayed, kept on the carry-on's record
// (src/cause-hops.js); null when it sent none.
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
      const effort = peerStr(msg.effort, SESSION_CONTROL_EFFORT_MAX, 'effort')
      if (effort) params.effort = effort
      if (msg.agent != null) {
        if (!SESSION_CONTROL_AGENTS.has(msg.agent)) return { rid, code: 'bad_request', detail: 'bad agent' }
        params.agent = msg.agent
      }
      if (!params.model && !params.agent && !params.effort) return { rid, code: 'bad_request', detail: 'set_model needs model, agent or effort' }
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
    const frame = msg.action === 'carry_on' ? causesFromFrame(msg) : { ok: true, causes: null }
    if (!frame.ok) return { rid, code: 'bad_request', detail: 'bad causes' }
    const reason = peerStr(msg.reason, SESSION_CONTROL_REASON_MAX, 'reason')
    if (reason) params.reason = reason
    return { ok: true, rid, params, causes: frame.causes }
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
//   - a protected box (src/consent-subject.js) is out of the Coordinator's
//     reach, whether or not the account has an approval key: forbidden /
//     protected_device.
//   - a carry-on into a session on a user-only box (src/consent.js), unless
//     the turn that sent it was the user's own: forbidden / user_only, with
//     a fixed why. See carryOnUserOnlyRefused below.
//   - an account under a panic lock (src/panic.js): forbidden /
//     account_locked, with since.
// `causes` are the request's, as validateSessionControl returned them, and
// `now` the time the request arrived.
export function authorizeSessionControl(db, conn, msg, { causes = null, now = Date.now() } = {}) {
  const from = db.prepare('SELECT owner_user_id, agent_device_id, parent_convo_id FROM conversations WHERE id=?').get(msg.from_convo_id)
  if (!from || from.owner_user_id !== conn.userId || from.agent_device_id !== conn.deviceId || from.parent_convo_id != null) return { code: 'not_found' }
  if (getCoordinatorConvoId(db, conn.userId) !== msg.from_convo_id) return { code: 'forbidden', detail: 'not_coordinator' }
  const tgt = db.prepare('SELECT owner_user_id, agent_device_id, parent_convo_id FROM conversations WHERE id=?').get(msg.target_convo_id)
  if (!tgt || tgt.owner_user_id !== conn.userId || tgt.parent_convo_id != null || tgt.agent_device_id == null) return { code: 'not_found' }
  if (isPrivateDevice(db, tgt.agent_device_id) && !isPrivateDevice(db, conn.deviceId)) return { code: 'not_found' }
  const dev = db.prepare("SELECT id AS device_id, name FROM devices WHERE id=? AND user_id=? AND kind='agent'").get(tgt.agent_device_id, conn.userId)
  if (!dev) return { code: 'not_found' }
  if (isProtectedDevice(db, conn.userId, dev.device_id)) return { code: 'forbidden', detail: 'protected_device' }
  if (carryOnUserOnlyRefused(db, conn, { deviceId: dev.device_id, action: msg.action, fromConvoId: msg.from_convo_id, causes, at: now })) {
    return { code: 'forbidden', detail: 'user_only', why: WHY_CARRY_ON_USER_ONLY }
  }
  // A panic-locked account (src/panic.js): no box of it gets new work.
  const lock = panicLock(db, conn.userId)
  if (lock) return { code: 'forbidden', detail: 'account_locked', since: lock.since }
  return { target: dev }
}

// A user-only box (devices.consent_user_only) takes new work only on the
// user's own say. A carry-on's message becomes a turn in the target session,
// now or after a limit reset, so it is held to that rule: the Coordinator
// cannot send one there on its own. set_model and compact stay allowed: the
// journal relays no turn text for them, only a model, agent and effort name
// (short, sanitised settings) and the optional reason, which the target
// bridge shows as a notice in the session's chat.
export function sessionControlUserOnly(db, userId, deviceId, action) {
  return action === 'carry_on' && userOnlyDevice(db, userId, deviceId)
}

// The user's own say can come through the Coordinator: a carry-on goes to a
// user-only box when the Coordinator turn that sent it was started by the
// user. The request's causes (the turn's, stamped by the bridge and so peer
// data) must resolve, by the journal's own record (src/ask-cause.js), to a
// message the user typed or spoke in the Coordinator's conversation, or to
// a comment or tap of theirs on an item that conversation owns, and that
// event must be at most CARRY_ON_USER_ONLY_WINDOW_MS older than `at`, the
// time the request arrived. Everything else is refused: no causes, a
// routine fire, a cause of a kind that cannot carry the user's authority
// beside the user's (a room message, a reminder, an alert, another
// carry-on), a user cause that does not check out or is in another
// conversation. A spawn outcome is refused here too, though the resolver
// would follow it to the ask behind it: the turn it starts is the
// outcome's, not the user's.
// → true when the carry-on must be refused (user_only).
export function carryOnUserOnlyRefused(db, conn, { deviceId, action, fromConvoId, causes, at }) {
  if (!sessionControlUserOnly(db, conn.userId, deviceId, action)) return false
  if (!Array.isArray(causes) || causes.some((c) => c.kind === 'spawn_outcome')) return true
  const who = { kind: conn.kind, userId: conn.userId, deviceId: conn.deviceId }
  const res = resolveAskCause(db, { who, userId: conn.userId, causes, createdAt: at, fromConvoId })
  if (!res.ok || (res.root.kind !== 'user' && res.root.kind !== 'item')) return true
  return !(res.root.at >= at - CARRY_ON_USER_ONLY_WINDOW_MS)
}

// The result frame relayed to the Coordinator's bridge, from the broker's
// settled reply. Error codes/details are bridge-originated peer text; `why`
// is the journal's own fixed text for a refusal it made itself.
export function sessionControlResultFrame(rid, r, why = null) {
  if (r.ok) return { kind: 'session_control', event: 'result', request_id: rid, ok: true, result: r.result ?? null }
  const code = sanitizePeerText(String(r.error?.code || 'unknown'), 64) || 'unknown'
  const detail = r.error?.detail != null ? sanitizePeerText(String(r.error.detail), 300) : ''
  return { kind: 'session_control', event: 'result', request_id: rid, ok: false, error: { code, ...(detail ? { detail } : {}), ...(why ? { why } : {}) } }
}
