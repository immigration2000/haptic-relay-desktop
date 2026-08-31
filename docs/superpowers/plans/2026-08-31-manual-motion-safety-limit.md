# Manual Motion Safety Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted 50-400%/s Hardware Settings slider that safely changes the manual live-demo slew limit without changing 30 Hz delivery or any automatic/received motion path.

**Architecture:** App settings schema v4 gains a dedicated `motionSafety` object. A small Electron validator owns the normalized `0.5..4.0` domain, `DemoMotionStream` uses a mutable validated instance value, and a narrow renderer-to-main IPC message applies slider changes without publishing frames. The renderer converts the normalized value to percent-per-second for the existing hardware stroke card and saves it through the existing settings workflow.

**Tech Stack:** TypeScript, React, Electron IPC/contextBridge, Node.js assertion tests, Vite, electron-builder

---

## File Structure

- Create `electron/services/manual-motion-safety.ts`: Electron-side constants and authoritative validation for persisted/runtime speed values.
- Modify `electron/protocol.ts`: add `MotionSafetySettings` and settings schema v4.
- Modify `src/shared/protocol.ts`: mirror the renderer contract.
- Modify `electron/app-settings.ts`: default, validate, and migrate the new root settings object.
- Modify `src/App.tsx`: keep renderer defaults, loaded state, and saved state schema-compatible with v4.
- Modify `scripts/app-settings-test.mjs`: prove schema migration and validation.
- Modify `electron/services/demo-motion-stream.ts`: replace the fixed module-level step with a validated mutable instance speed.
- Modify `scripts/demo-motion-stream-test.mjs`: prove live limit changes and safety invariants.
- Modify `electron/main.ts`: receive trusted runtime limit updates.
- Modify `electron/preload.cts`: expose only the new narrow setter.
- Modify `src/global.d.ts`: type the preload method.
- Modify `scripts/preload-format-test.mjs`: verify sender validation, IPC exposure, renderer application, and UI wiring.
- Modify `src/App.tsx`: apply live slider changes through the trusted IPC method.
- Modify `src/ui/components/HardwareStrokeControl.tsx`: render the slider above intensity.
- Modify `src/ui/hardware-settings-values.ts`: convert and format the safety speed for display.
- Modify `scripts/hardware-settings-values-test.mjs`: test conversions and traversal estimate formatting.
- Modify `src/styles.css`: style the new row using the current hardware control language.
- Modify `scripts/electron-ui-smoke-test.mjs`: assert the packaged-width UI renders the control without overflow.

### Task 1: Settings Contract and Migration

**Files:**
- Create: `electron/services/manual-motion-safety.ts`
- Modify: `electron/protocol.ts`
- Modify: `src/shared/protocol.ts`
- Modify: `electron/app-settings.ts`
- Modify: `src/App.tsx`
- Test: `scripts/app-settings-test.mjs`
- Test: `scripts/preload-format-test.mjs`

- [ ] **Step 1: Write failing schema and validation tests**

Extend the protocol source assertions and fixtures in `scripts/app-settings-test.mjs`:

```js
for (const protocolSource of protocolSources) {
  assert.match(
    protocolSource,
    /export type MotionSafetySettings = \{[\s\S]*?manualMaxPositionSpeed:\s*number;[\s\S]*?\};/,
    'MotionSafetySettings must require the manual slew speed'
  );
  assert.match(
    protocolSource,
    /export type AppSettings = \{[\s\S]*?schemaVersion:\s*4;[\s\S]*?motionSafety:\s*MotionSafetySettings;[\s\S]*?\};/,
    'AppSettings must use schema version 4 and require motionSafety'
  );
}

assert.deepEqual(settingsModule.DEFAULT_SETTINGS.motionSafety, {
  manualMaxPositionSpeed: 2
});

// Add after the existing migratedV2, migratedV1, and migratedLegacy fixtures.
const migratedV3 = settingsModule.migrateAppSettings({
  schemaVersion: 3,
  hardwareProfile,
  hardwareProtection,
  playback: { motionDelayMs: 700 }
});
assert.equal(migratedV3.schemaVersion, 4);
assert.deepEqual(migratedV3.motionSafety, { manualMaxPositionSpeed: 2 });

for (const migrated of [migratedV3, migratedV2, migratedV1, migratedLegacy]) {
  assert.equal(migrated.schemaVersion, 4);
  assert.deepEqual(migrated.motionSafety, { manualMaxPositionSpeed: 2 });
}

for (const manualMaxPositionSpeed of [0.5, 0.75, 2, 4]) {
  assert.deepEqual(
    settingsModule.validateMotionSafetySettings({ manualMaxPositionSpeed }),
    { manualMaxPositionSpeed }
  );
}

for (const manualMaxPositionSpeed of [0.49, 4.01, 0.6, Number.NaN, Number.POSITIVE_INFINITY, '2']) {
  assert.throws(
    () => settingsModule.validateMotionSafetySettings({ manualMaxPositionSpeed }),
    /invalid-manual-motion-speed/
  );
}
```

