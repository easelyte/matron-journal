// Task & decision tracker — pure DB state (spec: 2026-09-08
// task-decision-tracker). Every transition lives here so the HTTP layer,
// tests, and any future WS op share one set of rules. No hub, no push, no
// wake: those are src/items-http.js's job.
import { randomBytes } from 'node:crypto'

export const ITEM_KINDS = ['task', 'question', 'decision']
export const RESOLUTIONS = ['done', 'answered', 'decided', 'reversed', 'cancelled']
export const AWAITING = ['user', 'agent']
export const TITLE_MAX = 200
export const BODY_MAX = 32768
export const LABELS_MAX = 50
export const LABEL_MAX = 40
export const LINKS_MAX = 50
export const URL_MAX = 2048
export const ATTACHMENTS_MAX = 20
export const RANK_GAP = 1024
export const RANK_EPSILON = 1e-6

export const newId = (prefix) => `${prefix}_${randomBytes(8).toString('hex')}`

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// `allowTranscript` defaults FALSE, and no HTTP route turns it on: a
// transcript is agent-attested output of the transcribe job, written only by
// PATCH /items/:id/comments/:cid (setAttachmentTranscript). A client that
// posts one on a create/comment gets it dropped on the floor rather than
// stored — otherwise anyone could forge words into a voice note's transcript,
// which is exactly the text the apps display in place of the audio.
function validateAttachments(list, { allowTranscript = false } = {}) {
  if (list === undefined) return { ok: true, value: [] }
  if (!Array.isArray(list) || list.length > ATTACHMENTS_MAX) return { ok: false }
  const out = []
  for (const a of list) {
    if (!isPlainObject(a)) return { ok: false }
    if (typeof a.blob_ref !== 'string' || !a.blob_ref || a.blob_ref.length > 128) return { ok: false }
    if (typeof a.mime !== 'string' || !a.mime || a.mime.length > 128) return { ok: false }
    if (typeof a.name !== 'string' || a.name.length > 255) return { ok: false }
    if (!Number.isInteger(a.size) || a.size < 0) return { ok: false }
    const att = { blob_ref: a.blob_ref, mime: a.mime, name: a.name, size: a.size }
    if (allowTranscript && a.transcript !== undefined) {
      if (typeof a.transcript !== 'string' || a.transcript.length > BODY_MAX) return { ok: false }
      att.transcript = a.transcript
    }
    out.push(att)
  }
  return { ok: true, value: out }
}

