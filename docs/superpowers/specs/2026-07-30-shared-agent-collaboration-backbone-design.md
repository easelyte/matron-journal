# Shared-Agent Collaboration Backbone — Design

- **Status:** draft (pre-spec-review)
- **Date:** 2026-07-30
- **Loop:** #458
- **Repos touched:** `easelyte/matron-journal` (server, primary), `easelyte/claude-matrix-bridge` (`/opt/matron/bridge-journal`), `easelyte/matron-web` (client)
- **Scope:** collaboration BACKBONE only. The per-user *curated toolset/permissions* layer and the *simplified ChatGPT-like client* are separate sub-projects (see §9 Out of Scope) and get their own spec → review.

---

## 1. Problem & Goal

Today the journal server is **single-tenant-per-conversation**: `conversations.owner_user_id` is a single owner, `events` has `PRIMARY KEY(user_id, seq)` with a per-user monotonic `user_seq` counter, and `append()` (`src/journal.js:76`) hard-throws if the writer is not the owner (`journal.js:79`). One human, one Claude session, one sequence space per conversation.

We want **two (later N) humans talking to the SAME Claude agent conversation, each seeing the other's turns**, with:

- **Full parity.** Nastia is a first-class journal user (her own `users` row, id 2) with her own devices, read-state, and `sender` attribution — not a shared login.
- **Solo-or-group at creation.** When either human starts a conversation, the default is **both on it**; a modal lets the creator choose **solo** (just them) or **group** (with the other). (The modal is a client concern; the backbone just accepts an explicit initial member set.)
- **Add-back + shared history.** A member can be added to an existing conversation later and receives the **full prior history**.
- **Membership-derived tool tier.** The conversation's effective tool capability is a pure function of its membership (see §7). The backbone exposes this; the *toolset wiring* is sub-project 2.

Non-goal (explicitly): human-to-human general chat / federation. This is shared-agent collaboration, not a second Matrix. If a pure human-to-human room is ever wanted, keep a separate channel.

---

## 2. Grounding: current schema & write path (HEAD, grep-confirmed 2026-07-30)

