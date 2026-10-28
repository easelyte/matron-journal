import test from 'node:test'
import assert from 'node:assert/strict'
import { getSpawn } from '../src/spawns.js'
import { fleet, parkSpawn, parkInviteAsk, pending, answer, settle } from './consent-fleet.js'
import { upsertDeviceStatus } from '../src/db.js'

test('GET /coordinator carries consent (default on); a client switches it off and on, alone or with convo_id; an agent PUT is 403', async (t) => {
  const f = await fleet(t)
  assert.deepEqual((await f.s.http('/coordinator', { token: f.clientToken })).json, { convo_id: 'coord', consent: true, transfer_consent: false })
  assert.deepEqual((await f.s.http('/coordinator', { token: f.coordDev.token })).json, { convo_id: 'coord', consent: true, transfer_consent: false })
  assert.equal((await f.s.http('/coordinator', { method: 'PUT', token: f.clientToken, body: { consent: 'no' } })).status, 400)
  const off = await f.s.http('/coordinator', { method: 'PUT', token: f.clientToken, body: { consent: false } })
  assert.equal(off.status, 200); assert.deepEqual(off.json, { convo_id: 'coord', consent: false, transfer_consent: false })
  assert.equal((await f.s.http('/coordinator', { method: 'PUT', token: f.coordDev.token, body: { consent: true } })).status, 403)
  assert.equal((await f.s.http('/coordinator', { token: f.clientToken })).json.consent, false)
  const on = await f.s.http('/coordinator', { method: 'PUT', token: f.clientToken, body: { convo_id: 'coord', consent: true } })
  assert.deepEqual(on.json, { convo_id: 'coord', consent: true, transfer_consent: false })
})

test('GET /consent/pending: client 403; an ordinary agent 403 not_coordinator; a convo the caller does not own 404; the Coordinator lists a parked spawn and a parked invite', async (t) => {
  const f = await fleet(t)
  const spawnId = await parkSpawn(f)
  await parkInviteAsk(f)
  assert.equal((await pending(f, f.clientToken)).status, 403)
  const stranger = await pending(f, f.askerDev.token, 'ask')
  assert.equal(stranger.status, 403); assert.equal(stranger.json.detail, 'not_coordinator')
  assert.equal((await pending(f, f.coordDev.token, 'ask')).status, 404)
  assert.equal((await f.s.http('/consent/pending', { token: f.coordDev.token })).status, 400)
  const r = await pending(f, f.coordDev.token)
  assert.equal(r.status, 200)
  const kinds = r.json.pending.map((p) => p.kind).sort()
  assert.deepEqual(kinds, ['chat', 'spawn'])
  const sp = r.json.pending.find((p) => p.kind === 'spawn')
  assert.equal(sp.id, spawnId); assert.equal(sp.from_name, 'asker-box'); assert.equal(sp.from_convo_id, 'ask'); assert.equal(sp.from_convo_title, 'Asker')
  assert.equal(sp.target_device_id, f.targetDev.deviceId); assert.equal(sp.target_name, 'opal'); assert.equal(sp.target_state, 'online')
  assert.equal(sp.workdir, '/home/alice/proj'); assert.equal(sp.task, 'fix the flaky test'); assert.equal(sp.topic, 'flaky test')
  assert.equal(typeof sp.created_at, 'number'); assert.equal(typeof sp.item_num, 'number')
  const ch = r.json.pending.find((p) => p.kind === 'chat')
  assert.equal(ch.id, `room/${f.targetDev.deviceId}`); assert.equal(ch.request, 'invite'); assert.equal(ch.room_id, 'room')
  assert.equal(ch.from_name, 'asker-box'); assert.equal(ch.from_convo_id, 'ask'); assert.equal(ch.to_name, 'opal'); assert.equal(ch.target_state, 'online')
  assert.equal(ch.topic, 'review'); assert.equal(ch.justification, 'need eyes on the diff'); assert.equal(typeof ch.item_num, 'number')
})

