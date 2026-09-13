# Missions & milestones — design

**Date:** 2026-09-10 · **Requested by:** Dan (coordinator direction,
2026-09-09: "Projects = one per ongoing thing; a human-readable history
tracking milestones/checkpoints … supersedes the per-turn summaries TOC")
· **Renamed** "missions" on 2026-09-10 ("it's possible that later there
could be a projects umbrella above that").

Sub-project 2 of the coordinator direction (sub-project 1, the app shell
tabs, shipped 2026-09-09). Spans three repos; this is the single design and
each repo gets its own implementation plan (see *Rollout*).

## Problem

Conversations are too long to navigate. Dan's stated pain: "sometimes it
runs for hours without my input", and he cannot find the last thing he
wrote, or the shape of what happened, by scrolling. The per-turn summaries
TOC that shipped 2026-08-10 was meant to solve this and has gone unused —
partly because it is too granular, and partly because ten of eleven boxes
had no summary-model key, so it was silently empty (fixed 2026-09-10,
bridge #272). Items (the tracker) give him decisions and tasks but no
narrative: nothing says "this is the piece of work, here is how it went,
here is where each step happened".

## Goal

A **mission** is the human-readable record of one piece of work
(task-sized to project-sized), owned by the journal and shared by every
agent and app of the same journal user:

- **Numbered** from the same per-user counter as items, so `#61` names
  exactly one thing across the whole tracker, GitHub-style.
- **Owns conversations and items.** A conversation belongs to at most one
  mission; spawned conversations inherit the parent's; related sessions
  can join. Items filed from a mission's conversation belong to the
  mission.
- **Milestones** are posted by the agent explicitly through a bridge tool.
  Each one is simultaneously an inline card in the transcript and a jump
  target: the marker event's own `seq` is the anchor, exactly as `item`
  markers already work.
- **Cadence is a floor, not a cap.** Dan's substantive inputs should
  *normally* get a milestone (skip typos, one-word answers,
  clarifications); the agent may post as many `progress` milestones as it
  likes. The point is to get back to his last input easily, not to limit
  the agent.
- **Closing is deliberate.** Nothing gets accidentally missed: an agent
  cannot close a mission over open items; only Dan can, and it is recorded.
- **Missions tab** in both apps; a mission page with milestones, open
  items and conversations; tapping a milestone opens its conversation at
  that point. The summaries *surface* retires; the `summary` event and its
  client mirror stay.

## Non-goals (v1)

- A "projects" umbrella above missions (the name is kept free for it).
- Automatic milestones from the journal or the summary model.
- Android and the web client (same spec, later).
- Old-client fallback text mirrors of milestone markers (items needed one
  because Dan had to see questions; a milestone is navigational only).
- Cross-mission moves of conversations; a conversation keeps its mission
  once joined (items can move, see `item_move`).
- Reordering missions; the list is sorted by activity.
- FTS indexing of milestones (search stays on `text`/`diff`).

## Decisions taken during brainstorming

| # | Decision |
|---|---|
| #23 | Any agent session creates a mission via a bridge tool; the coordinator later becomes the main caller with no data change. Spawned/related sessions join the parent's mission by default. |
| #25 | A mission owns its conversations **and** its items (`items.mission_id`, defaulted from the origin conversation, repointable, never passed by an agent). |
| #26 | Retire the summaries surface (iOS `SummariesSheet`, Mac `MacSummariesPanel`); keep the `summary` event and `summary_entry` mirror. The conversation title becomes the way into milestones. |
| #30 | The agent closes the mission. Named "missions". Closing over open items: items awaiting the user block the agent outright; items awaiting the agent must each be closed with a real resolution or moved to another mission; only the user may close with open items, recorded on the mission. |
| chat | "Everything should be numbered" — missions and milestones draw from `item_counters`, the same counter as items. |
| chat | Cadence: floor not cap (above). No bridge-side refusal of milestones. |
| #60 | An agent-independent "jump to my last message" control shipped separately (apple #202) — milestones are not the only way back to Dan's input. |
| #73 | Bridge tools, apps, rollout and testing sections below approved as written. |
| #74 | An explicit `mission_start` tool (title + goal) is the only way in. No auto-create: a milestone on a conversation with no mission is rejected and the agent is told to start one — it has far more context for naming the mission than its first milestone could carry. |

## Data model (matron-journal, `src/db.js`)

Append to the `SCHEMA` string with `CREATE TABLE IF NOT EXISTS`; new
columns on existing tables via the guarded `PRAGMA table_info` +
`ALTER TABLE` pattern, placed **between** the table-rebuild blocks
(`db.js:353-356`) so a rebuild cannot drop them. `PRAGMA user_version` is
not a migration counter and is not touched.

```sql
CREATE TABLE IF NOT EXISTS missions (
  id                     TEXT PRIMARY KEY,          -- 'ms_' + 16 hex
  user_id                INTEGER NOT NULL REFERENCES users(id),
  num                    INTEGER NOT NULL,          -- from item_counters, shown as #num
  state                  TEXT NOT NULL CHECK (state IN ('open','closed')),
  title                  TEXT NOT NULL,             -- ≤ 200 chars
  body                   TEXT NOT NULL DEFAULT '',  -- Markdown ≤ 32 KiB; standing description
  close_summary          TEXT,                      -- Markdown ≤ 32 KiB; set on close
  closed_by              TEXT CHECK (closed_by IN ('user','agent')),
  closed_over_open_items INTEGER NOT NULL DEFAULT 0,-- count of open items at a user-forced close
  origin_convo_id        TEXT NOT NULL,             -- the conversation that started it
  origin_device_id       INTEGER NOT NULL,
  created_by             TEXT NOT NULL CHECK (created_by IN ('user','agent')),
  idem_key               TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  last_milestone_at      INTEGER,                   -- list sort key
  closed_at              INTEGER,
  UNIQUE (user_id, num),
  UNIQUE (user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS missions_user_state ON missions(user_id, state, last_milestone_at);

CREATE TABLE IF NOT EXISTS milestones (
  id          TEXT PRIMARY KEY,                     -- 'ml_' + 16 hex
  mission_id  TEXT NOT NULL REFERENCES missions(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  num         INTEGER NOT NULL,                     -- from item_counters
  kind        TEXT NOT NULL CHECK (kind IN ('user_input','progress')),
  title       TEXT NOT NULL,                        -- ≤ 200 chars
  body        TEXT NOT NULL DEFAULT '',             -- Markdown ≤ 32 KiB
  convo_id    TEXT NOT NULL,                        -- conversation it was posted in
  seq         INTEGER NOT NULL,                     -- the milestone marker event's seq = the anchor
  device_id   INTEGER NOT NULL,
  created_by  TEXT NOT NULL CHECK (created_by IN ('user','agent')),
  idem_key    TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (user_id, num),
  UNIQUE (user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS milestones_mission ON milestones(mission_id, created_at);
CREATE INDEX IF NOT EXISTS milestones_convo   ON milestones(convo_id, seq);

-- guarded ALTERs
ALTER TABLE conversations ADD COLUMN mission_id TEXT;   -- NULL = no mission
ALTER TABLE items         ADD COLUMN mission_id TEXT;   -- NULL = no mission
CREATE INDEX IF NOT EXISTS conversations_mission ON conversations(mission_id);
CREATE INDEX IF NOT EXISTS items_mission         ON items(mission_id, state, awaiting);
```

### Semantics

- **Numbers.** `missions.num` and `milestones.num` are allocated from
  `item_counters` inside the create transaction with the same
  `INSERT … ON CONFLICT DO UPDATE SET next_num = next_num + 1 RETURNING
  next_num - 1` the items route uses. Uniqueness across the three tables
  follows from the shared counter; each table keeps its own
  `UNIQUE (user_id, num)` as a belt. There are no per-mission ordinals.
- **A conversation has at most one mission.** `conversations.mission_id`
  is set by: creating a mission from it, `join`, or inheritance at
  creation when `parent_convo_id` is set and the parent has a mission. It
  is never cleared or changed afterwards (v1).
- **Items follow their conversation.** On item creation
  `items.mission_id` = the origin conversation's `mission_id` (may be
  NULL). Whenever a conversation *gains* a mission, the journal repoints
  that conversation's items with `mission_id IS NULL` to it in the same
  transaction. `PATCH /items/:id` accepts `mission` (id, `#num`, or
  `null`) so an item can be moved or detached explicitly — never inferred
  from an agent's tool arguments beyond that.
- **Milestone anchor.** The milestone row and its `milestone` marker
  event are written in one request. The marker's `seq` is stored on the
  row and is the only anchor. If the marker cannot be appended the
  milestone is not created (the row is rolled back or deleted and the
  request fails 502): a milestone with no anchor is worse than none.
  Implementation: `append()` in `src/journal.js` is a synchronous
  better-sqlite3 transaction (a savepoint when nested), and
  `appendAndBroadcast` only adds the WS broadcast after it — so the
  milestone route allocates the number, calls `append()` for the marker,
  inserts the row with the returned `seq`, all inside one outer
  transaction, and broadcasts the frame after commit.
- **No mission, no milestone.** `POST /milestones` on a conversation with
  no mission is **409** `{blocked_by: 'no_mission'}`; nothing is written.
  The mission is named by the agent, deliberately, with the whole
  conversation as context — never inferred from a title or a first
  checkpoint (#74). The bridge renders the 409 as "this conversation has
  no mission — call mission_start(title, body) first, then post the
  milestone again", and the agent's own retry is safe under its
  idempotency key.
- **Closing.**
  - Caller is an agent (`who.kind === 'agent'`): if the mission has any
    open item with `awaiting='user'` → **409** `{blocked_by: 'user_items',
    items: [{num,title}]}`; else if any other open item → **409**
    `{blocked_by: 'agent_items', items: […]}` (close each with a real
    resolution or `item_move` it). Only then does it close with
    `closed_by='agent'`.
  - Caller is a device (the user): always allowed. If open items remain,
    `closed_over_open_items` = their count and the marker records the
    numbers. The items themselves stay open and keep their `mission_id`.
  - `close_summary` is required for both (≤ 32 KiB, may be short).
  - A closed mission accepts no new milestones (409) and no joins; items
    in it can still be commented on and closed as today.
- **Privacy sieve.** Same rule as items and `/search`: for agent callers,
  milestones, conversations and items whose conversation is private and
  not the agent's are filtered from mission reads; a mission whose
  *origin* conversation is invisible to the caller 404s.
- **Limits.** Title ≤ 200 chars, body/summary ≤ 32 KiB, ≤ 200
  conversations per mission. **No cap on milestones per mission** — the
  cadence is the agent's call. Over-limit → 400.

## HTTP API (matron-journal, `src/missions-http.js`)

Mounted like `src/items-http.js`. `:id` accepts a mission id (`ms_…`) or a
bare number; numbers resolve within the caller's user. Device and agent
credentials both work; `who.kind` drives the close rules. Every create
takes an `Idempotency-Key` header, namespaced `${deviceId}:${key}` into
`idem_key`; a replay returns **200** with the existing row (even if since
closed), a first write **201**.

| Route | Body / query | Returns |
|---|---|---|
| `POST /missions` | `{title, body?, convo_id}` | 201 mission. If `convo_id` already has a mission: 200 that mission with `existing: true`, nothing changed. Attaches the conversation, repoints its items. |
| `GET /missions` | `?state=open\|closed` (omit = both), `?since=<ms>` | `{missions:[…]}` with per-row counts: `open_items`, `needs_you` (open + awaiting user), `conversations`, `milestones`, `last_milestone` `{num,title,kind,created_at}`. Sorted `last_milestone_at DESC NULLS LAST`. |
| `GET /missions/:id` | | `{mission, milestones:[…] newest first, items:[open items], conversations:[{id,title,box,state}]}` |
| `PATCH /missions/:id` | `{title?, body?}` | 200 mission (409 if closed) |
| `POST /missions/:id/join` | `{convo_id}` | 200 mission; 409 if the conversation already has a different mission or the mission is closed. Repoints the conversation's items. |
| `POST /missions/:id/close` | `{summary}` | 200 mission, or 409 as in *Closing*. |
| `POST /milestones` | `{convo_id, title, body?, kind}` | 201 `{milestone, mission}`; 409 `{blocked_by: 'no_mission'}` if the conversation has none, 409 `{blocked_by: 'closed'}` if its mission is closed. |
| `GET /milestones?convo=<id>` | | `{milestones:[…]}` newest first — the apps' per-conversation view. |
| `PATCH /items/:id` | gains `mission: id \| "#num" \| null` | existing route; emits the item marker `updated`. |

Errors follow the items routes: 400 on shape/limits, 404 on unknown or
invisible, 409 on state conflicts, 502 when the marker append fails.

## Marker events (protocol, `docs/protocol.md`)

Two new event types written only by the journal from these routes. Neither
joins `AGENT_PUBLISH_TYPES` (no direct `publish`) nor `MESSAGE_TYPES`
(no unread counts, snippets or push). Old clients ignore unknown types.

```json
{ "type": "milestone",
  "payload": { "milestone_id": "ml_…", "num": 63, "kind": "user_input",
               "title": "Wired the journal migration", "body": "…",
               "mission_id": "ms_…", "mission_num": 61, "mission_title": "Missions & milestones",
               "by": "agent" } }
```
Appended to `convo_id`; **its own `seq` is the milestone's anchor**. It is
the inline card and the jump target.

```json
{ "type": "mission",
  "payload": { "mission_id": "ms_…", "num": 61, "title": "…",
               "action": "created" | "joined" | "updated" | "closed",
               "by": "user" | "agent",
               "open_item_nums": [64, 70] } }        // only on a user-forced close
```
Appended to the conversation that performed the action (`created`/`joined`
on that conversation; `updated`/`closed` on the origin conversation). Apps
use it only as an invalidation signal; it renders as a small inline notice
("🏁 Mission #61 closed").

## Agent tools (matron-bridge)

Same shape as the items tools: `server.tool(name, desc, zodObj, handler)`
in `ask-user.js` → POST to the bridge loopback `/missions/<op>` (added to
the regex allowlist in `index.js`) → `lib/missions-tools.js` handlers →
`lib/missions-client.js` (Bearer agent token, never throws, `status 0` =
unreachable → 502). Formatting in `lib/missions-format.js` so it is
testable without a journal. The bridge injects `convo_id` = the session's
journal conversation; the agent never passes one.

| Tool | Args | Journal call | Notes |
|---|---|---|---|
| `mission_start` | `title, body?` | `POST /missions` | Returns the mission `#num`. If the conversation already has a mission, returns it as "already in mission #N" and changes nothing (the route's `existing: true`). |
| `milestone_post` | `title, body?, kind: 'user_input' \| 'progress'` | `POST /milestones` | Returns `#num` and the mission `#num`. A `no_mission` 409 is rendered as "call mission_start first, then post again". |
| `mission_update` | `title?, body?` | `PATCH /missions/:id` on the conversation's mission | 404-as-text if the conversation has no mission. |
| `mission_join` | `num` | `POST /missions/:num/join` | Attach this conversation to an existing mission. |
| `mission_get` | `num?` | `GET /missions/:id` | Default: this conversation's mission. Milestones, open items, conversations — what the coordinator will read later. |
| `mission_close` | `summary` | `POST /missions/:id/close` | 409 bodies are rendered as text listing the blocking items and what to do ("close each with a resolution, or item_move it"). |
| `item_move` | `id \| num, mission: num \| null` | `PATCH /items/:id {mission}` | Added to `lib/items-tools.js`. |

`mission_start` is the only way in: name the work and state its goal in
`body` before the first checkpoint, so the mission page reads as a record
from its first line. There is no auto-create — a milestone with no
mission is refused with the instruction to start one.

`BRIDGE_CODEX.md` gets the raw-curl equivalents under the existing journal
base-URL and token discipline (read inside the request, never printed).

### Prompt section (`BRIDGE_CLAUDE.md`, "## Missions & milestones")

- A mission is the human-readable record of one piece of work; milestones
  are its checkpoints and each one is a link back to where it happened.
- Post a milestone with `kind: "user_input"` whenever an input from the
  user starts or redirects work. Skip typos, one-word answers and
  clarifications. The user's stated purpose is "to be able to go back to my
  last input easily".
- Post `kind: "progress"` milestones as often as they are useful — a
  landed PR, a diagnosis, a decision, a phase done. There is no upper limit;
  hours of unattended work should leave a readable trail.
- Start the mission with `mission_start` (title + goal) as soon as you know
  what the work is — usually right after the user's first substantive
  input. Milestones are refused until the conversation has a mission;
  name it yourself from what you know, then post the milestone again.
  Rename later with `mission_update` if the work changes shape.
- Close the mission (`mission_close` with a summary) when the work is done,
  not when the session ends. It refuses while items are open: close each
  with a real resolution, or `item_move` it to the mission it belongs to.
  Items awaiting the user block you outright — only they can clear those.
- Numbers are shared: `#63` may be an item, a mission or a milestone. Refer
  to any of them by number.

## Apps (matron-apple)

### Shared core (`MatronShared`)

- **Store migration v10** (`JournalStore.swift`): tables `mission` and
  `milestone` mirroring the journal rows (plus the list counts on
  `mission`), and `mission_id` on `item`. Record types in
  `JournalStore+Missions.swift` (`MissionRecord`, `MilestoneRecord`),
  read helpers `missions(state:)`, `mission(id:)`, `milestones(missionID:)`,
  `milestones(convoID:)`, `missionID(convoID:)`, streams via
  `ValueObservation` as the items store does.
- **`MissionsSync` actor** cloned from `ItemsSync`: full `GET /missions`
  on connect and on reconnect; `GET /missions/:id` on demand for a page
  and on a `milestone`/`mission` marker for that mission; the marker is
  only an invalidation signal. `ItemsSync` already refetches on an `item`
  marker, and the refetched row carries `mission_id`.
- **`MissionsAPI`** in the journal client (`JournalAPI+Missions.swift`),
  feature-detected like items (a 404 on `GET /missions` marks the server
  as unsupported and hides the tab).
- **View models**: `MissionsListViewModel` (open/closed sections, sort,
  badge counts, `isSupported`), `MissionDetailViewModel` (milestones
  newest first, `showOnlyUserInput` filter, open items awaiting-you first,
  conversations; `close(summary:)` for the user path with the
  "N items still open" confirmation).
- **Navigation**: `ChatViewModel.focusOrPark(seq:)` becomes public
  (`focus(seq:parkIfNeeded:)`), and `AppShellNavigation.openChat(_:)` /
  `openConversation(fromDecisions:)` gain an optional `focusSeq:` carried
  through the route so a milestone tap from any tab opens the
  conversation and lands on the marker after the first snapshot.
- **Number resolution**: a `#N` in item bodies, milestone bodies and chat
  resolves locally against `item`, `mission`, `milestone` in that order
  (they cannot collide) and links to the right detail.

### Missions tab

- iOS: `AppTab.missions` (`AppShellNavigation.swift`), tab order
  Coordinator · Missions · Decisions · Conversations, own `missionsPath`,
  `tabItem` + `tag` in `AppShellView.swift`. Mac: `MacNav.missions` in
  `MacNavColumn.swift`; the sidebar column shows the list, detail shows the
  page; the switch sites grow in the hoisted helpers in
  `MacChatListView.swift` (`sidebarStack`, `sidebarWidths(for:)`,
  `detailContent`, `navChanged(from:to:)`), never inline in `body` (CI
  type-checker budget).
- **List** (`DesignSystem/Missions/MissionRowView`): open missions sorted
  by latest milestone, closed in a collapsed "Closed" section. Row =
  `#num`, title, last milestone title + relative age, open-items badge
  (`NeedsYouBadge` accent when `needs_you > 0`), box chips of its
  conversations.
- **Page** (`MissionDetailView`): header (`#num`, title, state, standing
  body, close summary when closed); milestones newest first, each row =
  `#num`, kind glyph (person for `user_input`), title, body, time, and
  the conversation it lives in as a `SessionTag`; a toggle "My inputs
  only"; tap → `openChat(convoID, focusSeq: seq)`. Below: open items
  (awaiting-you first) → item detail; then conversations → chat. A user
  "Close mission" action with a summary field; when items are open it
  confirms "Close with N items still open?" and the mission records it.
- **Empty states**: "No missions yet — an agent starts one with
  mission_start" / unsupported server hides the tab.

### Transcript and title

- `TimelineItem.Kind.milestone(MilestoneEvent)` from the marker; renders
  as an inline card (`MilestoneCard`) with the kind glyph, `#num`, title,
  body; tap → mission page. The `mission` marker renders as a one-line
  notice.
- **Title tap** on a conversation opens its mission page (iOS: pushed;
  Mac: the detail column switches to it with a back affordance). With no
  mission the title is not a button. This replaces the summaries sheet
  and popover; `SummariesSheet.swift`, `MacSummariesPanel.swift` and the
  popover plumbing in `MacChatToolbar` are deleted. `summary_entry`, its
  migration and ingest stay untouched.

### Decisions tab

Rows gain the mission `#num` as a chip when the item has one, nothing
else changes.

## Error handling

- **Journal**: 400 shape/limits, 404 unknown/invisible, 409 state (closed
  mission, milestone with no mission, second mission for a conversation,
  close blocked), 502 marker
  append failure (milestone not created). All 409s carry a machine-readable
  `blocked_by` and the item list where relevant.
- **Bridge**: tools never throw; a 409 becomes a text result the agent can
  act on ("blocked by #64 (awaiting user), #70 (awaiting agent)…");
  `status 0` → "journal unreachable, try again". Nothing is retried
  silently; idempotency keys make the agent's own retry safe.
- **Apps**: sync failures keep the cached tables and show the same offline
  note the tracker uses; a milestone tap whose conversation is not cached
  falls back to opening the conversation at the tail. A `focusSeq` that no
  longer exists lands on the nearest earlier row (existing `focus`
  fallback).

## Testing

- **Journal** (vitest): shared counter across items/missions/milestones;
  milestone on a conversation with no mission is 409 `no_mission` and
  writes nothing; inheritance on spawned conversation creation; item
  repointing on create/join;
  `PATCH /items mission`; close blocked by user items, by agent items,
  allowed for a device with `closed_over_open_items` recorded; closed
  mission rejects milestones and joins; idempotency replay 200 on both
  creates; marker seq equals the milestone's `seq`; append failure yields
  502 and no row; privacy sieve; conformance fixtures for both marker
  types.
- **Bridge** (vitest): each tool against a fake client (success, 409
  rendering, 502, `status 0`); `missions-format` snapshots; the allowlist
  regex admits only the new ops; prompt file contains the section.
- **Apps** (`swift test` + `xcodebuild`): v10 migration up from v9 with
  existing items; `MissionsSync` with a fake API (connect fetch, marker
  invalidation, unsupported 404); list VM sort/sections/badges; detail VM
  filter and awaiting-first order; navigation carries `focusSeq` and the
  parked focus fires; `SessionTag`/row/page snapshots (skip locally with
  `MATRON_SKIP_SNAPSHOT_TESTS=1`); Mac tests only with
  `TEST_RUNNER_MATRON_APP_SUPPORT_OVERRIDE`.
- **End-to-end** on one box before the fleet deploy: a real session posts
  both kinds of milestone, an item filed in it shows on the mission page,
  the milestone tap lands on the marker from the Missions tab, agent close
  is blocked by an open item, user close records it.

## Rollout

One spec, three plans under `docs/superpowers/plans/`, executed in order
so nothing reads a shape that is not there yet. Everything is additive:
old bridges and apps keep working against a migrated journal.

1. **matron-journal** — tables + guarded columns, routes, marker events,
   protocol doc. Back up the DB, deploy to the journal box, verify
   `GET /missions` answers before step 2.
2. **matron-bridge** — client, tools, loopback allowlist, `item_move`,
   prompt sections in both prompt files. Fleet deploy with the existing
   script; dan-mac last (it kills this session).
3. **matron-apple** — (a) v10 migration + `MissionsSync` + API; (b)
   Missions tab, list, page, navigation; (c) transcript card, title tap,
   retire the summaries UI; (d) Decisions chip. Android follows the same
   spec later.
