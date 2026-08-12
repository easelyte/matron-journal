import { test } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { openDb, isPrivateDevice, pinDevicePrivate, unpinDevicePrivate, applyBridgePrivate } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { getParticipant, answerParkedInvite } from '../src/participants.js'
import { startTestServer, makeWsClient } from './helpers.js'

async function dbWithAgent() {
  const db = openDb(':memory:')
  const u = await createUser(db, 'dan', 'pw')
  const a = createAgent(db, u.id, 'kit')
  return { db, userId: u.id, deviceId: a.deviceId, token: a.token }
}

test('privacy flag: defaults to 0 and unpinned for every device', async () => {
  const { db, deviceId } = await dbWithAgent()
  assert.equal(isPrivateDevice(db, deviceId), false)
  const row = db.prepare('SELECT private, private_pinned FROM devices WHERE id=?').get(deviceId)
  assert.deepEqual(row, { private: 0, private_pinned: 0 })
  db.close()
})

test('privacy flag: bridge assertion applies only while unpinned', async () => {
  const { db, deviceId } = await dbWithAgent()
  applyBridgePrivate(db, deviceId, true)
  assert.equal(isPrivateDevice(db, deviceId), true)
  applyBridgePrivate(db, deviceId, false)
  assert.equal(isPrivateDevice(db, deviceId), false)
  pinDevicePrivate(db, deviceId, true)
  applyBridgePrivate(db, deviceId, false) // the forgot-the-env-var deploy
  assert.equal(isPrivateDevice(db, deviceId), true, 'admin pin survives a contrary hello')
  unpinDevicePrivate(db, deviceId)
  assert.equal(isPrivateDevice(db, deviceId), true, 'unpinning alone changes no value')
  applyBridgePrivate(db, deviceId, false)
  assert.equal(isPrivateDevice(db, deviceId), false, 'after unpin the bridge assertion applies again')
  db.close()
})

test('privacy flag: pin off is also pinned — admin can force-visible', async () => {
  const { db, deviceId } = await dbWithAgent()
  pinDevicePrivate(db, deviceId, false)
  applyBridgePrivate(db, deviceId, true)
  assert.equal(isPrivateDevice(db, deviceId), false)
  db.close()
})

test('privacy flag: isPrivateDevice on an unknown/deleted id is false, never a throw', async () => {
  const { db } = await dbWithAgent()
  assert.equal(isPrivateDevice(db, 99999), false)
  db.close()
})

async function serverWithAgent() {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })
  const userId = login.json.user_id
  const clientToken = login.json.token
  const agent = createAgent(s.db, userId, 'kit')
  return { s, userId, clientToken, agent }
}

// hello with an explicit private field needs a raw client — makeWsClient's
// hello only sends token+cursor, so drive the frame by hand.
function helloRaw(base, frame) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
    const frames = []
    ws.on('message', (d) => frames.push(JSON.parse(d)))
    ws.on('error', reject)
    ws.on('close', () => resolve({ frames, closed: true }))
    ws.on('open', () => {
      ws.send(JSON.stringify(frame))
      setTimeout(() => { if (ws.readyState === 1) resolve({ frames, closed: false, ws }) }, 150)
    })
  })
}

test('hello: an agent asserting private:true is marked private before registration', async () => {
  const { s, agent } = await serverWithAgent()
  const r = await helloRaw(s.base, { op: 'hello', token: agent.token, private: true })
  assert.ok(r.frames.some((f) => f.op === 'hello_ok'))
  assert.equal(s.db.prepare('SELECT private FROM devices WHERE id=?').get(agent.deviceId).private, 1)
  r.ws?.close()
  await s.close()
})

test('hello: omitting the field asserts visible — bridge-set privacy does not survive a re-register', async () => {
  const { s, agent } = await serverWithAgent()
  const r1 = await helloRaw(s.base, { op: 'hello', token: agent.token, private: true })
  r1.ws?.close()
  const r2 = await helloRaw(s.base, { op: 'hello', token: agent.token })
  assert.equal(s.db.prepare('SELECT private FROM devices WHERE id=?').get(agent.deviceId).private, 0)
  r2.ws?.close()
  await s.close()
})

