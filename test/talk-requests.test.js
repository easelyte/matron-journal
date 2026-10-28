import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { sweepTalkAsks } from '../src/talk-requests-events.js'
import { TALK_GUEST_TTL_MS } from '../src/talk-requests.js'

// Talk requests (docs/protocol.md "Rooms between people"): alice's agent
// asks to talk with bob, the PERSON. alice taps Send once; bob taps once,
// choosing where his side talks. No session share, nothing on a roster.
// alice has a box; bob has a box with two sessions and a Coordinator box.
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms))
const post = (body) => ({ method: 'POST', body })

async function world(t, opts = {}) {
  const s = await startTestServer(opts)
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const bob = await createUser(s.db, 'bob', 'pw')
  await createUser(s.db, 'carol', 'pw')
  const aliceBox = createAgent(s.db, alice.id, 'alice-box')
  const aliceCoord = createAgent(s.db, alice.id, 'alice-coord')
  const bobBox = createAgent(s.db, bob.id, 'bob-box')
  const bobCoord = createAgent(s.db, bob.id, 'bob-coord')
  upsertConversation(s.db, { id: 'room', ownerUserId: alice.id, title: 'Cover chat', agentDeviceId: aliceBox.deviceId })
  upsertConversation(s.db, { id: 'room2', ownerUserId: alice.id, title: 'Cover chat 2', agentDeviceId: aliceBox.deviceId })
  upsertConversation(s.db, { id: 'coord', ownerUserId: alice.id, title: 'Coordinator', agentDeviceId: aliceCoord.deviceId })
  upsertConversation(s.db, { id: 'bobwork', ownerUserId: bob.id, title: 'Bob Q3', agentDeviceId: bobBox.deviceId })
  upsertConversation(s.db, { id: 'bobother', ownerUserId: bob.id, title: 'Bob garden', agentDeviceId: bobBox.deviceId })
  upsertConversation(s.db, { id: 'bobcoord', ownerUserId: bob.id, title: 'Coordinator', agentDeviceId: bobCoord.deviceId })
  // bobwork is the most recently active of bob's sessions.
  s.db.prepare("UPDATE conversations SET last_seq=5 WHERE id='bobwork'").run()
  s.db.prepare("UPDATE conversations SET last_seq=3 WHERE id='bobother'").run()
  const login = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw', device_name: `${name}-phone` } })).json.token
  const alicePhone = await login('alice')
  const bobPhone = await login('bob')
  assert.equal((await s.http('/coordinator', { method: 'PUT', token: alicePhone, body: { convo_id: 'coord' } })).status, 200)
  assert.equal((await s.http('/coordinator', { method: 'PUT', token: bobPhone, body: { convo_id: 'bobcoord' } })).status, 200)
  const sockets = {}
  for (const [k, token] of Object.entries({ alicePhone, bobPhone, aliceBox: aliceBox.token, aliceCoord: aliceCoord.token, bobBox: bobBox.token, bobCoord: bobCoord.token })) {
    sockets[k] = await makeWsClient(s.base, { token, cursor: null })
    await sockets[k].waitFor((f) => f.op === 'hello_ok')
  }
  t.after(() => { for (const w of Object.values(sockets)) { try { w.close() } catch { /* already closed */ } } })
  const http = (token) => (path, opts = {}) => s.http(path, { token, ...opts })
  return {
    s, alice, bob, ws: sockets, aliceBoxId: aliceBox.deviceId, bobBoxId: bobBox.deviceId, bobCoordId: bobCoord.deviceId,
    aliceBox: http(aliceBox.token), aliceCoord: http(aliceCoord.token), bobBox: http(bobBox.token), bobCoord: http(bobCoord.token),
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

const openItems = async (phone, consent) => (await phone('/items?label=consent')).json.items.filter((i) => i.consent === consent && i.state === 'open')
const talkRow = (w) => w.s.db.prepare("SELECT * FROM person_rooms WHERE kind='talk' ORDER BY created_at DESC LIMIT 1").get()

// alice's agent opens a fresh room with its first message and asks for bob.
async function askTalk(w, extra = {}, room = 'room') {
  w.ws.aliceBox.send({ op: 'publish', convo_id: room, type: 'text', payload: { body: 'Hello bob, about the cover editor', from: 'agent' } })
  w.ws.aliceBox.send({ op: 'agent_invite', room_id: room, target_person: 'bob', topic: 'Cover editor', justification: 'Compare notes on the cover editor', from_convo_id: room, ...extra })
}

async function askAndSend(w) {
  await askTalk(w)
  const delivered = await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await settle()
  const [own] = await openItems(w.alicePhone, 'room')
  const sent = await w.alicePhone(`/items/${own.id}/comments`, post({ action: 'Send' }))
  assert.equal(sent.status, 200)
  await settle()
  return { delivered, own, sent }
}

async function guestItem(w) {
  const [theirs] = await openItems(w.bobPhone, 'room')
  assert.ok(theirs, 'bob has a talk item')
  return theirs
}

// The guest agent receives its invite and accepts; alice's agent hears it.
async function guestJoins(w, socket) {
  const req = await w.ws[socket].waitFor((f) => f.kind === 'invite' && f.event === 'request')
  w.ws[socket].send({ op: 'agent_invite_answer', room_id: req.room_id, accept: true })
  const answer = await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'answer' && f.room_id === 'room')
  assert.equal(answer.accept, true)
  return req
}

function assertNoShareAndNoRoster(w) {
  return (async () => {
    assert.equal(w.s.db.prepare('SELECT COUNT(*) n FROM session_shares').get().n, 0, 'no session share is created')
    assert.deepEqual((await w.aliceBox('/roster')).json.people, [], 'nothing on alice\'s roster')
    assert.deepEqual((await w.bobBox('/roster')).json.people, [], 'nothing on bob\'s roster')
  })()
}

test('talk with an existing contact: one Send, one tap on My Coordinator, and the room opens', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  await askTalk(w)
  const delivered = await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  assert.equal(delivered.room_id, 'room')
  assert.equal(delivered.target_person, 'bob')
  assert.equal(delivered.target_device_id, undefined)
  await settle()

  const card = w.ws.alicePhone.journal().find((f) => f.type === 'permission_request' && f.payload.kind === 'person_room')
  assert.equal(card.convo_id, 'room')
  assert.equal(card.payload.talk, true)
  assert.equal(card.payload.direction, 'out')
  assert.equal(card.payload.contact_pending, false)
  assert.equal(card.payload.session_title, null)
  assert.deepEqual(card.payload.choices, ['Send', 'Cancel'])
  for (const k of ['aliceBox', 'aliceCoord', 'bobBox', 'bobCoord']) {
    assert.equal(w.ws[k].journal().filter((f) => f.payload?.kind === 'person_room').length, 0, `${k} never sees the card`)
  }
  const [own] = await openItems(w.alicePhone, 'room')
  assert.equal(own.title, 'Ask bob to talk — Cover editor')
  assert.deepEqual(own.actions, ['Send', 'Cancel'])
  assert.ok(!own.body.includes('contact request'), 'no contact line between contacts')
  assert.equal(talkRow(w).state, 'awaiting_owner')
  assert.equal(talkRow(w).guest_device_id, null)
  assert.deepEqual(await openItems(w.bobPhone, 'room'), [], 'nothing reaches bob before Send')

  assert.equal((await w.alicePhone(`/items/${own.id}/comments`, post({ action: 'Send' }))).status, 200)
  await settle()
  const bobCard = w.ws.bobPhone.journal().find((f) => f.type === 'permission_request' && f.payload.kind === 'person_room')
  assert.equal(bobCard.payload.talk, true)
  assert.equal(bobCard.payload.direction, 'in')
  assert.equal(bobCard.payload.person.name, 'alice')
  assert.equal(bobCard.payload.contact_pending, false)
  assert.deepEqual(bobCard.payload.choices, ['New session', 'My Coordinator', 'Pick a session', 'Decline'])
  assert.ok(!JSON.stringify(bobCard).includes('alice-box'), 'the box name does not cross')
  const theirs = await guestItem(w)
  assert.equal(theirs.title, 'alice\'s agent wants to talk — Cover editor')
  assert.deepEqual(theirs.actions, ['New session', 'My Coordinator', 'Pick a session', 'Decline'])
  assert.ok(!theirs.body.includes('Accepting also makes alice a contact'))
  assert.equal(w.ws.bobCoord.frames.filter((f) => f.kind === 'invite').length, 0, 'no agent hears of it before bob taps')

  const tap = await w.bobPhone(`/items/${theirs.id}/comments`, post({ action: 'My Coordinator' }))
  assert.equal(tap.status, 200)
  assert.equal(tap.json.person_room.state, 'invited')
  const req = await guestJoins(w, 'bobCoord')
  assert.equal(req.target_convo_id, 'bobcoord')
  assert.deepEqual(req.person, { name: 'alice' })
  const row = talkRow(w)
  assert.equal(row.state, 'joined')
  assert.equal(row.guest_device_id, w.bobCoordId)
  assert.equal(row.guest_convo_id, 'bobcoord')
  // Each side's view names the kind.
  assert.equal((await w.aliceBox('/person-rooms?room_id=room')).json.person_room.kind, 'talk')
  // Messages cross as person: copies, as in any room with another person.
  w.ws.aliceBox.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'Shall we start?', from: 'agent' } })
  const copy = await w.ws.bobCoord.waitFor((f) => f.kind === 'journal' && f.convo_id === req.room_id && f.payload?.body === 'Shall we start?')
  assert.equal(copy.sender, 'person:alice')
  await assertNoShareAndNoRoster(w)
})

