import { ORIGIN_SIEVE } from './missions.js'
import { parseQuery } from './search-query.js'
import { yieldTurn } from './background.js'

// Single source of truth for what the search index can see (prose only).
// Called by BOTH the live append path (journal.js, inside the append
// transaction) and the startup backfill, and by the agent context filter in
// http.js — one function, three consumers, zero drift. This copies the app
// side's searchableBody discipline for the same reason the apps needed it.
//
// tool_output is deliberately null: command output is retrieval noise for
// "why did we do this" questions, and it is where credentials land. If a
// new prose-bearing event type is ever added, extend HERE and nowhere else.
export function indexableBody(type, payload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  // Old-client fallback (spec: "Old-client fallback"): a flagged mirror of
  // an item marker that new clients hide — a hit here would surface a row
  // that half the fleet never sees.
  if (p.fallback_for) return null
  if (type === 'text') {
    const body = typeof p.body === 'string' ? p.body : ''
    return body.trim() ? body : null
  }
  if (type === 'diff') {
    const text = typeof p.diff === 'string' && p.diff
      ? p.diff
      : (typeof p.snippet === 'string' ? p.snippet : '')
    return text.trim() ? text : null
  }
  return null
}

// Shared by every FTS5 MATCH string this file builds from human input:
// double-quote the term (FTS5 escapes an embedded " by doubling it) so raw
// MATCH syntax a person might type (an unbalanced quote, a bare *, a stray
// NEAR) is always literal, never parsed.
function quoteFtsTerm(t) { return `"${t.replace(/"/g, '""')}"` }

// Human input → FTS5 MATCH string. Every whitespace-separated term is
// quoted (see quoteFtsTerm), giving an implicit AND over literal terms.
// Returns null for input with no terms; the route maps that to 400.
export function ftsQueryFor(raw) {
  const terms = String(raw).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return null
  return terms.map(quoteFtsTerm).join(' ')
}

// The ranked search's "fewer than 5 hits" fallback (spec 2026-10-12 unified
// search): any term present, not every term. Same quoting as
// ftsQueryFor, OR-joined instead of AND-joined. Only meaningful for 2+
// terms — a single-term query's some_words tier would be identical to its
// words tier — so returns null below that, same null-means-skip contract.
export function ftsAnyQueryFor(raw) {
  const terms = String(raw).split(/\s+/).filter(Boolean)
  if (terms.length < 2) return null
  return terms.map(quoteFtsTerm).join(' OR ')
}

// Adjacent-phrase match (see searchMessages). Capped so a pasted paragraph
// is not run as a phrase.
const MAX_PHRASE_TERMS = 8
export function ftsPhraseQueryFor(raw) {
  const terms = String(raw).split(/\s+/).filter(Boolean)
  return terms.length < 2 ? null : quoteFtsTerm(terms.join(' '))
}

// WHERE/SELECT builder shared by searchMessages's main (all-words) query and
// its some_words fallback below — the only difference between the two is
// the MATCH string and an extra "already have these seqs" exclusion, so
// they are built from one template rather than two copies of the privacy
// and subagent predicates drifting apart.
// excludePrivateOwned (spec: agent visibility & privacy): hits from
// conversations owned by a private device vanish for ordinary agent
// callers. NULL-owner (legacy) conversations are never private-owned.
// mission_num (spec 2026-10-12 unified search): same sieved scalar subquery searchChats
// already uses — never a plain LEFT JOIN — so a filtered agent caller
// never learns a private-origin mission's number even for an otherwise
// visible hit.
function rankedSql({ convoId, excludeSubagents, excludePrivateOwned, excludeSeqsCount = 0, proseOnly = false }) {
  return `
    SELECT sm.convo_id, c.title, sm.seq, sm.ts, sm.sender, c.session_state,
           snippet(search_fts, 0, '**', '**', '…', 12) AS snippet,
           (SELECT m.num FROM missions m WHERE m.id = c.mission_id${excludePrivateOwned ? ` AND ${ORIGIN_SIEVE}` : ''}) AS mission_num
    FROM search_fts
    JOIN search_messages sm ON sm.rowid = search_fts.rowid
    JOIN conversations c ON c.id = sm.convo_id
    WHERE search_fts MATCH ? AND sm.user_id = ?${convoId != null ? ' AND sm.convo_id = ?' : ''}
    ${excludeSubagents ? 'AND c.parent_convo_id IS NULL' : ''}
    ${proseOnly ? 'AND sm.is_diff = 0' : ''}
    ${excludePrivateOwned
      ? `AND (c.agent_device_id IS NULL OR NOT EXISTS(
            SELECT 1 FROM private_devices d WHERE d.id=c.agent_device_id))`
      : ''}
    ${excludeSeqsCount ? `AND sm.seq NOT IN (${Array(excludeSeqsCount).fill('?').join(',')})` : ''}
    ORDER BY sm.is_diff, bm25(search_fts), sm.ts DESC
    LIMIT ?`
}

