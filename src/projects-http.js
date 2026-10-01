// HTTP surface of projects (spec 2026-09-30 projects & mission links §4.2).
// Validation, auth, the Coordinator gate and the one side effect projects
// have: moving missions (merge) writes each mission's `updated` marker with
// project_changed. Project create/update/close write no marker — apps
// refresh GET /projects on mission markers and while the tab is open.
import { json, readBody } from './http-body.js'
import { idemKeyOf, badRequest, notFound, conflict } from './http-who.js'
import { validateMissionFields, getMission } from './missions.js'
import {
  writableConvo, statusConvoOf, emitMissionMarker, byOf, validCloseSummary, closingConvo, refusedCloser,
} from './missions-http.js'
import { filteredAgent } from './privacy.js'
import {
  createProject, getProject, resolveProject, listProjects, projectDetail, projectWithRollup,
  updateProject, closeProject, mergeProject,
} from './projects.js'

const STATES = ['open', 'closed']

// Close and merge (Dan, Q3): the user, or the user's Coordinator — which
// proves it by naming its own conversation, the rule mission close uses.
// Nothing is "on" a project, so only the Coordinator passes, and naming no
// conversation at all is 403 not_coordinator (`required`).
const coordinatorGate = (db, who, convoId) => closingConvo(db, who, convoId, { required: true })

async function handleCreate(ctx, req, res, who) {
  const { db } = ctx
  const body = await readBody(req)
  const v = validateMissionFields(body)
  if (!v.ok) return badRequest(res)
  const idemKey = idemKeyOf(req, who)
  if (idemKey === undefined) return badRequest(res)
  // convo_id is optional provenance (a client creates from the Projects
  // tab); when named it must be a conversation this caller may write to.
  // null is the same as absent.
  if (body.convo_id != null && !writableConvo(db, who, body.convo_id)) return notFound(res)
  const excludePrivateOwned = filteredAgent(db, who)
  const out = createProject(db, {
    userId: who.userId, deviceId: who.deviceId, createdBy: byOf(who), convoId: body.convo_id ?? null,
    title: v.value.title, body: v.value.body ?? '', idemKey, excludePrivateOwned,
  })
  // A replay of a key whose project this caller cannot see: same 404 as unknown.
  if (!out.project) return notFound(res)
  json(res, out.duplicate ? 200 : 201, { project: projectWithRollup(db, who.userId, out.project, { excludePrivateOwned }) })
  return true
}

function handleList(ctx, res, url, who) {
  const { db } = ctx
  const state = url.searchParams.get('state')
  if (state != null && !STATES.includes(state)) return badRequest(res)
  json(res, 200, { projects: listProjects(db, who.userId, { state, excludePrivateOwned: filteredAgent(db, who) }) })
  return true
}

async function handlePatch(ctx, req, res, who, project) {
  const { db } = ctx
  const body = await readBody(req)
  const v = validateMissionFields(body, { partial: true })
  if (!v.ok || Object.keys(v.value).length === 0) return badRequest(res)
  const statusWriter = typeof v.value.status === 'string'
    ? { by: byOf(who), convoId: statusConvoOf(db, who, body.convo_id), deviceId: who.deviceId }
    : null
  const excludePrivateOwned = filteredAgent(db, who)
  let updated
  try {
    updated = updateProject(db, { userId: who.userId, projectId: project.id, fields: v.value, statusWriter, excludePrivateOwned })
  } catch (err) { if (err.message === 'closed') return conflict(res, { blocked_by: 'closed' }); throw err }
  if (!updated) return notFound(res)
  json(res, 200, { project: projectWithRollup(db, who.userId, updated, { excludePrivateOwned }) })
  return true
}

