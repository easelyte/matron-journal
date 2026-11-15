# Protocol conformance fixtures (spec §12)

Golden JSON exchanges for matron-journal's wire protocol (`POST /login`,
`GET /snapshot`, `GET /convo/:id/messages`, `POST`/`GET /media`,
`POST /password`, `GET /metrics`, and the `/ws` socket). Each file here is
one canonical scenario, replayed against a **real, freshly-started,
in-process server** through the replay coordinator, by the committed runner,
`test/conformance.test.js` (`npm test` runs it along with everything else).
See "Tooling" at the bottom for the seeded-server CLI and the runner protocol.

The point of this suite: two independent client implementations (the Node
runner in this repo, and the Matron Swift client's test target) can both
replay the same fixtures against a local server instance and assert
byte-for-byte agreement on every exchange, so the protocol can't quietly
drift out from under either implementation. `tools/conformance/matcher.js` is
the **reference implementation** of the matcher described below — a Swift
harness re-implements the same four rules (they're deliberately small; see
"Porting to Swift" at the bottom).

Fixtures are **hand-shaped, not generated**: write them by driving a local
server and a real client (or `test/helpers.js`) and capturing the actual
exchange, then trim it down to the essential shape. There is no fixture
generator committed to this repo — that would just be another thing that
could silently drift from the runner. (The decoder extracts under `payloads/`
are different: they are derived from the fixtures and checked in CI.)

## File format

One JSON file per scenario:

```jsonc
{
  "name": "human-readable scenario name",
  "description": "one or two sentences: what this proves and why",

  // Required. The protocol revision this fixture was written against, an
  // integer starting at 1.
  "protocol": 1,

  // Optional (default 1, never greater than `protocol`). The first protocol
  // revision a client must pass this fixture on. A client that declares an
  // older revision skips the fixture instead of failing it, so a scenario for a
  // new protocol addition can ship before every client has caught up.
  "since": 1,

  // Optional. Overrides passed straight into startServer() (src/server.js),
  // e.g. {"maxReplay": 5} to force the snapshot_required valve, or
  // {"mediaMaxBytes": 16} to force the 413 cap. `dbPath` is always chosen by
  // the runner, never the fixture — see "Isolation" below.
  "server": { "maxReplay": 5 },

  // Optional. Test-only preconditions, applied directly via src/auth.js and
  // src/journal.js helpers BEFORE any step runs. This is setup, not
  // protocol traffic under test — same idea as the existing unit tests'
  // `createUser`/`createAgent`/`upsertConversation`/`append` calls.
  "seed": {
    "users":         [{ "as": "alice", "name": "alice", "password": "..." }],
    "agents":        [{ "as": "bridge", "user": "alice", "name": "box-2" }],
    "conversations": [{ "id": "c1", "owner": "alice", "title": "T", "sessionState": "running", "agent": "bridge" }],
    "events":        [{ "convo": "c1", "sender": "agent:a", "type": "text", "payload": { "body": "hi" } }]
  },

  // The exchange under test, executed in order. See "Step kinds" below.
  "steps": [ /* ... */ ]
}
```

Seeding an `as: "alice"` user automatically binds `alice.user_id`; seeding an
`as: "bridge"` agent binds `bridge.token` and `bridge.device_id` (agent
tokens are minted at seed time, unlike client tokens, which only exist after
a `POST /login` step — see "Bindings" below). `seed.events[].convo` must
name a conversation already listed in `seed.conversations`; its owner is
inferred from that conversation, not repeated per event. A conversation's
optional `agent` names a `seed.agents[].as` value, resolved to that agent's
`device_id` and passed as `upsertConversation`'s `agentDeviceId` — i.e. that
agent *manages* the conversation, the same as it would after the bridge's
own `convo_upsert`. Needed by any fixture step where an agent caller must
clear `authorizeAgentWrite` against this convo (e.g. filing an item).
Omitted, the conversation is seeded with no manager, same as before this
field existed.

## Roles

Every step carries a required `role` saying which actor performs it:

- `client`: an app's side of the exchange (login, hello, sending, expecting).
- `agent`: the bridge's side (an agent token's calls and its socket).
- `admin`: an out-of-band operational action (`admin_revoke_device`).

