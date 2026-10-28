import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { append, upsertConversation } from '../src/journal.js'
import { getSpawn } from '../src/spawns.js'
import { getAutoApproveCoordinatorSpawns, setAutoApproveCoordinatorSpawns, setNoticesEnabled } from '../src/settings.js'
import { makeWsClient } from './helpers.js'
import { fleet, parkInviteAsk } from './consent-fleet.js'

const reason = 'auto-approved (Coordinator)'
const enable = (f) => setAutoApproveCoordinatorSpawns(f.s.db, f.alice.id, true)
// The user's words in the asking conversation: the verified cause the
// Coordinator own-ask rule (src/consent-own-ask.js) needs before an ask may
// be auto-approved.
const userSays = (f, convo = 'coord') => {
  const { seq } = append(f.s.db, { userId: f.alice.id, convoId: convo, sender: 'user:alice', type: 'text', payload: { body: 'please start a helper' } })
  return [{ kind: 'user_message', ref: `${convo}:${seq}` }]
}
async function request(f, { from = 'coord', ws = f.coord, target = f.targetDev.deviceId, causes = userSays(f, from) } = {}) {
  ws.send({ op: 'spawn_request', request_id: 'auto-test', from_convo_id: from, target_device_id: target, workdir: '/project', task: 'Run the checks', ...(causes ? { causes } : {}) })
  const ack = await ws.waitFor((x) => x.kind === 'spawn' && x.event === 'pending')
  return getSpawn(f.s.db, ack.spawn_id)
}
function parked(f, row) {
  assert.equal(row.state, 'awaiting_user')
  assert.equal(row.answered_by, null)
  assert.equal(row.answer_reason, null)
  assert.equal(f.s.db.prepare('SELECT state FROM items WHERE id=?').get(row.item_id).state, 'open')
  assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM consent_decisions').get().n, 0)
  assert.equal(f.target.frames.some((x) => x.kind === 'rpc' && x.request?.method === 'start'), false)
}

test('default off keeps Coordinator spawns parked', async (t) => {
  const f = await fleet(t)
  assert.equal(getAutoApproveCoordinatorSpawns(f.s.db, f.alice.id), false)
  parked(f, await request(f))
})

