import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

// Protocol-level fixture for the pre-session_outcome convo_upsert handler.
// Keep the named-field destructure explicit: additional frame keys must never
// become database columns merely because a newer sender includes them.
function handleLegacyConvoUpsert(db, wireFrame) {
  const {
    op,
    convo_id: convoId,
    title,
    session_state: sessionState,
    parent_convo_id: parentConvoId,
  } = JSON.parse(wireFrame)

  if (op !== 'convo_upsert') return [{ op: 'error', code: 'bad_request' }]

  db.prepare(`
    INSERT INTO conversations(id, title, session_state, parent_convo_id)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      session_state = excluded.session_state
  `).run(convoId, title ?? '', sessionState ?? 'running', parentConvoId ?? null)

  return []
}

test('an upgraded database blocks a legacy writer from regressing a terminal outcome', () => {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE conversations(
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      session_state TEXT NOT NULL DEFAULT 'running',
      parent_convo_id TEXT,
      session_outcome TEXT
        CHECK(session_outcome IS NULL OR (session_outcome IN ('completed','interrupted','failed') AND session_state = 'done'))
    )
  `)

  const frame = JSON.stringify({
    op: 'convo_upsert',
    convo_id: 'rollout-child',
    title: 'new bridge, old journal',
    session_state: 'done',
    parent_convo_id: 'rollout-parent',
    session_outcome: 'completed',
  })

  let responses
  assert.doesNotThrow(() => {
    responses = handleLegacyConvoUpsert(db, frame)
  })
  assert.deepEqual(responses, [])
  assert.deepEqual(
    db.prepare(`
      SELECT id, title, session_state, parent_convo_id
      FROM conversations WHERE id = ?
    `).get('rollout-child'),
    {
      id: 'rollout-child',
      title: 'new bridge, old journal',
      session_state: 'done',
      parent_convo_id: 'rollout-parent',
    },
  )
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('conversations') WHERE name = 'session_outcome'").get().count,
    1,
  )

  // A current writer records the terminal outcome. If the process is then
  // rolled back, the legacy update must not produce running/completed.
  db.prepare("UPDATE conversations SET session_outcome='completed' WHERE id='rollout-child'").run()
  const regressiveFrame = JSON.stringify({
    op: 'convo_upsert', convo_id: 'rollout-child', session_state: 'running',
  })
  assert.throws(
    () => handleLegacyConvoUpsert(db, regressiveFrame),
    /CHECK constraint failed/,
  )
  assert.deepEqual(
    db.prepare(`
      SELECT session_state, session_outcome
      FROM conversations WHERE id = ?
    `).get('rollout-child'),
    { session_state: 'done', session_outcome: 'completed' },
  )

  db.close()
})
