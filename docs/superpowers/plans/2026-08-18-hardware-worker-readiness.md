# Hardware Worker Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a Windows build that drives a viewer T-Code device from the host's manual controls or repeating templates and shows the last serial command that completed successfully.

**Architecture:** Keep the existing 30Hz host-to-relay-to-viewer path. Add a successful-write callback at the `HardwareController` boundary, forward a typed snapshot through the sandboxed preload, and render it in a focused component whose local state prevents 30Hz updates from rerendering the full app. Do not add custom script playback or interpolation before the hardware session.

**Tech Stack:** Electron 37, React 19, TypeScript 5.8, SerialPort 13, Node.js test scripts, NSIS, Socket.IO.

---

## File Map

- `electron/services/tcode-encoder.ts`: pure T-Code command creation; behavior is characterized, not redesigned.
- `scripts/tcode-encoder-test.mjs`: focused encoder and probe regression coverage.
- `electron/services/hardware-controller.ts`: serial port ownership and successful-write reporting.
- `scripts/hardware-output-test.mjs`: fake serial port coverage for successful, failed, and stop writes.
- `electron/protocol.ts` and `src/shared/protocol.ts`: shared `HardwareOutputSnapshot` contract.
- `electron/main.ts`, `electron/preload.cts`, and `src/global.d.ts`: secure one-way output event bridge.
- `src/ui/components/HardwareOutputMonitor.tsx`: locally subscribed diagnostic display.
- `src/App.tsx` and `src/styles.css`: existing hardware panel integration and stable responsive styling.
- `scripts/preload-format-test.mjs` and `scripts/electron-ui-smoke-test.mjs`: bridge and visible UI coverage.
- `docs/HARDWARE_SESSION_CHECKLIST.md`, `README.md`, and `docs/ROADMAP.md`: on-site procedure and status.
- `package.json` and `package-lock.json`: test scripts and `0.1.1-demo.4` release version.

## Task 1: Characterize T-Code Encoding

**Files:**
- Create: `scripts/tcode-encoder-test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add focused encoder assertions**

Create `scripts/tcode-encoder-test.mjs`:

```js
import assert from 'node:assert/strict';

const encoder = await import('../dist-electron/services/tcode-encoder.js');

const frame = (position, intensity) => ({ position, intensity, timestamp: 1_786_000_000_000 });

assert.equal(
  encoder.encodeTCodeMotion(frame(0.5, 0.25), { linearAxis: 'L0', intervalMs: 16 }),
  'L05000I16\n'
);
assert.equal(
  encoder.encodeTCodeMotion(frame(-1, 2), { linearAxis: 'l0', vibrationAxis: 'v0', intervalMs: 16.4 }),
  'L00000I16 V09999\n'
);
assert.equal(
  encoder.encodeTCodeMotion(frame(1, 0), { linearAxis: 'R2', intervalMs: 33.6 }),
  'R29999I34\n'
);
assert.equal(
  encoder.encodeTCodeStop({ linearAxis: 'L0', vibrationAxis: 'V0', stopPosition: 0.2 }),
  'DSTOP\nL02000I1 V00000\n'
);
assert.equal(encoder.encodeTCodeProbe(), 'D1\nD2\n');
assert.deepEqual(
  encoder.parseTCodeProbe(['T-Code: v0.3', 'axes L0 R1 V0']),
  { detected: true, raw: ['T-Code: v0.3', 'axes L0 R1 V0'], version: 'v0.3', axes: ['L0', 'R1', 'V0'] }
);
assert.throws(
  () => encoder.encodeTCodeMotion(frame(0.5, 0.5), { linearAxis: 'X0' }),
  /invalid-tcode-axis/
);

console.log('tcode encoder tests passed');
```

- [ ] **Step 2: Register the test**

Append the command to `test:electron` after `demo-motion-pattern-test.mjs`:

```json
"test:electron": "npm run build:electron && node scripts/preload-format-test.mjs && node scripts/app-settings-test.mjs && node scripts/settings-file-store-test.mjs && node scripts/window-messenger-test.mjs && node scripts/demo-motion-stream-test.mjs && node scripts/demo-motion-pattern-test.mjs && node scripts/tcode-encoder-test.mjs"
```

- [ ] **Step 3: Run focused verification**

Run:

```powershell
npm.cmd run build:electron
node scripts/tcode-encoder-test.mjs
```

Expected: `tcode encoder tests passed` and exit code `0`.

- [ ] **Step 4: Commit**

```powershell
git add package.json scripts/tcode-encoder-test.mjs
git commit -m "test(hardware): characterize T-Code output" -m "Confidence: high" -m "Scope-risk: narrow" -m "Not-tested: Physical serial device"
```

## Task 2: Report Successful Serial Writes

**Files:**
- Modify: `electron/protocol.ts`
- Modify: `src/shared/protocol.ts`
- Modify: `electron/services/hardware-controller.ts`
- Create: `scripts/hardware-output-test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing controller test**

