import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, pinDevicePrivate } from '../src/db.js'
import { createUser, createAgent, revokeDevice } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import {
  validateMemoryFields, validName, upsertMemory, getMemory, listMemories, deleteMemory, privateOrigin, MEMORIES_MAX,
} from '../src/memories.js'

async function seed() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const pat = await createUser(db, 'pat', 'pw')
  const agent = createAgent(db, dan.id, 'dev-2')
  const priv = createAgent(db, dan.id, 'priv-box')
  pinDevicePrivate(db, priv.deviceId, true)
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  return { db, dan, pat, agent, priv }
}
const save = (db, userId, over = {}) => upsertMemory(db, {
  userId, name: 'avoid-eric', description: 'Never use eric.', body: '', type: undefined,
  originConvoId: 'c1', originDeviceId: null, by: 'agent', now: 1000, ...over,
})

test('schema: memories table has the spec columns', async () => {
  const { db } = await seed()
  const cols = db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name)
  assert.deepEqual(cols, ['id', 'user_id', 'name', 'type', 'description', 'body', 'origin_convo_id', 'origin_device_id', 'origin_private', 'created_by', 'updated_by', 'created_at', 'updated_at'])
})

test('validName: kebab slugs only', () => {
  for (const ok of ['a', 'avoid-eric', 'x1-2', 'a'.repeat(64)]) assert.equal(validName(ok), true, ok)
  for (const bad of ['', '-a', 'A', 'a b', 'a_b', 'a'.repeat(65), 'é', 42, null]) assert.equal(validName(bad), false, String(bad))
})

test('validateMemoryFields: description trimmed one-liner ≤200, body ≤8192 bytes (cleared when omitted), type enum', () => {
  const ok = validateMemoryFields({ description: '  Never use eric.  ', body: 'why', type: 'user' })
  assert.deepEqual(ok, { ok: true, value: { description: 'Never use eric.', body: 'why', type: 'user' } })
  assert.deepEqual(validateMemoryFields({ description: 'x' }), { ok: true, value: { description: 'x', body: '', type: undefined } })
  assert.equal(validateMemoryFields({ description: 'x', body: 'é'.repeat(4096) }).ok, true)
  assert.equal(validateMemoryFields({ description: 'x', body: 'é'.repeat(4096) + 'a' }).ok, false)
  for (const bad of [{}, null, [], { description: '' }, { description: '   ' }, { description: 'a'.repeat(201) }, { description: 'a\nb' }, { description: 'a\u2028b' },
    { description: 'x', body: 42 }, { description: 'x', type: 'rule' }, { description: 'x', type: '' }, { description: 42 }]) {
    assert.equal(validateMemoryFields(bad).ok, false, JSON.stringify(bad))
  }
})

test('upsertMemory: create then update by name; origin and created_* fixed, updated_* move, omitted type kept', async () => {
  const { db, dan, agent } = await seed()
  const c = save(db, dan.id, { originDeviceId: agent.deviceId, type: 'user', body: 'b1' })
  assert.equal(c.created, true)
  assert.match(c.memory.id, /^me_[0-9a-f]{16}$/)
  assert.equal(c.memory.type, 'user'); assert.equal(c.memory.created_by, 'agent'); assert.equal(c.memory.updated_by, 'agent')
  assert.equal(c.memory.origin_convo_id, 'c1'); assert.equal(c.memory.origin_device_id, agent.deviceId)
  const u = save(db, dan.id, { description: 'Eric is reserved.', body: '', originConvoId: 'other', originDeviceId: 999, by: 'user', now: 2000 })
  assert.equal(u.created, false); assert.equal(u.memory.id, c.memory.id)
  assert.equal(u.memory.description, 'Eric is reserved.'); assert.equal(u.memory.body, ''); assert.equal(u.memory.type, 'user')
  assert.equal(u.memory.origin_convo_id, 'c1'); assert.equal(u.memory.origin_device_id, agent.deviceId)
  assert.equal(u.memory.created_by, 'agent'); assert.equal(u.memory.updated_by, 'user')
  assert.equal(u.memory.created_at, 1000); assert.equal(u.memory.updated_at, 2000)
  assert.equal(save(db, dan.id, {}).memory.type, 'user')
  assert.equal(save(db, dan.id, { name: 'fresh' }).memory.type, 'feedback')
})

test('upsertMemory: the same name is a different row per user', async () => {
  const { db, dan, pat } = await seed()
  const a = save(db, dan.id); const b = save(db, pat.id)
  assert.notEqual(a.memory.id, b.memory.id); assert.equal(b.created, true)
})

test('upsertMemory: cap at MEMORIES_MAX creates; updates still fine', async () => {
  const { db, dan } = await seed()
  for (let i = 0; i < MEMORIES_MAX; i++) save(db, dan.id, { name: `m-${i}` })
  assert.throws(() => save(db, dan.id, { name: 'one-more' }), /too_many/)
  assert.equal(save(db, dan.id, { name: 'm-0', description: 'again' }).created, false)
})

test('getMemory by id or name; listMemories ordered by name with the privacy sieve; privateOrigin', async () => {
  const { db, dan, priv, agent } = await seed()
  const pub = save(db, dan.id, { name: 'b-public', originDeviceId: agent.deviceId }).memory
  const hid = save(db, dan.id, { name: 'a-private', originDeviceId: priv.deviceId }).memory
  assert.equal(getMemory(db, dan.id, pub.id).name, 'b-public')
  assert.equal(getMemory(db, dan.id, 'b-public').id, pub.id)
  assert.equal(getMemory(db, dan.id, 'nope'), null)
  assert.equal(getMemory(db, dan.id, ''), null)
  assert.equal(getMemory(db, 999, pub.id), null)
  assert.deepEqual(listMemories(db, dan.id).map((m) => m.name), ['a-private', 'b-public'])
  assert.deepEqual(listMemories(db, dan.id, { excludePrivateOwned: true }).map((m) => m.name), ['b-public'])
  assert.equal(privateOrigin(hid), true); assert.equal(privateOrigin(pub), false)
  assert.equal(hid.origin_private, true); assert.equal(pub.origin_private, false)
  assert.equal(privateOrigin({ origin_device_id: null }), false)
})

test('privacy is snapshotted at save time: revoking the origin device (and reusing its id) changes nothing', async () => {
  const { db, dan, priv, agent } = await seed()
  const hid = save(db, dan.id, { name: 'secret', originDeviceId: priv.deviceId }).memory
  const pub = save(db, dan.id, { name: 'open', originDeviceId: agent.deviceId }).memory
  revokeDevice(db, priv.deviceId)
  revokeDevice(db, agent.deviceId)
  // A fresh device may land on a revoked id (INTEGER PRIMARY KEY reuse).
  const again = createAgent(db, dan.id, 'again')
  pinDevicePrivate(db, again.deviceId, true)
  assert.deepEqual(listMemories(db, dan.id, { excludePrivateOwned: true }).map((m) => m.name), ['open'])
  assert.equal(privateOrigin(getMemory(db, dan.id, hid.id)), true)
  assert.equal(privateOrigin(getMemory(db, dan.id, pub.id)), false)
})

test('deleteMemory returns the row once, then null', async () => {
  const { db, dan } = await seed()
  const m = save(db, dan.id).memory
  assert.equal(deleteMemory(db, dan.id, m.id).id, m.id)
  assert.equal(deleteMemory(db, dan.id, m.id), null)
  assert.equal(getMemory(db, dan.id, m.id), null)
})
