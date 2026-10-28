// HTTP surface of contacts and grants (spec 2026-10-02 matron-to-matron
// sharing, phase 1; docs/protocol.md "Contacts and grants").
//
//   GET    /contacts/users                 this journal's other users, names only
//   GET    /contacts[?state=]              my contacts
//   POST   /contacts {user, convo_id?}     ask someone to be a contact
//   POST   /contacts/:id/answer {decision} approve | decline       (client only)
//   POST   /contacts/:id/block             DELETE /contacts/:id    (remove / withdraw)
//   POST   /contacts/:id/unblock                                   (client only)
//   GET    /contacts/:id/activity          the audit events for one contact
//   POST   /missions/:id/shares {contact, level, brief?, exclude_media?, keep_level?, convo_id?}
//   GET    /missions/:id/shares            the owner's grants on one mission
//   POST   /projects/:id/shares {contact, level:'owner', brief, exclude_media?, keep_level?, convo_id?}
//   GET    /projects/:id/shares            the owner's grants on one project
//   GET    /grants[?direction=in|out][&state=]
//   POST   /grants/:id/answer {decision, exclude_media?, keep_level?, start_session?}   (client only)
//   DELETE /grants/:id                     revoke (owner) / leave (grantee)
//
// Who may do what:
//   - An AGENT asking (POST /contacts, POST …/shares) never sends anything:
//     the ask is parked, a card and its tracker mirror go to the agent's
//     own user, and only that user's tap sends it on. A CLIENT asking is the
//     user's own tap, and goes straight out.
//   - Every answer is a client's. An agent — the Coordinator included — gets
//     403 on both answer routes and on unblock, and these asks are not in
//     /consent/pending: a card from another person, or one that sends data
//     to another person, is the user's alone.
//   - Agents may remove, block and revoke: those only ever reduce access.
import { json, readBody } from './http-body.js'
import { badRequest, notFound, conflict } from './http-who.js'
import { PEOPLE_EVENT_TYPE } from './journal.js'
import {
  DECISIONS, CONTACT_STATES, contactRow, listJournalUsers, getContactRaw, listContacts, requestContact, answerContact,
  removeContact, blockContact, unblockContact,
} from './contacts.js'
import { grantRow, getGrantRaw, shareMission, shareProject, answerGrant, revokeGrant, listGrants, GRANT_LEVELS, GRANT_STATES } from './grants.js'
import { validBrief, validExcludeMedia, validKeepLevel } from './handover.js'
import { onContactOutcome, onContactEnded, onContactUnblocked, onGrantOutcome, onGrantRevoked } from './sharing-events.js'
import { HANDOVER_CHOICE, beginHandoverSession, pickableBoxes, cardLine } from './handover-session.js'
import { talkQuestionActions, recordFollowUpTap } from './talk-requests-events.js'
import { visibleMission, writableConvo } from './missions-http.js'
import { getProject } from './projects.js'
import { filteredAgent } from './privacy.js'
import { getItem } from './items.js'
import { USERNAME_RE } from './users-http.js'
import { revokeSharesBetween } from './person-rooms.js'
import { onContactEndedRooms, onGrantEndedRooms, onShareEnded } from './person-rooms-events.js'

// Phase 2's share of a contact ending: every room between the two people
// ends on both sides, and every session either one shared with the other
// stops being offered. After onContactEnded, best-effort like it.
function endPeopleRooms(ctx, out) {
  const own = out.contact
  if (own.peer_user_id == null) return
  try {
    onContactEndedRooms(ctx, own.user_id, own.peer_user_id)
    for (const s of revokeSharesBetween(ctx.db, [own.id, out.peer?.id ?? ctx.db.prepare('SELECT id FROM contacts WHERE user_id=? AND peer_user_id=? AND peer_journal IS NULL').get(own.peer_user_id, own.user_id)?.id])) onShareEnded(ctx, s)
  } catch (err) {
    console.error('person rooms: contact end failed (the contact change stands)', err)
  }
}

