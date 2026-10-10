import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { openDb, getBlob, insertBlob } from '../src/db.js'
import { createUser } from '../src/auth.js'
import { upsertConversation, append, markRead } from '../src/journal.js'
import { runOffload, runExpireLogs, runReapMedia, runReapOrphanBlobs, runExpireVoiceNotes } from '../src/retention.js'
import { resolveReapPcts, resolveOrphanBlobGraceHours } from '../src/server.js'
import { writeBlobSync, resolveMediaDir } from '../src/media.js'
import { createItem, addComment, setAttachmentTranscript, finishAttachmentTranscript, listComments } from '../src/items.js'
import { makeTmpDir } from './tmp-dir.js'

function tmpMediaDir() {
  return makeTmpDir('matron-retention-')
}

async function setup() {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id })
  return { db, alice }
}

function backdate(db, seq, userId, daysAgo) {
  const ts = Date.now() - daysAgo * 86400000
  db.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(ts, userId, seq)
  return ts
}

test('runOffload moves an old tool_output payload to a blob, leaves {type,snippet,blob_ref}, is idempotent on re-run', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const payload = { snippet: 'ran tests', truncated: true, tool_name: 'bash', output: 'x'.repeat(5000) }
  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'tool_output', payload })
  backdate(db, r.seq, alice.id, 40) // 40 days old, past the 30-day default window

  const result = runOffload(db, { days: 30, mediaDir })
  assert.equal(result.offloaded, 1)

  const row = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(alice.id, r.seq)
  assert.ok(row.blob_ref)
  const stored = JSON.parse(row.payload)
  assert.deepEqual(Object.keys(stored).sort(), ['blob_ref', 'snippet', 'type'])
  assert.equal(stored.type, 'tool_output')
  assert.equal(stored.blob_ref, row.blob_ref)

  const blob = getBlob(db, row.blob_ref)
  assert.ok(blob)
  assert.equal(blob.owner_user_id, alice.id)
  assert.equal(blob.content_type, 'application/json')
  const onDisk = JSON.parse(fs.readFileSync(blob.disk_path, 'utf8'))
  assert.deepEqual(onDisk, payload)

  // second run: no-op (idempotent) — the row is already offloaded (blob_ref set)
  const again = runOffload(db, { days: 30, mediaDir })
  assert.equal(again.offloaded, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 1)
  const rowAfter = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(alice.id, r.seq)
  assert.deepEqual(rowAfter, row)
})

test('runOffload skips tool_output events within the retention window', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'tool_output', payload: { snippet: 'recent' } })
  backdate(db, r.seq, alice.id, 5) // only 5 days old
  const result = runOffload(db, { days: 30, mediaDir })
  assert.equal(result.offloaded, 0)
  const row = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(alice.id, r.seq)
  assert.equal(row.blob_ref, null)
})

test('runOffload never touches non-tool_output types, even when old', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'old message' } })
  backdate(db, r.seq, alice.id, 400)
  const result = runOffload(db, { days: 30, mediaDir })
  assert.equal(result.offloaded, 0)
  const row = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(alice.id, r.seq)
  assert.equal(row.blob_ref, null)
  assert.equal(JSON.parse(row.payload).body, 'old message')
})

test('runOffload does not double-process a row whose payload already looks offloaded (defensive idempotency)', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'tool_output', payload: { snippet: 'weird' } })
  backdate(db, r.seq, alice.id, 90)
  // Simulate a row whose payload already has the offloaded shape but whose
  // blob_ref column was never set (hand-edited row / hypothetical bug
  // elsewhere) — offload must not create a second, orphaned blob for it.
  db.prepare('UPDATE events SET payload=? WHERE user_id=? AND seq=?')
    .run(JSON.stringify({ type: 'tool_output', snippet: 'weird', blob_ref: 'deadbeef' }), alice.id, r.seq)

  const result = runOffload(db, { days: 30, mediaDir })
  assert.equal(result.offloaded, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 0, 'a second blob was created for an already-offloaded-shaped payload')
})

test('server.js retention: runs at boot, offloads old tool_output rows, retrievable via GET /media', async (t) => {
  const { startTestServer } = await import('./helpers.js')
  const dir = makeTmpDir('matron-retention-boot-')
  const dbPath = path.join(dir, 'test.db')
  const preDb = openDb(dbPath)
  const alice = await createUser(preDb, 'alice', 'pw')
  upsertConversation(preDb, { id: 'c1', ownerUserId: alice.id })
  const payload = { snippet: 'boot offload', body: 'x'.repeat(200) }
  const r = append(preDb, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'tool_output', payload })
  preDb.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(Date.now() - 40 * 86400000, alice.id, r.seq)
  preDb.close()

  const s = await startTestServer({ dbPath, retentionDays: 30 })
  t.after(() => s.close())
  const row = s.db.prepare('SELECT payload, blob_ref FROM events WHERE seq=?').get(r.seq)
  assert.ok(row.blob_ref, 'boot-time retention run did not offload the old row')
  assert.deepEqual(JSON.parse(row.payload), { type: 'tool_output', snippet: 'boot offload', blob_ref: row.blob_ref })

  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'x' } })
  const dl = await fetch(s.base + `/media/${row.blob_ref}`, { headers: { authorization: `Bearer ${login.json.token}` } })
  assert.equal(dl.status, 200)
  assert.equal(dl.headers.get('content-type'), 'application/json')
  const fetched = JSON.parse(await dl.text())
  assert.deepEqual(fetched, payload)
})

test('MATRON_RETENTION_DAYS=0 (retentionDays: 0) disables retention — no offload at boot', async (t) => {
  const { startTestServer } = await import('./helpers.js')
  const dir = makeTmpDir('matron-retention-disabled-')
  const dbPath = path.join(dir, 'test.db')
  const preDb = openDb(dbPath)
  const alice = await createUser(preDb, 'alice', 'pw')
  upsertConversation(preDb, { id: 'c1', ownerUserId: alice.id })
  const r = append(preDb, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'tool_output', payload: { snippet: 'x' } })
  preDb.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(Date.now() - 400 * 86400000, alice.id, r.seq)
  preDb.close()

  const s = await startTestServer({ dbPath, retentionDays: 0 })
  t.after(() => s.close())
  const row = s.db.prepare('SELECT blob_ref FROM events WHERE seq=?').get(r.seq)
  assert.equal(row.blob_ref, null)
})

test('an invalid retentionDays override (negative/non-integer) disables retention — it must NOT compute a future cutoff and offload everything', async (t) => {
  const { startTestServer } = await import('./helpers.js')
  for (const badDays of [-5, 1.5, 'abc']) {
    const dir = makeTmpDir('matron-retention-badopt-')
    const dbPath = path.join(dir, 'test.db')
    const preDb = openDb(dbPath)
    const alice = await createUser(preDb, 'alice', 'pw')
    upsertConversation(preDb, { id: 'c1', ownerUserId: alice.id })
    // A RECENT row: with days=-5 the cutoff lands 5 days in the future, so a
    // buggy pass-through would offload even this brand-new payload.
    const r = append(preDb, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'tool_output', payload: { snippet: 'fresh' } })
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
  const dir = makeTmpDir('matron-retention-default-')
  const dbPath = path.join(dir, 'test.db')
  const preDb = openDb(dbPath)
  const alice = await createUser(preDb, 'alice', 'pw')
  upsertConversation(preDb, { id: 'c1', ownerUserId: alice.id })
  const r = append(preDb, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'tool_output', payload: { snippet: 'x' } })
  preDb.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(Date.now() - 40 * 86400000, alice.id, r.seq)
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
  const r = append(db, { userId, convoId, sender: 'agent:box-2', type: 'tool_output', payload, blobRef: blob.id })
  db.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(ts, userId, r.seq)
  return { blob, seq: r.seq }
}

test('runExpireLogs deletes old live_log blobs, rewrites payload, NULLs the column', async () => {
  const { db, alice } = await setup()
  const userId = alice.id
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
  const { db, alice } = await setup()
  const userId = alice.id
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
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const payload = {
    message_ref: 'tu-pre', command: 'npm ci', exit_code: 1, denied: false,
    truncated: false, snippet: 'old tail', blob_ref: null, blob_expired: true, live_log: true,
  }
  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:box-2', type: 'tool_output', payload })
  backdate(db, r.seq, alice.id, 40) // past the 30-day offload window

  const before = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(alice.id, r.seq)
  const result = runOffload(db, { days: 30, mediaDir })
  assert.equal(result.offloaded, 0)
  const after = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(alice.id, r.seq)
  assert.deepEqual(after, before, 'blob_expired payload must be left untouched by offload')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 0)
})