When a fixture has more than one client, client steps also carry `client`, a
name for that client (`mac`, `ipad`). `client` is only legal on `role: "client"`.
Every WebSocket connection belongs to exactly one actor (the same role and
client name on every step that names it). A platform harness runs the steps of
its own role through its real networking and decoding code; a coordinator
(`tools/conformance-server.js`) plays every other actor. The schema and the
coordinator both enforce these rules.

## Step kinds

- **`http`** — one HTTP request/response.
  `{kind, method, path, headers?, token?, body?, body_base64?, content_type?, expect: {status?, headers?, body?, body_base64?}}`
  - `path` supports `${name}` string interpolation (see "Path/header
    templating" below) — needed for e.g. `GET /media/${media_id}` once
    `media_id` was `$bind`-captured from an earlier step's response.
  - `token`, if present, is sent as `Authorization: Bearer <token>` (resolved
    like any other value — see "Bindings").
  - Exactly one of `body` (JSON, matcher-resolved) or `body_base64` (raw
    bytes, for `POST /media`) may be given.
  - `expect.body` matches a JSON response; `expect.body_base64` matches a
    binary response (e.g. `GET /media/:id`) byte-for-byte.
- **`ws_open`** — `{kind, conn}`. Opens a named WebSocket connection (no
  frame sent yet — matching the real protocol, where `hello` is just the
  first `ws_send`).
- **`ws_send`** — `{kind, conn, frame}`. Sends `frame` (matcher-resolved) as
  a JSON text frame on the named connection.
- **`ws_expect`** — `{kind, conn, frame}`. Waits (up to a **2000 ms**
  timeout — a harness constant, not per-fixture) for and consumes the next
  unconsumed frame on that connection (frames are asserted **in arrival
  order, per connection** — each connection has its own FIFO cursor), and
  matches it against `frame`.
- **`ws_expect_none`** — `{kind, conn, ms?}`. Asserts no new frame arrives
  on that connection within `ms` (default **200 ms**) — used to prove
  something is *not* delivered (e.g. ephemerals to a non-viewing device, a
  deduped resend). **Liveness requirement:** the step must ALSO assert the
  connection is still open at the end of the window — a closed socket
  receives nothing trivially, so a dead connection must FAIL this step, not
  pass it vacuously. Swift ports must implement the same check.
- **`ws_expect_close`** — `{kind, conn, code?}`. Waits (up to the same
  **2000 ms** timeout as `ws_expect`) for the connection to close; if
  `code` is given, asserts the WS close code matches.
- **`wait`** — `{kind, ms}`. A plain pause. **Last resort only** — a bare
  sleep is a flake waiting to happen. Prefer a *causal barrier*: the server
  is single-threaded and processes each connection's frames in FIFO order,
  so sending a durable op after the frame whose effect you need applied,
  and `ws_expect`-ing that op's journal echo (on whichever connection needs
  the guarantee), proves the earlier frame was processed — see the
  `08_ack`/`10_activity`/`12_revocation` fixtures' descriptions. No current
  fixture uses `wait`; if one ever must (a genuinely signal-free exchange),
  its `description` must say why no barrier exists.
- **`admin_revoke_device`** — `{kind, device_id}`. **Not a wire message** —
  this is what `matron-admin device revoke <id>` does under the hood
  (delete the `devices` row). It exists so a fixture can construct the
  precondition for testing the protocol's *reaction* to revocation (the next
  frame on that device's connection gets `{code:'revoked'}` + close 4001).
  A Swift harness driving its own local server instance can satisfy this
  step however is convenient for it (shell out to `matron-admin`, or touch
  its own test DB directly) — the fixture only specifies *what* out-of-band
  operational action occurred, never *how*.

### Client lifecycle steps

These describe what an app does around a dropped connection and how it decides
to notify. All are `role: "client"` except `disconnect` and
`reconnect_from_cursor`, which an agent can also use. A runner that cannot
perform a step kind reports that and the fixture is skipped for it.

- **`disconnect`**: `{kind, role, conn}`. Drops the socket as a network drop
  would. The platform runner severs its own socket and does not reconnect on its
  own: not on a timer, and not when `advance_clock` moves virtual time. The
  connection comes back only with `reconnect_from_cursor`.
- **`reconnect_from_cursor`**: `{kind, role, conn, cursor?}`. Opens the socket
  again and sends `hello` with `cursor`: the highest journal seq the actor
  applied before the drop unless `cursor` is given (an integer, `null`, or a
  `{"$ref"}`). The hello token is the one the connection used before.
