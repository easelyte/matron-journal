import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDb, setApnsRegistration, clientDevicesForPush, listDevices, upsertDeviceStatus, deviceStatuses } from '../src/db.js'
import { createUser, createAgent, login, revokeDevice, authorizeAgentWrite } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { makeTmpDir } from './tmp-dir.js'
import { participantConvoIds } from '../src/participants.js'

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
  // Pre-existing row survives untouched, with apns_env now NULL.
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

test('clientDevicesForPush lists client devices with a token; listDevices has no push prefs', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const dev = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','phone','h2',?)")
    .run(alice.id, Date.now())
  const deviceId = dev.lastInsertRowid
  setApnsRegistration(db, deviceId, { apnsToken: 'tok', apnsEnv: 'prod' })

  const pushRows = clientDevicesForPush(db, alice.id)
  assert.equal(pushRows.length, 1)
  assert.equal(pushRows[0].apns_token, 'tok')
  assert.equal('push_prefs' in pushRows[0], false)
  assert.equal('push_prefs' in listDevices(db, alice.id)[0], false)
})

// `agent_device_id` names a real device now (see the cascade tests below), so
// every convo_agents fixture needs one.
const seedDevice = (db, id) => {
  db.prepare("INSERT OR IGNORE INTO users(id, name, password_hash, created_at) VALUES(1,'alice','x',0)").run()
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
  db.prepare("INSERT INTO users(name, password_hash, created_at) VALUES('alice','x',0)").run()
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
  db.prepare("INSERT INTO search_messages(user_id, convo_id, seq, ts, sender, body) VALUES(1,'c1',1,1,'user:alice','hello sqlite search')").run()
  const hit = db.prepare("SELECT rowid FROM search_fts WHERE search_fts MATCH 'sqlite'").get()
  assert.ok(hit, 'insert trigger populates the FTS index')
  const plain = db.prepare("SELECT rowid FROM search_fts_plain WHERE search_fts_plain MATCH 'sqlite'").get()
  assert.ok(plain, 'insert trigger populates the unstemmed mirror too')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_backfill_state').get().n, 0)
  // The append-only invariant, pinned: ONLY after-insert triggers on
  // search_messages (one per FTS mirror) — a future update/delete trigger
  // means someone added a mutation path to events and must revisit the
  // whole design.
  const triggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='search_messages' ORDER BY name"
  ).all()
  assert.deepEqual(triggers.map((t) => t.name), ['search_messages_ai', 'search_messages_ai_plain'])
  db.close()
})

test('search schema: UNIQUE(user_id, seq) makes re-inserts with OR IGNORE no-ops', () => {
  const db = openDb(':memory:')
  const ins = db.prepare("INSERT OR IGNORE INTO search_messages(user_id, convo_id, seq, ts, sender, body) VALUES(1,'c1',1,1,'user:alice','hello')")
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
  const alice = await createUser(db, 'alice', 'pw')
  const mk = (hash) => db.prepare(
    "INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','mac',?,0)"
  ).run(alice.id, hash).lastInsertRowid

  const old = mk('h-old')
  const fresh = mk('h-fresh')
  setApnsRegistration(db, old, { apnsToken: 'mac-token', apnsEnv: 'sandbox' })
  setApnsRegistration(db, fresh, { apnsToken: 'mac-token', apnsEnv: 'sandbox' })

  const rows = clientDevicesForPush(db, alice.id)
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
  const alice = await createUser(db, 'alice', 'pw')
  const sam = await createUser(db, 'sam', 'pw')
  const aliceMac = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','mac','h-alice',0)").run(alice.id).lastInsertRowid
  const samMac = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','mac','h-sam',0)").run(sam.id).lastInsertRowid

  setApnsRegistration(db, aliceMac, { apnsToken: 'shared-hardware', apnsEnv: 'prod' })
  setApnsRegistration(db, samMac, { apnsToken: 'shared-hardware', apnsEnv: 'prod' })

  assert.equal(clientDevicesForPush(db, alice.id).length, 0, 'the previous owner keeps no claim on the token')
  assert.deepEqual(clientDevicesForPush(db, sam.id).map((r) => r.id), [samMac])
  db.close()
})

