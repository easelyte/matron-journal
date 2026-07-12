# Protocol conformance fixtures (spec §12)

Golden JSON exchanges for matron-journal's wire protocol (`POST /login`,
`GET /snapshot`, `GET /convo/:id/messages`, `POST`/`GET /media`,
`POST /password`, `GET /metrics`, and the `/ws` socket). Each file here is
one canonical scenario, replayed against a **real, freshly-started,
in-process server** by the committed runner, `test/conformance.test.js`
(`npm test` runs it along with everything else).

The point of this suite: two independent client implementations (the Node
runner in this repo, and the Matron Swift client's test target) can both
replay the same fixtures against a local server instance and assert
byte-for-byte agreement on every exchange, so the protocol can't quietly
drift out from under either implementation. `test/conformance.test.js` is
the **reference implementation** of the matcher described below — a Swift
harness re-implements the same four rules (they're deliberately small; see
"Porting to Swift" at the bottom).

Fixtures are **hand-shaped, not generated**: write them by driving a local
server and a real client (or `test/helpers.js`) and capturing the actual
exchange, then trim it down to the essential shape. There is no fixture
generator committed to this repo — that would just be another thing that
could silently drift from the runner.

## File format

One JSON file per scenario:

```jsonc
{
  "name": "human-readable scenario name",
  "description": "one or two sentences: what this proves and why",

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
    "users":         [{ "as": "dan", "name": "dan", "password": "..." }],
    "agents":        [{ "as": "bridge", "user": "dan", "name": "dev-2" }],
    "conversations": [{ "id": "c1", "owner": "dan", "title": "T", "sessionState": "running" }],
    "events":        [{ "convo": "c1", "sender": "agent:a", "type": "text", "payload": { "body": "hi" } }]
  },

  // The exchange under test, executed in order. See "Step kinds" below.
  "steps": [ /* ... */ ]
}
```

Seeding an `as: "dan"` user automatically binds `dan.user_id`; seeding an
`as: "bridge"` agent binds `bridge.token` and `bridge.device_id` (agent
tokens are minted at seed time, unlike client tokens, which only exist after
a `POST /login` step — see "Bindings" below). `seed.events[].convo` must
name a conversation already listed in `seed.conversations`; its owner is
inferred from that conversation, not repeated per event.

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
- **`ws_expect`** — `{kind, conn, frame}`. Waits for and consumes the next
  unconsumed frame on that connection (frames are asserted **in arrival
  order, per connection** — each connection has its own FIFO cursor), and
  matches it against `frame`.
- **`ws_expect_none`** — `{kind, conn, ms?}`. Asserts no new frame arrives
  on that connection within `ms` (default 200) — used to prove something is
  *not* delivered (e.g. ephemerals to a non-viewing device, a deduped
  resend).
- **`ws_expect_close`** — `{kind, conn, code?}`. Waits for the connection to
  close; if `code` is given, asserts the WS close code matches.
- **`wait`** — `{kind, ms}`. A plain pause, for the handful of exchanges
  that are genuinely timing-observable server-side (e.g. `ack` advancing a
  device's cursor row, which has no dedicated confirmation frame).
- **`admin_revoke_device`** — `{kind, device_id}`. **Not a wire message** —
  this is what `matron-admin device revoke <id>` does under the hood
  (delete the `devices` row). It exists so a fixture can construct the
  precondition for testing the protocol's *reaction* to revocation (the next
  frame on that device's connection gets `{code:'revoked'}` + close 4001).
  A Swift harness driving its own local server instance can satisfy this
  step however is convenient for it (shell out to `matron-admin`, or touch
  its own test DB directly) — the fixture only specifies *what* out-of-band
  operational action occurred, never *how*.

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
`dan.user_id`, `bridge.token` — steps are free to use flat names like
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
`test/conformance.test.js`) — deliberately small enough to re-implement in
an afternoon:

1. Load a fixture, walk `seed` calling the equivalent local setup.
2. Walk `steps` in order, dispatching on `kind`.
3. For `expect`/`ws_expect` matching: recursively compare, special-casing
   objects with exactly the keys `$bind`/`$ref`/`$type`/`$ignore` as
   described above, exact-key-set otherwise.
4. For outbound (`body`, `frame`, `token`) resolution: recursively replace
   `{"$ref": "name"}` nodes with the bound value; everything else passes
   through unchanged.

The Swift CI job spawns a real matron-journal server instance (`node
src/server.js` against a throwaway DB, or the equivalent test harness in
this repo) and points its own matcher/runner at `test/fixtures/conformance/*.json`
from this repo (vendored or checked out as a submodule/CI artifact) —
whichever is more convenient for that repo's CI; nothing here assumes one
particular mechanism.
