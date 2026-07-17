# Matron shared-infra VPS: push relay + demo journal

Provisions one small VPS (Hetzner CX22 / CAX11 class, Debian 12 or Ubuntu
24.04) to run the two pieces of Matron infrastructure that should not live
on a personal machine:

- **push.matron.chat** — the push relay (`bin/matron-push-relay.js`). Holds
  the APNs key for `chat.matron.app`; forwards content-blind pushes for
  self-hosted journals.
- **demo.matron.chat** — a demo journal seeded with fake conversations, for
  App Review's demo account and product screenshots. Isolated database,
  separate unix user, no real data anywhere near it.

Both are loopback-bound and reach the internet only through a cloudflared
tunnel — the VPS needs **no open inbound ports** except SSH.

## Layout on the box

```
/opt/matron/journal            this repo (root-owned checkout, npm ci --omit=dev)
/etc/matron/relay.env          relay env  (root:matron-relay, 640)
/etc/matron/demo.env           demo env   (root:matron-demo,  640)
/etc/matron/apns/key.p8        APNs .p8   (root:matron-relay, 640)
/var/lib/matron-demo/          demo journal db + seeded tokens (matron-demo)
/etc/cloudflared/config.yml    tunnel ingress (see cloudflared-config.yml.example)
```

`matron-relay` and `matron-demo` are system users with no shell. The APNs
key is readable by the relay user only — the demo journal (the larger
attack surface: HTTP + WS API) cannot read it.

## One-time setup

1. **Create the VPS** (Debian 12 / Ubuntu 24.04, smallest tier is plenty)
   with your SSH key. Everything below runs on the box as root.

2. **Provision:**

   ```bash
   git clone https://github.com/Matronhq/matron-journal /opt/matron/journal
   /opt/matron/journal/deploy/vps/setup.sh
   ```

   Idempotent — re-run it after `git pull` to update code + units.

3. **APNs key** (from wherever it currently lives — scp directly, never
   through chat):

   ```bash
   install -o root -g matron-relay -m 640 /path/to/AuthKey_XXXXXXXXXX.p8 /etc/matron/apns/key.p8
   ```

   Then fill in `MATRON_APNS_KEY_ID` / `MATRON_APNS_TEAM_ID` in
   `/etc/matron/relay.env` and `systemctl restart matron-push-relay`.

4. **Tunnel.** Create it from any machine that has a cloudflared origin
   cert for the account (`cloudflared tunnel login`):

   ```bash
   cloudflared tunnel create matron-vps
   cloudflared tunnel route dns matron-vps push.matron.chat
   cloudflared tunnel route dns matron-vps demo.matron.chat
   scp ~/.cloudflared/<TUNNEL-UUID>.json root@<vps>:/etc/cloudflared/credentials.json
   ```

   On the VPS: copy `cloudflared-config.yml.example` to
   `/etc/cloudflared/config.yml`, set the tunnel UUID, then
   `cloudflared service install && systemctl start cloudflared`.

5. **Seed the demo account:**

   ```bash
   sudo -u matron-demo DEMO_PASSWORD='<pick one>' /opt/matron/journal/deploy/vps/demo/seed-demo.sh
   systemctl start matron-demo-responder
   ```

   Creates user `demo` with two agents (`mac-studio`, `homelab`), seeds the
   marketing conversations, and stores the agent tokens in
   `/var/lib/matron-demo/tokens.env` for the responder service. The
   password is what goes in App Store Connect's App Review notes, with
   server `https://demo.matron.chat`.

6. **Cloudflare rate-limit rule** (dashboard or API): on the zone, limit
   `push.matron.chat` to ~30 requests/10s per IP, block on exceed. Legit
   journals send low single-digit pushes per minute from one IP; this
   neuters token-spray floods before they reach the box. (The relay also
   has an in-process global ceiling — 50/s sustained — as the APNs-side
   backstop.)

## Updating

```bash
cd /opt/matron/journal && git pull && deploy/vps/setup.sh
```

(`setup.sh` re-runs `npm ci` and restarts the services.)

## Journal-side config (self-hosters)

A self-hosted journal points at the relay with one env var:

```
MATRON_PUSH_GATEWAY_URL=https://push.matron.chat
```

The demo journal on this box does the same via loopback
(`http://127.0.0.1:9821`) — already set in `demo.env`.
