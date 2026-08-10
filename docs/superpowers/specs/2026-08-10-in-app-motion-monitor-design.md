# In-App Motion Monitor Demo Design

## Goal

Provide a fast, hardware-free demonstration that proves motion travels through the real streamer-to-viewer path:

```text
streamer controls -> relay server -> viewer RelayClient -> delay/sequence pipeline -> in-app monitor
```

The demo succeeds when a value sent from the streamer client appears in the viewer client's monitor without requiring a serial device.

## Scope

### Included

- Add an expanded `Admin Motion Monitor` panel to the viewer workspace.
- Display the latest received position and intensity as numeric values and live gauges.
- Display protocol version, sequence, total received frames, and last receipt time.
- Display hardware delivery state, including `hardware-not-connected`, without treating missing hardware as a relay failure.
- Show a bounded list of recent received frames for visual confirmation.
- Forward monitor snapshots from the Electron main process through the existing sandboxed preload bridge.
- Use the existing streamer motion test sliders as the demo input.
- Add scripts and documentation for running the relay server and two independent desktop clients locally.

### Excluded

- Serial hardware emulation or virtual COM ports.
- A server-hosted web administration page.
- Long-term analytics, database persistence, or room-wide administrator accounts.
- Fixes for the safety, session-isolation, protocol-rollout, and maximum-rate issues found in the final PR review. Those remain separate pre-release work.

## Architecture

The existing relay server remains the demo server. No parallel server implementation is introduced.

When the viewer `RelayClient` releases a frame after sequence validation and configured delay, the Electron main process already attempts `HardwareController.queueMotion(frame)`. At that exact boundary, it will build a monitor event containing:

- the normalized `MotionFrame`;
- local receipt timestamp;
- cumulative viewer-side monitor count;
- hardware queue result.

The main process sends this event to the renderer over a new one-way IPC channel. The preload exposes only a typed subscription function. The renderer stores the latest event and a bounded recent-event list.

This location proves that the frame passed through the viewer's real receive pipeline. A server-only dashboard would not prove that.

## User Interface

The viewer workspace shows an expanded panel titled `Admin Motion Monitor` before the hardware panel.

The panel contains:

- connection state: waiting or receiving;
- latest position and intensity gauges in the `0.00-1.00` range;
- protocol version and sequence;
- cumulative received count;
- local last-received time;
- hardware result, shown as `Virtual receive OK` when no hardware is connected;
- the 10 most recent frames in newest-first order.

The panel does not render on the streamer workspace. Missing hardware is expected in demo mode and must not produce a red failure state when relay frames are arriving.

## Demo Workflow

1. Start the existing relay server on `http://localhost:4174`.
2. Start the Vite renderer and first Electron client.
3. Start a second independent Electron client against the same Vite server.
4. Use the first client as streamer and create an open room.
5. Use the second client as viewer and join the room.
6. Move the streamer's motion test sliders and send motion.
7. Confirm the viewer monitor updates even though no serial hardware is connected.

## Error Handling

- Invalid relay packets remain rejected by the existing decoder.
- Duplicate and out-of-order frames remain excluded before monitor delivery.
- The monitor retains only 10 recent frames to prevent unbounded renderer memory growth.
- Renderer unmount removes the IPC listener.
- Hardware queue failure is shown separately from relay receive success.

## Verification

- Unit/source contract tests cover the preload subscription and renderer listener cleanup.
- Relay smoke coverage confirms a real viewer receives motion without hardware.
- TypeScript and production builds must pass.
- Manual demo uses two independent Electron processes and verifies live values in the viewer panel.

## Acceptance Criteria

- A streamer-sent frame updates the viewer monitor through the real relay path.
- Position and intensity match the transmitted normalized values within packet quantization tolerance.
- The monitor count increases for accepted frames.
- No serial device is required.
- Recent frame history remains bounded at 10 entries.
- Existing room creation, join, delay, and hardware controls continue to build and test successfully.
