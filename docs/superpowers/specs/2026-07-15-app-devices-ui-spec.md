# Devices screen & agent pairing — app implementation spec

**Date:** 2026-07-15
**Status:** ready to build — every endpoint below is merged and live on
https://chat.yearbooks.be
**Audience:** matron-apple / matron-web implementers (SP2 client work)
**Server spec:** `2026-07-15-app-managed-agent-enrollment-design.md`
**API reference:** `docs/protocol.md` (authoritative if this doc ever drifts)

This is everything the app needs to ship the Devices screen and the
"Add agent" pairing flow. The server side is complete; nothing here is
speculative. A follow-up spec will add the SP2 journal ops (`app-start`,
`recent-folders`) — they are independent of this screen and should not block
it.

## What you are building

1. **Devices screen** — a roster of the signed-in user's devices (clients and
   agents) with per-device revoke.
2. **"Add agent" flow** — one modal: enter pairing code → preview shows who is
   asking → name the agent → approve → wait for the box to connect.

One screen + one modal. No rename, no admin views, no other-user visibility —
the server has none of those concepts in v1.

## Auth context

All authenticated calls use the bearer token the app already holds from
`POST /login`. Every endpoint in this doc is **client-devices-only** on the
server side; the app is always a client device, so a 403 `forbidden` here
means a bug (or an agent token pasted into the app), not a state to design
for. 401 means the device was revoked or the token is bad → route to login,
same as everywhere else.

Error envelope everywhere: HTTP status + `{ "error": "snake_case_code" }`.

## 1. Devices roster

```
GET /devices            (Bearer)
-> 200 { "devices": [ { "device_id": 7,
                        "kind": "client" | "agent",
                        "name": "dan-mac",
                        "created_at": 1784000000000,
                        "cursor": 5123,
                        "lag": 0,
                        "last_seen_at": 1784500000000 | null,
                        "is_self": true } ] }
```

- Scoped to the signed-in user. Order is not guaranteed — sort client-side
  (suggest: clients first, then agents, each newest-first).