test('hello: an admin-pinned flag survives a contrary hello', async () => {
  const { s, agent } = await serverWithAgent()
  pinDevicePrivate(s.db, agent.deviceId, true)
  const r = await helloRaw(s.base, { op: 'hello', token: agent.token })
  assert.ok(r.frames.some((f) => f.op === 'hello_ok'))
  assert.equal(s.db.prepare('SELECT private FROM devices WHERE id=?').get(agent.deviceId).private, 1)
  r.ws?.close()
  await s.close()
})

test('hello: a client sending private is ignored; a non-boolean is rejected', async () => {
  const { s, clientToken } = await serverWithAgent()
  const ok = await helloRaw(s.base, { op: 'hello', token: clientToken, private: true })
  assert.ok(ok.frames.some((f) => f.op === 'hello_ok'), 'client hello unaffected')
  ok.ws?.close()
  const bad = await helloRaw(s.base, { op: 'hello', token: clientToken, private: 'yes' })
  assert.ok(bad.frames.some((f) => f.op === 'error' && f.code === 'bad_request' && f.ref === 'hello'))
  await s.close()
})

// Fixture: dan with a client, an ordinary agent (kit), and two private
// agents (ghost, wraith). ghost manages a conversation.
async function privacyFixture() {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })
  const userId = login.json.user_id
  const clientToken = login.json.token
  const kit = createAgent(s.db, userId, 'kit')
  const ghost = createAgent(s.db, userId, 'ghost')
  const wraith = createAgent(s.db, userId, 'wraith')
  pinDevicePrivate(s.db, ghost.deviceId, true)
  pinDevicePrivate(s.db, wraith.deviceId, true)
  upsertConversation(s.db, { id: 'open-work', ownerUserId: userId, title: 'Open work', sessionState: 'running', agentDeviceId: kit.deviceId })
  upsertConversation(s.db, { id: 'ghost-work', ownerUserId: userId, title: 'Ghost work', sessionState: 'running', agentDeviceId: ghost.deviceId })
  upsertConversation(s.db, { id: 'legacy', ownerUserId: userId, title: 'Legacy', sessionState: 'done' }) // agent_device_id NULL
  return { s, userId, clientToken, kit, ghost, wraith }
}

test('roster: an ordinary agent cannot see private devices or their conversations', async () => {
  const { s, kit, ghost } = await privacyFixture()
  const r = await s.http('/roster', { token: kit.token })
  assert.equal(r.status, 200)
  const ids = r.json.agents.map((a) => a.device_id)
  assert.ok(ids.includes(kit.deviceId))
  assert.ok(!ids.includes(ghost.deviceId), 'private device absent')
  const convos = r.json.conversations.map((c) => c.id)
  assert.ok(convos.includes('open-work'))
  assert.ok(convos.includes('legacy'), 'NULL-owner conversations stay visible')
  assert.ok(!convos.includes('ghost-work'), 'private-owned conversation absent — the summaries are the point')
  await s.close()
})

test('roster: a client sees everything, unchanged', async () => {
  const { s, clientToken, ghost } = await privacyFixture()
  const r = await s.http('/roster', { token: clientToken })
  assert.ok(r.json.agents.some((a) => a.device_id === ghost.deviceId))
  assert.ok(r.json.conversations.some((c) => c.id === 'ghost-work'))
  await s.close()
})

test('roster: a private agent sees the whole roster — including another private agent', async () => {
  const { s, ghost, wraith } = await privacyFixture()
  const r = await s.http('/roster', { token: ghost.token })
  assert.ok(r.json.agents.some((a) => a.device_id === wraith.deviceId), 'two private agents see each other')
  assert.ok(r.json.conversations.some((c) => c.id === 'ghost-work'))
  await s.close()
})

