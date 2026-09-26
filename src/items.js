// Task & decision tracker — pure DB state (spec: 2026-09-08
// task-decision-tracker). Every transition lives here so the HTTP layer,
// tests, and any future WS op share one set of rules. No hub, no push, no
// wake: those are src/items-http.js's job.
import { randomBytes } from 'node:crypto'
import { sharedConvoSql } from './visibility.js'

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
export const ACTIONS_MAX = 4
export const ACTION_LABEL_MAX = 40
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

// Item action buttons (2026-09-24 item-actions contract): the one-tap answers
// an agent offers on an item. 0–4 labels, each trimmed to 1–40 chars on a
// single line (no C0/C1 control characters — which covers \n, \r and \t —
// and no Unicode line/paragraph separators), unique case-insensitively so no
// two buttons read the same. Duplicates are refused, not folded: the agent
// asked for two buttons and would silently get one.
const ACTION_BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
function validateActions(list) {
  if (!Array.isArray(list) || list.length > ACTIONS_MAX) return null
  const out = []
  const seen = new Set()
  for (const a of list) {
    if (typeof a !== 'string') return null
    const s = a.trim()
    if (!s || s.length > ACTION_LABEL_MAX || ACTION_BAD_CHARS.test(s)) return null
    const key = s.toLowerCase()
    if (seen.has(key)) return null
    seen.add(key)
    out.push(s)
  }
  return out
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
      // matron:// is the apps' own scheme (item links, consent asks — spec
      // 2026-09-22 consent-items); anything else is refused, javascript: above all.
      if (!/^(https?|matron):\/\//i.test(l.url)) return { ok: false }
      const link = { url: l.url }
      if (l.title !== undefined) {
        if (typeof l.title !== 'string' || l.title.length > TITLE_MAX) return { ok: false }
        link.title = l.title
      }
      value.links.push(link)
    }
  }
  if (fields.actions !== undefined) {
    // The one field with its own error code: the contract names it
    // (`invalid_actions`) so an agent can tell a bad button list apart from
    // any other malformed field.
    const actions = validateActions(fields.actions)
    if (!actions) return { ok: false, error: 'invalid_actions' }
    value.actions = actions
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
  const { labels, links, attachments, actions, idem_key: _idemKey, ...rest } = row
  const out = {
    ...rest,
    labels: parseJson(labels, []),
    links: parseJson(links, []),
    attachments: parseJson(attachments ?? '[]', []),
    actions: parseJson(actions ?? '[]', []),
    chosen_action: rest.chosen_action ?? null,
  }
  if ('comment_count' in out) out.comment_count = Number(out.comment_count)
  if ('has_image' in out) out.has_image = !!out.has_image
  return out
}

// Same internal-column strip as rowToItem, plus `user_id`: every comment
// route is already scoped to the caller's own user, so the field is noise.
// `action` lifts meta.action (the label of the action button the user tapped)
// to the top level, null on every other comment.
export function rowToComment(row) {
  if (!row) return null
  const { attachments, meta, idem_key: _idemKey, user_id: _userId, ...rest } = row
  const m = meta == null ? null : parseJson(meta, null)
  const action = typeof m?.action === 'string' ? m.action : null
  return { ...rest, attachments: parseJson(attachments, []), meta: m, action }
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
  userId, kind, title, body = '', labels = [], links = [], attachments = [], actions = [], awaiting, position, after, before,
  originConvoId, originDeviceId, createdBy, supersedes = null, idemKey = null, consent = null, now = Date.now(),
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
        origin_convo_id,origin_device_id,created_by,idem_key,created_at,updated_at,mission_id,consent,actions)
        VALUES(?,?,?,?,'open',NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, userId, num, kind, aw, rank, title, body, JSON.stringify(labels), JSON.stringify(links), supersedes,
          originConvoId, originDeviceId, createdBy, idemKey, now, now, missionId, consent, JSON.stringify(actions))
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
    let bodyCommentId = null
    if (attachments.length) {
      // Item-body attachments ride on a synthetic first comment of kind
      // 'status' with meta.role='body' so the thread has one place for
      // blob refs; rowToItem exposes them as item.attachments via listItems'
      // decoration query. Simpler than a fourth table.
      bodyCommentId = newId('ic')
      db.prepare(`INSERT INTO item_comments(id,item_id,user_id,author,device_id,kind,body,attachments,meta,created_at)
        VALUES(?,?,?,?,?,'status','',?,?,?)`)
        .run(bodyCommentId, id, userId, createdBy, originDeviceId, JSON.stringify(attachments), JSON.stringify({ role: 'body' }), now)
    }
    // `bodyComment`: the synthetic row above, so the caller can queue its
    // voice notes for transcription exactly like a comment's (null without
    // attachments, and on a duplicate — a replay queues nothing).
    const bodyComment = bodyCommentId ? rowToComment(db.prepare('SELECT * FROM item_comments WHERE id=?').get(bodyCommentId)) : null
    return { item: getItem(db, userId, id), bodyComment, duplicate: false }
  })()
}

