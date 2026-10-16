// Notice items and the notices setting (mission: For you). A notice is
// something the user needs to read but not decide: it awaits the user with
// one built-in action, Seen, and the Seen tap closes it without waking
// anyone. Apps that don't announce the kind see a task, as before it
// existed. The notices setting lives beside it in user_settings.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { startTestServer, makeWsClient } from './helpers.js'
import { openDb, rebuildItemsForNotice } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { createItem, addComment, reopenItem, getItem } from '../src/items.js'
import { getNoticesEnabled, setNoticesEnabled } from '../src/settings.js'
import { eventKey, parseNotifyPrefs, allowedForUser } from '../src/notify.js'

const KINDS = { 'x-matron-item-kinds': 'notice' }

async function seed() {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const agent = createAgent(db, alice.id, 'box-2')
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: agent.deviceId })
  const notice = (o = {}) => createItem(db, { userId: alice.id, kind: 'notice', title: 'Deploy key expired', originConvoId: 'c1', originDeviceId: agent.deviceId, createdBy: 'agent', ...o }).item
  return { db, alice, agent, notice }
}

test('createItem: a notice awaits the user with the built-in Seen action', async () => {
  const { notice } = await seed()
  const n = notice({ actions: [] })
  assert.equal(n.kind, 'notice'); assert.equal(n.awaiting, 'user'); assert.equal(n.state, 'open')
  assert.deepEqual(n.actions, ['Seen']); assert.equal(n.chosen_action, null)
})

test('addComment: the Seen tap closes a notice as done; a second tap changes nothing; a typed reply goes to the agent', async () => {
  const { db, alice, agent, notice } = await seed()
  const n = notice()
  const out = addComment(db, { userId: alice.id, itemId: n.id, author: 'user', deviceId: 1, body: 'Seen', action: 'Seen' })
  assert.equal(out.seen, true); assert.equal(out.duplicate, false)
  assert.equal(out.item.state, 'closed'); assert.equal(out.item.resolution, 'done')
  assert.equal(out.item.awaiting, null); assert.equal(out.item.chosen_action, 'Seen')
  assert.deepEqual(out.status.meta.to, { state: 'closed', resolution: 'done', awaiting: null })
  assert.equal(out.status.meta.seen, true)
  const again = addComment(db, { userId: alice.id, itemId: n.id, author: 'user', deviceId: 1, body: 'Seen', action: 'Seen' })
  assert.equal(again.duplicate, true); assert.equal(again.comment, null)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM item_comments WHERE item_id=? AND kind='comment'").get(n.id).n, 1)

  const m = notice()
  const typed = addComment(db, { userId: alice.id, itemId: m.id, author: 'user', deviceId: 1, body: 'Which key?' })
  assert.equal(typed.seen, undefined)
  assert.equal(typed.item.state, 'open'); assert.equal(typed.item.awaiting, 'agent')
  // An agent's comment on a notice is an ordinary comment.
  const ac = addComment(db, { userId: alice.id, itemId: m.id, author: 'agent', deviceId: agent.deviceId, body: 'The host-a one' })
  assert.equal(ac.item.state, 'open')
})

test('reopenItem: a reopened notice awaits the user again with its Seen button live', async () => {
  const { db, alice, notice } = await seed()
  const n = notice()
  addComment(db, { userId: alice.id, itemId: n.id, author: 'user', deviceId: 1, body: 'Seen', action: 'Seen' })
  const r = reopenItem(db, { userId: alice.id, itemId: n.id, author: 'agent', deviceId: 1 })
  assert.equal(r.item.state, 'open'); assert.equal(r.item.awaiting, 'user'); assert.equal(r.item.chosen_action, null)
})

test('settings: notices reads on with no row, and follows the switch', async () => {
  const { db, alice } = await seed()
  assert.equal(getNoticesEnabled(db, alice.id), true)
  setNoticesEnabled(db, alice.id, false)
  assert.equal(getNoticesEnabled(db, alice.id), false)
  setNoticesEnabled(db, alice.id, true)
  assert.equal(getNoticesEnabled(db, alice.id), true)
})

test('notify: a notice push falls under its own "notices" switch, on in both presets and under "Needs me"', () => {
  assert.equal(eventKey({ kind: 'attention', question: true, notice: true }, {}), 'notices')
  assert.equal(eventKey({ kind: 'attention', question: true }, {}), 'questions')
  assert.equal(parseNotifyPrefs(null).events.notices, true)
  assert.equal(parseNotifyPrefs('{"mode":"all"}').events.notices, true)
  // A custom set stored before the key existed starts it from the 'all' preset.
  assert.equal(parseNotifyPrefs('{"mode":"custom","events":{"questions":false}}').events.notices, true)
  const off = parseNotifyPrefs('{"mode":"custom","events":{"notices":false}}').events
  assert.equal(allowedForUser('notices', off, null), false)
  assert.equal(allowedForUser('questions', off, null), true)
  assert.equal(allowedForUser('notices', off, { level: 'needs_me', mute_until: null }), true)
})

