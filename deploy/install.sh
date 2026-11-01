#!/usr/bin/env bash
# One-command install of session-bridge on a Linux (systemd) cloud machine.
#   sudo bash deploy/install.sh          (run from the repo root)
# Re-running is safe: code is re-synced, the env file is never overwritten.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/opt/leqi-grokbot-bridge
ENVF=/etc/leqi-grokbot-bridge.env

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "Installing Node.js 20..."
  if command -v apt-get >/dev/null; then curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
  elif command -v dnf >/dev/null; then curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && dnf install -y nodejs
  else echo "install Node >=18 manually"; exit 1; fi
fi

id leqi-bridge >/dev/null 2>&1 || useradd --system --home "$DEST" --shell /usr/sbin/nologin leqi-bridge
mkdir -p "$DEST"
cp -r "$SRC/session-bridge" "$SRC/reader-preview" "$SRC/prism-plugin-grokbot" "$DEST/"
mkdir -p "$DEST/session-bridge/data"
chown -R leqi-bridge:leqi-bridge "$DEST"

if [ ! -f "$ENVF" ]; then
  TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat > "$ENVF" <<EOT
HOST=127.0.0.1
PORT=8787
DATA_DIR=$DEST/session-bridge/data
BRIDGE_TOKEN=$TOKEN
# Delivery: gateway (local relay claims) | webhook | both
DELIVERY_MODE=gateway
GATEWAY_FALLBACK_MS=60000
PUBLIC_BASE_URL=https://glasses.example.com
# Fill webhook for fallback / webhook mode:
GROKBOT_WEBHOOK_URL=
GROKBOT_WEBHOOK_KEY=
EOT
  chmod 600 "$ENVF"; echo "Created $ENVF (BRIDGE_TOKEN generated). Fill GROKBOT_WEBHOOK_URL/KEY, then: systemctl restart session-bridge"
fi

install -m 644 "$SRC/deploy/session-bridge.service" /etc/systemd/system/session-bridge.service
systemctl daemon-reload
systemctl enable --now session-bridge
systemctl restart session-bridge
sleep 1
curl -fsS http://127.0.0.1:8787/health && echo && echo "session-bridge is up on 127.0.0.1:8787"