test('opt-in approves an online Coordinator spawn, records the decision and closes its item even at the daily cap', async (t) => {
  const f = await fleet(t, { consentDailyCap: 1 })
  enable(f)
  f.s.db.prepare('INSERT INTO consent_decisions(user_id, kind, ask_id, decision, convo_id, reason, created_at) VALUES(?,?,?,?,?,?,?)')
    .run(f.alice.id, 'spawn', 'previous', 'approve', 'coord', 'approved', Date.now())
  const row = await request(f)
  assert.equal(row.state, 'approved')
  const rpc = await f.target.waitFor((x) => x.kind === 'rpc' && x.request?.method === 'start')
  f.target.send({ op: 'agent_response', request_id: rpc.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child' } })
  const outcome = await f.coord.waitFor((x) => x.kind === 'spawn' && x.event === 'outcome')
  assert.equal(outcome.outcome, 'started')
  assert.equal(outcome.decided_by, 'coordinator')
  assert.equal(outcome.reason, reason)
  const started = getSpawn(f.s.db, row.id)
  assert.equal(started.state, 'started')
  assert.equal(started.answered_by, 'coordinator')
  assert.equal(started.answer_reason, reason)
  assert.equal(f.s.db.prepare('SELECT state FROM items WHERE id=?').get(row.item_id).state, 'closed')
  const record = f.s.db.prepare('SELECT * FROM consent_decisions WHERE ask_id=?').get(row.id)
  assert.equal(record.convo_id, 'coord')
  assert.equal(record.reason, reason)
  const event = await f.client.waitFor((x) => x.type === 'consent_decision')
  assert.equal(event.payload.request_id, row.id)
  assert.equal(event.payload.reason, reason)
  assert.equal(f.coord.frames.some((x) => x.kind === 'consent' && x.event === 'pending'), false)
})

test('opt-in only applies to the selected Coordinator conversation, even on the same device', async (t) => {
  const f = await fleet(t)
  enable(f)
  upsertConversation(f.s.db, { id: 'other', ownerUserId: f.alice.id, agentDeviceId: f.coordDev.deviceId })
  parked(f, await request(f, { from: 'other' }))
})

test('opt-in keeps an asleep, wakeable target parked', async (t) => {
  const calls = []
  const f = await fleet(t, { waker: { enabled: true, wake: (name) => { calls.push(name); return true } } })
  enable(f)
  const closed = once(f.target.ws, 'close')
  f.target.close()
  await closed
  parked(f, await request(f))
  assert.deepEqual(calls, ['opal'])
})

test('opt-in preserves the refusal for an offline, unwakeable target', async (t) => {
  const f = await fleet(t, { waker: { enabled: false } })
  enable(f)
  const closed = once(f.target.ws, 'close')
  f.target.close()
  await closed
  f.coord.send({ op: 'spawn_request', request_id: 'offline', from_convo_id: 'coord', target_device_id: f.targetDev.deviceId, workdir: '/project', task: 'Run checks' })
  const error = await f.coord.waitFor((x) => x.op === 'error' && x.request_id === 'offline')
  assert.equal(error.code, 'agent_unreachable')
  assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM agent_spawn_requests').get().n, 0)
})

test('Coordinator consent off keeps an opted-in spawn parked', async (t) => {
  const f = await fleet(t)
  enable(f)
  await f.s.http('/coordinator', { method: 'PUT', token: f.clientToken, body: { consent: false } })
  parked(f, await request(f))
})

for (const side of ['coordDev', 'targetDev']) {
  test(`user-only ${side} keeps an opted-in spawn parked`, async (t) => {
    const f = await fleet(t)
    enable(f)
    f.s.db.prepare('UPDATE devices SET consent_user_only=1 WHERE id=?').run(f[side].deviceId)
    parked(f, await request(f))
  })
}

test('automatic answer failure leaves the filed card and item available', async (t) => {
  const f = await fleet(t)
  enable(f)
  f.s.db.exec("CREATE TRIGGER fail_approval BEFORE UPDATE OF state ON agent_spawn_requests WHEN NEW.state='approved' BEGIN SELECT RAISE(ABORT, 'test approval failure'); END")
  const row = await request(f)
  parked(f, row)
  const card = await f.client.waitFor((x) => x.payload?.kind === 'agent_spawn')
  assert.equal(card.payload.request_id, row.id)
})

test('opt-in does not approve chat invites or requests targeting another user', async (t) => {
  const f = await fleet(t)
  enable(f)
  await parkInviteAsk(f)
  assert.equal(f.s.db.prepare('SELECT state FROM convo_agents WHERE convo_id=? AND agent_device_id=?').get('room', f.targetDev.deviceId).state, 'awaiting_user')
  const other = await createUser(f.s.db, 'other', 'pw')
  const device = createAgent(f.s.db, other.id, 'other-box')
  f.coord.send({ op: 'spawn_request', request_id: 'foreign', from_convo_id: 'coord', target_device_id: device.deviceId, workdir: '/project', task: 'Run checks' })
  assert.equal((await f.coord.waitFor((x) => x.op === 'error' && x.request_id === 'foreign')).code, 'not_found')
})

test('settings roundtrip accepts either switch alone or both, validates all keys, and broadcasts the full view', async (t) => {
  const f = await fleet(t)
  const defaults = { notices: true, auto_approve_coordinator_spawns: false, auto_archive_days: 30 }
  assert.deepEqual((await f.s.http('/settings', { token: f.coordDev.token })).json, defaults)
  assert.equal((await f.s.http('/settings', { method: 'PATCH', token: f.coordDev.token, body: { auto_approve_coordinator_spawns: true } })).status, 403)
  for (const value of [null, 0, 1, 'true', [], {}]) {
    const r = await f.s.http('/settings', { method: 'PATCH', token: f.clientToken, body: { notices: false, auto_approve_coordinator_spawns: value } })
    assert.equal(r.status, 400)
  }
  for (const body of [{}, { unknown: true }, []]) {
    assert.equal((await f.s.http('/settings', { method: 'PATCH', token: f.clientToken, body })).status, 400)
  }
  assert.deepEqual((await f.s.http('/settings', { token: f.clientToken })).json, defaults)
  for (const [body, expected] of [
    [{ auto_approve_coordinator_spawns: true }, { ...defaults, auto_approve_coordinator_spawns: true }],
    [{ notices: false }, { ...defaults, notices: false, auto_approve_coordinator_spawns: true }],
    [{ notices: true, auto_approve_coordinator_spawns: false }, defaults],
  ]) {
    for (const w of [f.coord, f.client]) w.frames.length = 0
    const r = await f.s.http('/settings', { method: 'PATCH', token: f.clientToken, body })
    assert.equal(r.status, 200)
    assert.deepEqual(r.json, expected)
    for (const w of [f.coord, f.client]) {
      assert.deepEqual((await w.waitFor((x) => x.op === 'settings')).settings, expected)
    }
    assert.deepEqual((await f.s.http('/settings', { token: f.clientToken })).json, expected)
  }
  const next = await makeWsClient(f.s.base, { token: f.coordDev.token, cursor: null })
  t.after(() => next.close())
  assert.deepEqual((await next.waitFor((x) => x.op === 'hello_ok')).settings, defaults)
  const other = await createUser(f.s.db, 'other', 'pw')
  assert.equal(getAutoApproveCoordinatorSpawns(f.s.db, other.id), false)
})

test('existing databases migrate the opt-in as off without changing settings; reopen preserves an enabled value', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'journal.db')
  let db = openDb(path)
  const user = await createUser(db, 'user', 'pw')
  assert.equal(getAutoApproveCoordinatorSpawns(db, user.id), false)
  setNoticesEnabled(db, user.id, false)
  db.exec('ALTER TABLE user_settings DROP COLUMN auto_approve_coordinator_spawns')
  db.close()
  db = openDb(path)
  assert.equal(getAutoApproveCoordinatorSpawns(db, user.id), false)
  assert.equal(db.prepare('SELECT notices FROM user_settings WHERE user_id=?').get(user.id).notices, 0)
  setAutoApproveCoordinatorSpawns(db, user.id, true)
  db.close()
  db = openDb(path)
  try { assert.equal(getAutoApproveCoordinatorSpawns(db, user.id), true) } finally { db.close() }
})

test('opt-in does not waive the own-ask rule: no cause, an unverified cause or a non-user cause stays parked', async (t) => {
  const f = await fleet(t)
  enable(f)
  parked(f, await request(f, { causes: null }))
  parked(f, await request(f, { causes: [{ kind: 'user_message', ref: 'coord:99999' }] }))
  parked(f, await request(f, { causes: [{ kind: 'reminder' }] }))
})
