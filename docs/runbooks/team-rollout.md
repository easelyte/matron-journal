# Runbook: team rollout of matron-journal

Roll matron-journal out from Dan's single-user deployment on dev-2 to the
whole team, replacing the tuwunel Matrix homeserver. The journal side is
**additive** throughout: every bridge dual-posts to Matrix and the journal
until per-user cutover, so a journal problem never affects Matrix
(`claude-matrix-bridge/.env.example`).

Every step states **WHERE** it runs:

- **[CENTRAL]** — the journal server host, dev-2 (`systemd
  matron-journal.service`, DB `/home/youruser/matron-journal/data/matron.db`,
  bound `127.0.0.1:9810`, public `https://chat.example.com`).
- **[BOX:&lt;host&gt;]** — a teammate's dev box running `claude-matrix-bridge`.
- **[CHEF]** — the `infra-repo` repo (`dev_server` cookbook). PROPOSED
  only — no change lands from this repo.

Placeholders to fill in per site: `<username>`, `<dev-box-host>` (short
hostname used as the agent name), `<device_id>`.

> Accuracy: every command, flag, env var, path, and endpoint below is drawn
> from the repo README, the protocol spec
> (`docs/superpowers/specs/2026-07-10-matron-protocol-design.md`), the admin
> CLI (`bin/matron-admin.js`), the committed unit (`deploy/matron-journal.service`),
> and `claude-matrix-bridge/.env.example`. Open questions are flagged inline
> as **OPEN**.

---

## Current deployed reality (starting point)

- One journal server process on dev-2 (`matron-journal.service`), listening
  `127.0.0.1:9810`, published at `https://chat.example.com` through a
  **remotely-managed** Cloudflare tunnel (`dev-2-server`). Routes are edited
  in the Zero Trust dashboard under **Published applications** on that tunnel
  — **not** `/etc/cloudflared/config.yml`.
- **No Cloudflare Access** on `chat.example.com` by design — native-client
  auth is first-party passwords + device/agent tokens (spec §8).
