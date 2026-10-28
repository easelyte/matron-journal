import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { openDb } from '../src/db.js'
import { FRESH_ROOM_SQL } from '../src/person-rooms.js'

// Rooms between two people's agents (spec 2026-10-02 matron-to-matron
// sharing, phase 2), end to end over real HTTP and sockets: alice (a box, a
// Coordinator box and a phone) and bob (a box and a phone). Alice's agent owns
// the room; Bob's session is the guest.
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms))
const post = (body) => ({ method: 'POST', body })

async function world(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const bob = await createUser(s.db, 'bob', 'pw')
  const aliceBox = createAgent(s.db, alice.id, 'alice-box')
  const aliceCoord = createAgent(s.db, alice.id, 'alice-coord')
  const bobBox = createAgent(s.db, bob.id, 'bob-box')
  upsertConversation(s.db, { id: 'work', ownerUserId: alice.id, title: 'Garden Club', agentDeviceId: aliceBox.deviceId })
  upsertConversation(s.db, { id: 'room', ownerUserId: alice.id, title: 'Launch chat', agentDeviceId: aliceBox.deviceId })
  upsertConversation(s.db, { id: 'coord', ownerUserId: alice.id, title: 'Coordinator', agentDeviceId: aliceCoord.deviceId })
  upsertConversation(s.db, { id: 'bobwork', ownerUserId: bob.id, title: 'Bob Q3', agentDeviceId: bobBox.deviceId })
  upsertConversation(s.db, { id: 'bobother', ownerUserId: bob.id, title: 'Bob private stuff', agentDeviceId: bobBox.deviceId })
  const login = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw', device_name: `${name}-phone` } })).json.token
  const alicePhone = await login('alice')
  const bobPhone = await login('bob')
  assert.equal((await s.http('/coordinator', { method: 'PUT', token: alicePhone, body: { convo_id: 'coord' } })).status, 200)
  const sockets = {}
  for (const [k, token] of Object.entries({ alicePhone, bobPhone, aliceBox: aliceBox.token, aliceCoord: aliceCoord.token, bobBox: bobBox.token })) {
    sockets[k] = await makeWsClient(s.base, { token, cursor: null })
    await sockets[k].waitFor((f) => f.op === 'hello_ok')
  }
  t.after(() => { for (const w of Object.values(sockets)) { try { w.close() } catch { /* already closed */ } } })
  const http = (token) => (path, opts = {}) => s.http(path, { token, ...opts })
  return {
    s, alice, bob, ws: sockets, aliceBoxId: aliceBox.deviceId, bobBoxId: bobBox.deviceId,
    aliceBox: http(aliceBox.token), aliceCoord: http(aliceCoord.token), bobBox: http(bobBox.token),
    alicePhone: http(alicePhone), bobPhone: http(bobPhone),
  }
}

async function makeContacts(w) {
  const r = await w.alicePhone('/contacts', post({ user: 'bob' }))
  assert.equal(r.status, 201)
  const bobSide = (await w.bobPhone('/contacts')).json.contacts[0]
  assert.equal((await w.bobPhone(`/contacts/${bobSide.id}/answer`, post({ decision: 'approve' }))).status, 200)
  return { aliceContact: r.json.contact.id, bobContact: bobSide.id }
}

const consentItems = async (phone, consent) => (await phone('/items?label=consent')).json.items.filter((i) => i.consent === consent && i.state === 'open')

// Bob's agent shares its session with alice; Bob taps Approve.
async function shareTimSession(w, convoId = 'bobwork') {
  const ask = await w.bobBox('/session-shares', post({ convo_id: convoId, contact: 'alice' }))
  assert.equal(ask.status, 202)
  assert.equal(ask.json.session_share.state, 'awaiting_user')
  const [mirror] = await consentItems(w.bobPhone, 'session')
  assert.ok(mirror, 'bob has an Approve item')
  const tap = await w.bobPhone(`/items/${mirror.id}/comments`, post({ action: 'Approve' }))
  assert.equal(tap.status, 200)
  assert.equal(tap.json.session_share.state, 'active')
  return ask.json.session_share.id
}

function invite(w, extra = {}) {
  // The owner agent opens a room with its first message, as agent_chat_start does.
  if (!w.opened) { w.opened = true; w.ws.aliceBox.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'Opening: shall we talk Q3?', from: 'agent' } }) }
  w.ws.aliceBox.send({ op: 'agent_invite', room_id: 'room', target_device_id: w.bobBoxId, target_convo_id: 'bobwork', topic: 'Launch', justification: 'Talk through the Q3 hand-over', from_convo_id: 'room', ...extra })
}

