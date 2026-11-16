import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openDb, getBlob, insertBlob } from '../src/db.js'
import { createUser } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { runOffload, runReapOrphanBlobs, reapOrphanBlobsPass } from '../src/retention.js'
import { resolveOrphanBlobGraceHours } from '../src/server.js'
import { writeBlobSync, resolveMediaDir } from '../src/media.js'
import { createItem, addComment } from '../src/items.js'

const makeTmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
const tmpMediaDir = () => makeTmpDir('matron-orphan-')

async function setup() {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id })
  return { db, alice }
}

function backdate(db, seq, userId, daysAgo) {
  db.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(Date.now() - daysAgo * 86400000, userId, seq)
}

// Scheduled orphan-blob reaper: the age-gated sweep for blobs nothing
// references, with a broader reference check than the quota reaper's.

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
  // land with events.blob_ref NULL, and item markers mirror comment attachments the same way. A column-only
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

test('recovery leaves a staged file in place when its row points outside mediaDir', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  t.after(() => warn.mock.restore())
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const outsideDir = makeTmpDir('matron-outside-')
  const outside = path.join(outsideDir, 'victim')
  fs.writeFileSync(outside, 'external')
  const b = seedAgedBlob(db, mediaDir, { userId: alice.id, bytes: 20, hoursAgo: 48 })
  fs.renameSync(b.diskPath, `${b.diskPath}.reaping`)
  db.prepare('UPDATE blobs SET disk_path=? WHERE id=?').run(outside, b.id)
  runReapOrphanBlobs(db, { graceMs: 24 * HOUR, mediaDir })
  assert.ok(fs.existsSync(`${b.diskPath}.reaping`), 'staged file left in place')
  assert.equal(fs.readFileSync(outside, 'utf8'), 'external', 'external file untouched')
  assert.deepEqual(fs.readdirSync(outsideDir), ['victim'])
  assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes('outside the media dir')))
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

test('resolveOrphanBlobGraceHours: off by default, override beats env, 0/garbage disable', (t) => {
  const mute = t.mock.method(console, 'warn', () => {})
  t.after(() => mute.mock.restore())
  delete process.env.MATRON_ORPHAN_BLOB_GRACE_HOURS
  assert.equal(resolveOrphanBlobGraceHours(undefined), null, 'off unless configured')
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


async function bootWithOrphans(t, opts) {
  const { startTestServer } = await import('./helpers.js')
  delete process.env.MATRON_ORPHAN_BLOB_GRACE_HOURS
  const dir = makeTmpDir('matron-orphan-boot-')
  const dbPath = path.join(dir, 'test.db')
  const mediaDir = resolveMediaDir(dbPath)
  const preDb = openDb(dbPath)
  const alice = await createUser(preDb, 'alice', 'pw')
  const old = seedAgedBlob(preDb, mediaDir, { userId: alice.id, hoursAgo: 200 })
  const fresh = seedAgedBlob(preDb, mediaDir, { userId: alice.id, hoursAgo: 72 }) // inside a 7-day grace
  preDb.close()
  const s = await startTestServer({ dbPath, ...opts })
  t.after(() => s.close())
  const count = (id) => s.db.prepare('SELECT COUNT(*) n FROM blobs WHERE id=?').get(id).n
  return { old, fresh, count }
}

test('orphan-blob pass runs at boot from the retention scheduler when a grace is configured', async (t) => {
  const { old, fresh, count } = await bootWithOrphans(t, { orphanBlobGraceHours: 168 })
  assert.equal(count(old.id), 0, 'boot pass must reap the old orphan')
  assert.equal(fs.existsSync(old.diskPath), false)
  assert.equal(count(fresh.id), 1)
})

test('orphan-blob pass does not run when no grace is configured', async (t) => {
  const { old, fresh, count } = await bootWithOrphans(t, {})
  assert.equal(count(old.id), 1)
  assert.equal(count(fresh.id), 1)
})

test('reapOrphanBlobsPass scans in rowid ranges and still sees a payload reference written while it was paused', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const early = seedAgedBlob(db, mediaDir, { userId: alice.id, hoursAgo: 72 })
  const late = seedAgedBlob(db, mediaDir, { userId: alice.id, hoursAgo: 72 })
  const orphan = seedAgedBlob(db, mediaDir, { userId: alice.id, hoursAgo: 72 })
  // Referenced only inside a payload (blob_ref column NULL), as agent publishes are.
  append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { text: 'a', meta: { blob_ref: early.id } } })
  for (let i = 0; i < 4; i++) append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { text: `filler ${i}` } })

  const gen = reapOrphanBlobsPass(db, { graceMs: 24 * HOUR, mediaDir, scanBatchRows: 2 })
  let yields = 0
  let r = gen.next()
  // Mid-scan, a new event names `late` in its payload only.
  append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { text: 'b', meta: { blob_ref: late.id } } })
  while (!r.done) { yields += 1; r = gen.next() }
  assert.ok(yields >= 2, `the scan yielded between ranges (${yields})`)
  assert.deepEqual(r.value, { reaped: 1, bytesFreed: orphan.size })
  assert.equal(getBlob(db, orphan.id), undefined)
  assert.ok(getBlob(db, early.id))
  assert.ok(getBlob(db, late.id), 'a reference written mid-scan keeps its blob')
})