test('runOffload skips an inline live_log row (blob_ref column NULL, never offloaded) — live_log rows are governed solely by the TTL pass; runExpireLogs then tombstones it', async () => {
  const { db, alice } = await setup()
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
  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:box-2', type: 'tool_output', payload })
  backdate(db, r.seq, alice.id, 40) // past the 30-day offload window

  const before = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(alice.id, r.seq)
  const offloadResult = runOffload(db, { days: 30, mediaDir })
  assert.equal(offloadResult.offloaded, 0)
  const after = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(alice.id, r.seq)
  assert.deepEqual(after, before, 'inline live_log payload must be left untouched by offload')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 0)

  const expireResult = runExpireLogs(db, { hours: 24, mediaDir })
  assert.equal(expireResult.expired, 1, 'runExpireLogs must still be able to tombstone the row offload skipped')
  const tombstoned = JSON.parse(db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(alice.id, r.seq).payload)
  assert.equal(tombstoned.expired, true)
  assert.equal(tombstoned.blob_ref, null)
})

test('runExpireLogs tombstones a pre-upgrade blob_expired row (snippet purged, no blob to delete)', async () => {
  const { db, alice } = await setup()
  const payload = {
    message_ref: 'tu-pre', command: 'npm ci', exit_code: 1, denied: false,
    truncated: false, snippet: 'old tail', blob_ref: null, blob_expired: true, live_log: true,
  }
  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:box-2', type: 'tool_output', payload })
  db.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(Date.now() - 48 * 3600000, alice.id, r.seq)

  assert.equal(runExpireLogs(db, { hours: 24, mediaDir: tmpMediaDir() }).expired, 1)
  const row = db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(alice.id, r.seq)
  assert.deepEqual(JSON.parse(row.payload), {
    message_ref: 'tu-pre', command: 'npm ci', exit_code: 1, denied: false,
    truncated: false, live_log: true, expired: true, blob_ref: null,
  })
})

test('runExpireLogs scrubs the convo preview when the purged event is the latest', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  seedLiveLog(db, mediaDir, { userId: alice.id, convoId: 'c1', ts: Date.now() - 48 * 3600000 })
  assert.equal(db.prepare('SELECT snippet FROM conversations WHERE id=?').get('c1').snippet, 'tail')

  runExpireLogs(db, { hours: 24, mediaDir })
  assert.equal(db.prepare('SELECT snippet FROM conversations WHERE id=?').get('c1').snippet, '$ make')
})

test('runExpireLogs leaves the convo preview alone when a newer message exists', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  seedLiveLog(db, mediaDir, { userId: alice.id, convoId: 'c1', ts: Date.now() - 48 * 3600000 })
  append(db, { userId: alice.id, convoId: 'c1', sender: 'user:alice', type: 'text', payload: { body: 'newer message' } })

  runExpireLogs(db, { hours: 24, mediaDir })
  assert.equal(db.prepare('SELECT snippet FROM conversations WHERE id=?').get('c1').snippet, 'newer message')
})

test('runExpireLogs preserves a latest peer_message body as the convo preview', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  seedLiveLog(db, mediaDir, { userId: alice.id, convoId: 'c1', ts: Date.now() - 48 * 3600000 })
  append(db, {
    userId: alice.id, convoId: 'c1', sender: 'agent:peer', type: 'peer_message',
    payload: { body: 'deploy after checks' },
  })
  // A newer non-message row proves retention keys preview ownership on the
  // latest MESSAGE_TYPES event, not conversations.last_seq.
  markRead(db, alice.id, 'c1', null, 'user:alice')

  assert.equal(runExpireLogs(db, { hours: 24, mediaDir }).expired, 1)
  const snippet = db.prepare('SELECT snippet FROM conversations WHERE id=?').get('c1').snippet
  assert.equal(snippet, '💬 deploy after checks')
  assert.notEqual(snippet, '[peer_message]')
})

test('runExpireLogs scrubs the preview even when a read_marker bumped last_seq after the purged event (read_marker never owns the preview)', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  seedLiveLog(db, mediaDir, { userId: alice.id, convoId: 'c1', ts: Date.now() - 48 * 3600000 })
  // markRead appends a read_marker event, which bumps conversations.last_seq
  // but is not a MESSAGE_TYPES type, so it never writes conversations.snippet.
  // A last_seq-based ownership check would wrongly see the purged tool_output
  // as "not latest" and skip the scrub, leaving the purged snippet forever.
  markRead(db, alice.id, 'c1', null, 'user:alice')

  runExpireLogs(db, { hours: 24, mediaDir })
  assert.equal(db.prepare('SELECT snippet FROM conversations WHERE id=?').get('c1').snippet, '$ make')
})

test('runExpireLogs never touches offload-created blobs (no live_log flag)', async () => {
  const { db, alice } = await setup()
  const userId = alice.id
  const convoId = 'c1'
  const mediaDir = tmpMediaDir()
  // an inline tool_output old enough for offload, which creates a NON-live_log blob
  const r0 = append(db, { userId, convoId, sender: 'agent:box-2', type: 'tool_output', payload: { snippet: 'big', body: 'B'.repeat(500) } })
  db.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(Date.now() - 40 * 86400000, userId, r0.seq)
  runOffload(db, { days: 30, mediaDir })
  assert.equal(runExpireLogs(db, { hours: 24, mediaDir }).expired, 0)
})

test('MATRON_TOOL_LOG_TTL_HOURS=0 (toolLogTtlHours: 0) disables the TTL pass — an old live_log row is not tombstoned at boot', async (t) => {
  const { startTestServer } = await import('./helpers.js')
  const dir = makeTmpDir('matron-ttl-disabled-')
  const dbPath = path.join(dir, 'test.db')
  const mediaDir = resolveMediaDir(dbPath)
  const preDb = openDb(dbPath)
  const alice = await createUser(preDb, 'alice', 'pw')
  upsertConversation(preDb, { id: 'c1', ownerUserId: alice.id })
  const seeded = seedLiveLog(preDb, mediaDir, { userId: alice.id, convoId: 'c1', ts: Date.now() - 48 * 3600000 })
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
    const dir = makeTmpDir('matron-ttl-badopt-')
    const dbPath = path.join(dir, 'test.db')
    const mediaDir = resolveMediaDir(dbPath)
    const preDb = openDb(dbPath)
    const alice = await createUser(preDb, 'alice', 'pw')
    upsertConversation(preDb, { id: 'c1', ownerUserId: alice.id })
    // A RECENT row: with hours=-5 the cutoff lands 5 hours in the future, so
    // a buggy pass-through would tombstone even this brand-new payload.
    const seeded = seedLiveLog(preDb, mediaDir, { userId: alice.id, convoId: 'c1', ts: Date.now() })
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
  const dir = makeTmpDir('matron-ttl-default-')
  const dbPath = path.join(dir, 'test.db')
  const mediaDir = resolveMediaDir(dbPath)
  const preDb = openDb(dbPath)
  const alice = await createUser(preDb, 'alice', 'pw')
  upsertConversation(preDb, { id: 'c1', ownerUserId: alice.id })
  const seeded = seedLiveLog(preDb, mediaDir, { userId: alice.id, convoId: 'c1', ts: Date.now() - 48 * 3600000 })
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

// Writes bytes to a fresh blob file under mediaDir and inserts its blobs
// row — the disk + row half of every reap fixture. seedAttachment layers a
// referencing event on top; reapFixture's blob B stays here, never attached
// to any event.
function seedBlob(db, mediaDir, { userId, bytes, contentType = 'application/pdf', fill = 1 }) {
  const blob = writeBlobSync(mediaDir, Buffer.alloc(bytes, fill))
  insertBlob(db, {
    id: blob.id, ownerUserId: userId, contentType,
    size: blob.size, sha256: blob.sha256, diskPath: blob.diskPath,
  })
  return blob
}

// Seeds a real blob on disk + its blobs row + a file/image event referencing
// it (both events.blob_ref and payload.blob_ref, mirroring ws.js sends).
function seedAttachment(db, mediaDir, { userId, convoId = 'c1', type = 'file', name = 'doc.pdf', bytes = 100, daysAgo = 0, caption }) {
  const blob = seedBlob(db, mediaDir, { userId, bytes, contentType: 'application/pdf' })
  const payload = { blob_ref: blob.id, name, content_type: 'application/pdf', size: bytes }
  if (caption) payload.caption = caption
  const r = append(db, { userId, convoId, sender: 'user:alice', type, payload, blobRef: blob.id })
  if (daysAgo) backdate(db, r.seq, userId, daysAgo)
  return { blob, seq: r.seq }
}

// Shared base for tests that need real quota pressure without hand-tuning
// four attachments: one user, a media dir, and blob A (a 500-byte image
// event — a genuine reap candidate) sized against quota=1000/highPct=50/
// lowPct=10 so reaping A alone clears the high-water mark back under
// target. Callers add more blobs (e.g. a comment-only B) before calling
// runReapMedia(db, { quotaBytes: quota, highPct: 50, lowPct: 10 }).
async function reapFixture() {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const a = seedAttachment(db, mediaDir, { userId: alice.id, type: 'image', bytes: 500, daysAgo: 10 })
  const b = seedBlob(db, mediaDir, { userId: alice.id, bytes: 50, contentType: 'image/png', fill: 3 })
  return { db, alice, mediaDir, blobA: a.blob.id, blobB: b.id, quota: 1000 }
}

test('runReapMedia is a no-op below the high-water mark', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const a = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 400, daysAgo: 100 })
  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 0, bytesFreed: 0 })
  assert.ok(getBlob(db, a.blob.id))
  assert.ok(fs.existsSync(a.blob.diskPath))
})

