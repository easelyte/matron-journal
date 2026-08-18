// test/search.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { indexableBody, backfillSearchIndex } from '../src/search.js'
import { startTestServer } from './helpers.js'
import { createUser } from '../src/auth.js'

test('indexableBody: text events index their body', () => {
  assert.equal(indexableBody('text', { body: 'why did we drop SQLCipher' }), 'why did we drop SQLCipher')
})

test('indexableBody: text with empty/whitespace/missing/non-string body is not indexed', () => {
  assert.equal(indexableBody('text', { body: '' }), null)
  assert.equal(indexableBody('text', { body: '   \n ' }), null)
  assert.equal(indexableBody('text', {}), null)
  assert.equal(indexableBody('text', { body: 42 }), null)
})

test('indexableBody: diff events index payload.diff, falling back to payload.snippet', () => {
  assert.equal(indexableBody('diff', { diff: '-a\n+b' }), '-a\n+b')
  assert.equal(indexableBody('diff', { snippet: 'changed StoragePaths' }), 'changed StoragePaths')
  assert.equal(indexableBody('diff', { diff: 'full', snippet: 'short' }), 'full')
  assert.equal(indexableBody('diff', {}), null)
})

test('indexableBody: tool_output is NEVER indexed — the privacy property', () => {
  assert.equal(indexableBody('tool_output', { command: 'env', body: 'SECRET=hunter2' }), null)
  assert.equal(indexableBody('tool_output', { snippet: 'SECRET=hunter2' }), null)
})

test('indexableBody: every other type returns null', () => {
  for (const type of ['prompt', 'file', 'image', 'permission_request', 'session_status', 'read_marker', 'convo_meta', 'spawn_outcome']) {
    assert.equal(indexableBody(type, { body: 'x', question: 'x', description: 'x' }), null, type)
  }
})

// spawn_outcome (spec: 2026-08-11 spawn outcome events) is a MESSAGE_TYPE
// (sets the conversation snippet, bumps unread) but must never be
// searchable — its payload carries no prose, only ids/enum/error codes, and
// indexableBody's return-null-for-unknown-type default already covers it;
// this pins that with the type's actual field shape rather than the shared
// {body,question,description} probe above.
test('indexableBody: spawn_outcome is never indexed regardless of payload shape', () => {
  assert.equal(indexableBody('spawn_outcome', { request_id: 'q1', outcome: 'started', room_id: 'r1', child_convo_id: 'c1' }), null)
  assert.equal(indexableBody('spawn_outcome', { request_id: 'q1', outcome: 'failed', error_code: 'timeout' }), null)
})

test('indexableBody: tolerates malformed payloads', () => {
  assert.equal(indexableBody('text', null), null)
  assert.equal(indexableBody('text', undefined), null)
  assert.equal(indexableBody('text', 'bare string'), null)
  assert.equal(indexableBody('diff', 7), null)
})

import { openDb } from '../src/db.js'
import { append, upsertConversation } from '../src/journal.js'
import { runExpireLogs, runOffload } from '../src/retention.js'
import { createAgent } from '../src/auth.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function seedUserAndConvo(db, { userId = 1, convoId = 'c1' } = {}) {
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(?, ?, 'x', 0)")
    .run(userId, `u${userId}`)
  upsertConversation(db, { id: convoId, ownerUserId: userId, title: 'T', sessionState: 'running' })
  return { userId, convoId }
}

const ftsCount = (db, term) =>
  db.prepare('SELECT COUNT(*) n FROM search_fts WHERE search_fts MATCH ?').get(`"${term}"`).n

test('append: text and diff events are indexed in the same transaction', () => {
  const db = openDb(':memory:')
  const { userId, convoId } = seedUserAndConvo(db)
  append(db, { userId, convoId, sender: 'user:dan', type: 'text', payload: { body: 'sqlcipher attempt deferred' } })
  append(db, { userId, convoId, sender: 'agent:kit', type: 'diff', payload: { diff: '+used xchacha instead' } })
  assert.equal(ftsCount(db, 'sqlcipher'), 1)
  assert.equal(ftsCount(db, 'xchacha'), 1)
  const row = db.prepare('SELECT * FROM search_messages WHERE user_id=? ORDER BY seq').get(userId)
  assert.equal(row.convo_id, convoId)
  assert.equal(row.sender, 'user:dan')
  db.close()
})

