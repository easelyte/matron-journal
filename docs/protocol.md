# Protocol reference (v1)

The full design rationale lives in the
[protocol design spec](superpowers/specs/2026-07-10-matron-protocol-design.md);
this document is the operational reference for what the server implements
today. Golden wire-protocol fixtures under `test/fixtures/conformance/` are
the machine-checkable version of this page.

## HTTP endpoints

- `POST /login {username, password, device_name}` -> `{token, device_id, user_id}`.
  Brute-force protection: 5 attempts/min per IP (429 `rate_limited`), plus per-username
  lockout after 5 consecutive failures — 30s doubling per failure up to 1h, cleared by
  a successful login (429 `locked_out` with `retry_after` seconds + `Retry-After` header).
- `GET /snapshot` (Bearer) -> `{conversations, seq}`. Each conversation row
  carries `parent_convo_id` (`null` for a normal conversation; set for a
  subagent child — see "Child conversations").
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
- `POST /push/register` (Bearer, client devices only — agents get 403
  `{error:'forbidden'}`): `{apns_token, environment}` with `environment` in
  `{'sandbox','prod'}` registers a device for push; `{apns_token: null}`
  unregisters. 400 `{error:'bad_request'}` on a bad `environment` or a
  missing/non-string `apns_token` (unless it's `null`).
- `POST /password` (Bearer, client devices only — agents get 403
  `{error:'forbidden'}`): `{old_password, new_password}`. `old_password` is
  always verified against the real argon2 hash (no shortcuts); a wrong one
  is 401 `{error:'bad_password'}`. `new_password` must be a string of at
  least 8 characters, otherwise 400 `{error:'weak_password'}`; a
  missing/non-string `old_password` is 400 `{error:'bad_request'}`. On
  success the user's hash is rotated to a fresh argon2id hash; **existing
  device tokens (including the one used to make this request) stay valid**
  — a password change does not revoke sessions, only the credential used to
  mint new ones via `/login`.
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
- `GET /devices` (Bearer, client devices only — agents get 403
  `{error:'forbidden'}`) -> `{devices: [{device_id, kind, name, created_at,
  cursor, lag, last_seen_at, is_self, connected}]}`. The caller's own user's
  devices only; `is_self` marks the requesting device. Overlaps `/metrics`'
  `user.devices` deliberately — metrics is observability (agents may read
  it, no `name`), this is the management roster. `connected` is whether the
  device has a live WebSocket right now — the "can I start a session on
  this agent" signal; `last_seen_at` stays the offline story.
- `POST /pair/start` (unauthenticated; shares /login's per-IP rate limit) ->
  `{pair_code, poll_token, expires_in}`. Pending pairs are in-memory only
  (10-minute TTL, 64 outstanding max — 429 `rate_limited` beyond either);
  a restart forgets them.
- `POST /pair/approve {pair_code, agent_name}` (Bearer, client devices
  only) -> `{status:'approved'}`. Binds the pair to the approving caller's
  user. Exactly once per pair: already-approved is 409 `{error:'conflict'}`;
  unknown and expired are indistinguishable 404s. Codes are normalized
  (case/hyphens/spaces) before lookup.
- `POST /pair/preview {pair_code}` (Bearer, client devices only) ->
  `{requester_ip, expires_in}` for a pending pair — the approval screen shows
  who is asking before the user approves. `requester_ip` is the IP that
  called `pair/start`; `expires_in` is the pair's remaining TTL in seconds.
  Read-only. Unknown, expired, and already-approved codes are
  indistinguishable 404s; codes are normalized as in approve.
- `POST /pair/claim {poll_token}` (unauthenticated) -> `{status:'pending'}`
  until approval, then exactly once `{status:'approved', token, device_id}`
  — the agent device row is minted at claim, not approve, so an unclaimed
  pair leaves no DB residue. Second claim / unknown / expired: 404.

## WebSocket

- `WS /ws`: first frame `{op:'hello', token, cursor}` (cursor null = live-only).
  Server: `hello_ok {seq}`, then journal frames `> cursor`, then live.
  If the replay gap (`head_seq - cursor`) exceeds `MATRON_MAX_REPLAY`
  (default 50000), the server sends `{kind:'control', op:'snapshot_required'}`
  instead of replaying and closes the socket with code `4009` — the client
  wipes its local store, calls `GET /snapshot`, and reconnects with the
  fresh cursor (spec §6). Journal rows are never deleted, so this is an
  efficiency valve, not a data-loss boundary.
  Client ops: send (type text, or file/image with a top-level blob_ref from a
  prior POST /media — payload mirrors the agent-publish media shape),
  prompt_reply, read_marker, ack, viewing.
  Agent ops: convo_upsert, publish, stream (ephemeral), stream_append,
  finalize, activity (ephemeral), status (ephemeral, cached). `read_marker`
  is available to both kinds:
  an agent (bridge) connection may advance its user's read marker too —
  e.g. after mirroring the user's own message into the journal, so that
  mirrored round-trip doesn't inflate the unread badge.
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
- `convo_upsert` appends a `convo_meta` journal event
  (`payload:{title, parent_convo_id}`, sender = the agent device, e.g.
  `agent:dev-2`) whenever it changes an existing conversation's title, sets
  a non-empty title at creation, or creates a child (`parent_convo_id` set,
  even titleless — the linkage must ride the journal, or a live client would
  list the child as a normal conversation until its next `/snapshot`) — so
  other devices learn renames and child linkage live instead of only via
  `/snapshot`. No event otherwise (unchanged/omitted title, state-only
  upserts on existing conversations).
- `convo_upsert` accepts an optional `parent_convo_id` linking a durable child
  conversation to its parent (subagent sub-chats). It is a non-empty string
  (id length cap 128; malformed → `bad_request`), **set once at creation and
  immutable afterwards**: a later upsert that omits it does not clear it, and
  one carrying a different value does not change it. The referenced parent need
  not exist yet — ordering between a child's upsert and its parent's is not
  guaranteed, so the reference is stored as-is. `parent_convo_id` is exposed
  wherever conversation metadata already flows: the `convo_meta` payload above
  (so it rides hello replay) and each `/snapshot` conversation row (`null` for
  normal conversations). See "Child conversations" below.
- Agent delivery scoping: `convo_upsert` records the upserting agent device
  as the conversation's owner (`agent_device_id`, last writer wins). Journal
  frames for an owned conversation are delivered only to that agent device;
  client devices always receive every frame. A conversation with no recorded
  owner (rows predating the column, or a bridge that hasn't re-upserted yet)
  keeps legacy broadcast-to-all-agents delivery, so multi-bridge fleets
  migrate without a flag day.
- Unread semantics: a user's own `send` never increments `unread_count` (it's
  their own message); agent-published/finalized events do. `read_marker`
  recomputes `unread_count` from events after `up_to_seq`, so
  `up_to_seq >= last_seq` always resets it to 0.
- Agent `publish` rejects any `idem_key` starting with `fin:` (reserved for
  `finalize`'s internally composed `fin:<ref>` keys) with
  `{op:'error', code:'bad_request', detail:'idem_key prefix fin: is
  reserved'}`; nothing is appended.
- Agent `activity {convo_id, state, detail?}` broadcasts a typing/tool-use
  indicator: `state` must be one of `thinking`/`tool`/`idle` (else
  `bad_request`); `detail` is an optional string, truncated (not rejected) at
  200 chars. Same ownership rule as every other agent write (missing/not-owned
  convo → `forbidden`). Delivered as `{kind:'ephemeral', convo_id,
  activity:{state, detail}}` only to the owning user's client connections
  currently `viewing` that conversation, via the same hub fan-out `stream`
  uses — never written to the journal (no seq, no unread/push effects).
- Agent `status {convo_id, status}` publishes the session's header data
  (model, context-window gauge, rate limits — the shape is owned by the
  bridge and passed through opaquely). Validated only as a non-null object
  whose JSON encoding is ≤ 4096 bytes (else `bad_request`); ownership as
  `activity` (`forbidden`); agent connections only. Delivered as
  `{kind:'ephemeral', convo_id, status:{...}}` to viewing clients, same as
  `activity` — never journaled. Unlike `activity`, the server caches the
  last status per conversation (in-memory, bounded) and replays it to a
  client immediately after it sends `viewing`, so headers populate on open
  instead of waiting for the next turn end.
- Agent `stream_append {convo_id, message_ref, offset, chunk, meta?}` streams
  live tool output (never journaled). `message_ref` is the tool_use_id;
  `offset` is the UTF-8 byte position of `chunk` in the command's output.
  The server holds a capped in-memory buffer per stream (1 MiB /
  `MATRON_TOOL_STREAM_MAX_BYTES`; 64 buffers /
  `MATRON_TOOL_STREAM_MAX_BUFFERS`; 30 min idle /
  `MATRON_TOOL_STREAM_IDLE_MS`). `meta {tool, command}` is required on the
  buffer-creating (offset-0) frame. Offset rules: `== end` appends, `< end`
  trims the overlap (idempotent retries), `> end` (or unknown buffer at
  offset > 0) draws `{kind:'control', op:'stream_resync', convo_id,
  message_ref, have}` — resend from byte `have`. Ownership as `activity`
  (`forbidden`); agent connections only.
- Viewing clients receive tool-stream ephemerals distinguished by the
  `tool_stream` key: `{event:'append', offset, chunk}` live (consecutive
  appends coalesce by concatenation, not latest-wins); on starting to view,
  one `{event:'sync', meta, offset, content, head_truncated}` per active
  stream (full scrollback so far — clients trim any append whose offset
  precedes their accumulated end); `{event:'end', reason:'stale'}` when the
  idle sweep frees a buffer whose bridge died. Normal completion sends no
  ephemeral: the durable `tool_output` event arrives with the same
  `message_ref` in its payload and retires the live view. Because journal
  frames bypass the hub's coalescing but ephemerals don't, a pending
  `tool_stream` append can flush up to 200 ms after that completion frame —
  clients must ignore `tool_stream` ephemerals for a `message_ref` already
  retired by a durable event rather than re-opening a retired overlay.
- `finalize` accepts an optional top-level `blob_ref` (same passthrough as
  `publish`) and frees the matching live-stream buffer.

## Child conversations

A bridge may link a durable **child conversation** to a parent by sending
`parent_convo_id` on the child's `convo_upsert` (subagent sub-chats — a
subagent's turns land in their own conversation instead of interleaving into
the parent's transcript). The linkage is a fixed structural fact:

- **Immutable.** `parent_convo_id` is set once, at the child's creation. Later
  upserts can never clear it (omitting the field) or repoint it (a different
  value); both are ignored. A conversation created without a parent likewise
  cannot gain one later.
- **Silent, server-side.** A conversation with `parent_convo_id IS NOT NULL` is
  exempt from both unread counting and APNs: an agent event in a child never
  increments the owner's `unread_count` and never pushes a notification (of any
  kind — alert, coalesced routine, or the read_marker background wake). The
  short-circuit is enforced by the server, not the client, so stale app
  versions stay silent for children too. The child's `last_seq`/`snippet` still
  advance normally; only the unread and push side effects are suppressed.
- **Delivery is unchanged.** Journal delivery is user-wide and every event is
  tagged with its `convo_id`, so a child's events ride the same journal as any
  other conversation's — no separate subscription. Clients discover the
  parent/child relationship from `parent_convo_id` on the `/snapshot`
  conversation row and the `convo_meta` payload.

## Device revocation

`matron-admin device revoke <device_id>` deletes the device/agent row (spec
§8) — that's the entire revocation. HTTP handlers look up the token hash
per request, so a deleted row 401s on the very next call. On the WS side,
every inbound frame *after* hello re-checks the device row still exists
(one cheap prepared `SELECT`); if it's gone, the server sends
`{kind:'control', op:'error', code:'revoked'}` and closes with code `4001`
(close-on-next-frame). A periodic sweep (every 60s) additionally checks
every *registered* connection's device row, so a revoked device that just
listens without ever sending — a lost or compromised phone — is cut off
too, with the same error frame and `4001` close. WS enforcement is
therefore **next-frame or ≤60s, whichever comes first**.
`matron-admin device list <username>` shows each device's kind, cursor,
and last-seen time.

Owners can also revoke from a client device over HTTP:
`POST /devices/:id/revoke` (Bearer, client devices only — agents get 403)
deletes the row exactly like `matron-admin device revoke`; not-owned and
nonexistent ids are indistinguishable (404 `{error:'not_found'}`).
Self-revocation is allowed and acts as a logout. WS enforcement is the
same next-frame-or-≤60s-sweep described above.

## Agent pairing (device authorization)

`gh auth login`-style enrollment for headless boxes (spec:
`docs/superpowers/specs/2026-07-15-app-managed-agent-enrollment-design.md`).
The box calls `pair/start` and displays the `pair_code` (`XXXX-XXXX`,
Crockford base32 minus vowels); the human approves that code in an
authenticated client app with `pair/approve`, naming the agent; the box
polls `pair/claim` with its secret `poll_token` (32 random bytes hex,
never displayed) and receives the agent token exactly once, straight into
its token file — no human ever sees it. Nothing durable exists until
claim: approve only flips the in-memory pair's state, and the `devices`
row is created by the claim response itself. The approve→claim regret
window (≤ TTL) is accepted in v1; once claimed, the agent appears in
`GET /devices` and is revocable instantly.

## Agent RPC (client->agent request/response)

Structured app->bridge calls (spec:
`docs/superpowers/specs/2026-07-15-agent-rpc-design.md`) — how the app asks a
bridge for its recent folders or to start a session in a folder, without
typing text commands into the control conversation.

- Client op: `agent_request {request_id, agent_device_id, method, params?}`
  (client connections only). `request_id`: <=128 chars, echoed verbatim on
  every correlated frame. `method`/`params` are opaque to the server (the
  bridge owns the vocabulary — same stance as `status`). Whole frame <=16 KiB
  (`MATRON_RPC_MAX_BYTES`). Unknown/foreign/client-kind targets are
  indistinguishable `not_found`; an agent with no live registered socket is
  `agent_unreachable` immediately (no queueing). A connection may send
  `agent_request` only once registered for live delivery itself — mid-replay
  requests draw `not_ready` (nothing forwarded; re-send verbatim after
  replay). `cursor: null` hellos register synchronously and never see it.
- Delivery to the agent: `{kind:'rpc', request:{request_id, from_device_id,
  method, params}}` — to exactly ONE socket, the device's most recently
  registered live connection (single-consumer: reconnect overlap must not
  double-execute a non-idempotent `start`). `from_device_id` is stamped
  server-side.
- Agent op: `agent_response {request_id, to_device_id, ok, result?, error?}`
  (agent connections only). `to_device_id` must be a client device of the
  same user (else `not_found`); `ok:false` requires `error.code`. Delivered
  as `{kind:'rpc', response:{request_id, agent_device_id, ok, result?|
  error?}}` to ALL live sockets of that device (responses are
  side-effect-free; clients dedupe by `request_id`).
- The relay is stateless and nothing is journaled: no seq, no unread/push
  effects, no retention surface. Timeouts are the client's job; at-most-once
  delivery, re-asking is the retry.
- v1 method vocabulary (bridge-owned, normative in the spec):
  `recent_folders {} -> {folders:[{path, last_used}]}` and
  `start {workdir?, browser?} -> {convo_id}` (errors `bad_workdir`,
  `spawn_failed`; unknown methods `unknown_method`). Cross-channel ordering
  between the `start` response and its `convo_upsert` is not guaranteed.

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

Unset `MATRON_RETENTION_DAYS` means ENABLED at the 30-day default.
`MATRON_RETENTION_DAYS=0`, or any value that isn't a non-negative integer,
disables retention instead (one warn log line at boot). Manual run:
`matron-admin offload [--days N]` (default 30).

Live-streamed tool output (`tool_output` payloads with `live_log: true`,
uploaded by bridges at command completion) is purged entirely after
`MATRON_TOOL_LOG_TTL_HOURS` (default 24; 0/invalid disables): the blob file
and its `blobs` row are deleted and the payload is rewritten to the tombstone
`{message_ref, command, exit_code, denied, truncated, live_log: true,
expired: true, blob_ref: null}` — the snippet is removed; what a command ran
and whether it succeeded survive forever, what it printed does not. If the
purged event is still the newest message-type event (text, tool_output,
diff, prompt, permission_request, file, image) in its conversation, the
conversation-list preview is rewritten to `$ <command>`. Offload skips
`expired` payloads. Manual run:
`matron-admin expire-logs [--hours N]`.

Client rules (binding on all client implementations):

- Render `expired: true` as an "output expired" affordance — show command and
  exit code, no snippet area, no fetch button.
- Any client-side persistence of `tool_output` payloads must enforce the same
  TTL locally: drop a cached snippet once `ts + 24h` passes, without waiting
  for a server re-sync — otherwise the server purge is defeated by device
  caches. In-memory display of a currently-open conversation is exempt.
- The TTL is not communicated in-protocol; clients assume the 24h default.
