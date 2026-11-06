// Contacts across journals (docs/protocol.md "Federation": contacts across
// journals). Phase 5 stage 5 of the matron-to-matron sharing design.
//
// Only an invite link makes a contact on another journal; nobody can ask
// an address they typed. Alice's journal mints a single-use, 7-day invite
// and shows her the link once:
//
//   matron://contact?v=1&j=<journal host>&u=<alice's name>&t=<token>&fp=<key fingerprint>
//
// Bob opens it in his app. His journal fetches Alice's journal's
// well-known, refuses it unless its key fingerprint is the one in the link
// (so the link authenticates the key: no trust on first use), and shows Bob
// who is asking. Bob's tap is his consent: his journal pins the key, writes
// his row `pending_out`, and queues the signed `contact.accept_invite
// {token, display_name}` to Alice's journal. That journal admits the
// envelope only because it carries one of its own open invites (the
// inbound handler's discovery), verifies it against the key Bob's journal's
// well-known serves, pins that key, writes Alice's row `active` and marks
// the invite used, all in the transaction that writes the receipt. Minting
// the invite was Alice's consent, so she gets a notice, not a card. Bob's
// row turns `active` when the acknowledgement comes back.
//
// Removing or blocking a contact on another journal ends it here at once
// (contacts.js, which also revokes every grant between the two) and sends
// `contact.remove`, urgent, cancelling anything still queued for that
// contact. A block travels as a removal: the other person is told only
// that the contact ended, never that it was a block, and the block itself
// stays here, refusing every later invite answer from that address.
//
// A journal whose well-known starts serving a different key is marked
// `key_changed` (fed_peers): every op to and from it stops, and each user
// with a contact there gets one notice. There is no rotation in phase 5: a
// fresh invite between the two people pins the new key for that contact.

import { createHash, randomBytes } from 'node:crypto'
import { newId } from './items.js'
import { formatFingerprint, isAddress } from './federation-envelope.js'
import { journalAllowed } from './federation-identity.js'
import { enqueue } from './federation-outbox.js'
import { sanitizePeerText, plainText as plain } from './peer-text.js'
import { contactRow, getContactRaw, remoteContactRaw, removeContact } from './contacts.js'
import { audit, changed, fileNotice, onGrantRevoked, addressOf } from './sharing-events.js'
import { onIncomingEnded } from './federation-grants.js'

export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000
export const MAX_OPEN_INVITES = 20
export const MAX_REMOTE_CONTACTS = 200
// How long a used, revoked or expired invite stays in the user's list.
export const INVITE_LIST_DAYS = 30
export const ACCEPT_OP = 'contact.accept_invite'
export const REMOVE_OP = 'contact.remove'
const NAME_CAP = 80

