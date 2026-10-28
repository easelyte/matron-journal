// Comment action buttons (2026-10-04 comment-actions contract, protocol.md
// "Comment action buttons"). The item-actions pair one level down: an agent
// attaches up to four one-tap answers to a follow-up COMMENT, the user taps
// one with `action` + `reply_to`, and the tap is the same user comment a tap
// on the item's own buttons is — only the asking comment's `chosen_action`
// follows it, not the item's.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { startTestServer, makeWsClient } from './helpers.js'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { createItem, addComment, getItem, listComments, listGrantedComments, closeItem } from '../src/items.js'
import { itemMarkerPayload, itemFallbackText } from '../src/items-marker.js'

// --- pure state ---------------------------------------------------------------

async function seed() {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const agent = createAgent(db, alice.id, 'box-2')
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: agent.deviceId })
  const item = createItem(db, { userId: alice.id, kind: 'task', title: 'Paragraph spacing', originConvoId: 'c1', originDeviceId: agent.deviceId, createdBy: 'agent' }).item
  const ask = (actions, o = {}) => addComment(db, { userId: alice.id, itemId: item.id, author: 'agent', deviceId: agent.deviceId, body: 'Merge it?', actions, ...o })
  const tap = (action, replyTo, o = {}) => addComment(db, { userId: alice.id, itemId: item.id, author: 'user', deviceId: 99, body: action, action, replyTo, ...o })
  return { db, alice, agent, item, ask, tap }
}

test('every comment carries actions / chosen_action / reply_to: [] / null / null unless set', async () => {
  const { db, item, ask } = await seed()
  const plain = ask([]).comment
  assert.deepEqual(plain.actions, []); assert.equal(plain.chosen_action, null); assert.equal(plain.reply_to, null)
  const asked = ask(['Merge', 'Wait']).comment
  assert.deepEqual(asked.actions, ['Merge', 'Wait']); assert.equal(asked.chosen_action, null)
  assert.deepEqual(listComments(db, item.id).map((c) => c.actions), [[], ['Merge', 'Wait']])
})

test('an agent comment with actions hands the item to the user; one without leaves awaiting alone', async () => {
  const { db, alice, item, ask } = await seed()
  assert.equal(item.awaiting, 'agent')
  assert.equal(ask([]).item.awaiting, 'agent')
  assert.equal(ask(['Merge']).item.awaiting, 'user')
  assert.equal(getItem(db, alice.id, item.id).awaiting, 'user')
})

test('an agent comment with actions on a closed item throws item_closed and writes nothing', async () => {
  const { db, alice, agent, item, ask } = await seed()
  closeItem(db, { userId: alice.id, itemId: item.id, resolution: 'done', author: 'agent', deviceId: agent.deviceId })
  const before = listComments(db, item.id).length
  assert.throws(() => ask(['Merge']), /item_closed/)
  assert.equal(listComments(db, item.id).length, before)
  assert.equal(getItem(db, alice.id, item.id).state, 'closed')
  // Without buttons it is the ordinary agent comment a closed item accepts.
  assert.equal(ask([]).item.state, 'closed')
})

test('a tap with replyTo: the tap comment records it, the asking comment is marked, the item\'s own chosen_action is not', async () => {
  const { db, alice, item, ask, tap } = await seed()
  const q = ask(['Merge', 'Wait']).comment
  const out = tap('Merge', q.id)
  assert.equal(out.comment.action, 'Merge'); assert.equal(out.comment.reply_to, q.id)
  assert.deepEqual(out.comment.meta, { action: 'Merge', reply_to: q.id })
  assert.deepEqual(out.comment.actions, []) // the tap offers nothing itself
  assert.equal(out.item.awaiting, 'agent'); assert.equal(out.item.chosen_action, null)
  const thread = listComments(db, item.id)
  assert.equal(thread.find((c) => c.id === q.id).chosen_action, 'Merge')
  // The latest tap wins, as on the item.
  tap('Wait', q.id)
  assert.equal(listComments(db, item.id).find((c) => c.id === q.id).chosen_action, 'Wait')
  assert.equal(getItem(db, alice.id, item.id).chosen_action, null)
})

test('two questions in one thread keep their own buttons and their own answers', async () => {
  const { db, item, ask, tap } = await seed()
  const q1 = ask(['Merge', 'Wait']).comment
  tap('Wait', q1.id)
  const q2 = ask(['Now', 'Tomorrow']).comment
  tap('Now', q2.id)
  const byId = Object.fromEntries(listComments(db, item.id).map((c) => [c.id, c]))
  assert.deepEqual([byId[q1.id].actions, byId[q1.id].chosen_action], [['Merge', 'Wait'], 'Wait'])
  assert.deepEqual([byId[q2.id].actions, byId[q2.id].chosen_action], [['Now', 'Tomorrow'], 'Now'])
})