test('append: tool_output and other non-prose types never reach the index', () => {
  const db = openDb(':memory:')
  const { userId, convoId } = seedUserAndConvo(db)
  append(db, { userId, convoId, sender: 'agent:kit', type: 'tool_output', payload: { command: 'env', snippet: 'SECRET=hunter2' } })
  append(db, { userId, convoId, sender: 'agent:kit', type: 'session_status', payload: { state: 'waiting' } })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_messages').get().n, 0)
  db.close()
})

test('append: a failing search insert rolls back the whole append (same transaction, fails loudly)', () => {
  const db = openDb(':memory:')
  const { userId, convoId } = seedUserAndConvo(db)
  // First append to establish seq=1
  append(db, { userId, convoId, sender: 'user:dan', type: 'text', payload: { body: 'first msg' } })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 1)
  assert.equal(db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(userId).seq, 1)
  // Pre-insert search_messages row with (user_id, seq=2) to trigger UNIQUE constraint
  // when the next append() tries to insert its search row
  db.prepare('INSERT INTO search_messages(user_id, convo_id, seq, ts, sender, body) VALUES(?,?,?,?,?,?)')
    .run(userId, convoId, 2, Date.now(), 'user:dan', 'blocking')
  // Second append with text (indexable) will try to INSERT into search_messages
  // with the same seq=2, violating the UNIQUE(user_id, seq) constraint
  assert.throws(() => append(db, { userId, convoId, sender: 'user:dan', type: 'text', payload: { body: 'second msg' } }))
  // Verify the events table still has only the first row (append rollback)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 1)
  // Verify user_seq was rolled back from 2 back to 1
  assert.equal(db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(userId).seq, 1)
  db.close()
})

test('retention rewriting tool_output leaves the index untouched', () => {
  const db = openDb(':memory:')
  const { userId, convoId } = seedUserAndConvo(db)
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-retention-'))
  append(db, { userId, convoId, sender: 'user:dan', type: 'text', payload: { body: 'the only indexed row' } })
  append(db, { userId, convoId, sender: 'agent:kit', type: 'tool_output', payload: { command: 'ls', snippet: 'out', live_log: true } })
  append(db, { userId, convoId, sender: 'agent:kit', type: 'tool_output', payload: { command: 'ls', snippet: 'old out' } })
  // Age both tool_output rows past every retention window
  db.prepare("UPDATE events SET ts=1 WHERE type='tool_output'").run()
  runExpireLogs(db, { hours: 24, mediaDir })
  runOffload(db, { days: 30, mediaDir })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_messages').get().n, 1)
  assert.equal(ftsCount(db, 'indexed'), 1)
  db.close()
})

// Simulates a pre-search DB: rows written straight into `events`, bypassing
// append() and therefore the live index feed — exactly what history looks
// like when the schema first arrives.
function insertRawEvent(db, { userId, convoId, seq, type, payload, sender = 'user:dan' }) {
  db.prepare('INSERT INTO user_seq(user_id, seq) VALUES(?, ?) ON CONFLICT(user_id) DO UPDATE SET seq=MAX(seq, excluded.seq)').run(userId, seq)
  db.prepare(
    'INSERT INTO events(user_id, seq, convo_id, ts, sender, type, payload) VALUES(?,?,?,?,?,?,?)'
  ).run(userId, seq, convoId, seq, sender, type, JSON.stringify(payload))
}

test('backfill: indexes historical prose, skips everything else, and reports progress', async () => {
  const db = openDb(':memory:')
  seedUserAndConvo(db)
  insertRawEvent(db, { userId: 1, convoId: 'c1', seq: 1, type: 'text', payload: { body: 'ancient decision' } })
  insertRawEvent(db, { userId: 1, convoId: 'c1', seq: 2, type: 'tool_output', payload: { snippet: 'SECRET=hunter2' } })
  insertRawEvent(db, { userId: 1, convoId: 'c1', seq: 3, type: 'diff', payload: { diff: '+ancient change' } })
  const lines = []
  const r = await backfillSearchIndex(db, { batchSize: 2, log: (l) => lines.push(l) })
  assert.equal(r.scanned, 3)
  assert.equal(r.indexed, 2)
  assert.ok(lines.length >= 1, 'progress is logged')
  assert.equal(ftsCount(db, 'ancient'), 2)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM search_messages WHERE body LIKE '%SECRET%'").get().n, 0)
  db.close()
})

