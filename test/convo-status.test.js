import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { sanitizeConvoStatus, upsertConvoStatus, convoStatuses, convoStatus } from '../src/convo-status.js'

// The persisted subset of a bridge's `status` op (spec 2026-09-29 coordinator
// session control §1): model, context gauge, usage-limit stall and account
// meters, per conversation, so the roster and mission detail can say how
// full a session is — for a sleeping box and across a journal restart.

const FRAME = {
  model: 'claude-opus-5-5', effort: 'high', workdir: '/home/dan/app', email: 'dan@example.com',
  context: { tokens: 87000, window: 1000000, pct: 9 },
  limits: [{ id: '5h', label: 'Current session', percent: 42, resets_at: '2026-09-29T15:00:00.000Z' }],
  stall: { kind: 'usage_limit', model: 'claude-fable-5-1', resets_at: '2026-09-29T15:00:00.000Z', since: 1758460000000 },
  vitals: { cpu: 12 }, model_options: [{ value: 'opus', label: 'Opus' }],
}

function userRow(db, name = 'dan') {
  db.prepare("INSERT INTO users(name, password_hash, created_at) VALUES(?,'x',0)").run(name)
  return { id: db.prepare('SELECT id FROM users WHERE name=?').get(name).id }
}

test('sanitizeConvoStatus keeps model, context, stall and limits; drops everything else', () => {
  const s = sanitizeConvoStatus(FRAME, 1758460001000)
  assert.deepEqual(Object.keys(s).sort(), ['context', 'limits', 'model', 'stall'])
  assert.equal(s.model, 'claude-opus-5-5')
  assert.deepEqual(s.context, { tokens: 87000, window: 1000000, pct: 9 })
  assert.deepEqual(s.stall, FRAME.stall)
  assert.deepEqual(s.limits, { as_of: 1758460001000, lines: FRAME.limits })
})

test('sanitizeConvoStatus drops an invalid block but keeps the rest; nothing valid -> null', () => {
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', context: { tokens: '87000', window: 1000000, pct: 9 } }), { model: 'x' })
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', context: { tokens: -1, window: 1000000, pct: 9 } }), { model: 'x' })
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', context: { tokens: 1, window: Infinity, pct: 9 } }), { model: 'x' })
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', context: { tokens: 1, window: 2, pct: 101 } }), { model: 'x' })
  assert.deepEqual(sanitizeConvoStatus({ context: { tokens: 1, window: 2, pct: 50 }, stall: { kind: 'other' } }), { context: { tokens: 1, window: 2, pct: 50 } })
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', stall: { kind: 'usage_limit', since: -5 } }), { model: 'x' })
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', limits: [{ id: '5h' }] }), { model: 'x' })
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', stall: { kind: 'usage_limit', resets_at: 'x'.repeat(41) } }), { model: 'x' })
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', stall: { kind: 'usage_limit', since: 4102444800001 } }), { model: 'x' })
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', stall: { kind: 'usage_limit', model: '   ' } }), { model: 'x' })
  assert.equal(sanitizeConvoStatus({ model: '' }), null)
  assert.equal(sanitizeConvoStatus({ model: '  \n ' }), null)
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', limits: { as_of: 1, lines: [] } }), { model: 'x' }, 'limits must be the bare lines array a bridge sends')
  assert.equal(sanitizeConvoStatus({ effort: 'high', vitals: {} }), null)
  assert.equal(sanitizeConvoStatus(null), null)
  assert.equal(sanitizeConvoStatus([]), null)
  assert.equal(sanitizeConvoStatus({ model: 'x'.repeat(65) }), null)
})

test('sanitizeConvoStatus strips control characters from peer strings and gives id-less meter lines an id', () => {
  const s = sanitizeConvoStatus({ model: 'claude-opus\u0007-5-5', stall: { kind: 'usage_limit', model: 'fable\u001b[0m', resets_at: '2026-09-29T15:00:00Z\u0000' } })
  // sanitizePeerText turns control characters into spaces, so an escape
  // sequence can no longer reach a terminal or a prompt intact.
  assert.equal(s.model, 'claude-opus -5-5')
  assert.equal(s.stall.model, 'fable [0m')
  assert.equal(s.stall.resets_at, '2026-09-29T15:00:00Z')
  // Older bridges and this repo's status fixtures send {label, percent} only.
  const l = sanitizeConvoStatus({ limits: [{ label: 'Session', percent: 39, resets: 'Jul 14, 5:59pm (UTC)' }, { id: 'week_all', label: 'Week (all models)', percent: 3 }] }, 5)
  assert.deepEqual(l.limits, { as_of: 5, lines: [{ id: 'session', label: 'Session', percent: 39, resets: 'Jul 14, 5:59pm (UTC)' }, { id: 'week_all', label: 'Week (all models)', percent: 3 }] })
})

