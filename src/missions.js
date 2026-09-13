// Pure DB state for missions & milestones (spec 2026-09-10). No hub, push
// or wake here — src/missions-http.js owns the side effects. Same stance
// as src/items.js: every recoverable failure is a tagged Error the HTTP
// layer maps to one status; anything else is a bug and reaches the 500.
import { nextNum, newId, BODY_MAX } from './items.js'
import { milestoneMarkerPayload } from './missions-marker.js'
import { markerTitleAllowed } from './privacy.js'

export const MILESTONE_KINDS = ['user_input', 'progress']
export const TITLE_MAX = 200
export const CONVOS_MAX = 200

const now = () => Date.now()

// idem_key is internal (same stance as rowToItem). `sieved_last_milestone_at`
// (fix round 3, B2) is a sort key countsSql computes for listMissions' ORDER
// BY — never part of the wire shape.
export function missionRow(row) {
  if (!row) return null
  const { idem_key: _idemKey, sieved_last_milestone_at: _sievedLastMilestoneAt, ...rest } = row
  const out = { ...rest, closed_over_open_items: Number(rest.closed_over_open_items || 0) }
  for (const k of ['open_items', 'needs_you', 'conversations', 'milestones']) if (k in out) out[k] = Number(out[k])
  if ('last_milestone_json' in out) {
    out.last_milestone = out.last_milestone_json ? JSON.parse(out.last_milestone_json) : null
    delete out.last_milestone_json
  }
  return out
}

// `idem_key` is internal, and so is `user_id` (fix round 2, minor 2): it is
// always the caller's own id — no route hands back another user's milestone —
// so returning it only widened the wire shape for nothing.
export function milestoneRow(row) {
  if (!row) return null
  const { idem_key: _idemKey, user_id: _userId, ...rest } = row
  return rest
}

export function validateMissionFields(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false }
  const value = {}
  if (body.title !== undefined) {
    if (typeof body.title !== 'string') return { ok: false }
    const t = body.title.trim()
    if (!t || t.length > TITLE_MAX) return { ok: false }
    value.title = t
  } else if (!partial) return { ok: false }
  if (body.body !== undefined) {
    if (typeof body.body !== 'string' || Buffer.byteLength(body.body, 'utf8') > BODY_MAX) return { ok: false }
    value.body = body.body
  }
  return { ok: true, value }
}

// Review fix (Task 7, Critical 1): every COUNTS subquery must apply the same
// private-owned-conversation sieve the caller's OWN arrays get in
// missionDetail — otherwise an ordinary agent that can't see a private
// convo's milestones/items/conversation still sees their totals (and the
// last milestone's TITLE, in last_milestone_json) leak through the summary
// row. Three separate joins because each subquery's own conversation
// column differs: items by origin_convo_id, milestones by convo_id,
// conversations are their own row.
function countsSql(excludePrivateOwned) {
  const itemSieve = excludePrivateOwned
    ? `AND NOT EXISTS (SELECT 1 FROM conversations oc JOIN devices d ON d.id = oc.agent_device_id WHERE oc.id = i.origin_convo_id AND d.private = 1)`
    : ''
  const milestoneSieve = excludePrivateOwned
    ? `AND NOT EXISTS (SELECT 1 FROM conversations mc JOIN devices d ON d.id = mc.agent_device_id WHERE mc.id = l.convo_id AND d.private = 1)`
    : ''
  const convoSieve = excludePrivateOwned
    ? `AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.id = c.agent_device_id AND d.private = 1)`
    : ''
  return `
    (SELECT COUNT(*) FROM items i WHERE i.mission_id = m.id AND i.state='open' ${itemSieve}) AS open_items,
    (SELECT COUNT(*) FROM items i WHERE i.mission_id = m.id AND i.state='open' AND i.awaiting='user' ${itemSieve}) AS needs_you,
    (SELECT COUNT(*) FROM conversations c WHERE c.mission_id = m.id ${convoSieve}) AS conversations,
    (SELECT COUNT(*) FROM milestones l WHERE l.mission_id = m.id ${milestoneSieve}) AS milestones,
    (SELECT json_object('num', l.num, 'title', l.title, 'kind', l.kind, 'created_at', l.created_at)
       FROM milestones l WHERE l.mission_id = m.id ${milestoneSieve} ORDER BY l.created_at DESC, l.seq DESC LIMIT 1) AS last_milestone_json,
    (SELECT l.created_at FROM milestones l WHERE l.mission_id = m.id ${milestoneSieve}
       ORDER BY l.created_at DESC, l.seq DESC LIMIT 1) AS sieved_last_milestone_at
  `
}

