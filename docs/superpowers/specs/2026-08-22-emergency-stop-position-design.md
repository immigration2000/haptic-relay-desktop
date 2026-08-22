# Configurable Emergency Stop Position Design

## Objective

Allow the user to choose the absolute device-axis position used by the T-Code fallback command after `DSTOP`. The same configured position must be used by the global emergency stop and the safe hardware disconnect operation.

## User-Approved Semantics

- The value is an absolute normalized device position from `0.00` through `1.00`.
- It must remain inside the configured hardware stroke range, inclusive.
- It is not transformed by the profile's direction-inversion option.
- Global emergency stop and safe disconnect use one shared stop payload.
- Existing users retain the old behavior through migration: their stop position becomes their previous `strokeMin`.

For a profile with `strokeMin = 0.20`, `strokeMax = 0.80`, and `stopPosition = 0.30`, the linear fallback command targets `L03000`. Direction inversion does not change that target.

## Scope

Included:

- a required `stopPosition` field in `HardwareProfile`;
- a persisted settings-schema migration from version 2 to version 3;
- a numeric **긴급 정지 위치** field in the hardware profile UI;
- validation and UI range correction;
- controller use of the configured position for both emergency stop and safe disconnect;
- encoder, settings, controller, preload/UI, and migration regression coverage;
- an update to the shared T-Code guide after implementation is verified.

Excluded:

- a different stop target for safe disconnect;
- per-click stop-position prompts;
- direction-inverted stop targets;
- configurable stop interval or stop speed;
- automatic device reconnect;
- claiming that a successful serial callback proves physical movement or physical stop.

## Profile and Settings Contract

Add `stopPosition: number` to both renderer and Electron copies of `HardwareProfile`.

The application settings schema becomes version 3:

```ts
type AppSettings = {
  schemaVersion: 3;
  hardwareProfile: HardwareProfile;
  hardwareProtection: HardwareProtection;
  playback: PlaybackSettings;
};
```

Default settings use `stopPosition: 0`, matching the existing default `strokeMin`.

Migration rules are deterministic:

- version 3: validate directly;
- version 2: preserve all existing fields and add `stopPosition = hardwareProfile.strokeMin`;
- version 1 or an unversioned legacy value: add the existing playback default, add `stopPosition = hardwareProfile.strokeMin`, then validate as version 3;
- unsupported versions continue to fail with `unsupported-settings-version`.

`validateHardwareProfile` validates `strokeMin` and `strokeMax` first, keeps the existing strict `strokeMin < strokeMax` rule, validates `stopPosition` as a finite unit-interval number, and then requires:

```text
strokeMin <= stopPosition <= strokeMax
```

An out-of-range value fails with the stable reason `invalid-stop-position`. Validation occurs in the main process for settings and connection IPC, so renderer constraints cannot be bypassed by a crafted request or a corrupt settings file.

## Renderer Behavior

The hardware profile grid adds a number input labeled **긴급 정지 위치**:

- `min` equals the current `strokeMin`;
- `max` equals the current `strokeMax`;
- `step` is `0.01`;
- the displayed value is `hardwareProfile.stopPosition`;
- the field is disabled while hardware is connected or another action is busy.

Hardware profile values are applied when connecting. Disabling this safety-critical field while connected prevents the screen from displaying a new stop target that the active controller has not received. To change it, the user safely disconnects, edits the value, and reconnects.

When the user changes a valid stroke boundary, the renderer clamps `stopPosition` to the nearest point in the new range. Main-process validation remains authoritative. If the stroke range itself becomes invalid during editing, connect and save continue to reject it through the existing range validation rather than silently rewriting both boundaries.

Saving and loading settings includes `stopPosition`. A migrated profile is returned to the renderer with the explicit field, so all later saves are version 3.

## Controller and T-Code Flow

`HardwareController` normalizes and retains `stopPosition` as part of the active connection profile. For defensive compatibility with direct legacy callers, normalization falls back to `strokeMin` only when `stopPosition` is absent at runtime; the typed application contract still requires the field.

Both stop entry points converge on the existing `emergencyStop()` implementation:

```text
global emergency stop ---------+
                               +-> encodeTCodeStop(stopPosition)
safe disconnect -> stop first -+   -> DSTOP
                                   -> linear axis at stopPosition, I1
                                   -> optional vibration axis at 0
```

