// Durable idempotency for the file WRITE API (loop #644).
//
// The property under test is the one the in-memory store could not hold: a
// reservation OUTLIVES the process that made it. So every test here that says
// "restart" builds a second store over the same database with a different boot
// id — a real second process, not a reconstructed object sharing this one's
// identity — and the end-to-end case at the bottom stops a real server and
// starts another on the same db and the same fixture tree.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { startTestServer } from './helpers.js'
import { createUser } from '../src/auth.js'
import { FILE_AUDIT_BASENAME } from '../src/file-audit.js'
import { FileLinkDenied, denialToStatus } from '../src/file-guard.js'
import { makeDurableIdemStore, safeToReRun, ORPHAN_RETENTION_MS } from '../src/file-idem.js'

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))

function makeDb(t) {
  const dir = tmp('matron-idem-')
  const db = openDb(path.join(dir, 'test.db'))
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return db
}

const quiet = { warn: () => {}, error: () => {} }
// Two stores over one database = two server processes over one database.
const store = (db, opts = {}) => makeDurableIdemStore({ db, log: quiet, ...opts })

const ok = (body) => ({ status: 200, body })

test('a settled outcome replays after a restart instead of re-executing', async (t) => {
  const db = makeDb(t)
  let runs = 0
  const work = async () => { runs += 1; return ok({ path: '/w/a.txt', bytes: 3 }) }

  const first = await store(db, { bootId: 'boot-1' }).run('dev:k', 'fp', work, { op: 'write', path: '/w/a.txt' })
  assert.equal(first.status, 200)
  assert.equal(runs, 1)

  // The restart the in-memory Map could not survive.
  const replay = await store(db, { bootId: 'boot-2' }).run('dev:k', 'fp', work, { op: 'write', path: '/w/a.txt' })
  assert.equal(runs, 1, 'the work must not run a second time')
  assert.deepEqual(replay, { status: 200, body: { path: '/w/a.txt', bytes: 3 } })
})

test('an upload replay keeps its content hash across a restart, so the bytes can still be checked', async (t) => {
  const db = makeDb(t)
  const hash = 'a'.repeat(64)
  await store(db, { bootId: 'boot-1' })
    .run('dev:u', 'fp', async () => ({ ...ok({ path: '/w/up.bin', bytes: 9 }), contentHash: hash }),
      { op: 'upload', path: '/w/up.bin' })

  const replay = await store(db, { bootId: 'boot-2' }).run('dev:u', 'fp', async () => {
    throw new Error('must not re-execute')
  }, { op: 'upload', path: '/w/up.bin' })
  assert.equal(replay.contentHash, hash)
})

test('a reused key carrying a different request is a conflict, across a restart too', async (t) => {
  const db = makeDb(t)
  await store(db, { bootId: 'boot-1' }).run('dev:k', 'fp-one', async () => ok({ path: '/w/a' }), { op: 'mkdir', path: '/w/a' })
  assert.throws(
    () => store(db, { bootId: 'boot-2' }).run('dev:k', 'fp-two', async () => ok({ path: '/w/b' }), { op: 'mkdir', path: '/w/b' }),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-key-conflict',
  )
})

test('concurrent retries inside one process still share a single execution', async (t) => {
  const db = makeDb(t)
  const s = store(db)
  let runs = 0
  const slow = () => new Promise((resolve) => setTimeout(() => { runs += 1; resolve(ok({ path: '/w/a' })) }, 10))

  const [a, b] = await Promise.all([
    s.run('dev:k', 'fp', slow, { op: 'mkdir', path: '/w/a' }),
    s.run('dev:k', 'fp', slow, { op: 'mkdir', path: '/w/a' }),
  ])
  assert.equal(runs, 1)
  assert.deepEqual(a, b)
})

test('a failed attempt is forgotten, so the caller can genuinely retry', async (t) => {
  const db = makeDb(t)
  const s = store(db)
  await assert.rejects(s.run('dev:k', 'fp', async () => { throw new Error('boom') }, { op: 'mkdir', path: '/w/a' }))
  assert.equal(s.size(), 0, 'a failure leaves no reservation behind')
  let retried = false
  await s.run('dev:k', 'fp', async () => { retried = true; return ok({ path: '/w/a' }) }, { op: 'mkdir', path: '/w/a' })
  assert.equal(retried, true)
})

