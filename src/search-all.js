// Tiered tracker search, rolled up to the entity a person is looking for
// (spec 2026-10-12 unified search §3/§4). Tiers run strict-to-loose over
// search_docs; the first (best) tier a doc is found in is the entity's
// `why`, and within a tier bm25 plus recency order the candidates.
import { parseQuery, matchExact, matchAll, matchAny } from './search-query.js'
import { docVisibilitySql, missionOk } from './search-docs.js'
import { ORIGIN_SIEVE } from './missions.js'

export const TIERS = ['number', 'exact','words', 'stemmed', 'similar', 'some_words']
const KINDS = ['mission', 'item', 'memory', 'project']
const THIN = 5 // fewer strict results than this → some_words tier runs
const MAX_PAGES = 4 // per tier; see runTier

// Similar-tier defaults: a hit needs cosine
// similarity at least SIMILAR_MIN, and no more than SIMILAR_MARGIN below
// the best similar score for this query; at most SIMILAR_MAX such hits.
export const SIMILAR_MIN = 0.70
export const SIMILAR_MARGIN = 0.06
export const SIMILAR_MAX = 5

// The search_docs kinds that can roll up to each entity kind: a milestone
// (and a default project) rolls up to its mission, a comment to its item.
// Filtering on these in SQL keeps a `kinds` search from spending its pool
// on docs that could never become a wanted result.
const DOC_KINDS = {
  mission: ['mission', 'milestone', 'project'],
  item: ['item', 'comment'],
  memory: ['memory'],
  project: ['project'],
}
function docKindSql(want) {
  const kinds = new Set([...want].flatMap((k) => DOC_KINDS[k] ?? []))
  return `d.kind IN (${[...kinds].map((k) => `'${k}'`).join(',')})`
}

// One tier: matching visible docs of the wanted kinds, best-first. Snippet
// from the index that matched, so highlights agree with why it matched.
function tierStmt(db, { table, visibility, kindSql }) {
  return db.prepare(`
    SELECT d.id, d.kind, d.ref_id, d.field, d.updated_at, bm25(${table}) AS score,
           snippet(${table}, 0, '**', '**', '…', 16) AS snippet
    FROM ${table} JOIN search_docs d ON d.id = ${table}.rowid
    WHERE ${table} MATCH ? AND d.user_id = ? AND ${kindSql} AND ${visibility}
    ORDER BY score, d.updated_at DESC
    LIMIT ? OFFSET ?`)
}

// A query that is just a tracker number, with or without the leading '#'.
// Tracker numbers are positive and fit a safe integer.
const NUMBER_QUERY = /^#?(\d{1,15})$/

// The `number` tier: the one row of the user's that carries this number.
// Items, missions, milestones and projects share a per-user counter, so at
// most one source table answers. The row is reached through its own
// search_docs doc, so the same per-field visibility as every other tier
// applies. A milestone's primary doc is its text; the others' is the
// title-bearing field.
const NUMBER_SOURCES = [
  { kind: 'item', table: 'items', field: 'text' },
  { kind: 'mission', table: 'missions', field: 'title' },
  { kind: 'milestone', table: 'milestones', field: 'text' },
  { kind: 'project', table: 'projects', field: 'title' },
]
function numberDocs(db, userId, num, { visibility, kindSql }) {
  for (const s of NUMBER_SOURCES) {
    const row = db.prepare(`SELECT id FROM ${s.table} WHERE user_id=? AND num=?`).get(userId, num)
    if (!row) continue
    const doc = db.prepare(`
      SELECT d.id, d.kind, d.ref_id, d.field, d.updated_at, substr(d.body, 1, 200) AS snippet
      FROM search_docs d
      WHERE d.user_id = ? AND d.kind = ? AND d.ref_id = ? AND d.field = ? AND ${kindSql} AND ${visibility}`)
      .get(userId, s.kind, row.id, s.field)
    return doc ? [doc] : []
  }
  return []
}

