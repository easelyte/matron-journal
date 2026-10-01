// Pure DB state for missions & milestones (spec 2026-09-10). No hub, push
// or wake here — src/missions-http.js owns the side effects. Same stance
// as src/items.js: every recoverable failure is a tagged Error the HTTP
// layer maps to one status; anything else is a bug and reaches the 500.
import { nextNum, newId, BODY_MAX } from './items.js'
import { milestoneMarkerPayload } from './missions-marker.js'
import { markerTitleAllowed } from './privacy.js'
import { sharedConvoSql } from './visibility.js'
import { MESSAGE_TYPES_SQL } from './message-types.js'
import { activateLink, endLink, hasActiveLink, linkRow, nextCurrent, topLevelActiveCount } from './mission-links.js'

export const MILESTONE_KINDS = ['user_input', 'progress']
export const TITLE_MAX = 200
export const CONVOS_MAX = 200
export const STATUS_MAX = 600
// Status (spec 2026-09-28 missions dashboard §1) is markdown, so \n and \t
// stay; every other C0/C1 control and U+2028/2029 is refused — the set
// items' action labels refuse (ACTION_BAD_CHARS), minus the two a
// paragraph needs. CRLF is folded to \n before this runs, so only a LONE
// \r is refused.
const STATUS_BAD_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/
// Shared with projects.js: the four status columns a withheld status nulls.
export const STATUS_FIELDS = ['status', 'status_by', 'status_convo_id', 'status_updated_at']

// Spec 2026-09-30 §2/§4.2 activity. quiet = nothing for 7 days; the clock
// is read at row-building time.
export const QUIET_MS = 7 * 24 * 60 * 60 * 1000

export function activityOf({ state, running, waiting, needsYou, lastActivityAt }, nowMs = Date.now()) {
  if (state === 'closed') return 'closed'
  if (running > 0) return 'running'
  if (waiting > 0 || needsYou > 0) return 'waiting'
  if (nowMs - lastActivityAt >= QUIET_MS) return 'quiet'
  return 'idle'
}

// The three per-caller inputs activity needs, over ACTIVE links only.
// `sieve` is the caller's conversation predicate on alias c (the same one
// the counts use), so a hidden session is never "running" and a hidden
// conversation's messages are never "activity". A conversation's activity
// is its newest MESSAGE event (the /snapshot last_ts rule — session_status
// and markers are not activity) or when it joined, whichever is later.
// Indexes: the link scans ride mission_conversations' PRIMARY KEY
// (mission_id, convo_id); c is a conversations PK lookup; the newest-message
// probe walks idx_events_convo (convo_id, seq) backwards from the top.
function activitySql(sieve) {
  return `
    (SELECT COUNT(*) FROM mission_conversations al JOIN conversations c ON c.id = al.convo_id
       WHERE al.mission_id = m.id AND al.ended_at IS NULL AND c.session_state = 'running' ${sieve}) AS running_convos,
    (SELECT COUNT(*) FROM mission_conversations al JOIN conversations c ON c.id = al.convo_id
       WHERE al.mission_id = m.id AND al.ended_at IS NULL AND c.session_state = 'waiting' ${sieve}) AS waiting_convos,
    (SELECT MAX(max(al.joined_at, COALESCE((SELECT e.ts FROM events e WHERE e.convo_id = c.id
                 AND e.type IN (${MESSAGE_TYPES_SQL}) ORDER BY e.seq DESC LIMIT 1), 0)))
       FROM mission_conversations al JOIN conversations c ON c.id = al.convo_id
       WHERE al.mission_id = m.id AND al.ended_at IS NULL ${sieve}) AS convo_activity_at`
}

const now = () => Date.now()

