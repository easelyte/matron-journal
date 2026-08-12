// Single source of truth for what the search index can see (spec: prose
// only — docs/superpowers/specs/2026-08-07-agent-journal-search-design.md).
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

// Human input → FTS5 MATCH string. Raw MATCH syntax throws on things people
// actually type (an unbalanced quote, a bare *, a stray NEAR) — so every
// whitespace-separated term is double-quoted (FTS5 escapes an embedded " by
// doubling it), giving an implicit AND over literal terms. Returns null for
// input with no terms; the route maps that to 400.
export function ftsQueryFor(raw) {
  const terms = String(raw).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return null
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ')
}

// Ranked, user-scoped search (spec: GET /search). bm25() ascending is
// best-first; ts DESC breaks ties toward recency. `live` is derived from the
// conversation's session_state so the caller can prefer talking to a working
// agent over reading its transcript. The try/catch is belt-and-braces: after
// quoting, a parse failure should be unreachable, but a SQLite error must
// surface as badQuery (→ 400), never a 500 with internals in it.
// excludePrivateOwned (spec: agent visibility & privacy): hits from
// conversations owned by a private device vanish for ordinary agent
// callers. NULL-owner (legacy) conversations are never private-owned.
export function searchMessages(db, userId, { query, limit = 20, convoId = null, excludePrivateOwned = false } = {}) {
  const match = ftsQueryFor(query)
  if (match == null) return { badQuery: true }
  const sql = `
    SELECT sm.convo_id, c.title, sm.seq, sm.ts, sm.sender, c.session_state,
           snippet(search_fts, 0, '**', '**', '…', 12) AS snippet
    FROM search_fts
    JOIN search_messages sm ON sm.rowid = search_fts.rowid
    JOIN conversations c ON c.id = sm.convo_id
    WHERE search_fts MATCH ? AND sm.user_id = ?${convoId != null ? ' AND sm.convo_id = ?' : ''}
    ${excludePrivateOwned
      ? `AND (c.agent_device_id IS NULL OR NOT EXISTS(
            SELECT 1 FROM devices d WHERE d.id=c.agent_device_id AND d.private=1))`
      : ''}
    ORDER BY bm25(search_fts), sm.ts DESC
    LIMIT ?`
  let rows
  try {
    rows = convoId != null
      ? db.prepare(sql).all(match, userId, convoId, limit)
      : db.prepare(sql).all(match, userId, limit)
  } catch (err) {
    console.error('search query failed', err)
    return { badQuery: true }
  }
  return {
    hits: rows.map((r) => ({
      convo_id: r.convo_id, title: r.title, seq: r.seq, ts: r.ts, sender: r.sender,
      snippet: r.snippet, live: r.session_state === 'running',
    })),
  }
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
export async function backfillSearchIndex(db, { batchSize = 1000, log = () => {}, shouldStop = () => false } = {}) {
  const state = db.prepare('SELECT last_events_rowid FROM search_backfill_state WHERE id=1').get()
  let cursor = state ? state.last_events_rowid : 0
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
    'INSERT OR IGNORE INTO search_messages(user_id, convo_id, seq, ts, sender, body) VALUES(?,?,?,?,?,?)'
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
        if (body != null) indexed += insert.run(row.user_id, row.convo_id, row.seq, row.ts, row.sender, body).changes
      }
      cursor = ceiling
      saveCursor.run(cursor)
    })()
    scanned += ids.length
    log(`search backfill: scanned ${scanned} events, indexed ${indexed}`)
    await new Promise((r) => setImmediate(r))
  }
  log(`search backfill complete: scanned ${scanned}, indexed ${indexed}`)
  return { scanned, indexed }
}