The controller changes the encoder call from `stopPosition: profile.strokeMin` to `stopPosition: profile.stopPosition`. `disconnectSafely()` already calls `emergencyStop()` before closing, so it needs no separate position logic.

Examples:

```text
L0, no vibration, stopPosition 0.30
DSTOP
L03000I1

L0 + V0, stopPosition 0.75
DSTOP
L07500I1 V00000
```

The stop write retains the existing production limit of 500 ms. A timeout still fail-closes the serial port, publishes disconnected state, and warns that physical stop was not confirmed.

## Error Handling and Safety

- Values below `0`, above `1`, non-finite values, and values outside the active stroke range are rejected.
- A profile missing `stopPosition` is accepted only through explicit legacy migration or the controller's defensive runtime fallback; new version-3 settings must contain it.
- A successful write callback confirms that the serial stack accepted the payload, not that the mechanism reached the target.
- `DSTOP` remains first in the payload; the position command is a compatibility fallback.
- Changing the saved stop position never sends motion by itself.
- Automatic reconnect and automatic motion resume remain prohibited.

## Automated Verification

Settings and migration tests:

- both protocol copies require `schemaVersion: 3` and `HardwareProfile.stopPosition`;
- defaults use `stopPosition = strokeMin = 0`;
- version-2, version-1, and unversioned profiles migrate to their previous `strokeMin`;
- version-3 settings round-trip a valid stop position;
- values outside the unit interval or stroke range reject with `invalid-stop-position`;
- unsupported schema versions remain rejected.

Controller and encoder tests:

- emergency stop encodes a non-minimum configured absolute position;
- direction inversion does not transform the stop position;
- optional vibration output remains zero;
- safe disconnect emits the same configured stop payload before close;
- missing runtime stop position falls back to `strokeMin` for legacy direct callers;
- existing timeout, port-error, close-only, and close-failure regressions continue to pass.

Renderer and integration tests:

- the new number input is present with dynamic minimum and maximum;
- it is disabled while connected or busy;
- a stroke-boundary edit clamps the stop position into a valid range;
- save, load, and connect pass the version-3 profile through the existing trusted IPC paths;
- preload exposure remains narrow and unchanged except for the extended typed profile data.

Required automated gate:

- focused application-settings tests;
- focused T-Code encoder and hardware-output tests;
- preload/UI source integration tests;
- full Electron suite;
- UI smoke suite;
- lint and full build;
- `git diff --check` and clean worktree verification.

## Documentation

After implementation and automated verification, update the shared `TCODE_GUIDE.md` to state:

- stop position is an absolute device-axis coordinate;
- it is constrained to the active stroke range;
- it is not affected by direction inversion;
- emergency stop and safe disconnect share the same payload;
- migration preserves the previous `strokeMin` behavior;
- serial acceptance does not prove physical stop.

Do not record COM port identifiers as permanent device identity or include credentials/environment secrets.

## COM3 Acceptance Test

Physical testing remains blocked until the implementation passes every automated gate and the user reconfirms readiness.

1. Keep the mechanism unloaded and clear, with an independent power cutoff within reach.
2. Configure `115200`, `L0`, no vibration axis, stroke range `0.20..0.80`, and stop position `0.30`.
3. Connect COM3 and verify the stop-position input cannot be edited while connected.
4. Run only the existing conservative motion check.
5. Trigger global emergency stop and manually confirm the mechanism stops near absolute position `0.30`.
6. Reconnect if required, then use **연결 해제** and confirm it uses the same target before the UI becomes disconnected.
7. Compare the application's last successful T-Code snapshot with the configured target, while recording physical position as a separate manual observation.

Do not deliberately stall or unplug a moving physical device to exercise automated failure cases.

## Acceptance Criteria

- A user can persist an absolute stop position inside the configured stroke range.
- Existing settings migrate without changing their previous stop target.
- Global emergency stop and safe disconnect encode exactly the same configured target.
- Direction inversion cannot alter the absolute stop target.
- Invalid stop positions cannot reach the controller through trusted application IPC.
- The UI cannot imply that an edited position is active on an already-connected controller.
- The feature introduces no automatic reconnect, unsolicited motion, or physical-stop claim.
