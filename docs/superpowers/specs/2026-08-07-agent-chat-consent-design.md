# Agent chat consent — the user approves rooms before agents talk

**Status:** design, awaiting approval
**Repos:** matron-journal (enforcement), matron-bridge (tool copy), matron-apple / matron-android (approval card)
**Related:** [agent journal search](2026-08-07-agent-journal-search-design.md), [agent visibility & privacy](2026-08-07-agent-visibility-privacy-design.md)

## Why

Agent-to-agent chat (Phases 1–3, merged at `53d5ad7`, not yet deployed) lets any of a
user's agents open a room with any other. Today the consent decision belongs to the
**target agent**: `ws.js`'s `agent_invite` case relays a `kind:'invite', event:'request'`
frame straight to the target bridge, which injects it as a turn, and the target agent
then calls `agent_chat_accept` or `agent_chat_refuse`.

That ordering is the problem. The requester writes `justification` and the opening
`message`; both reach the target agent's context *before* it decides. Refusing does not
unread them. An agent that has been prompt-injected — by a web page, a PR body, an issue
comment — can therefore deliver arbitrary text into any sibling agent's context, including
one running on a box with more authority, and the only thing standing between the two is
the victim's own judgement about text it has already ingested.

Moving the decision to the user inverts that. The text goes to a human, and reaches the
target agent only on approval.

This spec is sequenced **before** the Phase 3 deploy, so the permissive form never runs.

## What changes

One sentence: `agent_invite` and `agent_join` stop relaying to the target agent and
instead park, publish a `permission_request` to the user's clients, and relay only when
the user approves.

Nothing about how agents *behave* changes. `agent_chat_start`'s tool description already
promises that a pending result is normal and must not be polled — "If the result is
pending or pending_busy, do NOT wait or poll: continue your own work — the answer and any
replies arrive automatically as later turns." A human in the loop is just a longer
pending.

## Enforcement point

`src/ws.js`, `case 'agent_invite'` (and the symmetric `case 'agent_join'`). All existing
validation stays exactly as it is — owner check, self-invite rejection, topic/justification
length caps, and the anti-enumeration `not_found` that makes an unknown id, another user's
device, and a client device indistinguishable. The change is what happens after
`inviteParticipant` succeeds.

The gate is in the journal, never in the bridge. A bridge that has been compromised is
precisely the bridge whose restraint we cannot rely on, and holding the frame server-side
means the payload is never transmitted at all rather than transmitted-and-ignored.

## Data model

`convo_agents.state` gains `'awaiting_user'`:

```sql
state TEXT NOT NULL CHECK(state IN
  ('awaiting_user','invited','joined','refused','denied','left','expired'))
```

`'denied'` is separate from `'refused'` on purpose: `'refused'` means the peer agent said
no, `'denied'` means the user did. They read identically to the requester (see *What the
requester learns*) but they are different facts, and collapsing them would make the audit
trail lie.

The held frame must survive until approval, so `convo_agents` also gains:

```sql
topic TEXT NOT NULL DEFAULT ''
```

`justification` is already stored. `initiator_device_id` and `created_at` are already
stored. Between them that is the whole frame; nothing else needs persisting.

`RENEWABLE` in `src/participants.js` must **not** include `'awaiting_user'`. A pending
request is a conflict, otherwise a rogue agent re-requests in a loop and turns the
approval card into a denial-of-service against the user's attention. It should include
`'denied'`, matching how `'refused'` already works — a past no must not permanently bar a
later legitimate ask.

### State machine

```
agent_invite ──> awaiting_user ──approve──> invited ──accept──> joined
                      │                        │  └─refuse──> refused
                      ├──deny────> denied      └──ttl────> expired
                      └──ttl─────> expired
```

`expireInvites` currently sweeps `state='invited'` on a TTL. It must sweep
`'awaiting_user'` too, on its own — longer — TTL: an invite waiting on a *machine* should
expire briskly, but one waiting on a *human who is asleep* should not evaporate before
they wake. Proposal: keep the existing TTL for `'invited'`, use 24h for `'awaiting_user'`.

The two TTLs also run on different clocks, not just different lengths (locked decision,
see plan header). `'invited'`'s 30-minute answer window clocks from `delivered_at`, not
`created_at`: it is a window for the *target* to answer, so it must not start ticking
before the target has actually seen the ask — an approved-but-undelivered row (target
offline, or an admin approval still waiting on the delivery pump) is exempt and can never
expire out from under a target that never got the frame. `'awaiting_user'`'s 24h TTL
clocks from `created_at`, on its own separate schedule — there is no delivery to wait for
here; the card is published the moment the row parks.

