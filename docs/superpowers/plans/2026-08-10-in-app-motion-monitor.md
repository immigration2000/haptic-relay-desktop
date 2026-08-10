# In-App Motion Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hardware-free viewer monitor that proves streamer motion traversed the existing relay server and viewer receive pipeline.

**Architecture:** The existing `RelayClient` callback remains the single accepted-frame boundary. Electron main records a cumulative count, attempts the existing hardware queue, and emits a typed `MotionMonitorSnapshot` through a one-way sandboxed preload subscription; the React viewer stores only the newest ten snapshots and renders the latest values, metadata, and queue state.

**Tech Stack:** Electron 37, React 19, TypeScript 5.8, Socket.IO 4.8, Vite 7, Node.js source-contract and relay smoke tests

---

## File Map

- Modify `electron/protocol.ts`: define the main/preload-side `MotionMonitorSnapshot` IPC payload.
- Modify `src/shared/protocol.ts`: mirror the renderer-side snapshot type used by the existing duplicated protocol boundary.
- Modify `electron/main.ts`: emit one monitor snapshot after each accepted viewer frame and hardware queue attempt.
- Modify `electron/preload.cts`: expose a typed, removable `onMotionReceived` listener.
- Modify `src/global.d.ts`: type the renderer bridge listener.
- Modify `src/App.tsx`: subscribe, retain ten events, and render the viewer-only monitor.
- Modify `src/styles.css`: provide stable responsive gauges, metrics, and frame-history layout.
- Modify `scripts/preload-format-test.mjs`: assert the IPC sender, bridge, cleanup, viewer placement, and bounded history contract.
- Modify `package.json`: add a command for launching the second Electron client against the existing Vite process.
- Modify `README.md`: document the hardware-free two-client demonstration.

### Task 1: Lock Down the Monitor IPC Contract

**Files:**
- Modify: `scripts/preload-format-test.mjs`
- Modify: `electron/protocol.ts`
- Modify: `src/shared/protocol.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.cts`
- Modify: `src/global.d.ts`

- [ ] **Step 1: Write failing source-contract assertions**

Extend `scripts/preload-format-test.mjs` with assertions that require the main sender and removable preload listener:

```js
assert.match(mainSource, /webContents\.send\(['"]motion:received['"],\s*snapshot\)/);
assert.match(preloadSource, /onMotionReceived:\s*\(listener/);
assert.match(preloadSource, /ipcRenderer\.on\(['"]motion:received['"],\s*handler\)/);
assert.match(preloadSource, /removeListener\(['"]motion:received['"],\s*handler\)/);
```

- [ ] **Step 2: Run the contract test and confirm the red state**

Run: `npm.cmd run test:electron`

Expected: FAIL in `preload-format-test.mjs` because `motion:received` does not exist yet.

- [ ] **Step 3: Define the snapshot type on both existing protocol boundaries**

Add the same type after `MotionFrame` in `electron/protocol.ts` and `src/shared/protocol.ts`:

```ts
export type MotionMonitorSnapshot = {
  frame: MotionFrame;
  receivedAt: number;
  receivedFrames: number;
  hardware: {
    queued: boolean;
    reason?: string;
  };
};
```

- [ ] **Step 4: Emit snapshots from the accepted viewer-frame callback**

Import `MotionMonitorSnapshot` in `electron/main.ts`, add `let receivedMotionFrames = 0`, and extend the existing `RelayClient` frame callback:

```ts
const relay = new RelayClient(frame => {
  const result = hardware.queueMotion(frame);
  const snapshot: MotionMonitorSnapshot = {
    frame,
    receivedAt: Date.now(),
    receivedFrames: ++receivedMotionFrames,
    hardware: result
  };
  mainWindow?.webContents.send('motion:received', snapshot);
  if (result.queued === false && result.reason !== 'hardware-not-connected') {
    addLog({ level: 'warning', source: 'hardware', message: 'motion-not-queued', details: result.reason });
  }
}, ...);
```

The event must remain after `queueMotion(frame)` so it reports the real queue result, and inside this callback so rejected/out-of-order frames never reach the monitor.

- [ ] **Step 5: Expose and type a removable preload listener**

Import `MotionMonitorSnapshot` in `electron/preload.cts`, then add:

```ts
onMotionReceived: (listener: (snapshot: MotionMonitorSnapshot) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, snapshot: MotionMonitorSnapshot) => listener(snapshot);
  ipcRenderer.on('motion:received', handler);
  return () => ipcRenderer.removeListener('motion:received', handler);
},
```

Import the same type in `src/global.d.ts` and add:

```ts
onMotionReceived: (listener: (snapshot: MotionMonitorSnapshot) => void) => () => void;
```

