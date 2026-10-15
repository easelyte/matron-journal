// test/vector-index.test.js (spec 2026-10-12 unified search §5)
import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeEmbedder } from '../src/embedder.js'
import { ensureVectorSchema, runVectorIndexer, createVectorStore, bufToVec } from '../src/vector-index.js'
import { seed } from './search-fixtures.js'
import { createMission } from '../src/missions.js'
import { upsertConversation } from '../src/journal.js'
import { createHash } from 'node:crypto'

// createMission attaches its convoId to the new mission; a second
// createMission call on the SAME already-attached convoId returns the
// existing mission rather than making a new one (src/missions.js,
// test/search-all.test.js documents the same gotcha) — so a test needing
// two distinct missions gives each its own conversation.
function moreConvos(db, n) {
  for (let i = 0; i < n; i++) upsertConversation(db, { id: `c${i + 2}`, ownerUserId: 1, title: `c${i + 2}`, agentDeviceId: 1 })
}

test('indexer embeds every doc once, re-embeds a changed doc, drops a deleted one', async () => {
  const db = seed(); ensureVectorSchema(db)
  const emb = fakeEmbedder()
  const { mission } = createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'alpha' })
  // createMission also creates a default project with the same title
  // (src/default-project.js), and search-docs.js indexes projects too — a
  // second, unrelated pending doc this test isn't about. Drop it so
  // "embeds every doc once" below is scoped to the mission's own doc.
  db.prepare("DELETE FROM search_docs WHERE kind='project'").run()
  assert.equal((await runVectorIndexer(db, emb)).embedded, 1)
  assert.equal((await runVectorIndexer(db, emb)).embedded, 0)
  db.prepare('UPDATE missions SET title=? WHERE id=?').run('bravo', mission.id)
  assert.equal((await runVectorIndexer(db, emb)).embedded, 1)
  db.prepare('DELETE FROM search_docs WHERE ref_id=?').run(mission.id)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_vectors').get().n, 0)
})

test('similarDocs ranks by cosine and honours the filter', async () => {
  const db = seed(); ensureVectorSchema(db)
  const emb = fakeEmbedder({ vectors: { near: [1, 0], far: [0, 1], q: [0.9, 0.1] }, dim: 2 })
  moreConvos(db, 1)
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'near' })
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c2', title: 'far' })
  // See the note in the test above: drop the default projects' own docs so
  // this test's two docs are exactly the missions named 'near' and 'far'.
  db.prepare("DELETE FROM search_docs WHERE kind='project'").run()
  await runVectorIndexer(db, emb)
  const store = createVectorStore(db, emb)
  const qv = await emb.embedQuery('q')
  const hits = store.similarDocs(1, qv, () => true, 5)
  const body = (id) => db.prepare('SELECT body FROM search_docs WHERE id=?').get(id).body
  assert.equal(body(hits[0].doc_id), 'near')
  assert.ok(hits[0].score > hits[1].score)
  assert.equal(store.similarDocs(1, qv, (id) => body(id) !== 'near', 5).length, 1)
})

test('loadEmbedder returns null (never throws) when the package or model is unavailable', async () => {
  const { loadEmbedder } = await import('../src/embedder.js')
  const e = await loadEmbedder({ modelDir: '/nonexistent/models', allowDownload: false, log: () => {} })
  assert.equal(e, null)
})

// better-sqlite3 copies a BLOB into a freshly
// allocated, 0-offset Buffer on read (checked directly: 50 reads of 8-12
// byte BLOBs all came back aligned), so a test that inserts an unaligned
// Buffer and reads it back through a real db never actually exercises
// bufToVec's copy branch — it passes even with that branch deleted. Test
// bufToVec directly instead, with a Buffer whose byteOffset is forced to 1
// (never a multiple of 4) by slicing it out of a larger ArrayBuffer.
test('bufToVec reads a vector at byteOffset 0 and at an unaligned byteOffset alike', () => {
  const raw = new ArrayBuffer(1 + 2 * 4)
  const view = new DataView(raw)
  view.setFloat32(1, 1, true)
  view.setFloat32(5, 0.5, true)
  const unaligned = Buffer.from(raw, 1, 2 * 4)
  assert.equal(unaligned.byteOffset % 4, 1)
  assert.deepEqual(Array.from(bufToVec(unaligned, 2)), [1, 0.5])

  const aligned = Buffer.alloc(2 * 4)
  aligned.writeFloatLE(1, 0)
  aligned.writeFloatLE(0.5, 4)
  assert.equal(aligned.byteOffset % 4, 0)
  assert.deepEqual(Array.from(bufToVec(aligned, 2)), [1, 0.5])
})