const forbidden = (res) => { json(res, 403, { error: 'forbidden' }); return true }
const blocked = (res, by, extra = {}) => conflict(res, { blocked_by: by, ...extra })
const CONTACT_CONFLICTS = new Set(['already_contact', 'pending', 'pending_in', 'blocked', 'too_many_asks', 'not_pending', 'not_active', 'not_blocked'])
const GRANT_CONFLICTS = new Set(['not_contact', 'level_unavailable', 'private_mission', 'pending', 'too_many_asks', 'not_pending', 'not_active',
  'handed_over', 'mission_closed', 'project_closed', 'empty_project', 'handover_changed'])

// The conversation an agent's ask is parked in — where its card goes. Same
// gate as every other agent-authored append. A client names none.
function askConvo(db, who, convoId) {
  if (who.kind !== 'agent') return { convoId: null }
  if (typeof convoId !== 'string' || !convoId) return { status: 400 }
  if (!writableConvo(db, who, convoId)) return { status: 404 }
  return { convoId }
}

const by = (who) => (who.kind === 'agent' ? 'agent' : 'user')

// --- Contacts ---------------------------------------------------------------

async function handleContactRequest(ctx, req, res, who) {
  const { db } = ctx
  const body = await readBody(req)
  if (typeof body.user !== 'string' || !USERNAME_RE.test(body.user)) return badRequest(res)
  const convo = askConvo(db, who, body.convo_id)
  if (convo.status === 400) return badRequest(res)
  if (convo.status === 404) return notFound(res)
  let out
  try {
    out = requestContact(db, { userId: who.userId, peerName: body.user, by: by(who), convoId: convo.convoId, deviceId: who.deviceId })
  } catch (err) {
    // Unknown user and "yourself" are one 404.
    if (err.message === 'no_user') return notFound(res)
    if (CONTACT_CONFLICTS.has(err.message)) return blocked(res, err.message)
    throw err
  }
  onContactOutcome(ctx, who, out)
  // `pending`: whose yes is still needed. A request the other person has
  // blocked answers exactly like one they have not seen yet.
  const pending = out.outcome === 'parked' ? 'owner' : (out.contact.state === 'active' ? null : 'peer')
  json(res, out.outcome === 'parked' ? 202 : 201, { contact: contactRow(out.contact), ...(pending ? { pending } : {}) })
  return true
}

// Shared by POST /contacts/:id/answer and a tap on the mirror's button.
// Returns {status, body} for the caller to send, plus `closed` (the mirror
// that the answer closed) for the item route.
export function applyContactAnswer(ctx, who, contactId, decision) {
  const { db } = ctx
  let out
  try {
    out = answerContact(db, { userId: who.userId, contactId, decision })
  } catch (err) {
    if (CONTACT_CONFLICTS.has(err.message)) return { status: 409, body: { error: 'conflict', blocked_by: err.message } }
    throw err
  }
  if (!out) return { status: 404, body: { error: 'not_found' } }
  const closed = onContactOutcome(ctx, who, out)
  if (out.outcome === 'expired') return { status: 409, body: { error: 'conflict', blocked_by: 'expired' }, closed }
  return { status: 200, body: { contact: contactRow(out.contact) }, closed }
}