// --- migration -------------------------------------------------------------------

test('openDb: a database from before the kind is rebuilt once, keeping every row, column, index and comment link', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-mig-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'j.db')
  let db = openDb(file)
  const alice = await createUser(db, 'alice', 'pw')
  const agent = createAgent(db, alice.id, 'box-2')
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: agent.deviceId })
  const q = createItem(db, { userId: alice.id, kind: 'question', title: 'Ship it?', actions: ['Go'], originConvoId: 'c1', originDeviceId: agent.deviceId, createdBy: 'agent' }).item
  addComment(db, { userId: alice.id, itemId: q.id, author: 'agent', deviceId: agent.deviceId, body: 'context' })
  db.close()
  // Put the old CHECK back, as a pre-notice journal has it.
  const raw = new Database(file)
  const def = raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='items'").get().sql
  const idx = raw.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='items' AND sql IS NOT NULL").all().map((r) => r.sql)
  raw.pragma('foreign_keys = OFF')
  raw.exec(def.replace(/^CREATE TABLE items\(/, 'CREATE TABLE items_old(').replace("'decision','notice'", "'decision'"))
  raw.exec('INSERT INTO items_old SELECT * FROM items; DROP TABLE items; ALTER TABLE items_old RENAME TO items')
  for (const sql of idx) raw.exec(sql)
  raw.close()
  const old = new Database(file)
  assert.ok(!old.prepare("SELECT sql FROM sqlite_master WHERE name='items'").get().sql.includes("'notice'"))
  const indexesBefore = old.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='items' AND sql IS NOT NULL ORDER BY name").all().map((r) => r.name)
  old.close()

  db = openDb(file)
  assert.ok(db.prepare("SELECT sql FROM sqlite_master WHERE name='items'").get().sql.includes("'notice'"))
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='items' AND sql IS NOT NULL ORDER BY name").all().map((r) => r.name), indexesBefore)
  const kept = getItem(db, alice.id, q.id)
  assert.equal(kept.title, 'Ship it?'); assert.deepEqual(kept.actions, ['Go']); assert.equal(kept.comment_count, 1)
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check(item_comments)').all(), [])
  const n = createItem(db, { userId: alice.id, kind: 'notice', title: 'FYI', originConvoId: 'c1', originDeviceId: agent.deviceId, createdBy: 'agent' }).item
  assert.equal(n.kind, 'notice')
  assert.equal(rebuildItemsForNotice(db), false) // idempotent
  db.close()
})

// --- HTTP ------------------------------------------------------------------------

async function fleet(t) {
  const wakeCalls = []
  const waker = { enabled: true, wake: (name) => wakeCalls.push(name) }
  const s = await startTestServer({ waker })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const agent = createAgent(s.db, alice.id, 'box-2')
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: agent.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  return { s, alice, agent, client: login.json.token, wakeCalls }
}

const mkNotice = (s, token, body = {}) => s.http('/items', { method: 'POST', token, body: { kind: 'notice', title: 'Deploy key expired', convo_id: 'c1', ...body } })

test('POST /items: a notice takes no actions but its own', async (t) => {
  const { s, agent } = await fleet(t)
  const r = await mkNotice(s, agent.token)
  assert.equal(r.status, 201); assert.equal(r.json.item.kind, 'notice')
  assert.equal(r.json.item.awaiting, 'user'); assert.deepEqual(r.json.item.actions, ['Seen'])
  assert.equal((await mkNotice(s, agent.token, { actions: ['seen'] })).status, 201)
  assert.equal((await mkNotice(s, agent.token, { actions: [] })).status, 201)
  const bad = await mkNotice(s, agent.token, { actions: ['Seen', 'Later'] })
  assert.equal(bad.status, 400); assert.deepEqual(bad.json, { error: 'invalid_actions' })
  const patch = await s.http(`/items/${r.json.item.id}`, { method: 'PATCH', token: agent.token, body: { actions: ['Go'] } })
  assert.equal(patch.status, 400); assert.deepEqual(patch.json, { error: 'invalid_actions' })
  assert.equal((await s.http(`/items/${r.json.item.id}`, { method: 'PATCH', token: agent.token, body: { title: 'Deploy key expired on host-a' } })).status, 200)
  for (const actions of [[], ['seen'], ['Seen']]) {
    const p = await s.http(`/items/${r.json.item.id}`, { method: 'PATCH', token: agent.token, body: { actions } })
    assert.equal(p.status, 200, JSON.stringify(actions)); assert.deepEqual(p.json.item.actions, ['Seen'])
  }
})

