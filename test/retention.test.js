import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openDb, getBlob, insertBlob } from '../src/db.js'
import { createUser } from '../src/auth.js'
import { upsertConversation, append, markRead } from '../src/journal.js'
import { runOffload, runExpireLogs, runReapMedia } from '../src/retention.js'
import { resolveReapPcts } from '../src/server.js'
import { writeBlobSync, resolveMediaDir } from '../src/media.js'

function tmpMediaDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'matron-retention-'))
}

async function setup() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id })
  return { db, dan }
}

function backdate(db, seq, userId, daysAgo) {
  const ts = Date.now() - daysAgo * 86400000
  db.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(ts, userId, seq)
  return ts
}

test('runOffload moves an old tool_output payload to a blob, leaves {type,snippet,blob_ref}, is idempotent on re-run', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  const payload = { snippet: 'ran tests', truncated: true, tool_name: 'bash', output: 'x'.repeat(5000) }
  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'tool_output', payload })
  backdate(db, r.seq, dan.id, 40) // 40 days old, past the 30-day default window

  const result = runOffload(db, { days: 30, mediaDir })
  assert.equal(result.offloaded, 1)

  const row = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(dan.id, r.seq)
  assert.ok(row.blob_ref)
  const stored = JSON.parse(row.payload)
  assert.deepEqual(Object.keys(stored).sort(), ['blob_ref', 'snippet', 'type'])
  assert.equal(stored.type, 'tool_output')
  assert.equal(stored.blob_ref, row.blob_ref)

  const blob = getBlob(db, row.blob_ref)
  assert.ok(blob)
  assert.equal(blob.owner_user_id, dan.id)
  assert.equal(blob.content_type, 'application/json')
  const onDisk = JSON.parse(fs.readFileSync(blob.disk_path, 'utf8'))
  assert.deepEqual(onDisk, payload)

  // second run: no-op (idempotent) — the row is already offloaded (blob_ref set)
  const again = runOffload(db, { days: 30, mediaDir })
  assert.equal(again.offloaded, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 1)
  const rowAfter = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(dan.id, r.seq)
  assert.deepEqual(rowAfter, row)
})

test('runOffload skips tool_output events within the retention window', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'tool_output', payload: { snippet: 'recent' } })
  backdate(db, r.seq, dan.id, 5) // only 5 days old
  const result = runOffload(db, { days: 30, mediaDir })
  assert.equal(result.offloaded, 0)
  const row = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(dan.id, r.seq)
  assert.equal(row.blob_ref, null)
})

test('runOffload never touches non-tool_output types, even when old', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'old message' } })
  backdate(db, r.seq, dan.id, 400)
  const result = runOffload(db, { days: 30, mediaDir })
  assert.equal(result.offloaded, 0)
  const row = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(dan.id, r.seq)
  assert.equal(row.blob_ref, null)
  assert.equal(JSON.parse(row.payload).body, 'old message')
})

test('runOffload does not double-process a row whose payload already looks offloaded (defensive idempotency)', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'tool_output', payload: { snippet: 'weird' } })
  backdate(db, r.seq, dan.id, 90)
  // Simulate a row whose payload already has the offloaded shape but whose
  // blob_ref column was never set (hand-edited row / hypothetical bug
  // elsewhere) — offload must not create a second, orphaned blob for it.
  db.prepare('UPDATE events SET payload=? WHERE user_id=? AND seq=?')
    .run(JSON.stringify({ type: 'tool_output', snippet: 'weird', blob_ref: 'deadbeef' }), dan.id, r.seq)

  const result = runOffload(db, { days: 30, mediaDir })
  assert.equal(result.offloaded, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 0, 'a second blob was created for an already-offloaded-shaped payload')
})

test('server.js retention: runs at boot, offloads old tool_output rows, retrievable via GET /media', async (t) => {
  const { startTestServer } = await import('./helpers.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-retention-boot-'))
  const dbPath = path.join(dir, 'test.db')
  const preDb = openDb(dbPath)
  const dan = await createUser(preDb, 'dan', 'pw')
  upsertConversation(preDb, { id: 'c1', ownerUserId: dan.id })
  const payload = { snippet: 'boot offload', body: 'x'.repeat(200) }
  const r = append(preDb, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'tool_output', payload })
  preDb.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(Date.now() - 40 * 86400000, dan.id, r.seq)
  preDb.close()

  const s = await startTestServer({ dbPath, retentionDays: 30 })
  t.after(() => s.close())
  const row = s.db.prepare('SELECT payload, blob_ref FROM events WHERE seq=?').get(r.seq)
  assert.ok(row.blob_ref, 'boot-time retention run did not offload the old row')
  assert.deepEqual(JSON.parse(row.payload), { type: 'tool_output', snippet: 'boot offload', blob_ref: row.blob_ref })

  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'x' } })
  const dl = await fetch(s.base + `/media/${row.blob_ref}`, { headers: { authorization: `Bearer ${login.json.token}` } })
  assert.equal(dl.status, 200)
  assert.equal(dl.headers.get('content-type'), 'application/json')
  const fetched = JSON.parse(await dl.text())
  assert.deepEqual(fetched, payload)
})

