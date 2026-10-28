// Tracker search documents (spec 2026-10-12 unified search §1). One row per
// searchable FIELD — each field keeps its own visibility rule (a mission's
// status can be private while its title is not). Tracker rows are mutable,
// so unlike search_messages these are kept in sync by INSERT/UPDATE/DELETE
// triggers on the source tables, and the FTS mirrors use the standard
// external-content three-trigger pattern ('delete' command, never REPLACE).
import { ORIGIN_SIEVE, statusPrivateSql } from './missions.js'
import { PROJECT_ORIGIN_SIEVE } from './projects.js'
import { privateConvoSql } from './sieve-sql.js'

// Tables whose source rows carry only created_at (no updated_at): milestones
// are never edited after posting, and item_comments likewise. Every other
// source table (missions, items, memories, projects) has updated_at.
const CREATED_AT_ONLY = new Set(['item_comments', 'milestones'])
const tsCol = (table) => (CREATED_AT_ONLY.has(table) ? 'created_at' : 'updated_at')

// kind, ref table, field, body expression over NEW (or the table alias).
const SOURCES = [
  { kind: 'mission', table: 'missions', field: 'title',
    body: (r) => `trim(coalesce(${r}.name,'') || ' ' || ${r}.title || ' ' || ${r}.body)`, when: () => '1' },
  { kind: 'mission', table: 'missions', field: 'status', body: (r) => `${r}.status`, when: (r) => `coalesce(${r}.status,'') <> ''` },
  { kind: 'mission', table: 'missions', field: 'summary', body: (r) => `${r}.close_summary`, when: (r) => `coalesce(${r}.close_summary,'') <> ''` },
  { kind: 'milestone', table: 'milestones', field: 'text', body: (r) => `trim(${r}.title || ' ' || ${r}.body)`, when: () => '1' },
  { kind: 'item', table: 'items', field: 'text',
    body: (r) => `trim(${r}.title || ' ' || ${r}.body || ' ' || (SELECT coalesce(group_concat(value,' '),'') FROM json_each(${r}.labels)))`, when: () => '1' },
  // A reply the user withdrew (src/withdrawn-comments.js) is not searchable.
  { kind: 'comment', table: 'item_comments', field: 'text', body: (r) => `${r}.body`,
    when: (r) => `${r}.kind = 'comment' AND trim(${r}.body) <> '' AND ${r}.withdrawn_at IS NULL`, recreate: true },
  { kind: 'memory', table: 'memories', field: 'text', body: (r) => `trim(${r}.name || ' ' || ${r}.description || ' ' || ${r}.body)`, when: () => '1' },
  { kind: 'project', table: 'projects', field: 'title', body: (r) => `trim(${r}.title || ' ' || ${r}.body)`, when: () => '1' },
  { kind: 'project', table: 'projects', field: 'status', body: (r) => `${r}.status`, when: (r) => `coalesce(${r}.status,'') <> ''` },
  { kind: 'project', table: 'projects', field: 'summary', body: (r) => `${r}.close_summary`, when: (r) => `coalesce(${r}.close_summary,'') <> ''` },
]

const SCHEMA = `
CREATE TABLE IF NOT EXISTS search_docs(
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  ref_id     TEXT NOT NULL,
  field      TEXT NOT NULL,
  body       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(kind, ref_id, field)
);
CREATE INDEX IF NOT EXISTS idx_search_docs_user ON search_docs(user_id, kind);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(body, content='search_docs', content_rowid='id', tokenize='porter unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts_plain USING fts5(body, content='search_docs', content_rowid='id', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS search_docs_ai AFTER INSERT ON search_docs BEGIN
  INSERT INTO docs_fts(rowid, body) VALUES (new.id, new.body);
  INSERT INTO docs_fts_plain(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS search_docs_ad AFTER DELETE ON search_docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, body) VALUES('delete', old.id, old.body);
  INSERT INTO docs_fts_plain(docs_fts_plain, rowid, body) VALUES('delete', old.id, old.body);
END;
CREATE TRIGGER IF NOT EXISTS search_docs_au AFTER UPDATE OF body ON search_docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, body) VALUES('delete', old.id, old.body);
  INSERT INTO docs_fts_plain(docs_fts_plain, rowid, body) VALUES('delete', old.id, old.body);
  INSERT INTO docs_fts(rowid, body) VALUES (new.id, new.body);
  INSERT INTO docs_fts_plain(rowid, body) VALUES (new.id, new.body);
END;
CREATE TABLE IF NOT EXISTS search_docs_state(id INTEGER PRIMARY KEY CHECK(id=1), backfilled INTEGER NOT NULL);
`

