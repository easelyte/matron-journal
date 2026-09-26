import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDb, setApnsRegistration, clientDevicesForPush, listDevices, parsePushPrefs, setPushPrefs, upsertDeviceStatus, deviceStatuses } from '../src/db.js'
import { createUser } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { makeTmpDir } from './tmp-dir.js'

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
  const dir = makeTmpDir('matron-migration-')
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
  const dir = makeTmpDir('matron-parent-migration-')
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

test('openDb adds session_outcome to a pre-existing conversations table in place', () => {
  const dir = makeTmpDir('matron-outcome-migration-')
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
  assert.ok(cols.includes('session_outcome'), 'session_outcome column missing after migration')
  // Pre-existing row survives untouched, with session_outcome now NULL —
  // which is exactly what "this conversation has no outcome" means.
  const row = db.prepare("SELECT title, session_outcome FROM conversations WHERE id='c1'").get()
  assert.equal(row.title, 'legacy')
  assert.equal(row.session_outcome, null)
  // No CHECK constraint: the outcome vocabulary belongs to the writing bridge,
  // so a value this server has never heard of must still be storable.
  db.prepare("UPDATE conversations SET session_outcome='some-future-outcome' WHERE id='c1'").run()
  assert.equal(
    db.prepare("SELECT session_outcome FROM conversations WHERE id='c1'").get().session_outcome,
    'some-future-outcome'
  )
  db.close()

  // Re-opening (already migrated) is a no-op, not an error.
  assert.doesNotThrow(() => openDb(dbPath).close())
  fs.rmSync(dir, { recursive: true, force: true })
})