// `project` arrives already resolved through the caller's sieve (the route
// below), so closeProject's unsieved row read never reaches a hidden one.
async function handleClose(ctx, req, res, who, project) {
  const { db } = ctx
  const body = await readBody(req)
  if (!validCloseSummary(body.summary)) return badRequest(res)
  if (refusedCloser(res, coordinatorGate(db, who, body.convo_id))) return true
  const excludePrivateOwned = filteredAgent(db, who)
  let out
  try {
    out = closeProject(db, { userId: who.userId, projectId: project.id, by: byOf(who), summary: body.summary, excludePrivateOwned })
  } catch (err) {
    if (err.message === 'closed') return conflict(res, { blocked_by: 'closed' })
    // err.missions is already sieved: a hidden open mission blocks but is not named.
    if (err.message === 'open_missions') return conflict(res, { blocked_by: 'open_missions', missions: err.missions })
    if (err.message === 'no_project') return notFound(res)
    throw err
  }
  json(res, 200, { project: projectWithRollup(db, who.userId, out.project, { excludePrivateOwned }) })
  return true
}

// Both ends go through the caller's sieve before mergeProject (which reads
// rows unsieved): a project the caller cannot see is 404 as :id (route) or
// as `into` (here). movedMissionIds never leaves this function — it can
// name missions hidden from a filtered caller.
async function handleMerge(ctx, req, res, who, project) {
  const { db } = ctx
  const body = await readBody(req)
  if (typeof body.into !== 'string' && typeof body.into !== 'number') return badRequest(res)
  if (refusedCloser(res, coordinatorGate(db, who, body.convo_id))) return true
  const excludePrivateOwned = filteredAgent(db, who)
  const into = getProject(db, who.userId, body.into, { excludePrivateOwned })
  if (!into) return notFound(res)
  let out
  try {
    out = mergeProject(db, { userId: who.userId, projectId: project.id, intoId: into.id, by: byOf(who), excludePrivateOwned })
  } catch (err) {
    if (err.message === 'same_project') return badRequest(res)
    if (err.message === 'closed' || err.message === 'into_closed') return conflict(res, { blocked_by: err.message })
    if (err.message === 'no_project') return notFound(res)
    throw err
  }
  // One `updated` marker per moved mission, on its origin conversation,
  // built from the unsieved row (emitMissionMarker's withTitle rule is the
  // privacy boundary for markers).
  for (const id of out.movedMissionIds) {
    const m = getMission(db, who.userId, id)
    if (m) emitMissionMarker(ctx, who, { mission: m, action: 'updated', convoId: m.origin_convo_id, projectChanged: true })
  }
  json(res, 200, {
    project: projectWithRollup(db, who.userId, out.project, { excludePrivateOwned }),
    merged: projectWithRollup(db, who.userId, out.merged, { excludePrivateOwned }),
  })
  return true
}

export async function handleProjectsRoute(ctx, req, res, url, who) {
  const { db } = ctx
  const path = url.pathname
  if (path === '/projects') {
    if (req.method === 'POST') return handleCreate(ctx, req, res, who)
    if (req.method === 'GET') return handleList(ctx, res, url, who)
    return false
  }
  const m = path.match(/^\/projects\/([^/]+)(?:\/(close|merge))?$/)
  if (!m) return false
  let idOrNum
  try { idOrNum = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  const sub = m[2] || null
  const excludePrivateOwned = filteredAgent(db, who)
  if (!sub && req.method === 'GET') {
    // Reads follow a merge to the project that survived it (§4.2).
    const r = resolveProject(db, who.userId, idOrNum, { excludePrivateOwned })
    if (!r) return notFound(res)
    json(res, 200, { ...projectDetail(db, who.userId, r.project, { excludePrivateOwned }), ...(r.mergedFrom ? { merged_from: r.mergedFrom } : {}) })
    return true
  }
  // Writes address the row itself, never the merge target.
  const project = getProject(db, who.userId, idOrNum, { excludePrivateOwned })
  if (!project) return notFound(res)
  if (!sub) return req.method === 'PATCH' ? handlePatch(ctx, req, res, who, project) : false
  if (req.method !== 'POST') return false
  return sub === 'close' ? handleClose(ctx, req, res, who, project) : handleMerge(ctx, req, res, who, project)
}
