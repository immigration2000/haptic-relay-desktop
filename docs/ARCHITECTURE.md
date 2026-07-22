# Architecture

## Boundary

Haptic Relay extracts hardware control from the live-streaming website. The live video platform remains responsible only for video, chat, and room promotion. The desktop app owns hardware connection and user workflows. The relay server owns room identity, access control, and motion-frame relay.

## Components

- `electron/main.ts`: native desktop shell, IPC registration, app lifecycle.
- `electron/services/hardware-controller.ts`: serial hardware access and normalized motion output.
- `electron/services/tcode-encoder.ts`: converts normalized motion frames to OSR/SR6 compatible T-Code lines.
- `electron/services/relay-client.ts`: Socket.IO client used by the desktop app.
- `server/src/relay-server.ts`: standalone Socket.IO relay server for rooms and motion frames.
- `server/src/control-token.ts`: HMAC signed token helper for host/viewer relay authorization.
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

## Control Plane

The current Node process serves both the Control API and Relay Node so local development stays simple. The API contract is intentionally separable.

```text
POST /api/rooms
  -> create room metadata
  -> return hostToken + relayUrl

POST /api/rooms/:roomName/join
  -> validate password and room capacity
  -> return viewerToken + relayUrl

Socket.IO room:create/viewer:join
  -> verify signed token
  -> bind socket to room
```

Production should split the Control API from Relay Nodes once account auth, billing, and moderation are added.

## Server Split Rationale

The website hardware feature and the external-platform desktop app should not share the same realtime path.

- Website path: optimized for lowest possible latency, tight platform integration, controlled environment.
- Desktop app path: optimized for compatibility across PandaTV and other platforms, easier onboarding, separate scaling and rate limits.
- Shared protocol: motion frame shape and hardware adapters can stay compatible across both products.
- Separate infrastructure: latency budgets, relay geography, logging, moderation, and cost controls can diverge without hurting the website experience.

## Latency Policy

The app relay optimizes for stable perceived motion rather than guaranteed delivery of every frame. Motion frames are transient state, so the newest frame is more valuable than a delayed backlog.

- WebSocket-only transport avoids long-polling overhead.
- Compression is disabled for tiny motion frames.
- Motion frames use a 4-byte binary packet instead of JSON.
- Motion broadcasts use volatile events so slow clients drop stale frames.
- Server-side token bucket max Hz protects viewers, devices, and relay cost without over-dropping timer jitter.
- Desktop-side coalescing keeps serial hardware and network output from building queues.

## Hardware Protocol

The relay protocol and hardware protocol are intentionally different.

- Relay payload: 4-byte binary packet derived from normalized app-level `MotionFrame`.
- Hardware output: T-Code ASCII over UART serial.
- Default output axis: `L0`, matching OSR/SR6 stroke control.
- Optional output axis: `V0` can map normalized intensity to vibration when a connected device supports it.
- Example: position `0.42` with a 16ms interval becomes `L04200I16\n`.

## Access Modes

- `open`: room name and optional password are enough to join.
- `request`: viewer join requests are rejected with `approval-required` until an approval queue is implemented.

## Security And Safety Requirements

- Require explicit room join before receiving motion.
- Provide host and viewer emergency stop controls before hardware output is enabled.
- Clamp all incoming motion values to valid ranges.
- Rate-limit motion frames to protect devices and relay infrastructure.
- Keep `.env` and relay secrets out of git.
- Treat all hardware protocol input as untrusted.
