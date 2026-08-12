# matron-journal

The sync server for **Matron** — a chat system for talking to [Claude
Code](https://claude.com/claude-code) agents from your phone, desktop, or
browser.

matron-journal is a small, server-authoritative journal service: every user
has one append-only, strictly-ordered event log (the *journal*), and every
device — phone, laptop, or agent bridge — is just a cursor into it. Clients
reconnect, say "I have seq N", and replay forward. Everything a user sees is
an event in that log — messages, tool output, read markers, conversation
metadata, session status — with a per-user monotonic `seq` assigned
server-side and at-least-once delivery behind idempotency keys, so publishers
fire-and-forget and retry safely. No federation, no CRDTs, no client-side
merge — one user, one log, many cursors.

Status: v0.1.0 — pre-1.0, the protocol may change. The apps are in beta:
TestFlight (iPhone / Mac) and Play Store testing (Android) — see
[matron.chat](https://matron.chat).

## Run

    npm install
    MATRON_DB=./matron.db MATRON_PORT=9810 npm start

Node 20+. A systemd unit template is in
[`deploy/matron-journal.service`](deploy/matron-journal.service).

### Create users and devices

    printf %s "$PW" | MATRON_DB=./matron.db npx matron-admin user add dan --password-stdin
    MATRON_DB=./matron.db npx matron-admin agent add dan dev-2
    MATRON_DB=./matron.db npx matron-admin link-code dan --server-url https://journal.example.com --expires 30m
    MATRON_DB=./matron.db npx matron-admin device list dan
    MATRON_DB=./matron.db npx matron-admin device revoke <device_id>
    MATRON_DB=./matron.db npx matron-admin device private <device_id> on
    MATRON_DB=./matron.db npx matron-admin offload [--days N]
    MATRON_DB=./matron.db npx matron-admin expire-logs [--hours N]
    MATRON_DB=./matron.db npx matron-admin status

Passwords come from stdin (`--password-stdin`) or the `MATRON_PASSWORD` env
var; the legacy `--password <pw>` flag still works but puts the plaintext on
argv, where any local user can read it via `ps`.

Clients log in with `POST /login` and get their own device token; agents are
provisioned with `matron-admin agent add`, which prints a token once.
`link-code` prints a QR code and a short code for signing in a second device
without retyping credentials.

Next steps: install [matron-bridge](https://github.com/Matronhq/matron-bridge)
on each dev box, then sign in from an app with your journal URL + username.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `MATRON_DB` | `./matron.db` | Path to the SQLite database file |
| `MATRON_PORT` | `9810` | Listen port |
| `MATRON_BIND` | `127.0.0.1` | Bind address (put a TLS-terminating proxy in front for `wss://`) |
| `MATRON_MEDIA_DIR` | `<db dir>/media` | Blob storage root |
| `MATRON_MEDIA_MAX_BYTES` | 50 MiB (`52428800`) | Upload size limit |
| `MATRON_MEDIA_USER_QUOTA_BYTES` | 2 GiB (`2147483648`) | Per-user media storage quota |
| `MATRON_MAX_REPLAY` | `50000` | Replay gap above which clients are told to re-snapshot |
| `MATRON_RETENTION_DAYS` | `30` | Offload `tool_output` payloads older than this (`0` disables) |
| `MATRON_TOOL_LOG_TTL_HOURS` | `24` | Delete offloaded tool-log blobs older than this |
| `MATRON_WS_PING_MS` | `55000` | WebSocket heartbeat interval (kept under common 60s proxy idle timeouts) |
| `MATRON_RPC_MAX_BYTES` | `16384` | Max inbound WebSocket RPC frame size |
| `MATRON_TOOL_STREAM_MAX_BYTES` | `1048576` | Max bytes per live tool-output stream buffer |
| `MATRON_TOOL_STREAM_MAX_BUFFERS` | `64` | Max concurrent tool-output stream buffers |
| `MATRON_TOOL_STREAM_IDLE_MS` | `1800000` | Idle expiry for tool-output stream buffers |
| `MATRON_APNS_KEY_FILE` / `_KEY_ID` / `_TEAM_ID` / `_TOPIC` | unset | All four set = push enabled; otherwise push is an inert no-op |
| `MATRON_PUSH_GATEWAY_URL` | unset | Push relay URL when you have no APNs key — see Push relay section |
| `MATRON_RELAY_PORT` / `MATRON_RELAY_BIND` | `9821` / `127.0.0.1` | matron-push-relay only |

## How it fits together

```
 iPhone / Mac / Android /               matron-bridge (agent)
 desktop / web client                          │  WS /ws
        │  WS /ws + HTTP                       │
        └──────────────┬───────────────────────┘
                       ▼
                matron-journal
          per-user append-only journal
             (SQLite, WAL, one file)
```

- Bridges (e.g. [matron-bridge](https://github.com/Matronhq/matron-bridge))
  connect as **agent** devices: they create conversations, publish Claude's
  output into the journal, and receive the user's messages for the
  conversations they own.
- Apps — [matron-apple](https://github.com/Matronhq/matron-apple) (iPhone +
  Mac), [matron-android](https://github.com/Matronhq/matron-android),
  [matron-desktop](https://github.com/Matronhq/matron-desktop),
  [matron-web](https://github.com/Matronhq/matron-web) — connect as **client**
  devices: they render the journal, send user messages, and get push
  notifications when disconnected.
- [dev-boxer](https://github.com/Matronhq/dev-boxer) provisions a fresh box
  with the whole stack in one command.

## Features

- **Cursor replay** — reconnect with `{op:'hello', token, cursor}` and
  receive everything after it, then live frames on the same socket.
- **Two device kinds** — `client` (apps) and `agent` (bridges), with
  per-conversation agent ownership so multi-bridge fleets only receive
  their own traffic.
- **Auth** — argon2id password hashes, per-device bearer tokens, login rate
  limiting + lockout, instant device revocation.
- **QR / link-code sign-in** — `matron-admin link-code` prints a QR code and
  short code; a second device signs in via the `/link/*` + `/pair/*` flows
  without retyping credentials (`src/link.js`, `src/pairing.js`,
  `src/rendezvous.js`).
- **Search** — FTS5 full-text search over journal prose, `GET /search`
  (`src/search.js`).
- **Agent chat rooms** — agent-to-agent conversations; every invite and
  join asks the user for consent, every time (`src/participants.js`).
- **Device privacy** — private agent devices hidden from ordinary agents
  (`matron-admin device private`).
- **Media** — blob upload/download with per-user authorization and sharded
  on-disk storage.
- **Push** — direct HTTP/2 APNs (ES256 provider JWT, `node:http2`), no
  sygnal: priority tiers, per-conversation coalescing, silent badge-clear
  pushes, dead-token pruning, per-device sandbox/prod environment.
- **Retention** — old `tool_output` payloads offload from the hot table to
  blob files on a schedule, and a TTL pass deletes those blobs after
  `MATRON_TOOL_LOG_TTL_HOURS` (default 24); journal rows are never deleted.
- **Ops** — `/metrics` endpoint, `matron-admin` CLI (`user add`/`passwd`,
  `agent add`, `device list`/`revoke`/`private on|off|auto`, `link-code`,
  `offload`, `expire-logs`, `agent-chat pending|approve|deny`,
  `status`), systemd unit in `deploy/`, WAL checkpoint tuning
  ([measured](docs/wal-checkpoint-profile.md)).
- **Conformance fixtures** — golden wire-protocol exchanges under
  `test/fixtures/conformance/` that client implementations replay too, so
  server and clients can't silently drift.

Dependencies: `better-sqlite3`, `ws`, `argon2`, `qrcode`, `qrcode-terminal`.
That's the whole list.

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

The wire protocol is small: ~20 Bearer-authenticated HTTP endpoints (auth,
snapshot, history, search, media, push, device pairing/linking, agent-chat
consent) and one WebSocket (`/ws`) speaking journal frames — see
[docs/protocol.md](docs/protocol.md) for the full list.

- Operational reference: [docs/protocol.md](docs/protocol.md)
- Design spec (the why): [docs/superpowers/specs/2026-07-10-matron-protocol-design.md](docs/superpowers/specs/2026-07-10-matron-protocol-design.md)
- Machine-checkable fixtures: [test/fixtures/conformance/](test/fixtures/conformance/)

## Test

    npm test

Runs the full suite (`node --test`), including the protocol conformance
suite replayed against a real in-process server. `npm run loadtest` drives a
synthetic multi-device load against a scratch server.

## Ops

- Vulnerability reporting policy: [SECURITY.md](SECURITY.md)
- Shared-infra VPS (push relay + demo journal, cloudflared + systemd):
  [deploy/vps/README.md](deploy/vps/README.md)
- Team rollout runbook (historical — Matrix-era migration):
  [docs/runbooks/team-rollout.md](docs/runbooks/team-rollout.md)
- WAL checkpoint profiling method + numbers:
  [docs/wal-checkpoint-profile.md](docs/wal-checkpoint-profile.md)

---

History: the journal replaced a whole Matrix homeserver + client-sync stack
for Matron's use case, in a few thousand lines of Node with SQLite underneath.