// The whole consent chain to a joined room. Returns the twin's id.
async function openRoom(w, extra = {}) {
  invite(w, extra)
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await settle()
  const [own] = await consentItems(w.alicePhone, 'room')
  assert.ok(own, 'alice has an Approve item')
  assert.equal((await w.alicePhone(`/items/${own.id}/comments`, post({ action: 'Approve' }))).status, 200)
  await settle()
  const [theirs] = await consentItems(w.bobPhone, 'room')
  assert.ok(theirs, 'bob has an Accept item')
  const accepted = await w.bobPhone(`/items/${theirs.id}/comments`, post({ action: 'Accept' }))
  assert.equal(accepted.status, 200)
  const req = await w.ws.bobBox.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  w.ws.bobBox.send({ op: 'agent_invite_answer', room_id: req.room_id, accept: true })
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'answer' && f.room_id === 'room')
  return req.room_id
}

test('a session is on a contact\'s roster only once its owner shares it, and never with its box name', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  assert.deepEqual((await w.aliceBox('/roster')).json.people, [])
  await shareTimSession(w)
  const roster = (await w.aliceBox('/roster')).json
  assert.equal(roster.people.length, 1)
  assert.equal(roster.people[0].person, 'bob')
  assert.deepEqual(roster.people[0].sessions.map((s) => s.convo_id), ['bobwork'], 'only the shared session')
  assert.equal(roster.people[0].sessions[0].agent_device_id, w.bobBoxId)
  assert.ok(!JSON.stringify(roster.people).includes('bob-box'), 'the box name never crosses')
  // Bob's own roster is unchanged by it; the share is listed for him.
  assert.deepEqual((await w.bobBox('/roster')).json.people, [])
  assert.equal((await w.bobBox('/session-shares')).json.session_shares[0].contact, 'alice')
})

test('session shares: only a contact, only one\'s own session, and an agent cannot approve its own ask', async (t) => {
  const w = await world(t)
  assert.equal((await w.bobBox('/session-shares', post({ convo_id: 'bobwork', contact: 'alice' }))).status, 409, 'not a contact yet')
  await makeContacts(w)
  assert.equal((await w.bobBox('/session-shares', post({ convo_id: 'work', contact: 'alice' }))).status, 404, 'alice\'s session is not bob\'s to share')
  const ask = await w.bobBox('/session-shares', post({ convo_id: 'bobwork', contact: 'alice' }))
  assert.equal(ask.status, 202)
  assert.equal((await w.bobBox(`/session-shares/${ask.json.session_share.id}/answer`, post({ decision: 'approve' }))).status, 403)
  assert.deepEqual((await w.aliceBox('/roster')).json.people, [], 'still parked')
  // A client's share is the tap itself.
  const direct = await w.bobPhone('/session-shares', post({ convo_id: 'bobother', contact: 'alice' }))
  assert.equal(direct.status, 201)
  assert.equal(direct.json.session_share.state, 'active')
  // Either side of the sharer may stop sharing.
  assert.equal((await w.bobBox(`/session-shares/${direct.json.session_share.id}`, { method: 'DELETE' })).status, 200)
  assert.deepEqual((await w.aliceBox('/roster')).json.people, [])
})

