# Tracker Web — Journal Plan B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the journal side of the tracker web/teams design: journal admins and their user-management routes, static hosting of the web app with history fallback, the app-link well-known files, and encryption at rest for stored GitHub tokens.

**Architecture:** Four independent additions to the existing Node HTTP server, each its own module mounted from `src/http.js` in the order the request pipeline already uses (unauthenticated handlers before the Bearer check, authenticated handlers after). `users-http.js` gates on a new `users.is_admin` flag and reuses the auth helpers `matron-admin` already calls. `static-http.js` and `well-known.js` are pure request handlers configured from env at boot and inert when unconfigured. `token-box.js` is an AES-256-GCM seal/open pair; `github-accounts.js` stores sealed tokens plus a SHA-256 `token_hash` so the refresh path's "only touch the row I read" guard keeps working without plaintext equality.

**Tech Stack:** Node ≥ 20 ESM, better-sqlite3, `node:crypto`, `node --test` with `node:assert/strict`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-tracker-web-teams-and-item-links-design.md` — sections "Data model" (`is_admin`, "Token at rest"), "HTTP API changes" (User administration, Self-service), "Static hosting", "Security notes", "Testing". Plan A (`docs/superpowers/plans/2026-09-23-tracker-visibility-journal-core.md`) shipped everything else on this branch.

## Global Constraints

- Node `>=20`, ESM, no new npm dependencies (`node:crypto` only).
- Every new route follows `src/http-who.js` conventions: `badRequest`, `notFound`, `conflict` responders; errors are `{error: '<code>'}` JSON. Invisible or unknown rows answer `404 not_found`; a caller who is not allowed to use an admin surface answers `403 forbidden`.
- Admin routes are for client devices whose user has `is_admin = 1`. Agents (the bridge) are never admins, whatever their user's flag.
- `MATRON_WEB_DIR` unset → every request behaves exactly as today. Static serving is read-only, rejects path traversal and dot-segments, and serves the directory's `index.html` only for `/u/*` and `/app/*`.
- `GET /.well-known/apple-app-site-association` and `GET /.well-known/assetlinks.json` are `404 not_found` unless their env is set; both are unauthenticated.
- The GitHub token is never returned by any route and never logged. With `MATRON_TOKEN_KEY` set (64 hex chars) tokens are stored sealed (`enc1:` prefix); unset keeps today's plaintext. Existing rows are sealed at boot when a key appears.
- better-sqlite3 forbids mixing named (`@x`) and positional (`?`) parameters in one statement.
- Commit subjects ≤ 72 chars; every commit message ends with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; never reference Matron tracker items by number in commits or code.

## Review Focus

1. A non-admin client (or any agent) calling any `/users` route gets `403 forbidden` and learns nothing — not even whether a user id exists. Pinned in Task 2's test (agent and non-admin client on every verb).
2. Demoting the last admin via `PATCH /users/:id {is_admin:false}` would lock everyone out of the admin surface; it must answer `409 conflict` and change nothing. Pinned in Task 2.
3. A traversal attempt at the static handler — `/../etc/passwd`, `%2e%2e%2f`, a backslash, or a dot-segment like `/.git/config` inside the web dir — must never read outside the directory or serve a dotfile, and must fall through to the API's 404 rather than a static one. Pinned in Task 3.
4. A tool resolving a pasted link with `GET /u/dan/12` and `Accept: application/json` must reach the authenticated lookup route, not receive `index.html`, when `MATRON_WEB_DIR` is set. Pinned in Task 3.
5. A journal restarted without `MATRON_TOKEN_KEY` after tokens were sealed must not crash, must not mark links stale, and must log that the token is unreadable; unlink and re-link still work. Pinned in Task 5.

---

### Task 1: `users.is_admin`, `matron-admin user admin`, `is_admin` on `/me`

**Files:**
- Modify: `src/db.js` (after the `github_link_confirms` block)
- Modify: `bin/matron-admin.js` (USAGE and `runAdmin`)
- Modify: `src/http.js` (`GET /me`)
- Test: `test/db.test.js`, `test/admin.test.js`, `test/github-http.test.js` (append)

**Interfaces:**
- Consumes: `openDb`, `createUser`.
- Produces: column `users.is_admin INTEGER NOT NULL DEFAULT 0`; CLI `matron-admin user admin <name> on|off`; `GET /me` → `{user: {id, name, is_admin}, github, github_linking}`.

- [ ] **Step 1: Write the failing tests**

Append to `test/db.test.js`:
```js
test('openDb adds users.is_admin (default 0) to a pre-existing users table in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-admin-migration-'))
  const dbPath = path.join(dir, 'pre-admin.db')
  const raw = new Database(dbPath)
  raw.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL)')
  raw.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  raw.close()
  const db = openDb(dbPath)
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name)
  assert.ok(cols.includes('is_admin'), 'is_admin column missing after migration')
  assert.deepEqual(db.prepare('SELECT id, name, is_admin FROM users').all(), [{ id: 1, name: 'dan', is_admin: 0 }])
  db.close()
  assert.doesNotThrow(() => openDb(dbPath).close())
  fs.rmSync(dir, { recursive: true, force: true })
})
```

Append to `test/admin.test.js`:
```js
test('admin CLI: user admin on|off flips users.is_admin; unknown user and bad value are usage errors', async () => {
  const db = openDb(':memory:')
  await runAdmin(db, ['user', 'add', 'dan', '--password', 'pw123456'])
  assert.equal(db.prepare("SELECT is_admin FROM users WHERE name='dan'").get().is_admin, 0)
  assert.match(await runAdmin(db, ['user', 'admin', 'dan', 'on']), /dan is now a journal admin/)
  assert.equal(db.prepare("SELECT is_admin FROM users WHERE name='dan'").get().is_admin, 1)
  assert.match(await runAdmin(db, ['user', 'admin', 'dan', 'off']), /dan is no longer a journal admin/)
  assert.equal(db.prepare("SELECT is_admin FROM users WHERE name='dan'").get().is_admin, 0)
  await assert.rejects(runAdmin(db, ['user', 'admin', 'nobody', 'on']), /no such user/)
  await assert.rejects(runAdmin(db, ['user', 'admin', 'dan', 'maybe']), /usage/i)
  await assert.rejects(runAdmin(db, ['user', 'admin', 'dan']), /usage/i)
})
```

Append to `test/github-http.test.js`:
```js
test('GET /me reports is_admin', async (t) => {
  const { s, dan, danTok, agent } = await fleet(t, fakeGithub())
  assert.equal((await s.http('/me', { token: danTok })).json.user.is_admin, false)
  s.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(dan.id)
  assert.deepEqual((await s.http('/me', { token: danTok })).json.user, { id: dan.id, name: 'dan', is_admin: true })
  assert.equal((await s.http('/me', { token: agent.token })).json.user.is_admin, true, '/me describes the user, not the device')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/db.test.js test/admin.test.js test/github-http.test.js`
Expected: FAIL — no `is_admin` column, `user admin` hits USAGE, `/me` has no `is_admin`.

- [ ] **Step 3: Migration in `src/db.js`**

Directly after the `db.exec(\`... github_link_confirms ... \`)` block:
```js
  // Journal admins (spec 2026-09-23 tracker web/teams, "User
  // administration"). Bootstrapped from the shell with
  // `matron-admin user admin <name> on`; the users admin routes need at
  // least one. Default 0: an upgraded journal has no admin until someone
  // with shell access says so.
  const userCols = db.prepare('PRAGMA table_info(users)').all()
  if (!userCols.some((c) => c.name === 'is_admin')) {
    db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0')
  }
```

- [ ] **Step 4: CLI in `bin/matron-admin.js`**

Add to USAGE after the `user passwd` line:
```
  matron-admin user admin <name> on|off
```
In `runAdmin`, after the `user passwd` branch:
```js
  if (a === 'user' && b === 'admin') {
    const name = argv[2]
    const value = argv[3]
    if (!name || (value !== 'on' && value !== 'off')) throw new Error(USAGE)
    const r = db.prepare('UPDATE users SET is_admin=? WHERE name=?').run(value === 'on' ? 1 : 0, name)
    if (r.changes === 0) throw new Error(`no such user: ${name}`)
    return value === 'on' ? `${name} is now a journal admin` : `${name} is no longer a journal admin`
  }
```

- [ ] **Step 5: `/me` in `src/http.js`**

Replace the `/me` handler's user query and shape:
```js
        const user = db.prepare('SELECT id, name, is_admin FROM users WHERE id=?').get(who.userId)
        return json(res, 200, {
          user: { id: user.id, name: user.name, is_admin: !!user.is_admin },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/db.test.js test/admin.test.js test/github-http.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db.js bin/matron-admin.js src/http.js test/db.test.js test/admin.test.js test/github-http.test.js
git commit -m "journal: users.is_admin, matron-admin user admin, is_admin on /me"
```

---

### Task 2: Users admin routes (`src/users-http.js`)

**Files:**
- Create: `src/users-http.js`
- Modify: `src/http.js` (mount after `handleLookupRoute`)
- Test: `test/users-http.test.js`

**Interfaces:**
- Consumes: `createUser(db, name, password)`, `setPassword(db, name, password)` (auth.js); `deleteGithubAccount(db, userId)` (github-accounts.js); `links.startPreapproved(userId, {ttlMs}) → {linkCode, expiresIn} | null` (link.js, already in `makeHttpHandler`'s `links`); `users.is_admin` (Task 1).
- Produces: `handleUsersRoute({db, links}, req, res, url, who) -> Promise<boolean>`; `isAdmin(db, who) -> boolean`; `USERNAME_RE`. Routes: `GET /users`, `POST /users {name, password, is_admin?}` → 201 `{user}`, `PATCH /users/:id {is_admin}` → `{user}`, `POST /users/:id/password {password}` → `{ok:true}`, `DELETE /users/:id/github-link` → `{ok:true}`, `POST /users/:id/link-code {ttl_seconds?}` → `{link_code, expires_in}`. User shape: `{id, name, is_admin, created_at, github: {login, state, host} | null}`.

Note: the spec writes the link-code body as `{expires}`; this plan names it `ttl_seconds` with the same bounds (`60..86400`) as the existing `POST /link/preapprove`, so the two mint routes take one vocabulary. Document it that way in Task 6.

- [ ] **Step 1: Write the failing test**

Create `test/users-http.test.js`:
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent, login } from '../src/auth.js'
import { saveGithubIdentity, githubAccountView } from '../src/github-accounts.js'

async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const root = await createUser(s.db, 'root', 'pw123456')
  const dan = await createUser(s.db, 'dan', 'pw123456')
  s.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(root.id)
  const rootAgent = createAgent(s.db, root.id, 'root-box')
  const tok = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw123456', device_name: 'mac' } })).json.token
  return { s, root, dan, rootAgent, rootTok: await tok('root'), danTok: await tok('dan') }
}

test('users admin: every route is 403 for a non-admin client and for an admin\'s own agent, and says nothing about ids (review focus 1)', async (t) => {
  const { s, dan, rootAgent, danTok } = await fleet(t)
  const calls = [
    ['/users', 'GET'], ['/users', 'POST', { name: 'x', password: 'pw123456' }],
    [`/users/${dan.id}`, 'PATCH', { is_admin: true }], ['/users/999', 'PATCH', { is_admin: true }],
    [`/users/${dan.id}/password`, 'POST', { password: 'pw123456' }],
    [`/users/${dan.id}/github-link`, 'DELETE'], [`/users/${dan.id}/link-code`, 'POST', {}],
  ]
  for (const token of [danTok, rootAgent.token]) {
    for (const [path, method, body] of calls) {
      const r = await s.http(path, { method, token, body })
      assert.equal(r.status, 403, `${method} ${path} for ${token === danTok ? 'non-admin' : 'agent'}`)
      assert.deepEqual(r.json, { error: 'forbidden' })
    }
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2)
})

test('users admin: list, create (validated, 409 on a taken name), reset password, flip admin, last-admin guard (review focus 2)', async (t) => {
  const { s, root, dan, rootTok } = await fleet(t)
  saveGithubIdentity(s.db, { userId: dan.id, host: 'github.com', identity: { github_id: 5, login: 'DanB', scopes: [] }, token: 'tok', now: 1 })
  const list = await s.http('/users', { token: rootTok })
  assert.equal(list.status, 200)
  assert.deepEqual(list.json.users.map((u) => [u.name, u.is_admin, u.github && u.github.login]), [['root', true, null], ['dan', false, 'DanB']])
  assert.ok(!JSON.stringify(list.json).includes('tok'), 'no token in the listing')
  assert.ok(!JSON.stringify(list.json).includes('password'), 'no hash in the listing')

  const made = await s.http('/users', { method: 'POST', token: rootTok, body: { name: 'pat', password: 'pw123456' } })
  assert.equal(made.status, 201)
  assert.deepEqual({ name: made.json.user.name, is_admin: made.json.user.is_admin, github: made.json.user.github }, { name: 'pat', is_admin: false, github: null })
  assert.ok((await login(s.db, { username: 'pat', password: 'pw123456', deviceName: 'ph' })).token, 'the new user can sign in')
  assert.equal((await s.http('/users', { method: 'POST', token: rootTok, body: { name: 'pat', password: 'pw123456' } })).status, 409)
  assert.equal((await s.http('/users', { method: 'POST', token: rootTok, body: { name: 'bad name', password: 'pw123456' } })).status, 400)
  assert.equal((await s.http('/users', { method: 'POST', token: rootTok, body: { name: '../x', password: 'pw123456' } })).status, 400)
  const weak = await s.http('/users', { method: 'POST', token: rootTok, body: { name: 'sam', password: 'short' } })
  assert.equal(weak.status, 400); assert.equal(weak.json.error, 'weak_password')
  const admin2 = await s.http('/users', { method: 'POST', token: rootTok, body: { name: 'sam', password: 'pw123456', is_admin: true } })
  assert.equal(admin2.json.user.is_admin, true)

  assert.equal((await s.http(`/users/${dan.id}/password`, { method: 'POST', token: rootTok, body: { password: 'newpw12345' } })).status, 200)
  assert.ok((await login(s.db, { username: 'dan', password: 'newpw12345', deviceName: 'ph' })).token)
  assert.equal((await s.http(`/users/${dan.id}/password`, { method: 'POST', token: rootTok, body: { password: 'short' } })).json.error, 'weak_password')
  assert.equal((await s.http('/users/999/password', { method: 'POST', token: rootTok, body: { password: 'newpw12345' } })).status, 404)

  const promoted = await s.http(`/users/${dan.id}`, { method: 'PATCH', token: rootTok, body: { is_admin: true } })
  assert.equal(promoted.status, 200); assert.equal(promoted.json.user.is_admin, true)
  assert.equal((await s.http(`/users/${dan.id}`, { method: 'PATCH', token: rootTok, body: { is_admin: 'yes' } })).status, 400)
  // root, dan, sam are admins now; demote two, then the last one is refused.
  assert.equal((await s.http(`/users/${dan.id}`, { method: 'PATCH', token: rootTok, body: { is_admin: false } })).status, 200)
  assert.equal((await s.http(`/users/${admin2.json.user.id}`, { method: 'PATCH', token: rootTok, body: { is_admin: false } })).status, 200)
  const last = await s.http(`/users/${root.id}`, { method: 'PATCH', token: rootTok, body: { is_admin: false } })
  assert.equal(last.status, 409); assert.equal(last.json.reason, 'last_admin')
  assert.equal(s.db.prepare('SELECT is_admin FROM users WHERE id=?').get(root.id).is_admin, 1)
  assert.equal((await s.http('/users/999', { method: 'PATCH', token: rootTok, body: { is_admin: true } })).status, 404)
})

test('users admin: clearing a GitHub link and minting a link code', async (t) => {
  const { s, dan, rootTok } = await fleet(t)
  assert.equal((await s.http(`/users/${dan.id}/github-link`, { method: 'DELETE', token: rootTok })).status, 404, 'nothing linked yet')
  saveGithubIdentity(s.db, { userId: dan.id, host: 'github.com', identity: { github_id: 5, login: 'DanB', scopes: ['github.com/matronhq'] }, token: 'tok', now: 1 })
  assert.deepEqual((await s.http(`/users/${dan.id}/github-link`, { method: 'DELETE', token: rootTok })).json, { ok: true })
  assert.equal(githubAccountView(s.db, dan.id), null)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM github_orgs WHERE user_id=?').get(dan.id).n, 0)

  const code = await s.http(`/users/${dan.id}/link-code`, { method: 'POST', token: rootTok, body: {} })
  assert.equal(code.status, 200)
  assert.match(code.json.link_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  assert.equal(code.json.expires_in, 600)
  const short = await s.http(`/users/${dan.id}/link-code`, { method: 'POST', token: rootTok, body: { ttl_seconds: 120 } })
  assert.equal(short.json.expires_in, 120)
  // The minted code signs a device in as dan, no approval tap.
  const claim = await s.http('/link/claim', { method: 'POST', body: { link_code: short.json.link_code, device_name: 'dans phone' } })
  assert.equal(claim.status, 200)
  const poll = await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })
  assert.equal(poll.json.status, 'approved')
  assert.equal(s.db.prepare("SELECT user_id FROM devices WHERE name='dans phone'").get().user_id, dan.id)
  for (const bad of [{ ttl_seconds: 30 }, { ttl_seconds: 90000 }, { ttl_seconds: '120' }]) {
    assert.equal((await s.http(`/users/${dan.id}/link-code`, { method: 'POST', token: rootTok, body: bad })).status, 400)
  }
  assert.equal((await s.http('/users/999/link-code', { method: 'POST', token: rootTok, body: {} })).status, 404)
})
```
(`POST /link/claim {link_code, device_name}` → `{status:'claimed', claim_token}` and `POST /link/poll {claim_token}` → `{status:'approved', token, device_id, user_id, username}` are the existing routes in `src/http.js`; the pre-approved default TTL is `makeLinkStore`'s `preapprovedTtlMs = 600000`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/users-http.test.js`
Expected: FAIL — 404 on every `/users` path.

- [ ] **Step 3: Write `src/users-http.js`**

```js
// Journal user administration (spec 2026-09-23 tracker web/teams, "User
// administration"). The web app's admin page and nothing else: client
// devices whose user carries users.is_admin=1. Everyone else — a plain
// user, and every agent whatever its user's flag — gets one 403 for every
// verb, before any id is looked up, so the surface leaks nothing. Mirrors
// matron-admin: create, reset password, admin flag, clear a GitHub link,
// mint a pairing code.
import { json, readBody } from './http-body.js'
import { badRequest, notFound, conflict } from './http-who.js'
import { createUser, setPassword } from './auth.js'
import { deleteGithubAccount } from './github-accounts.js'

// A journal name is a URL path segment in shareable links (/u/<name>/<n>)
// and a sender prefix (user:<name>), so it is ASCII, starts alphanumeric,
// and is at most 64 characters.
export const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const PASSWORD_MIN = 8
const TTL_MIN_S = 60
const TTL_MAX_S = 86400

const forbidden = (res) => { json(res, 403, { error: 'forbidden' }); return true }
const weakPassword = (res) => { json(res, 400, { error: 'weak_password' }); return true }

export function isAdmin(db, who) {
  if (!who || who.kind !== 'client') return false
  const row = db.prepare('SELECT is_admin FROM users WHERE id=?').get(who.userId)
  return !!(row && row.is_admin)
}

const USER_SQL = `SELECT u.id, u.name, u.is_admin, u.created_at,
    ga.login AS github_login, ga.state AS github_state, ga.host AS github_host
  FROM users u LEFT JOIN github_accounts ga ON ga.user_id = u.id`
const userRow = (db, id) => db.prepare(`${USER_SQL} WHERE u.id=?`).get(id)
const shape = (r) => ({
  id: r.id, name: r.name, is_admin: !!r.is_admin, created_at: r.created_at,
  github: r.github_login ? { login: r.github_login, state: r.github_state, host: r.github_host } : null,
})

export async function handleUsersRoute(ctx, req, res, url, who) {
  const { db, links } = ctx
  const path = url.pathname
  if (path !== '/users' && !path.startsWith('/users/')) return false
  if (!isAdmin(db, who)) return forbidden(res)

  if (path === '/users' && req.method === 'GET') {
    json(res, 200, { users: db.prepare(`${USER_SQL} ORDER BY u.id`).all().map(shape) })
    return true
  }
  if (path === '/users' && req.method === 'POST') {
    const { name, password, is_admin = false } = await readBody(req)
    if (typeof name !== 'string' || !USERNAME_RE.test(name)) return badRequest(res)
    if (typeof is_admin !== 'boolean') return badRequest(res)
    if (typeof password !== 'string' || password.length < PASSWORD_MIN) return weakPassword(res)
    if (db.prepare('SELECT 1 FROM users WHERE name=?').get(name)) return conflict(res)
    const u = await createUser(db, name, password)
    if (is_admin) db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(u.id)
    json(res, 201, { user: shape(userRow(db, u.id)) })
    return true
  }

  const m = path.match(/^\/users\/(\d+)(?:\/(password|github-link|link-code))?$/)
  if (!m) return notFound(res)
  const target = userRow(db, Number(m[1]))
  if (!target) return notFound(res)
  const sub = m[2]

  if (!sub && req.method === 'PATCH') {
    const { is_admin } = await readBody(req)
    if (typeof is_admin !== 'boolean') return badRequest(res)
    // The admin surface must never become unreachable from inside the app:
    // the last admin cannot demote themselves (or be demoted).
    if (!is_admin && target.is_admin && db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin=1').get().n === 1) {
      return conflict(res, { reason: 'last_admin' })
    }
    db.prepare('UPDATE users SET is_admin=? WHERE id=?').run(is_admin ? 1 : 0, target.id)
    json(res, 200, { user: shape(userRow(db, target.id)) })
    return true
  }
  if (sub === 'password' && req.method === 'POST') {
    const { password } = await readBody(req)
    if (typeof password !== 'string' || password.length < PASSWORD_MIN) return weakPassword(res)
    // Same semantics as `matron-admin user passwd`: device tokens stay valid.
    await setPassword(db, target.name, password)
    json(res, 200, { ok: true })
    return true
  }
  if (sub === 'github-link' && req.method === 'DELETE') {
    if (!deleteGithubAccount(db, target.id)) return notFound(res)
    json(res, 200, { ok: true })
    return true
  }
  if (sub === 'link-code' && req.method === 'POST') {
    const { ttl_seconds } = await readBody(req)
    if (ttl_seconds !== undefined && (!Number.isInteger(ttl_seconds) || ttl_seconds < TTL_MIN_S || ttl_seconds > TTL_MAX_S)) return badRequest(res)
    // The same pre-approved session POST /link/preapprove mints for the
    // CLI; the web app builds the matron://link URI from its own origin.
    const l = links.startPreapproved(target.id, ttl_seconds !== undefined ? { ttlMs: ttl_seconds * 1000 } : {})
    if (!l) { json(res, 429, { error: 'rate_limited' }); return true }
    json(res, 200, { link_code: l.linkCode, expires_in: l.expiresIn })
    return true
  }
  return notFound(res)
}
```

- [ ] **Step 4: Mount in `src/http.js`**

Import `handleUsersRoute` from `./users-http.js` and, directly after the `handleLookupRoute` mount:
```js
      if (await handleUsersRoute({ db, links }, req, res, url, who)) return
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/users-http.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/users-http.js src/http.js test/users-http.test.js
git commit -m "journal: users admin routes for journal admins"
```

---

### Task 3: Static hosting of the web app (`src/static-http.js`)

**Files:**
- Create: `src/static-http.js`
- Modify: `src/server.js` (option `webDir`, env `MATRON_WEB_DIR`, pass to handler)
- Modify: `src/http.js` (mount at the top of the handler, before `/login`)
- Test: `test/static-http.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `resolveWebDir(raw) -> string | null` (throws if set but not a directory); `makeStaticHandler({webDir}) -> (req, res, url) => Promise<boolean>`; `makeHttpHandler` gains `handleStatic` (a function; the default is `() => false`); `startServer` option `webDir` (default `process.env.MATRON_WEB_DIR || null`).

Behaviour: GET/HEAD only. `/` → 302 `/app/`. An existing regular file under the dir is served with its extension's content type, `nosniff`, `x-frame-options: DENY` on HTML, `cache-control: public, max-age=31536000, immutable` under `/assets/` and `no-cache` elsewhere. `/u/*`, `/app` and `/app/*` fall back to `index.html` unless the request's `Accept` names `application/json` (those reach the API's lookup route). Anything with a dot-segment, a backslash, a NUL, a path that resolves outside the dir, or no matching file falls through (`false`) so the API's own 401/404 answers as today.

- [ ] **Step 1: Write the failing test**

Create `test/static-http.test.js`:
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestServer } from './helpers.js'
import { createUser } from '../src/auth.js'
import { resolveWebDir } from '../src/static-http.js'

function webDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-web-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Matron</title>')
  fs.mkdirSync(path.join(dir, 'assets'))
  fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)')
  fs.writeFileSync(path.join(dir, 'favicon.svg'), '<svg/>')
  fs.mkdirSync(path.join(dir, '.git'))
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]')
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1')
  fs.writeFileSync(path.join(path.dirname(dir), 'outside.txt'), 'outside')
  return dir
}

test('static: files, index fallback for /u/* and /app/*, root redirect, HEAD, cache headers', async (t) => {
  const dir = webDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const s = await startTestServer({ webDir: dir })
  t.after(() => s.close())
  const get = (p, headers = {}, method = 'GET') => fetch(s.base + p, { method, headers, redirect: 'manual' })

  const idx = await get('/u/dan/12')
  assert.equal(idx.status, 200)
  assert.match(idx.headers.get('content-type'), /^text\/html/)
  assert.equal(idx.headers.get('cache-control'), 'no-cache')
  assert.equal(idx.headers.get('x-frame-options'), 'DENY')
  assert.equal(idx.headers.get('x-content-type-options'), 'nosniff')
  assert.match(await idx.text(), /Matron/)
  for (const p of ['/app', '/app/', '/app/items/it_1', '/u/dan/1?x=1']) assert.equal((await get(p)).status, 200, p)

  const asset = await get('/assets/app-abc123.js')
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('content-type'), /^text\/javascript/)
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(await asset.text(), 'console.log(1)')
  assert.match((await get('/favicon.svg')).headers.get('content-type'), /^image\/svg\+xml/)

  const head = await get('/assets/app-abc123.js', {}, 'HEAD')
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '14'); assert.equal(await head.text(), '')

  const root = await get('/')
  assert.equal(root.status, 302); assert.equal(root.headers.get('location'), '/app/')

  // A path that is neither a file nor a fallback prefix is the API's 404/401, not a static one.
  assert.equal((await get('/nope.js')).status, 401)
  assert.equal((await get('/items')).status, 401)
  assert.equal((await get('/u/dan/12', {}, 'POST')).status, 401, 'static is GET/HEAD only')
})

test('static: traversal, dot-segments, backslashes and NUL never serve; JSON Accept on /u/* reaches the lookup route (review focus 3, 4)', async (t) => {
  const dir = webDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const s = await startTestServer({ webDir: dir })
  t.after(() => s.close())
  const get = (p, headers = {}) => fetch(s.base + p, { headers, redirect: 'manual' })
  for (const p of ['/../outside.txt', '/%2e%2e/outside.txt', '/assets/%2e%2e/%2e%2e/outside.txt', '/.git/config', '/.env', '/app/../.env', '/assets/..%5c..%5coutside.txt', '/assets/app-abc123.js%00.html', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd']) {
    const r = await get(p)
    assert.equal(r.status, 401, `${p} fell through to the API (unauthenticated)`)
    assert.ok(!(await r.text()).includes('outside'), `${p} leaked a file outside the web dir`)
  }
  assert.equal((await get('/assets/')).status, 401, 'a directory is not a file')
  await createUser(s.db, 'dan', 'pw123456')
  const tok = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw123456', device_name: 'mac' } })).json.token
  const r = await get('/u/dan/1', { authorization: `Bearer ${tok}`, accept: 'application/json' })
  assert.equal(r.status, 404, 'the JSON lookup answered (404: dan has no item 1), not index.html')
  assert.deepEqual(await r.json(), { error: 'not_found' })
})

test('static: unset MATRON_WEB_DIR changes nothing; a missing index.html makes the fallbacks fall through; a bad dir fails at boot', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  assert.equal((await fetch(s.base + '/u/dan/12')).status, 401)
  assert.equal((await fetch(s.base + '/', { redirect: 'manual' })).status, 401)
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-web-bare-'))
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }))
  const s2 = await startTestServer({ webDir: bare })
  t.after(() => s2.close())
  assert.equal((await fetch(s2.base + '/app/x')).status, 401)
  assert.equal(resolveWebDir(''), null)
  assert.equal(resolveWebDir(undefined), null)
  assert.throws(() => resolveWebDir(path.join(bare, 'missing')), /MATRON_WEB_DIR/)
  fs.writeFileSync(path.join(bare, 'a-file.txt'), '')
  assert.throws(() => resolveWebDir(path.join(bare, 'a-file.txt')), /MATRON_WEB_DIR/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/static-http.test.js`
Expected: FAIL — `static-http.js` missing; every static path answers 401.

- [ ] **Step 3: Write `src/static-http.js`**

```js
// Static hosting of the tracker web app (spec 2026-09-23 tracker
// web/teams, "Static hosting"). Inert unless MATRON_WEB_DIR is set. Serves
// files under that directory read-only, and the directory's index.html for
// the app's client-side routes (/u/*, /app/*). Mounted before Bearer auth
// — a browser has no token when it loads the app — so it must never be a
// way to read anything but that directory: the resolved path is checked
// against the root, dot-segments (.git, .env, ..) never serve, and
// anything it does not own falls through to the API's own 401/404.
import fs from 'node:fs'
import path from 'node:path'

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
}
export const FALLBACK_PREFIXES = ['/u/', '/app/']

export function resolveWebDir(raw) {
  if (!raw) return null
  const dir = path.resolve(raw)
  let st
  try { st = fs.statSync(dir) } catch { throw new Error(`MATRON_WEB_DIR ${raw} does not exist`) }
  if (!st.isDirectory()) throw new Error(`MATRON_WEB_DIR ${raw} is not a directory`)
  return dir
}

export function makeStaticHandler({ webDir }) {
  if (!webDir) return async () => false
  const index = path.join(webDir, 'index.html')

  async function send(req, res, file, { immutable }) {
    const st = await fs.promises.stat(file)
    const ext = path.extname(file).toLowerCase()
    const type = TYPES[ext] || 'application/octet-stream'
    const headers = {
      'content-type': type,
      'content-length': String(st.size),
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    }
    if (ext === '.html') headers['x-frame-options'] = 'DENY'
    res.writeHead(200, headers)
    if (req.method === 'HEAD') { res.end(); return true }
    await new Promise((resolve) => {
      const stream = fs.createReadStream(file)
      stream.on('error', () => { res.destroy(); resolve() })
      stream.on('close', resolve)
      stream.pipe(res)
    })
    return true
  }

  return async function handleStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    let pathname
    try { pathname = decodeURIComponent(url.pathname) } catch { return false }
    if (pathname.includes('\0') || pathname.includes('\\')) return false
    if (pathname === '/') { res.writeHead(302, { location: '/app/' }); res.end(); return true }
    // No dot-segment ever serves: that covers `..`, `.git`, `.env`, and
    // leaves /.well-known to its own handler.
    if (pathname.split('/').some((seg) => seg.startsWith('.'))) return false
    const abs = path.resolve(webDir, '.' + pathname)
    if (abs !== webDir && !abs.startsWith(webDir + path.sep)) return false
    const isFallback = pathname === '/app' || FALLBACK_PREFIXES.some((p) => pathname.startsWith(p))
    // A tool resolving a link asks for JSON; that is the API's lookup route.
    if (isFallback && /application\/json/.test(req.headers.accept || '')) return false
    let st = null
    try { st = await fs.promises.stat(abs) } catch { /* not a file here */ }
    if (st && st.isFile()) return send(req, res, abs, { immutable: pathname.startsWith('/assets/') })
    if (isFallback) {
      try { await fs.promises.access(index) } catch { return false }
      return send(req, res, index, { immutable: false })
    }
    return false
  }
}
```

- [ ] **Step 4: Wire `src/server.js` and `src/http.js`**

`src/server.js`: import `{ resolveWebDir, makeStaticHandler }` from `./static-http.js`; add `webDir` to `startServer`'s destructured options; before `http.createServer`:
```js
  // Static hosting of the web app (spec 2026-09-23 tracker web/teams). The
  // option is the test seam; env otherwise; unset serves nothing.
  const resolvedWebDir = resolveWebDir(webDir !== undefined ? webDir : process.env.MATRON_WEB_DIR)
  const handleStatic = makeStaticHandler({ webDir: resolvedWebDir })