Create `scripts/hardware-output-test.mjs` with a fake port:

```js
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const { HardwareController } = await import('../dist-electron/services/hardware-controller.js');

class FakePort extends EventEmitter {
  constructor(path) {
    super();
    this.path = path;
    this.isOpen = false;
    this.writes = [];
    this.failNextWrite = false;
  }

  open(callback) {
    this.isOpen = true;
    callback(null);
  }

  close(callback) {
    this.isOpen = false;
    callback(null);
  }

  write(payload, callback) {
    this.writes.push(payload);
    const error = this.failNextWrite ? new Error('serial-write-failed') : null;
    this.failNextWrite = false;
    queueMicrotask(() => callback(error));
    return true;
  }
}

const outputs = [];
const logs = [];
const port = new FakePort('COM9');
const controller = new HardwareController({
  onLog: entry => logs.push(entry),
  onOutput: output => outputs.push(output),
  createPort: () => port,
  probeTimeoutMs: 0
});

await controller.connect('COM9', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});

controller.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() });
await delay(50);
assert.equal(outputs.length, 1);
assert.deepEqual(outputs[0], {
  kind: 'motion',
  command: 'L05000I16',
  completedAt: outputs[0].completedAt,
  portPath: 'COM9',
  baudRate: 115200
});
assert.ok(Number.isFinite(outputs[0].completedAt));

port.failNextWrite = true;
controller.queueMotion({ position: 0.7, intensity: 0.25, timestamp: Date.now() });
await delay(50);
assert.equal(outputs.length, 1, 'failed writes do not report successful output');
assert.ok(logs.some(entry => entry.message === 'hardware-motion-write-failed'));

await controller.emergencyStop();
assert.equal(outputs.at(-1).kind, 'stop');
assert.match(outputs.at(-1).command, /^DSTOP\nL00000I1$/);

await controller.disconnect();
console.log('hardware output tests passed');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npm.cmd run build:electron
node scripts/hardware-output-test.mjs
```

Expected: FAIL because the current constructor does not accept the dependency object and no output snapshot is emitted.

- [ ] **Step 3: Add the shared output contract**

Add the same type to `electron/protocol.ts` and `src/shared/protocol.ts`:

```ts
export type HardwareOutputSnapshot = {
  kind: 'motion' | 'test' | 'stop';
  command: string;
  completedAt: number;
  portPath: string;
  baudRate: number;
};
```

- [ ] **Step 4: Add injectable controller dependencies**

In `electron/services/hardware-controller.ts`, define the minimal adapter and options:

```ts
type HardwarePort = Pick<SerialPort, 'path' | 'isOpen' | 'open' | 'close' | 'write' | 'once' | 'on' | 'off'>;

type HardwareControllerOptions = {
  onLog?: (entry: HardwareLog) => void;
  onOutput?: (snapshot: HardwareOutputSnapshot) => void;
  createPort?: (options: { path: string; baudRate: number; autoOpen: false }) => HardwarePort;
  probeTimeoutMs?: number;
};
```

Replace the constructor and port creation with:

```ts
private port: HardwarePort | undefined;

constructor(private readonly options: HardwareControllerOptions = {}) {}

const createPort = this.options.createPort ?? (options => new SerialPort(options));
this.port = createPort({ path: pathName, baudRate: this.profile.baudRate, autoOpen: false });
```

Replace `this.onLog` calls with `this.options.onLog` and use `this.options.probeTimeoutMs ?? TCODE_PROBE_TIMEOUT_MS` in the probe wait.

- [ ] **Step 5: Emit only completed writes**

Add this helper:

```ts
private reportOutput(kind: HardwareOutputSnapshot['kind'], payload: string) {
  if (!this.port) return;
  this.options.onOutput?.({
    kind,
    command: payload.trim(),
    completedAt: Date.now(),
    portPath: this.port.path,
    baudRate: this.profile.baudRate
  });
}
```