test('runReapMedia reaps oldest attachments down to the low-water mark, tombstones their events, and is idempotent', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  // 4 x 300 = 1200 used, quota 1000 -> over the 900 high-water mark.
  // Oldest two must go (1200 -> 900 -> 600 <= 700 target); newest two survive.
  const oldest = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 300, daysAgo: 40, caption: 'q3 report' })
  const older = seedAttachment(db, mediaDir, { userId: alice.id, type: 'image', bytes: 300, daysAgo: 30 })
  const newer = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 300, daysAgo: 20 })
  const newest = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 300, daysAgo: 10 })

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 2, bytesFreed: 600 })

  for (const gone of [oldest, older]) {
    assert.equal(getBlob(db, gone.blob.id), undefined, 'reaped blob row must be deleted')
    assert.equal(fs.existsSync(gone.blob.diskPath), false, 'reaped blob file must be unlinked')
    const row = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(alice.id, gone.seq)
    assert.equal(row.blob_ref, null)
    const p = JSON.parse(row.payload)
    assert.equal(p.expired, true)
    assert.equal(p.blob_ref, null)
    assert.equal(p.name, 'doc.pdf', 'tombstone must keep the display name')
    assert.equal(p.size, 300, 'tombstone must keep the size')
  }
  assert.equal(JSON.parse(db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(alice.id, oldest.seq).payload).caption,
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

test('runReapMedia keeps a journal-transcribed voice note\'s words, stamped, and never carries a payload-supplied transcript_by', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const voice = (transcript, extra = {}) => {
    const blob = seedBlob(db, mediaDir, { userId: alice.id, bytes: 400, contentType: 'audio/mp4' })
    if (transcript) db.prepare("UPDATE blobs SET transcript_status='done', transcript=?, transcribed_at=? WHERE id=?").run(transcript, Date.now(), blob.id)
    const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'user:alice', type: 'file', payload: { blob_ref: blob.id, name: 'V.m4a', content_type: 'audio/mp4', size: 400, ...extra }, blobRef: blob.id })
    backdate(db, r.seq, alice.id, 50)
    return r.seq
  }
  const heard = voice('what the user said', { transcript_by: 'journal' })
  const local = voice(null, { transcript_by: 'journal', transcript: 'client text' })
  seedAttachment(db, mediaDir, { userId: alice.id, bytes: 300, daysAgo: 1 })
  runReapMedia(db, { quotaBytes: 1000, highPct: 50, lowPct: 10 })
  const a = JSON.parse(db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(alice.id, heard).payload)
  assert.equal(a.expired, true)
  assert.equal(a.transcript, 'what the user said')
  assert.equal(a.transcript_by, 'journal')
  const b = JSON.parse(db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(alice.id, local).payload)
  assert.equal(b.expired, true)
  assert.equal(b.transcript, 'client text')
  assert.equal(b.transcript_by, undefined)
})

test('runReapMedia never reaps a tool_output blob, even when it is the oldest', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  // Tool blob (100, oldest) + two attachments (500 each). used = 1100 >= 900
  // high water; un-reapable floor is only 100, so reaping proceeds — and must
  // take the oldest ATTACHMENT, never the older tool blob. One reap gets to
  // 600 <= 700 target.
  const tool = seedToolBlob(db, mediaDir, { userId: alice.id, bytes: 100, daysAgo: 90 })
  const fileA = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 500, daysAgo: 40 })
  const fileB = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 500, daysAgo: 10 })

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 1, bytesFreed: 500 })
  assert.ok(getBlob(db, tool.blob.id), 'tool_output blob must survive quota pressure')
  assert.ok(fs.existsSync(tool.blob.diskPath))
  assert.equal(getBlob(db, fileA.blob.id), undefined, 'oldest attachment must be the one reaped')
  assert.ok(getBlob(db, fileB.blob.id))
})

test('runReapMedia refuses to reap when the un-reapable floor alone keeps the user above target', async (t) => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  // Tool blob 800 + attachment 300: used = 1100 >= 900 high water, but the
  // un-reapable floor (800) already exceeds the 700 target — reaping every
  // attachment could never reach it. The pass must skip the user with a warn
  // and delete NOTHING (the old behaviour ground through every attachment,
  // including brand-new ones, every tick, forever).
  const tool = seedToolBlob(db, mediaDir, { userId: alice.id, bytes: 800, daysAgo: 90 })
  const file = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 300, daysAgo: 5 })
  // An attachment-type event pointing at the tool blob must not make it
  // reapable either (its tool_output reference wins).
  const mixed = append(db, {
    userId: alice.id, convoId: 'c1', sender: 'user:alice', type: 'file',
    payload: { blob_ref: tool.blob.id, name: 'weird.json', content_type: 'application/json', size: 800 }, blobRef: tool.blob.id,
  })
  backdate(db, mixed.seq, alice.id, 89)

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
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  // ws.js passes msg.blob_ref through unvalidated on text sends — a
  // caption-style text event referencing the attachment's blob must not
  // exempt that blob from the reaper (only tool_output references pin).
  const file = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 950, daysAgo: 10 })
  const textRef = append(db, {
    userId: alice.id, convoId: 'c1', sender: 'user:alice', type: 'text',
    payload: { body: 'see attached', blob_ref: file.blob.id }, blobRef: file.blob.id,
  })

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 1, bytesFreed: 950 })
  assert.equal(getBlob(db, file.blob.id), undefined)
  assert.equal(JSON.parse(db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(alice.id, file.seq).payload).expired, true)
  // The text event is not an attachment: its payload must be left alone.
  const textRow = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(alice.id, textRef.seq)
  assert.equal(JSON.parse(textRow.payload).expired, undefined)
  // Its blob_ref column intentionally still names the now-deleted blob —
  // non-attachment refs are left dangling by design (nothing dereferences
  // them; a resolver would get the same 404 a stale client gets). Pin it so
  // a future change here is loud.
  assert.equal(textRow.blob_ref, file.blob.id)
})

test("runReapMedia never rewrites another user's event referencing the reaped blob", async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const elm = await createUser(db, 'elm', 'pw')
  upsertConversation(db, { id: 'cb', ownerUserId: elm.id })
  const file = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 950, daysAgo: 10 })
  // Pathological cross-user reference (blob ids are unguessable in practice):
  // elm's event points at alice's blob. Reaping alice's blob must not touch
  // elm's payload, and elm's newer event must not influence alice's reap order.
  const bevs = append(db, {
    userId: elm.id, convoId: 'cb', sender: 'user:elm', type: 'file',
    payload: { blob_ref: file.blob.id, name: 'not-mine.pdf', size: 950, note: 'elm private' }, blobRef: file.blob.id,
  })

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 1, bytesFreed: 950 })
  assert.equal(getBlob(db, file.blob.id), undefined)
  const elmRow = db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(elm.id, bevs.seq)
  const elmPayload = JSON.parse(elmRow.payload)
  assert.equal(elmPayload.expired, undefined, "another user's event must never be tombstoned")
  assert.equal(elmPayload.note, 'elm private')
})

test('runReapMedia skips loudly on an invalid quota instead of selecting everything', async (t) => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const file = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 950, daysAgo: 10 })
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
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  // An upload sits orphaned between POST /media and the ws send that attaches
  // it — reaping it would corrupt an in-flight attachment. Today the
  // exclusion is structural (candidates join through events), so this test
  // is a regression tripwire for any rewrite that scans the blobs table
  // directly.
  const orphan = writeBlobSync(mediaDir, Buffer.alloc(600, 3))
  insertBlob(db, {
    id: orphan.id, ownerUserId: alice.id, contentType: 'image/png',
    size: orphan.size, sha256: orphan.sha256, diskPath: orphan.diskPath,
  })
  const file = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 600, daysAgo: 10 })

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 1, bytesFreed: 600 })
  assert.ok(getBlob(db, orphan.id), 'orphan blob must not be reaped')
  assert.ok(fs.existsSync(orphan.diskPath))
  assert.equal(getBlob(db, file.blob.id), undefined)
})

// Orphans split by age. A FRESH orphan is an upload between POST /media and
// the send/comment that attaches it — never touched. An orphan older than the
// grace period is garbage nobody can reach (no event, no item comment names
// it: a send that failed after the upload, a retried upload) — reaped FIRST,
// before any attachment the user can still see, with no tombstone to write.
test('runReapMedia reaps an orphan upload older than the grace period before any visible attachment', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  // Attachment 500 (10 days) + aged orphan 600 (2 days): used 1100 >= 900
  // high water; dropping the orphan alone reaches 500 <= 700 target, so the
  // attachment — older than the orphan — must survive.
  const file = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 500, daysAgo: 10 })
  const orphan = seedBlob(db, mediaDir, { userId: alice.id, bytes: 600, contentType: 'image/png', fill: 4 })
  db.prepare('UPDATE blobs SET created_at=? WHERE id=?').run(Date.now() - 2 * 86400000, orphan.id)

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 1, bytesFreed: 600 })
  assert.equal(getBlob(db, orphan.id), undefined, 'aged orphan must be reaped')
  assert.equal(fs.existsSync(orphan.diskPath), false, 'aged orphan file must be unlinked')
  assert.ok(getBlob(db, file.blob.id), 'a visible attachment must outlive garbage')
  assert.equal(JSON.parse(db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(alice.id, file.seq).payload).expired, undefined)
})