// Ranked, user-scoped search (spec: GET /search). bm25() ascending is
// best-first; ts DESC breaks ties toward recency; sm.is_diff first puts a
// diff hit below prose matching the same terms (spec 2026-10-12 unified
// search) — a code change is rarely what "why did we do this"
// means. `live` is derived from the conversation's session_state so the
// caller can prefer talking to a working agent over reading its
// transcript. The try/catch is belt-and-braces: after quoting, a parse
// failure should be unreachable, but a SQLite error must surface as
// badQuery (→ 400), never a 500 with internals in it.
//
// some_words fallback: fewer than 5 all-words (`why: 'words'`)
// hits, and the query has 2+ terms — any one term, excluding the seqs
// already returned, up to the remaining limit, tagged `why: 'some_words'`.
// Inherits the exact same privacy/subagent filters via rankedSql, so the
// fallback can never surface something the main query would have hidden.
//
// Literal queries never get it: `parseQuery`
// (src/search-query.js) is the one literal rule every tier of /search/all
// already shares — quoted, carries a digit, id-like, or a single word —
// reused here rather than re-implemented, because a person who quoted
// their query or typed an id wanted an exact match, not loose noise.
export function searchMessages(db, userId, { query, limit = 20, convoId = null, excludePrivateOwned = false, excludeSubagents = false } = {}) {
  const match = ftsQueryFor(query)
  if (match == null) return { badQuery: true }
  const toHit = (r, why) => ({
    convo_id: r.convo_id, title: r.title, seq: r.seq, ts: r.ts, sender: r.sender,
    snippet: r.snippet, live: r.session_state === 'running', mission_num: r.mission_num ?? null, why,
  })
  const hits = []
  // One tier: run `matchStr` for up to the remaining `limit`, skipping seqs
  // an earlier tier already returned. Every tier shares rankedSql, so the
  // privacy and subagent filters cannot drift between them.
  const runTier = (matchStr, why, { proseOnly = false } = {}) => {
    const remaining = limit - hits.length
    if (remaining <= 0) return
    const excludeSeqs = hits.map((h) => h.seq)
    const sql = rankedSql({ convoId, excludeSubagents, excludePrivateOwned, excludeSeqsCount: excludeSeqs.length, proseOnly })
    const args = [matchStr, userId, ...(convoId != null ? [convoId] : []), ...excludeSeqs, remaining]
    hits.push(...db.prepare(sql).all(...args).map((r) => toHit(r, why)))
  }
  const parsed = parseQuery(query)
  const termCount = String(query).split(/\s+/).filter(Boolean).length
  try {
    // Phrase tier (2+ terms): a message holding the terms adjacent and in
    // order ranks above one that merely contains every term somewhere: a
    // person recalling what was said types a fragment of it. Prose only, so
    // a diff never jumps above prose matching the same terms.
    if (termCount >= 2 && termCount <= MAX_PHRASE_TERMS) {
      runTier(ftsPhraseQueryFor(query), 'phrase', { proseOnly: true })
    }
    runTier(match, 'words')
  } catch (err) {
    console.error('search query failed', err)
    return { badQuery: true }
  }
  const orMatch = parsed && !parsed.literal ? ftsAnyQueryFor(query) : null
  if (hits.length < 5 && orMatch != null) {
    try {
      runTier(orMatch, 'some_words')
    } catch (err) {
      console.error('search (some_words) query failed', err)
    }
  }
  return { hits }
}