test('talk without a contact: Send also sends the contact request, and bob\'s tap makes them contacts (Pick a session)', async (t) => {
  const w = await world(t)
  await askTalk(w)
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await settle()
  const card = w.ws.alicePhone.journal().find((f) => f.type === 'permission_request' && f.payload.kind === 'person_room')
  assert.equal(card.payload.contact_pending, true)
  const [own] = await openItems(w.alicePhone, 'room')
  assert.match(own.body, /This also sends bob a contact request\./)
  assert.deepEqual((await w.alicePhone('/contacts')).json.contacts, [], 'nothing is sent before the tap')

  assert.equal((await w.alicePhone(`/items/${own.id}/comments`, post({ action: 'Send' }))).status, 200)
  await settle()
  // The contact request is recorded (bob's contact list shows it pending),
  // but bob gets no separate contact card: the talk card covers it.
  assert.equal((await w.alicePhone('/contacts')).json.contacts[0].state, 'pending_out')
  const bobContacts = (await w.bobPhone('/contacts')).json.contacts
  assert.equal(bobContacts[0].state, 'pending_in')
  assert.deepEqual(await openItems(w.bobPhone, 'contact'), [], 'no separate contact card')
  assert.equal(w.ws.bobPhone.journal().filter((f) => f.payload?.kind === 'contact_request').length, 0)
  const bobCard = w.ws.bobPhone.journal().find((f) => f.type === 'permission_request' && f.payload.kind === 'person_room')
  assert.equal(bobCard.payload.contact_pending, true)
  const theirs = await guestItem(w)
  assert.match(theirs.body, /Accepting also makes alice a contact/)

  // Pick a session: a follow-up comment offers bob's recent sessions.
  const pick = await w.bobPhone(`/items/${theirs.id}/comments`, post({ action: 'Pick a session' }))
  assert.equal(pick.status, 200)
  const thread = (await w.bobPhone(`/items/${theirs.id}`)).json
  const question = thread.comments.filter((c) => c.actions?.length).at(-1)
  assert.deepEqual(question.actions, ['Bob Q3', 'Bob garden', 'Decline'], 'most recent first; never the Coordinator')
  assert.ok(JSON.parse(talkRow(w).pick_options)['Bob Q3'] === 'bobwork')
  assert.equal((await w.bobPhone(`/items/${theirs.id}`)).json.item.state, 'open', 'still open until bob chooses')
  assert.equal((await w.bobPhone('/contacts')).json.contacts[0].state, 'pending_in', 'picking is not yet accepting')

  const chose = await w.bobPhone(`/items/${theirs.id}/comments`, post({ action: 'Bob Q3', reply_to: question.id }))
  assert.equal(chose.status, 200)
  assert.equal(chose.json.person_room.state, 'invited')
  assert.equal((await w.alicePhone('/contacts')).json.contacts[0].state, 'active')
  assert.equal((await w.bobPhone('/contacts')).json.contacts[0].state, 'active')
  const req = await guestJoins(w, 'bobBox')
  assert.equal(req.target_convo_id, 'bobwork')
  const after = (await w.bobPhone(`/items/${theirs.id}`)).json
  assert.equal(after.item.state, 'closed')
  assert.equal(after.comments.find((c) => c.id === question.id).chosen_action, 'Bob Q3')
  await assertNoShareAndNoRoster(w)
})

