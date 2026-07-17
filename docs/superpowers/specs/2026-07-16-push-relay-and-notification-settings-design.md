# Push relay + notification settings — design

**Date:** 2026-07-16
**Status:** approved in conversation (Dan), pending spec review
**Repos touched:** matron-journal (v1), matron-apple (v2)

## Context

Matron is bring-your-own-server: everyone except Dan runs their own journal
server, and only Dan holds the APNs key for the `chat.matron.app` bundle ID.
Self-hosted journals therefore cannot push at all today. The fix is the one
piece of shared infrastructure Matron will ever run: a stateless push relay
at `push.matron.chat` that holds the APNs key and forwards notifications on
behalf of self-hosted journals.

Hard privacy requirement (matron.chat privacy policy says "we receive
nothing"): the relay must never see message content. This design makes that
**structural** — the relay wire protocol has no field that could carry a
title, body, or conversation name.

External-tester constraint: v1 must work with the TestFlight build already
on devices (build 290). The current MatronNSE is a payload passthrough, so a
relay that sends generic alert text works with zero app changes. Rich
content for relay users (NSE fetch) is v2.

## Phasing

- **v1 (matron-journal only, ships now):** relay service + gateway client in
  the journal + notification-prefs enforcement server-side.
- **v2 (matron-apple, next TestFlight build):** Settings UI for notification
  prefs + NSE fetch so relay-delivered alerts show real snippets.
- Explicitly out of scope: per-conversation mute (tier B — add when a real
  user asks), quiet hours (iOS Focus does this), payload encryption, any
  relay persistence.

## Component 1 — relay service (`push.matron.chat`)

Lives in the matron-journal repo (it reuses `makeApnsClient` verbatim):
`src/relay.js` + entry point `bin/matron-push-relay.js`. Separate process
from the journal — Dan's journal keeps pushing via direct APNs and never
routes through the relay.

**Endpoint:** `POST /push`, JSON body:

```json
{
  "device_token": "hex",
  "env": "prod" | "sandbox",
  "category": "attention" | "done" | "activity" | "wake",
  "badge": 3,
  "thread_id": "convo-id",
  "collapse_id": "convo-id",
  "priority": 10,
  "push_type": "alert" | "background"
}
```

`badge`, `thread_id`, `collapse_id` optional; everything else required.
Unknown fields → 400. There is deliberately no title/body/snippet field.

**Payload construction (relay-side, fixed strings):**

| category  | aps payload |
|-----------|-------------|
| attention | alert `{title: "Matron", body: "Your agent needs you"}`, `mutable-content: 1` |
| done      | alert `{title: "Matron", body: "Session finished"}`, `mutable-content: 1` |
| activity  | alert `{title: "Matron", body: "New activity from your agent"}`, `mutable-content: 1` |
| wake      | `{"content-available": 1}` (background) |

`mutable-content: 1` is set now so the v2 NSE fetch enriches these without
any relay change. `thread-id`, `apns-collapse-id`, `apns-priority`,
`apns-push-type` pass through from the request.

**Response:** mirrors the APNs result as `{status, reason}` with the HTTP
status set to the APNs status (200/410/400/…), so the journal's existing
`handleResult` logic (410 → prune token, 400 → env-mismatch warning) works
against the relay unchanged.

**Abuse controls** (the relay is an open endpoint by design — a self-hosted
journal can't pre-register):

- Device tokens are unguessable 32-byte values known only to the user's own
  journal — possession is the credential.
- Per-device-token token bucket: burst 20, refill 1 per 10s, 429 when empty.
- Global (token-independent) ceiling: burst 200, refill 1 per 20ms (50/s sustained), 429 when empty — bounds APNs-bound traffic under a spray of fabricated unique tokens, which the per-token bucket cannot stop.
  Journal-side coalescing keeps legitimate traffic far below this.
- Body limit 1 KB, JSON only, strict field validation.
- No logging of tokens beyond a truncated prefix; no request bodies logged.

**Config:** the same `MATRON_APNS_*` four vars as the journal, plus
`MATRON_RELAY_PORT` / `MATRON_RELAY_BIND` (default 127.0.0.1). Stateless:
in-memory rate buckets only, safe to restart anytime.

**Deploy:** Dan's journal box, behind the existing cloudflared tunnel — new
ingress `push.matron.chat → 127.0.0.1:<port>` + `cloudflared tunnel route
dns <tunnel> push.matron.chat`.

## Component 2 — gateway client in the journal

`src/gateway.js`: `makeGatewayClient({ url, fetchImpl })` implementing the
exact `makeApnsClient` contract — `send(opts) → Promise<{status, reason}>`,
never rejects, resolves `{status: 0, reason: 'transport'|'timeout'}` on
failure; `close()` is a no-op. Injected into `makePushPipeline` in place of
the APNs client, so `push.js` needs almost no changes.

`send()` serializes **only** the content-free fields listed above. The full
`payload.aps.alert` built by `push.js` stays in-process and is dropped —
content never crosses the wire.

**`push.js` change (the one real edit):** `classify()` gains a `kind` field
(`'attention'` for prompt/permission_request, `'done'` for a turn-finished
session_status transition — previous state running moving to waiting or
done; every other transition, notably waiting -> done teardown, is silent —
`'activity'` for routine), threaded through `buildOpts` as `category`; the
read_marker branch passes `category: 'wake'`. The direct APNs client
ignores the extra field.

**`server.js` selection order** in `resolveApnsClient()`:

1. All four `MATRON_APNS_*` set → direct APNs (Dan; full-content alerts,
   behavior unchanged).
2. Else `MATRON_PUSH_GATEWAY_URL` set → gateway client (self-hosters).
3. Else → push disabled (current warn log, mentions both options).

## Component 3 — notification settings

**Journal (v1):** `devices` gains `push_prefs TEXT` (JSON
`{"attention": bool, "done": bool, "activity": bool}`, NULL = defaults —
attention and done on, activity off),
added via the same in-place ALTER pattern as `apns_env`. Enforced in the
`onAppend` device loop: skip the device when its prefs disable the event's
category. `wake` pushes (read_marker badge sync) are invisible to the user
and never filtered.

**HTTP API (v1):** alongside the existing `POST /push/register`:
`PUT /push/prefs` (body = the three booleans, partial updates merge) and
prefs echoed in the device's own registration/devices responses per existing
http.js conventions. Prefs are per-device, matching where the APNs token
lives.

**Apps (v2):** Settings → Notifications section on iPhone and Mac — three
toggles ("Needs your input", "Session finished", "Agent activity") — plus
`JournalAPI` get/set methods. Defaults match the server: "Needs your input"
and "Session finished" on, "Agent activity" off.

## Component 4 — NSE content fetch (v2, matron-apple)

Relay alerts arrive with `mutable-content: 1`, a generic body, and
`thread-id` = convo id. MatronNSE (today a passthrough) will: load the
journal session from the app-group container, fetch the latest snippet for
that conversation from the **user's own** journal over HTTPS (new
lightweight authed `GET /convos/<id>/snippet` returning `{title, snippet}`
— the snapshot endpoint returns every conversation and is too heavy for an
NSE's ~30s budget), and rewrite the notification body. Any failure
(no session, timeout ~10s, offline) leaves the generic text — never a
dropped notification. Ships in the next TestFlight build; requires no relay
or journal change.

## Testing

- `gateway.js`: unit tests with injected `fetchImpl` — field allowlist (no
  alert text on the wire), `{status, reason}` mapping, transport/timeout
  never-reject behavior. Mirrors the apns.js fake-connect style.
- `relay.js`: in-process HTTP server against the existing fake APNs h2
  helper — category→payload table, mutable-content, validation 400s, rate
  limit 429s, APNs status passthrough (410 reaches the caller).
- `push.js`: extend existing pipeline tests for category threading and
  prefs filtering (attention off → prompt push skipped, wake unaffected).

## Rollout

1. Journal PR: gateway + relay + prefs (this spec's v1). Deploy to Dan's
   journal box; start the relay (launchd/systemd per that box's setup);
   cloudflared ingress + DNS route for `push.matron.chat`.
2. Friend's journal: set `MATRON_PUSH_GATEWAY_URL=https://push.matron.chat`
   → push works on the TestFlight build they already have.
3. matron-site: update the support-page push answer ("point your journal at
   the relay") and add the promised privacy-policy line: the relay receives
   a device push token and an event category, never message content.
4. v2 apps PR (settings UI + NSE fetch) → next TestFlight build.