test('backfill: running twice changes nothing (idempotent)', async () => {
  const db = openDb(':memory:')
  seedUserAndConvo(db)
  insertRawEvent(db, { userId: 1, convoId: 'c1', seq: 1, type: 'text', payload: { body: 'once only' } })
  await backfillSearchIndex(db)
  const r2 = await backfillSearchIndex(db)
  assert.equal(r2.indexed, 0)
  assert.equal(ftsCount(db, 'once'), 1)
  db.close()
})

test('backfill: interrupt and re-run reaches the same state (resumable)', async () => {
  const db = openDb(':memory:')
  seedUserAndConvo(db)
  for (let i = 1; i <= 10; i++) insertRawEvent(db, { userId: 1, convoId: 'c1', seq: i, type: 'text', payload: { body: `note ${i}` } })
  let batches = 0
  const r1 = await backfillSearchIndex(db, { batchSize: 3, shouldStop: () => ++batches > 1 })
  assert.ok(r1.scanned < 10, 'stopped early')
  const r2 = await backfillSearchIndex(db, { batchSize: 3 })
  assert.equal(r1.scanned + r2.scanned, 10, 'resume starts where the interrupt left off, no re-scan')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_messages').get().n, 10)
  db.close()
})

test('backfill: rows the live path already indexed are not duplicated', async () => {
  const db = openDb(':memory:')
  const { userId, convoId } = seedUserAndConvo(db)
  append(db, { userId, convoId, sender: 'user:dan', type: 'text', payload: { body: 'live row' } })
  const r = await backfillSearchIndex(db)
  assert.equal(r.indexed, 0)
  assert.equal(ftsCount(db, 'live'), 1)
  db.close()
})

test('startServer kicks off the backfill and exposes its promise', async () => {
  const { startTestServer } = await import('./helpers.js')
  const s = await startTestServer()
  assert.ok(s.searchBackfill instanceof Promise)
  await s.searchBackfill
  await s.close()
})

test('GET /search: ranked hits with title, snippet, and live flag', async () => {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })
  const { token } = login.json
  const userId = login.json.user_id
  upsertConversation(s.db, { id: 'battery', ownerUserId: userId, title: 'Battery pass', sessionState: 'running' })
  upsertConversation(s.db, { id: 'old', ownerUserId: userId, title: 'Old work', sessionState: 'done' })
  append(s.db, { userId, convoId: 'battery', sender: 'agent:kit', type: 'text', payload: { body: 'cut the websocket ping cadence for battery' } })
  append(s.db, { userId, convoId: 'old', sender: 'user:dan', type: 'text', payload: { body: 'battery mentioned once in passing' } })

  const r = await s.http('/search?q=battery', { token })
  assert.equal(r.status, 200)
  assert.equal(r.json.hits.length, 2)
  const hit = r.json.hits.find((h) => h.convo_id === 'battery')
  assert.equal(hit.title, 'Battery pass')
  assert.equal(hit.live, true)
  assert.ok(hit.snippet.includes('**battery**'), `snippet highlights the match: ${hit.snippet}`)
  assert.equal(r.json.hits.find((h) => h.convo_id === 'old').live, false)
  await s.close()
})

test('GET /search: cross-user isolation — A cannot match B text', async () => {
  const s = await startTestServer()
  for (const name of ['alice', 'bob']) {
    await createUser(s.db, name, 'password-123')
  }
  const a = (await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'password-123' } })).json
  const b = (await s.http('/login', { method: 'POST', body: { username: 'bob', password: 'password-123' } })).json
  upsertConversation(s.db, { id: 'bc', ownerUserId: b.user_id, title: 'B', sessionState: 'done' })
  append(s.db, { userId: b.user_id, convoId: 'bc', sender: 'user:bob', type: 'text', payload: { body: 'wombat sighting confirmed' } })

  const r = await s.http('/search?q=wombat', { token: a.token })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.hits, [])
  const rb = await s.http('/search?q=wombat', { token: b.token })
  assert.equal(rb.json.hits.length, 1)
  await s.close()
})

