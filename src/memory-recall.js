// Memory recall: the memories that bear on a piece of text. Two callers,
// two modes:
//
//   query  an agent asks in its own words ("cleaning up disk space on a
//          Mac"). A short query runs unified search's tiers over memories
//          (exact, words, stemmed, similar, some words); a long one runs
//          the similar pass alone.
//   auto   the bridge hands over the text of a turn the agent is about to
//          get, to add the on-demand rules that bear on it. Only the
//          embedding pass runs: any-word matching on a whole message would
//          pull in every memory that shares a common word. A match must
//          clear two bars: a similarity floor, and standing out from the
//          user's other memories for this text (z-score of its similarity
//          against all of them). A small embedding model scores most text
//          pairs alike, so a fixed floor alone either misses real matches
//          or lets in near-misses; a turn that bears on a rule makes that
//          rule stand out from the rest.
//
// Both answer with whole memories (the body included), so the agent reads
// the rule itself rather than a summary of it. The embedding model runs
// in-process (src/embedder.js); no text leaves the journal. Without a
// ready vector index, `auto` finds nothing and `query` falls back to the
// word tiers.
import { searchAll } from './search-all.js'
import { getMemory, privateOrigin, validScope, MEMORY_TIERS, MEMORIES_MAX } from './memories.js'

export const RECALL_TEXT_MAX = 4000
export const RECALL_QUERY_MAX = 256 // longer query text skips the word tiers
export const RECALL_LIMIT_MAX = 10
export const RECALL_DEFAULT_LIMIT = 3
export const RECALL_EXCLUDE_MAX = 200
// The two bars for `auto` (cosine similarity and z-score, bge-small). A
// caller may move them within [0.5, 0.95] and [1, 6].
export const RECALL_AUTO_MIN = 0.62
export const RECALL_AUTO_MIN_Z = 3
// Fewer memories than this and a z-score means little: `auto` then uses
// the floor alone.
const Z_MIN_POPULATION = 20
const EMBED_MAX = 2000

const bad = { bad: true }

// The body of POST /memories/recall → { ok, value } or bad.
export function validateRecall(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return bad
  const { text, mode = 'query', scopes, tier, exclude, limit, min_score: minScore, min_z: minZ } = body
  if (typeof text !== 'string' || !text.trim() || text.length > RECALL_TEXT_MAX) return bad
  if (mode !== 'query' && mode !== 'auto') return bad
  if (scopes !== undefined && (!Array.isArray(scopes) || scopes.length > 20 || !scopes.every(validScope))) return bad
  if (tier !== undefined && !MEMORY_TIERS.includes(tier)) return bad
  if (exclude !== undefined && (!Array.isArray(exclude) || exclude.length > RECALL_EXCLUDE_MAX || !exclude.every((n) => typeof n === 'string' && n.length <= 64))) return bad
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > RECALL_LIMIT_MAX)) return bad
  if (minScore !== undefined && (typeof minScore !== 'number' || !(minScore >= 0.5 && minScore <= 0.95))) return bad
  if (minZ !== undefined && (typeof minZ !== 'number' || !(minZ >= 1 && minZ <= 6))) return bad
  return {
    ok: true,
    value: {
      text: text.trim(), mode, scopes: scopes ?? null, tier: tier ?? null,
      exclude: new Set(exclude ?? []), limit: limit ?? RECALL_DEFAULT_LIMIT,
      minScore: minScore ?? RECALL_AUTO_MIN, minZ: minZ ?? RECALL_AUTO_MIN_Z,
    },
  }
}

// → { memories: [{ ...memory, score, why }], semantic: 'ready'|'indexing'|'off' }
export async function recallMemories(db, userId, { text, mode, scopes, tier, exclude, limit, minScore, minZ }, { excludePrivateOwned = false, semantic = null } = {}) {
  const status = semantic?.store ? semantic.store.status() : 'off'
  const ready = status === 'ready' ? semantic : null
  const scopeSet = scopes ? new Set(scopes) : null
  const wanted = (m) => !!m
    && !(excludePrivateOwned && privateOrigin(m))
    && (!scopeSet || scopeSet.has(m.scope))
    && (!tier || m.tier === tier)
    && !exclude.has(m.name)
  const out = []
  const seen = new Set()
  // A hit whose memory was deleted while the search awaited the embedding
  // reads back as null: skipped by `wanted`, before anything reads it.
  const add = (m, score, why) => {
    if (out.length >= limit || !wanted(m) || seen.has(m.id)) return
    seen.add(m.id)
    out.push({ ...m, score: score == null ? null : Number(score.toFixed(3)), why })
  }

  if (mode === 'query' && text.length <= RECALL_QUERY_MAX) {
    const r = await searchAll(db, userId, {
      // Every matching memory (a user holds at most MEMORIES_MAX), so the
      // scope, tier and exclude filters below never lose a match to a
      // result limit applied before them.
      query: text, kinds: ['memory'], limit: MEMORIES_MAX, excludePrivateOwned,
      similar: ready ? { store: ready.store, embedder: ready.embedder } : null,
    })
    for (const hit of r.results ?? []) add(getMemory(db, userId, hit.id), hit.score ?? null, hit.why)
    return { memories: out, semantic: status }
  }

  if (!ready) return { memories: out, semantic: status }
  // The user's memory docs this caller may see: the candidates, and for
  // `auto` the population the z-score is taken over (all of them, not only
  // the wanted ones, so a narrow audience does not make its own best match
  // look outstanding).
  const docs = new Map()
  for (const r of db.prepare("SELECT id, ref_id FROM search_docs WHERE user_id=? AND kind='memory'").all(userId)) {
    const m = getMemory(db, userId, r.ref_id)
    if (m && !(excludePrivateOwned && privateOrigin(m))) docs.set(r.id, m)
  }
  try {
    const qv = await ready.embedder.embedQuery(text.slice(0, EMBED_MAX))
    const scored = ready.store.scoreDocs(userId, qv, [...docs.keys()]).sort((a, b) => b.score - a.score)
    const n = scored.length
    const mean = scored.reduce((a, h) => a + h.score, 0) / (n || 1)
    const sd = Math.sqrt(scored.reduce((a, h) => a + (h.score - mean) ** 2, 0) / (n || 1)) || 1
    const floor = mode === 'auto' ? minScore : Math.min(minScore, 0.7)
    for (const h of scored) {
      if (h.score < floor || out.length >= limit) break
      if (mode === 'auto' && n >= Z_MIN_POPULATION && (h.score - mean) / sd < minZ) continue
      add(docs.get(h.doc_id), h.score, 'similar')
    }
  } catch (err) {
    // A failed embedding pass answers "nothing recalled", never an error:
    // a turn must not wait on, or fail for, its reminders.
    console.error('memories/recall similar pass failed', err)
  }
  return { memories: out, semantic: status }
}
