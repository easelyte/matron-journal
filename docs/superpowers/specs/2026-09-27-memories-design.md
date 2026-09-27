# Memories — a journal-backed memory for the Coordinator and every agent

Date: 2026-09-27. Status: draft for review.
Mission #3778. Dan chose "B only" on item #3787 (over a bridge carve-out that
would have let the Coordinator write to its Claude Code memory dir).

## Problem

The Coordinator (spec 2026-09-23 coordinator redesign) runs with the
file-editing tools switched off, so it cannot write to Claude Code's
auto-memory directory. Rules Dan gives it ("avoid eric and fatima",
"Fable-maxed boxes can still use Opus 5.5") are lost at the next
compaction or respawn. Today they are parked in decision items (#3677,
#3216), which the Coordinator has to remember to read.

Even with a carve-out, a file under `~/.claude/projects/<slug>/memory/`
lives on one box and moves with the Coordinator's workdir. The Coordinator
can be reassigned to a conversation on any box.

## Goals

1. An agent can **save, list, read and delete memories** through MCP tools,
   and the memories survive compaction, respawns, box moves and bridge
   restarts.
2. The Coordinator **starts every session knowing its memories**: the
   index is part of its instructions at spawn, the way Claude Code injects
   `MEMORY.md`.
3. Dan can **see, edit and delete** memories in the apps (web, Apple,
   Android), live.

## Non-goals (v1)

- Search indexing of memories (they are few and short; `memory_list` is
  the search).
- Per-conversation or per-project memories. Memories are per user.
- Cross-user (shared visibility) memories.
- Attachments, comments, history. A memory is one row that is overwritten.
- Push notifications or wake-on-message for memory changes.
- Replacing Claude Code's own memory dir for ordinary sessions. Ordinary
  sessions keep it; the journal memory is the *user's* memory, shared by
  every agent.

## Shape

A memory mirrors the Claude Code memory-file convention the Coordinator
already knows from its system prompt (name, description, type, body), so
the same instructions apply to both.

```
{
  id:               "me_<16 hex>",
  name:             "avoid-eric-and-fatima",          // ^[a-z0-9][a-z0-9-]{0,63}$, unique per user
  type:             "feedback",                       // user | feedback | project | reference
  description:      "Never start sessions on eric or fatima; Dan reserves them.",  // ≤200 chars, one line
  body:             "**Why:** …\n**How to apply:** …", // markdown, ≤8192 bytes, may be empty
  origin_convo_id:  "de145271-…" | null,              // the conversation that first saved it
  origin_device_id: 65 | null,                        // the device that first saved it
  created_by:       "user" | "agent",
  updated_by:       "user" | "agent",
  created_at:       1790550000000,
  updated_at:       1790550000000
}
```

`description` is the line the Coordinator sees at spawn, so it must be the
actionable one-liner. `body` holds the why and the how, read on demand.

Limits: at most **200 memories per user** (a `PUT` that would create the
201st is 409 `too_many`; updates are never refused). Name, description
and body caps as above; a bad value is 400 `bad_request`.

## Journal

### Schema (`src/db.js`)

```sql
CREATE TABLE IF NOT EXISTS memories(
  id               TEXT PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  name             TEXT NOT NULL,
  type             TEXT NOT NULL CHECK(type IN ('user','feedback','project','reference')),
  description      TEXT NOT NULL,
  body             TEXT NOT NULL DEFAULT '',
  origin_convo_id  TEXT,
  origin_device_id INTEGER,
  created_by       TEXT NOT NULL CHECK(created_by IN ('user','agent')),
  updated_by       TEXT NOT NULL CHECK(updated_by IN ('user','agent')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, updated_at);
```

Added to the base `CREATE TABLE IF NOT EXISTS` block: a fresh database and
an upgraded one get the same table, no ALTER needed. `origin_convo_id` is
not a foreign key (a deleted conversation must not take the memory with
it), same stance as `user_settings.coordinator_convo_id`.

### Module split

`src/memories.js` (pure: validation, list/get/upsert/delete on the db,
privacy sieve) and `src/memories-http.js` (auth, routes, marker append and
broadcast) — the items.js / items-http.js split. `src/memories-marker.js`
is not needed; the payload builder lives in memories-http.js.

### Routes (Bearer, either device kind)

| Route | Body / query | Response |
|---|---|---|
| `GET /memories` | none | 200 `{memories:[…]}`, ordered by `name`. At most 200 rows, so no paging. |
| `GET /memories/:key` | `:key` = `me_…` or the name | 200 `{memory}`; 404 |
| `PUT /memories/:name` | `{description, body?, type?, convo_id?}` | 201 `{memory}` when created, 200 `{memory}` when updated; 400 `bad_request`; 409 `too_many`; 404 (agent `convo_id` not writable by this agent, see below) |
| `DELETE /memories/:key` | none | 200 `{memory}` (the row that was deleted); 404 |

`PUT` is the only write. It is an upsert by name: the same name from any
device overwrites description, body and type and bumps `updated_at` /
`updated_by`; `origin_*` and `created_*` are set once at creation. Omitted
`body` on an update **clears** it (a PUT is the whole memory; a client that
wants to keep the body sends it back). Omitted `type` defaults to
`feedback` on create and is kept on update. This makes retries free, so
there is no `Idempotency-Key`.

`convo_id` is optional and only meaningful from an agent: the bridge sends
the session's conversation so the memory records where it came from and
the marker lands on its timeline. It goes through `authorizeAgentWrite`
like an item create; an agent naming a conversation it does not own or
has not joined gets 404 `not_found` (never 403, the items rule). A client
never sends it; a client `PUT` with `convo_id` is 400.

`:name` in the path is validated with the same regex as the body rules; an
invalid name is 400, not 404.

### Privacy (`src/privacy.js` predicates)

A memory saved from a **private** agent device is invisible to an ordinary
(filtered) agent: absent from `GET /memories`, 404 on `GET`, `PUT` and
`DELETE` by key. Clients and private agents see everything. The `PUT` by a
filtered agent on a name that exists but is hidden is a 404, not a second
row: `UNIQUE(user_id, name)` holds, and 404 does not reveal the name is
taken beyond what a failed create would (accepted, same trade-off as
`/coordinator` reading null).

### Marker event

Every successful `PUT` and `DELETE` appends a `memory` event, after the
row's transaction has committed (the items rule: a broadcast never
advertises a write that then rolls back; a marker append that itself fails
is logged and swallowed).