test('MATRON_RETENTION_DAYS=0 (retentionDays: 0) disables retention — no offload at boot', async (t) => {
  const { startTestServer } = await import('./helpers.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-retention-disabled-'))
  const dbPath = path.join(dir, 'test.db')
  const preDb = openDb(dbPath)
  const dan = await createUser(preDb, 'dan', 'pw')
  upsertConversation(preDb, { id: 'c1', ownerUserId: dan.id })
  const r = append(preDb, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'tool_output', payload: { snippet: 'x' } })
  preDb.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(Date.now() - 400 * 86400000, dan.id, r.seq)
  preDb.close()

  const s = await startTestServer({ dbPath, retentionDays: 0 })
  t.after(() => s.close())
  const row = s.db.prepare('SELECT blob_ref FROM events WHERE seq=?').get(r.seq)
  assert.equal(row.blob_ref, null)
})

test('an invalid retentionDays override (negative/non-integer) disables retention — it must NOT compute a future cutoff and offload everything', async (t) => {
  const { startTestServer } = await import('./helpers.js')
  for (const badDays of [-5, 1.5, 'abc']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-retention-badopt-'))
    const dbPath = path.join(dir, 'test.db')
    const preDb = openDb(dbPath)
    const dan = await createUser(preDb, 'dan', 'pw')
    upsertConversation(preDb, { id: 'c1', ownerUserId: dan.id })
    // A RECENT row: with days=-5 the cutoff lands 5 days in the future, so a
    // buggy pass-through would offload even this brand-new payload.
    const r = append(preDb, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'tool_output', payload: { snippet: 'fresh' } })
    preDb.close()

    const mute = t.mock.method(console, 'warn', () => {}) // expected one disabled-log line; keep output clean
    const s = await startTestServer({ dbPath, retentionDays: badDays })
    const row = s.db.prepare('SELECT blob_ref FROM events WHERE seq=?').get(r.seq)
    await s.close()
    mute.mock.restore()
    assert.equal(row.blob_ref, null, `retentionDays=${JSON.stringify(badDays)} must disable retention, not offload`)
  }
})

test('default retention (no override, no env) is enabled at 30 days', async (t) => {
  const { startTestServer } = await import('./helpers.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-retention-default-'))
  const dbPath = path.join(dir, 'test.db')
  const preDb = openDb(dbPath)
  const dan = await createUser(preDb, 'dan', 'pw')
  upsertConversation(preDb, { id: 'c1', ownerUserId: dan.id })
  const r = append(preDb, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'tool_output', payload: { snippet: 'x' } })
  preDb.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(Date.now() - 40 * 86400000, dan.id, r.seq)
  preDb.close()

  delete process.env.MATRON_RETENTION_DAYS
  const s = await startTestServer({ dbPath })
  t.after(() => s.close())
  const row = s.db.prepare('SELECT blob_ref FROM events WHERE seq=?').get(r.seq)
  assert.ok(row.blob_ref, 'default (unset env) retention did not offload a 40-day-old row against the 30-day default')
})

// helper: append a finalized live-log tool_output event whose blob exists on disk
function seedLiveLog(db, mediaDir, { userId, convoId, ts, content = 'full log bytes' }) {
  const blob = writeBlobSync(mediaDir, Buffer.from(content, 'utf8'))
  insertBlob(db, { id: blob.id, ownerUserId: userId, contentType: 'text/plain', size: blob.size, sha256: blob.sha256, diskPath: blob.diskPath })
  const payload = { message_ref: 'tu-x', command: 'make', exit_code: 0, denied: false, truncated: false, snippet: 'tail', blob_ref: blob.id, live_log: true }
  const r = append(db, { userId, convoId, sender: 'agent:dev-2', type: 'tool_output', payload, blobRef: blob.id })
  db.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(ts, userId, r.seq)
  return { blob, seq: r.seq }
}