async function handleContactSub(ctx, req, res, url, who, id, sub) {
  const { db } = ctx
  const own = getContactRaw(db, who.userId, id)
  if (!own) return notFound(res)
  if (!sub) {
    if (req.method === 'GET') { json(res, 200, { contact: contactRow(own) }); return true }
    if (req.method === 'DELETE') {
      let out
      try { out = removeContact(db, { userId: who.userId, contactId: own.id }) } catch (err) {
        if (CONTACT_CONFLICTS.has(err.message)) return blocked(res, err.message)
        throw err
      }
      if (!out) return notFound(res)
      onContactEnded(ctx, who, out, 'removed')
      endPeopleRooms(ctx, out)
      json(res, 200, { contact: contactRow(out.contact) })
      return true
    }
    return false
  }
  if (sub === 'activity' && req.method === 'GET') {
    // Client-only, like the events it lists: a line about an ask the user
    // has not yet answered must not reach an agent through this door
    // either (sharing-events.js, rule 1).
    if (who.kind !== 'client') return forbidden(res)
    json(res, 200, { events: contactActivity(db, who.userId, own.id) })
    return true
  }
  if (req.method !== 'POST') return false
  if (sub === 'answer') {
    if (who.kind !== 'client') return forbidden(res)
    const body = await readBody(req)
    if (!DECISIONS.includes(body.decision)) return badRequest(res)
    const r = applyContactAnswer(ctx, who, own.id, body.decision)
    json(res, r.status, r.body)
    return true
  }
  if (sub === 'block') {
    let out
    try { out = blockContact(db, { userId: who.userId, contactId: own.id }) } catch (err) {
      if (CONTACT_CONFLICTS.has(err.message)) return blocked(res, err.message)
      throw err
    }
    if (!out) return notFound(res)
    onContactEnded(ctx, who, out, 'blocked')
    endPeopleRooms(ctx, out)
    json(res, 200, { contact: contactRow(out.contact) })
    return true
  }
  if (sub === 'unblock') {
    if (who.kind !== 'client') return forbidden(res)
    let out
    try { out = unblockContact(db, { userId: who.userId, contactId: own.id }) } catch (err) {
      if (CONTACT_CONFLICTS.has(err.message)) return blocked(res, err.message)
      throw err
    }
    if (!out) return notFound(res)
    onContactUnblocked(ctx, out)
    json(res, 200, { contact: contactRow(out.contact) })
    return true
  }
  return false
}

// The audit trail for one contact, newest first: the `people` events in the
// caller's own People conversation that name this contact row. Clients
// only: the events are client-only in the timeline, and so is this door.
const ACTIVITY_MAX = 200
function contactActivity(db, userId, contactId) {
  return db.prepare(`SELECT e.seq, e.ts, e.payload FROM events e
      JOIN conversations c ON c.id = e.convo_id AND c.owner_user_id = e.user_id AND c.system = 'people'
    WHERE e.user_id = ? AND e.type = ? AND json_extract(e.payload, '$.contact_id') = ?
    ORDER BY e.seq DESC LIMIT ${ACTIVITY_MAX}`).all(userId, PEOPLE_EVENT_TYPE, contactId)
    .map((r) => ({ seq: r.seq, ts: r.ts, ...JSON.parse(r.payload) }))
}

// --- Grants -----------------------------------------------------------------

// `subject` is {kind:'mission'|'project', row}. A hand-over (level owner)
// needs `brief`; `exclude_media` is the owner's own unticking, so only a
// client may send it with the ask (an agent's ask is unticked on the card).
async function handleShareCreate(ctx, req, res, who, subject) {
  const { db } = ctx
  const body = await readBody(req)
  if (typeof body.contact !== 'string' || !body.contact || body.contact.length > 128) return badRequest(res)
  const level = body.level ?? 'read'
  if (!GRANT_LEVELS.includes(level)) return badRequest(res)
  let brief = null
  if (level === 'owner') {
    brief = validBrief(body.brief)
    if (!brief) return badRequest(res)
  }
  const excludeMedia = validExcludeMedia(body.exclude_media)
  if (excludeMedia === null || (excludeMedia !== undefined && (who.kind !== 'client' || level !== 'owner'))) return badRequest(res)
  // What the owner keeps on the copy: a hand-over's alone. An agent may ask
  // for it; the owner's card can still change it.
  const keepLevel = validKeepLevel(body.keep_level)
  if (keepLevel === null || (keepLevel !== undefined && level !== 'owner')) return badRequest(res)
  const convo = askConvo(db, who, body.convo_id)
  if (convo.status === 400) return badRequest(res)
  if (convo.status === 404) return notFound(res)
  const args = { ownerUserId: who.userId, contact: body.contact, level, brief, excludeMedia: excludeMedia ?? null, keepLevel: keepLevel ?? null, by: by(who), convoId: convo.convoId, deviceId: who.deviceId }
  let out
  try {
    out = subject.kind === 'project'
      ? shareProject(db, { ...args, projectId: subject.row.id })
      : shareMission(db, { ...args, missionId: subject.row.id })
  } catch (err) {
    if (err.message === 'no_mission' || err.message === 'no_project') return notFound(res)
    if (err.message === 'no_brief') return badRequest(res)
    if (GRANT_CONFLICTS.has(err.message)) return blocked(res, err.message)
    throw err
  }
  if (out.existing) { json(res, 200, { grant: grantRow(out.grant, who.userId), existing: true }); return true }
  const parked = (out.grant.pending_state ?? out.grant.state) === 'awaiting_owner'
  onGrantOutcome(ctx, who, { outcome: parked ? 'parked' : 'sent', grant: out.grant })
  json(res, parked ? 202 : 201, { grant: grantRow(out.grant, who.userId), pending: parked ? 'owner' : 'peer' })
  return true
}

