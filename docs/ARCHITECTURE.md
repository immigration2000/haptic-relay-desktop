# Architecture

## Boundary

Haptic Relay extracts hardware control from the live-streaming website. The live video platform remains responsible only for video, chat, and room promotion. The desktop app owns hardware connection and user workflows. The relay server owns room identity, access control, and motion-frame relay.

## Components

- `electron/main.ts`: native desktop shell, IPC registration, app lifecycle.
- `electron/services/hardware-controller.ts`: serial hardware access and normalized motion output.
- `electron/services/tcode-encoder.ts`: converts normalized motion frames to OSR/SR6 compatible T-Code lines.
- `electron/services/relay-client.ts`: Socket.IO client used by the desktop app.
- `electron/services/motion-delay-buffer.ts`: bounded FIFO for viewer motion delayed by local receipt time.
- `server/src/relay-server.ts`: standalone Socket.IO relay server for rooms and motion frames.
- `server/src/control-token.ts`: HMAC signed token helper for host/viewer relay authorization.
- `server/src/room-registry.ts`: room metadata registry and relay node assignment boundary.
- `src/App.tsx`: renderer UI for host and viewer workflows.
- `src/shared/protocol.ts`: shared room and motion protocol types.

## Roles

- Host: creates a room, chooses entry mode, connects source hardware, publishes motion frames.
- Viewer: enters a room, connects receiver hardware, receives motion frames, writes hardware commands.

## MVP Data Flow

```text
Host hardware -> Desktop app -> Relay server -> Viewer desktop app -> Viewer hardware
```

For local testing, run the relay server on `localhost:4174`. For production, deploy this relay server separately from the website's low-latency in-site hardware sync backend.

## Motion Sequence Handling

The host desktop app assigns a uint32 sequence only when a motion frame is actually flushed to the socket. Samples replaced by the local latest-frame policy do not consume sequence numbers and therefore do not appear as network loss.

The viewer relay client validates V2 sequences before handing frames to the hardware queue:

- first and forward-moving sequences are accepted;
- duplicate and out-of-order sequences are dropped;
- forward gaps increment the estimated lost-frame counter;
- wraparound from `4294967295` to `0` is treated as forward progress;
- legacy V1 input is assigned a forwarding sequence by the relay server.

Current receive metrics are `receivedFrames`, `acceptedFrames`, `duplicateFrames`, `outOfOrderFrames`, `lostFrames`, and `lastSequence`. Renderer quality indicators can consume these counters in a later UI step.

## Viewer Motion Delay

The viewer receive path is:

```text
decode -> sequence filter -> local receipt-time delay queue -> hardware queue
```

The local delay accepts `0-10000ms` in `100ms` steps. Its default is `0ms`, and unversioned or schema-v1 settings migrate to `0ms`. A configured delay change and session or safety events clear queued frames so stale motion cannot cross those boundaries. Delays of at least `100ms` use receipt-time-based `30Hz` linear interpolation for source gaps up to `250ms`; the viewer does not synthesize motion across larger gaps or extrapolate beyond the newest real frame.

## Hardware Motion Lifecycle

Normal room motion is stateful: an unchanged streamer value or temporary packet inactivity leaves the device at its last commanded position. There is no inactivity-triggered stop-position command. Receive pause independently blocks new frames without moving the device.

The configured absolute stop position is reserved for room exit and emergency stop:

```text
valid room frame -> emergency-latch gate -> receive-pause gate -> hardware queue

room leave / in-room app exit -> stopForRoomExit() -> DSTOP + absolute position
local or room-wide emergency -> latchEmergencyStop() -> DSTOP + absolute position + local latch
local explicit release -> releaseEmergencyStop() -> no serial output, no relay release
hardware disconnect -> block pending output -> bounded DSTOP + absolute position attempt -> close serial port
```

The emergency latch is runtime-local and independent from receive pause. Production motion admission checks the emergency latch before applying receive protection; changing either state never changes the other. A room-wide stop latches each connected participant, but the relay protocol has no release event: each participant must press **긴급정지 해제** locally. Releasing the latch sends no motion, so only a later valid streamer frame may move the device. Hardware disconnect/reconnect and room leave/rejoin do not release the latch; a full application restart initializes it as released.

