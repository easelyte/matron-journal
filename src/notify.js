// Notification settings (spec 2026-10-01 notification settings): what may
// push, synced per user. Pure reads and writes over user_settings.notify_prefs,
// convo_notify and devices.push_level; src/push.js asks eventKey + allowedForUser per event and
// device, src/notify-http.js is the client surface.
import { getCoordinatorConvoId } from './coordinator.js'
import { getConsentEnabled } from './consent.js'

export const NOTIFY_MODES = ['coordinator', 'all', 'custom']
export const NOTIFY_EVENTS = ['prompts', 'questions', 'notices', 'coordinator_done', 'other_done', 'stopped', 'rooms', 'activity']
export const CONVO_LEVELS = ['all', 'needs_me', 'none']
export const DEVICE_LEVELS = ['all', 'needs_me', 'off']
// What "Needs me" lets through, at conversation and device level alike.
export const NEEDS_ME = new Set(['prompts', 'questions', 'notices'])

const PRESETS = {
  // No turn-finished pushes at all: with a Coordinator, what it wants from
  // the user arrives as a For you item, and that is what pushes.
  coordinator: { prompts: true, questions: true, notices: true, coordinator_done: false, other_done: false, stopped: false, rooms: false, activity: false },
  all: { prompts: true, questions: true, notices: true, coordinator_done: true, other_done: true, stopped: true, rooms: false, activity: false },
}

// Stored JSON → {mode, events}. Anything unreadable falls back to the
// default (Coordinator mode) wholesale; a custom `events` object is filled
// key by key from the 'all' preset, so a key added later starts from there.
export function parseNotifyPrefs(text) {
  const fallback = { mode: 'coordinator', events: { ...PRESETS.coordinator } }
  if (!text) return fallback
  let p
  try { p = JSON.parse(text) } catch { return fallback }
  if (!p || typeof p !== 'object' || Array.isArray(p) || !NOTIFY_MODES.includes(p.mode)) return fallback
  if (p.mode !== 'custom') return { mode: p.mode, events: { ...PRESETS[p.mode] } }
  const events = { ...PRESETS.all }
  const src = p.events && typeof p.events === 'object' ? p.events : {}
  for (const k of NOTIFY_EVENTS) if (typeof src[k] === 'boolean') events[k] = src[k]
  events.prompts = true // an unanswered prompt blocks an agent: never off
  return { mode: 'custom', events }
}

export function getNotifyPrefs(db, userId) {
  const row = db.prepare('SELECT notify_prefs FROM user_settings WHERE user_id=?').get(userId)
  return parseNotifyPrefs(row ? row.notify_prefs : null)
}

// `patch` is {mode?, events?}; events only matter in custom mode (switching
// one while on a preset moves the user to custom, starting from that preset).
export function setNotifyPrefs(db, userId, patch, now = Date.now()) {
  const cur = getNotifyPrefs(db, userId)
  let mode = patch.mode ?? cur.mode
  let events = { ...cur.events }
  if (patch.events) {
    if (patch.mode == null) mode = 'custom'
    for (const k of NOTIFY_EVENTS) if (typeof patch.events[k] === 'boolean') events[k] = patch.events[k]
    events.prompts = true
  }
  const stored = mode === 'custom' ? { mode, events } : { mode }
  db.prepare(`INSERT INTO user_settings(user_id, notify_prefs, updated_at) VALUES(?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET notify_prefs=excluded.notify_prefs, updated_at=excluded.updated_at`)
    .run(userId, JSON.stringify(stored), now)
  return getNotifyPrefs(db, userId)
}

// Coordinator mode only means something while there is a Coordinator to
// watch the other sessions; without one it behaves as 'all'.
// `coordinatorConvoId` lets a caller that already read it skip the lookup.
export function effectiveEvents(db, userId, prefs = getNotifyPrefs(db, userId), coordinatorConvoId = getCoordinatorConvoId(db, userId)) {
  if (prefs.mode === 'coordinator' && !coordinatorConvoId) return { mode: 'all', events: { ...PRESETS.all } }
  return prefs
}

export function getConvoNotify(db, userId, convoId) {
  return db.prepare('SELECT level, mute_until FROM convo_notify WHERE user_id=? AND convo_id=?').get(userId, convoId) || null
}

export function listConvoNotify(db, userId, now = Date.now()) {
  return db.prepare(`SELECT convo_id, level, mute_until FROM convo_notify
    WHERE user_id=? AND (level IS NOT NULL OR mute_until > ?) ORDER BY updated_at DESC`).all(userId, now)
}

