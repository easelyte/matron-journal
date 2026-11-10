// HTTP surface of the projects timeline (spec 2026-11-09 projects timeline).
// Five reads over projects, missions, items and milestones; the Coordinator's
// raw read of one week (GET /timeline/weeks/:week?raw=1); and its write of a
// week's lede and story cards (POST /timeline/weeks/:week, storage and rules
// in src/week-stories.js). The read functions in src/timeline.js assume valid
// input, so every parameter is validated here (400) before one is called.
import { json, readBody } from './http-body.js'
import { badRequest } from './http-who.js'
import { closingConvo, refusedCloser } from './missions-http.js'
import { filteredAgent } from './privacy.js'
import { parseCursor } from './projects-feed.js'
import { validWeekWrite, writeWeek } from './week-stories.js'
import { weeksList, weekDetail, weekRaw, wentQuiet, openLong, finished, parseWeekKey, userTimeZone } from './timeline.js'

const WEEKS_LIMIT = { default: 12, max: 52 }
const FINISHED_LIMIT = { default: 30, max: 100 }

// The integer `limit` query parameter: its default when absent, null when not
// an integer in 1..max.
function limitOf(url, { default: dflt, max }) {
  const raw = url.searchParams.get('limit')
  if (raw == null) return dflt
  const n = Number(raw)
  return /^\d+$/.test(raw) && Number.isInteger(n) && n >= 1 && n <= max ? n : null
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

// POST /timeline/weeks/:week — the Coordinator's lede and story cards for one
// week, and its notes on projects. Agents only, gated exactly like POST
// /briefings (the Coordinator naming its own conversation). The Coordinator
// always writes under the agent privacy sieve, whatever device it runs on.
async function handleWeekWrite(db, req, res, who, week) {
  if (who.kind !== 'agent') { json(res, 403, { error: 'forbidden' }); return true }
  const body = await readBody(req)
  if (refusedCloser(res, closingConvo(db, who, body.convo_id, { required: true }))) return true
  const input = validWeekWrite(body)
  if (!input) return badRequest(res)
  const r = writeWeek(db, who.userId, week, input, { excludePrivateOwned: true })
  if (r.error === 'conflict') { json(res, 409, { error: 'conflict', detail: r.detail }); return true }
  if (r.error) { json(res, 400, { error: r.error, detail: r.detail, ...(r.ref !== undefined && { ref: r.ref }) }); return true }
  json(res, 201, { week: r.week, written: true, final: input.final })
  return true
}

export async function handleTimelineRoute(ctx, req, res, url, who) {
  const { db } = ctx
  const path = url.pathname
  if (!path.startsWith('/timeline/')) return false
  if (req.method === 'POST') {
    const w = path.match(/^\/timeline\/weeks\/([^/]+)$/)
    if (!w) return false
    let week
    try { week = decodeURIComponent(w[1]) } catch { return badRequest(res) }
    return handleWeekWrite(db, req, res, who, week)
  }
  if (req.method !== 'GET') return false
  const opts = { excludePrivateOwned: filteredAgent(db, who) }
  // The Coordinator reads the stalled lists to write notes and a lede that the
  // filtered apps then show, so (like its raw week read and its write) its
  // `?raw=1` read of them is always under the agent privacy sieve, whatever
  // device it runs on. A client sending raw=1 gets the ordinary read.
  const rawOpts = url.searchParams.get('raw') === '1' && who.kind === 'agent' ? { excludePrivateOwned: true } : opts
  if (path === '/timeline/weeks') return handleWeeks(db, res, url, who, opts)
  if (path === '/timeline/quiet') { json(res, 200, wentQuiet(db, who.userId, rawOpts)); return true }
  if (path === '/timeline/long') { json(res, 200, openLong(db, who.userId, rawOpts)); return true }
  if (path === '/timeline/finished') return handleFinished(db, res, url, who, opts)
  const m = path.match(/^\/timeline\/weeks\/([^/]+)$/)
  if (!m) return false
  let week
  try { week = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  if (url.searchParams.get('raw') === '1') {
    // The Coordinator's input: agents only, and always under the agent privacy sieve.
    if (who.kind !== 'agent') { json(res, 403, { error: 'forbidden' }); return true }
    const raw = weekRaw(db, who.userId, week, { excludePrivateOwned: true })
    if (!raw) return badRequest(res)
    json(res, 200, raw)
    return true
  }
  const detail = weekDetail(db, who.userId, week, opts)
  if (!detail) return badRequest(res)
  json(res, 200, detail)
  return true
}
