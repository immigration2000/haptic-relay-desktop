#!/data/data/com.termux/files/usr/bin/bash
set -eu

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PID_FILE="$APP_DIR/relay.pid"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/relay.log"

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "Missing .env. Run: cp .env.phone.example .env"
  exit 1
fi

if grep -Eq '^HAPTIC_PUBLIC_RELAY_URL=.*replace-with|^HAPTIC_CONTROL_TOKEN_SECRET=.*replace-with' .env; then
  echo "Replace the placeholder URL and token secret in .env before starting."
  exit 1
fi

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "Relay server is already running with PID $PID."
    exit 1
  fi
  rm -f "$PID_FILE"
fi

mkdir -p "$LOG_DIR"
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock || true
fi

nohup node --env-file=.env dist-server/server/src/relay-server.js >>"$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" >"$PID_FILE"
sleep 2

if ! kill -0 "$PID" 2>/dev/null; then
  echo "Relay server failed to start."
  tail -n 40 "$LOG_FILE" || true
  rm -f "$PID_FILE"
  exit 1
fi

echo "Relay server started with PID $PID. Log: $LOG_FILE"