```json
{ "seq": 123, "convo_id": "…", "ts": 1790550000000,
  "sender": "user:dan" | "agent:bev", "type": "memory",
  "payload": { "memory_id": "me_…", "name": "avoid-eric-and-fatima", "type": "feedback",
    "description": "Never start sessions on eric or fatima; Dan reserves them.",
    "action": "saved" | "deleted", "created": true | false, "by": "user" | "agent" } }
```

Where it is appended:

1. The memory's **origin conversation** when the write came from an agent
   with a `convo_id` (its timeline shows what it saved).
2. The user's **Coordinator conversation** (`user_settings.coordinator_convo_id`)
   when one is set and it is not already the conversation in (1). This is
   what lets the Coordinator's bridge refresh its cached index the moment
   anything changes, whichever device changed it.

A client write with no Coordinator set appends nothing; the app refetches
after its own write anyway. Two conversations means two events with the
same `memory_id`; apps dedupe on it (they refetch the list on any marker,
batched, as they do for items).

Crossing the privacy boundary: when the origin device is private and the
target conversation is not private-owned, the marker carries `memory_id`
and `action` only (no `name`, `type`, `description`) — `markerTitleAllowed`
in `src/privacy.js`, the missions rule.

`memory` is not in `MESSAGE_TYPES` (no unread, no snippet), not in
`AGENT_PUBLISH_TYPES` (a bare publish is `bad_request`), never pushes and
never wakes. There is no old-client text fallback: pre-memory clients
ignore unknown event types.

### Docs

`docs/protocol.md` gains a "Memories" section between "Coordinator" and
"Missions & milestones"; `src/help.js` gains the matching digest.

### Tests (`test/memories.test.js`, `test/memories-http.test.js`)

Unit: validation table (names, description, body byte cap, type), upsert
create-vs-update semantics, cap at 200, privacy sieve, delete returns the
row. HTTP: client and agent auth on every route, 201/200 on create/update,
404 on a filtered agent reading a private-origin memory, the marker on the
origin conversation and on the Coordinator conversation (and only once
when they coincide), title stripping across the privacy boundary, the ws
frame reaching a client, `memory` refused as an agent publish type, and
`/help` mentioning the routes.

## Bridge

### Tools (`ask-user.js` → loopback → `lib/memory-tools.js` → `lib/memory-client.js`)

Same layering as items and missions: the MCP tool posts to the bridge's
loopback API, index.js mounts handlers from `lib/memory-tools.js`, which
call the journal through `lib/memory-client.js` (a `createItemsClient`
clone with `list/get/save/remove`). Every session gets the tools.