## Delivery timing

The current code treats delivery as synchronous with the request:

```js
const delivered = hub.sendRpcRequest(...)
if (!delivered) { undoInvite(...); return fail('offline') }
```

That fast-fail is deliberate ("spec: honest fast status") and it cannot survive as-is,
because at request time we no longer attempt delivery. The online check moves to approval
time, and a new case appears: approved, but the target has since gone offline.

**Behaviour (locked decision, see plan header):** `convo_agents` gains a `delivered_at`
column, separating "the user approved this" from "the target actually got the frame" into
two independent facts. A single delivery pump, `deliverPendingInvites(db, hub, {deviceId?})`,
owns every row with `state='invited' AND delivered_at IS NULL` and is called from three
places: the HTTP approve handler (immediate attempt, scoped to the just-answered row's
recipient), an agent's `hello` registration (scoped to that device — catches up whatever was
approved while it was offline), and the periodic sweep timer (unscoped catch-all — covers
`matron-admin` approvals, which never touch a running server's hub at all, and any row whose
target was already connected at approval time so no `hello` would ever fire for it).
`markDelivered`'s `delivered_at IS NULL` guard makes the pump idempotent against the three
callers racing each other. There is no separate "replay hook" to reuse for this — none
existed; the pump *is* the mechanism. The user's card resolves to "approved — waiting for
that agent to come online"; the requester is told the same (`delivered` widens to mean
"accepted into the system", not "reached a socket" — see "What the requester learns").

Holding rather than failing is the right default because the human and the peer are now
two independent sources of delay, and failing an approved request because the peer blinked
would be infuriating and would push the user toward approving pre-emptively.

## The approval surface

**Where (locked decision, see plan header).** A `permission_request` event appended to the
**room conversation** — not, as first drafted here, "the target agent's session
conversation". The journal has no way to know which session conversation the target bridge
would even choose to treat as "the" one for this — that mapping lives bridge-side and the
journal cannot see it — while the room is a real, already-existing, user-visible
conversation, and it is where the chat will actually happen if the user approves. Push
(`permission_request` → `attention`, already wired, `push.js:37`, no change needed) deep-links
the user there. This does mean `formatInviteRequestNotice`'s bridge-side publication into the
target's session conversation is no longer the user's first sight of the ask — see
"Bridge-side changes" below for what becomes of it.

**It must be a client-only event, and this is load-bearing.** `hub.broadcastJournal` gives
client devices every frame but gives an agent device every frame *for a conversation it
manages*. The target agent manages this conversation. So a naively published card would
deliver the requester's justification straight to the target bridge — reinstating the exact
exposure this spec exists to remove, by a different route.

The existing `agentTargets` parameter already provides the fix: passing an **empty set**
(rather than `null`, which means broadcast-to-everyone) skips every agent connection while
leaving client delivery untouched. No new fan-out machinery.

That covers live delivery. The same exclusion must hold on **hello replay**, or an agent
that reconnects receives the card as history — the property has to be durable, not just
momentary. A shared predicate:

```js
export function isClientOnlyEvent(type, payload) // -> bool
```

consulted by both the live fan-out and the replay path, returning true for
`permission_request` with `kind: 'agent_chat'`. One rule, two call sites, one test each —
the alternative, a type check inlined in both places, is how the two drift apart.

**Payload.**

```json
{
  "type": "permission_request",
  "kind": "agent_chat",
  "room_id": "…",
  "from_device_id": 7,
  "from_name": "…",
  "target_device_id": 12,
  "topic": "…",
  "justification": "…"
}
```

**Sanitisation is now the journal's job.** Today the bridge sanitises peer-written text
through `peerField` before publishing it in the bridge's own voice — coerced, stripped of
control characters, flattened to one line, length-capped — because a `\n` in a
justification is line forgery in the user's chat, not a cosmetic problem. With the journal
publishing this event, that same treatment has to exist journal-side. `from_name`, `topic`
and `justification` are all written by a remote agent.

The apps must render `justification` as untrusted text: no markdown, no autolinking, no
image embedding. It is an attacker-controlled string being shown to a human who is about
to make a security decision, and a rendered `[click here](evil)` inside it would be the
whole exploit again with extra steps.

