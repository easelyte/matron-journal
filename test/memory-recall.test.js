// POST /memories/recall: the memories that bear on a text. `query` mode
// runs unified search's tiers for a short text; `auto` mode is the
// embedding pass alone, above a floor.
import test from 'node:test'
import assert from 'node:assert/strict'
import { seed } from './search-fixtures.js'
import { upsertMemory } from '../src/memories.js'
import { validateRecall, recallMemories, RECALL_AUTO_MIN } from '../src/memory-recall.js'
import { fakeEmbedder } from '../src/embedder.js'
import { ensureVectorSchema, runVectorIndexer, createVectorStore } from '../src/vector-index.js'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { pinDevicePrivate } from '../src/db.js'

// Each memory's search doc is "topic: name description" (empty body), so the fake
// embedder's vector table keys on that text.
const MEMS = [
  ['parcel-labels', 'Label every parcel with its ship date.', 'repo:widgets', 'on_demand', 'parcels', [1, 0, 0]],
  ['parcel-courier', 'Book couriers only through the app.', 'global', 'on_demand', 'parcels', [0.95, 0.31, 0]],
  ['disk-volumes', 'Never delete container volumes.', 'global', 'always', null, [0, 1, 0]],
  ['tone', 'Keep replies short.', 'global', 'on_demand', 'writing', [0, 0, 1]],
]
async function world() {
  const db = seed()
  const vectors = {}
  for (const [name, description, scope, tier, topic, vec] of MEMS) {
    upsertMemory(db, { userId: 1, name, description, body: '', scope, tier, topic, by: 'agent' })
    vectors[`${topic ? `${topic}: ` : ''}${name} ${description}`] = vec
  }
  vectors['please send the parcel to the school tomorrow'] = [1, 0.1, 0]
  vectors['something unrelated entirely'] = [-1, 0.2, 0.2]
  ensureVectorSchema(db)
  const embedder = fakeEmbedder({ dim: 3, vectors })
  await runVectorIndexer(db, embedder)
  const store = createVectorStore(db, embedder)
  store.setIndexing(false)
  return { db, semantic: { store, embedder } }
}
const ask = (body) => {
  const v = validateRecall(body)
  assert.equal(v.ok, true, JSON.stringify(body))
  return v.value
}

test('validateRecall', () => {
  assert.equal(validateRecall({ text: 'x' }).value.mode, 'query')
  assert.equal(validateRecall({ text: 'x' }).value.limit, 3)
  assert.equal(validateRecall({ text: 'x' }).value.minScore, RECALL_AUTO_MIN)
  for (const bad of [null, [], {}, { text: '' }, { text: '   ' }, { text: 'x'.repeat(4001) }, { text: 'x', mode: 'oracle' },
    { text: 'x', scopes: 'global' }, { text: 'x', scopes: ['team'] }, { text: 'x', tier: 'maybe' }, { text: 'x', exclude: [1] },
    { text: 'x', limit: 0 }, { text: 'x', limit: 11 }, { text: 'x', min_score: 0.2 }, { text: 'x', min_score: '0.8' }]) {
    assert.equal(validateRecall(bad).ok, undefined, JSON.stringify(bad))
  }
})

test('auto: embedding matches above the floor, best first, with the body; filters by scope, tier and exclude', async () => {
  const { db, semantic } = await world()
  const text = 'please send the parcel to the school tomorrow'
  let r = await recallMemories(db, 1, ask({ text, mode: 'auto' }), { semantic })
  assert.equal(r.semantic, 'ready')
  assert.deepEqual(r.memories.map((m) => m.name), ['parcel-labels', 'parcel-courier'])
  assert.equal(r.memories[0].why, 'similar')
  assert.ok(r.memories[0].score >= r.memories[1].score)
  assert.equal(typeof r.memories[0].body, 'string')
  r = await recallMemories(db, 1, ask({ text, mode: 'auto', scopes: ['global'] }), { semantic })
  assert.deepEqual(r.memories.map((m) => m.name), ['parcel-courier'])
  r = await recallMemories(db, 1, ask({ text, mode: 'auto', exclude: ['parcel-labels'] }), { semantic })
  assert.deepEqual(r.memories.map((m) => m.name), ['parcel-courier'])
  r = await recallMemories(db, 1, ask({ text, mode: 'auto', limit: 1 }), { semantic })
  assert.deepEqual(r.memories.map((m) => m.name), ['parcel-labels'])
  r = await recallMemories(db, 1, ask({ text, mode: 'auto', tier: 'always' }), { semantic })
  assert.deepEqual(r.memories, [])
})

