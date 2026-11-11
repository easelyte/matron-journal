// Weekly timeline stories written by the user's Coordinator (spec 2026-11-09
// projects timeline, phase 2): the lede and story cards of one local week and
// one-sentence notes on projects. A week is written either as grouped stories
// (a lede and titled cards naming several projects) or as one entry per
// project (no lede, no titles); both land in the same row. This module holds
// the limits, the body validation, the checked writes and the reads; the HTTP
// routes are in src/timeline-http.js. Nothing here trusts the Coordinator's
// references: a project, item or picture it names must resolve to the user's
// own row, and (the Coordinator always writes with the agent privacy sieve)
// to one an ordinary agent may see, so a private device's work is never put
// into text the apps show.
import { parseWeekKey, userTimeZone, weekStartOf, weekEndOf, previousWeekStart } from './timeline.js'
import { resolveProject } from './projects.js'
import { ORIGIN_SIEVE } from './missions.js'
import { privateConvo, filesSql } from './projects-feed.js'

export const WEEK_LIMITS = {
  ledeMax: 600, storiesMax: 8, titleMax: 80, sentenceMax: 300, nextMax: 300, noteMax: 300,
  notesMax: 50, projectsPerStory: 10, itemsPerStory: 10, reachWeeks: 10,
}

// The longest string reference or blob id accepted (ids are far shorter).
const REF_MAX = 128

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// A required string, trimmed, 1..max long; null when it is not.
function text(v, max) {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length >= 1 && t.length <= max ? t : null
}

// An optional string: undefined/null/empty → null; too long or not a string → undefined (invalid).
function optionalText(v, max) {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (!t) return null
  return t.length <= max ? t : undefined
}

// A reference to a project or item: a non-empty string id, or the positive
// integer per-user number. Anything else is undefined.
function ref(v) {
  if (typeof v === 'string') {
    const t = v.trim()
    return t && t.length <= REF_MAX ? t : undefined
  }
  return Number.isInteger(v) && v > 0 ? v : undefined
}

function refs(v, min, max) {
  if (v === undefined || v === null) return min === 0 ? [] : undefined
  if (!Array.isArray(v) || v.length < min || v.length > max) return undefined
  const out = v.map(ref)
  return out.includes(undefined) ? undefined : out
}

function validStory(s) {
  if (!isObject(s)) return null
  const title = text(s.title, WEEK_LIMITS.titleMax)
  const sentence = text(s.sentence, WEEK_LIMITS.sentenceMax)
  const next = optionalText(s.next, WEEK_LIMITS.nextMax)
  const project_ids = refs(s.project_ids, 1, WEEK_LIMITS.projectsPerStory)
  const item_ids = refs(s.item_ids, 0, WEEK_LIMITS.itemsPerStory)
  const blob = s.media_blob_id
  if (title === null || sentence === null || next === undefined || !project_ids || !item_ids) return null
  if (blob !== undefined && blob !== null && (typeof blob !== 'string' || !blob || blob.length > REF_MAX)) return null
  return { title, sentence, next, project_ids, item_ids, media_blob_id: blob || null }
}

// The optional `final` flag and `notes` of a write body, shared by both
// writes: { final, notes } or null when either is malformed.
function validFinalAndNotes(body) {
  if (body.final !== undefined && body.final !== null && typeof body.final !== 'boolean') return null
  const rawNotes = body.notes ?? []
  if (!Array.isArray(rawNotes) || rawNotes.length > WEEK_LIMITS.notesMax) return null
  const notes = rawNotes.map((n) => {
    if (!isObject(n)) return null
    const project = ref(n.project_id)
    const note = text(n.note, WEEK_LIMITS.noteMax)
    return project === undefined || note === null ? null : { project, note }
  })
  if (notes.includes(null)) return null
  return { final: body.final === true, notes }
}

// The write body, normalised: { lede, stories, final, notes } or null when
// malformed. Unknown extra keys are ignored.
export function validWeekWrite(body) {
  if (!isObject(body)) return null
  const lede = optionalText(body.lede, WEEK_LIMITS.ledeMax)
  if (lede === undefined) return null
  const rawStories = body.stories ?? []
  if (!Array.isArray(rawStories) || rawStories.length > WEEK_LIMITS.storiesMax) return null
  const stories = rawStories.map(validStory)
  if (stories.includes(null)) return null
  const rest = validFinalAndNotes(body)
  return rest && { lede, stories, ...rest }
}

