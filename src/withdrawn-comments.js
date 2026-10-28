// Withdrawn replies. A user's reply on an item reaches the agent as a turn.
// When the session is busy the bridge holds that turn on its queue and posts
// a `queued_release` card for it, naming the reply (`item: {item_id,
// comment_id}`). If the user cancels the card, the bridge drops the turn and
// publishes its release with `action: 'cancel'`. The reply was never sent to
// the agent, so from then on no agent may read it by any other route either:
//
//   - the comment row is marked `withdrawn_at`; agents reading the thread get
//     it without its words (presentWithdrawn), and search drops it;
//   - the conversation log is scrubbed of the words: the item markers that
//     carried the comment, the old-client fallback text after the
//     `commented` one, and the queue card itself, which held the whole turn.
//
// The user's own apps still read the comment in full on the item, so the
// thread shows what was cancelled and "Edit and resend" has the text.
import { ITEM_EVENT_TYPE } from './items-marker.js'

export const WITHDRAWN_NOTE = '(a reply the user cancelled before it was sent)'

// How far after an item marker its old-client fallback text can sit: the two
// are appended back to back (src/items-http.js emitMarker), so in practice
// the next seq.
const FALLBACK_WINDOW = 4

const parse = (s) => { try { return JSON.parse(s) } catch { return null } }

// A comment as an agent, or another person, may see it once withdrawn: who
// wrote it and when, never what it said.
// A tapped reply's label is what it said, too.
export function presentWithdrawn(c) {
  if (!c || c.withdrawn_at == null) return c
  const meta = c.meta && typeof c.meta === 'object' ? { ...c.meta } : c.meta
  if (meta) delete meta.action
  return { ...c, body: '', attachments: [], meta, action: null, withdrawn: true }
}

