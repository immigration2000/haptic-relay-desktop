# Full Mockup UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 제공된 1180 x 780 목업의 전체 데스크톱 UI를 구현하면서 기존 실제 방·모션·하드웨어·보호 기능을 유지한다.

**Architecture:** `App.tsx`는 Electron IPC와 실제 세션 상태를 조정하고, `src/ui`의 화면 컴포넌트는 표시와 사용자 이벤트만 담당한다. 로그인·서버 프리셋·샘플 방은 데모 상태로 분리하고 실제 방 생성·입장·30Hz 전송은 기존 `window.hapticRelay` 경로를 그대로 사용한다.

**Tech Stack:** React 19, TypeScript 5.8, Electron 37, Vite 7, Lucide React, CSS, Chrome DevTools Protocol 기반 UI 자동 테스트

---

## File Structure

- Create `src/ui/model.ts`: 화면, 로그인, 서버, 샘플 방의 UI 타입과 순수 필터 함수
- Create `src/ui/demo-data.ts`: 국가별 서버와 샘플 방 데이터
- Create `src/ui/components/AppShell.tsx`: 공통 상단바·본문·하단 상태바
- Create `src/ui/components/Modal.tsx`: 접근 가능한 공통 모달
- Create `src/ui/components/StatusBadge.tsx`: Relay·Device·데모 상태 표현
- Create `src/ui/views/LoginView.tsx`: 데모 로그인 화면
- Create `src/ui/views/RoomBrowserView.tsx`: 검색·정렬·필터·방 카드
- Create `src/ui/views/RoomSessionView.tsx`: 호스트·참가자 공통 방 헤더와 탭
- Create `src/ui/views/HardwareView.tsx`: 기존 하드웨어 폼의 화면 컨테이너
- Create `src/ui/views/SafetyView.tsx`: 보호·긴급 정지 화면 컨테이너
- Create `src/ui/views/LogsView.tsx`: 로그 필터·내보내기 화면 컨테이너
- Modify `src/App.tsx`: 기존 IPC 동작을 새 화면 컴포넌트에 연결
- Replace `src/styles.css`: 목업 토큰과 반응형 앱 스타일
- Modify `scripts/electron-ui-smoke-test.mjs`: 로그인부터 실제 방·시연까지 전체 흐름 검증
- Modify `scripts/packaged-two-client-test.mjs`: 새 로그인·방 브라우저 흐름에서 2클라이언트 검증
- Modify `package.json`, `package-lock.json`: `lucide-react` 추가

---

### Task 1: UI Model And Demo Data

**Files:**
- Create: `src/ui/model.ts`
- Create: `src/ui/demo-data.ts`
- Modify: `scripts/electron-ui-smoke-test.mjs`

- [ ] **Step 1: Write the failing browser-flow assertion**

UI 스모크 테스트의 첫 화면 기대값을 기존 `방 만들기`에서 `로그인`으로 바꾸고, 로그인 후 `방 찾기`가 표시되는 단계를 추가한다.

```js
await waitForExpression(client, `document.body.innerText.includes('로그인')`);
await setInputByLabel(client, '아이디', 'user01');
await setInputByLabel(client, '비밀번호', 'demo-password');
await clickButton(client, '로그인');
await waitForExpression(client, `document.body.innerText.includes('방 찾기')`);
```

- [ ] **Step 2: Run the UI test to verify it fails**

Run: `npm.cmd run test:ui`

Expected: FAIL because the current app opens the role selector and has no login screen.

- [ ] **Step 3: Add typed UI models**

`src/ui/model.ts`에 아래 경계를 정의한다.

