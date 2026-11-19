// A notice that an agent later asks something with buttons becomes a
// question in the same write: every app then shows it as needing the user
// (not as something to read), the push goes out as a question, and a Seen
// tap can no longer close it with the question unanswered. Notices that
// already wait on such a question become questions once, at startup.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { createItem, addComment, insertComment, closeItem, getItem, listComments, promoteAskingNotices } from '../src/items.js'
import { promoteAskingNoticesAndTell } from '../src/sharing-events.js'
import { classify } from '../src/push.js'
import { world, post, grantOf, incoming, offer } from './federation-world.js'

async function seed() {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const agent = createAgent(db, alice.id, 'box-a')
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: agent.deviceId })
  const notice = (o = {}) => createItem(db, { userId: alice.id, kind: 'notice', title: 'Backup failed', originConvoId: 'c1', originDeviceId: agent.deviceId, createdBy: 'agent', ...o }).item
  const ask = (itemId, o = {}) => addComment(db, { userId: alice.id, itemId, author: 'agent', deviceId: agent.deviceId, convoId: 'c1', body: 'Retry it tonight?', actions: ['Retry', 'Leave it'], ...o })
  return { db, alice, agent, notice, ask }
}

// An ask written the way it was before this change: the comment only, the
// item left a notice.
function oldAsk(db, alice, agent, itemId, at) {
  insertComment(db, { itemId, userId: alice.id, author: 'agent', deviceId: agent.deviceId, convoId: 'c1', kind: 'comment', body: 'Retry it tonight?', attachments: [], meta: null, actions: ['Retry', 'Leave it'], idemKey: null, now: at })
  db.prepare("UPDATE items SET awaiting='user', updated_at=? WHERE id=?").run(at, itemId)
}

test('an agent asking with buttons on an open notice turns it into a question in the same write', async () => {
  const { db, alice, notice, ask } = await seed()
  const n = notice()
  const out = ask(n.id, { now: 5000 })
  assert.equal(out.item.kind, 'question')
  assert.deepEqual(out.item.actions, [], 'the built-in Seen is gone')
  assert.deepEqual([out.item.state, out.item.awaiting, out.item.chosen_action], ['open', 'user', null])
  assert.deepEqual(out.comment.actions, ['Retry', 'Leave it'], 'the buttons stay on the comment that asked')
  const thread = listComments(db, n.id)
  assert.deepEqual(thread.map((c) => c.kind), ['comment', 'status'])
  const status = thread[1]
  assert.equal(status.body, '', 'no note in the agent\'s name')
  assert.deepEqual(status.meta.kind, { from: 'notice', to: 'question' })
  assert.deepEqual(status.meta.to, { state: 'open', resolution: null, awaiting: 'user' })
  // A second question on it changes nothing more.
  ask(n.id, { body: 'Or move it to Sunday?', actions: ['Sunday'] })
  assert.equal(listComments(db, n.id).filter((c) => c.kind === 'status').length, 1)
})

test('only an agent question with buttons changes the kind', async () => {
  const { db, alice, agent, notice, ask } = await seed()
  const plain = notice()
  assert.equal(ask(plain.id, { actions: [] }).item.kind, 'notice', 'a comment with no buttons')
  const typed = notice()
  assert.equal(addComment(db, { userId: alice.id, itemId: typed.id, author: 'user', deviceId: 1, body: 'Why?' }).item.kind, 'notice', 'the user\'s own words')
  const deviceZero = notice()
  assert.equal(addComment(db, { userId: alice.id, itemId: deviceZero.id, author: 'agent', deviceId: 0, body: 'Pick a box', actions: ['box-a'] }).item.kind, 'notice', 'a journal-written question')
  const journalOwn = notice()
  // The journal's own questions on an item (a hand-over offer) keep its status, and its kind.
  assert.equal(addComment(db, { userId: alice.id, itemId: journalOwn.id, author: 'agent', deviceId: 0, body: 'Hand this over?', actions: ['Yes'], keepStatus: true }).item.kind, 'notice')
  const closed = notice()
  closeItem(db, { userId: alice.id, itemId: closed.id, resolution: 'cancelled', author: 'agent', deviceId: agent.deviceId })
  assert.throws(() => ask(closed.id), /item_closed/)
  assert.equal(getItem(db, alice.id, closed.id).kind, 'notice')
  for (const kind of ['task', 'decision']) {
    const it = createItem(db, { userId: alice.id, kind, title: kind, originConvoId: 'c1', originDeviceId: agent.deviceId, createdBy: 'agent' }).item
    assert.equal(ask(it.id).item.kind, kind)
  }
})

