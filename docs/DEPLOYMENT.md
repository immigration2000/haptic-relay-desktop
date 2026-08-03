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

```text
GET /metrics
```

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