test('runReapMedia keeps a fresh orphan whatever the pressure, and names the floor when it blocks the pass', async (t) => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  // Tool blob 750 (never a candidate) + fresh orphan 50 (in flight) + chat
  // attachment 300 (5 days): used 1100 >= 900, but the un-reapable floor
  // (800) is above the 700 target. The pass must refuse, delete nothing,
  // and say WHAT the floor is made of — the old line blamed "tool logs /
  // in-flight uploads" for 1.6 GB that was neither.
  const tool = seedToolBlob(db, mediaDir, { userId: alice.id, bytes: 750, daysAgo: 90 })
  const fresh = seedBlob(db, mediaDir, { userId: alice.id, bytes: 50, contentType: 'image/png', fill: 6 })
  const file = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 300, daysAgo: 5 })

  const warns = []
  const mute = t.mock.method(console, 'warn', (...a) => { warns.push(a.join(' ')) })
  t.after(() => mute.mock.restore())
  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 0, bytesFreed: 0 })
  for (const kept of [tool.blob, fresh]) {
    assert.ok(getBlob(db, kept.id), 'tool blob and fresh orphan must both survive')
    assert.ok(fs.existsSync(kept.diskPath))
  }
  assert.ok(getBlob(db, file.blob.id), 'no attachment may be sacrificed to an unreachable target')
  const warn = warns.find((w) => w.includes('un-reapable'))
  assert.ok(warn, 'skip must be loud')
  assert.match(warn, /800 are un-reapable/)
  assert.match(warn, /750 in tool logs/)
  assert.match(warn, /50 in uploads under 24h old/)
})

test('runReapMedia tombstones every event referencing a shared blob, deleting the blob once', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  upsertConversation(db, { id: 'c2', ownerUserId: alice.id })
  const first = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 1000, daysAgo: 30 })
  const second = append(db, {
    userId: alice.id, convoId: 'c2', sender: 'user:alice', type: 'file',
    payload: { blob_ref: first.blob.id, name: 'doc.pdf', content_type: 'application/pdf', size: 1000 }, blobRef: first.blob.id,
  })
  backdate(db, second.seq, alice.id, 29)

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 1, bytesFreed: 1000 })
  for (const seq of [first.seq, second.seq]) {
    const row = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(alice.id, seq)
    assert.equal(row.blob_ref, null)
    assert.equal(JSON.parse(row.payload).expired, true)
  }
  assert.equal(getBlob(db, first.blob.id), undefined)
})

test('runReapMedia only reaps users over the high-water mark', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const elm = await createUser(db, 'elm', 'pw')
  upsertConversation(db, { id: 'cb', ownerUserId: elm.id })
  const alicesFile = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 950, daysAgo: 10 })
  const bevsFile = seedAttachment(db, mediaDir, { userId: elm.id, convoId: 'cb', bytes: 400, daysAgo: 100 })

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 1, bytesFreed: 950 })
  assert.equal(getBlob(db, alicesFile.blob.id), undefined)
  assert.ok(getBlob(db, bevsFile.blob.id), "an under-quota user's attachments must be untouched")
})

test('runReapMedia tolerates a blob file already missing on disk', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const file = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 950, daysAgo: 10 })
  fs.unlinkSync(file.blob.diskPath)

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 1, bytesFreed: 950 })
  assert.equal(getBlob(db, file.blob.id), undefined)
  const row = db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(alice.id, file.seq)
  assert.equal(JSON.parse(row.payload).expired, true)
  assert.equal(row.blob_ref, null)
})

test('media reap treats an item-thread attachment like a chat one: oldest goes first, the entry becomes a tombstone that keeps blob_ref and transcript', async () => {
  // Alice, 2026-10-02 (tracker question "may the reaper prune your oldest
  // item-thread attachments as well as chat ones?"): "Reap items too".
  // reapFixture: blob A (500, image event, 10 days) is the only chat
  // candidate; blob B (50) is attached to an item comment and backdated to
  // 20 days, so it is the OLDEST attachment and must go first. 550 used,
  // quota 1000 / high 50% / low 10%: B alone leaves 500 > 100, so A goes
  // too; the fixture's target is only reachable by reaping both.
  const { db, alice, blobA, blobB, mediaDir, quota } = await reapFixture()
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, title: 'T' })
  const it = createItem(db, { userId: alice.id, kind: 'task', title: 'T', originConvoId: 'c1', originDeviceId: 1, createdBy: 'agent' }).item
  const c = addComment(db, { userId: alice.id, itemId: it.id, author: 'user', deviceId: 1, body: '', attachments: [{ blob_ref: blobB, mime: 'audio/mp4', name: 'v.m4a', size: 50, transcript: 'keep these words' }] }).comment
  db.prepare('UPDATE item_comments SET created_at=? WHERE id=?').run(Date.now() - 20 * 86400000, c.id)
  const updatedAt = db.prepare('SELECT updated_at FROM items WHERE id=?').get(it.id).updated_at

  // Quota 1000, high 50 → 500, low 10 → 100: both must go, B first.
  const r = runReapMedia(db, { quotaBytes: quota, highPct: 50, lowPct: 10 })
  assert.deepEqual(r, { reaped: 2, bytesFreed: 550 })
  assert.equal(getBlob(db, blobB), undefined, 'the item attachment (oldest) must be reaped')
  assert.equal(getBlob(db, blobA), undefined)
  const [entry] = JSON.parse(db.prepare('SELECT attachments FROM item_comments WHERE id=?').get(c.id).attachments)
  assert.equal(entry.expired, true)
  assert.equal(entry.blob_ref, blobB, 'blob_ref stays a string: the apps decode it as required')
  assert.equal(entry.transcript, 'keep these words')
  assert.equal(entry.name, 'v.m4a'); assert.equal(entry.size, 50)
  assert.equal(db.prepare('SELECT updated_at FROM items WHERE id=?').get(it.id).updated_at, updatedAt, 'reaping must not resurface the item')
  void mediaDir
})

test('media reap order interleaves chat and item attachments by age, and stops at the target', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, title: 'T' })
  const it = createItem(db, { userId: alice.id, kind: 'task', title: 'T', originConvoId: 'c1', originDeviceId: 1, createdBy: 'agent' }).item
  const itemBlob = (days) => {
    const b = seedBlob(db, mediaDir, { userId: alice.id, bytes: 300, contentType: 'image/png', fill: 9 })
    const c = addComment(db, { userId: alice.id, itemId: it.id, author: 'user', deviceId: 1, body: '', attachments: [{ blob_ref: b.id, mime: 'image/png', name: 's.png', size: 300 }] }).comment
    db.prepare('UPDATE item_comments SET created_at=? WHERE id=?').run(Date.now() - days * 86400000, c.id)
    return b
  }
  // 1200 used, quota 1000: oldest two go (1200 → 900 → 600 <= 700).
  const chatOldest = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 300, daysAgo: 40 })
  const itemOlder = itemBlob(30)
  const chatNewer = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 300, daysAgo: 20 })
  const itemNewest = itemBlob(10)

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 2, bytesFreed: 600 })
  assert.equal(getBlob(db, chatOldest.blob.id), undefined)
  assert.equal(getBlob(db, itemOlder.id), undefined)
  assert.ok(getBlob(db, chatNewer.blob.id))
  assert.ok(getBlob(db, itemNewest.id))
})

test('media reap of a blob both a chat event and an item comment name tombstones both and deletes it once', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, title: 'T' })
  const file = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 950, daysAgo: 10 })
  const it = createItem(db, { userId: alice.id, kind: 'task', title: 'T', originConvoId: 'c1', originDeviceId: 1, createdBy: 'agent' }).item
  const c = addComment(db, { userId: alice.id, itemId: it.id, author: 'user', deviceId: 1, body: '', attachments: [{ blob_ref: file.blob.id, mime: 'application/pdf', name: 'doc.pdf', size: 950 }] }).comment

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 1, bytesFreed: 950 })
  assert.equal(getBlob(db, file.blob.id), undefined)
  assert.equal(JSON.parse(db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(alice.id, file.seq).payload).expired, true)
  assert.equal(JSON.parse(db.prepare('SELECT attachments FROM item_comments WHERE id=?').get(c.id).attachments)[0].expired, true)
})

