import test from 'node:test'
import assert from 'node:assert/strict'
import { getSpawn } from '../src/spawns.js'
import { recordConsentDecision } from '../src/consent.js'
import { getParticipant } from '../src/participants.js'
import { fleet, parkSpawn, parkInviteAsk, pending, answer, settle } from './consent-fleet.js'

test('chat asks: decline reaches the requester as the usual refusal; approve delivers the invite marked approved_by coordinator; the item says who decided', async (t) => {
  const f = await fleet(t)
  await parkInviteAsk(f)
  const id = `room/${f.targetDev.deviceId}`
  assert.equal((await answer(f, f.coordDev.token, { kind: 'chat', id, decision: 'decline', reason: 'the asker already has a room with eric' })).status, 200)
  const refused = await f.asker.waitFor((x) => x.kind === 'invite' && x.event === 'answer')
  assert.equal(refused.accept, false); assert.equal(refused.reason, 'refused'); assert.equal('decided_by' in refused, false)
  assert.equal(getParticipant(f.s.db, 'room', f.targetDev.deviceId).state, 'denied')
  const declinedNote = f.s.db.prepare("SELECT body FROM item_comments WHERE kind='status' ORDER BY created_at DESC").get()
  assert.equal(declinedNote.body, 'Declined by the Coordinator — the asker already has a room with eric.')
  await parkInviteAsk(f)
  const r = await answer(f, f.coordDev.token, { kind: 'chat', id, decision: 'approve', reason: 'a review chat between two of my sessions' })
  assert.equal(r.status, 200); assert.equal(r.json.delivered, true)
  const req = await f.target.waitFor((x) => x.kind === 'invite' && x.event === 'request')
  assert.equal(req.room_id, 'room'); assert.equal(req.approved_by, 'coordinator'); assert.equal(req.justification, 'need eyes on the diff')
  const row = getParticipant(f.s.db, 'room', f.targetDev.deviceId)
  assert.equal(row.state, 'invited'); assert.equal(row.answered_by, 'coordinator'); assert.equal(row.answer_reason, 'a review chat between two of my sessions')
  const note = f.s.db.prepare("SELECT body FROM item_comments WHERE kind='status' ORDER BY created_at DESC").get()
  assert.equal(note.body, 'Approved by the Coordinator — a review chat between two of my sessions. The invitation is on its way.')
  const decision = await f.client.waitFor((x) => x.kind === 'journal' && x.type === 'consent_decision' && x.payload.decision === 'approve')
  assert.equal(decision.convo_id, 'room')
  assert.deepEqual(decision.payload, { kind: 'chat', room_id: 'room', target_device_id: f.targetDev.deviceId, decision: 'approve', by: 'coordinator', convo_id: 'coord', reason: 'a review chat between two of my sessions' })
  assert.equal((await answer(f, f.coordDev.token, { kind: 'chat', id: 'room/abc', decision: 'approve', reason: 'x' })).status, 400)
  assert.equal((await answer(f, f.coordDev.token, { kind: 'chat', id: 'nope/1', decision: 'approve', reason: 'x' })).status, 404)
})

test('guardrails: the off switch answers 403 consent_disabled; a spawn approval into an offline, unwakeable box is 409 target_offline and leaves the ask parked; a stranger is 403 not_coordinator', async (t) => {
  const f = await fleet(t)
  const spawnId = await parkSpawn(f)
  assert.equal((await f.s.http('/coordinator', { method: 'PUT', token: f.clientToken, body: { consent: false } })).status, 200)
  const off = await answer(f, f.coordDev.token, { kind: 'spawn', id: spawnId, decision: 'approve', reason: 'x' })
  assert.equal(off.status, 403); assert.equal(off.json.detail, 'consent_disabled')
  assert.equal((await pending(f, f.coordDev.token)).status, 403)
  assert.equal((await f.s.http('/coordinator', { method: 'PUT', token: f.clientToken, body: { consent: true } })).status, 200)
  const stranger = await f.s.http('/consent/answer', { method: 'POST', token: f.askerDev.token, body: { convo_id: 'ask', kind: 'spawn', id: spawnId, decision: 'approve', reason: 'x' } })
  assert.equal(stranger.status, 403); assert.equal(stranger.json.detail, 'not_coordinator')
  assert.equal((await f.s.http('/consent/answer', { method: 'POST', token: f.clientToken, body: { convo_id: 'coord', kind: 'spawn', id: spawnId, decision: 'approve', reason: 'x' } })).status, 403)
  f.target.close()
  await settle()
  assert.equal((await pending(f, f.coordDev.token)).json.pending[0].target_state, 'offline')
  const offline = await answer(f, f.coordDev.token, { kind: 'spawn', id: spawnId, decision: 'approve', reason: 'x' })
  assert.equal(offline.status, 409); assert.equal(offline.json.detail, 'target_offline')
  assert.equal(getSpawn(f.s.db, spawnId).state, 'awaiting_user')
  assert.equal(f.s.db.prepare('SELECT COUNT(*) c FROM consent_decisions').get().c, 0)
  // Declining an ask into an offline box is still fine.
  assert.equal((await answer(f, f.coordDev.token, { kind: 'spawn', id: spawnId, decision: 'decline', reason: 'box is offline' })).status, 200)
})