const DECORATE = `
  (SELECT COUNT(*) FROM item_comments c WHERE c.item_id = i.id AND c.kind='comment') AS comment_count,
  (SELECT MAX(created_at) FROM item_comments c WHERE c.item_id = i.id AND c.kind='comment') AS last_comment_at,
  (SELECT COALESCE(attachments,'[]') FROM item_comments c WHERE c.item_id = i.id AND c.kind='status' AND c.meta LIKE '%"role":"body"%' LIMIT 1) AS attachments,
  EXISTS(SELECT 1 FROM item_comments c WHERE c.item_id = i.id AND c.attachments LIKE '%"mime":"image/%') AS has_image,
  (SELECT num FROM missions m WHERE m.id = i.mission_id) AS mission_num,
  -- Origin conversation title for client-side provenance labelling (this
  -- session / another session). origin_convo_id already rides on i.*; the
  -- title lets a viewer render "from «that convo»" without a second fetch.
  -- May be '' (conversations.title defaults to '') or NULL if the origin
  -- conversation row is gone; clients treat both as "no title".
  --   owner_user_id = i.user_id: a conversation id is a global PK, so an
  -- orphaned origin_convo_id that a DIFFERENT user later reuses must NOT
  -- disclose that user's title — scope the lookup to the item's own owner
  -- (P2 canonical source: provenance resolves through the item user's convo).
  --   substr(...,1,200): the title is repeated on every row of a page (up to
  -- 500) and copied into durable markers; bound the projection so one
  -- oversized title can't amplify a response or event into hundreds of MiB.
  (SELECT substr(cv.title, 1, 200) FROM conversations cv
     WHERE cv.id = i.origin_convo_id AND cv.owner_user_id = i.user_id) AS origin_convo_title
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
  limit = 100, cursor = null, excludePrivateOwned = false, excludeConsent = false,
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
  if (excludeConsent) where.push('i.consent IS NULL') // the user's alone (isConsentMirror)
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

// Cross-user read (spec 2026-09-23 tracker web/teams, "Reads that widen").
// Rows whose origin conversation passes the shared rule for @viewer, never
// the viewer's own. Ordered newest-updated first; the cursor is
// [updated_at, id] — item ids are random, so unlike `num` they are unique
// across users.
const OWNER_DECORATE = `
  cv.repo AS repo,
  json_object('user_id', u.id, 'name', u.name, 'github_login', ga.login) AS owner_json`
const SHARED_FROM = `FROM items i
  JOIN conversations cv ON cv.id = i.origin_convo_id
  JOIN users u ON u.id = i.user_id
  LEFT JOIN github_accounts ga ON ga.user_id = i.user_id`

function rowToSharedItem(row) {
  if (!row) return null
  const { owner_json: ownerJson, ...rest } = row
  const item = rowToItem(rest)
  item.owner = parseJson(ownerJson, null)
  return item
}

export function listSharedItems(db, viewerUserId, { kind = null, state = null, awaiting = null, limit = 100, cursor = null } = {}) {
  limit = Math.min(Math.max(Number(limit) || 100, 1), 500)
  const where = [sharedConvoSql('cv'), 'i.consent IS NULL']
  const args = { viewer: viewerUserId }
  if (kind != null) { where.push('i.kind = @kind'); args.kind = kind }
  if (state != null) { where.push('i.state = @state'); args.state = state }
  if (awaiting != null) { where.push('i.awaiting = @awaiting'); args.awaiting = awaiting }
  const cur = cursor ? decCursor(cursor) : null
  if (cursor && !cur) return { badCursor: true }
  if (cur) { where.push('(i.updated_at < @cu OR (i.updated_at = @cu AND i.id < @cid))'); args.cu = cur[0]; args.cid = cur[1] }
  const rows = db.prepare(`SELECT i.*, ${DECORATE}, ${OWNER_DECORATE} ${SHARED_FROM}
    WHERE ${where.join(' AND ')} ORDER BY i.updated_at DESC, i.id DESC LIMIT @lim`).all({ ...args, lim: limit + 1 })
  const page = rows.slice(0, limit).map(rowToSharedItem)
  const last = page[page.length - 1]
  const next_cursor = rows.length > limit && last ? encCursor([last.updated_at, last.id]) : null
  return { items: page, next_cursor }
}

export function getSharedItem(db, viewerUserId, itemId) {
  if (typeof itemId !== 'string' || !itemId.startsWith('it_')) return null
  const row = db.prepare(`SELECT i.*, ${DECORATE}, ${OWNER_DECORATE} ${SHARED_FROM}
    WHERE i.id = @id AND i.consent IS NULL AND ${sharedConvoSql('cv')}`).get({ viewer: viewerUserId, id: itemId })
  return rowToSharedItem(row)
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

// `action` (a user's tap on one of the item's action buttons, already
// trimmed by the caller) must name one of the item's CURRENT actions: checked
// here, inside the transaction, so a PATCH that swaps the list can never
// interleave with the check. Throws Error('unknown_action') otherwise. The
// comment records it as meta.action and the item's chosen_action follows it
// in the same write. An idempotent replay is answered before the check — the
// original tap was valid when it landed.
export function addComment(db, { userId, itemId, author, deviceId, body = '', attachments = [], action = null, idemKey = null, now = Date.now() }) {
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
    if (action != null && !parseJson(row.actions, []).includes(action)) throw new Error('unknown_action')
    let comment
    try {
      comment = insertComment(db, { itemId, userId, author, deviceId, kind: 'comment', body, attachments, meta: action == null ? null : { action }, idemKey, now })
    } catch (err) {
      if (idemKey && err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new Error('idem_key_conflict')
      throw err
    }
    if (author === 'user') {
      // The user's words always hand the ball to the agent, and wake a
      // closed item back up (spec: "any further user comment on a closed
      // item reopens it awaiting the agent").
      db.prepare("UPDATE items SET state='open', resolution=NULL, closed_at=NULL, awaiting='agent', updated_at=? WHERE id=?").run(now, itemId)
      if (action != null) db.prepare('UPDATE items SET chosen_action=? WHERE id=?').run(action, itemId)
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
    if (fields.actions !== undefined) {
      const next = JSON.stringify(fields.actions)
      sets.push('actions=?'); args.push(next)
      // A different list is a different question: the old tap no longer
      // answers it. Re-sending the list unchanged (an agent patching every
      // field at once) keeps the user's choice.
      if (next !== row.actions) sets.push('chosen_action=NULL')
    }
    db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id=?`).run(...args, itemId)
    return getItem(db, userId, itemId)
  })()
}

