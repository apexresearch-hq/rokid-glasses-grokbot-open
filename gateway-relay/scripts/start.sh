#!/usr/bin/env bash
# Start gateway-relay in background with a clean env (no e2e PORT/DATA_DIR leak).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${RELAY_LOG_DIR:-$HOME/.prism}"
mkdir -p "$LOG_DIR"
PIDFILE="$LOG_DIR/leqi-gateway-relay.pid"
LOGFILE="$LOG_DIR/leqi-gateway-relay.log"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running pid=$(cat "$PIDFILE")"
  exit 0
fi

# Secrets
if [ -z "${BRIDGE_TOKEN:-}" ] && [ -f "$HOME/.secrets/leqi-bridge-token" ]; then
  BRIDGE_TOKEN="$(tr -d '\n' < "$HOME/.secrets/leqi-bridge-token")"
fi
if [ -z "${SESSION_BRIDGE_URL:-}" ] && [ -f "$HOME/.secrets/leqi-bridge-url" ]; then
  SESSION_BRIDGE_URL="$(tr -d '\n' < "$HOME/.secrets/leqi-bridge-url")"
fi
: "${BRIDGE_TOKEN:?BRIDGE_TOKEN missing}"
: "${SESSION_BRIDGE_URL:?set SESSION_BRIDGE_URL e.g. https://glasses.example.com}"

# Drop local e2e / bridge-server vars that must not affect the relay client
unset PORT DATA_DIR HOST DELIVERY_MODE GATEWAY_FALLBACK_MS GROKBOT_WEBHOOK_URL GROKBOT_WEBHOOK_KEY PUBLIC_BASE_URL 2>/dev/null || true

cd "$ROOT"
# Use env -i-ish clean subset via explicit env
nohup env -u PORT -u DATA_DIR -u HOST -u DELIVERY_MODE -u GATEWAY_FALLBACK_MS \
  BRIDGE_TOKEN="$BRIDGE_TOKEN" \
  SESSION_BRIDGE_URL="$SESSION_BRIDGE_URL" \
  CLAIM_WAIT_MS="${CLAIM_WAIT_MS:-15000}" \
  HOME="$HOME" \
  PATH="$PATH" \
  node relay.js >>"$LOGFILE" 2>&1 &
echo $! >"$PIDFILE"
echo "started pid=$(cat "$PIDFILE") log=$LOGFILE bridge=$SESSION_BRIDGE_URL"