- One user (`dan`) and one agent token (dev-2's own bridge). Token/password
  files live under `~/.config/matron/`, mode `600`.
- Every team member already runs `claude-matrix-bridge` on their own dev
  box, today pointed at the tuwunel homeserver. Rollout points each box's
  bridge at the **one** central journal server; the APNs push key is
  configured on the central server via a systemd drop-in
  (`/etc/systemd/system/matron-journal.service.d/apns.conf`, variable names
  only — see §5/§9).

---

## 1. Prereqs & inventory

Collect before starting. **[CENTRAL] + planning**

- [ ] Team roster: one journal `<username>` per person (lowercase, matches
      existing convention for `dan`).
- [ ] Dev-box inventory: every `<dev-box-host>` and **who owns it**. Dan
      owns three dev boxes + a laptop/phone client; most teammates own one
      box + client(s).
- [ ] Confirm each box currently runs `claude-matrix-bridge`
      (`sudo systemctl status claude-matrix-bridge.service`) and dual-post
      journal vars are still **unset** (§8 for how to read them).
- [ ] Confirm the central server is healthy:
      ```
      # [CENTRAL]
      sudo systemctl status matron-journal.service
      curl -fsS http://127.0.0.1:9810/metrics -H "Authorization: Bearer <a-valid-device-token>" | head
      ```
      (`/metrics` requires any valid device token; use `dan`'s.)
- [ ] A secure out-of-band channel to deliver initial passwords (secret vault
      / 1Password) — **never chat, never a repo** (§10).

---

## 2. Per-user provisioning (central server)

All admin commands run **[CENTRAL]**, in the server checkout, with `MATRON_DB`
pointed at the live DB. Syntax is exactly `bin/matron-admin.js` (README §Admin).

```
# [CENTRAL]
cd /home/youruser/matron-journal
export MATRON_DB=/home/youruser/matron-journal/data/matron.db

# create the account with an initial password
npx matron-admin user add <username> --password '<initial-password>'
# -> "user <username> created (id N)"
```

- Deliver `<initial-password>` to the teammate **out-of-band** (secret vault),
  never via chat.
- The teammate changes it on first login via `POST /password` (Bearer, client
  devices only): `{old_password, new_password}`, `new_password` a string ≥ 8
  chars (README). Login mints the device token first; the Matron app performs
  login-then-change. Manual equivalent:
  ```
  # from the teammate's client, after POST /login yields <token>
  curl -fsS https://chat.example.com/password \
    -H "Authorization: Bearer <token>" \
    -H 'Content-Type: application/json' \
    -d '{"old_password":"<initial-password>","new_password":"<new-password>"}'
  ```
  A password change does **not** revoke existing device tokens (README) — it
  only rotates the credential used by `/login`.
- Login is rate-limited: 5 attempts/min/IP (429 `rate_limited`) plus
  per-username lockout after 5 consecutive failures (429 `locked_out`,
  `Retry-After`). Don't script blind retries against a forgotten password.

To rotate a password administratively (lost password, §9):
```
# [CENTRAL]
npx matron-admin user passwd <username> --password '<new-password>'
```

---

## 3. Per-dev-box agent enrollment

One agent token per dev box, scoped to that box's owner. Do this **once per
box**, coordinating the restart with the owner.

**a. Issue the agent token — [CENTRAL].** The agent name is the box's short
hostname; the journal sender becomes `agent:<dev-box-host>`.

```
# [CENTRAL]
cd /home/youruser/matron-journal
MATRON_DB=/home/youruser/matron-journal/data/matron.db \
  npx matron-admin agent add <username> <dev-box-host>
# -> "agent <dev-box-host> token: <TOKEN>
#     (store in the bridge credentials file; it is not shown again)"
```

Capture `<TOKEN>` now — it is not recoverable. Move it to the box out-of-band.

**b. Install the token on the box — [BOX:&lt;dev-box-host&gt;].** Mode `600`,
under `~/.config/matron/` (never printed, never committed):

```
# [BOX:<dev-box-host>]
# paste the token at the hidden prompt and press Enter — read -rs keeps it
# out of shell history and off the terminal:
read -rs MATRON_AGENT_TOKEN
(umask 077; printf '%s\n' "$MATRON_AGENT_TOKEN" > ~/.config/matron/agent.<dev-box-host>.token)
unset MATRON_AGENT_TOKEN
# verify perms only (do NOT cat the file):
ls -l ~/.config/matron/agent.<dev-box-host>.token   # -> -rw------- (600)
```

(The token file is read once at bridge boot and trimmed — `.env.example` —
so the trailing newline is fine.)

**c. Point the bridge at the journal — [BOX:&lt;dev-box-host&gt;].** Edit the
bridge's `.env` (see `claude-matrix-bridge/.env.example` for the full set).
Set the journal client vars:

```
# ~/claude-matrix-bridge/.env  on [BOX:<dev-box-host>]
JOURNAL_WS_URL=wss://chat.example.com/ws
JOURNAL_TOKEN_FILE=/home/<owner>/.config/matron/agent.<dev-box-host>.token
JOURNAL_CURSOR_FILE=/home/<owner>/claude-matrix-bridge/journal-cursor.json
# optional; defaults to bridge-<hostname> if unset:
# JOURNAL_CONTROL_CONVO_ID=bridge-<dev-box-host>
```

Notes (all from `.env.example`):
- `JOURNAL_TOKEN_FILE` takes precedence over a raw `JOURNAL_TOKEN`; prefer the
  file so the secret never sits in `.env`.
- The media HTTP endpoint is **derived** from `JOURNAL_WS_URL`
  (`wss://` → `https://`, strip the trailing `/ws`) and reuses the same agent
  token — no extra var. So `wss://chat.example.com/ws` implies media at
  `https://chat.example.com`.
- `JOURNAL_CURSOR_FILE` defaults to `journal-cursor.json` in the bridge repo
  root; first connect with no cursor file is live-only (no history replay as
  input).
- Dual-post stays additive: leaving `JOURNAL_WS_URL` **or** the token unset
  disables journal publishing with zero effect on Matrix (§8).

**d. Restart the bridge — [BOX:&lt;dev-box-host&gt;].** The journal vars only
take effect on restart, and **restarting kills that box's active Claude
sessions** — coordinate with the owner first.

```
# [BOX:<dev-box-host>]
sudo systemctl restart claude-matrix-bridge.service
sudo systemctl status  claude-matrix-bridge.service
```

Then verify enrollment per §6.

---

## 4. Chef automation — PROPOSED (infra-repo `dev_server` cookbook)

**[CHEF] — this section is a proposal; the change lands in `infra-repo`,
not in this repo.** Goal: a rebuilt dev box comes up journal-ready without
hand enrollment.

The cookbook already provisions each box (role `dev_server`; host + attribute
data bags per `~/.claude/DEV-MACHINE-SETUP.md`; `./scripts/provision-server
<host> --update`). Propose adding, per box:

- Template the bridge journal env into `~/claude-matrix-bridge/.env`:
  `JOURNAL_WS_URL=wss://chat.example.com/ws`, `JOURNAL_TOKEN_FILE`,
  `JOURNAL_CURSOR_FILE`, optional `JOURNAL_CONTROL_CONVO_ID`.
- Place the per-box agent token at
  `~/.config/matron/agent.<dev-box-host>.token`, mode `600`, owner-only.

Secret mechanism: DEV-MACHINE-SETUP.md states host secrets (RDP password,
CircleCI token, tunnel credentials) live in the **encrypted `development`
credentials data bag**; separately, it notes the GitHub MCP token
(`GITHUB_PERSONAL_ACCESS_TOKEN`) is injected into a service by a **systemd
drop-in from `gh auth token`** — a locally-derived value, not a data-bag
secret. For the agent token, follow the data-bag pattern: store each box's
token in the encrypted credentials data bag and have the recipe render it to
the `600` token file (or a bridge systemd drop-in).

- **OPEN (Chef):** exact data-bag key layout for a per-host agent token, and
  whether the token is rendered to the file vs. injected as `JOURNAL_TOKEN`
  via a drop-in, are not determined by the sources here — decide in
  `infra-repo` review. Do **not** invent a key path.
- **OPEN (Chef):** token issuance is a stateful central-server action
  (`matron-admin agent add`, §3a) that returns a one-time token — Chef cannot
  mint it. Decide whether provisioning consumes a pre-issued token from the
  data bag (issued once by an operator) or triggers issuance out of band.

---

## 5. Client onboarding (Matron app)

Per teammate, on each client device (iOS / Mac). **Client-side.**

- Log in against `https://chat.example.com`: the app performs
  `POST /login {username, password, device_name}` →
  `{token, device_id, user_id}` (spec §8, README). One login screen per
  device; the device token is long-lived.
- On first login, change the initial password (§2, `POST /password`).
- Push registration: the app calls
  `POST /push/register {apns_token, environment}` (Bearer, **client devices
  only** — agents get 403). `environment` must be `"sandbox"` or `"prod"`
  (README).
  - **sandbox vs prod:** Xcode dev builds register **sandbox** tokens; prod
    APNs rejects those with 400 `BadDeviceToken`. The environment travels with
    the token — a TestFlight/App Store build registers `prod`, a local Xcode
    build registers `sandbox`. Mismatch shows up as a loud 400 in server logs
    (§9), not a dead token.
- Server-side APNs must be enabled for pushes to actually send (§9); if the
  four `MATRON_APNS_*` vars aren't set, registration succeeds but the pipeline
  is an inert no-op.

---

## 6. Verification checklist (per user / per box)

Run after each enrollment. Mix of **[CENTRAL]** and client checks.

- [ ] **Agent connected — [CENTRAL].** The box's agent appears with a moving
      cursor and recent `last_seen_at`:
      ```
      # [CENTRAL]
      cd /home/youruser/matron-journal
      MATRON_DB=/home/youruser/matron-journal/data/matron.db \
        npx matron-admin device list <username>
      # -> a line "kind=agent name=<dev-box-host> cursor=… last_seen_at=…"
      ```
- [ ] **Snapshot shows convos — client / [CENTRAL].** `GET /snapshot` (Bearer)
      returns `{conversations, seq}` with the user's sessions:
      ```
      curl -fsS https://chat.example.com/snapshot -H "Authorization: Bearer <token>"
      ```
- [ ] **WS `hello_ok` — client.** Opening `/ws` and sending
      `{op:'hello', token, cursor}` yields `hello_ok {seq}` (README, spec §6).
      In the Matron app this is a successful connect (no "connecting" spin).
- [ ] **Dual-post visible from a live session — [BOX] + client.** Start a
      Claude session on `<dev-box-host>`; the same traffic appears in Matrix
      (Element X) **and** in Matron. Confirms the bridge is publishing to both.
- [ ] **Read markers sync — client.** Read a conversation on one device; the
      unread badge clears on the user's other devices (`read_marker` journal
      row + badge-clearing background push, README/§9).
- [ ] **Push received — client.** With server APNs enabled (§9) and a device
      registered `prod`/`sandbox` correctly, a `prompt`/`permission_request`
      in a **not-currently-viewed** conversation delivers a notification.
- [ ] **Lag sane — [CENTRAL].** `matron-admin status` shows the device's
      `lag` near 0. `sockets_connected` only exists in the running server's
      memory — it is `/metrics`-only, never printed by `status` (README) —
      so check it incremented via the `/metrics` curl:
      ```
      # [CENTRAL]
      MATRON_DB=/home/youruser/matron-journal/data/matron.db npx matron-admin status
      curl -fsS http://127.0.0.1:9810/metrics -H "Authorization: Bearer <token>"   # -> sockets_connected
      ```

---

## 7. Cutover & Matrix retirement

Per-user, **no flag day** (spec §11 steps 4–5).

Criteria to end dual-post for a user (all must hold):
- [ ] Every one of the user's boxes enrolled and verified (§6) for a soak
      period on real traffic.
- [ ] The user's clients are on the Matron app (journal), not the Element X /
      Matrix client, for day-to-day use.
- [ ] `matron-admin status` shows their agents' `lag` steadily ~0.

Ordering:
1. Cut over willing single-box users first; Dan's multi-box setup last (most
   moving parts).
