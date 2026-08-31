# Hardware Settings and Serial Output Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe visual 30–80% hardware range editor and a read-only native window for the current connection session's completed T-Code outputs.

**Architecture:** The Electron main process owns a bounded pure output-session store and a singleton native log window. A dedicated read-only preload exposes only snapshot and subscription APIs to a routed React log view. The main Hardware Settings renderer uses focused percentage/range helpers and components while preserving normalized settings and existing hardware lifecycle rules.

**Tech Stack:** Electron 43, React 19, TypeScript 5.8, Vite 7, Node `assert` regression scripts, existing CSS design system.

---

## File Map

### New files

- `electron/services/hardware-output-session-store.ts` — bounded current-connection output history.
- `electron/services/hardware-output-window-manager.ts` — testable singleton window ownership and focus behavior.
- `electron/hardware-output-log-preload.cts` — read-only preload for the native log window.
- `src/ui/hardware-settings-values.ts` — pure percentage/range conversion helpers.
- `src/ui/components/HardwareStrokeControl.tsx` — visual rail, dual-handle motion range, stop position, intensity limit, and advanced disclosure.
- `src/ui/views/HardwareOutputLogView.tsx` — read-only incremental output table and follow-latest behavior.
- `scripts/hardware-output-session-store-test.mjs` — output retention/session unit regression.
- `scripts/hardware-output-window-manager-test.mjs` — singleton native-window unit regression.
- `scripts/hardware-settings-values-test.mjs` — percentage and range invariant regression.
- `scripts/hardware-output-log-ui-test.mjs` — renderer/preload/source contract regression.

### Modified files

- `electron/protocol.ts` and `src/shared/protocol.ts` — identical log row/session payload types.
- `electron/main.ts` — store wiring, successful-ready reset, append broadcast, log-window creation, trusted IPC.
- `electron/preload.cts` — main-window `openHardwareOutputLog()` bridge only.
- `src/global.d.ts` — main and log-window preload API declarations.
- `src/main.tsx` — route `?view=hardware-output-log` to the dedicated view.
- `src/App.tsx` — 30–80 defaults, log action, and new hardware settings component.
- `src/ui/components/HardwareOutputMonitor.tsx` — text link beside the diagnostic title.
- `electron/app-settings.ts` — fresh-settings default 30–80% and stop 50%.
- `src/styles.css` — light industrial stroke card and native log-window styles.
- `scripts/app-settings-test.mjs` — fresh default regression without migration changes.
- `scripts/preload-format-test.mjs` — security and integration source assertions.
- `package.json` — add the four new Node regression scripts to `test:electron`.

## Task 1: Bounded Hardware Output Session Store

**Files:**
- Create: `electron/services/hardware-output-session-store.ts`
- Modify: `electron/protocol.ts`
- Modify: `src/shared/protocol.ts`
- Create: `scripts/hardware-output-session-store-test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add shared payload types**

Add the same definitions after `HardwareOutputSnapshot` in both protocol files:

```ts
export type HardwareOutputLogRow = HardwareOutputSnapshot & {
  id: number;
};

export type HardwareOutputLogSession = {
  sessionId: number;
  startedAt?: number;
  portPath?: string;
  rows: HardwareOutputLogRow[];
  omittedRows: number;
};
```

- [ ] **Step 2: Write the failing store test**

Create `scripts/hardware-output-session-store-test.mjs`:

```js
import assert from 'node:assert/strict';

const { HardwareOutputSessionStore } = await import('../dist-electron/services/hardware-output-session-store.js');

const store = new HardwareOutputSessionStore(3, () => 1_000);
assert.deepEqual(store.snapshot(), { sessionId: 0, rows: [], omittedRows: 0 });

assert.deepEqual(store.reset('COM3'), {
  sessionId: 1,
  startedAt: 1_000,
  portPath: 'COM3',
  rows: [],
  omittedRows: 0
});

for (let index = 0; index < 5; index += 1) {
  store.append({
    kind: 'motion',
    command: `L0${index}`,
    completedAt: 1_001 + index,
    portPath: 'COM3',
    baudRate: 115200
  });
}

const retained = store.snapshot();
assert.equal(retained.sessionId, 1);
assert.equal(retained.omittedRows, 2);
assert.deepEqual(retained.rows.map(row => row.id), [3, 4, 5]);
assert.deepEqual(retained.rows.map(row => row.command), ['L02', 'L03', 'L04']);

const snapshotCopy = store.snapshot();
snapshotCopy.rows.length = 0;
assert.equal(store.snapshot().rows.length, 3, 'callers cannot mutate store rows');

store.reset('COM4');
assert.deepEqual(store.snapshot(), {
  sessionId: 2,
  startedAt: 1_000,
  portPath: 'COM4',
  rows: [],
  omittedRows: 0
});

console.log('hardware output session store tests passed');
```

- [ ] **Step 3: Register and run the failing test**

Append `node scripts/hardware-output-session-store-test.mjs` immediately after `window-messenger-test.mjs` in `test:electron`.

Run:

```powershell
npm run build:electron
node scripts/hardware-output-session-store-test.mjs
```

Expected: FAIL because `dist-electron/services/hardware-output-session-store.js` does not exist.

- [ ] **Step 4: Implement the bounded store**

Create `electron/services/hardware-output-session-store.ts`:

```ts
import type {
  HardwareOutputLogRow,
  HardwareOutputLogSession,
  HardwareOutputSnapshot
} from '../protocol.js';

export const MAX_HARDWARE_OUTPUT_LOG_ROWS = 10_000;

export class HardwareOutputSessionStore {
  private sessionId = 0;
  private nextRowId = 1;
  private startedAt: number | undefined;
  private portPath: string | undefined;
  private rows: HardwareOutputLogRow[] = [];
  private omittedRows = 0;