// ---------------------------------------------------------------------------
// Typed matching — the apps' search (matron-apple PR 303 brought the same
// rule to the device index; this is its server twin, so iPhone, Mac and the
// journal agree on what a query means).
//
// A message matches when it contains EVERY typed word, as typed. Only the
// word still being typed (the text does not end in whitespace) also matches
// as the start of a longer word, so results don't blink out mid-word. Both
// halves need an unstemmed index, which is what `search_fts_plain` is
// (db.js): on the porter mirror "run" finds "running", and a prefix
// "runn"* finds nothing because the stored token is "run".
export function typedQuery(raw) {
  const text = String(raw)
  const words = text.split(/\s+/).filter(Boolean)
  const terms = words.filter((w) => /[\p{L}\p{N}]/u.test(w))
  if (terms.length === 0) return null
  const lastIsPrefix = !/\s$/.test(text) && words[words.length - 1] === terms[terms.length - 1]
  const quote = (t) => `"${t.replace(/"/g, '""')}"`
  const matchParts = terms.map(quote)
  if (lastIsPrefix) matchParts[matchParts.length - 1] += '*'
  return {
    terms,
    lastIsPrefix,
    allTermsMatch: matchParts.join(' '),
    exactMatch: quote(terms.join(' ')),
    // The exact tier can only differ from the all-terms tier for a phrase
    // or a word still being typed.
    hasDistinctExactTier: terms.length > 1 || lastIsPrefix,
  }
}

// WHERE fragment + arguments shared by the typed modes: FTS match, user
// scope, optional conversation / subagent / privacy filters.
function typedWhere({ match, userId, convoId, excludeSubagents, excludePrivateOwned }) {
  const clauses = ['search_fts_plain MATCH ?', 'sm.user_id = ?']
  const args = [match, userId]
  if (convoId != null) { clauses.push('sm.convo_id = ?'); args.push(convoId) }
  if (excludeSubagents) clauses.push('c.parent_convo_id IS NULL')
  if (excludePrivateOwned) {
    clauses.push(`(c.agent_device_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM private_devices d WHERE d.id=c.agent_device_id))`)
  }
  return { sql: clauses.join(' AND '), args }
}

// Flat hits newest first under the typed rule — find-in-chat's match list
// (the apps step through it by seq), also usable across conversations.
// No body or snippet: the caller already shows the message. mission_num
// (spec 2026-10-12 unified search): same sieved scalar subquery
// searchChats and searchMessages use — see the mission_num comment on
// rankedSql above for why a plain LEFT JOIN is wrong here.
export function searchRecent(db, userId, { query, limit = 50, convoId = null, excludeSubagents = false, excludePrivateOwned = false } = {}) {
  const typed = typedQuery(query)
  if (typed == null) return { badQuery: true }
  const where = typedWhere({ match: typed.allTermsMatch, userId, convoId, excludeSubagents, excludePrivateOwned })
  let rows
  try {
    rows = db.prepare(`
      SELECT sm.convo_id, sm.seq, sm.ts, sm.sender,
             (SELECT m.num FROM missions m WHERE m.id = c.mission_id${excludePrivateOwned ? ` AND ${ORIGIN_SIEVE}` : ''}) AS mission_num
      FROM search_fts_plain
      JOIN search_messages sm ON sm.rowid = search_fts_plain.rowid
      JOIN conversations c ON c.id = sm.convo_id
      WHERE ${where.sql}
      ORDER BY sm.seq DESC
      LIMIT ?`).all(...where.args, limit)
  } catch (err) {
    console.error('search (recent) query failed', err)
    return { badQuery: true }
  }
  return { hits: rows.map((r) => ({ convo_id: r.convo_id, seq: r.seq, ts: r.ts, sender: r.sender, mission_num: r.mission_num ?? null })) }
}

