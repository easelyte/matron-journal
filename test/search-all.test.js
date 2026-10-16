// Query parsing and the tiered lexical searchAll (spec 2026-10-12 unified
// search §3/§4), rolled up to missions, items, memories and projects.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseQuery } from '../src/search-query.js'
import { searchAll } from '../src/search-all.js'
import { seed } from './search-fixtures.js'
import { createMission, updateMission, createMilestone } from '../src/missions.js'
import { createItem } from '../src/items.js'
import { createProject } from '../src/projects.js'
import { upsertMemory } from '../src/memories.js'
import { upsertConversation } from '../src/journal.js'
import { fakeEmbedder } from '../src/embedder.js'
import { ensureVectorSchema, runVectorIndexer, createVectorStore } from '../src/vector-index.js'

async function withVectors(db, vectors) {
  ensureVectorSchema(db)
  const embedder = fakeEmbedder({ dim: 3, vectors })
  await runVectorIndexer(db, embedder)
  return { store: createVectorStore(db, embedder), embedder }
}

// createMission attaches its convoId to the new mission (conversations.mission_id
// goes from NULL to that mission's id, once); a second createMission call on
// the SAME already-attached convoId returns the existing mission rather than
// making a new one (src/missions.js, "a second mission for the same convo:
// existing, nothing changed" — test/missions.test.js pins this). Tests below
// that need several distinct missions give each its own conversation.
function moreConvos(db, n) {
  for (let i = 0; i < n; i++) upsertConversation(db, { id: `c${i + 2}`, ownerUserId: 1, title: `c${i + 2}`, agentDeviceId: 1 })
}

test('parseQuery: literal rules', () => {
  assert.equal(parseQuery('   '), null)
  assert.equal(parseQuery('heron').literal, true, 'one word')
  assert.equal(parseQuery('PR 4242').literal, true, 'digit')
  assert.equal(parseQuery('book q7zk3mw9pxa').literal, true, 'id-like')
  assert.equal(parseQuery('"walrus lantern"').literal, true, 'quoted')
  assert.equal(parseQuery('"walrus lantern"').quoted, true)
  assert.equal(parseQuery('making sleepy otters wake quicker').literal, false)
  assert.deepEqual(parseQuery('"walrus lantern"').terms, ['walrus', 'lantern'])
})

// createMission also gives the mission a default project of the same title
// (default-project.js), so each mission created below has a same-titled
// project that would ALSO match these queries and double the result count.
// kinds: ['mission'] keeps this test about the mission tier order it's
// actually pinning.
test('exact beats words beats stemmed; each result says why', async () => {
  const db = seed()
  moreConvos(db, 2)
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'lantern export for painted boats' })
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c2', title: 'export of the lantern for painted boats' })
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c3', title: 'exporting lanterns for painting' })
  const r = (await searchAll(db, 1, { query: 'lantern export', kinds: ['mission'] })).results
  assert.deepEqual(r.map((x) => x.why), ['exact', 'words', 'stemmed'])
})

test('a mission is found through its milestone and status; one result per mission', async () => {
  const db = seed()
  const { mission } = createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'Feed the otters' })
  createMilestone(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', kind: 'progress', title: 'kelp basket woven', appendMarker: () => ({ seq: 1 }) })
  updateMission(db, { userId: 1, missionId: mission.id, fields: { status: 'kelp basket delivered' }, statusWriter: { by: 'agent', convoId: 'c1', deviceId: 1 } })
  const r = (await searchAll(db, 1, { query: 'kelp basket' })).results
  assert.equal(r.length, 1)
  assert.equal(r[0].kind, 'mission')
  assert.equal(r[0].num, mission.num)
})

// createItem takes mission_id from the origin conversation's CURRENT
// mission (src/items.js createItem); createMission attaches convoId 'c1'
// to the new mission, so filing the item against 'c1' right after exercises
// that real path rather than passing a mission id by hand.
test('an item reports its mission number', async () => {
  const db = seed()
  const { mission } = createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'M' })
  createItem(db, { userId: 1, deviceId: 1, originDeviceId: 1, originConvoId: 'c1', createdBy: 'agent', kind: 'question', title: 'which quokka count' })
  const r = (await searchAll(db, 1, { query: 'quokka count' })).results
  assert.equal(r[0].kind, 'item')
  assert.equal(r[0].mission_num, mission.num)
})

