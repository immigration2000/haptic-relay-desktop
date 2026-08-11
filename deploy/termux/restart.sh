#!/data/data/com.termux/files/usr/bin/bash
set -eu

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$APP_DIR/stop.sh"
"$APP_DIR/start.sh"