- `is_self` marks the device making the request → badge it "This device".
- `last_seen_at` is null for a device that has **never** connected (e.g. an
  agent enrolled but whose box hasn't come online). Render as "never".
- `lag` = user's head seq − device cursor: how far behind that device's
  journal sync is. 0 → "up to date"; render large values as "N events
  behind". `cursor` itself is diagnostic; showing it is optional.
- Timestamps are epoch **milliseconds**.
- Pull-based; device changes are not journal events. Refresh on screen enter
  and after every mutation (revoke/approve-claim). No push/WS signal exists
  for roster changes in v1.

## 2. Revoke a device

```
POST /devices/:id/revoke   (Bearer, empty or {} body)
-> 200 { "ok": true }        revoked; the row is gone
-> 404 { "error": "not_found" }   unknown id OR not your device (indistinguishable)
```

- Revocation is immediate and permanent: the device's next HTTP call gets
  401 and its WebSocket is closed within ≤60s (next-frame or sweep). There
  is no undo — re-enrollment is the recovery path. The confirm dialog is
  the app's job; the server asks no questions.
- **Self-revocation is allowed and is a logout.** If `is_self`, change the
  copy: "Sign out this device?" — and on 200, drop local credentials and
  return to login.
- After a 200, remove the row optimistically or re-fetch `GET /devices`.
- A 404 on a device you just listed means it was already revoked elsewhere —
  treat as success and re-fetch.

## 3. "Add agent" pairing flow

The counterpart runs on a headless box: it calls `pair/start`, displays an
8-character code, and polls for its token. The app's job is the **approval**
side. Full flow the user experiences:

```
box terminal shows:  KTNM-3VQ8        (expires in 10:00)
        │
        ▼
app: [Add agent] → enter code → preview → name it → approve
        │
        ▼
box claims its token automatically and connects; agent appears in roster
```

### 3a. Code entry

- Codes are 8 characters from a no-lookalike alphabet — Crockford base32
  minus vowels: `0123456789BCDFGHJKMNPQRSTVWXYZ` — displayed by the box as
  `XXXX-XXXX`.
- The server normalizes before lookup: uppercases and strips every
  non-alphanumeric. So accept sloppy input (lowercase, spaces, missing
  hyphen) and don't block submission on format; optionally auto-format the
  field as `XXXX-XXXX` while typing.
- v1 is **type-only**: no QR/deep-link scanning (explicit design decision;
  revisit with SP5).

### 3b. Preview — show who is asking (required step)

```
POST /pair/preview  { "pair_code": "KTNM-3VQ8" }   (Bearer)
-> 200 { "requester_ip": "65.108.10.252", "expires_in": 412 }
-> 404 { "error": "not_found" }
```

- Call this as soon as a plausible code is entered, **before** offering the
  approve button. This is a security requirement from the design spec, not a
  nicety: approving binds the new agent to *your* user, and the classic
  device-flow phish is "approve this code for me". The approval screen must
  show the requesting IP so the user can recognize their own box.
- Suggested copy: *"A device at **65.108.10.252** is asking to connect as an
  agent on your account. Only approve if this is your machine — check the
  code on its terminal."*
- `expires_in` is seconds of TTL remaining (pairs live 10 minutes). Show a
  countdown; on expiry, disable approve and ask for a fresh code.
- 404 means unknown, expired, **or already approved** — deliberately
  indistinguishable. Copy: "Code not recognized or expired. Get a fresh code
  from the box and try again."
- Read-only and repeatable; safe to call on every code-field change
  (debounced — it shares no rate limit with login, but be polite).

### 3c. Name it and approve

```
POST /pair/approve  { "pair_code": "KTNM-3VQ8", "agent_name": "dev-7" }   (Bearer)
-> 200 { "status": "approved" }
-> 404 { "error": "not_found" }   unknown/expired (same copy as preview 404)
-> 409 { "error": "conflict" }    this code was already approved
-> 400 { "error": "bad_request" } missing/empty code or agent_name
```

- `agent_name` is chosen by the approving user in this modal — convention is
  the box's short hostname (`dev-7`, `dan-mac`). It becomes the `name` in the
  roster and is not renameable later; say so next to the field.
- Exactly-once: a 409 means someone (you, on another device?) already
  approved this code. Copy: "This code was already approved."
- Approval does **not** create the device. Nothing appears in the roster
  until the box claims its token (it polls every few seconds, so normally
  ~instant — but if the box died, nothing ever appears and the pair simply
  expires with zero residue).

### 3d. Waiting for the box

After a 200 from approve, show a "waiting for agent to connect" state and
poll `GET /devices` (every 2–3s, capped at the pair's remaining TTL) until a
device with `kind: "agent"` and the chosen name appears — then success. If
the TTL runs out first: "The box never collected its token. Start again with
a fresh code." Make the wait dismissible; the roster will show the agent
whenever it lands.

Note the regret window: between approve and claim there is nothing to revoke
(no device row exists yet). Once the agent appears, revoke works instantly.
Don't build an "un-approve" — it doesn't exist server-side (accepted v1
trade-off, ≤10-minute exposure).

## Errors summary (all four endpoints)

| Status | code           | Meaning / app action |
|--------|----------------|----------------------|
| 400    | `bad_request`  | Malformed body — app bug, fix the request |
| 401    | `unauthenticated` | Token bad or device revoked → to login |
| 403    | `forbidden`    | Agent-kind token — never legitimate in the app |
| 404    | `not_found`    | Unknown/expired/not-yours — generic "not recognized" copy |
| 409    | `conflict`     | approve only: already approved |
| 429    | `rate_limited` | not expected on these Bearer calls; back off politely |

## Testing against the live server

The server is deployed; you can integration-test today with any client
bearer token:

```sh
TOK=...   # a client device token
B=https://chat.yearbooks.be

curl -s $B/devices -H "Authorization: Bearer $TOK" | jq .

# fake a box: start a pair, then preview/approve it from the app side
curl -s -X POST $B/pair/start -d '{}' | jq .        # note pair_code
curl -s -X POST $B/pair/preview -H "Authorization: Bearer $TOK" \
     -d '{"pair_code":"<code>"}' | jq .
curl -s -X POST $B/pair/approve -H "Authorization: Bearer $TOK" \
     -d '{"pair_code":"<code>","agent_name":"test-agent"}' | jq .
curl -s -X POST $B/pair/claim -d '{"poll_token":"<poll_token>"}' | jq .
# ^ claim mints the device; it now shows in /devices — revoke it to clean up
```

`pair/start` is per-IP rate-limited (shared budget with `/login`, 5/min) —
don't hammer it from CI.

## Out of scope here (coming in the SP2 ops spec)

- `app-start` (structured "start a session in this folder" op) and
  `recent-folders` — being specced now; will arrive as a separate app spec
  section once the journal side merges.
- Roster entries for *connectivity* (which agents are online right now) —
  v1 approximates with `last_seen_at`/`lag`; a live presence signal is a
  later protocol addition if needed.
