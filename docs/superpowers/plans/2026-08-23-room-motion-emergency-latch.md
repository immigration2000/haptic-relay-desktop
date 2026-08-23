# Room Motion and Emergency Latch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the streamer's last commanded position during normal room operation, move to the configured absolute stop position only for room exit or emergency stop, and require an explicit local emergency release before motion can resume.

**Architecture:** `HardwareController` owns a runtime-only `emergencyStopped` latch that is independent of receive pause, plus short-lived room-exit and port-disconnect gates. `electron/main.ts` coordinates reliable room-wide stop, local release, room-leave stop, and conditional application shutdown; the renderer mirrors the main-process latch but never acts as its authority.

**Tech Stack:** TypeScript, Electron IPC/context bridge, React 19, SerialPort, Socket.IO, Node assertion scripts, Chrome DevTools Protocol UI smoke tests.

---

## File map

- Modify `electron/protocol.ts`: define emergency state, plain disconnect, and room-leave result contracts.
- Modify `src/shared/protocol.ts`: keep the renderer copy of those contracts byte-for-byte aligned.
- Modify `electron/services/hardware-controller.ts`: own the emergency latch, remove inactivity movement, separate room-exit stop from plain disconnect, and keep receive pause independent.
- Modify `electron/tuning.ts`: remove the obsolete hardware inactivity timeout setting and normalizer.
- Modify `scripts/hardware-output-test.mjs`: behavior-level regression coverage for latch, release, inactivity, room-exit stop, test cancellation, and disconnect.
- Modify `electron/services/relay-client.ts`: expose whether a room session is active without exposing session internals.
- Modify `electron/main.ts`: coordinate local/remote stop, release, room leave, and conditional shutdown.
- Modify `electron/preload.cts`: expose emergency-state query and local release IPC.
- Modify `src/global.d.ts`: type the new preload API and room-leave result.
- Modify `src/App.tsx`: display and control the local latch, surface room-leave failures, and remove stop-before-disconnect messaging.
- Modify `scripts/preload-format-test.mjs`: lock the IPC trust boundary and lifecycle orchestration contracts.
- Modify `scripts/relay-smoke-test.mjs`: verify active-room lifecycle state and retain reliable stop delivery.
- Modify `scripts/electron-ui-smoke-test.mjs`: exercise stop → latched UI → local release without hardware.
- Modify `README.md`, `docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION_GUIDE.md`, `docs/HARDWARE_SESSION_CHECKLIST.md`, `docs/DEVELOPMENT_HANDOFF.md`, and `docs/ROADMAP.md`: publish the new operator and developer contract.
- Modify `docs/superpowers/specs/2026-08-22-emergency-stop-position-design.md` and `docs/superpowers/plans/2026-08-22-emergency-stop-position.md`: mark their disconnect coupling as superseded historical guidance.

### Task 1: Define the emergency contract and controller latch

**Files:**
- Modify: `electron/protocol.ts:79-114`
- Modify: `src/shared/protocol.ts:79-114`
- Modify: `scripts/hardware-output-test.mjs:193-263`
- Modify: `electron/services/hardware-controller.ts:65-317`

- [ ] **Step 1: Write failing controller tests for latch ownership and explicit release**

Replace the old `pauseAndStop()` assertions with an isolated controller block that proves the new state machine:

```js
const latchOutputs = [];
let latchPort;
const latchController = new HardwareController({
  createPort: options => {
    latchPort = new FakePort(options.path);
    return latchPort;
  },
  onOutput: output => latchOutputs.push(output),
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});

assert.deepEqual(latchController.getEmergencyStopState(), { emergencyStopped: false });
await latchController.connect('COM21', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0.2,
  strokeMax: 0.8,
  stopPosition: 0.35,
  invertPosition: false
});

assert.deepEqual(await latchController.latchEmergencyStop(), {
  stopped: true,
  emergencyStopped: true
});
assert.equal(latchOutputs.at(-1).command, 'DSTOP\nL03500I1');
assert.deepEqual(
  latchController.queueMotion({ position: 0.8, intensity: 0.25, timestamp: Date.now() }),
  { queued: false, reason: 'hardware-emergency-stopped' }
);
assert.deepEqual(await latchController.runTestPattern(), {
  tested: false,
  reason: 'hardware-emergency-stopped'
});

const writesBeforeRelease = latchPort.writes.length;
assert.deepEqual(latchController.releaseEmergencyStop(), { emergencyStopped: false });
assert.equal(latchPort.writes.length, writesBeforeRelease, 'release emits no serial payload');
assert.equal(
  latchController.queueMotion({ position: 0.8, intensity: 0.25, timestamp: Date.now() }).queued,
  true
);
await waitFor(() => latchOutputs.at(-1)?.kind === 'motion');
```

Add independence and lifecycle assertions:

```js
await latchController.latchEmergencyStop();
await latchController.setProtection({
  intensityLimit: 1,
  positionMin: 0,
  positionMax: 1,
  paused: false
});
assert.deepEqual(latchController.getEmergencyStopState(), { emergencyStopped: true });

await latchController.disconnect();
await latchController.connect('COM22', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0.2,
  strokeMax: 0.8,
  stopPosition: 0.35,
  invertPosition: false
});
assert.deepEqual(latchController.getEmergencyStopState(), { emergencyStopped: true });

latchController.releaseEmergencyStop();
const writesBeforePause = latchPort.writes.length;
const pausedProtection = await latchController.setProtection({
  intensityLimit: 1,
  positionMin: 0,
  positionMax: 1,
  paused: true
});
assert.deepEqual(pausedProtection, {
  protection: { intensityLimit: 1, positionMin: 0, positionMax: 1, paused: true }
});
assert.equal(latchPort.writes.length, writesBeforePause, 'receive pause does not move hardware');
assert.deepEqual(latchController.releaseEmergencyStop(), { emergencyStopped: false });
assert.deepEqual(
  latchController.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() }),
  { queued: false, reason: 'protection-paused' }
);

await latchController.setProtection({
  intensityLimit: 1,
  positionMin: 0,
  positionMax: 1,
  paused: false
});
const testOutputStart = latchOutputs.length;
assert.deepEqual(await latchController.runTestPattern(), { tested: true, steps: 4 });
assert.equal(
  latchOutputs.slice(testOutputStart).some(output => output.kind === 'stop'),
  false,
  'normal hardware test completion does not move to the emergency position'
);

const restartedController = new HardwareController({ probeTimeoutMs: 0, writeTimeoutMs: 20 });
assert.deepEqual(restartedController.getEmergencyStopState(), { emergencyStopped: false });
```

Update the remaining emergency-specific calls in this test file as follows:

```js
// Stalled stop: the software latch remains active even when the write fails.
const stalledStopResult = await Promise.race([
  controller.latchEmergencyStop(),
  delay(100).then(() => ({ timedOut: true }))
]);
assert.deepEqual(stalledStopResult, {
  stopped: false,
  reason: 'hardware-stop-write-failed',
  emergencyStopped: true
});
assert.deepEqual(controller.getEmergencyStopState(), { emergencyStopped: true });

// Test cancellation and absolute-position encoder cases use the latched operation.
assert.deepEqual(await cancelledPatternController.latchEmergencyStop(), {
  stopped: true,
  emergencyStopped: true
});
await legacyStopController.latchEmergencyStop();
```

Use `stopForRoomExit()` only in the dedicated room-exit payload test added in Task 2. No final test should call the removed generic `emergencyStop()` or `pauseAndStop()` methods.

- [ ] **Step 2: Run the focused test and verify the red state**

Run:

```powershell
npm.cmd run build:electron
node scripts/hardware-output-test.mjs
```

Expected: FAIL because `getEmergencyStopState`, `latchEmergencyStop`, and `releaseEmergencyStop` do not exist and the old stop result exposes `protection` instead of `emergencyStopped`.

- [ ] **Step 3: Update both protocol copies with the exact new contracts**

Apply the same block to `electron/protocol.ts` and `src/shared/protocol.ts`:

```ts
export type HardwareStopResult = {
  stopped: boolean;
  reason?: string;
};

export type HardwareEmergencyState = {
  emergencyStopped: boolean;
};

export type HardwareLatchedStopResult = HardwareStopResult & HardwareEmergencyState;

export type HardwareProtectionResult = {
  protection: HardwareProtection;
};

export type HardwareDisconnectResult = {
  connected: false;
};

export type RoomDisconnectResult = HardwareDisconnectResult & {
  stop: HardwareStopResult;
};
```

- [ ] **Step 4: Implement the dedicated controller latch and stop primitive**

Add controller state:

```ts
private emergencyStopped = false;
private lifecycleTransition: 'disconnect' | 'room-exit' | undefined;
```

Replace `pauseAndStop()` with these public operations and keep the existing stop payload/write-error body in `writeStopPayload()`:

```ts
getEmergencyStopState() {
  return { emergencyStopped: this.emergencyStopped };
}

async latchEmergencyStop() {
  this.emergencyStopped = true;
  const stop = await this.writeStopPayload();
  return { ...stop, emergencyStopped: true };
}

releaseEmergencyStop() {
  this.emergencyStopped = false;
  this.options.onLog?.({ level: 'info', source: 'hardware', message: 'hardware-emergency-released' });
  return { emergencyStopped: false };
}

async stopForRoomExit() {
  this.lifecycleTransition = 'room-exit';
  try {
    return await this.writeStopPayload();
  } finally {
    if (this.lifecycleTransition === 'room-exit') this.lifecycleTransition = undefined;
  }
}

private async writeStopPayload() {
  this.operationGeneration += 1;
  if (this.flushTimer) {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }
  this.latestFrame = undefined;

  if (!this.port?.isOpen) {
    return { stopped: false, reason: 'hardware-not-connected' };
  }

  const payload = encodeTCodeStop({
    linearAxis: this.profile.linearAxis,
    vibrationAxis: this.profile.vibrationAxis,
    stopPosition: this.profile.stopPosition
  });
  const writeError = await this.writePayload(payload).then(() => {
    this.reportOutput('stop', payload);
    return undefined;
  }).catch(error => {
    console.error('hardware emergency stop failed', error);
    this.options.onLog?.({ level: 'error', source: 'hardware', message: 'hardware-stop-write-failed', details: formatError(error) });
    return error;
  });

  if (writeError) return { stopped: false, reason: 'hardware-stop-write-failed' };
  this.options.onLog?.({ level: 'warning', source: 'hardware', message: 'hardware-stopped' });
  return { stopped: true };
}

// Temporary compatibility bridge. Remove in Task 3 after every main-process
// caller uses latchEmergencyStop(). Do not commit this bridge by itself.
async pauseAndStop() {
  const result = await this.latchEmergencyStop();
  return { ...result, protection: this.protection };
}
```

Change motion admission before the port check:

```ts
if (this.lifecycleTransition) {
  return {
    queued: false,
    reason: this.lifecycleTransition === 'disconnect'
      ? 'hardware-disconnecting'
      : 'hardware-room-exit-stopping'
  };
}
if (this.emergencyStopped) {
  this.latestFrame = undefined;
  return { queued: false, reason: 'hardware-emergency-stopped' };
}
```