// Doc → the entity a person is looking for (spec §4), and the entity's own
// display fields. Both run once per matching doc (pool size ≤ 200 at these
// defaults), but their statements are prepared once per searchAll call —
// not once per doc — by building them inside this factory rather than at
// module scope or inline in the hot loop.
function makeLookups(db, { excludePrivateOwned, want }) {
  const milestoneMission = db.prepare('SELECT mission_id FROM milestones WHERE id=?')
  const commentItem = db.prepare('SELECT item_id FROM item_comments WHERE id=?')
  const missionInfo = db.prepare('SELECT num, name, title, state, updated_at FROM missions WHERE id=?')
  // mission_num: as in searchChats (src/search.js), a scalar subquery sieved by
  // ORIGIN_SIEVE when excludePrivateOwned, not a plain LEFT JOIN, so a
  // filtered agent never learns the number of a private-origin mission an
  // otherwise-visible item happens to be filed under.
  const itemInfo = db.prepare(`SELECT i.num, i.title, i.state, i.updated_at,
    (SELECT m.num FROM missions m WHERE m.id = i.mission_id${excludePrivateOwned ? ` AND ${ORIGIN_SIEVE}` : ''}) AS mission_num
    FROM items i WHERE i.id=?`)
  const memoryInfo = db.prepare('SELECT name, description, updated_at FROM memories WHERE id=?')
  const projectInfo = db.prepare('SELECT num, title, state, updated_at FROM projects WHERE id=?')
  // A default project (createMission's same-titled, auto-created twin,
  // default-project.js) rolls up to its mission: exactly one mission points
  // at this project (missions.project_id = p.id), that mission's title
  // equals the project's title, AND that mission shares the project's own origin — the only way
  // they can share an origin is `insertDefaultProject` having copied it,
  // i.e. a TRUE auto-created twin, not a coincidence. The title/count match
  // alone would let a public project roll up to a same-titled mission some
  // OTHER caller had merely filed into it, from a different, possibly
  // private, origin. GROUP BY + HAVING
  // COUNT(*)=1 means the bare `m.title`/`m.origin_*` below are read from
  // that single row whenever the condition can be true at all; when the
  // count isn't 1 the AND is already false, so which arbitrary row SQLite
  // picked for them can't matter.
  const defaultProjectMission = db.prepare(`
    SELECT m.id AS mission_id FROM projects p JOIN missions m ON m.project_id = p.id
    WHERE p.id = ?
    GROUP BY p.id
    HAVING COUNT(*) = 1 AND m.title = p.title
      AND m.origin_convo_id = p.origin_convo_id AND m.origin_device_id = p.origin_device_id`)
  // Belt and braces on top of the origin-match above: when the caller asked
  // to exclude private-owned entities, re-check the rolled-up MISSION's own
  // origin the same way docVisibilitySql checks a mission doc's (`missionOk`,
  // search-docs.js) — a project doc passing PROJECT_ORIGIN_SIEVE says
  // nothing about the mission it would roll up to; they are independent
  // origins. A project-only search (`want` lacks 'mission') never rolls up
  // either: a default project listed on its own must still be findable.
  const missionOriginOk = db.prepare(`SELECT ${missionOk('?')} AS ok`)
  const rollupEnabled = want.has('mission')

  // `own`: report a project as itself even when it is a mission's default
  // twin — the number tier asked for that project's own number.
  function entityKey(doc, { own = false } = {}) {
    if (doc.kind === 'milestone') {
      const m = milestoneMission.get(doc.ref_id)
      return m && { kind: 'mission', id: m.mission_id }
    }
    if (doc.kind === 'comment') {
      const c = commentItem.get(doc.ref_id)
      return c && { kind: 'item', id: c.item_id }
    }
    if (doc.kind === 'project' && rollupEnabled && !own) {
      const d = defaultProjectMission.get(doc.ref_id)
      if (d && (!excludePrivateOwned || missionOriginOk.get(d.mission_id).ok)) {
        return { kind: 'mission', id: d.mission_id }
      }
    }
    return { kind: doc.kind, id: doc.ref_id }
  }

  function describe(key) {
    if (key.kind === 'mission') {
      const m = missionInfo.get(key.id)
      return m && { num: m.num, name: m.name, title: m.title, state: m.state, updated_at: m.updated_at, mission_num: null }
    }
    if (key.kind === 'item') {
      const i = itemInfo.get(key.id)
      return i && { num: i.num, name: null, title: i.title, state: i.state, updated_at: i.updated_at, mission_num: i.mission_num ?? null }
    }
    if (key.kind === 'memory') {
      const me = memoryInfo.get(key.id)
      return me && { num: null, name: me.name, title: me.description, state: null, updated_at: me.updated_at, mission_num: null }
    }
    const p = projectInfo.get(key.id)
    return p && { num: p.num, name: null, title: p.title, state: p.state, updated_at: p.updated_at, mission_num: null }
  }

  return { entityKey, describe }
}

