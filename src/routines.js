// Pure DB state for Coordinator routines (spec 2026-10-01 coordinator
// routines): a schedule (5-field cron in a named zone) and a prompt the
// journal owns and fires into whichever conversation holds the Coordinator
// role. No hub, no markers, no delivery here — src/routines-http.js owns the
// routes and markers, src/routines-sweep.js the firing. Same stance as
// missions.js: every recoverable failure is a tagged Error the HTTP layer
// maps to one status ('conflict' = name taken, 'cap' = too many).
import { randomBytes } from 'node:crypto'
import { Cron } from 'croner'

export const ROUTINES_MAX = 50
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const TITLE_MAX = 200
export const PROMPT_MAX = 2000 // the session_control message cap
export const DEFAULT_TZ = 'Europe/London'
// A routine is a check-in, not a poll: consecutive fires at least this far
// apart, checked over the next few fires from validation time.
export const MIN_GAP_MS = 15 * 60000
const GAP_CHECK_FIRES = 5
// A fire more than this late (the journal was down, the clock jumped) is
// marked missed rather than run: a 07:05 sweep is not wanted at 15:00.
export const MISSED_AFTER_MS = 6 * 3600000
export const RETRY_AFTER_MS = 15 * 60000

// eslint-disable-next-line no-control-regex -- the control range is the point
const LINE_BAD = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
// Prompt: keep line breaks (CRLF, CR, NEL, U+2028/9 folded to \n), drop
// every other control character.
// eslint-disable-next-line no-control-regex
const PROMPT_BAD = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u0084\u0086-\u009f]/g

export const STARTER_ROUTINES = Object.freeze([
  { name: 'daily-sweep', title: 'Daily sweep', schedule: '5 7 * * *', prompt: 'Routine daily-sweep: follow the Daily sweep section of your playbook.' },
  { name: 'session-health', title: 'Session health check', schedule: '0 */2 * * *', prompt: 'Routine session-health: follow the Session health section of your playbook.' },
  { name: 'project-status', title: 'Project status refresh', schedule: '0 8,17 * * *', prompt: 'Routine project-status: follow the Project status refresh section of your playbook.' },
  { name: 'unseen-digest', title: 'Unseen digest', schedule: '0 12,18 * * *', prompt: 'Routine unseen-digest: follow the Unseen digest section of your playbook.' },
  { name: 'deploy-window', title: 'Evening deploy window', schedule: '30 18 * * 1-5', prompt: 'Routine deploy-window: follow the Evening deploy window section of your playbook.' },
  // Triggered (Dan, 1 Oct: "Add triggers"): fired the moment a rule trips,
  // once per session or box per crossing, with the specifics in the turn.
  { name: 'context-over', title: 'Session context over the threshold', trigger: { kind: 'context_over', pct: 40 }, prompt: 'Routine context-over: follow the Session context over the threshold section of your playbook.' },
  { name: 'stalled-session', title: 'Session stalled on a usage limit', trigger: { kind: 'stalled', reset_minutes: 120 }, prompt: 'Routine stalled-session: follow the Session stalled on a usage limit section of your playbook.' },
  { name: 'disk-low', title: 'Box disk under the threshold', trigger: { kind: 'disk_under', pct: 20 }, prompt: 'Routine disk-low: follow the Box disk under the threshold section of your playbook.' },
])

// Triggers (spec "Triggers"): what a routine can fire on instead of a clock.
//   context_over {pct}        a live session's context gauge at or past pct
//   stalled {reset_minutes}   a session stalled on a usage limit whose reset
//                             is at least reset_minutes away, or unknown
//   disk_under {pct}          an agent box with under pct% free disk
export const TRIGGER_KINDS = Object.freeze(['context_over', 'stalled', 'disk_under'])
const STALLED_DEFAULT_MINUTES = 120
const STALLED_MAX_MINUTES = 7 * 24 * 60

export function validateTrigger(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const keys = Object.keys(raw).filter((k) => raw[k] !== undefined)
  if (!TRIGGER_KINDS.includes(raw.kind)) return null
  if (raw.kind === 'stalled') {
    if (keys.some((k) => !['kind', 'reset_minutes'].includes(k))) return null
    const m = raw.reset_minutes === undefined ? STALLED_DEFAULT_MINUTES : raw.reset_minutes
    if (!Number.isInteger(m) || m < 0 || m > STALLED_MAX_MINUTES) return null
    return { kind: 'stalled', reset_minutes: m }
  }
  if (keys.some((k) => !['kind', 'pct'].includes(k))) return null
  if (!Number.isInteger(raw.pct) || raw.pct < 1 || raw.pct > 99) return null
  return { kind: raw.kind, pct: raw.pct }
}