test('some_words only when the strict tiers are thin, and never for a literal query', async () => {
  const db = seed()
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'otter whisker comparison' })
  const loose = (await searchAll(db, 1, { query: 'otter colours versus meadow badgers' })).results
  assert.equal(loose[0].why, 'some_words')
  assert.equal((await searchAll(db, 1, { query: 'otter 4242' })).results.length, 0)
})

test('an identifier query returns its target at rank 1', async () => {
  const db = seed()
  moreConvos(db, 10)
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'Forward button in header (PR 4242)' })
  for (let i = 0; i < 10; i++) createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: `c${i + 2}`, title: `PR review round ${i}` })
  const r = (await searchAll(db, 1, { query: 'PR 4242' })).results
  assert.match(r[0].title, /4242/)
  assert.ok(['exact', 'words'].includes(r[0].why))
})

test('kinds filter and limit clamp', async () => {
  const db = seed()
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'heron' })
  createItem(db, { userId: 1, deviceId: 1, originDeviceId: 1, originConvoId: 'c1', createdBy: 'agent', kind: 'task', title: 'heron' })
  assert.deepEqual((await searchAll(db, 1, { query: 'heron', kinds: ['item'] })).results.map((r) => r.kind), ['item'])
})

test('kinds filters in SQL: a memory is found past a pool full of matching missions', async () => {
  const db = seed()
  moreConvos(db, 100)
  for (let i = 0; i < 100; i++) createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: `c${i + 2}`, title: `kestrel nest ${i}` })
  // One mention in a long body: a weaker bm25 match than every mission,
  // so it ranks below the whole first page unless kinds reaches the SQL.
  upsertMemory(db, { userId: 1, name: 'meadow-notes', description: 'how we find the kestrel nest', body: 'a long note about the meadow with many other words in it so this memory ranks low', type: 'reference', scope: 'global', by: 'agent' })
  const r = (await searchAll(db, 1, { query: 'kestrel', kinds: ['memory'] })).results
  assert.deepEqual(r.map((x) => [x.kind, x.name]), [['memory', 'meadow-notes']])
})

test('one mission with many matching milestones does not stop other missions reaching the limit', async () => {
  const db = seed()
  moreConvos(db, 10)
  // Created first, so its milestones are older; give them the best bm25
  // (shortest bodies) so they fill the first page of the tier.
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'Busy mission' })
  for (let i = 0; i < 60; i++) {
    createMilestone(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', kind: 'progress', title: 'pelican', appendMarker: () => ({ seq: i + 1 }) })
  }
  for (let i = 0; i < 10; i++) {
    createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: `c${i + 2}`, title: `pelican mission number ${i} with a longer title` })
  }
  const r = (await searchAll(db, 1, { query: 'pelican', kinds: ['mission'], limit: 5 })).results
  assert.equal(r.length, 5)
  assert.equal(new Set(r.map((x) => x.id)).size, 5)
})

test('a tier runs a bounded number of queries however many docs of one entity match', async () => {
  const db = seed()
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'Busy mission' })
  db.transaction(() => {
    for (let i = 0; i < 1000; i++) {
      createMilestone(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', kind: 'progress', title: 'pelican', appendMarker: () => ({ seq: i + 1 }) })
    }
  })()
  // Count executions of the tier statements (the ones ranking by bm25).
  let tierQueries = 0
  const prepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    const stmt = prepare(sql)
    if (!sql.includes('bm25(')) return stmt
    return { all: (...args) => { tierQueries++; return stmt.all(...args) } }
  }
  const r = (await searchAll(db, 1, { query: 'pelican' })).results
  assert.equal(r.length, 1)
  // A one-word query runs the words and stemmed tiers: at most 4 pages each.
  assert.ok(tierQueries <= 8, `${tierQueries} tier queries`)
})

test('kinds filters the similar tier too: a memory is found past nearer missions', async () => {
  const db = seed()
  moreConvos(db, 10)
  const vectors = { 'heron musings today': [1, 0, 0], 'otter quiet notes': [0.97, 0.2, 0] }
  for (let i = 0; i < 10; i++) {
    const title = `kestrel ${'abcdefghij'[i]}`
    createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: `c${i + 2}`, title })
    vectors[title] = [1, 0.01, 0]
  }
  upsertMemory(db, { userId: 1, name: 'otter', description: 'quiet notes', body: '', type: 'reference', scope: 'global', by: 'agent' })
  const similar = await withVectors(db, vectors)
  const r = (await searchAll(db, 1, { query: 'heron musings today', kinds: ['memory'], limit: 1, similar })).results
  assert.deepEqual(r.map((x) => [x.kind, x.name, x.why]), [['memory', 'otter', 'similar']])
})

