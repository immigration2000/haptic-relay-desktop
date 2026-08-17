# Automatic Motion Patterns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four safe, main-process-driven automatic motion patterns to the host demo panel and ship a tested `v0.1.1-demo.3` Windows installer.

**Architecture:** A pure pattern calculator maps monotonic elapsed time to normalized positions. `DemoMotionStream` owns the single 30Hz timer, mode transitions, the 300ms entry ramp, and safe stop behavior; the renderer only sends validated configuration and displays snapshots pushed from Electron main. Existing `MotionFrame` relay, hardware protection, room, and server paths remain unchanged.

**Tech Stack:** TypeScript 5.8, Electron 37 IPC/context bridge, React 19, CSS, Node assertion scripts, Socket.IO integration tests, electron-builder NSIS.

---

## File Map

- Create `electron/services/demo-motion-pattern.ts`: pattern types, validation, phase calculation, and range mapping.
- Modify `electron/services/demo-motion-stream.ts`: manual/pattern state machine, one 30Hz timer, entry ramp, live pattern updates, and safe stop.
- Modify `electron/protocol.ts`: Electron-side pattern configuration and demo snapshot contracts.
- Modify `src/shared/protocol.ts`: renderer-side mirror of pattern configuration and demo snapshot contracts.
- Modify `electron/main.ts`: preserve full motion frames, register pattern IPC, and publish demo snapshots safely.
- Modify `electron/preload.cts`: expose start/update pattern and snapshot listener APIs.
- Modify `src/global.d.ts`: type the new preload APIs.
- Create `src/ui/components/MotionDemoPanel.tsx`: focused manual/pattern controls and live preview.
- Modify `src/App.tsx`: own demo mode/configuration state and coordinate IPC lifecycle.
- Modify `src/styles.css`: compact responsive controls for 1180x780 and 960x640.
- Create `scripts/demo-motion-pattern-test.mjs`: deterministic calculator and validation tests.
- Modify `scripts/demo-motion-stream-test.mjs`: deterministic mode, ramp, update, and stop tests.
- Modify `scripts/preload-format-test.mjs`: verify the sandbox bridge and main-process validation path.
- Modify `scripts/electron-ui-smoke-test.mjs`: exercise the automatic pattern UI and responsive layout.
- Modify `scripts/packaged-two-client-test.mjs`: prove changing automatic positions reach a second app.
- Modify `package.json` and `package-lock.json`: register tests and bump the stage release version.
- Modify `docs/DESKTOP_DEMO_TEST_GUIDE.md`, `docs/WINDOWS_INSTALL_GUIDE.md`, and `docs/ROADMAP.md`: document automatic pattern operation and release status.

## Task 1: Pure Pattern Calculator

**Files:**
- Create: `electron/services/demo-motion-pattern.ts`
- Modify: `electron/protocol.ts`
- Modify: `src/shared/protocol.ts`
- Create: `scripts/demo-motion-pattern-test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add the shared pattern contracts**

Add the same contract to both protocol files so the isolated Electron and renderer TypeScript builds agree:

```ts
export type MotionPattern = 'sine' | 'triangle' | 'pulse' | 'sawtooth';

export type MotionPatternConfig = {
  pattern: MotionPattern;
  periodMs: number;
  positionMin: number;
  positionMax: number;
  intensity: number;
};

export type MotionDemoMode = 'manual' | 'pattern';

export type MotionDemoSnapshot = {
  mode: MotionDemoMode;
  frame: MotionFrame;
};
```

- [ ] **Step 2: Write the failing calculator and validator test**

Create `scripts/demo-motion-pattern-test.mjs` with exact phase and validation cases:

```js
import assert from 'node:assert/strict';

const {
  calculatePatternPosition,
  validateMotionPatternConfig
} = await import('../dist-electron/services/demo-motion-pattern.js');

const base = {
  pattern: 'triangle',
  periodMs: 1_000,
  positionMin: 0.2,
  positionMax: 0.8,
  intensity: 0.6
};

assert.equal(calculatePatternPosition(base, 0), 0.2);
assert.equal(calculatePatternPosition(base, 250), 0.5);
assert.equal(calculatePatternPosition(base, 500), 0.8);
assert.equal(calculatePatternPosition(base, 750), 0.5);
assert.equal(calculatePatternPosition(base, 1_000), 0.2);

assert.equal(calculatePatternPosition({ ...base, pattern: 'sine' }, 0), 0.2);
assert.equal(calculatePatternPosition({ ...base, pattern: 'sine' }, 500), 0.8);
assert.equal(calculatePatternPosition({ ...base, pattern: 'sawtooth' }, 500), 0.5);
assert.equal(calculatePatternPosition({ ...base, pattern: 'pulse' }, 25), 0.5);
assert.equal(calculatePatternPosition({ ...base, pattern: 'pulse' }, 250), 0.8);
assert.equal(calculatePatternPosition({ ...base, pattern: 'pulse' }, 525), 0.5);
assert.equal(calculatePatternPosition({ ...base, pattern: 'pulse' }, 750), 0.2);

assert.deepEqual(validateMotionPatternConfig(base), base);
assert.throws(() => validateMotionPatternConfig({ ...base, pattern: 'random' }), /invalid-motion-pattern/);
assert.throws(() => validateMotionPatternConfig({ ...base, periodMs: 499 }), /invalid-pattern-period/);
assert.throws(() => validateMotionPatternConfig({ ...base, periodMs: 5_001 }), /invalid-pattern-period/);
assert.throws(() => validateMotionPatternConfig({ ...base, positionMin: 0.9 }), /invalid-pattern-range/);
assert.throws(() => validateMotionPatternConfig({ ...base, intensity: 2 }), /invalid-pattern-intensity/);

