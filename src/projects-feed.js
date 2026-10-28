// What a project's page and card roll up from across its missions (Projects
// view v2): decisions and answered questions, files and
// images, every milestone — each paged — plus the three card fields
// (waiting_on, latest, sessions_now). Pure DB reads; every query applies
// the same two sieves as projectDetail: a private device's conversation
// (the item's origin, the event's conversation, the milestone's
// conversation, the comment's device) and a private-origin mission.
import { milestoneRow, ORIGIN_SIEVE } from './missions.js'

export const FEED_KINDS = ['decisions', 'files', 'milestones']
export const FEED_LIMIT_DEFAULT = 20
export const FEED_LIMIT_MAX = 100
// The first page of each kind that GET /projects/:id carries.
export const DETAIL_PAGE = 6
const ANSWER_MAX = 240

const privateDevice = (col) => `EXISTS (SELECT 1 FROM private_devices pd WHERE pd.id = ${col})`
const privateConvo = (alias) => privateDevice(`${alias}.agent_device_id`)

// A page cursor is "<at>:<key>": rows sort by at DESC, then key DESC (a
// fixed-width string, so equal timestamps never skip or repeat a row).
export function parseCursor(raw) {
  if (raw == null) return null
  const m = /^(\d{1,15}):([A-Za-z0-9_:.-]{1,80})$/.exec(raw)
  return m ? { at: Number(m[1]), key: m[2] } : undefined
}
const cursorOf = (row) => `${row.at}:${row.sort_key}`
const pad = (col) => `printf('%012d', ${col})`

function page(db, sql, args, { before, limit }) {
  const where = before ? 'WHERE (f.at < @beforeAt OR (f.at = @beforeAt AND f.sort_key < @beforeKey))' : ''
  const rows = db.prepare(`SELECT * FROM (${sql}) f ${where} ORDER BY f.at DESC, f.sort_key DESC LIMIT @limit`)
    .all({ ...args, beforeAt: before?.at ?? 0, beforeKey: before?.key ?? '', limit: limit + 1 })
  const more = rows.length > limit
  const shown = more ? rows.slice(0, limit) : rows
  return { rows: shown, next_before: more ? cursorOf(shown[shown.length - 1]) : null }
}

const total = (db, sql, args) => db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(args).n

// Decision items (open = in force; closed = decided, done or reversed; a
// cancelled one never took effect and is left out) and
// questions closed as answered, on the project's missions. A decision dates
// from when it was recorded, an answered question from when it closed.
// `answer` is the newest user comment: the tapped label, else its words,
// else a voice note's transcript. Consent cards are never decisions.
function decisionsSql(excludePrivateOwned) {
  const sieve = excludePrivateOwned ? `AND NOT ${privateConvo('c')} AND ${ORIGIN_SIEVE}` : ''
  const answerSieve = excludePrivateOwned ? `AND NOT ${privateDevice('ic.device_id')}` : ''
  return `SELECT i.id, i.num, i.kind, i.state, i.resolution, i.title, i.supersedes, i.created_at, i.closed_at,
      i.mission_id, m.num AS mission_num,
      CASE WHEN i.kind = 'question' THEN i.closed_at ELSE i.created_at END AS at,
      ${pad('i.num')} AS sort_key,
      CASE WHEN i.kind = 'question' THEN (
        SELECT substr(COALESCE(NULLIF(json_extract(ic.meta, '$.action'), ''), NULLIF(ic.body, ''),
                               json_extract(ic.attachments, '$[0].transcript')), 1, ${ANSWER_MAX})
        FROM item_comments ic
        WHERE ic.item_id = i.id AND ic.author = 'user' AND ic.kind = 'comment' AND ic.withdrawn_at IS NULL ${answerSieve}
        ORDER BY ic.created_at DESC, ic.id DESC LIMIT 1) END AS answer
    FROM items i JOIN missions m ON m.id = i.mission_id JOIN conversations c ON c.id = i.origin_convo_id
    WHERE m.project_id = @projectId AND m.user_id = @userId AND i.consent IS NULL
      AND ((i.kind = 'decision' AND COALESCE(i.resolution, '') <> 'cancelled')
           OR (i.kind = 'question' AND i.state = 'closed' AND i.resolution = 'answered'))
      ${sieve}`
}

