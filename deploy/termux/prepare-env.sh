#!/data/data/com.termux/files/usr/bin/bash
set -eu

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$APP_DIR"

if [ ! -f .env ]; then
  cp .env.phone.example .env
fi

node -e "const fs=require('node:fs');const crypto=require('node:crypto');const file='.env';const input=fs.readFileSync(file,'utf8');const output=input.replace('replace-with-64-character-random-secret',crypto.randomBytes(32).toString('hex'));fs.writeFileSync(file,output);"

if grep -Eq '^HAPTIC_CONTROL_TOKEN_SECRET=.*replace-with' .env; then
  echo "Failed to generate the control token secret."
  exit 1
fi

chmod 600 .env
chmod +x prepare-env.sh start.sh stop.sh restart.sh start-quick-tunnel.sh stop-quick-tunnel.sh health-check.sh
echo "Environment prepared. The tunnel URL will be filled automatically."