test('a Seen tap no longer closes it; the question\'s own buttons answer it', async () => {
  const { db, alice, notice, ask } = await seed()
  const n = notice()
  const asked = ask(n.id)
  assert.throws(() => addComment(db, { userId: alice.id, itemId: n.id, author: 'user', deviceId: 1, body: 'Seen', action: 'Seen' }), /unknown_action/)
  assert.deepEqual([getItem(db, alice.id, n.id).state, getItem(db, alice.id, n.id).awaiting], ['open', 'user'])
  const tap = addComment(db, { userId: alice.id, itemId: n.id, author: 'user', deviceId: 1, body: 'Retry', action: 'Retry', replyTo: asked.comment.id })
  assert.equal(tap.seen, undefined)
  assert.deepEqual([tap.item.state, tap.item.awaiting, tap.item.kind], ['open', 'agent', 'question'])
})

test('over HTTP: the marker, the push and every app see a question; a Seen tap from an old screen is refused', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const agent = createAgent(s.db, alice.id, 'box-a')
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: agent.deviceId })
  const client = (await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })).json.token
  const id = (await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'notice', title: 'Backup failed', convo_id: 'c1' } })).json.item.id
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  t.after(() => ws.close())
  await ws.waitFor((f) => f.op === 'hello_ok')

  const r = await s.http(`/items/${id}/comments`, { method: 'POST', token: agent.token, body: { body: 'Retry it tonight?', actions: ['Retry', 'Leave it'], convo_id: 'c1' } })
  assert.equal(r.status, 201)
  assert.deepEqual([r.json.item.kind, r.json.item.actions, r.json.item.awaiting], ['question', [], 'user'])
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === 'commented' && f.payload.item_id === id)
  assert.equal(marker.payload.kind, 'question')
  const push = classify('item', marker.payload, marker.sender)
  assert.equal(push.question, true)
  assert.equal(push.notice, undefined, 'it pushes as a question, not as something to read')

  // Apps that know notices and apps that don't both see a question.
  assert.equal((await s.http(`/items/${id}`, { token: client })).json.item.kind, 'question')
  assert.equal((await s.http(`/items/${id}`, { token: client, headers: { 'x-matron-item-kinds': 'notice' } })).json.item.kind, 'question')
  const seen = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: { action: 'Seen' } })
  assert.equal(seen.status, 400)
  assert.equal((await s.http(`/items/${id}`, { token: client })).json.item.state, 'open')
})

test('one-off: open notices waiting on an unanswered button question become questions, once', async () => {
  const { db, alice, agent, notice } = await seed()
  db.pragma('user_version = 2') // a database from before the change
  const waiting = notice()
  oldAsk(db, alice, agent, waiting.id, 1000)
  const tapped = notice()
  oldAsk(db, alice, agent, tapped.id, 1000)
  const askRow = db.prepare("SELECT id FROM item_comments WHERE item_id=? AND kind='comment'").get(tapped.id)
  db.prepare("UPDATE item_comments SET chosen_action='Retry' WHERE id=?").run(askRow.id)
  const replied = notice()
  oldAsk(db, alice, agent, replied.id, 1000)
  addComment(db, { userId: alice.id, itemId: replied.id, author: 'user', deviceId: 1, body: 'Not tonight', now: 2000 })
  const reopened = notice()
  oldAsk(db, alice, agent, reopened.id, 1000)
  insertComment(db, { itemId: reopened.id, userId: alice.id, author: 'user', deviceId: 1, kind: 'comment', body: 'Not tonight', attachments: [], meta: null, idemKey: null, now: 2000 })
  const closed = notice()
  oldAsk(db, alice, agent, closed.id, 1000)
  closeItem(db, { userId: alice.id, itemId: closed.id, resolution: 'cancelled', author: 'agent', deviceId: agent.deviceId })
  const quiet = notice()
  // The journal's own hand-over question, written as device 0.
  const handover = notice()
  insertComment(db, { itemId: handover.id, userId: alice.id, author: 'agent', deviceId: 0, kind: 'comment', body: 'Hand this over?', attachments: [], meta: { role: 'handover_approval' }, actions: ['Hand over', 'Keep it here'], idemKey: null, now: 1000 })

  const out = promoteAskingNotices(db, 9000)
  assert.deepEqual(out.map((i) => i.id), [waiting.id])
  const w = getItem(db, alice.id, waiting.id)
  assert.deepEqual([w.kind, w.actions, w.awaiting, w.updated_at], ['question', [], 'user', 9000])
  const status = listComments(db, waiting.id).find((c) => c.kind === 'status')
  assert.deepEqual([status.body, status.device_id, status.meta.kind], ['', agent.deviceId, { from: 'notice', to: 'question' }])
  for (const it of [tapped, replied, reopened, closed, quiet, handover]) assert.equal(getItem(db, alice.id, it.id).kind, 'notice', it.id)
  assert.equal(db.pragma('user_version', { simple: true }), 3)
  // Once per database: a notice left like that later is not swept again.
  const late = notice()
  oldAsk(db, alice, agent, late.id, 10000)
  assert.deepEqual(promoteAskingNotices(db), [])
  assert.equal(getItem(db, alice.id, late.id).kind, 'notice')
})

