# Viewer Motion Delay Buffer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted 0-10 second viewer motion delay in 100ms increments without allowing stale queued motion to cross session or safety boundaries.

**Architecture:** A pure bounded `MotionDelayBuffer` stores accepted frames by local monotonic receipt time. `RelayClient` owns one next-due timer after sequence validation, while AppSettings schema v2 and a narrow Electron IPC command persist and apply the viewer delay.

**Tech Stack:** TypeScript 5.8, Electron 37, React 19, Socket.IO 4.8, Node.js test scripts using `node:assert/strict`.

---

## File Map

- Create `electron/services/motion-delay-buffer.ts`: pure FIFO delay and validation logic.
- Create `electron/app-settings.ts`: pure defaults, validation, and schema migration.
- Create `scripts/motion-delay-buffer-test.mjs`: deterministic delay-buffer tests.
- Create `scripts/app-settings-test.mjs`: schema v2 and migration tests.
- Modify `electron/services/relay-client.ts`: sequence-to-delay integration, one timer, and lifecycle cleanup.
- Modify `electron/protocol.ts`: playback settings and AppSettings schema v2.
- Modify `src/shared/protocol.ts`: renderer copy of playback settings and AppSettings schema v2.
- Modify `electron/main.ts`: import pure settings helpers and expose delay IPC.
- Modify `electron/preload.cts`: expose `setMotionDelay`.
- Modify `src/global.d.ts`: type the delay IPC response.
- Modify `src/App.tsx`: viewer delay state, apply action, schema v2 save payload, and viewer control.
- Modify `scripts/preload-format-test.mjs`: verify the sandbox bridge contains the new API.
- Modify `scripts/relay-smoke-test.mjs`: exercise real RelayClient delay and emergency queue clearing.
- Modify `package.json`: include the new tests in existing verification commands.
- Modify `README.md`, `docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION_GUIDE.md`, and `docs/ROADMAP.md`: document the completed receive path and update roadmap status.

### Task 1: Pure Motion Delay Buffer

**Files:**
- Create: `scripts/motion-delay-buffer-test.mjs`
- Create: `electron/services/motion-delay-buffer.ts`
- Modify: `electron/services/relay-client.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing delay-buffer test**

Create `scripts/motion-delay-buffer-test.mjs` with assertions against the desired export from the existing RelayClient module:

```js
import assert from 'node:assert/strict';

const relayModule = await import('../dist-electron/services/relay-client.js');

assert.equal(
  typeof relayModule.MotionDelayBuffer,
  'function',
  'relay client module must export MotionDelayBuffer'
);

const frame = sequence => ({
  protocolVersion: 2,
  sequence,
  sourceTimeMs: 1_785_847_000_000 + sequence,
  timestamp: 1_785_847_000_000 + sequence,
  durationMs: 20,
  position: sequence / 10,
  intensity: 0.5
});

const buffer = new relayModule.MotionDelayBuffer();
assert.deepEqual(buffer.enqueue(frame(1), 1000), [frame(1)], '0ms is immediate');

buffer.setDelayMs(500);
assert.deepEqual(buffer.enqueue(frame(2), 2000), [], 'delayed frame is queued');
assert.deepEqual(buffer.drain(2499), [], 'frame is not early');
assert.deepEqual(buffer.drain(2500), [frame(2)], 'frame is due at target time');

buffer.enqueue(frame(3), 3000);
buffer.enqueue(frame(4), 3010);
assert.deepEqual(buffer.drain(3510), [frame(3), frame(4)], 'due frames retain FIFO order');

buffer.enqueue(frame(5), 4000);
buffer.setDelayMs(1000);
assert.equal(buffer.stats().bufferedFrames, 0, 'changing delay clears queued frames');

for (const invalid of [-100, 50, 10_100, 100.5, Number.NaN]) {
  assert.throws(() => buffer.setDelayMs(invalid), /invalid-motion-delay/);
}

const bounded = new relayModule.MotionDelayBuffer(3);
bounded.setDelayMs(1000);
for (let sequence = 1; sequence <= 4; sequence += 1) bounded.enqueue(frame(sequence), sequence);
assert.deepEqual(bounded.drain(2000).map(item => item.sequence), [2, 3, 4]);
assert.equal(bounded.stats().overflowFrames, 1, 'overflow drops the oldest frame');

