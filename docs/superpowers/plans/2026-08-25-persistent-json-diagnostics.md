# Persistent JSON Diagnostics Implementation Plan

> **Post-plan release correction (2026-08-29):** Explicit hardware disconnect now attempts `DSTOP` plus the configured absolute stop position for at most `500ms` before closing the port. Portable JSON export omits `diagnosticLog.activeFile` so a shared support file cannot expose the Windows account path. Final motion aggregation is persisted before lifecycle-boundary records. These corrections supersede close-only, active-file export, and shutdown-order steps below; the historical task text is retained for traceability.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist bounded JSONL diagnostics that distinguish serial write completion from device movement, retain the existing manual JSON export, and publish the verified Windows Demo 10 release.

**Architecture:** A focused main-process `DiagnosticLogStore` owns JSONL serialization, ordering, size rotation, failure suppression, and one-second motion aggregation. `HardwareController` emits allowlisted structured diagnostic events without performing file I/O; `main.ts` routes those events to the store, supplies session/export metadata, and flushes diagnostics only after safety-critical shutdown work. The renderer continues to consume the existing `AppLogEntry` and `HardwareOutputSnapshot` contracts.

**Tech Stack:** Electron 43, TypeScript, Node.js `fs/promises` and `crypto`, SerialPort 13, React 19, Node assertion scripts, electron-builder/NSIS, GitHub CLI.

---

### Task 0: Synchronize the release branch with current main

**Files:**
- No source changes expected unless Git reports a conflict.

- [ ] **Step 1: Verify the worktree and refs**

Run:

```powershell
git status --short --branch
git fetch origin --prune
git rev-list --left-right --count origin/main...HEAD
```

Expected: the worktree is clean; before synchronization `origin/main` has two merge commits not present in the feature branch.

- [ ] **Step 2: Merge current main without rewriting published history**

Run:

```powershell
git merge --no-edit origin/main
```

Expected: a merge commit or an already-up-to-date result. Do not rebase or force-push the shared branch.

- [ ] **Step 3: Re-run the baseline build**

Run:

```powershell
npm.cmd run lint
npm.cmd run build
git status --short
```

Expected: both commands exit 0 and the worktree remains clean.

### Task 1: Add the bounded JSONL store with motion aggregation

**Files:**
- Create: `electron/diagnostic-log-store.ts`
- Create: `scripts/diagnostic-log-store-test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add the failing store tests**

Create `scripts/diagnostic-log-store-test.mjs` with an injected in-memory filesystem. The fake must expose `files`, `directories`, `appendOrder`, `failNextAppend()`, and these operations: `mkdir`, `stat`, `appendFile`, `rename`, and `unlink`.

The test cases must assert these concrete behaviors:

```js
const { DiagnosticLogStore } = await import('../dist-electron/diagnostic-log-store.js');

const store = new DiagnosticLogStore({
  directory: '/diagnostics',
  sessionId: 'session-one',
  maxFileBytes: 512,
  maxFiles: 5,
  operations: fake.operations,
  onError: error => errors.push(error.message)
});

await Promise.all([
  store.record({ timestamp: 1000, level: 'info', source: 'app', event: 'first', data: { order: 1 } }),
  store.record({ timestamp: 1001, level: 'info', source: 'app', event: 'second', data: { order: 2 } })
]);
await store.flush();
assert.deepEqual(parseJsonLines(fake.files.get('/diagnostics/haptic-relay.jsonl')), [
  { schemaVersion: 1, timestamp: 1000, sessionId: 'session-one', level: 'info', source: 'app', event: 'first', data: { order: 1 } },
  { schemaVersion: 1, timestamp: 1001, sessionId: 'session-one', level: 'info', source: 'app', event: 'second', data: { order: 2 } }
]);
```

Also cover:

```js
assert.equal(fake.directories.has('/diagnostics'), true, 'directory is created lazily');
assert.equal(fake.files.size <= 5, true, 'rotation never exceeds five files');
assert.equal(byteLength(fake.files.get('/diagnostics/haptic-relay.jsonl')) <= 512, true);