test('GET /consent/pending carries the causes a spawn and a chat ask were parked with, and none on an ask parked without', async (t) => {
  const f = await fleet(t)
  const spawnCauses = [{ kind: 'user_message', ref: 'ask:7', at: 1700000000000 }]
  const chatCauses = [{ kind: 'routine', ref: 'morning-sweep' }, { kind: 'item_reply', ref: 'it_1:c2', at: 1700000000001 }]
  const spawnId = await parkSpawn(f, { causes: spawnCauses })
  const bare = await parkSpawn(f, { rid: 'q2' })
  await parkInviteAsk(f, { causes: chatCauses })
  const rows = (await pending(f, f.coordDev.token)).json.pending
  assert.deepEqual(rows.find((p) => p.id === spawnId).causes, spawnCauses)
  assert.ok(!('causes' in rows.find((p) => p.id === bare)))
  assert.deepEqual(rows.find((p) => p.kind === 'chat').causes, chatCauses)
})

test('agent_invite and agent_join refuse present-but-unusable causes; nothing parks', async (t) => {
  const f = await fleet(t)
  f.asker.send({ op: 'agent_invite', room_id: 'room', target_device_id: f.targetDev.deviceId, justification: 'need eyes', from_convo_id: 'ask', causes: [{ kind: 'telepathy' }] })
  const e1 = await f.asker.waitFor((x) => x.kind === 'control' && x.op === 'error')
  assert.equal(e1.code, 'bad_request'); assert.equal(e1.detail, 'bad causes')
  f.target.send({ op: 'agent_join', room_id: 'room', justification: 'let me in', causes: [] })
  const e2 = await f.target.waitFor((x) => x.kind === 'control' && x.op === 'error')
  assert.equal(e2.code, 'bad_request'); assert.equal(e2.detail, 'bad causes')
  assert.equal(f.s.db.prepare("SELECT COUNT(*) n FROM convo_agents WHERE state='awaiting_user'").get().n, 0)
})

test('agent_invite with causes: null parks the ask with NULL causes', async (t) => {
  const f = await fleet(t)
  await parkInviteAsk(f, { causes: null })
  assert.equal(f.s.db.prepare("SELECT causes FROM convo_agents WHERE convo_id='room' AND agent_device_id=?").get(f.targetDev.deviceId).causes, null)
  assert.ok(!('causes' in (await pending(f, f.coordDev.token)).json.pending[0]))
})

test('agent_join stores the causes it carries on the parked row', async (t) => {
  const f = await fleet(t)
  const causes = [{ kind: 'handoff', ref: 'h1' }]
  f.target.send({ op: 'agent_join', room_id: 'room', justification: 'let me in', causes })
  await f.target.waitFor((x) => x.kind === 'invite' && x.event === 'delivered')
  assert.deepEqual(JSON.parse(f.s.db.prepare("SELECT causes FROM convo_agents WHERE convo_id='room' AND agent_device_id=?").get(f.targetDev.deviceId).causes), causes)
})

test('GET /consent/pending: a no-model spawn onto a box out of Fable carries the predicted Opus fallback, read at list time', async (t) => {
  const f = await fleet(t)
  await parkSpawn(f)
  assert.ok(!('fallback_model' in (await pending(f, f.coordDev.token)).json.pending[0]))
  upsertDeviceStatus(f.s.db, { userId: f.alice.id, deviceId: f.targetDev.deviceId, status: { limits: { as_of: 1, lines: [{ id: 'week_all', label: 'Week (all models)', percent: 40 }, { id: 'week_fable', label: 'Week (Fable)', percent: 100 }] } } })
  const sp = (await pending(f, f.coordDev.token)).json.pending[0]
  assert.equal(sp.fallback_model, 'opus'); assert.equal(sp.fallback_reason, 'fable_limit')
})