// excludeConsent: a consent-mirror item is the user's
// alone; searchAll must be able to hide it the way items-http.js does for
// every agent caller.
test('a consent item is not returned with excludeConsent: true', async () => {
  const db = seed()
  createItem(db, { userId: 1, deviceId: 1, originDeviceId: 1, originConvoId: 'c1', createdBy: 'agent', kind: 'task', title: 'gibbon consent ask', consent: 'spawn' })
  const withIt = await searchAll(db, 1, { query: 'gibbon consent ask' })
  assert.equal(withIt.results.length, 1)
  const without = await searchAll(db, 1, { query: 'gibbon consent ask', excludeConsent: true })
  assert.equal(without.results.length, 0)
})

// A private box's mission status must not be findable by an ordinary
// agent, end to end through searchAll — docVisibilitySql itself is pinned
// in search-docs.test.js; this confirms searchAll actually passes
// excludePrivateOwned through to it.
test('excludePrivateOwned hides a private-owned mission status from searchAll', async () => {
  const db = seed()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(2,1,'agent','box-b','h2',0,1)").run()
  upsertConversation(db, { id: 'cp', ownerUserId: 1, title: 'private chat', agentDeviceId: 2 })
  const { mission } = createMission(db, { userId: 1, deviceId: 2, createdBy: 'agent', convoId: 'cp', title: 'Private narwhal mission' })
  updateMission(db, { userId: 1, missionId: mission.id, fields: { status: 'secret narwhal status' }, statusWriter: { by: 'agent', convoId: 'cp', deviceId: 2 } })
  const owner = await searchAll(db, 1, { query: 'narwhal status' })
  assert.ok(owner.results.some((r) => r.kind === 'mission' && r.num === mission.num), 'the owner finds it')
  const agent = await searchAll(db, 1, { query: 'narwhal status', excludePrivateOwned: true })
  assert.equal(agent.results.length, 0, 'an ordinary agent finds nothing')
})

// An item filed from a visible, PUBLIC conversation can still be attached to
// a mission whose own origin is private. The item itself must stay
// visible (it is its own, unrelated entity), but the private-origin
// mission's number must not ride along with it.
test('excludePrivateOwned hides a private-origin mission\'s number on an item, even though the item itself is visible', async () => {
  const db = seed()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(2,1,'agent','box-b','h2',0,1)").run()
  upsertConversation(db, { id: 'cp', ownerUserId: 1, title: 'private chat', agentDeviceId: 2 })
  const { mission } = createMission(db, { userId: 1, deviceId: 2, createdBy: 'agent', convoId: 'cp', title: 'Private narwhal mission' })
  const { item } = createItem(db, { userId: 1, originDeviceId: 1, originConvoId: 'c1', createdBy: 'agent', kind: 'task', title: 'otter errand report' })
  db.prepare('UPDATE items SET mission_id=? WHERE id=?').run(mission.id, item.id)
  const owner = (await searchAll(db, 1, { query: 'otter errand report' })).results.find((r) => r.kind === 'item')
  assert.equal(owner.num, item.num, 'the owner finds the item')
  assert.equal(owner.mission_num, mission.num, 'and sees its mission number')
  const agent = (await searchAll(db, 1, { query: 'otter errand report', excludePrivateOwned: true })).results.find((r) => r.kind === 'item')
  assert.equal(agent.num, item.num, 'an ordinary agent still finds the item itself')
  assert.equal(agent.mission_num, null, 'but not the private-origin mission number')
})

// The similar tier: a local-embedding pass, folded in below every strict word match
// (exact/words/stemmed) but above the any-word fallback (some_words),
// thresholded and capped.
// Each mission needs its OWN conversation: createMission's attach short-
// circuit returns the convo's existing mission unchanged on a repeat
// convoId (see the `moreConvos` note above), so three missions need three
// convos, not one `c1` reused three times.
test('similar results come after every strict word match, capped, above the threshold and margin', async () => {
  const db = seed()
  moreConvos(db, 2)
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'amber fox from the meadow' })  // exact/words match (strict)
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c2', title: 'violet heron sketches' }) // similar
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c3', title: 'unrelated pebble colours' })  // below threshold
  const similar = await withVectors(db, {
    'amber fox from the meadow': [1, 0, 0], 'violet heron sketches': [0.95, 0.31, 0], 'unrelated pebble colours': [0.2, 0.98, 0],
  })
  const r = (await searchAll(db, 1, { query: 'amber fox from the meadow', similar })).results
  assert.deepEqual(r.map((x) => [x.title, x.why]), [
    ['amber fox from the meadow', 'exact'],
    ['violet heron sketches', 'similar'],
  ])
})

