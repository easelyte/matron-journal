import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { setCoordinatorConvoId, COORDINATOR_EVENT_TYPE } from '../src/coordinator.js'
import { ITEM_EVENT_TYPE } from '../src/items-marker.js'
import { MISSION_EVENT_TYPE, MILESTONE_EVENT_TYPE } from '../src/missions-marker.js'
import { MEMORY_EVENT_TYPE } from '../src/memories-http.js'
import { ROUTINE_EVENT_TYPE } from '../src/routines-marker.js'
import { FOR_YOU_EVENT_TYPES, parseSyncScope, scopeCarries, noteCoordinator, wakesForYou } from '../src/sync-scope.js'

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

test('the marker names sync-scope.js spells out match their modules', () => {
  for (const t of [ITEM_EVENT_TYPE, MISSION_EVENT_TYPE, MILESTONE_EVENT_TYPE, COORDINATOR_EVENT_TYPE, MEMORY_EVENT_TYPE, ROUTINE_EVENT_TYPE]) {
    assert.ok(FOR_YOU_EVENT_TYPES.includes(t), t)
  }
})

test('parseSyncScope: absent, null and everything are the default; junk is refused', () => {
  assert.equal(parseSyncScope(undefined), null)
  assert.equal(parseSyncScope(null), null)
  assert.equal(parseSyncScope('everything'), null)
  assert.equal(parseSyncScope('for_you'), 'for_you')
  assert.equal(parseSyncScope('FOR_YOU'), undefined)
  assert.equal(parseSyncScope(1), undefined)
})

test('scopeCarries: markers, the Coordinator and viewed chats only', () => {
  const conn = { syncScope: 'for_you', coordinatorConvoId: 'coord', viewingConvoIds: new Set(['open']) }
  assert.equal(scopeCarries(conn, { type: 'text', convo_id: 'other' }), false)
  assert.equal(scopeCarries(conn, { type: 'tool_output', convo_id: 'other' }), false)
  assert.equal(scopeCarries(conn, { type: 'read_marker', convo_id: 'other' }), false)
  assert.equal(scopeCarries(conn, { type: 'item', convo_id: 'other' }), true)
  assert.equal(scopeCarries(conn, { type: 'convo_meta', convo_id: 'other' }), true)
  assert.equal(scopeCarries(conn, { type: 'session_status', convo_id: 'other' }), true)
  assert.equal(scopeCarries(conn, { type: 'text', convo_id: 'coord' }), true)
  assert.equal(scopeCarries(conn, { type: 'text', convo_id: 'open' }), true)
  assert.equal(scopeCarries({ syncScope: null }, { type: 'text', convo_id: 'other' }), true)
})

test('noteCoordinator follows the role between conversations', () => {
  const conn = { syncScope: 'for_you', coordinatorConvoId: 'a' }
  noteCoordinator(conn, { type: 'coordinator', convo_id: 'b', payload: { role: 'released' } })
  assert.equal(conn.coordinatorConvoId, 'a', 'a release elsewhere changes nothing')
  noteCoordinator(conn, { type: 'coordinator', convo_id: 'a', payload: { role: 'released' } })
  assert.equal(conn.coordinatorConvoId, null)
  noteCoordinator(conn, { type: 'coordinator', convo_id: 'b', payload: { role: 'assigned' } })
  assert.equal(conn.coordinatorConvoId, 'b')
  noteCoordinator(conn, { type: 'text', convo_id: 'c', payload: { role: 'assigned' } })
  assert.equal(conn.coordinatorConvoId, 'b')
})

test('wakesForYou: tracker and mission changes, and the Coordinator\'s messages', () => {
  assert.equal(wakesForYou({ type: 'item', convo_id: 'x' }, 'coord'), true)
  assert.equal(wakesForYou({ type: 'milestone', convo_id: 'x' }, 'coord'), true)
  assert.equal(wakesForYou({ type: 'text', convo_id: 'x' }, 'coord'), false)
  assert.equal(wakesForYou({ type: 'convo_meta', convo_id: 'x' }, 'coord'), false)
  assert.equal(wakesForYou({ type: 'text', convo_id: 'coord' }, 'coord'), true)
  assert.equal(wakesForYou({ type: 'session_status', convo_id: 'coord' }, 'coord'), false)
  assert.equal(wakesForYou({ type: 'text', convo_id: null }, null), false)
})

async function fixture(t, opts = {}) {
  const s = await startTestServer(opts)
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  upsertConversation(s.db, { id: 'work', ownerUserId: alice.id, title: 'Work' })
  upsertConversation(s.db, { id: 'coord', ownerUserId: alice.id, title: 'Coordinator' })
  upsertConversation(s.db, { id: 'next', ownerUserId: alice.id, title: 'Next' })
  setCoordinatorConvoId(s.db, alice.id, 'coord')
  const login = async (name) => (await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: name } })).json
  const add = (convoId, type, payload = { body: 'x' }) => append(s.db, { userId: alice.id, convoId, sender: 'agent:box-a', type, payload }).seq
  return { s, alice, login, add }
}

