# Live Tool-Output Streaming over the Journal Protocol — Design

- **Date:** 2026-07-13
- **Status:** Draft for review
- **Owner:** Dan Barker
- **Replaces:** The code-file viewer's live-output path (`/live` + `/live/ws` on
  the viewer service) as the transport for watching a running Bash command.
  The viewer keeps its other jobs (file views, sensitive-data sharing).

## 1. Background

Today, watching a running Bash command works like this: a PreToolUse hook tees
the command's output to `/tmp/matron-cmd-<tool_use_id>.log` on the bridge box;
the bridge publishes a durable `tool_output` journal event carrying
`{tool_use_id, command, viewer_url, expires_at}`; the client opens the signed
`viewer_url`, and the viewer service tails the log file over its **own**
WebSocket, streaming chunks to the browser.

Problems with that path:

1. **Bearer links.** `viewer_url` is an HMAC-signed capability — anyone
   holding the URL can watch (and later fetch) the output through the public
   tunnel for 24 h, with no login and no revocation.
2. **A second transport.** The client already holds an authenticated journal
   WebSocket with viewing state, coalescing, and reconnect semantics; live
   output rides a parallel, unauthenticated one with none of that.
3. **Expiring durable records.** The journal event's `viewer_url` dies after
   its TTL, so history shows dead links.
4. **Extra moving parts.** The feature requires `HMAC_SECRET`,
   `VIEWER_BASE_URL`, a public tunnel hostname, and the viewer service to all
   be up.

The original protocol design (§2 of
[2026-07-10-matron-protocol-design.md](2026-07-10-matron-protocol-design.md))
lists "streaming tool output … live-output deltas are never persisted; the
server coalesces before fan-out" as a first-class goal. This spec fills in
that slot: live output becomes journal-native.

## 2. Goals

- A client viewing a conversation sees a running command's output live, with
  **full scrollback** — including when it opens the conversation mid-command
  or reconnects — up to a bounded buffer size.
- Live chunks are ephemeral: never written to the journal, never pushed, gone
  from server memory when the command ends.
- The durable record stops carrying an expiring URL: it carries the command,
  exit status, a snippet, and a `blob_ref` to the full log in media storage.
- Retention parity with today: full logs are deleted after a TTL
  (default 24 h); only the snippet survives indefinitely.
- Self-healing delivery: bridge reconnects, journal-server restarts, and
  at-least-once retries all converge without acks or client-visible gaps.
- The wire contract is precise enough for matron-apple and matron-web to
  implement without reading server source.

## 3. Non-goals

- Client (matron-apple / matron-web) implementation — this spec defines their
  wire contract only (decision Q4-A).
- Streaming output of tools other than Bash. The protocol is
  tool-agnostic (`meta.tool`), but the bridge only wires Bash in v1.
- Keeping the viewer-URL path alive in parallel (decision Q1-A). The viewer's
  file-view and sensitive-data flows are untouched.
- Durable chunk-level replay. Scrollback beyond the live buffer comes from
  the completion blob, not the journal.

## 4. Decisions (from design review)

| # | Question | Decision |
|---|----------|----------|
| Q1 | Fate of the viewer's live-output role | **Replace fully.** Durable event drops `viewer_url`; carries snippet + `blob_ref`. |
| Q2 | Live semantics | **Full scrollback** (append protocol + server-side buffer), not a rolling tail. |
| Q3 | Durable retention | **Blob with TTL deletion** (default 24 h), snippet kept forever. |
| Q4 | Spec scope | **matron-journal + bridge**, wire contract documented for clients. |

## 5. Wire contract

### 5.1 Agent → server: `stream_append`

```json
{"op": "stream_append", "convo_id": "...", "message_ref": "<tool_use_id>",
 "offset": 0, "chunk": "…output bytes (utf-8)…",
 "meta": {"tool": "Bash", "command": "npm test"}}
```

- `message_ref` is the Claude `tool_use_id` — stable, globally unique, and
  the same ref the durable completion event will carry.
