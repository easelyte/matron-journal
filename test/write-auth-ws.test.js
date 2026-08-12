import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { inviteParticipant, answerInvite, leaveConvo } from '../src/participants.js'

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agA = createAgent(s.db, dan.id, 'dev-a')
  const agB = createAgent(s.db, dan.id, 'dev-b')
  const a = await makeWsClient(s.base, { token: agA.token, cursor: null })
  const b = await makeWsClient(s.base, { token: agB.token, cursor: null })
  await a.waitFor((f) => f.op === 'hello_ok')
  await b.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { a.close(); b.close() })
  // A owns the room.
  a.send({ op: 'convo_upsert', convo_id: 'room', title: 'room', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  return { s, dan, agA, agB, a, b }
}

const joinB = (s, agA, agB) => {
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
}

test('publish into a foreign convo is rejected; allowed after join; blocked again after leave', async (t) => {
  const { s, agA, agB, a, b } = await fleet(t)
  b.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'sneak' } })
  const err = await b.waitFor((f) => f.op === 'error' && f.ref === 'publish')
  assert.equal(err.code, 'forbidden')

  joinB(s, agA, agB)
  b.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'hello room' } })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'hello room')

  leaveConvo(s.db, { convoId: 'room', agentDeviceId: agB.deviceId })
  b.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'sneak2' } })
  const err2 = await b.waitFor((f) => f.op === 'error' && f.ref === 'publish' && f.code === 'forbidden')
  assert.ok(err2)
})

test('finalize, stream, stream_append, activity, status all reject a foreign convo', async (t) => {
  const { b } = await fleet(t)
  const cases = [
    { op: 'finalize', convo_id: 'room', message_ref: 'm1', type: 'text', payload: { body: 'x' } },
    { op: 'stream', convo_id: 'room', message_ref: 'm1', text: 'x' },
    { op: 'stream_append', convo_id: 'room', message_ref: 'm1', offset: 0, chunk: 'x', meta: { command: 'ls' } },
    { op: 'activity', convo_id: 'room', state: 'thinking' },
    { op: 'status', convo_id: 'room', status: { model: 'x' } },
  ]
  for (const msg of cases) {
    b.send(msg)
    const err = await b.waitFor((f) => f.op === 'error' && f.ref === msg.op)
    assert.equal(err.code, 'forbidden', `${msg.op} must be forbidden`)
  }
})

test('joined participant can finalize and stream ephemerals', async (t) => {
  const { s, agA, agB, a, b } = await fleet(t)
  joinB(s, agA, agB)
  b.send({ op: 'finalize', convo_id: 'room', message_ref: 'm1', type: 'text', payload: { body: 'done' } })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'done')
  // Ephemerals: no error frame back is the pass signal (delivery is
  // viewing-scoped, so nothing arrives anywhere — absence of `forbidden`
  // is what we assert).
  b.send({ op: 'activity', convo_id: 'room', state: 'thinking' })
  await settle()
  assert.deepEqual(b.frames.filter((f) => f.op === 'error' && f.ref === 'activity'), [])
})

test('legacy NULL-owner convo still accepts any agent write', async (t) => {
  const { s, dan, b } = await fleet(t)
  s.db.prepare(
    'INSERT INTO conversations(id, owner_user_id, title, session_state, created_at) VALUES(?,?,?,?,?)'
  ).run('legacy', dan.id, 'old', 'running', Date.now())
  b.send({ op: 'publish', convo_id: 'legacy', type: 'text', payload: { body: 'ok' } })
  await b.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'ok')
})