```ts
export type AppScreen = 'login' | 'browser' | 'host-room' | 'participant-room' | 'hardware' | 'safety' | 'logs';
export type RoomKind = 'demo' | 'live';
export type RoomFilter = 'all' | 'open' | 'request' | 'demo' | 'live';

export type RelayServerOption = {
  id: string;
  name: string;
  url: string;
  pingMs: number;
  available: boolean;
  custom?: boolean;
};

export type BrowserRoom = {
  id: string;
  kind: RoomKind;
  title: string;
  host: string;
  description: string;
  tags: string[];
  entryMode: 'open' | 'request';
  viewerCount: number;
  maxViewers: number;
  serverName: string;
  passwordProtected: boolean;
  updatedLabel: string;
};

export function filterRooms(rooms: BrowserRoom[], query: string, filter: RoomFilter) {
  const normalized = query.trim().toLowerCase();
  return rooms.filter(room => {
    const matchesFilter = filter === 'all' || room.entryMode === filter || room.kind === filter;
    const haystack = [room.title, room.host, room.description, ...room.tags].join(' ').toLowerCase();
    return matchesFilter && (!normalized || haystack.includes(normalized));
  });
}
```

- [ ] **Step 4: Add immutable demo data**

`src/ui/demo-data.ts`는 10개 서버 프리셋과 3개 샘플 방을 export한다. 샘플 방은 모두 `kind: 'demo'`이고 실제 릴레이 URL이나 토큰을 포함하지 않는다.

- [ ] **Step 5: Run type checking**

Run: `npm.cmd run lint`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/model.ts src/ui/demo-data.ts scripts/electron-ui-smoke-test.mjs
git commit -m "test(ui): define mockup navigation flow"
```

---

### Task 2: Design Tokens, Icons, And App Shell

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/ui/components/AppShell.tsx`
- Create: `src/ui/components/StatusBadge.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: Install the icon dependency**

Run: `npm.cmd install lucide-react@^0.468.0`

Expected: `lucide-react` appears under dependencies without changing unrelated packages.

- [ ] **Step 2: Implement connection status badges**

```tsx
import { CircleCheck, CircleOff } from 'lucide-react';

export function StatusBadge({ connected, label }: { connected: boolean; label: string }) {
  const Icon = connected ? CircleCheck : CircleOff;
  return <span className={`status-badge ${connected ? 'connected' : 'disconnected'}`}><Icon size={13} />{label}</span>;
}
```

- [ ] **Step 3: Implement AppShell**

`AppShell` props는 현재 서버, Relay·Device 상태, 사용자명, 현재 화면, 상태 메시지, 하드웨어·로그·로그아웃 이벤트와 `children`이다. 상단 58px, 본문 `minmax(0, 1fr)`, 하단 26px의 고정 3행 그리드를 사용한다.

- [ ] **Step 4: Replace global tokens and shell CSS**

`src/styles.css`의 루트 토큰은 목업의 회색 표면과 청회색 강조색을 사용한다.

```css
:root {
  font-family: "Barlow", "Segoe UI", sans-serif;
  color: #1d1f20;
  background: #f2f2f3;
  --surface: #f5f5f8;
  --surface-muted: #e7e7ea;
  --divider: rgb(29 31 32 / 16%);
  --accent: #5980a6;
  --accent-strong: #416180;
  --danger: #b42318;
}

.app-shell {
  width: 100%;
  height: 100vh;
  min-width: 0;
  display: grid;
  grid-template-rows: 58px minmax(0, 1fr) 26px;
  overflow: hidden;
}
```

- [ ] **Step 5: Verify the shell build**

Run: `npm.cmd run build`

Expected: PASS and renderer assets use relative paths.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/ui/components/AppShell.tsx src/ui/components/StatusBadge.tsx src/styles.css
git commit -m "feat(ui): add industrial desktop app shell"
```

---

### Task 3: Demo Login And Persistence

