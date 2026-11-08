// Pure DB state for grants (spec 2026-10-02 matron-to-matron sharing,
// "Grants"). No hub, cards, items or audit events here —
// src/sharing-events.js owns the side effects; the read rule itself is in
// src/visibility.js and the grantee's view of a mission in src/missions.js.
//
// A grant lets one contact into one subject at a level. `read` and
// `contribute` (src/contribute.js) on a mission, and `owner` — a hand-over —
// on a mission or a project (src/handover.js). Every ask takes two yeses — the owner's (when
// an agent asked: 'awaiting_owner') and the grantee's ('pending') — and
// either side can end it until it is accepted.
//
// A grant that is already active can be asked for at a higher level (a
// mission shared read-only, then handed over to the same person). The row
// stays active at its old level while the ask runs in pending_level /
// pending_state, through the same two yeses, and only the grantee's accept
// raises it; a no, an expiry or a withdrawal just clears the ask.
//
// An accepted hand-over stays as the record of it: state 'active', level
// 'owner', copy_subject_id naming the recipient's copy. It confers nothing
// (visibility.js never admits an owner grant) and can no longer be revoked.
import fs from 'node:fs'
import { newId } from './items.js'
import { ORIGIN_SIEVE } from './missions.js'
import { getContactRaw, isMutual, isLiveRemote, parkedAsks, MAX_PARKED_PER_DEVICE, OWN_ASK_TTL_MS, LIVE_GRANT_STATES } from './contacts.js'
import { applyHandover, checkHandoverAsk, checkHandoverStill, approvedSet, sameApprovedSet, subjectProject, HANDOVER_REFUSALS } from './handover.js'

export const GRANT_LEVELS = ['read', 'contribute', 'owner']
export const GRANT_STATES = ['awaiting_owner', 'pending', 'active', 'declined', 'revoked', 'expired']

const fail = (code) => { throw new Error(code) }

const RANK = { read: 1, contribute: 2, owner: 3 }

const RAW = `SELECT g.*, oc.user_id AS oc_user_id, oc.peer_user_id AS grantee_user_id, oc.peer_user AS grantee_name, oc.peer_journal AS grantee_journal,
    ou.name AS owner_name, m.num AS mission_num, m.title AS mission_title, p.num AS project_num, p.title AS project_title
  FROM grants g
  JOIN contacts oc ON oc.id = g.contact_id
  JOIN users ou ON ou.id = g.owner_user_id
  LEFT JOIN missions m ON g.subject_kind = 'mission' AND m.id = g.subject_id
  LEFT JOIN projects p ON g.subject_kind = 'project' AND p.id = g.subject_id`

// The ask a row carries: its own state and level, or the pending raise of
// an active row. `raise` says which.
export const askOf = (g) => (g.pending_state
  ? { state: g.pending_state, level: g.pending_level, raise: true }
  : { state: g.state, level: g.level, raise: false })

export const getGrantRaw = (db, id) => (typeof id === 'string' && id.startsWith('gr_') ? db.prepare(`${RAW} WHERE g.id=?`).get(id) ?? null : null)

