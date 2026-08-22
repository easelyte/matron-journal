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
- `GET /snapshot` (Bearer) -> `{conversations, agents, seq}`. Each conversation row
  carries `parent_convo_id` (`null` for a normal conversation; set for a
  subagent child — see "Child conversations") and `agent_device_id` (the
  agent box that manages it; `null` for legacy rows created before ownership
  was recorded). A conversation with at least one **joined** `convo_agents`
  row (an agent-chat room, see "Agent chat") additionally carries
  `participants`: the recorded owner plus every joined participant's device
  id, deduped and ascending — one box chip per id, client-side. The key is
  omitted everywhere else (solo conversations, dissolved rooms, rooms whose
  only joined participants were sieved out by the privacy predicate below),
  so the wire is unchanged for everything that is not a live room.
  `agents` is `[{device_id, name}]` for the caller's
  `kind='agent'` devices — the id→name table a client needs to render which
  box owns a conversation, so no second round-trip is required. It obeys the
  same privacy predicate as the conversation list: an ordinary (non-private)
  agent caller never sees private boxes. Client devices are absent by
  design — they are not boxes. Every agent caller — private
  or not — gets `snippet` omitted from every row (it can carry `tool_output`
  text, a credential surface); an ordinary (non-private) agent additionally
  has private-owned conversations excluded entirely — see "Device privacy"
  below. Conversations are ordered by last message time, exactly as `/roster`
  documents below: `COALESCE(last_ts, created_at) DESC, id DESC`, so non-message
  activity (`session_status`/`convo_meta`/`read_marker`) never resurfaces an
  idle conversation.
- `GET /convo/:id/messages?before_seq&limit` (Bearer) -> `{events}`. `limit`
  is clamped to 1..200 (400 on non-integer/NaN/<1); `before_seq`, when given,
  must be an integer (400 otherwise). Owner-only; missing or not-owned are
  indistinguishable, both 404 `{error:'not_found'}` (never 403). For an
  **agent** token specifically, "owner" is narrower than plain user-scoped
  ownership: the same `authorizeAgentWrite` rule every other agent write
  path uses (the conversation's recorded owner device, a `joined`
  participant, or a legacy NULL-owner conversation) — a foreign convo of the
  same user's OTHER agent device is 404, same shape as a missing/not-owned
  one, never 403. This is the spec's "agents get roster metadata only, no
  cross-agent transcript reads in v1" rule enforced on the one HTTP read
  path that used to be only user-scoped; it's also exactly what a future
  `agent_chat_read` needs ("allowed for joined agents"). Client tokens are
  unaffected — still plain user-scoped ownership.
- `GET /convo/:id/messages?around_seq&limit` — a second paging mode on the
  same endpoint, mutually exclusive with `before_seq`: supplying both is
  400 `{error:'bad_request'}`. `around_seq` must be an integer when given
  (400 otherwise); `limit` uses the same 1..200 clamp as `before_seq`.
  Returns up to `limit` events centered on the anchor: `floor(limit/2)`
  strictly before `around_seq`, the remainder from `around_seq` up (so the
  anchor row itself is included when it exists) — either end of the
  conversation just yields a shorter window, never an error. This mode
  carries its own, separate agent-authorization story from the
  `before_seq`/default gate described above — see "Journal search" below
  for the full two-regime explanation.
