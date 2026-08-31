# Release 11 Always-On Full Debug Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship desktop version `0.1.1-demo.11` with always-on, local, bounded JSONL diagnostics containing every 30 Hz hardware motion sample and every main-process lifecycle event.

**Architecture:** Replace the diagnostic store's one-second motion bucket with ordered per-sample writes while preserving its serialized queue and atomic rotation. Route every sanitized `addLog` entry into the same store as an `app-log` event, keep exact hardware diagnostics separate, and retain the existing fail-open safety sequencing. Version the diagnostic metadata and package separately from the app settings schema.

**Tech Stack:** TypeScript, Electron main process, Node.js `fs/promises`, JSONL, Node assertion tests, npm/electron-builder

---

## File Structure

- Modify `electron/diagnostic-log-store.ts`: schema-2 metadata, 16 MiB/16-file defaults, raw motion records, no summary bucket.
- Modify `electron/main.ts`: persist every `addLog`, route raw motion samples, and keep shutdown ordering/failure isolation.
- Modify `scripts/diagnostic-log-store-test.mjs`: raw sample, rotation, ordering, and failure tests.
- Modify `scripts/preload-format-test.mjs`: source assertions for raw routing and app-log persistence.
- Modify `scripts/log-export-test.mjs`: assert schema-2 diagnostic metadata while preserving compact export behavior.
- Modify `package.json` and `package-lock.json`: bump version to `0.1.1-demo.11`.
- Modify `docs/ARCHITECTURE.md`: document always-on raw capture and new retention bounds.
- Modify `docs/DEVELOPMENT_HANDOFF.md`: update operational instructions and log collection workflow.

### Task 1: Raw Diagnostic Store

**Files:**
- Modify: `electron/diagnostic-log-store.ts`
- Test: `scripts/diagnostic-log-store-test.mjs`

- [ ] **Step 1: Write failing raw-capture tests**

Replace the existing summary-bucket test with this deterministic case, retaining the existing ordering, rotation, and failure cases:

```js
const fake = createFakeOperations();
const store = new DiagnosticLogStore({
  directory: diagnosticsDirectory,
  sessionId: 'motion-session',
  operations: fake.operations
});

await store.recordMotion({ timestamp: 2100, outcome: 'completed', command: 'L05000100', position: 0.5, intensity: 0.1 });
await store.recordMotion({ timestamp: 2200, outcome: 'completed', command: 'L06000100', position: 0.6, intensity: 0.1 });
await store.recordMotion({ timestamp: 2300, outcome: 'dropped', position: 0.6, intensity: 0.1, reason: 'protection-paused' });
await store.recordMotion({ timestamp: 3100, outcome: 'failed', command: 'L07000100', position: 0.7, intensity: 0.1, reason: 'hardware-write-timeout' });
await store.flush();

assert.deepEqual(
  allRecords(fake).map(record => record.event),
  ['hardware-motion-sample', 'hardware-motion-sample', 'hardware-motion-sample', 'hardware-motion-sample']
);
assert.deepEqual(allRecords(fake).map(record => record.data.outcome), ['completed', 'completed', 'dropped', 'failed']);
assert.equal(allRecords(fake)[1].data.command, 'L06000100');
assert.equal(allRecords(fake)[2].data.reason, 'protection-paused');
assert.equal(allRecords(fake)[3].data.timeout, undefined, 'store does not invent fields absent from the input');
```

Add a default metadata assertion:

```js
const defaults = new DiagnosticLogStore({ directory: diagnosticsDirectory, sessionId: 'defaults', operations: createFakeOperations().operations });
assert.equal(defaults.metadata().schemaVersion, 2);
assert.equal(defaults.metadata().maxFileBytes, 16 * 1024 * 1024);
assert.equal(defaults.metadata().maxFiles, 16);
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
npm run build:electron
node scripts/diagnostic-log-store-test.mjs
```

