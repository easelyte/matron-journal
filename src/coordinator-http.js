// HTTP surface of the Coordinator setting (spec 2026-09-23 coordinator
// redesign §1a). Either device kind may read; only the user (a client
// token) may choose. A change is announced into both conversations, so the
// owning bridge and every open app hear it live and replay it later.
import { append, broadcastAppended, CONVO_ID_MAX_CHARS } from './journal.js'
import { json, readBody } from './http-body.js'
import { senderOf, badRequest, notFound } from './http-who.js'
import { filteredAgent } from './privacy.js'
import { COORDINATOR_EVENT_TYPE, coordinatorFor, setCoordinatorConvoId } from './coordinator.js'

export async function handleCoordinatorRoute(ctx, req, res, url, who) {
  if (url.pathname !== '/coordinator') return false
  const { db, hub } = ctx
  if (req.method === 'GET') {
    json(res, 200, { convo_id: coordinatorFor(db, who.userId, { excludePrivateOwned: filteredAgent(db, who) }) })
    return true
  }
  if (req.method !== 'PUT') return false
  if (who.kind !== 'client') { json(res, 403, { error: 'forbidden' }); return true }
  const body = await readBody(req)
  if (!('convo_id' in body)) return badRequest(res)
  const convoId = body.convo_id
  if (convoId !== null && (typeof convoId !== 'string' || !convoId || convoId.length > CONVO_ID_MAX_CHARS)) return badRequest(res)
  const sender = senderOf(db, who)
  // Collected inside setCoordinatorConvoId's own transaction (via append(),
  // the journal's non-broadcasting half) so the setting and both event rows
  // commit together — a failing append rolls the setting back too, instead
  // of leaving it switched with no event committed (CodeRabbit finding: the
  // old emitRole ran after the setting had already committed, so the PUT
  // still returned 200 and a repeat PUT of the same value was a no-op,
  // permanently hiding `assigned` from the new owning bridge).
  const appended = []
  let out
  try {
    out = setCoordinatorConvoId(db, who.userId, convoId, Date.now(), {
      appendEvent: (evtConvoId, role) => {
        const r = append(db, { userId: who.userId, convoId: evtConvoId, sender, type: COORDINATOR_EVENT_TYPE, payload: { role } })
        appended.push({ convoId: evtConvoId, role, seq: r.seq, ts: r.ts })
      },
    })
  } catch (err) {
    if (err.message === 'no_convo') return notFound(res)
    throw err
  }
  // Broadcast only now: everything above already committed.
  for (const e of appended) {
    try {
      broadcastAppended(db, hub, { userId: who.userId, convoId: e.convoId, seq: e.seq, ts: e.ts, sender, type: COORDINATOR_EVENT_TYPE, payload: { role: e.role } })
    } catch (err) {
      console.error('coordinator: role event broadcast failed (already committed)', err)
    }
  }
  json(res, 200, { convo_id: out.current })
  return true
}