- `GET /search?q=&limit=&convo_id=` (Bearer, any authenticated device —
  client or agent) -> `{hits: [{convo_id, title, seq, ts, sender, snippet,
  live}]}`. Full-text search over the prose the journal has indexed (see
  "Journal search" below for what is indexed and why). `q` is required,
  must be non-empty after trimming, and is capped at 256 chars (400
  `{error:'bad_request'}` otherwise); every whitespace-separated term is
  double-quoted before it reaches FTS5's `MATCH` parser (embedded quotes
  escaped by doubling) and the terms are ANDed together — an implicit-AND
  query over literal terms, so raw FTS5 syntax a human might type (an
  unbalanced quote, a bare `*`, a stray `NEAR`) can never throw; a query
  with zero terms, or one that still fails to parse, is 400
  `{error:'bad_request'}`, never a 500 with SQLite internals in it. `limit`
  defaults to 20, clamped to 50 (400 on non-integer/NaN/<1, same convention
  as `/convo/:id/messages`). `convo_id`, when given, narrows to one
  conversation; an id belonging to another user (or a nonexistent one)
  yields the same empty result set the user-scoping already guarantees for
  a genuinely-unmatched query — there is no separate existence check, so
  this is not an oracle for "does this convo_id exist." Results are ranked
  by FTS5 `bm25()` (best match first), ties broken by `ts DESC`; `snippet`
  is the FTS5 `snippet()` excerpt with matched terms wrapped in `**`...`**`
  (markdown bold — agents and the apps both render markdown); `live` is
  `true` when the hit's conversation has `session_state = 'running'`, a
  hint to talk to the working agent (`GET /roster` / `agent_chat_start`)
  rather than only read its transcript. Scoped to the caller's own user
  (`search_messages.user_id`) regardless of device kind — open to both
  agents (the feature's primary audience) and clients; an ordinary
  (non-private) agent caller additionally has hits from private-owned
  conversations excluded — see "Device privacy" below.
- `POST /media` (Bearer, client or agent) -> raw request body streamed to disk;
  `{media_id, size, content_type, sha256}`. Content-Type header captured
  (default `application/octet-stream`). 400 `{error:'empty'}` on a zero-byte
  body; 413 `{error:'too_large'}` over `MATRON_MEDIA_MAX_BYTES` (default 50 MB);
  413 `{error:'quota_exceeded'}` when the user's total blob bytes would exceed
  `MATRON_MEDIA_USER_QUOTA_BYTES` (default 2 GiB) — checked up front (rejected
  before the body streams) when already at the ceiling, and precisely after the
  size is known otherwise (the just-written file is deleted on rejection).
  Storage root: `MATRON_MEDIA_DIR` env or `<dirname of the db file>/media`,
  sharded `<root>/<id[0:2]>/<id>`.
- `GET /media/:id` (Bearer) -> streams the blob with its Content-Type,
  Content-Length and a long-lived `Cache-Control` (ids are immutable random
  handles), plus `X-Content-Type-Options: nosniff` and
  `Content-Disposition: attachment` so an uploader-chosen content-type can never
  render as active content on the API origin. Owner-only; missing or not-owned
  are indistinguishable, both 404 `{error:'not_found'}`.
  A blob may also disappear later via the quota-pressure reaper: once a user's
  total blob bytes reach `MATRON_MEDIA_REAP_HIGH_PCT` (default 90%) of the
  quota, the retention scheduler deletes their oldest `file`/`image`
  attachment blobs (never `tool_output` blobs, never orphan uploads) until the
  footprint is back under `MATRON_MEDIA_REAP_LOW_PCT` (default 70%). Each
  reaped event's payload is rewritten in place to a tombstone — the original
  fields (`name`, `size`, `content_type`, `caption`) with `blob_ref: null` and
  `expired: true` — so fresh syncs render an "expired" attachment; clients
  that already hold the event learn from the 404 on `GET /media/:id`.
- `POST /push/register` (Bearer, client devices only — agents get 403
  `{error:'forbidden'}`): `{apns_token, environment}` with `environment` in
  `{'sandbox','prod'}` registers a device for push; `{apns_token: null}`
  unregisters. 400 `{error:'bad_request'}` on a bad `environment` or a
  missing/non-string `apns_token` (unless it's `null`). Response echoes the
  device's current `push_prefs` (see `PUT /push/prefs` below); `GET
  /devices` echoes the same per-device `push_prefs` in its roster.
- `PUT /push/prefs` (Bearer, client devices only — agents get 403
  `{error:'forbidden'}`): body is any subset of `{attention, done, activity}`
  booleans — a partial merge, not a replace: only the given keys change, the
  rest keep their stored value. 400 `{error:'bad_request'}` on an unknown
  field or a non-boolean value for a known field. Response `{ok:true,
  push_prefs}` echoes the full merged three-key shape. Defaults (NULL /
  never set) are `{attention: true, done: true, activity: false}` — "buzz me
  when the agent needs me or finishes; routine activity is opt-in."
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
  `/metrics`-only. `user.devices` additionally omits private devices for a
  filtered (ordinary, non-private) agent caller — same one-caller-rule
  predicate as `/roster`/`/search`; see "Device privacy" below. A client or
  a private agent caller sees every device, unchanged.
- `GET /devices` (Bearer, client devices only — agents get 403
  `{error:'forbidden'}`) -> `{devices: [{device_id, kind, name, created_at,
  cursor, lag, last_seen_at, is_self, connected, push_prefs}]}`. The
  caller's own user's devices only; `is_self` marks the requesting device.
  `push_prefs` is the per-device notification prefs (see `PUT /push/prefs`
  above), always the full three-key shape (defaults filled in). Overlaps `/metrics`'
  `user.devices` deliberately — metrics is observability (agents may read
  it, no `name`), this is the management roster. `connected` is whether the
  device has a live WebSocket right now — the "can I start a session on
  this agent" signal; `last_seen_at` stays the offline story.
- `GET /roster` (Bearer, any authenticated device — client or agent) ->
  `{agents, conversations}`. Targeting surface for agent chat rooms (spec:
  2026-08-06 agent-to-agent chat design, Phase 2) — unlike `GET /devices`
  (management, client devices only) this is deliberately open to agent
  tokens too, and deliberately narrower. `agents`:
  `[{device_id, name, created_at, last_seen_at, connected}]` — this user's
  `kind='agent'` devices only (never client devices; no `cursor`/`lag`/
  `push_prefs`); `connected` is the same live-WebSocket check `/devices`
  uses. `conversations`:
  `[{id, title, session_state, last_seq, summary, agent_device_id,
  created_at, last_ts}]` — top-level conversations only
  (`parent_convo_id IS NULL`; children are silenced sub-chats, never invite/
  chat targets), ordered by last message time —
  `COALESCE(last_ts, created_at) DESC, id DESC` (most recent message first,
  falling back to the conversation's own `created_at` when it has no message
  events, with the immutable `id` as a stable tie-break). Deliberately NOT
  `last_seq DESC`: a `session_status`/`convo_meta`/`read_marker` event advances
  `last_seq` without being a message, so a `last_seq` order resurfaced an idle
  conversation to the top on non-message activity. `last_ts` is the newest
  **message** event's timestamp (`null` for a conversation with no message
  events), same derivation as `/snapshot`. Scoped to the caller's own user like
  every other read. See "Agent chat rooms" below for what a room and `summary`
  are.
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
- `POST /link/start` (Bearer, client devices only) -> `{link_code, expires_in}`.
  Starts a device-link session for QR sign-in (TTL 120s). One active session
  per starter device: a new start replaces the previous one. Store cap 64
  pending -> 429 `{error:'rate_limited'}`.
- `POST /link/claim {link_code, device_name}` (unauthenticated; shares
  /login's per-IP rate limit) -> `{status:'claimed', claim_token, expires_in}`.
  First claim wins: already-claimed is 409 `{error:'conflict'}`; unknown and
  expired merge into 404. `device_name` is trimmed, non-empty, max 64 chars.
  A successful claim extends the session TTL to at least 60s remaining.
- `POST /link/poll {claim_token}` (unauthenticated, not rate-limited) ->
  `{status:'pending'}` until the starter acts, then exactly once
  `{status:'approved', token, device_id, user_id, username}` (the `client`
  device is minted at this poll; the session is deleted first) or
  `{status:'denied'}` (observed once, then the session is deleted). Unknown /
  expired / already-observed: 404. `username` is included because link
  claimants never type one.
- `POST /link/status` (Bearer, client devices only; starter device only) ->
  `{status:'waiting', expires_in}` or
  `{status:'claimed', device_name, requester_ip, expires_in}`. 404 when the
  device has no active session (none started, expired, or already resolved).
- `POST /link/approve {link_code}` (Bearer, client devices only; starter
  device only, and the code must match its active session) ->
  `{status:'approved'}`. 409 `{error:'conflict'}` when the session is not in
  the `claimed` state (nothing to approve yet, or already resolved); 404 for
  unknown/expired/other-device.
- `POST /link/deny {link_code}` (Bearer, same binding as approve) ->
  `{status:'denied'}`. 404 for unknown/expired/other-device/already-resolved.

## Journal search

(spec: `docs/superpowers/specs/2026-08-07-agent-journal-search-design.md`.)
A prose-only full-text index over the journal, serving `GET /search` and
the `around_seq` context mode on `GET /convo/:id/messages` (both above) —
the feature that lets an agent look up "what happened with X" across a
user's whole history instead of only the roster metadata a foreign
conversation otherwise exposes.

### What is indexed

Two event types: `text` (`payload.body`) and `diff` (`payload.diff`,
falling back to `payload.snippet` when `diff` is empty/absent). Everything
else — `tool_output`, `prompt`, `file`, `image`, `permission_request`,
`session_status`, and any future type — is never indexed. Diffs were kept
in deliberately: "what did we change to fix X" is a real question, and
dropping them later is a one-line change if it turns out to leak too much
(a committed `.env` diff would land in the index verbatim).

One function, `indexableBody(type, payload)` (`src/search.js`), is the
single source of truth for this rule. It is called from three places: the
live append path (inside `append()`'s own transaction in `src/journal.js`,
so an event and its index row commit or roll back together), the startup
backfill, and the `around_seq` foreign-agent context filter (see below) —
one predicate, three consumers, zero drift between them.

`tool_output` is excluded on purpose and is the load-bearing case: command
output is retrieval noise for "why did we do this" questions, and it is
where credentials land. Because `indexableBody` is the exact predicate the
`around_seq` foreign-agent filter also uses, this is simultaneously the
guarantee that an agent reading context around a search hit in a
conversation it doesn't manage can never have a `tool_output` payload (or
the client-only `permission_request` consent card, or anything else
outside the prose set) placed in front of it — that guarantee rests on one
shared function, not on two filters kept in sync by hand.

### Index invariants

- **Append-only, insert-trigger-only.** `search_messages` has an `AFTER
  INSERT` trigger populating `search_fts` and nothing else — no update or
  delete trigger exists. This mirrors `events` itself: rows are written
  with a plain `INSERT`, never `INSERT OR REPLACE` (`REPLACE` silently
  skipping a delete trigger is the exact corruption that hit the app-side
  FTS index — matron-apple #106), and no `DELETE FROM events` exists
  anywhere in the server. A prose-only index of an append-only table needs
  an insert path and nothing else; if a delete path is ever added to
  `events`, this schema needs revisiting.
- **Retention never touches indexed rows.** The two retention passes under
  "Retention (payload offload)" below only ever rewrite `tool_output`
  payloads — purging live-streamed output after
  `MATRON_TOOL_LOG_TTL_HOURS` and offloading older output to a blob after
  `MATRON_RETENTION_DAYS` — and `tool_output` is never indexed. Neither
  pass can therefore invalidate a `search_messages`/`search_fts` row; the
  index has no reconciliation path with retention because it needs none.
- **Backfill is resumable and self-healing.** A startup walk over `events`
  by `rowid`, batched, indexing every row `indexableBody` accepts via
  `INSERT OR IGNORE` (never `OR REPLACE`) against `search_messages`'
  `UNIQUE(user_id, seq)` — so a re-run, or overlap with the live append
  path, is a no-op rather than a duplicate or a corruption. Progress lives
  in one row, `search_backfill_state(id=1, last_events_rowid)`, written
  after each committed batch: an interrupted run resumes from there on the
  next boot, and a completed run costs a single row read. `/search`
  returns partial results until the walk finishes — acceptable, because any
  event appended after the schema exists is indexed by the live path, so
  the backfill cursor can never miss a row on the way to catching up.

### Agent context access: two regimes

`GET /convo/:id/messages` now has two distinct authorization stories for
an agent token, selected by which query parameter is present:

- **`before_seq` (or neither param)** keeps the Phase-2 gate described
  above unchanged: an agent reads a conversation's full transcript (every
  event type, unfiltered) only for one it manages or has `joined`
  (`authorizeAgentWrite`) — a conversation outside that set stays 404,
  exactly as before this feature existed.
- **`around_seq`** is the search-context surface, and deliberately looser:
  an agent MAY read a conversation outside that set — that is the point,
  since a `/search` hit can be anywhere in the user's history — but the
  response is limited to the set the index can see (`text` + `diff`
  prose). `tool_output` and every other type, including the client-only
  agent-chat consent card, never reach an agent through this path. An
  agent's `around_seq` read of a conversation it DOES manage or has
  joined is unfiltered, same as `before_seq`; a client's read is
  identical either way — this narrowing applies to agent callers only.

  For a foreign read specifically, the seq window itself is computed FROM
  `search_messages` — the indexed prose set, not `events` — rather than
  windowed over every event and filtered afterward. In a `tool_output`-heavy
  conversation (the common case: an agent's own tool calls dwarf its prose),
  windowing over everything first and filtering after can starve a small
  `limit` down to a couple of visible rows even though plenty of prose
  exists further out; picking the window from the already-indexed set means
  a requested window is a full window of visible events whenever that much
  prose exists. `indexableBody` is still applied to the result as
  belt-and-braces against drift between the index and the rule, so it stays
  the single predicate all three consumers (live append, backfill, this
  filter) ultimately answer to — it should just never have anything left to
  filter in practice now.

  Two more restrictions apply only to this foreign-read path: `limit` is
  clamped to 30 regardless of what the caller requests (a context read is
  meant to orient around one search hit, not extract a conversation
  wholesale — the client and managing-agent paths keep the normal 1..200
  clamp), and every foreign context read is logged server-side
  (`journal: foreign-agent context read convo=… device=… anchor=…`) so the
  exposure this feature grants is observable, not silent.

  This resolves what would otherwise be a contradiction with the design
  spec's original wording, "reuses the endpoint's existing authorisation
  unchanged": that holds for a client, but for an agent it means the
  Phase-2 gate is specifically bypassed in `around_seq` mode, with the
  indexed-window-plus-`indexableBody` filter substituted in as the narrower
  replacement. Both modes still collapse "not found" and "not yours" into
  the same 404 `{error:'not_found'}` — never 403 — so a caller can't use
  either path to probe which conversations exist.

## WebSocket

- `WS /ws`: first frame `{op:'hello', token, cursor}` (cursor null = live-only).
  Server: `hello_ok {seq, device_id, name}`, then journal frames `> cursor`,
  then live. `device_id`/`name` are the authenticated device's own identity —
  bridges use them for agent-chat rooms (own-echo guard, roster
  self-exclusion, room titles).
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
  finalize, activity (ephemeral), status (ephemeral, cached), host_vitals
  (ephemeral, cached, host-global — no convo_id). `read_marker`
  is available to both kinds:
  an agent (bridge) connection may advance its user's read marker too —
  e.g. after mirroring the user's own message into the journal, so that
  mirrored round-trip doesn't inflate the unread badge.
  `up_to_seq: null` resolves server-side to the conversation's current
  `last_seq` at processing time, so a fire-and-forget publisher never needs
  to learn the seq it was assigned; explicit integers keep working as before.
- Live journal frames (fan-out at append time) carry `sender_device_id` —
  the numeric device id of the connection that produced the event. Device
  names have no unique constraint, so this is the only exact own-echo test
  a bridge has in a shared room. Deliberately live-only: absent from hello
  replay frames and never stored in the event row, so consumers must fall
  back to sender-name matching for replayed history.
- Publishes and sends are at-least-once: a caller that doesn't get a
  confirmation should retry with the same `idem_key`/`local_id`. A deduped
  retry gets NO dedicated confirmation frame — convergence is observed via
  the journal frame carrying the event, which carries the same `seq` on
  every delivery (original or retried).
- Conversation ids are a global primary key across all users, not scoped to a
  user or device. Bridges MUST mint globally unique ids — Claude session
  UUIDs are the convention.
- `convo_upsert` appends a `convo_meta` journal event
  (`payload:{title, parent_convo_id, agent_device_id}`, sender = the agent device, e.g.
  `agent:dev-2`) whenever it changes an existing conversation's title, sets
  a non-empty title at creation, or creates a child (`parent_convo_id` set,
  even titleless — the linkage must ride the journal, or a live client would
  list the child as a normal conversation until its next `/snapshot`) — so
  other devices learn renames and child linkage live instead of only via
  `/snapshot`. No event otherwise (unchanged/omitted title, state-only
  upserts on existing conversations). `agent_device_id` is the upserting
  connection's own device — the same id `convo_upsert` records on the row —
  so a live client can attribute a brand-new conversation to its box without
  waiting for the next `/snapshot`.
- Room membership changes append a server-authored `convo_meta` (sender
  `journal`) whose payload is just `{participants}` — the same
  owner-plus-joined array `/snapshot` carries — so live clients re-chip a
  room the moment an invite is accepted, a spawn room appears (there it
  rides the creation `convo_meta` alongside `title`), a participant leaves,
  or the owner dissolves the room. Emitted only when membership actually
  changed: refusals and repeat dissolves append nothing. Clients treat every
  `convo_meta` key independently; a membership-only payload leaves
  title/parent/owner untouched.
- `device_meta` — `{kind:'device_meta', device_id, name}`, sent to a user's
  **client** sockets when `POST /devices/:id/rename` succeeds. Transient: not
  a journal event, carries no seq, and is never replayed. Recovery for a
  client that misses one depends on the renamed device's kind, because every
  kind may be renamed but `/snapshot`'s `agents` list carries only agent
  boxes: an **agent** rename is picked up from that list on the next
  `GET /snapshot`; a **client** rename appears only in `GET /devices`, which
  lists every device kind, so a client that renders other client devices
  re-reads the roster there. Agent connections never receive `device_meta` —
  a box keeps no roster.
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
- `convo_upsert` accepts an optional `summary` (string, ≤1000 chars —
  `bad_request` over the cap): a rolling 2-3 sentence conversation summary
  the owning bridge maintains as a targeting aid for `GET /roster` (see
  "Agent chat rooms" below). Same don't-clobber discipline as `title`/
  `parent_convo_id`: only an upsert that carries a non-null `summary`
  changes the stored value; omitting it leaves the existing summary
  untouched. Unlike a title change, a summary change never appends a
  `convo_meta` event — it's roster-read material, not something a live
  client needs to learn mid-conversation.
- Agent delivery scoping: `convo_upsert` records the upserting agent device
  as the conversation's owner (`agent_device_id`). Ownership is
  last-writer-wins **except** for a guest: a device that has ever appeared
  in `convo_agents` for this conversation (`invited`, `joined`, `refused`,
  `left`, or `expired` — any state at all) never becomes the recorded owner
  on upsert, so a room participant's own housekeeping upserts can't steal
  delivery ownership from the room's real owner (spec: agent chat phase 2,
  the "ownership no-steal" fix). A device with no participant row keeps the
  old takeover behavior — a re-paired bridge gets a new device id and must
  still be able to reclaim its own sessions. Journal frames for an owned
  conversation are delivered to that owner device **and** every currently-
  `joined` participant (see "Agent chat rooms" below); client devices always
  receive every frame. A conversation with no recorded owner (rows
  predating the column, or a bridge that hasn't re-upserted yet) keeps
  legacy broadcast-to-all-agents delivery, so multi-bridge fleets migrate
  without a flag day. Hello replay (the `cursor`-driven catch-up above)
  applies the identical owner-or-joined-participant predicate per
  conversation for an agent connection, so a joined participant catching up
  after a disconnect sees the room's backlog too, not just live traffic
  from the moment it joined.
- **Room-upsert ownership gate.** Before `convo_upsert` reaches the
  ownership no-steal logic above, the server checks: if the conversation
  already exists **under the caller's own user**, has at least one
  `convo_agents` row (any state — the conversation is a "room"), and its
  recorded owner (`agent_device_id`) is non-NULL and different from the
  upserting device, the WHOLE upsert is rejected with `{code:'forbidden',
  detail:'only the room owner may upsert a room'}` — no title/state/summary
  change is applied, not even a non-ownership-changing one. The gate's
  lookup is deliberately scoped to the caller's user id: an upsert naming
  another user's conversation falls through to the generic cross-user
  rejection (`{code:'forbidden'}` with no detail), so the room-specific
  detail never confirms to a foreign agent that a given convo id exists
  and is a populated room. This is stricter than the no-steal rule
  above: a guest used to be allowed to upsert a room's title/session_state
  (just never reassign its ownership); now, once a room has ANY
  participant history, only its recorded owner may upsert it at all —
  joined guests and uninvited strangers alike, since either one's own
  housekeeping upsert would otherwise flap title/session_state/summary
  that the room's creator owns. A participant-less conversation (no
  `convo_agents` rows at all) keeps the old last-writer-wins takeover
  behavior — a re-paired bridge with a new device id can still reclaim its
  own sessions — **except when the recorded owner is a private device**
  (see "Device privacy" below): there, an ordinary caller's takeover is
  refused instead, and a conversation with no recorded owner (legacy NULL)
  stays writable by anyone. Accepted trade-off for v1: a re-paired owner
  (new device id after a bridge restart pairs fresh) can no longer reclaim
  a room it created once that room has participant history, because the
  gate sees a mismatched non-NULL owner and a populated `convo_agents`
  table — same "needs a fresh invite" story as any other stranger. The
  ownership no-steal predicate in `upsertConversation` itself still runs
  underneath as belt-and-braces for any caller that reaches it directly
  (e.g. a test harness bypassing the WS layer), but on ordinary WS traffic
  this gate rejects a disqualified upsert before that code ever runs.

  **Operational trap: re-pairing a private bridge onto a fresh device id.**
  The private-owner guard checks the NEW connection's own `private` flag,
  not any memory of the old device — so whether a re-paired bridge can
  reclaim its own participant-less conversations depends entirely on how
  its new device id acquires privacy, and the two paths behave very
  differently:
  - **`MATRON_AGENT_PRIVATE` (bridge-side env var) self-heals.** The bridge
    asserts `private` on every `hello`, and `hello` always completes before
    any op (including `convo_upsert`) is processed on that connection — so
    if the env var travels with the re-pair, the fresh device is marked
    private before its first upsert ever reaches the guard, and reclaiming
    its old sessions just works, no operator action needed.
  - **An admin PIN on the OLD device id does not transfer.** `matron-admin
    device private <id> on` pins one specific `devices` row; a re-pair
    mints a brand-new row that starts unpinned and `private=0` by default
    (see the schema default above). If the operator relied on the pin
    rather than the env var, the new device is *ordinary* the moment it
    connects: its `convo_upsert`s on the old private-owned conversations
    return `forbidden`, ownership never transfers, and that history is
    effectively read-only to the new device until an operator either runs
    `matron-admin device private <new_id> on` or ensures the env var is set
    so the next re-pair self-heals instead.
- Agent write authorization: `publish`, `finalize`, `stream`,
  `stream_append`, `activity`, and `status` all gate on the same rule
  (`authorizeAgentWrite`) — the agent device must be the conversation's
  recorded owner (`agent_device_id`), a `joined` participant (`convo_agents`
  state=`'joined'`), or the conversation must have no recorded owner at all
  (legacy NULL, broadcast-era rows — any of the user's agent devices may
  write there). Anything else — a different agent device's conversation the
  caller was never invited into, or one it was invited into but hasn't
  accepted / has since left / has expired — fails closed as
  `{kind:'control', op:'error', code:'forbidden', ref:<op>}` (`publish`/
  `finalize` add `detail:'not a participant of this conversation'`).
  `convo_upsert` and `read_marker` are deliberately NOT gated by this rule
  (`authorizeAgentWrite`'s owner-or-joined-participant test) — but each has
  its own, narrower gate instead, not a free pass:
  - `convo_upsert` is how a device becomes an owner or a guest in the first
    place, so it can't require the very standing it's used to establish —
    but it is not ungated: see "Room-upsert ownership gate" above for the
    populated-room case and "Device privacy" below for the private-owner
    takeover guard layered on top of it for a participant-less room.
  - `read_marker` stays scoped to the conversation's owning user only — a
    bridge may mark its user's own messages read without being `joined` —
    but as of "Device privacy" below, an ORDINARY agent caller marking a
    conversation whose recorded owner is a private device, that the caller
    is not a known participant of (`isKnownParticipant`), gets the same
    `forbidden` its own unknown-convo-id path already returns. This is safe
    precisely because `read_marker` only ever advances the CALLER'S OWN
    user's read state (never another user's — `markRead` is scoped by
    `who.userId` like every other op) and writes no message content of any
    kind: there is no content to steal or forge, and no way to use it to
    gain or fake participation in a room — the privacy gate exists to close
    an *existence-oracle* and *unwanted-write* hole, not a content-leak one.
- Unread semantics: a user's own `send` never increments `unread_count` (it's
  their own message); agent-published/finalized events do. `read_marker`
  recomputes `unread_count` from events after `up_to_seq`, so
  `up_to_seq >= last_seq` always resets it to 0. Certain event kinds are
  never counted toward unread: `convo_meta` (a rename), `summary` (TOC metadata),
  and `edit` (not new activity).
- `summary` events: agent-publishable message kind carrying `{toc, detail, model}`
  (payload is opaque to the server — no field-level validation or size caps
  enforced; the server only checks the payload is a non-null object; any
  truncation is bridge-side). TOC summaries are derived metadata: journal-synced
  (fans out and replays to all devices), never FTS-indexed, never increment
  `unread_count`, and never trigger APNs push (journal-sync-only, like
  `convo_meta` — clients learn them from the replay, not from notifications).
- Agent `publish` rejects any `idem_key` starting with `fin:` (reserved for
  `finalize`'s internally composed `fin:<ref>` keys) with
  `{op:'error', code:'bad_request', detail:'idem_key prefix fin: is
  reserved'}`; nothing is appended.
- Agent `stream {convo_id, message_ref, text?, replace_text?}` broadcasts a
  live message overlay (never journaled). Same ownership rule as every other
  agent write (missing/not-owned convo → `forbidden`); `text`/`replace_text`
  must be strings when present (else `bad_request`). No separate byte cap — the
  1 MiB WS frame limit bounds it and nothing is retained (transient,
  latest-wins in the hub coalescer). Delivered as `{kind:'ephemeral', convo_id,
  message_ref, text, replace_text}` to viewing clients.
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
- Agent `host_vitals {vitals}` publishes a host-global machine sample
  (`vitals` = `{cpu, ram, sampled_at_ms}`, shape owned opaquely by the
  bridge). Unlike every other agent op it carries **no `convo_id`** and has
  **no ownership check** — vitals belong to the machine, not a conversation.
  Agent connections only (a client gets `forbidden`); `vitals` validated only
  as a non-null object whose JSON encoding is ≤ 4096 bytes (else
  `bad_request`). Delivered as `{kind:'ephemeral', host_vitals:{...}}` to
  **all** of the user's client connections regardless of what (if anything)
  they are `viewing` — the one ephemeral that bypasses the viewing filter.
  Never journaled. The server caches the last sample per user (in-memory,
  bounded) and replays it to a client immediately on connect (after
  `hello_ok`), so a fresh client paints its vitals gauge without waiting for
  the next sample. Rate-limited server-side to one accepted frame per second
  per agent connection (excess dropped silently); a backed-up client is
  skipped for a sample rather than queued (latest-wins telemetry). Keyed by
  user, so it assumes one host per user — see `makeVitalsCache` in
  `src/ws.js` (multi-host is deferred to matron loop #542).
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

## Agent chat rooms

A **room** is not a new entity — it's an ordinary top-level conversation
(never a child; see "Child conversations" above) whose owner
(`agent_device_id`) has drawn other agent devices of the same user into its
lifecycle via the `convo_agents` table (spec: 2026-08-06 agent-to-agent chat
design, Phase 2; consent gating: 2026-08-07 agent chat consent design). A
`convo_agents` row is a **grant**, one per `(convo_id, agent_device_id)`,
that moves through a small state machine:

    awaiting_user -> invited -> joined
         │              │      └─refuse──> refused
         │              └─ttl──────────> expired
         ├─deny────> denied
         └─ttl─────> expired
    joined  -> left

`awaiting_user` and `invited` are the two pending states.
`awaiting_user` means the request is parked awaiting the **user's**
decision (see "Consent gating" below) — it is where every `agent_invite`/
`agent_join` lands by default. `invited` means the user has decided and
the target agent has yet to answer. `joined` is the only
state that confers delivery and write rights (see "Agent write
authorization" and "Agent delivery scoping" above). A row left in
`refused`, `denied`, `left`, or `expired` is **renewable** — a fresh
`agent_invite`/`agent_join` may reuse the same `(convo_id, agent_device_id)`
pair and resets it to `awaiting_user`; a row already `awaiting_user`,
`invited`, or `joined` is not
— inviting/joining over one of those returns `{code:'conflict',
detail:'already <state>'}` instead of silently resetting it (a
double-invite is a caller bug worth surfacing, not a no-op; the same
non-renewability keeps a still-pending `awaiting_user` ask from becoming a
re-request loop against the user's attention — see the per-requester cap
below).

Every row also records `initiator_device_id` — whichever side asked (the
room owner sending an invite, or the would-be participant sending a join
request) — because the **other** side is the one entitled to answer: the
initiator can never ack or answer its own invite
(`{code:'forbidden', detail:'the initiator cannot answer its own invite'}`).

### The five room ops

All five are agent-connection-only (`{code:'forbidden'}` for a client
connection) and all five require the connection to be past its own hello
replay (`conn.registered`; `{code:'not_ready'}` otherwise — same stance as
`agent_request`: a reply might need to reach this very socket, and
mid-replay it's invisible to the hub's delivery scan). Every op resolves
`room_id` the same way: `bad_request` for a missing/non-string/oversized
(>128 char) id, `not_found` for an unknown id or one owned by another user,
`bad_request` for a child conversation (`parent_convo_id` set — children
can never be rooms). Error frames for these five ops also carry
`room_id` — a bridge can have several rooms' ops in flight at once, and
`ref` alone can't say which room an error is about — but only when the
inbound `room_id` was a well-formed id (non-empty string, ≤128 chars); a
malformed id is never echoed back. Other ops' error frames are unchanged.

- **`agent_invite {room_id, target_device_id, target_convo_id?, from_convo_id?, topic?, justification}`** —
  only the room's own owner (`agent_device_id === conn.deviceId`) may send
  it (`forbidden` — "only the room owner may invite" — otherwise);
  `target_device_id` must be a different agent device of the same user
  (`not_found` for an unknown id, another user's device, or a client-kind
  device — anti-enumeration, same stance as `agent_request`; `bad_request`
  for inviting self). `topic` is optional (≤200 chars,
  `INVITE_TOPIC_MAX_CHARS`), `justification` is required (1-1000 chars,
  `INVITE_TEXT_MAX_CHARS`).

  `target_convo_id` is optional and names **which of the target device's
  conversations** the ask is for. A caller picks a conversation off
  `/roster`, but the invite otherwise resolves down to that conversation's
  owning device — and a receiving bridge running several sessions then
  cannot tell which was meant. Where it is absent (a pre-3.5 caller) the
  receiver falls back to a guess; where it is present it is **authorisation,
  not a hint**: it must be a top-level conversation of this user that
  `target_device_id` actually owns, else `not_found` — the same code the
  unknown-device case gets, so a caller cannot probe for conversations it
  can't see. Persisted on the `convo_agents` row (so it survives a park for
  consent) and relayed verbatim on the `request` frame; **omitted, never
  null**, when the caller sent none, so a receiver can tell "not addressed"
  from "addressed to nothing".

  `from_convo_id` is its mirror image: optional, and naming **which of the
  requester's own conversations** is doing the asking, so the consent card
  can say who is asking rather than just which device. Validated the same
  way and for the same reason — a top-level conversation this connection's
  own device owns, else `not_found`. It is display-only: unlike
  `target_convo_id` it is not persisted or relayed, only resolved to a title
  for the card.

  Every ask parks: it creates/renews an `awaiting_user` row and the target
  agent is sent **nothing** — the justification never leaves the journal
  until the user approves it (see "Consent gating" below). The caller still
  gets `{kind:'invite', event:'delivered', room_id, target_device_id}`
  immediately — see "Consent gating" below for what `delivered` means here.
- **`agent_join {room_id, justification}`** — the reverse direction: an
  agent asks to join a room it doesn't own. The room must have a recorded
  owner (`{code:'conflict', detail:'room has no recorded owner to ask'}`
  otherwise) and the caller can't be that owner
  (`{code:'bad_request', detail:'cannot join own room'}`). Same park as
  `agent_invite`, with the caller as both the participant and the
  initiator and the room's owner device as the target: it creates/renews
  an `awaiting_user` row, and the caller gets `{kind:'invite',
  event:'delivered', room_id, target_device_id:<owner>}` while the owner
  is sent nothing until the user answers.
- **`agent_invite_ack {room_id, peer_device_id?, session_state}`** — a
  non-committal status ping while an invite/join is still pending
  (`invited`), sent by whichever side did NOT initiate. `session_state` must
  be `'idle'` or `'busy'` (`bad_request` otherwise). `peer_device_id`
  selects direction: present means the room owner is acking a join request
  (naming the requesting participant device — only the owner may supply it,
  `forbidden` otherwise); absent means a participant is acking an invite
  addressed to itself. No pending `invited` row for the resolved device
  (`{code:'conflict', detail:'no pending invite'}`) or the caller IS that
  row's initiator (`forbidden`, see above) both fail closed. Delivered to
  the initiator as
  `{kind:'invite', event:'ack', room_id, from_device_id, session_state}` —
  no journal entry, no state change.
- **`agent_invite_answer {room_id, peer_device_id?, accept, reason?}`** —
  resolves a pending `invited` row to `joined` (`accept:true`) or `refused`
  (`accept:false`); same direction rule, pending-row check, and
  initiator-can't-answer-itself check as `agent_invite_ack` above (a row
  that stopped being `invited` between the check and the update — e.g. a
  race with the expiry sweep — also surfaces as `{code:'conflict',
  detail:'no pending invite'}`). `reason` is optional (≤1000 chars,
  `INVITE_TEXT_MAX_CHARS` — a refusal justification, typically). Delivered
  to the initiator as
  `{kind:'invite', event:'answer', room_id, peer_device_id, accept,
  from_device_id, reason?}` (`reason` omitted from the frame when
  absent/empty). `from_device_id` is the device that actually sent this
  `agent_invite_answer` — the room owner when answering a join request
  (`peer_device_id` present, naming the joiner instead), or the invited
  participant itself otherwise — so the initiator always learns who
  answered, not just which row changed. Contrast with the expiry sweep's
  synthetic `answer` frame below, which has no answering connection behind
  it and so carries no `from_device_id`.
- **`agent_leave {room_id}`** — a joined participant leaves (`joined` ->
  `left`; `{code:'conflict', detail:'not a joined participant'}` if the
  caller isn't currently joined). If the room has a recorded owner other
  than the caller, that owner is told:
  `{kind:'invite', event:'left', room_id, from_device_id}`. When the
  caller IS the room's recorded owner (who has no `convo_agents` row of
  its own) **and the conversation is actually a room** — it has at least
  one `convo_agents` row, in any state — the room dissolves instead:
  - Every *live* row (`joined`, still-pending `invited`, or parked
    `awaiting_user`) flips to `left`. Terminal outcomes (`refused`,
    `denied`, `expired`) are left alone: they are history, not membership.
  - Each previously-**joined** participant is sent the same
    `{kind:'invite', event:'left', room_id, from_device_id}` frame.
  - Each pending `invited`/`awaiting_user` row that the *other* side
    initiated — i.e. a `agent_join` request awaiting this owner's answer,
    whether already relayed (`invited`) or still parked awaiting the
    user's consent (`awaiting_user`, never delivered to any agent socket)
    — gets that answer now, as
    `{kind:'invite', event:'answer', room_id, peer_device_id, accept:false,
    reason:'left'}`, delivered to the requester. Without it the requester
    would wait forever: it is its own row's initiator, so it never sends
    an `agent_invite_answer` that could surface a `conflict`, and the
    dissolve puts the row out of reach of both the expiry sweep and the
    awaiting-TTL sweep. Same synthetic shape as the sweep's expiry
    `answer` (no `from_device_id`) — see "Expiry" below. A pending row the
    *owner* initiated needs no frame: for an `invited` row the invitee was
    never in the room and was not waiting on an answer; for an
    `awaiting_user` row the target was never even told about the ask.
    Either row's next answer attempt (`agent_invite_answer`, or
    `POST /agent-chat/answer` for a parked one) surfaces `conflict`/`409`
    instead.

  Success is silent either way (no-error-means-success), which keeps
  owner-leave idempotent: repeating it on an already-dissolved room (rows
  exist, all `left`) succeeds silently again. A conversation with **no**
  `convo_agents` rows at all is not a room — `convo_upsert` stamps the
  creating device as `agent_device_id` on every agent-created
  conversation, so this case is just an ordinary solo convo — and leaving
  it is the usual `{code:'conflict', detail:'not a joined participant'}`.

### Consent gating (`awaiting_user`)

(spec: `docs/superpowers/specs/2026-08-07-agent-chat-consent-design.md`.)
Every `agent_invite`/`agent_join` is a park, not a relay: the request lands
in `awaiting_user` and the target agent is told nothing, every time — there
is no way to pre-approve a directed pair. The requester's
`justification` (an attacker-controlled string if the requesting agent has
been prompt-injected) never reaches a sibling agent's context; it reaches a
human first.

**The card.** Parking appends a `permission_request` event to the **room
conversation** — not the requester's or the target's own session
conversation; the room is where the chat will actually happen if approved,
and it is what the push notification below deep-links the user to.
Payload:

```json
{
  "kind": "agent_chat",
  "request": "invite" | "join",
  "room_id": "…",
  "from_device_id": 7,
  "from_name": "…",
  "target_device_id": 12,
  "topic": "…",
  "justification": "…",
  "from_convo_id": "…",
  "from_convo_title": "…",
  "to_name": "…",
  "to_convo_id": "…",
  "to_convo_title": "…"
}
```

The last five are **display-only** and exist so the card can state who is
asking whom. `to_name` is the device on the far end — the invitee for an
`invite`, the room's **owner** for a `join` — and is always populated. The
two id/title pairs identify the two sessions, and are `""` when the
requesting bridge named no conversation (`from_convo_id` / `target_convo_id`
omitted), so a client must treat a blank as "not stated" rather than
rendering an empty quote. Note `to_name` deliberately does not track
`target_device_id` on a join: the field below names the row to answer, while
`to_name` names who is being asked.

Both id and title are sent because neither alone identifies a session to a
user. Bridges seed a session title with a `"<box>:<first two of the convo
id>"` prefix, which is what the conversation list displays — but a room's
title has no prefix, a retitle can drop one, and two sessions can share
wording. Clients should render the short id from the **id** and, so the
same characters do not appear twice, leave the title alone when it already
carries that prefix. A title is a snapshot taken when the ask was made: the
card is an immutable event, so a later retitle does not rewrite it.

`from_convo_id` is authorisation, not decoration, exactly as
`target_convo_id` is: the requester may only name a top-level conversation
its own device owns, else `not_found`. A title is shown to the user as the
asker's identity, so an unchecked one would let a requester borrow another
session's name to be trusted by.

`target_device_id` is **the parked row's own device** — the invitee for an
`invite`, and the requester itself for a `join` (a join self-targets, so
`from_device_id === target_device_id` there). It is the value
`POST /agent-chat/answer` keys on, so a client can answer a card using
nothing but the card's own fields. Do not confuse it with the ephemeral
`{kind:'invite', event:'delivered', …, target_device_id:<owner>}` ack the
joining agent gets, which reports who was asked rather than which row is
pending.

sent with `sender: "agent:<name>"`, same sender convention as any other
agent-authored event. `from_name`, `topic`, and `justification` are all
remote-agent-controlled text and are run through the journal's own
sanitiser before storage/publish — control characters (including `\n`)
become spaces, collapsed, trimmed to `INVITE_TOPIC_MAX_CHARS`/
`INVITE_TEXT_MAX_CHARS` — the same treatment the bridge already applies to
peer text it renders in its own voice, now applied journal-side because the
journal is the one publishing this event. Apps must render `justification`
as untrusted text (no markdown, no autolinking) — it is attacker-
controlled content shown to a human about to make a security decision.

**It is a client-only event, load-bearing.** `permission_request` with
`payload.kind === 'agent_chat'` is excluded from agent delivery — live
fan-out, hello replay, and HTTP message pagination — by `isClientOnlyEvent`
(`src/journal.js`), consulted at all three call sites so they can't drift
apart. It also gates the write side: an agent's `publish`/`finalize` reject
a payload shaped like the card outright, since it must only ever be minted
by the server's own `agent_invite`/`agent_join` park path. This is enforced
even against the room's own recorded owner: a naive fan-out would deliver
to the owner first (it manages the room), which for an `agent_join` card
is exactly the target the justification must stay hidden from. Contrast
with the `kind:'invite'` frames in "Delivery" below, which are a different,
unrelated mechanism (ephemeral, WS-only, agent-to-agent) that the card
plays no part in.

**Reading and answering the card.** Two client-gated (`who.kind !== 'client'`
→ `403`) HTTP endpoints, since only a human may decide:

- **`GET /agent-chat/pending`** → `{pending: [...]}`, one entry per
  `awaiting_user` row owned by the caller's user:
  `{convo_id, agent_device_id, initiator_device_id, justification, topic,
  created_at, title, initiator_name, agent_name}` (`title` is the room's;
  the two names are the devices', sanitised and capped exactly as the live
  card's `from_name` is, and `null` if the device has since been revoked).
  A durable inbox for a client that missed the live card or wants to review
  every outstanding ask at once.
- **`POST /agent-chat/answer`** `{room_id, target_device_id, decision:
  "approve"|"deny"}` — `room_id`/`target_device_id` must
  resolve to a **row belonging to the caller's own user**
  (`conversations.owner_user_id`); an unknown room and one owned by another
  user are indistinguishable (`404 {error:'not_found'}`, never `403` — same
  anti-enumeration stance as `GET /convo/:id/messages`). The row must be
  `state='awaiting_user'` or the call is `409 {error:'conflict'}` (already
  answered, or never parked). A body carrying `always_allow` at all — any
  value — is `400 {error:'bad_request'}`, not silently ignored: there is no
  standing-consent grant left for it to mean, and a caller that believed it
  had granted one would be worse off than a caller told plainly the field
  is not accepted.
  - **`deny`** flips the row to `denied` and, if the initiator is
    reachable, sends it `{kind:'invite', event:'answer', room_id,
    peer_device_id: target_device_id, accept:false, reason:'refused'}` —
    `reason` is **`'refused'`, never `'denied'`**. A requesting agent must
    never be able to tell "the human said no" from "the peer said no";
    collapsing the two into one wire string is what keeps that true (the
    distinct `denied` DB state exists for the user's own audit trail, not
    for the requester).
  - **`approve`** flips the row to `invited`, then calls the delivery pump
    (see below) scoped to this row's own recipient, and the response is
    `{ok:true, delivered}` where `delivered` is read back off the
    just-answered row's own `delivered_at` (not a pump-wide "something got
    sent" flag) — `true` if the target happened to be connected right now,
    `false` if delivery is still owed.

**`delivered` widens.** The requester's `{kind:'invite', event:'delivered',
room_id, target_device_id}` frame arrives at parking time — before the
human has even seen the card, let alone approved it. `delivered` does not
mean "the target's socket got the frame"; it means "accepted into the
system". The bridge's `agent_chat_start` tool copy already tolerates this
(a `pending` result is documented as normal and not to be polled).

**Delivery pump.** Approval alone cannot deliver — the room's target agent
may be offline, and an approval made through `matron-admin` (a separate CLI
process, not the running server) never touches the hub at all. A single
function, `deliverPendingInvites(db, hub, {deviceId?})` (`src/invite-
delivery.js`), owns delivery for every `state='invited' AND delivered_at IS
NULL` row, and is called from three places: `POST /agent-chat/answer`
(scoped to the just-answered row's recipient, for the fast path), an
agent's `hello` registration (scoped to that device, catching up whatever
was approved while it was offline), and the periodic sweep timer (unscoped
catch-all — covers `matron-admin`-approved rows, and any row whose target
was already connected at approval time so no hello would ever fire for
it). `markDelivered`'s `delivered_at IS NULL` predicate makes the pump
idempotent — a hello racing the sweep can double-*call* the pump but not
double-*deliver* — and `matron-admin agent-chat approve` says as much in
its own output, since the CLI itself has no path to the hub whatsoever and
the delivery genuinely happens later, out of its hands.

**Device revocation clears room membership.** Deleting a device deletes
every `convo_agents` row where it is the participant, by way of
`agent_device_id REFERENCES devices(id) ON DELETE CASCADE`. `devices.id` is
a plain `INTEGER PRIMARY KEY`, so SQLite assigns `max(rowid)+1` and the
device created after the newest one is revoked lands on exactly its id —
without this, retiring an agent and registering its replacement would hand
the replacement the retired agent's room memberships by number alone.

The constraint carries this rather than the revoke sites, because there are
two of them: `POST /devices/:id/revoke` used to do the cleanup itself and
`matron-admin device revoke` did not, so the same operation left different
state depending on which door it came through.

`initiator_device_id` deliberately has no such constraint. It records who
*asked*, and a parked ask outlives its requester: the row stays, and
`/agent-chat/pending` reports a `null` name for the device that is gone.

**Cap.** Outstanding `awaiting_user` rows per *requesting* device are
capped at `MAX_AWAITING_PER_REQUESTER` (3); over the cap, `agent_invite`/
`agent_join` fail `{code:'conflict', detail:'too many requests awaiting
user approval'}` rather than queuing indefinitely against the user's
attention.

**`matron-admin agent-chat` — the operator approval surface.** The same
decisions from the CLI, writing the DB directly — for an operator without
a client device to hand, or a user whose apps predate the card UI:

```
matron-admin agent-chat pending <username>
matron-admin agent-chat approve <username> <room_id> <device_id>
matron-admin agent-chat deny <username> <room_id> <device_id>
```

`pending` lists one line per `awaiting_user` row for that user (room id,
target device id/name, topic, justification, relative age). `approve`
rejects a `--always-allow` flag outright — it exits non-zero with a message
that the flag no longer exists and every agent-chat request now asks the
user, rather than silently approving without it.
`approve`/`deny` re-run the same room-ownership check `POST
/agent-chat/answer` does (`conversations.owner_user_id` must match the
named user) before touching the row — this is not skippable just because
the CLI is a trusted operator surface; taking a username is precisely what
makes the check meaningful. Because this CLI cannot reach the running
server's hub, its output says so plainly both ways: an approval is relayed
by the sweep-tick pump (or that agent's next hello), not by this command,
within one sweep interval; a denial cannot push an answer frame to the
requester at all — its waiter simply times out to pending, and the state
change is only visible on its next attempt.

### Expiry

Two independent TTLs, on two different clocks, because they answer two
different questions — "has the *target agent* gone quiet?" versus "has the
*user* gone quiet?" — and the two must not be conflated (see "What the
requester learns" below).

A pending `invited` row older than the invite TTL (`inviteTtlMs`, default 30
minutes — 1800000 ms, the `inviteTtlMs` parameter default in `attachWs`) is flipped to `expired` by the
same periodic sweep that handles the tool-stream idle eviction and device
revocation checks (see "Device revocation" below) — generous on purpose,
because a busy responder is expected to report that honestly via
`agent_invite_ack` rather than race the clock. This TTL clocks from
`delivered_at`, **not** `created_at` — the 30-minute window is a window for
the target to *answer*, so it must not start ticking before the target has
actually seen the ask; a row that is `invited` but still undelivered
(target offline, or approved-but-not-yet-pumped) is exempt and can never
expire out from under a target that hasn't heard the ask yet. The initiator
hears an expiry exactly like an explicit refusal:
`{kind:'invite', event:'answer', room_id, peer_device_id:<agent_device_id>,
accept:false, reason:'expired'}`. If the initiator is offline at sweep time
it simply misses the frame, same as any other invite frame (see "Delivery"
below) — its next roster read or invite/join attempt tells the same story
(`state:'expired'` via a fresh, renewed invite). An expired row is
renewable, same as `refused`/`left`.

A parked `awaiting_user` row — the user, not the target agent, hasn't
answered — has its own, much longer TTL: `AWAITING_USER_TTL_MS`, 24 hours,
clocked from `created_at` (there is no delivery to wait for; the card was
already published the moment the row was parked). Generous on purpose: an
ask that arrives while the user is asleep must survive the night. The same
sweep flips it to `expired` and notifies the initiator — but, unlike the
`invited`-TTL case above, with `reason:'refused'`, **not** `'expired'`: a
user who never looked at the card and a user who looked and said no must
read identically to the requester (see "What the requester learns" in the
consent design spec). `denied` (an explicit `POST /agent-chat/answer
{decision:'deny'}` or `matron-admin agent-chat deny`) uses the same
`reason:'refused'` wire string for the same reason — three different DB
facts (`denied`, `refused`, this TTL's `expired`), one indistinguishable
story on the wire.

Owner-dissolve produces the same synthetic frame with `reason:'left'`
instead (see `agent_leave` above): a pending join request that the room's
dissolution has made unanswerable is closed the same way an expired one
is, because the waiting initiator is in the same position either way. Both
frames omit `from_device_id` — there is no answering connection behind
them — so an initiator can handle the pair identically and read `reason`
only to log *why*.

### Delivery

Every `kind:'invite'` frame — `request`, `join_request`, `delivered`,
`ack`, `answer` (including the sweep's own expiry `answer`), and `left` —
is an ephemeral relay, same stance as Agent RPC: **never appended to the
journal** (no `seq`, no unread/push effects, no retention surface),
**never pushed** (APNs never sees it), and **never sent to client
devices** — only the two agent devices on either side of the invite ever
see these frames. `delivered`/`request`/`join_request` use the
single-socket `hub.sendRpcRequest` delivery rule (one most-recently-
registered live connection; `offline` if none — non-idempotent, so it must
never double-deliver). `ack`/`answer`/`left` use `hub.sendToDevice`
(multicast to every live socket of that device) — these don't carry the
same double-execution risk `sendRpcRequest` guards against, so every
connection of a briefly-doubled-up (mid-reconnect) device hears them.

Separately, ordinary journal fan-out and hello replay (see "Agent delivery
scoping" above) now reach not just the recorded owner but every currently-
`joined` participant too — that's the durable side of room membership (the
room's actual conversation content), distinct from this section's ephemeral
invite-lifecycle relay.

## Agent-spawned sessions (`spawn`)

(spec: `docs/superpowers/specs/2026-08-09-agent-spawns-session-design.md`.)
A parent agent may ask a target agent to start a new session (child conversation) with a given prompt, parked across human latency while the user consents. The journal brokers the request and handles the consensus flow.

### Operations

**`spawn_request`:** A parent agent requests the user's consent to spawn a session on a target agent device.

```json
{
  "op": "spawn_request",
  "request_id": "string (UUID or similar)",
  "from_convo_id": "string (conversation id the parent owns)",
  "target_device_id": integer,
  "workdir": "string (capped at 1024 chars)",
  "task": "string (the child's seed prompt, capped at 2000 chars)",
  "topic": "string (optional, title fragment for the card, capped at 200 chars)"
}
```

Acknowledgement: `{kind:'spawn', event:'pending', request_id, spawn_id}` — the spawn row is now parked in `awaiting_user` state, and a `permission_request` event has been appended to the parent's conversation with `payload.kind: 'agent_spawn'` (client-only).

**Errors.** `forbidden` for a client connection (agent-only, same stance as the room ops); `not_ready` if sent before this connection's own hello replay completes (mid-replay it's invisible to the delivery scan an outcome frame would need). `bad_request` covers: a missing/non-string/oversized `request_id` (≤128 chars, `RPC_ID_MAX_CHARS`); an empty or oversized `workdir` (≤1024 chars, `SPAWN_WORKDIR_MAX_CHARS`) or `task` (≤2000 chars, `SPAWN_TASK_MAX_CHARS`) — and the same check re-run *after* peer-text sanitisation, so an all-control-character string that sanitises down to empty is rejected too; an oversized `topic` when present (≤200 chars, `INVITE_TOPIC_MAX_CHARS`); a non-integer `target_device_id`; and a missing/empty `from_convo_id`. `not_found` covers: an unknown `target_device_id`, one belonging to another user, a client-kind device, or a private device seen by a non-private caller — all indistinguishable, anti-enumeration, same stance as `agent_invite`'s `target_device_id`; and a `from_convo_id` that doesn't resolve to a top-level conversation this device owns (foreign, unknown, or a child conversation — `parent_convo_id` set), mirroring `agent_invite`'s `from_convo_id` check. `agent_unreachable` — the target box has no live registered connection right now; checked, and refused, **before** the consent card is published, so the user's tap is never spent on an ask that cannot work. `conflict` (`detail:'too many requests awaiting user approval'`) — the requesting device already has `MAX_AWAITING_PER_REQUESTER` (3) rows in `awaiting_user`, counted jointly with agent-chat's pending asks (see "Pending-ask cap" below).

> **Same-box spawn (loop #690 — easelyte fork divergence from upstream).** Upstream rejects a self-target with `bad_request` ("cannot spawn on self"); this fork **accepts** it, so a session can spawn another session on its *own* box seeded with a task (eliminates the operator copy-pasting a start prompt into a new window). Every other guard is unchanged for a self-target: the ownership/privacy gate (the caller's own device passes its own filter), the liveness check (the caller's own connection is online), the shared pending-ask cap, and — above all — the same client-only consent card is parked and must be tapped; there is **no silent same-box spawn**. The `from_convo_id` child-conversation guard (`parent_convo_id` set → `not_found`) also still applies, so a **sub-chat/subagent transcript convo** can never originate a spawn. Note this guard does *not* by itself bound spawn *depth*: a spawned session's own top-level conversation is a root convo (`parent_convo_id` NULL), so it could in principle spawn again — depth is bounded by the human consent gate (every hop needs an operator tap), not by an automatic counter. See also the `agent-rooms` same-bridge (`guestSessionRoomId`) wiring on the bridge for how a same-box room binds both local sessions.

**`spawn_targets`:** A parent agent queries what other agent boxes are available for spawning.

```json
{
  "op": "spawn_targets",
  "request_id": "string (UUID or similar)"
}
```

Reply: `{kind:'spawn', event:'targets', request_id, boxes: [{device_id, name, self?, online, folders: [{path, last_used}], activity?, limits?}]}`. Each box carries whether it is currently online and — if reachable — a list of recent working directories it has reported. Self (the requesting device) **is** listed (loop #690, easelyte fork divergence — same-box spawn support; upstream excludes it as "a self-spawn trap"): the self entry carries `self: true` and its `name` is suffixed `" (this box)"` so the picker can label it as a same-box target. Private devices are hidden from non-private agents; the caller's own box always passes that filter.

Folder discovery rides the RPC broker: for each *online* box the journal itself issues a **journal-originated** `recent_folders` RPC (see "Journal-originated requests" under "Agent RPC" below — `from_device_id: 0`, answered with `to_device_id: 0`) and waits up to `spawnFoldersTimeoutMs` for the reply. A bridge that never learns to answer this method will simply time out to `folders: []` for every request rather than erroring; offline boxes are listed with no RPC attempted at all.

**Capacity blocks (optional).** A bridge may additionally report its current load in the same `recent_folders` reply, as `activity: {live_sessions, last_hour: [{path, sessions}]}` (capped to 20 `last_hour` entries) and `limits: {as_of, lines: [{id, label, percent, resets?, resets_at?}]}` (capped to 12 `lines`; `resets`/`resets_at` are per-line and each independently optional). Both are validated all-or-nothing (`sanitizeSpawnActivity`/`sanitizeSpawnLimits` in `src/spawns.js`): any malformed entry drops the whole block from that box's reply, but never the box itself — a bridge that predates these fields, or whose reply fails validation, simply shows up with folders and no `activity`/`limits` keys (omitted, not null).

### Consent card

A `permission_request` event with `payload.kind: 'agent_spawn'` is appended to the **parent conversation** — the conversation the parent owns and is asking from, named `from_convo_id` in the operation. The payload includes:

```json
{
  "kind": "agent_spawn",
  "request_id": "the spawn row's id",
  "from_device_id": 7,
  "from_name": "the parent device's name",
  "from_convo_id": "the parent conversation's id",
  "from_convo_title": "the parent conversation's title",
  "target_device_id": 12,
  "target_name": "the target device's name",
  "workdir": "string",
  "task": "string (the child's seed prompt, also the card's text)",
  "topic": "string (optional, title fragment for the card)"
}
```

Like agent-chat cards, this is a **client-only event** excluded from agent delivery and unforgeable via `publish`.

**Identification fields.** `from_device_id` and `target_device_id` identify the two boxes in the spawn pair and map to the devices' own ids — `from_device_id` is always the requesting parent. `from_name` and `target_name` are the devices' sanitised names (control characters become spaces, capped to `PEER_NAME_CAP`), sent because a device's name is how the user knows which box is which on the conversation list. A client rendering the card state must identify which is parent and which is target using the device ids.

**Originating conversation.** `from_convo_id` and `from_convo_title` identify the **parent conversation** — the session the parent owns and is asking from, and where this card is being published. A client that missed the live card or wants to review all spawn requests uses these fields to correlate the card to its originating thread. `from_convo_id` is authorisation, not decoration, exactly as in agent-chat: it must be a **top-level conversation** (`parent_convo_id` must be null — a child/sub-chat can never front an ask) that the requesting device actually owns, or the `spawn_request` is rejected `not_found`. A title is shown to the user as the asker's identity, so an unchecked one would let a requester borrow another conversation's name to be trusted by. Both id and title are sent because neither alone identifies a conversation to a user — a room's title has no identifying prefix (unlike a bridge-seeded session title), and two conversations can share wording. A title is a snapshot taken when the ask was made: the card is an immutable event, so a later retitle does not rewrite it.

**Prompt and context.** `task` is both the child's seed prompt for the `start` RPC and the card's text that the user approves — one blob, so the text the user reads is the text that takes effect. `workdir` is the child's working directory, sent as context so the user can understand what environment the spawn will run in. Both are peer text and undergo the same sanitisation (control characters become spaces, trimmed to `SPAWN_TASK_MAX_CHARS` and `SPAWN_WORKDIR_MAX_CHARS` respectively). `topic` is optional and provides a shorter title fragment (capped to `INVITE_TOPIC_MAX_CHARS`) — when present, used as the card's headline instead of truncating the task itself.

sent with `sender: "agent:<name>"`, same sender convention as any other agent-authored event.

### Answering

**`POST /agent-spawn/answer`** `{request_id, decision: "approve"|"deny"}` — client-only (`403` for agent tokens). `request_id` must resolve to a **row belonging to the caller's own user**; an unknown row and one owned by another user are indistinguishable (`404 {error:'not_found'}`, never `403` — anti-enumeration). The row must be `state='awaiting_user'` or the call is `409 {error:'conflict'}` (already answered, or never parked). A body carrying `always_allow` at all — any value — is `400 {error:'bad_request'}`.

- **`deny`** flips the row to `denied` and sends the parent `{kind:'spawn', event:'outcome', request_id, outcome:'declined'}` (if reachable).
- **`approve`** flips the row to `approved`, creates a new `conversations` row owned by the parent, and joins the target as a participant — room-first, same ordering rule as agent-chat, so a room-creation failure never leaves a live agent spawned on another box with no channel and no provenance. Before the `start` RPC is issued, `session_status` and `convo_meta` journal events are broadcast into the new room — the same two frames `convo_upsert` fans for a fresh conversation — so live clients learn the room exists immediately, and they fan to the target agent too, since it is already a joined participant by this point. Only then does the journal issue the `start` RPC to the target with `params: {prompt: <task>, workdir: <workdir>, room_id: <new room id>, from_name?: <parent device's sanitised name>}`. `from_name` gives the target's opening turn the parent's identity without a separate lookup; it is omitted rather than sent empty if the parent device row is gone by approval time. The parent hears one of: `outcome:'started'` (with `room_id` and `child_convo_id`), `outcome:'failed'` (with `error_code`), or times out to `failed/timeout` if the target never answers.

### Outcome frames

All settlement notifications to the parent take the form `{kind:'spawn', event:'outcome', request_id, outcome: '<state>', ...}`:

```json
{
  "kind": "spawn",
  "event": "outcome",
  "request_id": "the spawn row's id",
  "outcome": "started | declined | expired | failed",
  "room_id": "new room id (started only)",
  "child_convo_id": "child session id reported by the target (started only)",
  "error_code": "code describing the failure (failed only)"
}
```

**The durable `spawn_outcome` event.** (spec: `docs/superpowers/specs/2026-08-11-spawn-outcome-events-design.md`.) Every call site that sends the ephemeral frame above also appends — first, then sends the frame — a `spawn_outcome` journal event into the **parent conversation** (`from_convo_id`, the same conversation the consent card was published into), through one shared helper (`emitSpawnOutcome`, `src/spawns.js`). The payload mirrors the frame exactly, minus `kind`/`event`:

```json
{
  "request_id": "the spawn row's id (same value the card carries)",
  "outcome": "started | declined | expired | failed",
  "room_id": "new room id (started only)",
  "child_convo_id": "child session id (started only)",
  "error_code": "sanitised failure code (failed only)"
}
```

Sent with `sender: "journal"` — server-authored, no `sender_device_id`, the same convention as the failure epitaph written into the room on the failure paths. Correlation is by `payload.request_id`: the card carries the same id, and the card's `seq` is not otherwise discoverable by a client that missed the live frame.

Unlike the card, `spawn_outcome` is **agent-visible** — deliberately *not* added to the client-only-event predicate. The parent agent owns `from_convo_id`, so it receives the event in live fan-out and hello replay exactly like any other event in a conversation it manages; the un-approved ask stays withheld (the card itself is still client-only, unchanged), but the *resolution* is precisely what the parent is entitled to know. If `from_convo_id` is itself a room with joined peer agents, those participants receive the event too — the ordinary fan-out rule for any event in a room they're joined to. That's information, not capability: a leaked `room_id`/`child_convo_id` grants nothing (transcript reads stay gated by write-authorisation, and foreign-context reads are filtered to indexable prose, which `spawn_outcome` never is). It is also, like the card, **unforgeable**: `spawn_outcome` is deliberately *not* added to `AGENT_PUBLISH_TYPES`, so a bare `publish` or `finalize` of the type is rejected `bad_request` before it ever reaches the append path — server-minted only.

`spawn_outcome` joins `MESSAGE_TYPES`, so a resolution updates the parent conversation's snippet and bumps unread the same way the card itself did — the resolved state must retire the card's `🤝 Agent spawn request` snippet, or the chat-list row keeps advertising a settled ask forever. `snippetOf` maps each outcome: `started` → `🚀 Spawned session started`, `declined` → `🚫 Spawn declined`, `expired` → `⌛ Spawn request expired`, `failed` → `❌ Spawn failed`. No push notification follows — journal-authored events never enter the push pipeline (only agent-published events via the ws append path do) — which is correct: a started child generates its own activity, and answered outcomes were just acted on by the user looking at the screen. The event is not searchable either: its payload carries only ids/an enum/error codes, no prose, and `indexableBody` returns `null` for it like every other non-text/diff type.

The append is **best-effort**: `from_convo_id` may point at a conversation deleted since the ask was parked, and `append()` throws on a missing/foreign conversation. `emitSpawnOutcome` catches that, logs it, and sends the ephemeral frame regardless — telling the parent (if reachable) is the one thing this tail must never skip, even when the durable half fails.

The four outcomes flow from: `started` (approval granted and target answered), `declined` (user denied), `expired` (24h TTL without user action), `failed` (target unreachable, didn't answer in time, returned a bad start response, or — see "Stranded-`approved` recovery" below — orphaned by a restart or an internal error mid-orchestration). These outcomes are coarser than the six `agent_spawn_requests.state` values: `awaiting_user` and `approved` are transient parking states with no outcome frame of their own, folded into whichever of the four above the row eventually resolves to. **Frame delivery to live sockets is still at-most-once; the journaled event is now the durable record.** Every parked request resolves to exactly one terminal state, and both the outcome frame and the `spawn_outcome` event fire exactly once for it — but the frame itself remains fire-and-forget to the parent's live sockets (like `/agent-chat/answer` frames), so a parent offline at resolution time still misses *the frame*. It no longer misses the outcome (absent an append failure, above): the journaled event lands in `from_convo_id` regardless of whether anyone was listening, and a parent that was offline picks it up on its next hello replay, the same way it would any other event in a conversation it manages. The durable row (`agent_spawn_requests.state`) remains the ultimate source of truth; the journal event is what makes that truth reach the parent agent without depending on socket timing — the recorded follow-up this section used to promise, now implemented.

**Journal-originated RPC:** When the journal issues the `start` RPC itself (during approval orchestration), it sets `from_device_id: 0` — a reserved value signifying the journal is the originator, not a peer agent. The target's bridge uses this to seed the new session without a peer device context.

### Expiry

A parked `awaiting_user` spawn request older than `AWAITING_USER_TTL_MS` (24 hours, same clock as agent-chat awaiting-user rows, clocked from `created_at`) is flipped to `expired` by the periodic sweep timer and the parent is notified. Unlike agent-chat, where expiry is masked as `reason:'refused'` (to hide from the requester that the user is unresponsive), **spawn expiry is reported honestly as `outcome:'expired'`** — spawn denials are already told plainly as `'declined'`, and there is no peer to hide behind, so distinguishing "the user never answered" from "the user said no" reveals nothing the parent doesn't already learn from a denial.

### Stranded-`approved` recovery

`approved` is meant to be momentary — the claim (`claimApprove`) that lets exactly one `POST /agent-spawn/answer` tap own the expensive orchestration, settled moments later by `outcome:'started'` or `outcome:'failed'`. Two things can strand a row there instead: the journal process restarting in the gap between the claim and the in-memory orchestration settling it (nothing left in memory will ever resolve the row), or an exception inside the orchestration *before* the `start` RPC is even issued (a DB error creating the room, say) — the route that fired the orchestration only logs such a throw, it never re-derives an outcome. Both leave the row `approved` forever and the parent never told, breaking "every request resolves exactly once and the parent is told exactly once."

Two mechanisms close this, layered the same way `expireSpawns` covers `awaiting_user`:

- The orchestration itself (`approveSpawn`) wraps its body in a try/catch: a throw before `broker.issue` routes to the same failure tail a bad `start` reply gets, with `error_code: 'internal'`.
- The periodic sweep timer additionally flips any `approved` row whose `answered_at` (the claim timestamp) is older than the orphan TTL — derived as `max(5 minutes, 2 × the configured start timeout)`, so a raised `spawnStartTimeoutMs` can never let the sweep fail a row whose orchestration is still legitimately awaiting the target's reply — to `failed`, and notifies the parent with `error_code: 'orphaned'`. If the orchestration got as far as creating the room before the restart (the room linkage is persisted onto the row *before* the `start` RPC is issued), the sweep also writes the same `❌ spawn failed` epitaph into that room a live failure writes, so the user is never left with an unexplained dead room. This is the backstop for the restart case, where nothing is left to run the try/catch above at all.

Both paths use the same state-scoped `UPDATE ... WHERE state='approved'` (`markFailed` / the sweep's own update) that the rest of the state machine relies on: whichever one wins the race is the only one whose outcome frame is ever sent, so a row a live orchestration successfully resolved (`started` or `failed`) can never also be reported `orphaned` by a sweep tick that happens to land moments later.

### Pending-ask cap

Outstanding `awaiting_user` rows per *requesting* device are capped at `MAX_AWAITING_PER_REQUESTER` (3), shared with agent-chat invites and joins — the cap is what stops a re-ask loop, not TTL ambiguity or answer masking. Over the cap, `spawn_request` fails `{code:'conflict', detail:'too many requests awaiting user approval'}`.

## Device privacy

(spec: `docs/superpowers/specs/2026-08-07-agent-visibility-privacy-design.md`.)
A per-device flag that makes an agent device — and what it manages — invisible
and unreachable to *other agent devices*, while the user's own client apps see
everything unchanged. Consent (see "Agent chat rooms" above) stops a rogue
agent injecting text into a sibling's context; it does not stop it *watching*,
and once a room is approved a compromised participant can work on it freely
and indefinitely. For a device with materially more authority than its
siblings, unreachable is a stronger property than approved, because
unreachable has no first-contact hole at all.

**The flag pair.** `devices.private` (`INTEGER NOT NULL DEFAULT 0`) is the
value; `devices.private_pinned` (`INTEGER NOT NULL DEFAULT 0`) records who
owns it. `private=1` means invisible/unreachable to other agents — not to the
user: `kind='client'` connections are never filtered by any rule below, and
`GET /devices` (already client-only, see above) is untouched by this feature
entirely. `isPrivateDevice(db, deviceId)` (`src/db.js`) is the single read
helper every enforcement point calls; it answers `false` for an unknown/
deleted id rather than throwing, so a caller checking a dangling reference
falls through to its normal not-found path instead of crashing.

**Setting it: hello, then the pin.** The bridge asserts its own flag on every
WS `hello` frame: an optional top-level `private: boolean`
(`MATRON_AGENT_PRIVATE`, bridge-side env var) — hello is the only recurring
moment a long-lived, operator-absent agent connection can assert env-var
config. The shape check runs for **every** connecting device, agent or
client, before the two kinds are told apart: a `private` field that is
present but not a boolean is rejected —
`{kind:'control', op:'error', code:'bad_request', ref:'hello'}`, the same
reject shape a bad cursor gets, socket closed — regardless of which kind of
device sent it. Only past that check does the agent/client distinction
apply: a **well-formed** boolean, or an absent field, from a client is
silently ignored — never applied, hello proceeds normally — while an agent's
value is written via `applyBridgePrivate`. Leniency is for a client sending a
harmless, well-formed value it should never send in the first place; a
malformed value gets no such leniency from either kind. Omitting the field
asserts `false`: an unpinned flag follows the hello assertion exactly,
including its removal — bridge-set privacy does NOT survive a re-register
without the env var.
`matron-admin device private <device_id> on|off|auto` is the authoritative
override: `on`/`off` both PIN the flag (`private_pinned=1`) — `off` is
"force-visible", not "hands off" — so a deploy that forgot the env var can
never silently unmark a pinned machine; `auto` releases the pin and hands the
flag back to the next hello, without itself changing the value.
`matron-admin device list` renders `private=yes|no`, with a `(pinned)` suffix
when pinned.

**The enforced surfaces — one caller rule, nine enforcement points.** Every
rule is conditioned on the identical predicate: filtering applies **only
when the caller is an ordinary (non-private) agent**. `kind='client'`
callers are never filtered, and a private agent caller is never filtered
either — it is invisible, not blinded, so two private agents see each other
and a private agent still gets the whole unfiltered roster/search/room set.
The nine:

- **`GET /roster`** — omits private agent devices and every top-level
  conversation whose `agent_device_id` is private.
- **`GET /search`** — `searchMessages`'s `excludePrivateOwned` option
  (`src/search.js`) excludes hits from private-owned conversations.
- **The `around_seq` context mode** of `GET /convo/:id/messages` — a
  private-owned conversation 404s for a foreign ordinary-agent read. The
  check runs before `messagesAroundIndexed` and before the foreign-read
  audit log line (see "Journal search" above), so a refused read is never
  logged as a successful one.
- **Every room op, on room ownership** — via a single choke point rather
  than a per-op check: `loadRoom` (`src/ws.js`), the shared lookup behind
  `agent_invite`, `agent_join`, `agent_invite_ack`, `agent_invite_answer`,
  and `agent_leave` (see "The five room ops" above), checks whether the
  room's *owner* device (`room.agent_device_id`) is private and applies
  uniformly to all five ops. A room owned by a private device answers the
  byte-identical `not_found` an unknown room id gets, on every one of those
  five ops. The plan originally specified this only as a per-op check on
  `agent_join`'s owner lookup; folding it into `loadRoom` instead means the
  other three ops, which had no privacy check of their own
  (`agent_invite_ack`/`_answer`'s "no pending invite", `agent_leave`'s "not
  a joined participant"), are covered too — closing what would otherwise be
  an existence oracle in the fields those checks don't touch.
  - The exemption is narrower than "is a participant":
    `isKnownParticipant` (`src/participants.js`) passes a caller only if it
    **initiated** the ask, the ask was **actually delivered** to it
    (`delivered_at IS NOT NULL`), or it is **`joined`**. A merely parked
    (`awaiting_user`, never relayed to any agent socket) or `denied` (never
    told) row does NOT exempt — either would leak a private room's
    existence to an agent the user never approved, or explicitly refused.
- **`agent_invite`'s target-device check** — separate from `loadRoom` and
  unreplaced by it: whether the room's *owner* is private (`loadRoom`'s job,
  above) is independent of whether the invite's *target* device is private.
  `agent_invite` (`src/ws.js`) looks up `target_device_id` directly and
  folds `target.private === 1 && !isPrivateDevice(db, conn.deviceId)` into
  the same `not_found` an unknown id, another user's device, or a
  client-kind device already gets. This check was specified per-op in the
  plan and remains per-op in the shipped code — nothing subsumed it.
- **`read_marker`** — an ordinary agent caller marking a conversation whose
  recorded owner is a private device, and that the caller is not a known
  participant of (`isKnownParticipant`, same exemption `loadRoom` uses),
  gets the same `forbidden` its own unknown-`convo_id` path already returns
  (`markRead`'s `not authorized` throw, caught by `handleOp`'s outer
  catch) — byte-identical, not merely same-shaped, because `read_marker`
  isn't one of the five room ops `roomIdEcho` attaches `room_id` to, so
  neither rejection carries one. The gate runs before `markRead`, so a
  refused mark never appends a `read_marker` event or fans one out. See
  "Agent write authorization" above for why `read_marker` isn't gated by
  `authorizeAgentWrite` itself.
- **`convo_upsert`'s private-owner takeover guard** — extends the
  pre-existing "Room-upsert ownership gate" (above) to the
  participant-less case it deliberately left open: when the existing
  conversation's recorded owner is a private device and the upserting
  caller is an ordinary agent, the whole upsert is refused with the
  identical `forbidden` shape the populated-room gate already returns,
  instead of the old last-writer-wins takeover. See "Room-upsert ownership
  gate" above for the full mechanics and the re-pairing operational trap
  this creates. Unlike every other surface in this list, this one is a
  **new, accepted** existence oracle rather than a byte-identical
  rejection — see "Byte-identical, deliberately" below.
- **`GET /snapshot`** — a differently-shaped rule of its own; see below.
- **`GET /metrics`** — the `user.devices` list (`buildMetrics`,
  `src/metrics.js`) omits private devices for a filtered ordinary-agent
  caller, via an `excludePrivateDevices` option computed with the same
  predicate at the HTTP layer; a client or a private agent caller gets the
  unfiltered list, byte-identical to today.

**Byte-identical, deliberately — with one accepted exception.** Every
filtered surface's refusal is indistinguishable from the same surface's
refusal for a genuinely nonexistent target: `not_found` for room ops
(matching an unknown room or device id, another user's device, or a
client-kind device), `404 {error:'not_found'}` for `around_seq` (matching a
missing conversation), and the same `forbidden` for `read_marker` (matching
its own unknown-`convo_id` rejection — see above). A distinct "that's
private" error would itself confirm existence — the thing being hidden.

The one deliberate exception is `convo_upsert`'s private-owner takeover
guard (above): refusing an upsert on an existing private-owned,
participant-less conversation id IS distinguishable from an upsert on a
fresh id, which simply creates it — a caller who already knows or guesses
an id can learn "something private-owned already exists here" in a way it
could not learn from a truly-unused id. This mirrors an oracle already
accepted one gate up: the populated-room case (any `convo_agents` history)
answers a caller-visible `forbidden` for a private-owned room, distinguishable
from ordinary creation, for exactly the same structural reason — a
conversation that already exists behaves differently from one that
doesn't, and hiding *that* difference would mean either silently rejecting
every fresh `convo_upsert` too (breaking normal room creation) or silently
allowing the private-owner takeover this guard exists to close. Extending
an already-accepted oracle class to the participant-less case was judged
preferable to inventing a second, differently-shaped one.

**`/snapshot`'s two independent rules (added by security review during
implementation, alongside the other enforcement points above).**
`GET /snapshot` predates this feature and answers to its own pair of rules
layered on the client shape, not the single roster/search/room predicate
above:

- **`snippet` is omitted for every agent caller, private or not** —
  unconditional, because the risk is credential leakage (a snippet can carry
  `tool_output` text), not visibility. A managing agent losing its own
  conversation's snippet in this one summary payload is an accepted cost; no
  agent consumer of `/snapshot`'s snippet exists.
- **Private-owned conversations are excluded for a filtered (ordinary) agent
  only** — the same one-caller predicate as `/roster` and `/search`, so
  `/snapshot` can't be used as an end-run around either.

**What this does not do.**

- **Visibility, not privilege.** Every device is still the same journal user
  with the same rights; privacy is not a permission boundary between an
  agent and its own box, and does not prevent it doing damage there.
- **No retroactive hiding.** Text a private agent already wrote into
  another agent's conversation stays visible there — the flag changes what's
  discoverable going forward, not the historical record.
- **A compromised private agent gains nothing from the flag.** It already
  sees everything (the asymmetry runs the other way — if the private one is
  the compromised device, this feature bought nothing); the only flag it can
  touch is its own, and unmarking itself only makes it more visible, which
  harms nobody but itself.
- **Revocation re-exposes.** `matron-admin device revoke` (see "Device
  revocation" below) deletes the device row outright — there is no
  soft-delete or tombstone. A private device's conversations still carry its
  now-dangling `agent_device_id`, so every enforcement point above (whose
  private check is `isPrivateDevice`, a live lookup against the `devices`
  table) sees no row, answers `false`, and stops excluding them: a
  decommissioned private agent's whole history becomes visible and
  searchable again to ordinary agents the moment it's revoked. Privacy here
  is a visibility flag on a live device, not a retention policy on its past
  conversations; if a decommissioned device's history needs to stay hidden,
  that needs a distinct fail-closed mechanism (e.g. an owner id that
  survives its device row) — not implemented in v1.
- **`/metrics`'s global aggregates still count private devices.**
  `sockets_connected`, `journal_row_count`, and `db_file_size_bytes` are
  whole-user (or whole-server) aggregates computed before the per-device
  `user.devices` filtering above — a private agent's own live socket, its
  journal rows, and its share of the DB file size are folded into these
  numbers for every caller on the account, including an ordinary agent
  whose own `user.devices` list just had that same device filtered out. No
  id or name ever leaks through them (they're bare counts), but an
  attentive ordinary-agent caller can still infer "something else is active
  on this account" from population-level movement it can't attribute to
  any device. Only the per-device list — the part that could name one — is
  filtered.
- **A drawn-in ordinary agent keeps the access it was granted, not the
  discoverability.** Once an ordinary agent is `joined` into a private
  device's room (invited and accepted, or joined via `agent_join`), it reads
  and writes that room over the ordinary journal/WS paths exactly like any
  other room it's a participant in — `authorizeAgentWrite`, hello replay,
  and paging never re-check privacy once a caller has standing. But that
  room still never appears in the participant's own `GET /roster`,
  `GET /snapshot`, or `GET /search` — those three stay scoped to the
  one-caller predicate above regardless of the caller's actual room
  memberships. The asymmetry is deliberate: discovery closes (you can't find
  what you weren't told about), granted access does not (once told, you keep
  reading it the normal way).

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
and last-seen time. Room membership goes with the row — see "Device
revocation clears room membership" under agent chat.

Owners can also revoke from a client device over HTTP:
`POST /devices/:id/revoke` (Bearer, client devices only — agents get 403)
deletes the row exactly like `matron-admin device revoke`; not-owned and
nonexistent ids are indistinguishable (404 `{error:'not_found'}`).
Self-revocation is allowed and acts as a logout. WS enforcement is the
same next-frame-or-≤60s-sweep described above.

`POST /devices/:id/rename` (Bearer, client devices only — agents get 403)
renames a device, body `{name}`, 200 `{ok:true, device:{device_id, name}}`.
The name is sanitised (control characters flattened, whitespace collapsed,
trimmed) and then capped at 40 characters — over the cap is rejected with
400 `{error:'bad_request'}`, never truncated, as is an empty or non-string
name. Not-owned and nonexistent ids are indistinguishable (404), same as
revoke. Any device kind may be renamed, including the caller's own, and
duplicate names are allowed (pairing only warns about them). A success fans
a `device_meta` frame out to the user's client sockets; a client that was
offline for it re-reads the name from `/snapshot`'s `agents` list (agent
boxes) or from `GET /devices` (any kind, client devices included) — see
`device_meta` under "WebSocket" above.

A rename takes effect on the renamed device's own **live** WebSocket too, not
just from its next connection: every event that names the producing device —
journal `sender` strings (`agent:dev-2`) and the `from_name` in an
agent-chat/agent-spawn consent card — carries the new name from the next op
onwards. Already-journaled events keep the name they were written with;
`sender` is history, not a live reference.

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

## Device link (QR sign-in)

The reverse of agent pairing: here the *signed-in* side starts. A signed-in
client ("starter") calls `link/start` and renders the `link_code` as a QR
(`matron://link?v=1&server=<url-encoded base URL>&code=XXXX-XXXX`) plus the
code as text. The new device ("claimant") scans or types the code and calls
`link/claim` with its device name, then polls `link/poll` with its secret
`claim_token` (32 random bytes hex). The starter polls `link/status`, sees
`claimed` with the claimant's name and IP, and the user taps Approve
(`link/approve`) or Deny (`link/deny`). Scanning alone never signs anything
in: only the approve tap — from the starter device itself, holding a live
bearer — releases an identity.

Like pairing, no `devices` row exists before the final step: approve only
flips the in-memory session's state, and the `kind='client'` row is minted
at the claimant's next `link/poll`, exactly once (the session is deleted
before the token is returned). Sessions live 120s (extended to ≥60s
remaining on claim so a last-second scan still leaves time for the tap),
are in-memory only, and die with a restart or with the starter's token —
`link/approve` requires a live starter bearer at tap time, so a revoked or
signed-out starter can never complete a link.

### Pre-approved link codes (provisioning)

`POST /link/preapprove {username}` mints a link session that is born
approved: the claimant runs the ordinary `link/claim` → `link/poll` flow
and the FIRST poll returns the device token — no approve tap (at
provisioning time there is no other device to tap on). The granting
authority is root on the box: the endpoint answers only loopback sockets
carrying no `X-Forwarded-*`/`Forwarded`/`CF-Connecting-IP` header (external
traffic always arrives via the reverse proxy, which adds one), and 404s
for everyone else.

That header check alone is defeated by a headerless reverse proxy (a
default-config nginx `proxy_pass` with no `proxy_set_header` lines forwards
none of them), so the endpoint additionally requires the header
`x-preapprove-key` to match a 64-hex-char secret the journal auto-mints on
first boot at `<dirname(db path)>/preapprove.key` (mode 0600, compared with
`crypto.timingSafeEqual`) — no operator provisioning step, nothing to
configure. Missing or wrong key gets the same 404 as every other guard
failure. `matron-admin link-code` reads that file itself (it must run on
the journal host, as the journal's service user or root) and sends the
header automatically.

Codes live 10 minutes, are one-shot, and count toward the same in-memory
cap as normal link sessions. `matron-admin link-code <username>
--server-url <url>` wraps this and prints the
`matron://link?v=1&server=…&code=XXXX-XXXX` QR on the terminal.

## Link rendezvous (relay)

The reverse direction, for signed-out devices that can't scan (spec:
`docs/superpowers/specs/2026-07-18-link-rendezvous-design.md`). Served by
the push relay (`push.matron.chat`), NOT the journal — a brand-new install
has no configuration, and the shared relay is the one address every Matron
app knows. The relay never carries a token: only `{server, code}`, the
same two values the shipped QR displays on screen. The confirm-tap on the
signed-in phone remains the only credential-granting gate.

- `POST /link/rendezvous` (empty body) → `201 {rid, secret, expires_in}`.
  `rid`: 26 chars of the pairing alphabet (~128 bits), shown in the QR as
  `matron://rlink?v=1&rid=<rid>`. `secret`: 256-bit hex poll gate, never
  in the QR. TTL 3 minutes, in-memory only, `maxPending` 256. Per-IP
  token bucket (burst 10, refill 1/30 s) plus a global ceiling (burst
  100, refill 1/100 ms) that also bounds offers and polls.
- `POST /link/rendezvous/:rid/offer {server, code}` — the scanning
  phone's move, after calling `link/start` on its own journal. First
  offer wins → 204; later offers 409; unknown/expired rid 404. `server`
  must be https (http allowed to localhost-ish dev hosts only), ≤ 200
  chars; `code` is normalized to `XXXX-XXXX`. Validation reasons are
  machine strings that never echo caller values.
- `GET /link/rendezvous/:rid?secret=<hex>` — the creator's 2 s poll.
  204 waiting; `200 {server, code}` once offered (NOT one-shot — the
  entry survives to TTL so a dropped response is retryable; it releases
  no credential); 403 on secret mismatch (constant-time); 404 after TTL.

A relay restart forgets pending rendezvous; the signed-out device
regenerates its QR, mirroring link-session behavior.

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
  (agent connections only). For a reply to a client-relayed request,
  `to_device_id` must be a client device of the same user (else `not_found`);
  a reply to a **journal-originated** request instead carries
  `to_device_id: 0` and is settled internally rather than relayed — see
  "Journal-originated requests" below. `ok:false` requires `error.code`.
  Delivered as `{kind:'rpc', response:{request_id, agent_device_id, ok,
  result?|error?}}` to ALL live sockets of that device (responses are
  side-effect-free; clients dedupe by `request_id`).
- The relay is stateless and nothing is journaled: no seq, no unread/push
  effects, no retention surface. Timeouts are the client's job; at-most-once
  delivery, re-asking is the retry.
- v1 method vocabulary (bridge-owned, normative in the spec):
  `recent_folders {} -> {folders:[{path, last_used}], activity?, limits?}` and
  `start {workdir?, browser?, prompt?, room_id?, from_name?} -> {convo_id}`
  (errors `bad_workdir` — workdir does not resolve to a directory on the
  target box; `spawn_failed` — the target threw while starting the session;
  `bad_request` — `room_id` was sent without `prompt`, or `room_id` on its
  own is otherwise invalid; `unsupported_mode` — the target bridge has no
  spawn wiring (e.g. session id unknown at spawn, or spawn-room support
  absent); unknown methods `unknown_method`).
  `prompt`/`room_id`/`from_name` are the parameters the journal-originated
  `start` call behind spawn approval sends (see "Agent-spawned sessions"
  above); a client-relayed `start` sends `workdir`/`browser` instead.
  `activity`/`limits` on the `recent_folders` reply are the optional capacity
  blocks (see "Agent-spawned sessions" → "spawn_targets" above). Cross-channel
  ordering between the `start` response and its `convo_upsert` is not
  guaranteed.

**Journal-originated requests.** The journal itself can be the RPC caller —
not just the relay between a client and an agent. Spawn approval's `start`
call and spawn-target discovery's `recent_folders` call (see "Agent-spawned
sessions" above) are both issued by the journal directly, over the same
single-consumer delivery path a client-relayed `agent_request` uses. These
requests carry `from_device_id: 0` — a reserved value no real device row can
ever have (SQLite `AUTOINCREMENT` starts at 1) — signalling that the journal,
not a peer agent, is the caller. The agent answers with an ordinary
`agent_response`, addressed with `to_device_id: 0`; the journal's RPC broker
recognises that reserved id and settles the pending request internally
instead of relaying it onward to a (nonexistent) client device — this is why
the "`to_device_id` must be a client device of the same user" rule above does
not apply to these replies. The broker still checks that the responder is who
the request actually went to: only a reply from the same `userId`/`deviceId`
pair the journal addressed the request to may settle it; a reply from any
other device for the same `request_id` falls through to the ordinary
client-forward path instead, where `to_device_id: 0` is not a client device
and the reply lands `not_found`.

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
  conversation, or when its acked cursor already covers the event's `seq`,
  or when its `push_prefs` (see `PUT /push/prefs`) explicitly disable the
  event's category — `wake` background pushes are never prefs-filtered.
- `prompt` / `permission_request` push immediately at priority 10
  (category `attention`).
- `session_status` pushes on the turn-finished TRANSITION, not the new
  state alone: previous state `running` moving to `waiting` or `done`
  pushes immediately at priority 10 (category `done`, body "Session
  finished"). Every other transition is silent — in particular
  `waiting` -> `done` (tearing down an already-idle session) and a
  brand-new conversation's first state.
- `convo_meta` never pushes at all — a title rename is journal-sync
  material, not a notification (connected devices learn it from the
  journal frame).
- `summary` never pushes at all — TOC summaries are derived metadata
  (not new activity), journal-sync material for browsing, never push
  (fans out and replays to all devices, but silent notification-wise).
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
diff, prompt, permission_request, file, image, spawn_outcome) in its
conversation, the
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
