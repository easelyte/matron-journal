# Shared-Agent Collaboration Backbone — Design (v3)

- **Status:** converged, revision 4 (spec-review rounds 1–3; round 3 = convergence-by-class — architectural audit-completeness class closed, residual pseudocode↔prose consistency + tier-kill scope reconciled here)
- **Date:** 2026-07-30
- **Loop:** #458
- **Repos:** `easelyte/matron-journal` (server, primary), `easelyte/claude-matrix-bridge` (`/opt/matron/bridge-journal`), `easelyte/matron-web` (client)
- **Scope:** collaboration BACKBONE. Curated per-user *toolset* (which tools a restricted session gets) = sub-project 2; simplified ChatGPT-like *client* = sub-project 3 (§10). This spec delivers: the membership model, a **chokepoint architecture** that funnels all tenancy through 4 primitives + one authz gate, the complete call-site conversion, 2a fan-out with an explicit canonical copy, and the membership→tool-tier signal **and the concrete session-kill** on downgrade.
- **v3 change:** replaces v2's "enumerate & patch every `owner_user_id` string" with a **complete mechanism-by-mechanism surface map (§2)** and a **chokepoint design (§3)** — because rounds 1–2 showed single-tenancy is enforced across SQL predicates, the in-memory delivery registry, the write primitive, agent-op authz, read/cursor recomputes, deletion, and blob access, not just ownership SQL. Round-1/2 findings → resolution in §15.

---

## 1. Problem & Goal

Journal server is single-tenant-per-conversation (`conversations.owner_user_id`; `events PK(user_id, seq)` per-user monotonic; `devices.cursor` user-wide). Goal: **N humans share one Claude conversation**, each seeing the other's turns live, with full parity (Nastia = own `users` row id 2, own devices/read-state/`sender`), solo-or-group at creation, add-back-with-history, and a membership-derived tool tier. Non-goal: human-to-human federation.

**Why 2a (confirmed by audit):** `eventsAfter` (`journal.js:149`) is `WHERE user_id=? AND seq>?` — the WS replay is already per-user. Writing one event copy per member into each member's own `(user_id, seq)` space means each member's existing device cursor replays their own copy with **zero client sync-protocol change**. 2b (per-convo seq + per-convo cursors) would rework that replay/cursor model for every conversation across server + both clients. Operator chose 2a (2026-07-30).

---

## 2. Complete single-tenancy surface (audit, grep-confirmed HEAD 2026-07-30)

Single-tenancy is enforced through **8 mechanism classes**, not just `owner_user_id` SQL. Every site + required change:

### 2.1 SQL ownership predicates
`auth.js:106` `authorize()` (owner check — backs `messagesBefore`, `stream_append`, `activity`, `status`) → `isMember`. `journal.js:79` `append()` authz → membership. `journal.js:48` `upsertConversation` owner check → key off `agent_device_id` for agent upserts. `journal.js:143` `snapshot()` `WHERE owner_user_id=?` → include member convos. `journal.js:176` `markRead()` owner check → membership. `ws.js:419` `isReadOnlyChild` owner-scoped → membership. `push.js:160` `onAppend` owner lookup → per-member. `db.js:188` `unreadBadge` owner-sum → include member convos. `http.js:439` blob `owner_user_id` gate → §2.7.

### 2.2 The write primitive (fan-out classification)
`journal.js:76` `append()` is the **sole `INSERT INTO events`**, entered via `ws.js:398 appendAndFan` (all writes) + `journal.js:179 markRead`. Per-op fan requirement:
- **Fan to all members:** `send` (457), `prompt_reply` (478), agent `publish` (635), `finalize` (748), `convo_upsert`→`session_status` (616), `convo_upsert`→`convo_meta` (627).
- **Per-reader (NOT fanned):** `read_marker` (570) + `markRead`'s internal append — each member's read state is private.
- **Ephemeral (not journaled):** `stream`/`stream_append`, `activity`, `status` → §2.3.
- **Host-global (unaffected):** `host_vitals` (721).

### 2.3 In-memory delivery (`hub.js byUser`)
`byUser: Map<userId, Set<conn>>` — every helper reaches ONE user. `broadcastJournal` (`hub.js:85`), `sendEphemeral` (`hub.js:109`) → **union all members' connections**. `sendRpcRequest`/`sendRpcResponse` (138/153) stay device-targeted but authz widens (§2.4). Viewer catch-up: `statusCache` keyed `(userId,convoId)` (`ws.js:64`) and `toolStreams.buffersFor(userId,convoId)` (`tool-stream.js:99`) — both stamped under the **owner's** userId, so a non-owner member gets **no header + no scrollback** on `viewing` (`ws.js:431`). **Re-key both by `convoId`.**

