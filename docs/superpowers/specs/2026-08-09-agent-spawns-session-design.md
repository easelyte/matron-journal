# Agent-spawned sessions — design

**Date:** 2026-08-09
**Status:** approved (Dan, 2026-08-09)
**Repos touched:** matron-journal, matron-bridge, matron-apple, matron-android

## Goal

Let an agent farm a job out to a **new first-party Matron session on another
box**, instead of its only options being "talk to an agent that already
exists" or "spawn a subagent inside my own context".

The spawned session is an ordinary session — it appears in the user's chat
list, it is reaped on idle, the user can talk to it. It also comes with an
agent-chat room joining parent and child, so the two can keep talking
asynchronously after the hand-off.

Every spawn requires the user's explicit approval, every time.

## Background: what already exists

- **Agent RPC relay** (`2026-07-15-agent-rpc-design.md`). The journal relays
  opaque requests from a client device to an agent device (`agent_request` /
  `agent_response`). The bridge implements two methods on it:
  `recent_folders` (the app's folder picker) and `start` (`{workdir,
  browser}` → spawns a session → returns `convo_id`). This is how the app's
  new-chat flow already works.
- **Agent chat** (`2026-08-06 agent-to-agent chat`, Phases 1–3). Rooms,
  participants (`convo_agents`), invites, the eight `agent_chat_*` MCP tools,
  hybrid idle/busy delivery with queued/delivered notices.
- **Agent chat consent** (`2026-08-07-agent-chat-consent-design.md`). An ask
  parks in `awaiting_user`; a card is published into the requesting agent's
  own conversation; the user answers over `POST /agent-chat/answer`; a
  24-hour TTL with a half-TTL sweep expires unanswered asks.

Three gaps stand between that and this feature:

1. The relay is client → agent only (`if (conn.kind !== 'client') return
   fail('forbidden')`), so an agent cannot issue an RPC at all.
2. `start` takes no opening prompt — it spawns an idle session with nobody
   to tell it the job.
3. Nothing links child back to parent, and there is no channel for a result.

## Architecture

**Journal-brokered.** The parent agent asks the journal; the journal parks
the request durably, gets the user's answer, and then issues the `start` RPC
to the target box **itself**.

The alternative — letting agents issue RPC directly and having the target
bridge ask for consent — was rejected. The relay is deliberately stateless
(single-consumer, no queueing, immediate `agent_unreachable` when the target
has no live socket), so nothing can sit in it across human latency; a bridge
restart would drop a pending request silently. And it asks the wrong
question at the wrong door: "may this agent start work on your behalf" is a
decision about the user and the parent, not about the target machine.

Modelling a spawn as an invite to a not-yet-existing session (reusing
`convo_agents` wholesale) was also rejected: that table's states describe an
agent joining a conversation that exists, and bending them to also mean "an
agent that does not exist yet, on a box, in a directory" would distort both
features.

**Consequence:** the journal must learn to *await* RPC responses. Today it
correlates nothing — it forwards a request and forwards whatever comes back.
Under this design it issues `start` itself and must hear the reply to learn
the child's `convo_id`. That is a pending-request map keyed by `request_id`
with a timeout. Once it exists, folder discovery rides it for free.

## End-to-end flow

1. **Discover.** The parent calls `agent_boxes`. The journal returns the
   user's agent devices (name, id, online) and, per box, its recent folders,
   brokered from that box's existing `recent_folders` RPC. Offline boxes are
   listed with no folders.
2. **Ask.** The parent calls `agent_session_start(device_id, workdir, task,
   topic?)`. The bridge forwards it as `spawn_request`. The journal
   validates ownership **and that the target box has a live socket**, writes
   an `agent_spawn_requests` row in `awaiting_user`, and answers the tool
   `pending`. An unreachable box is refused here, before any card is
   published. The parent's turn ends; it is not blocked.
3. **Consent.** The journal publishes the card into the parent's own
   conversation, naming the parent session, the target box, the resolved
   workdir and the task text. One tap.
4. **On approve.** The tap first *claims* the row: `UPDATE … SET
   state='approved' … WHERE id=? AND state='awaiting_user'`, and a zero
   row-count answers 409 and stops. Everything after this is expensive and
   externally visible — a room, a live agent on another box — so nothing
   starts until exactly one caller has won the claim. Two taps from two
   devices therefore spawn once, which is what the failure table below
   promises. The winner then creates the room convo, records both agents
   as `joined` (no second invite — approving the spawn approved the pair),
   and issues `start` to the target bridge with `{workdir, prompt,
   room_id}`. The target bridge spawns, joins the room, and seeds the
   child's first turn. The journal moves the row to `started`, writes
   `room_id` and `child_convo_id` onto it, and tells the parent, which
   surfaces as a turn. `approved` is thus the window in which a spawn is
   authorised but not yet live — the state a journal restart mid-`start`
   finds the row in, and the one the broker timeout resolves to `failed`.
5. **On refuse / timeout / failure.** The row moves to `denied` / `expired` /
   `failed`; the parent hears exactly one outcome either way. A spawn that
   fails after approval closes the room with the epitaph line
   `deadRoomLine` already writes.
6. **After.** The child is an ordinary session; the room is an ordinary
   room. Idle reaping applies to both.

**Ordering is load-bearing:** room first, then spawn. Spawning first would,
on a room-creation failure, leave a live agent on another box with no
channel and no provenance.

## Consent

Every spawn asks. There is no standing permission and no "always allow".

This design also **removes standing allowances from agent chat**: the
`agent_chat_allowances` table, `isAllowed`/`addAllowance`/`listAllowances`/
`removeAllowance`/`forgetDeviceAllowances`, the `always_allow` field on
`POST /agent-chat/answer`, the HTTP list/revoke endpoints, and the
allowances screen on iOS/Mac/Android. The gate is per *room*, not per
message, so once a chat exists the agents talk freely — and a spawn is by
definition a rare, deliberate act. Dead code that reads as a live security
control is worse than no code.

**That removal ships as its own PR**, before or alongside this work, so the
consent path's history stays readable.

### Two deliberate differences from the chat consent path

- **A denial is reported plainly** as `declined`, with no reason. In chat, a
  user's "no" reaches the requester as `refused`, indistinguishable from the
  peer's own refusal, so a requesting agent can never learn the human said
  no. Here there is no peer to hide behind; the parent must be told
  something, and inventing a box-side failure would send the agent off
  diagnosing a network problem that does not exist.
- **A cap on outstanding asks per agent.** Every-time consent makes the
  user's attention the throttle, and a looping agent must not be able to
  stack forty cards against it. The cap counts **both** tables: pending
  spawn rows live in `agent_spawn_requests`, so reusing `convo_agents`'
  `countPendingByInitiator` unchanged would leave spawn cards uncapped
  while chat invites stayed capped — and an agent that has exhausted its
  chat-invite budget could still spawn freely. One `countPendingAsks(db,
  fromDeviceId)` sums `awaiting_user` rows across both, and both surfaces
  check it against one shared limit. What the user is being protected from
  is cards, not any one table's cards.

**No depth cap.** A child may itself spawn a grandchild; every link costs
the user a tap, which is a better throttle than a number, and the second
card arrives before the first job finishes. Provenance is recorded so a
chain is traceable.

## Tool surface (matron-bridge, MCP)

```
agent_boxes()
  → { boxes: [ { device_id, name, online,
                 default_workdir, folders: [{path, last_used}] } ] }
