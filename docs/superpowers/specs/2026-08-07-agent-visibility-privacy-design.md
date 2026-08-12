# Agent visibility & privacy — machines that other agents cannot see or reach

**Status:** design, awaiting approval
**Repos:** matron-journal (enforcement), matron-bridge (registration flag)
**Related:** [agent chat consent](2026-08-07-agent-chat-consent-design.md), [agent journal search](2026-08-07-agent-journal-search-design.md)

## Why

[Consent](2026-08-07-agent-chat-consent-design.md) stops a rogue agent injecting text into
a sibling's context. It does not stop it *watching*, and it has one structural hole.

**Disclosure.** `agent_roster` hands any agent, unconditionally: every other agent's name
and device id, and for thirty conversations the id, title, session state, and a
200-character rolling summary. An agent that never starts a chat and never searches
anything already receives a decent map of everything the user is working on. Adding
[journal search](2026-08-07-agent-journal-search-design.md) widens that from a map to the
territory.

**The first-contact hole.** Consent gates the creation of a room, not the messages inside
it. Once the user approves agent A talking to agent B, a compromised A can work on B
freely and indefinitely. For most pairs that is an acceptable trade — approval is a
judgement the user actually made. For a machine with materially more authority than its
siblings, *unreachable* is a stronger property than *approved*, because unreachable has no
first-contact hole at all.

So this is the third leg: some agents should be invisible and unreachable to other agents.

## The flag

```sql
ALTER TABLE devices ADD COLUMN private INTEGER NOT NULL DEFAULT 0
```

Meaning: **invisible and unreachable to other agent devices.** Not invisible to the user —
the user's own apps are `kind='client'` and see everything they see today. This is
compartmentalisation between agents, not a hidden folder.

Every rule below is conditioned on the *caller* being `kind='agent'`. `devices.kind` is
already `'client' | 'agent'`, and `src/http.js` already gates a dozen management routes on
`who.kind !== 'client'` → 403, so the hook exists and the pattern is established.

## Three surfaces

**Roster.** A private agent, and every conversation whose `agent_device_id` is a private
device, are omitted from `agent_roster` for agent callers. Highest value of the three,
because of the summaries.

**Search and context.** `/search` excludes hits from conversations owned by a private
device; `around_seq` refuses to read them. Both for agent callers only — the user's apps
are unaffected.

**Chat.** `agent_invite` and `agent_join` targeting a private device fail `not_found`,
identically to an unknown id, another user's device, and a client device. The existing
anti-enumeration stance already produces exactly this error for those three cases, so a
private device simply joins the set. A distinct "that agent is private" would confirm its
existence, which is the thing being hidden.

## One-directional, deliberately

A private agent keeps full outbound capability: it sees the whole roster, searches
everything, and can start chats with non-private agents. It is invisible, not blinded.

Quarantining the privileged machine into uselessness would defeat the purpose — that
machine is usually the one that most needs to coordinate. And traffic it initiates is on
the trusted side of the boundary: it chose the peer, rather than a peer choosing it.

The asymmetry does mean a private agent can reveal itself by starting a chat. That is the
user's call at the moment they configure it, and it is the correct default.

## Setting it

An env var the bridge presents at registration — `MATRON_AGENT_PRIVATE=1` — with
`matron-admin` as the authoritative override.

The env var is not the weakness it looks like. The only flag a compromised bridge can
change is its own, and unmarking itself merely makes it *visible*, which harms nobody but
itself. It cannot touch another device's flag, and another device's flag is the one that
matters. An attacker who can set `private` on the box they have already compromised has
gained nothing.

`matron-admin` remains authoritative so a machine can be marked private without redeploying
it, and so the flag can be audited server-side.

## What this does not do

Stated plainly, so the flag is not over-trusted:

- **It is visibility, not privilege.** Every bridge is still the same journal user with the
  same rights. A rogue agent is not prevented from doing damage on its own box; it is
  prevented from recruiting or surveilling the private one.
- **It does not stop the user relaying.** Text the user copies out of one conversation and
  into another bypasses every rule here.
- **It is asymmetric in the other direction too.** The private agent reads everything, so
  if *it* is the compromised one, the flag has bought nothing.
- **It does not retroactively hide history.** Conversations a private agent owned before
  the flag was set become hidden; anything it said in *another* agent's conversation stays
  visible there.

## Testing

- Agent caller: private device absent from `agent_roster`, along with its conversations.
- Client caller: private device present everywhere, unchanged.
- `/search` from an agent returns no hits from a private device's conversations; from a
  client, it does.
- `around_seq` on a private conversation → 404 for an agent, normal for a client.
- `agent_invite` and `agent_join` targeting a private device → `not_found`, byte-identical
  to targeting an unknown id.