Update all existing valid schema-v3 fixtures to schema v4 with `motionSafety`, while retaining explicit schema-v3 fixtures for migration coverage.

Update the existing `scripts/preload-format-test.mjs` schema assertion from 3 to 4 and assert that `loadSettings()` stores `settings.motionSafety`, `saveSettings()` includes `motionSafety`, and successful saves store `result.settings.motionSafety`.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npm run build:electron
node scripts/app-settings-test.mjs
```

Expected: FAIL because `MotionSafetySettings`, schema v4, and `validateMotionSafetySettings` do not exist.

- [ ] **Step 3: Add the focused validator**

Create `electron/services/manual-motion-safety.ts`:

```ts
export const DEFAULT_MANUAL_MAX_POSITION_SPEED = 2;
export const MIN_MANUAL_MAX_POSITION_SPEED = 0.5;
export const MAX_MANUAL_MAX_POSITION_SPEED = 4;
export const MANUAL_MAX_POSITION_SPEED_STEP = 0.25;

export function validateManualMaxPositionSpeed(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('invalid-manual-motion-speed');
  }
  if (value < MIN_MANUAL_MAX_POSITION_SPEED || value > MAX_MANUAL_MAX_POSITION_SPEED) {
    throw new Error('invalid-manual-motion-speed');
  }
  const steps = value / MANUAL_MAX_POSITION_SPEED_STEP;
  if (Math.abs(steps - Math.round(steps)) > Number.EPSILON * 16) {
    throw new Error('invalid-manual-motion-speed');
  }
  return value;
}
```

- [ ] **Step 4: Add schema v4 types, defaults, validation, and migration**

Add this type to both protocol files and update `AppSettings`:

```ts
export type MotionSafetySettings = {
  manualMaxPositionSpeed: number;
};

export type AppSettings = {
  schemaVersion: 4;
  hardwareProfile: HardwareProfile;
  hardwareProtection: HardwareProtection;
  playback: PlaybackSettings;
  motionSafety: MotionSafetySettings;
};
```

In `electron/app-settings.ts`, import `MotionSafetySettings` with the existing protocol types, import the validator/default, set `CURRENT_SETTINGS_SCHEMA_VERSION = 4`, add the default object, and validate it:

```ts
import {
  DEFAULT_MANUAL_MAX_POSITION_SPEED,
  validateManualMaxPositionSpeed
} from './services/manual-motion-safety.js';

motionSafety: {
  manualMaxPositionSpeed: DEFAULT_MANUAL_MAX_POSITION_SPEED
}

export function validateMotionSafetySettings(value: unknown): MotionSafetySettings {
  if (!isRecord(value)) throw new Error('invalid-motion-safety-settings');
  return {
    manualMaxPositionSpeed: validateManualMaxPositionSpeed(value.manualMaxPositionSpeed)
  };
}
```

Return `motionSafety: validateMotionSafetySettings(value.motionSafety)` from `validateAppSettings`. Add a schema-v3 migration branch that preserves v3 profile/protection/playback values and adds the default. Make every v1/v2 migration target schema v4 and add the same default. Do not treat a malformed v4 object as legacy.

In `src/App.tsx`, import `MotionSafetySettings`, set `CURRENT_SETTINGS_SCHEMA_VERSION` to 4, then add the default and state:

```ts
const DEFAULT_MOTION_SAFETY: MotionSafetySettings = {
  manualMaxPositionSpeed: 2
};