Make `setProtection()` update only protection and logs:

```ts
async setProtection(protection: HardwareProtection) {
  this.protection = normalizeProtection(protection);
  this.options.onLog?.({
    level: this.protection.paused ? 'warning' : 'info',
    source: 'protection',
    message: this.protection.paused ? 'receive-paused' : 'protection-updated',
    details: `intensity<=${this.protection.intensityLimit.toFixed(2)}, position ${this.protection.positionMin.toFixed(2)}-${this.protection.positionMax.toFixed(2)}`
  });
  return { protection: this.protection };
}
```

At the beginning of `runTestPattern()` add:

```ts
if (this.emergencyStopped) {
  return { tested: false, reason: 'hardware-emergency-stopped' };
}
```

Remove the `finally` call that automatically invokes a stop payload. Operation-generation cancellation remains, so an emergency or room exit cancels the test and owns the one allowed stop write.

- [ ] **Step 5: Run the focused test and verify the green state**

Run:

```powershell
npm.cmd run build:electron
node scripts/hardware-output-test.mjs
```

Expected: `hardware output tests passed`.

- [ ] **Step 6: Record the controller checkpoint without committing**

```powershell
git diff --check
git status --short
```

Expected: only the Task 1 files are modified and diff-check is clean. Keep the changes uncommitted because the shared protocol consumers are migrated atomically in Task 4.

### Task 2: Remove inactivity movement and make hardware disconnect close-only

**Files:**
- Modify: `electron/tuning.ts:1-20`
- Modify: `electron/services/hardware-controller.ts:10-18, 72-84, 147-226, 353-372, 453-468`
- Modify: `scripts/hardware-output-test.mjs:6-75, 331-462`

- [ ] **Step 1: Write failing no-inactivity and close-only disconnect tests**

Add close control to `FakePort`:

```js
this.stallNextClose = false;
this.pendingClose = undefined;
```

At the start of `close(callback)` add:

```js
if (this.stallNextClose) {
  this.stallNextClose = false;
  this.pendingClose = callback;
  return;
}
```

Add a helper method:

```js
completeClose() {
  const callback = this.pendingClose;
  assert.ok(callback, 'no pending close');
  this.pendingClose = undefined;
  this.close(callback);
}
```

Replace safe-disconnect cases with a close-only case:

```js
const disconnectOutputs = [];
const disconnectPort = new FakePort('COM13');
const disconnectController = new HardwareController({
  createPort: () => disconnectPort,
  onOutput: output => disconnectOutputs.push(output),
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await disconnectController.connect('COM13', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  stopPosition: 0.6,
  invertPosition: false
});
disconnectPort.stallNextClose = true;
const writesBeforeDisconnect = disconnectPort.writes.length;
const disconnectPromise = disconnectController.disconnect();
assert.deepEqual(
  disconnectController.queueMotion({ position: 0.8, intensity: 0.25, timestamp: Date.now() }),
  { queued: false, reason: 'hardware-disconnecting' }
);
assert.equal(disconnectPort.writes.length, writesBeforeDisconnect, 'disconnect sends no stop payload');
disconnectPort.completeClose();
assert.deepEqual(await disconnectPromise, { connected: false });
assert.equal(disconnectOutputs.some(output => output.kind === 'stop'), false);
```

Add a separate room-exit case proving that the same physical payload does not release or create a latch:

```js
const roomExitOutputs = [];
const roomExitPort = new FakePort('COM24');
const roomExitController = new HardwareController({
  createPort: () => roomExitPort,
  onOutput: output => roomExitOutputs.push(output),
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await roomExitController.connect('COM24', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0.2,
  strokeMax: 0.8,
  stopPosition: 0.35,
  invertPosition: false
});
assert.deepEqual(await roomExitController.stopForRoomExit(), { stopped: true });
assert.equal(roomExitOutputs.at(-1).command, 'DSTOP\nL03500I1');
assert.deepEqual(roomExitController.getEmergencyStopState(), { emergencyStopped: false });
assert.equal(
  roomExitController.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() }).queued,
  true
);
await waitFor(() => roomExitOutputs.at(-1)?.kind === 'motion');
await roomExitController.latchEmergencyStop();
await roomExitController.stopForRoomExit();
assert.deepEqual(
  roomExitController.getEmergencyStopState(),
  { emergencyStopped: true },
  'room exit does not release an existing emergency latch'
);
await roomExitController.disconnect();
```

Add an inactivity regression using the old default timeout boundary:

```js
const idleOutputs = [];
const idlePort = new FakePort('COM23');
const idleController = new HardwareController({
  createPort: () => idlePort,
  onOutput: output => idleOutputs.push(output),
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await idleController.connect('COM23', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  stopPosition: 0.35,
  invertPosition: false
});
idleController.queueMotion({ position: 0.7, intensity: 0.25, timestamp: Date.now() });
await waitFor(() => idleOutputs.length === 1);
idleController.queueMotion({ position: 0.7, intensity: 0.25, timestamp: Date.now() });
await waitFor(() => idleOutputs.length === 2);
assert.deepEqual(idleOutputs.map(output => output.command), ['L07000I17', 'L07000I17']);
await delay(1_100);
assert.deepEqual(idleOutputs.map(output => output.kind), ['motion', 'motion']);
assert.equal(idlePort.writes.some(payload => payload.includes('DSTOP')), false);
await idleController.disconnect();
```

- [ ] **Step 2: Run the focused test and verify the red state**

Run:

```powershell
npm.cmd run build:electron
node scripts/hardware-output-test.mjs
```

Expected: FAIL because inactivity still emits `DSTOP`, `disconnect()` has no explicit transition gate, and old `disconnectSafely()` assertions still expect stop-before-close.

