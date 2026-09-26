// Item action buttons (contract: .followups/item-actions-contract.md,
// "Journal"). An agent attaches up to four one-tap answers to an item; the
// user taps one, which is exactly a user comment whose body is the label,
// plus `meta.action` on the comment and `chosen_action` on the item.
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
import { createItem, addComment, updateItem, validateItemFields, getItem } from '../src/items.js'
import { itemMarkerPayload } from '../src/items-marker.js'

// --- validation ---------------------------------------------------------------

test('validateItemFields: actions are trimmed, bounded, single-line and case-insensitively unique', () => {
  const ok = (actions) => validateItemFields({ title: 't', actions })
  assert.deepEqual(ok([' Go ', 'Stop']).value.actions, ['Go', 'Stop'])
  assert.deepEqual(ok([]).value.actions, [])
  assert.deepEqual(ok(['a', 'b', 'c', 'd']).value.actions, ['a', 'b', 'c', 'd'])
  assert.deepEqual(ok(['x'.repeat(40)]).value.actions, ['x'.repeat(40)])
  assert.equal(validateItemFields({ title: 't' }).value.actions, undefined) // absent stays absent
  for (const bad of [
    ['a', 'b', 'c', 'd', 'e'], // more than four
    [''], ['   '], // empty after trim
    ['x'.repeat(41)], // too long
    ['two\nlines'], ['tab\there'], ['bell\u0007'], ['del\u007f'], ['sep\u2028x'], // newline / control
    ['Go', 'go'], ['Go', ' GO '], // case-insensitive duplicate
    [1], [null], [['Go']], // not strings
    'Go', null, {}, // not an array
  ]) {
    const v = ok(bad)
    assert.equal(v.ok, false, `accepted ${JSON.stringify(bad)}`)
    assert.equal(v.error, 'invalid_actions', `wrong error for ${JSON.stringify(bad)}`)
  }
})

// --- pure state ---------------------------------------------------------------

async function seed() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const agent = createAgent(db, dan.id, 'dev-2')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  const base = (o = {}) => ({ userId: dan.id, kind: 'question', title: 'Ship it?', originConvoId: 'c1', originDeviceId: agent.deviceId, createdBy: 'agent', ...o })
  return { db, dan, agent, base }
}

test('createItem / getItem: actions default to [] and chosen_action to null', async () => {
  const { db, dan, base } = await seed()
  const plain = createItem(db, base()).item
  assert.deepEqual(plain.actions, []); assert.equal(plain.chosen_action, null)
  const withActions = createItem(db, base({ actions: ['Go', 'Wait'] })).item
  assert.deepEqual(withActions.actions, ['Go', 'Wait'])
  assert.deepEqual(getItem(db, dan.id, withActions.id).actions, ['Go', 'Wait'])
})

test('addComment with an action: meta.action, comment.action, chosen_action — in one write', async () => {
  const { db, dan, base } = await seed()
  const it = createItem(db, base({ actions: ['Go', 'Wait'] })).item
  const r = addComment(db, { userId: dan.id, itemId: it.id, author: 'user', deviceId: 9, body: 'Go', action: 'Go' })
  assert.deepEqual(r.comment.meta, { action: 'Go' }); assert.equal(r.comment.action, 'Go')
  assert.equal(r.item.chosen_action, 'Go'); assert.equal(r.item.awaiting, 'agent')
  // The most recent action wins; a plain comment leaves the choice alone.
  const w = addComment(db, { userId: dan.id, itemId: it.id, author: 'user', deviceId: 9, body: 'Wait', action: 'Wait' })
  assert.equal(w.item.chosen_action, 'Wait')
  const plain = addComment(db, { userId: dan.id, itemId: it.id, author: 'user', deviceId: 9, body: 'hmm' })
  assert.equal(plain.comment.action, null); assert.equal(plain.comment.meta, null)
  assert.equal(plain.item.chosen_action, 'Wait')
  // A label that is not one of the item's CURRENT actions is refused inside
  // the transaction, and nothing is written.
  const before = db.prepare('SELECT COUNT(*) n FROM item_comments').get().n
  assert.throws(() => addComment(db, { userId: dan.id, itemId: it.id, author: 'user', deviceId: 9, body: 'x', action: 'Nope' }), /unknown_action/)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM item_comments').get().n, before)
})