```
and pass `handleStatic` into `makeHttpHandler({...})`.

`src/http.js`: add `handleStatic = async () => false` to `makeHttpHandler`'s parameters and, as the first statement after `const url = new URL(req.url, 'http://x')`:
```js
      if (await handleStatic(req, res, url)) return
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/static-http.test.js test/http.test.js`
Expected: PASS (http.test.js proves nothing changed without `webDir`).

- [ ] **Step 6: Commit**

```bash
git add src/static-http.js src/server.js src/http.js test/static-http.test.js
git commit -m "journal: serve the web app from MATRON_WEB_DIR with /u and /app fallback"
```

---

### Task 4: App-link well-known files (`src/well-known.js`)

**Files:**
- Create: `src/well-known.js`
- Modify: `src/server.js` (options `appleAppIds`, `androidPackage`, `androidCertSha256`; env `MATRON_APPLE_APP_IDS`, `MATRON_ANDROID_PACKAGE`, `MATRON_ANDROID_CERT_SHA256`)
- Modify: `src/http.js` (mount before `handleStatic`)
- Test: `test/well-known.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `parseList(raw) -> string[]` (comma-separated, trimmed, empties dropped); `makeWellKnown({appleAppIds, androidPackage, androidCertSha256}) -> (req, res, url) => boolean` (throws at construction on malformed values); `makeHttpHandler` gains `handleWellKnown` (default `() => false`).

