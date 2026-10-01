// The conversation ↔ mission link table (spec 2026-09-30 projects & mission
// links §3): low-level SQL shared by missions.js (join/leave/reads),
// journal.js (inheritance) and db.js (the one-time backfill and the
// every-open heal). Deliberately imports nothing from missions.js or db.js,
// so no import cycle can form.
// conversations.mission_id is the CURRENT pointer; this table is the truth
// for "which conversations belong to which mission". Invariant: a non-null
// pointer always has an active (ended_at IS NULL) link.

// One pass over what the journal already knows, run by openDb while the
// table is empty (the spec's guard). It is idempotent in practice: once any
// row exists (the first join after deploy writes one) it never runs again.
// On a brand-new database it is a no-op on empty tables. INSERT OR IGNORE
// throughout: a pair found twice keeps its first, stronger source — current
// pointers go first, so an active link is never downgraded to history.
export function backfillMissionLinks(db) {
  if (db.prepare('SELECT 1 FROM mission_conversations LIMIT 1').get()) return 0
  return db.transaction(() => {
    // 1. Every current pointer → an active link. how: origin when the
    //    mission was born here, inherited for a sub-chat, else joined.
    //    joined_at: the earliest created/joined marker this conversation
    //    holds for the mission; failing that, the later of the two rows'
    //    creation times (the link cannot predate either).
    const current = db.prepare(`
      INSERT OR IGNORE INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at, ended_at)
      SELECT c.mission_id, c.id, c.owner_user_id,
        CASE WHEN m.origin_convo_id = c.id THEN 'origin'
             WHEN c.parent_convo_id IS NOT NULL THEN 'inherited'
             ELSE 'joined' END,
        COALESCE(
          (SELECT MIN(e.ts) FROM events e
            WHERE e.convo_id = c.id AND e.type = 'mission'
              AND json_valid(e.payload)
              AND json_extract(e.payload, '$.mission_id') = m.id
              AND json_extract(e.payload, '$.action') IN ('created', 'joined')),
          max(c.created_at, m.created_at)),
        NULL
      FROM conversations c JOIN missions m ON m.id = c.mission_id AND m.user_id = c.owner_user_id
      WHERE c.mission_id IS NOT NULL`).run().changes
    // 2. History: a conversation that posted a milestone or filed an item on
    //    a mission it no longer points at. Ended at its last such trace.
    //    Same-user only — a row whose conversation belongs to someone else is
    //    never a link. The Coordinator files items into many missions it was
    //    never on, so its item traces are skipped.
    const history = db.prepare(`
      INSERT OR IGNORE INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at, ended_at)
      SELECT t.mission_id, t.convo_id, c.owner_user_id, 'backfill', MIN(t.at), MAX(t.at)
      FROM (
        SELECT mission_id, convo_id, created_at AS at FROM milestones
        UNION ALL
        SELECT i.mission_id, i.origin_convo_id AS convo_id, i.created_at AS at FROM items i
        WHERE i.mission_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM user_settings us
            WHERE us.user_id = i.user_id AND us.coordinator_convo_id = i.origin_convo_id)
      ) t
      JOIN conversations c ON c.id = t.convo_id
      JOIN missions m ON m.id = t.mission_id AND m.user_id = c.owner_user_id
      GROUP BY t.mission_id, t.convo_id`).run().changes
    return current + history
  })()
}

// Run by openDb on EVERY open, after the backfill: restores the invariant
// wherever something outside this code (old code after a rollback, a hand
// edit) left a current pointer with no active link. Inserts a 'backfill'
// link stamped now, or reactivates an ended one keeping its how and
// joined_at. The NOT EXISTS keeps it one index probe per pointed
// conversation when nothing is broken. Same-user missions only, as above.
export function healMissionLinks(db) {
  return db.transaction(() => db.prepare(`
    INSERT INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at, ended_at)
    SELECT c.mission_id, c.id, c.owner_user_id, 'backfill', ?, NULL
    FROM conversations c JOIN missions m ON m.id = c.mission_id AND m.user_id = c.owner_user_id
    WHERE c.mission_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM mission_conversations l
      WHERE l.mission_id = c.mission_id AND l.convo_id = c.id AND l.ended_at IS NULL)
    ON CONFLICT(mission_id, convo_id) DO UPDATE SET ended_at = NULL`).run(Date.now()).changes)()
}

export function linkRow(db, missionId, convoId) {
  return db.prepare('SELECT * FROM mission_conversations WHERE mission_id=? AND convo_id=?').get(missionId, convoId) ?? null
}

export function hasActiveLink(db, missionId, convoId) {
  return !!db.prepare('SELECT 1 FROM mission_conversations WHERE mission_id=? AND convo_id=? AND ended_at IS NULL').get(missionId, convoId)
}

// Adds a link or reactivates an ended one, stamping joined_at = ts (the
// leave fallback picks the most recently joined). A reactivated link keeps
// the `how` it was made with, unless it was only a backfilled trace — or
// was 'joined' and is now 'spawned' (the stronger account of the same
// arrival). No other how is ever replaced.
export function activateLink(db, { missionId, convoId, userId, how, ts }) {
  db.prepare(`INSERT INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at, ended_at)
    VALUES(?,?,?,?,?,NULL)
    ON CONFLICT(mission_id, convo_id) DO UPDATE SET
      ended_at = NULL,
      joined_at = excluded.joined_at,
      how = CASE WHEN mission_conversations.how = 'backfill' THEN excluded.how
                 WHEN mission_conversations.how = 'joined' AND excluded.how = 'spawned' THEN 'spawned'
                 ELSE mission_conversations.how END`)
    .run(missionId, convoId, userId, how, ts)
}

export function endLink(db, { missionId, convoId, ts }) {
  return db.prepare('UPDATE mission_conversations SET ended_at=? WHERE mission_id=? AND convo_id=? AND ended_at IS NULL')
    .run(ts, missionId, convoId).changes > 0
}

// CONVOS_MAX counts top-level conversations only (spec 2026-09-30 §3):
// sub-chats are folded under their parent and never fill a mission.
export function topLevelActiveCount(db, missionId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM mission_conversations l JOIN conversations c ON c.id = l.convo_id
    WHERE l.mission_id = ? AND l.ended_at IS NULL AND c.parent_convo_id IS NULL`).get(missionId).n
}

// Where `current` goes when a conversation leaves its current mission: the
// most recently joined remaining active link on an OPEN mission (a closed
// one cannot take a milestone), else none.
export function nextCurrent(db, convoId) {
  return db.prepare(`SELECT l.mission_id FROM mission_conversations l JOIN missions m ON m.id = l.mission_id
    WHERE l.convo_id = ? AND l.ended_at IS NULL AND m.state = 'open'
    ORDER BY l.joined_at DESC, l.rowid DESC LIMIT 1`).get(convoId)?.mission_id ?? null
}
