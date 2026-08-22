# Hardware Disconnect Design

## Objective

Add an explicit hardware disconnect control that safely releases the selected serial port and keeps the renderer's connection indicator synchronized with the real `HardwareController` state. This makes a failed or emergency-stopped device reconnectable without restarting the desktop app.

## User-Approved Behavior

When the user selects **연결 해제**, the application must:

1. cancel queued motion and attempt the existing T-Code emergency-stop payload;
2. wait no longer than the existing 500 ms serial-write timeout;
3. close the serial port whether the stop write succeeds or fails;
4. report whether the serial callback accepted the stop payload, without presenting that as physical-stop confirmation;
5. require an explicit user reconnect instead of reconnecting automatically.

Closing a serial port does not prove that the mechanism physically stopped. If the stop write fails, the UI must tell the user to cut device power directly.

## Scope

Included:

- a **연결 해제** button beside the existing hardware connection controls;
- safe-stop-before-close behavior for a user-requested disconnect;
- main-process-to-renderer hardware connection status synchronization;
- correct button states for connected, disconnected, and busy states;
- bounded failure handling and regression tests;
- a conservative COM3 acceptance test after automated verification.

Excluded:

- automatic reconnect;
- changing the normal emergency-stop success behavior to disconnect the port;
- changing T-Code encoding, stroke mapping, or protection limits;
- claiming physical stop from port closure alone;
- installer publication or deployment.

## Existing Behavior and Gap

The preload bridge and main process already expose `hardware:disconnect`, and `HardwareController.disconnect()` already clears queued motion, fails active writes, closes the port, and preserves the port reference when close fails.

The renderer does not call that API. It sets `hardwareConnected` to `true` after a successful connect and never learns when the controller fail-closes a port because of a write timeout, port error, cable removal, or probe failure. This can leave the UI showing a connected device even though later motion is rejected as `hardware-not-connected`.

## Connection State Contract

Add a shared `HardwareConnectionStatus` payload with:

- `connected`: whether the controller currently accepts work for an open port;
- `path`: the active port path when connected;
- `reason`: a stable reason string for a transition to disconnected;
- `unexpected`: whether the transition was caused by a timeout or port failure rather than a requested disconnect.

`HardwareController` owns the source of truth and publishes transitions through an `onConnectionStatus` option:

- publish connected only after the port opens and the probe phase completes without invalidation;
- publish disconnected after a requested close succeeds;
- publish disconnected immediately when `failPort` invalidates the active port;
- do not publish disconnected before a close that can still fail and restore the open port;
- avoid duplicate notifications when no state transition occurred.

A safe-disconnect operation tags its transition as requested even when its stop write fails. The structured disconnect result carries that stop failure to the initiating UI action. Timeouts and port errors outside a safe-disconnect operation are tagged as unexpected. This prevents the renderer from racing two different error messages for the same user action.

The main process forwards transitions on `hardware:connection-status`. It also exposes a read-only `hardware:status` query so a renderer reload cannot miss the current state. The preload bridge provides the query and a listener that returns an unsubscribe function.

On mount, `App` reads the current status, subscribes to future transitions, and removes the listener on unmount. A disconnected transition clears `hardwareConnected`, which also clears the last-successful-output monitor through its existing `connected` prop. An unexpected transition displays a reconnect-required error; a requested transition leaves the explicit disconnect action responsible for its completion message.

## Safe Disconnect Flow

The user-facing disconnect operation is a single main-process request backed by a controller-level `disconnectSafely()` operation:

```text
renderer: 연결 해제
-> main: hardware:disconnect
-> controller: cancel queued motion and safety timer
-> controller: write DSTOP + minimum-position fallback
-> success or 500 ms bounded failure
-> controller: close active serial port
-> connection status: disconnected
-> renderer: enable explicit reconnect
```

The existing raw `disconnect()` lifecycle method remains available for internal cleanup and reconnection setup. It does not gain an implicit stop write. `disconnectSafely()` owns the stop-attempt result, transition classification, and subsequent raw disconnect so other callers cannot accidentally duplicate or omit part of the user-facing sequence.

The operation returns a structured result containing the final connection state and whether the stop write succeeded.

