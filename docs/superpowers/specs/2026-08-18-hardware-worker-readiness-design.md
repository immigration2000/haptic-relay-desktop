# Hardware Worker Readiness Design

## Objective

Prepare a narrowly scoped Windows build for the August 19 hardware session. A host must be able to drive a viewer's T-Code device through either the existing mouse controls or an existing repeating motion template, and both sides must be able to diagnose the last command that was actually accepted by the viewer's serial port.

## Deadline Scope

Included:

- existing manual position and intensity controls at 30Hz;
- existing sine, triangle, pulse, and sawtooth repeating templates;
- viewer serial connection and T-Code output;
- last successful serial-output diagnostics inside the desktop app;
- focused T-Code encoding tests;
- manual hardware-session checklist;
- Windows `v0.1.1-demo.4` installer and installed-app verification.

Excluded until after the hardware session:

- user-authored script import, editing, recording, and playback;
- viewer interpolation implementation;
- source-device motion capture;
- account authentication and production server work.

## Existing Motion Path

The deadline build preserves the current path:

```text
host mouse or repeating template
-> 30Hz MotionFrame
-> relay server
-> viewer RelayClient
-> viewer HardwareController
-> T-Code serial command
-> viewer hardware
```

The host does not need hardware connected. The viewer connects the physical device and selects its COM port, baud rate, linear axis, optional vibration axis, stroke range, and direction.

## T-Code Output

Position is encoded on the configured linear axis, normally `L0`, from `0000` through `9999`. A normal 30Hz frame includes an interval near the current hardware cadence, for example `L05000I16`.

Intensity is emitted only when an optional vibration axis such as `V0` is configured. Devices that only implement an OSR linear axis can leave vibration blank.

Emergency stop writes `DSTOP` first and then a minimum-position, zero-intensity fallback command. Existing protection limits remain active before profile mapping and encoding.

## Successful-Write Diagnostic

`HardwareController` emits a diagnostic snapshot only after the serial write callback reports success. The snapshot contains:

- output kind: `motion`, `test`, or `stop`;
- the exact trimmed T-Code payload;
- local completion time;
- configured port path and baud rate.

Failed writes continue through the existing error log and must not replace the last successful snapshot.

The renderer receives the snapshot through a one-way preload event. A focused hardware-output monitor component owns its own subscription and local state so 30Hz diagnostics do not rerender the entire application. The component appears in the existing hardware panel and displays the latest command, output type, timestamp, port, and baud rate. It uses a stable fixed-height layout and does not keep an unbounded command history.

The diagnostic proves that the application handed a command successfully to the operating-system serial stack. It does not claim that the physical mechanism moved; the hardware worker confirms that separately.

## Safety and Lifecycle

- Device disconnect clears the visible output diagnostic.
- Failed connection or write remains visible through existing status and event logs.
- Emergency stop cancels pending motion before writing the stop payload.
- The output monitor unsubscribes when unmounted.
- No command history, device identifier, or room credential is persisted.
- Diagnostic rendering must never slow or block serial output.

## Automated Verification

### Encoder tests

- linear-axis minimum, midpoint, maximum, and clamping;
- interval encoding and rounding;
- optional vibration-axis intensity;
- invalid axis rejection;
- `DSTOP` ordering and fallback command;
- T-Code probe request and response parsing.

### Desktop integration tests

- preload exposes only the hardware-output listener and cleanup function;
- successful output snapshots reach the focused monitor;
- failed writes do not report success;
- existing manual and automatic two-client tests continue to pass;
- installed app closes without destroyed-object errors.

## Hardware Session Acceptance Checklist

1. Connect the viewer device and confirm the expected COM port appears.
2. Use `115200`, `L0`, no vibration axis, and a conservative `0.20..0.80` stroke range initially.
3. Run the local hardware test and verify the expected stepped movement.
4. Create a host room and join it from the viewer app.
5. Start manual demonstration and move the host position slider slowly.
6. Confirm viewer position values, successful T-Code diagnostics, and physical movement agree.
7. Stop manual demonstration and run the triangle template at low intensity and a slow period.
8. Confirm repeated viewer movement stays inside the configured range.
9. Trigger emergency stop and confirm movement stops immediately.
10. Save the device's working port, baud rate, axes, direction, and safe stroke range.

## Release Gate

Publish `v0.1.1-demo.4` only after:

- focused encoder and diagnostic tests pass;
- motion, Electron, security, relay, and UI suites pass;
- unpacked and installed two-client tests pass;
- the NSIS installer and SHA-256 sidecar are generated;
- the hardware-session guide identifies unverified physical movement as the remaining on-site check.