test('roster: privacy is per-user — another user roster is unaffected either way', async () => {
  const { s, ghost } = await privacyFixture()
  await createUser(s.db, 'eve', 'password-123')
  const eve = (await s.http('/login', { method: 'POST', body: { username: 'eve', password: 'password-123' } })).json
  const eveAgent = createAgent(s.db, eve.user_id, 'evebot')
  const r = await s.http('/roster', { token: eveAgent.token })
  // dan's devices — private or not — were never visible to eve's agents and stay that way
  assert.ok(!r.json.agents.some((a) => a.device_id === ghost.deviceId))
  assert.deepEqual(r.json.conversations, [])
  await s.close()
})

test('metrics: an ordinary agent\'s device list omits private devices; a client sees everything', async () => {
  const { s, clientToken, kit, ghost, wraith } = await privacyFixture()
  const agentView = await s.http('/metrics', { token: kit.token })
  assert.equal(agentView.status, 200)
  const agentIds = agentView.json.user.devices.map((d) => d.device_id)
  assert.ok(agentIds.includes(kit.deviceId), 'the caller itself stays listed')
  assert.ok(!agentIds.includes(ghost.deviceId), 'private device omitted from an ordinary agent\'s metrics')
  assert.ok(!agentIds.includes(wraith.deviceId), 'private device omitted from an ordinary agent\'s metrics')
  const clientView = await s.http('/metrics', { token: clientToken })
  const clientIds = clientView.json.user.devices.map((d) => d.device_id)
  assert.ok(clientIds.includes(ghost.deviceId), 'client metrics unchanged')
  assert.ok(clientIds.includes(wraith.deviceId), 'client metrics unchanged')
  await s.close()
})

test('metrics: a private agent (ghost) sees the whole device list too — invisible, not blinded', async () => {
  const { s, ghost, wraith } = await privacyFixture()
  const r = await s.http('/metrics', { token: ghost.token })
  const ids = r.json.user.devices.map((d) => d.device_id)
  assert.ok(ids.includes(wraith.deviceId))
  await s.close()
})

// Extends privacyFixture with live sockets for kit (ordinary) and ghost
// (private), and a room each manages.
async function chatPrivacyFixture() {
  const fx = await privacyFixture()
  const kitWs = await makeWsClient(fx.s.base, { token: fx.kit.token, cursor: 0 })
  await kitWs.waitFor((f) => f.op === 'hello_ok')
  const ghostWs = await makeWsClient(fx.s.base, { token: fx.ghost.token, cursor: 0 })
  await ghostWs.waitFor((f) => f.op === 'hello_ok')
  kitWs.send({ op: 'convo_upsert', convo_id: 'kit-room', title: 'Kit room', session_state: 'running' })
  ghostWs.send({ op: 'convo_upsert', convo_id: 'ghost-room', title: 'Ghost room', session_state: 'running' })
  await new Promise((r) => setTimeout(r, 100))
  return { ...fx, kitWs, ghostWs }
}

// Approves a parked ask via the same HTTP route a client's approve tap
// takes — Task 1 removed the standing-allowance fast path that used to let
// a test seed immediate relay directly; this is the real state machine's
// route to a drawn-in participant, not a DB shortcut.
async function approvePark(s, clientToken, roomId, participantDeviceId) {
  const r = await s.http('/agent-chat/answer', {
    method: 'POST', token: clientToken,
    body: { room_id: roomId, target_device_id: participantDeviceId, decision: 'approve' },
  })
  assert.equal(r.status, 200, 'approving the park must succeed')
  return r.json
}

test('agent_invite: a private target answers not_found, byte-identical to an unknown id', async () => {
  const { s, kitWs, ghost } = await chatPrivacyFixture()
  kitWs.send({ op: 'agent_invite', room_id: 'kit-room', target_device_id: ghost.deviceId, justification: 'let me in' })
  const priv = await kitWs.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite')
  kitWs.send({ op: 'agent_invite', room_id: 'kit-room', target_device_id: 999999, justification: 'let me in' })
  const unknown = await kitWs.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite' && f !== priv)
  assert.equal(priv.code, 'not_found')
  const strip = ({ ...f }) => f
  assert.deepEqual(strip(priv), strip(unknown), 'frames identical — existence never confirmed')
  kitWs.close(); await s.close()
})