test('runExpireLogs deletes old live_log blobs, rewrites payload, NULLs the column', async () => {
  const { db, dan } = await setup()
  const userId = dan.id
  const convoId = 'c1'
  const mediaDir = tmpMediaDir()
  const old = seedLiveLog(db, mediaDir, { userId, convoId, ts: Date.now() - 48 * 3600000 })
  const fresh = seedLiveLog(db, mediaDir, { userId, convoId, ts: Date.now() - 1 * 3600000 })

  const r = runExpireLogs(db, { hours: 24, mediaDir })
  assert.equal(r.expired, 1)

  const oldRow = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(userId, old.seq)
  assert.equal(oldRow.blob_ref, null)
  const p = JSON.parse(oldRow.payload)
  assert.deepEqual(p, {
    message_ref: 'tu-x', command: 'make', exit_code: 0, denied: false,
    truncated: false, live_log: true, expired: true, blob_ref: null,
  }) // snippet and blob_expired keys gone, everything else carried verbatim
  assert.equal(getBlob(db, old.blob.id), undefined)
  assert.equal(fs.existsSync(old.blob.diskPath), false)

  // the fresh one is untouched
  const freshRow = db.prepare('SELECT blob_ref FROM events WHERE user_id=? AND seq=?').get(userId, fresh.seq)
  assert.equal(freshRow.blob_ref, fresh.blob.id)
  assert.equal(fs.existsSync(fresh.blob.diskPath), true)

  // idempotent: second run finds nothing
  assert.equal(runExpireLogs(db, { hours: 24, mediaDir }).expired, 0)
})

test('runOffload skips expired tombstones (no pointless re-blob at 30d)', async () => {
  const { db, dan } = await setup()
  const userId = dan.id
  const convoId = 'c1'
  const mediaDir = tmpMediaDir()
  const old = seedLiveLog(db, mediaDir, { userId, convoId, ts: Date.now() - 40 * 86400000 })
  runExpireLogs(db, { hours: 24, mediaDir })
  const r = runOffload(db, { days: 30, mediaDir })
  assert.equal(r.offloaded, 0)
  const row = db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(userId, old.seq)
  assert.equal(JSON.parse(row.payload).expired, true) // untouched tombstone
})

test('runOffload skips a pre-upgrade blob_expired payload (disabled-TTL window where the row is already snippet-purged but not yet migrated)', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  const payload = {
    message_ref: 'tu-pre', command: 'npm ci', exit_code: 1, denied: false,
    truncated: false, snippet: 'old tail', blob_ref: null, blob_expired: true, live_log: true,
  }
  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:dev-2', type: 'tool_output', payload })
  backdate(db, r.seq, dan.id, 40) // past the 30-day offload window

  const before = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(dan.id, r.seq)
  const result = runOffload(db, { days: 30, mediaDir })
  assert.equal(result.offloaded, 0)
  const after = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(dan.id, r.seq)
  assert.deepEqual(after, before, 'blob_expired payload must be left untouched by offload')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 0)
})

test('runOffload skips an inline live_log row (blob_ref column NULL, never offloaded) — live_log rows are governed solely by the TTL pass; runExpireLogs then tombstones it', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  // Simulates an empty-output finalize / failed media upload: a live_log
  // payload that landed inline (blob_ref column NULL) and, via a disabled
  // TTL window or a long outage, reached the 30-day offload cutoff without
  // ever being tombstoned. Offload must not re-blob it (that would strand
  // the snippet in a permanent blob and drop the live_log key, exempting
  // the row from runExpireLogs forever) — only runExpireLogs may touch it.
  const payload = {
    message_ref: 'tu-inline', command: 'echo hi', exit_code: 0, denied: false,
    truncated: false, snippet: '', blob_ref: null, live_log: true,
  }
  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:dev-2', type: 'tool_output', payload })
  backdate(db, r.seq, dan.id, 40) // past the 30-day offload window

  const before = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(dan.id, r.seq)
  const offloadResult = runOffload(db, { days: 30, mediaDir })
  assert.equal(offloadResult.offloaded, 0)
  const after = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(dan.id, r.seq)
  assert.deepEqual(after, before, 'inline live_log payload must be left untouched by offload')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 0)

  const expireResult = runExpireLogs(db, { hours: 24, mediaDir })
  assert.equal(expireResult.expired, 1, 'runExpireLogs must still be able to tombstone the row offload skipped')
  const tombstoned = JSON.parse(db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(dan.id, r.seq).payload)
  assert.equal(tombstoned.expired, true)
  assert.equal(tombstoned.blob_ref, null)
})

test('runExpireLogs tombstones a pre-upgrade blob_expired row (snippet purged, no blob to delete)', async () => {
  const { db, dan } = await setup()
  const payload = {
    message_ref: 'tu-pre', command: 'npm ci', exit_code: 1, denied: false,
    truncated: false, snippet: 'old tail', blob_ref: null, blob_expired: true, live_log: true,
  }
  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:dev-2', type: 'tool_output', payload })
  db.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(Date.now() - 48 * 3600000, dan.id, r.seq)

  assert.equal(runExpireLogs(db, { hours: 24, mediaDir: tmpMediaDir() }).expired, 1)
  const row = db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(dan.id, r.seq)
  assert.deepEqual(JSON.parse(row.payload), {
    message_ref: 'tu-pre', command: 'npm ci', exit_code: 1, denied: false,
    truncated: false, live_log: true, expired: true, blob_ref: null,
  })
})

