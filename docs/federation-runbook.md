# Running federation: an operator's runbook

How to turn federation on for a journal, link it with one other journal,
keep an eye on it, and turn it off. The protocol itself is in
`docs/protocol.md`, "Federation (between journals)".

Throughout, our journal is `a.example` (where alice is a user) and the other
one is `b.example` (where bob is).

## Before you turn it on

- **A public https origin.** The journal must be reachable at a fixed https
  URL, such as `https://a.example`, with a certificate other machines trust.
  That URL's host is the journal's name in every address (`alice@a.example`),
  and it can't change later without becoming a new journal to every peer.
  Federation refuses plain http, except for `localhost`.
- **The token box key** (`MATRON_TOKEN_KEY`, 64 hex characters). It seals the
  journal's federation key in the database. Keep it with your other secrets,
  and never change it in passing.
- **Backups of the database.** The journal makes its Ed25519 key the first
  time it starts with federation on, and stores it sealed in the
  `journal_settings` table. There is no rotation. Back up the database, and
  keep the token box key somewhere separate. If you lose either, every peer
  sees a new journal, and your users have to exchange fresh invites with
  their contacts.
- **Inbound reachability.** Other journals call `POST /federation/v1`,
  `GET /federation/v1/media` and `GET /.well-known/matron-journal` on your
  origin. A proxy in front of the journal must pass those through, with
  their request bodies (up to 1 MiB) and headers intact.

## Turning it on

Set these in the journal's environment, then restart it:

```
MATRON_FEDERATION=on
MATRON_PUBLIC_URL=https://a.example
MATRON_TOKEN_KEY=<64 hex>
MATRON_FEDERATION_ALLOW_JOURNALS=b.example     # recommended for a first link
```

The journal logs one line at start:

```
federation: on as a.example, key <fingerprint>
```

If one of the three required settings is missing, or the stored key doesn't
open under the token box key, it logs why and stays off. Check from outside:

```
curl -s https://a.example/.well-known/matron-journal
```

That answers `404` while federation is off. When it's on, it answers
`{v: 1, journal, base_url, key: {alg, pub, id}, federation}`, where `key.id`
is the fingerprint.

`matron-admin federation status`, run with the journal's environment, shows
the switch as that shell sees it, plus the public key, its fingerprint and
when the key was made.

## The allow list

`MATRON_FEDERATION_ALLOW_JOURNALS` is a comma-separated list of journal
hosts. While it is set, only those journals can federate with yours.
`MATRON_FEDERATION_DENY_JOURNALS` refuses hosts, and a deny wins over an
allow. Without an allow list, any journal a user swaps an invite with can
federate: the invite is the trust.

For a first link, set the allow list to the one other journal. Widen it, or
remove it, once you're happy with how it runs.

## Linking two people

1. Both journals are on, and each allows the other.
2. **alice makes an invite** in her app: People, then "Invite someone on
   another Matron". An agent can ask for one (`contact_add` with
   `remote: true`), but only alice's tap makes the link, and it shows on her
   device only. The link is
   `https://a.example/contact#v=1&j=a.example&u=alice&t=<token>&fp=<fingerprint>`,
   which chat apps and mail make tappable (older apps show the same invite
   as `matron://contact?v=1&j=…`; both work).
   It can be used once, lasts 7 days, and her journal keeps only its hash.
3. alice sends bob the link over any channel.
4. **bob opens it** in his app: tapping the https link opens the app where
   it's installed, or alice's journal's `/contact` page, which hands it to
   the app or says how to paste it in.
   His journal fetches
   `https://a.example/.well-known/matron-journal` and refuses the link if the
   key there doesn't match its `fp`. The accept card shows alice's address,
   her journal and the fingerprint, grouped in fours.
5. **Compare the fingerprint another way.** alice reads hers out from
   `matron-admin federation status`, or from the link, over a call or in
   person. bob checks it matches his card. The link already pins the key, so
   this check is about the link itself: it confirms nobody else made or
   changed the link on its way to bob.
6. **bob accepts.** His journal sends a signed `contact.accept_invite`. The
   contact becomes active on both sides when alice's journal acknowledges it,
   usually within seconds.

After that, alice can share a mission with `bob@b.example` to read, and bob
approves it on his side.

## Watching it

- **The journal log** names a peer that says your clock is off, and any
  hook that failed.
- **The outbox.** A user's client can read that user's own outbox at
  `GET /federation/outbox?state=dead|queued|sent|cancelled` (client devices
  only, and never the bodies). For the whole journal, look at the
  `fed_outbox` table: `state`, `attempts`, `last_status` and `last_error`
  per entry. Sent and cancelled entries are deleted a week after they
  ended.
- **Dead deliveries.** An op the other journal hasn't acknowledged within 7
  days, or that it refused for good, goes dead. Its user gets one notice per
  peer in their People conversation. Dead ops hold up later ops on the same
  subject until the user resends or discards them
  (`POST /federation/outbox/resend {peer}` or `/discard {peer}`). A resend
  keeps the same op ids, so a peer that already applied one just answers
  from its receipt. Ops queued more than 23 days ago can't be resent.
- **A peer whose key changed** is marked `key_changed`. Nothing more goes to
  it, or is accepted from it, until a user accepts a fresh invite from that
  journal. Treat it as a new journal until someone confirms the change with
  its operator.
- **Common `last_error`s:**
  - `journal_not_allowed`: your lists refuse that journal.
  - `unreachable`: the other origin didn't answer, or its certificate failed.
  - `stale`: your clock and theirs are more than a few minutes apart. Fix
    NTP.
  - `expired`: not acknowledged within 7 days.

  `fingerprint_mismatch` isn't an outbox error. It's what opening a link
  answers when the link doesn't match the journal's current key.

## The kill switch

Set `MATRON_FEDERATION=off` (or remove it) and restart the journal. Then:

- `/.well-known/matron-journal` and `POST /federation/v1` answer `404`.
- The outbox stops, and nothing is sent.
- Invite routes answer `409 blocked_by: federation_off`.

The key, contacts, shares and queued ops all stay in the database. Turning
federation on again picks them up. The 7 days keep counting while it's off,
so an op more than 7 days old by then goes dead, and its user can resend
it.

To cut off one journal and keep the others, block it:

```
matron-admin federation block b.example
matron-admin federation unblock b.example
matron-admin federation peers
```

A block takes effect at once, with no restart. Its envelopes are refused
with `403 peer_refused`, invite links from it are refused, and what you
would send it goes dead as `peer_blocked`, with a notice to each user it
was for. A host this journal has never heard from can be blocked ahead of
time. After an unblock, its contacts work again with the key they pinned,
and users can resend what went dead. `peers` lists every journal this one
knows, with its state, live contacts, queued and dead ops, and when it last
answered.

Adding the host to `MATRON_FEDERATION_DENY_JOURNALS` and restarting does
the same from the environment; what you would send it then goes dead as
`journal_not_allowed`.

## What crosses, and what doesn't

Only what a person shared crosses, each time with their own tap:

- a contact's address and display name
- read shares of missions: the mission, its milestones and items, as a
  contact on the same journal would see them
- those items' attachments, fetched by the other journal when first opened

These never cross:

- conversations, transcripts, tool output, memories or secrets
- box names
- owner-only items
- anything from a private box: when a box turns private, a fresh snapshot
  takes its records back out of every copy on other journals