// Unregistering must not scavenge: `apnsToken: null` clears only the caller's
// own row, and can never null out a token some other row legitimately holds.
test('unregistering clears only the calling device row', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const phone = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','phone','h-p',0)").run(alice.id).lastInsertRowid
  const mac = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','mac','h-m',0)").run(alice.id).lastInsertRowid
  setApnsRegistration(db, phone, { apnsToken: 'phone-token', apnsEnv: 'prod' })
  setApnsRegistration(db, mac, { apnsToken: 'mac-token', apnsEnv: 'prod' })

  setApnsRegistration(db, mac, { apnsToken: null, apnsEnv: null })

  assert.deepEqual(clientDevicesForPush(db, alice.id).map((r) => r.id), [phone])
  db.close()
})

// The live box-2 DB already carries 18 rows sharing one token; the fix above
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

// Bridge-stamped causes (src/ask-causes.js) and the consent-decision and
// routine columns that resolve them later: additive, NULL on every older row.
test('schema: causes columns on both ask tables, cause columns on consent_decisions, envelope on routines', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-ask-causes-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'causes.db')
  const db = openDb(dbPath)
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
  assert.ok(cols('agent_spawn_requests').includes('causes'))
  assert.ok(cols('convo_agents').includes('causes'))
  for (const c of ['cause_kind', 'cause_ref', 'verifier_note']) assert.ok(cols('consent_decisions').includes(c), c)
  assert.ok(cols('routines').includes('envelope'))
  db.close()
  // The migration runs again on every open; it must find the columns and stop.
  assert.doesNotThrow(() => openDb(dbPath).close())
})

// device_status rides the device row: a revoked box takes its last report
// with it. Even an explicit insert reusing its integer id cannot inherit
// the old usage, paths and account email on /devices and /roster.
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
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'alice','x',0)").run()
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(2,'pat','x',0)").run()
  const ins = db.prepare("INSERT INTO github_accounts(user_id, host, github_id, login, token, state, linked_at) VALUES(?, 'github.com', 7, 'alice', 't', 'ok', 0)")
  ins.run(1)
  assert.throws(() => ins.run(2), /UNIQUE/, 'one GitHub account binds to one user')
  db.close()
})

test('openDb adds repo/repo_scope and the GitHub link tables to a pre-existing populated database in place', () => {
  const dir = makeTmpDir('matron-repo-migration-')
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
  raw.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'alice','x',0)").run()
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

test('openDb adds users.unlisted (default 0) to a pre-existing users table in place', () => {
  const dir = makeTmpDir('matron-unlisted-migration-')
  const dbPath = path.join(dir, 'pre-unlisted.db')
  const raw = new Database(dbPath)
  raw.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0)')
  raw.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'alice','x',0)").run()
  raw.close()
  const db = openDb(dbPath)
  assert.deepEqual(db.prepare('SELECT id, name, unlisted FROM users').all(), [{ id: 1, name: 'alice', unlisted: 0 }])
  db.close()
  assert.doesNotThrow(() => openDb(dbPath).close())
  fs.rmSync(dir, { recursive: true, force: true })
})

test('openDb adds users.is_admin (default 0) to a pre-existing users table in place', () => {
  const dir = makeTmpDir('matron-admin-migration-')
  const dbPath = path.join(dir, 'pre-admin.db')
  const raw = new Database(dbPath)
  raw.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL)')
  raw.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'alice','x',0)").run()
  raw.close()
  const db = openDb(dbPath)
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name)
  assert.ok(cols.includes('is_admin'), 'is_admin column missing after migration')
  assert.deepEqual(db.prepare('SELECT id, name, is_admin FROM users').all(), [{ id: 1, name: 'alice', is_admin: 0 }])
  db.close()
  assert.doesNotThrow(() => openDb(dbPath).close())
  fs.rmSync(dir, { recursive: true, force: true })
})