test('runExpireLogs scrubs the convo preview when the purged event is the latest', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  seedLiveLog(db, mediaDir, { userId: dan.id, convoId: 'c1', ts: Date.now() - 48 * 3600000 })
  assert.equal(db.prepare('SELECT snippet FROM conversations WHERE id=?').get('c1').snippet, 'tail')

  runExpireLogs(db, { hours: 24, mediaDir })
  assert.equal(db.prepare('SELECT snippet FROM conversations WHERE id=?').get('c1').snippet, '$ make')
})

test('runExpireLogs leaves the convo preview alone when a newer message exists', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  seedLiveLog(db, mediaDir, { userId: dan.id, convoId: 'c1', ts: Date.now() - 48 * 3600000 })
  append(db, { userId: dan.id, convoId: 'c1', sender: 'user:dan', type: 'text', payload: { body: 'newer message' } })

  runExpireLogs(db, { hours: 24, mediaDir })
  assert.equal(db.prepare('SELECT snippet FROM conversations WHERE id=?').get('c1').snippet, 'newer message')
})

test('runExpireLogs preserves a latest peer_message body as the convo preview', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  seedLiveLog(db, mediaDir, { userId: dan.id, convoId: 'c1', ts: Date.now() - 48 * 3600000 })
  append(db, {
    userId: dan.id, convoId: 'c1', sender: 'agent:peer', type: 'peer_message',
    payload: { body: 'deploy after checks' },
  })
  // A newer non-message row proves retention keys preview ownership on the
  // latest MESSAGE_TYPES event, not conversations.last_seq.
  markRead(db, dan.id, 'c1', null, 'user:dan')

  assert.equal(runExpireLogs(db, { hours: 24, mediaDir }).expired, 1)
  const snippet = db.prepare('SELECT snippet FROM conversations WHERE id=?').get('c1').snippet
  assert.equal(snippet, '💬 deploy after checks')
  assert.notEqual(snippet, '[peer_message]')
})

test('runExpireLogs scrubs the preview even when a read_marker bumped last_seq after the purged event (read_marker never owns the preview)', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  seedLiveLog(db, mediaDir, { userId: dan.id, convoId: 'c1', ts: Date.now() - 48 * 3600000 })
  // markRead appends a read_marker event, which bumps conversations.last_seq
  // but is not a MESSAGE_TYPES type, so it never writes conversations.snippet.
  // A last_seq-based ownership check would wrongly see the purged tool_output
  // as "not latest" and skip the scrub, leaving the purged snippet forever.
  markRead(db, dan.id, 'c1', null, 'user:dan')

  runExpireLogs(db, { hours: 24, mediaDir })
  assert.equal(db.prepare('SELECT snippet FROM conversations WHERE id=?').get('c1').snippet, '$ make')
})

test('runExpireLogs never touches offload-created blobs (no live_log flag)', async () => {
  const { db, dan } = await setup()
  const userId = dan.id
  const convoId = 'c1'
  const mediaDir = tmpMediaDir()
  // an inline tool_output old enough for offload, which creates a NON-live_log blob
  const r0 = append(db, { userId, convoId, sender: 'agent:dev-2', type: 'tool_output', payload: { snippet: 'big', body: 'B'.repeat(500) } })
  db.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(Date.now() - 40 * 86400000, userId, r0.seq)
  runOffload(db, { days: 30, mediaDir })
  assert.equal(runExpireLogs(db, { hours: 24, mediaDir }).expired, 0)
})

test('MATRON_TOOL_LOG_TTL_HOURS=0 (toolLogTtlHours: 0) disables the TTL pass — an old live_log row is not tombstoned at boot', async (t) => {
  const { startTestServer } = await import('./helpers.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-ttl-disabled-'))
  const dbPath = path.join(dir, 'test.db')
  const mediaDir = resolveMediaDir(dbPath)
  const preDb = openDb(dbPath)
  const dan = await createUser(preDb, 'dan', 'pw')
  upsertConversation(preDb, { id: 'c1', ownerUserId: dan.id })
  const seeded = seedLiveLog(preDb, mediaDir, { userId: dan.id, convoId: 'c1', ts: Date.now() - 48 * 3600000 })
  preDb.close()

  const s = await startTestServer({ dbPath, toolLogTtlHours: 0 })
  t.after(() => s.close())
  const row = s.db.prepare('SELECT payload, blob_ref FROM events WHERE seq=?').get(seeded.seq)
  assert.equal(row.blob_ref, seeded.blob.id, 'TTL disabled must not tombstone the row')
  assert.equal(JSON.parse(row.payload).expired, undefined)
})

