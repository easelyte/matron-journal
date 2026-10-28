// Archived conversations: the user's own "out of the way" flag, synced to
// every app like pins. Pure reads and writes over convo_archive;
// src/archive-http.js owns auth, validation and the live frame.
//
// Archive hides a conversation from the apps' main list; it never deletes
// anything. A new message in an archived conversation unarchives it (append
// in journal.js clears the flag in the same transaction), the way mail
// brings a thread back to the inbox. A row outlives its unarchive:
// unarchived_at restarts the auto-archive idle clock, so a conversation the
// user brought back is not archived again by the next sweep.
//
// Changes are versioned by updated_at so an app can catch up with
// `since` (GET /archive?since=, hello `archive_since`) instead of
// downloading every archived id on each connect.
import { MESSAGE_TYPES_SQL } from './message-types.js'

export const ARCHIVE_BATCH_MAX = 500
export const AUTO_ARCHIVE_DEFAULT_DAYS = 30
export const AUTO_ARCHIVE_MAX_DAYS = 3650
export const AUTO_ARCHIVE_INTERVAL_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const changeOf = (r) => ({ convo_id: r.convo_id, archived_at: r.archived_at ?? null, auto: Boolean(r.auto) })

// Every change at or after `since` (ms), unarchives included, or — with
// no `since` — every conversation archived now. `at` is the value to pass
// as `since` next time; a change in that same millisecond comes again,
// which is harmless (applying a change twice is a no-op).
export function archiveChanges(db, userId, since = null) {
  const rows = since == null
    ? db.prepare('SELECT * FROM convo_archive WHERE user_id=? AND archived_at IS NOT NULL ORDER BY updated_at').all(userId)
    : db.prepare('SELECT * FROM convo_archive WHERE user_id=? AND updated_at>=? ORDER BY updated_at').all(userId, since)
  const at = rows.reduce((m, r) => Math.max(m, r.updated_at), since ?? 0)
  return { changes: rows.map(changeOf), at }
}

// Archive (`archived` true) or unarchive a batch of the user's own
// conversations. Ids the user does not own are skipped; a conversation
// already in the asked state is unchanged. Returns the changes made.
export function setArchived(db, userId, convoIds, archived, { now = Date.now(), auto = false } = {}) {
  return db.transaction(() => {
    const owned = db.prepare('SELECT 1 FROM conversations WHERE id=? AND owner_user_id=?')
    const current = db.prepare('SELECT archived_at FROM convo_archive WHERE user_id=? AND convo_id=?')
    const archive = db.prepare(`INSERT INTO convo_archive(user_id, convo_id, archived_at, auto, unarchived_at, updated_at)
      VALUES(?,?,?,?,NULL,?)
      ON CONFLICT(user_id, convo_id) DO UPDATE SET archived_at=excluded.archived_at, auto=excluded.auto, updated_at=excluded.updated_at`)
    const unarchive = db.prepare('UPDATE convo_archive SET archived_at=NULL, auto=0, unarchived_at=?, updated_at=? WHERE user_id=? AND convo_id=?')
    const changes = []
    for (const id of new Set(convoIds)) {
      if (!owned.get(id, userId)) continue
      const isArchived = current.get(userId, id)?.archived_at != null
      if (archived === isArchived) continue
      if (archived) archive.run(userId, id, now, auto ? 1 : 0, now)
      else unarchive.run(now, now, userId, id)
      changes.push({ convo_id: id, archived_at: archived ? now : null, auto: archived && auto })
    }
    return changes
  })()
}

// Called by append() inside its transaction for a message event: bring an
// archived conversation back. Returns the change, or null when it was not
// archived. One primary-key lookup for the common case.
export function unarchiveOnMessage(db, userId, convoId, now) {
  const r = db.prepare('UPDATE convo_archive SET archived_at=NULL, auto=0, unarchived_at=?, updated_at=? WHERE user_id=? AND convo_id=? AND archived_at IS NOT NULL')
    .run(now, now, userId, convoId)
  return r.changes ? { convo_id: convoId, archived_at: null, auto: false } : null
}

export function getAutoArchiveDays(db, userId) {
  const v = db.prepare('SELECT auto_archive_days FROM user_settings WHERE user_id=?').get(userId)?.auto_archive_days
  return v == null ? AUTO_ARCHIVE_DEFAULT_DAYS : Number(v)
}

export function setAutoArchiveDays(db, userId, days, now = Date.now()) {
  db.prepare(`INSERT INTO user_settings(user_id, auto_archive_days, updated_at) VALUES(?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET auto_archive_days=excluded.auto_archive_days, updated_at=excluded.updated_at`)
    .run(userId, days, now)
}

