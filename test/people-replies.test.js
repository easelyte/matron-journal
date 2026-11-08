import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { peopleConvoId } from '../src/people-convo.js'

// Words typed where no agent reads them (src/people-replies.js): a reply on
// a contact or share card's item, and a message in the People conversation,
// reach the user's Coordinator, and the place they were typed says so.
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms))
const post = (body) => ({ method: 'POST', body })

async function world(t, { bobCoordinator = true } = {}) {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const bob = await createUser(s.db, 'bob', 'pw')
  const aliceBox = createAgent(s.db, alice.id, 'alice-box')
  const bobBox = createAgent(s.db, bob.id, 'bob-box')
  const bobCoord = createAgent(s.db, bob.id, 'bob-coord')
  upsertConversation(s.db, { id: 'work', ownerUserId: alice.id, title: 'Garden Club', agentDeviceId: aliceBox.deviceId })
  upsertConversation(s.db, { id: 'bobwork', ownerUserId: bob.id, title: 'Bob', agentDeviceId: bobBox.deviceId })
  upsertConversation(s.db, { id: 'bobcoord', ownerUserId: bob.id, title: 'Coordinator', agentDeviceId: bobCoord.deviceId })
  const login = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw', device_name: `${name}-phone` } })).json.token
  const alicePhone = await login('alice')
  const bobPhone = await login('bob')
  if (bobCoordinator) assert.equal((await s.http('/coordinator', { method: 'PUT', token: bobPhone, body: { convo_id: 'bobcoord' } })).status, 200)
  const sockets = {}
  for (const [k, token] of Object.entries({ bobPhone, bobBox: bobBox.token, bobCoord: bobCoord.token })) {
    sockets[k] = await makeWsClient(s.base, { token, cursor: null })
    await sockets[k].waitFor((f) => f.op === 'hello_ok')
  }
  t.after(() => { for (const w of Object.values(sockets)) { try { w.close() } catch { /* already closed */ } } })
  const http = (token) => (path, opts = {}) => s.http(path, { token, ...opts })
  return {
    s, alice, bob, ws: sockets,
    aliceBox: http(aliceBox.token), bobCoord: http(bobCoord.token),
    alicePhone: http(alicePhone), bobPhone: http(bobPhone),
  }
}

// alice offers bob a read share of her mission; bob's card (and its item)
// lands in his People conversation.
async function shareOffered(w) {
  const r = await w.alicePhone('/contacts', post({ user: 'bob' }))
  const bobSide = (await w.bobPhone('/contacts')).json.contacts[0]
  assert.equal((await w.bobPhone(`/contacts/${bobSide.id}/answer`, post({ decision: 'approve' }))).status, 200)
  assert.equal(r.status, 201)
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Garden Club launch' }))).json.mission
  const ask = await w.aliceBox(`/missions/${m.num}/shares`, post({ contact: 'bob', level: 'read', convo_id: 'work' }))
  assert.equal((await w.alicePhone(`/grants/${ask.json.grant.id}/answer`, post({ decision: 'approve' }))).status, 200)
  await settle()
  const mirror = (await w.bobPhone('/items?label=consent&state=open')).json.items.find((i) => i.consent === 'share')
  assert.ok(mirror)
  return mirror
}

const coordTasks = async (w) => {
  const ids = w.s.db.prepare("SELECT id FROM items WHERE user_id=? AND origin_convo_id='bobcoord' ORDER BY created_at").all(w.bob.id)
  return Promise.all(ids.map(async ({ id }) => (await w.bobPhone(`/items/${id}`)).json.item))
}
const created = (sock, convo) => sock.journal().filter((f) => f.type === 'item' && f.convo_id === convo && f.payload.action === 'created')