// Normalises and bounds every user/agent-writable field. `partial` (PATCH)
// lets `title` be absent; a present field is always validated in full.
// `allowTranscript` is passed straight through to validateAttachments (see
// there: off for every route, so a client-supplied transcript is stripped).
export function validateItemFields(fields, { partial = false, allowTranscript = false } = {}) {
  if (!isPlainObject(fields)) return { ok: false }
  const value = {}
  if (fields.title !== undefined || !partial) {
    if (typeof fields.title !== 'string') return { ok: false }
    const t = fields.title.trim()
    if (!t || t.length > TITLE_MAX) return { ok: false }
    value.title = t
  }
  if (fields.body !== undefined) {
    if (typeof fields.body !== 'string' || fields.body.length > BODY_MAX) return { ok: false }
    value.body = fields.body
  }
  if (fields.labels !== undefined) {
    if (!Array.isArray(fields.labels) || fields.labels.length > LABELS_MAX) return { ok: false }
    const seen = new Set()
    for (const l of fields.labels) {
      if (typeof l !== 'string') return { ok: false }
      const s = l.trim()
      if (!s || s.length > LABEL_MAX) return { ok: false }
      seen.add(s)
    }
    value.labels = [...seen]
  }
  if (fields.links !== undefined) {
    if (!Array.isArray(fields.links) || fields.links.length > LINKS_MAX) return { ok: false }
    value.links = []
    for (const l of fields.links) {
      if (!isPlainObject(l) || typeof l.url !== 'string' || l.url.length > URL_MAX) return { ok: false }
      if (!/^https?:\/\//i.test(l.url)) return { ok: false }
      const link = { url: l.url }
      if (l.title !== undefined) {
        if (typeof l.title !== 'string' || l.title.length > TITLE_MAX) return { ok: false }
        link.title = l.title
      }
      value.links.push(link)
    }
  }
  const att = validateAttachments(fields.attachments, { allowTranscript })
  if (!att.ok) return { ok: false }
  if (fields.attachments !== undefined) value.attachments = att.value
  return { ok: true, value }
}

const parseJson = (s, fallback) => { try { return JSON.parse(s) } catch { return fallback } }

// `idem_key` is an internal column (same stance as toEventShape in
// journal.js): the caller sent the key, so handing it back tells it nothing,
// and echoing another device's key would be a small leak.
export function rowToItem(row) {
  if (!row) return null
  const { labels, links, attachments, idem_key: _idemKey, ...rest } = row
  const out = {
    ...rest,
    labels: parseJson(labels, []),
    links: parseJson(links, []),
    attachments: parseJson(attachments ?? '[]', []),
  }
  if ('comment_count' in out) out.comment_count = Number(out.comment_count)
  if ('has_image' in out) out.has_image = !!out.has_image
  return out
}

// Same internal-column strip as rowToItem, plus `user_id`: every comment
// route is already scoped to the caller's own user, so the field is noise.
export function rowToComment(row) {
  if (!row) return null
  const { attachments, meta, idem_key: _idemKey, user_id: _userId, ...rest } = row
  return { ...rest, attachments: parseJson(attachments, []), meta: meta == null ? null : parseJson(meta, null) }
}

// Default `awaiting` per kind at creation (spec: Semantics). Also the value
// a reopen restores.
export function defaultAwaiting(kind) {
  if (kind === 'question') return 'user'
  if (kind === 'task') return 'agent'
  return null
}

// ...but WHO filed it matters at creation time: the kind defaults above
// describe an AGENT-filed item (an agent's question is a question *for* the
// user). A user filing a question is asking the agent, and a user filing a
// task is asking for work — both start `awaiting:'agent'`. A decision
// records something already settled and awaits nobody either way.
export function createDefaultAwaiting(kind, createdBy) {
  if (createdBy === 'user') return kind === 'decision' ? null : 'agent'
  return defaultAwaiting(kind)
}

// Mirrors journal.js's user_seq counter idiom: one statement, atomic even
// under concurrent callers on the same connection.
export function nextNum(db, userId) {
  return db.prepare(
    'INSERT INTO item_counters(user_id, next_num) VALUES(?, 2) ON CONFLICT(user_id) DO UPDATE SET next_num = next_num + 1 RETURNING next_num - 1 AS num'
  ).get(userId).num
}

function rankBounds(db, userId) {
  return db.prepare("SELECT MIN(rank) AS lo, MAX(rank) AS hi FROM items WHERE user_id=? AND state='open'").get(userId)
}

function openRankOf(db, userId, id) {
  const r = db.prepare("SELECT rank FROM items WHERE id=? AND user_id=? AND state='open'").get(id, userId)
  return r ? r.rank : null
}

// Renormalise every open item of the user to 1024·n in rank order. Called
// only when a midpoint would land within RANK_EPSILON of a neighbour.
export function renormaliseRanks(db, userId) {
  const rows = db.prepare("SELECT id FROM items WHERE user_id=? AND state='open' ORDER BY rank ASC, num ASC").all(userId)
  const upd = db.prepare('UPDATE items SET rank=? WHERE id=?')
  rows.forEach((r, i) => upd.run(RANK_GAP * (i + 1), r.id))
}

// Resolves a target rank from {position, after, before}. Throws
// Error('bad_after_before') when a named neighbour is not one of the user's
// OPEN items, when after/before name the same item, or when they're
// inverted (before ranked at-or-below after — renormalising can't fix a
// structural inversion, only a tight gap, so this must fail fast rather
// than loop). `excludeId` keeps a reorder from using itself as a neighbour.
export function resolveRank(db, userId, { position, after, before, excludeId = null }) {
  const bounds = rankBounds(db, userId)
  if (after == null && before == null) {
    if (position === 'top') return bounds.lo == null ? RANK_GAP : bounds.lo - RANK_GAP
    return bounds.hi == null ? RANK_GAP : bounds.hi + RANK_GAP
  }
  if (after != null && before != null && after === before) throw new Error('bad_after_before')

  const computeBounds = () => {
    let lo = null, hi = null
    if (after != null) {
      if (after === excludeId) throw new Error('bad_after_before')
      lo = openRankOf(db, userId, after)
      if (lo == null) throw new Error('bad_after_before')
    }
    if (before != null) {
      if (before === excludeId) throw new Error('bad_after_before')
      hi = openRankOf(db, userId, before)
      if (hi == null) throw new Error('bad_after_before')
    }
    if (lo == null) {
      // "before X" only: sit between X's predecessor and X.
      const prev = db.prepare("SELECT MAX(rank) AS r FROM items WHERE user_id=? AND state='open' AND rank < ? AND id<>?").get(userId, hi, excludeId ?? '').r
      lo = prev == null ? hi - RANK_GAP * 2 : prev
    }
    if (hi == null) {
      const next = db.prepare("SELECT MIN(rank) AS r FROM items WHERE user_id=? AND state='open' AND rank > ? AND id<>?").get(userId, lo, excludeId ?? '').r
      hi = next == null ? lo + RANK_GAP * 2 : next
    }
    return { lo, hi }
  }

  let { lo, hi } = computeBounds()
  if (hi <= lo) throw new Error('bad_after_before')
  if (hi - lo < RANK_EPSILON) {
    // A genuine but too-tight gap: renormalise once (spreads every open
    // item back to 1024·n, preserving order) and recompute directly — no
    // recursion, so this can fire at most once per call no matter how many
    // items are open.
    renormaliseRanks(db, userId)
    ;({ lo, hi } = computeBounds())
    if (hi <= lo) throw new Error('bad_after_before')
  }
  return (lo + hi) / 2
}

export function createItem(db, {
  userId, kind, title, body = '', labels = [], links = [], attachments = [], awaiting, position, after, before,
  originConvoId, originDeviceId, createdBy, supersedes = null, idemKey = null, now = Date.now(),
}) {
  return db.transaction(() => {
    if (idemKey) {
      const dup = db.prepare('SELECT * FROM items WHERE user_id=? AND idem_key=?').get(userId, idemKey)
      if (dup) return { item: getItem(db, userId, dup.id), duplicate: true }
    }
    if (supersedes != null) {
      const sup = db.prepare('SELECT 1 FROM items WHERE id=? AND user_id=?').get(supersedes, userId)
      if (!sup) throw new Error('bad_supersedes')
    }
    const rank = resolveRank(db, userId, { position, after, before })
    const id = newId('it')
    const num = nextNum(db, userId)
    const aw = awaiting === undefined ? createDefaultAwaiting(kind, createdBy) : awaiting
    const missionId = db.prepare('SELECT mission_id FROM conversations WHERE id=?').get(originConvoId)?.mission_id ?? null
    try {
      db.prepare(`INSERT INTO items(id,user_id,num,kind,state,resolution,awaiting,rank,title,body,labels,links,supersedes,
        origin_convo_id,origin_device_id,created_by,idem_key,created_at,updated_at,mission_id)
        VALUES(?,?,?,?,'open',NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, userId, num, kind, aw, rank, title, body, JSON.stringify(labels), JSON.stringify(links), supersedes,
          originConvoId, originDeviceId, createdBy, idemKey, now, now, missionId)
    } catch (err) {
      // A racing writer on another connection committed the same
      // (user_id, idem_key) between our lookup above and this INSERT. That
      // is precisely the case the key exists to handle, so hand back their
      // row rather than surfacing a raw constraint error as a 500. (The
      // `num` this call minted is spent — a gap in the user's numbering is
      // a fair price for never double-filing an item.) Any other unique
      // violation is a real bug and still throws.
      if (idemKey && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const dup = db.prepare('SELECT id FROM items WHERE user_id=? AND idem_key=?').get(userId, idemKey)
        if (dup) return { item: getItem(db, userId, dup.id), duplicate: true }
      }
      throw err
    }
    if (attachments.length) {
      // Item-body attachments ride on a synthetic first comment of kind
      // 'status' with meta.role='body' so the thread has one place for
      // blob refs; rowToItem exposes them as item.attachments via listItems'
      // decoration query. Simpler than a fourth table.
      db.prepare(`INSERT INTO item_comments(id,item_id,user_id,author,device_id,kind,body,attachments,meta,created_at)
        VALUES(?,?,?,?,?,'status','',?,?,?)`)
        .run(newId('ic'), id, userId, createdBy, originDeviceId, JSON.stringify(attachments), JSON.stringify({ role: 'body' }), now)
    }
    return { item: getItem(db, userId, id), duplicate: false }
  })()
}

const DECORATE = `
  (SELECT COUNT(*) FROM item_comments c WHERE c.item_id = i.id AND c.kind='comment') AS comment_count,
  (SELECT MAX(created_at) FROM item_comments c WHERE c.item_id = i.id AND c.kind='comment') AS last_comment_at,
  (SELECT COALESCE(attachments,'[]') FROM item_comments c WHERE c.item_id = i.id AND c.kind='status' AND c.meta LIKE '%"role":"body"%' LIMIT 1) AS attachments,
  EXISTS(SELECT 1 FROM item_comments c WHERE c.item_id = i.id AND c.attachments LIKE '%"mime":"image/%') AS has_image,
  (SELECT num FROM missions m WHERE m.id = i.mission_id) AS mission_num
`

export function getItem(db, userId, idOrNum) {
  let row
  if (typeof idOrNum === 'string' && idOrNum.startsWith('it_')) {
    row = db.prepare(`SELECT i.*, ${DECORATE} FROM items i WHERE i.id=? AND i.user_id=?`).get(idOrNum, userId)
  } else {
    const n = Number(String(idOrNum).replace(/^#/, ''))
    if (!Number.isInteger(n) || n < 1) return null
    row = db.prepare(`SELECT i.*, ${DECORATE} FROM items i WHERE i.num=? AND i.user_id=?`).get(n, userId)
  }
  return rowToItem(row)
}

export function listComments(db, itemId) {
  // rowid (not id) as the tiebreaker: id is random hex, so two rows written
  // in the same millisecond (e.g. a comment immediately followed by a
  // close's status row) would otherwise come back in nondeterministic
  // order. rowid reflects actual insertion order for this ordinary table.
  return db.prepare("SELECT * FROM item_comments WHERE item_id=? AND NOT (kind='status' AND meta LIKE '%\"role\":\"body\"%') ORDER BY created_at ASC, rowid ASC")
    .all(itemId).map(rowToComment)
}

// Cursor = base64url of JSON [sortKey, num]; opaque to callers.
const encCursor = (a) => Buffer.from(JSON.stringify(a)).toString('base64url')
const decCursor = (s) => { try { const v = JSON.parse(Buffer.from(String(s), 'base64url').toString()); return Array.isArray(v) && v.length === 2 ? v : null } catch { return null } }

export function listItems(db, userId, {
  convoId = null, kind = null, state = null, awaiting = null, label = null, sort = 'rank', since = null,
  limit = 100, cursor = null, excludePrivateOwned = false,
} = {}) {
  // Default 100, max 500 (spec: listItems). Coerce first — an unclamped
  // string limit went straight into a SQL LIMIT via bind param concatenation
  // and could exceed the page cap or bind a non-numeric value.
  limit = Math.min(Math.max(Number(limit) || 100, 1), 500)
  const where = ['i.user_id = ?']
  const args = [userId]
  if (convoId != null) { where.push('i.origin_convo_id = ?'); args.push(convoId) }
  if (kind != null) { where.push('i.kind = ?'); args.push(kind) }
  if (state != null) { where.push('i.state = ?'); args.push(state) }
  if (awaiting != null) { where.push('i.awaiting = ?'); args.push(awaiting) }
  if (label != null) { where.push('EXISTS (SELECT 1 FROM json_each(i.labels) WHERE value = ?)'); args.push(label) }
  if (since != null) { where.push('i.updated_at >= ?'); args.push(since) }
  if (excludePrivateOwned) {
    // Same shape as searchMessages' excludePrivateOwned (src/search.js): an
    // item filed against a conversation owned by a private device is
    // invisible to an ordinary agent caller. NULL-owner conversations are
    // never private-owned.
    where.push(`NOT EXISTS (SELECT 1 FROM conversations cv JOIN devices d ON d.id = cv.agent_device_id
      WHERE cv.id = i.origin_convo_id AND d.private = 1)`)
  }
  const cur = cursor ? decCursor(cursor) : null
  if (cursor && !cur) return { badCursor: true }
  let order
  if (sort === 'updated') {
    order = 'i.updated_at DESC, i.num DESC'
    if (cur) { where.push('(i.updated_at < ? OR (i.updated_at = ? AND i.num < ?))'); args.push(cur[0], cur[0], cur[1]) }
  } else {
    order = 'i.rank ASC, i.num ASC'
    if (cur) { where.push('(i.rank > ? OR (i.rank = ? AND i.num > ?))'); args.push(cur[0], cur[0], cur[1]) }
  }
  const rows = db.prepare(`SELECT i.*, ${DECORATE} FROM items i WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`)
    .all(...args, limit + 1)
  const page = rows.slice(0, limit).map(rowToItem)
  const last = page[page.length - 1]
  const next_cursor = rows.length > limit && last
    ? encCursor([sort === 'updated' ? last.updated_at : last.rank, last.num])
    : null
  return { items: page, next_cursor }
}

function touch(db, itemId, now) {
  db.prepare('UPDATE items SET updated_at=? WHERE id=?').run(now, itemId)
}

function insertComment(db, { itemId, userId, author, deviceId, kind, body, attachments, meta, idemKey, now }) {
  const id = newId('ic')
  db.prepare(`INSERT INTO item_comments(id,item_id,user_id,author,device_id,kind,body,attachments,meta,idem_key,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, itemId, userId, author, deviceId, kind, body, JSON.stringify(attachments ?? []), meta == null ? null : JSON.stringify(meta), idemKey, now)
  return rowToComment(db.prepare('SELECT * FROM item_comments WHERE id=?').get(id))
}

const ownedRow = (db, userId, itemId) => db.prepare('SELECT * FROM items WHERE id=? AND user_id=?').get(itemId, userId)

export function addComment(db, { userId, itemId, author, deviceId, body = '', attachments = [], idemKey = null, now = Date.now() }) {
  return db.transaction(() => {
    const row = ownedRow(db, userId, itemId)
    if (!row) return null
    if (idemKey) {
      // Scoped to this item: idem_key is only unique per (user_id,
      // idem_key) in the schema, so a key first used on item A and
      // replayed against item B must NOT silently hand back A's comment
      // under B's id. Below, the INSERT itself catches that cross-item
      // reuse via the UNIQUE constraint and reports it as a conflict.
      const dup = db.prepare('SELECT * FROM item_comments WHERE user_id=? AND item_id=? AND idem_key=?').get(userId, itemId, idemKey)
      if (dup) return { item: getItem(db, userId, itemId), comment: rowToComment(dup), duplicate: true }
    }
    let comment
    try {
      comment = insertComment(db, { itemId, userId, author, deviceId, kind: 'comment', body, attachments, meta: null, idemKey, now })
    } catch (err) {
      if (idemKey && err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new Error('idem_key_conflict')
      throw err
    }
    if (author === 'user') {
      // The user's words always hand the ball to the agent, and wake a
      // closed item back up (spec: "any further user comment on a closed
      // item reopens it awaiting the agent").
      db.prepare("UPDATE items SET state='open', resolution=NULL, closed_at=NULL, awaiting='agent', updated_at=? WHERE id=?").run(now, itemId)
    } else {
      touch(db, itemId, now)
    }
    return { item: getItem(db, userId, itemId), comment, duplicate: false }
  })()
}

const statusOf = (row) => ({ state: row.state, resolution: row.resolution, awaiting: row.awaiting })

export function closeItem(db, { userId, itemId, resolution, author, deviceId, comment = '', now = Date.now() }) {
  return db.transaction(() => {
    const row = ownedRow(db, userId, itemId)
    if (!row || row.state === 'closed') return null
    const to = { state: 'closed', resolution, awaiting: null }
    db.prepare("UPDATE items SET state='closed', resolution=?, awaiting=NULL, closed_at=?, updated_at=? WHERE id=?").run(resolution, now, now, itemId)
    const c = insertComment(db, { itemId, userId, author, deviceId, kind: 'status', body: comment, attachments: [], meta: { from: statusOf(row), to }, idemKey: null, now })
    return { item: getItem(db, userId, itemId), comment: c }
  })()
}

export function reopenItem(db, { userId, itemId, author, deviceId, comment = '', now = Date.now() }) {
  return db.transaction(() => {
    const row = ownedRow(db, userId, itemId)
    if (!row || row.state === 'open') return null
    const awaiting = row.kind === 'decision' ? null : defaultAwaiting(row.kind)
    const to = { state: 'open', resolution: null, awaiting }
    db.prepare("UPDATE items SET state='open', resolution=NULL, awaiting=?, closed_at=NULL, updated_at=? WHERE id=?").run(awaiting, now, itemId)
    const c = insertComment(db, { itemId, userId, author, deviceId, kind: 'status', body: comment, attachments: [], meta: { from: statusOf(row), to }, idemKey: null, now })
    return { item: getItem(db, userId, itemId), comment: c }
  })()
}

// `missionId` (undefined = leave it alone, null = detach) rides along with
// the ordinary fields so PATCH /items/:id {title, mission} is ONE transaction
// and ONE `updated_at` bump — see items-http.js's handlePatch. It is an
// explicit move or detach only; never inferred from an agent's tool
// arguments (spec 2026-09-10: Items follow their conversation).
export function updateItem(db, { userId, itemId, fields, missionId, now = Date.now() }) {
  return db.transaction(() => {
    const row = ownedRow(db, userId, itemId)
    if (!row) return null
    const sets = ['updated_at=?']
    const args = [now]
    if (missionId !== undefined) { sets.push('mission_id=?'); args.push(missionId) }
    if (fields.title !== undefined) { sets.push('title=?'); args.push(fields.title) }
    if (fields.body !== undefined) { sets.push('body=?'); args.push(fields.body) }
    if (fields.labels !== undefined) { sets.push('labels=?'); args.push(JSON.stringify(fields.labels)) }
    if (fields.links !== undefined) { sets.push('links=?'); args.push(JSON.stringify(fields.links)) }
    if (fields.awaiting !== undefined) { sets.push('awaiting=?'); args.push(fields.awaiting) }
    db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id=?`).run(...args, itemId)
    return getItem(db, userId, itemId)
  })()
}

export function setAttachmentTranscript(db, { userId, itemId, commentId, blobRef, transcript, now = Date.now() }) {
  return db.transaction(() => {
    const c = db.prepare('SELECT * FROM item_comments WHERE id=? AND item_id=? AND user_id=?').get(commentId, itemId, userId)
    if (!c) return null
    const atts = parseJson(c.attachments, [])
    const target = atts.find((a) => a.blob_ref === blobRef)
    if (!target) return null
    target.transcript = transcript
    db.prepare('UPDATE item_comments SET attachments=? WHERE id=?').run(JSON.stringify(atts), commentId)
    touch(db, itemId, now)
    return rowToComment(db.prepare('SELECT * FROM item_comments WHERE id=?').get(commentId))
  })()
}

export function rerankItem(db, { userId, itemId, position, after, before, now = Date.now() }) {
  return db.transaction(() => {
    const row = ownedRow(db, userId, itemId)
    if (!row) return null
    const rank = resolveRank(db, userId, { position, after, before, excludeId: itemId })
    db.prepare('UPDATE items SET rank=?, updated_at=? WHERE id=?').run(rank, now, itemId)
    return getItem(db, userId, itemId)
  })()
}