// Upsert without REPLACE: the UNIQUE conflict path does an UPDATE, which
// fires search_docs_au (delete old FTS row, insert new). A field that
// became empty is deleted instead.
function upsertSql(s, r) {
  const ts = `${r}.${tsCol(s.table)}`
  return `
    INSERT INTO search_docs(user_id, kind, ref_id, field, body, updated_at)
      SELECT ${r}.user_id, '${s.kind}', ${r}.id, '${s.field}', ${s.body(r)}, ${ts} WHERE ${s.when(r)}
      ON CONFLICT(kind, ref_id, field) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at
      WHERE search_docs.body IS NOT excluded.body;
    DELETE FROM search_docs WHERE kind='${s.kind}' AND ref_id=${r}.id AND field='${s.field}' AND NOT (${s.when(r)});`
}

// A source whose rule changed carries `recreate`: its triggers are dropped
// and made again at every start, since CREATE TRIGGER IF NOT EXISTS
// would keep the old rule on an existing database.
function triggersFor(s) {
  const name = `sd_${s.table}_${s.field}`
  const drop = s.recreate ? `
DROP TRIGGER IF EXISTS ${name}_ai;
DROP TRIGGER IF EXISTS ${name}_au;
DROP TRIGGER IF EXISTS ${name}_ad;` : ''
  return `${drop}
CREATE TRIGGER IF NOT EXISTS ${name}_ai AFTER INSERT ON ${s.table} BEGIN ${upsertSql(s, 'new')} END;
CREATE TRIGGER IF NOT EXISTS ${name}_au AFTER UPDATE ON ${s.table} BEGIN ${upsertSql(s, 'new')} END;
CREATE TRIGGER IF NOT EXISTS ${name}_ad AFTER DELETE ON ${s.table} BEGIN
  DELETE FROM search_docs WHERE kind='${s.kind}' AND ref_id=old.id AND field='${s.field}';
END;`
}

// Per-field visibility predicate over search_docs alias `d` (spec
// 2026-10-12 unified search §2): search never decides visibility itself —
// each kind/field reuses the exact predicate its own read route applies.
// `excludePrivateOwned` means "an ORDINARY agent caller" — the same
// one-flag rule every other route uses (missions-http.js, items-http.js,
// memories-http.js, projects-http.js all key it off `filteredAgent(db,
// who)`, and the existing /search route for messages does the same: "never
// to clients or private agents", src/http.js). Owners and private agents
// get the private-owned sieve skipped — matching that precedent.
//
// `excludeConsent` is the ORTHOGONAL items-http.js rule: a consent-mirror item (and its comments) is hidden from
// EVERY agent, private ones included (`who.kind === 'agent' &&
// isConsentMirror(...)`, src/items-http.js visibleItem) — unlike
// excludePrivateOwned, which never applies to a private agent. Checking
// consent only alongside excludePrivateOwned would let a private agent
// find consent-mirror text its own /items read would 404 for. Whichever route calls this MUST pass
// `excludeConsent: true` for every agent caller (ordinary and private
// alike), mirroring items-http.js's `excludeConsent: who.kind==='agent'` —
// not just the ordinary ones excludePrivateOwned covers.
// Exported so search-all.js's default-project roll-up can re-check a rolled-up mission's own origin instead of copying this SQL:
// the project doc's visibility (PROJECT_ORIGIN_SIEVE) says nothing about
// whether the MISSION it rolls up to is itself private-owned.
export const missionOk = (idExpr) => `EXISTS (SELECT 1 FROM missions m WHERE m.id = ${idExpr} AND ${ORIGIN_SIEVE})`
// Matches listItems' excludePrivateOwned (origin convo not private-owned)
// and excludeConsent (i.consent IS NULL): each condition is added only when
// its own flag asks for it, so a caller that wants one without the other
// (e.g. a private agent: excludeConsent true, excludePrivateOwned false)
// gets exactly that.
function itemOk(idExpr, excludePrivateOwned, excludeConsent) {
  const conds = [`i.id = ${idExpr}`]
  if (excludeConsent) conds.push('i.consent IS NULL')
  if (excludePrivateOwned) conds.push(`NOT ${privateConvoSql('i.origin_convo_id')}`)
  return `EXISTS (SELECT 1 FROM items i WHERE ${conds.join(' AND ')})`
}