- A private agent can itself roster, search, and invite outward.
- The flag survives a bridge re-registering without the env var **only** when set by
  `matron-admin` — the precedence rule needs pinning by a test, because getting it backwards
  silently unmarks a machine.
- Cross-user: privacy is per-user; another user's devices are already invisible and stay so.

## Open questions

1. **Precedence.** If `matron-admin` marks a device private and it later registers with
   `MATRON_AGENT_PRIVATE` unset, does it stay private? Proposal: yes, admin wins — an
   explicit server-side decision should not be undone by a deploy that forgot an env var.
   **Resolved:** yes, admin wins, via the pin (`private_pinned`) — see "Locked decisions"
   below.
2. **Per-conversation privacy** as well as per-device — "this chat is not searchable by
   agents", independent of which machine owns it. Plausibly useful, not specified here; it
   would want its own flag on `conversations` and the same three-surface treatment.
   **Deferred** — out of scope for this implementation; unchanged from the proposal above.
3. **Whether a private agent should be excluded from the roster it receives** — i.e. can
   two private agents see each other? Proposal: yes, they can. Private is about the
   boundary with ordinary agents. **Resolved:** yes, uniformly — private callers bypass
   all filtering, at every surface, not just the roster — see "Locked decisions" below.

## Locked decisions (2026-08-08 planning)

Called out in the implementation plan's header
(`docs/superpowers/plans/2026-08-08-agent-visibility-privacy.md`) for Dan:

1. **The bridge presents its flag on every WS hello** — an optional boolean `private`
   field on the hello frame, applied for agent connections only, ignored for clients.
   Rationale: agents are minted at `/pair/claim` (a one-shot poll with no operator
   present) and long-lived after that; hello is the only recurring moment the bridge can
   assert env-var config without re-pairing. The bridge-side change (read
   `MATRON_AGENT_PRIVATE`, send the field) is a separate matron-bridge task.
2. **Pin semantics.** `private_pinned=1` means matron-admin owns the flag and hello
   assertions are ignored. `matron-admin device private <id> on|off` sets value + pin;
   `auto` clears the pin (the value stays until the next hello asserts). An unpinned flag
   follows the hello assertion exactly — including hello-without-the-field, which asserts
   `false` (spec test: bridge-set privacy does NOT survive a re-register without the env
   var; admin-set does).
3. **Open question 1 (precedence): resolved as proposed — admin wins** (that is what the
   pin is).
4. **Open question 3 (can two private agents see each other): resolved as proposed —
   yes.** Implemented as: the privacy filter applies only when the caller is a
   non-private agent, at every surface uniformly (roster, search, context, chat). The
   spec's "can start chats with non-private agents" sentence is superseded by this — a
   private agent can also invite another private agent; "private is about the boundary
   with ordinary agents".
5. **Open question 2 (per-conversation privacy): out of scope**, unchanged.
6. **`GET /devices` is untouched** — it is already client-only (`src/http.js`), so a
   private device correctly remains visible there to the user.

## Implementation deltas (2026-08-08 execution)

Where the shipped implementation departs from the plan above, and why:

- **`agent_join`'s owner check moved into `loadRoom`; `agent_invite`'s target check did
  not.** The plan's Task 5 specified two separate per-op checks — `agent_invite`'s
  target-device lookup and `agent_join`'s room-owner lookup. Execution subsumed only the
  second of those into `loadRoom` (`src/ws.js`), the shared lookup behind all five room
  ops: gating on `room.agent_device_id`'s privacy there, rather than in `agent_join`
  alone, closes what would otherwise have been distinct error shapes for a private-owned
  room versus a nonexistent one on the other three ops (`agent_invite_ack`,
  `agent_invite_answer`, `agent_leave` — e.g. "no pending invite" vs `not_found`), which
  had no privacy check of their own — an existence oracle in the fields those per-op
  checks didn't cover. `agent_invite`'s target-device check is a *different* check (is
  the invite's target private, independent of whether the room's owner is) and remains
  exactly where the plan put it, per-op inside `agent_invite`, unreplaced. The `loadRoom`
  exemption is `isKnownParticipant` (`src/participants.js`), narrower than plain
  participant lookup: it passes only a caller that initiated the ask, actually had it
  delivered, or is `joined` — a merely parked (`awaiting_user`) or `denied` row does not
  exempt, since either would leak the room's existence to an agent the user never
  approved or explicitly refused.
- **A Task 8 (`/snapshot`) was added by the search branch's final security review**,
  outside this plan's original four-surface scope. `GET /snapshot` predates this feature
  and needed its own two rules layered on top: `snippet` omitted for every agent caller
  (private or not — a credential-leakage concern, since a snippet can carry `tool_output`
  text), and private-owned conversations excluded for a filtered (ordinary) agent caller
  only, matching the `/roster`/`/search` predicate so `/snapshot` can't be used as an
  end-run around either.