- `offset` is the absolute byte position of `chunk`'s first byte in the
  command's logical output stream (= the tee log file offset).
- `meta` is required on the frame that **creates** the buffer (normally
  offset 0) and ignored afterwards. `meta.tool` and `meta.command` are
  strings; `command` is truncated server-side at 2 000 chars.
- Auth: agent connections only, and the convo must be owned by the sending
  agent (same `authorize()` check as `activity`); otherwise
  `{op:'error', code:'forbidden'}`.
- Validation: non-string `chunk`, non-integer/negative `offset`, or a
  missing/non-object `meta` on a buffer-creating frame →
  `{op:'error', code:'bad_request'}`.

**Offset reconciliation** (buffer holds bytes `[start, end)`):

| Condition | Server behaviour |
|-----------|------------------|
| `offset == end` | Append. |
| `offset < end` | Trim the overlapping prefix, append the remainder (idempotent retry). A chunk entirely `< end` is dropped silently. |
| `offset > end`, buffer exists | Drop the chunk; reply `{kind:'control', op:'stream_resync', convo_id, message_ref, have: end}`. |
| No buffer and `offset > 0` | Drop; reply `stream_resync` with `have: 0`. |

The bridge answers a `stream_resync` by re-reading its log file from byte
`have` and re-sending. This one rule self-heals bridge reconnects (frames
dropped while the socket was down), server restarts (buffers are memory-only),
and at-least-once retries — no acks, no sequence numbers.

### 5.2 Server → client ephemerals

Delivered only to the owning user's **client** connections whose
`viewing` conversation matches — the same scoping as `stream`/`activity`.
Tool-stream ephemerals are distinguished from assistant-text overlays by the
`tool_stream` key (text overlays carry `text`/`replace_text`).

**Sync** — sent when a client starts `viewing` a convo that has one or more
active buffers (one frame per buffer), giving full scrollback so far:

```json
{"kind": "ephemeral", "convo_id": "...", "message_ref": "...",
 "tool_stream": {"event": "sync", "meta": {"tool": "Bash", "command": "npm test"},
                  "offset": 0, "content": "…everything so far…",
                  "head_truncated": false}}
```

`offset` is the byte position of `content`'s first byte (> 0 with
`head_truncated: true` once the per-buffer cap has dropped the head).

**Append** — live chunks:

```json
{"kind": "ephemeral", "convo_id": "...", "message_ref": "...",
 "tool_stream": {"event": "append", "offset": 1024, "chunk": "…"}}
```

Appends are ordered within a socket. In the hub's 200 ms flush window,
consecutive appends for the same `(convo_id, message_ref)` are **concatenated**
into one frame — never latest-wins (that rule stays exclusive to text-overlay
`stream` frames).

**End without completion** — the idle sweep (§6) freed a stale buffer:

```json
{"tool_stream": {"event": "end", "reason": "stale"}}
```

