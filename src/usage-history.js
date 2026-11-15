// Usage history: how much of each weekly allowance went unused.
//
// device_status keeps only a box's latest usage reading. This module keeps
// the past: every reading of a weekly meter is filed under the ACCOUNT it
// belongs to (boxes on one login spend one allowance) and the weekly WINDOW
// it falls in (the window is named by its reset time).
//
// Tables (src/db.js SCHEMA):
//   usage_windows  one row per account, meter and window: the last reading
//                  before the reset (`percent`), the highest (`peak`), and
//                  when the first and last readings were taken. The unused
//                  allowance of a finished window is 100 − percent.
//   usage_samples  one row per account, meter and hour, for the shape of a
//                  week. Pruned after SAMPLE_RETENTION_MS; windows are kept.
//
// Readings come from two places: a bridge's `box_status` (Claude's meters,
// with the login's email) and a session's `status` frame (Codex's meters,
// which a bridge reports per session and without a login, so they are filed
// under the box). Both are best effort: a reading that cannot be placed in
// a window is dropped, never guessed at beyond the one rule below.
import { isPrivateDevice } from './db.js'
import { sanitizePeerText } from './peer-text.js'

const HOUR_MS = 3600000
const WEEK_MS = 7 * 24 * HOUR_MS
// Boxes on one account print the same reset a minute or so apart, and a
// rolling window can drift a little between readings: a reading joins an
// open window whose reset is within this much of its own.
const RESET_SLACK_MS = 2 * HOUR_MS
// A reading older than this says nothing about the current week.
const STALE_MS = 8 * 24 * HOUR_MS
const RESET_HORIZON_MS = 8 * 24 * HOUR_MS
export const SAMPLE_RETENTION_MS = 2 * 365 * 24 * HOUR_MS
const PRUNE_EVERY_MS = 24 * HOUR_MS
const DEVICES_MAX = 64
export const WEEKS_DEFAULT = 12
export const WEEKS_MAX = 104

const isCodexLine = (l) => typeof l?.id === 'string' && l.id.startsWith('codex:')
// Weekly meters only: Claude's ids start with "week" (lib/usage-limits.js in
// the bridge), Codex names its 7-day window "… · Weekly".
const isWeeklyLine = (l) => (isCodexLine(l) ? /· Weekly$/.test(l.label || '') : typeof l?.id === 'string' && l.id.startsWith('week'))

const lastPrune = new WeakMap()
function pruneSamples(db, now) {
  if (now - (lastPrune.get(db) || 0) < PRUNE_EVERY_MS) return
  lastPrune.set(db, now)
  db.prepare('DELETE FROM usage_samples WHERE hour < ?').run(now - SAMPLE_RETENTION_MS)
}

function parseDevices(text) {
  try { const a = JSON.parse(text); return Array.isArray(a) ? a.filter(Number.isInteger) : [] } catch { return [] }
}