- [ ] **Step 3: Remove the inactivity timer and environment setting**

Delete `HARDWARE_SAFETY_TIMEOUT_MS` and `normalizeOptionalTimeoutMs` from `electron/tuning.ts`. Remove their imports, `safetyTimer`, `safetyTimeoutMs`, `scheduleSafetyStop()`, `clearSafetyTimer()`, and every call to those timer methods from `HardwareController`.

After setting `latestFrame`, normal queueing must be only:

```ts
this.latestFrame = protectedFrame;
this.scheduleFlush();
return { queued: true };
```

- [ ] **Step 4: Put the disconnect gate inside raw port disconnection**

Wrap the existing `disconnect()` body with the lifecycle transition, preserving close-failure restoration and failed-port cleanup:

```ts
async disconnect() {
  this.lifecycleTransition = 'disconnect';
  try {
    this.operationGeneration += 1;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.latestFrame = undefined;

    const port = this.port;
    if (!port?.isOpen) {
      if (port) {
        this.detachPortErrorHandler(port);
        this.detachPortCloseHandler(port);
      }
      this.port = undefined;
      await this.retryFailedPortCleanup();
      this.reportConnectionStatus({ connected: false, reason: 'hardware-disconnected', unexpected: false });
      return { connected: false as const };
    }

    this.port = undefined;
    this.failActiveWrites(port, new Error('hardware-disconnected'));
    const errorHandler = this.portErrorHandlers.get(port);
    const closeHandler = this.portCloseHandlers.get(port);
    try {
      await new Promise<void>((resolve, reject) => {
        port.close(error => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      if (!this.port && port.isOpen) this.port = port;
      throw error;
    } finally {
      this.schedulePortHandlersDetach(port, errorHandler, closeHandler);
    }
    this.reportConnectionStatus({ connected: false, reason: 'hardware-disconnected', unexpected: false });
    this.options.onLog?.({ level: 'info', source: 'hardware', message: 'hardware-disconnected' });
    return { connected: false as const };
  } finally {
    if (this.lifecycleTransition === 'disconnect') this.lifecycleTransition = undefined;
  }
}
```

Temporarily replace `disconnectSafely()` with a close-only compatibility bridge so `electron/main.ts` continues compiling until Task 3 switches its caller:

```ts
async disconnectSafely() {
  const result = await this.disconnect();
  return {
    ...result,
    stop: { stopped: false, reason: 'hardware-not-connected' }
  };
}
```

This bridge sends no stop payload. Remove it in Task 3 and do not commit it as a final API.

In `failPort()`, replace the removed safe-disconnect flag with transition-aware reporting:

```ts
const expectedTransition = this.lifecycleTransition !== undefined;
this.reportConnectionStatus({
  connected: false,
  reason: this.lifecycleTransition === 'room-exit' ? 'hardware-room-exit-stop-failed' : reason,
  unexpected: !expectedTransition
});
```

- [ ] **Step 5: Run controller and type checks**

Run:

```powershell
npm.cmd run build:electron
node scripts/hardware-output-test.mjs
```

Expected: all commands exit `0`; focused output ends with `hardware output tests passed`.

- [ ] **Step 6: Record the close-only checkpoint without committing**

```powershell
git diff --check
git status --short
```

Expected: Task 1 and Task 2 changes are present and diff-check is clean. Keep them uncommitted until Task 4 completes the vertical protocol migration.

### Task 3: Coordinate room stop, room leave, and application shutdown

**Files:**
- Modify: `electron/services/relay-client.ts:121-370`
- Modify: `electron/main.ts:80-110, 229-239, 327-344, 516-533`
- Modify: `scripts/preload-format-test.mjs:65-100`
- Modify: `scripts/relay-smoke-test.mjs:112-240`

- [ ] **Step 1: Write failing lifecycle contract assertions**

Replace the obsolete source assertions in `scripts/preload-format-test.mjs` with:

```js
assert.match(mainSource, /ipcMain\.handle\(['"]hardware:disconnect['"][\s\S]*?assertTrustedSender\(event\)[\s\S]*?hardware\.disconnect\(\)/);
assert.match(mainSource, /ipcMain\.handle\(['"]hardware:emergency-stop['"][\s\S]*?relay\.clearBufferedMotion\(\)[\s\S]*?hardware\.latchEmergencyStop\(\)/);
assert.match(mainSource, /ipcMain\.handle\(['"]hardware:emergency-release['"][\s\S]*?assertTrustedSender\(event\)[\s\S]*?hardware\.releaseEmergencyStop\(\)/);
assert.match(mainSource, /room:emergency-stop[\s\S]*?hardware\.latchEmergencyStop\(\)[\s\S]*?hardwareResult/);
assert.match(mainSource, /ipcMain\.handle\(['"]room:emergency-stop['"][\s\S]*?const relayStop = relay\.emergencyStop\(\)[\s\S]*?const hardwareStop = hardware\.latchEmergencyStop\(\)[\s\S]*?Promise\.all\(\[hardwareStop, relayStop\]\)/);
assert.match(mainSource, /ipcMain\.handle\(['"]room:disconnect['"][\s\S]*?hardware\.stopForRoomExit\(\)[\s\S]*?relay\.disconnect\(\)[\s\S]*?stop/);
assert.match(mainSource, /status\.status === ['"]removed['"][\s\S]*?hardware\.stopForRoomExit\(\)/);
assert.match(mainSource, /function shutdownApplication\(\)[\s\S]*?relay\.hasActiveRoom\(\)[\s\S]*?hardware\.stopForRoomExit\(\)[\s\S]*?relay\.disconnect\(\)[\s\S]*?hardware\.disconnect\(\)/);
assert.doesNotMatch(mainSource, /pauseAndStop|disconnectSafely/);
```

