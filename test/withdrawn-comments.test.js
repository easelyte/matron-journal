import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { recordJoined } from '../src/participants.js'
import { withdrawComment, WITHDRAWN_NOTE } from '../src/withdrawn-comments.js'
import { listSharedComments } from '../src/items.js'

// alice: a client ('mac') and an agent (box-a) managing c1, plus a second
// agent (box-b) of hers that manages nothing here.
async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const agent = createAgent(s.db, alice.id, 'box-a')
  const other = createAgent(s.db, alice.id, 'box-b')
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'c9', ownerUserId: alice.id, title: 'C9', agentDeviceId: other.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  const client = login.json.token
  const item = (await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'question', title: 'Which account?', convo_id: 'c1' } })).json.item
  const reply = (await s.http(`/items/${item.id}/comments`, { method: 'POST', token: client, body: { body: 'use the zebra ledger' } })).json.comment
  return { s, alice, agent, other, client, item, reply }
}

// The bridge's queue card for the reply, then its release.
async function queueAndRelease(s, agent, { item, reply, action, promptId = 'pr_1', canceller = agent }) {
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  ws.send({
    op: 'publish', convo_id: 'c1', type: 'prompt',
    payload: {
      kind: 'queued_release', prompt_id: promptId, question: 'Send this queued message now, or cancel it?',
      items: [{ id: `${promptId}::0`, text: `📌 Item #${item.num} "Which account?" — alice replied:\nuse the zebra ledger` }],
      actions: [{ id: 'send', label: 'Send now' }, { id: 'cancel', label: 'Cancel' }],
      body: `📨 Queued (1): 📌 #${item.num} Which account?`,
      item: { item_id: item.id, comment_id: reply.id },
    },
  })
  await ws.waitFor((f) => f.kind === 'journal' && f.type === 'prompt')
  const cw = canceller === agent ? ws : await makeWsClient(s.base, { token: canceller.token, cursor: null })
  if (cw !== ws) await cw.waitFor((f) => f.op === 'hello_ok')
  cw.send({ op: 'publish', convo_id: 'c1', type: 'prompt_reply', payload: { kind: 'queued_release', prompt_id: promptId, action, released: [`${promptId}::0`] } })
  await ws.waitFor((f) => f.kind === 'journal' && f.type === 'prompt_reply')
  ws.close(); if (cw !== ws) cw.close()
}

const thread = async (s, token, item) => (await s.http(`/items/${item.id}`, { token })).json.comments
const replyIn = (comments, reply) => comments.find((c) => c.id === reply.id)
const search = async (s, token) => (await s.http('/search/all?q=zebra&semantic=0&chats=0', { token })).json.results
const log = (s, userId) => s.db.prepare('SELECT type, payload FROM events WHERE user_id=? AND convo_id=? ORDER BY seq').all(userId, 'c1')

test('a cancelled queued reply: agents read that it was there, never its words; the user still reads it', async (t) => {
  const { s, alice, agent, other, client, item, reply } = await fleet(t)
  assert.equal(replyIn(await thread(s, agent.token, item), reply).body, 'use the zebra ledger')
  assert.equal((await search(s, agent.token)).length, 1)

  await queueAndRelease(s, agent, { item, reply, action: 'cancel' })

  for (const token of [agent.token, other.token]) {
    const c = replyIn(await thread(s, token, item), reply)
    assert.equal(c.body, ''); assert.deepEqual(c.attachments, []); assert.equal(c.withdrawn, true)
    assert.equal(c.author, 'user')
    assert.deepEqual(await search(s, token), [])
  }
  // The user's own apps keep the words, so the thread can show and resend them.
  const own = replyIn(await thread(s, client, item), reply)
  assert.equal(own.body, 'use the zebra ledger'); assert.equal(typeof own.withdrawn_at, 'number')
  assert.equal(own.withdrawn, undefined)
  assert.deepEqual(await search(s, client), [])

  // Nothing in the conversation log holds the words any more: the item
  // marker, the old-client fallback text, and the queue card.
  const rows = log(s, alice.id)
  for (const r of rows) assert.ok(!r.payload.includes('zebra'), `${r.type} still holds the reply: ${r.payload}`)
  const marker = rows.map((r) => JSON.parse(r.payload)).find((p) => p.action === 'commented' && p.comment)
  assert.equal(marker.comment.withdrawn, true); assert.equal(marker.comment.id, reply.id)
  const fallback = rows.filter((r) => r.type === 'text').map((r) => JSON.parse(r.payload)).find((p) => p.action === 'commented')
  assert.match(fallback.body, /alice commented:\n/); assert.ok(fallback.body.endsWith(WITHDRAWN_NOTE))
  const card = rows.filter((r) => r.type === 'prompt').map((r) => JSON.parse(r.payload))[0]
  assert.equal(card.items[0].text, WITHDRAWN_NOTE)
  // Read back through the agent's own transcript route, too.
  const page = await s.http('/convo/c1/messages?limit=50', { token: agent.token })
  assert.ok(!JSON.stringify(page.json).includes('zebra'))
})

