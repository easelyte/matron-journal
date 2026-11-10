// Weekly timeline stories written by the user's Coordinator (spec 2026-11-09
// projects timeline, phase 2): the lede and story cards of one local week and
// one-sentence notes on projects. This module holds the limits, the body
// validation, the checked write and the two reads; the HTTP route is in
// src/timeline-http.js. Nothing here trusts the Coordinator's references: a
// project, item or picture it names must resolve to the user's own row, and
// (the Coordinator always writes with the agent privacy sieve) to one an
// ordinary agent may see, so a private device's work is never put into text
// the apps show.
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
  return { lede, stories, final: body.final === true, notes }
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
  return !!db.prepare(`SELECT 1 FROM (${filesSql(true, '1 = 1')}) f WHERE f.blob_id = @blobId LIMIT 1`).get({ userId, blobId })
}

const unknown = (error, ref) => ({ error: 'bad_request', detail: error, ref })

// Check and store one week. Every reference is resolved before anything is
// written; the rows go in one transaction. { ok: true, week } or
// { error, detail, ref? }.
export function writeWeek(db, userId, weekKey, input, { now = Date.now(), excludePrivateOwned = true } = {}) {
  const tz = userTimeZone(db, userId)
  const start = parseWeekKey(weekKey, tz)
  if (start == null) return { error: 'bad_request', detail: 'bad_week' }
  const current = weekStartOf(now, tz)
  let oldest = current
  for (let i = 0; i < WEEK_LIMITS.reachWeeks; i++) oldest = previousWeekStart(oldest, tz)
  if (start > current || start < oldest) return { error: 'bad_request', detail: 'week_out_of_range' }
  if (input.final && weekEndOf(start, tz) > now) return { error: 'bad_request', detail: 'week_not_ended' }
  // Rows are found by week key (the Monday's local date), not by instant: the
  // instant moves when the user's zone changes, the date does not.
  const existing = db.prepare('SELECT final FROM week_stories WHERE user_id = ? AND week_key = ? ORDER BY final DESC').get(userId, weekKey)
  if (existing?.final && !input.final) return { error: 'conflict', detail: 'week_final' }

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
  const notes = []
  for (const n of input.notes) {
    const id = projectId(n.project)
    if (id == null) return unknown('unknown_project', n.project)
    notes.push({ project_id: id, note: n.note })
  }

  db.transaction(() => {
    // A row written under another zone's instant for this week is replaced.
    db.prepare('DELETE FROM week_stories WHERE user_id = ? AND week_key = ? AND week_start != ?').run(userId, weekKey, start)
    db.prepare(`INSERT INTO week_stories(user_id, week_start, week_key, lede, stories, written_at, final)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(user_id, week_start) DO UPDATE SET week_key=excluded.week_key, lede=excluded.lede,
        stories=excluded.stories, written_at=excluded.written_at, final=excluded.final`)
      .run(userId, start, weekKey, input.lede, JSON.stringify(stories), now, input.final ? 1 : 0)
    const upsert = db.prepare(`INSERT INTO project_notes(user_id, project_id, note, written_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id, project_id) DO UPDATE SET note=excluded.note, written_at=excluded.written_at`)
    for (const n of notes) upsert.run(userId, n.project_id, n.note, now)
  })()
  return { ok: true, week: weekKey }
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
