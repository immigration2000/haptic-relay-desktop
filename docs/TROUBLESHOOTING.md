# 트러블슈팅 및 로컬 테스트 기록

이 문서는 로컬 테스트 환경을 처음 구성하면서 확인한 절차, 실제로 발견한 결함, 재발을 막기 위한 유의사항을 남깁니다.

작업 기준: 2026-08-03, Node v24.12.0, npm 11.6.2, Windows 11.

## 1. 로컬 테스트 셋팅 절차

### 1.1 의존성 설치

```powershell
npm.cmd install
```

- 452개 패키지가 설치됩니다.
- 설치 후 아래 두 가지가 실제로 존재하는지 확인해야 합니다. 둘 중 하나라도 없으면 앱이 뜨지 않거나 하드웨어 검색이 실패합니다.
  - `node_modules/electron/dist/electron.exe` (Electron postinstall이 내려받는 런타임)
  - `node_modules/@serialport/bindings-cpp/prebuilds/win32-x64` (SerialPort 네이티브 바인딩)
- `npm install --ignore-scripts`로 설치하면 Electron postinstall이 돌지 않아 위 런타임이 없습니다. 샌드박스 환경에서 설치했던 흔적이 있다면 `node_modules`를 지우고 다시 설치합니다.

### 1.2 환경변수 파일

`.env.example`을 복사해 `.env`를 만듭니다. `.env`는 `.gitignore` 대상입니다.

`HAPTIC_CONTROL_TOKEN_SECRET`은 기본값(`change-me-before-production`)을 그대로 두지 말고 랜덤 값으로 채웁니다.

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 1.3 `.env`는 자동으로 로드되지 않습니다

코드베이스에는 `dotenv`도, `process.loadEnvFile`도 없습니다. 즉 `.env`를 만들어도:

- Vite는 `VITE_`로 시작하는 값만 읽습니다.
- **릴레이 서버 프로세스는 `.env`를 전혀 읽지 않습니다.**

로컬 테스트에서 `.env`를 서버에 적용하려면 `server:test` 스크립트를 사용합니다.

```powershell
npm.cmd run server:test
```

`server:dev`와 `server:start`는 배포 경로라 일부러 그대로 두었습니다. Node의 `--env-file`은 파일이 없으면 즉시 실패하므로, 이 두 스크립트에 붙이면 `.env`가 없는 환경에서 서버가 아예 기동하지 않습니다.

### 1.4 동작 확인

```powershell
npm.cmd run lint
npm.cmd run build
```

서버를 띄운 뒤 Control API와 fanout을 확인합니다.

```powershell
curl.exe -s http://localhost:4174/healthz
curl.exe -s -X POST http://localhost:4174/api/rooms -H "Content-Type: application/json" -d '{\"roomName\":\"test-room\",\"password\":\"test1234\",\"entryMode\":\"open\"}'
```

부하 테스트로 소켓 fanout까지 확인합니다.

```powershell
$env:VIEWERS=10; $env:HZ=30; $env:DURATION_MS=5000; npm.cmd run load:relay
```

`receiveRate`가 `1`이면 정상입니다. 확인 당시 10 viewers / 30Hz / 5초 조건에서 1500 프레임 전송, 1500 프레임 수신이었습니다.

## 2. 앱 창이 흰 화면으로 뜨던 문제

앱은 실행되고 창과 메뉴바까지 나오지만 내용이 완전히 비어 있었습니다. 원인은 하나가 아니라 **서로 독립적인 결함 4개**가 겹친 것이었고, 앞의 것을 고쳐야 뒤의 것이 드러나는 구조였습니다.

### 2.1 React를 마운트하는 코드가 없었음

`index.html`이 `/src/App.tsx`를 직접 로드했는데, 이 파일은 컴포넌트를 `export default` 하기만 하고 `createRoot(...).render(...)`를 어디서도 호출하지 않았습니다. 그래서 `#root`가 빈 채로 남았습니다.

- 수정: `src/main.tsx` 엔트리를 추가하고 `index.html`이 이 파일을 가리키게 변경.
- 판별 근거: 프로덕션 번들이 26.65 kB에서 436.90 kB로 커졌습니다. 그 전까지 `react-dom`이 번들에 포함된 적이 없었다는 뜻입니다.

### 2.2 preload가 로드되지 않아 `window.hapticRelay`가 undefined

`package.json`에 `"type": "module"`이 있어 `tsc`가 `preload.js`를 ESM으로 출력했습니다. **Electron은 `sandbox: true`인 창에서 ESM preload를 지원하지 않습니다.** preload가 조용히 실패해서 contextBridge가 아무것도 노출하지 못했고, 앱의 첫 effect가 `window.hapticRelay.getLogs()`에서 던지면서 React가 트리 전체를 언마운트했습니다.

- 수정: `electron/preload.ts` → `electron/preload.cts`로 확장자 변경(CommonJS `preload.cjs` 출력), `main.ts`의 preload 경로를 `preload.cjs`로 변경.
- `tsconfig.electron.json`의 `include`에 `electron/**/*.cts`를 추가해야 합니다. `electron/**/*.ts`만으로는 `.cts` 파일이 컴파일 대상에 잡히지 않습니다.
- `sandbox: true`는 그대로 유지했습니다. 보안 설정을 낮추는 방향으로 우회하지 않았습니다.
- 이 전환이 가능한 이유는 preload가 값으로 import하는 모듈이 `electron` 하나뿐이고, 나머지는 `import type`이라 컴파일 시 지워지기 때문입니다. preload에 ESM 전용 의존성을 새로 추가하면 이 구조가 깨집니다.

### 2.3 빌드 산출물이 `file://`에서 asset을 찾지 못함