store.recordMotion({ timestamp: 2100, outcome: 'completed', command: 'L05000100', position: 0.5, intensity: 0.1 });
store.recordMotion({ timestamp: 2200, outcome: 'completed', command: 'L06000100', position: 0.6, intensity: 0.1 });
store.recordMotion({ timestamp: 2300, outcome: 'dropped', reason: 'protection-paused' });
store.recordMotion({ timestamp: 3100, outcome: 'failed', reason: 'hardware-write-timeout' });
await store.flushMotion();
await store.flush();
const summaries = allRecords(fake).filter(record => record.event === 'hardware-motion-summary');
assert.equal(summaries.length, 2);
assert.deepEqual(summaries[0].data, {
  attempted: 3,
  completed: 2,
  dropped: 1,
  failed: 0,
  firstTimestamp: 2100,
  lastTimestamp: 2300,
  lastCommand: 'L06000100',
  lastPosition: 0.6,
  lastIntensity: 0.1,
  lastFailureReason: 'protection-paused'
});
```

Before the rotation assertions, append twenty numbered records and flush them so the 512-byte boundary creates multiple generations. Assert every retained file contains only complete parseable JSON lines.

Finally make one append fail and assert that `onError` fires exactly once, subsequent records do not append, and `flush()` resolves instead of rejecting.

- [ ] **Step 2: Register and run the failing test**

Add the new test immediately after `settings-file-store-test.mjs` in `test:electron`:

```json
"test:electron": "npm run build:electron && node scripts/preload-format-test.mjs && node scripts/app-settings-test.mjs && node scripts/settings-file-store-test.mjs && node scripts/diagnostic-log-store-test.mjs && node scripts/window-messenger-test.mjs && node scripts/demo-motion-stream-test.mjs && node scripts/demo-motion-pattern-test.mjs && node scripts/tcode-encoder-test.mjs && node scripts/hardware-output-test.mjs"
```

Run:

```powershell
npm.cmd run test:electron
```

Expected: FAIL because `dist-electron/diagnostic-log-store.js` does not exist.

- [ ] **Step 3: Implement the store**

Create `electron/diagnostic-log-store.ts` with these public contracts:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';

export type DiagnosticLevel = 'info' | 'warning' | 'error';

export type DiagnosticEventInput = {
  timestamp: number;
  level: DiagnosticLevel;
  source: 'app' | 'hardware' | 'protection';
  event: string;
  data: Record<string, unknown>;
};

export type MotionDiagnosticSample = {
  timestamp: number;
  outcome: 'completed' | 'dropped' | 'failed';
  command?: string;
  position?: number;
  intensity?: number;
  reason?: string;
};

export interface DiagnosticFileOperations {
  mkdir(directory: string, options: { recursive: true }): Promise<unknown>;
  stat(filePath: string): Promise<{ size: number }>;
  appendFile(filePath: string, content: string, encoding: 'utf8'): Promise<void>;
  rename(sourcePath: string, targetPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

export type DiagnosticLogStoreOptions = {
  directory: string;
  sessionId: string;
  maxFileBytes?: number;
  maxFiles?: number;
  operations?: DiagnosticFileOperations;
  onError?: (error: Error) => void;
};
```

Implement constants `DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024`, `DEFAULT_MAX_FILES = 5`, active name `haptic-relay.jsonl`, and these methods:

```ts
record(input: DiagnosticEventInput): Promise<void>;
recordMotion(sample: MotionDiagnosticSample): void;
flushMotion(): Promise<void>;
flush(): Promise<void>;
metadata(): {
  schemaVersion: 1;
  sessionId: string;
  format: 'jsonl';
  activeFile: string;
  maxFileBytes: number;
  maxFiles: number;
};
```

`record()` must construct the common schema itself, append exactly one compact JSON line, and serialize appends through a promise chain. Before an append that would make a non-empty active file exceed the limit, rotate `.4` away, `.3` to `.4`, `.2` to `.3`, `.1` to `.2`, and the active file to `.1`. Treat only `ENOENT` as an absent generation. After the first other filesystem error, call `onError` once, disable persistence for that session, and keep `record()`/`flush()` resolving.