// --- shared copies -------------------------------------------------------------

test('a grantee on the same journal reads the item as a question', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  await createUser(s.db, 'bob', 'pw')
  const box = createAgent(s.db, alice.id, 'box-a')
  upsertConversation(s.db, { id: 'work', ownerUserId: alice.id, title: 'Garden Club', agentDeviceId: box.deviceId })
  const login = async (name) => (await s.http('/login', post({ username: name, password: 'pw', device_name: `${name}-phone` }))).json.token
  const alicePhone = await login('alice')
  const bobPhone = await login('bob')
  const as = (token) => (path, opts = {}) => s.http(path, { token, ...opts })
  const [aBox, aPhone, bPhone] = [as(box.token), as(alicePhone), as(bobPhone)]
  const c = await aPhone('/contacts', post({ user: 'bob' }))
  assert.equal(c.status, 201)
  const bobSide = (await bPhone('/contacts')).json.contacts[0]
  assert.equal((await bPhone(`/contacts/${bobSide.id}/answer`, post({ decision: 'approve' }))).status, 200)
  const mission = (await aBox('/missions', post({ convo_id: 'work', title: 'Garden Club', body: 'Spring.' }))).json.mission
  const n = (await aBox('/items', post({ convo_id: 'work', kind: 'notice', title: 'Frost tonight' }))).json.item
  const share = await aPhone(`/missions/${mission.id}/shares`, post({ contact: 'bob' }))
  assert.equal((await bPhone(`/grants/${share.json.grant.id}/answer`, post({ decision: 'approve' }))).status, 200)
  const kindOnBobs = async () => (await bPhone('/items?scope=shared', { headers: { 'x-matron-item-kinds': 'notice' } })).json.items.find((i) => i.id === n.id).kind
  assert.equal(await kindOnBobs(), 'notice')
  assert.equal((await aBox(`/items/${n.id}/comments`, post({ body: 'Cover the beds?', actions: ['Cover', 'Leave'], convo_id: 'work' }))).status, 201)
  assert.equal(await kindOnBobs(), 'question')
})

async function federated(t) {
  const w = await world(t)
  const n = (await w.aliceBox('/items', post({ convo_id: 'work', kind: 'notice', title: 'Frost tonight' }))).json.item
  const g = await offer(w)
  await w.phones.bob(`/grants/${incoming(w.b)[0].id}/answer`, post({ decision: 'approve' }))
  await w.settle()
  assert.equal(grantOf(w.a, g.id).state, 'active')
  const bobKind = async () => (await w.phones.bob('/items?scope=shared', { headers: { 'x-matron-item-kinds': 'notice' } })).json.items.find((i) => i.title === 'Frost tonight').kind
  assert.equal(await bobKind(), 'notice')
  return { w, n, bobKind }
}

test('the copy on another journal follows the new kind', async (t) => {
  const { w, n, bobKind } = await federated(t)
  assert.equal((await w.aliceBox(`/items/${n.id}/comments`, post({ body: 'Cover the beds?', actions: ['Cover', 'Leave'], convo_id: 'work' }))).status, 201)
  await w.settle()
  assert.equal(await bobKind(), 'question')
})

test('the one-off sends what it changed to the copy on another journal', async (t) => {
  const { w, n, bobKind } = await federated(t)
  const box = w.a.db.prepare("SELECT agent_device_id AS id FROM conversations WHERE id='work'").get().id
  oldAsk(w.a.db, w.users.alice, { deviceId: box }, n.id, Date.now())
  w.a.db.pragma('user_version = 2')
  const out = promoteAskingNoticesAndTell({ db: w.a.db, hub: { sendToClients() {} } })
  assert.deepEqual(out.map((i) => i.id), [n.id])
  await w.settle()
  assert.equal(await bobKind(), 'question')
})