test('an app that does not announce the kind sees a notice as a task; agents and announcing apps see the real kind', async (t) => {
  const { s, agent, client } = await fleet(t)
  const id = (await mkNotice(s, agent.token)).json.item.id
  const legacyOne = await s.http(`/items/${id}`, { token: client })
  assert.equal(legacyOne.json.item.kind, 'task'); assert.deepEqual(legacyOne.json.item.actions, ['Seen'])
  assert.equal(legacyOne.json.item.awaiting, 'user')
  const legacyList = await s.http('/items', { token: client })
  assert.equal(legacyList.json.items.find((i) => i.id === id).kind, 'task')
  // Its kind=task filter finds them too, and a kind=notice filter still works for those that know.
  assert.deepEqual((await s.http('/items?kind=task', { token: client })).json.items.map((i) => [i.id, i.kind]), [[id, 'task']])
  assert.deepEqual((await s.http('/items?kind=task', { token: client, headers: KINDS })).json.items, [])
  assert.equal((await s.http('/items?kind=notice', { token: client, headers: KINDS })).json.items.length, 1)
  assert.equal((await s.http(`/items/${id}`, { token: client, headers: KINDS })).json.item.kind, 'notice')
  assert.equal((await s.http('/items', { token: client, headers: { 'x-matron-item-kinds': 'foo, Notice' } })).json.items.find((i) => i.id === id).kind, 'notice')
  assert.equal((await s.http(`/items/${id}`, { token: agent.token })).json.item.kind, 'notice')
  assert.equal((await s.http('/items?kind=notice', { token: agent.token })).json.items.length, 1)
})

test('the Seen tap (even from an old app) closes the notice with one quiet marker: no wake, no fallback text', async (t) => {
  const { s, agent, client, wakeCalls } = await fleet(t)
  const id = (await mkNotice(s, agent.token)).json.item.id
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  const hello = await ws.waitFor((f) => f.op === 'hello_ok')
  assert.deepEqual(hello.settings, { notices: true, auto_approve_coordinator_spawns: false })
  // No header: an app from before the kind, tapping the Seen button it renders.
  const r = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: { action: 'Seen' } })
  assert.equal(r.status, 201)
  assert.equal(r.json.item.state, 'closed'); assert.equal(r.json.item.resolution, 'done'); assert.equal(r.json.item.kind, 'task')
  assert.equal(r.json.comment.action, 'Seen')
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === 'closed')
  assert.equal(marker.payload.seen, true); assert.equal(marker.payload.by, 'user'); assert.equal(marker.payload.resolution, 'done')
  await new Promise((res) => setTimeout(res, 100))
  assert.equal(ws.journal().filter((f) => f.type === 'item' && f.payload.action === 'commented').length, 0)
  assert.equal(ws.journal().filter((f) => f.type === 'text' && f.payload.fallback_for === 'item' && f.payload.item_id === id).length, 0)
  assert.deepEqual(wakeCalls, [])
  const again = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: { action: 'Seen' }, headers: KINDS })
  assert.equal(again.status, 200); assert.equal(again.json.item.state, 'closed'); assert.equal(again.json.item.kind, 'notice')
  ws.close()
  // A typed reply does go to the agent, waking its box.
  const id2 = (await mkNotice(s, agent.token)).json.item.id
  const typed = await s.http(`/items/${id2}/comments`, { method: 'POST', token: client, body: { body: 'Which key?' } })
  assert.equal(typed.json.item.awaiting, 'agent')
  assert.deepEqual(wakeCalls, ['box-2'])
  // An agent cannot tap Seen for the user.
  assert.equal((await s.http(`/items/${id2}/comments`, { method: 'POST', token: agent.token, body: { action: 'Seen' } })).status, 403)
})

test('GET/PATCH /settings: anyone reads, only the user writes; a change reaches every socket and the next hello_ok', async (t) => {
  const { s, agent, client } = await fleet(t)
  assert.deepEqual((await s.http('/settings', { token: agent.token })).json, { notices: true, auto_approve_coordinator_spawns: false })
  assert.deepEqual((await s.http('/settings', { token: client })).json, { notices: true, auto_approve_coordinator_spawns: false })
  assert.equal((await s.http('/settings', { method: 'PATCH', token: agent.token, body: { notices: false } })).status, 403)
  for (const body of [{}, { notices: 'no' }, { notices: false, other: 1 }]) {
    assert.equal((await s.http('/settings', { method: 'PATCH', token: client, body })).status, 400, JSON.stringify(body))
  }
  const bridge = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await bridge.waitFor((f) => f.op === 'hello_ok')
  const r = await s.http('/settings', { method: 'PATCH', token: client, body: { notices: false } })
  assert.equal(r.status, 200); assert.deepEqual(r.json, { notices: false, auto_approve_coordinator_spawns: false })
  const frame = await bridge.waitFor((f) => f.kind === 'control' && f.op === 'settings')
  assert.deepEqual(frame.settings, { notices: false, auto_approve_coordinator_spawns: false })
  bridge.close()
  const next = await makeWsClient(s.base, { token: agent.token, cursor: null })
  assert.deepEqual((await next.waitFor((f) => f.op === 'hello_ok')).settings, { notices: false, auto_approve_coordinator_spawns: false })
  next.close()
  assert.deepEqual((await s.http('/settings', { token: client })).json, { notices: false, auto_approve_coordinator_spawns: false })
})