test('GET /search: human-typed FTS syntax is treated as literal terms, never a 500', async () => {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const { token, user_id } = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })).json
  upsertConversation(s.db, { id: 'c', ownerUserId: user_id, title: 'C', sessionState: 'done' })
  append(s.db, { userId: user_id, convoId: 'c', sender: 'user:dan', type: 'text', payload: { body: "don't use NEAR the edge *" } })
  for (const q of ['don"t', '*', 'NEAR(', '"unbalanced', 'a AND OR']) {
    const r = await s.http(`/search?q=${encodeURIComponent(q)}`, { token })
    assert.notEqual(r.status, 500, `q=${q} must never 500`)
    assert.ok([200, 400].includes(r.status), `q=${q} → ${r.status}`)
  }
  // Quoting makes syntax characters literal: NEAR matches the stored text as a word
  const near = await s.http('/search?q=NEAR', { token })
  assert.equal(near.status, 200)
  assert.equal(near.json.hits.length, 1)
  await s.close()
})

test('GET /search: bad inputs → 400; limit is clamped to 50', async () => {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const { token } = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })).json
  assert.equal((await s.http('/search', { token })).status, 400)
  assert.equal((await s.http('/search?q=%20%20', { token })).status, 400)
  assert.equal((await s.http(`/search?q=${'x'.repeat(300)}`, { token })).status, 400)
  assert.equal((await s.http('/search?q=a&limit=0', { token })).status, 400)
  assert.equal((await s.http('/search?q=a&limit=nope', { token })).status, 400)
  assert.equal((await s.http('/search?q=a&limit=100000', { token })).status, 200)
  await s.close()
})

test('GET /search: convo_id narrows to one conversation; unknown/foreign convo_id is just zero hits', async () => {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const { token, user_id } = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })).json
  upsertConversation(s.db, { id: 'c1', ownerUserId: user_id, title: 'One', sessionState: 'done' })
  upsertConversation(s.db, { id: 'c2', ownerUserId: user_id, title: 'Two', sessionState: 'done' })
  append(s.db, { userId: user_id, convoId: 'c1', sender: 'user:dan', type: 'text', payload: { body: 'shared keyword' } })
  append(s.db, { userId: user_id, convoId: 'c2', sender: 'user:dan', type: 'text', payload: { body: 'shared keyword' } })
  const r = await s.http('/search?q=shared&convo_id=c1', { token })
  assert.equal(r.json.hits.length, 1)
  assert.equal(r.json.hits[0].convo_id, 'c1')
  // No existence oracle: a convo_id the user cannot see returns the same
  // empty set an unmatched query does (results are user-scoped regardless).
  const foreign = await s.http('/search?q=shared&convo_id=someone-elses', { token })
  assert.equal(foreign.status, 200)
  assert.deepEqual(foreign.json.hits, [])
  await s.close()
})

test('GET /search: porter stemming finds morphological variants', async () => {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const { token, user_id } = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })).json
  upsertConversation(s.db, { id: 'c', ownerUserId: user_id, title: 'C', sessionState: 'done' })
  append(s.db, { userId: user_id, convoId: 'c', sender: 'user:dan', type: 'text', payload: { body: 'we dropped the sqlcipher plan' } })
  const r = await s.http('/search?q=dropping', { token })
  assert.equal(r.json.hits.length, 1)
  await s.close()
})

