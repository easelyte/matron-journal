// Hand-over (spec 2026-10-02 matron-to-matron sharing, "Hand-over"): an
// owner gives a mission, or a project with its open missions, to a contact.
// Pure DB state, like src/grants.js, which calls in here: what a hand-over
// would carry (the card's preview) and the one transaction that carries it
// out when the recipient accepts. No hub, cards or audit events here —
// src/sharing-events.js announces what applyHandover returns.
//
// A hand-over COPIES. Even on one journal the recipient gets new rows in
// their own log, under their own numbering, so a later hand-over between
// journals takes the same path; the original is closed, not moved. What
// crosses is the tracker record as an ordinary agent of the owner would see
// it — milestones and items from a private box, consent mirrors and a
// privately written status stay behind — with nothing that names one of the
// owner's conversations or devices: copied rows hang off the recipient's
// People conversation (src/people-convo.js), with device 0 and no marker.
// Milestones therefore cross as text (their jump target is a transcript
// that does not cross), and every copied comment is the agent's, attributed
// in words ("alice", "alice's agent"), so nothing the owner wrote reads as
// the recipient's own words.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { newId, nextNum, resolveRank, closeItem } from './items.js'
import { ORIGIN_SIEVE, statusPrivateSql, leaveMission } from './missions.js'
import { PROJECT_ORIGIN_SIEVE } from './projects.js'
import { insertDefaultProject } from './default-project.js'
import { ensurePeopleConvo } from './people-convo.js'
import { shardedPath } from './media.js'
import { INLINE_REF_RE } from './inline-refs.js'

export const BRIEF_MAX = 16000
// The owner's unticked attachments: a list of media ids, bounded so a
// request cannot make the row arbitrarily large.
export const EXCLUDE_MEDIA_MAX = 1000

const fail = (code) => { throw new Error(code) }
const parseJson = (s, fallback) => { try { return JSON.parse(s) } catch { return fallback } }
const PRIVATE_CONVO = (col) => `EXISTS (SELECT 1 FROM conversations pc JOIN private_devices pd ON pd.id = pc.agent_device_id WHERE pc.id = ${col})`

// A brief is required for a hand-over: trimmed, 1..BRIEF_MAX characters.
// null = not a valid brief.
export function validBrief(v) {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s && s.length <= BRIEF_MAX ? s : null
}

// What the owner keeps on the copy after a hand-over: undefined = absent,
// null = malformed.
export function validKeepLevel(v) {
  if (v === undefined) return undefined
  return v === 'read' || v === 'contribute' ? v : null
}

// undefined = absent, null = malformed, else the de-duplicated ids.
export function validExcludeMedia(v) {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.length > EXCLUDE_MEDIA_MAX) return null
  if (!v.every((x) => typeof x === 'string' && x && x.length <= 128)) return null
  return [...new Set(v)]
}

// The missions a hand-over of this subject carries: the mission itself, or
// a project's OPEN missions. Each row carries `status_hidden`, the private
// sieve's verdict on its status.
function subjectMissions(db, { kind, id, ownerUserId }) {
  const cols = `m.*, ${statusPrivateSql('m')} AS status_hidden, (${ORIGIN_SIEVE}) AS shareable`
  if (kind === 'mission') return db.prepare(`SELECT ${cols} FROM missions m WHERE m.id=? AND m.user_id=?`).all(id, ownerUserId)
  return db.prepare(`SELECT ${cols} FROM missions m WHERE m.project_id=? AND m.user_id=? AND m.state='open' ORDER BY m.num`).all(id, ownerUserId)
}

// The project row a project hand-over is about, with the same two sieve
// verdicts. null when it is not the owner's.
export function subjectProject(db, ownerUserId, projectId) {
  return db.prepare(`SELECT p.*, ${statusPrivateSql('p')} AS status_hidden, ${PROJECT_ORIGIN_SIEVE} AS shareable
    FROM projects p WHERE p.id=? AND p.user_id=?`).get(projectId, ownerUserId) ?? null
}

