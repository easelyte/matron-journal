// The user's Coordinator (spec 2026-09-23 coordinator redesign §1a): one
// conversation per user, stored here so every device and every bridge reads
// the same answer. DB state plus the `coordinator` role event appends (both
// committed in setCoordinatorConvoId's own transaction) — src/coordinator-http.js
// owns auth, shapes the appended events, and broadcasts after commit, the
// same split as missions.js / missions-http.js.
import { privateOwnedConvo } from './privacy.js'

export const COORDINATOR_EVENT_TYPE = 'coordinator'

export function getCoordinatorConvoId(db, userId) {
  return db.prepare('SELECT coordinator_convo_id FROM user_settings WHERE user_id=?').get(userId)?.coordinator_convo_id ?? null
}

// What a given caller may be told. An ordinary (filtered) agent never learns
// the id of a private-owned conversation — the same rule /snapshot and
// /roster apply — so it reads null, exactly as if no Coordinator were set.
export function coordinatorFor(db, userId, { excludePrivateOwned = false } = {}) {
  const id = getCoordinatorConvoId(db, userId)
  if (id && excludePrivateOwned && privateOwnedConvo(db, id)) return null
  return id
}

// One transaction: ownership check, read of the previous value, write, and
// (if given) the released/assigned event appends — so a failing append rolls
// the setting back too, instead of leaving the setting switched with no
// event to show for it (CodeRabbit, coordinator-http.js: a repeat PUT of the
// same value is this function's own no-op, so a bridge that missed the
// `assigned` event would miss it permanently). `appendEvent(convoId, role)`
// is called inside this same transaction — append() is itself a sync
// better-sqlite3 transaction, nested as a savepoint, same as
// missions.js's createMilestone/appendMarker. An unchanged value writes
// nothing and never calls appendEvent (the route turns `changed: false`
// into "no events"). `null` clears.
export function setCoordinatorConvoId(db, userId, convoId, now = Date.now(), { appendEvent } = {}) {
  return db.transaction(() => {
    if (convoId !== null) {
      const owned = db.prepare('SELECT 1 FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
      if (!owned) throw new Error('no_convo')
    }
    const previous = getCoordinatorConvoId(db, userId)
    if (previous === convoId) return { previous, current: convoId, changed: false }
    db.prepare(`INSERT INTO user_settings(user_id, coordinator_convo_id, updated_at) VALUES(?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET coordinator_convo_id=excluded.coordinator_convo_id, updated_at=excluded.updated_at`)
      .run(userId, convoId, now)
    if (appendEvent) {
      if (previous) appendEvent(previous, 'released')
      if (convoId) appendEvent(convoId, 'assigned')
    }
    return { previous, current: convoId, changed: true }
  })()
}
