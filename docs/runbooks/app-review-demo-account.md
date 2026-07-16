# Runbook: App Review demo account

App Store review (guideline 2.1) requires a working demo login for as long as
the app is on the store — every update is reviewed against it, and Apple
occasionally re-reviews live apps. This runbook sets up a journal account that
stays demonstrable with no human attached: a seeded conversation plus
`tools/demo-agent.js`, a small auto-reply agent that answers every message
with one fixed reply and services the app's `start` / `recent_folders` RPCs
so the new-session flow works too.

The server needs no changes and never learns the account is a demo: the agent
is an ordinary agent device speaking the public protocol, exercising the same
auth, ownership, and push paths as a real bridge.

Paths below assume the reference deployment (`/opt/matron-journal`, user
`matron` — see `hardening.md`); adjust for your layout.

## One-time setup

```
# 1. Create the account (generate a strong password; it goes in
#    App Store Connect → App Review Information, never in this repo)
sudo -u matron env MATRON_DB=/opt/matron-journal/data/matron.db \
  node bin/matron-admin.js user add applereview --password '<generated>'

# 2. Mint the agent device and store its token where the sandboxed unit
#    can read it (ProtectHome=yes blocks /home)
sudo -u matron env MATRON_DB=/opt/matron-journal/data/matron.db \
  node bin/matron-admin.js agent add applereview demo
sudo -u matron install -m 600 /dev/stdin /opt/matron-journal/data/demo-agent.token
  # paste the token, then EOF (ctrl-d)

# 3. Install and start the unit
sudo cp deploy/matron-demo-agent.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now matron-demo-agent
```

## Verify

```
journalctl -u matron-demo-agent -n 3   # expect "connected, head seq N"
curl -s -X POST https://chat.example.com/login \
  -H 'content-type: application/json' \
  -d '{"username":"applereview","password":"<generated>","device_name":"verify"}'
  # expect 200 {token, device_id, user_id}
```

Then log in from a real client, send a message, and confirm the fixed reply
arrives (after a ~1.2 s typing indicator). Revoke the `verify` device
afterwards (`matron-admin device list applereview` → `device revoke <id>`).

## Operational notes

- **Do not casually revoke and re-mint the `demo` agent device.** The agent
  is stateless: every (re)connect replays from cursor 0 and re-offers a reply
  to every user message ever seen, relying on the server's idempotency keys
  (`demo-reply:<seq>`) to dedupe. Dedup state is tied to the device row — a
  fresh device double-replies to the whole backlog on its first replay. If
  you must rotate the token, expect one duplicate reply per historical user
  message, or start a fresh account.
- The canned reply can be changed without touching code: set
  `MATRON_DEMO_REPLY` in the unit and restart.
- Password rotation: `matron-admin user passwd applereview --password <new>`,
  then update App Store Connect. Apple rejects updates whose demo credentials
  no longer work.
- The account's journal is append-only like any other; the demo conversation
  history is permanent. That is fine — it is the account's whole purpose.

## Teardown (app leaves the store)

```
sudo systemctl disable --now matron-demo-agent
sudo rm /etc/systemd/system/matron-demo-agent.service /opt/matron-journal/data/demo-agent.token
# matron-admin device list applereview → device revoke <agent id>
```