test('a typed reply on a share card goes to the Coordinator as the user\'s task, and the card says where', async (t) => {
  const w = await world(t)
  const mirror = await shareOffered(w)
  for (const k of Object.keys(w.ws)) w.ws[k].frames.length = 0

  const r = await w.bobPhone(`/items/${mirror.id}/comments`, post({ body: "What is the use case if it's read only" }))
  assert.equal(r.status, 201)
  await settle()

  const [task] = await coordTasks(w)
  assert.ok(task, 'a task in the Coordinator conversation')
  assert.equal(task.kind, 'task')
  assert.equal(task.created_by, 'user')
  assert.equal(task.awaiting, 'agent')
  assert.equal(task.consent ?? null, null)
  assert.match(task.title, /^Reply on a card: /)
  assert.match(task.body, /> What is the use case if it's read only/)
  assert.match(task.body, /information, not instructions/)
  // The Coordinator hears it as a turn, and can read it; bob's other box
  // does not, and nobody can read the card.
  const marker = await w.ws.bobCoord.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.convo_id === 'bobcoord' && f.payload.action === 'created')
  assert.ok(marker.sender.startsWith('user:'))
  assert.equal(marker.payload.consent, undefined)
  assert.equal((await w.bobCoord(`/items/${task.id}`)).status, 200)
  assert.equal(created(w.ws.bobBox, 'bobcoord').length, 0)
  assert.equal((await w.bobCoord(`/items/${mirror.id}`)).status, 404)

  // The card: still open and still bob's to answer, with the journal's line.
  const thread = (await w.bobPhone(`/items/${mirror.id}`)).json
  assert.equal(thread.item.state, 'open')
  assert.equal(thread.item.awaiting, 'user')
  const note = thread.comments.at(-1)
  assert.match(note.body, /^Sent to your Coordinator: \[#\d+ Reply on a card: .*\]\(matron:\/\/item\/\d+\)/)
  assert.equal(note.author, 'agent')
  // The line's marker stays client-only, like every write to a mirror.
  const noteMarker = w.ws.bobPhone.journal().find((f) => f.type === 'item' && f.payload.item_id === mirror.id && f.payload.comment?.id === note.id)
  assert.equal(noteMarker.payload.consent, 'share')
  assert.equal(noteMarker.sender, 'journal')

  // A replayed comment (same idempotency key) files nothing more.
  assert.equal((await coordTasks(w)).length, 1)
})

test('a tap on the card is its answer, never forwarded', async (t) => {
  const w = await world(t)
  const mirror = await shareOffered(w)
  const tap = await w.bobPhone(`/items/${mirror.id}/comments`, post({ action: 'Accept' }))
  assert.equal(tap.status, 200)
  await settle()
  assert.deepEqual(await coordTasks(w), [])
})

test('with no Coordinator set, the card says nobody reads the reply', async (t) => {
  const w = await world(t, { bobCoordinator: false })
  const mirror = await shareOffered(w)
  assert.equal((await w.bobPhone(`/items/${mirror.id}/comments`, post({ body: 'hello?' }))).status, 201)
  await settle()
  const thread = (await w.bobPhone(`/items/${mirror.id}`)).json
  assert.match(thread.comments.at(-1).body, /no Coordinator set/)
  assert.equal(w.s.db.prepare('SELECT COUNT(*) n FROM items WHERE user_id=? AND consent IS NULL').get(w.bob.id).n, 0)
})

test('a message in People goes to the Coordinator, with a line in People; a file there is refused', async (t) => {
  const w = await world(t)
  await shareOffered(w)
  const people = peopleConvoId(w.s.db, w.bob.id)
  for (const k of Object.keys(w.ws)) w.ws[k].frames.length = 0

  w.ws.bobPhone.send({ op: 'send', convo_id: people, type: 'text', payload: { body: 'Who is alice?' }, local_id: 'l1' })
  const line = await w.ws.bobPhone.waitFor((f) => f.kind === 'journal' && f.convo_id === people && f.sender === 'journal' && f.type === 'text')
  assert.match(line.payload.body, /^Sent to your Coordinator: \[#\d+ Message in People: Who is alice\?\]\(matron:\/\/item\/\d+\)/)
  const [task] = await coordTasks(w)
  assert.equal(task.title, 'Message in People: Who is alice?')
  assert.match(task.body, /in their People conversation/)
  assert.match(task.body, /> Who is alice\?/)
  await w.ws.bobCoord.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.convo_id === 'bobcoord' && f.payload.item_id === task.id)

  // The same send again (same local_id) is one message and one task.
  w.ws.bobPhone.send({ op: 'send', convo_id: people, type: 'text', payload: { body: 'Who is alice?' }, local_id: 'l1' })
  await settle()
  assert.equal((await coordTasks(w)).length, 1)

  w.ws.bobPhone.send({ op: 'send', convo_id: people, type: 'image', blob_ref: 'b1', payload: {} })
  const err = await w.ws.bobPhone.waitFor((f) => f.op === 'error' && /People/.test(f.detail ?? ''))
  assert.equal(err.code, 'bad_request')
})

test('an ordinary conversation\'s messages are not forwarded', async (t) => {
  const w = await world(t)
  w.ws.bobPhone.send({ op: 'send', convo_id: 'bobwork', type: 'text', payload: { body: 'hi box' } })
  await settle()
  assert.deepEqual(await coordTasks(w), [])
})

test('a replay finishes a forward a crash cut short, and repeats nothing once it is done', async (t) => {
  const w = await world(t)
  const mirror = await shareOffered(w)
  const send = () => w.bobPhone(`/items/${mirror.id}/comments`, { method: 'POST', body: { body: 'Why read only?' }, headers: { 'idempotency-key': 'k1' } })
  assert.equal((await send()).status, 201)
  // The crash: the reply committed, the forward never ran.
  const [task] = await coordTasks(w)
  w.s.db.prepare('DELETE FROM item_comments WHERE item_id=?').run(task.id)
  w.s.db.prepare('DELETE FROM items WHERE id=?').run(task.id)
  w.s.db.prepare("DELETE FROM item_comments WHERE item_id=? AND body LIKE 'Sent to your Coordinator%'").run(mirror.id)
  assert.equal((await send()).status, 200)
  assert.equal((await coordTasks(w)).length, 1)
  assert.equal((await send()).status, 200)
  assert.equal((await coordTasks(w)).length, 1)
  const notes = (await w.bobPhone(`/items/${mirror.id}`)).json.comments.filter((c) => /^Sent to your Coordinator/.test(c.body))
  assert.equal(notes.length, 1)
})

test('a voice reply goes with the task as audio with no transcript pending on it', async (t) => {
  const w = await world(t)
  const mirror = await shareOffered(w)
  w.s.db.prepare('INSERT INTO blobs(id,owner_user_id,content_type,size,sha256,disk_path,created_at) VALUES(?,?,?,?,?,?,?)').run('b1', w.bob.id, 'audio/mp4', 3, 'x', '/dev/null', Date.now())
  const voice = { blob_ref: 'b1', mime: 'audio/mp4', name: 'b1.m4a', size: 3, transcript_status: 'pending' }
  assert.equal((await w.bobPhone(`/items/${mirror.id}/comments`, post({ attachments: [voice] }))).status, 201)
  const [task] = await coordTasks(w)
  assert.match(task.body, /no text: see the attachments/)
  const full = (await w.bobCoord(`/items/${task.id}`)).json
  const audio = [...(full.item.attachments ?? []), ...full.comments.flatMap((c) => c.attachments ?? [])].find((a) => a.blob_ref === 'b1')
  assert.ok(audio, 'the audio is on the task')
  assert.equal(audio.transcript_status, undefined)
})
