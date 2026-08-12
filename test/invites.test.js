import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { getParticipant, inviteParticipant, answerInvite, markDelivered } from '../src/participants.js'
import { handleOp } from '../src/ws.js'

// Task 1 removed the standing "always allow A -> B" fast path (isAllowed) —
// every agent_invite/agent_join now parks for the user's consent, every
// time, with no way to pre-approve a directed pair ahead of the ask (see
// src/participants.js, test/agent-chat-consent.test.js). This file's job is
// the relay CONTRACT once a park is actually answered — busy ack, refuse,
// accept — which behaves exactly as it did before consent-gating existed.
// So wherever a test needs to observe a relayed
// frame, it sends the ask, lets it park, and approves it for real via
// approvePark() below (the same HTTP route a client's approve tap uses) —
// never by seeding a bypass.
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
  a.send({ op: 'convo_upsert', convo_id: 'room', title: 'room', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  return { s, dan, agA, agB, clientToken, a, b }
}

// Approves a parked ask via the same HTTP route a client's approve tap
// takes. `participantDeviceId` is the row's key — the invitee for an
// agent_invite, or the joiner itself for an agent_join (a join self-targets;
// see ws.js's agent_join handler).
async function approvePark(s, clientToken, roomId, participantDeviceId) {
  const r = await s.http('/agent-chat/answer', {
    method: 'POST', token: clientToken,
    body: { room_id: roomId, target_device_id: participantDeviceId, decision: 'approve' },
  })
  assert.equal(r.status, 200, 'approving the park must succeed')
  return r.json
}

test('full invite happy path: request → delivered → ack → answer(accept) → joined', async (t) => {
  const { s, agB, clientToken, a, b } = await fleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, topic: 'ci', justification: 'need your logs' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered' && f.target_device_id === agB.deviceId)
  await approvePark(s, clientToken, 'room', agB.deviceId)

  const req = await b.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  assert.equal(req.room_id, 'room')
  assert.equal(req.from_name, 'dev-a')
  assert.equal(req.topic, 'ci')
  assert.equal(req.justification, 'need your logs')

  b.send({ op: 'agent_invite_ack', room_id: 'room', session_state: 'idle' })
  const ack = await a.waitFor((f) => f.kind === 'invite' && f.event === 'ack')
  assert.equal(ack.session_state, 'idle')
  assert.equal(ack.from_device_id, agB.deviceId)

  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: true })
  const ans = await a.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  assert.equal(ans.accept, true)
  assert.equal(ans.peer_device_id, agB.deviceId)
  assert.equal(ans.from_device_id, agB.deviceId, 'the answering device is stamped on the live relay')
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'joined')
})

test('refusal carries the reason back and blocks the room for the target', async (t) => {
  const { s, agB, clientToken, a, b } = await fleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'x' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered' && f.target_device_id === agB.deviceId)
  await approvePark(s, clientToken, 'room', agB.deviceId)
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: false, reason: 'mid-release, no' })
  const ans = await a.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  assert.equal(ans.accept, false)
  assert.equal(ans.reason, 'mid-release, no')
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'refused')
  // Refused device cannot write (ties into Task 3's gate).
  b.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'sneak' } })
  const err = await b.waitFor((f) => f.op === 'error' && f.ref === 'publish')
  assert.equal(err.code, 'forbidden')
})

test('join flow: peer asks, owner acks busy and accepts via peer_device_id', async (t) => {
  const { s, agA, agB, clientToken, a, b } = await fleet(t)
  b.send({ op: 'agent_join', room_id: 'room', justification: 'I have context on this bug' })
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'delivered' && f.target_device_id === agA.deviceId)
  await approvePark(s, clientToken, 'room', agB.deviceId)

  const jr = await a.waitFor((f) => f.kind === 'invite' && f.event === 'join_request')
  assert.equal(jr.from_device_id, agB.deviceId)
  assert.equal(jr.from_name, 'dev-b')

  a.send({ op: 'agent_invite_ack', room_id: 'room', session_state: 'busy', peer_device_id: agB.deviceId })
  const ack = await b.waitFor((f) => f.kind === 'invite' && f.event === 'ack')
  assert.equal(ack.session_state, 'busy')

  a.send({ op: 'agent_invite_answer', room_id: 'room', accept: true, peer_device_id: agB.deviceId })
  const ans = await b.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  assert.equal(ans.accept, true)
  // In the join-request direction, from_device_id is the OWNER (who actually
  // answered) — distinct from peer_device_id, which names the join-requester
  // the row is about. This is how the join-requester learns who answered.
  assert.equal(ans.from_device_id, agA.deviceId)
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'joined')
})