console.log('motion delay buffer tests passed');
```

Modify `package.json` so `test:motion` runs this script after the existing sequence test:

```json
"test:motion": "npm run build:server && npm run build:electron && node scripts/motion-packet-test.mjs && node scripts/motion-sequence-test.mjs && node scripts/motion-delay-buffer-test.mjs"
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
npm.cmd run test:motion
```

Expected: FAIL with `relay client module must export MotionDelayBuffer` because the class does not exist yet.

- [ ] **Step 3: Implement the pure buffer**

Create `electron/services/motion-delay-buffer.ts`:

```ts
import type { MotionFrame } from '../protocol.js';

export const MIN_MOTION_DELAY_MS = 0;
export const MAX_MOTION_DELAY_MS = 10_000;
export const MOTION_DELAY_STEP_MS = 100;
export const DEFAULT_MAX_DELAYED_FRAMES = 2_048;

type DelayedFrame = {
  frame: MotionFrame;
  dueAtMs: number;
};

export type MotionDelayStats = {
  motionDelayMs: number;
  bufferedFrames: number;
  overflowFrames: number;
};

export class MotionDelayBuffer {
  private motionDelayMs = 0;
  private entries: DelayedFrame[] = [];
  private overflowFrames = 0;

  constructor(private readonly maxFrames = DEFAULT_MAX_DELAYED_FRAMES) {
    if (!Number.isInteger(maxFrames) || maxFrames < 1) throw new Error('invalid-motion-buffer-capacity');
  }

  setDelayMs(value: number) {
    this.motionDelayMs = validateMotionDelayMs(value);
    this.clear();
    return this.stats();
  }

  enqueue(frame: MotionFrame, receivedAtMs: number) {
    if (this.motionDelayMs === 0) return [frame];

    this.entries.push({ frame, dueAtMs: receivedAtMs + this.motionDelayMs });
    if (this.entries.length > this.maxFrames) {
      this.entries.shift();
      this.overflowFrames += 1;
    }
    return [];
  }

  drain(nowMs: number) {
    const due: MotionFrame[] = [];
    while (this.entries[0] && this.entries[0].dueAtMs <= nowMs) {
      due.push(this.entries.shift()!.frame);
    }
    return due;
  }

  nextWaitMs(nowMs: number) {
    const next = this.entries[0];
    return next ? Math.max(0, next.dueAtMs - nowMs) : undefined;
  }

  clear() {
    this.entries = [];
  }

  stats(): MotionDelayStats {
    return {
      motionDelayMs: this.motionDelayMs,
      bufferedFrames: this.entries.length,
      overflowFrames: this.overflowFrames
    };
  }
}

export function validateMotionDelayMs(value: number) {
  if (!Number.isInteger(value)
    || value < MIN_MOTION_DELAY_MS
    || value > MAX_MOTION_DELAY_MS
    || value % MOTION_DELAY_STEP_MS !== 0) {
    throw new Error('invalid-motion-delay');
  }
  return value;
}
```

Import and re-export the class in `electron/services/relay-client.ts` so the focused test can load it from an existing compiled module:

```ts
import { MotionDelayBuffer } from './motion-delay-buffer.js';
export { MotionDelayBuffer } from './motion-delay-buffer.js';
```

- [ ] **Step 4: Run the test and verify GREEN**

Run:

```powershell
npm.cmd run test:motion
```

Expected: `motion-v2 packet tests passed`, `motion sequence tests passed`, and `motion delay buffer tests passed`.

- [ ] **Step 5: Commit the pure buffer**

```powershell
git add -- electron/services/motion-delay-buffer.ts electron/services/relay-client.ts scripts/motion-delay-buffer-test.mjs package.json
git commit -m "feat: add viewer motion delay buffer core" -m "Constraint: delay frames by local receipt time in 100ms increments" -m "Rejected: per-frame timers | complicate bounded cancellation" -m "Confidence: high" -m "Scope-risk: narrow"
```

### Task 2: AppSettings Schema V2 and Migration

**Files:**
- Create: `electron/app-settings.ts`
- Create: `scripts/app-settings-test.mjs`
- Modify: `electron/protocol.ts`
- Modify: `src/shared/protocol.ts`
- Modify: `electron/main.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing schema and migration test**