// Fixture: dan with a client token, two agent devices (kit manages 'work',
// rex manages nothing), prose + tool_output events in 'work'.
async function contextFixture() {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const { token: clientToken, user_id: userId } = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })).json
  const kit = createAgent(s.db, userId, 'kit')
  const rex = createAgent(s.db, userId, 'rex')
  upsertConversation(s.db, { id: 'work', ownerUserId: userId, title: 'Work', sessionState: 'running', agentDeviceId: kit.deviceId })
  const seqs = []
  const put = (type, payload) => {
    const r = append(s.db, { userId, convoId: 'work', sender: 'agent:kit', type, payload })
    seqs.push(r.seq)
    return r.seq
  }
  put('text', { body: 'first message' })
  put('tool_output', { command: 'env', snippet: 'SECRET=hunter2' })
  const anchor = put('text', { body: 'the decision happened here' })
  put('diff', { diff: '+the change itself' })
  put('text', { body: 'aftermath' })
  return { s, clientToken, userId, kit, rex, anchor, seqs }
}

test('around_seq: client gets the window either side, ascending, anchored', async () => {
  const { s, clientToken, anchor } = await contextFixture()
  const r = await s.http(`/convo/work/messages?around_seq=${anchor}&limit=4`, { token: clientToken })
  assert.equal(r.status, 200)
  const seqs = r.json.events.map((e) => e.seq)
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, 'ascending')
  assert.ok(r.json.events.some((e) => e.seq === anchor), 'anchor row included')
  assert.ok(r.json.events.length <= 4)
  assert.ok(r.json.events.some((e) => e.seq < anchor) && r.json.events.some((e) => e.seq > anchor), 'both sides present')
  await s.close()
})

test('around_seq: at either end of a conversation returns short, not an error', async () => {
  const { s, clientToken, seqs } = await contextFixture()
  const first = await s.http(`/convo/work/messages?around_seq=${seqs[0]}&limit=10`, { token: clientToken })
  assert.equal(first.status, 200)
  assert.equal(first.json.events.length, 5)
  const last = await s.http(`/convo/work/messages?around_seq=${seqs[seqs.length - 1] + 100}&limit=10`, { token: clientToken })
  assert.equal(last.status, 200)
  assert.ok(last.json.events.length > 0)
  await s.close()
})

test('around_seq: before_seq and around_seq together → 400', async () => {
  const { s, clientToken, anchor } = await contextFixture()
  const r = await s.http(`/convo/work/messages?around_seq=${anchor}&before_seq=${anchor}`, { token: clientToken })
  assert.equal(r.status, 400)
  await s.close()
})

test('around_seq: a foreign agent sees ONLY what the index can see — the tool_output leak test', async () => {
  const { s, rex, anchor } = await contextFixture()
  const r = await s.http(`/convo/work/messages?around_seq=${anchor}&limit=10`, { token: rex.token })
  assert.equal(r.status, 200, 'foreign agent CAN read context around a hit — that is the feature')
  assert.ok(r.json.events.length >= 3)
  const raw = JSON.stringify(r.json)
  assert.ok(!raw.includes('SECRET'), 'tool_output never reaches a foreign agent')
  assert.ok(r.json.events.every((e) => ['text', 'diff'].includes(e.type)))
  await s.close()
})

test('around_seq: the managing agent still sees its own conversation unfiltered', async () => {
  const { s, kit, anchor } = await contextFixture()
  const r = await s.http(`/convo/work/messages?around_seq=${anchor}&limit=10`, { token: kit.token })
  assert.equal(r.status, 200)
  assert.ok(r.json.events.some((e) => e.type === 'tool_output'), 'own-conversation reads are unchanged')
  await s.close()
})

test('around_seq: before_seq keeps the existing agent gate — foreign agent still 404s', async () => {
  const { s, rex } = await contextFixture()
  const r = await s.http('/convo/work/messages?limit=10', { token: rex.token })
  assert.equal(r.status, 404)
  await s.close()
})

test('around_seq: cross-user is 404, indistinguishable from missing', async () => {
  const { s, anchor } = await contextFixture()
  await createUser(s.db, 'mallory', 'password-123')
  const m = (await s.http('/login', { method: 'POST', body: { username: 'mallory', password: 'password-123' } })).json
  const r = await s.http(`/convo/work/messages?around_seq=${anchor}`, { token: m.token })
  assert.equal(r.status, 404)
  const missing = await s.http(`/convo/no-such/messages?around_seq=${anchor}`, { token: m.token })
  assert.equal(missing.status, 404)
  assert.deepEqual(r.json, missing.json)
  await s.close()
})

