// Per-user settings that are neither the Coordinator's nor the notification
// screen's (mission: For you). Pure reads and writes over user_settings;
// src/settings-http.js is the surface, and hello_ok carries settingsView.
//
// notices — "Send things I need to read to For you". On: bridges tell new
// sessions to file what the user should read as `notice` items, and the
// unseen lists skip what an open item already covers (src/seen.js). Off:
// both behave as before the kind existed. No row, or a row from before the
// column, reads as ON — the default.
export function getNoticesEnabled(db, userId) {
  const row = db.prepare('SELECT notices FROM user_settings WHERE user_id=?').get(userId)
  return row ? Number(row.notices) !== 0 : true
}

export function setNoticesEnabled(db, userId, on, now = Date.now()) {
  db.prepare(`INSERT INTO user_settings(user_id, notices, updated_at) VALUES(?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET notices=excluded.notices, updated_at=excluded.updated_at`)
    .run(userId, on ? 1 : 0, now)
}

// Explicit opt-in: no settings row means Coordinator spawns still need approval.
export function getAutoApproveCoordinatorSpawns(db, userId) {
  const row = db.prepare('SELECT auto_approve_coordinator_spawns FROM user_settings WHERE user_id=?').get(userId)
  return Number(row?.auto_approve_coordinator_spawns) === 1
}

export function setAutoApproveCoordinatorSpawns(db, userId, on, now = Date.now()) {
  db.prepare(`INSERT INTO user_settings(user_id, auto_approve_coordinator_spawns, updated_at) VALUES(?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET auto_approve_coordinator_spawns=excluded.auto_approve_coordinator_spawns, updated_at=excluded.updated_at`)
    .run(userId, on ? 1 : 0, now)
}

export const settingsView = (db, userId) => ({
  notices: getNoticesEnabled(db, userId),
  auto_approve_coordinator_spawns: getAutoApproveCoordinatorSpawns(db, userId),
})
