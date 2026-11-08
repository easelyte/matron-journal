// Contribute shares across journals: the writes (docs/protocol.md
// "Contributors across journals"). src/federation-grants.js carries the
// grant at `contribute`; src/contribute.js is what a contributor may do on
// one journal, and this carries it between two.
//
//   mission.write       contributor → owner  {grant, kind, via, item?, fields}
//   item.reply_notice   owner → contributor  {grant, item, action, via, comment?}
//
// The contributor's journal checks the write as the owner's would (the
// same fields, the same limits), queues it on the grant's subject and
// answers 202: the copy it keeps shows the write once the owner's journal
// has applied it and its mission.event comes back. The owner's journal
// checks again when it applies (the grant still active at contribute, the
// mission open, the item one the grantee view shows) and writes it exactly
// as a contributor on one journal would be written, in the owner's
// numbering, attributed to the contributor's address. Its answer names the
// owner-side record ({kind, ref, num}).
//
// The conversation that filed an item is the contributor's alone: their
// journal keeps it (fed_contrib_items, by the owner's item id) and never
// sends it. The owner's replies on such an item come back as an
// item.reply_notice naming the item, and that journal hands them to the
// filing conversation as another person's turn, from its copy of the item.
import { enqueue } from './federation-outbox.js'
import { append, appendAndBroadcast, toEventShape } from './journal.js'
import { json } from './http-body.js'
import { badRequest, notFound, conflict } from './http-who.js'
import { validateItemFields, RESOLUTIONS, BODY_MAX } from './items.js'
import { itemMarkerPayload, ITEM_EVENT_TYPE } from './items-marker.js'
import { MILESTONE_KINDS, TITLE_MAX, validateMissionFields } from './missions.js'
import { MILESTONE_EVENT_TYPE } from './missions-marker.js'
import { getGrantRaw } from './grants.js'
import { remoteContactRaw } from './contacts.js'
import { strayInlineRef } from './inline-refs.js'
import { wakeConvoAgent } from './wake.js'
import { withdrawOnClose } from './item-handover-http.js'
import { fileNotice } from './sharing-events.js'
import { sanitizePeerText, plainText as plain } from './peer-text.js'
import { getReplicaMission, getReplicaItem } from './federation-replica.js'
import {
  CONTRIBUTE_KINDS, remoteContributableMission, remoteContributableItem,
  contributeMilestone, contributeItem, contributeComment, contributeClose, contributeReopen, contributeStatus,
} from './contribute.js'
import {
  toOwner, onRemoteContributorReply, contributedMilestoneMarker, afterContributedMilestone, afterContributedItem, afterContributedStatus,
} from './contribute-http.js'

export const WRITE_OP = 'mission.write'
export const REPLY_OP = 'item.reply_notice'
export const WRITE_KINDS = ['milestone', 'item', 'comment', 'close', 'reopen', 'status']
const ITEM_WRITES = new Set(['comment', 'close', 'reopen'])
const REPLY_ACTIONS = ['commented', 'closed', 'reopened']

const GRANT_REF = /^gr_[A-Za-z0-9_-]{1,64}$/
const ITEM_REF = /^it_[A-Za-z0-9_-]{1,64}$/
const COMMENT_REF = /^ic_[A-Za-z0-9_-]{1,64}$/
const TITLE_CAP = 200
const fail = (code) => { throw new Error(code) }
const hostOf = (address) => address.slice(address.indexOf('@') + 1)
const nameOf = (address) => address.slice(0, address.indexOf('@'))
const subjectOf = (ref) => `grant:${ref}`
const titleOf = (t) => plain(sanitizePeerText(t, TITLE_CAP))
const bodyOf = (entry) => (typeof entry.body === 'string' ? JSON.parse(entry.body) : entry.body ?? {})
const isText = (v, max = BODY_MAX) => typeof v === 'string' && Buffer.byteLength(v, 'utf8') <= max
const NOUN = { milestone: 'milestone', item: 'item', comment: 'comment', close: 'close', reopen: 'reopen', status: 'status' }
const WHAT = { milestone: 'your milestone', item: 'your item', comment: 'your comment', close: 'your close of an item', reopen: 'your reopening of an item', status: 'your status' }