test('hello: for_you is echoed and kept on the device row; the default is everything', async (t) => {
  const { s, login } = await fixture(t)
  const phone = await login('phone')
  const mac = await login('mac')
  const p = await makeWsClient(s.base, { token: phone.token, cursor: 0, hello: { sync: 'for_you' } })
  const m = await makeWsClient(s.base, { token: mac.token, cursor: 0, hello: { sync: 'everything' } })
  const quiet = await makeWsClient(s.base, { token: (await login('ipad')).token, cursor: 0 })
  assert.equal((await p.waitFor((f) => f.op === 'hello_ok')).sync, 'for_you')
  assert.equal((await m.waitFor((f) => f.op === 'hello_ok')).sync, 'everything')
  assert.equal('sync' in (await quiet.waitFor((f) => f.op === 'hello_ok')), false, 'not echoed to a client that did not ask')
  quiet.close()
  const scope = (id) => s.db.prepare('SELECT sync_scope FROM devices WHERE id=?').get(id).sync_scope
  assert.equal(scope(phone.device_id), 'for_you')
  assert.equal(scope(mac.device_id), null)
  p.close(); m.close()
  // Switching back clears it.
  const p2 = await makeWsClient(s.base, { token: phone.token, cursor: 0, hello: { sync: 'everything' } })
  await p2.waitFor((f) => f.op === 'hello_ok')
  assert.equal(scope(phone.device_id), null)
  p2.close()
})

test('hello: a sync value no client sends is a bad request', async (t) => {
  const { s, login } = await fixture(t)
  const phone = await login('phone')
  const p = await makeWsClient(s.base, { token: phone.token, cursor: 0, hello: { sync: 'some' } })
  const err = await p.waitFor((f) => f.op === 'error')
  assert.equal(err.code, 'bad_request')
  assert.equal(err.ref, 'hello')
})

test('replay: a for_you socket gets only what its scope carries, then the head as its cursor', async (t) => {
  const { s, login, add } = await fixture(t)
  add('work', 'text')
  const item = add('work', 'item', { item_id: 'it_1', action: 'created' })
  add('work', 'tool_output')
  const meta = add('next', 'convo_meta', { title: 'Next' })
  const coordText = add('coord', 'text')
  const coordItem = add('coord', 'item', { item_id: 'it_2', action: 'created' })
  const head = add('work', 'text')
  const phone = await login('phone')
  const p = await makeWsClient(s.base, { token: phone.token, cursor: 0, hello: { sync: 'for_you' } })
  const cursor = await p.waitFor((f) => f.kind === 'control' && f.op === 'cursor')
  const journal = p.journal().map((f) => f.seq)
  // setCoordinatorConvoId in the fixture wrote no event (no appendEvent).
  assert.deepEqual(journal, [item, meta, coordText, coordItem], 'a marker in the Coordinator conversation comes once')
  assert.equal(cursor.seq, head)
  assert.ok(p.frames.indexOf(cursor) > p.frames.findIndex((f) => f.seq === coordItem), 'cursor comes after the replay')
  p.close()
})

test('replay: an everything socket is unchanged and gets no cursor frame', async (t) => {
  const { s, login, add } = await fixture(t)
  add('work', 'text'); add('work', 'tool_output'); const last = add('coord', 'text')
  const mac = await login('mac')
  const m = await makeWsClient(s.base, { token: mac.token, cursor: 0 })
  await m.waitFor((f) => f.kind === 'journal' && f.seq === last)
  await settle()
  assert.equal(m.journal().length, 3)
  assert.equal(m.frames.some((f) => f.op === 'cursor'), false)
  m.close()
})

test('replay: the snapshot valve counts what a for_you replay would send, not the whole gap', async (t) => {
  const { s, login, add } = await fixture(t, { maxReplay: 5 })
  for (let i = 0; i < 20; i++) add('work', 'text')
  const item = add('work', 'item', { item_id: 'it_1', action: 'created' })
  const phone = await login('phone')
  const p = await makeWsClient(s.base, { token: phone.token, cursor: 1, hello: { sync: 'for_you' } })
  await p.waitFor((f) => f.op === 'cursor')
  assert.equal(p.frames.some((f) => f.op === 'snapshot_required'), false)
  assert.deepEqual(p.journal().map((f) => f.seq), [item])
  p.close()
  for (let i = 0; i < 6; i++) add('work', 'item', { item_id: `it_${i + 2}`, action: 'created' })
  const p2 = await makeWsClient(s.base, { token: phone.token, cursor: 1, hello: { sync: 'for_you' } })
  await p2.waitFor((f) => f.op === 'snapshot_required')
})

