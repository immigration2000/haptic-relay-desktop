# Hardware Readiness Gate Design

**Status:** Approved for implementation

**Date:** 2026-08-26

## Context

The COM3 T-Code controller opens successfully at 115200 baud and has repeatedly answered the existing `D1\nD2\n` probe with `TCode v0.3`. The same physical controller works in mosa, while Haptic Relay can report a completed operating-system write without physical motion. Inspection of Node SerialPort 13 on Windows shows that the current application opens with DTR asserted and RTS deasserted, while Chromium Web Serial and XTPlayer's optional control-line path finish with both DTR and RTS asserted.

Haptic Relay currently never calls `SerialPort.set()`. It also marks the connection ready when the serial port remains open even if the probe returns no T-Code response. Because `queueMotion()` checks only whether the port is open, room motion can be accepted during the probe window before firmware communication has been established.

## Goals

- Explicitly assert `DTR=true` and `RTS=true` after opening the serial port.
- Treat a parsed T-Code version response to the local `D1`/`D2` probe as the readiness boundary.
- Reject and close a connection if control-line setup fails or no T-Code version is received.
- Block room motion and the local hardware test until the exact active port is ready.
- Preserve fail-closed behavior after write errors, port errors, and unexpected closes.
- Persist structured evidence for control-line setup and readiness failures through the existing diagnostic pipeline.

## Non-goals

- Do not add a control-line toggle to the UI.
- Do not pulse DTR or RTS low, add an inferred reset sequence, or automatically retry a failed connection.
- Do not change baudrate, T-Code axis formatting, motion speed shaping, emergency-stop position, or relay protocol behavior.
- Do not claim physical movement from a probe or successful serial write.
- Do not add the separate, still-unverified continuous receive-buffer drain hypothesis in this change.

## Connection sequence

`HardwareController.performConnect()` will use this order:

1. Finish any prior disconnect cleanup.
2. Create the serial port with `autoOpen: false` and attach error/close handlers.
3. Open the port within the existing lifecycle timeout.
4. Call `port.set({ dtr: true, rts: true })` within the existing lifecycle timeout.
5. Attach the probe data listener and write the existing `D1\nD2\n` payload.
6. Parse the response after the configured probe window.
7. Mark that exact port ready only when `probe.version` is present and the port is still the active open port.
8. Publish `connected: true` only after readiness is established.

The control-line call keeps DTR asserted throughout the transition from the current Windows open state and raises RTS. No reset pulse is introduced.

## Readiness state

The controller will track `readyPort` rather than a standalone boolean. A port is ready only when all of these are true:

- `this.port === this.readyPort`;
- the port reports `isOpen`;
- its probe produced a recognizable T-Code version.

Using the port identity prevents a late callback from an old port from making a newly opened or failed port ready.

`queueMotion()` and `runTestPattern()` will return `{ queued/tested: false, reason: 'hardware-not-ready' }` when a port is open but has not crossed the readiness boundary. Emergency-stop and disconnect cleanup remain allowed to write/close an open port because safety teardown must not depend on successful readiness.

Readiness is cleared when the port fails, closes, or is physically finalized as disconnected. If an explicit close fails and the same physical port is restored by the existing lifecycle recovery path, its previous readiness is preserved; the lifecycle gate continues blocking motion while the disconnect is pending.

## Failure handling

- `SerialPort.set()` callback error, synchronous throw, or timeout: fail the port with `hardware-control-signals-failed`, close it, and reject `connect()`.
- Probe response without a parsed T-Code version or no response: fail the port with `hardware-tcode-not-ready`, close it, and reject `connect()`.
- Port loss during setup or probe: preserve the existing port error/close reason and reject `connect()`.
- No automatic reconnect or queued-motion replay occurs after any failure.

The renderer will map the two new reasons to Korean guidance. The previous successful-but-no-response warning becomes unreachable because such a connection no longer succeeds.

## Diagnostics

Add low-frequency structured events:

- `hardware-control-signals-configured`: port path, `dtr: true`, and `rts: true`.
- `hardware-control-signals-failed`: port path and normalized error data.
- `hardware-readiness-failed`: port path, bounded probe response, parsed version, and axes.
- `hardware-ready`: port path, parsed T-Code version, and axes.

These events contain no credentials. They are routed through the existing bounded JSONL store and must remain observational.

## Test strategy

- Extend the faithful fake port with callback-based `set()` behavior, operation ordering, and configurable T-Code probe replies.
- Verify `set({ dtr: true, rts: true })` happens after open and before the first probe write.
- Verify a control-line callback error rejects connection, closes the port, and never reports connected.
- Verify no T-Code version rejects connection and blocks motion while the probe is pending.
- Verify a recognized `TCode v0.3` reply establishes readiness and allows motion.
- Re-run all hardware lifecycle, emergency-stop, disconnect, diagnostic, Electron, UI, and build checks.

## Release condition

Automated verification proves state ordering and regression behavior but not physical motion. COM3 acceptance must start with no person in the mechanism, use the existing restricted stroke range, connect once, confirm the T-Code version in the UI/log, and only then run the low-risk hardware test.
