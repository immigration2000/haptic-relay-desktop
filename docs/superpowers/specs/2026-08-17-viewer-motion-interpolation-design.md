# Viewer Motion Interpolation Design

## Objective

Make viewer motion output smoother when local playback delay is enabled, without adding latency to the existing zero-delay path or predicting future motion.

The feature must remain testable without physical OSR/T-Code hardware. Interpolated output therefore reaches both the viewer receive monitor and the hardware queue through the existing `RelayClient` motion callback.

## Scope

This stage adds automatic linear interpolation when the applied viewer motion delay is at least `100ms`.

It does not add a new UI toggle, cubic interpolation, motion prediction, recording, playback, or physical hardware certification. The existing delay control remains the only user-facing setting.

## Receive Path

The viewer receive path becomes:

```text
decode
-> sequence validation
-> receipt-time playback timeline
-> 30Hz linear interpolation when delay >= 100ms
-> viewer receive monitor and hardware queue
```

At `0ms`, accepted frames bypass the interpolation timeline and are delivered immediately exactly as they are today.

## Components

### Motion interpolation calculator

A pure calculator receives two timeline samples and a target receipt time. It linearly interpolates `position` and `intensity`, clamps both values to `0..1`, and returns no synthetic value when its inputs or target time are invalid.

The generated frame uses a `durationMs` matching the 30Hz playback cadence. Source sequence and flags identify the newest real source frame participating in the output. Source and frame timestamps are linearly interpolated when both endpoints provide finite timing metadata; otherwise the newest valid source metadata is retained.

### Receipt-time playback timeline

The existing bounded viewer delay queue evolves into a playback timeline. Each accepted source frame is stored with its local monotonic receipt time. The configured delay determines the playback target:

```text
target receipt time = current monotonic time - applied delay
```

The timeline keeps the nearest real frame before the target and the nearest real frame after it. Old frames are pruned once they can no longer participate in a sample. Capacity remains bounded and overflow continues to drop the oldest source frame while incrementing the existing overflow metric.

### Relay playback loop

`RelayClient` owns one viewer playback timer. When interpolation is active, it samples the timeline at the existing 30Hz relay cadence and sends at most one output frame per tick through the existing motion callback.

The timer starts only when a delayed viewer frame is available and stops when there is no sampleable work. New frames restart it when necessary. Multiple timers must never run concurrently.

## Gap and Underflow Policy

Normal source-frame gaps up to and including `250ms` are interpolated.

When adjacent real frames are more than `250ms` apart, the app does not synthesize a long ramp. It emits no repeated hardware writes during the unsupported interval and delivers the newer real frame when its playback time becomes due. This preserves the hardware controller's existing safety timeout instead of keeping stale motion alive.

The app never extrapolates beyond the newest real frame. If the future endpoint is unavailable, the newest due frame may be delivered once, but it is not repeated indefinitely.

## Lifecycle and Safety

The playback timer and timeline are cleared on:

- relay disconnect or reconnect transition;
- viewer rejection, kick, room stop, or room leave;
- emergency stop;
- applied delay change;
- application shutdown.

Clearing the timeline also clears any interpolation anchor so motion from an old room or old delay setting cannot cross the boundary.

The zero-delay path remains immediate. Emergency and room-stop signals continue to bypass motion playback and invoke the existing stop behavior directly.

## Settings and UI

No settings schema change is required. Applied delay has these meanings:

- `0ms`: immediate source-frame delivery, interpolation disabled;
- `100ms` to `10000ms`: receipt-time delayed 30Hz interpolation enabled.

The viewer's existing delay panel remains unchanged. The receive monitor displays interpolated position and intensity values through its current snapshot path, allowing hardware-free verification.

## Testing

### Pure calculator coverage

- exact endpoints and midpoint values;
- position and intensity clamping;
- invalid and non-finite input rejection;
- timing metadata and sequence selection;
- gaps at `250ms` and above the threshold.

### Timeline coverage

- `0ms` immediate behavior remains unchanged;
- `100ms` playback produces intermediate values at 30Hz targets;
- no extrapolation after the newest frame;
- long gaps do not produce repeated stale output;
- bounded overflow and monotonic receipt-time validation remain intact;
- delay changes and clear operations remove all anchors and queued frames.

### Relay and two-client coverage

- only one playback timer is active;
- disconnect and safety events cancel pending output;
- the viewer receives multiple intermediate values between sparse host positions;
- output remains inside the two source endpoints;
- installed-app two-client verification succeeds without hardware.

## Release Plan

Implementation is split into independently reviewable stages:

1. pure interpolation calculator and focused tests;
2. receipt-time timeline and focused tests;
3. `RelayClient` 30Hz playback integration and lifecycle tests;
4. hardware-free two-client regression coverage and documentation;
5. a separately versioned Windows installer, silent-install verification, and GitHub release.