test('a crossed contact request: bob had already asked alice, so Send makes them contacts at once', async (t) => {
  const w = await world(t)
  assert.equal((await w.bobPhone('/contacts', post({ user: 'alice' }))).status, 201)
  const [aliceAccept] = await openItems(w.alicePhone, 'contact')
  assert.ok(aliceAccept, 'alice has bob\'s contact request')
  await askAndSend(w)
  assert.equal((await w.alicePhone('/contacts')).json.contacts[0].state, 'active')
  assert.equal((await w.bobPhone('/contacts')).json.contacts[0].state, 'active')
  assert.deepEqual(await openItems(w.alicePhone, 'contact'), [], 'alice\'s accept item is settled by the Send')
  const bobCard = w.ws.bobPhone.journal().find((f) => f.type === 'permission_request' && f.payload.kind === 'person_room')
  assert.equal(bobCard.payload.contact_pending, false)
  const theirs = await guestItem(w)
  assert.ok(!theirs.body.includes('Accepting also makes alice a contact'))
  assert.equal(talkRow(w).contact_by_talk, 0)
})

test('a blocked person: alice sees exactly what she sees when it is sent, bob sees nothing', async (t) => {
  const w = await world(t)
  // bob blocks alice; alice is not told.
  const { bobContact } = await makeContacts(w)
  assert.equal((await w.bobPhone(`/contacts/${bobContact}/block`, post({}))).status, 200)
  w.ws.bobPhone.frames.length = 0
  const { delivered, sent } = await askAndSend(w)
  assert.equal(delivered.target_person, 'bob', 'parked like any other')
  assert.match(sent.json.comment.body, /^Sent — bob has been asked/)
  assert.equal(sent.json.person_room.state, 'awaiting_guest')
  assert.equal((await w.alicePhone('/contacts')).json.contacts[0].state, 'pending_out', 'alice sees her request as sent')
  assert.deepEqual(await openItems(w.bobPhone, 'room'), [])
  assert.deepEqual((await w.bobPhone('/person-rooms')).json.person_rooms, [], 'not listed for bob')
  assert.equal(w.ws.bobPhone.journal().filter((f) => f.type === 'permission_request').length, 0)
  assert.equal(talkRow(w).state, 'awaiting_guest')
  // It expires like any unanswered ask.
  w.s.db.prepare("UPDATE person_rooms SET updated_at=? WHERE kind='talk'").run(Date.now() - TALK_GUEST_TTL_MS - 1000)
  sweepTalkAsks({ db: w.s.db, hub: w.s.hub })
  const no = await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'answer' && f.room_id === 'room')
  assert.equal(no.accept, false)
  assert.equal(talkRow(w).state, 'expired')
})

