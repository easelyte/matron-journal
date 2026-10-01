import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { inviteParticipant, answerInvite, answerParkedInvite, recordJoined, leaveConvo, leaveAllParticipants, getParticipant, participantConvoIds } from '../src/participants.js'
import { createSpawnRequest, claimApprove, markStarted } from '../src/spawns.js'
import { snapshot } from '../src/journal.js'

// Room membership on the wire (spec: multi-agent room tags). Clients render
// a box chip per participating machine, so the journal must say WHO is in a
// room: snapshot rows carry `participants` (recorded owner + joined
// convo_agents device ids), and every membership change fans a convo_meta
// with the updated array so live clients re-chip without a /snapshot.

async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agA = createAgent(s.db, dan.id, 'dev-a')
  const agB = createAgent(s.db, dan.id, 'dev-b')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const a = await makeWsClient(s.base, { token: agA.token, cursor: null })
  const b = await makeWsClient(s.base, { token: agB.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  for (const w of [a, b, client]) await w.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { a.close(); b.close(); client.close() })
  a.send({ op: 'convo_upsert', convo_id: 'room', title: 'room', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  return { s, dan, agA, agB, a, b, client }
}

test('snapshot: rooms carry participants (owner + joined), plain convos omit the key', async (t) => {
  const { s, dan, agA, agB, a } = await fleet(t)
  a.send({ op: 'convo_upsert', convo_id: 'solo', title: 'solo', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.convo_id === 'solo')
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })

  // Merely invited is not membership: the room carries only its owner (a
  // room row always carries the key, so a client never keeps a stale set).
  let rows = Object.fromEntries(snapshot(s.db, dan.id).conversations.map((c) => [c.id, c]))
  assert.deepEqual(rows.room.participants, [agA.deviceId], 'an invited-but-unanswered room is not yet multi-agent')

  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  rows = Object.fromEntries(snapshot(s.db, dan.id).conversations.map((c) => [c.id, c]))
  assert.deepEqual(rows.room.participants, [agA.deviceId, agB.deviceId].sort((x, y) => x - y))
  assert.equal(rows.solo.participants, undefined, 'a solo convo never grows the key')
})

test('accepting an invite over the socket fans convo_meta with the new participant set', async (t) => {
  const { s, agA, agB, b, client } = await fleet(t)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: true })
  const meta = await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta'
    && f.convo_id === 'room' && Array.isArray(f.payload.participants))
  assert.deepEqual(meta.payload.participants, [agA.deviceId, agB.deviceId].sort((x, y) => x - y))
})

test('a refusal fans nothing — membership did not change', async (t) => {
  const { s, agA, agB, b, client } = await fleet(t)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: false })
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(
    client.frames.filter((f) => f.kind === 'journal' && f.type === 'convo_meta' && f.payload.participants),
    [],
  )
})

test('guest leave and owner dissolve both fan the shrunken set', async (t) => {
  const { s, agA, agB, a, b, client } = await fleet(t)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: true })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta' && Array.isArray(f.payload.participants))

  b.send({ op: 'agent_leave', room_id: 'room' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta'
    && Array.isArray(f.payload.participants) && f.payload.participants.length === 1)

  // Re-join (leaveConvo's 'left' is renewable), then the OWNER leaves —
  // dissolution must fan the same shrunken shape.
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: true })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta'
    && Array.isArray(f.payload.participants) && f.payload.participants.length === 2
    && client.frames.filter((g) => g.type === 'convo_meta' && g.payload.participants?.length === 2).length === 2)
  a.send({ op: 'agent_leave', room_id: 'room' })
  const metas = () => client.frames.filter((f) => f.kind === 'journal' && f.type === 'convo_meta'
    && Array.isArray(f.payload.participants) && f.payload.participants.length === 1)
  await client.waitFor(() => metas().length === 2)
  assert.deepEqual(metas().at(-1).payload.participants, [agA.deviceId])
})