// The wire shape, from one party's side. `direction` is 'out' for the
// owner, 'in' for the grantee. `contact_id` is the OWNER's contact row, so
// only the owner's side carries it (it is how "unshare with ct_…" finds the
// grant); the grantee's own contact row id is looked up by the caller when
// it needs one. Nothing here names a conversation or a device.
//
// A raise the owner has not approved yet does not exist for the grantee:
// they read pending_level/pending_state null and no brief. What the owner
// unticked (exclude_media) is the owner's alone.
export function grantRow(row, viewerUserId) {
  if (!row) return null
  const out = row.owner_user_id === viewerUserId
  const hidden = !out && row.pending_state === 'awaiting_owner'
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
    ...(row.subject_kind === 'project' && row.project_num != null
      ? { project: { id: row.subject_id, num: row.project_num, title: row.project_title } } : {}),
    pending_level: hidden ? null : row.pending_level ?? null,
    pending_state: hidden ? null : row.pending_state ?? null,
    ...(row.brief != null && !hidden ? { brief: row.brief } : {}),
    // Who asked for a raise still in flight: the owner's to know.
    ...(out && row.pending_by ? { pending_requested_by: row.pending_by } : {}),
    ...(out && row.exclude_media != null ? { exclude_media: JSON.parse(row.exclude_media) } : {}),
    ...((row.level === 'owner' || row.pending_level === 'owner') && !hidden ? { keep_level: row.keep_level ?? 'read' } : {}),
    ...(row.copy_subject_id ? { copy_id: row.copy_subject_id } : {}),
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
      (SELECT COUNT(*) FROM items i WHERE i.mission_id = @m AND i.consent IS NULL AND i.private = 0 AND ${NOT_PRIVATE('i.origin_convo_id')}) AS items,
      (SELECT COUNT(*) FROM item_comments ic JOIN items i ON i.id = ic.item_id
         WHERE i.mission_id = @m AND i.consent IS NULL AND i.private = 0 AND ic.kind = 'comment' AND ${NOT_PRIVATE('i.origin_convo_id')}) AS comments,
      (SELECT COALESCE(SUM(json_array_length(ic.attachments)), 0) FROM item_comments ic JOIN items i ON i.id = ic.item_id
         WHERE i.mission_id = @m AND i.consent IS NULL AND i.private = 0 AND ${NOT_PRIVATE('i.origin_convo_id')}) AS attachments`).get({ m: missionId })
}

// The shared tail of shareMission and shareProject, inside their
// transaction: find or renew the (subject, contact) row, or raise an
// active one. Returns {grant, existing}.
function upsertAsk(db, { ownerUserId, kind, subjectId, own, level, brief, excludeMedia, keepLevel, by, convoId, deviceId, now }) {
  const cur = db.prepare('SELECT * FROM grants WHERE subject_kind=? AND subject_id=? AND contact_id=?').get(kind, subjectId, own.id)
  // The owner's own offer to a contact on another journal may be offered
  // again while it waits: their answer may never have got back (their
  // journal gives up on it after 7 days), and nothing else would end it.
  const resend = cur?.state === 'pending' && !cur.pending_state && own.peer_journal && by !== 'agent'
  if (cur && !resend && (cur.state === 'awaiting_owner' || cur.state === 'pending' || cur.pending_state)) fail('pending')
  // Asking for what the contact already has, or less, changes nothing.
  if (cur?.state === 'active' && RANK[level] <= RANK[cur.level]) return { grant: getGrantRaw(db, cur.id), existing: true }
  if (by === 'agent' && parkedAsks(db, deviceId) >= MAX_PARKED_PER_DEVICE) fail('too_many_asks')
  const state = by === 'agent' ? 'awaiting_owner' : 'pending'
  const extra = [brief ?? null, excludeMedia ? JSON.stringify(excludeMedia) : null, level === 'owner' && keepLevel === 'contribute' ? 'contribute' : null]
  // A client's hand-over ask is the owner's own yes: what crosses is fixed now.
  const approved = level === 'owner' && state === 'pending'
    ? JSON.stringify(approvedSet(db, { kind, id: subjectId, ownerUserId, excludeMedia: excludeMedia ?? [] })) : null
  if (cur?.state === 'active') {
    // A raise keeps the share's own fields (requested_by, updated_at) as the
    // grantee knows them: its asker and time are pending_by / pending_at,
    // and updated_at moves only once the raise is sent to the grantee.
    db.prepare(`UPDATE grants SET pending_level=?, pending_state=?, pending_by=?, pending_at=?, brief=?, exclude_media=?, keep_level=?, approved=?, origin_convo_id=?, origin_device_id=?,
      owner_item_id=NULL, grantee_item_id=NULL, updated_at=CASE WHEN ?='pending' THEN ? ELSE updated_at END WHERE id=?`)
      .run(level, state, by, now, ...extra, approved, convoId, deviceId, state, now, cur.id)
    return { grant: getGrantRaw(db, cur.id), existing: false }
  }
  let id = cur?.id
  if (cur) {
    // A renewed row is a new ask: whatever the grantee saw of the old one,
    // this one is theirs to see only once it is sent (sent_at).
    db.prepare(`UPDATE grants SET level=?, state=?, brief=?, exclude_media=?, keep_level=?, approved=?, copy_subject_id=NULL, pending_level=NULL, pending_state=NULL,
      pending_by=NULL, pending_at=NULL, sent_at=?, requested_by=?, origin_convo_id=?, origin_device_id=?, owner_item_id=NULL, grantee_item_id=NULL,
      revoked_by=NULL, updated_at=?, answered_at=NULL, revoked_at=NULL WHERE id=?`).run(level, state, ...extra, approved, state === 'pending' ? now : null, by, convoId, deviceId, now, cur.id)
  } else {
    id = newId('gr')
    db.prepare(`INSERT INTO grants(id,owner_user_id,subject_kind,subject_id,contact_id,level,state,requested_by,origin_convo_id,origin_device_id,brief,exclude_media,keep_level,approved,sent_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, ownerUserId, kind, subjectId, own.id, level, state, by, convoId, deviceId, ...extra, approved, state === 'pending' ? now : null, now, now)
  }
  return { grant: getGrantRaw(db, id), existing: false }
}