// One row per conversation under the typed rule: how many messages match,
// and the message the row should preview. Conversations holding the query
// as an exact phrase come first, then those containing every word; newest
// first within each (sorting only by newest put a note from a minute ago
// above the exact phrase from three days earlier).
//
// "Newest" is the highest seq (the user's append order, strictly
// increasing — two messages can share a ts). The bare `sm.rowid` next to
// MAX(sm.seq) rides SQLite's documented single-MAX rule: with exactly one
// MAX() aggregate, bare columns take their values from the row that
// supplied the maximum.
// How many of the newest matching messages searchChats groups (see there).
export const CHAT_SCAN_CAP = 2000

export function searchChats(db, userId, { query, limit = 20, excludeSubagents = false, excludePrivateOwned = false } = {}) {
  const typed = typedQuery(query)
  if (typed == null) return { badQuery: true }
  const groups = (match, convoIds, n) => {
    const where = typedWhere({ match, userId, excludeSubagents, excludePrivateOwned })
    let scope = ''
    if (convoIds) {
      scope = ` AND sm.convo_id IN (${convoIds.map(() => '?').join(',')})`
      where.args.push(...convoIds)
    }
    // Grouped over the newest CHAT_SCAN_CAP matching messages only. A
    // common word ("the", "a", a name) matches a large share of the whole
    // journal, and counting every one of those took seconds; walking the
    // index newest first and stopping at the cap keeps every query fast.
    return db.prepare(`
      SELECT convo_id, COUNT(*) AS hit_count, MAX(seq) AS newest_seq, rowid AS newest_rowid
      FROM (
        SELECT sm.convo_id, sm.seq, sm.rowid
        FROM search_fts_plain
        JOIN search_messages sm ON sm.rowid = search_fts_plain.rowid
        JOIN conversations c ON c.id = sm.convo_id
        WHERE ${where.sql}${scope}
        ORDER BY search_fts_plain.rowid DESC
        LIMIT ?)
      GROUP BY convo_id
      ORDER BY newest_seq DESC
      LIMIT ?`).all(...where.args, CHAT_SCAN_CAP, n)
  }
  let exact = []
  let all
  try {
    if (typed.hasDistinctExactTier) exact = groups(typed.exactMatch, null, limit)
    all = groups(typed.allTermsMatch, null, limit)
    // An exact conversation older than the newest `limit` all-terms ones
    // still needs its total: every exact match is an all-terms match, so
    // the count comes from the same query, scoped.
    const listed = new Set(all.map((g) => g.convo_id))
    const unlisted = exact.map((g) => g.convo_id).filter((id) => !listed.has(id))
    if (unlisted.length) all = all.concat(groups(typed.allTermsMatch, unlisted, unlisted.length))
  } catch (err) {
    console.error('search (chats) query failed', err)
    return { badQuery: true }
  }
  const counts = new Map(all.map((g) => [g.convo_id, g.hit_count]))
  const exactIds = new Set(exact.map((g) => g.convo_id))
  const ranked = exact.map((g) => ({ g, exact: true }))
    .concat(all.filter((g) => !exactIds.has(g.convo_id)).map((g) => ({ g, exact: false })))
    .slice(0, limit)
  if (ranked.length === 0) return { chats: [] }
  // Bodies and names for just the winning rows; the preview is cut from
  // the excerpt by the app, so nothing is computed for matches not shown.
  const rowids = ranked.map(({ g }) => g.newest_rowid)
  // mission_num (spec 2026-10-12 unified search):
  // the conversation's CURRENT mission pointer (conversations.mission_id —
  // the same column joinMission/createMission maintain, missions.js),
  // resolved to the mission's own `num`. A scalar subquery, not a plain LEFT JOIN — exactly the shape GET
  // /conversations uses (src/http.js) — so a filtered (ordinary agent)
  // caller never learns a private-origin mission's number even when the
  // conversation carrying it is itself visible. ORIGIN_SIEVE's own
  // aliases (cv, d) are local to this subquery and don't clash with sm/c/p.
  const detail = new Map(db.prepare(`
    SELECT sm.rowid, sm.seq, sm.ts, sm.sender, sm.body,
           c.title, c.session_state, c.parent_convo_id, p.title AS parent_title,
           (SELECT m.num FROM missions m WHERE m.id = c.mission_id${excludePrivateOwned ? ` AND ${ORIGIN_SIEVE}` : ''}) AS mission_num
    FROM search_messages sm
    JOIN conversations c ON c.id = sm.convo_id
    LEFT JOIN conversations p ON p.id = c.parent_convo_id
    WHERE sm.rowid IN (${rowids.map(() => '?').join(',')})`).all(...rowids).map((r) => [r.rowid, r]))
  return {
    chats: ranked.flatMap(({ g, exact: isExact }) => {
      const d = detail.get(g.newest_rowid)
      if (!d) return []
      return [{
        convo_id: g.convo_id, title: d.title, parent_convo_id: d.parent_convo_id, parent_title: d.parent_title,
        mission_num: d.mission_num ?? null,
        count: counts.get(g.convo_id) ?? g.hit_count, exact: isExact, live: d.session_state === 'running',
        top: { seq: d.seq, ts: d.ts, sender: d.sender, excerpt: excerpt(d.body, typed) },
      }]
    }),
  }
}

