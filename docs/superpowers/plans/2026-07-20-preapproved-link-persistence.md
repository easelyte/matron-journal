# Pre-Approved Link-Code Persistence Implementation Plan (matron-journal)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pre-approved link codes persist to SQLite (surviving restarts), accept a TTL up to 24 hours, and `matron-admin link-code` gains `--expires` and `--png` flags.

**Architecture:** A new `link_preapprovals` table stores SHA-256 hashes of pre-approved codes; `makeLinkStore` writes pre-approved codes there (instead of the in-memory map) when given a `db` handle, and `claim()` consumes a persisted code with an atomic `DELETE … RETURNING`, handing off to the existing in-memory poll machinery via a synthetic approved session. The HTTP layer forwards an optional `ttl_seconds`; the CLI adds duration parsing and PNG output.

**Tech Stack:** Node ≥20 ESM, better-sqlite3, `node:test` + `assert/strict`, new dependency `qrcode` (PNG rendering; `qrcode-terminal` stays for ANSI QRs).

**Spec:** `docs/superpowers/specs/2026-07-20-preapproved-link-code-persistence-design.md` (approved). Work happens on branch `feat/preapproved-link-persistence` (already created; the spec is committed on it).

## Global Constraints

- Pre-approved codes are **single-use**: the consume is one `DELETE … RETURNING` statement; two concurrent claims must never both succeed.
- Plaintext codes never touch disk — only hex SHA-256 hashes are stored.
- TTL clamp at the store: **[60 000 ms, 86 400 000 ms]**; store default stays `preapprovedTtlMs` (600 000 ms).
- HTTP `ttl_seconds`: optional; when present must be an integer in **[60, 86400]**, else 400 `bad_request`. The loopback/no-forwarding-header/`x-preapprove-key` guards are NOT touched.
- CLI `--expires` accepts `Nm`/`Nh` only, range 1m–24h; invalid → error **before any network call**.
- CLI `--png` writes mode 0600 and verifies writability **before** minting (a bad path must never orphan a live code).
- Interactive (non-preapproved) link sessions stay in-memory only; every existing test in `test/link.test.js` and `test/link-http.test.js` must keep passing unchanged.
- Timestamps are epoch **milliseconds** (matches `devices.created_at` etc.).
- Tests use real SQLite (`openDb`), no mocks. Run per-file with `node --test test/<file>`; full suite `npm test`.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `link_preapprovals` table + persistent store path

**Files:**
- Modify: `src/db.js` (append to the `SCHEMA` template string, after the `blobs` table)
- Modify: `src/link.js`
- Test: `test/link-preapprovals.test.js` (new file)

**Interfaces:**
- Consumes: `openDb(path)` from `src/db.js`; `normalizeCode`, `randomCode` from `src/pairing.js` (already imported in link.js).
- Produces: `makeLinkStore({ ttlMs, claimExtensionMs, maxPending, preapprovedTtlMs, db })` — new optional `db` (a better-sqlite3 handle). `startPreapproved(userId, { ttlMs } = {})` — new optional per-call TTL, clamped; returns `{ linkCode: 'XXXX-XXXX', expiresIn }` (seconds) or `null` when the cap is hit. `claim(codeInput, { deviceName, requesterIp })` — unchanged signature; now also consumes persisted codes. Creating a store with `db` sweeps expired rows (this is the boot sweep — the server builds its store once at startup).

- [ ] **Step 1: Add the table to the schema**

In `src/db.js`, inside the `SCHEMA` string, after the `blobs` table definition (before the closing backtick):

```sql
CREATE TABLE IF NOT EXISTS link_preapprovals(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

No migration dance is needed — `SCHEMA` is executed with `CREATE TABLE IF NOT EXISTS` on every `openDb`, which is exactly how every other table ships.

- [ ] **Step 2: Write the failing tests**

Create `test/link-preapprovals.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { makeLinkStore } from '../src/link.js'

function tmpDbPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-link-pre-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'test.db')
}

const rowCount = (db) => db.prepare('SELECT COUNT(*) n FROM link_preapprovals').get().n