**Normal end** — no ephemeral: the durable `tool_output` journal frame
arrives with the same `message_ref` in its **payload**, exactly how
assistant-text overlays retire today. The client replaces the live view with
the durable rendering. A client that detects an offset gap while viewing
(shouldn't happen on an ordered socket) recovers by re-sending `viewing`,
which re-delivers sync frames. Journal frames bypass the hub's coalescing
window but ephemerals don't, so a pending `append` can flush up to 200 ms
after the completion frame for the same `message_ref`; clients must ignore
`tool_stream` ephemerals for a `message_ref` already retired by a durable
event rather than re-opening a retired overlay.

### 5.3 Durable completion event

Published by the bridge via the existing `finalize` op
(`idem_key` = `fin:<tool_use_id>` composed server-side), type `tool_output`:

```json
{"message_ref": "<tool_use_id>", "command": "npm test", "exit_code": 1,
 "denied": false, "truncated": false,
 "snippet": "…last ≤50 lines / ≤4 KB…", "blob_ref": "<media id>",
 "live_log": true}
```

- `blob_ref` points at the full log uploaded through `POST /media`
  (subject to the existing 50 MB cap; the bridge caps its upload well below).
  `finalize` gains the same optional top-level `blob_ref` passthrough
  `publish` already has, so the event row's `blob_ref` **column** is set —
  that column is what the retention scans key on. The payload's `blob_ref`
  is the client-visible copy (journal frames strip internal columns,
  including the column-level `blob_ref`).
- `live_log: true` marks the blob for TTL deletion (§7) and distinguishes
  these blobs from 30-day retention-offload blobs.
- `denied: true` (command never ran) and bridge-side abort paths (session
  killed mid-command) still finalize — possibly with `exit_code: null` and
  whatever output exists — so buffers are freed deterministically.
- `viewer_url` and `expires_at` are gone from new events. Clients keep
  rendering old events' `viewer_url` as "expired" (they all are).

## 6. Server implementation (matron-journal)

New module `src/tool-stream.js` — `makeToolStreamStore(opts)`:

```
open/append(convoId, ref, offset, chunk, meta) -> {appended | resync:{have}}
buffersFor(convoId) -> [{ref, meta, start, end, content()}]
free(convoId, ref)
sweepIdle(now) -> freed[]
```

State per buffer: `{meta, start, end, chunks[], lastAppendAt}`. Bounds, all
env-tunable:

| Bound | Default | Env | Behaviour at limit |
|-------|---------|-----|--------------------|
| Per-buffer bytes | 1 MiB | `MATRON_TOOL_STREAM_MAX_BYTES` | Drop head; `start` advances; syncs set `head_truncated`. |
| Buffer count | 64 | `MATRON_TOOL_STREAM_MAX_BUFFERS` | Evict oldest-idle; viewers get `end {reason:'stale'}`. |
| Idle age | 30 min | `MATRON_TOOL_STREAM_IDLE_MS` | Sweep frees buffer; viewers get `end {reason:'stale'}`. |

Wiring:

- `ws.js` gains the `stream_append` case (validation + authorize + store +
  fan-out) and, in the `viewing` handler, synchronous sync-frame delivery for
  the target convo's active buffers (same event-loop turn, so no append can
  interleave before the sync).
- The `finalize` handler (the only durable op that carries `message_ref`)
  frees the buffer matching `(convo_id, message_ref)` after appending —
  normal end-of-stream.
- `hub.js`: `sendEphemeral` currently coalesces latest-wins per
  `(convo_id, message_ref)`. Tool-stream appends instead **merge by
  concatenation** within the flush window; sync/end frames replace pending
  appends for their key. Text-overlay and activity behaviour is unchanged.
- The idle sweep piggybacks on the existing 60 s revocation sweep timer.

Nothing survives a restart — `stream_resync` (§5.1) recovers the stream from
the bridge's log file.

## 7. Durable record retention (blob TTL)

The retention job (`src/retention.js`, runs at boot + every 6 h) gains a
second pass: for `tool_output` events with `payload.live_log` and a
`payload.blob_ref` older than `MATRON_TOOL_LOG_TTL_HOURS` (default 24;
0/invalid disables, mirroring `MATRON_RETENTION_DAYS` semantics):

1. Unlink the media file and delete its `blobs` table row.
2. Rewrite the payload to `{..., blob_ref: null, blob_expired: true}` and
   NULL the row's `blob_ref` column — the same payload-rewrite precedent as
   the 30-day offload, and no dangling column reference to a deleted blob.

Interplay with the 30-day offload (its scan is `type='tool_output' AND
blob_ref IS NULL`): while the log blob exists, the column is set, so offload
skips these events. After the TTL pass NULLs the column, the event would
enter offload's scan at 30 d and get pointlessly re-blobbed — so offload
gains one guard alongside `looksAlreadyOffloaded`: skip payloads with
`blob_expired`. `matron-admin offload` gets a sibling:
`matron-admin expire-logs [--hours N]`.

Client UX for an expired blob: `GET /media/<ref>` 404s (or `blob_expired`
is already set) → "output expired", identical to today's dead viewer link.

## 8. Security