- [ ] **Step 6: Run the Electron contract suite and confirm green**

Run: `npm.cmd run test:electron`

Expected: `sandbox preload format: commonjs` and all Electron test scripts exit 0.

- [ ] **Step 7: Commit the IPC contract**

```bash
git add scripts/preload-format-test.mjs electron/protocol.ts src/shared/protocol.ts electron/main.ts electron/preload.cts src/global.d.ts
git commit -m "feat: expose received motion snapshots"
```

### Task 2: Build the Viewer-Only Motion Monitor

**Files:**
- Modify: `scripts/preload-format-test.mjs`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: Add failing renderer contract assertions**

Read a `motionMonitorPanelSource` section and require listener cleanup, bounded newest-first storage, and placement before the delay panel:

```js
const motionMonitorPanelSource = sourceSection(appSource, '  const motionMonitorPanel = (', '  const motionDelayPanel = (');
assert.match(appSource, /const removeMotionReceived = window\.hapticRelay\.onMotionReceived/);
assert.match(appSource, /setMotionMonitorEntries\(current => \[snapshot, \.\.\.current\]\.slice\(0, 10\)\)/);
assert.match(appSource, /removeMotionReceived\(\)/);
assert.match(motionMonitorPanelSource, /관리자 수신 모니터/);
assert.match(appSource, /\{motionMonitorPanel\}\s*\{motionDelayPanel\}/);
```

- [ ] **Step 2: Run the contract test and confirm the red state**

Run: `npm.cmd run test:electron`

Expected: FAIL because the renderer has no monitor state or panel.

- [ ] **Step 3: Subscribe and retain ten snapshots**

Import `MotionMonitorSnapshot`, add state and latest-value derivation, then subscribe in the existing IPC effect:

```ts
const [motionMonitorEntries, setMotionMonitorEntries] = useState<MotionMonitorSnapshot[]>([]);
const latestMotion = motionMonitorEntries[0];

const removeMotionReceived = window.hapticRelay.onMotionReceived(snapshot => {
  setMotionMonitorEntries(current => [snapshot, ...current].slice(0, 10));
});
```

Call `removeMotionReceived()` in that effect's cleanup alongside the existing listener removals.

- [ ] **Step 4: Render the expanded viewer monitor**

Define `motionMonitorPanel` immediately before `motionDelayPanel`. It must render:

```tsx
<section className="panel motion-monitor" aria-live="polite">
  <div className="panel-header">
    <h2>관리자 수신 모니터</h2>
    <span className={`monitor-state ${latestMotion ? 'receiving' : 'waiting'}`}>
      {latestMotion ? '수신 중' : '수신 대기 중'}
    </span>
  </div>
  {latestMotion ? (
    <>
      <div className="monitor-gauges">
        <MotionGauge label="위치" value={latestMotion.frame.position} />
        <MotionGauge label="강도" value={latestMotion.frame.intensity} />
      </div>
      <dl className="monitor-metrics">
        <div><dt>프로토콜</dt><dd>v{latestMotion.frame.protocolVersion ?? 1}</dd></div>
        <div><dt>시퀀스</dt><dd>{latestMotion.frame.sequence ?? '-'}</dd></div>
        <div><dt>누적 수신</dt><dd>{latestMotion.receivedFrames}</dd></div>
        <div><dt>마지막 수신</dt><dd>{formatTime(latestMotion.receivedAt)}</dd></div>
      </dl>
      <p className="monitor-delivery">
        {latestMotion.hardware.queued ? '하드웨어 전달 정상' : latestMotion.hardware.reason === 'hardware-not-connected' ? '가상 수신 정상 / 하드웨어 미연결' : `수신 정상 / 하드웨어 전달 실패: ${latestMotion.hardware.reason ?? 'unknown'}`}
      </p>
      <div className="motion-history" aria-label="최근 수신 프레임">
        {motionMonitorEntries.map(entry => (
          <div className="motion-history-row" key={`${entry.receivedAt}-${entry.receivedFrames}`}>
            <span>#{entry.receivedFrames}</span>
            <span>P {entry.frame.position.toFixed(2)}</span>
            <span>I {entry.frame.intensity.toFixed(2)}</span>
            <time>{formatTime(entry.receivedAt)}</time>
          </div>
        ))}
      </div>
    </>
  ) : <p className="muted">스트리머의 모션 데이터가 도착하면 여기에 표시됩니다.</p>}
</section>
```

Add a focused component outside `App`:

```tsx
function MotionGauge({ label, value }: { label: string; value: number }) {
  return (
    <div className="motion-gauge">
      <div><span>{label}</span><strong>{value.toFixed(2)}</strong></div>
      <progress max={1} value={value} aria-label={`${label} ${value.toFixed(2)}`} />
    </div>
  );
}
```