// `by` as in requestContact. `contact` is the owner's contact row id, or a
// same-journal peer's name. `level` 'read', 'contribute' or 'owner' (a hand-over, which
// needs `brief`; `excludeMedia` is the owner's own unticking, from a client;
// `keepLevel` 'contribute' keeps the owner contributing to the copy).
// Throws: bad_level, no_brief, no_mission, private_mission, handed_over,
// mission_closed, not_contact, pending, too_many_asks.
// Returns {grant, existing} — existing:true is an already-active grant at
// that level or above, returned unchanged (sharing twice is not an error).
// `federate(what, grant)` queues what a grant for a contact on another
// journal sends ('offer', 'revoke'), inside the same transaction
// (src/federation-grants.js); null while federation is off.
export function shareMission(db, { ownerUserId, missionId, contact, level, brief = null, excludeMedia = null, keepLevel = null, by, convoId = null, deviceId = null, federate = null, now = Date.now() }) {
  return db.transaction(() => {
    if (!GRANT_LEVELS.includes(level)) fail('bad_level')
    if (level === 'owner' && !brief) fail('no_brief')
    const mission = db.prepare(`SELECT m.id, (${ORIGIN_SIEVE}) AS shareable FROM missions m WHERE m.id=? AND m.user_id=?`).get(missionId, ownerUserId)
    if (!mission) fail('no_mission')
    // A mission born on a private box stays the owner's alone: the grantee's
    // view is the ordinary-agent view, and that view has no such mission.
    if (!mission.shareable) fail('private_mission')
    if (level === 'owner') checkHandoverAsk(db, { kind: 'mission', id: mission.id, ownerUserId })
    const own = getContactRaw(db, ownerUserId, contact)
    if (!own) fail('not_contact')
    if (own.peer_journal) {
      // A contact on another journal: a read or contribute share crosses
      // (a hand-over does not yet), and only while this journal federates
      // (`federate` sends the offer).
      if (!isLiveRemote(db, own)) fail('not_contact')
      if (level === 'owner') fail('level_unavailable')
      if (!federate) fail('federation_off')
    } else if (!isMutual(db, own)) fail('not_contact')
    const out = upsertAsk(db, { ownerUserId, kind: 'mission', subjectId: mission.id, own, level, brief: level === 'owner' ? brief : null, excludeMedia, keepLevel, by, convoId, deviceId, now })
    // A new ask, or a raise of an active share, that is the grantee's to
    // answer now (an agent's waits for the owner's yes first).
    if (own.peer_journal && !out.existing && askOf(out.grant).state === 'pending') federate('offer', out.grant)
    return out
  })()
}

