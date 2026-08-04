# Viewer Motion Delay Buffer Design

Date: 2026-08-04

Status: Approved in conversation

## Goal

Give each viewer a manual motion delay from 0 to 10 seconds so external live video can be aligned with the lower-latency motion relay. The setting uses 100ms increments and persists across app restarts.

## Scope

This change includes:

- a bounded viewer-side delay queue;
- RelayClient integration after V2 sequence validation;
- queue cleanup on session and safety events;
- AppSettings schema v2 with v1 migration;
- Electron IPC for applying and persisting the delay;
- a viewer-only delay control;
- deterministic unit and integration-oriented tests.

This change does not include local interpolation, automatic video-delay detection, presets, or connection-quality charts. Those remain separate roadmap items.

## Decisions

- Valid delay values are integers from `0` through `10000` milliseconds in 100ms increments.
- The default and migrated value is `0ms`.
- Delay is measured from local receipt time using a monotonic clock. `sourceTimeMs` is preserved as motion metadata but is not used as the waiting-clock origin because host and viewer wall clocks may differ.
- `0ms` remains an immediate pass-through path.
- Changing the delay clears every queued frame before the new value is accepted.
- No queued motion may survive a room change, viewer rejection or removal, explicit room disconnect, socket disconnect, emergency stop, or application shutdown.
- The queue holds at most 2,048 frames. On overflow it removes the oldest frame because current motion state is more valuable than stale state.

## Considered Approaches

### RelayClient FIFO with one timer - selected

Sequence validation and room lifecycle already live in RelayClient. A bounded FIFO inserted directly after sequence validation keeps ordering, cleanup, and delivery in one ownership boundary. One timer targets the next due frame, so a 10-second delay does not create hundreds of timers.

### Main-process intermediary queue

Placing the queue between RelayClient and HardwareController would keep RelayClient smaller, but room disconnect, rejection, reconnect, and stop events would need a second lifecycle protocol. That duplication increases the chance of stale frames surviving a session transition.

### One timer per frame

This is simple to write but creates roughly 600 active timers at 10 seconds and 60Hz, complicates cancellation, and makes queue-depth control less explicit.

## Components

### MotionDelayBuffer

A small pure module owns delayed entries and has no Socket.IO, Electron, or hardware dependency. Its interface supports:

- setting and reading the delay;
- enqueueing a frame with a monotonic receipt timestamp;
- draining every frame due at a supplied timestamp;
- reporting the wait until the next due frame;
- clearing entries;
- reporting queue depth and overflow drops.

The pure interface allows tests to advance time explicitly without sleeping.

### RelayClient

The receive path becomes:

```text
binary packet decode
  -> sequence validation
  -> MotionDelayBuffer enqueue
  -> one next-due timer
  -> onMotion callback
  -> HardwareController queue
```

RelayClient owns the timer. When the timer fires, it drains all due frames in FIFO order, calls the existing `onMotion` callback for each, and schedules only the next due time. At `0ms`, the frame is delivered immediately without scheduling.

RelayClient exposes a validated `setMotionDelay(delayMs)` operation and read-only buffer statistics for later quality UI work. Setting a new delay cancels the timer and clears the queue.

### Settings

`AppSettings` advances from schema version 1 to version 2 and adds:

```ts
playback: {
  motionDelayMs: number;
}
```

Migration preserves the existing hardware profile and protection values and adds `motionDelayMs: 0`. Unversioned legacy settings follow the existing migration path and also become schema v2. Invalid, out-of-range, or non-100ms values are rejected as `invalid-motion-delay`.

Settings validation and migration should move to a pure Electron module so the v1-to-v2 behavior can be tested without starting Electron.

### IPC and UI

The preload bridge exposes a narrow `setMotionDelay(delayMs)` command. The main process validates the value, applies it to RelayClient, and persists the updated playback setting while preserving hardware settings.

The viewer workflow shows a compact `모션 지연` control with:

- a slider from 0 to 10 seconds in 100ms steps;
- the selected value displayed in seconds;
- a `지연 적용` button.

Dragging the slider only edits the pending value. Pressing the button applies it once, avoiding repeated queue clearing while the user drags. Loading saved settings applies the persisted delay before normal viewer use.

## Safety and Error Handling

- Emergency stop cancels the delay timer and clears the queue before hardware stop handling continues.
- A socket disconnect clears delayed frames immediately, even when Socket.IO will reconnect. Rejoined motion starts with a fresh queue.
- Viewer rejection, removal, room change, and explicit disconnect clear the queue.
- Invalid settings do not modify the active delay or queue.
- Queue overflow drops the oldest entry and increments an overflow counter.
- Local interpolation is intentionally absent in this step; delayed frames retain their original values and metadata.

## Tests

The delay-buffer tests cover:

- `0ms` immediate delivery;
- no delivery before a frame is due;
- delivery at and after the due timestamp;
- FIFO delivery of multiple due frames;
- 100ms range and increment validation;
- queue clearing when delay changes;
- queue depth and 2,048-frame overflow behavior.

Settings tests cover:

- schema v2 validation;
- schema v1 migration to `motionDelayMs: 0`;
- unversioned settings migration;
- rejection of invalid delay values while preserving valid hardware settings.

RelayClient and smoke regression checks cover existing V1/V2 sequence behavior, room lifecycle, emergency stop, and reconnect behavior. TypeScript, Electron preload, server smoke, and renderer build checks remain part of completion verification.

## Completion Criteria

- A viewer can apply any valid delay from 0 to 10 seconds in 100ms increments.
- A received frame is not delivered before the configured local wait has elapsed.
- `0ms` preserves the current immediate behavior.
- Changing delay or ending the active session prevents previously queued frames from reaching hardware output.
- Existing settings migrate without losing hardware profile or protection values.
- Automated tests prove timing, ordering, validation, migration, and cleanup behavior.
