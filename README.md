# matron-journal

Journal server for the Matron chat system: a thin, server-authoritative
replacement for the Matrix stack used by the Claude bridge.
Spec: docs/superpowers/specs/2026-07-10-matron-protocol-design.md

## Run

    npm install
    MATRON_DB=./matron.db MATRON_PORT=9810 npm start

## Admin

    MATRON_DB=./matron.db npx matron-admin user add dan --password '...'
    MATRON_DB=./matron.db npx matron-admin agent add dan dev-2
    MATRON_DB=./matron.db npx matron-admin status

## Protocol (v1 core)

- `POST /login {username, password, device_name}` -> `{token, device_id, user_id}`.
  Brute-force protection: 5 attempts/min per IP (429 `rate_limited`), plus per-username
  lockout after 5 consecutive failures — 30s doubling per failure up to 1h, cleared by
  a successful login (429 `locked_out` with `retry_after` seconds + `Retry-After` header).
- `GET /snapshot` (Bearer) -> `{conversations, seq}`
- `GET /convo/:id/messages?before_seq&limit` (Bearer) -> `{events}`
- `POST /media` (Bearer, client or agent) -> raw request body streamed to disk;
  `{media_id, size, content_type, sha256}`. Content-Type header captured
  (default `application/octet-stream`). 400 `{error:'empty'}` on a zero-byte
  body; 413 `{error:'too_large'}` over `MATRON_MEDIA_MAX_BYTES` (default 50 MB).
  Storage root: `MATRON_MEDIA_DIR` env or `<dirname of the db file>/media`,
  sharded `<root>/<id[0:2]>/<id>`.
- `GET /media/:id` (Bearer) -> streams the blob with its Content-Type,
  Content-Length and a long-lived `Cache-Control` (ids are immutable random
  handles). Owner-only; missing or not-owned are indistinguishable, both
  404 `{error:'not_found'}`.
- `WS /ws`: first frame `{op:'hello', token, cursor}` (cursor null = live-only).
  Server: `hello_ok {seq}`, then journal frames `> cursor`, then live.
  Client ops: send, prompt_reply, read_marker, ack, viewing.
  Agent ops: convo_upsert, publish, stream (ephemeral), finalize.

## Test

    npm test

Deferred to v1 completion: APNs push, retention offload, /metrics,
conformance fixtures (see the spec, §15 and plan docs).
