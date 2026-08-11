# Haptic Relay App Relay Deployment

## Goal

The desktop app relay is separate from the website's low-latency hardware backend. The app relay prioritizes external-platform compatibility, room control, predictable fanout, and independent cost/latency tuning.

## MVP Deployment

Use one Node.js relay process per region.

```text
Desktop App
  -> HTTPS Control API on the relay process
  -> WebSocket-only Socket.IO relay on the same process
  -> Viewer apps in the assigned room
```

This is the current deployable shape:

- one process serves Control API and Relay Node
- room metadata uses memory for local tests or Redis for hosted runs
- motion frames stay in the relay process memory
- Redis is only for room metadata and relay assignment
- no Redis/Postgres/Kafka on the motion hot path

## Production Environment

Required:

```text
NODE_ENV=production
HAPTIC_RELAY_PORT=4174
HAPTIC_RELAY_HOST=0.0.0.0
HAPTIC_PUBLIC_RELAY_URL=https://relay.example.com
HAPTIC_RELAY_NODE_ID=relay-seoul-1
HAPTIC_CONTROL_TOKEN_SECRET=<32+ char random secret>
HAPTIC_ROOM_REGISTRY_DRIVER=redis
HAPTIC_REDIS_URL=redis://redis:6379
HAPTIC_ROOM_TTL_SECONDS=28800
HAPTIC_MAX_VIEWERS_PER_ROOM=500
HAPTIC_RELAY_MAX_HZ=30
HAPTIC_RELAY_BURST_FRAMES=2
HAPTIC_HOST_RECONNECT_GRACE_MS=15000
HAPTIC_METRICS_TOKEN=<32+ char separate random secret>
HAPTIC_CONTROL_RATE_WINDOW_MS=60000
HAPTIC_ROOM_CREATE_RATE_LIMIT=10
HAPTIC_ROOM_JOIN_RATE_LIMIT=300
HAPTIC_TRUST_CF_CONNECTING_IP=false
```

For a single MVP node, `HAPTIC_RELAY_NODES` can be omitted. For multiple nodes:

```text
HAPTIC_RELAY_NODES=[{"id":"relay-seoul-1","url":"https://relay-seoul-1.example.com","maxViewers":500},{"id":"relay-seoul-2","url":"https://relay-seoul-2.example.com","maxViewers":500}]
```

## Build And Run

Local production command:

```powershell
npm.cmd run build:server
npm.cmd run server:start
```

## Android Termux Demo Relay

Build the phone-only artifact on the development PC:

```powershell
npm.cmd run package:termux
```

The command creates the unpacked `release/termux-server` directory plus a versioned `.tar.gz` archive and `.sha256` checksum file in `release`. The bundle contains compiled server code, a lockfile with only the Socket.IO runtime dependency, a production environment template, and PID-based Termux operation scripts.

Copy both the archive and checksum file to the Android phone and follow [ANDROID_TERMUX_TRANSFER.md](ANDROID_TERMUX_TRANSFER.md). The phone profile deliberately uses the in-memory room registry, 30 Hz relay rate, a 10-frame jitter burst, and a 50-viewer safety limit. Treat 50 as a configured ceiling, not verified capacity; increase it only after device-specific load testing.

Use a Cloudflare Quick Tunnel only for the first smoke test. Repeated external tests require a Named Tunnel with a fixed HTTPS URL, and that exact URL must be configured as `HAPTIC_PUBLIC_RELAY_URL` before the relay starts.

The Termux artifact is a demo deployment target. The container or hosted Node deployment remains the production path.

Container build:

```powershell
docker build -f Dockerfile.server -t haptic-relay-server:0.1.0 .
```

Container run example:

```powershell
docker run --rm -p 4174:4174 `
  -e NODE_ENV=production `
  -e HAPTIC_PUBLIC_RELAY_URL=https://relay.example.com `
  -e HAPTIC_RELAY_NODE_ID=relay-seoul-1 `
  -e HAPTIC_CONTROL_TOKEN_SECRET=replace-with-long-random-secret `
  -e HAPTIC_ROOM_REGISTRY_DRIVER=memory `
  haptic-relay-server:0.1.0
```

Hosted runs should use Redis instead of memory so room metadata survives process replacement and can be shared with future split Control API processes.

## Health And Metrics

Health:

```text
GET /healthz
```

Metrics snapshot:

```bash
curl -H "Authorization: Bearer $HAPTIC_METRICS_TOKEN" https://relay.example.com/metrics
```

If `HAPTIC_METRICS_TOKEN` is unset, `/metrics` returns `404`. If it is set, requests without the matching Bearer token return `401`. Keep this token separate from `HAPTIC_CONTROL_TOKEN_SECRET`.

Room creation and join routes use independent per-IP fixed-window limits. The defaults are 10 creates and 300 joins per 60 seconds. Set `HAPTIC_TRUST_CF_CONNECTING_IP=true` only when the relay origin is reachable exclusively through Cloudflare Tunnel; otherwise a direct client could forge the header.

Track at minimum:

- room count
- relay node count
- connected viewers per room
- pending approvals
- forwarded frames
- dropped frames
- effective max Hz

## Redis Live Test

Run this before using `HAPTIC_ROOM_REGISTRY_DRIVER=redis` in a hosted environment:

```powershell
$env:HAPTIC_REDIS_URL="redis://localhost:6379"
$env:HAPTIC_ROOM_TTL_SECONDS="60"
npm.cmd run test:redis
```

The test verifies:

- room create
- room read
- host socket attach
- room count/list
- room TTL
- host disconnect cleanup

It requires a real Redis server. If Redis is not running or not installed, the test fails with a connection error.

## Rollout Path

1. Single region, one Node relay process, memory registry for private smoke tests.
2. Single region, one Node relay process, Redis registry for public beta.
3. Multiple Node relay processes, Redis registry, room assignment through `HAPTIC_RELAY_NODES`.
4. Split Control API from Relay Nodes once account auth, billing, moderation persistence, and admin tooling are added.
5. Rewrite Relay Node hot path in Go only after production traffic shows the Node relay is the bottleneck.

## Production Guards

When `NODE_ENV=production`, the server refuses to start if:

- `HAPTIC_CONTROL_TOKEN_SECRET` is missing, too short, or still a default value
- `HAPTIC_PUBLIC_RELAY_URL` still points to localhost
- numeric relay limits are invalid

This keeps obvious deployment mistakes from becoming live rooms.