test('an invalid toolLogTtlHours override (negative/non-integer) disables the TTL pass — it must NOT compute a future cutoff and tombstone everything', async (t) => {
  const { startTestServer } = await import('./helpers.js')
  for (const badHours of [-5, 1.5, 'abc']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-ttl-badopt-'))
    const dbPath = path.join(dir, 'test.db')
    const mediaDir = resolveMediaDir(dbPath)
    const preDb = openDb(dbPath)
    const dan = await createUser(preDb, 'dan', 'pw')
    upsertConversation(preDb, { id: 'c1', ownerUserId: dan.id })
    // A RECENT row: with hours=-5 the cutoff lands 5 hours in the future, so
    // a buggy pass-through would tombstone even this brand-new payload.
    const seeded = seedLiveLog(preDb, mediaDir, { userId: dan.id, convoId: 'c1', ts: Date.now() })
    preDb.close()

    const mute = t.mock.method(console, 'warn', () => {}) // expected one disabled-log line; keep output clean
    const s = await startTestServer({ dbPath, toolLogTtlHours: badHours })
    const row = s.db.prepare('SELECT payload, blob_ref FROM events WHERE seq=?').get(seeded.seq)
    await s.close()
    mute.mock.restore()
    assert.equal(row.blob_ref, seeded.blob.id, `toolLogTtlHours=${JSON.stringify(badHours)} must disable the TTL pass, not tombstone`)
    assert.equal(JSON.parse(row.payload).expired, undefined)
  }
})

test('default TTL (no override, no env) is enabled at 24h — an old live_log row IS tombstoned at boot', async (t) => {
  const { startTestServer } = await import('./helpers.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-ttl-default-'))
  const dbPath = path.join(dir, 'test.db')
  const mediaDir = resolveMediaDir(dbPath)
  const preDb = openDb(dbPath)
  const dan = await createUser(preDb, 'dan', 'pw')
  upsertConversation(preDb, { id: 'c1', ownerUserId: dan.id })
  const seeded = seedLiveLog(preDb, mediaDir, { userId: dan.id, convoId: 'c1', ts: Date.now() - 48 * 3600000 })
  preDb.close()

  delete process.env.MATRON_TOOL_LOG_TTL_HOURS
  const s = await startTestServer({ dbPath })
  t.after(() => s.close())
  const row = s.db.prepare('SELECT payload, blob_ref FROM events WHERE seq=?').get(seeded.seq)
  assert.equal(row.blob_ref, null, 'default (unset env) TTL did not tombstone a 48h-old row against the 24h default')
  assert.equal(JSON.parse(row.payload).expired, true)
})

// ---------------------------------------------------------------------------
// runReapMedia — quota-pressure attachment reaper
// ---------------------------------------------------------------------------

// Seeds a real blob on disk + its blobs row + a file/image event referencing
// it (both events.blob_ref and payload.blob_ref, mirroring ws.js sends).
function seedAttachment(db, mediaDir, { userId, convoId = 'c1', type = 'file', name = 'doc.pdf', bytes = 100, daysAgo = 0, caption }) {
  const blob = writeBlobSync(mediaDir, Buffer.alloc(bytes, 1))
  insertBlob(db, {
    id: blob.id, ownerUserId: userId, contentType: 'application/pdf',
    size: blob.size, sha256: blob.sha256, diskPath: blob.diskPath,
  })
  const payload = { blob_ref: blob.id, name, content_type: 'application/pdf', size: bytes }
  if (caption) payload.caption = caption
  const r = append(db, { userId, convoId, sender: 'user:dan', type, payload, blobRef: blob.id })
  if (daysAgo) backdate(db, r.seq, userId, daysAgo)
  return { blob, seq: r.seq }
}

test('runReapMedia is a no-op below the high-water mark', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  const a = seedAttachment(db, mediaDir, { userId: dan.id, bytes: 400, daysAgo: 100 })
  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 0, bytesFreed: 0 })
  assert.ok(getBlob(db, a.blob.id))
  assert.ok(fs.existsSync(a.blob.diskPath))
})

test('runReapMedia reaps oldest attachments down to the low-water mark, tombstones their events, and is idempotent', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  // 4 x 300 = 1200 used, quota 1000 -> over the 900 high-water mark.
  // Oldest two must go (1200 -> 900 -> 600 <= 700 target); newest two survive.
  const oldest = seedAttachment(db, mediaDir, { userId: dan.id, bytes: 300, daysAgo: 40, caption: 'q3 report' })
  const older = seedAttachment(db, mediaDir, { userId: dan.id, type: 'image', bytes: 300, daysAgo: 30 })
  const newer = seedAttachment(db, mediaDir, { userId: dan.id, bytes: 300, daysAgo: 20 })
  const newest = seedAttachment(db, mediaDir, { userId: dan.id, bytes: 300, daysAgo: 10 })

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 2, bytesFreed: 600 })

  for (const gone of [oldest, older]) {
    assert.equal(getBlob(db, gone.blob.id), undefined, 'reaped blob row must be deleted')
    assert.equal(fs.existsSync(gone.blob.diskPath), false, 'reaped blob file must be unlinked')
    const row = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(dan.id, gone.seq)
    assert.equal(row.blob_ref, null)
    const p = JSON.parse(row.payload)
    assert.equal(p.expired, true)
    assert.equal(p.blob_ref, null)
    assert.equal(p.name, 'doc.pdf', 'tombstone must keep the display name')
    assert.equal(p.size, 300, 'tombstone must keep the size')
  }
  assert.equal(JSON.parse(db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(dan.id, oldest.seq).payload).caption,
    'q3 report', 'tombstone must keep the caption')
  for (const kept of [newer, newest]) {
    assert.ok(getBlob(db, kept.blob.id), 'newer attachment must survive')
    assert.ok(fs.existsSync(kept.blob.diskPath))
  }

  const again = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(again, { reaped: 0, bytesFreed: 0 }, 'second run under the high-water mark must be a no-op')
})