  constructor(
    private readonly maxRows = MAX_HARDWARE_OUTPUT_LOG_ROWS,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isInteger(maxRows) || maxRows <= 0) throw new Error('invalid-hardware-output-log-limit');
  }

  reset(portPath: string) {
    this.sessionId += 1;
    this.nextRowId = 1;
    this.startedAt = this.now();
    this.portPath = portPath;
    this.rows = [];
    this.omittedRows = 0;
    return this.snapshot();
  }

  append(snapshot: HardwareOutputSnapshot) {
    const row: HardwareOutputLogRow = { id: this.nextRowId++, ...snapshot };
    this.rows.push(row);
    if (this.rows.length > this.maxRows) {
      const excess = this.rows.length - this.maxRows;
      this.rows.splice(0, excess);
      this.omittedRows += excess;
    }
    return { row: { ...row }, omittedRows: this.omittedRows };
  }

  snapshot(): HardwareOutputLogSession {
    return {
      sessionId: this.sessionId,
      ...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
      ...(this.portPath === undefined ? {} : { portPath: this.portPath }),
      rows: this.rows.map(row => ({ ...row })),
      omittedRows: this.omittedRows
    };
  }
}
```

- [ ] **Step 5: Run the store and Electron tests**

Run:

```powershell
npm run build:electron
node scripts/hardware-output-session-store-test.mjs
npm run test:electron
```

Expected: `hardware output session store tests passed`, then `hardware output tests passed`, exit code 0.

- [ ] **Step 6: Commit Task 1**

```powershell
git add electron/protocol.ts src/shared/protocol.ts electron/services/hardware-output-session-store.ts scripts/hardware-output-session-store-test.mjs package.json
git commit -m "feat(hardware): store bounded output sessions" -m "Constraint: retain only the newest 10000 completed outputs" -m "Confidence: high" -m "Scope-risk: narrow"
```

## Task 2: Singleton Read-Only Native Log Window

**Files:**
- Create: `electron/services/hardware-output-window-manager.ts`
- Create: `scripts/hardware-output-window-manager-test.mjs`
- Create: `electron/hardware-output-log-preload.cts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.cts`
- Modify: `src/global.d.ts`
- Modify: `scripts/preload-format-test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing singleton manager test**

Create `scripts/hardware-output-window-manager-test.mjs` with a fake window that records `show`, `focus`, and `closed`:

```js
import assert from 'node:assert/strict';

const { HardwareOutputWindowManager } = await import('../dist-electron/services/hardware-output-window-manager.js');

const created = [];
const manager = new HardwareOutputWindowManager(() => {
  const listeners = new Map();
  const sent = [];
  const window = {
    destroyed: false,
    shown: 0,
    focused: 0,
    sent,
    isDestroyed() { return this.destroyed; },
    show() { this.shown += 1; },
    focus() { this.focused += 1; },
    on(name, listener) { listeners.set(name, listener); },
    closeForTest() { this.destroyed = true; listeners.get('closed')?.(); },
    webContents: {
      isDestroyed: () => false,
      send: (...args) => sent.push(args)
    }
  };
  created.push(window);
  return window;
});

const first = manager.open();
assert.equal(created.length, 1);
assert.equal(manager.open(), first);
assert.equal(first.shown, 1);
assert.equal(first.focused, 1);
assert.equal(manager.send('hardware-output-log:append', { id: 1 }), true);
assert.deepEqual(first.sent, [['hardware-output-log:append', { id: 1 }]]);
first.closeForTest();
assert.equal(manager.send('hardware-output-log:append', { id: 2 }), false);
assert.notEqual(manager.open(), first);
assert.equal(created.length, 2);

console.log('hardware output window manager tests passed');
```

- [ ] **Step 2: Register and run the failing manager test**

Add the script after the session-store test in `test:electron`.

Run:

```powershell
npm run build:electron
node scripts/hardware-output-window-manager-test.mjs
```

Expected: FAIL because the manager module does not exist.

- [ ] **Step 3: Implement the manager**

Create `electron/services/hardware-output-window-manager.ts` with structural window types so the unit test does not load Electron:

```ts
type ManagedWindow = {
  isDestroyed(): boolean;
  show(): void;
  focus(): void;
  on(event: 'closed', listener: () => void): void;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  };
};

export class HardwareOutputWindowManager {
  private window: ManagedWindow | undefined;

  constructor(private readonly createWindow: () => ManagedWindow) {}

  open() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return this.window;
    }
    const window = this.createWindow();
    this.window = window;
    window.on('closed', () => {
      if (this.window === window) this.window = undefined;
    });
    return window;
  }

  send(channel: string, payload: unknown) {
    const window = this.window;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
    window.webContents.send(channel, payload);
    return true;
  }
}
```

- [ ] **Step 4: Add RED preload/security assertions**

Extend `scripts/preload-format-test.mjs` to read `dist-electron/hardware-output-log-preload.cjs` and assert:

```js
assert.match(logPreloadSource, /require\(['"]electron['"]\)/);
assert.doesNotMatch(logPreloadSource, /^\s*import\s/m);
assert.match(logPreloadSource, /contextBridge\.exposeInMainWorld\(['"]hapticOutputLog['"]/);
assert.match(logPreloadSource, /ipcRenderer\.invoke\(['"]hardware-output-log:get['"]\)/);
assert.match(logPreloadSource, /ipcRenderer\.on\(['"]hardware-output-log:reset['"]/);
assert.match(logPreloadSource, /ipcRenderer\.on\(['"]hardware-output-log:append['"]/);
for (const forbidden of ['hardware:connect', 'hardware:disconnect', 'hardware:test', 'hardware:send', 'app:copy-text']) {
  assert.doesNotMatch(logPreloadSource, new RegExp(forbidden.replace(':', '\\:')));
}
assert.match(preloadSource, /openHardwareOutputLog:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]hardware-output-log:open['"]\)/);
```

