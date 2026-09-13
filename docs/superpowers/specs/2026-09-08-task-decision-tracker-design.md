# Task & decision tracker — design

**Date:** 2026-09-08 · **Requested by:** Dan ("a task and decision tracker
built into matron … a third column on desktop and on right swipe in the
conversation panel on mobile")

Spans three repos. This is the single design; each repo gets its own
implementation plan (see *Rollout*).

## Problem

Long-running agents make decisions on their own and pile up decisions they
need from Dan. When he comes back the agent says "I need decisions on x, y
and z" and the context is lost somewhere up a long timeline. Asking for a
recap produces one long message; answering the first question scrolls the
rest out of view. Images the agent wants looked at are equally hard to find
again, and the media browser shows them without their descriptions. The
CLAUDE.md rule "put everything in GitHub issues" half-works: issues get lost
too and rarely arrive as links.

## Goal

A real issue tracker inside Matron, owned by the journal and shared by every
agent and conversation belonging to the same journal user:

- Every decision the agent took, every question it needs answered, and every
  task, as one **item** type with a kind, a state, and its own comment thread.
- A **panel** beside the chat (Mac: a pane; iOS: a right-edge drawer) listing
  what needs Dan, open tasks in a drag-sortable order, decisions in force,
  and what's done. Default scope: this conversation. One toggle: everything.
- Items and comments are rich: Markdown bodies, images and files as journal
  blobs, voice-note answers.
- Answering an item from the panel notifies **the originating conversation's
  agent** as a normal user turn: queued if the agent is mid-turn, waking the
  box if it is asleep. Other agents see changes only by listing.
- Agents create, read, comment on, close, and reorder items through an API
  (journal HTTP routes, wrapped as bridge MCP tools).
- A **"Make task"** action files composer text as a task instead of sending
  it; the same action sits on the queued-message card.

## Non-goals (v1)

- Due dates, assignees beyond *user* / *agent*, priorities.
- GitHub sync (items can carry links to issues; nothing more).
- Editing or deleting another author's comments; deleting items at all.
- Cross-user visibility of any kind.
- A second real-time channel: the panel is refreshed by marker events on the
  existing WebSocket.
- Codex-specific tooling beyond the HTTP routes (Codex sessions can curl them).

## Decisions taken during brainstorming

| Question | Decision |
|---|---|
| One entity or several? | One `item` with `kind` ∈ task / question / decision; comments on all of them; kind-specific views. |
| Ownership | Journal user. Any agent or device of that user can read every item; default panel scope is the current conversation. |
| Timeline presence | Compact inline cards on create and close (like ask-user / spawn-consent cards). Answering happens only in the item's thread. |
| Who creates | Agents via API; Dan via the panel and via "Make task". |
| Who is notified on a comment | The item's origin conversation only, always. |
| Storage | Dedicated tables with REST routes (a real tracker). The conversation log carries only marker events. |
| Ordering | Manual drag order via a float `rank`; priority dropped. |
| Mac layout | Tracker shares the detail slot with the sub-chat pane (one or the other). |
| "Make task" placement | A pill floating above the composer, centred, shown only once there is text — same treatment as the scroll-to-bottom arrow. Both platforms; ⌘⇧T on Mac. |

## Data model (matron-journal, `src/db.js`)

Same idempotent `CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` pattern
as every other table.

```sql
CREATE TABLE IF NOT EXISTS items (
  id               TEXT PRIMARY KEY,          -- 'it_' + 16 hex
  user_id          INTEGER NOT NULL REFERENCES users(id),
  num              INTEGER NOT NULL,          -- per-user counter, shown as #num
  kind             TEXT NOT NULL CHECK (kind IN ('task','question','decision')),
  state            TEXT NOT NULL CHECK (state IN ('open','closed')),
  resolution       TEXT CHECK (resolution IN ('done','answered','decided','reversed','cancelled')),
  awaiting         TEXT CHECK (awaiting IN ('user','agent')),   -- NULL = nobody
  rank             REAL NOT NULL,
  title            TEXT NOT NULL,             -- ≤ 200 chars
  body             TEXT NOT NULL DEFAULT '',  -- Markdown, ≤ 32 KiB
  labels           TEXT NOT NULL DEFAULT '[]',-- JSON array of strings
  links            TEXT NOT NULL DEFAULT '[]',-- JSON array of {url, title?}
  supersedes       TEXT REFERENCES items(id), -- decision that replaced this one
  origin_convo_id  TEXT NOT NULL,
  origin_device_id INTEGER NOT NULL,          -- creator's device row id (agent or client)
  created_by       TEXT NOT NULL CHECK (created_by IN ('user','agent')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  closed_at        INTEGER,
  UNIQUE (user_id, num)
);
CREATE INDEX IF NOT EXISTS items_user_state ON items(user_id, state, rank);
CREATE INDEX IF NOT EXISTS items_convo      ON items(origin_convo_id, state);
CREATE INDEX IF NOT EXISTS items_updated    ON items(user_id, updated_at);

CREATE TABLE IF NOT EXISTS item_comments (
  id          TEXT PRIMARY KEY,               -- 'ic_' + 16 hex
  item_id     TEXT NOT NULL REFERENCES items(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  author      TEXT NOT NULL CHECK (author IN ('user','agent')),
  device_id   INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('comment','status')),
  body        TEXT NOT NULL DEFAULT '',       -- Markdown; for 'status' a short generated line
  attachments TEXT NOT NULL DEFAULT '[]',     -- JSON array of {blob_ref, mime, name, size, transcript?}
  meta        TEXT,                           -- 'status' rows: {from:{state,resolution,awaiting}, to:{…}}
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS item_comments_item ON item_comments(item_id, created_at);

CREATE TABLE IF NOT EXISTS item_counters (user_id INTEGER PRIMARY KEY, next_num INTEGER NOT NULL);
```

### Semantics

- **Kinds and lifecycle**
  - *question*: created `open`, `awaiting='user'`. A user comment sets
    `awaiting='agent'`. The agent closes with `answered` once acted on. Any
    further user comment on a closed item reopens it awaiting the agent.
  - *task*: created `open`, `awaiting` = whoever is expected to do it (agent
    by default; user tasks are allowed). Closed with `done` or `cancelled`.
  - *decision*: created `open` = in force, `awaiting=NULL`. Reversing = close
    with `reversed`; the agent usually creates a new decision with
    `supersedes` pointing at the old one. A user comment on an open decision
    sets `awaiting='agent'` (Dan is challenging it); the agent either closes
    it as `reversed`, or comments and clears `awaiting`.
- **`awaiting='user'` is the "Needs you" set** across all kinds.
- **`rank`** — one order per user. New items get `max(rank)+1024` (bottom)
  unless the caller asks for `position:'top'` (`min(rank)-1024`) or supplies
  `after`/`before` item ids (midpoint). A reorder writes only the moved
  item's rank. When the two neighbours differ by less than `1e-6` the
  journal renormalises all of that user's open items to `1024·n` in one
  transaction before applying the move.
- **`num`** — allocated from `item_counters` inside the create transaction.
- **Attachments** are ordinary journal blobs uploaded through the existing
  `POST /media` route; items reference them by `blob_ref`. The media reaper
  only ever reaps blobs joined to `image`/`file` event rows, so an item
  attachment (referenced from a table, not an event) is never a candidate;
  a test pins that so a future reaper change cannot regress it.
- **Voice notes** are a comment with an `audio/*` attachment. The bridge
  transcribes when it consumes the marker (the same path as chat voice
  notes) and writes the text back via `PATCH /items/:id/comments/:cid`
  (agent-only, transcript field only), so the panel shows the words too.
- **Privacy sieve** — for agent callers (`kind='agent'`), an item whose
  `origin_convo_id` is a private conversation the agent is not party to is
  invisible (list, get, comment, close all 404). Same rule as `/search`.
- **Limits**: title ≤ 200 chars, body ≤ 32 KiB, comment ≤ 32 KiB, ≤ 20
  attachments per comment, ≤ 50 labels, ≤ 50 links. Over-limit → 400.

## HTTP API (matron-journal, `src/http.js`)

All routes Bearer-authenticated with existing device tokens; scoped by the
token's `user_id`. `authorize` for client tokens (an agent may read
anything of the user it can see through the sieve, and may comment on /
close anything it can read; only the origin agent's marker turns into a
prompt — see *Routing*). `authorizeAgentWrite` still gates the two routes
that target a conversation rather than an already-visible item: create
(against the body's `convo_id`) and the transcript `PATCH` (against the
item's origin conversation, since transcribing is the origin bridge's job).

