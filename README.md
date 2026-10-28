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

    ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install
    MATRON_DB=./matron.db MATRON_PORT=9810 npm start

Semantic search uses the optional `@huggingface/transformers` dependency.
Its `onnxruntime-node` dependency downloads CUDA libraries (about 340 MB)
at install time unless `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` is set; search
runs on the CPU, so the install line above sets it, as does
`deploy/vps/setup.sh`. Use
`npm install --omit=optional` to leave semantic search out entirely. See
`MATRON_SEMANTIC_SEARCH` below for memory use and the first-boot model
download.

Node 20+. A systemd unit template is in
[`deploy/matron-journal.service`](deploy/matron-journal.service).

`npm start` runs `bin/matron-journal`, which starts `src/server.js`. On macOS
it runs from a copy of the node binary named `matron-journal` (kept in
`~/.matron/bin`, refreshed after a node upgrade), so per-app firewalls, which
identify a program by its executable, show the journal under its own name
rather than as `node`. The copy keeps node's code signature; the firewall may
ask once more after a node upgrade. Set `MATRON_NAMED_NODE=0` to run under
node itself; on Linux that is what always happens.

### Create users and devices

    printf %s "$PW" | MATRON_DB=./matron.db npx matron-admin user add alice --password-stdin
    MATRON_DB=./matron.db npx matron-admin user admin alice on
    MATRON_DB=./matron.db npx matron-admin agent add alice box-2
    MATRON_DB=./matron.db npx matron-admin link-code alice --server-url https://journal.example.com --expires 30m
    MATRON_DB=./matron.db npx matron-admin device list alice
    MATRON_DB=./matron.db npx matron-admin device revoke <device_id>
    MATRON_DB=./matron.db npx matron-admin device private <device_id> on
    MATRON_DB=./matron.db npx matron-admin offload [--days N]
    MATRON_DB=./matron.db npx matron-admin expire-logs [--hours N]
    MATRON_DB=./matron.db npx matron-admin status
    MATRON_DB=./matron.db npx matron-admin two-factor status
    MATRON_DB=./matron.db npx matron-admin two-factor require on|off
    MATRON_DB=./matron.db npx matron-admin user 2fa-reset alice

Passwords come from stdin (`--password-stdin`) or the `MATRON_PASSWORD` env
var; the legacy `--password <pw>` flag still works but puts the plaintext on
argv, where any local user can read it via `ps`.

Clients log in with `POST /login` and get their own device token; agents are
provisioned with `matron-admin agent add`, which prints a token once.
`link-code` prints a QR code and a short code for signing in a second device
without retyping credentials.

Two-factor sign-in: each user turns it on in the web app's settings with an
authenticator app (TOTP) and gets ten recovery codes. `two-factor require on`
makes it compulsory, so users without it enrol at their next password sign-in.
`user 2fa-reset` is the way back in for someone who has lost both their app
and their recovery codes. Details are in [docs/protocol.md](docs/protocol.md),
"Two-factor sign-in".