test("media reap never rewrites another user's item comment naming the reaped blob", async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const elm = await createUser(db, 'elm', 'pw')
  upsertConversation(db, { id: 'cb', ownerUserId: elm.id })
  const file = seedAttachment(db, mediaDir, { userId: alice.id, bytes: 950, daysAgo: 10 })
  const elmItem = createItem(db, { userId: elm.id, kind: 'task', title: 'B', originConvoId: 'cb', originDeviceId: 1, createdBy: 'agent' }).item
  const elmC = addComment(db, { userId: elm.id, itemId: elmItem.id, author: 'user', deviceId: 1, body: '', attachments: [{ blob_ref: file.blob.id, mime: 'application/pdf', name: 'x.pdf', size: 950 }] }).comment

  const r = runReapMedia(db, { quotaBytes: 1000 })
  assert.deepEqual(r, { reaped: 1, bytesFreed: 950 })
  assert.equal(JSON.parse(db.prepare('SELECT attachments FROM item_comments WHERE id=?').get(elmC.id).attachments)[0].expired, undefined)
})

// ---------------------------------------------------------------------------
// runExpireVoiceNotes — audio goes 7 days after its transcript landed
// (MATRON_VOICE_NOTE_TTL_DAYS, default 7). The words stay; only the bytes go.
// ---------------------------------------------------------------------------

const DAY = 86400000

// An item comment carrying one audio attachment (+ optional extras), its
// blob real on disk. `transcribedDaysAgo` stamps the transcript the way
// setAttachmentTranscript does; `commentDaysAgo` backdates the comment row
// (the fallback age for pre-stamp rows).
function seedVoiceNote(db, mediaDir, { userId, bytes = 100, mime = 'audio/mp4', transcript = 'hello', transcribedDaysAgo = null, commentDaysAgo = 0, extras = [], stamp = true }) {
  upsertConversation(db, { id: 'c1', ownerUserId: userId, title: 'T' })
  const it = createItem(db, { userId, kind: 'task', title: 'T', originConvoId: 'c1', originDeviceId: 1, createdBy: 'agent' }).item
  const blob = seedBlob(db, mediaDir, { userId, bytes, contentType: mime, fill: 7 })
  const c = addComment(db, { userId, itemId: it.id, author: 'user', deviceId: 1, body: '', attachments: [{ blob_ref: blob.id, mime, name: 'Voice 1.m4a', size: bytes }, ...extras] }).comment
  if (commentDaysAgo) db.prepare('UPDATE item_comments SET created_at=? WHERE id=?').run(Date.now() - commentDaysAgo * DAY, c.id)
  if (transcript !== null) {
    const now = transcribedDaysAgo == null ? Date.now() : Date.now() - transcribedDaysAgo * DAY
    setAttachmentTranscript(db, { userId, itemId: it.id, commentId: c.id, blobRef: blob.id, transcript, now })
    if (!stamp) {
      // A row from before transcribed_at existed: strip the stamp again.
      const atts = JSON.parse(db.prepare('SELECT attachments FROM item_comments WHERE id=?').get(c.id).attachments)
      for (const a of atts) delete a.transcribed_at
      db.prepare('UPDATE item_comments SET attachments=? WHERE id=?').run(JSON.stringify(atts), c.id)
    }
  }
  const updatedAt = db.prepare('SELECT updated_at FROM items WHERE id=?').get(it.id).updated_at
  return { item: it, comment: c, blob, updatedAt }
}

const attachmentsOf = (db, commentId) => JSON.parse(db.prepare('SELECT attachments FROM item_comments WHERE id=?').get(commentId).attachments)

test('setAttachmentTranscript and finishAttachmentTranscript stamp transcribed_at', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const v = seedVoiceNote(db, mediaDir, { userId: alice.id, transcript: 'hello', transcribedDaysAgo: 0 })
  const [a] = attachmentsOf(db, v.comment.id)
  assert.equal(a.transcript, 'hello')
  assert.ok(Number.isInteger(a.transcribed_at) && Date.now() - a.transcribed_at < 5000, 'stamp must be the write time')

  const w = seedVoiceNote(db, mediaDir, { userId: alice.id, transcript: null })
  const pending = attachmentsOf(db, w.comment.id).map((x) => ({ ...x, transcript_status: 'pending' }))
  db.prepare('UPDATE item_comments SET attachments=? WHERE id=?').run(JSON.stringify(pending), w.comment.id)
  finishAttachmentTranscript(db, { commentId: w.comment.id, blobRef: w.blob.id, transcript: 'from whisper', now: 1234567 })
  const [b] = attachmentsOf(db, w.comment.id)
  assert.equal(b.transcript, 'from whisper')
  assert.equal(b.transcribed_at, 1234567)
  // A failed attempt is not a transcription: no stamp.
  const x = seedVoiceNote(db, mediaDir, { userId: alice.id, transcript: null })
  db.prepare('UPDATE item_comments SET attachments=? WHERE id=?').run(JSON.stringify(attachmentsOf(db, x.comment.id).map((y) => ({ ...y, transcript_status: 'pending' }))), x.comment.id)
  finishAttachmentTranscript(db, { commentId: x.comment.id, blobRef: x.blob.id, transcript: '', now: 99 })
  assert.equal(attachmentsOf(db, x.comment.id)[0].transcribed_at, undefined)
})

test('runExpireVoiceNotes deletes audio transcribed more than `days` ago, keeps the words, and is idempotent', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const old = seedVoiceNote(db, mediaDir, { userId: alice.id, bytes: 300, transcribedDaysAgo: 8 })
  const young = seedVoiceNote(db, mediaDir, { userId: alice.id, bytes: 300, transcribedDaysAgo: 6 })

  const r = runExpireVoiceNotes(db, { days: 7 })
  assert.deepEqual(r, { expired: 1, bytesFreed: 300 })
  assert.equal(getBlob(db, old.blob.id), undefined, 'blob row must go')
  assert.equal(fs.existsSync(old.blob.diskPath), false, 'file must be unlinked')
  const [a] = attachmentsOf(db, old.comment.id)
  assert.equal(a.expired, true)
  assert.equal(a.transcript, 'hello', 'the words stay')
  assert.equal(a.blob_ref, old.blob.id, 'blob_ref stays a string: the apps decode it as required')
  assert.equal(a.mime, 'audio/mp4'); assert.equal(a.name, 'Voice 1.m4a'); assert.equal(a.size, 300)
  assert.equal(db.prepare('SELECT updated_at FROM items WHERE id=?').get(old.item.id).updated_at, old.updatedAt, 'expiry must not resurface the item')
  // listComments still parses the row and exposes the tombstone.
  const listed = listComments(db, old.item.id).find((c) => c.id === old.comment.id)
  assert.equal(listed.attachments[0].expired, true)

  assert.ok(getBlob(db, young.blob.id), 'younger than `days` must survive')
  assert.equal(attachmentsOf(db, young.comment.id)[0].expired, undefined)

  assert.deepEqual(runExpireVoiceNotes(db, { days: 7 }), { expired: 0, bytesFreed: 0 }, 'second run is a no-op')
})

test('runExpireVoiceNotes falls back to the comment time for rows stamped before transcribed_at existed', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const legacyOld = seedVoiceNote(db, mediaDir, { userId: alice.id, stamp: false, commentDaysAgo: 30 })
  const legacyYoung = seedVoiceNote(db, mediaDir, { userId: alice.id, stamp: false, commentDaysAgo: 2 })
  // Stamp beats comment age: an old comment transcribed yesterday keeps its audio.
  const lateTranscript = seedVoiceNote(db, mediaDir, { userId: alice.id, commentDaysAgo: 30, transcribedDaysAgo: 1 })

  const r = runExpireVoiceNotes(db, { days: 7 })
  assert.deepEqual(r, { expired: 1, bytesFreed: 100 })
  assert.equal(getBlob(db, legacyOld.blob.id), undefined)
  assert.ok(getBlob(db, legacyYoung.blob.id))
  assert.ok(getBlob(db, lateTranscript.blob.id))
})

test('runExpireVoiceNotes never touches audio without a successful transcript, nor non-audio attachments', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const untranscribed = seedVoiceNote(db, mediaDir, { userId: alice.id, transcript: null, commentDaysAgo: 40 })
  const pending = seedVoiceNote(db, mediaDir, { userId: alice.id, transcript: null, commentDaysAgo: 40 })
  db.prepare('UPDATE item_comments SET attachments=? WHERE id=?').run(JSON.stringify(attachmentsOf(db, pending.comment.id).map((a) => ({ ...a, transcript_status: 'pending' }))), pending.comment.id)
  const failed = seedVoiceNote(db, mediaDir, { userId: alice.id, transcript: null, commentDaysAgo: 40 })
  db.prepare('UPDATE item_comments SET attachments=? WHERE id=?').run(JSON.stringify(attachmentsOf(db, failed.comment.id).map((a) => ({ ...a, transcript_status: 'failed', transcript: '' }))), failed.comment.id)
  const png = seedBlob(db, mediaDir, { userId: alice.id, bytes: 100, contentType: 'image/png', fill: 8 })
  const withImage = seedVoiceNote(db, mediaDir, { userId: alice.id, transcribedDaysAgo: 30, extras: [{ blob_ref: png.id, mime: 'image/png', name: 'shot.png', size: 100, transcript: 'not really' }] })

  const r = runExpireVoiceNotes(db, { days: 7 })
  assert.deepEqual(r, { expired: 1, bytesFreed: 100 })
  for (const kept of [untranscribed, pending, failed]) assert.ok(getBlob(db, kept.blob.id), 'no transcript, no deletion')
  assert.ok(getBlob(db, png.id), 'a picture is never a voice note, whatever keys it carries')
  const atts = attachmentsOf(db, withImage.comment.id)
  assert.equal(atts[0].expired, true)
  assert.equal(atts[1].expired, undefined)
})

