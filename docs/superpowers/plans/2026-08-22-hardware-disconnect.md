# Safe Hardware Disconnect Implementation Plan

> **Historical record — do not execute:** This completed plan's stop-before-close
> behavior is superseded by
> `../specs/2026-08-23-room-motion-emergency-latch-design.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded stop-before-close hardware disconnect button whose UI state always matches the actual serial controller state.

**Architecture:** `HardwareController` remains the connection-state source of truth and gains a user-facing `disconnectSafely()` operation plus connection transition callbacks. Electron forwards a typed status query/event through the preload bridge, and `App` consumes both to render safe connect/disconnect/test button states without automatic reconnect.

**Tech Stack:** TypeScript, Electron IPC/context bridge, React 19, Node.js `EventEmitter`, SerialPort-compatible fake tests, source-format integration tests.

---

## File Map

- Modify `electron/protocol.ts`: define the main/preload hardware status and disconnect result contracts.
- Modify `src/shared/protocol.ts`: mirror the renderer-facing hardware contracts used by `App` and `global.d.ts`.
- Modify `electron/services/hardware-controller.ts`: own current status, publish transitions, and implement bounded safe disconnect.
- Modify `electron/main.ts`: forward connection transitions, expose current status, and route user disconnects through `disconnectSafely()`.
- Modify `electron/preload.cts`: expose the status query and event subscription without exposing raw Electron objects.
- Modify `src/global.d.ts`: type the new preload methods and the structured disconnect result.
- Modify `src/App.tsx`: subscribe to status, add the disconnect action, and enforce button-state rules.
- Modify `scripts/hardware-output-test.mjs`: exercise stop-before-close, timeout, close failure, and transition classification with the Writable-style fake port.
- Modify `scripts/preload-format-test.mjs`: assert the IPC bridge, listener cleanup, renderer action, and button-state contract.

No new runtime dependency or automatic reconnect module is introduced.

### Task 1: Controller-Owned Connection State and Safe Disconnect

**Files:**

- Modify: `electron/protocol.ts:62-86`
- Modify: `electron/services/hardware-controller.ts:1-140, 368-438`
- Test: `scripts/hardware-output-test.mjs:1-246`

- [ ] **Step 1: Add failing controller regressions**

Import the new runtime-independent status shape through the controller callback and append isolated safe-disconnect cases before the final `console.log` in `scripts/hardware-output-test.mjs`:

First extend the existing successful emergency-stop assertion so normal emergency stop is proven to retain the healthy connection:

```js
await controller.emergencyStop();
assert.equal(outputs.at(-1).kind, 'stop');
assert.match(outputs.at(-1).command, /^DSTOP\nL00000I1$/);
assert.deepEqual(
  controller.getConnectionStatus(),
  { connected: true, path: 'COM9' },
  'a successful normal emergency stop keeps the healthy port connected'
);
```

Then append the isolated safe-disconnect cases:

```js
const safeStatuses = [];
const safePort = new FakePort('COM13');
const safeController = new HardwareController({
  createPort: () => safePort,
  onConnectionStatus: status => safeStatuses.push(status),
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await safeController.connect('COM13', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});
assert.deepEqual(safeController.getConnectionStatus(), { connected: true, path: 'COM13' });

const safeResult = await safeController.disconnectSafely();
assert.deepEqual(safeResult, { connected: false, stop: { stopped: true } });
assert.match(safePort.writes.at(-1), /^DSTOP\nL00000I1$/);
assert.deepEqual(safeStatuses, [
  { connected: true, path: 'COM13' },
  { connected: false, reason: 'hardware-disconnected', unexpected: false }
]);

const stalledStatuses = [];
const stalledPort = new FakePort('COM14');
const stalledController = new HardwareController({
  createPort: () => stalledPort,
  onConnectionStatus: status => stalledStatuses.push(status),
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await stalledController.connect('COM14', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});
stalledPort.stallNextWrite = true;
const stalledDisconnect = await Promise.race([
  stalledController.disconnectSafely(),
  delay(100).then(() => ({ timedOut: true }))
]);
assert.deepEqual(stalledDisconnect, {
  connected: false,
  stop: { stopped: false, reason: 'hardware-stop-write-failed' }
});
assert.deepEqual(stalledStatuses.at(-1), {
  connected: false,
  reason: 'hardware-disconnected-stop-failed',
  unexpected: false
});

const unexpectedStatuses = [];
const unexpectedPort = new FakePort('COM15');
const unexpectedController = new HardwareController({
  createPort: () => unexpectedPort,
  onConnectionStatus: status => unexpectedStatuses.push(status),
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await unexpectedController.connect('COM15', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});
unexpectedPort.emit('error', new Error('serial-port-fault'));
assert.deepEqual(unexpectedStatuses.at(-1), {
  connected: false,
  reason: 'hardware-port-error',
  unexpected: true
});

const safeCloseFailureStatuses = [];
const safeCloseFailurePort = new FakePort('COM16');
const safeCloseFailureController = new HardwareController({
  createPort: () => safeCloseFailurePort,
  onConnectionStatus: status => safeCloseFailureStatuses.push(status),
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await safeCloseFailureController.connect('COM16', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});
safeCloseFailurePort.failNextClose = true;
await assert.rejects(safeCloseFailureController.disconnectSafely(), /serial-close-failed/);
assert.deepEqual(safeCloseFailureController.getConnectionStatus(), { connected: true, path: 'COM16' });
assert.deepEqual(safeCloseFailureStatuses, [{ connected: true, path: 'COM16' }]);
await safeCloseFailureController.disconnect();
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```powershell
npm.cmd run build:electron
node scripts/hardware-output-test.mjs
```

Expected: the build or test fails because `onConnectionStatus`, `getConnectionStatus()`, and `disconnectSafely()` do not exist yet.

- [ ] **Step 3: Define the shared controller contracts**

Add these exports after `HardwareOutputSnapshot` in `electron/protocol.ts`:

```ts
export type HardwareConnectionStatus = {
  connected: boolean;
  path?: string;
  reason?: string;
  unexpected?: boolean;
};

export type HardwareDisconnectResult = {
  connected: false;
  stop: {
    stopped: boolean;
    reason?: string;
  };
};
```

Update the controller type import and options in `electron/services/hardware-controller.ts`:

```ts
import type {
  HardwareConnectionStatus,
  HardwareDisconnectResult,
  HardwareOutputSnapshot,
  HardwareProfile,
  HardwareProtection,
  MotionFrame
} from '../protocol.js';

type HardwareControllerOptions = {
  onLog?: (entry: HardwareLog) => void;
  onOutput?: (snapshot: HardwareOutputSnapshot) => void;
  onConnectionStatus?: (status: HardwareConnectionStatus) => void;
  createPort?: (options: { path: string; baudRate: number; autoOpen: false }) => HardwarePort;
  probeTimeoutMs?: number;
  writeTimeoutMs?: number;
};
```

- [ ] **Step 4: Implement status ownership and transition de-duplication**

Add controller state and helpers in `HardwareController`:

```ts
private connectionStatus: HardwareConnectionStatus = { connected: false };
private safeDisconnectInProgress = false;

getConnectionStatus(): HardwareConnectionStatus {
  return { ...this.connectionStatus };
}

private reportConnectionStatus(status: HardwareConnectionStatus) {
  if (
    this.connectionStatus.connected === status.connected
    && this.connectionStatus.path === status.path
  ) return;

  this.connectionStatus = { ...status };
  this.options.onConnectionStatus?.({ ...status });
}
```

Immediately after the probe completes successfully and before returning from `connect()`, publish the active port:

```ts
this.reportConnectionStatus({ connected: true, path: pathName });
```

After a requested `disconnect()` closes successfully, publish:

```ts
this.reportConnectionStatus({
  connected: false,
  reason: 'hardware-disconnected',
  unexpected: false
});
```

Do not publish before `port.close()` succeeds. The existing catch must continue restoring `this.port = port` when the close callback fails and `port.isOpen` remains true.

- [ ] **Step 5: Classify fail-closed transitions with stable reasons**

Change `failPort` to accept a stable reason rather than exposing an arbitrary serial error through the status payload:

```ts
private failPort(port: HardwarePort, error: Error, reason: string) {
  if (this.port !== port) return;
  this.port = undefined;
  if (this.flushTimer) {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }
  this.clearSafetyTimer();
  this.latestFrame = undefined;
  this.failActiveWrites(port, error);
  this.reportConnectionStatus({
    connected: false,
    reason: this.safeDisconnectInProgress ? 'hardware-disconnected-stop-failed' : reason,
    unexpected: !this.safeDisconnectInProgress
  });

  const errorHandler = this.portErrorHandlers.get(port);
  if (!port.isOpen) {
    this.detachPortErrorHandler(port, errorHandler);
    return;
  }
  try {
    port.close(closeError => {
      if (closeError) {
        this.options.onLog?.({ level: 'error', source: 'hardware', message: 'hardware-port-close-failed', details: formatError(closeError) });
      }
      this.schedulePortErrorHandlerDetach(port, errorHandler);
    });
  } catch (closeError) {
    this.options.onLog?.({ level: 'error', source: 'hardware', message: 'hardware-port-close-failed', details: formatError(closeError) });
    this.schedulePortErrorHandlerDetach(port, errorHandler);
  }
}
```

Update its three call sites exactly as follows. Replace the open catch body so the normalized error is both rejected consistently and passed to `failPort`:

```ts
} catch (error) {
  const normalizedError = error instanceof Error ? error : new Error('hardware-open-failed');
  this.failPort(port, normalizedError, 'hardware-open-failed');
  throw normalizedError;
}
```

Use these reason-bearing calls in the timeout and port-error paths:

```ts
this.failPort(port, new Error('hardware-write-timeout'), 'hardware-write-timeout');
this.failPort(port, error, 'hardware-port-error');
```

Keep the original normalized `Error` objects for Promise rejection and logs. Only the renderer-facing reason is constrained to a stable identifier.

- [ ] **Step 6: Implement the bounded user-facing safe disconnect**

Add this public method before raw `disconnect()`:

```ts
async disconnectSafely(): Promise<HardwareDisconnectResult> {
  if (!this.port?.isOpen) {
    await this.disconnect();
    return {
      connected: false,
      stop: { stopped: false, reason: 'hardware-not-connected' }
    };
  }

  this.safeDisconnectInProgress = true;
  try {
    const stop = await this.emergencyStop();
    await this.disconnect();
    return { connected: false, stop };
  } finally {
    this.safeDisconnectInProgress = false;
  }
}
```

Do not add another timer. `emergencyStop()` must continue using `writePayload()`, whose existing configured timeout is 500 ms in production and 20 ms in the focused test.

- [ ] **Step 7: Run the focused test to verify GREEN**

Run:

```powershell
npm.cmd run build:electron
node scripts/hardware-output-test.mjs
```

Expected: `hardware output tests passed`.

- [ ] **Step 8: Commit the controller unit**

Run:

```powershell
git add electron/protocol.ts electron/services/hardware-controller.ts scripts/hardware-output-test.mjs
git commit -m "feat(hardware): add bounded safe disconnect" -m "Constraint: attempt the existing stop payload before releasing the serial port." -m "Rejected: automatic reconnect | reconnecting can re-enable motion unexpectedly." -m "Confidence: high" -m "Scope-risk: moderate"
```

Expected: one commit containing only the controller contract, implementation, and focused regressions.

### Task 2: Typed Electron Status Bridge

**Files:**

- Modify: `src/shared/protocol.ts:62-86`
- Modify: `electron/main.ts:72-75, 193-214`
- Modify: `electron/preload.cts:1-120`
- Modify: `src/global.d.ts:1-90`
- Test: `scripts/preload-format-test.mjs:29-72`

- [ ] **Step 1: Add failing bridge assertions**

Add these assertions after the existing hardware-output assertions in `scripts/preload-format-test.mjs`:

```js
assert.match(mainSource, /onConnectionStatus:\s*status\s*=>\s*sendToRenderer\(mainWindow, ['"]hardware:connection-status['"], status\)/);
assert.match(mainSource, /ipcMain\.handle\(['"]hardware:status['"][\s\S]*?assertTrustedSender\(event\)[\s\S]*?hardware\.getConnectionStatus\(\)/);
assert.match(mainSource, /ipcMain\.handle\(['"]hardware:disconnect['"][\s\S]*?assertTrustedSender\(event\)[\s\S]*?hardware\.disconnectSafely\(\)/);
assert.match(preloadSource, /getHardwareStatus:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]hardware:status['"]\)/);
assert.match(preloadSource, /onHardwareConnectionStatus:\s*\(listener\)/);
assert.match(preloadSource, /ipcRenderer\.on\(['"]hardware:connection-status['"],\s*handler\)/);
assert.match(preloadSource, /removeListener\(['"]hardware:connection-status['"],\s*handler\)/);
```

- [ ] **Step 2: Run the integration test to verify RED**

Run:

```powershell
npm.cmd run build:electron
node scripts/preload-format-test.mjs
```

Expected: assertion failure because `hardware:status` and `hardware:connection-status` are not bridged yet.

- [ ] **Step 3: Mirror the renderer-facing contracts**

Add the same `HardwareConnectionStatus` and `HardwareDisconnectResult` definitions from Task 1 after `HardwareOutputSnapshot` in `src/shared/protocol.ts`.

Import both types in `src/global.d.ts`, then replace the untyped disconnect declaration and add status APIs:

```ts
disconnectHardware: () => Promise<HardwareDisconnectResult>;
getHardwareStatus: () => Promise<HardwareConnectionStatus>;
onHardwareConnectionStatus: (listener: (status: HardwareConnectionStatus) => void) => () => void;
```

- [ ] **Step 4: Forward controller transitions and current status from main**

Update controller construction in `electron/main.ts`:

```ts
const hardware = new HardwareController({
  onLog: entry => addLog(entry),
  onOutput: snapshot => sendToRenderer(mainWindow, 'hardware:output', snapshot),
  onConnectionStatus: status => sendToRenderer(mainWindow, 'hardware:connection-status', status)
});
```

Add a trusted read-only handler and route the existing disconnect handler through the safe operation:

```ts
ipcMain.handle('hardware:status', event => {
  assertTrustedSender(event);
  return hardware.getConnectionStatus();
});
ipcMain.handle('hardware:disconnect', event => {
  assertTrustedSender(event);
  return hardware.disconnectSafely();
});
```

Leave `window-all-closed` using raw `hardware.disconnect()` so app shutdown does not introduce a new stop-wait lifecycle.

- [ ] **Step 5: Expose a narrow preload query and listener**

Import `HardwareConnectionStatus` in `electron/preload.cts` and add:

```ts
getHardwareStatus: () => ipcRenderer.invoke('hardware:status'),
onHardwareConnectionStatus: (listener: (status: HardwareConnectionStatus) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, status: HardwareConnectionStatus) => listener(status);
  ipcRenderer.on('hardware:connection-status', handler);
  return () => ipcRenderer.removeListener('hardware:connection-status', handler);
},
```

Do not expose `ipcRenderer`, event objects, arbitrary channel names, or a generic send function.

- [ ] **Step 6: Build and verify the bridge is GREEN**

Run:

```powershell
npm.cmd run build:electron
node scripts/preload-format-test.mjs
```

Expected: `sandbox preload format: commonjs`.

- [ ] **Step 7: Commit the IPC unit**

Run:

```powershell
git add src/shared/protocol.ts electron/main.ts electron/preload.cts src/global.d.ts scripts/preload-format-test.mjs
git commit -m "feat(hardware): sync serial connection status" -m "Constraint: renderer state must follow the controller rather than infer connection from a past request." -m "Confidence: high" -m "Scope-risk: narrow"
```

Expected: one commit containing the shared types, trusted IPC handlers, preload bridge, and bridge assertions.

### Task 3: Renderer Disconnect Control and State Synchronization

**Files:**

- Modify: `src/App.tsx:132-219, 433-462, 646-660`
- Test: `scripts/preload-format-test.mjs:20-72`

- [ ] **Step 1: Add failing renderer source assertions**

Define a source slice near the existing action slices in `scripts/preload-format-test.mjs`:

```js
const disconnectHardwareSource = sourceSection(appSource, '  async function disconnectHardware()', '  async function testHardware()');
```

Add these assertions with the other hardware-panel checks:

```js
assert.match(disconnectHardwareSource, /window\.hapticRelay\.disconnectHardware\(\)/);
assert.match(disconnectHardwareSource, /setHardwareConnected\(result\.connected\)/);
assert.match(disconnectHardwareSource, /장비 전원을 직접 차단하세요/);
assert.match(appSource, /window\.hapticRelay\.getHardwareStatus\(\)/);
assert.match(appSource, /window\.hapticRelay\.onHardwareConnectionStatus\(nextStatus\s*=>/);
assert.match(appSource, /removeHardwareConnectionStatus\(\)/);
assert.match(hardwarePanelSource, /disabled=\{isBusy \|\| hardwareConnected \|\| !selectedPort\}[\s\S]*?>연결<\/button>/);
assert.match(hardwarePanelSource, /disabled=\{isBusy \|\| !hardwareConnected\}[\s\S]*?onClick=\{disconnectHardware\}>연결 해제<\/button>/);
assert.match(hardwarePanelSource, /disabled=\{isBusy \|\| !hardwareConnected\}[\s\S]*?onClick=\{testHardware\}>테스트<\/button>/);
```

- [ ] **Step 2: Run the source integration test to verify RED**

Run:

```powershell
npm.cmd run build:electron
node scripts/preload-format-test.mjs
```

Expected: assertion failure because the renderer has no disconnect action or hardware-status subscription.

- [ ] **Step 3: Subscribe before querying to avoid a reload race**

Inside the existing long-lived event `useEffect`, add the hardware listener before starting the status query:

```ts
let hardwareStatusEventSeen = false;
const applyHardwareStatus = (nextStatus: HardwareConnectionStatus) => {
  setHardwareConnected(nextStatus.connected);
  if (!nextStatus.connected && nextStatus.unexpected) {
    setStatusMessage(
      'error',
      `하드웨어 연결이 끊겼습니다: ${formatReason(nextStatus.reason ?? 'hardware-not-connected')}. 다시 연결하세요.`
    );
  }
};
const removeHardwareConnectionStatus = window.hapticRelay.onHardwareConnectionStatus(nextStatus => {
  hardwareStatusEventSeen = true;
  applyHardwareStatus(nextStatus);
});
void window.hapticRelay.getHardwareStatus()
  .then(nextStatus => {
    if (!hardwareStatusEventSeen) applyHardwareStatus(nextStatus);
  })
  .catch(error => setStatusMessage('error', formatError(error)));
```

Import `HardwareConnectionStatus` from `./shared/protocol`, and add this cleanup beside the other listener cleanups:

```ts
removeHardwareConnectionStatus();
```

The event-first registration plus `hardwareStatusEventSeen` guard prevents a delayed initial query from overwriting a newer disconnect event.

- [ ] **Step 4: Add the user-facing disconnect action**

Insert this function between `connectHardware()` and `testHardware()`:

```ts
async function disconnectHardware() {
  await runAction('hardware', '정지 명령 전송 후 하드웨어 연결 해제 중', async () => {
    const result = await window.hapticRelay.disconnectHardware();
    setHardwareConnected(result.connected);
    if (!result.stop.stopped && result.stop.reason !== 'hardware-not-connected') {
      setStatusMessage('error', '정지 명령을 확인하지 못했습니다. 장비 전원을 직접 차단하세요.');
      return;
    }
    setStatusMessage('ok', '하드웨어 연결 해제됨');
  });
}
```

Do not call `stopHardware()` separately from the renderer. The main-process `disconnectSafely()` request must remain the single serialized operation.

- [ ] **Step 5: Enforce the hardware button state contract**

Replace the three action buttons in `hardwarePanel` with:

```tsx
<button disabled={isBusy} onClick={() => refreshPorts()}>새로고침</button>
<button disabled={isBusy || hardwareConnected || !selectedPort} onClick={connectHardware}>연결</button>
<button disabled={isBusy || !hardwareConnected} onClick={disconnectHardware}>연결 해제</button>
<button disabled={isBusy || !hardwareConnected} onClick={testHardware}>테스트</button>
```

Do not add automatic reconnect, timers, or motion resumption in the renderer.

- [ ] **Step 6: Build and verify the renderer assertions are GREEN**

Run:

```powershell
npm.cmd run build:electron
node scripts/preload-format-test.mjs
npm.cmd run lint
```

Expected: preload format test prints `sandbox preload format: commonjs`, and TypeScript exits with code 0.

- [ ] **Step 7: Commit the renderer unit**

Run:

```powershell
git add src/App.tsx scripts/preload-format-test.mjs
git commit -m "feat(ui): add safe hardware disconnect control" -m "Constraint: disconnect must stop first and keep the UI aligned with the serial controller." -m "Rejected: renderer-side stop and close calls | separate IPC requests can race." -m "Confidence: high" -m "Scope-risk: narrow"
```

Expected: one commit containing only the UI behavior and its source integration assertions.

### Task 4: Full Automated Gate and COM3 Handoff

**Files:**

- Verify only; no source file changes expected.

- [ ] **Step 1: Run the focused controller regression again**

Run:

```powershell
npm.cmd run build:electron
node scripts/hardware-output-test.mjs
```

Expected: `hardware output tests passed` with no unhandled `error` event and no timeout race.

- [ ] **Step 2: Run all Electron tests**

Run:

```powershell
npm.cmd run test:electron
```

Expected: every Electron script exits with code 0, including preload, settings, window messenger, T-Code encoder, and hardware output.

- [ ] **Step 3: Run renderer build and UI smoke tests**

Run:

```powershell
npm.cmd run test:ui
```

Expected: Vite production build succeeds and the Electron UI smoke test exits with code 0.

- [ ] **Step 4: Run final static checks**

Run:

```powershell
npm.cmd run lint
npm.cmd run build
git diff --check
git status --short
```

Expected: all commands exit with code 0; `git diff --check` is silent; the worktree has no uncommitted implementation files.

- [ ] **Step 5: Review the final range before physical access**

Run:

```powershell
git log --oneline --decorate -6
git diff --stat c200a5e..HEAD
git diff --check c200a5e..HEAD
```

Expected: exactly the planned controller, bridge, renderer, and test files appear after the design commit; no `.env`, credential, installer, or unrelated server file appears.

- [ ] **Step 6: Stop before physical COM3 motion and request user readiness**

Report the automated results and ask the user to confirm all of the following before opening COM3:

```text
- COM3 is still the intended device.
- The mechanism is unloaded and clear of people/objects.
- An independent power cutoff is within reach.
- Initial profile is 115200 / L0 / no vibration / stroke 0.20..0.80.
```

Only after that confirmation, follow the acceptance sequence in `docs/superpowers/specs/2026-08-22-hardware-disconnect-design.md`. Do not deliberately unplug or stall a moving physical device to test failure handling.