```

Self is excluded, and the list is withheld entirely when the bridge's own
identity is unknown — the same fail-closed stance `agent_roster` takes,
for the same reason (a self-entry is a self-spawn trap).

```
agent_session_start({ device_id, workdir, task, topic? })
  → { status: "pending" }        // outcome arrives later as a turn
```

- `task` is **both** the prompt the child is seeded with and the text the
  user's card shows. Unlike `agent_chat_start`, there is no separate
  `justification`: a second agent-authored blob summarising the first
  guarantees that the one the user reads is not the one that takes effect.
- Caps: `task` ≤ 2000 chars, `topic` ≤ 200 (the journal's
  `INVITE_TOPIC_MAX_CHARS`). Both flattened through the peer-text discipline
  (`oneLine`/`peerField`) before reaching the card — this text comes from an
  agent, and a newline in it must not forge a second line on a consent card.

### Ask the user where, first

The tool description instructs the calling agent, unconditionally:

> If the user has not already said which box and directory the work should
> happen in, ask them before calling this. They usually have a preference,
> and the consent card can only be approved or declined — it cannot be
> corrected.

This is not a fallback for when the user is present; it is the normal path.
A spawn cannot proceed without the user's tap regardless, so an agent that
guesses saves nothing — it just moves the same wait to after the request,
where a wrong guess costs a decline and a retry instead of one question.

Consequently the card stays a plain approve/decline, and a decline stays a
bare `declined` with no reason. The box and the directory — the two fields
a reason could usefully correct — have already been agreed before the card
exists. The `task` has not: it is agent-authored, it is executed verbatim,
and the user may well decline precisely because it is wrong. That is
accepted rather than solved. The parent is in an open conversation with
the user, so the correction arrives there, in the user's own words, and
the parent asks again — which is a better channel for "not like that" than
any structured reason code, and keeps the card itself a single tap.

### What the child wakes up to

The **target bridge** composes the opening turn, not the parent — so a
parent cannot dictate the framing. It names the parent session and box,
states the task verbatim, and says the room is the channel back, that it is
asynchronous, that the child should report there when done, and that the
user can read every word of it.

### What the user sees

Three things, all in chats they already have: the consent card in the
parent's conversation; the new session in the chat list, titled from the
task by the existing title-seed path; and the room, where the report lands.

## matron-journal changes

### Schema

```sql
CREATE TABLE IF NOT EXISTS agent_spawn_requests(
  id                TEXT PRIMARY KEY,
  user_id           INTEGER NOT NULL,
  from_device_id    INTEGER NOT NULL,
  from_convo_id     TEXT NOT NULL,
  target_device_id  INTEGER NOT NULL,
  workdir           TEXT NOT NULL,
  task              TEXT NOT NULL,
  topic             TEXT NOT NULL DEFAULT '',
  state             TEXT NOT NULL CHECK(state IN
                      ('awaiting_user','approved','started',
                       'denied','expired','failed')),
  room_id           TEXT,
  child_convo_id    TEXT,
  created_at        INTEGER NOT NULL,
  answered_at       INTEGER,
  resolved_at       INTEGER
);
```

`from_convo_id` is the parent session: where the card goes and where the
outcome lands. The CHECK lists every state the code can write — the
`convo_agents` lesson, where an unlisted value (`ended`) made the upsert fail
silently and left rooms stuck in whatever state they were created with.

### Ops and endpoints

- `spawn_targets` (agent-only) — backs `agent_boxes`.
- `spawn_request` (agent-only) — parks a request.
- `POST /agent-spawn/answer {request_id, decision}` (client-only) — mirrors
  `/agent-chat/answer`, including its rule that an agent may never answer a
  consent ask, *including one addressed to itself*. No `always_allow`.

Both ops inherit `agent_request`'s ownership checks verbatim: unknown
device, another user's device, and a client-kind device are indistinguishable
`not_found` (anti-enumeration, matching the HTTP 404 stance).

### RPC brokering

A pending-request map keyed by `request_id`, with a timeout. `agent_response`
currently requires the reply's target to be a `client` device; it gains a
branch for journal-originated requests, which resolve internally rather than
being forwarded. A timeout resolves the spawn as `failed` — never left
hanging.

### Expiry

The 24-hour TTL and half-TTL sweep that `awaiting_user` rows already use.
`awaiting_user` stays **non-renewable** for the same reason it is in
`convo_agents`: a pending ask that can simply be re-asked is a re-request
loop against the user's attention.

## matron-bridge changes

**Target side.** `start` in `lib/journal-rpc.js` gains `prompt` and
`room_id`. After spawn: join the room, then inject the opening turn. If
either fails, tear the session down and answer `failed` — the teardown path
already exists for `unsupported_mode`, and an orphaned agent on another box
with no channel is the worst outcome available.

**Parent side.** A new `lib/agent-spawn.js` in the shape of
`lib/agent-chat.js`: one injected factory returning both handlers,
HTTP-agnostic so they unit-test without a socket, mounted in `index.js` as
thin loopback adapters. The outcome reaches the user as a notice via
`journalPublishNotice`.

## App changes (iOS / macOS / Android)

One new consent-card variant, reusing the card from apple#87 / android#88
with box, workdir and task, answering to `POST /agent-spawn/answer`. The
allowances screen is removed in the separate allowances PR.

## Failure handling

| When | What happens |
|---|---|
| Box offline at request | Tool errors immediately; no card. Never spend the user's tap on something that cannot work. |
| Box offline at approval | `failed`; room opens with the dead-room epitaph; parent told once. |
| Workdir gone between discovery and approval | `failed` via the existing `bad_workdir` answer. |
| Journal restarts mid-wait | Row is durable; the card re-renders from the DB. This is the point of brokering. |
| Two approve taps | State-scoped `UPDATE`; the second is a 409 conflict. |
| Spawn succeeds, room join or prompt injection fails | Session torn down, reported `failed`. |
| Target bridge restarts after spawn | Ordinary session recovery; nothing spawn-specific. |

Every request resolves exactly once, and the parent is told exactly once.

## Testing

- **Journal:** state machine transitions; op authorization in both
  directions (agent-only ops reject clients, the answer endpoint rejects
  agents); broker timeout; expiry sweep; the anti-enumeration 404s. Two
  cases earn named tests: the pending-ask cap counted across *both* tables
  (spawn rows alone, chat rows alone, and a mix that trips the limit only
  when summed), and a second approve on a claimed row answering 409 without
  creating a second room.
- **Bridge:** handler-factory unit tests (the `agent-chat.test.js` pattern),
  plus source-inspection pins in `index.js` for wiring that cannot be
  imported in-process.
- **Apps:** snapshot tests for the new card.
- **End-to-end:** two bridges — Mac spawns on dev-2 — which is how Phase 3
  was actually validated.

## Ship order

1. Allowance removal (separate PR).
2. matron-journal, deployed to dev-2.
3. matron-bridge, deployed to the fleet.
4. Apps.

A bridge whose journal does not know the ops yet just gets an error. An app
without the card would leave a request the user cannot answer, so it goes
last.

## Out of scope

- `agent_session_stop` (the parent ending a session it started). Sessions
  are already reaped on idle and the user can stop any session from the app;
  adding it now would need its own consent question — may an agent stop a
  session it did not start?
- Capability- or label-based targeting ("any box with Xcode"). Boxes are
  named explicitly.
- Cross-user spawning. Everything here is scoped to one user's own devices.
