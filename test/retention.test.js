import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openDb, getBlob } from '../src/db.js'
import { createUser } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { runOffload } from '../src/retention.js'

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
