# App-managed agent enrollment & device management — design

**Date:** 2026-07-15
**Status:** draft — awaiting review
**Depends on:** protocol v1 (`docs/protocol.md`), SP2 (client-API: connected-servers roster)

## Problem

Agents (bridges) are devices under a person's own journal user. Today the only
way to mint one is an operator on the journal host running
`matron-admin agent add <user> <host>`, then hand-carrying the one-time token
to the target box (`docs/runbooks/team-rollout.md` §3a). The runbook itself
flags the gap (line 217): the token can't be minted by config management, and
delivery needs an out-of-band secret channel every time.

The Matron app is already authenticated as the user. Managing the user's own
devices from the app rides the token the app already holds — no new
unauthenticated management surface on an internet-facing service
(chat.yearbooks.be sits behind no Cloudflare Access; the journal's own auth is
the only guard).

## Goals

1. A user can see all their devices (clients and agents) in the app: kind,
   name, created, cursor lag, last seen.
2. A user can revoke any of their devices from the app.
3. A user can enroll an agent on a headless box without any human ever seeing
   the token (device-authorization pairing, `gh auth login` style).
4. The only new unauthenticated surface is the pairing bootstrap, which grants
   nothing until an authenticated client approves a specific code.

## Non-goals

- Self-serve user registration. Users are created by an operator via
  `matron-admin user add` — deliberate; population is a handful of people and
  an open registration endpoint is pure attack surface.
- Admin/multi-user management. v1 has no admin concept; everything here is
  scoped to the caller's own user.
- Email of any kind.
- Device rename. Names are set at creation; YAGNI.

## Alternatives considered

- **Status quo (operator + hand-carried token).** Works — it onboarded every
  current agent — but every new box needs an operator on dev-2 plus a secure
  side-channel. Rejected as the long-term path.
- **Standalone web portal (register → email confirm → manage agents).**
  Duplicates auth, adds an unauthenticated public registration endpoint, and
  builds a second UI stack for three users. Rejected.
- **App-managed with device-authorization pairing.** Chosen. New surface is
  minimal, the approval rides existing client auth, and it is the natural
  write-side of the SP2 connected-servers roster.

## Design

Three additions to the journal HTTP API, one app screen, one CLI consumer.
All error envelopes follow existing conventions: `{error: 'snake_case'}` with
400 `bad_request`, 403 `forbidden`, 404 `not_found`, 429 `rate_limited`.

### 1. Device roster — `GET /devices`

Bearer, **client devices only** (agents get 403 `forbidden`, same gating as
`POST /password` and `POST /push/register`).

```
GET /devices ->
{ devices: [ { device_id, kind, name, created_at,
               cursor, lag, last_seen_at, is_self } ] }
```

Scoped to the caller's user. `is_self` marks the requesting device so the UI
can badge "this device" and warn before self-revocation. This deliberately
overlaps `GET /metrics`' `user.devices` block; metrics stays as-is (it is an
observability endpoint, has no `name`, and is reachable by agents).

### 2. Device revocation — `POST /devices/:id/revoke`

Bearer, client devices only. Deletes the `devices` row — deleting the row IS
the revocation (protocol.md "Device revocation" section applies unchanged:
live sockets for that device are closed). Revoking a device not owned by the
caller and revoking a nonexistent id are indistinguishable: both 404
`not_found`. Self-revocation is allowed (it is a logout); confirming is the
client's job.

`matron-admin device revoke` keeps working as the operator fallback.

### 3. Agent pairing — device-authorization flow

New box side (unauthenticated), app side (authenticated):

```
POST /pair/start   {}                          (unauthenticated, rate-limited per IP)
  -> { pair_code, poll_token, expires_in }

POST /pair/approve { pair_code, agent_name }   (Bearer, client devices only)
  -> { status: 'approved' }

POST /pair/preview { pair_code }               (Bearer, client devices only)
  -> { requester_ip, expires_in }               # pending pairs only — the approval screen's "who is asking"

POST /pair/claim   { poll_token }              (unauthenticated)
  -> { status: 'pending' }
   | { status: 'approved', token, device_id }   # exactly once, then the pair is deleted
```

- `pair_code`: 8 chars from a no-lookalike alphabet (Crockford base32 minus
  vowels), grouped `XXXX-XXXX`, displayed by the box for the human to type or
  scan into the app. ~40 bits.
- `poll_token`: 32 random bytes hex — the claim secret. Never displayed.
- Pending pairs live in an **in-memory map** with a 10-minute TTL, lazy
  expiry. No DB table: a server restart dropping pending pairs is acceptable
  (the box CLI just retries with a fresh code).
