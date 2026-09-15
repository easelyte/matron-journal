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
import Database from 'better-sqlite3'
import { openDb } from '../src/db.js'
import { startTestServer } from './helpers.js'
import { createUser } from '../src/auth.js'
import { FILE_AUDIT_BASENAME } from '../src/file-audit.js'
import { FileLinkDenied, denialBody, denialToStatus } from '../src/file-guard.js'
import { makeDurableIdemStore, safeToReRun, ORPHAN_RETENTION_MS } from '../src/file-idem.js'

const dirs = []
process.on('exit', () => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const t_after = (d) => dirs.push(d)
const tick = () => new Promise((resolve) => setImmediate(resolve))
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))

const DEV = 7

function makeDb(t) {
  const dir = tmp('matron-idem-')
  const db = openDb(path.join(dir, 'test.db'))
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  // A reservation is bound to the device incarnation that made it, so the
  // fixture carries a real owner rather than a bare id.
  db.prepare("INSERT INTO users(id,name,password_hash,created_at) VALUES(1,'op','h',0)").run()
  addDevice(db, DEV)
  return db
}

const addDevice = (db, id, tokenHash = `h${id}`) => db
  .prepare("INSERT INTO devices(id,user_id,kind,name,token_hash,created_at) VALUES(?,1,'client',?,?,0)")
  .run(id, `dev-${id}`, tokenHash)

const quiet = { warn: () => {}, error: () => {} }
// Two stores over one database = two server processes over one database.
const store = (db, opts = {}) => {
  const s = makeDurableIdemStore({ db, log: quiet, ...opts })
  // Thin wrappers so each test reads about the property under test rather than
  // about argument order; `deviceId` is explicit only where it is the subject.
  s.reserveAs = (key, fp, factory, intent, deviceId = DEV) => s.reserve(key, fp, factory, intent, deviceId)
  s.runAs = (key, fp, factory, intent, deviceId = DEV) => s.run(key, fp, factory, intent, deviceId)
  return s
}

const ok = (body) => ({ status: 200, body })

test('a settled outcome replays after a restart instead of re-executing', async (t) => {
  const db = makeDb(t)
  let runs = 0
  const work = async () => { runs += 1; return ok({ path: '/w/a.txt', bytes: 3 }) }

  const first = await store(db, { bootId: 'boot-1' }).runAs('dev:k', 'fp', work, { op: 'write', path: '/w/a.txt' })
  assert.equal(first.status, 200)
  assert.equal(runs, 1)

  // The restart the in-memory Map could not survive.
  const replay = await store(db, { bootId: 'boot-2' }).runAs('dev:k', 'fp', work, { op: 'write', path: '/w/a.txt' })
  assert.equal(runs, 1, 'the work must not run a second time')
  assert.deepEqual(replay, { status: 200, body: { path: '/w/a.txt', bytes: 3 } })
})

test('an upload replay keeps its content hash across a restart, so the bytes can still be checked', async (t) => {
  const db = makeDb(t)
  const hash = 'a'.repeat(64)
  await store(db, { bootId: 'boot-1' })
    .runAs('dev:u', 'fp', async () => ({ ...ok({ path: '/w/up.bin', bytes: 9 }), contentHash: hash }),
      { op: 'upload', path: '/w/up.bin' })

  const replay = await store(db, { bootId: 'boot-2' }).runAs('dev:u', 'fp', async () => {
    throw new Error('must not re-execute')
  }, { op: 'upload', path: '/w/up.bin' })
  assert.equal(replay.contentHash, hash)
})

test('a reused key carrying a different request is a conflict, across a restart too', async (t) => {
  const db = makeDb(t)
  await store(db, { bootId: 'boot-1' }).runAs('dev:k', 'fp-one', async () => ok({ path: '/w/a' }), { op: 'mkdir', path: '/w/a' })
  assert.throws(
    () => store(db, { bootId: 'boot-2' }).runAs('dev:k', 'fp-two', async () => ok({ path: '/w/b' }), { op: 'mkdir', path: '/w/b' }),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-key-conflict',
  )
})