const [motionSafety, setMotionSafety] = useState<MotionSafetySettings>(DEFAULT_MOTION_SAFETY);
```

Have `loadSettings()` call `setMotionSafety(settings.motionSafety)`. Include `motionSafety` in the settings object passed by `saveSettings()` and call `setMotionSafety(result.settings.motionSafety)` after a successful save. Do not add runtime IPC in this task.

- [ ] **Step 5: Run focused settings tests**

Run:

```powershell
npm run build:electron
node scripts/app-settings-test.mjs
node scripts/settings-file-store-test.mjs
node scripts/preload-format-test.mjs
```

Expected: all commands exit 0 and report their pass messages.

- [ ] **Step 6: Commit the settings unit**

```powershell
git add electron/services/manual-motion-safety.ts electron/protocol.ts src/shared/protocol.ts electron/app-settings.ts src/App.tsx scripts/app-settings-test.mjs scripts/preload-format-test.mjs
git commit -m "feat(settings): persist manual motion safety speed" -m "Constraint: Migrate schema v1-v3 to the current 200%/s behavior." -m "Confidence: high" -m "Scope-risk: moderate"
```

### Task 2: Configurable Manual Stream Limit

**Files:**
- Modify: `electron/services/demo-motion-stream.ts`
- Test: `scripts/demo-motion-stream-test.mjs`

- [ ] **Step 1: Write failing runtime behavior tests**

Import the constants and validator result, then replace the test-local hard-coded `2` with the stream's configured speed. Add this focused case:

```js
const configurable = createHarness();
configurable.stream.start({ intensity: 0.5, position: 1 });
const publishedBeforeLimitChange = configurable.published.length;
const intervalsBeforeLimitChange = configurable.intervals.length;

assert.equal(configurable.stream.setManualMaxPositionSpeed(4), 4);
assert.equal(configurable.published.length, publishedBeforeLimitChange, 'changing speed publishes no frame');
assert.equal(configurable.intervals.length, intervalsBeforeLimitChange, 'changing speed does not restart the timer');

configurable.setTime(1_033, DEMO_MOTION_INTERVAL_MS);
configurable.intervals[0].callback();
assert.equal(
  configurable.published.at(-1).position,
  0.5 + 4 * DEMO_MOTION_INTERVAL_MS / 1000,
  'the next tick uses the new 400%/s limit'
);

assert.equal(configurable.stream.setManualMaxPositionSpeed(0.5), 0.5);
configurable.stream.update({ intensity: 0.5, position: 0 });
configurable.setTime(1_066, DEMO_MOTION_INTERVAL_MS * 2);
configurable.intervals[0].callback();
assert.equal(
  configurable.published.at(-1).position,
  0.5 + 4 * DEMO_MOTION_INTERVAL_MS / 1000 - 0.5 * DEMO_MOTION_INTERVAL_MS / 1000,
  'the next tick uses the new 50%/s limit'
);

for (const invalid of [0, 0.6, 4.25, Number.NaN]) {
  assert.throws(() => configurable.stream.setManualMaxPositionSpeed(invalid), /invalid-manual-motion-speed/);
}
```

Also run the existing rapid-reversal delta assertion for `0.5`, `2`, and `4` so every adjacent delta is bounded by `speed * DEMO_MOTION_INTERVAL_MS / 1000 + Number.EPSILON`.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npm run build:electron
node scripts/demo-motion-stream-test.mjs
```

Expected: FAIL because `setManualMaxPositionSpeed` is missing.

- [ ] **Step 3: Replace the fixed step with instance state**

In `electron/services/demo-motion-stream.ts`, import the default and validator, remove `MANUAL_MAX_POSITION_SPEED_PER_SECOND` and `MANUAL_MAX_POSITION_STEP`, then add:

```ts
private manualMaxPositionSpeed = DEFAULT_MANUAL_MAX_POSITION_SPEED;

setManualMaxPositionSpeed(value: unknown): number {
  this.manualMaxPositionSpeed = validateManualMaxPositionSpeed(value);
  return this.manualMaxPositionSpeed;
}
```

Calculate the step inside `publishManual()`:

```ts
const maximumStep = this.manualMaxPositionSpeed * DEMO_MOTION_INTERVAL_MS / 1000;
const delta = this.manualTarget.position - this.latest.position;
const position = Math.abs(delta) <= maximumStep
  ? this.manualTarget.position
  : this.latest.position + Math.sign(delta) * maximumStep;
```

Do not change the interval, latest-target assignment, pattern path, stop frame, or transition behavior.

- [ ] **Step 4: Run the stream regression tests**

Run:

```powershell
npm run build:electron
node scripts/demo-motion-stream-test.mjs
node scripts/demo-motion-pattern-test.mjs
```