test('runExpireVoiceNotes expires every comment naming a shared audio blob and deletes it once; a blob another user owns is left alone', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const v = seedVoiceNote(db, mediaDir, { userId: alice.id, transcribedDaysAgo: 10 })
  const twice = addComment(db, { userId: alice.id, itemId: v.item.id, author: 'user', deviceId: 1, body: '', attachments: [{ blob_ref: v.blob.id, mime: 'audio/mp4', name: 'again.m4a', size: 100 }] }).comment
  setAttachmentTranscript(db, { userId: alice.id, itemId: v.item.id, commentId: twice.id, blobRef: v.blob.id, transcript: 'hello', now: Date.now() - 9 * DAY })
  const other = await createUser(db, 'other', 'pw')
  upsertConversation(db, { id: 'cb', ownerUserId: other.id })
  const otherItem = createItem(db, { userId: other.id, kind: 'task', title: 'B', originConvoId: 'cb', originDeviceId: 1, createdBy: 'agent' }).item
  // Pathological: the other user's comment names this user's blob (ids are unguessable in practice).
  const otherC = addComment(db, { userId: other.id, itemId: otherItem.id, author: 'user', deviceId: 1, body: '', attachments: [{ blob_ref: v.blob.id, mime: 'audio/mp4', name: 'x.m4a', size: 100 }] }).comment
  setAttachmentTranscript(db, { userId: other.id, itemId: otherItem.id, commentId: otherC.id, blobRef: v.blob.id, transcript: 'mine', now: Date.now() - 9 * DAY })

  const r = runExpireVoiceNotes(db, { days: 7 })
  assert.deepEqual(r, { expired: 2, bytesFreed: 100 })
  assert.equal(getBlob(db, v.blob.id), undefined)
  assert.equal(attachmentsOf(db, v.comment.id)[0].expired, true)
  assert.equal(attachmentsOf(db, twice.id)[0].expired, true)
  assert.equal(attachmentsOf(db, otherC.id)[0].expired, undefined, "another user's comment is never rewritten")
})

test('runExpireVoiceNotes tolerates a blob file already missing on disk', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const v = seedVoiceNote(db, mediaDir, { userId: alice.id, transcribedDaysAgo: 10 })
  fs.unlinkSync(v.blob.diskPath)
  assert.deepEqual(runExpireVoiceNotes(db, { days: 7 }), { expired: 1, bytesFreed: 100 })
  assert.equal(attachmentsOf(db, v.comment.id)[0].expired, true)
})

test('MATRON_VOICE_NOTE_TTL_DAYS: default 7 runs at boot; 0 (voiceNoteTtlDays: 0) and garbage disable the pass', async (t) => {
  const { startTestServer } = await import('./helpers.js')
  const mute = t.mock.method(console, 'warn', () => {})
  t.after(() => mute.mock.restore())
  for (const [override, expectDeleted] of [[undefined, true], [0, false], [-3, false], ['soon', false], [30, false]]) {
    const dir = makeTmpDir('matron-voice-ttl-')
    const dbPath = path.join(dir, 'test.db')
    const mediaDir = resolveMediaDir(dbPath)
    const preDb = openDb(dbPath)
    const alice = await createUser(preDb, 'alice', 'pw')
    const v = seedVoiceNote(preDb, mediaDir, { userId: alice.id, transcribedDaysAgo: 10 })
    preDb.close()
    const s = await startTestServer({ dbPath, ...(override === undefined ? {} : { voiceNoteTtlDays: override }) })
    const gone = s.db.prepare('SELECT COUNT(*) n FROM blobs WHERE id=?').get(v.blob.id).n === 0
    s.close()
    assert.equal(gone, expectDeleted, `voiceNoteTtlDays=${override}`)
  }
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
  const dir = makeTmpDir('matron-reap-boot-')
  const dbPath = path.join(dir, 'test.db')
  const mediaDir = resolveMediaDir(dbPath)
  const preDb = openDb(dbPath)
  const alice = await createUser(preDb, 'alice', 'pw')
  upsertConversation(preDb, { id: 'c1', ownerUserId: alice.id })
  const old = seedAttachment(preDb, mediaDir, { userId: alice.id, bytes: 600, daysAgo: 30 })
  const fresh = seedAttachment(preDb, mediaDir, { userId: alice.id, bytes: 350, daysAgo: 1 })
  preDb.close()

  const s = await startTestServer({ dbPath, mediaUserQuotaBytes: 1000 })
  t.after(() => s.close())
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM blobs WHERE id=?').get(old.blob.id).n, 0,
    'boot reap must clear the oldest attachment for an over-quota user')
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM blobs WHERE id=?').get(fresh.blob.id).n, 1)
  const row = s.db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(alice.id, old.seq)
  assert.equal(JSON.parse(row.payload).expired, true)
})

// --- Orphan-blob reaper ---------------------------------------
// runReapMedia joins through events, so a blob nothing references (an upload
// whose send never happened, an item attachment abandoned mid-compose) was
// never a candidate for anything and lived forever. runReapOrphanBlobs is the
// age-gated sweep for exactly those.

const HOUR = 3600000

function seedAgedBlob(db, mediaDir, { userId, bytes = 100, hoursAgo = 0, contentType = 'image/png' }) {
  const b = writeBlobSync(mediaDir, Buffer.alloc(bytes, 7))
  insertBlob(db, { id: b.id, ownerUserId: userId, contentType, size: b.size, sha256: b.sha256, diskPath: b.diskPath })
  db.prepare('UPDATE blobs SET created_at=? WHERE id=?').run(Date.now() - hoursAgo * HOUR, b.id)
  return b
}

test('runReapOrphanBlobs: a fresh orphan survives the grace window, an old one is reaped (row + file)', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const fresh = seedAgedBlob(db, mediaDir, { userId: alice.id, bytes: 100, hoursAgo: 1 })
  const old = seedAgedBlob(db, mediaDir, { userId: alice.id, bytes: 300, hoursAgo: 48 })

  const r = runReapOrphanBlobs(db, { graceMs: 24 * HOUR, mediaDir })
  assert.deepEqual(r, { reaped: 1, bytesFreed: 300 })
  assert.equal(getBlob(db, old.id), undefined)
  assert.equal(fs.existsSync(old.diskPath), false)
  assert.ok(getBlob(db, fresh.id), 'an upload inside the grace window may still be attached')
  assert.ok(fs.existsSync(fresh.diskPath))

  // Idempotent: nothing left to reap.
  assert.deepEqual(runReapOrphanBlobs(db, { graceMs: 24 * HOUR, mediaDir }), { reaped: 0, bytesFreed: 0 })
})

test('runReapOrphanBlobs never reaps an old blob referenced by an item body or an item comment', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const bodyBlob = seedAgedBlob(db, mediaDir, { userId: alice.id, hoursAgo: 72 })
  const commentBlob = seedAgedBlob(db, mediaDir, { userId: alice.id, hoursAgo: 72, contentType: 'audio/webm' })
  const orphan = seedAgedBlob(db, mediaDir, { userId: alice.id, hoursAgo: 72 })
  const it = createItem(db, {
    userId: alice.id, kind: 'task', title: 'T', originConvoId: 'c1', originDeviceId: 1, createdBy: 'user',
    attachments: [{ blob_ref: bodyBlob.id, mime: 'image/png', name: 'shot', size: bodyBlob.size }],
  }).item
  addComment(db, {
    userId: alice.id, itemId: it.id, author: 'user', deviceId: 1, body: '',
    attachments: [{ blob_ref: commentBlob.id, mime: 'audio/webm', name: 'note', size: commentBlob.size }],
  })

  const r = runReapOrphanBlobs(db, { graceMs: 24 * HOUR, mediaDir })
  assert.deepEqual(r, { reaped: 1, bytesFreed: orphan.size }, 'the unreferenced one proves the pass ran')
  assert.equal(getBlob(db, orphan.id), undefined)
  assert.ok(getBlob(db, bodyBlob.id), 'item-body attachment must survive')
  assert.ok(getBlob(db, commentBlob.id), 'item-comment attachment must survive')
  assert.ok(fs.existsSync(bodyBlob.diskPath) && fs.existsSync(commentBlob.diskPath))
})

