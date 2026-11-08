// An agent's ask for an invite link (docs/protocol.md "Contacts across
// journals"). An invite link is a capability, so an agent never mints one:
// it parks an ask, the user gets a card and its tracker mirror, and only the
// user's tap makes the link — returned once, in the answer to that tap, to
// the device that tapped. It never reaches an agent and never sits in the
// tracker, where an agent could read it.
//
//   parkInviteAsk    POST /contacts/invites from an agent → awaiting_user
//   answerInviteAsk  the user's tap: approve mints the invite, decline ends it
//   expireInviteAsks the 24 h sweep, like every ask an agent parks
import { newId } from './items.js'
import { isUnlisted, parkedAsks, MAX_PARKED_PER_DEVICE, OWN_ASK_TTL_MS } from './contacts.js'
import { card, fileMirror, closeMirror, changed, OWNER_ACTIONS } from './sharing-events.js'
import { consentLink } from './consent-items.js'
import { sanitizePeerText, plainText as plain } from './peer-text.js'

export const INVITE_CARD_KIND = 'contact_invite'
export const INVITE_ASK_STATES = ['awaiting_user', 'approved', 'declined', 'expired']

const fail = (code) => { throw new Error(code) }
const askById = (db, id) => db.prepare('SELECT * FROM fed_invite_asks WHERE id=?').get(id) ?? null
const setState = (db, id, state, now, inviteId = null) =>
  db.prepare('UPDATE fed_invite_asks SET state=?, invite_id=COALESCE(?, invite_id), updated_at=? WHERE id=?').run(state, inviteId, now, id)

export function inviteAskView(row) {
  return {
    id: row.id, state: row.state, invite_id: row.invite_id ?? null, origin_convo_id: row.origin_convo_id,
    created_at: row.created_at, updated_at: row.updated_at,
  }
}

// One open ask per conversation: asking again while the card waits is the
// same ask. Errors: 'unlisted', 'pending', 'too_many_asks'.
export function parkInviteAsk(db, { userId, convoId, deviceId, now = Date.now() }) {
  return db.transaction(() => {
    if (isUnlisted(db, userId)) fail('unlisted')
    const open = db.prepare("SELECT 1 FROM fed_invite_asks WHERE user_id=? AND origin_convo_id=? AND state='awaiting_user' AND updated_at>=?")
      .get(userId, convoId, now - OWN_ASK_TTL_MS)
    if (open) fail('pending')
    if (parkedAsks(db, deviceId) >= MAX_PARKED_PER_DEVICE) fail('too_many_asks')
    const id = newId('ia')
    db.prepare(`INSERT INTO fed_invite_asks(id, user_id, state, origin_convo_id, origin_device_id, created_at, updated_at)
      VALUES(?,?,'awaiting_user',?,?,?,?)`).run(id, userId, convoId, deviceId, now, now)
    return askById(db, id)
  })()
}

// The user's answer. `mint()` makes the invite ({invite, link, web_link}) inside this
// transaction, so a refused mint (too_many_invites) leaves the ask waiting.
// null = no such ask of theirs. Outcomes: 'approved' (with invite and link),
// 'declined', 'expired' (it was past its 24 h). Error: 'not_pending'.
export function answerInviteAsk(db, { userId, askId, decision, mint, now = Date.now() }) {
  return db.transaction(() => {
    const before = db.prepare('SELECT * FROM fed_invite_asks WHERE id=? AND user_id=?').get(askId, userId)
    if (!before) return null
    if (before.state !== 'awaiting_user') fail('not_pending')
    if (now - before.updated_at > OWN_ASK_TTL_MS) {
      // Committed, not thrown: the ask really is expired now.
      setState(db, before.id, 'expired', now)
      return { outcome: 'expired', ask: askById(db, before.id), before }
    }
    if (decision === 'decline') {
      setState(db, before.id, 'declined', now)
      return { outcome: 'declined', ask: askById(db, before.id), before }
    }
    const made = mint()
    setState(db, before.id, 'approved', now, made.invite.id)
    return { outcome: 'approved', ask: askById(db, before.id), before, invite: made.invite, link: made.link, web_link: made.web_link }
  })()
}

export function expireInviteAsks(db, now = Date.now()) {
  return db.transaction(() => {
    const rows = db.prepare("SELECT * FROM fed_invite_asks WHERE state='awaiting_user' AND updated_at < ?").all(now - OWN_ASK_TTL_MS)
    for (const r of rows) setState(db, r.id, 'expired', now)
    return rows
  })()
}

