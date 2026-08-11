#!/data/data/com.termux/files/usr/bin/bash
set -eu

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PID_FILE="$APP_DIR/cloudflared.pid"
URL_FILE="$APP_DIR/quick-tunnel-url.txt"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/cloudflared.log"

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "Missing .env. Run: ./prepare-env.sh"
  exit 1
fi
if grep -Eq '^HAPTIC_CONTROL_TOKEN_SECRET=.*replace-with' .env; then
  echo "Control token secret is not configured. Run: ./prepare-env.sh"
  exit 1
fi
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is missing. Run: pkg install cloudflared"
  exit 1
fi

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "Quick Tunnel is already running with PID $PID."
    if [ -f "$URL_FILE" ]; then cat "$URL_FILE"; fi
    exit 0
  fi
  rm -f "$PID_FILE" "$URL_FILE"
fi

PORT="$(sed -n 's/^HAPTIC_RELAY_PORT=//p' .env | tail -n 1)"
if [ -z "$PORT" ]; then PORT=4174; fi

mkdir -p "$LOG_DIR"
: >"$LOG_FILE"
nohup cloudflared tunnel --config /dev/null --no-autoupdate --url "http://127.0.0.1:$PORT" >>"$LOG_FILE" 2>&1 &
TUNNEL_PID=$!
echo "$TUNNEL_PID" >"$PID_FILE"

URL=""
ATTEMPT=0
while [ "$ATTEMPT" -lt 30 ]; do
  URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_FILE" | tail -n 1 || true)"
  if [ -n "$URL" ]; then break; fi
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then break; fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done

if [ -z "$URL" ]; then
  echo "Quick Tunnel URL was not issued."
  tail -n 40 "$LOG_FILE" || true
  kill "$TUNNEL_PID" 2>/dev/null || true
  rm -f "$PID_FILE"
  exit 1
fi

sed -i "s|^HAPTIC_PUBLIC_RELAY_URL=.*|HAPTIC_PUBLIC_RELAY_URL=$URL|" .env
printf '%s\n' "$URL" >"$URL_FILE"

if [ -f relay.pid ] && kill -0 "$(cat relay.pid)" 2>/dev/null; then
  ./restart.sh
else
  ./start.sh
fi

echo "Quick Tunnel ready: $URL"