test('auto: nothing above the floor → nothing; no ready index → nothing, with the status', async () => {
  const { db, semantic } = await world()
  let r = await recallMemories(db, 1, ask({ text: 'something unrelated entirely', mode: 'auto' }), { semantic })
  assert.deepEqual(r.memories, [])
  semantic.store.setIndexing(true)
  r = await recallMemories(db, 1, ask({ text: 'please send the parcel to the school tomorrow', mode: 'auto' }), { semantic })
  assert.deepEqual(r, { memories: [], semantic: 'indexing' })
  r = await recallMemories(db, 1, ask({ text: 'please send the parcel to the school tomorrow', mode: 'auto' }), { semantic: null })
  assert.deepEqual(r, { memories: [], semantic: 'off' })
})

test('query: word tiers find a memory without the index; the tier filter applies', async () => {
  const { db } = await world()
  const r = await recallMemories(db, 1, ask({ text: 'couriers' }), { semantic: null })
  assert.deepEqual(r.memories.map((m) => m.name), ['parcel-courier'])
  assert.notEqual(r.memories[0].why, 'similar')
  const none = await recallMemories(db, 1, ask({ text: 'couriers', tier: 'always' }), { semantic: null })
  assert.deepEqual(none.memories, [])
})

test('an embedding failure answers nothing recalled, not an error', async () => {
  const { db, semantic } = await world()
  semantic.embedder.embedQuery = async () => { throw new Error('model gone') }
  const r = await recallMemories(db, 1, ask({ text: 'please send the parcel to the school tomorrow', mode: 'auto' }), { semantic })
  assert.deepEqual(r.memories, [])
})

