# 데스크톱 무하드웨어 시연 설명서

이 설명서는 Windows PC 한 대에서 릴레이 서버와 Haptic Relay 앱 두 개를 실행해 스트리머에서 보낸 모션 값이 시청자 앱에 도착하는지 확인하는 절차입니다. OSR 또는 T-Code 하드웨어가 없어도 테스트할 수 있습니다.

## 1. 현재 테스트 범위

이 테스트로 다음 경로를 확인합니다.

```text
스트리머 모션 테스트 -> 로컬 릴레이 서버 -> 시청자 수신 파이프라인 -> 관리자 수신 모니터
```

현재 Windows 설치 파일에는 릴레이 서버를 자동 실행하는 기능이 포함되어 있지 않습니다. 따라서 기능 시연은 이 저장소를 내려받아 서버와 앱을 각각 실행하는 방식을 권장합니다.

## 2. 준비물

- Windows 10 또는 Windows 11
- Node.js `^20.19.0` 또는 `>=22.12.0`
- 인터넷 연결
- PowerShell 터미널 3개
- 하드웨어는 필요 없음

Node.js 설치 여부는 PowerShell에서 확인합니다.

```powershell
node --version
npm.cmd --version
```

두 명령이 버전을 출력해야 합니다.

## 3. 프로젝트 내려받기

### 방법 A: GitHub ZIP 다운로드

1. GitHub 저장소의 `feature/viewer-motion-delay-pr` 브랜치를 엽니다.
2. `Code` 버튼을 누릅니다.
3. `Download ZIP`을 선택합니다.
4. ZIP 파일을 원하는 폴더에 압축 해제합니다.
5. 압축을 해제한 폴더에서 PowerShell을 엽니다.

### 방법 B: Git 사용

```powershell
git clone --branch feature/viewer-motion-delay-pr https://github.com/immigration2000/haptic-relay-desktop.git
cd haptic-relay-desktop
```

## 4. 의존성 설치

프로젝트 폴더에서 실행합니다.

```powershell
npm.cmd install
```

`--ignore-scripts` 옵션을 사용하지 마십시오. Electron 실행 파일과 SerialPort 네이티브 모듈 설치 과정이 필요합니다.

설치가 끝나면 다음 파일이 존재하는지 확인합니다.

```powershell
Test-Path node_modules\electron\dist\electron.exe
```

결과가 `True`여야 합니다.

## 5. 릴레이 서버 실행

첫 번째 PowerShell에서 프로젝트 폴더로 이동한 뒤 실행합니다.

```powershell
npm.cmd run server:dev
```

이 터미널은 테스트가 끝날 때까지 닫지 않습니다. 다른 PowerShell에서 서버 상태를 확인할 수 있습니다.

```powershell
curl.exe http://localhost:4174/healthz
```

아래처럼 `ok`가 `true`이면 정상입니다.

```json
{"ok":true,"rooms":0,"relayNodes":1}
```

## 6. 데스크톱 앱 두 개 실행

두 번째 PowerShell에서 첫 번째 앱과 Vite 개발 서버를 실행합니다.

```powershell
npm.cmd run electron:dev
```

Haptic Relay 창이 열리고 `http://127.0.0.1:5173` 개발 서버가 준비될 때까지 기다립니다.

세 번째 PowerShell에서 두 번째 앱을 실행합니다.

```powershell
npm.cmd run electron:demo-client
```

화면에 `Haptic Relay` 창이 두 개 있어야 합니다.

## 7. 스트리머 방 만들기

첫 번째 Haptic Relay 창에서 진행합니다.

1. 왼쪽에서 `스트리머`를 선택합니다.
2. 서버 URL이 `http://localhost:4174`인지 확인합니다.
3. 방 이름을 입력합니다. 예: `studio-main`
4. 빠른 테스트를 위해 입장 방식을 `자유입장`으로 선택합니다.
5. `방 생성`을 누릅니다.
6. 생성된 방 이름과 비밀번호를 확인합니다.

하드웨어 포트는 선택하거나 연결하지 않아도 됩니다.

## 8. 시청자 방 입장

두 번째 Haptic Relay 창에서 진행합니다.

