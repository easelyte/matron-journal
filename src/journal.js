export const MESSAGE_TYPES = [
  'text', 'tool_output', 'diff', 'prompt', 'permission_request', 'file', 'image',
]

function snippetOf(type, payload) {
  if (type === 'text') return String(payload.body || '').slice(0, 120)
  if (type === 'prompt') return `? ${String(payload.question || '').slice(0, 110)}`
  if (type === 'permission_request') return `permission: ${String(payload.description || '').slice(0, 100)}`
  if (payload && payload.snippet) return String(payload.snippet).slice(0, 120)
  return `[${type}]`
}

export function upsertConversation(db, { id, ownerUserId, title, sessionState }) {
  const existing = db.prepare('SELECT * FROM conversations WHERE id=?').get(id)
  if (existing) {
    if (existing.owner_user_id !== ownerUserId) throw new Error('not authorized: convo owned by another user')
    db.prepare(
      'UPDATE conversations SET title=COALESCE(?, title), session_state=COALESCE(?, session_state) WHERE id=?'
    ).run(title ?? null, sessionState ?? null, id)
  } else {
    db.prepare(
      'INSERT INTO conversations(id, owner_user_id, title, session_state, created_at) VALUES(?,?,?,?,?)'
    ).run(id, ownerUserId, title || '', sessionState || 'running', Date.now())
  }
  return db.prepare('SELECT * FROM conversations WHERE id=?').get(id)
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
    db.prepare(
      'INSERT INTO events(user_id, seq, convo_id, ts, sender, type, payload, blob_ref, idem_key) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(userId, seq, convoId, ts, sender, type, JSON.stringify(payload), blobRef, idemKey)
    if (type === 'session_status') {
      db.prepare('UPDATE conversations SET last_seq=?, session_state=? WHERE id=?')
        .run(seq, payload.state, convoId)
    } else if (MESSAGE_TYPES.includes(type)) {
      db.prepare('UPDATE conversations SET last_seq=?, unread_count=unread_count+1, snippet=? WHERE id=?')
        .run(seq, snippetOf(type, payload), convoId)
    } else {
      db.prepare('UPDATE conversations SET last_seq=? WHERE id=?').run(seq, convoId)
    }
    return { seq, ts, duplicate: false }
  })()
}
