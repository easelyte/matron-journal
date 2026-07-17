#!/usr/bin/env bash
# Provision (or update) the Matron shared-infra VPS: push relay + demo
# journal behind a cloudflared tunnel. Debian 12 / Ubuntu 24.04, run as
# root. Idempotent — safe to re-run after every git pull.
set -euo pipefail

REPO_DIR=/opt/matron/journal
VPS_DIR="$REPO_DIR/deploy/vps"

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -d "$REPO_DIR/.git" ] || { echo "clone the repo to $REPO_DIR first" >&2; exit 1; }

# --- packages ---------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg build-essential python3 unattended-upgrades

# Node 22 (NodeSource) — engines requires >=20, native deps want a stable ABI.
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1)" != "v22" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

# cloudflared (Cloudflare package repo)
if ! command -v cloudflared >/dev/null; then
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq && apt-get install -y -qq cloudflared
fi

# --- security baseline (mirrors dev-boxer 01_security, minus postfix/exporter) ---
timedatectl set-timezone Etc/UTC

# unattended-upgrades: installing the package is not enough — this file is
# what turns the daily run on. Debian's stock 50unattended-upgrades already
# limits it to security origins.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable unattended-upgrades >/dev/null

# sshd: key-only. Guarded so a box provisioned without a root key can't be
# locked out. Port stays 22 — ufw + fail2ban cover it, and a surprise port
# change on a headless VPS is its own outage.
if [ -s /root/.ssh/authorized_keys ]; then
  cat > /etc/ssh/sshd_config.d/90-matron.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  systemctl reload ssh || systemctl reload sshd
else
  echo ">> no /root/.ssh/authorized_keys — skipping sshd key-only hardening" >&2
fi

# ufw: deny inbound except SSH. Everything else arrives via the cloudflared
# tunnel (outbound-only), so no service ports are ever opened.
apt-get install -y -qq ufw
if ! ufw status | grep -q 'Status: active'; then
  ufw default deny incoming
  ufw default allow outgoing
fi
ufw allow 22/tcp comment 'SSH' >/dev/null
ufw --force enable >/dev/null

# fail2ban: Debian 12 minimal has no auth.log (no rsyslog) — backend must be
# systemd or the sshd jail silently watches a file that never exists.
apt-get install -y -qq fail2ban
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
backend = systemd

[sshd]
enabled = true
port = 22
maxretry = 6
bantime = 300
EOF
systemctl enable fail2ban >/dev/null
systemctl restart fail2ban

# --- users & directories -----------------------------------------------------
for u in matron-relay matron-demo; do
  id "$u" >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin --home-dir /nonexistent --no-create-home "$u"
done
install -d -o root -g root -m 755 /etc/matron /etc/cloudflared
install -d -o root -g matron-relay -m 750 /etc/matron/apns
install -d -o matron-demo -g matron-demo -m 750 /var/lib/matron-demo

# --- app install ---------------------------------------------------------------
cd "$REPO_DIR"
npm ci --omit=dev --no-audit --no-fund

# --- env files (created once; never overwritten — they hold secrets/ids) -----
if [ ! -f /etc/matron/relay.env ]; then
  cat > /etc/matron/relay.env <<'EOF'
MATRON_APNS_KEY_FILE=/etc/matron/apns/key.p8
MATRON_APNS_KEY_ID=FILL_ME_IN
MATRON_APNS_TEAM_ID=FILL_ME_IN
MATRON_APNS_TOPIC=chat.matron.app
MATRON_RELAY_PORT=9821
MATRON_RELAY_BIND=127.0.0.1
EOF
  chown root:matron-relay /etc/matron/relay.env && chmod 640 /etc/matron/relay.env
  echo ">> fill in /etc/matron/relay.env and install the .p8 (see README step 3)"
fi

if [ ! -f /etc/matron/demo.env ]; then
  cat > /etc/matron/demo.env <<'EOF'
MATRON_DB=/var/lib/matron-demo/matron.db
MATRON_PORT=9810
MATRON_BIND=127.0.0.1
# Demo pushes go through the relay on this same box, like any self-hoster.
MATRON_PUSH_GATEWAY_URL=http://127.0.0.1:9821
EOF
  chown root:matron-demo /etc/matron/demo.env && chmod 640 /etc/matron/demo.env
fi

# --- systemd units -------------------------------------------------------------
install -m 644 "$VPS_DIR"/systemd/*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable matron-push-relay matron-demo-journal matron-demo-responder >/dev/null

# Relay only starts once the key exists (ConditionPathExists in the unit).
systemctl restart matron-push-relay matron-demo-journal || true
# Responder needs seeded tokens; started by seed-demo.sh the first time.
systemctl try-restart matron-demo-responder || true

echo "== status =="
systemctl --no-pager --legend=false list-units 'matron-*' 'cloudflared*' || true
echo "done. Next steps if this is a fresh box: README steps 3 (APNs key), 4 (tunnel), 5 (demo seed)."
