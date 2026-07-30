# Shared-Agent Collaboration Backbone — Design (v2)

- **Status:** draft, revision 2 (post spec-review round 1)
- **Date:** 2026-07-30
- **Loop:** #458
- **Repos:** `easelyte/matron-journal` (server, primary), `easelyte/claude-matrix-bridge` (`/opt/matron/bridge-journal`), `easelyte/matron-web` (client)
- **Scope:** collaboration BACKBONE only. The curated per-user *toolset enforcement* and the *simplified ChatGPT-like client* are separate sub-projects (§9); this spec delivers the membership model, the authorization change across all consumers, 2a fan-out with an explicit canonical copy, and the membership→tool-tier *signal* (not the enforcement).
- **v2 changes:** full `owner_user_id` call-site audit (round-1 root miss); explicit canonical-copy model; `users.tools_tier` schema; tier re-eval on membership change; identity-lifecycle fix; whole-call idempotency; atomic creation; `appendShared` authenticated actor; agent authorization via `agent_device_id`; bounded/chunked backfill; membership audit log; rollback stance. Round-1 findings mapped in §14.

---

## 1. Problem & Goal

The journal server is **single-tenant-per-conversation**: `conversations.owner_user_id` is a single owner, `events` is `PRIMARY KEY(user_id, seq)` with a per-user monotonic `user_seq`, and `append()` throws if the writer ≠ owner (`journal.js:79`). One human, one Claude session, one sequence space per conversation.

Goal: **two (later N) humans share one Claude conversation**, each seeing the other's turns, with:

- **Full parity.** Nastia is a first-class user (own `users` row, id 2), own devices, own read-state, own `sender` attribution.
- **Solo-or-group at creation.** The client offers a modal; the server receives an **explicit** initial member set (§7). No server-side guessing.
- **Add-back + shared history.** A member added later receives full prior history.
- **Membership-derived tool tier.** The conversation's effective tool capability is a function of its membership; the backbone stores the per-user tier and exposes + re-evaluates the conversation tier (enforcement wiring is sub-project 2).

Non-goal: human-to-human federation. This is shared-*agent* collaboration.

---

## 2. Grounding: full authorization surface (grep-confirmed HEAD, 2026-07-30)

Schema (`src/db.js`): `conversations(id TEXT PK, owner_user_id, title, session_state, last_seq, unread_count, snippet, created_at, agent_device_id, parent_convo_id)`; `events(user_id, seq, convo_id, ts, sender, type, payload, blob_ref, idem_key, PRIMARY KEY(user_id, seq))` + `idx_events_convo ON (convo_id, seq)` + `idx_events_idem UNIQUE ON (user_id, convo_id, idem_key)`; `user_seq(user_id PK, seq)`; `users(id INTEGER PRIMARY KEY /* NO AUTOINCREMENT */, name, password_hash, created_at)`; `devices(user_id, kind, cursor, ...)`; `blobs(id, owner_user_id, ...)`.