// Files and images: (a) attachments on comments of the project's items,
// and (b) image/file events in conversations linked to the project's
// missions, posted between the conversation first joining the mission and
// leaving it. A rejoin keeps the first start (first_joined_at); a file
// posted in a gap between two stints counts too, since the link table
// keeps no history of gaps. An event in a conversation
// linked to two of the project's missions is listed once, under the
// lower-numbered mission.
function filesSql(excludePrivateOwned) {
  const itemSieve = excludePrivateOwned
    ? `AND NOT ${privateConvo('c')} AND NOT ${privateDevice('ic.device_id')} AND ${ORIGIN_SIEVE}` : ''
  const eventSieve = excludePrivateOwned ? `AND NOT ${privateConvo('c')} AND ${ORIGIN_SIEVE}` : ''
  return `SELECT 'item' AS source, json_extract(je.value, '$.blob_ref') AS blob_id, json_extract(je.value, '$.name') AS name,
      json_extract(je.value, '$.mime') AS content_type, json_extract(je.value, '$.size') AS size,
      ic.created_at AS at, 'c:' || ic.id || ':' || printf('%03d', je.key) AS sort_key,
      i.num AS item_num, NULL AS convo_id, NULL AS seq, NULL AS caption, m.num AS mission_num
    FROM item_comments ic JOIN items i ON i.id = ic.item_id JOIN missions m ON m.id = i.mission_id
    JOIN conversations c ON c.id = i.origin_convo_id, json_each(ic.attachments) je
    WHERE m.project_id = @projectId AND m.user_id = @userId AND i.consent IS NULL AND ic.withdrawn_at IS NULL ${itemSieve}
  UNION ALL
  SELECT 'chat', e.blob_ref, json_extract(e.payload, '$.name'), json_extract(e.payload, '$.content_type'),
      json_extract(e.payload, '$.size'), e.ts, 'e:' || ${pad('e.seq')}, NULL, e.convo_id, e.seq,
      json_extract(e.payload, '$.caption'), MIN(m.num)
    FROM missions m
    JOIN mission_conversations l ON l.mission_id = m.id
    JOIN conversations c ON c.id = l.convo_id
    JOIN events e ON e.convo_id = l.convo_id AND e.type IN ('image', 'file')
      AND e.ts >= COALESCE(l.first_joined_at, l.joined_at) AND (l.ended_at IS NULL OR e.ts <= l.ended_at)
    WHERE m.project_id = @projectId AND m.user_id = @userId AND +e.user_id = @userId AND e.blob_ref IS NOT NULL ${eventSieve}
    GROUP BY e.seq`
  // `+e.user_id`: the unary plus keeps SQLite off the events primary key
  // (user_id, seq), which it otherwise prefers without ANALYZE statistics,
  // reading every event the user has. With it, each linked conversation is
  // read through idx_events_media (pinned by a test).
}

function milestonesSql(excludePrivateOwned) {
  const sieve = excludePrivateOwned ? `AND NOT ${privateConvo('c')} AND ${ORIGIN_SIEVE}` : ''
  return `SELECT l.*, m.num AS mission_num, l.created_at AS at, ${pad('l.seq')} AS sort_key
    FROM milestones l JOIN missions m ON m.id = l.mission_id JOIN conversations c ON c.id = l.convo_id
    WHERE m.project_id = @projectId AND m.user_id = @userId ${sieve}`
}

const SQL = { decisions: decisionsSql, files: filesSql, milestones: milestonesSql }
// Test seam: the query-plan test reads the files SQL directly.
export const filesSqlForTest = filesSql