test('snapshot with excludePrivateOwned filters private device ids from participants', async (t) => {
  const { s, dan, agA, agB } = await fleet(t)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  s.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(agB.deviceId)
  const rows = Object.fromEntries(
    snapshot(s.db, dan.id, { excludePrivateOwned: true }).conversations.map((c) => [c.id, c]),
  )
  // With its only joined participant sieved out, the room reads as a plain
  // solo convo to the filtered caller — no key at all, so neither the
  // private box's id nor the fact of a hidden member leaks. The unfiltered
  // client snapshot still carries both ids.
  assert.equal(rows.room.participants, undefined,
    'a private participant must not leak through the filtered snapshot')
  const unfiltered = Object.fromEntries(snapshot(s.db, dan.id).conversations.map((c) => [c.id, c]))
  assert.deepEqual(unfiltered.room.participants, [agA.deviceId, agB.deviceId].sort((x, y) => x - y))
})

// participant_convos (spec: 2026-10-01 rooms under missions): alongside the
// devices, the room's participant CONVERSATIONS, so a client can show a room
// under its participants' missions.

const rowsOf = (snap) => Object.fromEntries(snap.conversations.map((c) => [c.id, c]))

// Each agent's own top-level session, as a bridge would have published it.
async function sessions(a, b) {
  a.send({ op: 'convo_upsert', convo_id: 'a-sess', title: 'a session', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.convo_id === 'a-sess')
  b.send({ op: 'convo_upsert', convo_id: 'b-sess', title: 'b session', session_state: 'running' })
  await b.waitFor((f) => f.kind === 'journal' && f.convo_id === 'b-sess')
}

test('participant_convos: an accepted invite room yields both sessions; the fan carries them', async (t) => {
  const { s, dan, agB, a, b, client } = await fleet(t)
  await sessions(a, b)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, target_convo_id: 'b-sess', from_convo_id: 'a-sess', justification: 'help' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  assert.ok(answerParkedInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, approve: true }))
  // Invited is not membership: nobody's session yet, but the room carries the key.
  assert.deepEqual(rowsOf(snapshot(s.db, dan.id)).room.participant_convos, [])

  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: true })
  const meta = await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta'
    && f.convo_id === 'room' && Array.isArray(f.payload.participants))
  assert.deepEqual(meta.payload.participant_convos, ['a-sess', 'b-sess'], 'owner session leads, then the invited one')
  assert.deepEqual(rowsOf(snapshot(s.db, dan.id)).room.participant_convos, ['a-sess', 'b-sess'])
})

test('participant_convos: a participant who left drops out (snapshot and the leave fan)', async (t) => {
  const { s, dan, agA, agB, b, client } = await fleet(t)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x', targetConvoId: 'b-sess', initiatorConvoId: 'a-sess' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  assert.deepEqual(participantConvoIds(s.db, 'room'), ['a-sess', 'b-sess'])

  b.send({ op: 'agent_leave', room_id: 'room' })
  const meta = await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta'
    && f.convo_id === 'room' && f.payload.participants?.length === 1)
  assert.deepEqual(meta.payload.participant_convos, [])
  assert.deepEqual(participantConvoIds(s.db, 'room'), [])
  // No joined row left: the room still carries both keys, matching the
  // leave fan, so a client that missed that frame is corrected by a snapshot.
  const row = rowsOf(snapshot(s.db, dan.id)).room
  assert.deepEqual(row.participants, [agA.deviceId])
  assert.deepEqual(row.participant_convos, [])
})