Vite 기본 `base`는 `/`라서 빌드된 `index.html`이 `/assets/index-*.js`를 절대경로로 참조했습니다. 패키징된 앱은 `loadFile`로 `file://`에서 열리므로 이 경로가 앱 디렉터리 바깥을 가리키게 되어 스크립트가 아예 로드되지 않았습니다.

- 수정: `vite.config.ts`에 `base: './'`.
- 이 증상은 **콘솔에 예외가 남지 않습니다.** 스크립트 로드 실패는 네트워크 레벨 실패라 JS 예외가 아닙니다. 흰 화면인데 콘솔이 조용하면 이 경우를 먼저 의심해야 합니다.

### 2.4 CSP가 Vite dev preamble을 차단

`electron/main.ts`가 `onHeadersReceived`로 모든 응답에 CSP 헤더를 주입합니다. 그 안의 `script-src 'self'`가 Vite dev 서버의 react-refresh 인라인 preamble을 막아서, dev 경로에서만 `@vitejs/plugin-react can't detect preamble` 예외가 발생했습니다.

- 수정: `main.ts`에서 dev 서버 URL이 설정된 실행에 한해 `script-src`에 `'unsafe-inline'`, `default-src`에 `blob:`(HMR 재연결용 worker)을 허용. `vite.config.ts`의 dev 전용 플러그인이 `index.html`의 meta CSP도 같은 방식으로 완화.
- **패키징된 앱의 CSP는 바뀌지 않습니다.** 프로덕션 실행에서 렌더러가 받은 정책이 `script-src 'self'`이고 인라인 스크립트가 0개임을 확인했습니다.
- 함정: CSP가 두 군데(`index.html`의 meta 태그, `main.ts`의 응답 헤더)에 있습니다. 여러 CSP는 교집합으로 적용되므로 **한쪽만 고치면 증상이 그대로입니다.** 실제로 meta만 완화했을 때 차단이 계속됐고, 차단 메시지에 찍힌 정책 문자열이 meta의 내용과 다른 것을 보고 헤더 쪽을 찾아냈습니다.

## 3. 진단 방법: CDP로 렌더러 들여다보기

Electron 창은 스크린샷만으로는 원인을 알 수 없습니다. 원격 디버깅 포트를 열고 렌더러의 DOM, 콘솔, 예외, CSP 위반 로그를 직접 읽는 편이 훨씬 빠릅니다.

```powershell
npx electron . --remote-debugging-port=9222
```

Node 24에는 `WebSocket`이 내장되어 있어 별도 패키지 없이 붙을 수 있습니다.

```js
const targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json());
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
// Runtime.enable  -> Runtime.consoleAPICalled, Runtime.exceptionThrown
// Log.enable      -> Log.entryAdded (CSP 위반은 여기에 security/error로 들어옵니다)
// Page.reload     -> 위 이벤트를 처음부터 수집
// Runtime.evaluate-> document.getElementById('root').innerHTML.length 등
// Page.captureScreenshot -> 창 이미지를 파일로 저장
```

확인 포인트 순서:

1. `document.getElementById('root').innerHTML.length` — 0이면 마운트 실패
2. `typeof window.hapticRelay` — `undefined`면 preload 문제
3. `[...document.scripts]` — 스크립트가 실제로 로드됐는지, 경로가 맞는지
4. `Log.entryAdded`의 `security/error` — CSP 차단 여부와 **차단한 정책 문자열**

`Runtime.exceptionThrown`이 비어 있는데 화면이 비어 있다면 JS가 실행조차 안 된 것이므로 3번을 봅니다.

## 4. 유의사항

- **`sandbox: true`를 유지하는 한 preload는 CommonJS여야 합니다.** preload를 다시 `.ts`로 되돌리거나 ESM 전용 의존성을 넣으면 `window.hapticRelay`가 통째로 사라지고, 증상은 흰 화면입니다.
- **`vite.config.ts`의 `base: './'`를 지우면 패키징된 앱만 깨집니다.** dev 서버에서는 멀쩡히 보이므로 개발 중에는 눈치채기 어렵습니다. 렌더러 관련 변경 후에는 `npm run build` 결과를 `file://`로도 한 번 확인해야 합니다.
- **CSP를 손볼 때는 `index.html`의 meta와 `main.ts`의 헤더를 함께 봐야 합니다.** 완화는 dev 실행에만 적용되도록 유지하고, 패키징 경로의 정책은 낮추지 않습니다.
- **`.env`는 서버가 읽지 않습니다.** 로컬 테스트는 `server:test`를 쓰고, 배포에서는 컨테이너/프로세스 환경변수로 주입합니다.
- 앱 시작 직후 상태 문구가 `포트 확인 중`에 머무릅니다. `refreshPorts(true)`의 `silent` 분기가 완료 메시지를 의도적으로 갱신하지 않는 기존 동작이며, 포트 목록 자체는 정상적으로 채워집니다.
- `npm audit`에 high 2건이 있습니다. `electron@37`(해소하려면 43으로 breaking 업그레이드)과 `brace-expansion` DoS(`npm audit fix`로 해소 가능). 임의로 올리지 않았습니다.

## 5. 확인한 범위와 확인하지 못한 범위

확인함:

- `npm run lint`, `npm run build` 통과
- 릴레이 서버 기동, `/healthz`, `/metrics`
- Control API 방 생성 및 입장 토큰 발급
- 소켓 fanout 수신률 1.0
- dev 서버 경로와 `file://` 빌드 경로 양쪽에서 렌더러 마운트
- preload IPC를 통한 SerialPort 포트 목록 조회(실제 `COM1` 인식)

확인하지 못함:

- 실제 햅틱 장비 연결 및 T-Code 출력
- `electron:build` 패키징 산출물과 `release:check`
- Docker 이미지 빌드
- Redis registry 드라이버 경로