test('HTTP: POST /memories/recall answers 200, 400 on junk, and hides a private-origin memory from an ordinary agent', async (t) => {
  const s = await startTestServer({})
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const agent = createAgent(s.db, alice.id, 'box-a')
  const priv = createAgent(s.db, alice.id, 'priv-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertMemory(s.db, { userId: alice.id, name: 'courier-public', description: 'Couriers via the app.', body: '', tier: 'on_demand', by: 'agent' })
  upsertMemory(s.db, { userId: alice.id, name: 'courier-private', description: 'Couriers on Tuesdays.', body: '', tier: 'on_demand', by: 'agent', originDeviceId: priv.deviceId })
  const r = await s.http('/memories/recall', { method: 'POST', token: agent.token, body: { text: 'couriers' } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.memories.map((m) => m.name), ['courier-public'])
  const p = await s.http('/memories/recall', { method: 'POST', token: priv.token, body: { text: 'couriers' } })
  assert.deepEqual(p.json.memories.map((m) => m.name).sort(), ['courier-private', 'courier-public'])
  assert.equal((await s.http('/memories/recall', { method: 'POST', token: agent.token, body: { text: '' } })).status, 400)
  assert.equal((await s.http('/memories/recall', { method: 'POST', token: agent.token, body: { text: 'x', mode: 'oracle' } })).status, 400)
})

test('a memory\'s topic leads its search text, and changes with it', () => {
  const db = seed()
  upsertMemory(db, { userId: 1, name: 'book-van', description: 'Book vans early.', body: 'Why: they sell out.', tier: 'on_demand', topic: 'couriers', by: 'agent' })
  const text = () => db.prepare("SELECT body FROM search_docs WHERE kind='memory'").get().body
  assert.equal(text(), 'couriers: book-van Book vans early. Why: they sell out.')
  upsertMemory(db, { userId: 1, name: 'book-van', description: 'Book vans early.', body: 'Why: they sell out.', topic: '', by: 'agent' })
  assert.equal(text(), 'book-van Book vans early. Why: they sell out.')
})

test('auto with 20+ memories: a match must also stand out from the rest (z-score), not just clear the floor', async () => {
  const db = seed()
  const vectors = {}
  // 24 memories spread round one region; one points straight at the turn.
  for (let i = 0; i < 24; i++) {
    const name = `rule-${i}`
    upsertMemory(db, { userId: 1, name, description: `Rule number ${i}.`, body: '', tier: 'on_demand', by: 'agent' })
    vectors[`${name} Rule number ${i}.`] = [1, 0.25 + (i % 6) * 0.05, (i % 4) * 0.05]
  }
  upsertMemory(db, { userId: 1, name: 'the-one', description: 'The one that matters.', body: '', tier: 'on_demand', by: 'agent' })
  vectors['the-one The one that matters.'] = [1, 0, 0.9]
  vectors['a turn about the thing'] = [1, 0, 0.95]
  vectors['a turn about nothing much'] = [1, 0.4, 0.05]
  ensureVectorSchema(db)
  const embedder = fakeEmbedder({ dim: 3, vectors })
  await runVectorIndexer(db, embedder)
  const store = createVectorStore(db, embedder)
  store.setIndexing(false)
  const semantic = { store, embedder }
  let r = await recallMemories(db, 1, ask({ text: 'a turn about the thing', mode: 'auto' }), { semantic })
  assert.deepEqual(r.memories.map((m) => m.name), ['the-one'])
  // Every rule clears the floor here, but none stands out: nothing.
  r = await recallMemories(db, 1, ask({ text: 'a turn about nothing much', mode: 'auto' }), { semantic })
  assert.deepEqual(r.memories, [])
  // The floor alone (as with a small memory set) would have let them in.
  assert.ok(store.scoreDocs(1, await embedder.embedQuery('a turn about nothing much'), [1, 2, 3]).every((h) => h.score >= 0.62))
})

test('validateRecall: min_z', () => {
  assert.equal(validateRecall({ text: 'x' }).value.minZ, 3)
  assert.equal(validateRecall({ text: 'x', min_z: 2 }).value.minZ, 2)
  for (const v of [0.5, 7, '3']) assert.equal(validateRecall({ text: 'x', min_z: v }).ok, undefined)
})

test('query: filters apply to every match, not to a first page of them', async () => {
  const db = seed()
  // 60 always memories all mention vans; one on-demand memory does too.
  for (let i = 0; i < 60; i++) upsertMemory(db, { userId: 1, name: `van-rule-${i}`, description: `Vans rule ${i}.`, body: '', by: 'agent', tier: 'always' })
  upsertMemory(db, { userId: 1, name: 'zz-van-on-demand', description: 'Vans need booking a week ahead.', body: '', tier: 'on_demand', by: 'agent' })
  const r = await recallMemories(db, 1, ask({ text: 'vans', tier: 'on_demand' }), { semantic: null })
  assert.deepEqual(r.memories.map((m) => m.name), ['zz-van-on-demand'])
})

test('query: a memory deleted while the search runs is skipped, not a crash', async () => {
  const { db, semantic } = await world()
  const realEmbed = semantic.embedder.embedQuery
  semantic.embedder.embedQuery = async (t) => {
    db.prepare("DELETE FROM memories WHERE name='parcel-courier'").run()
    return realEmbed(t)
  }
  // Two words: the word tiers find it first, then the similar tier's
  // embedding call deletes it.
  let deleted = false
  const before = semantic.embedder.embedQuery
  semantic.embedder.embedQuery = async (t) => { deleted = true; return before(t) }
  const r = await recallMemories(db, 1, ask({ text: 'book couriers' }), { semantic })
  assert.equal(deleted, true)
  assert.ok(!r.memories.some((m) => m.name === 'parcel-courier'))
})
