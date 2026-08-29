# Room Motion and Emergency Latch Design

## Status

Approved product design. This document supersedes the behavior described in
`2026-08-23-stop-safety-hardening-design.md` wherever the two documents conflict.

The explicit disconnect rule in this historical design was superseded on
2026-08-29: disconnect now attempts `DSTOP` plus the configured absolute stop
position for at most `500ms`, then closes the port regardless of write success.

## Goal

Keep hardware motion faithful to the streamer for the full room session while
making emergency stop an explicit, locally released safety latch.

The hardware moves to the configured absolute stop position only when the user
leaves the room or an emergency stop is triggered. Packet inactivity, an
unchanged streamer value, and hardware-port disconnection must not move the
hardware to that position.

## Product rules

1. From room join until room leave, every valid streamer motion frame is eligible
   for local hardware output.
2. If the streamer does not move, the hardware remains at the last commanded
   position.
3. If motion packets temporarily stop, the hardware remains at the last commanded
   position. There is no inactivity-triggered stop-position command.
4. Leaving the room sends `DSTOP` and the configured absolute stop position before
   ending the local room session.
5. Closing the application while still in a room follows the same stop-position
   behavior as leaving the room.
6. The hardware disconnect button closes the serial port without sending `DSTOP`
   or the stop position.
7. Emergency stop sends `DSTOP` and the configured absolute stop position, then
   latches local hardware motion off.
8. A streamer room-wide emergency stop sends the reliable stop event to all
   currently connected participants and applies the same local latch to the
   streamer.
9. Every participant releases only their own local latch by pressing
   **긴급정지 해제**. There is no remote or room-wide release command.
10. Releasing the latch sends no serial motion. A later valid streamer frame may
    move the hardware.
11. Room leave, room join, hardware disconnect, and hardware reconnect do not
    release the latch. The explicit release button is required.
12. The latch is runtime-only. A complete application restart initializes it as
    released.

## Chosen architecture

Add a dedicated `emergencyStopped` runtime latch to the main-process hardware
controller. It is independent of the existing receive-protection `paused` state.

The distinction is intentional:

- `paused` is an ordinary receive-control setting.
- `emergencyStopped` is a safety state entered by an emergency event and exited
  only by an explicit local release.

Motion admission checks both states. A frame is rejected if either state blocks
output, but changing one state never changes the other.

The controller exposes three separate operations:

- `latchEmergencyStop()`: synchronously latches first, clears pending output,
  cancels hardware tests, then attempts `DSTOP` plus the configured position.
- `releaseEmergencyStop()`: clears only the emergency latch and emits no hardware
  output.
- `stopForRoomExit()`: clears pending output and attempts the same bounded stop
  payload without changing or releasing the emergency latch.

Serial disconnection is a fourth, separate operation. It rejects new motion while
the close is in progress and closes the port without a stop payload.

## Alternatives considered

1. **Reuse receive pause as the emergency latch.** Rejected because a normal
   receive preference and an emergency safety state need independent controls,
   messages, and release semantics.
2. **Close the serial port on emergency stop.** Rejected because release would
   require reconnecting hardware and would not match the requested local release
   workflow.
3. **Keep the existing inactivity safety timer.** Rejected because it moves the
   hardware without a room-leave or emergency event and violates the required
   last-position behavior.

## Data flow

### Normal room motion

1. Joining a room starts accepting valid streamer frames.
2. Each frame passes through existing relay validation and motion mapping.
3. The hardware controller rejects the frame if receive pause, emergency latch,
   disconnect, or another existing safety gate blocks output.
4. Otherwise the controller emits the mapped TCode command.
5. Repeated values are harmless; packet silence schedules no fallback movement.

### Local emergency stop

1. The main process clears delayed relay motion and stops local demo/test output.
2. The controller sets `emergencyStopped=true` before awaiting any serial work.
3. Pending hardware frames and output timers are cleared.
4. The controller attempts `DSTOP` and the configured absolute stop position using
   the existing bounded write behavior.
5. The UI displays the latched state even if physical stop confirmation fails.
6. Until local release, later relay, demo, test, and queued motion are rejected.

### Streamer room-wide emergency stop

1. The streamer starts reliable relay fanout and their local emergency stop
   concurrently so local serial latency does not delay viewers.
2. Each connected viewer receiving the event clears delayed motion and invokes
   `latchEmergencyStop()` locally.
3. Relay delivery and each machine's physical stop result remain independent.
4. The relay protocol provides no release event.

### Local emergency release

1. The user presses **긴급정지 해제** on their own machine.
2. The controller clears `emergencyStopped` only.
3. No `DSTOP`, position, replayed frame, or synthetic motion is emitted.
4. The next newly received valid streamer frame may move the hardware.

### Room leave and application exit

1. New room motion is blocked and delayed motion is cleared.
2. If hardware is connected, `stopForRoomExit()` attempts `DSTOP` plus the
   configured absolute stop position using the existing bounded write behavior.
3. The room connection is closed. Application exit also closes the serial port.
4. A failed physical stop is reported when the UI remains available; shutdown is
   still bounded and cannot hang indefinitely.
5. This flow does not clear an existing emergency latch.

Application exit outside a room closes the serial port without sending a stop
payload.

### Hardware disconnect

1. A transient disconnect gate rejects new hardware motion.
2. Pending local output that has not reached the serial port is cleared.
3. The port is closed without `DSTOP` and without an absolute-position command.
4. The room session and emergency latch are unchanged.

## UI behavior

- The local safety control shows **긴급 정지** while released and
  **긴급정지 해제** while latched.
- The latched state remains visible whether or not hardware is currently connected.
- A local release affects neither another participant nor the streamer's state.
- Receive pause remains a separate control and status.
- A stop-write failure keeps the latch active and shows direct power-cut guidance.
- The hardware disconnect confirmation and status must not claim that the device
  was moved to the stop position.

## Error handling

- The emergency latch is set before serial I/O, so a timeout or port error cannot
  accidentally permit later motion.
- Emergency stop reports relay-delivery and local-hardware results independently.
- Room leave continues closing the room after a bounded stop failure and reports
  the unconfirmed physical stop when possible.
- Hardware disconnect closes the port even though it intentionally performs no
  position write.
- Release is idempotent and does not depend on a connected serial port.

## Verification

- Streamer value repetition and packet inactivity produce no automatic `DSTOP` or
  stop-position write.
- Local emergency stop latches before serial completion and rejects later relay,
  demo, test, and queued motion.
- A received room-wide stop latches each viewer independently and uses reliable
  relay delivery.
- Local release emits no serial output; a later new frame is accepted.
- Receive pause and emergency latch remain independent in both directions.
- Room leave and in-room application exit attempt the bounded stop payload.
- Out-of-room application exit and hardware disconnect write no stop payload.
- Disconnect/reconnect and leave/rejoin do not clear the latch; application restart
  does.
- Stop position accepts decimal normalized values such as `0.35` and the emitted
  absolute TCode position matches the configured value.
- Electron, relay smoke, UI smoke, build, audit, and diff checks remain green.

## Out of scope

- Remote emergency release
- Persistent emergency state across application restarts
- Automatic movement after release
- Packet-loss or inactivity fallback movement
- Firmware power control