test('New session: the spawn RPC starts a Claude session on the Coordinator\'s box, which becomes the guest', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  await askAndSend(w)
  const theirs = await guestItem(w)
  const tap = await w.bobPhone(`/items/${theirs.id}/comments`, post({ action: 'New session' }))
  assert.equal(tap.status, 200)
  assert.equal(tap.json.person_room.state, 'starting')
  const rpc = await w.ws.bobCoord.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start')
  assert.equal(rpc.request.from_device_id, 0)
  assert.equal(rpc.request.params.agent, 'claude')
  assert.equal(rpc.request.params.workdir, '')
  assert.equal(rpc.request.params.talk, true, 'the bridge accepts an empty workdir only on a talk spawn')
  assert.equal(rpc.request.params.model, undefined)
  assert.match(rpc.request.params.prompt, /started for a talk with alice, another person, about Cover editor/)
  assert.match(rpc.request.params.prompt, /Their turns are restricted\./)
  // A second tap while it starts is refused.
  assert.equal((await w.bobPhone(`/items/${theirs.id}/comments`, post({ action: 'My Coordinator' }))).status, 409)
  w.ws.bobCoord.send({ op: 'agent_response', request_id: rpc.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'talk-child' } })
  const req = await guestJoins(w, 'bobCoord')
  assert.equal(req.target_convo_id, 'talk-child')
  const row = talkRow(w)
  assert.equal(row.guest_convo_id, 'talk-child')
  assert.equal(row.guest_device_id, w.bobCoordId)
  assert.equal(w.s.db.prepare("SELECT title FROM conversations WHERE id='talk-child'").get().title, 'Talk with alice — Cover editor')
  assert.equal((await w.bobPhone(`/items/${theirs.id}`)).json.item.state, 'closed')
  await assertNoShareAndNoRoster(w)
})

test('New session that fails to start: bob is told why and offered the other choices', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  await askAndSend(w)
  const theirs = await guestItem(w)
  assert.equal((await w.bobPhone(`/items/${theirs.id}/comments`, post({ action: 'New session' }))).status, 200)
  const rpc = await w.ws.bobCoord.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start')
  w.ws.bobCoord.send({ op: 'agent_response', request_id: rpc.request.request_id, to_device_id: 0, ok: false, error: { code: 'bad_workdir' } })
  await settle(200)
  assert.equal(talkRow(w).state, 'awaiting_guest')
  const thread = (await w.bobPhone(`/items/${theirs.id}`)).json
  assert.equal(thread.item.state, 'open')
  const retry = thread.comments.filter((c) => c.actions?.length).at(-1)
  assert.equal(retry.body, 'Couldn\'t start a session: bad_workdir. Pick another option.')
  assert.deepEqual(retry.actions, ['My Coordinator', 'Pick a session', 'Decline'])
  assert.equal(w.ws.aliceBox.frames.filter((f) => f.kind === 'invite' && f.event === 'answer').length, 0, 'alice\'s agent is still waiting')
  const chose = await w.bobPhone(`/items/${theirs.id}/comments`, post({ action: 'My Coordinator', reply_to: retry.id }))
  assert.equal(chose.status, 200)
  const req = await guestJoins(w, 'bobCoord')
  assert.equal(req.target_convo_id, 'bobcoord')
})

test('bob declining refuses alice\'s agent and declines the contact request the talk made', async (t) => {
  const w = await world(t)
  await askAndSend(w)
  assert.equal(talkRow(w).contact_by_talk, 1)
  const theirs = await guestItem(w)
  const no = await w.bobPhone(`/items/${theirs.id}/comments`, post({ action: 'Decline' }))
  assert.equal(no.status, 200)
  assert.equal(no.json.person_room.state, 'refused')
  const answer = await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  assert.equal(answer.accept, false)
  assert.equal(answer.reason, 'refused')
  assert.equal(w.s.db.prepare("SELECT state FROM contacts WHERE peer_user='bob'").get().state, 'declined')
  assert.equal(w.s.db.prepare("SELECT state FROM contacts WHERE peer_user='alice'").get().state, 'declined')
  assert.equal(w.ws.bobBox.frames.filter((f) => f.kind === 'invite').length + w.ws.bobCoord.frames.filter((f) => f.kind === 'invite').length, 0)
})