// `excludeMedia` and `keepLevel` (the owner's approval of a hand-over) only come from POST
// /grants/:id/answer. `startSession` (the recipient's accept) is the
// answer's {device_id, workdir?}, or 'coordinator' for the card's New
// session button (src/handover-session.js).
export function applyGrantAnswer(ctx, who, grantId, decision, { excludeMedia, keepLevel, startSession = null } = {}) {
  const { db } = ctx
  let out
  try {
    out = answerGrant(db, { userId: who.userId, grantId, decision, excludeMedia, keepLevel })
  } catch (err) {
    if (GRANT_CONFLICTS.has(err.message)) return { status: 409, body: { error: 'conflict', blocked_by: err.message } }
    // The subject of a hand-over was deleted under the ask: nothing to take over.
    if (err.message === 'no_mission' || err.message === 'no_project') return { status: 409, body: { error: 'conflict', blocked_by: 'mission_closed' } }
    throw err
  }
  if (!out) return { status: 404, body: { error: 'not_found' } }
  const closed = onGrantOutcome(ctx, who, out)
  if (out.outcome === 'expired') return { status: 409, body: { error: 'conflict', blocked_by: 'expired' }, closed }
  if (out.outcome === 'unavailable') return { status: 409, body: { error: 'conflict', blocked_by: 'not_contact' }, closed }
  if (out.outcome === 'refused') return { status: 409, body: { error: 'conflict', blocked_by: out.reason }, closed }
  const session = out.outcome === 'handed_over' && startSession
    ? { start_session: beginHandoverSession(ctx, { g: out.grant, h: out.handover, request: startSession, itemId: out.before?.grantee_item_id ?? null }) }
    : {}
  return { status: 200, body: { grant: grantRow(out.grant, who.userId), ...session }, closed }
}

// {device_id, workdir?}: null = malformed.
function startSessionOf(v) {
  if (v == null) return undefined
  if (typeof v !== 'object' || Array.isArray(v) || !Number.isInteger(v.device_id) || v.device_id < 1) return null
  if (v.workdir !== undefined && (typeof v.workdir !== 'string' || !v.workdir || v.workdir.length > 4096)) return null
  return { device_id: v.device_id, ...(v.workdir !== undefined ? { workdir: v.workdir } : {}) }
}

