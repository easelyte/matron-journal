import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { getParticipant, parkInvite, answerParkedInvite } from '../src/participants.js'
import { deliverPendingInvites } from '../src/invite-delivery.js'

// `target_convo_id` on agent_invite (spec: agent chat phase 3.5).
//
// The bug this closes: an agent picks a CONVERSATION off /roster, but the
// invite only ever carried that conversation's owning DEVICE. A bridge
// running several sessions therefore could not tell which one the ask was
// for, guessed at its most recently active session, and delivered a
// stranger's chat request — and every later message in that room — into an
// unrelated conversation of the user's.
//
// Two halves are tested here: the journal RELAYS the target, and the journal
// REFUSES to relay one the requester has no business naming.

// Two agent devices under one user, each owning a conversation of its own.
// Tests that need to observe a relayed request frame approve the park for
// real via approvePark() below (the same HTTP route a client's approve tap
// uses) — Task 1 removed the standing-allowance fast path this fleet() used
// to pre-seed for immediate relay.
async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agA = createAgent(s.db, dan.id, 'dev-a')
  const agB = createAgent(s.db, dan.id, 'dev-b')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const clientToken = login.json.token
  const a = await makeWsClient(s.base, { token: agA.token, cursor: null })
  const b = await makeWsClient(s.base, { token: agB.token, cursor: null })
  await a.waitFor((f) => f.op === 'hello_ok')
  await b.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { a.close(); b.close() })
  // 'room' is the chat room A is creating; 'b-work' is one of B's own
  // conversations — the thing an invite is actually addressed to.
  a.send({ op: 'convo_upsert', convo_id: 'room', title: 'room', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  b.send({ op: 'convo_upsert', convo_id: 'b-work', title: 'B at work', session_state: 'running' })
  await b.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  return { s, dan, agA, agB, clientToken, a, b }
}

// Approves a parked ask via the same HTTP route a client's approve tap
// takes — the only way left to reach a relayed request frame now that every
// ask parks (Task 1 removed the standing-allowance bypass).
async function approvePark(s, clientToken, roomId, participantDeviceId) {
  const r = await s.http('/agent-chat/answer', {
    method: 'POST', token: clientToken,
    body: { room_id: roomId, target_device_id: participantDeviceId, decision: 'approve' },
  })
  assert.equal(r.status, 200, 'approving the park must succeed')
  return r.json
}

test('a valid target_convo_id rides along to the target on the relay path', async (t) => {
  const { s, agB, clientToken, a, b } = await fleet(t)
  a.send({
    op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId,
    target_convo_id: 'b-work', justification: 'need your logs',
  })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered' && f.target_device_id === agB.deviceId)
  await approvePark(s, clientToken, 'room', agB.deviceId)
  const req = await b.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  assert.equal(req.target_convo_id, 'b-work',
    'without this the receiving bridge has nothing to aim at but a guess')
})

test('an invite with no target_convo_id omits the field entirely', async (t) => {
  const { s, agB, clientToken, a, b } = await fleet(t)
  // A pre-3.5 bridge sends none. The field must be ABSENT, not null: the
  // receiver distinguishes "not addressed" (fall back, suppress the user's
  // copy) from "addressed", and a null would read as the latter.
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'x' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered' && f.target_device_id === agB.deviceId)
  await approvePark(s, clientToken, 'room', agB.deviceId)
  const req = await b.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  assert.ok(!('target_convo_id' in req), 'absent, not null')
})

test('naming a conversation the target device does not own is refused', async (t) => {
  const { agB, a } = await fleet(t)
  // 'room' belongs to A, not B. Allowing this would let a requester point
  // the receiving bridge at any conversation it can see in the roster —
  // which is precisely the cross-chat write the whole feature must not have.
  a.send({
    op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId,
    target_convo_id: 'room', justification: 'x',
  })
  const err = await a.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.ref === 'agent_invite')
  assert.equal(err.code, 'not_found')
})

test('naming an unknown conversation is refused, indistinguishably', async (t) => {
  const { agB, a } = await fleet(t)
  a.send({
    op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId,
    target_convo_id: 'no-such-convo', justification: 'x',
  })
  const err = await a.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.ref === 'agent_invite')
  assert.equal(err.code, 'not_found',
    'same code as the wrong-owner case — a distinct error would confirm which ids exist')
})

test('naming a sub-chat is refused', async (t) => {
  const { agB, a, b } = await fleet(t)
  b.send({
    op: 'convo_upsert', convo_id: 'b-sub', title: 'sub', session_state: 'running',
    parent_convo_id: 'b-work',
  })
  await b.waitFor((f) => f.kind === 'journal' && f.type === 'session_status' && f.convo_id === 'b-sub')
  // Sub-chats are silenced children, never chat targets — the roster omits
  // them for exactly this reason.
  a.send({
    op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId,
    target_convo_id: 'b-sub', justification: 'x',
  })
  const err = await a.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.ref === 'agent_invite')
  assert.equal(err.code, 'not_found')
})

test('a non-string target_convo_id is rejected before any side effect', async (t) => {
  const { s, agB, a } = await fleet(t)
  a.send({
    op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId,
    target_convo_id: 42, justification: 'x',
  })
  const err = await a.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.ref === 'agent_invite')
  assert.equal(err.code, 'bad_request')
  assert.equal(getParticipant(s.db, 'room', agB.deviceId), null,
    'a rejected invite must not leave a participant row behind')
})

test('the target survives a park for consent and reaches the frame on approval', async (t) => {
  const { s, dan, agA, agB } = await fleet(t)
  // The consent path stores the row now and delivers much later — the target
  // has to be persisted, not just relayed, or an approved invite arrives
  // unaddressed and the receiver is back to guessing.
  parkInvite(s.db, {
    convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId,
    justification: 'need logs', topic: 'ci', targetConvoId: 'b-work',
  })
  assert.ok(answerParkedInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, approve: true }))
  const calls = []
  const hub = { calls, sendRpcRequest: (u, d, f) => { calls.push([u, d, f]); return true } }
  assert.equal(deliverPendingInvites(s.db, hub, { deviceId: agB.deviceId }), 1)
  assert.equal(calls.length, 1)
  const [userId, deviceId, frame] = calls[0]
  assert.equal(userId, dan.id)
  assert.equal(deviceId, agB.deviceId)
  assert.equal(frame.target_convo_id, 'b-work')
})

test('a parked invite with no target delivers without the field', async (t) => {
  const { s, agA, agB } = await fleet(t)
  parkInvite(s.db, {
    convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x',
  })
  answerParkedInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, approve: true })
  const calls = []
  const hub = { calls, sendRpcRequest: (u, d, f) => { calls.push([u, d, f]); return true } }
  deliverPendingInvites(s.db, hub, { deviceId: agB.deviceId })
  assert.ok(!('target_convo_id' in calls[0][2]), 'absent, not null')
})