2. Only after the **last** user is off Matrix do you decommission tuwunel.
3. Matrix history stays readable in old clients until decommission — nothing is
   deleted at cutover.

What gets archived: Matrix history remains in tuwunel until decommission;
optional export of historic Matrix data into journal rows is a **nice-to-have,
not v1** (spec §11 step 5, §15).

tuwunel/sygnal decommission is **high-level here** — it lives in the tuwunel
fork's own repo (spec §13: "matron-server" is the tuwunel fork). This runbook
stops at "last user off; hand off to the tuwunel decommission procedure."

- **OPEN (cutover lever):** the bridge sources expose a journal **on/off**
  toggle (§8) but **no documented "journal-primary" input switch** and no
  documented way to disable the Matrix side (`MATRIX_HOMESERVER_URL` /
  `MATRIX_ACCESS_TOKEN` are required bridge config in `.env.example`). The
  concrete mechanism for flipping a box from dual-post to journal-only input
  (spec §11 step 4) is **not in these sources** — confirm with the bridge
  publisher-module work before scheduling cutover.

---

## 8. Rollback (disable journal on one box)

The journal side is additive during dual-post, so rollback is per-box and does
**not** touch Matrix (`.env.example`: "a journal outage never affects Matrix
behavior either way").

```
# [BOX:<dev-box-host>]  — edit ~/claude-matrix-bridge/.env
# comment out / remove the token (or JOURNAL_WS_URL); either one disables it:
# JOURNAL_TOKEN_FILE=
# JOURNAL_WS_URL=
sudo systemctl restart claude-matrix-bridge.service
```

- Takes effect on restart (restart kills active sessions — coordinate).
- Matrix output is unchanged; the box simply stops publishing to the journal.
- To confirm rollback **[CENTRAL]**: that box's agent `last_seen_at` in
  `device list` stops advancing.
- If you want the agent token gone entirely, revoke it (§9) after disabling.

---

## 9. Ops reference

**Service — [CENTRAL].**
```
sudo systemctl status matron-journal.service
sudo journalctl -u matron-journal.service -f
sudo systemctl restart matron-journal.service   # WAL-safe; clients auto-resume from cursor (spec §10)
```

**Metrics — [CENTRAL] or any client.** `GET /metrics` (Bearer, any valid
device) → JSON: per-caller-user `head_seq` and per-device
`{device_id, kind, cursor, lag, last_seen_at}`, plus global
`sockets_connected`, `journal_row_count`, `db_file_size_bytes`, and `push`
counters (README).
```
curl -fsS http://127.0.0.1:9810/metrics -H "Authorization: Bearer <token>"
# DB-derived subset without a token, straight from SQLite:
cd /home/youruser/matron-journal
MATRON_DB=/home/youruser/matron-journal/data/matron.db npx matron-admin status
```

**Device revocation — [CENTRAL].** `<device_id>` is the integer id from
`device list`. Deleting the row is the entire revocation: HTTP 401s on the next
call, WS is cut on the next frame or within ≤60s (README §Device revocation).
```
MATRON_DB=/home/youruser/matron-journal/data/matron.db npx matron-admin device list <username>
MATRON_DB=/home/youruser/matron-journal/data/matron.db npx matron-admin device revoke <device_id>
```

**Lost password reset — [CENTRAL].**
```
MATRON_DB=/home/youruser/matron-journal/data/matron.db npx matron-admin user passwd <username> --password '<new-password>'
```
Deliver out-of-band; note this does **not** revoke existing device tokens
(README) — revoke devices separately if the account is compromised.

**Retention / blob offload — [CENTRAL].** A scheduled job (boot, then every 6h)
offloads `tool_output` payloads older than `MATRON_RETENTION_DAYS` (default 30)
to blob files, leaving `{type, snippet, blob_ref}` in the row; journal rows are
never deleted (README §Retention, spec §5). Manual run:
```
MATRON_DB=/home/youruser/matron-journal/data/matron.db npx matron-admin offload [--days N]
```
`--days` must be a positive integer. `MATRON_RETENTION_DAYS=0` (or a
non-integer) disables the scheduled job.

**Backup — [CENTRAL].** Two things: the SQLite DB and the blob/media dir.
- DB: `MATRON_DB` = `/home/youruser/matron-journal/data/matron.db` (committed
  unit). WAL mode — back up with the DB stopped or via SQLite online backup, so
  the `-wal`/`-shm` sidecars are consistent.
- Blobs: `MATRON_MEDIA_DIR`, or its default `<dirname of the DB>/media`
  (README, `src/media.js`), i.e. `/home/youruser/matron-journal/data/media`
  by default. Offloaded payloads and uploads both live here.
  - **OPEN (backup):** confirm the effective media dir on the live host with
    `systemctl show matron-journal.service -p Environment` (do not read secret
    files). If a drop-in sets `MATRON_MEDIA_DIR`, back up that path instead.

---

## 10. Security invariants

- **Token & password files are `600`, owner-only, and never leave the box.**
  Agent tokens live at `~/.config/matron/agent.<dev-box-host>.token` (mode
  600); the central server's own secrets live under `~/.config/matron/`. Never
  `cat`, print, paste into chat, or commit any of them. Deliver initial
  passwords and agent tokens **out-of-band** (secret vault), never via chat or
  a repo.
- **Agent tokens are per-box and revocable.** One token per `<dev-box-host>`,
  scoped to its owner's journal; agents can only publish/stream to their own
  user's conversations and **cannot log in as the user** (spec §8). Revoke a
  lost/retired box's token immediately (§9); revocation is next-frame or ≤60s
  on WS, next-request on HTTP.
- **TLS-only public edge.** The only public exposure is
  `https://chat.example.com` via the Cloudflare tunnel; the server itself
  binds `127.0.0.1:9810` (committed unit) and is not otherwise reachable
  (dev-box UFW opens only SSH + RDP).
- **No Cloudflare Access on the chat hostname — by design.** CF Access is
  cookie-based and hostile to native clients, WebSockets, and headless agents
  (spec §8 "Explicitly rejected"). Auth is first-party: passwords mint device
  tokens; bridges use agent tokens. Do **not** add an Access policy to
  `chat.example.com`.
- **Least-privilege metrics.** `/metrics` scopes the `user` section to the
  caller's own devices only; the rest are bare global aggregates (README).
