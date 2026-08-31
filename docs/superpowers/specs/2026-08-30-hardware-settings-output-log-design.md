# Hardware Settings and Serial Output Log Design

## Goal

Redesign the lower half of the Hardware Settings view around a visual stroke-control card while preserving the existing port controls and serial output diagnostic card. Add a read-only native Electron window that shows the current hardware connection session's completed serial outputs.

The redesign must not add the reference mockup's `스크립트 진폭 자동 확장` control or any equivalent behavior.

## Confirmed Product Decisions

- Keep the port selector, refresh, connect, disconnect, test controls, and the existing serial output diagnostic card.
- Add a clickable text action, `전체 로그 보기`, beside `직렬 출력 진단`.
- Open the full output history in a separate Electron window, not an in-app modal or the existing general log tab.
- A successful hardware connection starts a new output-log session. Failed connection attempts do not clear the last successful session.
- Preserve the last session after disconnect so it can still be inspected. Clear it only when the next connection becomes ready.
- Keep at most the newest 10,000 output rows and show how many older rows were omitted.
- Replace the current profile grid with a visual stroke card, a dual-handle horizontal motion-range slider, a stop-position control, an intensity-limit slider, and a collapsible advanced-settings section.
- New installations default the motion range to 30–80%. Existing saved settings remain unchanged.
- Profile and device controls remain locked while hardware is connected. The intensity limit remains adjustable while connected.

## Existing Boundaries

`HardwareController` is the source of truth for connection readiness and completed serial writes. Its `onOutput` callback already emits a `HardwareOutputSnapshot` only after the serial write callback succeeds. The main process forwards that snapshot to the main renderer for the compact diagnostic card.

The new output history must reuse this completed-output boundary. It must not infer success from queued motion, renderer slider input, relay receipt, or a pending serial write.

## Serial Output Session Store

Add a small main-process store dedicated to the current successful hardware connection session.

The store contains:

- a monotonically increasing row ID within the session;
- the session start timestamp and connected port;
- an ordered array of `HardwareOutputSnapshot` rows;
- the number of rows discarded from the front after the 10,000-row limit is reached.

Session behavior:

1. When `HardwareController` reports `connected: true`, reset the store before forwarding that connection status to renderers.
2. Failed connection attempts leave the existing store unchanged.
3. Each subsequent `onOutput` snapshot is appended to the store and broadcast to the output-log window when it exists.
4. Disconnect and unexpected port loss retain the last session rows.
5. The next `connected: true` transition starts the next empty session.

Resetting in the synchronous connection-status callback places the boundary after readiness and before later motion output can be accepted.

## Native Output Log Window

Create one non-modal `BrowserWindow` for the output history. Repeated open requests focus the existing window instead of creating duplicates. Closing this window does not stop collection, change the hardware connection, or close the main window.

The log window uses the same local renderer bundle with a dedicated view selector and a read-only preload bridge. Its exposed API is limited to:

- fetching the current session snapshot;
- subscribing to session reset and appended-row events;
- unsubscribing from those events.

The window displays:

- session port and start time;
- retained-row count and omitted-row count;
- chronological columns for completion time, kind, command, port, and baudrate;
- an empty state before the first completed output;
- a `최신 로그로 이동` action when the user has scrolled away from the bottom.

The view follows new rows only while the user is already near the bottom. Reading older rows suspends auto-follow. Returning to the bottom resumes it. The list must use incremental rendering or virtualization so 10,000 retained rows do not freeze the renderer.

The window is read-only. It provides no connect, disconnect, test, stop, copy, export, or arbitrary IPC function.

## Hardware Settings Layout

The upper port-control row and compact serial output diagnostic retain their current visual hierarchy. The diagnostic heading gains a text-style button:

```text
직렬 출력 진단   전체 로그 보기                         직렬 전송 완료
```

The lower area becomes a visual control card adapted to the application's existing light industrial styling rather than copying the reference image's dark theme verbatim.

### Stroke Visualization

The left side displays `스트로크 제어 (L0)` with a 0–100 vertical reference rail. The colored segment visualizes the selected minimum and maximum positions. This vertical rail is a status visualization; editing happens through the horizontal range control below it.

The right side displays one vertical stop-position control. Its bounds always follow the selected motion range. The labels and summary use integer percentages, while the stored profile continues to use normalized 0.0–1.0 values.

The summary reads in this form:

```text
실제 30~80 · 정지 50 · 원본 대비 0.50배
```

When direction inversion is active, the summary also shows that state.

### Motion Range

Place a dual-handle `동작 범위` slider above `강도 상한`.

- UI domain: integer 0–100%.
- Model mapping: divide by 100 to update `hardwareProfile.strokeMin` and `strokeMax`.
- Default for settings without saved values: 30–80%.
- The handles maintain at least a 1% gap, matching the existing main-process requirement that minimum be strictly less than maximum.
- Changing the range clamps `stopPosition` into the new inclusive range.
- The horizontal control and vertical visualization update from the same model state.
- The control is disabled while connected or while a hardware lifecycle action is busy.

### Stop Position

The vertical stop control edits `hardwareProfile.stopPosition` as an integer percentage mapped back to 0.0–1.0. It cannot leave the selected motion range and is disabled under the same conditions as the motion range.

### Intensity Limit

Place the existing protection `강도 상한` control below the motion range.

- UI domain: integer 0–100%.
- Model mapping: divide by 100 to update `hardwareProtection.intensityLimit`.
- It remains editable while connected.
- Reuse the existing explicit protection-apply action so a form edit is not mistaken for an applied runtime limit.
- Saving settings persists the normalized value through the existing settings schema.

### Advanced Settings

Move the following existing controls into a collapsed `고급 설정` disclosure:

- baudrate;
- stroke axis;
- optional vibration axis;
- direction inversion;
- settings save and load actions.

These controls keep their current validation and connected/busy disable rules. Loading settings updates every visual control from the loaded normalized values.

## Validation and Error Handling

- Renderer conversions reject non-finite values and clamp percentages to 0–100 before producing normalized values.
- The minimum/maximum invariant is enforced both in the UI component and by the existing main-process profile validation.
- Reducing the motion range clamps stop position immediately, so an invalid profile is never submitted.
- Failure to open the log window reports a normal app error without changing hardware state.
- A log-window crash or close does not affect the session store or serial output.
- Session events carry plain validated data only. The read-only preload exposes no raw Electron objects.

## Testing

Add regression coverage for:

- 0–100 percentage to normalized-value conversion and round-trip display;
- dual-handle ordering and stop-position clamping;
- fresh-settings default of 30–80% without changing migrated or saved profiles;
- connected/busy disable behavior for profile controls and connected editability for intensity limit;
- omission of `스크립트 진폭 자동 확장` text and behavior;
- successful connection resetting the output store;
- failed connection and disconnect retaining the last successful session;
- append order, 10,000-row retention, and omitted-row count;
- singleton log-window open/focus behavior;
- read-only preload format and trusted-sender validation;
- initial snapshot, reset event, live append, and auto-follow pause/resume;
- existing hardware output, connection, disconnect, emergency latch, settings, security, smoke, and production build suites.

Packaged-app verification covers opening the native window, receiving live output rows from actual COM hardware, retaining the session after disconnect, resetting on successful reconnect, and editing/saving/reloading the 30–80% visual range.

## Out of Scope

- Script amplitude auto-expansion.
- Changing T-Code position precision, interpolation timing, or the 30Hz demo stream.
- Exporting or copying the full output history.
- Persisting per-output rows across app restarts.
- Replacing the existing general application/event log.