test('concurrent retries inside one process still share a single execution', async (t) => {
  const db = makeDb(t)
  const s = store(db)
  let runs = 0
  const slow = () => new Promise((resolve) => setTimeout(() => { runs += 1; resolve(ok({ path: '/w/a' })) }, 10))

  const [a, b] = await Promise.all([
    s.runAs('dev:k', 'fp', slow, { op: 'mkdir', path: '/w/a' }),
    s.runAs('dev:k', 'fp', slow, { op: 'mkdir', path: '/w/a' }),
  ])
  assert.equal(runs, 1)
  assert.deepEqual(a, b)
})

test('a failed attempt is forgotten, so the caller can genuinely retry', async (t) => {
  const db = makeDb(t)
  const s = store(db)
  await assert.rejects(s.runAs('dev:k', 'fp', async () => { throw new Error('boom') }, { op: 'mkdir', path: '/w/a' }))
  assert.equal(s.size(), 0, 'a failure leaves no reservation behind')
  let retried = false
  await s.runAs('dev:k', 'fp', async () => { retried = true; return ok({ path: '/w/a' }) }, { op: 'mkdir', path: '/w/a' })
  assert.equal(retried, true)
})

test('the reservation is durable BEFORE the work runs, so a crash leaves evidence', async (t) => {
  const db = makeDb(t)
  const s = store(db)
  let seen = null
  await s.runAs('dev:k', 'fp', async () => {
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

  store(db, { bootId: 'boot-1' }).reserveAs('dev:k', 'fp', () => new Promise(() => {}), intent)

  await assert.rejects(
    store(db, { bootId: 'boot-2' })
      .runAs('dev:k', 'fp', async () => { throw new Error('re-executed an unknown outcome') }, intent),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-indeterminate',
  )
})

test('an orphaned mkdir re-runs, because re-running it converges whether or not it landed', async (t) => {
  const db = makeDb(t)
  const intent = { op: 'mkdir', path: '/w/a' }
  store(db, { bootId: 'boot-1' }).reserveAs('dev:k', 'fp', () => new Promise(() => {}), intent)

  let runs = 0
  const outcome = await store(db, { bootId: 'boot-2' })
    .runAs('dev:k', 'fp', async () => { runs += 1; return ok({ path: '/w/a' }) }, intent)
  assert.equal(runs, 1)
  assert.equal(outcome.status, 200)
})

test('a recovery whose row was taken between the read and the swap refuses, rather than running a second copy', async (t) => {
  const db = makeDb(t)
  const intent = { op: 'mkdir', path: '/w/a' }
  store(db, { bootId: 'boot-1' }).reserveAs('dev:k', 'fp', () => new Promise(() => {}), intent)

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
    loser.runAs('dev:k', 'fp', async () => { throw new Error('ran despite losing the swap') }, intent),
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

  store(db, { bootId: 'boot-1' }).reserveAs('dev:k', 'fp', () => new Promise(() => {}), intent)

  const after = store(db, { bootId: 'boot-2' })
  const mustNotRun = async () => { throw new Error('re-executed an unknown outcome') }
  await assert.rejects(
    after.runAs('dev:k', 'fp', mustNotRun, intent),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-indeterminate',
  )
  // The refusal must not clear the row: otherwise the NEXT retry would find a
  // clean slate and execute the very mutation we just refused to repeat.
  await assert.rejects(
    after.runAs('dev:k', 'fp', mustNotRun, intent),
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

  await s.runAs('dev:a', 'fp', async () => ok({ path: '/w/a' }), { op: 'mkdir', path: '/w/a' })
  await s.runAs('dev:b', 'fp', async () => ok({ path: '/w/b' }), { op: 'mkdir', path: '/w/b' })
  assert.equal(s.size(), 2)

  // An unexpired settled row is not a cache line to reclaim — it IS the
  // guarantee that a retry of that key will not execute twice. Under pressure
  // the store refuses the NEW key (503, raised before any filesystem call)
  // rather than dropping a promise it already made about an old one.
  assert.throws(
    () => s.reserveAs('dev:c', 'fp', async () => ok({ path: '/w/c' }), { op: 'mkdir', path: '/w/c' }),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-store-full',
  )
  assert.equal(
    s.reserveAs('dev:a', 'fp', async () => ok({ path: '/w/a' }), { op: 'mkdir', path: '/w/a' }).replay,
    true, 'the guarantee that would have been evicted is still honoured',
  )

  // Once the window drains the room is genuinely free, and the same call works.
  clock += 10_000
  await s.runAs('dev:c', 'fp', async () => ok({ path: '/w/c' }), { op: 'mkdir', path: '/w/c' })
  assert.ok(s.size() <= 2, 'the store stays bounded')

  // Live work is never reclaimable either — evicting it would let a retry
  // start a second concurrent mutation of the same target.
  let release
  const held = s.reserveAs('dev:live', 'fp', () => new Promise((resolve) => { release = resolve }),
    { op: 'mkdir', path: '/w/live' })
  assert.equal(held.replay, false)
  await new Promise((resolve) => setTimeout(resolve, 0))   // let the factory start
  clock += 10_000                                   // far past the replay TTL
  assert.equal(
    s.reserveAs('dev:live', 'fp', async () => ok({ path: '/w/live' }), { op: 'mkdir', path: '/w/live' }).replay,
    true, 'a retry joins the live reservation rather than starting a second mutation',
  )
  s.reserveAs('dev:filler', 'fp', () => new Promise(() => {}), { op: 'mkdir', path: '/w/f' })
  assert.throws(
    () => s.reserveAs('dev:refused', 'fp', async () => ok({ path: '/w/r' }), { op: 'mkdir', path: '/w/r' }),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-store-full',
    'with every row live, the store refuses rather than evicting work in flight',
  )

  release(ok({ path: '/w/live' }))
  await held.promise
  // Settled entries expire, and the TTL runs from settlement.
  clock += 10_000
  assert.equal(
    s.reserveAs('dev:live', 'fp', async () => ok({ path: '/w/live' }), { op: 'mkdir', path: '/w/live' }).replay,
    false,
  )
})

test('an orphan outlives the replay TTL and is only swept at the far retention bound', async (t) => {
  const db = makeDb(t)
  let clock = 1_000_000
  const intent = { op: 'delete', path: '/w/x' }
  store(db, { bootId: 'boot-1', ttlMs: 100, now: () => clock })
    .reserveAs('dev:orphan', 'fp', () => new Promise(() => {}), intent)

  clock += 10_000                                   // far past the replay TTL
  const after = store(db, { bootId: 'boot-2', ttlMs: 100, now: () => clock })
  // A sweep runs on every reservation; the orphan must survive all of them,
  // because while it stands its key can never execute.
  await after.runAs('dev:other', 'fp', async () => ok({ path: '/w/o' }), { op: 'mkdir', path: '/w/o' })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM file_idem WHERE key='dev:orphan'").get().n, 1)

  // Bounded at the far end only, so a crash storm cannot wedge the table.
  clock += ORPHAN_RETENTION_MS + 1
  await after.runAs('dev:sweep', 'fp', async () => ok({ path: '/w/s' }), { op: 'mkdir', path: '/w/s' })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM file_idem WHERE key='dev:orphan'").get().n, 0)
})

test('an expired key is reusable for a deliberately different request', async (t) => {
  const db = makeDb(t)
  let clock = 1_000_000
  const s = store(db, { ttlMs: 100, now: () => clock })
  await s.runAs('dev:k', 'fp-one', async () => ok({ path: '/w/a' }), { op: 'mkdir', path: '/w/a' })
  clock += 1000
  // Past the window the key was replayable for, it is an ordinary fresh key —
  // not a permanent conflict.
  const outcome = await s.runAs('dev:k', 'fp-two', async () => ok({ path: '/w/b' }), { op: 'mkdir', path: '/w/b' })
  assert.deepEqual(outcome.body, { path: '/w/b' })
})

test('an orphaned reservation survives a settle that could not be recorded', async (t) => {
  const db = makeDb(t)
  const s = store(db)
  // A database that refuses the UPDATE stands in for any failure to record the
  // outcome after the mutation already happened.
  const real = db.prepare.bind(db)
  db.prepare = (sql) => (sql.startsWith('UPDATE file_idem SET state=') ? { run: () => { throw new Error('disk full') } } : real(sql))
  await s.runAs('dev:k', 'fp', async () => ok({ path: '/w/a' }), { op: 'mkdir', path: '/w/a' })
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
    s.runAs('dev:k', 'fp', async () => { throw new Error('the write failed') }, { op: 'mkdir', path: '/w/a' }),
    /the write failed/,
  )
  // Let any stray rejection reach the handler before asserting it did not.
  await tick()
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
  store(db, { bootId: 'boot-1', ttlMs: 100, now: () => clock })
    .reserveAs('dev:orphan', 'fp', () => new Promise(() => {}), intent)

  clock += ORPHAN_RETENTION_MS + 1
  const after = store(db, { log: noisy, bootId: 'boot-2', ttlMs: 100, now: () => clock })
  await after.runAs('dev:other', 'fp', async () => ok({ path: '/w/o' }), { op: 'mkdir', path: '/w/o' })

  // Past this bound the key becomes executable again, so the evidence being
  // discarded has to reach the operator rather than vanishing into a sweep.
  const dropped = errors.filter((m) => typeof m === 'string' && m.includes('retention bound'))
  assert.equal(dropped.length, 1)
  assert.match(dropped[0], /"op":"delete"/)
  assert.match(dropped[0], /\/w\/x/)
})

test('revoking a device discards what it was told, and keeps what it started', async (t) => {
  const db = makeDb(t)
  addDevice(db, 8)
  const s = store(db)

  await s.runAs('7:done-key', 'fp', async () => ok({ path: '/w/a' }), { op: 'mkdir', path: '/w/a' })
  s.reserveAs('7:pending-key', 'fp', () => new Promise(() => {}), { op: 'delete', path: '/w/x' })
  await s.runAs('8:other', 'fp', async () => ok({ path: '/w/b' }), { op: 'mkdir', path: '/w/b' }, 8)
  await tick()
  assert.equal(s.size(), 3)

  db.prepare('DELETE FROM devices WHERE id=?').run(DEV)

  // The settled row was a cached RESPONSE. devices.id is a reusable rowid, so
  // leaving it would answer a replacement with the previous incarnation's
  // result — it goes with the device.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM file_idem WHERE key='7:done-key'").get().n, 0)
  // The pending row was a live EXCLUSION record, and its work may still be
  // running. It is detached instead, and still refuses its key.
  const tombstone = db.prepare("SELECT device_id, state FROM file_idem WHERE key='7:pending-key'").get()
  assert.equal(tombstone.device_id, null, 'unowned, so it is charged to no quota')
  assert.equal(tombstone.state, 'pending')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM file_idem WHERE device_id=8').get().n, 1,
    "the other device's reservation is untouched")

  addDevice(db, DEV, 'reissued')
  // The replacement is refused on the tombstoned key rather than starting a
  // second execution of work that may still be in flight.
  assert.throws(
    () => s.runAs('7:pending-key', 'fp', async () => { throw new Error('executed against a live reservation') },
      { op: 'delete', path: '/w/x' }),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-indeterminate',
  )
  // Its own keys are unaffected — the refusal is scoped to the collision.
  assert.equal((await s.runAs('7:fresh', 'fp', async () => ok({ path: '/w/f' }),
    { op: 'mkdir', path: '/w/f' })).status, 200)
})
test('one device cannot spend another device’s reservation budget', async (t) => {
  const db = makeDb(t)
  addDevice(db, 8)
  const s = store(db, { maxPerDevice: 2 })

  // Guard denials settle as ordinary recorded outcomes, so a client aimed at a
  // path it may not touch fills its quota without writing anything at all.
  const denied = async () => { throw new FileLinkDenied('outside-scope') }
  for (const k of ['7:a', '7:b']) {
    await assert.rejects(s.runAs(k, 'fp', denied, { op: 'delete', path: '/etc/passwd' }))
  }
  // A rejected attempt releases its row, so fill the quota with settled ones.
  await s.runAs('7:c', 'fp', async () => ok({ path: '/w/c' }), { op: 'mkdir', path: '/w/c' })
  await s.runAs('7:d', 'fp', async () => ok({ path: '/w/d' }), { op: 'mkdir', path: '/w/d' })

  assert.throws(
    () => s.reserveAs('7:e', 'fp', async () => ok({ path: '/w/e' }), { op: 'mkdir', path: '/w/e' }),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-store-full',
    'the spender is the one refused',
  )
  // The whole point: everyone else still works.
  const other = await s.runAs('8:a', 'fp', async () => ok({ path: '/w/o' }), { op: 'mkdir', path: '/w/o' }, 8)
  assert.equal(other.status, 200)
})

test('losing the insert race re-reads the winner’s row instead of raising a 500', async (t) => {
  const db = makeDb(t)
  const s = store(db)
  const winner = store(db, { bootId: 'boot-winner' })

  // Two processes both find no row and both insert; the primary key lets one
  // through. The loser must treat that as "someone else has it", not as an
  // unhandled SQLITE_CONSTRAINT surfacing to the client as a 500.
  const real = db.prepare.bind(db)
  db.prepare = (sql) => {
    if (sql.includes('INSERT INTO file_idem')) {
      db.prepare = real
      winner.reserveAs('dev:k', 'fp', () => new Promise(() => {}), { op: 'mkdir', path: '/w/a' })
    }
    return real(sql)
  }
  t.after(() => { db.prepare = real })

  // The winner's row is pending under a FOREIGN boot id with no local promise,
  // so the loser resolves it the orphan way — here a converging mkdir.
  const outcome = await s.runAs('dev:k', 'fp', async () => ok({ path: '/w/a' }), { op: 'mkdir', path: '/w/a' })
  assert.equal(outcome.status, 200)
  assert.equal(s.size(), 1, 'one row, not two, and no constraint error escaped')
})

test('an unknown outcome is distinguishable on the wire from a denial that changed nothing', () => {
  // Both arrive as a 5xx with an `error` field. If they read the same, the
  // reasonable client move — assume nothing happened, retry under a fresh key
  // — is exactly how a delete runs twice.
  assert.deepEqual(denialBody('idem-indeterminate'),
    { error: 'indeterminate', outcome: 'unknown', retryable: false })
  assert.deepEqual(denialBody('outside-scope'), { error: 'denied' })
  assert.deepEqual(denialBody('audit-fail-closed'), { error: 'denied' })
  assert.notDeepEqual(denialBody('idem-indeterminate'), denialBody('audit-fail-closed'))
})

test('openDb repairs a pre-release file_idem table instead of wedging on its missing column', () => {
  const dir = tmp('matron-idem-legacy-')
  t_after(dir)
  const dbPath = path.join(dir, 'journal.db')
  // The exact state an earlier commit of this branch left behind: the table,
  // without device_id. The repair has to run BEFORE the schema exec, because
  // the schema builds an index on that column — so getting this wrong does not
  // skip the repair, it throws out of openDb and locks every opener out of the
  // database, server and admin CLI alike.
  const legacy = new Database(dbPath)
  legacy.exec(`
    CREATE TABLE file_idem(
      key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, boot_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','done')), intent TEXT,
      status INTEGER, body TEXT, content_hash TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    INSERT INTO file_idem(key,fingerprint,boot_id,state,created_at,expires_at)
      VALUES('7:stale','fp','old-boot','pending',0,0);
  `)
  legacy.close()

  const db = openDb(dbPath)
  try {
    const cols = db.prepare('PRAGMA table_info(file_idem)').all().map((c) => c.name)
    assert.ok(cols.includes('device_id'))
    assert.ok(cols.includes('gen'))
    const fk = db.prepare('PRAGMA foreign_key_list(file_idem)').all().find((r) => r.from === 'device_id')
    assert.equal(fk?.table, 'devices')
    assert.equal(fk?.on_delete, 'SET NULL')
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?")
      .get('file_idem_drop_settled_on_revoke'), 'settled rows are dropped by the revoke trigger')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM file_idem').get().n, 0,
      'the pre-release row went with the table it belonged to')
  } finally {
    db.close()
  }
})

