# Matron Protocol & Journal Server — Design

- **Date:** 2026-07-10
- **Status:** Draft for review
- **Owner:** Dan Barker
- **Replaces:** Matrix stack for the Claude bridge — tuwunel homeserver, sygnal push gateway, Element X fork, matrix-rust-sdk layer in the Matron Swift client

## 1. Background

The Claude bridge currently runs over Matrix: per-dev-box Node bridges (`claude-matrix-bridge`) post Claude Code session traffic into rooms on a self-hosted tuwunel homeserver on dev-2; the team reads them in an Element X fork and a native Swift client (Matron, Mac + iOS), both built on matrix-rust-sdk.

Two problems drove this design:

1. **Reliability.** Clients freeze (no new messages until app restart). Diagnosis showed the server healthy and fast; the failure signature is matrix-rust-sdk's sync machinery dying without resuming. Both clients share that SDK, so both freeze.
2. **Fit.** Matrix's cost centers — event DAG, state resolution, signatures, federation machinery, Olm/Megolm E2EE, sliding-sync complexity — buy properties this deployment doesn't use (federation is disabled; all parties trust one server). Meanwhile the bridge's actual needs — streaming tool output, interactive prompts, session state — are shoehorned into `m.text` + HTML + reaction hacks.

The replacement is a purpose-built, server-authoritative protocol whose sync model makes the freeze failure class structurally impossible, and whose message model is native to Claude-session traffic.

## 2. Goals

- A client can never wedge: any connection failure converges to "reconnect and resume from an integer cursor."
- All of a user's devices (Dan: 3 dev boxes publishing, phone + laptop reading) stay in step, including read state and session state.
- First-class message types for Claude traffic: prompts with option buttons, streaming tool output, diffs, permission requests, session status.
- Streaming firehose traffic is cheap: live-output deltas are never persisted; the server coalesces before fan-out.
- Multi-user: one central server for the team; each member's sessions private to them.
- Small enough for one person to maintain: one Node process, one SQLite file.

## 3. Non-goals

- Federation, interop with Matrix clients, or public sign-up.
- E2EE. Threat model is TLS via the Cloudflare tunnel plus first-party auth. (A cheap per-account payload-encryption layer can be added later; nothing in the protocol assumes plaintext payloads server-side.)
- Cross-user sharing UI in v1. The server enforces access checks from day one so per-conversation grants can be added later without protocol changes (see §7).
- General-purpose group chat. Conversations are Claude sessions plus a per-user notices channel; human-to-human chat stays wherever it lives today.

## 4. Topology

```
dev-box bridges (publisher agents, N boxes)          clients (per user)
  bridge on box A ──┐                                  Matron iOS ──┐
  bridge on box B ──┼──► journal server (dev-2) ◄──────Matron Mac ──┤
  bridge on box C ──┘      Node + SQLite               web (later) ─┘
                           APNs push (direct)
```

- One **journal server** process on dev-2, replacing tuwunel and sygnal. Exposed via the existing Cloudflare tunnel on a dedicated hostname (e.g. `chat.example.com` → a localhost port, same pattern as the existing viewer ingress rules). No Cloudflare Access on this hostname — auth is first-party (§8).
- Each dev box's bridge becomes a **publisher agent**: an outbound WebSocket to the server, authenticated by an agent token scoped to its owner's journal. A user with several dev boxes has several agents publishing into one journal.
- **Clients** hold a local store (SQLite/GRDB in Matron) that mirrors the user's journal from their cursor forward.

## 5. Data model

SQLite (WAL mode), one database. Core tables:

- `users(id, name, password_hash, created_at)` — identity. Password hashes are argon2id. Users are created by the admin CLI; Chef can provision as it does Matrix credentials today.
- `devices(id, user_id, kind[client|agent], name, token_hash, cursor, apns_token?, created_at, last_seen_at)` — one row per enrolled device or bridge agent. `cursor` is the last journal seq the device has acknowledged (server-side copy; the client owns its own).
- `conversations(id, owner_user_id, title, session_state[running|waiting|done|archived], last_seq, unread_count, snippet, created_at)` — the materialized room list. Updated transactionally on every relevant journal append.
- `events(user_id, seq, convo_id, ts, sender, type, payload_json, blob_ref?)` — the journal. **PK `(user_id, seq)`; `seq` is per-user and strictly monotonic**, allocated inside the append transaction. Secondary index `(convo_id, seq)` for pagination.
- `blobs(id, owner_user_id, content_type, size, disk_path, created_at)` — uploads and offloaded payloads, stored on disk, served through authenticated HTTP with access checks.

Per-user seq means one user's journal is independent of the team's: replay, cursors, and retention are all scoped per user, and nobody's devices pay for anyone else's traffic.

### Retention

Journal rows are permanent; their payloads are not. A scheduled job offloads `payload_json` of `tool_output`-class events older than a configurable window (default 30 days) to blob files, leaving `{type, snippet, blob_ref}` in the row. Timelines stay scrollable forever; the hot table stays small; full output remains retrievable on demand.

## 6. Protocol