Create `scripts/app-settings-test.mjs`:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const protocolSource = await readFile(new URL('../electron/protocol.ts', import.meta.url), 'utf8');
assert.match(protocolSource, /schemaVersion:\s*2/, 'AppSettings must use schema version 2');

const settingsModule = await import('../dist-electron/app-settings.js');
const hardwareProfile = {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
};
const hardwareProtection = {
  intensityLimit: 1,
  positionMin: 0,
  positionMax: 1,
  paused: false
};

const migratedV1 = settingsModule.migrateAppSettings({
  schemaVersion: 1,
  hardwareProfile,
  hardwareProtection
});
assert.equal(migratedV1.schemaVersion, 2);
assert.equal(migratedV1.playback.motionDelayMs, 0);
assert.deepEqual(migratedV1.hardwareProfile, hardwareProfile);

const migratedLegacy = settingsModule.migrateAppSettings({ hardwareProfile, hardwareProtection });
assert.equal(migratedLegacy.schemaVersion, 2);
assert.equal(migratedLegacy.playback.motionDelayMs, 0);

const validated = settingsModule.validateAppSettings({
  schemaVersion: 2,
  hardwareProfile,
  hardwareProtection,
  playback: { motionDelayMs: 700 }
});
assert.equal(validated.playback.motionDelayMs, 700);

for (const motionDelayMs of [-100, 50, 10_100]) {
  assert.throws(() => settingsModule.validateAppSettings({
    schemaVersion: 2,
    hardwareProfile,
    hardwareProtection,
    playback: { motionDelayMs }
  }), /invalid-motion-delay/);
}

console.log('app settings v2 tests passed');
```

Append the new script to `test:electron`:

```json
"test:electron": "npm run build:electron && node scripts/preload-format-test.mjs && node scripts/app-settings-test.mjs"
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
npm.cmd run test:electron
```

Expected: FAIL with `AppSettings must use schema version 2`.

- [ ] **Step 3: Add schema v2 types**

In both `electron/protocol.ts` and `src/shared/protocol.ts`, add:

```ts
export type PlaybackSettings = {
  motionDelayMs: number;
};

export type AppSettings = {
  schemaVersion: 2;
  hardwareProfile: HardwareProfile;
  hardwareProtection: HardwareProtection;
  playback: PlaybackSettings;
};
```

- [ ] **Step 4: Extract pure settings validation and migration**

Create `electron/app-settings.ts`. Move the existing default hardware profile, default protection, hardware validators, settings validator, and migration code out of `electron/main.ts`. Export these exact APIs:

```ts
import type { AppSettings, HardwareProfile, HardwareProtection } from './protocol.js';
import { validateMotionDelayMs } from './services/motion-delay-buffer.js';

export const CURRENT_SETTINGS_SCHEMA_VERSION = 2;
export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
  hardwareProfile: {
    baudRate: 115200,
    linearAxis: 'L0',
    vibrationAxis: undefined,
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  },
  hardwareProtection: {
    intensityLimit: 1,
    positionMin: 0,
    positionMax: 1,
    paused: false
  },
  playback: { motionDelayMs: 0 }
};

export function validateAppSettings(value: unknown): AppSettings {
  if (!isRecord(value) || value.schemaVersion !== CURRENT_SETTINGS_SCHEMA_VERSION) {
    throw new Error('unsupported-settings-version');
  }
  if (!isRecord(value.playback)) throw new Error('invalid-playback-settings');
  return {
    schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    hardwareProfile: validateHardwareProfile(value.hardwareProfile),
    hardwareProtection: validateHardwareProtection(value.hardwareProtection),
    playback: { motionDelayMs: validateMotionDelayMs(value.playback.motionDelayMs as number) }
  };
}