Formats: an Apple app id is `TEAMID.bundle.id` (`/^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/`); an Android fingerprint is 32 colon-separated upper-case hex bytes (`/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/`, lower-case input is upper-cased); the package is a Java package name (`/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)+$/`). Android needs both the package and at least one fingerprint; either alone is a boot error naming the missing one.

- [ ] **Step 1: Write the failing test**

Create `test/well-known.test.js`:
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { makeWellKnown, parseList } from '../src/well-known.js'

test('well-known: unset → 404 for both files, unauthenticated', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  for (const p of ['/.well-known/apple-app-site-association', '/.well-known/assetlinks.json']) {
    const r = await fetch(s.base + p)
    assert.equal(r.status, 404); assert.deepEqual(await r.json(), { error: 'not_found' })
  }
  assert.equal((await fetch(s.base + '/.well-known/other')).status, 401, 'anything else is the API')
})

test('well-known: configured → claims /u/* for the apps; served without a token; HEAD works', async (t) => {
  const s = await startTestServer({
    appleAppIds: ['ABCDE12345.be.yearbooks.matron', 'ABCDE12345.be.yearbooks.matron.dev'],
    androidPackage: 'be.yearbooks.matron',
    androidCertSha256: ['aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99'],
  })
  t.after(() => s.close())
  const aasa = await fetch(s.base + '/.well-known/apple-app-site-association')
  assert.equal(aasa.status, 200)
  assert.equal(aasa.headers.get('content-type'), 'application/json')
  assert.deepEqual(await aasa.json(), {
    applinks: { details: [{ appIDs: ['ABCDE12345.be.yearbooks.matron', 'ABCDE12345.be.yearbooks.matron.dev'], components: [{ '/': '/u/*', comment: 'Matron tracker links' }] }] },
  })
  const al = await fetch(s.base + '/.well-known/assetlinks.json')
  assert.equal(al.status, 200)
  assert.deepEqual(await al.json(), [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: 'be.yearbooks.matron', sha256_cert_fingerprints: ['AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'] },
  }])
  const head = await fetch(s.base + '/.well-known/assetlinks.json', { method: 'HEAD' })
  assert.equal(head.status, 200); assert.ok(Number(head.headers.get('content-length')) > 0); assert.equal(await head.text(), '')
  assert.equal((await fetch(s.base + '/.well-known/assetlinks.json', { method: 'POST' })).status, 401)
})

