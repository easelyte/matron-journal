// Mission shares with a contact on another journal (docs/protocol.md
// "Shares across journals"). Read shares only, so far.
//
// The owner's journal keeps the grant in `grants` as for any contact; its
// contact row names the other journal, so there is no grantee user here.
// What a same-journal share does on the grantee's side — their card, their
// answer, their log — happens on the grantee's journal instead, which
// keeps the grant it was offered in `fed_grants_in` (its own `fg_` id; the
// owner's `gr_` id is `peer_grant_ref`).
//
//   grant.offer   owner → grantee  {grant, level, mission: {num, title}, preview}
//   grant.answer  grantee → owner  {grant, decision: approve|decline}
//   grant.revoke  either way       {grant}            urgent: cancels the grant's queue
//   mission.snapshot owner → grantee, on accept: the mission's contents
//   mission.event    owner → grantee, on each write since: one record's
//                 state (both in src/federation-replica.js)
//
// Every op of one grant shares the subject `grant:<owner's gr_ id>`, so an
// answer never overtakes its offer and a revoke cancels whatever waits.
import { newId } from './items.js'
import { enqueue } from './federation-outbox.js'
import { remoteContactRaw } from './contacts.js'
import { answerRemoteGrant, leaveRemoteGrant, getGrantRaw, sharePreview } from './grants.js'
import { onRemoteMissionWrite, card, fileMirror, closeMirror, audit, changed, fileNotice, peopleConvo, onGrantOutcome, onGrantRevoked, PEER_ACTIONS, SHARE_CARD_KIND } from './sharing-events.js'
import { consentLink } from './consent-items.js'
import { sanitizePeerText, plainText as plain } from './peer-text.js'
import { SNAPSHOT_OP, EVENT_OP, sendSnapshot, sendEvent, eventBody, applySnapshotPage, applyEvent } from './federation-replica.js'

export const OFFER_OP = 'grant.offer'
export const ANSWER_OP = 'grant.answer'
export const REVOKE_OP = 'grant.revoke'
export const INCOMING_STATES = ['pending', 'active', 'declined', 'revoked']

const TITLE_CAP = 200
const GRANT_REF = /^gr_[A-Za-z0-9_-]{1,64}$/
const fail = (code) => { throw new Error(code) }
const hostOf = (address) => address.slice(address.indexOf('@') + 1)
const nameOf = (address) => address.slice(0, address.indexOf('@'))
const subjectOf = (ref) => `grant:${ref}`
// Every read of an incoming grant names its owner by address.
const IN = "SELECT *, owner_name || '@' || peer_host AS owner_address FROM fed_grants_in"
const userByName = (db, name) => db.prepare('SELECT id, name FROM users WHERE name=?').get(name)
const incomingById = (db, id) => db.prepare(`${IN} WHERE id=?`).get(id) ?? null
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0)
const titleOf = (t) => plain(sanitizePeerText(t, TITLE_CAP))
const shareLink = (id) => ({ url: consentLink('share', id), title: 'Mission share' })

// The grantee's view of one incoming grant: the same shape as GET /grants
// gives a same-journal grantee, with the owner named by address.
export function incomingRow(r) {
  return {
    id: r.id, direction: 'in', subject_kind: 'mission', subject_id: null, level: r.level, state: r.state,
    owner: { user_id: null, name: r.owner_name, address: r.owner_address },
    mission: { id: null, num: r.mission_num, title: r.mission_title },
    pending_level: null, pending_state: null, requested_by: null, revoked_by: r.revoked_by ?? null,
    created_at: r.created_at, updated_at: r.updated_at, answered_at: r.answered_at ?? null, revoked_at: r.revoked_at ?? null,
  }
}

// GET /grants for the grantee: the incoming grants from other journals.
// Ended ones only when a state is named, as for every grant.
export function listIncoming(db, userId, { state = null } = {}) {
  const rows = state
    ? db.prepare(`${IN} WHERE user_id=? AND state=? ORDER BY updated_at DESC`).all(userId, state)
    : db.prepare(`${IN} WHERE user_id=? AND state IN ('pending','active') ORDER BY updated_at DESC`).all(userId)
  return rows.map(incomingRow)
}

export const getIncoming = (db, userId, id) =>
  (typeof id === 'string' && id.startsWith('fg_') ? db.prepare(`${IN} WHERE id=? AND user_id=?`).get(id, userId) ?? null : null)

