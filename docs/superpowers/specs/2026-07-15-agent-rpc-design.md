# Agent RPC & connected roster — design (SP2 journal ops)

**Date:** 2026-07-15
**Status:** draft — awaiting review
**Depends on:** protocol v1 (`docs/protocol.md`); device roster
(`2026-07-15-app-managed-agent-enrollment-design.md`)
**Consumed by:** SP3 (bridge method handlers), SP2 app UI (folder picker +
start-session screen)

## Problem

The app needs two things from a bridge that the protocol cannot carry today:
"start a session in folder X on agent Y" and "which folders has agent Y used
recently". The only client→agent channel is `send` (plain text) routed into a
per-bridge control conversation, where commands are typed as `/start ~/dir`
and answers come back as prose — unparseable by a UI. The bridge's
journal-only design spec (matron-bridge,
`2026-07-14-matron-bridge-journal-only-design.md`) explicitly deferred "a
machine-readable start-session frame, a structured recent-folders response,
and a connected-servers roster" to this server work.

## Goals

1. A client device can send a structured request to one of its user's agent
   devices and receive a structured response — or an immediate "unreachable"
   error when that agent has no live connection.
2. The journal carries `method`/`params`/`result` **opaquely** (the bridge
   owns the vocabulary, exactly like the existing `status` op) so future
   agent capabilities need zero server changes.
3. The roster answers "which of my agents is connected right now":
   `GET /devices` rows gain a live `connected` flag.
4. Nothing is journaled. RPC traffic is ephemeral: no replay pollution, no
   unread counts, no push notifications, no retention interaction.

## Non-goals

- Durable command queueing for offline agents. Starting a session on an
  offline box is meaningless; the app disables the action instead
  (`connected: false`).
- Server-side request state, timeouts, retries, or dedup. The relay is
  stateless; the client owns its timeout, and re-asking is the retry.
- Client↔client or agent↔agent RPC.
- Journal-side knowledge of folders, sessions, or any bridge domain concept.

## Alternatives considered

- **Journaled command events** (client publishes a `command` event the bridge
  consumes). Durable where durability is harmful (a `start` replayed to a
  rebooting bridge would spawn ghost sessions), pollutes replay/snapshot,
  and drags unread/push semantics in. Rejected.
- **First-class typed ops per capability** (`start_session`,
  `list_recent_folders` with server-validated schemas). Every future bridge
  capability becomes a server deploy; breaks the `status`-op precedent that
  bridge-owned shapes pass through opaquely. Rejected.
- **HTTP with a server-side pending map** (client POSTs, agent long-polls or
  is pushed). Adds a second transport and server state for something both
  parties already have a WS for. Rejected.
- **Opaque ephemeral RPC over the existing WS** — chosen.

## Design

Two new WS ops and one delivered frame kind. All validation errors use the
existing WS error convention `{op:'error', code, detail?}`; codes reuse the
protocol's envelope vocabulary plus one addition (`agent_unreachable`).

### Client op: `agent_request`

```
{ op: 'agent_request', request_id, agent_device_id, method, params }
```

- **Client connections only** — an agent sending it gets
  `{op:'error', code:'forbidden'}`.
- `request_id`: non-empty string ≤128 chars, client-chosen, echoed verbatim
  in the response and in every correlated error frame. The server neither
  interprets nor dedupes it.
- `agent_device_id`: integer id of an **agent-kind device belonging to the
  caller's user**. Unknown id, another user's device, and a client-kind
  device are indistinguishable: `code:'not_found'` (anti-enumeration, same
  rule as everywhere else).
- `method`: non-empty string ≤64 chars. Opaque to the server.
- `params`: any JSON value (may be omitted → `null`). Opaque.
- Size cap: the whole inbound frame ≤ **16 KiB** UTF-8
  (`MATRON_RPC_MAX_BYTES`, default 16384) → `code:'bad_request'` beyond.
  Large payloads belong in `POST /media` with a `blob_ref` inside `params`.
- Delivery: if the target agent device has ≥1 open WS connection, forward

  ```
  { kind:'rpc', request: { request_id, from_device_id, method, params } }
  ```

  to **exactly one** of them — the most recently registered live connection
  (single-consumer rule). A device normally has one socket, but reconnect
  overlap can briefly leave two; multicasting a request there would
  double-execute non-idempotent methods (`start` spawning two sessions).
  The newest socket is the one a reconnecting bridge is actually serving.
  Delivery bypasses the ephemeral coalescer — RPC frames must never be
  merged or latest-wins-dropped. `from_device_id` is stamped by the server
  from the sender's authenticated connection, never taken from the frame.
- If the target has no live connection: reply immediately
  `{op:'error', code:'agent_unreachable', request_id}` — no queueing.
- At-most-once, fire-and-forget past that point: the server keeps no record.
  If the agent crashes mid-request the client's own timeout fires. A re-send
  is a new request; for non-idempotent methods (`start`) the app disables
  the trigger while one is pending rather than relying on dedup.

### Agent op: `agent_response`

```
{ op: 'agent_response', request_id, to_device_id, ok, result?, error? }
```

- **Agent connections only** — a client sending it gets `forbidden`.
- `to_device_id`: the `from_device_id` the request arrived with. Must be a
  **client-kind device of the agent's own user**: anything else →
  `code:'not_found'`. (Re-validated against the devices table at response
  time, so a client revoked mid-flight is simply not found.)
- `request_id`: non-empty string ≤128 chars, copied from the request.
- `ok`: boolean. When `true`, `result` is any JSON value; when `false`,
  `error` must be `{code, detail?}` with `code` a non-empty string ≤64 —
  the only shape rule the server enforces on the payload.
