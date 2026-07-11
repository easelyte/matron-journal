# v1-completion backlog

Carried out of the server-v1-core final review (2026-07-10). Items the review
triaged as FIX-IN-V1-COMPLETION, plus spec features explicitly deferred.
Deployment context for severity calls: internal team tool (~10 users), behind
a Cloudflare tunnel, bridge agents are trusted first-party code.

## Deferred spec features (plan follows spec §14/§15)

- Media upload/download (`POST /media`, `GET /media/:id`) with authorize on reads
- APNs push (direct HTTP/2 with the existing .p8; collapse-id coalescing; §9 rules)
- Retention/offload job (tool_output payloads → blob files after window)
- `/metrics` (or `matron-admin status` extension): per-device cursor lag, socket counts, head seq
- Golden conformance fixtures (shared with the Matron Swift client's CI)
- `snapshot_required` valve for pathological cursor gaps (spec §6)
- `POST /password` self-service change (spec §8)
- Device revocation end-to-end: `matron-admin device revoke` CLI + mid-socket
  enforcement (WS auths only at hello today; spec §8 promises close-on-next-frame)

## Protocol decisions needed before the Matron client data layer

- **Convo metadata live sync**: title-only `convo_upsert` reaches other devices
  only via `/snapshot` today. Decide: `convo_meta` journal event vs title in
  `session_status` payload.
- **unread_count semantics**: a user's own `send` currently increments their
  unread count (`src/journal.js` message-type branch). Decide before badges render.
- **Duplicate-send confirmation**: at-least-once + client dedup by seq is the
  design; document that a retried send gets no dedicated confirmation frame.
- **Reserved idem-key prefix**: agent `finalize` uses `fin:<message_ref>`; a raw
  `publish` idem_key could collide. Document or namespace.
- **Global convo-id namespace**: conversation ids are a global PK; bridges must
  use globally unique ids (Claude session UUIDs qualify). Document.

## Hardening pass (one work item, touch each file once)

- Client-op validation: `send` missing payload → bad_request (not internal);
  `read_marker` up_to_seq integer check; `hello` cursor integer-or-null check.
- Agent publish type whitelist (trusted, but `session_status` via publish can
  bypass convo_upsert semantics; bad state currently 500-frames via CHECK).
- HTTP: clamp `limit` to 1..200 (reject -1/NaN — `LIMIT -1` returns everything);
  `before_seq` integer check; URIError → 400; stop leaking `e.message` in 500s.
- WS `maxPayload` ~1 MB (ws default is 100 MiB; a 100 MB payload row replays forever).
- Replay backpressure: check `ws.bufferedAmount` between batches.
- Login timing side-channel: dummy argon2 verify on unknown usernames.
- snippetOf/session_status payload guards in journal.js (null payload from agents).
- Ephemeral stream frames are dropped during a connection's replay window
  (hub.register runs after replay; sendEphemeral only targets registered conns —
  Bugbot finding). Low impact: ephemeral is best-effort by design, the next
  coalesced frame or the finalize journal row catches the client up. Revisit
  when the client data layer defines `viewing` semantics.
- Port the realpathSync entrypoint guard from matron-admin to src/server.js (symmetry;
  systemd's direct invocation works today).

## Deployment (before the hostname goes live)

- cloudflared ingress rule + hostname → 127.0.0.1:9810 (port 9803 / tg-viewer2 is
  retired and free to repurpose).
- `ExecStartPre=/usr/bin/mkdir -p .../data` in the systemd unit (fresh clone
  crash-loops on SQLITE_CANTOPEN otherwise).
- Rate-limiter keying via `cf-connecting-ip` is DONE (5a14e6c); revisit Map
  eviction thresholds only if /metrics shows growth.

## Accepted (reviewed, deliberately not fixing)

Raw SqliteError on duplicate admin user; per-call db.prepare rebuilds; style
inconsistencies (inline auth checks, hello-path readyState, hub layering nit);
password on admin argv (single-user boxes); 429 body drain; test-only keep-alive
latency; utf8 cap counting chars not bytes.
