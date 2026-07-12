import { authorize } from './auth.js'

export const MESSAGE_TYPES = [
  'text', 'tool_output', 'diff', 'prompt', 'permission_request', 'file', 'image',
]

export function snippetOf(type, payload) {
  // Tolerate whatever an agent hands us — null/undefined/a bare string or
  // number — rather than crashing on `payload.body` etc. A malformed
  // payload just yields an empty/placeholder snippet, never a thrown error.
  const p = payload && typeof payload === 'object' ? payload : {}
  if (type === 'text') return String(p.body || '').slice(0, 120)
  if (type === 'prompt') return `? ${String(p.question || '').slice(0, 110)}`
  if (type === 'permission_request') return `permission: ${String(p.description || '').slice(0, 100)}`
  if (p.snippet) return String(p.snippet).slice(0, 120)
  return `[${type}]`
}

// Returns the conversation row plus `titleChanged`: true when this call set a
// new, different title — either an existing convo's title actually changed,
// or a brand-new convo was created with a non-empty title. Callers (ws.js)
// use that flag to decide whether to fan out a `convo_meta` journal event;
// no event on an unchanged title, an absent title, or a state-only upsert.
export function upsertConversation(db, { id, ownerUserId, title, sessionState, agentDeviceId }) {
  const existing = db.prepare('SELECT * FROM conversations WHERE id=?').get(id)
  let titleChanged = false
  if (existing) {
    if (existing.owner_user_id !== ownerUserId) throw new Error('not authorized: convo owned by another user')
    if (title != null && title !== existing.title) titleChanged = true
    // agent_device_id: last upsert wins — the device currently managing the
    // session owns delivery (see hub.js). An absent agentDeviceId leaves the
    // recorded owner untouched.
    db.prepare(
      'UPDATE conversations SET title=COALESCE(?, title), session_state=COALESCE(?, session_state), agent_device_id=COALESCE(?, agent_device_id) WHERE id=?'
    ).run(title ?? null, sessionState ?? null, agentDeviceId ?? null, id)
  } else {
    const initialTitle = title || ''
    db.prepare(
      'INSERT INTO conversations(id, owner_user_id, title, session_state, agent_device_id, created_at) VALUES(?,?,?,?,?,?)'
    ).run(id, ownerUserId, initialTitle, sessionState || 'running', agentDeviceId ?? null, Date.now())
    if (initialTitle) titleChanged = true
  }
  const convo = db.prepare('SELECT * FROM conversations WHERE id=?').get(id)
  return { ...convo, titleChanged }
}

const nextSeq = (db, userId) =>
  db.prepare(
    'INSERT INTO user_seq(user_id, seq) VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET seq=seq+1 RETURNING seq'
  ).get(userId).seq

