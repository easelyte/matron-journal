# Rendezvous offer encryption — take the relay operator out of the trust boundary

**Date:** 2026-07-18
**Status:** Approved (design review with Dan, this session)
**Depends on:** Link Rendezvous (`2026-07-18-link-rendezvous-design.md`, shipped in
journal #29, apple #71, android #5) — this hardens that feature's offer path.

## Problem

The link-rendezvous flow routes the signed-in phone's offer — `{server, code}` —
through the shared relay (`push.matron.chat`) in cleartext. That link **code is a
bearer credential** against the journal: whoever holds it can `claim()` it. The
relay operator holds it.

So the relay operator can actively intercept a sign-in, not merely observe one:

1. The phone offers `{server, code}`; the operator reads `code` off the relay.
2. The operator `claim()`s it against `server` with the operator's own device
   name/IP, and can stall the desktop's poll so the operator is the only claimant.
3. The signed-in phone's approve card now shows the **operator's** device.
4. If the user taps approve, the operator's poll mints a device token **for the
   user's account**. The real desktop sees only a `conflict`.

The shipped design's threat model (§4.2, "compromised relay") named the *reverse*
direction (a bad relay feeding the desktop an attacker's server) and concluded "no
structural fix exists — mitigation is transparency." The interception above is
mitigated **solely** by the human noticing an unfamiliar device on the approve
card. That is a human-in-the-loop gate, not a structural guarantee. This spec
makes it structural.

## Solution shape

End-to-end encrypt the offer so the relay only ever holds ciphertext it cannot
read or forge. The signed-out **desktop** generates a fresh single-use symmetric
key, publishes it **in the QR** (which travels desktop-screen → phone-camera,
never through the relay), and the scanning phone encrypts `{server, code}` under
it. The relay stores an opaque blob; the desktop decrypts it locally and runs the
unchanged claim flow.

Why symmetric (AES-256-GCM), not an asymmetric sealed box: the key material only
ever crosses the trusted screen→camera channel in either scheme, so the relay
operator never sees it either way — symmetric is exactly as strong against the
operator (the stated threat) while adding **zero new dependencies** and no OS
version floor. AES-256-GCM is first-class on every target: `CryptoKit.AES.GCM`
(iOS 18 / macOS 15, MatronShared at iOS 17 / macOS 14) and `javax.crypto`
`AES/GCM/NoPadding` (Android minSdk 26). An asymmetric scheme would only add value
against a malicious *scanning phone*, which is QRLjacking (§4.1) — a distinct
threat that encryption does not address in either form.

This is a **hard `v=2` cutover**: the feature shipped hours ago with no production
users, so there is no cleartext `v=1` path to keep alive. Keeping one would
reintroduce exactly the vector this closes (an un-upgraded desktop still shows a
`v=1` QR a new phone would have to honor in cleartext).

## 1. Wire format and crypto

### QR payload — `v=2`

`matron://rlink?v=2&rid=<rid>&k=<key>`

- `rid`: unchanged — 26 chars of the pairing alphabet, the relay entry key.
- `k`: the offer key — 32 random bytes (256-bit), **base64url, no padding**
  (43 chars). `java.util.Base64` url-safe (API 26+) and Foundation both decode it;
  it is case-sensitive, which the existing query-value parsing already preserves
  (only scheme/host are matched case-insensitively). The mixed-case `k` pushes the
  QR into byte mode; total payload is ~80 chars, trivially within QR capacity.
- The key is **never** sent to the relay. It exists only in the QR and in the two
  legitimate devices' memory.

### Offer body — the sealed box

The scanning phone builds the exact plaintext the relay used to store:

```json
{"server":"https://chat.example.com","code":"2345-6789"}
```

(`server` = the phone's session homeserver URL; `code` = the `XXXX-XXXX` display
form, same value the shipped offer sent.) It encrypts that UTF-8 JSON with
**AES-256-GCM** under `k`, using a fresh random **96-bit nonce**, and posts:

```json
{"box":"<base64url(nonce(12) ‖ ciphertext ‖ tag(16)), no padding>"}
```

- Single-use key ⇒ nonce reuse is structurally impossible (one key encrypts at
  most one offer), but a fresh random nonce is specified anyway for hygiene.
- No associated data: the unique-per-rendezvous key already binds the box to this
  rendezvous, so a box cannot be replayed into another one (it would fail
  authentication under that rendezvous's different key).
- The relay does **not** decrypt, validate, or normalize the box — it is opaque
  bytes to the relay.

### Desktop decryption

On a polled `{box}`: base64url-decode, split `nonce ‖ ciphertext ‖ tag`,
AES-256-GCM-open under `k`. On success, parse the JSON, **validate `server` with
the app's existing `ServerURLValidator`** (the relay no longer does this), then
feed `{server, code}` to the existing claim path — identical to today past this
point. An **undecryptable or malformed box** (someone who knows only the rid — not
`k` — occupied the slot with garbage) is treated exactly like an expired
rendezvous: regenerate a fresh rid + key + QR and keep showing. This keeps a
hostile slot-grab from permanently wedging the Show screen.

## 2. Journal / relay changes (`matron-journal`)

### `src/rendezvous.js`

The entry stores a single opaque `box` string in place of `{server, code}`:

- `create()`: unchanged (rid, 256-bit poll secret, TTL 3 min, `maxPending` 256).
- `offer(rid, box)`: first-box-wins (unchanged conflict/not-found/TTL semantics);
  stores `box` verbatim. No server/code parsing or validation.
- `poll(rid, secret)`: `204` while `box === null`; `200 { box }` once offered;
  `404`/`403` unchanged; constant-time secret compare unchanged; still not
  one-shot (survives to TTL so a dropped poll can retry).

### `src/relay.js`

- `handleOffer`: replace `validateOffer` + `normalizeCode` + `{server, code}` with
  a single check that `body` is `{ box: string }`, `box` non-empty and length-
  capped (**≤ 1024 chars**; a valid box is ~340), else `400 { reason }` with a
  machine reason that never echoes caller input (relay convention). The existing
  `413` body-size guard and rate limiters are unchanged.
- `handlePoll`: return `200 { box: p.box }` instead of `{ server, code }`.
- Route regexes, create handler, sweep, and limiter shape unchanged.

### Tests (`node:test`)

- Store: box round-trips through offer→poll; first-box-wins; `204` before offer;
  secret gating and TTL expiry unchanged.
- HTTP: valid `{box}` → `204`, poll → `200 {box}`; missing/empty/oversized/extra-
  field bodies → `400`/`413`; unknown rid → `404`; wrong secret → `403`.

## 3. App changes (`matron-apple`, `matron-android`)

### Shared crypto helper (new, one per codebase)

A small, pure, dependency-free unit wrapping three operations, TDD'd on its own:

- `generateKey() -> 32 bytes`
- `seal(plaintext, key) -> box bytes` (random nonce, AES-256-GCM, `nonce‖ct‖tag`)
- `open(box, key) -> plaintext` (throws/returns nil on auth failure or short input)

Apple: `RendezvousCrypto` in `MatronShared` (shared Mac/iOS), over `CryptoKit`.
Android: the Kotlin equivalent over `javax.crypto` (`AES/GCM/NoPadding`,
`GCMParameterSpec` 128-bit tag). Tests: seal→open round-trip; a flipped byte fails
`open`; a wrong key fails `open`; truncated input fails cleanly.

**Cross-language agreement:** one shared test vector (fixed key + fixed nonce +
fixed plaintext → fixed box, all hex/base64 literals in the spec of the plan)
asserted in *both* suites, so a Swift-sealed box opens under Kotlin and vice
versa. This is the interop contract; without it the two AES-GCM implementations
could disagree on framing and never encounter each other until production.

### `matron-android`

- `RendezvousURI`: `format(rid, key)` emits `v=2&rid=…&k=<base64url>`; `parse`
  returns `{ rid, key }`, throws `UnsupportedVersion` for `v != 2`,
  `Malformed` for a bad/absent `rid` or `k`.
- `RelayApi` / `RelayRendezvousing`: `offerRendezvous(rid, box)` posts `{box}`;
  `pollRendezvous` maps `200 {box}` → `Offered(box)`. The `{server, code}` shape
  leaves the relay layer.
- `RendezvousSignInViewModel` (Show): generate key, format the `v=2` QR, `open`
  the polled box, validate `server`, then delegate to `LinkSignInViewModel` as
  today; undecryptable box → regenerate (mirror the expiry-regeneration path).
- `DeviceLinkViewModel` (Scan): parse `v=2`, `linkStart` on its journal, `seal`
  `{server, code}`, `offerRendezvous(rid, box)`.

### `matron-apple`

The mirror of the above in `MatronShared`: the `RendezvousURI` equivalent, the
relay client's offer/poll types, `RendezvousSignInViewModel` (Show) and the
signed-in Scan view model — same generation-guarded post-cancel race handling the
siblings already use. Mac has no Scan tab (unchanged); it only ever decrypts.

### Copy

No new user-facing strings are required — the decrypt-failure path reuses the
existing rendezvous-expiry regeneration (silent) and the unknown-version path
reuses the existing "needs a newer version of Matron" copy.

## 4. Threat model update

Rewrite link-rendezvous §4.2. A compromised or malicious relay operator now holds
only an opaque, authenticated ciphertext and never the offer key:

- **Cannot read** the offer → cannot race the claim (the interception above is
  closed).
- **Cannot forge or substitute** an offer → the reverse-direction §4.2 attack
  (signing the desktop into an attacker's journal) is also closed: a forged box
  fails AES-GCM authentication, and the operator never has `k` to make a valid one.
- **Residual:** denial-of-service only (drop/refuse/garbage-fill offers), which is
  unavoidable for any relay and benign here — the desktop regenerates and the user
  retries. §4.1 (QRLjacking — victim scans an *attacker's* QR) is unchanged and
  still gated by the approve card; encryption is orthogonal to it.

## 5. Scope

Three repos, not four. `dev-boxer`, the `POST /link/preapprove` path, and the
forward `matron://link` claim flow are **untouched** — encryption applies only to
the `matron://rlink` rendezvous offer. `matron-admin` is untouched.

## 6. Rollout

Hard `v=2` cutover; no dual-version support.

1. Journal PR: `rendezvous.js` opaque box + `relay.js` offer/poll handlers.
2. Apple PR: `RendezvousCrypto`, `v=2` URI, Show/Scan encryption.
3. Android PR: Kotlin crypto helper, `v=2` URI, Show/Scan encryption.

Each non-draft with the bugbot review loop. Deploy order: journal first (relay
accepts `{box}`), then the apps. There are no users mid-upgrade, so a brief window
where the deployed relay expects `{box}` while old app builds still send
`{server, code}` only affects the developer's own test devices, which update with
the apps.