`recordMotion()` must roll the previous integer-second bucket when a sample enters a later bucket. `flushMotion()` writes the pending bucket. Bound `command` and `reason` to 4096 characters before storing them.

- [ ] **Step 4: Verify the focused store behavior**

Run:

```powershell
npm.cmd run build:electron
node scripts/diagnostic-log-store-test.mjs
```

Expected: `diagnostic log store tests passed`.

- [ ] **Step 5: Commit the store**

```powershell
git add electron/diagnostic-log-store.ts scripts/diagnostic-log-store-test.mjs package.json
git commit -m "feat(logs): add bounded JSONL diagnostic store" -m "Constraint: Diagnostic I/O must remain bounded and best-effort." -m "Rejected: Per-frame disk writes | production motion runs at 30 Hz." -m "Confidence: high" -m "Scope-risk: moderate"
```

### Task 2: Emit allowlisted serial and T-Code diagnostics

**Files:**
- Modify: `electron/services/hardware-controller.ts`
- Modify: `scripts/hardware-output-test.mjs`

- [ ] **Step 1: Add failing structured-diagnostic tests**

Extend the existing fake-controller tests with an `onDiagnostic` array and an injected monotonic clock. Assert:

```js
const diagnostics = [];
const controller = new HardwareController({
  createPort: () => port,
  listPorts: async () => [{
    path: 'COM3',
    vendorId: '10C4',
    productId: 'EA64',
    serialNumber: '0693C90A',
    manufacturer: 'Silicon Labs',
    pnpId: 'USB\\VID_10C4&PID_EA64',
    locationId: 'Port_#0002.Hub_#0001'
  }],
  onDiagnostic: event => diagnostics.push(event),
  now: () => clock.now,
  probeTimeoutMs: 0
});

await controller.connect('COM3', {
  baudRate: 115200,
  linearAxis: 'L0',
  vibrationAxis: undefined,
  strokeMin: 0.2,
  strokeMax: 0.8,
  stopPosition: 0.35,
  invertPosition: false
});

assert.deepEqual(diagnostics.find(item => item.event === 'hardware-connect-requested').data, {
  portPath: 'COM3', baudRate: 115200, linearAxis: 'L0', vibrationAxis: undefined,
  strokeMin: 0.2, strokeMax: 0.8, stopPosition: 0.35, invertPosition: false
});
assert.equal(diagnostics.find(item => item.event === 'hardware-port-identified').data.vendorId, '10C4');
assert.equal(diagnostics.find(item => item.event === 'hardware-probe-completed').data.responseReceived, false);
```

Feed a fake probe response and assert raw lines, detected/version/axes, and the bounded probe command are recorded. Run a test pattern and assert four `hardware-write-completed` events with `operation: 'test'`, non-negative `durationMs`, exact commands, and `deviceAcknowledged: false`. Stall one write and assert one `hardware-write-failed` event with `timeout: true` and no secret or error stack.

For production motion, assert the controller emits `hardware-motion-sample` callbacks only in memory with `completed`, `dropped`, and `failed` outcomes. Assert `emergency-latched`, `emergency-released`, and `room-exit-stop` describe the local state/result without adding a relay release event. Assert `hardware-port-closed` distinguishes an unexpected close and `hardware-disconnected` describes the expected close-only path. These diagnostics must not change the existing close-only disconnect or absolute room-exit stop behavior.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```powershell
npm.cmd run build:electron
node scripts/hardware-output-test.mjs
```

Expected: FAIL because `onDiagnostic`, `listPorts`, and `now` are not supported and no structured diagnostics are emitted.

- [ ] **Step 3: Add the diagnostic event boundary**

Export these controller-local types:

```ts
export type HardwareDiagnosticEvent = {
  timestamp: number;
  level: 'info' | 'warning' | 'error';
  source: 'hardware' | 'protection';
  event: string;
  data: Record<string, unknown>;
};

type WriteOperation = 'probe' | 'test' | 'stop' | 'motion';

type PortIdentity = {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  locationId?: string;
  productId?: string;
  vendorId?: string;
};
```