// Shared setup for the tool_output-vs-attachment tests: an offloaded
// tool_output blob of `toolBytes` plus attachments.
function seedToolBlob(db, mediaDir, { userId, bytes, daysAgo }) {
  const toolBlob = writeBlobSync(mediaDir, Buffer.alloc(bytes, 2))
  insertBlob(db, {
    id: toolBlob.id, ownerUserId: userId, contentType: 'application/json',
    size: toolBlob.size, sha256: toolBlob.sha256, diskPath: toolBlob.diskPath,
  })
  const r = append(db, {
    userId, convoId: 'c1', sender: 'agent:a', type: 'tool_output',
    payload: { type: 'tool_output', snippet: 'ran tests', blob_ref: toolBlob.id }, blobRef: toolBlob.id,
  })
  backdate(db, r.seq, userId, daysAgo)
  return { blob: toolBlob, seq: r.seq }
}

test('runReapMedia never reaps a tool_output blob, even when it is the oldest', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  // Tool blob (100, oldest) + two attachments (500 each). used = 1100 >= 900
  // high water; un-reapable floor is only 100, so reaping proceeds — and must
  // take the oldest ATTACHMENT, never the older tool blob. One reap gets to
  // 600 <= 700 target.
  const tool = seedToolBlob(db, mediaDir, { userId: dan.id, bytes: 100, daysAgo: 90 })
  const fileA = seedAttachment(db, mediaDir, { userId: dan.id, bytes: 500, daysAgo: 40 })
  const fileB = seedAttachment(db, mediaDir, { userId: dan.id, bytes: 500, daysAgo: 10 })

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 1, bytesFreed: 500 })
  assert.ok(getBlob(db, tool.blob.id), 'tool_output blob must survive quota pressure')
  assert.ok(fs.existsSync(tool.blob.diskPath))
  assert.equal(getBlob(db, fileA.blob.id), undefined, 'oldest attachment must be the one reaped')
  assert.ok(getBlob(db, fileB.blob.id))
})

test('runReapMedia refuses to reap when the un-reapable floor alone keeps the user above target', async (t) => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  // Tool blob 800 + attachment 300: used = 1100 >= 900 high water, but the
  // un-reapable floor (800) already exceeds the 700 target — reaping every
  // attachment could never reach it. The pass must skip the user with a warn
  // and delete NOTHING (the old behaviour ground through every attachment,
  // including brand-new ones, every tick, forever).
  const tool = seedToolBlob(db, mediaDir, { userId: dan.id, bytes: 800, daysAgo: 90 })
  const file = seedAttachment(db, mediaDir, { userId: dan.id, bytes: 300, daysAgo: 5 })
  // An attachment-type event pointing at the tool blob must not make it
  // reapable either (its tool_output reference wins).
  const mixed = append(db, {
    userId: dan.id, convoId: 'c1', sender: 'user:dan', type: 'file',
    payload: { blob_ref: tool.blob.id, name: 'weird.json', content_type: 'application/json', size: 800 }, blobRef: tool.blob.id,
  })
  backdate(db, mixed.seq, dan.id, 89)

  const warns = []
  const mute = t.mock.method(console, 'warn', (...a) => { warns.push(a.join(' ')) })
  t.after(() => mute.mock.restore())

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 0, bytesFreed: 0 })
  assert.ok(getBlob(db, tool.blob.id))
  assert.ok(getBlob(db, file.blob.id), 'no attachment may be sacrificed to an unreachable target')
  assert.ok(fs.existsSync(file.blob.diskPath))
  assert.ok(warns.some((w) => w.includes('un-reapable')), 'skip must be loud')

  // Sustained pressure: the next tick must skip again, not churn.
  const again = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(again, { reaped: 0, bytesFreed: 0 })
})