1. 왼쪽에서 `시청자`를 선택합니다.
2. 서버 URL이 `http://localhost:4174`인지 확인합니다.
3. 표시 이름을 입력합니다. 예: `viewer-01`
4. 스트리머 창과 같은 방 이름과 비밀번호를 입력합니다.
5. `입장 요청`을 누릅니다.
6. 상태 영역에 릴레이 연결 완료 메시지가 표시되는지 확인합니다.

## 9. 모션 전송 확인

1. 스트리머 창의 `모션 테스트`에서 위치와 강도 슬라이더를 조절합니다.
2. `시청자에게 전송`을 누릅니다.
3. 시청자 창의 `관리자 수신 모니터`를 확인합니다.

정상이라면 다음 항목이 갱신됩니다.

- 상태: `수신 중`
- 위치와 강도 숫자 및 게이지
- 프로토콜 버전과 시퀀스
- 누적 수신 프레임 수
- 마지막 수신 시각
- 최근 수신 프레임 목록
- 전달 상태: `가상 수신 정상 / 하드웨어 미연결`

위치와 강도는 패킷 양자화 때문에 스트리머 값과 약 `0.00002` 이내의 차이가 날 수 있습니다. 화면에 표시되는 소수점 둘째 자리 값은 같아야 합니다.

## 10. 100ms 지연 확인

시청자 창에서 진행합니다.

1. `모션 지연`을 `0.1초`로 설정합니다.
2. `적용`을 누릅니다.
3. 스트리머 창에서 모션을 다시 전송합니다.
4. 시청자 수신 모니터가 약 100ms 뒤에 갱신되는지 확인합니다.

## 11. 테스트 성공 기준

다음 조건을 모두 만족하면 시연 성공입니다.

- 스트리머가 방을 생성할 수 있음
- 시청자가 같은 방에 입장할 수 있음
- 스트리머가 전송할 때마다 시청자 누적 수신 수가 증가함
- 위치와 강도 값이 스트리머 입력과 일치함
- 최근 프레임 목록이 최신순으로 표시됨
- 하드웨어가 없어도 오류가 아닌 `가상 수신 정상` 상태가 표시됨
- 100ms 지연 적용 후에도 데이터가 손실되지 않고 도착함

## 12. 테스트 종료

1. Haptic Relay 창 두 개를 닫습니다.
2. `electron:dev` 터미널에서 `Ctrl+C`를 누릅니다.
3. `server:dev` 터미널에서 `Ctrl+C`를 누릅니다.

포트가 남아 있는지 확인하려면 실행합니다.

```powershell
Get-NetTCPConnection -LocalPort 4174,5173 -ErrorAction SilentlyContinue
```

## 13. 문제 해결

### 앱 창이 열리지 않음

```powershell
npm.cmd install
npm.cmd run build:electron
npm.cmd run electron:dev
```

`npm install --ignore-scripts`로 설치했다면 정상 설치 명령을 다시 실행합니다.

### 서버 연결 실패

```powershell
curl.exe http://localhost:4174/healthz
```

응답이 없으면 첫 번째 터미널의 `server:dev` 오류를 확인합니다. 다른 프로그램이 4174 포트를 사용하고 있는지도 확인합니다.

### 두 번째 앱이 열리지 않음

두 번째 터미널의 `electron:dev`가 계속 실행 중이고 `http://127.0.0.1:5173`이 열리는지 확인한 뒤 다시 실행합니다.

```powershell
npm.cmd run electron:demo-client
```

### 모니터 값이 갱신되지 않음

- 두 앱의 서버 URL과 방 이름이 같은지 확인합니다.
- 시청자 상태가 방 입장 완료인지 확인합니다.
- 스트리머 창에서 `시청자에게 전송`을 눌렀는지 확인합니다.
- 시청자 창의 이벤트 로그에서 릴레이 연결 상태를 확인합니다.

더 자세한 실행 문제는 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)를 참고합니다.

## 14. Windows 설치 파일 직접 만들기

개발 PC에서 NSIS 설치 파일을 생성하려면 실행합니다.

```powershell
npm.cmd run electron:build
npm.cmd run release:check
```

산출물은 `release` 폴더에 생성됩니다. 현재 설치 앱만으로는 릴레이 서버가 자동 실행되지 않으므로, 설치 파일 테스트 중에도 별도로 `npm.cmd run server:dev`를 실행하거나 배포된 릴레이 서버 주소를 입력해야 합니다.
