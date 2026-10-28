// Task & decision tracker — pure DB state (spec: 2026-09-08
// task-decision-tracker). Every transition lives here so the HTTP layer,
// tests, and any future WS op share one set of rules. No hub, no push, no
// wake: those are src/items-http.js's job.
import { randomBytes } from 'node:crypto'
import { sharedConvoSql, grantedMissionSql } from './visibility.js'
import { blobImageDims, isPrivateDevice } from './db.js'
import { yieldTurn } from './background.js'
import { presentWithdrawn } from './withdrawn-comments.js'

export const ITEM_KINDS = ['task', 'question', 'decision', 'notice']
// A notice (mission: For you) is something the user needs to read but not
// decide. Its one action is built in: the journal sets it, an agent cannot
// offer others, and the user's tap on it closes the item (addComment).
export const NOTICE_ACTION = 'Seen'
export const NOTICE_ACTIONS = [NOTICE_ACTION]
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
  if (!Array.isArray(list)) return { ok: false }
  // Named, so a client can say why and split the files across comments
  // rather than show a bare "bad request".
  if (list.length > ATTACHMENTS_MAX) return { ok: false, error: 'too_many_attachments' }
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
  if (!att.ok) return att.error ? { ok: false, error: att.error, max: ATTACHMENTS_MAX } : { ok: false }
  if (fields.attachments !== undefined) value.attachments = att.value
  return { ok: true, value }
}

const parseJson = (s, fallback) => { try { return JSON.parse(s) } catch { return fallback } }

// `idem_key` is an internal column (same stance as toEventShape in
// journal.js): the caller sent the key, so handing it back tells it nothing,
// and echoing another device's key would be a small leak.
// No `now` parameter: this is mapped over row arrays (`rows.map(rowToItem)`),
// where a second positional argument would be the row's index.
export function rowToItem(row) {
  if (!row) return null
  const {
    labels, links, attachments, actions, idem_key: _idemKey,
    turn_requested_at: turnRequestedAt, owner_session_state: sessionState,
    owner_turn_started_at: turnStartedAt, owner_turn_ended_at: turnEndedAt,
    // Internal: where a contributor's replies go (src/contribute.js), never
    // on the wire — least of all to the owner.
    contributor_user_id: _contributorUserId, contributor_convo_id: _contributorConvoId,
    contributor_name: contributorName, contributor_via: contributorVia,
    ...rest
  } = row
  const out = {
    ...rest,
    labels: parseJson(labels, []),
    links: parseJson(links, []),
    attachments: parseJson(attachments ?? '[]', []),
    actions: parseJson(actions ?? '[]', []),
    chosen_action: rest.chosen_action ?? null,
    // Owner-only (see db.js): never on another person's wire, so a row
    // that reaches one is always false there.
    private: !!rest.private,
  }
  // Filed by another person, a contributor to the item's mission: who, in
  // words. Absent on every other item, so their shape is unchanged.
  if (contributorName) out.contributor = { name: contributorName, via: contributorVia ?? 'agent' }
  if ('handover' in out) out.handover = out.handover == null ? null : parseJson(out.handover, null)
  if ('comment_count' in out) out.comment_count = Number(out.comment_count)
  if ('has_image' in out) out.has_image = !!out.has_image
  // Only a decorated row knows its owning conversation's state.
  if ('owner_session_state' in row) out.working = itemWorking({ sessionState, turnStartedAt, turnEndedAt, turnRequestedAt })
  return out
}

// How long an ask may sit `queued` with no turn starting before the item
// stops saying so: long enough for a sleeping box to be started and its
// session resumed, short enough that an ask nobody will pick up (the box is
// gone, the session is stalled) does not look alive for long.
export const WORKING_QUEUED_TTL_MS = 10 * 60 * 1000
// An ask that landed while a turn was in flight is delivered when that turn
// ends, as the next turn. Between the two the session reads idle for a
// moment; `queued` covers the gap for this long after the turn end, and no
// longer — the reply may equally have been taken into the turn that ended.
export const WORKING_HANDOFF_GRACE_MS = 15 * 1000

// An item's `working` block: is the session that owns it busy? What an item
// thread shows a working indicator from, the way a chat does from its own
// conversation's state. Pure, so the rule is testable without a clock.
//   running — the owning conversation is mid-turn (session_state 'running'),
//             whether or not the turn is about this item.
//   queued  — the user said something on the item that reaches the agent as a
//             turn (turnRequestedAt), and no turn has started since: the box
//             is being woken, the session resumed, or the reply is waiting
//             behind the turn in flight.
// `since` is when that state began (null when unknown); `until` is when a
// queued state lapses if nothing else happens — a client drops the indicator
// then without asking again. null = nothing to show.
export function itemWorking({ sessionState, turnStartedAt, turnEndedAt, turnRequestedAt }, now = Date.now()) {
  if (sessionState == null) return null
  if (sessionState === 'running') return { state: 'running', since: turnStartedAt ?? null, until: null }
  if (turnRequestedAt == null) return null
  if (turnStartedAt != null && turnStartedAt > turnRequestedAt) return null
  let until = turnRequestedAt + WORKING_QUEUED_TTL_MS
  if (turnEndedAt != null && turnEndedAt >= turnRequestedAt) until = Math.min(until, turnEndedAt + WORKING_HANDOFF_GRACE_MS)
  return now < until ? { state: 'queued', since: turnRequestedAt, until } : null
}

