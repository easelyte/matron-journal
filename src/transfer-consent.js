// The `transfer` consent kind: every file a session sends into a room waits
// for the user's approval. Its card is a tracker item (no timeline card):
// a question filed on the sender's own conversation when the transfer is
// created, answered on the item itself (Approve / Decline, routed here from
// POST /items/:id/comments) or by the Coordinator (POST /consent/answer).
// The item is a mirror of the row's consent axis: open exactly while the
// row's consent is 'awaiting_user' and its phase still open.
//
// Approve stamps the row and hands over to releaseIfReady (the file goes
// out once its upload is also complete). Decline deletes the bytes at once,
// ends the transfer, tells the sender's box and leaves a line in the room.
import { createItem, closeItem, TITLE_MAX } from './items.js'
import { emitMarker } from './items-http.js'
import { CONSENT_LABEL, codeSpan, fenced } from './consent-items.js'
import { sanitizePeerText, PEER_NAME_CAP, plainText as plain } from './peer-text.js'
import { appendAndBroadcast } from './journal.js'
import { participantConvoIds } from './participants.js'
import { recordAndAnnounce } from './consent-answer.js'
import { wakeIfOffline } from './wake.js'
import { getTransfer, setTransferState, deleteTransferFiles, forgetChunks, transferRecipients, isTransferId, parseFindings } from './transfers.js'

// "by the user." or "by the Coordinator: <reason>", for the decline's
// room line: the reason flattened to one line, without markdown, capped.
const DECLINE_REASON_MAX = 200
function declineWhy(decidedBy) {
  if (decidedBy?.kind !== 'coordinator') return 'by the user.'
  const why = plain(sanitizePeerText(decidedBy.reason, DECLINE_REASON_MAX * 2)).replace(/\s+/g, ' ').trim().slice(0, DECLINE_REASON_MAX).trim()
  return why ? `by the Coordinator: ${why}` : 'by the Coordinator.'
}