// With real data, some_words running straight after the strict tiers
// could fill the whole result list, slicing off a similar hit appended
// after it. So similar ranks above some_words:
// strict results first, then similar, then some_words — even when
// some_words itself does trigger (strict tiers are thin here).
test('similar outranks some_words when both tiers contribute', async () => {
  const db = seed()
  moreConvos(db, 2)
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'amber fox from the meadow' })  // words match (strict)
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c2', title: 'violet heron sketches' }) // similar
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c3', title: 'meadow picnic notes' })        // some_words only (shares "meadow")
  const similar = await withVectors(db, {
    'amber fox from the meadow': [1, 0, 0], 'violet heron sketches': [0.95, 0.31, 0], 'meadow picnic notes': [0.2, 0.98, 0],
    'amber fox meadow': [1, 0.05, 0],
  })
  const r = (await searchAll(db, 1, { query: 'amber fox meadow', similar })).results
  assert.deepEqual(r.map((x) => [x.title, x.why]), [
    ['amber fox from the meadow', 'words'],
    ['violet heron sketches', 'similar'],
    ['meadow picnic notes', 'some_words'],
  ])
})

// some_words is gated on the strict tiers alone being thin (fewer than
// THIN=5), measured before similar adds anything — not on the final count
// after similar runs. Five strict (words) hits plus a similar hit must NOT
// pull in a sixth, unrelated some_words-only candidate: if the gate were
// (wrongly) re-checked after similar ran, the outcome here would be the
// same either way, but this pins the required behaviour directly.
test('some_words does not run when the strict tiers alone give five or more results', async () => {
  const db = seed()
  moreConvos(db, 7)
  for (let i = 0; i < 5; i++) {
    createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: `c${i + 2}`, title: `amber fox sketch ${i}` })
  }
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c7', title: 'violet heron sketches' }) // similar
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c8', title: 'sketch backlog notes' })      // some_words only (shares "sketch")
  const vectors = { 'violet heron sketches': [0.95, 0.31, 0], 'sketch backlog notes': [0.1, 0.99, 0], 'amber fox sketch': [1, 0.05, 0] }
  for (let i = 0; i < 5; i++) vectors[`amber fox sketch ${i}`] = [1, 0, 0]
  const similar = await withVectors(db, vectors)
  const r = (await searchAll(db, 1, { query: 'amber fox sketch', similar })).results
  assert.equal(r.filter((x) => x.why === 'some_words').length, 0)
  assert.ok(!r.some((x) => x.title === 'sketch backlog notes'), 'the some_words-only candidate never surfaces')
  assert.ok(r.some((x) => x.why === 'similar'), 'similar still contributes')
})

test('literal queries never get similar results', async () => {
  const db = seed()
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'harbour' })
  const similar = await withVectors(db, { harbour: [1, 0, 0], 'PR 4242': [1, 0, 0] })
  assert.equal((await searchAll(db, 1, { query: 'PR 4242', similar })).results.length, 0)
})

test('similar respects visibility: a private status cannot surface its mission to an ordinary agent', async () => {
  const db = seed()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(2,1,'agent','box-b','h2',0,1)").run()
  upsertConversation(db, { id: 'cp', ownerUserId: 1, title: 'p', agentDeviceId: 2 })
  const { mission } = createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'plain title' })
  updateMission(db, { userId: 1, missionId: mission.id, fields: { status: 'hidden meaning' }, statusWriter: { by: 'agent', convoId: 'cp', deviceId: 2 } })
  const similar = await withVectors(db, { 'plain title': [0, 0, 1], 'hidden meaning': [1, 0, 0], 'what was that secret thing': [1, 0, 0] })
  assert.equal((await searchAll(db, 1, { query: 'what was that secret thing', similar, excludePrivateOwned: true })).results.length, 0)
  assert.equal((await searchAll(db, 1, { query: 'what was that secret thing', similar })).results.length, 1)
})

