import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append, snapshot } from '../src/journal.js'
import {
  archiveChanges, setArchived, autoArchiveCandidates, runAutoArchive, getAutoArchiveDays, setAutoArchiveDays,
} from '../src/archive.js'
import { upsertPin } from '../src/pins.js'
import { createItem } from '../src/items.js'
import { createMission } from '../src/missions.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { startTestServer, makeWsClient } from './helpers.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_000 * DAY
const at = (db, id, createdAt) => db.prepare('UPDATE conversations SET created_at=? WHERE id=?').run(createdAt, id)

async function seedDb() {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const bob = await createUser(db, 'bob', 'pw')
  const box = createAgent(db, alice.id, 'box-a')
  for (const id of ['old', 'fresh', 'pinned', 'coord', 'item', 'mission', 'running', 'child', 'sys']) {
    upsertConversation(db, { id, ownerUserId: alice.id, title: id, agentDeviceId: box.deviceId })
    at(db, id, NOW - 60 * DAY)
  }
  upsertConversation(db, { id: 'b1', ownerUserId: bob.id, title: 'B1' })
  at(db, 'fresh', NOW - 2 * DAY)
  db.prepare("UPDATE conversations SET session_state='done'").run()
  db.prepare("UPDATE conversations SET session_state='running' WHERE id='running'").run()
  db.prepare("UPDATE conversations SET parent_convo_id='old' WHERE id='child'").run()
  db.prepare("UPDATE conversations SET system='x' WHERE id='sys'").run()
  upsertPin(db, alice.id, 'pinned', { label: 'Desk' })
  setCoordinatorConvoId(db, alice.id, 'coord')
  createItem(db, { userId: alice.id, kind: 'task', title: 'T', originConvoId: 'item', originDeviceId: box.deviceId, createdBy: 'agent' })
  createMission(db, { userId: alice.id, deviceId: box.deviceId, createdBy: 'agent', convoId: 'mission', title: 'M' })
  return { db, alice, bob, box }
}

test('archive: set, unarchive, ownership, idempotence and since-changes', async () => {
  const { db, alice } = await seedDb()
  assert.deepEqual(archiveChanges(db, alice.id), { changes: [], at: 0 })
  const made = setArchived(db, alice.id, ['old', 'old', 'b1', 'nope'], true, { now: 100 })
  assert.deepEqual(made, [{ convo_id: 'old', archived_at: 100, auto: false }], "bob's and unknown ids are skipped, duplicates once")
  assert.deepEqual(setArchived(db, alice.id, ['old'], true, { now: 101 }), [], 'already archived: no change')
  assert.deepEqual(archiveChanges(db, alice.id).changes.map((c) => c.convo_id), ['old'])
  setArchived(db, alice.id, ['old'], false, { now: 200 })
  assert.deepEqual(archiveChanges(db, alice.id).changes, [], 'no since: archived now only')
  assert.deepEqual(archiveChanges(db, alice.id, 150), { changes: [{ convo_id: 'old', archived_at: null, auto: false }], at: 200 })
  assert.deepEqual(archiveChanges(db, alice.id, 201).changes, [])
})

test('archive: a message unarchives, in the same append; a child or a status does not', async () => {
  const { db, alice } = await seedDb()
  setArchived(db, alice.id, ['old', 'child'], true, { now: 100 })
  let r = append(db, { userId: alice.id, convoId: 'old', sender: 'agent:1', type: 'session_status', payload: { state: 'done' } })
  assert.equal(r.unarchived, undefined)
  r = append(db, { userId: alice.id, convoId: 'child', sender: 'agent:1', type: 'text', payload: { body: 'x' } })
  assert.equal(r.unarchived, undefined, 'sub-chats stay as they are')
  r = append(db, { userId: alice.id, convoId: 'old', sender: 'agent:1', type: 'text', payload: { body: 'back' } })
  assert.deepEqual(r.unarchived, { convo_id: 'old', archived_at: null, auto: false })
  const snap = snapshot(db, alice.id)
  assert.equal('archived_at' in snap.conversations.find((c) => c.id === 'old'), false, 'no key when not archived')
  assert.equal(snap.conversations.find((c) => c.id === 'child').archived_at, 100)
})