test('runReapMedia: a stray blob_ref on a text event does not pin an attachment blob', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  // ws.js passes msg.blob_ref through unvalidated on text sends — a
  // caption-style text event referencing the attachment's blob must not
  // exempt that blob from the reaper (only tool_output references pin).
  const file = seedAttachment(db, mediaDir, { userId: dan.id, bytes: 950, daysAgo: 10 })
  const textRef = append(db, {
    userId: dan.id, convoId: 'c1', sender: 'user:dan', type: 'text',
    payload: { body: 'see attached', blob_ref: file.blob.id }, blobRef: file.blob.id,
  })

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 1, bytesFreed: 950 })
  assert.equal(getBlob(db, file.blob.id), undefined)
  assert.equal(JSON.parse(db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(dan.id, file.seq).payload).expired, true)
  // The text event is not an attachment: its payload must be left alone.
  const textRow = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(dan.id, textRef.seq)
  assert.equal(JSON.parse(textRow.payload).expired, undefined)
  // Its blob_ref column intentionally still names the now-deleted blob —
  // non-attachment refs are left dangling by design (nothing dereferences
  // them; a resolver would get the same 404 a stale client gets). Pin it so
  // a future change here is loud.
  assert.equal(textRow.blob_ref, file.blob.id)
})

test("runReapMedia never rewrites another user's event referencing the reaped blob", async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  const bev = await createUser(db, 'bev', 'pw')
  upsertConversation(db, { id: 'cb', ownerUserId: bev.id })
  const file = seedAttachment(db, mediaDir, { userId: dan.id, bytes: 950, daysAgo: 10 })
  // Pathological cross-user reference (blob ids are unguessable in practice):
  // bev's event points at dan's blob. Reaping dan's blob must not touch
  // bev's payload, and bev's newer event must not influence dan's reap order.
  const bevs = append(db, {
    userId: bev.id, convoId: 'cb', sender: 'user:bev', type: 'file',
    payload: { blob_ref: file.blob.id, name: 'not-mine.pdf', size: 950, note: 'bev private' }, blobRef: file.blob.id,
  })

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 1, bytesFreed: 950 })
  assert.equal(getBlob(db, file.blob.id), undefined)
  const bevRow = db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(bev.id, bevs.seq)
  const bevPayload = JSON.parse(bevRow.payload)
  assert.equal(bevPayload.expired, undefined, "another user's event must never be tombstoned")
  assert.equal(bevPayload.note, 'bev private')
})

test('runReapMedia skips loudly on an invalid quota instead of selecting everything', async (t) => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  const file = seedAttachment(db, mediaDir, { userId: dan.id, bytes: 950, daysAgo: 10 })
  const mute = t.mock.method(console, 'warn', () => {})
  t.after(() => mute.mock.restore())
  // quotaBytes 0 would make high = target = 0: every user selected and the
  // stop condition unreachable — must refuse up front.
  for (const bad of [0, -5, undefined, NaN, 'lots']) {
    const r = runReapMedia(db, { quotaBytes: bad })
    assert.deepEqual(r, { reaped: 0, bytesFreed: 0 }, `quotaBytes=${bad} must be a loud no-op`)
  }
  assert.ok(getBlob(db, file.blob.id))
})

test('runReapMedia skips orphan blobs (uploaded but not yet attached to an event)', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  // An upload sits orphaned between POST /media and the ws send that attaches
  // it — reaping it would corrupt an in-flight attachment. Today the
  // exclusion is structural (candidates join through events), so this test
  // is a regression tripwire for any rewrite that scans the blobs table
  // directly.
  const orphan = writeBlobSync(mediaDir, Buffer.alloc(600, 3))
  insertBlob(db, {
    id: orphan.id, ownerUserId: dan.id, contentType: 'image/png',
    size: orphan.size, sha256: orphan.sha256, diskPath: orphan.diskPath,
  })
  const file = seedAttachment(db, mediaDir, { userId: dan.id, bytes: 600, daysAgo: 10 })

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 1, bytesFreed: 600 })
  assert.ok(getBlob(db, orphan.id), 'orphan blob must not be reaped')
  assert.ok(fs.existsSync(orphan.diskPath))
  assert.equal(getBlob(db, file.blob.id), undefined)
})

test('runReapMedia tombstones every event referencing a shared blob, deleting the blob once', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  upsertConversation(db, { id: 'c2', ownerUserId: dan.id })
  const first = seedAttachment(db, mediaDir, { userId: dan.id, bytes: 1000, daysAgo: 30 })
  const second = append(db, {
    userId: dan.id, convoId: 'c2', sender: 'user:dan', type: 'file',
    payload: { blob_ref: first.blob.id, name: 'doc.pdf', content_type: 'application/pdf', size: 1000 }, blobRef: first.blob.id,
  })
  backdate(db, second.seq, dan.id, 29)

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 1, bytesFreed: 1000 })
  for (const seq of [first.seq, second.seq]) {
    const row = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(dan.id, seq)
    assert.equal(row.blob_ref, null)
    assert.equal(JSON.parse(row.payload).expired, true)
  }
  assert.equal(getBlob(db, first.blob.id), undefined)
})