console.log('demo motion pattern tests passed');
```

- [ ] **Step 3: Register and run the failing test**

Add the new script after `demo-motion-stream-test.mjs` in `test:electron`:

```json
"test:electron": "npm run build:electron && node scripts/preload-format-test.mjs && node scripts/app-settings-test.mjs && node scripts/settings-file-store-test.mjs && node scripts/window-messenger-test.mjs && node scripts/demo-motion-stream-test.mjs && node scripts/demo-motion-pattern-test.mjs"
```

Run:

```powershell
npm.cmd run test:electron
```

Expected: FAIL because `dist-electron/services/demo-motion-pattern.js` does not exist.

- [ ] **Step 4: Implement the pure calculator and validator**

Create `electron/services/demo-motion-pattern.ts`:

```ts
import type { MotionPattern, MotionPatternConfig } from '../protocol.js';

const MOTION_PATTERNS = new Set<MotionPattern>(['sine', 'triangle', 'pulse', 'sawtooth']);

export function calculatePatternPosition(config: MotionPatternConfig, elapsedMs: number) {
  const phase = positiveModulo(elapsedMs, config.periodMs) / config.periodMs;
  const unit = calculateUnitPosition(config.pattern, phase);
  return config.positionMin + (config.positionMax - config.positionMin) * unit;
}

export function validateMotionPatternConfig(value: unknown): MotionPatternConfig {
  if (!isRecord(value) || !MOTION_PATTERNS.has(value.pattern as MotionPattern)) {
    throw new Error('invalid-motion-pattern');
  }
  if (typeof value.periodMs !== 'number' || !Number.isFinite(value.periodMs) || value.periodMs < 500 || value.periodMs > 5_000) {
    throw new Error('invalid-pattern-period');
  }
  const positionMin = validateUnit(value.positionMin, 'invalid-pattern-range');
  const positionMax = validateUnit(value.positionMax, 'invalid-pattern-range');
  if (positionMin > positionMax) throw new Error('invalid-pattern-range');
  return {
    pattern: value.pattern as MotionPattern,
    periodMs: value.periodMs,
    positionMin,
    positionMax,
    intensity: validateUnit(value.intensity, 'invalid-pattern-intensity')
  };
}

