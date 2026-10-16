// Pure DB state for grants (spec 2026-10-02 matron-to-matron sharing,
// "Grants"). No hub, cards, items or audit events here —
// src/sharing-events.js owns the side effects; the read rule itself is in
// src/visibility.js and the grantee's view of a mission in src/missions.js.
//
// A grant lets one contact into one subject at a level. Phase 1 exercises
// `read` on a mission: the other kinds and levels are the spec's, kept in
// the schema and refused here. A read share takes two yeses — the owner's
// (when an agent asked: 'awaiting_owner') and the grantee's ('pending') —
// and either side can end it.
import { newId } from './items.js'
import { ORIGIN_SIEVE } from './missions.js'
import { getContactRaw, isMutual, parkedAsks, MAX_PARKED_PER_DEVICE, OWN_ASK_TTL_MS, LIVE_GRANT_STATES } from './contacts.js'

export const GRANT_LEVELS = ['read', 'contribute', 'owner']
export const GRANT_STATES = ['awaiting_owner', 'pending', 'active', 'declined', 'revoked', 'expired']

const fail = (code) => { throw new Error(code) }

const RAW = `SELECT g.*, oc.user_id AS oc_user_id, oc.peer_user_id AS grantee_user_id, oc.peer_user AS grantee_name, oc.peer_journal AS grantee_journal,
    ou.name AS owner_name, m.num AS mission_num, m.title AS mission_title
  FROM grants g
  JOIN contacts oc ON oc.id = g.contact_id
  JOIN users ou ON ou.id = g.owner_user_id
  LEFT JOIN missions m ON g.subject_kind = 'mission' AND m.id = g.subject_id`

export const getGrantRaw = (db, id) => (typeof id === 'string' && id.startsWith('gr_') ? db.prepare(`${RAW} WHERE g.id=?`).get(id) ?? null : null)

// The wire shape, from one party's side. `direction` is 'out' for the
// owner, 'in' for the grantee. `contact_id` is the OWNER's contact row, so
// only the owner's side carries it (it is how "unshare with ct_…" finds the
// grant); the grantee's own contact row id is looked up by the caller when
// it needs one. Nothing here names a conversation or a device.
export function grantRow(row, viewerUserId) {
  if (!row) return null
  const out = row.owner_user_id === viewerUserId
  return {
    id: row.id,
    direction: out ? 'out' : 'in',
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    level: row.level,
    state: row.state,
    owner: { user_id: row.owner_user_id, name: row.owner_name },
    grantee: { name: row.grantee_name, address: row.grantee_journal ? `${row.grantee_name}@${row.grantee_journal}` : row.grantee_name },
    ...(out ? { contact_id: row.contact_id } : {}),
    ...(row.subject_kind === 'mission' && row.mission_num != null
      ? { mission: { id: row.subject_id, num: row.mission_num, title: row.mission_title } } : {}),
    requested_by: row.requested_by ?? null,
    revoked_by: row.revoked_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    answered_at: row.answered_at ?? null,
    revoked_at: row.revoked_at ?? null,
  }
}

// What the owner's card previews before anything leaves (spec, hand-over
// step 2, applied to a read share): counts of exactly what the grantee
// will be able to read — the same private sieve grantedMissionDetail uses.
export function sharePreview(db, missionId) {
  const NOT_PRIVATE = (col) => `NOT EXISTS (SELECT 1 FROM conversations pc JOIN private_devices pd ON pd.id = pc.agent_device_id WHERE pc.id = ${col})`
  return db.prepare(`SELECT
      (SELECT COUNT(*) FROM milestones l WHERE l.mission_id = @m AND ${NOT_PRIVATE('l.convo_id')}) AS milestones,
      (SELECT COUNT(*) FROM items i WHERE i.mission_id = @m AND i.consent IS NULL AND ${NOT_PRIVATE('i.origin_convo_id')}) AS items,
      (SELECT COUNT(*) FROM item_comments ic JOIN items i ON i.id = ic.item_id
         WHERE i.mission_id = @m AND i.consent IS NULL AND ic.kind = 'comment' AND ${NOT_PRIVATE('i.origin_convo_id')}) AS comments,
      (SELECT COALESCE(SUM(json_array_length(ic.attachments)), 0) FROM item_comments ic JOIN items i ON i.id = ic.item_id
         WHERE i.mission_id = @m AND i.consent IS NULL AND ${NOT_PRIVATE('i.origin_convo_id')}) AS attachments`).get({ m: missionId })
}