**Files:**
- Create: `src/ui/views/LoginView.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Test: `scripts/electron-ui-smoke-test.mjs`

- [ ] **Step 1: Implement LoginView as a controlled form**

```tsx
type LoginViewProps = {
  username: string;
  password: string;
  remember: boolean;
  error?: string;
  onUsernameChange(value: string): void;
  onPasswordChange(value: string): void;
  onRememberChange(value: boolean): void;
  onSubmit(): void;
};
```

폼 제출 시 두 값 중 하나라도 비어 있으면 `아이디와 비밀번호를 입력하세요`를 표시한다.

- [ ] **Step 2: Add login state to App**

저장 키는 `haptic-relay.demo-session.v1` 하나만 사용한다. 저장값은 `{ username, remembered: true }`이며 비밀번호를 저장하지 않는다. 로그아웃은 이 키를 제거하고 로그인 화면으로 돌아간다.

- [ ] **Step 3: Connect AppShell after login**

로그인 전에는 `LoginView`만 렌더링하고 로그인 후에는 `AppShell` 안에서 `RoomBrowserView` 자리 표시 콘텐츠를 렌더링한다.

- [ ] **Step 4: Run UI smoke test**

Run: `npm.cmd run test:ui`

Expected: login assertions pass and the test next fails at the not-yet-built room browser controls.

- [ ] **Step 5: Commit**

```bash
git add src/ui/views/LoginView.tsx src/App.tsx src/styles.css scripts/electron-ui-smoke-test.mjs
git commit -m "feat(ui): add local demo login flow"
```

---

### Task 4: Server Selector, Modal, And Room Browser

**Files:**
- Create: `src/ui/components/Modal.tsx`
- Create: `src/ui/views/RoomBrowserView.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Test: `scripts/electron-ui-smoke-test.mjs`

- [ ] **Step 1: Extend failing test for browser controls**

```js
await waitForExpression(client, `document.body.innerText.includes('현재 서버')`);
await waitForExpression(client, `document.body.innerText.includes('데모 데이터')`);
await setInputByPlaceholder(client, '방 이름, 소개, 태그 검색', '승인형');
await waitForExpression(client, `document.querySelectorAll('[data-room-card]').length === 1`);
```

- [ ] **Step 2: Implement accessible Modal**

`role="dialog"`, `aria-modal="true"`, 제목 연결, 배경 클릭 닫기, 내부 클릭 전파 차단, Escape 닫기를 제공한다.

- [ ] **Step 3: Implement RoomBrowserView**

RoomBrowserView는 `filterRooms` 결과를 표시하고 아래 이벤트만 상위로 전달한다.

```ts
type RoomBrowserViewProps = {
  rooms: BrowserRoom[];
  query: string;
  filter: RoomFilter;
  onQueryChange(value: string): void;
  onFilterChange(value: RoomFilter): void;
  onCreateRoom(): void;
  onJoinByInvite(): void;
  onOpenRoom(room: BrowserRoom): void;
};
```

- [ ] **Step 4: Implement server selection**

프리셋 선택은 표시 서버만 바꾸고, 사용자 지정 서버는 이름·URL을 입력해 실제 `relayUrl`을 변경한다. URL은 `https://` 또는 localhost·사설 IP의 `http://`만 허용한다.

- [ ] **Step 5: Add create-room and invite-code modals**

방 생성 모달은 기존 `createRoom`에 연결하고 초대 코드 모달은 기존 `applyInviteCode`와 `joinRoom`에 연결한다. 샘플 방은 실제 네트워크 호출 없이 데모 상세 상태를 연다.

- [ ] **Step 6: Run UI smoke test**

Run: `npm.cmd run test:ui`

Expected: login, search, filter, create modal, actual room creation and host room transition pass.

- [ ] **Step 7: Commit**

```bash
git add src/ui/components/Modal.tsx src/ui/views/RoomBrowserView.tsx src/App.tsx src/styles.css scripts/electron-ui-smoke-test.mjs
git commit -m "feat(ui): add server selector and room browser"
```

---

### Task 5: Host And Participant Session Views

**Files:**
- Create: `src/ui/views/RoomSessionView.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Test: `scripts/electron-ui-smoke-test.mjs`
- Test: `scripts/packaged-two-client-test.mjs`

- [ ] **Step 1: Define RoomSessionView slots**

```ts
type SessionTab = 'overview' | 'demo' | 'receive' | 'delay' | 'hardware' | 'safety' | 'logs';