test('the reservation is durable BEFORE the work runs, so a crash leaves evidence', async (t) => {
  const db = makeDb(t)
  const s = store(db)
  let seen = null
  await s.run('dev:k', 'fp', async () => {
    // Mid-flight: this is what a process that dies here leaves on disk.
    seen = db.prepare('SELECT state, boot_id, intent FROM file_idem WHERE key=?').get('dev:k')
    return ok({ path: '/w/a' })
  }, { op: 'mkdir', path: '/w/a' })
  assert.equal(seen.state, 'pending')
  assert.deepEqual(JSON.parse(seen.intent), { op: 'mkdir', path: '/w/a' })
})

test('an orphaned write is refused even though its target is absent', async (t) => {
  const db = makeDb(t)
  const dir = tmp('matron-idem-fs-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // An absent target used to be read as proof that nothing had been committed.
  // It is not: the write could have landed and then been deleted, and re-running
  // would resurrect content someone removed on purpose.
  const target = path.join(dir, 'never-written.txt')
  const intent = { op: 'write', path: target }

  store(db, { bootId: 'boot-1' }).reserve('dev:k', 'fp', () => new Promise(() => {}), intent)

  await assert.rejects(
    store(db, { bootId: 'boot-2' })
      .run('dev:k', 'fp', async () => { throw new Error('re-executed an unknown outcome') }, intent),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-indeterminate',
  )
})

test('an orphaned mkdir re-runs, because re-running it converges whether or not it landed', async (t) => {
  const db = makeDb(t)
  const intent = { op: 'mkdir', path: '/w/a' }
  store(db, { bootId: 'boot-1' }).reserve('dev:k', 'fp', () => new Promise(() => {}), intent)

  let runs = 0
  const outcome = await store(db, { bootId: 'boot-2' })
    .run('dev:k', 'fp', async () => { runs += 1; return ok({ path: '/w/a' }) }, intent)
  assert.equal(runs, 1)
  assert.equal(outcome.status, 200)
})

test('a recovery whose row was taken between the read and the swap refuses, rather than running a second copy', async (t) => {
  const db = makeDb(t)
  const intent = { op: 'mkdir', path: '/w/a' }
  store(db, { bootId: 'boot-1' }).reserve('dev:k', 'fp', () => new Promise(() => {}), intent)

  // The reachable race: two recoveries of one key, both having read the same
  // orphaned row. Single-threaded, the read and the swap cannot actually
  // interleave, so the other recovery is injected into the gap — ownership
  // moves after this store read the row and before its own swap runs.
  const loser = store(db, { bootId: 'boot-2' })
  const real = db.prepare.bind(db)
  db.prepare = (sql) => {
    if (sql.startsWith('UPDATE file_idem SET boot_id=')) {
      db.prepare = real
      real('UPDATE file_idem SET boot_id=? WHERE key=?').run('boot-3', 'dev:k')
    }
    return real(sql)
  }
  t.after(() => { db.prepare = real })

  await assert.rejects(
    loser.run('dev:k', 'fp', async () => { throw new Error('ran despite losing the swap') }, intent),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-indeterminate',
  )
  // Losing is not a clean slate either: the row stands, so the key stays
  // governed by whoever did win it.
  assert.equal(db.prepare('SELECT boot_id FROM file_idem WHERE key=?').get('dev:k').boot_id, 'boot-3')
})

test('an orphaned reservation whose outcome cannot be proven is refused, and stays refused', async (t) => {
  const db = makeDb(t)
  const dir = tmp('matron-idem-fs-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // A move that may or may not have happened: the source is gone and the
  // destination exists, which is equally "we did it" and "someone else did".
  const to = path.join(dir, 'dest.txt')
  fs.writeFileSync(to, 'x')
  const intent = { op: 'move', path: path.join(dir, 'src.txt'), to }

  store(db, { bootId: 'boot-1' }).reserve('dev:k', 'fp', () => new Promise(() => {}), intent)

  const after = store(db, { bootId: 'boot-2' })
  const mustNotRun = async () => { throw new Error('re-executed an unknown outcome') }
  await assert.rejects(
    after.run('dev:k', 'fp', mustNotRun, intent),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-indeterminate',
  )
  // The refusal must not clear the row: otherwise the NEXT retry would find a
  // clean slate and execute the very mutation we just refused to repeat.
  await assert.rejects(
    after.run('dev:k', 'fp', mustNotRun, intent),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-indeterminate',
  )
  assert.equal(after.size(), 1)
})

test('an indeterminate outcome answers 507, never a 409 that invites a retry', () => {
  assert.equal(denialToStatus('idem-indeterminate'), 507)
})

test('safeToReRun answers for the operation alone, never from filesystem state', () => {
  // The decision must not depend on what the tree looks like now — that is the
  // unsound inference this replaced. Same verdict whether the path is there or
  // not, so no fixture is needed and none is consulted.
  assert.equal(safeToReRun({ op: 'mkdir', path: '/w/a' }), true)
  for (const op of ['write', 'upload', 'move', 'delete']) {
    assert.equal(safeToReRun({ op, path: '/w/a', to: '/w/b' }), false, `${op} is never re-run on a guess`)
  }
  assert.equal(safeToReRun({ op: 'unknown-future-op', path: '/w/a' }), false, 'a new op defaults to refusing')
  assert.equal(safeToReRun(null), false)
  assert.equal(safeToReRun('mkdir'), false)
})

test('the table is bounded by refusing, never by discarding an unexpired guarantee', async (t) => {
  const db = makeDb(t)
  let clock = 1_000_000
  const s = store(db, { ttlMs: 100, max: 2, now: () => clock })

  await s.run('dev:a', 'fp', async () => ok({ path: '/w/a' }), { op: 'mkdir', path: '/w/a' })
  await s.run('dev:b', 'fp', async () => ok({ path: '/w/b' }), { op: 'mkdir', path: '/w/b' })
  assert.equal(s.size(), 2)

  // An unexpired settled row is not a cache line to reclaim — it IS the
  // guarantee that a retry of that key will not execute twice. Under pressure
  // the store refuses the NEW key (503, raised before any filesystem call)
  // rather than dropping a promise it already made about an old one.
  assert.throws(
    () => s.reserve('dev:c', 'fp', async () => ok({ path: '/w/c' }), { op: 'mkdir', path: '/w/c' }),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-store-full',
  )
  assert.equal(
    s.reserve('dev:a', 'fp', async () => ok({ path: '/w/a' }), { op: 'mkdir', path: '/w/a' }).replay,
    true, 'the guarantee that would have been evicted is still honoured',
  )

  // Once the window drains the room is genuinely free, and the same call works.
  clock += 10_000
  await s.run('dev:c', 'fp', async () => ok({ path: '/w/c' }), { op: 'mkdir', path: '/w/c' })
  assert.ok(s.size() <= 2, 'the store stays bounded')

  // Live work is never reclaimable either — evicting it would let a retry
  // start a second concurrent mutation of the same target.
  let release
  const held = s.reserve('dev:live', 'fp', () => new Promise((resolve) => { release = resolve }),
    { op: 'mkdir', path: '/w/live' })
  assert.equal(held.replay, false)
  await new Promise((resolve) => setTimeout(resolve, 0))   // let the factory start
  clock += 10_000                                   // far past the replay TTL
  assert.equal(
    s.reserve('dev:live', 'fp', async () => ok({ path: '/w/live' }), { op: 'mkdir', path: '/w/live' }).replay,
    true, 'a retry joins the live reservation rather than starting a second mutation',
  )
  s.reserve('dev:filler', 'fp', () => new Promise(() => {}), { op: 'mkdir', path: '/w/f' })
  assert.throws(
    () => s.reserve('dev:refused', 'fp', async () => ok({ path: '/w/r' }), { op: 'mkdir', path: '/w/r' }),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-store-full',
    'with every row live, the store refuses rather than evicting work in flight',
  )

  release(ok({ path: '/w/live' }))
  await held.promise
  // Settled entries expire, and the TTL runs from settlement.
  clock += 10_000
  assert.equal(
    s.reserve('dev:live', 'fp', async () => ok({ path: '/w/live' }), { op: 'mkdir', path: '/w/live' }).replay,
    false,
  )
})

test('an orphan outlives the replay TTL and is only swept at the far retention bound', async (t) => {
  const db = makeDb(t)
  let clock = 1_000_000
  const intent = { op: 'delete', path: '/w/x' }
  store(db, { bootId: 'boot-1', ttlMs: 100, now: () => clock })
    .reserve('dev:orphan', 'fp', () => new Promise(() => {}), intent)

  clock += 10_000                                   // far past the replay TTL
  const after = store(db, { bootId: 'boot-2', ttlMs: 100, now: () => clock })
  // A sweep runs on every reservation; the orphan must survive all of them,
  // because while it stands its key can never execute.
  await after.run('dev:other', 'fp', async () => ok({ path: '/w/o' }), { op: 'mkdir', path: '/w/o' })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM file_idem WHERE key='dev:orphan'").get().n, 1)

  // Bounded at the far end only, so a crash storm cannot wedge the table.
  clock += ORPHAN_RETENTION_MS + 1
  await after.run('dev:sweep', 'fp', async () => ok({ path: '/w/s' }), { op: 'mkdir', path: '/w/s' })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM file_idem WHERE key='dev:orphan'").get().n, 0)
})

test('an expired key is reusable for a deliberately different request', async (t) => {
  const db = makeDb(t)
  let clock = 1_000_000
  const s = store(db, { ttlMs: 100, now: () => clock })
  await s.run('dev:k', 'fp-one', async () => ok({ path: '/w/a' }), { op: 'mkdir', path: '/w/a' })
  clock += 1000
  // Past the window the key was replayable for, it is an ordinary fresh key —
  // not a permanent conflict.
  const outcome = await s.run('dev:k', 'fp-two', async () => ok({ path: '/w/b' }), { op: 'mkdir', path: '/w/b' })
  assert.deepEqual(outcome.body, { path: '/w/b' })
})

test('an orphaned reservation survives a settle that could not be recorded', async (t) => {
  const db = makeDb(t)
  const s = store(db)
  // A database that refuses the UPDATE stands in for any failure to record the
  // outcome after the mutation already happened.
  const real = db.prepare.bind(db)
  db.prepare = (sql) => (sql.startsWith('UPDATE file_idem SET state=') ? { run: () => { throw new Error('disk full') } } : real(sql))
  await s.run('dev:k', 'fp', async () => ok({ path: '/w/a' }), { op: 'mkdir', path: '/w/a' })
  db.prepare = real
  const row = db.prepare('SELECT state FROM file_idem WHERE key=?').get('dev:k')
  assert.equal(row.state, 'pending', 'the row stays pending, so the outcome reads as unknown')
})

test('a release that the database refuses does not reject into a dangling promise', async (t) => {
  const db = makeDb(t)
  const s = store(db)
  // The failed-attempt path runs inside a `.then` nobody awaits, so a throw
  // there is an unhandled rejection — which, under this runtime, ends the
  // process mid-write. A DELETE that fails must be absorbed, not raised.
  const real = db.prepare.bind(db)
  db.prepare = (sql) => (sql.startsWith('DELETE FROM file_idem WHERE key=')
    ? { run: () => { throw new Error('SQLITE_BUSY') } } : real(sql))

  let unhandled
  const onUnhandled = (err) => { unhandled = err }
  process.on('unhandledRejection', onUnhandled)
  t.after(() => { process.off('unhandledRejection', onUnhandled); db.prepare = real })

  await assert.rejects(
    s.run('dev:k', 'fp', async () => { throw new Error('the write failed') }, { op: 'mkdir', path: '/w/a' }),
    /the write failed/,
  )
  // Let any stray rejection reach the handler before asserting it did not.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(unhandled, undefined, 'the bookkeeping chain was terminated')

  db.prepare = real
  const row = db.prepare('SELECT state FROM file_idem WHERE key=?').get('dev:k')
  assert.equal(row.state, 'pending', 'the reservation it could not release reads as unknown, not as a clean slate')
})

test('dropping an unresolved reservation at the retention bound is reported, never silent', async (t) => {
  const db = makeDb(t)
  let clock = 1_000_000
  const errors = []
  const noisy = { warn: () => {}, error: (msg) => errors.push(msg) }
  const intent = { op: 'delete', path: '/w/x' }
  makeDurableIdemStore({ db, log: quiet, bootId: 'boot-1', ttlMs: 100, now: () => clock })
    .reserve('dev:orphan', 'fp', () => new Promise(() => {}), intent)

  clock += ORPHAN_RETENTION_MS + 1
  const after = makeDurableIdemStore({ db, log: noisy, bootId: 'boot-2', ttlMs: 100, now: () => clock })
  await after.run('dev:other', 'fp', async () => ok({ path: '/w/o' }), { op: 'mkdir', path: '/w/o' })

  // Past this bound the key becomes executable again, so the evidence being
  // discarded has to reach the operator rather than vanishing into a sweep.
  const dropped = errors.filter((m) => typeof m === 'string' && m.includes('retention bound'))
  assert.equal(dropped.length, 1)
  assert.match(dropped[0], /"op":"delete"/)
  assert.match(dropped[0], /\/w\/x/)
})

// ── end to end: a real server, stopped and replaced ──────────────────────────
test('a move retried across a real server restart executes exactly once', async (t) => {
  const root = tmp('matron-idem-e2e-')
  const writeRoot = path.join(root, 'writable')
  const auditDir = tmp('matron-idem-audit-')
  fs.mkdirSync(writeRoot)
  fs.writeFileSync(path.join(writeRoot, 'src.txt'), 'payload\n')
  const dbPath = path.join(tmp('matron-idem-db-'), 'journal.db')
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(auditDir, { recursive: true, force: true })
  })

  const opts = {
    dbPath,
    fileReadRoots: [root],
    fileWriteRoots: [writeRoot],
    fileEnableWrites: true,
    fileAuditDir: auditDir,
  }
  const from = path.join(writeRoot, 'src.txt')
  const to = path.join(writeRoot, 'moved.txt')
  const key = 'e2e-move-key'
  const move = (s, token) => s.http('/files/move', {
    method: 'POST', token, body: { from, to }, headers: { 'idempotency-key': key },
  })

  const first = await startTestServer(opts)
  const user = await createUser(first.db, 'op', 'pw')
  assert.ok(user)
  const login = await first.http('/login', {
    method: 'POST', body: { username: 'op', password: 'pw', device_name: 'x' },
  })
  const token = login.json.token
  const one = await move(first, token)
  assert.equal(one.status, 200)
  assert.equal(fs.existsSync(to), true)
  assert.equal(fs.existsSync(from), false)
  await first.close()

  // The client never saw that response and retries it at the new process.
  // Re-create the source: if the retry re-executes, it moves this file too and
  // the assertion below catches it.
  fs.writeFileSync(from, 'a replacement someone else put there\n')
  const second = await startTestServer(opts)
  t.after(() => second.close())
  const two = await move(second, token)

  assert.equal(two.status, 200, 'the recorded outcome replays')
  assert.deepEqual(two.json, one.json, 'byte-for-byte the first execution’s answer')
  assert.equal(
    fs.readFileSync(from, 'utf8'), 'a replacement someone else put there\n',
    'the replacement is untouched — the move did not run a second time',
  )
  assert.equal(fs.readFileSync(to, 'utf8'), 'payload\n')

  const audit = fs.readFileSync(path.join(auditDir, FILE_AUDIT_BASENAME), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.equal(
    audit.filter((row) => row.op === 'move' && row.result === 'ok').length, 1,
    'exactly one move was ever performed',
  )
})