// How another journal's refusal of an invite answer is put to the user. The
// code is that journal's word, so only known codes are shown.
const REFUSALS = {
  peer_refused: 'does not accept contacts from this journal',
  too_many_contacts: 'refused it: they have too many contacts on other journals',
  not_here: 'has no such user',
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const FP_RE = /^[a-z2-7]{26}$/
const LIVE_REMOTE = "('active','pending_out')"

const fail = (code) => { throw new Error(code) }
const hostOf = (address) => address.slice(address.indexOf('@') + 1)
const nameOf = (address) => address.slice(0, address.indexOf('@'))
const hashToken = (token) => createHash('sha256').update(token).digest('hex')
// The outbox orders ops per (peer, subject): one subject per pair of
// people, so two users here with contacts at the same address never wait
// for, or cancel, each other's ops.
const subjectOf = (local, remote) => `contact:${local}|${remote}`
const userById = (db, id) => db.prepare('SELECT id, name, unlisted FROM users WHERE id=?').get(id)
const userByName = (db, name) => db.prepare('SELECT id, name, unlisted FROM users WHERE name=?').get(name)
// An address in a sentence of the journal's: peer text, flattened (plainText
// also drops backticks, so it is safe inside a code span).
const who = (row) => plain(addressOf(row))

// --- Links --------------------------------------------------------------------

export function inviteLink({ host, user, token, fingerprint }) {
  const q = new URLSearchParams({ v: '1', j: host, u: user, t: token, fp: fingerprint })
  return `matron://contact?${q}`
}

// → {host, user, token, fingerprint} or null. Strict: exactly the fields a
// link this journal makes carries, each in its own shape.
export function parseInviteLink(link) {
  if (typeof link !== 'string' || link.length > 1024) return null
  let u
  try { u = new URL(link.trim()) } catch { return null }
  if (u.protocol !== 'matron:' || u.host !== 'contact' || (u.pathname && u.pathname !== '/' && u.pathname !== '')) return null
  const p = u.searchParams
  if ([...p.keys()].some((k) => !['v', 'j', 'u', 't', 'fp'].includes(k))) return null
  if ([...new Set(p.keys())].length !== [...p.keys()].length) return null
  if (p.get('v') !== '1') return null
  const host = String(p.get('j') ?? '').toLowerCase()
  const user = String(p.get('u') ?? '')
  const token = String(p.get('t') ?? '')
  const fingerprint = String(p.get('fp') ?? '').toLowerCase()
  if (!isAddress(`${user}@${host}`) || !TOKEN_RE.test(token) || !FP_RE.test(fingerprint)) return null
  return { host, user, token, fingerprint }
}

// --- Invites (the inviter's journal) -------------------------------------------

const inviteState = (r, now) => (r.revoked_at ? 'revoked' : r.used_at ? 'used' : r.expires_at <= now ? 'expired' : 'open')
export const inviteView = (r, now = Date.now()) => ({
  id: r.id, state: inviteState(r, now), created_at: r.created_at, expires_at: r.expires_at,
  used_at: r.used_at ?? null, used_by: r.used_by_address ?? null, revoked_at: r.revoked_at ?? null,
})

// → {invite, link}. The link is returned this once: only the token's hash
// is kept. Errors: 'unlisted', 'too_many_invites'.
export function createInvite(db, { userId, federation, now = Date.now(), random = randomBytes }) {
  return db.transaction(() => {
    const user = userById(db, userId)
    if (!user || user.unlisted) fail('unlisted')
    const open = db.prepare('SELECT COUNT(*) AS n FROM fed_invites WHERE user_id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?').get(userId, now).n
    if (open >= MAX_OPEN_INVITES) fail('too_many_invites')
    const token = random(32).toString('base64url')
    const id = newId('inv')
    db.prepare('INSERT INTO fed_invites(id, token_hash, user_id, created_at, expires_at) VALUES(?,?,?,?,?)')
      .run(id, hashToken(token), userId, now, now + INVITE_TTL_MS)
    const row = db.prepare('SELECT * FROM fed_invites WHERE id=?').get(id)
    return { invite: inviteView(row, now), link: inviteLink({ host: federation.host, user: user.name, token, fingerprint: federation.key.fingerprint }) }
  })()
}

export function listInvites(db, userId, now = Date.now()) {
  return db.prepare('SELECT * FROM fed_invites WHERE user_id=? AND created_at>? ORDER BY created_at DESC')
    .all(userId, now - INVITE_LIST_DAYS * 24 * 3600 * 1000).map((r) => inviteView(r, now))
}

// null when it is not the caller's. Error: 'not_open'.
export function revokeInvite(db, { userId, inviteId, now = Date.now() }) {
  const row = db.prepare('SELECT * FROM fed_invites WHERE id=? AND user_id=?').get(inviteId, userId)
  if (!row) return null
  if (inviteState(row, now) !== 'open') fail('not_open')
  db.prepare('UPDATE fed_invites SET revoked_at=? WHERE id=?').run(now, row.id)
  return inviteView({ ...row, revoked_at: now }, now)
}

// The invite `token` names, if `userName` minted it and `from` may use it:
// open, or already used by that same address while the contact it made is
// still live. A second answer from the same person is a retry of the same
// yes, never a new one: once the contact has ended, a spent link is spent.
// `retryKey` is then the key that contact is pinned to; the retry must be
// signed by it.
function usableInvite(db, userName, token, from, now) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null
  const user = userByName(db, userName)
  if (!user || user.unlisted) return null
  const row = db.prepare('SELECT * FROM fed_invites WHERE token_hash=? AND user_id=?').get(hashToken(token), user.id)
  if (!row || row.revoked_at || row.expires_at <= now) return null
  if (!row.used_at) return { row, user, retryKey: null }
  if (row.used_by_address !== from) return null
  const made = remoteContactRaw(db, user.id, nameOf(from), hostOf(from))
  if (made?.state !== 'active') return null
  return { row, user, retryKey: made.peer_journal_key }
}