// A project is only ever handed over: `owner` level, with its open
// missions. Throws as shareMission, plus no_project, project_closed and
// empty_project.
export function shareProject(db, { ownerUserId, projectId, contact, level, brief = null, excludeMedia = null, keepLevel = null, by, convoId = null, deviceId = null, now = Date.now() }) {
  return db.transaction(() => {
    if (!GRANT_LEVELS.includes(level)) fail('bad_level')
    if (level !== 'owner') fail('level_unavailable')
    if (!brief) fail('no_brief')
    if (!subjectProject(db, ownerUserId, projectId)) fail('no_project')
    checkHandoverAsk(db, { kind: 'project', id: projectId, ownerUserId })
    const own = getContactRaw(db, ownerUserId, contact)
    if (!own) fail('not_contact')
    // Hand-overs across journals are not built yet.
    if (own.peer_journal) fail(isLiveRemote(db, own) ? 'level_unavailable' : 'not_contact')
    if (!isMutual(db, own)) fail('not_contact')
    return upsertAsk(db, { ownerUserId, kind: 'project', subjectId: projectId, own, level, brief, excludeMedia, keepLevel, by, convoId, deviceId, now })
  })()
}

const setState = (db, id, state, now, extra = '') =>
  db.prepare(`UPDATE grants SET state=?, updated_at=? ${extra} WHERE id=?`).run(state, now, id)

// Moves the ask a row carries: its own state, or its pending raise.
// Sending an ask to the grantee (state or raise → pending) stamps the row
// sent: from then on they may read it, whatever becomes of it.
function setAsk(db, g, state, now, extra = '') {
  if (g.pending_state) db.prepare(`UPDATE grants SET pending_state=?, pending_at=?, updated_at=? WHERE id=?`).run(state, now, now, g.id)
  else setState(db, g.id, state, now, `${extra}${state === 'pending' ? `, sent_at=${Number(now)}` : ''}`)
}
// A raise that ends without happening leaves the row as it was — to the
// grantee, exactly as it was when it was never sent (updated_at untouched).
const dropRaise = (db, g, now) => db.prepare(`UPDATE grants SET pending_level=NULL, pending_state=NULL, pending_by=NULL, pending_at=NULL, brief=NULL, exclude_media=NULL, keep_level=NULL, approved=NULL,
  updated_at=CASE WHEN ?='awaiting_owner' THEN updated_at ELSE ? END WHERE id=?`).run(g.pending_state, now, g.id)
// The time an ask was made: a raise's own, else the row's.
const askedAt = (g) => (g.pending_state ? g.pending_at ?? g.updated_at : g.updated_at)
// An ask that ends before its owner said yes was never sent (sent_at is
// null), so the grantee never sees the row at all; its brief goes too.
// Every path that ends an ask still awaiting the owner forgets it this way
// (an approval refused here, a withdrawal, an expiry, a revoke — and, in
// contacts.js and handover.js, a removed contact and a hand-over that
// overtook it).
const forgetBrief = (db, id) => db.prepare('UPDATE grants SET brief=NULL, exclude_media=NULL, keep_level=NULL, approved=NULL WHERE id=?').run(id)

// null when the hand-over `g` asks for can still happen, else the reason it
// cannot (one of HANDOVER_REFUSALS).
function stillPossible(db, g) {
  try { checkHandoverStill(db, g); return null } catch (err) {
    if (HANDOVER_REFUSALS.has(err.message)) return err.message
    throw err
  }
}
// A hand-over that can no longer happen: it expires (a raise just drops).
// Refused at the owner's approval, it was never sent: the row stays hidden
// from the recipient (sent_at null) and its brief goes too. Refused at the
// accept, the recipient has already read it.
function endAsk(db, g, ask, now) {
  if (ask.raise) dropRaise(db, g, now)
  else {
    setState(db, g.id, 'expired', now)
    if (ask.state === 'awaiting_owner') forgetBrief(db, g.id)
  }
}