Extend `HardwareControllerOptions`:

```ts
onDiagnostic?: (event: HardwareDiagnosticEvent) => void;
listPorts?: () => Promise<PortIdentity[]>;
now?: () => number;
```

Add helpers `emitDiagnostic(level, source, event, data)`, `boundedText(value)`, and `normalizedErrorData(error)`. `normalizedErrorData` must return only `name`, `message`, and `timeout`; do not include stacks or arbitrary objects.

- [ ] **Step 4: Instrument connection and probe boundaries**

Before opening the port, emit `hardware-connect-requested` from the normalized profile. Best-effort match `pathName` against `(options.listPorts ?? SerialPort.list)()` and emit `hardware-port-identified` using only `path`, `vendorId`, `productId`, `serialNumber`, `manufacturer`, `pnpId`, and `locationId` when present. Metadata lookup failure must emit a warning diagnostic but must not fail connection. SerialPort 13 does not expose a Windows friendly-name field, so do not invent one.

After `D1\nD2\n`, emit one `hardware-probe-completed` record containing:

```ts
{
  command: boundedText(encodeTCodeProbe().trim()),
  raw: boundedText(raw.join('\n')),
  responseReceived: raw.length > 0,
  detected: result.detected,
  version: result.version,
  axes: result.axes,
  durationMs: Math.max(0, now() - startedAt)
}
```

- [ ] **Step 5: Instrument writes without changing safety order**

Change the private signature to:

```ts
private writePayload(payload: string, operation: WriteOperation, frame?: Pick<MotionFrame, 'position' | 'intensity'>): Promise<void>
```

Capture `startedAt` immediately before `port.write`. On completion:

- for `motion`, emit `hardware-motion-sample` with outcome `completed`, command, final position/intensity, and duration;
- otherwise emit `hardware-write-completed` with operation, command, port, baudrate, duration, and `deviceAcknowledged: false`.

On failure, emit either a motion sample with outcome `failed` or `hardware-write-failed` with the normalized error. Preserve the current rule that emergency/room-exit state changes happen before asynchronous writes and that disconnect remains close-only.

When `queueMotion` rejects a frame for emergency latch, receive pause, lifecycle gate, or missing connection, emit a dropped motion sample with that exact reason. Do not add file I/O or awaits to `queueMotion`.

Emit `emergency-latched` after the local latch is set, `emergency-released` on explicit local release, and `room-exit-stop` with the completed stop result. Emit `hardware-port-closed` from the unexpected close handler and `hardware-disconnected` only after the expected close-only operation settles. These records are observational and must not introduce a second serial write, state transition, or relay event.

- [ ] **Step 6: Verify controller regressions**

Run:

```powershell
npm.cmd run build:electron
node scripts/hardware-output-test.mjs
npm.cmd run test:electron
```

Expected: hardware output tests pass, including all existing emergency latch, disconnect, room-exit, timeout, stale-port, and race cases.

- [ ] **Step 7: Commit hardware diagnostics**

```powershell
git add electron/services/hardware-controller.ts scripts/hardware-output-test.mjs
git commit -m "feat(hardware): emit structured serial diagnostics" -m "Constraint: Serial diagnostics cannot alter emergency or disconnect ordering." -m "Confidence: high" -m "Scope-risk: broad"
```

### Task 3: Integrate session persistence and backward-compatible JSON export

**Files:**
- Create: `electron/log-export.ts`
- Create: `scripts/log-export-test.mjs`
- Modify: `electron/main.ts`
- Modify: `scripts/preload-format-test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add failing export and main integration tests**

Create `scripts/log-export-test.mjs` and assert the exact compatible shape:

```js
const payload = buildLogExportPayload({
  appName: 'Haptic Relay',
  version: '0.1.1-demo.10',
  exportedAt: '2026-08-25T00:00:00.000Z',
  entries: [{ id: 1, timestamp: 1, level: 'info', source: 'hardware', message: 'hardware-connected' }],
  diagnostic: {
    schemaVersion: 1,
    sessionId: 'session-one',
    format: 'jsonl',
    activeFile: '/profile/logs/haptic-relay.jsonl',
    maxFileBytes: 2097152,
    maxFiles: 5
  }
});