test('room-upsert gate: an uninvited stranger cannot upsert a room that has any participant history; ownership is unchanged; its publish stays forbidden', async (t) => {
  const { s, dan, agA, agB, a, b } = await fleet(t)
  // Give the room participant history via a THIRD device (never B), so this
  // test isolates the "any convo_agents row at all" predicate from B's own
  // membership state (that's the separate JOINED-guest test below).
  const agC = createAgent(s.db, dan.id, 'dev-c')
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })

  b.send({ op: 'convo_upsert', convo_id: 'room', title: 'stolen', session_state: 'idle' })
  const err = await b.waitFor((f) => f.op === 'error' && f.ref === 'convo_upsert')
  assert.equal(err.code, 'forbidden')

  const row = s.db.prepare('SELECT agent_device_id, title, session_state FROM conversations WHERE id=?').get('room')
  assert.equal(row.agent_device_id, agA.deviceId, 'ownership must not change')
  assert.equal(row.title, 'room', 'title must not change')
  assert.equal(row.session_state, 'running', 'session_state must not change')

  b.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'sneak' } })
  const err2 = await b.waitFor((f) => f.op === 'error' && f.ref === 'publish')
  assert.equal(err2.code, 'forbidden')
})

test("room-upsert gate: another user's agent probing a room id gets the generic forbidden, not the room-specific detail", async (t) => {
  const { s, dan, agA, agB } = await fleet(t)
  // Any participant row makes 'room' a room; agB is simply dan's other agent.
  // (This read a device NAME before — with the convo_agents cascade in place,
  // agent_device_id has to be a real device id.)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  const eve = await createUser(s.db, 'eve', 'pw')
  const agE = createAgent(s.db, eve.id, 'dev-e')
  const e = await makeWsClient(s.base, { token: agE.token, cursor: null })
  await e.waitFor((f) => f.op === 'hello_ok')
  t.after(() => e.close())

  // The room-specific detail must never cross the user boundary — it would
  // confirm to eve that dan's convo id exists and is a populated room. The
  // foreign upsert falls through to upsertConversation's generic rejection.
  e.send({ op: 'convo_upsert', convo_id: 'room', title: 'probe', session_state: 'idle' })
  const err = await e.waitFor((f) => f.op === 'error' && f.ref === 'convo_upsert')
  assert.equal(err.code, 'forbidden')
  assert.ok(!/room/.test(err.detail ?? ''), `detail must not leak room-ness, got: ${err.detail}`)

  const row = s.db.prepare('SELECT owner_user_id, agent_device_id, title FROM conversations WHERE id=?').get('room')
  assert.equal(row.owner_user_id, dan.id)
  assert.equal(row.agent_device_id, agA.deviceId)
  assert.equal(row.title, 'room')
})

test('room-upsert gate: a JOINED guest cannot upsert the room it joined either', async (t) => {
  const { s, agA, agB, a, b } = await fleet(t)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })

  b.send({ op: 'convo_upsert', convo_id: 'room', title: 'guest-set', session_state: 'idle' })
  const err = await b.waitFor((f) => f.op === 'error' && f.ref === 'convo_upsert')
  assert.equal(err.code, 'forbidden')

  const row = s.db.prepare('SELECT agent_device_id, title, session_state FROM conversations WHERE id=?').get('room')
  assert.equal(row.agent_device_id, agA.deviceId)
  assert.equal(row.title, 'room')
  assert.equal(row.session_state, 'running')
})

// A participant-less convo must still allow last-writer-wins takeover (a
// re-paired bridge with a new device id reclaiming its own sessions) — this
// is already covered end-to-end by agent-scoped-delivery.test.js's "a later
// convo_upsert by another device takes over delivery" (convo 'sess-move' has
// zero convo_agents rows throughout), so it is not duplicated here.

test('convo_upsert rejects a non-string or oversize summary', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agA = createAgent(s.db, dan.id, 'dev-a')
  const ag = await makeWsClient(s.base, { token: agA.token, cursor: null })
  await ag.waitFor((f) => f.op === 'hello_ok')
  t.after(() => ag.close())
  ag.send({ op: 'convo_upsert', convo_id: 'v1', session_state: 'running', summary: 42 })
  let err = await ag.waitFor((f) => f.op === 'error' && f.ref === 'convo_upsert')
  assert.equal(err.code, 'bad_request')
  ag.frames.length = 0
  ag.send({ op: 'convo_upsert', convo_id: 'v1', session_state: 'running', summary: 'x'.repeat(1001) })
  err = await ag.waitFor((f) => f.op === 'error' && f.ref === 'convo_upsert')
  assert.equal(err.code, 'bad_request')
})