test('db-backed startPreapproved stores a hash, not the code; claim consumes and approves', (t) => {
  const db = openDb(tmpDbPath(t))
  t.after(() => db.close())
  const store = makeLinkStore({ db })
  const s = store.startPreapproved(7)
  assert.match(s.linkCode, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4}$/)
  assert.equal(s.expiresIn, 600)
  assert.equal(rowCount(db), 1)
  assert.equal(store.size(), 0) // nothing in the in-memory map

  // hash on disk, never the plaintext code
  const bare = s.linkCode.replace('-', '')
  const expected = crypto.createHash('sha256').update(bare).digest('hex')
  const row = db.prepare('SELECT user_id, code_hash FROM link_preapprovals').get()
  assert.equal(row.user_id, 7)
  assert.equal(row.code_hash, expected)

  const c = store.claim(s.linkCode, { deviceName: 'First Phone' })
  assert.equal(c.status, 'claimed')
  assert.match(c.claimToken, /^[0-9a-f]{64}$/)
  assert.equal(rowCount(db), 0) // consumed at claim time
  assert.deepEqual(store.poll(c.claimToken), { status: 'approved', userId: 7, deviceName: 'First Phone' })
})

test('persisted code survives a restart (fresh store on the same db file)', (t) => {
  const dbPath = tmpDbPath(t)
  const db1 = openDb(dbPath)
  const s = makeLinkStore({ db: db1 }).startPreapproved(7, { ttlMs: 86400000 })
  assert.equal(s.expiresIn, 86400)
  db1.close()

  const db2 = openDb(dbPath)
  t.after(() => db2.close())
  const store2 = makeLinkStore({ db: db2 })
  const c = store2.claim(s.linkCode, { deviceName: 'Handed-off Phone' })
  assert.equal(c.status, 'claimed')
  assert.equal(store2.poll(c.claimToken).status, 'approved')
})

test('second claim of the same code is not_found (single-use)', (t) => {
  const db = openDb(tmpDbPath(t))
  t.after(() => db.close())
  const store = makeLinkStore({ db })
  const s = store.startPreapproved(7)
  assert.equal(store.claim(s.linkCode, { deviceName: 'a' }).status, 'claimed')
  assert.deepEqual(store.claim(s.linkCode, { deviceName: 'b' }), { status: 'not_found' })
})

test('expired row is not claimable; store creation sweeps it (boot sweep)', (t) => {
  const db = openDb(tmpDbPath(t))
  t.after(() => db.close())
  const store = makeLinkStore({ db })
  const s = store.startPreapproved(7)
  db.prepare('UPDATE link_preapprovals SET expires_at = 1').run()
  assert.deepEqual(store.claim(s.linkCode, { deviceName: 'x' }), { status: 'not_found' })

  db.prepare('INSERT INTO link_preapprovals(user_id, code_hash, expires_at, created_at) VALUES(7, ?, 1, 1)')
    .run('e'.repeat(64))
  makeLinkStore({ db }) // boot sweep
  assert.equal(rowCount(db), 0)
})

test('ttlMs clamps to [1 minute, 24 hours]', (t) => {
  const db = openDb(tmpDbPath(t))
  t.after(() => db.close())
  const store = makeLinkStore({ db })
  assert.equal(store.startPreapproved(1, { ttlMs: 1 }).expiresIn, 60)
  assert.equal(store.startPreapproved(2, { ttlMs: 999 * 86400000 }).expiresIn, 86400)
})

test('cap counts live db rows; expired rows do not count', (t) => {
  const db = openDb(tmpDbPath(t))
  t.after(() => db.close())
  const store = makeLinkStore({ db, maxPending: 2 })
  assert.ok(store.startPreapproved(1))
  assert.ok(store.startPreapproved(2))
  assert.equal(store.startPreapproved(3), null)
  db.prepare('UPDATE link_preapprovals SET expires_at = 1 WHERE user_id = 1').run()
  assert.ok(store.startPreapproved(3)) // expired row swept before the cap check
})

test('without a db handle, startPreapproved stays in-memory (unchanged behaviour)', () => {
  const store = makeLinkStore()
  const s = store.startPreapproved(7)
  assert.equal(s.expiresIn, 600)
  assert.equal(store.size(), 1)
  const c = store.claim(s.linkCode, { deviceName: 'x' })
  assert.equal(c.status, 'claimed')
  assert.equal(store.poll(c.claimToken).status, 'approved')
})
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `node --test test/link-preapprovals.test.js`
Expected: FAIL — `startPreapproved` ignores `db` (rows never land in `link_preapprovals`, `rowCount` is 0, `store.size()` is 1).

