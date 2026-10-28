// Pure DB state for contacts (spec 2026-10-02 matron-to-matron sharing,
// "Contacts"). No hub, cards, items or audit events here —
// src/sharing-events.js owns the side effects. Same stance as
// src/missions.js: every recoverable failure is a tagged Error the HTTP
// layer maps to one status; anything else is a bug and reaches the 500.
//
// A contact is mutual: one row per side, and nothing is shared except
// between two rows that are both 'active'. Being on the same journal makes
// nobody a contact (spec decision 8): the other person accepts once.
//
// Phase 1 writes same-journal rows only (peer_journal NULL, peer_user_id
// set). The address columns are federation's; every query here that joins
// two sides goes through peer_user_id.
import { newId } from './items.js'

export const CONTACT_STATES = ['awaiting_user', 'pending_out', 'pending_in', 'active', 'blocked', 'declined', 'removed', 'expired']
export const DECISIONS = ['approve', 'decline']
// An ask the user's own agent parked: the same 24 h the spawn and chat asks
// get. An ask waiting on the OTHER person never expires here — people take
// days — and the requester can withdraw it (removeContact).
export const OWN_ASK_TTL_MS = 24 * 60 * 60 * 1000
// Open asks one agent device may have parked across contacts and grants.
export const MAX_PARKED_PER_DEVICE = 10
// A grant that is, or may still become, live.
export const LIVE_GRANT_STATES = "('awaiting_owner','pending','active')"

const fail = (code) => { throw new Error(code) }

// The wire shape. `address` is how the person is written everywhere
// (`tim`, or `tim@tim.example` once journals federate). peer_user_id, the
// pinned key and the tracker mirror's id are internal.
export function contactRow(row) {
  if (!row) return null
  return {
    id: row.id,
    address: row.peer_journal ? `${row.peer_user}@${row.peer_journal}` : row.peer_user,
    peer_user: row.peer_user,
    peer_journal: row.peer_journal ?? null,
    display_name: row.display_name || row.peer_user,
    state: row.state,
    requested_by: row.requested_by ?? null,
    origin_convo_id: row.origin_convo_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    accepted_at: row.accepted_at ?? null,
    revoked_at: row.revoked_at ?? null,
  }
}

const rawById = (db, id) => db.prepare('SELECT * FROM contacts WHERE id=?').get(id)
const rawBetween = (db, userId, peerUserId) =>
  db.prepare('SELECT * FROM contacts WHERE user_id=? AND peer_user_id=? AND peer_journal IS NULL').get(userId, peerUserId)
const userName = (db, id) => db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name ?? null

// An unlisted account (users.unlisted, e.g. the App Store review login) is
// outside contacts altogether: it is in nobody's list, its own list is
// empty, and a request to it or from it is the same answer as a name that
// does not exist — so it can be neither found nor used to probe for names.
// Contact rows made before the flag was set are left as they are.
const isUnlisted = (db, userId) => !!db.prepare('SELECT unlisted FROM users WHERE id=?').get(userId)?.unlisted

// "Add contact" on the same journal lists the journal's users — names only
// (spec decision 4), never the caller, never an unlisted account.
export function listJournalUsers(db, userId) {
  if (isUnlisted(db, userId)) return []
  return db.prepare('SELECT name FROM users WHERE id<>? AND unlisted=0 ORDER BY name COLLATE NOCASE').all(userId).map((r) => ({ name: r.name }))
}

// By id (ct_…) or, for a same-journal peer, by name. Always the caller's
// own row. A username may itself start with ct_, so a ct_ reference that is
// not one of the caller's row ids is still tried as a name.
export function getContactRaw(db, userId, idOrName) {
  if (typeof idOrName !== 'string' || !idOrName) return null
  if (idOrName.startsWith('ct_')) {
    const row = rawById(db, idOrName)
    if (row && row.user_id === userId) return row
  }
  return db.prepare('SELECT * FROM contacts WHERE user_id=? AND peer_user=? AND peer_journal IS NULL').get(userId, idOrName) ?? null
}

export function listContacts(db, userId, { state = null } = {}) {
  const rows = state
    ? db.prepare('SELECT * FROM contacts WHERE user_id=? AND state=? ORDER BY updated_at DESC').all(userId, state)
    : db.prepare("SELECT * FROM contacts WHERE user_id=? AND state NOT IN ('removed','declined','expired') ORDER BY (state='active') DESC, updated_at DESC").all(userId)
  return rows.map(contactRow)
}