test('a revoked device’s in-flight work keeps its key reserved, and settles only its own row', async (t) => {
  const db = makeDb(t)
  const s = store(db)

  let finishOld
  const stale = s.reserveAs('7:k', 'fp', () => new Promise((resolve) => { finishOld = resolve }),
    { op: 'move', path: '/w/old', to: '/w/dest' })
  await tick()   // the factory runs on a microtask, so let it take its resolver
  db.prepare('DELETE FROM devices WHERE id=?').run(DEV)
  addDevice(db, DEV, 'reissued')

  // The mutation is STILL RUNNING. Handing the replacement a clean slate here
  // is what executes a move twice; it is refused instead.
  assert.throws(
    () => s.runAs('7:k', 'fp', async () => { throw new Error('a second execution of live work') },
      { op: 'move', path: '/w/old', to: '/w/dest' }),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-indeterminate',
  )

  finishOld(ok({ path: '/w/dest' }))
  await stale.promise
  await tick()

  // It settled its OWN row — the detached one — and created nothing new.
  const rows = db.prepare('SELECT device_id, state FROM file_idem WHERE key=?').all('7:k')
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], { device_id: null, state: 'done' })
})
test('a revoked device’s FAILED attempt releases its key, because nothing is in flight to protect', async (t) => {
  const db = makeDb(t)
  const s = store(db)
  let failOld
  const stale = s.reserveAs('7:k', 'fp', () => new Promise((_, reject) => { failOld = reject }),
    { op: 'mkdir', path: '/w/old' })
  await tick()
  db.prepare('DELETE FROM devices WHERE id=?').run(DEV)
  addDevice(db, DEV, 'reissued')

  failOld(new Error('the old attempt failed'))
  await assert.rejects(stale.promise, /the old attempt failed/)
  await tick()

  // A rejected attempt means the mutation did NOT happen, so the tombstone has
  // nothing left to guard and the key is genuinely free again.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM file_idem WHERE key=?').get('7:k').n, 0)
  let ran = 0
  assert.equal((await s.runAs('7:k', 'fp', async () => { ran += 1; return ok({ path: '/w/new' }) },
    { op: 'mkdir', path: '/w/new' })).status, 200)
  assert.equal(ran, 1)
})
test('a pre-release table missing only the later column is repaired too', () => {
  const dir = tmp('matron-idem-legacy2-')
  t_after(dir)
  const dbPath = path.join(dir, 'journal.db')
  // This branch grew device_id in one round and gen in the next, so a dev
  // database can hold either half-built shape. Checking one column would let
  // this one through: startup would succeed and the first keyed write would
  // fail on the missing column as a bare 500.
  const legacy = new Database(dbPath)
  legacy.exec(`
    CREATE TABLE file_idem(
      key TEXT PRIMARY KEY, device_id INTEGER, fingerprint TEXT NOT NULL, boot_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','done')), intent TEXT,
      status INTEGER, body TEXT, content_hash TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
  `)
  legacy.close()

  const db = openDb(dbPath)
  try {
    assert.ok(db.prepare('PRAGMA table_info(file_idem)').all().map((c) => c.name).includes('gen'))
  } finally {
    db.close()
  }
})