- **Transport:** live chunks ride the authenticated journal WS only; delivery
  is owner-scoped and viewing-scoped — any same-user connection whose
  `viewing` conversation matches receives appends, agent connections
  included, consistent with the legacy `stream`/`activity` ephemerals. Only
  the viewing-time `sync` frames are additionally gated to `client`
  connections. Device revocation (next-frame or ≤60 s) applies as everywhere
  else.
- **At rest:** chunks live only in the in-memory buffer (≤ caps) while the
  command runs; full logs are Bearer-auth'd owner-only media, deleted after
  24 h; snippets persist like any journal payload.
- **Removed surface:** no more HMAC bearer links for command output through
  the public tunnel; `HMAC_SECRET`/`VIEWER_BASE_URL` are no longer needed for
  this feature.
- **Resource bounds:** the three buffer caps bound what a compromised or
  runaway agent can pin in server memory; `stream_append` frames also pass
  the existing per-connection frame-size limits.
- **Forgery:** `finalize`'s type whitelist and reserved `fin:` idem prefix
  already prevent a raw `publish` from forging completion; `stream_append`
  fails closed (`forbidden`) on non-owned convos.

## 9. Bridge implementation (claude-matrix-bridge)

All behind the existing `showBashOutput` toggle.

- **New `lib/tool-stream-pump.js`** — per running command: `fs.watch` +
  offset reads on the tee log (the viewer's proven pump logic, lifted into a
  testable module), throttled to ≥250 ms between frames, feeding
  `journalPublisher.streamAppend(convoId, ref, offset, chunk, meta)`.
  Handles resync requests by re-reading from the requested offset.
- **`lib/journal-publisher.js`** — new `streamAppend(...)` (ephemeral
  contract like `stream`: never queued, fails open) and dispatch of inbound
  `{kind:'control', op:'stream_resync'}` frames to a registered pump
  callback.
- **`index.js` seams** (thin, mirroring current live-output wiring):
  - `tool_use` (Bash + `showBashOutput`): start a pump for
    `/tmp/matron-cmd-<tool_use_id>.log`. The Matrix custom event is still
    posted for room UX, but without `viewer_url`/`expires_at`.
  - `tool_result` (the existing `markComplete` seam): stop the pump, read the
    log, cap + `uploadMedia`, `finalize` the `tool_output` payload (§5.3).
  - Session teardown (`killSession`/`recreateSession`): stop pumps and
    finalize open streams with `exit_code: null`, so server buffers are freed
    (the idle sweep is the backstop, not the mechanism).
- **Removed:** live-output viewer-URL generation (`generateSignedUrl` with
  `liveCmdId`). `liveOutputStore`, the done-sentinel, and log GC stay — the
  pump rides the same lifecycle.

## 10. Rollout & consequences

1. Ship matron-journal (protocol + retention) — additive, no migration.
2. Ship the bridge — new events stop carrying `viewer_url`.
3. **matron-web's live tile goes dark for new commands** until it implements
   §5.2 — the Matrix event keeps its plain-text `🔧 command` fallback, so it
   degrades to what non-tile clients see, nothing breaks. Accepted under
   Q1-A; matron-apple is the first-class consumer.
4. matron-apple / matron-web implement the client contract (separate
   efforts).

Order matters only in that the bridge must not ship before the server
(`stream_append` would error `bad_request`… which the fail-open publisher
tolerates, so even that is safe, just useless).

## 11. Testing

- **matron-journal:** unit tests for `makeToolStreamStore` (offset
  reconciliation table, head-drop, eviction, idle sweep); ws-level tests for
  authorize/validation, viewing-sync timing, finalize-frees-buffer; hub tests
  for append concatenation vs latest-wins isolation; retention tests for the
  TTL pass (incl. non-collision with offload); **conformance fixtures** for
  every frame in §5 — the golden files are the contract clients build
  against.
- **bridge:** unit tests for the pump (tail, throttle, resync re-read) and
  `streamAppend` against the fake-journal-server harness (drop frames →
  assert resync recovery); the `index.js` seams stay as thin as today's
  live-output wiring and are exercised by the existing regression suite.