// The other side's row for one of mine (same journal), or null.
export function peerRowOf(db, row) {
  if (!row || row.peer_user_id == null) return null
  return rawBetween(db, row.peer_user_id, row.user_id) ?? null
}

// Both rows active: the only state in which anything is shared.
export function isMutual(db, row) {
  return !!row && row.state === 'active' && peerRowOf(db, row)?.state === 'active'
}

export function parkedAsks(db, deviceId) {
  return db.prepare(`SELECT
      (SELECT COUNT(*) FROM contacts WHERE origin_device_id=@d AND state='awaiting_user')
    + (SELECT COUNT(*) FROM grants WHERE origin_device_id=@d AND (state='awaiting_owner' OR pending_state='awaiting_owner')) AS n`).get({ d: deviceId }).n
}

function upsertOwn(db, { userId, peer, state, requestedBy, convoId, deviceId, now }) {
  const cur = rawBetween(db, userId, peer.id)
  if (cur) {
    db.prepare(`UPDATE contacts SET state=?, requested_by=?, origin_convo_id=?, origin_device_id=?, item_id=NULL,
      display_name=?, updated_at=?, accepted_at=NULL, revoked_at=NULL WHERE id=?`)
      .run(state, requestedBy, convoId, deviceId, peer.name, now, cur.id)
    return rawById(db, cur.id)
  }
  const id = newId('ct')
  db.prepare(`INSERT INTO contacts(id,user_id,peer_user,peer_journal,peer_user_id,display_name,state,requested_by,origin_convo_id,origin_device_id,created_at,updated_at)
    VALUES(?,?,?,NULL,?,?,?,?,?,?,?,?)`).run(id, userId, peer.name, peer.id, peer.name, state, requestedBy, convoId, deviceId, now, now)
  return rawById(db, id)
}

const setState = (db, id, state, now, extra = '') =>
  db.prepare(`UPDATE contacts SET state=?, updated_at=? ${extra} WHERE id=?`).run(state, now, id)

// Revokes every grant that is or may become live between two contact rows,
// in both directions (spec: "removal revokes every grant between the two").
// Returns the rows as they stood BEFORE, for the events layer. An accepted
// hand-over (level owner, active) is a record of something done, not
// access, and is left as it is.
const LIVE_NOT_HANDED = `state IN ${LIVE_GRANT_STATES} AND NOT (level = 'owner' AND state = 'active')`
function revokeGrantsBetween(db, contactIds, now) {
  const ids = contactIds.filter(Boolean)
  if (!ids.length) return []
  const marks = ids.map(() => '?').join(',')
  const rows = db.prepare(`SELECT * FROM grants WHERE contact_id IN (${marks}) AND ${LIVE_NOT_HANDED}`).all(...ids)
  if (rows.length) {
    // An ask the owner had not approved was never sent: its brief goes with
    // it, as when any other path ends one (grants.js forgetBrief).
    db.prepare(`UPDATE grants SET brief=NULL, exclude_media=NULL, keep_level=NULL, approved=NULL
      WHERE contact_id IN (${marks}) AND ${LIVE_NOT_HANDED} AND (state='awaiting_owner' OR pending_state='awaiting_owner')`).run(...ids)
    db.prepare(`UPDATE grants SET state='revoked', revoked_by='contact_removed', revoked_at=?, updated_at=?, pending_level=NULL, pending_state=NULL, pending_by=NULL, pending_at=NULL
      WHERE contact_id IN (${marks}) AND ${LIVE_NOT_HANDED}`).run(now, now, ...ids)
  }
  return rows
}