// participant_convos storage (room_owner_convos + convo_agents.spawn_id):
// the one-time backfill must reproduce exactly what the previous derivation
// showed, so no live room's list changes at deploy — and a room with no
// joined row (dissolved) must not get its old owner sessions back.
test('room_owner_convos + spawn_id backfill reproduce the pre-migration participant_convos', (t) => {
  const dir = makeTmpDir('matron-owner-convos-migration-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'pre-migration.db')

  preMigrationDb(dbPath, (raw) => {
    for (const id of [1, 2, 3]) seedDevice(raw, id)
    raw.exec(`DROP TABLE room_owner_convos;
      ALTER TABLE convo_agents DROP COLUMN spawn_id;
      INSERT INTO conversations(id, owner_user_id, title, agent_device_id, created_at) VALUES
        ('room', 1, 'room', 1, 0), ('dead', 1, 'dead', 1, 0);
      INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, target_convo_id, initiator_convo_id, created_at) VALUES
        ('room', 2, 1, 'left', 'b-sess', 'a-sess', 10),
        ('room', 3, 1, 'joined', NULL, NULL, 20),
        ('dead', 2, 1, 'left', 'b-old', 'a-old', 10);
      INSERT INTO agent_spawn_requests(id, user_id, from_device_id, from_convo_id, target_device_id, workdir, task, state, room_id, child_convo_id, created_at, resolved_at) VALUES
        ('sp1', 1, 1, 'a-par', 3, '/w', 't', 'started', 'room', 'child-1', 15, 30);`)
  })

  const db = openDb(dbPath)
  assert.equal(db.prepare("SELECT spawn_id FROM convo_agents WHERE convo_id='room' AND agent_device_id=3").get().spawn_id, 'sp1')
  assert.deepEqual(participantConvoIds(db, 'room'), ['a-sess', 'a-par', 'child-1'])
  assert.deepEqual(db.prepare("SELECT convo_id FROM room_owner_convos WHERE room_id='dead'").all(), [])
  db.close()
  assert.doesNotThrow(() => openDb(dbPath).close())
})

// One-off repair for rows written before agent publishes set the blob_ref
// column (see the agent.test.js case): image/file events whose payload names
// a blob the column does not. Idempotent, cheap (idx_events_media narrows
// the scan to attachment rows), and never touches tombstones or other types.
test('openDb backfills events.blob_ref for image/file rows that only carry payload.blob_ref', () => {
  const dir = makeTmpDir('matron-blobref-backfill-')
  const dbPath = path.join(dir, 'm.db')
  let db = openDb(dbPath)
  const ins = db.prepare('INSERT INTO events(user_id, seq, convo_id, ts, sender, type, payload, blob_ref) VALUES(1,?,?,?,?,?,?,?)')
  ins.run(1, 'c1', 1000, 'agent:box-2', 'image', JSON.stringify({ blob_ref: 'img1', name: 'a.png' }), null)
  ins.run(2, 'c1', 1001, 'agent:box-2', 'file', JSON.stringify({ blob_ref: 'file2', name: 'a.pdf' }), null)
  ins.run(3, 'c1', 1002, 'user:alice', 'image', JSON.stringify({ blob_ref: 'img3', name: 'b.png' }), 'img3')
  ins.run(4, 'c1', 1003, 'agent:box-2', 'image', JSON.stringify({ blob_ref: null, expired: true, name: 'gone.png' }), null)
  ins.run(5, 'c1', 1004, 'agent:box-2', 'text', JSON.stringify({ body: 'x', blob_ref: 'img1' }), null)
  ins.run(6, 'c1', 1005, 'agent:box-2', 'image', JSON.stringify({ blob_ref: 42, name: 'bad.png' }), null)
  db.close()

  db = openDb(dbPath)
  const refs = db.prepare('SELECT seq, blob_ref FROM events ORDER BY seq').all()
  assert.deepEqual(refs, [
    { seq: 1, blob_ref: 'img1' },
    { seq: 2, blob_ref: 'file2' },
    { seq: 3, blob_ref: 'img3' },
    { seq: 4, blob_ref: null },
    { seq: 5, blob_ref: null },
    { seq: 6, blob_ref: null },
  ])
  db.close()
  assert.doesNotThrow(() => openDb(dbPath).close(), 'backfill must be idempotent on the next boot')
})

test('openDb rebuilds an old person_rooms table for talk requests, keeping its rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-talk-migration-'))
  const dbPath = path.join(dir, 'pre-talk.db')
  // Build a current database, then put person_rooms back to its shape from
  // before talk requests (NOT NULL guest columns, no 'starting', no kind).
  openDb(dbPath).close()
  const raw = new Database(dbPath)
  raw.exec(`
    DROP TABLE person_rooms;
    CREATE TABLE person_rooms(
      id               TEXT PRIMARY KEY,
      owner_user_id    INTEGER NOT NULL REFERENCES users(id),
      owner_room_id    TEXT NOT NULL,
      owner_device_id  INTEGER NOT NULL,
      owner_convo_id   TEXT,
      owner_contact_id TEXT NOT NULL REFERENCES contacts(id),
      guest_user_id    INTEGER NOT NULL REFERENCES users(id),
      guest_device_id  INTEGER NOT NULL,
      guest_convo_id   TEXT NOT NULL,
      guest_room_id    TEXT,
      mission_id       TEXT,
      state            TEXT NOT NULL CHECK(state IN
                         ('awaiting_owner','awaiting_guest','invited','joined','declined','refused','withdrawn','left','expired')),
      topic            TEXT NOT NULL DEFAULT '',
      justification    TEXT NOT NULL DEFAULT '',
      owner_item_id    TEXT,
      guest_item_id    TEXT,
      ended_by         TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      answered_at      INTEGER,
      UNIQUE(owner_room_id, guest_device_id)
    );
    CREATE INDEX idx_person_rooms_owner_room ON person_rooms(owner_room_id, state);
  `)
  raw.pragma('foreign_keys = OFF')
  raw.prepare(`INSERT INTO person_rooms(id,owner_user_id,owner_room_id,owner_device_id,owner_contact_id,guest_user_id,guest_device_id,guest_convo_id,state,created_at,updated_at)
    VALUES('pr_1',1,'room',1,'ct_1',2,2,'s',  'joined',0,0)`).run()
  raw.close()

  const db = openDb(dbPath)
  const cols = db.prepare('PRAGMA table_info(person_rooms)').all()
  for (const c of ['kind', 'contact_by_talk', 'pick_options', 'spawn_id']) assert.ok(cols.some((x) => x.name === c), `missing ${c}`)
  assert.equal(cols.find((c) => c.name === 'guest_device_id').notnull, 0)
  assert.equal(cols.find((c) => c.name === 'guest_convo_id').notnull, 0)
  assert.equal(cols.find((c) => c.name === 'owner_contact_id').notnull, 0)
  const row = db.prepare("SELECT * FROM person_rooms WHERE id='pr_1'").get()
  assert.equal(row.state, 'joined')
  assert.equal(row.kind, 'session')
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_person_rooms_owner_room'").get(), 'indexes survive')
  db.pragma('foreign_keys = OFF')
  db.prepare("UPDATE person_rooms SET state='starting' WHERE id='pr_1'").run()
  db.close()
  assert.doesNotThrow(() => openDb(dbPath).close())
})