test('alice cancelling sends nothing to bob, not even the contact request', async (t) => {
  const w = await world(t)
  await askTalk(w)
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await settle()
  const [own] = await openItems(w.alicePhone, 'room')
  assert.equal((await w.alicePhone(`/items/${own.id}/comments`, post({ action: 'Cancel' }))).status, 200)
  const no = await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  assert.equal(no.accept, false)
  assert.deepEqual((await w.bobPhone('/contacts')).json.contacts, [])
  assert.deepEqual(await openItems(w.bobPhone, 'room'), [])
})

test('expiry: alice\'s Send waits 24 h; bob\'s card waits 7 days', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  await askTalk(w)
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await settle()
  w.s.db.prepare("UPDATE person_rooms SET updated_at=? WHERE kind='talk'").run(Date.now() - 25 * 3600 * 1000)
  sweepTalkAsks({ db: w.s.db, hub: w.s.hub })
  assert.equal(talkRow(w).state, 'expired')
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  assert.deepEqual(await openItems(w.alicePhone, 'room'), [])

  // A second talk from a fresh room, sent, then unanswered for 7 days.
  w.ws.aliceBox.frames.length = 0
  await askTalk(w, {}, 'room2')
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await settle()
  const [own] = await openItems(w.alicePhone, 'room')
  assert.equal((await w.alicePhone(`/items/${own.id}/comments`, post({ action: 'Send' }))).status, 200)
  await settle()
  const theirs = await guestItem(w)
  w.s.db.prepare("UPDATE person_rooms SET updated_at=? WHERE kind='talk' AND state='awaiting_guest'").run(Date.now() - 6 * 24 * 3600 * 1000)
  sweepTalkAsks({ db: w.s.db, hub: w.s.hub })
  assert.equal(talkRow(w).state, 'awaiting_guest', 'six days is not yet seven')
  w.s.db.prepare("UPDATE person_rooms SET updated_at=? WHERE kind='talk' AND state='awaiting_guest'").run(Date.now() - TALK_GUEST_TTL_MS - 1000)
  sweepTalkAsks({ db: w.s.db, hub: w.s.hub })
  assert.equal(talkRow(w).state, 'expired')
  const no = await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'answer' && f.room_id === 'room2')
  assert.equal(no.accept, false)
  assert.equal((await w.bobPhone(`/items/${theirs.id}`)).json.item.state, 'closed')
})

test('only the person taps: another person, an agent and the Coordinator are all refused', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  await askTalk(w)
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await settle()
  const [own] = await openItems(w.alicePhone, 'room')
  const link = talkRow(w)
  // alice's own ask: her agents cannot see or tap it.
  for (const agent of [w.aliceBox, w.aliceCoord]) {
    assert.equal((await agent(`/items/${own.id}/comments`, post({ action: 'Send' }))).status, 404)
    assert.equal((await agent(`/person-rooms/${link.id}/answer`, post({ decision: 'approve' }))).status, 403)
  }
  assert.equal((await w.bobPhone(`/items/${own.id}/comments`, post({ action: 'Send' }))).status, 404, 'bob cannot tap alice\'s item')
  assert.equal((await w.bobPhone(`/person-rooms/${link.id}/answer`, post({ decision: 'accept' }))).status, 404, 'bob has not been asked yet')
  assert.equal((await w.alicePhone(`/items/${own.id}/comments`, post({ action: 'Send' }))).status, 200)
  await settle()
  const theirs = await guestItem(w)
  for (const agent of [w.bobBox, w.bobCoord]) {
    assert.equal((await agent(`/items/${theirs.id}/comments`, post({ action: 'My Coordinator' }))).status, 404)
    assert.equal((await agent(`/person-rooms/${link.id}/answer`, post({ decision: 'accept', target: 'coordinator' }))).status, 403)
  }
  assert.equal((await w.alicePhone(`/items/${theirs.id}/comments`, post({ action: 'My Coordinator' }))).status, 404, 'alice cannot tap bob\'s item')
  assert.equal((await w.alicePhone(`/person-rooms/${link.id}/answer`, post({ decision: 'accept', target: 'coordinator' }))).status, 409, 'alice answers only her own side')
  assert.equal(talkRow(w).state, 'awaiting_guest')
  // bob's own client may answer over HTTP as well as by the tap.
  const r = await w.bobPhone(`/person-rooms/${link.id}/answer`, post({ decision: 'accept', target: 'coordinator' }))
  assert.equal(r.status, 200)
  assert.equal(r.json.person_room.state, 'invited')
})

