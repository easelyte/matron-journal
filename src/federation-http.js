// The user's own view of their federation outbox (docs/protocol.md
// "Federation": the outbox). Client devices only: what was not delivered
// to another person's journal, and the Resend / Discard the undelivered
// notice points at. An agent can neither see nor change it.

import { json, readBody } from './http-body.js'
import { discardDead, listOutbox, resendDead } from './federation-outbox.js'

const HOST = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/

export async function handleFederationRoute({ db, outbox = null }, req, res, url, who) {
  if (url.pathname !== '/federation/outbox' && !url.pathname.startsWith('/federation/outbox/')) return false
  if (who.kind !== 'client') { json(res, 403, { error: 'forbidden' }); return true }
  if (url.pathname === '/federation/outbox' && req.method === 'GET') {
    const state = url.searchParams.get('state') || 'dead'
    if (!['queued', 'dead', 'sent', 'cancelled'].includes(state)) { json(res, 400, { error: 'bad_request' }); return true }
    json(res, 200, { entries: listOutbox(db, who.userId, { state }) })
    return true
  }
  const m = url.pathname.match(/^\/federation\/outbox\/(resend|discard)$/)
  if (m && req.method === 'POST') {
    const { peer } = await readBody(req)
    if (typeof peer !== 'string' || !HOST.test(peer)) { json(res, 400, { error: 'bad_request' }); return true }
    if (m[1] === 'resend') {
      const out = resendDead(db, who.userId, peer)
      if (out.resent && outbox) outbox.tick().catch(() => {})
      json(res, 200, out)
    } else {
      json(res, 200, { discarded: discardDead(db, who.userId, peer) })
    }
    return true
  }
  return false
}