// --- Peers --------------------------------------------------------------------

// The contacts of this journal's users whose pin is not `pub` at `host`:
// the ones a new key at that journal cuts off.
const contactsOnOtherKeys = (db, host, pub) =>
  db.prepare(`SELECT * FROM contacts WHERE peer_journal=? AND state IN ${LIVE_REMOTE} AND (peer_journal_key IS NULL OR peer_journal_key<>?)`).all(host, pub)

// A well-known just fetched over TLS, compared with what this journal
// knows of that host. → 'new' | 'same' | 'changed' | 'blocked'. A different
// key marks a known journal key_changed (the old key stays stored, so
// nothing verifies against the new one until a user's tap pins it).
// Returns the contacts cut off when this call made the change.
function observeKey(db, host, pub, now) {
  const row = db.prepare('SELECT * FROM fed_peers WHERE host=?').get(host)
  if (!row) return { seen: 'new', cut: [] }
  if (row.state === 'blocked') return { seen: 'blocked', cut: [] }
  if (row.key_pub === pub) {
    if (row.state === 'key_changed') db.prepare("UPDATE fed_peers SET state='active', last_error=NULL WHERE host=?").run(host)
    return { seen: 'same', cut: [] }
  }
  if (row.state === 'key_changed') return { seen: 'changed', cut: [] }
  db.prepare("UPDATE fed_peers SET state='key_changed', last_error='key_changed' WHERE host=?").run(host)
  return { seen: 'changed', cut: contactsOnOtherKeys(db, host, pub) }
}

// A user's consent pins `pub` for `host`. → the contacts this cut off (pinned
// to an earlier key), for their notices. Never unblocks: caller checks.
function pinPeer(db, { host, baseUrl, pub, now }) {
  const row = db.prepare('SELECT * FROM fed_peers WHERE host=?').get(host)
  if (!row) {
    db.prepare("INSERT INTO fed_peers(host, base_url, key_pub, state, first_seen) VALUES(?,?,?,'active',?)").run(host, baseUrl, pub, now)
    return []
  }
  db.prepare("UPDATE fed_peers SET base_url=?, key_pub=?, state='active', last_error=NULL WHERE host=?").run(baseUrl, pub, host)
  return row.key_pub === pub && row.state === 'active' ? [] : contactsOnOtherKeys(db, host, pub)
}

const queuedAnswer = (db, userId, address) =>
  !!db.prepare("SELECT 1 FROM fed_outbox WHERE user_id=? AND to_addr=? AND op=? AND state='queued'").get(userId, address, ACCEPT_OP)

// The row is waiting on the answer `entry` carries: a new contact
// (pending_out), or a live one reconnecting under the key the user
// consented to (entry.meta.key).
const awaitingAnswer = (row, entry) => row?.state === 'pending_out' ||
  (row?.state === 'active' && !!entry?.meta?.key && row.peer_journal_key !== entry.meta.key)