test('a device revoked between authenticating and reserving is refused, not told the outcome is unknown', async (t) => {
  const db = makeDb(t)
  const s = store(db)
  // The token was valid when it was presented; the device is gone by the time
  // the reservation is written. The insert fails on the foreign key — which is
  // a DEFINITE refusal, since the work has not started. Reporting it as the
  // insert RACE would end in `idem-indeterminate`: telling a caller its
  // outcome is unknown when nothing whatsoever happened.
  db.prepare('DELETE FROM devices WHERE id=?').run(DEV)

  let ran = 0
  assert.throws(
    () => s.runAs('7:k', 'fp', async () => { ran += 1; return ok({ path: '/w/a' }) }, { op: 'mkdir', path: '/w/a' }),
    (e) => e instanceof FileLinkDenied && e.reason === 'device-revoked',
  )
  assert.equal(ran, 0, 'nothing ran')
  assert.equal(denialToStatus('device-revoked'), 403)
  assert.deepEqual(denialBody('device-revoked'), { error: 'denied' },
    'and it reads as an ordinary denial, because the filesystem really is unchanged')
})

test('a pre-release table with the right columns but the old cascade is rebuilt', () => {
  const dir = tmp('matron-idem-legacy3-')
  t_after(dir)
  const dbPath = path.join(dir, 'journal.db')
  // The nastiest of the intermediate shapes: every column present, so a
  // name-only check accepts it, but the foreign key still CASCADEs. Left
  // standing, a revoke deletes a PENDING reservation whose work is running and
  // a reused device id re-executes it.
  const legacy = new Database(dbPath)
  legacy.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE devices(
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL CHECK(kind IN ('client','agent')), name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, cursor INTEGER NOT NULL DEFAULT 0,
      apns_token TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER
    );
    CREATE TABLE file_idem(
      key TEXT PRIMARY KEY,
      device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      gen TEXT NOT NULL, fingerprint TEXT NOT NULL, boot_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','done')), intent TEXT,
      status INTEGER, body TEXT, content_hash TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
  `)
  legacy.close()

  const db = openDb(dbPath)
  try {
    const fk = db.prepare('PRAGMA foreign_key_list(file_idem)').all().find((r) => r.from === 'device_id')
    assert.equal(fk?.on_delete, 'SET NULL', 'the obsolete cascade was not preserved')
    assert.equal(db.prepare('PRAGMA table_info(file_idem)').all()
      .find((c) => c.name === 'device_id').notnull, 0, 'and the column can be detached')
  } finally {
    db.close()
  }
})

test('a reservation whose intent cannot be read refuses, and keeps its evidence', async (t) => {
  const db = makeDb(t)
  // Version skew or corruption: the row is there, but nothing can be concluded
  // from it. Deleting it would hand the next retry a clean slate for a
  // mutation that may already have happened.
  store(db, { bootId: 'boot-1' }).reserveAs('7:k', 'fp', () => new Promise(() => {}),
    { op: 'delete', path: '/w/x' })
  await tick()
  db.prepare('UPDATE file_idem SET intent=? WHERE key=?').run('{not json', '7:k')

  const after = store(db, { bootId: 'boot-2' })
  const mustNotRun = async () => { throw new Error('re-executed an unreadable reservation') }
  await assert.rejects(
    after.runAs('7:k', 'fp', mustNotRun, { op: 'delete', path: '/w/x' }),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-indeterminate',
  )
  await tick()
  assert.equal(after.size(), 1, 'the row stands, so the next retry is refused too')
  await assert.rejects(
    after.runAs('7:k', 'fp', mustNotRun, { op: 'delete', path: '/w/x' }),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-indeterminate',
  )
})

test('a stored intent that disagrees with the request cannot authorize it', async (t) => {
  const db = makeDb(t)
  // Corruption or version skew that stays VALID JSON: a pending `delete`
  // whose stored intent now reads as a `mkdir`. Deciding replay safety from
  // the stored side alone would pass it — and then run the delete factory,
  // because that is what the CURRENT request carries.
  const real = { op: 'delete', path: '/w/x' }
  store(db, { bootId: 'boot-1' }).reserveAs('7:k', 'fp', () => new Promise(() => {}), real)
  await tick()
  db.prepare('UPDATE file_idem SET intent=? WHERE key=?').run(JSON.stringify({ op: 'mkdir', path: '/w/x' }), '7:k')

  const after = store(db, { bootId: 'boot-2' })
  await assert.rejects(
    after.runAs('7:k', 'fp', async () => { throw new Error('a delete authorized by a mkdir') }, real),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-indeterminate',
  )
  await tick()
  assert.equal(after.size(), 1, 'and the evidence stands')
})

test('recovery still runs when both descriptions of the work agree', async (t) => {
  const db = makeDb(t)
  // The positive control for the check above: same op, same path, so the
  // stored reservation really does describe the factory about to run.
  const intent = { op: 'mkdir', path: '/w/a' }
  store(db, { bootId: 'boot-1' }).reserveAs('7:k', 'fp', () => new Promise(() => {}), intent)
  await tick()

  let ran = 0
  const outcome = await store(db, { bootId: 'boot-2' })
    .runAs('7:k', 'fp', async () => { ran += 1; return ok({ path: '/w/a' }) }, { op: 'mkdir', path: '/w/a' })
  assert.equal(ran, 1)
  assert.equal(outcome.status, 200)
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

test('a move that committed but was never recorded answers 507 unknown, and never moves again', async (t) => {
  const root = tmp('matron-idem-crash-')
  const writeRoot = path.join(root, 'writable')
  const auditDir = tmp('matron-idem-audit-')
  fs.mkdirSync(writeRoot)
  fs.writeFileSync(path.join(writeRoot, 'src.txt'), 'payload\n')
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(auditDir, { recursive: true, force: true })
  })

  const server = await startTestServer({
    dbPath: path.join(tmp('matron-idem-db-'), 'journal.db'),
    fileReadRoots: [root],
    fileWriteRoots: [writeRoot],
    fileEnableWrites: true,
    fileAuditDir: auditDir,
  })
  t.after(() => server.close())
  assert.ok(await createUser(server.db, 'op', 'pw'))
  const login = await server.http('/login', {
    method: 'POST', body: { username: 'op', password: 'pw', device_name: 'x' },
  })
  const token = login.json.token

  const from = path.join(writeRoot, 'src.txt')
  const to = path.join(writeRoot, 'moved.txt')
  const key = 'crash-after-commit'
  const move = () => server.http('/files/move', {
    method: 'POST', token, body: { from, to }, headers: { 'idempotency-key': key },
  })

  assert.equal((await move()).status, 200)

  // The crash this whole module exists for: the rename committed, and the
  // process died before the outcome reached the database. Reproduced by
  // returning the row to exactly that state — pending, owned by a boot that is
  // gone — with the fingerprint the real request wrote.
  server.db.prepare("UPDATE file_idem SET state='pending', boot_id='a-process-that-died'").run()
  fs.writeFileSync(from, 'a replacement someone else put there\n')

  const retry = await move()
  assert.equal(retry.status, 507)
  assert.deepEqual(retry.json, { error: 'indeterminate', outcome: 'unknown', retryable: false },
    'the client can tell this apart from a denial that changed nothing')
  assert.equal(fs.readFileSync(from, 'utf8'), 'a replacement someone else put there\n',
    'the replacement was not moved by a second execution')

  // And it stays refused: a retry must not find a clean slate on the next try.
  assert.equal((await move()).status, 507)

  const audit = fs.readFileSync(path.join(auditDir, FILE_AUDIT_BASENAME), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.equal(audit.filter((row) => row.op === 'move' && row.result === 'ok').length, 1,
    'exactly one move was ever performed')
})