test('agent_join: a private-owned room answers not_found like a room that does not exist', async () => {
  const { s, kitWs } = await chatPrivacyFixture()
  kitWs.send({ op: 'agent_join', room_id: 'ghost-room', justification: 'curious' })
  const priv = await kitWs.waitFor((f) => f.op === 'error' && f.ref === 'agent_join')
  kitWs.send({ op: 'agent_join', room_id: 'no-such-room', justification: 'curious' })
  const unknown = await kitWs.waitFor((f) => f.op === 'error' && f.ref === 'agent_join' && f.room_id === 'no-such-room')
  assert.equal(priv.code, 'not_found')
  assert.equal(unknown.code, 'not_found')
  kitWs.close(); await s.close()
})

test('a private agent keeps full outbound capability: it can invite an ordinary agent', async () => {
  const { s, ghostWs, kit } = await chatPrivacyFixture()
  ghostWs.send({ op: 'agent_invite', room_id: 'ghost-room', target_device_id: kit.deviceId, justification: 'need your eyes' })
  const ack = await ghostWs.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  assert.equal(ack.room_id, 'ghost-room')
  ghostWs.close(); await s.close()
})

test('a private agent can invite another private agent (the boundary is with ordinary agents)', async () => {
  const { s, ghostWs, wraith } = await chatPrivacyFixture()
  ghostWs.send({ op: 'agent_invite', room_id: 'ghost-room', target_device_id: wraith.deviceId, justification: 'ghost to wraith' })
  const ack = await ghostWs.waitFor((f) => (f.kind === 'invite' && f.event === 'delivered') || f.op === 'error')
  assert.equal(ack.event, 'delivered')
  ghostWs.close(); await s.close()
})

// Fix-round findings: the privacy gate must live in loadRoom itself, ahead
// of every other check any room op makes — otherwise a caller-controlled
// field (a blank justification, an accept flag, an unrelated arg) picks
// which of two DIFFERENT rejections comes back, and that difference alone
// confirms a private room exists. room_id necessarily differs between the
// "real private room" and "no such room" probes in every test below, so
// deepEqual compares the frames with room_id stripped.
const stripRoomId = ({ room_id, ...rest }) => rest

test('agent_join: a blank justification does not flip the answer — the room-privacy not_found wins before the justification check ever runs', async () => {
  const { s, kitWs } = await chatPrivacyFixture()
  kitWs.send({ op: 'agent_join', room_id: 'ghost-room', justification: '' })
  const priv = await kitWs.waitFor((f) => f.op === 'error' && f.ref === 'agent_join')
  kitWs.send({ op: 'agent_join', room_id: 'no-such-room', justification: '' })
  const unknown = await kitWs.waitFor((f) => f.op === 'error' && f.ref === 'agent_join' && f !== priv)
  assert.equal(priv.code, 'not_found')
  assert.equal(unknown.code, 'not_found')
  assert.deepEqual(stripRoomId(priv), stripRoomId(unknown), 'a malformed justification never distinguishes a private room from an unknown one')
  kitWs.close(); await s.close()
})