## Control Plane

The current Node process serves both the Control API and Relay Node so local development stays simple. The API contract is intentionally separable.

```text
POST /api/rooms
  -> create room metadata
  -> assign relay node
  -> return hostToken + relayNodeId + relayUrl

POST /api/rooms/:roomName/join
  -> validate password and room capacity
  -> return viewerToken + relayNodeId + relayUrl

Socket.IO room:create/viewer:join
  -> verify signed token
  -> bind socket to room
```

Production should split the Control API from Relay Nodes once account auth, billing, and moderation are added.

## Room Assignment

`room-registry.ts` supports in-memory and Redis-backed registries. Redis stores room metadata and relay assignment, while high-frequency motion state stays in the relay node's active room cache.

```text
Room create -> RelayDirectory.chooseNode() -> RoomRecord(relayNodeId, relayUrl)
```

Do not move motion frames through Redis. Redis is control-plane storage here, not a realtime media bus.

## Server Split Rationale

The website hardware feature and the external-platform desktop app should not share the same realtime path.

- Website path: optimized for lowest possible latency, tight platform integration, controlled environment.
- Desktop app path: optimized for compatibility across PandaTV and other platforms, easier onboarding, separate scaling and rate limits.
- Shared protocol: motion frame shape and hardware adapters can stay compatible across both products.
- Separate infrastructure: latency budgets, relay geography, logging, moderation, and cost controls can diverge without hurting the website experience.

## Production Server Language Base

The MVP server stays in Node.js because the desktop app, Control API, and Socket.IO client are already moving quickly in TypeScript. The production realtime relay should move to Go once traffic and deployment shape are clear.

Recommended split:

```text
Control API: TypeScript or Go
Relay Node: Go
Device Protocol Gateway: Go first, Rust later only for specialized native protocol work
Analytics / Session Logs: TypeScript workers or Go batch consumers
```

Why Go for the relay node:

- The hot path is high-concurrency network I/O, not complex CPU computation.
- A room maps cleanly to a goroutine-owned state loop: one room actor receives host frames and broadcasts to viewer sessions.
- Go binaries deploy simply as one process per relay node.
- The standard library and runtime make connection-heavy services straightforward to operate.
- Team velocity is better than Rust for the first production relay.

Why not keep Node.js as the long-term relay core:

- Node is fine for the MVP and Control API, but the motion fanout hot path should not share one event loop with JSON control routes, metrics, auth checks, logs, and future moderation work.
- Worker threads help CPU-heavy work, not ordinary async I/O. The relay bottleneck is connection fanout, queue policy, and per-room scheduling.
- TypeScript remains useful at the edge: desktop app, admin UI, room management, dashboards, and non-hot-path APIs.

Why not start with Rust:

- Rust + Tokio is a strong fit for a future ultra-low-latency relay, binary protocol gateway, or device-specific protocol engine.
- It is more expensive to build and maintain while the room model, pricing, moderation, and deployment topology are still changing.
- Use Rust later when profiling proves Go is the bottleneck or when memory safety around native protocol parsing becomes the main risk.

## Production Server Topology

The production system should split control-plane work from motion-plane work.

```text
Desktop App
  |
  | HTTPS create/join
  v
Control API
  - auth / accounts later
  - room create / join
  - password / approval policy
  - relay node assignment
  - signed token issue
  |
  | signed host/viewer token + relayUrl
  v
Go Relay Node
  - WebSocket only
  - token verification
  - room-local state
  - binary motion fanout
  - emergency stop fanout
  - viewer kick/block for active session
  |
  v
Viewer Desktop Apps -> Serial T-Code hardware output
```

Do not route motion frames through Redis, Postgres, Kafka, or a generic message broker in the first production design. Use those for room metadata, audit logs, billing events, and metrics. The motion hot path should stay in memory on the relay node that owns the room.

## Go Relay Node Shape

Target packages:

```text
cmd/relay-node
  process startup, config, health server

internal/transport/ws
  WebSocket accept loop, ping/pong, binary frame read/write

internal/relay
  room actor, viewer session, host session, fanout policy

internal/protocol
  V2 20-byte motion packet, legacy V1 decoder, stop event, join/control messages

internal/auth
  HMAC token verification compatible with current Control API tokens

internal/metrics
  Prometheus counters, room gauges, event loop/runtime stats
```

Room actor model:

```text
Host socket read loop
  -> decode V2 motion packet or legacy V1 packet
  -> room inbox channel, latest-frame wins
  -> room actor rate gate
  -> nonblocking write to viewer send queues
  -> slow viewer drops old motion frames
```

Each viewer should have a bounded send queue of size 1-2 for motion frames. If a viewer cannot keep up, replace the queued motion frame with the newest one. Never let one viewer create room-level latency.

Use a separate reliable control channel path for:

- join result
- approval result
- kick/block
- emergency stop

Emergency stop is not normal motion. It must clear pending motion and be delivered as a distinct control event.

## Latency Policy

The app relay optimizes for stable perceived motion rather than guaranteed delivery of every frame. Motion frames are transient state, so the newest frame is more valuable than a delayed backlog.

- WebSocket-only transport avoids long-polling overhead.
- Compression is disabled for tiny motion frames.
- Motion frames use a 20-byte V2 binary packet instead of JSON.
- Motion broadcasts use volatile events so slow clients drop stale frames.
- Server-side token bucket max Hz protects viewers, devices, and relay cost without over-dropping timer jitter.
- Desktop-side coalescing keeps serial hardware and network output from building queues.

## Hardware Protocol

The relay protocol and hardware protocol are intentionally different.

- Relay payload: 20-byte V2 binary packet derived from normalized app-level `MotionFrame`; legacy 4-byte V1 packets are accepted for compatibility.
- Hardware output: T-Code ASCII over UART serial.
- Default output axis: `L0`, matching OSR/SR6 stroke control.
- Optional output axis: `V0` can map normalized intensity to vibration when a connected device supports it.
- Example: position `0.42` with a 16ms interval becomes `L04200I16\n`.

## Local Diagnostic Storage

Release 11 always writes sanitized JSONL diagnostics locally beneath Electron `userData/logs`. Every hardware motion sample is recorded at the 30 Hz output cadence; the active `haptic-relay.jsonl` file plus `.1` through `.15` are capped at 16 MiB each (maximum 256 MiB). The compact UI export still contains in-memory entries and metadata; attach rotated files for complete incident reconstruction. Profile, probe, test, stop, disconnect, serial-error, relay, protection, and application events remain individual records.

The renderer's `직렬 전송 완료` state means only that the operating system completed the serial write callback. It is not device acknowledgement and does not prove controller parsing or physical hardware motion. Diagnosis starts with the profile, probe response/no-response, write duration, and port error records, then compares them with the separately observed device position, power, cable, and firmware.

The existing **저장** action exports the bounded in-memory `entries` plus current session and diagnostic-file metadata. Persistent files and exports remain local-only. Event construction uses field allowlists and excludes credentials, tokens, authorization data, cookies, and URL query strings. Diagnostic file failure disables persistence for that session without blocking motion or safety sequencing.

## Access Modes

- `open`: the Demo 10 desktop UI does not use a password and disables the password field. The server retains open-room password compatibility for older/API clients.
- `request`: viewer join requests remain connected in approval wait state until the host approves or rejects them.
- Host moderation can kick active viewers or block the same display name for the current room session.

## Security And Safety Requirements

- Require explicit room join before receiving motion.
- Provide host and viewer emergency stop controls.
- Treat emergency stop as a distinct control event, not as an ordinary zero-value motion frame.
- Keep emergency stop latched locally until explicit local release; never fan out a release event.
- Use the absolute stop position for room exit, emergency stop, and explicit hardware disconnect. Disconnect attempts the stop payload for at most `500ms`, then closes the port even if the write fails or stalls.
- Keep receive pause independent from the emergency latch.
- Clamp all incoming motion values to valid ranges.
- Rate-limit motion frames to protect devices and relay infrastructure.
- Keep `.env` and relay secrets out of git.
- Treat all hardware protocol input as untrusted.
