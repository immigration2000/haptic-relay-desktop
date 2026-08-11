#!/data/data/com.termux/files/usr/bin/bash
set -eu

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PID_FILE="$APP_DIR/relay.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "Relay server is not running."
  exit 0
fi

PID="$(cat "$PID_FILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "Removed a stale PID file."
  exit 0
fi

CMDLINE="$(tr '\000' ' ' <"/proc/$PID/cmdline" 2>/dev/null || true)"
case "$CMDLINE" in
  *dist-server/server/src/relay-server.js*) ;;
  *)
    echo "PID $PID does not belong to this relay server; refusing to stop it."
    exit 1
    ;;
esac

kill "$PID"
ATTEMPT=0
while kill -0 "$PID" 2>/dev/null && [ "$ATTEMPT" -lt 20 ]; do
  sleep 0.25
  ATTEMPT=$((ATTEMPT + 1))
done

if kill -0 "$PID" 2>/dev/null; then
  kill -KILL "$PID"
fi

rm -f "$PID_FILE"
if command -v termux-wake-unlock >/dev/null 2>&1; then
  termux-wake-unlock || true
fi
echo "Relay server stopped."