- [ ] **Step 4: Implement in `src/link.js`**

Add module-level helpers below the imports:

```js
const MIN_PREAPPROVED_TTL_MS = 60000
const MAX_PREAPPROVED_TTL_MS = 86400000

// Only the SHA-256 of a pre-approved code touches disk — a leaked DB
// backup must not be able to mint devices.
const hashCode = (code) => crypto.createHash('sha256').update(code).digest('hex')
```

Change the factory signature and add the boot sweep at the top of the factory body:

```js
export function makeLinkStore({ ttlMs = 120000, claimExtensionMs = 60000, maxPending = 64, preapprovedTtlMs = 600000, db = null } = {}) {
  const sessions = new Map() // starterDeviceId (or 'preapproved:<random>') -> { code, userId, status, preapproved, claimToken, deviceName, requesterIp, expiresAt }

  // Boot sweep: the server builds its store once at startup, so sweeping
  // here means a journal that was down past a code's expiry doesn't carry
  // dead rows until the next mint.
  if (db) db.prepare('DELETE FROM link_preapprovals WHERE expires_at <= ?').run(Date.now())
```

Replace `startPreapproved` with (the in-memory branch is today's body with the clamped TTL substituted):

```js
    // Root-on-the-box provisioning (spec §3): the session is born approved —
    // claim() jumps straight to 'approved', so the claimant's first poll
    // returns the device token with no approve tap (at provisioning time
    // there is no other device to tap on). With a db handle the code lives
    // in link_preapprovals INSTEAD of the map (one source of truth) so a
    // long-lived hand-off code survives a restart; only its hash is stored.
    startPreapproved(userId, { ttlMs: requestedTtlMs } = {}) {
      const now = Date.now()
      const ttl = Math.min(MAX_PREAPPROVED_TTL_MS, Math.max(MIN_PREAPPROVED_TTL_MS, requestedTtlMs ?? preapprovedTtlMs))
      if (!db) {
        sweep(now)
        if (sessions.size >= maxPending) return null
        let code
        do { code = randomCode() } while ([...sessions.values()].some((s) => s.code === code))
        sessions.set(`preapproved:${crypto.randomBytes(8).toString('hex')}`, {
          code, userId, status: 'waiting', preapproved: true, claimToken: null, deviceName: null, requesterIp: null, expiresAt: now + ttl,
        })
        return { linkCode: `${code.slice(0, 4)}-${code.slice(4)}`, expiresIn: Math.floor(ttl / 1000) }
      }
      // Sweep-then-cap, same shape as the in-memory path. The cap is
      // independent of the interactive-session cap: both are 64, neither
      // can starve the other.
      db.prepare('DELETE FROM link_preapprovals WHERE expires_at <= ?').run(now)
      if (db.prepare('SELECT COUNT(*) n FROM link_preapprovals').get().n >= maxPending) return null
      // Claim must stay unambiguous across both stores, so the code may
      // collide with neither a live row nor a live in-memory session.
      let code
      do { code = randomCode() } while (
        [...sessions.values()].some((s) => s.code === code) ||
        db.prepare('SELECT 1 FROM link_preapprovals WHERE code_hash=?').get(hashCode(code))
      )
      db.prepare('INSERT INTO link_preapprovals(user_id, code_hash, expires_at, created_at) VALUES(?,?,?,?)')
        .run(userId, hashCode(code), now + ttl, now)
      return { linkCode: `${code.slice(0, 4)}-${code.slice(4)}`, expiresIn: Math.floor(ttl / 1000) }
    },
```

In `claim()`, replace the final `return { status: 'not_found' }` with:

```js
      if (db) {
        // Atomic consume: one statement, so two concurrent claims can never
        // both get the row — single-use is enforced by SQLite, not by us.
        // Deleting at claim (not at poll) means a crash in the seconds
        // between claim and poll burns the code unused; the alternative
        // would leave an already-scanned code replayable after a crash.
        const row = db.prepare(
          'DELETE FROM link_preapprovals WHERE code_hash=? AND expires_at > ? RETURNING user_id'
        ).get(hashCode(code), now)
        if (row) {
          // Synthetic approved session: from here the existing poll()
          // machinery mints the device with zero changes.
          const claimToken = crypto.randomBytes(32).toString('hex')
          sessions.set(`preapproved:${crypto.randomBytes(8).toString('hex')}`, {
            code, userId: row.user_id, status: 'approved', preapproved: true, claimToken,
            deviceName, requesterIp, expiresAt: now + claimExtensionMs,
          })
          return { status: 'claimed', claimToken, expiresIn: Math.ceil(claimExtensionMs / 1000) }
        }
      }
      return { status: 'not_found' }
```

Note: `code` here is already the normalized form (`const code = normalizeCode(codeInput)` at the top of `claim`), and `deviceName`/`requesterIp` are the destructured claim options — both already in scope.

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `node --test test/link-preapprovals.test.js`
Expected: PASS (7/7).

- [ ] **Step 6: Run the neighbouring suites to verify nothing regressed**

Run: `node --test test/link.test.js test/link-http.test.js test/db.test.js`
Expected: PASS, zero failures.

- [ ] **Step 7: Commit**

```bash
git add src/db.js src/link.js test/link-preapprovals.test.js
git commit -m "Persist pre-approved link codes to SQLite (hashed, single-use, 24h-capable)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Server wiring + `ttl_seconds` on POST /link/preapprove

**Files:**
- Modify: `src/server.js` (the `resolvedLinks` line, currently `const resolvedLinks = links || makeLinkStore()`)
- Modify: `src/http.js` (the `/link/preapprove` handler, currently lines ~195-231)
- Test: `test/link-http.test.js` (append tests)

**Interfaces:**
- Consumes: `makeLinkStore({ db })` and `startPreapproved(userId, { ttlMs })` from Task 1.
- Produces: `POST /link/preapprove` body gains optional `ttl_seconds` (integer 60–86400 → 400 otherwise); response `{ link_code, expires_in }` unchanged in shape, `expires_in` reflects the requested TTL. The server's link store is now DB-backed for pre-approved codes.

- [ ] **Step 1: Write the failing tests**

Append to `test/link-http.test.js` (it already imports `startTestServer` from `./helpers.js` and `createUser` from `../src/auth.js`; the preapprove tests use `s.preapproveKey` — follow the same pattern):

```js
test('preapprove: ttl_seconds is honoured, and the code survives a server restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-pre-restart-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'j.db')

  const s1 = await startTestServer({ dbPath })
  await createUser(s1.db, 'dan', 'hunter22')
  const pre = await s1.http('/link/preapprove', {
    method: 'POST', body: { username: 'dan', ttl_seconds: 86400 }, headers: { 'x-preapprove-key': s1.preapproveKey },
  })
  assert.equal(pre.status, 200)
  assert.equal(pre.json.expires_in, 86400)
  await s1.close()

  const s2 = await startTestServer({ dbPath })
  t.after(() => s2.close())
  const claim = await s2.http('/link/claim', {
    method: 'POST', body: { link_code: pre.json.link_code, device_name: 'Handed-off Phone' },
  })
  assert.equal(claim.status, 200)
  const poll = await s2.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })
  assert.equal(poll.json.status, 'approved')
  assert.equal(poll.json.username, 'dan')

  // single-use across the wire too
  const again = await s2.http('/link/claim', {
    method: 'POST', body: { link_code: pre.json.link_code, device_name: 'Replay' },
  })
  assert.equal(again.status, 404)
})