test('validation and authorization failures', async (t) => {
  const { s, dan, agA, agB, clientToken, a, b } = await fleet(t)
  const expectErr = async (w, msg, code) => {
    w.send(msg)
    const err = await w.waitFor((f) => f.op === 'error' && f.ref === msg.op)
    assert.equal(err.code, code, `${msg.op} -> ${code}`)
    // Drain so the next waitFor doesn't match this frame again.
    w.frames.length = 0
  }
  // Non-owner cannot invite into A's room.
  await expectErr(b, { op: 'agent_invite', room_id: 'room', target_device_id: agA.deviceId, justification: 'x' }, 'forbidden')
  // Owner cannot invite itself.
  await expectErr(a, { op: 'agent_invite', room_id: 'room', target_device_id: agA.deviceId, justification: 'x' }, 'bad_request')
  // Missing justification.
  await expectErr(a, { op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId }, 'bad_request')
  // Unknown room.
  await expectErr(a, { op: 'agent_invite', room_id: 'nope', target_device_id: agB.deviceId, justification: 'x' }, 'not_found')
  // Target that is a client device is indistinguishable from missing.
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const clientDeviceId = s.db.prepare("SELECT id FROM devices WHERE kind='client' ORDER BY id DESC LIMIT 1").get().id
  await expectErr(a, { op: 'agent_invite', room_id: 'room', target_device_id: clientDeviceId, justification: 'x' }, 'not_found')
  // Double-invite: first parks, second conflicts — a pending park is not
  // renewable (see parkInvite's RENEWABLE set in participants.js), so this
  // needs no approval step to observe.
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'x' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered' && f.target_device_id === agB.deviceId)
  await expectErr(a, { op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'x' }, 'conflict')
  // Answer without a pending invite (already answered): approve the park for
  // real first, so the row is actually 'invited' and answerable.
  await approvePark(s, clientToken, 'room', agB.deviceId)
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: true })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  await expectErr(b, { op: 'agent_invite_answer', room_id: 'room', accept: true }, 'conflict')
  // Owner joining its own room is a bad_request.
  await expectErr(a, { op: 'agent_join', room_id: 'room', justification: 'x' }, 'bad_request')
  // Client connections may not use invite ops at all.
  const c = await makeWsClient(s.base, { token: login.json.token, cursor: null })
  await c.waitFor((f) => f.op === 'hello_ok')
  t.after(() => c.close())
  await expectErr(c, { op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'x' }, 'forbidden')
})

test('inviting a device that has never connected still parks; approving it leaves an undelivered row, not an error', async (t) => {
  const { s, dan, agA, clientToken, a } = await fleet(t)
  const ghost = createAgent(s.db, dan.id, 'dev-ghost') // never connects
  // Task 1 removed the standing-allowance fast path that used to attempt
  // immediate delivery on the FIRST ask and fail synchronously with
  // 'offline' (undoing the row). Every first ask parks now, regardless of
  // the target's liveness — even a device that has never once connected
  // gets the same park, not a liveness check up front.
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: ghost.deviceId, justification: 'x' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered' && f.target_device_id === ghost.deviceId)
  assert.equal(getParticipant(s.db, 'room', ghost.deviceId).state, 'awaiting_user')

  // Approving it attempts delivery for real and finds nobody home — the row
  // stays 'invited', undelivered, not undone (see invite-delivery.js's pump
  // and the matching HTTP contract pinned in test/agent-chat-consent.test.js:
  // "POST /agent-chat/answer approve, target offline").
  const r = await s.http('/agent-chat/answer', {
    method: 'POST', token: clientToken,
    body: { room_id: 'room', target_device_id: ghost.deviceId, decision: 'approve' },
  })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, delivered: false })
  const row = getParticipant(s.db, 'room', ghost.deviceId)
  assert.equal(row.state, 'invited')
  assert.equal(row.delivered_at, null)
})

