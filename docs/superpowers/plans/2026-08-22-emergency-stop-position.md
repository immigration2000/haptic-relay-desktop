# Configurable Emergency Stop Position Implementation Plan

> **Historical record — partially superseded:** The absolute emergency position remains current, but hardware disconnect no longer writes it. See [2026-08-23-room-motion-emergency-latch-design.md](../specs/2026-08-23-room-motion-emergency-latch-design.md) for the current lifecycle authority.

> **ARCHIVED — DO NOT EXECUTE.** Preserve the tasks below only as historical implementation evidence. Use [2026-08-23-room-motion-emergency-latch-design.md](../specs/2026-08-23-room-motion-emergency-latch-design.md) for current behavior and planning authority.

> **Archived plan:** The former agent execution directive is intentionally disabled. Do not run or resume the tasks below.

**Goal:** Persist and apply one absolute, stroke-bounded stop position to both emergency stop and safe hardware disconnect.

**Architecture:** Extend `HardwareProfile` and migrate application settings to schema version 3, keeping legacy behavior by deriving the new field from the prior `strokeMin`. `HardwareController.emergencyStop()` remains the single stop-payload owner, while the renderer adds a connection-time profile input and clamps it when stroke bounds change.

**Tech Stack:** TypeScript, Electron IPC validation, React 19, Node.js assertion scripts, SerialPort-compatible fake tests, Markdown shared operational documentation.

---

## File Map

- Modify `electron/protocol.ts`: require `HardwareProfile.stopPosition` and settings schema version 3.
- Modify `src/shared/protocol.ts`: mirror the renderer-facing profile and settings contracts.
- Modify `electron/app-settings.ts`: defaults, v1/v2/legacy migration, and authoritative stop-position validation.
- Modify `scripts/app-settings-test.mjs`: schema, migration, round-trip, and invalid-value regressions.
- Modify `electron/services/hardware-controller.ts`: normalize the active target and pass it to the existing stop encoder.
- Modify `scripts/hardware-output-test.mjs`: prove emergency stop and safe disconnect use the configured absolute target.
- Modify `scripts/tcode-encoder-test.mjs`: retain an explicit encoder example for a nonzero target and zero vibration.
- Modify `src/App.tsx`: schema constant, default profile, range-aware input, and clamp behavior.
- Modify `scripts/preload-format-test.mjs`: assert the renderer profile contract and safety-critical disabled state.
- Modify `C:\Users\user\AI_NOTES\TCODE_GUIDE.md`: record the reusable T-Code stop-position rules.
- Modify `C:\Users\user\AI_NOTES\logs\laptop.md`: record verified Desktop behavior and remaining physical validation.

No new runtime package, IPC channel, stop-speed setting, or automatic reconnect behavior is introduced.

### Task 1: Settings Schema Version 3 and Migration

**Files:**

- Modify: `electron/protocol.ts:62-118`
- Modify: `src/shared/protocol.ts:62-118`
- Modify: `electron/app-settings.ts:4-76`
- Modify: `electron/services/hardware-controller.ts:26-33`
- Modify: `src/App.tsx:38-55`
- Test: `scripts/app-settings-test.mjs:1-102`

- [ ] **Step 1: Write failing schema and migration regressions**

Replace the profile setup in `scripts/app-settings-test.mjs` with explicit legacy and version-3 values:

```js
const legacyHardwareProfile = {
  baudRate: 115200,
  linearAxis: 'L0',
  vibrationAxis: 'V0',
  strokeMin: 0.1,
  strokeMax: 0.9,
  invertPosition: true
};
const hardwareProfile = {
  ...legacyHardwareProfile,
  stopPosition: 0.3
};
```

Change the protocol assertions to require both the new field and schema version:

```js
assert.match(
  protocolSource,
  /export type HardwareProfile = \{[\s\S]*?stopPosition:\s*number;[\s\S]*?\};/,
  'HardwareProfile must require an absolute stopPosition'
);
assert.match(
  protocolSource,
  /export type AppSettings = \{[\s\S]*?schemaVersion:\s*3;[\s\S]*?playback:\s*PlaybackSettings;[\s\S]*?\};/,
  'AppSettings must use schema version 3 and require playback settings'
);
```

