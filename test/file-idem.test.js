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
import {
  makeDurableIdemStore, provablyNotCommitted, ORPHAN_RETENTION_MS,
} from '../src/file-idem.js'

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

test('an orphaned reservation re-runs only when the filesystem proves it never happened', async (t) => {
  const db = makeDb(t)
  const dir = tmp('matron-idem-fs-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const target = path.join(dir, 'never-written.txt')

  // A row left behind by a process that died mid-write.
  store(db, { bootId: 'boot-1' }).reserve('dev:k', 'fp', () => new Promise(() => {}), { op: 'write', path: target })

  let runs = 0
  const outcome = await store(db, { bootId: 'boot-2' })
    .run('dev:k', 'fp', async () => { runs += 1; return ok({ path: target, bytes: 2 }) }, { op: 'write', path: target })
  assert.equal(runs, 1, 'the target does not exist, so nothing was committed and re-running is safe')
  assert.equal(outcome.status, 200)
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

test('provablyNotCommitted proves absence only, and never guesses about delete', async (t) => {
  const dir = tmp('matron-idem-fs-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const present = path.join(dir, 'present.txt')
  const absent = path.join(dir, 'absent.txt')
  fs.writeFileSync(present, 'x')

  // mkdir -p converges, so re-running is always safe.
  assert.equal(await provablyNotCommitted({ op: 'mkdir', path: present }), true)
  assert.equal(await provablyNotCommitted({ op: 'write', path: absent }), true)
  assert.equal(await provablyNotCommitted({ op: 'write', path: present }), false)
  assert.equal(await provablyNotCommitted({ op: 'upload', path: absent }), true)
  assert.equal(await provablyNotCommitted({ op: 'upload', path: present }), false)
  // move: source intact AND destination empty is the only provable shape.
  assert.equal(await provablyNotCommitted({ op: 'move', path: present, to: absent }), true)
  assert.equal(await provablyNotCommitted({ op: 'move', path: absent, to: present }), false)
  assert.equal(await provablyNotCommitted({ op: 'move', path: present, to: present }), false)
  // delete is never provable: an existing target may be the original or a
  // replacement, and the two demand opposite actions.
  assert.equal(await provablyNotCommitted({ op: 'delete', path: present }), false)
  assert.equal(await provablyNotCommitted({ op: 'delete', path: absent }), false)
  assert.equal(await provablyNotCommitted(null), false)
})

test('the table is bounded: settled rows expire, orphans are kept far longer, and the cap refuses', async (t) => {
  const db = makeDb(t)
  let clock = 1_000_000
  const s = store(db, { ttlMs: 100, max: 2, now: () => clock })

  await s.run('dev:a', 'fp', async () => ok({ path: '/w/a' }), { op: 'mkdir', path: '/w/a' })
  await s.run('dev:b', 'fp', async () => ok({ path: '/w/b' }), { op: 'mkdir', path: '/w/b' })
  assert.equal(s.size(), 2)
  assert.throws(
    () => s.run('dev:c', 'fp', async () => ok({ path: '/w/c' }), { op: 'mkdir', path: '/w/c' }),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-store-full',
  )

  clock += 1000                                     // past the replay TTL
  await s.run('dev:c', 'fp', async () => ok({ path: '/w/c' }), { op: 'mkdir', path: '/w/c' })
  assert.equal(s.size(), 1, 'settled rows are reclaimed once they expire')

  // An orphan survives the replay TTL — it is evidence, not a cache line —
  // and is only swept at the far outer retention bound.
  store(db, { bootId: 'boot-1', now: () => clock })
    .reserve('dev:orphan', 'fp', () => new Promise(() => {}), { op: 'delete', path: '/w/x' })
  clock += 10_000
  const after = store(db, { bootId: 'boot-2', ttlMs: 100, now: () => clock })
  // A sweep runs on every reservation; the orphan must survive all of them.
  await after.run('dev:d', 'fp', async () => ok({ path: '/w/d' }), { op: 'mkdir', path: '/w/d' })
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM file_idem WHERE key='dev:orphan'").get().n, 1,
    'the orphan outlives the replay TTL',
  )
  clock += ORPHAN_RETENTION_MS + 1
  after.run('dev:sweep', 'fp', async () => ok({ path: '/w/s' }), { op: 'mkdir', path: '/w/s' })
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM file_idem WHERE key='dev:orphan'").get().n, 0,
    'and is eventually swept so a crash storm cannot wedge the table',
  )
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