- Stop succeeds and close succeeds: show **하드웨어 연결 해제됨**.
- Stop fails but the port is invalidated or closes: show **정지 명령을 확인하지 못했습니다. 장비 전원을 직접 차단하세요.** and remain disconnected.
- Close fails while the old port remains open: reject the operation, restore the controller's port reference, keep the UI connected, and show the existing formatted error.
- No port is connected: return immediately as disconnected without attempting a write.

The 500 ms bound comes from the existing `HardwareController.writePayload()` timeout. A stalled write already fail-closes the port, rejects the active write, and prevents later writes from queuing behind it. The disconnect flow must reuse that path rather than adding a second unbounded timer.

## Emergency Stop Interaction

The global emergency-stop button keeps its current success behavior: it cancels motion and writes the stop payload but leaves a healthy port connected so the user can intentionally resume later.

If the emergency-stop write times out or the port emits an error, the controller's existing fail-closed path invalidates the port. The new connection-status event then changes the UI to disconnected and requires an explicit reconnect. No automatic motion resume or automatic reconnect is allowed.

## Renderer Controls

In the existing hardware row:

- **연결** is enabled only when a port is selected, no hardware action is busy, and hardware is disconnected;
- **연결 해제** is enabled only when hardware is connected and no action is busy;
- **테스트** is enabled only when hardware is connected and no action is busy;
- port and profile controls remain visible; reconnect uses the currently selected port and profile;
- the existing global status message reports progress, success, warning, or failure.

The disconnect action uses the existing `runAction('hardware', ...)` busy guard so connect, disconnect, and test operations cannot overlap through the UI.

## Failure Semantics

- A successful write callback confirms only that the operating-system serial stack accepted the stop payload, not that the mechanism moved or stopped.
- A timeout or error invalidates the controller before another motion write is accepted.
- Closing and invalidated ports keep their error handler until close completion so a close-induced stream error cannot terminate the Electron main process.
- A failed close that leaves the port open remains recoverable through a second disconnect attempt.
- Status reason strings are safe operational identifiers and must not include environment values, room credentials, or serial payload history.

## Automated Verification

Controller regressions:

- successful safe disconnect writes the stop payload before closing;
- stalled stop write settles within the configured timeout and ends disconnected;
- close failure with an open port preserves the connected state and allows a retry;
- write timeout and port error publish one unexpected disconnected transition;
- successful connect publishes the connected port only after probe completion;
- probe invalidation never publishes connected.

Bridge and renderer regressions:

- preload exposes the status query and event listener with cleanup;
- the disconnect button exists and calls `disconnectHardware`;
- connect, disconnect, and test buttons follow the connection/busy state contract;
- requested disconnect success and stop-write failure produce the intended messages;
- an unexpected disconnected event updates the app shell device indicator and output monitor.

Required checks before physical testing:

- focused hardware-output regression test;
- preload/UI source integration tests;
- TypeScript/Electron build;
- lint;
- full Electron and UI test suites;
- `git diff --check`.

## COM3 Acceptance Test

Physical verification happens only after automated checks pass and the user confirms that COM3 is the intended device.

1. Prepare an independent power cutoff and keep clear of the mechanism.
2. Connect at `115200`, linear axis `L0`, no optional vibration axis, and stroke range `0.20..0.80`.
3. Confirm the UI shows connected and disables **연결**.
4. Run a conservative stepped hardware test and confirm movement remains inside the configured range.
5. Select **연결 해제** and confirm movement stops, the port closes, and the UI shows disconnected within the bounded operation.
6. Reconnect COM3 without restarting the app and repeat one low-range test.
7. Trigger a controlled failure only with a safe fake or loopback; do not deliberately stall or unplug a moving physical device merely to exercise the timeout path.

Physical movement and physical stop remain manual observations and must be recorded separately from automated serial-write success.

## Acceptance Criteria

- A connected user can safely disconnect and reconnect COM3 without restarting the app.
- Disconnect always attempts the stop payload first and never waits indefinitely.
- Stop-write failure still releases or invalidates the port and gives an explicit power-cut warning.
- Main-process port failures cannot leave the renderer showing a connected device.
- Normal successful emergency stop leaves the healthy port connected.
- No automatic reconnect or unsolicited motion is introduced.