- `conversations(id TEXT PK, owner_user_id, title, session_state, last_seq, unread_count, snippet, created_at, agent_device_id, parent_convo_id)` — `src/db.js:21`.
- `events(user_id, seq, convo_id, ts, sender, type, payload, blob_ref, idem_key, PRIMARY KEY(user_id, seq))`; `idx_events_convo ON (convo_id, seq)`; `idx_events_idem UNIQUE ON (user_id, convo_id, idem_key) WHERE idem_key IS NOT NULL` — `src/db.js:32`.
- `user_seq(user_id PK, seq)` — per-user monotonic counter, `nextSeq()` at `src/journal.js:71`.
- `devices(user_id, kind IN ('client','agent'), cursor, ...)` — `cursor` is **per-device, user-wide** (one cursor across all that user's convos), `src/db.js:10`. Ack advances it at `ws.js:455`.
- `append()` (`journal.js:76`): loads convo, **throws if `owner_user_id !== userId`** (`:79`), idem-dedups, `nextSeq(userId)`, inserts ONE event row, updates the single `conversations` row's `last_seq`/`unread_count`/`snippet`. Unread predicate: a `user:*` sender does not bump the owner's own unread (`:114`).
- `appendAndFan()` (`ws.js:398`): after append, WS-broadcasts one frame via `hub.broadcastJournal(conn.userId, frame, agent_device_id)`. Fan-out today is **WS-only** — there is no DB fan-out; a non-owner has no row and no cursor path to the event.
- Client `send`/`prompt_reply` (`ws.js:457`, `:478`) always call `appendAndFan({ userId: conn.userId, ... })` — a client can only write to convos it owns, enforced by append()'s throw.

**Implication:** the backbone changes exactly three surfaces — the conversation/membership model, the authorization check on write & read, and event fan-out (WS-only → DB-level).

---

## 3. Chosen approach: 2a fan-out-write (per-member seq space)

Two candidate shared-event models were considered (loop #458):

- **2a — fan-out-write (CHOSEN).** A shared event is written once into **each member's own `(user_id, seq)` space** (each member's own `nextSeq`). Each member's existing **user-wide device cursor** then picks up their copy with zero client sync-protocol change. Per-member conversation state (unread, membership) lives in a new `conversation_members` table.
- **2b — re-key per-conversation.** Events keyed by `convo_id` + a per-conversation seq, with per-(member, convo) cursors. One physical row per event, canonically cleaner (P2). **Rejected** because it reworks the cursor model from user-wide to per-conversation for *every* conversation and *every* client/device — a global sync-protocol change to serve a 2-user feature. 2a reuses the model that already exists.

**Why 2a despite the row duplication (right-sizing):** the journal's entire read/sync model is already "per-user seq + user-wide cursor + per-user read-state." 2a is additive to that model; 2b replaces it. Duplication cost is N copies of an event body for an N-member convo (N=2 in practice), against a full-stack cursor rework for 2b. The pragmatic path wins here and the loop concurs.

### 2a canonical-copy rule

With 2a there is no single canonical event row, but there **is** a canonical *sequence anchor*: the conversation's `owner_user_id` (its creator) remains the **agent-facing** space. The bridge's Claude session reads the conversation **convo-scoped** (via `idx_events_convo`) so it sees every member's messages regardless of `user_id`, and writes its replies through the same fan-out so every member receives them. `agent_device_id` (already on `conversations`) continues to bind the session to its bridge.

---

## 4. Data model changes

### 4.1 New table: `conversation_members`

```sql
CREATE TABLE IF NOT EXISTS conversation_members(
  convo_id     TEXT    NOT NULL,
  user_id      INTEGER NOT NULL,
  role         TEXT    NOT NULL DEFAULT 'member' CHECK(role IN ('owner','member')),
  unread_count INTEGER NOT NULL DEFAULT 0,
  added_by     INTEGER,               -- user_id who added them; NULL for the creator
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY(convo_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_convo_members_user ON conversation_members(user_id);
```

- The conversation **creator** gets a `role='owner'` row at creation; every other member a `role='member'` row.
- **Per-member unread** moves here. `conversations.unread_count` is retained but becomes the **owner's** mirror (kept in sync for the owner's row so existing single-member reads/snapshots don't regress); the authoritative per-member unread is `conversation_members.unread_count`. (See §8 migration for the backfill that seeds an owner row for every existing conversation.)
- Deliberately **not** a foreign key on `convo_id`/`user_id` — consistent with the existing `agent_device_id`/`parent_convo_id` no-FK rationale (`db.js:95`): device/user deletion is a bare DELETE and must never be blocked by a dangling membership row; a dangling row simply matches no live participant.

### 4.2 `conversations`

No column changes. `owner_user_id` stays (creator / agent-facing seq anchor + `sender` default). `unread_count`/`last_seq`/`snippet` continue to track the **owner's** view (mirror). New per-member state lives in `conversation_members`.

### 4.3 `events`

No schema change. 2a stores one row per member in each member's `(user_id, seq)` space; `convo_id`, `idx_events_convo`, and `idx_events_idem` (already per-`user_id`) all work unchanged. A member's idem key stays `client:${deviceId}:${localId}` and is naturally scoped to their own `user_id`.

### 4.4 Migration mechanics

Follow the in-place pattern already in `openDb` (`db.js:80–112`): add `conversation_members` (+ index) to the `SCHEMA` const for fresh installs, and an idempotent create + one-time backfill in `openDb` for the live DB (seed a `role='owner'` member row for every existing conversation from its `owner_user_id`, `unread_count`, `created_at`). Backfill is idempotent (`INSERT ... ON CONFLICT(convo_id,user_id) DO NOTHING`).

---

## 5. Authorization changes (the access check)

Introduce one helper, used by every write and read path:

```js
// journal.js
export const isMember = (db, convoId, userId) =>
  !!db.prepare('SELECT 1 FROM conversation_members WHERE convo_id=? AND user_id=?').get(convoId, userId)
```

- **`append()` (`journal.js:79`)** — replace `convo.owner_user_id !== userId` throw with `!isMember(db, convoId, userId)` throw. A member (owner or added) may write; a non-member still gets the same "not authorized" throw (preserves the anti-enumeration behavior for foreign convos, which have no membership row).
- **Read paths** — `snapshot()`, sync/backfill queries, and the `viewing` op must return a conversation's events to any member. Today reads are scoped by `conn.userId`'s own seq space; under 2a each member already has their own copy in their own space, so **most reads need no change** — a member reads their own fan-out copy via their user-wide cursor exactly like today. The change is that `conversation_members` (not just owned `conversations`) drives which convos appear in a member's conversation list / snapshot.
- **`isReadOnlyChild` guard (`ws.js:418`)** stays; sub-chats remain read-only regardless of membership.

---

## 6. Event fan-out (2a): the core change

`appendAndFan` becomes a **DB fan-out + WS fan-out** over the member set.

```
appendShared(db, { convoId, sender, type, payload, blobRef, idemKey, originUserId }):
  members = SELECT user_id FROM conversation_members WHERE convo_id = convoId   // stable order
  within ONE db.transaction():
    for each member m:
      seq_m = nextSeq(db, m)
      INSERT events(user_id=m, seq=seq_m, convo_id, ts, sender, type, payload, blob_ref, idem_key)
      update per-member conversation state:
        unread bump on conversation_members(m) UNLESS sender is m's own (sender == `user:${m.username}`)
          or the convo is a silent child (parent_convo_id != null)
        keep conversations.last_seq/snippet in sync for the owner row (mirror)
    return { perMember: { m: {seq_m, ts} }, duplicate }
  after commit, for each member m:
    hub.broadcastJournal(m, journalFrame({ seq: seq_m, convo_id, ... }), agent_device_id)
    pushPipeline.onAppend(m, frame, ...)
```

Design points the review must scrutinize:

- **Atomicity.** All per-member inserts + seq bumps happen in one `db.transaction()` so a shared event is all-or-nothing across members (no half-fanned event). `nextSeq` is already an atomic upsert-returning.
- **Idempotency under fan-out.** The idem key is per-member (`user_id` scoped). A client retry from member X re-dedups only X's copy — correct, because a retry only re-sends X's own message. The agent's own replies carry no client idem key (unchanged).
- **Unread attribution.** Under 2a a member does not bump their **own** unread (their own `user:${username}` send), but **does** bump for the other member's messages and for agent output — this generalizes the current single-owner predicate (`journal.js:114`) to per-member. `markRead` recompute (referenced at `journal.js:108`) moves to `conversation_members`.
- **WS delivery.** `hub.broadcastJournal(userId, ...)` is already per-user; we call it once per member with that member's framed copy. The agent device still receives frames for convos it owns (`agent_device_id`) — unchanged, and sufficient because the agent reads convo-scoped.
- **Ordering across members.** Each member's copy gets its own seq in its own space; there is no cross-member ordering guarantee needed (each client only ever reads its own space). The `ts` is shared, so relative ordering by `ts` is consistent across members.

---

## 7. Membership operations

- **Create (solo/group).** Conversation creation accepts an explicit **initial member set** (creator always included). Solo = `{creator}`; group = `{creator, other}`. The client modal chooses; the backbone just writes the member rows at creation. Default when unspecified = both known humans (product default), but the wire contract requires an explicit set so the server never guesses.
- **Add-member (+ history backfill).** Adding member M to convo C:
  1. Insert `conversation_members(C, M, role='member', added_by=..., joined_at=now)`.
  2. **Backfill history via 2a replay:** read C's existing event log convo-scoped (owner's copy, `idx_events_convo`), and for each historical event allocate `nextSeq(M)` and insert an M-space copy (preserving original `ts`, `sender`, `type`, `payload`). This gives M full prior history in their own space, consistent with how live events arrive. Backfill runs in one transaction; it is bounded by conversation length. `unread_count` for M is set to 0 on join (they are "caught up" by choice — or set to the count of non-M messages; default 0, review to confirm).
  3. Idempotent: re-adding an existing member is a no-op (PK conflict → skip, no re-backfill).