// The request leaves for the other person. Caller holds the transaction
// and has already put `own` in a state from which sending is right.
// Outcomes:
//   sent     the peer now has a pending_in row and gets the accept card
//   crossed  the peer had already asked us: both are active, no card
//   silent   the peer has blocked us — our row reads pending_out, nothing
//            is delivered, and the answer is the same as `sent` so a block
//            is not an oracle (spec: blocking refuses future invites)
function send(db, own, now) {
  const me = userName(db, own.user_id)
  const theirs = rawBetween(db, own.peer_user_id, own.user_id)
  if (theirs?.state === 'blocked') {
    setState(db, own.id, 'pending_out', now)
    return { outcome: 'silent', contact: rawById(db, own.id), peer: null, superseded: null }
  }
  if (theirs && (theirs.state === 'pending_out' || theirs.state === 'active')) {
    setState(db, own.id, 'active', now, `, accepted_at=${Number(now)}`)
    if (theirs.state !== 'active') setState(db, theirs.id, 'active', now, `, accepted_at=${Number(now)}`)
    return { outcome: 'crossed', contact: rawById(db, own.id), peer: rawById(db, theirs.id), superseded: null }
  }
  setState(db, own.id, 'pending_out', now)
  // Their own agent may have parked an ask for us that they never approved:
  // our request supersedes it (one card, the accept card), and the events
  // layer closes that ask's mirror.
  const superseded = theirs?.state === 'awaiting_user' ? theirs : null
  let peer
  if (theirs) {
    db.prepare(`UPDATE contacts SET state='pending_in', requested_by=NULL, origin_convo_id=NULL, origin_device_id=NULL, item_id=NULL,
      display_name=?, updated_at=?, accepted_at=NULL, revoked_at=NULL WHERE id=?`).run(me, now, theirs.id)
    peer = rawById(db, theirs.id)
  } else {
    const id = newId('ct')
    db.prepare(`INSERT INTO contacts(id,user_id,peer_user,peer_journal,peer_user_id,display_name,state,created_at,updated_at)
      VALUES(?,?,?,NULL,?,?,'pending_in',?,?)`).run(id, own.peer_user_id, me, own.user_id, me, now, now)
    peer = rawById(db, id)
  }
  return { outcome: 'sent', contact: rawById(db, own.id), peer, superseded }
}

// `by` is who is asking: 'user' (a client device — the user's own tap, so
// it goes straight out) or 'agent' (parked as awaiting_user until the user
// approves it on a card; convoId/deviceId say where the ask was made).
// Returns {outcome: 'parked'|'sent'|'crossed'|'silent'|'accepted', contact, peer?, superseded?}.
export function requestContact(db, { userId, peerName, by, convoId = null, deviceId = null, now = Date.now() }) {
  return db.transaction(() => {
    const peer = typeof peerName === 'string' ? db.prepare('SELECT id, name, unlisted FROM users WHERE name=?').get(peerName) : null
    // Unknown, "yourself", an unlisted account, and anyone at all when the
    // caller is unlisted are one answer.
    if (!peer || peer.id === userId || peer.unlisted || isUnlisted(db, userId)) fail('no_user')
    const cur = rawBetween(db, userId, peer.id)
    if (cur) {
      if (cur.state === 'active') fail('already_contact')
      if (cur.state === 'pending_out' || cur.state === 'awaiting_user') fail('pending')
      if (cur.state === 'blocked') fail('blocked')
      if (cur.state === 'pending_in') {
        // They asked first. The user asking back IS the accept; an agent
        // asking back is not — the accept card is the user's to tap.
        if (by !== 'user') fail('pending_in')
        return accept(db, cur, now)
      }
    }
    if (by === 'agent') {
      if (parkedAsks(db, deviceId) >= MAX_PARKED_PER_DEVICE) fail('too_many_asks')
      const own = upsertOwn(db, { userId, peer, state: 'awaiting_user', requestedBy: 'agent', convoId, deviceId, now })
      return { outcome: 'parked', contact: own, peer: null, superseded: null }
    }
    const own = upsertOwn(db, { userId, peer, state: 'pending_out', requestedBy: 'user', convoId: null, deviceId, now })
    return send(db, own, now)
  })()
}

function accept(db, own, now) {
  const theirs = peerRowOf(db, own)
  // The requester withdrew between the card and the tap.
  if (!theirs || theirs.state !== 'pending_out') fail('not_pending')
  setState(db, own.id, 'active', now, `, accepted_at=${Number(now)}`)
  setState(db, theirs.id, 'active', now, `, accepted_at=${Number(now)}`)
  return { outcome: 'accepted', contact: rawById(db, own.id), peer: rawById(db, theirs.id), superseded: null, before: own }
}

