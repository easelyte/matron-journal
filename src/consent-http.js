// HTTP surface of Coordinator consent approval (spec: matron-bridge
// docs/superpowers/specs/2026-09-29-coordinator-consent-design.md):
//   GET  /consent/pending?convo_id=…   the parked asks, both kinds
//   POST /consent/answer {convo_id, kind, id, decision, reason}
// Agent connections only, and only when convo_id is a top-level
// conversation this device owns AND the user's Coordinator — the same gate
// session_control applies. Checks, in order (every failure is a bare error
// body): client → 403 forbidden; bad shape → 400; convo not this device's →
// 404; not the Coordinator → 403 not_coordinator; switch off → 403
// consent_disabled; then per answer: the ask must exist (404) and still be
// awaiting (409 conflict); a spawn approval into an offline, unwakeable box
// is 409 target_offline; approvals at the rolling 24 h cap are 409
// daily_cap (a cap of 0 is no cap). Nothing here can reach a tool
// permission prompt or a secret request — those never exist as journal asks.
import { json, readBody } from './http-body.js'
import { sanitizePeerText } from './peer-text.js'
import { getCoordinatorConvoId } from './coordinator.js'
import {
  CONSENT_REASON_MAX, CONSENT_DAILY_CAP_DEFAULT, CONSENT_DAILY_WINDOW_MS, CONSENT_KINDS, CONSENT_DECISIONS,
  getConsentEnabled, listPendingAsks, parseChatAskId, coordinatorApprovalsSince, deviceState,
} from './consent.js'
import { answerChatAsk, answerSpawnAsk } from './consent-answer.js'
import { getSpawn } from './spawns.js'

const forbidden = (res, detail) => { json(res, 403, { error: 'forbidden', ...(detail ? { detail } : {}) }); return true }

// Ownership and role, in that order so a caller who is not the
// Coordinator learns nothing beyond "not yours".
function coordinatorCaller(db, who, convoId) {
  if (typeof convoId !== 'string' || !convoId || convoId.length > 128) return { status: 400 }
  const convo = db.prepare('SELECT owner_user_id, agent_device_id, parent_convo_id FROM conversations WHERE id=?').get(convoId)
  if (!convo || convo.owner_user_id !== who.userId || convo.agent_device_id !== who.deviceId || convo.parent_convo_id != null) return { status: 404 }
  if (getCoordinatorConvoId(db, who.userId) !== convoId) return { status: 403, detail: 'not_coordinator' }
  if (!getConsentEnabled(db, who.userId)) return { status: 403, detail: 'consent_disabled' }
  return { ok: true }
}

function refuse(res, gate) {
  if (gate.status === 400) { json(res, 400, { error: 'bad_request' }); return true }
  if (gate.status === 404) { json(res, 404, { error: 'not_found' }); return true }
  return forbidden(res, gate.detail)
}

export async function handleConsentRoute(ctx, req, res, url, who) {
  if (url.pathname !== '/consent/pending' && url.pathname !== '/consent/answer') return false
  const { db, hub, waker } = ctx
  if (who.kind !== 'agent') return forbidden(res)
  if (req.method === 'GET' && url.pathname === '/consent/pending') {
    const gate = coordinatorCaller(db, who, url.searchParams.get('convo_id'))
    if (!gate.ok) return refuse(res, gate)
    json(res, 200, { pending: listPendingAsks({ db, hub, waker }, who.userId) })
    return true
  }
  if (req.method !== 'POST' || url.pathname !== '/consent/answer') return false
  const body = await readBody(req)
  const gate = coordinatorCaller(db, who, body.convo_id)
  if (!gate.ok) return refuse(res, gate)
  if (!CONSENT_KINDS.has(body.kind) || !CONSENT_DECISIONS.has(body.decision)) { json(res, 400, { error: 'bad_request' }); return true }
  if (typeof body.reason !== 'string' || body.reason.length > CONSENT_REASON_MAX) { json(res, 400, { error: 'bad_request' }); return true }
  const reason = sanitizePeerText(body.reason, CONSENT_REASON_MAX)
  if (!reason) { json(res, 400, { error: 'bad_request' }); return true }
  const decidedBy = { kind: 'coordinator', deviceId: who.deviceId, convoId: body.convo_id, reason }
  const cap = Number.isInteger(ctx.consentDailyCap) && ctx.consentDailyCap >= 0 ? ctx.consentDailyCap : CONSENT_DAILY_CAP_DEFAULT
  // The cap and the offline check come BEFORE any state changes, so a
  // refused answer leaves the ask exactly as it was — for the user.
  // cap 0 = unlimited (MATRON_COORDINATOR_CONSENT_DAILY_CAP=0).
  if (body.decision === 'approve' && cap > 0 && coordinatorApprovalsSince(db, who.userId, Date.now() - CONSENT_DAILY_WINDOW_MS) >= cap) {
    json(res, 409, { error: 'conflict', detail: 'daily_cap', cap }); return true
  }
  if (body.kind === 'spawn') {
    if (typeof body.id !== 'string' || !body.id || body.id.length > 128) { json(res, 400, { error: 'bad_request' }); return true }
    if (body.decision === 'approve') {
      const row = getSpawn(db, body.id)
      if (!row || row.user_id !== who.userId) { json(res, 404, { error: 'not_found' }); return true }
      if (row.state !== 'awaiting_user') { json(res, 409, { error: 'conflict' }); return true }
      if (deviceState({ db, hub, waker }, who.userId, row.target_device_id) === 'offline') {
        json(res, 409, { error: 'conflict', detail: 'target_offline' }); return true
      }
    }
    const r = answerSpawnAsk(ctx, { userId: who.userId, requestId: body.id, decision: body.decision, decidedBy })
    json(res, r.status, r.body); return true
  }
  const key = parseChatAskId(body.id)
  if (!key) { json(res, 400, { error: 'bad_request' }); return true }
  const r = answerChatAsk(ctx, { userId: who.userId, roomId: key.roomId, targetDeviceId: key.targetDeviceId, decision: body.decision, decidedBy })
  json(res, r.status, r.body)
  return true
}