| Tool | Args | Does |
|---|---|---|
| `memory_save` | `name`, `description`, `body?`, `type?` | `PUT /memories/:name` with the session's `convo_id`. Answers `Saved memory \`name\` (created)` or `(updated)`. |
| `memory_list` | none | `GET /memories`; renders the index (name, type, description, updated). |
| `memory_get` | `name` | `GET /memories/:name`; renders the full memory. |
| `memory_delete` | `name` | `DELETE /memories/:name`. |

Tool descriptions say what the memory is for: durable rules and facts the
user gives about how they want their agents to work, shared by every
session and read by the Coordinator at spawn. Not for project facts an
ordinary session should keep in its own Claude Code memory dir. Errors map
as the items tools do: 0 → `journal unreachable`, 404 on the collection →
"this journal does not have the /memories routes yet — deploy the journal
update".

### The index at spawn (`lib/memory-lookup.js`)

`createMemoryLookup({ baseUrl, token })` is the `createCoordinatorLookup`
pattern: a cached `GET /memories`, never throws, never logs the token.
`refresh({ force })` is forced on every `hello_ok`, on every `coordinator`
event and on every `memory` event the bridge receives on any of its
conversations; a throttled refresh is kicked behind every spawn. `snapshot()`
gives `{ known, memories }`.

`renderMemoryBlock(memories)` (pure, in `lib/coordinator.js`) produces the
text appended after the Coordinator block:

```
## Your memories

These are the user's standing rules and facts, shared by every agent and
saved with memory_save. Follow them. Call memory_get for the full note,
memory_save to add or update one (same name overwrites), memory_delete to
retire one.

- avoid-eric-and-fatima (feedback): Never start sessions on eric or fatima; Dan reserves them.
- fable-maxed-boxes-can-use-opus (feedback): A box at 100% Fable can still take Opus 5.5 sessions.
```

Empty list: the heading and the paragraph only, ending "You have no
memories yet." The block is capped at 16 KB; beyond that it lists what
fits and ends "… N more — call memory_list." Unknown (journal never
answered): the block says the memories could not be loaded and to call
`memory_list`.

`claudeCoordinatorArgs`, `codexCoordinatorOptions` and
`coordinatorTurnText` take a `memoryBlock` and append it after the
Coordinator block, so a spawn, a respawn and a live `assigned` turn all
carry it. Ordinary sessions get nothing appended.

### Instructions

`BRIDGE_COORDINATOR.md` gains "Remember what the user tells you": when the
user states a rule about how they want work run (which boxes to avoid,
which model to use, how to report), save it with `memory_save` at once,
one memory per rule, and confirm in one line. `BRIDGE_CLAUDE.md` and
`BRIDGE_CODEX.md` mention the four tools in a short paragraph.

### Tests

`test/memory-lookup.test.js`, `test/memory-tools.test.js`,
`test/memory-client.test.js` (the items/missions test shapes),
`test/coordinator.test.js` additions for the block rendering and the
`memoryBlock` plumbing, `test/coordinator-wiring.test.js` additions pinning
the index.js wiring (lookup constructed on the journal base, refreshed on
hello_ok / coordinator / memory events, passed to all three builders).

## Apps

Each app gets a **Memories** view beside the tracker: a list (name,
type, description, when updated), a detail with the body rendered as
markdown, edit (description, body, type) and delete, and a new-memory
form. Writes are `PUT`/`DELETE`; a `memory` marker refetches the list
(batched like item markers). Web first (matron-web `TrackerPane` gets a
third switch: Missions / Inbox / Memories), then Apple and Android on
dan-mac, each its own PR against the same routes.

## Rollout order

1. Journal PR merged and deployed (the bridge tools answer "routes not
   deployed" until then; nothing else breaks).
2. Bridge PR merged and rolled out box by box when no session is mid-turn
   (POST `/sessions` on the loopback API reports `busy`).
3. The Coordinator saves the two rules from #3677 as its first memories.
4. Web, Apple, Android PRs.

## Open points settled here

- **Every agent, not only the Coordinator, can save.** A rule Dan gives
  any session is worth keeping, and the journal has no notion of "the
  Coordinator's device". Only the Coordinator gets the index injected.
- **Upsert by name, not create/patch.** "Update rather than duplicate" is
  the Claude Code memory rule; a single PUT makes it the only path.
- **Description is the injected line; body is on demand.** Keeps the
  injected block small and makes agents write actionable one-liners.
- **Two markers (origin + Coordinator).** The cheapest way to keep the
  Coordinator's bridge current without a second subscription channel.
