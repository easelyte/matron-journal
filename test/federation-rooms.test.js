import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { makeWsClient } from './helpers.js'
import { world, post } from './federation-world.js'

// Rooms across journals (phase 5 stage 12a), end to end between two journals
// on loopback: alice's agent on a.example asks to talk with her contact
// bob@b.example; alice taps Send, bob chooses where his side talks, and the
// two agents talk through their journals.
async function rooms(t, opts = {}) {
  const w = await world(t, opts)
  const aliceBox = createAgent(w.a.db, w.users.alice.id, 'alice-chat')
  const bobBox = createAgent(w.b.db, w.users.bob.id, 'bob-box')
  upsertConversation(w.a.db, { id: 'room', ownerUserId: w.users.alice.id, title: 'Cover chat', agentDeviceId: aliceBox.deviceId })
  upsertConversation(w.b.db, { id: 'bobwork', ownerUserId: w.users.bob.id, title: 'Bob Q3', agentDeviceId: bobBox.deviceId })
  w.b.db.prepare("UPDATE conversations SET last_seq=5 WHERE id='bobwork'").run()
  w.ws = {
    alice: await makeWsClient(w.a.base, { token: aliceBox.token, cursor: null }),
    bob: await makeWsClient(w.b.base, { token: bobBox.token, cursor: null }),
  }
  for (const s of Object.values(w.ws)) await s.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { for (const s of Object.values(w.ws)) { try { s.close() } catch { /* closed */ } } })
  w.aliceChat = (path, opts = {}) => w.a.http(path, { token: aliceBox.token, ...opts })
  w.bobChat = (path, opts = {}) => w.b.http(path, { token: bobBox.token, ...opts })
  return w
}
const roomItem = async (phone) => (await phone('/items?label=consent')).json.items.find((i) => i.consent === 'room' && i.state === 'open')
const half = (s) => s.db.prepare('SELECT * FROM fed_rooms ORDER BY created_at DESC LIMIT 1').get()
const texts = (s, convoId) => s.db.prepare("SELECT sender, json_extract(payload, '$.body') AS body FROM events WHERE convo_id=? AND type='text' ORDER BY seq").all(convoId)
const tick = () => new Promise((r) => setTimeout(r, 50))

async function askAndSend(w, extra = {}) {
  w.ws.alice.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'Hello bob, about the cover editor', from: 'agent' } })
  w.ws.alice.send({ op: 'agent_invite', room_id: 'room', target_person: 'bob@b.example', topic: 'Cover editor', justification: 'Compare notes on the cover editor', from_convo_id: 'room', ...extra })
  const delivered = await w.ws.alice.waitFor((f) => (f.kind === 'invite' && f.event === 'delivered') || (f.op === 'error' && f.ref === 'agent_invite'))
  assert.equal(delivered.event, 'delivered', JSON.stringify(delivered))
  await tick()
  const own = await roomItem(w.phones.alice)
  assert.deepEqual(own.actions, ['Send', 'Cancel'])
  assert.equal((await w.phones.alice(`/items/${own.id}/comments`, post({ action: 'Send' }))).status, 200)
  await w.settle()
  return own
}

// bob picks his session; his agent accepts the invite.
async function bobJoins(w) {
  const card = await roomItem(w.phones.bob)
  assert.ok(card, 'bob has the talk card')
  const pick = await w.phones.bob(`/items/${card.id}/comments`, post({ action: 'Pick a session' }))
  assert.equal(pick.status, 200, JSON.stringify(pick.json))
  assert.deepEqual(pick.json.comment.actions, ['Bob Q3', 'Decline'])
  const chose = await w.phones.bob(`/items/${card.id}/comments`, post({ action: 'Bob Q3', reply_to: pick.json.comment.id }))
  assert.equal(chose.status, 200, JSON.stringify(chose.json))
  const req = await w.ws.bob.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  w.ws.bob.send({ op: 'agent_invite_answer', room_id: req.room_id, accept: true })
  await tick()
  await w.settle()
  return { card, req }
}