assert.equal(payload.schemaVersion, 1);
assert.equal(payload.sessionId, 'session-one');
assert.deepEqual(payload.entries[0].message, 'hardware-connected');
assert.deepEqual(payload.diagnosticLog, {
  format: 'jsonl',
  activeFile: '/profile/logs/haptic-relay.jsonl',
  maxFileBytes: 2097152,
  maxFiles: 5
});
```

Include representative forbidden strings in unrelated input objects and assert the builder only emits its explicit arguments; it must not accept environment, settings, password, bearer token, or relay request objects.

Extend `preload-format-test.mjs` source assertions for:

- initialization under `path.join(app.getPath('userData'), 'logs')` after `app.whenReady()`;
- `session-started` with version/runtime metadata;
- routing `hardware-motion-sample` to `recordMotion()` and other events to `record()`;
- a non-recursive `persistent-log-disabled` in-memory warning;
- `flushMotion()` and bounded `flush()` after hardware disconnect in shutdown;
- export through `buildLogExportPayload()`.

- [ ] **Step 2: Register and run the failing tests**

Add `node scripts/log-export-test.mjs` after the diagnostic store test in `test:electron`, then run:

```powershell
npm.cmd run test:electron
```

Expected: FAIL because `log-export.ts` and main-process integration do not exist.

- [ ] **Step 3: Implement the pure export builder**

Create `electron/log-export.ts` with a single exported `buildLogExportPayload` function. It must accept only `appName`, `version`, `exportedAt`, `entries`, and the diagnostic metadata. Return:

```ts
{
  schemaVersion: 1,
  app: appName,
  version,
  exportedAt,
  sessionId: diagnostic.sessionId,
  diagnosticLog: {
    format: diagnostic.format,
    activeFile: diagnostic.activeFile,
    maxFileBytes: diagnostic.maxFileBytes,
    maxFiles: diagnostic.maxFiles
  },
  entries
}
```

Do not add a generic spread of settings, environment, IPC requests, or controller objects.

- [ ] **Step 4: Initialize the store and route diagnostics**

In `main.ts`, create the session ID with `randomUUID()` and initialize the store only after Electron is ready:

```ts
diagnosticLogStore = new DiagnosticLogStore({
  directory: path.join(app.getPath('userData'), 'logs'),
  sessionId,
  onError: error => reportPersistentLogFailure(error)
});
```

Record `session-started` with only app/Electron/Node versions, platform, architecture, and `app.isPackaged`. Pass `onDiagnostic` into `HardwareController`; route `hardware-motion-sample` to `recordMotion`, and convert every other allowlisted event to `record` without spreading unknown objects.

`reportPersistentLogFailure` must call `addLog(..., { persist: false })` at most once and write the error to stderr. It must not call the disabled store again.

- [ ] **Step 5: Add session/export metadata and bounded shutdown flush**

Use `buildLogExportPayload()` in `app:export-logs`, preserving `entries`. After all existing room-exit stop and close-only disconnect work finishes, record `session-ended`, flush the motion bucket, and wait at most 250 ms for diagnostic `flush()` using an explicit timeout race. A timeout or logger failure must not reject `shutdownApplication()`.

Do not move the diagnostic wait before `stopForRoomExit()` or `hardware.disconnect()`.

- [ ] **Step 6: Verify integration and privacy**

Run:

```powershell
npm.cmd run build:electron
node scripts/log-export-test.mjs
node scripts/preload-format-test.mjs
npm.cmd run test:electron
```

Expected: all pass. Search the test fixtures and generated diagnostic records to confirm the representative password, bearer token, and query secret are absent.

- [ ] **Step 7: Commit the integration**

```powershell
git add electron/log-export.ts electron/main.ts scripts/log-export-test.mjs scripts/preload-format-test.mjs package.json
git commit -m "feat(logs): persist session hardware diagnostics" -m "Constraint: Logger failure and flush timeout cannot delay safety shutdown." -m "Confidence: high" -m "Scope-risk: broad"
```

### Task 4: Correct the UI wording and document operator access

**Files:**
- Modify: `src/ui/components/HardwareOutputMonitor.tsx`
- Modify: `scripts/electron-ui-smoke-test.mjs`
- Modify: `scripts/preload-format-test.mjs`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/HARDWARE_SESSION_CHECKLIST.md`
- Modify: `docs/DEVELOPMENT_HANDOFF.md`

