# Memory scopes — global, coordinator and repo:<name>

**Status:** approved by Dan, 1 Oct 2026 (tracker question "Memory scopes: Coordinator-only and per-repo, or Coordinator-only for now?", answered "Do both"). Mission 5790.
**Repos:** matron-journal (the `scope` column, validation, the marker), matron-bridge (the filter at spawn, `scope` on `memory_save`, `all` on `memory_list`, the instructions).
**Related:** [memories](2026-09-27-memories-design.md), [Coordinator routines](2026-10-01-coordinator-routines-design.md) (the pattern this follows: journal PR 108, bridge PR 339).

## Why

Every memory went to every session. A yearbook-infra session carried yearbook-app's merge-train and promo rules; an ordinary working session carried the Coordinator's compaction, usage-limit and disk rules, and sometimes acted on them. The rules are right; the audience was too wide.

## Shape

Each memory gets a **scope**:

| Scope | Who gets it at spawn |
|---|---|
| `global` | every session — the default, and what every memory saved before the column existed is |
| `coordinator` | the user's Coordinator only |
| `repo:<name>` | sessions whose working directory is a checkout of that repo |

A session is given the global memories, the memories for its repo, and the coordinator memories when it is the Coordinator. Its instructions say which scopes those are. The Coordinator's `memory_list` shows every memory; an ordinary session's lists the ones that apply to it, with the count of the rest and an `all: true` option to see them.

`<name>` is the bare repo name (`yearbook-app`, not `github.com/yearbook/yearbook-app`): one memory per repo regardless of host or fork, and it is what a session can tell from its working directory without a network call.

## Journal

- `memories.scope TEXT NOT NULL DEFAULT 'global'`, added by an in-place `ALTER TABLE` for a live database; every pre-migration row is `global`.
- `scope` is validated as `^(global|coordinator|repo:[A-Za-z0-9_.-]+)$`, at most 128 characters (the repo-name characters are those of `src/repo-identity.js`'s canonical form). `PUT /memories/:name` takes `scope?`: `global` on create when omitted, kept on update when omitted (the `type` rule).
- `GET /memories` and `GET /memories/:key` show it. The `memory` marker payload carries it next to `type` (and, like `type`, not across the privacy boundary).
- No filtering in the journal: the audience of a memory is a property of the *session*, which only its bridge knows. Clients see everything, as before.

## Bridge

- **Repo name** (`lib/repo-name.js`): the last path segment of `git -C <workdir> remote get-url origin` with `.git` stripped; failing that, the basename of `git rev-parse --show-toplevel`; failing that, the basename of the workdir. Synchronous (createSession is), bounded, never throws, cached per workdir for the life of the process (a remote does not change under a running bridge; a cache miss is one git call). Compared case-insensitively.
- **The block at spawn** (`renderMemoryBlock(snapshot, { coordinator, repo })`): the memories whose scope is `global`, `repo:<this repo>`, or `coordinator` when the session is the Coordinator. A memory with no `scope` (an older journal) is global. A scope the bridge does not recognise is left out of an ordinary session's block and kept in the Coordinator's. The intro line names the scopes shown ("the global memories, the memories for repo:yearbook-app, and the coordinator memories") and the count left out; each line carries its scope. The three spawn builders and the live `assigned` turn pass the session's role and workdir.
- **Tools:** `memory_save` takes `scope?` (validated like the journal, with the reason); the ack names it. `memory_list` takes `all?: boolean`; without it an ordinary session gets its own scopes plus a trailing line counting the rest, the Coordinator always gets everything. `memory_get` shows the scope.
- **Instructions:** the memory paragraph in `BRIDGE_CLAUDE.md`, `BRIDGE_CODEX.md` and `BRIDGE_COORDINATOR.md` says what the scopes are and when to pick each (a rule only the Coordinator acts on → `coordinator`; a rule about one repo's workflow → `repo:<name>`; everything else global).

## Rollout order

1. Journal PR merged and deployed (an older bridge ignores `scope` and keeps giving every memory to every session — nothing breaks, nothing changes).
2. Bridge PR merged and rolled out box by box.
3. Re-scope the existing memories as listed on the mission: the Coordinator's seven to `coordinator`, yearbook-app's five to `repo:yearbook-app`, the rest stay global.

## Not done here

The apps on hand (Apple, Android) have no memories view yet; when one is built it shows and edits `scope` with the same PUT.