test('live: a for_you socket hears markers, the Coordinator and the chats it views', async (t) => {
  const { s, login } = await fixture(t)
  const phone = await login('phone')
  const mac = await login('mac')
  const p = await makeWsClient(s.base, { token: phone.token, cursor: 0, hello: { sync: 'for_you' } })
  const m = await makeWsClient(s.base, { token: mac.token, cursor: 0 })
  await p.waitFor((f) => f.op === 'cursor')
  await m.waitFor((f) => f.op === 'hello_ok')

  m.send({ op: 'send', convo_id: 'work', payload: { body: 'not for the phone' }, local_id: 'l1' })
  m.send({ op: 'send', convo_id: 'coord', payload: { body: 'for the phone' }, local_id: 'l2' })
  await m.waitFor((f) => f.kind === 'journal' && f.payload?.body === 'for the phone')
  await p.waitFor((f) => f.kind === 'journal' && f.payload?.body === 'for the phone')
  assert.equal(p.journal().some((f) => f.payload?.body === 'not for the phone'), false)

  p.send({ op: 'viewing', convo_id: 'work' })
  await settle()
  m.send({ op: 'send', convo_id: 'work', payload: { body: 'viewed now' }, local_id: 'l3' })
  await p.waitFor((f) => f.kind === 'journal' && f.payload?.body === 'viewed now')

  p.send({ op: 'viewing', convo_id: null })
  await settle()
  m.send({ op: 'send', convo_id: 'work', payload: { body: 'left again' }, local_id: 'l4' })
  m.send({ op: 'send', convo_id: 'coord', payload: { body: 'marker after' }, local_id: 'l5' })
  await p.waitFor((f) => f.kind === 'journal' && f.payload?.body === 'marker after')
  assert.equal(p.journal().some((f) => f.payload?.body === 'left again'), false)
  p.close(); m.close()
})

test('live: a for_you socket follows the Coordinator role when it moves', async (t) => {
  const { s, login } = await fixture(t)
  const phone = await login('phone')
  const mac = await login('mac')
  const p = await makeWsClient(s.base, { token: phone.token, cursor: 0, hello: { sync: 'for_you' } })
  const m = await makeWsClient(s.base, { token: mac.token, cursor: 0 })
  await p.waitFor((f) => f.op === 'cursor')
  await m.waitFor((f) => f.op === 'hello_ok')
  assert.equal((await s.http('/coordinator', { method: 'PUT', token: mac.token, body: { convo_id: 'next' } })).status, 200)
  await p.waitFor((f) => f.kind === 'journal' && f.type === 'coordinator' && f.convo_id === 'next')
  m.send({ op: 'send', convo_id: 'next', payload: { body: 'new coordinator' }, local_id: 'l1' })
  m.send({ op: 'send', convo_id: 'coord', payload: { body: 'old coordinator' }, local_id: 'l2' })
  m.send({ op: 'send', convo_id: 'next', payload: { body: 'fence' }, local_id: 'l3' })
  await p.waitFor((f) => f.kind === 'journal' && f.payload?.body === 'fence')
  assert.ok(p.journal().some((f) => f.payload?.body === 'new coordinator'))
  assert.equal(p.journal().some((f) => f.payload?.body === 'old coordinator'), false)
  p.close(); m.close()
})

test('replay: a for_you backlog longer than one batch arrives whole and in order', async (t) => {
  const { s, login, add } = await fixture(t)
  const want = []
  for (let i = 0; i < 700; i++) {
    add('work', 'text')
    want.push(add('work', 'item', { item_id: `it_${i}`, action: 'created' }))
    if (i % 3 === 0) want.push(add('coord', 'text'))
  }
  want.sort((a, b) => a - b)
  const phone = await login('phone')
  const p = await makeWsClient(s.base, { token: phone.token, cursor: 0, hello: { sync: 'for_you' } })
  await p.waitFor((f) => f.op === 'cursor', 10000)
  assert.deepEqual(p.journal().map((f) => f.seq), want)
  p.close()
})

test('replay: a Coordinator move while a long for_you replay runs is followed', async (t) => {
  const { s, login, add } = await fixture(t)
  for (let i = 0; i < 1500; i++) add('work', 'item', { item_id: `it_${i}`, action: 'updated' })
  const phone = await login('phone')
  const mac = await login('mac')
  const p = await makeWsClient(s.base, { token: phone.token, cursor: 0, hello: { sync: 'for_you' } })
  // Lands while the replay yields between batches, or just after it.
  assert.equal((await s.http('/coordinator', { method: 'PUT', token: mac.token, body: { convo_id: 'next' } })).status, 200)
  await p.waitFor((f) => f.op === 'cursor', 10000)
  const m = await makeWsClient(s.base, { token: mac.token, cursor: null })
  await m.waitFor((f) => f.op === 'hello_ok')
  m.send({ op: 'send', convo_id: 'next', payload: { body: 'to the new coordinator' }, local_id: 'l1' })
  await p.waitFor((f) => f.kind === 'journal' && f.payload?.body === 'to the new coordinator')
  p.close(); m.close()
})
