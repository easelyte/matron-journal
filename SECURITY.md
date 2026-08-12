# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's **"Report a vulnerability"** button under this
repository's **Security** tab (Security Advisories → Report a vulnerability).
This opens a private channel with the maintainers.

Please include enough to reproduce: affected version/commit, a description of the
issue, and a proof of concept or the request/frames that trigger it. If you have
a suggested fix, include it — but a clear report is enough.

We aim to acknowledge a report within a few days and to agree a disclosure
timeline with you once the issue is confirmed. Please give us a reasonable window
to ship a fix before any public disclosure.

## Scope

matron-journal is the server: HTTP + WebSocket API, SQLite persistence, media
blobs, APNs push, and the `matron-admin` CLI. In scope:

- Authentication / session-token handling and device revocation
- Cross-user data access (one user reading or writing another user's
  conversations, media, devices, or metrics)
- Agent/client authorization on WebSocket ops (an agent or client performing an
  op it should not be allowed to)
- Injection, path traversal, or resource-exhaustion reachable over the API
- The pairing (device-authorization) flow

## Out of scope / by design

These are known, deliberate design choices rather than vulnerabilities:

- **The server trusts the `cf-connecting-ip` header.** This is safe *only* behind
  a trusted proxy (e.g. Cloudflare) terminating in front of a loopback bind. The
  server logs a loud warning at boot if bound to a non-loopback address. Running
  it directly exposed to untrusted clients is a misconfiguration, not a server bug.
- **Per-username login lockout** can be used to lock out a known username (a
  denial of service against that account). This is an intentional brute-force
  tradeoff; deployments exposing usernames publicly should weigh it.
- Aggregate `/metrics` counters (row counts, DB size, connection count) are
  visible to any authenticated device.

Vulnerabilities in the pinned dependencies (`better-sqlite3`, `ws`, `argon2`)
should be reported upstream, but let us know so we can bump the pin.