// Record that the user just asked the item's session for a turn, and answer
// with the item's `working` as it now stands. Called from the one place that
// decides a write wakes the agent (items-http.js emitMarker), so "queued"
// means exactly "a turn is on its way".
export function requestTurn(db, itemId, now = Date.now()) {
  db.prepare('UPDATE items SET turn_requested_at=? WHERE id=?').run(now, itemId)
  const row = db.prepare(`SELECT i.turn_requested_at, ${WORKING_DECORATE} FROM items i WHERE i.id=?`).get(itemId)
  if (!row) return null
  return itemWorking({
    sessionState: row.owner_session_state, turnStartedAt: row.owner_turn_started_at,
    turnEndedAt: row.owner_turn_ended_at, turnRequestedAt: row.turn_requested_at,
  }, now)
}

// Same internal-column strip as rowToItem, plus `user_id`: every comment
// route is already scoped to the caller's own user, so the field is noise.
// `action` lifts meta.action (the label of the action button the user tapped)
// to the top level, null on every other comment; `reply_to` lifts
// meta.reply_to (the id of the comment whose button it was), null when the
// tap answered the item's own buttons. `actions` / `chosen_action` are the
// buttons this comment itself offers and the user's latest tap on them
// (2026-10-04 comment-actions contract): [] / null on every other comment.
// `device_name` / `convo_id` / `convo_title` say who wrote an agent's comment:
// the box, and the conversation (session) on it when the bridge named one.
// All null on a user's comment, on the journal's own lines, and wherever the
// reader may not learn them (hidePrivateAuthors, listSharedComments).
export function rowToComment(row) {
  if (!row) return null
  const { attachments, meta, actions, idem_key: _idemKey, user_id: _userId, withdrawn_at: withdrawnAt, ...rest } = row
  const agent = rest.author === 'agent'
  rest.device_name = agent ? rest.device_name ?? null : null
  rest.convo_id = agent ? rest.convo_id ?? null : null
  rest.convo_title = agent ? rest.convo_title ?? null : null
  const m = meta == null ? null : parseJson(meta, null)
  const action = typeof m?.action === 'string' ? m.action : null
  const replyTo = typeof m?.reply_to === 'string' ? m.reply_to : null
  // `attribution`: who wrote a comment that came from another person, in
  // words — a hand-over copy (src/handover.js) carries "alice" or "alice's
  // agent". Absent on every comment written in this log, so the shape
  // every client already decodes is unchanged.
  const attribution = typeof m?.attribution === 'string' ? { attribution: m.attribution } : {}
  // `contributor` {name, via}: written by a contributor to the item's
  // mission (src/contribute.js). Absent otherwise, like attribution.
  if (m?.contributor && typeof m.contributor.name === 'string') attribution.contributor = { name: m.contributor.name, via: m.contributor.via === 'user' ? 'user' : 'agent' }
  // `withdrawn_at`: when the user cancelled this reply before it reached the
  // agent (src/withdrawn-comments.js). Absent on every other comment, like
  // attribution.
  if (withdrawnAt != null) attribution.withdrawn_at = withdrawnAt
  return {
    ...rest, attachments: parseJson(attachments, []), meta: m, action, reply_to: replyTo, ...attribution,
    actions: parseJson(actions ?? '[]', []), chosen_action: rest.chosen_action ?? null,
  }
}

