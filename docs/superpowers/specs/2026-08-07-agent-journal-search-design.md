# Agent journal search — agents can look up the backstory

**Status:** design, awaiting approval
**Repos:** matron-journal (index + API), matron-bridge (MCP tools), matron-apple / matron-android (phase 3 only)
**Related:** [agent chat consent](2026-08-07-agent-chat-consent-design.md), [agent visibility & privacy](2026-08-07-agent-visibility-privacy-design.md)

## Why

An agent can see which of its siblings are alive (`agent_roster`) and ask to talk to one
(`agent_chat_start`). It cannot look anything up. Ask "what happened with the SQLCipher
attempt" or "why did we key the chat destination to room id" and the agent has no way to
find out — the answer is sitting in the journal, in a conversation from three weeks ago,
and nothing can reach it.

## What exists today, and why none of it helps

Server-side, `events` is `(user_id, seq, convo_id, ts, sender, type, payload, blob_ref,
idem_key)` with **no full-text index**. The only read path is
`GET /convo/:id/messages?before_seq=&limit=`, paging backwards through one conversation.

The search in the apps is entirely **client-side**: each app builds a local FTS5 index by
backfilling every room (`MatronShared/Sources/Search/`, `SearchBackfill.swift`). That index
lives on the phone and the Mac. An agent talks to the server, so it cannot see it.

So this is a new journal capability, not a bridge tool wrapping something that already
exists.

## Shape

Two tools.

- `journal_search(query, limit?)` — ranked hits: conversation title, sender, timestamp,
  highlighted snippet, and a flag for whether that conversation's agent is currently live.
- `journal_context(convo_id, around_seq, limit?)` — the messages either side of a hit.

Search alone does not answer "why did we do this". The reasoning is spread across an
exchange: an objection, a counter, a decision three messages later. Finding the right spot
and being unable to read around it would locate the answer without delivering it.

## Scope of the index: prose only

Indexed:

| type | text |
|---|---|
| `text` | `payload.body` |
| `diff` | `payload.diff` ?? `payload.snippet` |

Not indexed: `tool_output`, `prompt`, `file`, `image`, `permission_request`,
`session_status`, and everything else.

This mirrors the apps' `searchableBody` rule minus tool output. Excluding tool output is
partly retrieval quality — command output is noise when the question is why a decision got
made — and partly that it is where credentials land. Two retention behaviours already
limit that exposure and are worth recording because they also explain why the index cannot
drift:

- `runExpireLogs` purges tool output marked `live_log: true` after 24h
  (`MATRON_TOOL_LOG_TTL_HOURS`), deleting the blob and tombstoning the payload.
- `runOffload` moves older non-`live_log` tool output to a blob after 30d, leaving a
  snippet inline.

Both touch `tool_output` only, which is not indexed — so retention can never invalidate an
indexed row.

## The index is append-only

Two facts confirmed in the current code:

- Events are written with a plain `INSERT` (`src/journal.js:93`) — never `INSERT OR
  REPLACE`. That matters: `REPLACE` skipping a delete trigger is exactly what corrupted the
  app-side external-content FTS index and needed fixing in matron-apple #106.
- There is no `DELETE FROM events` anywhere. The only `UPDATE`s are the two retention
  paths above.

So a prose-only index needs an insert path and nothing else. No update trigger, no delete
trigger, no tombstones, no reconciliation. This should be stated in the code, because it is
the kind of invariant a future change quietly breaks.

## Schema

```sql
CREATE TABLE search_messages(
  rowid     INTEGER PRIMARY KEY,
  user_id   INTEGER NOT NULL,
  convo_id  TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  sender    TEXT NOT NULL,
  body      TEXT NOT NULL,
  UNIQUE(user_id, seq)
);
CREATE INDEX idx_search_messages_convo ON search_messages(convo_id, seq);

CREATE VIRTUAL TABLE search_fts USING fts5(
  body,
  content='search_messages',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER search_messages_ai AFTER INSERT ON search_messages BEGIN
  INSERT INTO search_fts(rowid, body) VALUES (new.rowid, new.body);
END;
```