Run `npm run test:electron`.

Expected: FAIL because the dedicated preload and bridge methods do not exist.

- [ ] **Step 5: Add the read-only preload and declarations**

Create `electron/hardware-output-log-preload.cts`:

```ts
import { contextBridge, ipcRenderer } from 'electron';
import type { HardwareOutputLogRow, HardwareOutputLogSession } from './protocol.js';

type AppendPayload = { row: HardwareOutputLogRow; omittedRows: number };

contextBridge.exposeInMainWorld('hapticOutputLog', {
  getSession: (): Promise<HardwareOutputLogSession> => ipcRenderer.invoke('hardware-output-log:get'),
  onReset: (listener: (session: HardwareOutputLogSession) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, session: HardwareOutputLogSession) => listener(session);
    ipcRenderer.on('hardware-output-log:reset', handler);
    return () => ipcRenderer.removeListener('hardware-output-log:reset', handler);
  },
  onAppend: (listener: (payload: AppendPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AppendPayload) => listener(payload);
    ipcRenderer.on('hardware-output-log:append', handler);
    return () => ipcRenderer.removeListener('hardware-output-log:append', handler);
  }
});
```

Add this exact member to the existing `hapticRelay` bridge in `electron/preload.cts`:

```ts
openHardwareOutputLog: (): Promise<{ opened: true }> => ipcRenderer.invoke('hardware-output-log:open'),
```

Import the two output-log payload types and extend `src/global.d.ts` with:

```ts
interface Window {
  hapticOutputLog?: {
    getSession: () => Promise<HardwareOutputLogSession>;
    onReset: (listener: (session: HardwareOutputLogSession) => void) => () => void;
    onAppend: (listener: (payload: { row: HardwareOutputLogRow; omittedRows: number }) => void) => () => void;
  };
}
```

Add `openHardwareOutputLog: () => Promise<{ opened: true }>;` inside the existing `hapticRelay` object declaration rather than declaring a second incompatible object shape.

- [ ] **Step 6: Wire main-process store, window, and trusted IPC**

In `electron/main.ts`:

1. Create one `HardwareOutputSessionStore` and one `HardwareOutputWindowManager`.
2. In `onConnectionStatus`, call `outputSessionStore.reset(status.path)` only when `status.connected && status.path`, broadcast `hardware-output-log:reset`, then forward the normal connection status.
3. In `onOutput`, append the completed snapshot, broadcast `{ row, omittedRows }`, then forward the compact `hardware:output` event.
4. Build the native window at 900×640 with the dedicated preload, context isolation, sandbox, no Node integration, and the query `view=hardware-output-log` for either dev URL or packaged file.
5. Add trusted handlers:

Use these concrete wiring blocks:

```ts
const outputSessionStore = new HardwareOutputSessionStore();
const outputLogWindowManager = new HardwareOutputWindowManager(createHardwareOutputLogWindow);

const hardware = new HardwareController({
  onLog: entry => addLog(entry),
  onDiagnostic: routeHardwareDiagnostic,
  onOutput: snapshot => {
    const appended = outputSessionStore.append(snapshot);
    outputLogWindowManager.send('hardware-output-log:append', appended);
    sendToRenderer(mainWindow, 'hardware:output', snapshot);
  },
  onConnectionStatus: status => {
    if (status.connected && status.path) {
      const session = outputSessionStore.reset(status.path);
      outputLogWindowManager.send('hardware-output-log:reset', session);
    }
    sendToRenderer(mainWindow, 'hardware:connection-status', status);
  }
});

function createHardwareOutputLogWindow() {
  const window = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    title: 'Haptic Relay · 전체 출력 로그',
    webPreferences: {
      preload: path.join(__dirname, 'hardware-output-log-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  });
  const devServerUrl = getDevServerUrl();
  if (devServerUrl) {
    const url = new URL(devServerUrl);
    url.searchParams.set('view', 'hardware-output-log');
    void window.loadURL(url.toString());
  } else {
    void window.loadFile(path.join(__dirname, '../dist/index.html'), {
      query: { view: 'hardware-output-log' }
    });
  }
  return window;
}
```

```ts
ipcMain.handle('hardware-output-log:open', event => {
  assertTrustedSender(event);
  outputLogWindowManager.open();
  return { opened: true };
});

ipcMain.handle('hardware-output-log:get', event => {
  assertTrustedSender(event);
  return outputSessionStore.snapshot();
});
```

Do not clear the store in `hardware:connect`, `hardware:disconnect`, or any failure handler.

- [ ] **Step 7: Run focused and Electron tests**

```powershell
npm run build:electron
node scripts/hardware-output-window-manager-test.mjs
npm run test:electron
```

Expected: manager test passes; both preload files compile as CommonJS; all Electron tests exit 0.

- [ ] **Step 8: Commit Task 2**

```powershell
git add electron/services/hardware-output-window-manager.ts electron/hardware-output-log-preload.cts electron/main.ts electron/preload.cts src/global.d.ts scripts/hardware-output-window-manager-test.mjs scripts/preload-format-test.mjs package.json
git commit -m "feat(hardware): open read-only output log window" -m "Constraint: log window exposes no hardware mutation IPC" -m "Rejected: modal and general event-log reuse" -m "Confidence: high" -m "Scope-risk: moderate"
```

## Task 3: Output Log Renderer and Incremental Follow Behavior

**Files:**
- Create: `src/ui/views/HardwareOutputLogView.tsx`
- Create: `scripts/hardware-output-log-ui-test.mjs`
- Modify: `src/main.tsx`
- Modify: `src/styles.css`
- Modify: `package.json`