### 2.4 Agent-op authorization
`authorize()` called at `ws.js:662` (`stream_append`), `693` (`activity`), `711` (`status`) — all owner-based → **agent-device-based** (`conn.deviceId == conversations.agent_device_id`). `ws.js:653` `stream` has **no authz** (inert only because delivery is user-scoped today) → add agent-device authz **before** `sendEphemeral` fans to members, else cross-convo leak. RPC target checks `ws.js:520` (`agent_request` target user==self) + `ws.js:555` (`agent_response` target user==self) → **member-of-agent's-convo**.

### 2.5 Read / cursor / sync (silent-corruption class)
`eventsAfter` (`journal.js:149`, `WHERE user_id=? AND seq>?`) → **keep** (per-member replay is why 2a works). `messagesBefore` (`journal.js:155`, `WHERE convo_id=?` only) → **add `AND user_id=<requester>`** or it returns N duplicate copies. `markRead` unread recompute (`journal.js:189`, `COUNT(*) WHERE convo_id=? AND seq>?`) → **add `AND user_id=<marker>`** or it counts all members' copies (inflated unread); the marker `seq` is only meaningful in the marking member's own space. `devices.cursor` (`ws.js:453`) per-member OK; **no cross-member seq comparison is valid** (a shared event has a different seq per member).

### 2.6 Deletion / identity lifecycle
No user-deletion path exists today (safe by absence). `users.id` has **no AUTOINCREMENT** → rowids reused after delete; `events` has **no FK to users** + is `user_id`-scoped. Under fan-out, retaining a removed member's event copies is **unsafe**: a reused id replays them via `eventsAfter`. Resolution: **member removal / user deletion hard-deletes that user's `events` + `user_seq` + `devices` rows for the affected scope** (a leave purges the member's copies of that convo's events; a full user deletion purges all their rows) in one transaction. `AUTOINCREMENT` on `users.id` is added as defense-in-depth against id reuse.

