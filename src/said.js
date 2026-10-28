// "Did the user really say this?" — GET /said/<convo>:<seq> (docs/protocol.md,
// "Verified authorship"). An agent that should act only on its user's own
// request is often handed it by another agent, as a citation <convo>:<seq>,
// and must not take that agent's word for what the user said. It asks the
// journal instead, with its own token, and gets back only what the journal
// itself recorded:
//
//  - typed: a `text` event whose sender is `user:<account>`. The journal sets
//    that sender from the device token (ws.js `send`, client devices only),
//    so no agent can write one. The old-client item fallback copies carry the
//    same sender but agent-written words (an item title, a question), so
//    they are refused by name.
//  - voice: the user's audio `file` event, answered with the words the
//    journal's own transcriber wrote on the blob (blob-transcripts.js — the
//    only writer of blobs.transcript, and it never runs for an agent's
//    upload), or, once the audio has expired, the copy retention.js moved
//    onto the event (stamped transcript_by 'journal' — only when it was the
//    blob's own transcript). A bridge-transcribed note (no journal transcript) is
//    refused: an agent box wrote those words.
//  - tapped: a `prompt_reply` event whose sender is `user:<account>` — the
//    user's answer to a question card, by button or by the card's own text
//    box. Only a client `prompt_reply` op writes one with that sender (a
//    bridge's own release of a queue card is published as `agent:<box>`),
//    so the answer is the user's as surely as a typed message. The words
//    are the reply's free text, else its choice; `before` is the card it
//    answers, an agent's question, never the user's words.
//  - the bridge's "[Voice note transcription]: …" copy: an agent message,
//    but agents find and cite it because it is the only searchable text a
//    voice note leaves. The journal looks for the user's own voice note just
//    before it whose journal transcript is the same words, and answers with
//    THAT note. The words returned are always the journal's transcript, never
//    the copy's, so a forged copy can at most point at something the user
//    really said (with its real time, which is what the caller judges a
//    replay by).
//
// Nothing is signed: the caller asks the journal directly, every time, so the
// answer never passes through an agent's hands. Events are never edited
// (retention only adds the transcript to an expired voice note), so the same
// citation always gives the same answer.

import { indexableBody } from './search.js'
import { filteredAgent, privateOwnedConvo } from './privacy.js'

export const VOICE_COPY_PREFIX = '[Voice note transcription]:'
// The message just before the cited one, for a reply like "yes, do that":
// returned as context, marked with its sender, never as the user's words.
export const BEFORE_CHARS = 4000
// How far back a bridge copy may sit from the voice note it copies. The
// bridge posts the copy when the words reach the session — at once, or at the
// end of a busy turn — so minutes in practice; a day is generous.
const COPY_MAX_GAP_MS = 24 * 60 * 60 * 1000
const COPY_SEARCH_LIMIT = 50

const parse = (row) => {
  let payload = null
  try { payload = JSON.parse(row.payload) } catch { payload = null }
  return { ...row, payload: payload && typeof payload === 'object' ? payload : {} }
}

const isAudio = (s) => typeof s === 'string' && s.toLowerCase().startsWith('audio/')

// <convo>:<seq> → { convoId, seq }, or null. A conversation id never holds a
// bare `:<digits>` tail of its own (sub-chats are `<id>:sub:<hex>`), so the
// last colon splits.
export function parseCitation(s) {
  if (typeof s !== 'string') return null
  const i = s.lastIndexOf(':')
  if (i <= 0) return null
  const convoId = s.slice(0, i)
  const tail = s.slice(i + 1)
  if (!/^[1-9][0-9]{0,15}$/.test(tail) || convoId.length > 200) return null
  return { convoId, seq: Number(tail) }
}

// The journal's own words for one of the user's voice notes, or null.
function journalTranscript(db, userId, ev) {
  const p = ev.payload
  const blobRef = ev.blob_ref ?? (typeof p.blob_ref === 'string' ? p.blob_ref : null)
  if (blobRef) {
    const blob = db.prepare('SELECT owner_user_id, content_type, transcript, transcript_status FROM blobs WHERE id=?').get(blobRef)
    if (!blob || blob.owner_user_id !== userId || !isAudio(blob.content_type)) return null
    if (blob.transcript_status !== 'done') return null
    const t = typeof blob.transcript === 'string' ? blob.transcript.trim() : ''
    return t || null
  }
  // Expired audio: retention.js rewrote the event to a tombstone carrying the
  // transcript of the blob it deleted (tombstoneAttachmentEvents), stamped
  // 'journal' only when those were the journal's own words — an item
  // attachment's transcript, which an agent may have written, is not.
  if (p.expired === true && p.transcript_by === 'journal' && isAudio(p.content_type) && typeof p.transcript === 'string' && p.transcript.trim()) {
    return p.transcript.trim()
  }
  return null
}

// The question card a prompt_reply answers, as context: { seq, sender, text },
// or null when target_seq names no prompt of this conversation BEFORE the
// reply (a card that came later cannot be what the user answered).
function answeredPrompt(db, convoId, targetSeq, replySeq) {
  if (!Number.isSafeInteger(targetSeq) || targetSeq <= 0 || targetSeq >= replySeq) return null
  const r = db.prepare(`SELECT seq, sender, payload FROM events WHERE convo_id=? AND seq=? AND type='prompt'`).get(convoId, targetSeq)
  if (!r) return null
  const ev = parse(r)
  const q = typeof ev.payload.question === 'string' ? ev.payload.question : ''
  return { seq: ev.seq, sender: ev.sender, text: q.length > BEFORE_CHARS ? `${q.slice(0, BEFORE_CHARS)}…` : q }
}