test('agent_leave flips joined to left and notifies the owner', async (t) => {
  const { s, agA, agB, a, b } = await fleet(t)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  b.send({ op: 'agent_leave', room_id: 'room' })
  const left = await a.waitFor((f) => f.kind === 'invite' && f.event === 'left')
  assert.equal(left.from_device_id, agB.deviceId)
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'left')
  // Leaving twice conflicts.
  b.send({ op: 'agent_leave', room_id: 'room' })
  const err = await b.waitFor((f) => f.op === 'error' && f.ref === 'agent_leave')
  assert.equal(err.code, 'conflict')
})

test('owner leave dissolves the room: joined peers are told, pending invites die', async (t) => {
  const { s, dan, agA, agB, a, b } = await fleet(t)
  const agC = createAgent(s.db, dan.id, 'dev-c')
  const c = await makeWsClient(s.base, { token: agC.token, cursor: null })
  await c.waitFor((f) => f.op === 'hello_ok')
  t.after(() => c.close())
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  // C stays merely invited.

  a.send({ op: 'agent_leave', room_id: 'room' })
  const left = await b.waitFor((f) => f.kind === 'invite' && f.event === 'left')
  assert.equal(left.room_id, 'room')
  assert.equal(left.from_device_id, agA.deviceId)
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'left')
  // The pending invite dies with the room — but its device was never joined,
  // so it gets no 'left' frame; its next answer attempt tells the story.
  assert.equal(getParticipant(s.db, 'room', agC.deviceId).state, 'left')
  c.send({ op: 'agent_invite_answer', room_id: 'room', accept: true })
  const err = await c.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite_answer')
  assert.equal(err.code, 'conflict')
  assert.ok(!c.frames.some((f) => f.kind === 'invite'), 'a pending invitee the OWNER invited is not notified at all')

  // Repeated owner-leave is a silent success (no-error-means-success), not a
  // conflict. Proven with a barrier: a deliberately-failing leave on an
  // unknown room — per-connection FIFO means its not_found arriving proves
  // the repeat before it produced no error frame.
  a.frames.length = 0
  a.send({ op: 'agent_leave', room_id: 'room' })
  a.send({ op: 'agent_leave', room_id: 'nope' })
  const barrier = await a.waitFor((f) => f.op === 'error' && f.ref === 'agent_leave')
  assert.equal(barrier.code, 'not_found')
  assert.equal(barrier.room_id, 'nope')
  assert.ok(!a.frames.some((f) => f.op === 'error' && f.room_id === 'room'), 'repeated owner-leave must be silent')
})

test('owner leave answers a pending JOIN REQUEST instead of orphaning the requester', async (t) => {
  // The join-requester is its own row's initiator, so it never sends an
  // agent_invite_answer and has nothing to conflict against; the dissolve
  // flips its row invited -> left, which also puts it out of reach of the
  // expiry sweep (predicate: state='invited'). Without an answer here the
  // requesting bridge waits forever with no server-side recovery.
  const { s, agB, clientToken, a, b } = await fleet(t)
  b.send({ op: 'agent_join', room_id: 'room', justification: 'I have context on this bug' })
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await approvePark(s, clientToken, 'room', agB.deviceId)
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'join_request')

  a.send({ op: 'agent_leave', room_id: 'room' })
  const ans = await b.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  assert.equal(ans.room_id, 'room')
  assert.equal(ans.accept, false)
  assert.equal(ans.reason, 'left')
  assert.equal(ans.peer_device_id, agB.deviceId)
  // Same synthetic shape as the expiry sweep's answer (no answering
  // connection behind it, so no from_device_id) — the initiator's existing
  // expiry handling fires unchanged, only the reason differs.
  assert.equal(ans.from_device_id, undefined)
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'left')
})