test('well-known: one platform configured leaves the other 404; malformed values fail at construction', async (t) => {
  const s = await startTestServer({ appleAppIds: ['ABCDE12345.be.yearbooks.matron'] })
  t.after(() => s.close())
  assert.equal((await fetch(s.base + '/.well-known/apple-app-site-association')).status, 200)
  assert.equal((await fetch(s.base + '/.well-known/assetlinks.json')).status, 404)
  assert.deepEqual(parseList(' a, b ,,c '), ['a', 'b', 'c'])
  assert.deepEqual(parseList(undefined), [])
  assert.throws(() => makeWellKnown({ appleAppIds: ['not-an-app-id'] }), /MATRON_APPLE_APP_IDS/)
  assert.throws(() => makeWellKnown({ androidPackage: 'be.yearbooks.matron' }), /MATRON_ANDROID_CERT_SHA256/)
  assert.throws(() => makeWellKnown({ androidCertSha256: ['aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99'] }), /MATRON_ANDROID_PACKAGE/)
  assert.throws(() => makeWellKnown({ androidPackage: 'be.yearbooks.matron', androidCertSha256: ['AA:BB'] }), /MATRON_ANDROID_CERT_SHA256/)
  assert.throws(() => makeWellKnown({ androidPackage: 'bad package', androidCertSha256: ['aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99'] }), /MATRON_ANDROID_PACKAGE/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/well-known.test.js`
Expected: FAIL — module missing; both paths 401.

- [ ] **Step 3: Write `src/well-known.js`**

```js
// The two app-link files (spec 2026-09-23 tracker web/teams, "Static
// hosting" and "Why not universal links alone"): Apple's AASA and Android's
// assetlinks, each claiming /u/* for the installed app. Built once from env
// at boot; a journal with nothing configured claims nothing (404), so a
// self-hosted journal without app builds never asserts an association it
// cannot honour. Unauthenticated by design — the platforms fetch these
// anonymously.
import { json } from './http-body.js'

const APPLE_ID_RE = /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/
const PACKAGE_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)+$/
const FINGERPRINT_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/

export const parseList = (raw) => String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)

export function makeWellKnown({ appleAppIds = [], androidPackage = null, androidCertSha256 = [] } = {}) {
  for (const id of appleAppIds) if (!APPLE_ID_RE.test(id)) throw new Error(`MATRON_APPLE_APP_IDS: ${JSON.stringify(id)} is not TEAMID.bundle.id`)
  const fingerprints = androidCertSha256.map((f) => f.toUpperCase())
  for (const f of fingerprints) if (!FINGERPRINT_RE.test(f)) throw new Error(`MATRON_ANDROID_CERT_SHA256: ${JSON.stringify(f)} is not a colon-separated SHA-256 fingerprint`)
  if (androidPackage && !PACKAGE_RE.test(androidPackage)) throw new Error(`MATRON_ANDROID_PACKAGE: ${JSON.stringify(androidPackage)} is not a package name`)
  if (androidPackage && !fingerprints.length) throw new Error('MATRON_ANDROID_CERT_SHA256 is required alongside MATRON_ANDROID_PACKAGE')
  if (fingerprints.length && !androidPackage) throw new Error('MATRON_ANDROID_PACKAGE is required alongside MATRON_ANDROID_CERT_SHA256')

  const aasa = appleAppIds.length
    ? JSON.stringify({ applinks: { details: [{ appIDs: appleAppIds, components: [{ '/': '/u/*', comment: 'Matron tracker links' }] }] } })
    : null
  const assetlinks = androidPackage
    ? JSON.stringify([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: androidPackage, sha256_cert_fingerprints: fingerprints } }])
    : null
  const files = { '/.well-known/apple-app-site-association': aasa, '/.well-known/assetlinks.json': assetlinks }

  return function handleWellKnown(req, res, url) {
    if (!(url.pathname in files)) return false
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    const body = files[url.pathname]
    if (body === null) { json(res, 404, { error: 'not_found' }); return true }
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
    return true
  }
}
```

- [ ] **Step 4: Wire `src/server.js` and `src/http.js`**

`src/server.js`: import `{ makeWellKnown, parseList }`; add `appleAppIds, androidPackage, androidCertSha256` to `startServer`'s options; next to the static block:
```js
  const handleWellKnown = makeWellKnown({
    appleAppIds: appleAppIds !== undefined ? appleAppIds : parseList(process.env.MATRON_APPLE_APP_IDS),
    androidPackage: androidPackage !== undefined ? androidPackage : (process.env.MATRON_ANDROID_PACKAGE || null),
    androidCertSha256: androidCertSha256 !== undefined ? androidCertSha256 : parseList(process.env.MATRON_ANDROID_CERT_SHA256),
  })