In `scripts/relay-smoke-test.mjs`, after `mixedProtocolViewer.joinRoom(...)` add:

```js
assert.equal(mixedProtocolViewer.hasActiveRoom(), true, 'joined RelayClient reports an active room');
```

After the room-stop assertions and after that client is no longer needed, add:

```js
mixedProtocolViewer.disconnect();
assert.equal(mixedProtocolViewer.hasActiveRoom(), false, 'disconnect clears active room state');
```

- [ ] **Step 2: Run the focused integration checks and verify the red state**

Run:

```powershell
npm.cmd run build:server
npm.cmd run build:electron
node scripts/preload-format-test.mjs
node scripts/relay-smoke-test.mjs
```

Expected: source contract FAIL for the new handlers/orchestration and relay smoke FAIL because `hasActiveRoom()` does not exist.

- [ ] **Step 3: Add the active-room boundary to `RelayClient`**

Add this public query without exposing tokens or mutable session objects:

```ts
hasActiveRoom() {
  return Boolean(this.session && this.roomName);
}
```

Do not add a relay release event. Existing `room:stop` remains reliable and continues clearing incoming/outgoing buffered motion.

- [ ] **Step 4: Replace main-process stop and release handlers**

Use `latchEmergencyStop()` in the received-stop callback, local handler, and host room-wide handler. Add the state query and release handlers:

```ts
ipcMain.handle('hardware:emergency-state', event => {
  assertTrustedSender(event);
  return hardware.getEmergencyStopState();
});
ipcMain.handle('hardware:emergency-stop', event => {
  assertTrustedSender(event);
  demoMotionStream.stop();
  relay.clearBufferedMotion();
  return hardware.latchEmergencyStop();
});
ipcMain.handle('hardware:emergency-release', event => {
  assertTrustedSender(event);
  return hardware.releaseEmergencyStop();
});
```

Keep host fanout concurrent:

```ts
const relayStop = relay.emergencyStop().catch(error => {
  addLog({ level: 'error', source: 'relay', message: 'room-stop-failed', details: formatError(error) });
  return { sent: false, reason: 'room-stop-failed' };
});
const hardwareStop = hardware.latchEmergencyStop();
const [hardwareResult, relayResult] = await Promise.all([hardwareStop, relayStop]);
return { hardware: hardwareResult, relay: relayResult };
```

After these callers are switched, delete the temporary `pauseAndStop()` and `disconnectSafely()` compatibility bridges from `HardwareController` and remove its now-unused `HardwareDisconnectResult` type import.

Treat a forced viewer removal, kick, block, or host-ended room as a room exit. In the existing viewer-status callback, start the same bounded local stop before forwarding the status:

```ts
if (status.status === 'removed') {
  void hardware.stopForRoomExit().then(stop => {
    if (!stop.stopped && stop.reason !== 'hardware-not-connected') {
      addLog({ level: 'error', source: 'hardware', message: 'hardware-room-exit-stop-failed', details: stop.reason });
    }
  });
}
sendToRenderer(mainWindow, 'room:viewer-status', status);
```

Do not stop on transient Socket.IO disconnect/reconnect because the active room session is retained and rejoined.

- [ ] **Step 5: Implement room-leave and shutdown branching**

Make room disconnect block hardware output synchronously, disconnect relay input, then await the bounded stop result:

```ts
ipcMain.handle('room:disconnect', async event => {
  assertTrustedSender(event);
  demoMotionStream.stop();
  addLog({ level: 'info', source: 'relay', message: 'relay-disconnect-requested' });
  const stopPromise = hardware.stopForRoomExit();
  const relayResult = relay.disconnect();
  const stop = await stopPromise;
  return { ...relayResult, stop };
});
```

Branch shutdown on the room state captured before relay cleanup:

```ts
const wasInRoom = relay.hasActiveRoom();
demoMotionStream.stop();
const stopPromise = wasInRoom
  ? hardware.stopForRoomExit()
  : Promise.resolve(undefined);
relay.disconnect();

const stop = await stopPromise;
if (stop && !stop.stopped && stop.reason !== 'hardware-not-connected') {
  addLog({ level: 'error', source: 'hardware', message: 'hardware-room-exit-stop-failed', details: stop.reason });
}
await hardware.disconnect();
```

Retain the existing shutdown promise and `before-quit` recursion guards so app exit stays bounded.

- [ ] **Step 6: Run integration checks**

Run:

```powershell
npm.cmd run test:smoke
npm.cmd run test:electron
```

Expected: relay smoke summary reports all checks passed and Electron tests end with `hardware output tests passed`.

- [ ] **Step 7: Record the main-process checkpoint without committing**

```powershell
git diff --check
git status --short
```

Expected: Task 1-3 files are modified and no current main-process caller uses a compatibility bridge. Keep the vertical slice uncommitted until renderer consumers are updated in Task 4.

### Task 4: Expose and render explicit local emergency release

**Files:**
- Modify: `electron/preload.cts:1-45`
- Modify: `src/global.d.ts:1-84`
- Modify: `src/App.tsx:80-210, 457-510, 648-714, 794-818, 1019-1039, 1203-1295`
- Modify: `scripts/preload-format-test.mjs:1-145`
- Modify: `scripts/electron-ui-smoke-test.mjs:216-228`

- [ ] **Step 1: Write failing preload and UI assertions**

Add preload source assertions:

```js
assert.match(preloadSource, /getHardwareEmergencyState:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]hardware:emergency-state['"]\)/);
assert.match(preloadSource, /releaseHardwareStop:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]hardware:emergency-release['"]\)/);
assert.match(appSource, /useState\(false\)[\s\S]*?getHardwareEmergencyState\(\)/);
assert.match(appSource, /async function releaseEmergencyStop\(\)[\s\S]*?releaseHardwareStop\(\)/);
assert.match(appSource, /viewerTab === ['"]safety['"][\s\S]*?emergencyStopPanel/);
assert.match(appSource, /긴급정지 해제/);
assert.doesNotMatch(appSource, /async function leaveRoom\(\)[\s\S]*?setEmergencyStopped\(false\)[\s\S]*?async function localEmergencyStop/);
```

Replace the current emergency portion of `scripts/electron-ui-smoke-test.mjs` with:

```js
await clickButton(cdp, '보호 설정');
await waitForExpression(cdp, `document.body.innerText.includes('MOTION PROTECTION')`);
await clickButton(cdp, '긴급 정지');
await waitForExpression(cdp, `[...document.querySelectorAll('button')].some(button => button.textContent.includes('긴급정지 해제'))`);
assert.equal(
  await cdp.evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find(item => item.textContent.includes('수신 일시정지'));
    return label?.querySelector('input')?.checked;
  })()`),
  false,
  'emergency latch does not enable receive pause'
);
assert.equal(
  await cdp.evaluate(`document.body.innerText.includes('릴레이 서버에 연결되어 있지 않습니다')`),
  false,
  'host emergency stop uses the active room relay'
);
await clickButton(cdp, '긴급정지 해제');
await waitForExpression(cdp, `document.body.innerText.includes('긴급정지 해제됨')`);
await waitForExpression(cdp, `[...document.querySelectorAll('button')].some(button => button.textContent.trim() === '긴급 정지')`);
```

- [ ] **Step 2: Run the focused UI contracts and verify the red state**

Run:

```powershell
npm.cmd run build
node scripts/preload-format-test.mjs
node scripts/electron-ui-smoke-test.mjs
```

Expected: preload/source assertions FAIL before the new API exists; UI cannot find **긴급정지 해제**.

- [ ] **Step 3: Add preload and global type contracts**

Add `HardwareEmergencyState` and `RoomDisconnectResult` to the type import from `./protocol.js` in `electron/preload.cts`. Add the same two names to the type import from `./shared/protocol` in `src/global.d.ts`. Expose:

```ts
getHardwareEmergencyState: (): Promise<HardwareEmergencyState> => ipcRenderer.invoke('hardware:emergency-state'),
stopHardware: () => ipcRenderer.invoke('hardware:emergency-stop'),
releaseHardwareStop: (): Promise<HardwareEmergencyState> => ipcRenderer.invoke('hardware:emergency-release'),
disconnectRoom: (): Promise<RoomDisconnectResult> => ipcRenderer.invoke('room:disconnect')
```

Type the renderer API as:

```ts
getHardwareEmergencyState: () => Promise<HardwareEmergencyState>;
stopHardware: () => Promise<HardwareLatchedStopResult>;
releaseHardwareStop: () => Promise<HardwareEmergencyState>;
disconnectRoom: () => Promise<RoomDisconnectResult>;
```

Add `HardwareEmergencyState` to the existing `./shared/protocol` type import in `src/App.tsx` for the state synchronization helper used in the next step.

- [ ] **Step 4: Mirror the authoritative latch in `App`**

Add state plus a revision guard so an older initial query cannot overwrite a newer local or received stop:

```tsx
const [emergencyStopped, setEmergencyStopped] = useState(false);
const emergencyStateRevisionRef = useRef(0);

function applyEmergencyState(state: HardwareEmergencyState) {
  emergencyStateRevisionRef.current += 1;
  setEmergencyStopped(state.emergencyStopped);
}

const requestedRevision = emergencyStateRevisionRef.current;
void window.hapticRelay.getHardwareEmergencyState()
  .then(result => {
    if (requestedRevision === emergencyStateRevisionRef.current) applyEmergencyState(result);
  })
  .catch(error => setStatusMessage('error', formatError(error)));