test('owner leave also dissolves a PARKED (awaiting_user) join request: initiator gets the answer frame, the row goes terminal, and a stale answer 409s', async (t) => {
  // Bugbot finding: leaveAllParticipants only swept 'invited'/'joined' rows,
  // so a row parked for the user's consent (never delivered to any agent
  // socket) survived a dissolved room — the card stayed live for a dead
  // room and the requester waited out the full 24h park TTL instead of
  // hearing the same synthetic 'left' answer an 'invited' row gets.
  const { s, dan, agA, agB, clientToken, a, b } = await fleet(t)
  const agC = createAgent(s.db, dan.id, 'dev-c')
  const c = await makeWsClient(s.base, { token: agC.token, cursor: null })
  await c.waitFor((f) => f.op === 'hello_ok')
  t.after(() => c.close())

  // B: approve the park for real (Task 1 removed the standing-allowance
  // fast path fleet() used to pre-seed) — lands 'invited', delivered to the
  // owner. Same shape as the test above.
  b.send({ op: 'agent_join', room_id: 'room', justification: 'I have context on this bug' })
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await approvePark(s, clientToken, 'room', agB.deviceId)
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'join_request')

  // C: no approval, so the join request stays parked for the user's consent
  // instead of ever reaching A's socket.
  c.send({ op: 'agent_join', room_id: 'room', justification: 'let me help too' })
  await c.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  assert.equal(getParticipant(s.db, 'room', agC.deviceId).state, 'awaiting_user')

  a.send({ op: 'agent_leave', room_id: 'room' })

  const ansB = await b.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  assert.equal(ansB.accept, false)
  assert.equal(ansB.reason, 'left')
  assert.equal(ansB.peer_device_id, agB.deviceId)

  const ansC = await c.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  assert.equal(ansC.accept, false)
  assert.equal(ansC.reason, 'left')
  assert.equal(ansC.peer_device_id, agC.deviceId)

  assert.equal(getParticipant(s.db, 'room', agC.deviceId).state, 'left',
    'the parked row must go terminal, not stay stuck awaiting_user until the 24h TTL')

  // The now-dead card must not be answerable — a client trying to approve
  // it hits the same 409 an already-answered row gets.
  const answerAttempt = await s.http('/agent-chat/answer', {
    method: 'POST', token: clientToken,
    body: { room_id: 'room', target_device_id: agC.deviceId, decision: 'approve' },
  })
  assert.equal(answerAttempt.status, 409)
  assert.deepEqual(answerAttempt.json, { error: 'conflict' })
})

test('a throwing notify neither undoes a committed dissolve nor strands the remaining peers', async (t) => {
  // The DB flip is committed before any frame goes out, so a send that
  // throws (a socket that died between the hub's lookup and the write) must
  // not surface as {code:'internal'}: the caller would retry a leave that
  // already happened, the retry would no-op, and everyone after the throw
  // would never be told. Unit-level with a deliberately broken hub — a real
  // socket can't be made to throw on cue.
  const { s, dan, agA, agB } = await fleet(t)
  const agC = createAgent(s.db, dan.id, 'dev-c')
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  // C is a pending join request — notified after B, so B's throw is what
  // would swallow C's answer.
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, initiatorDeviceId: agC.deviceId, justification: 'x' })

  const mute = t.mock.method(console, 'error', () => {}) // the guard is expected to log; keep test output clean
  const seen = []
  const brokenHub = {
    sendToDevice: (userId, deviceId, frame) => {
      if (deviceId === agB.deviceId) throw new Error('socket died between lookup and write')
      seen.push({ deviceId, frame })
    },
  }
  const frames = []
  const owner = {
    ws: { send: (str) => frames.push(JSON.parse(str)) },
    userId: dan.id, deviceId: agA.deviceId, kind: 'agent', name: 'dev-a', registered: true,
  }
  handleOp({ db: s.db, hub: brokenHub, conn: owner, msg: { op: 'agent_leave', room_id: 'room' } })

  assert.deepEqual(frames, [], 'a committed leave stays a silent success, not an internal error')
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'left')
  assert.equal(getParticipant(s.db, 'room', agC.deviceId).state, 'left')
  assert.equal(seen.length, 1, 'the peer after the throwing one is still notified')
  assert.equal(seen[0].deviceId, agC.deviceId)
  assert.equal(seen[0].frame.reason, 'left')
  assert.ok(mute.mock.callCount() >= 1, 'the swallowed send failure is logged server-side')
})