```
and pass `handleWellKnown` into `makeHttpHandler({...})`.

`src/http.js`: add `handleWellKnown = () => false` to the parameters and mount it immediately before `handleStatic`:
```js
      if (handleWellKnown(req, res, url)) return
      if (await handleStatic(req, res, url)) return
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/well-known.test.js test/static-http.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/well-known.js src/server.js src/http.js test/well-known.test.js
git commit -m "journal: serve AASA and assetlinks for /u/* when configured"
```

---

### Task 5: GitHub token encryption at rest (`src/token-box.js`)

**Files:**
- Create: `src/token-box.js`
- Modify: `src/db.js` (column `github_accounts.token_hash TEXT`)
- Modify: `src/github-accounts.js` (seal on write, open on read, hash-based guards, `sealStoredTokens`)
- Modify: `src/github-http.js` (`box` threaded through `finishLink`, `refreshGithubAccount`, poll, callback, confirm)
- Modify: `src/github-refresh.js` (`box` option)
- Modify: `src/server.js` (option `tokenKey`, env `MATRON_TOKEN_KEY`, boot seal, pass `tokenBox`)
- Test: `test/token-box.test.js`, `test/github-accounts.test.js` (append), `test/github-http.test.js` (append)

**Interfaces:**
- Consumes: Plan A's `saveGithubIdentity`, `updateGithubIdentity`, `markGithubStale`, `listGithubAccounts`, `createLinkConfirm`, `takeLinkConfirm`, `refreshGithubAccount`, `runGithubRefresh`, `scheduleGithubRefresh`.
- Produces: `makeTokenBox(keyHex) -> {enabled, seal(plain), open(stored), }`; `PLAIN_BOX` (the no-key box); `isSealed(stored)`; `tokenHash(plain)`; `sealStoredTokens(db, box) -> {sealed, hashed}`. Signature changes: `saveGithubIdentity(db, {…, box = PLAIN_BOX})`, `updateGithubIdentity(db, {userId, tokenHash, identity, now})`, `markGithubStale(db, userId, {tokenHash = null, now})`, `listGithubAccounts(db)` rows gain `token_hash`, `createLinkConfirm(db, {…, box = PLAIN_BOX})`, `takeLinkConfirm(db, {nonce, now, box = PLAIN_BOX})`, `refreshGithubAccount(db, github, userId, now = Date.now(), {box = PLAIN_BOX} = {})`, `runGithubRefresh(db, github, {now, log, box})`, `scheduleGithubRefresh(db, github, {intervalMs, log, box})`, `finishLink(db, github, {userId, token, now, box})`. HTTP ctx for `handleGithubRoute` and `handleGithubCallback` gains `tokenBox`.

Sealed format: `enc1:` + base64(iv[12] ‖ tag[16] ‖ ciphertext), AES-256-GCM, key = 32 bytes from 64 hex chars. `open` on a plaintext value returns it unchanged (so the same code path reads pre-key rows); `PLAIN_BOX.open` on a sealed value throws `token_sealed`; a wrong key or tampered value throws `token_unreadable`. The refresh path turns either throw into `{outcome:'unchanged', error:{code}}` and a log line — never `stale`, never a crash (review focus 5).

- [ ] **Step 1: Write the failing tests**

Create `test/token-box.test.js`:
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTokenBox, PLAIN_BOX, isSealed, tokenHash } from '../src/token-box.js'

const KEY = 'ab'.repeat(32)

test('token box: seal/open round-trips, output is prefixed and never repeats, tamper and wrong key throw', () => {
  const box = makeTokenBox(KEY)
  assert.equal(box.enabled, true)
  const a = box.seal('gho_secret'); const b = box.seal('gho_secret')
  assert.ok(isSealed(a) && isSealed(b)); assert.notEqual(a, b, 'a fresh IV every time')
  assert.ok(!a.includes('gho_secret'))
  assert.equal(box.open(a), 'gho_secret'); assert.equal(box.open(b), 'gho_secret')
  assert.equal(box.open('plain-legacy'), 'plain-legacy', 'pre-key rows read through')
  assert.throws(() => box.open(a.slice(0, -2) + 'AA'), /token_unreadable/)
  assert.throws(() => makeTokenBox('cd'.repeat(32)).open(a), /token_unreadable/)
})

test('token box: without a key it is a pass-through that refuses sealed values; bad keys are rejected; hash is stable', () => {
  assert.equal(PLAIN_BOX.enabled, false)
  assert.equal(PLAIN_BOX.seal('x'), 'x'); assert.equal(PLAIN_BOX.open('x'), 'x')
  assert.throws(() => PLAIN_BOX.open(makeTokenBox(KEY).seal('x')), /token_sealed/)
  assert.equal(makeTokenBox('').enabled, false); assert.equal(makeTokenBox(undefined).enabled, false)
  assert.throws(() => makeTokenBox('short'), /MATRON_TOKEN_KEY/)
  assert.throws(() => makeTokenBox('zz'.repeat(32)), /MATRON_TOKEN_KEY/)
  assert.equal(tokenHash('x'), tokenHash('x')); assert.notEqual(tokenHash('x'), tokenHash('y')); assert.match(tokenHash('x'), /^[0-9a-f]{64}$/)
})
```