// `level` null = follow the mode; `mute_until` null = not muted. A row with
// neither is deleted, so the list only ever holds real overrides.
export function setConvoNotify(db, userId, convoId, { level, mute_until: muteUntil }, now = Date.now()) {
  const cur = getConvoNotify(db, userId, convoId) || { level: null, mute_until: null }
  const next = {
    level: level === undefined ? cur.level : level,
    mute_until: muteUntil === undefined ? cur.mute_until : muteUntil,
  }
  if (next.level == null && next.mute_until == null) {
    db.prepare('DELETE FROM convo_notify WHERE user_id=? AND convo_id=?').run(userId, convoId)
  } else {
    db.prepare(`INSERT INTO convo_notify(user_id, convo_id, level, mute_until, updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id, convo_id) DO UPDATE SET level=excluded.level, mute_until=excluded.mute_until, updated_at=excluded.updated_at`)
      .run(userId, convoId, next.level, next.mute_until, now)
  }
  return next
}

export function getDeviceLevel(db, deviceId) {
  const row = db.prepare('SELECT push_level FROM devices WHERE id=?').get(deviceId)
  return DEVICE_LEVELS.includes(row?.push_level) ? row.push_level : 'all'
}

export function setDeviceLevel(db, deviceId, level) {
  db.prepare('UPDATE devices SET push_level=? WHERE id=?').run(level === 'all' ? null : level, deviceId)
}

// The event switch an event falls under. `cls` is push.js's classification
// ({kind, ...}); `convo` carries isCoordinator / isRoom. A kind this file
// does not know yet is its own key, which allowedForUser lets through.
export function eventKey(cls, convo) {
  // A notice (something to read, mission: For you) has its own switch, "Things
  // to read" — on by default — so it can go badge-only
  // without silencing questions.
  if (cls.kind === 'attention') return cls.notice ? 'notices' : cls.question ? 'questions' : 'prompts'
  if (cls.kind === 'done') {
    if (convo.isCoordinator) return 'coordinator_done'
    return cls.stopped ? 'stopped' : 'other_done'
  }
  if (cls.kind === 'activity') return convo.isRoom ? 'rooms' : 'activity'
  return cls.kind
}

// Does this event push, before the per-device level? `convoSetting` is the
// convo_notify row or null.
export function allowedForUser(key, events, convoSetting, now = Date.now()) {
  if (!key) return false
  if (convoSetting) {
    if (convoSetting.mute_until != null && convoSetting.mute_until > now) return false
    if (convoSetting.level === 'none') return false
    if (convoSetting.level === 'needs_me') return NEEDS_ME.has(key)
    if (convoSetting.level === 'all') {
      if (key === 'rooms' || key === 'activity') return events[key] === true
      return true
    }
  }
  // Fail open for a category the settings have not caught up to (the same
  // rule as the legacy per-device prefs): a missed push costs more than an
  // extra one.
  if (!NOTIFY_EVENTS.includes(key)) return true
  return events[key] === true
}

export function allowedForDevice(key, level) {
  if (level === 'off') return false
  if (level === 'needs_me') return NEEDS_ME.has(key)
  return true
}

// Should a consent card's push wait for the Coordinator? Only in effective
// Coordinator mode, with consent on, for an ask that is not the
// Coordinator's own.
export function holdsConsent(db, userId, mode, fromDeviceId) {
  if (mode !== 'coordinator' || !getConsentEnabled(db, userId)) return false
  const convoId = getCoordinatorConvoId(db, userId)
  if (!convoId) return false
  const coord = db.prepare('SELECT agent_device_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
  return !(coord && coord.agent_device_id != null && coord.agent_device_id === fromDeviceId)
}

// Is the ask a consent card stands for still waiting on someone?
export function consentStillPending(db, payload) {
  if (!payload) return false
  if (payload.kind === 'agent_spawn') {
    return !!db.prepare("SELECT 1 FROM agent_spawn_requests WHERE id=? AND state='awaiting_user'").get(payload.request_id)
  }
  if (payload.kind === 'agent_chat') {
    return !!db.prepare("SELECT 1 FROM convo_agents WHERE convo_id=? AND agent_device_id=? AND state='awaiting_user'").get(payload.room_id, payload.target_device_id)
  }
  return false
}

// Full client view: what the settings screen renders.
export function notifyView(db, userId, deviceId, now = Date.now()) {
  const prefs = getNotifyPrefs(db, userId)
  return {
    mode: prefs.mode,
    events: prefs.events,
    has_coordinator: !!getCoordinatorConvoId(db, userId),
    device_level: deviceId != null ? getDeviceLevel(db, deviceId) : 'all',
    convos: listConvoNotify(db, userId, now),
  }
}

// The app-icon badge a push carries. Coordinator mode counts only what needs
// the user — the Coordinator's unread plus the open items awaiting them;
// otherwise every conversation's unread, as before.
export function notifyBadge(db, userId, unreadBadge) {
  const { mode } = effectiveEvents(db, userId)
  if (mode !== 'coordinator') return unreadBadge(db, userId)
  const convoId = getCoordinatorConvoId(db, userId)
  const unread = db.prepare('SELECT unread_count FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)?.unread_count ?? 0
  const items = db.prepare("SELECT COUNT(*) AS n FROM items WHERE user_id=? AND state='open' AND awaiting='user'").get(userId).n
  return unread + items
}