// AUTOINCREMENT only changes schema metadata. Remove it on disk to exercise
// the upgrade from the otherwise current upstream schema, including late columns.
function legacyDeviceIds(db) {
  db.unsafeMode(true)
  db.pragma('writable_schema = ON')
  db.prepare("UPDATE sqlite_master SET sql=replace(sql, ' AUTOINCREMENT', '') WHERE name='devices'").run()
  db.pragma('writable_schema = OFF')
  db.unsafeMode(false)
  db.prepare("DELETE FROM sqlite_sequence WHERE name='devices'").run()
}

test('device ids increase after agent revocation, client sign-out, and deleting every device', async (t) => {
  const db = openDb(':memory:')
  t.after(() => db.close())
  const user = await createUser(db, 'alice', 'password')
  const agent = createAgent(db, user.id, 'agent')
  revokeDevice(db, agent.deviceId)
  const client = await login(db, { username: 'alice', password: 'password', deviceName: 'phone' })
  assert.ok(client.deviceId > agent.deviceId)
  revokeDevice(db, client.deviceId)
  const next = createAgent(db, user.id, 'replacement')
  assert.ok(next.deviceId > client.deviceId)
  db.prepare('DELETE FROM devices').run()
  const direct = db.prepare("INSERT INTO devices(user_id,kind,name,token_hash,created_at) VALUES(?,'agent','direct','direct',0)").run(user.id)
  assert.ok(direct.lastInsertRowid > next.deviceId, 'implicit SQLite allocation also respects the sequence')
})

