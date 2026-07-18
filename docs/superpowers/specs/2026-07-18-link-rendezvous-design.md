# Link Rendezvous — reverse QR sign-in via the relay

**Date:** 2026-07-18
**Status:** Approved (design review with Dan, this session)
**Depends on:** QR device-link login (`2026-07-18-qr-device-link-login-design.md`, shipped in journal #28, apple #70, android #3)

## Problem

The shipped link flow requires the signed-out device to *scan* (or type) a
code shown by a signed-in device. A signed-out **desktop** can't scan, and
typing a server URL + code is the friction this feature family exists to
remove. A brand-new install also has no configuration, so it cannot ask "its"
journal for anything — it doesn't know which journal is its own.

Additionally, dev-boxer's initial provisioning should end with a QR on the
terminal that signs the first phone in, with nothing typed on the phone.

## Solution shape

Two independent additions that share the shipped claim flow:

1. **Rendezvous on the relay** (reverse direction, for signed-out devices
   that can't scan): the signed-out device asks the shared relay for a
   rendezvous ID, shows it as a QR, and polls. A signed-in phone scans it,
   mints a link code on *its own* journal (`linkStart`), and posts
   `{server, code}` to the relay. The signed-out device picks that up and
   runs the existing claim → approve → token flow directly against the
   journal. The relay never carries a token — only the same two values the
   shipped QR displays on screen.
2. **Pre-approved link codes** (for dev-boxer): root on the box mints a
   link code that is born approved; the phone scans it with the ordinary
   claimant flow and skips the waiting-for-approval state.

The confirm-tap on the signed-in phone remains the only credential-granting
gate for the rendezvous direction. For pre-approved codes the granting
authority is root on the box, which already owns the DB.

## 1. Relay rendezvous protocol

Lives in the existing push-relay process (`src/relay.js`'s HTTP server, same
`bin/matron-push-relay.js` binary and systemd unit, served at
`push.matron.chat`). Three endpoints join `/push`:

### `POST /link/rendezvous`

Called by the signed-out device. Response `201 { rid, secret, expires_in }`.

- `rid`: 26 chars from the pairing alphabet (`0123456789BCDFGHJKMNPQRSTVWXYZ`,
  ~128 bits, unguessable, no lookalike glyphs). Key of the entry.
- `secret`: 256-bit hex poll token. Returned only to the creator; never in
  the QR.
- Entry: in-memory Map, **TTL 3 minutes**, swept on the relay's existing
  sweep cadence. `maxPending` cap (256) on live entries.
- QR payload rendered by the device: `matron://rlink?v=1&rid=<rid>`.

### `POST /link/rendezvous/:rid/offer`

Called by the scanning phone. Body `{ server, code }`.

- `server`: validated https URL, length-capped (≤200), normalized with the
  same rules the apps' `ServerURLValidator` applies.
- `code`: 8 chars of the pairing alphabet (normalized before validation).
- First offer wins → `204`. Second offer → `409`. Unknown/expired rid →
  `404`. Body over limit / unknown fields / bad values → `400` with a
  machine reason that never echoes caller values (push-relay convention).
- The phone knows only the rid (from the QR), never the secret — a
  bystander photographing the desktop's QR cannot read the offer back.

### `GET /link/rendezvous/:rid?secret=<secret>`

The creator's poll (every 2 s).

- `204` while waiting; `200 { server, code }` once offered; `404` after TTL
  or unknown rid; `403` on secret mismatch (constant-time compare).
- The entry survives until TTL rather than dying on first read, so a
  dropped poll response can be retried.

### Abuse and privacy

- Rendezvous creation is the new unauthenticated surface: per-IP token
  bucket plus global ceiling, reusing `makeRelayLimiter`'s two-bucket shape
  tuned for this traffic (per-IP burst 10, refill 1 per 30 s; global burst
  100, refill 1 per 100 ms — far above legitimate volume, since one sign-in
  needs exactly one creation). Offers and polls are bounded by rid
  existence plus the same global ceiling.
- Structural privacy, as with pushes: the wire protocol has no field that
  can carry an account name, token, or message content. The relay holds at
  most `{server URL, link code}` for ≤3 minutes in memory. Nothing
  caller-controlled is logged.
- The relay stays stateless across restarts; a restart forgets pending
  rendezvous and the devices regenerate, mirroring link-session behavior.

### Implementation notes (2026-07-18)

Two deliberate deviations from the letter of this spec, both in the shipped
`src/relay.js`:

- Oversized offer bodies return `413`, not `400` — the relay's existing
  body-size guard (shared with the push endpoints) responds `413` before the
  body is even parsed, which is the established relay convention for
  over-limit requests.
- The offer's `server` value is validated (https any host, http
  localhost-only, ≤200 chars) but stored and echoed back verbatim, not
  re-normalized — the scanning phone already sends its session's normalized
  homeserver URL, so re-normalizing on the relay would only risk disagreeing
  with the value the phone itself is using.
- Bugbot hardening (PR #29, 2026-07-18): `POST /link/preapprove`'s loopback
  + no-forwarding-header guard alone is defeated by a headerless reverse
  proxy (a default nginx `proxy_pass` with no `proxy_set_header` lines adds
  none of those headers, so external traffic can look identical to a local
  call). Added a second, independent factor: a 64-hex-char key the journal
  auto-mints next to its DB file on first boot (`preapprove-key.js`) and
  requires as `x-preapprove-key` on every call; `matron-admin link-code`
  reads the same file and sends it. This spec's "no new secret to
  provision" still holds — the key is minted automatically, never
  operator-configured.

## 2. App flows

Relay base URL is a hardcoded constant (`https://push.matron.chat`) in all
three apps; forks change the constant (no UI override).

### Signed-out sign-in screen (Mac, iOS, Android) — tabbed QR area

- **Scan** (default on phones; absent on Mac): the existing claimant
  camera, unchanged. Accepts `matron://link` QRs — including dev-boxer's
  pre-approved ones, which are indistinguishable to the app. Manual
  server + code entry remains beneath as fallback.
- **Show** (default and only tab on Mac): calls the relay, renders the
  `matron://rlink` QR, caption "Scan this with a phone that's signed in to
  Matron", polls every 2 s. On `{server, code}`: display "Connecting to
  <server host>…" and feed the existing claim path — identical to a scan
  of that server + code. Rendezvous expiry silently regenerates the QR
  (mirror of the show-side's link-expiry regeneration). Relay unreachable →
  retryable error notice; Scan/manual paths never touch the relay.
- New small view model per codebase (shared in `MatronShared` for
  Mac/iOS): wraps rendezvous create/poll, then delegates to the existing
  link sign-in view model. Generation-guarded against post-cancel races
  like all its siblings (stop() bumps a monotonic counter; every
  post-suspension branch re-checks it before state writes).

### Signed-in Settings → "Link a Device" (iOS, Android) — mirrored tabs

- **Show** (default): the existing QR screen, unchanged.
- **Scan** (new): camera accepting `matron://rlink`. On scan: call
  `linkStart` on the phone's own journal, POST `{server: session
  homeserver URL, code}` to the relay offer endpoint, then land on the
  existing waiting/approve screen. The desktop claims within seconds; the
  approve card shows its device name and IP as today.
- Approve-card copy sharpened (all platforms): "This signs a computer into
  **your** account — only approve if it's yours, in front of you."
- Unknown `rlink` version → existing "needs a newer version of Matron"
  copy. Offer POST failure → notice; the minted link session expires
  server-side in 2 minutes.

## 3. Pre-approved link codes (dev-boxer)

### Journal

- `makeLinkStore` gains `startPreapproved(userId)`: session under a
  synthetic starter key (`preapproved:<random>`), flag `preapproved: true`,
  **TTL 10 minutes** (pairing-store pacing). `claim()` on a preapproved
  session jumps straight to `approved` and mints the claim token, so the
  claimant's first poll returns the device token. No approve card — at
  provisioning time there is no other device.
- `POST /link/preapprove` `{ username }` → `{ link_code, expires_in }`.
  Accepted **only** when the socket remote address is loopback **and** no
  `X-Forwarded-*` header is present (external traffic always arrives via
  the reverse proxy, which adds them). No new secret to provision.

### matron-admin

- `matron-admin link-code <username> --server-url https://…`: calls
  `127.0.0.1:<port>/link/preapprove`, prints the `XXXX-XXXX` code, and
  renders `matron://link?v=1&server=…&code=…` as an ANSI QR via
  `qrcode-terminal` (zero-dependency, MIT).

### dev-boxer

- Final provisioning step (after user creation, journal up): run
  `matron-admin link-code` with the configured domain; print the QR plus a
  manual fallback line ("or enter server + code on the sign-in screen").

### Risk shape

The printed code is a one-shot, 10-minute, ~39-bit bearer credential for
that user, displayed only on the root terminal of the box being
provisioned — equivalent trust to what that terminal already has (it owns
the DB). First claim wins; later claimants learn only that the code is gone.

## 4. Threat model (residual risks, named)

1. **QRLjacking** (victim scans an attacker's rendezvous QR): the victim's
   approve card shows the attacker's device name and IP with the sharpened
   copy; codes are one-shot with short TTLs. The tap remains the gate.
2. **Compromised relay** could hand the desktop `{server, code}` for an
   attacker's journal, signing the desktop into the wrong account. No
   structural fix exists (the relay is trusted for exactly this datum);
   mitigation is transparency — the desktop shows the server host before
   claiming and keeps it visible while waiting.
3. **Relay abuse** (flood of rendezvous creation): two-bucket rate
   limiting, maxPending cap, tiny bodies, memory-only state.

## 5. Testing

TDD throughout (red-green per change).

- **Journal/relay** (`node:test`): rendezvous store TTL/one-shot/secret
  gating (constant-time), limiter behavior, offer validation, preapprove
  guard (loopback-only, rejects `X-Forwarded-*`), preapproved claim path
  returning the token on first poll.
- **Apps**: view-model unit tests against fakes — rendezvous create/poll →
  delegate to claim; regeneration on expiry; post-cancel race guards using
  the NonCancellable-gated fake pattern (Android) / its Swift equivalent
  established in the link feature.
- **dev-boxer**: smoke test minting + claiming against a local journal.

## 6. Rollout

1. Journal PR: relay rendezvous + preapprove + `matron-admin link-code`.
2. Apple PR: tabs, rendezvous VM, approve-copy.
3. Android PR: same.
4. dev-boxer PR: provisioning step.

Each non-draft with the bugbot review loop. The previous feature's journal
changes are still undeployed; this lands behind them, so one deploy ships
both.