- [ ] **Step 1: Add the failing wording assertions**

In `scripts/preload-format-test.mjs`, read `src/ui/components/HardwareOutputMonitor.tsx` and assert:

```js
assert.match(hardwareOutputMonitorSource, /output \? ['"]직렬 전송 완료['"]/);
assert.doesNotMatch(hardwareOutputMonitorSource, /출력 성공/);
```

After the hardware panel opens in `electron-ui-smoke-test.mjs`, assert that its initial state does not contain the misleading success phrase:

```js
await waitForExpression(cdp, `document.body.innerText.includes('출력 성공') === false`);
```

Run `npm.cmd run test:electron` and expect failure because the component still renders `출력 성공`.

- [ ] **Step 2: Change only the acknowledgement wording**

In `HardwareOutputMonitor.tsx`, replace:

```tsx
{output ? '출력 성공' : connected ? '출력 대기' : '장비 미연결'}
```

with:

```tsx
{output ? '직렬 전송 완료' : connected ? '출력 대기' : '장비 미연결'}
```

Do not change the command, kind, port, baudrate, or timestamp presentation.

- [ ] **Step 3: Document the bounded local diagnostics**

Add current, active guidance to the four documents:

- automatic files live under Electron `userData/logs` as `haptic-relay.jsonl` plus four rotations;
- total retained size is approximately 10 MiB;
- the **저장** action still exports the current in-memory entries plus diagnostic metadata;
- `직렬 전송 완료` proves only the OS write callback, not controller parsing or physical movement;
- probe/no-response, profile, write duration, and port errors are the first evidence to inspect;
- logs are local-only and exclude credentials;
- 30 Hz motion is summarized once per second.

In `HARDWARE_SESSION_CHECKLIST.md`, add a post-test step that records the automatic JSONL path and exports the manual JSON. Do not weaken the existing requirement to judge actual device position separately from write completion.

- [ ] **Step 4: Verify UI and docs**

Run:

```powershell
npm.cmd run test:ui
rg -n "출력 성공" src scripts README.md docs
rg -n "직렬 전송 완료|haptic-relay\.jsonl|device acknowledgement|장비.*동작" README.md docs src
git diff --check
```

Expected: UI tests pass; `출력 성공` has no current-source match; documentation clearly separates write completion from motion.

- [ ] **Step 5: Commit UI and docs**

```powershell
git add src/ui/components/HardwareOutputMonitor.tsx scripts/electron-ui-smoke-test.mjs scripts/preload-format-test.mjs README.md docs/ARCHITECTURE.md docs/HARDWARE_SESSION_CHECKLIST.md docs/DEVELOPMENT_HANDOFF.md
git commit -m "docs(ui): clarify persistent serial diagnostics" -m "Constraint: The UI cannot imply physical device acknowledgement." -m "Confidence: high" -m "Scope-risk: narrow"
```

### Task 5: Run automated and COM3 acceptance

**Files:**
- Modify only if a failing verification reveals a focused defect in the files above.

- [ ] **Step 1: Run the complete automated matrix separately**

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

Expected: all exit 0, smoke reports 29/29, audit reports zero vulnerabilities, and the worktree is clean.

- [ ] **Step 2: Inspect a real packaged diagnostic session without motion**

Build the unpacked app and start the dedicated local demo with separate profiles:

```powershell
npm.cmd run electron:pack
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-hardware-demo.ps1 -AppExecutable "$PWD\release\win-unpacked\Haptic Relay.exe"
```

Connect COM3 with `115200`, `L0`, no vibration axis, stroke `0.20-0.80`, and stop position `0.35`. Before sending motion, confirm the active profile JSONL exists beneath the demo profile's `logs` directory and contains `session-started`, `hardware-connect-requested`, `hardware-port-identified` when available, and `hardware-probe-completed` with an explicit `responseReceived` value.