test('a room between two people: both consent, the twin is created, and messages cross as person: copies', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  await shareTimSession(w)
  invite(w)
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await settle()

  // Alice's card sits in the room; no agent, the Coordinator included, sees it
  // or can list it.
  const aliceCard = w.ws.alicePhone.journal().find((f) => f.type === 'permission_request' && f.payload.kind === 'person_room')
  assert.equal(aliceCard.convo_id, 'room')
  assert.equal(aliceCard.payload.direction, 'out')
  assert.equal(aliceCard.payload.person.name, 'bob')
  assert.equal(aliceCard.payload.session_title, 'Bob Q3')
  for (const k of ['aliceBox', 'aliceCoord', 'bobBox']) {
    assert.equal(w.ws[k].journal().filter((f) => f.payload?.kind === 'person_room').length, 0, `${k} never sees the card`)
  }
  assert.deepEqual((await w.aliceCoord('/consent/pending')).json.chats ?? [], [], 'not in the Coordinator\'s queue')
  const [own] = await consentItems(w.alicePhone, 'room')
  assert.equal((await w.aliceCoord(`/items/${own.id}/comments`, post({ action: 'Approve' }))).status, 404, 'an agent cannot see the mirror, let alone tap it')
  const link = (await w.alicePhone('/person-rooms')).json.person_rooms[0]
  assert.equal(link.state, 'awaiting_owner')
  assert.equal((await w.aliceCoord(`/person-rooms/${link.id}/answer`, post({ decision: 'approve' }))).status, 403)
  // Nothing has reached Bob yet.
  assert.deepEqual((await w.bobPhone('/person-rooms')).json.person_rooms, [])
  assert.equal(w.ws.bobPhone.journal().filter((f) => f.payload?.kind === 'person_room').length, 0)

  assert.equal((await w.alicePhone(`/items/${own.id}/comments`, post({ action: 'Approve' }))).status, 200)
  await settle()
  const bobCard = w.ws.bobPhone.journal().find((f) => f.type === 'permission_request' && f.payload.kind === 'person_room')
  assert.equal(bobCard.payload.direction, 'in')
  assert.equal(bobCard.payload.person.name, 'alice')
  assert.ok(!JSON.stringify(bobCard).includes('alice-box'), 'alice\'s box name does not cross')
  assert.equal(w.ws.bobBox.frames.filter((f) => f.kind === 'invite').length, 0, 'bob\'s agent hears nothing before bob accepts')
  const [theirs] = await consentItems(w.bobPhone, 'room')
  assert.equal((await w.bobBox(`/person-rooms/${link.id}/answer`, post({ decision: 'accept' }))).status, 403)
  assert.equal((await w.bobPhone(`/items/${theirs.id}/comments`, post({ action: 'Accept' }))).status, 200)

  // Bob's agent is invited into the twin, named by person, never by box.
  const req = await w.ws.bobBox.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  const twin = req.room_id
  assert.notEqual(twin, 'room')
  assert.equal(req.from_name, 'alice')
  assert.deepEqual(req.person, { name: 'alice' })
  assert.equal(req.target_convo_id, 'bobwork')
  assert.ok(!JSON.stringify(req).includes('alice-box'))
  // The opening message is already in the twin when the invite lands.
  const opening = (await w.bobPhone(`/convo/${twin}/messages?limit=10`)).json
  assert.deepEqual((opening.messages ?? opening.events ?? []).filter((e) => e.type === 'text').map((e) => `${e.sender}|${e.payload.body}`), ['person:alice|Opening: shall we talk Q3?'])
  w.ws.bobBox.send({ op: 'agent_invite_ack', room_id: twin, session_state: 'idle' })
  const ack = await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'ack')
  assert.equal(ack.room_id, 'room')
  w.ws.bobBox.send({ op: 'agent_invite_answer', room_id: twin, accept: true })
  const answer = await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'answer' && f.room_id === 'room')
  assert.equal(answer.accept, true)
  assert.equal(answer.peer_device_id, w.bobBoxId)
  assert.deepEqual(answer.person, { name: 'bob' })

  // Each side's view of the link: the other person, and its own room id.
  assert.deepEqual((({ role, person, room_id: r, state }) => ({ role, person, r, state }))((await w.aliceBox('/person-rooms?room_id=room')).json.person_room),
    { role: 'owner', person: 'bob', r: 'room', state: 'joined' })
  assert.deepEqual((({ role, person, room_id: r, state }) => ({ role, person, r, state }))((await w.bobBox(`/person-rooms?room_id=${twin}`)).json.person_room),
    { role: 'guest', person: 'alice', r: twin, state: 'joined' })
  assert.equal((await w.aliceCoord('/person-rooms?room_id=room')).status, 404, 'an agent not in the room learns nothing')
  assert.equal((await w.bobBox('/person-rooms?room_id=room')).status, 404)
  assert.ok(!(await w.bobBox('/roster')).json.conversations.some((c) => c.id === twin), 'the twin is no session to target')

  // Alice's agent speaks: Bob's agent and phone get a person:alice copy in the twin.
  w.ws.aliceBox.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'Hi Bob, here is the plan', from: 'agent' } })
  const atTim = await w.ws.bobBox.waitFor((f) => f.kind === 'journal' && f.convo_id === twin && f.type === 'text')
  assert.equal(atTim.sender, 'person:alice')
  assert.deepEqual(atTim.payload, { body: 'Hi Bob, here is the plan', person: { name: 'alice' }, via: 'agent' })
  await w.ws.bobPhone.waitFor((f) => f.kind === 'journal' && f.convo_id === twin && f.sender === 'person:alice')
  // Bob's agent answers, and Bob types too: both reach Alice as person:bob.
  w.ws.bobBox.send({ op: 'publish', convo_id: twin, type: 'text', payload: { body: 'Sounds good', from: 'agent' } })
  const atDan = await w.ws.aliceBox.waitFor((f) => f.kind === 'journal' && f.convo_id === 'room' && f.sender === 'person:bob')
  assert.equal(atDan.payload.via, 'agent')
  w.ws.bobPhone.send({ op: 'send', convo_id: twin, type: 'text', payload: { body: 'Bob here myself' } })
  const typed = await w.ws.aliceBox.waitFor((f) => f.kind === 'journal' && f.sender === 'person:bob' && f.payload.body === 'Bob here myself')
  assert.equal(typed.payload.via, 'user')
  await settle()
  // A copy is never copied back.
  assert.equal(w.ws.aliceBox.journal().filter((f) => f.sender === 'person:alice').length, 0)
  assert.equal(w.ws.bobBox.journal().filter((f) => f.sender === 'person:bob').length, 0)
  // Each log holds its own copy: alice's room has her message and bob's two.
  const aliceLog = (await w.alicePhone('/convo/room/messages?limit=50')).json
  const bodies = (aliceLog.messages ?? aliceLog.events ?? []).filter((e) => e.type === 'text').map((e) => `${e.sender}|${e.payload.body}`)
  assert.deepEqual(bodies, ['agent:alice-box|Opening: shall we talk Q3?', 'agent:alice-box|Hi Bob, here is the plan', 'person:bob|Sounds good', 'person:bob|Bob here myself'])

  // Files do not cross.
  w.ws.aliceBox.send({ op: 'publish', convo_id: 'room', type: 'image', payload: { blob_ref: 'b1', name: 'x.png' }, blob_ref: 'b1' })
  const err = await w.ws.aliceBox.waitFor((f) => f.op === 'error' && f.ref === 'publish')
  assert.equal(err.code, 'bad_request')
})