export function migrateAppSettings(value: unknown): AppSettings {
  if (!isRecord(value)) throw new Error('invalid-app-settings');
  if (value.schemaVersion === CURRENT_SETTINGS_SCHEMA_VERSION) return validateAppSettings(value);
  if (value.schemaVersion === 1 || value.schemaVersion === undefined) {
    return validateAppSettings({
      schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
      hardwareProfile: value.hardwareProfile,
      hardwareProtection: value.hardwareProtection,
      playback: { motionDelayMs: 0 }
    });
  }
  throw new Error('unsupported-settings-version');
}
```

Add the hardware validators to the same module:

```ts
export function validateHardwareProfile(value: unknown): HardwareProfile {
  if (!isRecord(value)) throw new Error('invalid-hardware-profile');
  const strokeMin = validateUnitInterval(value.strokeMin, 'strokeMin');
  const strokeMax = validateUnitInterval(value.strokeMax, 'strokeMax');
  if (strokeMin >= strokeMax) throw new Error('invalid-stroke-range');
  const vibrationAxis = value.vibrationAxis === undefined || value.vibrationAxis === ''
    ? undefined
    : validateTCodeAxis(value.vibrationAxis, 'vibrationAxis');
  return {
    baudRate: validateBaudRate(value.baudRate),
    linearAxis: validateTCodeAxis(value.linearAxis, 'linearAxis'),
    vibrationAxis,
    strokeMin,
    strokeMax,
    invertPosition: validateBoolean(value.invertPosition, 'invertPosition')
  };
}

export function validateHardwareProtection(value: unknown): HardwareProtection {
  if (!isRecord(value)) throw new Error('invalid-hardware-protection');
  const positionMin = validateUnitInterval(value.positionMin, 'protectionPositionMin');
  const positionMax = validateUnitInterval(value.positionMax, 'protectionPositionMax');
  if (positionMin >= positionMax) throw new Error('invalid-protection-position-range');
  return {
    intensityLimit: validateUnitInterval(value.intensityLimit, 'protectionIntensityLimit'),
    positionMin,
    positionMax,
    paused: validateBoolean(value.paused, 'protectionPaused')
  };
}

function validateBaudRate(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1200 || value > 1_000_000) {
    throw new Error('invalid-baud-rate');
  }
  return value;
}

function validateTCodeAxis(value: unknown, fieldName: string) {
  if (typeof value !== 'string') throw new Error(`invalid-${fieldName}`);
  const axis = value.trim().toUpperCase();
  if (!/^[LRVA][0-9]$/.test(axis)) throw new Error(`invalid-${fieldName}`);
  return axis;
}

export function validateUnitInterval(value: unknown, fieldName: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`invalid-${fieldName}`);
  }
  return value;
}