- [ ] **Step 1: Write the failing renderer contract test**

Create `scripts/hardware-output-log-ui-test.mjs` to read the source files and assert:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [mainSource, viewSource, stylesSource] = await Promise.all([
  readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/ui/views/HardwareOutputLogView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8')
]);

assert.match(mainSource, /searchParams\.get\(['"]view['"]\) === ['"]hardware-output-log['"]/);
assert.match(mainSource, /<HardwareOutputLogView\s*\/>/);
assert.match(viewSource, /window\.hapticOutputLog\?\.getSession\(\)/);
assert.match(viewSource, /onReset/);
assert.match(viewSource, /onAppend/);
assert.match(viewSource, /이전 .*개 생략됨/);
assert.match(viewSource, /최신 로그로 이동/);
assert.match(viewSource, /완료 시각/);
assert.match(viewSource, /명령/);
assert.match(stylesSource, /\.hardware-output-log-view/);

console.log('hardware output log UI tests passed');
```

Register it in `test:electron` and run it.

Expected: FAIL because the view does not exist.

- [ ] **Step 2: Implement the routed log view**

In `src/main.tsx`, render the dedicated view with this branch:

```tsx
import { HardwareOutputLogView } from './ui/views/HardwareOutputLogView';

const view = new URLSearchParams(window.location.search).get('view');
createRoot(rootElement).render(
  view === 'hardware-output-log' ? <HardwareOutputLogView /> : <App />
);
```

Implement `HardwareOutputLogView.tsx` around this complete state flow:

```tsx
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HardwareOutputLogSession } from '../../shared/protocol';
import '../../styles.css';

const EMPTY_SESSION: HardwareOutputLogSession = { sessionId: 0, rows: [], omittedRows: 0 };
const PAGE_SIZE = 500;
const MAX_ROWS = 10_000;
const FOLLOW_THRESHOLD_PX = 48;

export function HardwareOutputLogView() {
  const [session, setSession] = useState(EMPTY_SESSION);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [following, setFollowing] = useState(true);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const api = window.hapticOutputLog;
    if (!api) {
      setError('출력 로그 API를 사용할 수 없습니다.');
      return;
    }
    let active = true;
    const removeReset = api.onReset(next => {
      if (!active) return;
      setSession(next);
      setVisibleCount(PAGE_SIZE);
      setFollowing(true);
    });
    const removeAppend = api.onAppend(({ row, omittedRows }) => {
      if (!active) return;
      setSession(current => ({
        ...current,
        rows: [...current.rows, row].slice(-MAX_ROWS),
        omittedRows
      }));
    });
    void api.getSession().then(next => {
      if (active) setSession(next);
    }).catch(nextError => {
      if (active) setError(nextError instanceof Error ? nextError.message : String(nextError));
    });
    return () => {
      active = false;
      removeReset();
      removeAppend();
    };
  }, []);

  const rows = useMemo(
    () => session.rows.slice(Math.max(0, session.rows.length - visibleCount)),
    [session.rows, visibleCount]
  );

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (container && following) container.scrollTop = container.scrollHeight;
  }, [following, rows.length]);

  function updateFollowState() {
    const container = scrollRef.current;
    if (!container) return;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    setFollowing(distance <= FOLLOW_THRESHOLD_PX);
  }

  function followLatest() {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
    setFollowing(true);
  }

  return (
    <main className="hardware-output-log-view">
      <header className="hardware-output-log-header">
        <div><span>HARDWARE OUTPUT</span><h1>전체 출력 로그</h1></div>
        <p>{session.portPath ?? '연결 대기'} · 유지 {session.rows.length.toLocaleString()}개</p>
      </header>
      {session.omittedRows > 0 ? <p className="hardware-output-log-omitted">이전 {session.omittedRows.toLocaleString()}개 생략됨</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {session.rows.length > rows.length ? (
        <button type="button" onClick={() => setVisibleCount(count => Math.min(session.rows.length, count + PAGE_SIZE))}>이전 로그 더 보기</button>
      ) : null}
      <div className="hardware-output-log-table-wrap" ref={scrollRef} onScroll={updateFollowState}>
        <table className="hardware-output-log-table">
          <thead><tr><th>완료 시각</th><th>종류</th><th>명령</th><th>포트</th><th>Baudrate</th></tr></thead>
          <tbody>
            {rows.map(row => (
              <tr key={`${session.sessionId}-${row.id}`}>
                <td>{new Date(row.completedAt).toLocaleTimeString('ko-KR', { hour12: false })}</td>
                <td>{row.kind}</td><td><code>{row.command}</code></td><td>{row.portPath}</td><td>{row.baudRate}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && !error ? <p>완료된 직렬 출력이 없습니다.</p> : null}
      </div>
      {!following ? <button className="hardware-output-log-follow" type="button" onClick={followLatest}>최신 로그로 이동</button> : null}
    </main>
  );
}
```

During implementation, keep the same state transitions and labels; extract tiny formatting helpers only if TypeScript or lint requires it.

- an initial `getSession()` request guarded against unmount;
- reset and append subscriptions cleaned up on unmount;
- `visibleCount` initially 500 and a `이전 로그 더 보기` action that increases it by 500 up to retained count;
- rows sliced from `Math.max(0, rows.length - visibleCount)`;
- a scroll container ref and a near-bottom threshold of 48px;
- auto-scroll only while near the bottom;
- a fixed `최신 로그로 이동` button when follow is suspended;
- semantic table columns: 완료 시각, 종류, 명령, 포트, Baudrate;
- session/empty/error states.

Do not add copy, export, hardware control, or general app navigation.

- [ ] **Step 3: Add focused log-window styles**

Add the focused layout using concrete declarations equivalent to:

```css
.hardware-output-log-view { display: grid; grid-template-rows: auto auto auto minmax(0, 1fr); gap: 10px; height: 100vh; padding: 18px; background: var(--bg); color: var(--text); }
.hardware-output-log-header { display: flex; align-items: end; justify-content: space-between; gap: 16px; }
.hardware-output-log-header h1 { margin: 2px 0 0; font-size: 22px; }
.hardware-output-log-header span, .hardware-output-log-header p { color: var(--muted); font-size: 10px; }
.hardware-output-log-table-wrap { min-height: 0; overflow: auto; border: 1px solid var(--divider); background: var(--surface); }
.hardware-output-log-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.hardware-output-log-table th { position: sticky; top: 0; z-index: 1; padding: 8px; text-align: left; background: var(--surface-muted); }
.hardware-output-log-table td { padding: 7px 8px; border-top: 1px solid var(--divider); }
.hardware-output-log-table code { color: #274a64; font-size: 11px; }
.hardware-output-log-omitted { margin: 0; color: var(--warning); font-size: 10px; }
.hardware-output-log-follow { position: fixed; right: 24px; bottom: 24px; box-shadow: var(--shadow); }
```

- [ ] **Step 4: Run renderer and build verification**

```powershell
node scripts/hardware-output-log-ui-test.mjs
npm run lint
npm run build
```

Expected: UI test passes; TypeScript and Vite build exit 0; renderer asset paths remain relative.

- [ ] **Step 5: Commit Task 3**

```powershell
git add src/main.tsx src/ui/views/HardwareOutputLogView.tsx src/styles.css scripts/hardware-output-log-ui-test.mjs package.json
git commit -m "feat(ui): render live hardware output history" -m "Constraint: incrementally render at most the selected visible slice" -m "Confidence: high" -m "Scope-risk: moderate"
```

## Task 4: Percentage and Motion-Range Helpers

**Files:**
- Create: `src/ui/hardware-settings-values.ts`
- Create: `scripts/hardware-settings-values-test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing value-helper test**

Create `scripts/hardware-settings-values-test.mjs`:

```js
import assert from 'node:assert/strict';

const {
  clampPercent,
  normalizedToPercent,
  percentToNormalized,
  updateMotionRange
} = await import('../src/ui/hardware-settings-values.ts');

assert.equal(clampPercent(-5), 0);
assert.equal(clampPercent(105), 100);
assert.equal(normalizedToPercent(0.3), 30);
assert.equal(normalizedToPercent(0.805), 81);
assert.equal(percentToNormalized(80), 0.8);
assert.equal(percentToNormalized(Number.NaN), 0);

assert.deepEqual(
  updateMotionRange({ min: 30, max: 80, stop: 50 }, 'min', 70),
  { min: 70, max: 80, stop: 70 }
);
assert.deepEqual(
  updateMotionRange({ min: 30, max: 80, stop: 50 }, 'max', 40),
  { min: 30, max: 40, stop: 40 }
);
assert.deepEqual(
  updateMotionRange({ min: 30, max: 80, stop: 50 }, 'min', 95),
  { min: 79, max: 80, stop: 79 }
);

console.log('hardware settings value tests passed');
```

Register it in `test:electron` and run it.

Expected: FAIL because the helper module does not exist.

- [ ] **Step 2: Implement pure helpers**

Create `src/ui/hardware-settings-values.ts`:

```ts
export type MotionRangePercent = { min: number; max: number; stop: number };

export function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function normalizedToPercent(value: number) {
  return clampPercent(value * 100);
}

export function percentToNormalized(value: number) {
  return clampPercent(value) / 100;
}

export function updateMotionRange(
  current: MotionRangePercent,
  handle: 'min' | 'max',
  requested: number
): MotionRangePercent {
  const value = clampPercent(requested);
  const min = handle === 'min' ? Math.min(value, current.max - 1) : current.min;
  const max = handle === 'max' ? Math.max(value, current.min + 1) : current.max;
  return {
    min,
    max,
    stop: Math.max(min, Math.min(max, current.stop))
  };
}
```

- [ ] **Step 3: Run focused and type checks**

```powershell
node scripts/hardware-settings-values-test.mjs
npm run lint
```

Expected: helper test and TypeScript check pass.

- [ ] **Step 4: Commit Task 4**

```powershell
git add src/ui/hardware-settings-values.ts scripts/hardware-settings-values-test.mjs package.json
git commit -m "feat(ui): add hardware range value helpers" -m "Constraint: keep persisted settings normalized to 0 through 1" -m "Confidence: high" -m "Scope-risk: narrow"
```

## Task 5: Visual Stroke Control and Advanced Settings

**Files:**
- Create: `src/ui/components/HardwareStrokeControl.tsx`
- Modify: `src/App.tsx`
- Modify: `src/ui/components/HardwareOutputMonitor.tsx`
- Modify: `src/styles.css`
- Modify: `scripts/preload-format-test.mjs`

- [ ] **Step 1: Add failing source contract assertions**

Extend `scripts/preload-format-test.mjs` to read `HardwareStrokeControl.tsx` and assert:

```js
assert.match(hardwareOutputMonitorSource, /전체 로그 보기/);
assert.match(hardwareOutputMonitorSource, /openHardwareOutputLog/);
assert.match(hardwareStrokeControlSource, /스트로크 제어/);
assert.match(hardwareStrokeControlSource, /동작 범위/);
assert.match(hardwareStrokeControlSource, /강도 상한/);
assert.match(hardwareStrokeControlSource, /긴급 정지 위치/);
assert.match(hardwareStrokeControlSource, /<details/);
assert.match(hardwareStrokeControlSource, /고급 설정/);
assert.doesNotMatch(hardwareStrokeControlSource, /스크립트 진폭 자동 확장/);
assert.doesNotMatch(hardwarePanelSource, /className=['"]profile-grid['"]/);
```

Run `npm run test:electron`.

Expected: FAIL because the component and log action do not exist.

- [ ] **Step 2: Implement `HardwareStrokeControl`**

Give the component explicit props:

```ts
type HardwareStrokeControlProps = {
  profile: HardwareProfile;
  protection: HardwareProtection;
  profileDisabled: boolean;
  busy: boolean;
  settingsLoading: boolean;
  hasSavedSettings: boolean;
  onProfileChange: (patch: Partial<HardwareProfile>) => void;
  onProtectionChange: (patch: Partial<HardwareProtection>) => void;
  onApplyProtection: () => void;
  onSave: () => void;
  onLoad: () => void;
};
```

Use the Task 4 helpers to derive integer `min`, `max`, `stop`, and `intensity`. Render:

- a left 0–100 vertical visualization with CSS custom properties `--stroke-min` and `--stroke-max`;
- a right vertical stop range input bounded by min/max;
- summary text with selected width divided by 100 and optional `방향 반전`;
- two overlaid horizontal range inputs for min/max, each labelled for accessibility;
- a horizontal intensity range input and explicit `보호 옵션 적용` button;
- a closed `<details>` disclosure containing baudrate, axes, inversion, save, and load.

When either motion-range handle moves, call `updateMotionRange`, then send one profile patch containing all of `strokeMin`, `strokeMax`, and clamped `stopPosition`. Profile controls use `profileDisabled`; intensity and apply use only `busy`.

Create the component with this concrete structure (minor class-name extraction is allowed, but preserve the state flow and labels):

```tsx
import type { CSSProperties } from 'react';
import type { HardwareProfile, HardwareProtection } from '../../shared/protocol';
import {
  normalizedToPercent,
  percentToNormalized,
  updateMotionRange
} from '../hardware-settings-values';

type HardwareStrokeControlProps = {
  profile: HardwareProfile;
  protection: HardwareProtection;
  profileDisabled: boolean;
  busy: boolean;
  settingsLoading: boolean;
  hasSavedSettings: boolean;
  onProfileChange: (patch: Partial<HardwareProfile>) => void;
  onProtectionChange: (patch: Partial<HardwareProtection>) => void;
  onApplyProtection: () => void;
  onSave: () => void;
  onLoad: () => void;
};

export function HardwareStrokeControl(props: HardwareStrokeControlProps) {
  const min = normalizedToPercent(props.profile.strokeMin);
  const max = normalizedToPercent(props.profile.strokeMax);
  const stop = normalizedToPercent(props.profile.stopPosition);
  const intensity = normalizedToPercent(props.protection.intensityLimit);
  const railStyle = {
    '--stroke-min': `${min}%`,
    '--stroke-max': `${max}%`,
    '--stroke-stop': `${stop}%`
  } as CSSProperties;

  const changeRange = (handle: 'min' | 'max', value: number) => {
    const next = updateMotionRange({ min, max, stop }, handle, value);
    props.onProfileChange({
      strokeMin: percentToNormalized(next.min),
      strokeMax: percentToNormalized(next.max),
      stopPosition: percentToNormalized(next.stop)
    });
  };

  return (
    <section className="hardware-stroke-control">
      <h3>스트로크 제어 ({props.profile.linearAxis})</h3>

      <div className="stroke-visual-grid" style={railStyle}>
        <div className="stroke-rail" aria-label={`동작 범위 ${min}%에서 ${max}%`}>
          <span className="stroke-range-fill" />
          <span className="stroke-mark stroke-mark-max">{max}</span>
          <span className="stroke-mark stroke-mark-min">{min}</span>
        </div>
        <label className="stop-position-rail">
          긴급 정지 위치
          <input
            aria-label="긴급 정지 위치"
            type="range"
            min={min}
            max={max}
            step="1"
            value={stop}
            disabled={props.profileDisabled}
            onChange={event => props.onProfileChange({ stopPosition: percentToNormalized(Number(event.target.value)) })}
          />
          <output>{stop}%</output>
        </label>
      </div>

      <p className="stroke-summary">
        실제 {min}~{max}% · 중심 {stop}% · 원본 대비 {(max - min) / 100}배
        {props.profile.invertPosition ? ' · 방향 반전' : ''}
      </p>

      <fieldset className="motion-range-control" disabled={props.profileDisabled}>
        <legend>동작 범위</legend>
        <div className="dual-range">
          <input aria-label="동작 범위 최솟값" type="range" min="0" max="99" step="1" value={min} onChange={event => changeRange('min', Number(event.target.value))} />
          <input aria-label="동작 범위 최댓값" type="range" min="1" max="100" step="1" value={max} onChange={event => changeRange('max', Number(event.target.value))} />
        </div>
        <output>{min}%~{max}%</output>
      </fieldset>

      <label className="intensity-limit-control">
        <span>강도 상한</span>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={intensity}
          disabled={props.busy}
          onChange={event => props.onProtectionChange({ intensityLimit: percentToNormalized(Number(event.target.value)) })}
        />
        <output>{intensity}%</output>
      </label>
      <button type="button" disabled={props.busy} onClick={props.onApplyProtection}>보호 옵션 적용</button>

      <details className="hardware-advanced-settings">
        <summary>고급 설정</summary>
        <div className="profile-grid">
          <label>Baudrate
            <select value={props.profile.baudRate} disabled={props.profileDisabled} onChange={event => props.onProfileChange({ baudRate: Number(event.target.value) })}>
              {[9600, 57600, 115200, 230400, 460800].map(value => <option value={value} key={value}>{value}</option>)}
            </select>
          </label>
          <label>Stroke 축
            <input value={props.profile.linearAxis} disabled={props.profileDisabled} onChange={event => props.onProfileChange({ linearAxis: event.target.value.toUpperCase() })} />
          </label>
          <label>진동 축
            <input value={props.profile.vibrationAxis ?? ''} disabled={props.profileDisabled} placeholder="선택, 예: V0" onChange={event => props.onProfileChange({ vibrationAxis: event.target.value.toUpperCase() })} />
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={props.profile.invertPosition} disabled={props.profileDisabled} onChange={event => props.onProfileChange({ invertPosition: event.target.checked })} />
            방향 반전
          </label>
        </div>
        <div className="button-row">
          <button type="button" disabled={props.busy || props.settingsLoading || !props.hasSavedSettings} onClick={props.onSave}>설정 저장</button>
          <button type="button" disabled={props.profileDisabled || props.settingsLoading || !props.hasSavedSettings} onClick={props.onLoad}>설정 불러오기</button>
        </div>
      </details>
    </section>
  );
}
```

- [ ] **Step 3: Add the log action without changing the compact card**

Update `HardwareOutputMonitor` to render a text-style button beside `직렬 출력 진단` and call `window.hapticRelay.openHardwareOutputLog()`. Preserve the command block, success state, metadata grid, connection-reset behavior, and `aria-live` region.

Replace only the heading label with this wrapper; leave the status `<strong>` as its sibling:

```tsx
<span className="hardware-output-title">
  <span><Cable size={15} /> 직렬 출력 진단</span>
  <button
    type="button"
    className="text-action"
    onClick={() => void window.hapticRelay.openHardwareOutputLog().catch(error => {
      console.error('Failed to open hardware output log', error);
    })}
  >
    전체 로그 보기
  </button>
</span>
```

Handle a rejected open request locally by logging to `console.error`; the global status bar must not be replaced by a window-only failure.

- [ ] **Step 4: Replace only the lower profile grid in `App.tsx`**

Keep the port row and `<HardwareOutputMonitor connected={hardwareConnected} />` unchanged. Replace the profile grid and settings button row with:

```tsx
<HardwareStrokeControl
  profile={hardwareProfile}
  protection={hardwareProtection}
  profileDisabled={hardwareConnected || isBusy}
  busy={isBusy}
  settingsLoading={settingsLoading}
  hasSavedSettings={Boolean(savedSettings)}
  onProfileChange={updateHardwareProfile}
  onProtectionChange={updateHardwareProtection}
  onApplyProtection={() => void applyHardwareProtection()}
  onSave={() => void saveSettings()}
  onLoad={() => void loadSettings()}
/>
```

Do not remove the separate Protection view; both views continue to share the same `hardwareProtection` state.

- [ ] **Step 5: Add component styles**

Add styles for `.hardware-stroke-control`, `.stroke-visual-grid`, `.stroke-rail`, `.stroke-range-fill`, `.stop-position-rail`, `.motion-range-control`, `.dual-range`, `.intensity-limit-control`, `.hardware-advanced-settings`, and `.text-action`. Use the existing accent, divider, muted, surface, and danger variables. Add a single-column responsive layout inside the existing 760px media query.

Start from these declarations so the visual rail is display-only, while the horizontal range remains the editing control:

```css
.hardware-output-title { display: inline-flex; align-items: center; gap: 10px; }
.hardware-output-title > span { display: inline-flex; align-items: center; gap: 6px; }
.text-action { padding: 0; border: 0; background: transparent; color: var(--accent-strong); text-decoration: underline; cursor: pointer; }
.hardware-stroke-control { display: grid; gap: 14px; max-width: 720px; margin-top: 14px; padding: 18px; border: 1px solid var(--divider); border-radius: 10px; background: var(--surface); }
.stroke-visual-grid { display: grid; grid-template-columns: minmax(120px, 180px) minmax(120px, 180px); justify-content: center; gap: 46px; min-height: 250px; }
.stroke-rail { position: relative; width: 54px; height: 220px; margin: auto; border-radius: 22px; background: var(--surface-strong); }
.stroke-range-fill { position: absolute; left: 8px; right: 8px; bottom: var(--stroke-min); height: calc(var(--stroke-max) - var(--stroke-min)); border-radius: 18px; background: linear-gradient(180deg, #e7297d, #722cff); }
.stroke-mark { position: absolute; left: calc(100% + 12px); color: var(--muted); font-size: 11px; }
.stroke-mark-max { bottom: calc(var(--stroke-max) - 6px); }
.stroke-mark-min { bottom: calc(var(--stroke-min) - 6px); }
.stop-position-rail { display: grid; grid-template-rows: auto 1fr auto; justify-items: center; gap: 8px; }
.stop-position-rail input { width: 32px; height: 180px; writing-mode: vertical-lr; direction: rtl; }
.stroke-summary { text-align: center; color: var(--muted); }
.motion-range-control { display: grid; grid-template-columns: 1fr auto; gap: 8px 14px; min-width: 0; padding: 12px; border: 1px solid var(--divider); border-radius: 8px; }
.motion-range-control legend { padding: 0 5px; font-weight: 700; }
.dual-range { position: relative; min-height: 24px; }
.dual-range input { position: absolute; inset: 0; padding: 0; background: transparent; pointer-events: none; }
.dual-range input::-webkit-slider-thumb { pointer-events: auto; }
.intensity-limit-control { display: grid; grid-template-columns: auto minmax(180px, 1fr) 44px; align-items: center; gap: 12px; }
.intensity-limit-control input { padding: 0; }
.hardware-advanced-settings { border-top: 1px solid var(--divider); padding-top: 12px; }
.hardware-advanced-settings summary { cursor: pointer; font-weight: 700; }
.hardware-advanced-settings[open] summary { margin-bottom: 12px; }
@media (max-width: 760px) {
  .stroke-visual-grid { grid-template-columns: 1fr; gap: 24px; }
  .intensity-limit-control { grid-template-columns: 1fr auto; }
  .intensity-limit-control input { grid-column: 1 / -1; }
}
```

- [ ] **Step 6: Run focused, Electron, and renderer checks**

```powershell
npm run test:electron
npm run lint
npm run build
```

Expected: source contracts pass; existing hardware output and settings tests pass; production renderer builds.

- [ ] **Step 7: Commit Task 5**

```powershell
git add src/ui/components/HardwareStrokeControl.tsx src/ui/components/HardwareOutputMonitor.tsx src/App.tsx src/styles.css scripts/preload-format-test.mjs
git commit -m "feat(ui): redesign hardware stroke settings" -m "Constraint: preserve existing port controls and omit amplitude auto-expansion" -m "Confidence: high" -m "Scope-risk: moderate"
```

## Task 6: Fresh Default 30–80% Without Rewriting Saved Settings

**Files:**
- Modify: `electron/app-settings.ts`
- Modify: `src/App.tsx`
- Modify: `scripts/app-settings-test.mjs`

- [ ] **Step 1: Add the failing fresh-default assertions**

In `scripts/app-settings-test.mjs`, assert:

```js
assert.deepEqual(DEFAULT_SETTINGS.hardwareProfile, {
  baudRate: 115200,
  linearAxis: 'L0',
  vibrationAxis: undefined,
  strokeMin: 0.3,
  strokeMax: 0.8,
  stopPosition: 0.5,
  invertPosition: false
});
```

Keep the existing migration fixtures and add an assertion that a saved current-schema profile with `strokeMin: 0.1`, `strokeMax: 0.9`, and `stopPosition: 0.4` remains exactly those values after validation.

Run:

```powershell
npm run build:electron
node scripts/app-settings-test.mjs
```

Expected: FAIL because the fresh default is still 0–100%.

- [ ] **Step 2: Change only fresh defaults**

Set the default hardware profile in both `electron/app-settings.ts` and the renderer fallback in `src/App.tsx` to:

```ts
strokeMin: 0.3,
strokeMax: 0.8,
stopPosition: 0.5,
```

Do not increment the settings schema and do not mutate current-schema or migrated saved profiles.

- [ ] **Step 3: Run settings and full Electron tests**

```powershell
npm run build:electron
node scripts/app-settings-test.mjs
npm run test:electron
```

Expected: fresh default test passes; migration and all Electron tests remain green.

- [ ] **Step 4: Commit Task 6**

```powershell
git add electron/app-settings.ts src/App.tsx scripts/app-settings-test.mjs
git commit -m "feat(settings): default stroke range to 30 through 80" -m "Constraint: preserve every existing saved profile" -m "Confidence: high" -m "Scope-risk: narrow"
```

## Task 7: Full Verification and Packaged-App Acceptance

**Files:**
- Modify only if verification exposes a scoped defect.

- [ ] **Step 1: Run formatting and repository checks**

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; only intentional changes, or clean after task commits.

- [ ] **Step 2: Run all relevant automated suites fresh**

```powershell
npm run lint
npm run test:motion
npm run test:electron
npm run test:smoke
npm run test:security
npm run build
```

Expected: exit code 0; smoke summary 30/30; Electron output ends with `hardware output tests passed`.

- [ ] **Step 3: Package the application**

Close only the worktree's running unpacked client, then run:

```powershell
npm run electron:pack
```

Expected: exit code 0 and `release/win-unpacked/Haptic Relay.exe` rebuilt.

- [ ] **Step 4: Verify the native log window without hardware motion**

Launch the rebuilt unpacked app, open Hardware Settings, and click `전체 로그 보기` before connecting.

Expected:

- exactly one native output-log window opens;
- repeated clicks focus that same window;
- the empty state is visible;
- closing and reopening restores the same empty session.

- [ ] **Step 5: Verify settings behavior**

With hardware disconnected:

1. Confirm a clean settings directory displays 30–80 and stop 50.
2. Move the minimum to 40 and maximum to 70; confirm the vertical visualization and summary show 40–70.
3. Move stop to 65, then reduce maximum to 60; confirm stop clamps to 60.
4. Save, change values, reload, and confirm the saved normalized values return.
5. Connect COM hardware and confirm motion-range, stop, and advanced profile controls disable while intensity remains editable.

- [ ] **Step 6: Verify current-session output history with real COM hardware**

With the user ready to cut power:

1. Connect COM3 and wait for `hardware-ready`.
2. Run only the existing low-risk small-range test first.
3. Confirm each completed `test`/`motion`/`stop` output appears in chronological order with command, port, baudrate, and completion time.
4. Scroll upward, generate another safe output, and confirm auto-follow remains paused with `최신 로그로 이동` visible.
5. Disconnect and confirm rows remain.
6. Reconnect successfully and confirm the log resets to the new empty session before new output.

Do not repeat high-speed or full-range physical motion solely to test this UI feature.

- [ ] **Step 7: Final review and optional fix commit**

If acceptance reveals a defect, add one focused RED regression, implement the minimal fix, rerun the affected suite plus `npm run build`, and commit with a scoped `fix(...)` message. Otherwise do not create an empty commit.

- [ ] **Step 8: Record handoff state**

Update `C:/Users/user/AI_NOTES/logs/laptop.md` only after pulling that repository. Record commits, automated results, packaged-app behavior, and any unverified physical edge. Commit with the required message `note: desktop 작업 요약`, pull with rebase, and push.

Do not merge to `main` or create a release unless the user separately authorizes that deployment step.