// idem_key is internal (same stance as rowToItem). `sieved_last_milestone_at`
// (fix round 3, B2) is a sort key countsSql computes for listMissions' ORDER
// BY — never part of the wire shape. `status_device_id` (spec 2026-09-28
// missions dashboard §1) is internal too: the device that wrote the status,
// kept only so the privacy sieve can key on it. `status_hidden` is the
// per-caller sieve verdict countsSql/sharedCountsSql compute — never on the wire.
// `running_convos`, `waiting_convos` and `convo_activity_at` are activity
// inputs, never on the wire.
export function missionRow(row) {
  if (!row) return null
  const {
    idem_key: _idemKey, sieved_last_milestone_at: sievedLastMilestoneAt,
    status_device_id: _statusDeviceId, status_hidden: statusHidden,
    running_convos: runningConvos, waiting_convos: waitingConvos, convo_activity_at: convoActivityAt, ...rest
  } = row
  const { closed_hidden: closedHidden, ...bare } = rest
  const out = { ...bare, closed_over_open_items: Number(bare.closed_over_open_items || 0) }
  // Same sieve for the closing conversation (CLOSED_PRIVATE): a private
  // Coordinator's conversation id must not reach an ordinary agent through
  // the mission row it closed. Null reads exactly as "none named".
  if (Number(closedHidden || 0) && 'closed_convo_id' in out) out.closed_convo_id = null
  for (const k of ['open_items', 'needs_you', 'conversations', 'milestones']) if (k in out) out[k] = Number(out[k])
  if ('last_milestone_json' in out) {
    out.last_milestone = out.last_milestone_json ? JSON.parse(out.last_milestone_json) : null
    delete out.last_milestone_json
  }
  // The sieve's verdict (STATUS_PRIVATE, below) — computed per caller by
  // countsSql / sharedCountsSql. A withheld status reads as four nulls, the
  // same shape as "never set", so its absence says nothing.
  if (Number(statusHidden || 0)) for (const k of STATUS_FIELDS) out[k] = null
  // Spec 2026-09-30 §2 activity — computed after the status sieve, so a
  // withheld status_updated_at never counts. Every input here is the
  // caller's own sieved view (countsSql / sharedCountsSql). One argument
  // only (rows are built with .map(missionRow)); the clock is read here.
  if (runningConvos !== undefined) {
    out.last_activity_at = Math.max(...[out.created_at, sievedLastMilestoneAt, out.status_updated_at, convoActivityAt]
      .filter((v) => v != null).map(Number))
    out.activity = activityOf({
      state: out.state, running: Number(runningConvos), waiting: Number(waitingConvos),
      needsYou: out.needs_you ?? 0, lastActivityAt: out.last_activity_at,
    })
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
  // PATCH only: POST /missions ignores a status rather than storing one.
  // null is the explicit clear; a string is trimmed, then 1–STATUS_MAX
  // UTF-16 code units (JS .length, like TITLE_MAX).
  if (partial && body.status !== undefined) {
    if (body.status === null) value.status = null
    else {
      if (typeof body.status !== 'string') return { ok: false }
      const s = body.status.replace(/\r\n/g, '\n').trim()
      if (!s || s.length > STATUS_MAX || STATUS_BAD_CHARS.test(s)) return { ok: false }
      value.status = s
    }
  }
  return { ok: true, value }
}

// Spec 2026-09-28 missions dashboard §1, privacy: a status written from a
// private-owned conversation is withheld from an ordinary agent the way that
// conversation's milestones are. Keyed on the writing DEVICE too: a private
// agent that named no conversation (or a public one) wrote it all the same.
// Evaluated at read time against the current private flag, like every other
// private-owned sieve here.
// `alias` names the row's table alias, so projects.js applies the same
// sieve to its own status columns (projects p).
export const statusPrivateSql = (alias) => `(
  EXISTS (SELECT 1 FROM devices sd WHERE sd.id = ${alias}.status_device_id AND sd.private = 1)
  OR EXISTS (SELECT 1 FROM conversations sc JOIN devices sd ON sd.id = sc.agent_device_id
             WHERE sc.id = ${alias}.status_convo_id AND sd.private = 1)
)`
const STATUS_PRIVATE = statusPrivateSql('m')

// The closing conversation (closed_convo_id) is withheld from an ordinary
// agent when it is private-owned, as status_convo_id is above.
const CLOSED_PRIVATE = `EXISTS (SELECT 1 FROM conversations cc JOIN devices cd ON cd.id = cc.agent_device_id
             WHERE cc.id = m.closed_convo_id AND cd.private = 1)`

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
    (SELECT COUNT(*) FROM mission_conversations cl JOIN conversations c ON c.id = cl.convo_id
       WHERE cl.mission_id = m.id AND cl.ended_at IS NULL AND c.parent_convo_id IS NULL ${convoSieve}) AS conversations,
    (SELECT COUNT(*) FROM milestones l WHERE l.mission_id = m.id ${milestoneSieve}) AS milestones,
    (SELECT json_object('num', l.num, 'title', l.title, 'kind', l.kind, 'created_at', l.created_at)
       FROM milestones l WHERE l.mission_id = m.id ${milestoneSieve} ORDER BY l.created_at DESC, l.seq DESC LIMIT 1) AS last_milestone_json,
    (SELECT l.created_at FROM milestones l WHERE l.mission_id = m.id ${milestoneSieve}
       ORDER BY l.created_at DESC, l.seq DESC LIMIT 1) AS sieved_last_milestone_at,
    ${excludePrivateOwned ? STATUS_PRIVATE : '0'} AS status_hidden,
    ${excludePrivateOwned ? CLOSED_PRIVATE : '0'} AS closed_hidden
    ,${activitySql(convoSieve)},
    (SELECT p.num FROM projects p WHERE p.id = m.project_id) AS project_num
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
export const ORIGIN_SIEVE = `NOT EXISTS (SELECT 1 FROM conversations cv JOIN devices d ON d.id = cv.agent_device_id
  WHERE cv.id = m.origin_convo_id AND d.private = 1)`

// Cross-user variant of ORIGIN_SIEVE: fails closed when the origin
// conversation's device row is gone (revoked), matching sharedConvoSql.
const ORIGIN_SHARED_SIEVE = `EXISTS (SELECT 1 FROM conversations cv LEFT JOIN devices d
    ON d.id = cv.agent_device_id AND d.user_id = cv.owner_user_id
  WHERE cv.id = m.origin_convo_id AND (cv.agent_device_id IS NULL OR d.private = 0))`

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
  const r = db.prepare('UPDATE conversations SET mission_id=? WHERE id=? AND owner_user_id=? AND mission_id IS NULL').run(missionId, convoId, userId)
  if (r.changes) activateLink(db, { missionId, convoId, userId, how: 'origin', ts })
  repointItems(db, userId, convoId, missionId, ts)
}

