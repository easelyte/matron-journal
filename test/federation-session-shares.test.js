import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { fedRoomsOf } from '../src/federation-rooms.js'
import { makeWsClient } from './helpers.js'
import { world, post } from './federation-world.js'

// Session shares across journals (phase 5 stage 12b), end to end between two
// journals on loopback: bob on b.example shares one session with his contact
// alice@a.example; it appears on her roster; her agent asks for a room with
// that session; alice taps Send and bob Accept, and the session's agent joins.
async function shares(t, opts = {}) {
  const w = await world(t, opts)
  const aliceBox = createAgent(w.a.db, w.users.alice.id, 'alice-chat')
  const bobBox = createAgent(w.b.db, w.users.bob.id, 'bob-box')
  upsertConversation(w.a.db, { id: 'room', ownerUserId: w.users.alice.id, title: 'Cover chat', agentDeviceId: aliceBox.deviceId })
  upsertConversation(w.b.db, { id: 'bobwork', ownerUserId: w.users.bob.id, title: 'Bob Q3', agentDeviceId: bobBox.deviceId })
  w.ws = {
    alice: await makeWsClient(w.a.base, { token: aliceBox.token, cursor: null }),
    bob: await makeWsClient(w.b.base, { token: bobBox.token, cursor: null }),
  }
  for (const s of Object.values(w.ws)) await s.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { for (const s of Object.values(w.ws)) { try { s.close() } catch { /* closed */ } } })
  w.aliceChat = (path, o = {}) => w.a.http(path, { token: aliceBox.token, ...o })
  w.bobChat = (path, o = {}) => w.b.http(path, { token: bobBox.token, ...o })
  return w
}
const tick = () => new Promise((r) => setTimeout(r, 50))
const roomItem = async (phone) => (await phone('/items?label=consent')).json.items.find((i) => i.consent === 'room' && i.state === 'open')
const half = (s) => s.db.prepare('SELECT * FROM fed_rooms ORDER BY created_at DESC LIMIT 1').get()
const remoteOn = async (w) => ((await w.aliceChat('/roster')).json.people ?? []).find((p) => p.person === 'bob@b.example')?.sessions ?? []

async function bobShares(w) {
  const r = await w.phones.bob('/session-shares', post({ convo_id: 'bobwork', contact: 'alice@a.example' }))
  assert.equal(r.status, 201, JSON.stringify(r.json))
  assert.equal(r.json.session_share.contact, 'alice@a.example')
  await w.settle()
  return r.json.session_share
}

async function askForSession(w, convoId) {
  w.ws.alice.send({ op: 'agent_invite', room_id: 'room', target_person: 'bob@b.example', target_convo_id: convoId, topic: 'Q3', justification: 'Ask about the Q3 numbers', from_convo_id: 'room' })
  return w.ws.alice.waitFor((f) => (f.kind === 'invite' && f.event === 'delivered') || (f.op === 'error' && f.ref === 'agent_invite'))
}

test('a shared session across journals: on the roster, asked for, accepted, and its agent joins', async (t) => {
  const w = await shares(t)
  await bobShares(w)
  const listed = await remoteOn(w)
  assert.equal(listed.length, 1)
  assert.match(listed[0].convo_id, /^fs_/)
  assert.deepEqual([listed[0].title, listed[0].agent_device_id, listed[0].remote], ['Bob Q3', null, true])
  // Nothing of bob's but the title and this journal's own id crosses.
  assert.equal(JSON.stringify(listed).includes('bobwork'), false)

  const delivered = await askForSession(w, listed[0].convo_id)
  assert.equal(delivered.event, 'delivered', JSON.stringify(delivered))
  await tick()
  const own = await roomItem(w.phones.alice)
  assert.deepEqual(own.actions, ['Send', 'Cancel'])
  assert.match(own.body, /session "Bob Q3", which bob@b\.example shares with you/)
  assert.equal((await w.phones.alice(`/items/${own.id}/comments`, post({ action: 'Send' }))).status, 200)
  await w.settle()

  const card = await roomItem(w.phones.bob)
  assert.deepEqual(card.actions, ['Accept', 'Decline'])
  assert.match(card.body, /your session "Bob Q3", which you share with them/)
  assert.ok(half(w.b).session_ref.startsWith('ss_'))
  assert.equal((await w.phones.bob(`/items/${card.id}/comments`, post({ action: 'Accept' }))).status, 200)
  const req = await w.ws.bob.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  assert.equal(req.target_convo_id, 'bobwork')
  assert.deepEqual(req.person, { name: 'alice@a.example' })
  w.ws.bob.send({ op: 'agent_invite_answer', room_id: req.room_id, accept: true })
  await tick()
  await w.settle()
  const answer = await w.ws.alice.waitFor((f) => f.kind === 'invite' && f.event === 'answer' && f.room_id === 'room')
  assert.equal(answer.accept, true)
  assert.deepEqual([half(w.a).state, half(w.b).state], ['joined', 'joined'])
})

