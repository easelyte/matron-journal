// Weekly timeline: per-user time zone and local-week arithmetic (spec
// 2026-11-09 projects timeline). A "week" is Monday 00:00 to the next Monday
// 00:00 in the user's own zone, so a week spanning a clock change is 167 or
// 169 hours long. Every function takes and returns epoch milliseconds, except
// the week key, which is the local date of the Monday as 'YYYY-MM-DD'.

import { Cron } from 'croner'
import { DEFAULT_TZ, validTz } from './routines.js'
import { ORIGIN_SIEVE, statusPrivateSql } from './missions.js'
import { privateDevice, privateConvo, filesSql, parseCursor } from './projects-feed.js'
import { PROJECT_ORIGIN_SIEVE, resolveProject } from './projects.js'
import { writtenWeek, writtenWeeks, projectNotes } from './week-stories.js'

const MONDAY_MIDNIGHT = '0 0 * * 1'
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

// Week maths runs on the request path of a synchronous server, and a list
// read asks for the same few boundaries hundreds of times, so the zone check,
// the per-zone Cron and every computed boundary are memoised (each map is
// cleared when it grows past its cap; a boundary never changes for a zone).
const CACHE_MAX = 50_000
const remember = (map, key, compute) => {
  if (map.has(key)) return map.get(key)
  if (map.size >= CACHE_MAX) map.clear()
  const value = compute()
  map.set(key, value)
  return value
}
const zoneChecks = new Map()
const crons = new Map()
const boundaries = new Map()
let cronRuns = 0
// Test seam: how many croner run computations have happened so far.
export const cronRunsForTest = () => cronRuns

const zoneOf = (tz) => (remember(zoneChecks, tz, () => validTz(tz)) ? tz : DEFAULT_TZ)
const mondays = (zone) => remember(crons, zone, () => new Cron(MONDAY_MIDNIGHT, { timezone: zone }))

export function userTimeZone(db, userId) {
  const row = db.prepare('SELECT time_zone FROM users WHERE id = ?').get(userId)
  return row ? zoneOf(row.time_zone) : DEFAULT_TZ
}

// The local Monday 00:00 at or before `ms`. croner counts in whole seconds and
// returns runs strictly before its reference, so the reference is a second on.
// Not memoised by `ms` (any instant); week starts themselves go through the
// cached boundaries below.
export function weekStartOf(ms, tz) {
  cronRuns += 1
  return mondays(zoneOf(tz)).previousRuns(1, new Date(ms + 1000))[0].getTime()
}

// The next local Monday 00:00 after `weekStart`.
export function weekEndOf(weekStart, tz) {
  const zone = zoneOf(tz)
  return remember(boundaries, `${zone}|end|${weekStart}`, () => {
    cronRuns += 1
    return mondays(zone).nextRun(new Date(weekStart)).getTime()
  })
}

export function previousWeekStart(weekStart, tz) {
  const zone = zoneOf(tz)
  return remember(boundaries, `${zone}|prev|${weekStart}`, () => weekStartOf(weekStart - 1, zone))
}

// The local calendar date of the instant, 'YYYY-MM-DD'.
export function formatWeekKey(weekStart, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zoneOf(tz), year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(weekStart))
  const get = (type) => parts.find((p) => p.type === type).value
  return `${get('year')}-${get('month')}-${get('day')}`
}

// The Monday-00:00 instant a week key names, or null when the key is not a
// real calendar date or not a Monday in `tz`.
export function parseWeekKey(key, tz) {
  const m = typeof key === 'string' ? KEY_RE.exec(key) : null
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const noon = new Date(Date.UTC(y, mo - 1, d, 12))
  if (noon.getUTCFullYear() !== y || noon.getUTCMonth() !== mo - 1 || noon.getUTCDate() !== d) return null
  // UTC noon of the date lies inside that date's local week in every zone
  // (local time is between 00:00 that day and 02:00 the next), so the week
  // start found from it is the key's Monday exactly when the key is a Monday.
  const start = weekStartOf(noon.getTime(), tz)
  return formatWeekKey(start, tz) === key ? start : null
}

// What counts as a project "moving" in a window (spec 2026-11-09 projects
// timeline): a milestone posted, an item created or closed, a user-visible
// comment on an item, a mission created or closed. Chat traffic and a project
// status edit are not moves. Each move is credited to the surviving project
// when the mission's project was merged into another (merges flatten, so one
// hop reaches the survivor). `excludePrivateOwned` applies the same two sieves
// as the project feed: a private device's conversation or comment, and a
// mission born in a private device's conversation.
//
// The six kinds of move are written once, as `moveArms`, and read two ways:
// for every project of the user at once (`movesSql`), and for one project
// through its own missions (`projectMovesSql`). `cols` is what an arm selects
// before its instant, `join` what it joins to the mission `m`, `scope` which
// missions it takes and `consent` how it leaves consent cards out.
function moveArms(excludePrivateOwned, { cols = '', join = '', scope, consent }) {
  const convoSieve = convoSieveOf(excludePrivateOwned)
  const commentSieve = excludePrivateOwned ? `AND NOT ${privateDevice('ic.device_id')}` : ''
  const originSieve = excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''
  const ofItem = `JOIN missions m ON m.id = i.mission_id ${join}
      JOIN conversations c ON c.id = i.origin_convo_id
      WHERE ${scope} AND ${consent}`
  return `SELECT ${cols}l.created_at AS at
      FROM milestones l JOIN missions m ON m.id = l.mission_id ${join}
      JOIN conversations c ON c.id = l.convo_id
      WHERE ${scope} ${convoSieve}
    UNION ALL
    SELECT ${cols}i.created_at AS at
      FROM items i ${ofItem} ${convoSieve}
    UNION ALL
    SELECT ${cols}i.closed_at AS at
      FROM items i ${ofItem} AND i.closed_at IS NOT NULL ${convoSieve}
    UNION ALL
    SELECT ${cols}ic.created_at AS at
      FROM item_comments ic JOIN items i ON i.id = ic.item_id ${ofItem}
        AND ic.kind = 'comment' AND ic.withdrawn_at IS NULL ${convoSieve} ${commentSieve}
    UNION ALL
    SELECT ${cols}m.created_at AS at
      FROM missions m ${join}
      WHERE ${scope} ${originSieve}
    UNION ALL
    SELECT ${cols}m.closed_at AS at
      FROM missions m ${join}
      WHERE ${scope} AND m.closed_at IS NOT NULL ${originSieve}`
}

// Every move of the user (@userId) as (project_id, at). Each arm starts from
// the user's missions (idx_missions_user_state) and reads each one's
// milestones, items and comments through their own indexes (pinned by a
// test). `+i.consent` holds that without ANALYZE statistics: it keeps SQLite
// off idx_items_consent, which it otherwise prefers, reading nearly every
// item of every user for the all-projects list and each week read.
const movesSql = (excludePrivateOwned) => moveArms(excludePrivateOwned, {
  cols: 'COALESCE(p.merged_into, p.id) AS project_id, ',
  join: 'JOIN projects p ON p.id = m.project_id AND p.user_id = m.user_id',
  scope: 'm.user_id = @userId',
  consent: '+i.consent IS NULL',
})