// `rows` (and their bodies) are read
// before `embedder.embedDocs` is awaited — with the real model that await
// can take hundreds of ms per batch, long enough for a doc to be deleted
// or edited out from under it. An embedder that mutates the db from
// inside embedDocs simulates exactly that window.
test('a doc deleted mid-batch gets no vector; a doc edited mid-batch is re-embedded next run', async () => {
  const db = seed(); ensureVectorSchema(db)
  moreConvos(db, 1)
  const { mission: delMission } = createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'deleteme' })
  const { mission: editMission } = createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c2', title: 'editme' })
  db.prepare("DELETE FROM search_docs WHERE kind='project'").run()
  const delDoc = db.prepare("SELECT id FROM search_docs WHERE kind='mission' AND ref_id=?").get(delMission.id)
  const editDoc = db.prepare("SELECT id FROM search_docs WHERE kind='mission' AND ref_id=?").get(editMission.id)

  const real = fakeEmbedder()
  let batches = 0
  const racing = {
    model: real.model, dim: real.dim, embedQuery: real.embedQuery,
    // Mutate the db as if another request ran while this batch's
    // embedDocs call was in flight, then resolve normally.
    embedDocs: async (texts) => {
      batches++
      db.prepare('DELETE FROM missions WHERE id=?').run(delMission.id)
      db.prepare('UPDATE missions SET title=? WHERE id=?').run('edited', editMission.id)
      return real.embedDocs(texts)
    },
  }
  // runVectorIndexer loops internally until nothing is pending, which would
  // otherwise self-correct the "edited" doc in a second internal batch
  // (its body is stable by then) and hide the bug this test is for.
  // shouldStop pins this run to exactly the one racing batch, as if it
  // were a single external call — a later, separate call is what's
  // supposed to pick the edited doc back up.
  await runVectorIndexer(db, racing, { shouldStop: () => batches >= 1 })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_vectors WHERE doc_id=?').get(delDoc.id).n, 0,
    'the deleted doc gets no vector at all')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_vectors WHERE doc_id=?').get(editDoc.id).n, 0,
    'the edited doc gets no vector for its old (now stale) body')

  // Next run, with a normal embedder: the edited doc is still pending
  // (its stored text_hash never got written) and is re-embedded for its
  // NEW body.
  const r2 = await runVectorIndexer(db, real)
  assert.equal(r2.embedded, 1)
  const row = db.prepare('SELECT text_hash FROM search_vectors WHERE doc_id=?').get(editDoc.id)
  assert.ok(row)
  const newBody = db.prepare('SELECT body FROM search_docs WHERE id=?').get(editDoc.id).body
  assert.equal(newBody, 'edited')
})

test('similarDocs throws a clear error when the query vector length does not match the embedder', async () => {
  const db = seed(); ensureVectorSchema(db)
  const emb = fakeEmbedder({ dim: 16 })
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'alpha' })
  await runVectorIndexer(db, emb)
  const store = createVectorStore(db, emb)
  assert.throws(() => store.similarDocs(1, Float32Array.from([1, 0]), () => true, 5), /dim/)
})

test('an idle pass does no per-doc work; editing a body drops its vector and makes it pending', async () => {
  const db = seed(); ensureVectorSchema(db)
  moreConvos(db, 50)
  for (let i = 0; i < 50; i++) createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: `c${i + 2}`, title: `heron ${i}` })
  const real = fakeEmbedder()
  let calls = 0
  const counting = { ...real, embedDocs: async (texts) => { calls++; return real.embedDocs(texts) } }
  await runVectorIndexer(db, counting)
  // Count body hashing from here on: the indexer registers sd_hash once
  // per handle, so this replacement is what any later pass would call.
  let hashed = 0
  db.function('sd_hash', { deterministic: true }, (s) => { hashed++; return createHash('sha256').update(s).digest('hex').slice(0, 16) })
  calls = 0
  assert.equal((await runVectorIndexer(db, counting)).embedded, 0)
  assert.equal(calls, 0, 'the embedder is not called on an idle pass')
  assert.equal(hashed, 0, 'no body is hashed on an idle pass')

  const doc = db.prepare("SELECT id FROM search_docs WHERE kind='mission' AND body='heron 7'").get()
  db.prepare("UPDATE missions SET title='heron seven' WHERE title='heron 7'").run()
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_vectors WHERE doc_id=?').get(doc.id).n, 0, 'an edited body drops its vector at once')
  assert.equal((await runVectorIndexer(db, counting)).embedded, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_vectors WHERE doc_id=?').get(doc.id).n, 1)
})

test('vectors from another model are re-embedded with the current one', async () => {
  const db = seed(); ensureVectorSchema(db)
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'alpha' })
  const total = db.prepare('SELECT COUNT(*) n FROM search_docs').get().n
  await runVectorIndexer(db, fakeEmbedder({ dim: 4 }))
  const r = await runVectorIndexer(db, fakeEmbedder({ dim: 8 }))
  assert.equal(r.embedded, total)
  assert.deepEqual(db.prepare('SELECT DISTINCT model FROM search_vectors').all().map((x) => x.model), ['fake-8'])
})