- **`advance_clock`**: `{kind, role, ms}`. Advances the client's virtual clock
  (timers, backoff, grace periods). The server and the real sockets keep real time.
- **`set_app_state`**: `{kind, role, app?, muted?}`. `app` is `foreground` or
  `background`; `muted` is a boolean. At least one is required. `muted` mutes (or
  unmutes) the conversations the app knows through its own settings write
  (`PUT /notify`), so the journal pushes a `notify` frame to the user's client
  sockets; a fixture expects that frame next. An app that has the conversation
  open on screen says so with a `viewing` frame, which is also what a foreground
  notification decision reads.
- **`expect_model`**: `{kind, role, expect}`. Matches the client's model state,
  as the platform runner reports it through its test hook, against `expect`.
- **`expect_notification`**: `{kind, role, expect}`. Matches the client's most
  recent notification decision, reported the same way.

`expect_model` and `expect_notification` use the standard matcher below. The
shape each runner reports is defined by its test hook.

## The variable convention (bind / ref / type / ignore)

Dynamic values — tokens, device/user ids, seqs, timestamps, media ids,
sha256 digests — can't be hardcoded into a fixture and still match a fresh
server run. Exactly **four** node types, matched/resolved the same way
everywhere a JSON value appears (HTTP body, HTTP header value, WS frame):

| node | where legal | meaning |
|---|---|---|
| `{"$bind": "name"}` | expected side only (`expect.*`, `ws_expect.frame`) | matches any value; records it under `name` for later `$ref` |
| `{"$ref": "name"}` | both sides | outbound: substituted with the bound value. inbound: must deep-equal the bound value |
| `{"$type": "T"}` | expected side only | matches any value whose type is `T` — one of `integer, number, string, boolean, null, array, object` |
| `{"$ignore": true}` | expected side only | matches any value, unconditionally, and binds nothing |

`bindings` is **one flat map for the whole fixture run** — every step
(seed, HTTP, WS) shares it. There's no scoping beyond that; pick names that
won't collide (the seed helpers use a `<as>.field` convention, e.g.
`alice.user_id`, `bridge.token` — steps are free to use flat names like
`media_id`).

Every other JSON value (object, array, string, number, boolean, `null`) is a
**literal**: on the expected side, plain objects must match the actual
value's key set **exactly** (no extra keys, no missing keys — this is what
makes the fixtures byte-for-byte, not just "contains"); arrays must match
length and every element in order; primitives use `===`. This also means a
field the real server omits from a JSON frame (e.g. `ws.js`'s `stream`
ephemeral frame drops an `undefined text` key entirely, since
`JSON.stringify` strips `undefined` properties) must simply be **absent**
from the fixture's expected object too — don't write `"text": null`, since
`null` and *absent* are different observations.

### Path/header templating

Separate from the value matcher above (which operates on parsed JSON), `http`
step `path` and `headers` values are plain strings that support `${name}`
interpolation, substituted from the same bindings map (`String(value)`).
This exists only because a URL path or header can't embed a `{"$ref": ...}`
object inline — it's a second, even smaller mechanism, not a special case
of the value matcher.

### Reserved keys

`$bind`, `$ref`, `$type`, `$ignore` are reserved as *object keys standing
alone* in this fixture format. No matron-journal protocol payload uses a
field named that way, so this never collides with real traffic.

## Schema, decoder extracts and the key table

- `schema/fixture.schema.json` is the JSON Schema (draft 2020-12) for the
  fixture format above. Every fixture here validates against it
  (`test/conformance-schema.test.js`), with the extra rules a schema cannot
  express: `since` is not greater than `protocol`, and each connection belongs to
  one actor.
- `payloads/<frame-type>.json` are decoder-only extracts: frames and response
  bodies taken from fixtures with every variable resolved to a stable sample
  value, validated by `schema/payload-extract.schema.json`. A client decodes each
  sample and checks the store effect, without a server.
- `keys/message-box.json` is the message-box key table: rows of key, modifiers,
  input-method state and primary pointer, with the expected outcome (`send`,
  `newline` or `none`). Each platform runs every row against every message box it
  has. `schema/key-table.schema.json` describes it. A row without an expected
  outcome is rejected.

## Isolation

Every fixture gets a **fresh server instance** (`startServer()` from
`src/server.js`) with an isolated database — `dbPath: ':memory:'` by
default, or a throwaway `os.tmpdir()` SQLite file + media directory when
`"server": {"tmpDb": true}` is set (required for anything touching
`POST`/`GET /media`, since blobs need a real disk path). Fixtures never
touch a real/shared database, and the runner never reads or writes anything
under `~/.config/matron/`.