test('auto-archive: idle conversations only, with every exemption', async () => {
  const { db, alice, bob } = await seedDb()
  assert.equal(getAutoArchiveDays(db, alice.id), 30)
  assert.deepEqual(autoArchiveCandidates(db, alice.id, 30, NOW), ['old'])
  // A recent message keeps it; so does a recent unarchive.
  at(db, 'fresh', Date.now() + 100 * DAY) // keep it out of the real-clock checks below
  // A sub-chat still working, or recently active, keeps its parent.
  db.prepare("UPDATE conversations SET session_state='running' WHERE id='child'").run()
  assert.deepEqual(autoArchiveCandidates(db, alice.id, 30, NOW), [])
  db.prepare("UPDATE conversations SET session_state='done' WHERE id='child'").run()
  append(db, { userId: alice.id, convoId: 'child', sender: 'agent:1', type: 'text', payload: { body: 'sub' } })
  assert.deepEqual(autoArchiveCandidates(db, alice.id, 30, Date.now() + DAY), [])
  append(db, { userId: alice.id, convoId: 'old', sender: 'agent:1', type: 'text', payload: { body: 'hi' } })
  assert.deepEqual(autoArchiveCandidates(db, alice.id, 30, Date.now() + DAY), [])
  assert.deepEqual(autoArchiveCandidates(db, alice.id, 30, Date.now() + 31 * DAY), ['old'])
  setArchived(db, alice.id, ['old'], true, { now: Date.now() + 31 * DAY })
  setArchived(db, alice.id, ['old'], false, { now: Date.now() + 32 * DAY })
  assert.deepEqual(autoArchiveCandidates(db, alice.id, 30, Date.now() + 40 * DAY), [], 'unarchive restarts the clock')
  // A closed mission no longer exempts.
  db.prepare("UPDATE missions SET state='closed'").run()
  db.prepare("UPDATE items SET state='closed'").run()
  assert.deepEqual(autoArchiveCandidates(db, alice.id, 30, NOW).sort(), ['item', 'mission'])
  at(db, 'fresh', NOW - 2 * DAY)
  // Off, and per-user.
  setAutoArchiveDays(db, alice.id, 0)
  setAutoArchiveDays(db, bob.id, 0)
  assert.equal(runAutoArchive(db, NOW).size, 0)
  setAutoArchiveDays(db, alice.id, 30)
  const out = runAutoArchive(db, NOW)
  assert.deepEqual(out.get(alice.id).map((c) => [c.convo_id, c.auto]).sort(), [['item', true], ['mission', true]])
  // Each user is reported as soon as it commits; a failing user is logged and skipped.
  setArchived(db, alice.id, ['item', 'mission'], false, { now: NOW - 40 * DAY })
  setAutoArchiveDays(db, bob.id, 30)
  const seen = []
  const errors = []
  const failing = new Proxy(db, { get: (t, k) => k === 'prepare'
    ? (sql) => { if (sql.includes('LEFT JOIN convo_archive a ON') && seen.length) throw new Error('disk'); return t.prepare(sql) }
    : (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) })
  const out2 = runAutoArchive(failing, NOW, { onUser: (u, c) => seen.push([u, c.length]), log: { error: (m) => errors.push(m) } })
  assert.deepEqual(seen, [[alice.id, 2]])
  assert.equal(out2.size, 1)
  assert.equal(errors.length, 1, "bob's failure is logged")
  assert.deepEqual(runAutoArchive(db, NOW).size, 0, 'a second pass changes nothing')
})

async function fleet(t) {
  const s = await startTestServer({})
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const box = createAgent(s.db, alice.id, 'box-a')
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: box.deviceId })
  upsertConversation(s.db, { id: 'c2', ownerUserId: alice.id, title: 'C2', agentDeviceId: box.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  return { s, alice, box, client: login.json.token }
}

test('/archive: client only, validation, live frame, hello and settings', async (t) => {
  const { s, box, client } = await fleet(t)
  assert.equal((await s.http('/archive')).status, 401)
  assert.equal((await s.http('/archive', { token: box.token })).status, 403)
  for (const body of [{}, { convo_ids: [], archived: true }, { convo_ids: ['c1'] }, { convo_ids: [1], archived: true }, { convo_ids: ['c1'], archived: 'yes' }]) {
    assert.equal((await s.http('/archive', { method: 'POST', token: client, body })).status, 400, JSON.stringify(body))
  }
  assert.equal((await s.http('/archive?since=-1', { token: client })).status, 400)

  const ws = await makeWsClient(s.base, { token: client })
  await ws.waitFor((f) => f.op === 'hello_ok')
  assert.equal(ws.frames.find((f) => f.op === 'hello_ok').archive, undefined, 'only sent when asked for')
  const r = await s.http('/archive', { method: 'POST', token: client, body: { convo_ids: ['c1', 'c2'], archived: true } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.changes.map((c) => c.convo_id), ['c1', 'c2'])
  const frame = await ws.waitFor((f) => f.kind === 'archive')
  assert.deepEqual(frame.changes.map((c) => c.convo_id), ['c1', 'c2'])
  ws.close()

  const got = await s.http('/archive', { token: client })
  assert.deepEqual(got.json.changes.map((c) => c.convo_id), ['c1', 'c2'])
  assert.equal(got.json.auto_archive_days, 30)

  // Settings.
  assert.equal((await s.http('/settings', { method: 'PATCH', token: client, body: { auto_archive_days: -1 } })).status, 400)
  const set = await s.http('/settings', { method: 'PATCH', token: client, body: { auto_archive_days: 0 } })
  assert.deepEqual(set.json, { notices: true, auto_approve_coordinator_spawns: false, auto_archive_days: 0 })
})

test('hello archive_since: changes since, and a message unarchives live', async (t) => {
  const { s, alice, client } = await fleet(t)
  setArchived(s.db, alice.id, ['c1'], true, { now: 100 })
  setArchived(s.db, alice.id, ['c2'], true, { now: 300 })
  const WebSocket = (await import('ws')).default
  const ws = new WebSocket(s.base.replace('http', 'ws') + '/ws')
  const frames = []
  ws.on('message', (d) => frames.push(JSON.parse(d)))
  await new Promise((r) => ws.on('open', r))
  ws.send(JSON.stringify({ op: 'hello', token: client, archive_since: 200 }))
  const until = async (pred) => { for (let i = 0; i < 200; i++) { const f = frames.find(pred); if (f) return f; await new Promise((r) => setTimeout(r, 10)) } throw new Error('timeout') }
  const hello = await until((f) => f.op === 'hello_ok')
  assert.deepEqual(hello.archive, { changes: [{ convo_id: 'c2', archived_at: 300, auto: false }], at: 300 })
  await new Promise((r) => setTimeout(r, 50))
  const { appendAndBroadcast } = await import('../src/journal.js')
  appendAndBroadcast(s.db, s.hub, { userId: alice.id, convoId: 'c2', sender: 'agent:1', type: 'text', payload: { body: 'news' } })
  const live = await until((f) => f.kind === 'archive')
  assert.deepEqual(live.changes, [{ convo_id: 'c2', archived_at: null, auto: false }])
  ws.close()
})
