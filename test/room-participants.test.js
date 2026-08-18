import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { inviteParticipant, answerInvite } from '../src/participants.js'
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

  // Merely invited is not membership — no participants array yet.
  let rows = Object.fromEntries(snapshot(s.db, dan.id).conversations.map((c) => [c.id, c]))
  assert.equal(rows.room.participants, undefined, 'an invited-but-unanswered room is not yet multi-agent')

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