test('runReapMedia only reaps users over the high-water mark', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  const bev = await createUser(db, 'bev', 'pw')
  upsertConversation(db, { id: 'cb', ownerUserId: bev.id })
  const dansFile = seedAttachment(db, mediaDir, { userId: dan.id, bytes: 950, daysAgo: 10 })
  const bevsFile = seedAttachment(db, mediaDir, { userId: bev.id, convoId: 'cb', bytes: 400, daysAgo: 100 })

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 1, bytesFreed: 950 })
  assert.equal(getBlob(db, dansFile.blob.id), undefined)
  assert.ok(getBlob(db, bevsFile.blob.id), "an under-quota user's attachments must be untouched")
})

test('runReapMedia tolerates a blob file already missing on disk', async () => {
  const { db, dan } = await setup()
  const mediaDir = tmpMediaDir()
  const file = seedAttachment(db, mediaDir, { userId: dan.id, bytes: 950, daysAgo: 10 })
  fs.unlinkSync(file.blob.diskPath)

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 1, bytesFreed: 950 })
  assert.equal(getBlob(db, file.blob.id), undefined)
  const row = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(dan.id, file.seq)
  assert.equal(JSON.parse(row.payload).expired, true)
  assert.equal(row.blob_ref, null)
})

test('resolveReapPcts: defaults, overrides, disable-on-zero, fail-closed on garbage or inverted marks', (t) => {
  const mute = t.mock.method(console, 'warn', () => {})
  t.after(() => mute.mock.restore())
  delete process.env.MATRON_MEDIA_REAP_HIGH_PCT
  delete process.env.MATRON_MEDIA_REAP_LOW_PCT

  assert.deepEqual(resolveReapPcts({}), { highPct: 90, lowPct: 70 })
  assert.deepEqual(resolveReapPcts({ mediaReapHighPct: 95, mediaReapLowPct: 50 }), { highPct: 95, lowPct: 50 })
  assert.equal(resolveReapPcts({ mediaReapHighPct: 0 }), null, '0 must disable the reaper')
  assert.equal(resolveReapPcts({ mediaReapHighPct: 'lots' }), null, 'garbage must disable, never delete data')
  assert.equal(resolveReapPcts({ mediaReapLowPct: 'some' }), null, 'garbage LOW must disable too')
  assert.equal(resolveReapPcts({ mediaReapHighPct: 101 }), null, '>100% is invalid')
  assert.equal(resolveReapPcts({ mediaReapHighPct: 60, mediaReapLowPct: 80 }), null, 'low >= high must disable')

  process.env.MATRON_MEDIA_REAP_HIGH_PCT = '80'
  process.env.MATRON_MEDIA_REAP_LOW_PCT = '40'
  assert.deepEqual(resolveReapPcts({}), { highPct: 80, lowPct: 40 })
  assert.deepEqual(resolveReapPcts({ mediaReapHighPct: 95 }), { highPct: 95, lowPct: 40 }, 'override beats env per-knob')
  process.env.MATRON_MEDIA_REAP_LOW_PCT = 'nonsense'
  assert.equal(resolveReapPcts({}), null, 'env-sourced garbage must disable')
  process.env.MATRON_MEDIA_REAP_LOW_PCT = ''
  assert.equal(resolveReapPcts({}), null, "empty env assignment (Number('') === 0) must disable")
  delete process.env.MATRON_MEDIA_REAP_HIGH_PCT
  delete process.env.MATRON_MEDIA_REAP_LOW_PCT
})

test('reap pass runs at boot when a user is over quota', async (t) => {
  const { startTestServer } = await import('./helpers.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-reap-boot-'))
  const dbPath = path.join(dir, 'test.db')
  const mediaDir = resolveMediaDir(dbPath)
  const preDb = openDb(dbPath)
  const dan = await createUser(preDb, 'dan', 'pw')
  upsertConversation(preDb, { id: 'c1', ownerUserId: dan.id })
  const old = seedAttachment(preDb, mediaDir, { userId: dan.id, bytes: 600, daysAgo: 30 })
  const fresh = seedAttachment(preDb, mediaDir, { userId: dan.id, bytes: 350, daysAgo: 1 })
  preDb.close()

  const s = await startTestServer({ dbPath, mediaUserQuotaBytes: 1000 })
  t.after(() => s.close())
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM blobs WHERE id=?').get(old.blob.id).n, 0,
    'boot reap must clear the oldest attachment for an over-quota user')
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM blobs WHERE id=?').get(fresh.blob.id).n, 1)
  const row = s.db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(dan.id, old.seq)
  assert.equal(JSON.parse(row.payload).expired, true)
})
