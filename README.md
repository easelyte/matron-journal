# matron-journal

The sync server for **Matron** — a chat system for talking to [Claude
Code](https://claude.com/claude-code) agents from your phone, desktop, or
browser.

matron-journal is a small, server-authoritative journal service: every user
has one append-only, strictly-ordered event log (the *journal*), and every
device — phone, laptop, or agent bridge — is just a cursor into it. Clients
reconnect, say "I have seq N", and replay forward. That one idea replaces a
whole Matrix homeserver + client-sync stack for Matron's use case, in a few
thousand lines of Node with SQLite underneath.

## How it fits together

```
 iOS / desktop / web client          claude-matrix-bridge (agent)
        │  WS /ws + HTTP                     │  WS /ws
        └──────────────┬─────────────────────┘
                       ▼
                matron-journal
          per-user append-only journal
             (SQLite, WAL, one file)
```

- Bridges (e.g. [claude-matrix-bridge](https://github.com/Matronhq/claude-matrix-bridge))
  connect as **agent** devices: they create conversations, publish Claude's
  output into the journal, and receive the user's messages for the
  conversations they own.
- Apps ([matron-apple](https://github.com/Matronhq/matron-apple),
  [matron-desktop](https://github.com/Matronhq/matron-desktop),
  [matron-web](https://github.com/Matronhq/matron-web)) connect as **client**
  devices: they render the journal, send user messages, and get push
  notifications when disconnected.
- [dev-boxer](https://github.com/Matronhq/dev-boxer) provisions a fresh box
  with the whole stack in one command.

## Design in one paragraph

Everything a user sees is an event in their journal: messages, tool output,
prompts, read markers, conversation metadata, session status. Events get a
per-user monotonic `seq` assigned server-side; delivery is at-least-once with
idempotency keys, so publishers fire-and-forget and retry safely. Devices
resume from any cursor (with a snapshot escape hatch for huge gaps), unread
counts and push decisions derive from the same log, and ephemeral traffic
(typing indicators, live streaming previews) fans out alongside it without
ever touching the journal. No federation, no rooms, no CRDTs — one user, one
log, many cursors.

## Features

- **Cursor replay** — reconnect with `{op:'hello', token, cursor}` and
  receive everything after it, then live frames on the same socket.
- **Two device kinds** — `client` (apps) and `agent` (bridges), with
  per-conversation agent ownership so multi-bridge fleets only receive
  their own traffic.
- **Auth** — argon2id password hashes, per-device bearer tokens, login rate
  limiting + lockout, instant device revocation.
- **Media** — blob upload/download with per-user authorization and sharded
  on-disk storage.
- **Push** — direct HTTP/2 APNs (ES256 provider JWT, `node:http2`), no
  sygnal: priority tiers, per-conversation coalescing, silent badge-clear
  pushes, dead-token pruning, per-device sandbox/prod environment.
- **Retention** — old `tool_output` payloads offload from the hot table to
  blob files on a schedule; journal rows are never deleted.
- **Ops** — `/metrics` endpoint, `matron-admin` CLI (users, devices,
  revocation, offload, status), systemd unit in `deploy/`, WAL checkpoint
  tuning ([measured](docs/wal-checkpoint-profile.md)).
- **Conformance fixtures** — golden wire-protocol exchanges under
  `test/fixtures/conformance/` that client implementations replay too, so
  server and clients can't silently drift.

Dependencies: `better-sqlite3`, `ws`, `argon2`. That's the whole list.

## Run

    npm install
    MATRON_DB=./matron.db MATRON_PORT=9810 npm start

Node 20+. A systemd unit template is in
[`deploy/matron-journal.service`](deploy/matron-journal.service).

### Create users and devices

    MATRON_DB=./matron.db npx matron-admin user add dan --password '...'
    MATRON_DB=./matron.db npx matron-admin agent add dan dev-2
    MATRON_DB=./matron.db npx matron-admin device list dan
    MATRON_DB=./matron.db npx matron-admin device revoke <device_id>
    MATRON_DB=./matron.db npx matron-admin offload [--days N]
    MATRON_DB=./matron.db npx matron-admin status

Clients log in with `POST /login` and get their own device token; agents are
provisioned with `matron-admin agent add`, which prints a token once.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `MATRON_DB` | `./matron.db` | Path to the SQLite database file |
| `MATRON_PORT` | `9810` | Listen port |
| `MATRON_BIND` | `127.0.0.1` | Bind address (put a TLS-terminating proxy in front for `wss://`) |
| `MATRON_MEDIA_DIR` | `<db dir>/media` | Blob storage root |
| `MATRON_MEDIA_MAX_BYTES` | 50 MB | Upload size limit |
| `MATRON_MAX_REPLAY` | `50000` | Replay gap above which clients are told to re-snapshot |
| `MATRON_RETENTION_DAYS` | `30` | Offload `tool_output` payloads older than this (`0` disables) |
| `MATRON_APNS_KEY_FILE` / `_KEY_ID` / `_TEAM_ID` / `_TOPIC` | unset | All four set = push enabled; otherwise push is an inert no-op |
| `MATRON_PUSH_GATEWAY_URL` | unset | No APNs key? Point at a push relay (`https://push.matron.chat`) — pushes become generic-text alerts built by the relay; your message content never leaves this server |
| `MATRON_RELAY_PORT` / `MATRON_RELAY_BIND` | `9821` / `127.0.0.1` | matron-push-relay only |

## Push relay (self-hosted journals)

Only the app author holds the APNs key for the `chat.matron.app` bundle id, so a
self-hosted journal cannot talk to Apple directly. Set
`MATRON_PUSH_GATEWAY_URL=https://push.matron.chat` and the journal sends each
push as a content-free event instead: device token, environment, a category
(`attention` / `done` / `activity` / `wake`), badge count, and conversation-id
routing fields. The relay maps the category to a fixed generic string ("Your
agent needs you", "Session finished", …) — your message content, titles, and
conversation names never leave your server, structurally: the relay protocol
has no field that could carry them.

Running your own relay (needs an Apple Developer membership and the app's APNs
key, so this is for the hosted one's operator):

    MATRON_APNS_KEY_FILE=… MATRON_APNS_KEY_ID=… MATRON_APNS_TEAM_ID=… \
    MATRON_APNS_TOPIC=chat.matron.app npx matron-push-relay

## Protocol

The wire protocol is small: a handful of Bearer-authenticated HTTP endpoints
(`/login`, `/snapshot`, `/convo/:id/messages`, `/media`, `/push/register`,
`/password`, `/metrics`) and one WebSocket (`/ws`) speaking journal frames.

- Operational reference: [docs/protocol.md](docs/protocol.md)
- Design spec (the why): [docs/superpowers/specs/2026-07-10-matron-protocol-design.md](docs/superpowers/specs/2026-07-10-matron-protocol-design.md)
- Machine-checkable fixtures: [test/fixtures/conformance/](test/fixtures/conformance/)

## Test

    npm test

Runs the full suite (`node --test`), including the protocol conformance
suite replayed against a real in-process server. `npm run loadtest` drives a
synthetic multi-device load against a scratch server.

## Ops

- Team rollout runbook (single-user → whole team, Matrix retirement):
  [docs/runbooks/team-rollout.md](docs/runbooks/team-rollout.md)
- WAL checkpoint profiling method + numbers:
  [docs/wal-checkpoint-profile.md](docs/wal-checkpoint-profile.md)