const liveRemoteCount = (db, userId) =>
  db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE user_id=? AND peer_journal IS NOT NULL AND state IN ${LIVE_REMOTE}`).get(userId).n

// Writes the caller's row for `name@host` in `state` with `pub` pinned,
// over whatever row was there (a removed or expired one, or one on an old
// key). → the row.
function putRemoteRow(db, { userId, name, host, pub, state, displayName, requestedBy, now }) {
  const cur = remoteContactRaw(db, userId, name, host)
  const accepted = state === 'active' ? now : null
  if (cur) {
    db.prepare(`UPDATE contacts SET state=?, peer_journal_key=?, display_name=?, requested_by=?, origin_convo_id=NULL, origin_device_id=NULL,
      item_id=NULL, updated_at=?, accepted_at=?, revoked_at=NULL WHERE id=?`).run(state, pub, displayName, requestedBy, now, accepted, cur.id)
    return remoteContactRaw(db, userId, name, host)
  }
  db.prepare(`INSERT INTO contacts(id,user_id,peer_user,peer_journal,peer_journal_key,peer_user_id,display_name,state,requested_by,created_at,updated_at,accepted_at)
    VALUES(?,?,?,?,?,NULL,?,?,?,?,?,?)`).run(newId('ct'), userId, name, host, pub, displayName, state, requestedBy, now, now, accepted)
  return remoteContactRaw(db, userId, name, host)
}

// --- The contact federation ------------------------------------------------------

// `ctx` is {db, hub, pushPipeline}; `federation` the loaded identity;
// `client` the federation client; the outbox is set once it exists.
// → {createInvite, listInvites, revokeInvite, preview, accept, queueEnd, kick,
//    inbound, outbound, setOutbox}
export function makeContactFederation({ db, hub = null, pushPipeline = null, federation, client, now: clock = Date.now, log = console }) {
  const ctx = { db, hub, pushPipeline }
  let outbox = null
  const myAddress = (userId) => `${userById(db, userId).name}@${federation.host}`
  // What each applied op left for its after hook, keyed by its envelope.
  const pending = new WeakMap()

  function noticeCut(cut, host) {
    const byUser = new Map()
    for (const c of cut) {
      if (!byUser.has(c.user_id)) byUser.set(c.user_id, [])
      byUser.get(c.user_id).push(c)
    }
    for (const [userId, rows] of byUser) {
      // In code spans: a markdown renderer would autolink an address as email.
      const names = rows.map((r) => `\`${who(r)}\``).join(', ')
      fileNotice(ctx, {
        userId, title: `The journal at ${host} changed its key`,
        body: `Matron can no longer check that messages from ${names} really come from ${rows.length === 1 ? 'them' : 'those contacts'}, so nothing is sent to or accepted from ${host} for ${rows.length === 1 ? 'that contact' : 'them'}. To reconnect, ask for a fresh invite link and open it.`,
        idemKey: `fed-key:${host}:${rows.map((r) => r.id).join(',')}:${rows[0].updated_at}`,
      })
      changed(ctx, userId)
    }
  }

  // Everything the preview and the accept check, in order. `link` is the
  // invite; the well-known is fetched once and its key must be the link's.
  async function inspect(userId, link) {
    const inv = parseInviteLink(link)
    if (!inv) fail('bad_link')
    if (inv.host === federation.host) fail('own_journal')
    if (!journalAllowed(federation, inv.host)) fail('journal_not_allowed')
    const user = userById(db, userId)
    if (!user || user.unlisted) fail('unlisted')
    let wk
    try { wk = await client.fetchWellKnown(inv.host) } catch (err) {
      fail(err.message === 'bad_well_known' ? 'bad_journal' : 'unreachable')
    }
    // What the journal serves is news whatever the link says: an old link
    // opened after a key change still reveals the change.
    const { seen, cut } = observeKey(db, inv.host, wk.pub, clock())
    if (cut.length) noticeCut(cut, inv.host)
    if (wk.fingerprint !== inv.fingerprint) fail('fingerprint_mismatch')
    if (seen === 'blocked') fail('journal_blocked')
    return { inv, wk, user, address: `${inv.user}@${inv.host}`, seen }
  }

  // POST /contacts/invites/open: who the link is from, before any consent.
  async function preview(userId, link) {
    const { inv, address, seen } = await inspect(userId, link)
    const existing = getContactRaw(db, userId, address)
    return {
      inviter: { address, name: inv.user, journal: inv.host, fingerprint: formatFingerprint(inv.fingerprint) },
      // The journal is known here under another key: accepting pins this one.
      key_changed: seen === 'changed',
      contact: existing && !['removed', 'declined', 'expired'].includes(existing.state) ? contactRow(existing) : null,
    }
  }

  // POST /contacts/invites/accept: the user's tap. → the row, pending_out.
  async function accept(userId, link) {
    const { inv, wk, user, address } = await inspect(userId, link)
    const at = clock()
    const { row, cut } = db.transaction(() => {
      const cur = remoteContactRaw(db, userId, inv.user, inv.host)
      if (cur?.state === 'blocked') fail('blocked')
      if (cur?.state === 'pending_out') fail('pending')
      if (cur?.state === 'active' && cur.peer_journal_key === wk.pub) fail('already_contact')
      // A live contact on an old key reconnecting: its row stays as it is
      // (listed, key_changed) until the answer is acknowledged, so a
      // reconnect that fails hides nothing.
      const reconnect = cur?.state === 'active'
      if (reconnect && queuedAnswer(db, userId, address)) fail('pending')
      if (!reconnect && liveRemoteCount(db, userId) >= MAX_REMOTE_CONTACTS) fail('too_many_contacts')
      const cutOff = pinPeer(db, { host: inv.host, baseUrl: wk.baseUrl, pub: wk.pub, now: at })
      const own = reconnect
        ? remoteContactRaw(db, userId, inv.user, inv.host)
        : putRemoteRow(db, { userId, name: inv.user, host: inv.host, pub: wk.pub, state: 'pending_out', displayName: inv.user, requestedBy: 'user', now: at })
      const from = `${user.name}@${federation.host}`
      // meta.key: the key this user consented to. The answer is acknowledged
      // under it or not at all, whatever another user here pins meanwhile.
      enqueue(db, {
        userId, from, to: address, op: ACCEPT_OP, body: { token: inv.token, display_name: user.name },
        subject: subjectOf(from, address), meta: { key: wk.pub }, now: at,
      })
      return { row: own, cut: cutOff.filter((c) => c.id !== own.id) }
    })()
    if (cut.length) noticeCut(cut, inv.host)
    audit(ctx, userId, { event: 'contact.requested', summary: `You accepted ${who(row)}'s invite`, contact: row, by: 'user' })
    changed(ctx, userId, { contact_id: row.id })
    outbox?.kick()
    return row
  }

  // Inside the transaction that ends a contact on another journal (removeContact
  // or blockContact): queue `contact.remove` to tell that journal, so the
  // ending and the message are one commit. A block reads as a removal
  // there. Anything still queued for the contact (an invite answer) is
  // cancelled. kick() afterwards, once committed.
  function queueEnd(out) {
    const before = out?.before
    if (!before?.peer_journal || !['active', 'pending_out'].includes(before.state)) return
    const from = myAddress(before.user_id)
    const to = addressOf(before)
    enqueue(db, { userId: before.user_id, from, to, op: REMOVE_OP, body: {}, subject: subjectOf(from, to), urgent: true, cancelSubject: true, now: clock() })
  }

  // --- Inbound ops (the inviter's journal, and either side for remove) -------

  const inbound = {
    [ACCEPT_OP]: {
      admits: ({ db: d, envelope, now }) => !!usableInvite(d, nameOf(envelope.to), envelope.body?.token, envelope.from, now),
      apply({ db: d, envelope, peer, now }) {
        const body = envelope.body
        if (!body || typeof body !== 'object' || typeof body.display_name !== 'string') fail('malformed')
        const found = usableInvite(d, nameOf(envelope.to), body.token, envelope.from, now)
        if (!found) fail('invite_invalid')
        const { row: invite, user, retryKey } = found
        if (retryKey && retryKey !== peer.key_pub) fail('invite_invalid')
        const name = nameOf(envelope.from)
        const host = hostOf(envelope.from)
        const cur = remoteContactRaw(d, user.id, name, host)
        // A block refuses every invite answer from that address, and says
        // nothing a used or expired invite would not.
        if (cur?.state === 'blocked') fail('invite_invalid')
        const wasActive = cur?.state === 'active' && cur.peer_journal_key === peer.key_pub
        if (!wasActive && !(cur && ['active', 'pending_out'].includes(cur.state)) && liveRemoteCount(d, user.id) >= MAX_REMOTE_CONTACTS) fail('too_many_contacts')
        const cut = peer.discovered ? pinPeer(d, { host, baseUrl: peer.base_url, pub: peer.key_pub, now }) : []
        const displayName = sanitizePeerText(body.display_name, NAME_CAP) || name
        const row = wasActive ? cur : putRemoteRow(d, { userId: user.id, name, host, pub: peer.key_pub, state: 'active', displayName, requestedBy: null, now })
        if (!invite.used_at) d.prepare('UPDATE fed_invites SET used_at=?, used_by_address=? WHERE id=?').run(now, envelope.from, invite.id)
        pending.set(envelope, { row, wasActive, cut: cut.filter((c) => c.id !== row.id), host })
        return { user: user.name, display_name: user.name }
      },
      after({ envelope }) {
        const p = pending.get(envelope)
        if (!p) return
        if (p.cut.length) noticeCut(p.cut, p.host)
        if (p.wasActive) return
        const name = who(p.row)
        audit(ctx, p.row.user_id, { event: 'contact.accepted', summary: `${name} accepted your invite: you are now contacts`, contact: p.row, by: 'peer' })
        fileNotice(ctx, {
          userId: p.row.user_id, title: `${name} accepted your invite`,
          body: `\`${name}\` used your invite link and is now your contact. Being contacts shares nothing by itself: every mission share is asked for separately, and you can remove or block a contact at any time.`,
          idemKey: `fed-invite-used:${p.row.id}:${p.row.updated_at}`,
        })
        changed(ctx, p.row.user_id, { contact_id: p.row.id })
      },
      errors: { malformed: 400, invite_invalid: 403, too_many_contacts: 403 },
    },
    [REMOVE_OP]: {
      apply({ db: d, envelope, peer, now }) {
        const user = userByName(d, nameOf(envelope.to))
        const cur = remoteContactRaw(d, user.id, nameOf(envelope.from), hostOf(envelope.from))
        // Only the contact this key was pinned for; anything else is already
        // over here, and a removal is the same answer either way.
        if (!cur || cur.peer_journal_key !== peer.key_pub || !['active', 'pending_out'].includes(cur.state)) return {}
        const out = removeContact(d, { userId: user.id, contactId: cur.id, now })
        // An invite answer of ours still queued for them has nothing to do.
        d.prepare("UPDATE fed_outbox SET state='cancelled', ended_at=?, last_error='contact_ended' WHERE user_id=? AND peer_host=? AND subject=? AND state='queued'")
          .run(now, user.id, hostOf(envelope.from), subjectOf(envelope.to, envelope.from))
        pending.set(envelope, out)
        return {}
      },
      after({ envelope }) {
        const out = pending.get(envelope)
        if (!out) return
        const name = who(out.contact)
        audit(ctx, out.contact.user_id, {
          event: 'contact.removed', contact: out.contact, by: 'peer',
          summary: out.before.state === 'active' ? `${name} is no longer your contact` : `${name}'s invite ended`,
        })
        for (const g of out.revokedGrants) onGrantRevoked(ctx, g, 'contact_removed')
        for (const r of out.endedIncoming ?? []) onIncomingEnded(ctx, r, 'contact_removed')
        changed(ctx, out.contact.user_id, { contact_id: out.contact.id })
      },
      errors: {},
    },
  }

  // --- Outbox hooks (the invitee's journal, and either side for remove) ------

  const rowFor = (d, entry) => remoteContactRaw(d, entry.user_id, nameOf(entry.to_addr), hostOf(entry.to_addr))
  const outbound = {
    [ACCEPT_OP]: {
      stillAllowed(d, entry) {
        const row = rowFor(d, entry)
        if (!awaitingAnswer(row, entry)) return false
        // Another user here pinned a different key for that journal since:
        // this answer would be acknowledged under a key nobody asked this
        // user about. It ends, and onDead says so.
        if (entry.meta?.key && row.journal_key_now !== entry.meta.key) return 'key_changed'
        return true
      },
      onAcked(d, entry, result) {
        const row = rowFor(d, entry)
        if (!awaitingAnswer(row, entry)) return undefined
        const at = clock()
        const displayName = sanitizePeerText(result?.display_name, NAME_CAP) || row.peer_user
        d.prepare("UPDATE contacts SET state='active', peer_journal_key=?, display_name=?, accepted_at=?, updated_at=? WHERE id=?")
          .run(entry.meta?.key ?? row.peer_journal_key, displayName, at, at, row.id)
        const fresh = rowFor(d, entry)
        return () => {
          audit(ctx, row.user_id, { event: 'contact.accepted', summary: `You and ${who(fresh)} are now contacts`, contact: fresh })
          changed(ctx, row.user_id, { contact_id: row.id })
        }
      },
      onDead(d, entry, { error }) {
        const row = rowFor(d, entry)
        if (awaitingAnswer(row, entry)) {
          const at = clock()
          const reconnect = row.state === 'active'
          // A new contact ends; a live one reconnecting stays as it was.
          if (!reconnect) d.prepare("UPDATE contacts SET state='expired', updated_at=? WHERE id=? AND state='pending_out'").run(at, row.id)
          const name = who(row)
          const why = error === 'key_changed'
            ? `The journal at ${row.peer_journal} changed its key while this was waiting. Ask ${plain(row.peer_user)} for a fresh invite link.`
            : error === 'invite_invalid'
            ? `The invite link has already been used, has expired or was withdrawn. Ask ${plain(row.peer_user)} for a new one.`
            : error === 'expired'
              ? `Their journal at ${row.peer_journal} could not be reached for 7 days. Ask ${plain(row.peer_user)} for a new link and try again.`
              : `Their journal at ${row.peer_journal} ${REFUSALS[error] ?? 'refused it'}.`
          const title = reconnect ? `Couldn't reconnect with ${name}` : `Couldn't add ${name}`
          audit(ctx, row.user_id, { event: 'contact.invite_failed', summary: title, contact: rowFor(d, entry) })
          fileNotice(ctx, { userId: row.user_id, title, body: why, idemKey: `fed-invite-dead:${entry.id}` })
          changed(ctx, row.user_id, { contact_id: row.id })
        }
        // Told just now: no undelivered notice, and nothing for Resend.
        return 'discard'
      },
    },
    [REMOVE_OP]: {
      // Sent under whatever key that journal is pinned with now: a removal
      // only takes access away, and tells that host nothing it does not
      // already know. One that cannot go out (a journal that changed its
      // key and was not re-pinned, one the operator now refuses, 7 days
      // unreachable) is told to the user, and does not block a later
      // invite answer between the same two people.
      onDead(d, entry, { error }) {
        const row = rowFor(d, entry)
        if (row) {
          const host = row.peer_journal
          const why = error === 'expired' ? `could not be reached for 7 days`
            : error === 'journal_not_allowed' ? `is not one this journal federates with any more`
              : error === 'peer_key_changed' ? `changed its key`
                : `${REFUSALS[error] ?? 'refused it'}`
          fileNotice(ctx, {
            userId: row.user_id, title: `Couldn't tell ${host} that ${who(row)} is no longer a contact`,
            body: `The contact is ended here, but the journal at ${host} ${why}, so ${plain(row.peer_user)} may still see you as a contact there.`,
            idemKey: `fed-remove-dead:${entry.id}`,
          })
        }
        return 'discard'
      },
    },
  }

  return {
    createInvite: (userId) => createInvite(db, { userId, federation, now: clock() }),
    listInvites: (userId) => listInvites(db, userId, clock()),
    revokeInvite: (userId, inviteId) => revokeInvite(db, { userId, inviteId, now: clock() }),
    preview, accept, queueEnd, inbound, outbound,
    kick() { outbox?.kick() },
    setOutbox(o) { outbox = o },
  }
}