const strip = ({ at: _at, sort_key: _key, ...rest }) => rest
const SHAPE = {
  decisions: (r) => strip(r),
  files: ({ source, item_num: itemNum, convo_id: convoId, seq, ...r }) => ({
    ...strip(r),
    posted_at: r.at,
    source: source === 'item' ? { item_num: itemNum } : { convo_id: convoId, seq },
  }),
  milestones: (r) => milestoneRow(strip(r)),
}

// One page of one kind. `before` is a parsed cursor or null.
export function projectFeed(db, userId, project, kind, { before = null, limit = FEED_LIMIT_DEFAULT, excludePrivateOwned = false } = {}) {
  const sql = SQL[kind](excludePrivateOwned)
  const args = { projectId: project.id, userId }
  const out = page(db, sql, args, { before, limit })
  return { kind, total: total(db, sql, args), rows: out.rows.map(SHAPE[kind]), next_before: out.next_before }
}

// The first page of every kind, for GET /projects/:id.
export function feedFirstPages(db, userId, project, { excludePrivateOwned = false } = {}) {
  const out = {}
  for (const kind of FEED_KINDS) {
    const { total: n, rows, next_before: next } = projectFeed(db, userId, project, kind, { limit: DETAIL_PAGE, excludePrivateOwned })
    out[kind] = { total: n, rows, next_before: next }
  }
  return out
}

// The card's three fields for every project of `userId`, in three grouped
// queries: waiting_on (the newest item awaiting the user, plus how many
// more — consent cards included, as in the needs_you count beside it), latest (the newest milestone) and sessions_now (live top-level
// conversations on its open missions — the conversations sessions_by_box
// counts).
export function cardFields(db, userId, { excludePrivateOwned = false } = {}) {
  const sieve = excludePrivateOwned ? `AND NOT ${privateConvo('c')} AND ${ORIGIN_SIEVE}` : ''
  const out = new Map()
  const of = (id) => {
    if (!out.has(id)) out.set(id, { waiting_on: null, latest: null, sessions_now: 0 })
    return out.get(id)
  }
  const waiting = db.prepare(`SELECT m.project_id, i.id AS item_id, i.num, i.kind, i.title, m.num AS mission_num
    FROM items i JOIN missions m ON m.id = i.mission_id JOIN conversations c ON c.id = i.origin_convo_id
    WHERE m.user_id = ? AND m.project_id IS NOT NULL AND i.state = 'open' AND i.awaiting = 'user' ${sieve}
    ORDER BY i.updated_at DESC, i.num DESC`).all(userId)
  for (const { project_id: pid, ...row } of waiting) {
    const f = of(pid)
    if (f.waiting_on) f.waiting_on.more += 1
    else f.waiting_on = { ...row, more: 0 }
  }
  const latest = db.prepare(`SELECT project_id, title, kind, created_at AS at, mission_num FROM (
      SELECT m.project_id, l.title, l.kind, l.created_at, m.num AS mission_num,
        ROW_NUMBER() OVER (PARTITION BY m.project_id ORDER BY l.created_at DESC, l.seq DESC) AS rn
      FROM milestones l JOIN missions m ON m.id = l.mission_id JOIN conversations c ON c.id = l.convo_id
      WHERE m.user_id = ? AND m.project_id IS NOT NULL ${sieve})
    WHERE rn = 1`).all(userId)
  for (const { project_id: pid, ...row } of latest) of(pid).latest = row
  const sessions = db.prepare(`SELECT m.project_id, COUNT(DISTINCT c.id) AS n
    FROM missions m
    JOIN mission_conversations l ON l.mission_id = m.id AND l.ended_at IS NULL
    JOIN conversations c ON c.id = l.convo_id AND c.parent_convo_id IS NULL
    JOIN devices bd ON bd.id = c.agent_device_id AND bd.user_id = c.owner_user_id
    WHERE m.user_id = ? AND m.project_id IS NOT NULL AND m.state = 'open'
      ${excludePrivateOwned ? `AND bd.private = 0 AND ${ORIGIN_SIEVE}` : ''}
    GROUP BY m.project_id`).all(userId)
  for (const { project_id: pid, n } of sessions) of(pid).sessions_now = n
  return out
}