In `test/github-accounts.test.js`, extend the existing import from `../src/github-accounts.js` with `sealStoredTokens, updateGithubIdentity, createLinkConfirm, takeLinkConfirm` (it already imports `openDb`, `createUser`, `githubAccountView`, `saveGithubIdentity`, `markGithubStale`, `listGithubAccounts`), add the line `import { makeTokenBox, PLAIN_BOX, isSealed, tokenHash } from '../src/token-box.js'`, and append:
```js
test('sealed storage: save writes enc1 + token_hash; guards match on the hash; confirm rows seal too; boot sealing upgrades plaintext rows', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw'); const pat = await createUser(db, 'pat', 'pw')
  const box = makeTokenBox('ab'.repeat(32))
  const identity = { github_id: 1, login: 'dan', scopes: ['github.com/matronhq'] }
  saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity, token: 'gho_dan', now: 1, box })
  const row = db.prepare('SELECT token, token_hash FROM github_accounts WHERE user_id=?').get(dan.id)
  assert.ok(isSealed(row.token)); assert.equal(row.token_hash, tokenHash('gho_dan'))
  assert.equal(box.open(listGithubAccounts(db)[0].token), 'gho_dan')
  assert.ok(updateGithubIdentity(db, { userId: dan.id, tokenHash: tokenHash('gho_dan'), identity: { ...identity, scopes: ['github.com/other'] }, now: 2 }))
  assert.deepEqual(githubAccountView(db, dan.id).orgs, ['github.com/other'])
  assert.equal(updateGithubIdentity(db, { userId: dan.id, tokenHash: tokenHash('stale-token'), identity, now: 3 }), null)
  markGithubStale(db, dan.id, { tokenHash: tokenHash('stale-token'), now: 4 })
  assert.equal(githubAccountView(db, dan.id).state, 'ok', 'a stale-mark for a token no longer held changes nothing')
  markGithubStale(db, dan.id, { tokenHash: tokenHash('gho_dan'), now: 5 })
  assert.equal(githubAccountView(db, dan.id).state, 'stale')

  const { nonce } = createLinkConfirm(db, { userId: pat.id, token: 'gho_pat', identity: { github_id: 2, login: 'pat', scopes: [] }, now: 1, box })
  assert.ok(isSealed(db.prepare('SELECT token FROM github_link_confirms').get().token))
  assert.equal(takeLinkConfirm(db, { nonce, now: 2, box }).token, 'gho_pat')

  // Plan A rows: plaintext token, no hash. Boot sealing fixes both.
  db.prepare("INSERT INTO github_accounts(user_id, host, github_id, login, token, state, checked_at, linked_at) VALUES(?,?,?,?,?,'ok',1,1)").run(pat.id, 'github.com', 2, 'pat', 'gho_legacy')
  db.prepare('INSERT INTO github_link_confirms(id, user_id, nonce, token, identity_json, expires_at, created_at) VALUES(?,?,?,?,?,?,?)').run('gc_x', pat.id, 'ff'.repeat(16), 'gho_parked', '{}', 9e15, 1)
  const out = sealStoredTokens(db, box)
  assert.deepEqual(out, { sealed: 2, hashed: 1 })
  const legacy = db.prepare('SELECT token, token_hash FROM github_accounts WHERE user_id=?').get(pat.id)
  assert.ok(isSealed(legacy.token)); assert.equal(box.open(legacy.token), 'gho_legacy'); assert.equal(legacy.token_hash, tokenHash('gho_legacy'))
  assert.equal(box.open(db.prepare("SELECT token FROM github_link_confirms WHERE id='gc_x'").get().token), 'gho_parked')
  assert.deepEqual(sealStoredTokens(db, box), { sealed: 0, hashed: 0 }, 'idempotent')
  // Without a key, boot sealing only backfills hashes.
  const db2 = openDb(':memory:'); const sam = await createUser(db2, 'sam', 'pw')
  db2.prepare("INSERT INTO github_accounts(user_id, host, github_id, login, token, state, checked_at, linked_at) VALUES(?,?,?,?,?,'ok',1,1)").run(sam.id, 'github.com', 3, 'sam', 'gho_sam')
  assert.deepEqual(sealStoredTokens(db2, PLAIN_BOX), { sealed: 0, hashed: 1 })
  assert.deepEqual(db2.prepare('SELECT token, token_hash FROM github_accounts').get(), { token: 'gho_sam', token_hash: tokenHash('gho_sam') })
})
```
(Add `PLAIN_BOX` to that import line, and `openDb`/`createUser`/`githubAccountView`/`markGithubStale`/`saveGithubIdentity` are already imported at the top of the file — check and merge.)

Append to `test/github-http.test.js`:
```js
test('with MATRON_TOKEN_KEY: link, refresh and unlink work; the plaintext token is nowhere in the database files; a restart without the key logs and leaves the link alone (review focus 5)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-token-key-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'j.db')
  const secret = 'gho_' + 'f00dcafe'.repeat(5)
  const gh = fakeGithub()
  gh.q.poll.push(() => ({ status: 'ok', token: secret }))
  const s = await startTestServer({ dbPath, github: gh, tokenKey: 'ab'.repeat(32) })
  const dan = await createUser(s.db, 'dan', 'pw')
  const danTok = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })).json.token
  const start = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  const linked = await s.http(`/github/link/${start.json.flow_id}/poll`, { method: 'POST', token: danTok })
  assert.equal(linked.json.status, 'linked')
  const row = s.db.prepare('SELECT token, token_hash FROM github_accounts WHERE user_id=?').get(dan.id)
  assert.ok(row.token.startsWith('enc1:')); assert.ok(row.token_hash)
  gh.q.identity.push(() => ({ github_id: 42, login: 'DanBarker', scopes: ['github.com/matronhq', 'github.com/second'] }))
  const refreshed = await s.http('/github/refresh', { method: 'POST', token: danTok })
  assert.equal(refreshed.status, 200); assert.deepEqual(refreshed.json.github.orgs, ['github.com/matronhq', 'github.com/second'])
  await s.close()
  const bytes = Buffer.concat(['', '-wal', '-shm'].map((sfx) => { try { return fs.readFileSync(dbPath + sfx) } catch { return Buffer.alloc(0) } }))
  assert.ok(!bytes.includes(secret), 'the plaintext token must not be on disk')

  // Restart without the key: the sealed row is unreadable, not stale.
  const logs = []
  const s2 = await startTestServer({ dbPath, github: gh, tokenKey: '', githubRefreshIntervalMs: 3600000 })
  const origLog = console.log; console.log = (...a) => { logs.push(a.join(' ')); origLog(...a) }
  t.after(() => { console.log = origLog })
  const danTok2 = (await s2.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac2' } })).json.token
  const r = await s2.http('/github/refresh', { method: 'POST', token: danTok2 })
  assert.equal(r.status, 502)
  assert.equal((await s2.http('/me', { token: danTok2 })).json.github.state, 'ok')
  const { runGithubRefresh } = await import('../src/github-refresh.js')
  const out = await runGithubRefresh(s2.db, gh, { log: (l) => logs.push(l) })
  assert.deepEqual(out, { refreshed: 0, stale: 0, unchanged: 1 })
  assert.ok(logs.some((l) => /token_sealed/.test(l)), 'the operator is told the key is missing')
  assert.deepEqual((await s2.http('/github/link', { method: 'DELETE', token: danTok2 })).json, { ok: true })
  await s2.close()
})
```
Add `import fs from 'node:fs'`, `import os from 'node:os'`, `import path from 'node:path'` to that file's imports.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/token-box.test.js test/github-accounts.test.js test/github-http.test.js`
Expected: FAIL — module missing; `token_hash` column missing; `box` ignored.

