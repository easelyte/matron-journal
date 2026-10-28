// Contributors (spec 2026-10-02 matron-to-matron sharing, "Grants":
// contribute). A contact granted a mission at `contribute` writes into it:
// milestones, items, comments, an item's open/closed state and the
// mission's status. Pure DB state; src/contribute-http.js owns the routes
// and the side effects.
//
// Every write lands in the OWNER's log, under the owner's numbering, and is
// attributed in words (contributor {name, via}) — never as the owner's own:
// the rows are `created_by`/`author` 'agent' with device 0 whoever wrote
// them, so nothing a contributor wrote reads as the owner's words, and no
// conversation or device of the contributor's is stored where the owner can
// read it. What a contributor writes hangs off the owner's People
// conversation (src/people-convo.js), which no agent of the owner's reads;
// an item reply reaches the owner's agent only as a turn marked as another
// person's (contribute-http.js). The one thing of the contributor's that is
// kept is where the owner's replies to an item they filed go — the filing
// conversation in their own log (items.contributor_convo_id) — and it never
// leaves this module and contribute-http.js.
//
// Never: renaming, closing or re-sharing the mission, moving, reranking or
// editing items, action buttons (offering or tapping), attachments, and
// consent mirrors (which a grantee cannot even see).
import { createItem, insertComment, closeItem, reopenItem, nextNum, newId } from './items.js'
import { updateMission, getGrantedMission } from './missions.js'
import { missionAccess } from './visibility.js'
import { ensurePeopleConvo } from './people-convo.js'

export const CONTRIBUTE_KINDS = ['task', 'question', 'decision']

const fail = (code) => { throw new Error(code) }

// Who is writing, as the owner reads it.
export const contributorOf = (db, who) => ({
  userId: who.userId,
  name: db.prepare('SELECT name FROM users WHERE id=?').get(who.userId)?.name ?? `user ${who.userId}`,
  via: who.kind === 'agent' ? 'agent' : 'user',
})
export const attributionOf = (c) => (c.via === 'agent' ? `${c.name}'s agent` : c.name)
const metaOf = (c) => ({ contributor: { name: c.name, via: c.via }, attribution: attributionOf(c) })

// The owner's mission row, when `viewerUserId` may contribute to it. Throws
// read_only for a read grant; null when it is not shared with them at all.
export function contributableMission(db, viewerUserId, missionId) {
  if (typeof missionId !== 'string' || !missionId.startsWith('ms_')) return null
  // Only what the grantee can read is theirs to write to: the grant rule
  // and the origin sieve (a mission whose box has since turned private is
  // no longer shared).
  if (!getGrantedMission(db, viewerUserId, missionId)) return null
  const level = missionAccess(db, viewerUserId, missionId)
  if (level == null || level === 'owner') return null
  const m = db.prepare('SELECT * FROM missions WHERE id=?').get(missionId)
  if (!m || m.user_id === viewerUserId) return null
  if (level !== 'contribute') fail('read_only')
  return m
}

const openMission = (m) => { if (m.state !== 'open') fail('closed') }

// The mission row as it is NOW, for a write inside its own transaction: the
// route checked before reading the body, and the share may have ended (or
// the mission closed) while it arrived. Error('gone') when the contributor
// no longer may; the fresh row otherwise, so the write sees current state.
function stillContributesTo(db, contributor, mission) {
  let m
  try { m = contributableMission(db, contributor.userId, mission.id) } catch { m = null }
  if (!m) fail('gone')
  openMission(m)
  return m
}

// A milestone, anchored on a marker in the owner's People conversation:
// `appendMarker(convoId, payload)` runs inside this transaction (as in
// createMilestone) and its seq is the row's anchor. Returns {milestone,
// convoId, seq, ts}.
export function contributeMilestone(db, { mission, contributor, kind, title, body = '', appendMarker, now = Date.now() }) {
  return db.transaction(() => {
    mission = stillContributesTo(db, contributor, mission)
    const people = ensurePeopleConvo(db, mission.user_id, now)
    const id = newId('ml')
    const num = nextNum(db, mission.user_id)
    const row = { id, num, kind, title, body }
    const r = appendMarker(people.id, row)
    db.prepare(`INSERT INTO milestones(id,mission_id,user_id,num,kind,title,body,convo_id,seq,device_id,created_by,created_at,contributor_name,contributor_via)
      VALUES(?,?,?,?,?,?,?,?,?,0,'agent',?,?,?)`).run(id, mission.id, mission.user_id, num, kind, title, body, people.id, r.seq, now, contributor.name, contributor.via)
    db.prepare('UPDATE missions SET last_milestone_at=?, updated_at=? WHERE id=?').run(now, now, mission.id)
    return { milestone: db.prepare('SELECT * FROM milestones WHERE id=?').get(id), convoId: people.id, seq: r.seq, ts: r.ts, peopleCreated: people.created }
  })()
}