// The write's own fields, checked the same way on both journals: what the
// contributor's journal accepts is what the owner's applies. → the clean
// fields, or null.
export function writeFields(kind, f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null
  const noRef = (...texts) => texts.every((t) => t == null || strayInlineRef(t, []) == null)
  switch (kind) {
    case 'milestone': {
      const title = typeof f.title === 'string' ? f.title.trim() : ''
      if (!MILESTONE_KINDS.includes(f.kind) || !title || title.length > TITLE_MAX) return null
      if (f.body !== undefined && f.body !== null && !isText(f.body)) return null
      return { kind: f.kind, title, body: f.body ?? '' }
    }
    case 'item': {
      if (!CONTRIBUTE_KINDS.includes(f.kind)) return null
      const v = validateItemFields({ title: f.title, body: f.body, labels: f.labels, links: f.links })
      if (!v.ok || !noRef(v.value.body)) return null
      return { kind: f.kind, ...v.value, labels: v.value.labels ?? [], links: v.value.links ?? [] }
    }
    case 'comment':
      if (typeof f.body !== 'string' || !f.body.trim() || f.body.length > BODY_MAX || !noRef(f.body)) return null
      return { body: f.body }
    case 'close':
      if (!RESOLUTIONS.includes(f.resolution)) return null
      if (f.comment !== undefined && f.comment !== null && (!isText(f.comment) || !noRef(f.comment))) return null
      return { resolution: f.resolution, comment: f.comment ?? '' }
    case 'reopen':
      if (f.comment !== undefined && f.comment !== null && (!isText(f.comment) || !noRef(f.comment))) return null
      return { comment: f.comment ?? '' }
    case 'status': {
      const v = validateMissionFields({ status: f.status }, { partial: true })
      return v.ok && 'status' in v.value ? { status: v.value.status } : null
    }
    default:
      return null
  }
}

