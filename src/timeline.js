// Weekly timeline: per-user time zone and local-week arithmetic (spec
// 2026-11-09 projects timeline). A "week" is Monday 00:00 to the next Monday
// 00:00 in the user's own zone, so a week spanning a clock change is 167 or
// 169 hours long. Every function takes and returns epoch milliseconds, except
// the week key, which is the local date of the Monday as 'YYYY-MM-DD'.

import { Cron } from 'croner'
import { DEFAULT_TZ, validTz } from './routines.js'
import { ORIGIN_SIEVE, statusPrivateSql } from './missions.js'
import { privateDevice, privateConvo, filesSql, parseCursor } from './projects-feed.js'
import { PROJECT_ORIGIN_SIEVE } from './projects.js'
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
function movesSql(excludePrivateOwned) {
  const convoSieve = excludePrivateOwned ? `AND NOT ${privateConvo('c')} AND ${ORIGIN_SIEVE}` : ''
  const commentSieve = excludePrivateOwned ? `AND NOT ${privateDevice('ic.device_id')}` : ''
  const originSieve = excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''
  const of = 'COALESCE(p.merged_into, p.id)'
  const joinProject = 'JOIN projects p ON p.id = m.project_id AND p.user_id = m.user_id'
  return `SELECT ${of} AS project_id, l.created_at AS at
      FROM milestones l JOIN missions m ON m.id = l.mission_id ${joinProject}
      JOIN conversations c ON c.id = l.convo_id
      WHERE m.user_id = @userId ${convoSieve}
    UNION ALL
    SELECT ${of}, i.created_at
      FROM items i JOIN missions m ON m.id = i.mission_id ${joinProject}
      JOIN conversations c ON c.id = i.origin_convo_id
      WHERE m.user_id = @userId AND i.consent IS NULL ${convoSieve}
    UNION ALL
    SELECT ${of}, i.closed_at
      FROM items i JOIN missions m ON m.id = i.mission_id ${joinProject}
      JOIN conversations c ON c.id = i.origin_convo_id
      WHERE m.user_id = @userId AND i.consent IS NULL AND i.closed_at IS NOT NULL ${convoSieve}
    UNION ALL
    SELECT ${of}, ic.created_at
      FROM item_comments ic JOIN items i ON i.id = ic.item_id
      JOIN missions m ON m.id = i.mission_id ${joinProject}
      JOIN conversations c ON c.id = i.origin_convo_id
      WHERE m.user_id = @userId AND i.consent IS NULL AND ic.kind = 'comment' AND ic.withdrawn_at IS NULL
        ${convoSieve} ${commentSieve}
    UNION ALL
    SELECT ${of}, m.created_at
      FROM missions m ${joinProject}
      WHERE m.user_id = @userId ${originSieve}
    UNION ALL
    SELECT ${of}, m.closed_at
      FROM missions m ${joinProject}
      WHERE m.user_id = @userId AND m.closed_at IS NOT NULL ${originSieve}`
}

// Every move in [from, to) as {project_id, at}.
const moveRows = (db, userId, { from, to, excludePrivateOwned }) =>
  db.prepare(`SELECT project_id, at FROM (${movesSql(excludePrivateOwned)}) WHERE at >= @from AND at < @to`)
    .all({ userId, from, to })

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

// ---- The five reads (weeks list, one week, went quiet, open a long time,
// finished). Every read takes `{ excludePrivateOwned, now }` last; the zone is
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
}
const DAY_MS = 86400e3

const openMissionSql = (excludePrivateOwned) => `EXISTS (SELECT 1 FROM missions m
  WHERE m.project_id = p.id AND m.user_id = p.user_id AND m.state = 'open' ${excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''})`

