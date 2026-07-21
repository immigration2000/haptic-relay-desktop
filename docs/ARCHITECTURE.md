# Architecture

## Boundary

Haptic Relay Desktop extracts hardware control from the live-streaming website. The live video platform remains responsible only for video, chat, and room promotion. This app owns room identity, access control, hardware connection, and motion-frame relay.

## Components

- `electron/main.ts`: native desktop shell, IPC registration, app lifecycle.
- `electron/services/hardware-controller.ts`: serial hardware access and normalized motion output.
- `electron/services/room-host.ts`: Socket.IO room host for the streamer.
- `src/App.tsx`: renderer UI for host and viewer workflows.
- `src/shared/protocol.ts`: shared room and motion protocol types.

## Roles

- Host: creates a room, chooses entry mode, connects source hardware, publishes motion frames.
- Viewer: enters a room, connects receiver hardware, receives motion frames, writes hardware commands.

## MVP Data Flow

```text
Host hardware -> HardwareController -> host:motion -> RoomHost -> viewer:motion -> viewer hardware
```

For local testing, the room host can run inside the streamer's desktop app. For public internet rooms, replace `RoomHost` with a hosted relay service and keep the same motion protocol.

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
