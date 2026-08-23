# Stop Safety Hardening Design

> **Historical record — superseded:** The approved
> `2026-08-23-room-motion-emergency-latch-design.md` replaces this design's
> receive-pause latch, inactivity fallback, disconnect stop, and shutdown rules.
> Do not use this document as the current implementation authority.

## Goal

Make every stop path fail safe: a local or received emergency stop must block later motion until the user explicitly resumes, safe disconnect and app shutdown must prevent motion from overtaking the stop payload, and room-wide stop must be delivered independently of local serial latency.

## Chosen approach

Use the existing hardware protection pause as the visible, explicit stop latch. Add one main-process `pauseAndStop()` operation that sets `paused=true` before clearing pending output and writing `DSTOP` plus the configured absolute fallback position. The renderer receives the updated protection state and the user resumes by explicitly turning off **수신 일시정지**.

Safe disconnect uses a separate transient disconnect gate so it blocks `queueMotion()` before the stop write without changing saved protection settings. App shutdown reuses the same bounded safe-disconnect operation.

Room-wide stop starts relay fanout and local hardware stop concurrently. The server sends `room:stop` as a reliable control event rather than a volatile motion event. A received room stop clears delayed motion, latches local pause, waits for the hardware result, and reports an unconfirmed physical stop as an error.

## Alternatives considered

1. **Renderer calls pause and stop separately.** Rejected because a relay frame can enter between the two IPC calls.
2. **Close the serial port for every emergency stop.** Rejected because the existing product contract intentionally permits explicit resume without reconnecting.
3. **Keep emergency stop momentary and rely on the sender to stop.** Rejected because a viewer cannot control a remote sender and the hardware checklist requires that a local stop not resume automatically.

## Data flow

### Local emergency stop

1. Main process clears delayed relay motion and stops the local demo timer.
2. `HardwareController.pauseAndStop()` sets `protection.paused=true` before any asynchronous write.
3. Pending hardware frames and timers are cleared.
4. The controller writes `DSTOP` and the absolute stop-position fallback.
5. Renderer applies the returned protection state and shows either confirmed stop or direct-power-cut guidance.

### Safe disconnect and app shutdown

1. Controller sets a transient disconnect gate.
2. New `queueMotion()` calls are rejected.
3. Controller attempts the stop payload for at most the existing 500 ms write bound.
4. Controller closes the port and clears the gate.
5. App quit waits for this bounded sequence before completing.

### Room-wide emergency stop

1. Host stops its demo timer.
2. Host starts local `pauseAndStop()` and relay `room:stop` concurrently.
3. Server emits a non-volatile control event and acknowledges the host.
4. Viewer clears delayed motion, atomically pauses local output, writes the stop payload, then receives a status event containing the hardware result.

## Stop position input

Keep the wire/profile value normalized to `0.00-1.00`. The number field maintains a string draft while the user types so transient values such as `0.` or an empty field are not immediately coerced to `0` or clamped to `1`. Valid drafts update the profile; blur restores or clamps invalid drafts.

## Error handling

- A serial write failure returns `hardware-stop-write-failed` and retains the paused latch.
- Receive-pause and remote-stop UI must not overwrite that failure with a success message.
- Relay failure and local hardware failure are reported independently.
- A missed hardware connection is a local warning, while a write failure on an open port requires direct power-cut guidance.

## Verification

- A frame arriving after local stop is rejected until explicit unpause.
- A frame arriving during safe disconnect is rejected and never appears after `DSTOP`.
- App shutdown invokes bounded safe disconnect.
- Relay stop starts before a stalled local hardware stop resolves and uses a non-volatile event.
- Receive pause and received room stop expose hardware write failure.
- Typing `0.35` into the stop-position field preserves and commits the decimal value.
- Existing Electron, relay smoke, UI smoke, build, and diff checks remain green.