// `ctx` {db, hub, pushPipeline, waker}; `federation` the loaded identity.
// → {inbound, outbound, setOutbox, routes}
export function makeContributeFederation({ db, hub = null, pushPipeline = null, waker = null, federation, now: clock = Date.now, log = console }) {
  const ctx = { db, hub, pushPipeline, waker }
  let outbox = null
  const pending = new WeakMap()
  const kick = () => { try { outbox?.kick() } catch (err) { log.error?.('federation: outbox kick failed', err) } }
  const addressOfUser = (userId) => `${db.prepare('SELECT name FROM users WHERE id=?').get(userId).name}@${federation.host}`
  const IN = "SELECT *, owner_name || '@' || peer_host AS owner_address FROM fed_grants_in"

  // --- The contributor's journal: the routes ---------------------------------

  // The incoming grant behind a copy, when it lets this user contribute.
  // Answers the refusal itself and returns null when it did.
  function grantFor(res, userId, fgId, missionState) {
    const g = db.prepare(`${IN} WHERE id=? AND user_id=?`).get(fgId, userId)
    if (!g || g.state !== 'active') { notFound(res); return null }
    if (g.level !== 'contribute') { json(res, 403, { error: 'forbidden' }); return null }
    if (missionState !== 'open') { conflict(res, { blocked_by: 'closed' }); return null }
    return g
  }

  // Queues the write and answers 202. `convoId` is the contributor's own
  // conversation an item's replies go to (kept here only).
  function queue(res, who, g, { kind, item = null, fields, convoId = null, mission }) {
    const at = clock()
    let id
    try {
      id = enqueue(db, {
      userId: who.userId, from: addressOfUser(who.userId), to: g.owner_address, op: WRITE_OP, subject: subjectOf(g.peer_grant_ref), now: at,
      body: { grant: g.peer_grant_ref, kind, via: who.kind === 'agent' ? 'agent' : 'user', ...(item ? { item } : {}), fields },
      meta: { kind, convo_id: convoId },
      })
    } catch (err) {
      // Too much already waiting for that journal, or a write too big to
      // send: nothing was queued, so the contributor may try again.
      if (err.message === 'outbox_full' || err.message === 'too_large') { json(res, 503, { error: err.message }); return true }
      throw err
    }
    kick()
    json(res, 202, {
      queued: true, write: { id, kind }, mission,
      note: `Sent to ${g.owner_address}'s journal, which writes it into their mission in their numbering. It shows in the shared mission once it has; if their journal refuses it, your user gets a notice.`,
    })
    return true
  }

  const fgOfMission = (missionId) => db.prepare('SELECT fg_id FROM fed_replica_missions WHERE id=?').get(missionId)?.fg_id ?? null
  const fgOfItem = (itemId) => db.prepare('SELECT fg_id, ref FROM fed_replica_items WHERE id=?').get(itemId) ?? null

  const routes = {
    // POST /milestones {mission: <a copy's id>, kind, title, body?}.
    handleMilestone(res, who, body, replica) {
      const fields = writeFields('milestone', { kind: body.kind, title: body.title, body: body.body })
      if (!fields) return badRequest(res)
      const g = grantFor(res, who.userId, fgOfMission(replica.id), replica.state)
      if (!g) return true
      return queue(res, who, g, { kind: 'milestone', fields, mission: replica })
    },
    // POST /items {mission: <a copy's id>, kind, title, body?, labels?, links?, convo_id?}.
    handleItem(res, who, body, replica, { writableConvo }) {
      if (body.attachments !== undefined && !(Array.isArray(body.attachments) && body.attachments.length === 0)) return badRequest(res)
      if (body.actions !== undefined || body.on_behalf_of !== undefined || body.supersedes !== undefined) return badRequest(res)
      const fields = writeFields('item', { kind: body.kind, title: body.title, body: body.body, labels: body.labels, links: body.links })
      if (!fields) return badRequest(res)
      if (who.kind === 'agent' && (typeof body.convo_id !== 'string' || !body.convo_id)) return badRequest(res)
      if (body.convo_id != null && !writableConvo(db, who, body.convo_id)) return notFound(res)
      const g = grantFor(res, who.userId, fgOfMission(replica.id), replica.state)
      if (!g) return true
      return queue(res, who, g, { kind: 'item', fields, convoId: body.convo_id ?? null, mission: replica })
    },
    // POST /items/:id/comments|close|reopen on a copy's item.
    handleItemSub(req, res, who, item, sub, subId, body) {
      if (req.method !== 'POST' || subId != null || !['comments', 'close', 'reopen'].includes(sub)) { json(res, 403, { error: 'forbidden' }); return true }
      const kind = sub === 'comments' ? 'comment' : sub
      if (kind === 'comment') {
        if (body.action != null || body.reply_to != null) { json(res, 403, { error: 'forbidden' }); return true }
        if (body.actions != null && !(Array.isArray(body.actions) && body.actions.length === 0)) { json(res, 403, { error: 'forbidden' }); return true }
        if (body.attachments !== undefined && !(Array.isArray(body.attachments) && body.attachments.length === 0)) return badRequest(res)
      }
      const fields = writeFields(kind, kind === 'comment' ? { body: body.body } : kind === 'close' ? { resolution: body.resolution, comment: body.comment } : { comment: body.comment })
      if (!fields) return badRequest(res)
      const row = fgOfItem(item.id)
      const mission = row ? getReplicaMission(db, who.userId, item.mission_id) : null
      if (!row || !mission) return notFound(res)
      const g = grantFor(res, who.userId, row.fg_id, mission.state)
      if (!g) return true
      return queue(res, who, g, { kind, item: row.ref, fields, mission })
    },
    // PATCH /missions/:id {status} on a copy.
    handleMissionPatch(res, who, body, replica) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res)
      if (Object.keys(body).some((k) => k !== 'status' && k !== 'convo_id') || body.status === undefined) { json(res, 403, { error: 'forbidden' }); return true }
      const fields = writeFields('status', { status: body.status })
      if (!fields) return badRequest(res)
      const g = grantFor(res, who.userId, fgOfMission(replica.id), replica.state)
      if (!g) return true
      return queue(res, who, g, { kind: 'status', fields, mission: replica })
    },
  }

  // --- The owner's journal: an owner reply on a remote contributor's item ---

  onRemoteContributorReply(db, ({ grantId, itemId, action, comment, via }) => {
    if (!REPLY_ACTIONS.includes(action)) return
    const g = getGrantRaw(db, grantId)
    if (!g || g.state !== 'active' || g.level !== 'contribute' || !g.grantee_journal) return
    try {
      enqueue(db, {
        userId: g.owner_user_id, from: `${g.owner_name}@${federation.host}`, to: `${g.grantee_name}@${g.grantee_journal}`, op: REPLY_OP,
        subject: subjectOf(g.id), now: clock(),
        body: { grant: g.id, item: itemId, action, via, ...(comment?.id ? { comment: comment.id } : {}) },
      })
      kick()
    } catch (err) {
      // A full outbox loses the nudge, not the reply: the item's own event
      // (queued first) still brings it to their copy.
      if (err.message !== 'outbox_full') throw err
    }
  })

  // --- Inbound ----------------------------------------------------------------

  // The local user `to` names, and their live contact for `from` under the
  // key that signed.
  function party(d, envelope, peer) {
    const user = d.prepare('SELECT id, name FROM users WHERE name=?').get(nameOf(envelope.to))
    const contact = user ? remoteContactRaw(d, user.id, nameOf(envelope.from), hostOf(envelope.from)) : null
    if (!contact || contact.state !== 'active' || contact.peer_journal_key !== peer.key_pub) fail('not_contact')
    return { user, contact }
  }
  const ref = (v, re) => { if (typeof v !== 'string' || !re.test(v)) fail('malformed'); return v }

  const inbound = {
    // The owner's journal: a contributor's write.
    [WRITE_OP]: {
      apply({ db: d, envelope, peer, now }) {
        const b = envelope.body ?? {}
        const grantId = ref(b.grant, GRANT_REF)
        if (!WRITE_KINDS.includes(b.kind)) fail('malformed')
        const fields = writeFields(b.kind, b.fields)
        if (!fields) fail('malformed')
        const { user } = party(d, envelope, peer)
        const g = getGrantRaw(d, grantId)
        if (!g || g.owner_user_id !== user.id || `${g.grantee_name}@${g.grantee_journal}` !== envelope.from) fail('not_active')
        let mission
        try { mission = remoteContributableMission(d, g.id) } catch (err) { if (err.message === 'read_only') fail('read_only'); throw err }
        if (!mission) fail('not_active')
        if (mission.state !== 'open') fail('closed')
        const contributor = { userId: null, name: envelope.from, via: b.via === 'user' ? 'user' : 'agent', grantId: g.id }
        let item = null
        if (ITEM_WRITES.has(b.kind)) {
          item = remoteContributableItem(d, g.id, ref(b.item, ITEM_REF))
          if (!item) fail('no_item')
        }
        const run = (fn) => { try { return fn() } catch (err) { if (err.message === 'gone') fail('not_active'); throw err } }
        const sender = `person:${contributor.name}`
        let out
        let answer
        switch (b.kind) {
          case 'milestone':
            out = run(() => contributeMilestone(d, {
              mission, contributor, ...fields, now,
              appendMarker: (convoId, row) => append(d, { userId: mission.user_id, convoId, sender, type: MILESTONE_EVENT_TYPE, payload: contributedMilestoneMarker(d, { mission, contributor, row }) }),
            }))
            answer = { kind: 'milestone', ref: out.milestone.id, num: out.milestone.num }
            break
          case 'item':
            out = run(() => contributeItem(d, { mission, contributor, replyConvoId: null, ...fields, now }))
            answer = { kind: 'item', ref: out.itemId, num: d.prepare('SELECT num FROM items WHERE id=?').get(out.itemId).num }
            break
          case 'comment':
            out = run(() => contributeComment(d, { item, contributor, body: fields.body, now }))
            answer = { kind: 'comment', ref: out.id, item: item.id, num: item.num }
            break
          case 'close':
            out = run(() => contributeClose(d, { item, contributor, ...fields, now }))
            if (!out) fail('conflict')
            answer = { kind: 'close', ref: item.id, num: item.num }
            break
          case 'reopen':
            out = run(() => contributeReopen(d, { item, contributor, ...fields, now }))
            if (!out) fail('conflict')
            answer = { kind: 'reopen', ref: item.id, num: item.num }
            break
          case 'status':
            out = run(() => contributeStatus(d, { mission, contributor, status: fields.status }))
            answer = { kind: 'status', ref: mission.id, num: mission.num }
            break
        }
        pending.set(envelope, { kind: b.kind, mission, contributor, item, out })
        return answer
      },
      after({ envelope }) {
        const p = pending.get(envelope)
        if (!p) return
        const { kind, mission, contributor, item, out } = p
        if (kind === 'milestone') afterContributedMilestone(ctx, { mission, contributor, out })
        else if (kind === 'item') afterContributedItem(ctx, { mission, contributor, out })
        else if (kind === 'status') afterContributedStatus(ctx, { mission, contributor, updated: out })
        else if (kind === 'comment') toOwner(ctx, { contributor, item, action: 'commented', comment: out })
        else {
          if (kind === 'close') withdrawOnClose(ctx, item.user_id, item.id)
          toOwner(ctx, { contributor, item, action: kind === 'close' ? 'closed' : 'reopened', comment: out.comment })
        }
      },
      errors: { malformed: 400, not_contact: 403, read_only: 403, no_item: 404, not_active: 409, closed: 409, conflict: 409 },
    },
    // The contributor's journal: the owner replied on an item they filed.
    [REPLY_OP]: {
      apply({ db: d, envelope, peer }) {
        const b = envelope.body ?? {}
        const grantRef = ref(b.grant, GRANT_REF)
        const itemRef = ref(b.item, ITEM_REF)
        if (!REPLY_ACTIONS.includes(b.action)) fail('malformed')
        if (b.comment !== undefined) ref(b.comment, COMMENT_REF)
        const { user } = party(d, envelope, peer)
        const g = d.prepare(`${IN} WHERE user_id=? AND peer_host=? AND peer_grant_ref=? AND owner_name=?`).get(user.id, hostOf(envelope.from), grantRef, nameOf(envelope.from))
        if (!g || g.state !== 'active') fail('not_active')
        const filed = d.prepare('SELECT convo_id FROM fed_contrib_items WHERE fg_id=? AND ref=?').get(g.id, itemRef)
        // An item filed from a phone, or one this journal did not file: no
        // conversation to tell.
        if (filed) pending.set(envelope, { g, convoId: filed.convo_id, itemRef, commentRef: b.comment ?? null, action: b.action, via: b.via === 'user' ? 'user' : 'agent' })
        return {}
      },
      after({ envelope }) {
        const p = pending.get(envelope)
        if (p) tellFiler(p)
      },
      errors: { malformed: 400, not_contact: 403, not_active: 409 },
    },
  }

  // The filing conversation hears the owner's reply, from this journal's
  // copy of the item: as another person's turn, the way a contributor on
  // one journal hears it (contribute-http.js forwardToContributor).
  function tellFiler({ g, convoId, itemRef, commentRef, action, via }) {
    try {
      if (!db.prepare('SELECT 1 FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, g.user_id)) return
      const row = db.prepare('SELECT id, comments FROM fed_replica_items WHERE fg_id=? AND ref=?').get(g.id, itemRef)
      const shared = row ? getReplicaItem(db, g.user_id, row.id) : null
      if (!shared) return
      let comment = null
      if (commentRef) {
        const local = JSON.parse(row.comments ?? '[]').find((c) => c.ref === commentRef)
        comment = local ? shared.comments.find((c) => c.id === local.id) ?? null : null
      }
      const sender = `person:${g.owner_address}`
      const payload = {
        ...itemMarkerPayload({ item: shared.item, action, by: via, comment }),
        person: { name: g.owner_address, via }, shared_by: { user_id: 0, name: g.owner_address }, mission_id: shared.item.mission_id,
      }
      const r = appendAndBroadcast(db, hub, { userId: g.user_id, convoId, sender, type: ITEM_EVENT_TYPE, payload })
      try { pushPipeline?.onAppend(g.user_id, toEventShape({ seq: r.seq, convo_id: convoId, ts: r.ts, sender, type: ITEM_EVENT_TYPE, payload }), null) } catch (err) { log.error?.('federation: push failed', err) }
      wakeConvoAgent(ctx, g.user_id, convoId)
    } catch (err) {
      log.error?.('federation: telling the filing conversation failed (the reply stands)', err)
    }
  }

  // --- Outbox hooks -----------------------------------------------------------

  const incomingFor = (d, entry) => d.prepare(`${IN} WHERE user_id=? AND peer_host=? AND peer_grant_ref=?`)
    .get(entry.user_id, hostOf(entry.to_addr), bodyOf(entry).grant)
  const REASONS = {
    expired: 'could not be reached for 7 days', journal_not_allowed: 'is not one this journal federates with any more',
    peer_key_changed: 'changed its key', not_contact: 'no longer has you as a contact', not_active: 'no longer shares it with you',
    read_only: 'shares it with you read-only now', closed: 'has closed the mission', no_item: 'no longer shows that item',
    conflict: 'already had the item that way', malformed: 'could not read it', peer_refused: 'does not accept messages from this journal',
  }
  const why = (error) => REASONS[error] ?? 'refused it'

  const outbound = {
    [WRITE_OP]: {
      // While the share still lets this user contribute.
      stillAllowed(d, entry) {
        const g = incomingFor(d, entry)
        return !!g && g.state === 'active' && g.level === 'contribute'
      },
      // An item filed from a conversation: its replies go back there.
      onAcked(d, entry, result) {
        const meta = entry.meta ?? {}
        const g = incomingFor(d, entry)
        if (g && meta.kind === 'item' && meta.convo_id && typeof result?.ref === 'string' && ITEM_REF.test(result.ref)) {
          d.prepare('INSERT OR IGNORE INTO fed_contrib_items(fg_id, ref, convo_id, created_at) VALUES(?,?,?,?)').run(g.id, result.ref, meta.convo_id, clock())
        }
        return undefined
      },
      onDead(d, entry, { error }) {
        const g = incomingFor(d, entry)
        const kind = bodyOf(entry).kind
        if (g && WRITE_KINDS.includes(kind)) {
          fileNotice(ctx, {
            userId: g.user_id, title: `Couldn't add ${WHAT[kind]} to mission "${titleOf(g.mission_title)}"`,
            body: `The journal at ${g.peer_host} ${why(error)}, so ${WHAT[kind]} on the mission shared by \`${plain(g.owner_address)}\` was not written there.`,
            idemKey: `fed-write-dead:${entry.id}`,
          })
        }
        return 'discard'
      },
    },
    [REPLY_OP]: {
      stillAllowed(d, entry) {
        const g = getGrantRaw(d, bodyOf(entry).grant)
        return !!g && g.state === 'active' && g.level === 'contribute'
      },
      // A nudge, nothing more: the reply itself reaches their copy anyway.
      onDead() { return 'discard' },
    },
  }

  return { inbound, outbound, routes, setOutbox: (o) => { outbox = o }, NOUN }
}
