// HTTP surface of the projects timeline (spec 2026-11-09 projects timeline).
// Six reads over projects, missions, items and milestones; one project's
// page (GET /timeline/projects/:id) and its history week by week
// (GET /timeline/projects/:id/history); the Coordinator's
// paged raw read of one week (GET /timeline/weeks/:week?raw=1), with its
// index of the whole week (&index=1) and its read of named projects
// (&projects=); and its two
// writes of a week: a lede and story cards (POST /timeline/weeks/:week) or
// one entry per project (POST /timeline/weeks/:week/entries), storage and
// rules in src/week-stories.js. The read functions in src/timeline.js assume
// valid input, so every parameter is validated here (400) before one is
// called.
import { json, readBody } from './http-body.js'
import { badRequest, notFound } from './http-who.js'
import { closingConvo, refusedCloser } from './missions-http.js'
import { filteredAgent } from './privacy.js'
import { parseCursor } from './projects-feed.js'
import { resolveProject } from './projects.js'
import { projectPage, projectHistory, PROJECT_HISTORY } from './timeline-project.js'
import { validWeekWrite, writeWeek, validWeekEntries, writeWeekEntries } from './week-stories.js'
import {
  weeksList, weekDetail, weekRaw, weekIndex, RAW, TIMELINE, wentQuiet, openLong, finished, allProjects, parseWeekKey, userTimeZone,
} from './timeline.js'

const WEEKS_LIMIT = { default: 12, max: 52 }
const FINISHED_LIMIT = { default: 30, max: 100 }
const PROJECTS_LIMIT = { default: TIMELINE.allPage, max: 100 }
const HISTORY_LIMIT = { default: PROJECT_HISTORY.page, max: PROJECT_HISTORY.pageMax }
const RAW_LIMIT = { default: RAW.page, max: RAW.pageMax }

// The integer `limit` query parameter: its default when absent, null when not
// an integer in 1..max.
function limitOf(url, { default: dflt, max }) {
  const raw = url.searchParams.get('limit')
  if (raw == null) return dflt
  const n = Number(raw)
  return /^\d+$/.test(raw) && Number.isInteger(n) && n >= 1 && n <= max ? n : null
}

// The integer `offset` query parameter: 0 when absent, null when not an
// integer from 0 up.
function offsetOf(url) {
  const raw = url.searchParams.get('offset')
  if (raw == null) return 0
  const n = Number(raw)
  return /^\d+$/.test(raw) && Number.isSafeInteger(n) ? n : null
}

// The `projects` query parameter of the raw week read: undefined when
// absent, else its comma-separated references (each a project id or a
// number), null unless there are 1..RAW.page of them, all well formed.
const PROJECT_REF = /^(pj_[0-9A-Za-z]{1,60}|[1-9]\d{0,14})$/
function pickedOf(url) {
  const raw = url.searchParams.get('projects')
  if (raw == null) return undefined
  const refs = raw.split(',')
  return refs.length <= RAW.page && refs.every((r) => PROJECT_REF.test(r)) ? refs : null
}

// GET /timeline/weeks?before=<week key>&limit=<1..52>
function handleWeeks(db, res, url, who, opts) {
  const limit = limitOf(url, WEEKS_LIMIT)
  if (limit == null) return badRequest(res)
  const before = url.searchParams.get('before')
  if (before != null && parseWeekKey(before, userTimeZone(db, who.userId)) == null) return badRequest(res)
  json(res, 200, weeksList(db, who.userId, { before, limit, ...opts }))
  return true
}

// GET /timeline/finished?before=<"<finished_at>:<project id>">&limit=<1..100>
function handleFinished(db, res, url, who, opts) {
  const limit = limitOf(url, FINISHED_LIMIT)
  if (limit == null) return badRequest(res)
  const before = url.searchParams.get('before')
  if (parseCursor(before) === undefined) return badRequest(res)
  json(res, 200, finished(db, who.userId, { before, limit, ...opts }))
  return true
}

// GET /timeline/projects?before=<"<at>:<project id>">&limit=<1..100>&raw=1?
function handleProjects(db, res, url, who, opts) {
  const limit = limitOf(url, PROJECTS_LIMIT)
  if (limit == null) return badRequest(res)
  const before = url.searchParams.get('before')
  if (parseCursor(before) === undefined) return badRequest(res)
  json(res, 200, allProjects(db, who.userId, { before, limit, ...opts }))
  return true
}

// GET /timeline/projects/:id — one project's page; `:id` is a project id or
// its number. A read, so it follows a merge to the project that survived it,
// as GET /projects/:id does: the survivor's page plus `merged_from`. A project
// the caller cannot see is 404, like one that does not exist.
function handleProject(db, res, who, ref, opts) {
  const r = resolveProject(db, who.userId, ref, opts)
  if (!r) return notFound(res)
  json(res, 200, { ...projectPage(db, who.userId, r.project, opts), ...(r.mergedFrom ? { merged_from: r.mergedFrom } : {}) })
  return true
}

// GET /timeline/projects/:id/history?before=<week key>&limit=<1..26> — the
// weeks the project moved in, newest first. The project is found as the
// page finds it (id or number, through a merge, 404 when hidden or unknown).
function handleProjectHistory(db, res, url, who, ref, opts) {
  const limit = limitOf(url, HISTORY_LIMIT)
  if (limit == null) return badRequest(res)
  const before = url.searchParams.get('before')
  if (before != null && parseWeekKey(before, userTimeZone(db, who.userId)) == null) return badRequest(res)
  const r = resolveProject(db, who.userId, ref, opts)
  if (!r) return notFound(res)
  json(res, 200, projectHistory(db, who.userId, r.project, { before, limit, ...opts }))
  return true
}