test('openDb adds agent_kind to legacy conversations and codex upserts round-trip', () => {
  const dir = makeTmpDir('matron-agent-kind-migration-')
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
    "INSERT INTO conversations(id, owner_user_id, title, created_at) VALUES('legacy',1,'pre-stamp',0)"
  ).run()
  raw.close()

  const db = openDb(dbPath)
  try {
    const cols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name)
    assert.ok(cols.includes('agent_kind'), 'agent_kind column missing after migration')

    const legacy = db.prepare("SELECT agent_kind FROM conversations WHERE id='legacy'").get()
    assert.equal(legacy.agent_kind, null)
    assert.ok(['claude', 'codex', null].includes(legacy.agent_kind))

    upsertConversation(db, { id: 'codex', ownerUserId: 1, title: 'review', agentKind: 'codex' })
    const codex = db.prepare("SELECT agent_kind FROM conversations WHERE id='codex'").get()
    assert.equal(codex.agent_kind, 'codex')
    assert.ok(['claude', 'codex', null].includes(codex.agent_kind))
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// Migration guard for the pinned-summary surface (spec: loop #554). Two
// distinct failure modes are being excluded: a cold start on a FRESH database
// (where the base CREATE TABLE has no such column, so the ALTER must run and
// must not fail) and a restart on a database that already carries it (where
// re-running the ALTER would throw "duplicate column name" and take the
// process down at boot). The live journal DB is the second case on every
// restart after the first, so re-runnability is not academic.
test('openDb adds summary_updated_at to legacy conversations, is re-runnable, and cold-starts fresh', () => {
  const dir = makeTmpDir('matron-summary-stamp-migration-')
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
    "INSERT INTO conversations(id, owner_user_id, title, created_at) VALUES('legacy',1,'pre-stamp',0)"
  ).run()
  raw.close()

  let db = openDb(dbPath)
  try {
    const cols = db.prepare('PRAGMA table_info(conversations)').all()
    const col = cols.find((c) => c.name === 'summary_updated_at')
    assert.ok(col, 'summary_updated_at column missing after migration')
    assert.equal(col.notnull, 1, 'must be NOT NULL so no row ever reads null')
    assert.equal(col.dflt_value, '0')
    assert.equal(cols.filter((c) => c.name === 'summary_updated_at').length, 1, 'added exactly once')

    // The backfilled value for a row that predates the column is the same
    // "never" sentinel a summary-less new row gets — so an old conversation
    // renders no age label rather than claiming to be fresh.
    assert.equal(db.prepare("SELECT summary_updated_at FROM conversations WHERE id='legacy'").get().summary_updated_at, 0)
    assert.equal(db.prepare("SELECT summary FROM conversations WHERE id='legacy'").get().summary, '')
  } finally {
    db.close()
  }

  // Re-open the SAME file: the migration block runs again against a database
  // that already has the column. Idempotent or the server cannot restart.
  try {
    db = openDb(dbPath)
    const cols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name)
    assert.equal(cols.filter((c) => c === 'summary_updated_at').length, 1, 're-open must not re-add the column')
    db.close()

    // Fresh/empty database: the column must exist after a cold start too,
    // since the base CREATE TABLE does not declare it.
    const fresh = openDb(':memory:')
    const freshCols = fresh.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name)
    assert.ok(freshCols.includes('summary_updated_at'), 'cold start must create the column')
    fresh.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// WAL mitigation, openDb half (docs/wal-checkpoint-profile.md): the WAL file
// truncates back to <=4MiB on reset for every opener, but the inline
// auto-checkpoint must stay at SQLite's stock default here — only the server
// (which runs the PASSIVE-checkpoint timer) may disable it, otherwise a
// standalone opener like the admin CLI would grow the WAL unbounded during
// long one-shot runs. Asserted on a file-backed DB because :memory:
// databases silently ignore WAL mode.
test('openDb bounds the WAL file but keeps the stock auto-checkpoint', () => {
  const dir = makeTmpDir('matron-walpragma-')
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

// `agent_device_id` names a real device now (see the cascade tests below), so
// every convo_agents fixture needs one.
const seedDevice = (db, id) => {
  db.prepare("INSERT OR IGNORE INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(?,1,'agent',?,?,0)")
    .run(id, `d${id}`, `h${id}`)
  return id
}

// Stand up a database on the CURRENT schema, then hand a raw handle to
// `downgrade` to put convo_agents back into a pre-migration shape. Building
// the other twenty tables with openDb rather than by hand is what keeps these
// fixtures from drifting out of date with the real schema.
const preMigrationDb = (dbPath, downgrade) => {
  openDb(dbPath).close()
  const raw = new Database(dbPath)
  raw.pragma('foreign_keys = OFF')
  downgrade(raw)
  raw.close()
}

test('convo_agents accepts the consent states and columns', () => {
  const db = openDb(':memory:')
  const dev = seedDevice(db, 2)
  db.prepare(`INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, justification, topic, created_at, delivered_at)
             VALUES('r', ?, 1, 'awaiting_user', 'j', 't', 5, NULL)`).run(dev)
  db.prepare("UPDATE convo_agents SET state='denied' WHERE convo_id='r'").run()
  assert.equal(db.prepare("SELECT state FROM convo_agents WHERE convo_id='r'").get().state, 'denied')
  assert.throws(() => db.prepare("UPDATE convo_agents SET state='bogus' WHERE convo_id='r'").run())
})

test('old-schema convo_agents is rebuilt in place, rows preserved, delivered_at backfilled', (t) => {
  const dir = makeTmpDir('matron-convo-agents-migration-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'pre-migration.db')

  preMigrationDb(dbPath, (raw) => {
    seedDevice(raw, 2)
    raw.exec(`DROP TABLE convo_agents;
      CREATE TABLE convo_agents(
        convo_id TEXT NOT NULL, agent_device_id INTEGER NOT NULL, initiator_device_id INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('invited','joined','refused','left','expired')),
        justification TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, answered_at INTEGER,
        PRIMARY KEY(convo_id, agent_device_id));
      INSERT INTO convo_agents VALUES('r', 2, 1, 'joined', 'why', 111, 222);`)
  })

  const db = openDb(dbPath)
  const row = db.prepare("SELECT * FROM convo_agents WHERE convo_id='r'").get()
  assert.equal(row.state, 'joined')
  assert.equal(row.justification, 'why')
  assert.equal(row.topic, '')
  assert.equal(row.delivered_at, 111)
  db.close()

  assert.doesNotThrow(() => openDb(dbPath).close())
})

// The cascade, and the deliberate asymmetry between the two device columns.
// This is the whole mechanism behind device revocation clearing rooms — no
// revoke site calls a cleanup helper any more, so if the constraint goes, so
// does the protection, silently.
test('convo_agents: agent_device_id cascades from devices, initiator_device_id does not', () => {
  const db = openDb(':memory:')
  const a = seedDevice(db, 1)
  const b = seedDevice(db, 2)
  db.prepare("INSERT INTO conversations(id, owner_user_id, created_at) VALUES('room',1,0)").run()
  db.prepare(`INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, created_at)
              VALUES('room',?,?,'joined',0)`).run(b, a)

  db.prepare('DELETE FROM devices WHERE id=?').run(a)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM convo_agents').get().n, 1,
    'losing the requester must not delete the ask it made')

  db.prepare('DELETE FROM devices WHERE id=?').run(b)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM convo_agents').get().n, 0,
    'losing the member deletes its membership')
})

test('convo_agents: an unknown agent_device_id is rejected outright', () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(name, password_hash, created_at) VALUES('dan','x',0)").run()
  db.prepare("INSERT INTO conversations(id, owner_user_id, created_at) VALUES('room',1,0)").run()
  assert.throws(() => db.prepare(`INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, created_at)
                                  VALUES('room',999,999,'joined',0)`).run(), /FOREIGN KEY/)
})

test('convo_agents migration adds the cascade and drops rows the old revoke path stranded', (t) => {
  const dir = makeTmpDir('matron-convo-agents-fk-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'pre-fk.db')

  // Current-schema convo_agents minus the constraint — what every database
  // written before this migration looks like, holding one live membership row
  // and one left behind by `matron-admin device revoke`.
  preMigrationDb(dbPath, (raw) => {
    seedDevice(raw, 7)
    raw.exec(`DROP TABLE convo_agents;
      CREATE TABLE convo_agents(
        convo_id TEXT NOT NULL, agent_device_id INTEGER NOT NULL, initiator_device_id INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('awaiting_user','invited','joined','refused','denied','left','expired')),
        justification TEXT NOT NULL DEFAULT '', topic TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
        answered_at INTEGER, delivered_at INTEGER, target_convo_id TEXT,
        PRIMARY KEY(convo_id, agent_device_id));
      INSERT INTO convo_agents VALUES('room',7,7,'joined','why','deploy',111,222,333,'target-1');
      INSERT INTO convo_agents VALUES('room',404,7,'joined','stale','',1,2,3,NULL);`)
  })

  const db = openDb(dbPath)
  const rows = db.prepare('SELECT * FROM convo_agents').all()
  assert.equal(rows.length, 1, 'the row whose device is already gone does not survive the rebuild')
  // Every column carried across, not just the ones the constraint is about.
  assert.deepEqual(
    [rows[0].agent_device_id, rows[0].state, rows[0].justification, rows[0].topic,
      rows[0].created_at, rows[0].answered_at, rows[0].delivered_at, rows[0].target_convo_id],
    [7, 'joined', 'why', 'deploy', 111, 222, 333, 'target-1'])

  db.prepare('DELETE FROM devices WHERE id=7').run()
  assert.equal(db.prepare('SELECT COUNT(*) n FROM convo_agents').get().n, 0, 'and the cascade is live afterwards')
  db.close()

  assert.doesNotThrow(() => openDb(dbPath).close(), 'migration is idempotent')
})

test('openDb: agent_chat_allowances is gone from a fresh database', () => {
  const db = openDb(':memory:')
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_chat_allowances'").get()
  assert.equal(t, undefined)
})

test('openDb: an existing agent_chat_allowances table is dropped on migrate', (t) => {
  const dir = makeTmpDir('matron-allow-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'm.db')
  const raw = new Database(dbPath)
  raw.exec(`CREATE TABLE agent_chat_allowances(
    user_id INTEGER NOT NULL, from_device_id INTEGER NOT NULL,
    target_device_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, from_device_id, target_device_id))`)
  raw.prepare('INSERT INTO agent_chat_allowances VALUES(1,2,3,0)').run()
  raw.close()

  const db = openDb(dbPath)
  const found = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_chat_allowances'").get()
  assert.equal(found, undefined, 'the migration must drop the table, standing consent and all')
})

test('search schema: tables, insert trigger, and NOTHING else', () => {
  const db = openDb(':memory:')
  // content table + fts + backfill state all exist
  db.prepare("INSERT INTO search_messages(user_id, convo_id, seq, ts, sender, body) VALUES(1,'c1',1,1,'user:dan','hello sqlite search')").run()
  const hit = db.prepare("SELECT rowid FROM search_fts WHERE search_fts MATCH 'sqlite'").get()
  assert.ok(hit, 'insert trigger populates the FTS index')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_backfill_state').get().n, 0)
  // The append-only invariant, pinned: exactly ONE trigger (after-insert) on
  // search_messages — a future update/delete trigger means someone added a
  // mutation path to events and must revisit the whole design.
  const triggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='search_messages'"
  ).all()
  assert.deepEqual(triggers.map((t) => t.name), ['search_messages_ai'])
  db.close()
})

test('search schema: UNIQUE(user_id, seq) makes re-inserts with OR IGNORE no-ops', () => {
  const db = openDb(':memory:')
  const ins = db.prepare("INSERT OR IGNORE INTO search_messages(user_id, convo_id, seq, ts, sender, body) VALUES(1,'c1',1,1,'user:dan','hello')")
  assert.equal(ins.run().changes, 1)
  assert.equal(ins.run().changes, 0)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM search_fts WHERE search_fts MATCH 'hello'").get().n, 1)
  db.close()
})

// An APNs token identifies a physical app install, so at most ONE device row
// may hold it. The bug this pins: every re-pair of the Mac app created a fresh
// device row and left the old rows holding the same live token, so one push
// fanned out to 18 rows — 18 sends to one device, 17 of them 429 rate_limited
// by APNs.
test('registering an APNs token clears it from every other device row', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const mk = (hash) => db.prepare(
    "INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','mac',?,0)"
  ).run(dan.id, hash).lastInsertRowid

  const old = mk('h-old')
  const fresh = mk('h-fresh')
  setApnsRegistration(db, old, { apnsToken: 'mac-token', apnsEnv: 'sandbox' })
  setApnsRegistration(db, fresh, { apnsToken: 'mac-token', apnsEnv: 'sandbox' })

  const rows = clientDevicesForPush(db, dan.id)
  assert.deepEqual(rows.map((r) => r.id), [fresh], 'only the newest registration keeps the token')
  const stale = db.prepare('SELECT apns_token, apns_env FROM devices WHERE id=?').get(old)
  assert.equal(stale.apns_token, null)
  assert.equal(stale.apns_env, null, 'token and env are always cleared as a pair')
  db.close()
})

// Cross-user, because a re-paired device that now belongs to someone else must
// stop receiving the previous owner's notifications — the same exclusivity
// rule, with a privacy consequence rather than a rate-limit one.
test('registering an APNs token claims it from another user_id device row', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const sam = await createUser(db, 'sam', 'pw')
  const danMac = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','mac','h-dan',0)").run(dan.id).lastInsertRowid
  const samMac = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','mac','h-sam',0)").run(sam.id).lastInsertRowid

  setApnsRegistration(db, danMac, { apnsToken: 'shared-hardware', apnsEnv: 'prod' })
  setApnsRegistration(db, samMac, { apnsToken: 'shared-hardware', apnsEnv: 'prod' })

  assert.equal(clientDevicesForPush(db, dan.id).length, 0, 'the previous owner keeps no claim on the token')
  assert.deepEqual(clientDevicesForPush(db, sam.id).map((r) => r.id), [samMac])
  db.close()
})

