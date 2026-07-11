import Database from 'better-sqlite3'

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
`

export function openDb(path) {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
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