| Route | Purpose |
|---|---|
| `GET /items?convo=&kind=&state=&awaiting=&label=&sort=rank|updated&since=&limit=&cursor=` | List. `since` = `updated_at` watermark for cheap polling. Default `limit` 100, max 500. Returns `{items:[…], next_cursor?}`; each item carries `comment_count`, `last_comment_at`, `has_image`. |
| `GET /items/:id` | One item + full thread `{item, comments:[…]}`. Accepts `#num` as well as id. |
| `POST /items` | Create. Body `{kind, title, body?, labels?, links?, attachments?, awaiting?, position?, after?, before?, convo_id?, supersedes?, on_behalf_of?}`. Agents default `convo_id` to their current conversation (bridge fills it in); clients must pass it. `on_behalf_of: "user"` (agent callers only) records the item as user-created with a marker `by: "user"`, for the queued-card "Make task" tap, which the bridge performs with its own token; the marker's sender stays the agent device so it neither wakes nor re-prompts. Returns the item. |
| `PATCH /items/:id` | Update `title, body, labels, links, awaiting`. Author-agnostic. |
| `POST /items/:id/comments` | `{body, attachments?}` → comment. Applies the `awaiting` flip rules. |
| `PATCH /items/:id/comments/:cid` | Agent-only, `{transcript}` on one attachment. |
| `POST /items/:id/close` | `{resolution, comment?}` → status comment + state change. |
| `POST /items/:id/reopen` | `{comment?}` → reopen, `awaiting` per kind rules. |
| `POST /items/:id/rank` | `{after?, before?, position?}` → new rank. No prompt is generated. |