- Same 16 KiB whole-frame cap → `bad_request`.
- Delivery to all live connections of `to_device_id`, direct send (no
  coalescing):

  ```
  { kind:'rpc', response: { request_id, agent_device_id, ok, result?, error? } }
  ```

  `agent_device_id` is stamped from the responding connection. If the client
  has meanwhile disconnected, the response is dropped silently — the app
  re-asks on next need. Responses stay multicast deliberately (asymmetric
  with requests): they carry no side effects, and a client correlating by
  `request_id` ignores a duplicate; dropping one socket of a
  mid-reconnect client would instead lose the response entirely.

The relay is **stateless**: validate, stamp the sender's device id, forward.
No table, no pending map, no sweep. Revocation needs no new handling — a
revoked device's next frame already gets close `4001`, and each RPC frame
re-validates the *counterparty* against the devices table.

### Roster: `connected` flag

`GET /devices` rows gain `connected: true|false` — whether that device has at
least one open WS connection right now (hub scan at request time; the hub
already indexes connections per user with `deviceId` on each). This is the
"connected-servers roster": the app enables *Start session here* only for
agents with `connected: true`, and renders offline agents with their existing
`last_seen_at`. `/metrics` is unchanged.

### v1 method vocabulary (normative for SP3 + app, opaque to this repo)

The journal forwards these blindly; they are specified here so the bridge
(SP3) and the app build to the same contract. Method names are snake_case.

**`recent_folders`** — params `{}`.
Result:

```
{ folders: [ { path: '/home/dan/yearbook-app', last_used: 1784500000000 } ] }
```

Deduplicated absolute paths, newest-first by `last_used` (epoch ms), capped
at 20. Bridge sources: its persisted per-conversation session records and
Claude's on-disk project directories. Bridge errors: none expected beyond
`internal`.

**`start`** — params `{ workdir?, browser? }`.
`workdir`: absolute or `~`-relative path on the agent's box; omitted → the
bridge's default workdir. `browser`: boolean, opt into browser tooling
(the bridge's existing `--browser` behavior); omitted → false.
Result:

```
{ convo_id: '<uuid>' }
```

The bridge mints the conversation id at spawn (Claude session UUID — the
existing convention) and returns it; the `convo_upsert` for that conversation
arrives on the journal as usual. **Ordering across the two channels is not
guaranteed** — the app must tolerate the convo_upsert landing before or after
the RPC response, and should navigate by `convo_id` whichever comes first.
Bridge error codes: `bad_workdir` (missing/not a directory), `spawn_failed`.

Any unknown method → `{ok:false, error:{code:'unknown_method'}}` from the
bridge. Adding a method later (stop-session, list-sessions, …) is a bridge +
app change only.

## Security analysis

Both directions are scoped to one user: a client can only reach agent devices
of its own user (validated per request against the devices table), and an
agent can only answer client devices of its own user. Agents cannot originate
requests and clients cannot originate responses, so there is no lateral
agent→agent or cross-user path. Device ids stamped server-side from the
authenticated connection prevent sender spoofing. Nothing is written
durably — no journal rows, no push, no retention surface — so the op adds no
stored-data exposure. The 16 KiB cap keeps the relay from becoming a blob
side-channel (media already has an authenticated, size-capped path). Frames
ride existing authenticated WS connections; no new rate limiter in v1 — a
user flooding their own agent only harms themselves, and the population is
three. The `start` method lets a client spawn processes on the box — but that
is exactly the power the same user already has via text commands in the
control conversation today; workdir validation stays the bridge's job.

## Testing

Conformance-style tests alongside the existing suite (`:memory:` DBs, real WS
pairs as in existing ws tests):

- happy path: client `agent_request` → fake agent conn receives
  `kind:'rpc'` request with stamped `from_device_id` → agent responds →
  client receives correlated response with stamped `agent_device_id`
- target agent offline → immediate `agent_unreachable` carrying `request_id`
- unknown / other-user's / client-kind `agent_device_id` → `not_found`
- agent sending `agent_request` → `forbidden`; client sending
  `agent_response` → `forbidden`
- `agent_response` to unknown / other-user's / agent-kind `to_device_id` →
  `not_found`
- malformed: missing/oversize `request_id` or `method`, non-boolean `ok`,
  `ok:false` without `error.code` → `bad_request`
- frame over 16 KiB → `bad_request`
- response after requesting client disconnected → dropped, no crash
- two live connections on the target agent device → only the most recently
  registered one receives the request (single-consumer); two live
  connections on the responding-to client device → both receive the
  response (multicast)
- RPC traffic appends nothing to the journal (`head_seq` unchanged) and
  triggers no push counters
- `GET /devices`: `connected` true while a WS is open, false after close;
  regression: `/metrics` unchanged, ephemeral coalescing for
  activity/status/tool_stream unchanged

## Rollout

1. Journal: ops + `connected` flag + protocol.md section, one PR (this repo).
2. SP3 bridge: consume `kind:'rpc'` requests, implement `recent_folders` +
   `start`, respond via `agent_response`.
3. App: folder picker + start-session UI on top of `connected` roster; the
   Devices screen spec (`2026-07-15-app-devices-ui-spec.md`) gains an RPC
   section once this merges.

## Open questions

1. Should the server enforce a per-connection cap on outstanding forwarded
   requests (e.g. 32) purely as memory hygiene? (Recommend: no — the relay
   keeps no per-request state at all, so there is nothing to cap; revisit if
   a pending map ever becomes necessary.)