function validEntry(e) {
  if (!isObject(e)) return null
  const project = ref(e.project)
  const sentence = text(e.sentence, WEEK_LIMITS.sentenceMax)
  const next = optionalText(e.next, WEEK_LIMITS.nextMax)
  const blob = e.media_blob_id
  if (project === undefined || sentence === null || next === undefined) return null
  if (blob !== undefined && blob !== null && (typeof blob !== 'string' || !blob || blob.length > REF_MAX)) return null
  return { project, sentence, next, media_blob_id: blob || null }
}

// The body of a write of one entry per project, normalised: { entries, final,
// notes } or null when malformed. An entry is { project, sentence, next,
// media_blob_id }; any other key (a title, a lede, a list of projects or
// items) is ignored, so it is never stored. `entries` itself is required: a
// write replaces the stored week, so a body without the list (the grouped
// write's shape sent here, or notes alone) is malformed rather than a week
// with no cards. An empty list clears what was
// written: final, the week has no cards; not final, it reads as unwritten
// (the computed cards), as an empty stories write always has.
export function validWeekEntries(body) {
  if (!isObject(body)) return null
  const rawEntries = body.entries
  if (!Array.isArray(rawEntries) || rawEntries.length > WEEK_LIMITS.storiesMax) return null
  const entries = rawEntries.map(validEntry)
  if (entries.includes(null)) return null
  const rest = validFinalAndNotes(body)
  return rest && { entries, ...rest }
}

// The id of the user's project a reference names, through a merge to the
// project that survived it, under the caller's sieve; null when none.
function resolveProjectId(db, userId, r, excludePrivateOwned) {
  return resolveProject(db, userId, r, { excludePrivateOwned })?.project.id ?? null
}

