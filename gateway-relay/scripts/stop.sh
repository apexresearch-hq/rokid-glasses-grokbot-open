#!/usr/bin/env bash
set -euo pipefail
PIDFILE="${RELAY_LOG_DIR:-$HOME/.prism}/leqi-gateway-relay.pid"
if [ -f "$PIDFILE" ]; then
  pid=$(cat "$PIDFILE")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" || true
    sleep 0.5
    kill -9 "$pid" 2>/dev/null || true
    echo "stopped $pid"
  else
    echo "not running"
  fi
  rm -f "$PIDFILE"
else
  echo "no pidfile"
fi