// Whether this subject can be handed over now. Throws the refusal the
// routes name: private_mission, mission_closed, project_closed,
// empty_project. Used when the ask is made and again on accept.
export function checkHandoverSubject(db, { kind, id, ownerUserId }) {
  if (kind === 'project') {
    const p = subjectProject(db, ownerUserId, id)
    if (!p) fail('no_project')
    if (!p.shareable) fail('private_mission')
    if (p.state === 'closed') fail('project_closed')
  }
  const missions = subjectMissions(db, { kind, id, ownerUserId })
  if (!missions.length) fail(kind === 'project' ? 'empty_project' : 'no_mission')
  // A project with a private-born mission in it is refused whole: leaving
  // that mission behind in a closed project would strand it.
  if (missions.some((m) => !m.shareable)) fail('private_mission')
  if (missions.some((m) => m.state !== 'open')) fail('mission_closed')
  return missions
}

// The refusals an ask, an approval or an accept may meet.
export const HANDOVER_REFUSALS = new Set(['private_mission', 'mission_closed', 'project_closed', 'empty_project', 'handed_over', 'pending', 'handover_changed'])

// A hand-over of this subject other than `excludeId`: an ask in flight (to
// anyone), or one already accepted.
const handoverOf = (db, kind, id, excludeId = '') => db.prepare(`SELECT state, pending_state FROM grants WHERE subject_kind=? AND subject_id=? AND id<>?
  AND (level='owner' OR pending_level='owner') AND (state IN ('awaiting_owner','pending') OR pending_state IS NOT NULL OR (level='owner' AND state='active'))
  ORDER BY (level='owner' AND state='active') DESC LIMIT 1`).get(kind, id, excludeId)
const isAccepted = (h) => h.state === 'active' && !h.pending_state

// Is a hand-over of this mission or project in flight — of it, of the
// project a mission is in, or of a mission in a project? What refiling a
// mission must not change under an ask (missions-http.js).
export function handoverInFlight(db, kind, id) {
  const h = handoverOf(db, kind, id)
  return !!h && !isAccepted(h)
}

// A hand-over's own refusals: the subject is already handed over, or no
// longer can be (checkHandoverSubject), or another hand-over of it — of the
// project a mission is in, or of a mission in the project, too: one accept
// would strand the other — is in flight. `selfId` is the ask being checked
// again (at its approval or its accept), which is not "another".
export function checkHandoverAsk(db, { kind, id, ownerUserId, selfId = '' }) {
  const live = handoverOf(db, kind, id, selfId)
  if (live && isAccepted(live)) fail('handed_over')
  const missions = checkHandoverSubject(db, { kind, id, ownerUserId })
  if (live) fail('pending')
  const asked = (k, sid) => { const h = handoverOf(db, k, sid, selfId); return h && !isAccepted(h) }
  if (kind === 'mission' && missions[0].project_id && asked('project', missions[0].project_id)) fail('pending')
  if (kind === 'project' && missions.some((m) => asked('mission', m.id))) fail('pending')
  return missions
}
export const checkHandoverStill = (db, g) => checkHandoverAsk(db, { kind: g.subject_kind, id: g.subject_id, ownerUserId: g.owner_user_id, selfId: g.id })

// What the owner says yes to: the missions that would cross and the files
// that would be copied, by id. Fixed on the grant at the approval (or at a
// client's own ask); the accept copies exactly this or nothing.
export function approvedSet(db, { kind, id, ownerUserId, excludeMedia = [] }) {
  const exclude = new Set(excludeMedia)
  const p = handoverPreview(db, { kind, id, ownerUserId })
  return {
    missions: subjectMissions(db, { kind, id, ownerUserId }).map((m) => m.id).sort(),
    attachments: p.attachments.map((a) => a.media_id).filter((x) => !exclude.has(x)).sort(),
  }
}
export function sameApprovedSet(db, g) {
  if (!g.approved) return false
  const was = JSON.parse(g.approved)
  const now = approvedSet(db, { kind: g.subject_kind, id: g.subject_id, ownerUserId: g.owner_user_id, excludeMedia: JSON.parse(g.exclude_media ?? '[]') })
  return JSON.stringify(was) === JSON.stringify(now)
}

