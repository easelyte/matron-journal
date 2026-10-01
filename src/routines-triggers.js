// Triggered routines (spec 2026-10-01 coordinator routines, "Triggers"):
// a routine with a trigger instead of a schedule fires the moment a rule
// trips — a live session's context gauge past a threshold, a session
// stalled on a usage limit with a far (or unknown) reset, an agent box
// under a disk threshold — using the status the journal already holds
// (conversation_status, device_status). Once per subject per crossing:
// routine_trigger_state remembers the subjects a routine has fired for and
// forgets them when the condition clears, so the next crossing fires again.
// The turn carries the specifics ("Tripped by:" lines) after the prompt.
import { coordinatorDevice } from './consent.js'
import { convoStatuses } from './convo-status.js'
import { deviceStatuses, isPrivateDevice } from './db.js'
import { privateOwnedConvo } from './privacy.js'
import { sanitizePeerText } from './peer-text.js'
import { triggeredRoutines, RETRY_AFTER_MS, PROMPT_MAX, MIN_GAP_MS } from './routines.js'

const LIVE_STATES = new Set(['running', 'waiting'])
const TITLE_CAP = 80
const GB = 1024 ** 3

// A title inside a markdown link label: brackets and parens dropped so it
// cannot close the label; one line, capped.
const linkLabel = (title) => (sanitizePeerText(String(title || ''), TITLE_CAP) || 'untitled').replace(/[[\]()]/g, '').trim() || 'untitled'
const inWords = (ms) => {
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`
}
const gb = (bytes) => `${(bytes / GB).toFixed(1)} GB`
const kTokens = (n) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

// The window a session really has, for context_over. The bridge reports a
// window per session, but for the 1M-class models (Opus, Fable, Mythos,
// any `[1m]` alias) it can only prove 1M once the gauge passes 200k: below
// that a session started as `opus` or as the box default reads 200k, and
// 100k tokens shows as 50% (item 5894, 1 Oct 2026). The user's rule
// (compact at 40%, "about 400k") is a 1M rule, so 1M is the floor for those
// models and a reported window above it is trusted. Other models keep what
// the bridge said.
const WINDOW_1M_RE = /opus|fable|mythos|\[1m\]/i
const WINDOW_1M = 1_000_000
export function contextWindowOf(model, reported) {
  const w = Number.isFinite(reported) && reported > 0 ? reported : 0
  return WINDOW_1M_RE.test(String(model || '')) ? Math.max(w, WINDOW_1M) : w
}

// Floor between two fires of one triggered routine. Subjects crossing
// inside the gap are not consumed — they are fresh at the first sweep after
// it — so a run of crossings costs the Coordinator one turn a quarter hour,
// not one per five-minute sweep (fourteen turns in two hours, 1 Oct 2026).
export const TRIGGER_GAP_MS = MIN_GAP_MS

export function describeTrigger(t) {
  if (!t || typeof t !== 'object') return 'no trigger'
  if (t.kind === 'context_over') return `when a session passes ${t.pct}% of its context window`
  if (t.kind === 'disk_under') return `when a box drops under ${t.pct}% free disk`
  if (t.kind === 'stalled') return t.reset_minutes > 0 ? `when a session stalls on a usage limit with no reset within ${inWords(t.reset_minutes * 60000)}` : 'when a session stalls on a usage limit'
  return 'no trigger'
}

// The subjects a trigger matches right now: [{subject, line}], ordered by
// subject so two sweeps agree. The Coordinator's own conversation never
// counts (it cannot act on itself), nor do done/archived sessions, nor the
// helper conversations inside a session (parent_convo_id set): a subagent
// cannot be compacted or switched on its own and ends with its turn. With
// excludePrivateOwned (the Coordinator sits on an ordinary box), sessions
// on private devices and private boxes are invisible, as everywhere else.
export function evaluateTrigger(db, userId, trigger, { now = Date.now(), coordinatorConvoId = null, excludePrivateOwned = false } = {}) {
  const out = []
  if (trigger.kind === 'context_over' || trigger.kind === 'stalled') {
    const statuses = convoStatuses(db, userId)
    const rows = db.prepare('SELECT id, title, session_state FROM conversations WHERE owner_user_id=? AND agent_device_id IS NOT NULL AND parent_convo_id IS NULL').all(userId)
    for (const c of rows) {
      if (c.id === coordinatorConvoId || !LIVE_STATES.has(c.session_state)) continue
      const st = statuses.get(c.id)
      if (!st) continue
      if (excludePrivateOwned && privateOwnedConvo(db, c.id)) continue
      const title = linkLabel(c.title)
      if (trigger.kind === 'context_over') {
        // Measured from the tokens against the window the session really
        // has (contextWindowOf); the reported pct only when there is no
        // gauge to measure.
        const tokens = st.context?.tokens
        const window = contextWindowOf(st.model, st.context?.window)
        const measured = Number.isFinite(tokens) && tokens > 0 && window > 0
        const pct = measured ? Math.floor((tokens * 100) / window) : st.context?.pct
        if (!Number.isInteger(pct) || pct < trigger.pct) continue
        const detail = measured ? `${kTokens(tokens)}/${kTokens(window)}${st.model ? `, ${st.model}` : ''}` : (st.model || '')
        out.push({ subject: `convo:${c.id}`, line: `- [${title}](matron://convo/${c.id}) at ${pct}% of its window${detail ? ` (${detail})` : ''}` })
      } else {
        const stall = st.stall
        if (!stall || stall.kind !== 'usage_limit') continue
        const resetAt = typeof stall.resets_at === 'string' ? Date.parse(stall.resets_at) : NaN
        const known = Number.isFinite(resetAt)
        if (known && resetAt - now < trigger.reset_minutes * 60000) continue
        const model = stall.model || st.model
        const when = known ? `resets ${stall.resets_at} (${resetAt > now ? `in ${inWords(resetAt - now)}` : 'passed'})` : 'no reset time'
        out.push({ subject: `convo:${c.id}`, line: `- [${title}](matron://convo/${c.id}) stalled${model ? ` on ${model}` : ''}, ${when}` })
      }
    }
  } else if (trigger.kind === 'disk_under') {
    const statuses = deviceStatuses(db, userId)
    const devices = db.prepare("SELECT id, name, private FROM devices WHERE user_id=? AND kind='agent'").all(userId)
    for (const d of devices) {
      if (excludePrivateOwned && d.private) continue
      const disk = statuses.get(d.id)?.disk
      if (!disk || !(disk.total_bytes > 0)) continue
      const pct = Math.floor((disk.free_bytes / disk.total_bytes) * 100)
      if (pct >= trigger.pct) continue
      out.push({ subject: `device:${d.id}`, line: `- ${sanitizePeerText(d.name, 64) || `device ${d.id}`}: ${pct}% free (${gb(disk.free_bytes)} of ${gb(disk.total_bytes)})` })
    }
  }
  return out.sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0))
}