**Every `owner_user_id`-gated site (the round-1 root miss — v1 addressed only #3):**

| # | Site | Role | v2 change |
|---|---|---|---|
| 1 | `journal.js:143` snapshot/list `WHERE owner_user_id=?` | which convos a user sees | JOIN `conversation_members`; per-member state |
| 2 | `journal.js:48` `upsertConversation` update owner check | convo metadata update auth | membership-aware (owner/creator only for title) |
| 3 | `journal.js:79` `append()` owner throw | write auth | `isMember(authUserId)` (§5) |
| 4 | `journal.js:176` `markRead()` owner throw | clear unread | membership; operate on **reader's own** copy |
| 5 | `auth.js:107` `authorize()` owner check → `messagesBefore()`/`GET /convo/:id/messages` (`http.js`) | pagination | membership |
| 6 | `ws.js:419` `isReadOnlyChild` `WHERE id=? AND owner_user_id=?` | sub-chat write guard | drop owner filter; check membership |
| 7 | `db.js:188` `unreadBadge()` `SUM(unread_count) WHERE owner_user_id=?` | APNs badge | SUM over `conversation_members.unread_count WHERE user_id=?` |
| 8 | `push.js:160` `onAppend()` `WHERE id=? AND owner_user_id=?` | push decision | look up membership, not ownership |
| 9 | `http.js:439` blob fetch `blob.owner_user_id !== who.userId` | media access | allow if requester is a member of a convo referencing the blob |
| 10 | `ws.js:662` agent ops `authorize(conn.userId, convo)` (owner) | agent write/stream auth | authorize by `conversations.agent_device_id == conn.deviceId` (§8a) |

Blob *ownership* (`db.js:53/118`) stays as uploader provenance; only *access* (#9) widens to members.

---

## 3. Chosen approach: 2a fan-out with an explicit canonical copy

**2a (chosen):** each shared event is written once into **every member's own `(user_id, seq)` space**, so each member's existing user-wide device cursor syncs their copy with **zero client sync-protocol change**. (2b — per-conversation seq + per-member per-convo cursors — was rejected: it reworks the cursor model for *every* conversation across server + both clients to serve a 2-member feature. Operator confirmed 2a, 2026-07-30.)

**Canonical-copy rule (the round-1 core fix).** Under 2a the SAME logical event exists as N physical rows (one per member). A naïve `WHERE convo_id=?` read therefore returns it N times. Two distinct read intents, each with its own predicate:

- **Member-facing reads** (a member paginating/snapshotting *their* view): read **that member's own copy** — `WHERE convo_id=? AND user_id=<the requesting member>`. Their space holds every event via fan-out, exactly once.
- **Canonical/agent-facing reads** (the bridge reading the conversation; add-member backfill sourcing history): read the **owner's copy** — `WHERE convo_id=? AND user_id=<owner_user_id>` — declared the single canonical sequence. Never `WHERE convo_id=?` alone.

No convo-scoped consumer may read across `user_id`. The `idx_events_convo (convo_id, seq)` index is retained for range scans but every query adds the `user_id` predicate.

---

## 4. Data model changes

### 4.1 `conversation_members` (per-member state — sole authoritative unread)

```sql
CREATE TABLE IF NOT EXISTS conversation_members(
  convo_id     TEXT    NOT NULL,
  user_id      INTEGER NOT NULL,
  role         TEXT    NOT NULL DEFAULT 'member' CHECK(role IN ('owner','member')),
  unread_count INTEGER NOT NULL DEFAULT 0,
  added_by     INTEGER,
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY(convo_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_convo_members_user ON conversation_members(user_id);
```

`conversation_members.unread_count` is the **sole authoritative** per-member unread. `conversations.unread_count` is **deprecated** as an authority: `unreadBadge()` and the snapshot/list now read from `conversation_members` (§5 sites 1,7). `conversations.unread_count` is left in place but no longer read for badges (removing the column is deferred to avoid a wider migration); the append path stops maintaining it as authoritative to eliminate the P2 dual-source. This resolves round-1 B2/dual-unread.

### 4.2 `users.tools_tier` (the missing flag — round-1 B5/Codex-B3)

```sql
ALTER TABLE users ADD COLUMN tools_tier TEXT NOT NULL DEFAULT 'restricted'
  CHECK(tools_tier IN ('full','restricted'));
```
Fresh SCHEMA includes it. In-place `openDb` migration adds it and **sets every pre-existing user to `'full'`** (today only the operator exists and has full tools); new users (Nastia) default `'restricted'`. `effectiveToolTier` (§8) reads this column — it is now defined by the data model, satisfying P38.

### 4.3 `conversation_member_audit` (append-only — Codex-M5)

```sql
CREATE TABLE IF NOT EXISTS conversation_member_audit(
  id         INTEGER PRIMARY KEY,
  convo_id   TEXT    NOT NULL,
  target_user INTEGER NOT NULL,
  actor      TEXT    NOT NULL,          -- 'cli:admin' or 'user:<name>'
  action     TEXT    NOT NULL CHECK(action IN ('add','remove')),
  prev_tier  TEXT,                       -- convo effective tier before
  new_tier   TEXT,                       -- after
  backfilled INTEGER,                    -- events copied on add, NULL on remove
  ts         INTEGER NOT NULL
);
```
Append-only (P30/P34); removal writes an `action='remove'` row rather than deleting evidence. Records who granted/revoked access, when, and the tier transition.

### 4.4 `conversations`

No column additions. `owner_user_id` stays (creator = canonical seq anchor + agent binding + `sender` default). `agent_device_id`/`parent_convo_id` unchanged.

### 4.5 `events`

No schema change. 2a stores one row per member per event; `idx_events_idem` is already per-`user_id`.

### 4.6 Migration mechanics

In-place `openDb` pattern (`db.js:80–112`): add the two tables + `users.tools_tier`; **backfill** one `role='owner'` member row per existing conversation (from `owner_user_id`, current `unread_count`, `created_at`), idempotent `INSERT ... ON CONFLICT(convo_id,user_id) DO NOTHING`; set existing users `tools_tier='full'`. Migration wrapped in one transaction (Codex/atomicity).

### 4.7 Identity lifecycle (round-1 Codex-B2, ROWID reuse)

`users.id` has no `AUTOINCREMENT`, so a deleted id can be reused. **User deletion MUST delete that user's `conversation_members` rows in the same transaction** (and write `action='remove'` audit rows). No membership row may outlive its user. This closes the "dangling membership authorizes a reused id" vector without an FK (kept FK-free per the existing `agent_device_id`/`parent_convo_id` rationale). A ratchet test asserts no `conversation_members.user_id` lacks a live `users` row.

---

## 5. Authorization change — every site (round-1 root fix)

One helper:
```js
export const isMember = (db, convoId, userId) =>
  !!db.prepare('SELECT 1 FROM conversation_members WHERE convo_id=? AND user_id=?').get(convoId, userId)
```

Applied per §2 table:
- **Write** (`append()` 79): `!isMember(db, convoId, authUserId)` throw (authUserId = the authenticated actor, §6). Non-member/foreign convo → same "not authorized" (anti-enumeration preserved).
- **markRead** (176): `isMember` gate; recompute unread on the **caller's own** `conversation_members` row and their own event copy — not the owner's.
- **authorize()/pagination** (`auth.js:107`, `messagesBefore`): `isMember`; `messagesBefore` reads the **requesting member's own copy** (`WHERE convo_id=? AND user_id=<requester>`), never convo-wide.
- **snapshot/list** (143): a user's conversation list = `conversation_members JOIN conversations` for their memberships; metadata (title/session_state) from `conversations`, per-member `unread_count`/read-state from `conversation_members`.
- **isReadOnlyChild** (`ws.js:419`): drop the `owner_user_id` filter — `SELECT parent_convo_id FROM conversations WHERE id=?` — so the read-only-sub-chat guard holds for **every** member, not just the owner (round-1 M2).
- **unreadBadge** (`db.js:188`): `SUM(unread_count) FROM conversation_members WHERE user_id=?`.
- **push.onAppend** (`push.js:160`): resolve the target by membership; a fanned-out non-owner member now receives push (round-1 B2).
- **blob fetch** (`http.js:439`): allow if `blob.owner_user_id == requester` **or** the requester is a member of a conversation whose events reference the blob (media in shared convos).
- **agent ops** (`ws.js:662`): authorize by `agent_device_id` (§8a), decoupled from owner identity.

---

## 6. Fan-out primitive (`appendShared`) — authenticated actor, atomic, whole-call idempotent

```
appendShared(db, { convoId, authUserId, sender, type, payload, blobRef, idemKey }):
  if not isMember(db, convoId, authUserId): throw 'not authorized'      // actor ≠ sender ≠ member set
  members = SELECT user_id FROM conversation_members WHERE convo_id=convoId ORDER BY user_id
  db.transaction(() => {
    // whole-call idempotency: if ANY member already has this idem_key, the
    // entire logical send already fanned out — return the existing result,
    // insert nothing (round-1 B4). Checked against the canonical (owner) copy.
    if idemKey and exists(events WHERE user_id=owner AND convo_id AND idem_key):
        return { duplicate: true }
    for m in members:
      seq_m = nextSeq(db, m)
      INSERT events(user_id=m, seq=seq_m, convo_id, ts, sender, type, payload, blob_ref, idem_key)
      // per-member unread: bump conversation_members(m).unread_count UNLESS
      // sender is m's own (user:<m.name>) or convo is a silent child (parent_convo_id)
      // canonical mirror: if m == owner, also advance conversations.last_seq/snippet
  })
  after commit, for each member m:
    hub.broadcastJournal(m, journalFrame(seq_m, convo_id, ...))
    pushPipeline.onAppend(m, frame, ...)
```

- **Authenticated actor** (Codex-M1): `authUserId` is the connection's identity, distinct from `sender` (attribution, forgeable content) and the member set (destinations). The membership check uses `authUserId`. WS `send`/`prompt_reply` pass `conn.userId`.
- **Atomicity:** all per-member inserts + seq bumps in one `db.transaction()` — no half-fanned event.
- **Idempotency (whole-call):** a retry from any member matches the canonical copy's idem key and short-circuits the entire fan-out (no per-member re-insert → no duplicate delivery to others). Round-1 B4 resolved.
- **Ordering:** each member's copy gets its own seq in its own space; clients only read their own space; shared `ts` gives consistent cross-member ordering.

---

## 7. Membership operations

- **Create (atomic, explicit member set).** Conversation creation takes an **explicit** `members` array (creator always included). The wire contract **requires** it; an omitted/empty set is a `bad_request` — the server never defaults (round-1 Codex-M3 contradiction resolved: "default both" is a *client* UX default, filled in before the request). Creation writes the `conversations` row + all `conversation_members` rows in **one transaction** (Codex-M2): a crash cannot leave a convo with no creator membership.
- **Add-member (bounded backfill + audit).**
  1. Insert `conversation_members(C, M, 'member', added_by, now)`.
  2. **Backfill from the canonical (owner) copy only:** `SELECT ... FROM events WHERE convo_id=C AND user_id=<owner> ORDER BY seq` — never convo-wide (round-1 B3 duplicate fix). Replay each into M's space via `nextSeq(M)`, preserving `ts`/`sender`/`type`/`payload`.
  3. **Bounded/chunked:** backfill runs in **chunks of ≤500 events per transaction** (better-sqlite3 is synchronous — an unbounded transaction blocks the whole process, round-1 B6). A hard ceiling `MEMBER_BACKFILL_MAX_EVENTS` (default 50 000) aborts with a clear error rather than blocking pathologically; today's conversation lengths are far below this (chunking keeps each transaction short regardless).
  4. `unread_count` for M = 0 on join (caught-up). Write an `add` audit row with `backfilled=<count>`.
  5. Idempotent: re-adding an existing member is a no-op (PK conflict, no re-backfill).
- **Remove-member.** Delete M's `conversation_members` row; write a `remove` audit row. M's event copies are retained (harmless in M's own space; a later GC may prune). If removal changes the convo's effective tier, trigger §8 re-evaluation.
- **User deletion.** Deletes all of that user's `conversation_members` rows in the same transaction (§4.7) — no dangling authorization.
- **v1 grant surface = CLI/admin** (`node scripts/members.js add|remove <convo> <user>`), not in-app UX. Right-sized for a known 2-person team; in-app invite is sub-project 3.

---

## 8. Membership → tool tier: storage, signal, and re-evaluation (enforcement = sub-project 2)

```
effectiveToolTier(convoId) =
  'restricted' if ANY member has users.tools_tier='restricted'   // worst-privilege-wins (V9)
  'full'       only if every member is 'full'
```
**Operator-locked:** a GROUP convo (≥2 members) is always `restricted`; `full` only in a full-user solo convo. `tools_tier` is now a real column (§4.2).

**Re-evaluation on membership change (round-1 Codex-B3).** Tier is not only computed at spawn. Any membership mutation that changes `effectiveToolTier(convoId)` (e.g. adding a restricted member to a live full-tools solo session) MUST **terminate the conversation's live agent session** so the bridge respawns it at the new (restricted) tier. The backbone emits a `tier_changed` signal on the conversation (a journal control event the bridge consumes, or a direct session-kill via the existing `agent_device_id` binding); the running session cannot continue at a stale tier. The audit row records `prev_tier`/`new_tier`.

The backbone's deliverable here is: the `tools_tier` column, `effectiveToolTier`, and the re-evaluation/kill signal. The **actual curated toolset** (which integration MCP tools a restricted session gets, and the hard exclusion of Bash/Edit/system tools) is **sub-project 2** — the real enforcement. This spec delivers the *signal*, not the *sandbox*.

### 8a. Agent identity / authorization (round-1 M1)

An agent connection authenticates as a registered agent device (`devices.kind='agent'`, bound to one `user_id`). Rather than require the bridge to switch identities per conversation owner, **agent-op authorization keys on `conversations.agent_device_id`**: an agent op (`stream_append`/`activity`/`status`, `ws.js:662`) is authorized iff `conversations.agent_device_id == conn.deviceId` for the target convo. This is already the delivery-scoping key (`ws.js:390`); §5 site 10 extends it to the write/stream authorization, decoupling the agent from `owner_user_id`. One bridge agent device can thus serve a convo regardless of which human owns it. The agent writes replies via `appendShared` with `authUserId = owner_user_id` (canonical) and `sender = 'agent:<name>'`.

---

## 9. Out of scope (own spec → review)

1. **Curated toolset enforcement (sub-project 2)** — the restricted MCP toolset, exclusion of dangerous tools, spawn-time + kill-on-tier-change enforcement. The real blast-radius layer; backbone only signals.
2. **Simplified ChatGPT-like client (sub-project 3)** — no commands/code/picker-cards, in-app solo/group modal + invite UX.
3. **Separate-server isolation** — same-server decided; a later lift-and-shift is possible because the tool tier, not the server, is the boundary.

---

## 10. Rollback & failure modes

- **Rollback stance (Codex-M4):** the first fan-out write is a **declared point of no return** — after it, the DB holds multi-copy events that old (pre-migration) code would mis-read. Binary rollback is therefore **not** supported; the rollback path is **restore from the pre-migration DB backup** (a mandatory backup is taken before the migration runs, same as the 2026-07-28 snafu prod pattern). Documented as a deploy gate.
- **Non-member write** → "not authorized" (anti-enumeration).
- **Partial fan-out crash** → whole `db.transaction()` rolls back.
- **Backfill on a long convo** → chunked ≤500/txn + hard ceiling (§7).
- **Tier change on live session** → session terminated + respawned (§8).
- **Offline member** → copies persist; sync on reconnect via user-wide cursor.

---

## 11. Testing

Server (`node --test`):
1. Migration: fresh SCHEMA has both tables + `users.tools_tier`; in-place `openDb` backfills one `owner` member per convo + sets existing users `'full'`, idempotent on re-run, all in one transaction.
2. `isMember` gate across **all** §2 sites: owner + added member write/paginate/markRead/see-in-list/get-pushed OK; non-member rejected identically to foreign convo at each site.
3. Canonical-copy: a member's pagination returns each event **exactly once** (assert row-count parity), not N times; the agent-facing/canonical read returns the owner copy once.
4. 2a fan-out: a member `send` writes one row **per member**; **exact** per-member row-count parity (guards B3/B4 duplication); sender's own unread does not bump, others' do.
5. Fan-out atomicity: forced insert failure on member 2 rolls back member 1.
6. **Whole-call idempotency:** a retry (same member, same `local_id`) inserts **zero** new rows for **every** member (assert counts unchanged for all), not just the sender.
7. Add-member backfill: exact row-count parity in M's space (no duplicates even with a 3rd pre-existing member — sourced from owner copy only); chunking exercised on a >500-event convo; audit row written; re-add is a no-op.
8. Identity lifecycle: deleting a user removes their membership rows (same txn); ratchet test — no `conversation_members.user_id` without a live `users` row.
9. `effectiveToolTier`: group→restricted; full-solo→full; **adding a restricted member to a live full session emits the tier-change/kill signal** (prev/new tier audited).
10. Atomic creation: forced failure after the convo insert rolls back the convo (no orphan); omitted member set → `bad_request`.
11. unreadBadge/snapshot read from `conversation_members`, not `conversations.unread_count`.
12. Blob access: a member can fetch a blob referenced by a shared convo they're in but didn't upload.

Bridge/web changes (membership-driven lists, agent-device authorization, tier-change consumption) get tests in their repos; this spec's acceptance is the server backbone.

---

## 12. Acceptance criteria

- **AC1** Two users both `send` into one convo; each receives the other's + the agent's messages live, correct `sender`, correct **per-member** unread, and pagination/markRead/push all work for the non-owner.
- **AC2** Create with an explicit 1-member (solo) vs 2-member (group) set produces the right `conversation_members` rows; omitted set → `bad_request`; solo behaves exactly as today.
- **AC3** Add-member backfills full history into the new member's space with **exact row-count parity** (no duplicates, incl. a 3-member case), chunked, audited; idempotent.
- **AC4** Non-member writes/reads rejected identically to foreign-convo at every audited site.
- **AC5** `effectiveToolTier` returns `restricted` for any convo with a restricted member and `full` only for a full-user solo; adding a restricted member to a live full session terminates/respawns it at `restricted`.
- **AC6** Migration backfills owner rows + `tools_tier='full'` for existing users; all pre-existing single-owner conversations behave unchanged.
- **AC7** Deleting a user leaves no `conversation_members` row referencing it (no reused-id authorization).

---

## 13. Open questions for review (v2)

- **Blob-access predicate cost:** membership-of-a-convo-referencing-the-blob may need an index on events(blob_ref) or a blob→convo link; confirm the query shape.
- **`tier_changed` transport:** journal control event vs direct session-kill via `agent_device_id`. Leaning journal control event (observable, P34); confirm.
- **`conversations.unread_count` deprecation:** left in place unread-authority-removed vs fully dropped this pass (dropping widens migration). Default: leave, stop reading. Confirm.

---

## 14. Round-1 findings → v2 resolution map

- Canonical-copy multiplies events (Codex-B1/Claude-B3) → §3 canonical-copy rule + §5 per-site `user_id` predicate + §11.3/11.4 row-count-parity tests.
- Incomplete call-site audit (Claude-B1) → §2 full table (10 sites) + §5.
- Push/badge skip non-owner (Claude-B2) → §4.1 (auth unread in members) + §5 sites 7,8.
- Backfill duplicates for 3+ members (Claude-B3) → §7 owner-copy-only source + §11.7.
- Idempotency ambiguous (Claude-B4) → §6 whole-call short-circuit + §11.6.
- `is_full_tools` never in schema (Claude-B5/Codex-B3) → §4.2 `users.tools_tier`.
- Unbounded backfill (Claude-B6) → §7 chunked + ceiling.
- ROWID reuse (Codex-B2) → §4.7 delete membership on user-deletion + §11.8.
- Tier stale on membership change (Codex-B3) → §8 re-evaluation/kill.
- `appendShared` no actor (Codex-M1) → §6 `authUserId`.
- Creation not atomic (Codex-M2) → §7 one-transaction create + §11.10.
- Missing-member-set contradiction (Codex-M3) → §7 explicit required, `bad_request` on omit.
- Agent identity (Claude-M1) → §8a `agent_device_id` authorization.
- `isReadOnlyChild` bypass (Claude-M2) → §5 site 6.
- Rollback unsound (Codex-M4) → §10 point-of-no-return + backup-restore.
- Audit trail (Codex-M5) → §4.3 append-only audit table.
- Stale in-app edge case (Claude minor) → §7 CLI-only, edge dropped.
