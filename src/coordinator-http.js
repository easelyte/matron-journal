// HTTP surface of the Coordinator setting (spec 2026-09-23 coordinator
// redesign §1a). Either device kind may read; only the user (a client
// token) may choose. A change is announced into both conversations, so the
// owning bridge and every open app hear it live and replay it later.
import { append, broadcastAppended, CONVO_ID_MAX_CHARS } from './journal.js'
import { json, readBody } from './http-body.js'
import { senderOf, badRequest } from './http-who.js'
import { filteredAgent } from './privacy.js'
import { COORDINATOR_EVENT_TYPE, coordinatorFor, setCoordinatorConvoId } from './coordinator.js'
import { getConsentEnabled, setConsentEnabled, getTransferConsentEnabled, setTransferConsentEnabled } from './consent.js'
import { seedRoutines } from './routines.js'
import { guardedAccountAction, hasActiveKey, refuse, boundedSubject } from './approval-keys.js'
import { securityLogOf, convoTarget } from './security-log.js'

export async function handleCoordinatorRoute(ctx, req, res, url, who) {
  if (url.pathname !== '/coordinator') return false
  const { db, hub, journalHost = null } = ctx
  // `consent` (spec: 2026-09-29 coordinator consent): whether the
  // Coordinator may answer chat and spawn asks on the user's behalf. Read by
  // both kinds; set by a client alone, with or without a convo_id change.
  // `transfer_consent`: whether the Coordinator may also approve a file
  // transfer it had another session send (src/consent-http.js
  // answerTransfer). Default off; set by a client alone, like `consent`.
  const settings = () => ({ consent: getConsentEnabled(db, who.userId), transfer_consent: getTransferConsentEnabled(db, who.userId) })
  const view = () => ({ convo_id: coordinatorFor(db, who.userId, { excludePrivateOwned: filteredAgent(db, who) }), ...settings() })
  if (req.method === 'GET') {
    json(res, 200, view())
    return true
  }
  if (req.method !== 'PUT') return false
  if (who.kind !== 'client') { json(res, 403, { error: 'forbidden' }); return true }
  const body = await readBody(req)
  if (!('convo_id' in body) && !('consent' in body) && !('transfer_consent' in body)) return badRequest(res)
  if ('consent' in body && typeof body.consent !== 'boolean') return badRequest(res)
  if ('transfer_consent' in body && typeof body.transfer_consent !== 'boolean') return badRequest(res)
  const convoId = body.convo_id
  if ('convo_id' in body && convoId !== null && (typeof convoId !== 'string' || !convoId || convoId.length > CONVO_ID_MAX_CHARS)) return badRequest(res)
  // An account action: once the user has an approval key, each change is
  // signed — {op:'set_coordinator', convo:<id, or '' to clear>} or
  // {op:'set_consent', which:'spawns'|'transfers', on:'true'|'false'} —
  // and a request makes one change, since one statement names one subject.
  const changes = ['convo_id', 'consent', 'transfer_consent'].filter((k) => k in body)
  const subject = 'convo_id' in body ? boundedSubject({ op: 'set_coordinator', convo: convoId ?? '' })
    : 'consent' in body ? { op: 'set_consent', which: 'spawns', on: String(body.consent) }
    : { op: 'set_consent', which: 'transfers', on: String(body.transfer_consent) }
  const sender = senderOf(db, who)
  // Collected inside setCoordinatorConvoId's own transaction (via append(),
  // the journal's non-broadcasting half) so the setting and both event rows
  // commit together — a failing append rolls the setting back too, instead
  // of leaving it switched with no event committed (CodeRabbit finding: the
  // old emitRole ran after the setting had already committed, so the PUT
  // still returned 200 and a repeat PUT of the same value was a no-op,
  // permanently hiding `assigned` from the new owning bridge). That
  // transaction nests in the guard's, so the switches, the role and the
  // approval's nonce commit or roll back together.
  const appended = []
  let out = null
  // Which switches the write actually turned (the security log).
  const switched = []
  const g = guardedAccountAction({ db, journalHost }, who, body, subject, {
    check: () => {
      if (changes.length > 1 && hasActiveKey(db, who.userId)) refuse(400, { error: 'bad_request', detail: 'one_change_per_approval' })
    },
    write: () => {
      if ('convo_id' in body) {
        try {
          out = setCoordinatorConvoId(db, who.userId, convoId, Date.now(), {
            appendEvent: (evtConvoId, role) => {
              const r = append(db, { userId: who.userId, convoId: evtConvoId, sender, type: COORDINATOR_EVENT_TYPE, payload: { role } })
              appended.push({ convoId: evtConvoId, role, seq: r.seq, ts: r.ts })
            },
          })
        } catch (err) {
          if (err.message === 'no_convo') refuse(404, { error: 'not_found' })
          throw err
        }
      }
      if ('consent' in body) {
        if (getConsentEnabled(db, who.userId) !== body.consent) switched.push('spawns')
        setConsentEnabled(db, who.userId, body.consent, Date.now())
      }
      if ('transfer_consent' in body) {
        if (getTransferConsentEnabled(db, who.userId) !== body.transfer_consent) switched.push('transfers')
        setTransferConsentEnabled(db, who.userId, body.transfer_consent, Date.now())
      }
    },
  })
  if (!g.ok) { json(res, g.status, g.body); return true }
  // Committed: each real change, once.
  const record = (event, target) => securityLogOf(ctx).record(who.userId, event, { deviceId: who.deviceId, deviceName: who.name, target, decidedBy: 'user' })
  if (out?.changed) record('coordinator_changed', out.current == null ? null : convoTarget(out.current))
  for (const which of switched) record('consent_switch_changed', which)
  if (!out) {
    json(res, 200, view())
    return true
  }
  // Broadcast only now: everything above already committed.
  for (const e of appended) {
    try {
      broadcastAppended(db, hub, { userId: who.userId, convoId: e.convoId, seq: e.seq, ts: e.ts, sender, type: COORDINATOR_EVENT_TYPE, payload: { role: e.role } })
    } catch (err) {
      console.error('coordinator: role event broadcast failed (already committed)', err)
    }
  }
  // Coordinator routines (spec 2026-10-01): the starter set is seeded the
  // first time a user gets a Coordinator — once ever, per user; a later
  // re-assignment, or an emptied list, never re-seeds. Off the role
  // transaction: a seeding failure must not undo the assignment.
  if (out.current) {
    try { seedRoutines(db, who.userId, Date.now()) } catch (err) { console.error('coordinator: routine seeding failed (the role stands)', err) }
  }
  json(res, 200, { convo_id: out.current, ...settings() })
  return true
}