// `by` as in requestContact. `contact` is the owner's contact row id, or a
// same-journal peer's name. Throws: not_contact, level_unavailable,
// no_mission, private_mission, pending, too_many_asks.
// Returns {grant, existing} — existing:true is an already-active grant,
// returned unchanged (sharing twice is not an error).
export function shareMission(db, { ownerUserId, missionId, contact, level, by, convoId = null, deviceId = null, now = Date.now() }) {
  return db.transaction(() => {
    if (!GRANT_LEVELS.includes(level)) fail('bad_level')
    if (level !== 'read') fail('level_unavailable')
    const mission = db.prepare(`SELECT m.id, (${ORIGIN_SIEVE}) AS shareable FROM missions m WHERE m.id=? AND m.user_id=?`).get(missionId, ownerUserId)
    if (!mission) fail('no_mission')
    // A mission born on a private box stays the owner's alone: the grantee's
    // view is the ordinary-agent view, and that view has no such mission.
    if (!mission.shareable) fail('private_mission')
    const own = getContactRaw(db, ownerUserId, contact)
    if (!own || !isMutual(db, own)) fail('not_contact')
    const cur = db.prepare("SELECT * FROM grants WHERE subject_kind='mission' AND subject_id=? AND contact_id=?").get(mission.id, own.id)
    if (cur?.state === 'active') return { grant: getGrantRaw(db, cur.id), existing: true }
    if (cur && (cur.state === 'awaiting_owner' || cur.state === 'pending')) fail('pending')
    if (by === 'agent' && parkedAsks(db, deviceId) >= MAX_PARKED_PER_DEVICE) fail('too_many_asks')
    const state = by === 'agent' ? 'awaiting_owner' : 'pending'
    let id = cur?.id
    if (cur) {
      db.prepare(`UPDATE grants SET level=?, state=?, requested_by=?, origin_convo_id=?, origin_device_id=?, owner_item_id=NULL, grantee_item_id=NULL,
        revoked_by=NULL, updated_at=?, answered_at=NULL, revoked_at=NULL WHERE id=?`).run(level, state, by, convoId, deviceId, now, cur.id)
    } else {
      id = newId('gr')
      db.prepare(`INSERT INTO grants(id,owner_user_id,subject_kind,subject_id,contact_id,level,state,requested_by,origin_convo_id,origin_device_id,created_at,updated_at)
        VALUES(?,?,'mission',?,?,?,?,?,?,?,?,?)`).run(id, ownerUserId, mission.id, own.id, level, state, by, convoId, deviceId, now, now)
    }
    return { grant: getGrantRaw(db, id), existing: false }
  })()
}

const setState = (db, id, state, now, extra = '') =>
  db.prepare(`UPDATE grants SET state=?, updated_at=? ${extra} WHERE id=?`).run(state, now, id)

// One party's answer to one of the two cards. null = not a grant of
// theirs (the owner's or the grantee's). Outcomes: 'sent' (owner approved:
// now pending with the grantee), 'withdrawn' (owner declined own agent's
// ask), 'expired', 'unavailable' (approved, but the two are no longer
// contacts — the row is revoked), 'accepted' | 'declined' (the grantee).
export function answerGrant(db, { userId, grantId, decision, now = Date.now() }) {
  return db.transaction(() => {
    const g = getGrantRaw(db, grantId)
    if (!g || (g.owner_user_id !== userId && g.grantee_user_id !== userId)) return null
    const isOwner = g.owner_user_id === userId
    // The grantee has never been told of an ask its owner has not approved.
    if (!isOwner && g.state === 'awaiting_owner') return null
    const done = (outcome) => ({ outcome, grant: getGrantRaw(db, g.id), before: g })
    const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(g.contact_id)
    if (isOwner && g.state === 'awaiting_owner') {
      if (now - g.updated_at > OWN_ASK_TTL_MS) { setState(db, g.id, 'expired', now); return done('expired') }
      if (decision === 'decline') { setState(db, g.id, 'declined', now, `, answered_at=${Number(now)}`); return done('withdrawn') }
      if (!isMutual(db, contact)) {
        setState(db, g.id, 'revoked', now, `, revoked_by='contact_removed', revoked_at=${Number(now)}`)
        return done('unavailable')
      }
      setState(db, g.id, 'pending', now)
      return done('sent')
    }
    if (!isOwner && g.state === 'pending') {
      if (decision === 'decline') { setState(db, g.id, 'declined', now, `, answered_at=${Number(now)}`); return done('declined') }
      if (!isMutual(db, contact)) fail('not_pending')
      setState(db, g.id, 'active', now, `, answered_at=${Number(now)}`)
      return done('accepted')
    }
    fail('not_pending')
  })()
}