export function setAttachmentTranscript(db, { userId, itemId, commentId, blobRef, transcript, now = Date.now() }) {
  return db.transaction(() => {
    const c = db.prepare('SELECT * FROM item_comments WHERE id=? AND item_id=? AND user_id=?').get(commentId, itemId, userId)
    if (!c) return null
    const atts = parseJson(c.attachments, [])
    // Every attachment naming the blob: the same audio attached twice is the
    // same words twice, and settling only the first would strand the other
    // `pending` forever.
    const targets = atts.filter((a) => a.blob_ref === blobRef)
    if (!targets.length) return null
    for (const target of targets) {
      target.transcript = transcript
      // The origin bridge beat the journal's own job to it (an older bridge
      // transcribes without waiting): the words are in, so it is no longer
      // pending. The job keeps this transcript when it lands (below).
      if (target.transcript_status) target.transcript_status = 'done'
    }
    db.prepare('UPDATE item_comments SET attachments=? WHERE id=?').run(JSON.stringify(atts), commentId)
    touch(db, itemId, now)
    return rowToComment(db.prepare('SELECT * FROM item_comments WHERE id=?').get(commentId))
  })()
}

// --- Journal-side transcription (src/items-transcribe.js) -------------------
// `transcript_status` on an audio attachment: 'pending' while the journal's
// own whisper job owns it, then 'done' or 'failed'. Absent = this journal
// never took the job (transcription off, or a row from before it existed),
// which is what tells a bridge to transcribe the note itself.
export const isAudioAttachment = (a) => typeof a?.mime === 'string' && a.mime.startsWith('audio/')