test('a reply sent from the queue, or one whose session ended, stays readable', async (t) => {
  for (const action of ['send', 'send_one', 'expired']) {
    const { s, agent, item, reply } = await fleet(t)
    await queueAndRelease(s, agent, { item, reply, action })
    assert.equal(replyIn(await thread(s, agent.token, item), reply).body, 'use the zebra ledger', action)
    assert.equal((await search(s, agent.token)).length, 1, action)
  }
})

test('withdrawComment: only the user\'s own replies, once', async (t) => {
  const { s, alice, agent, item, reply } = await fleet(t)
  const mine = (await s.http(`/items/${item.id}/comments`, { method: 'POST', token: agent.token, body: { body: 'noted' } })).json.comment
  assert.equal(withdrawComment(s.db, { userId: alice.id, itemId: item.id, commentId: mine.id }), null)
  assert.equal(replyIn(await thread(s, agent.token, item), mine).body, 'noted')
  assert.equal(withdrawComment(s.db, { userId: alice.id, itemId: 'it_nope', commentId: reply.id }), null)
  assert.equal(withdrawComment(s.db, { userId: alice.id, itemId: item.id, commentId: reply.id }), reply.id)
  assert.equal(withdrawComment(s.db, { userId: alice.id, itemId: item.id, commentId: reply.id }), null)
})

test('a cancel release for a card that held no item reply touches nothing', async (t) => {
  const { s, alice, agent, item, reply } = await fleet(t)
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  ws.send({ op: 'publish', convo_id: 'c1', type: 'prompt', payload: { kind: 'queued_release', prompt_id: 'pr_plain', items: [{ id: 'pr_plain::0', text: 'a chat message' }] } })
  await ws.waitFor((f) => f.kind === 'journal' && f.type === 'prompt')
  ws.send({ op: 'publish', convo_id: 'c1', type: 'prompt_reply', payload: { kind: 'queued_release', prompt_id: 'pr_plain', action: 'cancel' } })
  await ws.waitFor((f) => f.kind === 'journal' && f.type === 'prompt_reply')
  ws.close()
  assert.equal(replyIn(await thread(s, agent.token, item), reply).body, 'use the zebra ledger')
  assert.ok(log(s, alice.id).some((r) => r.payload.includes('a chat message')))
})

test('another person\'s view of the thread shows a withdrawn reply without its words', async (t) => {
  const { s, alice, item, reply } = await fleet(t)
  withdrawComment(s.db, { userId: alice.id, itemId: item.id, commentId: reply.id })
  const c = replyIn(listSharedComments(s.db, item.id), reply)
  assert.equal(c.body, ''); assert.equal(c.withdrawn, true)
})

test('a cancelled tap: the agent never learns the label, and the item\'s buttons go back to unchosen', async (t) => {
  const { s, agent, client } = await fleet(t)
  const item = (await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'question', title: 'Pick one', convo_id: 'c1', actions: ['Plan A', 'Plan B'] } })).json.item
  const tap = (await s.http(`/items/${item.id}/comments`, { method: 'POST', token: client, body: { action: 'Plan B' } })).json.comment
  assert.equal((await s.http(`/items/${item.id}`, { token: agent.token })).json.item.chosen_action, 'Plan B')
  await queueAndRelease(s, agent, { item, reply: tap, action: 'cancel' })
  const r = (await s.http(`/items/${item.id}`, { token: agent.token })).json
  assert.equal(r.item.chosen_action, null)
  const c = replyIn(r.comments, tap)
  assert.equal(c.action, null); assert.equal(c.meta?.action, undefined); assert.equal(c.withdrawn, true)
  const page = await s.http('/convo/c1/messages?limit=50', { token: agent.token })
  // The log has no trace of the label: not on the comment, not as the item's choice.
  assert.ok(!JSON.stringify(page.json).includes('"chosen_action":"Plan B"'))
  for (const e of page.json.events.filter((x) => x.type === 'item')) assert.notEqual(e.payload.comment?.action, 'Plan B')
})