test('similarDocs returns the same best-first order as a full sort, and widens past a rejecting filter', async () => {
  const db = seed(); ensureVectorSchema(db)
  moreConvos(db, 60)
  for (let i = 0; i < 60; i++) createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: `c${i + 2}`, title: `swallow ${i}` })
  // Default projects repeat each title, so their vectors would tie.
  db.prepare("DELETE FROM search_docs WHERE kind='project'").run()
  const emb = fakeEmbedder({ dim: 8 })
  await runVectorIndexer(db, emb)
  const store = createVectorStore(db, emb)
  const qv = await emb.embedQuery('a query about swallows')
  const all = db.prepare('SELECT doc_id, vec FROM search_vectors').all().map((r) => {
    const v = bufToVec(r.vec, 8)
    return { doc_id: r.doc_id, score: v.reduce((s, x, j) => s + x * qv[j], 0) }
  }).sort((a, b) => b.score - a.score)
  const top = store.similarDocs(1, qv, () => true, 5)
  assert.deepEqual(top.map((h) => h.doc_id), all.slice(0, 5).map((h) => h.doc_id))
  // Accept only the five worst-scoring docs: the first window holds none
  // of them, so the store has to widen to find them.
  const worst = new Set(all.slice(-5).map((h) => h.doc_id))
  const found = store.similarDocs(1, qv, (id) => worst.has(id), 5)
  assert.deepEqual(new Set(found.map((h) => h.doc_id)), worst)
})

test('the indexer folds new vectors into a cached matrix in place, and an idle cache is dropped', async () => {
  const db = seed(); ensureVectorSchema(db)
  moreConvos(db, 1)
  const emb = fakeEmbedder({ dim: 2, vectors: { near: [1, 0], later: [0.9, 0.1], q: [1, 0] } })
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'near' })
  db.prepare("DELETE FROM search_docs WHERE kind='project'").run()
  let clock = 0
  const store = createVectorStore(db, emb, { idleMs: 1000, now: () => clock })
  await runVectorIndexer(db, emb, { onWrite: (rows) => store.upsertVectors(rows) })
  const qv = await emb.embedQuery('q')
  const body = (id) => db.prepare('SELECT body FROM search_docs WHERE id=?').get(id).body
  assert.deepEqual(store.similarDocs(1, qv, () => true, 5).map((h) => body(h.doc_id)), ['near'])

  // Built: from here, a reload would read search_vectors. Hide the old row
  // from SQL; an in-place update keeps it in the cache alongside the new one.
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c2', title: 'later' })
  db.prepare("DELETE FROM search_docs WHERE kind='project'").run()
  await runVectorIndexer(db, emb, { onWrite: (rows) => store.upsertVectors(rows) })
  const nearDoc = db.prepare("SELECT id FROM search_docs WHERE body='near'").get().id
  db.prepare('DELETE FROM search_vectors WHERE doc_id=?').run(nearDoc)
  assert.deepEqual(store.similarDocs(1, qv, () => true, 5).map((h) => body(h.doc_id)), ['near', 'later'])

  // Unused for longer than idleMs: dropped, so the next query reloads.
  clock += 2000
  assert.deepEqual(store.similarDocs(1, qv, () => true, 5).map((h) => body(h.doc_id)), ['later'])
})

test('a malformed vector BLOB is dropped with one log line and re-embedded; the tier keeps working', async () => {
  const db = seed(); ensureVectorSchema(db)
  moreConvos(db, 1)
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'near' })
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c2', title: 'far' })
  db.prepare("DELETE FROM search_docs WHERE kind='project'").run()
  const emb = fakeEmbedder({ dim: 2, vectors: { near: [1, 0], far: [0, 1], q: [1, 0] } })
  await runVectorIndexer(db, emb)
  const nearDoc = db.prepare("SELECT id FROM search_docs WHERE body='near'").get().id
  db.prepare('UPDATE search_vectors SET vec=? WHERE doc_id=?').run(Buffer.from([1, 2, 3]), nearDoc)

  const logs = []
  const store = createVectorStore(db, emb, { log: (l) => logs.push(l) })
  const qv = await emb.embedQuery('q')
  const hits = store.similarDocs(1, qv, () => true, 5)
  assert.deepEqual(hits.map((h) => h.doc_id).includes(nearDoc), false, 'the malformed row is skipped')
  assert.equal(hits.length, 1, 'the other doc is still scored')
  assert.equal(logs.length, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_vectors WHERE doc_id=?').get(nearDoc).n, 0, 'the row is deleted')
  assert.equal((await runVectorIndexer(db, emb)).embedded, 1, 'so the indexer re-embeds it')
})

