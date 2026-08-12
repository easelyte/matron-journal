import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { makeLinkStore } from '../src/link.js'

function tmpDbPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-link-pre-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'test.db')
}

const rowCount = (db) => db.prepare('SELECT COUNT(*) n FROM link_preapprovals').get().n

// link_preapprovals.user_id is a real FK to users(id) and openDb() runs with
// foreign_keys=ON, so every userId these tests hand to startPreapproved()
// needs a backing row (same pattern as test/db.test.js's user seeding).
function seedUsers(db, ids) {
  const insert = db.prepare('INSERT OR IGNORE INTO users(id, name, password_hash, created_at) VALUES(?,?,?,?)')
  for (const id of ids) insert.run(id, `user${id}`, 'x', 0)
}

test('db-backed startPreapproved stores a hash, not the code; claim consumes and approves', (t) => {
  const db = openDb(tmpDbPath(t))
  t.after(() => db.close())
  seedUsers(db, [7])
  const store = makeLinkStore({ db })
  const s = store.startPreapproved(7)
  assert.match(s.linkCode, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4}$/)
  assert.equal(s.expiresIn, 600)
  assert.equal(rowCount(db), 1)
  assert.equal(store.size(), 0) // nothing in the in-memory map

  // hash on disk, never the plaintext code
  const bare = s.linkCode.replace('-', '')
  const expected = crypto.createHash('sha256').update(bare).digest('hex')
  const row = db.prepare('SELECT user_id, code_hash FROM link_preapprovals').get()
  assert.equal(row.user_id, 7)
  assert.equal(row.code_hash, expected)

  const c = store.claim(s.linkCode, { deviceName: 'First Phone' })
  assert.equal(c.status, 'claimed')
  assert.match(c.claimToken, /^[0-9a-f]{64}$/)
  assert.equal(rowCount(db), 0) // consumed at claim time
  assert.deepEqual(store.poll(c.claimToken), { status: 'approved', userId: 7, deviceName: 'First Phone' })
})

test('persisted code survives a restart (fresh store on the same db file)', (t) => {
  const dbPath = tmpDbPath(t)
  const db1 = openDb(dbPath)
  seedUsers(db1, [7])
  const s = makeLinkStore({ db: db1 }).startPreapproved(7, { ttlMs: 86400000 })
  assert.equal(s.expiresIn, 86400)
  db1.close()

  const db2 = openDb(dbPath)
  t.after(() => db2.close())
  const store2 = makeLinkStore({ db: db2 })
  const c = store2.claim(s.linkCode, { deviceName: 'Handed-off Phone' })
  assert.equal(c.status, 'claimed')
  assert.equal(store2.poll(c.claimToken).status, 'approved')
})

test('second claim of the same code is not_found (single-use)', (t) => {
  const db = openDb(tmpDbPath(t))
  t.after(() => db.close())
  seedUsers(db, [7])
  const store = makeLinkStore({ db })
  const s = store.startPreapproved(7)
  assert.equal(store.claim(s.linkCode, { deviceName: 'a' }).status, 'claimed')
  assert.deepEqual(store.claim(s.linkCode, { deviceName: 'b' }), { status: 'not_found' })
})

test('expired row is not claimable; store creation sweeps it (boot sweep)', (t) => {
  const db = openDb(tmpDbPath(t))
  t.after(() => db.close())
  seedUsers(db, [7])
  const store = makeLinkStore({ db })
  const s = store.startPreapproved(7)
  db.prepare('UPDATE link_preapprovals SET expires_at = 1').run()
  assert.deepEqual(store.claim(s.linkCode, { deviceName: 'x' }), { status: 'not_found' })

  db.prepare('INSERT INTO link_preapprovals(user_id, code_hash, expires_at, created_at) VALUES(7, ?, 1, 1)')
    .run('e'.repeat(64))
  makeLinkStore({ db }) // boot sweep
  assert.equal(rowCount(db), 0)
})

test('ttlMs clamps to [1 minute, 24 hours]', (t) => {
  const db = openDb(tmpDbPath(t))
  t.after(() => db.close())
  seedUsers(db, [1, 2])
  const store = makeLinkStore({ db })
  assert.equal(store.startPreapproved(1, { ttlMs: 1 }).expiresIn, 60)
  assert.equal(store.startPreapproved(2, { ttlMs: 999 * 86400000 }).expiresIn, 86400)
})

test('cap counts live db rows; expired rows do not count', (t) => {
  const db = openDb(tmpDbPath(t))
  t.after(() => db.close())
  seedUsers(db, [1, 2, 3])
  const store = makeLinkStore({ db, maxPending: 2 })
  assert.ok(store.startPreapproved(1))
  assert.ok(store.startPreapproved(2))
  assert.equal(store.startPreapproved(3), null)
  db.prepare('UPDATE link_preapprovals SET expires_at = 1 WHERE user_id = 1').run()
  assert.ok(store.startPreapproved(3)) // expired row swept before the cap check
})

// Forcing an actual random collision between start()'s in-memory code and a
// live db row isn't practical to do deterministically (8 chars from a
// 30-char alphabet, and module-local randomCode() can't be stubbed without
// touching production code just to make it testable). Instead this proves
// *why* start()'s db-collision check matters: claim() scans in-memory
// sessions before the db, so if the two stores ever shared a code, the
// interactive session would silently shadow the db-backed one. The retry
// loop that prevents the collision in the first place is exercised the same
// way as startPreapproved's own collision loop — by construction, not by
// test (accepted in review for the same reason).
test('cross-store claim precedence: an in-memory session would shadow a same-code db row (why start() must exclude live db codes)', (t) => {
  const db = openDb(tmpDbPath(t))
  t.after(() => db.close())
  seedUsers(db, [1, 2])
  const store = makeLinkStore({ db })
  const started = store.start('starter-1', 1)

  // Manufacture the collision the retry loop exists to prevent: give a live
  // db row the exact code the interactive session already holds.
  const bareCode = started.linkCode.replace('-', '')
  const hash = crypto.createHash('sha256').update(bareCode).digest('hex')
  db.prepare('INSERT INTO link_preapprovals(user_id, code_hash, expires_at, created_at) VALUES(?,?,?,?)')
    .run(2, hash, Date.now() + 60000, Date.now())

  const c = store.claim(started.linkCode, { deviceName: 'Handoff Phone' })
  assert.equal(c.status, 'claimed')
  // If claim() had matched the preapproved db row, status would jump
  // straight to 'approved' and the row would be gone (consumed). Instead it
  // lands on the interactive session's 'claimed' (pending approve()) and the
  // db row is left untouched — proof the in-memory scan won, exactly the
  // shadowing the fix in start() prevents.
  assert.equal(store.poll(c.claimToken).status, 'pending')
  assert.equal(rowCount(db), 1)
})

test('without a db handle, startPreapproved stays in-memory (unchanged behaviour)', () => {
  const store = makeLinkStore()
  const s = store.startPreapproved(7)
  assert.equal(s.expiresIn, 600)
  assert.equal(store.size(), 1)
  const c = store.claim(s.linkCode, { deviceName: 'x' })
  assert.equal(c.status, 'claimed')
  assert.equal(store.poll(c.claimToken).status, 'approved')
})