## Porting to Swift

The whole matcher is ~40 lines (`match`/`resolve`/`resolveString` in
`tools/conformance/matcher.js`) — deliberately small enough to re-implement in
an afternoon:

1. Load a fixture, walk `seed` calling the equivalent local setup.
2. Walk `steps` in order, dispatching on `kind`.
3. For `expect`/`ws_expect` matching: recursively compare, special-casing
   objects with exactly the keys `$bind`/`$ref`/`$type`/`$ignore` as
   described above, exact-key-set otherwise.
4. For outbound (`body`, `frame`, `token`) resolution: recursively replace
   `{"$ref": "name"}` nodes with the bound value; everything else passes
   through unchanged.
5. Timeouts and liveness: `ws_expect`/`ws_expect_close` wait up to 2000 ms;
   `ws_expect_none` observes a `ms` (default 200 ms) quiet window AND must
   assert the connection is still open at its end — a closed socket must
   fail the step, never pass it vacuously (see "Step kinds").

The Swift CI job spawns a real matron-journal server instance (`node
src/server.js` against a throwaway DB, or the equivalent test harness in
this repo) and points its own matcher/runner at `test/fixtures/conformance/*.json`
from this repo (vendored or checked out as a submodule/CI artifact) —
whichever is more convenient for that repo's CI; nothing here assumes one
particular mechanism.

## Tooling

All of it is test tooling; nothing changes at runtime.

- **`tools/conformance-server.js <fixture>`** boots a seeded journal for one
  fixture and prints one JSON line, `{fixture, base, bindings, control}`.
  `bindings` are the seed's values (user ids, agent tokens); `control` is a unix
  socket on which admin steps run (`{"op":"admin_revoke_device","device_id":N}`,
  one JSON line each way). A client in any language spawns it and stops it by
  closing stdin. Server overrides are flags, else environment variables, else the
  fixture's `server`: `--max-replay N` (`MATRON_CONFORMANCE_MAX_REPLAY`),
  `--media-max-bytes N` (`MATRON_CONFORMANCE_MEDIA_MAX_BYTES`), `--tmp-db`
  (`MATRON_CONFORMANCE_TMP_DB=1`).
- **The replay coordinator** (`tools/conformance/coordinator.js`, also
  `tools/conformance-server.js --replay <fixture>`) runs every step in order and
  plays every actor the platform under test does not (admin, agent, any other
  client). Bindings are shared across actors. Each actor is a lane; with the
  barrier on (the default) a step waits for every earlier step of the other lanes,
  so a frame an agent step causes is in flight before the client step that
  expects it. `--no-barrier` frees the lanes (to show what the barrier is for).
  It refuses a fixture that fails the schema, skips one whose `since` is newer than
  the client's declared protocol, and skips one that needs a step kind the runner
  does not implement. A failure names the step that failed, and later steps do
  not run.
- **A platform runner** performs only its own actor's steps, through its real
  networking and decoding code. The coordinator spawns it and talks
  newline-delimited JSON on stdio (`tools/conformance/stdio-runner.js` describes
  the messages: `init`, `ready` with a capability list, `step` with the step and
  a snapshot of the bindings, a result with `ok`, an error and the bindings the
  step recorded). `tools/conformance/stub-runner.js` is a minimal runner that
  plays only the client role; `tools/conformance/actor.js` is the Node reference.
  A runner that implements no model or notification hook leaves out
  `set_app_state`, `expect_model` and `expect_notification`, and fixtures using
  them are skipped for it. The decoder extracts are not mined from a fixture whose
  muting is an app's own write (`set_app_state` with `muted`): only an app causes
  the frames it shows.
- **Decoder extracts** are generated, never edited: `npm run conformance:extracts`
  rewrites `payloads/`, `npm run conformance:check` fails if `payloads/` differs
  from a fresh generation (run it in CI). Variable values become stable samples
  (named bindings map to the same number or string everywhere), so two
  generations are byte-identical.
- **The artifact**: `npm run conformance:pack` writes
  `dist/matron-journal-conformance-<version>.tgz` with the fixtures, schema,
  extracts, key table and a manifest (package version, protocol revision, a hash
  of every file). Attach it to a release of this repository; each client pins a
  release.