// The prompt plus its subjects, kept under the session-control message
// cap (the prompt alone may fill it): lines that do not fit are folded
// into a "+N more" line, and when not even that fits the prompt goes
// alone — a fire is never refused as oversize.
export function trigMessage(prompt, subjects, cap = PROMPT_MAX) {
  if (!subjects.length) return prompt
  const head = `${prompt}\n\nTripped by:`
  const lines = subjects.map((s) => s.line)
  for (let keep = lines.length; keep >= 1; keep--) {
    const rest = lines.length - keep
    const text = [head, ...lines.slice(0, keep), ...(rest ? [`+${rest} more`] : [])].join('\n')
    if (text.length <= cap) return text
  }
  const bare = `${head}\n+${lines.length} more`
  return bare.length <= cap ? bare : prompt
}

function viewFor(db, routine) {
  const coord = coordinatorDevice(db, routine.user_id)
  return { coordinatorConvoId: coord?.convoId ?? null, excludePrivateOwned: coord ? !isPrivateDevice(db, coord.deviceId) : true }
}

// What a `run` by hand reports: everything matching now, state untouched.
export function currentSubjects(db, routine, { now = Date.now() } = {}) {
  if (!routine.trigger) return []
  return evaluateTrigger(db, routine.user_id, routine.trigger, { now, ...viewFor(db, routine) })
}