### 2.7 Blob / media access
`http.js:439` `blob.owner_user_id !== who.userId → 404`. A fanned event carries the same `blob_ref` into every member's copy, but the blob is uploader-owned → non-uploader members 404. **Allow fetch if the requester is a member of a conversation whose (own copy of an) event references the blob.** Uploader ownership (`insertBlob`) unchanged. `retention.js:66` offload owns the blob under `row.user_id`. Offloaded shared tool-output would create N owner-scoped blobs (one per member copy). "Offload once under owner, others reference it" is **not implementable without a logical-event correlation key**, which §4.4 forecloses (no `events` column change). Resolution (round-3 Claude-M2): **accept per-copy offload** — `retention.js` is left unchanged; each member's copy offloads independently under its own `user_id`. This is correctness-safe (the §2.7 blob-access gate still resolves each member's own copy) — the only cost is storage duplication of large offloaded outputs, an acceptable tradeoff vs. adding a logical-event id to a hot table. Documented so no consumer assumes single-copy offload.

### 2.8 Server-generated event fan classification
`read_marker` = per-reader (private). `session_status` + `convo_meta` = fan to all members. Tool streams / `status` / `activity` = deliver to all viewing members. `host_vitals` = host-global, unchanged.

---

## 3. Chokepoint architecture

Tenancy is enforced at **five** places, and every site in §2 funnels through one of them:

1. **`isMember(db, userId, convoId)`** — the one authz predicate. Rewriting `authorize()` (`auth.js:106`) to call it covers `messagesBefore`/`stream_append`/`activity`/`status` in one edit; the hand-inlined `owner_user_id` predicates (§2.1) each convert to `isMember` at their site.
2. **`appendShared()`** — the sole persisted-write chokepoint. `append()` (`journal.js:76`) is already the only `INSERT INTO events`; it becomes membership-aware and fans one copy per member **in one transaction**. Both callers (`appendAndFan`, and `markRead` — which passes a **per-reader** flag to skip fan) inherit it. Read_marker/unread stay single-member.
3. **`broadcastJournal(userId, frame_m, agentDeviceId)`** — journal-frame delivery, **called once per member** by `appendShared`'s post-commit loop (retains the current per-user signature so the round-2 M2 per-member failure isolation works). Each member receives a frame carrying **their own** `seq_m` (§3.1) — never the canonical seq, and never N copies. The loop, not the function, is the fan point; `hub.byUser` stays user-keyed.
4. **`sendEphemeral(convoId, frame)`** — ephemeral delivery (tool streams, activity, status). Unions all members' viewing connections; paired with re-keying `statusCache`/`toolStreams.buffersFor` by `convoId` so `viewing` catch-up reaches every member.
5. **Agent-op authz = `agent_device_id`** — agent write/stream/status/RPC ops authorize on `conn.deviceId == conversations.agent_device_id`, decoupled from human ownership.

### 3.1 Canonical copy
The SAME logical event exists as N physical rows. **Canonical copy = the owner's `user_id` space.** Reads split by intent:
- **Member-facing** (a member reading *their* view — `eventsAfter`, `messagesBefore`, `markRead` recompute): scope to that member's own copy (`user_id = requester`).
- **Canonical/agent-facing** (add-member backfill source; retention offload owner): the owner's copy (`user_id = owner_user_id`).
- **Never** read `WHERE convo_id=?` without a `user_id` predicate.

---

## 4. Data model

### 4.1 `conversation_members` (per-member state; sole authoritative unread)
```sql
CREATE TABLE IF NOT EXISTS conversation_members(
  convo_id TEXT NOT NULL, user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','member')),
  unread_count INTEGER NOT NULL DEFAULT 0,
  backfill_state TEXT NOT NULL DEFAULT 'complete' CHECK(backfill_state IN ('pending','complete')),
  backfill_cursor INTEGER NOT NULL DEFAULT 0,   -- last owner-copy seq copied into this member's space (round-3 Codex-M1); resume point
  added_by INTEGER, joined_at INTEGER NOT NULL,
  PRIMARY KEY(convo_id, user_id));
CREATE INDEX IF NOT EXISTS idx_convo_members_user ON conversation_members(user_id);
```
`unread_count` here is authoritative. `conversations.unread_count` is **no longer read or written** after migration (both `append`-path and `markRead` stop writing it — resolving the round-2 dual-write race); the column is left in place (drop deferred). `backfill_state='pending'` gates a partially-backfilled member (§7).

### 4.2 `users.tools_tier`
```sql
ALTER TABLE users ADD COLUMN tools_tier TEXT NOT NULL DEFAULT 'restricted'
  CHECK(tools_tier IN ('full','restricted'));
```
Fresh SCHEMA includes it. **One-shot migration** (§4.6): the `UPDATE ... SET tools_tier='full'` for existing users runs **only in the same migration execution that adds the column** (guarded by the `PRAGMA table_info` "column absent" branch), so a later restart after Nastia exists never re-promotes her.

### 4.3 `conversation_member_audit` (append-only, durable identity)
```sql
CREATE TABLE IF NOT EXISTS conversation_member_audit(
  id INTEGER PRIMARY KEY, convo_id TEXT NOT NULL,
  target_user_id INTEGER NOT NULL,          -- stable numeric id, not mutable name
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('cli','user')),
  actor_user_id INTEGER,                     -- resolved id when actor_kind='user'; NULL for cli
  action TEXT NOT NULL CHECK(action IN ('add','remove')),
  prev_tier TEXT, new_tier TEXT, backfilled INTEGER, ts INTEGER NOT NULL);
```
Actor recorded as a **stable numeric id** (not the mutable `name`). Append-only by convention **and** no application `UPDATE`/`DELETE` path is exposed (P30 tier-1). **Retention: indefinite** (security evidence; documented at write-one, P53). Removal writes an `action='remove'` row (evidence not deleted).

### 4.4 `conversations` / `events` — no column change.

### 4.5 `users.id` — add `AUTOINCREMENT` (defense-in-depth vs rowid reuse; SQLite requires table rebuild — done as a guarded one-shot migration for the existing DB).

### 4.6 Migration — one transaction, one-shot promotion, idempotent
`openDb` in-place: create the two tables + `AUTOINCREMENT` rebuild; add `users.tools_tier` **and in the same absent-column branch** set existing users `'full'`; backfill one `role='owner',backfill_state='complete'` member per existing convo (`ON CONFLICT DO NOTHING`). Whole migration in one transaction. Rerun-idempotent (column-absent guard prevents re-promotion; `ON CONFLICT` prevents re-backfill). **A pre-migration DB backup is a mandatory deploy gate** (§10 rollback).

---

## 5. Authorization — every §2.1/§2.4 site → `isMember` or agent-device

`isMember(db, userId, convoId) = !!SELECT 1 FROM conversation_members WHERE convo_id=? AND user_id=?`. Applied at every §2.1 site (append, markRead, snapshot/list JOIN, isReadOnlyChild drop owner filter, unreadBadge sum members, push per-member, upsertConversation agent-device path, blob §2.7). `authorize()`→`isMember` covers messagesBefore + the three agent ops, which additionally gain the **agent-device** check (§2.4). Non-member → identical "not authorized" (anti-enumeration). `stream` (`ws.js:653`) gains the agent-device authz it lacks.

---

## 6. `appendShared` — actor + membership + fan-out, all in one transaction

```
appendShared(db, { convoId, authUserId, agentDeviceId=null, sender, type, payload, blobRef, idemKey, perReader=false }):
  result = db.transaction(() => {
    // authz INSIDE txn (round-2 race fix): a human actor must be a member; an
    // agent actor must own the session (device binding checked in-txn, round-3 B2).
    if agentDeviceId != null:
       if SELECT agent_device_id FROM conversations WHERE id=convoId != agentDeviceId: throw 'not authorized'
    else if not isMember(db, authUserId, convoId): throw 'not authorized'
    if perReader:  // read_marker / markRead — single-member, private
       seq_r = nextSeq(db, authUserId); INSERT events(user_id=authUserId, seq=seq_r, ...)
       recompute conversation_members(authUserId).unread_count (AND user_id=authUserId)
       return { perReader:true, reader:authUserId, seq:seq_r }
    if idemKey and exists(events WHERE user_id=owner AND convo_id AND idem_key):
       return { duplicate:true }                                        // whole-call idempotency vs canonical copy
    // FAN ONLY to backfill-complete members; a 'pending' member gets history first,
    // then live once complete (round-3 B1: the filter §7 promises, now in the SELECT)
    members = SELECT user_id FROM conversation_members
              WHERE convo_id=? AND backfill_state='complete' ORDER BY user_id
    perMember = {}
    for m in members:
       seq_m = nextSeq(db, m); INSERT events(user_id=m, seq=seq_m, ...); perMember[m]=seq_m
       bump conversation_members(m).unread_count UNLESS sender is m's own OR parent_convo_id set
    return { perMember }
  })
  // post-commit delivery (round-2 M2): per member, isolated; a throw for one MUST NOT skip others.
  // perReader → deliver ONLY to the reader's own devices (round-3 M3, keeps read state private).
  if result.perReader:
     try { broadcastJournal(result.reader, frameWithSeq(result.seq), agentDeviceId) } catch(e){ log delivery_failure; }
  else for m,seq_m in result.perMember:
     try { broadcastJournal(m, frameWithSeq(seq_m), agentDeviceId); pushPipeline.onAppend(m, frame) }
     catch(e){ log structured delivery_failure{convo,member,seq_m}; continue }  // recovered on reconnect replay
```
- **Actor in-transaction** (round-2 Codex-M1, round-3 Codex-B2): the authz check (human `isMember` OR agent `agent_device_id` binding), member SELECT, and inserts share one transaction → a concurrent membership mutation OR a session reassignment can't authorize a removed writer, a non-owning agent device, or miss a new member.
- **Two actor kinds, one primitive.** A **human** write passes `authUserId=conn.userId` (member check). An **agent** write (`publish`/`finalize`/`convo_upsert` server-events) passes `agentDeviceId=conn.deviceId` (device-binding check) + writes canonically as the owner (`sender='agent:<name>'`). `sender` is attribution only, never authorization. Every persisted agent call site routes here — no agent write bypasses the in-txn device check.
- **Whole-call idempotency** checked against the canonical (owner) copy → a retry from any member short-circuits the entire fan (no per-member duplicate delivery).
- **Delivery failure isolated + logged** (P3/P34); reconnect replay is the recovery path.

---

## 7. Membership operations

- **Create — atomic, explicit set.** Takes a **required** `members` array (creator included, role `owner`). Omitted/empty → `bad_request` (no server default; "both" is a client UX default). Convo row + all member rows in **one transaction** (round-2 Codex-M2). Owner row is `backfill_state='complete'`.
- **Add-member — crash-safe backfill (round-2 both-B/M).**
  1. Insert member row `backfill_state='pending'`, `backfill_cursor=0`. **Pending-member visibility rule (round-3 Codex-M2): a `pending` convo is HIDDEN from the member — excluded from their snapshot/list, and their `eventsAfter`/`messagesBefore` return nothing for it — until `backfill_state='complete'`.** So a member never sees a partial/mis-ordered history; the convo appears atomically once complete. A pending member is likewise **excluded from `appendShared`'s live fan** (the §6 SELECT filters `backfill_state='complete'`), closing the concurrent-append-races-backfill race.
  2. Backfill from the **owner canonical copy** (`WHERE convo_id=? AND user_id=owner AND seq > backfill_cursor ORDER BY seq LIMIT 500`) in **chunks ≤500/txn**; each chunk transaction copies rows into the member's space AND advances `conversation_members.backfill_cursor` to the last-copied owner-seq **atomically**. A crash mid-backfill leaves `pending` + a durable cursor; re-running `add` **resumes** from `backfill_cursor` (not a no-op — round-2 M3/round-3 Codex-M1 fix). The copy is idempotent per chunk (cursor advance + inserts in one txn).
  3. On the final chunk, in one transaction: flip `backfill_state='complete'`, set `unread_count=0`, write the `add` audit row with `backfilled=<count>`, and start including the member in live fan.
  4. Hard ceiling `MEMBER_BACKFILL_MAX_EVENTS` (50 000) → abort with a clear error, member left removable.
  5. Idempotent: re-add of a `complete` member is a no-op; re-add of a `pending` member **resumes**.
- **Remove-member.** Only a `member` (not `owner`, §7 invariant) may be removed via this path. Delete the member row; **hard-delete that member's copies of this convo's events + their `user_seq`/cursor as scoped** (§2.6 leak fix); write `remove` audit. Tier re-eval (§8).
- **Owner invariant (round-2 M4, round-3 minor):** the `role='owner'` row is **immutable membership** — it cannot be removed while the conversation exists. Enforced at the **store/primitive level** (the `removeMember` function itself throws on `role='owner'`), not merely in the CLI — so any future caller of the primitive is protected, matching the chokepoint philosophy. The owner anchors the canonical copy (§3.1) and the agent write identity (§6). Deleting a conversation removes its owner row + all member rows + all event copies.
- **User deletion** (§2.6): removes ALL that user's `conversation_members` + `events` + `user_seq` + `devices` rows in one transaction; owned conversations are reassigned or deleted (operator CLI choice). No dangling copy survives a user id.
- **v1 grant surface = CLI/admin** (`bin/matron-admin members add|remove <convo> <user>`); in-app invite = sub-project 3.

---

## 8. Tool tier: storage, corrected formula, signal + concrete kill

```
effectiveToolTier(convoId):
  members = SELECT user_id FROM conversation_members WHERE convo_id=?
  if members.length >= 2: return 'restricted'                 // group is ALWAYS restricted (operator lock)
  return (the single member's users.tools_tier)               // solo: their own tier
```
Round-2 Codex-B3 fix: the group case is decided by **member count first** (≥2 → restricted), not by "all full → full". `full` only for a full-user **solo** convo. `tools_tier` is a real column (§4.2).

**Signal + fail-closed termination (scope corrected, round-3 Codex-B3).** The backbone cannot terminate the Claude *process* or revoke its tool *capabilities* — that lives in the bridge. What the backbone DOES own, on any membership change that alters `effectiveToolTier`:
  (a) write prev/new tier to the audit row;
  (b) set `session_state='archived'` and **force-close the WS connection bound to the convo's `agent_device_id`** — this severs the transport so the stale-tier session cannot deliver or persist further into the journal (server-side containment);
  (c) emit a `tier_changed` journal control event (§9) that the bridge MUST consume to actually **kill the process + respawn at the new tier**.
**Fail-closed contract:** the bridge must ACK `tier_changed` within a timeout; **until an ACK is recorded, the convo stays `archived` and all writes to it are rejected** (worst-signal-wins, V9). A disconnected/non-acking bridge therefore cannot leave a full-tier session operating against the journal — the boundary the backbone owns (journal access) is closed regardless. **The actual process-kill + capability-revocation is a bridge responsibility (sub-project 2 / a named bridge dependency), not a backbone guarantee.** This corrects v3's over-claim that a socket close alone is a "kill": backbone = archive + transport-sever + signal + fail-closed gate; bridge = process termination; sub-project 2 = the restricted toolset the respawn gets.

---

## 9. `tier_changed` wire shape
A journal event `type='tier_changed'`, `payload={convo_id, prev_tier, new_tier, reason:'membership_change'}`, fanned to all members (so clients can reflect it) and consumed by the bridge (which owns the `agent_device_id`) to confirm the archive. Added to the server's known control-event types (not a `MESSAGE_TYPES` content type — it doesn't bump unread).

