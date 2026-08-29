# Hardware Readiness Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a serial port controllable only after both hardware control lines are asserted and the device returns a recognizable T-Code version.

**Architecture:** `HardwareController` will own a port-identity readiness gate. The connection path opens the port, applies `DTR=true` and `RTS=true`, probes the firmware, and only then publishes connected state; all failures reuse the existing fail-closed cleanup. Existing callback-faithful fake ports will model signal setup and probe replies so the lifecycle is verified without moving physical hardware.

**Tech Stack:** Electron 43, TypeScript 5.8, Node SerialPort 13, Node assertion scripts, React 19.

---

### Task 1: Lock control-line and readiness behavior with failing tests

**Files:**
- Modify: `scripts/hardware-output-test.mjs`

- [ ] **Step 1: Extend `FakePort` with signal setup and probe-response controls**

Add state and a callback API matching SerialPort 13:

```js
this.signalSets = [];
this.operations = [];
this.failNextSet = false;
this.stallNextSet = false;
this.probeReply = 'TCode v0.3\nL0\n';

set(options, callback) {
  this.signalSets.push({ ...options });
  this.operations.push({ type: 'set', options: { ...options } });
  if (this.stallNextSet) return;
  const error = this.failNextSet ? new Error('serial-set-failed') : null;
  this.failNextSet = false;
  queueMicrotask(() => callback(error));
}
```

Record writes in `operations` and emit `probeReply` in a microtask when the payload contains `D1`.

- [ ] **Step 2: Add a focused `hardware-readiness` regression block**

Assert this sequence for a successful connection:

```js
assert.deepEqual(port.signalSets, [{ dtr: true, rts: true }]);
assert.deepEqual(port.operations.slice(0, 2).map(operation => operation.type), ['set', 'write']);
assert.equal(result.probe.version, 'v0.3');
assert.deepEqual(controller.getConnectionStatus(), { connected: true, path: 'COM3' });
assert.deepEqual(controller.queueMotion(frame), { queued: true });
```

Add separate ports/controllers asserting:

```js
await assert.rejects(setFailureController.connect('COM4', profile), /serial-set-failed/);
assert.equal(setFailurePort.isOpen, false);
assert.deepEqual(setFailureController.getConnectionStatus(), { connected: false });

noReplyPort.probeReply = undefined;
const pending = noReplyController.connect('COM5', profile);
assert.deepEqual(noReplyController.queueMotion(frame), { queued: false, reason: 'hardware-not-ready' });
await assert.rejects(pending, /hardware-tcode-not-ready/);
assert.equal(noReplyPort.isOpen, false);
```

- [ ] **Step 3: Build and run only the new regression to verify RED**

Run:

```powershell
npm.cmd run build:electron
node scripts/hardware-output-test.mjs hardware-readiness
```

Expected: FAIL because `HardwarePort` has no `set()` lifecycle, no readiness gate exists, and a missing probe version currently succeeds.

### Task 2: Apply control signals before probing

**Files:**
- Modify: `electron/services/hardware-controller.ts`
- Test: `scripts/hardware-output-test.mjs`

- [ ] **Step 1: Expand the internal port contract**

Include `set` in the existing SerialPort projection:

```ts
type HardwarePort = Pick<SerialPort,
  'path' | 'isOpen' | 'open' | 'close' | 'write' | 'set' | 'once' | 'on' | 'off'
>;
```

- [ ] **Step 2: Add the bounded control-line helper**

Implement a callback wrapper using `lifecycleTimeoutMs`:

```ts
private configureControlSignals(port: HardwarePort) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('hardware-control-signals-timeout')), this.lifecycleTimeoutMs);
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    try {
      port.set({ dtr: true, rts: true }, finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error('hardware-control-signals-failed'));
    }
  });
}
```

After `openPort(port)`, await this helper before `probeTCodeCapabilities()`. Emit the configured diagnostic only after the callback succeeds. On failure, emit the failure diagnostic, pass the exact error to `failPort()`, and reject the connection.

- [ ] **Step 3: Run the focused regression**

Run:

```powershell
npm.cmd run build:electron
node scripts/hardware-output-test.mjs hardware-readiness
```