Expected: FAIL because the store still emits `hardware-motion-summary`, has schema-1/2 MiB/5-file defaults, and retains the motion bucket.

- [ ] **Step 3: Implement serialized raw motion writes**

In `electron/diagnostic-log-store.ts`:

```ts
const DIAGNOSTIC_SCHEMA_VERSION = 2 as const;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FILES = 16;
```

Delete `MotionBucket` and `motionBucket`. Implement `recordMotion` as an ordered write through `record`:

```ts
recordMotion(sample: MotionDiagnosticSample) {
  const data: Record<string, unknown> = { outcome: sample.outcome };
  if (sample.command !== undefined) data.command = boundedText(sample.command);
  if (sample.position !== undefined) data.position = sample.position;
  if (sample.intensity !== undefined) data.intensity = sample.intensity;
  if (sample.reason !== undefined) data.reason = boundedText(sample.reason);
  if (sample.durationMs !== undefined) data.durationMs = sample.durationMs;
  if (sample.timeout !== undefined) data.timeout = sample.timeout;
  return this.record({
    timestamp: sample.timestamp,
    level: sample.outcome === 'failed' ? 'error' : sample.outcome === 'dropped' ? 'warning' : 'info',
    source: 'hardware',
    event: 'hardware-motion-sample',
    data
  });
}
```

Extend `MotionDiagnosticSample` with optional `durationMs` and `timeout`. `recordBoundary` becomes a direct `return this.record(input)`. Remove `flushMotion`; `flush()` remains the only queue drain. Do not change append/rotation serialization or failure disabling.

- [ ] **Step 4: Run raw store and existing Electron tests**

Run:

```powershell
npm run build:electron
node scripts/diagnostic-log-store-test.mjs
npm run test:electron
```

Expected: all tests pass; only intentional fault-injection errors may appear on stderr.

- [ ] **Step 5: Commit the store unit**

```powershell
git add electron/diagnostic-log-store.ts scripts/diagnostic-log-store-test.mjs
git commit -m "feat(logs): persist every hardware motion sample" -m "Constraint: Keep serialized JSONL writes and bounded rotation." -m "Rejected: One-second motion summaries | they hide the disconnect-triggering frame." -m "Confidence: high" -m "Scope-risk: moderate"
```

### Task 2: Complete Main-Process Event Routing

**Files:**
- Modify: `electron/main.ts`
- Modify: `scripts/preload-format-test.mjs`
- Test: `scripts/diagnostic-log-store-test.mjs`

- [ ] **Step 1: Write failing routing tests and source assertions**

Add a fake-store routing test around `addLog` behavior using the existing source-level test style. Assert that the source records an `app-log` with sanitized message/details before the UI deduplication map and that `routeHardwareDiagnostic` passes `durationMs` and `timeout` to `recordMotion`.

```js
assert.match(mainSource, /function addLog\([\s\S]*?diagnosticLogStore\?\.record\([\s\S]*?event:\s*['"]app-log['"][\s\S]*?sanitizeDiagnosticData/);
assert.match(mainSource, /function routeHardwareDiagnostic\([\s\S]*?recordMotion\([\s\S]*?durationMs:\s*primitiveNumber\(diagnostic\.data\.durationMs\)[\s\S]*?timeout:/);
assert.doesNotMatch(mainSource, /recordMotionBucket|hardware-motion-summary/);
```

Update the existing `scripts/diagnostic-log-store-test.mjs` boundary test to expect the raw motion event before `session-ended`.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```powershell
npm run build:electron
node scripts/preload-format-test.mjs
node scripts/diagnostic-log-store-test.mjs
```

Expected: FAIL because main still uses the old summary flow and `addLog` does not persist app/relay events.

- [ ] **Step 3: Route every app log without recursion**

At the start of `addLog`, after `now` is calculated and before the one-second `lastLogByKey` check, add:

```ts
const diagnostic = diagnosticLogStore;
if (diagnostic) {
  void diagnostic.record({
    timestamp: now,
    level: entry.level,
    source: entry.source,
    event: 'app-log',
    data: sanitizeDiagnosticData({
      message: boundedText(entry.message),
      details: entry.details === undefined ? undefined : boundedText(entry.details)
    })
  });
}
```

Expand `DiagnosticEventInput.source` to `'app' | 'hardware' | 'relay' | 'room' | 'protection'`, add `details` to `DIAGNOSTIC_DATA_FIELDS`, and ensure `sanitizeDiagnosticData` is called before app-log persistence. Keep the existing in-memory deduplication unchanged. Because a failed store returns immediately after disabling, `reportPersistentLogFailure` may still add one in-memory entry without recursive filesystem writes.

- [ ] **Step 4: Route complete raw hardware samples and preserve shutdown order**

In `routeHardwareDiagnostic`, replace the old sample mapping with:

```ts
void diagnosticLogStore.recordMotion({
  timestamp: diagnostic.timestamp,
  outcome,
  command: primitiveString(diagnostic.data.command),
  position: primitiveNumber(diagnostic.data.position),
  intensity: primitiveNumber(diagnostic.data.intensity),
  reason: primitiveString(diagnostic.data.reason),
  durationMs: primitiveNumber(diagnostic.data.durationMs),
  timeout: diagnostic.data.timeout === true
});
```

Remove any `flushMotion()` call from `flushDiagnosticsForShutdown`; `recordBoundary` now queues after all prior sample writes, then the existing bounded `flush()` drains the sequence.

- [ ] **Step 5: Extend sanitization and routing tests**

Assert that `details` is bounded and that a string containing `password=`, `token=`, or a URL query is not recorded by app-log routing. Keep the existing allowlist test for arbitrary fields. Assert that repeated identical app logs are present in persistent fake-store order even though only one appears in the in-memory UI list.

- [ ] **Step 6: Run main routing and full Electron tests**

Run:

```powershell
npm run build:electron
node scripts/preload-format-test.mjs
node scripts/diagnostic-log-store-test.mjs
npm run test:electron
```

Expected: all commands exit 0, with raw `hardware-motion-sample` records and no `hardware-motion-summary` records.

- [ ] **Step 7: Commit the routing unit**

```powershell
git add electron/main.ts scripts/preload-format-test.mjs scripts/diagnostic-log-store-test.mjs
git commit -m "feat(logs): persist complete application diagnostics" -m "Constraint: Logging failures cannot delay motion or safety teardown." -m "Rejected: Persist only UI-deduplicated logs | it loses repeated failure evidence." -m "Confidence: high" -m "Scope-risk: broad"
```

### Task 3: Release 11 Version and Documentation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `scripts/log-export-test.mjs`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DEVELOPMENT_HANDOFF.md`

- [ ] **Step 1: Write failing version/metadata tests**

Add to `scripts/log-export-test.mjs`:

```js
assert.equal(payload.diagnosticLog.schemaVersion, 2);
assert.equal(payload.diagnosticLog.maxFileBytes, 16 * 1024 * 1024);
assert.equal(payload.diagnosticLog.maxFiles, 16);
```

Add a package-source assertion in `scripts/preload-format-test.mjs` or a new `scripts/release-version-test.mjs`:

```js
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(packageJson.version, '0.1.1-demo.11');
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm run build:electron
node scripts/log-export-test.mjs
```

Expected: FAIL because the package and diagnostic metadata still report Demo 10/schema 1/default 2 MiB×5.

- [ ] **Step 3: Bump package and lock versions**

Change exactly these four version strings:

```json
"version": "0.1.1-demo.11"
```

in `package.json` and the root/package entry in `package-lock.json`. Do not update dependencies or regenerate the lockfile.

- [ ] **Step 4: Update operational documentation**

In `docs/ARCHITECTURE.md` and `docs/DEVELOPMENT_HANDOFF.md`, replace the old `2 MiB`, `.1.. .4`, and “one-second summary” statements with:

```text
Release 11 always writes sanitized JSONL diagnostics locally. Every hardware motion sample is recorded at the 30Hz output cadence; the active file plus .1 through .15 are capped at 16MiB each (maximum 256MiB). The compact UI export still contains in-memory entries and metadata; attach rotated files for complete incident reconstruction.
```

Retain the existing privacy allowlist, local-only policy, and fail-open safety wording.

- [ ] **Step 5: Run version, docs, and regression tests**

Run:

```powershell
node scripts/log-export-test.mjs
npm run test:electron
npm run lint
npm run build
git diff --check
```

Expected: all pass; no dependency lock changes beyond the two package version locations.

- [ ] **Step 6: Commit Release 11 metadata**

```powershell
git add package.json package-lock.json scripts/log-export-test.mjs scripts/preload-format-test.mjs docs/ARCHITECTURE.md docs/DEVELOPMENT_HANDOFF.md
git commit -m "chore(release): prepare demo 11 diagnostics" -m "Constraint: Keep exports compact while raw logs remain local." -m "Confidence: high" -m "Scope-risk: moderate"
```

### Task 4: Full Verification and Reproduction Package

**Files:**
- Verify: all tracked implementation files from Tasks 1-3.

- [ ] **Step 1: Run all automated gates**

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

Expected: every command exits 0, intentional fake-hardware fault logs do not change exit status, and the worktree is clean.

- [ ] **Step 2: Build the Release 11 unpacked app**

```powershell
npm run electron:pack
```

Expected: exit 0 and `release/win-unpacked/Haptic Relay.exe` has a fresh timestamp. The package must report `0.1.1-demo.11` in the session-started diagnostic record.

- [ ] **Step 3: Verify raw capture without hardware**

Launch the unpacked app with an isolated temporary Electron user-data directory. Open and close Hardware Settings and Logs, then inspect `userData/logs/haptic-relay.jsonl` to confirm `session-started`, `app-log`, and `session-ended` records are valid JSONL. Confirm no password/token/query strings occur.

- [ ] **Step 4: Bounded physical reproduction**

With no person/load in the mechanism and the power switch reachable:

1. Connect the known COM port and confirm the T-Code probe succeeds.
2. Set the normal hardware range only if the device is stable; otherwise use `48%..52%` and stop `50%`.
3. Set demo intensity to `100%` and make one rapid right-end→left-end move.
4. Record the local time if the port disconnects. Do not repeatedly reconnect while the device is unstable.
5. Export the compact JSON and copy the raw active/rotated JSONL files from Electron `userData/logs`.
6. Compare the final completed sample, write duration/timeout, port-error/close, and disconnect-stop records in timestamp order.

Stop immediately on abrupt motion, a port error, or unexpected movement. No automatic upload is performed.

- [ ] **Step 5: Confirm worktree and package evidence**

Run:

```powershell
git status --short
Get-FileHash -LiteralPath 'release\win-unpacked\Haptic Relay.exe' -Algorithm SHA256
```

Expected: no tracked changes and a recorded SHA-256 for the exact artifact delivered to the user.

### Task 5: Final Review and Handoff

**Files:**
- Review: all commits from the pre-task HEAD through the Release 11 tip.

- [ ] **Step 1: Request a final code review**

Use `superpowers:requesting-code-review` with the pre-feature HEAD, requiring specific checks for log volume, rotation atomicity, privacy filtering, event ordering, and safety sequencing. Resolve every Critical or Important finding with a regression test before handoff.

- [ ] **Step 2: Re-run affected gates after review fixes**

Run the focused test for each fix, then repeat the full commands from Task 4 Step 1 and `git diff --check`.

- [ ] **Step 3: Finish the branch workflow**

Invoke `superpowers:finishing-a-development-branch`. Report the implementation commits, Release 11 artifact path/hash, raw-log reproduction result, and the remaining review status. Do not push, merge, tag, or publish without explicit user authorization.