test('only the conversation\'s own bridge can withdraw, and only through its own card', async (t) => {
  const { s, other, agent, item, reply } = await fleet(t)
  // box-b joins c1 as a peer: it may publish there, but it does not run c1's queue.
  recordJoined(s.db, { convoId: 'c1', agentDeviceId: other.deviceId, initiatorDeviceId: agent.deviceId })
  await queueAndRelease(s, agent, { item, reply, action: 'cancel', canceller: other })
  assert.equal(replyIn(await thread(s, agent.token, item), reply).body, 'use the zebra ledger')
})

test('a transcript that lands after the cancel puts no words back in the log', async (t) => {
  const { s, alice, agent, item, reply } = await fleet(t)
  await queueAndRelease(s, agent, { item, reply, action: 'cancel' })
  s.db.prepare('UPDATE item_comments SET attachments=? WHERE id=?')
    .run(JSON.stringify([{ blob_ref: 'b1', mime: 'audio/m4a', name: 'v.m4a', size: 1, transcript: null }]), reply.id)
  const r = await s.http(`/items/${item.id}/comments/${reply.id}`, { method: 'PATCH', token: agent.token, body: { blob_ref: 'b1', transcript: 'zebra again' } })
  assert.equal(r.status, 200); assert.deepEqual(r.json.comment.attachments, [])
  for (const row of log(s, alice.id)) assert.ok(!row.payload.includes('zebra'), `${row.type}: ${row.payload}`)
})

test('the reply\'s copy in another person\'s log is scrubbed too', async (t) => {
  const { s, alice, item, reply } = await fleet(t)
  const bob = await createUser(s.db, 'bob', 'pw')
  const bobAgent = createAgent(s.db, bob.id, 'bob-box')
  upsertConversation(s.db, { id: 'b1', ownerUserId: bob.id, title: 'B1', agentDeviceId: bobAgent.deviceId })
  append(s.db, { userId: bob.id, convoId: 'b1', sender: 'person:alice', type: 'item', payload: { item_id: item.id, action: 'commented', comment: { id: reply.id, body: 'use the zebra ledger', attachments: [] } } })
  withdrawComment(s.db, { userId: alice.id, itemId: item.id, commentId: reply.id })
  const rows = s.db.prepare("SELECT payload FROM events WHERE user_id=? AND convo_id='b1'").all(bob.id)
  assert.equal(rows.length, 1); assert.ok(!rows[0].payload.includes('zebra'))
})

test('a cancelled tap never restores a choice the buttons no longer offer', async (t) => {
  const { s, agent, client } = await fleet(t)
  const item = (await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'question', title: 'Pick one', convo_id: 'c1', actions: ['Plan A', 'Plan B'] } })).json.item
  await s.http(`/items/${item.id}/comments`, { method: 'POST', token: client, body: { action: 'Plan A' } })
  await s.http(`/items/${item.id}`, { method: 'PATCH', token: agent.token, body: { actions: ['Yes', 'No'] } })
  const tap = (await s.http(`/items/${item.id}/comments`, { method: 'POST', token: client, body: { action: 'No' } })).json.comment
  await queueAndRelease(s, agent, { item, reply: tap, action: 'cancel' })
  assert.equal((await s.http(`/items/${item.id}`, { token: agent.token })).json.item.chosen_action, null)
})

test('a cancelled tap gives the choice back to the earlier tap still standing', async (t) => {
  const { s, agent, client } = await fleet(t)
  const item = (await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'question', title: 'Pick one', convo_id: 'c1', actions: ['Plan A', 'Plan B'] } })).json.item
  await s.http(`/items/${item.id}/comments`, { method: 'POST', token: client, body: { action: 'Plan A' } })
  const tap = (await s.http(`/items/${item.id}/comments`, { method: 'POST', token: client, body: { action: 'Plan B' } })).json.comment
  await queueAndRelease(s, agent, { item, reply: tap, action: 'cancel' })
  assert.equal((await s.http(`/items/${item.id}`, { token: agent.token })).json.item.chosen_action, 'Plan A')
})