Every mutating route runs in one transaction that also appends the
**marker event** (below) to `origin_convo_id`. Idempotency: `POST /items`
and `POST /items/:id/comments` accept an `Idempotency-Key` header stored in
an `idem_key` column (unique per user) on `items` / `item_comments`, so a
retried create returns the original row instead of doubling up.

## Marker event (protocol, `docs/protocol.md`)

New event type `item` in the conversation log, written only by the journal
itself from the item routes. It is **not** added to `AGENT_PUBLISH_TYPES`,
so an agent cannot `publish` one directly. Not a `MESSAGE_TYPES` member, so it does not
affect unread counts or snippets, except as noted for push.

```json
{
  "type": "item",
  "payload": {
    "item_id": "it_…", "num": 12, "kind": "question",
    "title": "Which auth library?",
    "action": "created" | "commented" | "closed" | "reopened" | "reordered",
    "by": "user" | "agent",
    "awaiting": "user" | "agent" | null,
    "resolution": "answered" | null,
    "comment": {                       // present for action=commented/closed/reopened when a body exists
      "id": "ic_…",
      "body": "use the one we already have in the monorepo",
      "attachments": [{ "blob_ref": "…", "mime": "audio/mp4", "name": "…", "transcript": null }]
    }
  }
}
```

The event's `device_id` is the writer's device, so a comment Dan posts from
his phone is a **user-authored event** on the origin conversation. That is
what makes the wake and busy-queue paths work with no new plumbing.

**Push** (`src/push.js`): `action='created'` with `awaiting='user'`, or
`action='commented'` with `by='agent'` and `awaiting='user'`, pushes with
the title as the body ("❓ #12 Which auth library?"). Everything else is
silent. Conformance fixtures added under `test/fixtures/conformance/`.

## Old-client fallback (`fallback_for`, added 2026-09-09)

Older clients cannot render `item` markers: pre-tracker iOS/Mac builds show
"[unsupported event: item]", Android skips unknown types, matron-web dumps
the raw payload, and a pre-tracker bridge drops user-authored markers. An
agent that files a question and waits on the user would be waiting on
someone who cannot see it. So the journal also writes a plain `text` event
that every existing client already renders. This is a degrade path, not a
second timeline: new clients hide it.

**Emission (journal, `emitMarker`).** Immediately after a marker with
`action` ∈ {`created`, `commented`, `closed`, `reopened`} is appended (never
for `reordered`/`updated`), append one more event to the same conversation
with the same `sender`:

```json
{ "type": "text",
  "payload": { "body": "📌 …", "fallback_for": "item",
               "item_id": "it_…", "num": 12, "action": "created" } }
```

