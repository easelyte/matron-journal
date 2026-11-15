// Protected boxes and signed consent (approval keys, src/approval-keys.js).
// A device the user marked `protected` (devices.protected) is a box whose
// consent asks — a spawn onto it, a chat invite to it, a file sent to it, a
// client's direct `start` on it — need the user's approval key once the
// account has one. `protected` implies the user-only consent flag
// (src/consent.js userOnlyDevice): the Coordinator never approves such an
// ask. For an account with no active key that is all it does.
//
// The statement a client signs for such an ask is `type: "consent"` (for a
// direct `start`, `type: "account"`) over the subject built here. The
// journal publishes the subject on the ask (GET /consent/pending, the
// consent item's `subject`), checks the signature against it when the
// answer comes, and forwards the statement and signature unchanged to the
// box, whose own check (against its pinned keys) is the gate.
//
// The subject is a flat object of strings, at most 12 keys of at most 200
// characters each (src/approvals.js validSubject). A value that can be
// longer — a box name, a working directory, an ask id — is replaced
// (boundedSubject, src/approval-keys.js), when it is over 200 characters,
// by the lowercase hex SHA-256 of its UTF-8 bytes under the key
// `<name>_sha256` (so a 300-character workdir is
// `workdir_sha256`, never a truncated `workdir`). Texts are always hashed:
// `task_sha256` (the spawn's task), `message_sha256` (a chat ask's opening
// message, its justification), `prompt_sha256` (a direct start's prompt);
// `file_sha256` is the transfer's own content hash. `decision` is always
// "approve": a decline never needs a signature.
import { hasActiveKey, requireApproval, boundedSubject, sha256Hex } from './approval-keys.js'
import { transferRecipients } from './transfers.js'

// The subject for one ask. `ask` per kind:
//   spawn:    {id, box, workdir, task}
//   chat:     {room_id, device_id, box, message}  (device_id: the row's key,
//             the invitee or, for a join request, the joiner)
//   transfer: {id, box, sha256, size}
//   start:    {box, workdir, prompt}
export function consentSubject(kind, ask) {
  switch (kind) {
    case 'spawn':
      return boundedSubject({ op: 'spawn', ask: ask.id, box: ask.box, workdir: ask.workdir, task_sha256: sha256Hex(ask.task), decision: 'approve' })
    case 'chat':
      return boundedSubject({ op: 'chat', ask: `${ask.room_id}/${ask.device_id}`, box: ask.box, message_sha256: sha256Hex(ask.message), decision: 'approve' })
    case 'transfer':
      return boundedSubject({ op: 'transfer', ask: ask.id, box: ask.box, file_sha256: ask.sha256, size: String(ask.size), decision: 'approve' })
    case 'start':
      return boundedSubject({ op: 'start', box: ask.box, workdir: ask.workdir, prompt_sha256: sha256Hex(ask.prompt) })
    default:
      throw new TypeError(`no consent subject for ${kind}`)
  }
}

export function isProtectedDevice(db, userId, deviceId) {
  if (!Number.isInteger(deviceId)) return false
  return !!db.prepare('SELECT 1 FROM devices WHERE id=? AND user_id=? AND protected=1').get(deviceId, userId)
}

const deviceName = (db, userId, deviceId) => db.prepare('SELECT name FROM devices WHERE id=? AND user_id=?').get(deviceId, userId)?.name ?? ''

// A chat ask's row with what the subject needs: the box the invite goes to
// (the invitee, or the room's owner for a join request) and the message.
export function chatAskRow(db, userId, roomId, targetDeviceId) {
  return db.prepare(`
    SELECT ca.convo_id, ca.agent_device_id, ca.initiator_device_id, ca.justification, ca.state, c.agent_device_id AS room_owner_id
    FROM convo_agents ca JOIN conversations c ON c.id = ca.convo_id
    WHERE ca.convo_id=? AND ca.agent_device_id=? AND c.owner_user_id=?
  `).get(roomId, targetDeviceId, userId) ?? null
}

// The boxes an ask is aimed at: the spawn's target, the box a chat invite
// is delivered to, every box a transfer goes to. The signature requirement
// follows these; the user-only rule (src/consent.js) also counts the asker.
export function consentTargets(db, kind, row) {
  if (kind === 'spawn') return [row.target_device_id]
  if (kind === 'chat') return [row.initiator_device_id === row.agent_device_id ? row.room_owner_id : row.agent_device_id]
  if (kind === 'transfer') return transferRecipients(db, row)
  return []
}

