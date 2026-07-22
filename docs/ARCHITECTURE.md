# Architecture

## Boundary

Haptic Relay extracts hardware control from the live-streaming website. The live video platform remains responsible only for video, chat, and room promotion. The desktop app owns hardware connection and user workflows. The relay server owns room identity, access control, and motion-frame relay.

## Components

- `electron/main.ts`: native desktop shell, IPC registration, app lifecycle.
- `electron/services/hardware-controller.ts`: serial hardware access and normalized motion output.
- `electron/services/relay-client.ts`: Socket.IO client used by the desktop app.
- `server/src/relay-server.ts`: standalone Socket.IO relay server for rooms and motion frames.
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
- Motion broadcasts use volatile events so slow clients drop stale frames.
- Server-side max Hz protects viewers, devices, and relay cost.
- Desktop-side coalescing keeps serial hardware and network output from building queues.

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