test('updateItem: changing actions clears chosen_action; re-sending the same list keeps it', async () => {
  const { db, dan, base } = await seed()
  const it = createItem(db, base({ actions: ['Go', 'Wait'] })).item
  addComment(db, { userId: dan.id, itemId: it.id, author: 'user', deviceId: 9, body: 'Go', action: 'Go' })
  assert.equal(updateItem(db, { userId: dan.id, itemId: it.id, fields: { title: 'Retitled' } }).chosen_action, 'Go')
  assert.equal(updateItem(db, { userId: dan.id, itemId: it.id, fields: { actions: ['Go', 'Wait'] } }).chosen_action, 'Go')
  const changed = updateItem(db, { userId: dan.id, itemId: it.id, fields: { actions: ['Go', 'Later'] } })
  assert.deepEqual(changed.actions, ['Go', 'Later']); assert.equal(changed.chosen_action, null)
  const cleared = updateItem(db, { userId: dan.id, itemId: it.id, fields: { actions: [] } })
  assert.deepEqual(cleared.actions, []); assert.equal(cleared.chosen_action, null)
})

test('itemMarkerPayload carries actions, chosen_action and the comment\'s action', async () => {
  const { db, dan, base } = await seed()
  const it = createItem(db, base({ actions: ['Go'] })).item
  const created = itemMarkerPayload({ item: it, action: 'created', by: 'agent' })
  assert.deepEqual(created.actions, ['Go']); assert.equal(created.chosen_action, null)
  const r = addComment(db, { userId: dan.id, itemId: it.id, author: 'user', deviceId: 9, body: 'Go', action: 'Go' })
  const p = itemMarkerPayload({ item: r.item, action: 'commented', by: 'user', comment: r.comment })
  assert.equal(p.chosen_action, 'Go'); assert.equal(p.comment.action, 'Go')
  const plain = addComment(db, { userId: dan.id, itemId: it.id, author: 'user', deviceId: 9, body: 'hmm' })
  assert.equal(itemMarkerPayload({ item: plain.item, action: 'commented', by: 'user', comment: plain.comment }).comment.action, null)
})

test('openDb adds actions / chosen_action to a pre-existing items table; old rows read as [] / null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-actions-migration-'))
  const dbPath = path.join(dir, 'pre.db')
  const db0 = openDb(dbPath)
  db0.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  db0.close()
  // Rewind the file to the pre-actions schema.
  const raw = new Database(dbPath)
  raw.exec('ALTER TABLE items DROP COLUMN actions')
  raw.exec('ALTER TABLE items DROP COLUMN chosen_action')
  raw.prepare(`INSERT INTO items(id,user_id,num,kind,state,rank,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at)
    VALUES('it_old',1,1,'task','open',1024,'t','c1',1,'user',0,0)`).run()
  raw.close()
  const db = openDb(dbPath)
  const cols = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name)
  assert.ok(cols.includes('actions')); assert.ok(cols.includes('chosen_action'))
  const old = getItem(db, 1, 'it_old')
  assert.deepEqual(old.actions, []); assert.equal(old.chosen_action, null)
  db.close()
  openDb(dbPath).close() // re-opening an already-migrated file is a no-op
  fs.rmSync(dir, { recursive: true, force: true })
})

// --- HTTP ----------------------------------------------------------------------

async function fleet(t) {
  const wakeCalls = []
  const waker = { enabled: true, wake: (name) => wakeCalls.push(name) }
  const s = await startTestServer({ waker })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  return { s, dan, agent, client: login.json.token, wakeCalls }
}

const mkItem = (s, token, body) => s.http('/items', { method: 'POST', token, body: { kind: 'question', title: 'Ship it?', convo_id: 'c1', ...body } })
const comment = (s, token, id, body, headers) => s.http(`/items/${id}/comments`, { method: 'POST', token, body, headers })