export const isAutoArchiveDays = (v) => Number.isInteger(v) && v >= 0 && v <= AUTO_ARCHIVE_MAX_DAYS

// Conversations the sweep would archive for this user now: top-level, not
// a system conversation, not archived, idle for `days` (no message, no
// creation, no unarchive since the cutoff), and none of the exemptions —
// a session still running or waiting, the Coordinator, a pin, an open
// tracker item filed from it, any link to an open mission, or a sub-chat
// still running or with a message since the cutoff (its parent's work).
export function autoArchiveCandidates(db, userId, days, now = Date.now()) {
  if (!days) return []
  const cutoff = now - days * DAY_MS
  return db.prepare(`
    SELECT c.id FROM conversations c
    LEFT JOIN convo_archive a ON a.user_id=c.owner_user_id AND a.convo_id=c.id
    WHERE c.owner_user_id=? AND c.parent_convo_id IS NULL AND c.system IS NULL
      AND (a.archived_at IS NULL)
      AND c.session_state NOT IN ('running','waiting')
      AND c.created_at < ? AND COALESCE(a.unarchived_at, 0) < ?
      AND c.id IS NOT (SELECT coordinator_convo_id FROM user_settings WHERE user_id=c.owner_user_id)
      AND NOT EXISTS(SELECT 1 FROM convo_pins p WHERE p.user_id=c.owner_user_id AND p.convo_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM items i WHERE i.origin_convo_id=c.id AND i.state='open')
      AND NOT EXISTS(SELECT 1 FROM mission_conversations l JOIN missions m ON m.id=l.mission_id
                     WHERE l.convo_id=c.id AND m.state='open')
      AND NOT EXISTS(SELECT 1 FROM missions m WHERE m.id=c.mission_id AND m.state='open')
      AND COALESCE((SELECT e.ts FROM events e WHERE e.convo_id=c.id AND e.type IN (${MESSAGE_TYPES_SQL})
                    ORDER BY e.seq DESC LIMIT 1), 0) < ?
      AND NOT EXISTS(SELECT 1 FROM conversations k WHERE k.parent_convo_id=c.id
                     AND (k.session_state IN ('running','waiting')
                          OR EXISTS(SELECT 1 FROM events e WHERE e.convo_id=k.id AND e.ts >= ?
                                    AND e.type IN (${MESSAGE_TYPES_SQL}))))`).all(userId, cutoff, cutoff, cutoff, cutoff).map((r) => r.id)
}

// One pass over every user. Returns {userId: changes} for users with any.
// Each user commits on its own, and `onUser(userId, changes)` runs right
// after that commit, so one user's failure (logged, skipped) never costs
// the users already archived their live frame.
export function runAutoArchive(db, now = Date.now(), { onUser = () => {}, log = console } = {}) {
  const out = new Map()
  for (const { id: userId } of db.prepare('SELECT id FROM users').all()) {
    let changes
    try {
      const ids = autoArchiveCandidates(db, userId, getAutoArchiveDays(db, userId), now)
      if (!ids.length) continue
      changes = setArchived(db, userId, ids, true, { now, auto: true })
    } catch (err) {
      try { log.error(`auto-archive: user ${userId} failed: ${err?.message || err}`) } catch { /* never throw from a timer */ }
      continue
    }
    if (!changes.length) continue
    out.set(userId, changes)
    onUser(userId, changes)
  }
  return out
}

// `at` is the change time, the app's next `since`.
export function sendArchiveFrame(hub, userId, changes, at) {
  if (!changes?.length) return
  try { hub.sendToClients(userId, { kind: 'archive', changes, at }) } catch (err) { console.error('archive: live frame failed (saved)', err) }
}

// Hourly sweep; stopped in close(). The first pass waits one interval so a
// restart never races boot.
export function startAutoArchiveSweep({ db, hub, intervalMs = AUTO_ARCHIVE_INTERVAL_MS, enabled = true, log = console } = {}) {
  function run(now = Date.now()) {
    try {
      return runAutoArchive(db, now, { log, onUser: (userId, changes) => sendArchiveFrame(hub, userId, changes, now) })
    } catch (err) {
      try { log.error(`auto-archive: sweep failed: ${err?.message || err}`) } catch { /* never throw from a timer */ }
      return new Map()
    }
  }
  if (!enabled) return { stop() {}, run }
  const t = setInterval(run, intervalMs)
  t.unref()
  return { stop() { clearInterval(t) }, run }
}