test('preapprove: invalid ttl_seconds is a 400, valid boundaries pass', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'hunter22')
  const keyHeaders = { 'x-preapprove-key': s.preapproveKey }
  for (const ttl_seconds of ['abc', 99999, 59, 0, -5, 3.5]) {
    const r = await s.http('/link/preapprove', { method: 'POST', body: { username: 'dan', ttl_seconds }, headers: keyHeaders })
    assert.equal(r.status, 400, `ttl_seconds=${JSON.stringify(ttl_seconds)}`)
  }
  for (const [ttl_seconds, expected] of [[60, 60], [86400, 86400], [undefined, 600]]) {
    const r = await s.http('/link/preapprove', { method: 'POST', body: { username: 'dan', ttl_seconds }, headers: keyHeaders })
    assert.equal(r.status, 200)
    assert.equal(r.json.expires_in, expected)
  }
})
```

If `fs`/`os`/`path` are not already imported at the top of `test/link-http.test.js`, add:

```js
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/link-http.test.js`
Expected: the two new tests FAIL — `expires_in` is 600 regardless of `ttl_seconds`, and the restart claim is 404 (store not DB-backed). Every pre-existing test still passes.

- [ ] **Step 3: Implement**

`src/server.js` — pass the already-open handle (the line sits after `const db = openDb(resolvedDbPath)`):

```js
  const resolvedLinks = links || makeLinkStore({ db })