- **The `devices` row is minted at CLAIM time, not approve time.** Approve
  only transitions the pair `pending → approved`, recording the approving
  caller's `user_id` and the `agent_name`; `pair/claim` then calls the
  existing `issueDevice(db, userId, 'agent', name)` and returns the token in
  the same response, atomically deleting the pair. Consequences, all
  deliberate: an approved-but-never-claimed pair (box died, TTL expiry,
  server restart) leaves **zero DB residue** — no orphan agent rows in
  `GET /devices` with unrecoverable tokens; the agent appears in the roster
  only once a box actually holds its token, which is when "connected server"
  starts being true.
- A pair can be approved **exactly once**: `pair/approve` on an
  already-approved pair returns 409 `conflict` (the caller is authenticated,
  so distinguishing this from 404 leaks nothing exploitable); unknown or
  expired codes are 404 `not_found` (indistinguishable, anti-enumeration as
  elsewhere). The code itself names no user — approval binds the pair to
  the approving caller's user_id.
- `/pair/start` is rate-limited per IP through the existing `rateLimiter`
  (same budget class as `/login`), and the pending map is capped (e.g. 64
  outstanding pairs) — start returns 429 `rate_limited` beyond either limit.
- `pair/start` records the requester's IP on the pending pair;
  `pair/preview` returns it (with the remaining TTL) so the approval screen
  can show who is asking before the user approves. Unknown, expired, and
  already-approved codes are indistinguishable 404s — an approved pair can't
  be approved again, so there is nothing left to preview.
- `/pair/claim` returns the token exactly once and deletes the pair;
  a second claim is 404. Unknown/expired poll_token: 404.

**Security analysis.** `pair/start` grants nothing and stores nothing durable;
nothing durable exists anywhere until claim. A guessed or phished `pair_code`
becomes an agent only if a real user approves it in the app, and it becomes an
agent **of the approving user** — so the approval screen must show the code
and the requesting IP (the app fetches the IP via `pair/preview` before
approving), and the human types the code they can see on their own box's
terminal. Token exfiltration requires the 256-bit `poll_token`, which
transits only TLS responses. The residual risk is the classic device-flow
phish ("approve this code for me") — mitigated by approval-screen wording
(agent name + requester IP), acceptable for a first-party population of three.
An approval the user regrets cannot be un-approved (there is no device to
revoke until the box claims); the exposure is bounded by the pair TTL, and the
moment the box claims, the agent appears in the roster and is revocable
instantly. This regret window (≤10 minutes) is accepted in v1.

### 4. Consumers

- **App (SP2 fold-in):** one Devices screen — roster list (the read side SP2
  already plans), revoke action, and "Add agent": enter/scan code → name it →
  approve. One screen + one modal in matron-apple and matron-web.
- **Box CLI (SP3/SP4):** `matron-agent enroll --server https://chat.yearbooks.be`
  calls `pair/start`, prints the code (and a `matron://pair?code=…` deep
  link/QR), polls `claim`, writes `~/.config/matron/agent.<host>.token`
  mode 600, and exits. Lives with the bridge/dev-boxer, not this repo; this
  spec defines only the journal endpoints.
- **matron-admin:** unchanged, remains the only way to create users and the
  operator fallback for agent minting and revocation.

## Testing

Conformance-style tests alongside the existing suite (`:memory:` DBs):

- happy path: start → approve → claim returns token once → agent connects
  over ws with it; the device row does not exist before the claim
- claim before approve → `pending`; claim twice → second is 404
- expiry: claim/approve after TTL → 404; an approved-but-unclaimed pair that
  expires leaves no `devices` row (no orphans in `GET /devices`)
- approve twice with the same code → second is 409 `conflict`, and exactly
  one device row exists after the eventual claim
- approve with an **agent**-kind bearer → 403; approve with unknown code → 404
- preview on a pending pair returns the requester IP recorded at start and
  the remaining TTL; unknown, expired, and already-approved codes → 404;
  agent bearer → 403; unauthenticated → 401; bad bodies → 400
- start beyond the per-IP rate limit / pending-map cap → 429
- `GET /devices` as agent → 403; roster shows `is_self` correctly
- revoke: not-owned id → 404; own device → row gone, live socket closed;
  self-revocation works
- regression: `/metrics` output unchanged

## Rollout

1. Journal endpoints + tests (this repo) — no client dependency, ships alone.
2. `protocol.md` gains a "Device management & pairing" section in the same PR.
3. App UI folds into SP2's roster work (read + write in one screen).
4. Enroll CLI lands with SP3/SP4.

Today's manual onboarding of alex and zahra (runbook path) is unaffected;
this replaces the manual path for future boxes and future devices.

## Open questions

1. QR/deep-link in the v1 app UI, or typing the code only? (Recommend: type
   only in v1; QR when SP5's device story lands.)
2. Should `pair/approve` require fresh re-auth (password confirm) rather than
   just a valid client token? (Recommend: no for v1 — population of three,
   revocation is instant.)