type RoomSessionViewProps = {
  role: 'host' | 'participant';
  roomTitle: string;
  roomMeta: string;
  activeTab: SessionTab;
  tabs: Array<{ id: SessionTab; label: string }>;
  onTabChange(tab: SessionTab): void;
  onLeave(): void;
  children: React.ReactNode;
};
```

- [ ] **Step 2: Map existing host panels**

호스트 overview에는 초대 정보, 승인 대기, 참가자 목록을 배치한다. demo 탭에는 기존 `motionDemoPanel`을 넣고 `시연 시작`, 위치, 강도, 30Hz 상태 텍스트를 유지한다.

- [ ] **Step 3: Map existing participant panels**

participant receive에는 기존 `motionMonitorPanel`, delay에는 `motionDelayPanel`을 배치한다. 승인 대기 중에는 브라우저로 돌아가지 않고 대기 메시지를 표시한다.

- [ ] **Step 4: Update packaged two-client navigation**

테스트는 로그인 후 방 브라우저에서 방 생성 모달을 열고, 참가자 창은 초대 코드 모달 또는 직접 입장 모달을 통해 입장하도록 변경한다. 기존 검증 조건인 접속자 1명, 시연 30Hz, 반복 수신 프레임을 유지한다.

- [ ] **Step 5: Run local session tests**

Run: `npm.cmd run test:ui`

Expected: PASS.

Run: `npm.cmd run test:two-client`

Expected: PASS with `receivedFrames >= 5`.

- [ ] **Step 6: Commit**

```bash
git add src/ui/views/RoomSessionView.tsx src/App.tsx src/styles.css scripts/electron-ui-smoke-test.mjs scripts/packaged-two-client-test.mjs
git commit -m "feat(ui): connect host and participant room views"
```

---

### Task 6: Hardware, Safety, And Logs Views

**Files:**
- Create: `src/ui/views/HardwareView.tsx`
- Create: `src/ui/views/SafetyView.tsx`
- Create: `src/ui/views/LogsView.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Test: `scripts/electron-ui-smoke-test.mjs`

- [ ] **Step 1: Extract hardware presentation**

기존 포트 탐색, 연결·해제, baudrate, 축, stroke 범위, 방향 반전, 프로필 저장·불러오기 이벤트를 props로 전달한다. 실제 IPC 호출 함수는 `App.tsx`에 둔다.

- [ ] **Step 2: Extract safety presentation**

강도 상한, 위치 최소·최대, 수신 일시정지, 로컬 긴급 정지와 호스트 방 전체 정지를 분리한다. 위험 버튼은 `danger-action` 스타일과 `OctagonX` 아이콘을 사용한다.

- [ ] **Step 3: Extract logs presentation**

`all`, `relay`, `room`, `hardware`, `protection` 필터와 기존 로그 내보내기를 제공한다. 시간·분류·메시지·상세를 테이블로 표시하고 빈 필터 결과를 처리한다.

- [ ] **Step 4: Add global navigation actions**

상단 하드웨어 버튼은 room 밖에서는 전용 HardwareView, room 안에서는 hardware 탭으로 이동한다. 하단 상태 메시지는 기존 `AppStatus`를 그대로 표시한다.

- [ ] **Step 5: Verify all existing IPC controls remain reachable**

Run: `npm.cmd run test:electron`

Expected: preload, 설정 저장소, 안전한 창 메시지, 데모 스트림 테스트 모두 PASS.

Run: `npm.cmd run test:motion`