// What crosses for one mission, through the private sieve. Comments are
// every row of each item's thread (the item body's attachment row included)
// except the item-handover lines, which name the owner's conversations, and
// replies the user withdrew.
function missionContents(db, missionId) {
  const milestones = db.prepare(`SELECT * FROM milestones l WHERE l.mission_id=? AND NOT ${PRIVATE_CONVO('l.convo_id')}
    ORDER BY l.created_at, l.seq`).all(missionId)
  // Owner-only items (`private`, db.js) stay with the owner: never copied.
  const items = db.prepare(`SELECT * FROM items i WHERE i.mission_id=? AND i.consent IS NULL AND i.private = 0 AND NOT ${PRIVATE_CONVO('i.origin_convo_id')}
    ORDER BY i.num`).all(missionId)
  const comments = db.prepare('SELECT * FROM item_comments WHERE item_id=? ORDER BY created_at, rowid')
  // A reply the user withdrew (src/withdrawn-comments.js) never crosses.
  for (const it of items) it.comments = comments.all(it.id).filter((c) => !parseJson(c.meta, null)?.handover && c.withdrawn_at == null)
  return { milestones, items }
}

// Attachments that can actually be copied: a live blob of the owner's.
const liveBlob = (db, ownerUserId, id) => db.prepare('SELECT * FROM blobs WHERE id=? AND owner_user_id=?').get(id, ownerUserId)

// The card's preview. `attachments` lists each copyable file once (the
// first item it is on), for the owner to untick.
export function handoverPreview(db, { kind, id, ownerUserId }) {
  const missions = subjectMissions(db, { kind, id, ownerUserId })
  const out = { missions: missions.length, milestones: 0, items: 0, comments: 0, attachments: [] }
  const seen = new Set()
  for (const m of missions) {
    const c = missionContents(db, m.id)
    out.milestones += c.milestones.length
    out.items += c.items.length
    for (const it of c.items) {
      for (const cm of it.comments) {
        if (cm.kind === 'comment') out.comments++
        for (const a of parseJson(cm.attachments, [])) {
          if (!a?.blob_ref || a.expired || seen.has(a.blob_ref) || !liveBlob(db, ownerUserId, a.blob_ref)) continue
          seen.add(a.blob_ref)
          out.attachments.push({ media_id: a.blob_ref, name: a.name ?? '', mime: a.mime ?? '', size: a.size ?? 0, item_num: it.num })
        }
      }
    }
  }
  return out
}