// `searchAll` is async because the similar tier awaits an embedding of the
// query. The lexical tiers need no await of their own.
export async function searchAll(db, userId, { query, limit = 20, kinds = null, excludePrivateOwned = false, excludeConsent = false, similar = null } = {}) {
  const parsed = parseQuery(query)
  if (!parsed) return { badQuery: true }
  const want = new Set(kinds && kinds.length ? kinds : KINDS)
  const visibility = docVisibilitySql(excludePrivateOwned, { excludeConsent })
  const kindSql = docKindSql(want)
  const pool = limit * 4
  const tiers = [
    ['exact', 'docs_fts_plain', parsed.terms.length > 1 ? matchExact(parsed) : null],
    ['words', 'docs_fts_plain', matchAll(parsed)],
    ['stemmed', 'docs_fts', matchAll(parsed)],
  ]
  const { entityKey, describe } = makeLookups(db, { excludePrivateOwned, want })
  const byEntity = new Map() // "kind:id" → result (first = best tier, best score)
  // Returns the entry it just added, or undefined when every doc was
  // skipped (wrong kind, or an entity a stricter tier already found) — so a
  // caller that needs the entry it added (the similar tier, to stamp a
  // score) doesn't have to re-derive it with an O(n) `.at(-1)`.
  const take = (why, docs, opts) => {
    let added
    for (const doc of docs) {
      const key = entityKey(doc, opts)
      if (!key || !want.has(key.kind)) continue
      const k = `${key.kind}:${key.id}`
      if (byEntity.has(k)) continue
      const info = describe(key)
      if (!info) continue
      added = { kind: key.kind, id: key.id, ...info, why, field: doc.kind === key.kind ? doc.field : doc.kind, snippet: doc.snippet ?? null }
      byEntity.set(k, added)
    }
    return added
  }
  // Runs one tier in pages until `limit` entities are known, the tier has
  // no more matches, or MAX_PAGES pages have run. Many docs can roll up to
  // one entity (a mission with dozens of matching milestones), so the first
  // page can hold far fewer than `limit` distinct entities even when more
  // match. Every page re-sorts all of the tier's matches, so pages grow
  // ×4 (pool, 4·pool, 16·pool, …) and are capped: a tier costs at most
  // MAX_PAGES sorts however many docs match, and covers 85·pool docs.
  const runTier = (why, table, match) => {
    const stmt = tierStmt(db, { table, visibility, kindSql })
    let offset = 0
    for (let page = 0, size = pool; page < MAX_PAGES && byEntity.size < limit; page++, size *= 4) {
      const docs = stmt.all(match, userId, size, offset)
      take(why, docs)
      if (docs.length < size) break
      offset += size
    }
  }
  let strictCount
  try {
    // A bare number names one tracker row exactly; it goes first, ahead of
    // every row that merely mentions the number in its text.
    const numbered = String(query).trim().match(NUMBER_QUERY)
    if (numbered) take('number', numberDocs(db, userId, Number(numbered[1]), { visibility, kindSql }), { own: true })
    for (const [why, table, match] of tiers) {
      if (match) runTier(why, table, match)
    }
    // Measured BEFORE similar adds anything: whether some_words runs below
    // depends only on how thin the strict tiers (exact/words/stemmed) are,
    // not on what similar finds in between.
    strictCount = byEntity.size
  } catch (err) {
    console.error('search/all query failed', err)
    return { badQuery: true }
  }
  // Similar tier (spec §5): similar outranks the any-word fallback but
  // stays below every strict word match, because on real data the any-word
  // fallback could otherwise fill the list and push good similar hits out.
  // An embedding pass over `query`, folded into byEntity the
  // same way `take` folds a lexical tier — skip an entity already found by
  // a stricter tier — gated on `similar` being non-null and `parsed.literal`
  // being false (a literal query never gets `similar`).
  // `visibleDoc` reuses the same `visibility` string the lexical tiers used
  // above, so excludeConsent/excludePrivateOwned apply identically to a
  // similar hit. An embedder or vector-store failure (model unload, corrupt
  // index) must not turn a good lexical answer into an error — log it and
  // return the lexical results as they stand.
  // Skipped when the strict tiers already filled `limit`: similar ranks
  // below them, so nothing it found could make the cut.
  if (similar && !parsed.literal && strictCount < limit) {
    try {
      const visibleDoc = db.prepare(`SELECT 1 FROM search_docs d WHERE d.id = ? AND d.user_id = ? AND ${kindSql} AND ${visibility}`)
      const docById = db.prepare('SELECT id, kind, ref_id, field, updated_at, substr(body, 1, 200) AS snippet FROM search_docs WHERE id=?')
      const qv = await similar.embedder.embedQuery(String(query).trim())
      const hits = similar.store.similarDocs(userId, qv, (id) => !!visibleDoc.get(id, userId), pool, { minScore: SIMILAR_MIN })
      const best = hits.length ? hits[0].score : 0
      let added = 0
      for (const h of hits) {
        if (added >= SIMILAR_MAX) break
        if (h.score < SIMILAR_MIN || h.score < best - SIMILAR_MARGIN) break
        const doc = docById.get(h.doc_id)
        const entry = take('similar', [doc])
        if (entry) { added++; entry.score = Number(h.score.toFixed(3)) }
      }
    } catch (err) {
      console.error('search/all similar tier failed', err)
    }
  }
  // some_words (the any-word fallback): only when the strict tiers alone
  // were thin, and never for a literal query. `take` already skips an
  // entity similar just found, so some_words cannot re-add it.
  if (!parsed.literal && strictCount < THIN) {
    try {
      runTier('some_words', 'docs_fts', matchAny(parsed))
    } catch (err) {
      console.error('search/all query failed', err)
      return { badQuery: true }
    }
  }
  return { results: [...byEntity.values()].slice(0, limit) }
}