export const parseTrigger = (text) => { try { return text ? validateTrigger(JSON.parse(text)) : null } catch { return null } }

export const newRoutineId = () => `rt_${randomBytes(8).toString('hex')}`

export function validTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true } catch { return false }
}

// croner also takes six fields (seconds) and names like "@daily"; the
// routine grammar is the plain five-field cron the apps show and edit.
function cronOf(schedule, tz) {
  if (typeof schedule !== 'string' || schedule.trim().split(/\s+/).length !== 5) return null
  try { return new Cron(schedule.trim(), { timezone: tz }) } catch { return null }
}

// The next fire strictly after `from` (ms), or null for a bad pattern/zone.
export function nextRunAt(schedule, tz, from) {
  const cron = cronOf(schedule, tz)
  if (!cron) return null
  const d = cron.nextRun(new Date(from))
  return d ? d.getTime() : null
}

function validSchedule(schedule, tz, now) {
  const cron = cronOf(schedule, tz)
  if (!cron) return false
  const runs = cron.nextRuns(GAP_CHECK_FIRES, new Date(now))
  // Fewer fires than asked for means the pattern runs out (a date that
  // never comes): an enabled routine would silently stop with next_at NULL.
  if (runs.length < GAP_CHECK_FIRES) return false
  for (let i = 1; i < runs.length; i++) {
    const gap = runs[i].getTime() - runs[i - 1].getTime()
    // Across a spring-forward fold croner reports the skipped hour as the
    // same instant twice; nextRun() fires it once, so a 0 gap is not a poll.
    if (gap > 0 && gap < MIN_GAP_MS) return false
  }
  return true
}

export function normalizePrompt(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.replace(/\r\n|\r|\u0085|\u2028|\u2029/g, '\n').replace(PROMPT_BAD, '').trim()
  if (!text || text.length > PROMPT_MAX) return null
  return text
}

// Create (all required, tz/enabled defaulted) or partial (PATCH: given keys
// only, name not editable). Returns {ok, value} — the HTTP layer answers a
// bare 400 for !ok, the bridge tools validate again with reasons.
export function validateRoutineFields(body, { partial = false, now = Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false }
  const out = {}
  if (!partial) {
    if (typeof body.name !== 'string' || !NAME_RE.test(body.name)) return { ok: false }
    out.name = body.name
  } else if ('name' in body) return { ok: false }
  if ('title' in body || !partial) {
    const t = typeof body.title === 'string' ? body.title.trim() : ''
    if (!t || t.length > TITLE_MAX || LINE_BAD.test(t)) return { ok: false }
    out.title = t
  }
  if ('prompt' in body || !partial) {
    const p = normalizePrompt(body.prompt)
    if (!p) return { ok: false }
    out.prompt = p
  }
  if ('tz' in body || !partial) {
    const tz = body.tz === undefined ? DEFAULT_TZ : body.tz
    if (!validTz(tz)) return { ok: false }
    out.tz = tz
  }
  // Exactly one of schedule and trigger on create; on a PATCH either may be
  // given (updateRoutine refuses the one the row does not have), never both.
  const hasSchedule = body.schedule !== undefined && body.schedule !== null
  const hasTrigger = body.trigger !== undefined && body.trigger !== null
  if (hasSchedule && hasTrigger) return { ok: false }
  if (!partial && !hasSchedule && !hasTrigger) return { ok: false }
  if (hasSchedule) {
    // Spacing depends on the zone only at DST edges; validate against the
    // zone given (or the default) — a PATCH of schedule alone is checked
    // against the default zone here and the row's own zone in updateRoutine.
    if (typeof body.schedule !== 'string') return { ok: false }
    const schedule = body.schedule.trim()
    if (!validSchedule(schedule, out.tz ?? DEFAULT_TZ, now)) return { ok: false }
    out.schedule = schedule
    if (!partial) out.trigger = null
  }
  if (hasTrigger) {
    const trigger = validateTrigger(body.trigger)
    if (!trigger) return { ok: false }
    out.trigger = trigger
    if (!partial) out.schedule = null
  }
  if ('enabled' in body || !partial) {
    const e = body.enabled === undefined ? true : body.enabled
    if (typeof e !== 'boolean') return { ok: false }
    out.enabled = e
  }
  return { ok: true, value: out }
}