export function append(db, { userId, convoId, sender, type, payload, blobRef = null, idemKey = null }) {
  return db.transaction(() => {
    const convo = db.prepare('SELECT owner_user_id FROM conversations WHERE id=?').get(convoId)
    if (!convo || convo.owner_user_id !== userId) throw new Error('not authorized: convo missing or not owned')
    if (idemKey) {
      const dup = db.prepare('SELECT seq, ts FROM events WHERE user_id=? AND convo_id=? AND idem_key=?').get(userId, convoId, idemKey)
      if (dup) return { seq: dup.seq, ts: dup.ts, duplicate: true }
    }
    const seq = nextSeq(db, userId)
    const ts = Date.now()
    // JSON.stringify(undefined) is the JS value `undefined`, not a string —
    // binding that would hit the payload column's NOT NULL constraint as a
    // raw SQLite error. A caller that omits `payload` entirely gets `null`
    // stored instead, so this always fails at the same clean layer as an
    // explicit null/non-object payload (see the guards below).
    const payloadJson = JSON.stringify(payload === undefined ? null : payload)
    db.prepare(
      'INSERT INTO events(user_id, seq, convo_id, ts, sender, type, payload, blob_ref, idem_key) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(userId, seq, convoId, ts, sender, type, payloadJson, blobRef, idemKey)
    if (type === 'session_status') {
      // Guard against a malformed agent payload (null/undefined/non-object,
      // or an object with no string `state`) reaching the DB as a raw
      // bind-type or CHECK-constraint crash — fail with one clear, expected
      // error instead (still rolls back the whole transaction).
      const state = payload && typeof payload === 'object' ? payload.state : undefined
      if (typeof state !== 'string') throw new Error('invalid session_status payload: state must be a string')
      db.prepare('UPDATE conversations SET last_seq=?, session_state=? WHERE id=?')
        .run(seq, state, convoId)
    } else if (MESSAGE_TYPES.includes(type)) {
      // A user's own message (sender `user:*`) never inflates their own unread
      // badge — only content from someone/something else (an agent, mirroring
      // a bridge's remote participant) counts as unread. Keep this predicate in
      // sync with the recompute query in markRead() below.
      const sql = sender.startsWith('user:')
        ? 'UPDATE conversations SET last_seq=?, snippet=? WHERE id=?'
        : 'UPDATE conversations SET last_seq=?, unread_count=unread_count+1, snippet=? WHERE id=?'
      db.prepare(sql).run(seq, snippetOf(type, payload), convoId)
    } else {
      db.prepare('UPDATE conversations SET last_seq=? WHERE id=?').run(seq, convoId)
    }
    return { seq, ts, duplicate: false }
  })()
}

const parseRow = (r) => ({ ...r, payload: JSON.parse(r.payload) })

// Single source of truth for the public event shape shared by WS journal frames
// and HTTP pagination — strips internal columns (user_id, idem_key, blob_ref).
export const toEventShape = ({ seq, convo_id, ts, sender, type, payload }) =>
  ({ seq, convo_id, ts, sender, type, payload })

export function snapshot(db, userId) {
  const conversations = db.prepare(
    `SELECT id, title, session_state, last_seq, unread_count, snippet, created_at
     FROM conversations WHERE owner_user_id=? ORDER BY last_seq DESC`
  ).all(userId)
  const head = db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(userId)
  return { conversations, seq: head ? head.seq : 0 }
}

export function eventsAfter(db, userId, cursor, limit = 500) {
  return db.prepare(
    'SELECT * FROM events WHERE user_id=? AND seq>? ORDER BY seq LIMIT ?'
  ).all(userId, cursor, limit).map(parseRow)
}

export function messagesBefore(db, userId, convoId, { beforeSeq = null, limit = 50 } = {}) {
  if (!authorize(db, userId, convoId)) throw new Error('not authorized')
  const rows = beforeSeq == null
    ? db.prepare('SELECT * FROM events WHERE convo_id=? ORDER BY seq DESC LIMIT ?').all(convoId, limit)
    : db.prepare('SELECT * FROM events WHERE convo_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(convoId, beforeSeq, limit)
  return rows.reverse().map(parseRow)
}

// `sender` defaults to the caller's own `user:<name>` identity (the original
// client-only behavior) but callers may pass an explicit identity string —
// ws.js does, so an agent connection marking read on behalf of its user gets
// `agent:<name>` instead (see the read_marker op handler).
//
// `upToSeq: null` means "resolve to this conversation's current last_seq at
// processing time" — a bridge mirroring a user's own messages publishes
// fire-and-forget and never learns the seq it was assigned, so it can't pass
// an explicit cursor. Resolution happens inside this transaction so it's
// consistent with the recompute below.
export function markRead(db, userId, convoId, upToSeq, sender = null) {
  return db.transaction(() => {
    const convo = db.prepare('SELECT owner_user_id, last_seq FROM conversations WHERE id=?').get(convoId)
    if (!convo || convo.owner_user_id !== userId) throw new Error('not authorized: convo missing or not owned')
    const resolvedUpToSeq = upToSeq == null ? convo.last_seq : upToSeq
    const finalSender = sender ?? `user:${db.prepare('SELECT name FROM users WHERE id=?').get(userId).name}`
    const r = append(db, {
      userId, convoId, sender: finalSender, type: 'read_marker',
      payload: { convo_id: convoId, up_to_seq: resolvedUpToSeq },
    })
    const placeholders = MESSAGE_TYPES.map(() => '?').join(',')
    // Mirrors append()'s unread predicate: only non-`user:*`-sender messages
    // count as unread, so a recompute after read never resurrects the
    // reader's own messages as unread.
    db.prepare(
      `UPDATE conversations SET unread_count=(
         SELECT COUNT(*) FROM events e WHERE e.convo_id=? AND e.seq>? AND e.type IN (${placeholders})
           AND e.sender NOT LIKE 'user:%'
       ) WHERE id=?`
    ).run(convoId, resolvedUpToSeq, ...MESSAGE_TYPES, convoId)
    return { ...r, upToSeq: resolvedUpToSeq }
  })()
}
