# Persistent JSON Diagnostics Design

**Status:** Approved for implementation

**Date:** 2026-08-25

**Release correction (2026-08-29):** Portable exports omit `diagnosticLog.activeFile` because an absolute `userData` path can disclose the Windows account name. Lifecycle boundary records atomically flush the pending motion summary first.

## Context

During the COM3 acceptance session, Haptic Relay successfully opened the serial port and completed four T-Code writes, while the physical device initially did not move and later recovered. The existing UI labeled a completed operating-system write as `출력 성공`, but that result does not prove that the controller parsed the command or that the mechanism moved. The exported log retained connection and test lifecycle events, but omitted the transmitted commands, probe response, applied hardware profile, write latency, and USB identity needed to distinguish an application defect from firmware, power, cable, or controller behavior.

The current log buffer also keeps at most 300 entries in memory. Diagnostic evidence disappears when the application exits unless the user manually exports it.

## Goals

- Persist bounded, structured diagnostic evidence automatically for every application session.
- Keep the existing log tab and manual JSON export workflow.
- Clearly distinguish serial write completion from device acknowledgement or physical motion.
- Capture enough T-Code and serial context to diagnose intermittent hardware failures without logging secrets or producing unbounded 30 Hz output.
- Keep logging best-effort: a log-file failure must never block motion, emergency stop, room exit, hardware disconnect, or application shutdown.

## Non-goals

- The application will not claim that the device physically moved without a hardware feedback channel.
- This work will not add a new relay protocol event, remote log upload, telemetry service, cloud storage, or automatic issue reporting.
- The application will not persist room passwords, access tokens, control secrets, or other authentication material.
- The application will not write every production motion frame to disk.

## User-facing behavior

The hardware output monitor will replace `출력 성공` with `직렬 전송 완료`. The command, type, port, baudrate, and completion time remain visible. This wording means only that the operating system accepted the serial write callback; device parsing and physical movement remain unknown.

The existing **로그** tab continues to show the bounded in-memory event list and its existing filters. The existing **저장** action continues to create a human-shareable JSON file. Its payload gains session and diagnostic-log metadata while preserving the current `entries` array for compatibility.

No new user action is required to start persistent logging.

## Storage architecture

Add a main-process `DiagnosticLogStore` with one responsibility: serialize sanitized diagnostic events as newline-delimited JSON and rotate the files within a fixed bound.

- Directory: `path.join(app.getPath('userData'), 'logs')`
- Active file: `haptic-relay.jsonl`
- Rotated files: `haptic-relay.1.jsonl` through `haptic-relay.4.jsonl`
- Maximum file size: 2 MiB
- Maximum total files: 5, for an approximate 10 MiB upper bound
- Encoding: UTF-8, one valid JSON object per line
- Ordering: a single promise chain preserves append order
- Rotation: before an append that would exceed 2 MiB, delete the oldest file and rename the remaining generations from oldest to newest before rotating the active file

Each application launch generates a random session ID. Every persisted record contains:

```json
{
  "schemaVersion": 1,
  "timestamp": 1787580000000,
  "sessionId": "random-session-id",
  "level": "info",
  "source": "hardware",
  "event": "hardware-write-completed",
  "data": {}
}
```

The store creates its directory lazily. Malformed or partially written older lines do not prevent new appends. Rotation and append errors are reported once to the in-memory application log and stderr, without recursively attempting to persist the logging failure.

The store exposes an awaited `flush()` for orderly shutdown. Shutdown waits only within the existing bounded shutdown lifecycle; a stalled diagnostic write cannot delay a safety action or keep the app alive indefinitely.

## Diagnostic event model

The existing human-readable `AppLogEntry` remains the renderer contract. Main-process diagnostics use a separate structured record so display text does not become a storage schema.

Required session and hardware events are:

- `session-started`: application version, Electron version, Node version, platform, architecture, and whether the app is packaged.
- `session-ended`: orderly shutdown reason when available.
- `hardware-connect-requested`: port path, baudrate, linear axis, optional vibration axis, direction, stroke bounds, and absolute stop position.
- `hardware-port-identified`: USB vendor ID, product ID, serial number, manufacturer, and friendly name when supplied by SerialPort; unavailable fields are omitted.
- `hardware-probe-completed`: probe command, bounded raw response, detected flag, parsed T-Code version, axes, duration, and an explicit `responseReceived` boolean.
- `hardware-write-completed`: operation kind (`probe`, `test`, `stop`, or sampled `motion`), bounded command, port, baudrate, duration, and `deviceAcknowledged: false` because T-Code write completion is not a device acknowledgement.
- `hardware-write-failed`: operation kind, port, baudrate, duration, normalized error name/message, and timeout classification.
- `hardware-port-closed` and `hardware-disconnected`: expected/unexpected classification and known reason.
- `emergency-latched`, `emergency-released`, and `room-exit-stop`: local state/result only; no relay release event is introduced.

Raw probe responses and commands are capped at 4 KiB per event and control characters other than line separators are escaped by JSON serialization. Error stacks and arbitrary environment variables are not persisted.

## Motion aggregation

Production motion output can run at 30 Hz and must not create one disk write per frame. The logger maintains an in-memory one-second bucket containing:

- attempted, completed, dropped, and failed frame counts;
- first and last completion timestamp;
- last bounded command;
- last position and intensity after profile/protection processing, when available;
- last failure reason, when present.

At most one `hardware-motion-summary` record is persisted per elapsed one-second bucket. Test, probe, emergency-stop, and room-exit-stop writes remain individual records because they are low-frequency diagnostic boundaries. A pending motion bucket is flushed before disconnect and orderly shutdown.

## Manual export

The existing JSON export keeps these top-level fields:

- `app`
- `version`
- `exportedAt`
- `entries`

It adds:

- `schemaVersion`
- `sessionId`
- `diagnosticLog.format` (`jsonl`)
- `diagnosticLog.maxFileBytes`
- `diagnosticLog.maxFiles`

The manual export does not embed all rotated JSONL files. This keeps the existing action fast and bounded; users can share the automatically retained files separately when deeper history is required.

## Privacy and security

Diagnostic data is local only. It is never uploaded automatically. Event constructors use allowlisted fields rather than serializing arbitrary request, settings, or environment objects. Passwords, room credentials, control tokens, cookies, authorization headers, and URL query strings are excluded. User-selected local export paths are not copied into persistent diagnostics.

## Failure handling

- Logging initialization failure: continue running and add one non-recursive in-memory warning.
- Append or rotation failure: disable further persistent appends for that session after reporting one warning; keep the UI log operational.
- Corrupt existing file: retain it unless rotation removes it naturally; new records remain independent JSON lines.
- Shutdown flush timeout: continue shutdown and report to stderr without changing safety sequencing.
- Serial write success without physical motion: record `deviceAcknowledged: false`; never upgrade the result to device or motion success.

## Test strategy

- Unit-test JSONL serialization, append ordering, lazy directory creation, exact 2 MiB boundary behavior, five-file rotation, error suppression, and flush behavior with an injected filesystem adapter.
- Extend hardware-controller tests to verify structured profile, probe response/no-response, test/stop write latency, error classification, and one-per-second motion aggregation.
- Extend main/preload source assertions and UI smoke coverage for `직렬 전송 완료` and the backward-compatible manual export shape.
- Verify that representative passwords, bearer tokens, and URL query secrets never appear in JSONL or exported JSON fixtures.
- Run lint, Electron tests, relay smoke tests, UI tests, build, dependency audit, release build, release checks, and packaged two-client tests before publishing.

## Release conditions

The release version advances from `0.1.1-demo.9` only after all automated verification passes. Build the Windows NSIS artifact from a clean worktree, run `release:check`, verify the installer checksum and packaged two-client behavior, and publish the new tag and installer to the existing GitHub repository. Do not publish if persistent logging affects safety ordering, captures a secret fixture, fails rotation bounds, or causes any existing emergency/room lifecycle regression.
