# Projects + conversation↔mission history (journal half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a conversation hold many mission links (one current, the rest "also on" or ended, with history recovered by a one-time backfill), stop counting sub-chats toward the 200-conversation cap, and add a `projects` object above missions with server-computed activity (`running`/`waiting`/`idle`/`quiet`) and per-project rollups.

**Architecture:** A new `mission_conversations` link table becomes the source of truth for "which conversations belong to which mission". `conversations.mission_id` stays as the *current* pointer, so old readers keep working. Low-level link SQL and the backfill live in a new `src/mission-links.js`. `src/missions.js` keeps the pure mission logic (join, leave, reads, activity), `src/missions-http.js` the routes and markers. Projects get the same split: `src/projects.js` (pure) and `src/projects-http.js` (routes), mounted in `src/http.js`. Activity is computed per caller inside the existing `countsSql` / `sharedCountsSql` subqueries, so the privacy sieve already applied to counts also applies to activity.

**Tech Stack:** Node ≥20 ESM, better-sqlite3, `node:test` + `node:assert/strict`. Run one file with `node --test --test-timeout=30000 test/<file>.js`. Run the whole suite with `npm test`, which is `node --test --test-timeout=30000 'test/**/*.js'`. No new dependencies.

**Spec:** `/Users/danbarker/Dev/matron-apple-projects-spec/docs/superpowers/specs/2026-09-30-projects-and-mission-links-design.md` (matron-apple PR #276). This plan covers §3, §4 and §7 for the journal only. §5 (bridge) and §6 (apps) are other plans. Background: `docs/superpowers/specs/2026-09-10-missions-milestones-design.md` in this repo.

## Global Constraints

- Name: **Project** (Dan, Q1). Ids `pj_…` (`newId('pj')`). Numbers come from the shared per-user counter (`nextNum`, the one items/missions/milestones use), so `/lookup` and `#N` resolve projects too.
- One project per mission, or none (Q2): `missions.project_id` is a single nullable column.
- **Any** agent may create a project, file a mission into one, or edit its title/body/status (Q3). **Only the user or the user's Coordinator** may close or merge one; any other agent gets `403 {error:'forbidden', detail:'not_coordinator'}`.
- Project status: "Status rules are copied from mission status (1–600 chars)". It is a written paragraph plus server-derived counts (Q4).
- Many active links per conversation, exactly one or zero current (Q6). `conversations.mission_id` is the current pointer. **Invariant: when it is non-null, an active link exists for it.**
- `CONVOS_MAX = 200` counts **top-level** conversations only (`parent_convo_id IS NULL`, active links). Sub-chats are folded under their parent on the mission page and never counted (Q7).
- Backfill: yes (Q9). It runs once, "guarded by an empty table". It is idempotent and safe on every later open.
- `how` vocabulary: `origin | joined | spawned | inherited | backfill`.
- Activity (§2): `running` means an active linked conversation is running. `waiting` means an active linked conversation is waiting, or the mission has items awaiting the user. `quiet` means "no milestone, status update or conversation activity for 7 days". `idle` means none of these.
- House style: no foreign keys on the new link/project columns. Ownership is checked on write. New tables go in `SCHEMA`. Every `ALTER` is guarded by `PRAGMA table_info` and placed after the table-rebuild blocks in `openDb`.
- **Privacy sieve on every new read path.** An ordinary (non-private) agent (`filteredAgent(db, who)`, `excludePrivateOwned: true`) never sees a private-owned conversation, a private-origin mission, a private-origin project, or a status written from/by a private device. It also never sees counts, activity or rollups computed from any of those. Clients and private agents are unfiltered.
- Compatibility (§7): an old bridge's `POST /missions/:id/join` on a conversation that already has another mission now gets **200** where it used to get 409 `other_mission`. Nothing else an old client or bridge reads changes shape except for **added** keys.
- Errors use `src/http-who.js`: `badRequest` → `{error:'bad_request'}`, `notFound` → `{error:'not_found'}`, `conflict(res, extra)` → `{error:'conflict', …extra}`.
- Commits: `git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit …`. Never run `git config` in this worktree. The message ends with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Do not deploy.** The implementer opens the PR and stops. The rollout order is journal → bridge → apps (§7), and Dan schedules it.

## Where the spec did not fit the code (decisions this plan makes)

1. **`user_id` type.** The spec's SQL declares `user_id TEXT` on both new tables. `users.id` is `INTEGER`, and every table here stores it as INTEGER, so both new tables use `INTEGER NOT NULL`.
2. **Extra project columns.** `projects` adds four columns the spec's sketch lacks:
   - `status_device_id`: internal and off the wire. The status sieve needs the writing device, exactly as missions do (plan 2026-09-28, decision 1).
   - `origin_device_id`: needed for the origin sieve when no `convo_id` is named.
   - `closed_over_open_missions`: records a user close over open missions ("that close is recorded, as for missions").
   - `body TEXT NOT NULL DEFAULT ''`: matches `missions.body`.

   `idx_projects_user_state` is added too.
3. **Projects get the origin sieve as well as the status sieve.** The spec says "the privacy sieve works as for missions". For missions that means the whole row is hidden when the origin is private. So a project created from a private-owned conversation, or by a private device, is invisible to ordinary agents: 404 on reads, absent from lists. `project_id` / `project_num` on a mission row still travel as bare handles, the same "numbers, never words" exception `mission_num` has on items.
4. **Colleagues never see projects.** "Projects shared with colleagues" is out of scope (§9). Shared mission rows (`scope=shared`, a colleague's `GET /missions/:id`) carry `project_id: null` and `project_num: null`. The shared mission predicate and its conversation list now read *active links*, not `conversations.mission_id`. The current pointer is always one of them, so this is a superset.
5. **Conversation activity timestamp.** `conversations` has no `updated_at` / `last_activity_at` column. The timestamp used is the newest **message** event's `ts` (the `MESSAGE_TYPES` subquery `/snapshot` already uses for `last_ts`). `session_status` and marker events do not count, for the same phantom-aliveness reason.
6. **`last_activity_at`** = the max of:
   - the mission's `created_at`;
   - its sieved last milestone;
   - its `status_updated_at`, if visible to the caller;
   - each active linked conversation's newest message `ts` and link `joined_at`.

   Including `created_at` and `joined_at` stops a brand-new mission, or a just-joined one, from reading `quiet`. `quiet` means `now − last_activity_at ≥ 7 days`. Precedence is `closed` > `running` > `waiting` > `quiet` > `idle`. A closed mission reads `activity: 'closed'`, which also feeds the `closed` rollup count.
7. **The `conversations` count on a mission row** is now **active top-level links** (sieved). It used to count every conversation whose pointer named the mission, sub-chats included. It matches the cap and the folded list, and "unassigned = open and `conversations: 0`" still holds. A mission everyone has left reads as unassigned.
8. **Join details:**
   - Joining refreshes `joined_at`. That keeps "most recently joined" meaningful for the leave fallback.
   - Reactivating an ended link keeps its original `how`, except that `backfill` is replaced by the new `how`.
   - Joining a link that is already active but not current emits the marker `current_changed`, not `joined`.
   - Re-joining the current mission is a no-op with no marker.
9. **Leave details:**
   - Leaving the current mission moves `current` to the most recently joined remaining active link **whose mission is open**, else to none. A closed mission can't take milestones, so it would be a useless current.
   - Leaving a link that is already ended is a **200 no-op**. Only "no link at all" is 404, so a retried leave is safe.
10. **`milestone_post` naming a mission** that doesn't exist, isn't visible, or has no active link is `409 not_linked` in all three cases, so the response can't be used to probe whether a mission exists. A name of the wrong type is 400.
11. **`POST /missions` on a conversation that already has a current mission** still answers `200 existing: true`. The spec's route table leaves this route unchanged, and bridges rely on it for an idempotent `mission_start`. To move on to new work a session creates with `attach: false` and then joins. The bridge plan owns that tool flow.
12. **Merge redirect is not an HTTP 3xx.**
    - `GET /projects/:id` for a merged project answers 200 with the target's detail plus `merged_from: {id, num}`.
    - `/lookup` answers `{kind:'project', id:<target>, merged_from:<old id>, owner}`.
    - A redirect chain (A→B→C) is followed for up to 16 hops.
    - Writes (`PATCH`, `close`, `merge`) on a merged project address the row itself and get `409 closed`.
13. **Project close and merge details:**
    - The Coordinator proves its role by naming its own conversation as `convo_id`, the rule mission close already uses. An agent that names none gets 403.
    - A user close over open missions leaves those missions open and still filed in the closed project, and records the count.
    - Merging needs no empty source: every mission (open or closed) moves.
14. **Filing:**
    - Taking a mission out of a project (`project: null`) is always allowed.
    - Filing into a closed project is `409 {blocked_by:'project_closed'}`.
    - A **closed** mission may be refiled (`project` alone). A title, body or status edit on it is still 409 `closed`, the same way a closed mission stays a legal target for item moves.
    - `POST /missions {project}` is ignored on the `existing: true` short-circuit.
15. **No project marker.**
    - Per the spec, project create/update/close emit nothing. Only mission moves do, as the existing `updated` mission marker with `project_changed: true` on each moved mission's origin conversation. That includes every mission a merge moves.
    - Apps learn about other project changes by refreshing `GET /projects` on any mission marker and while the tab is open (§4.2).
16. **Backfill `how` for sub-chats.** A conversation whose pointer is set and which has a `parent_convo_id` is backfilled as `inherited`, not `joined`. That is how it got there, and it keeps `how` truthful for the mission page.
    - `joined_at` for backfilled current links comes from the earliest `created`/`joined` `mission` marker the conversation holds for that mission. If there is none, it falls back to `max(conversation.created_at, mission.created_at)`.
17. **Backfill from items** links a conversation to any mission one of its items was *moved* to (`items.mission_id` is repointable). The spec asks for items as a source, and such a link lands under "Earlier", which is the right bucket for it.
18. **`mission_count` on snapshot rows** counts every link, active and ended, so the header's "+n" is `mission_count − 1` (mockup 03: current + one "also on" + one "earlier" = "+2").
19. **Sub-chat folding** rolls each linked sub-chat (grandchildren too) up to its nearest linked ancestor. A linked sub-chat whose parent is not linked to the mission stands as its own row, so folding never hides a link.
20. **The sub-chat cap gate in `inheritableMission` goes away.** Inheritance only ever creates sub-chats (`parentConvoId` set), and sub-chats are not counted.

## Review Focus

1. **A long-running session joins a second mission and then posts a milestone without naming one.** People expect it to land on the **new** current mission, never the old one. It should also land on an "also on" mission when named. Pinned in Task 6 (`default posts to the current mission …`).
2. **A conversation leaves its current mission while its only other link is to a closed mission.** People expect it to end up on no mission. The next unnamed milestone gets `409 no_mission`, not a write into a closed mission. Pinned in Task 4 (`a closed mission is never the fallback …`).
3. **A mission already holding 200 top-level conversations.** Its sub-chats still inherit and can still join. A new top-level join gets 400. Ending a link frees a slot. Pinned in Task 3 (cap test and inheritance test).
4. **An ordinary agent reads a public conversation that the user joined to a private-origin mission.** The mission must not appear in `GET /conversations/:id/missions`. The snapshot's `mission_id` reads null and `mission_count` excludes it. None of that mission's words appear anywhere. Pinned in Tasks 5 and 7.
5. **Someone opens a `#N` link to a project that was merged, possibly twice.** People expect to land on the surviving project with `merged_from` set, both through `/lookup` and `GET /projects/:id`. Writes to the merged row answer `409 closed`. Pinned in Task 11 (merge test).

---

## File Structure

- Create `src/mission-links.js`: the link table's low-level SQL (`activateLink`, `endLink`, `linkRow`, `hasActiveLink`, `topLevelActiveCount`, `nextCurrent`) and `backfillMissionLinks`. It imports nothing from `missions.js` or `db.js`, so no import cycle can form.
- Create `src/message-types.js`: `MESSAGE_TYPES` and `MESSAGE_TYPES_SQL`, moved out of `journal.js` so `missions.js` can use them without importing `journal.js`, which imports `missions.js`. `journal.js` re-exports both.
- Create `src/projects.js`: pure project logic (create/get/resolve/list/detail/update/close/merge, rollups, sieves).
- Create `src/projects-http.js`: the `/projects*` routes and the Coordinator gate.
- Modify `src/db.js`: `SCHEMA` (two tables), guarded `missions.project_id` plus its index, and the backfill call.
- Modify `src/missions.js`: link-aware `createMission` / `joinMission` / new `leaveMission` / `createMilestone`, `missionDetail` rows and folding, `conversationMissions`, `countsSql` / `sharedCountsSql` (count via links, activity, `project_num`), `missionRow` (activity), `listMissions({projectId})`, `updateMission({projectId})`, and exported `ORIGIN_SIEVE`.
- Modify `src/missions-marker.js`: new actions `left` and `current_changed`, and a `project_changed` flag.
- Modify `src/missions-http.js`: join/leave, `GET /conversations/:id/missions`, `?subchats=1`, `POST /milestones {mission}`, `project` on POST/PATCH, and a link-based close gate. It exports `writableConvo`, `statusConvoOf`, `emitMissionMarker`, `byOf`.
- Modify `src/journal.js`: inheritance writes an `inherited` link with no cap gate, `/snapshot` gains `mission_id` and `mission_count`, and `snippetOf` learns the new actions.
- Modify `src/spawns.js`: the spawn join records `how: 'spawned'` and uses the new return shape.
- Modify `src/lookup-http.js`: the `project` kind plus the merge redirect.
- Modify `src/http.js`: mount `handleProjectsRoute`.
- Modify `docs/protocol.md` and `src/help.js`.
- Tests:
  - new `test/mission-links.test.js` (pure), `test/mission-links-http.test.js`, `test/projects.test.js`, `test/projects-http.test.js`;
  - updated `test/missions.test.js`, `test/missions-http.test.js`, `test/agent-spawn.test.js`, `test/help.test.js`;
  - conformance fixtures `02`, `04`, `07`, `15` updated, and new fixture `17`.

---

### Task 1: Schema — link table, projects table, `missions.project_id`

**Files:**
- Modify: `src/db.js` (`SCHEMA`: append after the `memories` block, before the closing backtick at ~line 314; `openDb`: right after `addMissionCol('closed_convo_id', …)` at ~line 652)
- Test: create `test/mission-links.test.js`; modify `test/missions.test.js:21-25` (schema column list)

**Interfaces:**
- Produces:
  - Table `mission_conversations(mission_id TEXT, convo_id TEXT, user_id INTEGER, how TEXT, joined_at INTEGER, ended_at INTEGER|NULL)`, PK `(mission_id, convo_id)`, index `idx_mc_convo(convo_id, ended_at)`.
  - Table `projects` with the columns listed in Step 3.
  - Column `missions.project_id TEXT` and index `idx_missions_project(project_id, state)`.

- [ ] **Step 0: Install dependencies (a fresh worktree has no `node_modules`)**

Run: `cd /Users/danbarker/Dev/matron-journal-projects-plan && npm ci && npm test 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# fail 0`. Note the pass count. It is the baseline every later task must keep (plus the new tests).

- [ ] **Step 1: Write the failing tests**

Create `test/mission-links.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.js'

const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
const indexes = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name)
const tmpPath = (tag) => path.join(os.tmpdir(), `${tag}-${process.pid}-${Date.now()}.sqlite`)
const rmDb = (p) => { for (const s of ['', '-wal', '-shm']) fs.rmSync(`${p}${s}`, { force: true }) }

const PROJECT_COLS = [
  'id', 'user_id', 'num', 'state', 'title', 'body',
  'status', 'status_by', 'status_convo_id', 'status_device_id', 'status_updated_at',
  'close_summary', 'closed_by', 'closed_over_open_missions', 'closed_at', 'merged_into',
  'origin_convo_id', 'origin_device_id', 'created_by', 'idem_key', 'created_at', 'updated_at',
]

test('schema: mission_conversations and projects exist; missions gains project_id; constraints hold', () => {
  const db = openDb(':memory:')
  assert.deepEqual(cols(db, 'mission_conversations'), ['mission_id', 'convo_id', 'user_id', 'how', 'joined_at', 'ended_at'])
  assert.deepEqual(cols(db, 'projects'), PROJECT_COLS)
  assert.ok(cols(db, 'missions').includes('project_id'))
  for (const n of ['idx_mc_convo', 'idx_projects_user_state', 'idx_missions_project']) assert.ok(indexes(db).includes(n), n)
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  const link = db.prepare('INSERT INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at) VALUES(?,?,1,?,0)')
  link.run('ms_a', 'c1', 'joined')
  assert.throws(() => link.run('ms_a', 'c1', 'joined'), /UNIQUE/)
  assert.throws(() => link.run('ms_b', 'c1', 'teleported'), /CHECK/)
  const pj = db.prepare("INSERT INTO projects(id,user_id,num,title,origin_device_id,created_by,created_at,updated_at) VALUES(?,1,?,'P',1,'agent',0,0)")
  pj.run('pj_a', 5)
  assert.throws(() => pj.run('pj_b', 5), /UNIQUE/)
  const row = db.prepare('SELECT state, body, closed_over_open_missions FROM projects WHERE id=?').get('pj_a')
  assert.deepEqual(row, { state: 'open', body: '', closed_over_open_missions: 0 })
  assert.throws(() => db.prepare("UPDATE projects SET state='archived' WHERE id='pj_a'").run(), /CHECK/)
})

test('schema: opening a pre-projects database adds the tables, project_id and its index once', () => {
  const p = tmpPath('projects-migration')
  try {
    openDb(p).close()
    const raw = new Database(p)
    raw.exec('DROP INDEX IF EXISTS idx_missions_project')
    raw.exec('ALTER TABLE missions DROP COLUMN project_id')
    raw.exec('DROP TABLE mission_conversations')
    raw.exec('DROP TABLE projects')
    raw.close()

    const db2 = openDb(p)
    assert.ok(cols(db2, 'missions').includes('project_id'))
    assert.deepEqual(cols(db2, 'projects'), PROJECT_COLS)
    assert.ok(indexes(db2).includes('idx_missions_project'))
    const after = { missions: cols(db2, 'missions'), projects: cols(db2, 'projects'), links: cols(db2, 'mission_conversations') }
    db2.close()

    const db3 = openDb(p)
    assert.deepEqual({ missions: cols(db3, 'missions'), projects: cols(db3, 'projects'), links: cols(db3, 'mission_conversations') }, after)
    db3.close()
  } finally { rmDb(p) }
})
```

In `test/missions.test.js`, extend the expected `missions` column list in the first schema test (lines 21–25) with `'project_id'` at the end:

```js
  assert.deepEqual(cols('missions'), [
    'id', 'user_id', 'num', 'state', 'title', 'body', 'close_summary', 'closed_by', 'closed_over_open_items',
    'origin_convo_id', 'origin_device_id', 'created_by', 'idem_key', 'created_at', 'updated_at', 'last_milestone_at', 'closed_at',
    'status', 'status_by', 'status_convo_id', 'status_updated_at', 'status_device_id', 'closed_convo_id', 'project_id',
  ])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=30000 test/mission-links.test.js test/missions.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: FAIL. Both new tests fail (`no such table: mission_conversations`), and the missions schema test fails on the missing `project_id`.

- [ ] **Step 3: Implement**

In `src/db.js`, append to `SCHEMA` directly after the `CREATE INDEX IF NOT EXISTS idx_memories_user …;` line:

```sql
-- Conversation ↔ mission links (spec 2026-09-30 projects & mission links
-- §3). One row per (mission, conversation) the conversation ever worked on:
-- ended_at NULL = active ("on it now"), set = history ("earlier").
-- conversations.mission_id stays as the CURRENT pointer — invariant: when it
-- is non-null an active link exists for it. No foreign keys (same stance as
-- conversations.mission_id); ownership is checked on write.
CREATE TABLE IF NOT EXISTS mission_conversations(
  mission_id TEXT NOT NULL,
  convo_id   TEXT NOT NULL,
  user_id    INTEGER NOT NULL,
  how        TEXT NOT NULL CHECK(how IN ('origin','joined','spawned','inherited','backfill')),
  joined_at  INTEGER NOT NULL,
  ended_at   INTEGER,
  PRIMARY KEY(mission_id, convo_id)
);
CREATE INDEX IF NOT EXISTS idx_mc_convo ON mission_conversations(convo_id, ended_at);
-- Projects (spec 2026-09-30 §4): groups of missions. Numbered from
-- item_counters like items/missions/milestones. status_device_id and
-- idem_key are internal (never on the wire). merged_into names the project a
-- merge closed this one into.
CREATE TABLE IF NOT EXISTS projects(
  id                        TEXT PRIMARY KEY,
  user_id                   INTEGER NOT NULL REFERENCES users(id),
  num                       INTEGER NOT NULL,
  state                     TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),
  title                     TEXT NOT NULL,
  body                      TEXT NOT NULL DEFAULT '',
  status                    TEXT,
  status_by                 TEXT CHECK(status_by IN ('user','agent')),
  status_convo_id           TEXT,
  status_device_id          INTEGER,
  status_updated_at         INTEGER,
  close_summary             TEXT,
  closed_by                 TEXT CHECK(closed_by IN ('user','agent')),
  closed_over_open_missions INTEGER NOT NULL DEFAULT 0,
  closed_at                 INTEGER,
  merged_into               TEXT,
  origin_convo_id           TEXT,
  origin_device_id          INTEGER NOT NULL,
  created_by                TEXT NOT NULL CHECK(created_by IN ('user','agent')),
  idem_key                  TEXT,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  UNIQUE(user_id, num),
  UNIQUE(user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_projects_user_state ON projects(user_id, state);
```

In `openDb`, directly after `addMissionCol('closed_convo_id', 'closed_convo_id TEXT')`, add:

```js
  // The project a mission is filed in (spec 2026-09-30 §4.1): at most one,
  // NULL = unfiled. Not a foreign key. The index cannot live in SCHEMA: on an
  // upgraded database SCHEMA runs before this ALTER adds the column.
  addMissionCol('project_id', 'project_id TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_missions_project ON missions(project_id, state)')
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-timeout=30000 test/mission-links.test.js test/missions.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`. Nothing reads the new column or tables yet.

- [ ] **Step 6: Commit**

```bash
git add src/db.js test/mission-links.test.js test/missions.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "db: mission_conversations + projects tables, missions.project_id

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: One-time backfill of mission links

**Files:**
- Create: `src/mission-links.js`
- Modify: `src/db.js` (import, plus the call right after the Task 1 `idx_missions_project` line)
- Test: `test/mission-links.test.js`

**Interfaces:**
- Produces: `backfillMissionLinks(db) → number` (rows written; 0 when the table already has rows). `LINK_HOWS = ['origin','joined','spawned','inherited','backfill']`.

- [ ] **Step 1: Write the failing test**

Append to `test/mission-links.test.js`. Add the import `import { backfillMissionLinks } from '../src/mission-links.js'` to the import block.

```js
const linkMap = (db) => Object.fromEntries(db.prepare('SELECT * FROM mission_conversations ORDER BY mission_id, convo_id').all()
  .map((r) => [`${r.mission_id}/${r.convo_id}`, { how: r.how, joined_at: r.joined_at, ended_at: r.ended_at }]))

test('backfill: the first open with an empty link table recovers current, origin, inherited and history links; later opens never touch it', () => {
  const p = tmpPath('mc-backfill')
  try {
    const db1 = openDb(p)
    db1.exec(`
      INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0), (2,'pat','x',0);
      INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','dev-2','h',0);
      INSERT INTO conversations(id, owner_user_id, title, created_at, mission_id, parent_convo_id) VALUES
        ('origin',1,'o',100,'ms_a',NULL), ('joiner',1,'j',200,'ms_a',NULL), ('kid',1,'k',300,'ms_a','origin'),
        ('mover',1,'m',400,'ms_b',NULL), ('quiet',1,'q',500,NULL,NULL), ('foreign',2,'f',600,NULL,NULL);
      INSERT INTO missions(id,user_id,num,state,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at) VALUES
        ('ms_a',1,1,'open','A','origin',7,'agent',1000,1000),
        ('ms_b',1,2,'open','B','mover',7,'agent',2000,2000),
        ('ms_old',1,3,'closed','Old','mover',7,'agent',50,50);
      INSERT INTO milestones(id,mission_id,user_id,num,kind,title,convo_id,seq,device_id,created_by,created_at) VALUES
        ('ml_1','ms_old',1,4,'progress','x','mover',1,7,'agent',60),
        ('ml_2','ms_old',1,5,'progress','y','mover',2,7,'agent',70),
        ('ml_3','ms_a',1,6,'progress','z','joiner',3,7,'agent',1500),
        ('ml_4','ms_a',1,7,'progress','f','foreign',4,7,'agent',1600);
      INSERT INTO items(id,user_id,num,kind,state,rank,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at,mission_id) VALUES
        ('it_1',1,8,'task','closed',1024,'t','mover',7,'agent',80,80,'ms_old');
      INSERT INTO events(user_id, seq, convo_id, ts, sender, type, payload) VALUES
        (1, 10, 'joiner', 1200, 'agent:dev-2', 'mission', '{"mission_id":"ms_a","num":1,"action":"joined","by":"agent"}');
      DELETE FROM mission_conversations;
    `)
    db1.close()

    const db2 = openDb(p)
    assert.deepEqual(linkMap(db2), {
      'ms_a/joiner': { how: 'joined', joined_at: 1200, ended_at: null },     // joined_at from its joined marker
      'ms_a/kid': { how: 'inherited', joined_at: 1000, ended_at: null },     // sub-chat; max(300, 1000)
      'ms_a/origin': { how: 'origin', joined_at: 1000, ended_at: null },     // max(100, 1000)
      'ms_b/mover': { how: 'origin', joined_at: 2000, ended_at: null },
      'ms_old/mover': { how: 'backfill', joined_at: 60, ended_at: 80 },      // first/last milestone-or-item trace
      // 'ms_a/foreign' is absent: the conversation belongs to another user.
    })
    // Invariant: every current pointer has an active link.
    assert.equal(db2.prepare(`SELECT COUNT(*) AS n FROM conversations c WHERE c.mission_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM mission_conversations l WHERE l.mission_id = c.mission_id AND l.convo_id = c.id AND l.ended_at IS NULL)`).get().n, 0)
    assert.equal(backfillMissionLinks(db2), 0, 'a non-empty table is never backfilled again')
    db2.prepare("UPDATE mission_conversations SET ended_at=9999 WHERE convo_id='joiner'").run()
    db2.close()

    const db3 = openDb(p)
    assert.equal(db3.prepare('SELECT COUNT(*) AS n FROM mission_conversations').get().n, 5)
    assert.equal(db3.prepare("SELECT ended_at FROM mission_conversations WHERE convo_id='joiner'").get().ended_at, 9999, 'an ended link stays ended')
    db3.close()
  } finally { rmDb(p) }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=30000 test/mission-links.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: FAIL with `Cannot find module '…/src/mission-links.js'`.

- [ ] **Step 3: Implement**

Create `src/mission-links.js`:

```js
// The conversation ↔ mission link table (spec 2026-09-30 projects & mission
// links §3): low-level SQL shared by missions.js (join/leave/reads),
// journal.js (inheritance) and db.js (the one-time backfill). Deliberately
// imports nothing from missions.js or db.js, so no import cycle can form.
// conversations.mission_id is the CURRENT pointer; this table is the truth
// for "which conversations belong to which mission". Invariant: a non-null
// pointer always has an active (ended_at IS NULL) link.

export const LINK_HOWS = ['origin', 'joined', 'spawned', 'inherited', 'backfill']

// One pass over what the journal already knows, run by openDb while the
// table is empty (the spec's guard). It is idempotent in practice: once any
// row exists (the first join after deploy writes one) it never runs again.
// On a brand-new database it is a no-op on empty tables. INSERT OR IGNORE
// throughout: a pair found twice keeps its first, stronger source — current
// pointers go first, so an active link is never downgraded to history.
export function backfillMissionLinks(db) {
  if (db.prepare('SELECT 1 FROM mission_conversations LIMIT 1').get()) return 0
  return db.transaction(() => {
    // 1. Every current pointer → an active link. how: origin when the
    //    mission was born here, inherited for a sub-chat, else joined.
    //    joined_at: the earliest created/joined marker this conversation
    //    holds for the mission; failing that, the later of the two rows'
    //    creation times (the link cannot predate either).
    const current = db.prepare(`
      INSERT OR IGNORE INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at, ended_at)
      SELECT c.mission_id, c.id, c.owner_user_id,
        CASE WHEN m.origin_convo_id = c.id THEN 'origin'
             WHEN c.parent_convo_id IS NOT NULL THEN 'inherited'
             ELSE 'joined' END,
        COALESCE(
          (SELECT MIN(e.ts) FROM events e
            WHERE e.convo_id = c.id AND e.type = 'mission'
              AND json_extract(e.payload, '$.mission_id') = m.id
              AND json_extract(e.payload, '$.action') IN ('created', 'joined')),
          max(c.created_at, m.created_at)),
        NULL
      FROM conversations c JOIN missions m ON m.id = c.mission_id AND m.user_id = c.owner_user_id
      WHERE c.mission_id IS NOT NULL`).run().changes
    // 2. History: a conversation that posted a milestone or filed an item on
    //    a mission it no longer points at. Ended at its last such trace.
    //    Same-user only — a row whose conversation belongs to someone else is
    //    never a link.
    const history = db.prepare(`
      INSERT OR IGNORE INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at, ended_at)
      SELECT t.mission_id, t.convo_id, c.owner_user_id, 'backfill', MIN(t.at), MAX(t.at)
      FROM (
        SELECT mission_id, convo_id, created_at AS at FROM milestones
        UNION ALL
        SELECT mission_id, origin_convo_id AS convo_id, created_at AS at FROM items WHERE mission_id IS NOT NULL
      ) t
      JOIN conversations c ON c.id = t.convo_id
      JOIN missions m ON m.id = t.mission_id AND m.user_id = c.owner_user_id
      GROUP BY t.mission_id, t.convo_id`).run().changes
    return current + history
  })()
}
```

In `src/db.js`, add `import { backfillMissionLinks } from './mission-links.js'` beside the `healBakedTitles` import. Directly after the Task 1 `CREATE INDEX IF NOT EXISTS idx_missions_project …` line, add:

```js
  // Spec 2026-09-30 §3 backfill: once, while the link table is empty. After
  // every mission/conversation/item column it reads has been added above.
  const backfilled = backfillMissionLinks(db)
  if (backfilled > 0) console.log(`mission_conversations: backfilled ${backfilled} link(s)`)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-timeout=30000 test/mission-links.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/mission-links.js src/db.js test/mission-links.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "db: one-time backfill of conversation-mission links from pointers, milestones and items

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Join makes current; origin, inherited and spawned links; top-level cap

**Files:**
- Modify: `src/mission-links.js` (link helpers)
- Modify: `src/missions.js:180-212` (`attachConversation`, `createMission`), `src/missions.js:295-312` (`joinMission`)
- Modify: `src/missions-marker.js:16` (`MISSION_ACTIONS`)
- Modify: `src/journal.js` (`snippetOf` mission branch ~90-100, `inheritableMission` ~112-144, `upsertConversation` insert branch ~203-213, and the `CONVOS_MAX` import on line 4)
- Modify: `src/missions-http.js:162-183` (`handleJoin`)
- Modify: `src/spawns.js:278-283` (`joinSpawnMission`)
- Test: `test/mission-links.test.js`, create `test/mission-links-http.test.js`. Update `test/missions.test.js` (MISSION_ACTIONS, snippetOf, join test, the CONVOS_MAX inheritance test, and `packConvos`), `test/missions-http.test.js` (join test, cap test) and `test/agent-spawn.test.js:1275`.

**Interfaces:**
- Consumes: the Task 1 table.
- Produces:
  - In `src/mission-links.js`:
    - `linkRow(db, missionId, convoId) → row|null`
    - `hasActiveLink(db, missionId, convoId) → boolean`
    - `activateLink(db, {missionId, convoId, userId, how, ts})`
    - `endLink(db, {missionId, convoId, ts}) → boolean`
    - `topLevelActiveCount(db, missionId) → number`
    - `nextCurrent(db, convoId) → missionId|null`
  - In `src/missions.js`: `joinMission(db, {userId, missionId, convoId, how = 'joined', excludePrivateOwned}) → { mission, action: 'joined'|'current_changed'|null }`. **The return shape changes**: it used to return the mission row.
  - In `src/missions-marker.js`: `MISSION_ACTIONS = ['created','joined','updated','closed','left','current_changed']`.

- [ ] **Step 1: Write the failing pure tests**

Append to `test/mission-links.test.js`, extending its imports to:

```js
import { openDb } from '../src/db.js'
import { backfillMissionLinks } from '../src/mission-links.js'
import { upsertConversation } from '../src/journal.js'
import { createItem } from '../src/items.js'
import { createMission, joinMission, closeMission, CONVOS_MAX } from '../src/missions.js'
```

```js
function seeded() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','dev-2','h',0)").run()
  for (const id of ['c1', 'c2', 'c3']) upsertConversation(db, { id, ownerUserId: 1, title: id.toUpperCase(), agentDeviceId: 7 })
  return db
}
function withPrivateBox() {
  const db = seeded()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(9,1,'agent','priv-box','h2',0,1)").run()
  upsertConversation(db, { id: 'secret', ownerUserId: 1, title: 'S', agentDeviceId: 9 })
  return db
}
const linksOf = (db, convoId) => db.prepare('SELECT mission_id, how, ended_at FROM mission_conversations WHERE convo_id=? ORDER BY rowid').all(convoId)
const currentOf = (db, convoId) => db.prepare('SELECT mission_id FROM conversations WHERE id=?').get(convoId).mission_id
const startOn = (db, convoId, title, extra = {}) => createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId, title, ...extra }).mission
const join = (db, missionId, convoId, extra = {}) => joinMission(db, { userId: 1, missionId, convoId, ...extra })
function packLinks(db, missionId, n, prefix) {
  const conv = db.prepare("INSERT INTO conversations(id, owner_user_id, title, session_state, mission_id, created_at) VALUES(?,1,'x','running',?,0)")
  const link = db.prepare("INSERT INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at) VALUES(?,?,1,'joined',0)")
  for (let i = 0; i < n; i++) { conv.run(`${prefix}${i}`, missionId); link.run(missionId, `${prefix}${i}`) }
}

test('createMission: the attached origin gets an active origin link; attach:false links nothing', () => {
  const db = seeded()
  const a = startOn(db, 'c1', 'A')
  assert.deepEqual(linksOf(db, 'c1'), [{ mission_id: a.id, how: 'origin', ended_at: null }])
  startOn(db, 'c2', 'Parked', { attach: false })
  assert.deepEqual(linksOf(db, 'c2'), [])
  assert.equal(currentOf(db, 'c2'), null)
})

test('joinMission: a second mission becomes current and the first stays active; re-joining current is a no-op; joining an also-on mission is current_changed; closed refuses', () => {
  const db = seeded()
  const a = startOn(db, 'c1', 'A')
  const b = startOn(db, 'c2', 'B')
  const { item } = createItem(db, { userId: 1, originDeviceId: 7, createdBy: 'agent', kind: 'task', title: 'T', originConvoId: 'c1' })
  const j = join(db, b.id, 'c1')
  assert.equal(j.action, 'joined'); assert.equal(j.mission.id, b.id)
  assert.equal(currentOf(db, 'c1'), b.id)
  assert.deepEqual(linksOf(db, 'c1'), [
    { mission_id: a.id, how: 'origin', ended_at: null },
    { mission_id: b.id, how: 'joined', ended_at: null },
  ])
  // An item already on a mission stays there; only unassigned items follow.
  assert.equal(db.prepare('SELECT mission_id FROM items WHERE id=?').get(item.id).mission_id, a.id)
  assert.equal(join(db, b.id, 'c1').action, null)
  const back = join(db, a.id, 'c1')
  assert.equal(back.action, 'current_changed'); assert.equal(currentOf(db, 'c1'), a.id)
  assert.equal(linksOf(db, 'c1').length, 2)
  closeMission(db, { userId: 1, missionId: b.id, by: 'user', summary: 'done' })
  assert.throws(() => join(db, b.id, 'c1'), /closed/)
})

test('joinMission: records the how it is given; a reactivated backfill link takes the new how', () => {
  const db = seeded()
  const a = startOn(db, 'c1', 'A')
  join(db, a.id, 'c2', { how: 'spawned' })
  assert.equal(linksOf(db, 'c2')[0].how, 'spawned')
  db.prepare("INSERT INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at, ended_at) VALUES(?, 'c3', 1, 'backfill', 1, 2)").run(a.id)
  assert.equal(join(db, a.id, 'c3').action, 'joined')
  assert.deepEqual(linksOf(db, 'c3'), [{ mission_id: a.id, how: 'joined', ended_at: null }])
})

test('joinMission: the cap counts active top-level links only — a sub-chat always joins, an ended link frees a slot', () => {
  const db = seeded()
  const m = startOn(db, 'c1', 'A')
  packLinks(db, m.id, CONVOS_MAX - 1, 'pad')   // c1 + 199 = 200 top-level
  assert.throws(() => join(db, m.id, 'c2'), /too_many_convos/)
  assert.equal(currentOf(db, 'c2'), null)
  upsertConversation(db, { id: 'kid', ownerUserId: 1, title: 'k', agentDeviceId: 7, parentConvoId: 'c2' })
  assert.equal(join(db, m.id, 'kid').action, 'joined')
  db.prepare("UPDATE mission_conversations SET ended_at=1 WHERE convo_id='pad0'").run()
  assert.equal(join(db, m.id, 'c2').action, 'joined')
})

test('inheritance: a sub-chat inherits its parent\'s CURRENT mission with an inherited link, even when that mission is at the top-level cap', () => {
  const db = seeded()
  startOn(db, 'c1', 'A')
  const b = startOn(db, 'c2', 'B')
  join(db, b.id, 'c1')
  packLinks(db, b.id, CONVOS_MAX - 2, 'pad')   // c2 + c1 + 198 = 200 top-level
  upsertConversation(db, { id: 'kid', ownerUserId: 1, title: 'k', agentDeviceId: 7, parentConvoId: 'c1' })
  assert.equal(currentOf(db, 'kid'), b.id)
  assert.deepEqual(linksOf(db, 'kid'), [{ mission_id: b.id, how: 'inherited', ended_at: null }])
  // A later upsert never adds or changes a link.
  upsertConversation(db, { id: 'kid', ownerUserId: 1, title: 'k2' })
  assert.equal(linksOf(db, 'kid').length, 1)
})
```

- [ ] **Step 2: Update the existing tests that pinned the old behaviour**

In `test/missions.test.js`:

1. In `marker payloads carry exactly the documented fields`, change the last assertion to:

```js
  assert.deepEqual(MISSION_ACTIONS, ['created', 'joined', 'updated', 'closed', 'left', 'current_changed'])
```

2. In `snippetOf renders both markers; classify never pushes them` (~line 155), add after the `'updated'` assertion:

```js
  assert.equal(snippetOf('mission', { num: 61, action: 'left' }), '🏁 Left mission #61')
  assert.equal(snippetOf('mission', { num: 61, action: 'current_changed' }), '🏁 Now on mission #61')
```

3. Rename the test at ~line 221 to `'join: attaches a second conversation and repoints its items; a conversation on another mission now joins it; a closed mission refuses'`. Replace its line
   `assert.throws(() => joinMission(db, { userId: 1, missionId: b.id, convoId: 'c2' }), /other_mission/)`
   with:

```js
  const moved = joinMission(db, { userId: 1, missionId: b.id, convoId: 'c2' })
  assert.equal(moved.action, 'joined')
  assert.equal(db.prepare('SELECT mission_id FROM conversations WHERE id=?').get('c2').mission_id, b.id)
```

4. Delete the test `'inheritance gate: a parent mission already at CONVOS_MAX is not inherited (the cap is never exceeded)'` (~lines 539–551). The new inheritance test above replaces it. Delete the `packConvos` helper (~lines 526–529) if nothing else uses it (`grep -n packConvos test/missions.test.js` must print nothing afterwards). If `CONVOS_MAX` is then unused in the import on line 14, remove it from that import.

In `test/missions-http.test.js`:

5. In `'join: attaches c2 and repoints its items; refuses a second mission for a convo; …'` (~line 133), rename it to `'join: attaches c2 and repoints its items; a conversation on another mission joins it (200, was 409); PATCH updates and emits the marker on the origin'`. Replace:

```js
  const bad = await s.http(`/missions/${b.id}/join`, { method: 'POST', token: agent.token, body: { convo_id: 'c2' } })
  assert.equal(bad.status, 409); assert.equal(bad.json.blocked_by, 'other_mission')
```

with:

```js
  const moved = await s.http(`/missions/${b.id}/join`, { method: 'POST', token: agent.token, body: { convo_id: 'c2' } })
  assert.equal(moved.status, 200); assert.equal(moved.json.mission.id, b.id)
```

6. Replace the whole `'POST /missions/:id/join: 400 once the mission already holds CONVOS_MAX conversations'` test (~lines 485–499) with:

```js
test('POST /missions/:id/join: 400 once the mission already holds CONVOS_MAX top-level conversations; sub-chats never count', async (t) => {
  const { s, agent } = await fleet(t)
  const m = (await start(s, agent.token, {})).json.mission
  const userId = s.db.prepare('SELECT owner_user_id FROM conversations WHERE id=?').get('c1').owner_user_id
  const conv = s.db.prepare("INSERT INTO conversations(id, owner_user_id, title, session_state, mission_id, created_at) VALUES(?,?,'pad','running',?,0)")
  const link = s.db.prepare("INSERT INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at) VALUES(?,?,?,'joined',0)")
  for (let i = 0; i < CONVOS_MAX - 1; i++) { conv.run(`pad${i}`, userId, m.id); link.run(m.id, `pad${i}`, userId) }
  const joinC = (id) => s.http(`/missions/${m.id}/join`, { method: 'POST', token: agent.token, body: { convo_id: id } })
  const full = await joinC('c2')
  assert.equal(full.status, 400)
  assert.deepEqual(full.json, { error: 'bad_request' })
  assert.equal(s.db.prepare('SELECT mission_id FROM conversations WHERE id=?').get('c2').mission_id, null)
  upsertConversation(s.db, { id: 'kid', ownerUserId: userId, title: 'k', agentDeviceId: agent.deviceId, parentConvoId: 'c2' })
  assert.equal((await joinC('kid')).status, 200, 'a sub-chat is never counted')
  // One slot back (an ended link) and the same call succeeds — the cap is the only reason.
  s.db.prepare("UPDATE mission_conversations SET ended_at=1 WHERE convo_id='pad0'").run()
  assert.equal((await joinC('c2')).status, 200)
})
```

In `test/agent-spawn.test.js`, in `'approve with a mission: …'`, after `assert.equal(child.mission_id, mission.id)` (~line 1275), add:

```js
  assert.equal(s.db.prepare('SELECT how FROM mission_conversations WHERE mission_id=? AND convo_id=?').get(mission.id, 'child-m1').how, 'spawned')
```

- [ ] **Step 3: Write the failing HTTP test**

Create `test/mission-links-http.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { pinDevicePrivate } from '../src/db.js'

async function fleet(t) {
  const s = await startTestServer({})
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  const patAgent = createAgent(s.db, pat.id, 'pat-box')
  for (const id of ['c1', 'c2', 'c3']) upsertConversation(s.db, { id, ownerUserId: dan.id, title: id.toUpperCase(), agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'p1', ownerUserId: pat.id, title: 'P1', agentDeviceId: patAgent.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  return { s, dan, pat, agent, patAgent, client: login.json.token }
}
const start = (s, token, body) => s.http('/missions', { method: 'POST', token, body: { title: 'A', convo_id: 'c1', ...body } })
const join = (s, token, missionId, convoId) => s.http(`/missions/${missionId}/join`, { method: 'POST', token, body: { convo_id: convoId } })
const markerCount = (s, convoId, action) => s.db.prepare(
  "SELECT COUNT(*) AS n FROM events WHERE convo_id=? AND type='mission' AND json_extract(payload,'$.action')=?").get(convoId, action).n

test('POST /missions/:id/join: a conversation on another mission now joins (200, was 409 other_mission), becomes current, and the marker says which', async (t) => {
  const { s, agent, client } = await fleet(t)
  const a = (await start(s, agent.token, {})).json.mission
  const b = (await start(s, agent.token, { title: 'B', convo_id: 'c2' })).json.mission
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const j = await join(s, agent.token, b.id, 'c1')
  assert.equal(j.status, 200); assert.equal(j.json.mission.id, b.id)
  const joined = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.convo_id === 'c1' && f.payload.action === 'joined')
  assert.equal(joined.payload.num, b.num)
  assert.equal((await join(s, agent.token, a.id, 'c1')).status, 200)
  const moved = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.convo_id === 'c1' && f.payload.action === 'current_changed')
  assert.equal(moved.payload.num, a.num)
  ws.close()
  // Re-joining the current mission: 200, no new marker.
  assert.equal((await join(s, agent.token, a.id, 'c1')).status, 200)
  assert.equal(markerCount(s, 'c1', 'current_changed'), 1)
  assert.equal(markerCount(s, 'c1', 'joined'), 1)
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test --test-timeout=30000 test/mission-links.test.js test/mission-links-http.test.js test/missions.test.js test/missions-http.test.js test/agent-spawn.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: FAIL. `joinMission` still returns a mission row (`.action` is undefined), still throws `other_mission`, writes no links, and the new marker actions are rejected.

- [ ] **Step 5: Implement the link helpers**

Append to `src/mission-links.js`:

```js
export function linkRow(db, missionId, convoId) {
  return db.prepare('SELECT * FROM mission_conversations WHERE mission_id=? AND convo_id=?').get(missionId, convoId) ?? null
}

export function hasActiveLink(db, missionId, convoId) {
  return !!db.prepare('SELECT 1 FROM mission_conversations WHERE mission_id=? AND convo_id=? AND ended_at IS NULL').get(missionId, convoId)
}

// Adds a link or reactivates an ended one, stamping joined_at = ts (the
// leave fallback picks the most recently joined). A reactivated link keeps
// the `how` it was made with, unless it was only a backfilled trace.
export function activateLink(db, { missionId, convoId, userId, how, ts }) {
  db.prepare(`INSERT INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at, ended_at)
    VALUES(?,?,?,?,?,NULL)
    ON CONFLICT(mission_id, convo_id) DO UPDATE SET
      ended_at = NULL,
      joined_at = excluded.joined_at,
      how = CASE WHEN mission_conversations.how = 'backfill' THEN excluded.how ELSE mission_conversations.how END`)
    .run(missionId, convoId, userId, how, ts)
}

export function endLink(db, { missionId, convoId, ts }) {
  return db.prepare('UPDATE mission_conversations SET ended_at=? WHERE mission_id=? AND convo_id=? AND ended_at IS NULL')
    .run(ts, missionId, convoId).changes > 0
}

// CONVOS_MAX counts top-level conversations only (spec 2026-09-30 §3):
// sub-chats are folded under their parent and never fill a mission.
export function topLevelActiveCount(db, missionId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM mission_conversations l JOIN conversations c ON c.id = l.convo_id
    WHERE l.mission_id = ? AND l.ended_at IS NULL AND c.parent_convo_id IS NULL`).get(missionId).n
}

// Where `current` goes when a conversation leaves its current mission: the
// most recently joined remaining active link on an OPEN mission (a closed
// one cannot take a milestone), else none.
export function nextCurrent(db, convoId) {
  return db.prepare(`SELECT l.mission_id FROM mission_conversations l JOIN missions m ON m.id = l.mission_id
    WHERE l.convo_id = ? AND l.ended_at IS NULL AND m.state = 'open'
    ORDER BY l.joined_at DESC, l.rowid DESC LIMIT 1`).get(convoId)?.mission_id ?? null
}
```

- [ ] **Step 6: Implement create and join in `src/missions.js`**

Add `import { activateLink, linkRow, topLevelActiveCount } from './mission-links.js'` to the imports.

Replace `attachConversation`:

```js
function attachConversation(db, userId, convoId, missionId, ts) {
  const r = db.prepare('UPDATE conversations SET mission_id=? WHERE id=? AND owner_user_id=? AND mission_id IS NULL').run(missionId, convoId, userId)
  if (r.changes) activateLink(db, { missionId, convoId, userId, how: 'origin', ts })
  repointItems(db, userId, convoId, missionId, ts)
}
```

Replace `joinMission`:

```js
// Spec 2026-09-30 §3: join adds (or reactivates) a link and makes it
// CURRENT. The previous current mission stays active ("also on") — a
// conversation on another mission is no longer refused. `action` tells the
// HTTP layer which marker to write: 'joined' (a new or reactivated link),
// 'current_changed' (an already-active link became current) or null (it
// already was current: a no-op, no marker). The cap counts active
// top-level links; a sub-chat never fills a mission.
export function joinMission(db, { userId, missionId, convoId, how = 'joined', excludePrivateOwned = false }) {
  return db.transaction(() => {
    const m = db.prepare('SELECT id, state FROM missions WHERE id=? AND user_id=?').get(missionId, userId)
    if (!m) throw new Error('no_mission')
    if (m.state === 'closed') throw new Error('closed')
    const convo = db.prepare('SELECT mission_id, parent_convo_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
    if (!convo) throw new Error('no_convo')
    const link = linkRow(db, m.id, convoId)
    const active = !!link && link.ended_at == null
    if (active && convo.mission_id === m.id) return { mission: getMission(db, userId, m.id, { excludePrivateOwned }), action: null }
    if (!active && convo.parent_convo_id == null && topLevelActiveCount(db, m.id) >= CONVOS_MAX) throw new Error('too_many_convos')
    const ts = now()
    activateLink(db, { missionId: m.id, convoId, userId, how, ts })
    db.prepare('UPDATE conversations SET mission_id=? WHERE id=? AND owner_user_id=?').run(m.id, convoId, userId)
    repointItems(db, userId, convoId, m.id, ts)
    db.prepare('UPDATE missions SET updated_at=? WHERE id=?').run(ts, m.id)
    if (convo.mission_id && convo.mission_id !== m.id) db.prepare('UPDATE missions SET updated_at=? WHERE id=?').run(ts, convo.mission_id)
    return { mission: getMission(db, userId, m.id, { excludePrivateOwned }), action: active ? 'current_changed' : 'joined' }
  })()
}
```

- [ ] **Step 7: Implement markers, snippets and inheritance**

In `src/missions-marker.js`:

```js
export const MISSION_ACTIONS = ['created', 'joined', 'updated', 'closed', 'left', 'current_changed']
```

In `src/journal.js` `snippetOf`, inside `if (type === 'mission') {`, add before `return \`🏁 Mission #${n} updated\``:

```js
    if (p.action === 'left') return `🏁 Left mission #${n}`
    if (p.action === 'current_changed') return `🏁 Now on mission #${n}`
```

In `src/journal.js`:
- Change line 4 to `import { getMission } from './missions.js'`.
- Add `import { activateLink } from './mission-links.js'`.
- In `inheritableMission`'s header comment, delete item 3 (`it must hold fewer than CONVOS_MAX …`) and add: `Sub-chats are never counted toward CONVOS_MAX (spec 2026-09-30 §3), so there is no cap gate: a full mission still takes its sub-chats.`
- Delete the function's last cap check (the `if (db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE mission_id=?') … ) return null` line and its comment).

In `upsertConversation`'s `else` (new row) branch, replace the `INSERT INTO conversations …` statement with:

```js
    const createdAt = Date.now()
    // The row and its inherited link are one write: the invariant "a
    // non-null mission_id has an active link" must hold from birth.
    db.transaction(() => {
      db.prepare(
        'INSERT INTO conversations(id, owner_user_id, title, session_state, agent_device_id, parent_convo_id, session_outcome, summary, mission_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
      ).run(id, ownerUserId, initialTitle, sessionState || 'running', agentDeviceId ?? null, parentConvoId ?? null, sessionOutcome ?? null, summary || '', inheritedMission, createdAt)
      if (inheritedMission) activateLink(db, { missionId: inheritedMission, convoId: id, userId: ownerUserId, how: 'inherited', ts: createdAt })
    })()
```

- [ ] **Step 8: Implement the callers**

In `src/missions-http.js`, replace `handleJoin`:

```js
async function handleJoin(ctx, req, res, who, mission) {
  const { db } = ctx
  const body = await readBody(req)
  if (!writableConvo(db, who, body.convo_id)) return notFound(res)
  let out
  try {
    out = joinMission(db, { userId: who.userId, missionId: mission.id, convoId: body.convo_id, excludePrivateOwned: filteredAgent(db, who) })
  } catch (err) {
    if (err.message === 'closed') return conflict(res, { blocked_by: 'closed' })
    if (err.message === 'too_many_convos') return badRequest(res)
    // TOCTOU: the mission/convo were confirmed a moment ago (visibleMission,
    // writableConvo) but either can vanish before this write.
    if (err.message === 'no_mission' || err.message === 'no_convo') return notFound(res)
    throw err
  }
  // Only reachable if the mission vanished inside its own transaction.
  if (!out.mission) return notFound(res)
  // Spec 2026-09-30 §3: no more 409 other_mission — an old bridge simply sees
  // its join succeed. The marker says what happened to this conversation.
  if (out.action) emitMissionMarker(ctx, who, { mission: out.mission, action: out.action, convoId: body.convo_id })
  json(res, 200, { mission: out.mission })
  return true
}
```

In `src/spawns.js` `joinSpawnMission`, replace from `const joined = joinMission(…)` through `return joined` with:

```js
    const { mission: joined, action } = joinMission(db, { userId: row.user_id, missionId: mission.id, convoId: childConvoId, how: 'spawned', excludePrivateOwned })
    if (action) {
      appendAndBroadcast(db, hub, {
        userId: row.user_id, convoId: childConvoId, sender: 'journal', type: MISSION_EVENT_TYPE,
        payload: missionMarkerPayload({ mission: joined, action, by: 'agent', withTitle: markerTitleAllowed(db, joined.origin_convo_id, childConvoId) }),
      })
    }
    return joined
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test --test-timeout=30000 test/mission-links.test.js test/mission-links-http.test.js test/missions.test.js test/missions-http.test.js test/agent-spawn.test.js test/convo-status.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 10: Run the whole suite**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`. If a test elsewhere fails because it still expects 409 `other_mission`, or reads `joinMission(...)` as a row, update it to the new contract in this commit. `grep -rn "other_mission\|joinMission(" test src` lists the candidates.

- [ ] **Step 11: Commit**

```bash
git add src/mission-links.js src/missions.js src/missions-marker.js src/journal.js src/missions-http.js src/spawns.js test/
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "missions: join makes a link current instead of refusing; origin/inherited/spawned links; the cap counts top-level only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `POST /missions/:id/leave`

**Files:**
- Modify: `src/missions.js` (new `leaveMission` after `joinMission`)
- Modify: `src/missions-http.js` (new `handleLeave`, route regex `join|leave|close`, dispatch)
- Test: `test/mission-links.test.js`, `test/mission-links-http.test.js`

**Interfaces:**
- Consumes: `endLink`, `linkRow`, `nextCurrent` (Task 3).
- Produces: `leaveMission(db, {userId, missionId, convoId, excludePrivateOwned}) → { mission, left: boolean, currentChanged: boolean, currentMissionId: string|null }`. Throws `no_mission` | `no_convo` | `no_link`. HTTP `POST /missions/:id/leave {convo_id}` → 200 `{mission, current_mission}`.

- [ ] **Step 1: Write the failing pure tests**

Append to `test/mission-links.test.js`. Add `leaveMission, createMilestone` to the `../src/missions.js` import and `append` to the `../src/journal.js` import.

```js
const pinJoined = (db, missionId, convoId, at) =>
  db.prepare('UPDATE mission_conversations SET joined_at=? WHERE mission_id=? AND convo_id=?').run(at, missionId, convoId)

test('leaveMission: leaving the current falls back to the most recently joined open active link; leaving another keeps the pointer; a repeat is a no-op; rejoin reactivates', () => {
  const db = seeded()
  const a = startOn(db, 'c1', 'A'); const b = startOn(db, 'c2', 'B'); const c = startOn(db, 'c3', 'C')
  join(db, b.id, 'c1'); join(db, c.id, 'c1')
  // Pin the join order: Date.now() can repeat within a millisecond.
  pinJoined(db, a.id, 'c1', 100); pinJoined(db, b.id, 'c1', 200); pinJoined(db, c.id, 'c1', 300)
  const r = leaveMission(db, { userId: 1, missionId: c.id, convoId: 'c1' })
  assert.deepEqual([r.left, r.currentChanged, r.currentMissionId], [true, true, b.id])
  assert.equal(r.mission.id, c.id)
  assert.equal(currentOf(db, 'c1'), b.id)
  assert.ok(linksOf(db, 'c1').find((l) => l.mission_id === c.id).ended_at > 0)
  const r2 = leaveMission(db, { userId: 1, missionId: a.id, convoId: 'c1' })
  assert.deepEqual([r2.left, r2.currentChanged, r2.currentMissionId], [true, false, b.id])
  const r3 = leaveMission(db, { userId: 1, missionId: a.id, convoId: 'c1' })
  assert.equal(r3.left, false, 'an ended link: 200 no-op, never 404')
  assert.throws(() => leaveMission(db, { userId: 1, missionId: b.id, convoId: 'c3' }), /no_link/)
  assert.throws(() => leaveMission(db, { userId: 1, missionId: 'ms_nope', convoId: 'c1' }), /no_mission/)
  // Rejoining reactivates the ended link with its original how.
  assert.equal(join(db, a.id, 'c1').action, 'joined')
  assert.deepEqual(linksOf(db, 'c1').find((l) => l.mission_id === a.id), { mission_id: a.id, how: 'origin', ended_at: null })
  assert.equal(currentOf(db, 'c1'), a.id)
})

test('leaveMission: a closed mission is never the fallback — leaving the last open one leaves the conversation on none, and an unnamed milestone then answers no_mission', () => {
  const db = seeded()
  const a = startOn(db, 'c1', 'A'); const b = startOn(db, 'c2', 'B')
  join(db, b.id, 'c1')
  closeMission(db, { userId: 1, missionId: a.id, by: 'user', summary: 'done' })
  const r = leaveMission(db, { userId: 1, missionId: b.id, convoId: 'c1' })
  assert.deepEqual([r.left, r.currentChanged, r.currentMissionId], [true, false, null])
  assert.equal(currentOf(db, 'c1'), null)
  assert.equal(linksOf(db, 'c1').find((l) => l.mission_id === a.id).ended_at, null, 'the closed mission keeps its active link as history')
  const appendMarker = (payload) => append(db, { userId: 1, convoId: 'c1', sender: 'agent:dev-2', type: 'milestone', payload })
  assert.throws(() => createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', kind: 'progress', title: 'x', appendMarker }), /no_mission/)
})
```

- [ ] **Step 2: Write the failing HTTP test**

Append to `test/mission-links-http.test.js`:

```js
test('POST /missions/:id/leave: ends the link, moves current, writes left + current_changed; repeat is a 200 no-op; no link, foreign or unknown convo is 404', async (t) => {
  const { s, agent, client } = await fleet(t)
  const a = (await start(s, agent.token, {})).json.mission
  const b = (await start(s, agent.token, { title: 'B', convo_id: 'c2' })).json.mission
  await join(s, agent.token, b.id, 'c1')
  const leave = (missionId, convoId, token = agent.token) => s.http(`/missions/${missionId}/leave`, { method: 'POST', token, body: { convo_id: convoId } })
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await leave(b.id, 'c1')
  assert.equal(r.status, 200)
  assert.equal(r.json.mission.id, b.id); assert.equal(r.json.current_mission.id, a.id)
  const left = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.convo_id === 'c1' && f.payload.action === 'left')
  assert.equal(left.payload.num, b.num)
  const moved = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.convo_id === 'c1' && f.payload.action === 'current_changed')
  assert.equal(moved.payload.num, a.num)
  ws.close()
  const again = await leave(b.id, 'c1')
  assert.equal(again.status, 200); assert.equal(markerCount(s, 'c1', 'left'), 1)
  assert.equal((await leave(b.id, 'c3')).status, 404, 'no link')
  assert.equal((await leave(b.id, 'p1')).status, 404, 'another user\'s conversation')
  assert.equal((await leave(b.id, 'nope')).status, 404)
  // Leaving the last one: current_mission null, and no current_changed marker.
  const last = await leave(a.id, 'c1')
  assert.equal(last.status, 200); assert.equal(last.json.current_mission, null)
  assert.equal(markerCount(s, 'c1', 'current_changed'), 1)
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test --test-timeout=30000 test/mission-links.test.js test/mission-links-http.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: FAIL. `leaveMission` is not exported, and the route returns 404 because the regex has no `leave`.

- [ ] **Step 4: Implement `leaveMission`**

In `src/missions.js`, extend the mission-links import to `{ activateLink, endLink, linkRow, nextCurrent, topLevelActiveCount }` and add after `joinMission`:

```js
// Spec 2026-09-30 §3: leave ends a link (kept as history). Leaving the
// CURRENT one moves current to the most recently joined remaining active
// link on an open mission, else to none (nextCurrent). An already-ended
// link is a no-op (left:false) so a retried leave is safe; no link at all
// is 'no_link'. Items stay where they are. A closed mission may be left.
export function leaveMission(db, { userId, missionId, convoId, excludePrivateOwned = false }) {
  return db.transaction(() => {
    const m = db.prepare('SELECT id FROM missions WHERE id=? AND user_id=?').get(missionId, userId)
    if (!m) throw new Error('no_mission')
    const convo = db.prepare('SELECT mission_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
    if (!convo) throw new Error('no_convo')
    const link = linkRow(db, m.id, convoId)
    if (!link) throw new Error('no_link')
    if (link.ended_at != null) {
      return { mission: getMission(db, userId, m.id, { excludePrivateOwned }), left: false, currentChanged: false, currentMissionId: convo.mission_id ?? null }
    }
    const ts = now()
    endLink(db, { missionId: m.id, convoId, ts })
    let current = convo.mission_id ?? null
    const wasCurrent = current === m.id
    if (wasCurrent) {
      current = nextCurrent(db, convoId)
      db.prepare('UPDATE conversations SET mission_id=? WHERE id=? AND owner_user_id=?').run(current, convoId, userId)
    }
    db.prepare('UPDATE missions SET updated_at=? WHERE id=?').run(ts, m.id)
    return {
      mission: getMission(db, userId, m.id, { excludePrivateOwned }),
      left: true, currentChanged: wasCurrent && current !== null, currentMissionId: current,
    }
  })()
}
```

- [ ] **Step 5: Implement the route**

In `src/missions-http.js`, add `leaveMission` to the `./missions.js` import. Add after `handleJoin`:

```js
// Spec 2026-09-30 §3: ends this conversation's link to the mission. Same
// conversation gate as join. Markers go to the conversation concerned:
// `left` for this mission and, when current moved to another mission,
// `current_changed` for that one. Both are built from the unsieved row —
// markerTitleAllowed (inside emitMissionMarker) is what drops a private
// title — while the response is sieved like every other mission read.
async function handleLeave(ctx, req, res, who, mission) {
  const { db } = ctx
  const body = await readBody(req)
  if (!writableConvo(db, who, body.convo_id)) return notFound(res)
  const excludePrivateOwned = filteredAgent(db, who)
  let out
  try {
    out = leaveMission(db, { userId: who.userId, missionId: mission.id, convoId: body.convo_id, excludePrivateOwned })
  } catch (err) {
    if (['no_link', 'no_mission', 'no_convo'].includes(err.message)) return notFound(res)
    throw err
  }
  if (out.left) {
    emitMissionMarker(ctx, who, { mission: getMission(db, who.userId, mission.id), action: 'left', convoId: body.convo_id })
    if (out.currentChanged) {
      emitMissionMarker(ctx, who, { mission: getMission(db, who.userId, out.currentMissionId), action: 'current_changed', convoId: body.convo_id })
    }
  }
  const current = out.currentMissionId ? getMission(db, who.userId, out.currentMissionId, { excludePrivateOwned }) : null
  json(res, 200, { mission: out.mission, current_mission: current })
  return true
}
```

In `handleMissionsRoute`, change the regex to `/^\/missions\/([^/]+)(?:\/(join|leave|close))?$/`. Change the dispatch tail to:

```js
  if (req.method !== 'POST') return false
  if (sub === 'join') return handleJoin(ctx, req, res, who, mission)
  if (sub === 'leave') return handleLeave(ctx, req, res, who, mission)
  return handleClose(ctx, req, res, who, mission)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test --test-timeout=30000 test/mission-links.test.js test/mission-links-http.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 7: Run the whole suite**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/missions.js src/missions-http.js test/mission-links.test.js test/mission-links-http.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "missions: POST /missions/:id/leave with current fallback and left/current_changed markers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Link-aware reads — counts, mission page rows with folding, `GET /conversations/:id/missions`, shared view, close gate

**Files:**
- Modify: `src/missions.js`:
  - `countsSql` `conversations` line (~129)
  - `missionDetail` (~252-268) plus a new `foldSubchats`
  - new `conversationMissions` plus exported `ORIGIN_SIEVE`
  - `MISSION_SHARED` (~430-436), `sharedCountsSql` conversations line (~466), `sharedMissionDetail` conversations query (~513-515)
- Modify: `src/missions-http.js`:
  - `closingConvo` (~194-202)
  - the GET `/missions/:id` branch passes `subchats`
  - new `/conversations/:id/missions` route
- Test: `test/mission-links.test.js`, `test/mission-links-http.test.js`

**Interfaces:**
- Consumes: `hasActiveLink` (Task 3).
- Produces:
  - `missionDetail(db, userId, missionId, {excludePrivateOwned, subchats = false})`. Its `conversations[]` rows are `{id, title, state, box, parent_convo_id, current, how, joined_at, ended_at, subchat_count, other_missions, status?}`. `other_missions` is `[{id, num, title, current, active, joined_at, ended_at}]`: that conversation's links to missions other than this one, ordered as `conversationMissions` orders them, capped at `OTHER_MISSIONS_MAX = 5`, with `ORIGIN_SIEVE` applied for a filtered caller. Mockup 03 draws "also on #N" / "moved to #N" from it.
  - `foldSubchats(rows, {subchats}) → rows`.
  - `conversationMissions(db, userId, convoId, {excludePrivateOwned}) → [missionRow & {current, active, how, joined_at, ended_at}]`.
  - `ORIGIN_SIEVE` (exported string, alias `m`).
  - HTTP `GET /conversations/:id/missions` → `{missions}`. HTTP `GET /missions/:id?subchats=1`.

- [ ] **Step 1: Write the failing pure tests**

Append to `test/mission-links.test.js`. Add `missionDetail, conversationMissions, getMission` to the missions import.

```js
test('missionDetail: rows carry current/how/joined_at/ended_at/parent_convo_id/subchat_count; active before ended; sub-chats fold under their nearest linked ancestor unless subchats; sieved', () => {
  const db = withPrivateBox()
  const a = startOn(db, 'c1', 'A'); const b = startOn(db, 'c2', 'B')
  upsertConversation(db, { id: 'kid', ownerUserId: 1, title: 'kid', agentDeviceId: 7, parentConvoId: 'c1' })       // inherits A
  upsertConversation(db, { id: 'grandkid', ownerUserId: 1, title: 'gk', agentDeviceId: 7, parentConvoId: 'kid' })  // inherits A
  upsertConversation(db, { id: 'pkid', ownerUserId: 1, title: 'pk', agentDeviceId: 9, parentConvoId: 'c1' })       // private sub-chat, inherits A
  upsertConversation(db, { id: 'c4', ownerUserId: 1, title: 'C4', agentDeviceId: 7 })
  upsertConversation(db, { id: 'stray', ownerUserId: 1, title: 'st', agentDeviceId: 7, parentConvoId: 'c4' })      // parent not on A
  join(db, a.id, 'c2')              // c2 current on A, B stays active
  join(db, a.id, 'stray')
  join(db, a.id, 'c3'); leaveMission(db, { userId: 1, missionId: a.id, convoId: 'c3' })
  for (const [id, at] of [['c1', 100], ['kid', 110], ['grandkid', 120], ['pkid', 130], ['c3', 150], ['c2', 200], ['stray', 300]]) pinJoined(db, a.id, id, at)

  const full = missionDetail(db, 1, a.id)
  assert.deepEqual(full.conversations.map((c) => [c.id, c.current, c.how, c.ended_at === null, c.subchat_count]), [
    ['c1', true, 'origin', true, 3],
    ['c2', true, 'joined', true, 0],
    ['stray', true, 'joined', true, 0],   // parent c4 is not on A: never hidden
    ['c3', false, 'joined', false, 0],    // ended → after every active row
  ])
  const c1 = full.conversations[0]
  for (const k of ['id', 'title', 'state', 'box', 'parent_convo_id', 'current', 'how', 'joined_at', 'ended_at', 'subchat_count', 'other_missions']) assert.ok(k in c1, k)
  assert.equal(full.conversations.find((c) => c.id === 'stray').parent_convo_id, 'c4')
  const expanded = missionDetail(db, 1, a.id, { subchats: true })
  assert.deepEqual(expanded.conversations.map((c) => c.id), ['c1', 'kid', 'grandkid', 'pkid', 'c2', 'stray', 'c3'])
  const sieved = missionDetail(db, 1, a.id, { excludePrivateOwned: true })
  assert.equal(sieved.conversations[0].subchat_count, 2, 'the private sub-chat is neither listed nor counted')
  // The row count is active TOP-LEVEL links: c1 and c2 (stray is a sub-chat; c3 ended).
  assert.equal(getMission(db, 1, a.id).conversations, 2)
  assert.ok(b)
})

test('conversationMissions: current first, then active newest-joined, then ended newest; link fields; a private-origin mission is hidden from a filtered caller', () => {
  const db = withPrivateBox()
  const a = startOn(db, 'c1', 'A'); const b = startOn(db, 'c2', 'B'); const c = startOn(db, 'c3', 'C')
  const h = createMission(db, { userId: 1, deviceId: 9, createdBy: 'agent', convoId: 'secret', title: 'Hidden' }).mission
  join(db, b.id, 'c1'); join(db, h.id, 'c1'); join(db, c.id, 'c1')
  leaveMission(db, { userId: 1, missionId: a.id, convoId: 'c1' })
  pinJoined(db, b.id, 'c1', 200); pinJoined(db, h.id, 'c1', 250); pinJoined(db, c.id, 'c1', 300)
  const full = conversationMissions(db, 1, 'c1')
  assert.deepEqual(full.map((m) => [m.id, m.current, m.active, m.how]), [
    [c.id, true, true, 'joined'], [h.id, false, true, 'joined'], [b.id, false, true, 'joined'], [a.id, false, false, 'origin'],
  ])
  assert.ok(full[3].ended_at > 0); assert.equal(full[0].ended_at, null); assert.equal(full[0].joined_at, 300)
  assert.equal(full[0].title, 'C'); assert.equal(typeof full[0].conversations, 'number')
  const sieved = conversationMissions(db, 1, 'c1', { excludePrivateOwned: true })
  assert.deepEqual(sieved.map((m) => m.id), [c.id, b.id, a.id])
  assert.equal(JSON.stringify(sieved).includes('Hidden'), false)
})
```

Also append this test (same file). Add `OTHER_MISSIONS_MAX` to the missions import:

```js
test('missionDetail other_missions: each row names the conversation\'s OTHER missions (current first, then active, then ended; capped); a private-origin one is hidden from a filtered caller', () => {
  const db = withPrivateBox()
  const a = startOn(db, 'c1', 'A'); const b = startOn(db, 'c2', 'B')
  const h = createMission(db, { userId: 1, deviceId: 9, createdBy: 'agent', convoId: 'secret', title: 'Hidden' }).mission
  join(db, b.id, 'c1')                  // c1: B current, A also-on
  const rowOf = (detail, id) => detail.conversations.find((c) => c.id === id)
  const onB = missionDetail(db, 1, b.id)
  assert.deepEqual(rowOf(onB, 'c1').other_missions.map((m) => [m.num, m.title, m.current, m.active]), [[a.num, 'A', false, true]])
  assert.deepEqual(rowOf(onB, 'c2').other_missions, [], 'c2 is on B only')
  const onA = missionDetail(db, 1, a.id)
  const other = rowOf(onA, 'c1').other_missions
  assert.deepEqual(other.map((m) => [m.id, m.current, m.active, m.ended_at]), [[b.id, true, true, null]])
  for (const k of ['id', 'num', 'title', 'current', 'active', 'joined_at', 'ended_at']) assert.ok(k in other[0], k)
  // Leaving B: c1's row on A now shows B as ended ("moved to" / "earlier").
  join(db, h.id, 'c1')                  // c1: H current, B and A active
  leaveMission(db, { userId: 1, missionId: b.id, convoId: 'c1' })
  const full = rowOf(missionDetail(db, 1, a.id), 'c1').other_missions
  assert.deepEqual(full.map((m) => [m.id, m.current, m.active]), [[h.id, true, true], [b.id, false, false]])
  const sieved = rowOf(missionDetail(db, 1, a.id, { excludePrivateOwned: true }), 'c1').other_missions
  assert.deepEqual(sieved.map((m) => m.id), [b.id], 'the private-origin mission is neither named nor counted')
  assert.equal(JSON.stringify(sieved).includes('Hidden'), false)
  // Capped: c3 on A plus six more missions lists only OTHER_MISSIONS_MAX of them.
  join(db, a.id, 'c3')
  for (let i = 0; i < 6; i++) join(db, startOn(db, 'c3', `X${i}`, { attach: false }).id, 'c3')
  assert.equal(OTHER_MISSIONS_MAX, 5)
  const capped = rowOf(missionDetail(db, 1, a.id), 'c3').other_missions
  assert.equal(capped.length, OTHER_MISSIONS_MAX)
  assert.equal(capped[0].current, true, 'the current mission is never the one cut')
})
```

- [ ] **Step 2: Write the failing HTTP tests**

Append to `test/mission-links-http.test.js`:

```js
test('GET /conversations/:id/missions: the header list for own conversations only; 404 for another user\'s, an unknown one, or (ordinary agent) a private-owned one', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const a = (await start(s, agent.token, {})).json.mission
  const b = (await start(s, agent.token, { title: 'B', convo_id: 'c2' })).json.mission
  await join(s, agent.token, b.id, 'c1')
  for (const token of [agent.token, client]) {
    const r = await s.http('/conversations/c1/missions', { token })
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.missions.map((m) => [m.num, m.current, m.active]), [[b.num, true, true], [a.num, false, true]])
  }
  assert.equal((await s.http('/conversations/p1/missions', { token: client })).status, 404)
  assert.equal((await s.http('/conversations/nope/missions', { token: client })).status, 404)
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret', ownerUserId: dan.id, title: 'S', agentDeviceId: priv.deviceId })
  assert.equal((await s.http('/conversations/secret/missions', { token: agent.token })).status, 404)
  assert.equal((await s.http('/conversations/secret/missions', { token: client })).status, 200)
})

test('GET /missions/:id folds sub-chats by default and lists them with ?subchats=1', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const a = (await start(s, agent.token, {})).json.mission
  upsertConversation(s.db, { id: 'kid', ownerUserId: dan.id, title: 'kid', agentDeviceId: agent.deviceId, parentConvoId: 'c1' })
  // Pin the order: both links can be stamped in the same millisecond.
  s.db.prepare("UPDATE mission_conversations SET joined_at=1 WHERE convo_id='c1'").run()
  const folded = await s.http(`/missions/${a.num}`, { token: client })
  assert.deepEqual(folded.json.conversations.map((c) => [c.id, c.subchat_count]), [['c1', 1]])
  assert.deepEqual(folded.json.conversations[0].other_missions, [])
  const open = await s.http(`/missions/${a.num}?subchats=1`, { token: client })
  assert.deepEqual(open.json.conversations.map((c) => [c.id, c.parent_convo_id]), [['c1', null], ['kid', 'c1']])
})

test('close gate: an agent naming a conversation that is ALSO ON the mission (active, not current) may close it; one that left may not', async (t) => {
  const { s, dan, agent } = await fleet(t)
  const a = (await start(s, agent.token, {})).json.mission
  const b = (await start(s, agent.token, { title: 'B', convo_id: 'c2' })).json.mission
  await join(s, agent.token, b.id, 'c1')                        // c1 current on B, still active on A
  await join(s, agent.token, a.id, 'c3')
  await s.http(`/missions/${a.id}/leave`, { method: 'POST', token: agent.token, body: { convo_id: 'c3' } })
  const close = (convoId) => s.http(`/missions/${a.id}/close`, { method: 'POST', token: agent.token, body: { summary: 'done', convo_id: convoId } })
  const refused = await close('c3')
  assert.equal(refused.status, 403); assert.equal(refused.json.detail, 'not_coordinator')
  assert.equal((await close('c1')).status, 200)
  assert.ok(dan)
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test --test-timeout=30000 test/mission-links.test.js test/mission-links-http.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: FAIL. `conversationMissions` and `OTHER_MISSIONS_MAX` are not exported, detail rows lack the link fields and `other_missions`, the route 404s, and the close gate refuses `c1`.

- [ ] **Step 4: Implement the reads in `src/missions.js`**

Export the origin sieve by changing `const ORIGIN_SIEVE =` to `export const ORIGIN_SIEVE =`.

In `countsSql`, replace the `conversations` line with:

```js
    (SELECT COUNT(*) FROM mission_conversations cl JOIN conversations c ON c.id = cl.convo_id
       WHERE cl.mission_id = m.id AND cl.ended_at IS NULL AND c.parent_convo_id IS NULL ${convoSieve}) AS conversations,
```

Replace `missionDetail`'s `conversations` query and return with the code below, and add `foldSubchats` above the function:

```js
// Spec 2026-09-30 §3: every sub-chat whose parent (or any ancestor) is also
// linked to this mission folds into that nearest linked ancestor's row — it
// is counted in that row's subchat_count and, unless `subchats`, left out of
// the list. A sub-chat whose parent is not on the mission stands as its own
// row: folding never hides a link. Runs AFTER the privacy sieve, so a
// hidden sub-chat is neither listed nor counted.
export function foldSubchats(rows, { subchats = false } = {}) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const rootOf = (r) => {
    let cur = r
    const seen = new Set([r.id])
    while (cur.parent_convo_id && byId.has(cur.parent_convo_id) && !seen.has(cur.parent_convo_id)) {
      cur = byId.get(cur.parent_convo_id); seen.add(cur.id)
    }
    return cur
  }
  const counts = new Map()
  const folded = new Set()
  for (const r of rows) {
    const root = rootOf(r)
    if (root !== r) { counts.set(root.id, (counts.get(root.id) || 0) + 1); folded.add(r.id) }
  }
  const out = rows.map((r) => ({ ...r, subchat_count: counts.get(r.id) || 0 }))
  return subchats ? out : out.filter((r) => !folded.has(r.id))
}
```

```js
  const rows = db.prepare(`SELECT c.id, c.title, c.session_state AS state, d.name AS box, c.parent_convo_id,
      (c.mission_id = l.mission_id) AS current, l.how, l.joined_at, l.ended_at,
      s.reported_at AS status_reported_at, s.status AS status_json
    FROM mission_conversations l JOIN conversations c ON c.id = l.convo_id AND c.owner_user_id = ?
    LEFT JOIN devices d ON d.id = c.agent_device_id
    LEFT JOIN conversation_status s ON s.convo_id = c.id
    WHERE l.mission_id = ? ${sieve}
    ORDER BY (l.ended_at IS NOT NULL), l.joined_at, c.created_at`).all(userId, mission.id)
    .map((r) => withConvoStatus({ ...r, current: !!r.current }))
  const conversations = foldSubchats(rows, { subchats })
  const others = otherMissionsStmt(db, excludePrivateOwned)
  for (const c of conversations) c.other_missions = others.all(userId, c.id, mission.id).map(otherMissionRow)
  return { mission, milestones, items, conversations }
```

Add above `missionDetail` (next to `foldSubchats`):

```js
// Mockup 03's "also on #N" / "moved to #N" on a mission page's conversation
// rows (spec 2026-09-30 §3): each listed row names the conversation's links
// to OTHER missions — current first, then active, then ended newest first
// (conversationMissions' order), at most OTHER_MISSIONS_MAX. A slim shape,
// not a mission row: the page needs a chip, not counts. ORIGIN_SIEVE keeps
// a private-origin mission (the user may have joined this public
// conversation to one) from being named to an ordinary agent. Folded
// sub-chats are not listed, so they carry none.
export const OTHER_MISSIONS_MAX = 5

function otherMissionsStmt(db, excludePrivateOwned) {
  return db.prepare(`SELECT m.id, m.num, m.title, (c.mission_id = m.id) AS current, (l.ended_at IS NULL) AS active,
      l.joined_at, l.ended_at
    FROM mission_conversations l
    JOIN missions m ON m.id = l.mission_id AND m.user_id = ?
    JOIN conversations c ON c.id = l.convo_id
    WHERE l.convo_id = ? AND l.mission_id <> ? ${excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''}
    ORDER BY current DESC, (l.ended_at IS NULL) DESC, COALESCE(l.ended_at, l.joined_at) DESC
    LIMIT ${OTHER_MISSIONS_MAX}`)
}

const otherMissionRow = (r) => ({ ...r, current: !!r.current, active: !!r.active })
```

(`ORIGIN_SIEVE` is declared further down the file as a `const`. That is fine, because `otherMissionsStmt` reads it only when called, after the module has loaded. If you prefer, move the `export const ORIGIN_SIEVE` declaration above `foldSubchats`.)

Change `missionDetail`'s signature to `export function missionDetail(db, userId, missionId, { excludePrivateOwned = false, subchats = false } = {})`.

Add after `missionDetail`:

```js
// GET /conversations/:id/missions (spec 2026-09-30 §3): every mission this
// conversation is or was linked to — current first, then the other active
// links newest-joined first, then ended links newest-ended first. Full
// mission rows (same countsSql, same sieve as GET /missions) plus the link.
// ORIGIN_SIEVE drops a private-origin mission for a filtered caller: the
// user may have joined this public conversation to it.
export function conversationMissions(db, userId, convoId, { excludePrivateOwned = false } = {}) {
  const sieve = excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''
  return db.prepare(`SELECT m.*, ${countsSql(excludePrivateOwned)},
      (c.mission_id = m.id) AS link_current, l.how AS link_how, l.joined_at AS link_joined_at, l.ended_at AS link_ended_at
    FROM mission_conversations l
    JOIN missions m ON m.id = l.mission_id AND m.user_id = ?
    JOIN conversations c ON c.id = l.convo_id AND c.owner_user_id = ?
    WHERE l.convo_id = ? ${sieve}
    ORDER BY link_current DESC, (l.ended_at IS NULL) DESC, COALESCE(l.ended_at, l.joined_at) DESC`)
    .all(userId, userId, convoId)
    .map(({ link_current: cur, link_how: how, link_joined_at: joinedAt, link_ended_at: endedAt, ...row }) => ({
      ...missionRow(row), current: !!cur, active: endedAt == null, how, joined_at: joinedAt, ended_at: endedAt,
    }))
}
```

Shared view, reading links instead of the pointer:
- In `MISSION_SHARED`, replace `OR EXISTS (SELECT 1 FROM conversations cv WHERE cv.mission_id = m.id AND ${sharedConvoSql('cv')})` with:

```js
    OR EXISTS (SELECT 1 FROM mission_conversations sl JOIN conversations cv ON cv.id = sl.convo_id
               WHERE sl.mission_id = m.id AND sl.ended_at IS NULL AND ${sharedConvoSql('cv')})
```

- In `sharedCountsSql`, replace the `conversations` line with:

```js
    (SELECT COUNT(*) FROM mission_conversations sl JOIN conversations cc ON cc.id = sl.convo_id
       WHERE sl.mission_id = m.id AND sl.ended_at IS NULL AND cc.parent_convo_id IS NULL AND ${sharedConvoSql('cc')}) AS conversations,
```

- In `sharedMissionDetail`, replace the conversations query with:

```js
  const conversations = db.prepare(`SELECT cv.id, cv.title, cv.session_state AS state, cv.repo, d.name AS box
    FROM mission_conversations sl JOIN conversations cv ON cv.id = sl.convo_id
    LEFT JOIN devices d ON d.id = cv.agent_device_id
    WHERE sl.mission_id = @mid AND sl.ended_at IS NULL AND ${sharedConvoSql('cv')} ORDER BY sl.joined_at`).all(args)
```

- [ ] **Step 5: Implement the routes and the close gate in `src/missions-http.js`**

Add `conversationMissions` to the `./missions.js` import and `import { hasActiveLink } from './mission-links.js'`.

In `closingConvo`, replace `if (convo.mission_id === mission.id) return { convoId }` with:

```js
  // "On the mission" = an ACTIVE link (spec 2026-09-30 §3): current or also-on.
  if (hasActiveLink(db, mission.id, convoId)) return { convoId }
```

In the `GET /missions/:id` branch, pass `subchats`:

```js
      const detail = missionDetail(db, who.userId, mission.id, { excludePrivateOwned: filteredAgent(db, who), subchats: url.searchParams.get('subchats') === '1' })
```

At the top of `handleMissionsRoute`, after `const path = url.pathname`, add:

```js
  // The conversation header's list (spec 2026-09-30 §3). Own conversations
  // only; an ordinary agent never reads a private-owned one — same 404 as
  // missing, like GET /milestones?convo=.
  const cm = path.match(/^\/conversations\/([^/]+)\/missions$/)
  if (cm) {
    if (req.method !== 'GET') return false
    let convoId
    try { convoId = decodeURIComponent(cm[1]) } catch { return badRequest(res) }
    const convo = db.prepare('SELECT owner_user_id FROM conversations WHERE id=?').get(convoId)
    if (!convo || convo.owner_user_id !== who.userId) return notFound(res)
    const excludePrivateOwned = filteredAgent(db, who)
    if (excludePrivateOwned && privateOwnedConvo(db, convoId)) return notFound(res)
    json(res, 200, { missions: conversationMissions(db, who.userId, convoId, { excludePrivateOwned }) })
    return true
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test --test-timeout=30000 test/mission-links.test.js test/mission-links-http.test.js test/missions.test.js test/missions-http.test.js test/agent-spawn.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 7: Run the whole suite**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`. Watch `test/convo-status.test.js`: it reads `detail.conversations[].status`, which `withConvoStatus` still sets.

- [ ] **Step 8: Commit**

```bash
git add src/missions.js src/missions-http.js test/mission-links.test.js test/mission-links-http.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "missions: read conversations through links — folded mission page rows, GET /conversations/:id/missions, link-based close gate and shared view

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `POST /milestones` may name an active linked mission

**Files:**
- Modify: `src/missions.js` (`createMilestone` ~352-373)
- Modify: `src/missions-http.js` (`handleMilestoneCreate` ~234-285)
- Test: `test/mission-links.test.js`, `test/mission-links-http.test.js`

**Interfaces:**
- Consumes: `hasActiveLink` (Task 3).
- Produces: `createMilestone(db, {…, missionRef = null})`. It throws `not_linked` when `missionRef` names a mission that doesn't exist, isn't visible, or has no active link from `convoId`. HTTP `POST /milestones {…, mission?: id|"#n"|n}` → 409 `{blocked_by:'not_linked'}`, or 400 on a non-string/non-number.

- [ ] **Step 1: Write the failing pure test**

Append to `test/mission-links.test.js`:

```js
test('createMilestone: default posts to the current mission; mission names any ACTIVE link; ended, unrelated, unknown or hidden → not_linked and nothing is written', () => {
  const db = withPrivateBox()
  const a = startOn(db, 'c1', 'A'); const b = startOn(db, 'c2', 'B'); const c = startOn(db, 'c3', 'C')
  const h = createMission(db, { userId: 1, deviceId: 9, createdBy: 'agent', convoId: 'secret', title: 'Hidden' }).mission
  join(db, h.id, 'c1'); join(db, b.id, 'c1')   // c1: A origin, H active, B current
  const appendMarker = (payload) => append(db, { userId: 1, convoId: 'c1', sender: 'agent:dev-2', type: 'milestone', payload })
  const post = (extra) => createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', kind: 'progress', title: 't', appendMarker, ...extra })
  assert.equal(post({}).mission.id, b.id, 'no name → the NEW current mission')
  assert.equal(post({ missionRef: `#${a.num}` }).mission.id, a.id)
  assert.equal(post({ missionRef: a.num }).mission.id, a.id)
  assert.equal(post({ missionRef: a.id }).mission.id, a.id)
  leaveMission(db, { userId: 1, missionId: a.id, convoId: 'c1' })
  const before = db.prepare('SELECT COUNT(*) AS n FROM milestones').get().n
  const events = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='milestone'").get().n
  for (const ref of [a.id, `#${c.num}`, '#9999', 'nonsense']) assert.throws(() => post({ missionRef: ref }), /not_linked/, String(ref))
  assert.throws(() => post({ missionRef: h.id, excludePrivateOwned: true }), /not_linked/, 'hidden to a filtered caller')
  assert.equal(post({ missionRef: h.id }).mission.id, h.id, 'the unfiltered caller may')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM milestones').get().n, before + 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='milestone'").get().n, events + 1)
})
```

- [ ] **Step 2: Write the failing HTTP test**

Append to `test/mission-links-http.test.js`:

```js
test('POST /milestones {mission}: names an also-on mission; 409 not_linked when not an active link; 400 on a bad type; old callers unchanged', async (t) => {
  const { s, agent } = await fleet(t)
  const a = (await start(s, agent.token, {})).json.mission
  const b = (await start(s, agent.token, { title: 'B', convo_id: 'c2' })).json.mission
  await join(s, agent.token, b.id, 'c1')
  const post = (body) => s.http('/milestones', { method: 'POST', token: agent.token, body: { convo_id: 'c1', kind: 'progress', title: 'step', ...body } })
  const plain = await post({})
  assert.equal(plain.status, 201); assert.equal(plain.json.mission.id, b.id)
  const named = await post({ mission: `#${a.num}` })
  assert.equal(named.status, 201); assert.equal(named.json.milestone.mission_id, a.id)
  const marker = s.db.prepare("SELECT payload FROM events WHERE type='milestone' AND seq=?").get(named.json.milestone.seq)
  assert.equal(JSON.parse(marker.payload).mission_num, a.num)
  const c = (await start(s, agent.token, { title: 'C', convo_id: 'c3' })).json.mission
  const refused = await post({ mission: c.num })
  assert.equal(refused.status, 409); assert.deepEqual(refused.json, { error: 'conflict', blocked_by: 'not_linked' })
  assert.equal((await post({ mission: { id: a.id } })).status, 400)
  assert.equal((await post({ mission: null })).status, 201, 'null = the current mission')
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test --test-timeout=30000 test/mission-links.test.js test/mission-links-http.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: FAIL. `missionRef` is ignored, so the milestone lands on the current mission.

- [ ] **Step 4: Implement**

In `src/missions.js`, add `hasActiveLink` to the mission-links import. Change the `createMilestone` signature to include `missionRef = null`. Replace the four lines from `if (!convo.mission_id) throw new Error('no_mission')` through `if (!mission) throw new Error('no_mission')` with:

```js
    // Spec 2026-09-30 §3: `missionRef` (id, "#n" or n) may name ANY mission
    // this conversation has an active link to; the default stays the current
    // one. Unknown, invisible (the caller's own sieve) and unlinked are one
    // answer — not_linked — so the name is never an existence oracle.
    let targetId = convo.mission_id
    if (missionRef != null) {
      const named = getMission(db, userId, missionRef, { excludePrivateOwned })
      if (!named || !hasActiveLink(db, named.id, convoId)) throw new Error('not_linked')
      targetId = named.id
    }
    if (!targetId) throw new Error('no_mission')
    // Resolved THROUGH the caller's own sieve (C1): a conversation the user
    // joined to a private-origin mission must not become a write path into
    // it for an ordinary agent. Refused before the marker append, so nothing
    // — not the row, not the number, not the event — is written.
    const mission = getMission(db, userId, targetId, { excludePrivateOwned })
    if (!mission) throw new Error('no_mission')
```

In `src/missions-http.js` `handleMilestoneCreate`, after the `body.body` validation line add:

```js
  // Optional mission name (spec 2026-09-30 §3): id, "#n" or n; null/absent = current.
  if (body.mission != null && typeof body.mission !== 'string' && typeof body.mission !== 'number') return badRequest(res)
```

Pass `missionRef: body.mission ?? null` into `createMilestone`. In its catch, add as the first line:

```js
    if (err.message === 'not_linked') return conflict(res, { blocked_by: 'not_linked' })
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test --test-timeout=30000 test/mission-links.test.js test/mission-links-http.test.js test/missions.test.js test/missions-http.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/missions.js src/missions-http.js test/mission-links.test.js test/mission-links-http.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "milestones: optional mission name among the conversation's active links; 409 not_linked

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Snapshot rows gain `mission_id` and `mission_count`

**Files:**
- Modify: `src/journal.js` (`snapshot` conversations SELECT ~335-345, and the `./missions.js` import)
- Modify: `test/fixtures/conformance/02_snapshot_with_conversations.json`, `04_client_send_echo_idem.json`, `07_prompt_reply_and_read_marker.json`
- Test: `test/mission-links.test.js`

**Interfaces:**
- Consumes: `ORIGIN_SIEVE` (Task 5).
- Produces: every `/snapshot` conversation row carries `mission_id` (current, or null) and `mission_count` (every link, active and ended). Both are sieved for a filtered caller.

- [ ] **Step 1: Write the failing test**

Append to `test/mission-links.test.js`. Add `snapshot` to the `../src/journal.js` import.

```js
test('snapshot: rows carry the current mission_id and mission_count (every link, ended ones too); a filtered caller loses private-origin missions from both', () => {
  const db = withPrivateBox()
  const a = startOn(db, 'c1', 'A'); const b = startOn(db, 'c2', 'B')
  join(db, b.id, 'c1'); leaveMission(db, { userId: 1, missionId: a.id, convoId: 'c1' })   // c1: B current, A ended
  const h = createMission(db, { userId: 1, deviceId: 9, createdBy: 'agent', convoId: 'secret', title: 'Hidden' }).mission
  join(db, h.id, 'c3')                                                                     // user put public c3 on a private-origin mission
  const row = (snap, id) => snap.conversations.find((c) => c.id === id)
  const full = snapshot(db, 1)
  assert.deepEqual([row(full, 'c1').mission_id, row(full, 'c1').mission_count], [b.id, 2])
  assert.deepEqual([row(full, 'c2').mission_id, row(full, 'c2').mission_count], [b.id, 1])
  assert.deepEqual([row(full, 'c3').mission_id, row(full, 'c3').mission_count], [h.id, 1])
  const sieved = snapshot(db, 1, { excludePrivateOwned: true })
  assert.deepEqual([row(sieved, 'c3').mission_id, row(sieved, 'c3').mission_count], [null, 0])
  assert.deepEqual([row(sieved, 'c1').mission_id, row(sieved, 'c1').mission_count], [b.id, 2])
  assert.equal(row(sieved, 'secret'), undefined)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=30000 test/mission-links.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: FAIL. `mission_id` / `mission_count` are undefined on snapshot rows.

- [ ] **Step 3: Implement**

In `src/journal.js`, change the missions import to `import { getMission, ORIGIN_SIEVE } from './missions.js'`. In `snapshot`, add to the conversations SELECT column list after `agent_device_id,`:

```js
            ${excludePrivateOwned
              ? `(CASE WHEN EXISTS (SELECT 1 FROM missions m WHERE m.id = conversations.mission_id AND ${ORIGIN_SIEVE}) THEN mission_id END)`
              : 'mission_id'} AS mission_id,
            (SELECT COUNT(*) FROM mission_conversations l JOIN missions m ON m.id = l.mission_id
              WHERE l.convo_id = conversations.id${excludePrivateOwned ? ` AND ${ORIGIN_SIEVE}` : ''}) AS mission_count,
```

Update the comment block above `snapshot()` with one line:
`// mission_id / mission_count (spec 2026-09-30 §3): the header chip without a fetch — the current mission and how many missions this conversation ever touched; a filtered caller never counts or names a private-origin mission.`

In each of the three conformance fixtures, add `"mission_id": null, "mission_count": 0` to **every** expected conversation object, next to `"agent_device_id": null`. That is two objects in `02_snapshot_with_conversations.json`, one in `04_client_send_echo_idem.json` and one in `07_prompt_reply_and_read_marker.json`. Example:

```json
            "parent_convo_id": null, "summary": "", "repo": null, "agent_device_id": null, "mission_id": null, "mission_count": 0,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-timeout=30000 test/mission-links.test.js test/conformance.test.js test/journal.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`. Any other test that `deepEqual`s a whole snapshot row gains the two keys in this commit.

- [ ] **Step 6: Commit**

```bash
git add src/journal.js test/mission-links.test.js test/fixtures/conformance/
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "snapshot: conversation rows carry mission_id (current) and mission_count, sieved

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Mission rows gain `activity`, `last_activity_at`, `project_id`, `project_num`

**Files:**
- Create: `src/message-types.js`
- Modify: `src/journal.js` (lines 10-18: move the two constants out and re-export them)
- Modify: `src/missions.js`: `QUIET_MS` / `activityOf`, `missionRow`, `countsSql`, `sharedCountsSql`, `sharedMissionRow`, `listMissions({projectId})`
- Modify: `test/fixtures/conformance/15_missions_roundtrip.json`
- Test: `test/mission-links.test.js`

**Interfaces:**
- Produces:
  - `QUIET_MS = 604800000`
  - `activityOf({state, running, waiting, needsYou, lastActivityAt}, nowMs = Date.now()) → 'closed'|'running'|'waiting'|'quiet'|'idle'`
  - every mission row gains `activity`, `last_activity_at` (ms), `project_id` (own view; null for a colleague) and `project_num` (null when unfiled or for a colleague)
  - `listMissions(db, userId, {…, projectId = null})`
- **Trap:** `missionRow` is used as `.map(missionRow)`, so it must take **one** argument. It reads `Date.now()` itself. Do not add a `nowMs` parameter to it, because `map` would pass the array index there.

- [ ] **Step 1: Write the failing tests**

Append to `test/mission-links.test.js`. Add `updateMission, activityOf, QUIET_MS` to the missions import.

```js
test('activityOf: closed > running > waiting (a waiting session or needs-you) > quiet (≥ 7 days) > idle', () => {
  const now = 100 * QUIET_MS
  const base = { state: 'open', running: 0, waiting: 0, needsYou: 0, lastActivityAt: now }
  assert.equal(QUIET_MS, 7 * 24 * 60 * 60 * 1000)
  assert.equal(activityOf({ ...base, state: 'closed', running: 2 }, now), 'closed')
  assert.equal(activityOf({ ...base, running: 1, waiting: 1, needsYou: 1 }, now), 'running')
  assert.equal(activityOf({ ...base, waiting: 1, lastActivityAt: 0 }, now), 'waiting')
  assert.equal(activityOf({ ...base, needsYou: 2, lastActivityAt: 0 }, now), 'waiting')
  assert.equal(activityOf({ ...base, lastActivityAt: now - QUIET_MS }, now), 'quiet')
  assert.equal(activityOf({ ...base, lastActivityAt: now - QUIET_MS + 1 }, now), 'idle')
})

test('mission rows: activity follows linked sessions, needs-you, messages and closing; last_activity_at; project fields present', () => {
  const db = seeded()
  const m = startOn(db, 'c1', 'A')
  const row = () => getMission(db, 1, m.id)
  assert.equal(row().activity, 'running')
  assert.equal(row().project_id, null); assert.equal(row().project_num, null)
  assert.ok(row().last_activity_at >= row().created_at)
  db.prepare("UPDATE conversations SET session_state='waiting' WHERE id='c1'").run()
  assert.equal(row().activity, 'waiting')
  db.prepare("UPDATE conversations SET session_state='done' WHERE id='c1'").run()
  assert.equal(row().activity, 'idle')
  const old = Date.now() - 8 * 24 * 60 * 60 * 1000
  db.prepare('UPDATE missions SET created_at=? WHERE id=?').run(old, m.id)
  db.prepare('UPDATE mission_conversations SET joined_at=? WHERE mission_id=?').run(old, m.id)
  assert.equal(row().activity, 'quiet'); assert.equal(row().last_activity_at, old)
  append(db, { userId: 1, convoId: 'c1', sender: 'agent:dev-2', type: 'text', payload: { body: 'back' } })
  assert.equal(row().activity, 'idle', 'a message in a linked conversation is activity')
  createItem(db, { userId: 1, originDeviceId: 7, createdBy: 'agent', kind: 'question', title: 'Q?', originConvoId: 'c1' })
  assert.equal(row().activity, 'waiting', 'needs-you')
  closeMission(db, { userId: 1, missionId: m.id, by: 'user', summary: 'done' })
  assert.equal(row().activity, 'closed')
})

test('activity is sieved: a private box\'s running session or a privately written status never makes a mission look live to an ordinary agent', () => {
  const db = withPrivateBox()
  const m = startOn(db, 'c1', 'A')
  db.prepare("UPDATE conversations SET session_state='done' WHERE id='c1'").run()
  join(db, m.id, 'secret')
  assert.equal(getMission(db, 1, m.id).activity, 'running')
  assert.equal(getMission(db, 1, m.id, { excludePrivateOwned: true }).activity, 'idle')
  const old = Date.now() - 8 * 24 * 60 * 60 * 1000
  db.prepare("UPDATE conversations SET session_state='done' WHERE id='secret'").run()
  db.prepare('UPDATE missions SET created_at=? WHERE id=?').run(old, m.id)
  db.prepare('UPDATE mission_conversations SET joined_at=? WHERE mission_id=?').run(old, m.id)
  updateMission(db, { userId: 1, missionId: m.id, fields: { status: 'Private progress' }, statusWriter: { by: 'agent', convoId: 'secret', deviceId: 9 } })
  assert.equal(getMission(db, 1, m.id).activity, 'idle', 'the fresh status counts for the owner')
  assert.equal(getMission(db, 1, m.id, { excludePrivateOwned: true }).activity, 'quiet', 'but not through the sieve')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=30000 test/mission-links.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: FAIL. `activityOf` and `QUIET_MS` are not exported, and `activity` is undefined.

- [ ] **Step 3: Move the message types**

Create `src/message-types.js`:

```js
// The event types that are conversation CONTENT — what bumps unread and the
// snippet, and what counts as "activity" for last_ts (/snapshot, /roster)
// and a mission's last_activity_at (missions.js). Its own module so
// missions.js can use it without importing journal.js (which imports
// missions.js).
export const MESSAGE_TYPES = [
  'text', 'tool_output', 'diff', 'prompt', 'permission_request', 'file', 'image', 'spawn_outcome',
]

// SQL literal of MESSAGE_TYPES for correlated last-message subqueries. Safe
// to inline — a compile-time constant of bare identifiers.
export const MESSAGE_TYPES_SQL = MESSAGE_TYPES.map((t) => `'${t}'`).join(',')
```

In `src/journal.js`, delete the `MESSAGE_TYPES` and `MESSAGE_TYPES_SQL` declarations (lines 10–18) and add:

```js
import { MESSAGE_TYPES, MESSAGE_TYPES_SQL } from './message-types.js'
export { MESSAGE_TYPES, MESSAGE_TYPES_SQL }
```

- [ ] **Step 4: Implement activity in `src/missions.js`**

Add `import { MESSAGE_TYPES_SQL } from './message-types.js'`. Add after `STATUS_FIELDS`:

```js
// Spec 2026-09-30 §2/§4.2 activity. quiet = nothing for 7 days; the clock
// is read at row-building time.
export const QUIET_MS = 7 * 24 * 60 * 60 * 1000

export function activityOf({ state, running, waiting, needsYou, lastActivityAt }, nowMs = Date.now()) {
  if (state === 'closed') return 'closed'
  if (running > 0) return 'running'
  if (waiting > 0 || needsYou > 0) return 'waiting'
  if (nowMs - lastActivityAt >= QUIET_MS) return 'quiet'
  return 'idle'
}

// The three per-caller inputs activity needs, over ACTIVE links only.
// `sieve` is the caller's conversation predicate on alias c (the same one
// the counts use), so a hidden session is never "running" and a hidden
// conversation's messages are never "activity". A conversation's activity
// is its newest MESSAGE event (the /snapshot last_ts rule — session_status
// and markers are not activity) or when it joined, whichever is later.
function activitySql(sieve) {
  return `
    (SELECT COUNT(*) FROM mission_conversations al JOIN conversations c ON c.id = al.convo_id
       WHERE al.mission_id = m.id AND al.ended_at IS NULL AND c.session_state = 'running' ${sieve}) AS running_convos,
    (SELECT COUNT(*) FROM mission_conversations al JOIN conversations c ON c.id = al.convo_id
       WHERE al.mission_id = m.id AND al.ended_at IS NULL AND c.session_state = 'waiting' ${sieve}) AS waiting_convos,
    (SELECT MAX(max(al.joined_at, COALESCE((SELECT e.ts FROM events e WHERE e.convo_id = c.id
                 AND e.type IN (${MESSAGE_TYPES_SQL}) ORDER BY e.seq DESC LIMIT 1), 0)))
       FROM mission_conversations al JOIN conversations c ON c.id = al.convo_id
       WHERE al.mission_id = m.id AND al.ended_at IS NULL ${sieve}) AS convo_activity_at`
}
```

In `countsSql`, append before the closing backtick (after `closed_hidden`):

```js
    ,${activitySql(convoSieve)},
    (SELECT p.num FROM projects p WHERE p.id = m.project_id) AS project_num
```

In `sharedCountsSql`, append before the closing backtick (after `closed_hidden`):

```js
    ,${activitySql(`AND ${sharedConvoSql('c')}`)},
    NULL AS project_num
```

Replace `missionRow` with:

```js
export function missionRow(row) {
  if (!row) return null
  const {
    idem_key: _idemKey, sieved_last_milestone_at: sievedLastMilestoneAt,
    status_device_id: _statusDeviceId, status_hidden: statusHidden,
    running_convos: runningConvos, waiting_convos: waitingConvos, convo_activity_at: convoActivityAt, ...rest
  } = row
  const { closed_hidden: closedHidden, ...bare } = rest
  const out = { ...bare, closed_over_open_items: Number(bare.closed_over_open_items || 0) }
  if (Number(closedHidden || 0) && 'closed_convo_id' in out) out.closed_convo_id = null
  for (const k of ['open_items', 'needs_you', 'conversations', 'milestones']) if (k in out) out[k] = Number(out[k])
  if ('last_milestone_json' in out) {
    out.last_milestone = out.last_milestone_json ? JSON.parse(out.last_milestone_json) : null
    delete out.last_milestone_json
  }
  if (Number(statusHidden || 0)) for (const k of STATUS_FIELDS) out[k] = null
  // Spec 2026-09-30 §2 activity — computed after the status sieve, so a
  // withheld status_updated_at never counts. Every input here is the
  // caller's own sieved view (countsSql / sharedCountsSql).
  if (runningConvos !== undefined) {
    out.last_activity_at = Math.max(...[out.created_at, sievedLastMilestoneAt, out.status_updated_at, convoActivityAt]
      .filter((v) => v != null).map(Number))
    out.activity = activityOf({
      state: out.state, running: Number(runningConvos), waiting: Number(waitingConvos),
      needsYou: out.needs_you ?? 0, lastActivityAt: out.last_activity_at,
    })
  }
  return out
}
```

(The comment block above `missionRow` also gains: "`running_convos`, `waiting_convos` and `convo_activity_at` are activity inputs, never on the wire.")

In `sharedMissionRow`, after `mission.owner = …`, add:

```js
  // Projects are never shared with colleagues (spec 2026-09-30 §9).
  mission.project_id = null
```

In `listMissions`, change the signature to `{ state = null, since = null, projectId = null, excludePrivateOwned = false } = {}` and add after the `since` line:

```js
  if (projectId) { where.push('m.project_id = ?'); args.push(projectId) }
```

- [ ] **Step 5: Update the conformance fixture**

In `test/fixtures/conformance/15_missions_roundtrip.json`, in the first step's expected `mission` object, replace `"open_items": 0, "needs_you": 0, "conversations": 1, "milestones": 0, "last_milestone": null` with:

```json
        "open_items": 0, "needs_you": 0, "conversations": 1, "milestones": 0, "last_milestone": null,
        "project_id": null, "project_num": null, "activity": "running", "last_activity_at": { "$type": "integer" }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test --test-timeout=30000 test/mission-links.test.js test/missions.test.js test/missions-http.test.js test/conformance.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 7: Run the whole suite**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`. Any test that `deepEqual`s a whole mission row gains the four keys in this commit.

- [ ] **Step 8: Commit**

```bash
git add src/message-types.js src/journal.js src/missions.js test/mission-links.test.js test/fixtures/conformance/15_missions_roundtrip.json
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "missions: server-computed activity (running/waiting/quiet/idle), last_activity_at and project fields on every row, sieved

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `src/projects.js` — pure project state, sieves, rollups, close, merge

**Files:**
- Create: `src/projects.js`
- Test: create `test/projects.test.js`

**Interfaces:**
- Consumes: `nextNum`, `newId` (`items.js`); `listMissions`, `milestoneRow`, `ORIGIN_SIEVE` (`missions.js`, Tasks 5 and 8).
- Produces:
  - `MERGE_HOPS_MAX = 16`
  - `projectRow(row)`
  - `getProject(db, userId, idOrNum, {excludePrivateOwned}) → project|null`
  - `resolveProject(db, userId, idOrNum, opts) → {project, mergedFrom: {id,num}|null}|null`
  - `createProject(db, {userId, deviceId, createdBy, convoId = null, title, body = '', idemKey = null, excludePrivateOwned}) → {project, duplicate}`
  - `updateProject(db, {userId, projectId, fields, statusWriter, excludePrivateOwned}) → project|null`
  - `closeProject(db, {userId, projectId, by, summary, excludePrivateOwned}) → {project}`
  - `mergeProject(db, {userId, projectId, intoId, by, excludePrivateOwned}) → {project, merged, movedMissionIds}`
  - `rollupsByProject(missions) → Map`
  - `withRollup(project, rollup?)`
  - `projectWithRollup(db, userId, project, {excludePrivateOwned})`
  - `listProjects(db, userId, {state, excludePrivateOwned})`
  - `projectDetail(db, userId, project, {excludePrivateOwned})`

  Errors: `no_project`, `closed`, `open_missions` (`.missions = [{num,title}]`), `same_project`, `into_closed`, `status_writer_required`.
- Project wire row: every `projects` column except `idem_key` and `status_device_id`, plus `merged_into_num`. Rollup keys, when added: `missions:{running,waiting,idle,quiet,closed}`, `needs_you`, `open_items`, `last_activity_at`.

- [ ] **Step 1: Write the failing tests**

Create `test/projects.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { upsertConversation, append } from '../src/journal.js'
import { createItem } from '../src/items.js'
import { createMission, joinMission, closeMission, createMilestone } from '../src/missions.js'
import {
  createProject, getProject, resolveProject, updateProject, closeProject, mergeProject, listProjects, projectDetail, MERGE_HOPS_MAX,
} from '../src/projects.js'

function seeded() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','dev-2','h',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(9,1,'agent','priv-box','h2',0,1)").run()
  for (const id of ['c1', 'c2', 'c3']) upsertConversation(db, { id, ownerUserId: 1, title: id, agentDeviceId: 7 })
  upsertConversation(db, { id: 'secret', ownerUserId: 1, title: 'S', agentDeviceId: 9 })
  return db
}
const mk = (db, extra = {}) => createProject(db, { userId: 1, deviceId: 7, createdBy: 'agent', title: 'Promo launch', ...extra })
const mission = (db, convoId, title, deviceId = 7) => createMission(db, { userId: 1, deviceId, createdBy: 'agent', convoId, title }).mission
const file = (db, missionId, projectId) => db.prepare('UPDATE missions SET project_id=? WHERE id=?').run(projectId, missionId)

test('createProject: shared numbering, pj_ id, optional origin, idempotent replay; getProject by id, #n and n', () => {
  const db = seeded()
  mission(db, 'c1', 'M')   // #1
  const r = mk(db, { idemKey: '7:k', convoId: 'c1', body: 'goal' })
  assert.equal(r.duplicate, false)
  assert.match(r.project.id, /^pj_/); assert.equal(r.project.num, 2); assert.equal(r.project.state, 'open')
  assert.equal(r.project.origin_convo_id, 'c1'); assert.equal(r.project.body, 'goal')
  for (const k of ['idem_key', 'status_device_id', 'status_hidden']) assert.equal(k in r.project, false, k)
  assert.equal(r.project.merged_into_num, null)
  assert.equal(mk(db, { idemKey: '7:k' }).duplicate, true)
  assert.equal(mk(db).project.origin_convo_id, null)
  for (const ref of [r.project.id, '#2', 2, '2']) assert.equal(getProject(db, 1, ref).id, r.project.id)
  assert.equal(getProject(db, 1, 'pj_nope'), null); assert.equal(getProject(db, 2, 2), null); assert.equal(getProject(db, 1, '#x'), null)
})

test('project sieve: private origin (conversation or device) hides the project; a privately written status reads four nulls', () => {
  const db = seeded()
  const fromSecret = mk(db, { convoId: 'secret', title: 'Secret project' }).project
  const byPrivateBox = createProject(db, { userId: 1, deviceId: 9, createdBy: 'agent', title: 'Box project' }).project
  const pub = mk(db).project
  for (const p of [fromSecret, byPrivateBox]) assert.equal(getProject(db, 1, p.id, { excludePrivateOwned: true }), null)
  assert.deepEqual(listProjects(db, 1, { excludePrivateOwned: true }).map((p) => p.id), [pub.id])
  assert.equal(listProjects(db, 1).length, 3)
  updateProject(db, { userId: 1, projectId: pub.id, fields: { status: 'Private news' }, statusWriter: { by: 'agent', convoId: 'secret', deviceId: 9 } })
  assert.equal(getProject(db, 1, pub.id).status, 'Private news')
  const sieved = getProject(db, 1, pub.id, { excludePrivateOwned: true })
  assert.deepEqual([sieved.status, sieved.status_by, sieved.status_convo_id, sieved.status_updated_at], [null, null, null, null])
})

test('updateProject: title/body/status as for missions; a status string needs a writer; null clears; closed refuses', () => {
  const db = seeded()
  const p = mk(db).project
  const up = updateProject(db, { userId: 1, projectId: p.id, fields: { title: 'Renamed', status: 'On track' }, statusWriter: { by: 'user', convoId: null, deviceId: 7 } })
  assert.equal(up.title, 'Renamed'); assert.equal(up.status, 'On track'); assert.equal(up.status_by, 'user'); assert.ok(up.status_updated_at)
  assert.throws(() => updateProject(db, { userId: 1, projectId: p.id, fields: { status: 'x' } }), /status_writer_required/)
  assert.equal(updateProject(db, { userId: 1, projectId: p.id, fields: { status: null } }).status_updated_at, null)
  assert.equal(updateProject(db, { userId: 1, projectId: 'pj_nope', fields: { title: 'x' } }), null)
  closeProject(db, { userId: 1, projectId: p.id, by: 'user', summary: 'done' })
  assert.throws(() => updateProject(db, { userId: 1, projectId: p.id, fields: { title: 'x' } }), /closed/)
})

test('closeProject: an agent is blocked by open missions (listed through the sieve); the user closes over them, recorded, missions stay open and filed', () => {
  const db = seeded()
  const p = mk(db).project
  const open = mission(db, 'c1', 'Open work'); const hidden = mission(db, 'secret', 'Hidden work', 9)
  file(db, open.id, p.id); file(db, hidden.id, p.id)
  let err
  try { closeProject(db, { userId: 1, projectId: p.id, by: 'agent', summary: 's', excludePrivateOwned: true }) } catch (e) { err = e }
  assert.equal(err.message, 'open_missions'); assert.deepEqual(err.missions, [{ num: open.num, title: 'Open work' }])
  const r = closeProject(db, { userId: 1, projectId: p.id, by: 'user', summary: 'Shipped' })
  assert.equal(r.project.state, 'closed'); assert.equal(r.project.closed_by, 'user')
  assert.equal(r.project.closed_over_open_missions, 2); assert.equal(r.project.close_summary, 'Shipped')
  assert.equal(db.prepare('SELECT project_id, state FROM missions WHERE id=?').get(open.id).project_id, p.id)
  assert.throws(() => closeProject(db, { userId: 1, projectId: p.id, by: 'user', summary: 'again' }), /closed/)
  const empty = mk(db, { title: 'Empty' }).project
  assert.equal(closeProject(db, { userId: 1, projectId: empty.id, by: 'agent', summary: 'nothing left' }).project.state, 'closed')
})

test('mergeProject: moves every mission (open and closed), closes the source as merged; resolveProject follows the chain', () => {
  const db = seeded()
  const a = mk(db, { title: 'A' }).project; const b = mk(db, { title: 'B' }).project; const c = mk(db, { title: 'C' }).project
  const m1 = mission(db, 'c1', 'm1'); const m2 = mission(db, 'c2', 'm2')
  file(db, m1.id, a.id); file(db, m2.id, a.id)
  closeMission(db, { userId: 1, missionId: m2.id, by: 'user', summary: 'x' })
  const r = mergeProject(db, { userId: 1, projectId: a.id, intoId: b.id, by: 'user' })
  assert.deepEqual(r.movedMissionIds.sort(), [m1.id, m2.id].sort())
  assert.equal(r.merged.state, 'closed'); assert.equal(r.merged.merged_into, b.id); assert.equal(r.merged.merged_into_num, b.num)
  assert.equal(r.merged.close_summary, `Merged into #${b.num}`)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM missions WHERE project_id=?').get(b.id).n, 2)
  mergeProject(db, { userId: 1, projectId: b.id, intoId: c.id, by: 'agent' })
  const res = resolveProject(db, 1, `#${a.num}`)
  assert.equal(res.project.id, c.id); assert.deepEqual(res.mergedFrom, { id: a.id, num: a.num })
  assert.equal(resolveProject(db, 1, c.id).mergedFrom, null)
  assert.throws(() => mergeProject(db, { userId: 1, projectId: c.id, intoId: c.id, by: 'user' }), /same_project/)
  assert.throws(() => mergeProject(db, { userId: 1, projectId: a.id, intoId: c.id, by: 'user' }), /closed/)
  const d = mk(db, { title: 'D' }).project
  assert.throws(() => mergeProject(db, { userId: 1, projectId: d.id, intoId: a.id, by: 'user' }), /into_closed/)
  assert.equal(MERGE_HOPS_MAX, 16)
})

test('listProjects: rollups count mission activity, sum needs_you/open_items, and take the latest activity; state filter; newest activity first', () => {
  const db = seeded()
  const p = mk(db, { title: 'Busy' }).project; const q = mk(db, { title: 'Quiet one' }).project
  const running = mission(db, 'c1', 'r')
  const waiting = mission(db, 'c2', 'w'); db.prepare("UPDATE conversations SET session_state='done' WHERE id='c2'").run()
  createItem(db, { userId: 1, originDeviceId: 7, createdBy: 'agent', kind: 'question', title: 'Q?', originConvoId: 'c2' })
  const done = mission(db, 'c3', 'd'); closeMission(db, { userId: 1, missionId: done.id, by: 'user', summary: 'x' })
  for (const m of [running, waiting, done]) file(db, m.id, p.id)
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000
  db.prepare('UPDATE projects SET created_at=? WHERE id=?').run(old, q.id)
  const rows = listProjects(db, 1)
  assert.deepEqual(rows.map((r) => r.id), [p.id, q.id])
  assert.deepEqual(rows[0].missions, { running: 1, waiting: 1, idle: 0, quiet: 0, closed: 1 })
  assert.equal(rows[0].needs_you, 1); assert.equal(rows[0].open_items, 1)
  assert.deepEqual(rows[1].missions, { running: 0, waiting: 0, idle: 0, quiet: 0, closed: 0 })
  assert.equal(rows[1].last_activity_at, old)
  closeProject(db, { userId: 1, projectId: q.id, by: 'user', summary: 'x' })
  assert.deepEqual(listProjects(db, 1, { state: 'open' }).map((r) => r.id), [p.id])
  assert.deepEqual(listProjects(db, 1, { state: 'closed' }).map((r) => r.id), [q.id])
})

test('projectDetail: missions, needs-you items with mission_num, 5 latest milestones with mission_num, sessions per box — all sieved', () => {
  const db = seeded()
  const p = mk(db).project
  const m1 = mission(db, 'c1', 'one'); const m2 = mission(db, 'c2', 'two')
  file(db, m1.id, p.id); file(db, m2.id, p.id)
  joinMission(db, { userId: 1, missionId: m1.id, convoId: 'secret' })
  createItem(db, { userId: 1, originDeviceId: 7, createdBy: 'agent', kind: 'question', title: 'Public Q', originConvoId: 'c1' })
  createItem(db, { userId: 1, originDeviceId: 9, createdBy: 'agent', kind: 'question', title: 'Private Q', originConvoId: 'secret' })
  const post = (convoId, title, deviceId = 7) => createMilestone(db, {
    userId: 1, deviceId, createdBy: 'agent', convoId, kind: 'progress', title,
    appendMarker: (payload) => append(db, { userId: 1, convoId, sender: 'agent:x', type: 'milestone', payload }),
  })
  for (let i = 0; i < 6; i++) post('c2', `step ${i}`)
  post('secret', 'private step', 9)
  const full = projectDetail(db, 1, p)
  assert.deepEqual(full.missions.map((m) => m.id).sort(), [m1.id, m2.id].sort())
  assert.equal(full.needs_you.length, 2); assert.equal(full.needs_you[0].mission_num !== undefined, true)
  assert.equal(full.recent_milestones.length, 5); assert.equal(full.recent_milestones[0].title, 'private step')
  assert.equal(full.recent_milestones[0].mission_num, m1.num)
  assert.deepEqual(full.sessions_by_box, { 'dev-2': 2, 'priv-box': 1 })
  assert.equal(full.project.needs_you, 2)
  const sieved = projectDetail(db, 1, p, { excludePrivateOwned: true })
  assert.deepEqual(sieved.needs_you.map((i) => i.title), ['Public Q'])
  assert.equal(sieved.recent_milestones[0].title, 'step 5')
  assert.equal(JSON.stringify(sieved).includes('Private'), false)
  assert.equal(JSON.stringify(sieved).includes('private step'), false)
  assert.deepEqual(sieved.sessions_by_box, { 'dev-2': 2 })
  assert.equal(sieved.project.needs_you, 1)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=30000 test/projects.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: FAIL with `Cannot find module '…/src/projects.js'`.

- [ ] **Step 3: Implement `src/projects.js`**

```js
// Pure DB state for projects (spec 2026-09-30 projects & mission links §4).
// No hub, no markers here — src/projects-http.js owns side effects. Same
// stance as missions.js: every recoverable failure is a tagged Error the
// HTTP layer maps to one status.
import { nextNum, newId } from './items.js'
import { listMissions, milestoneRow, ORIGIN_SIEVE } from './missions.js'

export const MERGE_HOPS_MAX = 16
const STATUS_FIELDS = ['status', 'status_by', 'status_convo_id', 'status_updated_at']
const now = () => Date.now()

// "The privacy sieve works as for missions" (§4.1): a project born in a
// private-owned conversation, or created by a private device, is invisible
// to an ordinary agent — the origin sieve — and a status written from/by
// one reads as four nulls — the status sieve. Read-time, current flags.
const PROJECT_ORIGIN_SIEVE = `(
  NOT EXISTS (SELECT 1 FROM devices od WHERE od.id = p.origin_device_id AND od.private = 1)
  AND NOT EXISTS (SELECT 1 FROM conversations oc JOIN devices od ON od.id = oc.agent_device_id
                  WHERE oc.id = p.origin_convo_id AND od.private = 1)
)`
const PROJECT_STATUS_PRIVATE = `(
  EXISTS (SELECT 1 FROM devices sd WHERE sd.id = p.status_device_id AND sd.private = 1)
  OR EXISTS (SELECT 1 FROM conversations sc JOIN devices sd ON sd.id = sc.agent_device_id
             WHERE sc.id = p.status_convo_id AND sd.private = 1)
)`

const selectSql = (excludePrivateOwned) => `SELECT p.*,
    ${excludePrivateOwned ? PROJECT_STATUS_PRIVATE : '0'} AS status_hidden,
    (SELECT q.num FROM projects q WHERE q.id = p.merged_into) AS merged_into_num
  FROM projects p`

// idem_key and status_device_id are internal; status_hidden is the
// per-caller verdict. merged_into_num is computed ("Merged into #N").
export function projectRow(row) {
  if (!row) return null
  const { idem_key: _idemKey, status_device_id: _statusDeviceId, status_hidden: hidden, ...out } = row
  out.closed_over_open_missions = Number(out.closed_over_open_missions || 0)
  out.merged_into_num = out.merged_into_num ?? null
  if (Number(hidden || 0)) for (const k of STATUS_FIELDS) out[k] = null
  return out
}

export function getProject(db, userId, idOrNum, { excludePrivateOwned = false } = {}) {
  const sieve = excludePrivateOwned ? `AND ${PROJECT_ORIGIN_SIEVE}` : ''
  if (typeof idOrNum === 'string' && idOrNum.startsWith('pj_')) {
    return projectRow(db.prepare(`${selectSql(excludePrivateOwned)} WHERE p.id=? AND p.user_id=? ${sieve}`).get(idOrNum, userId))
  }
  const n = Number(String(idOrNum).replace(/^#/, ''))
  if (!Number.isInteger(n) || n < 1) return null
  return projectRow(db.prepare(`${selectSql(excludePrivateOwned)} WHERE p.num=? AND p.user_id=? ${sieve}`).get(n, userId))
}

// Reads (GET /projects/:id, /lookup) follow a merge to the project that
// survived it (§4.2 "redirect to the target"), through the caller's sieve
// at every hop. Writes never do — they address the row itself.
export function resolveProject(db, userId, idOrNum, opts = {}) {
  const first = getProject(db, userId, idOrNum, opts)
  if (!first) return null
  let project = first
  for (let hops = 0; project.merged_into && hops < MERGE_HOPS_MAX; hops++) {
    const next = getProject(db, userId, project.merged_into, opts)
    if (!next) return null
    project = next
  }
  return { project, mergedFrom: project.id === first.id ? null : { id: first.id, num: first.num } }
}

export function createProject(db, { userId, deviceId, createdBy, convoId = null, title, body = '', idemKey = null, excludePrivateOwned = false }) {
  return db.transaction(() => {
    const replay = () => {
      const dup = idemKey && db.prepare('SELECT id FROM projects WHERE user_id=? AND idem_key=?').get(userId, idemKey)
      return dup ? { project: getProject(db, userId, dup.id, { excludePrivateOwned }), duplicate: true } : null
    }
    const early = replay()
    if (early) return early
    const id = newId('pj')
    const num = nextNum(db, userId)
    const ts = now()
    try {
      db.prepare(`INSERT INTO projects(id,user_id,num,state,title,body,origin_convo_id,origin_device_id,created_by,idem_key,created_at,updated_at)
        VALUES(?,?,?,'open',?,?,?,?,?,?,?,?)`).run(id, userId, num, title, body, convoId, deviceId, createdBy, idemKey, ts, ts)
    } catch (err) {
      if (idemKey && err.code === 'SQLITE_CONSTRAINT_UNIQUE') { const late = replay(); if (late) return late }
      throw err
    }
    return { project: getProject(db, userId, id, { excludePrivateOwned }), duplicate: false }
  })()
}

// Mirrors updateMission: statusWriter {by, convoId, deviceId} is required
// for a status string; the five status columns are written as one set.
export function updateProject(db, { userId, projectId, fields, statusWriter = null, excludePrivateOwned = false }) {
  return db.transaction(() => {
    const cur = db.prepare('SELECT state FROM projects WHERE id=? AND user_id=?').get(projectId, userId)
    if (!cur) return null
    if (cur.state === 'closed') throw new Error('closed')
    const ts = now()
    const sets = []; const args = []
    if (fields.title !== undefined) { sets.push('title=?'); args.push(fields.title) }
    if (fields.body !== undefined) { sets.push('body=?'); args.push(fields.body) }
    if (fields.status !== undefined) {
      if (fields.status !== null && !statusWriter) throw new Error('status_writer_required')
      const w = fields.status === null ? { by: null, convoId: null, deviceId: null } : statusWriter
      sets.push('status=?', 'status_by=?', 'status_convo_id=?', 'status_device_id=?', 'status_updated_at=?')
      args.push(fields.status, w.by, w.convoId ?? null, w.deviceId ?? null, fields.status === null ? null : ts)
    }
    sets.push('updated_at=?'); args.push(ts)
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id=? AND user_id=?`).run(...args, projectId, userId)
    return getProject(db, userId, projectId, { excludePrivateOwned })
  })()
}

// §4.2: open missions block an agent (the Coordinator) — 409 open_missions,
// listed through the caller's sieve, while a hidden one still blocks. The
// user closes over them; the count is recorded and the missions stay open
// and filed.
export function closeProject(db, { userId, projectId, by, summary, excludePrivateOwned = false }) {
  return db.transaction(() => {
    const p = db.prepare('SELECT id, state FROM projects WHERE id=? AND user_id=?').get(projectId, userId)
    if (!p) throw new Error('no_project')
    if (p.state === 'closed') throw new Error('closed')
    const open = db.prepare(`SELECT m.num, m.title, NOT ${ORIGIN_SIEVE} AS is_private
      FROM missions m WHERE m.project_id = ? AND m.user_id = ? AND m.state = 'open' ORDER BY m.num`).all(p.id, userId)
    if (by === 'agent' && open.length) {
      const e = new Error('open_missions')
      e.missions = open.filter((m) => !excludePrivateOwned || !m.is_private).map(({ num, title }) => ({ num, title }))
      throw e
    }
    const ts = now()
    db.prepare(`UPDATE projects SET state='closed', close_summary=?, closed_by=?, closed_over_open_missions=?, closed_at=?, updated_at=?
      WHERE id=?`).run(summary, by, open.length, ts, ts, p.id)
    return { project: getProject(db, userId, p.id, { excludePrivateOwned }) }
  })()
}

// §4.2 merge: every mission (any state) moves to `into`; the source closes
// with "Merged into #N" and records merged_into. movedMissionIds lets the
// HTTP layer write one `updated` marker (project_changed) per mission.
export function mergeProject(db, { userId, projectId, intoId, by, excludePrivateOwned = false }) {
  return db.transaction(() => {
    const src = db.prepare('SELECT id, state FROM projects WHERE id=? AND user_id=?').get(projectId, userId)
    const dst = db.prepare('SELECT id, num, state FROM projects WHERE id=? AND user_id=?').get(intoId, userId)
    if (!src || !dst) throw new Error('no_project')
    if (src.id === dst.id) throw new Error('same_project')
    if (src.state === 'closed') throw new Error('closed')
    if (dst.state === 'closed') throw new Error('into_closed')
    const ts = now()
    const moved = db.prepare('SELECT id FROM missions WHERE project_id=? AND user_id=? ORDER BY num').all(src.id, userId).map((r) => r.id)
    db.prepare('UPDATE missions SET project_id=?, updated_at=? WHERE project_id=? AND user_id=?').run(dst.id, ts, src.id, userId)
    db.prepare(`UPDATE projects SET state='closed', close_summary=?, closed_by=?, closed_at=?, merged_into=?, updated_at=? WHERE id=?`)
      .run(`Merged into #${dst.num}`, by, ts, dst.id, ts, src.id)
    db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(ts, dst.id)
    return {
      project: getProject(db, userId, dst.id, { excludePrivateOwned }),
      merged: getProject(db, userId, src.id, { excludePrivateOwned }),
      movedMissionIds: moved,
    }
  })()
}

const emptyRollup = () => ({ missions: { running: 0, waiting: 0, idle: 0, quiet: 0, closed: 0 }, needs_you: 0, open_items: 0, lastMissionActivityAt: null })

// Rollups come from the caller's OWN sieved mission rows (listMissions), so
// a hidden mission never adds to a count, a needs-you total or the time.
export function rollupsByProject(missions) {
  const out = new Map()
  for (const m of missions) {
    if (!m.project_id) continue
    if (!out.has(m.project_id)) out.set(m.project_id, emptyRollup())
    const r = out.get(m.project_id)
    r.missions[m.activity] += 1
    r.needs_you += m.needs_you
    r.open_items += m.open_items
    r.lastMissionActivityAt = Math.max(r.lastMissionActivityAt ?? 0, m.last_activity_at)
  }
  return out
}

export function withRollup(project, rollup = emptyRollup()) {
  const { lastMissionActivityAt, ...rest } = rollup
  const last = Math.max(...[project.created_at, project.status_updated_at, lastMissionActivityAt].filter((v) => v != null))
  return { ...project, ...rest, last_activity_at: last }
}

export function projectWithRollup(db, userId, project, { excludePrivateOwned = false } = {}) {
  if (!project) return null
  return withRollup(project, rollupsByProject(listMissions(db, userId, { projectId: project.id, excludePrivateOwned })).get(project.id))
}

export function listProjects(db, userId, { state = null, excludePrivateOwned = false } = {}) {
  const where = ['p.user_id = ?']; const args = [userId]
  if (state) { where.push('p.state = ?'); args.push(state) }
  if (excludePrivateOwned) where.push(PROJECT_ORIGIN_SIEVE)
  const rows = db.prepare(`${selectSql(excludePrivateOwned)} WHERE ${where.join(' AND ')}`).all(...args).map(projectRow)
  const rollups = rollupsByProject(listMissions(db, userId, { excludePrivateOwned }))
  return rows.map((p) => withRollup(p, rollups.get(p.id)))
    .sort((a, b) => (b.last_activity_at - a.last_activity_at) || (b.created_at - a.created_at))
}

// GET /projects/:id (§4.2). Every array goes through the caller's sieve:
// private-owned conversations (convoSieve) and private-origin missions
// (ORIGIN_SIEVE) are dropped from items, milestones and session counts.
export function projectDetail(db, userId, project, { excludePrivateOwned = false } = {}) {
  const missions = listMissions(db, userId, { projectId: project.id, excludePrivateOwned })
  const convoSieve = excludePrivateOwned ? 'AND NOT EXISTS (SELECT 1 FROM devices pd WHERE pd.id = c.agent_device_id AND pd.private = 1)' : ''
  const originSieve = excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''
  const needsYou = db.prepare(`SELECT i.id, i.num, i.kind, i.state, i.awaiting, i.title, i.origin_convo_id, i.updated_at,
      i.mission_id, m.num AS mission_num
    FROM items i JOIN missions m ON m.id = i.mission_id JOIN conversations c ON c.id = i.origin_convo_id
    WHERE m.project_id = ? AND m.user_id = ? AND i.state = 'open' AND i.awaiting = 'user' ${convoSieve} ${originSieve}
    ORDER BY i.updated_at DESC`).all(project.id, userId)
  const recent = db.prepare(`SELECT l.*, m.num AS mission_num
    FROM milestones l JOIN missions m ON m.id = l.mission_id JOIN conversations c ON c.id = l.convo_id
    WHERE m.project_id = ? AND m.user_id = ? ${convoSieve} ${originSieve}
    ORDER BY l.created_at DESC, l.seq DESC LIMIT 5`).all(project.id, userId).map(milestoneRow)
  const boxes = db.prepare(`SELECT bd.name AS box, COUNT(DISTINCT c.id) AS n
    FROM missions m
    JOIN mission_conversations l ON l.mission_id = m.id AND l.ended_at IS NULL
    JOIN conversations c ON c.id = l.convo_id AND c.parent_convo_id IS NULL
    JOIN devices bd ON bd.id = c.agent_device_id
    WHERE m.project_id = ? AND m.user_id = ? AND m.state = 'open' ${excludePrivateOwned ? 'AND bd.private = 0' : ''} ${originSieve}
    GROUP BY bd.name ORDER BY bd.name`).all(project.id, userId)
  return {
    project: withRollup(project, rollupsByProject(missions).get(project.id)),
    missions,
    needs_you: needsYou,
    recent_milestones: recent,
    sessions_by_box: Object.fromEntries(boxes.map((b) => [b.box, b.n])),
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-timeout=30000 test/projects.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/projects.js test/projects.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "projects: pure state — create, sieve, status, close over open missions, merge with redirect, rollups, detail

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Filing missions — `project` on `POST /missions` and `PATCH /missions/:id`, `project_changed`

**Files:**
- Modify: `src/missions-marker.js` (`missionMarkerPayload` gains `projectChanged`)
- Modify: `src/missions.js` (`createMission({projectId})`, `updateMission` accepts `fields.projectId`)
- Modify: `src/missions-http.js` (`projectRefOf`; `handleCreate`, `handlePatch`, `emitMissionMarker`; export `writableConvo`, `statusConvoOf`, `emitMissionMarker`, `byOf`)
- Test: create `test/projects-http.test.js`; `test/missions.test.js` (marker payload)

**Interfaces:**
- Consumes: `getProject` (Task 9).
- Produces:
  - `missionMarkerPayload({…, projectChanged = false})` → `project_changed: true` when set.
  - `emitMissionMarker(ctx, who, {…, projectChanged = false})` (exported).
  - `projectRefOf(db, who, ref) → {projectId}|{status: 400|404|409}` (exported).
  - `updateMission` fields may carry `projectId: string|null`. A closed mission accepts a PATCH whose only field is `projectId`.
  - `createMission({…, projectId = null})`.

- [ ] **Step 1: Write the failing tests**

In `test/missions.test.js` `'missionMarkerPayload: status_changed appears only when statusChanged is true …'` (~line 695), append:

```js
  assert.equal(missionMarkerPayload({ mission: { id: 'ms_1', num: 1, title: 'T' }, action: 'updated', by: 'agent', projectChanged: true }).project_changed, true)
  assert.equal('project_changed' in missionMarkerPayload({ mission: { id: 'ms_1', num: 1, title: 'T' }, action: 'updated', by: 'agent' }), false)
```

Create `test/projects-http.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { pinDevicePrivate } from '../src/db.js'
import { saveGithubIdentity } from '../src/github-accounts.js'
import { createProject, closeProject } from '../src/projects.js'

async function fleet(t) {
  const s = await startTestServer({})
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  for (const id of ['c1', 'c2', 'c3']) upsertConversation(s.db, { id, ownerUserId: dan.id, title: id, agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'secret', ownerUserId: dan.id, title: 'S', agentDeviceId: priv.deviceId })
  const tok = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw', device_name: 'mac' } })).json.token
  return { s, dan, pat, agent, priv, client: await tok('dan'), patClient: await tok('pat') }
}
const seedProject = (s, dan, deviceId, extra = {}) => createProject(s.db, { userId: dan.id, deviceId, createdBy: 'agent', title: 'Promo launch', ...extra }).project
const startMission = (s, token, body) => s.http('/missions', { method: 'POST', token, body: { title: 'M', convo_id: 'c1', ...body } })

test('POST /missions {project}: files the new mission; unknown/hidden 404, closed 409 project_closed, bad type 400; ignored on existing', async (t) => {
  const { s, dan, agent, priv } = await fleet(t)
  const p = seedProject(s, dan, agent.deviceId)
  const r = await startMission(s, agent.token, { project: `#${p.num}` })
  assert.equal(r.status, 201); assert.equal(r.json.mission.project_id, p.id); assert.equal(r.json.mission.project_num, p.num)
  const again = await startMission(s, agent.token, { project: null, title: 'other' })
  assert.equal(again.json.existing, true); assert.equal(again.json.mission.project_id, p.id)
  assert.equal((await startMission(s, agent.token, { convo_id: 'c2', project: '#999' })).status, 404)
  const hidden = seedProject(s, dan, priv.deviceId, { title: 'Hidden' })
  assert.equal((await startMission(s, agent.token, { convo_id: 'c2', project: hidden.id })).status, 404)
  const closed = seedProject(s, dan, agent.deviceId, { title: 'Done' })
  closeProject(s.db, { userId: dan.id, projectId: closed.id, by: 'user', summary: 'x' })
  const refused = await startMission(s, agent.token, { convo_id: 'c2', project: closed.num })
  assert.equal(refused.status, 409); assert.equal(refused.json.blocked_by, 'project_closed')
  assert.equal((await startMission(s, agent.token, { convo_id: 'c2', project: { id: p.id } })).status, 400)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM missions WHERE origin_convo_id='c2'").get().n, 0, 'nothing created on a refusal')
})

test('PATCH /missions/:id {project}: moves and detaches with a project_changed marker on the origin; a closed mission may be refiled but not edited; a colleague never sees project_id', async (t) => {
  const { s, dan, pat, agent, client, patClient } = await fleet(t)
  const p = seedProject(s, dan, agent.deviceId); const q = seedProject(s, dan, agent.deviceId, { title: 'Other' })
  const m = (await startMission(s, agent.token, {})).json.mission
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const patch = (body, token = agent.token) => s.http(`/missions/${m.id}`, { method: 'PATCH', token, body })
  const filed = await patch({ project: p.id })
  assert.equal(filed.status, 200); assert.equal(filed.json.mission.project_num, p.num)
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.payload.action === 'updated')
  assert.equal(marker.convo_id, 'c1'); assert.equal(marker.payload.project_changed, true)
  ws.close()
  assert.equal((await patch({ project: null })).json.mission.project_id, null)
  await s.http(`/missions/${m.id}/close`, { method: 'POST', token: client, body: { summary: 'done' } })
  const refiled = await patch({ project: `#${q.num}` })
  assert.equal(refiled.status, 200); assert.equal(refiled.json.mission.project_id, q.id)
  assert.equal((await patch({ title: 'x' })).status, 409)
  assert.equal((await patch({ project: q.id, title: 'x' })).status, 409, 'a closed mission refiles with project alone')
  assert.equal((await patch({})).status, 400)
  // A colleague reading the shared mission never learns which project it is in.
  for (const [u, gid] of [[dan, 1], [pat, 2]]) {
    saveGithubIdentity(s.db, { userId: u.id, host: 'github.com', identity: { github_id: gid, login: u.name, scopes: ['github.com/matronhq'] }, token: `t${gid}`, now: 1 })
  }
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, repo: 'github.com/matronhq/x' })
  const shared = await s.http('/missions?scope=shared', { token: patClient })
  assert.equal(shared.json.missions.length, 1)
  assert.equal(shared.json.missions[0].project_id, null); assert.equal(shared.json.missions[0].project_num, null)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=30000 test/projects-http.test.js test/missions.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: FAIL. `project` is ignored on POST (no `project_id`), a PATCH with only `project` is a 400, and `project_changed` is absent.

- [ ] **Step 3: Implement the marker flag**

In `src/missions-marker.js`, change the signature to `missionMarkerPayload({ mission, action, by, openItemNums = null, withTitle = true, statusChanged = false, byConvoId = null, projectChanged = false })`. Add after the `statusChanged` line:

```js
  if (projectChanged) out.project_changed = true
```

Also add to the comment above it: "project_changed (spec 2026-09-30 §4.2) is present only on an `updated` that moved the mission into, out of or between projects — the apps' cue to refresh GET /projects."

- [ ] **Step 4: Implement storage in `src/missions.js`**

In `createMission`, add `projectId = null` to the destructured parameters and change the INSERT to:

```js
      db.prepare(`INSERT INTO missions(id,user_id,num,state,title,body,origin_convo_id,origin_device_id,created_by,idem_key,created_at,updated_at,project_id)
        VALUES(?,?,?,'open',?,?,?,?,?,?,?,?,?)`).run(id, userId, num, title, body, convoId, deviceId, createdBy, idemKey, ts, ts, projectId)
```

In `updateMission`, replace `if (cur.state === 'closed') throw new Error('closed')` with:

```js
    // Refiling (spec 2026-09-30 §4.2) stays legal on a closed mission — a
    // finished mission must stay correctable, like an item's move target —
    // but nothing else about it changes.
    const onlyProject = Object.keys(fields).length > 0 && Object.keys(fields).every((k) => k === 'projectId')
    if (cur.state === 'closed' && !onlyProject) throw new Error('closed')
```

and add after the `fields.body` line:

```js
    if (fields.projectId !== undefined) { sets.push('project_id=?'); args.push(fields.projectId) }
```

- [ ] **Step 5: Implement the routes in `src/missions-http.js`**

Add `import { getProject } from './projects.js'`. Export the four helpers by prefixing `export` to `const byOf`, `function writableConvo`, `function emitMissionMarker` and `function statusConvoOf`.

Change `emitMissionMarker`'s parameter object to `{ mission, action, convoId, openItemNums = null, statusChanged = false, byConvoId = null, projectChanged = false }` and pass `projectChanged` into `missionMarkerPayload`.

Add:

```js
// `project` on POST /missions and PATCH /missions/:id (spec 2026-09-30
// §4.2): id, "#n" or n — or null (take it out). Resolved through the
// caller's own sieve, so a project it cannot read is the same 404 as one
// that does not exist. Filing INTO a closed project is refused.
export function projectRefOf(db, who, ref) {
  if (ref === null) return { projectId: null }
  if (typeof ref !== 'string' && typeof ref !== 'number') return { status: 400 }
  const p = getProject(db, who.userId, ref, { excludePrivateOwned: filteredAgent(db, who) })
  if (!p) return { status: 404 }
  if (p.state === 'closed') return { status: 409 }
  return { projectId: p.id }
}

// The one mapping every caller of projectRefOf uses. Returns true when it
// answered (the caller returns), false when the reference resolved.
function refusedProjectRef(res, ref) {
  if (ref.status === 400) return badRequest(res)
  if (ref.status === 404) return notFound(res)
  if (ref.status === 409) return conflict(res, { blocked_by: 'project_closed' })
  return false
}
```

In `handleCreate`, after the `attach` type check, add:

```js
  let projectId = null
  if (body.project != null) {
    const ref = projectRefOf(db, who, body.project)
    if (refusedProjectRef(res, ref)) return true
    projectId = ref.projectId
  }
```

and pass `projectId` into `createMission`.

Replace the body of `handlePatch` down to the `updateMission` call with:

```js
  const body = await readBody(req)
  const v = validateMissionFields(body, { partial: true })
  if (!v.ok) return badRequest(res)
  const fields = { ...v.value }
  if (body.project !== undefined) {
    const ref = projectRefOf(db, who, body.project)
    if (refusedProjectRef(res, ref)) return true
    fields.projectId = ref.projectId
  }
  if (Object.keys(fields).length === 0) return badRequest(res)
  const statusWriter = typeof fields.status === 'string'
    ? { by: byOf(who), convoId: statusConvoOf(db, who, body.convo_id), deviceId: who.deviceId }
    : null
  let updated
  try {
    updated = updateMission(db, { userId: who.userId, missionId: mission.id, fields, statusWriter, excludePrivateOwned: filteredAgent(db, who) })
  } catch (err) { if (err.message === 'closed') return conflict(res, { blocked_by: 'closed' }); throw err }
  if (!updated) return notFound(res)
  emitMissionMarker(ctx, who, {
    mission: updated, action: 'updated', convoId: updated.origin_convo_id,
    statusChanged: fields.status !== undefined,
    projectChanged: fields.projectId !== undefined && fields.projectId !== mission.project_id,
  })
  json(res, 200, { mission: updated })
  return true
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test --test-timeout=30000 test/projects-http.test.js test/missions.test.js test/missions-http.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 7: Run the whole suite**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/missions-marker.js src/missions.js src/missions-http.js test/projects-http.test.js test/missions.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "missions: file into a project on create and PATCH; project_changed on the updated marker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: `/projects` routes, Coordinator gate, merge redirect, `/lookup`

**Files:**
- Create: `src/projects-http.js`
- Modify: `src/http.js` (import, and mount after `handleMissionsRoute`, line ~257)
- Modify: `src/lookup-http.js` (`resolve` and the response)
- Test: `test/projects-http.test.js`

**Interfaces:**
- Consumes: Tasks 9 and 10 (`projects.js`, `writableConvo`, `statusConvoOf`, `emitMissionMarker`, `byOf`, `validateMissionFields`, `getMission`).
- Produces:
  - `handleProjectsRoute(ctx, req, res, url, who) → Promise<boolean>`, serving:
    - `POST /projects` → 201 `{project}` (replay 200)
    - `GET /projects?state=` → `{projects}`
    - `GET /projects/:id` → `{project, missions, needs_you, recent_milestones, sessions_by_box, merged_from?}`
    - `PATCH /projects/:id` → `{project}`
    - `POST /projects/:id/close {summary, convo_id?}` → `{project}`
    - `POST /projects/:id/merge {into, convo_id?}` → `{project, merged}`
  - `/lookup` answers `kind: 'project'` (plus `merged_from` after a merge).

- [ ] **Step 1: Write the failing tests**

Append to `test/projects-http.test.js`. Add `import { setCoordinatorConvoId } from '../src/coordinator.js'` to its imports.

```js
const newProject = (s, token, body = {}, headers = {}) => s.http('/projects', { method: 'POST', token, body: { title: 'Promo launch', ...body }, headers })

test('POST/GET/PATCH /projects: any agent creates (idempotent), lists with rollups, sets status; 400/404 on junk; a private-origin project is invisible to an ordinary agent', async (t) => {
  const { s, agent, priv, client } = await fleet(t)
  const r = await newProject(s, agent.token, { body: 'Launch week', convo_id: 'c1' }, { 'idempotency-key': 'p1' })
  assert.equal(r.status, 201)
  const p = r.json.project
  assert.match(p.id, /^pj_/); assert.equal(p.origin_convo_id, 'c1')
  assert.deepEqual(p.missions, { running: 0, waiting: 0, idle: 0, quiet: 0, closed: 0 })
  assert.equal((await newProject(s, agent.token, {}, { 'idempotency-key': 'p1' })).status, 200)
  assert.equal((await newProject(s, agent.token, { title: '' })).status, 400)
  assert.equal((await newProject(s, agent.token, { convo_id: 'nope' })).status, 404)
  assert.equal((await newProject(s, client, { title: 'From the app' })).status, 201)
  await startMission(s, agent.token, { project: p.id })
  const list = await s.http('/projects?state=open', { token: client })
  assert.equal(list.status, 200)
  const row = list.json.projects.find((x) => x.id === p.id)
  assert.equal(row.missions.running, 1); assert.equal(typeof row.last_activity_at, 'number')
  assert.equal((await s.http('/projects?state=bogus', { token: client })).status, 400)
  const st = await s.http(`/projects/${p.num}`, { method: 'PATCH', token: agent.token, body: { status: 'Launch Wed', convo_id: 'c1' } })
  assert.equal(st.status, 200); assert.equal(st.json.project.status, 'Launch Wed'); assert.equal(st.json.project.status_convo_id, 'c1')
  assert.equal((await s.http(`/projects/${p.num}`, { method: 'PATCH', token: agent.token, body: { status: 'x'.repeat(601) } })).status, 400)
  assert.equal((await s.http(`/projects/${p.num}`, { method: 'PATCH', token: agent.token, body: {} })).status, 400)
  const hidden = (await newProject(s, priv.token, { title: 'Secret', convo_id: 'secret' })).json.project
  assert.equal((await s.http(`/projects/${hidden.num}`, { token: agent.token })).status, 404)
  assert.equal((await s.http('/projects', { token: agent.token })).json.projects.some((x) => x.id === hidden.id), false)
  assert.equal((await s.http(`/projects/${hidden.num}`, { token: client })).status, 200)
  const detail = await s.http(`/projects/${p.id}`, { token: client })
  assert.deepEqual(Object.keys(detail.json).sort(), ['missions', 'needs_you', 'project', 'recent_milestones', 'sessions_by_box'])
  assert.deepEqual(detail.json.sessions_by_box, { 'dev-2': 1 })
})

test('close and merge: user or Coordinator only (403 not_coordinator otherwise); open missions block the Coordinator; merge moves missions with markers and redirects reads and /lookup', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const a = (await newProject(s, agent.token, { title: 'A' })).json.project
  const b = (await newProject(s, agent.token, { title: 'B' })).json.project
  const m = (await startMission(s, agent.token, { project: a.id })).json.mission
  const close = (id, token, extra = {}) => s.http(`/projects/${id}/close`, { method: 'POST', token, body: { summary: 'done', ...extra } })
  const merge = (id, token, extra = {}) => s.http(`/projects/${id}/merge`, { method: 'POST', token, body: { into: b.id, ...extra } })
  for (const extra of [{}, { convo_id: 'c1' }]) {
    const r = await close(a.id, agent.token, extra)
    assert.equal(r.status, 403); assert.deepEqual(r.json, { error: 'forbidden', detail: 'not_coordinator' })
    assert.equal((await merge(a.id, agent.token, extra)).status, 403)
  }
  setCoordinatorConvoId(s.db, dan.id, 'c2')
  const blocked = await close(a.id, agent.token, { convo_id: 'c2' })
  assert.equal(blocked.status, 409); assert.equal(blocked.json.blocked_by, 'open_missions')
  assert.deepEqual(blocked.json.missions, [{ num: m.num, title: 'M' }])
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const merged = await merge(a.id, agent.token, { convo_id: 'c2' })
  assert.equal(merged.status, 200)
  assert.equal(merged.json.project.id, b.id); assert.equal(merged.json.merged.merged_into, b.id)
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.payload.action === 'updated' && f.payload.project_changed)
  assert.equal(marker.payload.num, m.num); assert.equal(marker.convo_id, 'c1')
  ws.close()
  assert.equal((await s.http(`/missions/${m.id}`, { token: client })).json.mission.project_id, b.id)
  const redirected = await s.http(`/projects/${a.num}`, { token: client })
  assert.equal(redirected.status, 200); assert.equal(redirected.json.project.id, b.id)
  assert.deepEqual(redirected.json.merged_from, { id: a.id, num: a.num })
  const look = await s.http(`/lookup?user=dan&num=${a.num}`, { token: client })
  assert.deepEqual(look.json, { kind: 'project', id: b.id, merged_from: a.id, owner: { user_id: dan.id, name: 'dan' } })
  assert.deepEqual((await s.http(`/lookup?user=dan&num=${b.num}`, { token: client })).json, { kind: 'project', id: b.id, owner: { user_id: dan.id, name: 'dan' } })
  assert.equal((await s.http(`/projects/${a.id}`, { method: 'PATCH', token: client, body: { title: 'x' } })).status, 409, 'writes address the merged row')
  assert.equal((await merge(b.id, client, { into: b.id })).status, 400)
  const c = (await newProject(s, client, { title: 'C' })).json.project
  assert.equal((await merge(c.id, client, { into: a.id })).status, 409)
  assert.equal((await merge(c.id, client, { into: '#999' })).status, 404)
  const forced = await close(b.id, client)
  assert.equal(forced.status, 200); assert.equal(forced.json.project.closed_over_open_missions, 1)
  assert.equal((await close(b.id, client)).status, 409)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=30000 test/projects-http.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: FAIL. Every `/projects` call is 404 because no route is mounted.

- [ ] **Step 3: Implement `src/projects-http.js`**

```js
// HTTP surface of projects (spec 2026-09-30 projects & mission links §4.2).
// Validation, auth, the Coordinator gate and the one side effect projects
// have: moving missions (merge) writes each mission's `updated` marker with
// project_changed. Project create/update/close write no marker — apps
// refresh GET /projects on mission markers and while the tab is open.
import { json, readBody } from './http-body.js'
import { idemKeyOf, badRequest, notFound, conflict } from './http-who.js'
import { BODY_MAX } from './items.js'
import { validateMissionFields, getMission } from './missions.js'
import { writableConvo, statusConvoOf, emitMissionMarker, byOf } from './missions-http.js'
import { filteredAgent } from './privacy.js'
import { getCoordinatorConvoId } from './coordinator.js'
import {
  createProject, getProject, resolveProject, listProjects, projectDetail, projectWithRollup,
  updateProject, closeProject, mergeProject,
} from './projects.js'

const STATES = ['open', 'closed']

// Close and merge (Dan, Q3): the user, or the user's Coordinator — which
// proves it by naming its own conversation, the rule mission close uses.
// An agent that names none, or a conversation that isn't the Coordinator,
// is 403 not_coordinator; one it does not own is 404.
function coordinatorGate(db, who, convoId) {
  if (who.kind !== 'agent') return { ok: true }
  if (convoId === undefined) return { status: 403 }
  if (typeof convoId !== 'string' || !convoId) return { status: 400 }
  const convo = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(convoId)
  if (!convo || convo.owner_user_id !== who.userId || convo.agent_device_id !== who.deviceId) return { status: 404 }
  if (getCoordinatorConvoId(db, who.userId) !== convoId) return { status: 403 }
  return { ok: true }
}

function refusedByGate(res, gate) {
  if (gate.ok) return false
  if (gate.status === 400) return badRequest(res)
  if (gate.status === 404) return notFound(res)
  json(res, 403, { error: 'forbidden', detail: 'not_coordinator' })
  return true
}

async function handleCreate(ctx, req, res, who) {
  const { db } = ctx
  const body = await readBody(req)
  const v = validateMissionFields(body)
  if (!v.ok) return badRequest(res)
  const idemKey = idemKeyOf(req, who)
  if (idemKey === undefined) return badRequest(res)
  // convo_id is optional provenance (a client creates from the Projects
  // tab); when named it must be a conversation this caller may write to.
  if (body.convo_id !== undefined && !writableConvo(db, who, body.convo_id)) return notFound(res)
  const excludePrivateOwned = filteredAgent(db, who)
  const out = createProject(db, {
    userId: who.userId, deviceId: who.deviceId, createdBy: byOf(who), convoId: body.convo_id ?? null,
    title: v.value.title, body: v.value.body ?? '', idemKey, excludePrivateOwned,
  })
  // A replay of a key whose project this caller cannot see: same 404 as unknown.
  if (!out.project) return notFound(res)
  json(res, out.duplicate ? 200 : 201, { project: projectWithRollup(db, who.userId, out.project, { excludePrivateOwned }) })
  return true
}

function handleList(ctx, res, url, who) {
  const { db } = ctx
  const state = url.searchParams.get('state')
  if (state != null && !STATES.includes(state)) return badRequest(res)
  json(res, 200, { projects: listProjects(db, who.userId, { state, excludePrivateOwned: filteredAgent(db, who) }) })
  return true
}

async function handlePatch(ctx, req, res, who, project) {
  const { db } = ctx
  const body = await readBody(req)
  const v = validateMissionFields(body, { partial: true })
  if (!v.ok || Object.keys(v.value).length === 0) return badRequest(res)
  const statusWriter = typeof v.value.status === 'string'
    ? { by: byOf(who), convoId: statusConvoOf(db, who, body.convo_id), deviceId: who.deviceId }
    : null
  const excludePrivateOwned = filteredAgent(db, who)
  let updated
  try {
    updated = updateProject(db, { userId: who.userId, projectId: project.id, fields: v.value, statusWriter, excludePrivateOwned })
  } catch (err) { if (err.message === 'closed') return conflict(res, { blocked_by: 'closed' }); throw err }
  if (!updated) return notFound(res)
  json(res, 200, { project: projectWithRollup(db, who.userId, updated, { excludePrivateOwned }) })
  return true
}

async function handleClose(ctx, req, res, who, project) {
  const { db } = ctx
  const body = await readBody(req)
  if (typeof body.summary !== 'string' || !body.summary.trim() || Buffer.byteLength(body.summary, 'utf8') > BODY_MAX) return badRequest(res)
  if (refusedByGate(res, coordinatorGate(db, who, body.convo_id))) return true
  const excludePrivateOwned = filteredAgent(db, who)
  let out
  try {
    out = closeProject(db, { userId: who.userId, projectId: project.id, by: byOf(who), summary: body.summary, excludePrivateOwned })
  } catch (err) {
    if (err.message === 'closed') return conflict(res, { blocked_by: 'closed' })
    if (err.message === 'open_missions') return conflict(res, { blocked_by: 'open_missions', missions: err.missions })
    if (err.message === 'no_project') return notFound(res)
    throw err
  }
  json(res, 200, { project: projectWithRollup(db, who.userId, out.project, { excludePrivateOwned }) })
  return true
}

async function handleMerge(ctx, req, res, who, project) {
  const { db } = ctx
  const body = await readBody(req)
  if (typeof body.into !== 'string' && typeof body.into !== 'number') return badRequest(res)
  if (refusedByGate(res, coordinatorGate(db, who, body.convo_id))) return true
  const excludePrivateOwned = filteredAgent(db, who)
  const into = getProject(db, who.userId, body.into, { excludePrivateOwned })
  if (!into) return notFound(res)
  let out
  try {
    out = mergeProject(db, { userId: who.userId, projectId: project.id, intoId: into.id, by: byOf(who), excludePrivateOwned })
  } catch (err) {
    if (err.message === 'same_project') return badRequest(res)
    if (err.message === 'closed' || err.message === 'into_closed') return conflict(res, { blocked_by: err.message })
    if (err.message === 'no_project') return notFound(res)
    throw err
  }
  // One `updated` marker per moved mission, on its origin conversation,
  // built from the unsieved row (emitMissionMarker's withTitle rule is the
  // privacy boundary for markers).
  for (const id of out.movedMissionIds) {
    const m = getMission(db, who.userId, id)
    if (m) emitMissionMarker(ctx, who, { mission: m, action: 'updated', convoId: m.origin_convo_id, projectChanged: true })
  }
  json(res, 200, {
    project: projectWithRollup(db, who.userId, out.project, { excludePrivateOwned }),
    merged: projectWithRollup(db, who.userId, out.merged, { excludePrivateOwned }),
  })
  return true
}

export async function handleProjectsRoute(ctx, req, res, url, who) {
  const { db } = ctx
  const path = url.pathname
  if (path === '/projects') {
    if (req.method === 'POST') return handleCreate(ctx, req, res, who)
    if (req.method === 'GET') return handleList(ctx, res, url, who)
    return false
  }
  const m = path.match(/^\/projects\/([^/]+)(?:\/(close|merge))?$/)
  if (!m) return false
  let idOrNum
  try { idOrNum = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  const sub = m[2] || null
  const excludePrivateOwned = filteredAgent(db, who)
  if (!sub && req.method === 'GET') {
    // Reads follow a merge to the project that survived it (§4.2).
    const r = resolveProject(db, who.userId, idOrNum, { excludePrivateOwned })
    if (!r) return notFound(res)
    json(res, 200, { ...projectDetail(db, who.userId, r.project, { excludePrivateOwned }), ...(r.mergedFrom ? { merged_from: r.mergedFrom } : {}) })
    return true
  }
  const project = getProject(db, who.userId, idOrNum, { excludePrivateOwned })
  if (!project) return notFound(res)
  if (!sub) return req.method === 'PATCH' ? handlePatch(ctx, req, res, who, project) : false
  if (req.method !== 'POST') return false
  return sub === 'close' ? handleClose(ctx, req, res, who, project) : handleMerge(ctx, req, res, who, project)
}
```

- [ ] **Step 4: Mount it and extend `/lookup`**

In `src/http.js`, add `import { handleProjectsRoute } from './projects-http.js'` beside the missions import. After the `handleMissionsRoute` line, add:

```js
      if (await handleProjectsRoute({ db, hub }, req, res, url, who)) return
```

In `src/lookup-http.js`:
- Add `import { resolveProject } from './projects.js'`.
- Update the header comment ("items, missions, milestones and projects alike").
- In `resolve`, before the final `return null`, add:

```js
  // Projects (spec 2026-09-30 §4.1) share the number space. Never shared
  // with colleagues (§9), so a foreign number is the same 404. A merged
  // project resolves to the one that survived it, like GET /projects/:id.
  const project = db.prepare('SELECT id FROM projects WHERE user_id=? AND num=?').get(owner.id, num)
  if (project) {
    if (!own) return null
    const r = resolveProject(db, who.userId, project.id, { excludePrivateOwned: filteredAgent(db, who) })
    return r ? { kind: 'project', id: r.project.id, owner, mergedFrom: r.mergedFrom?.id ?? null } : null
  }
```

In `handleLookupRoute`, replace the final `json(…)` with:

```js
  json(res, 200, {
    kind: hit.kind, id: hit.id,
    ...(hit.mergedFrom ? { merged_from: hit.mergedFrom } : {}),
    owner: { user_id: hit.owner.id, name: hit.owner.name },
  })
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test --test-timeout=30000 test/projects-http.test.js test/lookup-http.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 6: Run the whole suite**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/projects-http.js src/http.js src/lookup-http.js test/projects-http.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "projects: /projects routes, Coordinator-gated close and merge, merge redirect on reads and /lookup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Docs, `/help` and the conformance fixture

**Files:**
- Modify: `docs/protocol.md`:
  - the `/snapshot` bullet (~line 15)
  - the *Missions & milestones* intro, routes table and row shapes (~1849-1925)
  - a new *Conversation links* subsection after *Status*
  - *Marker events* (~2014)
  - *Visibility* (~2067)
  - a new `## Projects` section before `## Shared visibility`
- Modify: `src/help.js` (*Missions & milestones* ~113-195; a new *Projects* section)
- Modify: `test/help.test.js`
- Create: `test/fixtures/conformance/17_mission_links_and_projects.json`

**Interfaces:**
- Consumes: every route and field from Tasks 3–11.

- [ ] **Step 1: Write the failing tests**

In `test/help.test.js`, add the new routes to the `for (const route of [...])` list: `'POST /missions/:id/leave'`, `'GET /conversations/:id/missions'`, `'POST /projects'`, `'GET /projects?state='`, `'GET /projects/:id'`, `'PATCH /projects/:id'`, `'POST /projects/:id/close'`, `'POST /projects/:id/merge'`. Then append before the closing `})`:

```js
  // Spec 2026-09-30 projects & mission links: the answers a bridge cannot
  // guess — join no longer refuses, how to name a mission on a milestone,
  // the leave fallback, the activity vocabulary and who may close/merge.
  assert.equal(body.includes('other_mission'), false, '/help must not document the retired 409')
  for (const s of ['not_linked', 'current_changed', 'project_changed', 'mission_count', 'subchats=1',
    'running|waiting|idle|quiet', 'not_coordinator', 'open_missions', 'merged_from', 'project: id|"#n"|n|null']) {
    assert.ok(body.includes(s), `/help must name ${s}`)
  }
```

Create `test/fixtures/conformance/17_mission_links_and_projects.json`:

```json
{
  "name": "mission links & projects: a conversation joins a second mission (200), lists both, names one on a milestone, leaves the current; a project files a mission and rolls it up",
  "description": "Exercises POST /missions/:id/join on a conversation that already has a mission (200 — it was 409 other_mission), GET /conversations/:id/missions (current first), POST /milestones {mission}, POST /missions/:id/leave (current falls back), POST /projects, PATCH /missions/:id {project} and GET /projects rollups, then the mission markers c1 holds: created, joined, milestone, left, current_changed and updated with project_changed. Numbers are shared: missions #1 and #2, milestone #3, project #4.",
  "server": { "tmpDb": true },
  "seed": {
    "users": [ { "as": "dan", "name": "dan", "password": "fixture-pw-17" } ],
    "agents": [ { "as": "bridge", "user": "dan", "name": "dev-2" } ],
    "conversations": [
      { "id": "c1", "owner": "dan", "title": "Long session", "sessionState": "running", "agent": "bridge" },
      { "id": "c2", "owner": "dan", "title": "Other", "sessionState": "running", "agent": "bridge" }
    ]
  },
  "steps": [
    { "kind": "http", "method": "POST", "path": "/missions", "token": { "$ref": "bridge.token" },
      "body": { "title": "A", "convo_id": "c1" },
      "expect": { "status": 201, "body": { "mission": { "$ignore": true } } } },
    { "kind": "http", "method": "POST", "path": "/missions", "token": { "$ref": "bridge.token" },
      "body": { "title": "B", "convo_id": "c2" },
      "expect": { "status": 201, "body": { "mission": { "$ignore": true } } } },
    { "kind": "http", "method": "POST", "path": "/missions/2/join", "token": { "$ref": "bridge.token" },
      "body": { "convo_id": "c1" },
      "expect": { "status": 200, "body": { "mission": { "$ignore": true } } } },
    { "kind": "http", "method": "GET", "path": "/conversations/c1/missions", "token": { "$ref": "bridge.token" },
      "expect": { "status": 200, "body": { "missions": [
        { "id": { "$bind": "b_id" }, "user_id": { "$ref": "dan.user_id" }, "num": 2, "state": "open", "title": "B", "body": "",
          "close_summary": null, "closed_by": null, "closed_over_open_items": 0, "origin_convo_id": "c2",
          "origin_device_id": { "$ref": "bridge.device_id" }, "created_by": "agent",
          "created_at": { "$type": "integer" }, "updated_at": { "$type": "integer" }, "last_milestone_at": null, "closed_at": null,
          "status": null, "status_by": null, "status_convo_id": null, "status_updated_at": null, "closed_convo_id": null,
          "project_id": null, "project_num": null,
          "open_items": 0, "needs_you": 0, "conversations": 2, "milestones": 0, "last_milestone": null,
          "activity": "running", "last_activity_at": { "$type": "integer" },
          "current": true, "active": true, "how": "joined", "joined_at": { "$type": "integer" }, "ended_at": null },
        { "id": { "$bind": "a_id" }, "user_id": { "$ref": "dan.user_id" }, "num": 1, "state": "open", "title": "A", "body": "",
          "close_summary": null, "closed_by": null, "closed_over_open_items": 0, "origin_convo_id": "c1",
          "origin_device_id": { "$ref": "bridge.device_id" }, "created_by": "agent",
          "created_at": { "$type": "integer" }, "updated_at": { "$type": "integer" }, "last_milestone_at": null, "closed_at": null,
          "status": null, "status_by": null, "status_convo_id": null, "status_updated_at": null, "closed_convo_id": null,
          "project_id": null, "project_num": null,
          "open_items": 0, "needs_you": 0, "conversations": 1, "milestones": 0, "last_milestone": null,
          "activity": "running", "last_activity_at": { "$type": "integer" },
          "current": false, "active": true, "how": "origin", "joined_at": { "$type": "integer" }, "ended_at": null }
      ] } } },
    { "kind": "http", "method": "POST", "path": "/milestones", "token": { "$ref": "bridge.token" },
      "body": { "convo_id": "c1", "kind": "progress", "title": "Work on A", "mission": "#1" },
      "expect": { "status": 201, "body": {
        "milestone": { "id": { "$bind": "milestone_id" }, "mission_id": { "$ref": "a_id" }, "num": 3, "kind": "progress",
          "title": "Work on A", "body": "", "convo_id": "c1", "seq": { "$bind": "anchor_seq" },
          "device_id": { "$ref": "bridge.device_id" }, "created_by": "agent", "created_at": { "$type": "integer" } },
        "mission": { "$ignore": true } } } },
    { "kind": "http", "method": "POST", "path": "/missions/2/leave", "token": { "$ref": "bridge.token" },
      "body": { "convo_id": "c1" },
      "expect": { "status": 200, "body": { "mission": { "$ignore": true }, "current_mission": { "$ignore": true } } } },
    { "kind": "http", "method": "POST", "path": "/projects", "token": { "$ref": "bridge.token" },
      "body": { "title": "Promo launch" },
      "expect": { "status": 201, "body": { "project": { "$ignore": true } } } },
    { "kind": "http", "method": "PATCH", "path": "/missions/1", "token": { "$ref": "bridge.token" },
      "body": { "project": "#4" },
      "expect": { "status": 200, "body": { "mission": { "$ignore": true } } } },
    { "kind": "http", "method": "GET", "path": "/projects", "token": { "$ref": "bridge.token" },
      "expect": { "status": 200, "body": { "projects": [
        { "id": { "$type": "string" }, "user_id": { "$ref": "dan.user_id" }, "num": 4, "state": "open", "title": "Promo launch", "body": "",
          "status": null, "status_by": null, "status_convo_id": null, "status_updated_at": null,
          "close_summary": null, "closed_by": null, "closed_over_open_missions": 0, "closed_at": null,
          "merged_into": null, "merged_into_num": null, "origin_convo_id": null,
          "origin_device_id": { "$ref": "bridge.device_id" }, "created_by": "agent",
          "created_at": { "$type": "integer" }, "updated_at": { "$type": "integer" },
          "missions": { "running": 1, "waiting": 0, "idle": 0, "quiet": 0, "closed": 0 },
          "needs_you": 0, "open_items": 0, "last_activity_at": { "$type": "integer" } }
      ] } } },
    { "kind": "http", "method": "GET", "path": "/convo/c1/messages?limit=20", "token": { "$ref": "bridge.token" },
      "expect": { "status": 200, "body": { "events": [
        { "seq": { "$type": "integer" }, "convo_id": "c1", "ts": { "$type": "integer" }, "sender": "agent:dev-2", "type": "mission",
          "payload": { "mission_id": { "$ref": "a_id" }, "num": 1, "title": "A", "action": "created", "by": "agent" } },
        { "seq": { "$type": "integer" }, "convo_id": "c1", "ts": { "$type": "integer" }, "sender": "agent:dev-2", "type": "mission",
          "payload": { "mission_id": { "$ref": "b_id" }, "num": 2, "title": "B", "action": "joined", "by": "agent" } },
        { "seq": { "$ref": "anchor_seq" }, "convo_id": "c1", "ts": { "$type": "integer" }, "sender": "agent:dev-2", "type": "milestone",
          "payload": { "milestone_id": { "$ref": "milestone_id" }, "num": 3, "kind": "progress", "title": "Work on A", "body": "",
            "mission_id": { "$ref": "a_id" }, "mission_num": 1, "mission_title": "A", "by": "agent" } },
        { "seq": { "$type": "integer" }, "convo_id": "c1", "ts": { "$type": "integer" }, "sender": "agent:dev-2", "type": "mission",
          "payload": { "mission_id": { "$ref": "b_id" }, "num": 2, "title": "B", "action": "left", "by": "agent" } },
        { "seq": { "$type": "integer" }, "convo_id": "c1", "ts": { "$type": "integer" }, "sender": "agent:dev-2", "type": "mission",
          "payload": { "mission_id": { "$ref": "a_id" }, "num": 1, "title": "A", "action": "current_changed", "by": "agent" } },
        { "seq": { "$type": "integer" }, "convo_id": "c1", "ts": { "$type": "integer" }, "sender": "agent:dev-2", "type": "mission",
          "payload": { "mission_id": { "$ref": "a_id" }, "num": 1, "title": "A", "action": "updated", "by": "agent", "project_changed": true } }
      ] } } }
  ]
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=30000 test/help.test.js test/conformance.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected:
- `help.test.js` fails: the new routes are not named yet and `other_mission` is still documented.
- Fixture 17 should already **pass**, because it pins behaviour Tasks 3–11 built. If it fails, the implementation is wrong. Fix it in the owning task's code, never by loosening the fixture.

- [ ] **Step 3: Update `src/help.js`**

In the *Missions & milestones* section:

1. Replace the sentence starting `A conversation joins a mission by starting one, by \`join\`, …` through `… can \`mission_start\` its own).` with:

```
A conversation can be on several missions at once: one is **current** (where
milestones and new items go by default), the others are "also on", and ones
it left are history. It joins a mission by starting one, by \`join\`, or by
being spawned from a conversation that has one (a sub-chat inherits its
parent's current mission whenever that mission is open and visible to you —
sub-chats never count toward the 200-conversation cap).
```

2. Replace the `POST /missions/:id/join` bullet with:

```
- \`POST /missions/:id/join\` \`{convo_id}\` → 200 \`{mission}\`. Adds a link
  (or reactivates an ended one) and makes it CURRENT; the previous current
  mission stays "also on" — joining never fails because the conversation
  is on another mission. 409 \`closed\`; 400 once the mission has 200
  top-level conversations. Re-joining the current mission is a no-op 200.
  Marker: \`joined\`, or \`current_changed\` when the link was already active.
- \`POST /missions/:id/leave\` \`{convo_id}\` → 200 \`{mission,
  current_mission}\`. Ends the link. Leaving the current one moves current
  to the most recently joined remaining open mission, or to none. 404 if
  the conversation was never linked; leaving an ended link is a 200 no-op.
  Markers: \`left\`, plus \`current_changed\` when current moved.
- \`GET /conversations/:id/missions\` → \`{missions}\`: every mission this
  conversation is or was on — current first, then the rest newest first —
  each a full mission row plus \`current\`, \`active\`, \`how\`
  (origin|joined|spawned|inherited|backfill), \`joined_at\`, \`ended_at\`.
```

3. In the `GET /missions?state=…` bullet, append: `Rows also carry \`activity\` (running|waiting|idle|quiet, or closed), \`last_activity_at\`, \`project_id\` and \`project_num\`; \`conversations\` counts active top-level conversations.`

4. Replace the `GET /missions/:id` bullet with:

```
- \`GET /missions/:id\` → \`{mission, milestones (newest first), items
  (open), conversations}\`. Each conversation row has \`current\`, \`how\`,
  \`joined_at\`, \`ended_at\` (null = on it now), \`parent_convo_id\` and
  \`subchat_count\`, plus \`other_missions\` (up to 5 of that
  conversation's other missions: \`{id, num, title, current, active,
  joined_at, ended_at}\`); sub-chats are folded into their parent's row —
  add \`?subchats=1\` to list them too.
```

5. In the `PATCH /missions/:id` bullet, change `{title?, body?, status?: string|null, convo_id?}` to `{title?, body?, status?: string|null, project?, convo_id?}` and append: `\`project: id|"#n"|n|null\` files the mission in a project (null takes it out); it works on a closed mission too. The \`updated\` marker carries \`project_changed: true\` when it moved. \`POST /missions\` also takes \`project\`. 404 for a project you cannot see, 409 \`project_closed\`.`

6. In the `POST /milestones` bullet, change the body shape to `{convo_id, kind:'user_input'|'progress', title, body?, mission?}` and append: `\`mission\` (id, "#n" or n) names any mission this conversation is actively on — default is the current one; 409 \`not_linked\` otherwise.`

7. Remove every other mention of `other_mission`.

8. Add to the `/snapshot` description in the *Reading* section (or, if absent there, as a line at the end of *Missions & milestones*): `\`GET /snapshot\` conversation rows carry \`mission_id\` (current) and \`mission_count\` (every mission ever linked).`

Then add a new section directly after *Missions & milestones*:

```
## Projects

A project groups missions (one project per mission, or none). Same
\`#num\` counter; \`:id\` is \`pj_…\` or a number. Any agent may create one,
file a mission into one, or update it; only the user or the Coordinator may
close or merge.

- \`POST /projects\` \`{title, body?, convo_id?}\` + optional
  \`Idempotency-Key\` → 201 \`{project}\` (replay 200). Run \`GET /projects\`
  first and create one only when none fits.
- \`GET /projects?state=open|closed\` → \`{projects}\`; each carries
  \`missions: {running, waiting, idle, quiet, closed}\` counts, \`needs_you\`,
  \`open_items\` and \`last_activity_at\`.
- \`GET /projects/:id\` → \`{project, missions, needs_you (items with
  mission_num), recent_milestones (5), sessions_by_box}\`. A merged project
  answers with the project it was merged into plus \`merged_from\`.
- \`PATCH /projects/:id\` \`{title?, body?, status?: string|null,
  convo_id?}\` — status rules as for missions. 409 once closed.
- \`POST /projects/:id/close\` \`{summary, convo_id}\` — as an agent you must
  be the Coordinator and name its conversation (else 403
  \`not_coordinator\`); open missions block you with 409 \`open_missions\`.
- \`POST /projects/:id/merge\` \`{into, convo_id}\` — Coordinator or user
  only; moves every mission into \`into\` and closes this one ("Merged into
  #N").
- Activity: \`running\` (a linked session is running), \`waiting\` (one is
  waiting, or items await the user), \`quiet\` (no milestone, status update
  or conversation activity for 7 days), else \`idle\`.
```

- [ ] **Step 4: Update `docs/protocol.md`**

1. In the `GET /snapshot` bullet, after the `participants` sentence, add:

```
  Every row also carries `mission_id` — the conversation's **current**
  mission, or `null` — and `mission_count`, the number of missions it was
  ever linked to (active and ended; the header's "+n" is `mission_count − 1`).
  For an ordinary agent both are sieved: a private-origin mission reads as
  `mission_id: null` and is not counted (see *Missions & milestones →
  Visibility*).
```

2. In *Missions & milestones*, replace the paragraph starting `A conversation gains a mission in exactly four ways` (through `its agent can \`mission_start\` its own.`) with:

```
A conversation may be linked to **many** missions (spec
2026-09-30 projects & mission links §3). The `mission_conversations` table
holds one row per (mission, conversation): `how` it was made (`origin |
joined | spawned | inherited | backfill`), `joined_at`, and `ended_at`
(`null` = active). Exactly one active link is **current**, or none;
`conversations.mission_id` is the pointer to it (invariant: a non-null
pointer always has an active link), and it is where `POST /milestones` and
new items go by default. The pointer changes only through create (origin),
join, leave, spawn and inheritance.

A conversation gains a link by `POST /missions` (its origin, unless
`attach: false`), `POST /missions/:id/join`, a spawn that named the mission
(`spawn_request` `mission_num`; `how: spawned`), and **inheritance** — a
sub-chat takes its parent's *current* mission at creation (`how:
inherited`), and never afterwards. Inheritance is a way into a mission, so
two of join's gates apply: the mission must be `open`, and **visible to the
creating device** under *Visibility* (a private-owned parent, or a public
parent joined to a private-origin mission, is refused for an ordinary
agent). There is no cap gate: **sub-chats never count toward the 200**. A
child that fails a gate starts with no mission.

**Cap.** `CONVOS_MAX = 200` counts a mission's *active* links from
*top-level* conversations (`parent_convo_id IS NULL`). Ended links and
sub-chats never count.

**Backfill.** On the first start after this change, while the link table
is empty, the journal writes one active link per current pointer (`origin`
when the mission was born there, `inherited` for a sub-chat, else `joined`;
`joined_at` from the conversation's earliest `created`/`joined` marker for
that mission, else the later of the two creation times), then one ended
`backfill` link for every other (mission, conversation) pair a milestone or
an item records, from its first to its last trace. Pairs that left no trace
cannot be recovered. It never runs again once any link exists.
```

3. In the routes table:
   - Replace the `POST /missions/:id/join` row with:

```
| `POST /missions/:id/join` | `{convo_id}` | 200 `{mission}`. Adds a link — or reactivates an ended one, keeping its original `how` unless that was `backfill` — stamps `joined_at`, and makes it **current**. The previous current mission stays active ("also on"): there is **no 409 `other_mission`** any more (an old bridge simply sees 200). Re-joining the current mission is a no-op 200 with no marker. 409 `{blocked_by:'closed'}`; 400 `{error:'bad_request'}` when the mission already has 200 active top-level links (a sub-chat is never refused by the cap). Repoints the conversation's unassigned items. Marker: `joined` for a new or reactivated link, `current_changed` for an already-active one. |
| `POST /missions/:id/leave` | `{convo_id}` | 200 `{mission, current_mission}`. Ends the link (`ended_at`), keeping it as history. Leaving the current one moves current to the most recently joined remaining active link **on an open mission**, else to none (`current_mission: null`). Leaving an already-ended link is a 200 no-op; **404** when the conversation was never linked, or the conversation fails join's gate. Items stay where they are. Markers: `left`, and `current_changed` (for the new current mission) when current moved. |
| `GET /conversations/:id/missions` | | `{missions:[…]}` — every mission the conversation is or was linked to: current first, then other active links newest-joined first, then ended links newest-ended first. Each is a full mission row plus `current`, `active`, `how`, `joined_at`, `ended_at`. Own conversations only; 404 for another user's, an unknown one, or (ordinary agent) a private-owned one. |
```

   - In the `POST /missions` row, append: `Optional \`project\` (id, \`#n\` or \`n\`) files the new mission: 404 for a project the caller cannot see, 409 \`{blocked_by:'project_closed'}\`, 400 on a non-string/non-number; ignored on the \`existing: true\` answer.`
   - In the `GET /missions` row, append: `Rows also carry \`project_id\`, \`project_num\`, \`activity\` and \`last_activity_at\` (see *Activity*). \`conversations\` is the number of **active top-level** links. \`?scope=shared\` rows carry \`project_id: null, project_num: null\`.`
   - Replace the own-view `GET /missions/:id` row's Returns cell with: `` `{mission, milestones:[…] newest first, items:[open items], conversations:[{id, title, box, state, parent_convo_id, current, how, joined_at, ended_at, subchat_count, other_missions, status?}]}` — every linked conversation, active links first (by `joined_at`), then ended ones. A sub-chat whose parent (or any ancestor) is also linked is **folded**: counted in its nearest linked ancestor's `subchat_count` and left out of the list; `?subchats=1` lists them as well. A sub-chat whose parent is not linked stands as its own row. `other_missions` is `[{id, num, title, current, active, joined_at, ended_at}]`: the listed conversation's links to *other* missions (for "also on #N" / "moved to #N"), current first, then active, then ended newest first, at most 5; for an ordinary agent a private-origin mission is left out. `status` is the session header (own-user view only). ``
   - In the `PATCH /missions/:id` row, change the body to `{title?, body?, status?: string\|null, project?: id\|"#n"\|n\|null, convo_id?}` and append: `\`project\` files or (null) unfiles the mission — same 404/409 \`project_closed\`/400 as on create — and is the one change a **closed** mission still accepts (any other field on a closed mission is 409 \`closed\`). The \`updated\` marker carries \`project_changed: true\` when the project changed.`
   - Replace the `POST /milestones` row's body/returns with: `` `{convo_id, kind:'user_input'\|'progress', title, body?, mission?}` + optional `Idempotency-Key` `` → `` 201 `{milestone, mission}`. `mission` (id, `#n` or `n`; `null`/absent = current) may name any mission this conversation has an **active** link to; anything else — unknown, invisible to the caller, never linked, or ended — is 409 `{blocked_by:'not_linked'}` (one answer, so it is never an existence oracle), and a non-string/non-number is 400. With no `mission`: 409 `{blocked_by:'no_mission'}` if the conversation has no current mission (or its mission is invisible to the caller), 409 `{blocked_by:'closed'}` if the target mission is closed; 502 `{error:'marker_append_failed'}` as before. ``

4. In *Row shapes*, extend the mission field list with `project_id, project_num, activity, last_activity_at`. Add: "`running_convos`, `waiting_convos` and `convo_activity_at` (activity inputs computed by `countsSql`) are never returned."

5. In *Closing → Who may close*, replace "either **on the mission** — the origin conversation or any conversation attached to it, a child of the origin included —" with "either **on the mission** — any conversation with an *active* link to it, current or also-on —".

6. Add a subsection after *Status*:

```
### Activity

Every mission row carries `activity` and `last_activity_at`, computed per
caller (spec 2026-09-30 §2):

- `closed` — the mission is closed;
- `running` — any actively linked conversation's `session_state` is `running`;
- `waiting` — any actively linked conversation is `waiting`, or `needs_you > 0`;
- `quiet` — `now − last_activity_at ≥ 7 days`;
- `idle` — none of the above.

`last_activity_at` is the latest of the mission's `created_at`, its last
milestone, its `status_updated_at`, and — for each **active** link — the
link's `joined_at` and the conversation's newest message event (the
`MESSAGE_TYPES` rule `/snapshot` uses for `last_ts`; `session_status` and
marker events are not activity). There is no stored activity column.
Every input goes through the caller's sieve: for an ordinary agent a
private-owned conversation's state and messages, a withheld status and a
hidden milestone never count.
```

7. In *Marker events*, change the `action` line of the `mission` JSON to `"created" | "joined" | "updated" | "closed" | "left" | "current_changed"` and add `"project_changed": true } }  // only on an \`updated\` that moved the mission between projects`. Replace "Appended to the conversation that performed the action (`created`/`joined` on that conversation; `updated`/`closed` on the origin conversation)" with: "Appended to the conversation concerned: `created`, `joined`, `left` and `current_changed` on that conversation (`current_changed` names the mission that became current; `left` the one it left); `updated`/`closed` on the origin conversation. A merge (see *Projects*) writes one `updated` with `project_changed` per moved mission." Add the snippets: `🏁 Left mission #N` and `🏁 Now on mission #N`.

8. In *Visibility*, add a paragraph:

```
**Links.** Every link read is sieved the same way: `GET
/conversations/:id/missions` omits a private-origin mission for an ordinary
agent (the user may have joined a public conversation to one), `/snapshot`'s
`mission_id` reads null and `mission_count` excludes it, a mission's
`conversations` rows and `subchat_count` exclude private-owned
conversations, each row's `other_missions` omits private-origin missions, and `activity` ignores them. `POST /milestones {mission}`
answers `not_linked` for a mission the caller cannot see.
```

9. Add a new top-level section before `## Shared visibility (GitHub-verified, per repo)`:

```
## Projects

Spec: matron-apple `docs/superpowers/specs/2026-09-30-projects-and-mission-links-design.md` §4.

A project (`projects`, id `pj_…`) groups missions. A mission belongs to at
most one (`missions.project_id`). Projects share the per-user `#num`
counter, so `/lookup` resolves them (`kind: 'project'`). Mounted in
`src/projects-http.js`; `:id` accepts `pj_…` or a number.

| Route | Body / query | Returns |
|---|---|---|
| `POST /projects` | `{title, body?, convo_id?}` + optional `Idempotency-Key` | 201 `{project}`; replay 200. Any device may create. `convo_id` is optional provenance and must pass the same gate as `POST /missions` (404 otherwise). No marker. |
| `GET /projects` | `?state=open\|closed` (omit = both) | `{projects:[…]}`, newest `last_activity_at` first. Each row adds `missions: {running, waiting, idle, quiet, closed}` (its missions' *Activity*), `needs_you` and `open_items` (sums of its missions' counts), and `last_activity_at` (the latest of the project's `created_at`, its `status_updated_at` and its missions' `last_activity_at`). |
| `GET /projects/:id` | | `{project, missions:[mission rows], needs_you:[open items awaiting the user, each with mission_id and mission_num], recent_milestones:[the 5 newest across its missions, each with mission_num], sessions_by_box:{box name: n}}` — `sessions_by_box` counts distinct top-level conversations actively linked to its **open** missions. For a **merged** project: the detail of the project it was merged into (following up to 16 merges) plus `merged_from: {id, num}` of the one asked for. |
| `PATCH /projects/:id` | `{title?, body?, status?: string\|null, convo_id?}` | 200 `{project}`. Title/body/status rules and status attribution are exactly the mission ones (see *Missions & milestones → Status*). 409 `{blocked_by:'closed'}` on a closed (or merged) project. No marker. |
| `POST /projects/:id/close` | `{summary, convo_id?}` | 200 `{project}`. A client always may, over open missions: `closed_over_open_missions` records the count and the missions stay open and filed. An agent must be the **Coordinator** and prove it by naming its conversation (owned by this device, else 404); any other agent — or one naming none — is **403** `{error:'forbidden', detail:'not_coordinator'}`. The Coordinator is blocked by open missions: 409 `{blocked_by:'open_missions', missions:[{num,title}]}` (listed through its sieve; a hidden one still blocks). 409 `closed` if already closed. |
| `POST /projects/:id/merge` | `{into, convo_id?}` | 200 `{project: into, merged: this}`. Same who-may rule as close. Moves **every** mission of this project (any state) to `into`, closes this one with `close_summary: "Merged into #N"`, `merged_into` and `merged_into_num`, and writes one `updated` mission marker with `project_changed: true` per moved mission on its origin conversation. 400 when `into` is this project or not a string/number; 404 for an `into` the caller cannot see; 409 `{blocked_by:'closed'}` if this one is closed, `{blocked_by:'into_closed'}` if `into` is. |
| `POST /missions`, `PATCH /missions/:id` | `project` | see *Missions & milestones* |

Row shape: `{id, user_id, num, state, title, body, status, status_by,
status_convo_id, status_updated_at, close_summary, closed_by,
closed_over_open_missions, closed_at, merged_into, merged_into_num,
origin_convo_id, origin_device_id, created_by, created_at, updated_at}`,
plus the rollup fields on every route that returns one. `idem_key` and
`status_device_id` are never returned.

There is no project marker: the apps refresh `GET /projects` on any
`mission` marker and while the Projects tab is open.

**Visibility.** Same rules as missions. An ordinary agent never sees a
project whose origin conversation is private-owned or that a private device
created (404, absent from lists, not resolvable by `/lookup`); a status
written from/by a private device reads as four nulls; rollups, needs-you
items, milestones and session counts are computed from that agent's own
sieved mission rows. `project_id` / `project_num` on a mission row it *can*
see still travel as bare handles (the same "numbers, never words" exception
as `mission_num` on items). Projects are never shared with colleagues:
shared mission rows carry `project_id: null`.
```

10. In the lookup section of `docs/protocol.md` (search `GET /lookup`), add `project` to the kinds and document `merged_from`: "A merged project resolves to the project it was merged into, with `merged_from: <the id asked for>`."

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test --test-timeout=30000 test/help.test.js test/conformance.test.js 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 6: Run the whole suite and check the docs for stale wording**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`, with the pass count above the Task 1 baseline.

Run: `grep -n "other_mission\|set once and never changed\|at most one mission" docs/protocol.md src/help.js src/*.js`
Expected: no documentation or comment still claims the old one-mission rule. Rewrite any hit in the same terms as above. The `src/db.js` comment beside `conversations.mission_id` becomes "the conversation's CURRENT mission (spec 2026-09-30: see mission_conversations)".

- [ ] **Step 7: Commit**

```bash
git add docs/protocol.md src/help.js src/db.js test/help.test.js test/fixtures/conformance/17_mission_links_and_projects.json
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "docs: mission links, activity and projects in protocol.md and /help; conformance fixture 17

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review (done while writing; kept for the executor)

**Spec coverage (§3, §4, §7 journal):**

| Spec item | Task |
|---|---|
| `mission_conversations` table + index | Task 1 |
| Backfill (guarded, idempotent) | Task 2 |
| Join adds/reactivates, becomes current, no 409 | Task 3 |
| Leave ends link, current fallback | Task 4 |
| Cap counts top-level only | Task 3 |
| Sub-chats inherit with an `inherited` link | Task 3 |
| `milestone_post(mission)` + 409 `not_linked` | Task 6 |
| `GET /conversations/:id/missions` | Task 5 |
| `GET /missions/:id` rows + folding + `?subchats=1` | Task 5 |
| Snapshot `mission_id` / `mission_count` | Task 7 |
| Marker `left`, `current_changed` | Tasks 3, 4 |
| `projects` table, `missions.project_id` + index | Task 1 |
| Project routes incl. merge + redirect | Tasks 9, 11 |
| `PATCH /missions {project}`, `POST /missions {project}`, `project_changed` | Task 10 |
| `GET /missions` rows gain `project_id`, `project_num`, `activity` | Task 8 |
| Activity running/waiting/idle/quiet, rollups | Tasks 8, 9 |
| Project privacy sieve | Tasks 9, 11 |
| Old-bridge compat (join 200) | Task 3 |
| Docs | Task 12 |

**Type consistency:**
- `joinMission` returns `{mission, action}` everywhere: the Task 3 routes, `spawns.js` and the tests.
- `leaveMission` returns `{mission, left, currentChanged, currentMissionId}` in Tasks 4, 5 and 7.
- `missionRef` (pure) / `mission` (wire) in Task 6.
- `projectId` in `fields` / `createMission` (Task 10), and `projectId` in `listMissions` (Task 8), which `projects.js` uses (Task 9).
- `projectWithRollup` / `withRollup` / `rollupsByProject` are defined in Task 9 and used in Task 11.
- `ORIGIN_SIEVE` is exported in Task 5 and used in Tasks 7 and 9.

**Placeholders:** none. Every code step carries its code, and every docs step carries its text.