test('device id migration preserves columns, constraints, indexes, privacy objects and children', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-device-ids-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'journal.db')
  let db = openDb(dbPath)
  seedDevice(db, 1)
  seedDevice(db, 2)
  db.exec(`UPDATE devices SET private=1, private_eligible=1, private_pinned=1,
    push_level='all', push_key='key', sync_scope='for_you', default_model='model',
    consent_user_only=1, tag_char='A', apns_token='token', apns_env='prod' WHERE id=2;
    INSERT INTO convo_agents(convo_id,agent_device_id,initiator_device_id,state,created_at)
      VALUES('room',2,1,'joined',0);
    INSERT INTO seen_devices(device_id,first_at) VALUES(2,0);`)
  upsertDeviceStatus(db, { userId: 1, deviceId: 2, status: { connected: true }, reportedAt: 5 })
  const rows = db.prepare('SELECT * FROM devices ORDER BY id').all()
  const cols = db.pragma('table_info(devices)')
  const objects = () => db.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE type IN ('index','trigger','view') AND sql IS NOT NULL ORDER BY name`).all()
  const beforeObjects = objects()
  legacyDeviceIds(db)
  db.close()

  db = openDb(dbPath)
  assert.deepEqual(db.prepare('SELECT * FROM devices ORDER BY id').all(), rows)
  assert.deepEqual(db.pragma('table_info(devices)'), cols)
  assert.deepEqual(objects(), beforeObjects)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM convo_agents').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM device_status').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM seen_devices').get().n, 1)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
  assert.throws(() => db.prepare("UPDATE devices SET kind='invalid' WHERE id=2").run(), /CHECK/)
  assert.throws(() => db.prepare("UPDATE devices SET token_hash='h1' WHERE id=2").run(), /UNIQUE/)
  assert.throws(() => db.prepare("UPDATE devices SET apns_token='token' WHERE id=1").run(), /UNIQUE/)
  revokeDevice(db, 2)
  assert.ok(db.prepare('SELECT id FROM private_devices WHERE id=2').get(), 'revoked private identity stays private')
  for (const table of ['convo_agents', 'device_status', 'seen_devices']) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, `${table} still cascades on revoke`)
  }
  const fresh = createAgent(db, 1, 'replacement')
  assert.ok(fresh.deviceId > 2)
  revokeDevice(db, fresh.deviceId)
  db.close()
  db = openDb(dbPath)
  assert.ok(createAgent(db, 1, 'after-reopen').deviceId > fresh.deviceId)
  db.close()
})

for (const [name, reference] of [
  ['private tombstone', "INSERT INTO revoked_private_devices VALUES(80,1,0)"],
  ['conversation owner', "INSERT INTO conversations(id,owner_user_id,agent_device_id,created_at) VALUES('old',1,80,0)"],
  ['integer reference with quoted names', 'CREATE TABLE "historical\""records"("old_device_id" INTEGER); INSERT INTO "historical\""records" VALUES(80)'],
  ['client event key', "INSERT INTO events(user_id,seq,convo_id,ts,sender,type,payload,idem_key) VALUES(1,1,'old',0,'s','text','{}','client:80:retry')"],
  ['agent event key', "INSERT INTO events(user_id,seq,convo_id,ts,sender,type,payload,idem_key) VALUES(1,1,'old',0,'s','text','{}','agent:80:retry')"],
  ['child orphan before cleanup', "INSERT INTO device_status(device_id,user_id,reported_at,status) VALUES(80,1,0,'{}')"],
]) {
  test(`device id migration allocates above a dangling ${name}`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-device-reference-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const dbPath = path.join(dir, 'journal.db')
    let db = openDb(dbPath)
    seedDevice(db, 1)
    db.pragma('foreign_keys = OFF')
    db.exec(reference)
    legacyDeviceIds(db)
    db.close()
    db = openDb(dbPath)
    const fresh = createAgent(db, 1, 'replacement')
    assert.equal(fresh.deviceId, 81)
    if (name === 'conversation owner') {
      assert.equal(authorizeAgentWrite(db, 1, fresh.deviceId, 'old'), false)
    }
    if (name.includes('event key')) {
      assert.equal(db.prepare('SELECT idem_key FROM events').get().idem_key.split(':')[1], '80')
    }
    db.close()
  })
}

test('device id migration ignores malformed and overflowing event key ids', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-device-key-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'journal.db')
  let db = openDb(dbPath)
  seedDevice(db, 1)
  const insert = db.prepare("INSERT INTO events(user_id,seq,convo_id,ts,sender,type,payload,idem_key) VALUES(1,?,'old',0,'s','text','{}',?)")
  for (const [i, key] of ['client:999junk:x', 'agent:9223372036854775808:x', 'client:-900:x', 'other:999:x', 'client:1e9:x'].entries()) {
    insert.run(i + 1, key)
  }
  legacyDeviceIds(db)
  db.close()
  db = openDb(dbPath)
  assert.equal(createAgent(db, 1, 'replacement').deviceId, 2)
  db.close()
})

test('device id migration rolls back its schema changes if the rebuild fails', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-device-rollback-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'journal.db')
  const db = openDb(dbPath)
  seedDevice(db, 1)
  db.exec('CREATE TABLE devices_ai(block_rebuild INTEGER)')
  legacyDeviceIds(db)
  const objects = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()
  db.close()
  assert.throws(() => openDb(dbPath), /already exists/)
  const raw = new Database(dbPath)
  assert.deepEqual(raw.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(), objects)
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM devices').get().n, 1)
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM private_devices').get().n, 0)
  raw.close()
})