// excludeConsent must apply to a similar hit exactly as it applies to a
// lexical one (the similar tier reuses the same `visibility` string). The item's title shares no words with the query, so only the
// similar tier can find it — this pins excludeConsent there specifically,
// not just in the lexical tiers.
test('a consent item found only through similar is hidden when excludeConsent is true', async () => {
  const db = seed()
  createItem(db, { userId: 1, deviceId: 1, originDeviceId: 1, originConvoId: 'c1', createdBy: 'agent', kind: 'task', title: 'quiet otter errand', consent: 'spawn' })
  const similar = await withVectors(db, {
    'quiet otter errand': [1, 0, 0],
    'need the status of a secret task': [1, 0, 0],
  })
  const withIt = await searchAll(db, 1, { query: 'need the status of a secret task', similar })
  assert.equal(withIt.results.length, 1)
  assert.equal(withIt.results[0].why, 'similar')
  const without = await searchAll(db, 1, { query: 'need the status of a secret task', similar, excludeConsent: true })
  assert.equal(without.results.length, 0)
})

// Default-project rollup: createMission
// auto-creates a same-titled "default" project (default-project.js) — a
// project with exactly one mission whose title equals the project's own.
// Searching the shared title must return the mission once, not the mission
// and its twin project both.
test('a mission and its auto default project roll up to one mission result', async () => {
  const db = seed()
  const { mission } = createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'otter migration tracker' })
  const r = (await searchAll(db, 1, { query: 'otter migration tracker' })).results
  assert.equal(r.length, 1)
  assert.equal(r[0].kind, 'mission')
  assert.equal(r[0].num, mission.num)
})

// Not a default project: two missions share this project (and neither
// mission's title overlaps the project's own, so lexical tiers can't pull
// one in by accident either), so it keeps showing as its own project
// result rather than rolling up to either.
test('a project with two missions still shows as its own project result', async () => {
  const db = seed()
  moreConvos(db, 1)
  const { project } = createProject(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'quarterly beluga summary' })
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'otter burrow survey', projectId: project.id })
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c2', title: 'otter diet log', projectId: project.id })
  const r = (await searchAll(db, 1, { query: 'quarterly beluga summary' })).results
  assert.equal(r.length, 1)
  assert.equal(r[0].kind, 'project')
})

// Not a default project either: one mission, but its title differs from
// the project's own.
test('a one-mission project whose title differs from its mission still shows as a project', async () => {
  const db = seed()
  const { project } = createProject(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'spring beluga roundup' })
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'otter census outlook', projectId: project.id })
  const r = (await searchAll(db, 1, { query: 'spring beluga roundup' })).results
  assert.equal(r.length, 1)
  assert.equal(r[0].kind, 'project')
})

// The title/count match alone is not enough
// to call a project a TRUE default twin — a project born on a public box
// can hold exactly one same-titled mission that was simply filed into it
// from elsewhere, including a private box. Here: a public project "walrus lantern" with one same-titled mission
// created from a private box's conversation. Must return the project, not
// the hidden mission, for an ordinary agent — and the project is genuinely
// visible, so the result count stays 1 rather than dropping to 0.
test('a project does not roll up to a same-titled mission born on a private box', async () => {
  const db = seed()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(2,1,'agent','box-b','h2',0,1)").run()
  upsertConversation(db, { id: 'cp', ownerUserId: 1, title: 'p', agentDeviceId: 2 })
  const { project } = createProject(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'walrus lantern' })
  createMission(db, { userId: 1, deviceId: 2, createdBy: 'agent', convoId: 'cp', title: 'walrus lantern', projectId: project.id })
  const r = (await searchAll(db, 1, { query: 'walrus lantern', excludePrivateOwned: true })).results
  assert.equal(r.length, 1)
  assert.equal(r[0].kind, 'project')
})

// A project-only search must still find a
// default project — the roll-up exists to collapse a MISSION search's
// view of its own twin, not to make a default project unfindable when the
// caller never asked for missions at all.
test('kinds: [project] still finds a default project, unrolled', async () => {
  const db = seed()
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'otter migration tracker' })
  const r = (await searchAll(db, 1, { query: 'otter migration tracker', kinds: ['project'] })).results
  assert.equal(r.length, 1)
  assert.equal(r[0].kind, 'project')
})

// An embedder or vector-store failure during the
// similar tier must fall back to the lexical results, never a badQuery.
// The catch is expected to log (console.error), muted here per this
// suite's own convention (test/http.test.js etc.) to keep output clean.
test('an embedder failure during the similar tier falls back to the lexical results', async (t) => {
  const mute = t.mock.method(console, 'error', () => {})
  const db = seed()
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'lemur migration notes' })
  const similar = {
    embedder: { embedQuery: async () => { throw new Error('embedder down') } },
    store: { similarDocs: () => { throw new Error('must not be reached') } },
  }
  const r = await searchAll(db, 1, { query: 'lemur migration notes', similar })
  assert.equal(r.badQuery, undefined)
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0].title, 'lemur migration notes')
  assert.ok(mute.mock.callCount() >= 1, 'expected the failure to be logged')
})