// An item in the owner's log, on the mission. `replyConvoId` is the
// contributor's own conversation the owner's replies go to (null for a
// contributor's phone, which has none). Returns the owner-side item id.
export function contributeItem(db, { mission, contributor, replyConvoId = null, kind, title, body = '', labels = [], links = [], now = Date.now() }) {
  return db.transaction(() => {
    mission = stillContributesTo(db, contributor, mission)
    const people = ensurePeopleConvo(db, mission.user_id, now)
    const { item } = createItem(db, {
      userId: mission.user_id, kind, title, body, labels, links, originConvoId: people.id, originDeviceId: 0, createdBy: 'agent', now,
    })
    db.prepare(`UPDATE items SET mission_id=?, contributor_user_id=?, contributor_convo_id=?, contributor_name=?, contributor_via=? WHERE id=?`)
      .run(mission.id, contributor.userId, replyConvoId, contributor.name, contributor.via, item.id)
    return { itemId: item.id, peopleConvo: people }
  })()
}

// The owner-side item row a contributor may write to: on a mission they
// contribute to, not a consent mirror. null otherwise.
export function contributableItem(db, viewerUserId, itemId) {
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(itemId)
  // An owner-only item (`private`, db.js) is the owner's alone: a
  // contributor neither reads nor writes it.
  if (!it || it.consent != null || it.private || !it.mission_id || it.user_id === viewerUserId) return null
  try { return contributableMission(db, viewerUserId, it.mission_id) ? it : null } catch { return null }
}

// The writes below re-check, inside their own transaction, that the writer
// still contributes: the route checked before reading the body, and a share
// may have ended while it arrived. Error('gone') if not.
const stillContributes = (db, contributor, item) => { if (!contributableItem(db, contributor.userId, item.id)) fail('gone') }

// A comment: words only — no buttons, no taps, no files. It does not move
// the item's status (the owner's turn hears it either way).
export function contributeComment(db, { item, contributor, body, now = Date.now() }) {
  return db.transaction(() => {
    stillContributes(db, contributor, item)
    const comment = insertComment(db, { itemId: item.id, userId: item.user_id, author: 'agent', deviceId: 0, kind: 'comment', body, attachments: [], meta: metaOf(contributor), idemKey: null, now })
    db.prepare('UPDATE items SET updated_at=? WHERE id=?').run(now, item.id)
    return comment
  })()
}

export function contributeClose(db, { item, contributor, resolution, comment = '', now = Date.now() }) {
  return db.transaction(() => {
    stillContributes(db, contributor, item)
    return closeItem(db, { userId: item.user_id, itemId: item.id, resolution, author: 'agent', deviceId: 0, comment, meta: metaOf(contributor), now })
  })()
}

export function contributeReopen(db, { item, contributor, comment = '', now = Date.now() }) {
  return db.transaction(() => {
    stillContributes(db, contributor, item)
    return reopenItem(db, { userId: item.user_id, itemId: item.id, author: 'agent', deviceId: 0, comment, meta: metaOf(contributor), now })
  })()
}

// The mission's status, by the contributor: written like an agent's with no
// conversation named, plus their name. null clears it.
export function contributeStatus(db, { mission, contributor, status }) {
  return db.transaction(() => {
    let still = null
    try { still = contributableMission(db, contributor.userId, mission.id) } catch { /* read only now */ }
    if (!still) fail('gone')
    return updateMission(db, {
      userId: mission.user_id, missionId: mission.id, fields: { status },
      statusWriter: { by: 'agent', convoId: null, deviceId: null, contributor: contributor.name },
    })
  })()
}
