# v1 Completion: media, protocol decisions, APNs push, hardening, ops

Implements the remaining v1 items from docs/BACKLOG.md against the approved
spec (docs/superpowers/specs/2026-07-10-matron-protocol-design.md). Branch:
feat/v1-completion off master (post PR #1 merge).

## Global Constraints

- Node >= 22, ESM, zero new runtime dependencies (better-sqlite3, ws, argon2
  only). Tests: node:test via `npm test`. Style: match existing src/ (no
  semicolons is NOT the rule — match what's there).
- TDD per task: failing test first, then implement.
- The live DB on dev-2 already exists — every schema change must include an
  in-place migration path in `openDb` (guard with `PRAGMA table_info` /
  `CREATE TABLE IF NOT EXISTS`), never a destructive rebuild.
- Every read path passes `authorize(user, convo)` semantics: v1 rule is
  owner-only. Unauthorized and missing must be indistinguishable (404, not
  403) on media/message reads.
- No secrets in code, logs, or test fixtures. Never read
  ~/.config/matron/* or any .p8 key contents; tests generate their own
  throwaway EC keys via node:crypto.
- Commit and push to origin after each task (Bugbot reviews incrementally).
  Task 1 opens the PR (base master, do not merge).
- Fails-open is for the bridge; the server is fails-CLOSED: invalid input
  gets an error frame/status, never a crash or a silent accept.

## Task 1: Media upload/download

Spec §5 (blobs), §6 (HTTP surface). New table + two endpoints + storage.

- `blobs(id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL REFERENCES
  users(id), content_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT
  NOT NULL, disk_path TEXT NOT NULL, created_at INTEGER NOT NULL)` — add to
  SCHEMA (CREATE TABLE IF NOT EXISTS is migration enough for a new table).
- `POST /media` (Bearer, client or agent token): raw request body → disk.
  - id = 32 hex chars from crypto.randomBytes(16).
  - Storage root: `MATRON_MEDIA_DIR` env or `<dirname(dbPath)>/media`;
    layout `<root>/<id[0:2]>/<id>`; write to `<path>.tmp` then rename
    (atomic); mkdir -p on demand.
  - Content-Type request header captured, default `application/octet-stream`.
  - Size cap `MATRON_MEDIA_MAX_BYTES` default 52428800 (50 MB): stream and
    count; over cap → destroy the temp file, respond 413
    `{error:'too_large'}`. Zero bytes → 400 `{error:'empty'}`.
  - Response 200 `{media_id, size, content_type, sha256}` (sha256 computed
    while streaming).
- `GET /media/:id` (Bearer): owner-only. Missing OR not-owned → 404
  `{error:'not_found'}`. Success streams the file with Content-Type,
  Content-Length, and `Cache-Control: private, max-age=31536000, immutable`
  (ids are immutable random handles).
- `file`/`image` journal events already flow through `publish` (types are
  freeform) — no journal changes; payloads carry `blob_ref: <media_id>`.
- db.js gets blob insert/get statements; http.js routes follow the existing
  handler style (auth helper, JSON errors).
- Tests (test/media.test.js): upload→download roundtrip byte-identical with
  binary (non-UTF8) content; content-type preserved; 401 without token;
  404 for other user's blob and for unknown id; 413 over cap (small cap via
  env/injection); 400 empty body; sha256 matches; disk layout sharded;
  atomic tmp file gone after success.

## Task 2: Protocol decisions (convo_meta, unread, fin: guard, docs)

Five decided items from BACKLOG "Protocol decisions".

1. **convo_meta journal event.** In the convo_upsert path (src/journal.js /
   src/ws.js): when an upsert CHANGES the title of an existing convo (or
   sets a non-empty title at creation), append a journal event
   `type:'convo_meta'`, payload `{title}`, sender = the agent device name
   (same sender convention as session_status rows). No event when the title
   is unchanged or absent. Other devices thereby learn renames live instead
   of only via /snapshot.
2. **Unread semantics.** A user's own `send` (client op) must NOT increment
   the conversation's unread_count. Agent-published events still increment
   (the bridge advances the read marker for mirrored user messages — that
   half lives in the bridge repo, not here). Verify and lock in with a test:
   `read_marker` with up_to_seq >= last_seq resets unread_count to 0; if the
   current implementation doesn't, make it so.
3. **fin: prefix guard.** Agent `publish` with an idem_key starting `fin:`
   → error frame `{op:'error', code:'bad_request', detail:'idem_key prefix
   fin: is reserved'}`; nothing appended. (finalize composes `fin:<ref>`
   keys internally — a raw publish must not be able to collide with them.)
4. **Docs: at-least-once.** README Protocol section: publishes/sends are
   at-least-once; retries dedupe via idem_key; a deduped retry gets NO
   dedicated confirmation frame — convergence is observed via the journal
   frame carrying the event (same seq on every delivery).
5. **Docs: convo-id namespace.** README: conversation ids are a global PK;
   bridges MUST use globally unique ids — Claude session UUIDs are the
   convention.
- Tests: convo_meta appended on title change only (not on same-title upsert,
  not on state-only upsert); send does not bump unread; agent publish does;
  read_marker resets; fin:-prefixed publish rejected and nothing lands.

## Task 3: APNs push (direct HTTP/2)

Spec §9. Direct APNs, no sygnal. All config via env; feature disabled (one
warn log at boot) unless ALL of MATRON_APNS_KEY_FILE, MATRON_APNS_KEY_ID,
MATRON_APNS_TEAM_ID, MATRON_APNS_TOPIC are set. Production values for
reference (deploy config, NOT test fixtures): key file ~/sygnal/apns_key.p8,
key id <asc-key-id>, team <team-id>, topic chat.matron.x.

- **Schema migration:** `devices.apns_env TEXT` (values 'sandbox'|'prod',
  app-enforced). openDb: if PRAGMA table_info(devices) lacks apns_env →
  `ALTER TABLE devices ADD COLUMN apns_env TEXT`. (Sygnal lesson: Xcode dev
  builds register sandbox tokens; prod APNs answers 400 BadDeviceToken —
  environment must be per-device.)
- **`POST /push/register`** (Bearer, kind 'client' only — agents get 403
  `{error:'forbidden'}`): body `{apns_token, environment}` with environment
  in {'sandbox','prod'} → store both on the device row. `{apns_token: null}`
  unregisters. 400 on bad environment or missing/non-string apns_token
  (unless null).
- **src/apns.js — makeApnsClient({keyFile, keyId, teamId, topic, connect?})**
  - ES256 JWT via node:crypto (createPrivateKey on the .p8, sign with
    dsaEncoding 'ieee-p1363'), header {alg:'ES256', kid}, claims {iss: team,
    iat}; cached and re-minted after 45 min.
  - node:http2 client sessions, one per environment host —
    prod api.push.apple.com, sandbox api.sandbox.push.apple.com — lazily
    connected, re-created on 'error'/'goaway'/'close'.
  - `send({deviceToken, env, topic?, payload, collapseId, priority,
    pushType})` → resolves `{status, reason}` (never rejects; transport
    errors → {status: 0, reason: 'transport'}). Headers: :method POST,
    :path /3/device/<token>, authorization bearer <jwt>, apns-topic,
    apns-push-type, apns-priority, apns-collapse-id (only when set),
    apns-expiration 0.
  - `connect` injectable (defaults to http2.connect) so tests run a fake
    in-process h2 server (node:http2 createSecureServer with a self-signed
    cert generated in-test, or plain createServer + connect option) — no
    network, no Apple.
- **Push pipeline (src/push.js, wired in server.js/hub):** after a journal
  append fans out, for each of the owner's client devices with apns_token:
  - skip when the device's socket is connected AND its `viewing` convo is
    this convo (hub tracks viewing hints);
  - skip when device.cursor >= event.seq (already acked past it);
  - type mapping: `prompt`/`permission_request` → alert push, priority 10;
    `session_status` payload.state 'done' → alert, priority 10;
    `text`/`tool_output`/`diff`/other → alert, priority 5, coalesced per
    (device, convo): trailing-edge timer, min 10 s between routine pushes
    (leading send allowed when idle); `read_marker` rows → background push
    (apns-push-type background, priority 5, content-available 1, no alert)
    so other devices clear badges.
  - alert body: title = convo title (fallback convo id), body = snippet of
    the event payload (existing snippetOf), thread-id + collapse-id =
    convo_id. badge = SUM(unread_count) over the owner's conversations.
  - 410 Unregistered → NULL out that device's apns_token/apns_env (prune,
    log once). 400 BadDeviceToken → keep token, log loudly (config/env
    mismatch — sygnal lesson). Other non-200 → log, no retry in v1.
  - failure/success counters exposed on the push module for /metrics
    (Task 5).
- Tests (test/apns.test.js, test/push.test.js): JWT header/claims decode +
  ES256 verify with the test key; env routes to the right host; collapse-id
  and priority per type mapping; viewing suppression; acked-past
  suppression; 410 prunes token; 400 does not; coalescing (two routine
  events within window → one push then trailing push); disabled mode inert;
  agent devices never pushed to.

## Task 4: Hardening pass

The BACKLOG "Hardening pass" list, one touch per file, all with tests:

- Client-op validation: `send` with missing/non-object payload → error frame
  bad_request (not internal); `read_marker.up_to_seq` must be a
  non-negative integer; `hello.cursor` must be integer-or-null (else error +
  close); `prompt_reply` ref integer check.
- Agent publish type whitelist: allow exactly
  text|prompt|prompt_reply|tool_output|diff|permission_request|file|image|
  edit — reject others incl. `session_status` (must go via convo_upsert) and
  `read_marker`/`convo_meta` (server-generated) with bad_request. Unknown
  future types arrive via a server upgrade, not a bare agent.
- HTTP: clamp `limit` to 1..200 (reject NaN/negative → 400); `before_seq`
  integer check → 400; wrap decodeURIComponent (URIError → 400); 500
  responses say `{error:'internal'}` only — no e.message leak (log it
  server-side instead).
- WS `maxPayload: 1048576` on the WebSocketServer.
- Replay backpressure: between replay batches, if `ws.bufferedAmount` >
  4 MB, pause (await drain via setTimeout loop) before continuing.
- Login timing: unknown username → verify against a precomputed dummy
  argon2 hash before answering 401 (no user-exists timing oracle).
- journal.js: snippetOf/session_status guards for null/undefined/non-object
  payloads from agents (error, not crash).
- src/server.js: same realpathSync entrypoint guard as bin/matron-admin.js.
- Tests for each rejection path + the dummy-verify (assert 401, not 500).

## Task 5: Retention, /metrics, snapshot_required, /password, revocation

- **Retention/offload (src/retention.js):** `runOffload(db, {days=30,
  mediaDir})` — for `tool_output` events older than the window with payload
  still inline: write payload JSON to a blob file (reuse Task 1 storage +
  blobs table, content_type application/json, owner = event user), replace
  the row's payload with `{type:'tool_output', snippet, blob_ref}` and set
  blob_ref column. Idempotent (skips rows already offloaded). Wire a
  setInterval in server.js (env MATRON_RETENTION_DAYS, 0 disables; run at
  boot + every 6 h) and a `matron-admin offload` command for manual runs.
  Journal frames replayed after offload carry the offloaded payload —
  clients fetch the full body via GET /media/<blob_ref> on demand.
- **GET /metrics** (Bearer, any valid device): JSON — per-user head seq,
  per-device cursor lag (head - cursor) + kind + last_seen_at, connected
  socket count, APNs sent/failed/pruned counters, journal row count,
  DB file size. Extend `matron-admin status` to print the same numbers
  (direct DB reads; socket/APNs counters shown only when the server is
  asked, i.e. /metrics — admin prints DB-derived stats).
- **snapshot_required valve:** at hello, if `head_seq - cursor >
  MATRON_MAX_REPLAY` (default 50000, env-overridable), send
  `{kind:'control', op:'snapshot_required'}` instead of replaying, and keep
  the socket open awaiting a new hello? No — close with code 4009 after
  sending; client calls /snapshot and reconnects with the fresh cursor
  (matches spec §6 wipe-and-resync).
- **POST /password** (Bearer, client devices only): `{old_password,
  new_password}`; verify old against the user's hash (argon2), min length 8
  for the new one; store new argon2id hash. Existing device tokens stay
  valid (document in README). 403 for agent tokens, 401 bad old password
  (after real verify — no oracle shortcuts), 400 weak/missing new.
- **Device revocation end-to-end:** `matron-admin device list <user>` and
  `matron-admin device revoke <device_id>` (delete row). WS enforcement:
  every inbound frame handler re-checks the device row still exists (SELECT
  id) — gone → send error frame `{code:'revoked'}` and close 4001
  (spec §8 close-on-next-frame). HTTP handlers already look up by token
  hash per request → deleting the row kills them naturally; add a test.
- Tests: offload roundtrip (payload retrievable via /media, replay carries
  offloaded shape, second run no-ops); /metrics numbers move after
  publish/ack; snapshot_required at gap > threshold and normal replay under
  it; password change happy path + all three rejects + old token still
  valid; revoked device's next frame → 4001 and HTTP 401.
