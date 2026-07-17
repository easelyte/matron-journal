import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDb, setApnsRegistration, clientDevicesForPush, listDevices, parsePushPrefs, setPushPrefs } from '../src/db.js'
import { createUser } from '../src/auth.js'

test('openDb creates schema idempotently', () => {
  const db = openDb(':memory:')
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name)
  for (const t of ['users', 'devices', 'conversations', 'events', 'user_seq']) {
    assert.ok(tables.includes(t), `missing table ${t}`)
  }
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
})

test('events PK is (user_id, seq)', () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(name, password_hash, created_at) VALUES('a','x',0)").run()
  db.prepare("INSERT INTO conversations(id, owner_user_id, created_at) VALUES('c1',1,0)").run()
  const ins = db.prepare(
    "INSERT INTO events(user_id, seq, convo_id, ts, sender, type, payload) VALUES(1,1,'c1',0,'s','text','{}')"
  )
  ins.run()
  assert.throws(() => ins.run(), /UNIQUE|PRIMARY/)
})

test('openDb migrates a pre-apns_env devices table in place (live-DB upgrade path)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-migration-'))
  const dbPath = path.join(dir, 'pre-migration.db')

  const raw = new Database(dbPath)
  raw.exec(`
    CREATE TABLE devices(
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      cursor INTEGER NOT NULL DEFAULT 0,
      apns_token TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    );
  `)
  raw.prepare(
    "INSERT INTO devices(id, user_id, kind, name, token_hash, apns_token, created_at) VALUES(1,1,'client','phone','hash','pre-existing-token',0)"
  ).run()
  raw.close()

  const db = openDb(dbPath)
  const cols = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name)
  assert.ok(cols.includes('apns_env'), 'apns_env column missing after migration')
  // Pre-existing row survives untouched, with apns_env now NULL rather than
  // the row being wiped or rebuilt.
  const row = db.prepare('SELECT apns_token, apns_env FROM devices WHERE id=1').get()
  assert.equal(row.apns_token, 'pre-existing-token')
  assert.equal(row.apns_env, null)
  db.close()

  // Re-opening again (schema already migrated) must be a no-op, not an error.
  assert.doesNotThrow(() => openDb(dbPath).close())
})

test('openDb adds parent_convo_id (+ its index) to a pre-existing conversations table in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-parent-migration-'))
  const dbPath = path.join(dir, 'pre-migration.db')

  const raw = new Database(dbPath)
  raw.exec(`
    CREATE TABLE conversations(
      id TEXT PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      session_state TEXT NOT NULL DEFAULT 'running',
      last_seq INTEGER NOT NULL DEFAULT 0,
      unread_count INTEGER NOT NULL DEFAULT 0,
      snippet TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `)
  raw.prepare(
    "INSERT INTO conversations(id, owner_user_id, title, created_at) VALUES('c1',1,'legacy',0)"
  ).run()
  raw.close()

  const db = openDb(dbPath)
  const cols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name)
  assert.ok(cols.includes('parent_convo_id'), 'parent_convo_id column missing after migration')
  const indexes = db.prepare('PRAGMA index_list(conversations)').all().map((i) => i.name)
  assert.ok(indexes.includes('idx_conversations_parent'), 'parent index missing after migration')
  // Pre-existing row survives untouched, with parent_convo_id now NULL.
  const row = db.prepare("SELECT title, parent_convo_id FROM conversations WHERE id='c1'").get()
  assert.equal(row.title, 'legacy')
  assert.equal(row.parent_convo_id, null)
  db.close()

  // Re-opening (already migrated) is a no-op, not an error.
  assert.doesNotThrow(() => openDb(dbPath).close())
  fs.rmSync(dir, { recursive: true, force: true })
})

// WAL mitigation, openDb half (docs/wal-checkpoint-profile.md): the WAL file
// truncates back to <=4MiB on reset for every opener, but the inline
// auto-checkpoint must stay at SQLite's stock default here — only the server
// (which runs the PASSIVE-checkpoint timer) may disable it, otherwise a
// standalone opener like the admin CLI would grow the WAL unbounded during
// long one-shot runs. Asserted on a file-backed DB because :memory:
// databases silently ignore WAL mode.
test('openDb bounds the WAL file but keeps the stock auto-checkpoint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-walpragma-'))
  const db = openDb(path.join(dir, 'm.db'))
  try {
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')
    assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), 1000)
    assert.equal(db.pragma('journal_size_limit', { simple: true }), 4194304)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('push_prefs: NULL and garbage parse as all-on; setPushPrefs merges partial updates', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const dev = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','phone','h1',?)")
    .run(dan.id, Date.now())
  const deviceId = dev.lastInsertRowid

  // Column exists (migration ran) and NULL = defaults: attention/done on,
  // activity off.
  assert.deepEqual(parsePushPrefs(null), { attention: true, done: true, activity: false })
  // Garbage stored by a buggy/older writer must fail open to the defaults, not throw.
  assert.deepEqual(parsePushPrefs('not json'), { attention: true, done: true, activity: false })
  assert.deepEqual(parsePushPrefs('[1,2]'), { attention: true, done: true, activity: false })
  // A garbage value for one key falls back to that key's default alone —
  // the rest of a well-formed blob is still honored.
  assert.deepEqual(parsePushPrefs('{"attention":"nope","done":false}'), { attention: true, done: false, activity: false })

  // Explicit true/false are both honored, including turning the
  // default-off activity key back on.
  const merged1 = setPushPrefs(db, deviceId, { activity: true })
  assert.deepEqual(merged1, { attention: true, done: true, activity: true })
  const merged2 = setPushPrefs(db, deviceId, { done: false })
  assert.deepEqual(merged2, { attention: true, done: false, activity: true })

  // The stored row round-trips through parsePushPrefs — an explicit `true`
  // for a default-off key survives the round-trip, not just `false`.
  const row = db.prepare('SELECT push_prefs FROM devices WHERE id=?').get(deviceId)
  assert.deepEqual(parsePushPrefs(row.push_prefs), { attention: true, done: false, activity: true })
})

test('clientDevicesForPush and listDevices expose push_prefs', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const dev = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','phone','h2',?)")
    .run(dan.id, Date.now())
  const deviceId = dev.lastInsertRowid
  setApnsRegistration(db, deviceId, { apnsToken: 'tok', apnsEnv: 'prod' })
  setPushPrefs(db, deviceId, { attention: false })

  const pushRows = clientDevicesForPush(db, dan.id)
  assert.equal(pushRows.length, 1)
  assert.deepEqual(parsePushPrefs(pushRows[0].push_prefs), { attention: false, done: true, activity: false })

  const roster = listDevices(db, dan.id)
  assert.deepEqual(roster[0].push_prefs, { attention: false, done: true, activity: false })
})