---

## 10. Out of scope / rollback / failure modes

**Out of scope:** curated toolset enforcement (sub-project 2 — the restricted MCP set + dangerous-tool exclusion; backbone only signals + kills); simplified client (sub-project 3); separate-server isolation (later lift-and-shift; the tool tier, not the server, is the boundary).

**Rollback (round-2 Codex-M4):** the first fan-out write is a declared **point of no return** — after it, multi-copy events exist that pre-migration code mis-reads. Binary rollback is unsupported; the rollback path is **restore from the mandatory pre-migration DB backup** (a deploy gate).

**Failure modes:** partial fan-out → whole txn rolls back; delivery failure → isolated + logged + reconnect-replay recovery (§6); backfill crash → resumable via `backfill_state='pending'` + cursor (§7); tier downgrade on live session → archived + respawn (§8); offline member → copies persist, sync on reconnect.

---

## 11. Testing (by mechanism class)
1. Migration: fresh SCHEMA + in-place both idempotent (rerun no re-promote — create Nastia then restart → still restricted; no re-backfill); one transaction; `AUTOINCREMENT` present.
2. `isMember` at **every** §2.1 site: owner + member OK, non-member rejected identically to foreign convo.
3. Canonical-copy: `messagesBefore` returns each event **exactly once** for a member (row-count parity, guards §2.5 dup); `markRead` recompute counts only the marker's copies.
4. `appendShared`: one row per member; **exact per-member parity**; sender's own unread not bumped, others' bumped; actor check inside txn (concurrent remove between hypothetical check and insert cannot authorize — serialized).
5. Whole-call idempotency: retry inserts **zero** new rows for **every** member.
6. Delivery: a second member receives live journal frames, tool streams, activity, status header, and scrollback on `viewing` (guards §2.3); a broadcast throw for member 1 does not skip member 2 (isolation).
7. Agent ops: `stream_append`/`activity`/`status`/`stream` authorized by `agent_device_id` for a non-owner-owned convo; RPC reaches a non-owner member.
8. Backfill: exact parity incl. 3-member; chunk >500; **crash mid-backfill → pending + cursor → re-run resumes to parity** (not no-op); concurrent append during pending doesn't duplicate/misorder (pending excluded from live fan).
9. Identity lifecycle: user deletion purges events+user_seq+devices+members (no orphan copy); ratchet — no `events.user_id`/`conversation_members.user_id` without a live user; owner-role removal rejected.
10. Tier: group(≥2)→restricted even if all full; full-solo→full; adding a restricted member to a live full session emits `tier_changed`, archives + **force-closes the agent WS** (assert socket CLOSED / `close()` observed on the conn bound to that `agent_device_id`, not just the DB flag — round-3 M3), writes prev/new audit; a write attempted before the bridge ACK is rejected (fail-closed).
11. Blob: a non-uploader member fetches a shared-convo blob; a non-member 404s.
12. unreadBadge/snapshot read `conversation_members`; `conversations.unread_count` no longer written by append or markRead.