- [ ] **Step 3: Repeat the bounded COM3 safety acceptance**

With the mechanism unloaded, travel clear, and independent power cutoff reachable:

1. Run the `0.2 -> 0.5 -> 0.8 -> 0.5` test and separately observe physical motion.
2. Hold one streamer value for two seconds, then packet silence for two seconds; confirm no automatic move to `0.35`.
3. Trigger viewer local emergency stop; confirm physical movement to `0.35` and latch blocking subsequent frames.
4. Release during packet silence; confirm release emits no serial command and only the next new frame moves.
5. Trigger room-wide stop; release the streamer only and confirm the viewer remains latched until its own release.
6. Disconnect hardware from a non-stop position; confirm the port closes without a stop write or movement to `0.35`.
7. Reconnect, move away, and leave the room; confirm movement to `0.35`.
8. Rejoin, move away, and have the streamer kick the viewer; confirm movement to `0.35`.

Cut power immediately on any unexpected motion. Record the last completed step and do not proceed to release on any mismatch.

- [ ] **Step 4: Verify the captured evidence**

Stop the demo with `demo\STOP-HARDWARE-DEMO.cmd`. Parse every JSONL line as JSON and verify:

- test and stop writes have individual commands, duration, and `deviceAcknowledged: false`;
- probe raw response or explicit no-response is present;
- motion records appear as at most one summary per second rather than per-frame lines;
- connect profile uses `0.20`, `0.80`, and `0.35`;
- expected and unexpected close classifications are distinguishable;
- manual JSON export retains `entries` and adds session/diagnostic metadata;
- no password, token, authorization value, or URL query secret appears.

### Task 6: Version, package, review, merge, and publish Demo 10

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docs/DEVELOPMENT_HANDOFF.md`

- [ ] **Step 1: Bump the release version after acceptance**

Run:

```powershell
npm.cmd version 0.1.1-demo.10 --no-git-tag-version
node -e "const p=require('./package.json'); const l=require('./package-lock.json'); if(p.version!=='0.1.1-demo.10'||l.version!=='0.1.1-demo.10'||l.packages[''].version!=='0.1.1-demo.10') process.exit(1); console.log(p.version)"
```

Expected: `0.1.1-demo.10`.

- [ ] **Step 2: Re-run release-grade verification**

Run each separately:

```powershell
npm.cmd run lint
npm.cmd run test:electron
npm.cmd run test:smoke
npm.cmd run test:ui
npm.cmd run build
npm.cmd audit --json
npm.cmd run electron:build
npm.cmd run release:check
npm.cmd run test:two-client
```

Then verify the hosted relay with the packaged app:

```powershell
$env:RELAY_URL='https://aws-relay.syncra.uk'
$env:USE_DEFAULT_RELAY='1'
npm.cmd run test:two-client
Remove-Item Env:RELAY_URL
Remove-Item Env:USE_DEFAULT_RELAY
```

Expected: all pass, exactly one current-version Windows installer exists in `release`, and both local and AWS packaged two-client runs pass.

- [ ] **Step 3: Record exact artifact evidence**

Run:

```powershell
$installers = @(Get-ChildItem -LiteralPath 'release' -File | Where-Object { $_.Name -match '^Haptic[ .]Relay-0\.1\.1-demo\.10-win-x64\.exe$' })
if ($installers.Count -ne 1) { throw "expected-one-demo10-installer:$($installers.Count)" }
$installer = $installers[0]
$sha256 = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
[pscustomobject]@{ Name=$installer.Name; Bytes=$installer.Length; SHA256=$sha256 } | Format-List
```

Use `apply_patch` to update the Windows release block in `docs/DEVELOPMENT_HANDOFF.md` to Demo 10 with the exact filename, byte count, and SHA-256 printed by this command. Update the verification list to include persistent JSONL rotation/privacy tests and the completed COM3 acceptance.

- [ ] **Step 4: Commit release metadata**

```powershell
git add package.json package-lock.json docs/DEVELOPMENT_HANDOFF.md
git commit -m "chore(release): prepare Demo 10" -m "Constraint: Release follows automated, packaged, and COM3 acceptance." -m "Confidence: high" -m "Scope-risk: moderate"
```

- [ ] **Step 5: Perform the final whole-diff review**

Use `superpowers:requesting-code-review` against `origin/main...HEAD`. Resolve every Critical or Important finding with a focused regression test and rerun the full matrix. Confirm:

```powershell
git status --short
git diff --check origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: clean worktree, no whitespace errors, and only reviewed commits.