test('approve a spawn: the start RPC reaches the target, the outcome and its durable event carry decided_by coordinator + reason, the item closes "Approved by the Coordinator", the consent_decision event is client-only, the decision is recorded', async (t) => {
  const f = await fleet(t)
  const spawnId = await parkSpawn(f)
  const started = f.target.waitFor((x) => x.kind === 'rpc' && x.request?.method === 'start').then((req) => {
    f.target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child' } })
  })
  assert.equal((await answer(f, f.coordDev.token, { kind: 'spawn', id: spawnId, decision: 'approve', reason: '' })).status, 400)
  const r = await answer(f, f.coordDev.token, { kind: 'spawn', id: spawnId, decision: 'approve', reason: 'follows the box rules' })
  assert.equal(r.status, 200); assert.equal(r.json.ok, true)
  await started
  const out = await f.asker.waitFor((x) => x.kind === 'spawn' && x.event === 'outcome')
  assert.equal(out.outcome, 'started'); assert.equal(out.decided_by, 'coordinator'); assert.equal(out.reason, 'follows the box rules')
  const durable = await f.client.waitFor((x) => x.kind === 'journal' && x.type === 'spawn_outcome')
  assert.equal(durable.payload.decided_by, 'coordinator'); assert.equal(durable.payload.reason, 'follows the box rules')
  const decision = await f.client.waitFor((x) => x.kind === 'journal' && x.type === 'consent_decision')
  assert.equal(decision.convo_id, 'ask')
  assert.deepEqual(decision.payload, { kind: 'spawn', request_id: spawnId, decision: 'approve', by: 'coordinator', convo_id: 'coord', reason: 'follows the box rules', cause: null })
  await settle()
  assert.equal(f.asker.frames.find((x) => x.kind === 'journal' && x.type === 'consent_decision'), undefined)
  const row = getSpawn(f.s.db, spawnId)
  assert.equal(row.state, 'started'); assert.equal(row.answered_by, 'coordinator'); assert.equal(row.answer_reason, 'follows the box rules')
  const item = f.s.db.prepare('SELECT id, state, resolution FROM items WHERE id=?').get(row.item_id)
  assert.equal(item.state, 'closed'); assert.equal(item.resolution, 'decided')
  const note = f.s.db.prepare("SELECT body, author, device_id FROM item_comments WHERE item_id=? AND kind='status' ORDER BY created_at DESC").get(item.id)
  assert.match(note.body, /^Approved by the Coordinator — follows the box rules\. Starting the session on opal;/)
  assert.equal(note.author, 'agent'); assert.equal(note.device_id, f.coordDev.deviceId)
  const followUp = f.s.db.prepare("SELECT body FROM item_comments WHERE item_id=? AND kind='comment'").get(item.id)
  assert.equal(followUp.body, 'The session started on opal.')
  const rec = f.s.db.prepare('SELECT * FROM consent_decisions').all()
  assert.equal(rec.length, 1); assert.equal(rec[0].kind, 'spawn'); assert.equal(rec[0].ask_id, spawnId); assert.equal(rec[0].decision, 'approve'); assert.equal(rec[0].convo_id, 'coord')
})

test('decline a spawn: the parent hears declined with decided_by and the reason; a second answer is 409; an unknown id is 404', async (t) => {
  const f = await fleet(t)
  const spawnId = await parkSpawn(f)
  const r = await answer(f, f.coordDev.token, { kind: 'spawn', id: spawnId, decision: 'decline', reason: 'opal is a last-resort box and box-2 is free' })
  assert.equal(r.status, 200)
  const out = await f.asker.waitFor((x) => x.kind === 'spawn' && x.event === 'outcome')
  assert.equal(out.outcome, 'declined'); assert.equal(out.decided_by, 'coordinator'); assert.equal(out.reason, 'opal is a last-resort box and box-2 is free')
  assert.equal(getSpawn(f.s.db, spawnId).state, 'denied')
  const note = f.s.db.prepare("SELECT body FROM item_comments WHERE item_id=(SELECT item_id FROM agent_spawn_requests WHERE id=?) AND kind='status'").get(spawnId)
  assert.equal(note.body, 'Declined by the Coordinator — opal is a last-resort box and box-2 is free.')
  assert.equal((await answer(f, f.coordDev.token, { kind: 'spawn', id: spawnId, decision: 'approve', reason: 'x' })).status, 409)
  assert.equal((await answer(f, f.coordDev.token, { kind: 'spawn', id: 'nope', decision: 'approve', reason: 'x' })).status, 404)
  assert.equal((await answer(f, f.coordDev.token, { kind: 'spawn', id: spawnId, decision: 'maybe', reason: 'x' })).status, 400)
  assert.equal((await answer(f, f.coordDev.token, { kind: 'mail', id: spawnId, decision: 'approve', reason: 'x' })).status, 400)
})