export const TRANSFER_ACTIONS = Object.freeze(['Approve', 'Decline'])
const quietPush = { onAppend() {} }
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const name = (raw) => (raw == null ? '' : sanitizePeerText(raw, PEER_NAME_CAP))
// A file name in the title: markup characters dropped like plain(), but
// underscores kept (they are common in file names, and never emphasis
// inside a word).
const titleName = (s) => String(s ?? '').replace(/[*`~[\]()<>!#|\\"]/g, '')

export function humanSize(bytes) {
  const units = ['KB', 'MB', 'GB', 'TB']
  if (bytes < 1024) return `${bytes} B`
  let v = bytes
  let u = -1
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1 }
  return `${v.toFixed(1)} ${units[u]}`
}

function scanLine(row) {
  if (row.scan_verdict === 'clean') return '✅ clean'
  if (row.scan_verdict === 'flagged') {
    const findings = parseFindings(row.scan_findings)
    const list = findings.map((f) => `${codeSpan(f.kind)} (${typeof f.line === 'number' ? f.line : codeSpan(f.line)})`).join(', ')
    return `⚠️ ${findings.length} possible secret${findings.length === 1 ? '' : 's'}: ${list}`
  }
  return 'not scanned (binary or unsupported format)'
}

// The item's fields. `names` carries the display names the row only has
// ids for: {senderBox, senderSession, roomTitle, recipients: [{box,
// sessions: [title]}]}. Every peer string is stripped of markdown (plain),
// the hash goes in a code span and the sender's note in a fence.
export function transferConsentItemFields(row, names) {
  const size = humanSize(row.size)
  const sender = plain(names.senderBox)
  const room = plain(names.roomTitle)
  const session = (t) => (t ? ` — session "${plain(t)}"` : '')
  const recipients = names.recipients.length
    ? names.recipients.map((r) => `${plain(r.box)}${r.sessions.length ? ` — ${r.sessions.map((t) => `session "${plain(t)}"`).join(', ')}` : ''}`).join('; ')
    : 'no other box is in the room yet'
  const lines = [
    `**${sender}** asks to send a file into the room "${room}".`,
    '',
    `- **From:** ${sender}${session(names.senderSession)}`,
    `- **To:** ${recipients}`,
    `- **Room:** ${room}`,
    `- **File:** ${codeSpan(row.name)}`,
    `- **Size:** ${size} (${row.size} bytes)`,
    `- **Type:** ${plain(row.content_type)}`,
    `- **SHA-256:** ${codeSpan(row.sha256)}`,
    `- **Secret scan:** ${scanLine(row)}`,
    '',
    ...(row.reason ? [`**Note from ${sender}:**`, '', fenced(row.reason), ''] : []),
    'Tap **Approve** to let the file through or **Decline** to delete it. Unanswered, it expires 7 days after it was sent.',
  ]
  return {
    title: cut(`Approve file transfer: ${titleName(row.name)} (${size}) from ${sender} to ${room}`, TITLE_MAX),
    body: lines.join('\n'),
    labels: [CONSENT_LABEL],
    links: [],
  }
}

// The display names for a row: the sender's box and session, the room's
// title, and each recipient box with its session(s) in the room.
export function transferNames(db, row) {
  const deviceName = (id) => name(db.prepare('SELECT name FROM devices WHERE id=?').get(id)?.name) || `box ${id}`
  const title = (id) => name(db.prepare('SELECT title FROM conversations WHERE id=?').get(id)?.title)
  const convos = participantConvoIds(db, row.room_id).filter((c) => c !== row.from_convo_id)
  const ownerOf = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?')
  const recipients = transferRecipients(db, row).map((d) => ({
    box: deviceName(d),
    sessions: convos.filter((c) => ownerOf.get(c)?.agent_device_id === d).map(title).filter(Boolean),
  }))
  return { senderBox: deviceName(row.sender_device_id), senderSession: title(row.from_convo_id), roomTitle: title(row.room_id), recipients }
}

function senderWho(db, row) {
  const devName = db.prepare('SELECT name FROM devices WHERE id=?').get(row.sender_device_id)?.name
  return devName ? { kind: 'agent', userId: row.user_id, deviceId: row.sender_device_id, name: devName } : null
}

// File the card for a freshly created transfer. Best-effort: a tracker
// failure is logged and the transfer stands with no item (item_id NULL);
// it can then only be answered by the Coordinator or expire. → the item or
// null.
export function fileTransferConsentItem({ db, hub }, row) {
  try {
    const fields = transferConsentItemFields(row, transferNames(db, row))
    const item = db.transaction(() => {
      const { item } = createItem(db, {
        userId: row.user_id, kind: 'question', ...fields, actions: [...TRANSFER_ACTIONS], awaiting: 'user', position: 'top',
        originConvoId: row.from_convo_id, originDeviceId: row.sender_device_id, createdBy: 'agent', consent: 'transfer',
        idemKey: `consent:transfer:${row.id}`,
      })
      if (!setTransferState(db, row.id, { item_id: item.id })) throw new Error(`transfer ${row.id} is gone`)
      return item
    })()
    const who = senderWho(db, row)
    if (who) emitMarker({ db, hub, pushPipeline: quietPush, waker: null }, who, { item, action: 'created', by: 'agent', fallback: false, extra: { consent: 'transfer', consent_ask: row.id } })
    return item
  } catch (err) {
    console.error('transfer consent: filing the card failed (the transfer stands)', err)
    return null
  }
}

const DELETED = 'The file was deleted; nothing was delivered.'
// How each way the ask stops waiting closes the item. `decidedBy` is
// {kind: 'user'|'coordinator', deviceId, reason?}.
export function transferConsentClosing(outcome, decidedBy = null) {
  const coord = decidedBy?.kind === 'coordinator'
  const why = coord ? ` — ${decidedBy.reason || 'no reason given'}` : ''
  switch (outcome) {
    case 'approved': return coord
      ? { resolution: 'decided', author: 'agent', byCoordinator: true, comment: `Approved by the Coordinator${why}.` }
      : { resolution: 'decided', author: 'user', comment: 'Approved.' }
    case 'declined': return coord
      ? { resolution: 'decided', author: 'agent', byCoordinator: true, comment: `Declined by the Coordinator${why}. ${DELETED}` }
      : { resolution: 'decided', author: 'user', comment: `Declined by you. ${DELETED}` }
    case 'cancelled': return { resolution: 'cancelled', author: 'agent', comment: 'Cancelled by the sender before it was answered.' }
    case 'failed': return { resolution: 'cancelled', author: 'agent', comment: 'The upload failed; there is nothing to approve.' }
    case 'expired': return { resolution: 'cancelled', author: 'agent', comment: 'Expired after 7 days.' }
    default: return { resolution: 'cancelled', author: 'agent', comment: `Closed — ${outcome}.` }
  }
}

// Close the card with what happened. An item already closed (the user
// closed it by hand, or an earlier outcome did) is left as it is. Never
// throws.
export function closeTransferConsentItem({ db, hub }, id, { outcome, decidedBy = null } = {}) {
  try {
    const row = getTransfer(db, id)
    if (!row || !row.item_id) return false
    const c = transferConsentClosing(outcome, decidedBy)
    const deviceId = (c.author === 'user' || c.byCoordinator) && decidedBy?.deviceId != null ? decidedBy.deviceId : row.sender_device_id
    const out = closeItem(db, { userId: row.user_id, itemId: row.item_id, resolution: c.resolution, author: c.author, deviceId, comment: c.comment })
    if (!out) return false
    const who = senderWho(db, row)
    if (hub && who) {
      emitMarker({ db, hub, pushPipeline: quietPush, waker: null }, who, {
        item: out.item, action: 'closed', comment: out.comment, by: c.author, fallback: false,
        extra: { consent: 'transfer', consent_ask: id, consent_outcome: outcome, ...(c.byCoordinator ? { decided_by: 'coordinator' } : {}) },
      })
    }
    return true
  } catch (err) {
    console.error('transfer consent: closing the card failed (the outcome stands)', err)
    return false
  }
}

// What a recipient bridge needs to fetch and file a released transfer: the
// `ready` frame's `transfer` and each row of GET /transfers?for=me.
// `reason` is the sender's note as stored at create (the text the card
// shows), or null when there was none.
export function readyTransferView(db, row) {
  return {
    id: row.id, room_id: row.room_id, name: row.name, size: row.size, sha256: row.sha256, content_type: row.content_type,
    from_name: name(db.prepare('SELECT name FROM devices WHERE id=?').get(row.sender_device_id)?.name), from_convo_id: row.from_convo_id,
    reason: row.reason || null,
  }
}

// Release the file to the room once it is both approved and fully
// uploaded. Called after each of the two (whichever comes second does it);
// the guarded open -> released move picks a single winner, so a repeat or
// racing call writes nothing. The room gets a durable `file` event in the
// journal's voice (no blob: the bytes are fetched by transfer_id), and
// the recipient device a `ready` frame; a box that is asleep is woken,
// and its bridge catches up on hello (GET /transfers?for=me). → true when
// this call released it.
export function releaseIfReady({ db, hub, waker = null }, id) {
  const row = getTransfer(db, id)
  if (!row || row.consent !== 'approved' || row.upload !== 'uploaded' || row.phase !== 'open') return false
  if (!setTransferState(db, id, { phase: 'released', released_at: Date.now() })) return false
  const view = readyTransferView(db, row)
  try {
    appendAndBroadcast(db, hub, {
      userId: row.user_id, convoId: row.room_id, sender: 'journal', type: 'file',
      payload: { name: view.name, size: view.size, sha256: view.sha256, content_type: view.content_type, transfer_id: id, from_name: view.from_name, from_convo_id: view.from_convo_id, reason: view.reason },
    })
  } catch (err) {
    console.error(`transfer: room file event for ${id} failed (the release stands)`, err)
  }
  for (const deviceId of transferRecipients(db, row)) {
    hub.sendToDevice(row.user_id, deviceId, { kind: 'transfer', event: 'ready', transfer_id: id, transfer: view })
    wakeIfOffline({ db, hub, waker }, row.user_id, deviceId)
  }
  console.log(`journal: transfer released id=${id} room=${row.room_id}`)
  return true
}

const awaiting = (row) => row.consent === 'awaiting_user' && row.phase === 'open'

// Apply a decision — the one path behind the user's tap and the
// Coordinator's answer. `decidedBy` is {kind: 'user', deviceId} or
// {kind: 'coordinator', deviceId, convoId, reason}. Everything up to the
// guarded state change is synchronous, so two answers cannot both win:
// the loser gets 409 and changes nothing. → {status, body}.
export function answerTransferAsk(ctx, { userId, transferId, decision, decidedBy }) {
  const { db, hub, mediaDir } = ctx
  const row = isTransferId(transferId) ? getTransfer(db, transferId) : null
  if (!row || row.user_id !== userId) return { status: 404, body: { error: 'not_found' } }
  if (!awaiting(row)) return { status: 409, body: { error: 'conflict' } }
  const now = Date.now()
  const stamp = { decided_by: decidedBy?.kind === 'coordinator' ? 'coordinator' : 'user', decided_reason: decidedBy?.reason ?? null }
  if (decision === 'decline') {
    if (!setTransferState(db, transferId, { consent: 'declined', phase: 'declined', ...stamp, deleted_at: now })) return { status: 409, body: { error: 'conflict' } }
    try {
      deleteTransferFiles(mediaDir, transferId)
    } catch (err) {
      console.error(`transfer consent: deleting declined ${transferId} failed`, err)
    }
    forgetChunks(db, transferId)
    closeTransferConsentItem({ db, hub }, transferId, { outcome: 'declined', decidedBy })
    recordAndAnnounce({ db, hub }, { userId, kind: 'transfer', askId: transferId, decision, decidedBy, convoId: row.from_convo_id, payload: { transfer_id: transferId } })
    const reason = decidedBy?.kind === 'coordinator' ? `Declined by the Coordinator: ${decidedBy.reason}` : 'Declined by the user.'
    hub.sendToDevice(userId, row.sender_device_id, { kind: 'transfer', event: 'declined', transfer_id: transferId, reason })
    try {
      appendAndBroadcast(db, hub, { userId, convoId: row.room_id, sender: 'journal', type: 'text', payload: { body: `Not sent: ${codeSpan(row.name)} was declined ${declineWhy(decidedBy)}` } })
    } catch (err) {
      console.error('transfer consent: room notice failed (the decline stands)', err)
    }
    console.log(`journal: transfer declined id=${transferId} by=${stamp.decided_by}`)
    return { status: 200, body: { ok: true } }
  }
  if (!setTransferState(db, transferId, { consent: 'approved', ...stamp, approved_at: now })) return { status: 409, body: { error: 'conflict' } }
  closeTransferConsentItem({ db, hub }, transferId, { outcome: 'approved', decidedBy })
  recordAndAnnounce({ db, hub }, { userId, kind: 'transfer', askId: transferId, decision, decidedBy, convoId: row.from_convo_id, payload: { transfer_id: transferId } })
  console.log(`journal: transfer approved id=${transferId} by=${stamp.decided_by}`)
  releaseIfReady(ctx, transferId)
  return { status: 200, body: { ok: true } }
}

// A tap on the card (POST /items/:id/comments with `action`). The row is
// checked before the label, so a tap on a card whose ask is no longer
// waiting is 409 whatever it says.
export function transferTapAnswer(ctx, who, item, action) {
  const row = ctx.db.prepare('SELECT * FROM transfers WHERE item_id=? AND user_id=?').get(item.id, who.userId)
  if (!row || !awaiting(row)) return staleTransferTap(row)
  if (!TRANSFER_ACTIONS.includes(action)) return { status: 400, body: { error: 'unknown_action' } }
  const r = answerTransferAsk(ctx, { userId: who.userId, transferId: row.id, decision: action === 'Decline' ? 'decline' : 'approve', decidedBy: { kind: 'user', deviceId: who.deviceId } })
  return r.status === 409 ? staleTransferTap(getTransfer(ctx.db, row.id)) : r
}

// A tap on a card whose ask is no longer waiting: 409, with a message an
// app shows as it is, saying how the ask ended.
function staleTransferTap(row) {
  const message = row?.consent === 'approved' ? 'Already answered: this file was approved.'
    : row?.consent === 'declined' ? 'Already answered: this file was declined.'
      : row?.phase === 'expired' ? 'This file expired before it was answered.'
        : row?.phase === 'cancelled' ? 'The sender cancelled this file before it was answered.'
          : 'This file is no longer waiting for an answer.'
  return { status: 409, body: { error: 'conflict', reason: 'already_answered', message } }
}