test('per-op existence oracle: agent_invite, agent_invite_answer, and agent_leave all answer a private-owned room exactly like an unknown one', async () => {
  const { s, kitWs, ghost } = await chatPrivacyFixture()
  const probe = async (frame) => {
    kitWs.send({ ...frame, room_id: 'ghost-room' })
    const priv = await kitWs.waitFor((f) => f.op === 'error' && f.ref === frame.op)
    kitWs.send({ ...frame, room_id: 'no-such-room' })
    const unknown = await kitWs.waitFor((f) => f.op === 'error' && f.ref === frame.op && f !== priv)
    assert.equal(priv.code, 'not_found', `${frame.op} on the private-owned room`)
    assert.equal(unknown.code, 'not_found', `${frame.op} on an unknown room`)
    assert.deepEqual(stripRoomId(priv), stripRoomId(unknown), `${frame.op} frames identical modulo room_id`)
  }
  await probe({ op: 'agent_invite', target_device_id: ghost.deviceId, justification: 'probe' })
  await probe({ op: 'agent_invite_answer', accept: true })
  await probe({ op: 'agent_leave' })
  kitWs.close(); await s.close()
})

test('agent_join: a private caller (wraith) passes the room-privacy gate on another private device (ghost)\'s room', async () => {
  const { s, wraith } = await chatPrivacyFixture()
  const wraithWs = await makeWsClient(s.base, { token: wraith.token, cursor: 0 })
  await wraithWs.waitFor((f) => f.op === 'hello_ok')
  wraithWs.send({ op: 'agent_join', room_id: 'ghost-room', justification: 'wraith joining ghost' })
  const ack = await wraithWs.waitFor((f) => (f.kind === 'invite' && f.event === 'delivered') || f.op === 'error')
  assert.notEqual(ack.code, 'not_found', 'a private caller is invisible, not blinded — the gate never fires for it')
  assert.equal(ack.event, 'delivered', 'normal park-for-consent flow runs, same as any other valid join request')
  wraithWs.close(); await s.close()
})

test('the drawn-in flow: once ghost invites kit and kit accepts, kit can answer and later leave — no step is rejected not_found', async () => {
  const { s, clientToken, ghost, kit, ghostWs, kitWs } = await chatPrivacyFixture()
  ghostWs.send({ op: 'agent_invite', room_id: 'ghost-room', target_device_id: kit.deviceId, justification: 'need your eyes' })
  await ghostWs.waitFor((f) => f.kind === 'invite' && f.event === 'delivered' && f.target_device_id === kit.deviceId)
  // Every ask parks for the user's consent now (Task 1 removed the
  // standing-allowance fast path) — approve it for real, the state
  // machine's own route to a drawn-in participant.
  await approvePark(s, clientToken, 'ghost-room', kit.deviceId)
  const req = await kitWs.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  assert.equal(req.room_id, 'ghost-room')
  // Pin the exemption's actual precondition (fix-round-2 finding): this
  // row must be delivered_at-set, not merely "any row exists" — that is
  // exactly what distinguishes it from the parked/denied rows the gate
  // must still block (see the isKnownParticipant test below).
  assert.ok(getParticipant(s.db, 'ghost-room', kit.deviceId).delivered_at != null, 'sanity: this is a delivered row, the case the gate must exempt')
  kitWs.send({ op: 'agent_invite_answer', room_id: 'ghost-room', accept: true })
  await ghostWs.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  kitWs.send({ op: 'agent_leave', room_id: 'ghost-room' })
  await ghostWs.waitFor((f) => f.kind === 'invite' && f.event === 'left')
  assert.equal(kitWs.frames.filter((f) => f.op === 'error').length, 0,
    'kit — drawn into ghost\'s private room by an accepted invite — never hit the room-privacy not_found gate')
  kitWs.close(); ghostWs.close(); await s.close()
})