test('a person room holds exactly the two agents: no further invite or join on either side', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  await shareTimSession(w)
  const twin = await openRoom(w)
  const aliceOther = createAgent(w.s.db, w.alice.id, 'alice-other')
  const other = await makeWsClient(w.s.base, { token: aliceOther.token, cursor: null })
  t.after(() => other.close())
  await other.waitFor((f) => f.op === 'hello_ok')
  w.ws.aliceBox.send({ op: 'agent_invite', room_id: 'room', target_device_id: aliceOther.deviceId, justification: 'join us' })
  const e1 = await w.ws.aliceBox.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite')
  assert.equal(e1.code, 'conflict')
  other.send({ op: 'agent_join', room_id: 'room', justification: 'let me in' })
  const e2 = await other.waitFor((f) => f.op === 'error' && f.ref === 'agent_join')
  assert.equal(e2.code, 'conflict')
  // Bob's side: the twin is owned by alice's agent, so bob's agents cannot
  // invite into it, and a second bob agent cannot join it.
  const bobOther = createAgent(w.s.db, w.bob.id, 'bob-other')
  const tOther = await makeWsClient(w.s.base, { token: bobOther.token, cursor: null })
  t.after(() => tOther.close())
  await tOther.waitFor((f) => f.op === 'hello_ok')
  tOther.send({ op: 'agent_join', room_id: twin, justification: 'me too' })
  const e3 = await tOther.waitFor((f) => f.op === 'error' && f.ref === 'agent_join')
  assert.equal(e3.code, 'conflict')
})

test('an invite reaches only a session shared with the inviter, of an active contact; refusals look alike', async (t) => {
  const w = await world(t)
  invite(w)
  const notContact = await w.ws.aliceBox.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite')
  assert.equal(notContact.code, 'not_found')
  await makeContacts(w)
  w.ws.aliceBox.frames.length = 0
  invite(w)
  const notShared = await w.ws.aliceBox.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite')
  assert.equal(notShared.code, 'not_found')
  await shareTimSession(w)
  w.ws.aliceBox.frames.length = 0
  invite(w, { target_convo_id: 'bobother' })
  const otherSession = await w.ws.aliceBox.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite')
  assert.equal(otherSession.code, 'not_found', 'a session bob did not share')
  assert.deepEqual(notContact.detail, otherSession.detail)
  // A mission must be shared with bob before a room can be attached to it.
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch' }))).json.mission
  w.ws.aliceBox.frames.length = 0
  invite(w, { mission: m.num })
  const unshared = await w.ws.aliceBox.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite')
  assert.equal(unshared.code, 'conflict')
})