export function validateBoolean(value: unknown, fieldName: string) {
  if (typeof value !== 'boolean') throw new Error(`invalid-${fieldName}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
```

Update `electron/main.ts` imports:

```ts
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  migrateAppSettings,
  validateAppSettings,
  validateBoolean,
  validateHardwareProfile,
  validateHardwareProtection,
  validateUnitInterval
} from './app-settings.js';
```

Delete the moved constants, hardware validators, `validateUnitInterval`, and `validateBoolean` from `electron/main.ts`. Keep main's `isRecord` because room and join request validation still use it. Keep `readSettings`, `writeSettings`, and `getSettingsPath` in main because they depend on Electron app paths and filesystem I/O.

Change `readSettings()` so both unversioned and schema v1 files are persisted as v2 after migration:

```ts
async function readSettings(): Promise<AppSettings> {
  try {
    const raw = await fs.readFile(getSettingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as { schemaVersion?: unknown };
    const settings = migrateAppSettings(parsed);
    if (parsed.schemaVersion !== CURRENT_SETTINGS_SCHEMA_VERSION) {
      await writeSettings(settings);
      addLog({ level: 'info', source: 'app', message: 'settings-migrated', details: `v${settings.schemaVersion}` });
    }
    return settings;
  } catch (error) {
    addLog({ level: 'warning', source: 'app', message: 'settings-defaulted', details: formatError(error) });
    return DEFAULT_SETTINGS;
  }
}
```

- [ ] **Step 5: Run settings and type tests**

Run:

```powershell
npm.cmd run test:electron
npx.cmd tsc --noEmit
```

Expected: `app settings v2 tests passed`, `sandbox preload format: commonjs`, and TypeScript exit code 0.

- [ ] **Step 6: Commit schema migration**

```powershell
git add -- electron/app-settings.ts electron/protocol.ts src/shared/protocol.ts electron/main.ts scripts/app-settings-test.mjs package.json
git commit -m "feat: migrate app settings to motion delay v2" -m "Constraint: preserve v1 hardware settings while defaulting viewer delay to zero" -m "Confidence: high" -m "Scope-risk: moderate"
```

### Task 3: RelayClient Scheduling and Safety Cleanup

**Files:**
- Modify: `scripts/relay-smoke-test.mjs`
- Modify: `electron/services/relay-client.ts`
- Modify: `package.json`

- [ ] **Step 1: Write a failing real-client delay smoke test**

Import the compiled RelayClient in `scripts/relay-smoke-test.mjs` after the server is ready:

```js
const { RelayClient } = await import('../dist-electron/services/relay-client.js');
```

Inside the open-room test, add a real app viewer and assert that a 300ms setting delays delivery:

```js
const delayedFrames = [];
let resolveDelayedFrame;
const delayedFramePromise = new Promise(resolve => { resolveDelayedFrame = resolve; });
const delayedViewer = new RelayClient(frame => {
  delayedFrames.push({ frame, receivedAt: Date.now() });
  resolveDelayedFrame?.(delayedFrames.at(-1));
});
sockets.push(delayedViewer);
await delayedViewer.joinRoom(baseUrl, {
  displayName: 'delayed-viewer',
  roomName,
  password: 'open-secret'
});

assert.equal(typeof delayedViewer.setMotionDelay, 'function', 'RelayClient exposes delay control');
delayedViewer.setMotionDelay(300);
const delayedStartedAt = Date.now();
host.volatile.compress(false).emit('m', encodeMotionPacket({
  protocolVersion: 2,
  sequence: 78,
  sourceTimeMs: Date.now(),
  timestamp: Date.now(),
  durationMs: 20,
  position: 0.4,
  intensity: 0.6
}));
await delay(100);
record('viewer delay blocks early output', delayedFrames.length === 0, `received=${delayedFrames.length}`);
const delayed = await Promise.race([
  delayedFramePromise,
  delay(1000).then(() => { throw new Error('delayed-motion-timeout'); })
]);
record('viewer delay releases due output', delayed.receivedAt - delayedStartedAt >= 250, JSON.stringify(delayed));
```

Then enqueue another delayed frame, issue room stop, wait beyond its due time, and assert the frame count does not increase:

```js
delayedViewer.setMotionDelay(500);
const beforeStopCount = delayedFrames.length;
host.volatile.compress(false).emit('m', encodeMotionPacket({
  protocolVersion: 2,
  sequence: 79,
  sourceTimeMs: Date.now(),
  timestamp: Date.now(),
  durationMs: 20,
  position: 0.7,
  intensity: 0.7
}));
await delay(50);
await emitWithAck(host, 'room:stop', {});
await delay(550);
record('room stop clears delayed output', delayedFrames.length === beforeStopCount, `received=${delayedFrames.length}`);
```

Change `test:smoke` in `package.json` so Electron is built before the script imports RelayClient:

```json
"test:smoke": "npm run build:server && npm run build:electron && node scripts/relay-smoke-test.mjs"
```

- [ ] **Step 2: Run the smoke test and verify RED**

Run:

```powershell
npm.cmd run test:smoke
```

Expected: FAIL with `RelayClient exposes delay control`.

- [ ] **Step 3: Integrate the buffer and one timer**

In `electron/services/relay-client.ts`, add:

```ts
import { performance } from 'node:perf_hooks';

private readonly incomingDelayBuffer = new MotionDelayBuffer();
private delayTimer: NodeJS.Timeout | undefined;
```

Reuse the `MotionDelayBuffer` import added in Task 1; do not add a second import for the same symbol.

Replace direct receive delivery with:

```ts
const frame = decodeMotionPacket(payload);
if (!this.incomingSequenceTracker.accept(frame)) return;
for (const immediate of this.incomingDelayBuffer.enqueue(frame, performance.now())) {
  this.onMotion?.(immediate);
}
this.scheduleDelayedMotion();
```

Add these methods:

```ts
setMotionDelay(delayMs: number) {
  this.clearDelayedMotion();
  return this.incomingDelayBuffer.setDelayMs(delayMs);
}

getMotionDelayStats() {
  return this.incomingDelayBuffer.stats();
}

private scheduleDelayedMotion() {
  if (this.delayTimer) return;
  const waitMs = this.incomingDelayBuffer.nextWaitMs(performance.now());
  if (waitMs === undefined) return;
  this.delayTimer = setTimeout(() => {
    this.delayTimer = undefined;
    for (const frame of this.incomingDelayBuffer.drain(performance.now())) this.onMotion?.(frame);
    this.scheduleDelayedMotion();
  }, waitMs);
}

private clearDelayedMotion() {
  if (this.delayTimer) clearTimeout(this.delayTimer);
  this.delayTimer = undefined;
  this.incomingDelayBuffer.clear();
}
```

Call `clearDelayedMotion()` before status callbacks on socket disconnect, viewer rejection, viewer removal, room stop, successful create/join room transitions, explicit `disconnect()`, and emergency stop completion. Keep the configured delay value when clearing; only queued entries and the active timer are removed.

- [ ] **Step 4: Run motion and smoke tests**

Run:

```powershell
npm.cmd run test:motion
npm.cmd run test:smoke
```

Expected: all motion tests pass and the smoke summary reports zero failed checks, including early blocking, due release, and room-stop cleanup.

- [ ] **Step 5: Commit RelayClient integration**

```powershell
git add -- electron/services/relay-client.ts scripts/relay-smoke-test.mjs package.json
git commit -m "feat: schedule delayed viewer motion" -m "Constraint: clear queued motion at every session and safety boundary" -m "Rejected: source timestamp scheduling | host and viewer wall clocks may differ" -m "Confidence: high" -m "Scope-risk: moderate"
```

### Task 4: Electron IPC and Viewer Control

**Files:**
- Modify: `scripts/preload-format-test.mjs`
- Modify: `electron/main.ts`
- Modify: `electron/preload.cts`
- Modify: `src/global.d.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write the failing preload bridge test**

Add assertions to `scripts/preload-format-test.mjs`:

```js
assert.match(preloadSource, /setMotionDelay:\s*\(delayMs/);
assert.match(preloadSource, /ipcRenderer\.invoke\(['"]viewer:set-motion-delay['"]/);
```

- [ ] **Step 2: Run the Electron test and verify RED**

Run:

```powershell
npm.cmd run test:electron
```

Expected: FAIL because `setMotionDelay` is not present in the preload bundle.

- [ ] **Step 3: Add narrow main-process IPC**

In `electron/main.ts`, add a handler that validates, persists, and applies only the playback delay while preserving saved hardware settings:

```ts
ipcMain.handle('viewer:set-motion-delay', async (event, delayMs: unknown) => {
  assertTrustedSender(event);
  const motionDelayMs = validateMotionDelayMs(delayMs as number);
  const current = await readSettings();
  const settings: AppSettings = {
    ...current,
    playback: { motionDelayMs }
  };
  await writeSettings(settings);
  const buffer = relay.setMotionDelay(motionDelayMs);
  addLog({ level: 'info', source: 'relay', message: 'motion-delay-applied', details: `${motionDelayMs}ms` });
  return { settings, buffer };
});
```

Import `validateMotionDelayMs` from `electron/services/motion-delay-buffer.ts`. Update `app:get-settings` to apply the persisted delay before returning settings, and update `app:save-settings` to call `relay.setMotionDelay(nextSettings.playback.motionDelayMs)` after writing a valid v2 settings object.

- [ ] **Step 4: Expose and type the preload API**

Add to `electron/preload.cts`:

```ts
setMotionDelay: (delayMs: number) => ipcRenderer.invoke('viewer:set-motion-delay', delayMs),
```

Add to `src/global.d.ts`:

```ts
setMotionDelay: (delayMs: number) => Promise<{
  settings: AppSettings;
  buffer: {
    motionDelayMs: number;
    bufferedFrames: number;
    overflowFrames: number;
  };
}>;
```

- [ ] **Step 5: Add viewer state and apply action**

In `src/App.tsx`, change the settings version to 2, add state, and include playback in every save payload:

```tsx
const CURRENT_SETTINGS_SCHEMA_VERSION = 2;
const [motionDelayMs, setMotionDelayMs] = useState(0);
const [appliedMotionDelayMs, setAppliedMotionDelayMs] = useState(0);
```

In `loadSettings()`:

```tsx
setMotionDelayMs(settings.playback.motionDelayMs);
setAppliedMotionDelayMs(settings.playback.motionDelayMs);
```

In `saveSettings()` add:

```tsx
playback: { motionDelayMs }
```

After the save response, keep the displayed active value synchronized because `app:save-settings` also applies the saved delay:

```tsx
setMotionDelayMs(result.settings.playback.motionDelayMs);
setAppliedMotionDelayMs(result.settings.playback.motionDelayMs);
```

Add the apply action:

```tsx
async function applyMotionDelay() {
  await runAction('delay', '모션 지연 적용 중', async () => {
    const result = await window.hapticRelay.setMotionDelay(motionDelayMs);
    setMotionDelayMs(result.settings.playback.motionDelayMs);
    setAppliedMotionDelayMs(result.settings.playback.motionDelayMs);
    setSavedSettings(result.settings);
    setStatusMessage('ok', `모션 지연 적용됨: ${(result.settings.playback.motionDelayMs / 1000).toFixed(1)}초`);
  });
}
```

Extend `BusyAction` with `'delay'`.

- [ ] **Step 6: Render the viewer-only delay control**

Place this panel after the viewer room-entry panel and before `hardwarePanel`:

```tsx
<section className="panel">
  <div className="panel-header">
    <h2>모션 지연</h2>
    <strong>{(motionDelayMs / 1000).toFixed(1)}초</strong>
  </div>
  <label>
    영상 동기화 지연
    <input
      type="range"
      min="0"
      max="10000"
      step="100"
      value={motionDelayMs}
      onChange={event => setMotionDelayMs(Number(event.target.value))}
    />
  </label>
  <div className="button-row">
    <button className="primary" disabled={isBusy} onClick={applyMotionDelay}>지연 적용</button>
    <span className="field-value">현재 적용 {(appliedMotionDelayMs / 1000).toFixed(1)}초</span>
  </div>
</section>
```

Use existing `panel-header`, `button-row`, range input, and `field-value` styles so no new decorative component or nested card is introduced.

- [ ] **Step 7: Run Electron, type, and renderer checks**

Run:

```powershell
npm.cmd run test:electron
npx.cmd tsc --noEmit
npm.cmd run build:renderer
```

Expected: Electron and TypeScript tests pass. Renderer build should pass in a normal environment; if this workspace again returns Vite/esbuild `spawn EPERM`, record that exact environment limitation without treating it as a TypeScript failure.

- [ ] **Step 8: Commit IPC and UI**

```powershell
git add -- electron/main.ts electron/preload.cts src/global.d.ts src/App.tsx scripts/preload-format-test.mjs
git commit -m "feat: add viewer motion delay control" -m "Constraint: apply delay only on explicit 100ms-step user command" -m "Confidence: high" -m "Scope-risk: moderate" -m "Not-tested: renderer build may be blocked by Vite/esbuild spawn EPERM in the managed workspace"
```

### Task 5: Documentation and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/IMPLEMENTATION_GUIDE.md`
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Update user and architecture documentation**

Document this receive path in all applicable docs:

```text
decode -> sequence filter -> local receipt-time delay queue -> hardware queue
```

State these exact rules:

- range `0-10000ms`;
- step `100ms`;
- default and migrated value `0ms`;
- delay changes and session/safety events clear queued frames;
- local interpolation remains the next Phase 1 task.

Update `docs/ROADMAP.md` so Motion Packet V2, sequence filtering, and viewer delay are marked complete while local interpolation remains pending.

- [ ] **Step 2: Run complete fresh verification**

Run each command and inspect its exit code and output:

```powershell
npm.cmd run test:motion
npm.cmd run test:smoke
npm.cmd run test:electron
npx.cmd tsc --noEmit
npm.cmd run build:server
npm.cmd run build:electron
npm.cmd run build:renderer
git diff --check
```

Expected:

- motion packet, sequence, and delay-buffer tests pass;
- server smoke has zero failures, including delayed release and emergency cleanup;
- preload and settings migration tests pass;
- TypeScript, server, and Electron builds exit 0;
- renderer build exits 0 outside the known managed-environment `spawn EPERM` restriction;
- `git diff --check` exits 0.

- [ ] **Step 3: Commit documentation**

```powershell
git add -- README.md docs/ARCHITECTURE.md docs/IMPLEMENTATION_GUIDE.md docs/ROADMAP.md
git commit -m "docs: record viewer motion delay workflow" -m "Constraint: keep interpolation as the next independent Phase 1 task" -m "Confidence: high" -m "Scope-risk: narrow"
```

- [ ] **Step 4: Confirm repository state**

Run:

```powershell
git status --short
git log --oneline -7
```

Expected: clean worktree and a bisectable sequence of delay-buffer core, settings migration, RelayClient integration, UI, and documentation commits.