```

`src/http.js` — in the `/link/preapprove` handler, replace:

```js
        const { username } = await readBody(req)
        if (typeof username !== 'string' || !username) return json(res, 400, { error: 'bad_request' })
        const user = db.prepare('SELECT id FROM users WHERE name=?').get(username)
        if (!user) return json(res, 404, { error: 'not_found' })
        const l = links.startPreapproved(user.id)
```

with:

```js
        const { username, ttl_seconds } = await readBody(req)
        if (typeof username !== 'string' || !username) return json(res, 400, { error: 'bad_request' })
        // Optional hand-off TTL (spec §3): bounded here so the store clamp
        // is belt-and-braces, not the operator's error report.
        if (ttl_seconds !== undefined &&
            (!Number.isInteger(ttl_seconds) || ttl_seconds < 60 || ttl_seconds > 86400)) {
          return json(res, 400, { error: 'bad_request' })
        }
        const user = db.prepare('SELECT id FROM users WHERE name=?').get(username)
        if (!user) return json(res, 404, { error: 'not_found' })
        const l = links.startPreapproved(user.id, ttl_seconds !== undefined ? { ttlMs: ttl_seconds * 1000 } : {})
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/link-http.test.js`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, zero failures (server startup now touches `link_preapprovals`, so the whole suite is the regression net).

- [ ] **Step 6: Commit**

```bash
git add src/server.js src/http.js test/link-http.test.js
git commit -m "Accept ttl_seconds on /link/preapprove and back the store with the DB

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `matron-admin link-code --expires`

**Files:**
- Modify: `bin/matron-admin.js`
- Test: `test/admin.test.js` (append tests)

