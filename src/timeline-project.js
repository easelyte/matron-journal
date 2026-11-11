// One project on the timeline: the summary its page opens with, and its
// history week by week. Pure DB reads over what src/timeline.js already
// defines (moves, the stored weeks, the sieves), for one project the caller
// has already resolved (through a merge, under its own sieve).
// `excludePrivateOwned` hides what an ordinary agent may not see, exactly as
// the week reads do.
import { ORIGIN_SIEVE } from './missions.js'
import { filesSql, milestonesSql, feedMilestone } from './projects-feed.js'
import { allWrittenWeeks, writtenWeeks } from './week-stories.js'
import {
  userTimeZone, parseWeekKey, formatWeekKey, weekEndOf, projectMoveTimes, weekStartsOf, namedProjects, storyProjects,
  liveMedia, convoSieveOf, IN_PROJECT, OF_PROJECT, needsYouSql, forYouSql,
} from './timeline.js'

export const PROJECT_PAGE = {
  needsYou: 10, // waiting items listed on the page; needs_you_total counts them all
}

export const PROJECT_HISTORY = {
  page: 8, // weeks per page by default
  pageMax: 26,
  milestones: 20, // milestones listed per week; more_milestones counts the rest
}

const PICTURES = "(f.content_type LIKE 'image/%' OR f.content_type LIKE 'video/%')"
// The needs-you SQL asks for items created before @end; a page takes them all.
const ALWAYS = Number.MAX_SAFE_INTEGER

// What the stored `weeks` say about the project: for each week with a story
// whose main project is this one (the first project the story names that the
// caller may see, through merges; the first such story wins, as on the week
// page), { week, story }, in the order of `weeks`. One statement, however
// many weeks: only the projects the stories name are looked up, and each is
// kept under the rule that makes a project a row of the timeline.
function storiesAbout(db, userId, project, weeks, excludePrivateOwned) {
  const ids = [...new Set(weeks.flatMap((w) => w.stories.flatMap((s) => s.project_ids)))]
  const projects = namedProjects(db, userId, ids, excludePrivateOwned)
  const out = []
  for (const week of weeks) {
    const story = week.stories.find((s) => storyProjects(s, projects)[0]?.id === project.id)
    if (story) out.push({ week, story })
  }
  return out
}

// The newest picture picked for the project in a stored week that still
// resolves for the caller, as { media, at }; null when none does. A pick
// dates from the end of its week, or from when it was written if that came
// first (a week still running).
function storedPick(db, userId, about, tz, excludePrivateOwned) {
  const picks = about.filter((a) => a.story.media_blob_id)
  const live = liveMedia(db, userId, [...new Set(picks.map((a) => a.story.media_blob_id))], excludePrivateOwned)
  const pick = picks.find((a) => live.has(a.story.media_blob_id))
  if (!pick) return null
  const start = parseWeekKey(pick.week.week_key, tz)
  const end = start == null ? pick.week.written_at : weekEndOf(start, tz)
  return { media: live.get(pick.story.media_blob_id), at: Math.min(end, pick.week.written_at) }
}

// The summary of one project:
// { project: {id,num,title,state,live}, sentence, sentence_source, next,
//   needs_you: [{id,num,title}], needs_you_total, media, counts }.
// - `sentence` is the project's status (`sentence_source` 'status'), else its
//   newest milestone's title ('milestone'), else null (null).
// - `next` is what the newest stored week about the project says comes next;
//   null when that week says nothing, or no week is about it.
// - `needs_you` is the newest PROJECT_PAGE.needsYou of its open items waiting
//   on the user, consent cards left out; `needs_you_total` counts them all.
// - `media` is the newer of the newest stored pick that still resolves and
//   the newest picture or video among its files (the pick on a tie).
// - `counts`: the local weeks it moved in, its open and closed missions, and
//   its files.
// `project` is the row getProject returns (its status already sieved).
export function projectPage(db, userId, project, { excludePrivateOwned = false } = {}) {
  const tz = userTimeZone(db, userId)
  const convoSieve = convoSieveOf(excludePrivateOwned)
  const args = { userId, projectId: project.id }

  const missions = new Map(db.prepare(`SELECT m.state, COUNT(*) AS n FROM missions m
    WHERE ${OF_PROJECT} ${excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''} GROUP BY m.state`).all(args).map((r) => [r.state, r.n]))
  const open = missions.get('open') ?? 0

  let sentence = project.status?.trim() || null
  let source = sentence ? 'status' : null
  if (!sentence) {
    sentence = db.prepare(`SELECT l.title FROM milestones l JOIN missions m ON m.id = l.mission_id
        JOIN conversations c ON c.id = l.convo_id
      WHERE ${OF_PROJECT} ${convoSieve} ORDER BY l.created_at DESC, l.seq DESC LIMIT 1`).get(args)?.title ?? null
    source = sentence ? 'milestone' : null
  }

  const about = storiesAbout(db, userId, project, allWrittenWeeks(db, userId), excludePrivateOwned)

  // The files roll-up, read once: its first row is the newest picture or
  // video when there is one (`picture`), and every row carries the count.
  const first = db.prepare(`SELECT f.blob_id, f.content_type, f.name, f.at, ${PICTURES} AS picture, COUNT(*) OVER () AS total
    FROM (${filesSql(excludePrivateOwned, IN_PROJECT)}) f
    ORDER BY picture DESC, f.at DESC, f.sort_key DESC LIMIT 1`).get(args)
  const newest = first?.picture ? first : null
  const pick = storedPick(db, userId, about, tz, excludePrivateOwned)
  const fromFiles = newest ? { blob_id: newest.blob_id, content_type: newest.content_type, name: newest.name } : null
  const media = pick && (!newest || pick.at >= newest.at) ? pick.media : fromFiles

  const waiting = { ...args, end: ALWAYS }
  return {
    project: { id: project.id, num: project.num, title: project.title, state: project.state, live: project.state === 'open' && open > 0 },
    sentence,
    sentence_source: source,
    next: about[0]?.story.next ?? null,
    needs_you: db.prepare(needsYouSql(convoSieve, PROJECT_PAGE.needsYou)).all(waiting),
    needs_you_total: db.prepare(forYouSql(convoSieve)).get(waiting).n,
    media,
    counts: {
      weeks: weekStartsOf(projectMoveTimes(db, userId, project.id, { excludePrivateOwned }), tz).length,
      missions_open: open,
      missions_done: missions.get('closed') ?? 0,
      files: first?.total ?? 0,
    },
  }
}

