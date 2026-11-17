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
import { validName, validateMemoryFields, getMemory, listMemories, upsertMemory, deleteMemory, privateOrigin, MEMORIES_MAX } from './memories.js'
import { validateRecall, recallMemories } from './memory-recall.js'
import { causesFromFrame } from './ask-causes.js'
import { needsUserAnswer, fileProposal, answerPending } from './memory-proposals-http.js'

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
// target) the marker carries the id and action only. `extra` is the
// `proposal` an approved memory proposal adds (src/memory-proposals-http.js):
// `who` is then the user who approved it.
export function emitMemoryMarker({ db, hub }, who, { memory, action, created, writerConvoId = null, extra = null }) {
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
      ...(withTitle ? { name: memory.name, type: memory.type, scope: memory.scope, description: memory.description } : {}),
      action, created, by: byOf(who), ...(extra ?? {}),
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

// `convo_id` and `causes` of an agent's write: the conversation it is made
// from and the causes of the turn that made it (src/ask-causes.js), which
// decide whether it applies now or waits for the user
// (src/memory-proposals-http.js needsUserAnswer). Only an agent has either.
// → { convoId, causes }, or null for a malformed field (400).
function writerOf(who, body) {
  let convoId = null
  if (body.convo_id !== undefined) {
    if (who.kind !== 'agent') return null
    if (typeof body.convo_id !== 'string' || !body.convo_id || body.convo_id.length > ID_MAX) return null
    convoId = body.convo_id
  }
  if (body.causes !== undefined && who.kind !== 'agent') return null
  const frame = causesFromFrame(body)
  if (!frame.ok) return null
  return { convoId, causes: frame.causes }
}

// The conversation gate every agent-authored write clears (items,
// missions): owned by the user, writable by this agent, and not
// private-owned when the agent is an ordinary one.
function writableConvo(db, who, convoId) {
  const convo = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(convoId)
  if (!convo || convo.owner_user_id !== who.userId) return false
  if (!authorizeAgentWrite(db, who.userId, who.deviceId, convoId)) return false
  if (filteredAgent(db, who) && convo.agent_device_id != null && isPrivateDevice(db, convo.agent_device_id)) return false
  return true
}

// Park an agent's write as a proposal: 202, or 409 when too many of its
// conversation's proposals (or of the user's) already wait — the answer a
// parked ask gives at its cap. Nothing is stored then and no item is filed.
function propose(ctx, res, who, change) {
  let out
  try {
    out = fileProposal(ctx, who, change)
  } catch (err) {
    if (err.message === 'too_many_asks') { json(res, 409, { error: 'conflict', blocked_by: 'too_many_asks' }); return true }
    throw err
  }
  return answerPending(res, out)
}

async function handlePut(ctx, req, res, who, name) {
  const { db } = ctx
  const body = await readBody(req)
  const v = validateMemoryFields(body)
  if (!v.ok) return badRequest(res)
  const writer = writerOf(who, body)
  if (!writer) return badRequest(res)
  const convoId = writer.convoId
  // Every body-only rule is settled, so a malformed field answers 400 even
  // when the conversation or the memory is one this caller may not see.
  // 404, never 403.
  if (convoId && !writableConvo(db, who, convoId)) return notFound(res)
  // A name that exists but is hidden from this caller is a 404, not a second
  // row: UNIQUE(user_id, name) holds either way.
  const existing = getMemory(db, who.userId, name)
  if (existing && filteredAgent(db, who) && privateOrigin(existing)) return notFound(res)
  // An agent's write that is not the user's own ask waits for their answer.
  if (needsUserAnswer(db, who, writer)) {
    if (!existing && db.prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id=?').get(who.userId).n >= MEMORIES_MAX) { json(res, 409, { error: 'too_many' }); return true }
    return propose(ctx, res, who, { name, action: 'save', fields: v.value, memoryId: existing?.id ?? null, convoId })
  }
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
  // POST /memories/recall: the memories that bear on a text (src/memory-recall.js).
  // No memory is named "recall" by a POST: PUT/GET/DELETE of that name
  // still reach the routes below.
  if (url.pathname === '/memories/recall' && req.method === 'POST') {
    const v = validateRecall(await readBody(req))
    if (!v.ok) return badRequest(res)
    json(res, 200, await recallMemories(db, who.userId, v.value, { excludePrivateOwned: filteredAgent(db, who), semantic: ctx.semantic ?? null }))
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
    // An optional body: {convo_id?, causes?}, an agent's only, as on a PUT.
    const writer = writerOf(who, await readBody(req))
    if (!writer) return badRequest(res)
    if (writer.convoId && !writableConvo(db, who, writer.convoId)) return notFound(res)
    const memory = visibleMemory(db, who, key)
    if (!memory) return notFound(res)
    if (needsUserAnswer(db, who, writer)) {
      return propose(ctx, res, who, { name: memory.name, action: 'delete', memoryId: memory.id, convoId: writer.convoId })
    }
    const gone = deleteMemory(db, who.userId, memory.id)
    if (!gone) return notFound(res)
    emitMemoryMarker(ctx, who, { memory: gone, action: 'deleted', created: false, writerConvoId: writer.convoId })
    json(res, 200, { memory: gone })
    return true
  }
  return false
}