```

In local, host, and received stop paths replace protection synchronization with:

```tsx
applyEmergencyState(result);
```

or for received/host results:

```tsx
applyEmergencyState(result.hardware);
```

Keep direct-power-cut guidance for `hardware-stop-write-failed`, but describe an unconnected device as a latched software stop rather than a total stop failure.

Use this local stop result handling after `applyEmergencyState(result)`:

```tsx
if (!result.stopped) {
  if (result.reason === 'hardware-stop-write-failed') {
    setStatusMessage('error', '긴급 정지는 활성화됐지만 하드웨어 정지 명령을 쓰지 못했습니다. 장비 전원을 직접 차단하세요.');
    return;
  }
  setStatusMessage('warning', `긴급정지 활성화됨: ${formatReason(result.reason ?? 'hardware-not-connected')}`);
  return;
}
setStatusMessage('warning', '로컬 긴급정지 활성화됨');
```

Remove the obsolete `result.stop` branch from receive-protection application so pause changes do not claim to write a stop payload:

```tsx
async function applyHardwareProtection() {
  await runAction('hardware', '보호 옵션 적용 중', async setActionStatus => {
    const result = await window.hapticRelay.setHardwareProtection(hardwareProtection);
    setHardwareProtection(result.protection);
    setActionStatus(
      result.protection.paused ? 'warning' : 'ok',
      result.protection.paused ? '수신 일시정지 적용됨' : '보호 옵션 적용됨'
    );
  });
}
```

Add local release with the existing action-generation ownership pattern:

```tsx
async function releaseEmergencyStop() {
  const actionGeneration = ++actionGenerationRef.current;
  setBusyAction('stop');
  setStatusMessage('busy', '긴급정지 해제 중');
  try {
    const result = await window.hapticRelay.releaseHardwareStop();
    applyEmergencyState(result);
    setStatusMessage('ok', '긴급정지 해제됨');
  } catch (error) {
    setStatusMessage('error', formatError(error));
  } finally {
    if (actionGeneration === actionGenerationRef.current) setBusyAction(undefined);
  }
}
```

- [ ] **Step 5: Render one role-aware emergency panel everywhere safety controls appear**

Create one JSX value and reuse it for host, viewer, and standalone safety screens:

```tsx
const roomWideStop = screen === 'host-room';
const emergencyStopPanel = (
  <section className="panel danger-panel" data-emergency-stopped={emergencyStopped}>
    <div>
      <h2>{emergencyStopped ? '긴급정지 활성' : roomWideStop ? '전체 긴급 정지' : '로컬 긴급 정지'}</h2>
      <p className="muted">
        {emergencyStopped
          ? '내 장비는 직접 해제하기 전까지 움직이지 않습니다. 해제는 다른 참여자에게 적용되지 않습니다.'
          : roomWideStop
            ? '자신과 현재 참여자에게 긴급 정지를 전송합니다.'
            : '이 장비의 모션 출력을 잠그고 안전 위치로 이동합니다.'}
      </p>
    </div>
    <button
      className={emergencyStopped ? undefined : 'danger-action'}
      disabled={busyAction === 'stop'}
      onClick={emergencyStopped ? releaseEmergencyStop : roomWideStop ? emergencyStop : localEmergencyStop}
    >
      <OctagonX size={17} /> {emergencyStopped ? '긴급정지 해제' : '긴급 정지'}
    </button>
  </section>
);
```

Render `{protectionPanel}{emergencyStopPanel}` in host safety, viewer safety, and `SafetyView`. Do not add a relay release call.

- [ ] **Step 6: Update leave and disconnect renderer messages**

Make hardware disconnect close-only:

```tsx
await runAction('hardware', '하드웨어 연결 해제 중', async setActionStatus => {
  const result = await window.hapticRelay.disconnectHardware();
  setHardwareConnected(result.connected);
  setActionStatus('ok', '하드웨어 연결 해제됨');
});
```

After room leave returns, preserve navigation but report only a real connected-device stop failure:

```tsx
const result = await window.hapticRelay.disconnectRoom();
const stopFailed = !result.stop.stopped && result.stop.reason !== 'hardware-not-connected';
setMotionDemoActive(false);
setApprovalRequests([]);
setViewerSessions([]);
setHostRoomInvite(undefined);
if (role === 'host') {
  setHostPage('setup');
  setHostTab('overview');
} else {
  setViewerPage('join');
  setViewerTab('receive');
}
setScreen('browser');
setActionStatus(
  stopFailed ? 'warning' : 'ok',
  stopFailed
    ? '방에서는 나왔지만 안전 위치 명령을 확인하지 못했습니다. 장비 전원을 직접 차단하세요.'
    : role === 'host' ? '방이 종료됨' : '방에서 나왔습니다'
);
```

Add Korean reason mappings for `hardware-emergency-stopped`, `hardware-room-exit-stopping`, `hardware-room-exit-stop-failed`, and the `hardware-emergency-released` log entry. Remove the obsolete `hardware-safety-timeout` label.

- [ ] **Step 7: Run renderer and Electron regression checks**

Run:

```powershell
npm.cmd run test:electron
npm.cmd run test:ui
```

Expected: both scripts exit `0`; UI output includes the screenshot list and no JavaScript error.

- [ ] **Step 8: Commit the complete vertical code slice**

```powershell
git add electron/protocol.ts src/shared/protocol.ts electron/tuning.ts electron/services/hardware-controller.ts electron/services/relay-client.ts electron/main.ts electron/preload.cts src/global.d.ts src/App.tsx scripts/hardware-output-test.mjs scripts/preload-format-test.mjs scripts/relay-smoke-test.mjs scripts/electron-ui-smoke-test.mjs
git commit -m "feat(safety): add local emergency latch lifecycle" -m "Constraint: Only room exit and emergency stop may command the absolute stop position." -m "Rejected: Receive-pause latch and relay release | safety state must be local and independently released." -m "Confidence: high" -m "Scope-risk: broad"
```

### Task 5: Align current documentation and historical guidance

**Files:**
- Modify: `README.md:260-275, 380-450`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/IMPLEMENTATION_GUIDE.md:450-565, 624-665`
- Modify: `docs/HARDWARE_SESSION_CHECKLIST.md:15-48`
- Modify: `docs/DEVELOPMENT_HANDOFF.md:100-175, 250-265`
- Modify: `docs/ROADMAP.md:20-25`
- Modify: `docs/superpowers/specs/2026-08-22-emergency-stop-position-design.md:1-15`
- Modify: `docs/superpowers/plans/2026-08-22-emergency-stop-position.md:1-12`

- [ ] **Step 1: Replace current user-facing behavior descriptions**

Document these exact rules in README and implementation guidance:

```markdown
- 같은 스트리머 값이 유지되거나 새 패킷이 잠시 없으면 마지막 명령 위치를 유지합니다.
- 자동 inactivity 정지 위치 이동은 없습니다.
- 절대 정지 위치는 방 나가기 또는 긴급정지에서만 사용합니다.
- 하드웨어 연결 해제는 위치 명령 없이 직렬 포트만 닫습니다.
- 긴급정지는 로컬 잠금이며 사용자가 **긴급정지 해제**를 눌러야 다시 움직입니다.
- 해제는 로컬에만 적용되고 해제 순간에는 모션 명령을 보내지 않습니다.
- 수신 일시정지와 긴급정지 잠금은 서로 독립적입니다.
```