The same content-table shape the apps use, which is battle-tested including the corruption
fix. FTS5 availability confirmed: `better-sqlite3` ^11 with SQLite 3.49.2 has it compiled
in.

Deliberately no delete or update trigger — see above. If a delete path is ever added to
`events`, this schema needs revisiting, and the migration comment should say so.

## One indexable-body function

```js
export function indexableBody(type, payload) // -> string | null
```

Called by **both** the live append path in `journal.js` (inside the existing transaction,
next to the `MESSAGE_TYPES` branch) and the backfill migration. One function, two callers.

This copies `searchableBody` from the app side, and copies it for a reason: the apps have
three index feeders and needed a single source of truth to stop them drifting. Two feeders
drift just as easily as three.

Application-level rather than a SQLite trigger on `events`: there is exactly one insert
site, the logic needs `json_extract` gymnastics in SQL that read poorly, and a JS function
is directly testable.

## Backfill

A versioned migration walking `events` in batches, inserting every row for which
`indexableBody` returns non-null.

- Idempotent and resumable via `INSERT OR IGNORE` on `UNIQUE(user_id, seq)`. **`OR IGNORE`,
  never `OR REPLACE`** — the latter is the exact corruption trap named above.
- Batched with progress logging. The production database has not been sized for this; the
  migration should log rows processed so a long run is visibly progressing rather than
  apparently hung.
- Runs at startup like other migrations. Search returns partial results until it finishes,
  which is acceptable and self-healing.

## API

### `GET /search`

```
GET /search?q=<query>&limit=<n≤50>&convo_id=<optional>
→ { hits: [ { convo_id, title, seq, ts, sender, snippet, live } ] }
```

- Scoped `WHERE search_messages.user_id = ?` from the authenticated device. Needs a test
  that user A's query cannot match user B's text — the same class of cross-user oracle
  Bugbot caught in the Phase 2 room gate.
- `snippet` via FTS5 `snippet()` with highlight markers.
- `live` is true when the conversation's `session_state = 'running'`.
- Ranked by FTS5 `bm25()`, tie-broken by `ts DESC`.

**Query sanitisation.** Raw FTS5 `MATCH` syntax throws on input a human would type — an
unbalanced quote, a bare `*`, a stray `NEAR`. A search for `don"t` must return 400, not a
500 with a SQLite error in it. The safest treatment is to quote each term and join, giving
an implicit AND over literal terms, and reject anything that still fails to parse.

### `GET /convo/:id/messages?around_seq=&limit=`

An `around_seq` mode on the existing endpoint, returning `limit/2` events either side.
Mutually exclusive with `before_seq`; supplying both is a 400.

For a client, reuses the endpoint's existing authorisation unchanged — including its
deliberate 404-not-403 for an unauthorised conversation, so a caller cannot probe which
conversations exist. For an agent, authorisation resolves per the two-regime rule in
"Locked decisions" below: `before_seq` keeps the Phase-2 gate, `around_seq` opens the
conversation but filters the response to `indexableBody`-visible events.

## Bridge tools

`journal_search` and `journal_context` in `ask-user.js`, alongside the eight existing
`agent_*` tools, proxying to the bridge API like every other tool there.

**Display.** Tool calls already render into the chat. `formatSubagentToolBody` maps known
tools to a line and falls back to `🔧 Name`; the parent path has its own indicator. Both
need a case:

```
🔍 journal: "why did we drop SQLCipher"
📖 Battery pass — around #4128
```

**The live-agent nudge.** Hits flagged `live` are labelled, and the result appends a line
pointing at `agent_chat_start`: that agent is working now, ask it. Reading a live
conversation stays possible — "what happened with X" is often about work in flight — but
the obvious next move becomes talking to the agent rather than reading over its shoulder.
Blocking it would break the case the feature is most useful for.