The body is built by a pure function `itemFallbackText(markerPayload,
{ actor, body })` in `src/items-marker.js`. `actor` is the display name
(`agent:dev-2` → `dev-2`, `user:dan` → `dan`); `body` is the item body for
`created` (the marker carries none). Kind word lowercase, title one-lined
and cut to 120 chars with `…`, body/comment cut to 500 chars with `…`,
attachments one per line as `[voice note <name>]` / `[attachment <name>]`:

| action | first line | then |
|---|---|---|
| `created`, by agent, awaiting user | `📌 Needs you — <kind> #N: <title>` | body lines |
| `created`, otherwise | `📌 New <kind> #N: <title>` | body lines |
| `commented`, by agent, awaiting user | `📌 Needs you — <kind> #N "<title>" — <actor> asked:` | comment lines |
| `commented`, otherwise | `📌 <Kind> #N "<title>" — <actor> commented:` | comment lines |
| `closed` | `✅ <Kind> #N "<title>" closed as <resolution>` | comment lines |
| `reopened` | `↩️ <Kind> #N "<title>" reopened by <actor>` | comment lines |

A failed fallback append is logged and swallowed like a failed marker
append; it never fails the request or the marker.

**Server rules.** `push.js` `classify` returns `null` for any `text` whose
payload has `fallback_for` (the marker already decided the push).
`search.js` `indexableBody` returns `null` for it (a hit would land on a row
new clients hide). Unread counts and snippets are deliberately **unchanged**:
the fallback is a normal message to old and new clients alike, so an agent
question now bumps unread and sets the chat-list snippet on every client.

**Bridge.** `journal-input-router` ignores a `text` frame whose payload has
`fallback_for` before any routing: the marker path already delivers the
turn. A pre-tracker bridge routes a user-authored fallback as ordinary chat
("📌 Task #12 … — dan commented: …"), which is the intended degrade.

**Apps.** `JournalTimelineMapper` returns `nil` for a `text` event whose
payload has `fallback_for`; the outbox delivery confirmation skips such
frames. Nothing else changes — unread and snippet follow the server.
Android and matron-web need no change; they render the text.

**Lifetime.** Temporary by design: a later journal release stops emitting
once pre-tracker clients are gone. Clients keep the filter; it is one guard.

## Routing (matron-bridge)

`lib/journal-input-router.js` / `createJournalInputConsumer` gain a case
for `type='item'` events authored by a **client** device on a conversation
the bridge owns:

- `commented`, `created` (by user), `closed`, `reopened` → a synthetic user
  turn:

  ```
  📌 Item #12 "Which auth library?" — you replied:
  use the one we already have in the monorepo
  [attachment: voice note 0:41 — transcript: …]
  (kind: question, now awaiting: agent. Use item_get for the full thread; item_close when acted on.)
  ```

  Voice attachments are fetched and transcribed first (existing voice path);
  the transcript is patched back to the comment.
- `reordered` → no turn. The agent reads order when it next lists.
- If the agent is mid-turn the synthetic turn goes through `busy-queue.js`
  exactly like a text message, so it is batched at turn end and shows the
  📨 Queued card. Item turns are never merged into a batch with a `/compact`.
- Events authored by the bridge's own device (its own API writes) and events
  on conversations the bridge does not own are ignored.

The journal's `wakeConvoAgent` already fires for user ops on a conversation
whose agent has no live socket; item routes call it after the transaction
for user-authored writes other than `reordered`.

### Queued card: "Make task"

`busy-queue.js`'s `queued_release` prompt gains a third action, **📌 Make
task**. Resolving it: remove the queued text from the batch, `POST /items`
with `kind:'task'`, `created_by:'user'`, title = first line (≤ 200 chars),
body = the rest, attachments = the queued attachments; the resulting
`created` marker is consumed by the router and joins the batch, so the
agent hears "Item #13 filed: …" at turn end instead of the raw message.

## Agent tools (matron-bridge, `ask-user.js`)

Thin `fetch` wrappers over loopback routes in `index.js`, which forward to
the journal through `lib/journal-publisher.js` with the bridge's agent
token and inject `convo_id` = the current room's conversation.

| Tool | Args | Notes |
|---|---|---|
| `item_create` | `kind, title, body?, labels?, links?, attachments? (local file paths), awaiting?, position?, supersedes?` | Local files are uploaded via `uploadMedia` first. Returns `{id, num}`. |
| `item_list` | `scope: 'convo'|'all', kind?, state?, awaiting?, label?, since?` | Default `convo`, `open`. |
| `item_get` | `id | num` | Full thread. |
| `item_comment` | `id, body, attachments?` | |
| `item_close` | `id, resolution, comment?` | |
| `item_reopen` | `id, comment?` | |
| `item_reorder` | `id, after? | before? | position?` | |