Bridge/web changes (membership lists, agent-device authz consumption, `tier_changed` handling) tested in their repos.

---

## 12. Acceptance criteria
- **AC1** Two members both send/receive live (journal + streams + status + activity), correct `sender`, per-member unread, pagination/markRead/push/scrollback all work for the non-owner.
- **AC2** Explicit 1-member (solo) vs 2-member (group) create; omitted set → `bad_request`; solo unchanged.
- **AC3** Add-member reaches exact row-count parity (incl. 3-member), chunked + **resumable after crash**, audited; idempotent/resumable.
- **AC4** Non-member rejected identically at every audited site (SQL + delivery + agent-op).
- **AC5** `effectiveToolTier` = restricted for any ≥2-member convo (even all-full) and full only for a full-user solo; adding a restricted member to a live full session emits `tier_changed`, archives the session, audits prev/new, **and force-closes the WS bound to that `agent_device_id`** (assert the connection transitions to CLOSED, not merely a DB flag); until the bridge ACKs `tier_changed`, further writes to the convo are rejected (fail-closed).
- **AC6** Migration one-shot (no re-promote on restart), backfills owner rows, existing convos unchanged.
- **AC7** User deletion leaves no `events`/`conversation_members` row referencing a reusable id; owner membership is immutable.
- **AC8** A second member fetches shared-convo media they didn't upload.

