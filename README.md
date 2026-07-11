# matron-journal

Journal server for the Matron chat system: a thin, server-authoritative
replacement for the Matrix stack used by the Claude bridge.
Spec: docs/superpowers/specs/2026-07-10-matron-protocol-design.md

## Run

    npm install
    MATRON_DB=./matron.db MATRON_PORT=9810 npm start

## Admin

    MATRON_DB=./matron.db npx matron-admin user add dan --password '...'
    MATRON_DB=./matron.db npx matron-admin agent add dan dev-2
    MATRON_DB=./matron.db npx matron-admin status

## Protocol (v1 core)

- `POST /login {username, password, device_name}` -> `{token, device_id, user_id}`.
  Brute-force protection: 5 attempts/min per IP (429 `rate_limited`), plus per-username
  lockout after 5 consecutive failures — 30s doubling per failure up to 1h, cleared by
  a successful login (429 `locked_out` with `retry_after` seconds + `Retry-After` header).
- `GET /snapshot` (Bearer) -> `{conversations, seq}`
- `GET /convo/:id/messages?before_seq&limit` (Bearer) -> `{events}`. `limit`
  is clamped to 1..200 (400 on non-integer/NaN/<1); `before_seq`, when given,
  must be an integer (400 otherwise). Owner-only; missing or not-owned are
  indistinguishable, both 404 `{error:'not_found'}` (never 403).
- `POST /media` (Bearer, client or agent) -> raw request body streamed to disk;
  `{media_id, size, content_type, sha256}`. Content-Type header captured
  (default `application/octet-stream`). 400 `{error:'empty'}` on a zero-byte
  body; 413 `{error:'too_large'}` over `MATRON_MEDIA_MAX_BYTES` (default 50 MB).
  Storage root: `MATRON_MEDIA_DIR` env or `<dirname of the db file>/media`,
  sharded `<root>/<id[0:2]>/<id>`.
- `GET /media/:id` (Bearer) -> streams the blob with its Content-Type,
  Content-Length and a long-lived `Cache-Control` (ids are immutable random
  handles). Owner-only; missing or not-owned are indistinguishable, both
  404 `{error:'not_found'}`.
- `WS /ws`: first frame `{op:'hello', token, cursor}` (cursor null = live-only).
  Server: `hello_ok {seq}`, then journal frames `> cursor`, then live.
  Client ops: send, prompt_reply, read_marker, ack, viewing.
  Agent ops: convo_upsert, publish, stream (ephemeral), finalize. `read_marker`
  is available to both kinds: an agent (bridge) connection may advance its
  user's read marker too — e.g. after mirroring the user's own message into
  the journal, so that mirrored round-trip doesn't inflate the unread badge.
  `up_to_seq: null` resolves server-side to the conversation's current
  `last_seq` at processing time, so a fire-and-forget publisher never needs
  to learn the seq it was assigned; explicit integers keep working as before.
- Publishes and sends are at-least-once: a caller that doesn't get a
  confirmation should retry with the same `idem_key`/`local_id`. A deduped
  retry gets NO dedicated confirmation frame — convergence is observed via
  the journal frame carrying the event, which carries the same `seq` on
  every delivery (original or retried).
- Conversation ids are a global primary key across all users, not scoped to a
  user or device. Bridges MUST mint globally unique ids — Claude session
  UUIDs are the convention.
- `convo_upsert` appends a `convo_meta` journal event (`payload:{title}`,
  sender = the agent device, e.g. `agent:dev-2`) whenever it changes an
  existing conversation's title, or sets a non-empty title at creation — so
  other devices learn renames live instead of only via `/snapshot`. No event
  when the title is unchanged or omitted (state-only upserts included).
- Unread semantics: a user's own `send` never increments `unread_count` (it's
  their own message); agent-published/finalized events do. `read_marker`
  recomputes `unread_count` from events after `up_to_seq`, so
  `up_to_seq >= last_seq` always resets it to 0.