test('participant_convos: a started spawn room yields parent and child; a left child takes both out', async (t) => {
  const { s, dan, agA, agB } = await fleet(t)
  // The spawn room shape approveSpawn leaves: parent owns the room, the
  // target is its joined participant, the row is started with the child id.
  createSpawnRequest(s.db, { id: 'sp1', userId: dan.id, fromDeviceId: agA.deviceId, fromConvoId: 'a-sess', targetDeviceId: agB.deviceId, workdir: '/w', task: 't', link: true })
  assert.ok(claimApprove(s.db, 'sp1'))
  recordJoined(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, spawnId: 'sp1' })
  // Approved but not started: the child is not known yet.
  assert.deepEqual(participantConvoIds(s.db, 'room'), [])
  // The child's conversation row need not exist yet — its bridge publishes
  // it after the start reply.
  assert.ok(markStarted(s.db, 'sp1', { roomId: 'room', childConvoId: 'child-1' }))
  assert.deepEqual(participantConvoIds(s.db, 'room'), ['a-sess', 'child-1'])
  assert.deepEqual(rowsOf(snapshot(s.db, dan.id)).room.participant_convos, ['a-sess', 'child-1'])

  leaveConvo(s.db, { convoId: 'room', agentDeviceId: agB.deviceId })
  assert.deepEqual(participantConvoIds(s.db, 'room'), [], 'a spawn row stays started forever; the joined gate drops it')
})

test('participant_convos: the filtered snapshot sieves private-owned sessions', async (t) => {
  const { s, dan, agA, agB } = await fleet(t)
  const agC = createAgent(s.db, dan.id, 'dev-c')
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x', targetConvoId: 'b-sess', initiatorConvoId: 'a-sess' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x', targetConvoId: 'c-sess', initiatorConvoId: 'a-sess' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, accept: true })
  s.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(agB.deviceId)

  const filtered = rowsOf(snapshot(s.db, dan.id, { excludePrivateOwned: true })).room
  assert.deepEqual(filtered.participants, [agA.deviceId, agC.deviceId].sort((x, y) => x - y))
  assert.deepEqual(filtered.participant_convos, ['a-sess', 'c-sess'], 'the private box\'s session must not leak')
  assert.deepEqual(rowsOf(snapshot(s.db, dan.id)).room.participant_convos, ['a-sess', 'b-sess', 'c-sess'])

  // Its only joined participant private: both keys go, as for participants.
  s.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(agC.deviceId)
  const solo = rowsOf(snapshot(s.db, dan.id, { excludePrivateOwned: true })).room
  assert.equal(solo.participants, undefined)
  assert.equal(solo.participant_convos, undefined)
})

test('participant_convos: snapshot omits the key for non-rooms; a room with unknown sessions carries []', async (t) => {
  const { s, dan, agA, agB, a } = await fleet(t)
  a.send({ op: 'convo_upsert', convo_id: 'solo', title: 'solo', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.convo_id === 'solo')
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  const rows = rowsOf(snapshot(s.db, dan.id))
  assert.equal('participant_convos' in rows.solo, false)
  assert.deepEqual(rows.room.participant_convos, [], 'a pre-3.5 invite named no sessions')
})

test('agent_join with from_convo_id persists it and the joiner\'s session appears once accepted', async (t) => {
  const { s, dan, agB, a, b, client } = await fleet(t)
  await sessions(a, b)
  b.send({ op: 'agent_join', room_id: 'room', justification: 'let me in', from_convo_id: 'b-sess' })
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).initiator_convo_id, 'b-sess')
  const card = await client.waitFor((f) => f.kind === 'journal' && f.type === 'permission_request' && f.payload.request === 'join')
  assert.equal(card.payload.from_convo_id, 'b-sess')
  assert.equal(card.payload.from_convo_title, 'b session')

  assert.ok(answerParkedInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, approve: true }))
  a.send({ op: 'agent_invite_answer', room_id: 'room', peer_device_id: agB.deviceId, accept: true })
  const meta = await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta'
    && f.convo_id === 'room' && Array.isArray(f.payload.participants))
  // Only the joiner's session: in a join-created membership the owner's
  // session is genuinely unknown — the journal learns an owner's session
  // only from an invite it sent (initiator_convo_id) or a spawn's parent.
  // A room the owner has also invited into carries it (see the three-party
  // test below).
  assert.deepEqual(meta.payload.participant_convos, ['b-sess'])
  assert.deepEqual(rowsOf(snapshot(s.db, dan.id)).room.participant_convos, ['b-sess'])
})