// The project's history: every local week it moved in, newest first, from
// the newest (or from the first before the week `before`, a week key),
// `limit` weeks a page:
// { weeks: [{ week, start, end, card, milestones, more_milestones }], next_before }.
// - `card` is { sentence, media } when a stored week has a story about the
//   project (see storiesAbout): the story's sentence, and its picture as the
//   week page resolves it (the stored pick if it still resolves, else the
//   newest picture or video among the project's files of that week, else
//   null). null for a week nobody wrote about it.
// - `milestones` are the week's, newest first, at most
//   PROJECT_HISTORY.milestones, each exactly as the project feed returns a
//   milestone; `more_milestones` is how many more the week has.
// `next_before` is the last week shown when older ones remain, else null.
// null when `before` is not a week key. A fixed number of statements, plus
// one for each returned week's milestones.
export function projectHistory(db, userId, project, { before = null, limit = PROJECT_HISTORY.page, excludePrivateOwned = false } = {}) {
  const tz = userTimeZone(db, userId)
  let starts = weekStartsOf(projectMoveTimes(db, userId, project.id, { excludePrivateOwned }), tz)
  if (before != null) {
    const b = parseWeekKey(before, tz)
    if (b == null) return null
    starts = starts.filter((s) => s < b)
  }
  const shown = starts.slice(0, limit).map((start) => ({ week: formatWeekKey(start, tz), start, end: weekEndOf(start, tz) }))

  const stored = writtenWeeks(db, userId, shown.map((w) => w.week))
  const about = new Map(storiesAbout(db, userId, project, [...stored.values()], excludePrivateOwned)
    .map(({ week, story }) => [week.week_key, story]))
  const picks = [...new Set([...about.values()].map((s) => s.media_blob_id).filter(Boolean))]
  const live = liveMedia(db, userId, picks, excludePrivateOwned)

  const args = { userId, projectId: project.id }
  // The newest picture or video of each week whose card has no pick that
  // resolves: one statement over the files roll-up for all of them. The weeks
  // do not overlap, so a file falls in at most one; the roll-up is the outer
  // loop (CROSS JOIN fixes the order), read once.
  const bare = shown.filter((w) => about.has(w.week) && !live.has(about.get(w.week).media_blob_id))
  const weekMedia = new Map(bare.length ? db.prepare(`SELECT week, blob_id, content_type, name FROM (
      SELECT w.value ->> 'week' AS week, f.blob_id, f.content_type, f.name,
        ROW_NUMBER() OVER (PARTITION BY w.key ORDER BY f.at DESC, f.sort_key DESC) AS rn
      FROM (${filesSql(excludePrivateOwned, IN_PROJECT)}) f CROSS JOIN json_each(@weeks) w
      WHERE ${PICTURES} AND f.at >= @from AND f.at < @to AND f.at >= w.value ->> 'start' AND f.at < w.value ->> 'end')
    WHERE rn = 1`).all({ ...args, weeks: JSON.stringify(bare), from: bare.at(-1).start, to: bare[0].end })
    .map(({ week, ...m }) => [week, m]) : [])
  // `total` counts the week's milestones before the cap.
  const milestones = db.prepare(`SELECT f.*, COUNT(*) OVER () AS total FROM (${milestonesSql(excludePrivateOwned, IN_PROJECT)}) f
    WHERE f.at >= @start AND f.at < @end ORDER BY f.at DESC, f.sort_key DESC LIMIT ${PROJECT_HISTORY.milestones}`)

  const weeks = shown.map(({ week, start, end }) => {
    const range = { ...args, start, end }
    const story = about.get(week)
    const rows = milestones.all(range)
    return {
      week, start, end,
      card: story ? { sentence: story.sentence, media: live.get(story.media_blob_id) ?? weekMedia.get(week) ?? null } : null,
      milestones: rows.map(({ total: _total, ...r }) => feedMilestone(r)),
      more_milestones: rows.length ? rows[0].total - rows.length : 0,
    }
  })
  return { weeks, next_before: starts.length > limit ? shown.at(-1).week : null }
}