Expected: control-line ordering and failure cleanup pass; the no-response assertion still fails until Task 3.

### Task 3: Add the port-identity readiness gate

**Files:**
- Modify: `electron/services/hardware-controller.ts`
- Modify: `src/App.tsx`
- Test: `scripts/hardware-output-test.mjs`
- Test: `scripts/preload-format-test.mjs`

- [ ] **Step 1: Track the exact ready port**

Add:

```ts
private readyPort: HardwarePort | undefined;

private isPortReady(port = this.port) {
  return Boolean(port && port === this.port && port === this.readyPort && port.isOpen);
}
```

Set `readyPort = port` only after a parsed probe version and final active/open checks. Clear it in `failPort()` and every path that finalizes or discovers a closed port. Do not clear it before an explicit close callback, so the existing close-failure restoration keeps the same port usable.

- [ ] **Step 2: Reject unverified connections**

Immediately after probing:

```ts
if (!probe.version) {
  const error = new Error('hardware-tcode-not-ready');
  this.emitDiagnostic('error', 'hardware', 'hardware-readiness-failed', {
    portPath: port.path,
    raw: boundedText(probe.raw.join('\n')),
    version: probe.version,
    axes: probe.axes
  });
  this.failPort(port, error, error.message);
  throw error;
}
if (this.port !== port || !port.isOpen) throw new Error('hardware-connection-lost');
this.readyPort = port;
```

Only then report `connected: true` and emit `hardware-ready`.

- [ ] **Step 3: Gate motion and tests**

After the existing lifecycle and emergency checks, make `queueMotion()` reject an open-but-unready port:

```ts
if (this.port?.isOpen && !this.isPortReady()) {
  this.reportDroppedMotion(frame, 'hardware-not-ready');
  return { queued: false, reason: 'hardware-not-ready' };
}
```

Apply the same readiness check to `runTestPattern()`. Leave `writeStopPayload()` able to address an open port for safety teardown.

- [ ] **Step 4: Add user-facing reason mappings**

Add `hardware-not-ready`, `hardware-tcode-not-ready`, and `hardware-control-signals-failed` to `formatReason()`. Add the new low-frequency event labels to `formatLogMessage()` and assert their source strings in `preload-format-test.mjs`.

- [ ] **Step 5: Run focused tests to verify GREEN**

Run:

```powershell
npm.cmd run build:electron
node scripts/hardware-output-test.mjs hardware-readiness
node scripts/preload-format-test.mjs
```

Expected: all focused assertions pass.

### Task 4: Preserve existing lifecycle behavior and verify the build

**Files:**
- Modify only files required by failures attributable to the readiness gate.

- [ ] **Step 1: Run the full hardware regression suite**

Run:

```powershell
npm.cmd run build:electron
node scripts/hardware-output-test.mjs
```

Expected: `hardware output tests passed`; expected failure-path stderr remains but the process exits 0.

- [ ] **Step 2: Run Electron and UI suites**

Run:

```powershell
npm.cmd run test:electron
npm.cmd run test:ui
```

Expected: both commands exit 0.

- [ ] **Step 3: Run the complete build**

Run:

```powershell
npm.cmd run build
git diff --check
git status --short
```

Expected: build and whitespace check exit 0; only intentional source, test, and documentation files are modified.

### Task 5: Perform a low-risk COM3 acceptance check

**Files:**
- Update only the existing hardware checklist if the observed contract differs from it.

- [ ] **Step 1: Prepare the physical test**

Keep the mechanism unloaded, use COM3 at 115200, retain the restricted stroke range, and ensure the hardware power switch is immediately reachable.

- [ ] **Step 2: Connect without sending room motion**

Expected: the log contains `hardware-control-signals-configured`, `hardware-probe-completed` with `TCode v0.3`, and `hardware-ready`; the UI reports connected only after those events.

- [ ] **Step 3: Run the existing low-risk test once**

Expected: the four bounded test positions move in order without a startup jump. Stop immediately if the device moves unexpectedly.

- [ ] **Step 4: Disconnect and inspect JSONL**

Expected: the port closes, subsequent motion is rejected, and the JSONL log contains no secrets and clearly records the readiness sequence.