test('runReapOrphanBlobs never reaps tool_output or attachment blobs referenced by events.blob_ref', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  // A retention-offloaded tool_output payload: its blob is referenced by the column.
  const r0 = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'tool_output', payload: { snippet: 's', output: 'x'.repeat(2000) } })
  backdate(db, r0.seq, alice.id, 40)
  assert.equal(runOffload(db, { days: 30, mediaDir }).offloaded, 1)
  const toolRef = db.prepare('SELECT blob_ref FROM events WHERE user_id=? AND seq=?').get(alice.id, r0.seq).blob_ref
  db.prepare('UPDATE blobs SET created_at=? WHERE id=?').run(Date.now() - 72 * HOUR, toolRef)
  // An ordinary image send (blob_ref on the frame → the column).
  const img = seedAgedBlob(db, mediaDir, { userId: alice.id, hoursAgo: 72 })
  append(db, { userId: alice.id, convoId: 'c1', sender: 'user:alice', type: 'image', payload: { blob_ref: img.id, name: 'a.png' }, blobRef: img.id })

  assert.deepEqual(runReapOrphanBlobs(db, { graceMs: 24 * HOUR, mediaDir }), { reaped: 0, bytesFreed: 0 })
  assert.ok(getBlob(db, toolRef), 'tool_output blob must survive')
  assert.ok(getBlob(db, img.id), 'attached image blob must survive')
})

test('runReapOrphanBlobs honours a blob_ref carried only inside an event payload (column NULL)', async () => {
  // Agent publishes that put blob_ref in the payload but not on the frame
  // land with events.blob_ref NULL — the live DB holds such file/image rows,
  // and item markers mirror comment attachments the same way. A column-only
  // reference check would delete blobs the timeline still renders.
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const published = seedAgedBlob(db, mediaDir, { userId: alice.id, hoursAgo: 72 })
  const nested = seedAgedBlob(db, mediaDir, { userId: alice.id, hoursAgo: 72 })
  append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:bridge', type: 'file', payload: { blob_ref: published.id, name: 'r.pdf' } })
  append(db, { userId: alice.id, convoId: 'c1', sender: 'system', type: 'text', payload: { comment: { attachments: [{ blob_ref: nested.id }] } } })

  assert.deepEqual(runReapOrphanBlobs(db, { graceMs: 24 * HOUR, mediaDir }), { reaped: 0, bytesFreed: 0 })
  assert.ok(getBlob(db, published.id))
  assert.ok(getBlob(db, nested.id))
})

test('runReapOrphanBlobs tolerates a blob file already missing on disk (ENOENT)', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const old = seedAgedBlob(db, mediaDir, { userId: alice.id, bytes: 50, hoursAgo: 48 })
  fs.unlinkSync(old.diskPath)
  assert.deepEqual(runReapOrphanBlobs(db, { graceMs: 24 * HOUR, mediaDir }), { reaped: 1, bytesFreed: 50 })
  assert.equal(getBlob(db, old.id), undefined)
})

test('runReapOrphanBlobs keeps row and file (and counts nothing) when staging fails with a non-ENOENT error', async (t) => {
  const err = t.mock.method(console, 'error', () => {})
  t.after(() => err.mock.restore())
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const old = seedAgedBlob(db, mediaDir, { userId: alice.id, bytes: 40, hoursAgo: 48 })
  // Occupy the staging path with a non-empty directory: the rename fails
  // EISDIR (works as root too, unlike a chmod).
  const blocker = `${old.diskPath}.reaping`
  fs.mkdirSync(blocker)
  fs.writeFileSync(path.join(blocker, 'x'), 'x')
  assert.deepEqual(runReapOrphanBlobs(db, { graceMs: 24 * HOUR, mediaDir }), { reaped: 0, bytesFreed: 0 })
  assert.ok(getBlob(db, old.id), 'row kept so the next pass can retry')
  assert.ok(err.mock.calls.length >= 1)
  assert.ok(fs.existsSync(old.diskPath), 'file untouched')
  // Once the obstruction clears, the next pass finishes the job.
  fs.rmSync(blocker, { recursive: true })
  assert.deepEqual(runReapOrphanBlobs(db, { graceMs: 24 * HOUR, mediaDir }), { reaped: 1, bytesFreed: 40 })
  assert.equal(getBlob(db, old.id), undefined)
})

test('runReapOrphanBlobs restores the file when the row delete fails, so the id keeps serving', async (t) => {
  const err = t.mock.method(console, 'error', () => {})
  t.after(() => err.mock.restore())
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const old = seedAgedBlob(db, mediaDir, { userId: alice.id, bytes: 30, hoursAgo: 48 })
  db.exec("CREATE TRIGGER no_blob_delete BEFORE DELETE ON blobs BEGIN SELECT RAISE(ABORT, 'nope'); END")
  assert.deepEqual(runReapOrphanBlobs(db, { graceMs: 24 * HOUR, mediaDir }), { reaped: 0, bytesFreed: 0 })
  assert.ok(getBlob(db, old.id), 'row kept')
  assert.ok(fs.existsSync(old.diskPath), 'file restored to its original path')
  assert.equal(fs.existsSync(`${old.diskPath}.reaping`), false)
  db.exec('DROP TRIGGER no_blob_delete')
  assert.deepEqual(runReapOrphanBlobs(db, { graceMs: 24 * HOUR, mediaDir }), { reaped: 1, bytesFreed: 30 })
  assert.equal(fs.existsSync(old.diskPath), false)
})

test('a pass that crashed after the row delete committed: the next pass unlinks the stranded staged file', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const gone = seedAgedBlob(db, mediaDir, { userId: alice.id, bytes: 20, hoursAgo: 48 })
  fs.renameSync(gone.diskPath, `${gone.diskPath}.reaping`)
  db.prepare('DELETE FROM blobs WHERE id=?').run(gone.id) // committed, then crash before unlink
  runReapOrphanBlobs(db, { graceMs: 24 * HOUR, mediaDir })
  assert.equal(fs.existsSync(`${gone.diskPath}.reaping`), false, 'stranded bytes reclaimed')
})

test('a staged file whose row survived is restored even when the blob is no longer a candidate', async () => {
  // Crash after staging, then the id got attached before the next pass: the
  // file must come back to its path so GET /media serves it again.
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const b = seedAgedBlob(db, mediaDir, { userId: alice.id, bytes: 20, hoursAgo: 48 })
  fs.renameSync(b.diskPath, `${b.diskPath}.reaping`)
  append(db, { userId: alice.id, convoId: 'c1', sender: 'user:alice', type: 'image', payload: { blob_ref: b.id }, blobRef: b.id })
  assert.deepEqual(runReapOrphanBlobs(db, { graceMs: 24 * HOUR, mediaDir }), { reaped: 0, bytesFreed: 0 })
  assert.ok(fs.existsSync(b.diskPath), 'restored')
  assert.equal(fs.existsSync(`${b.diskPath}.reaping`), false)
})

test('runReapOrphanBlobs finishes a blob a crashed pass left staged', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const old = seedAgedBlob(db, mediaDir, { userId: alice.id, bytes: 20, hoursAgo: 48 })
  fs.renameSync(old.diskPath, `${old.diskPath}.reaping`) // crash between stage and delete
  assert.deepEqual(runReapOrphanBlobs(db, { graceMs: 24 * HOUR, mediaDir }), { reaped: 1, bytesFreed: 20 })
  assert.equal(getBlob(db, old.id), undefined)
  assert.equal(fs.existsSync(`${old.diskPath}.reaping`), false)
})

test('runReapOrphanBlobs never unlinks a disk_path outside mediaDir, and leaves that row alone', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  t.after(() => warn.mock.restore())
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const elsewhere = tmpMediaDir()
  const stray = seedAgedBlob(db, elsewhere, { userId: alice.id, hoursAgo: 48 })
  assert.deepEqual(runReapOrphanBlobs(db, { graceMs: 24 * HOUR, mediaDir }), { reaped: 0, bytesFreed: 0 })
  assert.ok(getBlob(db, stray.id))
  assert.ok(fs.existsSync(stray.diskPath))
  assert.ok(warn.mock.calls.length >= 1)
})

test('runReapOrphanBlobs is a loud no-op on a nonsense grace or a missing mediaDir', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  t.after(() => warn.mock.restore())
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const old = seedAgedBlob(db, mediaDir, { userId: alice.id, hoursAgo: 48 })
  for (const bad of [0, -1, NaN, undefined, 'soon', Infinity]) {
    assert.deepEqual(runReapOrphanBlobs(db, { graceMs: bad, mediaDir }), { reaped: 0, bytesFreed: 0 }, `graceMs=${bad}`)
  }
  assert.deepEqual(runReapOrphanBlobs(db, { graceMs: HOUR }), { reaped: 0, bytesFreed: 0 }, 'no mediaDir')
  assert.ok(getBlob(db, old.id))
})