test('a new title is sent again, and an unshare takes it off the roster', async (t) => {
  const w = await shares(t)
  const share = await bobShares(w)
  w.b.db.prepare("UPDATE conversations SET title='[q3] Bob Q3 numbers' WHERE id='bobwork'").run()
  fedRoomsOf(w.b.db).syncShares()
  await w.settle()
  assert.equal((await remoteOn(w))[0].title, '[q3] Bob Q3 numbers')
  // Nothing changed: nothing more is queued.
  const queued = w.b.db.prepare("SELECT COUNT(*) AS n FROM fed_outbox WHERE op='session.share'").get().n
  fedRoomsOf(w.b.db).syncShares()
  assert.equal(w.b.db.prepare("SELECT COUNT(*) AS n FROM fed_outbox WHERE op='session.share'").get().n, queued)

  const fsId = (await remoteOn(w))[0].convo_id
  assert.equal((await w.phones.bob(`/session-shares/${share.id}`, { method: 'DELETE' })).status, 200)
  await w.settle()
  assert.deepEqual(await remoteOn(w), [])
  const nf = await askForSession(w, fsId)
  assert.equal(nf.op, 'error')
  assert.equal(nf.code ?? nf.error, 'not_found')
})

test('a share revoked after the ask was sent: Accept declines, and the asking agent hears a refusal', async (t) => {
  const w = await shares(t)
  const share = await bobShares(w)
  const fsId = (await remoteOn(w))[0].convo_id
  assert.equal((await askForSession(w, fsId)).event, 'delivered')
  await tick()
  const own = await roomItem(w.phones.alice)
  await w.phones.alice(`/items/${own.id}/comments`, post({ action: 'Send' }))
  await w.settle()
  // Revoked straight in the database, so the unshare op does not race the tap.
  w.b.db.prepare("UPDATE session_shares SET state='revoked' WHERE id=?").run(share.id)
  const card = await roomItem(w.phones.bob)
  const r = await w.phones.bob(`/items/${card.id}/comments`, post({ action: 'Accept' }))
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.match(r.json.comment?.body ?? '', /no longer share that session/)
  await w.settle()
  const answer = await w.ws.alice.waitFor((f) => f.kind === 'invite' && f.event === 'answer' && f.room_id === 'room')
  assert.deepEqual([answer.accept, answer.reason], [false, 'refused'])
})

test('an ask for a session that is no longer shared is refused by the sharer\'s journal, and the room ends', async (t) => {
  const w = await shares(t)
  const share = await bobShares(w)
  const fsId = (await remoteOn(w))[0].convo_id
  assert.equal((await askForSession(w, fsId)).event, 'delivered')
  await tick()
  w.b.db.prepare("UPDATE session_shares SET state='revoked' WHERE id=?").run(share.id)
  const own = await roomItem(w.phones.alice)
  await w.phones.alice(`/items/${own.id}/comments`, post({ action: 'Send' }))
  await w.settle()
  // Still pending when it ended: withdrawn, not left.
  assert.deepEqual([half(w.a).state, half(w.a).ended_by], ['withdrawn', 'unreachable'])
  const notice = w.a.db.prepare("SELECT title, body FROM items WHERE kind='notice' AND title LIKE 'Room with bob@b.example ended%'").get()
  assert.match(notice.body, /no longer shared with you/)
})

test('an agent\'s share with a contact on another journal parks for its user, and goes once approved', async (t) => {
  const w = await shares(t)
  const r = await w.bobChat('/session-shares', post({ convo_id: 'bobwork', contact: 'alice@a.example' }))
  assert.equal(r.status, 202, JSON.stringify(r.json))
  await w.settle()
  assert.deepEqual(await remoteOn(w), [])
  const ask = (await w.phones.bob('/items?label=consent')).json.items.find((i) => i.consent === 'session' && i.state === 'open')
  assert.match(ask.title, /alice@a\.example/)
  assert.match(ask.body, /on another Matron journal: the session's title goes to a\.example/)
  assert.equal((await w.phones.bob(`/items/${ask.id}/comments`, post({ action: 'Approve' }))).status, 200)
  await w.settle()
  assert.equal((await remoteOn(w)).length, 1)
})

test('removing the contact drops the shared session on both journals', async (t) => {
  const w = await shares(t)
  const share = await bobShares(w)
  const contact = (await w.phones.bob('/contacts')).json.contacts[0]
  assert.equal((await w.phones.bob(`/contacts/${contact.id}`, { method: 'DELETE' })).status, 200)
  await w.settle()
  assert.deepEqual(await remoteOn(w), [])
  assert.equal(w.a.db.prepare('SELECT state FROM fed_sessions_in').get().state, 'ended')
  assert.equal(w.b.db.prepare('SELECT state FROM session_shares WHERE id=?').get(share.id).state, 'revoked')
})

test('the HTTP answer accepts onto the shared session, whatever target it names', async (t) => {
  const w = await shares(t)
  await bobShares(w)
  upsertConversation(w.b.db, { id: 'other', ownerUserId: w.users.bob.id, title: 'Other', agentDeviceId: w.b.db.prepare("SELECT agent_device_id AS d FROM conversations WHERE id='bobwork'").get().d })
  assert.equal((await askForSession(w, (await remoteOn(w))[0].convo_id)).event, 'delivered')
  await tick()
  const own = await roomItem(w.phones.alice)
  await w.phones.alice(`/items/${own.id}/comments`, post({ action: 'Send' }))
  await w.settle()
  const r = await w.phones.bob(`/person-rooms/${half(w.b).id}/answer`, post({ decision: 'accept', convo_id: 'other' }))
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const req = await w.ws.bob.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  assert.equal(req.target_convo_id, 'bobwork')
})
