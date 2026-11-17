import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { append, upsertConversation } from '../src/journal.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { setConsentEnabled, autoApprovalsSince, recordConsentDecision, coordinatorApprovalsSince, AUTO_APPROVE_REASON, AUTO_APPROVE_WINDOW_MS, AUTO_APPROVE_HOURLY_CAP } from '../src/consent.js'
import { getAutoApproveCoordinatorSpawns, setAutoApproveCoordinatorSpawns, setNoticesEnabled } from '../src/settings.js'
import { createRoutine } from '../src/routines.js'
import { makeHub } from '../src/hub.js'
import { handleOp } from '../src/ws.js'
import { answerSpawnAsk } from '../src/consent-answer.js'
import { handleSettingsRoute } from '../src/settings-http.js'

// Exercise the production handlers without binding a network port.
async function fixture(t) {
  const db = openDb(':memory:')
  const hub = makeHub()
  t.after(() => { hub.close(); db.close() })
  const user = await createUser(db, 'user', 'pw')
  const parent = createAgent(db, user.id, 'parent-box')
  const target = createAgent(db, user.id, 'target-box')
  const frames = []
  const conn = { userId: user.id, deviceId: parent.deviceId, kind: 'agent', registered: true, name: 'parent-box', ws: { readyState: 1, send: (s) => frames.push(JSON.parse(s)) } }
  hub.register(conn)
  const targetConn = { userId: user.id, deviceId: target.deviceId, kind: 'agent', registered: true, ws: { readyState: 1, send() {} } }
  hub.register(targetConn)
  for (const id of ['coordinator', 'other']) upsertConversation(db, { id, ownerUserId: user.id, agentDeviceId: parent.deviceId })
  setCoordinatorConvoId(db, user.id, 'coordinator')
  const calls = []
  const broker = { issue: async (...args) => { calls.push(args); return { ok: true, result: { convo_id: 'child' } } } }
  const ctx = { db, hub, conn, broker, spawnStartTimeoutMs: 1234 }
  // The user's verified words in the asking conversation: the cause the
  // Coordinator own-ask rule needs before an ask may be auto-approved.
  const request = (from = 'coordinator', causes) => {
    const { seq } = append(db, { userId: user.id, convoId: from, sender: 'user:user', type: 'text', payload: { body: 'start a helper' } })
    return handleOp({ ...ctx, msg: { op: 'spawn_request', request_id: 'req', from_convo_id: from, target_device_id: target.deviceId, workdir: '/project', task: 'Run checks', causes: causes === undefined ? [{ kind: 'user_message', ref: `${from}:${seq}` }] : causes } })
  }
  return { db, hub, user, parent, target, targetConn, frames, calls, ctx, request }
}