test('reapOrphanBlobsPass sees an item comment that attaches a candidate while the scan was paused', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const claimed = seedAgedBlob(db, mediaDir, { userId: alice.id, hoursAgo: 72 })
  const orphan = seedAgedBlob(db, mediaDir, { userId: alice.id, hoursAgo: 72 })
  const it = createItem(db, { userId: alice.id, kind: 'task', title: 'T', originConvoId: 'c1', originDeviceId: 1, createdBy: 'user' }).item
  for (let i = 0; i < 4; i++) append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { text: `filler ${i}`, blob_ref: 'unrelated' } })

  const gen = reapOrphanBlobsPass(db, { graceMs: 24 * HOUR, mediaDir, scanBatchRows: 2 })
  let r = gen.next()
  assert.equal(r.done, false, 'the scan has paused between ranges')
  addComment(db, {
    userId: alice.id, itemId: it.id, author: 'user', deviceId: 1, body: '',
    attachments: [{ blob_ref: claimed.id, mime: 'image/png', name: 'late', size: claimed.size }],
  })
  while (!r.done) r = gen.next()
  assert.deepEqual(r.value, { reaped: 1, bytesFreed: orphan.size })
  assert.ok(getBlob(db, claimed.id), 'a blob attached mid-scan keeps its row')
  assert.ok(fs.existsSync(claimed.diskPath))
})

test('reapOrphanBlobsPass deletes at most maxDeletes per pass, oldest first, and the next pass takes the rest', async () => {
  const { db, alice } = await setup()
  const mediaDir = tmpMediaDir()
  const oldest = seedAgedBlob(db, mediaDir, { userId: alice.id, hoursAgo: 300 })
  const middle = seedAgedBlob(db, mediaDir, { userId: alice.id, hoursAgo: 200 })
  const newest = seedAgedBlob(db, mediaDir, { userId: alice.id, hoursAgo: 100 })

  assert.deepEqual(runReapOrphanBlobs(db, { graceMs: 24 * HOUR, mediaDir, maxDeletes: 2 }), { reaped: 2, bytesFreed: oldest.size + middle.size })
  assert.equal(getBlob(db, oldest.id), undefined)
  assert.equal(getBlob(db, middle.id), undefined)
  assert.ok(getBlob(db, newest.id), 'left for the next pass')
  assert.deepEqual(runReapOrphanBlobs(db, { graceMs: 24 * HOUR, mediaDir, maxDeletes: 2 }), { reaped: 1, bytesFreed: newest.size })
})