test('around_seq: an AGENT token minted for a different user gets the same 404 as a missing convo (no cross-user oracle)', async () => {
  const { s, anchor } = await contextFixture()
  await createUser(s.db, 'mallory', 'password-123')
  const mallory = (await s.http('/login', { method: 'POST', body: { username: 'mallory', password: 'password-123' } })).json
  const spy = createAgent(s.db, mallory.user_id, 'spy')
  const r = await s.http(`/convo/work/messages?around_seq=${anchor}`, { token: spy.token })
  assert.equal(r.status, 404)
  const missing = await s.http(`/convo/no-such/messages?around_seq=${anchor}`, { token: spy.token })
  assert.equal(missing.status, 404)
  assert.deepEqual(r.json, missing.json)
  await s.close()
})

test('around_seq: a non-integer value → 400', async () => {
  const { s, clientToken } = await contextFixture()
  const r = await s.http('/convo/work/messages?around_seq=abc', { token: clientToken })
  assert.equal(r.status, 400)
  await s.close()
})

// Fixture for the foreign-agent windowing tests: 40 text events interleaved
// 2-for-1 with 20 tool_output events (60 events total), so a window that
// merely filtered post-hoc would starve badly. textSeqs[19] sits with 19
// prose events before it and 21 after — enough to fill both a limit=10 and
// a clamped limit=30 window from either side.
async function heavyForeignFixture() {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const { user_id: userId } = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })).json
  const kit = createAgent(s.db, userId, 'kit')
  const rex = createAgent(s.db, userId, 'rex')
  upsertConversation(s.db, { id: 'heavy', ownerUserId: userId, title: 'Heavy', sessionState: 'running', agentDeviceId: kit.deviceId })
  const textSeqs = []
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < 2; j++) {
      const r = append(s.db, { userId, convoId: 'heavy', sender: 'agent:kit', type: 'text', payload: { body: `prose ${i}-${j}` } })
      textSeqs.push(r.seq)
    }
    append(s.db, { userId, convoId: 'heavy', sender: 'agent:kit', type: 'tool_output', payload: { command: 'env', snippet: 'SECRET=hunter2' } })
  }
  return { s, userId, rex, textSeqs, anchor: textSeqs[19] }
}

test('around_seq: a foreign agent gets a FULL window of prose from a tool_output-heavy conversation (pins the indexed-window fix)', async () => {
  const { s, rex, anchor } = await heavyForeignFixture()
  const r = await s.http(`/convo/heavy/messages?around_seq=${anchor}&limit=10`, { token: rex.token })
  assert.equal(r.status, 200)
  assert.equal(r.json.events.length, 10, 'the window is full, not starved by interleaved tool_output')
  assert.ok(r.json.events.every((e) => e.type === 'text'), 'no tool_output leaks into the window')
  await s.close()
})

test('around_seq: a foreign agent read is clamped to 30 even when more prose exists and a bigger limit is requested', async () => {
  const { s, rex, anchor } = await heavyForeignFixture()
  const r = await s.http(`/convo/heavy/messages?around_seq=${anchor}&limit=100`, { token: rex.token })
  assert.equal(r.status, 200)
  assert.ok(r.json.events.length <= 30, `expected <=30 events, got ${r.json.events.length}`)
  await s.close()
})

test('GET /search: empty convo_id is treated as no filter, not a literal-empty-string filter', async () => {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const { token, user_id } = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })).json
  upsertConversation(s.db, { id: 'c1', ownerUserId: user_id, title: 'One', sessionState: 'done' })
  upsertConversation(s.db, { id: 'c2', ownerUserId: user_id, title: 'Two', sessionState: 'done' })
  append(s.db, { userId: user_id, convoId: 'c1', sender: 'user:dan', type: 'text', payload: { body: 'shared keyword' } })
  append(s.db, { userId: user_id, convoId: 'c2', sender: 'user:dan', type: 'text', payload: { body: 'shared keyword' } })
  const r = await s.http('/search?q=shared&convo_id=', { token })
  assert.equal(r.status, 200)
  assert.equal(r.json.hits.length, 2, 'an empty convo_id must not filter results down to zero')
  await s.close()
})