// The user's answer to one of their two cards. null = no such row of
// theirs. Outcomes: 'sent' | 'crossed' | 'silent' (approved own agent's
// ask), 'withdrawn' (declined it), 'expired' (it was past its 24 h),
// 'accepted' | 'declined' (the other person's request). `before` is the
// row as the card saw it.
export function answerContact(db, { userId, contactId, decision, now = Date.now() }) {
  return db.transaction(() => {
    const own = getContactRaw(db, userId, contactId)
    if (!own) return null
    if (own.state === 'awaiting_user') {
      if (now - own.updated_at > OWN_ASK_TTL_MS) {
        // Committed, not thrown: the row really is expired now, and the
        // caller closes its mirror before answering 409.
        setState(db, own.id, 'expired', now)
        return { outcome: 'expired', contact: rawById(db, own.id), peer: null, superseded: null, before: own }
      }
      if (decision === 'decline') {
        setState(db, own.id, 'declined', now)
        return { outcome: 'withdrawn', contact: rawById(db, own.id), peer: null, superseded: null, before: own }
      }
      return { ...send(db, own, now), before: own }
    }
    if (own.state === 'pending_in') {
      if (decision === 'decline') {
        const theirs = peerRowOf(db, own)
        setState(db, own.id, 'declined', now)
        if (theirs?.state === 'pending_out') setState(db, theirs.id, 'declined', now)
        return { outcome: 'declined', contact: rawById(db, own.id), peer: theirs ? rawById(db, theirs.id) : null, superseded: null, before: own }
      }
      return accept(db, own, now)
    }
    fail('not_pending')
  })()
}

// Remove, withdraw, or (with block) block. Works from any state but the
// ones already ended, and a blocked row (unblockContact is its only exit). The peer's row follows — except a row in which THEY
// blocked us, which stays theirs. Every live grant between the two is
// revoked in the same transaction.
function end(db, { userId, contactId, to, now }) {
  return db.transaction(() => {
    const own = getContactRaw(db, userId, contactId)
    if (!own) return null
    if (own.state === to || (to === 'removed' && ['declined', 'expired'].includes(own.state))) fail('not_active')
    // Removing a blocked row would read exactly like an unblock, and an
    // agent may remove but never unblock. The one way out of 'blocked' is
    // unblockContact, which only the user's own device reaches.
    if (own.state === 'blocked') fail('blocked')
    const theirs = peerRowOf(db, own)
    setState(db, own.id, to, now, `, revoked_at=${Number(now)}`)
    // An ask their own agent parked (awaiting_user) is theirs to answer and
    // is left alone: if we blocked, approving it sends nothing (send's
    // `silent`).
    const touchPeer = !!theirs && ['pending_in', 'pending_out', 'active'].includes(theirs.state)
    if (touchPeer) setState(db, theirs.id, 'removed', now, `, revoked_at=${Number(now)}`)
    const revokedGrants = revokeGrantsBetween(db, [own.id, theirs?.id], now)
    return {
      contact: rawById(db, own.id), before: own,
      peer: touchPeer ? rawById(db, theirs.id) : null, peerBefore: touchPeer ? theirs : null,
      revokedGrants,
    }
  })()
}

export const removeContact = (db, { userId, contactId, now = Date.now() }) => end(db, { userId, contactId, to: 'removed', now })
export const blockContact = (db, { userId, contactId, now = Date.now() }) => end(db, { userId, contactId, to: 'blocked', now })

// Unblocking makes nobody a contact again: the row reads 'removed', and a
// fresh request (and accept) is needed.
export function unblockContact(db, { userId, contactId, now = Date.now() }) {
  return db.transaction(() => {
    const own = getContactRaw(db, userId, contactId)
    if (!own) return null
    if (own.state !== 'blocked') fail('not_blocked')
    setState(db, own.id, 'removed', now)
    return { contact: rawById(db, own.id), before: own }
  })()
}

// The 24 h sweep for asks an agent parked for its own user. Returns the
// rows as they stood before, for the events layer to close their mirrors.
export function expireContactAsks(db, now = Date.now()) {
  return db.transaction(() => {
    const rows = db.prepare("SELECT * FROM contacts WHERE state='awaiting_user' AND updated_at < ?").all(now - OWN_ASK_TTL_MS)
    for (const r of rows) setState(db, r.id, 'expired', now)
    return rows
  })()
}

export function setContactItem(db, contactId, itemId) {
  db.prepare('UPDATE contacts SET item_id=? WHERE id=?').run(itemId, contactId)
}