// Pure. Run on VALIDATED attachments only (validateAttachments drops any
// client-sent status along with every other unknown key).
export function markTranscriptsPending(attachments) {
  return (attachments || []).map((a) => (isAudioAttachment(a) ? { ...a, transcript_status: 'pending' } : a))
}

// The job's write-back. `transcript` null/blank = the attempt failed. Never
// overwrites words that are already there. `settled` is true once no
// attachment on the comment is still pending — the moment the follow-up
// marker may go out. `changed` is false when the attachment was not pending
// (a replayed job), so the caller does not emit a second marker.
export function finishAttachmentTranscript(db, { commentId, blobRef, transcript, now = Date.now() }) {
  return db.transaction(() => {
    const c = db.prepare('SELECT * FROM item_comments WHERE id=?').get(commentId)
    if (!c) return null
    const atts = parseJson(c.attachments, [])
    // All of them, for the same reason as setAttachmentTranscript above.
    const targets = atts.filter((a) => a.blob_ref === blobRef)
    if (!targets.length) return null
    const got = typeof transcript === 'string' && transcript.trim()
    let changed = false
    for (const target of targets) {
      if (target.transcript_status !== 'pending') continue
      changed = true
      const have = typeof target.transcript === 'string' && target.transcript.trim()
      if (!have && got) target.transcript = transcript.trim().slice(0, BODY_MAX)
      target.transcript_status = have || got ? 'done' : 'failed'
    }
    if (changed) {
      db.prepare('UPDATE item_comments SET attachments=? WHERE id=?').run(JSON.stringify(atts), commentId)
      touch(db, c.item_id, now)
    }
    const settled = !atts.some((a) => a.transcript_status === 'pending')
    const failed = atts.some((a) => a.transcript_status === 'failed')
    return {
      changed, settled, failed, userId: c.user_id, deviceId: c.device_id,
      // The synthetic body row of createItem: its voice notes belong to the
      // `created` turn, not to a reply.
      isItemBody: parseJson(c.meta, null)?.role === 'body',
      comment: rowToComment(db.prepare('SELECT * FROM item_comments WHERE id=?').get(commentId)),
      item: getItem(db, c.user_id, c.item_id),
    }
  })()
}

// Boot recovery: comments a previous process left pending (crash or restart
// mid-job). The LIKE is a cheap prefilter; the parsed check is the rule.
export function listPendingTranscripts(db) {
  const rows = db.prepare(`SELECT * FROM item_comments WHERE attachments LIKE '%"transcript_status":"pending"%' ORDER BY created_at`).all()
  const out = []
  for (const row of rows) {
    const seen = new Set() // one job per blob, however often it is attached
    for (const a of parseJson(row.attachments, [])) {
      if (a.transcript_status !== 'pending' || seen.has(a.blob_ref)) continue
      seen.add(a.blob_ref)
      out.push({ commentId: row.id, userId: row.user_id, blobRef: a.blob_ref })
    }
  }
  return out
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


// Is this item the tracker mirror of a consent ask — a spawn or agent-chat
// card (src/consent-items.js, `items.consent` = 'spawn' | 'chat')? Such an
// item is the USER's alone, in every state: while the ask is pending, what
// the user reads there must stay what the journal wrote, and it must stay
// in the open list (the asking agent, prompt-injected, could otherwise
// rewrite the task or close it out of sight); and its body carries the
// very text the card withholds from agents — a spawn's unapproved task, a
// chat ask's justification — which the consent design keeps away from
// every sibling agent, approved or not. So items-http.js treats it as
// invisible to agent callers, exactly as the cards are (isClientOnlyEvent):
// 404 on read and on every mutation, absent from GET /items
// (excludeConsent). Clients are unaffected. The mark lives on the item
// itself, never derived from the row that points at it: a renewed chat ask
// re-points its row's item_id and a device revoke cascades the row away,
// and neither may turn the old mirror into an ordinary item.
export function isConsentMirror(db, itemId) {
  return db.prepare('SELECT consent FROM items WHERE id=?').get(itemId)?.consent != null
}