test('a talk across journals: Send, the guest picks a session, and the agents talk both ways', async (t) => {
  const w = await rooms(t)
  const own = await askAndSend(w)
  assert.match(own.title, /^Ask bob@b\.example to talk — Cover editor/)
  assert.equal(half(w.a).state, 'awaiting_guest')

  const g = half(w.b)
  assert.deepEqual([g.role, g.state, g.peer_name, g.peer_host, g.ref], ['guest', 'awaiting_guest', 'alice', 'a.example', half(w.a).id])
  const card = await roomItem(w.phones.bob)
  assert.equal(card.title, "alice@a.example's agent wants to talk — Cover editor")
  assert.deepEqual(card.actions, ['Pick a session', 'Decline'])

  const { req } = await bobJoins(w)
  assert.deepEqual(req.person, { name: 'alice@a.example' })
  assert.equal(req.from_name, 'alice@a.example')
  assert.equal(req.target_convo_id, 'bobwork')
  const answer = await w.ws.alice.waitFor((f) => f.kind === 'invite' && f.event === 'answer' && f.room_id === 'room')
  assert.equal(answer.accept, true)
  assert.deepEqual([half(w.a).state, half(w.b).state], ['joined', 'joined'])

  // What alice's room said before bob accepted is in his room first.
  const twin = half(w.b).room_id
  assert.deepEqual(texts(w.b, twin), [{ sender: 'person:alice@a.example', body: 'Hello bob, about the cover editor' }])

  // Both ways, under person:<address>.
  w.ws.bob.send({ op: 'publish', convo_id: twin, type: 'text', payload: { body: 'Hi alice.\nHere are my notes.', from: 'agent' } })
  await tick()
  await w.settle()
  const inA = texts(w.a, 'room').at(-1)
  assert.deepEqual(inA, { sender: 'person:bob@b.example', body: 'Hi alice.\nHere are my notes.' })
  const frame = await w.ws.alice.waitFor((f) => f.kind === 'journal' && f.sender === 'person:bob@b.example')
  assert.equal(frame.convo_id, 'room')
  w.ws.alice.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'Thanks', from: 'agent' } })
  await tick()
  await w.settle()
  assert.deepEqual(texts(w.b, twin).at(-1), { sender: 'person:alice@a.example', body: 'Thanks' })

  // The session a bridge stamps on its own message (payload.from_session) stays in the
  // sender's journal: it is stored and replayed there, and the copy that crosses to the
  // other person carries only the body (a convo id or title never leaves).
  w.ws.alice.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'Stamped', from: 'agent', from_session: { convo_id: 'sess-1', title: 'Fix the build' } } })
  await tick()
  await w.settle()
  const stampedOwn = JSON.parse(w.a.db.prepare("SELECT payload FROM events WHERE convo_id='room' AND type='text' AND json_extract(payload, '$.body')='Stamped'").get().payload)
  assert.deepEqual(stampedOwn.from_session, { convo_id: 'sess-1', title: 'Fix the build' })
  const stampedFar = JSON.parse(w.b.db.prepare("SELECT payload FROM events WHERE convo_id=? AND type='text' AND json_extract(payload, '$.body')='Stamped'").get(twin).payload)
  assert.deepEqual(Object.keys(stampedFar).sort(), ['body', 'person', 'via'])

  // The bridge's question at a foreign turn: who, and which side.
  const mine = await w.aliceChat('/person-rooms?room_id=room')
  assert.deepEqual([mine.json.person_room.role, mine.json.person_room.person, mine.json.person_room.remote], ['owner', 'bob@b.example', true])
  const theirs = await w.bobChat(`/person-rooms?room_id=${twin}`)
  assert.deepEqual([theirs.json.person_room.role, theirs.json.person_room.person], ['guest', 'alice@a.example'])
  assert.equal((await w.phones.bob('/person-rooms')).json.person_rooms.length, 1)

  // Files do not cross, and the room takes no third agent.
  w.ws.alice.send({ op: 'publish', convo_id: 'room', type: 'image', payload: { blob_ref: 'x' } })
  const err = await w.ws.alice.waitFor((f) => f.op === 'error' && f.ref === 'publish')
  assert.match(err.message ?? err.detail ?? '', /do not cross/)

  // bob's agent leaves: the room ends on both journals.
  w.ws.bob.send({ op: 'agent_leave', room_id: twin })
  await tick()
  await w.settle()
  assert.deepEqual([half(w.a).state, half(w.b).state], ['left', 'left'])
  const left = await w.ws.alice.waitFor((f) => f.kind === 'invite' && f.event === 'left' && f.room_id === 'room')
  assert.deepEqual(left.person, { name: 'bob@b.example' })
})