// Up to ~1 KB of the body around the first place the query appears (the
// phrase if it is there, else the earliest word), so the app can cut and
// highlight its preview without the whole message crossing the wire. The
// tokenizer folds diacritics and punctuation that this plain text search
// does not, so a match may show no literal occurrence; the head of the
// body is sent then.
export const EXCERPT_BEFORE = 200
export const EXCERPT_LENGTH = 1000
export function excerpt(body, typed) {
  const lower = body.toLowerCase()
  const candidates = [typed.terms.join(' '), ...typed.terms].map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0)
  const anchor = candidates.length ? (lower.indexOf(typed.terms.join(' ').toLowerCase()) >= 0 ? candidates[0] : Math.min(...candidates)) : 0
  const start = Math.max(0, anchor - EXCERPT_BEFORE)
  const end = Math.min(body.length, start + EXCERPT_LENGTH)
  return (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '')
}

// Startup backfill (spec: agent journal search, "Backfill"). Walks `events`
// by rowid in batches, indexing every row indexableBody accepts. Three
// safety properties, each load-bearing:
//   - INSERT OR IGNORE on UNIQUE(user_id, seq) — never OR REPLACE (the
//     external-content corruption trap, matron-apple #106) — so overlap
//     with the live append path or a re-run is a no-op, not a duplicate.
//   - The cursor row (search_backfill_state) advances per committed batch,
//     so an interrupted run resumes where it stopped and a completed one
//     costs a single row read at next boot. Rows appended after the schema
//     exists are indexed live by append(), so the cursor can never miss.
//   - One batch per event-loop turn (the await below): better-sqlite3 is
//     synchronous, and a multi-GB history must not starve the server's
//     sockets while it indexes. Search returns partial results until the
//     walk finishes — acceptable and self-healing (spec).
export async function backfillSearchIndex(db, { batchSize = 1000, log = () => {}, shouldStop = () => false, pause = yieldTurn } = {}) {
  const state = db.prepare('SELECT last_events_rowid FROM search_backfill_state WHERE id=1').get()
  let cursor = state ? state.last_events_rowid : 0
  if (cursor > 0) log(`search backfill: resuming after events rowid ${cursor}`)
  const saveCursor = db.prepare(
    'INSERT INTO search_backfill_state(id, last_events_rowid) VALUES(1, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET last_events_rowid=excluded.last_events_rowid'
  )
  // Batch rowids are selected index-only first (no payload column touched):
  // most history is tool_output, which indexableBody always rejects, so
  // reading and JSON.parse-ing its payload is pure waste at backfill scale.
  // The second query re-fetches only the rows whose type can ever index.
  const selectBatchIds = db.prepare(
    'SELECT rowid FROM events WHERE rowid>? ORDER BY rowid LIMIT ?'
  )
  const selectIndexable = db.prepare(
    `SELECT rowid, user_id, convo_id, seq, ts, sender, type, payload FROM events
     WHERE rowid>? AND rowid<=? AND type IN ('text','diff') ORDER BY rowid`
  )
  const insert = db.prepare(
    'INSERT OR IGNORE INTO search_messages(user_id, convo_id, seq, ts, sender, body, is_diff) VALUES(?,?,?,?,?,?,?)'
  )
  let scanned = 0
  let indexed = 0
  for (;;) {
    if (shouldStop()) break
    const ids = selectBatchIds.all(cursor, batchSize)
    if (ids.length === 0) break
    const floor = cursor
    const ceiling = ids[ids.length - 1].rowid
    db.transaction(() => {
      const rows = selectIndexable.all(floor, ceiling)
      for (const row of rows) {
        let payload
        try { payload = JSON.parse(row.payload) } catch { payload = null }
        const body = indexableBody(row.type, payload)
        if (body != null) indexed += insert.run(row.user_id, row.convo_id, row.seq, row.ts, row.sender, body, row.type === 'diff' ? 1 : 0).changes
      }
      cursor = ceiling
      saveCursor.run(cursor)
    })()
    scanned += ids.length
    log(`search backfill: scanned ${scanned} events, indexed ${indexed}`)
    await pause()
  }
  log(`search backfill complete: scanned ${scanned}, indexed ${indexed}`)
  return { scanned, indexed }
}