test('POST /items and PATCH /items/:id: actions validated with invalid_actions; serialized on every read', async (t) => {
  const { s, agent, client } = await fleet(t)
  const r = await mkItem(s, agent.token, { actions: ['Go', ' Wait '] })
  assert.equal(r.status, 201)
  assert.deepEqual(r.json.item.actions, ['Go', 'Wait']); assert.equal(r.json.item.chosen_action, null)
  const id = r.json.item.id
  const bad = await mkItem(s, agent.token, { actions: ['Go', 'GO'] })
  assert.equal(bad.status, 400); assert.deepEqual(bad.json, { error: 'invalid_actions' })
  assert.equal((await mkItem(s, agent.token, { actions: 'Go' })).json.error, 'invalid_actions')
  // No actions given: the field is still there, empty.
  const plain = await mkItem(s, agent.token, {})
  assert.deepEqual(plain.json.item.actions, []); assert.equal(plain.json.item.chosen_action, null)
  // Every read path carries the pair.
  const one = await s.http(`/items/${id}`, { token: client })
  assert.deepEqual(one.json.item.actions, ['Go', 'Wait']); assert.equal(one.json.item.chosen_action, null)
  const list = await s.http('/items', { token: client })
  assert.deepEqual(list.json.items.find((i) => i.id === id).actions, ['Go', 'Wait'])
  assert.ok(list.json.items.every((i) => Array.isArray(i.actions) && 'chosen_action' in i))
  // PATCH: anyone who may PATCH may set them — the agent and the user alike.
  const p1 = await s.http(`/items/${id}`, { method: 'PATCH', token: agent.token, body: { actions: ['Go'] } })
  assert.equal(p1.status, 200); assert.deepEqual(p1.json.item.actions, ['Go'])
  const p2 = await s.http(`/items/${id}`, { method: 'PATCH', token: client, body: { actions: [] } })
  assert.equal(p2.status, 200); assert.deepEqual(p2.json.item.actions, [])
  const p3 = await s.http(`/items/${id}`, { method: 'PATCH', token: agent.token, body: { actions: ['a', 'b', 'c', 'd', 'e'] } })
  assert.equal(p3.status, 400); assert.deepEqual(p3.json, { error: 'invalid_actions' })
  assert.deepEqual((await s.http(`/items/${id}`, { token: client })).json.item.actions, []) // the rejected patch wrote nothing
})

test('action comment: body defaults to the label, meta.action + chosen_action, awaiting→agent, marker + wake + push path unchanged', async (t) => {
  const { s, agent, client, wakeCalls } = await fleet(t)
  const id = (await mkItem(s, agent.token, { actions: ['Go', 'Wait'] })).json.item.id
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await comment(s, client, id, { action: ' Go ' })
  assert.equal(r.status, 201)
  assert.equal(r.json.comment.body, 'Go'); assert.equal(r.json.comment.action, 'Go')
  assert.deepEqual(r.json.comment.meta, { action: 'Go' })
  assert.equal(r.json.item.chosen_action, 'Go'); assert.equal(r.json.item.awaiting, 'agent')
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === 'commented')
  assert.equal(marker.sender, 'user:dan'); assert.equal(marker.payload.by, 'user')
  assert.equal(marker.payload.comment.body, 'Go'); assert.equal(marker.payload.comment.action, 'Go')
  assert.deepEqual(marker.payload.actions, ['Go', 'Wait']); assert.equal(marker.payload.chosen_action, 'Go')
  // Old clients: the fallback text is the ordinary commented mirror, body = label.
  const fb = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.fallback_for === 'item' && f.payload.action === 'commented')
  assert.match(fb.payload.body, /\nGo$/)
  ws.close()
  assert.deepEqual(wakeCalls, ['dev-2'])
  // An explicit body is kept; the action still rides along.
  const w = await comment(s, client, id, { body: 'Wait, hold on until Monday', action: 'Wait' })
  assert.equal(w.status, 201); assert.equal(w.json.comment.body, 'Wait, hold on until Monday')
  assert.equal(w.json.comment.action, 'Wait'); assert.equal(w.json.item.chosen_action, 'Wait')
  // GET exposes action on each comment (null on ordinary ones).
  await comment(s, agent.token, id, { body: 'ok' })
  const got = await s.http(`/items/${id}`, { token: client })
  assert.deepEqual(got.json.comments.map((c) => c.action), ['Go', 'Wait', null])
  assert.equal(got.json.item.chosen_action, 'Wait')
})

test('action comment on a CLOSED item reopens it like any user comment', async (t) => {
  const { s, agent, client } = await fleet(t)
  const id = (await mkItem(s, agent.token, { actions: ['Go'] })).json.item.id
  assert.equal((await s.http(`/items/${id}/close`, { method: 'POST', token: agent.token, body: { resolution: 'answered' } })).status, 200)
  const r = await comment(s, client, id, { action: 'Go' })
  assert.equal(r.status, 201); assert.equal(r.json.item.state, 'open'); assert.equal(r.json.item.awaiting, 'agent')
  assert.equal(r.json.item.chosen_action, 'Go')
})