test('unknown_action: a label the comment does not offer, a comment of another item, a status row, a bare replyTo', async () => {
  const { db, alice, agent, item, ask, tap } = await seed()
  const q = ask(['Merge']).comment
  assert.throws(() => tap('merge', q.id), /unknown_action/) // case-sensitive
  assert.throws(() => tap('Merge', 'ic_nope'), /unknown_action/)
  // Another item's comment, even one offering the label.
  const other = createItem(db, { userId: alice.id, kind: 'task', title: 'Other', originConvoId: 'c1', originDeviceId: agent.deviceId, createdBy: 'agent' }).item
  const foreign = addComment(db, { userId: alice.id, itemId: other.id, author: 'agent', deviceId: agent.deviceId, body: 'q', actions: ['Merge'] }).comment
  assert.throws(() => tap('Merge', foreign.id), /unknown_action/)
  // The item's own buttons are not the comment's: with replyTo the item list is never consulted.
  db.prepare("UPDATE items SET actions='[\"Go\"]' WHERE id=?").run(item.id)
  assert.throws(() => tap('Go', q.id), /unknown_action/)
  assert.throws(() => addComment(db, { userId: alice.id, itemId: item.id, author: 'user', deviceId: 99, body: 'hi', replyTo: q.id }), /unknown_action/)
  assert.equal(listComments(db, item.id).length, 1) // nothing written by any refusal
  assert.equal(listComments(db, item.id)[0].chosen_action, null)
  // ...and without replyTo the tap still answers the item, exactly as before.
  const itemTap = tap('Go', null)
  assert.equal(itemTap.item.chosen_action, 'Go'); assert.equal(itemTap.comment.reply_to, null)
  assert.deepEqual(itemTap.comment.meta, { action: 'Go' })
})

test('a grantee sees the thread without the buttons', async () => {
  const { db, item, ask, tap } = await seed()
  const q = ask(['Merge']).comment
  tap('Merge', q.id)
  for (const c of listGrantedComments(db, item.id)) {
    assert.deepEqual(c.actions, []); assert.equal(c.chosen_action, null); assert.equal(c.device_id, 0)
  }
})

test('itemMarkerPayload carries the comment\'s actions, chosen_action and reply_to', async () => {
  const { ask, tap } = await seed()
  const asked = ask(['Merge', 'Wait'])
  const p = itemMarkerPayload({ item: asked.item, action: 'commented', by: 'agent', comment: asked.comment })
  assert.deepEqual(p.comment.actions, ['Merge', 'Wait']); assert.equal(p.comment.chosen_action, null); assert.equal(p.comment.reply_to, null)
  assert.equal(p.awaiting, 'user')
  // An agent comment that hands the item over reads "Needs you" to an old client.
  assert.match(itemFallbackText(p, { actor: 'box-2' }), /^📌 Needs you — task #\d+ "Paragraph spacing" — box-2 asked:\nMerge it\?$/)
  const tapped = tap('Merge', asked.comment.id)
  const tp = itemMarkerPayload({ item: tapped.item, action: 'commented', by: 'user', comment: tapped.comment })
  assert.equal(tp.comment.action, 'Merge'); assert.equal(tp.comment.reply_to, asked.comment.id)
  assert.equal(tp.chosen_action, null) // the item's own pair is untouched
})

test('itemMarkerPayload carries the comment\'s created_at in ms, the time an item_tap / item_reply cause names', async () => {
  const { ask, tap } = await seed()
  const asked = ask(['Merge'])
  const tapped = tap('Merge', asked.comment.id)
  const tp = itemMarkerPayload({ item: tapped.item, action: 'commented', by: 'user', comment: tapped.comment })
  assert.ok(Number.isSafeInteger(tp.comment.created_at))
  assert.equal(tp.comment.created_at, tapped.comment.created_at)
  // A ref built from it round-trips to the same ms: what src/ask-cause.js looks up.
  assert.equal(Date.parse(new Date(tp.comment.created_at).toISOString()), tapped.comment.created_at)
  const bare = itemMarkerPayload({ item: tapped.item, action: 'commented', by: 'user', comment: { id: 'ic_x', body: 'hi' } })
  assert.equal(bare.comment.created_at, null)
  const odd = itemMarkerPayload({ item: tapped.item, action: 'commented', by: 'user', comment: { id: 'ic_y', body: 'hi', created_at: '2026-01-01T00:00:00Z' } })
  assert.equal(odd.comment.created_at, null) // a non-integer time is no time: never a string a bridge would misparse
})

test('openDb adds actions / chosen_action to a pre-existing item_comments table; old rows read as [] / null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-comment-actions-'))
  const file = path.join(dir, 'j.db')
  const d1 = openDb(file)
  d1.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'alice','x',0)").run()
  d1.close()
  // Rewind the file to the pre-contract schema, with one comment already in it.
  const raw = new Database(file)
  raw.exec('ALTER TABLE item_comments DROP COLUMN actions; ALTER TABLE item_comments DROP COLUMN chosen_action;')
  raw.prepare(`INSERT INTO items(id,user_id,num,kind,state,rank,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at)
    VALUES('it_old',1,1,'task','open',1024,'t','c1',1,'user',0,0)`).run()
  raw.prepare("INSERT INTO item_comments(id,item_id,user_id,author,device_id,kind,body,created_at) VALUES('ic_old','it_old',1,'agent',1,'comment','hi',1)").run()
  raw.close()
  const d2 = openDb(file)
  const cols = d2.prepare('PRAGMA table_info(item_comments)').all().map((c) => c.name)
  assert.ok(cols.includes('actions') && cols.includes('chosen_action'))
  const [c] = listComments(d2, 'it_old')
  assert.deepEqual(c.actions, []); assert.equal(c.chosen_action, null); assert.equal(c.reply_to, null)
  d2.close()
  openDb(file).close() // re-opening an already-migrated file is a no-op
  fs.rmSync(dir, { recursive: true, force: true })
})

