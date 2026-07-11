# Backlog

Rewritten after the v1-completion branch (2026-07-11) — the previous backlog
(media, APNs push, retention, /metrics, snapshot_required, /password, device
revocation, protocol decisions, hardening pass) shipped in PR #2. Deployment
context for severity calls: internal team tool (~10 users), behind a
Cloudflare tunnel (chat.example.com, no CF Access), bridge agents are
trusted first-party code, iPhones on the public internet.

## Follow-ups from the PR #2 final whole-branch review

- `MATRON_MEDIA_MAX_BYTES` garbage value → NaN → upload size cap silently
  disabled (fails open). One-line validator: non-integer/<=0 → default+warn.
- Push: a user's own `send` still triggers routine alert pushes to their
  other devices — mirror the unread predicate (own messages aren't unread)
  into the push decision, or advance suppression via the sender device's
  cursor. Product wart, not a defect.
- `GET /media/:id`: stat the file before writeHead so a DB-vs-disk size
  mismatch (ops error) yields a clean 5xx instead of 200-then-reset.
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

## Accepted (reviewed, deliberately not fixing)

title:'' upsert fires convo_meta{title:''} (rename-to-empty is defensible);
conversations-row write + meta/status append non-atomic (single-process,
snapshot recovers); buildOpts-throw could strand a coalesce entry
(unreachable today); matron-admin status db-size via db.name vs /metrics
dbPath (same file by construction); offload scan concurrency (see README
follow-up above); raw SqliteError on duplicate admin user; per-call
db.prepare rebuilds; password on admin argv (single-user boxes); 429 body
drain; utf8 cap counting chars not bytes.