test('daily cap: approvals in the last 24 h at the cap answer 409 daily_cap and leave the ask for the user; declines are not capped', async (t) => {
  const f = await fleet(t, { consentDailyCap: 1 })
  const first = await parkSpawn(f, { rid: 'q1' })
  const second = await parkSpawn(f, { rid: 'q2' })
  f.target.waitFor((x) => x.kind === 'rpc' && x.request?.method === 'start').then((req) => {
    f.target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child' } })
  })
  assert.equal((await answer(f, f.coordDev.token, { kind: 'spawn', id: first, decision: 'approve', reason: 'ok' })).status, 200)
  // Let the first approval's start RPC settle before the server is torn
  // down, or the broker waits out its 30 s timeout on close.
  assert.equal((await f.asker.waitFor((x) => x.kind === 'spawn' && x.event === 'outcome' && x.request_id === first)).outcome, 'started')
  const capped = await answer(f, f.coordDev.token, { kind: 'spawn', id: second, decision: 'approve', reason: 'ok' })
  assert.equal(capped.status, 409); assert.equal(capped.json.detail, 'daily_cap'); assert.equal(capped.json.cap, 1)
  assert.equal(getSpawn(f.s.db, second).state, 'awaiting_user')
  assert.equal((await answer(f, f.coordDev.token, { kind: 'spawn', id: second, decision: 'decline', reason: 'over the cap anyway' })).status, 200)
})

test('cap 0 is no cap: an approval goes through with more approvals in the last 24 h than the default cap', async (t) => {
  const f = await fleet(t, { consentDailyCap: 0 })
  for (let i = 0; i < 25; i++) recordConsentDecision(f.s.db, { userId: f.dan.id, kind: 'chat', askId: `room/${i}`, decision: 'approve', convoId: 'coord', reason: 'routine' })
  const id = await parkSpawn(f, { rid: 'q1' })
  f.target.waitFor((x) => x.kind === 'rpc' && x.request?.method === 'start').then((req) => {
    f.target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child' } })
  })
  assert.equal((await answer(f, f.coordDev.token, { kind: 'spawn', id, decision: 'approve', reason: 'ok' })).status, 200)
  assert.equal((await f.asker.waitFor((x) => x.kind === 'spawn' && x.event === 'outcome' && x.request_id === id)).outcome, 'started')
})

test('nudge: another agent\'s ask sends the Coordinator\'s box a consent pending frame; the Coordinator\'s own ask does not; the switch off silences it', async (t) => {
  const f = await fleet(t)
  const spawnId = await parkSpawn(f)
  const nudge = await f.coord.waitFor((x) => x.kind === 'consent' && x.event === 'pending')
  assert.equal(nudge.ask.kind, 'spawn'); assert.equal(nudge.ask.id, spawnId); assert.equal(nudge.ask.from_name, 'asker-box'); assert.equal(nudge.ask.target_name, 'eric'); assert.equal(nudge.ask.task, 'fix the flaky test')
  await parkInviteAsk(f)
  const chatNudge = await f.coord.waitFor((x) => x.kind === 'consent' && x.event === 'pending' && x.ask.kind === 'chat')
  assert.equal(chatNudge.ask.id, `room/${f.targetDev.deviceId}`); assert.equal(chatNudge.ask.to_name, 'eric')
  f.coord.frames.length = 0
  await parkSpawn(f, { rid: 'own', from: 'coord', ws: f.coord })
  await settle()
  assert.equal(f.coord.frames.find((x) => x.kind === 'consent'), undefined)
  assert.equal((await f.s.http('/coordinator', { method: 'PUT', token: f.clientToken, body: { consent: false } })).status, 200)
  await parkSpawn(f, { rid: 'q3' })
  await settle()
  assert.equal(f.coord.frames.find((x) => x.kind === 'consent'), undefined)
})
