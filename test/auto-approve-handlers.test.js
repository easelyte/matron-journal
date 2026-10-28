import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { append, upsertConversation } from '../src/journal.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { setConsentEnabled } from '../src/consent.js'
import { setAutoApproveCoordinatorSpawns } from '../src/settings.js'
import { makeHub } from '../src/hub.js'
import { handleOp } from '../src/ws.js'
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
  const request = (from = 'coordinator') => {
    const { seq } = append(db, { userId: user.id, convoId: from, sender: 'user:user', type: 'text', payload: { body: 'start a helper' } })
    return handleOp({ ...ctx, msg: { op: 'spawn_request', request_id: 'req', from_convo_id: from, target_device_id: target.deviceId, workdir: '/project', task: 'Run checks', causes: [{ kind: 'user_message', ref: `${from}:${seq}` }] } })
  }
  return { db, hub, user, parent, target, targetConn, frames, calls, ctx, request }
}

for (const scenario of ['default', 'enabled', 'other', 'asleep', 'closed socket', 'consent off', 'user only', 'claim failure', 'claim conflict', 'hourly cap']) {
  test(`spawn handler: ${scenario}`, async (t) => {
    const f = await fixture(t)
    if (scenario !== 'default') setAutoApproveCoordinatorSpawns(f.db, f.user.id, true)
    if (scenario === 'consent off') setConsentEnabled(f.db, f.user.id, false)
    if (scenario === 'user only') f.db.prepare('UPDATE devices SET consent_user_only=1 WHERE id=?').run(f.target.deviceId)
    if (scenario === 'asleep' || scenario === 'closed socket') {
      if (scenario === 'asleep') f.hub.unregister(f.targetConn)
      else f.targetConn.ws.readyState = 3
      f.ctx.waker = { enabled: true, wake: () => true }
    }
    if (scenario === 'claim failure') f.db.exec("CREATE TRIGGER fail_approval BEFORE UPDATE OF state ON agent_spawn_requests WHEN NEW.state='approved' BEGIN SELECT RAISE(ABORT, 'test failure'); END")
    if (scenario === 'claim conflict') f.db.exec("CREATE TRIGGER ignore_approval BEFORE UPDATE OF state ON agent_spawn_requests WHEN NEW.state='approved' BEGIN SELECT RAISE(IGNORE); END")
    if (scenario === 'hourly cap') {
      const ins = f.db.prepare('INSERT INTO consent_decisions(user_id, kind, ask_id, decision, convo_id, reason, created_at) VALUES(?,?,?,?,?,?,?)')
      for (let i = 0; i < 60; i++) ins.run(f.user.id, 'spawn', `p${i}`, 'approve', 'coordinator', 'auto-approved (Coordinator)', Date.now())
    }
    if (scenario === 'enabled') f.db.prepare('INSERT INTO consent_decisions(user_id, kind, ask_id, decision, convo_id, reason, created_at) VALUES(?,?,?,?,?,?,?)')
      .run(f.user.id, 'spawn', 'previous', 'approve', 'coordinator', 'approved', Date.now())
    await f.request(scenario === 'other' ? 'other' : 'coordinator')
    // The orchestration runs off the request cycle.
    await new Promise((resolve) => setImmediate(resolve))
    const ack = f.frames.find((x) => x.kind === 'spawn' && x.event === 'pending')
    assert.ok(ack)
    const row = f.db.prepare('SELECT * FROM agent_spawn_requests WHERE id=?').get(ack.spawn_id)
    const item = f.db.prepare('SELECT * FROM items WHERE id=?').get(row.item_id)
    assert.equal(ack.auto_approved === true, ['enabled', 'claim failure', 'claim conflict'].includes(scenario))
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
    } else {
      assert.equal(row.state, 'awaiting_user')
      assert.equal(row.answered_by, null)
      assert.equal(item.state, 'open')
      assert.equal(f.calls.length, 0)
    }
  })
}

test('settings handler accepts partial changes, rejects invalid values and agent writes, and broadcasts', async (t) => {
  const f = await fixture(t)
  async function route(method, body, kind = 'client') {
    const req = Readable.from([JSON.stringify(body)])
    req.method = method
    const res = { writeHead(status) { this.status = status }, end(s) { this.body = JSON.parse(s) } }
    await handleSettingsRoute(f.ctx, req, res, new URL('http://localhost/settings'), { userId: f.user.id, kind })
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