// One party's answer to one of the two cards. null = not a grant of
// theirs (the owner's or the grantee's). Outcomes: 'sent' (owner approved:
// now pending with the grantee), 'withdrawn' (owner declined own agent's
// ask), 'expired', 'unavailable' (approved, but the two are no longer
// contacts — the row is revoked, or a raise dropped), 'accepted' |
// 'declined' (the grantee), 'refused' (a hand-over that can no longer
// happen, with `reason`: the ask has ended). An accepted hand-over is 'handed_over', with
// `handover` (what applyHandover did); `files` collects the blob files it
// wrote, and is cleaned up here if the transaction rolls back.
// `excludeMedia` and `keepLevel` (the owner's approval of a hand-over)
// replace the ask's.
export function answerGrant(db, { userId, grantId, decision, excludeMedia, keepLevel, federate = null, now = Date.now() }) {
  const files = []
  try {
    return db.transaction(() => {
      const g = getGrantRaw(db, grantId)
      if (!g || (g.owner_user_id !== userId && g.grantee_user_id !== userId)) return null
      const isOwner = g.owner_user_id === userId
      const ask = askOf(g)
      // The grantee has never been told of an ask its owner has not approved
      // (or of a row that was never sent to them at all).
      if (!isOwner && (ask.state === 'awaiting_owner' || g.sent_at == null)) return null
      const done = (outcome, extra = {}) => ({ outcome, grant: getGrantRaw(db, g.id), before: g, ...extra })
      const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(g.contact_id)
      if (isOwner && ask.state === 'awaiting_owner') {
        if (now - askedAt(g) > OWN_ASK_TTL_MS) {
          if (ask.raise) dropRaise(db, g, now); else { setState(db, g.id, 'expired', now); forgetBrief(db, g.id) }
          return done('expired')
        }
        if (decision === 'decline') {
          if (ask.raise) dropRaise(db, g, now); else { setState(db, g.id, 'declined', now, `, answered_at=${Number(now)}`); forgetBrief(db, g.id) }
          return done('withdrawn')
        }
        if (contact.peer_journal ? !isLiveRemote(db, contact) || !federate : !isMutual(db, contact)) {
          if (ask.raise) dropRaise(db, g, now)
          else { setState(db, g.id, 'revoked', now, `, revoked_by='contact_removed', revoked_at=${Number(now)}`); forgetBrief(db, g.id) }
          return done('unavailable')
        }
        if (ask.level === 'owner') {
          // The subject may have changed since the agent asked: approving
          // something that can no longer be handed over ends the ask.
          const refused = stillPossible(db, g)
          if (refused) { endAsk(db, g, ask, now); return done('refused', { reason: refused }) }
          if (excludeMedia !== undefined) db.prepare('UPDATE grants SET exclude_media=? WHERE id=?').run(JSON.stringify(excludeMedia), g.id)
          if (keepLevel !== undefined) db.prepare('UPDATE grants SET keep_level=? WHERE id=?').run(keepLevel === 'contribute' ? 'contribute' : null, g.id)
          // What the owner approved is fixed now; the accept copies it or
          // nothing (sameApprovedSet).
          const set = approvedSet(db, { kind: g.subject_kind, id: g.subject_id, ownerUserId: g.owner_user_id, excludeMedia: excludeMedia ?? JSON.parse(g.exclude_media ?? '[]') })
          db.prepare('UPDATE grants SET approved=? WHERE id=?').run(JSON.stringify(set), g.id)
        }
        setAsk(db, g, 'pending', now)
        if (contact.peer_journal) federate('offer', getGrantRaw(db, g.id))
        return done('sent')
      }
      if (!isOwner && ask.state === 'pending') {
        if (decision === 'decline') {
          if (ask.raise) dropRaise(db, g, now); else setState(db, g.id, 'declined', now, `, answered_at=${Number(now)}`)
          return done('declined')
        }
        if (!isMutual(db, contact)) fail('not_pending')
        if (ask.level === 'owner') {
          const refused = stillPossible(db, g) ?? (sameApprovedSet(db, g) ? null : 'handover_changed')
          if (refused) { endAsk(db, g, ask, now); return done('refused', { reason: refused }) }
          const handover = applyHandover(db, { g: getGrantRaw(db, g.id), files, now })
          return done('handed_over', { handover })
        }
        if (ask.raise) db.prepare(`UPDATE grants SET level=pending_level, pending_level=NULL, pending_state=NULL, pending_by=NULL, pending_at=NULL, answered_at=?, updated_at=? WHERE id=?`).run(now, now, g.id)
        else setState(db, g.id, 'active', now, `, answered_at=${Number(now)}`)
        return done('accepted')
      }
      fail('not_pending')
    })()
  } catch (err) {
    for (const f of files) { try { fs.unlinkSync(f) } catch { /* already gone */ } }
    throw err
  }
}

