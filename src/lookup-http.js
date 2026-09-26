// Resolves a shareable link's (user, num) to a row (spec 2026-09-23 tracker
// web/teams, "Item links and the lookup URL"). One per-user counter numbers
// items, missions and milestones alike, so a single lookup covers all three.
// Visibility is exactly the read rule: the caller's own rows, or a
// colleague's under the shared predicate. Unknown user, unknown number and
// invisible row are one 404. Own-row checks reuse the same helpers the
// GET routes gate with, so a lookup can never name a row its GET would
// then refuse.
import { json } from './http-body.js'
import { badRequest, notFound } from './http-who.js'
import { getItem, getSharedItem, isConsentMirror } from './items.js'
import { getMission, getSharedMission } from './missions.js'
import { canReadConvo } from './visibility.js'
import { filteredAgent, privateOwnedConvo } from './privacy.js'

const NAME_MAX = 64

function resolve(db, who, ownerName, num) {
  const owner = db.prepare('SELECT id, name FROM users WHERE name=?').get(ownerName)
  if (!owner) return null
  const own = owner.id === who.userId
  const item = db.prepare('SELECT id, origin_convo_id FROM items WHERE user_id=? AND num=?').get(owner.id, num)
  if (item) {
    let ok
    if (own) {
      ok = !!getItem(db, who.userId, item.id)
        && !(filteredAgent(db, who) && privateOwnedConvo(db, item.origin_convo_id))
        && !(who.kind === 'agent' && isConsentMirror(db, item.id))
    } else ok = !!getSharedItem(db, who.userId, item.id)
    return ok ? { kind: 'item', id: item.id, owner } : null
  }
  const mission = db.prepare('SELECT id FROM missions WHERE user_id=? AND num=?').get(owner.id, num)
  if (mission) {
    const ok = own ? !!getMission(db, who.userId, mission.id, { excludePrivateOwned: filteredAgent(db, who) }) : !!getSharedMission(db, who.userId, mission.id)
    return ok ? { kind: 'mission', id: mission.id, owner } : null
  }
  const ms = db.prepare('SELECT id, convo_id FROM milestones WHERE user_id=? AND num=?').get(owner.id, num)
  if (ms) {
    const ok = own ? !(filteredAgent(db, who) && privateOwnedConvo(db, ms.convo_id)) : canReadConvo(db, who.userId, ms.convo_id)
    return ok ? { kind: 'milestone', id: ms.id, owner } : null
  }
  return null
}

export function handleLookupRoute(ctx, req, res, url, who) {
  if (req.method !== 'GET') return false
  const { db } = ctx
  let user, numRaw
  if (url.pathname === '/lookup') {
    user = url.searchParams.get('user'); numRaw = url.searchParams.get('num')
  } else {
    const m = url.pathname.match(/^\/u\/([^/]+)\/([^/]+)$/)
    if (!m || !/application\/json/.test(req.headers.accept || '')) return false
    try { user = decodeURIComponent(m[1]); numRaw = decodeURIComponent(m[2]) } catch { return badRequest(res) }
  }
  if (typeof user !== 'string' || !user || user.length > NAME_MAX || numRaw == null) return badRequest(res)
  const num = Number(numRaw)
  if (!Number.isInteger(num) || num < 1) return badRequest(res)
  const hit = resolve(db, who, user, num)
  if (!hit) return notFound(res)
  json(res, 200, { kind: hit.kind, id: hit.id, owner: { user_id: hit.owner.id, name: hit.owner.name } })
  return true
}