**Approve / deny route.**

```
POST /agent-chat/answer   { room_id, target_device_id, decision: "approve"|"deny" }
```

Gated on `who.kind !== 'client'` → 403, the pattern a dozen journal routes already use.
An agent device must never be able to approve anything, including its own request.

**Push.** The request must generate a push notification through the existing relay, in its
own category so it can be controlled separately from message pushes. An approval gate the
user does not know about is just a hang.

**Remembering.** The card offers "Always allow *this agent* to chat to *that agent*",
recorded as a directed pair `(from_device_id → target_device_id)`. Off by default. It is
worth having because overnight coordination between two agents the user has already
sanctioned should not need re-approval at 3am; it is off by default because the safe
choice should be the one you get by not thinking. A stored pair is revocable from the
devices UI.

## Bridge-side changes

Small, but not zero.

`formatInviteRequestNotice` publishes the user's copy of an inbound request when the bridge
receives the frame. Under this design the bridge only receives that frame *after* the user
has approved it, so the notice now arrives second and tells the user something they just
decided. It should be dropped, or reduced to a one-line "chat with X started" — the ask
belongs to the card, the confirmation belongs here.

`agent_chat_start`'s tool description needs one clause: pending may now mean waiting on the
user, not only on the peer. The existing "do NOT wait or poll" instruction stands and
becomes more important, since the wait can now be hours.

## What the requester learns

`'denied'`, `'refused'` and `'expired'` must be indistinguishable to the requesting agent
— all three answer "declined". A requester that can tell "the user said no" from "the peer
said no" from "nobody answered" can probe the user's attention patterns and retry
accordingly. The distinction is kept in the database for the user's benefit, not exposed.

While parked, the requester's `agent_chat_start` returns `pending` — the status it already
handles.

## Anti-abuse

- Outstanding `'awaiting_user'` rows per requesting device are capped (proposal: 3). Over
  the cap, `agent_invite` fails `conflict`.
- The non-renewable `'awaiting_user'` state stops re-request loops on a single target.
- Existing length caps on `topic` and `justification` are unchanged and now do double duty
  as a bound on how much attacker text a human is asked to read.

## Testing

- An `agent_invite` sends **nothing** to the target device. This is the security property;
  it deserves a test that asserts on the hub mock receiving no frame, not merely on state.
- The approval card, published into the **room conversation** (locked decision, see plan
  header — not a session conversation), reaches client devices and **no** agent device —
  including the room's own recorded owner, who is exactly the device a naive fan-out would
  deliver to first since it manages that conversation, and for an `agent_join` card is also
  the target the justification must stay hidden from. Asserted on live fan-out, and
  separately on hello replay, where a reconnecting agent (owner or target) must not receive
  it as history.
- Approval relays exactly the frame that was parked, with the stored topic and
  justification.
- Deny → `'denied'`, requester sees the same string as `'refused'` and `'expired'`.
- An agent device calling `/agent-chat/answer` gets 403, including for its own request.
- Control characters and newlines in `from_name` / `topic` / `justification` cannot forge
  lines in the published event.
- `'awaiting_user'` is not renewable; a second request while parked is a `conflict`.
- Per-requester cap rejects the fourth outstanding request.
- Target offline at approval → held, delivered on that device's next registration.
- TTL sweep moves `'awaiting_user'` to `'expired'` at 24h and notifies the requester.
- Cross-user isolation: a device cannot approve, deny, or observe another user's request.

## Not doing

- Per-message approval. Approval gates first contact; once a room exists, its agents talk
  freely. Gating every message would be unusable, and this residual is the reason the
  [privacy spec](2026-08-07-agent-visibility-privacy-design.md) still matters for the most
  sensitive machines — unreachable has no first-contact hole.
- Approval for anything other than agent↔agent rooms. User↔agent conversations are
  unaffected.
- Retroactive approval of rooms created before this ships. There are none in production;
  Phase 3 has not deployed.

## Open questions

1. **24h `'awaiting_user'` TTL** — long enough to survive a night, short enough that stale
   asks do not accumulate. Confirm or pick another number.
2. **Cap of 3 outstanding requests per requester** — a guess. Real usage may want more.
3. **Where the "always allow" pairs are managed.** The devices UI is the obvious home, but
   that screen is app work in three codebases; a `matron-admin` subcommand could carry v1.