test('agent_leave/agent_join: a merely parked (awaiting_user) or denied row does NOT exempt the gate — not_found byte-identical to an unknown room', async () => {
  const { s, kit, ghostWs, kitWs } = await chatPrivacyFixture()
  // No standing allowance: this invite parks for the user's consent
  // instead of ever reaching kit's socket (see appendAndFan's comment in
  // ws.js — a parked card is client-only, no agent device gets it).
  ghostWs.send({ op: 'agent_invite', room_id: 'ghost-room', target_device_id: kit.deviceId, justification: 'park me' })
  await ghostWs.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(!kitWs.frames.some((f) => f.kind === 'invite' && f.event === 'request'), 'sanity: parked, never delivered to kit')
  assert.equal(getParticipant(s.db, 'ghost-room', kit.deviceId).state, 'awaiting_user')
  assert.equal(getParticipant(s.db, 'ghost-room', kit.deviceId).delivered_at, null)

  const stripRoomId = ({ room_id, ...rest }) => rest
  const probe = async (op, extra = {}) => {
    kitWs.send({ op, room_id: 'ghost-room', ...extra })
    const priv = await kitWs.waitFor((f) => f.op === 'error' && f.ref === op)
    kitWs.send({ op, room_id: 'no-such-room', ...extra })
    const unknown = await kitWs.waitFor((f) => f.op === 'error' && f.ref === op && f !== priv)
    assert.equal(priv.code, 'not_found', `${op} on the parked/denied private room`)
    assert.equal(unknown.code, 'not_found', `${op} on an unknown room`)
    assert.deepEqual(stripRoomId(priv), stripRoomId(unknown), `${op} frames identical modulo room_id`)
  }
  // awaiting_user: never delivered — probe/existence must still be hidden.
  await probe('agent_leave')
  await probe('agent_join', { justification: 'curious' })

  // Drive the same row to 'denied' (the user explicitly refused) and
  // confirm the gate still blocks — denied means the target was never told.
  assert.ok(answerParkedInvite(s.db, { convoId: 'ghost-room', agentDeviceId: kit.deviceId, approve: false }))
  assert.equal(getParticipant(s.db, 'ghost-room', kit.deviceId).state, 'denied')
  await probe('agent_leave')
  await probe('agent_join', { justification: 'curious again' })

  kitWs.close(); ghostWs.close(); await s.close()
})

test('read_marker: an ordinary agent marking a private-owned conversation gets the byte-identical forbidden an unknown convo_id gets; no event lands', async () => {
  const { s, kitWs } = await chatPrivacyFixture()
  const eventsBefore = s.db.prepare("SELECT COUNT(*) c FROM events WHERE convo_id='ghost-work'").get().c
  kitWs.send({ op: 'read_marker', convo_id: 'ghost-work' })
  const priv = await kitWs.waitFor((f) => f.op === 'error' && f.ref === 'read_marker')
  kitWs.send({ op: 'read_marker', convo_id: 'no-such-convo' })
  const unknown = await kitWs.waitFor((f) => f.op === 'error' && f.ref === 'read_marker' && f !== priv)
  assert.equal(priv.code, 'forbidden')
  assert.deepEqual(priv, unknown, 'byte-identical to the unknown-convo rejection — existence never confirmed')
  const eventsAfter = s.db.prepare("SELECT COUNT(*) c FROM events WHERE convo_id='ghost-work'").get().c
  assert.equal(eventsAfter, eventsBefore, 'no read_marker event landed in the private room')
  kitWs.close(); await s.close()
})

test('read_marker: a client can still mark a private-owned conversation read', async () => {
  const { s, clientToken } = await chatPrivacyFixture()
  const clientWs = await makeWsClient(s.base, { token: clientToken, cursor: 0 })
  await clientWs.waitFor((f) => f.op === 'hello_ok')
  clientWs.send({ op: 'read_marker', convo_id: 'ghost-work' })
  const frame = await clientWs.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker')
  assert.equal(frame.convo_id, 'ghost-work')
  clientWs.close(); await s.close()
})

test('convo_upsert: an ordinary agent cannot take over a private-owned, participant-less conversation', async () => {
  const { s, kitWs, ghost } = await chatPrivacyFixture()
  const before = s.db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get('ghost-work')
  assert.equal(before.agent_device_id, ghost.deviceId)
  kitWs.send({ op: 'convo_upsert', convo_id: 'ghost-work', title: 'stolen', session_state: 'running' })
  const err = await kitWs.waitFor((f) => f.op === 'error' && f.ref === 'convo_upsert')
  assert.equal(err.code, 'forbidden')
  const after = s.db.prepare('SELECT agent_device_id, title FROM conversations WHERE id=?').get('ghost-work')
  assert.equal(after.agent_device_id, ghost.deviceId, 'ownership unchanged')
  assert.notEqual(after.title, 'stolen')
  kitWs.close(); await s.close()
})