// The bridge's cancel release for one of its queue cards (a `prompt_reply`
// it published): withdraw the item reply the card held, if it held one.
// Only the conversation's own bridge (the device that manages it, which is
// the one that queues its turns) may do this, and only for a card it posted
// itself: a peer agent joined to the room can publish prompts too.
// Returns the withdrawn comment's id, or null when there was nothing to do.
export function withdrawForQueuedCancel(db, { userId, deviceId, convoId, sender, payload, now = Date.now() }) {
  if (!payload || payload.kind !== 'queued_release' || payload.action !== 'cancel') return null
  const promptId = payload.prompt_id
  if (typeof promptId !== 'string' || !promptId) return null
  const convo = db.prepare('SELECT agent_device_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
  if (!convo || convo.agent_device_id == null || convo.agent_device_id !== deviceId) return null
  const card = db.prepare(`SELECT seq, payload FROM events
    WHERE user_id=? AND convo_id=? AND type='prompt' AND sender=?
      AND json_extract(payload, '$.kind')='queued_release' AND json_extract(payload, '$.prompt_id')=?
    ORDER BY seq DESC LIMIT 1`).get(userId, convoId, sender, promptId)
  if (!card) return null
  const p = parse(card.payload)
  const itemId = p?.item?.item_id
  const commentId = p?.item?.comment_id
  if (typeof itemId !== 'string' || typeof commentId !== 'string' || !itemId || !commentId) return null
  return withdrawComment(db, { userId, itemId, commentId, cardSeq: card.seq, now })
}

// Mark one user reply withdrawn and scrub its words from the conversation
// log. Idempotent: a second call finds it withdrawn and does nothing. Only
// the user's own replies qualify; anything else returns null untouched.
export function withdrawComment(db, { userId, itemId, commentId, cardSeq = null, now = Date.now() }) {
  return db.transaction(() => {
    const c = db.prepare(`SELECT id, withdrawn_at, meta FROM item_comments
      WHERE id=? AND item_id=? AND user_id=? AND author='user' AND kind='comment'`).get(commentId, itemId, userId)
    if (!c || c.withdrawn_at != null) return null
    db.prepare('UPDATE item_comments SET withdrawn_at=? WHERE id=?').run(now, commentId)
    // The search triggers drop it too (search-docs.js); this covers a
    // database whose triggers predate the rule until they are recreated.
    db.prepare("DELETE FROM search_docs WHERE kind='comment' AND ref_id=?").run(commentId)
    const chosen = undoTap(db, { itemId, meta: parse(c.meta) })
    scrubEvents(db, { userId, itemId, commentId, cardSeq, chosen })
    return commentId
  })()
}

// A withdrawn tap was never the user's answer: the buttons it pressed go
// back to the latest tap still standing on them, or to none. Returns
// {action, itemChosen} for the log scrub, or null when it was not a tap.
function undoTap(db, { itemId, meta }) {
  const action = typeof meta?.action === 'string' ? meta.action : null
  if (!action) return null
  const replyTo = typeof meta.reply_to === 'string' ? meta.reply_to : null
  const latest = db.prepare(`SELECT json_extract(meta, '$.action') AS action FROM item_comments
    WHERE item_id=? AND author='user' AND kind='comment' AND withdrawn_at IS NULL
      AND json_extract(meta, '$.action') IS NOT NULL
      AND ${replyTo ? "json_extract(meta, '$.reply_to')=?" : "json_extract(meta, '$.reply_to') IS NULL"}
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(...(replyTo ? [itemId, replyTo] : [itemId]))
  // Only a label the buttons still offer: an agent that replaced the
  // buttons since that tap has already cleared the choice it answered.
  const offered = replyTo
    ? db.prepare('SELECT actions FROM item_comments WHERE id=? AND item_id=?').get(replyTo, itemId)?.actions
    : db.prepare('SELECT actions FROM items WHERE id=?').get(itemId)?.actions
  const restored = latest?.action != null && (parse(offered) ?? []).includes(latest.action) ? latest.action : null
  if (replyTo) {
    db.prepare('UPDATE item_comments SET chosen_action=? WHERE id=? AND item_id=? AND chosen_action IS ?').run(restored, replyTo, itemId, action)
    return { action, itemChosen: undefined }
  }
  db.prepare('UPDATE items SET chosen_action=? WHERE id=? AND chosen_action IS ?').run(restored, itemId, action)
  return { action, itemChosen: restored }
}

// Every user's log: a reply on an item a contributor filed was also copied
// into the contributor's conversation (src/contribute-http.js).
function scrubEvents(db, { userId, itemId, commentId, cardSeq, chosen }) {
  const update = db.prepare('UPDATE events SET payload=? WHERE user_id=? AND seq=?')
  const markers = db.prepare(`SELECT user_id, seq, convo_id, sender, payload FROM events
    WHERE type=? AND json_extract(payload, '$.item_id')=? AND json_extract(payload, '$.comment.id')=?`)
    .all(ITEM_EVENT_TYPE, itemId, commentId)
  const fallbackAfter = db.prepare(`SELECT seq, payload FROM events
    WHERE user_id=? AND convo_id=? AND sender=? AND type='text' AND seq>? AND seq<=?
      AND json_extract(payload, '$.fallback_for')='item' AND json_extract(payload, '$.item_id')=?
      AND json_extract(payload, '$.action')='commented'
    ORDER BY seq LIMIT 1`)
  for (const m of markers) {
    const p = parse(m.payload)
    if (!p?.comment) continue
    p.comment = { ...p.comment, body: '', attachments: [], action: null, withdrawn: true }
    update.run(JSON.stringify(p), m.user_id, m.seq)
    if (p.action !== 'commented') continue
    const fb = fallbackAfter.get(m.user_id, m.convo_id, m.sender, m.seq, m.seq + FALLBACK_WINDOW, itemId)
    const fp = fb && parse(fb.payload)
    if (!fp || typeof fp.body !== 'string') continue
    // Keep the heading line ("📌 Task #12 "…" — alice commented:"), drop the words.
    fp.body = `${fp.body.split('\n')[0]}\n${WITHDRAWN_NOTE}`
    update.run(JSON.stringify(fp), m.user_id, fb.seq)
  }
  // A withdrawn tap on the item's own buttons: the markers since it carry
  // the item's chosen_action, which named the tap.
  if (chosen && chosen.itemChosen !== undefined && markers.length) {
    const since = Math.min(...markers.filter((m) => m.user_id === userId).map((m) => m.seq))
    const later = db.prepare(`SELECT seq, payload FROM events
      WHERE user_id=? AND type=? AND seq>=? AND json_extract(payload, '$.item_id')=? AND json_extract(payload, '$.chosen_action')=?`)
      .all(userId, ITEM_EVENT_TYPE, since, itemId, chosen.action)
    for (const r of later) {
      const p = parse(r.payload)
      if (!p) continue
      p.chosen_action = chosen.itemChosen
      update.run(JSON.stringify(p), userId, r.seq)
    }
  }
  if (cardSeq != null) {
    const card = db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(userId, cardSeq)
    const p = card && parse(card.payload)
    if (p && Array.isArray(p.items)) {
      p.items = p.items.map((it) => (it && typeof it === 'object' ? { ...it, text: WITHDRAWN_NOTE } : it))
      update.run(JSON.stringify(p), userId, cardSeq)
    }
  }
}
