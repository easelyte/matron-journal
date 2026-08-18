# Durable spawn outcomes — design

**Date:** 2026-08-11
**Status:** approved (Dan, 2026-08-11 — "carry on" on the presented design)
**Repos touched:** matron-journal (this spec); consumed by matron-web, matron-android, matron-apple (client card specs live in those repos)

## Goal

Journal the resolution of every agent-spawn request as a durable event in the
parent conversation, so that:

1. **Clients** can render an `agent_spawn` consent card whose answered/resolved
   state survives restarts and is consistent across devices — no
   local-persistence workaround (the agent-chat cards' UserDefaults /
   SharedPreferences scheme) and no "buttons on a card that was answered on
   another device".
2. **The parent agent** learns the outcome durably. Today the outcome frame is
   fire-and-forget to the parent's live sockets (protocol.md: "Emission is
   exactly-once; delivery is at-most-once") — a parent offline at resolution
   time misses it forever. This spec is the recorded follow-up from PR #61
   promoted to a requirement.

## Background

The spawn state machine (`docs/superpowers/specs/2026-08-09-agent-spawns-session-design.md`,
merged as PR #61) resolves every parked `agent_spawn_requests` row to exactly
one of four outcomes — `started | declined | expired | failed` — and sends one
ephemeral `{kind:'spawn', event:'outcome', ...}` frame to the parent device.
Nothing durable records the resolution: the card (`permission_request`,
`payload.kind:'agent_spawn'`) is an immutable event, `events` is strictly
append-only (FTS external-content invariant, `src/db.js`), and there is no
`GET /agent-spawn/pending`. The only durable trace today is the failure
epitaph text event appended into the *room* on the failure paths.

## Design

### New event type: `spawn_outcome`

When a spawn row reaches a terminal state, the journal appends — best-effort —
an event into the **parent conversation** (`from_convo_id`, the same
conversation carrying the consent card):

- `type: 'spawn_outcome'`, `sender: 'journal'` (journal-authored, like the
  failure epitaph; no `sender_device_id`).
- `payload`:

```json
{
  "request_id": "the spawn row's id (same value the card carries)",
  "outcome": "started | declined | expired | failed",
  "room_id": "new room id (started only)",
  "child_convo_id": "child session id (started only)",
  "error_code": "sanitised failure code (failed only)"
}
```

The payload mirrors the ephemeral outcome frame's fields exactly (minus
`kind`/`event`); `error_code` reuses the already-sanitised value
(`sanitizePeerText(code, 64) || 'unknown'`). Correlation is by
`payload.request_id` — the card payload carries the same id, and the card's
`seq` is not otherwise discoverable.

### Visibility: agent-visible, NOT client-only

`spawn_outcome` is **not** added to `isClientOnlyEvent`. The parent agent owns
`from_convo_id`, so it receives the event in live fan-out and hello replay —
durable outcome delivery to the parent for free, closing the at-most-once
follow-up. The card itself stays client-only (unchanged): the un-approved ask
is withheld from agents; the *resolution* is precisely what the parent is
entitled to know.

### Unforgeable

`spawn_outcome` is deliberately **not** added to `AGENT_PUBLISH_TYPES`, so
`publish`/`finalize` already reject it (`bad_request`) — server-minted only,
same stance as the cards. A test pins this.

### Emission: best-effort append, exactly-once frame, one helper

A single helper in `src/spawns.js`:

```js
// Durable outcome + ephemeral frame, in that order. The append is
// best-effort: from_convo_id may have been deleted since the ask was parked
// (append() throws on a missing/foreign conversation) — a failed append is
// logged and NEVER suppresses the frame. Exactly-once emission remains
// guarded by the callers' state-scoped UPDATEs, exactly as today.
emitSpawnOutcome({ db, hub, userId, fromDeviceId, fromConvoId, requestId, outcome, roomId, childConvoId, errorCode })
```

It appends via `appendAndBroadcast` (try/catch → `console.error`), then sends
the existing `hub.sendToDevice(userId, fromDeviceId, {kind:'spawn',
event:'outcome', ...})` frame unconditionally. The five existing send sites
all route through it:

| Site | Outcome | Where today |
|---|---|---|
| deny answer | `declined` | `src/http.js` `/agent-spawn/answer` deny branch |
| live orchestration failure | `failed` | `src/spawns.js` `fail()` inside `approveSpawn` |
| start success | `started` | `src/spawns.js` after `markStarted` |
| awaiting-user TTL sweep | `expired` | `src/ws.js` sweep over `expireSpawns` |
| stranded-approved sweep | `failed` (`orphaned`) | `src/ws.js` sweep over `expireApproved` |

`expireSpawns` already RETURNINGs `from_convo_id`; **`expireApproved` must add
`from_convo_id` to its RETURNING** — the only store change. No schema change.

Ordering inside the helper: append first, then frame — so a live client that
receives the frame (via any future use) already has, or is about to receive,
the durable event; and a client that sees neither still converges on replay.

### Snippet, push, indexing

- `spawn_outcome` joins `MESSAGE_TYPES`: the card (`permission_request`) is a
  message type that sets the conversation snippet and bumps unread, so its
  resolution must be too — otherwise the chat-list row keeps advertising
  `🤝 Agent spawn request` after the ask is settled, and the snippet branch
  below would be dead code (`append()` only calls `snippetOf` for message
  types). The unread bump is correct for `expired`/orphaned `failed` (the
  user didn't act and should be told) and harmless for answered outcomes
  (the user is looking at the conversation, which clears unread).
- `snippetOf` gains explicit `spawn_outcome` snippets: `started` →
  `🚀 Spawned session started`, `declined` → `🚫 Spawn declined`, `expired` →
  `⌛ Spawn request expired`, `failed` → `❌ Spawn failed`.
- Push: none. Journal-authored events (`appendAndBroadcast`) never enter the
  push pipeline — only agent-published events via the ws append path do — so
  no `classify` change and no notification, which is right: a started child
  generates its own activity, and answered outcomes were just acted on.
- Not indexable: `indexableBody` already ignores unknown types; a test pins
  that `spawn_outcome` is not searchable.

### Client contract (implemented in the three client repos)

Recorded here as the cross-repo contract the client specs build on:

- A card (`permission_request` / `payload.kind:'agent_spawn'`) is **resolved**
  iff a `spawn_outcome` event exists in the same conversation with
  `payload.request_id === card.payload.request_id`. Resolution state and the
  `started` deep-link (`room_id`) come from that event.
- An unresolved card renders Approve/Deny → `POST /agent-spawn/answer`.
  `409 conflict` means "resolved elsewhere or expired": render the expired-style
  state immediately; the durable event follows (or already exists) via sync.
- Old clients render `spawn_outcome` through their generic unknown-type
  fallback; acceptable because spawns cannot occur before the new
  bridge/journal are deployed.
- The inverse also holds: cards minted before this deploys never get an
  outcome event. Clients render them answerable and converge through the
  409 (expired-style copy) — same path as a card whose durable event was
  lost to an append failure.

## Error handling

- Append failure (deleted conversation, DB error): logged, frame still sent,
  row state already terminal — no retry, no crash. Same stance as the room
  epitaph.
- No new error surfaces on `/agent-spawn/answer`; its status contract is
  unchanged.

## Testing

Extend `test/agent-spawn.test.js` (fleet harness) — for each of the five
sites: resolve the row, assert exactly one `spawn_outcome` event lands in the
parent conversation with the right payload, visible to **both** the client and
the parent agent (fan-out + a fresh hello replay). Plus: forged publish of
`spawn_outcome` rejected; append-failure resilience (delete the parent convo
before resolution → outcome frame still sent, no throw, no event); snippet
mapping unit coverage in the journal tests; search non-indexing.

## Out of scope

- `GET /agent-spawn/pending` (the chat-side inbox pattern) — unnecessary once
  outcomes are journaled; the card + outcome pair fully determines state.
- Durable outcomes for **agent-chat** invites/joins — same disease, separate
  campaign; agent-chat cards keep their local-persistence scheme for now.
- Any bridge change — the bridge already receives the ephemeral frame; the
  durable event reaching parent agents is additive and ignorable.