// Final review (C1): the ORIGIN sieve — a mission born in a private device's
// conversation is invisible to an ordinary agent — belongs here, not only in
// missions-http.js's visibleMission wrapper. Two routes resolve a mission
// from a CONVERSATION rather than from an already-visible mission (POST
// /missions on a convo that already has one, POST /milestones), and both
// used to hand back (and, for milestones, write into) the unsieved row.
// Same predicate listMissions applies to its WHERE clause; one caller
// passing `excludePrivateOwned` now gets one consistent answer everywhere.
const ORIGIN_SIEVE = `NOT EXISTS (SELECT 1 FROM conversations cv JOIN devices d ON d.id = cv.agent_device_id
  WHERE cv.id = m.origin_convo_id AND d.private = 1)`

export function getMission(db, userId, idOrNum, { excludePrivateOwned = false } = {}) {
  const counts = countsSql(excludePrivateOwned)
  const sieve = excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''
  let row
  if (typeof idOrNum === 'string' && idOrNum.startsWith('ms_')) {
    row = db.prepare(`SELECT m.*, ${counts} FROM missions m WHERE m.id=? AND m.user_id=? ${sieve}`).get(idOrNum, userId)
  } else {
    const n = Number(String(idOrNum).replace(/^#/, ''))
    if (!Number.isInteger(n) || n < 1) return null
    row = db.prepare(`SELECT m.*, ${counts} FROM missions m WHERE m.num=? AND m.user_id=? ${sieve}`).get(n, userId)
  }
  return missionRow(row)
}

// Whenever a conversation GAINS a mission its unassigned items follow it.
// Fix round 3, B1: repointing an item must bump ITS OWN updated_at (the
// caller's `ts`, not a fresh now() — one moment for the whole transaction)
// or `GET /items?since=` and any client syncing on updated_at never learn
// the item gained a mission after its conversation was created/joined.
export function repointItems(db, userId, convoId, missionId, ts) {
  db.prepare('UPDATE items SET mission_id=?, updated_at=? WHERE user_id=? AND origin_convo_id=? AND mission_id IS NULL').run(missionId, ts, userId, convoId)
}

function attachConversation(db, userId, convoId, missionId, ts) {
  db.prepare('UPDATE conversations SET mission_id=? WHERE id=? AND owner_user_id=? AND mission_id IS NULL').run(missionId, convoId, userId)
  repointItems(db, userId, convoId, missionId, ts)
}

export function createMission(db, { userId, deviceId, createdBy, convoId, title, body = '', idemKey = null, excludePrivateOwned = false }) {
  return db.transaction(() => {
    if (idemKey) {
      const dup = db.prepare('SELECT id FROM missions WHERE user_id=? AND idem_key=?').get(userId, idemKey)
      if (dup) return { mission: getMission(db, userId, dup.id, { excludePrivateOwned }), duplicate: true, existing: false }
    }
    const convo = db.prepare('SELECT mission_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
    if (!convo) throw new Error('no_convo')
    if (convo.mission_id) return { mission: getMission(db, userId, convo.mission_id, { excludePrivateOwned }), duplicate: false, existing: true }
    const id = newId('ms')
    const num = nextNum(db, userId)
    const ts = now()
    try {
      db.prepare(`INSERT INTO missions(id,user_id,num,state,title,body,origin_convo_id,origin_device_id,created_by,idem_key,created_at,updated_at)
        VALUES(?,?,?,'open',?,?,?,?,?,?,?,?)`).run(id, userId, num, title, body, convoId, deviceId, createdBy, idemKey, ts, ts)
    } catch (err) {
      if (idemKey && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const dup = db.prepare('SELECT id FROM missions WHERE user_id=? AND idem_key=?').get(userId, idemKey)
        if (dup) return { mission: getMission(db, userId, dup.id, { excludePrivateOwned }), duplicate: true, existing: false }
      }
      throw err
    }
    attachConversation(db, userId, convoId, id, ts)
    return { mission: getMission(db, userId, id, { excludePrivateOwned }), duplicate: false, existing: false }
  })()
}

export function listMissions(db, userId, { state = null, since = null, excludePrivateOwned = false } = {}) {
  const where = ['m.user_id = ?']
  const args = [userId]
  if (state) { where.push('m.state = ?'); args.push(state) }
  if (since != null) { where.push('m.updated_at >= ?'); args.push(since) }
  // Same shape as listItems' excludePrivateOwned: a mission born in a private
  // device's conversation is invisible to an ordinary agent. One predicate,
  // shared with getMission (see ORIGIN_SIEVE) so the list and the single-row
  // read can never disagree about what is hidden.
  if (excludePrivateOwned) where.push(ORIGIN_SIEVE)
  // Fix round 3, B2: the stored m.last_milestone_at (and updated_at) are
  // bumped by EVERY milestone, including one posted on a private-owned
  // conversation the ordinary agent can't see — ordering on it would jump a
  // mission to the top of a list that shows last_milestone: null,
  // milestones: 0 for it, disagreeing with the row it displays. When
  // excludePrivateOwned, order by the SIEVED last-milestone timestamp
  // (sieved_last_milestone_at, the same sieved subquery countsSql uses for
  // last_milestone) so the list order always agrees with what's shown. The
  // owner/private-agent path is unchanged (stored column, unsieved).
  const orderCol = excludePrivateOwned ? 'sieved_last_milestone_at' : 'm.last_milestone_at'
  const rows = db.prepare(`SELECT m.*, ${countsSql(excludePrivateOwned)} FROM missions m WHERE ${where.join(' AND ')}
    ORDER BY (${orderCol} IS NULL), ${orderCol} DESC, m.created_at DESC`).all(...args)
  return rows.map(missionRow)
}

const PRIVATE_CONVO = `EXISTS (SELECT 1 FROM devices d WHERE d.id = c.agent_device_id AND d.private = 1)`

export function missionDetail(db, userId, missionId, { excludePrivateOwned = false } = {}) {
  const mission = getMission(db, userId, missionId, { excludePrivateOwned })
  if (!mission) return null
  const sieve = excludePrivateOwned ? `AND NOT ${PRIVATE_CONVO}` : ''
  const milestones = db.prepare(`SELECT l.* FROM milestones l JOIN conversations c ON c.id = l.convo_id
    WHERE l.mission_id=? ${sieve} ORDER BY l.created_at DESC, l.seq DESC`).all(mission.id).map(milestoneRow)
  const items = db.prepare(`SELECT i.id, i.num, i.kind, i.state, i.awaiting, i.title, i.origin_convo_id, i.updated_at
    FROM items i JOIN conversations c ON c.id = i.origin_convo_id
    WHERE i.mission_id=? AND i.state='open' ${sieve}
    ORDER BY (i.awaiting = 'user') DESC, i.updated_at DESC`).all(mission.id)
  const conversations = db.prepare(`SELECT c.id, c.title, c.session_state AS state, d.name AS box
    FROM conversations c LEFT JOIN devices d ON d.id = c.agent_device_id
    WHERE c.mission_id=? ${sieve} ORDER BY c.created_at`).all(mission.id)
  return { mission, milestones, items, conversations }
}

export function updateMission(db, { userId, missionId, fields, excludePrivateOwned = false }) {
  return db.transaction(() => {
    const cur = db.prepare('SELECT state FROM missions WHERE id=? AND user_id=?').get(missionId, userId)
    if (!cur) return null
    if (cur.state === 'closed') throw new Error('closed')
    const sets = []; const args = []
    if (fields.title !== undefined) { sets.push('title=?'); args.push(fields.title) }
    if (fields.body !== undefined) { sets.push('body=?'); args.push(fields.body) }
    sets.push('updated_at=?'); args.push(now())
    db.prepare(`UPDATE missions SET ${sets.join(', ')} WHERE id=? AND user_id=?`).run(...args, missionId, userId)
    return getMission(db, userId, missionId, { excludePrivateOwned })
  })()
}

export function joinMission(db, { userId, missionId, convoId, excludePrivateOwned = false }) {
  return db.transaction(() => {
    const m = db.prepare('SELECT id, state FROM missions WHERE id=? AND user_id=?').get(missionId, userId)
    if (!m) throw new Error('no_mission')
    if (m.state === 'closed') throw new Error('closed')
    const convo = db.prepare('SELECT mission_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
    if (!convo) throw new Error('no_convo')
    if (convo.mission_id && convo.mission_id !== m.id) throw new Error('other_mission')
    if (!convo.mission_id) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE mission_id=?').get(m.id).n
      if (n >= CONVOS_MAX) throw new Error('too_many_convos')
      const ts = now()
      attachConversation(db, userId, convoId, m.id, ts)
      db.prepare('UPDATE missions SET updated_at=? WHERE id=?').run(ts, m.id)
    }
    return getMission(db, userId, m.id, { excludePrivateOwned })
  })()
}

// Review fix (Task 7, Critical 2): a hidden open item (on a private-owned
// conversation the caller can't see) still BLOCKS the close — it exists and
// is open, whether or not this caller can see it — but the `items` array on
// the thrown error is filtered to what the caller may actually see, so an
// ordinary agent's 409 never names a private item or its title.
// `by === 'agent'` covers both an ordinary and a private agent; only the
// ordinary one passes excludePrivateOwned true.
export function closeMission(db, { userId, missionId, by, summary, excludePrivateOwned = false }) {
  return db.transaction(() => {
    const m = db.prepare('SELECT id, state FROM missions WHERE id=? AND user_id=?').get(missionId, userId)
    if (!m) throw new Error('no_mission')
    if (m.state === 'closed') throw new Error('closed')
    const open = db.prepare(`
      SELECT i.num, i.title, i.awaiting,
        EXISTS (SELECT 1 FROM conversations oc JOIN devices d ON d.id = oc.agent_device_id
                WHERE oc.id = i.origin_convo_id AND d.private = 1) AS is_private
      FROM items i WHERE i.mission_id=? AND i.state='open' ORDER BY i.num
    `).all(m.id)
    const visible = (i) => !excludePrivateOwned || !i.is_private
    if (by === 'agent') {
      const user = open.filter((i) => i.awaiting === 'user')
      if (user.length) { const e = new Error('user_items'); e.items = user.filter(visible).map(({ num, title }) => ({ num, title })); throw e }
      if (open.length) { const e = new Error('agent_items'); e.items = open.filter(visible).map(({ num, title }) => ({ num, title })); throw e }
    }
    const ts = now()
    db.prepare(`UPDATE missions SET state='closed', close_summary=?, closed_by=?, closed_over_open_items=?, closed_at=?, updated_at=?
      WHERE id=?`).run(summary, by, open.length, ts, ts, m.id)
    return { mission: getMission(db, userId, m.id, { excludePrivateOwned }), openItemNums: open.map((i) => i.num) }
  })()
}

// The milestone row and its marker are one write: appendMarker runs INSIDE
// this transaction (append() is itself a sync better-sqlite3 transaction,
// nested as a savepoint) and the returned seq is the row's anchor. If the
// append throws, nothing — not even the number — survives.
export function createMilestone(db, { userId, deviceId, createdBy, convoId, kind, title, body = '', idemKey = null, appendMarker, excludePrivateOwned = false }) {
  return db.transaction(() => {
    if (!MILESTONE_KINDS.includes(kind)) throw new Error('bad_kind')
    if (idemKey) {
      const dup = db.prepare('SELECT id, mission_id FROM milestones WHERE user_id=? AND idem_key=?').get(userId, idemKey)
      if (dup) {
        const mission = getMission(db, userId, dup.mission_id, { excludePrivateOwned })
        // Hidden to this caller (C1) — answer exactly as a fresh post would,
        // never a 200 carrying a null mission.
        if (!mission) throw new Error('no_mission')
        return { milestone: milestoneRow(db.prepare('SELECT * FROM milestones WHERE id=?').get(dup.id)), mission, duplicate: true }
      }
    }
    const convo = db.prepare('SELECT mission_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
    if (!convo) throw new Error('no_convo')
    if (!convo.mission_id) throw new Error('no_mission')
    // Resolved THROUGH the caller's own sieve (C1): a conversation the user
    // joined to a private-origin mission must not become a write path into
    // it for an ordinary agent. Refused before the marker append, so nothing
    // — not the row, not the number, not the event — is written.
    const mission = getMission(db, userId, convo.mission_id, { excludePrivateOwned })
    if (!mission) throw new Error('no_mission')
    if (mission.state === 'closed') throw new Error('closed')
    const id = newId('ml')
    const num = nextNum(db, userId)
    const ts = now()
    const milestone = { id, num, kind, title, body }
    // Numbers, never words, across the privacy boundary (fix round 2,
    // Critical): the user may post a milestone on a PUBLIC conversation they
    // joined to a private-origin mission, and that conversation's ordinary
    // agents replay this stored marker verbatim. The milestone's own fields
    // stay — it is this conversation's own content — but the mission title
    // does not travel with it.
    const markerWithTitle = markerTitleAllowed(db, mission.origin_convo_id, convoId)
    let r
    try {
      r = appendMarker(milestoneMarkerPayload({ milestone, mission, by: createdBy, withTitle: markerWithTitle }))
    } catch (err) {
      const e = new Error('marker_append_failed'); e.cause = err; throw e
    }
    try {
      db.prepare(`INSERT INTO milestones(id,mission_id,user_id,num,kind,title,body,convo_id,seq,device_id,created_by,idem_key,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, mission.id, userId, num, kind, title, body, convoId, r.seq, deviceId, createdBy, idemKey, ts)
    } catch (err) {
      // Review fix (Task 7, Important #4): the marker was appended INSIDE
      // this transaction (its seq is the row's anchor — see the comment
      // above), so a colliding idem_key at INSERT time must roll the WHOLE
      // transaction back, marker included. Returning a "duplicate" here
      // instead (the previous fix) committed a milestone event whose
      // milestone_id pointed at a row that was never written — verified
      // over real HTTP by the reviewer (one marker event, backing row
      // absent). The caller (missions-http.js) recovers by re-querying the
      // winner's row AFTER this transaction has rolled back, exactly the
      // way createMission's INSERT-race catch already recovers a mission —
      // but that recovery cannot safely live inside this transaction, only
      // after it.
      throw err.code === 'SQLITE_CONSTRAINT_UNIQUE' && idemKey ? new Error('idem_key_conflict') : err
    }
    db.prepare('UPDATE missions SET last_milestone_at=?, updated_at=? WHERE id=?').run(ts, ts, mission.id)
    return { milestone: milestoneRow({ ...milestone, mission_id: mission.id, user_id: userId, convo_id: convoId, seq: r.seq, device_id: deviceId, created_by: createdBy, created_at: ts }), mission: getMission(db, userId, mission.id, { excludePrivateOwned }), duplicate: false, seq: r.seq, ts: r.ts, markerWithTitle }
  })()
}

export function listMilestones(db, userId, { convoId, excludePrivateOwned = false }) {
  const sieve = excludePrivateOwned ? `AND NOT ${PRIVATE_CONVO}` : ''
  return db.prepare(`SELECT l.* FROM milestones l JOIN conversations c ON c.id = l.convo_id
    WHERE l.user_id=? AND l.convo_id=? ${sieve} ORDER BY l.created_at DESC, l.seq DESC`).all(userId, convoId).map(milestoneRow)
}