test('upsertConvoStatus is latest-wins per conversation and cascades with the conversation', () => {
  const db = openDb(':memory:')
  const dan = userRow(db)
  const dev = createAgent(db, dan.id, 'gene')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'A', sessionState: 'running', agentDeviceId: dev.deviceId })
  upsertConversation(db, { id: 'c2', ownerUserId: dan.id, title: 'B', sessionState: 'running', agentDeviceId: dev.deviceId })
  upsertConvoStatus(db, { userId: dan.id, convoId: 'c1', status: { model: 'a' }, reportedAt: 10 })
  upsertConvoStatus(db, { userId: dan.id, convoId: 'c1', status: { model: 'b', context: { tokens: 1, window: 2, pct: 50 } }, reportedAt: 20 })
  upsertConvoStatus(db, { userId: dan.id, convoId: 'c2', status: { model: 'c' }, reportedAt: 30 })
  assert.deepEqual(convoStatus(db, dan.id, 'c1'), { reported_at: 20, model: 'b', context: { tokens: 1, window: 2, pct: 50 } })
  // A spawn/resume frame carries model and meters but no gauge yet: the
  // stored gauge survives it, while an omitted stall clears (replace).
  upsertConvoStatus(db, { userId: dan.id, convoId: 'c1', status: { model: 'b', stall: { kind: 'usage_limit' } }, reportedAt: 21 })
  assert.deepEqual(convoStatus(db, dan.id, 'c1'), { reported_at: 21, model: 'b', context: { tokens: 1, window: 2, pct: 50 }, stall: { kind: 'usage_limit' } })
  upsertConvoStatus(db, { userId: dan.id, convoId: 'c1', status: { model: 'b', limits: { as_of: 22, lines: [] } }, reportedAt: 22 })
  assert.deepEqual(convoStatus(db, dan.id, 'c1'), { reported_at: 22, model: 'b', context: { tokens: 1, window: 2, pct: 50 }, limits: { as_of: 22, lines: [] } })
  upsertConvoStatus(db, { userId: dan.id, convoId: 'c1', status: { model: 'c', context: { tokens: 3, window: 4, pct: 75 } }, reportedAt: 23 })
  assert.deepEqual(convoStatus(db, dan.id, 'c1'), { reported_at: 23, model: 'c', context: { tokens: 3, window: 4, pct: 75 }, limits: { as_of: 22, lines: [] } })
  assert.equal(convoStatus(db, dan.id + 1, 'c1'), null, 'scoped to the owner')
  assert.equal(convoStatus(db, dan.id, 'nope'), null)
  const all = convoStatuses(db, dan.id)
  assert.deepEqual([...all.keys()].sort(), ['c1', 'c2'])
  assert.equal(convoStatuses(db, dan.id + 1).size, 0)
  db.prepare('DELETE FROM conversations WHERE id=?').run('c1')
  assert.equal(convoStatus(db, dan.id, 'c1'), null)
  assert.equal(convoStatuses(db, dan.id).size, 1)
})

import { startTestServer, makeWsClient } from './helpers.js'
import { createUser } from '../src/auth.js'

test('the status op persists its roster subset; a frame with nothing persistable leaves the row alone', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan2', 'pw')
  const dev = createAgent(s.db, dan.id, 'gene')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan2', password: 'pw', device_name: 'mac' } })
  const agent = await makeWsClient(s.base, { token: dev.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { agent.close(); client.close() })
  agent.send({ op: 'convo_upsert', convo_id: 'w1', title: 'Work', session_state: 'running' })
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  // The persist runs before the ephemeral fan-out, so a viewing client's
  // receipt of the frame proves the row is written (no fixed sleeps).
  client.send({ op: 'viewing', convo_id: 'w1' })
  await client.waitFor((f) => f.kind === 'tool_stream' || (f.kind === 'ephemeral' && f.convo_id === 'w1') || f.op === 'ok', 500).catch(() => {})
  agent.send({ op: 'status', convo_id: 'w1', status: FRAME })
  await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'w1' && f.status?.model === 'claude-opus-5-5')
  const stored = convoStatus(s.db, dan.id, 'w1')
  assert.equal(stored.model, 'claude-opus-5-5')
  assert.deepEqual(stored.context, { tokens: 87000, window: 1000000, pct: 9 })
  assert.equal(stored.limits.lines[0].id, '5h')
  assert.equal(stored.limits.as_of, stored.reported_at, 'one clock for the row and its meters')
  assert.equal('effort' in stored, false)
  assert.ok(Number.isInteger(stored.reported_at))
  agent.send({ op: 'status', convo_id: 'w1', status: { effort: 'high' } })
  await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'w1' && f.status?.effort === 'high')
  assert.equal(convoStatus(s.db, dan.id, 'w1').model, 'claude-opus-5-5')
  // Ownership still gates the write: a conversation this device may not
  // write to is refused before anything is persisted.
  const other = createAgent(s.db, dan.id, 'eric')
  upsertConversation(s.db, { id: 'w2', ownerUserId: dan.id, title: 'Theirs', sessionState: 'running', agentDeviceId: other.deviceId })
  agent.send({ op: 'status', convo_id: 'w2', status: FRAME })
  await agent.waitFor((f) => f.op === 'error' && f.code === 'forbidden')
  assert.equal(convoStatus(s.db, dan.id, 'w2'), null)
})