test('a room attached to a shared mission names it to both sides, and loses it when the share ends', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  await shareTimSession(w)
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch' }))).json.mission
  const share = await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'read' }))
  assert.equal(share.status, 201)
  const grantId = share.json.grant.id
  assert.equal((await w.bobPhone(`/grants/${grantId}/answer`, post({ decision: 'approve' }))).status, 200)
  const twin = await openRoom(w, { mission: m.num })
  const own = (await w.aliceBox('/person-rooms?room_id=room')).json.person_room
  assert.equal(own.mission.num, m.num)
  const guest = (await w.bobBox(`/person-rooms?room_id=${twin}`)).json.person_room
  assert.equal(guest.mission.id, m.id)
  assert.equal(guest.mission.owner, 'alice')
  assert.equal((await w.alicePhone(`/grants/${grantId}`, { method: 'DELETE' })).status, 200)
  assert.equal((await w.aliceBox('/person-rooms?room_id=room')).json.person_room.mission, null)
  assert.equal((await w.aliceBox('/person-rooms?room_id=room')).json.person_room.state, 'joined', 'the room itself stands')
})

test('bob declining tells alice\'s agent no, as a refusal', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  await shareTimSession(w)
  invite(w)
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await settle()
  const [own] = await consentItems(w.alicePhone, 'room')
  await w.alicePhone(`/items/${own.id}/comments`, post({ action: 'Approve' }))
  await settle()
  const [theirs] = await consentItems(w.bobPhone, 'room')
  assert.equal((await w.bobPhone(`/items/${theirs.id}/comments`, post({ action: 'Decline' }))).status, 200)
  const no = await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  assert.equal(no.accept, false)
  assert.equal(no.reason, 'refused')
  assert.equal(w.ws.bobBox.frames.filter((f) => f.kind === 'invite').length, 0)
})

test('alice declining her own agent\'s ask sends nothing to bob', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  await shareTimSession(w)
  invite(w)
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await settle()
  const [own] = await consentItems(w.alicePhone, 'room')
  await w.alicePhone(`/items/${own.id}/comments`, post({ action: 'Decline' }))
  const no = await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  assert.equal(no.accept, false)
  await settle()
  assert.deepEqual(await consentItems(w.bobPhone, 'room'), [])
  assert.deepEqual((await w.bobPhone('/person-rooms')).json.person_rooms, [])
})

test('removing the contact ends the room on both sides and stops the copies', async (t) => {
  const w = await world(t)
  const { aliceContact } = await makeContacts(w)
  await shareTimSession(w)
  const twin = await openRoom(w)
  assert.equal((await w.alicePhone(`/contacts/${aliceContact}`, { method: 'DELETE' })).status, 200)
  const leftDan = await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'left' && f.room_id === 'room')
  assert.equal(leftDan.from_device_id, w.bobBoxId)
  await w.ws.bobBox.waitFor((f) => f.kind === 'invite' && f.event === 'left' && f.room_id === twin)
  assert.deepEqual((await w.aliceBox('/roster')).json.people, [], 'the session share ended too')
  w.ws.aliceBox.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'still there?' } })
  await settle(250)
  assert.equal(w.ws.bobBox.journal().filter((f) => f.payload?.body === 'still there?').length, 0)
})

test('either agent leaving ends the room for the other', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  await shareTimSession(w)
  const twin = await openRoom(w)
  w.ws.bobBox.send({ op: 'agent_leave', room_id: twin })
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'left' && f.room_id === 'room')
  assert.equal((await w.aliceBox('/person-rooms?room_id=room')).status, 404, 'no live link any more')
})

test('the owner agent leaving dissolves the twin too', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  await shareTimSession(w)
  const twin = await openRoom(w)
  w.ws.aliceBox.send({ op: 'agent_leave', room_id: 'room' })
  await w.ws.bobBox.waitFor((f) => f.kind === 'invite' && f.event === 'left' && f.room_id === twin)
  w.ws.bobBox.send({ op: 'publish', convo_id: twin, type: 'text', payload: { body: 'hello?' } })
  const e = await w.ws.bobBox.waitFor((f) => f.op === 'error' && f.ref === 'publish')
  assert.equal(e.code, 'forbidden', 'no longer a participant of the twin')
})