- **Remove / re-add.** Removal deletes the member row (their event copies may be retained or GC'd — default retain, since they're in the member's own space and harmless; a future cleanup can prune). Re-add backfills again from the canonical (owner) log, so "add someone back and share history" works by construction.
- **v1 grant surface = CLI/admin**, not in-app invite UX. A small admin command (`node scripts/members.js add <convo_id> <user>` or equivalent) performs the add + backfill. In-app invite/membership UX is deferred to the simplified-client sub-project. (Right-sized: for a known 2-person team, invite flows are disproportionate surface.)

---

## 8. Membership → tool tier (interface only; wiring is sub-project 2)

The backbone exposes a **pure function** the bridge consumes:

```
effectiveToolTier(convoId) =
  'restricted'  if ANY member is a restricted user (e.g. Nastia)   // worst-privilege-wins (V9)
  'full'        only if every member is a full-tools user (e.g. a Fantin-solo convo)
```

**Rule (operator-locked 2026-07-30): a GROUP convo is ALWAYS `restricted`.** Tool capability follows membership, worst-privilege-wins: any convo containing a restricted member runs the curated integration-only toolset; full dev tools only in a full-tools user's solo convo. This keeps the blast-radius boundary intact during collaboration.

The backbone's only responsibility here is to expose membership + a per-user "is full-tools" flag so the bridge can compute the tier at session spawn. The **actual curated toolset** (which MCP integration tools Nastia's Claude gets, and the hard exclusion of Bash/Edit/system tools) is **sub-project 2** and is where the real safety enforcement lives. This spec must not be read as delivering the toolset restriction — only the membership signal that drives it.