Call it only after successful `await this.writePayload(payload)` operations:

```ts
await this.writePayload(payload);
this.reportOutput('test', payload);
```

```ts
await this.writePayload(payload);
this.reportOutput('stop', payload);
```

Use `try/catch/finally` in `flushLatest()` so motion reports only on success and `writing` always returns to `false`:

```ts
try {
  await this.writePayload(payload);
  this.reportOutput('motion', payload);
} catch (error) {
  console.error('hardware write failed', error);
  this.options.onLog?.({ level: 'error', source: 'hardware', message: 'hardware-motion-write-failed', details: formatError(error) });
} finally {
  this.writing = false;
  if (this.latestFrame) this.scheduleFlush();
}
```

Replace `writePayload` so success is determined only by the SerialPort write callback. Do not resolve early from the stream's `drain` event because that can race a later callback error:

```ts
private writePayload(payload: string) {
  return new Promise<void>((resolve, reject) => {
    if (!this.port?.isOpen) {
      reject(new Error('hardware-not-connected'));
      return;
    }

    this.port.write(payload, error => (error ? reject(error) : resolve()));
  });
}
```

- [ ] **Step 6: Register and run the test**

Append `node scripts/hardware-output-test.mjs` to `test:electron`, then run:

```powershell
npm.cmd run test:electron
```

Expected: both `tcode encoder tests passed` and `hardware output tests passed`.

- [ ] **Step 7: Commit**

```powershell
git add electron/protocol.ts src/shared/protocol.ts electron/services/hardware-controller.ts scripts/hardware-output-test.mjs package.json
git commit -m "feat(hardware): report completed T-Code writes" -m "Constraint: Diagnostics must reflect successful serial callbacks, not queued intent." -m "Confidence: high" -m "Scope-risk: moderate" -m "Not-tested: Physical serial device"
```