test('unknown_action: not one of the item\'s current actions (after trim), case-sensitive, nothing written', async (t) => {
  const { s, agent, client } = await fleet(t)
  const id = (await mkItem(s, agent.token, { actions: ['Go'] })).json.item.id
  const noActions = (await mkItem(s, agent.token, {})).json.item.id
  const before = s.db.prepare("SELECT COUNT(*) n FROM events WHERE type='item'").get().n
  for (const [itemId, action] of [[id, 'Stop'], [id, 'go'], [id, ''], [id, 7], [noActions, 'Go']]) {
    const r = await comment(s, client, itemId, { body: 'x', action })
    assert.equal(r.status, 400, `accepted ${JSON.stringify(action)}`)
    assert.deepEqual(r.json, { error: 'unknown_action' })
  }
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM item_comments WHERE kind='comment'").get().n, 0)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE type='item'").get().n, before)
  // null is "no action": an ordinary comment.
  const plain = await comment(s, client, id, { body: 'x', action: null })
  assert.equal(plain.status, 201); assert.equal(plain.json.comment.action, null)
})

test('an agent may not send action', async (t) => {
  const { s, dan, agent } = await fleet(t)
  const id = (await mkItem(s, agent.token, { actions: ['Go'] })).json.item.id
  const r = await comment(s, agent.token, id, { body: 'Go', action: 'Go' })
  assert.equal(r.status, 403); assert.deepEqual(r.json, { error: 'forbidden' })
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM item_comments WHERE kind='comment'").get().n, 0)
  assert.equal(getItem(s.db, dan.id, id).chosen_action, null)
})

test('PATCH actions clears chosen_action (and says so on the updated marker); the same list keeps it', async (t) => {
  const { s, agent, client } = await fleet(t)
  const id = (await mkItem(s, agent.token, { actions: ['Go', 'Wait'] })).json.item.id
  await comment(s, client, id, { action: 'Go' })
  const same = await s.http(`/items/${id}`, { method: 'PATCH', token: agent.token, body: { title: 'Ship it now?', actions: ['Go', 'Wait'] } })
  assert.equal(same.json.item.chosen_action, 'Go')
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const p = await s.http(`/items/${id}`, { method: 'PATCH', token: agent.token, body: { actions: ['Ship', 'Hold'] } })
  assert.equal(p.status, 200); assert.equal(p.json.item.chosen_action, null)
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === 'updated' && f.payload.chosen_action === null)
  assert.deepEqual(marker.payload.actions, ['Ship', 'Hold'])
  ws.close()
  // The old label is no longer tappable.
  assert.equal((await comment(s, client, id, { action: 'Go' })).json.error, 'unknown_action')
})

test('idempotent replay of an action comment returns the original, even after the actions changed', async (t) => {
  const { s, agent, client } = await fleet(t)
  const id = (await mkItem(s, agent.token, { actions: ['Go'] })).json.item.id
  const h = { 'idempotency-key': 'tap-1' }
  const a = await comment(s, client, id, { action: 'Go' }, h)
  await s.http(`/items/${id}`, { method: 'PATCH', token: agent.token, body: { actions: ['Other'] } })
  const b = await comment(s, client, id, { action: 'Go' }, h)
  assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(b.json.comment.id, a.json.comment.id)
})

test('hello replay: item markers carry actions and chosen_action', async (t) => {
  const { s, agent, client } = await fleet(t)
  const id = (await mkItem(s, agent.token, { actions: ['Go'] })).json.item.id
  await comment(s, client, id, { action: 'Go' })
  const ws = await makeWsClient(s.base, { token: client, cursor: 0 })
  const created = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === 'created')
  assert.deepEqual(created.payload.actions, ['Go']); assert.equal(created.payload.chosen_action, null)
  const commented = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === 'commented')
  assert.equal(commented.payload.chosen_action, 'Go'); assert.equal(commented.payload.comment.action, 'Go')
  ws.close()
})

test('a consent mirror refuses action writes from agents (404, like every other mutation); its user may set them', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const { item } = createItem(s.db, {
    userId: dan.id, kind: 'question', title: 'Spawn consent ask', awaiting: 'user',
    originConvoId: 'c1', originDeviceId: agent.deviceId, createdBy: 'agent', consent: 'spawn',
  })
  assert.equal((await s.http(`/items/${item.id}`, { method: 'PATCH', token: agent.token, body: { actions: ['Approve'] } })).status, 404)
  assert.equal((await comment(s, agent.token, item.id, { body: 'x', action: 'Approve' })).status, 404)
  assert.deepEqual(getItem(s.db, dan.id, item.id).actions, [])
  const p = await s.http(`/items/${item.id}`, { method: 'PATCH', token: client, body: { actions: ['Approve'] } })
  assert.equal(p.status, 200); assert.deepEqual(p.json.item.actions, ['Approve'])
})