import { createMission, joinMission } from '../src/missions.js'

test('roster and mission-detail conversation rows carry the persisted status; unreported rows have no key', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan3', 'pw')
  const dev = createAgent(s.db, dan.id, 'gene')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan3', password: 'pw', device_name: 'mac' } })
  const token = login.json.token
  upsertConversation(s.db, { id: 'r1', ownerUserId: dan.id, title: 'A', sessionState: 'waiting', agentDeviceId: dev.deviceId })
  upsertConversation(s.db, { id: 'r2', ownerUserId: dan.id, title: 'B', sessionState: 'waiting', agentDeviceId: dev.deviceId })
  const status = { model: 'claude-opus-5-5', context: { tokens: 87000, window: 1000000, pct: 9 } }
  upsertConvoStatus(s.db, { userId: dan.id, convoId: 'r1', status, reportedAt: 123 })
  const roster = await s.http('/roster', { token })
  const r1 = roster.json.conversations.find((c) => c.id === 'r1')
  const r2 = roster.json.conversations.find((c) => c.id === 'r2')
  assert.deepEqual(r1.status, { reported_at: 123, ...status })
  assert.equal('status' in r2, false)
  // An agent token reads the same block.
  const asAgent = await s.http('/roster', { token: dev.token })
  assert.deepEqual(asAgent.json.conversations.find((c) => c.id === 'r1').status, { reported_at: 123, ...status })
  // Mission detail: the same block on its conversation rows, own-user view.
  const m = createMission(s.db, { userId: dan.id, deviceId: dev.deviceId, createdBy: 'agent', convoId: 'r1', title: 'M' })
  joinMission(s.db, { userId: dan.id, missionId: m.mission.id, convoId: 'r2' })
  const detail = await s.http(`/missions/${m.mission.id}`, { token })
  assert.equal(detail.status, 200)
  const d1 = detail.json.conversations.find((c) => c.id === 'r1')
  const d2 = detail.json.conversations.find((c) => c.id === 'r2')
  assert.deepEqual(d1.status, { reported_at: 123, ...status })
  assert.equal(d1.box, 'gene')
  assert.equal('status' in d2, false)
  assert.equal('status_json' in d1, false)
})

test('a private box\'s conversation stays hidden from an ordinary agent, status row or not; the client sees both', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan4', 'pw')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan4', password: 'pw', device_name: 'mac' } })
  const ordinary = createAgent(s.db, dan.id, 'gene')
  const priv = createAgent(s.db, dan.id, 'vault')
  s.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(priv.deviceId)
  upsertConversation(s.db, { id: 'p1', ownerUserId: dan.id, title: 'Secret', sessionState: 'waiting', agentDeviceId: priv.deviceId })
  upsertConversation(s.db, { id: 'o1', ownerUserId: dan.id, title: 'Open', sessionState: 'waiting', agentDeviceId: ordinary.deviceId })
  upsertConvoStatus(s.db, { userId: dan.id, convoId: 'p1', status: { model: 'claude-opus-5-5' }, reportedAt: 1 })
  upsertConvoStatus(s.db, { userId: dan.id, convoId: 'o1', status: { model: 'claude-sonnet-5' }, reportedAt: 2 })
  const asOrdinary = await s.http('/roster', { token: ordinary.token })
  assert.equal(asOrdinary.json.conversations.find((c) => c.id === 'p1'), undefined)
  assert.equal(asOrdinary.json.conversations.find((c) => c.id === 'o1').status.model, 'claude-sonnet-5')
  const asClient = await s.http('/roster', { token: login.json.token })
  assert.equal(asClient.json.conversations.find((c) => c.id === 'p1').status.model, 'claude-opus-5-5')
  const m = createMission(s.db, { userId: dan.id, deviceId: priv.deviceId, createdBy: 'agent', convoId: 'p1', title: 'M' })
  joinMission(s.db, { userId: dan.id, missionId: m.mission.id, convoId: 'o1' })
  const detailAsOrdinary = await s.http(`/missions/${m.mission.id}`, { token: ordinary.token })
  if (detailAsOrdinary.status === 200) {
    assert.equal(detailAsOrdinary.json.conversations.find((c) => c.id === 'p1'), undefined)
    assert.equal(detailAsOrdinary.json.conversations.find((c) => c.id === 'o1').status.model, 'claude-sonnet-5')
  } else {
    assert.equal(detailAsOrdinary.status, 404, 'a mission originating on a private box is invisible to an ordinary agent')
  }
  const detailAsClient = await s.http(`/missions/${m.mission.id}`, { token: login.json.token })
  assert.equal(detailAsClient.json.conversations.find((c) => c.id === 'p1').status.model, 'claude-opus-5-5')
})
