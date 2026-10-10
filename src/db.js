import Database from 'better-sqlite3'
import { healBakedTitles } from './heal-titles.js'
import { autoTitleColumns, recomputeConvoTitle } from './convo-title.js'
import { imageSizeFromFile } from './image-size.js'
import { backfillMissionLinks, healMissionLinks } from './mission-links.js'
import { backfillDefaultProjects } from './default-project.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices(
  -- AUTOINCREMENT, not a plain rowid: a plain INTEGER PRIMARY KEY
  -- hands a deleted device's number straight to the next insert, so a
  -- replacement inherits the revoked device's identity — and with it the
  -- revoked device's idempotency namespace, since idemKeyOf embeds who.deviceId
  -- (\`<deviceId>:<key>\`). AUTOINCREMENT makes the id monotonic and never
  -- reused, closing that at the source. The downstream workarounds that were
  -- built while this id was reusable (file_idem's revoke trigger + gen + SET
  -- NULL detach, agent_idem's incarnation-binding migration, the convo_agents
  -- cascade) are LEFT in place here as belt-and-braces and removed in a
  -- follow-up — this change only re-bases the invariant they defend.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
-- A project's "Files and images" (projects-feed.js) reads only these rows.
CREATE INDEX IF NOT EXISTS idx_events_media ON events(convo_id, seq) WHERE type IN ('image', 'file');
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idem
  ON events(user_id, convo_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS agent_idem(
  key TEXT PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_idem_expires ON agent_idem(expires_at);
-- Durable idempotency for the file WRITE API. Separate from
-- agent_idem because the unit of replay is an HTTP OUTCOME (status + body),
-- not an appended event seq, and because a row has to survive the process that
-- created it: the in-memory store this replaces lost every reservation on
-- restart, so a client retry crossing one re-executed its move/delete/upload.
-- The key column already carries the calling device (idemKeyOf prefixes it
-- with the device id), so there is no device column here: the 120s TTL, not a
-- revocation cascade, is what bounds this table.
CREATE TABLE IF NOT EXISTS file_idem(
  key TEXT PRIMARY KEY,
  -- The device INCARNATION that reserved this row, not just the id encoded in
  -- the key. devices.id is a reusable rowid, so without this a revoked device's
  -- rows are inherited by whichever replacement is handed the same number.
  --
  -- Revocation splits by state, because the two states fail in opposite
  -- directions. A SETTLED row is a cached response: inherited, it answers a
  -- replacement with the previous incarnation's result, so the trigger below
  -- deletes it. A PENDING row is a live exclusion record, and its work may
  -- still be running — cascading it away would let a retry execute a second
  -- time, which for an upload or a move destroys data. So it is detached
  -- (device_id → NULL) and kept as a tombstone: unowned, charged to no one's
  -- quota, swept at the orphan retention bound, and refusing its key until
  -- then. A replacement colliding on that key is refused rather than served or
  -- joined — the safe direction, and the collision needs both id reuse and the
  -- same client-chosen key.
  device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  -- Identifies THIS reservation, not just its key. The key is chosen by the
  -- client and the device id it embeds is reusable, so after a revoke the same
  -- key can legitimately belong to a different reservation. Bookkeeping that
  -- addressed rows by key alone could then let an in-flight operation from the
  -- revoked incarnation settle, or delete, the replacement's row.
  gen TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  -- Which server process reserved this row. A 'pending' row whose boot_id is
  -- not ours crossed a restart: its outcome is UNKNOWN, never assumed.
  boot_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','done')),
  -- JSON {op, path, to?, contentHash?}: what the row was reserved to do, so a
  -- crossed-restart retry can ask the filesystem whether it happened.
  intent TEXT,
  status INTEGER,
  body TEXT,
  content_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_idem_expires ON file_idem(expires_at);
CREATE INDEX IF NOT EXISTS idx_file_idem_device ON file_idem(device_id);
-- Fires before the FK's SET NULL detaches the rest, so only reservations that
-- have already answered are discarded with the device.
CREATE TRIGGER IF NOT EXISTS file_idem_drop_settled_on_revoke BEFORE DELETE ON devices BEGIN
  DELETE FROM file_idem WHERE device_id=OLD.id AND state='done';
END;
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
  model             TEXT,
  link              INTEGER NOT NULL DEFAULT 1,
  child_short       TEXT,
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
-- Task & decision tracker (spec: 2026-09-08 task-decision-tracker). Tables
-- are the source of truth; the conversation log only carries 'item' marker
-- events written by src/items-http.js. CHECKs list every value src/items.js
-- writes (the convo_agents lesson: an unlisted value fails silently).
CREATE TABLE IF NOT EXISTS items(
  id               TEXT PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  num              INTEGER NOT NULL,
  kind             TEXT NOT NULL CHECK(kind IN ('task','question','decision','notice')),
  state            TEXT NOT NULL CHECK(state IN ('open','closed')),
  resolution       TEXT CHECK(resolution IN ('done','answered','decided','reversed','cancelled')),
  awaiting         TEXT CHECK(awaiting IN ('user','agent')),
  rank             REAL NOT NULL,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL DEFAULT '',
  labels           TEXT NOT NULL DEFAULT '[]',
  links            TEXT NOT NULL DEFAULT '[]',
  supersedes       TEXT REFERENCES items(id),
  origin_convo_id  TEXT NOT NULL,
  origin_device_id INTEGER NOT NULL,
  created_by       TEXT NOT NULL CHECK(created_by IN ('user','agent')),
  idem_key         TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  closed_at        INTEGER,
  UNIQUE(user_id, num),
  UNIQUE(user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_items_user_state ON items(user_id, state, rank);
CREATE INDEX IF NOT EXISTS idx_items_convo ON items(origin_convo_id, state);
CREATE INDEX IF NOT EXISTS idx_items_updated ON items(user_id, updated_at);
CREATE TABLE IF NOT EXISTS item_comments(
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES items(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  author      TEXT NOT NULL CHECK(author IN ('user','agent')),
  device_id   INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK(kind IN ('comment','status')),
  body        TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '[]',
  meta        TEXT,
  idem_key    TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE(user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_item_comments_item ON item_comments(item_id, created_at);
CREATE TABLE IF NOT EXISTS item_counters(
  user_id  INTEGER PRIMARY KEY,
  next_num INTEGER NOT NULL
);
-- Missions & milestones (spec: 2026-09-10 missions-milestones). Tables are
-- the source of truth; the conversation log carries 'mission' and
-- 'milestone' marker events written only by src/missions-http.js. Numbers
-- come from item_counters, the same counter as items (#61 names one thing).
CREATE TABLE IF NOT EXISTS missions(
  id                     TEXT PRIMARY KEY,
  user_id                INTEGER NOT NULL REFERENCES users(id),
  num                    INTEGER NOT NULL,
  state                  TEXT NOT NULL CHECK(state IN ('open','closed')),
  title                  TEXT NOT NULL,
  body                   TEXT NOT NULL DEFAULT '',
  close_summary          TEXT,
  closed_by              TEXT CHECK(closed_by IN ('user','agent')),
  closed_over_open_items INTEGER NOT NULL DEFAULT 0,
  origin_convo_id        TEXT NOT NULL,
  origin_device_id       INTEGER NOT NULL,
  created_by             TEXT NOT NULL CHECK(created_by IN ('user','agent')),
  idem_key               TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  last_milestone_at      INTEGER,
  closed_at              INTEGER,
  UNIQUE(user_id, num),
  UNIQUE(user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_missions_user_state ON missions(user_id, state, last_milestone_at);
CREATE TABLE IF NOT EXISTS milestones(
  id          TEXT PRIMARY KEY,
  mission_id  TEXT NOT NULL REFERENCES missions(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  num         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK(kind IN ('user_input','progress')),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  convo_id    TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  device_id   INTEGER NOT NULL,
  created_by  TEXT NOT NULL CHECK(created_by IN ('user','agent')),
  idem_key    TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE(user_id, num),
  UNIQUE(user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_milestones_mission ON milestones(mission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_milestones_convo ON milestones(convo_id, seq);
-- Search index (spec: agent journal search). Deliberately INSERT-trigger
-- only: \`events\` is append-only — plain INSERT in journal.js append(), no
-- DELETE anywhere, and the only paths that rewrite an event's payload are
-- retention's tool_output offload/expire passes and the media reaper's
-- file/image tombstones (runReapMedia) — all three touch only types that
-- indexableBody never indexes (it reads text/prompt/prompt_reply bodies) —
-- so no update/delete trigger can ever be needed. If a delete/update path
-- for an INDEXED type is ever added to \`events\`, or indexableBody grows to
-- read file/image captions or tool_output, this schema must be revisited
-- (external-content FTS corrupts when content rows change without the
-- matching fts delete — matron-apple #106). Never INSERT OR REPLACE into
-- search_messages for the same reason.
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
-- A second mirror of the same content, unstemmed, for the apps' typed
-- modes (src/search.js "Typed matching"): there a query means the words
-- as typed, and the word still being typed is a prefix. Neither survives
-- the porter index — "run" would find "running", and a prefix "runn"
-- matches nothing because the stored token is "run". Same content table,
-- same insert-only discipline; \`openDb\` rebuilds it once when it is new.
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts_plain USING fts5(
  body,
  content='search_messages',
  content_rowid='rowid',
  tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS search_messages_ai_plain AFTER INSERT ON search_messages BEGIN
  INSERT INTO search_fts_plain(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TABLE IF NOT EXISTS search_backfill_state(
  id INTEGER PRIMARY KEY CHECK(id=1),
  last_events_rowid INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS device_status(
  device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  reported_at INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_status_user ON device_status(user_id);
-- Per-conversation session header (spec 2026-09-29 coordinator session
-- control §1): the persisted subset of the bridge's status op — model,
-- context gauge, usage-limit stall, account meters — so the roster and a
-- mission's conversations can answer "how full is that session" for a box
-- that is asleep or a journal that has restarted. Same shape as
-- device_status: JSON per row, latest wins, goes with the conversation.
CREATE TABLE IF NOT EXISTS conversation_status(
  convo_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  reported_at INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_status_user ON conversation_status(user_id);
-- Per-user settings (spec 2026-09-23 coordinator redesign §1a). A table, not
-- a users column, so later per-user settings have a home. No row = every
-- setting at its default. coordinator_convo_id is not a foreign key — same
-- stance as conversations.mission_id; ownership is checked on write.
CREATE TABLE IF NOT EXISTS user_settings(
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  coordinator_convo_id TEXT,
  coordinator_consent INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
-- Coordinator consent decisions (spec: matron-bridge 2026-09-29 coordinator
-- consent): one row per ask the Coordinator answered — the audit record and
-- the rolling 24 h approval cap's counter. A user's own tap never writes one.
CREATE TABLE IF NOT EXISTS consent_decisions(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL CHECK(kind IN ('chat','spawn')),
  ask_id     TEXT NOT NULL,
  decision   TEXT NOT NULL CHECK(decision IN ('approve','decline')),
  convo_id   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consent_decisions_user ON consent_decisions(user_id, created_at);
-- Memories (spec: 2026-09-27 memories): the user's shared agent memory.
-- One row per name; PUT /memories/:name overwrites. origin_convo_id is
-- deliberately not a foreign key — deleting the conversation a memory was
-- saved from must not delete the memory (same stance as
-- user_settings.coordinator_convo_id). origin_private is the origin device's
-- privacy flag snapshotted at save time: the row outlives the device
-- (revokeDevice deletes the row, and SQLite may hand the id to the next
-- device), so a live join would flip visibility when the device goes.
CREATE TABLE IF NOT EXISTS memories(
  id               TEXT PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  name             TEXT NOT NULL,
  type             TEXT NOT NULL CHECK(type IN ('user','feedback','project','reference')),
  description      TEXT NOT NULL,
  body             TEXT NOT NULL DEFAULT '',
  origin_convo_id  TEXT,
  origin_device_id INTEGER,
  origin_private   INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT NOT NULL CHECK(created_by IN ('user','agent')),
  updated_by       TEXT NOT NULL CHECK(updated_by IN ('user','agent')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  scope            TEXT NOT NULL DEFAULT 'global',
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, updated_at);
-- Conversation ↔ mission links (spec 2026-09-30 projects & mission links
-- §3). One row per (mission, conversation) the conversation ever worked on:
-- ended_at NULL = active ("on it now"), set = history ("earlier").
-- conversations.mission_id stays as the CURRENT pointer — invariant: when it
-- is non-null an active link exists for it. No foreign keys (same stance as
-- conversations.mission_id); ownership is checked on write.
CREATE TABLE IF NOT EXISTS mission_conversations(
  mission_id TEXT NOT NULL,
  convo_id   TEXT NOT NULL,
  user_id    INTEGER NOT NULL,
  how        TEXT NOT NULL CHECK(how IN ('origin','joined','spawned','inherited','backfill')),
  joined_at  INTEGER NOT NULL,
  ended_at   INTEGER,
  PRIMARY KEY(mission_id, convo_id)
);
CREATE INDEX IF NOT EXISTS idx_mc_convo ON mission_conversations(convo_id, ended_at);
-- Projects (spec 2026-09-30 §4): groups of missions. Numbered from
-- item_counters like items/missions/milestones. status_device_id and
-- idem_key are internal (never on the wire). merged_into names the project a
-- merge closed this one into.
CREATE TABLE IF NOT EXISTS projects(
  id                        TEXT PRIMARY KEY,
  user_id                   INTEGER NOT NULL REFERENCES users(id),
  num                       INTEGER NOT NULL,
  state                     TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),
  title                     TEXT NOT NULL,
  body                      TEXT NOT NULL DEFAULT '',
  status                    TEXT,
  status_by                 TEXT CHECK(status_by IN ('user','agent')),
  status_convo_id           TEXT,
  status_device_id          INTEGER,
  status_updated_at         INTEGER,
  close_summary             TEXT,
  closed_by                 TEXT CHECK(closed_by IN ('user','agent')),
  closed_over_open_missions INTEGER NOT NULL DEFAULT 0,
  closed_at                 INTEGER,
  merged_into               TEXT,
  origin_convo_id           TEXT,
  origin_device_id          INTEGER NOT NULL,
  created_by                TEXT NOT NULL CHECK(created_by IN ('user','agent')),
  idem_key                  TEXT,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  UNIQUE(user_id, num),
  UNIQUE(user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_projects_user_state ON projects(user_id, state);
-- Read state (spec 2026-09-30 read state). What the user has actually SEEN,
-- as reported by their client apps: separate from read_marker/unread_count,
-- which stay the badge's business. Seq ranges per conversation, coalesced on
-- write (src/seen.js) so a normally-read conversation is one or a few rows.
-- No foreign keys: same stance as mission_conversations; ownership is checked
-- on write.
CREATE TABLE IF NOT EXISTS seen_ranges(
  user_id   INTEGER NOT NULL,
  convo_id  TEXT NOT NULL,
  from_seq  INTEGER NOT NULL,
  to_seq    INTEGER NOT NULL,
  seen_at   INTEGER NOT NULL,
  PRIMARY KEY(user_id, convo_id, from_seq)
);
-- Client devices that report precise ranges. A client read_marker from a
-- device NOT listed here counts as "seen up to that seq" (the legacy
-- fallback for apps that don't send ranges yet).
CREATE TABLE IF NOT EXISTS seen_devices(
  device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  first_at  INTEGER NOT NULL
);
-- Item threads: the item itself, and its comments up to a created_at.
CREATE TABLE IF NOT EXISTS item_seen(
  user_id                 INTEGER NOT NULL,
  item_id                 TEXT NOT NULL,
  seen_through_comment_at INTEGER NOT NULL DEFAULT 0,
  seen_at                 INTEGER NOT NULL,
  PRIMARY KEY(user_id, item_id)
);
-- What an agent has already raised with the user (the no-repeat rule).
CREATE TABLE IF NOT EXISTS unseen_flags(
  user_id             INTEGER NOT NULL,
  ref                 TEXT NOT NULL,
  flagged_at          INTEGER NOT NULL,
  flagged_in_convo_id TEXT NOT NULL,
  PRIMARY KEY(user_id, ref)
);
-- The unseen nudge's memory: when the Coordinator was last nudged, and
-- every entry a nudge has named, so an entry is nudged about once (even one
-- that only becomes important after a later entry was nudged).
CREATE TABLE IF NOT EXISTS unseen_nudges(
  user_id INTEGER PRIMARY KEY,
  last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS unseen_nudged(
  user_id  INTEGER NOT NULL,
  ref      TEXT NOT NULL,
  nudged_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, ref)
);
-- Coordinator routines (spec 2026-10-01 coordinator routines): a schedule
-- (or a trigger) and a prompt the journal owns and fires into whichever
-- conversation holds the Coordinator role. Exactly one of schedule (5-field
-- cron in tz) and trigger (JSON: context_over / stalled / disk_under) is
-- set. next_at is the next scheduled fire in ms (NULL while paused, and
-- always NULL for a triggered routine); retry_at the one retry after a
-- failed delivery (internal, never on the wire). Names are the handle
-- agents and prompts use, unique per user.
CREATE TABLE IF NOT EXISTS routines(
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,
  title         TEXT NOT NULL,
  schedule      TEXT,
  trigger       TEXT,
  tz            TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  origin        TEXT NOT NULL CHECK(origin IN ('seed','user','agent')),
  next_at       INTEGER,
  retry_at      INTEGER,
  last_fired_at INTEGER,
  last_outcome  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(user_id, name),
  CHECK((schedule IS NULL) <> (trigger IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_routines_due ON routines(enabled, next_at);
-- A triggered routine's currently-tripped subjects (convo:<id> or
-- device:<id>): a row means this crossing has been fired for; it is removed
-- when the condition clears, so the next crossing fires again.
CREATE TABLE IF NOT EXISTS routine_trigger_state(
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  subject    TEXT NOT NULL,
  tripped_at INTEGER NOT NULL,
  PRIMARY KEY(routine_id, subject)
);
-- Coordinator briefings (spec 2026-10-04 latest briefing): what the
-- Coordinator published as a briefing (its sweep and status updates), with
-- the conversation and seq of the chat message the journal wrote for it —
-- the apps' "Open in chat" anchor. The newest BRIEFINGS_KEEP per user are
-- kept. briefing_refresh is the one refresh the user may have asked for:
-- pending until a briefing is published after requested_at, it fails or
-- BRIEFING_REFRESH_TIMEOUT_MS passes.
CREATE TABLE IF NOT EXISTS briefings(
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  convo_id   TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_briefings_user ON briefings(user_id, created_at);
CREATE TABLE IF NOT EXISTS briefing_refresh(
  user_id      INTEGER PRIMARY KEY REFERENCES users(id),
  requested_at INTEGER NOT NULL,
  outcome      TEXT
);
-- Contacts and grants (spec 2026-10-02 matron-to-matron sharing, phase 1).
-- A contact is one row PER SIDE; nothing is shared except between two rows
-- that are both 'active'. peer_user is the address's user part and
-- peer_journal its journal (NULL = this journal — the only kind phase 1
-- writes; peer_journal_key is federation's pinned key). peer_user_id is the
-- local users row of a same-journal peer: what every join uses, never on
-- the wire. 'awaiting_user' is an ask the user's own agent made and the
-- user has not approved yet. A row is reused when a request is made again
-- after a decline, removal or expiry (the convo_agents renewal stance), so
-- (user, address) is unique. origin_* name where an agent's ask was made
-- and item_id its tracker mirror (consent-items) — not foreign keys, same
-- stance as conversations.mission_id.
CREATE TABLE IF NOT EXISTS contacts(
  id               TEXT PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  peer_user        TEXT NOT NULL,
  peer_journal     TEXT,
  peer_journal_key TEXT,
  peer_user_id     INTEGER REFERENCES users(id),
  display_name     TEXT NOT NULL DEFAULT '',
  state            TEXT NOT NULL CHECK(state IN
                     ('awaiting_user','pending_out','pending_in','active','blocked','declined','removed','expired')),
  requested_by     TEXT CHECK(requested_by IN ('user','agent')),
  origin_convo_id  TEXT,
  origin_device_id INTEGER,
  item_id          TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  accepted_at      INTEGER,
  revoked_at       INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_address ON contacts(user_id, peer_user, COALESCE(peer_journal, ''));
CREATE INDEX IF NOT EXISTS idx_contacts_peer ON contacts(peer_user_id, user_id);
-- A grant: the owner of a subject lets one contact in at a level. Only
-- subject_kind 'mission' at level 'read' is exercised in phase 1; the other
-- values are the spec's and are refused by the route, not the schema.
-- contact_id is the OWNER's contact row. 'awaiting_owner' is an ask the
-- owner's agent made that the owner has not approved; 'pending' waits for
-- the grantee's accept. One row per (subject, contact), renewed like a
-- contact row. revoked_by says which side ended it.
CREATE TABLE IF NOT EXISTS grants(
  id               TEXT PRIMARY KEY,
  owner_user_id    INTEGER NOT NULL REFERENCES users(id),
  subject_kind     TEXT NOT NULL CHECK(subject_kind IN ('mission','project','room')),
  subject_id       TEXT NOT NULL,
  contact_id       TEXT NOT NULL REFERENCES contacts(id),
  level            TEXT NOT NULL CHECK(level IN ('read','contribute','owner')),
  state            TEXT NOT NULL CHECK(state IN ('awaiting_owner','pending','active','declined','revoked','expired')),
  requested_by     TEXT CHECK(requested_by IN ('user','agent')),
  origin_convo_id  TEXT,
  origin_device_id INTEGER,
  owner_item_id    TEXT,
  grantee_item_id  TEXT,
  revoked_by       TEXT CHECK(revoked_by IN ('owner','grantee','contact_removed')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  answered_at      INTEGER,
  revoked_at       INTEGER,
  UNIQUE(subject_kind, subject_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_grants_subject ON grants(subject_kind, subject_id, state);
CREATE INDEX IF NOT EXISTS idx_grants_contact ON grants(contact_id, state);
CREATE INDEX IF NOT EXISTS idx_grants_owner ON grants(owner_user_id, state);
-- A session a user lets one contact's agents address (spec 2026-10-02
-- matron-to-matron sharing, phase 2: "sessions the contact has opted to
-- expose by name"). contact_id is the SHARER's contact row for the peer.
-- 'awaiting_user' is an ask the sharer's own agent made, not yet approved.
-- One row per (session, contact), renewed like a contact row.
CREATE TABLE IF NOT EXISTS session_shares(
  id               TEXT PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  convo_id         TEXT NOT NULL,
  contact_id       TEXT NOT NULL REFERENCES contacts(id),
  state            TEXT NOT NULL CHECK(state IN ('awaiting_user','active','declined','revoked','expired')),
  requested_by     TEXT CHECK(requested_by IN ('user','agent')),
  origin_device_id INTEGER,
  item_id          TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  revoked_at       INTEGER,
  UNIQUE(convo_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_session_shares_contact ON session_shares(contact_id, state);
-- A room between two people's agents (phase 2): the owner's room, in the
-- owner's log, and its twin in the guest's log, created when the guest
-- accepts. The journal copies each message from one into the other; each
-- side's events, replay, cursors and read state stay its own. The convo_agents
-- rows of the two rooms carry the agent-facing membership exactly as for a
-- same-user room; this row carries the two people's consent:
--   awaiting_owner  the owner's agent asked; the owner has not approved
--   awaiting_guest  the owner approved; the guest person has not accepted
--   invited         the guest accepted; the invite is with the guest agent
--   joined          the guest agent joined
--   declined (owner said no) refused (guest person or agent said no)
--   withdrawn left expired (ended)
-- owner_contact_id is the owner's contact row for the guest. mission_id is
-- the owner's mission the room is attached to, if any.
CREATE TABLE IF NOT EXISTS person_rooms(
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_person_rooms_guest_room ON person_rooms(guest_room_id) WHERE guest_room_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_person_rooms_owner_room ON person_rooms(owner_room_id, state);
CREATE INDEX IF NOT EXISTS idx_person_rooms_contact ON person_rooms(owner_contact_id, state);
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
  // BEFORE the schema exec, and it has to be: SCHEMA builds
  // idx_file_idem_device, and creating that index over a table that predates
  // the column raises `no such column: device_id` — which does not just skip
  // the repair below, it throws out of openDb and wedges every opener, server
  // and admin CLI alike, against exactly the database this is meant to fix.
  //
  // A drop is the whole migration: file_idem is introduced by the same
  // unreleased change that added device_id, so there are no production rows to
  // preserve. A column-less table can only exist in a dev checkout that ran an
  // earlier commit of this branch, and SCHEMA recreates it on the next line.
  // The SHAPE of the table, not just its column names. This branch revised
  // file_idem three times — device_id, then gen, then the cascade becoming a
  // detach — so a dev database can hold any of those intermediate forms, and
  // `CREATE TABLE IF NOT EXISTS` repairs none of them. Checking column names
  // alone would accept the revision whose foreign key still says CASCADE,
  // which quietly restores the bug that revision removed: a revoke would
  // delete a PENDING reservation whose work is still running, and a reused
  // device id with the same key would then execute it a second time.
  //
  // Inspect, drop and create in ONE immediate transaction. Both the server and
  // the admin CLI open this database, and split across three statements two
  // concurrent openers can each see the stale table — the second then either
  // fails on a table that is no longer there or drops the correct one the
  // first just built. The write lock serialises them, and the loser re-reads
  // under it and finds nothing to do.
  db.transaction(() => {
    const cols = db.prepare('PRAGMA table_info(file_idem)').all()
    const fk = db.prepare('PRAGMA foreign_key_list(file_idem)').all().find((r) => r.from === 'device_id')
    const deviceCol = cols.find((c) => c.name === 'device_id')
    const stale = cols.length && !(
      deviceCol && deviceCol.notnull === 0
      && cols.some((c) => c.name === 'gen')
      && fk && fk.table === 'devices'
      && String(fk.on_delete).toUpperCase() === 'SET NULL'
    )
    if (stale) {
      db.exec('DROP TABLE file_idem')
      console.log('file_idem: dropped a pre-release dev table whose shape predates this revision; recreating')
    }
    // The unstemmed search mirror is populated by trigger from here on; a
    // database that predates it has rows to index. 'rebuild' reads the
    // content table (seconds for a few hundred thousand prose rows).
    const hadPlainFts = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='search_fts_plain'").get()
    db.exec(SCHEMA)
    if (!hadPlainFts) db.exec("INSERT INTO search_fts_plain(search_fts_plain) VALUES('rebuild')")
  }).immediate()
  // Older live DBs predate apns_env (only apns_token existed) — in-place
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
  // private-owner takeover guard, GET /snapshot, GET /metrics, and
  // GET /missions, GET /missions/:id, GET /milestones — see
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
  // Bind peer-message idempotency rows to the device incarnation that wrote
  // them. devices.id is a reusable rowid, so retaining a dedupe row after
  // revocation could otherwise suppress a replacement device's first send.
  // Existing rows predate the explicit device_id column; their keys are
  // server-generated as `agent:<device id>:<bridge key>`, so preserve only
  // rows whose encoded device existed when the row was written (expires_at
  // minus the fixed 120s TTL). That timestamp check also rejects a stale row
  // if its numeric id was already reused before this migration. Rows for
  // revoked/replacement devices are intentionally discarded because the new
  // cascade would have removed them.
  const agentIdemCols = db.prepare('PRAGMA table_info(agent_idem)').all()
  const agentIdemFks = db.prepare('PRAGMA foreign_key_list(agent_idem)').all()
  const agentIdemHasDevice = agentIdemCols.some((c) => c.name === 'device_id')
  const agentIdemHasCascade = agentIdemFks.some((fk) => (
    fk.from === 'device_id' && fk.table === 'devices' && fk.to === 'id'
    && String(fk.on_delete).toUpperCase() === 'CASCADE'
  ))
  if (!agentIdemHasDevice || !agentIdemHasCascade) {
    const before = db.prepare('SELECT COUNT(*) AS n FROM agent_idem').get().n
    const copy = agentIdemHasDevice
      ? `SELECT ai.key, ai.device_id, ai.seq, ai.expires_at
           FROM agent_idem ai JOIN devices d ON d.id=ai.device_id
          WHERE d.created_at <= ai.expires_at - 120000`
      : `SELECT ai.key, d.id, ai.seq, ai.expires_at
           FROM agent_idem ai JOIN devices d
             ON ai.key LIKE 'agent:' || d.id || ':%'
          WHERE d.created_at <= ai.expires_at - 120000`
    db.transaction(() => {
      db.exec(`
        CREATE TABLE agent_idem_fk(
          key TEXT PRIMARY KEY,
          device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        INSERT INTO agent_idem_fk(key, device_id, seq, expires_at) ${copy};
        DROP TABLE agent_idem;
        ALTER TABLE agent_idem_fk RENAME TO agent_idem;
        CREATE INDEX idx_agent_idem_expires ON agent_idem(expires_at);
      `)
    })()
    const dropped = before - db.prepare('SELECT COUNT(*) AS n FROM agent_idem').get().n
    if (dropped > 0) {
      console.log(`agent_idem: dropped ${dropped} row(s) whose device was already revoked`)
    }
  }
  // User-chosen roster tag character (spec: box tag characters). ONE grapheme,
  // NULL = automatic (clients derive a letter from the name). Journal-held so
  // the same letter shows on every device — it used to live in each app's
  // local defaults, which is exactly why it never followed the user.
  if (!deviceCols.some((c) => c.name === 'tag_char')) {
    db.exec('ALTER TABLE devices ADD COLUMN tag_char TEXT')
  }
  // When the wake command last refused this box (exit 2: not a box it can
  // start — a Mac, say). NULL = never refused, or woken since. See
  // isWakeableDevice in src/wake.js.
  if (!deviceCols.some((c) => c.name === 'wake_refused_at')) {
    db.exec('ALTER TABLE devices ADD COLUMN wake_refused_at INTEGER')
  }
  // A box whose asks only the user may approve: POST /consent/answer
  // refuses a Coordinator approval of any ask this device takes part in
  // (src/consent.js isUserOnlyAsk). Admin-set only (matron-admin device
  // consent); no bridge can assert or clear it.
  if (!deviceCols.some((c) => c.name === 'consent_user_only')) {
    db.exec('ALTER TABLE devices ADD COLUMN consent_user_only INTEGER NOT NULL DEFAULT 0')
  }
  // Retrofit AUTOINCREMENT onto a devices table that predates it.
  // SQLite has no ALTER to add AUTOINCREMENT, so the table is rebuilt — and
  // devices is a PARENT (agent_idem, file_idem and convo_agents all reference
  // devices(id)), so unlike the child-table rebuilds above this one must run
  // with foreign_keys OFF: with it ON, DROP TABLE devices would fire every
  // child's ON DELETE action and wipe/detach their rows. Placed AFTER every
  // devices ADD COLUMN so the rebuilt shape is the full, stable column set, and
  // BEFORE the apns dedupe + unique index below so that index lands on the new
  // table for free. The BEFORE DELETE trigger is dropped with the old table and
  // recreated by re-running SCHEMA (IF NOT EXISTS makes every other object a
  // no-op) — sourcing it from the canonical text rather than a hand-copy that
  // could drift.
  //
  // The explicit-id copy alone seeds sqlite_sequence only to MAX(live device
  // id) — which is NOT enough. A device deleted before the migration can still
  // be REFERENCED by a durable, non-cascading integer column, above all
  // `conversations.agent_device_id`, which authorizeAgentWrite treats as
  // conversation ownership (it is deliberately not a foreign key, so a revoke
  // leaves it dangling). If such a dangling id is the highest ever issued, the
  // live-max seed would hand it straight back to the next device, which would
  // then inherit write access to the revoked agent's conversation. The retained
  // idempotency/convo_agents workarounds do not cover that column. So the
  // sequence is seeded to the high-water mark across EVERY durable device-id
  // reference, guaranteeing no id that was ever issued — live or dangling — is
  // reissued from here on.
  const devicesSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'").get()
  if (devicesSql && !/AUTOINCREMENT/i.test(devicesSql.sql)) {
    db.pragma('foreign_keys = OFF')
    try {
      db.transaction(() => {
        // Columns added after the base shape (wake_refused_at, consent_user_only,
        // push_level, box defaults ...) ride along when the old table has them,
        // so the rebuild never drops data an earlier migration step added.
        const baseCols = ['id', 'user_id', 'kind', 'name', 'token_hash', 'cursor', 'apns_token',
          'created_at', 'last_seen_at', 'apns_env', 'push_prefs', 'private', 'private_pinned', 'tag_char']
        const extraCols = db.prepare('PRAGMA table_info(devices)').all()
          .filter((c) => !baseCols.includes(c.name) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name))
        const extraDdl = extraCols.map((c) =>
          `, ${c.name} ${/^[A-Za-z ]*$/.test(c.type) ? c.type : 'TEXT'}${c.notnull && c.dflt_value != null ? ` NOT NULL DEFAULT ${c.dflt_value}` : ''}`).join('')
        const copyCols = baseCols.concat(extraCols.map((c) => c.name)).join(', ')
        db.exec(`
          CREATE TABLE devices_ai(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            kind TEXT NOT NULL CHECK(kind IN ('client','agent')),
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
            tag_char TEXT${extraDdl}
          );
          INSERT INTO devices_ai(${copyCols})
            SELECT ${copyCols} FROM devices;
          DROP TABLE devices;
          ALTER TABLE devices_ai RENAME TO devices;
        `)
        // Recreate the trigger dropped with the old table, from the canonical
        // SCHEMA (every other CREATE ... IF NOT EXISTS is a no-op here).
        db.exec(SCHEMA)
        // Lift the sequence above every surviving device-id reference, not just
        // the live device rows, so a revoked-but-still-referenced id (e.g. a
        // dangling conversation owner, an item's origin_device_id, or a
        // milestone's device_id) is never reissued and cannot inherit that
        // reference's meaning (ownership, idempotency replay, attribution).
        //
        // The reference set is DISCOVERED from the schema, not hand-listed — a
        // hand-list silently diverges as columns are added (P2 canonical
        // source). Two kinds of reference:
        //   1. Integer columns: devices.id plus every column named `device_id`
        //      or `*_device_id` in any table. This auto-covers items, missions,
        //      milestones, item_comments, conversations, convo_agents,
        //      agent_spawn_requests, file_idem and agent_idem — and any future
        //      column that follows the same naming convention.
        //   2. `events.idem_key`, the ONLY persistent namespace that encodes a
        //      device id with no sibling integer column (`client:<id>:<local>`
        //      / `agent:<id>:<key>`, id as the 2nd colon segment). Every other
        //      idem_key column (items/missions/milestones/item_comments) sits in
        //      a row that also carries an integer *_device_id, already covered
        //      by (1); a detached file_idem key (device_id NULL) is left to
        //      file_idem's own colliding-key refusal + 120s TTL (retained).
        // Quote an identifier from the schema by doubling embedded quotes — the
        // names come from sqlite_master/PRAGMA, not user input, but a table or
        // column legally containing a `"` would otherwise generate invalid SQL
        // and wedge the migration on every restart.
        const qid = (id) => `"${String(id).replace(/"/g, '""')}"`
        let highWater = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM devices').get().m
        for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
          for (const c of db.prepare(`PRAGMA table_info(${qid(t.name)})`).all()) {
            if (c.name === 'device_id' || /_device_id$/.test(c.name)) {
              const v = db.prepare(`SELECT MAX(${qid(c.name)}) AS m FROM ${qid(t.name)}`).get().m
              if (v != null && v > highWater) highWater = v
            }
          }
        }
        const eventsExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get()
        if (eventsExists) {
          // 2nd colon segment of `<scheme>:<id>:<rest>`. Only a canonical, in-
          // range decimal counts: SQLite's CAST accepts a numeric PREFIX, so
          // `client:<huge>junk:x` would otherwise cast to a giant value and seed
          // the sequence to it (SQLITE_FULL on the next insert). The GLOB filter
          // requires all-digits and length ≤ 18 (< 10^18, safely inside int64),
          // so any suffix, sign, whitespace, scientific notation or overflow
          // width is excluded rather than truncated to a huge integer.
          const ev = db.prepare(`
            SELECT COALESCE(MAX(CAST(seg AS INTEGER)), 0) AS m
              FROM (SELECT substr(rest, 1, instr(rest || ':', ':') - 1) AS seg
                      FROM (SELECT substr(idem_key, instr(idem_key, ':') + 1) AS rest
                              FROM events
                             WHERE idem_key LIKE 'client:%:%' OR idem_key LIKE 'agent:%:%'))
             WHERE length(seg) BETWEEN 1 AND 18 AND seg NOT GLOB '*[^0-9]*'
          `).get().m
          if (ev > highWater) highWater = ev
        }
        const seqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='devices'").get()
        if (seqRow) {
          if (highWater > seqRow.seq) {
            db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='devices'").run(highWater)
          }
        } else if (highWater > 0) {
          db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES('devices', ?)").run(highWater)
        }
        // Validate BEFORE commit, scoped to children that reference devices
        // (parent==='devices'): those are the only violations THIS rebuild could
        // introduce (a device row the copy dropped while a child still points at
        // it). Throwing here rolls the whole rebuild back, so a failed audit
        // cannot be silently "completed" by the AUTOINCREMENT DDL landing and the
        // guard above skipping the migration on the next restart. Scoped rather
        // than whole-DB so a pre-existing unrelated orphan (e.g. a device whose
        // user_id no longer resolves) does not wedge every opener against a
        // condition this migration neither caused nor fixes.
        const violations = db.pragma('foreign_key_check').filter((v) => v.parent === 'devices')
        if (violations.length) {
          throw new Error(`devices AUTOINCREMENT migration orphaned a child reference: ${JSON.stringify(violations)}`)
        }
      })()
      console.log('devices: rebuilt with AUTOINCREMENT so revoked ids are never reused')
    } finally {
      // Always restore enforcement, even if the transaction rolled back — a
      // failed migration must not leave this connection running with foreign
      // keys off for the rest of the process.
      db.pragma('foreign_keys = ON')
    }
  }
  // An APNs token names a physical app install, so at most one device row may
  // hold it. Re-pairing creates a NEW device row, and until setApnsRegistration
  // learned to claim the token, every superseded row kept it: on one deployment one Mac
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
  // Which KIND of agent backs this conversation — e.g. 'claude' or 'codex' —
  // recorded by convo_upsert (spec: codex forwarder icon). Distinct from
  // agent_device_id: one agent device (a bridge) hosts BOTH claude and codex
  // sessions and stamps the same agent_device_id on every conversation it owns,
  // so the owning device cannot distinguish the backend — the kind is a
  // per-conversation fact. NULL for every normal conversation and every row
  // predating this column, which clients render as "no agent-kind marker".
  //
  // Deliberately NOT a CHECK constraint, mirroring session_outcome: the
  // vocabulary is the writing bridge's, not the journal's. A bridge that grows
  // a third backend must not start failing writes against an older server.
  // Shape is validated at the ws boundary (non-empty bounded string) and
  // clients render an unrecognised value as no marker, so an unknown kind
  // degrades instead of breaking. Mutable last-write-wins (COALESCE) like
  // session_outcome — a conversation can switch backend (a claude<->codex
  // agent switch) and an upsert that omits it leaves the recorded kind alone.
  if (!convoCols.some((c) => c.name === 'agent_kind')) {
    db.exec('ALTER TABLE conversations ADD COLUMN agent_kind TEXT')
  }
  // Rolling 2-3 sentence conversation summary, maintained by the owning
  // bridge's title pass (spec: agent chat phase 2) — roster targeting
  // metadata. Same don't-clobber discipline as title: only an upsert that
  // carries it changes it.
  if (!convoCols.some((c) => c.name === 'summary')) {
    db.exec("ALTER TABLE conversations ADD COLUMN summary TEXT NOT NULL DEFAULT ''")
  }
  // Epoch-ms of the last summary CHANGE (0 = never, including every row that
  // predates this column). The operator's pinned-summary surface needs
  // freshness: the bridge's digest lags the conversation by up to five
  // messages, and a stale digest rendered in a bar labelled "Summary" above a
  // live timeline reads as current when it isn't. Written ONLY when the
  // summary actually changes (see upsertConversation), never on an upsert
  // that merely re-sends the value it already stored — a bridge backfilling
  // its saved digests on reconnect must not stamp months-old text as fresh,
  // which is the precise lie this column exists to prevent.
  if (!convoCols.some((c) => c.name === 'summary_updated_at')) {
    db.exec('ALTER TABLE conversations ADD COLUMN summary_updated_at INTEGER NOT NULL DEFAULT 0')
  }
  // Displayed pixel size of an image blob (spec: 2026-10-01 item thread
  // layout shift), read from the file's own header by image-size.js. NULL =
  // not read yet (blobs from before this column; backfillImageDims and
  // blobImageDims fill them in), 0 × 0 = read, and not an image we can size.
  const blobCols = db.prepare('PRAGMA table_info(blobs)').all()
  if (!blobCols.some((c) => c.name === 'width')) db.exec('ALTER TABLE blobs ADD COLUMN width INTEGER')
  if (!blobCols.some((c) => c.name === 'height')) db.exec('ALTER TABLE blobs ADD COLUMN height INTEGER')
  // A voice note's words, transcribed at upload when the journal has a cloud
  // transcriber (blob-transcripts.js). transcript_status NULL = never asked,
  // else 'pending' | 'done' | 'failed'; transcript is set only when 'done'.
  if (!blobCols.some((c) => c.name === 'transcript')) db.exec('ALTER TABLE blobs ADD COLUMN transcript TEXT')
  if (!blobCols.some((c) => c.name === 'transcript_status')) db.exec('ALTER TABLE blobs ADD COLUMN transcript_status TEXT')
  // When the words landed: the clock runExpireVoiceNotes (retention.js)
  // measures a chat voice note's audio life from.
  if (!blobCols.some((c) => c.name === 'transcribed_at')) db.exec('ALTER TABLE blobs ADD COLUMN transcribed_at INTEGER')
  // Keeps the per-user quota SUM (see userBlobBytes) a cheap index scan rather
  // than a full-table read as the blob store grows.
  db.exec('CREATE INDEX IF NOT EXISTS idx_blobs_owner ON blobs(owner_user_id)')
  // Media reaper (runReapMedia) probes events by blob_ref three ways
  // (candidate join, tool_output guard, tombstone refs) — without this,
  // each is a full events scan, synchronous, inside the listen callback.
  // Partial: most events carry no blob_ref.
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_blob_ref ON events(blob_ref) WHERE blob_ref IS NOT NULL')
  // One-off repair, idempotent and cheap (idx_events_media narrows the scan
  // to attachment rows; 1,255 rows in ~5 ms on the 1.4M-event production
  // db): image/file events whose blob is named only inside the payload.
  // Agent publishes set no top-level blob_ref until ws.js publishBlobRef
  // learned to fall back to payload.blob_ref (2026-10-02), so the reaper —
  // which joins on this column — could not see any agent-posted attachment.
  // Tombstones (blob_ref: null) and non-string refs are left alone, as are
  // all other event types (a text row naming a blob is not an attachment).
  db.exec(`UPDATE events SET blob_ref = json_extract(payload, '$.blob_ref')
    WHERE type IN ('image', 'file') AND blob_ref IS NULL AND json_valid(payload)
      AND json_type(payload, '$.blob_ref') = 'text'`)
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
  // Which of the REQUESTER's conversations asked (agent_invite's
  // from_convo_id). The card always showed it; now it is also persisted and
  // relayed on the request frame, because the invited bridge keys its
  // one-room-per-pair lookup on the peer device PLUS the peer's conversation
  // and could only ever learn the device — so a guest calling the inviter
  // back found no room and opened a second one in the other direction. NULL
  // for a pre-existing row or a requester that named no conversation. After
  // both rebuilds above, for the reason target_convo_id is.
  const caColsBefore = db.prepare('PRAGMA table_info(convo_agents)').all()
  if (!caColsBefore.some((c) => c.name === 'initiator_convo_id')) {
    db.exec('ALTER TABLE convo_agents ADD COLUMN initiator_convo_id TEXT')
  }
  // Consent items (spec 2026-09-22 consent-items): the tracker item that
  // mirrors a parked chat ask, NULL for rows predating the mirror. After
  // BOTH convo_agents rebuilds above for the reason target_convo_id is: a
  // rebuild recreates the table from a fixed definition. A renewed row
  // (a fresh ask after a deny/expiry) gets a fresh item, overwriting this.
  const caCols = db.prepare('PRAGMA table_info(convo_agents)').all()
  if (!caCols.some((c) => c.name === 'item_id')) {
    db.exec('ALTER TABLE convo_agents ADD COLUMN item_id TEXT')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_convo_agents_item ON convo_agents(item_id)')
  // Room participant conversations (participant_convos, see
  // participantConvoIds in participants.js). Both additive; each backfills
  // exactly what the previous derivation produced, once, when it first
  // appears, so no live room's list changes at deploy.
  //
  // convo_agents.spawn_id: the spawn whose approval created this membership
  // generation (recordJoined), reset to NULL by any renewal. A started
  // spawn's child counts only while that same generation is joined. After
  // both convo_agents rebuilds above, for the reason target_convo_id is.
  // Backfill: the old rule (a joined row created no later than the start).
  const caColsSpawn = db.prepare('PRAGMA table_info(convo_agents)').all()
  if (!caColsSpawn.some((c) => c.name === 'spawn_id')) {
    db.exec('ALTER TABLE convo_agents ADD COLUMN spawn_id TEXT')
    db.exec(`
      UPDATE convo_agents SET spawn_id = (
        SELECT s.id FROM agent_spawn_requests s
         WHERE s.room_id = convo_agents.convo_id AND s.target_device_id = convo_agents.agent_device_id
           AND s.state = 'started' AND convo_agents.created_at <= s.resolved_at
         ORDER BY s.created_at DESC LIMIT 1)
       WHERE state = 'joined'`)
  }
  // room_owner_convos: the room owner's sessions that accepted membership
  // brought in (an accepted owner invite's initiator_convo_id, a started
  // spawn's from_convo_id) — kept off the membership row because a re-invite
  // renews that row. Dissolve deletes a room's rows. Backfill: the old
  // owner-side rule, for rooms with a joined row (others were not showing
  // any owner session and a dissolved one must not get them back).
  const hasOwnerConvos = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='room_owner_convos'").get()
  if (!hasOwnerConvos) {
    db.exec(`
      CREATE TABLE room_owner_convos(
        room_id TEXT NOT NULL,
        convo_id TEXT NOT NULL,
        device_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(room_id, convo_id)
      );
      INSERT OR IGNORE INTO room_owner_convos(room_id, convo_id, device_id, created_at)
        SELECT room_id, convo_id, device_id, created_at FROM (
          SELECT ca.convo_id AS room_id, ca.initiator_convo_id AS convo_id, ca.initiator_device_id AS device_id, ca.created_at AS created_at, ca.rowid AS rk, 0 AS sub
            FROM convo_agents ca JOIN conversations r ON r.id = ca.convo_id
           WHERE ca.initiator_device_id = r.agent_device_id AND ca.state IN ('joined','left') AND ca.initiator_convo_id IS NOT NULL
          UNION ALL
          SELECT s.room_id, s.from_convo_id, s.from_device_id, s.created_at, s.rowid, 1
            FROM agent_spawn_requests s JOIN conversations r ON r.id = s.room_id
           WHERE s.state = 'started' AND s.from_device_id = r.agent_device_id
        ) o
        WHERE EXISTS(SELECT 1 FROM convo_agents j WHERE j.convo_id = o.room_id AND j.state = 'joined')
        ORDER BY created_at, rk, sub;
    `)
  }
  // Which Claude model the spawned session should run (spec: agent-spawned
  // sessions). An alias like 'opus' or a full model id — the target bridge's
  // vocabulary, not the journal's, so no CHECK: a bridge that learns a new
  // alias must not start failing against an older server, exactly the
  // session_outcome stance above. Shape is bounded at the ws boundary
  // (SPAWN_MODEL_MAX_CHARS) and relayed only when non-empty, so a target that
  // predates the field sees the same `start` params it always saw.
  //
  // Nullable rather than NOT NULL DEFAULT '' (topic's shape) because rows
  // predating this column read NULL and no backfill can invent an answer for
  // them; every reader is a falsy test, so '' and NULL mean the same thing —
  // "the requester named no model".
  const spawnCols = db.prepare('PRAGMA table_info(agent_spawn_requests)').all()
  if (!spawnCols.some((c) => c.name === 'model')) {
    db.exec('ALTER TABLE agent_spawn_requests ADD COLUMN model TEXT')
  }
  // The reasoning effort the spawned session should start at ('high'), the
  // target bridge's --effort vocabulary. Same stance as model: no CHECK,
  // bounded at the ws boundary (SPAWN_EFFORT_MAX_CHARS), nullable for rows
  // predating it, relayed only when non-empty.
  if (!spawnCols.some((c) => c.name === 'effort')) {
    db.exec('ALTER TABLE agent_spawn_requests ADD COLUMN effort TEXT')
  }
  // The agent the spawned session should run ('claude' | 'codex'), when the
  // requester named one (matron-bridge docs/specs/box-defaults.md). NULL =
  // the target box's own default — and every row predating the column.
  if (!spawnCols.some((c) => c.name === 'agent')) {
    db.exec('ALTER TABLE agent_spawn_requests ADD COLUMN agent TEXT')
  }
  // Whether the approved spawn opens a chat room between parent and child
  // (2026-09-17: rooms are opt-in — a spawn is normally a clean break, and
  // an automatic room made the child narrate its progress back to a parent
  // that then relayed it on). DEFAULT 1, not 0: a row parked before the
  // column existed was asked under the always-linked contract, and the
  // card the user is about to tap promised a room. New rows always write
  // the value explicitly (createSpawnRequest), so the default only ever
  // speaks for those pre-migration rows.
  if (!spawnCols.some((c) => c.name === 'link')) {
    db.exec('ALTER TABLE agent_spawn_requests ADD COLUMN link INTEGER NOT NULL DEFAULT 1')
  }
  // The child's session short as first learned from its published title —
  // frozen there so the linked room's title never follows a later child
  // rename (bridge rooms freeze the peer short at creation the same way).
  // NULL until the child's bridge publishes a title with a short.
  if (!spawnCols.some((c) => c.name === 'child_short')) {
    db.exec('ALTER TABLE agent_spawn_requests ADD COLUMN child_short TEXT')
  }
  // Spawning onto a mission (spec 2026-09-23 coordinator redesign §1c): the
  // per-user mission #num the child joins as soon as its conversation is
  // known. NULL = no mission (every row predating the column). A number,
  // not an id — it is what the asking agent named and what the card shows.
  if (!spawnCols.some((c) => c.name === 'mission_num')) {
    db.exec('ALTER TABLE agent_spawn_requests ADD COLUMN mission_num INTEGER')
  }
  // Consent items (spec 2026-09-22 consent-items): the tracker item that
  // mirrors this ask, NULL for rows predating the mirror (they resolve
  // without one). Not a foreign key — same stance as mission_id.
  if (!spawnCols.some((c) => c.name === 'item_id')) {
    db.exec('ALTER TABLE agent_spawn_requests ADD COLUMN item_id TEXT')
  }
  // items.js isConsentMirror / listItems' excludeConsent look items up by
  // this column on every agent read; keep both point lookups.
  db.exec('CREATE INDEX IF NOT EXISTS idx_spawn_item ON agent_spawn_requests(item_id)')
  // refreshSpawnRoomTitle (spawns.js) looks a started row up by its child
  // on every titled convo_upsert; keep that a point lookup.
  db.exec('CREATE INDEX IF NOT EXISTS idx_spawn_child ON agent_spawn_requests(child_convo_id)')
  // Missions (spec 2026-09-10): conversations.mission_id is the
  // conversation's CURRENT mission (spec 2026-09-30: see
  // mission_conversations); an item follows its origin conversation but
  // can be moved (PATCH /items/:id {mission}). Both are NULL for every row
  // predating the column. Placed here, after every table-rebuild block, so
  // a rebuild can never drop them. Not foreign keys — same stance as
  // parent_convo_id.
  const missionConvoCols = db.prepare('PRAGMA table_info(conversations)').all()
  if (!missionConvoCols.some((c) => c.name === 'mission_id')) {
    db.exec('ALTER TABLE conversations ADD COLUMN mission_id TEXT')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_mission ON conversations(mission_id)')
  const itemMissionCols = db.prepare('PRAGMA table_info(items)').all()
  if (!itemMissionCols.some((c) => c.name === 'mission_id')) {
    db.exec('ALTER TABLE items ADD COLUMN mission_id TEXT')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_items_mission ON items(mission_id, state, awaiting)')
  // Consent items (spec 2026-09-22 consent-items): 'spawn' | 'chat' on the
  // tracker mirror of a consent card, NULL on every ordinary item. Carried
  // on the ITEM, not derived from the spawn/convo_agents row that points at
  // it: a renewed chat ask reuses its row and re-points item_id, and a
  // device revoke cascades the row away — either would otherwise turn the
  // old mirror, justification and all, into an ordinary agent-readable item.
  const itemConsentCols = db.prepare('PRAGMA table_info(items)').all()
  if (!itemConsentCols.some((c) => c.name === 'consent')) {
    db.exec('ALTER TABLE items ADD COLUMN consent TEXT')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_items_consent ON items(consent)')
  // Item action buttons (2026-09-24 item-actions contract): `actions` is the
  // JSON array of one-tap answer labels an agent offered, `chosen_action` the
  // label of the user's most recent tap (NULL until one, and again whenever
  // the offered list changes). Every pre-existing row reads as [] / NULL.
  const itemActionCols = db.prepare('PRAGMA table_info(items)').all()
  if (!itemActionCols.some((c) => c.name === 'actions')) {
    db.exec("ALTER TABLE items ADD COLUMN actions TEXT NOT NULL DEFAULT '[]'")
  }
  if (!itemActionCols.some((c) => c.name === 'chosen_action')) {
    db.exec('ALTER TABLE items ADD COLUMN chosen_action TEXT')
  }
  // Comment action buttons (2026-10-04 comment-actions contract): the same
  // pair as the item's, one level down. `actions` is the list an agent
  // offered on ONE comment (a follow-up question in the thread),
  // `chosen_action` the label of the user's most recent tap on that comment.
  // Per comment, so an older question keeps its own buttons and its answer.
  const commentActionCols = db.prepare('PRAGMA table_info(item_comments)').all()
  if (!commentActionCols.some((c) => c.name === 'actions')) {
    db.exec("ALTER TABLE item_comments ADD COLUMN actions TEXT NOT NULL DEFAULT '[]'")
  }
  if (!commentActionCols.some((c) => c.name === 'chosen_action')) {
    db.exec('ALTER TABLE item_comments ADD COLUMN chosen_action TEXT')
  }
  // Comment author: the conversation (session) an agent's comment was
  // written from. device_id already names the box; a box hosts many
  // sessions, so the conversation is what tells two of them apart in one
  // thread. NULL = unknown (a row from before the column, a bridge that does
  // not send it, the user's own comments, the journal's own lines).
  if (!commentActionCols.some((c) => c.name === 'convo_id')) {
    db.exec('ALTER TABLE item_comments ADD COLUMN convo_id TEXT')
  }
  // Notice items (mission: For you): kind 'notice' widens the items CHECK.
  // SQLite cannot ALTER a CHECK, so a database from before it is rebuilt once
  // from its OWN stored definition (every column added by the ALTERs above
  // included) with only the kind list widened — the documented 12-step
  // procedure, foreign keys off so item_comments' references survive the
  // drop. Placed after every items ALTER so the copy carries them all.
  rebuildItemsForNotice(db)
  // Item handover (mission: hand a tracker item from one session to another).
  // An item's origin_convo_id / origin_device_id is its OWNER: every reply,
  // tap, wake and transcript follows it, and a handover moves it. The
  // conversation that first filed the item is kept in filed_convo_id, set on
  // the first handover (NULL = never handed over: the owner filed it).
  // Placed after the notice rebuild so that rebuild never meets the column.
  const itemHandoverCols = db.prepare('PRAGMA table_info(items)').all()
  if (!itemHandoverCols.some((c) => c.name === 'filed_convo_id')) {
    db.exec('ALTER TABLE items ADD COLUMN filed_convo_id TEXT')
  }
  // One row per offer. 'awaiting_user' = parked for the user's tap (a
  // user-only device on either side), 'offered' = with the target session;
  // the rest are settled. At most one pending offer per item.
  db.exec(`CREATE TABLE IF NOT EXISTS item_handovers(
    id                  TEXT PRIMARY KEY,
    item_id             TEXT NOT NULL,
    user_id             INTEGER NOT NULL,
    from_convo_id       TEXT NOT NULL,
    from_device_id      INTEGER,
    to_convo_id         TEXT NOT NULL,
    to_device_id        INTEGER,
    offered_by          TEXT NOT NULL CHECK(offered_by IN ('owner','coordinator','user')),
    offered_by_device_id INTEGER NOT NULL,
    offered_by_convo_id TEXT,
    note                TEXT NOT NULL DEFAULT '',
    state               TEXT NOT NULL CHECK(state IN ('awaiting_user','offered','accepted','declined','withdrawn','refused','expired')),
    approval_comment_id TEXT,
    prior_awaiting      TEXT,
    reason              TEXT NOT NULL DEFAULT '',
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    expires_at          INTEGER NOT NULL
  )`)
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_item_handovers_pending ON item_handovers(item_id) WHERE state IN ('awaiting_user','offered')")
  db.exec('CREATE INDEX IF NOT EXISTS idx_item_handovers_state ON item_handovers(state, expires_at)')
  // Mission status (spec 2026-09-28 missions dashboard §1): one short
  // markdown paragraph agents keep current — who wrote it (status_by), from
  // which conversation (status_convo_id), and when. status_device_id is
  // internal and never on the wire: the privacy sieve keys on the WRITING
  // DEVICE as well as the conversation, so a private agent that names no
  // conversation is still withheld from ordinary agents. No backfill —
  // every existing row reads all NULL.
  const missionStatusCols = db.prepare('PRAGMA table_info(missions)').all()
  const addMissionCol = (name, ddl) => {
    if (!missionStatusCols.some((c) => c.name === name)) db.exec(`ALTER TABLE missions ADD COLUMN ${ddl}`)
  }
  addMissionCol('status', 'status TEXT')
  addMissionCol('status_by', "status_by TEXT CHECK(status_by IN ('user','agent'))")
  addMissionCol('status_convo_id', 'status_convo_id TEXT')
  addMissionCol('status_updated_at', 'status_updated_at INTEGER')
  addMissionCol('status_device_id', 'status_device_id INTEGER')
  // Which conversation closed the mission, when the closing agent named one
  // (spec 2026-09-29 coordinator session control, "Coordinator mission
  // close"): the audit line behind "closed by the Coordinator". NULL for a
  // client close and for a bridge that predates the field.
  addMissionCol('closed_convo_id', 'closed_convo_id TEXT')
  // The project a mission is filed in (spec 2026-09-30 §4.1): at most one,
  // NULL = unfiled. Not a foreign key. The index cannot live in SCHEMA: on an
  // upgraded database SCHEMA runs before this ALTER adds the column.
  addMissionCol('project_id', 'project_id TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_missions_project ON missions(project_id, state)')
  // When a conversation FIRST joined a mission: joined_at is re-stamped on
  // every rejoin (activateLink), which would hide an earlier stint's files
  // from the project page (projects-feed.js). NULL on older rows reads as
  // joined_at there.
  if (!db.prepare('PRAGMA table_info(mission_conversations)').all().some((c) => c.name === 'first_joined_at')) {
    db.exec('ALTER TABLE mission_conversations ADD COLUMN first_joined_at INTEGER')
  }
  // Every open mission has a project (default-project.js).
  const filed = backfillDefaultProjects(db)
  if (filed > 0) console.log(`missions: gave ${filed} open mission(s) a project of their own`)
  // Spec 2026-09-30 §3 backfill: once, while the link table is empty. After
  // every mission/conversation/item column it reads has been added above.
  const backfilled = backfillMissionLinks(db)
  if (backfilled > 0) console.log(`mission_conversations: backfilled ${backfilled} link(s)`)
  // And on EVERY open: a pointer written without a link (old code after a
  // rollback) gets its active link back, so the invariant always holds.
  const healed = healMissionLinks(db)
  if (healed > 0) console.log(`mission_conversations: healed ${healed} link(s)`)
  // Coordinator consent approval (spec: matron-bridge 2026-09-29 coordinator
  // consent): the off switch (default ON), and on both
  // ask tables who answered a parked row and why — 'coordinator' + reason
  // when the Coordinator did, NULL for a tap or a sweep. No backfill.
  const settingsCols = db.prepare('PRAGMA table_info(user_settings)').all()
  if (!settingsCols.some((c) => c.name === 'coordinator_consent')) {
    db.exec('ALTER TABLE user_settings ADD COLUMN coordinator_consent INTEGER NOT NULL DEFAULT 1')
  }
  // Coordinator routines (spec 2026-10-01): when the starter set was seeded
  // for this user, so it happens once — never again after the user empties
  // the list. NULL = not yet.
  if (!settingsCols.some((c) => c.name === 'routines_seeded_at')) {
    db.exec('ALTER TABLE user_settings ADD COLUMN routines_seeded_at INTEGER')
  }
  // Notification settings (spec 2026-10-01 notification settings): the
  // user's synced mode + event switches (JSON, NULL = Coordinator mode
  // defaults), the per-device level beside the APNs token it gates (NULL =
  // 'all'), and per-conversation levels and mutes.
  if (!settingsCols.some((c) => c.name === 'notify_prefs')) {
    db.exec('ALTER TABLE user_settings ADD COLUMN notify_prefs TEXT')
  }
  // Default model and effort for new chats (src/defaults.js): NULL = the
  // box's own default.
  if (!settingsCols.some((c) => c.name === 'default_model')) {
    db.exec('ALTER TABLE user_settings ADD COLUMN default_model TEXT')
  }
  if (!settingsCols.some((c) => c.name === 'default_effort')) {
    db.exec('ALTER TABLE user_settings ADD COLUMN default_effort TEXT')
  }
  // "Send things I need to read to For you" (mission: For you). Default ON,
  // and no row reads as on too (src/settings.js).
  if (!settingsCols.some((c) => c.name === 'notices')) {
    db.exec('ALTER TABLE user_settings ADD COLUMN notices INTEGER NOT NULL DEFAULT 1')
  }
  if (!db.prepare('PRAGMA table_info(devices)').all().some((c) => c.name === 'push_level')) {
    db.exec('ALTER TABLE devices ADD COLUMN push_level TEXT')
  }
  // Per-box defaults for new sessions (matron-bridge docs/specs/box-defaults.md,
  // src/box-defaults.js): the agent, model and effort a session started on
  // this box gets when nobody names one. Agent devices only; NULL = the
  // bridge's own fallback (its env), which is every row predating them.
  const boxCols = db.prepare('PRAGMA table_info(devices)').all()
  for (const col of ['default_agent', 'default_model', 'default_effort']) {
    if (!boxCols.some((c) => c.name === col)) db.exec(`ALTER TABLE devices ADD COLUMN ${col} TEXT`)
  }
  db.exec(`CREATE TABLE IF NOT EXISTS convo_notify(
    user_id INTEGER NOT NULL REFERENCES users(id),
    convo_id TEXT NOT NULL,
    level TEXT CHECK(level IN ('all','needs_me','none')),
    mute_until INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, convo_id)
  )`)
  // Pinned desk chats (spec: mission "pinned desk chats", 5 Oct): the
  // user's own sidebar entries for standing conversations — a label and an
  // emoji chosen by the user, in the user's order, synced to every device.
  // A pin points at a conversation, never a box: a desk's conversation id
  // already survives reaps, restarts and sleeps. device_id is the box the
  // pinned conversation ran on when last seen, kept so the "new session on
  // that box" hint (pins.js) still works if the conversation row is gone.
  // hint_dismissed_id: the newest suggested successor the user waved away.
  db.exec(`CREATE TABLE IF NOT EXISTS convo_pins(
    user_id INTEGER NOT NULL REFERENCES users(id),
    convo_id TEXT NOT NULL,
    label TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL,
    device_id INTEGER,
    hint_dismissed_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, convo_id)
  )`)
  // The startup resume of held consent pushes (push.js resumeHeldConsent)
  // reads recent permission_request cards; partial, so ordinary appends
  // never touch it.
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_permission_request ON events(ts) WHERE type='permission_request'")
  for (const table of ['convo_agents', 'agent_spawn_requests']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all()
    if (!cols.some((c) => c.name === 'answered_by')) db.exec(`ALTER TABLE ${table} ADD COLUMN answered_by TEXT`)
    if (!cols.some((c) => c.name === 'answer_reason')) db.exec(`ALTER TABLE ${table} ADD COLUMN answer_reason TEXT`)
  }
  // Standing agent-chat consent ("always allow A -> B") is gone: every ask
  // parks for the user now. Dropped rather than left in place, because a
  // table of grants that nothing consults still reads like a live security
  // control to the next person who finds it.
  db.exec('DROP TABLE IF EXISTS agent_chat_allowances')
  // Retrofit the device_status -> devices cascade onto a database that
  // created the table before it carried one (the constraint cannot be added
  // in place; same rebuild as convo_agents above). Without it a revoked box
  // left its last report behind, and since devices.id is a plain rowid the
  // next box to take that id inherited the old usage, paths and account on
  // /devices and /roster until it reported. The copy skips rows whose device
  // is already gone — with foreign_keys=ON the INSERT would refuse them.
  const dsNow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='device_status'").get()
  if (dsNow && !dsNow.sql.includes('ON DELETE CASCADE')) {
    const orphans = db.prepare(
      'SELECT COUNT(*) n FROM device_status WHERE device_id NOT IN (SELECT id FROM devices)'
    ).get().n
    db.exec(`
      CREATE TABLE device_status_fk(
        device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL,
        reported_at INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      INSERT INTO device_status_fk
        SELECT device_id, user_id, reported_at, status FROM device_status
         WHERE device_id IN (SELECT id FROM devices);
      DROP TABLE device_status;
      ALTER TABLE device_status_fk RENAME TO device_status;
      CREATE INDEX IF NOT EXISTS idx_device_status_user ON device_status(user_id);
    `)
    if (orphans > 0) {
      console.log(`device_status: dropped ${orphans} report(s) whose device was already revoked`)
    }
  }
  // Repo identity (spec 2026-09-23 tracker web/teams). `repo` is the
  // bridge-reported canonical `host/org/name`; `repo_scope` is the derived
  // `host/org`, the unit visibility is decided on. Both NULL for every row
  // predating the column and every conversation with no git remote.
  const repoCols = db.prepare('PRAGMA table_info(conversations)').all()
  if (!repoCols.some((c) => c.name === 'repo')) {
    db.exec('ALTER TABLE conversations ADD COLUMN repo TEXT')
  }
  if (!repoCols.some((c) => c.name === 'repo_scope')) {
    db.exec('ALTER TABLE conversations ADD COLUMN repo_scope TEXT')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_repo_scope ON conversations(repo_scope)')
  // System conversations (spec 2026-10-02 matron-to-matron sharing): 'people'
  // marks the one conversation per user the journal itself owns — the home
  // of cards from other people and the contact/grant audit events
  // (people-convo.js). NULL on every ordinary conversation. No agent may
  // read, write or adopt a row that carries it.
  if (!repoCols.some((c) => c.name === 'system')) {
    db.exec('ALTER TABLE conversations ADD COLUMN system TEXT')
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_system ON conversations(owner_user_id, system) WHERE system IS NOT NULL')
  // Memory scopes (spec 2026-10-01 memory scopes): who a memory is for —
  // 'global' (every session, how every memory worked before the column),
  // 'coordinator', or 'repo:<name>'. Additive: every pre-migration row is
  // global, which is exactly what it was.
  const memoryCols = db.prepare('PRAGMA table_info(memories)').all()
  if (!memoryCols.some((c) => c.name === 'scope')) {
    db.exec("ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'")
  }
  // GitHub account linking. One GitHub identity per journal user and one
  // journal user per GitHub identity (the unique index). `token` is the
  // user's read:org OAuth token, stored as-is (spec: "Token at rest").
  // `state='stale'` = GitHub refused the token on the last refresh; the
  // orgs rows stay but confer nothing until the user re-links.
  db.exec(`
    CREATE TABLE IF NOT EXISTS github_accounts(
      user_id    INTEGER PRIMARY KEY REFERENCES users(id),
      host       TEXT NOT NULL DEFAULT 'github.com',
      github_id  INTEGER NOT NULL,
      login      TEXT NOT NULL,
      token      TEXT NOT NULL,
      state      TEXT NOT NULL CHECK(state IN ('ok','stale')),
      checked_at INTEGER,
      linked_at  INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_github_accounts_id ON github_accounts(host, github_id);
    CREATE TABLE IF NOT EXISTS github_orgs(
      user_id INTEGER NOT NULL REFERENCES github_accounts(user_id) ON DELETE CASCADE,
      scope   TEXT NOT NULL,
      PRIMARY KEY(user_id, scope)
    );
    CREATE INDEX IF NOT EXISTS idx_github_orgs_scope ON github_orgs(scope);
    CREATE TABLE IF NOT EXISTS github_link_flows(
      id          TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      device_id   INTEGER NOT NULL,
      flow        TEXT NOT NULL CHECK(flow IN ('device','web')),
      device_code TEXT,
      state       TEXT,
      expires_at  INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_github_link_flows_state ON github_link_flows(state);
    CREATE TABLE IF NOT EXISTS github_link_confirms(
      id            TEXT PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id),
      nonce         TEXT NOT NULL UNIQUE,
      token         TEXT NOT NULL,
      identity_json TEXT NOT NULL,
      expires_at    INTEGER NOT NULL,
      created_at    INTEGER NOT NULL
    );
  `)
  // SHA-256 of the plaintext token: the refresh path's "only touch the row
  // I read" guard compares this, so the token column itself can be sealed
  // (src/token-box.js). NULL only until sealStoredTokens runs at boot.
  const ghCols = db.prepare('PRAGMA table_info(github_accounts)').all()
  if (!ghCols.some((c) => c.name === 'token_hash')) {
    db.exec('ALTER TABLE github_accounts ADD COLUMN token_hash TEXT')
  }
  // Journal admins (spec 2026-09-23 tracker web/teams, "User
  // administration"). Bootstrapped from the shell with
  // `matron-admin user admin <name> on`; the users admin routes need at
  // least one. Default 0: an upgraded journal has no admin until someone
  // with shell access says so.
  const userCols = db.prepare('PRAGMA table_info(users)').all()
  if (!userCols.some((c) => c.name === 'is_admin')) {
    db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0')
  }
  // Unlisted accounts (person-to-person sharing): an account that is on the
  // journal but is nobody's colleague, such as the App Store review login.
  // It is left out of the "add contact" user list, gets an empty list
  // itself, and can neither send nor be sent a contact request
  // (contacts.js). Set from the shell with `matron-admin user unlisted
  // <name> on`. Default 0.
  if (!userCols.some((c) => c.name === 'unlisted')) {
    db.exec('ALTER TABLE users ADD COLUMN unlisted INTEGER NOT NULL DEFAULT 0')
  }
  // One-time title cleanup (spec: agent box rename). Gated on user_version
  // inside, so this is a cheap pragma read on every subsequent open.
  healBakedTitles(db, { log: (m) => console.log(m) })
  // Mission-named conversations (src/convo-title.js). `auto_title` is the
  // title the bridge sent, with its parsed `session_short` / `title_marker`;
  // `title` becomes the journal-composed display name. `missions.name` is
  // the optional short name a mission lends its conversations. After the
  // title heal above, so the backfill copies healed titles. The one-time
  // recompose of titles follows below.
  const namedCols = db.prepare('PRAGMA table_info(conversations)').all()
  // One transaction, so a crash mid-way never leaves auto_title present
  // (the guard) with the backfill or its sibling columns missing.
  if (!namedCols.some((c) => c.name === 'auto_title')) {
    db.transaction(() => {
      db.exec('ALTER TABLE conversations ADD COLUMN auto_title TEXT')
      db.exec('ALTER TABLE conversations ADD COLUMN session_short TEXT')
      db.exec('ALTER TABLE conversations ADD COLUMN title_marker TEXT')
      const set = db.prepare('UPDATE conversations SET auto_title=@auto_title, session_short=@session_short, title_marker=@title_marker WHERE id=@id')
      for (const r of db.prepare('SELECT id, title FROM conversations WHERE system IS NULL').all()) {
        set.run({ id: r.id, ...autoTitleColumns(r.title) })
      }
    })()
  }
  // recomputeConvoTitle's "is this a spawn room" probe, on every titled upsert.
  db.exec('CREATE INDEX IF NOT EXISTS idx_spawn_room ON agent_spawn_requests(room_id)')
  const missionNameCols = db.prepare('PRAGMA table_info(missions)').all()
  if (!missionNameCols.some((c) => c.name === 'name')) db.exec('ALTER TABLE missions ADD COLUMN name TEXT')
  // One-time: name every eligible conversation already on a mission now.
  // Bridges stop re-sending a title once one is earned, so waiting for the
  // next title upsert could mean never. No convo_meta per conversation —
  // apps re-read titles from /snapshot. Gated on user_version 2 (1 is the
  // title heal's, which only checks >= 1).
  if (db.pragma('user_version', { simple: true }) < 2) {
    db.transaction(() => {
      for (const r of db.prepare('SELECT id FROM conversations WHERE mission_id IS NOT NULL').all()) recomputeConvoTitle(db, r.id)
      db.pragma('user_version = 2')
    })()
  }
  return db
}

export function insertBlob(db, { id, ownerUserId, contentType, size, sha256, diskPath, width = null, height = null }) {
  db.prepare(
    'INSERT INTO blobs(id, owner_user_id, content_type, size, sha256, disk_path, created_at, width, height) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(id, ownerUserId, contentType, size, sha256, diskPath, Date.now(), width, height)
}

// { width, height } of an image blob as displayed, or null when it isn't one
// we can size (or the blob is gone). Reads the file header once and caches the
// answer on the row — 0 × 0 records "read, unknown" so a non-image is never
// re-read. Sync: a header read is at most a few KB in the common case.
export function blobImageDims(db, blobId) {
  const row = db.prepare('SELECT disk_path, width, height FROM blobs WHERE id=?').get(blobId)
  if (!row) return null
  if (row.width == null || row.height == null) {
    const dims = imageSizeFromFile(row.disk_path)
    const width = dims?.width ?? 0
    const height = dims?.height ?? 0
    db.prepare('UPDATE blobs SET width=?, height=? WHERE id=?').run(width, height, blobId)
    return dims
  }
  return row.width > 0 && row.height > 0 ? { width: row.width, height: row.height } : null
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
    "SELECT id, apns_token, apns_env, cursor, push_prefs, push_level FROM devices WHERE user_id=? AND kind='client' AND apns_token IS NOT NULL"
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
    'SELECT id AS device_id, kind, name, tag_char, created_at, cursor, last_seen_at, push_prefs FROM devices WHERE user_id=? ORDER BY id'
  ).all(userId).map((d) => ({ ...d, lag: headSeq - d.cursor, push_prefs: parsePushPrefs(d.push_prefs) }))
}

// Box status (spec: 2026-09-21 "usage and allowances live in the journal").
// The last capacity report a bridge sent for its own box — activity,
// limits, disk, account — persisted so every client sees every box's last
// known state, including a box that is asleep and one this client has never
// talked to. One row per device, latest wins; the JSON is already sanitised
// (sanitizeBoxStatus in spawns.js) before it lands here.
export function upsertDeviceStatus(db, { userId, deviceId, status, reportedAt = Date.now() }) {
  db.prepare(
    `INSERT INTO device_status(device_id, user_id, reported_at, status) VALUES (?,?,?,?)
     ON CONFLICT(device_id) DO UPDATE SET user_id=excluded.user_id, reported_at=excluded.reported_at, status=excluded.status`
  ).run(deviceId, userId, reportedAt, JSON.stringify(status))
}

// The partial-report write: refresh the blocks `status` carries, keep the
// stored blocks it omits. For a source that never speaks the whole report —
// a recent_folders reply carries activity/limits/disk at most, never
// account — so one live fan-out cannot erase what the box's own box_status
// said. A bridge's box_status stays a full replacement (upsertDeviceStatus):
// it always sends everything it knows, and omitting a block there means
// "gone". Read-then-write is atomic here: better-sqlite3 is synchronous and
// nothing yields between the two statements.
export function mergeDeviceStatus(db, { userId, deviceId, status, reportedAt = Date.now() }) {
  const { reported_at: _, ...kept } = getDeviceStatus(db, userId, deviceId) || {}
  upsertDeviceStatus(db, { userId, deviceId, status: { ...kept, ...status }, reportedAt })
}

// One device's stored report, {reported_at, ...blocks}, or null when it has
// never reported (or its JSON no longer parses — treated as never).
export function getDeviceStatus(db, userId, deviceId) {
  const row = db.prepare('SELECT reported_at, status FROM device_status WHERE device_id=? AND user_id=?').get(deviceId, userId)
  if (!row) return null
  try { return { reported_at: row.reported_at, ...JSON.parse(row.status) } } catch { return null }
}

// deviceId -> {reported_at, activity?, limits?, disk?, account?} for one
// user. A row whose JSON no longer parses (never expected) is skipped rather
// than failing the whole roster.
export function deviceStatuses(db, userId) {
  const out = new Map()
  for (const r of db.prepare('SELECT device_id, reported_at, status FROM device_status WHERE user_id=?').all(userId)) {
    try { out.set(r.device_id, { reported_at: r.reported_at, ...JSON.parse(r.status) }) } catch { /* skip */ }
  }
  return out
}

// The privacy flag, read side. False for unknown ids: a caller checking a
// dangling/deleted device must fall through to the normal not_found path,
// not crash.
export function isPrivateDevice(db, deviceId) {
  return !!db.prepare('SELECT 1 FROM devices WHERE id=? AND private=1').get(deviceId)
}

export function setDeviceConsentUserOnly(db, deviceId, on) {
  db.prepare('UPDATE devices SET consent_user_only=? WHERE id=?').run(on ? 1 : 0, deviceId)
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

const ITEM_KIND_CHECK_OLD = "CHECK(kind IN ('task','question','decision'))"
const ITEM_KIND_CHECK_NEW = "CHECK(kind IN ('task','question','decision','notice'))"

// See the call in openDb. Idempotent: a table whose definition already lists
// 'notice' (a fresh database, or one already rebuilt) is left alone.
export function rebuildItemsForNotice(db) {
  const def = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='items'").get()
  if (!def || def.sql.includes("'notice'")) return false
  if (!def.sql.includes(ITEM_KIND_CHECK_OLD)) throw new Error('items: unexpected kind CHECK, cannot add notice')
  const createNew = def.sql
    .replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?items["`]?\s*\(/i, 'CREATE TABLE items_notice_new(')
    .replace(ITEM_KIND_CHECK_OLD, ITEM_KIND_CHECK_NEW)
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='items' AND sql IS NOT NULL").all().map((r) => r.sql)
  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      db.exec(createNew)
      db.exec('INSERT INTO items_notice_new SELECT * FROM items')
      db.exec('DROP TABLE items')
      db.exec('ALTER TABLE items_notice_new RENAME TO items')
      for (const sql of indexes) db.exec(sql)
      // Reported, not fatal: the copy is row-for-row, so a violation here
      // was already in the data before the rebuild and must not stop a boot.
      const broken = db.prepare('PRAGMA foreign_key_check(item_comments)').all().filter((r) => r.parent === 'items')
      if (broken.length) console.warn(`items rebuild: ${broken.length} item comment(s) point at no item`)
    })()
  } finally {
    db.pragma('foreign_keys = ON')
  }
  return true
}