test('talk request refusals: unknown, self and blocked look alike; a second live talk is pending', async (t) => {
  const w = await world(t)
  const errorFor = async (extra, room = 'room') => {
    w.ws.aliceBox.frames.length = 0
    w.ws.aliceBox.send({ op: 'agent_invite', room_id: room, topic: 'x', justification: 'y', ...extra })
    return w.ws.aliceBox.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite')
  }
  const unknown = await errorFor({ target_person: 'nobody' })
  assert.equal(unknown.code, 'not_found')
  const self = await errorFor({ target_person: 'alice' })
  assert.equal(self.code, 'not_found')
  assert.deepEqual(self.detail, unknown.detail)
  const both = await errorFor({ target_person: 'bob', target_device_id: w.bobBoxId })
  assert.equal(both.code, 'bad_request')
  const mission = (await w.aliceBox('/missions', post({ convo_id: 'room2', title: 'Covers' }))).json.mission
  const noContactMission = await errorFor({ target_person: 'bob', mission: mission.num })
  assert.equal(noContactMission.code, 'conflict')
  assert.match(noContactMission.detail, /mission_not_shared|not shared/)
  // alice blocked carol: the same not_found as an unknown name.
  assert.equal((await w.alicePhone('/contacts', post({ user: 'carol' }))).status, 201)
  const aliceCarol = (await w.alicePhone('/contacts')).json.contacts.find((c) => c.peer_user === 'carol')
  assert.equal((await w.alicePhone(`/contacts/${aliceCarol.id}/block`, post({}))).status, 200)
  const blocked = await errorFor({ target_person: 'carol' })
  assert.equal(blocked.code, 'not_found')
  assert.deepEqual(blocked.detail, unknown.detail)
  // One live talk per device and person.
  await askTalk(w)
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  w.ws.aliceBox.send({ op: 'publish', convo_id: 'room2', type: 'text', payload: { body: 'again', from: 'agent' } })
  const pending = await errorFor({ target_person: 'bob' }, 'room2')
  assert.equal(pending.code, 'conflict')
  assert.match(pending.detail, /pending/)
})

test('the existing session invite path keeps working beside talk requests', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  // bob shares a session the ordinary way; alice's agent invites that session.
  assert.equal((await w.bobPhone('/session-shares', post({ convo_id: 'bobwork', contact: 'alice' }))).status, 201)
  w.ws.aliceBox.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'hi', from: 'agent' } })
  w.ws.aliceBox.send({ op: 'agent_invite', room_id: 'room', target_device_id: w.bobBoxId, target_convo_id: 'bobwork', justification: 'old path', from_convo_id: 'room' })
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await settle()
  const [own] = await openItems(w.alicePhone, 'room')
  assert.deepEqual(own.actions, ['Approve', 'Decline'])
  const row = w.s.db.prepare("SELECT kind FROM person_rooms WHERE owner_room_id='room'").get()
  assert.equal(row.kind, 'session')
})

test('a talk in a room whose earlier session ask was declined lands on the same guest box', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  assert.equal((await w.bobPhone('/session-shares', post({ convo_id: 'bobwork', contact: 'alice' }))).status, 201)
  w.ws.aliceBox.send({ op: 'agent_invite', room_id: 'room', target_device_id: w.bobBoxId, target_convo_id: 'bobwork', justification: 'old path', from_convo_id: 'room' })
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await settle()
  const [sessionAsk] = await openItems(w.alicePhone, 'room')
  assert.equal((await w.alicePhone(`/items/${sessionAsk.id}/comments`, post({ action: 'Decline' }))).status, 200)
  await settle()
  w.ws.aliceBox.frames.length = 0
  await askAndSend(w)
  const link = talkRow(w)
  const r = await w.bobPhone(`/person-rooms/${link.id}/answer`, post({ decision: 'accept', convo_id: 'bobwork' }))
  assert.equal(r.status, 200)
  assert.equal(r.json.person_room.state, 'invited')
  const req = await guestJoins(w, 'bobBox')
  assert.equal(req.target_convo_id, 'bobwork')
})

test('a session ask that renews an ended talk row is a session ask again', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  await askAndSend(w)
  const theirs = await guestItem(w)
  assert.equal((await w.bobPhone(`/items/${theirs.id}/comments`, post({ action: 'Decline' }))).status, 200)
  // A talk that ended after its guest box was fixed, with no twin.
  w.s.db.prepare("UPDATE person_rooms SET guest_device_id=?, guest_convo_id='bobwork', contact_by_talk=1, pick_options='{}' WHERE kind='talk'").run(w.bobBoxId)
  assert.equal((await w.bobPhone('/session-shares', post({ convo_id: 'bobwork', contact: 'alice' }))).status, 201)
  w.ws.aliceBox.frames.length = 0
  w.ws.aliceBox.send({ op: 'agent_invite', room_id: 'room', target_device_id: w.bobBoxId, target_convo_id: 'bobwork', justification: 'old path', from_convo_id: 'room' })
  await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  const row = w.s.db.prepare("SELECT * FROM person_rooms WHERE owner_room_id='room'").get()
  assert.equal(row.kind, 'session')
  assert.equal(row.contact_by_talk, 0)
  assert.equal(row.pick_options, null)
  await settle()
  const [own] = await openItems(w.alicePhone, 'room')
  assert.deepEqual(own.actions, ['Approve', 'Decline'])
})