test('owner leave: a participant-less convo conflicts, a dissolved room stays silently idempotent', async (t) => {
  const { s, agA, agB, a, b } = await fleet(t)
  // convo_upsert stamps agent_device_id on EVERY agent-created conversation,
  // so "the caller is the recorded owner" alone would drag a plain solo
  // convo into the dissolve branch. A convo nobody was ever drawn into is
  // not a room: leaving it conflicts, exactly as it did before owner-leave
  // existed. Exactly one error frame — the guard must not be entangled with
  // the room_id echo, so assert the count as well as the contents.
  a.send({ op: 'agent_leave', room_id: 'room' })
  const err = await a.waitFor((f) => f.op === 'error' && f.ref === 'agent_leave')
  assert.equal(err.code, 'conflict')
  assert.equal(err.detail, 'not a joined participant')
  assert.equal(err.room_id, 'room')
  assert.equal(a.frames.filter((f) => f.op === 'error' && f.ref === 'agent_leave').length, 1)
  a.frames.length = 0

  // Make it a real room, then dissolve it. Now every row is 'left' — but
  // the rows still exist, so a repeat owner-leave stays in the dissolve
  // branch and is a silent success, not a conflict. Proven with a barrier:
  // a deliberately-failing leave on an unknown room — per-connection FIFO
  // means its not_found arriving proves the repeat produced no error frame.
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  a.send({ op: 'agent_leave', room_id: 'room' })
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'left')

  a.send({ op: 'agent_leave', room_id: 'room' })
  a.send({ op: 'agent_leave', room_id: 'nope' })
  const barrier = await a.waitFor((f) => f.op === 'error' && f.ref === 'agent_leave')
  assert.equal(barrier.code, 'not_found')
  assert.equal(barrier.room_id, 'nope')
  assert.equal(a.frames.filter((f) => f.op === 'error' && f.ref === 'agent_leave').length, 1, 'only the barrier errored')
})

test('agent_invite_ack/agent_invite_answer/agent_leave reject an unregistered agent connection', async (t) => {
  // hello_ok flips conn.registered=true only after the auth+replay dance
  // completes; mid-replay this socket is invisible to hub scans, same
  // reasoning as agent_invite/agent_join's existing gate (see loadRoom's
  // comment). Simulate that pre-registration window directly via handleOp,
  // since a real ws.hello() races the registration flag closed too fast to
  // observe from a public-interface test.
  const { s, dan, agA, agB } = await fleet(t)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  const frames = []
  const unregistered = {
    ws: { send: (str) => frames.push(JSON.parse(str)) },
    userId: dan.id, deviceId: agB.deviceId, kind: 'agent', name: 'dev-b', registered: false,
  }
  for (const msg of [
    { op: 'agent_invite_ack', room_id: 'room', session_state: 'idle' },
    { op: 'agent_invite_answer', room_id: 'room', accept: true },
    { op: 'agent_leave', room_id: 'room' },
  ]) {
    frames.length = 0
    handleOp({ db: s.db, hub: s.hub, conn: unregistered, msg })
    assert.equal(frames.length, 1, `${msg.op} should reply with exactly one frame`)
    assert.equal(frames[0].code, 'not_ready', `${msg.op} -> not_ready`)
  }
  // The gate short-circuits before any state mutation: the invite is still
  // pending, untouched by the rejected ack/answer/leave attempts above.
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'invited')
})

test('a retried join after a refusal renews the row: parks again with the new justification, prior initiator replaced', async (t) => {
  const { s, agA, agB, clientToken, a, b } = await fleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'first ask' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered' && f.target_device_id === agB.deviceId)
  await approvePark(s, clientToken, 'room', agB.deviceId)
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: false, reason: 'not now' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  const refused = getParticipant(s.db, 'room', agB.deviceId)
  assert.equal(refused.state, 'refused')
  assert.equal(refused.justification, 'first ask')

  // A retried join after a refusal is RENEWABLE (see participants.js's
  // RENEWABLE set) — it parks again for the user's consent, same as any
  // first ask, regardless of the owner's connectivity. (Pre-Task-1, an
  // ALLOWED pair's retry attempted immediate delivery and — if the owner
  // happened to be offline — restored the prior refused row rather than
  // leaving a dangling one; that undo path, `undoInvite`, is still
  // unit-tested directly in test/participants.test.js, but has no
  // production caller left now that every ask parks: parking never attempts
  // delivery, so it never fails and never needs to undo anything.)
  b.send({ op: 'agent_join', room_id: 'room', justification: 'let me back in' })
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'delivered' && f.target_device_id === agA.deviceId)
  const renewed = getParticipant(s.db, 'room', agB.deviceId)
  assert.equal(renewed.state, 'awaiting_user')
  assert.equal(renewed.justification, 'let me back in')
  assert.equal(renewed.initiator_device_id, agB.deviceId, 'a join self-initiates, replacing the owner-initiated invite row')
})