// File one {as_of, lines} block. `email` groups boxes on one login; without
// it the box is its own account.
function recordBlock(db, { userId, deviceId, agent, email, limits, now }) {
  if (!limits || !Array.isArray(limits.lines) || !Number.isFinite(limits.as_of)) return 0
  const asOf = Math.min(limits.as_of, now)
  if (asOf < now - STALE_MS) return 0
  const login = typeof email === 'string' && email ? email.toLowerCase() : null
  // A box with no login is its own account. Its key carries when the box
  // was paired as well as its id: a device id can be handed out again after
  // a box is removed, and the newcomer must not inherit the old history.
  let accountKey = login ? `${agent}:login:${login}` : null
  if (!accountKey) {
    const device = db.prepare('SELECT created_at FROM devices WHERE id=? AND user_id=?').get(deviceId, userId)
    if (!device) return 0
    accountKey = `${agent}:device:${deviceId}:${device.created_at}`
  }
  let written = 0
  for (const l of limits.lines) {
    if (!isWeeklyLine(l) || isCodexLine(l) !== (agent === 'codex')) continue
    if (!Number.isInteger(l.percent) || l.percent < 0) continue
    const percent = Math.min(l.percent, 100)
    let resetAt = typeof l.resets_at === 'string' ? Date.parse(l.resets_at) : NaN
    let inferred = false
    if (Number.isFinite(resetAt)) {
      // A reading taken at or after its own reset is the old week's text.
      if (resetAt <= asOf || resetAt > asOf + RESET_HORIZON_MS) continue
      resetAt = Math.round(resetAt / HOUR_MS) * HOUR_MS
      const open = db.prepare(
        `SELECT reset_at FROM usage_windows WHERE user_id=? AND account_key=? AND line_id=? AND reset_at BETWEEN ? AND ?
         ORDER BY ABS(reset_at - ?) LIMIT 1`
      ).get(userId, accountKey, l.id, resetAt - RESET_SLACK_MS, resetAt + RESET_SLACK_MS, resetAt)
      if (open) resetAt = open.reset_at
    } else {
      // An untouched week prints "0% used" with no reset time. It still
      // counts (as wholly unused) when the account's weekly rhythm is known:
      // the window is the next whole week on from its last one.
      if (percent !== 0) continue
      const prev = db.prepare(
        'SELECT reset_at FROM usage_windows WHERE user_id=? AND account_key=? AND line_id=? ORDER BY reset_at DESC LIMIT 1'
      ).get(userId, accountKey, l.id)
      if (!prev) continue
      resetAt = prev.reset_at
      // Its last window is still open: that window has real readings, and
      // a placed-by-inference zero must never replace one.
      if (resetAt > asOf) continue
      resetAt += Math.ceil((asOf - resetAt + 1) / WEEK_MS) * WEEK_MS
      inferred = true
    }
    const label = sanitizePeerText(l.label, 64) || l.id
    const row = db.prepare(
      'SELECT percent, peak, first_at, last_at, devices FROM usage_windows WHERE user_id=? AND account_key=? AND line_id=? AND reset_at=?'
    ).get(userId, accountKey, l.id, resetAt)
    // An inferred window that already has a row holds this same zero (or a
    // real reading that arrived since): nothing to add.
    if (row && inferred) continue
    if (!row) {
      db.prepare(
        `INSERT INTO usage_windows(user_id, account_key, line_id, reset_at, agent, label, percent, peak, first_at, last_at, devices)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(userId, accountKey, l.id, resetAt, agent, label, percent, percent, asOf, asOf, JSON.stringify([deviceId]))
    } else {
      // The newest reading is the window's figure; an older one (a box that
      // idled while others spent the meter) can only raise the peak.
      const newest = asOf >= row.last_at
      const devices = parseDevices(row.devices)
      if (!devices.includes(deviceId) && devices.length < DEVICES_MAX) devices.push(deviceId)
      db.prepare(
        `UPDATE usage_windows SET percent=?, peak=?, first_at=?, last_at=?, label=?, devices=?
         WHERE user_id=? AND account_key=? AND line_id=? AND reset_at=?`
      ).run(newest ? percent : row.percent, Math.max(row.peak, percent), Math.min(row.first_at, asOf), Math.max(row.last_at, asOf),
        label, JSON.stringify(devices), userId, accountKey, l.id, resetAt)
    }
    const hour = Math.floor(asOf / HOUR_MS) * HOUR_MS
    db.prepare(
      `INSERT INTO usage_samples(user_id, account_key, line_id, hour, percent, reset_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(user_id, account_key, line_id, hour) DO UPDATE SET
         percent = CASE WHEN excluded.reset_at > reset_at THEN excluded.percent
                        WHEN excluded.reset_at < reset_at THEN percent
                        ELSE MAX(percent, excluded.percent) END,
         reset_at = MAX(reset_at, excluded.reset_at)`
    ).run(userId, accountKey, l.id, hour, percent, resetAt)
    written++
  }
  return written
}

// A bridge's box_status report (already sanitised): Claude's meters, filed
// under the login it names.
export function recordBoxUsage(db, { userId, deviceId, status, now = Date.now() }) {
  if (!status?.limits) return 0
  const n = db.transaction(() => recordBlock(db, {
    userId, deviceId, agent: 'claude', email: status.account?.email, limits: status.limits, now,
  }))()
  pruneSamples(db, now)
  return n
}

// A session's persisted status (sanitizeConvoStatus): only Codex's meters
// are taken from here. Claude's arrive with box_status, which also knows the
// login.
export function recordSessionUsage(db, { userId, deviceId, status, now = Date.now() }) {
  if (!status?.limits || !status.limits.lines?.some(isCodexLine)) return 0
  const n = db.transaction(() => recordBlock(db, { userId, deviceId, agent: 'codex', email: null, limits: status.limits, now }))()
  pruneSamples(db, now)
  return n
}

const iso = (ms) => new Date(ms).toISOString()

// The read side: every account's weekly meters over the last `weeks` weeks.
// `excludePrivate` (an ordinary agent caller) leaves out anything only a
// private box reported, and private boxes' names everywhere.
//
//   { now, weeks, accounts: [{ key, agent, email?, boxes: [name],
//       meters: [{ id, label, primary,
//         current?: { resets_at, percent, unused, as_of },
//         windows: [{ resets_at, percent, unused, peak, first_at, last_at }],  // newest first, finished only
//         average_unused? }] }] }
export function readUsageHistory(db, userId, { weeks = WEEKS_DEFAULT, now = Date.now(), excludePrivate = false } = {}) {
  const since = now - weeks * WEEK_MS
  const rows = db.prepare(
    `SELECT account_key, line_id, reset_at, agent, label, percent, peak, first_at, last_at, devices
     FROM usage_windows WHERE user_id=? AND reset_at > ? ORDER BY account_key, line_id, reset_at DESC`
  ).all(userId, since)
  // id -> {name, created_at}. A box is named under a window only if it was
  // already paired when the window was last read: an id handed out again
  // must not put the newcomer's name on its predecessor's history.
  const boxes = new Map(db.prepare("SELECT id, name, created_at FROM devices WHERE user_id=? AND kind='agent'").all(userId).map((d) => [d.id, d]))
  const privacy = new Map()
  const isPrivate = (id) => { if (!privacy.has(id)) privacy.set(id, isPrivateDevice(db, id)); return privacy.get(id) }
  const accounts = new Map()
  for (const r of rows) {
    let devices = parseDevices(r.devices)
    if (excludePrivate) {
      devices = devices.filter((id) => !isPrivate(id))
      if (!devices.length) continue
    }
    let a = accounts.get(r.account_key)
    if (!a) {
      const login = r.account_key.startsWith(`${r.agent}:login:`) ? r.account_key.slice(r.agent.length + 7) : null
      a = { key: r.account_key, agent: r.agent, ...(login ? { email: login } : {}), boxIds: new Set(), meters: new Map() }
      accounts.set(r.account_key, a)
    }
    for (const id of devices) if (boxes.has(id) && boxes.get(id).created_at <= r.last_at) a.boxIds.add(id)
    let m = a.meters.get(r.line_id)
    if (!m) { m = { id: r.line_id, label: r.label, windows: [] }; a.meters.set(r.line_id, m) }
    if (r.reset_at > now) {
      // Newest first, so the first unfinished window is the one in progress.
      if (!m.current) m.current = { resets_at: iso(r.reset_at), percent: r.percent, unused: 100 - r.percent, as_of: r.last_at }
    } else {
      m.windows.push({
        resets_at: iso(r.reset_at), percent: r.percent, unused: 100 - r.percent, peak: r.peak, first_at: r.first_at, last_at: r.last_at,
      })
    }
  }
  const primaryRank = (m) => (m.id === 'week_all' ? 0 : m.id === 'codex:codex:secondary' ? 1 : 2)
  const out = []
  for (const a of accounts.values()) {
    const meters = [...a.meters.values()].sort((x, y) => primaryRank(x) - primaryRank(y) || (x.id < y.id ? -1 : 1))
    meters.forEach((m, i) => {
      m.primary = i === 0
      if (m.windows.length) m.average_unused = Math.round(m.windows.reduce((s, w) => s + w.unused, 0) / m.windows.length)
    })
    const boxNames = [...a.boxIds].map((id) => boxes.get(id).name).sort()
    out.push({ key: a.key, agent: a.agent, ...(a.email ? { email: a.email } : {}), boxes: boxNames, meters })
  }
  out.sort((x, y) => (x.agent === y.agent ? (x.key < y.key ? -1 : 1) : x.agent === 'claude' ? -1 : 1))
  return { now, weeks, accounts: out }
}