// Unregistering must not scavenge: `apnsToken: null` clears only the caller's
// own row, and can never null out a token some other row legitimately holds.
test('unregistering clears only the calling device row', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const phone = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','phone','h-p',0)").run(dan.id).lastInsertRowid
  const mac = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','mac','h-m',0)").run(dan.id).lastInsertRowid
  setApnsRegistration(db, phone, { apnsToken: 'phone-token', apnsEnv: 'prod' })
  setApnsRegistration(db, mac, { apnsToken: 'mac-token', apnsEnv: 'prod' })

  setApnsRegistration(db, mac, { apnsToken: null, apnsEnv: null })

  assert.deepEqual(clientDevicesForPush(db, dan.id).map((r) => r.id), [phone])
  db.close()
})

// The live dev-2 DB already carries 18 rows sharing one token; the fix above
// only stops NEW duplicates, so openDb collapses the existing ones on start.
test('openDb collapses duplicate APNs tokens, keeping the newest device row', () => {
  const dir = makeTmpDir('matron-apns-dedupe-')
  const dbPath = path.join(dir, 'dupes.db')

  // Seeded through a raw handle, because openDb is exactly what refuses to
  // hold duplicates: the pre-fix schema had no unique index to violate.
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
  const ins = raw.prepare(
    "INSERT INTO devices(id, user_id, kind, name, token_hash, apns_token, created_at) VALUES(?,1,'client','mac',?,?,0)"
  )
  for (const [id, hash] of [[1, 'h1'], [2, 'h2'], [3, 'h3']]) ins.run(id, hash, 'mac-token')
  // A different token on a fourth row is untouched by the collapse.
  ins.run(4, 'h4', 'phone-token')
  raw.close()

  const db = openDb(dbPath)
  assert.deepEqual(
    db.prepare('SELECT id FROM devices WHERE apns_token IS NOT NULL ORDER BY id').all().map((r) => r.id),
    [3, 4]
  )
  assert.equal(db.prepare('SELECT apns_env FROM devices WHERE id=1').get().apns_env, null)
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

// --- devices.id AUTOINCREMENT (loop #755) --------------------------------
// devices.id was a plain reusable rowid: deleting the highest-numbered device
// handed its id straight to the next insert, and a replacement then inherited
// the revoked device's idempotency namespace (idemKeyOf embeds who.deviceId).
// AUTOINCREMENT makes the id monotonic and never-reused, closing the hole at
// the source. This is the A1 scope of #755: the downstream workarounds
// (file_idem trigger/gen/SET NULL, agent_idem incarnation-binding) are LEFT in
// place as belt-and-braces and removed in a follow-up.

test('fresh DB: devices.id is AUTOINCREMENT and a revoked id is never reused', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const mk = (hash) => db.prepare(
    "INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'agent','box',?,0)"
  ).run(dan.id, hash).lastInsertRowid

  // The DDL itself carries the guarantee.
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'").get().sql
  assert.match(sql, /AUTOINCREMENT/, 'fresh devices table must be AUTOINCREMENT')

  const a = mk('h-a')
  const b = mk('h-b')
  assert.equal(b, a + 1)
  // Delete the HIGHEST id, then insert again: a plain rowid would hand `b`
  // back; AUTOINCREMENT must skip past it.
  db.prepare('DELETE FROM devices WHERE id=?').run(b)
  const c = mk('h-c')
  assert.equal(c, b + 1, 'the revoked id must not be reused')
  db.close()
})

test('openDb rebuilds a pre-AUTOINCREMENT devices table in place, preserving rows and ids', (t) => {
  const dir = makeTmpDir('matron-devices-ai-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'pre-ai.db')

  // A live-shaped devices table (base columns + every ALTER-added column) with
  // NO AUTOINCREMENT — what every database written before this migration has.
  const raw = new Database(dbPath)
  raw.exec(`
    CREATE TABLE users(
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE devices(
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      cursor INTEGER NOT NULL DEFAULT 0,
      apns_token TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      apns_env TEXT,
      push_prefs TEXT,
      private INTEGER NOT NULL DEFAULT 0,
      private_pinned INTEGER NOT NULL DEFAULT 0,
      tag_char TEXT
    );
  `)
  raw.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  const ins = raw.prepare(
    "INSERT INTO devices(id, user_id, kind, name, token_hash, cursor, private, private_pinned, tag_char, created_at, last_seen_at) VALUES(?,1,'agent',?,?,7,1,1,?,?,?)"
  )
  ins.run(1, 'box-1', 'h1', 'A', 100, 200)
  ins.run(2, 'box-2', 'h2', 'B', 101, 201)
  ins.run(3, 'box-3', 'h3', 'C', 102, 202)
  raw.close()

  const db = openDb(dbPath)
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'").get().sql
  assert.match(sql, /AUTOINCREMENT/, 'migration must convert devices to AUTOINCREMENT')

  // Every row + every column survives with its exact id.
  const rows = db.prepare('SELECT * FROM devices ORDER BY id').all()
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3])
  const two = rows[1]
  assert.deepEqual(
    [two.name, two.token_hash, two.cursor, two.private, two.private_pinned, two.tag_char, two.created_at, two.last_seen_at],
    ['box-2', 'h2', 7, 1, 1, 'B', 101, 201])

  // sqlite_sequence is seeded to the max live id, so a NEW device after the
  // migration is 4 — and deleting the top then re-inserting never reuses.
  const four = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(1,'agent','box-4','h4',0)").run().lastInsertRowid
  assert.equal(four, 4)
  db.prepare('DELETE FROM devices WHERE id=4').run()
  const five = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(1,'agent','box-5','h5',0)").run().lastInsertRowid
  assert.equal(five, 5, 'a post-migration revoke must not reuse the id')

  // Whole-DB FK integrity is intact after the parent-table rebuild.
  assert.equal(db.pragma('foreign_key_check').length, 0)
  db.close()

  // Idempotent: re-opening an already-AUTOINCREMENT DB is a no-op.
  assert.doesNotThrow(() => openDb(dbPath).close())
})

