#!/usr/bin/env bash
# One-time demo-account seed for the VPS demo journal. Run as matron-demo
# with the journal service already running:
#
#   sudo -u matron-demo DEMO_PASSWORD='...' /opt/matron/journal/deploy/vps/demo/seed-demo.sh
#
# Creates user `demo` + agents mac-studio/homelab, seeds the marketing
# conversations over the real WS protocol, and writes the agent tokens to
# /var/lib/matron-demo/tokens.env for the responder service.
set -euo pipefail

REPO_DIR=/opt/matron/journal
TOKENS_FILE=/var/lib/matron-demo/tokens.env

[ -n "${DEMO_PASSWORD:-}" ] || { echo "set DEMO_PASSWORD" >&2; exit 1; }
if [ -f "$TOKENS_FILE" ] && [ "${1:-}" != "--force" ]; then
  echo "$TOKENS_FILE already exists — demo is seeded. Pass --force to reseed (agents get NEW tokens)." >&2
  exit 1
fi

set -a; . /etc/matron/demo.env; set +a
BASE="http://127.0.0.1:${MATRON_PORT:-9810}"
cd "$REPO_DIR"

# Any HTTP response (even 404) proves the server is up — curl without -f
# only fails on connection errors.
curl -sS -o /dev/null "$BASE/" || {
  echo "journal not reachable on $BASE — start matron-demo-journal first" >&2; exit 1; }

node bin/matron-admin.js user add demo --password "$DEMO_PASSWORD" \
  || node bin/matron-admin.js user passwd demo --password "$DEMO_PASSWORD"

# `agent add` prints the token exactly once — capture it here.
AGENT1=$(node bin/matron-admin.js agent add demo mac-studio | grep -o '[0-9a-f]\{64\}')
AGENT2=$(node bin/matron-admin.js agent add demo homelab | grep -o '[0-9a-f]\{64\}')

CLIENT=$(curl -fsS -X POST "$BASE/login" -H 'content-type: application/json' \
  -d "{\"username\":\"demo\",\"password\":$(node -e 'console.log(JSON.stringify(process.env.DEMO_PASSWORD))'),\"device_name\":\"seeder\"}" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).token))')

umask 077
cat > "$TOKENS_FILE" <<EOF
MATRON_DEMO_AGENT_TOKEN=$AGENT1
MATRON_DEMO_AGENT2_TOKEN=$AGENT2
EOF

MATRON_DEMO_AGENT_TOKEN="$AGENT1" MATRON_DEMO_CLIENT_TOKEN="$CLIENT" \
  node deploy/vps/demo/seed.mjs

echo "seeded. Start the responder: systemctl start matron-demo-responder"
echo "App Review notes: server https://demo.matron.chat, user demo, the DEMO_PASSWORD you chose."
