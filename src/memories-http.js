// HTTP surface of memories (spec: 2026-09-27 memories). Auth, validation,
// and the one side effect the pure module must not know about: the `memory`
// marker on the writer's conversation and on the Coordinator's. No push, no
// wake, no old-client fallback — a memory change is quiet bookkeeping.
import { appendAndBroadcast } from './journal.js'
import { isPrivateDevice } from './db.js'
import { authorizeAgentWrite } from './auth.js'
import { json, readBody } from './http-body.js'
import { senderOf, badRequest, notFound } from './http-who.js'
import { filteredAgent, privateOwnedConvo } from './privacy.js'
import { getCoordinatorConvoId } from './coordinator.js'
import { validName, validateMemoryFields, getMemory, listMemories, upsertMemory, deleteMemory, privateOrigin } from './memories.js'

export const MEMORY_EVENT_TYPE = 'memory'
const ID_MAX = 128

const byOf = (who) => (who.kind === 'agent' ? 'agent' : 'user')

// Visible = the caller's user's and, for an ordinary agent, not saved from a
// private device. Same 404 for every failure.
function visibleMemory(db, who, key) {
  const m = getMemory(db, who.userId, key)
  if (!m) return null
  if (filteredAgent(db, who) && privateOrigin(m)) return null
  return m
}

// Called AFTER the row's transaction committed. Targets: the writer's
// conversation (an agent PUT's convo_id) or, failing that, the memory's
// origin conversation; plus the Coordinator's conversation when set and
// different. Across the privacy boundary (private origin device, public
// target) the marker carries the id and action only.
export function emitMemoryMarker({ db, hub }, who, { memory, action, created, writerConvoId = null }) {
  const targets = []
  const first = writerConvoId ?? memory.origin_convo_id
  if (first) targets.push(first)
  const coord = getCoordinatorConvoId(db, who.userId)
  if (coord && !targets.includes(coord)) targets.push(coord)
  const sender = senderOf(db, who)
  const hidden = privateOrigin(memory)
  for (const convoId of targets) {
    const withTitle = !hidden || privateOwnedConvo(db, convoId)
    const payload = {
      memory_id: memory.id,
      ...(withTitle ? { name: memory.name, type: memory.type, description: memory.description } : {}),
      action, created, by: byOf(who),
    }
    try {
      appendAndBroadcast(db, hub, { userId: who.userId, convoId, sender, type: MEMORY_EVENT_TYPE, payload })
    } catch (err) {
      // The row already committed; a marker on a since-deleted conversation
      // must not fail the request (same stance as items/missions).
      console.error('memories: marker append failed (memory write already committed)', err)
    }
  }
}

async function handlePut(ctx, req, res, who, name) {
  const { db } = ctx
  const body = await readBody(req)
  const v = validateMemoryFields(body)
  if (!v.ok) return badRequest(res)
  let convoId = null
  if (body.convo_id !== undefined) {
    // Only an agent has a conversation to attribute the write to.
    if (who.kind !== 'agent') return badRequest(res)
    if (typeof body.convo_id !== 'string' || !body.convo_id || body.convo_id.length > ID_MAX) return badRequest(res)
    convoId = body.convo_id
  }
  // Every body-only rule is settled, so a malformed field answers 400 even
  // when the conversation or the memory is one this caller may not see.
  // The conversation gate is the one every agent-authored write clears
  // (items, missions): owned by the user, writable by this agent, and not
  // private-owned when the agent is an ordinary one. 404, never 403.
  if (convoId) {
    const convo = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(convoId)
    if (!convo || convo.owner_user_id !== who.userId) return notFound(res)
    if (!authorizeAgentWrite(db, who.userId, who.deviceId, convoId)) return notFound(res)
    if (filteredAgent(db, who) && convo.agent_device_id != null && isPrivateDevice(db, convo.agent_device_id)) return notFound(res)
  }
  // A name that exists but is hidden from this caller is a 404, not a second
  // row: UNIQUE(user_id, name) holds either way.
  const existing = getMemory(db, who.userId, name)
  if (existing && filteredAgent(db, who) && privateOrigin(existing)) return notFound(res)
  let out
  try {
    out = upsertMemory(db, {
      userId: who.userId, name, ...v.value,
      originConvoId: convoId, originDeviceId: who.deviceId, by: byOf(who),
    })
  } catch (err) {
    if (err.message === 'too_many') { json(res, 409, { error: 'too_many' }); return true }
    throw err
  }
  emitMemoryMarker(ctx, who, { memory: out.memory, action: 'saved', created: out.created, writerConvoId: convoId })
  json(res, out.created ? 201 : 200, { memory: out.memory })
  return true
}

const validKey = (key) => key.startsWith('me_') || validName(key)

export async function handleMemoriesRoute(ctx, req, res, url, who) {
  const { db } = ctx
  if (url.pathname === '/memories') {
    if (req.method !== 'GET') return false
    json(res, 200, { memories: listMemories(db, who.userId, { excludePrivateOwned: filteredAgent(db, who) }) })
    return true
  }
  const m = /^\/memories\/([^/]+)$/.exec(url.pathname)
  if (!m) return false
  let key
  try { key = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  if (req.method === 'PUT') {
    if (!validName(key)) return badRequest(res)
    return handlePut(ctx, req, res, who, key)
  }
  if (req.method === 'GET') {
    if (!validKey(key)) return badRequest(res)
    const memory = visibleMemory(db, who, key)
    if (!memory) return notFound(res)
    json(res, 200, { memory })
    return true
  }
  if (req.method === 'DELETE') {
    if (!validKey(key)) return badRequest(res)
    const memory = visibleMemory(db, who, key)
    if (!memory) return notFound(res)
    const gone = deleteMemory(db, who.userId, memory.id)
    if (!gone) return notFound(res)
    emitMemoryMarker(ctx, who, { memory: gone, action: 'deleted', created: false })
    json(res, 200, { memory: gone })
    return true
  }
  return false
}