test('a vector-store failure during the similar tier falls back to the lexical results', async (t) => {
  const mute = t.mock.method(console, 'error', () => {})
  const db = seed()
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'lemur migration notes' })
  const similar = {
    embedder: { embedQuery: async () => Float32Array.from([1, 0, 0]) },
    store: { similarDocs: () => { throw new Error('store down') } },
  }
  const r = await searchAll(db, 1, { query: 'lemur migration notes', similar })
  assert.equal(r.badQuery, undefined)
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0].title, 'lemur migration notes')
  assert.ok(mute.mock.callCount() >= 1, 'expected the failure to be logged')
})

// One per-user counter numbers items, missions, milestones and projects, so
// a bare number names at most one row; that row leads the results and the
// rows that only mention the number follow.
test('a bare number, with or without #, puts the row carrying that number first', async () => {
  const db = seed()
  moreConvos(db, 1)
  const { mission } = createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'paint the heron boat' })
  const { item } = createItem(db, { userId: 1, deviceId: 1, originDeviceId: 1, originConvoId: 'c1', createdBy: 'agent', kind: 'task', title: 'order kelp rope' })
  // A second mission that merely mentions the item's number in its text.
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c2', title: `follow up on ${item.num} next week` })
  for (const q of [String(item.num), `#${item.num}`, `  #${item.num} `]) {
    const r = (await searchAll(db, 1, { query: q })).results
    assert.equal(r[0].kind, 'item', q); assert.equal(r[0].id, item.id); assert.equal(r[0].why, 'number'); assert.equal(r[0].num, item.num)
    assert.ok(r.slice(1).some((x) => x.kind === 'mission' && x.why !== 'number'), 'mentions follow')
    assert.equal(r.filter((x) => x.id === item.id).length, 1, 'never listed twice')
  }
  const m = (await searchAll(db, 1, { query: `#${mission.num}` })).results[0]
  assert.equal(m.kind, 'mission'); assert.equal(m.id, mission.id); assert.equal(m.why, 'number')
})

test('a milestone number finds its mission; a default project number finds the project itself', async () => {
  const db = seed()
  const { mission } = createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'weave the kelp basket' })
  const { milestone } = createMilestone(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', kind: 'progress', title: 'first row woven', appendMarker: () => ({ seq: 1 }) })
  const viaMilestone = (await searchAll(db, 1, { query: String(milestone.num) })).results[0]
  assert.equal(viaMilestone.kind, 'mission'); assert.equal(viaMilestone.id, mission.id)
  assert.equal(viaMilestone.why, 'number'); assert.equal(viaMilestone.field, 'milestone')
  const projectNum = db.prepare('SELECT num FROM projects WHERE id=?').get(mission.project_id).num
  const viaProject = (await searchAll(db, 1, { query: `#${projectNum}` })).results[0]
  assert.equal(viaProject.kind, 'project'); assert.equal(viaProject.id, mission.project_id); assert.equal(viaProject.why, 'number')
})

test('the number tier keeps to kinds and visibility, and leaves other queries alone', async () => {
  const db = seed()
  const { item } = createItem(db, { userId: 1, deviceId: 1, originDeviceId: 1, originConvoId: 'c1', createdBy: 'agent', kind: 'task', title: 'gibbon consent ask', consent: 'spawn' })
  assert.equal((await searchAll(db, 1, { query: String(item.num) })).results[0].why, 'number')
  assert.deepEqual((await searchAll(db, 1, { query: String(item.num), excludeConsent: true })).results, [], 'hidden from agents like every other tier')
  assert.deepEqual((await searchAll(db, 1, { query: String(item.num), kinds: ['mission'] })).results, [])
  assert.deepEqual((await searchAll(db, 1, { query: '987654' })).results, [], 'unknown number')
  assert.ok((await searchAll(db, 1, { query: `gibbon ${item.num}` })).results.every((x) => x.why !== 'number'), 'only a bare number')
  // Another user's row with the same number is never reached.
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(2,'bob','x',0)").run()
  assert.deepEqual((await searchAll(db, 2, { query: String(item.num) })).results, [])
})