test('resolveOrphanBlobGraceHours: 7-day default, override beats env, 0/garbage disable', (t) => {
  const mute = t.mock.method(console, 'warn', () => {})
  t.after(() => mute.mock.restore())
  delete process.env.MATRON_ORPHAN_BLOB_GRACE_HOURS
  assert.equal(resolveOrphanBlobGraceHours(undefined), 168, '7-day default (client outbox can resend days later)')
  assert.equal(resolveOrphanBlobGraceHours(6), 6)
  assert.equal(resolveOrphanBlobGraceHours(0), null)
  assert.equal(resolveOrphanBlobGraceHours('nope'), null)
  assert.equal(resolveOrphanBlobGraceHours(-3), null)
  process.env.MATRON_ORPHAN_BLOB_GRACE_HOURS = '72'
  assert.equal(resolveOrphanBlobGraceHours(undefined), 72)
  assert.equal(resolveOrphanBlobGraceHours(12), 12, 'override beats env')
  process.env.MATRON_ORPHAN_BLOB_GRACE_HOURS = ''
  assert.equal(resolveOrphanBlobGraceHours(undefined), null, "empty env (Number('') === 0) disables")
  delete process.env.MATRON_ORPHAN_BLOB_GRACE_HOURS
})

test('orphan-blob pass runs at boot from the retention scheduler', async (t) => {
  const { startTestServer } = await import('./helpers.js')
  const dir = makeTmpDir('matron-orphan-boot-')
  const dbPath = path.join(dir, 'test.db')
  const mediaDir = resolveMediaDir(dbPath)
  const preDb = openDb(dbPath)
  const alice = await createUser(preDb, 'alice', 'pw')
  const old = seedAgedBlob(preDb, mediaDir, { userId: alice.id, hoursAgo: 200 })
  const fresh = seedAgedBlob(preDb, mediaDir, { userId: alice.id, hoursAgo: 72 }) // inside the 7-day default
  preDb.close()

  const s = await startTestServer({ dbPath })
  t.after(() => s.close())
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM blobs WHERE id=?').get(old.id).n, 0, 'boot pass must reap the old orphan')
  assert.equal(fs.existsSync(old.diskPath), false)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM blobs WHERE id=?').get(fresh.id).n, 1)
})


// Chat voice notes the journal transcribed at upload (blob-transcripts.js):
// same 7-day rule, clocked from blobs.transcribed_at.
function seedChatVoiceNote(db, mediaDir, { userId, convoId = 'c1', bytes = 100, status = 'done', transcript = 'hello there', transcribedDaysAgo = 8 }) {
  const blob = seedBlob(db, mediaDir, { userId, bytes, contentType: 'audio/mp4', fill: 5 })
  db.prepare('UPDATE blobs SET transcript_status=?, transcript=?, transcribed_at=? WHERE id=?')
    .run(status, status === 'done' ? transcript : null, status === 'done' ? Date.now() - transcribedDaysAgo * DAY : null, blob.id)
  const payload = { blob_ref: blob.id, name: 'Voice.m4a', content_type: 'audio/mp4', size: bytes }
  const r = append(db, { userId, convoId, sender: 'user:alice', type: 'file', payload, blobRef: blob.id })
  return { blob, seq: r.seq }
}
const eventOf = (db, userId, seq) => db.prepare('SELECT payload, blob_ref FROM events WHERE user_id=? AND seq=?').get(userId, seq)

test('runExpireVoiceNotes: a chat voice note transcribed at upload goes after `days`; the event keeps its fields and gains the words', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const old = seedChatVoiceNote(db, mediaDir, { userId: alice.id, transcribedDaysAgo: 8 })
  const young = seedChatVoiceNote(db, mediaDir, { userId: alice.id, transcribedDaysAgo: 2 })
  const r = runExpireVoiceNotes(db, { days: 7 })
  assert.deepEqual(r, { expired: 1, bytesFreed: 100 })
  const ev = eventOf(db, alice.id, old.seq)
  assert.equal(ev.blob_ref, null)
  assert.deepEqual(JSON.parse(ev.payload), { blob_ref: null, name: 'Voice.m4a', content_type: 'audio/mp4', size: 100, expired: true, transcript: 'hello there', transcript_by: 'journal' })
  assert.equal(getBlob(db, old.blob.id), undefined)
  assert.equal(fs.existsSync(old.blob.diskPath), false)
  assert.ok(getBlob(db, young.blob.id))
  assert.ok(fs.existsSync(young.blob.diskPath))
  assert.deepEqual(runExpireVoiceNotes(db, { days: 7 }), { expired: 0, bytesFreed: 0 }, 'second run is a no-op')
})

test('runExpireVoiceNotes: chat audio not transcribed here, failed, or shared with an item / another user / a non-attachment event stays', async () => {
  const { db, alice } = await setup()
  const pat = await createUser(db, 'pat', 'pw')
  upsertConversation(db, { id: 'p1', ownerUserId: pat.id })
  const mediaDir = tmpMediaDir()
  const failed = seedChatVoiceNote(db, mediaDir, { userId: alice.id, status: 'failed' })
  const bridgeDid = seedChatVoiceNote(db, mediaDir, { userId: alice.id, status: null })
  const shared = seedChatVoiceNote(db, mediaDir, { userId: alice.id })
  append(db, { userId: pat.id, convoId: 'p1', sender: 'user:pat', type: 'file', payload: { blob_ref: shared.blob.id }, blobRef: shared.blob.id })
  const onText = seedChatVoiceNote(db, mediaDir, { userId: alice.id })
  append(db, { userId: alice.id, convoId: 'c1', sender: 'user:alice', type: 'text', payload: { text: 'x' }, blobRef: onText.blob.id })
  const inItem = seedChatVoiceNote(db, mediaDir, { userId: alice.id })
  const it = createItem(db, { userId: alice.id, kind: 'task', title: 'T', originConvoId: 'c1', originDeviceId: 1, createdBy: 'agent' }).item
  addComment(db, { userId: alice.id, itemId: it.id, author: 'user', deviceId: 1, body: '', attachments: [{ blob_ref: inItem.blob.id, mime: 'audio/mp4', name: 'v.m4a', size: 100 }] })
  const orphan = seedBlob(db, mediaDir, { userId: alice.id, bytes: 100, contentType: 'audio/mp4', fill: 9 })
  db.prepare("UPDATE blobs SET transcript_status='done', transcript='x', transcribed_at=? WHERE id=?").run(Date.now() - 30 * DAY, orphan.id)

  assert.deepEqual(runExpireVoiceNotes(db, { days: 7 }), { expired: 0, bytesFreed: 0 })
  for (const b of [failed.blob, bridgeDid.blob, shared.blob, onText.blob, inItem.blob, orphan]) assert.ok(getBlob(db, b.id), `blob ${b.id} must stay`)
})

test('runExpireVoiceNotes: a recording in both an item thread and a chat goes on the item clock, and the chat event becomes a tombstone with the words', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const v = seedVoiceNote(db, mediaDir, { userId: alice.id, transcript: 'from the item', transcribedDaysAgo: 8 })
  const r0 = append(db, { userId: alice.id, convoId: 'c1', sender: 'user:alice', type: 'file', payload: { blob_ref: v.blob.id, name: 'Voice 1.m4a', content_type: 'audio/mp4', size: 100 }, blobRef: v.blob.id })
  const r = runExpireVoiceNotes(db, { days: 7 })
  assert.equal(r.expired, 1)
  assert.equal(getBlob(db, v.blob.id), undefined)
  const ev = eventOf(db, alice.id, r0.seq)
  assert.equal(ev.blob_ref, null)
  // The item's words (an agent may have PATCHed them) ride along, unstamped:
  // said.js never vouches for them.
  assert.deepEqual(JSON.parse(ev.payload), { blob_ref: null, name: 'Voice 1.m4a', content_type: 'audio/mp4', size: 100, expired: true, transcript: 'from the item' })
})

test('runExpireVoiceNotes: an item-and-chat recording the journal transcribed itself leaves the journal\'s words, stamped, never an agent\'s PATCH', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const v = seedVoiceNote(db, mediaDir, { userId: alice.id, transcript: 'planted by an agent', transcribedDaysAgo: 8 })
  db.prepare("UPDATE blobs SET transcript_status='done', transcript='what the user said', transcribed_at=? WHERE id=?").run(Date.now() - 8 * DAY, v.blob.id)
  const r0 = append(db, { userId: alice.id, convoId: 'c1', sender: 'user:alice', type: 'file', payload: { blob_ref: v.blob.id, name: 'Voice 1.m4a', content_type: 'audio/mp4', size: 100, transcript_by: 'journal' }, blobRef: v.blob.id })
  runExpireVoiceNotes(db, { days: 7 })
  const p = JSON.parse(eventOf(db, alice.id, r0.seq).payload)
  assert.equal(p.transcript, 'what the user said')
  assert.equal(p.transcript_by, 'journal')
})

test('tombstones: a client payload\'s own transcript_by never survives onto an unstamped tombstone', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const v = seedVoiceNote(db, mediaDir, { userId: alice.id, transcript: 'agent words', transcribedDaysAgo: 8 })
  const r0 = append(db, { userId: alice.id, convoId: 'c1', sender: 'user:alice', type: 'file', payload: { blob_ref: v.blob.id, name: 'V.m4a', content_type: 'audio/mp4', size: 100, transcript_by: 'journal' }, blobRef: v.blob.id })
  runExpireVoiceNotes(db, { days: 7 })
  assert.equal(JSON.parse(eventOf(db, alice.id, r0.seq).payload).transcript_by, undefined)
})