// D5 note: `projectId` only ever reaches the INSERT below — the idem_key
// replay and the attach-existing short-circuits both return first, without
// touching it. missions-http.js's handleCreate mirrors that same pair of
// conditions (createsNewMission) so it can skip validating `project` before
// either of those short-circuits fires; if either condition here changes,
// that peek must change with it.
export function createMission(db, { userId, deviceId, createdBy, convoId, title, body = '', idemKey = null, excludePrivateOwned = false, attach = true, projectId = null }) {
  return db.transaction(() => {
    if (idemKey) {
      const dup = db.prepare('SELECT id FROM missions WHERE user_id=? AND idem_key=?').get(userId, idemKey)
      if (dup) return { mission: getMission(db, userId, dup.id, { excludePrivateOwned }), duplicate: true, existing: false }
    }
    const convo = db.prepare('SELECT mission_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
    if (!convo) throw new Error('no_convo')
    // attach:false (spec 2026-09-23 coordinator redesign §1b) creates an
    // UNASSIGNED mission: the conversation is only its provenance
    // (origin_convo_id), so whether it already belongs to a mission is
    // irrelevant — no short-circuit, and nothing below attaches it.
    if (attach && convo.mission_id) return { mission: getMission(db, userId, convo.mission_id, { excludePrivateOwned }), duplicate: false, existing: true }
    const id = newId('ms')
    const num = nextNum(db, userId)
    const ts = now()
    try {
      db.prepare(`INSERT INTO missions(id,user_id,num,state,title,body,origin_convo_id,origin_device_id,created_by,idem_key,created_at,updated_at,project_id)
        VALUES(?,?,?,'open',?,?,?,?,?,?,?,?,?)`).run(id, userId, num, title, body, convoId, deviceId, createdBy, idemKey, ts, ts, projectId)
    } catch (err) {
      if (idemKey && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const dup = db.prepare('SELECT id FROM missions WHERE user_id=? AND idem_key=?').get(userId, idemKey)
        if (dup) return { mission: getMission(db, userId, dup.id, { excludePrivateOwned }), duplicate: true, existing: false }
      }
      throw err
    }
    if (attach) attachConversation(db, userId, convoId, id, ts)
    return { mission: getMission(db, userId, id, { excludePrivateOwned }), duplicate: false, existing: false }
  })()
}

export function listMissions(db, userId, { state = null, since = null, projectId = null, filed = false, excludePrivateOwned = false } = {}) {
  const where = ['m.user_id = ?']
  const args = [userId]
  if (state) { where.push('m.state = ?'); args.push(state) }
  if (since != null) { where.push('m.updated_at >= ?'); args.push(since) }
  if (projectId) { where.push('m.project_id = ?'); args.push(projectId) }
  // filed: only missions in SOME project — listProjects' rollups never need
  // the (usually far larger) unfiled rest.
  if (filed) where.push('m.project_id IS NOT NULL')
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

// Fold the LEFT JOINed conversation_status columns into one `status` block
// (omitted when the session never reported), the shape GET /roster serves
// (spec 2026-09-29 coordinator session control §1). Own-user detail only:
// sharedMissionDetail deliberately carries no session header.
function withConvoStatus({ status_reported_at, status_json, ...row }) {
  if (status_json == null) return row
  try { return { ...row, status: { reported_at: status_reported_at, ...JSON.parse(status_json) } } } catch { return row }
}

// Spec 2026-09-30 §3: every sub-chat whose parent (or any ancestor) is also
// among `rows` folds into that nearest listed ancestor's row — it is counted
// in that row's subchat_count and, unless `subchats`, left out of the list.
// A sub-chat whose parent is not among the rows stands as its own row:
// folding never hides a link. A parent cycle (never written by the journal,
// but not guarded by the schema either) folds nothing: each row on it is its
// own root. Callers run it AFTER the privacy sieve, so a hidden sub-chat is
// neither listed nor counted. Input order is kept; input rows are not mutated.
export function foldSubchats(rows, { subchats = false } = {}) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const rootOf = (r) => {
    let cur = r
    const seen = new Set([r.id])
    while (cur.parent_convo_id && byId.has(cur.parent_convo_id)) {
      if (seen.has(cur.parent_convo_id)) return r
      cur = byId.get(cur.parent_convo_id); seen.add(cur.id)
    }
    return cur
  }
  const counts = new Map()
  const folded = new Set()
  for (const r of rows) {
    const root = rootOf(r)
    if (root !== r) { counts.set(root.id, (counts.get(root.id) || 0) + 1); folded.add(r.id) }
  }
  const out = rows.map((r) => ({ ...r, subchat_count: counts.get(r.id) || 0 }))
  return subchats ? out : out.filter((r) => !folded.has(r.id))
}

// Mockup 03's "also on #N" / "moved to #N" on a mission page's conversation
// rows (spec 2026-09-30 §3): each listed row names the conversation's links
// to OTHER missions — current first, then active, then ended newest first
// (conversationMissions' order), at most OTHER_MISSIONS_MAX. A slim shape,
// not a mission row: the page needs a chip, not counts. ORIGIN_SIEVE keeps
// a private-origin mission (the user may have joined this public
// conversation to one) from being named to an ordinary agent. Folded
// sub-chats are not listed, so they carry none.
export const OTHER_MISSIONS_MAX = 5

function otherMissionsStmt(db, excludePrivateOwned) {
  return db.prepare(`SELECT m.id, m.num, m.title, (c.mission_id = m.id) AS current, (l.ended_at IS NULL) AS active,
      l.joined_at, l.ended_at
    FROM mission_conversations l
    JOIN missions m ON m.id = l.mission_id AND m.user_id = ?
    JOIN conversations c ON c.id = l.convo_id
    WHERE l.convo_id = ? AND l.mission_id <> ? ${excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''}
    ORDER BY current DESC, (l.ended_at IS NULL) DESC, COALESCE(l.ended_at, l.joined_at) DESC
    LIMIT ${OTHER_MISSIONS_MAX}`)
}

const otherMissionRow = (r) => ({ ...r, current: !!r.current, active: !!r.active })

// `conversations[]` lists the conversations LINKED to this mission (spec
// 2026-09-30 §3). By default only ACTIVE links (controller ruling D3, spec
// §7: an old app copies this list into its members table without reading
// ended_at, so a conversation that left must not appear); `history` appends
// the ended links after every active row, each with its ended_at. Folding
// runs within each group: an ended sub-chat never folds into an active row
// (nor an active one into an ended row), so an active row's subchat_count
// is the same with or without history.
export function missionDetail(db, userId, missionId, { excludePrivateOwned = false, subchats = false, history = false } = {}) {
  const mission = getMission(db, userId, missionId, { excludePrivateOwned })
  if (!mission) return null
  const sieve = excludePrivateOwned ? `AND NOT ${PRIVATE_CONVO}` : ''
  const milestones = db.prepare(`SELECT l.* FROM milestones l JOIN conversations c ON c.id = l.convo_id
    WHERE l.mission_id=? ${sieve} ORDER BY l.created_at DESC, l.seq DESC`).all(mission.id).map(milestoneRow)
  const items = db.prepare(`SELECT i.id, i.num, i.kind, i.state, i.awaiting, i.title, i.origin_convo_id, i.updated_at
    FROM items i JOIN conversations c ON c.id = i.origin_convo_id
    WHERE i.mission_id=? AND i.state='open' ${sieve}
    ORDER BY (i.awaiting = 'user') DESC, i.updated_at DESC`).all(mission.id)
  // A sub-chat whose parent the caller cannot see (a filtered agent and a
  // private-device parent) must not name it: parent_convo_id is withheld.
  const parentHidden = excludePrivateOwned
    ? `EXISTS (SELECT 1 FROM conversations pc JOIN devices pd ON pd.id = pc.agent_device_id
         WHERE pc.id = c.parent_convo_id AND pd.private = 1)`
    : '0'
  const rows = db.prepare(`SELECT c.id, c.title, c.session_state AS state, d.name AS box, c.parent_convo_id,
      ${parentHidden} AS parent_hidden,
      (c.mission_id IS NOT NULL AND c.mission_id = l.mission_id) AS current, l.how, l.joined_at, l.ended_at,
      s.reported_at AS status_reported_at, s.status AS status_json
    FROM mission_conversations l JOIN conversations c ON c.id = l.convo_id AND c.owner_user_id = ?
    LEFT JOIN devices d ON d.id = c.agent_device_id
    LEFT JOIN conversation_status s ON s.convo_id = c.id
    WHERE l.mission_id = ? ${history ? '' : 'AND l.ended_at IS NULL'} ${sieve}
    ORDER BY (l.ended_at IS NOT NULL), l.joined_at, c.created_at`).all(userId, mission.id)
    .map(({ parent_hidden: hidden, ...r }) => withConvoStatus({ ...r, current: !!r.current, parent_convo_id: hidden ? null : r.parent_convo_id }))
  const conversations = [
    ...foldSubchats(rows.filter((r) => r.ended_at == null), { subchats }),
    ...foldSubchats(rows.filter((r) => r.ended_at != null), { subchats }),
  ]
  const others = otherMissionsStmt(db, excludePrivateOwned)
  for (const c of conversations) c.other_missions = others.all(userId, c.id, mission.id).map(otherMissionRow)
  return { mission, milestones, items, conversations }
}

// GET /conversations/:id/missions (spec 2026-09-30 §3): every mission this
// conversation is or was linked to — current first, then the other active
// links newest-joined first, then ended links newest-ended first. Full
// mission rows (same countsSql, same sieve as GET /missions) plus the link.
// ORIGIN_SIEVE drops a private-origin mission for a filtered caller: the
// user may have joined this public conversation to it.
export function conversationMissions(db, userId, convoId, { excludePrivateOwned = false } = {}) {
  const sieve = excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''
  return db.prepare(`SELECT m.*, ${countsSql(excludePrivateOwned)},
      (c.mission_id IS NOT NULL AND c.mission_id = m.id) AS link_current, l.how AS link_how, l.joined_at AS link_joined_at, l.ended_at AS link_ended_at
    FROM mission_conversations l
    JOIN missions m ON m.id = l.mission_id AND m.user_id = ?
    JOIN conversations c ON c.id = l.convo_id AND c.owner_user_id = ?
    WHERE l.convo_id = ? ${sieve}
    ORDER BY link_current DESC, (l.ended_at IS NULL) DESC, COALESCE(l.ended_at, l.joined_at) DESC`)
    .all(userId, userId, convoId)
    .map(({ link_current: cur, link_how: how, link_joined_at: joinedAt, link_ended_at: endedAt, ...row }) => ({
      ...missionRow(row), current: !!cur, active: endedAt == null, how, joined_at: joinedAt, ended_at: endedAt,
    }))
}

// `statusWriter` {by, convoId, deviceId} (spec 2026-09-28 missions dashboard
// §1) is required whenever fields.status is a string: the status columns are
// always written as one set, never one of them alone, with the same `ts` as
// updated_at. A null status clears all of them, status_device_id included.
export function updateMission(db, { userId, missionId, fields, statusWriter = null, excludePrivateOwned = false }) {
  return db.transaction(() => {
    const cur = db.prepare('SELECT state FROM missions WHERE id=? AND user_id=?').get(missionId, userId)
    if (!cur) return null
    // Refiling (spec 2026-09-30 §4.2) stays legal on a closed mission — a
    // finished mission must stay correctable, like an item's move target —
    // but nothing else about it changes.
    const onlyProject = Object.keys(fields).length > 0 && Object.keys(fields).every((k) => k === 'projectId')
    if (cur.state === 'closed' && !onlyProject) throw new Error('closed')
    const ts = now()
    const sets = []; const args = []
    if (fields.title !== undefined) { sets.push('title=?'); args.push(fields.title) }
    if (fields.body !== undefined) { sets.push('body=?'); args.push(fields.body) }
    if (fields.status !== undefined) {
      if (fields.status !== null && !statusWriter) throw new Error('status_writer_required')
      const w = fields.status === null ? { by: null, convoId: null, deviceId: null } : statusWriter
      sets.push('status=?', 'status_by=?', 'status_convo_id=?', 'status_device_id=?', 'status_updated_at=?')
      args.push(fields.status, w.by, w.convoId ?? null, w.deviceId ?? null, fields.status === null ? null : ts)
    }
    if (fields.projectId !== undefined) { sets.push('project_id=?'); args.push(fields.projectId) }
    sets.push('updated_at=?'); args.push(ts)
    db.prepare(`UPDATE missions SET ${sets.join(', ')} WHERE id=? AND user_id=?`).run(...args, missionId, userId)
    return getMission(db, userId, missionId, { excludePrivateOwned })
  })()
}

// Spec 2026-09-30 §3: join adds (or reactivates) a link and makes it
// CURRENT. The previous current mission stays active ("also on") — a
// conversation on another mission is no longer refused. `action` tells the
// HTTP layer which marker to write: 'joined' (a new or reactivated link),
// 'current_changed' (an already-active link became current) or null (it
// already was current: a no-op, no marker). The cap counts active
// top-level links; a sub-chat never fills a mission.
export function joinMission(db, { userId, missionId, convoId, how = 'joined', excludePrivateOwned = false }) {
  return db.transaction(() => {
    const m = db.prepare('SELECT id, state FROM missions WHERE id=? AND user_id=?').get(missionId, userId)
    if (!m) throw new Error('no_mission')
    if (m.state === 'closed') throw new Error('closed')
    const convo = db.prepare('SELECT mission_id, parent_convo_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
    if (!convo) throw new Error('no_convo')
    const link = linkRow(db, m.id, convoId)
    const active = !!link && link.ended_at == null
    if (active && convo.mission_id === m.id) return { mission: getMission(db, userId, m.id, { excludePrivateOwned }), action: null }
    if (!active && convo.parent_convo_id == null && topLevelActiveCount(db, m.id) >= CONVOS_MAX) throw new Error('too_many_convos')
    const ts = now()
    activateLink(db, { missionId: m.id, convoId, userId, how, ts })
    db.prepare('UPDATE conversations SET mission_id=? WHERE id=? AND owner_user_id=?').run(m.id, convoId, userId)
    repointItems(db, userId, convoId, m.id, ts)
    db.prepare('UPDATE missions SET updated_at=? WHERE id=?').run(ts, m.id)
    if (convo.mission_id && convo.mission_id !== m.id) db.prepare('UPDATE missions SET updated_at=? WHERE id=?').run(ts, convo.mission_id)
    return { mission: getMission(db, userId, m.id, { excludePrivateOwned }), action: active ? 'current_changed' : 'joined' }
  })()
}

// Spec 2026-09-30 §3: leave ends a link (kept as history). Leaving the
// CURRENT one moves current to the most recently joined remaining active
// link on an open mission, else to none (nextCurrent). An already-ended
// link is a no-op (left:false) so a retried leave is safe; no link at all
// is 'no_link'. Items stay where they are. A closed mission may be left.
export function leaveMission(db, { userId, missionId, convoId, excludePrivateOwned = false }) {
  return db.transaction(() => {
    const m = db.prepare('SELECT id FROM missions WHERE id=? AND user_id=?').get(missionId, userId)
    if (!m) throw new Error('no_mission')
    const convo = db.prepare('SELECT mission_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
    if (!convo) throw new Error('no_convo')
    const link = linkRow(db, m.id, convoId)
    if (!link) throw new Error('no_link')
    if (link.ended_at != null) {
      return { mission: getMission(db, userId, m.id, { excludePrivateOwned }), left: false, currentChanged: false, currentMissionId: convo.mission_id ?? null }
    }
    const ts = now()
    endLink(db, { missionId: m.id, convoId, ts })
    let current = convo.mission_id ?? null
    const wasCurrent = current === m.id
    if (wasCurrent) {
      current = nextCurrent(db, convoId)
      db.prepare('UPDATE conversations SET mission_id=? WHERE id=? AND owner_user_id=?').run(current, convoId, userId)
    }
    db.prepare('UPDATE missions SET updated_at=? WHERE id=?').run(ts, m.id)
    return {
      mission: getMission(db, userId, m.id, { excludePrivateOwned }),
      left: true, currentChanged: wasCurrent && current !== null, currentMissionId: current,
    }
  })()
}

// Review fix (Task 7, Critical 2): a hidden open item (on a private-owned
// conversation the caller can't see) still BLOCKS the close — it exists and
// is open, whether or not this caller can see it — but the `items` array on
// the thrown error is filtered to what the caller may actually see, so an
// ordinary agent's 409 never names a private item or its title.
// `by === 'agent'` covers both an ordinary and a private agent; only the
// ordinary one passes excludePrivateOwned true.
// `closedConvoId` is the conversation the closing agent named (validated by
// the HTTP layer: on the mission, or the Coordinator) — stored for the
// record and echoed on the marker; null when none was named.
export function closeMission(db, { userId, missionId, by, summary, closedConvoId = null, excludePrivateOwned = false }) {
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
    db.prepare(`UPDATE missions SET state='closed', close_summary=?, closed_by=?, closed_convo_id=?, closed_over_open_items=?, closed_at=?, updated_at=?
      WHERE id=?`).run(summary, by, closedConvoId, open.length, ts, ts, m.id)
    return { mission: getMission(db, userId, m.id, { excludePrivateOwned }), openItemNums: open.map((i) => i.num) }
  })()
}

// The milestone row and its marker are one write: appendMarker runs INSIDE
// this transaction (append() is itself a sync better-sqlite3 transaction,
// nested as a savepoint) and the returned seq is the row's anchor. If the
// append throws, nothing — not even the number — survives.
export function createMilestone(db, { userId, deviceId, createdBy, convoId, kind, title, body = '', idemKey = null, appendMarker, excludePrivateOwned = false, missionRef = null }) {
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
    // Spec 2026-09-30 §3: `missionRef` (id, "#n" or n) may name ANY mission
    // this conversation has an active link to; the default stays the current
    // one. Unknown, invisible (the caller's own sieve) and unlinked are one
    // answer — not_linked — so the name is never an existence oracle.
    let targetId = convo.mission_id
    if (missionRef != null) {
      const named = getMission(db, userId, missionRef, { excludePrivateOwned })
      if (!named || !hasActiveLink(db, named.id, convoId)) throw new Error('not_linked')
      targetId = named.id
    }
    if (!targetId) throw new Error('no_mission')
    // Resolved THROUGH the caller's own sieve (C1): a conversation the user
    // joined to a private-origin mission must not become a write path into
    // it for an ordinary agent. Refused before the marker append, so nothing
    // — not the row, not the number, not the event — is written.
    const mission = getMission(db, userId, targetId, { excludePrivateOwned })
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

// Cross-user reads (spec 2026-09-23 tracker web/teams). A mission is shared
// with @viewer when its origin conversation is not private-owned
// (ORIGIN_SHARED_SIEVE — otherwise a colleague who later joins a shared
// public conversation to a private-born mission would see its title/body,
// review round 2, Finding 2; it fails closed on a revoked device, unlike
// ORIGIN_SIEVE, which the owner's own private-owned filtering still uses)
// AND its origin conversation, or any conversation carrying its mission_id,
// passes the shared rule; its detail lists only those conversations'
// milestones and items.
const MISSION_SHARED = `(
  ${ORIGIN_SHARED_SIEVE}
  AND (
    EXISTS (SELECT 1 FROM conversations cv WHERE cv.id = m.origin_convo_id AND ${sharedConvoSql('cv')})
    OR EXISTS (SELECT 1 FROM mission_conversations sl JOIN conversations cv ON cv.id = sl.convo_id
               WHERE sl.mission_id = m.id AND sl.ended_at IS NULL AND ${sharedConvoSql('cv')})
  )
)`
const OWNER_JSON = `json_object('user_id', u.id, 'name', u.name, 'github_login', ga.login) AS owner_json`
const OWNER_FROM = `JOIN users u ON u.id = m.user_id LEFT JOIN github_accounts ga ON ga.user_id = m.user_id`

// Review round 2, Finding 1: countsSql(true) only sieves private-DEVICE
// conversations — it still counts (and takes last_milestone from) a
// conversation that carries this mission's id but fails the SHARED rule for
// THIS viewer (no repo, or a repo whose org this viewer isn't in). That let
// a foreign viewer's summary/detail counts disagree with what
// sharedMissionDetail actually lists, and leaked a milestone TITLE from a
// conversation the viewer cannot otherwise read. Every subquery here is
// sieved by sharedConvoSql for @viewer instead — the same predicate
// sharedMissionDetail's own three queries use — so the counts, the ordering
// key (sieved_last_milestone_at) and the detail arrays can never disagree.
// Items also exclude consent mirrors (i.consent IS NULL), matching
// sharedMissionDetail's own items query — a consent ask is the mission
// owner's alone and must never surface to a colleague, not even as a count.
// Status: hidden when privately written, written from a conversation this
// viewer cannot read, or written by an agent that named NO conversation at
// all — a status is a synthesis across the mission's conversations, which
// may include ones this colleague can't read, so an unattributed agent
// write fails closed rather than being taken on faith. A client write with
// no conversation is still shared like the title and body: the owner's own
// device vouches for it the way it vouches for everything else it writes.
function sharedCountsSql() {
  return `
    (SELECT COUNT(*) FROM items i JOIN conversations ic ON ic.id = i.origin_convo_id
       WHERE i.mission_id = m.id AND i.state='open' AND i.consent IS NULL AND ${sharedConvoSql('ic')}) AS open_items,
    (SELECT COUNT(*) FROM items i JOIN conversations ic ON ic.id = i.origin_convo_id
       WHERE i.mission_id = m.id AND i.state='open' AND i.awaiting='user' AND i.consent IS NULL AND ${sharedConvoSql('ic')}) AS needs_you,
    (SELECT COUNT(*) FROM mission_conversations sl JOIN conversations cc ON cc.id = sl.convo_id
       WHERE sl.mission_id = m.id AND sl.ended_at IS NULL AND cc.parent_convo_id IS NULL AND ${sharedConvoSql('cc')}) AS conversations,
    (SELECT COUNT(*) FROM milestones l JOIN conversations mc ON mc.id = l.convo_id
       WHERE l.mission_id = m.id AND ${sharedConvoSql('mc')}) AS milestones,
    (SELECT json_object('num', l.num, 'title', l.title, 'kind', l.kind, 'created_at', l.created_at)
       FROM milestones l JOIN conversations mc ON mc.id = l.convo_id
       WHERE l.mission_id = m.id AND ${sharedConvoSql('mc')} ORDER BY l.created_at DESC, l.seq DESC LIMIT 1) AS last_milestone_json,
    (SELECT l.created_at FROM milestones l JOIN conversations mc ON mc.id = l.convo_id
       WHERE l.mission_id = m.id AND ${sharedConvoSql('mc')}
       ORDER BY l.created_at DESC, l.seq DESC LIMIT 1) AS sieved_last_milestone_at,
    (${STATUS_PRIVATE}
      OR (m.status_by = 'agent' AND m.status_convo_id IS NULL)
      OR (m.status_convo_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM conversations sc WHERE sc.id = m.status_convo_id AND ${sharedConvoSql('sc')}))) AS status_hidden,
    (m.closed_convo_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM conversations cc WHERE cc.id = m.closed_convo_id AND ${sharedConvoSql('cc')})) AS closed_hidden
    ,${activitySql(`AND ${sharedConvoSql('c')}`)},
    NULL AS project_num
  `
}

function sharedMissionRow(row) {
  if (!row) return null
  const { owner_json: ownerJson, ...rest } = row
  const mission = missionRow(rest)
  mission.owner = JSON.parse(ownerJson)
  // Projects are never shared with colleagues (spec 2026-09-30 §9).
  mission.project_id = null
  return mission
}

export function listSharedMissions(db, viewerUserId) {
  return db.prepare(`SELECT m.*, ${sharedCountsSql()}, ${OWNER_JSON} FROM missions m ${OWNER_FROM}
    WHERE ${MISSION_SHARED}
    ORDER BY (sieved_last_milestone_at IS NULL), sieved_last_milestone_at DESC, m.created_at DESC`)
    .all({ viewer: viewerUserId }).map(sharedMissionRow)
}

export function getSharedMission(db, viewerUserId, missionId) {
  if (typeof missionId !== 'string' || !missionId.startsWith('ms_')) return null
  return sharedMissionRow(db.prepare(`SELECT m.*, ${sharedCountsSql()}, ${OWNER_JSON} FROM missions m ${OWNER_FROM}
    WHERE m.id = @id AND ${MISSION_SHARED}`).get({ viewer: viewerUserId, id: missionId }))
}

// The colleague's conversation list reads ACTIVE links (never history: a
// colleague has no members table to reconcile) and folds sub-chats exactly
// like the owner's (controller ruling D8), so its `conversations` count —
// active top-level links — matches the folded list.
export function sharedMissionDetail(db, viewerUserId, mission, { subchats = false } = {}) {
  const args = { viewer: viewerUserId, mid: mission.id }
  const milestones = db.prepare(`SELECT l.* FROM milestones l JOIN conversations cv ON cv.id = l.convo_id
    WHERE l.mission_id = @mid AND ${sharedConvoSql('cv')} ORDER BY l.created_at DESC, l.seq DESC`).all(args).map(milestoneRow)
  const items = db.prepare(`SELECT i.id, i.num, i.kind, i.state, i.awaiting, i.title, i.origin_convo_id, i.updated_at
    FROM items i JOIN conversations cv ON cv.id = i.origin_convo_id
    WHERE i.mission_id = @mid AND i.state='open' AND i.consent IS NULL AND ${sharedConvoSql('cv')}
    ORDER BY (i.awaiting = 'user') DESC, i.updated_at DESC`).all(args)
  // parent_convo_id is withheld when the colleague cannot read the parent.
  const conversations = foldSubchats(db.prepare(`SELECT cv.id, cv.title, cv.session_state AS state, cv.repo, d.name AS box,
      CASE WHEN EXISTS (SELECT 1 FROM conversations pc WHERE pc.id = cv.parent_convo_id AND ${sharedConvoSql('pc')})
        THEN cv.parent_convo_id END AS parent_convo_id
    FROM mission_conversations sl JOIN conversations cv ON cv.id = sl.convo_id
    LEFT JOIN devices d ON d.id = cv.agent_device_id
    WHERE sl.mission_id = @mid AND sl.ended_at IS NULL AND ${sharedConvoSql('cv')} ORDER BY sl.joined_at, cv.created_at`).all(args), { subchats })
  return { mission, milestones, items, conversations }
}

export function listSharedMilestones(db, viewerUserId, convoId) {
  return db.prepare(`SELECT l.* FROM milestones l JOIN conversations cv ON cv.id = l.convo_id
    WHERE l.convo_id = @cid AND ${sharedConvoSql('cv')} ORDER BY l.created_at DESC, l.seq DESC`)
    .all({ viewer: viewerUserId, cid: convoId }).map(milestoneRow)
}
