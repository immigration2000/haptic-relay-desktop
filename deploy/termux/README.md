# Android Termux Relay Deployment

This bundle contains only the compiled Haptic Relay server and its Socket.IO runtime dependency. It is intended for demos and small external tests, not a 500-viewer production broadcast.

## 1. Install Termux Packages

Install Termux from F-Droid. Install Termux:API and Termux:Boot from the same source if they are needed.

```bash
pkg update
pkg upgrade
pkg install nodejs curl openssh termux-api
```

Install `cloudflared` from the available Termux repository or use a compatible Android binary for the phone architecture.

## 2. Install The Relay

Copy this directory to the phone, enter it, and run:

```bash
npm ci --omit=dev --ignore-scripts
chmod +x prepare-env.sh start.sh stop.sh restart.sh start-quick-tunnel.sh stop-quick-tunnel.sh health-check.sh
./prepare-env.sh
```

`prepare-env.sh` creates `.env`, generates the control token secret inside Termux, and does not print it. The public relay URL is filled automatically when Quick Tunnel starts.

The phone profile trusts Cloudflare's `CF-Connecting-IP` header because the relay binds only to `127.0.0.1`. Do not combine this setting with a directly exposed relay port. `/metrics` stays disabled unless a separate `HAPTIC_METRICS_TOKEN` of at least 32 characters is added.

## 3. Get A Temporary External URL

Use this only for the first smoke test because the URL changes and Quick Tunnel has no SLA.

```bash
./start-quick-tunnel.sh
```

The script starts `cloudflared` in the background, saves the issued URL to `quick-tunnel-url.txt`, updates `.env`, and starts the relay. Stop both processes with `./stop-quick-tunnel.sh`.

## 4. Start And Verify

Verify the relay and inspect the URL:

```bash
./health-check.sh
cat quick-tunnel-url.txt
tail -f logs/relay.log
```

Enter the same public HTTPS URL in both desktop apps. Stop or restart the relay with `./stop.sh` or `./restart.sh`.

## 5. Use A Fixed Tunnel

For repeated tests, create a Named Tunnel and DNS route in the Cloudflare dashboard or CLI before starting the relay. Point its service to:

```text
http://127.0.0.1:4174
```

Keep the phone on a charger, disable battery optimization for Termux, and prefer Ethernet or stable 5 GHz Wi-Fi. Validate reconnect behavior after screen-off, network changes, and phone reboot before a live demo.

## Updating

Build a new bundle on the PC, stop the server, replace `dist-server`, run `npm ci --omit=dev --ignore-scripts`, and restart. Keep the phone's `.env` file; never commit or distribute it.