for (const scenario of ['default', 'enabled', 'other', 'asleep', 'closed socket', 'consent off', 'user only', 'requester user only', 'protected target', 'no cause', 'unverified cause', 'non-user cause', 'claim failure', 'claim conflict', 'record failure', 'hourly cap']) {
  test(`spawn handler: ${scenario}`, async (t) => {
    const f = await fixture(t)
    if (scenario !== 'default') setAutoApproveCoordinatorSpawns(f.db, f.user.id, true)
    if (scenario === 'consent off') setConsentEnabled(f.db, f.user.id, false)
    if (scenario === 'user only') f.db.prepare('UPDATE devices SET consent_user_only=1 WHERE id=?').run(f.target.deviceId)
    if (scenario === 'requester user only') f.db.prepare('UPDATE devices SET consent_user_only=1 WHERE id=?').run(f.parent.deviceId)
    if (scenario === 'protected target') f.db.prepare('UPDATE devices SET protected=1 WHERE id=?').run(f.target.deviceId)
    if (scenario === 'asleep' || scenario === 'closed socket') {
      if (scenario === 'asleep') f.hub.unregister(f.targetConn)
      else f.targetConn.ws.readyState = 3
      f.ctx.waker = { enabled: true, wake: () => true }
    }
    if (scenario === 'claim failure') f.db.exec("CREATE TRIGGER fail_approval BEFORE UPDATE OF state ON agent_spawn_requests WHEN NEW.state='approved' BEGIN SELECT RAISE(ABORT, 'test failure'); END")
    if (scenario === 'claim conflict') f.db.exec("CREATE TRIGGER ignore_approval BEFORE UPDATE OF state ON agent_spawn_requests WHEN NEW.state='approved' BEGIN SELECT RAISE(IGNORE); END")
    if (scenario === 'record failure') f.db.exec("CREATE TRIGGER fail_record BEFORE INSERT ON consent_decisions BEGIN SELECT RAISE(ABORT, 'test recording failure'); END")
    if (scenario === 'hourly cap') {
      const ins = f.db.prepare('INSERT INTO consent_decisions(user_id, kind, ask_id, decision, convo_id, reason, created_at) VALUES(?,?,?,?,?,?,?)')
      for (let i = 0; i < 60; i++) ins.run(f.user.id, 'spawn', `p${i}`, 'approve', 'coordinator', 'auto-approved (Coordinator)', Date.now())
    }
    if (scenario === 'enabled') f.ctx.consentDailyCap = 1
    if (scenario === 'enabled') f.db.prepare('INSERT INTO consent_decisions(user_id, kind, ask_id, decision, convo_id, reason, created_at) VALUES(?,?,?,?,?,?,?)')
      .run(f.user.id, 'spawn', 'previous', 'approve', 'coordinator', 'approved', Date.now())
    await f.request(scenario === 'other' ? 'other' : 'coordinator',
      scenario === 'no cause' ? null : scenario === 'unverified cause' ? [{ kind: 'user_message', ref: 'coordinator:99999' }]
        : scenario === 'non-user cause' ? [{ kind: 'reminder' }] : undefined)
    // The orchestration runs off the request cycle.
    await new Promise((resolve) => setImmediate(resolve))
    const ack = f.frames.find((x) => x.kind === 'spawn' && x.event === 'pending')
    assert.ok(ack)
    const row = f.db.prepare('SELECT * FROM agent_spawn_requests WHERE id=?').get(ack.spawn_id)
    const item = f.db.prepare('SELECT * FROM items WHERE id=?').get(row.item_id)
    if (scenario === 'enabled') {
      assert.equal(row.state, 'started')
      assert.equal(row.answered_by, 'coordinator')
      assert.equal(row.answer_reason, 'auto-approved (Coordinator)')
      assert.equal(item.state, 'closed')
      assert.equal(f.calls.length, 1)
      assert.equal(f.calls[0][5].timeoutMs, 1234)
      const record = f.db.prepare('SELECT * FROM consent_decisions WHERE ask_id=?').get(row.id)
      assert.equal(record.reason, 'auto-approved (Coordinator)')
      assert.equal(record.convo_id, 'coordinator')
      assert.equal(coordinatorApprovalsSince(f.db, f.user.id, 0), 2)
    } else {
      assert.equal(row.state, 'awaiting_user')
      assert.equal(row.answered_by, null)
      assert.equal(item.state, 'open')
      assert.equal(f.calls.length, 0)
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM consent_decisions WHERE ask_id=?').get(row.id).n, 0)
    }
  })
}

test('settings handler accepts partial changes, rejects invalid values and agent writes, and broadcasts', async (t) => {
  const f = await fixture(t)
  async function route(method, body, kind = 'client') {
    const req = Readable.from([JSON.stringify(body)])
    req.method = method
    const res = { writeHead(status) { this.status = status }, end(s) { this.body = JSON.parse(s) } }
    await handleSettingsRoute(f.ctx, req, res, { pathname: '/settings' }, { userId: f.user.id, kind })
    return res
  }
  const defaults = { notices: true, auto_approve_coordinator_spawns: false, auto_archive_days: 30 }
  assert.deepEqual((await route('GET')).body, defaults)
  for (const value of [null, 0, 'true', [], {}]) {
    assert.equal((await route('PATCH', { notices: false, auto_approve_coordinator_spawns: value })).status, 400)
  }
  assert.deepEqual((await route('GET')).body, defaults)
  assert.equal((await route('PATCH', { auto_approve_coordinator_spawns: true }, 'agent')).status, 403)
  assert.equal((await route('PATCH', {})).status, 400)
  assert.equal((await route('PATCH', { other: true })).status, 400)
  assert.deepEqual((await route('PATCH', { auto_approve_coordinator_spawns: true })).body, { ...defaults, auto_approve_coordinator_spawns: true })
  assert.deepEqual((await route('PATCH', { notices: false })).body, { ...defaults, notices: false, auto_approve_coordinator_spawns: true })
  assert.deepEqual(f.frames.filter((x) => x.op === 'settings').at(-1).settings, { ...defaults, notices: false, auto_approve_coordinator_spawns: true })
  assert.deepEqual((await route('PUT', defaults)).body, defaults)
})

test('automatic approvals retain their verified cause in history and count toward daily answers', async (t) => {
  const f = await fixture(t)
  setAutoApproveCoordinatorSpawns(f.db, f.user.id, true)
  await f.request()
  await new Promise((resolve) => setImmediate(resolve))
  const row = f.db.prepare('SELECT * FROM consent_decisions').get()
  assert.equal(row.cause_kind, 'user')
  assert.match(row.cause_ref, /^coordinator:/)
  assert.equal(coordinatorApprovalsSince(f.db, f.user.id, 0), 1)
})