test('the guest declines: the owner\'s agent hears a refusal, and nothing more crosses', async (t) => {
  const w = await rooms(t)
  await askAndSend(w)
  const card = await roomItem(w.phones.bob)
  assert.equal((await w.phones.bob(`/items/${card.id}/comments`, post({ action: 'Decline' }))).status, 200)
  await w.settle()
  const answer = await w.ws.alice.waitFor((f) => f.kind === 'invite' && f.event === 'answer' && f.room_id === 'room')
  assert.equal(answer.accept, false)
  assert.equal(answer.reason, 'refused')
  assert.deepEqual([half(w.a).state, half(w.b).state], ['refused', 'refused'])
  w.ws.alice.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'Anyone?', from: 'agent' } })
  await tick()
  await w.settle()
  assert.equal(w.a.db.prepare("SELECT COUNT(*) AS n FROM fed_outbox WHERE op='room.message'").get().n, 0)
})

test('Cancel on the owner\'s card sends nothing; an address that is not a contact is not found', async (t) => {
  const w = await rooms(t)
  w.ws.alice.send({ op: 'agent_invite', room_id: 'room', target_person: 'carol@b.example', justification: 'x', from_convo_id: 'room' })
  const nf = await w.ws.alice.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite')
  assert.equal(nf.code, 'not_found')

  w.ws.alice.send({ op: 'agent_invite', room_id: 'room', target_person: 'bob@b.example', justification: 'x', from_convo_id: 'room' })
  await w.ws.alice.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await tick()
  const own = await roomItem(w.phones.alice)
  assert.equal((await w.phones.alice(`/items/${own.id}/comments`, post({ action: 'Cancel' }))).status, 200)
  await w.settle()
  assert.equal(half(w.a).state, 'declined')
  assert.equal(w.b.db.prepare('SELECT COUNT(*) AS n FROM fed_rooms').get().n, 0)
  const answer = await w.ws.alice.waitFor((f) => f.kind === 'invite' && f.event === 'answer' && f.room_id === 'room')
  assert.equal(answer.accept, false)
})

test('removing the contact ends a live room on both journals', async (t) => {
  const w = await rooms(t)
  await askAndSend(w)
  await bobJoins(w)
  assert.deepEqual([half(w.a).state, half(w.b).state], ['joined', 'joined'])
  const contact = (await w.phones.bob('/contacts')).json.contacts.find((c) => c.address === 'alice@a.example' || c.peer?.address === 'alice@a.example') ?? (await w.phones.bob('/contacts')).json.contacts[0]
  assert.equal((await w.phones.bob(`/contacts/${contact.id}`, { method: 'DELETE' })).status, 200)
  await w.settle()
  assert.deepEqual([half(w.a).state, half(w.b).state], ['left', 'left'])
  assert.deepEqual([half(w.a).ended_by, half(w.b).ended_by], ['contact_removed', 'contact_removed'])
})

test('a mission attached to the room: the guest side reads it from its copy', async (t) => {
  const w = await rooms(t)
  const share = await w.phones.alice(`/missions/${w.mission.id}/shares`, post({ contact: 'bob@b.example', level: 'read' }))
  assert.equal(share.status, 201)
  await w.settle()
  const offer = (await w.phones.bob('/items?label=consent')).json.items.find((i) => i.consent === 'share' && i.state === 'open')
  assert.equal((await w.phones.bob(`/items/${offer.id}/comments`, post({ action: 'Accept' }))).status, 200)
  await w.settle()
  await askAndSend(w, { mission: w.mission.num })
  const { req } = await bobJoins(w)
  const row = (await w.bobChat(`/person-rooms?room_id=${req.room_id}`)).json.person_room
  assert.equal(row.mission.title, 'Garden Club')
  assert.equal(row.mission.owner, 'alice@a.example')
  assert.equal(row.mission.level, 'read')
  const copy = (await w.phones.bob('/missions?scope=shared')).json.missions[0]
  assert.equal(row.mission.id, copy.id)
  const ownerRow = (await w.aliceChat('/person-rooms?room_id=room')).json.person_room
  assert.equal(ownerRow.mission.num, w.mission.num)
})

