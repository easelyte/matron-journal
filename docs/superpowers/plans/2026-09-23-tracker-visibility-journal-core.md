# Tracker visibility — journal core (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the journal repo identity on conversations, GitHub account linking with verified org membership, and a per-repo cross-user read path for items, missions, milestones, lookups and transcript excerpts.

**Architecture:** The bridge reports a canonical `repo` string on `convo_upsert`; the journal stores it plus a derived `repo_scope` (`host/org`). Users link GitHub through the OAuth device flow or web flow; the journal stores a `read:org` token and the user's org scopes. One SQL predicate (`src/visibility.js`) says whether a viewer may read a conversation's rows: owner, or both viewer and owner are verified members of the conversation's org scope, and the conversation is not private-owned. Every widened read reuses it.

**Tech Stack:** Node ≥ 20 (ES modules, global `fetch`), better-sqlite3, `node --test` with `node:assert/strict`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-tracker-web-teams-and-item-links-design.md` (revision 2). This plan is rollout step 3's core. Plan B (users admin routes, `matron-admin user admin`, static hosting, well-known files) follows separately.

## Global Constraints

- Repo string regex, verbatim from the spec: `^[a-z0-9.-]+/[a-z0-9_.-]+/[A-Za-z0-9_.-]+$`, max 256 chars.
- GitHub token scope is exactly `read:org`. The token is never returned by any route and never logged.
- Invisible rows answer `404 {error:'not_found'}`; a visible foreign row refused for writing answers `403 {error:'forbidden'}`.
- Foreign transcript reads: prose only (`text`, `diff`), `limit` clamped to 30, one `console.log` line per read.
- Private-device sieve (`src/privacy.js`) applies before any org rule and cannot be bypassed by an org match.
- A stale link (`state='stale'`) confers no cross-user visibility.
- Link flows and web-flow `state` values expire after 10 minutes and are single use.
- Every error body uses the existing shapes: `bad_request`, `not_found`, `forbidden`, `conflict`, `rate_limited`, plus new `not_configured` (404) and `upstream` (502).
- Existing behaviour for a journal with no linked accounts is byte-identical (all existing tests keep passing).

## Review Focus

1. **Owner is a member, viewer's link is stale.** Expect: viewer sees nothing of the owner's; owner's own reads unchanged. Pinned in Task 7.
2. **Conversation switches repo after items were filed.** Expect: visibility follows the current `repo_scope`; an item filed under a personal repo becomes visible once the conversation moves to an org repo, and vice versa. Pinned in Task 8.
3. **Two users try to link the same GitHub account.** Expect: the second gets `409 conflict` and the first link is untouched. Pinned in Task 5.
4. **Web callback arrives with a valid `state` but a different browser (no Bearer).** Expect: the link lands on the flow row's user; a replayed `state` answers the error redirect, never a second link. Pinned in Task 5.
5. **A foreign excerpt read on a private-owned conversation that is otherwise org-visible.** Expect: 404, and no audit log line. Pinned in Task 11.

---

### Task 1: Repo identity and schema

**Files:**
- Create: `src/repo-identity.js`
- Modify: `src/db.js` (end of `openDb`, before `healBakedTitles`)
- Test: `test/repo-identity.test.js`, `test/db.test.js` (append)

**Interfaces:**
- Produces: `parseRepo(s) -> { repo, scope, host, org, name } | null`, `REPO_MAX = 256`, `REPO_RE`.
- Produces: columns `conversations.repo TEXT`, `conversations.repo_scope TEXT`, index `idx_conversations_repo_scope`; tables `github_accounts`, `github_orgs`, `github_link_flows`.

- [ ] **Step 1: Write the failing tests**

`test/repo-identity.test.js`:
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRepo, REPO_MAX } from '../src/repo-identity.js'

test('parseRepo: canonical strings split into host/org/name with a lower-cased scope', () => {
  assert.deepEqual(parseRepo('github.com/matronhq/matron-journal'), {
    repo: 'github.com/matronhq/matron-journal', scope: 'github.com/matronhq',
    host: 'github.com', org: 'matronhq', name: 'matron-journal',
  })
  // Name case is preserved; host and org must already be lower-case.
  assert.equal(parseRepo('github.com/matronhq/Matron-Journal').name, 'Matron-Journal')
})

test('parseRepo: rejects anything that is not host/org/name', () => {
  for (const bad of ['', 'github.com/matronhq', 'GitHub.com/matronhq/x', 'github.com/MatronHQ/x',
    'github.com/matronhq/x/y', 'git@github.com:matronhq/x.git', 'https://github.com/matronhq/x',
    'a'.repeat(REPO_MAX + 1), 42, null, undefined]) {
    assert.equal(parseRepo(bad), null, `should reject ${JSON.stringify(bad)}`)
  }
})
```

Append to `test/db.test.js` (it already imports `openDb`, `test` and `assert`; check its header and reuse):
```js
test('schema: repo columns and github tables exist', () => {
  const db = openDb(':memory:')
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
  assert.ok(cols('conversations').includes('repo'))
  assert.ok(cols('conversations').includes('repo_scope'))
  assert.deepEqual(cols('github_accounts'), ['user_id', 'host', 'github_id', 'login', 'token', 'state', 'checked_at', 'linked_at'])
  assert.deepEqual(cols('github_orgs'), ['user_id', 'scope'])
  assert.deepEqual(cols('github_link_flows'), ['id', 'user_id', 'device_id', 'flow', 'device_code', 'state', 'expires_at', 'created_at'])
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(2,'pat','x',0)").run()
  const ins = db.prepare("INSERT INTO github_accounts(user_id, host, github_id, login, token, state, linked_at) VALUES(?, 'github.com', 7, 'dan', 't', 'ok', 0)")
  ins.run(1)
  assert.throws(() => ins.run(2), /UNIQUE/, 'one GitHub account binds to one user')
  db.close()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/repo-identity.test.js test/db.test.js`
Expected: FAIL — `Cannot find module '../src/repo-identity.js'` and the schema assertions fail.

- [ ] **Step 3: Write `src/repo-identity.js`**

```js
// Canonical repo identity as reported by a bridge on convo_upsert (spec
// 2026-09-23 tracker web/teams, "Repo identity"): `host/org/name`, host and
// org lower-cased, name as-is. The journal never sees a git URL — the bridge
// normalises — so this is a validator and splitter, not a URL parser.
export const REPO_MAX = 256
export const REPO_RE = /^[a-z0-9.-]+\/[a-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

// Returns null for anything that is not a canonical repo string.
export function parseRepo(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > REPO_MAX || !REPO_RE.test(s)) return null
  const [host, org, name] = s.split('/')
  return { repo: s, scope: `${host}/${org}`, host, org, name }
}
```

- [ ] **Step 4: Add the schema to `openDb` in `src/db.js`**