- Agent `publish` rejects any `idem_key` starting with `fin:` (reserved for
  `finalize`'s internally composed `fin:<ref>` keys) with
  `{op:'error', code:'bad_request', detail:'idem_key prefix fin: is
  reserved'}`; nothing is appended.
- `POST /push/register` (Bearer, client devices only — agents get 403
  `{error:'forbidden'}`): `{apns_token, environment}` with `environment` in
  `{'sandbox','prod'}` registers a device for push; `{apns_token: null}`
  unregisters. 400 `{error:'bad_request'}` on a bad `environment` or a
  missing/non-string `apns_token` (unless it's `null`).
- `GET /metrics` (Bearer, any valid device — client or agent, no admin
  concept in v1) -> JSON: `{user: {head_seq, devices: [{device_id, kind,
  cursor, lag, last_seen_at}]}, sockets_connected, journal_row_count,
  db_file_size_bytes, push: {sent, failed, pruned, by_reason}}`. The `user`
  section is scoped to the caller's own user only — never another user's
  devices or username; the rest are global aggregates (bare numbers/
  counters, safe for any authenticated caller). `push` mirrors the push
  pipeline's in-memory counters (all zero when push is disabled).
  `matron-admin status` prints the DB-derived subset of the same numbers
  (per-user head seq, per-device kind/cursor/lag/last_seen_at, total events,
  DB file size) directly from the SQLite file — connected-socket count and
  APNs counters only exist in a running server's memory, so those are
  `/metrics`-only.

## Push notifications (APNs)

Direct HTTP/2 APNs (ES256 provider JWT, `node:http2` — no sygnal, no extra
dependencies). Disabled unless all four are set:

    MATRON_APNS_KEY_FILE=/path/to/AuthKey_XXXX.p8
    MATRON_APNS_KEY_ID=...
    MATRON_APNS_TEAM_ID=...
    MATRON_APNS_TOPIC=chat.matron.x

Missing any of them logs one warn line at boot and the push pipeline is an
inert no-op — everything else on the server works as normal.

After a journal event fans out to a user's connections, the push pipeline
considers each of that user's *client* devices with a registered token
(agent devices are never pushed to):

- skipped when that device is connected and actively `viewing` the event's
  conversation, or when its acked cursor already covers the event's `seq`.
- `prompt` / `permission_request`, and `session_status` with
  `payload.state:'done'`, push immediately at priority 10.
- `convo_meta` and `session_status` with any other state never push at all —
  a title rename or a running/waiting flip is journal-sync material, not a
  notification (connected devices learn it from the journal frame).
- routine content (`text`, `tool_output`, `diff`, ...) pushes at priority 5,
  coalesced per (device, conversation): a leading push when idle, then at
  most one trailing push per 10s window while events keep arriving
  (in-memory only — a restart loses a pending trailing push).
- `read_marker` rows trigger a silent background push
  (`content-available: 1`, no alert) to the user's *other* devices so they
  clear their badge — never back to the device whose read_marker it was.
- alert title is the conversation title (falling back to its id), body is
  the event's snippet, badge is `SUM(unread_count)` over the owner's
  conversations.
- a 410 response prunes that device's `apns_token`/`apns_env` (dead token,
  logged once); a 400 keeps the token but logs loudly — almost always a
  sandbox/prod `apns_env` mismatch (the sygnal lesson), not a dead token.

Per-device `apns_env` (`'sandbox'|'prod'`) exists because Xcode dev builds
register sandbox tokens, which prod APNs answers with 400 `BadDeviceToken` —
environment has to travel with the token, never be assumed from the topic.

## Retention (payload offload)

A scheduled job (runs at boot, then every 6h) offloads `tool_output` event
payloads older than `MATRON_RETENTION_DAYS` (default 30) from the hot
`events` table to blob files, leaving `{type:'tool_output', snippet,
blob_ref}` in the row — journal replay carries that shape from then on, and
clients fetch the full body via `GET /media/<blob_ref>` on demand. `journal`
rows themselves are never deleted; only payloads move. Idempotent — a row
already offloaded (or one whose payload already has the offloaded shape) is
never reprocessed.

`MATRON_RETENTION_DAYS=0`, or an unset/invalid value, disables retention
(one warn log line at boot); any other non-negative integer sets the window
in days. Manual run: `matron-admin offload [--days N]` (default 30).

## Test

    npm test

Deferred to v1 completion: conformance fixtures (see the spec, §15 and plan
docs).