// The sweep's step for one routine, in one transaction: subjects that no
// longer match are forgotten; subjects that match and are not yet recorded
// are recorded now (before delivery — a crash mid-delivery costs one
// fire, never a double) and returned as `fresh`. With `record: false` (a
// routine resting inside its gap) the forgetting still happens, so a
// subject that clears and crosses again inside the gap fires at the first
// sweep after it, but nothing is recorded and `fresh` is only a report.
export function trippedSubjects(db, routine, { now = Date.now(), coordinatorConvoId = null, excludePrivateOwned = false, record = true } = {}) {
  return db.transaction(() => {
    // Paused (or deleted) since the sweep listed it: nothing is recorded
    // and nothing fires — the same window the scheduled path closes.
    const live = db.prepare('SELECT enabled FROM routines WHERE id=?').get(routine.id)
    if (!live || !live.enabled) return { fresh: [], matching: [] }
    const matching = evaluateTrigger(db, routine.user_id, routine.trigger, { now, coordinatorConvoId, excludePrivateOwned })
    const known = new Set(db.prepare('SELECT subject FROM routine_trigger_state WHERE routine_id=?').all(routine.id).map((r) => r.subject))
    const still = new Set(matching.map((s) => s.subject))
    const forget = db.prepare('DELETE FROM routine_trigger_state WHERE routine_id=? AND subject=?')
    for (const s of known) if (!still.has(s)) forget.run(routine.id, s)
    const fresh = matching.filter((s) => !known.has(s.subject))
    if (record) {
      const mark = db.prepare('INSERT OR IGNORE INTO routine_trigger_state(routine_id, subject, tripped_at) VALUES(?,?,?)')
      for (const s of fresh) mark.run(routine.id, s.subject, now)
    }
    return { fresh, matching }
  })()
}

// One pass over every enabled triggered routine. Every fire rests the
// routine for TRIGGER_GAP_MS (retry_at doubles as "not before"); a resting
// routine only reconciles its records. A delivery
// failure the next attempt might cure — and "no Coordinator", which a later
// assignment cures — forgets the fresh subjects (so they re-trip) and backs
// the routine off for RETRY_AFTER_MS instead; a refusal keeps them recorded
// (nothing until the condition clears and trips again). Returns {fired}.
export async function runTriggerSweep({ db, firer, log = console }, now = Date.now()) {
  let routines = []
  try { routines = triggeredRoutines(db, now) } catch (err) {
    try { log.error(`routines: trigger sweep query failed: ${err?.message || err}`) } catch { /* never throw from a timer */ }
    return { fired: 0 }
  }
  let fired = 0
  const deliveries = []
  for (const r of routines) {
    // A busy firer skips the due routines (nothing recorded, so nothing is
    // lost) but the resting ones still reconcile.
    if (!r.resting && firer.busy()) continue
    let fresh
    try {
      ({ fresh } = trippedSubjects(db, r, { now, record: !r.resting, ...viewFor(db, r) }))
    } catch (err) {
      try { log.error(`routines: ${r.name}: trigger evaluation failed: ${err?.message || err}`) } catch { /* never throw from a timer */ }
      continue
    }
    if (r.resting || !fresh.length) continue
    fired += 1
    db.prepare('UPDATE routines SET last_fired_at=?, retry_at=? WHERE id=?').run(now, now + TRIGGER_GAP_MS, r.id)
    const onOutcome = (outcome, retryable) => {
      const again = retryable || outcome === 'no_coordinator'
      db.transaction(() => {
        db.prepare('UPDATE routines SET last_outcome=? WHERE id=?').run(outcome, r.id)
        if (again) {
          db.prepare('UPDATE routines SET retry_at=? WHERE id=?').run(Date.now() + RETRY_AFTER_MS, r.id)
          const forget = db.prepare('DELETE FROM routine_trigger_state WHERE routine_id=? AND subject=?')
          for (const s of fresh) forget.run(r.id, s.subject)
        }
      })()
    }
    deliveries.push(firer.fire(r, { now, message: trigMessage(r.prompt, fresh), onOutcome }).catch((err) => {
      try { log.error(`routines: ${r.name}: trigger fire failed`, err) } catch { /* never throw from a timer */ }
    }))
  }
  await Promise.all(deliveries)
  return { fired }
}
