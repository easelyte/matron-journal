import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { pinDevicePrivate } from '../src/db.js'

// `viewing` is a client op (tracker #2851). No bridge sends it; an agent
// connection that could would receive streaming/activity/status ephemerals
// for any convo of its user — including a private box's convos and
// agent-chat rooms it has not joined, which hello replay and live journal
// fan-out both hide from it.
//
// Two layers, tested separately: the op refusal (an agent's `viewing` never
// takes effect) and hub.sendEphemeral's agent scoping (an agent that
// somehow HAS a viewing set still only hears convos it owns or has joined).

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))
const ephemeralsFor = (c, convoId) => c.frames.filter((f) => f.kind === 'ephemeral' && f.convo_id === convoId)

// Waits until the server has recorded a client connection viewing every id —
// a fixed delay doesn't prove the `viewing` frame was processed (CodeRabbit).
async function untilClientViewing(s, convoIds) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const viewing = s.hub.allConns().some((c) => c.kind === 'client' && convoIds.every((id) => c.viewingConvoIds?.has(id)))
    if (viewing) return
    await settle(10)
  }
  assert.fail(`client never recorded viewing ${convoIds.join(', ')}`)
}

async function fixture(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const kit = createAgent(s.db, dan.id, 'kit')
  const ghost = createAgent(s.db, dan.id, 'ghost')
  const owner = createAgent(s.db, dan.id, 'owner')
  const mate = createAgent(s.db, dan.id, 'mate')
  pinDevicePrivate(s.db, ghost.deviceId, true)
  upsertConversation(s.db, { id: 'ghost-work', ownerUserId: dan.id, title: 'Ghost work', sessionState: 'running', agentDeviceId: ghost.deviceId })
  upsertConversation(s.db, { id: 'room-1', ownerUserId: dan.id, title: 'Room', sessionState: 'running', agentDeviceId: owner.deviceId })
  // kit was invited to the room but never joined.
  s.db.prepare(
    "INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, created_at) VALUES(?,?,?,'invited',?)"
  ).run('room-1', kit.deviceId, owner.deviceId, Date.now())
  // mate has joined it.
  s.db.prepare(
    "INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, created_at) VALUES(?,?,?,'joined',?)"
  ).run('room-1', mate.deviceId, owner.deviceId, Date.now())
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const conns = {
    kit: await makeWsClient(s.base, { token: kit.token, cursor: null }),
    ghost: await makeWsClient(s.base, { token: ghost.token, cursor: null }),
    owner: await makeWsClient(s.base, { token: owner.token, cursor: null }),
    mate: await makeWsClient(s.base, { token: mate.token, cursor: null }),
    client: await makeWsClient(s.base, { token: login.json.token, cursor: 0 }),
  }
  for (const c of Object.values(conns)) await c.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { for (const c of Object.values(conns)) c.close() })
  const ids = { kit: kit.deviceId, ghost: ghost.deviceId, owner: owner.deviceId, mate: mate.deviceId }
  return { s, dan, ids, ...conns }
}

// Every ephemeral family a producing agent can fan out for its own convo.
function produceEphemerals(agent, convoId) {
  agent.send({ op: 'activity', convo_id: convoId, state: 'thinking' })
  agent.send({ op: 'status', convo_id: convoId, status: { model: 'x' } })
  agent.send({ op: 'stream', convo_id: convoId, message_ref: 'm1', replace_text: 'secret progress' })
  agent.send({ op: 'stream_append', convo_id: convoId, message_ref: 't1', offset: 0, chunk: 'secret output', meta: { tool: 'Bash' } })
}

test('an agent sending `viewing` is refused as forbidden (single and set forms)', async (t) => {
  const { kit } = await fixture(t)
  const refusals = () => kit.frames.filter((f) => f.kind === 'control' && f.op === 'error' && f.code === 'forbidden' && f.ref === 'viewing')
  kit.send({ op: 'viewing', convo_id: 'ghost-work' })
  kit.send({ op: 'viewing', convo_ids: ['ghost-work', 'room-1'] })
  await kit.waitFor(() => refusals().length === 2)
})