**Interfaces:**
- Consumes: `POST /link/preapprove` with `ttl_seconds` from Task 2.
- Produces: exported `parseExpiresSeconds(text)` → integer seconds or `null` (Task 4's PNG output reuses the same expiry line formatting); `link-code … --expires <Nm|Nh>` sends `ttl_seconds`; the expiry print shows hours when ≥ 2 hours.

- [ ] **Step 1: Write the failing tests**

Append to `test/admin.test.js` (it already imports `runAdmin`, `startTestServer`, `createUser`, `openDb`):

```js
import { parseExpiresSeconds } from '../bin/matron-admin.js'

test('parseExpiresSeconds: Nm/Nh within 1m-24h, null otherwise', () => {
  assert.equal(parseExpiresSeconds('30m'), 1800)
  assert.equal(parseExpiresSeconds('1m'), 60)
  assert.equal(parseExpiresSeconds('24h'), 86400)
  assert.equal(parseExpiresSeconds('2h'), 7200)
  for (const bad of ['0m', '25h', '1441m', 'bananas', '90', 'h', '', null, '1d', '-5m', '1.5h']) {
    assert.equal(parseExpiresSeconds(bad), null, JSON.stringify(bad))
  }
})

test('link-code --expires: sends ttl_seconds and prints the expiry in hours', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'hunter22')
  const out = await runAdmin(s.db, ['link-code', 'dan', '--server-url', 'https://chat.example.com', '--port', String(s.port), '--expires', '24h'])
  assert.match(out, /expires in 24 hours and works once/)
  // the minted code really carries the long TTL
  const code = out.match(/code:\s+([0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4})/)?.[1]
  assert.ok(code, `expected a dashed code in output:\n${out}`)
  const claim = await s.http('/link/claim', { method: 'POST', body: { link_code: code, device_name: 'p' } })
  assert.equal(claim.status, 200)
})

test('link-code --expires: invalid duration fails with usage before any network call', async (t) => {
  const db = openDb(':memory:')
  // port 1 is unreachable — if the CLI tried the network first we would see
  // "not reachable" instead of the --expires usage error
  for (const bad of ['25h', '0m', 'bananas']) {
    await assert.rejects(
      () => runAdmin(db, ['link-code', 'dan', '--server-url', 'https://x.example.com', '--port', '1', '--expires', bad]),
      /--expires/
    )
  }
  db.close()
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/admin.test.js`
Expected: FAIL — the whole file fails to load because `parseExpiresSeconds` is not exported yet (`SyntaxError: The requested module '../bin/matron-admin.js' does not provide an export named 'parseExpiresSeconds'`). Confirm it is that error, not a typo.

- [ ] **Step 3: Implement in `bin/matron-admin.js`**

Update the USAGE line:

```
  matron-admin link-code <username> --server-url <url> [--port <n>] [--expires <30m|24h>] [--png <path>]
```

(The `--png` flag itself lands in Task 4; documenting it here keeps USAGE a one-touch change.)

Add next to `isValidServerUrl` (exported for tests):

```js
// --expires durations: Nm/Nh only, 1 minute to 24 hours — mirrors the
// server-side ttl_seconds bounds so a value we accept is never refused.
export function parseExpiresSeconds(text) {
  const m = /^(\d+)([mh])$/.exec(text ?? '')
  if (!m) return null
  const secs = Number(m[1]) * (m[2] === 'm' ? 60 : 3600)
  return secs >= 60 && secs <= 86400 ? secs : null
}
```

In the `link-code` branch, after the `--port` validation and before the key read:

```js
    const expiresFlag = flag(argv, '--expires')
    let ttlSeconds = null
    if (expiresFlag != null) {
      ttlSeconds = parseExpiresSeconds(expiresFlag)
      if (ttlSeconds == null) {
        throw new Error(`${USAGE}\n\n--expires must be minutes or hours between 1m and 24h, like 30m or 24h (got ${JSON.stringify(expiresFlag)})`)
      }
    }
```

Change the fetch body:

```js
        body: JSON.stringify(ttlSeconds != null ? { username, ttl_seconds: ttlSeconds } : { username }),
```

Replace the final expiry line of the output array with an hours-aware version:

```js
      // expires_in may be absent from an older/nonstandard journal response;
      // print the code either way rather than "expires in NaN minutes".
      Number.isFinite(expires_in) ? `The code ${formatExpiry(expires_in)} and works once.` : 'The code works once.',
```

and add next to `parseExpiresSeconds`:

```js
function formatExpiry(expiresInSeconds) {
  const mins = Math.round(expiresInSeconds / 60)
  return mins >= 120 ? `expires in ${Math.round(mins / 60)} hours` : `expires in ${mins} minutes`
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/admin.test.js`
Expected: PASS — including the pre-existing link-code tests (the default 600 s path still prints "expires in 10 minutes and works once").

- [ ] **Step 5: Commit**

```bash
git add bin/matron-admin.js test/admin.test.js
git commit -m "matron-admin link-code: --expires for long-lived hand-off codes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `matron-admin link-code --png`

**Files:**
- Modify: `package.json` (add dependency `"qrcode": "^1.5.4"` — run `npm install qrcode`, which also updates `package-lock.json`)
- Modify: `bin/matron-admin.js`
- Test: `test/admin.test.js` (append tests)

**Interfaces:**
- Consumes: `formatExpiry` from Task 3; the existing `uri` / `link_code` / `expires_in` locals in the `link-code` branch.
- Produces: `--png <path>` mode — QR PNG at `<path>` with mode 0600, scp + delete hints using `os.hostname()`, terminal QR suppressed, manual-entry fallback retained.

- [ ] **Step 1: Install the dependency**

Run: `npm install qrcode`
Expected: `package.json` gains `"qrcode"` under dependencies; `npm test` still passes (no code uses it yet).

- [ ] **Step 2: Write the failing tests**

Append to `test/admin.test.js`:

```js
test('link-code --png: writes a 0600 PNG, prints scp+rm hints, suppresses the ANSI QR', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'hunter22')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-admin-png-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pngPath = path.join(dir, 'link.png')

  const out = await runAdmin(s.db, ['link-code', 'dan', '--server-url', 'https://chat.example.com', '--port', String(s.port), '--expires', '24h', '--png', pngPath])

  const buf = fs.readFileSync(pngPath)
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]) // PNG magic
  assert.equal(fs.statSync(pngPath).mode & 0o777, 0o600)
  assert.match(out, /scp .*link\.png/)
  assert.match(out, /rm .*link\.png/)
  assert.match(out, /treat it like a password/)
  assert.match(out, /expires in 24 hours/)
  assert.doesNotMatch(out, /▄|█/) // no ANSI QR in file mode

  // the manual-entry fallback still carries a working code
  const code = out.match(/code:\s+([0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4})/)?.[1]
  assert.ok(code, `expected a dashed code in output:\n${out}`)
  const claim = await s.http('/link/claim', { method: 'POST', body: { link_code: code, device_name: 'p' } })
  assert.equal(claim.status, 200)
})