- [ ] **Step 3: Write `src/token-box.js`**

```js
// Encryption at rest for stored GitHub tokens (spec 2026-09-23 tracker
// web/teams, "Token at rest" follow-up). AES-256-GCM under a journal-side
// key from MATRON_TOKEN_KEY (64 hex chars). Sealed values carry an `enc1:`
// prefix so a row written before the key existed still reads through
// `open`, and a box without a key refuses to hand back a sealed value
// rather than treating ciphertext as a token. Equality guards elsewhere
// use tokenHash, never the sealed text (a fresh IV makes every seal
// distinct).
import crypto from 'node:crypto'

const PREFIX = 'enc1:'
const IV_LEN = 12
const TAG_LEN = 16

export const isSealed = (v) => typeof v === 'string' && v.startsWith(PREFIX)
export const tokenHash = (plain) => crypto.createHash('sha256').update(String(plain)).digest('hex')

export function makeTokenBox(keyHex) {
  if (keyHex == null || keyHex === '') {
    return {
      enabled: false,
      seal: (plain) => plain,
      open: (stored) => { if (isSealed(stored)) throw new Error('token_sealed'); return stored },
    }
  }
  if (typeof keyHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error('MATRON_TOKEN_KEY must be 64 hex characters (32 bytes)')
  const key = Buffer.from(keyHex, 'hex')
  return {
    enabled: true,
    seal(plain) {
      const iv = crypto.randomBytes(IV_LEN)
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
      return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
    },
    open(stored) {
      if (!isSealed(stored)) return stored
      try {
        const buf = Buffer.from(stored.slice(PREFIX.length), 'base64')
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, IV_LEN))
        decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN))
        return Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString('utf8')
      } catch {
        throw new Error('token_unreadable')
      }
    },
  }
}

export const PLAIN_BOX = makeTokenBox(null)
```

- [ ] **Step 4: Column in `src/db.js`**

After the `github_link_confirms` block (and before the `is_admin` block from Task 1):
```js
  // SHA-256 of the plaintext token: the refresh path's "only touch the row
  // I read" guard compares this, so the token column itself can be sealed
  // (src/token-box.js). NULL only until sealStoredTokens runs at boot.
  const ghCols = db.prepare('PRAGMA table_info(github_accounts)').all()
  if (!ghCols.some((c) => c.name === 'token_hash')) {
    db.exec('ALTER TABLE github_accounts ADD COLUMN token_hash TEXT')
  }
```

- [ ] **Step 5: `src/github-accounts.js`**

Import `{ PLAIN_BOX, isSealed, tokenHash }` from `./token-box.js`. Then:

`saveGithubIdentity` gains `box = PLAIN_BOX`; its INSERT becomes:
```js
    db.prepare(`INSERT INTO github_accounts(user_id, host, github_id, login, token, token_hash, state, checked_at, linked_at)
      VALUES(?,?,?,?,?,?,'ok',?,?)
      ON CONFLICT(user_id) DO UPDATE SET host=excluded.host, github_id=excluded.github_id, login=excluded.login,
        token=excluded.token, token_hash=excluded.token_hash, state='ok', checked_at=excluded.checked_at`)
      .run(userId, host, identity.github_id, identity.login, box.seal(token), tokenHash(token), now, now)
```

`updateGithubIdentity(db, { userId, tokenHash: hash, identity, now = Date.now() })`:
```js
    const r = db.prepare(`UPDATE github_accounts SET github_id=?, login=?, state='ok', checked_at=?
      WHERE user_id=? AND token_hash=?`).run(identity.github_id, identity.login, now, userId, hash)
```

`markGithubStale(db, userId, { tokenHash: hash = null, now = Date.now() } = {})` — the guarded branch is `WHERE user_id=? AND token_hash=?` with `hash`.

`listGithubAccounts` selects `user_id, host, token, token_hash`.

`createLinkConfirm` gains `box = PLAIN_BOX` and stores `box.seal(token)`; `takeLinkConfirm(db, { nonce, now = Date.now(), box = PLAIN_BOX })` returns `token: box.open(row.token)` (a throw propagates; the caller maps it).

Append:
```js
// Boot-time upgrade (server.js): seal every plaintext token when a key is
// configured, and backfill token_hash for rows written before the column
// existed. Idempotent; a key-less journal only backfills hashes.
export function sealStoredTokens(db, box) {
  return db.transaction(() => {
    const out = { sealed: 0, hashed: 0 }
    for (const r of db.prepare('SELECT user_id, token, token_hash FROM github_accounts').all()) {
      if (isSealed(r.token)) continue
      const hash = r.token_hash ?? tokenHash(r.token)
      if (r.token_hash == null) out.hashed++
      const stored = box.seal(r.token)
      if (stored !== r.token) out.sealed++
      db.prepare('UPDATE github_accounts SET token=?, token_hash=? WHERE user_id=?').run(stored, hash, r.user_id)
    }
    for (const r of db.prepare('SELECT id, token FROM github_link_confirms').all()) {
      if (isSealed(r.token)) continue
      const stored = box.seal(r.token)
      if (stored === r.token) continue
      out.sealed++
      db.prepare('UPDATE github_link_confirms SET token=? WHERE id=?').run(stored, r.id)
    }
    return out
  })()
}
```

- [ ] **Step 6: `src/github-http.js`, `src/github-refresh.js`, `src/server.js`**

`src/github-http.js`: import `{ PLAIN_BOX, tokenHash }` from `./token-box.js`.
```js
export async function finishLink(db, github, { userId, token, now = Date.now(), box = PLAIN_BOX }) {
  const identity = await github.fetchIdentity(token)
  return saveGithubIdentity(db, { userId, host: github.host, identity, token, now, box })
}

export async function refreshGithubAccount(db, github, userId, now = Date.now(), { box = PLAIN_BOX } = {}) {
  const row = db.prepare('SELECT token, token_hash FROM github_accounts WHERE user_id=?').get(userId)
  if (!row) return null
  let token
  try {
    token = box.open(row.token)
  } catch (err) {
    // Sealed under a key this process does not have (or a corrupted row):
    // say so and keep everything — never stale, never a crash.
    return { view: githubAccountView(db, userId), outcome: 'unchanged', error: { code: err.message } }
  }
  const hash = row.token_hash ?? tokenHash(token)
  try {
    const identity = await github.fetchIdentity(token)
    const view = updateGithubIdentity(db, { userId, tokenHash: hash, identity, now })
    if (!view) return { view: githubAccountView(db, userId), outcome: 'unchanged' }
    return { view, outcome: 'ok' }
  } catch (err) {
    if (err instanceof GithubError && err.code === 'unauthorized') {
      markGithubStale(db, userId, { tokenHash: hash, now })
      return { view: githubAccountView(db, userId), outcome: 'stale' }
    }
    if (err instanceof GithubError) return { view: githubAccountView(db, userId), outcome: 'unchanged', error: err }
    throw err
  }
}
```
In `handleGithubRoute`: destructure `tokenBox = PLAIN_BOX` from `ctx`; the poll's `finishLink(...)` call passes `box: tokenBox`; the refresh call becomes `refreshGithubAccount(db, github, who.userId, Date.now(), { box: tokenBox })`. In `handleGithubCallback`: destructure `tokenBox = PLAIN_BOX`; `createLinkConfirm({ ..., box: tokenBox })`; the confirm branch wraps `takeLinkConfirm(db, { nonce: body.nonce, box: tokenBox })` in `try { … } catch { return redirect('/account?link_error=expired') }` and passes `box: tokenBox` to `saveGithubIdentity`. Check the refresh log line in `runGithubRefresh` prints `r.error && r.error.code` — it already does, so `token_sealed` appears there.

`src/github-refresh.js`: `runGithubRefresh(db, github, { now = Date.now(), log = console.log, box = PLAIN_BOX } = {})` passes `{ box }` as the fifth argument of `refreshGithubAccount(db, github, acct.user_id, now, { box })`; `scheduleGithubRefresh(db, github, { intervalMs, log, box = PLAIN_BOX })` forwards `box`. Import `PLAIN_BOX`.