Add a version-2 migration case that preserves playback while deriving the prior stop target:

```js
const migratedV2 = settingsModule.migrateAppSettings({
  schemaVersion: 2,
  hardwareProfile: legacyHardwareProfile,
  hardwareProtection,
  playback: { motionDelayMs: 700 }
});
assert.equal(migratedV2.schemaVersion, 3);
assert.equal(migratedV2.playback.motionDelayMs, 700);
assert.deepEqual(migratedV2.hardwareProfile, {
  ...legacyHardwareProfile,
  stopPosition: legacyHardwareProfile.strokeMin
});
```

Replace the version-1 and unversioned migration cases with:

```js
const migratedV1 = settingsModule.migrateAppSettings({
  schemaVersion: 1,
  hardwareProfile: legacyHardwareProfile,
  hardwareProtection
});
assert.equal(migratedV1.schemaVersion, 3);
assert.equal(migratedV1.playback.motionDelayMs, 0);
assert.deepEqual(migratedV1.hardwareProfile, {
  ...legacyHardwareProfile,
  stopPosition: legacyHardwareProfile.strokeMin
});
assert.deepEqual(migratedV1.hardwareProtection, hardwareProtection);

const migratedLegacy = settingsModule.migrateAppSettings({
  hardwareProfile: legacyHardwareProfile,
  hardwareProtection
});
assert.equal(migratedLegacy.schemaVersion, 3);
assert.equal(migratedLegacy.playback.motionDelayMs, 0);
assert.deepEqual(migratedLegacy.hardwareProfile, {
  ...legacyHardwareProfile,
  stopPosition: legacyHardwareProfile.strokeMin
});
assert.deepEqual(migratedLegacy.hardwareProtection, hardwareProtection);
```

Validate version-3 settings with `hardwareProfile`, and add invalid position cases:

```js
for (const stopPosition of [-0.1, 1.1, Number.NaN]) {
  assert.throws(
    () => settingsModule.validateHardwareProfile({ ...hardwareProfile, stopPosition }),
    /invalid-stop-position/
  );
}

for (const stopPosition of [0.05, 0.95]) {
  assert.throws(
    () => settingsModule.validateHardwareProfile({ ...hardwareProfile, stopPosition }),
    /invalid-stop-position/
  );
}
```

The strict validator must now reject `[1, 2, 4, '3', undefined]`; migration must reject `[0, 4, '3']`; motion-delay cases must pass `schemaVersion: 3`. Change the final message to `app settings v3 tests passed`.

- [ ] **Step 2: Run the settings test to verify RED**

Run:

```powershell
npm.cmd run build:electron
node scripts/app-settings-test.mjs
```

Expected: assertion failure because the protocol still declares schema 2 and has no required `stopPosition`.

- [ ] **Step 3: Extend both shared type contracts**

Add the field after `strokeMax` in both protocol files:

```ts
export type HardwareProfile = {
  baudRate: number;
  linearAxis: string;
  vibrationAxis?: string;
  strokeMin: number;
  strokeMax: number;
  stopPosition: number;
  invertPosition: boolean;
};
```

Change both `AppSettings` types to:

```ts
export type AppSettings = {
  schemaVersion: 3;
  hardwareProfile: HardwareProfile;
  hardwareProtection: HardwareProtection;
  playback: PlaybackSettings;
};
```

- [ ] **Step 4: Add defaults and authoritative validation**

In `electron/app-settings.ts`, change the constant and default profile:

```ts
export const CURRENT_SETTINGS_SCHEMA_VERSION = 3;

hardwareProfile: {
  baudRate: 115200,
  linearAxis: 'L0',
  vibrationAxis: undefined,
  strokeMin: 0,
  strokeMax: 1,
  stopPosition: 0,
  invertPosition: false
},
```

After validating the stroke range in `validateHardwareProfile`, add:

```ts
const stopPosition = validateUnitInterval(value.stopPosition, 'stop-position');
if (stopPosition < strokeMin || stopPosition > strokeMax) {
  throw new Error('invalid-stop-position');
}
```

Return `stopPosition` with the normalized profile.

- [ ] **Step 5: Implement deterministic v1/v2 migration**

Add this helper above `migrateAppSettings`:

```ts
function migrateLegacyHardwareProfile(value: unknown) {
  if (!isRecord(value)) return value;
  return {
    ...value,
    stopPosition: value.strokeMin
  };
}
```

Replace `migrateAppSettings` with:

```ts
export function migrateAppSettings(value: unknown): AppSettings {
  if (!isRecord(value)) throw new Error('invalid-app-settings');
  if (value.schemaVersion === CURRENT_SETTINGS_SCHEMA_VERSION) return validateAppSettings(value);
  if (value.schemaVersion === 2) {
    return validateAppSettings({
      schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
      hardwareProfile: migrateLegacyHardwareProfile(value.hardwareProfile),
      hardwareProtection: value.hardwareProtection,
      playback: value.playback
    });
  }
  if (value.schemaVersion === 1 || value.schemaVersion === undefined) {
    return validateAppSettings({
      schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
      hardwareProfile: migrateLegacyHardwareProfile(value.hardwareProfile),
      hardwareProtection: value.hardwareProtection,
      playback: { motionDelayMs: 0 }
    });
  }
  throw new Error('unsupported-settings-version');
}
```

- [ ] **Step 6: Update typed application defaults so the build remains coherent**

Add `stopPosition: 0` to `DEFAULT_HARDWARE_PROFILE` in both `electron/services/hardware-controller.ts` and `src/App.tsx`. Change the renderer constant to:

```ts
const CURRENT_SETTINGS_SCHEMA_VERSION = 3;
```

Do not change the controller's stop encoder call in this task; Task 2 covers that behavior after its own RED test.

- [ ] **Step 7: Run the settings test to verify GREEN**

Run:

```powershell
npm.cmd run build:electron
node scripts/app-settings-test.mjs
npm.cmd run lint
```

Expected: `app settings v3 tests passed`, followed by TypeScript exit code 0.

- [ ] **Step 8: Commit the schema unit**

Run:

```powershell
git add electron/protocol.ts src/shared/protocol.ts electron/app-settings.ts electron/services/hardware-controller.ts src/App.tsx scripts/app-settings-test.mjs
git commit -m "feat(settings): persist emergency stop position" -m "Constraint: migrate prior stop behavior from each profile's stroke minimum." -m "Confidence: high" -m "Scope-risk: moderate"
```

Expected: one commit containing schema version 3, migration, validation, defaults, and settings regressions.

### Task 2: Controller Uses One Absolute Stop Target

**Files:**

- Modify: `electron/services/hardware-controller.ts:210-240, 541-560`
- Test: `scripts/hardware-output-test.mjs:175-390`
- Test: `scripts/tcode-encoder-test.mjs:19-23`

- [ ] **Step 1: Write failing controller target regressions**

Change the existing successful emergency-stop connection profile to an inverted profile with a non-minimum stop target:

```js
await controller.connect('COM9', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0.2,
  strokeMax: 0.8,
  stopPosition: 0.3,
  invertPosition: true
});
await controller.emergencyStop();
assert.equal(outputs.at(-1).kind, 'stop');
assert.equal(outputs.at(-1).command, 'DSTOP\nL03000I1');
```

This proves the target is neither forced to `strokeMin` nor inverted to `0.70`.

Add `stopPosition: 0.6` to the `safeController` COM13 profile and change its raw-write assertion to:

```js
assert.match(safePort.writes.at(-1).trim(), /^DSTOP\nL06000I1$/);
```

Add an isolated direct-legacy fallback case before the final success message:

```js
const legacyStopPort = new FakePort('COM18');
const legacyStopController = new HardwareController({
  createPort: () => legacyStopPort,
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await legacyStopController.connect('COM18', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0.25,
  strokeMax: 0.75,
  invertPosition: false
});
await legacyStopController.emergencyStop();
assert.match(legacyStopPort.writes.at(-1).trim(), /^DSTOP\nL02500I1$/);
await legacyStopController.disconnect();
```

The missing field is intentional JavaScript runtime compatibility; do not add it to this one test profile.

- [ ] **Step 2: Strengthen the encoder example**

Keep the existing vibration case and add this assertion in `scripts/tcode-encoder-test.mjs`:

```js
assert.equal(
  encoder.encodeTCodeStop({ linearAxis: 'L0', stopPosition: 0.3 }),
  'DSTOP\nL03000I1\n'
);
```

- [ ] **Step 3: Run focused tests to verify RED**

Run:

```powershell
npm.cmd run build:electron
node scripts/tcode-encoder-test.mjs
node scripts/hardware-output-test.mjs
```

Expected: the encoder test passes because it already supports explicit targets, while the hardware-output test fails by producing `L02000I1` for the configured `0.30` controller target. That failure proves the remaining bug is controller wiring, not encoding.

- [ ] **Step 4: Normalize a defensive, stroke-bounded active target**

Replace `normalizeProfile` with a version that computes each bound once:

```ts
function normalizeProfile(profile: HardwareProfile): HardwareProfile {
  const strokeMin = clamp01(profile.strokeMin);
  const strokeMax = clamp01(profile.strokeMax);
  const low = Math.min(strokeMin, strokeMax);
  const high = Math.max(strokeMin, strokeMax);
  const requestedStopPosition = clamp01(profile.stopPosition ?? strokeMin);

  return {
    baudRate: profile.baudRate,
    linearAxis: profile.linearAxis.trim().toUpperCase(),
    vibrationAxis: profile.vibrationAxis?.trim().toUpperCase() || undefined,
    strokeMin,
    strokeMax,
    stopPosition: Math.min(high, Math.max(low, requestedStopPosition)),
    invertPosition: profile.invertPosition
  };
}
```

The nullish fallback is defensive runtime compatibility only. TypeScript callers and schema-version-3 settings still require `stopPosition`.

- [ ] **Step 5: Route the shared stop path through the active target**

Change only the target passed by `emergencyStop()`:

```ts
const payload = encodeTCodeStop({
  linearAxis: this.profile.linearAxis,
  vibrationAxis: this.profile.vibrationAxis,
  stopPosition: this.profile.stopPosition
});
```

Do not duplicate this code in `disconnectSafely()`. It already invokes `emergencyStop()` and therefore inherits the same target.

- [ ] **Step 6: Run focused tests to verify GREEN**

Run:

```powershell
npm.cmd run build:electron
node scripts/tcode-encoder-test.mjs
node scripts/hardware-output-test.mjs
```

Expected: `tcode encoder tests passed` and `hardware output tests passed`.

- [ ] **Step 7: Commit the controller unit**

Run:

```powershell
git add electron/services/hardware-controller.ts scripts/tcode-encoder-test.mjs scripts/hardware-output-test.mjs
git commit -m "feat(hardware): apply configured stop position" -m "Constraint: emergency stop and safe disconnect must share one absolute target." -m "Rejected: direction-adjusted stop target | stopPosition is an absolute device-axis coordinate." -m "Confidence: high" -m "Scope-risk: narrow"
```

Expected: one commit containing only the controller behavior and focused T-Code regressions.

### Task 3: Range-Aware Stop Position UI

**Files:**

- Modify: `src/App.tsx:38-55, 690-735, 1041-1046`
- Test: `scripts/preload-format-test.mjs:65-85`

- [ ] **Step 1: Write failing renderer source assertions**

Add these checks beside the existing hardware panel assertions in `scripts/preload-format-test.mjs`:

```js
assert.match(appSource, /const CURRENT_SETTINGS_SCHEMA_VERSION = 3;/);
assert.match(hardwarePanelSource, /긴급 정지 위치/);
assert.match(hardwarePanelSource, /min=\{hardwareProfile\.strokeMin\}/);
assert.match(hardwarePanelSource, /max=\{hardwareProfile\.strokeMax\}/);
assert.match(hardwarePanelSource, /value=\{hardwareProfile\.stopPosition\}/);
assert.match(hardwarePanelSource, /disabled=\{hardwareConnected \|\| isBusy\}/);
assert.match(hardwarePanelSource, /updateHardwareProfile\(\{ stopPosition: Number\(event\.target\.value\) \}\)/);
assert.match(appSource, /stopPosition:\s*Math\.min\(high, Math\.max\(low, next\.stopPosition\)\)/);
```

- [ ] **Step 2: Run the source integration test to verify RED**

Run:

```powershell
npm.cmd run build:electron
node scripts/preload-format-test.mjs
```

Expected: assertion failure because the profile grid has no **긴급 정지 위치** input and `updateProfileValue` does not clamp it.

- [ ] **Step 3: Add the connection-time absolute position input**

Insert this label after the maximum-position input in `hardwarePanel`:

```tsx
<label>
  긴급 정지 위치
  <input
    type="number"
    min={hardwareProfile.strokeMin}
    max={hardwareProfile.strokeMax}
    step="0.01"
    value={hardwareProfile.stopPosition}
    disabled={hardwareConnected || isBusy}
    onChange={event => updateHardwareProfile({ stopPosition: Number(event.target.value) })}
  />
</label>
```

The existing Task 1 default and schema constant already provide `stopPosition: 0` and version 3. Do not add a live profile-update IPC; the active value changes only on the next successful connection.

- [ ] **Step 4: Clamp the target when either stroke boundary changes**

Replace `updateProfileValue` with:

```ts
function updateProfileValue(profile: HardwareProfile, patch: Partial<HardwareProfile>): HardwareProfile {
  const next = {
    ...profile,
    ...patch
  };
  const low = Math.min(next.strokeMin, next.strokeMax);
  const high = Math.max(next.strokeMin, next.strokeMax);
  return {
    ...next,
    stopPosition: Math.min(high, Math.max(low, next.stopPosition))
  };
}
```

This keeps the target within the current numeric bounds. It does not conceal an invalid crossed stroke range; main-process validation still rejects `strokeMin >= strokeMax` on save or connect.

- [ ] **Step 5: Run renderer checks to verify GREEN**

Run:

```powershell
npm.cmd run build:electron
node scripts/preload-format-test.mjs
npm.cmd run lint
```

Expected: `sandbox preload format: commonjs`, followed by TypeScript exit code 0.

- [ ] **Step 6: Commit the renderer unit**

Run:

```powershell
git add src/App.tsx scripts/preload-format-test.mjs
git commit -m "feat(ui): configure emergency stop position" -m "Constraint: the displayed target must match the connection-time hardware profile." -m "Rejected: live edits while connected | the controller would still hold the prior profile." -m "Confidence: high" -m "Scope-risk: narrow"
```

Expected: one commit containing only the profile input, clamp behavior, and UI assertions.

### Task 4: Full Verification, Shared Guide, and Physical Handoff

**Files:**

- Modify: `C:\Users\user\AI_NOTES\TCODE_GUIDE.md:115-126, 207-240`
- Modify: `C:\Users\user\AI_NOTES\logs\laptop.md:12`
- Verify: application worktree and AI_NOTES repository

- [ ] **Step 1: Run the full application gate before documenting behavior**

Run:

```powershell
npm.cmd run test:electron
npm.cmd run test:ui
npm.cmd run lint
npm.cmd run build
git diff --check
git status --short
```

Expected: all commands exit with code 0; `git diff --check` is silent; no implementation file is uncommitted.

- [ ] **Step 2: Update the shared T-Code lifecycle guidance**

In `C:\Users\user\AI_NOTES\TCODE_GUIDE.md`, add this Desktop rule after the existing `DSTOP` lifecycle example:

```markdown
### Desktop 절대 정지 위치 규칙 — 2026-08-22 자동 검증

- Desktop은 `DSTOP` 뒤에 `L0{stopPosition}I1` fallback을 보내고, 진동 축이 있으면 `V00000`을 함께 보낸다.
- `stopPosition`은 장치 축 기준 절대값 `0.00~1.00`이며 활성 `strokeMin~strokeMax` 안에 있어야 한다.
- 방향 반전은 일반 motion 매핑에만 적용하고 절대 정지 위치에는 적용하지 않는다.
- 긴급정지와 안전 연결 해제는 같은 `HardwareController.emergencyStop()` 페이로드를 사용한다.
- 설정 v2 이하를 v3으로 옮길 때 `stopPosition = 기존 strokeMin`으로 정해 이전 동작을 보존한다.
- serial write 성공은 OS 직렬 스택의 수락만 증명하며 실제 위치 도달이나 물리 정지를 증명하지 않는다.
```

Do not rewrite historical bug evidence in `logs/`. The new lifecycle subsection is the current reusable rule.

- [ ] **Step 3: Add the laptop work log entry**

Insert a newest-first entry immediately after the `---` marker in `C:\Users\user\AI_NOTES\logs\laptop.md`:

```markdown
## [2026-08-22 20:15 KST] [desktop] 절대 긴급정지 위치 및 안전 연결 해제 검증

- 무엇을 했는지:
  - Desktop 하드웨어 프로필에 절대 `stopPosition`을 추가하고 설정 v2 이하를 기존 `strokeMin` 값으로 마이그레이션했다.
  - 긴급정지와 안전 연결 해제가 같은 `DSTOP` + 위치 fallback을 사용하도록 회귀 테스트로 고정했다.
  - 연결 중 UI 편집을 막고, 포트 오류·close-only 손실·500ms write timeout의 fail-closed 동작을 유지했다.
- 다른 AI가 주의할 점 / 함정:
  - 절대 정지 위치에는 방향 반전을 적용하지 않는다. 성공한 write callback도 물리 정지를 증명하지 않는다.
- 남은 것 / 다음 작업 힌트:
  - COM3 실기기에서 `stroke 0.20~0.80`, `stopPosition 0.30`으로 실제 위치와 안전 연결 해제를 확인한다.
```

- [ ] **Step 4: Commit and synchronize AI_NOTES without including unrelated files**

Run from `C:\Users\user\AI_NOTES`:

```powershell
git status --short
git diff --check -- TCODE_GUIDE.md logs/laptop.md
git add -- TCODE_GUIDE.md logs/laptop.md
git commit -m "note: desktop 작업 요약" -m "Confidence: high" -m "Scope-risk: narrow"
git pull --rebase origin main
git push origin main
```

Expected: only `TCODE_GUIDE.md` and `logs/laptop.md` are committed; pull/rebase succeeds; `origin/main` advances to the new note commit. If unrelated changes appear, stop and preserve them rather than staging them.

- [ ] **Step 5: Verify final application scope after documentation work**

Run from the application worktree:

```powershell
git log --oneline --decorate -8
git diff --stat 000c735..HEAD
git diff --check 000c735..HEAD
git status --short --branch
```

Expected: the range after design commit contains only settings/protocol, controller/tests, and UI/test changes; the application worktree is clean.

> **ARCHIVED — DO NOT EXECUTE THIS PHYSICAL SECTION.** The referenced 2026-08-22 disconnect checks are obsolete and must not be followed. Use [the current lifecycle authority](../specs/2026-08-23-room-motion-emergency-latch-design.md) and [current hardware session checklist](../../HARDWARE_SESSION_CHECKLIST.md).

- [ ] **Step 6: Stop before physical COM3 access and request readiness**

Report the automated and documentation results, then require the user to confirm:

```text
- COM3 is the intended device.
- The mechanism is unloaded and clear.
- An independent power cutoff is within reach.
- Initial profile is 115200 / L0 / no vibration / stroke 0.20..0.80 / stopPosition 0.30.
```

Only after explicit confirmation, follow `docs/superpowers/specs/2026-08-22-emergency-stop-position-design.md`. Never deliberately stall or unplug a moving physical device to test a failure path.