// A copy of one blob for the recipient: a new file beside the original
// (same media root, derived from its own path) and a new row they own. A
// copy, not a second row on the same file: retention deletes a blob's file
// with its row, and either side's retention must never take the other's.
// The path goes on `files` so a rolled-back hand-over can remove it. null
// when the original's file cannot be read. The transcript crosses as it
// stands, except a 'pending' one: no job runs for the copy's new id, so it
// crosses as never asked (NULL), which a bridge can ask for again.
export function copyBlob(db, b, toUserId, files) {
  const id = randomBytes(16).toString('hex')
  const dest = shardedPath(path.dirname(path.dirname(b.disk_path)), id)
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(b.disk_path, dest, fs.constants.COPYFILE_EXCL)
  } catch (err) {
    console.error(`handover: could not copy blob ${b.id} (the attachment crosses as expired)`, err)
    return null
  }
  files.push(dest)
  db.prepare(`INSERT INTO blobs(id, owner_user_id, content_type, size, sha256, disk_path, created_at, width, height, transcript, transcript_status, transcribed_at, transcript_segments)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, toUserId, b.content_type, b.size, b.sha256, dest, Date.now(), b.width, b.height,
    ...(b.transcript_status === 'pending' ? [null, null, null, null] : [b.transcript, b.transcript_status, b.transcribed_at, b.transcript_segments ?? null]))
  return id
}

// Rewrites inline refs (`![caption](attachment:<id>)`) to the copied ids;
// a ref to a file that did not cross becomes its caption.
const rewriteRefs = (text, map) => (typeof text === 'string' && text.includes('attachment:')
  ? text.replace(INLINE_REF_RE, (whole, caption, ref) => (map.has(ref) ? (map.get(ref) ? `![${caption}](attachment:${map.get(ref)})` : caption) : whole))
  : text)

// The recipient's mission for one of the owner's. `projectId` is the
// project it is filed in.
function copyMission(db, { m, toUserId, ownerName, brief, peopleConvo, projectId, ownerUserId, exclude, blobMap, files, now }) {
  const id = newId('ms')
  const num = nextNum(db, toUserId)
  const status = m.status_hidden ? null : m.status
  db.prepare(`INSERT INTO missions(id,user_id,num,state,title,name,body,status,status_by,status_updated_at,status_contributor,origin_convo_id,origin_device_id,created_by,created_at,updated_at,project_id)
    VALUES(?,?,?,'open',?,?,?,?,?,?,?,?,0,'user',?,?,?)`).run(
    id, toUserId, num, m.title, m.name ?? null, m.body ?? '', status, status == null ? null : 'agent', status == null ? null : m.status_updated_at,
    status == null ? null : m.status_contributor ?? null, peopleConvo, now, now, projectId)
  const { milestones, items } = missionContents(db, m.id)
  const insMilestone = db.prepare(`INSERT INTO milestones(id,mission_id,user_id,num,kind,title,body,convo_id,seq,device_id,created_by,created_at,contributor_name,contributor_via)
    VALUES(?,?,?,?,?,?,?,?,0,0,'agent',?,?,?)`)
  // The brief first, so it carries the copy's lowest milestone number; its
  // time is the hand-over's, so it is also the copy's latest milestone.
  insMilestone.run(newId('ml'), id, toUserId, nextNum(db, toUserId), 'progress', `Handed over by ${ownerName}`, brief, peopleConvo, now, null, null)
  for (const l of milestones) insMilestone.run(newId('ml'), id, toUserId, nextNum(db, toUserId), l.kind, l.title, l.body, peopleConvo, l.created_at, l.contributor_name ?? null, l.contributor_via ?? null)
  db.prepare('UPDATE missions SET last_milestone_at=? WHERE id=?').run(now, id)

  // The same blob attached twice is copied once.
  const mapBlob = (ref) => {
    if (blobMap.has(ref)) return blobMap.get(ref)
    let to = null
    if (!exclude.has(ref)) {
      const b = liveBlob(db, ownerUserId, ref)
      if (b) to = copyBlob(db, b, toUserId, files)
    }
    blobMap.set(ref, to)
    return to
  }
  const mapAttachments = (list) => {
    const out = []
    for (const a of list) {
      if (!a?.blob_ref) continue
      if (exclude.has(a.blob_ref)) { blobMap.set(a.blob_ref, null); continue }
      const to = a.expired ? null : mapBlob(a.blob_ref)
      // Not copyable (already expired, or its file is gone): kept as the
      // retention tombstone shape, so the thread still says a file was here.
      out.push(to ? { ...a, blob_ref: to } : { ...a, expired: true })
    }
    return out
  }
  const itemIds = new Map()
  // A contributor's item keeps naming them, but not where their replies
  // went: that was a conversation of theirs talking to the old owner.
  const insItem = db.prepare(`INSERT INTO items(id,user_id,num,kind,state,resolution,awaiting,rank,title,body,labels,links,supersedes,
      origin_convo_id,origin_device_id,created_by,created_at,updated_at,closed_at,mission_id,actions,chosen_action,contributor_name,contributor_via)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'agent',?,?,?,?,?,?,?,?)`)
  const insComment = db.prepare(`INSERT INTO item_comments(id,item_id,user_id,author,device_id,convo_id,kind,body,attachments,meta,created_at,actions,chosen_action)
    VALUES(?,?,?,'agent',0,NULL,?,?,?,?,?,?,?)`)
  const copied = []
  for (const it of items) {
    const itemId = newId('it')
    itemIds.set(it.id, itemId)
    // Attachments are copied before the item's own body is written, so the
    // body's inline refs can follow them.
    const threads = it.comments.map((c) => ({ c, attachments: mapAttachments(parseJson(c.attachments, [])) }))
    insItem.run(itemId, toUserId, nextNum(db, toUserId), it.kind, it.state, it.resolution, it.awaiting,
      resolveRank(db, toUserId, { position: 'bottom' }), it.title, rewriteRefs(it.body, blobMap), it.labels, it.links,
      it.supersedes ? itemIds.get(it.supersedes) ?? null : null, peopleConvo, it.created_at, now, it.closed_at, id, it.actions ?? '[]', it.chosen_action ?? null,
      it.contributor_name ?? null, it.contributor_via ?? null)
    const commentIds = new Map()
    for (const { c, attachments } of threads) {
      const cid = newId('ic')
      commentIds.set(c.id, cid)
      // A contributor's comment keeps naming them (src/contribute.js).
      const prior = parseJson(c.meta, null) ?? {}
      const meta = { ...prior, attribution: prior.attribution ?? (c.author === 'user' ? ownerName : `${ownerName}'s agent`) }
      if (meta.reply_to) meta.reply_to = commentIds.get(meta.reply_to) ?? null
      insComment.run(cid, itemId, toUserId, c.kind, rewriteRefs(c.body, blobMap), JSON.stringify(attachments), JSON.stringify(meta), c.created_at, c.actions ?? '[]', c.chosen_action ?? null)
    }
    copied.push({ from: it.id, to: itemId })
  }
  return { id, num, title: m.title, original: m, items: copied }
}