// The subject of an ask from its row (a spawn row, chatAskRow, a transfer
// row). A transfer to several boxes (a row from before the one-recipient
// rule) names them all, comma-separated, in device id order.
export function consentAskSubject(db, userId, kind, row) {
  const boxes = consentTargets(db, kind, row).map((d) => deviceName(db, userId, d)).join(', ')
  if (kind === 'spawn') return consentSubject('spawn', { id: row.id, box: boxes, workdir: row.workdir, task: row.task })
  if (kind === 'chat') return consentSubject('chat', { room_id: row.convo_id, device_id: row.agent_device_id, box: boxes, message: row.justification })
  return consentSubject('transfer', { id: row.id, box: boxes, sha256: row.sha256, size: row.size })
}

export function targetsProtected(db, userId, kind, row) {
  return consentTargets(db, kind, row).some((d) => isProtectedDevice(db, userId, d))
}

// What a reader is told about an ask: {step_up: true, subject} when it is
// aimed at a protected box and the account has an active key, else null.
export function consentStepUp(db, userId, kind, row) {
  if (!row || !targetsProtected(db, userId, kind, row) || !hasActiveKey(db, userId)) return null
  return { step_up: true, subject: consentAskSubject(db, userId, kind, row) }
}

// The check on an approval of an ask, run by the answer path inside the
// transaction that applies it. `decidedBy` is the answer's: only the user's
// tap may approve an ask aimed at a protected box (the Coordinator's route
// refuses it earlier, as user-only; this is the backstop). An ask aimed at
// no protected box, and every ask of an account with no active key, is
// today's: {ok:true, approval:null}, and any `approval` sent is ignored.
// Otherwise requireApproval with the ask's subject: {ok:true, approval}
// ({statement, signature} as received) or {ok:false, status, body}.
export function consentApproval(ctx, userId, decidedBy, kind, row, approval) {
  const { db } = ctx
  if (!targetsProtected(db, userId, kind, row)) return { ok: true, approval: null }
  if (decidedBy?.kind !== 'user') return { ok: false, status: 403, body: { error: 'forbidden', detail: 'user_only' } }
  return requireApproval({ db, journalHost: ctx.journalHost ?? null }, { userId, deviceId: decidedBy.deviceId }, { approval }, {
    type: 'consent', subject: consentAskSubject(db, userId, kind, row),
  })
}

// The stored approval as the wire field: {approval: {statement, signature}}
// or nothing.
export function storedApproval(text) {
  if (text == null) return {}
  try {
    const a = JSON.parse(text)
    return typeof a?.statement === 'string' && typeof a?.signature === 'string' ? { approval: { statement: a.statement, signature: a.signature } } : {}
  } catch {
    return {}
  }
}

// What to store on the ask's row for forwarding: the JSON of
// {statement, signature}, or null.
export const approvalColumn = (approval) => (approval == null ? null : JSON.stringify({ statement: approval.statement, signature: approval.signature }))

// Set every open consent item's step_up and subject from its ask as it
// stands now — after a box is protected or unprotected or renamed, or the
// account's first key is added or its last removed. A changed item's
// updated_at moves too, so an app reading `GET /items?since=` sees what it
// must now sign; the caller announces each with an `updated` marker
// (approval-keys-http.js announceRestamped). → the ids of the items that
// changed.
export function restampConsentItems(db, userId, now = Date.now()) {
  const changed = []
  const stamp = (itemId, kind, row) => {
    if (!itemId) return
    const su = consentStepUp(db, userId, kind, row)
    const subject = su ? JSON.stringify(su.subject) : null
    const r = db.prepare("UPDATE items SET step_up=?, subject=?, updated_at=? WHERE id=? AND user_id=? AND state='open' AND (step_up IS NOT ? OR subject IS NOT ?)")
      .run(su ? 1 : 0, subject, now, itemId, userId, su ? 1 : 0, subject)
    if (r.changes) changed.push(itemId)
  }
  for (const row of db.prepare("SELECT * FROM agent_spawn_requests WHERE user_id=? AND state='awaiting_user' AND item_id IS NOT NULL").all(userId)) stamp(row.item_id, 'spawn', row)
  for (const r of db.prepare(`SELECT ca.convo_id, ca.agent_device_id, ca.item_id FROM convo_agents ca JOIN conversations c ON c.id = ca.convo_id
    WHERE c.owner_user_id=? AND ca.state='awaiting_user' AND ca.item_id IS NOT NULL`).all(userId)) {
    stamp(r.item_id, 'chat', chatAskRow(db, userId, r.convo_id, r.agent_device_id))
  }
  for (const row of db.prepare("SELECT * FROM transfers WHERE user_id=? AND consent='awaiting_user' AND phase='open' AND item_id IS NOT NULL").all(userId)) stamp(row.item_id, 'transfer', row)
  return changed
}