---

## 13. Rejected / deferred
2b (rejected §1). In-app membership UX (sub-project 3). Curated toolset (sub-project 2). Dropping `conversations.unread_count` (deferred; stop-writing this pass).

## 14. Open questions
- `tier_changed` archive vs pause semantics on the bridge side (does the bridge hard-archive or soft-suspend?) — confirm with the bridge repo.
- Offloaded shared tool-output blob: offload once under owner (chosen §2.7) vs per-copy — confirm no consumer assumes per-user offload.

## 15. Round 1–2 findings → v3 resolution
Canonical-copy multiplies (R1 Codex-B1/Claude-B3) → §2.5 `user_id` predicates on messagesBefore+markRead + §3.1 + §11.3. Incomplete audit (R1 Claude-B1, **R2 both — the meta-finding**) → §2 complete 8-class surface + §3 chokepoints. Push/badge non-owner (R1 B2) → §2.1 + §5. Backfill dup 3+ (R1 B3) → §7 owner-copy source. Idempotency (R1 B4) → §6 whole-call. `tools_tier` missing (R1 B5) → §4.2. Unbounded backfill (R1 B6) → §7 chunked. ROWID reuse (R1 Codex-B2, **R2 Codex-B1 deletion leak**) → §2.6 hard-delete copies + §4.5 AUTOINCREMENT. Tier stale (R1/R2 Codex-B3) → §8 kill. appendShared actor (R1 Codex-M1) → §6. Atomic create (R1 Codex-M2) → §7. Missing member set (R1 Codex-M3) → §7. Agent identity (R1 Claude-M1) → §2.4/§8-agent-device. isReadOnlyChild (R1 M2) → §2.1. Rollback (R1 Codex-M4) → §10. Audit trail (R1 Codex-M5, **R2 Codex-M3 durable id**) → §4.3 stable id + retention. **R2 new:** appendShared unwired (Claude-B1) → §3.2/§6 chokepoint both callers. hub.js delivery (Claude-B2) → §2.3/§3 chokepoints 3–4. authorize 693/711 (Claude-B3) → §2.4. tier formula contradiction (Codex-B3) → §8 count-first. appendShared race (Codex-M1) → §6 in-txn. delivery failure (Codex-M2) → §6 isolated+logged. migration re-promote (Codex-M4) → §4.2/§4.6 one-shot. markRead recompute SQL (Claude-M1) → §2.5. unread_count write race (Claude-M2) → §4.1 stop writing. backfill recovery (Claude-M3/Codex-B2) → §7 resumable. owner removal (Claude-M4) → §7 owner invariant.

**Round 3 (v4 fixes — convergence; audit-completeness class confirmed CLOSED by both reviewers):** appendShared SELECT missing backfill filter (Claude-B1) → §6 `backfill_state='complete'` in SELECT. broadcastJournal signature vs per-member seq (Claude-M1/Codex-B1) → §3.3 per-member call + §6 `frameWithSeq(seq_m)`. agent write device-binding lost (Codex-B2) → §6 in-txn `agentDeviceId` check + all agent call sites route through it. socket-close-isn't-process-kill (Codex-B3) → §8 scope corrected to backbone(archive+transport-sever+signal+fail-closed) / bridge(process-kill) / sub-project-2(toolset). backfill cursor not in DDL (Codex-M1) → §4.1 `backfill_cursor` column. pending-member partial-history visibility (Codex-M2) → §7 pending convo HIDDEN until complete. perReader delivery undefined (Codex-M3) → §6 reader-own-devices-only delivery. retention offload correlation key (Claude-M2) → §2.7 accept per-copy offload. AC5/Test10 don't assert WS-close (Claude-M3) → §12 AC5 + §11 Test 10 assert socket CLOSED. owner-invariant enforcement location (Claude-minor) → §7 store-level.