test('a retry of an ask in flight is pending; a re-ask after a decline renews it', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  await shareTimSession(w)
  invite(w)
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await settle()
  // The ask's own consent mirror sits in the room now: a retry is pending,
  // not a room with history.
  invite(w)
  const retry = await w.ws.aliceBox.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite')
  assert.equal(retry.code, 'conflict')
  assert.match(retry.detail, /awaiting_user/)
  const [own] = await consentItems(w.alicePhone, 'room')
  await w.alicePhone(`/items/${own.id}/comments`, post({ action: 'Decline' }))
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  const rows = () => w.s.db.prepare("SELECT id, state FROM person_rooms WHERE owner_room_id='room'").all()
  const [first] = rows()
  assert.equal(first.state, 'declined')
  w.ws.aliceBox.frames.length = 0
  invite(w)
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  assert.deepEqual(rows(), [{ id: first.id, state: 'awaiting_owner' }])
})

test('a person room must be a fresh room: never a conversation with a history of its own', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  await shareTimSession(w)
  // Alice's own session conversation, with her typing in it.
  w.ws.alicePhone.send({ op: 'send', convo_id: 'work', type: 'text', payload: { body: 'my private notes' } })
  await settle()
  w.ws.aliceBox.send({ op: 'agent_invite', room_id: 'work', target_device_id: w.bobBoxId, target_convo_id: 'bobwork', justification: 'x' })
  const e = await w.ws.aliceBox.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite')
  assert.equal(e.code, 'conflict')
  assert.match(e.detail, /new room/)
  // A room that already had a twin is not re-used: its old twin stays a twin.
  const twin = await openRoom(w)
  w.ws.bobBox.send({ op: 'agent_leave', room_id: twin })
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'left')
  w.ws.aliceBox.frames.length = 0
  w.ws.aliceBox.send({ op: 'agent_invite', room_id: 'room', target_device_id: w.bobBoxId, target_convo_id: 'bobwork', justification: 'again' })
  const again = await w.ws.aliceBox.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite')
  assert.equal(again.code, 'conflict')
  assert.ok(!(await w.bobBox('/roster')).json.conversations.some((c) => c.id === twin), 'the old twin is still no session')
})

test('the list of rooms and asks is the person\'s: agents, the Coordinator included, get 403', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  await shareTimSession(w)
  invite(w)
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  const link = (await w.alicePhone('/person-rooms')).json.person_rooms[0]
  for (const agent of [w.aliceBox, w.aliceCoord, w.bobBox]) {
    assert.equal((await agent('/person-rooms')).status, 403)
    assert.equal((await agent(`/person-rooms/${link.id}`)).status, 403)
  }
})

test('a room made the way agent_chat_start makes it parks the ask at a shared session, with the card and its item', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  await shareTimSession(w)
  w.ws.aliceBox.send({ op: 'convo_upsert', convo_id: 'made', title: 'A:2c ↔️ 👤 bob — Launch', session_state: 'waiting' })
  w.ws.aliceBox.send({ op: 'publish', convo_id: 'made', type: 'text', payload: { body: 'Opening', from: 'agent' } })
  w.ws.aliceBox.send({ op: 'agent_invite', room_id: 'made', target_device_id: w.bobBoxId, target_convo_id: 'bobwork', topic: 'Launch', justification: 'Talk it through', from_convo_id: 'work' })
  const reply = await w.ws.aliceBox.waitFor((f) => (f.kind === 'invite' && f.event === 'delivered') || (f.op === 'error' && f.ref === 'agent_invite'))
  assert.equal(reply.event, 'delivered', JSON.stringify(reply))
  await settle()
  const card = w.ws.alicePhone.journal().find((f) => f.type === 'permission_request' && f.payload.kind === 'person_room')
  assert.equal(card.convo_id, 'made')
  assert.equal((await consentItems(w.alicePhone, 'room')).length, 1)
})

test('the fresh-room check reads the room through idx_events_convo, not the whole log', () => {
  const db = openDb(':memory:')
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${FRESH_ROOM_SQL}`).all({ u: 1, r: 'room', s: 'agent:a' }).map((r) => r.detail).join(' | ')
  assert.match(plan, /idx_events_convo/, plan)
  db.close()
})