test('devices rebuild preserves inbound FK children and the file_idem revoke trigger', (t) => {
  const dir = makeTmpDir('matron-devices-ai-fk-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'pre-ai.db')

  // Stand the DB up on the CURRENT schema, then downgrade ONLY devices back to
  // a non-AUTOINCREMENT shape (keeping its rows), so the child tables + trigger
  // are real and must survive the parent rebuild.
  openDb(dbPath).close()
  const raw = new Database(dbPath)
  raw.pragma('foreign_keys = OFF')
  raw.exec("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)")
  raw.exec(`
    CREATE TABLE devices_old(
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, cursor INTEGER NOT NULL DEFAULT 0, apns_token TEXT,
      created_at INTEGER NOT NULL, last_seen_at INTEGER, apns_env TEXT, push_prefs TEXT,
      private INTEGER NOT NULL DEFAULT 0, private_pinned INTEGER NOT NULL DEFAULT 0, tag_char TEXT);
    INSERT INTO devices_old(id, user_id, kind, name, token_hash, created_at)
      VALUES(5,1,'agent','box-5','h5',0),(6,1,'agent','box-6','h6',0);
    DROP TABLE devices;
    ALTER TABLE devices_old RENAME TO devices;
  `)
  // A joined membership (cascades) and two file_idem reservations for device 6.
  raw.exec("INSERT INTO conversations(id, owner_user_id, created_at) VALUES('room',1,0)")
  raw.exec("INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, created_at) VALUES('room',6,5,'joined',0)")
  raw.exec(`INSERT INTO file_idem(key, device_id, gen, fingerprint, boot_id, state, created_at, expires_at)
            VALUES('6:done', 6, 'g1', 'fp', 'boot', 'done', 0, 9e18),
                  ('6:pending', 6, 'g2', 'fp', 'boot', 'pending', 0, 9e18)`)
  raw.close()

  const db = openDb(dbPath)
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'").get().sql, /AUTOINCREMENT/)
  // Children carried across the parent rebuild.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM convo_agents WHERE agent_device_id=6").get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM file_idem').get().n, 2)
  assert.equal(db.pragma('foreign_key_check').length, 0)

  // The BEFORE DELETE trigger was dropped with the old table and must be back:
  // revoking device 6 drops its SETTLED file_idem row and detaches the PENDING
  // one, and cascades its membership.
  db.prepare('DELETE FROM devices WHERE id=6').run()
  assert.equal(db.prepare("SELECT COUNT(*) n FROM file_idem WHERE key='6:done'").get().n, 0, 'settled row dropped by trigger')
  const pending = db.prepare("SELECT device_id FROM file_idem WHERE key='6:pending'").get()
  assert.equal(pending.device_id, null, 'pending row detached to a tombstone, not deleted')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM convo_agents WHERE agent_device_id=6").get().n, 0, 'membership cascaded')
  db.close()
})

// F1 regression (loop #755 Codex round 1): the seed must clear the HIGH-WATER
// mark across every durable device-id reference, not just live device rows.
// conversations.agent_device_id is the dangerous one — it is not a foreign key
// (a revoke leaves it dangling) and authorizeAgentWrite treats it as ownership,
// so if the highest id ever issued was revoked but still owns a conversation,
// reissuing it would hand the replacement that conversation's write access.
test('devices rebuild seeds the sequence above a dangling conversation owner, not just live rows', (t) => {
  const dir = makeTmpDir('matron-devices-ai-hw-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'pre-ai.db')

  openDb(dbPath).close()
  const raw = new Database(dbPath)
  raw.pragma('foreign_keys = OFF')
  raw.exec("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)")
  // Downgrade devices to a non-AUTOINCREMENT table holding ONLY device 1 —
  // device 2 was the highest ever issued but has since been revoked.
  raw.exec(`
    CREATE TABLE devices_old(
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, cursor INTEGER NOT NULL DEFAULT 0, apns_token TEXT,
      created_at INTEGER NOT NULL, last_seen_at INTEGER, apns_env TEXT, push_prefs TEXT,
      private INTEGER NOT NULL DEFAULT 0, private_pinned INTEGER NOT NULL DEFAULT 0, tag_char TEXT);
    INSERT INTO devices_old(id, user_id, kind, name, token_hash, created_at) VALUES(1,1,'agent','live','h1',0);
    DROP TABLE devices;
    ALTER TABLE devices_old RENAME TO devices;
  `)
  // The revoked device 2 still owns a conversation — the dangling reference the
  // live-max seed would miss.
  raw.exec("INSERT INTO conversations(id, owner_user_id, agent_device_id, created_at) VALUES('room',1,2,0)")
  raw.close()

  const db = openDb(dbPath)
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'").get().sql, /AUTOINCREMENT/)
  // Next issuance must skip PAST the dangling id 2 — id 3, never 2.
  const next = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(1,'agent','replacement','h-new',0)").run().lastInsertRowid
  assert.equal(next, 3, 'a revoked-but-still-referenced id must not be reissued')
  assert.notEqual(next, 2)
  db.close()
})

// F2 regression (loop #755 Codex round 1): the FK audit runs INSIDE the
// transaction, so a devices-parent orphan rolls the whole rebuild back and the
// AUTOINCREMENT DDL never lands. A restart therefore re-attempts and re-fails
// rather than skipping the (never-completed) migration and booting with the
// broken FK state silently accepted.
test('a devices-parent FK violation rolls the rebuild back and re-fails on restart', (t) => {
  const dir = makeTmpDir('matron-devices-ai-fkfail-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'pre-ai.db')

  openDb(dbPath).close()
  const raw = new Database(dbPath)
  raw.pragma('foreign_keys = OFF')
  raw.exec("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)")
  raw.exec(`
    CREATE TABLE devices_old(
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, cursor INTEGER NOT NULL DEFAULT 0, apns_token TEXT,
      created_at INTEGER NOT NULL, last_seen_at INTEGER, apns_env TEXT, push_prefs TEXT,
      private INTEGER NOT NULL DEFAULT 0, private_pinned INTEGER NOT NULL DEFAULT 0, tag_char TEXT);
    INSERT INTO devices_old(id, user_id, kind, name, token_hash, created_at) VALUES(1,1,'agent','live','h1',0);
    DROP TABLE devices;
    ALTER TABLE devices_old RENAME TO devices;
  `)
  // A convo_agents row pointing at a device (99) that is NOT in devices: a
  // devices-parent orphan the rebuild's scoped audit must catch.
  raw.exec("INSERT INTO conversations(id, owner_user_id, created_at) VALUES('room',1,0)")
  raw.exec("INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, created_at) VALUES('room',99,1,'joined',0)")
  raw.close()

  assert.throws(() => openDb(dbPath), /orphaned a child reference/, 'the audit fails the migration')
  // Rolled back: devices is still the non-AUTOINCREMENT table.
  const check = new Database(dbPath)
  assert.doesNotMatch(check.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'").get().sql, /AUTOINCREMENT/)
  check.close()
  // Restart re-attempts and re-fails rather than silently accepting the state.
  assert.throws(() => openDb(dbPath), /orphaned a child reference/, 'restart does not skip the never-completed migration')
})

// F1 round-2 (loop #755): the high-water scan must be schema-complete, not a
// hand-list. A revoked id surviving ONLY in items.origin_device_id (an integer
// column reached by the dynamic *_device_id scan) or ONLY in events.idem_key
// (the one persistent integer-less namespace, `client:<id>:` / `agent:<id>:`)
// must still lift the sequence past it — otherwise a reissued id inherits the
// old item's idempotency key (replay) or the old device's message dedup.
test('devices rebuild seeds above a dangling id found only in items.origin_device_id', (t) => {
  const dir = makeTmpDir('matron-devices-ai-item-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'pre-ai.db')

  openDb(dbPath).close()
  const raw = new Database(dbPath)
  raw.pragma('foreign_keys = OFF')
  raw.exec("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)")
  raw.exec(`
    CREATE TABLE devices_old(
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, cursor INTEGER NOT NULL DEFAULT 0, apns_token TEXT,
      created_at INTEGER NOT NULL, last_seen_at INTEGER, apns_env TEXT, push_prefs TEXT,
      private INTEGER NOT NULL DEFAULT 0, private_pinned INTEGER NOT NULL DEFAULT 0, tag_char TEXT);
    INSERT INTO devices_old(id, user_id, kind, name, token_hash, created_at) VALUES(1,1,'agent','live','h1',0);
    DROP TABLE devices;
    ALTER TABLE devices_old RENAME TO devices;
  `)
  // Revoked device 40 persists only as an item's author.
  raw.exec(`INSERT INTO items(id,user_id,num,kind,state,rank,title,origin_convo_id,origin_device_id,created_by,idem_key,created_at,updated_at)
            VALUES('it1',1,1,'task','open',1.0,'t','room',40,'agent','40:ckey',0,0)`)
  raw.close()

  const db = openDb(dbPath)
  const next = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(1,'agent','r','h-new',0)").run().lastInsertRowid
  assert.equal(next, 41, 'the dynamic *_device_id scan must reach items.origin_device_id')
  db.close()
})

test('devices rebuild seeds above a dangling id found only in events.idem_key', (t) => {
  const dir = makeTmpDir('matron-devices-ai-events-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'pre-ai.db')

  openDb(dbPath).close()
  const raw = new Database(dbPath)
  raw.pragma('foreign_keys = OFF')
  raw.exec("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)")
  raw.exec(`
    CREATE TABLE devices_old(
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, cursor INTEGER NOT NULL DEFAULT 0, apns_token TEXT,
      created_at INTEGER NOT NULL, last_seen_at INTEGER, apns_env TEXT, push_prefs TEXT,
      private INTEGER NOT NULL DEFAULT 0, private_pinned INTEGER NOT NULL DEFAULT 0, tag_char TEXT);
    INSERT INTO devices_old(id, user_id, kind, name, token_hash, created_at) VALUES(1,1,'client','live','h1',0);
    DROP TABLE devices;
    ALTER TABLE devices_old RENAME TO devices;
  `)
  // Revoked client 50 persists only as a message idempotency key; agent 30 too.
  raw.exec("INSERT INTO conversations(id, owner_user_id, created_at) VALUES('room',1,0)")
  raw.exec(`INSERT INTO events(user_id,seq,convo_id,ts,sender,type,payload,idem_key)
            VALUES(1,1,'room',0,'user:dan','text','{}','client:50:local-1'),
                  (1,2,'room',0,'agent:a','text','{}','agent:30:some-key')`)
  raw.close()

  const db = openDb(dbPath)
  const next = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(1,'client','r','h-new',0)").run().lastInsertRowid
  assert.equal(next, 51, 'the events.idem_key scan must reach the 2nd colon segment')
  db.close()
})

// F1/F2 round-3 hardening (loop #755): defensive against data our own code
// never writes but externally-repaired/legacy DBs might.
test('devices rebuild ignores a malformed events.idem_key numeric prefix (no ID exhaustion)', (t) => {
  const dir = makeTmpDir('matron-devices-ai-malformed-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'pre-ai.db')

  openDb(dbPath).close()
  const raw = new Database(dbPath)
  raw.pragma('foreign_keys = OFF')
  raw.exec("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)")
  raw.exec(`
    CREATE TABLE devices_old(
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, cursor INTEGER NOT NULL DEFAULT 0, apns_token TEXT,
      created_at INTEGER NOT NULL, last_seen_at INTEGER, apns_env TEXT, push_prefs TEXT,
      private INTEGER NOT NULL DEFAULT 0, private_pinned INTEGER NOT NULL DEFAULT 0, tag_char TEXT);
    INSERT INTO devices_old(id, user_id, kind, name, token_hash, created_at) VALUES(1,1,'client','live','h1',0);
    DROP TABLE devices;
    ALTER TABLE devices_old RENAME TO devices;
  `)
  raw.exec("INSERT INTO conversations(id, owner_user_id, created_at) VALUES('room',1,0)")
  // A numeric-prefix-with-junk key (CAST would yield a giant int) and a real one.
  raw.exec(`INSERT INTO events(user_id,seq,convo_id,ts,sender,type,payload,idem_key)
            VALUES(1,1,'room',0,'user:dan','text','{}','client:9223372036854775807junk:x'),
                  (1,2,'room',0,'user:dan','text','{}','client:7:ok')`)
  raw.close()

  const db = openDb(dbPath)
  // The malformed key is excluded; the real id 7 wins → next is 8, NOT a giant.
  const next = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(1,'client','r','h-new',0)").run().lastInsertRowid
  assert.equal(next, 8, 'malformed prefixes must not inflate the sequence')
  db.close()
})

test('devices rebuild scans a table whose name contains a double-quote', (t) => {
  const dir = makeTmpDir('matron-devices-ai-quote-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'pre-ai.db')

  openDb(dbPath).close()
  const raw = new Database(dbPath)
  raw.pragma('foreign_keys = OFF')
  raw.exec("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)")
  raw.exec(`
    CREATE TABLE devices_old(
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, cursor INTEGER NOT NULL DEFAULT 0, apns_token TEXT,
      created_at INTEGER NOT NULL, last_seen_at INTEGER, apns_env TEXT, push_prefs TEXT,
      private INTEGER NOT NULL DEFAULT 0, private_pinned INTEGER NOT NULL DEFAULT 0, tag_char TEXT);
    INSERT INTO devices_old(id, user_id, kind, name, token_hash, created_at) VALUES(1,1,'agent','live','h1',0);
    DROP TABLE devices;
    ALTER TABLE devices_old RENAME TO devices;
  `)
  // A table with a literal double-quote in its name, holding a dangling id 60.
  raw.exec('CREATE TABLE "weird""tbl" (x_device_id INTEGER); INSERT INTO "weird""tbl" VALUES(60);')
  raw.close()

  const db = openDb(dbPath)
  const next = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(1,'agent','r','h-new',0)").run().lastInsertRowid
  assert.equal(next, 61, 'the quoted-identifier scan must reach the oddly-named table without throwing')
  db.close()
})

// Rows parked before the `link` column existed were asked under the
// always-linked contract, so the column's DEFAULT keeps them linked; only
// rows written by the new code carry an explicit 0.
test('openDb adds agent_spawn_requests.link defaulting to 1 for pre-existing rows', () => {
  const dir = makeTmpDir('matron-spawn-link-migration-')
  const dbPath = path.join(dir, 'pre-migration.db')
  const raw = new Database(dbPath)
  raw.exec(`
    CREATE TABLE agent_spawn_requests(
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, from_device_id INTEGER NOT NULL,
      from_convo_id TEXT NOT NULL, target_device_id INTEGER NOT NULL, workdir TEXT NOT NULL,
      task TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '', model TEXT,
      state TEXT NOT NULL CHECK(state IN ('awaiting_user','approved','started','denied','expired','failed')),
      room_id TEXT, child_convo_id TEXT, created_at INTEGER NOT NULL, answered_at INTEGER, resolved_at INTEGER
    );
  `)
  raw.prepare("INSERT INTO agent_spawn_requests(id,user_id,from_device_id,from_convo_id,target_device_id,workdir,task,state,created_at) VALUES('old',1,1,'c',2,'/w','t','awaiting_user',0)").run()
  raw.close()
  const db = openDb(dbPath)
  const cols = db.prepare('PRAGMA table_info(agent_spawn_requests)').all().map((c) => c.name)
  assert.ok(cols.includes('link'), 'link column missing after migration')
  assert.ok(cols.includes('child_short'), 'child_short column missing after migration')
  assert.ok(cols.includes('mission_num'), 'mission_num column missing after migration')
  assert.equal(db.prepare('SELECT mission_num FROM agent_spawn_requests WHERE id=?').get('old').mission_num, null)
  assert.equal(db.prepare('SELECT link FROM agent_spawn_requests WHERE id=?').get('old').link, 1)
  db.close()
  assert.doesNotThrow(() => openDb(dbPath).close())
})

// device_status rides the device row: a revoked box takes its last report
// with it, so a replacement that happens to reuse the integer id (devices.id
// is a plain rowid, not AUTOINCREMENT) cannot inherit the old usage, paths
// and account email on /devices and /roster until it reports.
test('device_status: the row goes with its device on revoke, and a reused id starts clean', () => {
  const db = openDb(':memory:')
  seedDevice(db, 1)
  upsertDeviceStatus(db, { userId: 1, deviceId: 1, status: { account: { email: 'old@example.com' } }, reportedAt: 5 })
  assert.equal(deviceStatuses(db, 1).get(1).account.email, 'old@example.com')
  db.prepare('DELETE FROM devices WHERE id=1').run()
  assert.equal(deviceStatuses(db, 1).has(1), false)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM device_status').get().n, 0)
  seedDevice(db, 1)
  assert.equal(deviceStatuses(db, 1).has(1), false, 'the replacement box has no status until it reports')
})

test('old-schema device_status (no cascade) is rebuilt in place: live rows kept, orphans dropped', (t) => {
  const dir = makeTmpDir('matron-device-status-migration-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'pre-migration.db')

  preMigrationDb(dbPath, (raw) => {
    seedDevice(raw, 2)
    raw.exec(`DROP TABLE device_status;
      CREATE TABLE device_status(
        device_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, reported_at INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE INDEX idx_device_status_user ON device_status(user_id);
      INSERT INTO device_status VALUES(2, 1, 111, '{"disk":{"free_bytes":1,"total_bytes":2}}');
      INSERT INTO device_status VALUES(9, 1, 222, '{"account":{"email":"gone@example.com"}}');`)
  })

  const db = openDb(dbPath)
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='device_status'").get().sql
  assert.ok(sql.includes('ON DELETE CASCADE'))
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_device_status_user'").get())
  const rows = deviceStatuses(db, 1)
  assert.deepEqual([...rows.keys()], [2])
  assert.equal(rows.get(2).reported_at, 111)
  assert.deepEqual(rows.get(2).disk, { free_bytes: 1, total_bytes: 2 })
  db.prepare('DELETE FROM devices WHERE id=2').run()
  assert.equal(deviceStatuses(db, 1).size, 0, 'the rebuilt table cascades')
  db.close()

  assert.doesNotThrow(() => openDb(dbPath).close())
})

test('schema: repo columns and github tables exist', () => {
  const db = openDb(':memory:')
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
  assert.ok(cols('conversations').includes('repo'))
  assert.ok(cols('conversations').includes('repo_scope'))
  assert.deepEqual(cols('github_accounts'), ['user_id', 'host', 'github_id', 'login', 'token', 'state', 'checked_at', 'linked_at', 'token_hash'])
  assert.deepEqual(cols('github_orgs'), ['user_id', 'scope'])
  assert.deepEqual(cols('github_link_flows'), ['id', 'user_id', 'device_id', 'flow', 'device_code', 'state', 'expires_at', 'created_at'])
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(2,'pat','x',0)").run()
  const ins = db.prepare("INSERT INTO github_accounts(user_id, host, github_id, login, token, state, linked_at) VALUES(?, 'github.com', 7, 'dan', 't', 'ok', 0)")
  ins.run(1)
  assert.throws(() => ins.run(2), /UNIQUE/, 'one GitHub account binds to one user')
  db.close()
})

test('openDb adds repo/repo_scope and the GitHub link tables to a pre-existing populated database in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-repo-migration-'))
  const dbPath = path.join(dir, 'pre-repo.db')

  // A conversations table shaped like the one before the tracker
  // visibility branch: no repo, no repo_scope, and no github_* tables.
  const raw = new Database(dbPath)
  raw.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
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
  raw.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  raw.prepare("INSERT INTO conversations(id, owner_user_id, title, created_at) VALUES('c1',1,'legacy',0)").run()
  raw.prepare("INSERT INTO conversations(id, owner_user_id, title, created_at) VALUES('c2',1,'legacy two',0)").run()
  raw.close()

  const db = openDb(dbPath)
  const cols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name)
  assert.ok(cols.includes('repo'), 'repo column missing after migration')
  assert.ok(cols.includes('repo_scope'), 'repo_scope column missing after migration')
  const indexes = db.prepare('PRAGMA index_list(conversations)').all().map((i) => i.name)
  assert.ok(indexes.includes('idx_conversations_repo_scope'), 'repo_scope index missing after migration')
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name)
  for (const t of ['github_accounts', 'github_orgs', 'github_link_flows']) assert.ok(tables.includes(t), `${t} missing after migration`)
  // Pre-existing rows survive untouched, with the new columns NULL — so a
  // legacy conversation is never mistaken for one in some org's scope.
  const rows = db.prepare('SELECT id, title, repo, repo_scope FROM conversations ORDER BY id').all()
  assert.deepEqual(rows, [
    { id: 'c1', title: 'legacy', repo: null, repo_scope: null },
    { id: 'c2', title: 'legacy two', repo: null, repo_scope: null },
  ])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM github_accounts').get().n, 0)
  db.close()

  // Re-opening (already migrated) is a no-op, not an error.
  assert.doesNotThrow(() => openDb(dbPath).close())
  fs.rmSync(dir, { recursive: true, force: true })
})

test('openDb adds users.is_admin (default 0) to a pre-existing users table in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-admin-migration-'))
  const dbPath = path.join(dir, 'pre-admin.db')
  const raw = new Database(dbPath)
  raw.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL)')
  raw.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  raw.close()
  const db = openDb(dbPath)
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name)
  assert.ok(cols.includes('is_admin'), 'is_admin column missing after migration')
  assert.deepEqual(db.prepare('SELECT id, name, is_admin FROM users').all(), [{ id: 1, name: 'dan', is_admin: 0 }])
  db.close()
  assert.doesNotThrow(() => openDb(dbPath).close())
  fs.rmSync(dir, { recursive: true, force: true })
})
