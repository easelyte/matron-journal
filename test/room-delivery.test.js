import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { inviteParticipant, answerInvite } from '../src/participants.js'

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agA = createAgent(s.db, dan.id, 'dev-a')
  const agB = createAgent(s.db, dan.id, 'dev-b')
  const agC = createAgent(s.db, dan.id, 'dev-c')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const a = await makeWsClient(s.base, { token: agA.token, cursor: null })
  const b = await makeWsClient(s.base, { token: agB.token, cursor: null })
  const c = await makeWsClient(s.base, { token: agC.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  for (const w of [a, b, c, client]) await w.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { a.close(); b.close(); c.close(); client.close() })
  a.send({ op: 'convo_upsert', convo_id: 'room', title: 'room', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  return { s, dan, agA, agB, agC, a, b, c, client, clientDeviceId: login.json.device_id }
}

test('live frames fan to owner + joined participants, not to invited/stranger agents', async (t) => {
  const { s, agA, agB, agC, a, b, c, client } = await fleet(t)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  // C stays merely invited.

  client.send({ op: 'send', convo_id: 'room', payload: { body: 'hi both' } })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'hi both')
  await b.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'hi both')
  await settle()
  assert.deepEqual(c.journal().filter((f) => f.convo_id === 'room'), [], 'invited-but-not-joined receives nothing')
})

test("a joined participant's own publish reaches the owner and the client", async (t) => {
  const { s, agA, agB, a, b, client } = await fleet(t)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  b.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'from b' } })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'from b')
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'from b')
})

test('live frames carry sender_device_id; replayed frames do not', async (t) => {
  const { s, agA, agB, a, b, client, clientDeviceId } = await fleet(t)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })

  // A room message fanned out live names the publishing device exactly —
  // device names are not unique, so this is the only reliable own-echo test
  // a bridge has.
  b.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'from b' } })
  const toOwner = await a.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'from b')
  assert.equal(toOwner.sender_device_id, agB.deviceId)
  const echo = await b.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'from b')
  assert.equal(echo.sender_device_id, agB.deviceId, "the publisher's own echo carries its own device id")

  // A client send carries the client's device id.
  client.send({ op: 'send', convo_id: 'room', payload: { body: 'from mac' } })
  const sent = await a.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'from mac')
  assert.equal(sent.sender_device_id, clientDeviceId)

  // Replay is the documented asymmetry: eventsAfter frames carry no
  // sender_device_id (it is never stored), so consumers fall back to
  // sender-name matching for history.
  const b2 = await makeWsClient(s.base, { token: agB.token, cursor: 0 })
  const replayed = await b2.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'from b')
  assert.equal(replayed.sender_device_id, undefined)
  b2.close()
})

test('hello replay delivers room history to joined participants and skips strangers', async (t) => {
  const { s, agA, agB, agC, a, client } = await fleet(t)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  client.send({ op: 'send', convo_id: 'room', payload: { body: 'history' } })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'text')

  // Reconnect B from cursor 0 — replay must include the room history.
  const b2 = await makeWsClient(s.base, { token: agB.token, cursor: 0 })
  await b2.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'history')
  b2.close()

  const c2 = await makeWsClient(s.base, { token: agC.token, cursor: 0 })
  await c2.waitFor((f) => f.op === 'hello_ok')
  await settle()
  assert.deepEqual(c2.journal().filter((f) => f.convo_id === 'room'), [])
  c2.close()
})