function calculateUnitPosition(pattern: MotionPattern, phase: number) {
  if (pattern === 'sine') return (1 - Math.cos(phase * Math.PI * 2)) / 2;
  if (pattern === 'triangle') return phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  if (pattern === 'sawtooth') return phase;
  if (phase < 0.05) return phase / 0.05;
  if (phase < 0.5) return 1;
  if (phase < 0.55) return 1 - (phase - 0.5) / 0.05;
  return 0;
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function validateUnit(value: unknown, errorCode: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(errorCode);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 5: Run calculator tests and type checks**

Run:

```powershell
npm.cmd run test:electron
npm.cmd run lint
```

Expected: both commands PASS and print `demo motion pattern tests passed`.

- [ ] **Step 6: Commit the calculator**

```powershell
git add electron/protocol.ts src/shared/protocol.ts electron/services/demo-motion-pattern.ts scripts/demo-motion-pattern-test.mjs package.json
git commit -m "feat(motion): add deterministic demo patterns" -m "Constraint: Keep pattern output normalized and independent from renderer timing." -m "Confidence: high" -m "Scope-risk: narrow"
```

## Task 2: Main-Process Pattern State and Safety

**Files:**
- Modify: `electron/services/demo-motion-stream.ts`
- Modify: `scripts/demo-motion-stream-test.mjs`

- [ ] **Step 1: Replace the stream test with manual and pattern fake-clock cases**

Replace `scripts/demo-motion-stream-test.mjs` with:

```js
import assert from 'node:assert/strict';

const { DemoMotionStream, DEMO_MOTION_INTERVAL_MS } = await import('../dist-electron/services/demo-motion-stream.js');

function createHarness() {
  const published = [];
  const intervals = [];
  const cleared = [];
  let wallNow = 1_000;
  let monotonicNow = 0;
  const stream = new DemoMotionStream(
    frame => published.push(frame),
    (callback, intervalMs) => {
      const timer = { callback, intervalMs };
      intervals.push(timer);
      return timer;
    },
    timer => cleared.push(timer),
    () => wallNow,
    () => monotonicNow
  );
  return {
    stream,
    published,
    intervals,
    cleared,
    setTime(wall, monotonic) { wallNow = wall; monotonicNow = monotonic; }
  };
}

assert.equal(DEMO_MOTION_INTERVAL_MS, 1000 / 30);

const manual = createHarness();
assert.deepEqual(manual.stream.start({ intensity: 0.4, position: 0.2 }), {
  streaming: true,
  mode: 'manual',
  intervalMs: DEMO_MOTION_INTERVAL_MS
});
assert.deepEqual(manual.published.at(-1), {
  intensity: 0.4,
  position: 0.2,
  timestamp: 1_000,
  durationMs: DEMO_MOTION_INTERVAL_MS
});
manual.stream.update({ intensity: 0.8, position: 0.7 });
manual.setTime(1_033, 33);
manual.intervals[0].callback();
assert.equal(manual.published.at(-1).position, 0.7);
manual.stream.start({ intensity: 0.6, position: 0.5 });
assert.equal(manual.intervals.length, 1, 'manual restart reuses the interval');
manual.setTime(1_040, 40);
assert.deepEqual(manual.stream.stop(), { streaming: false });
assert.equal(manual.cleared.length, 1);
assert.deepEqual(manual.published.at(-1), {
  intensity: 0,
  position: 0.5,
  timestamp: 1_040,
  durationMs: DEMO_MOTION_INTERVAL_MS
});
assert.deepEqual(manual.stream.stop(), { streaming: false });

const automatic = createHarness();
automatic.stream.start({ intensity: 0.3, position: 0.5 });
const pattern = {
  pattern: 'triangle',
  periodMs: 1_000,
  positionMin: 0.2,
  positionMax: 0.8,
  intensity: 0.7
};
assert.deepEqual(automatic.stream.startPattern(pattern), {
  streaming: true,
  mode: 'pattern',
  intervalMs: DEMO_MOTION_INTERVAL_MS
});
assert.equal(automatic.intervals.length, 1, 'mode switch reuses the interval');
assert.equal(automatic.published.at(-2).intensity, 0, 'mode switch sends safe zero intensity');
assert.equal(automatic.published.at(-1).position, 0.5, 'pattern begins at the current position');
automatic.setTime(1_150, 150);
automatic.intervals[0].callback();
assert.equal(automatic.published.at(-1).position, 0.35);
automatic.setTime(1_300, 300);
automatic.intervals[0].callback();
assert.equal(automatic.published.at(-1).position, 0.2);
automatic.setTime(1_550, 550);
automatic.intervals[0].callback();
assert.equal(automatic.published.at(-1).position, 0.5);
assert.deepEqual(automatic.stream.updatePattern({ ...pattern, positionMin: 0.4, positionMax: 0.9 }), {
  streaming: true,
  accepted: true
});
assert.equal(automatic.intervals.length, 1, 'live pattern update reuses the interval');
automatic.setTime(1_700, 700);
automatic.intervals[0].callback();
assert.equal(automatic.published.at(-1).position, 0.45, 'updated pattern ramps from the live position');
automatic.stream.stop();
assert.equal(automatic.published.at(-1).intensity, 0);

console.log('demo motion stream tests passed');
```

- [ ] **Step 2: Run the test and confirm the new API is missing**

```powershell
npm.cmd run build:electron
node scripts/demo-motion-stream-test.mjs
```

Expected: FAIL with `stream.startPattern is not a function`.

- [ ] **Step 3: Replace the stream service with the pattern state machine**

Replace `electron/services/demo-motion-stream.ts` with:

```ts
import { performance } from 'node:perf_hooks';
import type { MotionFrame, MotionDemoMode, MotionPatternConfig } from '../protocol.js';
import { calculatePatternPosition } from './demo-motion-pattern.js';

export const DEMO_MOTION_INTERVAL_MS = 1000 / 30;
export const PATTERN_ENTRY_RAMP_MS = 300;

type DemoMotion = Pick<MotionFrame, 'intensity' | 'position'>;
type PublishMotion = (frame: MotionFrame) => void;
type IntervalFactory = (callback: () => void, intervalMs: number) => unknown;
type IntervalClearer = (timer: unknown) => void;

export class DemoMotionStream {
  private timer: unknown;
  private latest: DemoMotion = { intensity: 0, position: 0.5 };
  private mode: MotionDemoMode = 'manual';
  private pattern: MotionPatternConfig | undefined;
  private patternStartedAt = 0;
  private patternRampFrom = 0.5;

  constructor(
    private readonly publish: PublishMotion,
    private readonly createInterval: IntervalFactory = (callback, intervalMs) => setInterval(callback, intervalMs),
    private readonly clearIntervalHandle: IntervalClearer = timer => clearInterval(timer as NodeJS.Timeout),
    private readonly now: () => number = Date.now,
    private readonly monotonicNow: () => number = () => performance.now()
  ) {}

  start(next: DemoMotion) {
    this.safeTransition('manual');
    this.pattern = undefined;
    this.latest = next;
    this.publishLatest();
    this.ensureTimer();
    return { streaming: true, mode: 'manual' as const, intervalMs: DEMO_MOTION_INTERVAL_MS };
  }

  update(next: DemoMotion) {
    if (this.timer === undefined || this.mode !== 'manual') return { streaming: false, accepted: false };
    this.latest = next;
    return { streaming: true, accepted: true };
  }

  startPattern(config: MotionPatternConfig) {
    this.safeTransition('pattern');
    this.pattern = config;
    this.patternStartedAt = this.monotonicNow();
    this.patternRampFrom = this.latest.position;
    this.publishPattern();
    this.ensureTimer();
    return { streaming: true, mode: 'pattern' as const, intervalMs: DEMO_MOTION_INTERVAL_MS };
  }

  updatePattern(config: MotionPatternConfig) {
    if (this.timer === undefined || this.mode !== 'pattern') return { streaming: false, accepted: false };
    this.pattern = config;
    this.patternStartedAt = this.monotonicNow();
    this.patternRampFrom = this.latest.position;
    return { streaming: true, accepted: true };
  }

  stop() {
    if (this.timer === undefined) return { streaming: false };
    this.clearIntervalHandle(this.timer);
    this.timer = undefined;
    this.pattern = undefined;
    this.publishSafeStop();
    return { streaming: false };
  }

  getMode() {
    return this.mode;
  }

  private safeTransition(nextMode: MotionDemoMode) {
    if (this.timer !== undefined && this.mode !== nextMode) this.publishSafeStop();
    this.mode = nextMode;
  }

  private ensureTimer() {
    if (this.timer !== undefined) return;
    this.timer = this.createInterval(() => {
      if (this.mode === 'pattern') this.publishPattern();
      else this.publishLatest();
    }, DEMO_MOTION_INTERVAL_MS);
  }

  private publishPattern() {
    if (!this.pattern) return;
    const elapsed = this.monotonicNow() - this.patternStartedAt;
    const patternElapsed = Math.max(0, elapsed - PATTERN_ENTRY_RAMP_MS);
    const target = calculatePatternPosition(this.pattern, patternElapsed);
    const rampProgress = Math.min(1, Math.max(0, elapsed / PATTERN_ENTRY_RAMP_MS));
    const position = this.patternRampFrom + (target - this.patternRampFrom) * rampProgress;
    this.latest = { intensity: this.pattern.intensity, position };
    this.publishLatest();
  }

  private publishLatest() {
    this.publish({ ...this.latest, timestamp: this.now(), durationMs: DEMO_MOTION_INTERVAL_MS });
  }

  private publishSafeStop() {
    this.publish({ intensity: 0, position: this.latest.position, timestamp: this.now(), durationMs: DEMO_MOTION_INTERVAL_MS });
  }
}
```

- [ ] **Step 4: Run deterministic stream tests**

```powershell
npm.cmd run test:electron
```

Expected: PASS, including the calculator and stream messages.

- [ ] **Step 5: Commit the stream state machine**

```powershell
git add electron/services/demo-motion-stream.ts scripts/demo-motion-stream-test.mjs
git commit -m "feat(motion): stream automatic patterns safely" -m "Constraint: Use one main-process 30Hz timer and a 300ms entry ramp." -m "Confidence: high" -m "Scope-risk: moderate"
```

## Task 3: Secure IPC and Demo Snapshots

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/preload.cts`
- Modify: `src/global.d.ts`
- Modify: `scripts/preload-format-test.mjs`

- [ ] **Step 1: Add failing bridge assertions**

Add assertions to `scripts/preload-format-test.mjs`:

```js
assert.match(preloadSource, /startMotionPattern:\s*\(config\).*?ipcRenderer\.invoke\(['"]motion-demo:start-pattern['"],\s*config\)/);
assert.match(preloadSource, /updateMotionPattern:\s*\(config\).*?ipcRenderer\.send\(['"]motion-demo:update-pattern['"],\s*config\)/);
assert.match(preloadSource, /onMotionDemoFrame:\s*\(listener/);
assert.match(preloadSource, /ipcRenderer\.on\(['"]motion-demo:frame['"],\s*handler\)/);
assert.match(preloadSource, /removeListener\(['"]motion-demo:frame['"],\s*handler\)/);
assert.match(mainSource, /motion-demo:start-pattern[\s\S]*?validateMotionPatternConfig\(config\)[\s\S]*?demoMotionStream\.startPattern/);
assert.match(mainSource, /motion-demo:update-pattern[\s\S]*?try \{[\s\S]*?validateMotionPatternConfig\(config\)[\s\S]*?catch \(error\)/);
assert.match(mainSource, /sendToRenderer\(mainWindow, ['"]motion-demo:frame['"],/);
```

- [ ] **Step 2: Run the bridge test and verify failure**

```powershell
npm.cmd run build:electron
node scripts/preload-format-test.mjs
```

Expected: FAIL on the missing `startMotionPattern` bridge assertion.

- [ ] **Step 3: Register validated pattern IPC in Electron main**

Import the contracts and validator:

```ts
import type { AppLogEntry, AppSettings, MotionDemoSnapshot, MotionFrame, RoomSettings } from './protocol.js';
import { validateMotionPatternConfig } from './services/demo-motion-pattern.js';
```

Preserve duration metadata by changing the publish helper:

```ts
function publishMotion(frame: MotionFrame) {
  return {
    hardware: hardware.queueMotion(frame),
    relay: relay.publishMotion(frame)
  };
}

const demoMotionStream = new DemoMotionStream(frame => {
  publishMotion(frame);
  const snapshot: MotionDemoSnapshot = { mode: demoMotionStream.getMode(), frame };
  sendToRenderer(mainWindow, 'motion-demo:frame', snapshot);
});
```

Update `hardware:send` to pass a complete frame:

```ts
ipcMain.handle('hardware:send', async (event, intensity: unknown, position: unknown) => {
  assertTrustedSender(event);
  return publishMotion({
    intensity: validateUnitInterval(intensity, 'intensity'),
    position: validateUnitInterval(position, 'position'),
    timestamp: Date.now()
  });
});
```

Add pattern handlers beside the manual handlers:

```ts
ipcMain.handle('motion-demo:start-pattern', (event, config: unknown) => {
  assertTrustedSender(event);
  const validated = validateMotionPatternConfig(config);
  addLog({ level: 'info', source: 'room', message: 'motion-pattern-started', details: validated.pattern });
  return demoMotionStream.startPattern(validated);
});

ipcMain.on('motion-demo:update-pattern', (event, config: unknown) => {
  try {
    assertTrustedSender(event);
    demoMotionStream.updatePattern(validateMotionPatternConfig(config));
  } catch (error) {
    addLog({ level: 'warning', source: 'room', message: 'motion-pattern-update-rejected', details: formatError(error) });
  }
});
```

Expose `getMode(): MotionDemoMode` from `DemoMotionStream` as a read-only state query.

- [ ] **Step 4: Expose the sandboxed renderer API**

Add `MotionDemoSnapshot` and `MotionPatternConfig` to the type import in `electron/preload.cts`, then expose:

```ts
startMotionPattern: (config: MotionPatternConfig) => ipcRenderer.invoke('motion-demo:start-pattern', config),
updateMotionPattern: (config: MotionPatternConfig) => ipcRenderer.send('motion-demo:update-pattern', config),
onMotionDemoFrame: (listener: (snapshot: MotionDemoSnapshot) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, snapshot: MotionDemoSnapshot) => listener(snapshot);
  ipcRenderer.on('motion-demo:frame', handler);
  return () => ipcRenderer.removeListener('motion-demo:frame', handler);
},
```

Add `MotionDemoSnapshot` and `MotionPatternConfig` to the type import in `src/global.d.ts`, then add matching signatures:

```ts
startMotionPattern: (config: MotionPatternConfig) => Promise<{ streaming: boolean; mode: 'pattern'; intervalMs: number }>;
updateMotionPattern: (config: MotionPatternConfig) => void;
onMotionDemoFrame: (listener: (snapshot: MotionDemoSnapshot) => void) => () => void;
```

- [ ] **Step 5: Run bridge and Electron tests**

```powershell
npm.cmd run test:electron
npm.cmd run lint
```

Expected: PASS with `sandbox preload format: commonjs`; no Node API is exposed to the renderer.

- [ ] **Step 6: Commit the IPC boundary**

```powershell
git add electron/main.ts electron/preload.cts electron/services/demo-motion-stream.ts src/global.d.ts scripts/preload-format-test.mjs
git commit -m "feat(electron): bridge automatic motion controls" -m "Constraint: Validate all renderer pattern input in Electron main." -m "Confidence: high" -m "Scope-risk: moderate"
```

## Task 4: Host Automatic Pattern UI

**Files:**
- Create: `src/ui/components/MotionDemoPanel.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: Add the focused presentation component**

Create `MotionDemoPanel.tsx` with a segmented mode control, native pattern menu, range controls, stable live preview, and icon commands. Use this public interface:

```tsx
import { Play, Square } from 'lucide-react';
import type { MotionDemoMode, MotionPatternConfig } from '../../shared/protocol';

export function MotionDemoPanel(props: {
  mode: MotionDemoMode;
  active: boolean;
  busy: boolean;
  position: number;
  intensity: number;
  livePosition: number;
  pattern: MotionPatternConfig;
  onModeChange(mode: MotionDemoMode): void;
  onPositionChange(value: number): void;
  onIntensityChange(value: number): void;
  onPatternChange(value: MotionPatternConfig): void;
  onToggle(): void;
}) {
  const setPattern = (patch: Partial<MotionPatternConfig>) => props.onPatternChange({ ...props.pattern, ...patch });
  const setPositionMin = (positionMin: number) => props.onPatternChange({
    ...props.pattern,
    positionMin,
    positionMax: Math.max(positionMin, props.pattern.positionMax)
  });
  const setPositionMax = (positionMax: number) => props.onPatternChange({
    ...props.pattern,
    positionMin: Math.min(props.pattern.positionMin, positionMax),
    positionMax
  });
  return (
    <section className="panel motion-demo-panel">
      <div className="panel-header">
        <div><p className="section-label">실시간 제어</p><h2>모션 시연</h2></div>
        <span className={`stream-state ${props.active ? 'active' : ''}`}>{props.active ? '30Hz 전송 중' : '전송 대기'}</span>
      </div>
      <div className="demo-mode-control" role="group" aria-label="시연 모드">
        <button type="button" className={props.mode === 'manual' ? 'active' : ''} disabled={props.active} onClick={() => props.onModeChange('manual')}>수동</button>
        <button type="button" className={props.mode === 'pattern' ? 'active' : ''} disabled={props.active} onClick={() => props.onModeChange('pattern')}>자동 패턴</button>
      </div>
      {props.mode === 'manual' ? (
        <div className="motion-demo-controls">
          <label>
            <span className="control-label"><span>위치</span><strong>{props.position.toFixed(2)}</strong></span>
            <input className="range range-large" type="range" min="0" max="1" step="0.01" value={props.position} onChange={event => props.onPositionChange(Number(event.target.value))} />
          </label>
          <label>
            <span className="control-label"><span>강도</span><strong>{props.intensity.toFixed(2)}</strong></span>
            <input className="range range-large intensity-range" type="range" min="0" max="1" step="0.01" value={props.intensity} onChange={event => props.onIntensityChange(Number(event.target.value))} />
          </label>
        </div>
      ) : (
        <div className="pattern-demo-controls">
          <label><span>패턴</span><select value={props.pattern.pattern} onChange={event => setPattern({ pattern: event.target.value as MotionPatternConfig['pattern'] })}><option value="sine">사인</option><option value="triangle">삼각</option><option value="pulse">펄스</option><option value="sawtooth">톱니</option></select></label>
          <div className="pattern-live-value"><span>현재 자동 위치</span><strong>{props.livePosition.toFixed(2)}</strong></div>
          <div className="pattern-position-preview" aria-label="현재 자동 위치"><span style={{ left: `${props.livePosition * 100}%` }} /></div>
          <label>
            <span className="control-label"><span>주기</span><strong>{(props.pattern.periodMs / 1_000).toFixed(1)}초</strong></span>
            <input data-control="period" className="range" type="range" min="500" max="5000" step="100" value={props.pattern.periodMs} onChange={event => setPattern({ periodMs: Number(event.target.value) })} />
          </label>
          <label>
            <span className="control-label"><span>최소 위치</span><strong>{props.pattern.positionMin.toFixed(2)}</strong></span>
            <input data-control="position-min" className="range" type="range" min="0" max="1" step="0.01" value={props.pattern.positionMin} onChange={event => setPositionMin(Number(event.target.value))} />
          </label>
          <label>
            <span className="control-label"><span>최대 위치</span><strong>{props.pattern.positionMax.toFixed(2)}</strong></span>
            <input data-control="position-max" className="range" type="range" min="0" max="1" step="0.01" value={props.pattern.positionMax} onChange={event => setPositionMax(Number(event.target.value))} />
          </label>
          <label>
            <span className="control-label"><span>강도</span><strong>{props.pattern.intensity.toFixed(2)}</strong></span>
            <input data-control="pattern-intensity" className="range intensity-range" type="range" min="0" max="1" step="0.01" value={props.pattern.intensity} onChange={event => setPattern({ intensity: Number(event.target.value) })} />
          </label>
        </div>
      )}
      <div className="demo-footer">
        <p className="muted">{props.mode === 'manual' ? '슬라이더의 최신 값이 계속 전송됩니다.' : '선택한 패턴을 메인 프로세스에서 일정하게 전송합니다.'}</p>
        <button className={props.active ? 'danger' : 'primary'} disabled={props.busy} onClick={props.onToggle}>{props.active ? <><Square size={14} /> 시연 중지</> : <><Play size={14} /> 시연 시작</>}</button>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Wire state and lifecycle in `App.tsx`**

Add imports:

```ts
import type { AppLogEntry, AppSettings, ApprovalRequest, EntryMode, HardwareProfile, HardwareProtection, MotionDemoMode, MotionMonitorSnapshot, MotionPatternConfig, PortInfo, ViewerSession } from './shared/protocol';
import { MotionDemoPanel } from './ui/components/MotionDemoPanel';
```

Add state:

```ts
const [motionDemoMode, setMotionDemoMode] = useState<MotionDemoMode>('manual');
const [motionPattern, setMotionPattern] = useState<MotionPatternConfig>({
  pattern: 'sine',
  periodMs: 1_500,
  positionMin: 0.2,
  positionMax: 0.8,
  intensity: 0.5
});
const [motionDemoLivePosition, setMotionDemoLivePosition] = useState(0.5);
```

Subscribe once and clean up:

```ts
useEffect(() => window.hapticRelay.onMotionDemoFrame(snapshot => {
  setMotionDemoLivePosition(snapshot.frame.position);
}), []);
```

Split the update effects so inactive and wrong-mode values are never sent:

```ts
useEffect(() => {
  if (motionDemoActive && motionDemoMode === 'manual') window.hapticRelay.updateMotionDemo(intensity, position);
}, [intensity, motionDemoActive, motionDemoMode, position]);

useEffect(() => {
  if (motionDemoActive && motionDemoMode === 'pattern') window.hapticRelay.updateMotionPattern(motionPattern);
}, [motionDemoActive, motionDemoMode, motionPattern]);
```

Replace `toggleMotionDemo()` with:

```ts
async function toggleMotionDemo() {
  await runAction('motion', motionDemoActive ? '시연 중지 중' : '시연 시작 중', async () => {
    if (motionDemoActive) {
      await window.hapticRelay.stopMotionDemo();
      setMotionDemoActive(false);
      setStatusMessage('ok', '실시간 시연 중지됨');
      return;
    }
    if (motionDemoMode === 'pattern') await window.hapticRelay.startMotionPattern(motionPattern);
    else await window.hapticRelay.startMotionDemo(intensity, position);
    setMotionDemoActive(true);
    setStatusMessage('ok', `${motionDemoMode === 'pattern' ? '자동 패턴' : '수동 시연'} 시작됨 / 30Hz 전송 중`);
  });
}
```

Replace the inline panel constant with:

```tsx
const motionDemoPanel = (
  <MotionDemoPanel
    mode={motionDemoMode}
    active={motionDemoActive}
    busy={isBusy}
    position={position}
    intensity={intensity}
    livePosition={motionDemoLivePosition}
    pattern={motionPattern}
    onModeChange={setMotionDemoMode}
    onPositionChange={setPosition}
    onIntensityChange={setIntensity}
    onPatternChange={setMotionPattern}
    onToggle={toggleMotionDemo}
  />
);
```

Retain these existing lifecycle calls unchanged: `leaveRoom()` stops an active demo before `disconnectRoom()`, `room:emergency-stop` calls `demoMotionStream.stop()`, and `window-all-closed` calls `demoMotionStream.stop()`.

- [ ] **Step 3: Add compact responsive styles**

Add styles with stable dimensions:

```css
.demo-mode-control { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: min(320px, 100%); margin-top: 14px; border: 1px solid var(--divider); }
.demo-mode-control button { min-height: 30px; border: 0; background: var(--surface-muted); color: var(--muted); cursor: pointer; }
.demo-mode-control button.active { background: var(--accent-strong); color: white; font-weight: 800; }
.pattern-demo-controls { display: grid; grid-template-columns: minmax(170px, .7fr) minmax(0, 1.3fr); gap: 12px 20px; padding: 16px 0; }
.pattern-demo-controls label { display: grid; gap: 5px; min-width: 0; }
.pattern-position-preview { grid-column: 1 / -1; position: relative; height: 42px; border: 1px solid var(--divider); background: repeating-linear-gradient(90deg, var(--surface), var(--surface) calc(10% - 1px), var(--divider) 10%); }
.pattern-position-preview span { position: absolute; top: 5px; bottom: 5px; width: 4px; background: var(--accent-strong); transform: translateX(-50%); transition: left 32ms linear; }
.pattern-live-value { display: flex; align-items: center; justify-content: space-between; min-width: 0; color: var(--muted); }
.pattern-live-value strong { color: var(--accent-strong); font-size: 20px; }
@media (max-width: 980px) { .pattern-demo-controls { grid-template-columns: 1fr 1fr; gap: 8px 14px; } }
```

Do not add page-level horizontal scrolling, nested cards, decorative gradients, or viewport-scaled typography.

- [ ] **Step 4: Build renderer and inspect TypeScript errors**

```powershell
npm.cmd run build
```

Expected: PASS and `dist/index.html` exists.

- [ ] **Step 5: Commit the UI**

```powershell
git add src/ui/components/MotionDemoPanel.tsx src/App.tsx src/styles.css
git commit -m "feat(ui): add automatic pattern controls" -m "Constraint: Keep the host demo usable at 1180x780 and 960x640 without horizontal scrolling." -m "Confidence: high" -m "Scope-risk: moderate"
```

## Task 5: UI and Two-Client Regression Coverage

**Files:**
- Modify: `scripts/electron-ui-smoke-test.mjs`
- Modify: `scripts/packaged-two-client-test.mjs`

- [ ] **Step 1: Extend the Electron UI smoke flow**

After opening `실시간 시연`, switch mode and assert controls:

```js
await clickButton(cdp, '자동 패턴');
await waitForExpression(cdp, `document.querySelector('[data-control="period"]') && document.querySelector('.pattern-position-preview')`);
await selectOptionByLabel(cdp, '패턴', 'triangle');
await clickButton(cdp, '시연 시작');
await waitForExpression(cdp, `document.querySelector('.stream-state')?.textContent.includes('30Hz 전송 중')`);
const firstPosition = await cdp.evaluate(`Number.parseFloat(getComputedStyle(document.querySelector('.pattern-position-preview span')).left)`);
await delay(500);
const secondPosition = await cdp.evaluate(`Number.parseFloat(getComputedStyle(document.querySelector('.pattern-position-preview span')).left)`);
assert.notEqual(firstPosition, secondPosition, 'automatic preview position changes');
await captureScreenshot(cdp, path.join(outputDirectory, '04-automatic-pattern.png'));
await clickButton(cdp, '시연 중지');
```

Add this helper:

```js
async function selectOptionByLabel(client, labelText, value) {
  const changed = await client.evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find(item => item.textContent.includes(${JSON.stringify(labelText)}));
    const select = label?.querySelector('select');
    if (!(select instanceof HTMLSelectElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, ${JSON.stringify(value)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value === ${JSON.stringify(value)};
  })()`);
  assert.equal(changed, true, `${labelText} select accepts ${value}`);
}
```

Immediately after the automatic-pattern screenshot, verify the minimum viewport:

```js
await cdp.call('Emulation.setDeviceMetricsOverride', { width: 960, height: 640, deviceScaleFactor: 1, mobile: false });
await assertNoDocumentOverflow(cdp, '960x640 automatic pattern');
await captureScreenshot(cdp, path.join(outputDirectory, '05-automatic-pattern-960x640.png'));
await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1180, height: 780, deviceScaleFactor: 1, mobile: false });
```

- [ ] **Step 2: Run UI smoke and confirm screenshots**

```powershell
npm.cmd run test:ui
```

Expected: PASS, with automatic pattern screenshots under `%TEMP%\haptic-relay-ui-smoke` and no overflow assertion failures.

- [ ] **Step 3: Extend the two-client test with changing positions**

Insert the automatic triangle check after the manual receive assertions and before the viewer is closed:

```js
await clickButton(hostCdp, '시연 중지');
await clickButton(hostCdp, '자동 패턴');
await selectOptionByLabel(hostCdp, '패턴', 'triangle');
await clickButton(hostCdp, '시연 시작');

const automaticPositions = new Set();
for (let attempt = 0; attempt < 12; attempt += 1) {
  automaticPositions.add(await viewerCdp.evaluate(`document.querySelectorAll('.motion-gauge')[1]?.querySelector('strong')?.textContent`));
  await delay(120);
}
assert.ok(automaticPositions.size >= 3, `viewer receives changing automatic positions: ${[...automaticPositions]}`);
await clickButton(hostCdp, '시연 중지');
```

Add this helper to `scripts/packaged-two-client-test.mjs`:

```js
async function selectOptionByLabel(client, labelText, value) {
  const changed = await client.evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find(item => item.textContent.includes(${JSON.stringify(labelText)}));
    const select = label?.querySelector('select');
    if (!(select instanceof HTMLSelectElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, ${JSON.stringify(value)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value === ${JSON.stringify(value)};
  })()`);
  assert.equal(changed, true, `${labelText} select accepts ${value}`);
  await delay(80);
}
```

- [ ] **Step 4: Run development two-client verification**

Build an unpacked app and point the existing test at it:

```powershell
npm.cmd run electron:pack
$env:APP_EXECUTABLE = (Resolve-Path 'release\win-unpacked\Haptic Relay.exe').Path
npm.cmd run test:two-client
Remove-Item Env:APP_EXECUTABLE
```

Expected: PASS with `automaticPositions.size >= 3`, clean host/viewer shutdown logs, and screenshots under the test output directory.

- [ ] **Step 5: Visually inspect both viewports**

Open the generated `04-automatic-pattern.png` and the 960x640 automatic pattern screenshot with the local image viewer. Confirm text does not clip, buttons do not resize between states, the preview marker remains inside its track, and no controls overlap.

- [ ] **Step 6: Commit integration coverage**

```powershell
git add scripts/electron-ui-smoke-test.mjs scripts/packaged-two-client-test.mjs
git commit -m "test(demo): cover automatic pattern delivery" -m "Constraint: Verify the feature without physical hardware in both supported desktop viewports." -m "Confidence: high" -m "Scope-risk: narrow"
```

## Task 6: Documentation, Version, Installer, and Release

**Files:**
- Modify: `docs/DESKTOP_DEMO_TEST_GUIDE.md`
- Modify: `docs/WINDOWS_INSTALL_GUIDE.md`
- Modify: `docs/ROADMAP.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Generate: `release/Haptic.Relay-0.1.1-demo.3-win-x64.exe`
- Generate: `release/Haptic.Relay-0.1.1-demo.3-win-x64.exe.sha256`

- [ ] **Step 1: Update user documentation**

In `DESKTOP_DEMO_TEST_GUIDE.md`, replace the single manual-only motion procedure with two explicit checks:

```markdown
### 수동 시연
1. `수동`을 선택하고 `시연 시작`을 누릅니다.
2. 위치와 강도 슬라이더를 움직여 시청자 수신값이 같아지는지 확인합니다.

### 자동 패턴 시연
1. 시연을 중지한 뒤 `자동 패턴`을 선택합니다.
2. 사인, 삼각, 펄스 또는 톱니 패턴을 선택합니다.
3. 주기, 최소·최대 위치와 강도를 설정하고 `시연 시작`을 누릅니다.
4. 스트리머 미리보기와 시청자 위치값이 자동으로 반복 변화하는지 확인합니다.
5. `시연 중지` 후 시청자의 강도가 0으로 내려가는지 확인합니다.
```

Update `WINDOWS_INSTALL_GUIDE.md` to identify `v0.1.1-demo.3` as the current automatic-pattern release, while retaining the warning that the app and relay server are separate. Replace the hard-coded old hash with sidecar verification so every stage release uses its own published checksum:

```powershell
$file = "$HOME\Downloads\Haptic.Relay-0.1.1-demo.3-win-x64.exe"
$checksumFile = "$file.sha256"
$expected = (Get-Content -LiteralPath $checksumFile).Split()[0].ToLowerInvariant()
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw '설치 파일 SHA-256이 일치하지 않습니다.' }
"SHA-256 확인 완료: $actual"
```

Mark only the automatic-pattern roadmap item complete; leave recording/playback and network diagnostics pending.

- [ ] **Step 2: Bump the package version without creating a tag**

```powershell
npm.cmd version 0.1.1-demo.3 --no-git-tag-version
```

Expected: both `package.json` and `package-lock.json` contain `0.1.1-demo.3`.

- [ ] **Step 3: Run the complete pre-release suite**

```powershell
npm.cmd run test:motion
npm.cmd run test:smoke
npm.cmd run test:electron
npm.cmd run test:ui
npm.cmd run test:security
npm.cmd run build
```

Expected: every command exits 0. No `.env` file is staged or created by these commands.

- [ ] **Step 4: Build and validate the NSIS installer**

```powershell
npm.cmd run electron:build
npm.cmd run release:check
Copy-Item -LiteralPath 'release\Haptic Relay-0.1.1-demo.3-win-x64.exe' -Destination 'release\Haptic.Relay-0.1.1-demo.3-win-x64.exe' -Force
$asset = Resolve-Path 'release\Haptic.Relay-0.1.1-demo.3-win-x64.exe'
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $asset).Hash.ToLowerInvariant()
Set-Content -LiteralPath 'release\Haptic.Relay-0.1.1-demo.3-win-x64.exe.sha256' -Value "$hash  Haptic.Relay-0.1.1-demo.3-win-x64.exe" -NoNewline
```

Expected: `release:check` reports `All release checks passed.` and both dotted-name release assets exist.

- [ ] **Step 5: Test the installed executable**

```powershell
Start-Process -FilePath (Resolve-Path 'release\Haptic.Relay-0.1.1-demo.3-win-x64.exe') -ArgumentList '/S' -Wait
$env:APP_EXECUTABLE = "$env:LOCALAPPDATA\Programs\Haptic Relay\Haptic Relay.exe"
npm.cmd run test:two-client
Remove-Item Env:APP_EXECUTABLE
```

Expected: the installed app reports version `0.1.1-demo.3`, the automatic triangle pattern produces at least three distinct viewer positions, and both clients close without `Object has been destroyed`.

- [ ] **Step 6: Commit release metadata and documentation**

```powershell
git add package.json package-lock.json docs/DESKTOP_DEMO_TEST_GUIDE.md docs/WINDOWS_INSTALL_GUIDE.md docs/ROADMAP.md
git commit -m "chore(release): prepare automatic pattern demo" -m "Constraint: Publish a separately testable installer for stage 1." -m "Confidence: high" -m "Scope-risk: narrow" -m "Not-tested: Physical OSR/T-Code hardware remains outside this release."
```

- [ ] **Step 7: Verify the final diff and publish**

```powershell
git status --short
git log --oneline v0.1.1-demo.2..HEAD
git push origin feature/viewer-motion-delay-pr
git tag -a v0.1.1-demo.3 -m 'Haptic Relay v0.1.1 Demo 3'
git push origin v0.1.1-demo.3
gh release create v0.1.1-demo.3 'release/Haptic.Relay-0.1.1-demo.3-win-x64.exe' 'release/Haptic.Relay-0.1.1-demo.3-win-x64.exe.sha256' --title 'Haptic Relay v0.1.1 Demo 3' --notes 'Adds safe 30Hz automatic sine, triangle, pulse, and sawtooth motion patterns with live range, speed, intensity, and hardware-free two-client verification.'
```

Expected: working tree is clean before tagging, branch and tag pushes succeed, and GitHub Release lists the EXE and SHA-256 assets.

## Final Verification Checklist

- [ ] `npm.cmd run test:electron` proves deterministic pattern shape, validation, one timer, live updates, ramp, and safe stop.
- [ ] `npm.cmd run test:ui` proves mode controls and both supported viewports render without overflow.
- [ ] Installed two-client test proves changing automatic values traverse the real binary relay path without hardware.
- [ ] Manual slider mode, room leave, emergency stop, and window close behavior remain operational.
- [ ] Package and installed versions are `0.1.1-demo.3`.
- [ ] Installer and SHA-256 are attached to GitHub Release `v0.1.1-demo.3`.
- [ ] No `.env`, generated `dist*`, unpacked app, or unrelated files are committed.