Insert immediately before the `healBakedTitles(db, ...)` call at the end of `openDb`:
```js
  // Repo identity (spec 2026-09-23 tracker web/teams). `repo` is the
  // bridge-reported canonical `host/org/name`; `repo_scope` is the derived
  // `host/org`, the unit visibility is decided on. Both NULL for every row
  // predating the column and every conversation with no git remote.
  const repoCols = db.prepare('PRAGMA table_info(conversations)').all()
  if (!repoCols.some((c) => c.name === 'repo')) {
    db.exec('ALTER TABLE conversations ADD COLUMN repo TEXT')
  }
  if (!repoCols.some((c) => c.name === 'repo_scope')) {
    db.exec('ALTER TABLE conversations ADD COLUMN repo_scope TEXT')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_repo_scope ON conversations(repo_scope)')
  // GitHub account linking. One GitHub identity per journal user and one
  // journal user per GitHub identity (the unique index). `token` is the
  // user's read:org OAuth token, stored as-is (spec: "Token at rest").
  // `state='stale'` = GitHub refused the token on the last refresh; the
  // orgs rows stay but confer nothing until the user re-links.
  db.exec(`
    CREATE TABLE IF NOT EXISTS github_accounts(
      user_id    INTEGER PRIMARY KEY REFERENCES users(id),
      host       TEXT NOT NULL DEFAULT 'github.com',
      github_id  INTEGER NOT NULL,
      login      TEXT NOT NULL,
      token      TEXT NOT NULL,
      state      TEXT NOT NULL CHECK(state IN ('ok','stale')),
      checked_at INTEGER,
      linked_at  INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_github_accounts_id ON github_accounts(host, github_id);
    CREATE TABLE IF NOT EXISTS github_orgs(
      user_id INTEGER NOT NULL REFERENCES github_accounts(user_id) ON DELETE CASCADE,
      scope   TEXT NOT NULL,
      PRIMARY KEY(user_id, scope)
    );
    CREATE INDEX IF NOT EXISTS idx_github_orgs_scope ON github_orgs(scope);
    CREATE TABLE IF NOT EXISTS github_link_flows(
      id          TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      device_id   INTEGER NOT NULL,
      flow        TEXT NOT NULL CHECK(flow IN ('device','web')),
      device_code TEXT,
      state       TEXT,
      expires_at  INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_github_link_flows_state ON github_link_flows(state);
  `)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/repo-identity.test.js test/db.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/repo-identity.js src/db.js test/repo-identity.test.js test/db.test.js
git commit -m "journal: repo identity columns and GitHub account tables"
```

---

### Task 2: `repo` on `convo_upsert`, `convo_meta` and `/snapshot`

**Files:**
- Modify: `src/journal.js` (`upsertConversation`, `snapshot`)
- Modify: `src/ws.js` (`case 'convo_upsert'`)
- Modify: `docs/protocol.md` (the `convo_upsert` bullet near line 408)
- Test: `test/journal.test.js` (append), `test/agent.test.js` (append)

**Interfaces:**
- Consumes: `parseRepo` from Task 1.
- Produces: `upsertConversation(db, { ..., repo })` where `repo` undefined = unchanged, `null` = clear, string = set (must be canonical; throws `Error('bad repo')` otherwise). The returned row carries `repo`, `repo_scope`; `metaChanged` is true when the repo changed.
- Produces: `convo_upsert` accepts `repo` (string, null, or absent); `convo_meta` payload gains `repo`; `/snapshot` conversations gain `repo`.

- [ ] **Step 1: Write the failing tests**

Append to `test/journal.test.js` (it already imports `openDb`, `createUser`, `createAgent`, `upsertConversation`, `snapshot`; add any missing import):
```js
test('upsertConversation: repo is set, kept when absent, cleared with null, and rejected when malformed', async () => {
  const db = openDb(':memory:')
  const u = await createUser(db, 'dan', 'pw')
  const a = createAgent(db, u.id, 'dev-2')
  let c = upsertConversation(db, { id: 'c1', ownerUserId: u.id, title: 'C1', agentDeviceId: a.deviceId, repo: 'github.com/matronhq/matron-journal' })
  assert.equal(c.repo, 'github.com/matronhq/matron-journal')
  assert.equal(c.repo_scope, 'github.com/matronhq')
  assert.equal(c.metaChanged, true)
  c = upsertConversation(db, { id: 'c1', ownerUserId: u.id, agentDeviceId: a.deviceId })
  assert.equal(c.repo, 'github.com/matronhq/matron-journal', 'absent leaves it alone')
  assert.equal(c.metaChanged, false)
  c = upsertConversation(db, { id: 'c1', ownerUserId: u.id, agentDeviceId: a.deviceId, repo: 'github.com/matronhq/matron-journal' })
  assert.equal(c.metaChanged, false, 'same repo is not a change')
  c = upsertConversation(db, { id: 'c1', ownerUserId: u.id, agentDeviceId: a.deviceId, repo: null })
  assert.equal(c.repo, null); assert.equal(c.repo_scope, null); assert.equal(c.metaChanged, true)
  assert.throws(() => upsertConversation(db, { id: 'c1', ownerUserId: u.id, agentDeviceId: a.deviceId, repo: 'GitHub.com/x/y' }), /bad repo/)
  db.close()
})

test('snapshot: conversations carry repo', async () => {
  const db = openDb(':memory:')
  const u = await createUser(db, 'dan', 'pw')
  const a = createAgent(db, u.id, 'dev-2')
  upsertConversation(db, { id: 'c1', ownerUserId: u.id, title: 'C1', agentDeviceId: a.deviceId, repo: 'github.com/matronhq/x' })
  upsertConversation(db, { id: 'c2', ownerUserId: u.id, title: 'C2', agentDeviceId: a.deviceId })
  const snap = snapshot(db, u.id)
  const byId = Object.fromEntries(snap.conversations.map((c) => [c.id, c]))
  assert.equal(byId.c1.repo, 'github.com/matronhq/x')
  assert.equal(byId.c2.repo, null)
  db.close()
})
```

Append to `test/agent.test.js` (it uses `startTestServer`, `makeWsClient`, `createUser`, `createAgent`; follow the file's existing `hello` pattern, and match the frame shape the file already asserts for an op error — search it for `bad_request`):
```js
test('convo_upsert: repo rides to the row and the convo_meta fan-out; junk is bad_request', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: null })
  await client.waitFor((f) => f.op === 'hello_ok')
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  agent.send({ op: 'convo_upsert', convo_id: 'c1', title: 'C1', repo: 'github.com/matronhq/matron-journal' })
  const meta = await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta' && f.convo_id === 'c1')
  assert.equal(meta.payload.repo, 'github.com/matronhq/matron-journal')
  assert.equal(s.db.prepare('SELECT repo_scope FROM conversations WHERE id=?').get('c1').repo_scope, 'github.com/matronhq')
  agent.send({ op: 'convo_upsert', convo_id: 'c1', repo: 'not a repo' })
  const err = await agent.waitFor((f) => JSON.stringify(f).includes('bad_request'))
  assert.match(JSON.stringify(err), /bad repo/)
  agent.close(); client.close()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/journal.test.js test/agent.test.js`
Expected: FAIL — `repo` is undefined on the row; no `convo_meta` carrying `repo`.

- [ ] **Step 3: Implement in `src/journal.js`**

Add the import at the top:
```js
import { parseRepo } from './repo-identity.js'
```
Change the signature and add the `repo` handling to `upsertConversation`. Keep every existing line; only the marked additions are new:
```js
export function upsertConversation(db, { id, ownerUserId, title, sessionState, agentDeviceId, parentConvoId, sessionOutcome, summary, repo }) {
  // repo: undefined = unchanged, null = clear, string = canonical host/org/name.
  let repoCols = null // { repo, scope } to write, or null to leave alone
  if (repo === null) repoCols = { repo: null, scope: null }
  else if (repo !== undefined) {
    const p = parseRepo(repo)
    if (!p) throw new Error('bad repo')
    repoCols = { repo: p.repo, scope: p.scope }
  }
  const existing = db.prepare('SELECT * FROM conversations WHERE id=?').get(id)
  const prevSessionState = existing ? existing.session_state : undefined
  let metaChanged = false
  if (existing) {
    if (existing.owner_user_id !== ownerUserId) throw new Error('not authorized: convo owned by another user')
    if (title != null && title !== existing.title) metaChanged = true
    if (repoCols && (existing.repo ?? null) !== repoCols.repo) metaChanged = true          // NEW
    // ... existing guest computation and the COALESCE UPDATE, unchanged ...
    if (repoCols) db.prepare('UPDATE conversations SET repo=?, repo_scope=? WHERE id=?').run(repoCols.repo, repoCols.scope, id)  // NEW
  } else {
    // ... existing INSERT, unchanged ...
    if (repoCols && repoCols.repo) {                                                          // NEW
      db.prepare('UPDATE conversations SET repo=?, repo_scope=? WHERE id=?').run(repoCols.repo, repoCols.scope, id)
      metaChanged = true
    }
  }
  const convo = db.prepare('SELECT * FROM conversations WHERE id=?').get(id)
  return { ...convo, metaChanged, prevSessionState }
}
```
A separate `UPDATE` for the repo columns keeps the COALESCE statement untouched: `null` must clear, which COALESCE cannot express.

In `snapshot`, add `repo,` to the selected columns right after `summary,`:
```js
            parent_convo_id, summary, repo, created_at, agent_device_id,
```

- [ ] **Step 4: Implement in `src/ws.js`**

Add the import near the other `./` imports:
```js
import { parseRepo, REPO_MAX } from './repo-identity.js'
```
In `case 'convo_upsert'`, after the `summary` validation and before the room-upsert ownership gate:
```js
        // repo (spec 2026-09-23 tracker web/teams): absent = unchanged,
        // null = clear, string = canonical host/org/name from the bridge's
        // remote normalisation. Shape-checked here; upsertConversation
        // re-validates and would throw, so a bad string never reaches SQL.
        if (msg.repo !== undefined && msg.repo !== null && (
          typeof msg.repo !== 'string' || msg.repo.length > REPO_MAX || !parseRepo(msg.repo)
        )) {
          return fail('bad_request', 'bad repo')
        }
```
Pass it through to `upsertConversation`:
```js
          summary: msg.summary ?? null,
          repo: msg.repo,
```
In the `convo_meta` payload add `repo`:
```js
            payload: {
              title: convo.title,
              parent_convo_id: convo.parent_convo_id ?? null,
              agent_device_id: conn.deviceId,
              repo: convo.repo ?? null,
            },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/journal.test.js test/agent.test.js test/conformance.test.js`
Expected: PASS. If `test/conformance.test.js` pins the exact `convo_meta` payload keys or the `/snapshot` conversation keys, update its fixture under `test/fixtures/` to include `repo: null` and say so in the commit message.

- [ ] **Step 6: Document in `docs/protocol.md`**

In the `convo_upsert` bullet (near line 408) change the payload text to `payload:{title, parent_convo_id, agent_device_id, repo}` and add after that bullet:
```markdown
- `convo_upsert` accepts an optional `repo`: the canonical `host/org/name`
  of the session's git remote (lower-cased host and org, e.g.
  `github.com/matronhq/matron-journal`; regex
  `^[a-z0-9.-]+/[a-z0-9_.-]+/[A-Za-z0-9_.-]+$`, ≤ 256 chars). Absent leaves
  the stored value alone, `null` clears it, anything else is `bad_request`.
  A change appends a `convo_meta` carrying the new `repo`; `/snapshot`
  conversations carry `repo` too (`null` when unknown). The journal derives
  `repo_scope` (`host/org`) from it — the unit shared visibility is decided
  on (see "Shared visibility").
```

- [ ] **Step 7: Commit**

```bash
git add src/journal.js src/ws.js docs/protocol.md test/journal.test.js test/agent.test.js test/fixtures
git commit -m "journal: repo on convo_upsert, convo_meta and snapshot"
```

---

### Task 3: GitHub API client

**Files:**
- Create: `src/github.js`
- Test: `test/github.test.js`

**Interfaces:**
- Produces: `makeGithub({ clientId, clientSecret = null, host = 'github.com', fetchImpl = globalThis.fetch })` returning `{ enabled, webFlow, host, startDeviceFlow(), pollDeviceFlow(deviceCode), authorizeUrl(state), exchangeCode(code), fetchIdentity(token) }`.
- Produces: `class GithubError extends Error` with `code` ∈ `'unreachable' | 'unauthorized' | 'bad_response'`.
- Produces: `DEFAULT_GITHUB_CLIENT_ID` (empty string until Matron's published OAuth App exists — tracker task #2797 supplies the value; a one-line change here).

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeGithub, GithubError } from '../src/github.js'

// A fake fetch keyed by "METHOD url" prefix; each handler returns
// { status, json, headers } or throws for a network failure.
function fakeFetch(routes) {
  const calls = []
  const fetchImpl = async (url, opts = {}) => {
    const key = `${opts.method || 'GET'} ${url}`
    calls.push({ key, opts })
    const match = Object.entries(routes).find(([k]) => key.startsWith(k))
    if (!match) throw new Error(`unrouted ${key}`)
    const r = await match[1](opts, url)
    return {
      status: r.status ?? 200, ok: (r.status ?? 200) < 400,
      headers: { get: (h) => (r.headers || {})[h.toLowerCase()] ?? null },
      json: async () => r.json, text: async () => JSON.stringify(r.json),
    }
  }
  return { fetchImpl, calls }
}

test('makeGithub: enabled/webFlow reflect configuration', () => {
  assert.equal(makeGithub({ clientId: '' }).enabled, false)
  const g = makeGithub({ clientId: 'abc' })
  assert.equal(g.enabled, true); assert.equal(g.webFlow, false)
  assert.equal(makeGithub({ clientId: 'abc', clientSecret: 's' }).webFlow, true)
})

test('device flow: start posts client_id + read:org; poll maps GitHub errors to statuses', async () => {
  let pollN = 0
  const { fetchImpl, calls } = fakeFetch({
    'POST https://github.com/login/device/code': async () => ({ json: { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 } }),
    'POST https://github.com/login/oauth/access_token': async () => {
      pollN++
      if (pollN === 1) return { json: { error: 'authorization_pending' } }
      if (pollN === 2) return { json: { error: 'slow_down', interval: 10 } }
      if (pollN === 3) return { json: { error: 'expired_token' } }
      if (pollN === 4) return { json: { error: 'access_denied' } }
      return { json: { access_token: 'tok', scope: 'read:org' } }
    },
  })
  const g = makeGithub({ clientId: 'abc', fetchImpl })
  const start = await g.startDeviceFlow()
  assert.deepEqual(start, { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 })
  const body = new URLSearchParams(calls[0].opts.body)
  assert.equal(body.get('client_id'), 'abc'); assert.equal(body.get('scope'), 'read:org')
  assert.equal(calls[0].opts.headers.accept, 'application/json')
  assert.deepEqual(await g.pollDeviceFlow('dc'), { status: 'pending' })
  assert.deepEqual(await g.pollDeviceFlow('dc'), { status: 'pending', interval: 10 })
  assert.deepEqual(await g.pollDeviceFlow('dc'), { status: 'expired' })
  assert.deepEqual(await g.pollDeviceFlow('dc'), { status: 'denied' })
  assert.deepEqual(await g.pollDeviceFlow('dc'), { status: 'ok', token: 'tok' })
})

test('web flow: authorizeUrl carries client_id, scope and state; exchangeCode posts the secret', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'POST https://github.com/login/oauth/access_token': async () => ({ json: { access_token: 'tok' } }),
  })
  const g = makeGithub({ clientId: 'abc', clientSecret: 'sec', fetchImpl })
  const u = new URL(g.authorizeUrl('st4te'))
  assert.equal(u.origin + u.pathname, 'https://github.com/login/oauth/authorize')
  assert.equal(u.searchParams.get('client_id'), 'abc'); assert.equal(u.searchParams.get('scope'), 'read:org'); assert.equal(u.searchParams.get('state'), 'st4te')
  assert.deepEqual(await g.exchangeCode('c0de'), { token: 'tok' })
  const body = new URLSearchParams(calls[0].opts.body)
  assert.equal(body.get('client_secret'), 'sec'); assert.equal(body.get('code'), 'c0de')
  await assert.rejects(makeGithub({ clientId: 'abc', fetchImpl }).exchangeCode('x'), /web flow not configured/)
})

test('fetchIdentity: reads /user and paginates org memberships into lower-cased scopes', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'GET https://api.github.com/user/memberships/orgs?state=active&per_page=100&page=2': async () => ({ json: [{ state: 'active', organization: { login: 'Yearbooks' } }] }),
    'GET https://api.github.com/user/memberships/orgs': async () => ({ json: [{ state: 'active', organization: { login: 'MatronHQ' } }, { state: 'pending', organization: { login: 'Nope' } }], headers: { link: '<https://api.github.com/user/memberships/orgs?state=active&per_page=100&page=2>; rel="next"' } }),
    'GET https://api.github.com/user': async () => ({ json: { id: 42, login: 'DanBarker' } }),
  })
  const g = makeGithub({ clientId: 'abc', fetchImpl })
  const id = await g.fetchIdentity('tok')
  assert.deepEqual(id, { github_id: 42, login: 'DanBarker', scopes: ['github.com/matronhq', 'github.com/yearbooks'] })
  assert.ok(calls.every((c) => c.opts.headers.authorization === 'Bearer tok'))
})

test('fetchIdentity: 401/403 is unauthorized, a network failure is unreachable, junk is bad_response', async () => {
  const g401 = makeGithub({ clientId: 'abc', fetchImpl: fakeFetch({ 'GET https://api.github.com/user': async () => ({ status: 401, json: { message: 'Bad credentials' } }) }).fetchImpl })
  await assert.rejects(g401.fetchIdentity('t'), (e) => e instanceof GithubError && e.code === 'unauthorized')
  const gNet = makeGithub({ clientId: 'abc', fetchImpl: async () => { throw new Error('ECONNRESET') } })
  await assert.rejects(gNet.fetchIdentity('t'), (e) => e instanceof GithubError && e.code === 'unreachable')
  const gJunk = makeGithub({ clientId: 'abc', fetchImpl: fakeFetch({ 'GET https://api.github.com/user': async () => ({ json: { nope: true } }) }).fetchImpl })
  await assert.rejects(gJunk.fetchIdentity('t'), (e) => e instanceof GithubError && e.code === 'bad_response')
})

test('GHES host: login and api URLs follow the configured host', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'POST https://ghe.example.com/login/device/code': async () => ({ json: { device_code: 'd', user_code: 'u', verification_uri: 'v', interval: 5, expires_in: 9 } }),
    'GET https://ghe.example.com/api/v3/user/memberships/orgs': async () => ({ json: [] }),
    'GET https://ghe.example.com/api/v3/user': async () => ({ json: { id: 1, login: 'x' } }),
  })
  const g = makeGithub({ clientId: 'abc', host: 'ghe.example.com', fetchImpl })
  await g.startDeviceFlow()
  assert.deepEqual((await g.fetchIdentity('t')).scopes, [])
  assert.ok(calls.some((c) => c.key.startsWith('GET https://ghe.example.com/api/v3/user')))
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/github.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/github.js`**

```js
// GitHub OAuth + org-membership client (spec 2026-09-23 tracker web/teams,
// "GitHub account linking"). Two flows over ONE OAuth App: the device flow
// (client id only — works for any self-hosted journal) and the web flow
// (needs the client secret an installation's own app has). The only API
// question ever asked is "who is this token, and which orgs is it an active
// member of" — with the user's own read:org token, so private org
// memberships are visible without any org-level install.
//
// `fetchImpl` is the test seam. Nothing here logs a token or a code.

// Matron's published OAuth App client id. Empty until the app is registered
// (tracker task #2797); an empty id means "linking not configured" unless
// MATRON_GITHUB_CLIENT_ID overrides it.
export const DEFAULT_GITHUB_CLIENT_ID = ''
export const GITHUB_SCOPE = 'read:org'

export class GithubError extends Error {
  constructor(code, message) { super(message || code); this.code = code }
}

const form = (obj) => new URLSearchParams(obj).toString()