// Every move of one project (@projectId, a project that is not itself merged
// away) as (at): the same moves as movesSql credits to it, read from its own
// missions outwards instead of from everything the user has. The project's
// missions and those of projects merged into it come first (IN_PROJECT);
// each one's milestones are read through idx_milestones_mission, its items
// through idx_items_mission and their comments through idx_item_comments_item
// (pinned by a test).
// The two unary pluses hold that plan without ANALYZE statistics:
// `+i.consent` keeps SQLite off idx_items_consent, which it otherwise prefers,
// reading nearly every item of every user on each request; `+m.user_id` keeps
// it off idx_missions_user_state, so the missions are found through
// idx_missions_project rather than by reading every mission the user has.
const projectMovesSql = (excludePrivateOwned) => moveArms(excludePrivateOwned, {
  scope: `+m.user_id = @userId AND ${IN_PROJECT}`,
  consent: '+i.consent IS NULL',
})
// Test seam: both readings of the moves as SQL.
export const movesSqlForTest = { user: movesSql, project: projectMovesSql }

// Every move in [from, to) as {project_id, at}.
const moveRows = (db, userId, { from, to, excludePrivateOwned }) =>
  db.prepare(`SELECT project_id, at FROM (${movesSql(excludePrivateOwned)}) WHERE at >= @from AND at < @to`)
    .all({ userId, from, to })

// Every instant the project moved, newest first: its own moves and those
// credited to it from projects merged into it.
export const projectMoveTimes = (db, userId, projectId, { excludePrivateOwned = false } = {}) =>
  db.prepare(`SELECT at FROM (${projectMovesSql(excludePrivateOwned)}) ORDER BY at DESC`)
    .pluck().all({ userId, projectId })

// The start of every local week holding one of `times` (instants, newest
// first), newest first. One calendar lookup per week, not per instant.
export function weekStartsOf(times, tz) {
  const out = []
  let start = Infinity
  for (const t of times) {
    if (t >= start) continue
    start = weekStartOf(t, tz)
    out.push(start)
  }
  return out
}

// Moves per project with at least one in [from, to).
export function projectMoves(db, userId, { from, to, excludePrivateOwned = false }) {
  const rows = db.prepare(`SELECT project_id, COUNT(*) AS n FROM (${movesSql(excludePrivateOwned)})
      WHERE at >= @from AND at < @to GROUP BY project_id`).all({ userId, from, to })
  return new Map(rows.map((r) => [r.project_id, r.n]))
}

// One count per requested project and week start, oldest first (the order of
// `weekStarts`); a quiet week, or a project with no moves, is 0. One pass over
// the whole span: each move is placed in the week whose [start, end) holds it,
// with the ends from the zone's own calendar so a 167 or 169 hour week fits.
export function projectWeeklyMoves(db, userId, projectIds, weekStarts, tz, { excludePrivateOwned = false } = {}) {
  const out = new Map(projectIds.map((id) => [id, new Array(weekStarts.length).fill(0)]))
  if (!weekStarts.length) return out
  const weeks = weekStarts.map((start) => ({ start, end: weekEndOf(start, tz) }))
  const from = Math.min(...weeks.map((w) => w.start))
  const to = Math.max(...weeks.map((w) => w.end))
  for (const { project_id: id, at } of moveRows(db, userId, { from, to, excludePrivateOwned })) {
    const counts = out.get(id)
    if (!counts) continue
    const i = weeks.findIndex((w) => at >= w.start && at < w.end)
    if (i >= 0) counts[i] += 1
  }
  return out
}

// ---- The reads (weeks list, one week, went quiet, open a long time,
// finished, every live project). Every read takes `{ excludePrivateOwned, now }` last; the zone is
// the user's own. A project merged into another never appears as a row (its
// moves already count for the survivor); a filtered caller also loses
// private-origin projects, and its missions and moves go through the same
// sieves as the project feed.

// The thresholds, in one place.
export const TIMELINE = {
  storiesMax: 8, // data-only stories per week; the rest are "also"
  weeksPage: 12, // weeks per weeksList page by default
  listTop: 10, // rows shown by went quiet and open a long time
  sparkWeeks: 8, // the activity chart: weeks ending with the current one
  quietDays: 14, // went quiet: no move for this long ...
  quietWeeks: 8, // ... after moving in at least quietMovedWeeks of the
  quietMovedWeeks: 2, //   quietWeeks weeks ending with its last move's week
  openLongDays: 21, // open a long time: created at least this long ago
  finishedPage: 30,
  allPage: 50, // rows per page of every live project
}
const DAY_MS = 86400e3

const openMissionSql = (excludePrivateOwned) => `EXISTS (SELECT 1 FROM missions m
  WHERE m.project_id = p.id AND m.user_id = p.user_id AND m.state = 'open' ${excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''})`

// Which projects `p` the caller may see as a row: one not merged into
// another and, for a filtered caller, not born on a private device.
const rowProjectSql = (excludePrivateOwned) => `p.merged_into IS NULL ${excludePrivateOwned ? `AND ${PROJECT_ORIGIN_SIEVE}` : ''}`

// Every project the caller may see as a row, with whether it is live (open,
// with at least one open mission), whether it has any mission at all, and,
// when it is not live, when it finished: its close, else its newest mission
// close, else (no mission ever) its creation.
export function rowProjects(db, userId, excludePrivateOwned) {
  const originSieve = excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''
  // The status sieve, as GET /projects applies it: a status written from or
  // by a private device reads as null.
  const status = excludePrivateOwned ? `CASE WHEN ${statusPrivateSql('p')} THEN NULL ELSE p.status END` : 'p.status'
  return db.prepare(`SELECT p.id, p.num, p.title, ${status} AS status, p.state, p.created_at,
      (p.state = 'open' AND ${openMissionSql(excludePrivateOwned)}) AS live,
      EXISTS (SELECT 1 FROM missions m WHERE m.project_id = p.id AND m.user_id = p.user_id ${originSieve}) AS has_mission,
      COALESCE(p.closed_at,
        (SELECT MAX(m.closed_at) FROM missions m WHERE m.project_id = p.id AND m.user_id = p.user_id ${originSieve}),
        p.created_at) AS finished_at
    FROM projects p
    WHERE p.user_id = ? AND ${rowProjectSql(excludePrivateOwned)}`)
    .all(userId).map((r) => ({ ...r, live: Boolean(r.live), has_mission: Boolean(r.has_mission) }))
}
export const refOf = (p) => ({ id: p.id, num: p.num, title: p.title })

// The projects that moved, most moves first (ties by number), as
// [{ project, moved }]; projects the caller cannot see as rows are dropped.
function ranked(moves, byId) {
  return [...moves].filter(([id, n]) => n > 0 && byId.has(id))
    .map(([id, moved]) => ({ project: byId.get(id), moved }))
    .sort((a, b) => (b.moved - a.moved) || (a.project.num - b.project.num))
}