export function docVisibilitySql(excludePrivateOwned, { excludeConsent = false } = {}) {
  if (!excludePrivateOwned && !excludeConsent) return '1'
  const itemVisible = itemOk('d.ref_id', excludePrivateOwned, excludeConsent)
  const commentVisible = `EXISTS (SELECT 1 FROM item_comments ic WHERE ic.id = d.ref_id
    AND ${itemOk('ic.item_id', excludePrivateOwned, excludeConsent)})`
  // excludeConsent alone (a private agent): only item/comment docs are
  // filtered at all; every other kind is unaffected by excludePrivateOwned
  // being false, so it stays visible.
  if (!excludePrivateOwned) {
    return `(CASE d.kind WHEN 'item' THEN ${itemVisible} WHEN 'comment' THEN ${commentVisible} ELSE 1 END)`
  }
  return `(CASE d.kind
    WHEN 'mission' THEN ${missionOk('d.ref_id')} AND (
      d.field <> 'status'
      OR NOT EXISTS (SELECT 1 FROM missions m WHERE m.id = d.ref_id AND ${statusPrivateSql('m')}))
    WHEN 'milestone' THEN EXISTS (SELECT 1 FROM milestones l WHERE l.id = d.ref_id
      AND ${missionOk('l.mission_id')} AND NOT ${privateConvoSql('l.convo_id')})
    WHEN 'item' THEN ${itemVisible}
    WHEN 'comment' THEN ${commentVisible}
    WHEN 'memory' THEN EXISTS (SELECT 1 FROM memories me WHERE me.id = d.ref_id AND me.origin_private = 0)
    WHEN 'project' THEN EXISTS (SELECT 1 FROM projects p WHERE p.id = d.ref_id AND ${PROJECT_ORIGIN_SIEVE}
      AND (d.field <> 'status' OR NOT ${statusPrivateSql('p')}))
    ELSE 0 END)`
}

export function installSearchDocs(db) {
  db.exec(SCHEMA)
  for (const s of SOURCES) db.exec(triggersFor(s))
  if (db.prepare('SELECT 1 FROM search_docs_state WHERE id=1').get()) return
  db.transaction(() => {
    for (const s of SOURCES) {
      const ts = `t.${tsCol(s.table)}`
      db.exec(`INSERT OR IGNORE INTO search_docs(user_id, kind, ref_id, field, body, updated_at)
        SELECT t.user_id, '${s.kind}', t.id, '${s.field}', ${s.body('t')}, ${ts} FROM ${s.table} t WHERE ${s.when('t')}`)
    }
    db.prepare('INSERT INTO search_docs_state(id, backfilled) VALUES(1, ?)').run(Date.now())
  })()
}
