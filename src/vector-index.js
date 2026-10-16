// Per-user vector index over search_docs. One row per doc that has been
// embedded. A doc whose body changes loses its vector (trigger below), and
// vectors from a different embedding model are dropped before a pass, so
// "pending" is simply "a doc with no vector": an anti-join against this
// table's primary key, with no per-doc hashing on the idle path.
import { createHash } from 'node:crypto'
import { yieldTurn } from './background.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS search_vectors(
  doc_id    INTEGER PRIMARY KEY,
  user_id   INTEGER NOT NULL,
  model     TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  vec       BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_vectors_user ON search_vectors(user_id);
CREATE TRIGGER IF NOT EXISTS search_vectors_doc_ad AFTER DELETE ON search_docs BEGIN
  DELETE FROM search_vectors WHERE doc_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS search_vectors_doc_au AFTER UPDATE OF body ON search_docs
  WHEN old.body IS NOT new.body BEGIN
  DELETE FROM search_vectors WHERE doc_id = new.id;
END;`

export function ensureVectorSchema(db) { db.exec(SCHEMA) }

const hashOf = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)

// better-sqlite3 re-registers a same-named function without error (checked
// on 11.10.0), but there is no need to redo it every call: one registration
// per db handle, tracked here.
const hashFnRegistered = new WeakSet()
function ensureHashFn(db) {
  if (hashFnRegistered.has(db)) return
  db.function('sd_hash', { deterministic: true }, (s) => hashOf(s))
  hashFnRegistered.add(db)
}

// A BLOB column read back from better-sqlite3 is a Buffer whose byteOffset
// into its underlying ArrayBuffer is not guaranteed to be a multiple of 4
// (small Buffers are carved out of a shared pool at whatever offset is next
// free) — `new Float32Array(buf.buffer, buf.byteOffset, dim)` throws
// RangeError in that case. Copy the bytes out to a fresh, aligned
// ArrayBuffer only when needed. Exported so the unaligned path can be unit
// tested directly, without depending on better-sqlite3 ever actually
// handing back an odd byteOffset (in practice it always copies BLOB reads
// into a freshly allocated, 0-offset Buffer, so a round trip through a real
// db can't exercise this branch).
export function bufToVec(buf, dim) {
  if (buf.byteOffset % 4 === 0) return new Float32Array(buf.buffer, buf.byteOffset, dim)
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + dim * 4))
}

const purgedFor = new WeakMap()

// Embeds every doc that has no vector yet. One batch per event-loop turn,
// like the message backfill — better-sqlite3 is synchronous and the server
// must keep answering while a first full index runs. The pass walks doc ids
// upwards from a cursor, so each batch's query starts where the last one
// stopped instead of rescanning every doc already embedded.
// `onWrite` receives the vectors a batch actually stored ({ doc_id,
// user_id, vec }), so a vector store can fold them into its cache.
// `skipped` holds the ids of docs the embedder failed on; pass the same Set
// to every pass in a process so such a doc is tried once per process run,
// not on every sweep.
export async function runVectorIndexer(db, embedder, { batchSize = 32, shouldStop = () => false, pause = yieldTurn, log = () => {}, onWrite = () => {}, skipped = new Set() } = {}) {
  ensureHashFn(db)
  // Vectors from another model are never read, and keeping them would make
  // "pending" need a model comparison per doc; dropping them makes those
  // docs pending again. Only this process writes vectors, so once per
  // handle and model is enough.
  if (purgedFor.get(db) !== embedder.model) {
    db.prepare('DELETE FROM search_vectors WHERE model <> ?').run(embedder.model)
    purgedFor.set(db, embedder.model)
  }
  const pendingSql = db.prepare(`
    SELECT d.id, d.user_id, d.body FROM search_docs d
    LEFT JOIN search_vectors v ON v.doc_id = d.id
    WHERE d.id > ? AND v.doc_id IS NULL
    ORDER BY d.id
    LIMIT ?`)
  // `rows` is read, then `embedder.embedDocs` is awaited — with the real
  // model that can take hundreds of ms per batch, long enough for a doc to
  // be deleted or edited out from under it. The write below re-checks
  // `search_docs` INSIDE the same transaction: it inserts only when the doc
  // still exists with the exact body hash just embedded, so a doc deleted
  // meanwhile gets no vector at all (a plain VALUES insert would write an
  // orphan the delete trigger had no row to remove), and a doc edited
  // meanwhile gets no *stale* vector — it stays pending and is re-embedded,
  // with its new body, on the next pass. `user_id=excluded.user_id` on
  // conflict matters because `search_docs.id` has no AUTOINCREMENT
  // (src/search-docs.js): a reused id could otherwise leave a vector
  // tagged with a stale, possibly different, user_id.
  const upsert = db.prepare(`
    INSERT INTO search_vectors(doc_id, user_id, model, text_hash, vec)
      SELECT d.id, d.user_id, @model, @hash, @vec
      FROM search_docs d WHERE d.id = @id AND sd_hash(d.body) = @hash
    ON CONFLICT(doc_id) DO UPDATE SET
      user_id=excluded.user_id, model=excluded.model, text_hash=excluded.text_hash, vec=excluded.vec`)
  let embedded = 0
  let cursor = 0
  for (;;) {
    if (shouldStop()) break
    const page = pendingSql.all(cursor, batchSize)
    if (page.length === 0) break
    cursor = page[page.length - 1].id
    const rows = page.filter((r) => !skipped.has(r.id))
    if (rows.length === 0) continue
    const vecs = await embedRows(embedder, rows, { skipped, log })
    if (!vecs) break
    const written = []
    db.transaction(() => {
      rows.forEach((r, i) => {
        if (!vecs[i]) return
        const vec = Buffer.from(vecs[i].buffer, vecs[i].byteOffset, vecs[i].byteLength)
        const { changes } = upsert.run({ id: r.id, model: embedder.model, hash: hashOf(r.body), vec })
        if (changes) written.push({ doc_id: r.id, user_id: r.user_id, vec: vecs[i] })
      })
    })()
    embedded += written.length
    if (written.length) onWrite(written)
    log(`vector index: embedded ${embedded}`)
    await pause()
  }
  return { embedded }
}

// One doc the embedder throws on must not hold back the rest: when a batch
// fails, its docs are retried one at a time, and a doc that still fails
// while others in its batch succeed is added to `skipped` and left without
// a vector. When every retry fails too, the embedder itself is the likely
// problem, not the docs: nothing is skipped and this returns null, so the
// caller ends the pass and the next sweep tries again. Otherwise returns
// one vector per row, or undefined for a skipped doc.
async function embedRows(embedder, rows, { skipped, log }) {
  try {
    return await embedder.embedDocs(rows.map((r) => r.body))
  } catch (batchErr) {
    const out = []
    const failed = []
    for (const r of rows) {
      try {
        out.push((await embedder.embedDocs([r.body]))[0])
      } catch (err) {
        failed.push({ r, err })
        out.push(undefined)
      }
    }
    if (failed.length === rows.length) {
      log(`vector index: embedder failing (${batchErr.message}); stopping this pass`)
      return null
    }
    for (const { r, err } of failed) {
      skipped.add(r.id)
      log(`vector index: skipping doc ${r.id} for this run, the embedder failed on it (${err.message})`)
    }
    return out
  }
}

// Keeps the k best of `n` scores without sorting them all: a min-heap of
// row indices, so the cost is O(n log k). Returns indices, best first.
function topIndices(scores, n, k) {
  if (k <= 0) return []
  const heap = new Int32Array(k)
  let size = 0
  const less = (a, b) => scores[heap[a]] < scores[heap[b]]
  const swap = (a, b) => { const t = heap[a]; heap[a] = heap[b]; heap[b] = t }
  const down = (i) => {
    for (;;) {
      const l = 2 * i + 1, r = l + 1
      let m = i
      if (l < size && less(l, m)) m = l
      if (r < size && less(r, m)) m = r
      if (m === i) return
      swap(i, m); i = m
    }
  }
  for (let i = 0; i < n; i++) {
    if (size < k) {
      heap[size] = i
      let c = size++
      while (c > 0) {
        const p = (c - 1) >> 1
        if (!less(c, p)) break
        swap(c, p); c = p
      }
    } else if (scores[i] > scores[heap[0]]) {
      heap[0] = i
      down(0)
    }
  }
  const out = new Array(size)
  for (let j = size - 1; j >= 0; j--) { out[j] = heap[0]; heap[0] = heap[--size]; down(0) }
  return out
}

const IDLE_MS = 10 * 60_000

// Per-user matrix cache: n×dim floats plus the doc ids, built lazily on a
// user's first similar query. `upsertVectors` folds the indexer's freshly
// written vectors into any cached matrix in place (overwriting a doc's row,
// or appending), so indexing never forces a full reload. A doc deleted
// after its user's matrix was built keeps a cached row until the cache is
// dropped; the caller's filter re-checks every hit against search_docs, so
// such a row is never returned. A user's matrix is dropped after `idleMs`
// without a query, which bounds memory to the users actually searching.
// `setIndexing`/`status` let the caller say "no similar tier yet" while a
// first full index run is in flight.
export function createVectorStore(db, embedder, { idleMs = IDLE_MS, now = Date.now, log = console.error } = {}) {
  const dim = embedder.dim
  const cache = new Map()
  let indexing = true
  const evictIdle = () => {
    const t = now()
    for (const [u, e] of cache) if (t - e.usedAt > idleMs) cache.delete(u)
  }
  const load = (userId) => {
    const rows = db.prepare('SELECT doc_id, vec FROM search_vectors WHERE user_id=? AND model=?').all(userId, embedder.model)
    const entry = { ids: new Int32Array(rows.length), mat: new Float32Array(rows.length * dim), n: 0, rowOf: new Map(), usedAt: now() }
    for (const r of rows) {
      // A truncated or corrupt BLOB can't be read as a vector. Drop the row
      // so the indexer re-embeds the doc, rather than failing every query.
      if (r.vec.length !== dim * 4) {
        log(`vector index: dropping malformed vector for doc ${r.doc_id} (${r.vec.length} bytes, expected ${dim * 4})`)
        db.prepare('DELETE FROM search_vectors WHERE doc_id=?').run(r.doc_id)
        continue
      }
      entry.ids[entry.n] = r.doc_id
      entry.mat.set(bufToVec(r.vec, dim), entry.n * dim)
      entry.rowOf.set(r.doc_id, entry.n++)
    }
    cache.set(userId, entry)
    return entry
  }
  const put = (entry, docId, vec) => {
    let row = entry.rowOf.get(docId)
    if (row === undefined) {
      if (entry.n === entry.ids.length) {
        const cap = Math.max(16, entry.n * 2)
        const ids = new Int32Array(cap); ids.set(entry.ids)
        const mat = new Float32Array(cap * dim); mat.set(entry.mat)
        entry.ids = ids; entry.mat = mat
      }
      row = entry.n++
      entry.ids[row] = docId
      entry.rowOf.set(docId, row)
    }
    entry.mat.set(vec, row * dim)
  }
  return {
    // The k best docs passing `filter`, best first. Docs scoring below
    // `minScore` are never returned and never offered to the filter: a
    // caller that discards them anyway saves a filter call per doc, which
    // matters when the filter rejects most docs (a sparse `kinds` search).
    similarDocs(userId, qv, filter, k, { minScore = -Infinity } = {}) {
      if (qv.length !== dim) {
        throw new Error(`similarDocs: queryVec length ${qv.length} does not match embedder dim ${dim}`)
      }
      evictIdle()
      const entry = cache.get(userId) ?? load(userId)
      entry.usedAt = now()
      const { ids, mat, n } = entry
      const scores = new Float32Array(n)
      let eligible = 0
      for (let i = 0; i < n; i++) {
        let s = 0
        const o = i * dim
        for (let j = 0; j < dim; j++) s += mat[o + j] * qv[j]
        scores[i] = s
        if (s >= minScore) eligible++
      }
      // Best-first until k docs pass the filter. Most queries need only the
      // first window; a filter that rejects many widens it, up to the docs
      // at or above the floor, without re-scoring and without asking the
      // filter about a doc twice.
      const seen = new Map()
      const passes = (docId) => {
        if (!seen.has(docId)) seen.set(docId, !!filter(docId))
        return seen.get(docId)
      }
      for (let window = Math.min(eligible, Math.max(2 * k, 16)); ; window = Math.min(eligible, window * 4)) {
        const out = []
        for (const i of topIndices(scores, n, window)) {
          if (out.length >= k) break
          if (passes(ids[i])) out.push({ doc_id: ids[i], score: scores[i] })
        }
        if (out.length >= k || window >= eligible) return out
      }
    },
    upsertVectors(rows) {
      evictIdle()
      for (const r of rows) {
        const entry = cache.get(r.user_id)
        if (entry) put(entry, r.doc_id, r.vec)
      }
    },
    setIndexing(v) { indexing = v },
    status() { return indexing ? 'indexing' : 'ready' },
  }
}