Tool descriptions steer usage: file a `question` item per decision you need
instead of listing them in prose; attach screenshots to the item; record
decisions you make yourself as `decision` items with the reasoning in the
body; close items when acted on; check `item_list` at the start of a session.
The bridge system prompt gets a short paragraph saying the same, which
replaces Dan's CLAUDE.md GitHub-issues rule. Item ids and `#num` are safe to
mention in chat; nothing in items is secret-shaped, so the redaction rules
are unchanged.

## Apps (matron-apple)

### Shared core (`MatronShared`)

- **`Items/ItemsClient.swift`** — the HTTP client for the routes above
  (URLSession, device token, cursor paging).
- **`Journal/JournalStore.swift`** — two GRDB tables `item` and
  `item_comment` mirroring the server columns, migration `v8`. Populated by
  `ItemsClient` fetches, not by the event log. `items(convoID:scope:)`,
  `itemDetail(id:)`, `ValueObservation` streams for both, same shape as
  `summaryEntriesStream`.
- **`Items/ItemsSync.swift`** — refresh policy: on panel open, fetch
  `GET /items?since=<max updated_at seen>` and reconcile; on an `item`
  marker event arriving for any conversation (the sync engine already
  delivers every event to `applyOne`), refetch that item by id. On
  reconnect, a `since` refetch. A full refetch when the local table is
  empty. Comments are fetched per item on detail open and on marker.
- **`ViewModels/ItemsPanelViewModel.swift`** — `@Observable`: `scope`
  (`.convo(id)` / `.all`), sections, `needsYouCount`, drag reorder (compute
  midpoint locally, optimistic update, `POST /rank`, revert on failure),
  create / comment / close / reopen actions, error surface.
- **`ViewModels/ItemDetailViewModel.swift`** — the thread, the comment
  composer state (text, staged attachments, voice recording via the
  existing `VoiceRecorder`), submit.
- **Local outbox**: comment and create go through the existing outbox
  pattern (`outboxInsert` gains an `item_comment` / `item_create` kind) so
  an answer written offline is sent when the network returns, with the
  same "Queued" indicator. Rank changes are not queued (best effort).
- **`Events/ItemEvent.swift`** — the marker payload decoder.
- **`DesignSystem/Items/`** — `ItemRow`, `ItemsListView` (sections, drag
  reorder in *Tasks* only, scope toggle, empty states), `ItemDetailView`
  (Markdown body via the existing renderer, inline images via the media
  cache, links, labels, thread, comment box, close / reopen / reverse
  buttons), `ItemInlineCard` (timeline card for `created` / `closed`;
  a single-line `ItemInlineNote` for `commented` / `reopened`),
  `MakeTaskPill`.

### Panel content

Sections in order:

1. **Needs you** — `awaiting='user'`, any kind, sorted by `updated_at`
   desc. Badge count is this section's size.
2. **Tasks** — `kind='task'`, open, sorted by `rank`; drag to reorder.
3. **Decisions** — `kind='decision'`, open, newest first.
4. **Done** — closed, any kind, `closed_at` desc, capped at 200 with
   "show more".

Header: title, scope segmented control (*This chat* / *All*), a **+** to
create (kind picker, title, body). In *All* scope every row shows the origin
conversation's title; tapping that title navigates to the conversation.

Row: kind glyph (☐ task, ❓ question, ⚖ decision), `#num`, title, one-line
body preview, awaiting badge, comment count, thumbnail of the first image
attachment if any.

Detail: title, `#num`, kind, state pill, origin conversation link, labels,
links, body (Markdown, images inline and tappable into the existing image
viewer / gallery), then the thread (comments and status rows, attachments
rendered like chat attachments), then the composer: text field, attach
(photos / files, existing pickers), voice-note button (existing recorder;
the note is posted as an attachment and the transcript appears when the
bridge writes it back), send. Action bar: **Close** (resolution picker per
kind), **Reopen**, and for decisions **Reverse**.

### Mac

- `MacChatView`'s detail area gets a third mode for the `HSplitView` slot:
  `.subChat(id)` or `.tracker`. Opening one closes the other. Threshold and
  observation-lifecycle rules in `MacChatView.swift:328-400` apply
  unchanged; the tracker pane is `minWidth: 380`, and below
  `sideBySideMinWidth` it takes over the detail area with the same back
  chevron the sub-chat uses.