// --- HTTP ---------------------------------------------------------------------

async function fleet(t) {
  const wakeCalls = []
  const waker = { enabled: true, wake: (name) => wakeCalls.push(name) }
  const s = await startTestServer({ waker })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const agent = createAgent(s.db, alice.id, 'box-2')
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: agent.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  const made = await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'task', title: 'Paragraph spacing', convo_id: 'c1' } })
  return { s, alice, agent, client: login.json.token, wakeCalls, id: made.json.item.id }
}

const comment = (s, token, id, body, headers) => s.http(`/items/${id}/comments`, { method: 'POST', token, body, headers })

test('POST comments {actions} from an agent: validated, serialized, awaiting→user, and on the marker', async (t) => {
  const { s, agent, client, id } = await fleet(t)
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  t.after(() => ws.close())
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await comment(s, agent.token, id, { body: 'Merge it?', actions: ['Merge', ' Screenshot first '] })
  assert.equal(r.status, 201)
  assert.deepEqual(r.json.comment.actions, ['Merge', 'Screenshot first']); assert.equal(r.json.comment.chosen_action, null)
  assert.equal(r.json.item.awaiting, 'user')
  const got = await s.http(`/items/${id}`, { token: client })
  assert.deepEqual(got.json.comments.at(-1).actions, ['Merge', 'Screenshot first'])
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === 'commented')
  assert.deepEqual(marker.payload.comment.actions, ['Merge', 'Screenshot first'])
  assert.equal(marker.payload.awaiting, 'user')
  // Bad lists answer with the contract's own code; [] and null are "none".
  for (const bad of [['a', 'A'], ['x'.repeat(41)], 'Go', ['a', 'b', 'c', 'd', 'e']]) {
    const b = await comment(s, agent.token, id, { body: 'q', actions: bad })
    assert.equal(b.status, 400); assert.deepEqual(b.json, { error: 'invalid_actions' })
  }
  const none = await comment(s, agent.token, id, { body: 'fyi', actions: [] })
  assert.equal(none.status, 201); assert.deepEqual(none.json.comment.actions, [])
  assert.equal(none.json.item.awaiting, 'user') // an FYI does not take the question back
  // Buttons alone are not a comment: words or an attachment are still required.
  assert.equal((await comment(s, agent.token, id, { actions: ['Go'] })).status, 400)
})

test('a client may not offer actions on a comment', async (t) => {
  const { s, client, id } = await fleet(t)
  const r = await comment(s, client, id, { body: 'hello', actions: ['Go'] })
  assert.equal(r.status, 403)
  assert.equal((await s.http(`/items/${id}`, { token: client })).json.comments.length, 0)
  // An empty list is the same as leaving it out — not a refusal.
  assert.equal((await comment(s, client, id, { body: 'hello', actions: [] })).status, 201)
})