// Default `awaiting` per kind at creation (spec: Semantics). Also the value
// a reopen restores.
export function defaultAwaiting(kind) {
  if (kind === 'question' || kind === 'notice') return 'user'
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
  originConvoId, originDeviceId, createdBy, supersedes = null, idemKey = null, consent = null, isPrivate = false, now = Date.now(),
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
    // The route has already refused any other list on a notice.
    if (kind === 'notice') actions = NOTICE_ACTIONS
    const rank = resolveRank(db, userId, { position, after, before })
    const id = newId('it')
    const num = nextNum(db, userId)
    const aw = awaiting === undefined ? createDefaultAwaiting(kind, createdBy) : awaiting
    const missionId = db.prepare('SELECT mission_id FROM conversations WHERE id=?').get(originConvoId)?.mission_id ?? null
    try {
      db.prepare(`INSERT INTO items(id,user_id,num,kind,state,resolution,awaiting,rank,title,body,labels,links,supersedes,
        origin_convo_id,origin_device_id,created_by,idem_key,created_at,updated_at,mission_id,consent,actions,private)
        VALUES(?,?,?,?,'open',NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, userId, num, kind, aw, rank, title, body, JSON.stringify(labels), JSON.stringify(links), supersedes,
          originConvoId, originDeviceId, createdBy, idemKey, now, now, missionId, consent, JSON.stringify(actions), isPrivate ? 1 : 0)
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
        .run(bodyCommentId, id, userId, createdBy, originDeviceId, JSON.stringify(withImageDims(db, attachments)), JSON.stringify({ role: 'body' }), now)
    }
    // `bodyComment`: the synthetic row above, so the caller can queue its
    // voice notes for transcription exactly like a comment's (null without
    // attachments, and on a duplicate — a replay queues nothing).
    const bodyComment = bodyCommentId ? commentById(db, bodyCommentId) : null
    return { item: getItem(db, userId, id), bodyComment, duplicate: false }
  })()
}

// The owning conversation's state, for `working` (itemWorking). Same-user
// guard as origin_convo_title below: a stale id reused by another user
// discloses nothing. rowToItem folds these into `working` and drops them.
const WORKING_DECORATE = `
  (SELECT cv.session_state FROM conversations cv WHERE cv.id = i.origin_convo_id AND cv.owner_user_id = i.user_id) AS owner_session_state,
  (SELECT cv.turn_started_at FROM conversations cv WHERE cv.id = i.origin_convo_id AND cv.owner_user_id = i.user_id) AS owner_turn_started_at,
  (SELECT cv.turn_ended_at FROM conversations cv WHERE cv.id = i.origin_convo_id AND cv.owner_user_id = i.user_id) AS owner_turn_ended_at`

// When the user last acted on item `i` (see last_user_input_at below).
const LAST_USER_INPUT = `COALESCE((SELECT MAX(created_at) FROM item_comments c WHERE c.item_id = i.id AND c.author='user'),
    CASE WHEN i.created_by='user' THEN i.created_at END)`

// For you's Done view (state='done'): closed items, and open ones the user
// has answered that no longer wait on them (a question they tapped Go on,
// still open until its agent closes it). Without the open ones, an item the
// user has just acted on was in neither Needs you nor Done. Only an agent's
// item counts while open: one the user filed is work they handed out, not
// something they answered.
const DONE_VIEW = `(i.state = 'closed' OR (i.created_by = 'agent' AND i.awaiting IS NOT 'user' AND ${LAST_USER_INPUT} IS NOT NULL))`

// sort='acted': the user's own last action first, falling back to the close
// time, then the last update — so whatever they just tapped, answered or
// closed tops the list, however long its agent takes to close it.
const ACTED_AT = `COALESCE(${LAST_USER_INPUT}, i.closed_at, i.updated_at)`

// The device that filed item `i`: the writer of its first post. A handover
// (src/item-handover.js) moves origin_device_id to the new owner and keeps
// the filing conversation in filed_convo_id, so a handed-over item is named
// by the box that hosts that conversation.
const FILER_DEVICE = `CASE WHEN i.filed_convo_id IS NULL THEN i.origin_device_id
    ELSE (SELECT fc.agent_device_id FROM conversations fc WHERE fc.id = i.filed_convo_id AND fc.owner_user_id = i.user_id) END`

const DECORATE = `${WORKING_DECORATE},
  -- device_name: the box whose session filed an agent's item, as a comment's
  -- device_name names the box that wrote it, so the item's own post is headed
  -- the same way. NULL on the user's items, a contributor's (they name
  -- themselves), when the device is gone, and when a private box filed into a
  -- conversation that is not private-owned: an ordinary agent can read that
  -- item, and a private box's name never crosses to one (privacy.js).
  (SELECT d.name FROM devices d WHERE i.created_by = 'agent' AND i.contributor_name IS NULL
     AND d.id = ${FILER_DEVICE} AND d.user_id = i.user_id AND d.kind = 'agent'
     AND (NOT EXISTS (SELECT 1 FROM private_devices pd WHERE pd.id = d.id)
          OR EXISTS (SELECT 1 FROM conversations oc JOIN private_devices od ON od.id = oc.agent_device_id
                     WHERE oc.id = i.origin_convo_id))) AS device_name,
  (SELECT COUNT(*) FROM item_comments c WHERE c.item_id = i.id AND c.kind='comment') AS comment_count,
  (SELECT MAX(created_at) FROM item_comments c WHERE c.item_id = i.id AND c.kind='comment') AS last_comment_at,
  -- When the user last acted on the item: their latest comment, action tap,
  -- close or reopen (every one is an item_comments row with author 'user'),
  -- else the filing time of an item they filed themselves. NULL for an item
  -- only agents have touched. Lets a client order closed items by the
  -- user's own last input rather than by when an agent closed them. Every
  -- one of those writes also bumps updated_at, so a since delta carries it.
  ${LAST_USER_INPUT} AS last_user_input_at,
  (SELECT COALESCE(attachments,'[]') FROM item_comments c WHERE c.item_id = i.id AND c.kind='status' AND c.meta LIKE '%"role":"body"%' LIMIT 1) AS attachments,
  EXISTS(SELECT 1 FROM item_comments c WHERE c.item_id = i.id AND c.attachments LIKE '%"mime":"image/%') AS has_image,
  (SELECT num FROM missions m WHERE m.id = i.mission_id) AS mission_num,
  -- Title of the origin conversation, so a client can label an item's
  -- provenance ("this session" / "from <that conversation>") without a second
  -- fetch. NULL when the conversation is untitled ('' is the column default)
  -- or its row is gone, so clients have one "no title" sentinel.
  --   owner_user_id = i.user_id: conversation ids are a global PK, so an
  -- orphaned origin_convo_id reused by a different user must not disclose
  -- that user's title.
  --   substr(...,1,200): the title repeats on every row of a page (up to 500)
  -- and on every item in an {item} response; bound it so one oversized title
  -- can't amplify a response.
  (SELECT NULLIF(substr(cv.title, 1, 200), '') FROM conversations cv
     WHERE cv.id = i.origin_convo_id AND cv.owner_user_id = i.user_id) AS origin_convo_title,
  -- Item handover (src/item-handover.js): the offer waiting on the user or on
  -- the target session, if any — enough for an app to say "Offered to …"
  -- and for an agent to see it without a second fetch. Same title bound and
  -- same-user guard as origin_convo_title.
  (SELECT json_object('id', h.id, 'state', h.state, 'from_convo_id', h.from_convo_id, 'to_convo_id', h.to_convo_id,
       'to_convo_title', (SELECT NULLIF(substr(tc.title, 1, 200), '') FROM conversations tc WHERE tc.id = h.to_convo_id AND tc.owner_user_id = h.user_id),
       'note', h.note, 'created_at', h.created_at, 'expires_at', h.expires_at)
     FROM item_handovers h WHERE h.item_id = i.id AND h.state IN ('awaiting_user','offered')) AS handover
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

// Every comment read goes through this SELECT so the author's names ride on
// the row. Same-user guards and the title bound as ITEM_DECOR's
// origin_convo_title: a stale id reused by another user discloses nothing.
const COMMENT_SELECT = `SELECT c.*,
  (SELECT d.name FROM devices d WHERE d.id = c.device_id AND d.user_id = c.user_id AND d.kind = 'agent') AS device_name,
  (SELECT NULLIF(substr(cv.title, 1, 200), '') FROM conversations cv
     WHERE cv.id = c.convo_id AND cv.owner_user_id = c.user_id) AS convo_title
  FROM item_comments c`
const commentById = (db, id) => rowToComment(db.prepare(`${COMMENT_SELECT} WHERE c.id=?`).get(id))

// An ordinary agent may not learn a private box's name or its conversations
// (privacy.js): to it, a private box's comment has an author it cannot name.
// The conversation is sieved on its own as well: a public box that has
// joined a private box's conversation may name it on its comment, and that
// conversation's id and title are no more an ordinary agent's to read than
// the items filed in it. The public box's own name still shows.
export function hidePrivateAuthors(db, comments) {
  const privDevice = new Map()
  const privConvo = new Map()
  const memo = (map, key, probe) => { if (!map.has(key)) map.set(key, probe(key)); return map.get(key) }
  const hostIsPrivate = db.prepare(`SELECT 1 FROM conversations c JOIN private_devices d ON d.id = c.agent_device_id
    WHERE c.id = ?`)
  return comments.map((c) => {
    if (c.device_name == null && c.convo_id == null) return c
    if (memo(privDevice, c.device_id, (id) => isPrivateDevice(db, id))) return { ...c, device_name: null, convo_id: null, convo_title: null }
    if (c.convo_id != null && memo(privConvo, c.convo_id, (id) => !!hostIsPrivate.get(id))) return { ...c, convo_id: null, convo_title: null }
    return c
  })
}

export function listComments(db, itemId) {
  // rowid (not id) as the tiebreaker: id is random hex, so two rows written
  // in the same millisecond (e.g. a comment immediately followed by a
  // close's status row) would otherwise come back in nondeterministic
  // order. rowid reflects actual insertion order for this ordinary table.
  return db.prepare(`${COMMENT_SELECT} WHERE c.item_id=? AND NOT (c.kind='status' AND c.meta LIKE '%"role":"body"%') ORDER BY c.created_at ASC, c.rowid ASC`)
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
  // An array is "any of these" — how an app that predates notices still
  // finds them under kind=task (items-http.js handleList).
  if (Array.isArray(kind)) { where.push(`i.kind IN (${kind.map(() => '?').join(',')})`); args.push(...kind) }
  else if (kind != null) { where.push('i.kind = ?'); args.push(kind) }
  if (state === 'done') where.push(DONE_VIEW)
  else if (state != null) { where.push('i.state = ?'); args.push(state) }
  if (awaiting != null) { where.push('i.awaiting = ?'); args.push(awaiting) }
  if (label != null) { where.push('EXISTS (SELECT 1 FROM json_each(i.labels) WHERE value = ?)'); args.push(label) }
  if (since != null) { where.push('i.updated_at >= ?'); args.push(since) }
  if (excludePrivateOwned) {
    // Same shape as searchMessages' excludePrivateOwned (src/search.js): an
    // item filed against a conversation owned by a private device is
    // invisible to an ordinary agent caller. NULL-owner conversations are
    // never private-owned.
    where.push(`NOT EXISTS (SELECT 1 FROM conversations cv JOIN private_devices d ON d.id = cv.agent_device_id
      WHERE cv.id = i.origin_convo_id)`)
  }
  if (excludeConsent) where.push('i.consent IS NULL') // the user's alone (isConsentMirror)
  const cur = cursor ? decCursor(cursor) : null
  if (cursor && !cur) return { badCursor: true }
  if (sort === 'acted') {
    if (cur) { where.push(`(${ACTED_AT} < ? OR (${ACTED_AT} = ? AND i.num < ?))`); args.push(cur[0], cur[0], cur[1]) }
    // The page is picked on the bare rows first: decorating every candidate
    // before the sort would run DECORATE's subqueries over the user's whole
    // history (thousands of closed items) for one page.
    const rows = db.prepare(`SELECT i.*, ${DECORATE}, p.acted_at FROM
      (SELECT i.id, i.num, ${ACTED_AT} AS acted_at FROM items i WHERE ${where.join(' AND ')}
        ORDER BY acted_at DESC, i.num DESC LIMIT ?) p
      JOIN items i ON i.id = p.id ORDER BY p.acted_at DESC, p.num DESC`).all(...args, limit + 1)
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    const next_cursor = rows.length > limit && last ? encCursor([last.acted_at, last.num]) : null
    return { items: page.map(({ acted_at: _, ...row }) => rowToItem(row)), next_cursor }
  }
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

// The grant rule for an item (spec 2026-10-02 matron-to-matron sharing): it
// sits on a mission granted to @viewer, is not a consent mirror (callers add
// i.consent IS NULL), is not owner-only (`private`, db.js), and was not
// filed from a private box — the same sieve the grantee's mission view
// applies (missions.js grantedMissionDetail).
const GRANTED_ITEM = `(i.mission_id IS NOT NULL AND i.private = 0 AND EXISTS (
    SELECT 1 FROM missions m WHERE m.id = i.mission_id AND m.user_id = i.user_id
      AND NOT EXISTS (SELECT 1 FROM conversations mo JOIN private_devices md ON md.id = mo.agent_device_id
                      WHERE mo.id = m.origin_convo_id)
      AND ${grantedMissionSql('m')})
  AND NOT EXISTS (SELECT 1 FROM conversations pc JOIN private_devices pd ON pd.id = pc.agent_device_id
                  WHERE pc.id = i.origin_convo_id))`
// LEFT JOIN: a granted item is readable even when its origin conversation's
// row is gone; the org rule (which needs the row) is false for it either way.
const SHARED_OR_GRANTED_FROM = `FROM items i
  LEFT JOIN conversations cv ON cv.id = i.origin_convo_id
  JOIN users u ON u.id = i.user_id
  LEFT JOIN github_accounts ga ON ga.user_id = i.user_id`
const ORG_SHARED = `(cv.id IS NOT NULL AND ${sharedConvoSql('cv')})`

// `org_shared` 0 = the row is readable through a grant alone: nothing that
// names a conversation, a device or a repo crosses, and the action buttons
// (the owner's to tap) are not offered. '' and 0 rather than null for the
// two origin fields the apps' item model requires.
function rowToSharedItem(row) {
  if (!row) return null
  const { owner_json: ownerJson, org_shared: orgShared, ...rest } = row
  const item = rowToItem(rest)
  item.owner = parseJson(ownerJson, null)
  // Item handover (src/item-handover.js) names conversations that need not
  // pass the sharing rule themselves, and the filing box is the user's own:
  // never shown to another person (listSharedComments drops a comment's).
  Object.assign(item, { filed_convo_id: null, handover: null, device_name: null })
  // Whether the owner's session is busy is the owner's to see.
  delete item.working
  if (orgShared === 0) {
    Object.assign(item, {
      shared_via: 'grant', origin_convo_id: '', origin_device_id: 0, origin_convo_title: null, repo: null,
      actions: [], chosen_action: null,
    })
  }
  return item
}

// A grantee's comment thread: who said what and when, never from which
// device. A comment's action buttons are the owner's to tap, so they are not
// offered — the same strip rowToSharedItem applies to the item's own.
export function listGrantedComments(db, itemId) {
  return listSharedComments(db, itemId).map((c) => ({ ...c, device_id: 0, actions: [], chosen_action: null }))
}

// Another person's view of a thread: the handover lines (src/item-handover.js)
// are dropped — they name the user's conversations and boxes — and so are
// the author's box and conversation on every comment. A reply the user
// withdrew (src/withdrawn-comments.js) shows without its words.
export function listSharedComments(db, itemId) {
  return listComments(db, itemId).filter((c) => !c.meta?.handover)
    .map((c) => presentWithdrawn({ ...c, device_name: null, convo_id: null, convo_title: null }))
}

export function listSharedItems(db, viewerUserId, { kind = null, state = null, awaiting = null, limit = 100, cursor = null } = {}) {
  limit = Math.min(Math.max(Number(limit) || 100, 1), 500)
  // Owner-only items (`private`) stay out of every other person's read,
  // the org rule included.
  const where = [`(${ORG_SHARED} OR ${GRANTED_ITEM})`, 'i.consent IS NULL', 'i.private = 0']
  const args = { viewer: viewerUserId }
  if (Array.isArray(kind)) { where.push(`i.kind IN (${kind.map((_, i) => `@kind${i}`).join(',')})`); kind.forEach((k, i) => { args[`kind${i}`] = k }) }
  else if (kind != null) { where.push('i.kind = @kind'); args.kind = kind }
  if (state != null) { where.push('i.state = @state'); args.state = state }
  if (awaiting != null) { where.push('i.awaiting = @awaiting'); args.awaiting = awaiting }
  const cur = cursor ? decCursor(cursor) : null
  if (cursor && !cur) return { badCursor: true }
  if (cur) { where.push('(i.updated_at < @cu OR (i.updated_at = @cu AND i.id < @cid))'); args.cu = cur[0]; args.cid = cur[1] }
  const rows = db.prepare(`SELECT i.*, ${DECORATE}, ${OWNER_DECORATE}, ${ORG_SHARED} AS org_shared ${SHARED_OR_GRANTED_FROM}
    WHERE ${where.join(' AND ')} ORDER BY i.updated_at DESC, i.id DESC LIMIT @lim`).all({ ...args, lim: limit + 1 })
  const page = rows.slice(0, limit).map(rowToSharedItem)
  const last = page[page.length - 1]
  const next_cursor = rows.length > limit && last ? encCursor([last.updated_at, last.id]) : null
  return { items: page, next_cursor }
}

export function getSharedItem(db, viewerUserId, itemId) {
  if (typeof itemId !== 'string' || !itemId.startsWith('it_')) return null
  const row = db.prepare(`SELECT i.*, ${DECORATE}, ${OWNER_DECORATE}, ${ORG_SHARED} AS org_shared ${SHARED_OR_GRANTED_FROM}
    WHERE i.id = @id AND i.consent IS NULL AND i.private = 0 AND (${ORG_SHARED} OR ${GRANTED_ITEM})`).get({ viewer: viewerUserId, id: itemId })
  return rowToSharedItem(row)
}

function touch(db, itemId, now) {
  db.prepare('UPDATE items SET updated_at=? WHERE id=?').run(now, itemId)
}

// Stamps each image attachment with its blob's displayed width/height (spec:
// 2026-10-01 item thread layout shift) so the apps can reserve the image's box
// before its bytes load. Server-attested, like transcripts: a size a client
// sends is dropped by validateAttachments, and only the blob's own header is
// believed. A blob that can't be sized (gone, not an image) adds nothing.
export function withImageDims(db, attachments) {
  return (attachments ?? []).map((a) => {
    if (typeof a?.mime !== 'string' || !a.mime.startsWith('image/')) return a
    const dims = blobImageDims(db, a.blob_ref)
    return dims ? { ...a, width: dims.width, height: dims.height } : a
  })
}

export function insertComment(db, { itemId, userId, author, deviceId, convoId = null, kind, body, attachments, meta, actions = [], idemKey, now }) {
  attachments = withImageDims(db, attachments)
  const id = newId('ic')
  db.prepare(`INSERT INTO item_comments(id,item_id,user_id,author,device_id,convo_id,kind,body,attachments,meta,idem_key,created_at,actions)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, itemId, userId, author, deviceId, author === 'agent' ? convoId : null, kind, body, JSON.stringify(attachments ?? []), meta == null ? null : JSON.stringify(meta), idemKey, now, JSON.stringify(actions ?? []))
  return commentById(db, id)
}

const ownedRow = (db, userId, itemId) => db.prepare('SELECT * FROM items WHERE id=? AND user_id=?').get(itemId, userId)

// `action` (a user's tap on an action button, already trimmed by the caller)
// must name one of the CURRENT actions of what it answers: the comment
// `replyTo` names (a follow-up question in this item's thread — 2026-10-04
// comment-actions contract), or the item itself when `replyTo` is null.
// Checked here, inside the transaction, so a PATCH that swaps the list can
// never interleave with the check. Throws Error('unknown_action') otherwise —
// a `replyTo` that is not a comment of this item included. The comment
// records it as meta.action (+ meta.reply_to) and the answered row's
// chosen_action follows it in the same write: the asking comment's for a
// reply, the item's otherwise — never both. An idempotent replay is answered
// before the check — the original tap was valid when it landed.
//
// `actions` (already validated; an agent's comment only — the route refuses
// a client's) are the one-tap answers this comment offers. A non-empty list
// is a question to the user, so it hands them the item in the same write.
// A closed item cannot await anyone: Error('item_closed'), nothing written.
//
// `keepStatus` is for a consent mirror (isConsentMirror): its status belongs
// to the ask it mirrors, so a user's comment is recorded but neither hands
// the item to an agent (none can see it) nor reopens it.
export function addComment(db, { userId, itemId, author, deviceId, convoId = null, body = '', attachments = [], action = null, replyTo = null, actions = [], idemKey = null, keepStatus = false, now = Date.now() }) {
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
      if (dup) return { item: getItem(db, userId, itemId), comment: commentById(db, dup.id), duplicate: true }
    }
    const asks = actions.length > 0
    if (asks && row.state === 'closed') throw new Error('item_closed')
    let asked = null
    if (replyTo != null) {
      // No tap without a label: a bare reply_to is not a thing in v1.
      if (action == null) throw new Error('unknown_action')
      asked = db.prepare("SELECT id, actions FROM item_comments WHERE id=? AND item_id=? AND kind='comment'").get(replyTo, itemId)
      if (!asked || !parseJson(asked.actions, []).includes(action)) throw new Error('unknown_action')
    } else if (action != null && !parseJson(row.actions, []).includes(action)) {
      throw new Error('unknown_action')
    }
    // A notice's Seen tap (mission: For you) is the user's last word on it:
    // the item closes as done in this write instead of being handed to the
    // agent, so it neither reopens awaiting anyone nor wakes a box. A tap on
    // a notice that is already closed (a second device, a stale screen)
    // changes nothing — the same answer as a replay.
    const seen = row.kind === 'notice' && author === 'user' && action === NOTICE_ACTION && asked == null && !keepStatus
    if (seen && row.state === 'closed') return { item: getItem(db, userId, itemId), comment: null, duplicate: true, seen: true }
    const meta = action == null ? null : (asked ? { action, reply_to: asked.id } : { action })
    let comment
    try {
      comment = insertComment(db, { itemId, userId, author, deviceId, convoId, kind: 'comment', body, attachments, meta, actions, idemKey, now })
    } catch (err) {
      if (idemKey && err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new Error('idem_key_conflict')
      throw err
    }
    if (seen) {
      const to = { state: 'closed', resolution: 'done', awaiting: null }
      db.prepare("UPDATE items SET state='closed', resolution='done', awaiting=NULL, closed_at=?, updated_at=?, chosen_action=? WHERE id=?")
        .run(now, now, action, itemId)
      const status = insertComment(db, { itemId, userId, author, deviceId, kind: 'status', body: '', attachments: [], meta: { from: statusOf(row), to, seen: true }, idemKey: null, now })
      return { item: getItem(db, userId, itemId), comment, status, duplicate: false, seen: true }
    }
    if (author === 'user' && !keepStatus) {
      // The user's words always hand the ball to the agent, and wake a
      // closed item back up (spec: "any further user comment on a closed
      // item reopens it awaiting the agent").
      db.prepare("UPDATE items SET state='open', resolution=NULL, closed_at=NULL, awaiting='agent', updated_at=? WHERE id=?").run(now, itemId)
    } else if (asks) {
      db.prepare("UPDATE items SET awaiting='user', updated_at=? WHERE id=?").run(now, itemId)
    } else {
      touch(db, itemId, now)
    }
    // The tap is recorded whoever's status rule applied above: a consent
    // mirror keeps its status (keepStatus) but the choice was still made.
    if (author === 'user' && action != null) {
      if (asked) db.prepare('UPDATE item_comments SET chosen_action=? WHERE id=?').run(action, asked.id)
      else if (!keepStatus) db.prepare('UPDATE items SET chosen_action=? WHERE id=?').run(action, itemId)
    }
    return { item: getItem(db, userId, itemId), comment, duplicate: false }
  })()
}

const statusOf = (row) => ({ state: row.state, resolution: row.resolution, awaiting: row.awaiting })

// `meta` is merged into the status row's own: a contributor's close
// (src/contribute.js) says who closed it.
export function closeItem(db, { userId, itemId, resolution, author, deviceId, convoId = null, comment = '', meta = null, now = Date.now() }) {
  return db.transaction(() => {
    const row = ownedRow(db, userId, itemId)
    if (!row || row.state === 'closed') return null
    const to = { state: 'closed', resolution, awaiting: null }
    db.prepare("UPDATE items SET state='closed', resolution=?, awaiting=NULL, closed_at=?, updated_at=? WHERE id=?").run(resolution, now, now, itemId)
    const c = insertComment(db, { itemId, userId, author, deviceId, convoId, kind: 'status', body: comment, attachments: [], meta: { ...meta, from: statusOf(row), to }, idemKey: null, now })
    return { item: getItem(db, userId, itemId), comment: c }
  })()
}

export function reopenItem(db, { userId, itemId, author, deviceId, convoId = null, comment = '', meta = null, now = Date.now() }) {
  return db.transaction(() => {
    const row = ownedRow(db, userId, itemId)
    if (!row || row.state === 'open') return null
    const awaiting = row.kind === 'decision' ? null : defaultAwaiting(row.kind)
    const to = { state: 'open', resolution: null, awaiting }
    db.prepare("UPDATE items SET state='open', resolution=NULL, awaiting=?, closed_at=NULL, updated_at=? WHERE id=?").run(awaiting, now, itemId)
    // A reopened notice is unread again: its Seen button goes back live.
    if (row.kind === 'notice') db.prepare('UPDATE items SET chosen_action=NULL WHERE id=?').run(itemId)
    const c = insertComment(db, { itemId, userId, author, deviceId, convoId, kind: 'status', body: comment, attachments: [], meta: { ...meta, from: statusOf(row), to }, idemKey: null, now })
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
      // Who wrote the words (said.js's rule for chat voice notes, carried to
      // items): an agent's PATCH is never the user's own evidence, even when
      // it overwrites words the journal wrote.
      target.transcript_by = 'agent'
      // When the words landed — what runExpireVoiceNotes (retention.js)
      // measures the audio's 7-day life from. Rows from before this stamp
      // fall back to the comment's created_at there.
      target.transcribed_at = now
      // The origin bridge beat the journal's own job to it (an older bridge
      // transcribes without waiting): the words are in, so it is no longer
      // pending. The job keeps this transcript when it lands (below).
      if (target.transcript_status) target.transcript_status = 'done'
    }
    db.prepare('UPDATE item_comments SET attachments=? WHERE id=?').run(JSON.stringify(atts), commentId)
    touch(db, itemId, now)
    return commentById(db, commentId)
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
      if (!have && got) {
        target.transcript = transcript.trim().slice(0, BODY_MAX)
        // The journal's own job wrote these words: a guarded agent may take
        // them as the user's (setAttachmentTranscript stamps 'agent').
        target.transcript_by = 'journal'
      }
      target.transcript_status = have || got ? 'done' : 'failed'
      // Same stamp as setAttachmentTranscript; a failed attempt is not a
      // transcription, so it starts no clock on the audio.
      if ((have || got) && !Number.isInteger(target.transcribed_at)) target.transcribed_at = now
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
      comment: commentById(db, commentId),
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

// Stamps width/height onto the image attachments of comments written before
// the journal recorded image sizes (spec: 2026-10-01 item thread layout
// shift). Fire-and-forget after listen, like the search backfill: batched by
// rowid with a yield between batches, so a large thread history never holds
// the event loop. Idempotent — a row whose images already carry a size (or
// whose blob can't be sized) is left as it is, and a re-run after a restart
// mid-walk just finds less to do. Each blob's header is read at most once
// ever (blobImageDims caches the answer on the blob row).
export async function backfillImageDims(db, { batchSize = 50, log = () => {}, shouldStop = () => false, pause = yieldTurn } = {}) {
  const select = db.prepare(`SELECT rowid, id, attachments FROM item_comments
    WHERE rowid>? AND attachments LIKE '%"mime":"image/%' ORDER BY rowid LIMIT ?`)
  const update = db.prepare('UPDATE item_comments SET attachments=? WHERE id=?')
  let cursor = 0
  let updated = 0
  for (;;) {
    if (shouldStop()) break
    const rows = select.all(cursor, batchSize)
    if (rows.length === 0) break
    db.transaction(() => {
      for (const row of rows) {
        const atts = parseJson(row.attachments, null)
        if (!Array.isArray(atts)) continue
        const missing = atts.some((a) => typeof a?.mime === 'string' && a.mime.startsWith('image/') && !(a.width > 0 && a.height > 0))
        if (!missing) continue
        const stamped = withImageDims(db, atts)
        const next = JSON.stringify(stamped)
        if (next !== row.attachments) {
          update.run(next, row.id)
          updated++
        }
      }
    })()
    cursor = rows[rows.length - 1].rowid
    await pause()
  }
  if (updated > 0) log(`items: stamped image sizes on ${updated} comment(s)`)
  return { updated }
}