// Proves the op refusal: kit's `viewing` never takes effect.
test('an agent viewing a private box\'s convo receives none of its ephemerals; the client still does', async (t) => {
  const { s, kit, ghost, client } = await fixture(t)
  kit.send({ op: 'viewing', convo_id: 'ghost-work' })
  kit.send({ op: 'viewing', convo_ids: ['ghost-work'] })
  client.send({ op: 'viewing', convo_id: 'ghost-work' })
  await untilClientViewing(s, ['ghost-work'])
  produceEphemerals(ghost, 'ghost-work')
  await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'ghost-work' && f.tool_stream)
  await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'ghost-work' && f.activity)
  await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'ghost-work' && f.status)
  await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'ghost-work' && f.replace_text === 'secret progress')
  await settle()
  assert.deepEqual(ephemeralsFor(kit, 'ghost-work'), [], 'a non-private agent must not see a private box\'s ephemerals')
})

// Proves the op refusal for the set form against an unjoined room.
test('an agent viewing a room it has not joined receives none of its ephemerals', async (t) => {
  const { s, kit, owner, client } = await fixture(t)
  kit.send({ op: 'viewing', convo_ids: ['room-1'] })
  client.send({ op: 'viewing', convo_ids: ['room-1'] })
  await untilClientViewing(s, ['room-1'])
  produceEphemerals(owner, 'room-1')
  await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'room-1' && f.activity)
  await settle()
  assert.deepEqual(ephemeralsFor(kit, 'room-1'), [], 'an unjoined agent must not see the room\'s ephemerals')
})

// Hub-layer scoping, end to end. The op refusal means no agent can get a
// viewing set through the protocol, so plant one on the live registered
// connection — the state a future regression (or a bypass of the op check)
// would produce — and drive real agent ops through ws.js into the hub.
function plantViewing(s, deviceId, convoIds) {
  const conn = s.hub.allConns().find((c) => c.deviceId === deviceId)
  assert.ok(conn, `device ${deviceId} is registered`)
  conn.viewingConvoIds = new Set(convoIds)
}

const hasAllFamilies = (c, convoId) => {
  const e = ephemeralsFor(c, convoId)
  return e.some((f) => f.activity) && e.some((f) => f.status) && e.some((f) => f.replace_text === 'secret progress') && e.some((f) => f.tool_stream)
}

test('hub scoping: a viewing owner and a joined member still receive every ephemeral family', async (t) => {
  const { s, ids, owner, mate } = await fixture(t)
  plantViewing(s, ids.owner, ['room-1'])
  plantViewing(s, ids.mate, ['room-1'])
  produceEphemerals(owner, 'room-1')
  await owner.waitFor(() => hasAllFamilies(owner, 'room-1'))
  await mate.waitFor(() => hasAllFamilies(mate, 'room-1'))
})

test('hub scoping: a viewing non-member agent receives nothing from a private box or an unjoined room', async (t) => {
  const { s, ids, kit, ghost, owner, client } = await fixture(t)
  plantViewing(s, ids.kit, ['ghost-work', 'room-1'])
  client.send({ op: 'viewing', convo_ids: ['ghost-work', 'room-1'] })
  await untilClientViewing(s, ['ghost-work', 'room-1'])
  produceEphemerals(ghost, 'ghost-work')
  produceEphemerals(owner, 'room-1')
  await client.waitFor(() => hasAllFamilies(client, 'ghost-work') && hasAllFamilies(client, 'room-1'))
  await settle()
  assert.deepEqual(ephemeralsFor(kit, 'ghost-work'), [], 'private box ephemerals must not reach another agent')
  assert.deepEqual(ephemeralsFor(kit, 'room-1'), [], 'unjoined room ephemerals must not reach the agent')
})