---

## 9. Out of scope (separate sub-projects, own spec → review)

1. **Curated toolset / per-user permissions (sub-project 2).** The actual restricted MCP toolset for restricted users, exclusion of dangerous tools, and enforcement at session spawn. This is the real blast-radius safety layer; the backbone only signals the tier.
2. **Simplified ChatGPT-like client (sub-project 3).** No commands / no code / no picker cards, in-app solo/group modal + invite UX. A matron-web front-end project.
3. **Separate-server isolation.** Same-server is the decision; a later lift-and-shift to a physically separate box (defense-in-depth) is possible without backbone rework because the tool tier — not the server — is the boundary.

---

## 10. Error handling & edge cases

- **Non-member write** → same "not authorized" throw as today (anti-enumeration preserved).
- **Add-member to a convo the actor doesn't own** → rejected (only an existing owner/member with grant rights, per §7 v1 = admin CLI, sidesteps this for now).
- **Partial fan-out crash** → whole `db.transaction()` rolls back; no half-fanned event (§6).
- **Backfill on a long convo** → bounded single transaction; acceptable at current scale (review to set a ceiling / chunking if a convo is pathologically long).
- **Agent reads a shared convo** → convo-scoped read (`idx_events_convo`), sees all members; writes fan out to all. Unchanged `agent_device_id` binding.
- **A member with no live device** → their event copies persist; they sync on next connect via their user-wide cursor (identical to today's offline path).

---

## 11. Testing

Server (`node --test`, existing harness in `test/`):

1. `conversation_members` migration: fresh SCHEMA has the table; in-place `openDb` on a pre-existing DB backfills one `owner` row per conversation, idempotent on re-run.
2. `isMember` gate: owner writes OK; added member writes OK; non-member write throws "not authorized"; foreign/missing convo throws (anti-enumeration).
3. 2a fan-out: a member's `send` produces one event row **per member** in each member's seq space, one WS broadcast per member; the sender's own unread does not bump, the other member's does.
4. Fan-out atomicity: a forced insert failure on member 2 rolls back member 1's insert and seq bump (no orphaned partial event).
5. Idempotency: same member re-sends same `local_id` → dedup in that member's space only, no seq burned, other members unaffected.
6. Add-member backfill: after add, M's space contains a copy of every prior event (same `ts`/`sender`/`type`), M's conversation list shows the convo; re-add is a no-op (no double-backfill).
7. `effectiveToolTier`: group convo → `restricted`; full-user solo → `full`; convo with a restricted member → `restricted`.
8. Read/snapshot: a member's snapshot includes shared convos they're a member of (via `conversation_members`), not only owned ones.

Bridge + web changes (member awareness in delivery scoping; conversation list driven by membership) get their own test additions in their repos; this spec's acceptance is the server backbone.

---

## 12. Acceptance criteria

- **AC1** Two distinct journal users can both `send` into the same conversation and each receives the other's messages and the agent's replies live, with correct `sender` attribution and correct per-member unread.
- **AC2** Creating a conversation with an explicit member set of one (solo) vs two (group) produces the corresponding `conversation_members` rows; a solo convo behaves exactly as today.
- **AC3** Adding a member to an existing conversation backfills full prior history into that member's space; the operation is idempotent.
- **AC4** A non-member's write is rejected identically to today's foreign-convo rejection.
- **AC5** `effectiveToolTier` returns `restricted` for any convo containing a restricted member and `full` only for a full-user solo convo; a group convo is always `restricted`.
- **AC6** All existing single-owner conversations continue to function unchanged after migration (owner row backfilled; owner's reads/unread/snapshots identical).

---

## 13. Open questions for review

- **Backfill unread on join:** 0 (caught-up) vs count-of-others' messages. Default 0; confirm.
- **Grant rights in v1:** admin CLI only (no in-app add). Confirm no per-member "can add others" flag is needed yet.
- **Event-copy retention on member removal:** retain vs prune. Default retain (harmless, in their own space). Confirm.
- **`conversations.unread_count`/`last_seq` mirror vs deprecate:** kept as owner mirror for read-path compatibility. Confirm we don't instead migrate all owner reads to `conversation_members` in this pass (larger blast radius).