Remove `HAPTIC_HARDWARE_SAFETY_TIMEOUT_MS` from configuration examples and remove claims that receive pause, hardware test completion, or disconnect emits the stop-position payload.

- [ ] **Step 2: Update the physical checklist and handoff**

Make the checklist explicitly verify:

```markdown
1. 스트리머 값을 고정하고 2초 이상 기다려 장비가 마지막 위치를 유지하는지 확인합니다.
2. 시청자 로컬 긴급정지 후 장비가 절대 정지 위치로 이동하는지 확인합니다.
3. 스트리머가 계속 값을 보내도 로컬 해제 전에는 장비 출력이 재개되지 않는지 확인합니다.
4. 긴급정지 해제 순간에는 움직이지 않고 다음 새 프레임부터 움직이는지 확인합니다.
5. 하드웨어 연결 해제 시 절대 정지 위치로 이동하지 않고 포트만 닫히는지 확인합니다.
6. 방 나가기 시 절대 정지 위치로 이동하는지 확인합니다.
7. 스트리머 방 전체 정지 후 각 참여자가 자기 버튼으로만 해제되는지 확인합니다.
```

Update the roadmap completed item to “runtime emergency latch, local release, room-exit stop, and close-only hardware disconnect.” Keep physical COM3 acceptance unchecked until Task 6 is performed.

- [ ] **Step 3: Mark older stop-position coupling as superseded**

Add this notice below the title of both the 2026-08-22 emergency-stop-position design and plan:

```markdown
> **Historical record — partially superseded:** The absolute emergency position remains current, but hardware disconnect no longer writes it. See `2026-08-23-room-motion-emergency-latch-design.md` for the current lifecycle authority.
```

Use `../specs/2026-08-23-room-motion-emergency-latch-design.md` in the plan document so its relative link resolves correctly.

- [ ] **Step 4: Check documentation for stale active claims**

Run:

```powershell
rg -n "HAPTIC_HARDWARE_SAFETY_TIMEOUT_MS|새 motion frame이 없으면|disconnectSafely|pauseAndStop|연결 해제.*정지|테스트 종료.*긴급 정지" README.md docs electron src scripts
```

Expected: no current-code or current-guide matches. Matches inside explicitly marked historical documents are acceptable only below their superseded warning.

- [ ] **Step 5: Commit documentation alignment**

```powershell
git add README.md docs/ARCHITECTURE.md docs/IMPLEMENTATION_GUIDE.md docs/HARDWARE_SESSION_CHECKLIST.md docs/DEVELOPMENT_HANDOFF.md docs/ROADMAP.md docs/superpowers/specs/2026-08-22-emergency-stop-position-design.md docs/superpowers/plans/2026-08-22-emergency-stop-position.md
git commit -m "docs: align emergency and room lifecycle rules" -m "Constraint: Current operator docs must distinguish room exit, emergency stop, and port disconnect." -m "Confidence: high" -m "Scope-risk: narrow"
```

### Task 6: Verify automation and COM3 behavior

**Files:**
- Modify only if a verification failure reveals a defect in files already listed above.

- [ ] **Step 1: Run the complete automated verification matrix**

Run each command separately so a failure identifies its subsystem:

```powershell
npm.cmd run lint
npm.cmd run test:electron
npm.cmd run test:smoke
npm.cmd run test:ui
npm.cmd run build
npm.cmd audit --json
git diff --check origin/main...HEAD
git status --short
```

Expected:

- TypeScript, Electron, relay smoke, UI smoke, and build commands exit `0`.
- `npm audit` reports `0` vulnerabilities.
- `git diff --check` prints no whitespace error.
- `git status --short` is empty.

- [ ] **Step 2: Review the final diff for forbidden behavior**

Run:

```powershell
git diff --stat origin/main...HEAD
rg -n "room:release|emergency-release.*relay|HARDWARE_SAFETY_TIMEOUT_MS|disconnectSafely|pauseAndStop" electron src scripts README.md docs
```

Expected: no relay release protocol, inactivity timeout, safe-disconnect method, or pause-backed emergency method in current code. Historical documentation matches must carry a superseded warning.

- [ ] **Step 3: Perform the bounded COM3 acceptance session**

Use the application UI with COM3 and the existing limited stroke range. Set a visibly safe `stopPosition` such as `0.35`, then verify in this order:

1. Connect COM3 and join a test room.
2. Hold the streamer value constant for at least 2 seconds; confirm no automatic movement to `0.35`.
3. Trigger viewer local emergency stop; confirm the device moves to `0.35`.
4. Continue streamer motion; confirm the device remains blocked.
5. Press **긴급정지 해제**; confirm release itself causes no movement and the next new frame does.
6. Trigger streamer room-wide emergency stop; confirm both streamer and viewer latch locally.
7. Release only the streamer; confirm the viewer stays latched until its own release.
8. Press hardware **연결 해제** from a non-stop position; confirm the port closes without moving to `0.35`.
9. Reconnect, join the room, move away from `0.35`, then leave the room; confirm the device moves to `0.35`.
10. Rejoin once more and have the streamer kick the viewer; confirm forced removal also moves the viewer device to `0.35`.

If any physical result differs, cut device power, record the last completed step and observed TCode output, and do not package a release.

- [ ] **Step 4: Stop on any failed verification**

If an automated command or physical case fails, record the exact command/step and observed result, add a focused failing regression test in the owning task's test file, and do not claim completion or package a release until the focused fix and the entire Task 6 matrix both pass.