Transport: one WebSocket per connected device (`/ws`), JSON frames. Plus a small HTTP surface: `POST /login`, `GET /snapshot`, `GET /convo/:id/messages`, `POST /media`, `GET /media/:id`.

### Connect and resume

1. Client opens `/ws` with `{token, cursor}` (cursor = highest seq applied to its local store; `0` for a fresh device).
2. Server validates the token, then streams journal frames for `events > cursor` in seq order, then live frames as they occur.
3. Server pings every 20 s. A client missing pongs reconnects with jittered backoff and re-sends its cursor. Replay is idempotent: frames carry `seq`, the client ignores anything ≤ its cursor.

The server keeps **no per-connection sync state** — a resume is indistinguishable from a continuation, so there is no server-side session to wedge, time out, or invalidate. This is the core reliability property.

If replaying from a cursor would be pathological — the gap exceeds a configured threshold (e.g. a device offline for months, or a fresh install that shouldn't replay years of journal) — the server sends `{kind: "control", op: "snapshot_required"}`; the client wipes its local store, calls `GET /snapshot`, and reconnects with the returned seq, lazy-loading history per conversation thereafter. Journal rows are never deleted (§5 offloads only payloads), so this is an efficiency valve, not a data-loss boundary.

### Frame kinds (server → client)

- **`journal`** — a durable row: `{kind, seq, convo_id, ts, sender, type, payload}`. The only frames that advance the cursor.
- **`ephemeral`** — never stored, no seq: streaming output deltas (`{convo_id, message_ref, text_delta | replace_text}`), typing/activity indicators. Lost ephemerals are harmless: the finalized message arrives as a journal row regardless.
- **`control`** — `ping`, `snapshot_required`, `error`.

### Client → server messages

`send` (post a message to a conversation), `prompt_reply` (answer a `prompt` event by ref), `read_marker` (server turns it into a journal row so the user's other devices converge), `ack` (advance server-side cursor copy; used for push suppression and lag observability).

### Publisher agent → server

Same socket, agent token. `publish` (append a journal event to an owned conversation), `stream` (ephemeral deltas for an in-flight message), `finalize` (persist the completed message as one journal row), `convo_upsert` (create/update a conversation: title, session_state). Agents buffer locally while disconnected (the bridge already tails transcripts) and re-publish on reconnect; server-side idempotency keys (`agent_id + local_msg_id`) make retries safe.

### Cold start

`GET /snapshot` → `{conversations: [...summaries], seq}` — a few KB for hundreds of conversations, one round trip to first paint. Then connect the socket with `cursor = seq`. Timeline history loads lazily per conversation via `GET /convo/:id/messages?before_seq=X&limit=50`.

### Coalescing

The server coalesces `stream` deltas per (conversation, message) to ≤ ~5 frames/s per subscribed device. Devices not viewing that conversation receive no ephemerals — only the eventual `journal` row and a summary update. Clients declare their viewed conversation via a lightweight `viewing` message (an ephemeral-class upstream hint; correctness never depends on it).

## 7. Message / event types

Journal event `type`s, with payloads native to Claude-session traffic:

| type | payload highlights | replaces (Matrix-era) |
|---|---|---|
| `text` | body (markdown) | `m.text` + HTML |
| `prompt` | question, options[], allows_free_text | prompt-buttons reaction hack |
| `prompt_reply` | prompt seq ref, chosen option / text | reply-parsing in `prompt-reply.js` |
| `tool_output` | snippet, truncated flag, blob_ref, tool_name | walls of `m.notice` |
| `diff` | files[], unified diff (blob_ref if large) | code blocks |
| `permission_request` | tool, description, options | prompt hack |
| `session_status` | running \| waiting \| done, model, effort | inferred from message text |
| `file` / `image` | blob_ref, content_type, dims | `m.file`/`m.image` + media repo |
| `read_marker` | convo_id, up_to_seq | `m.read` receipts |
| `edit` | target seq, new payload | `m.replace` |

Unknown types must be rendered by clients as a labeled fallback (type name + JSON snippet or snippet field) so the protocol can grow without lockstep upgrades.

### Access control

Every read path (snapshot, pagination, socket fan-out, media) passes `authorize(user, convo)`. In v1 it returns `convo.owner_user_id == user.id`. The sharing door: a future `grants(convo_id, user_id, level)` table extends `authorize` and fan-out without any protocol change. Shared-conversation events would fan out into each grantee's journal by reference.

## 8. Auth

- **Login:** `POST /login {username, password, device_name}` → long-lived device token (random 256-bit, stored hashed). Matron shows a login screen once per device. Rate-limited (5 attempts/min/IP) with exponential lockout.
- **Passwords:** provisioned by admin CLI (`matron-admin user add <name>`), hashes in `users`. Chef manages initial secrets exactly as it does Matrix credentials today. `matron-admin user passwd` to rotate; `POST /password` for self-service change.
- **Agent tokens:** `matron-admin agent add <user> <box-name>` → token for the dev box's bridge, stored in the bridge's credentials file (Chef data bag). Agents cannot log in as users; they can only publish/stream to conversations owned by their user.
- **Revocation:** delete the device/agent row; its socket is closed on next frame.
- **Explicitly rejected:** Cloudflare Access as the auth layer (cookie-based; hostile to native clients, WebSockets, and headless agents; not currently in front of the chat hostname). OIDC against Google Workspace is a possible later upgrade — it would replace only the login ceremony; device tokens and everything downstream are unchanged.

## 9. Push (APNs)

The server sends APNs HTTP/2 pushes directly using the existing `.p8` signing key (team `<team-id>`, topic `chat.matron.x`) — sygnal is retired. Clients register `apns_token` on their device row after enrollment.

Rules: push only for journal events in conversations the device isn't actively viewing and hasn't acked past; coalesce per conversation using `apns-collapse-id` so a busy session is one updating notification, not hundreds; `prompt` and `permission_request` events push at high priority (they block a session), `session_status: done` pushes normally, routine `text`/`tool_output` pushes are batched. Read-marker journal rows from another device trigger a badge-clearing background push.

## 10. Failure handling

- **Client socket death** (network blip, Cloudflare idle cut, server restart): missed pong → reconnect with jittered backoff → resume from cursor. No user-visible failure mode beyond a brief "connecting" state; no restart-the-app path exists because none is needed.
- **Server crash:** systemd restarts the process; SQLite WAL guarantees committed appends survive; clients re-resume. Uncommitted in-flight appends are retried by agents via idempotency keys.
- **Agent offline / dev box reboot:** agent buffers locally and re-publishes on reconnect; per-user journal order is assigned at append time, so late-arriving events simply append (timeline shows bridge-side `ts` for display).
- **Clock skew:** ordering is by `seq`, never by timestamp. `ts` is display-only.
- **Cursor beyond horizon:** `snapshot_required` → wipe, snapshot, resync — bounded worst case, still automatic.
- **Observability:** `/metrics` (or `matron-admin status`) exposes per-device cursor lag, connected sockets, journal head seq per user, APNs failures. "Which integer stopped moving" is a one-query diagnosis.

## 11. Migration

1. Server v1 deployed on dev-2 alongside tuwunel (different port/hostname). Synthetic-load soak.
2. Bridge gains a **dual-post output layer**: every session posts to Matrix (unchanged) and publishes to the journal server. Bridge input (user replies) is accepted from both paths during transition.
3. Matron's data layer swaps matrix-rust-sdk for the journal protocol (WebSocket + GRDB store + cursor). Dan daily-drives it against real traffic while the team stays on Element X/Matrix, untouched.
4. Per-user cutover: enroll a user's devices, flip their bridge(s) to journal-primary. No flag day; Matrix history stays readable in old clients until decommission.
5. Decommission: tuwunel, sygnal, and the Element X fork retired once the last user is off. Historic Matrix data optionally exported to journal rows (nice-to-have, not v1).

## 12. Testing

- **Chaos resume property test (the headline):** a harness drives a synthetic firehose through the server while killing client connections at random points (mid-replay, mid-stream, mid-ack) and asserts the client store always converges to an exact prefix-consistent copy of the journal. This is the Matrix-era failure class, tested continuously in CI.
- **Protocol conformance suite:** golden JSON request/response/frame fixtures; the Node test client and Matron's Swift layer both run against a local server instance in CI, so the two implementations can't drift.
- **Load test:** synthetic publisher replicating the worst observed traffic (~40 deltas/s per session, 10 concurrent sessions, 300 conversations/user) validating coalescing rates and append latency.
- **Auth tests:** rate limiting, revocation mid-socket, agent/user privilege separation, `authorize()` on every read path (including media).

## 13. Implementation choices

- **Runtime:** Node 20+, `better-sqlite3` (synchronous, transactional, ideal for a single-writer journal), `ws`. Single process; systemd unit; Chef-deployable like the bridge.
- **Why Node:** the bridge is Node — its battle-tested `prompt-detector`, `live-output`, `iv-uploads` logic ports into the agent/publisher module nearly as-is; the team already maintains Node services. At ~10 users / ~10 agents, performance headroom is orders of magnitude beyond need.
- **Repos:** `Matronhq/matron-journal` (this repo: server + admin CLI + protocol docs + conformance fixtures; "matron-server" is taken by the tuwunel fork until it is decommissioned). Bridge changes land in `claude-matrix-bridge` (publisher module replacing/paralleling the Matrix output layer). Matron app repo gains the Swift protocol layer.

## 14. Effort estimate

| Phase | Scope | Estimate |
|---|---|---|
| Server v1 | journal, WS protocol, auth, admin CLI, snapshot/pagination, APNs, metrics | 2–3 weeks |
| Bridge publisher | dual-post output layer + input path | ~1 week (overlaps) |
| Matron data layer | rust-sdk → WebSocket + GRDB + cursor | 1–2 weeks |
| Migration + polish | soak, per-user cutover, web-client groundwork | 1–2 weeks |

**Total: 4–7 weeks to daily-drivable**, Matrix running in parallel throughout.

## 15. Explicitly deferred

- Web client (second client, after Matron cutover).
- Per-conversation sharing grants (+UI).
- OIDC login ceremony.
- Payload encryption at rest / cheap E2EE.
- Matrix history import.