test('link-code --png: unwritable path fails before minting (unreachable port never contacted)', async (t) => {
  const db = openDb(':memory:')
  await assert.rejects(
    () => runAdmin(db, ['link-code', 'dan', '--server-url', 'https://x.example.com', '--port', '1', '--png', '/nonexistent-dir/never/link.png']),
    /cannot write --png file/
  )
  await assert.rejects(
    () => runAdmin(db, ['link-code', 'dan', '--server-url', 'https://x.example.com', '--port', '1', '--png']),
    /--png needs a file path/
  )
  db.close()
})
```

(`fs`, `os`, `path`, `openDb` are already imported at the top of `test/admin.test.js`.)

- [ ] **Step 3: Run to verify they fail**

Run: `node --test test/admin.test.js`
Expected: the two new tests FAIL — no `--png` handling exists yet, so the happy-path test errors on the missing file and the guard test sees a different error message.

- [ ] **Step 4: Implement in `bin/matron-admin.js`**

Add imports at the top:

```js
import os from 'node:os'
import QRCode from 'qrcode'
```

In the `link-code` branch, immediately after the `--expires` block from Task 3 (still before the key read and the fetch — a bad path must never mint a code):

```js
    const wantsPng = argv.includes('--png')
    const pngPath = flag(argv, '--png')
    if (wantsPng && !pngPath) throw new Error(`${USAGE}\n\n--png needs a file path`)
    let pngFd = null
    if (wantsPng) {
      // Open (and 0600) the file BEFORE minting: an unwritable path must
      // never orphan a live pre-approved code on the server.
      try {
        pngFd = fs.openSync(pngPath, 'w', 0o600)
        fs.fchmodSync(pngFd, 0o600) // openSync's mode only applies to newly created files
      } catch (e) {
        throw new Error(`cannot write --png file at ${pngPath} (${e.code || e.message})`)
      }
    }
```

Then replace the QR-rendering/return block at the end of the branch:

```js
    const uri = `matron://link?v=1&server=${encodeURIComponent(serverUrl)}&code=${link_code}`
    const expiryLine = Number.isFinite(expires_in) ? `The code ${formatExpiry(expires_in)} and works once.` : 'The code works once.'
    if (pngFd != null) {
      fs.writeSync(pngFd, await QRCode.toBuffer(uri, { type: 'png', scale: 8 }))
      fs.closeSync(pngFd)
      const host = os.hostname()
      return [
        `Wrote sign-in QR to ${pngPath} (mode 0600).`,
        `Scanning it signs a phone in as ${username} with no approval step — treat it like a password.`,
        expiryLine,
        '',
        'Copy it off this box, then delete it:',
        `  scp ${host}:${pngPath} .`,
        `  ssh ${host} rm ${pngPath}`,
        '',
        'Manual entry fallback (sign-in screen):',
        `  server: ${serverUrl}`,
        `  code:   ${link_code}`,
      ].join('\n')
    }
    const qr = await new Promise((resolve) => qrcode.generate(uri, { small: true }, resolve))
    return [
      qr,
      `Scan with the Matron app to sign in as ${username}.`,
      'Or enter it manually on the sign-in screen:',
      `  server: ${serverUrl}`,
      `  code:   ${link_code}`,
      `(${uri})`,
      expiryLine,
    ].join('\n')
```

(This folds Task 3's expiry line into the shared `expiryLine` local — both output modes use it.)

- [ ] **Step 5: Run to verify they pass**

Run: `node --test test/admin.test.js`
Expected: PASS, all tests.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, zero failures.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json bin/matron-admin.js test/admin.test.js
git commit -m "matron-admin link-code: --png file export with scp/delete hints

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