test('agent_join without from_convo_id is unchanged; a session it does not own is not_found', async (t) => {
  const { s, agB, a, b, client } = await fleet(t)
  await sessions(a, b)
  // Someone else's session: refused with the anti-enumeration code, no row.
  b.send({ op: 'agent_join', room_id: 'room', justification: 'let me in', from_convo_id: 'a-sess' })
  const err = await b.waitFor((f) => f.op === 'error' && f.ref === 'agent_join')
  assert.equal(err.code, 'not_found')
  assert.equal(getParticipant(s.db, 'room', agB.deviceId), null)

  b.send({ op: 'agent_join', room_id: 'room', justification: 'let me in' })
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  const row = getParticipant(s.db, 'room', agB.deviceId)
  assert.equal(row.state, 'awaiting_user')
  assert.equal(row.initiator_convo_id, null)
  const card = await client.waitFor((f) => f.kind === 'journal' && f.type === 'permission_request' && f.payload.request === 'join')
  assert.equal(card.payload.from_convo_id, '')
  assert.equal(card.payload.from_convo_title, '')

  assert.ok(answerParkedInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, approve: true }))
  a.send({ op: 'agent_invite_answer', room_id: 'room', peer_device_id: agB.deviceId, accept: true })
  const meta = await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta'
    && f.convo_id === 'room' && Array.isArray(f.payload.participants))
  assert.deepEqual(meta.payload.participant_convos, [])
})

test('participant_convos: the owner\'s session stays while the owner is in the room, even after the invitee that carried it leaves', async (t) => {
  // Review repro: A invites B from a-sess, C joins from c-sess, B leaves.
  const { s, dan, agA, agB } = await fleet(t)
  const agC = createAgent(s.db, dan.id, 'dev-c')
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x', targetConvoId: 'b-sess', initiatorConvoId: 'a-sess' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  // agent_join's row shape: the joiner is both participant and initiator.
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, initiatorDeviceId: agC.deviceId, justification: 'x', initiatorConvoId: 'c-sess' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, accept: true })
  assert.deepEqual(participantConvoIds(s.db, 'room'), ['a-sess', 'b-sess', 'c-sess'])

  leaveConvo(s.db, { convoId: 'room', agentDeviceId: agB.deviceId })
  assert.deepEqual(participantConvoIds(s.db, 'room'), ['a-sess', 'c-sess'], 'only the leaver\'s session drops')
  assert.deepEqual(rowsOf(snapshot(s.db, dan.id)).room.participant_convos, ['a-sess', 'c-sess'])

  // The joiner leaving too ends the room (no joined row): owner side goes.
  leaveConvo(s.db, { convoId: 'room', agentDeviceId: agC.deviceId })
  assert.deepEqual(participantConvoIds(s.db, 'room'), [])
})

// The spawn room approveSpawn leaves: A (parent, a-sess) owns it, B is the
// joined child participant, the row is started with child-1.
function startedSpawnRoom(s, dan, agA, agB) {
  createSpawnRequest(s.db, { id: 'sp1', userId: dan.id, fromDeviceId: agA.deviceId, fromConvoId: 'a-sess', targetDeviceId: agB.deviceId, workdir: '/w', task: 't', link: true })
  assert.ok(claimApprove(s.db, 'sp1'))
  recordJoined(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, spawnId: 'sp1' })
  assert.ok(markStarted(s.db, 'sp1', { roomId: 'room', childConvoId: 'child-1' }))
}

test('participant_convos: the spawn parent\'s session stays after the child leaves while others remain', async (t) => {
  const { s, dan, agA, agB } = await fleet(t)
  const agC = createAgent(s.db, dan.id, 'dev-c')
  startedSpawnRoom(s, dan, agA, agB)
  // An invite naming no owner session, so a-sess can only come from the spawn.
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x', targetConvoId: 'c-sess' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, accept: true })
  assert.deepEqual(participantConvoIds(s.db, 'room'), ['a-sess', 'child-1', 'c-sess'])

  leaveConvo(s.db, { convoId: 'room', agentDeviceId: agB.deviceId })
  assert.deepEqual(participantConvoIds(s.db, 'room'), ['a-sess', 'c-sess'])
})