// is_diff backfill (spec 2026-10-12 unified search). search_messages
// carries no `type`, so fixing up is_diff for rows written before the
// column existed means re-walking `events` for 'diff' rows and flipping
// their matching search_messages row — same shape as backfillSearchIndex
// (batches of events rowids, cursor saved per committed batch, one batch
// per event-loop turn, stoppable for a clean close), but UPDATE-only: it
// never inserts, so a search_messages row missing because indexableBody
// rejected the event (or the live/backfill index hasn't reached it yet)
// is correctly left alone — it will get is_diff right the moment it is
// indexed, live or by backfillSearchIndex.
//
// user_id+seq is the correct key, not a guess: events' PRIMARY KEY is
// (user_id, seq), user_seq.seq is the per-user monotonic counter append()
// draws from (nextSeq), and search_messages has UNIQUE(user_id, seq) — seq
// is unique per user, so this can never touch two rows.
//
// Cursor seeding (openDb, db.js): a fresh database's cursor starts at the
// current max events rowid, so this walk has nothing to scan and every
// run after is a single cheap SELECT with zero rows — the live path
// (journal.js append()) already sets is_diff correctly for every row a
// fresh database will ever see.
export async function backfillIsDiff(db, { batchSize = 1000, log = () => {}, shouldStop = () => false, pause = yieldTurn } = {}) {
  const state = db.prepare('SELECT last_rowid FROM search_isdiff_state WHERE id=1').get()
  let cursor = state ? state.last_rowid : 0
  if (cursor > 0) log(`search is_diff backfill: resuming after events rowid ${cursor}`)
  const saveCursor = db.prepare(
    'INSERT INTO search_isdiff_state(id, last_rowid) VALUES(1, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET last_rowid=excluded.last_rowid'
  )
  const selectBatchIds = db.prepare(
    'SELECT rowid FROM events WHERE rowid>? ORDER BY rowid LIMIT ?'
  )
  const selectDiffs = db.prepare(
    `SELECT user_id, seq FROM events WHERE rowid>? AND rowid<=? AND type='diff' ORDER BY rowid`
  )
  const update = db.prepare('UPDATE search_messages SET is_diff=1 WHERE user_id=? AND seq=?')
  let scanned = 0
  let updated = 0
  for (;;) {
    if (shouldStop()) break
    const ids = selectBatchIds.all(cursor, batchSize)
    if (ids.length === 0) break
    const floor = cursor
    const ceiling = ids[ids.length - 1].rowid
    db.transaction(() => {
      const rows = selectDiffs.all(floor, ceiling)
      for (const row of rows) updated += update.run(row.user_id, row.seq).changes
      cursor = ceiling
      saveCursor.run(cursor)
    })()
    scanned += ids.length
    log(`search is_diff backfill: scanned ${scanned} events, updated ${updated}`)
    await pause()
  }
  log(`search is_diff backfill complete: scanned ${scanned}, updated ${updated}`)
  return { scanned, updated }
}