## Phasing

1. **Journal** — index, backfill, `/search`, `around_seq`.
2. **Bridge** — the two tools and their display lines.
3. **Apps** — `matron://convo?id=…&seq=…`, alongside the existing `matron://link`, so a
   citation is tappable and lands on the right message.

Phase 3 is deliberately last and separable: it is three platforms plus seq-anchored
scrolling, and on iOS and Mac it rides an App Store cycle. Phases 1–2 are useful the day
they deploy, with citations rendering as plain text ("Battery pass, 6 Aug") until then.

## Testing

- `indexableBody` per event type — including that `tool_output` returns null, which is the
  privacy property.
- Append indexes `text` and `diff` and skips everything else, in the same transaction.
- Cross-user isolation on `/search` and on `around_seq`.
- Malformed FTS queries → 400 with a useful message, not 500.
- Backfill is idempotent (running twice changes nothing) and resumable (interrupt and
  re-run reaches the same state).
- Retention rewriting a `tool_output` payload leaves the index untouched.
- `around_seq` at both ends of a conversation returns short, not an error.
- `before_seq` + `around_seq` together → 400.
- `live` reflects `session_state`.

## Not doing

Semantic or vector search. Cross-user search. Any agent write path into history — search is
read-only. Indexing tool output. Re-implementing the app-side index against the new
endpoint (worth doing later: it would fix a freshly-linked device being unable to search
until it has backfilled everything locally, but it is not this spec).

## Open questions

1. ~~**Diffs in the index?**~~ **Resolved: included.** See "Locked decisions" below (decision
   2) — "what did we change to fix X" is a real question, and dropping them later is a
   one-line change to `indexableBody` if it turns out to leak too much.
2. **Whether phase 3 waits for a later App Store cycle** or ships with the rest.

## Locked decisions (2026-08-08 planning)

Made while turning this spec into an implementation plan
(`docs/superpowers/plans/2026-08-08-agent-journal-search.md`); folded back in here so the
spec and the shipped behaviour don't drift apart.

1. **Agent context access resolves into two regimes, not one.** This spec's API section
   originally said `around_seq` "reuses the endpoint's existing authorisation unchanged" —
   but the endpoint also carries the Phase-2 agent gate (`authorizeAgentWrite`) that 404s
   any conversation an agent doesn't manage or hasn't joined, which would make context reads
   impossible for exactly the hits `/search` returns. Resolution: in `around_seq` mode, an
   agent may read a conversation it doesn't manage, but the response is filtered to events
   where `indexableBody(type, payload)` is non-null (text + diff prose — exactly the indexed
   set, one shared rule with the index feed and the backfill). An agent's `around_seq` on a
   conversation it DOES manage, and everything a client does in either mode, is unchanged.
   `before_seq` mode keeps the tightened Phase-2 gate exactly as it is today.
2. **Diffs stay in the index** (resolves open question 1). "What did we change to fix X" is
   a real question worth answering. Dropping diffs later, if the leak risk proves worse than
   the retrieval value, is a one-line change to `indexableBody`.
3. **Backfill cursor is a one-row table, not a checkpoint file or a full re-scan.**
   Resumability is `INSERT OR IGNORE` (never `OR REPLACE`) plus a one-row
   `search_backfill_state` table storing the last scanned `events.rowid` — a restart resumes
   where it left off, and a completed backfill costs one row read per boot rather than a full
   table scan. Any event appended after the schema exists is indexed by the live path, so the
   cursor can never miss a row.
4. **`/search` is open to both device kinds**, not user-scoped-to-agents-only as an earlier
   reading of this spec might imply. Clients may use it later; the agent-visibility/privacy
   plan is where agent-caller-specific filtering gets layered on top, not this one.
5. **Snippet highlight markers are `**`…`**`** (markdown bold) — both the bridge's agent
   surfaces and the apps already render markdown, so no new rendering convention is needed
   on either side.
