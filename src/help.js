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
  caller gets \`snippet\` omitted. A conversation the user pinned to their
  sidebar carries \`pin: {label, emoji}\` — the user's own name for it
  ("Help desk").

## Reading

- \`GET /convo/:id/messages?limit=&before_seq=\` — transcript pages, newest
  first; \`limit\` 1..200. Agent callers can only page conversations this
  device owns or has joined; others 404.
- \`GET /convo/:id/messages?around_seq=<seq>&limit=\` — a context window
  centred on a seq (pair it with a \`/search\` hit). Works on any
  conversation visible to this device (private-owned ones 404 for an
  ordinary agent): a foreign read returns indexed prose only, clamps
  \`limit\` to 30, and is logged server-side.
- \`GET /snapshot\` — bootstrap state for this device. Conversation rows
  carry \`mission_id\` (current) and \`mission_count\` (every mission ever
  linked).
- \`GET /items?scope=shared\` and \`GET /missions?scope=shared\` — a
  colleague's items and missions you may read: filed from a conversation
  whose repo belongs to a GitHub org both of you are verified members of
  (see "Shared visibility" in docs/protocol.md). Rows carry \`owner\`;
  item rows also carry \`repo\`. \`GET /items/:id\` / \`GET /missions/:id\`
  read one such row; every write to it is 403. \`GET /milestones?convo=<id>\`
  works on a shared conversation.
- \`GET /lookup?user=<name>&num=<n>\` — resolves a shareable link
  (\`https://<journal>/u/<name>/<n>\`) to \`{kind, id, num, title, owner}\` (a milestone also names its
  \`mission\`); 404 when
  unknown or not visible to you.
- \`GET /said/<convo>:<seq>\` — did your user really write this? For an
  agent checking a \`<convo>:<seq>\` citation another agent gave it, on any box's
  conversation of this account (private-owned ones 404 for an ordinary
  agent). \`{verified: true, seq, ts, author, kind: 'typed'|'voice'|'tap', text,
  caption?, choice?, cited_seq?, before}\` when it is a message the user sent from an
  app, a voice note with the words the journal itself transcribed, or the
  user's answer on a question card (\`tap\`: \`before\` is the card);
  citing a bridge's \`[Voice note transcription]\` copy answers with the
  user's own note (\`seq\`) and the journal's words (\`cited_seq\` = what
  you cited). \`before\` is the message just before it, with its sender —
  context, not the user's words. Anything else is
  \`{verified: false, sender, reason}\`. Logged.
- \`GET /me\` — \`{user:{id, name, is_admin}, github, github_linking}\`: who
  you are, whether your user is a journal admin, and your GitHub link
  state. The users admin routes themselves are for the web app's client
  session, never for an agent.
- \`GET /convo/:id/messages?around_seq=<seq>&limit=<n>\` on a colleague's
  shared conversation returns the prose window around \`seq\` (\`text\`
  and \`diff\` only, \`limit\` clamped to 30, logged).

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
  \`kind\` takes one kind or several, comma-separated.
- \`GET /items/:id\` — \`{item, comments}\` (comments oldest first).
- \`POST /items\` \`{kind, title, body?, labels?, links?, attachments?,
  actions?, awaiting?, convo_id, supersedes?, on_behalf_of?:'user', and at most one of
  position:'top'|'bottom' / after / before}\` → 201 \`{item}\`. Send
  \`on_behalf_of:'user'\` when the USER asked for the item, so it reads as
  theirs. Optional \`Idempotency-Key\` header (replay → 200, no second marker).
- \`PATCH /items/:id\` \`{title?, body?, labels?, links?, awaiting?, actions?,
  mission?: id|"#num"|null}\` → 200 \`{item}\`; \`attachments\` is 400
  (create-only in v1), moving \`awaiting\` on a closed item is 409, and a
  \`mission\` that does not exist or that you cannot see is 404 (never 403).
  \`mission: null\` detaches. Every item carries \`mission_id\` and
  \`mission_num\` — both null when it belongs to no mission; they are set by
  this route or inherited when the item's conversation joins a mission.
- \`POST /items/:id/comments\` \`{body?, attachments?, actions?}\` (body or
  attachments required) → 201 \`{item, comment}\`. A USER comment always
  flips \`awaiting\` to \`agent\` and reopens a closed item; yours as an
  agent never flips it — unless it carries \`actions\`.
- Images inline: put \`![caption](attachment:<media_id>)\` in an item or
  comment body, right after the paragraph it illustrates, with that blob in
  the SAME write's \`attachments\` (upload with \`POST /media\` first). A ref
  to anything else is 400 \`invalid_attachment_ref\`. Attachments no ref
  places still show at the end.
- \`actions\` on a comment: the same up-to-4 one-tap answers, shown under
  THAT comment — the way to ask a follow-up question on an item that already
  exists instead of filing a new one. Same rules as below (400
  \`invalid_actions\`); a non-empty list sets \`awaiting\` to \`user\`, and is
  409 on a closed item (reopen it first). Every comment carries \`actions\`
  and \`chosen_action\` (the latest tap on it). The tap reaches you as a user
  comment with \`comment.action\` = the label and \`comment.reply_to\` = your
  comment's id; the item's own \`chosen_action\` is not touched.
- \`actions\` (create/PATCH): up to 4 one-tap answer buttons the user sees on
  the item, e.g. \`["Go"]\` or \`["Option A","Option B"]\` — each 1–40 chars,
  one line, unique ignoring case (else 400 \`invalid_actions\`); \`[]\` clears.
  A tap is a user comment whose body is the label, with \`comment.action\` set
  to it and the item's \`chosen_action\` = the latest tap (changing
  \`actions\` clears it). Only the user taps: \`action\` on your comment is 403.
- \`PATCH /items/:id/comments/:cid\` \`{blob_ref, transcript}\` — agent-only
  write-back after transcribing a voice-note attachment; one sent on a
  create/comment is dropped. When the journal transcribes itself, a user's
  audio attachment arrives \`transcript_status:'pending'\`: hold the turn —
  a quiet \`updated\` marker with \`transcription:'done'|'failed'\` and the
  comment (transcripts filled in) follows when it settles.
- \`kind: 'notice'\` — something the user needs to read but not decide (a
  blocker, a key result, a warning). It awaits the user with one built-in
  action, \`Seen\`; send no \`actions\` (any other list is 400
  \`invalid_actions\`). The user's Seen tap closes it as \`done\` with
  \`chosen_action: 'Seen'\` and a quiet \`closed\` marker carrying
  \`seen: true\` — no wake, not a turn. A typed reply on a notice is an
  ordinary user comment. Apps see the kind only when they send
  \`X-Matron-Item-Kinds: notice\`; older ones get it as a \`task\`.
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
conversation can be on several missions at once: one is **current** (where
milestones and new items go by default), the others are "also on", and ones
it left are history. It joins a mission by starting one, by \`join\`, or by
being spawned from a conversation that has one (a sub-chat inherits its
parent's current mission whenever that mission is open and visible to you —
sub-chats never count toward the 200-conversation cap). \`POST /missions\` and
\`POST /milestones\` take an optional \`Idempotency-Key\` (replay → 200, no
second marker); join and close are naturally repeatable (a repeat join of the
same mission is a 200 no-op, a repeat close is 409 \`already_closed\`). The
mutating routes append a \`mission\` or \`milestone\` marker event you cannot
\`publish\` yourself.

- \`POST /missions\` \`{title, name?, body?, convo_id, attach?}\` → 201 \`{mission}\`
  with the next \`#num\`; 200 \`{mission, existing: true}\` if that
  conversation already has one (nothing changes), or 404 if that existing
  mission is one you cannot see — same 404 as an unknown conversation, never
  an existence oracle. Attaches the conversation and repoints its unassigned
  items. With \`attach: false\` it creates a NEW, unassigned mission whose
  origin is that conversation but touches neither the conversation nor its
  items (no \`existing\` short-circuit). \`POST /missions/create\` is the
  same route. \`name\` is an optional short label (at most 40 chars; longer
  is 400 \`name_too_long\`): while a session is on a mission its title
  reads \`[xx] <name>\` (else the mission title, cut to 40), and the title
  your bridge sent stays on the row as \`auto_title\`.
- \`GET /settings\` → \`{notices}\` — whether the user wants things to read filed as \`notice\` items (default true; \`hello_ok\` carries it as \`settings\`, and a change arrives as \`{kind:'control', op:'settings', settings}\`). \`PATCH /settings {notices}\` is the user's alone.
- \`GET /coordinator\` → \`{convo_id, consent}\` — the user's Coordinator, and whether it may approve chats and spawns
- \`GET /consent/pending?convo_id=<coordinator convo>\` → \`{pending:[…]}\` — parked chat invites, join requests and spawn requests (Coordinator only)
- \`POST /consent/answer\` \`{convo_id, kind: chat|spawn, id, decision: approve|decline, reason}\` — answer one on the user's behalf (Coordinator only; see /help's protocol for the guardrails). Approving the Coordinator's OWN ask needs its \`causes\` to resolve to the user's words or item reply/tap (else 403 own_ask_unverified), or to a routine fire inside the routine's envelope (403 envelope), passed by the verifier (403 verifier / 409 verifier_unavailable) and under the routine cap (409 routine_cap)
  conversation, or null. Only the user sets it; you hear a change as a
  \`coordinator\` event \`{role: 'assigned'|'released'}\` in the conversation.
- \`GET /defaults\` → \`{default_model, default_effort}\` — the user's default
  model and effort for new chats (null = the box's own default).
  \`PUT /defaults\` \`{default_model?, default_effort?}\` → the full new state;
  an absent key is left as is, null or "" clears (and "default" for the
  model). Effort is low|medium|high|xhigh|max (else 400 \`bad_effort\`); a
  model is an alias or full name like \`opus[1m]\` or \`claude-opus-5-5\`
  (else 400 \`bad_model\`). A change reaches every socket of the user as
  \`{kind: 'defaults', default_model, default_effort}\`.
- \`GET /devices/<id>/defaults\` → \`{device_id, default_agent, default_model,
  default_effort}\` — what a new session on that box of the user's starts
  with when nobody names it (null = the box's own env).
  \`PUT /devices/<id>/defaults\` \`{default_agent?, default_model?,
  default_effort?}\` → the full new state; any box of the user's, not only
  yours. Agent is claude|codex (else 400 \`bad_agent\`); model and effort
  as for /defaults. null, "" or "default" clears; a new agent without a
  model clears the model. The box hears \`{kind: 'box_defaults', ...}\`.
- \`GET /memories\` → \`{memories}\` — the user's shared agent memory:
  standing rules and facts, one row per kebab-case \`name\`, ordered by
  name. Each carries a \`scope\`: \`global\` (every session), \`coordinator\`
  (the Coordinator only) or \`repo:<name>\` (sessions working in that
  repo). A bridge with the scopes update gives a session only the memories
  whose scope matches it; an older bridge still gives every memory to
  every session, so a stored scope restricts nothing until the bridge is
  updated. \`GET /memories/:name\` (or the \`me_…\` id) → \`{memory}\`.
- \`PUT /memories/:name\` \`{description (≤200 chars, one line), body?
  (markdown ≤8 KB), type?: user|feedback|project|reference, scope?:
  global|coordinator|repo:<name> (global on create, kept on update when
  omitted), convo_id? (agents: your conversation)}\` → 201 created / 200
  updated \`{memory}\`. The same name overwrites — the whole memory, so send
  the body back when updating. 409 \`too_many\` at 200 memories. \`DELETE /memories/:name\` →
  200 \`{memory}\`. Every change lands as a quiet \`memory\` event on your
  conversation and on the Coordinator's.
- \`GET /routines\` → \`{routines}\` — the user's Coordinator routines: a
  prompt the journal fires into the Coordinator conversation on a
  \`schedule\` (5-field cron in \`tz\`) or when a \`trigger\` trips
  (\`{kind: context_over|disk_under, pct}\`, \`{kind: stalled,
  reset_minutes}\` or \`{kind: allowance_expiring, pct, from_hours?,
  to_hours?}\` or \`{kind: allowance_expiring, tiers: [{unused_pct,
  hours_left}]}\`), by \`name\`. \`GET /routines/:name\` (or the \`rt_…\` id)
  → \`{routine}\` with \`enabled\`, \`next_at\`, \`last_fired_at\`,
  \`last_outcome\`.
- \`POST /routines\` \`{name, title, schedule | trigger, prompt (≤2000),
  tz? (default Europe/London), enabled?, envelope?, convo_id}\` → 201 \`{routine}\`;
  \`PATCH /routines/:name\` \`{title?, schedule?, trigger?, tz?, prompt?,
  enabled?, envelope? (null clears), convo_id}\` → 200 (a routine stays
  scheduled or triggered). \`envelope\` \`{spawns_per_fire (0-50), chats,
  boxes: [names] | null}\` bounds what an ask born of a fire may do.
  Agents: the Coordinator only, naming its own conversation as
  \`convo_id\` (403 \`not_coordinator\` otherwise). Fires at least 15
  minutes apart; 409 \`blocked_by: name|cap\`. \`DELETE /routines/:name\`
  \`{convo_id}\` takes the same Coordinator gate and needs no \`causes\`.
- \`POST /routines/:name/run\` \`{convo_id}\` → 202 — fire it now, whatever
  \`enabled\` says; the schedule is untouched. Every change and fire lands as
  a quiet \`routine\` event in the Coordinator conversation.
- Creating, rewriting (\`prompt\`, \`schedule\`, \`trigger\`, \`envelope\`) and
  running a routine needs the user's ask: your bridge sends the turn's
  \`causes\`, and they must be the user's words in your conversation or the
  user's comment on one of your items — a routine fire is not enough. 403
  \`routine_write_unverified\` (with \`why\`) otherwise; ask the user, or
  leave it for them. Pausing, retitling and \`tz\` need no ask.
- \`POST /briefings\` \`{convo_id, body (markdown, ≤32 KB)}\` → 201
  \`{briefing}\` — publish a briefing (Coordinator only, naming its own
  conversation). The journal writes it into that conversation as your
  message, so do not repeat it in prose; the apps show the latest at the top
  of Projects. Honours \`Idempotency-Key\`.
- \`GET /unseen?convo_id=<coordinator convo>\` → \`{entries, truncated}\` —
  what the user hasn't seen (Coordinator only). Params: \`older_than_ms\`
  (default 30 min), \`since_ms\` (default 3 d), \`importance\`
  (important|all), \`in_convo_id\`, \`mission\`, \`include_flagged=1\`,
  \`limit\`. With \`mine=1\` and your own conversation as \`convo_id\`: only
  YOUR messages there that the user hasn't seen (any agent).
- \`POST /unseen/flags\` \`{convo_id, refs}\` — record that you raised these
  entries with the user, so they are not listed again (an agent: only its
  own messages).
- \`GET /missions?state=open|closed&since=<ms>\` → \`{missions}\` with
  per-row \`open_items\`, \`needs_you\`, \`conversations\`,
  \`milestones\`, \`last_milestone\`; most recent activity first. Rows also
  carry \`activity\` (running|waiting|idle|quiet, or closed),
  \`last_activity_at\`, \`project_id\` and \`project_num\`; \`conversations\`
  counts active top-level conversations.
- \`GET /missions/:id\` → \`{mission, milestones (newest first), items
  (open), conversations}\`. Each conversation row has \`current\`, \`how\`,
  \`joined_at\`, \`ended_at\` (null = on it now), \`parent_convo_id\` (null
  when you can't see the parent — a private-owned one, or, on a colleague's
  shared view, one they can't read — so null there can mean "hidden", not
  just "no parent") and \`subchat_count\`, plus \`other_missions\` (up to 5
  of that conversation's other missions: \`{id, num, title, current, active,
  joined_at, ended_at}\`); sub-chats are folded into their parent's row —
  add \`?subchats=1\` to list them too, and \`?history=1\` to also list ended
  links (each carrying its \`ended_at\`); the two combine. This array can be
  longer than the mission's \`conversations\` count (active top-level links
  only): an unfolded sub-chat whose parent isn't linked, or a row added by
  \`?subchats=1\`/\`?history=1\`, grows the array without growing the count —
  never assume \`conversations === conversations.length\` here.
- \`PATCH /missions/:id\` \`{title?, name?: string|null, body?, status?: string|null, project?,
  convo_id?}\` → 200 \`{mission}\`; 409 once the mission is closed.
  \`status\` is the mission's one-paragraph headline (markdown, 1–600
  chars after trimming, no control characters but newline and tab): a
  string replaces it, \`null\` clears it. Pass your own conversation as
  \`convo_id\` so the status is attributed to it. Every mission row carries
  \`status\`, \`status_by\` (user|agent), \`status_convo_id\` and
  \`status_updated_at\` — null when unset, or when it was written from a
  private conversation you cannot see, or by a private device. The
  \`updated\` mission marker carries \`status_changed: true\` when the PATCH
  wrote the status. \`project: id|"#n"|n|null\` files the mission in a
  project (null takes it out); it works on a closed mission too. The
  \`updated\` marker carries \`project_changed: true\` when it moved. \`POST
  /missions\` also takes \`project\`. 404 for a project you cannot see, 409
  \`project_closed\`.
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
- \`POST /missions/:id/close\` \`{summary}\` → 200 \`{mission}\`. As an
  agent you are blocked by open items: 409 \`user_items\` (clear those
  with the user first), else 409 \`agent_items\`, each with the
  \`{num,title}\` list. Close them or move them to another mission first.
- \`POST /milestones\` \`{convo_id, kind:'user_input'|'progress', title,
  body?, mission?}\` → 201 \`{milestone, mission}\`. The marker's own \`seq\`
  is the milestone's anchor — that is the jump target. \`mission\` (id,
  "#n" or n) names any mission this conversation is actively on — default
  is the current one; 409 \`not_linked\` otherwise. 409 \`no_mission\` /
  \`closed\`; 502 if the anchor marker could not be written (nothing is
  created).
- \`GET /milestones?convo=<id>\` → \`{milestones}\` newest first for one
  conversation.
- \`PATCH /items/:id\` also accepts \`mission: id|"#num"|null\` — move an
  item to a mission, or detach it. A CLOSED mission is still a legal target:
  closing blocks on open items precisely so you can move them, and a finished
  mission has to stay correctable.

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
- \`POST /projects/:id/close\` \`{summary, convo_id?}\` — \`convo_id\` is
  required when you call as an agent (name your own conversation so you
  prove you're the Coordinator; else 403 \`not_coordinator\`); a client
  never needs it. Open missions block a Coordinator close with 409
  \`open_missions\`.
- \`POST /projects/:id/merge\` \`{into, convo_id?}\` — same \`convo_id\` rule
  as close. Coordinator or user only; moves every mission into \`into\` and
  closes this one ("Merged into #N").
- Activity: \`running\` (a linked session is running), \`waiting\` (one is
  waiting, or items await the user), \`quiet\` (no milestone, status update
  or conversation activity for 7 days), else \`idle\`.

## Media

- \`POST /media\` (raw body, Content-Type captured) →
  \`{media_id, size, content_type, sha256}\`; fetch with \`GET /media/:id\`.
- \`GET /media/:id/transcript?wait=N\` → \`{status, transcript?, segments?}\`
  — a voice note's words (or a video's, with \`segments\`
  \`[{start_ms, text}]\`) when the journal transcribed it at upload
  (\`status\` none|pending|done|failed; \`wait\` ≤ 30 s holds a pending
  answer).
- \`POST /media/:id/transcript?wait=N\` — your user's own note: asks the
  journal to try a none/failed one again (→ pending) when it has a cloud
  transcriber, otherwise the row as it stands; done/pending answer as they
  stand, nothing re-runs; \`{status:'none', reason:'busy'}\` = backlog
  full, try later; 400 \`not_transcribable\` for non audio/video.
`

/**
 * Serve HELP_TEXT as markdown. Kept beside the text so the route in http.js
 * stays one line.
 */
export function serveHelp(res) {
  res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' })
  res.end(HELP_TEXT)
}
