# Tracker web app, GitHub-verified visibility and shareable item links — design

Date: 2026-09-23. Status: draft for review (revision 2).
Decided with Dan in the Matron tracker (items #2769, #2771, #2772, #2773,
#2791; decisions #2784, #2788).

## Problem

Tracker items are the record of what an agent asked and what its user
decided, but they only exist inside Matron and only for one user.

- Agents write item numbers (`#12`) into GitHub issues, PR bodies and
  commit messages, where GitHub autolinks them to unrelated issues. The
  in-app link form `[#12](matron://item/12)` fares no better: GitHub strips
  every scheme except `http`, `https` and `mailto`.
- `matron://item/12` is a convention the apps' markdown renderers
  intercept. Neither the Apple nor the Android app registers `matron` as a
  system URL scheme, so the link opens nothing from outside the app.
- Item, mission and milestone numbers are a **per-user counter**
  (`item_counters`). Dan's #12 and a colleague's #12 are different rows, so
  no bare number can ever identify an item to someone else.
- Cross-user visibility was a v1 non-goal of the tracker. A journal has
  `users` and nothing that says who works with whom, so a colleague cannot
  see which decisions were made in a repo they share.

## Goals

1. Agents never leak tracker numbers onto GitHub. Shipped (matron-bridge
   branch `feat/no-tracker-numbers-on-github`).
2. Every item, mission and milestone has one **https link** that works in a
   browser anywhere, and opens the app when it is installed.
3. A **tracker web app** where a signed-in user reads and works their own
   tracker, reads their colleagues', manages their account, and
   administrators manage users. No chat in v1.
4. **Per-repo visibility, verified by GitHub**: an item is readable by
   users who, like its owner, are verified members of the GitHub org that
   owns the repo the item was filed from. Personal repos and conversations
   without a repo stay private. No admin maintains a membership list.

## Non-goals (v1)

- Chat, a composer, or live conversation streaming in the web app. See
  "Built for chat later".
- Public or signed links readable without signing in.
- Per-item or per-mission sharing controls.
- Comments, closes or reorders by anyone but the owner (and the owner's
  agents).
- Manually curated teams. Visibility is derived from GitHub org membership
  only; repos on other hosts have no cross-user audience until a second
  identity provider is added.
- Signing in to the journal with GitHub instead of a password. Linking is
  additive; the password stays. A natural follow-up.
- Multi-company tenancy. One journal is one installation.

## Decisions taken during brainstorming

| Question | Decision |
|---|---|
| Item refs on GitHub (#2769) | Never `#N` or `matron://`; say it in words; the https link once it exists. Shipped. |
| Link format (#2771) | https on the journal host is canonical. In-app opening via a registered `matron://` scheme; universal links optional per build. See "Why not universal links alone". |
| Web access (#2772) | A new, focused web app on the journal HTTP API. Not matron-web. |
| Visibility (#2773, #2784) | Per repo, audience derived from the GitHub org in the remote. |
| Membership (#2791) | Verified: each user links their GitHub account; the journal reads their org memberships. Replaces the manual teams of revision 1. |
| OAuth flows (#2791) | Both. The web authorization flow when the installation registers its own OAuth App; the device flow always, with a default client id shipped by Matron. |
| Chat in the web app (#2788) | Not in v1; the app is structured so a conversation view can be added. |

## Repo identity

The bridge learns a session's repo and tells the journal. Nothing else
in the design depends on local paths.

- **Canonical repo string**: `host/org/name`, lower-cased host and org,
  name as-is minus a trailing `.git`. `git@github.com:Matronhq/matron-journal.git`,
  `https://github.com/Matronhq/matron-journal` and `ssh://git@github.com/Matronhq/matron-journal.git`
  all become `github.com/matronhq/matron-journal`. `org` is whatever owns
  the repo on the host: a GitHub organisation or a personal account.
  Comparisons are case-insensitive on the whole string.
- **Bridge** (`lib/repo-identity.js`, new): on session create, resume and
  `/workdir`, run `git -C <workdir> remote get-url origin` with a 2 s
  timeout via `spawnSync`. Best effort: no git, no remote, or a timeout
  yields `null`. Never throws, never sends the workdir path to the journal.
- **Wire**: `convo_upsert` gains an optional `repo` field. Absent means
  unchanged; `null` clears; a string must match
  `^[a-z0-9.-]+/[a-z0-9_.-]+/[A-Za-z0-9_.-]+$` and be ≤ 256 chars, else
  `bad_request`. The `convo_meta` fan-out carries it so clients can show
  the repo on a conversation. The handler ignores unknown fields today, so
  an old journal simply drops `repo`.
- **Journal**: `conversations.repo TEXT` (nullable), index on
  `lower(repo)`.

Items, missions and milestones do not store a repo. Their repo is the
repo of the conversation they came from, resolved at query time:

- item → `conversations.repo` via `origin_convo_id`
- milestone → `conversations.repo` via `convo_id`
- mission → the set of repos of its `origin_convo_id` plus every joined
  conversation; a mission is visible if any of them is.

A conversation's repo can change (the user switches workdir). Visibility
follows the current value; that is the rule that is cheapest and easiest
to explain.

## GitHub account linking (matron-journal)

### Why link accounts

The org in a repo string says who owns the code, not who the journal user
is. Without a link, membership would have to be typed in by an admin and
the journal would verify nothing. With a link, GitHub is the source of
truth: the journal asks GitHub, with the user's own token, which orgs the
user belongs to, and keeps that list. Private org memberships are visible
to the member's own token, so private orgs work without any org-level
installation.

### Data model (`src/db.js`)

```
CREATE TABLE IF NOT EXISTS github_accounts(
  user_id        INTEGER PRIMARY KEY REFERENCES users(id),
  host           TEXT NOT NULL DEFAULT 'github.com',  -- GHES support later
  github_id      INTEGER NOT NULL,        -- stable numeric id
  login          TEXT NOT NULL,           -- current login, display only
  token          TEXT NOT NULL,           -- OAuth user token, scope read:org
  orgs           TEXT NOT NULL DEFAULT '[]',  -- JSON, lower-cased org logins
  state          TEXT NOT NULL CHECK(state IN ('ok','stale')),
  checked_at     INTEGER,                 -- last successful membership read
  linked_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_github_accounts_id ON github_accounts(host, github_id);
CREATE TABLE IF NOT EXISTS github_link_flows(
  id           TEXT PRIMARY KEY,          -- 'gl_' + 16 hex
  user_id      INTEGER NOT NULL REFERENCES users(id),
  device_id    INTEGER NOT NULL,
  flow         TEXT NOT NULL CHECK(flow IN ('device','web')),
  device_code  TEXT,                      -- device flow
  state        TEXT,                      -- web flow CSRF state
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
```

One GitHub account per journal user and one journal user per GitHub
account. Linking an account already held by another user is `409
conflict`; the admin resolves it.

**Token at rest.** With `MATRON_TOKEN_KEY` (64 hex chars) set, the token
is sealed with AES-256-GCM before it is stored (`enc1:` prefix) and
existing rows are sealed at the next start; unset keeps plaintext, which
is acceptable because the scope is `read:org`, the user can revoke it on
GitHub, and the database already holds credentials of the same class.
`github_accounts.token_hash` (SHA-256 of the plaintext) is what the
refresh path matches on, so guards never compare ciphertext.

### Configuration

- `MATRON_GITHUB_CLIENT_ID`: defaults to Matron's published OAuth App
  client id, the way the GitHub CLI ships one. Overridable.
- `MATRON_GITHUB_CLIENT_SECRET`: optional. When set, the **web flow** is
  offered; the installation has registered its own OAuth App with callback
  `https://<journal>/github/callback`. When unset, only the device flow.
- `MATRON_GITHUB_HOST`: optional, defaults to `github.com`. Repo strings
  match on this host.

Both flows need the OAuth App to have "Device flow" enabled in its
GitHub settings. Matron's published app has it on; an installation's own
app must turn it on to keep the device path as a fallback.

A **GitHub App** (installed on the org by an org owner) was considered and
rejected for v1: it can read membership without per-user tokens, but every
org owner has to install it, and the per-user token already answers the
one question the journal asks.

### Flows

**Web flow** (`MATRON_GITHUB_CLIENT_SECRET` set). The account page's
"Link GitHub" button calls `POST /github/link {flow:'web'}` → `{url}`,
a GitHub authorize URL with `scope=read:org` and a random `state` stored
in `github_link_flows` for 10 minutes. GitHub redirects to
`GET /github/callback?code&state`. The journal consumes the flow row,
exchanges the code with the client secret, fetches `GET /user` and the
org list, and — instead of linking at once — parks the token and identity
on a `github_link_confirms` row (10 minutes, single-use nonce) and
renders a small confirm page: "You signed in to GitHub as **@login**. This
will link that GitHub account to the Matron journal user **name**." Only
the Link button (`POST /github/callback/confirm {nonce, decision:'link'}`)
upserts `github_accounts` and redirects to `/app/account?linked=1`; Cancel
discards the parked token and redirects to `/app/account?link_error=denied`.
The callback is bound to the flow row's user, not to the browser's Bearer
token, because the redirect arrives without one — and that is exactly why
the page exists: an authorize URL can be handed to anyone, and the person
who authorizes must see which journal account they are about to bind.
GitHub's pages name the OAuth App, never the journal user.

**Device flow** (always). `POST /github/link {flow:'device'}` asks GitHub
for a device code and returns `{flow_id, user_code, verification_uri,
interval}`. The page shows the code and a link to github.com/login/device;
it polls `POST /github/link/:flow_id/poll` at `interval`. The journal
polls GitHub's token endpoint on each call and answers `{status:
'pending'|'linked'|'expired'|'denied'}`, finishing exactly as the web flow
does on `linked`. The apps can offer the same flow from their settings
screens later; nothing in it needs a browser.

**Membership read.** `GET /user/memberships/orgs?state=active` (paginated)
with the user's token; store lower-cased `organization.login` values.
This lists every org the user is an active member of, including private
memberships, because it is the user's own token.

**Refresh.** A daily journal job (`src/github-refresh.js`, same style as
retention) re-reads memberships for every linked account. The web app
also triggers `POST /github/refresh` on sign-in and from a button. A `401`
or `403` from GitHub sets `state='stale'`, which **fails closed**: a stale
account confers no cross-user visibility until a later refresh succeeds
(the daily job retries stale rows) or the user re-links. Other
errors keep the previous list and log.

**Unlink.** `DELETE /github/link` removes the row; the web app tells the
user to also revoke the app on GitHub if they want the token dead.

### Visibility rule

`canRead(viewer, row)` for an item, mission, milestone or conversation
excerpt, where `owner` is the row's `user_id`:

1. `viewer.userId === owner` → yes (unchanged from today).
2. Otherwise the row's repo `R` must be non-null, `host(R)` must equal the
   configured GitHub host, and `org(R)` must be in **both** the viewer's and
   the owner's `orgs` lists, each from a `github_accounts` row in state
   `ok`.
3. Rows whose origin conversation is owned by a **private device** are
   never cross-user visible. The existing privacy sieve (`src/privacy.js`)
   runs first.

Consequences: a repo under a personal login is in nobody's `orgs`, so it
is private to its owner; a user with no linked account is fully private in
both directions; leaving a GitHub org ends visibility at the next refresh.

Agent callers get the read visibility of their owning user, so an agent
can answer "what did Dan decide about X" from a colleague's items. Writes
remain owner-only for users and agents alike.

The predicate lives in one place, `src/visibility.js`, and is the only
copy: `/items*`, `/missions*`, `/milestones*`, `/lookup` and the excerpt
read all call it, following the `privacy.js` precedent of a single shared
sieve.

## HTTP API changes (`src/http.js`, `src/items-http.js`, `src/missions-http.js`, new `src/github-http.js`, `src/users-http.js`)

Reads that widen:

- `GET /items?scope=mine|shared` (default `mine`, today's behaviour).
  `shared` returns every item visible under the rule, with `owner:
  {user_id, name, github_login}` on each row and `repo` where known.
  Existing filters apply.
- `GET /missions?scope=mine|shared`, same shape.
- `GET /items/:id`, `GET /missions/:id`, `GET /missions/:id/milestones` on
  a visible foreign row return it with `owner` and `repo`. An invisible
  row is `404 not_found` (anti-enumeration, as today).
- Writes to a visible foreign row (`comment`, `close`, `reopen`, `rank`,
  `PATCH`) are `403 forbidden`. Visible-but-not-yours is safe to
  distinguish from does-not-exist because the caller can already read it.
- `GET /lookup?user=<name>&num=<n>` → `{kind: 'item'|'mission'|'milestone',
  id}` for a visible row, else `404`. Numbers come from the shared per-user
  counter, so one lookup resolves all three kinds.
- `GET /convo/:id/messages?around_seq=&limit=` gains the same rule for a
  **foreign user's** conversation: allowed when the conversation's repo is
  visible to the viewer and the conversation is not private-owned. Prose
  only (`text`, `diff`), `limit` clamped to 30, logged server-side, exactly
  as the existing foreign-device read. This is what the milestone excerpt
  view uses.
- `GET /me` → `{user: {id, name, is_admin}, github: {login, orgs, state,
  checked_at} | null}`.

GitHub linking: `POST /github/link`, `POST /github/link/:id/poll`,
`GET /github/callback`, `POST /github/refresh`, `DELETE /github/link`, as
above. `POST /github/link` shares the `/login` per-IP limiter.

User administration (journal admin, `users.is_admin`, bootstrapped by
`matron-admin user admin <name> on|off`), mirroring `matron-admin`:

- `GET /users` (with each user's `github_login` and link state),
  `POST /users {name, password}`, `POST /users/:id/password {password}`,
  `PATCH /users/:id {is_admin}`, `DELETE /users/:id/github-link` (to
  resolve a conflict).
- `POST /users/:id/link-code {ttl_seconds}` → the same payload `matron-admin
  link-code` produces, so the web app can show the pairing QR for a new
  colleague's phone.

Self-service (any user), reusing existing helpers where routes are
missing: `GET /devices`, `DELETE /devices/:id`, `PATCH /devices/:id {name}`,
`POST /me/password {old, new}`.

All new routes follow `http-who.js` conventions and bear the existing
Bearer auth, except `GET /github/callback`, which is authenticated by the
flow row's `state`, and `POST /github/callback/confirm`, which is
authenticated by the confirm row's nonce.

### Item links and the lookup URL

Canonical link: `https://<journal-host>/u/<username>/<num>`.

- Short, one form for all three kinds, and the username makes the per-user
  number unambiguous.
- The journal serves the web app for `/u/*`, which calls `/lookup` and
  routes to the item, mission or milestone page.
- The journal also answers `GET /u/<user>/<num>` with `Accept:
  application/json` by returning the lookup result, so tools can resolve
  a pasted link without loading the app.

### Static hosting

`MATRON_WEB_DIR` (env, unset today → nothing changes). When set, the
journal serves that directory read-only: exact files for assets, and the
directory's `index.html` for `/u/*` and `/app/*` (history fallback). Same
origin as the API, so no CORS is introduced. Cloudflare in front caches
assets by the content hashes in their filenames.

`GET /.well-known/apple-app-site-association` and
`GET /.well-known/assetlinks.json` are served from env
(`MATRON_APPLE_APP_IDS`, `MATRON_ANDROID_CERT_SHA256`) when those are set,
claiming `/u/*`. Unset → `404`. See "Why not universal links alone".

### Marker events

Unchanged. Foreign rows are read through HTTP, never replayed into another
user's journal; the WebSocket stays a per-user stream. The web app
refreshes a shared view on its own `item`/`mission` markers and on a 60 s
poll while a shared view is open.

## Bridge changes (matron-bridge)

1. **Guidance**: shipped on branch `feat/no-tracker-numbers-on-github`
   (both prompt files, test `test/tracker-refs-outside-matron.test.js`).
   Once the journal serves links, the bridge appends the user's own link
   prefix to the instructions it renders (`Your shareable item link form is
   https://<journal>/u/<name>/<num>`), and the rule gains: "the https item
   link is the one form allowed outside Matron". The bridge knows both the
   journal base URL and the user name already.
2. **Repo reporting**: `lib/repo-identity.js` plus the `repo` field on
   `upsertConvo` in `lib/journal-publisher.js`, called from session create,
   resume and `/workdir` in `index.js`.
3. **Tools**: `item_list` and `mission_get` accept `scope: 'shared'`;
   `item_get` and `item_comment` accept `dan#12` and a pasted https link as
   the id; list output shows the owner on foreign rows. In-chat references
   to a colleague's item render as `[dan#12](https://…/u/dan/12)`. Own
   items keep `[#12](matron://item/12)` in chat for v1 so existing clients
   need no change to keep working; switching chat to the https form is a
   follow-up once every app handles it.

## Apps (matron-apple, matron-android)

- **Register the `matron` URL scheme** with the OS (`CFBundleURLTypes`,
  an `intent-filter` with `android:scheme="matron"`). Handle
  `matron://open?v=1&server=<url-encoded base>&user=<name>&num=<n>`:
  if the app is signed into that server, open the row (existing item and
  mission detail hosts, via `/lookup`); otherwise show "not signed in to
  <host>". The existing `matron://link?…` pairing URL rides the same
  registration.
- **Handle the https form** the same way, both from the OS (universal /
  app links, when a build configures them) and inside message bodies:
  the markdown link handlers that already catch `matron://item/<n>` also
  catch `https://<this server>/u/<user>/<num>`.
- **Associated domains are per build, optional.** `project.yml` and
  `build.gradle` read the journal host from a build setting
  (`MATRON_LINK_HOSTS`); a build without it simply has no universal links
  and relies on the scheme.

### Why not universal links alone

Universal Links and App Links require the domain to be baked into the
app at build time and a site-association file on that domain. Matron is
self-hosted, so the App Store build cannot know every journal's host. The
scheme works for any host; universal links are a per-deployment upgrade
for installations that build their own apps. The web app's item page
therefore shows an **Open in Matron** button that launches the scheme
URL, and on iOS and Android tries it automatically once per page load.

## Web app (new repo)

Proposed name `matron-tracker`; the name is Dan's call.

### Stack

TypeScript, React, Vite, no server of its own. Output is a static
directory the journal serves (`MATRON_WEB_DIR`). React because matron-web
is React, so nothing new to learn. No component framework beyond a small
shared set; the design follows the apps' tracker panel (list, detail,
thread) so the three surfaces read as one product.

Auth: `POST /login` with `device_name: 'web (<browser>)'`; the returned
client-device token is kept in `localStorage` and sent as Bearer. Sign
out revokes the device. The account page lists it alongside phones and
Macs, so a forgotten browser can be revoked from anywhere.

### Structure (the "built for chat later" shape)

```
src/
  api/            JournalClient: HTTP + WebSocket, token, cursor replay
  model/          items, missions, milestones, conversations, github link
  features/
    tracker/      my list, shared list, item detail, thread, compose comment
    missions/     mission list, mission page, milestone list
    excerpt/      read-only conversation excerpt around a seq
    account/      GitHub link, devices, password, pairing QR
    admin/        users
    conversation/ RESERVED: route /c/:id, renders excerpt today
  routes.tsx      /u/:user/:num, /items, /shared, /missions/:id, /c/:id, /account, /admin
```

`JournalClient` speaks the same WebSocket `hello` the apps use, with a
cursor, so the app already receives the user's live event stream. v1
consumes only `item` and `mission` markers from it. Adding chat later is a
`features/conversation` implementation over the same client and the same
event types, not a second data layer.

### Screens

- **Sign in.** Username, password, server is the page's own origin.
- **My tracker.** Three groups, like the apps: awaiting me, awaiting
  agent (tasks in rank order), decisions in force. Closed items behind a
  toggle. Drag to reorder posts `rank`.
- **Shared.** Every visible item from colleagues, grouped by org, repo,
  then owner, with kind/state/awaiting filters and a search box
  (client-side over the loaded page; server search is a follow-up). Empty
  state explains that linking GitHub is what makes items appear here.
- **Item.** Title, body, labels, links, thread with attachments inline,
  voice-note transcripts as text. Owner: comment, close with resolution,
  reopen, edit. Colleague: read only, with a visible "owned by Dan" line.
  Origin: "filed from <conversation title>" linking to the excerpt.
- **Mission.** Body, milestones newest first (each opens its excerpt),
  open items, conversations. Owner can close with a summary; refuses over
  open items exactly as the API does.
- **Excerpt.** The messages around a milestone's `seq`, prose only, with
  "Open full conversation in matron-web" when a matron-web URL is
  configured (`MATRON_WEB_CHAT_URL`, optional).
- **Account.** "Link GitHub" (web flow button when available, device
  code otherwise), the linked login and org list with a refresh button
  and last-checked time, unlink; devices (rename, revoke); change
  password; "pair a phone" QR via the link-code route.
- **Admin.** Users: create, reset password, admin flag, see and clear a
  GitHub link. Journal admins only.

### Open in Matron

Every item, mission and milestone page shows the button described under
the apps section. The page's own URL is the shareable link; a copy button
puts it on the clipboard.

## Error handling

- Journal: every new route returns the existing shapes (`bad_request`,
  `not_found`, `forbidden`, `conflict`, `rate_limited`). Invisible rows are
  `404`, never `403`.
- GitHub unreachable during a link: `502 upstream` with a retry hint; the
  flow row stays until it expires. During a refresh: previous list kept,
  logged, `checked_at` untouched.
- Repo detection in the bridge never fails a session start: any error is
  `repo: null` and a debug log line.
- Web app: `401` anywhere drops the token and returns to sign-in with the
  intended route preserved. `403` on a foreign row renders the read-only
  view with the action bar hidden, never a dead end. A `stale` link shows
  a banner with a re-link button on every page.
- Lookup of an unknown or invisible link shows "no such item, or you
  cannot see it", the same message for both.

## Security notes

- Anti-enumeration is preserved: invisible rows and unknown users answer
  `404` identically. Neither `/lookup` nor `/search` is rate limited; the
  identical 404 is the anti-enumeration guard.
- Link phishing: the web flow's confirm page names the journal user before
  anything is saved, so a victim handed someone else's authorize URL sees
  the wrong name and cancels. The device flow has no such hook — the
  authorizer only ever sees GitHub's device page — so a user_code handed
  to a victim can bind the victim's identity to the attacker's journal
  account. The residual guards are the `409 conflict` for an identity
  already linked elsewhere and the admin's ability to clear a link (Plan
  B). Installations that can register an OAuth App should prefer the web
  flow.
- Blobs follow the rule through the row that references them: a colleague
  may `GET /media/:id` only when a prose event in a shared conversation or
  an attachment on a shared, non-consent item names the blob and the row's
  owner owns the blob. Same 404 otherwise; every foreign read is logged.
- Private devices stay private across orgs. The sieve runs before the
  org rule and a test pins the order.
- Foreign excerpt reads are prose-only, capped at 30 and logged with viewer
  and conversation ids, matching the existing foreign-device rule.
- The GitHub token has one read-only scope, is never returned by any
  route, never logged, and is deleted on unlink. `state` values and
  device codes are single-use and expire in 10 minutes.
- The web callback checks `state` against the flow row and ignores the
  browser's session entirely, so a forged callback cannot link an account
  to someone else.
- The repo string is validated server-side; it is peer text like a title
  and passes the same control-character sanitiser.
- Static serving is read-only, rejects path traversal, and serves nothing
  unless `MATRON_WEB_DIR` is set.
- The well-known files are served only when configured, so a journal
  without app builds claims nothing.

## Testing

- **Journal**: schema migration on a populated DB; visibility predicate
  table-driven (owner; colleague in the org; colleague not in the org;
  owner with stale link; viewer with no link; private-owned origin; repo
  under a personal login; no repo; mission with mixed repos); device and
  web link flows against a fake GitHub (pending, linked, denied, expired,
  bad state, account held by another user); refresh success, `401` →
  stale, network error → unchanged; route tests for `scope=shared`,
  foreign read/write status codes, lookup, foreign excerpt cap and
  logging, users admin authorisation, static fallback and traversal,
  well-known on/off.
- **Bridge**: `repo-identity` normalisation table (ssh, https, ssh://,
  no `.git`, no remote, timeout); `convo_upsert` carries `repo` on create,
  resume, `/workdir`; tool id parsing for `dan#12` and links.
- **Web app**: unit tests on the client and models; component tests for
  the item page in owner and colleague modes and the account page in
  both link flows; one end-to-end run against a journal started from
  `test/` fixtures with a fake GitHub (sign in, link, open a link,
  comment, a colleague in the same org sees the item).
- **Apps**: link-handler unit tests for the scheme and https forms; the
  existing snapshot tests for item links extended with the https form.

## Rollout

Each step below is its own implementation plan in its own repo; the
steps share this spec, not a plan. A journal with no linked accounts and
no `MATRON_WEB_DIR` behaves exactly as today after every step.

1. **matron-bridge guidance**. Done, awaiting merge.
2. **Matron's OAuth App**: register it under the Matronhq GitHub org with
   device flow enabled; publish the client id as the journal default.
3. **matron-journal**: `repo` on conversations, GitHub linking and
   refresh, visibility, lookup, users admin, static hosting, well-known.
4. **matron-bridge**: repo reporting, tool scopes, link prefix in the
   instructions. Old journals drop the unknown field, so this can deploy
   before or after step 3.
5. **matron-tracker** web app, deployed by setting `MATRON_WEB_DIR` on the
   journal host.
6. **Apps**: scheme registration and https link handling, then optional
   associated domains for installations that build their own.