Expected: motion packet, sequence, delay buffer tests all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/views/HardwareView.tsx src/ui/views/SafetyView.tsx src/ui/views/LogsView.tsx src/App.tsx src/styles.css scripts/electron-ui-smoke-test.mjs
git commit -m "feat(ui): add hardware safety and log workspaces"
```

---

### Task 7: Responsive Layout And Visual Regression Checks

**Files:**
- Modify: `src/styles.css`
- Modify: `scripts/electron-ui-smoke-test.mjs`

- [ ] **Step 1: Add stable responsive constraints**

`@media (max-width: 1040px)`에서 상단 사용자 보조 문구를 숨기고 방 카드 열을 축소한다. `@media (max-width: 760px)`에서는 방 카드가 메타·본문 2열로 재배치되고 썸네일은 본문 상단으로 이동한다. `min-width`를 body나 AppShell에 두지 않는다.

- [ ] **Step 2: Add overflow assertions**

UI 스모크 테스트에서 1180 x 780과 960 x 640 두 viewport를 검증한다.

```js
const overflow = await client.evaluate(`({
  horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  vertical: document.documentElement.scrollHeight > document.documentElement.clientHeight
})`);
assert.equal(overflow.horizontal, false);
assert.equal(overflow.vertical, false);
```

- [ ] **Step 3: Capture required screenshots**

로그인, 방 브라우저, 방 생성 모달, 호스트 overview, 실시간 시연, 참가자 receive, 하드웨어, 보호, 로그 화면을 캡처한다.

- [ ] **Step 4: Run build and UI checks**

Run: `npm.cmd run lint`

Expected: PASS.

Run: `npm.cmd run test:ui`

Expected: PASS with screenshot paths and no overflow assertion failures.

- [ ] **Step 5: Commit**

```bash
git add src/styles.css scripts/electron-ui-smoke-test.mjs
git commit -m "fix(ui): make mockup workspace responsive"
```

---

### Task 8: Packaged And External Relay Verification

**Files:**
- Modify: `scripts/packaged-two-client-test.mjs`
- Modify: `docs/DESKTOP_DEMO_TEST_GUIDE.md`

- [ ] **Step 1: Run the complete local test suite**

Run: `npm.cmd run test:electron`

Expected: PASS.

Run: `npm.cmd run test:motion`

Expected: PASS.

Run: `npm.cmd run test:smoke`

Expected: all relay smoke assertions PASS.

Run: `npm.cmd run test:ui`

Expected: PASS.

- [ ] **Step 2: Build the unpacked app**

Run: `npm.cmd run electron:pack`

Expected: `release/win-unpacked/Haptic Relay.exe` is created.

- [ ] **Step 3: Run packaged two-client test locally**

Run: `npm.cmd run test:two-client`

Expected: host creates a room, participant joins, and repeated motion frames arrive.

- [ ] **Step 4: Run packaged two-client test through the phone relay**

```powershell
$env:RELAY_URL=(ssh -i "$env:USERPROFILE\.ssh\id_ed25519" -p 8022 u0_a870@192.168.219.108 'cat $HOME/haptic-relay-server/quick-tunnel-url.txt').Trim()
npm.cmd run test:two-client
```

Expected: the same workflow passes through `android-demo-1` without starting a local relay.

- [ ] **Step 5: Update the demo guide**

문서의 실행 흐름을 로그인 → 방 찾기 → 방 만들기/초대 코드 → 방 내부 탭 순서로 바꾸고 샘플 방이 데모 데이터임을 설명한다.

- [ ] **Step 6: Commit final verification changes**

```bash
git add scripts/packaged-two-client-test.mjs docs/DESKTOP_DEMO_TEST_GUIDE.md
git commit -m "docs: update full mockup UI test workflow"
```

---

## Final Review

- [ ] `git diff --check` reports no whitespace errors.
- [ ] `git status --short` contains only intentional files.
- [ ] No `.env`, token, tunnel URL, generated screenshot, or release artifact is staged.
- [ ] Login persistence does not store the password.
- [ ] Sample rooms cannot invoke real hardware or relay motion.
- [ ] Real room creation, invite entry, approval, moderation, 30Hz demo, delay, hardware, safety, and logs remain reachable.
- [ ] 1180 x 780 and 960 x 640 screenshots have no incoherent overlap or horizontal dragging.