test('convo_upsert: a private agent (ghost) can still upsert its own participant-less conversation', async () => {
  const { s, ghostWs, ghost } = await chatPrivacyFixture()
  ghostWs.send({ op: 'convo_upsert', convo_id: 'ghost-work', title: 'still mine', session_state: 'running' })
  await new Promise((r) => setTimeout(r, 50))
  const after = s.db.prepare('SELECT agent_device_id, title FROM conversations WHERE id=?').get('ghost-work')
  assert.equal(after.agent_device_id, ghost.deviceId)
  assert.equal(after.title, 'still mine')
  await s.close()
})

test('convo_upsert: an ordinary agent can still upsert a brand new conversation id', async () => {
  const { s, kitWs } = await chatPrivacyFixture()
  kitWs.send({ op: 'convo_upsert', convo_id: 'kit-fresh', title: 'fresh', session_state: 'running' })
  await new Promise((r) => setTimeout(r, 50))
  const row = s.db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get('kit-fresh')
  assert.ok(row, 'a new id is unaffected by the private-owner guard')
  kitWs.close(); await s.close()
})

// Extends privacyFixture with an indexed prose message in each of the two
// title-owned conversations, so search hits and around_seq context reads
// have something real to find.
async function searchPrivacyFixture() {
  const fx = await privacyFixture()
  append(fx.s.db, { userId: fx.userId, convoId: 'open-work', sender: 'agent:kit', type: 'text', payload: { body: 'heliotrope in the open' } })
  append(fx.s.db, { userId: fx.userId, convoId: 'ghost-work', sender: 'agent:ghost', type: 'text', payload: { body: 'heliotrope behind the veil' } })
  return fx
}

test('search: an ordinary agent gets no hits from private-owned conversations', async () => {
  const { s, kit } = await searchPrivacyFixture()
  const r = await s.http('/search?q=heliotrope', { token: kit.token })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.hits.map((h) => h.convo_id), ['open-work'])
  await s.close()
})

test('search: clients and private agents see hits from everywhere', async () => {
  const { s, clientToken, ghost } = await searchPrivacyFixture()
  for (const token of [clientToken, ghost.token]) {
    const r = await s.http('/search?q=heliotrope', { token })
    assert.equal(r.json.hits.length, 2, 'both conversations hit')
  }
  await s.close()
})

// The most direct existence probe: narrowing the search to the private-owned
// convo_id directly, instead of relying on it being absent from an unscoped
// hit list. Also the only test that exercises the 4-bind SQL variant
// (match, userId, convoId, limit) with excludePrivateOwned active — a future
// edit that moves the predicate relative to the convoId ternary would break
// silently without this.
test('search: convo_id-narrowed search on a private-owned conversation returns empty, not an error', async () => {
  const { s, kit } = await searchPrivacyFixture()
  const r = await s.http('/search?q=heliotrope&convo_id=ghost-work', { token: kit.token })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.hits, [])
  await s.close()
})

// The roster pins NULL-owner (legacy) conversations as always-visible to an
// ordinary agent (see "roster: an ordinary agent cannot see private devices
// or their conversations" above) — search must agree, since excludePrivateOwned
// is a self-contained SQL predicate independent of the roster's.
test('search: an ordinary agent still gets hits from a NULL-owner (legacy) conversation', async () => {
  const { s, kit, userId } = await searchPrivacyFixture()
  append(s.db, { userId, convoId: 'legacy', sender: 'agent:kit', type: 'text', payload: { body: 'heliotrope in the archive' } })
  const r = await s.http('/search?q=heliotrope', { token: kit.token })
  assert.equal(r.status, 200)
  assert.ok(r.json.hits.some((h) => h.convo_id === 'legacy'), 'NULL-owner conversation is never private-owned')
  await s.close()
})

