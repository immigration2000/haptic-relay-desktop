# Manual Motion Safety Limit Design

## Goal

Let the user tune the manual live-demo position slew limit from Hardware Settings without removing the protection that prevents rapid slider input from flooding or abruptly driving the serial device.

## Scope

- Add one **안전 모드 속도 제한** slider above **강도 상한** in the existing hardware stroke settings card.
- Apply the value only to manual live-demo motion.
- Keep the 30 Hz latest-value stream, automatic motion patterns, received streamer motion, hardware test pattern, emergency stop, and room-exit stop unchanged.
- Persist the value in app settings and migrate existing settings without changing their current behavior.

## User Experience

The slider range is `50%/초` through `400%/초` in `25%/초` steps. Its default is `200%/초`, which exactly preserves the current fixed `2.0` normalized-position-units-per-second behavior.

The control displays both the selected speed and an estimated full-scale traversal time:

- `50%/초 · 끝→끝 약 2.00초`
- `200%/초 · 끝→끝 약 0.50초`
- `400%/초 · 끝→끝 약 0.25초`

The displayed estimate describes a logical `0%` to `100%` position change. The configured hardware stroke range still maps that logical motion to the device's actual minimum and maximum positions.

Changing the slider while a manual demo is active takes effect on the next 30 Hz tick. It does not restart the stream, jump directly to the target, or emit extra frames. The value remains editable while hardware is connected. The existing **설정 저장** action persists it.

## Settings Model

Add a dedicated root settings object rather than placing this demo behavior inside the serial hardware profile or viewer protection settings:

```ts
type MotionSafetySettings = {
  manualMaxPositionSpeed: number;
};

type AppSettings = {
  schemaVersion: 4;
  hardwareProfile: HardwareProfile;
  hardwareProtection: HardwareProtection;
  playback: PlaybackSettings;
  motionSafety: MotionSafetySettings;
};
```

`manualMaxPositionSpeed` is stored in normalized position units per second. Valid persisted values are finite numbers from `0.5` through `4.0`, aligned to `0.25` increments. The UI converts between normalized units and integer percent-per-second labels.

Schema v4 is authoritative. Migration from schema v1, v2, or v3 adds:

```ts
motionSafety: { manualMaxPositionSpeed: 2 }
```

All existing profile, protection, and playback migration behavior remains intact. Invalid v4 safety values reject settings validation rather than being silently clamped.

## Runtime Architecture

`DemoMotionStream` owns the active manual slew value. Replace the module-level fixed step with a validated instance value and expose a focused setter. Each manual tick computes:

```text
maximum step = manualMaxPositionSpeed × (30 Hz interval in seconds)
```

The renderer owns the editable settings state. On settings load and on slider changes, it sends the validated value through a narrow preload IPC method to the main process. The main process validates the value again before updating `DemoMotionStream`.

IPC delivery preserves slider-event order. Applying a new value changes only future manual ticks; it does not publish synchronously. A rejected IPC value is logged and leaves the last valid runtime value active.

The existing app settings save path persists the full `motionSafety` object. Loading settings updates the renderer state and runtime stream before the user begins or continues manual demonstration.

## Safety Invariants

- Manual output remains capped at 30 Hz.
- Rapid slider events remain latest-value coalesced.
- Adjacent manual positions never differ by more than the configured per-tick maximum, apart from floating-point tolerance.
- The minimum limit cannot be reduced below `0.5` or raised above `4.0`.
- Updating the limit never generates a position frame by itself.
- Automatic patterns and received relay frames keep their current timing and interpolation behavior.
- Emergency stop and disconnect paths remain independent of the configurable limit.

## Error Handling

- Renderer controls only produce valid step-aligned values.
- Main-process validation rejects non-numeric, non-finite, out-of-range, and off-step values.
- Invalid persisted v4 settings produce the existing settings-invalid workflow.
- A rejected runtime update writes a warning log and keeps the prior valid speed.
- Failed persistence uses the existing settings-save error handling and does not alter the already active runtime limit.

## Verification

Automated tests cover:

- schema v1-v3 migration to the `2.0` default;
- schema v4 validation boundaries, step alignment, and invalid values;
- renderer and Electron protocol parity;
- default UI value, labels, range, step, and accessibility association;
- live runtime speed updates without timer restart or synchronous publication;
- adjacent-position bounds at `0.5`, `2.0`, and `4.0` units per second;
- unchanged automatic-pattern behavior and 30 Hz interval;
- settings save/load round trips.

Packaged hardware acceptance starts at the restricted `48%` to `52%` stroke range. Test `200%/초`, then `400%/초`, using one rapid right-to-left manual slider move at each setting while confirming motion, serial diagnostics, and connection stability. Only after both pass should the normal `30%` to `80%` range be tested once at `400%/초`. Stop immediately if motion becomes abrupt or the COM connection changes state.

## Rejected Alternatives

- **Store the value in `HardwareProfile`:** rejected because a manual-demo transport behavior is not a serial device characteristic.
- **Store the value in `HardwareProtection`:** rejected because it would imply that received viewer motion is subject to the same limiter.
- **Remove the limiter or allow an unlimited maximum:** rejected because prior rapid manual reversals caused physical-device disconnects.
