# Pre-Approved Link Codes: Persistence, Long Expiry, PNG Export & Dev-Boxer Hints

**Date:** 2026-07-20
**Repos:** matron-journal (store, HTTP, CLI), dev-boxer (provisioning summary)
**Status:** Approved design

## Problem

`matron-admin link-code` mints a pre-approved device-link code that expires in
10 minutes and renders only as a terminal QR. That works for the at-provision
flow (dev-boxer prints the QR, you scan it immediately) but fails two real
cases:

1. **Re-linking later.** If you miss the provisioning QR (or add a phone
   weeks later), nothing tells you how to mint a fresh code.
2. **Handing the code to someone else.** A 10-minute terminal QR cannot be
   sent to another person in another timezone. It needs a file artifact and a
   much longer expiry — and a long-lived code must survive a journal restart,
   which today's in-memory store does not.

## Decisions (from brainstorming)

- Both features: the dev-boxer re-mint hint AND the file/PNG export.
- File-export codes support a longer expiry, up to 24 hours (user choice).
- Long-lived pre-approved codes persist to the DB and survive restarts.
- Codes remain **single-use**: the first successful claim consumes the code
  atomically; a second scan (or replay of a captured QR) gets `not_found`.
- Interactive show-QR sessions (phone-to-phone approval flow) are untouched:
  short-lived, in-memory, forgotten on restart, exactly as today.

## Design

### 1. Journal — schema (`src/db.js`)

New table, appended to `SCHEMA` (idempotent `CREATE TABLE IF NOT EXISTS`,
same pattern as every other table):

```sql
CREATE TABLE IF NOT EXISTS link_preapprovals(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

- `code_hash` = hex SHA-256 of the normalized 8-char code. The plaintext
  code never touches disk — a leaked backup exposes only SHA-256 hashes of
  ~39-bit codes (brute-forceable offline while a row is live, but never
  readable directly).
- `expires_at` / `created_at` are epoch milliseconds (matches the rest of
  the codebase, e.g. `devices.created_at`).

### 2. Journal — store (`src/link.js`)

`makeLinkStore` gains an optional `db` handle:

```js
makeLinkStore({ ttlMs, claimExtensionMs, maxPending, preapprovedTtlMs, db })
```

**`startPreapproved(userId, { ttlMs } = {})`** — when `db` is present,
pre-approved codes go to the `link_preapprovals` table *instead of* the
in-memory map (one source of truth; no dual-state sync). Behaviour:

- `ttlMs` clamps to **[60 000 ms, 86 400 000 ms]** (1 minute to 24 hours);
  default stays `preapprovedTtlMs` (600 000 ms). Out-of-range input clamps rather than errors at the store layer;
  the HTTP layer validates before calling (see §3).
- Sweep expired rows (`DELETE FROM link_preapprovals WHERE expires_at <= now`)
  before the cap check — same sweep-then-check shape as the in-memory path.
- Cap: live DB rows are counted against their own `maxPending` (64),
  independent of the in-memory interactive-session cap. 429 semantics at the
  HTTP layer are unchanged.
- Code uniqueness: retry `randomCode()` while the hash collides with a live
  row (`SELECT 1 FROM link_preapprovals WHERE code_hash=?`) or the code
  matches a live in-memory session (claim must stay unambiguous across both
  stores).
- Returns `{ linkCode: 'XXXX-XXXX', expiresIn }` exactly as today.
- Without a `db` handle (tests, hypothetical embedded use), behaviour is
  unchanged: in-memory, `preapprovedTtlMs`, forgotten on restart.

**`claim(codeInput, { deviceName, requesterIp })`** — two-phase lookup:

1. In-memory scan, exactly as today (interactive sessions first).
2. On miss, hash the normalized code and consume atomically:

   ```sql
   DELETE FROM link_preapprovals
   WHERE code_hash = ? AND expires_at > ?
   RETURNING user_id
   ```

   - No row → `{ status: 'not_found' }` (expired, already used, or never
     existed — indistinguishable, as today's plain-404 posture requires).
   - Row returned → the code is consumed. Insert a synthetic in-memory
     session (`preapproved: true`, `status: 'approved'`, fresh 256-bit
     `claimToken`, `expiresAt = now + claimExtensionMs`) and return
     `{ status: 'claimed', claimToken, expiresIn }` — identical response
     shape to today. The existing `poll()` machinery then mints the device
     with zero changes.

**Single-use guarantee:** the `DELETE … RETURNING` is one SQLite statement —
two concurrent claims of the same code cannot both get the row. Deleting at
claim time (not at poll time) means a crash in the seconds between claim and
poll burns the code unused; that is the correct trade — the alternative
(delete at poll) would leave a claimed-but-live row after a crash, i.e. a
replay window on a code someone already scanned.

**Boot sweep:** `startServer` deletes expired rows once at startup, so a
journal that was down past a code's expiry doesn't carry dead rows until the
next mint.

### 3. Journal — HTTP (`src/http.js`)

`POST /link/preapprove` (loopback-only + key-gated, guards unchanged) accepts
an optional body field:

- `ttl_seconds`: integer, **60 ≤ ttl_seconds ≤ 86400**. Absent → 600 (today's
  default). Present but invalid (non-integer, out of range) → 400
  `bad_request`, matching the endpoint's existing body validation (a bad
  `username` is 400 too; the uniform 404 is for the access guards, which run
  before the body is read). Valid → passed to
  `startPreapproved(user.id, { ttlMs: ttl_seconds * 1000 })`.

Response shape unchanged: `{ link_code, expires_in }` (with `expires_in` now
reflecting the requested TTL). `/link/claim` is outwardly unchanged.

### 4. Journal — CLI (`bin/matron-admin.js`)

```
matron-admin link-code <username> --server-url <url> [--expires <dur>] [--png <path>]
```

- `--expires <dur>`: duration as `Nm` (minutes) or `Nh` (hours), e.g. `30m`,
  `24h`. Range 1m–24h. Default: omit the field (server default 600 s).
  Unparseable / out-of-range → exit 1 with a usage message *before* any
  network call.
- `--png <path>`: write the QR as a PNG file instead of terminal art.
  - New dependency: `qrcode` (npm) — renders the same `matron://link?v=1…`
    URI to a PNG buffer; written with `fs.writeFileSync(path, buf,
    { mode: 0o600 })`.
  - Path must be writable: the CLI verifies it can create/overwrite the file
    (open for write) **before** POSTing `/link/preapprove`, so a bad path
    never mints (and thus orphans) a live code.
  - On success prints: the PNG path, the expiry (`expires in N minutes/hours
    and works once`), a copy hint (`scp <host>:<path> .` — host is the
    machine's hostname), and a cleanup hint (`rm <path>` after sharing —
    the PNG grants a device login to anyone who scans it before expiry).
  - Terminal QR is suppressed in `--png` mode (nobody scans ANSI art off a
    log); the code string itself still prints for manual entry.