function previousProse(db, convoId, seq) {
  const rows = db.prepare(`SELECT seq, sender, type, payload FROM events WHERE convo_id=? AND seq<? AND type IN ('text','diff') ORDER BY seq DESC LIMIT 20`).all(convoId, seq)
  for (const r of rows) {
    const ev = parse(r)
    const text = indexableBody(ev.type, ev.payload)
    if (text == null) continue
    return { seq: ev.seq, sender: ev.sender, text: text.length > BEFORE_CHARS ? `${text.slice(0, BEFORE_CHARS)}…` : text }
  }
  return null
}

// What the user said in one of their own events, or { reason } when it is not
// words they wrote.
function wordsOf(db, userId, ev) {
  const p = ev.payload
  if (ev.type === 'text') {
    if (p.fallback_for) return { reason: 'item_reply_copy' }
    const body = typeof p.body === 'string' ? p.body.trim() : ''
    return body ? { kind: 'typed', text: body } : { reason: 'no_text' }
  }
  if (ev.type === 'file' || ev.type === 'image') {
    const caption = typeof p.caption === 'string' && p.caption.trim() ? p.caption.trim() : null
    if (ev.type === 'file' && isAudio(p.content_type)) {
      const words = journalTranscript(db, userId, ev)
      if (words) return { kind: 'voice', text: words, ...(caption ? { caption } : {}) }
      if (caption) return { kind: 'typed', text: caption }
      return { reason: 'voice_not_transcribed_by_journal' }
    }
    return caption ? { kind: 'typed', text: caption } : { reason: 'no_text' }
  }
  if (ev.type === 'prompt_reply') {
    const text = typeof p.text === 'string' ? p.text.trim() : ''
    const choice = typeof p.choice === 'string' ? p.choice.trim()
      : Number.isFinite(p.choice) ? String(p.choice) : ''
    if (!text && !choice) return { reason: 'no_text' }
    return { kind: 'tap', text: text || choice, ...(choice ? { choice } : {}) }
  }
  return { reason: 'not_a_message' }
}

// The user's voice note a bridge copy repeats, or null.
function voiceNoteForCopy(db, userId, userSender, copy) {
  const body = typeof copy.payload.body === 'string' ? copy.payload.body : ''
  if (!body.startsWith(VOICE_COPY_PREFIX)) return null
  const copied = body.slice(VOICE_COPY_PREFIX.length).trim()
  if (!copied) return null
  const rows = db.prepare(`SELECT * FROM events WHERE convo_id=? AND seq<? AND sender=? AND type='file' AND ts>=? ORDER BY seq DESC LIMIT ?`)
    .all(copy.convo_id, copy.seq, userSender, copy.ts - COPY_MAX_GAP_MS, COPY_SEARCH_LIMIT)
  for (const r of rows) {
    const ev = parse(r)
    if (!isAudio(ev.payload.content_type)) continue
    if (journalTranscript(db, userId, ev) === copied) return ev
  }
  return null
}

// → { status: 404 } | { status: 200, body }
export function verifySaid(db, who, { convoId, seq }) {
  const convo = db.prepare('SELECT owner_user_id FROM conversations WHERE id=?').get(convoId)
  // Only the caller's own account, and the same privacy rule as every other
  // agent read: a private box's conversation does not exist for an ordinary
  // agent. Unknown, foreign and private are one 404.
  if (!convo || convo.owner_user_id !== who.userId) return { status: 404 }
  if (filteredAgent(db, who) && privateOwnedConvo(db, convoId)) return { status: 404 }
  const row = db.prepare('SELECT * FROM events WHERE user_id=? AND convo_id=? AND seq=?').get(who.userId, convoId, seq)
  if (!row) return { status: 404 }
  const user = db.prepare('SELECT name FROM users WHERE id=?').get(who.userId)
  const userSender = `user:${user.name}`
  let ev = parse(row)
  let citedSeq = null
  if (ev.sender !== userSender) {
    const note = ev.type === 'text' && ev.sender.startsWith('agent:') ? voiceNoteForCopy(db, who.userId, userSender, ev) : null
    if (!note) {
      const reason = ev.sender.startsWith('agent:') ? 'agent_message' : 'not_from_user'
      return { status: 200, body: { verified: false, convo_id: convoId, seq, sender: ev.sender, reason } }
    }
    citedSeq = ev.seq
    ev = note
  }
  const words = wordsOf(db, who.userId, ev)
  if (words.reason) {
    return { status: 200, body: { verified: false, convo_id: convoId, seq, sender: ev.sender, reason: words.reason } }
  }
  const before = ev.type === 'prompt_reply'
    ? answeredPrompt(db, convoId, ev.payload.target_seq, ev.seq) ?? previousProse(db, convoId, ev.seq)
    : previousProse(db, convoId, ev.seq)
  return {
    status: 200,
    body: {
      verified: true,
      convo_id: convoId,
      seq: ev.seq,
      ...(citedSeq != null ? { cited_seq: citedSeq } : {}),
      ts: ev.ts,
      author: userSender,
      kind: words.kind,
      text: words.text,
      ...(words.caption ? { caption: words.caption } : {}),
      ...(words.choice ? { choice: words.choice } : {}),
      before,
    },
  }
}