// Either side ends a grant that is, or may still become, live. For the
// grantee a row still awaiting the OWNER's approval does not exist yet
// (they have never been told of it): same null as an unknown id.
export function revokeGrant(db, { userId, grantId, federate = null, now = Date.now() }) {
  return db.transaction(() => {
    const g = getGrantRaw(db, grantId)
    if (!g || (g.owner_user_id !== userId && g.grantee_user_id !== userId)) return null
    const isOwner = g.owner_user_id === userId
    if (!isOwner && g.sent_at == null) return null
    if (!['awaiting_owner', 'pending', 'active'].includes(g.state)) fail('not_active')
    // A hand-over that happened is not undone by revoking its record.
    if (g.level === 'owner' && g.state === 'active') fail('handed_over')
    setState(db, g.id, 'revoked', now, `, revoked_by='${isOwner ? 'owner' : 'grantee'}', revoked_at=${Number(now)}, pending_level=NULL, pending_state=NULL, pending_by=NULL, pending_at=NULL`)
    if (askOf(g).state === 'awaiting_owner') forgetBrief(db, g.id)
    // Their journal knows of every grant sent to it, and is told it ended.
    if (g.grantee_journal && g.sent_at != null) federate?.('revoke', g)
    return { grant: getGrantRaw(db, g.id), before: g, by: isOwner ? 'owner' : 'grantee' }
  })()
}

// direction 'out' = grants I gave, 'in' = grants given to me — only rows
// ever sent to me (sent_at): never one still waiting for its owner's
// approval, nor one that ended before the owner approved it. Ended rows
// are listed only when a state is named.
export function listGrants(db, userId, { direction = null, missionId = null, projectId = null, state = null } = {}) {
  const where = []; const args = { u: userId }
  if (direction === 'out') where.push('g.owner_user_id = @u')
  else if (direction === 'in') where.push('oc.peer_user_id = @u AND oc.peer_journal IS NULL AND g.sent_at IS NOT NULL')
  else where.push('(g.owner_user_id = @u OR (oc.peer_user_id = @u AND oc.peer_journal IS NULL AND g.sent_at IS NOT NULL))')
  if (missionId) { where.push("g.subject_kind = 'mission' AND g.subject_id = @m"); args.m = missionId }
  if (projectId) { where.push("g.subject_kind = 'project' AND g.subject_id = @p"); args.p = projectId }
  if (state) { where.push('g.state = @s'); args.s = state } else where.push(`g.state IN ${LIVE_GRANT_STATES}`)
  return db.prepare(`${RAW} WHERE ${where.join(' AND ')} ORDER BY g.updated_at DESC`).all(args).map((r) => grantRow(r, userId))
}

// Active grantees of one mission, for the live frame: user ids only.
export function activeGranteeIds(db, missionId) {
  return db.prepare(`SELECT DISTINCT oc.peer_user_id AS id FROM grants g
    JOIN contacts oc ON oc.id = g.contact_id AND oc.state = 'active' AND oc.peer_journal IS NULL
    JOIN contacts vc ON vc.user_id = oc.peer_user_id AND vc.peer_user_id = oc.user_id AND vc.peer_journal IS NULL AND vc.state = 'active'
    WHERE g.subject_kind = 'mission' AND g.subject_id = ? AND g.state = 'active' AND g.level <> 'owner'`).all(missionId).map((r) => r.id)
}

// A raise that expires just drops; the row stays as it was.
export function expireGrantAsks(db, now = Date.now()) {
  return db.transaction(() => {
    const rows = db.prepare(`${RAW} WHERE ((g.state='awaiting_owner' AND g.updated_at < @t) OR (g.pending_state='awaiting_owner' AND COALESCE(g.pending_at, g.updated_at) < @t))`).all({ t: now - OWN_ASK_TTL_MS })
    for (const r of rows) { if (r.pending_state) dropRaise(db, r, now); else { setState(db, r.id, 'expired', now); forgetBrief(db, r.id) } }
    return rows
  })()
}

// The sent_at backfill lives in db.js (its migration runs it); re-exported
// here beside the rule it serves.
export { backfillGrantSent } from './db.js'