async function handleGrantRoute(ctx, req, res, url, who) {
  const { db } = ctx
  const path = url.pathname
  if (path === '/grants') {
    if (req.method !== 'GET') return false
    const direction = url.searchParams.get('direction')
    if (direction != null && direction !== 'in' && direction !== 'out') return badRequest(res)
    const state = url.searchParams.get('state')
    if (state != null && !GRANT_STATES.includes(state)) return badRequest(res)
    json(res, 200, { grants: listGrants(db, who.userId, { direction, state }) })
    return true
  }
  const m = path.match(/^\/grants\/([^/]+)(?:\/(answer))?$/)
  if (!m) return false
  let id
  try { id = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  // Not a party — or the grantee of a row never sent to them: an ask its
  // owner has not approved yet, or one that ended before they did — is the
  // same 404 as an unknown id.
  const g = getGrantRaw(db, id)
  const party = g && (g.owner_user_id === who.userId || (g.grantee_user_id === who.userId && g.sent_at != null))
  if (!party) return notFound(res)
  if (!m[2]) {
    if (req.method === 'GET') { json(res, 200, { grant: grantRow(g, who.userId) }); return true }
    if (req.method === 'DELETE') {
      let out
      try { out = revokeGrant(db, { userId: who.userId, grantId: g.id }) } catch (err) {
        if (GRANT_CONFLICTS.has(err.message)) return blocked(res, err.message)
        throw err
      }
      if (!out) return notFound(res)
      onGrantRevoked(ctx, out.before, out.by, who)
      if (out.before.subject_kind === 'mission') onGrantEndedRooms(ctx, out.before.subject_id, out.before.contact_id)
      json(res, 200, { grant: grantRow(out.grant, who.userId) })
      return true
    }
    return false
  }
  if (req.method !== 'POST') return false
  if (who.kind !== 'client') return forbidden(res)
  const body = await readBody(req)
  if (!DECISIONS.includes(body.decision)) return badRequest(res)
  const excludeMedia = validExcludeMedia(body.exclude_media)
  const startSession = startSessionOf(body.start_session)
  const keepLevel = validKeepLevel(body.keep_level)
  if (excludeMedia === null || keepLevel === null || startSession === null) return badRequest(res)
  const r = applyGrantAnswer(ctx, who, g.id, body.decision, { excludeMedia, keepLevel, startSession })
  json(res, r.status, r.body)
  return true
}

// A tap on a contact/share mirror's action button (POST /items/:id/comments
// {action}) IS the answer to its card — the path today's apps already have.
// Called by items-http.js ahead of the generic comment path, for a client
// only. The reply has the comment route's shape: the closed item and the
// status row that closed it.
// The recipient's hand-over card (src/handover-session.js): Accept, New
// session, Pick a box (a follow-up question with their boxes) and Decline;
// a follow-up's tap carries `reply_to`.
function handleHandoverTap(ctx, res, who, item, action, replyTo, grantId) {
  const { db } = ctx
  let decision = 'approve'
  let startSession = null
  if (replyTo != null) {
    const offered = talkQuestionActions(db, item.id, replyTo)
    if (!offered || !offered.includes(action)) { json(res, 400, { error: 'unknown_action' }); return true }
    if (action === HANDOVER_CHOICE.decline) decision = 'decline'
    else {
      let picks = {}
      try { picks = JSON.parse(db.prepare('SELECT pick_options FROM grants WHERE id=?').get(grantId)?.pick_options ?? '{}') } catch { /* none */ }
      if (!Number.isInteger(picks[action])) { json(res, 400, { error: 'unknown_action' }); return true }
      startSession = { device_id: picks[action] }
    }
  } else {
    if (!item.actions.includes(action)) { json(res, 400, { error: 'unknown_action' }); return true }
    if (action === HANDOVER_CHOICE.pick) {
      // Only while the hand-over still waits on the recipient.
      const g = getGrantRaw(db, grantId)
      if (!g || g.grantee_user_id !== who.userId || g.sent_at == null || (g.pending_state ?? g.state) !== 'pending' || (g.pending_level ?? g.level) !== 'owner') {
        json(res, 409, { error: 'conflict', blocked_by: 'not_pending' }); return true
      }
      const options = pickableBoxes(db, who.userId)
      if (!Object.keys(options).length) { json(res, 409, { error: 'conflict', blocked_by: 'not_available' }); return true }
      db.prepare('UPDATE grants SET pick_options=? WHERE id=?').run(JSON.stringify(options), grantId)
      const q = cardLine(ctx, { userId: who.userId, itemId: item.id, body: 'Which box should start the session?', actions: [...Object.keys(options), HANDOVER_CHOICE.decline] })
      json(res, 200, { item: getItem(db, who.userId, item.id) ?? item, comment: q?.comment ?? null })
      return true
    }
    if (action === HANDOVER_CHOICE.decline) decision = 'decline'
    if (action === HANDOVER_CHOICE.new) startSession = 'coordinator'
  }
  const r = applyGrantAnswer(ctx, who, grantId, decision, { startSession })
  if (r.status !== 200) { json(res, r.status, r.body); return true }
  if (replyTo != null) recordFollowUpTap(ctx, who, item.id, action, replyTo)
  json(res, 200, { item: getItem(db, who.userId, item.id) ?? item, comment: r.closed?.comment ?? null, ...r.body })
  return true
}

export function handleConsentTap(ctx, res, who, item, action, replyTo = null) {
  const { db } = ctx
  if (item.consent === 'handover') {
    const recipient = db.prepare('SELECT id FROM grants WHERE grantee_item_id=?').get(item.id)
    if (recipient) return handleHandoverTap(ctx, res, who, item, action, replyTo, recipient.id)
  }
  if (replyTo != null) { json(res, 400, { error: 'unknown_action' }); return true }
  if (!item.actions.includes(action)) { json(res, 400, { error: 'unknown_action' }); return true }
  const decision = action === 'Decline' ? 'decline' : 'approve'
  let r
  if (item.consent === 'contact') {
    const row = db.prepare('SELECT id FROM contacts WHERE user_id=? AND item_id=?').get(who.userId, item.id)
    if (!row) return conflict(res)
    r = applyContactAnswer(ctx, who, row.id, decision)
  } else {
    const row = db.prepare('SELECT id FROM grants WHERE owner_item_id=? OR grantee_item_id=?').get(item.id, item.id)
    if (!row) return conflict(res)
    r = applyGrantAnswer(ctx, who, row.id, decision)
  }
  if (r.status !== 200) { json(res, r.status, r.body); return true }
  json(res, 200, { item: getItem(db, who.userId, item.id) ?? item, comment: r.closed?.comment ?? null, ...r.body })
  return true
}

export const isSharingMirror = (item) => item?.consent === 'contact' || item?.consent === 'share' || item?.consent === 'handover'

export async function handleSharingRoute(ctx, req, res, url, who) {
  const { db } = ctx
  const path = url.pathname
  if (path === '/grants' || path.startsWith('/grants/')) return handleGrantRoute(ctx, req, res, url, who)

  const sm = path.match(/^\/missions\/([^/]+)\/shares$/)
  if (sm) {
    let idOrNum
    try { idOrNum = decodeURIComponent(sm[1]) } catch { return badRequest(res) }
    // The owner's mission, through the caller's own sieve: a mission an
    // ordinary agent cannot see cannot be shared by it, or probed for.
    const mission = visibleMission(db, who, idOrNum)
    if (!mission) return notFound(res)
    if (req.method === 'GET') { json(res, 200, { grants: listGrants(db, who.userId, { direction: 'out', missionId: mission.id }) }); return true }
    if (req.method === 'POST') return handleShareCreate(ctx, req, res, who, { kind: 'mission', row: mission })
    return false
  }

  const pm = path.match(/^\/projects\/([^/]+)\/shares$/)
  if (pm) {
    let idOrNum
    try { idOrNum = decodeURIComponent(pm[1]) } catch { return badRequest(res) }
    // Same stance as a mission: the caller's own sieve, so a project an
    // ordinary agent cannot see cannot be handed over by it, or probed for.
    const project = getProject(db, who.userId, idOrNum, { excludePrivateOwned: filteredAgent(db, who) })
    if (!project) return notFound(res)
    if (req.method === 'GET') { json(res, 200, { grants: listGrants(db, who.userId, { direction: 'out', projectId: project.id }) }); return true }
    if (req.method === 'POST') return handleShareCreate(ctx, req, res, who, { kind: 'project', row: project })
    return false
  }

  if (path !== '/contacts' && !path.startsWith('/contacts/')) return false
  if (path === '/contacts') {
    if (req.method === 'GET') {
      const state = url.searchParams.get('state')
      if (state != null && !CONTACT_STATES.includes(state)) return badRequest(res)
      json(res, 200, { contacts: listContacts(db, who.userId, { state }) })
      return true
    }
    if (req.method === 'POST') return handleContactRequest(ctx, req, res, who)
    return false
  }
  if (path === '/contacts/users') {
    if (req.method !== 'GET') return false
    json(res, 200, { users: listJournalUsers(db, who.userId) })
    return true
  }
  const m = path.match(/^\/contacts\/([^/]+)(?:\/(answer|block|unblock|activity))?$/)
  if (!m) return false
  let id
  try { id = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  return handleContactSub(ctx, req, res, url, who, id, m[2] || null)
}