test('a journal that does not take rooms yet: the ask ends with a notice', async (t) => {
  // b.example as it was before rooms across journals: every room op unknown.
  const old = Object.fromEntries(['room.invite', 'room.answer', 'room.message', 'room.end'].map((op) => [op, undefined]))
  const w = await rooms(t, { federationOps: { 'b.example': old } })
  await askAndSend(w)
  assert.equal(half(w.a).state, 'withdrawn')
  const n = w.a.db.prepare("SELECT title, body FROM items WHERE user_id=? AND kind='notice'").all(w.users.alice.id).find((x) => x.title.startsWith('Room with bob@b.example'))
  assert.ok(n, 'alice has a notice')
  assert.match(n.body, /does not take rooms with other journals yet/)
  const answer = await w.ws.alice.waitFor((f) => f.kind === 'invite' && f.event === 'answer' && f.room_id === 'room')
  assert.equal(answer.accept, false)
})

test('New session: bob\'s Coordinator box starts a session for the talk, and it joins', async (t) => {
  const w = await rooms(t)
  const coord = createAgent(w.b.db, w.users.bob.id, 'bob-coord')
  upsertConversation(w.b.db, { id: 'bobcoord', ownerUserId: w.users.bob.id, title: 'Coordinator', agentDeviceId: coord.deviceId })
  assert.equal((await w.phones.bob('/coordinator', { method: 'PUT', body: { convo_id: 'bobcoord' } })).status, 200)
  const coordWs = await makeWsClient(w.b.base, { token: coord.token, cursor: null })
  t.after(() => { try { coordWs.close() } catch { /* closed */ } })
  await coordWs.waitFor((f) => f.op === 'hello_ok')
  await askAndSend(w)
  const card = await roomItem(w.phones.bob)
  assert.deepEqual(card.actions, ['New session', 'My Coordinator', 'Pick a session', 'Decline'])
  const tap = await w.phones.bob(`/items/${card.id}/comments`, post({ action: 'New session' }))
  assert.equal(tap.status, 200, JSON.stringify(tap.json))
  assert.equal(tap.json.person_room.state, 'starting')
  const rpc = await coordWs.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start')
  assert.match(rpc.request.params.prompt, /started for a talk with alice@a\.example, another person, about Cover editor/)
  coordWs.send({ op: 'agent_response', request_id: rpc.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'talk-child' } })
  const req = await coordWs.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  assert.equal(req.target_convo_id, 'talk-child')
  coordWs.send({ op: 'agent_invite_answer', room_id: req.room_id, accept: true })
  await tick()
  await w.settle()
  assert.deepEqual([half(w.a).state, half(w.b).state], ['joined', 'joined'])
  assert.equal(w.b.db.prepare("SELECT title FROM conversations WHERE id='talk-child'").get().title, 'Talk with alice@a.example — Cover editor')
})

test('the owner ending the room from their phone ends it on both journals', async (t) => {
  const w = await rooms(t)
  await askAndSend(w)
  await bobJoins(w)
  const id = half(w.a).id
  const end = await w.phones.alice(`/person-rooms/${id}`, { method: 'DELETE' })
  assert.equal(end.status, 200, JSON.stringify(end.json))
  await w.settle()
  assert.deepEqual([half(w.a).state, half(w.b).state], ['left', 'left'])
  const left = await w.ws.bob.waitFor((f) => f.kind === 'invite' && f.event === 'left')
  assert.deepEqual(left.person, { name: 'alice@a.example' })
  assert.equal(w.b.db.prepare("SELECT state FROM convo_agents WHERE convo_id=?").get(half(w.b).room_id).state, 'left')
})

test('a room holding a talk across journals takes no other person; a cancelled ask leaves the room free', async (t) => {
  const w = await rooms(t)
  const { createUser } = await import('../src/auth.js')
  await createUser(w.a.db, 'carol', 'pw')
  // Cancel: nothing left this journal, so the same room can ask again.
  w.ws.alice.send({ op: 'agent_invite', room_id: 'room', target_person: 'bob@b.example', justification: 'x', from_convo_id: 'room' })
  await w.ws.alice.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await tick()
  const own = await roomItem(w.phones.alice)
  assert.equal((await w.phones.alice(`/items/${own.id}/comments`, post({ action: 'Cancel' }))).status, 200)
  await askAndSend(w)
  assert.equal(w.a.db.prepare("SELECT COUNT(*) AS n FROM fed_rooms WHERE room_id='room'").get().n, 1)
  // Sent: a same-journal talk from this room is refused.
  w.ws.alice.send({ op: 'agent_invite', room_id: 'room', target_person: 'carol', justification: 'y', from_convo_id: 'room' })
  const err = await w.ws.alice.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite')
  assert.equal(err.code, 'conflict')
  assert.match(err.message ?? err.detail ?? '', /room_busy/)
})