test('a guest choice over HTTP reaches no further than the buttons: never a room', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  // An agent-chat room of bob's and a room bob's agent opened with someone.
  upsertConversation(w.s.db, { id: 'bobchat', ownerUserId: w.bob.id, title: 'Chat', agentDeviceId: w.bobBoxId })
  w.s.db.prepare("INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, created_at) VALUES('bobchat', ?, ?, 'joined', ?)").run(w.bobCoordId, w.bobBoxId, Date.now())
  await askAndSend(w)
  const link = talkRow(w)
  for (const convoId of ['bobchat', 'room', 'nope']) {
    const r = await w.bobPhone(`/person-rooms/${link.id}/answer`, post({ decision: 'accept', convo_id: convoId }))
    assert.equal(r.status, 409, convoId)
    assert.equal(r.json.blocked_by, 'not_available')
  }
  assert.equal(talkRow(w).state, 'awaiting_guest')
})

test('New session whose start names a session that is not new on that box: nothing is accepted, bob chooses again', async (t) => {
  const w = await world(t)
  await askAndSend(w)
  const theirs = await guestItem(w)
  assert.equal((await w.bobPhone(`/items/${theirs.id}/comments`, post({ action: 'New session' }))).status, 200)
  const rpc = await w.ws.bobCoord.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start')
  // bobwork lives on bob's other box, not the Coordinator's.
  w.ws.bobCoord.send({ op: 'agent_response', request_id: rpc.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'bobwork' } })
  await settle(200)
  const row = talkRow(w)
  assert.equal(row.state, 'awaiting_guest')
  assert.equal(row.guest_convo_id, null)
  assert.equal((await w.bobPhone('/contacts')).json.contacts[0].state, 'pending_in', 'the contact request is not accepted by a start that failed')
  const retry = (await w.bobPhone(`/items/${theirs.id}`)).json.comments.filter((c) => c.actions?.length).at(-1)
  assert.equal(retry.body, 'Couldn\'t start a session: bad_start_reply. Pick another option.')
})

