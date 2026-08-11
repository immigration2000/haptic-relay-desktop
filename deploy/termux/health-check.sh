#!/data/data/com.termux/files/usr/bin/bash
set -eu

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ENV_FILE="$APP_DIR/.env"
PORT=4174

if [ -f "$ENV_FILE" ]; then
  CONFIGURED_PORT="$(sed -n 's/^HAPTIC_RELAY_PORT=//p' "$ENV_FILE" | tail -n 1)"
  if [ -n "$CONFIGURED_PORT" ]; then PORT="$CONFIGURED_PORT"; fi
fi

curl --fail --silent --show-error "http://127.0.0.1:$PORT/healthz"
echo
