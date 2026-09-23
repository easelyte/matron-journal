# Consent asks in the Decisions list — design

**Date:** 2026-09-22 · **Requested by:** Dan (2026-09-22, from the bev
session: "I can never find the approval cards"; option A chosen on item
#135 on 2026-09-10, detailed in item #162; agent-chat asks confirmed on
item #2317, 2026-09-22) · **Repos touched:**
matron-journal (this spec). Apps embed the card in item detail as a
follow-up (item #162, per platform).

## Problem

A consent ask — an agent wanting to spawn a session on another box, an
agent wanting to chat with another session — is published as a
`permission_request` card into one conversation's timeline. The user has
many conversations and reads the tracker's Decisions list for things that
need an answer, so a card in a timeline they are not looking at goes
unseen until it expires (24 h). Spawn asks have no list at all; chat asks
have `GET /agent-chat/pending`, which no client surfaces prominently.

The bridge already solves this for one ask: `request_secret` files a
`question` item with the secure link in its body and closes it on submit.
That is bridge-side and reaches a box only through a fleet rollout. Spawn
consent is brokered by the journal for every box, so mirroring it there
covers the fleet in one deploy.

## Design (spawn and agent-chat consent)

**File.** When `spawn_request` has journaled the card (the commit point
that decides row-vs-discard), `fileSpawnConsentItem` creates a `question`
item on the parent conversation: awaiting the user, created by the agent,
origin = the parent conversation and device, top of the open list, label
`consent`, one link `matron://consent/spawn/<request_id>`. Title
`Approve spawn on <box> — <topic or task head>`. Body: who asks, box,
workdir, model and room flag when present, the task verbatim, how to
answer, the 24 h expiry. The row remembers the item
(`agent_spawn_requests.item_id`, new nullable column).

**Close.** `emitSpawnOutcome` is the one funnel every terminal transition
passes through (answer route, orchestration, both sweeps), so it closes
the item: `started`/`declined` → `decided` (the user's call, attributed to
the answering client device), `expired`/`failed` → `cancelled` (the ask
lapsed, attributed to the asking agent's device), each with a one-line
closing note. Item #162's resolution mapping, kept verbatim.

**Markdown-safe.** The body is the first place another agent's words meet
a markdown renderer: the task sits in a fence longer than its longest
backtick run (so it stays verbatim), names have markup stripped, a
backtick in a workdir is dropped from its code span.

**Quiet.** The item's markers are written under the asking agent's device
(the card's sender): no bridge turns them into a session turn (bridges
route only `user:*` markers), no push (the card already pushed), no wake,
and no old-client fallback text — a fallback `text` is a message and would
overwrite the card's snippet and double the unread. `emitMarker` gains a
`fallback` flag for this.

**The user's alone.** The item's body carries the very text the card
withholds from agents — a spawn's unapproved task, a chat ask's
justification, which the consent design keeps from every sibling agent
whether or not the user approves. So a consent mirror (`isConsentMirror`:
`items.consent` = `'spawn'|'chat'`, a mark on the item itself — a renewed
chat ask re-points its row and a device revoke cascades the row away, so
the row pointer alone would unmask an old mirror) is invisible to every
agent caller in every state: 404 on read and on every mutation route,
absent from `GET /items`; and its markers carry `consent: 'spawn'|'chat'`,
which makes them client-only like the cards. That also means the asking
agent, if prompt-injected, can neither rewrite what the user reads nor
close the item out of sight. The user's own hand-close is unaffected.

**Agent-chat asks.** `agent_invite`/`agent_join` file the same kind of
item on the room conversation (`convo_agents.item_id`, refreshed on a
renewed row), titled "‹from› asks to chat with ‹to› — ‹topic›" / "‹from›
asks to join ‹to›'s room", linked `matron://consent/chat/‹room›/‹device›`,
with both sessions, the topic and the justification fenced. Closed by
whatever leaves `awaiting_user`: the answer route and the admin CLI
(`decided`), the awaiting-TTL sweep (`cancelled`), an owner's dissolve
(`cancelled`).

**Best-effort.** A tracker failure is logged and never costs the ask, the
card, or the outcome frame. An item the user closed by hand stays as they
left it. Rows with no `item_id` resolve without one.

**Links.** `validateItemFields` accepts `matron://` alongside `http(s)://`
so a client that patches an item's links can round-trip a consent link.

## What the user gets

On every client, today: the ask appears in the Decisions list, numbered,
with everything the card says and the way back to it (origin chip); it
closes itself with the outcome. When an app learns to render the card
inside item detail (link scheme `matron://consent/spawn/<id>`, buttons on
the existing answer API), the answer happens from the item too.

## Out of scope

Tool-permission prompts are bridge-local, short-lived and answered in
seconds; a per-prompt item would flood the tracker (item #2317: left out).
Plan approvals (the bridge's ExitPlanMode card) wait indefinitely and are
mirrored bridge-side in matron-bridge, not here.