test('New session that times out: back to bob\'s choice', async (t) => {
  const w = await world(t, { spawnStartTimeoutMs: 100 })
  await makeContacts(w)
  await askAndSend(w)
  const theirs = await guestItem(w)
  assert.equal((await w.bobPhone(`/items/${theirs.id}/comments`, post({ action: 'New session' }))).status, 200)
  await w.ws.bobCoord.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start')
  // The box never answers.
  await settle(400)
  assert.equal(talkRow(w).state, 'awaiting_guest')
  assert.equal(talkRow(w).spawn_id, null)
  const retry = (await w.bobPhone(`/items/${theirs.id}`)).json.comments.filter((c) => c.actions?.length).at(-1)
  assert.match(retry.body, /^Couldn't start a session: .+\. Pick another option\.$/)
  assert.deepEqual(retry.actions, ['My Coordinator', 'Pick a session', 'Decline'])
  assert.equal(w.ws.aliceBox.frames.filter((f) => f.kind === 'invite' && f.event === 'answer').length, 0, 'alice\'s agent is still waiting')
})

test('a talk held back by a block ends without a word to the person who blocked', async (t) => {
  const w = await world(t)
  const { bobContact } = await makeContacts(w)
  assert.equal((await w.bobPhone(`/contacts/${bobContact}/block`, post({}))).status, 200)
  await askAndSend(w)
  const link = talkRow(w)
  await settle()
  w.ws.bobPhone.frames.length = 0
  assert.equal((await w.alicePhone(`/person-rooms/${link.id}`, { method: 'DELETE' })).status, 200)
  await settle()
  assert.equal(w.ws.bobPhone.frames.filter((f) => f.kind === 'people').length, 0)
  assert.equal(w.ws.bobPhone.journal().filter((f) => JSON.stringify(f).includes(link.id)).length, 0)
})

const contactStates = (w) => Object.fromEntries(w.s.db.prepare('SELECT peer_user, state FROM contacts').all().map((r) => [r.peer_user, r.state]))

test('a talk that expires unanswered takes the contact request it made with it', async (t) => {
  const w = await world(t)
  await askAndSend(w)
  assert.deepEqual(contactStates(w), { bob: 'pending_out', alice: 'pending_in' })
  w.ws.bobPhone.frames.length = 0
  w.s.db.prepare("UPDATE person_rooms SET updated_at=? WHERE kind='talk'").run(Date.now() - TALK_GUEST_TTL_MS - 1000)
  sweepTalkAsks({ db: w.s.db, hub: w.s.hub })
  assert.equal(talkRow(w).state, 'expired')
  assert.deepEqual(contactStates(w), { bob: 'expired', alice: 'expired' })
  await settle()
  assert.ok(w.ws.bobPhone.frames.some((f) => f.kind === 'people' && f.contact_id), 'bob\'s contact list refreshes')
})

test('a talk the owner ends before the guest chooses withdraws the contact request it made', async (t) => {
  const w = await world(t)
  await askAndSend(w)
  const link = talkRow(w)
  assert.equal((await w.alicePhone(`/person-rooms/${link.id}`, { method: 'DELETE' })).status, 200)
  assert.deepEqual(contactStates(w), { bob: 'removed', alice: 'removed' })
})

test('ending a talk leaves a contact request it did not make, and a block, alone', async (t) => {
  const w = await world(t)
  // A request alice sent herself, before the talk.
  assert.equal((await w.alicePhone('/contacts', post({ user: 'bob' }))).status, 201)
  await askAndSend(w)
  assert.equal(talkRow(w).contact_by_talk, 0)
  w.s.db.prepare("UPDATE person_rooms SET updated_at=? WHERE kind='talk'").run(Date.now() - TALK_GUEST_TTL_MS - 1000)
  sweepTalkAsks({ db: w.s.db, hub: w.s.hub })
  assert.deepEqual(contactStates(w), { bob: 'pending_out', alice: 'pending_in' })

  // bob blocked alice: her talk's request reads as sent; it ends with the
  // talk, and bob's block stays.
  const w2 = await world(t)
  const { bobContact } = await makeContacts(w2)
  assert.equal((await w2.bobPhone(`/contacts/${bobContact}/block`, post({}))).status, 200)
  await askAndSend(w2)
  assert.equal(talkRow(w2).contact_by_talk, 1)
  w2.s.db.prepare("UPDATE person_rooms SET updated_at=? WHERE kind='talk'").run(Date.now() - TALK_GUEST_TTL_MS - 1000)
  sweepTalkAsks({ db: w2.s.db, hub: w2.s.hub })
  assert.deepEqual(contactStates(w2), { bob: 'expired', alice: 'blocked' })
})

test('a guest tap after the week gets the sweep\'s answer', async (t) => {
  const w = await world(t)
  await askAndSend(w)
  const theirs = await guestItem(w)
  w.s.db.prepare("UPDATE person_rooms SET updated_at=? WHERE kind='talk'").run(Date.now() - TALK_GUEST_TTL_MS - 1000)
  const late = await w.bobPhone(`/items/${theirs.id}/comments`, post({ action: 'My Coordinator' }))
  assert.equal(late.status, 409)
  assert.equal(late.json.blocked_by, 'expired')
  assert.equal(talkRow(w).state, 'expired')
  const no = await w.ws.aliceBox.waitFor((f) => f.kind === 'invite' && f.event === 'answer' && f.room_id === 'room')
  assert.equal(no.accept, false)
  assert.equal(no.reason, 'expired')
  assert.equal((await w.bobPhone(`/items/${theirs.id}`)).json.item.state, 'closed')
  assert.deepEqual(contactStates(w), { bob: 'expired', alice: 'expired' })
  assert.equal(w.ws.bobCoord.frames.filter((f) => f.kind === 'invite').length, 0, 'no invite went out')
  // Over HTTP too.
  assert.equal((await w.bobPhone(`/person-rooms/${talkRow(w).id}/answer`, post({ decision: 'accept', target: 'coordinator' }))).status, 409)
})

// The room exactly as agent_chat_start makes it: a convo_upsert carrying the
// title and a `waiting` state (which journals a session_status), then the
// opening message, then the ask. That status is no session history.
test('a room made the way agent_chat_start makes it is fresh: the ask parks and the asking user gets the card', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  w.ws.aliceBox.send({ op: 'convo_upsert', convo_id: 'made', title: 'A:2c ↔️ 👤 bob — Cover editor', session_state: 'waiting' })
  await askTalk(w, {}, 'made')
  const reply = await w.ws.aliceBox.waitFor((f) => (f.kind === 'invite' && f.event === 'delivered') || (f.op === 'error' && f.ref === 'agent_invite'))
  assert.equal(reply.event, 'delivered', JSON.stringify(reply))
  await settle()
  const card = w.ws.alicePhone.journal().find((f) => f.type === 'permission_request' && f.payload.kind === 'person_room')
  assert.equal(card.convo_id, 'made')
  assert.equal((await openItems(w.alicePhone, 'room')).length, 1, 'the Send item is in her For you')
})

test('a room where a session turn ran is not fresh', async (t) => {
  const w = await world(t)
  await makeContacts(w)
  w.ws.aliceBox.send({ op: 'convo_upsert', convo_id: 'used', title: 'Some session', session_state: 'running' })
  w.ws.aliceBox.send({ op: 'convo_upsert', convo_id: 'used', session_state: 'waiting' })
  await askTalk(w, {}, 'used')
  const err = await w.ws.aliceBox.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite')
  assert.equal(err.code, 'conflict')
  assert.match(err.detail, /not_fresh/)
})