export function makeGithub({ clientId, clientSecret = null, host = 'github.com', fetchImpl = globalThis.fetch } = {}) {
  const enabled = typeof clientId === 'string' && clientId.length > 0
  const webFlow = enabled && typeof clientSecret === 'string' && clientSecret.length > 0
  const loginBase = `https://${host}`
  const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`

  async function call(method, url, { body = null, token = null } = {}) {
    const headers = { accept: 'application/json', 'user-agent': 'matron-journal' }
    if (body != null) headers['content-type'] = 'application/x-www-form-urlencoded'
    if (token) headers.authorization = `Bearer ${token}`
    let res
    try {
      res = await fetchImpl(url, { method, headers, body: body == null ? undefined : body })
    } catch (err) {
      throw new GithubError('unreachable', `github ${method} ${new URL(url).pathname}: ${err.message}`)
    }
    if (res.status === 401 || res.status === 403) throw new GithubError('unauthorized')
    if (res.status >= 500) throw new GithubError('unreachable', `github answered ${res.status}`)
    let json = null
    try { json = await res.json() } catch { throw new GithubError('bad_response') }
    return { status: res.status, json, headers: res.headers }
  }

  async function startDeviceFlow() {
    if (!enabled) throw new GithubError('bad_response', 'github linking not configured')
    const { json } = await call('POST', `${loginBase}/login/device/code`, { body: form({ client_id: clientId, scope: GITHUB_SCOPE }) })
    const { device_code, user_code, verification_uri, interval, expires_in } = json || {}
    if (typeof device_code !== 'string' || typeof user_code !== 'string' || typeof verification_uri !== 'string') throw new GithubError('bad_response')
    return { device_code, user_code, verification_uri, interval: Number(interval) || 5, expires_in: Number(expires_in) || 900 }
  }

  // Maps GitHub's device-flow poll answers onto the journal's own statuses.
  async function pollDeviceFlow(deviceCode) {
    const { json } = await call('POST', `${loginBase}/login/oauth/access_token`, {
      body: form({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    })
    if (json && typeof json.access_token === 'string') return { status: 'ok', token: json.access_token }
    switch (json && json.error) {
      case 'authorization_pending': return { status: 'pending' }
      case 'slow_down': return { status: 'pending', interval: Number(json.interval) || 10 }
      case 'expired_token': return { status: 'expired' }
      case 'access_denied': return { status: 'denied' }
      default: throw new GithubError('bad_response', `device poll: ${json && json.error}`)
    }
  }

  function authorizeUrl(state) {
    if (!webFlow) throw new GithubError('bad_response', 'web flow not configured')
    const u = new URL(`${loginBase}/login/oauth/authorize`)
    u.searchParams.set('client_id', clientId)
    u.searchParams.set('scope', GITHUB_SCOPE)
    u.searchParams.set('state', state)
    return u.toString()
  }

  async function exchangeCode(code) {
    if (!webFlow) throw new GithubError('bad_response', 'web flow not configured')
    const { json } = await call('POST', `${loginBase}/login/oauth/access_token`, {
      body: form({ client_id: clientId, client_secret: clientSecret, code }),
    })
    if (!json || typeof json.access_token !== 'string') throw new GithubError('bad_response', `code exchange: ${json && json.error}`)
    return { token: json.access_token }
  }

  // Follows RFC 5988 `Link: <url>; rel="next"` pagination.
  const nextLink = (headers) => {
    const link = headers && headers.get('link')
    if (!link) return null
    const m = /<([^>]+)>;\s*rel="next"/.exec(link)
    return m ? m[1] : null
  }

  async function fetchIdentity(token) {
    const user = await call('GET', `${apiBase}/user`, { token })
    if (!user.json || !Number.isInteger(user.json.id) || typeof user.json.login !== 'string') throw new GithubError('bad_response', 'user shape')
    const scopes = new Set()
    let url = `${apiBase}/user/memberships/orgs?state=active&per_page=100`
    for (let page = 0; url && page < 20; page++) {
      const r = await call('GET', url, { token })
      if (!Array.isArray(r.json)) throw new GithubError('bad_response', 'memberships shape')
      for (const m of r.json) {
        const login = m && m.organization && m.organization.login
        if (m.state === 'active' && typeof login === 'string' && login) scopes.add(`${host}/${login.toLowerCase()}`)
      }
      url = nextLink(r.headers)
    }
    return { github_id: user.json.id, login: user.json.login, scopes: [...scopes].sort() }
  }

  return { enabled, webFlow, host, startDeviceFlow, pollDeviceFlow, authorizeUrl, exchangeCode, fetchIdentity }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/github.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/github.js test/github.test.js
git commit -m "journal: GitHub OAuth device/web flow and org membership client"
```

---

### Task 4: GitHub accounts storage

**Files:**
- Create: `src/github-accounts.js`
- Test: `test/github-accounts.test.js`

**Interfaces:**
- Consumes: tables from Task 1.
- Produces:
  - `githubAccountView(db, userId) -> { host, login, orgs: string[], state, checked_at, linked_at } | null` (never includes the token)
  - `saveGithubIdentity(db, { userId, host, identity: {github_id, login, scopes}, token, now }) -> view` — throws `Error('github_conflict')` if the identity is bound to another user
  - `markGithubStale(db, userId, now)`, `deleteGithubAccount(db, userId) -> boolean`
  - `listGithubAccounts(db) -> [{ user_id, host, token }]`
  - `createLinkFlow(db, { userId, deviceId, flow, deviceCode = null, state = null, ttlMs = 600000, now }) -> row`
  - `takeLinkFlow(db, { id = null, state = null, now }) -> row | null` — returns and **deletes** the row (single use); expired rows are deleted and answer null
  - `LINK_FLOW_TTL_MS = 600000`

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser } from '../src/auth.js'
import {
  githubAccountView, saveGithubIdentity, markGithubStale, deleteGithubAccount, listGithubAccounts,
  createLinkFlow, takeLinkFlow, LINK_FLOW_TTL_MS,
} from '../src/github-accounts.js'

const identity = { github_id: 42, login: 'DanBarker', scopes: ['github.com/matronhq'] }

test('saveGithubIdentity: creates, replaces orgs on re-save, and refuses an identity bound elsewhere', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const pat = await createUser(db, 'pat', 'pw')
  const v = saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity, token: 't1', now: 1000 })
  assert.deepEqual(v, { host: 'github.com', login: 'DanBarker', orgs: ['github.com/matronhq'], state: 'ok', checked_at: 1000, linked_at: 1000 })
  assert.equal(githubAccountView(db, dan.id).token, undefined, 'the view never carries the token')
  const v2 = saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity: { ...identity, scopes: ['github.com/yearbooks'] }, token: 't2', now: 2000 })
  assert.deepEqual(v2.orgs, ['github.com/yearbooks']); assert.equal(v2.linked_at, 1000); assert.equal(v2.checked_at, 2000)
  assert.equal(db.prepare('SELECT token FROM github_accounts WHERE user_id=?').get(dan.id).token, 't2')
  assert.throws(() => saveGithubIdentity(db, { userId: pat.id, host: 'github.com', identity, token: 't3', now: 3000 }), /github_conflict/)
  assert.equal(githubAccountView(db, pat.id), null)
  assert.deepEqual(listGithubAccounts(db), [{ user_id: dan.id, host: 'github.com', token: 't2' }])
  db.close()
})

test('stale and delete', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity, token: 't', now: 1 })
  markGithubStale(db, dan.id, 5)
  assert.equal(githubAccountView(db, dan.id).state, 'stale')
  assert.deepEqual(githubAccountView(db, dan.id).orgs, ['github.com/matronhq'], 'orgs are kept while stale')
  assert.equal(deleteGithubAccount(db, dan.id), true)
  assert.equal(deleteGithubAccount(db, dan.id), false)
  assert.equal(githubAccountView(db, dan.id), null)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM github_orgs').get().n, 0, 'orgs cascade')
  db.close()
})

test('link flows: single use, expire, looked up by id or state', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const f = createLinkFlow(db, { userId: dan.id, deviceId: 9, flow: 'device', deviceCode: 'dc', now: 1000 })
  assert.match(f.id, /^gl_[0-9a-f]{16}$/); assert.equal(f.expires_at, 1000 + LINK_FLOW_TTL_MS)
  const taken = takeLinkFlow(db, { id: f.id, now: 2000 })
  assert.equal(taken.device_code, 'dc'); assert.equal(taken.user_id, dan.id)
  assert.equal(takeLinkFlow(db, { id: f.id, now: 2000 }), null, 'single use')
  const w = createLinkFlow(db, { userId: dan.id, deviceId: 9, flow: 'web', state: 'st', now: 1000 })
  assert.equal(takeLinkFlow(db, { state: 'st', now: 1000 + LINK_FLOW_TTL_MS + 1 }), null, 'expired')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM github_link_flows WHERE id=?').get(w.id).n, 0, 'expired rows are deleted on read')
  db.close()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/github-accounts.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/github-accounts.js`**

```js
// Storage for GitHub account links (spec 2026-09-23 tracker web/teams,
// "GitHub account linking"). Pure DB functions; the HTTP layer and the
// refresh job call these. The token column is written here and read by
// listGithubAccounts (the refresh job) — no view ever returns it.
import { randomBytes } from 'node:crypto'

export const LINK_FLOW_TTL_MS = 10 * 60 * 1000

export function githubAccountView(db, userId) {
  const row = db.prepare('SELECT host, login, state, checked_at, linked_at FROM github_accounts WHERE user_id=?').get(userId)
  if (!row) return null
  const orgs = db.prepare('SELECT scope FROM github_orgs WHERE user_id=? ORDER BY scope').all(userId).map((r) => r.scope)
  return { host: row.host, login: row.login, orgs, state: row.state, checked_at: row.checked_at, linked_at: row.linked_at }
}

// One GitHub identity per journal user, one journal user per identity.
export function saveGithubIdentity(db, { userId, host, identity, token, now = Date.now() }) {
  return db.transaction(() => {
    const other = db.prepare('SELECT user_id FROM github_accounts WHERE host=? AND github_id=? AND user_id<>?').get(host, identity.github_id, userId)
    if (other) throw new Error('github_conflict')
    db.prepare(`INSERT INTO github_accounts(user_id, host, github_id, login, token, state, checked_at, linked_at)
      VALUES(?,?,?,?,?,'ok',?,?)
      ON CONFLICT(user_id) DO UPDATE SET host=excluded.host, github_id=excluded.github_id, login=excluded.login,
        token=excluded.token, state='ok', checked_at=excluded.checked_at`).run(userId, host, identity.github_id, identity.login, token, now, now)
    db.prepare('DELETE FROM github_orgs WHERE user_id=?').run(userId)
    const ins = db.prepare('INSERT INTO github_orgs(user_id, scope) VALUES(?,?)')
    for (const scope of new Set(identity.scopes)) ins.run(userId, scope)
    return githubAccountView(db, userId)
  })()
}

export function markGithubStale(db, userId, now = Date.now()) {
  db.prepare("UPDATE github_accounts SET state='stale', checked_at=? WHERE user_id=?").run(now, userId)
}

export function deleteGithubAccount(db, userId) {
  return db.prepare('DELETE FROM github_accounts WHERE user_id=?').run(userId).changes > 0
}

export function listGithubAccounts(db) {
  return db.prepare('SELECT user_id, host, token FROM github_accounts ORDER BY user_id').all()
}

export function createLinkFlow(db, { userId, deviceId, flow, deviceCode = null, state = null, ttlMs = LINK_FLOW_TTL_MS, now = Date.now() }) {
  const id = `gl_${randomBytes(8).toString('hex')}`
  db.prepare('INSERT INTO github_link_flows(id, user_id, device_id, flow, device_code, state, expires_at, created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, userId, deviceId, flow, deviceCode, state, now + ttlMs, now)
  return db.prepare('SELECT * FROM github_link_flows WHERE id=?').get(id)
}

// Returns the row and deletes it — a flow is finished by exactly one poll
// or one callback. Expired rows are swept on read and answer null.
export function takeLinkFlow(db, { id = null, state = null, now = Date.now() }) {
  return db.transaction(() => {
    db.prepare('DELETE FROM github_link_flows WHERE expires_at <= ?').run(now)
    const row = id != null
      ? db.prepare('SELECT * FROM github_link_flows WHERE id=?').get(id)
      : (state != null ? db.prepare("SELECT * FROM github_link_flows WHERE state=? AND flow='web'").get(state) : null)
    if (!row) return null
    db.prepare('DELETE FROM github_link_flows WHERE id=?').run(row.id)
    return row
  })()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/github-accounts.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/github-accounts.js test/github-accounts.test.js
git commit -m "journal: GitHub account and link-flow storage"
```

---

### Task 5: Linking routes and server wiring

**Files:**
- Create: `src/github-http.js`
- Modify: `src/server.js` (options, `makeHttpHandler` args, env), `src/http.js` (mount + `/me`)
- Test: `test/github-http.test.js`

**Interfaces:**
- Consumes: `makeGithub`, `GithubError`, `DEFAULT_GITHUB_CLIENT_ID` (Task 3); storage functions (Task 4).
- Produces: `handleGithubRoute(ctx, req, res, url, who) -> boolean` for `POST /github/link`, `POST /github/link/:id/poll`, `POST /github/refresh`, `DELETE /github/link`; `handleGithubCallback(ctx, req, res, url) -> boolean` for the unauthenticated `GET /github/callback`.
- Produces: `finishLink(db, github, { userId, token, now }) -> view` (shared by poll and callback; throws `Error('github_conflict')` or `GithubError`).
- Produces: `refreshGithubAccount(db, github, userId, now) -> { view, outcome: 'ok'|'stale'|'unchanged', error? } | null` (used by Task 6).
- Produces: `startServer({ github, ... })` seam; env `MATRON_GITHUB_CLIENT_ID`, `MATRON_GITHUB_CLIENT_SECRET`, `MATRON_GITHUB_HOST`; `startServer(...)` resolves with `github` on the returned object.
- Produces: `GET /me -> { user: {id, name}, github: view | null, github_linking: { enabled, web_flow } }`.

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { GithubError } from '../src/github.js'

// A scripted stand-in for makeGithub(): poll/identity/exchange answers are
// queues of thunks; an empty queue answers the default.
function fakeGithub({ enabled = true, webFlow = false } = {}) {
  const q = { poll: [], identity: [], exchange: [] }
  const next = (k, fallback) => (q[k].length ? q[k].shift() : fallback)()
  return {
    q, enabled, webFlow, host: 'github.com',
    startDeviceFlow: async () => ({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 }),
    pollDeviceFlow: async () => next('poll', () => ({ status: 'pending' })),
    authorizeUrl: (state) => `https://github.com/login/oauth/authorize?client_id=abc&scope=read%3Aorg&state=${state}`,
    exchangeCode: async () => next('exchange', () => ({ token: 'tok' })),
    fetchIdentity: async () => next('identity', () => ({ github_id: 42, login: 'DanBarker', scopes: ['github.com/matronhq'] })),
  }
}

async function fleet(t, github) {
  const s = await startTestServer({ github })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  const danTok = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })).json.token
  const patTok = (await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'pw', device_name: 'mac' } })).json.token
  return { s, dan, pat, agent, danTok, patTok }
}