// The audit lines' grant, for an incoming one.
const auditGrant = (r) => ({ id: r.id, level: r.level, subject_kind: 'mission', subject_id: null, mission_num: null, owner_user_id: null, owner_name: r.owner_address })
const contactOf = (db, r) => db.prepare('SELECT * FROM contacts WHERE id=?').get(r.contact_id)

// An incoming grant ended (`by` 'owner' | 'grantee', or 'contact_removed'
// when the owner ended the contact, 'contact_ended' when the grantee did):
// its open card closes, and the grantee's log says so.
export function onIncomingEnded(ctx, before, by) {
  const { db } = ctx
  const from = plain(before.owner_address)
  const words = `mission "${titleOf(before.mission_title)}"`
  const mine = by === 'grantee' || by === 'contact_ended'
  if (before.state === 'pending') {
    closeMirror(ctx, {
      userId: before.user_id, itemId: before.item_id, consent: 'share', resolution: 'cancelled',
      author: mine ? 'user' : 'agent', comment: by === 'grantee' ? 'Declined.' : by === 'owner' ? `${from} withdrew the offer.` : 'The contact ended, so this share ended with it.',
    })
  }
  audit(ctx, before.user_id, {
    event: 'grant.revoked', contact: contactOf(db, before), grant: auditGrant(before), by: mine ? 'you' : 'peer',
    summary: by === 'grantee' ? `You ended the share of ${words} from ${from}`
      : by === 'owner' ? `${from} ended the share of ${words}`
        : `The share of ${words} from ${from} ended with the contact`,
  })
  // Its copy is gone (db.js fed_replica_drop): the apps drop it too.
  if (before.state === 'active' && before.replica_mission_id) sharedFrame(ctx, before.user_id, { event: 'mission_removed', mission_id: before.replica_mission_id, grant_id: before.id })
  changed(ctx, before.user_id, { grant_id: before.id })
}

// The grantee's apps, as for a share on one journal (sharing-events.js).
function sharedFrame({ hub }, userId, frame) {
  try { hub?.sendToClients(userId, { kind: 'shared', ...frame }) } catch { /* a frame is best-effort; the next read is right */ }
}