Expected: all tests pass; every stream frame still reports `DEMO_MOTION_INTERVAL_MS`.

- [ ] **Step 5: Commit the stream unit**

```powershell
git add electron/services/demo-motion-stream.ts scripts/demo-motion-stream-test.mjs
git commit -m "feat(motion): make manual slew limit configurable" -m "Constraint: Keep 30Hz latest-value delivery and bounded adjacent positions." -m "Rejected: Increasing the fixed limit | users need an explicit safety control." -m "Confidence: high" -m "Scope-risk: moderate"
```

### Task 3: Trusted Runtime IPC

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/preload.cts`
- Modify: `src/global.d.ts`
- Test: `scripts/preload-format-test.mjs`

- [ ] **Step 1: Write failing IPC contract tests**

Add source assertions to `scripts/preload-format-test.mjs`:

First extend the existing `Promise.all` source list with `readFile(new URL('../src/global.d.ts', import.meta.url), 'utf8')` and bind that final result as `globalSource`. Then add:

```js
assert.match(
  preloadSource,
  /setManualMotionSafety:\s*\(manualMaxPositionSpeed\).*?ipcRenderer\.send\(['"]motion-demo:set-safety-limit['"], manualMaxPositionSpeed\)/
);
assert.match(
  globalSource,
  /setManualMotionSafety:\s*\(manualMaxPositionSpeed:\s*number\)\s*=>\s*void/
);
assert.match(
  mainSource,
  /ipcMain\.on\(['"]motion-demo:set-safety-limit['"][\s\S]*?try \{[\s\S]*?assertTrustedSender\(event\)[\s\S]*?demoMotionStream\.setManualMaxPositionSpeed\(manualMaxPositionSpeed\)[\s\S]*?catch \(error\)[\s\S]*?motion-safety-limit-rejected/
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npm run build:electron
node scripts/preload-format-test.mjs
```

Expected: FAIL because the IPC method and handler are absent.

- [ ] **Step 3: Expose the narrow preload method**

Add to `electron/preload.cts`:

```ts
setManualMotionSafety: (manualMaxPositionSpeed: number) =>
  ipcRenderer.send('motion-demo:set-safety-limit', manualMaxPositionSpeed),
```

Add to `src/global.d.ts`:

```ts
setManualMotionSafety: (manualMaxPositionSpeed: number) => void;
```

Do not expose a generic settings channel or an Electron object.

- [ ] **Step 4: Validate and apply in the main process**

Add beside the other motion-demo IPC handlers in `electron/main.ts`:

```ts
ipcMain.on('motion-demo:set-safety-limit', (event, manualMaxPositionSpeed: unknown) => {
  try {
    assertTrustedSender(event);
    demoMotionStream.setManualMaxPositionSpeed(manualMaxPositionSpeed);
  } catch (error) {
    addLog({
      level: 'warning',
      source: 'protection',
      message: 'motion-safety-limit-rejected',
      details: formatError(error)
    });
  }
});
```

The setter performs authoritative validation. The handler must not start, stop, or publish the demo stream.

- [ ] **Step 5: Run IPC and stream tests**

Run:

```powershell
npm run build:electron
node scripts/preload-format-test.mjs
node scripts/demo-motion-stream-test.mjs
```

Expected: both tests pass.

- [ ] **Step 6: Commit the IPC unit**

```powershell
git add electron/main.ts electron/preload.cts src/global.d.ts scripts/preload-format-test.mjs
git commit -m "feat(motion): apply safety speed through trusted IPC" -m "Constraint: A limit update must not emit or restart motion." -m "Confidence: high" -m "Scope-risk: narrow"
```

### Task 4: Hardware Settings Slider and Persistence

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/ui/components/HardwareStrokeControl.tsx`
- Modify: `src/ui/hardware-settings-values.ts`
- Modify: `src/styles.css`
- Test: `scripts/hardware-settings-values-test.mjs`
- Test: `scripts/preload-format-test.mjs`
- Test: `scripts/electron-ui-smoke-test.mjs`

- [ ] **Step 1: Write failing value-helper tests**

In `scripts/hardware-settings-values-test.mjs`, import the new exports and add:

```js
assert.equal(normalizedSpeedToPercent(0.5), 50);
assert.equal(normalizedSpeedToPercent(2), 200);
assert.equal(normalizedSpeedToPercent(4), 400);
assert.equal(percentSpeedToNormalized(50), 0.5);
assert.equal(percentSpeedToNormalized(225), 2.25);
assert.equal(percentSpeedToNormalized(400), 4);
assert.equal(formatTraversalSeconds(0.5), '2.00');
assert.equal(formatTraversalSeconds(2), '0.50');
assert.equal(formatTraversalSeconds(4), '0.25');
```

Extend the renderer source assertions in `scripts/preload-format-test.mjs`:

```js
assert.match(loadSettingsSource, /setManualMotionSafety\(settings\.motionSafety\.manualMaxPositionSpeed\)/);
assert.match(hardwareStrokeControlSource, /안전 모드 속도 제한/);
assert.match(hardwareStrokeControlSource, /id="hardware-manual-speed-limit"[\s\S]*?min="50"[\s\S]*?max="400"[\s\S]*?step="25"/);
assert.ok(
  hardwareStrokeControlSource.indexOf('안전 모드 속도 제한') < hardwareStrokeControlSource.indexOf('강도 상한'),
  'safety speed control appears above intensity limit'
);
```

Update `scripts/electron-ui-smoke-test.mjs` to require `#hardware-manual-speed-limit`, confirm its value is `200`, and include it in the existing overflow/accessibility capture at desktop and 720px content widths.

- [ ] **Step 2: Run the UI tests to verify they fail**

Run:

```powershell
npm run build
node scripts/hardware-settings-values-test.mjs
node scripts/preload-format-test.mjs
node scripts/electron-ui-smoke-test.mjs
```

Expected: helper/import and slider assertions fail before implementation.

- [ ] **Step 3: Add renderer conversion helpers**

Append to `src/ui/hardware-settings-values.ts`:

```ts
export function normalizedSpeedToPercent(value: number): number {
  return Math.round(value * 100);
}

export function percentSpeedToNormalized(value: number): number {
  return value / 100;
}

export function formatTraversalSeconds(manualMaxPositionSpeed: number): string {
  return (1 / manualMaxPositionSpeed).toFixed(2);
}
```

The slider itself constrains the input; persisted/runtime validation remains authoritative.

- [ ] **Step 4: Wire live runtime application**

The v4 state/load/save wiring already exists from Task 1. In `src/App.tsx`, add:

```ts
function updateMotionSafety(manualMaxPositionSpeed: number) {
  const next = { manualMaxPositionSpeed };
  setMotionSafety(next);
  window.hapticRelay.setManualMotionSafety(manualMaxPositionSpeed);
}
```

In `loadSettings()`, after the request-id freshness check, apply the value to the main-process stream immediately after storing renderer state:

```ts
window.hapticRelay.setManualMotionSafety(settings.motionSafety.manualMaxPositionSpeed);
```

Pass `motionSafety` and `onMotionSafetyChange={updateMotionSafety}` to `HardwareStrokeControl`.

- [ ] **Step 5: Render the accessible slider above intensity**

Extend `HardwareStrokeControlProps` with:

```ts
motionSafety: MotionSafetySettings;
onMotionSafetyChange: (manualMaxPositionSpeed: number) => void;
```

Import the new helpers, calculate:

```ts
const manualSpeedPercent = normalizedSpeedToPercent(motionSafety.manualMaxPositionSpeed);
const traversalSeconds = formatTraversalSeconds(motionSafety.manualMaxPositionSpeed);
```

Insert above `.intensity-control-grid`:

```tsx
<div className="safety-speed-control-grid">
  <label htmlFor="hardware-manual-speed-limit">
    <span>안전 모드 속도 제한</span>
    <input
      id="hardware-manual-speed-limit"
      type="range"
      min="50"
      max="400"
      step="25"
      value={manualSpeedPercent}
      disabled={busy}
      onChange={event => onMotionSafetyChange(percentSpeedToNormalized(Number(event.target.value)))}
    />
  </label>
  <output htmlFor="hardware-manual-speed-limit">
    {manualSpeedPercent}%/초 · 끝→끝 약 {traversalSeconds}초
  </output>
</div>
```

Style `.safety-speed-control-grid` with the same grid columns, spacing, range width, and responsive collapse used by `.intensity-control-grid`. Do not change the stroke rail, range, stop, or intensity control behavior.

- [ ] **Step 6: Run focused renderer and UI tests**

Run:

```powershell
npm run build
node scripts/hardware-settings-values-test.mjs
node scripts/preload-format-test.mjs
node scripts/electron-ui-smoke-test.mjs
```

Expected: all tests pass; screenshots show the slider above intensity without clipping at both tested widths.

- [ ] **Step 7: Commit the UI unit**

```powershell
git add src/App.tsx src/ui/components/HardwareStrokeControl.tsx src/ui/hardware-settings-values.ts src/styles.css scripts/hardware-settings-values-test.mjs scripts/preload-format-test.mjs scripts/electron-ui-smoke-test.mjs
git commit -m "feat(ui): add manual motion safety slider" -m "Constraint: Keep the current 200%/s default and expose only 50-400%/s." -m "Confidence: high" -m "Scope-risk: moderate"
```

### Task 5: Full Verification, Packaging, and Bounded Hardware Acceptance

**Files:**
- Verify only; no production changes expected.

- [ ] **Step 1: Run all automated gates from a clean worktree**

Run:

```powershell
npm run lint
npm run test:motion
npm run test:electron
npm run test:smoke
npm run test:security
npm run test:ui
npm run build
git diff --check
git status --short
```

Expected: every command exits 0, smoke reports all checks passed, `git diff --check` prints nothing, and the worktree has no uncommitted files.

- [ ] **Step 2: Build the unpacked Windows application**

Run:

```powershell
npm run electron:pack
```

Expected: exit 0 and `release/win-unpacked/Haptic Relay.exe` exists with a fresh modification time.

- [ ] **Step 3: Verify no-hardware settings behavior**

Launch the packaged executable with an isolated temporary `userData` directory. Confirm:

1. Hardware Settings displays `200%/초 · 끝→끝 약 0.50초`.
2. The slider permits 50, 200, and 400 but no off-step value.
3. Saving at 300, closing, and reopening restores `300%/초`.
4. A migrated schema-v3 settings fixture opens at 200 and is rewritten as schema v4 only by the existing migration path.
5. Manual/automatic controls and the complete output-log window still open without renderer console errors.

- [ ] **Step 4: Run restricted-range physical acceptance**

With the mechanism unloaded and its power control immediately reachable:

1. Set stroke range to `48%..52%`, stop position `50%`, and speed `200%/초`.
2. Connect the known COM port and confirm the T-Code diagnostic succeeds.
3. Start manual live demo and make one rapid right-to-left slider move.
4. Confirm motion is bounded, the serial diagnostic remains successful, and the connection remains active.
5. Change only the speed to `400%/초`; repeat one right-to-left move.
6. Confirm the output rows remain approximately 30 Hz and adjacent logical positions respect the configured `4.0/s` bound.
7. Disconnect and reconnect once; confirm the selected speed is still present and the new output-log session begins correctly.

Stop immediately on abrupt motion, serial errors, or a COM state change. Do not continue to the normal range after any restricted-range failure.

- [ ] **Step 5: Run one normal-range confirmation**

Only after Step 4 succeeds:

1. Restore the default `30%..80%` range and stop position `50%`.
2. Keep `400%/초` and make one rapid right-to-left manual move.
3. Confirm the response is visibly faster than 200%/s and the device remains connected.
4. Restore the user's preferred speed after the test and save it.

- [ ] **Step 6: Confirm verification did not mutate the worktree**

Run:

```powershell
git status --short
```

Expected: no output. If a test produced untracked screenshots or temporary data inside the worktree, stop and inspect the exact paths before any cleanup; do not commit generated acceptance artifacts.

### Task 6: Final Review and Handoff

**Files:**
- Review all commits from `71db5cf` through the feature tip.

- [ ] **Step 1: Request final code review**

Use `superpowers:requesting-code-review` against the pre-feature base `71db5cf`. Require findings to distinguish critical safety defects from optional cleanup. Resolve every confirmed Critical or Important issue with a failing regression test first.

- [ ] **Step 2: Re-run affected and full gates after any review fix**

Run the focused test for each fix, then repeat:

```powershell
npm run lint
npm run test:motion
npm run test:electron
npm run test:smoke
npm run test:security
npm run test:ui
npm run build
git diff --check
git status --short
```

Expected: all commands exit 0 and the worktree is clean.

- [ ] **Step 3: Prepare branch completion choices**

Invoke `superpowers:finishing-a-development-branch`. Report the exact commits, automated results, package path, and physical acceptance result. Do not push, merge, tag, publish, or create a release without the user's explicit selection.