// Every project the caller may see as a row, with whether it is live (open,
// with at least one open mission), whether it has any mission at all, and,
// when it is not live, when it finished: its close, else its newest mission
// close, else (no mission ever) its creation.
function rowProjects(db, userId, excludePrivateOwned) {
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
    WHERE p.user_id = ? AND p.merged_into IS NULL ${excludePrivateOwned ? `AND ${PROJECT_ORIGIN_SIEVE}` : ''}`)
    .all(userId).map((r) => ({ ...r, live: Boolean(r.live), has_mission: Boolean(r.has_mission) }))
}
const refOf = (p) => ({ id: p.id, num: p.num, title: p.title })

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
function survivingProjects(db, userId, ids, byId) {
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
const isPicture = (type) => /^(image|video)\//.test(type ?? '')

// The stored pictures that still exist and that the caller may see (under the
// sieve, one the files roll-up still shows): Map(blob id → { blob_id,
// content_type, name }). One pass over the roll-up for all of them.
function liveMedia(db, userId, blobIds, excludePrivateOwned) {
  const out = new Map()
  if (!blobIds.length) return out
  const ids = JSON.stringify(blobIds)
  const owned = db.prepare('SELECT id, content_type FROM blobs WHERE owner_user_id = ? AND id IN (SELECT value FROM json_each(?))')
    .all(userId, ids)
  if (!owned.length) return out
  const rolled = new Map(db.prepare(`SELECT f.blob_id, f.content_type, f.name FROM (${filesSql(excludePrivateOwned, '1 = 1')}) f
    WHERE f.blob_id IN (SELECT value FROM json_each(@ids))`).all({ userId, ids }).map((r) => [r.blob_id, r]))
  for (const b of owned) {
    const r = rolled.get(b.id)
    if (!isPicture(r?.content_type ?? b.content_type)) continue
    if (excludePrivateOwned && !r) continue
    out.set(b.id, { blob_id: b.id, content_type: r?.content_type ?? b.content_type, name: r?.name ?? null })
  }
  return out
}

// The stored stories as the caller sees them now, in stored order:
// { title, sentence, next, projects: [project row], items: [{id,num,title,done}],
// media: {blob_id,content_type,name}|null }. A story left with no visible
// project is dropped; items and media that are gone or hidden are left out.
function resolveStored(db, userId, stored, byId, excludePrivateOwned) {
  const all = (f) => [...new Set(stored.stories.flatMap(f))]
  const projects = survivingProjects(db, userId, all((s) => s.project_ids), byId)
  const items = liveItems(db, userId, all((s) => s.item_ids), byId, excludePrivateOwned)
  const media = liveMedia(db, userId, all((s) => (s.media_blob_id ? [s.media_blob_id] : [])), excludePrivateOwned)
  const out = []
  for (const s of stored.stories) {
    const seen = new Set()
    const rows = s.project_ids.map((id) => projects.get(id)).filter((p) => p && !seen.has(p.id) && seen.add(p.id))
    if (!rows.length) continue
    out.push({
      title: s.title, sentence: s.sentence, next: s.next, projects: rows,
      items: s.item_ids.map((id) => items.get(id)).filter(Boolean),
      media: s.media_blob_id ? media.get(s.media_blob_id) ?? null : null,
    })
  }
  return out
}

// The project's open items awaiting the user, as the timeline shows them:
// unlike projectDetail's needs-you, consent cards are left out, newest created
// first, and only items created before the week ended (`@end`). Shared by the
// apps' fallback card and the Coordinator's raw read. `limit` caps the rows.
function needsYouStatement(db, convoSieve, inProject, ofProject, limit = -1) {
  return db.prepare(`SELECT i.id, i.num, i.title FROM items i JOIN missions m ON m.id = i.mission_id
      JOIN conversations c ON c.id = i.origin_convo_id
    WHERE ${ofProject} AND i.state = 'open' AND i.awaiting = 'user' AND i.consent IS NULL AND i.created_at < @end ${convoSieve}
    ORDER BY i.created_at DESC, i.num DESC LIMIT ${limit}`)
}

// One week's page: a story per project that moved, most moves first, at most
// TIMELINE.storiesMax, the rest under `also` -- or, when the Coordinator has
// written the week, its lede and stories in its order, with `also` the moving
// projects no story names. null when `weekKey` is not a week key.
export function weekDetail(db, userId, weekKey, { excludePrivateOwned = false, now = Date.now() } = {}) {
  const tz = userTimeZone(db, userId)
  const start = parseWeekKey(weekKey, tz)
  if (start == null) return null
  const end = weekEndOf(start, tz)
  const byId = new Map(rowProjects(db, userId, excludePrivateOwned).map((p) => [p.id, p]))
  const moved = ranked(projectMoves(db, userId, { from: start, to: end, excludePrivateOwned }), byId)
  const convoSieve = excludePrivateOwned ? `AND NOT ${privateConvo('c')} AND ${ORIGIN_SIEVE}` : ''
  // The project's missions and those still filed under a project merged into it.
  const inProject = 'm.project_id IN (SELECT q.id FROM projects q WHERE q.id = @projectId OR q.merged_into = @projectId)'
  const ofProject = `m.user_id = @userId AND ${inProject}`
  const sentence = db.prepare(`SELECT l.title FROM milestones l JOIN missions m ON m.id = l.mission_id
      JOIN conversations c ON c.id = l.convo_id
    WHERE ${ofProject} AND l.created_at >= @start AND l.created_at < @end ${convoSieve}
    ORDER BY l.created_at DESC, l.seq DESC LIMIT 1`)
  const needsYou = needsYouStatement(db, convoSieve, inProject, ofProject)
  // The project feed's files roll-up, narrowed to the week's pictures and videos.
  const media = db.prepare(`SELECT f.blob_id, f.content_type, f.name FROM (${filesSql(excludePrivateOwned, inProject)}) f
    WHERE f.at >= @start AND f.at < @end AND (f.content_type LIKE 'image/%' OR f.content_type LIKE 'video/%')
    ORDER BY f.at DESC, f.sort_key DESC LIMIT 1`)
  const weekMedia = (project) => media.get({ userId, projectId: project.id, start, end }) ?? null
  const head = { week: formatWeekKey(start, tz), start, end }
  const stored = writtenWeek(db, userId, weekKey)
  if (!stored) {
    const stories = moved.slice(0, TIMELINE.storiesMax).map(({ project }) => {
      const args = { userId, projectId: project.id, start, end }
      return {
        title: null,
        project: refOf(project),
        projects: [refOf(project)],
        sentence: sentence.get(args)?.title ?? null,
        next: null,
        needs_you: needsYou.all(args).map((r) => ({ ...r, done: false })),
        media: weekMedia(project),
      }
    })
    return {
      ...head, final: end <= now, lede: null, written_at: null, stories,
      also: moved.slice(TIMELINE.storiesMax).map(({ project, moved: n }) => ({ ...refOf(project), moved: n })),
    }
  }
  const stories = resolveStored(db, userId, stored, byId, excludePrivateOwned).map((s) => ({
    title: s.title,
    project: refOf(s.projects[0]),
    projects: s.projects.map(refOf),
    sentence: s.sentence,
    next: s.next,
    needs_you: s.items,
    media: s.media ?? weekMedia(s.projects[0]),
    _ids: s.projects.map((p) => p.id),
  }))
  const named = new Set(stories.flatMap((s) => s._ids))
  return {
    ...head, final: stored.final || end <= now, lede: stored.lede, written_at: stored.written_at,
    stories: stories.map(({ _ids, ...s }) => s),
    also: moved.filter(({ project }) => !named.has(project.id)).map(({ project, moved: n }) => ({ ...refOf(project), moved: n })),
  }
}

// The Coordinator's raw read of one week (it writes the week's stories from
// this): the stored week with ids resolved to refs, and every moving project
// (most moves first, at most RAW.projects) with its milestones, items and
// pictures of that week. null when `weekKey` is not a week key.
const RAW = { projects: 40, milestones: 10, items: 10, media: 5, needsYou: 10 }
export function weekRaw(db, userId, weekKey, { excludePrivateOwned = true, now = Date.now() } = {}) {
  const tz = userTimeZone(db, userId)
  const start = parseWeekKey(weekKey, tz)
  if (start == null) return null
  const end = weekEndOf(start, tz)
  const byId = new Map(rowProjects(db, userId, excludePrivateOwned).map((p) => [p.id, p]))
  const moved = ranked(projectMoves(db, userId, { from: start, to: end, excludePrivateOwned }), byId)
  const convoSieve = excludePrivateOwned ? `AND NOT ${privateConvo('c')} AND ${ORIGIN_SIEVE}` : ''
  const commentSieve = excludePrivateOwned ? `AND NOT ${privateDevice('ic.device_id')}` : ''
  const inProject = 'm.project_id IN (SELECT q.id FROM projects q WHERE q.id = @projectId OR q.merged_into = @projectId)'
  const ofProject = `m.user_id = @userId AND ${inProject}`
  const milestones = db.prepare(`SELECT l.title, l.kind, l.created_at AS at FROM milestones l JOIN missions m ON m.id = l.mission_id
      JOIN conversations c ON c.id = l.convo_id
    WHERE ${ofProject} AND l.created_at >= @start AND l.created_at < @end ${convoSieve}
    ORDER BY l.created_at DESC, l.seq DESC LIMIT ${RAW.milestones}`)
  // Every item with activity in the week (created, closed or commented, as a
  // move counts them), for all the shown projects in one pass. The week range
  // sits inside each arm so only the week's rows are read; the newest
  // RAW.items per project are kept.
  const shown = moved.slice(0, RAW.projects)
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
  for (const { project_id: pid, ...row } of itemRows) itemsOf.set(pid, [...(itemsOf.get(pid) ?? []), row])
  const media = db.prepare(`SELECT f.blob_id, f.content_type, f.name, f.at FROM (${filesSql(excludePrivateOwned, inProject)}) f
    WHERE f.at >= @start AND f.at < @end AND (f.content_type LIKE 'image/%' OR f.content_type LIKE 'video/%')
    ORDER BY f.at DESC, f.sort_key DESC LIMIT ${RAW.media}`)
  // Everything still waiting on the user, whatever the week's activity: the
  // Coordinator names these in `item_ids` and counts them in the lede.
  const needsYou = needsYouStatement(db, convoSieve, inProject, ofProject, RAW.needsYou)
  const projects = shown.map(({ project, moved: n }) => {
    const args = { userId, projectId: project.id, start, end }
    return {
      project: refOf(project), moved: n, status: project.status ?? null,
      milestones: milestones.all(args), items: itemsOf.get(project.id) ?? [], media: media.all(args),
      needs_you: needsYou.all(args),
    }
  })
  const stored = writtenWeek(db, userId, weekKey)
  return {
    week: formatWeekKey(start, tz), start, end,
    final: Boolean(stored?.final) || end <= now,
    written_at: stored?.written_at ?? null,
    current: start === weekStartOf(now, tz),
    // A story whose projects are all hidden from the caller is withheld here, as
    // the apps' read withholds it, so a Coordinator that rewrites the week from
    // this drops that story (accepted: a story never names private work).
    stored: stored && {
      lede: stored.lede, final: stored.final,
      stories: resolveStored(db, userId, stored, byId, excludePrivateOwned).map((s) => ({
        title: s.title, sentence: s.sentence, next: s.next,
        projects: s.projects.map(refOf),
        items: s.items.map(({ id, num, title }) => ({ id, num, title })),
        media_blob_id: s.media?.blob_id ?? null,
      })),
    },
    projects,
    more_projects: Math.max(0, moved.length - RAW.projects),
  }
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