test('device flow end to end: start, poll pending, poll linked; /me shows the link', async (t) => {
  const gh = fakeGithub()
  const { s, danTok, agent } = await fleet(t, gh)
  const me0 = await s.http('/me', { token: danTok })
  assert.equal(me0.status, 200); assert.equal(me0.json.github, null); assert.deepEqual(me0.json.github_linking, { enabled: true, web_flow: false })
  assert.equal((await s.http('/github/link', { method: 'POST', token: agent.token, body: { flow: 'device' } })).status, 403, 'agents do not link accounts')
  const start = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  assert.equal(start.status, 200)
  assert.match(start.json.flow_id, /^gl_/); assert.equal(start.json.user_code, 'ABCD-1234'); assert.equal(start.json.interval, 5)
  assert.equal((await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'web' } })).status, 400, 'web flow needs a secret')
  const p1 = await s.http(`/github/link/${start.json.flow_id}/poll`, { method: 'POST', token: danTok })
  assert.deepEqual(p1.json, { status: 'pending' })
  gh.q.poll.push(() => ({ status: 'ok', token: 'tok' }))
  const p2 = await s.http(`/github/link/${start.json.flow_id}/poll`, { method: 'POST', token: danTok })
  assert.equal(p2.status, 200); assert.equal(p2.json.status, 'linked'); assert.equal(p2.json.github.login, 'DanBarker')
  assert.deepEqual(p2.json.github.orgs, ['github.com/matronhq'])
  assert.equal((await s.http(`/github/link/${start.json.flow_id}/poll`, { method: 'POST', token: danTok })).status, 404, 'flow is single use')
  const me = await s.http('/me', { token: danTok })
  assert.equal(me.json.github.login, 'DanBarker'); assert.equal(me.json.github.state, 'ok')
  assert.equal(JSON.stringify(me.json).includes('tok'), false, 'token never leaves the journal')
})

test('device flow: denied and expired end the flow; another user cannot poll it', async (t) => {
  const gh = fakeGithub()
  const { s, danTok, patTok } = await fleet(t, gh)
  const a = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  assert.equal((await s.http(`/github/link/${a.json.flow_id}/poll`, { method: 'POST', token: patTok })).status, 404)
  gh.q.poll.push(() => ({ status: 'denied' }))
  assert.deepEqual((await s.http(`/github/link/${a.json.flow_id}/poll`, { method: 'POST', token: danTok })).json, { status: 'denied' })
  assert.equal((await s.http(`/github/link/${a.json.flow_id}/poll`, { method: 'POST', token: danTok })).status, 404)
  const b = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  gh.q.poll.push(() => ({ status: 'expired' }))
  assert.deepEqual((await s.http(`/github/link/${b.json.flow_id}/poll`, { method: 'POST', token: danTok })).json, { status: 'expired' })
})

test('conflict: the same GitHub identity cannot be linked to two users (review focus 3)', async (t) => {
  const gh = fakeGithub()
  const { s, danTok, patTok } = await fleet(t, gh)
  const a = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  gh.q.poll.push(() => ({ status: 'ok', token: 't1' }))
  assert.equal((await s.http(`/github/link/${a.json.flow_id}/poll`, { method: 'POST', token: danTok })).json.status, 'linked')
  const b = await s.http('/github/link', { method: 'POST', token: patTok, body: { flow: 'device' } })
  gh.q.poll.push(() => ({ status: 'ok', token: 't2' }))
  const r = await s.http(`/github/link/${b.json.flow_id}/poll`, { method: 'POST', token: patTok })
  assert.equal(r.status, 409); assert.equal(r.json.error, 'conflict')
  assert.equal((await s.http('/me', { token: danTok })).json.github.login, 'DanBarker', 'first link untouched')
  assert.equal((await s.http('/me', { token: patTok })).json.github, null)
})

test('web flow: link returns the authorize URL; callback binds to the flow row, redirects, and a replayed state fails (review focus 4)', async (t) => {
  const gh = fakeGithub({ webFlow: true })
  const { s, danTok } = await fleet(t, gh)
  const start = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'web' } })
  assert.equal(start.status, 200)
  const state = new URL(start.json.url).searchParams.get('state')
  assert.match(state, /^[0-9a-f]{32}$/)
  // No Bearer on the callback: it is the browser coming back from GitHub.
  const cb = await fetch(`${s.base}/github/callback?code=c0de&state=${state}`, { redirect: 'manual' })
  assert.equal(cb.status, 302); assert.equal(cb.headers.get('location'), '/account?linked=1')
  assert.equal((await s.http('/me', { token: danTok })).json.github.login, 'DanBarker')
  const replay = await fetch(`${s.base}/github/callback?code=c0de&state=${state}`, { redirect: 'manual' })
  assert.equal(replay.status, 302); assert.equal(replay.headers.get('location'), '/account?link_error=expired')
  const junk = await fetch(`${s.base}/github/callback?code=c0de&state=nope`, { redirect: 'manual' })
  assert.equal(junk.headers.get('location'), '/account?link_error=expired')
  const start2 = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'web' } })
  const state2 = new URL(start2.json.url).searchParams.get('state')
  const missing = await fetch(`${s.base}/github/callback?state=${state2}`, { redirect: 'manual' })
  assert.equal(missing.headers.get('location'), '/account?link_error=bad_request')
  const again = await fetch(`${s.base}/github/callback?code=c0de&state=${state2}`, { redirect: 'manual' })
  assert.equal(again.headers.get('location'), '/account?link_error=expired', 'a code-less callback still consumed the state')
})

test('refresh: ok updates orgs; unauthorized marks stale; unreachable leaves everything; unlink deletes', async (t) => {
  const gh = fakeGithub()
  const { s, danTok } = await fleet(t, gh)
  const a = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  gh.q.poll.push(() => ({ status: 'ok', token: 't1' }))
  await s.http(`/github/link/${a.json.flow_id}/poll`, { method: 'POST', token: danTok })
  gh.q.identity.push(() => ({ github_id: 42, login: 'DanBarker', scopes: ['github.com/matronhq', 'github.com/yearbooks'] }))
  const r1 = await s.http('/github/refresh', { method: 'POST', token: danTok })
  assert.equal(r1.status, 200); assert.deepEqual(r1.json.github.orgs, ['github.com/matronhq', 'github.com/yearbooks'])
  gh.q.identity.push(() => { throw new GithubError('unauthorized') })
  const r2 = await s.http('/github/refresh', { method: 'POST', token: danTok })
  assert.equal(r2.status, 200); assert.equal(r2.json.github.state, 'stale')
  gh.q.identity.push(() => { throw new GithubError('unreachable') })
  const r3 = await s.http('/github/refresh', { method: 'POST', token: danTok })
  assert.equal(r3.status, 502); assert.equal(r3.json.error, 'upstream')
  assert.equal((await s.http('/me', { token: danTok })).json.github.state, 'stale', 'unreachable changed nothing')
  assert.equal((await s.http('/github/link', { method: 'DELETE', token: danTok })).status, 200)
  assert.equal((await s.http('/me', { token: danTok })).json.github, null)
  assert.equal((await s.http('/github/link', { method: 'DELETE', token: danTok })).status, 404)
  assert.equal((await s.http('/github/refresh', { method: 'POST', token: danTok })).status, 404, 'nothing to refresh')
})