test('participant_convos: a spawn child re-invited after leaving does not resurrect the old spawn\'s child session', async (t) => {
  const { s, dan, agA, agB } = await fleet(t)
  const agC = createAgent(s.db, dan.id, 'dev-c')
  startedSpawnRoom(s, dan, agA, agB)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x', targetConvoId: 'c-sess' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, accept: true })
  leaveConvo(s.db, { convoId: 'room', agentDeviceId: agB.deviceId })
  // The renewal must land on a later millisecond than the spawn's start.
  await new Promise((r) => setTimeout(r, 5))
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x', targetConvoId: 'b-new' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  assert.deepEqual(participantConvoIds(s.db, 'room'), ['a-sess', 'c-sess', 'b-new'])
})

test('dissolved room: the owner-leave fan and the snapshot both carry participants [owner] and participant_convos []', async (t) => {
  const { s, dan, agA, agB, a, b, client } = await fleet(t)
  await sessions(a, b)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x', targetConvoId: 'b-sess', initiatorConvoId: 'a-sess' })
  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: true })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta' && f.convo_id === 'room'
    && f.payload.participant_convos?.length === 2)

  a.send({ op: 'agent_leave', room_id: 'room' })
  const meta = await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta' && f.convo_id === 'room'
    && f.payload.participants?.length === 1)
  assert.deepEqual(meta.payload.participants, [agA.deviceId])
  assert.deepEqual(meta.payload.participant_convos, [])

  // A client that missed that frame gets the same values from /snapshot,
  // never an absent key it would read as "keep what you had".
  const rows = rowsOf(snapshot(s.db, dan.id))
  assert.deepEqual(rows.room.participants, [agA.deviceId])
  assert.deepEqual(rows.room.participant_convos, [])
  // A plain session is still no room.
  assert.equal('participants' in rows['a-sess'], false)
  assert.equal('participant_convos' in rows['a-sess'], false)
})

test('a spawn room with no joined member still reads as a room in the snapshot', async (t) => {
  const { s, dan, agA, agB } = await fleet(t)
  startedSpawnRoom(s, dan, agA, agB)
  // Remove the membership row outright: the spawn alone marks it a room.
  s.db.prepare('DELETE FROM convo_agents WHERE convo_id=?').run('room')
  const row = rowsOf(snapshot(s.db, dan.id)).room
  assert.deepEqual(row.participants, [agA.deviceId])
  assert.deepEqual(row.participant_convos, [])
})

test('filtered snapshot: a room only a private box was ever in stays keyless; a mixed room keeps its keys after dissolving', async (t) => {
  const { s, dan, agA, agB } = await fleet(t)
  const agC = createAgent(s.db, dan.id, 'dev-c')
  s.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(agB.deviceId)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  let filtered = rowsOf(snapshot(s.db, dan.id, { excludePrivateOwned: true })).room
  assert.equal('participants' in filtered, false, 'must not reveal a room made only by a private box')
  assert.equal('participant_convos' in filtered, false)

  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x', targetConvoId: 'c-sess', initiatorConvoId: 'a-sess' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, accept: true })
  leaveAllParticipants(s.db, 'room')
  filtered = rowsOf(snapshot(s.db, dan.id, { excludePrivateOwned: true })).room
  assert.deepEqual(filtered.participants, [agA.deviceId])
  assert.deepEqual(filtered.participant_convos, [])
})

test('participant_convos: the owner\'s accepted session survives re-inviting a member who left, and an unaccepted invite\'s source never replaces it', async (t) => {
  // Review repro: A invites B from a-sess, C joins, B leaves, A re-invites B.
  const { s, dan, agA, agB } = await fleet(t)
  const agC = createAgent(s.db, dan.id, 'dev-c')
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x', targetConvoId: 'b-sess', initiatorConvoId: 'a-sess' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, initiatorDeviceId: agC.deviceId, justification: 'x', initiatorConvoId: 'c-sess' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, accept: true })
  leaveConvo(s.db, { convoId: 'room', agentDeviceId: agB.deviceId })
  assert.deepEqual(participantConvoIds(s.db, 'room'), ['a-sess', 'c-sess'])

  // The renewal is pending (and then denied): a-sess must stay, and the
  // renewal's own source session (a-other) must not appear.
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x', targetConvoId: 'b-new', initiatorConvoId: 'a-other' })
  assert.deepEqual(participantConvoIds(s.db, 'room'), ['a-sess', 'c-sess'], 'pending renewal')
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: false })
  assert.deepEqual(participantConvoIds(s.db, 'room'), ['a-sess', 'c-sess'], 'refused renewal')
  assert.deepEqual(rowsOf(snapshot(s.db, dan.id)).room.participant_convos, ['a-sess', 'c-sess'])
})

