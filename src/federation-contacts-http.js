// HTTP surface of contacts across journals (src/federation-contacts.js;
// docs/protocol.md "Contacts across journals"). Client devices only, but
// for one ask: an invite link is a capability, shown to the user's own
// device and never to an agent, and opening one is the user's own consent.
//
//   POST   /contacts/invites               mint an invite → {invite, link} (the link, once)
//                                          an AGENT {convo_id}: parks an ask for the user's tap
//                                          → 202 {ask} (src/federation-invite-asks.js)
//   POST   /contacts/invites/asks/:id/answer {decision}  the user's answer to that ask
//                                          → {ask, invite?, link?} (the link, once)
//   GET    /contacts/invites               my invites of the last 30 days
//   DELETE /contacts/invites/:id           withdraw an open invite
//   POST   /contacts/invites/open {link}   who the link is from (nothing is sent)
//   POST   /contacts/invites/accept {link} add them: queues the answer → 202 {contact}
import { json, readBody } from './http-body.js'
import { badRequest, notFound, conflict } from './http-who.js'
import { contactRow, DECISIONS } from './contacts.js'
import { writableConvo } from './missions-http.js'
import { parkInviteAsk, inviteAskView, onInviteAskParked, applyInviteAnswer } from './federation-invite-asks.js'

const CONFLICTS = new Set([
  'own_journal', 'journal_not_allowed', 'fingerprint_mismatch', 'journal_blocked',
  'already_contact', 'pending', 'blocked', 'too_many_invites', 'too_many_contacts', 'not_open', 'too_many_asks',
])
// The other journal could not be asked: its well-known did not answer, or
// answered with something that is not a journal's identity.
const UPSTREAM = new Set(['unreachable', 'bad_journal'])

function refusal(res, err) {
  if (err.message === 'bad_link') return badRequest(res)
  if (err.message === 'unlisted') { json(res, 403, { error: 'forbidden' }); return true }
  if (CONFLICTS.has(err.message)) return conflict(res, { blocked_by: err.message })
  if (UPSTREAM.has(err.message)) { json(res, 502, { error: err.message }); return true }
  throw err
}

// An agent's ask: nothing is minted, the user gets a card.
async function parkAsk(ctx, req, res, who) {
  const body = await readBody(req)
  if (typeof body.convo_id !== 'string' || !body.convo_id) return badRequest(res)
  if (!writableConvo(ctx.db, who, body.convo_id)) return notFound(res)
  const ask = parkInviteAsk(ctx.db, { userId: who.userId, convoId: body.convo_id, deviceId: who.deviceId })
  if (!onInviteAskParked(ctx, who, ask)) { json(res, 503, { error: 'unavailable' }); return true }
  json(res, 202, { ask: inviteAskView(ask), pending: 'user' })
  return true
}

export async function handleInviteRoute(ctx, req, res, url, who) {
  const fed = ctx.federationContacts ?? null
  const path = url.pathname
  if (path !== '/contacts/invites' && !path.startsWith('/contacts/invites/')) return false
  const asking = who.kind === 'agent' && path === '/contacts/invites' && req.method === 'POST'
  if (who.kind !== 'client' && !asking) { json(res, 403, { error: 'forbidden' }); return true }
  if (!fed) return conflict(res, { blocked_by: 'federation_off' })
  try {
    if (asking) return await parkAsk(ctx, req, res, who)
    const am = path.match(/^\/contacts\/invites\/asks\/([^/]+)\/answer$/)
    if (am) {
      if (req.method !== 'POST') return false
      const body = await readBody(req)
      if (!DECISIONS.includes(body.decision)) return badRequest(res)
      let id
      try { id = decodeURIComponent(am[1]) } catch { return badRequest(res) }
      const r = applyInviteAnswer(ctx, who, id, body.decision)
      json(res, r.status, r.body)
      return true
    }
    if (path === '/contacts/invites') {
      if (req.method === 'GET') { json(res, 200, { invites: fed.listInvites(who.userId) }); return true }
      if (req.method === 'POST') { json(res, 201, fed.createInvite(who.userId)); return true }
      return false
    }
    if (path === '/contacts/invites/open' || path === '/contacts/invites/accept') {
      if (req.method !== 'POST') return false
      const body = await readBody(req)
      if (typeof body.link !== 'string') return badRequest(res)
      if (path.endsWith('/open')) { json(res, 200, await fed.preview(who.userId, body.link)); return true }
      const row = await fed.accept(who.userId, body.link)
      json(res, 202, { contact: contactRow(row), pending: 'peer' })
      return true
    }
    const m = path.match(/^\/contacts\/invites\/([^/]+)$/)
    if (!m || req.method !== 'DELETE') return false
    let id
    try { id = decodeURIComponent(m[1]) } catch { return badRequest(res) }
    const invite = fed.revokeInvite(who.userId, id)
    if (!invite) return notFound(res)
    json(res, 200, { invite })
    return true
  } catch (err) {
    return refusal(res, err)
  }
}
