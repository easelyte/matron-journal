// HTTP surface of read state (spec 2026-09-30 read state §4–§6):
//   GET  /unseen?convo_id=…[&mine=1][&older_than_ms&since_ms&importance
//        &in_convo_id&mission&include_flagged&limit]
//   POST /unseen/flags {convo_id, refs[]}
// Agent connections only. Two callers, one route:
//   - the user's Coordinator (convo_id = its own top-level conversation):
//     everything the user hasn't seen, messages and items;
//   - any agent with mine=1 (convo_id = a conversation it may write to):
//     only its OWN messages there, never items, never other senders.
// Nobody else learns whether the user has seen anything: clients have no
// read route in v1, and a non-Coordinator without mine=1 is refused.
import { json, readBody } from './http-body.js'
import { senderOf, badRequest, notFound } from './http-who.js'
import { filteredAgent, privateOwnedConvo } from './privacy.js'
import { authorizeAgentWrite } from './auth.js'
import { getCoordinatorConvoId } from './coordinator.js'
import { CONVO_ID_MAX_CHARS } from './journal.js'
import { listUnseen, flagRefs, validRef, parseRef, REFS_MAX, UNSEEN_LIMIT_MAX } from './seen.js'

const forbidden = (res, detail) => { json(res, 403, { error: 'forbidden', ...(detail ? { detail } : {}) }); return true }
const DAY = 86400000
const OLDER_THAN_MAX = 30 * DAY
const SINCE_MAX = 30 * DAY

const validConvoId = (id) => typeof id === 'string' && id.length > 0 && id.length <= CONVO_ID_MAX_CHARS

// Which caller is this? 'coordinator' | 'mine' | an error status.
// Ownership first, role second, so a caller learns nothing beyond "not
// yours" about a conversation it has no standing in.
function gate(db, who, convoId, mine) {
  if (!validConvoId(convoId)) return { status: 400 }
  const convo = db.prepare('SELECT owner_user_id, agent_device_id, parent_convo_id FROM conversations WHERE id=?').get(convoId)
  if (!convo || convo.owner_user_id !== who.userId) return { status: 404 }
  if (mine) {
    if (!authorizeAgentWrite(db, who.userId, who.deviceId, convoId)) return { status: 404 }
    if (filteredAgent(db, who) && privateOwnedConvo(db, convoId)) return { status: 404 }
    return { role: 'mine' }
  }
  if (convo.agent_device_id !== who.deviceId || convo.parent_convo_id != null) return { status: 404 }
  if (getCoordinatorConvoId(db, who.userId) !== convoId) return { status: 403, detail: 'not_coordinator' }
  return { role: 'coordinator' }
}

function refuse(res, g) {
  if (g.status === 400) return badRequest(res)
  if (g.status === 404) return notFound(res)
  return forbidden(res, g.detail)
}

// A non-negative integer query parameter within [0, max], or the default
// when absent. undefined = malformed.
function intParam(url, name, dflt, max) {
  const raw = url.searchParams.get(name)
  if (raw == null || raw === '') return dflt
  if (!/^\d{1,16}$/.test(raw)) return undefined
  const n = Number(raw)
  return n <= max ? n : undefined
}

async function handleList(db, res, url, who) {
  const mine = url.searchParams.get('mine') === '1'
  const g = gate(db, who, url.searchParams.get('convo_id'), mine)
  if (!g.role) return refuse(res, g)
  const olderThanMs = intParam(url, 'older_than_ms', mine ? 10 * 60000 : 30 * 60000, OLDER_THAN_MAX)
  const sinceMs = intParam(url, 'since_ms', 3 * DAY, SINCE_MAX)
  const limit = intParam(url, 'limit', 50, UNSEEN_LIMIT_MAX)
  const missionNum = intParam(url, 'mission', null, Number.MAX_SAFE_INTEGER)
  const importance = url.searchParams.get('importance') ?? (mine ? 'all' : 'important')
  const inConvo = url.searchParams.get('in_convo_id')
  if ([olderThanMs, sinceMs, limit, missionNum].includes(undefined) || limit < 1) return badRequest(res)
  if (importance !== 'important' && importance !== 'all') return badRequest(res)
  if (inConvo != null && !validConvoId(inConvo)) return badRequest(res)
  const opts = {
    olderThanMs, sinceMs, limit, importance,
    includeFlagged: url.searchParams.get('include_flagged') === '1',
    excludePrivateOwned: filteredAgent(db, who),
  }
  const out = g.role === 'mine'
    ? listUnseen(db, who.userId, { ...opts, convoId: url.searchParams.get('convo_id'), sender: senderOf(db, who) })
    : listUnseen(db, who.userId, { ...opts, convoId: inConvo, missionNum })
  json(res, 200, out)
  return true
}

async function handleFlags(db, req, res, who) {
  const body = await readBody(req)
  const refs = body?.refs
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > REFS_MAX || !refs.every(validRef)) return badRequest(res)
  const coordinator = getCoordinatorConvoId(db, who.userId) === body.convo_id
  const g = gate(db, who, body.convo_id, !coordinator)
  if (!g.role) return refuse(res, g)
  if (g.role === 'coordinator' && filteredAgent(db, who)) {
    // An ordinary Coordinator can't see private-device conversations, so it
    // can't flag them either (nor probe whether they are flagged).
    const itemOrigin = db.prepare('SELECT origin_convo_id FROM items WHERE id=? AND user_id=?')
    for (const ref of refs) {
      const p = parseRef(ref)
      const convoId = p.kind === 'message' ? p.convoId : itemOrigin.get(p.itemId, who.userId)?.origin_convo_id
      if (convoId && privateOwnedConvo(db, convoId)) return notFound(res)
    }
  }
  if (g.role === 'mine') {
    // An agent may only mark its own messages in this conversation as
    // raised (it restated them); everything else is the Coordinator's call.
    const sender = senderOf(db, who)
    const own = db.prepare('SELECT 1 FROM events WHERE user_id=? AND convo_id=? AND seq=? AND sender=?')
    for (const ref of refs) {
      const p = parseRef(ref)
      if (p.kind !== 'message' || p.convoId !== body.convo_id || !own.get(who.userId, p.convoId, p.seq, sender)) return forbidden(res)
    }
  }
  const added = flagRefs(db, who.userId, [...new Set(refs)], body.convo_id)
  json(res, 200, { flagged: added })
  return true
}

export async function handleSeenRoute(ctx, req, res, url, who) {
  if (url.pathname !== '/unseen' && url.pathname !== '/unseen/flags') return false
  const { db } = ctx
  if (who.kind !== 'agent') return forbidden(res)
  if (req.method === 'GET' && url.pathname === '/unseen') return handleList(db, res, url, who)
  if (req.method === 'POST' && url.pathname === '/unseen/flags') return handleFlags(db, req, res, who)
  return false
}