test('room-op error frames carry room_id for correlation', async (t) => {
  const { agA, agB, a, b } = await fleet(t)
  const expectErr = async (w, msg, code) => {
    w.send(msg)
    const err = await w.waitFor((f) => f.op === 'error' && f.ref === msg.op)
    w.frames.length = 0
    assert.equal(err.code, code, `${msg.op} -> ${code}`)
    return err
  }
  // Non-owner invite (forbidden).
  let err = await expectErr(b, { op: 'agent_invite', room_id: 'room', target_device_id: agA.deviceId, justification: 'x' }, 'forbidden')
  assert.equal(err.room_id, 'room')
  // Unknown room (not_found) — the id is well-formed, so it still echoes.
  err = await expectErr(b, { op: 'agent_join', room_id: 'nope', justification: 'x' }, 'not_found')
  assert.equal(err.room_id, 'nope')
  // Double-invite (conflict) — a pending park already conflicts, no
  // approval needed to observe it.
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'x' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered' && f.target_device_id === agB.deviceId)
  err = await expectErr(a, { op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'x' }, 'conflict')
  assert.equal(err.room_id, 'room')
})

test('even the internal-error backstop carries room_id on a room op', async (t) => {
  const { s, a } = await fleet(t)
  // Fault injection, same brutal-but-honest trick as the HTTP 500 test:
  // agent_leave's is-this-a-room check reads convo_agents, so dropping the
  // table makes handleOp throw something genuinely unexpected — which is
  // exactly what the outermost backstop exists for. An 'internal' is the
  // error a bridge can least afford to leave uncorrelated, so that frame
  // must echo the room id just like fail()'s do.
  s.db.exec('DROP TABLE convo_agents')
  a.send({ op: 'agent_leave', room_id: 'room' })
  const err = await a.waitFor((f) => f.op === 'error' && f.ref === 'agent_leave')
  assert.equal(err.code, 'internal')
  assert.equal(err.room_id, 'room')
})

test('an invalid room_id is never echoed on an error frame, and non-room ops carry none', async (t) => {
  const { a } = await fleet(t)
  const expectErr = async (msg, code) => {
    a.send(msg)
    const err = await a.waitFor((f) => f.op === 'error' && f.ref === msg.op)
    a.frames.length = 0
    assert.equal(err.code, code, `${msg.op} -> ${code}`)
    return err
  }
  // Non-string and oversized ids are raw inbound input — omitted.
  let err = await expectErr({ op: 'agent_leave', room_id: 42 }, 'bad_request')
  assert.equal(err.room_id, undefined)
  err = await expectErr({ op: 'agent_leave', room_id: 'x'.repeat(129) }, 'bad_request')
  assert.equal(err.room_id, undefined)
  // A non-room op's error is unchanged even when the frame smuggles a room_id.
  err = await expectErr({ op: 'ack', cursor: -1, room_id: 'room' }, 'bad_request')
  assert.equal(err.room_id, undefined)
})

test('an unanswered invite expires and the initiator is told', async (t) => {
  const s = await startTestServer({ revocationSweepMs: 100, inviteTtlMs: 150 })
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
  a.send({ op: 'convo_upsert', convo_id: 'room', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'x' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered' && f.target_device_id === agB.deviceId)
  // Task 1 removed the standing-allowance fast path: reach the same
  // delivered/invited starting point through the real consent route
  // instead of pre-seeding a bypass — send, park, approve.
  await approvePark(s, clientToken, 'room', agB.deviceId)
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  // New contract: the 30-minute (here, 150ms) answer clock starts at
  // delivered_at, not created_at (Task 4). The approve step above already
  // stamps delivery (deliverPendingInvites -> markDelivered) — this
  // redundant direct stamp only guards against a future path that stops
  // doing so on its own; markDelivered's delivered_at-IS-NULL guard makes it
  // a harmless no-op here.
  markDelivered(s.db, { convoId: 'room', agentDeviceId: agB.deviceId })
  // B never answers; the sweep expires it.
  const ans = await a.waitFor((f) => f.kind === 'invite' && f.event === 'answer', 3000)
  assert.equal(ans.accept, false)
  assert.equal(ans.reason, 'expired')
  assert.equal(ans.peer_device_id, agB.deviceId)
  // Unlike the live agent_invite_answer relay, the sweep's synthetic expiry
  // answer has no answering connection behind it, so it carries no
  // from_device_id (documented difference — see docs/protocol.md).
  assert.equal(ans.from_device_id, undefined)
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'expired')
  // A late answer from B is a clean conflict, not a resurrection.
  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: true })
  const err = await b.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite_answer')
  assert.equal(err.code, 'conflict')
})