- [ ] **Step 6: Push and merge through a pull request**

```powershell
git push origin HEAD:feature/viewer-motion-delay-pr
gh pr create --repo immigration2000/haptic-relay-desktop --base main --head feature/viewer-motion-delay-pr --title "Haptic Relay Demo 10 diagnostics and safety lifecycle" --body "Adds bounded local JSONL diagnostics, clarifies serial write completion, and ships the verified room/emergency hardware lifecycle. Automated, packaged two-client, dependency audit, and COM3 acceptance completed."
gh pr checks --watch
gh pr merge --repo immigration2000/haptic-relay-desktop --merge
git fetch origin --prune
```

Expected: the PR is merged and `origin/main` contains the release commit.

- [ ] **Step 7: Tag and publish the installer**

Run:

```powershell
git tag -a v0.1.1-demo.10 origin/main -m "Haptic Relay v0.1.1 Demo 10"
git push origin v0.1.1-demo.10
$installers = @(Get-ChildItem -LiteralPath 'release' -File | Where-Object { $_.Name -match '^Haptic[ .]Relay-0\.1\.1-demo\.10-win-x64\.exe$' })
if ($installers.Count -ne 1) { throw "expected-one-demo10-installer:$($installers.Count)" }
$installer = $installers[0]
$releaseNotes = @'
## Haptic Relay Demo 10

- Adds bounded local JSONL diagnostics with manual JSON export compatibility.
- Records T-Code probe results, serial write duration, applied hardware profile, and port lifecycle without storing credentials.
- Clarifies that serial write completion is not device acknowledgement.
- Keeps room motion at the last received position until room exit or emergency stop.
- Adds a runtime-local emergency latch with explicit local release.
- Keeps hardware disconnect close-only; room exit and forced removal use the configured absolute stop position.

Validated with automated tests, local and hosted packaged two-client tests, dependency audit, and bounded COM3 hardware acceptance.
'@
gh release create v0.1.1-demo.10 $installer.FullName --repo immigration2000/haptic-relay-desktop --target main --title "Haptic Relay v0.1.1 Demo 10" --notes $releaseNotes --latest
```

- [ ] **Step 8: Verify the published release independently**

```powershell
gh release view v0.1.1-demo.10 --repo immigration2000/haptic-relay-desktop --json tagName,isLatest,url,assets
$published = Join-Path $env:TEMP 'haptic-relay-demo10-published'
New-Item -ItemType Directory -Path $published -Force | Out-Null
gh release download v0.1.1-demo.10 --repo immigration2000/haptic-relay-desktop --dir $published
$installers = @(Get-ChildItem -LiteralPath 'release' -File | Where-Object { $_.Name -match '^Haptic[ .]Relay-0\.1\.1-demo\.10-win-x64\.exe$' })
if ($installers.Count -ne 1) { throw "expected-one-demo10-installer:$($installers.Count)" }
$installer = $installers[0]
$localHash = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash
$downloadedHash = (Get-FileHash -LiteralPath (Join-Path $published $installer.Name) -Algorithm SHA256).Hash
if ($localHash -ne $downloadedHash) { throw 'published-installer-hash-mismatch' }
```

Expected: tag is `v0.1.1-demo.10`, it is latest, exactly one Windows installer asset is present, and the downloaded SHA-256 equals the locally verified artifact.

If any automated, physical, PR, tag, upload, or checksum step fails, stop at that step. Do not claim or mark the release complete until the failed boundary is understood and reverified.