// --- Cards --------------------------------------------------------------------

const inviteLinkOf = (id) => ({ url: consentLink('invite', id), title: 'Invite link request' })

// → the mirror, or null when it could not be filed (the ask is then gone).
export function onInviteAskParked(ctx, who, ask) {
  const box = plain(sanitizePeerText(who.name, 80))
  card(ctx, {
    userId: ask.user_id, convoId: ask.origin_convo_id, sender: `agent:${who.name}`,
    payload: { kind: INVITE_CARD_KIND, direction: 'out', ask_id: ask.id, from_device_id: who.deviceId, from_name: sanitizePeerText(who.name, 80), from_convo_id: ask.origin_convo_id },
  })
  const item = fileMirror(ctx, {
    userId: ask.user_id, convoId: ask.origin_convo_id, deviceId: who.deviceId, sender: `agent:${who.name}`, consent: 'invite',
    title: 'Approve making an invite link for someone on another Matron',
    body: [
      `**${box}** asks to make an invite link, so that someone on another Matron journal can add you as a contact.`,
      '',
      'If you approve, the link is shown once, on the device you tap on, and never to an agent: send it to the person yourself. It works once, for 7 days. Nobody is contacted until they open it and accept, and being contacts shares nothing by itself.',
      '',
      '**To answer:** tap **Approve** or **Decline**. Unanswered, the request expires 24 h after it was made and no link is made.',
    ].join('\n'),
    link: inviteLinkOf(ask.id), actions: OWNER_ACTIONS, idemKey: `consent:invite:${ask.id}`,
  })
  // The mirror is where the user taps. Without it the ask would wait
  // unseen and refuse a retry for 24 h: it is dropped, and the caller says
  // the ask failed.
  if (!item) {
    ctx.db.prepare("DELETE FROM fed_invite_asks WHERE id=? AND state='awaiting_user'").run(ask.id)
    return null
  }
  ctx.db.prepare('UPDATE fed_invite_asks SET item_id=? WHERE id=?').run(item.id, ask.id)
  changed(ctx, ask.user_id, { invite_ask_id: ask.id })
  return item
}

const CLOSING = {
  approved: ['decided', 'Approved — the link was shown on the device you tapped on. It works once, for 7 days, and can be withdrawn until it is used.'],
  declined: ['decided', 'Declined — no link was made.'],
  expired: ['cancelled', 'Expired — no answer within 24 h. No link was made.'],
}

// After answerInviteAsk or the sweep. → the closed mirror ({item, comment}).
export function onInviteAskOutcome(ctx, who, out) {
  const [resolution, comment] = CLOSING[out.outcome]
  const tapped = out.outcome !== 'expired'
  const closed = closeMirror(ctx, {
    userId: out.before.user_id, itemId: out.before.item_id, consent: 'invite', resolution,
    author: tapped ? 'user' : 'agent', deviceId: tapped ? who.deviceId : out.before.origin_device_id, comment,
  })
  changed(ctx, out.before.user_id, { invite_ask_id: out.before.id })
  return closed
}

export function onInviteAskExpired(ctx, before) {
  onInviteAskOutcome(ctx, null, { outcome: 'expired', ask: askById(ctx.db, before.id), before })
}

// The answer route and the mirror's tap share this. `fed` is the journal's
// contact federation (null: federation off — the ask waits).
// → {status, body, closed}
export function applyInviteAnswer(ctx, who, askId, decision) {
  const fed = ctx.federationContacts ?? null
  if (!fed) return { status: 409, body: { error: 'conflict', blocked_by: 'federation_off' } }
  let out
  try {
    out = answerInviteAsk(ctx.db, { userId: who.userId, askId, decision, mint: () => fed.createInvite(who.userId) })
  } catch (err) {
    if (['not_pending', 'too_many_invites'].includes(err.message)) return { status: 409, body: { error: 'conflict', blocked_by: err.message } }
    if (err.message === 'unlisted') return { status: 403, body: { error: 'forbidden' } }
    throw err
  }
  if (!out) return { status: 404, body: { error: 'not_found' } }
  const closed = onInviteAskOutcome(ctx, who, out)
  if (out.outcome === 'expired') return { status: 409, body: { error: 'conflict', blocked_by: 'expired' }, closed }
  const body = { ask: inviteAskView(out.ask) }
  if (out.outcome === 'approved') Object.assign(body, { invite: out.invite, link: out.link, web_link: out.web_link })
  return { status: 200, body, closed }
}