// `ctx` {db, hub, pushPipeline}; `federation` the loaded identity.
// → {federate, answer, leave, kick, inbound, outbound, setOutbox}
export function makeGrantFederation({ db, hub = null, pushPipeline = null, federation, now: clock = Date.now, log = console }) {
  const ctx = { db, hub, pushPipeline }
  let outbox = null
  const pending = new WeakMap()
  const addressOfUser = (userId) => `${db.prepare('SELECT name FROM users WHERE id=?').get(userId).name}@${federation.host}`
  // One notice a day per share, whichever way its events failed.
  const eventNoticeKey = (g) => `fed-event:${g.id}:${new Date(clock()).toISOString().slice(0, 10)}`
  const kick = () => { try { outbox?.kick() } catch (err) { log.error?.('federation: outbox kick failed', err) } }

  // --- The owner's journal: grants.js calls this inside its transaction ------

  function federate(what, g) {
    const from = `${g.owner_name}@${federation.host}`
    const to = `${g.grantee_name}@${g.grantee_journal}`
    if (what === 'offer') {
      const p = sharePreview(db, g.subject_id)
      enqueue(db, {
        userId: g.owner_user_id, from, to, op: OFFER_OP, subject: subjectOf(g.id), now: clock(),
        body: {
          grant: g.id, level: g.level, sent: g.sent_at,
          mission: { num: g.mission_num, title: sanitizePeerText(g.mission_title, TITLE_CAP) },
          preview: { milestones: p.milestones, items: p.items, comments: p.comments, attachments: p.attachments },
        },
      })
    } else if (what === 'revoke') {
      enqueue(db, { userId: g.owner_user_id, from, to, op: REVOKE_OP, body: { grant: g.id }, subject: subjectOf(g.id), urgent: true, cancelSubject: true, now: clock() })
    }
  }

  // A write on a mission (sharing-events.js notifyGrantees, after it has
  // committed): every contact on another journal it is shared with gets the
  // record's new state. A full outbox loses the event; the owner is told,
  // once a day per share, that the copy over there may be behind.
  function onMissionWrite(missionId, kind, ref) {
    const ids = db.prepare(`SELECT g.id FROM grants g JOIN contacts oc ON oc.id = g.contact_id AND oc.state = 'active' AND oc.peer_journal IS NOT NULL
      WHERE g.subject_kind = 'mission' AND g.subject_id = ? AND g.state = 'active' AND g.level <> 'owner'`).all(missionId)
    if (!ids.length) return
    let queued = false
    for (const { id } of ids) {
      const g = getGrantRaw(db, id)
      const to = `${g.grantee_name}@${g.grantee_journal}`
      try {
        queued = sendEvent(db, g, { kind, ref, from: `${g.owner_name}@${federation.host}`, to, now: clock() }) || queued
      } catch (err) {
        if (err.message !== 'outbox_full' && err.message !== 'too_large') throw err
        fileNotice(ctx, {
          userId: g.owner_user_id, title: `Couldn't update mission #${g.mission_num} for ${plain(to)}`,
          body: `Too much is waiting to go to ${g.grantee_journal}, so a change to mission **#${g.mission_num} ${titleOf(g.mission_title)}** was not sent. The copy they read may be behind. The share itself stands.`,
          idemKey: eventNoticeKey(g),
        })
      }
    }
    if (queued) kick()
  }
  onRemoteMissionWrite(db, onMissionWrite)

  // --- The grantee's journal: the card, the answer, leaving -----------------

  function raiseCard(r) {
    const from = plain(r.owner_address)
    const convoId = peopleConvo(ctx, r.user_id)
    const preview = JSON.parse(r.preview ?? '{}')
    card(ctx, {
      userId: r.user_id, convoId, sender: 'journal',
      payload: {
        kind: SHARE_CARD_KIND, direction: 'in', grant_id: r.id, level: r.level,
        owner: { user_id: null, name: r.owner_name, address: r.owner_address },
        mission: { id: null, num: r.mission_num, title: r.mission_title }, preview,
      },
    })
    const item = fileMirror(ctx, {
      userId: r.user_id, convoId, deviceId: 0, sender: 'journal', consent: 'share',
      title: `${from} wants to share a mission with you — ${titleOf(r.mission_title)}`,
      body: [
        `Your contact \`${from}\`, on another Matron journal, offers you mission **${titleOf(r.mission_title)}** to read.`,
        '',
        `- **You will see:** the mission's title, description and status, its milestones as text, and its items with their comments and attachments, live, under "shared by \`${from}\`".`,
        `- **Right now that is:** ${count(preview.milestones)} milestone(s), ${count(preview.items)} item(s), ${count(preview.comments)} comment(s), ${count(preview.attachments)} attachment(s).`,
        '- **Read-only:** you cannot change it, and nothing of yours is shared back.',
        '- Either of you can end the share at any time.',
        '',
        '**To answer:** tap **Accept** or **Decline**.',
      ].join('\n'),
      link: shareLink(r.id), actions: PEER_ACTIONS, idemKey: `consent:share:${r.id}:grantee:${r.updated_at}`,
    })
    if (item) db.prepare('UPDATE fed_grants_in SET item_id=? WHERE id=?').run(item.id, r.id)
  }

  // The grantee's tap. → {outcome: 'accepted'|'declined', row, before} or
  // null (not theirs). Errors: not_pending.
  function answer(userId, id, decision, deviceId = 0) {
    const out = db.transaction(() => {
      const before = getIncoming(db, userId, id)
      if (!before) return null
      if (before.state !== 'pending') fail('not_pending')
      const at = clock()
      const state = decision === 'decline' ? 'declined' : 'active'
      db.prepare('UPDATE fed_grants_in SET state=?, answered_at=?, updated_at=? WHERE id=?').run(state, at, at, before.id)
      const to = before.owner_address
      enqueue(db, { userId, from: addressOfUser(userId), to, op: ANSWER_OP, body: { grant: before.peer_grant_ref, decision, sent: before.offer_sent }, subject: subjectOf(before.peer_grant_ref), now: at })
      return { outcome: decision === 'decline' ? 'declined' : 'accepted', row: incomingById(db, before.id), before }
    })()
    if (!out) return null
    const from = plain(out.row.owner_address)
    const words = `mission "${titleOf(out.row.mission_title)}"`
    const comment = out.outcome === 'accepted' ? `Accepted — the mission will appear in your shared list, shared by \`${from}\`.` : 'Declined.'
    const closed = closeMirror(ctx, { userId, itemId: out.before.item_id, consent: 'share', resolution: 'decided', author: 'user', deviceId, comment })
    audit(ctx, userId, {
      event: out.outcome === 'accepted' ? 'grant.accepted' : 'grant.declined', contact: contactOf(db, out.row), grant: auditGrant(out.row),
      summary: out.outcome === 'accepted' ? `You accepted ${words} from ${from}` : `You declined ${words} from ${from}`,
    })
    changed(ctx, userId, { grant_id: out.row.id })
    kick()
    return { ...out, closed }
  }

  // The grantee ends it. null = not theirs. Errors: not_active.
  function leave(userId, id) {
    const out = db.transaction(() => {
      const before = getIncoming(db, userId, id)
      if (!before) return null
      if (!['pending', 'active'].includes(before.state)) fail('not_active')
      const at = clock()
      db.prepare("UPDATE fed_grants_in SET state='revoked', revoked_by='grantee', revoked_at=?, updated_at=? WHERE id=?").run(at, at, before.id)
      enqueue(db, {
        userId, from: addressOfUser(userId), to: before.owner_address, op: REVOKE_OP, body: { grant: before.peer_grant_ref, sent: before.offer_sent },
        subject: subjectOf(before.peer_grant_ref), urgent: true, cancelSubject: true, now: at,
      })
      return { row: incomingById(db, before.id), before }
    })()
    if (!out) return null
    onIncomingEnded(ctx, out.before, 'grantee')
    kick()
    return out
  }

  // --- Inbound ----------------------------------------------------------------

  // The local user `to` names, and their live contact for `from` under the
  // key that signed: anyone else is not a contact here.
  function party(d, envelope, peer) {
    const user = userByName(d, nameOf(envelope.to))
    const contact = user ? remoteContactRaw(d, user.id, nameOf(envelope.from), hostOf(envelope.from)) : null
    if (!contact || contact.state !== 'active' || contact.peer_journal_key !== peer.key_pub) fail('not_contact')
    return { user, contact }
  }
  const grantRef = (body) => {
    if (!body || typeof body !== 'object' || typeof body.grant !== 'string' || !GRANT_REF.test(body.grant)) fail('malformed')
    return body.grant
  }
  // The owner's side acts as their peer's journal did: no device, no agent.
  const peerWho = { kind: 'peer', deviceId: 0, name: 'journal' }

  const inbound = {
    // The grantee's journal: an offer.
    [OFFER_OP]: {
      apply({ db: d, envelope, peer, now }) {
        const ref = grantRef(envelope.body)
        const { level, mission, preview } = envelope.body
        const sent = Number.isSafeInteger(envelope.body.sent) ? envelope.body.sent : null
        if (typeof mission !== 'object' || mission === null || typeof mission.title !== 'string' || !Number.isSafeInteger(mission.num) || mission.num < 1) fail('malformed')
        if (level !== 'read') fail('level_unavailable')
        const { user, contact } = party(d, envelope, peer)
        const host = hostOf(envelope.from)
        const cur = d.prepare(`${IN} WHERE peer_host=? AND peer_grant_ref=?`).get(host, ref)
        if (cur && cur.user_id !== user.id) fail('not_contact')
        // An offer no newer than the last one heard (one still in flight
        // when it was withdrawn or sent again) changes nothing: offer_sent
        // only moves forward, and an ended share is not reopened by it.
        if (cur && cur.offer_sent != null && (sent == null || sent <= cur.offer_sent)) return { state: cur.state }
        // Offered again while live: nothing new to ask, but our answer from
        // now on names this offer.
        if (cur && ['pending', 'active'].includes(cur.state)) {
          d.prepare('UPDATE fed_grants_in SET offer_sent=? WHERE id=?').run(sent, cur.id)
          return { state: cur.state }
        }
        const fields = [level, sanitizePeerText(mission.title, TITLE_CAP) || 'Untitled', mission.num,
          JSON.stringify({ milestones: count(preview?.milestones), items: count(preview?.items), comments: count(preview?.comments), attachments: count(preview?.attachments) }), sent]
        let id = cur?.id
        if (cur) {
          d.prepare(`UPDATE fed_grants_in SET level=?, mission_title=?, mission_num=?, preview=?, offer_sent=?, state='pending', contact_id=?, item_id=NULL, revoked_by=NULL,
            answered_at=NULL, revoked_at=NULL, updated_at=? WHERE id=?`).run(...fields, contact.id, now, cur.id)
        } else {
          id = newId('fg')
          d.prepare(`INSERT INTO fed_grants_in(id, user_id, contact_id, peer_host, peer_grant_ref, owner_name, level, mission_title, mission_num, preview, offer_sent, state, created_at, updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(id, user.id, contact.id, host, ref, nameOf(envelope.from), ...fields, now, now)
        }
        pending.set(envelope, incomingById(d, id))
        return { state: 'pending' }
      },
      after({ envelope }) {
        const r = pending.get(envelope)
        if (!r) return
        raiseCard(r)
        audit(ctx, r.user_id, { event: 'grant.received', summary: `${plain(r.owner_address)} offered you mission "${titleOf(r.mission_title)}" to read`, contact: contactOf(db, r), grant: auditGrant(r), by: 'peer' })
        changed(ctx, r.user_id, { grant_id: r.id })
      },
      errors: { malformed: 400, not_contact: 403, level_unavailable: 409 },
    },
    // The owner's journal: the grantee's answer.
    [ANSWER_OP]: {
      apply({ db: d, envelope, peer, now }) {
        const ref = grantRef(envelope.body)
        if (!['approve', 'decline'].includes(envelope.body.decision)) fail('malformed')
        const { user } = party(d, envelope, peer)
        const out = answerRemoteGrant(d, { ownerUserId: user.id, grantId: ref, address: envelope.from, key: peer.key_pub, decision: envelope.body.decision, sent: envelope.body.sent, now })
        if (out.outcome !== 'same') pending.set(envelope, out)
        // Accepted: the mission's contents follow, in the same transaction.
        // An outbox too full for it leaves the share standing without a
        // copy over there; the owner is told.
        if (out.outcome === 'accepted') {
          try { sendSnapshot(d, out.grant, { from: envelope.to, to: envelope.from, now }) } catch (err) {
            if (err.message !== 'outbox_full' && err.message !== 'too_large') throw err
            pending.set(envelope, { ...out, snapshotFailed: err.message })
          }
        }
        return { state: out.grant.state }
      },
      after({ envelope }) {
        const out = pending.get(envelope)
        if (out) onGrantOutcome(ctx, peerWho, out)
        if (out?.outcome === 'accepted') kick()
        if (out?.snapshotFailed) {
          const g = out.grant
          fileNotice(ctx, {
            userId: g.owner_user_id, title: `Couldn't send mission #${g.mission_num} to ${plain(`${g.grantee_name}@${g.grantee_journal}`)}`,
            body: `Too much is waiting to go to ${g.grantee_journal}, so mission **#${g.mission_num} ${titleOf(g.mission_title)}** was not sent. The share itself stands.`,
            idemKey: `fed-snapshot-full:${g.id}:${g.updated_at}`,
          })
        }
      },
      errors: { malformed: 400, not_contact: 403, not_pending: 409 },
    },
    // The grantee's journal: a page of the mission's contents.
    [SNAPSHOT_OP]: {
      apply({ db: d, envelope, peer, now }) {
        const ref = grantRef(envelope.body)
        const { user } = party(d, envelope, peer)
        const r = d.prepare(`${IN} WHERE user_id=? AND peer_host=? AND peer_grant_ref=? AND owner_name=?`).get(user.id, hostOf(envelope.from), ref, nameOf(envelope.from))
        if (!r || r.state !== 'active') fail('not_active')
        const out = applySnapshotPage(d, r, envelope.body, now)
        if (out.done) pending.set(envelope, { ...out, row: r })
        return {}
      },
      after({ envelope }) {
        const p = pending.get(envelope)
        if (!p) return
        sharedFrame(ctx, p.row.user_id, {
          event: p.done === 'added' ? 'mission_added' : 'mission_changed', mission_id: p.missionId, grant_id: p.row.id,
          ...(p.done === 'changed' ? { what: 'snapshot' } : {}), owner: { user_id: 0, name: p.row.owner_address },
        })
      },
      errors: { malformed: 400, not_contact: 403, not_active: 409 },
    },
    // The grantee's journal: one record changed over there.
    [EVENT_OP]: {
      apply({ db: d, envelope, peer }) {
        const ref = grantRef(envelope.body)
        const { user } = party(d, envelope, peer)
        const r = d.prepare(`${IN} WHERE user_id=? AND peer_host=? AND peer_grant_ref=? AND owner_name=?`).get(user.id, hostOf(envelope.from), ref, nameOf(envelope.from))
        if (!r || r.state !== 'active') fail('not_active')
        const out = applyEvent(d, r, envelope.body)
        if (out) pending.set(envelope, { ...out, row: r })
        return {}
      },
      after({ envelope }) {
        const p = pending.get(envelope)
        if (!p) return
        sharedFrame(ctx, p.row.user_id, { event: 'mission_changed', mission_id: p.missionId, grant_id: p.row.id, what: p.kind, owner: { user_id: 0, name: p.row.owner_address } })
      },
      errors: { malformed: 400, not_contact: 403, not_active: 409 },
    },
    // Either side: the other one ended it.
    [REVOKE_OP]: {
      apply({ db: d, envelope, peer, now }) {
        const ref = grantRef(envelope.body)
        const { user } = party(d, envelope, peer)
        // The grantee left the owner's grant...
        const left = leaveRemoteGrant(d, { ownerUserId: user.id, grantId: ref, address: envelope.from, key: peer.key_pub, sent: envelope.body.sent, now })
        if (left) { pending.set(envelope, { left }); return {} }
        // ...or the owner withdrew one this user was offered.
        const cur = d.prepare(`${IN} WHERE user_id=? AND peer_host=? AND peer_grant_ref=? AND owner_name=? AND state IN ('pending','active')`)
          .get(user.id, hostOf(envelope.from), ref, nameOf(envelope.from))
        if (cur) {
          d.prepare("UPDATE fed_grants_in SET state='revoked', revoked_by='owner', revoked_at=?, updated_at=? WHERE id=?").run(now, now, cur.id)
          // An answer of ours still queued has nothing left to answer.
          d.prepare("UPDATE fed_outbox SET state='cancelled', ended_at=?, last_error='grant_ended' WHERE user_id=? AND peer_host=? AND subject=? AND state IN ('queued','dead')")
            .run(now, user.id, cur.peer_host, subjectOf(ref))
          pending.set(envelope, { ended: cur })
        }
        // Already over here: the same answer.
        return {}
      },
      after({ envelope }) {
        const p = pending.get(envelope)
        if (p?.left) onGrantRevoked(ctx, p.left.before, 'grantee')
        if (p?.ended) onIncomingEnded(ctx, p.ended, 'owner')
      },
      errors: { malformed: 400, not_contact: 403 },
    },
  }

  // --- Outbox hooks -----------------------------------------------------------

  const incomingFor = (d, entry) => d.prepare(`${IN} WHERE user_id=? AND peer_host=? AND peer_grant_ref=?`)
    .get(entry.user_id, hostOf(entry.to_addr), bodyOf(entry).grant)
  const bodyOf = (entry) => (typeof entry.body === 'string' ? JSON.parse(entry.body) : entry.body ?? {})
  const REASONS = {
    expired: 'could not be reached for 7 days', journal_not_allowed: 'is not one this journal federates with any more',
    peer_key_changed: 'changed its key', not_contact: 'no longer has you as a contact', not_pending: 'no longer has that offer open',
    level_unavailable: 'does not take that kind of share', peer_refused: 'does not accept messages from this journal',
  }
  const why = (error) => REASONS[error] ?? 'refused it'

  const outbound = {
    [OFFER_OP]: {
      // An offer withdrawn, or a contact ended, before it went out: nothing to send.
      stillAllowed(d, entry) {
        const g = getGrantRaw(d, bodyOf(entry).grant)
        return !!g && g.state === 'pending'
      },
      onDead(d, entry, { error }) {
        const g = getGrantRaw(d, bodyOf(entry).grant)
        if (g && g.state === 'pending') {
          const at = clock()
          d.prepare("UPDATE grants SET state='expired', updated_at=? WHERE id=? AND state='pending'").run(at, g.id)
          const to = plain(`${g.grantee_name}@${g.grantee_journal}`)
          fileNotice(ctx, {
            userId: g.owner_user_id, title: `Couldn't offer mission #${g.mission_num} to ${to}`,
            body: `Their journal at ${g.grantee_journal} ${why(error)}, so mission **#${g.mission_num} ${titleOf(g.mission_title)}** was not shared. You can offer it again.`,
            idemKey: `fed-offer-dead:${entry.id}`,
          })
          changed(ctx, g.owner_user_id, { grant_id: g.id })
        }
        return 'discard'
      },
    },
    [ANSWER_OP]: {
      stillAllowed(d, entry) {
        const r = incomingFor(d, entry)
        return !!r && r.state === (bodyOf(entry).decision === 'decline' ? 'declined' : 'active')
      },
      onDead(d, entry, { error }) {
        const r = incomingFor(d, entry)
        if (r && r.state === 'active' && bodyOf(entry).decision !== 'decline') {
          const at = clock()
          d.prepare("UPDATE fed_grants_in SET state='revoked', revoked_by='owner', revoked_at=?, updated_at=? WHERE id=?").run(at, at, r.id)
          fileNotice(ctx, {
            userId: r.user_id, title: `Couldn't accept mission "${titleOf(r.mission_title)}"`,
            body: `The journal at ${r.peer_host} ${why(error)}, so the share from \`${plain(r.owner_address)}\` did not start. Ask them to offer it again.`,
            idemKey: `fed-answer-dead:${entry.id}`,
          })
          changed(ctx, r.user_id, { grant_id: r.id })
        }
        return 'discard'
      },
    },
    [SNAPSHOT_OP]: {
      stillAllowed(d, entry) {
        const g = getGrantRaw(d, bodyOf(entry).grant)
        return !!g && g.state === 'active'
      },
      // The share stands, but their copy is not whole: the owner is told
      // once per snapshot. A share that ended over there meanwhile is not
      // news (its revoke is on the way).
      onDead(d, entry, { error }) {
        const body = bodyOf(entry)
        const g = getGrantRaw(d, body.grant)
        if (g && g.state === 'active' && error !== 'not_active') {
          const to = plain(`${g.grantee_name}@${g.grantee_journal}`)
          fileNotice(ctx, {
            userId: g.owner_user_id, title: `Couldn't send mission #${g.mission_num} to ${to}`,
            body: `Their journal at ${g.grantee_journal} ${why(error)}, so the copy of mission **#${g.mission_num} ${titleOf(g.mission_title)}** they read may be out of date or missing. The share itself stands.`,
            idemKey: `fed-snapshot-dead:${g.id}:${body.snap}`,
          })
        }
        return 'discard'
      },
    },
    [EVENT_OP]: {
      // And the record is still one the grantee view shows: a box that went
      // private since the event was queued keeps what it wrote at home.
      stillAllowed(d, entry) {
        const body = bodyOf(entry)
        const g = getGrantRaw(d, body.grant)
        if (!g || g.state !== 'active') return false
        return body.record === null || !!eventBody(d, g, body.kind, body.ref ?? null)
      },
      // As for a snapshot: the share stands, their copy may be behind. Once
      // a day per share, however many events died.
      onDead(d, entry, { error }) {
        const g = getGrantRaw(d, bodyOf(entry).grant)
        if (g && g.state === 'active' && error !== 'not_active') {
          const to = plain(`${g.grantee_name}@${g.grantee_journal}`)
          fileNotice(ctx, {
            userId: g.owner_user_id, title: `Couldn't update mission #${g.mission_num} for ${to}`,
            body: `Their journal at ${g.grantee_journal} ${why(error)}, so the copy of mission **#${g.mission_num} ${titleOf(g.mission_title)}** they read may be behind. The share itself stands.`,
            idemKey: eventNoticeKey(g),
          })
        }
        return 'discard'
      },
    },
    [REVOKE_OP]: {
      onDead(d, entry, { error }) {
        const host = hostOf(entry.to_addr)
        fileNotice(ctx, {
          userId: entry.user_id, title: `Couldn't tell ${host} that a share ended`,
          body: `The share with \`${plain(entry.to_addr)}\` is ended here, but their journal at ${host} ${why(error)}, so it may still show there until it hears.`,
          idemKey: `fed-grant-revoke-dead:${entry.id}`,
        })
        return 'discard'
      },
    },
  }
  return { federate, answer, leave, kick, inbound, outbound, setOutbox: (o) => { outbox = o } }
}