export function routineRow(row) {
  if (!row) return null
  const { retry_at: _retry, ...out } = row
  out.enabled = !!out.enabled
  out.schedule = out.schedule ?? null
  out.trigger = parseTrigger(out.trigger)
  return out
}

const byKey = (key) => (typeof key === 'string' && key.startsWith('rt_') ? 'id=?' : 'name=?')

export function getRoutine(db, userId, key) {
  if (typeof key !== 'string' || !key) return null
  return routineRow(db.prepare(`SELECT * FROM routines WHERE user_id=? AND ${byKey(key)}`).get(userId, key))
}

export function listRoutines(db, userId) {
  return db.prepare('SELECT * FROM routines WHERE user_id=? ORDER BY name').all(userId).map(routineRow)
}

export function createRoutine(db, { userId, origin, fields, now = Date.now() }) {
  return db.transaction(() => {
    const n = db.prepare('SELECT COUNT(*) n FROM routines WHERE user_id=?').get(userId).n
    if (n >= ROUTINES_MAX) throw new Error('cap')
    if (db.prepare('SELECT 1 FROM routines WHERE user_id=? AND name=?').get(userId, fields.name)) throw new Error('conflict')
    const id = newRoutineId()
    const nextAt = fields.enabled && fields.schedule ? nextRunAt(fields.schedule, fields.tz, now) : null
    db.prepare(`INSERT INTO routines(id, user_id, name, title, schedule, trigger, tz, prompt, enabled, origin, next_at, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, fields.name, fields.title, fields.schedule ?? null, fields.trigger ? JSON.stringify(fields.trigger) : null, fields.tz, fields.prompt, fields.enabled ? 1 : 0, origin, nextAt, now, now)
    return getRoutine(db, userId, id)
  })()
}

// Pausing clears next_at/retry_at; resuming, or a schedule/tz change,
// recomputes next_at from now; title/prompt edits leave the schedule alone.
export function updateRoutine(db, { userId, key, fields, now = Date.now() }) {
  return db.transaction(() => {
    const row = db.prepare(`SELECT * FROM routines WHERE user_id=? AND ${byKey(key)}`).get(userId, key)
    if (!row) return null
    // A scheduled routine stays scheduled and a triggered one triggered: the
    // kind is chosen at creation (the apps create; a PATCH edits).
    if (fields.schedule !== undefined && fields.schedule !== null && row.schedule == null) throw new Error('mixed')
    if (fields.trigger !== undefined && fields.trigger !== null && row.trigger == null) throw new Error('mixed')
    const next = { ...row, ...fields, enabled: fields.enabled === undefined ? !!row.enabled : fields.enabled }
    const scheduled = row.schedule != null
    if (scheduled && (fields.schedule !== undefined || fields.tz !== undefined)) {
      if (!validSchedule(next.schedule, next.tz, now)) throw new Error('bad_schedule')
    }
    const reschedule = scheduled && (fields.schedule !== undefined || fields.tz !== undefined || (next.enabled && !row.enabled))
    let nextAt = row.next_at
    let retryAt = row.retry_at
    if (!next.enabled) { nextAt = null; retryAt = null } else if (reschedule) { nextAt = nextRunAt(next.schedule, next.tz, now); retryAt = null }
    const triggerText = scheduled ? null : JSON.stringify(fields.trigger ?? parseTrigger(row.trigger))
    db.prepare(`UPDATE routines SET title=?, schedule=?, trigger=?, tz=?, prompt=?, enabled=?, next_at=?, retry_at=?, updated_at=? WHERE id=?`)
      .run(next.title, scheduled ? next.schedule : null, triggerText, next.tz, next.prompt, next.enabled ? 1 : 0, nextAt, retryAt, now, row.id)
    // A paused or re-thresholded trigger starts afresh: its subjects re-trip.
    if (!scheduled && (!next.enabled || fields.trigger !== undefined)) db.prepare('DELETE FROM routine_trigger_state WHERE routine_id=?').run(row.id)
    return getRoutine(db, userId, row.id)
  })()
}

export function deleteRoutine(db, userId, key) {
  return db.transaction(() => {
    const row = getRoutine(db, userId, key)
    if (!row) return null
    db.prepare('DELETE FROM routines WHERE id=?').run(row.id)
    return row
  })()
}

// What the sweep fires this minute: enabled, and either the scheduled time
// or the one retry has come. Oldest first so a backlog drains in order.
export function dueRoutines(db, now = Date.now()) {
  return db.prepare(`SELECT * FROM routines WHERE enabled=1 AND schedule IS NOT NULL AND ((next_at IS NOT NULL AND next_at<=?) OR (retry_at IS NOT NULL AND retry_at<=?))
    ORDER BY COALESCE(retry_at, next_at), id`).all(now, now).map(routineRow)
}

// Every enabled triggered routine whose retry backoff (if any) has passed.
// Every enabled triggered routine, `resting` while its retry_at (the gap
// after a fire, or a backoff) lies ahead: a resting routine still
// reconciles its records on the sweep but neither records nor fires.
export function triggeredRoutines(db, now = Date.now()) {
  return db.prepare('SELECT * FROM routines WHERE enabled=1 AND trigger IS NOT NULL ORDER BY user_id, name').all()
    .map((row) => ({ ...routineRow(row), resting: row.retry_at != null && row.retry_at > now }))
}

// Advance BEFORE delivery, in one transaction: last_fired_at stamped,
// next_at moved past now, retry_at cleared — so a crash, a slow wake or a
// restart mid-delivery can never fire the same occurrence twice. A fire
// that is a retry (retry_at was set) is reported so its failure is final.
// A scheduled fire more than MISSED_AFTER_MS late is recorded as missed and
// not delivered (missed: true).
export function advanceRoutine(db, id, now = Date.now()) {
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM routines WHERE id=?').get(id)
    // Paused between the due query and now: nothing fires.
    if (!row || !row.enabled || !row.schedule) return null
    const retry = row.retry_at != null && row.retry_at <= now
    // A retry is as stale as its own time, a scheduled fire as next_at.
    const lateBy = retry ? now - row.retry_at : row.next_at != null ? now - row.next_at : 0
    const missed = lateBy > MISSED_AFTER_MS
    // next_at moves past now whenever it has been reached — on a retry too,
    // so a retry never leaves a scheduled time behind to be reported missed.
    const nextAt = row.next_at != null && row.next_at <= now ? nextRunAt(row.schedule, row.tz, now) : row.next_at
    if (missed) {
      db.prepare('UPDATE routines SET next_at=?, retry_at=NULL, last_outcome=? WHERE id=?').run(nextAt, 'missed', id)
    } else if (retry) {
      db.prepare('UPDATE routines SET next_at=?, retry_at=NULL WHERE id=?').run(nextAt, id)
    } else {
      db.prepare('UPDATE routines SET last_fired_at=?, next_at=?, retry_at=NULL WHERE id=?').run(now, nextAt, id)
    }
    return { routine: routineRow(db.prepare('SELECT * FROM routines WHERE id=?').get(id)), missed, retry }
  })()
}

// A `run` (POST /routines/:key/run) is a fire too: stamp it, leave the
// schedule alone (next_at stays what it was, retry_at is not touched).
export function markRun(db, id, now = Date.now()) {
  db.prepare('UPDATE routines SET last_fired_at=? WHERE id=?').run(now, id)
}

// The delivery's verdict. A retryable failure on a scheduled fire arms the
// one retry; on the retry itself it does not.
export function recordOutcome(db, id, { outcome, retryable = false, retry = false, now = Date.now() }) {
  const retryAt = retryable && !retry ? now + RETRY_AFTER_MS : null
  db.prepare('UPDATE routines SET last_outcome=?, retry_at=? WHERE id=? AND enabled=1').run(outcome, retryAt, id)
  db.prepare('UPDATE routines SET last_outcome=? WHERE id=? AND enabled=0').run(outcome, id)
}

// The starter set, once per user: when the Coordinator is first assigned
// (routines-http.js / coordinator-http.js) and at boot for users who already
// have one (server.js). Stamps routines_seeded_at so a user who deleted
// every routine is never re-seeded. Returns how many were created.
export function seedRoutines(db, userId, now = Date.now()) {
  return db.transaction(() => {
    const settings = db.prepare('SELECT routines_seeded_at FROM user_settings WHERE user_id=?').get(userId)
    if (settings?.routines_seeded_at != null) return 0
    const existing = db.prepare('SELECT COUNT(*) n FROM routines WHERE user_id=?').get(userId).n
    let created = 0
    if (existing === 0) {
      for (const r of STARTER_ROUTINES) {
        const v = validateRoutineFields(r, { now })
        if (!v.ok) continue
        createRoutine(db, { userId, origin: 'seed', fields: v.value, now })
        created += 1
      }
    }
    db.prepare(`INSERT INTO user_settings(user_id, routines_seeded_at, updated_at) VALUES(?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET routines_seeded_at=excluded.routines_seeded_at`).run(userId, now, now)
    return created
  })()
}