## Task 3: Bridge Output Diagnostics Securely

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/preload.cts`
- Modify: `src/global.d.ts`
- Modify: `scripts/preload-format-test.mjs`

- [ ] **Step 1: Add failing bridge assertions**

Add to `scripts/preload-format-test.mjs`:

```js
assert.match(preloadSource, /onHardwareOutput:\s*\(listener/);
assert.match(preloadSource, /ipcRenderer\.on\(['"]hardware:output['"]/);
assert.match(preloadSource, /removeListener\(['"]hardware:output['"]/);
assert.match(mainSource, /new HardwareController\(\{[\s\S]*?onOutput:[\s\S]*?hardware:output/);
```

- [ ] **Step 2: Run the test to verify it fails**

```powershell
npm.cmd run build:electron
node scripts/preload-format-test.mjs
```

Expected: FAIL on the missing `onHardwareOutput` bridge.

- [ ] **Step 3: Forward successful output from main**

Import `HardwareOutputSnapshot` and replace controller construction in `electron/main.ts`:

```ts
const hardware = new HardwareController({
  onLog: entry => addLog(entry),
  onOutput: snapshot => sendToRenderer(mainWindow, 'hardware:output', snapshot)
});
```

- [ ] **Step 4: Add the sandboxed listener**

Import `HardwareOutputSnapshot` in `electron/preload.cts` and add:

```ts
onHardwareOutput: (listener: (snapshot: HardwareOutputSnapshot) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, snapshot: HardwareOutputSnapshot) => listener(snapshot);
  ipcRenderer.on('hardware:output', handler);
  return () => ipcRenderer.removeListener('hardware:output', handler);
},
```

Import the same type in `src/global.d.ts` and add:

```ts
onHardwareOutput: (listener: (snapshot: HardwareOutputSnapshot) => void) => () => void;
```

- [ ] **Step 5: Verify and commit**

```powershell
npm.cmd run test:electron
npm.cmd run lint
git add electron/main.ts electron/preload.cts src/global.d.ts scripts/preload-format-test.mjs
git commit -m "feat(electron): bridge hardware output diagnostics" -m "Constraint: Keep the renderer sandboxed and expose only typed one-way events." -m "Confidence: high" -m "Scope-risk: narrow"
```

Expected: both commands exit `0`.

## Task 4: Add the Focused Hardware Output Monitor

**Files:**
- Create: `src/ui/components/HardwareOutputMonitor.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Modify: `scripts/electron-ui-smoke-test.mjs`

- [ ] **Step 1: Create the locally subscribed component**

Create `src/ui/components/HardwareOutputMonitor.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Cable, CircleCheck } from 'lucide-react';
import type { HardwareOutputSnapshot } from '../../shared/protocol';

export function HardwareOutputMonitor({ connected }: { connected: boolean }) {
  const [output, setOutput] = useState<HardwareOutputSnapshot>();

  useEffect(() => window.hapticRelay.onHardwareOutput(setOutput), []);
  useEffect(() => {
    if (!connected) setOutput(undefined);
  }, [connected]);

  return (
    <section className="hardware-output-monitor" aria-live="polite">
      <div className="hardware-output-heading">
        <span><Cable size={15} /> 직렬 출력 진단</span>
        <strong className={output ? 'ok' : ''}>{output ? <CircleCheck size={14} /> : null}{output ? '출력 성공' : connected ? '출력 대기' : '장비 미연결'}</strong>
      </div>
      <code data-hardware-output>{output?.command ?? 'T-Code 출력이 완료되면 표시됩니다.'}</code>
      <dl>
        <div><dt>종류</dt><dd>{output?.kind ?? '-'}</dd></div>
        <div><dt>포트</dt><dd>{output?.portPath ?? '-'}</dd></div>
        <div><dt>속도</dt><dd>{output ? `${output.baudRate}` : '-'}</dd></div>
        <div><dt>완료 시각</dt><dd>{output ? new Date(output.completedAt).toLocaleTimeString('ko-KR', { hour12: false }) : '-'}</dd></div>
      </dl>
    </section>
  );
}
```

- [ ] **Step 2: Mount it only in the existing hardware panel**

Import `HardwareOutputMonitor` in `src/App.tsx` and place this after `.hardware-row`:

```tsx
<HardwareOutputMonitor connected={hardwareConnected} />
```

- [ ] **Step 3: Add stable styles**

Add to `src/styles.css`:

```css
.hardware-output-monitor { display: grid; gap: 8px; min-height: 116px; padding: 10px; border: 1px solid var(--divider); background: var(--surface-muted); }
.hardware-output-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.hardware-output-heading span, .hardware-output-heading strong { display: inline-flex; align-items: center; gap: 5px; font-size: 9px; }
.hardware-output-heading strong { color: var(--muted); }
.hardware-output-heading strong.ok { color: var(--ok); }
.hardware-output-monitor code { min-height: 30px; padding: 8px; overflow: auto; background: #2b2b2d; color: #d6ebff; font-size: 10px; white-space: pre-wrap; }
.hardware-output-monitor dl { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 0; }
.hardware-output-monitor dt { color: var(--muted); font-size: 8px; }
.hardware-output-monitor dd { margin: 2px 0 0; overflow: hidden; text-overflow: ellipsis; font-size: 9px; font-weight: 800; white-space: nowrap; }
```

- [ ] **Step 4: Extend UI smoke coverage**

After opening the hardware page in `scripts/electron-ui-smoke-test.mjs`, add:

```js
await waitForExpression(cdp, `document.querySelector('[data-hardware-output]')?.textContent.includes('T-Code 출력이 완료되면 표시됩니다.')`);
await assertNoDocumentOverflow(cdp, '1180x780 hardware output monitor');
await cdp.call('Emulation.setDeviceMetricsOverride', { width: 960, height: 640, deviceScaleFactor: 1, mobile: false });
await assertNoDocumentOverflow(cdp, '960x640 hardware output monitor');
await captureScreenshot(cdp, path.join(outputDirectory, '08-hardware-output-960x640.png'));
await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1180, height: 780, deviceScaleFactor: 1, mobile: false });
```

Renumber later screenshots and the printed screenshot list consistently.

- [ ] **Step 5: Verify both viewports**

```powershell
npm.cmd run test:ui
npm.cmd run test:electron
npm.cmd run lint
```

Expected: all commands exit `0`; screenshots show no clipped command text, overlapping controls, or document overflow.

- [ ] **Step 6: Commit**

```powershell
git add src/ui/components/HardwareOutputMonitor.tsx src/App.tsx src/styles.css scripts/electron-ui-smoke-test.mjs
git commit -m "feat(ui): show successful T-Code output" -m "Constraint: Keep 30Hz diagnostics local to the hardware monitor component." -m "Confidence: high" -m "Scope-risk: narrow" -m "Not-tested: Physical serial device"
```

## Task 5: Write the On-Site Hardware Checklist

**Files:**
- Create: `docs/HARDWARE_SESSION_CHECKLIST.md`
- Modify: `README.md`
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Write the field procedure**

Create `docs/HARDWARE_SESSION_CHECKLIST.md` with these exact sections:

```markdown
# 하드웨어 작업자 현장 테스트

## 합격 목표
스트리머 수동 슬라이더와 삼각 반복 패턴이 릴레이를 거쳐 시청자 OSR/T-Code 장비를 움직이고, 긴급 정지가 즉시 동작해야 합니다.

## 초기 장비 설정
- 시청자 앱에서 장비 COM 포트를 선택합니다.
- Baudrate는 우선 `115200`, Stroke 축은 `L0`, 진동 축은 비워 둡니다.
- 최초 Stroke 범위는 `0.20-0.80`으로 제한합니다.
- 연결 후 `테스트`를 눌러 `0.2 -> 0.5 -> 0.8 -> 0.5 -> 정지`를 확인합니다.

## 릴레이 테스트
1. 스트리머가 자유입장 방을 생성합니다.
2. 시청자가 같은 서버와 방에 입장합니다.
3. 스트리머가 `수동` 시연을 시작하고 위치를 천천히 `0.2 -> 0.8 -> 0.2`로 이동합니다.
4. 시청자 수신값, 직렬 출력 진단의 `L0` 값, 실제 장비 위치가 함께 변하는지 확인합니다.
5. 수동 시연을 중지하고 `자동 패턴 > 삼각`, 주기 `3.0초`, 범위 `0.20-0.80`, 강도 `0.25`로 시작합니다.
6. 30초 동안 반복 움직임과 출력 진단을 확인합니다.
7. 스트리머 방 전체 긴급 정지와 시청자 로컬 긴급 정지를 각각 확인합니다.

## 실패 위치 판별
- 수신 모니터가 멈춤: 서버 URL, 방 입장, 릴레이 연결을 확인합니다.
- 수신값은 변하지만 출력 진단이 없음: COM 포트, 연결 상태, 보호 일시정지를 확인합니다.
- 출력 진단은 변하지만 장비가 멈춤: baudrate, 축, 펌웨어 T-Code 버전, 케이블과 전원을 확인합니다.
- 반대 방향으로 움직임: `방향 반전`을 적용합니다.
- 범위가 너무 큼: Stroke 최소·최대와 시청자 보호 범위를 더 좁힙니다.

## 기록할 값
장비 모델, 펌웨어, COM 포트, baudrate, 선형 축, 진동 축, 방향 반전, 안전 Stroke 범위, 성공한 T-Code 예시를 기록합니다.
```

- [ ] **Step 2: Link and mark status accurately**

Add the guide under the README document list. In `docs/ROADMAP.md`, add a pending item under Phase 1:

```markdown
- [ ] Physical OSR/T-Code end-to-end acceptance
```

Do not mark physical hardware complete before the worker signs off.

- [ ] **Step 3: Commit**

```powershell
git add docs/HARDWARE_SESSION_CHECKLIST.md README.md docs/ROADMAP.md
git commit -m "docs(hardware): add on-site acceptance checklist" -m "Constraint: Separate software verification from unverified physical movement." -m "Confidence: high" -m "Scope-risk: narrow"
```

## Task 6: Verify Phone Relay Coexistence Without Touching PULSE

**Files:**
- No repository files changed.

- [ ] **Step 1: Confirm SSH reachability**

Run from the PC:

```powershell
ssh -o StrictHostKeyChecking=no -p 8022 u0_a870@192.168.219.108 "printf 'ssh-ok\n'"
```

Expected: `ssh-ok`. If SSH is unavailable, start `sshd` manually in Termux and rerun once.

- [ ] **Step 2: Inspect only named processes and ports**

```powershell
ssh -o StrictHostKeyChecking=no -p 8022 u0_a870@192.168.219.108 "ps -ef | grep -E 'server/app.js|dist-server/server/src/relay-server.js|run syncra|4174' | grep -v grep; ss -ltn | grep -E ':4174|:5501'"
```

Expected: PULSE remains on `5501`; relay remains isolated on `4174`. Do not run `pkill -f node`, `pkill -f cloudflared`, or `pkill -f 'cloudflared tunnel'`.

- [ ] **Step 3: Check local relay health without restarting anything**

```powershell
ssh -o StrictHostKeyChecking=no -p 8022 u0_a870@192.168.219.108 "curl -fsS http://127.0.0.1:4174/healthz"
```

Expected: JSON containing `"ok":true`. If it fails, preserve PULSE and use the PC-local relay for the hardware session until the relay-specific phone startup command has been identified by process inspection.

- [ ] **Step 4: Preserve deployment secrets**

Do not copy Basic-auth credentials, Cloudflare credentials, tunnel IDs, `cert.pem`, JSON credentials, phone database files, or `node_modules` into this repository or any commit.

## Task 7: Build and Publish Demo 4

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docs/WINDOWS_INSTALL_GUIDE.md`
- Generate: `release/Haptic.Relay-0.1.1-demo.4-win-x64.exe`
- Generate: `release/Haptic.Relay-0.1.1-demo.4-win-x64.exe.sha256`

- [ ] **Step 1: Bump version without a tag**

```powershell
npm.cmd version 0.1.1-demo.4 --no-git-tag-version
```

Update `docs/WINDOWS_INSTALL_GUIDE.md` from Demo 3 to Demo 4 and add a link to `HARDWARE_SESSION_CHECKLIST.md`.

- [ ] **Step 2: Run the pre-release suite in small groups**

```powershell
npm.cmd run test:motion
npm.cmd run test:electron
npm.cmd run test:security
```

Then:

```powershell
npm.cmd run test:smoke
npm.cmd run test:ui
npm.cmd run build
```

Expected: every command exits `0`.

- [ ] **Step 3: Build installer and checksum**

```powershell
npm.cmd run electron:build
npm.cmd run release:check
Copy-Item -LiteralPath 'release\Haptic Relay-0.1.1-demo.4-win-x64.exe' -Destination 'release\Haptic.Relay-0.1.1-demo.4-win-x64.exe' -Force
$asset = Resolve-Path 'release\Haptic.Relay-0.1.1-demo.4-win-x64.exe'
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $asset).Hash.ToLowerInvariant()
$checksumPath = Join-Path (Split-Path -Parent $asset.Path) 'Haptic.Relay-0.1.1-demo.4-win-x64.exe.sha256'
[System.IO.File]::WriteAllText($checksumPath, "$hash  Haptic.Relay-0.1.1-demo.4-win-x64.exe", [System.Text.UTF8Encoding]::new($false))
```

- [ ] **Step 4: Verify unpacked and installed apps**

```powershell
$env:APP_EXECUTABLE = (Resolve-Path 'release\win-unpacked\Haptic Relay.exe').Path
npm.cmd run test:two-client
Remove-Item Env:APP_EXECUTABLE
```

Install silently and test the installed binary:

```powershell
Start-Process -FilePath (Resolve-Path 'release\Haptic.Relay-0.1.1-demo.4-win-x64.exe') -ArgumentList '/S' -WindowStyle Hidden -Wait
$env:APP_EXECUTABLE = "$env:LOCALAPPDATA\Programs\Haptic Relay\Haptic Relay.exe"
npm.cmd run test:two-client
Remove-Item Env:APP_EXECUTABLE
```

Expected: manual and automatic host/viewer flows pass and both processes close cleanly.

- [ ] **Step 5: Commit release metadata**

```powershell
git add package.json package-lock.json docs/WINDOWS_INSTALL_GUIDE.md
git commit -m "chore(release): prepare hardware readiness demo" -m "Constraint: Provide an installable build for the August 19 hardware session." -m "Confidence: high" -m "Scope-risk: narrow" -m "Not-tested: Physical OSR/T-Code movement remains the on-site acceptance step."
```

- [ ] **Step 6: Push, tag, and publish**

```powershell
git status -sb
git push origin feature/viewer-motion-delay-pr
git tag -a v0.1.1-demo.4 -m 'Haptic Relay v0.1.1 Demo 4'
git push origin v0.1.1-demo.4
gh release create v0.1.1-demo.4 'release/Haptic.Relay-0.1.1-demo.4-win-x64.exe' 'release/Haptic.Relay-0.1.1-demo.4-win-x64.exe.sha256' --verify-tag --title 'Haptic Relay v0.1.1 Demo 4' --notes 'Adds successful T-Code serial-output diagnostics and an on-site hardware acceptance workflow. Manual controls and repeating templates drive the existing viewer hardware output path.'
```

Expected: the release page contains both uploaded assets and reports the installer SHA-256 digest.