test('hourly counter excludes old, manual, chat, declined and other-user decisions', async (t) => {
  const f = await fixture(t)
  const other = await createUser(f.db, 'other', 'pw')
  const since = 100000
  const base = { userId: f.user.id, kind: 'spawn', decision: 'approve', convoId: 'coordinator', reason: AUTO_APPROVE_REASON, now: since + 1 }
  for (const [i, fields] of [
    {}, { now: since }, { now: since - 1 }, { reason: 'approved' },
    { kind: 'chat' }, { decision: 'decline' }, { userId: other.id },
  ].entries()) recordConsentDecision(f.db, { ...base, askId: `ask-${i}`, ...fields })
  assert.equal(autoApprovalsSince(f.db, f.user.id, since), 1)
})

test('the last hourly slot is consumed synchronously and the next request stays parked', async (t) => {
  const f = await fixture(t)
  setAutoApproveCoordinatorSpawns(f.db, f.user.id, true)
  for (let i = 0; i < AUTO_APPROVE_HOURLY_CAP - 1; i++) {
    recordConsentDecision(f.db, { userId: f.user.id, kind: 'spawn', askId: `previous-${i}`, decision: 'approve', convoId: 'coordinator', reason: AUTO_APPROVE_REASON })
  }
  await Promise.all([f.request(), f.request()])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.calls.length, 1)
  assert.equal(autoApprovalsSince(f.db, f.user.id, Date.now() - AUTO_APPROVE_WINDOW_MS), AUTO_APPROVE_HOURLY_CAP)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM agent_spawn_requests WHERE state='awaiting_user'").get().n, 1)
})

test('a verified routine root still waits for the checked consent route', async (t) => {
  const f = await fixture(t)
  setAutoApproveCoordinatorSpawns(f.db, f.user.id, true)
  const firedAt = Date.now() - 60000
  createRoutine(f.db, { userId: f.user.id, origin: 'user', fields: {
    name: 'sweep', title: 'Sweep', schedule: '0 8 * * *', tz: 'UTC', prompt: 'Run checks', enabled: true,
  } })
  f.db.prepare('UPDATE routines SET last_fired_at=?, envelope=? WHERE user_id=? AND name=?')
    .run(firedAt, JSON.stringify({ spawns_per_fire: 1, chats: false, boxes: null }), f.user.id, 'sweep')
  await f.request('coordinator', [{ kind: 'routine', ref: `routine:sweep@${new Date(firedAt).toISOString()}` }])
  assert.equal(f.db.prepare('SELECT state FROM agent_spawn_requests').get().state, 'awaiting_user')
  assert.equal(f.calls.length, 0)
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


test('automatic approval never reaches a device belonging to another user', async (t) => {
  const f = await fixture(t)
  setAutoApproveCoordinatorSpawns(f.db, f.user.id, true)
  const other = await createUser(f.db, 'other', 'pw')
  f.db.prepare('UPDATE devices SET user_id=? WHERE id=?').run(other.id, f.target.deviceId)
  await f.request()
  assert.equal(f.frames.at(-1).code, 'not_found')
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM agent_spawn_requests').get().n, 0)
  assert.equal(f.calls.length, 0)
})

test('the automatic path is identified by a flag, not by the reason text', async (t) => {
  const f = await fixture(t)
  await f.request()
  await new Promise((resolve) => setImmediate(resolve))
  const ack = f.frames.find((x) => x.kind === 'spawn' && x.event === 'pending')
  const decidedBy = { kind: 'coordinator', deviceId: f.parent.deviceId, convoId: 'coordinator', reason: AUTO_APPROVE_REASON, causeKind: 'routine', causeRef: 'r1', verifierNote: 'checked' }
  const r = answerSpawnAsk(f.ctx, { userId: f.user.id, requestId: ack.spawn_id, decision: 'approve', decidedBy })
  assert.equal(r.status, 200)
  // The same text as an ordinary Coordinator answer keeps the verifier note
  // and is announced without the automatic marker.
  const row = f.db.prepare('SELECT * FROM consent_decisions WHERE ask_id=?').get(ack.spawn_id)
  assert.equal(row.verifier_note, 'checked')
  const ev = f.db.prepare("SELECT payload FROM events WHERE type='consent_decision'").get()
  assert.equal('auto' in JSON.parse(ev.payload), false)
})

test('an automatic approval marks its consent_decision event with auto: true', async (t) => {
  const f = await fixture(t)
  setAutoApproveCoordinatorSpawns(f.db, f.user.id, true)
  await f.request()
  await new Promise((resolve) => setImmediate(resolve))
  const ev = f.db.prepare("SELECT payload FROM events WHERE type='consent_decision'").get()
  assert.equal(JSON.parse(ev.payload).auto, true)
})