Render `{motionMonitorPanel}` directly before `{motionDelayPanel}` in the viewer branch only.

- [ ] **Step 5: Add stable responsive monitor styles**

Add CSS with fixed grid tracks and mobile collapse:

```css
.monitor-state { font-size: 13px; font-weight: 700; color: #647684; }
.monitor-state.receiving { color: #08775f; }
.monitor-gauges { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.motion-gauge { display: grid; gap: 8px; }
.motion-gauge div { display: flex; justify-content: space-between; gap: 12px; }
.motion-gauge progress { width: 100%; height: 14px; accent-color: #08775f; }
.monitor-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 0; }
.monitor-metrics div { min-width: 0; }
.monitor-metrics dt { color: #647684; font-size: 12px; }
.monitor-metrics dd { margin: 4px 0 0; font-weight: 700; overflow-wrap: anywhere; }
.monitor-delivery { margin: 0; color: #08775f; font-weight: 700; }
.motion-history { display: grid; max-height: 260px; overflow: auto; border-top: 1px solid #d7e0e7; }
.motion-history-row { display: grid; grid-template-columns: 72px 1fr 1fr 82px; gap: 10px; padding: 9px 0; border-bottom: 1px solid #e8edf1; font: 13px "Cascadia Mono", Consolas, monospace; }

@media (max-width: 720px) {
  .monitor-gauges, .monitor-metrics { grid-template-columns: 1fr 1fr; }
  .motion-history-row { grid-template-columns: 62px 1fr 1fr; }
  .motion-history-row time { grid-column: 2 / -1; }
}
```

- [ ] **Step 6: Run focused tests and the production build**

Run: `npm.cmd run test:electron`

Expected: all Electron contract tests exit 0.

Run: `npm.cmd run build`

Expected: TypeScript, Electron, server, Vite, and renderer checks all exit 0.

- [ ] **Step 7: Commit the viewer monitor**

```bash
git add scripts/preload-format-test.mjs src/App.tsx src/styles.css
git commit -m "feat: add viewer motion monitor"
```

### Task 3: Document and Enable the Two-Client Demo

**Files:**
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Add the second-client command**

Add this script beside `electron:dev` in `package.json`:

```json
"electron:demo-client": "wait-on tcp:5173 && cross-env VITE_DEV_SERVER_URL=http://127.0.0.1:5173 electron ."
```

This deliberately reuses the Vite server started by `electron:dev` and launches a separate Electron process with separate renderer state.

- [ ] **Step 2: Add the hardware-free demo runbook**

Add a `하드웨어 없는 2클라이언트 시연` section to `README.md` with three PowerShell terminals:

```powershell
# terminal 1: relay server
npm.cmd run server:dev

# terminal 2: Vite + streamer desktop client
npm.cmd run electron:dev

# terminal 3: viewer desktop client
npm.cmd run electron:demo-client
```

Document these exact actions: create an open room in the first app, join with the second app, use the streamer motion test controls, and confirm the viewer's `관리자 수신 모니터` shows matching position/intensity plus `가상 수신 정상 / 하드웨어 미연결`.

- [ ] **Step 3: Validate package syntax and documentation diff**

Run: `npm.cmd run build:electron`

Expected: exit 0, proving `package.json` parses and Electron TypeScript still compiles.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 4: Commit demo tooling and documentation**

```bash
git add package.json README.md
git commit -m "docs: add hardware-free relay demo"
```

### Task 4: End-to-End Verification

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run motion protocol tests**

Run: `npm.cmd run test:motion`

Expected: packet encoding, sequence filtering, and delay-buffer tests all exit 0.

- [ ] **Step 2: Run the real relay smoke test**

Run: `npm.cmd run test:smoke`

Expected: room creation/join and real viewer motion receipt pass without serial hardware.

- [ ] **Step 3: Run Electron and full production checks**

Run: `npm.cmd run test:electron`

Expected: preload and renderer contracts pass.

Run: `npm.cmd run build`

Expected: full build exits 0.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 4: Start the local relay server and verify health**

Run the server in a background process:

```powershell
Start-Process -WindowStyle Hidden -FilePath "npm.cmd" -ArgumentList "run","server:dev" -WorkingDirectory (Get-Location)
```

Then run:

```powershell
Invoke-RestMethod http://localhost:4174/healthz
```

Expected: a response with `ok` equal to `true`.

- [ ] **Step 5: Inspect final repository state**

Run: `git status --short --branch`

Expected: the branch is clean and ahead of its upstream only by the intentional design, plan, feature, and documentation commits.