`src/server.js`: import `{ makeTokenBox }` and `{ sealStoredTokens }`; add `tokenKey` to options; after `openDb`:
```js
  // Token encryption at rest (spec 2026-09-23 tracker web/teams). The
  // option is the test seam; env otherwise. A key that appears after rows
  // exist seals them here, once.
  const tokenBox = makeTokenBox(tokenKey !== undefined ? tokenKey : process.env.MATRON_TOKEN_KEY)
  const sealed = sealStoredTokens(db, tokenBox)
  if (sealed.sealed) console.log(`github: sealed ${sealed.sealed} stored token(s) under MATRON_TOKEN_KEY`)
```
Pass `tokenBox` into `makeHttpHandler({...})` (and from there into both `handleGithubRoute({ db, github, rateLimiter, tokenBox }, …)` and `handleGithubCallback({ db, github, tokenBox }, …)` in `src/http.js`; add `tokenBox = null` to `makeHttpHandler`'s parameters and pass it as `tokenBox: tokenBox || undefined` so the `PLAIN_BOX` default applies). Pass `box: tokenBox` to `scheduleGithubRefresh`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/token-box.test.js test/github-accounts.test.js test/github-http.test.js test/github-refresh.test.js test/visibility.test.js`
Expected: PASS. (`visibility.test.js` calls `markGithubStale(db, id, {})`, still valid.)

- [ ] **Step 8: Commit**

```bash
git add src/token-box.js src/db.js src/github-accounts.js src/github-http.js src/github-refresh.js src/server.js src/http.js test/token-box.test.js test/github-accounts.test.js test/github-http.test.js
git commit -m "github: seal stored tokens under MATRON_TOKEN_KEY; guards match on token_hash"
```

---

### Task 6: Docs — protocol, README, help, spec, admin usage

**Files:**
- Modify: `docs/protocol.md` (new sections before "## Device privacy": "User administration", "Static hosting and app links"; "Token at rest" paragraph inside "GitHub account linking"; `GET /me` row)
- Modify: `README.md` (Configuration table; the `matron-admin` command list near line 31)
- Modify: `src/help.js` (one line under `## Reading` for `/me`'s `is_admin`; nothing else — the admin routes are client-only)
- Modify: `docs/superpowers/specs/2026-09-23-tracker-web-teams-and-item-links-design.md` ("Token at rest" paragraph; link-code body name)
- Test: `test/help.test.js` (append one assertion)

- [ ] **Step 1: Write the failing test**

In `test/help.test.js`, after the `/lookup` assertion:
```js
  assert.match(body, /GET \/me\b.*is_admin/)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/help.test.js` — Expected: FAIL.

- [ ] **Step 3: `src/help.js`**

Change the `/me` clause in the `/lookup` bullet to its own bullet under `## Reading`:
```
- \`GET /me\` — \`{user:{id, name, is_admin}, github, github_linking}\`: who
  you are, whether your user is a journal admin, and your GitHub link
  state. The users admin routes themselves are for the web app's client
  session, never for an agent.
```

- [ ] **Step 4: `docs/protocol.md`**

In the GitHub routes table, change the `GET /me` row's response to `{user:{id,name,is_admin}, github: {…} | null, github_linking:{enabled, web_flow}}`.

Replace the paragraph beginning "The token is stored in the journal DB, never returned by any route" with:
```markdown
The token is never returned by any route and never logged. With
`MATRON_TOKEN_KEY` set (64 hex characters — `openssl rand -hex 32`) it is
stored sealed with AES-256-GCM (`enc1:` prefix); a journal that gains the
key seals its existing rows at the next start. Unset, it is stored as-is.
The refresh path recognises its own row by `token_hash` (SHA-256 of the
plaintext), so sealing changes no behaviour. Starting without the key after
rows were sealed marks nothing stale: refreshes answer `502 upstream`, the
daily job logs `token_sealed`, and unlink/re-link work as usual. Losing the
key means every user re-links.
```

Insert before `## Device privacy`:
```markdown
## User administration

Journal admins are users with `users.is_admin = 1`, bootstrapped from the
shell: `matron-admin user admin <name> on|off`. Every route below is for a
**client** device of an admin; any other caller — a non-admin, or an
agent whatever its user's flag — gets `403 forbidden` for every verb,
before any id is looked up. Mirrors `matron-admin` so the web app's admin
page needs no shell.

| Route | Body | Response |
|---|---|---|
| `GET /users` | — | `{users:[{id, name, is_admin, created_at, github:{login, state, host} \| null}]}` (no token, no hash) |
| `POST /users` | `{name, password, is_admin?}` — name `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, password ≥ 8 | `201 {user}`; `400 bad_request` \| `400 weak_password`; `409 conflict` if the name is taken |
| `PATCH /users/:id` | `{is_admin: boolean}` | `{user}`; `409 conflict {reason:'last_admin'}` when it would demote the only admin |
| `POST /users/:id/password` | `{password}` ≥ 8 | `{ok:true}`; device tokens stay valid (same as `matron-admin user passwd`) |
| `DELETE /users/:id/github-link` | — | `{ok:true}`; `404` if nothing linked. Resolves a `409 conflict` at link time |
| `POST /users/:id/link-code` | `{ttl_seconds?}` (60–86400, default 600) | `{link_code, expires_in}` — the same pre-approved pairing code `matron-admin link-code` mints; the app builds `matron://link?v=1&server=<origin>&code=<link_code>` |

Unknown `:id` is `404 not_found`. Self-service stays on the existing
routes: `GET /devices`, `POST /devices/:id/revoke`, `POST /devices/:id/rename`,
`POST /password`.

## Static hosting and app links

`MATRON_WEB_DIR` (unset by default — nothing changes) names a directory the
journal serves read-only, before Bearer auth, for `GET`/`HEAD` only:

- an existing regular file under it is served with its extension's
  content type, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`
  on HTML, and `Cache-Control: public, max-age=31536000, immutable` under
  `/assets/` (Vite's hashed names) or `no-cache` elsewhere;
- `/u/*`, `/app` and `/app/*` serve the directory's `index.html` (history
  fallback) unless the request's `Accept` names `application/json`, which
  is the JSON link lookup and reaches the API;
- `/` redirects to `/app/`;
- a path with a dot-segment (`..`, `.git`, `.env`), a backslash, a NUL, a
  path resolving outside the directory, a directory, or no matching file
  falls through to the API, which answers as it always has (`401`/`404`).
  Do not place files named like API routes (`items`, `login`) in the
  directory: an existing file wins.

The app-link files are served unauthenticated from env and are
`404 not_found` when unset:

| Route | Env | Body |
|---|---|---|
| `GET /.well-known/apple-app-site-association` | `MATRON_APPLE_APP_IDS` (comma-separated `TEAMID.bundle.id`) | `{applinks:{details:[{appIDs, components:[{"/":"/u/*"}]}]}}` |
| `GET /.well-known/assetlinks.json` | `MATRON_ANDROID_PACKAGE` and `MATRON_ANDROID_CERT_SHA256` (comma-separated colon-hex fingerprints; both required together) | `[{relation:["delegate_permission/common.handle_all_urls"], target:{namespace:"android_app", package_name, sha256_cert_fingerprints}}]` |

Malformed values refuse to start the journal, naming the variable.
```

- [ ] **Step 5: `README.md` and the spec**

README Configuration rows (after `MATRON_GITHUB_HOST`):
```markdown
| `MATRON_TOKEN_KEY` | unset (tokens stored as-is) | 64 hex chars (`openssl rand -hex 32`). Seals stored GitHub tokens with AES-256-GCM; existing rows are sealed at the next start. Losing it means every user re-links |
| `MATRON_WEB_DIR` | unset (nothing served) | Directory of the built tracker web app. Served read-only with `index.html` fallback for `/u/*` and `/app/*` |
| `MATRON_APPLE_APP_IDS` | unset (404) | Comma-separated `TEAMID.bundle.id` list for `/.well-known/apple-app-site-association`, claiming `/u/*` |
| `MATRON_ANDROID_PACKAGE` | unset (404) | Android package name for `/.well-known/assetlinks.json`; needs `MATRON_ANDROID_CERT_SHA256` too |
| `MATRON_ANDROID_CERT_SHA256` | unset | Comma-separated signing-cert SHA-256 fingerprints (`AA:BB:…`) for assetlinks |
```
README command list (after `user add`): `MATRON_DB=./matron.db npx matron-admin user admin dan on`.

Spec: replace the "Token at rest" paragraph (the one beginning "**Token at rest.** The token is stored as-is.") with:
```markdown
**Token at rest.** With `MATRON_TOKEN_KEY` (64 hex chars) set, the token
is sealed with AES-256-GCM before it is stored (`enc1:` prefix) and
existing rows are sealed at the next start; unset keeps plaintext, which
is acceptable because the scope is `read:org`, the user can revoke it on
GitHub, and the database already holds credentials of the same class.
`github_accounts.token_hash` (SHA-256 of the plaintext) is what the
refresh path matches on, so guards never compare ciphertext.
```
and in "User administration" change `POST /users/:id/link-code {expires}` to `POST /users/:id/link-code {ttl_seconds}`.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS, every file (the known `test/agent-spawn.test.js` cancellation aside — confirm it passes standalone if it cancels).

- [ ] **Step 7: Commit**

```bash
git add docs/protocol.md README.md src/help.js test/help.test.js docs/superpowers/specs/2026-09-23-tracker-web-teams-and-item-links-design.md
git commit -m "docs: users admin, static hosting, app-link files, token key"
```