test('actions on a comment to a closed item is 409; reopen first', async (t) => {
  const { s, agent, id } = await fleet(t)
  await s.http(`/items/${id}/close`, { method: 'POST', token: agent.token, body: { resolution: 'done' } })
  assert.equal((await comment(s, agent.token, id, { body: 'One more thing?', actions: ['Yes'] })).status, 409)
  await s.http(`/items/${id}/reopen`, { method: 'POST', token: agent.token, body: {} })
  assert.equal((await comment(s, agent.token, id, { body: 'One more thing?', actions: ['Yes'] })).status, 201)
})

test('tap {action, reply_to}: body defaults to the label, the asking comment is marked, awaiting→agent, marker carries reply_to, box woken', async (t) => {
  const { s, agent, client, id, wakeCalls } = await fleet(t)
  const q = (await comment(s, agent.token, id, { body: 'Merge it?', actions: ['Merge', 'Wait'] })).json.comment
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  t.after(() => ws.close())
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await comment(s, client, id, { action: ' Merge ', reply_to: q.id })
  assert.equal(r.status, 201)
  assert.equal(r.json.comment.body, 'Merge'); assert.equal(r.json.comment.action, 'Merge'); assert.equal(r.json.comment.reply_to, q.id)
  assert.equal(r.json.item.awaiting, 'agent'); assert.equal(r.json.item.chosen_action, null)
  const thread = (await s.http(`/items/${id}`, { token: client })).json.comments
  assert.equal(thread.find((c) => c.id === q.id).chosen_action, 'Merge')
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.payload.comment?.action === 'Merge')
  assert.equal(marker.payload.comment.reply_to, q.id); assert.equal(marker.payload.by, 'user')
  assert.deepEqual(wakeCalls, ['box-2'])
})

test('tap refusals: unknown label, unknown comment, reply_to without action, agent sender — nothing written', async (t) => {
  const { s, agent, client, id } = await fleet(t)
  const q = (await comment(s, agent.token, id, { body: 'Merge it?', actions: ['Merge'] })).json.comment
  const refused = async (token, body, status, error) => {
    const r = await comment(s, token, id, body)
    assert.equal(r.status, status, JSON.stringify(body))
    if (error) assert.deepEqual(r.json, { error })
  }
  await refused(client, { action: 'Nope', reply_to: q.id }, 400, 'unknown_action')
  await refused(client, { action: 'Merge', reply_to: 'ic_missing' }, 400, 'unknown_action')
  await refused(client, { action: 'Merge', reply_to: 7 }, 400, 'unknown_action')
  await refused(client, { body: 'typed', reply_to: q.id }, 400, 'unknown_action')
  // No reply_to: the item offers nothing, so the label is unknown there.
  await refused(client, { action: 'Merge' }, 400, 'unknown_action')
  await refused(agent.token, { action: 'Merge', reply_to: q.id }, 403, 'forbidden')
  const got = (await s.http(`/items/${id}`, { token: client })).json
  assert.equal(got.comments.length, 1); assert.equal(got.comments[0].chosen_action, null)
  assert.equal(got.item.awaiting, 'user')
})

test('a typed reply answers the question in words: awaiting→agent, no button marked', async (t) => {
  const { s, agent, client, id } = await fleet(t)
  const q = (await comment(s, agent.token, id, { body: 'Merge it?', actions: ['Merge'] })).json.comment
  const r = await comment(s, client, id, { body: 'Not yet, see my note' })
  assert.equal(r.json.item.awaiting, 'agent'); assert.equal(r.json.comment.reply_to, null)
  const thread = (await s.http(`/items/${id}`, { token: client })).json.comments
  assert.equal(thread.find((c) => c.id === q.id).chosen_action, null)
})

test('idempotent replay of a comment tap returns the original and marks nothing twice', async (t) => {
  const { s, agent, client, id } = await fleet(t)
  const q = (await comment(s, agent.token, id, { body: 'Merge it?', actions: ['Merge', 'Wait'] })).json.comment
  const h = { 'Idempotency-Key': 'tap-1' }
  const first = await comment(s, client, id, { action: 'Merge', reply_to: q.id }, h)
  const again = await comment(s, client, id, { action: 'Merge', reply_to: q.id }, h)
  assert.equal(first.status, 201); assert.equal(again.status, 200)
  assert.equal(again.json.comment.id, first.json.comment.id)
  assert.equal((await s.http(`/items/${id}`, { token: client })).json.comments.length, 2)
})

test('hello replay: a commented marker carries the comment\'s actions', async (t) => {
  const { s, agent, client, id } = await fleet(t)
  await comment(s, agent.token, id, { body: 'Merge it?', actions: ['Merge', 'Wait'] })
  const ws = await makeWsClient(s.base, { token: client, cursor: 0 })
  t.after(() => ws.close())
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === 'commented')
  assert.deepEqual(marker.payload.comment.actions, ['Merge', 'Wait'])
})