Next steps: install [matron-bridge](https://github.com/Matronhq/matron-bridge)
on each dev box, then sign in from an app with your journal URL + username.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `MATRON_DB` | `./matron.db` | Path to the SQLite database file |
| `MATRON_PORT` | `9810` | Listen port |
| `MATRON_BIND` | `127.0.0.1` | Bind address (put a TLS-terminating proxy in front for `wss://`) |
| `MATRON_GITHUB_CLIENT_ID` | Matron's published OAuth App id (`Ov23likaFmqoegaDMTtz`) | GitHub OAuth App client id for account linking (device flow works with the id alone). Set to the empty string to disable linking; set your own app's id, with its secret, for the web flow |
| `MATRON_GITHUB_CLIENT_SECRET` | unset | Client secret of an OAuth App registered for this journal (callback `https://<journal>/github/callback`). Enables the one-click web flow |
| `MATRON_GITHUB_DEVICE_FLOW` | on | Set to `0` to turn off the device flow (code entered on GitHub's site). It is always off when a client secret is set, so a journal with the web flow offers only that |
| `MATRON_GITHUB_HOST` | `github.com` | GitHub Enterprise host, if any |
| `MATRON_TOKEN_KEY` | unset (tokens stored as-is) | 64 hex chars (`openssl rand -hex 32`). Seals stored GitHub tokens and two-factor secrets with AES-256-GCM; existing GitHub rows are sealed at the next start. Two-factor sign-in needs it. Losing it means every user re-links GitHub, and two-factor users need `matron-admin user 2fa-reset` |
| `MATRON_WEB_DIR` | unset (nothing served) | Directory of the built tracker web app. Served read-only with `index.html` fallback for `/u/*` and `/app/*` |
| `MATRON_APPLE_APP_IDS` | unset (404) | Comma-separated `TEAMID.bundle.id` list for `/.well-known/apple-app-site-association`, claiming `/u/*` |
| `MATRON_ANDROID_PACKAGE` | unset (404) | Android package name for `/.well-known/assetlinks.json`; needs `MATRON_ANDROID_CERT_SHA256` too |
| `MATRON_ANDROID_CERT_SHA256` | unset | Comma-separated signing-cert SHA-256 fingerprints (`AA:BB:…`) for assetlinks |
| `MATRON_MEDIA_DIR` | `<db dir>/media` | Blob storage root |
| `MATRON_MEDIA_MAX_BYTES` | 50 MiB (`52428800`) | Upload size limit |
| `MATRON_STT_AZURE_KEY` | unset (off) | Azure Speech resource key. Set it and every user's voice note, and the audio track of every user's video, is transcribed here on upload (Azure fast transcription), along with voice notes on tracker items; a bridge reads the words instead of running its own whisper, and can ask for a retry (`POST /media/:id/transcript`). Needs `ffmpeg` on `PATH`. With `MATRON_WHISPER_MODEL` set too, whisper is the fallback when the cloud call fails |
| `MATRON_STT_AZURE_KEY_FILE` | unset | File holding the key, used when `MATRON_STT_AZURE_KEY` is unset; read at boot. Set but unreadable = cloud transcription off, said at boot |
| `MATRON_STT_AZURE_MODEL` | `MAI-Transcribe-2` | Azure transcription model; the empty string = Azure's standard model |
| `MATRON_STT_AZURE_ENDPOINT` | `https://northeurope.api.cognitive.microsoft.com` | Azure Speech endpoint of the resource the key belongs to |
| `MATRON_STT_LOCALE` | `en` (`en-GB` for the standard model) | Locale sent to Azure |
| `MATRON_WHISPER_MODEL` | unset (off) | Path to a whisper.cpp model (`…/whisper.cpp/models/ggml-base.bin`). With `MATRON_STT_AZURE_KEY` set, whisper is the fallback behind Azure: a note whose cloud call fails (an error, not an answer with no words in it) is transcribed here instead, one at a time. Without a key it is the transcriber, for voice notes on tracker items only (chat notes stay the origin box's job). Needs `ffmpeg` on `PATH`. Under the shipped systemd unit install whisper.cpp outside `/home` (e.g. `/opt/whisper.cpp`) — `ProtectHome=yes` hides it otherwise |
| `MATRON_WHISPER_CLI` | `<model dir>/../build/bin/whisper-cli` | whisper-cli binary, if not in whisper.cpp's own layout |
| `MATRON_WHISPER_LANGUAGE` | `en` | Language passed to whisper |
| `MATRON_WHISPER_PROMPT` | built-in Matron vocabulary | Vocabulary hint passed to whisper-cli as `--prompt`: names and terms it should spell right (box names, `sudo`, `PR`). Set your own list, or the empty string to send no prompt |
| `MATRON_TTS_AZURE_KEY` / `MATRON_TTS_AZURE_KEY_FILE` | unset: the transcription key, `MATRON_STT_AZURE_KEY` / `MATRON_STT_AZURE_KEY_FILE` | Azure Speech key (or a file holding it) for voice mode's cloud voice, `POST /tts`. With no key at all the route answers 501 and the apps use the on-device voice. See "Text to speech" in `docs/protocol.md` |
| `MATRON_TTS_AZURE_REGION` | `northeurope` | Region of the speech key |
| `MATRON_TTS_MODEL` | `MAI-Voice-2.1-Flash` | Speech model; the Azure voice name is `<voice>:<model>` |
| `MATRON_TTS_VOICE` | `en-GB-Harry` | Default voice (`en-GB-Harry` or `en-GB-Emily`) |
| `MATRON_TTS_DAILY_CHARS` | `300000` | Characters of text per user per UTC day that may be sent for speech; over it `POST /tts` answers 429 |
| `MATRON_TTS_DISABLED` | unset | `1` turns cloud speech off even when a key is present |
| `MATRON_MEDIA_USER_QUOTA_BYTES` | 2 GiB (`2147483648`) | Per-user media storage quota |
| `MATRON_MEDIA_REAP_HIGH_PCT` | `90` | Reap a user's oldest attachments once their footprint hits this % of the quota. `0`, a non-integer, or a value over `100` disables the reaper |
| `MATRON_MEDIA_REAP_LOW_PCT` | `70` | Reap down to this % of the quota; reaped events tombstone to `expired: true`. Must be lower than the high %, or the reaper is disabled (same invalid-value rules) |
| `MATRON_MAX_REPLAY` | `50000` | Replay gap above which clients are told to re-snapshot |
| `MATRON_RETENTION_DAYS` | `30` | Offload `tool_output` payloads older than this (`0` disables) |
| `MATRON_TOOL_LOG_TTL_HOURS` | `24` | Delete offloaded tool-log blobs older than this |
| `MATRON_VOICE_NOTE_TTL_DAYS` | `7` | Delete an item voice note's audio this many days after its transcript landed; the transcript stays (`0` disables) |
| `MATRON_DEVICE_RETENTION` | unset (off) | Comma-separated `<deviceId>:<days>` (e.g. `4:30,9:7`): expire the content of each device's sessions and rooms once older than that many days — payloads become tombstones, search rows and unshared blobs are deleted. Any invalid entry disables the whole setting. See docs/protocol.md *Per-device content expiry* |
| `MATRON_TRANSFER_MAX_BYTES` | 10 GiB (`10737418240`) | Per-file size cap for agent-to-agent file transfers |
| `MATRON_TRANSFER_USER_QUOTA_BYTES` | 20 GiB (`21474836480`) | Per-user cap on the declared size of transfers whose bytes the journal still holds or will hold (in flight, or delivered within the last hour before their copy is deleted), separate from the media/attachment quota |
| `MATRON_TRANSFER_MAX_AWAITING_PER_SENDER` | `50` | How many of one sending box's transfers may wait for the user's approval at once; the next `POST /transfers` is `409 too_many_awaiting` |
| `MATRON_WS_PING_MS` | `55000` | WebSocket heartbeat interval (kept under common 60s proxy idle timeouts) |
| `MATRON_RPC_MAX_BYTES` | `16384` | Max inbound WebSocket RPC frame size |
| `MATRON_TOOL_STREAM_MAX_BYTES` | `1048576` | Max bytes per live tool-output stream buffer |
| `MATRON_TOOL_STREAM_MAX_BUFFERS` | `64` | Max concurrent tool-output stream buffers |
| `MATRON_TOOL_STREAM_IDLE_MS` | `1800000` | Idle expiry for tool-output stream buffers |
| `MATRON_SEMANTIC_SEARCH` | on | `off` disables the similar tier of `/search/all` (the model is never loaded; search stays lexical). When on, the embedding model (`Xenova/bge-small-en-v1.5`, quantised) runs in-process and adds about 150 MB RSS (the whole process peaks under 300 MB while indexing a 3 GB journal). It is on by default: on a host without that headroom, set `MATRON_SEMANTIC_SEARCH=off`. The first index pass embeds every tracker doc, one at a time on one thread, paced like the backfills below. A missing optional dependency or a failed model load also turns it off; neither fails a boot or a request |
| `MATRON_BACKGROUND_DELAY_MS` | 30000 | How long after listening the startup backfills (message search index, `is_diff`, image sizes) and the first vector index pass wait before starting. They then run one at a time, and each saves its place per batch, so a restart resumes rather than starting over |
| `MATRON_BACKGROUND_PACE` | 1 | Rest between background batches, as a whole multiple of the batch's own time: 1 keeps that work to at most half of one core, 0 only yields one event-loop turn |
| `MATRON_SEMANTIC_MODEL_DIR` | unset (`<db dir>/models`, downloaded on first boot) | Directory holding a pre-seeded model, laid out as `<dir>/Xenova/bge-small-en-v1.5/{config.json,tokenizer.json,tokenizer_config.json,onnx/model_quantized.onnx}`. When set, the model is never downloaded, so boot needs no network. When unset, the first boot downloads the model (about 35 MB) into `<db dir>/models`, which must be writable |
| `MATRON_COORDINATOR_CONSENT_DAILY_CAP` | `20` | The Coordinator's chat and spawn consent approvals per user per rolling 24 h. `0` is no cap. See docs/protocol.md *Consent approval* |
| `MATRON_COORDINATOR_TRANSFER_DAILY_CAP` | `100` | The Coordinator's file-transfer approvals per user per rolling 24 h, counted apart from the cap above. `0` is no cap. See docs/protocol.md *File transfers* |
| `MATRON_COORDINATOR_ROUTINE_CAP` | `10` | Routine-born self-approvals (a spawn or chat ask the Coordinator makes and approves itself during a scheduled routine) per user per rolling 24 h, on top of the daily cap. `0` is no cap |
| `MATRON_VERIFIER_API_KEY` / `MATRON_VERIFIER_API_KEY_FILE` | unset (verifier off) | Anthropic API key, inline or read from a file, for the verifier that judges the Coordinator's routine-born self-approvals. With no key those approvals are refused `409 verifier_unavailable` and the card waits for the user. See docs/protocol.md *Consent approval* for the causes, envelopes and verifier rules |
| `MATRON_VERIFIER_MODEL` | `claude-opus-5-5` | Model the verifier calls |
| `MATRON_VERIFIER_TIMEOUT_MS` | `60000` | Bound on the whole verifier call; a timeout fails closed (the approval is refused and the card waits for the user) |
| `MATRON_RESEND_API_KEY` / `MATRON_RESEND_API_KEY_FILE` | unset (off) | [Resend](https://resend.com) API key, inline or read from a file, for password reset by email ("Forgot password?"). A sending-only key is enough. Needs `MATRON_MAIL_FROM` and `MATRON_PUBLIC_URL` too; without all three the feature is off and the apps hide it. Users need an address on file: `matron-admin user email <name> <address>`, the web admin page, or their own Settings |
| `MATRON_MAIL_FROM` | unset | From address for reset emails, on a domain verified with Resend, e.g. `Matron <no-reply@example.com>` |
| `MATRON_PUBLIC_URL` | unset | This journal's public `https://` origin, e.g. `https://journal.example.com`. Reset links point at `<origin>/app/reset-password` (served by `MATRON_WEB_DIR`). Required, because building links from a request's `Host` header would let anyone have the journal mail out a link to their own site |
| `MATRON_APNS_KEY_FILE` / `_KEY_ID` / `_TEAM_ID` / `_TOPIC` | unset | All four set = push enabled; otherwise push is an inert no-op |
| `MATRON_PUSH_GATEWAY_URL` | unset | Push relay URL when you have no APNs key — see Push relay section |
| `MATRON_RELAY_PORT` / `MATRON_RELAY_BIND` | `9821` / `127.0.0.1` | matron-push-relay only |
| `MATRON_FILE_OWNER_USER_ID` | unset | Numeric journal user ID authorized to use the File Explorer (`/files*`, read and write). **Required** whenever `MATRON_FILE_READ_ROOTS` (or writes) are enabled: unset or malformed, every `/files` request answers 500. Every other user, admin or not, gets 403 |

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
- **Agent-to-agent file transfers** — one agent sends a file to the other
  agents in a room it belongs to; chunked, resumable uploads, a secret-scan
  verdict on the consent card, Range-able downloads, and automatic cleanup
  once a file is collected or a week passes uncollected
  (`src/transfers.js`, `src/transfer-consent.js`; see docs/protocol.md
  *Agent-to-agent file transfers*).
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
- WAL checkpoint profiling method + numbers:
  [docs/wal-checkpoint-profile.md](docs/wal-checkpoint-profile.md)

---

History: the journal replaced a whole Matrix homeserver + client-sync stack
for Matron's use case, in a few thousand lines of Node with SQLite underneath.