- Toolbar button (`MacChatToolbar`) with the Needs-you count as a badge;
  ⌘⇧I toggles the pane.
- ⌘⇧T = "Make task" (menu-less; it is a keyboard equivalent on the pill).
- The pane is per-window state, remembered across conversation switches.

### iOS

- `ChatView` hosts an `ItemsDrawer` overlay: a right-edge `DragGesture`
  (start within 24pt of the trailing edge) slides a panel covering ~88% of
  the width over the chat with a dimming scrim. Toolbar button with badge
  opens it too. Inside, a `NavigationStack` (list → detail); the system
  back returns to the list. Dismiss: drag right, tap the scrim, or the
  close button. The gesture is disabled while the attachment preview or a
  sheet is up.
- No `TabView`; sub-chats keep their existing push presentation.

### Composer "Make task"

Both platforms: `MakeTaskPill` appears centred above the composer once the
field has non-whitespace text (or staged attachments), with the same fade
and offset as the scroll-to-bottom button. Tapping it files a `task` item on
the current conversation: title = first line (≤ 200 chars), body = the
rest, attachments = staged attachments (uploaded first through the existing
attachment path), then clears the composer. A brief "Filed #14" toast.
Mac: ⌘⇧T. Never shown for the sub-chat composer in v1.

### Inline cards

`JournalTimelineMapper` maps `item` events: `created` and `closed` →
`ItemInlineCard` (glyph, `#num`, title, "needs you" / "done" pill, tap →
opens the panel on that item). `commented` / `reopened` → `ItemInlineNote`
(one muted line: "You replied on #12 · Which auth library?"). `reordered`
→ hidden. Cards do not count toward the 120-row window's cost budget beyond
a normal text row (no images rendered in the card).

### Chat list

Each conversation row shows the Needs-you count for items whose
`origin_convo_id` is that conversation (a small ❓ badge next to the unread
count). Computed from the local `item` table via one grouped query.

## Error handling

- Route errors surface in the panel as a non-modal banner with retry;
  optimistic changes (rank, awaiting flip) are reverted.
- A comment that fails to send stays in the outbox with the existing
  "Queued" indicator and retry tap.
- The bridge logs and skips malformed `item` events; a failed transcription
  still delivers the turn with "(transcription failed)".
- A journal without the routes (older deploy) → the apps hide the toolbar
  button and pill after the first 404 on `GET /items`, and re-probe on
  reconnect. The bridge tools return a clear "journal does not support
  items yet" error to the agent.

## Testing

**Journal**: route tests (create with numbering, list filters and cursor,
`since` watermark, comment flip rules per kind, close / reopen, rank
midpoint and renormalisation, idempotency keys, limits, privacy sieve for
agents, reaper reference check); marker event contents and device
attribution; push classification; conformance fixtures.

**Bridge**: router turns an `item` event into the synthetic turn text
(fixtures per action, with and without attachments); busy-queue deferral and
batch merge rules; "Make task" from the queued card; MCP wrappers against a
stubbed journal including upload-before-create; tool descriptions snapshot.

**Apps**: GRDB migration; `ItemsSync` reconcile (since, marker refetch,
empty-table full fetch); panel VM sectioning, scope filtering, badge count,
rank math with revert; detail VM comment / voice submit and outbox;
snapshot tests for row, card, note, detail, pill (both appearances, both
platforms); Mac slot swap (sub-chat ↔ tracker) and iOS drawer open / close
in the existing snapshot harness (`MATRON_APP_SUPPORT_OVERRIDE` set, as
always).

## Rollout

Three independently deployable PR sets, in this order; older peers ignore
the `item` event type and the apps feature-detect the routes.

1. **matron-journal** — tables, routes, marker events, push rule, reaper
   guard, protocol doc. Deploy to dev-2 first (back up the DB).
2. **matron-bridge** — tools, loopback routes, router case, queued-card
   action, system-prompt paragraph. Deploy after (1) or the tools 404.
3. **matron-apple** — (a) shared core + panel + Mac pane + iOS drawer;
   (b) composer pill + inline cards; (c) chat-list badge. Android follows
   the same spec later.

Each repo gets its own implementation plan under `docs/superpowers/plans/`.