// Close the owner's original: every open item (a consent mirror is the
// user's own and is left alone) is cancelled with a line saying where the
// work went, the mission closes with a summary naming the copy, and every
// conversation still on it leaves. `copiedItems` tells which of its items
// crossed. Returns what the events layer needs for markers.
function closeOriginal(db, { m, copy, granteeName, copiedItems, selfId, now }) {
  const crossed = new Set(copiedItems.map((x) => x.from))
  const open = db.prepare("SELECT id FROM items WHERE mission_id=? AND user_id=? AND state='open' AND consent IS NULL ORDER BY num").all(m.id, m.user_id)
  const closedItems = []
  for (const { id } of open) {
    const comment = crossed.has(id) ? `Handed over to ${granteeName}.` : `The mission was handed over to ${granteeName}; this item stayed here.`
    const out = closeItem(db, { userId: m.user_id, itemId: id, resolution: 'cancelled', author: 'agent', deviceId: 0, comment, now })
    if (out) closedItems.push(out)
  }
  const summary = `Handed to ${granteeName}: now ${granteeName}'s mission #${copy.num} (/u/${encodeURIComponent(granteeName)}/${copy.num}).`
  db.prepare(`UPDATE missions SET state='closed', close_summary=?, closed_by='user', closed_convo_id=NULL, closed_over_open_items=0, closed_at=?, updated_at=?
    WHERE id=?`).run(summary, now, now, m.id)
  const left = []
  for (const { convo_id: convoId } of db.prepare('SELECT convo_id FROM mission_conversations WHERE mission_id=? AND ended_at IS NULL').all(m.id)) {
    // A link whose conversation row is gone (links have no foreign key)
    // just ends: leaveMission would refuse it and fail the whole accept.
    if (!db.prepare('SELECT 1 FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, m.user_id)) {
      db.prepare('UPDATE mission_conversations SET ended_at=? WHERE mission_id=? AND convo_id=?').run(now, m.id, convoId)
      continue
    }
    const out = leaveMission(db, { userId: m.user_id, missionId: m.id, convoId })
    if (out.left) left.push({ convoId, currentMissionId: out.currentChanged ? out.currentMissionId : null, retitled: out.retitled })
  }
  return { missionId: m.id, closedItems, left, endedAsks: endOtherAsks(db, 'mission', m.id, selfId, now) }
}

// Every other ask still open on a handed-over subject ends with it: a share
// waiting for the owner or the other person, or the raise of an active
// share. Returns the rows as they stood, for the events layer to close
// their cards.
function endOtherAsks(db, kind, id, selfId, now) {
  const rows = db.prepare(`SELECT * FROM grants WHERE subject_kind=? AND subject_id=? AND id<>?
    AND (state IN ('awaiting_owner','pending') OR pending_state IS NOT NULL)`).all(kind, id, selfId)
  for (const r of rows) {
    // A raise drops; one never sent leaves the share exactly as its grantee knows it.
    if (r.pending_state) db.prepare(`UPDATE grants SET pending_level=NULL, pending_state=NULL, pending_by=NULL, pending_at=NULL, brief=NULL, exclude_media=NULL, keep_level=NULL, approved=NULL,
      updated_at=CASE WHEN ?='awaiting_owner' THEN updated_at ELSE ? END WHERE id=?`).run(r.pending_state, now, r.id)
    else {
      db.prepare("UPDATE grants SET state='expired', updated_at=? WHERE id=?").run(now, r.id)
      // Never approved, never sent: the brief is not the recipient's to read.
      if (r.state === 'awaiting_owner') db.prepare('UPDATE grants SET brief=NULL, exclude_media=NULL, keep_level=NULL, approved=NULL WHERE id=?').run(r.id)
    }
  }
  return rows
}

// The accept. Runs INSIDE answerGrant's transaction: either all of it
// happens or none. `g` is the grant as RAW reads it. `files` collects the
// blob files written, for the caller to remove if the transaction rolls
// back. Throws the subject refusals (checkHandoverSubject) and not_contact.
export function applyHandover(db, { g, files, now = Date.now() }) {
  const kind = g.subject_kind
  const ownerUserId = g.owner_user_id
  const toUserId = g.grantee_user_id
  // Checked again here, whatever the caller did: nothing about the subject
  // or the other asks on it may have changed under this transaction.
  const missions = checkHandoverStill(db, g)
  // The recipient's own contact row for the owner: what their read grant on
  // the copy hangs on.
  const theirs = db.prepare("SELECT id FROM contacts WHERE user_id=? AND peer_user_id=? AND peer_journal IS NULL AND state='active'").get(toUserId, ownerUserId)
  if (!theirs) fail('not_contact')
  const people = ensurePeopleConvo(db, toUserId, now)
  const exclude = new Set(parseJson(g.exclude_media ?? '[]', []))
  const blobMap = new Map()
  const ctx = { toUserId, ownerUserId, ownerName: g.owner_name, brief: g.brief ?? '', peopleConvo: people.id, exclude, blobMap, files, now }

  let project = null
  if (kind === 'project') {
    const p = subjectProject(db, ownerUserId, g.subject_id)
    const status = p.status_hidden ? null : p.status
    project = { id: newId('pj'), num: nextNum(db, toUserId), original: p }
    db.prepare(`INSERT INTO projects(id,user_id,num,state,title,body,status,status_by,status_updated_at,origin_convo_id,origin_device_id,created_by,created_at,updated_at)
      VALUES(?,?,?,'open',?,?,?,?,?,?,0,'user',?,?)`).run(project.id, toUserId, project.num, p.title, p.body ?? '', status,
      status == null ? null : 'agent', status == null ? null : p.status_updated_at, people.id, now, now)
  }
  const copies = []
  const originals = []
  for (const m of missions) {
    const projectId = project ? project.id
      : insertDefaultProject(db, { userId: toUserId, deviceId: 0, createdBy: 'user', convoId: people.id, title: m.title, body: m.body ?? '', ts: now })
    const copy = copyMission(db, { m, projectId, ...ctx })
    copies.push(copy)
    originals.push(closeOriginal(db, { m, copy, granteeName: g.grantee_name, copiedItems: copy.items, selfId: g.id, now }))
  }
  const projectAsks = project ? endOtherAsks(db, 'project', g.subject_id, g.id, now) : []
  if (project) {
    db.prepare(`UPDATE projects SET state='closed', close_summary=?, closed_by='user', closed_over_open_missions=0, closed_at=?, updated_at=? WHERE id=?`)
      .run(`Handed to ${g.grantee_name}: now ${g.grantee_name}'s project #${project.num}.`, now, now, g.subject_id)
  }
  // The old owner keeps reading what they handed over (spec decision 9),
  // or keeps contributing to it when the owner chose that at the approval
  // and the recipient accepted the hand-over saying so: both people have
  // already said yes, so it is active at once, and the new owner may
  // revoke it like any share of theirs.
  const keep = g.keep_level === 'contribute' ? 'contribute' : 'read'
  const reverse = copies.map((c) => {
    const id = newId('gr')
    db.prepare(`INSERT INTO grants(id,owner_user_id,subject_kind,subject_id,contact_id,level,state,requested_by,created_at,updated_at,answered_at,sent_at)
      VALUES(?,?,'mission',?,?,?,'active','user',?,?,?,?)`).run(id, toUserId, c.id, theirs.id, keep, now, now, now, now)
    return { id, missionId: c.id, level: keep }
  })
  const copyId = project ? project.id : copies[0].id
  db.prepare(`UPDATE grants SET state='active', level='owner', pending_level=NULL, pending_state=NULL, pending_by=NULL, pending_at=NULL, copy_subject_id=?, answered_at=?, updated_at=? WHERE id=?`)
    .run(copyId, now, now, g.id)
  return { copyId, project, copies, originals, reverse, peopleConvo: people, endedAsks: [...originals.flatMap((o) => o.endedAsks), ...projectAsks] }
}