// POST /timeline/weeks/:week — the Coordinator's lede and story cards for one
// week, and its notes on projects. POST /timeline/weeks/:week/entries — the
// same week as one entry per project (`entries` true): no lede, no titles,
// and the reply counts the entries stored. Agents only, gated exactly like
// POST /briefings (the Coordinator naming its own conversation). The
// Coordinator always writes under the agent privacy sieve, whatever device it
// runs on.
async function handleWeekWrite(db, req, res, who, week, { entries = false } = {}) {
  if (who.kind !== 'agent') { json(res, 403, { error: 'forbidden' }); return true }
  const body = await readBody(req)
  if (refusedCloser(res, closingConvo(db, who, body.convo_id, { required: true }))) return true
  const input = entries ? validWeekEntries(body) : validWeekWrite(body)
  if (!input) return badRequest(res)
  const r = (entries ? writeWeekEntries : writeWeek)(db, who.userId, week, input, { excludePrivateOwned: true })
  if (r.error === 'conflict') { json(res, 409, { error: 'conflict', detail: r.detail }); return true }
  if (r.error) { json(res, 400, { error: r.error, detail: r.detail, ...(r.ref !== undefined && { ref: r.ref }) }); return true }
  json(res, 201, { week: r.week, written: true, final: input.final, ...(entries && { entries: r.entries }) })
  return true
}

export async function handleTimelineRoute(ctx, req, res, url, who) {
  const { db } = ctx
  const path = url.pathname
  if (!path.startsWith('/timeline/')) return false
  if (req.method === 'POST') {
    const e = path.match(/^\/timeline\/weeks\/([^/]+)\/entries$/)
    const w = e ?? path.match(/^\/timeline\/weeks\/([^/]+)$/)
    if (!w) return false
    let week
    try { week = decodeURIComponent(w[1]) } catch { return badRequest(res) }
    return handleWeekWrite(db, req, res, who, week, { entries: Boolean(e) })
  }
  if (req.method !== 'GET') return false
  const opts = { excludePrivateOwned: filteredAgent(db, who) }
  // The Coordinator reads the stalled lists, the list of live projects and a
  // project's page and history to write notes, a lede and entries that the
  // filtered apps then show, so (like its raw week read and its write) its
  // `?raw=1` read of them is always under the agent privacy sieve, whatever
  // device it runs on: a private-origin project is no row there, and 404 by
  // id or number. A client sending raw=1 gets the ordinary read.
  const rawOpts = url.searchParams.get('raw') === '1' && who.kind === 'agent' ? { excludePrivateOwned: true } : opts
  if (path === '/timeline/weeks') return handleWeeks(db, res, url, who, opts)
  if (path === '/timeline/quiet') { json(res, 200, wentQuiet(db, who.userId, rawOpts)); return true }
  if (path === '/timeline/long') { json(res, 200, openLong(db, who.userId, rawOpts)); return true }
  if (path === '/timeline/finished') return handleFinished(db, res, url, who, opts)
  if (path === '/timeline/projects') return handleProjects(db, res, url, who, rawOpts)
  const one = path.match(/^\/timeline\/projects\/([^/]+)(\/history)?$/)
  if (one) {
    let ref
    try { ref = decodeURIComponent(one[1]) } catch { return badRequest(res) }
    return one[2] ? handleProjectHistory(db, res, url, who, ref, rawOpts) : handleProject(db, res, who, ref, rawOpts)
  }
  const m = path.match(/^\/timeline\/weeks\/([^/]+)$/)
  if (!m) return false
  let week
  try { week = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  if (url.searchParams.get('raw') === '1') {
    // The Coordinator's input, a page of projects at a time
    // (&offset=<int from 0>&limit=<1..20>): agents only, and always under
    // the agent privacy sieve.
    if (who.kind !== 'agent') { json(res, 403, { error: 'forbidden' }); return true }
    // Two more reads of the same week, neither paged: &index=1, a compact
    // row for every moving project, and &projects=<1..12 ids or numbers,
    // comma-separated>, the page's detail for exactly those.
    const q = url.searchParams
    const index = q.get('index')
    const picked = pickedOf(url)
    if (index != null || picked !== undefined) {
      const alone = (index == null) !== (picked === undefined) && !q.has('offset') && !q.has('limit')
      if (!alone || picked === null || (index != null && index !== '1')) return badRequest(res)
      const read = picked
        ? weekRaw(db, who.userId, week, { picked, excludePrivateOwned: true })
        : weekIndex(db, who.userId, week, { excludePrivateOwned: true })
      if (!read) return badRequest(res)
      json(res, 200, read)
      return true
    }
    const offset = offsetOf(url)
    const limit = limitOf(url, RAW_LIMIT)
    if (offset == null || limit == null) return badRequest(res)
    const raw = weekRaw(db, who.userId, week, { offset, limit, excludePrivateOwned: true })
    if (!raw) return badRequest(res)
    json(res, 200, raw)
    return true
  }
  const detail = weekDetail(db, who.userId, week, opts)
  if (!detail) return badRequest(res)
  json(res, 200, detail)
  return true
}
