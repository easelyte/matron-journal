// GET /help — a self-describing summary of the HTTP API, aimed at agent
// callers (bridge sessions) that arrive with a token and no repo checkout.
// Deliberately a hand-maintained digest, not generated: /help answers "what
// can I call and how", docs/protocol.md remains the source of truth for
// semantics and edge cases. Keep the two in sync when endpoints change.
export const HELP_TEXT = `# Matron journal HTTP API

Every endpoint below requires \`Authorization: Bearer <token>\` (your device
token — for a bridge, the file named by \`JOURNAL_TOKEN_FILE\`). Conversation
reads answer 404 for "missing or not yours" — never 403. The full spec is
docs/protocol.md in the matron-journal repo ("Journal search" for the index).

## Finding things

- \`GET /search?q=<terms>&limit=<n>&convo_id=<id>\` — full-text search over
  every conversation visible to this device. An ordinary (non-private) agent
  never sees conversations owned by private devices. Terms are
  ANDed literals (raw FTS5 syntax is neutralised); \`q\` max 256 chars;
  \`limit\` defaults 20, clamps at 50; \`convo_id\` narrows to one
  conversation. Hits: \`{convo_id, title, seq, ts, sender, snippet, live}\` —
  \`sender\` is \`user:<name>\` or \`agent:<device>\`, \`snippet\` wraps
  matches in \`**\`, \`live: true\` means that conversation's agent session is
  running now. Only prose is indexed (\`text\` and \`diff\` events); tool
  output never appears in results.
- \`GET /roster\` — \`{agents, conversations}\` metadata for the devices
  and conversations visible to this device. Ordinary agent callers get
  private devices and private-owned conversations omitted; every agent
  caller gets \`snippet\` omitted.

## Reading

- \`GET /convo/:id/messages?limit=&before_seq=\` — transcript pages, newest
  first; \`limit\` 1..200. Agent callers can only page conversations this
  device owns or has joined; others 404.
- \`GET /convo/:id/messages?around_seq=<seq>&limit=\` — a context window
  centred on a seq (pair it with a \`/search\` hit). Works on any
  conversation visible to this device (private-owned ones 404 for an
  ordinary agent): a foreign read returns indexed prose only, clamps
  \`limit\` to 30, and is logged server-side.
- \`GET /snapshot\` — bootstrap state for this device.

## Items (task & decision tracker)

Items are \`task\`/\`question\`/\`decision\` rows scoped to the user, with a
per-user \`#num\`. Every mutating route below also appends an \`item\` marker
event to the item's origin conversation — you cannot \`publish\` one yourself.
For old clients that can't render that marker, the journal also mirrors
card-worthy actions (create/comment/close/reopen) as a flagged, hidden
\`text\` event on the same conversation — never publish one of those either.
\`:id\` is \`it_…\` or \`#num\` (URL-encode the \`#\`). As an agent, you may
comment on, close, reopen, rank, or edit ANY item of this user's you can
see — the tracker is user-scoped, not conversation-scoped. The only routes
still gated on a conversation are creating one (its \`convo_id\` must be a
conversation you manage or have joined) and the transcript patch on a
voice-note comment (gated on the item's origin conversation, since
transcribing is the origin bridge's job); those 404 on refusal.

- \`GET /items?convo=&kind=&state=&awaiting=&label=&sort=rank|updated&since=&limit=&cursor=\`
  — one ranked list per user; \`{items, next_cursor}\`, limit ≤ 500.
- \`GET /items/:id\` — \`{item, comments}\` (comments oldest first).
- \`POST /items\` \`{kind, title, body?, labels?, links?, attachments?,
  awaiting?, convo_id, supersedes?, on_behalf_of?:'user', and at most one of
  position:'top'|'bottom' / after / before}\` → 201 \`{item}\`. Send
  \`on_behalf_of:'user'\` when the USER asked for the item, so it reads as
  theirs. Optional \`Idempotency-Key\` header (replay → 200, no second marker).
- \`PATCH /items/:id\` \`{title?, body?, labels?, links?, awaiting?,
  mission?: id|"#num"|null}\` → 200 \`{item}\`; \`attachments\` is 400
  (create-only in v1), moving \`awaiting\` on a closed item is 409, and a
  \`mission\` that does not exist or that you cannot see is 404 (never 403).
  \`mission: null\` detaches. Every item carries \`mission_id\` and
  \`mission_num\` — both null when it belongs to no mission; they are set by
  this route or inherited when the item's conversation joins a mission.
- \`POST /items/:id/comments\` \`{body?, attachments?}\` (at least one) → 201
  \`{item, comment}\`. A USER comment always flips \`awaiting\` to \`agent\`
  and reopens a closed item; yours as an agent never flips it.
- \`PATCH /items/:id/comments/:cid\` \`{blob_ref, transcript}\` — agent-only
  write-back after transcribing a voice-note attachment. This is the ONLY way
  a transcript is stored; one sent on a create/comment is dropped.
- \`POST /items/:id/close\` \`{resolution:'done'|'answered'|'decided'|'reversed'|'cancelled', comment?}\`
  → 200 \`{item, comment}\`; 409 if already closed. Closing clears \`awaiting\`.
- \`POST /items/:id/reopen\` \`{comment?}\` → 200 \`{item, comment}\`; 409 if
  already open. Restores the kind's default \`awaiting\`.
- \`POST /items/:id/rank\` — \`{position:'top'|'bottom'}\` exclusive, OR
  \`{after}\`/\`{before}\` alone or together (a midpoint) → 200 \`{item}\`;
  409 on a closed item.

## Missions & milestones

A mission is the record of one piece of work; milestones are its
checkpoints. Both share the SAME per-user \`#num\` counter as items, and
\`:id\` is \`ms_…\` or a bare number. There is no auto-create: post a
milestone before \`POST /missions\` and you get 409 \`no_mission\`. A
conversation joins a mission by starting one, by \`join\`, or by being
spawned from a conversation that already has one (only if that mission is
open, visible to you, and under 200 conversations — otherwise the child
starts with none and can \`mission_start\` its own). \`POST /missions\` and
\`POST /milestones\` take an optional \`Idempotency-Key\` (replay → 200, no
second marker); join and close are naturally repeatable (a repeat join of the
same mission is a 200 no-op, a repeat close is 409 \`already_closed\`). The
mutating routes append a \`mission\` or \`milestone\` marker event you cannot
\`publish\` yourself.

- \`POST /missions\` \`{title, body?, convo_id}\` → 201 \`{mission}\`
  with the next \`#num\`; 200 \`{mission, existing: true}\` if that
  conversation already has one (nothing changes), or 404 if that existing
  mission is one you cannot see — same 404 as an unknown conversation, never
  an existence oracle. Attaches the conversation and repoints its unassigned
  items.
- \`GET /missions?state=open|closed&since=<ms>\` → \`{missions}\` with
  per-row \`open_items\`, \`needs_you\`, \`conversations\`,
  \`milestones\`, \`last_milestone\`; most recent activity first.
- \`GET /missions/:id\` → \`{mission, milestones (newest first), items
  (open), conversations}\`.
- \`PATCH /missions/:id\` \`{title?, body?}\` → 200 \`{mission}\`; 409
  once the mission is closed.
- \`POST /missions/:id/join\` \`{convo_id}\` → 200 \`{mission}\`; 409
  \`other_mission\` if that conversation already has a different one, 409
  \`closed\`, 400 at 200 conversations. Re-joining the same mission is a
  no-op 200.
- \`POST /missions/:id/close\` \`{summary}\` → 200 \`{mission}\`. As an
  agent you are blocked by open items: 409 \`user_items\` (clear those
  with the user first), else 409 \`agent_items\`, each with the
  \`{num,title}\` list. Close them or move them to another mission first.
- \`POST /milestones\` \`{convo_id, kind:'user_input'|'progress', title,
  body?}\` → 201 \`{milestone, mission}\`. The marker's own \`seq\` is
  the milestone's anchor — that is the jump target. 409 \`no_mission\` /
  \`closed\`; 502 if the anchor marker could not be written (nothing is
  created).
- \`GET /milestones?convo=<id>\` → \`{milestones}\` newest first for one
  conversation.
- \`PATCH /items/:id\` also accepts \`mission: id|"#num"|null\` — move an
  item to a mission, or detach it. A CLOSED mission is still a legal target:
  closing blocks on open items precisely so you can move them, and a finished
  mission has to stay correctable.

## Media

- \`POST /media\` (raw body, Content-Type captured) →
  \`{media_id, size, content_type, sha256}\`; fetch with \`GET /media/:id\`.
`

/**
 * Serve HELP_TEXT as markdown. Kept beside the text so the route in http.js
 * stays one line.
 */
export function serveHelp(res) {
  res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' })
  res.end(HELP_TEXT)
}