test('a doc the embedder throws on is skipped for the run; the rest of the index still builds', async () => {
  const db = seed(); ensureVectorSchema(db)
  moreConvos(db, 5)
  for (const [i, title] of ['amber', 'poison', 'cobalt', 'violet', 'russet', 'teal'].entries()) {
    createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: `c${i + 1}`, title })
  }
  db.prepare("DELETE FROM search_docs WHERE kind='project'").run()
  const real = fakeEmbedder()
  let calls = 0
  const flaky = {
    ...real,
    embedDocs: async (texts) => {
      calls++
      if (texts.includes('poison')) throw new Error('cannot embed')
      return real.embedDocs(texts)
    },
  }
  const skipped = new Set()
  const logs = []
  const r = await runVectorIndexer(db, flaky, { batchSize: 3, skipped, log: (l) => logs.push(l) })
  assert.equal(r.embedded, 5)
  const poisonDoc = db.prepare("SELECT id FROM search_docs WHERE body='poison'").get().id
  assert.deepEqual([...skipped], [poisonDoc])
  assert.equal(logs.filter((l) => l.includes('skipping')).length, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_vectors').get().n, 5)

  calls = 0
  assert.equal((await runVectorIndexer(db, flaky, { skipped })).embedded, 0)
  assert.equal(calls, 0, 'a later pass in the same run does not retry the skipped doc')
})

test('similarDocs never offers a doc scoring below minScore to the filter', async () => {
  const db = seed(); ensureVectorSchema(db)
  moreConvos(db, 30)
  const vectors = { near: [1, 0], q: [1, 0] }
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'near' })
  for (let i = 0; i < 30; i++) {
    createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: `c${i + 2}`, title: `far ${i}` })
    vectors[`far ${i}`] = [0.1, 1]
  }
  db.prepare("DELETE FROM search_docs WHERE kind='project'").run()
  const emb = fakeEmbedder({ dim: 2, vectors })
  await runVectorIndexer(db, emb)
  const store = createVectorStore(db, emb)
  const nearDoc = db.prepare("SELECT id FROM search_docs WHERE body='near'").get().id
  const asked = []
  // A filter that rejects everything forces the window to widen as far as
  // it can; the floor must still stop it at the one doc above 0.5.
  const hits = store.similarDocs(1, await emb.embedQuery('q'), (id) => { asked.push(id); return false }, 5, { minScore: 0.5 })
  assert.deepEqual(hits, [])
  assert.deepEqual(asked, [nearDoc])
})

test('when every doc in a failed batch fails alone too, nothing is skipped and the pass ends', async () => {
  const db = seed(); ensureVectorSchema(db)
  moreConvos(db, 5)
  for (let i = 0; i < 6; i++) createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: `c${i + 1}`, title: `heron ${i}` })
  db.prepare("DELETE FROM search_docs WHERE kind='project'").run()
  const real = fakeEmbedder()
  let down = true
  let calls = 0
  const flaky = { ...real, embedDocs: async (texts) => { calls++; if (down) throw new Error('model down'); return real.embedDocs(texts) } }
  const skipped = new Set()
  const r = await runVectorIndexer(db, flaky, { batchSize: 3, skipped })
  assert.equal(r.embedded, 0)
  assert.equal(skipped.size, 0, 'no doc is blamed for an embedder outage')
  assert.equal(calls, 4, 'one batch call and three single retries, then the pass stops')

  down = false
  assert.equal((await runVectorIndexer(db, flaky, { batchSize: 3, skipped })).embedded, 6, 'the next pass heals')
})

test('a stopped pass keeps what it embedded; the next pass embeds only the rest, pausing between batches', async () => {
  const db = seed(); ensureVectorSchema(db)
  moreConvos(db, 5)
  for (let i = 0; i < 6; i++) createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: `c${i + 1}`, title: `mission ${i}` })
  const total = db.prepare('SELECT COUNT(*) n FROM search_docs').get().n
  const emb = fakeEmbedder()
  let batches = 0
  const r1 = await runVectorIndexer(db, emb, { batchSize: 2, shouldStop: () => ++batches > 1 })
  assert.equal(r1.embedded, 2)
  let pauses = 0
  const embeddedTexts = []
  const counting = { ...emb, embedDocs: async (texts) => { embeddedTexts.push(...texts); return emb.embedDocs(texts) } }
  const r2 = await runVectorIndexer(db, counting, { batchSize: 2, pause: async () => { pauses++ } })
  assert.equal(r2.embedded, total - 2)
  assert.equal(embeddedTexts.length, total - 2, 'nothing embedded twice')
  assert.equal(pauses, Math.ceil((total - 2) / 2))
})