test('not configured: every linking route is 404 not_configured; /me says so', async (t) => {
  const { s, danTok } = await fleet(t, fakeGithub({ enabled: false }))
  assert.deepEqual((await s.http('/me', { token: danTok })).json.github_linking, { enabled: false, web_flow: false })
  const r = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  assert.equal(r.status, 404); assert.equal(r.json.error, 'not_configured')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/github-http.test.js`
Expected: FAIL — `/me` and `/github/*` answer 404 `not_found` (unrouted).

- [ ] **Step 3: Write `src/github-http.js`**

```js
// HTTP surface of GitHub account linking (spec 2026-09-23 tracker
// web/teams, "Flows"). Client devices only: an agent (the bridge) never
// links its user's identity. Every route but the callback sits behind
// Bearer auth; the callback is authenticated by the single-use `state` the
// journal minted for the flow row, so the browser's session is ignored.
import { randomBytes } from 'node:crypto'
import { json, readBody } from './http-body.js'
import { badRequest, notFound, conflict } from './http-who.js'
import { GithubError } from './github.js'
import {
  githubAccountView, saveGithubIdentity, markGithubStale, deleteGithubAccount,
  createLinkFlow, takeLinkFlow,
} from './github-accounts.js'

const FLOWS = ['device', 'web']
const notConfigured = (res) => { json(res, 404, { error: 'not_configured' }); return true }
const upstream = (res) => { json(res, 502, { error: 'upstream' }); return true }
const forbidden = (res) => { json(res, 403, { error: 'forbidden' }); return true }

// Turns a fresh token into a stored link. Shared by the poll and the
// callback so the two flows cannot drift.
export async function finishLink(db, github, { userId, token, now = Date.now() }) {
  const identity = await github.fetchIdentity(token)
  return saveGithubIdentity(db, { userId, host: github.host, identity, token, now })
}

// Re-reads memberships with the stored token. 'stale' = GitHub refused the
// token (fail closed: the predicate ignores stale rows); 'unchanged' =
// GitHub was unreachable or answered junk, previous list kept.
export async function refreshGithubAccount(db, github, userId, now = Date.now()) {
  const row = db.prepare('SELECT token FROM github_accounts WHERE user_id=?').get(userId)
  if (!row) return null
  try {
    const identity = await github.fetchIdentity(row.token)
    return { view: saveGithubIdentity(db, { userId, host: github.host, identity, token: row.token, now }), outcome: 'ok' }
  } catch (err) {
    if (err instanceof GithubError && err.code === 'unauthorized') {
      markGithubStale(db, userId, now)
      return { view: githubAccountView(db, userId), outcome: 'stale' }
    }
    if (err instanceof GithubError) return { view: githubAccountView(db, userId), outcome: 'unchanged', error: err }
    throw err
  }
}

export async function handleGithubRoute(ctx, req, res, url, who) {
  const { db, github, rateLimiter } = ctx
  const path = url.pathname
  if (path !== '/github/link' && path !== '/github/refresh' && !path.startsWith('/github/link/')) return false
  if (who.kind !== 'client') return forbidden(res)
  if (!github || !github.enabled) return notConfigured(res)

  if (path === '/github/link' && req.method === 'POST') {
    // Same per-IP limiter /login uses: a link start is a GitHub round trip.
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown'
    if (rateLimiter && !rateLimiter.allow(ip)) { json(res, 429, { error: 'rate_limited' }); return true }
    const body = await readBody(req)
    if (!FLOWS.includes(body.flow)) return badRequest(res)
    if (body.flow === 'web') {
      if (!github.webFlow) return badRequest(res)
      const state = randomBytes(16).toString('hex')
      createLinkFlow(db, { userId: who.userId, deviceId: who.deviceId, flow: 'web', state })
      json(res, 200, { url: github.authorizeUrl(state) })
      return true
    }
    let start
    try { start = await github.startDeviceFlow() } catch (err) { if (err instanceof GithubError) return upstream(res); throw err }
    const flow = createLinkFlow(db, { userId: who.userId, deviceId: who.deviceId, flow: 'device', deviceCode: start.device_code, ttlMs: start.expires_in * 1000 })
    json(res, 200, { flow_id: flow.id, user_code: start.user_code, verification_uri: start.verification_uri, interval: start.interval, expires_in: start.expires_in })
    return true
  }

  const m = path.match(/^\/github\/link\/([^/]+)\/poll$/)
  if (m && req.method === 'POST') {
    // Peek without consuming: a pending poll must leave the row in place.
    const row = db.prepare("SELECT * FROM github_link_flows WHERE id=? AND flow='device' AND user_id=? AND expires_at > ?").get(m[1], who.userId, Date.now())
    if (!row) return notFound(res)
    let poll
    try { poll = await github.pollDeviceFlow(row.device_code) } catch (err) { if (err instanceof GithubError) return upstream(res); throw err }
    if (poll.status === 'pending') { json(res, 200, poll.interval ? { status: 'pending', interval: poll.interval } : { status: 'pending' }); return true }
    // Every other answer ends the flow, so consume the row now.
    takeLinkFlow(db, { id: row.id })
    if (poll.status !== 'ok') { json(res, 200, { status: poll.status }); return true }
    try {
      const view = await finishLink(db, github, { userId: who.userId, token: poll.token })
      json(res, 200, { status: 'linked', github: view })
    } catch (err) {
      if (err.message === 'github_conflict') return conflict(res)
      if (err instanceof GithubError) return upstream(res)
      throw err
    }
    return true
  }

  if (path === '/github/link' && req.method === 'DELETE') {
    if (!deleteGithubAccount(db, who.userId)) return notFound(res)
    json(res, 200, { ok: true })
    return true
  }

  if (path === '/github/refresh' && req.method === 'POST') {
    const r = await refreshGithubAccount(db, github, who.userId)
    if (!r) return notFound(res)
    if (r.outcome === 'unchanged') return upstream(res)
    json(res, 200, { github: r.view })
    return true
  }
  return false
}

// GET /github/callback?code&state — the browser returning from GitHub's
// authorize page. No Bearer: the flow row's `state` is the credential, and
// it binds the resulting link to the row's user. Always redirects into the
// web app's account page so a user never sees raw JSON here. The state is
// consumed BEFORE the code is checked, so a malformed callback still burns
// the state and a replay cannot complete it later.
export async function handleGithubCallback(ctx, req, res, url) {
  if (url.pathname !== '/github/callback' || req.method !== 'GET') return false
  const { db, github } = ctx
  const redirect = (to) => { res.writeHead(302, { location: to }); res.end(); return true }
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!github || !github.enabled || !github.webFlow) return redirect('/account?link_error=not_configured')
  if (typeof state !== 'string' || !state) return redirect('/account?link_error=bad_request')
  const row = takeLinkFlow(db, { state })
  if (!row) return redirect('/account?link_error=expired')
  if (typeof code !== 'string' || !code) return redirect('/account?link_error=bad_request')
  try {
    const { token } = await github.exchangeCode(code)
    await finishLink(db, github, { userId: row.user_id, token })
    return redirect('/account?linked=1')
  } catch (err) {
    if (err.message === 'github_conflict') return redirect('/account?link_error=conflict')
    if (err instanceof GithubError) return redirect('/account?link_error=upstream')
    throw err
  }
}
```

- [ ] **Step 4: Mount in `src/http.js` and add `/me`**

Add the imports:
```js
import { handleGithubRoute, handleGithubCallback } from './github-http.js'
import { githubAccountView } from './github-accounts.js'
```
Add `github = null` to `makeHttpHandler`'s destructured options.

Before the `const who = bearer(req) && authToken(db, bearer(req))` line (it must run unauthenticated, next to `/login` and `/link/*`):
```js
      if (await handleGithubCallback({ db, github }, req, res, url)) return
```
Right after the `handleMissionsRoute` mount:
```js
      if (await handleGithubRoute({ db, github, rateLimiter }, req, res, url, who)) return
      if (req.method === 'GET' && url.pathname === '/me') {
        const user = db.prepare('SELECT id, name FROM users WHERE id=?').get(who.userId)
        return json(res, 200, {
          user: { id: user.id, name: user.name },
          github: githubAccountView(db, who.userId),
          github_linking: { enabled: !!(github && github.enabled), web_flow: !!(github && github.webFlow) },
        })
      }
```

- [ ] **Step 5: Wire configuration in `src/server.js`**

Add the import:
```js
import { makeGithub, DEFAULT_GITHUB_CLIENT_ID } from './github.js'
```
Add `github` to `startServer`'s destructured options (next to `waker, transcriber`). After `itemTranscription` is built:
```js
  // GitHub account linking (spec 2026-09-23 tracker web/teams). `github` is
  // the test seam; env otherwise. An empty client id disables the routes.
  const resolvedGithub = github !== undefined ? github : makeGithub({
    clientId: process.env.MATRON_GITHUB_CLIENT_ID ?? DEFAULT_GITHUB_CLIENT_ID,
    clientSecret: process.env.MATRON_GITHUB_CLIENT_SECRET || null,
    host: process.env.MATRON_GITHUB_HOST || 'github.com',
  })
```
Pass `github: resolvedGithub` into `makeHttpHandler({...})` and add `github: resolvedGithub` to the object `resolve(...)` returns.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/github-http.test.js test/http.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/github-http.js src/http.js src/server.js test/github-http.test.js
git commit -m "journal: GitHub linking routes (device + web flow), refresh, unlink, /me"
```

---

### Task 6: Daily membership refresh job

**Files:**
- Create: `src/github-refresh.js`
- Modify: `src/server.js` (schedule + close)
- Test: `test/github-refresh.test.js`

**Interfaces:**
- Consumes: `listGithubAccounts` (Task 4), `refreshGithubAccount` (Task 5).
- Produces: `runGithubRefresh(db, github, { now = Date.now(), log = console.log } = {}) -> { refreshed, stale, unchanged }`; `scheduleGithubRefresh(db, github, { intervalMs, log }) -> interval | null`; `GITHUB_REFRESH_INTERVAL_MS`; `startServer({ githubRefreshIntervalMs })` option, default 24 h.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser } from '../src/auth.js'
import { saveGithubIdentity, githubAccountView } from '../src/github-accounts.js'
import { GithubError } from '../src/github.js'
import { runGithubRefresh } from '../src/github-refresh.js'

test('runGithubRefresh: refreshes every linked account, marks refused tokens stale, keeps unreachable ones', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const pat = await createUser(db, 'pat', 'pw')
  const sam = await createUser(db, 'sam', 'pw')
  saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity: { github_id: 1, login: 'dan', scopes: ['github.com/a'] }, token: 'tdan', now: 1 })
  saveGithubIdentity(db, { userId: pat.id, host: 'github.com', identity: { github_id: 2, login: 'pat', scopes: ['github.com/a'] }, token: 'tpat', now: 1 })
  saveGithubIdentity(db, { userId: sam.id, host: 'github.com', identity: { github_id: 3, login: 'sam', scopes: ['github.com/a'] }, token: 'tsam', now: 1 })
  const github = {
    host: 'github.com', enabled: true,
    fetchIdentity: async (token) => {
      if (token === 'tdan') return { github_id: 1, login: 'dan', scopes: ['github.com/b'] }
      if (token === 'tpat') throw new GithubError('unauthorized')
      throw new GithubError('unreachable')
    },
  }
  const lines = []
  const r = await runGithubRefresh(db, github, { now: 500, log: (l) => lines.push(l) })
  assert.deepEqual(r, { refreshed: 1, stale: 1, unchanged: 1 })
  assert.deepEqual(githubAccountView(db, dan.id).orgs, ['github.com/b'])
  assert.equal(githubAccountView(db, pat.id).state, 'stale')
  assert.equal(githubAccountView(db, sam.id).state, 'ok'); assert.equal(githubAccountView(db, sam.id).checked_at, 1)
  assert.ok(lines.some((l) => /stale/.test(l)))
  assert.ok(!lines.some((l) => /tdan|tpat|tsam/.test(l)), 'tokens never logged')
  db.close()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/github-refresh.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/github-refresh.js`**

```js
// Daily re-read of every linked user's GitHub org memberships (spec
// 2026-09-23 tracker web/teams, "Refresh"). Same shape as scheduleRetention:
// run once at start, then on an unref'd interval; every failure is logged
// and never throws out of the tick.
import { listGithubAccounts } from './github-accounts.js'
import { refreshGithubAccount } from './github-http.js'

export const GITHUB_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

export async function runGithubRefresh(db, github, { now = Date.now(), log = console.log } = {}) {
  const out = { refreshed: 0, stale: 0, unchanged: 0 }
  for (const acct of listGithubAccounts(db)) {
    let r
    try {
      r = await refreshGithubAccount(db, github, acct.user_id, now)
    } catch (err) {
      log(`github-refresh: user=${acct.user_id} failed: ${err.message}`)
      out.unchanged++
      continue
    }
    if (!r) continue
    if (r.outcome === 'ok') out.refreshed++
    else if (r.outcome === 'stale') { out.stale++; log(`github-refresh: user=${acct.user_id} token refused, link marked stale`) }
    else { out.unchanged++; log(`github-refresh: user=${acct.user_id} unreachable (${r.error && r.error.code}), memberships kept`) }
  }
  return out
}

export function scheduleGithubRefresh(db, github, { intervalMs = GITHUB_REFRESH_INTERVAL_MS, log = console.log } = {}) {
  if (!github || !github.enabled) return null
  const run = () => { runGithubRefresh(db, github, { log }).catch((err) => console.error('github-refresh: run failed', err)) }
  run()
  const interval = setInterval(run, intervalMs)
  interval.unref()
  return interval
}
```

- [ ] **Step 4: Schedule it in `src/server.js`**

Import `scheduleGithubRefresh` from `./github-refresh.js`. Add `githubRefreshIntervalMs` to `startServer`'s options. Where `retentionInterval` is assigned inside `startServer` (search for `retentionInterval = scheduleRetention(`), add below it:
```js
      githubRefreshInterval = scheduleGithubRefresh(db, resolvedGithub, { intervalMs: githubRefreshIntervalMs })
```
Declare `let githubRefreshInterval = null` next to `let retentionInterval`, and in `close()` add `if (githubRefreshInterval) clearInterval(githubRefreshInterval)` beside the retention line.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/github-refresh.test.js test/server.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/github-refresh.js src/server.js test/github-refresh.test.js
git commit -m "journal: daily GitHub membership refresh"
```

---

### Task 7: The visibility predicate

**Files:**
- Create: `src/visibility.js`
- Test: `test/visibility.test.js`

**Interfaces:**
- Produces: `sharedConvoSql(alias) -> string` — a SQL fragment, true when the conversation aliased `alias` is readable by the viewer bound as the **named parameter `@viewer`** on the org rule only (the owner case is excluded: callers add `alias.owner_user_id = @viewer OR (...)` themselves when they want both).
- Produces: `canReadConvo(db, viewerUserId, convoId) -> boolean` — owner, or org-shared and not private-owned.
- Produces: `sharedOrgScopes(db, viewerUserId) -> string[]` (scopes of an `ok` link; `[]` otherwise).

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, pinDevicePrivate } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { saveGithubIdentity, markGithubStale } from '../src/github-accounts.js'
import { canReadConvo, sharedConvoSql, sharedOrgScopes } from '../src/visibility.js'

async function world() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const pat = await createUser(db, 'pat', 'pw')
  const sam = await createUser(db, 'sam', 'pw') // no link
  const danBox = createAgent(db, dan.id, 'dan-box')
  const danPrivate = createAgent(db, dan.id, 'dan-private')
  pinDevicePrivate(db, danPrivate.deviceId, true)
  const link = (u, gid, scopes) => saveGithubIdentity(db, { userId: u.id, host: 'github.com', identity: { github_id: gid, login: u.name, scopes }, token: `t${gid}`, now: 1 })
  link(dan, 1, ['github.com/matronhq', 'github.com/yearbooks'])
  link(pat, 2, ['github.com/matronhq'])
  upsertConversation(db, { id: 'org', ownerUserId: dan.id, title: 'org', agentDeviceId: danBox.deviceId, repo: 'github.com/matronhq/journal' })
  upsertConversation(db, { id: 'other-org', ownerUserId: dan.id, title: 'yb', agentDeviceId: danBox.deviceId, repo: 'github.com/yearbooks/app' })
  upsertConversation(db, { id: 'personal', ownerUserId: dan.id, title: 'p', agentDeviceId: danBox.deviceId, repo: 'github.com/danbarker/dotfiles' })
  upsertConversation(db, { id: 'norepo', ownerUserId: dan.id, title: 'n', agentDeviceId: danBox.deviceId })
  upsertConversation(db, { id: 'private', ownerUserId: dan.id, title: 'pr', agentDeviceId: danPrivate.deviceId, repo: 'github.com/matronhq/secret' })
  return { db, dan, pat, sam }
}

test('canReadConvo: table of viewer × conversation', async () => {
  const { db, dan, pat, sam } = await world()
  const rows = [
    // viewer, convo, expected, why
    [dan.id, 'org', true, 'owner'],
    [dan.id, 'private', true, 'owner sees own private'],
    [pat.id, 'org', true, 'both verified members of matronhq'],
    [pat.id, 'other-org', false, 'pat is not in yearbooks'],
    [pat.id, 'personal', false, 'personal login is nobody\'s org'],
    [pat.id, 'norepo', false, 'no repo, no audience'],
    [pat.id, 'private', false, 'private device sieve beats the org match (review focus 5)'],
    [pat.id, 'nope', false, 'unknown conversation'],
    [sam.id, 'org', false, 'viewer has no link'],
  ]
  for (const [viewer, convo, expected, why] of rows) assert.equal(canReadConvo(db, viewer, convo), expected, why)
  db.close()
})

test('canReadConvo: a stale link on either side ends sharing (review focus 1)', async () => {
  const { db, dan, pat } = await world()
  markGithubStale(db, pat.id, 2)
  assert.equal(canReadConvo(db, pat.id, 'org'), false, 'viewer stale')
  assert.equal(canReadConvo(db, dan.id, 'org'), true, 'owner unaffected')
  const { db: db2, dan: dan2, pat: pat2 } = await world()
  markGithubStale(db2, dan2.id, 2)
  assert.equal(canReadConvo(db2, pat2.id, 'org'), false, 'owner stale')
  db.close(); db2.close()
})

test('sharedConvoSql: usable inside a query with @viewer', async () => {
  const { db, pat } = await world()
  const ids = db.prepare(`SELECT c.id FROM conversations c WHERE ${sharedConvoSql('c')} ORDER BY c.id`).all({ viewer: pat.id }).map((r) => r.id)
  assert.deepEqual(ids, ['org'])
  assert.deepEqual(sharedOrgScopes(db, pat.id), ['github.com/matronhq'])
  db.close()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/visibility.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/visibility.js`**

```js
// The one cross-user read rule (spec 2026-09-23 tracker web/teams,
// "Visibility rule"): a viewer may read another user's conversation — and
// so the items, missions, milestones and prose excerpts hanging off it —
// when the conversation has a repo whose `host/org` scope both the viewer
// and the owner are verified members of (an `ok` GitHub link each), and
// the conversation is not owned by a private device. One SQL fragment, one
// function; every widened route uses these and nothing else, the way
// privacy.js is the only copy of the private-device sieve.
//
// The fragment binds the viewer as the NAMED parameter @viewer, so a caller
// can splice it into a larger statement without counting positional
// placeholders. It expresses the ORG rule only: callers that also want the
// owner to pass add `<alias>.owner_user_id = @viewer OR (...)`.
export const sharedConvoSql = (c) => `(
  ${c}.repo_scope IS NOT NULL
  AND ${c}.owner_user_id <> @viewer
  AND EXISTS (SELECT 1 FROM github_orgs gv
              JOIN github_accounts av ON av.user_id = gv.user_id AND av.state = 'ok'
              WHERE gv.user_id = @viewer AND gv.scope = ${c}.repo_scope)
  AND EXISTS (SELECT 1 FROM github_orgs go
              JOIN github_accounts ao ON ao.user_id = go.user_id AND ao.state = 'ok'
              WHERE go.user_id = ${c}.owner_user_id AND go.scope = ${c}.repo_scope)
  AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.id = ${c}.agent_device_id AND d.private = 1)
)`

export function canReadConvo(db, viewerUserId, convoId) {
  const row = db.prepare(`SELECT c.owner_user_id = @viewer AS own, ${sharedConvoSql('c')} AS shared
    FROM conversations c WHERE c.id = @id`).get({ viewer: viewerUserId, id: convoId })
  return !!row && (!!row.own || !!row.shared)
}

export function sharedOrgScopes(db, viewerUserId) {
  return db.prepare(`SELECT g.scope FROM github_orgs g JOIN github_accounts a ON a.user_id = g.user_id AND a.state='ok'
    WHERE g.user_id = ? ORDER BY g.scope`).all(viewerUserId).map((r) => r.scope)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/visibility.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/visibility.js test/visibility.test.js
git commit -m "journal: shared-visibility predicate"
```

---

### Task 8: Items — `scope=shared`, foreign reads, owner-only writes

**Files:**
- Modify: `src/items.js` (add `listSharedItems`, `getSharedItem`), `src/items-http.js` (`handleList`, `handleItemsRoute`)
- Test: `test/items-http.test.js` (append)

**Interfaces:**
- Consumes: `sharedConvoSql` (Task 7), `DECORATE`/`rowToItem`/`parseJson`/`encCursor`/`decCursor` (existing in items.js).
- Produces: `listSharedItems(db, viewerUserId, { kind, state, awaiting, limit, cursor }) -> { items, next_cursor } | { badCursor: true }`; items carry `owner: {user_id, name, github_login}` and `repo`.
- Produces: `getSharedItem(db, viewerUserId, itemId) -> item | null` (by `it_…` id only; same decoration).
- Produces: `GET /items?scope=shared`; `GET /items/:id` on a shared item; `403 forbidden` on every other method or sub-route for a shared item.

- [ ] **Step 1: Write the failing tests**

Append to `test/items-http.test.js`. It has `fleet(t)` giving dan (agent `dev-2`, convos `c1`, `c2`) and pat (agent `pat-box`, convo `p1`) and imports `pinDevicePrivate` and `upsertConversation`. Add an import of `saveGithubIdentity` from `../src/github-accounts.js`.
```js
async function sharedFleet(t) {
  const f = await fleet(t)
  const { s, dan, pat, agent, patAgent } = f
  const link = (u, gid, scopes) => saveGithubIdentity(s.db, { userId: u.id, host: 'github.com', identity: { github_id: gid, login: `${u.name}-gh`, scopes }, token: `t${gid}`, now: 1 })
  link(dan, 1, ['github.com/matronhq']); link(pat, 2, ['github.com/matronhq'])
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, agentDeviceId: agent.deviceId, repo: 'github.com/matronhq/journal' })
  upsertConversation(s.db, { id: 'p1', ownerUserId: pat.id, agentDeviceId: patAgent.deviceId, repo: 'github.com/matronhq/bridge' })
  const patLogin = await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'pw', device_name: 'mac' } })
  return { ...f, patClient: patLogin.json.token }
}

test('GET /items?scope=shared: a colleague in the same org sees my items, with owner and repo; not from repo-less or private conversations', async (t) => {
  const { s, dan, agent, client, patClient, patAgent } = await sharedFleet(t)
  const mine = await mkItem(s, agent.token, { title: 'Shared with pat' })
  await mkItem(s, agent.token, { title: 'Not shared', convo_id: 'c2' }) // c2 has no repo
  const r = await s.http('/items?scope=shared', { token: patClient })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.items.map((i) => i.title), ['Shared with pat'])
  assert.deepEqual(r.json.items[0].owner, { user_id: mine.json.item.user_id, name: 'dan', github_login: 'dan-gh' })
  assert.equal(r.json.items[0].repo, 'github.com/matronhq/journal')
  assert.equal((await s.http('/items', { token: client })).json.items.length, 2, 'scope=mine is unchanged')
  assert.equal((await s.http('/items?scope=shared', { token: client })).json.items.length, 0, 'never my own rows; pat has filed nothing')
  assert.equal((await s.http('/items?scope=shared', { token: patAgent.token })).json.items.length, 1, 'pat\'s agent reads with pat\'s visibility')
  // A private box of dan's inside the org stays invisible.
  const priv = createAgent(s.db, dan.id, 'dan-private'); pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'c3', ownerUserId: dan.id, title: 'C3', agentDeviceId: priv.deviceId, repo: 'github.com/matronhq/journal' })
  await mkItem(s, priv.token, { title: 'Private', convo_id: 'c3' })
  assert.equal((await s.http('/items?scope=shared', { token: patClient })).json.items.length, 1)
  assert.equal((await s.http('/items?scope=nope', { token: patClient })).status, 400)
  assert.equal((await s.http('/items?scope=shared&convo=c1', { token: patClient })).status, 400, 'own-list filters are rejected on shared')
})

test('GET /items/:id on a shared item reads it; every write is 403; an unshared one is 404', async (t) => {
  const { s, agent, patClient } = await sharedFleet(t)
  const mine = await mkItem(s, agent.token, { title: 'Shared' })
  const hidden = await mkItem(s, agent.token, { title: 'Hidden', convo_id: 'c2' })
  const id = mine.json.item.id
  const get = await s.http(`/items/${id}`, { token: patClient })
  assert.equal(get.status, 200); assert.equal(get.json.item.title, 'Shared'); assert.equal(get.json.item.owner.name, 'dan')
  assert.ok(Array.isArray(get.json.comments))
  for (const [method, path, body] of [
    ['PATCH', `/items/${id}`, { title: 'x' }],
    ['POST', `/items/${id}/comments`, { body: 'hi' }],
    ['POST', `/items/${id}/close`, { resolution: 'done' }],
    ['POST', `/items/${id}/reopen`, {}],
    ['POST', `/items/${id}/rank`, { position: 'top' }],
  ]) {
    const r = await s.http(path, { method, token: patClient, body })
    assert.equal(r.status, 403, `${method} ${path}`); assert.equal(r.json.error, 'forbidden')
  }
  assert.equal((await s.http(`/items/${hidden.json.item.id}`, { token: patClient })).status, 404)
  assert.equal((await s.http('/items/%231', { token: patClient })).status, 404, '#num stays owner-scoped: pat has no #1')
})

test('visibility follows the conversation\'s CURRENT repo (review focus 2)', async (t) => {
  const { s, agent, patClient, dan } = await sharedFleet(t)
  const it = await mkItem(s, agent.token, { title: 'Moves', convo_id: 'c2' })
  assert.equal((await s.http(`/items/${it.json.item.id}`, { token: patClient })).status, 404)
  upsertConversation(s.db, { id: 'c2', ownerUserId: dan.id, agentDeviceId: agent.deviceId, repo: 'github.com/matronhq/other' })
  assert.equal((await s.http(`/items/${it.json.item.id}`, { token: patClient })).status, 200)
  upsertConversation(s.db, { id: 'c2', ownerUserId: dan.id, agentDeviceId: agent.deviceId, repo: 'github.com/danbarker/personal' })
  assert.equal((await s.http(`/items/${it.json.item.id}`, { token: patClient })).status, 404)
})
```
`createAgent` is already imported in this test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/items-http.test.js`
Expected: FAIL — `scope=shared` answers 400 or the own list; foreign GET is 404.

- [ ] **Step 3: Add the queries to `src/items.js`**

Add the import at the top:
```js
import { sharedConvoSql } from './visibility.js'
```
Append after `listItems` (below the `DECORATE` constant, which the new code uses):
```js
// Cross-user read (spec 2026-09-23 tracker web/teams, "Reads that widen").
// Rows whose origin conversation passes the shared rule for @viewer, never
// the viewer's own. Ordered newest-updated first; the cursor is
// [updated_at, id] — item ids are random, so unlike `num` they are unique
// across users.
const OWNER_DECORATE = `
  cv.repo AS repo,
  json_object('user_id', u.id, 'name', u.name, 'github_login', ga.login) AS owner_json`
const SHARED_FROM = `FROM items i
  JOIN conversations cv ON cv.id = i.origin_convo_id
  JOIN users u ON u.id = i.user_id
  LEFT JOIN github_accounts ga ON ga.user_id = i.user_id`

function rowToSharedItem(row) {
  if (!row) return null
  const { owner_json: ownerJson, ...rest } = row
  const item = rowToItem(rest)
  item.owner = parseJson(ownerJson, null)
  return item
}

export function listSharedItems(db, viewerUserId, { kind = null, state = null, awaiting = null, limit = 100, cursor = null } = {}) {
  limit = Math.min(Math.max(Number(limit) || 100, 1), 500)
  const where = [sharedConvoSql('cv'), 'i.consent IS NULL']
  const args = { viewer: viewerUserId }
  if (kind != null) { where.push('i.kind = @kind'); args.kind = kind }
  if (state != null) { where.push('i.state = @state'); args.state = state }
  if (awaiting != null) { where.push('i.awaiting = @awaiting'); args.awaiting = awaiting }
  const cur = cursor ? decCursor(cursor) : null
  if (cursor && !cur) return { badCursor: true }
  if (cur) { where.push('(i.updated_at < @cu OR (i.updated_at = @cu AND i.id < @cid))'); args.cu = cur[0]; args.cid = cur[1] }
  const rows = db.prepare(`SELECT i.*, ${DECORATE}, ${OWNER_DECORATE} ${SHARED_FROM}
    WHERE ${where.join(' AND ')} ORDER BY i.updated_at DESC, i.id DESC LIMIT @lim`).all({ ...args, lim: limit + 1 })
  const page = rows.slice(0, limit).map(rowToSharedItem)
  const last = page[page.length - 1]
  const next_cursor = rows.length > limit && last ? encCursor([last.updated_at, last.id]) : null
  return { items: page, next_cursor }
}

export function getSharedItem(db, viewerUserId, itemId) {
  if (typeof itemId !== 'string' || !itemId.startsWith('it_')) return null
  const row = db.prepare(`SELECT i.*, ${DECORATE}, ${OWNER_DECORATE} ${SHARED_FROM}
    WHERE i.id = @id AND i.consent IS NULL AND ${sharedConvoSql('cv')}`).get({ viewer: viewerUserId, id: itemId })
  return rowToSharedItem(row)
}
```

- [ ] **Step 4: Route it in `src/items-http.js`**

Import `listSharedItems, getSharedItem` from `./items.js`. Add `const SCOPES = ['mine', 'shared']` next to `SORTS`. In `handleList`, right after the existing `if (kind === undefined || state === undefined || awaiting === undefined || sort === undefined) return badRequest(res)` line:
```js
  const scope = q.has('scope') ? oneOf(q.get('scope'), SCOPES) : 'mine'
  if (scope === undefined) return badRequest(res)
  if (scope === 'shared') {
    // Own-list-only filters (convo, label, sort, since) are meaningless
    // across users and are rejected rather than ignored.
    for (const k of ['convo', 'label', 'sort', 'since']) if (q.has(k)) return badRequest(res)
    const sharedLimit = q.has('limit') ? Number(q.get('limit')) : 100
    if (!Number.isInteger(sharedLimit) || sharedLimit < 1) return badRequest(res)
    const r = listSharedItems(db, who.userId, { kind, state, awaiting, limit: sharedLimit, cursor: q.get('cursor') })
    if (r.badCursor) return badRequest(res)
    json(res, 200, { items: r.items, next_cursor: r.next_cursor })
    return true
  }
```

In `handleItemsRoute`, replace the two lines `const item = visibleItem(db, who, idOrNum)` / `if (!item) return notFound(res)` with:
```js
  const item = visibleItem(db, who, idOrNum)
  if (!item) {
    // Not mine: maybe a colleague's, readable under the shared rule. Read
    // only — every other method on a shared row is 403 (visible, not
    // yours), which is safe to distinguish from 404 because the caller can
    // already read it.
    const shared = getSharedItem(db, who.userId, idOrNum)
    if (!shared) return notFound(res)
    if (!sub && req.method === 'GET') { json(res, 200, { item: shared, comments: listComments(db, shared.id) }); return true }
    json(res, 403, { error: 'forbidden' })
    return true
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/items-http.test.js test/items.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/items.js src/items-http.js test/items-http.test.js
git commit -m "journal: items scope=shared, foreign item reads, owner-only writes"
```

---

### Task 9: Missions and milestones — `scope=shared`, foreign detail

**Files:**
- Modify: `src/missions.js` (add `listSharedMissions`, `getSharedMission`, `sharedMissionDetail`, `listSharedMilestones`), `src/missions-http.js`
- Test: `test/missions-http.test.js` (append)

**Interfaces:**
- Consumes: `sharedConvoSql`, `canReadConvo` (Task 7), `missionRow`, `milestoneRow`, `countsSql` (existing).
- Produces: `listSharedMissions(db, viewerUserId) -> mission[]` with `owner`; `getSharedMission(db, viewerUserId, missionId) -> mission | null` (a mission is shared when its origin conversation or any conversation carrying its `mission_id` passes the rule); `sharedMissionDetail(db, viewerUserId, mission) -> { mission, milestones, items, conversations }` restricted to shared conversations; `listSharedMilestones(db, viewerUserId, convoId) -> milestone[]`.
- Produces: `GET /missions?scope=shared`; `GET /missions/:id` (`ms_…` only) on a shared mission; `403` for `PATCH`/`join`/`close`; `GET /milestones?convo=<id>` on a shared conversation.

- [ ] **Step 1: Write the failing tests**

Append to `test/missions-http.test.js`. Read its `fleet` helper first and adapt the destructuring below to what it returns (it must provide dan's agent on `c1`, a client token for dan, and pat with `p1`); add imports of `saveGithubIdentity` (`../src/github-accounts.js`) and `upsertConversation` (`../src/journal.js`) if missing.
```js
test('missions scope=shared and foreign detail follow the conversation rule; writes are 403', async (t) => {
  const { s, dan, pat, agent, client } = await fleet(t)
  const link = (u, gid) => saveGithubIdentity(s.db, { userId: u.id, host: 'github.com', identity: { github_id: gid, login: u.name, scopes: ['github.com/matronhq'] }, token: `t${gid}`, now: 1 })
  link(dan, 1); link(pat, 2)
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, agentDeviceId: agent.deviceId, repo: 'github.com/matronhq/journal' })
  const patClient = (await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'pw', device_name: 'mac' } })).json.token
  const m = await s.http('/missions', { method: 'POST', token: agent.token, body: { convo_id: 'c1', title: 'Shared mission', body: 'goal' } })
  assert.equal(m.status, 201)
  const ms = await s.http('/milestones', { method: 'POST', token: agent.token, body: { convo_id: 'c1', kind: 'progress', title: 'Step 1' } })
  assert.equal(ms.status, 201)
  const list = await s.http('/missions?scope=shared', { token: patClient })
  assert.equal(list.status, 200)
  assert.deepEqual(list.json.missions.map((x) => x.title), ['Shared mission'])
  assert.equal(list.json.missions[0].owner.name, 'dan')
  assert.equal((await s.http('/missions?scope=shared', { token: client })).json.missions.length, 0)
  assert.equal((await s.http('/missions?scope=shared&state=open', { token: patClient })).status, 400)
  const detail = await s.http(`/missions/${m.json.mission.id}`, { token: patClient })
  assert.equal(detail.status, 200); assert.equal(detail.json.mission.owner.name, 'dan')
  assert.deepEqual(detail.json.milestones.map((x) => x.title), ['Step 1'])
  assert.deepEqual(detail.json.conversations.map((x) => x.id), ['c1'])
  assert.equal((await s.http(`/missions/${m.json.mission.id}`, { method: 'PATCH', token: patClient, body: { title: 'x' } })).status, 403)
  assert.equal((await s.http(`/missions/${m.json.mission.id}/close`, { method: 'POST', token: patClient, body: { summary: 'x' } })).status, 403)
  assert.equal((await s.http(`/missions/${m.json.mission.id}/join`, { method: 'POST', token: patClient, body: { convo_id: 'p1' } })).status, 403)
  const mil = await s.http('/milestones?convo=c1', { token: patClient })
  assert.equal(mil.status, 200); assert.equal(mil.json.milestones.length, 1)
  assert.equal((await s.http('/milestones?convo=c2', { token: patClient })).status, 404, 'c2 has no repo')
  // Drop the repo: the mission disappears for pat.
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, agentDeviceId: agent.deviceId, repo: null })
  assert.equal((await s.http(`/missions/${m.json.mission.id}`, { token: patClient })).status, 404)
  assert.equal((await s.http('/milestones?convo=c1', { token: patClient })).status, 404)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/missions-http.test.js`
Expected: FAIL.

- [ ] **Step 3: Add the queries to `src/missions.js`**

Import `sharedConvoSql` from `./visibility.js`. Append at the end of the file:
```js
// Cross-user reads (spec 2026-09-23 tracker web/teams). A mission is shared
// with @viewer when its origin conversation, or any conversation carrying
// its mission_id, passes the shared rule; its detail lists only those
// conversations' milestones and items. countsSql(true) applies the private
// sieve to the counts, which is the honest count for a foreign viewer.
const MISSION_SHARED = `(
  EXISTS (SELECT 1 FROM conversations cv WHERE cv.id = m.origin_convo_id AND ${sharedConvoSql('cv')})
  OR EXISTS (SELECT 1 FROM conversations cv WHERE cv.mission_id = m.id AND ${sharedConvoSql('cv')})
)`
const OWNER_JSON = `json_object('user_id', u.id, 'name', u.name, 'github_login', ga.login) AS owner_json`
const OWNER_FROM = `JOIN users u ON u.id = m.user_id LEFT JOIN github_accounts ga ON ga.user_id = m.user_id`

function sharedMissionRow(row) {
  if (!row) return null
  const { owner_json: ownerJson, ...rest } = row
  const mission = missionRow(rest)
  mission.owner = JSON.parse(ownerJson)
  return mission
}

export function listSharedMissions(db, viewerUserId) {
  return db.prepare(`SELECT m.*, ${countsSql(true)}, ${OWNER_JSON} FROM missions m ${OWNER_FROM}
    WHERE ${MISSION_SHARED} ORDER BY (m.last_milestone_at IS NULL), m.last_milestone_at DESC, m.created_at DESC`)
    .all({ viewer: viewerUserId }).map(sharedMissionRow)
}

export function getSharedMission(db, viewerUserId, missionId) {
  if (typeof missionId !== 'string' || !missionId.startsWith('ms_')) return null
  return sharedMissionRow(db.prepare(`SELECT m.*, ${countsSql(true)}, ${OWNER_JSON} FROM missions m ${OWNER_FROM}
    WHERE m.id = @id AND ${MISSION_SHARED}`).get({ viewer: viewerUserId, id: missionId }))
}

export function sharedMissionDetail(db, viewerUserId, mission) {
  const args = { viewer: viewerUserId, mid: mission.id }
  const milestones = db.prepare(`SELECT l.* FROM milestones l JOIN conversations cv ON cv.id = l.convo_id
    WHERE l.mission_id = @mid AND ${sharedConvoSql('cv')} ORDER BY l.created_at DESC, l.seq DESC`).all(args).map(milestoneRow)
  const items = db.prepare(`SELECT i.id, i.num, i.kind, i.state, i.awaiting, i.title, i.origin_convo_id, i.updated_at
    FROM items i JOIN conversations cv ON cv.id = i.origin_convo_id
    WHERE i.mission_id = @mid AND i.state='open' AND i.consent IS NULL AND ${sharedConvoSql('cv')}
    ORDER BY (i.awaiting = 'user') DESC, i.updated_at DESC`).all(args)
  const conversations = db.prepare(`SELECT cv.id, cv.title, cv.session_state AS state, cv.repo, d.name AS box
    FROM conversations cv LEFT JOIN devices d ON d.id = cv.agent_device_id
    WHERE cv.mission_id = @mid AND ${sharedConvoSql('cv')} ORDER BY cv.created_at`).all(args)
  return { mission, milestones, items, conversations }
}

export function listSharedMilestones(db, viewerUserId, convoId) {
  return db.prepare(`SELECT l.* FROM milestones l JOIN conversations cv ON cv.id = l.convo_id
    WHERE l.convo_id = @cid AND ${sharedConvoSql('cv')} ORDER BY l.created_at DESC, l.seq DESC`)
    .all({ viewer: viewerUserId, cid: convoId }).map(milestoneRow)
}
```
`countsSql` is declared above `getMission` in the same file; if it is not exported, no export is needed since the new code lives in the same module.

- [ ] **Step 4: Route it in `src/missions-http.js`**

Import `listSharedMissions, getSharedMission, sharedMissionDetail, listSharedMilestones` from `./missions.js` and `canReadConvo` from `./visibility.js`. In `handleList`, before the final `json(...)`:
```js
  const scope = url.searchParams.get('scope') ?? 'mine'
  if (scope !== 'mine' && scope !== 'shared') return badRequest(res)
  if (scope === 'shared') {
    if (state != null || since != null) return badRequest(res)
    json(res, 200, { missions: listSharedMissions(db, who.userId) })
    return true
  }
```
In `handleMilestoneList`, replace the line `if (!convo || convo.owner_user_id !== who.userId) return notFound(res)` with:
```js
  if (!convo) return notFound(res)
  if (convo.owner_user_id !== who.userId) {
    // A colleague's conversation: readable under the shared rule, else the
    // same 404 as an unknown id. The rule already excludes private-owned.
    if (!canReadConvo(db, who.userId, convoId)) return notFound(res)
    json(res, 200, { milestones: listSharedMilestones(db, who.userId, convoId) })
    return true
  }
```
In `handleMissionsRoute`, replace `const mission = visibleMission(db, who, idOrNum)` / `if (!mission) return notFound(res)` with:
```js
  const mission = visibleMission(db, who, idOrNum)
  if (!mission) {
    const shared = getSharedMission(db, who.userId, idOrNum)
    if (!shared) return notFound(res)
    if (!sub && req.method === 'GET') { json(res, 200, sharedMissionDetail(db, who.userId, shared)); return true }
    json(res, 403, { error: 'forbidden' })
    return true
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/missions-http.test.js test/missions.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/missions.js src/missions-http.js test/missions-http.test.js
git commit -m "journal: missions and milestones scope=shared, foreign detail"
```

---

### Task 10: `/lookup` and `/u/:user/:num` (JSON)

**Files:**
- Create: `src/lookup-http.js`
- Modify: `src/http.js` (mount)
- Test: `test/lookup-http.test.js`

**Interfaces:**
- Consumes: `getItem`, `getSharedItem` (items.js), `getMission`, `getSharedMission` (missions.js), `canReadConvo` (visibility.js).
- Produces: `handleLookupRoute(ctx, req, res, url, who) -> boolean` for `GET /lookup?user=<name>&num=<n>` and `GET /u/<name>/<n>` when the request's `Accept` header contains `application/json`. Response `{ kind: 'item'|'mission'|'milestone', id, owner: {user_id, name} }`; 404 otherwise. The HTML fallback for `/u/*` is Plan B; until then a non-JSON `GET /u/...` falls through to the existing 404.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { saveGithubIdentity } from '../src/github-accounts.js'

test('/lookup resolves a per-user number to item, mission or milestone under the same visibility as the reads', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw'); const pat = await createUser(s.db, 'pat', 'pw'); const sam = await createUser(s.db, 'sam', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  for (const [u, gid] of [[dan, 1], [pat, 2]]) saveGithubIdentity(s.db, { userId: u.id, host: 'github.com', identity: { github_id: gid, login: u.name, scopes: ['github.com/matronhq'] }, token: `t${gid}`, now: 1 })
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: ag.deviceId, repo: 'github.com/matronhq/x' })
  const tok = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw', device_name: 'mac' } })).json.token
  const danTok = await tok('dan'); const patTok = await tok('pat'); const samTok = await tok('sam')
  // One per-user counter numbers all three kinds, so these are #1, #2, #3.
  const item = (await s.http('/items', { method: 'POST', token: ag.token, body: { kind: 'task', title: 'T', convo_id: 'c1' } })).json.item
  const mission = (await s.http('/missions', { method: 'POST', token: ag.token, body: { convo_id: 'c1', title: 'M' } })).json.mission
  const ms = (await s.http('/milestones', { method: 'POST', token: ag.token, body: { convo_id: 'c1', kind: 'progress', title: 'S' } })).json.milestone
  const look = (token, user, num) => s.http(`/lookup?user=${user}&num=${num}`, { token })
  assert.deepEqual((await look(danTok, 'dan', 1)).json, { kind: 'item', id: item.id, owner: { user_id: dan.id, name: 'dan' } })
  assert.deepEqual((await look(danTok, 'dan', 2)).json, { kind: 'mission', id: mission.id, owner: { user_id: dan.id, name: 'dan' } })
  assert.deepEqual((await look(danTok, 'dan', 3)).json, { kind: 'milestone', id: ms.id, owner: { user_id: dan.id, name: 'dan' } })
  assert.equal((await look(patTok, 'dan', 1)).json.kind, 'item', 'colleague in the org')
  assert.equal((await look(patTok, 'dan', 3)).json.kind, 'milestone')
  assert.equal((await look(samTok, 'dan', 1)).status, 404, 'no link')
  assert.equal((await look(danTok, 'dan', 99)).status, 404)
  assert.equal((await look(danTok, 'nobody', 1)).status, 404, 'unknown user is the same 404')
  assert.equal((await look(danTok, 'dan', 'x')).status, 400)
  assert.equal((await s.http('/lookup?user=dan', { token: danTok })).status, 400)
  // Link-shaped path with a JSON Accept header resolves the same way.
  const r = await fetch(`${s.base}/u/dan/1`, { headers: { authorization: `Bearer ${patTok}`, accept: 'application/json' } })
  assert.equal(r.status, 200); assert.equal((await r.json()).kind, 'item')
})
```
Check the response key for `POST /milestones` in `src/missions-http.js` (`milestone`) and adjust `.json.milestone` if it differs.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/lookup-http.test.js`
Expected: FAIL — 404 on `/lookup`.

- [ ] **Step 3: Write `src/lookup-http.js`**

```js
// Resolves a shareable link's (user, num) to a row (spec 2026-09-23 tracker
// web/teams, "Item links and the lookup URL"). One per-user counter numbers
// items, missions and milestones alike, so a single lookup covers all three.
// Visibility is exactly the read rule: the caller's own rows, or a
// colleague's under the shared predicate. Unknown user, unknown number and
// invisible row are one 404. Own-row checks reuse the same helpers the
// GET routes gate with, so a lookup can never name a row its GET would
// then refuse.
import { json } from './http-body.js'
import { badRequest, notFound } from './http-who.js'
import { getItem, getSharedItem, isConsentMirror } from './items.js'
import { getMission, getSharedMission } from './missions.js'
import { canReadConvo } from './visibility.js'
import { filteredAgent, privateOwnedConvo } from './privacy.js'

const NAME_MAX = 64

function resolve(db, who, ownerName, num) {
  const owner = db.prepare('SELECT id, name FROM users WHERE name=?').get(ownerName)
  if (!owner) return null
  const own = owner.id === who.userId
  const item = db.prepare('SELECT id, origin_convo_id FROM items WHERE user_id=? AND num=?').get(owner.id, num)
  if (item) {
    let ok
    if (own) {
      ok = !!getItem(db, who.userId, item.id)
        && !(filteredAgent(db, who) && privateOwnedConvo(db, item.origin_convo_id))
        && !(who.kind === 'agent' && isConsentMirror(db, item.id))
    } else ok = !!getSharedItem(db, who.userId, item.id)
    return ok ? { kind: 'item', id: item.id, owner } : null
  }
  const mission = db.prepare('SELECT id FROM missions WHERE user_id=? AND num=?').get(owner.id, num)
  if (mission) {
    const ok = own ? !!getMission(db, who.userId, mission.id, { excludePrivateOwned: filteredAgent(db, who) }) : !!getSharedMission(db, who.userId, mission.id)
    return ok ? { kind: 'mission', id: mission.id, owner } : null
  }
  const ms = db.prepare('SELECT id, convo_id FROM milestones WHERE user_id=? AND num=?').get(owner.id, num)
  if (ms) {
    const ok = own ? !(filteredAgent(db, who) && privateOwnedConvo(db, ms.convo_id)) : canReadConvo(db, who.userId, ms.convo_id)
    return ok ? { kind: 'milestone', id: ms.id, owner } : null
  }
  return null
}

export function handleLookupRoute(ctx, req, res, url, who) {
  if (req.method !== 'GET') return false
  const { db } = ctx
  let user, numRaw
  if (url.pathname === '/lookup') {
    user = url.searchParams.get('user'); numRaw = url.searchParams.get('num')
  } else {
    const m = url.pathname.match(/^\/u\/([^/]+)\/([^/]+)$/)
    if (!m || !/application\/json/.test(req.headers.accept || '')) return false
    try { user = decodeURIComponent(m[1]); numRaw = decodeURIComponent(m[2]) } catch { return badRequest(res) }
  }
  if (typeof user !== 'string' || !user || user.length > NAME_MAX || numRaw == null) return badRequest(res)
  const num = Number(numRaw)
  if (!Number.isInteger(num) || num < 1) return badRequest(res)
  const hit = resolve(db, who, user, num)
  if (!hit) return notFound(res)
  json(res, 200, { kind: hit.kind, id: hit.id, owner: { user_id: hit.owner.id, name: hit.owner.name } })
  return true
}
```

- [ ] **Step 4: Mount in `src/http.js`**

Import `handleLookupRoute` from `./lookup-http.js` and, after the `handleGithubRoute` mount:
```js
      if (handleLookupRoute({ db }, req, res, url, who)) return
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/lookup-http.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lookup-http.js src/http.js test/lookup-http.test.js
git commit -m "journal: /lookup and JSON /u/:user/:num resolve shareable links"
```

---

### Task 11: Foreign transcript excerpts for shared conversations

**Files:**
- Modify: `src/http.js` (the `GET /convo/:id/messages` branch)
- Test: `test/http.test.js` (append)

**Interfaces:**
- Consumes: `canReadConvo` (Task 7), `messagesAroundIndexed`, `indexableBody`, `toEventShape` (existing).
- Produces: `GET /convo/:id/messages?around_seq=&limit=` on another user's conversation, for any caller kind, returns the prose window (`text`, `diff`), `limit` clamped to 30, when `canReadConvo` passes; logs `journal: shared context read convo=<id> viewer=<userId> device=<deviceId> anchor=<seq>`; `before_seq` paging on a foreign conversation stays 404.

- [ ] **Step 1: Write the failing test**

Append to `test/http.test.js` (it has `startTestServer`, `createUser`, `createAgent`, `upsertConversation`, `append`; add `saveGithubIdentity` from `../src/github-accounts.js` and `pinDevicePrivate` from `../src/db.js`):
```js
test('GET /convo/:id/messages?around_seq on a colleague\'s shared conversation: prose only, clamped, logged; private-owned stays 404 unlogged (review focus 5)', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const logs = []
  const origLog = console.log
  console.log = (...a) => { logs.push(a.join(' ')); origLog(...a) }
  t.after(() => { console.log = origLog })
  const dan = await createUser(s.db, 'dan', 'pw'); const pat = await createUser(s.db, 'pat', 'pw')
  const box = createAgent(s.db, dan.id, 'dan-box'); const priv = createAgent(s.db, dan.id, 'dan-private')
  pinDevicePrivate(s.db, priv.deviceId, true)
  for (const [u, gid] of [[dan, 1], [pat, 2]]) saveGithubIdentity(s.db, { userId: u.id, host: 'github.com', identity: { github_id: gid, login: u.name, scopes: ['github.com/matronhq'] }, token: `t${gid}`, now: 1 })
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: box.deviceId, repo: 'github.com/matronhq/x' })
  upsertConversation(s.db, { id: 'pv', ownerUserId: dan.id, title: 'PV', agentDeviceId: priv.deviceId, repo: 'github.com/matronhq/x' })
  for (let i = 0; i < 40; i++) {
    append(s.db, { userId: dan.id, convoId: 'c1', sender: 'user:dan', type: 'text', payload: { body: `m${i}` } })
    append(s.db, { userId: dan.id, convoId: 'c1', sender: 'agent:dan-box', type: 'tool_output', payload: { text: 'SECRET' } })
  }
  append(s.db, { userId: dan.id, convoId: 'pv', sender: 'user:dan', type: 'text', payload: { body: 'private words' } })
  const patTok = (await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'pw', device_name: 'mac' } })).json.token
  const r = await s.http('/convo/c1/messages?around_seq=40&limit=200', { token: patTok })
  assert.equal(r.status, 200)
  assert.ok(r.json.events.length <= 30 && r.json.events.length > 0)
  assert.ok(r.json.events.every((e) => e.type === 'text'))
  assert.ok(!JSON.stringify(r.json).includes('SECRET'))
  assert.ok(logs.some((l) => /shared context read convo=c1 viewer=/.test(l)))
  assert.equal((await s.http('/convo/c1/messages?before_seq=40', { token: patTok })).status, 404, 'paging stays owner-only')
  const before = logs.length
  const pv = await s.http('/convo/pv/messages?around_seq=1', { token: patTok })
  assert.equal(pv.status, 404)
  assert.equal(logs.filter((l) => /context read convo=pv/.test(l)).length, 0, 'a refused read is never logged as a read')
  assert.equal(logs.length, before)
  const patAgent = createAgent(s.db, pat.id, 'pat-box')
  assert.equal((await s.http('/convo/c1/messages?around_seq=40', { token: patAgent.token })).status, 200, 'an agent reads with its user\'s visibility')
})
```
If `append`'s `tool_output` payload shape in this file differs (search the file for `tool_output`), copy that shape; the assertion only needs the word `SECRET` to be absent from prose results.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/http.test.js`
Expected: FAIL — pat gets 404 on `c1`.

- [ ] **Step 3: Implement in `src/http.js`**

Import `canReadConvo` from `./visibility.js`. In the `GET /convo/:id/messages` branch, after `const limit = Math.min(rawLimit, 200)` and before `const agentForeign = ...`, add:
```js
        // Shared conversations (spec 2026-09-23 tracker web/teams): a
        // colleague's conversation under the org rule is readable as a
        // context window only — the same prose-only, clamped, logged
        // regime as a foreign agent's search-hit read below, with the
        // owner's user id driving the query. canReadConvo runs the private
        // sieve inside the rule, so a refused read never reaches the log.
        const ownerRow = db.prepare('SELECT owner_user_id FROM conversations WHERE id=?').get(convoId)
        if (ownerRow && ownerRow.owner_user_id !== who.userId) {
          if (aroundSeq == null || !canReadConvo(db, who.userId, convoId)) return json(res, 404, { error: 'not_found' })
          const events = messagesAroundIndexed(db, ownerRow.owner_user_id, convoId, { aroundSeq, limit: Math.min(limit, 30) })
            .filter((e) => indexableBody(e.type, e.payload) != null)
          console.log(`journal: shared context read convo=${convoId} viewer=${who.userId} device=${who.deviceId} anchor=${aroundSeq}`)
          return json(res, 200, { events: events.map(toEventShape) })
        }
```
The existing code below is unchanged: a conversation owned by the caller's user keeps every current path.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/http.test.js test/search.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http.js test/http.test.js
git commit -m "journal: shared conversations readable as prose excerpts"
```

---

### Task 12: Protocol docs, help digest, README

**Files:**
- Modify: `docs/protocol.md` (Items routes table, Missions routes table, new section before "## Device privacy", the `around_seq` paragraph), `src/help.js`, `README.md` (Configuration table)
- Test: `test/help.test.js` (append two assertions)

- [ ] **Step 1: Write the failing test**

Append inside the existing test in `test/help.test.js`, after the `/search` assertion:
```js
  assert.match(body, /GET \/items\?scope=shared/)
  assert.match(body, /GET \/lookup\?user=/)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/help.test.js`
Expected: FAIL.

- [ ] **Step 3: Update `src/help.js`**

Under `## Reading`, add:
```
- \`GET /items?scope=shared\` and \`GET /missions?scope=shared\` — a
  colleague's items and missions you may read: filed from a conversation
  whose repo belongs to a GitHub org both of you are verified members of
  (see "Shared visibility" in docs/protocol.md). Rows carry \`owner\` and
  \`repo\`. \`GET /items/:id\` / \`GET /missions/:id\` read one such row;
  every write to it is 403. \`GET /milestones?convo=<id>\` works on a
  shared conversation.
- \`GET /lookup?user=<name>&num=<n>\` — resolves a shareable link
  (\`https://<journal>/u/<name>/<n>\`) to \`{kind, id, owner}\`; 404 when
  unknown or not visible to you. \`GET /me\` — who you are and your
  GitHub link state.
- \`GET /convo/:id/messages?around_seq=<seq>&limit=<n>\` on a colleague's
  shared conversation returns the prose window around \`seq\` (\`text\`
  and \`diff\` only, \`limit\` clamped to 30, logged).
```

- [ ] **Step 4: Update `docs/protocol.md`**

In the Items routes table, extend the `GET /items` row's query column with `, scope=mine|shared (shared: kind/state/awaiting/limit/cursor only; rows carry owner{user_id,name,github_login} and repo)` and add a row:
```markdown
| `GET /items/:id` (shared) | `:id` = `it_…` of a colleague's item visible under *Shared visibility* | `{item, comments}` with `item.owner`; any other method or sub-route on it is **403 `forbidden`** |
```
In the Missions routes table, add `scope=mine|shared` to `GET /missions` and a row for the shared `GET /missions/:id` (`ms_…` only, 403 on `PATCH`/`join`/`close`), and note that `GET /milestones?convo=` accepts a shared conversation.

Insert before `## Device privacy`:
```markdown
## Shared visibility (GitHub-verified, per repo)

Spec: `docs/superpowers/specs/2026-09-23-tracker-web-teams-and-item-links-design.md`.

A user may read another user's conversation-scoped rows — items, missions,
milestones, and a prose excerpt of the conversation — when **all** hold:

1. the conversation has a `repo` (see `convo_upsert`) whose `repo_scope`
   (`host/org`) is one the viewer is a verified member of;
2. the conversation's owner is a verified member of the same scope;
3. the conversation is not owned by a private device (the device-privacy
   sieve is part of the rule and is never overridden by an org match).

"Verified member" = the user has linked a GitHub account (below) whose
link is in state `ok` and whose active org memberships include the scope.
A stale link (GitHub refused the token on the last refresh) confers
nothing until the user re-links. A repo under a personal login is in no
one's org list, so it is private to its owner. Agent devices read with
their owning user's visibility; writes stay owner-only.

Invisible rows answer `404 not_found`; a visible foreign row refused for
writing answers `403 forbidden`. The rule lives in `src/visibility.js`
and is the only copy.

### GitHub account linking

Client devices only (an agent never links). Configuration:
`MATRON_GITHUB_CLIENT_ID` (default: Matron's published OAuth App;
empty = linking disabled → every route below is `404 not_configured`),
`MATRON_GITHUB_CLIENT_SECRET` (optional; enables the web flow),
`MATRON_GITHUB_HOST` (default `github.com`). The token scope is `read:org`.

| Route | Body / query | Response |
|---|---|---|
| `POST /github/link` | `{flow:'device'}` | `{flow_id, user_code, verification_uri, interval, expires_in}` |
| `POST /github/link` | `{flow:'web'}` (400 without a client secret) | `{url}` — send the browser there |
| `POST /github/link/:flow_id/poll` | — | `{status:'pending', interval?}` \| `{status:'linked', github}` \| `{status:'denied'\|'expired'}`; 404 unknown/finished/another user's; 409 if the GitHub account is linked to another user; 502 `upstream` if GitHub is unreachable |
| `GET /github/callback?code&state` | no Bearer; `state` is the single-use flow credential | 302 to `/account?linked=1` or `/account?link_error=<expired\|bad_request\|conflict\|upstream\|not_configured>` |
| `POST /github/refresh` | — | `{github}`; marks the link `stale` on 401/403 from GitHub; 502 `upstream` if unreachable (nothing changes) |
| `DELETE /github/link` | — | `{ok:true}`; 404 if not linked |
| `GET /me` | — | `{user:{id,name}, github: {host, login, orgs, state, checked_at, linked_at} \| null, github_linking:{enabled, web_flow}}` |
| `GET /lookup?user=<name>&num=<n>` | also `GET /u/<name>/<n>` with `Accept: application/json` | `{kind:'item'\|'mission'\|'milestone', id, owner:{user_id,name}}`; 404 unknown or invisible |

The journal re-reads every linked user's memberships daily
(`src/github-refresh.js`) and on `POST /github/refresh`. Flows expire
after 10 minutes and are consumed by the poll or callback that finishes
them. The token is stored in the journal DB, never returned by any route
and never logged.
```
In the `GET /convo/:id/messages` documentation (search the file for `around_seq`), add: on another user's conversation that passes *Shared visibility*, `around_seq` reads return the prose window (`text`, `diff`), `limit` clamped to 30, logged as `journal: shared context read …`; `before_seq` paging on it stays 404.

- [ ] **Step 5: Update `README.md`**

In the Configuration table (near line 53), add rows:
```markdown
| `MATRON_GITHUB_CLIENT_ID` | Matron's published OAuth App | GitHub OAuth App client id for account linking (device flow). Empty disables linking |
| `MATRON_GITHUB_CLIENT_SECRET` | unset | Client secret of an OAuth App registered for this journal (callback `https://<journal>/github/callback`). Enables the one-click web flow |
| `MATRON_GITHUB_HOST` | `github.com` | GitHub Enterprise host, if any |
```

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS, every file.

- [ ] **Step 7: Commit**

```bash
git add docs/protocol.md src/help.js README.md test/help.test.js
git commit -m "docs: shared visibility, GitHub linking, lookup routes"
```

---

## Deferred to Plan B

- `users.is_admin`, `matron-admin user admin <name> on|off`, and the users admin routes (`GET/POST /users`, password reset, admin flag, clear a GitHub link, link-code).
- Static hosting (`MATRON_WEB_DIR`, history fallback for `/u/*` and `/app/*`, traversal guard).
- `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`.
- Encryption at rest for `github_accounts.token`.