test('participant_convos: a dissolved room\'s old owner sessions do not come back when the room is repopulated', async (t) => {
  const { s, dan, agA, agB } = await fleet(t)
  const agC = createAgent(s.db, dan.id, 'dev-c')
  startedSpawnRoom(s, dan, agA, agB)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x', targetConvoId: 'c-sess', initiatorConvoId: 'a-sess2' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, accept: true })
  assert.deepEqual(participantConvoIds(s.db, 'room'), ['a-sess', 'a-sess2', 'child-1', 'c-sess'])

  leaveAllParticipants(s.db, 'room')
  // A later join (no owner session named) repopulates the room.
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, initiatorDeviceId: agC.deviceId, justification: 'x', initiatorConvoId: 'c-new' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, accept: true })
  assert.deepEqual(participantConvoIds(s.db, 'room'), ['c-new'], 'neither the old invite source nor the old spawn parent resurrects')
})

test('participant_convos: a spawn target renewed before the start reply does not bind the child to the replacement membership', async (t) => {
  const { s, dan, agA, agB } = await fleet(t)
  createSpawnRequest(s.db, { id: 'sp1', userId: dan.id, fromDeviceId: agA.deviceId, fromConvoId: 'a-sess', targetDeviceId: agB.deviceId, workdir: '/w', task: 't', link: true })
  assert.ok(claimApprove(s.db, 'sp1'))
  recordJoined(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, spawnId: 'sp1' })
  // While approveSpawn awaits the start RPC: B leaves and accepts a fresh
  // invite for another of its sessions.
  leaveConvo(s.db, { convoId: 'room', agentDeviceId: agB.deviceId })
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x', targetConvoId: 'b-new' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  assert.ok(markStarted(s.db, 'sp1', { roomId: 'room', childConvoId: 'child-1' }))
  // The parent is still the owner's session in the room; only the child,
  // which belongs to the membership B left, must not appear.
  assert.deepEqual(participantConvoIds(s.db, 'room'), ['a-sess', 'b-new'], 'child-1 belongs to the membership B left')
})

test('participant_convos: the filtered snapshot drops a session a private device has since taken over', async (t) => {
  const { s, dan, agA, agB, a, b } = await fleet(t)
  const agP = createAgent(s.db, dan.id, 'dev-p')
  await sessions(a, b)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x', targetConvoId: 'b-sess', initiatorConvoId: 'a-sess' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  // convo_upsert's last-writer-wins takeover of a participant-less session
  // by a private device (ws.js permits it when the old owner is ordinary).
  const p = await makeWsClient(s.base, { token: agP.token, cursor: null })
  t.after(() => p.close())
  await p.waitFor((f) => f.op === 'hello_ok')
  // After hello: the handshake re-derives an unpinned private flag.
  s.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(agP.deviceId)
  p.send({ op: 'convo_upsert', convo_id: 'a-sess', title: 'taken', session_state: 'running' })
  await p.waitFor((f) => f.kind === 'journal' && f.convo_id === 'a-sess' && f.payload?.title === 'taken')
  assert.equal(s.db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get('a-sess').agent_device_id, agP.deviceId)

  const filtered = rowsOf(snapshot(s.db, dan.id, { excludePrivateOwned: true })).room
  assert.deepEqual(filtered.participant_convos, ['b-sess'], 'a-sess is private-owned now')
  assert.deepEqual(rowsOf(snapshot(s.db, dan.id)).room.participant_convos, ['a-sess', 'b-sess'])
})