- Flags compose: `--expires 24h --png /root/matron-link.png` is the
  hand-off invocation.

### 5. dev-boxer (`lib/dev_boxer/modules/11_hello_world.rb`)

The provisioning summary (after the existing at-provision QR / login
instructions) gains a **"Link a phone later"** block with two copy-paste
lines, built from values dev-boxer already knows (SSH host, journal
username, journal dir):

```
Link a phone later:
  re-mint a QR in this terminal:
    ssh root@<host> "runuser -u matron -- sh -c 'cd <journal_dir> && MATRON_DB=<journal_dir>/data/matron.db npx matron-admin link-code <user> --server-url <https_base>'"
  or mint a 24-hour QR image to send to someone:
    ssh root@<host> "runuser -u matron -- sh -c 'cd <journal_dir> && MATRON_DB=<journal_dir>/data/matron.db npx matron-admin link-code <user> --server-url <https_base> --expires 24h --png /tmp/matron-link.png'"
    scp root@<host>:/tmp/matron-link.png . && ssh root@<host> rm /tmp/matron-link.png
```

- Reuses the exact command shape of `JournalEnrollment.matron_admin_command`
  so the printed line and the code path can't drift apart — extract the
  command-string builder so both use it.
- The existing at-provision QR behaviour is unchanged; the block prints even
  when the at-provision QR failed (that's precisely when you need it).

## Error handling

| Failure | Behaviour |
| --- | --- |
| `ttl_seconds` invalid at HTTP layer | 400 `bad_request` (matches existing body validation) |
| `--expires` unparseable / out of range | CLI exits 1 with usage, no network call |
| `--png` path unwritable | CLI exits 1 before minting a code |
| Preapproval cap (64 live rows) hit | 429, as today |
| Claim of used/expired/unknown code | `not_found` — indistinguishable |
| Crash between claim and poll | code burned (row already deleted); user re-mints |
| Journal restart with live long codes | codes survive (DB); interactive sessions forgotten as today |

## Testing

**Journal (`node:test`, real SQLite in-temp-dir, no mocks):**
- Persisted code claims successfully through a *new* `makeLinkStore` instance
  on the same DB (simulated restart), then polls to `approved`.
- Second claim of the same code → `not_found`.
- Expired row is not claimable; boot sweep removes it.
- TTL clamp: below-minimum and above-maximum requests clamp at the store.
- HTTP: `ttl_seconds: 86400` reflected in `expires_in`; `ttl_seconds: 99999`
  and `"abc"` → 400.
- Cap counts live DB rows; expired rows don't count.
- In-memory interactive flow: existing tests unchanged and passing.

**CLI:** unit tests for the duration parser (valid `30m`/`24h`, invalid
`0m`/`25h`/`bananas`); `--png` to an unwritable path exits before POST.

**dev-boxer (rspec):** summary output contains both hint commands verbatim,
built from the enrollment's host/user/dir.

## Out of scope

- Revoking a live pre-approved code from the CLI (re-mint + short TTL covers
  the practical need; YAGNI until asked).
- Persisting interactive show-QR sessions.
- Any app-side (iOS/Android) change — the claim wire format is unchanged.