test('around_seq: a private-owned conversation is 404 for an ordinary agent, normal for a client', async () => {
  const { s, kit, clientToken, userId } = await searchPrivacyFixture()
  const anchor = s.db.prepare("SELECT seq FROM events WHERE convo_id='ghost-work' ORDER BY seq DESC LIMIT 1").get().seq
  const agentRead = await s.http(`/convo/ghost-work/messages?around_seq=${anchor}`, { token: kit.token })
  assert.equal(agentRead.status, 404)
  const missing = await s.http(`/convo/never-existed/messages?around_seq=${anchor}`, { token: kit.token })
  assert.equal(missing.status, 404)
  assert.deepEqual(agentRead.json, missing.json, 'indistinguishable from a missing conversation')
  const clientRead = await s.http(`/convo/ghost-work/messages?around_seq=${anchor}`, { token: clientToken })
  assert.equal(clientRead.status, 200)
  await s.close()
})

test('around_seq: a private agent reads foreign context like any other agent surface allows', async () => {
  const { s, ghost } = await searchPrivacyFixture()
  const anchor = s.db.prepare("SELECT seq FROM events WHERE convo_id='open-work' ORDER BY seq DESC LIMIT 1").get().seq
  const r = await s.http(`/convo/open-work/messages?around_seq=${anchor}`, { token: ghost.token })
  assert.equal(r.status, 200)
  await s.close()
})

// /snapshot: two independent rules (spec: agent visibility & privacy, task
// 8). Credential rule — snippet must never reach ANY agent device, because
// snippetOf() can surface tool_output text (where credentials land); /roster
// already omits snippet for exactly this reason. Privacy rule — mirrors
// roster's ordinary-agent conversation filter so /snapshot can't be used as
// an end-run around it.
test('snapshot: an agent caller never sees a tool_output-derived snippet, even for its own conversation', async () => {
  const { s, kit, clientToken, userId } = await privacyFixture()
  append(s.db, {
    userId, convoId: 'open-work', sender: 'agent:kit', type: 'tool_output',
    payload: { snippet: 'SECRET=hunter2' },
  })
  const agentRead = await s.http('/snapshot', { token: kit.token })
  assert.equal(agentRead.status, 200)
  assert.ok(!JSON.stringify(agentRead.json).includes('SECRET'), 'no credential text anywhere in an agent snapshot')
  const clientRead = await s.http('/snapshot', { token: clientToken })
  const clientConvo = clientRead.json.conversations.find((c) => c.id === 'open-work')
  assert.equal(clientConvo.snippet, 'SECRET=hunter2', 'clients keep snippets unchanged')
  await s.close()
})

test('snapshot: an ordinary agent does not see a private-owned conversation', async () => {
  const { s, kit } = await privacyFixture()
  const r = await s.http('/snapshot', { token: kit.token })
  assert.equal(r.status, 200)
  const ids = r.json.conversations.map((c) => c.id)
  assert.ok(!ids.includes('ghost-work'), 'private-owned conversation absent')
  assert.ok(ids.includes('open-work'))
  assert.ok(ids.includes('legacy'), 'NULL-owner conversations stay visible')
  await s.close()
})

test('snapshot: a client and a private agent (ghost) see all three conversations', async () => {
  const { s, clientToken, ghost } = await privacyFixture()
  for (const token of [clientToken, ghost.token]) {
    const r = await s.http('/snapshot', { token })
    const ids = r.json.conversations.map((c) => c.id)
    assert.ok(ids.includes('open-work'))
    assert.ok(ids.includes('ghost-work'))
    assert.ok(ids.includes('legacy'))
  }
  const ghostSnapshot = await s.http('/snapshot', { token: ghost.token })
  assert.ok(ghostSnapshot.json.conversations.every((c) => c.snippet === null), 'a private agent still never gets a snippet')
  await s.close()
})
