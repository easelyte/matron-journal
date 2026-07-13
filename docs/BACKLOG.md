# Backlog

Rewritten after the v1-completion branch (2026-07-11) — the previous backlog
(media, APNs push, retention, /metrics, snapshot_required, /password, device
revocation, protocol decisions, hardening pass) shipped in PR #2. Deployment
context for severity calls: internal team tool (~10 users), behind a
Cloudflare tunnel (no CF Access), bridge agents are
trusted first-party code, iPhones on the public internet.

## Follow-ups from the PR #2 final whole-branch review

- `upsertConversation` runs SELECT-then-write outside `db.transaction()` —
  safe only because the server is single-process/synchronous; add the
  one-line invariant comment.
- chaos.test.js convergence loop counts all journal frames type-agnostically;
  filter to `type === 'text'` so future non-message event types can't race
  the target count.
- Dedicated boundary test for `gap === MATRON_MAX_REPLAY` (current behavior:
  `>` — exactly-at-threshold replays normally, matching README "exceeds").
- README: note not to run `matron-admin offload` while the server's interval
  is due (no locking; worst case one orphaned blob file).
- Boot-time offload runs synchronously in the listen callback — fine while
  the journal is young; revisit if the first big offload wave slows boot.
- `stream` has no convo ownership check (unlike `activity`, which calls
  `authorize()`): inert today because `hub.sendEphemeral` is scoped to the
  agent's own user and there is no grants table, but it must land together
  with the future grants/sharing work (see the TODO on the `stream` case in
  ws.js).
- The `viewing` op accepts agent connections too, so an agent can
  self-subscribe to its user's ephemeral frames (stream/activity). Harmless
  today (agents are trusted first-party code seeing only their own user's
  data); tighten alongside grants.

## Deferred by design (revisit with the Matron Swift client)

- Ephemeral stream frames are dropped during a connection's replay window
  (hub registration happens after replay; ephemeral is best-effort). Revisit
  when the client data layer defines `viewing` semantics.
- Bridge-side: message-edit mirroring and ephemeral streaming of live output
  (stream/finalize) — the proper fix for edits, once viewing semantics exist.
- Golden conformance fixtures shared with the Swift client's CI (spec §12) —
  build alongside the Swift data layer.
- Media `dims` for images (bridge passes Matrix's values when present; the
  server never computes them).

## Follow-ups from the tool-output-streaming branch final review

- Ephemeral backpressure valve: drop/skip `tool_stream` ephemerals when a
  conn's `bufferedAmount` is high (client recovers via re-`viewing` sync);
  the viewing sync loop and hub pending slots are otherwise unbounded within
  same-user scope.
- `mergeEphemeral`: flush a pending append before queueing an `end` frame
  (count-cap eviction can drop ≤200 ms of tail output).
- `evictOldest()` guard for `maxBuffers <= 0` (test-opts-only exposure).
- Duplicate-finalize-after-free and retention branch tests (missing blobs
  row; `scheduleRetention` one-pass-fails/both-disabled); `expire-logs`
  default-24 assertion.
- Global (not per-user) buffer-count cap: one user's runaway agent can evict
  another user's live streams (multi-user deployments).
- `resolveToolLogTtlHours`/`resolveRetentionDays` duplication; `handleOp`
  noop default for `toolStreams`.

## Accepted (reviewed, deliberately not fixing)

title:'' upsert fires convo_meta{title:''} (rename-to-empty is defensible);
conversations-row write + meta/status append non-atomic (single-process,
snapshot recovers); buildOpts-throw could strand a coalesce entry
(unreachable today); matron-admin status db-size via db.name vs /metrics
dbPath (same file by construction); offload scan concurrency (see README
follow-up above); raw SqliteError on duplicate admin user; per-call
db.prepare rebuilds; password on admin argv (single-user boxes); utf8 cap
counting chars not bytes; edit events don't update snippet/unread
(MESSAGE_TYPES) — by design, an edit is not new activity.
