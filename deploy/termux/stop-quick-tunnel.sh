#!/data/data/com.termux/files/usr/bin/bash
set -eu

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PID_FILE="$APP_DIR/cloudflared.pid"
URL_FILE="$APP_DIR/quick-tunnel-url.txt"

cd "$APP_DIR"
./stop.sh

if [ ! -f "$PID_FILE" ]; then
  rm -f "$URL_FILE"
  echo "Quick Tunnel is not running."
  exit 0
fi

PID="$(cat "$PID_FILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  rm -f "$PID_FILE" "$URL_FILE"
  echo "Removed a stale Quick Tunnel PID file."
  exit 0
fi

CMDLINE="$(tr '\000' ' ' <"/proc/$PID/cmdline" 2>/dev/null || true)"
case "$CMDLINE" in
  *cloudflared*) ;;
  *)
    echo "PID $PID does not belong to cloudflared; refusing to stop it."
    exit 1
    ;;
esac

kill "$PID"
ATTEMPT=0
while kill -0 "$PID" 2>/dev/null && [ "$ATTEMPT" -lt 20 ]; do
  sleep 0.25
  ATTEMPT=$((ATTEMPT + 1))
done
if kill -0 "$PID" 2>/dev/null; then kill -KILL "$PID"; fi

rm -f "$PID_FILE" "$URL_FILE"
echo "Quick Tunnel stopped."
