import Database from 'better-sqlite3'
import { healBakedTitles } from './heal-titles.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('client','agent')),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  cursor INTEGER NOT NULL DEFAULT 0,
  apns_token TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS conversations(
  id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL DEFAULT '',
  session_state TEXT NOT NULL DEFAULT 'running'
    CHECK(session_state IN ('running','waiting','done','archived')),
  last_seq INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  snippet TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events(
  user_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  convo_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  sender TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  blob_ref TEXT,
  idem_key TEXT,
  PRIMARY KEY(user_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_convo ON events(convo_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idem
  ON events(user_id, convo_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS user_seq(
  user_id INTEGER PRIMARY KEY,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blobs(
  id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  disk_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS link_preapprovals(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
-- \`agent_device_id\` cascades from devices deliberately. \`devices.id\` is a
-- plain INTEGER PRIMARY KEY, so SQLite hands a deleted rowid straight to the
-- next device created; a membership row that outlives its device therefore
-- grants a brand new agent write access to an old room (authorizeAgentWrite)
-- purely by inheriting its number. Enforcing that in the schema rather than
-- at each revoke site is the point: revocation happens from the HTTP route
-- and from the admin CLI, and the CLI used to forget.
--
-- \`initiator_device_id\` has NO such constraint, and must not: it records who
-- ASKED, and a still-pending row whose requester was revoked is a real row
-- the owner may still want to see (listAwaiting LEFT JOINs devices for
-- exactly this case). Cascading there would delete live asks.
CREATE TABLE IF NOT EXISTS convo_agents(
  convo_id TEXT NOT NULL,
  agent_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  initiator_device_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('awaiting_user','invited','joined','refused','denied','left','expired')),
  justification TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  delivered_at INTEGER,
  PRIMARY KEY(convo_id, agent_device_id)
);
CREATE TABLE IF NOT EXISTS agent_spawn_requests(
  id                TEXT PRIMARY KEY,
  user_id           INTEGER NOT NULL,
  from_device_id    INTEGER NOT NULL,
  from_convo_id     TEXT NOT NULL,
  target_device_id  INTEGER NOT NULL,
  workdir           TEXT NOT NULL,
  task              TEXT NOT NULL,
  topic             TEXT NOT NULL DEFAULT '',
  state             TEXT NOT NULL CHECK(state IN
                      ('awaiting_user','approved','started',
                       'denied','expired','failed')),
  room_id           TEXT,
  child_convo_id    TEXT,
  created_at        INTEGER NOT NULL,
  answered_at       INTEGER,
  resolved_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_spawn_state ON agent_spawn_requests(state, from_device_id);
-- Search index (spec: agent journal search). Deliberately INSERT-trigger
-- only: \`events\` is append-only — plain INSERT in journal.js append(), no
-- DELETE anywhere, and retention only rewrites tool_output payloads, which
-- indexableBody never indexes — so no update/delete trigger can ever be
-- needed. If a delete/update path is ever added to \`events\`, this schema
-- must be revisited (external-content FTS corrupts when content rows change
-- without the matching fts delete — matron-apple #106). Never INSERT OR
-- REPLACE into search_messages for the same reason.
CREATE TABLE IF NOT EXISTS search_messages(
  rowid     INTEGER PRIMARY KEY,
  user_id   INTEGER NOT NULL,
  convo_id  TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  sender    TEXT NOT NULL,
  body      TEXT NOT NULL,
  UNIQUE(user_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_search_messages_convo ON search_messages(convo_id, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  body,
  content='search_messages',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS search_messages_ai AFTER INSERT ON search_messages BEGIN
  INSERT INTO search_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TABLE IF NOT EXISTS search_backfill_state(
  id INTEGER PRIMARY KEY CHECK(id=1),
  last_events_rowid INTEGER NOT NULL
);
`

export function openDb(path) {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // Half of the WAL-checkpoint tail mitigation (measured, not guessed; full
  // method and numbers in docs/wal-checkpoint-profile.md): the WAL file
  // truncates back to <=4MiB on checkpoint reset instead of holding its
  // high-water size forever. Safe and useful for EVERY opener (server, admin
  // CLI, tests). The other half — wal_autocheckpoint=0 — is applied by
  // startServer only, because it is only correct alongside the server's 1s
  // PASSIVE-checkpoint timer; a standalone opener like the admin CLI keeps
  // SQLite's stock inline auto-checkpoint so a long one-shot run (e.g. a
  // backlog retention offload) cannot grow the WAL unbounded.
  db.pragma('journal_size_limit = 4194304')
  db.exec(SCHEMA)
  // The live DB on dev-2 predates apns_env (only apns_token existed) — in-place
  // migration, never a destructive rebuild. Sygnal lesson: environment
  // ('sandbox'|'prod') has to be tracked per device, not assumed from topic.
  const deviceCols = db.prepare('PRAGMA table_info(devices)').all()
  if (!deviceCols.some((c) => c.name === 'apns_env')) {
    db.exec('ALTER TABLE devices ADD COLUMN apns_env TEXT')
  }
  // Per-device notification prefs (spec: push relay + notification settings).
  // JSON {"attention":bool,"done":bool,"activity":bool}; NULL (every device
  // predating this column) means all-on. Same in-place ALTER pattern as
  // apns_env above.
  if (!deviceCols.some((c) => c.name === 'push_prefs')) {
    db.exec('ALTER TABLE devices ADD COLUMN push_prefs TEXT')
  }
  // Per-device agent-visibility flag (spec: agent visibility & privacy).
  // `private=1` = invisible and unreachable to OTHER agent devices — not to
  // the user's own client devices, which see everything unchanged. Enforced
  // at: GET /roster, GET /search, around_seq context reads, room ops (via
  // loadRoom) and invite targeting, read_marker, convo_upsert's
  // private-owner takeover guard, GET /snapshot, and GET /metrics — see
  // docs/protocol.md "Device privacy" for the full enumeration.
  // `private_pinned=1` records that
  // matron-admin owns the flag: the bridge's per-hello assertion is ignored
  // while pinned, so a deploy that forgot MATRON_AGENT_PRIVATE can never
  // silently unmark a machine (admin wins — spec precedence decision).
  if (!deviceCols.some((c) => c.name === 'private')) {
    db.exec('ALTER TABLE devices ADD COLUMN private INTEGER NOT NULL DEFAULT 0')
  }
  if (!deviceCols.some((c) => c.name === 'private_pinned')) {
    db.exec('ALTER TABLE devices ADD COLUMN private_pinned INTEGER NOT NULL DEFAULT 0')
  }
  // An APNs token names a physical app install, so at most one device row may
  // hold it. Re-pairing creates a NEW device row, and until setApnsRegistration
  // learned to claim the token, every superseded row kept it: on dev-2 one Mac
  // token was spread across 18 rows, so a single event fanned out as 18 sends
  // to the same device and APNs 429'd all but one (~9,300 rate_limited in a
  // day). Collapse the historical duplicates, newest row wins — it is the live
  // registration, the older ones are dead re-pairs. Runs before the unique
  // index below, which is what keeps the invariant true from here on.
  db.exec(`
    UPDATE devices SET apns_token=NULL, apns_env=NULL
     WHERE apns_token IS NOT NULL
       AND id < (SELECT MAX(d2.id) FROM devices d2 WHERE d2.apns_token = devices.apns_token)
  `)
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_apns_token ON devices(apns_token) WHERE apns_token IS NOT NULL')
  // Which agent device manages this conversation — recorded by convo_upsert,
  // read by the delivery scoping in ws.js/hub.js. NULL (every row predating
  // this column, or a convo whose bridge hasn't re-upserted yet) means
  // "unknown": those keep the legacy broadcast-to-all-agents delivery.
  // Deliberately NOT a foreign key: device revocation is a bare DELETE on
  // devices (revokeDevice), and a dangling owner id here must never block
  // it — a dangling id simply matches no live connection.
  const convoCols = db.prepare('PRAGMA table_info(conversations)').all()
  if (!convoCols.some((c) => c.name === 'agent_device_id')) {
    db.exec('ALTER TABLE conversations ADD COLUMN agent_device_id INTEGER')
  }
  // Links a subagent's durable child conversation to its parent conversation
  // (spec: subagent sub-chats). Set once at creation by convo_upsert and
  // immutable afterwards (see upsertConversation). NULL for every normal
  // conversation and every row predating this column. Deliberately NOT a
  // foreign key — same rationale as agent_device_id, and a child's upsert may
  // legitimately arrive before its parent's row exists (ordering between the
  // two is not guaranteed), so a dangling reference must be storable as-is.
  if (!convoCols.some((c) => c.name === 'parent_convo_id')) {
    db.exec('ALTER TABLE conversations ADD COLUMN parent_convo_id TEXT')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent_convo_id)')
  // How a session ENDED, as distinct from session_state's where-is-it-now
  // (spec: Codex run visualization). A Codex child run finishes 'completed',
  // 'interrupted' or 'failed' — all three land in session_state 'done', so the
  // distinction needs its own column. NULL for every normal conversation and
  // every row predating this column, which is what clients render as "no
  // outcome to show".
  //
  // Deliberately NOT a CHECK constraint, unlike session_state. The vocabulary
  // is the writing bridge's, not the journal's: a bridge that grows a fourth
  // outcome must not start failing writes against an older server. Shape is
  // validated at the ws boundary (non-empty bounded string) and clients
  // already render an unrecognised value as "status unknown", so an unknown
  // outcome degrades instead of breaking.
  if (!convoCols.some((c) => c.name === 'session_outcome')) {
    db.exec('ALTER TABLE conversations ADD COLUMN session_outcome TEXT')
  }
  // Rolling 2-3 sentence conversation summary, maintained by the owning
  // bridge's title pass (spec: agent chat phase 2) — roster targeting
  // metadata. Same don't-clobber discipline as title: only an upsert that
  // carries it changes it.
  if (!convoCols.some((c) => c.name === 'summary')) {
    db.exec("ALTER TABLE conversations ADD COLUMN summary TEXT NOT NULL DEFAULT ''")
  }
  // Keeps the per-user quota SUM (see userBlobBytes) a cheap index scan rather
  // than a full-table read as the blob store grows.
  db.exec('CREATE INDEX IF NOT EXISTS idx_blobs_owner ON blobs(owner_user_id)')
  // SQLite cannot ALTER a CHECK constraint, so convo_agents needs a rebuild to
  // add consent states (awaiting_user, denied) and new columns (topic, delivered_at).
  // delivered_at = created_at is correct for pre-consent flow (rows were delivered
  // at creation or the row was deleted and recreated).
  const caDef = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='convo_agents'").get()
  if (caDef && !caDef.sql.includes('awaiting_user')) {
    db.exec(`
      CREATE TABLE convo_agents_new(
        convo_id TEXT NOT NULL,
        agent_device_id INTEGER NOT NULL,
        initiator_device_id INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('awaiting_user','invited','joined','refused','denied','left','expired')),
        justification TEXT NOT NULL DEFAULT '',
        topic TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        answered_at INTEGER,
        delivered_at INTEGER,
        PRIMARY KEY(convo_id, agent_device_id)
      );
      INSERT INTO convo_agents_new(convo_id, agent_device_id, initiator_device_id, state, justification, created_at, answered_at, delivered_at)
        SELECT convo_id, agent_device_id, initiator_device_id, state, justification, created_at, answered_at, created_at FROM convo_agents;
      DROP TABLE convo_agents;
      ALTER TABLE convo_agents_new RENAME TO convo_agents;
    `)
  }
  // Which of the target device's conversations the requester actually meant
  // (spec: agent chat phase 3.5). An agent picks a CONVERSATION off /roster,
  // but the invite used to resolve down to that conversation's owning DEVICE
  // and drop the convo id — so a receiving bridge running several sessions
  // could not tell which was meant, guessed at the most recently active one,
  // and landed a stranger's chat request in an unrelated conversation.
  // NULL = a pre-3.5 requester that never sent one; the receiver falls back
  // to its old guess for those, so the column is additive in both directions.
  //
  // Deliberately AFTER the CHECK-constraint rebuild above: that path recreates
  // the table from a fixed definition, so an ALTER placed before it would be
  // dropped on exactly the databases that take both migrations.
  const convoAgentCols = db.prepare('PRAGMA table_info(convo_agents)').all()
  if (!convoAgentCols.some((c) => c.name === 'target_convo_id')) {
    db.exec('ALTER TABLE convo_agents ADD COLUMN target_convo_id TEXT')
  }
  // Retrofit the agent_device_id -> devices cascade onto databases created
  // before it (see the CREATE TABLE above for why it exists). Last of the
  // convo_agents migrations for the same reason the ALTER is second: this
  // recreates the table from a fixed definition, so anything placed after it
  // would be lost on the databases that take every migration.
  //
  // The copy filters rows whose device is already gone. That is not
  // defensive tidying — those rows are the bug this constraint closes, left
  // behind by `matron-admin device revoke`, and with foreign_keys=ON the
  // INSERT would fail outright rather than carry them across.
  const caNow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='convo_agents'").get()
  if (caNow && !caNow.sql.includes('ON DELETE CASCADE')) {
    const orphans = db.prepare(
      'SELECT COUNT(*) n FROM convo_agents WHERE agent_device_id NOT IN (SELECT id FROM devices)'
    ).get().n
    db.exec(`
      CREATE TABLE convo_agents_fk(
        convo_id TEXT NOT NULL,
        agent_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        initiator_device_id INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('awaiting_user','invited','joined','refused','denied','left','expired')),
        justification TEXT NOT NULL DEFAULT '',
        topic TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        answered_at INTEGER,
        delivered_at INTEGER,
        target_convo_id TEXT,
        PRIMARY KEY(convo_id, agent_device_id)
      );
      INSERT INTO convo_agents_fk
        SELECT convo_id, agent_device_id, initiator_device_id, state, justification, topic,
               created_at, answered_at, delivered_at, target_convo_id
          FROM convo_agents WHERE agent_device_id IN (SELECT id FROM devices);
      DROP TABLE convo_agents;
      ALTER TABLE convo_agents_fk RENAME TO convo_agents;
    `)
    if (orphans > 0) {
      console.log(`convo_agents: dropped ${orphans} membership row(s) whose device was already revoked`)
    }
  }
  // Standing agent-chat consent ("always allow A -> B") is gone: every ask
  // parks for the user now. Dropped rather than left in place, because a
  // table of grants that nothing consults still reads like a live security
  // control to the next person who finds it.
  db.exec('DROP TABLE IF EXISTS agent_chat_allowances')
  // One-time title cleanup (spec: agent box rename). Gated on user_version
  // inside, so this is a cheap pragma read on every subsequent open.
  healBakedTitles(db, { log: (m) => console.log(m) })
  return db
}

export function insertBlob(db, { id, ownerUserId, contentType, size, sha256, diskPath }) {
  db.prepare(
    'INSERT INTO blobs(id, owner_user_id, content_type, size, sha256, disk_path, created_at) VALUES(?,?,?,?,?,?,?)'
  ).run(id, ownerUserId, contentType, size, sha256, diskPath, Date.now())
}

export function getBlob(db, id) {
  return db.prepare('SELECT * FROM blobs WHERE id=?').get(id)
}

// Total on-disk bytes attributed to a user's blobs — the input to the
// per-user media quota enforced in POST /media (http.js). Counts every blob
// the user owns, including retention-offloaded tool_output payloads, since
// they consume the same disk. COALESCE so a user with no blobs reads 0, not
// NULL.
export function userBlobBytes(db, userId) {
  return db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM blobs WHERE owner_user_id=?').get(userId).bytes
}

// `apnsToken: null` unregisters (both columns cleared together — a token
// without a known environment is unsendable, so they're always set/cleared
// as a pair).
//
// Registering CLAIMS the token: any other row still holding it is cleared
// first, across users as well as within one. A token names a physical app
// install, and re-pairing mints a fresh device row rather than reusing the
// old one, so without this every re-pair left another row pointing at the
// same device — the push pipeline then sent one event N times to it and APNs
// 429'd the surplus. The cross-user case is a privacy rule as much as a
// rate-limit one: a device handed to someone else must stop receiving its
// previous owner's notifications. Unregistering scavenges nothing — it
// touches only the caller's own row.
export function setApnsRegistration(db, deviceId, { apnsToken, apnsEnv }) {
  if (apnsToken != null) {
    db.prepare('UPDATE devices SET apns_token=NULL, apns_env=NULL WHERE apns_token=? AND id<>?').run(apnsToken, deviceId)
  }
  db.prepare('UPDATE devices SET apns_token=?, apns_env=? WHERE id=?').run(apnsToken, apnsEnv, deviceId)
}

// Notification prefs, per device (that's where the APNs token lives too).
// Default: attention and done on, activity off — "buzz me when the agent
// needs me or finishes; routine activity is opt-in." NULL / unparseable /
// non-object all fall back to that default wholesale: a corrupt row must
// fail open on attention/done (the two that matter most), not silence
// every push. Per key, an explicit boolean in the stored JSON always wins
// in either direction (on or off); anything else for that key falls back
// to its default.
export function parsePushPrefs(text) {
  const prefs = { attention: true, done: true, activity: false }
  if (!text) return prefs
  let parsed
  try { parsed = JSON.parse(text) } catch { return prefs }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return prefs
  for (const k of Object.keys(prefs)) {
    if (typeof parsed[k] === 'boolean') prefs[k] = parsed[k]
  }
  return prefs
}

// Partial update: only boolean fields in `partial` override the stored
// state; everything else keeps its current value. Always writes the full
// three-key shape so a stored row never depends on merge-at-read.
export function setPushPrefs(db, deviceId, partial) {
  const row = db.prepare('SELECT push_prefs FROM devices WHERE id=?').get(deviceId)
  const merged = parsePushPrefs(row ? row.push_prefs : null)
  for (const k of Object.keys(merged)) {
    if (typeof partial[k] === 'boolean') merged[k] = partial[k]
  }
  db.prepare('UPDATE devices SET push_prefs=? WHERE id=?').run(JSON.stringify(merged), deviceId)
  return merged
}

// Read the current push prefs for a device (the read half of the setPushPrefs pair).
export function getPushPrefs(db, deviceId) {
  const row = db.prepare('SELECT push_prefs FROM devices WHERE id=?').get(deviceId)
  return parsePushPrefs(row ? row.push_prefs : null)
}

// Called by the push pipeline on a 410 Unregistered response — the token is
// dead, so stop trying it rather than retrying forever (sygnal lesson).
export function pruneApnsToken(db, deviceId) {
  db.prepare('UPDATE devices SET apns_token=NULL, apns_env=NULL WHERE id=?').run(deviceId)
}

// Client devices (never agent — agents are never pushed to) with a
// registered token, for the push pipeline to fan a journal event out to.
export function clientDevicesForPush(db, userId) {
  return db.prepare(
    "SELECT id, apns_token, apns_env, cursor, push_prefs FROM devices WHERE user_id=? AND kind='client' AND apns_token IS NOT NULL"
  ).all(userId)
}

// The unread badge = SUM(unread_count) over the owner's conversations.
export function unreadBadge(db, userId) {
  return db.prepare('SELECT COALESCE(SUM(unread_count),0) AS n FROM conversations WHERE owner_user_id=?').get(userId).n
}

// Roster for GET /devices — same devices+user_seq read as buildMetrics
// (src/metrics.js), plus name/created_at, which metrics deliberately omits.
// token_hash and user_id never leave this function.
export function listDevices(db, userId) {
  const head = db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(userId)
  const headSeq = head ? head.seq : 0
  return db.prepare(
    'SELECT id AS device_id, kind, name, created_at, cursor, last_seen_at, push_prefs FROM devices WHERE user_id=? ORDER BY id'
  ).all(userId).map((d) => ({ ...d, lag: headSeq - d.cursor, push_prefs: parsePushPrefs(d.push_prefs) }))
}

// The privacy flag, read side. False for unknown ids: a caller checking a
// dangling/deleted device must fall through to the normal not_found path,
// not crash.
export function isPrivateDevice(db, deviceId) {
  return !!db.prepare('SELECT 1 FROM devices WHERE id=? AND private=1').get(deviceId)
}

// matron-admin's write: sets the value AND takes ownership (pin). Both
// directions pin — `off` is "force-visible", not "hands off".
export function pinDevicePrivate(db, deviceId, value) {
  db.prepare('UPDATE devices SET private=?, private_pinned=1 WHERE id=?').run(value ? 1 : 0, deviceId)
}

// Hands the flag back to the bridge's hello assertion. Deliberately does not
// touch the value — the next hello does.
export function unpinDevicePrivate(db, deviceId) {
  db.prepare('UPDATE devices SET private_pinned=0 WHERE id=?').run(deviceId)
}

// The bridge's per-hello assertion (MATRON_AGENT_PRIVATE on the bridge
// side). A no-op while pinned. Hello-without-the-field asserts false — a
// bridge-set flag does NOT survive a re-register without the env var; an
// admin-set one does (the pin).
export function applyBridgePrivate(db, deviceId, value) {
  db.prepare('UPDATE devices SET private=? WHERE id=? AND private_pinned=0').run(value ? 1 : 0, deviceId)
}