// Either side ends a grant that is, or may still become, live. For the
// grantee a row still awaiting the OWNER's approval does not exist yet
// (they have never been told of it): same null as an unknown id.
export function revokeGrant(db, { userId, grantId, now = Date.now() }) {
  return db.transaction(() => {
    const g = getGrantRaw(db, grantId)
    if (!g || (g.owner_user_id !== userId && g.grantee_user_id !== userId)) return null
    const isOwner = g.owner_user_id === userId
    if (!isOwner && g.state === 'awaiting_owner') return null
    if (!['awaiting_owner', 'pending', 'active'].includes(g.state)) fail('not_active')
    setState(db, g.id, 'revoked', now, `, revoked_by='${isOwner ? 'owner' : 'grantee'}', revoked_at=${Number(now)}`)
    return { grant: getGrantRaw(db, g.id), before: g, by: isOwner ? 'owner' : 'grantee' }
  })()
}

// direction 'out' = grants I gave, 'in' = grants given to me (never one
// still waiting for its owner's approval). Ended rows are listed only when
// a state is named.
export function listGrants(db, userId, { direction = null, missionId = null, state = null } = {}) {
  const where = []; const args = { u: userId }
  if (direction === 'out') where.push('g.owner_user_id = @u')
  else if (direction === 'in') where.push("oc.peer_user_id = @u AND oc.peer_journal IS NULL AND g.state <> 'awaiting_owner'")
  else where.push("(g.owner_user_id = @u OR (oc.peer_user_id = @u AND oc.peer_journal IS NULL AND g.state <> 'awaiting_owner'))")
  if (missionId) { where.push("g.subject_kind = 'mission' AND g.subject_id = @m"); args.m = missionId }
  if (state) { where.push('g.state = @s'); args.s = state } else where.push(`g.state IN ${LIVE_GRANT_STATES}`)
  return db.prepare(`${RAW} WHERE ${where.join(' AND ')} ORDER BY g.updated_at DESC`).all(args).map((r) => grantRow(r, userId))
}

// Active grantees of one mission, for the live frame: user ids only.
export function activeGranteeIds(db, missionId) {
  return db.prepare(`SELECT DISTINCT oc.peer_user_id AS id FROM grants g
    JOIN contacts oc ON oc.id = g.contact_id AND oc.state = 'active' AND oc.peer_journal IS NULL
    JOIN contacts vc ON vc.user_id = oc.peer_user_id AND vc.peer_user_id = oc.user_id AND vc.peer_journal IS NULL AND vc.state = 'active'
    WHERE g.subject_kind = 'mission' AND g.subject_id = ? AND g.state = 'active'`).all(missionId).map((r) => r.id)
}

export function expireGrantAsks(db, now = Date.now()) {
  return db.transaction(() => {
    const rows = db.prepare(`${RAW} WHERE g.state='awaiting_owner' AND g.updated_at < ?`).all(now - OWN_ASK_TTL_MS)
    for (const r of rows) setState(db, r.id, 'expired', now)
    return rows
  })()
}

export function setGrantItem(db, grantId, side, itemId) {
  db.prepare(`UPDATE grants SET ${side === 'owner' ? 'owner_item_id' : 'grantee_item_id'}=? WHERE id=?`).run(itemId, grantId)
}