// The id of the user's item a reference names (id or per-user number), on a
// mission the sieve allows; null when none. Consent cards are not items to
// write about (the timeline's reads leave them out too).
function resolveItemId(db, userId, r, excludePrivateOwned) {
  const byId = typeof r === 'string' && r.startsWith('it_')
  const n = byId ? null : Number(String(r).replace(/^#/, ''))
  if (!byId && !(Number.isInteger(n) && n >= 1)) return null
  const sieve = excludePrivateOwned ? `AND NOT ${privateConvo('c')} AND ${ORIGIN_SIEVE}` : ''
  const row = db.prepare(`SELECT i.id FROM items i JOIN missions m ON m.id = i.mission_id AND m.user_id = i.user_id
      JOIN conversations c ON c.id = i.origin_convo_id
    WHERE i.user_id = ? AND ${byId ? 'i.id = ?' : 'i.num = ?'} AND i.consent IS NULL ${sieve}`).get(userId, byId ? r : n)
  return row?.id ?? null
}

// Whether the blob is the user's own, an image or a video (a card cannot show
// anything else) and, under the sieve, in the files
// roll-up the apps show (a picture or file of one of the user's missions, not
// of a private device's work).
function blobAllowed(db, userId, blobId, excludePrivateOwned) {
  const blob = db.prepare('SELECT content_type FROM blobs WHERE id = ? AND owner_user_id = ?').get(blobId, userId)
  if (!blob || !/^(image|video)\//.test(blob.content_type ?? '')) return false
  if (!excludePrivateOwned) return true
  return !!db.prepare(PICTURE_ROLLUP_SQL).get({ userId, blobId })
}
// The roll-up over every mission of the user, as liveMedia reads it: the
// scope names the user, so the missions are found through
// idx_missions_user_state and nothing of another user is read (pinned by a
// test).
const PICTURE_ROLLUP_SQL = `SELECT 1 FROM (${filesSql(true, 'm.user_id = @userId')}) f WHERE f.blob_id = @blobId LIMIT 1`
// Test seam: the query-plan test reads the picture check's SQL directly.
export const pictureRollupSqlForTest = PICTURE_ROLLUP_SQL

// A 400 that names the reference it is about.
const unknown = (error, ref) => ({ error: 'bad_request', detail: error, ref })

// The start instant of the week a write names, once the week rules allow the
// write: a real week key, no later than the current week and within reach
// behind it, final only once it has ended, and a final week replaced only by
// a final write. { start } or { error, detail }.
function writableWeek(db, userId, weekKey, final, now) {
  const tz = userTimeZone(db, userId)
  const start = parseWeekKey(weekKey, tz)
  if (start == null) return { error: 'bad_request', detail: 'bad_week' }
  const current = weekStartOf(now, tz)
  let oldest = current
  for (let i = 0; i < WEEK_LIMITS.reachWeeks; i++) oldest = previousWeekStart(oldest, tz)
  if (start > current || start < oldest) return { error: 'bad_request', detail: 'week_out_of_range' }
  if (final && weekEndOf(start, tz) > now) return { error: 'bad_request', detail: 'week_not_ended' }
  // Rows are found by week key (the Monday's local date), not by instant: the
  // instant moves when the user's zone changes, the date does not.
  const existing = db.prepare('SELECT final FROM week_stories WHERE user_id = ? AND week_key = ? ORDER BY final DESC').get(userId, weekKey)
  if (existing?.final && !final) return { error: 'conflict', detail: 'week_final' }
  return { start }
}

// The notes of a write with each project resolved: { notes } or the
// unknown_project error naming the reference.
function resolveNotes(db, userId, rawNotes, excludePrivateOwned) {
  const notes = []
  for (const n of rawNotes) {
    const id = resolveProjectId(db, userId, n.project, excludePrivateOwned)
    if (id == null) return unknown('unknown_project', n.project)
    notes.push({ project_id: id, note: n.note })
  }
  return { notes }
}

// Store one checked week and its notes in one transaction.
function storeWeek(db, userId, weekKey, start, { lede, stories, final, notes }, now) {
  db.transaction(() => {
    // A row written under another zone's instant for this week is replaced.
    db.prepare('DELETE FROM week_stories WHERE user_id = ? AND week_key = ? AND week_start != ?').run(userId, weekKey, start)
    db.prepare(`INSERT INTO week_stories(user_id, week_start, week_key, lede, stories, written_at, final)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(user_id, week_start) DO UPDATE SET week_key=excluded.week_key, lede=excluded.lede,
        stories=excluded.stories, written_at=excluded.written_at, final=excluded.final`)
      .run(userId, start, weekKey, lede, JSON.stringify(stories), now, final ? 1 : 0)
    const upsert = db.prepare(`INSERT INTO project_notes(user_id, project_id, note, written_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id, project_id) DO UPDATE SET note=excluded.note, written_at=excluded.written_at`)
    for (const n of notes) upsert.run(userId, n.project_id, n.note, now)
  })()
}

// Check and store one week of grouped stories. Every reference is resolved
// before anything is written; the rows go in one transaction. { ok: true,
// week } or { error, detail, ref? }.
export function writeWeek(db, userId, weekKey, input, { now = Date.now(), excludePrivateOwned = true } = {}) {
  const week = writableWeek(db, userId, weekKey, input.final, now)
  if (week.error) return week

  const projectId = (r) => resolveProjectId(db, userId, r, excludePrivateOwned)
  const stories = []
  for (const s of input.stories) {
    const project_ids = []
    for (const r of s.project_ids) {
      const id = projectId(r)
      if (id == null) return unknown('unknown_project', r)
      if (!project_ids.includes(id)) project_ids.push(id)
    }
    const item_ids = []
    for (const r of s.item_ids) {
      const id = resolveItemId(db, userId, r, excludePrivateOwned)
      if (id == null) return unknown('unknown_item', r)
      if (!item_ids.includes(id)) item_ids.push(id)
    }
    if (s.media_blob_id && !blobAllowed(db, userId, s.media_blob_id, excludePrivateOwned)) {
      return unknown('unknown_blob', s.media_blob_id)
    }
    stories.push({ title: s.title, sentence: s.sentence, next: s.next, project_ids, item_ids, media_blob_id: s.media_blob_id })
  }
  const notes = resolveNotes(db, userId, input.notes, excludePrivateOwned)
  if (notes.error) return notes

  storeWeek(db, userId, weekKey, week.start, { lede: input.lede, stories, final: input.final, notes: notes.notes }, now)
  return { ok: true, week: weekKey }
}

// Check and store one week written as one entry per project (the input of
// validWeekEntries), under the same week rules as writeWeek. Each entry is
// stored as a story with no title, its one project and no items, and the
// week has no lede. Two entries that resolve to the same project (the same
// one named twice, or one merged into the other) are refused: the second
// reference comes back as duplicate_project. { ok: true, week, entries: n }
// or { error, detail, ref? }.
export function writeWeekEntries(db, userId, weekKey, input, { now = Date.now(), excludePrivateOwned = true } = {}) {
  const week = writableWeek(db, userId, weekKey, input.final, now)
  if (week.error) return week

  const seen = new Set()
  const stories = []
  for (const e of input.entries) {
    const id = resolveProjectId(db, userId, e.project, excludePrivateOwned)
    if (id == null) return unknown('unknown_project', e.project)
    if (seen.has(id)) return unknown('duplicate_project', e.project)
    seen.add(id)
    if (e.media_blob_id && !blobAllowed(db, userId, e.media_blob_id, excludePrivateOwned)) {
      return unknown('unknown_blob', e.media_blob_id)
    }
    stories.push({ title: null, sentence: e.sentence, next: e.next, project_ids: [id], item_ids: [], media_blob_id: e.media_blob_id })
  }
  const notes = resolveNotes(db, userId, input.notes, excludePrivateOwned)
  if (notes.error) return notes

  storeWeek(db, userId, weekKey, week.start, { lede: null, stories, final: input.final, notes: notes.notes }, now)
  return { ok: true, week: weekKey, entries: stories.length }
}

// Whether a stored week says anything: a lede, a story or the final flag. A
// row from a notes-only write has none, and is read as if it did not exist.
const written = (w) => Boolean(w.lede || w.stories.length || w.final)
const parseRow = (row) => ({ week_key: row.week_key, lede: row.lede, stories: JSON.parse(row.stories), written_at: row.written_at, final: row.final === 1 })

// The stored week with the week key (the Monday's local date), or null. Keyed
// by date, not instant, so a change of the user's time zone orphans nothing.
export function storedWeek(db, userId, weekKey) {
  const row = db.prepare('SELECT week_key, lede, stories, written_at, final FROM week_stories WHERE user_id = ? AND week_key = ? ORDER BY week_start DESC')
    .get(userId, weekKey)
  return row ? parseRow(row) : null
}

// The stored week the readers use: storedWeek, or null when the row holds only
// notes.
export function writtenWeek(db, userId, weekKey) {
  const w = storedWeek(db, userId, weekKey)
  return w && written(w) ? w : null
}

// The written weeks among `weekKeys` in one query: Map(week key → week).
export function writtenWeeks(db, userId, weekKeys) {
  const out = new Map()
  if (!weekKeys.length) return out
  const rows = db.prepare(`SELECT week_key, lede, stories, written_at, final FROM week_stories
    WHERE user_id = ? AND week_key IN (SELECT value FROM json_each(?)) ORDER BY week_start`).all(userId, JSON.stringify(weekKeys))
  for (const r of rows) {
    const w = parseRow(r)
    if (written(w)) out.set(r.week_key, w)
  }
  return out
}

// Every written week of the user, newest first.
export function allWrittenWeeks(db, userId) {
  const rows = db.prepare(`SELECT week_key, lede, stories, written_at, final FROM week_stories
    WHERE user_id = ? ORDER BY week_key DESC, week_start DESC`).all(userId)
  const out = []
  let last = null
  for (const r of rows) {
    // As storedWeek reads a key held by two rows: the later instant only.
    if (r.week_key === last) continue
    last = r.week_key
    const w = parseRow(r)
    if (written(w)) out.push(w)
  }
  return out
}

// The notes on the given project ids: Map(project id → { note, written_at }).
export function projectNotes(db, userId, projectIds) {
  const out = new Map()
  if (!projectIds.length) return out
  // A note written on a project later merged into one of these counts for
  // the survivor (merges flatten, so one hop reaches it); the newest wins.
  const rows = db.prepare(`SELECT COALESCE(p.merged_into, n.project_id) AS project_id, n.note, n.written_at
    FROM project_notes n LEFT JOIN projects p ON p.id = n.project_id AND p.user_id = n.user_id
    WHERE n.user_id = @userId AND COALESCE(p.merged_into, n.project_id) IN (SELECT value FROM json_each(@ids))
    ORDER BY n.written_at`).all({ userId, ids: JSON.stringify(projectIds) })
  for (const r of rows) out.set(r.project_id, { note: r.note, written_at: r.written_at })
  return out
}