function weekSentence(moved) {
  const names = moved.slice(0, 3).map((r) => r.project.title)
  const rest = moved.length - names.length
  if (!names.length) return 'A quiet week.'
  if (rest > 0) return `${names.join(', ')} and ${rest} more moved.`
  if (names.length === 1) return `${names[0]} moved.`
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)} moved.`
}

// The lede's first sentence: up to and including the first . ! or ? followed
// by whitespace or the end; the whole lede when there is none.
function firstSentence(lede) {
  const text = lede.trim()
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(text)
  return m ? m[0].trim() : text
}

// `count` week starts ending with the week of `lastStart`, oldest first.
function weeksEndingWith(lastStart, count, tz) {
  const out = [lastStart]
  while (out.length < count) out.unshift(previousWeekStart(out[0], tz))
  return out
}

// The newest move ever per project.
const lastMoves = (db, userId, excludePrivateOwned) => new Map(
  db.prepare(`SELECT project_id, MAX(at) AS at FROM (${movesSql(excludePrivateOwned)}) GROUP BY project_id`)
    .all({ userId }).map((r) => [r.project_id, r.at]))

// Weeks newest first from the current week (or from the week before
// `before`, a week key), down to the week of the user's earliest mission;
// quiet weeks included. null when `before` is not a week key.
export function weeksList(db, userId, { before = null, limit = TIMELINE.weeksPage, excludePrivateOwned = false, now = Date.now() } = {}) {
  const tz = userTimeZone(db, userId)
  const current = weekStartOf(now, tz)
  let first = current
  if (before != null) {
    const b = parseWeekKey(before, tz)
    if (b == null) return null
    first = Math.min(previousWeekStart(b, tz), current)
  }
  const earliest = db.prepare(`SELECT MIN(m.created_at) AS at FROM missions m
    WHERE m.user_id = ? ${excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''}`).get(userId).at
  const floor = Math.min(weekStartOf(earliest ?? now, tz), current)
  const starts = []
  for (let s = first; starts.length < limit && s >= floor; s = previousWeekStart(s, tz)) starts.push(s)
  const projects = rowProjects(db, userId, excludePrivateOwned)
  const byId = new Map(projects.map((p) => [p.id, p]))
  const weekly = projectWeeklyMoves(db, userId, [...byId.keys()], starts, tz, { excludePrivateOwned })
  const keys = starts.map((s) => formatWeekKey(s, tz))
  const stored = writtenWeeks(db, userId, keys)
  const weeks = starts.map((start, i) => {
    const moved = ranked([...weekly].map(([id, counts]) => [id, counts[i]]), byId)
    const lede = stored.get(keys[i])?.lede
    return {
      week: keys[i], start, end: weekEndOf(start, tz),
      sentence: lede ? firstSentence(lede) : weekSentence(moved), moved: moved.length, written: stored.has(keys[i]),
    }
  })
  const oldest = starts.at(-1)
  return { weeks, next_before: oldest != null && oldest > floor ? formatWeekKey(oldest, tz) : null }
}

// The projects a stored week names, as the reader sees them now: each stored
// id through a merge to the project that survived it, kept only when it is a
// row the caller may see. Map(stored id → project).
export function survivingProjects(db, userId, ids, byId) {
  const out = new Map()
  if (!ids.length) return out
  const rows = db.prepare(`SELECT id, merged_into FROM projects
    WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`).all(userId, JSON.stringify(ids))
  for (const r of rows) {
    const p = byId.get(r.merged_into ?? r.id)
    if (p) out.set(r.id, p)
  }
  return out
}

// survivingProjects for a reader that needs only which project each stored
// id is now: Map(stored id -> { id }), in one statement and without listing
// every project. A stored id goes through a merge to the project that
// survived it, which is kept only when rowProjects would return it
// (rowProjectSql, the same rule).
// `+s.user_id` has SQLite find the named rows by their id rather than read
// every project of the user.
export function namedProjects(db, userId, ids, excludePrivateOwned) {
  if (!ids.length) return new Map()
  const rows = db.prepare(`SELECT s.id AS stored, p.id FROM projects s
      JOIN projects p ON p.id = COALESCE(s.merged_into, s.id) AND p.user_id = s.user_id
    WHERE +s.user_id = ? AND s.id IN (SELECT value FROM json_each(?)) AND ${rowProjectSql(excludePrivateOwned)}`)
    .all(userId, JSON.stringify(ids))
  return new Map(rows.map((r) => [r.stored, { id: r.id }]))
}

// The stored items that still exist and that the caller may see (consent cards
// are never items to show), with whether each still waits on the user:
// Map(id → { id, num, title, done }). Under the sieve the item's mission must
// also sit in a project the caller can see (`byId`, the surviving project
// after a merge); a mission filed under no project has nothing to hide behind.
function liveItems(db, userId, ids, byId, excludePrivateOwned) {
  const out = new Map()
  if (!ids.length) return out
  const sieve = excludePrivateOwned ? `AND NOT ${privateConvo('c')} AND ${ORIGIN_SIEVE}` : ''
  const rows = db.prepare(`SELECT i.id, i.num, i.title, (i.state = 'open' AND i.awaiting = 'user') AS pending,
        (SELECT COALESCE(p.merged_into, p.id) FROM projects p WHERE p.id = m.project_id AND p.user_id = m.user_id) AS project_id
      FROM items i JOIN missions m ON m.id = i.mission_id AND m.user_id = i.user_id
      JOIN conversations c ON c.id = i.origin_convo_id
    WHERE i.user_id = ? AND i.consent IS NULL AND i.id IN (SELECT value FROM json_each(?)) ${sieve}`)
    .all(userId, JSON.stringify(ids))
  for (const r of rows) {
    if (excludePrivateOwned && r.project_id != null && !byId.has(r.project_id)) continue
    out.set(r.id, { id: r.id, num: r.num, title: r.title, done: !r.pending })
  }
  return out
}

// Whether a content type is one a card can show: an image or a video.
export const isPicture = (type) => /^(image|video)\//.test(type ?? '')

// The stored pictures that still exist and that the caller may see (under the
// sieve, one the files roll-up still shows): Map(blob id → { blob_id,
// content_type, name }). One pass over the roll-up for all of them, over
// every mission of the user (found through idx_missions_user_state).
export function liveMedia(db, userId, blobIds, excludePrivateOwned) {
  const out = new Map()
  if (!blobIds.length) return out
  const ids = JSON.stringify(blobIds)
  const owned = db.prepare('SELECT id, content_type FROM blobs WHERE owner_user_id = ? AND id IN (SELECT value FROM json_each(?))')
    .all(userId, ids)
  if (!owned.length) return out
  const rolled = new Map(db.prepare(`SELECT f.blob_id, f.content_type, f.name FROM (${filesSql(excludePrivateOwned, 'm.user_id = @userId')}) f
    WHERE f.blob_id IN (SELECT value FROM json_each(@ids))`).all({ userId, ids }).map((r) => [r.blob_id, r]))
  for (const b of owned) {
    const r = rolled.get(b.id)
    if (!isPicture(r?.content_type ?? b.content_type)) continue
    if (excludePrivateOwned && !r) continue
    out.set(b.id, { blob_id: b.id, content_type: r?.content_type ?? b.content_type, name: r?.name ?? null })
  }
  return out
}

// The projects one stored story names, as the reader sees them now, in the
// stored order and each once: `projects` is survivingProjects' map. The first
// is the story's main project; a story left with none is not shown.
export function storyProjects(story, projects) {
  const seen = new Set()
  return story.project_ids.map((id) => projects.get(id)).filter((p) => p && !seen.has(p.id) && seen.add(p.id))
}

// The stored stories as the caller sees them now, in stored order:
// { title, sentence, next, projects: [project row], items: [{id,num,title,done}],
// media: {blob_id,content_type,name}|null }. A story left with no visible
// project is dropped; items and media that are gone or hidden are left out.
function resolveStored(db, userId, stored, byId, excludePrivateOwned) {
  const projects = survivingProjects(db, userId, [...new Set(stored.stories.flatMap((s) => s.project_ids))], byId)
  const pairs = stored.stories.map((story) => ({ story, rows: storyProjects(story, projects) })).filter(({ rows }) => rows.length)
  return resolveStories(db, userId, pairs, byId, excludePrivateOwned)
}

// resolveStored for stories whose projects are already resolved: `pairs` is
// [{ story, rows }], `rows` the story's visible projects (never empty).
function resolveStories(db, userId, pairs, byId, excludePrivateOwned) {
  const all = (f) => [...new Set(pairs.flatMap(({ story }) => f(story)))]
  const items = liveItems(db, userId, all((s) => s.item_ids), byId, excludePrivateOwned)
  const media = liveMedia(db, userId, all((s) => (s.media_blob_id ? [s.media_blob_id] : [])), excludePrivateOwned)
  return pairs.map(({ story: s, rows }) => ({
    title: s.title, sentence: s.sentence, next: s.next, projects: rows,
    items: s.item_ids.map((id) => items.get(id)).filter(Boolean),
    media: s.media_blob_id ? media.get(s.media_blob_id) ?? null : null,
  }))
}

// A caller's sieve over an item's or milestone's conversation `c` and mission `m`.
export const convoSieveOf = (excludePrivateOwned) => (excludePrivateOwned ? `AND NOT ${privateConvo('c')} AND ${ORIGIN_SIEVE}` : '')
// The project's missions (@projectId) and those still filed under a project
// merged into it. The projects are looked for among the user's own (@userId),
// through idx_projects_user_state: nothing indexes merged_into, so without
// the user the subquery reads every user's projects (pinned by tests).
export const IN_PROJECT = 'm.project_id IN (SELECT q.id FROM projects q WHERE q.user_id = @userId AND (q.id = @projectId OR q.merged_into = @projectId))'
export const OF_PROJECT = `m.user_id = @userId AND ${IN_PROJECT}`

// The project's open items awaiting the user, as the timeline shows them:
// unlike projectDetail's needs-you, consent cards are left out, newest created
// first, and only items created before the week ended (`@end`). Shared by the
// apps' fallback card and the Coordinator's raw read. `limit` caps the rows.
// `+i.consent`: the unary plus keeps SQLite off idx_items_consent, which it
// otherwise prefers without ANALYZE statistics, reading nearly every item of
// every user for each card. With it, the project's missions come first and
// each one's items are read through idx_items_mission (pinned by a test).
const needsYouFrom = (convoSieve) => `FROM items i JOIN missions m ON m.id = i.mission_id
      JOIN conversations c ON c.id = i.origin_convo_id
    WHERE ${OF_PROJECT} AND i.state = 'open' AND i.awaiting = 'user' AND +i.consent IS NULL AND i.created_at < @end ${convoSieve}`
export const needsYouSql = (convoSieve, limit = -1) => `SELECT i.id, i.num, i.title ${needsYouFrom(convoSieve)}
    ORDER BY i.created_at DESC, i.num DESC LIMIT ${limit}`

// The counts behind a week card's marks, for one project (@projectId) and one
// week (@start, @end): `forYou`, how many items the needs-you list would hold,
// and `done`, how many items on the project's missions were closed in the
// week. Consent cards are in neither; both go through the caller's sieve.
export const forYouSql = (convoSieve) => `SELECT COUNT(*) AS n ${needsYouFrom(convoSieve)}`
const doneSql = (convoSieve) => `SELECT COUNT(*) AS n FROM items i JOIN missions m ON m.id = i.mission_id
      JOIN conversations c ON c.id = i.origin_convo_id
    WHERE ${OF_PROJECT} AND +i.consent IS NULL AND i.closed_at >= @start AND i.closed_at < @end ${convoSieve}`
// Test seam: the three per-card item queries as SQL.
export const cardItemsSqlForTest = (excludePrivateOwned) => {
  const sieve = convoSieveOf(excludePrivateOwned)
  return { forYou: forYouSql(sieve), needsYou: needsYouSql(sieve), done: doneSql(sieve) }
}

// The SQL behind an apps' week card, for one project (@projectId) and one
// week (@start, @end), through the caller's sieve: `sentence`, the title of
// the project's newest milestone that week, and `media`, its newest picture
// or video that week (the project feed's files roll-up, narrowed to the week).
const cardSql = (excludePrivateOwned) => {
  const convoSieve = convoSieveOf(excludePrivateOwned)
  return {
    sentence: `SELECT l.title FROM milestones l JOIN missions m ON m.id = l.mission_id
      JOIN conversations c ON c.id = l.convo_id
    WHERE ${OF_PROJECT} AND l.created_at >= @start AND l.created_at < @end ${convoSieve}
    ORDER BY l.created_at DESC, l.seq DESC LIMIT 1`,
    media: `SELECT f.blob_id, f.content_type, f.name FROM (${filesSql(excludePrivateOwned, IN_PROJECT)}) f
    WHERE f.at >= @start AND f.at < @end AND (f.content_type LIKE 'image/%' OR f.content_type LIKE 'video/%')
    ORDER BY f.at DESC, f.sort_key DESC LIMIT 1`,
  }
}
// Test seam: the per-card sentence and media queries as SQL.
export const cardSqlForTest = cardSql

// Every statement a week card runs, prepared once per read and run once per
// card shown.
function cardStatements(db, excludePrivateOwned) {
  const convoSieve = convoSieveOf(excludePrivateOwned)
  const sql = cardSql(excludePrivateOwned)
  return {
    sentence: db.prepare(sql.sentence),
    media: db.prepare(sql.media),
    needsYou: db.prepare(needsYouSql(convoSieve)),
    forYou: db.prepare(forYouSql(convoSieve)),
    done: db.prepare(doneSql(convoSieve)),
  }
}

// The stored stories the week's page shows as cards, in stored order, each
// with its projects as the reader sees them now (`projects`, survivingProjects'
// map): one card per main project, the first story wins; a story left with no
// project the caller may see is not shown.
function shownStories(stored, projects) {
  const mains = new Set()
  return stored.stories.map((story) => ({ story, rows: storyProjects(story, projects) }))
    .filter(({ rows }) => rows.length && !mains.has(rows[0].id) && mains.add(rows[0].id))
}

// What one week's page is built from, for a caller: the week, every project
// the caller may see as a row (`byId`), the projects that moved (`moved`,
// ranked), the stored week (null when unwritten) with the stories it shows
// (`shown`), and `also`, the moving projects the page has no card for, in
// rank order: for an unwritten week those past TIMELINE.storiesMax, for a
// written one those no shown story names. weekDetail's `also` and
// weekProjects' pages are both this list. null when `weekKey` is not a week
// key.
function weekFrame(db, userId, weekKey, excludePrivateOwned) {
  const tz = userTimeZone(db, userId)
  const start = parseWeekKey(weekKey, tz)
  if (start == null) return null
  const end = weekEndOf(start, tz)
  const byId = new Map(rowProjects(db, userId, excludePrivateOwned).map((p) => [p.id, p]))
  const moved = ranked(projectMoves(db, userId, { from: start, to: end, excludePrivateOwned }), byId)
  const stored = writtenWeek(db, userId, weekKey)
  if (!stored) return { tz, start, end, byId, moved, stored, shown: null, also: moved.slice(TIMELINE.storiesMax) }
  const projects = survivingProjects(db, userId, [...new Set(stored.stories.flatMap((s) => s.project_ids))], byId)
  const shown = shownStories(stored, projects)
  const named = new Set(shown.flatMap(({ rows }) => rows.map((p) => p.id)))
  return { tz, start, end, byId, moved, stored, shown, also: moved.filter(({ project }) => !named.has(project.id)) }
}

// One week's page: a story per project that moved, most moves first, at most
// TIMELINE.storiesMax, the rest under `also` -- or, when the Coordinator has
// written the week, its lede and stories in its order, one per main project
// (the first wins: two can share one in a week written as grouped stories, or
// after a merge), with `also` the moving projects no remaining story names.
// Every story carries `marks`: { for_you, done, next }, counted now, as the
// caller may see them. null when `weekKey` is not a week key.
export function weekDetail(db, userId, weekKey, { excludePrivateOwned = false, now = Date.now() } = {}) {
  const frame = weekFrame(db, userId, weekKey, excludePrivateOwned)
  if (!frame) return null
  const { tz, start, end, byId, moved, stored, shown } = frame
  const q = cardStatements(db, excludePrivateOwned)
  const weekMedia = (project) => q.media.get({ userId, projectId: project.id, start, end }) ?? null
  const head = { week: formatWeekKey(start, tz), start, end }
  const also = frame.also.map(({ project, moved: n }) => ({ ...refOf(project), moved: n }))
  if (!stored) {
    const stories = moved.slice(0, TIMELINE.storiesMax).map(({ project }) => {
      const args = { userId, projectId: project.id, start, end }
      const waiting = q.needsYou.all(args).map((r) => ({ ...r, done: false }))
      return {
        title: null,
        project: refOf(project),
        projects: [refOf(project)],
        sentence: q.sentence.get(args)?.title ?? null,
        next: null,
        needs_you: waiting,
        media: weekMedia(project),
        // The list above is every item the for-you count would count.
        marks: { for_you: waiting.length, done: q.done.get(args).n, next: false },
      }
    })
    return { ...head, final: end <= now, lede: null, written_at: null, stories, also }
  }
  const stories = resolveStories(db, userId, shown, byId, excludePrivateOwned).map((s) => {
    const args = { userId, projectId: s.projects[0].id, start, end }
    return {
      title: s.title,
      project: refOf(s.projects[0]),
      projects: s.projects.map(refOf),
      sentence: s.sentence,
      next: s.next,
      needs_you: s.items,
      media: s.media ?? weekMedia(s.projects[0]),
      marks: { for_you: q.forYou.get(args).n, done: q.done.get(args).n, next: !!s.next },
    }
  })
  return { ...head, final: stored.final || end <= now, lede: stored.lede, written_at: stored.written_at, stories, also }
}

// The limits of the paged read of a week's other projects.
export const WEEK_PROJECTS = { page: 24, pageMax: 50, statusMax: 300 }

// The projects one week's page lists under `also`, as cards, a page at a
// time: exactly weekDetail's `also` for the same caller, in its order (most
// moves first), from `offset`, at most `limit` of them, each
// { project, moved, sentence, media, marks: { for_you, done, next: false } }.
// `sentence` is the project's newest milestone title that week, else its
// status (clipped to WEEK_PROJECTS.statusMax), else null; `media` and `marks`
// are counted as weekDetail counts them. `total` is the length of the whole
// list and `next_offset` where the next page starts, null on the last.
// Statements run per card on the page only. `offset` and `limit` are assumed
// valid. null when `weekKey` is not a week key.
export function weekProjects(db, userId, weekKey, { offset = 0, limit = WEEK_PROJECTS.page, excludePrivateOwned = false } = {}) {
  const frame = weekFrame(db, userId, weekKey, excludePrivateOwned)
  if (!frame) return null
  const { tz, start, end, also } = frame
  const q = cardStatements(db, excludePrivateOwned)
  const page = also.slice(offset, offset + limit)
  const projects = page.map(({ project, moved: n }) => {
    const args = { userId, projectId: project.id, start, end }
    return {
      project: refOf(project),
      moved: n,
      sentence: q.sentence.get(args)?.title ?? clip(project.status || null, WEEK_PROJECTS.statusMax),
      media: q.media.get(args) ?? null,
      marks: { for_you: q.forYou.get(args).n, done: q.done.get(args).n, next: false },
    }
  })
  const after = offset + page.length
  return { week: formatWeekKey(start, tz), total: also.length, offset, next_offset: after < also.length ? after : null, projects }
}

// The limits of the Coordinator's raw week read: the page of projects it
// returns by default and at most; per project, how many milestones, items,
// pictures and waiting items; how long a title and a status may be; and the
// most characters one response may run to as JSON.
export const RAW = {
  page: 12, pageMax: 20, milestones: 6, items: 6, media: 3, needsYou: 5, titleMax: 140, statusMax: 300, maxChars: 36_000,
}

// `text` cut to at most `max` UTF-16 code units, the last an ellipsis when
// anything was cut. A cut never leaves half a surrogate pair.
function clip(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text
  const end = max - 1
  const half = text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff
  return `${text.slice(0, half ? end - 1 : end)}…`
}
const clipTitle = (row) => ({ ...row, title: clip(row.title, RAW.titleMax) })

// What every raw read says about the week itself, the stored row included.
const rawHead = (stored, start, end, tz, now) => ({
  week: formatWeekKey(start, tz), start, end,
  final: Boolean(stored?.final) || end <= now,
  written_at: stored?.written_at ?? null,
  current: start === weekStartOf(now, tz),
})
// Whether a week was written as grouped stories (a card with its own title,
// or one naming several projects) rather than as one entry per project.
// Judged on the stories as stored, whatever the caller may see of them now.
const legacyWeek = (stored) => stored.stories.some((s) => s.title != null || s.project_ids.length > 1)

// The projects `refs` name (ids or numbers) as [{ project, moved }], in the
// order given and each once: every reference goes through a merge to the
// project that survived it, under the caller's sieve at each hop, and is
// left out when nothing the caller may see answers to it. `moved` is the
// project's place in the week's ranking, 0 when it did not move.
function pickedProjects(db, userId, refs, byId, moved, excludePrivateOwned) {
  const moves = new Map(moved.map((r) => [r.project.id, r.moved]))
  const out = new Map()
  for (const ref of refs) {
    const project = byId.get(resolveProject(db, userId, ref, { excludePrivateOwned })?.project.id)
    if (project && !out.has(project.id)) out.set(project.id, { project, moved: moves.get(project.id) ?? 0 })
  }
  return [...out.values()]
}

// The Coordinator's raw read of one week (it writes the week from this), one
// page at a time: the stored week with ids resolved to refs, and the moving
// projects (most moves first) from `offset`, at most `limit` of them, each
// with its milestones, items and pictures of that week and the items still
// waiting on the user. `projects_total` counts every moving project;
// `next_offset` is where the next page starts, or null on the last one, and
// `more_projects` how many projects come after this page.
//
// The response is bounded so its reader can take it whole: every list is
// capped, titles and statuses are clipped, and while the JSON is longer than
// RAW.maxChars the page gives up its last project (never its only one), so a
// page can hold fewer than `limit`; `next_offset` always follows what was
// returned. The stored week is on the first page only (`stored` is null from
// then on, as it is for an unwritten week; `written_at` tells them apart).
// When a page down to one project is still too long, the stored stories come
// back without their items (`stored.items_omitted: true`) and, if that is
// not enough, with their first project only (`stored.projects_omitted: true`).
// `offset` and `limit` are assumed valid. null when `weekKey` is not a week
// key.
//
// With `picked` (project ids or numbers, at most a page of them) the projects
// are instead exactly the named ones the caller may see, in the order given
// and each once: a reference is followed through a merge, one that is
// unknown or hidden is left out, and a project that did not move that week
// comes with `moved: 0`. There is no next page then, `projects_total` is
// still the week's moving total, and `omitted` lists the ids of the projects
// the bound took off the end.
export function weekRaw(db, userId, weekKey, { offset = 0, limit = RAW.page, picked = null, excludePrivateOwned = true, now = Date.now() } = {}) {
  const tz = userTimeZone(db, userId)
  const start = parseWeekKey(weekKey, tz)
  if (start == null) return null
  const end = weekEndOf(start, tz)
  const byId = new Map(rowProjects(db, userId, excludePrivateOwned).map((p) => [p.id, p]))
  const moved = ranked(projectMoves(db, userId, { from: start, to: end, excludePrivateOwned }), byId)
  const convoSieve = convoSieveOf(excludePrivateOwned)
  const commentSieve = excludePrivateOwned ? `AND NOT ${privateDevice('ic.device_id')}` : ''
  const inProject = IN_PROJECT
  const ofProject = OF_PROJECT
  const milestones = db.prepare(`SELECT l.title, l.kind, l.created_at AS at FROM milestones l JOIN missions m ON m.id = l.mission_id
      JOIN conversations c ON c.id = l.convo_id
    WHERE ${ofProject} AND l.created_at >= @start AND l.created_at < @end ${convoSieve}
    ORDER BY l.created_at DESC, l.seq DESC LIMIT ${RAW.milestones}`)
  // Every item with activity in the week (created, closed or commented, as a
  // move counts them), for all the page's projects in one pass. The week
  // range sits inside each arm so only the week's rows are read; the newest
  // RAW.items per project are kept.
  const shown = picked ? pickedProjects(db, userId, picked, byId, moved, excludePrivateOwned) : moved.slice(offset, offset + limit)
  const itemRows = shown.length ? db.prepare(`SELECT project_id, id, num, title, kind, state, awaiting, at FROM (
      SELECT project_id, id, num, title, kind, state, awaiting, at,
        ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY at DESC, num DESC) AS rn
      FROM (SELECT COALESCE(p.merged_into, p.id) AS project_id, i.id, i.num, i.title, i.kind, i.state, i.awaiting, MAX(ev.at) AS at
        FROM (SELECT i.id AS item_id, i.created_at AS at FROM items i
            WHERE i.user_id = @userId AND i.created_at >= @start AND i.created_at < @end
          UNION ALL SELECT i.id, i.closed_at FROM items i
            WHERE i.user_id = @userId AND i.closed_at >= @start AND i.closed_at < @end
          UNION ALL SELECT ic.item_id, ic.created_at FROM item_comments ic
            WHERE ic.created_at >= @start AND ic.created_at < @end AND ic.kind = 'comment' AND ic.withdrawn_at IS NULL ${commentSieve}) ev
          JOIN items i ON i.id = ev.item_id AND i.user_id = @userId
          JOIN missions m ON m.id = i.mission_id AND m.user_id = i.user_id
          JOIN projects p ON p.id = m.project_id AND p.user_id = m.user_id
          JOIN conversations c ON c.id = i.origin_convo_id
        WHERE i.consent IS NULL ${convoSieve}
        GROUP BY i.id))
    WHERE rn <= ${RAW.items} AND project_id IN (SELECT value FROM json_each(@projectIds))
    ORDER BY at DESC, num DESC`).all({ userId, start, end, projectIds: JSON.stringify(shown.map((r) => r.project.id)) }) : []
  const itemsOf = new Map()
  for (const { project_id: pid, ...row } of itemRows) itemsOf.set(pid, [...(itemsOf.get(pid) ?? []), clipTitle(row)])
  const media = db.prepare(`SELECT f.blob_id, f.content_type, f.name, f.at FROM (${filesSql(excludePrivateOwned, inProject)}) f
    WHERE f.at >= @start AND f.at < @end AND (f.content_type LIKE 'image/%' OR f.content_type LIKE 'video/%')
    ORDER BY f.at DESC, f.sort_key DESC LIMIT ${RAW.media}`)
  // The newest of what still waits on the user, whatever the week's activity.
  const needsYou = db.prepare(needsYouSql(convoSieve, RAW.needsYou))
  const projects = shown.map(({ project, moved: n }) => {
    const args = { userId, projectId: project.id, start, end }
    return {
      project: refOf(project), moved: n, status: clip(project.status ?? null, RAW.statusMax),
      milestones: milestones.all(args).map(clipTitle), items: itemsOf.get(project.id) ?? [],
      // A file name is as long as its sender made it; it is clipped like a title.
      media: media.all(args).map((f) => ({ ...f, name: clip(f.name, RAW.titleMax) })),
      needs_you: needsYou.all(args).map(clipTitle),
    }
  })
  const stored = writtenWeek(db, userId, weekKey)
  const result = {
    ...rawHead(stored, start, end, tz, now),
    // A story whose projects are all hidden from the caller is withheld here, as
    // the apps' read withholds it, so a Coordinator that rewrites the week from
    // this drops that story (accepted: a story never names private work).
    stored: stored && offset === 0 ? {
      lede: stored.lede, final: stored.final,
      legacy: legacyWeek(stored),
      stories: resolveStored(db, userId, stored, byId, excludePrivateOwned).map((s) => ({
        title: s.title, sentence: s.sentence, next: s.next,
        projects: s.projects.map(refOf),
        items: s.items.map(({ id, num, title }) => ({ id, num, title: clip(title, RAW.titleMax) })),
        media_blob_id: s.media?.blob_id ?? null,
      })),
    } : null,
    projects,
    projects_total: moved.length,
    offset,
    next_offset: null,
    more_projects: 0,
    ...(picked && { omitted: [] }),
  }
  const place = () => {
    if (picked) return
    result.more_projects = Math.max(0, moved.length - offset - projects.length)
    result.next_offset = result.more_projects ? offset + projects.length : null
  }
  place()
  const over = () => JSON.stringify(result).length > RAW.maxChars
  while (projects.length > 1 && over()) {
    const last = projects.pop()
    if (picked) result.omitted.unshift(last.project.id)
    place()
  }
  // A week written as grouped stories can itself be most of a page. With
  // one project left, the stored stories give up their items, then every
  // project after their first; a flag says what was left out.
  if (result.stored && over()) {
    result.stored.stories = result.stored.stories.map((s) => ({ ...s, items: [] }))
    result.stored.items_omitted = true
    if (over()) {
      result.stored.stories = result.stored.stories.map((s) => ({ ...s, projects: s.projects.slice(0, 1) }))
      result.stored.projects_omitted = true
    }
  }
  return result
}

// The limits of the week index: how long a project's title and its newest
// milestone's title may be, and the shorter title a crowded week falls back to.
export const INDEX = { titleMax: 80, titleMin: 40, newestMax: 100 }

// The three grouped statements behind the week index: for every project of
// the user (@userId) at once, in one week (@start, @end), each credited to
// the surviving project as a move is. Each starts from the user's missions
// (idx_missions_user_state) and reads each one's milestones, items and
// comments through their own indexes (pinned by a test); `+i.consent` is as
// in movesSql.
//   milestones: (project_id, n, title) -- how many that week and the newest's title;
//   items: (project_id, done, for_you) -- as doneSql and forYouSql count them
//     for one project, consent cards in neither;
//   media: (project_id, n) -- the week's pictures and videos in the files roll-up.
const BY_PROJECT = {
  cols: 'COALESCE(p.merged_into, p.id) AS project_id, ',
  join: 'JOIN projects p ON p.id = m.project_id AND p.user_id = m.user_id',
  group: ', COALESCE(p.merged_into, p.id)',
}
const indexSql = (excludePrivateOwned) => {
  const convoSieve = convoSieveOf(excludePrivateOwned)
  return {
    milestones: `SELECT project_id, n, title FROM (
        SELECT ${BY_PROJECT.cols}l.title,
          COUNT(*) OVER (PARTITION BY COALESCE(p.merged_into, p.id)) AS n,
          ROW_NUMBER() OVER (PARTITION BY COALESCE(p.merged_into, p.id) ORDER BY l.created_at DESC, l.seq DESC) AS rn
        FROM milestones l JOIN missions m ON m.id = l.mission_id ${BY_PROJECT.join}
        JOIN conversations c ON c.id = l.convo_id
        WHERE m.user_id = @userId AND l.created_at >= @start AND l.created_at < @end ${convoSieve})
      WHERE rn = 1`,
    items: `SELECT ${BY_PROJECT.cols}
        COALESCE(SUM(i.closed_at >= @start AND i.closed_at < @end), 0) AS done,
        COALESCE(SUM(i.state = 'open' AND i.awaiting = 'user' AND i.created_at < @end), 0) AS for_you
      FROM items i JOIN missions m ON m.id = i.mission_id ${BY_PROJECT.join}
      JOIN conversations c ON c.id = i.origin_convo_id
      WHERE m.user_id = @userId AND +i.consent IS NULL ${convoSieve}
      GROUP BY 1`,
    media: `SELECT f.project_id, COUNT(*) AS n FROM (${filesSql(excludePrivateOwned, 'm.user_id = @userId', BY_PROJECT)}) f
      WHERE f.at >= @start AND f.at < @end AND (f.content_type LIKE 'image/%' OR f.content_type LIKE 'video/%')
      GROUP BY f.project_id`,
  }
}
// Test seam: the week index's three grouped statements as SQL.
export const indexSqlForTest = indexSql

// The Coordinator's index of one week: every project that moved, most moves
// first as weekRaw ranks them, as one compact row each -- `moved`, how many
// `milestones` it posted, how many items were `done` (closed that week), how
// many are `for_you` (open, awaiting the user, created before the week
// ended), how many pictures or videos (`media`) and the title of its
// `newest` milestone of the week (null without one). Consent cards are in no
// count. `stored` is the written week as { final, legacy, entries }, each
// entry a stored story's main project and sentence (a story left with no
// project the caller may see is dropped), or null for an unwritten week.
// The Coordinator picks from this and reads its picks with weekRaw's `picked`.
//
// The whole week comes in one response of at most RAW.maxChars characters
// of JSON. A week too crowded for that gives up, from the last-ranked
// project upward and only as far as needed: first `newest` (null), then
// the title beyond INDEX.titleMin characters, then the project itself,
// counted in `more_projects`.
//
// The statements run do not grow with the projects: the counts are three
// grouped statements for the whole week. null when `weekKey` is not a week
// key.
export function weekIndex(db, userId, weekKey, { excludePrivateOwned = true, now = Date.now() } = {}) {
  const tz = userTimeZone(db, userId)
  const start = parseWeekKey(weekKey, tz)
  if (start == null) return null
  const end = weekEndOf(start, tz)
  const byId = new Map(rowProjects(db, userId, excludePrivateOwned).map((p) => [p.id, p]))
  const moved = ranked(projectMoves(db, userId, { from: start, to: end, excludePrivateOwned }), byId)
  const sql = indexSql(excludePrivateOwned)
  const grouped = (text) => new Map(db.prepare(text).all({ userId, start, end }).map((r) => [r.project_id, r]))
  const milestones = grouped(sql.milestones)
  const items = grouped(sql.items)
  const media = grouped(sql.media)
  const short = (p) => ({ id: p.id, num: p.num, title: clip(p.title, INDEX.titleMax) })
  const rows = moved.map(({ project, moved: n }) => ({
    ...short(project), moved: n,
    milestones: milestones.get(project.id)?.n ?? 0,
    done: items.get(project.id)?.done ?? 0,
    for_you: items.get(project.id)?.for_you ?? 0,
    media: media.get(project.id)?.n ?? 0,
    newest: clip(milestones.get(project.id)?.title ?? null, INDEX.newestMax),
  }))
  const stored = writtenWeek(db, userId, weekKey)
  const named = stored ? survivingProjects(db, userId, [...new Set(stored.stories.flatMap((s) => s.project_ids))], byId) : null
  const result = {
    ...rawHead(stored, start, end, tz, now),
    stored: stored ? {
      final: stored.final, legacy: legacyWeek(stored),
      entries: stored.stories.map((s) => ({ project: storyProjects(s, named)[0], sentence: s.sentence }))
        .filter((e) => e.project).map((e) => ({ ...e, project: short(e.project) })),
    } : null,
    projects_total: rows.length,
    projects: rows,
    more_projects: 0,
  }
  // Each step changes the last `k` rows; the fewest that fit are found by
  // halving (a larger `k` is never longer), all of them when none does.
  const fits = () => JSON.stringify(result).length <= RAW.maxChars
  const shrink = (change) => {
    const from = result.projects
    const set = (k) => { change(from, from.length - k, k); return fits() }
    if (set(0)) return
    let lo = 1
    let hi = from.length
    while (lo < hi) {
      const k = (lo + hi) >> 1
      if (set(k)) hi = k
      else lo = k + 1
    }
    set(lo)
  }
  const last = (edit) => (from, keep) => { result.projects = from.map((r, i) => (i < keep ? r : edit(r))) }
  shrink(last((r) => ({ ...r, newest: null })))
  shrink(last((r) => ({ ...r, title: clip(r.title, INDEX.titleMin) })))
  shrink((from, keep, k) => { result.projects = from.slice(0, keep); result.more_projects = k })
  return result
}

// The activity chart for each row: TIMELINE.sparkWeeks counts ending with
// the current week, oldest first.
function withSparklines(db, userId, rows, tz, now, excludePrivateOwned) {
  const weeks = weeksEndingWith(weekStartOf(now, tz), TIMELINE.sparkWeeks, tz)
  const weekly = projectWeeklyMoves(db, userId, rows.map((r) => r.project.id), weeks, tz, { excludePrivateOwned })
  return rows.map((r) => ({ ...r, weekly: weekly.get(r.project.id) }))
}

// Each row's `note`: the Coordinator's note on the project when it was written
// at or after the project's last move (or the project never moved), else null;
// a note older than the last move is stale. One lookup for all the rows.
function withNotes(db, userId, rows) {
  const notes = projectNotes(db, userId, rows.map((r) => r.project.id))
  return rows.map((r) => {
    const n = notes.get(r.project.id)
    return { ...r, note: n && (r.last_moved_at == null || n.written_at >= r.last_moved_at) ? n.note : null }
  })
}

// Live projects that moved in at least TIMELINE.quietMovedWeeks of the
// TIMELINE.quietWeeks weeks ending with their last move's week, and not for
// TIMELINE.quietDays since. Most moves in those weeks first; the top
// TIMELINE.listTop, with `total` the full count.
export function wentQuiet(db, userId, { excludePrivateOwned = false, now = Date.now() } = {}) {
  const tz = userTimeZone(db, userId)
  const last = lastMoves(db, userId, excludePrivateOwned)
  const candidates = rowProjects(db, userId, excludePrivateOwned)
    .filter((p) => p.live && last.has(p.id) && now - last.get(p.id) >= TIMELINE.quietDays * DAY_MS)
    .map((p) => {
      const weeks = weeksEndingWith(weekStartOf(last.get(p.id), tz), TIMELINE.quietWeeks, tz)
      return { project: p, last: last.get(p.id), weeks: weeks.map((s) => ({ start: s, end: weekEndOf(s, tz) })), counts: new Array(weeks.length).fill(0) }
    })
  if (candidates.length) {
    // One pass over every candidate's window.
    const byId = new Map(candidates.map((c) => [c.project.id, c]))
    const from = Math.min(...candidates.map((c) => c.weeks[0].start))
    const to = Math.max(...candidates.map((c) => c.weeks.at(-1).end))
    for (const { project_id: id, at } of moveRows(db, userId, { from, to, excludePrivateOwned })) {
      const c = byId.get(id)
      const i = c ? c.weeks.findIndex((w) => at >= w.start && at < w.end) : -1
      if (i >= 0) c.counts[i] += 1
    }
  }
  const quiet = candidates
    .filter((c) => c.counts.filter((n) => n > 0).length >= TIMELINE.quietMovedWeeks)
    .map((c) => ({ ...c, moves: c.counts.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => (b.moves - a.moves) || (b.last - a.last) || (a.project.num - b.project.num))
  const rows = withNotes(db, userId, quiet.slice(0, TIMELINE.listTop)
    .map((c) => ({ project: refOf(c.project), last_moved_at: c.last })))
  return { total: quiet.length, rows: withSparklines(db, userId, rows, tz, now, excludePrivateOwned) }
}

// Live projects created at least TIMELINE.openLongDays ago, oldest first;
// the top TIMELINE.listTop, with `total` the full count.
export function openLong(db, userId, { excludePrivateOwned = false, now = Date.now() } = {}) {
  const tz = userTimeZone(db, userId)
  const long = rowProjects(db, userId, excludePrivateOwned)
    .filter((p) => p.live && now - p.created_at >= TIMELINE.openLongDays * DAY_MS)
    .sort((a, b) => (a.created_at - b.created_at) || (a.num - b.num))
  const last = lastMoves(db, userId, excludePrivateOwned)
  const rows = withNotes(db, userId, long.slice(0, TIMELINE.listTop).map((p) => ({
    project: refOf(p), created_at: p.created_at, last_moved_at: last.get(p.id) ?? null,
  })))
  return { total: long.length, rows: withSparklines(db, userId, rows, tz, now, excludePrivateOwned) }
}

// Projects with no open mission, or closed, newest finish first, paged by
// a "<finished_at>:<project id>" cursor. An open project that never had a
// mission (a filing leftover, e.g. emptied by a move) is not finished work
// and is left out. null when `before` is not a cursor.
export function finished(db, userId, { before = null, limit = TIMELINE.finishedPage, excludePrivateOwned = false } = {}) {
  const cursor = parseCursor(before)
  if (cursor === undefined) return null
  const rows = rowProjects(db, userId, excludePrivateOwned)
    .filter((p) => !p.live && (p.state === 'closed' || p.has_mission))
    .filter((p) => !cursor || p.finished_at < cursor.at || (p.finished_at === cursor.at && p.id < cursor.key))
    .sort((a, b) => (b.finished_at - a.finished_at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  const shown = rows.slice(0, limit)
  const lastRow = shown.at(-1)
  return {
    rows: shown.map((p) => ({ project: refOf(p), finished_at: p.finished_at })),
    next_before: rows.length > limit ? `${lastRow.finished_at}:${lastRow.id}` : null,
  }
}

// Every live project, most recently moved first, paged by an
// "<at>:<project id>" cursor, where `at` is the project's last move or, for
// one that never moved, its creation; ties go by id, descending. Each row has
// `last_moved_at` (null when it never moved) and `open_missions`, how many of
// its missions are open; `total` counts every live project, whatever the
// page. null when `before` is not a cursor.
export function allProjects(db, userId, { before = null, limit = TIMELINE.allPage, excludePrivateOwned = false } = {}) {
  const cursor = parseCursor(before)
  if (cursor === undefined) return null
  const last = lastMoves(db, userId, excludePrivateOwned)
  const open = new Map(db.prepare(`SELECT m.project_id, COUNT(*) AS n FROM missions m
    WHERE m.user_id = ? AND m.state = 'open' ${excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''}
    GROUP BY m.project_id`).all(userId).map((r) => [r.project_id, r.n]))
  const live = rowProjects(db, userId, excludePrivateOwned).filter((p) => p.live)
    .map((p) => ({ p, moved: last.get(p.id) ?? null, at: last.get(p.id) ?? p.created_at }))
  const rows = live
    .filter((r) => !cursor || r.at < cursor.at || (r.at === cursor.at && r.p.id < cursor.key))
    .sort((a, b) => (b.at - a.at) || (a.p.id < b.p.id ? 1 : a.p.id > b.p.id ? -1 : 0))
  const shown = rows.slice(0, limit)
  const lastRow = shown.at(-1)
  return {
    total: live.length,
    rows: shown.map((r) => ({ project: refOf(r.p), last_moved_at: r.moved, open_missions: open.get(r.p.id) ?? 0 })),
    next_before: rows.length > limit ? `${lastRow.at}:${lastRow.p.id}` : null,
  }
}
