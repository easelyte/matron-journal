// Resolves a shareable link's (user, num) to a row (spec 2026-09-23 tracker
// web/teams, "Item links and the lookup URL"). One per-user counter numbers
// items, missions, milestones and projects alike, so a single lookup covers
// all four.
// Visibility is exactly the read rule: the caller's own rows, or a
// colleague's under the shared predicate. Unknown user, unknown number and
// invisible row are one 404. Own-row checks reuse the same helpers the
// GET routes gate with, so a lookup can never name a row its GET would
// then refuse.
import { json } from './http-body.js'
import { badRequest, notFound } from './http-who.js'
import { getItem, getSharedItem, isConsentMirror } from './items.js'
import { getMission, getSharedMission, getGrantedMission } from './missions.js'
import { resolveProject } from './projects.js'
import { canReadConvo } from './visibility.js'
import { filteredAgent, privateOwnedConvo } from './privacy.js'

const NAME_MAX = 64

// The mission a caller may read, under the same rule its own GET applies.
function readableMission(db, who, own, missionId) {
  if (own) return getMission(db, who.userId, missionId, { excludePrivateOwned: filteredAgent(db, who) })
  return getSharedMission(db, who.userId, missionId) || getGrantedMission(db, who.userId, missionId)
}

// A hit carries the row's own number and title, read from the same row the
// visibility check returned, so a client can label the result without a
// second request.
function resolve(db, who, ownerName, num) {
  const owner = db.prepare('SELECT id, name FROM users WHERE name=?').get(ownerName)
  if (!owner) return null
  const own = owner.id === who.userId
  const item = db.prepare('SELECT id, origin_convo_id FROM items WHERE user_id=? AND num=?').get(owner.id, num)
  if (item) {
    let row
    if (own) {
      row = getItem(db, who.userId, item.id)
      if (filteredAgent(db, who) && privateOwnedConvo(db, item.origin_convo_id)) row = null
      if (who.kind === 'agent' && isConsentMirror(db, item.id)) row = null
    } else row = getSharedItem(db, who.userId, item.id)
    return row ? { kind: 'item', id: item.id, owner, num: row.num, title: row.title } : null
  }
  const mission = db.prepare('SELECT id FROM missions WHERE user_id=? AND num=?').get(owner.id, num)
  if (mission) {
    const row = readableMission(db, who, own, mission.id)
    return row ? { kind: 'mission', id: mission.id, owner, num: row.num, title: row.title } : null
  }
  const ms = db.prepare('SELECT id, num, title, convo_id, mission_id FROM milestones WHERE user_id=? AND num=?').get(owner.id, num)
  if (ms) {
    const ok = own ? !(filteredAgent(db, who) && privateOwnedConvo(db, ms.convo_id)) : canReadConvo(db, who.userId, ms.convo_id)
    if (!ok) return null
    // A milestone has no page of its own: name the mission it sits on so a
    // client can open that, but only when the caller may read the mission.
    const parent = readableMission(db, who, own, ms.mission_id)
    return { kind: 'milestone', id: ms.id, owner, num: ms.num, title: ms.title, mission: parent ? { id: parent.id, num: parent.num } : null }
  }
  // Projects (spec 2026-09-30 §4.1) share the number space. Never shared
  // with colleagues (§9), so a foreign number is the same 404. A merged
  // project resolves to the one that survived it, like GET /projects/:id.
  const project = db.prepare('SELECT id FROM projects WHERE user_id=? AND num=?').get(owner.id, num)
  if (project) {
    if (!own) return null
    const r = resolveProject(db, who.userId, project.id, { excludePrivateOwned: filteredAgent(db, who) })
    return r ? { kind: 'project', id: r.project.id, owner, num: r.project.num, title: r.project.title, mergedFrom: r.mergedFrom?.id ?? null } : null
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
  json(res, 200, {
    kind: hit.kind, id: hit.id, num: hit.num, title: hit.title,
    ...(hit.mission ? { mission: hit.mission } : {}),
    ...(hit.mergedFrom ? { merged_from: hit.mergedFrom } : {}),
    owner: { user_id: hit.owner.id, name: hit.owner.name },
  })
  return true
}