export function setGrantItem(db, grantId, side, itemId) {
  db.prepare(`UPDATE grants SET ${side === 'owner' ? 'owner_item_id' : 'grantee_item_id'}=? WHERE id=?`).run(itemId, grantId)
}

// --- A grantee on another journal (src/federation-grants.js) -----------------

// The owner's grant `grantId` given to the remote `address` (name@host),
// pinned to `key`: the only grants a remote grantee can act on. null
// otherwise.
function remoteGrant(db, { ownerUserId, grantId, address, key }) {
  const g = getGrantRaw(db, grantId)
  if (!g || g.owner_user_id !== ownerUserId || !g.grantee_journal || g.subject_kind !== 'mission') return null
  if (`${g.grantee_name}@${g.grantee_journal}` !== address) return null
  const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(g.contact_id)
  if (!contact || contact.peer_journal_key !== key || g.sent_at == null) return null
  return { g, contact }
}

// An answer naming an earlier sending of a still-pending offer (`sent`, the
// offer's sent_at as their journal last heard it) crossed the owner's offer
// again: their journal has reopened the offer, so a decline or leave of the
// earlier one is stale. An accept never is (their journal keeps it).
const staleFor = (g, sent) => g.state === 'pending' && Number.isSafeInteger(sent) && sent !== g.sent_at

// Their answer to an offer, arriving from their journal. Outcomes as
// answerGrant ('accepted' | 'declined'); answering what is already so again,
// or a stale decline, is 'same'. Errors: not_pending (withdrawn, ended, or
// not theirs).
//
// `raise` names the level of a raise they answered (a read share offered to
// contribute): it moves only the raise, the share standing either way. An
// answer for a raise that is no longer waiting (answered already) is 'same'.
export function answerRemoteGrant(db, { ownerUserId, grantId, address, key, decision, sent = null, raise = null, now = Date.now() }) {
  return db.transaction(() => {
    const hit = remoteGrant(db, { ownerUserId, grantId, address, key })
    if (!hit) fail('not_pending')
    const { g, contact } = hit
    const done = (outcome) => ({ outcome, grant: getGrantRaw(db, g.id), before: g })
    if (raise != null) {
      if (g.state !== 'active') fail('not_pending')
      if (g.pending_state !== 'pending' || g.pending_level !== raise) {
        if (decision === 'decline' || g.level === raise) return done('same')
        fail('not_pending')
      }
      if (!isLiveRemote(db, contact)) fail('not_pending')
      if (decision === 'decline') dropRaise(db, g, now)
      else db.prepare(`UPDATE grants SET level=pending_level, pending_level=NULL, pending_state=NULL, pending_by=NULL, pending_at=NULL, answered_at=?, updated_at=? WHERE id=?`).run(now, now, g.id)
      return done(decision === 'decline' ? 'declined' : 'accepted')
    }
    if (g.state === (decision === 'decline' ? 'declined' : 'active') && !g.pending_state) return done('same')
    if (decision === 'decline' && staleFor(g, sent)) return done('same')
    if (g.state !== 'pending' || !isLiveRemote(db, contact)) fail('not_pending')
    if (decision === 'decline') setState(db, g.id, 'declined', now, `, answered_at=${Number(now)}`)
    else setState(db, g.id, 'active', now, `, answered_at=${Number(now)}`)
    return done(decision === 'decline' ? 'declined' : 'accepted')
  })()
}

// They ended a share from their side. null = nothing live to end (the
// answer is the same: it is over here too).
export function leaveRemoteGrant(db, { ownerUserId, grantId, address, key, sent = null, now = Date.now() }) {
  return db.transaction(() => {
    const hit = remoteGrant(db, { ownerUserId, grantId, address, key })
    if (!hit || !['pending', 'active'].includes(hit.g.state) || staleFor(hit.g, sent)) return null
    setState(db, hit.g.id, 'revoked', now, `, revoked_by='grantee', revoked_at=${Number(now)}, pending_level=NULL, pending_state=NULL, pending_by=NULL, pending_at=NULL`)
    return { grant: getGrantRaw(db, hit.g.id), before: hit.g, by: 'grantee' }
  })()
}
