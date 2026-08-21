# Haptic Relay Desktop 개발 인계

이 문서는 새 Codex 채팅에서 현재 상태를 빠르게 복구하기 위한 정본 요약입니다. 작업을 시작하기 전에 이 파일과 프로젝트 루트의 `AGENTS.md`, `C:\Users\user\AI_NOTES\RULES.md`, `C:\Users\user\AI_NOTES\logs\laptop.md` 최신 항목을 함께 읽습니다.

## 1. 현재 기준점

- 작성 기준: 2026-08-21 KST
- 앱 저장소: `https://github.com/immigration2000/haptic-relay-desktop.git`
- 원격 정본 브랜치: `main`
- 원격 `main`/Demo 8 커밋: `488e42ce78630106f2445f472b7d55c669c5ae3b`
- 현재 노트북 최신 worktree: `C:\Users\user\Documents\Claude\Projects\haptic-relay-desktop\.worktrees\viewer-motion-delay-pr`
- 위 worktree 브랜치: `feature/viewer-motion-delay-pr`, 현재 `origin/main`과 같은 커밋
- 공개 릴레이: `https://relay.syncra.uk`

주의: `C:\Users\user\Documents\Claude\Projects\haptic-relay-desktop`의 로컬 `main`은 원격과 이력이 크게 갈라진 오래된 브랜치입니다. 사용자 확인 없이 reset, checkout 강제 덮어쓰기, force push를 하지 않습니다. 새 작업은 최신 worktree에서 하거나 `origin/main` 기준 새 worktree를 만듭니다.

## 2. 제품 목적

PandaTV 같은 외부 방송 플랫폼에서도 플랫폼 영상 시스템과 독립적으로 하드웨어 모션을 중계하는 Windows 데스크톱 앱입니다.

목표 흐름:

1. 스트리머가 외부 플랫폼에서 방송합니다.
2. 스트리머가 앱에서 릴레이 방을 만듭니다.
3. 시청자가 같은 앱으로 방을 찾거나 초대 코드로 입장합니다.
4. 스트리머의 모션이 별도 릴레이 서버를 거쳐 시청자 앱으로 전달됩니다.
5. 시청자 앱이 수신값을 OSR/SR6 계열 T-Code 장비에 출력합니다.

현재 중요한 제한: 스트리머 장비의 물리 움직임을 입력으로 읽는 기능은 아직 없습니다. 현재 스트리머 소스는 마우스 수동 위치/강도 조작과 내장 자동 패턴입니다. 시청자 쪽 SerialPort/T-Code 출력은 구현되어 있습니다.

## 3. 배포 상태

### Windows 앱

- 최신 릴리스: `v0.1.1-demo.8`
- 릴리스 페이지: `https://github.com/immigration2000/haptic-relay-desktop/releases/tag/v0.1.1-demo.8`
- EXE: `Haptic.Relay-0.1.1-demo.8-win-x64.exe`
- 크기: `95,668,856` bytes
- SHA-256: `1d2c5416e59fd5f592e1c037987929eb3514cf9898748fb4b5e8e2b40842f435`
- NSIS 설치/제거, ASAR, SerialPort 네이티브 모듈 패키징 검증 완료

### 외부 릴레이

2026-08-21 확인 결과:

- `https://relay.syncra.uk/healthz`: `ok=true`, relay node 1개
- `https://relay.syncra.uk/api/rooms`: 정상, 확인 시 열린 방 0개
- 앱 기본 서버도 `https://relay.syncra.uk`

휴대폰 Termux 서버의 마지막 배포 기록은 `~/haptic-relay-server-demo7`입니다. 재부팅 후에는 해당 디렉터리의 전용 `start.sh`와 `start-haptic-named-tunnel.sh`를 사용합니다. PID는 실행 때마다 달라지므로 이전 기록을 그대로 믿지 말고 스크립트와 `/healthz`로 확인합니다.

휴대폰에는 PULSE 등 다른 프로젝트도 함께 실행됩니다. `pkill -f node`, `pkill -f cloudflared` 같은 넓은 종료 명령은 금지입니다. `AI_NOTES/RULES.md`의 프로젝트별 포트와 전용 종료 규칙을 따릅니다.

Termux 프로필은 30Hz, 방당 50명 제한의 데모 설정입니다. 500명 운영 검증 결과로 간주하면 안 됩니다.

## 4. 현재 구현된 기능

### 방과 사용자 흐름

- 데모용 로컬 로그인. 실제 계정 서버 인증은 아직 없음
- 선택 서버의 실제 `GET /api/rooms` 방 목록과 3초 자동 갱신
- 서버 선택과 사용자 서버 URL 입력
- `현재 서버` 옆 상태 점: 확인 중 회색, 연결 성공 초록, 실패 빨강
- Electron main에서 `/healthz`를 5초마다 확인하고 실제 응답시간 표시
- 방 생성, 방 카드 입장, 초대 코드/QR 입장
- 자유입장과 신청입장
- 신청입장 승인/거절, 접속자 목록, 강퇴, 현재 방 세션 차단
- 명시적 `방 종료` 시 방 즉시 삭제
- 네트워크 단절/창 비정상 종료는 재접속을 위해 약 15초 유예
- 릴레이 재연결 후 host/viewer token으로 자동 재입장

Demo 8 UI 계약:

- 자유입장 방은 데스크톱 UI에서 비밀번호를 사용하지 않습니다.
- 자유입장 선택 시 비밀번호를 지우고 입력창을 비활성화하며 create/join 요청에도 보내지 않습니다.
- 신청입장에서는 비밀번호가 선택 사항입니다.
- 서버 API 자체는 이전 호환성을 위해 open+password 요청을 여전히 처리할 수 있으므로 UI와 서버 능력을 혼동하지 않습니다.

### 모션 전송

- 스트리머 수동 위치/강도 조작을 30Hz로 전송
- 내장 자동 패턴: sine, triangle, pulse, sawtooth
- 패턴 주기, 위치 최소/최대, 강도 실시간 변경
- 시작 시 300ms 진입 램프와 안전 중지
- 20-byte Motion Packet V2와 legacy 4-byte V1 수신 호환
- uint32 sequence 필터, 중복/역순 drop, 손실 추정, wraparound 처리
- latest-value coalescing, volatile fanout, token bucket 속도 제한
- 시청자 로컬 수신 지연 `0-10000ms`, `100ms` 단위
- 시청자 관리자 수신 모니터와 최근 프레임 10개
- 지연 구간 선형 보간은 아직 구현되지 않음

### 하드웨어 출력

- Electron main의 Node `serialport` 사용
- COM 포트 검색/연결/해제
- 기본 baud `115200`, 기본 선형 축 `L0`, 선택 진동 축
- stroke 범위, 방향 반전, 강도 상한, 위치 보호 범위, 수신 일시정지
- 연결 직후 `D1\nD2\n` capability probe
- 최대 60Hz 하드웨어 write, 쓰기 중 newest frame 하나만 유지
- 기본 1000ms 무수신 safety stop
- `DSTOP` 후 안전 위치 fallback
- 성공한 serial write의 T-Code, 시각, 포트, baud를 앱 내부 출력 모니터에 표시
- 로컬 장비 테스트 패턴과 앱/방 전체 긴급 정지

현재 데스크톱 encoder 예시:

```text
position 0.5, interval 17ms -> L05000I17\n
```

플랫폼 실기기 성공 기록은 `L0500I0100` 계열입니다. T-Code V3 가변 소수 길이 규칙이면 값은 같을 수 있으므로 자릿수만 보고 encoder를 바꾸지 않습니다. 같은 장비/펌웨어로 비교한 뒤 결정합니다. 플랫폼 쪽 실기기 성공 근거가 더 강합니다.

### 서버와 보안

- 현재 서버: TypeScript/Node.js + Socket.IO
- Control API와 Relay Node를 한 프로세스에서 실행하는 MVP 구조
- HMAC 서명 host/viewer token
- 방 생성/입장 rate limit, motion rate gate, 보호된 metrics
- in-memory/Redis room registry 경계
- motion frame은 Redis나 DB를 통과하지 않음
- 공개 방 목록에서 비밀번호, token, socket ID 등 비밀값 제거
- 장기 생산 구조는 Control API와 Go Relay Node 분리를 문서로 설계했지만 아직 구현하지 않음

개발 환경 부하 테스트 기록:

- 500명 x 30Hz x 10초: 100% 수신
- 500명 x 60Hz x 10초: 99.33% 수신
- 1000명 x 30Hz x 10초: 100% 수신

이 수치는 개발 PC/테스트 조건 결과입니다. 휴대폰 Termux나 실제 인터넷 500명 운영 보증이 아닙니다.

## 5. Demo 8에서 마지막으로 반영한 변경

- 모달이 렌더링될 때마다 첫 요소로 포커스를 되돌려 비밀번호를 한 글자씩만 입력할 수 있던 버그 수정
- 최신 `onClose`를 ref로 보관하고 포커스/키보드 effect는 모달 mount 시 한 번만 실행
- 선택 서버 실제 health 상태와 latency 표시
- 자유입장 비밀번호 입력/전송 비활성화
- 관련 Electron IPC, UI, 포커스, 자유입장 회귀 테스트 추가
- 버그 리포트 버튼은 사용자 요청으로 보류

## 6. 최우선 미완료 및 위험

### 해결됨. SerialPort write 미응답 시 조용한 영구 정지

2026-08-19 실기기 시연 조사에서 발견된 버그이며, 현재 작업 브랜치에서 수정했습니다. 기존 Demo 8 설치본에는 이 수정이 포함되지 않습니다.

- 모든 SerialPort write에 500ms bounded timeout을 적용했습니다.
- timeout 또는 포트 `error` 발생 시 연결을 fail-closed로 폐기하고 active write, timer, 최신 대기 frame을 정리합니다.
- 실패 후에는 명시적으로 재연결하기 전까지 추가 motion을 거부합니다.
- motion과 긴급정지 실패를 로그에 남기고, 긴급정지는 무한 대기하지 않고 실패 결과를 반환합니다.
- Node Writable처럼 active callback이 다음 write를 막는 fake port로 callback 미호출, 재연결 복구, 긴급정지 timeout, 포트 error 회귀를 검증합니다.

남은 확인:

1. 실제 OSR/T-Code 장비에서 write timeout, 케이블 단절, 재연결을 확인
2. probe 이후 SerialPort 수신 데이터를 계속 배수할 필요가 있는지 실기기로 확인
3. 수정이 포함된 새 설치본을 빌드한 뒤 양쪽 PC에서 재검증

공유 노트는 `scripts/hardware-write-stall-repro.mjs`가 로컬 `study/annotated` 브랜치에 있었다고 기록하지만, 2026-08-21 현재 이 checkout과 전체 Projects 검색에서는 해당 파일을 찾지 못했습니다. 새 채팅은 파일이 있다고 가정하지 말고 다른 clone/worktree를 찾거나 테스트를 재작성해야 합니다.

### P0. 실기기 종단 합격 미완료

- 실제 OSR/T-Code 장비에서 Demo 8 전체 흐름을 공식 합격 처리하지 못했습니다.
- 최초 테스트는 baud `115200`, `L0`, stroke `0.20-0.80`으로 제한합니다.
- write 성공 UI는 OS가 write를 수락했다는 의미일 뿐 실제 장비 동작 증거가 아닙니다.
- `D1` 응답 유무, 실제 위치, 앱 수신값, 출력 T-Code를 함께 기록합니다.

### 기능 미완료

- 스트리머 물리 장비 움직임 입력/캡처
- 사용자 제작 스크립트 작성 및 재생
- 동작 녹화 후 재생
- viewer 지연 구간 선형 보간
- 자동 업데이트
- 실제 계정 인증/과금/영구 제재
- 버그 리포트 자동 전송 또는 진단 패키지 저장
- macOS 배포와 코드 서명
- Go production relay

## 7. 검증 상태

Demo 8과 `main` 반영 전에 통과한 항목:

- `npm run test:electron`
- `npm run test:smoke`: 24/24
- `npm run test:ui`
- `npm run electron:build`
- `npm run release:check`

UI 테스트는 로그인, 실제 방 목록, 방 생성, 자유입장 비밀번호 비활성화, 입력 포커스 유지, 서버 health 초록 점, 수동 시연, 자동 패턴, 하드웨어 출력 모니터, 보호 설정, 로그, 960x640/1180x780 overflow를 확인합니다.

미검증:

- SerialPort callback stall 수정, 아직 수정 자체가 없음
- 실제 OSR 장비에서 Demo 8 장시간 반복
- 휴대폰 릴레이 500명 실부하
- 외부 모바일망 장시간 reconnect/화면 꺼짐/재부팅 내구성

## 8. 새 채팅 작업 시작 절차

```powershell
cd C:\Users\user\Documents\Claude\Projects\haptic-relay-desktop\.worktrees\viewer-motion-delay-pr
git fetch origin
git status -sb
git log -1 --oneline --decorate
```

기대 기준은 `488e42c`이며, 이후 원격에 새 커밋이 있으면 `origin/main`을 먼저 확인합니다. 로컬 `main`이 아니라 원격 최신성을 기준으로 판단합니다.

공유 노트 확인:

```powershell
git -C C:\Users\user\AI_NOTES status -sb
git -C C:\Users\user\AI_NOTES pull --rebase
```

AI_NOTES가 dirty하면 pull/reset하지 말고 사용자에게 보고합니다. 토큰, 비밀번호, Cloudflare credentials, `.env` 값은 문서나 커밋에 넣지 않습니다.

외부 서버 확인:

```powershell
curl.exe https://relay.syncra.uk/healthz
curl.exe https://relay.syncra.uk/api/rooms
```

주요 검증:

```powershell
npm.cmd run test:electron
npm.cmd run test:smoke
npm.cmd run test:ui
```

설치 파일 생성:

```powershell
npm.cmd run electron:build
npm.cmd run release:check
```

## 9. 권장 다음 작업 순서

1. 실제 OSR 장비로 수동, 삼각 반복, 시연 중지 후 재시작, 긴급정지, write timeout/케이블 단절/재연결 확인
2. 수정이 포함된 설치본을 빌드하고 PC와 노트북에서 `https://relay.syncra.uk` 외부 방 생성/입장/방 종료 확인
3. 사용자 제작 스크립트 모델과 안전 제한 설계
4. 동작 녹화/재생
5. 진단 패키지 기반 버그 리포트 기능
6. 휴대폰 데모 서버에서 호스팅 relay로 이전

현재 추천은 1번입니다. 자동 회귀 검증은 통과했지만 사람 몸에 닿는 실기기 안전 경로는 별도 합격이 필요합니다.

## 10. 관련 문서

- `README.md`: 설치, 실행, API, 테스트 전체 개요
- `docs/ARCHITECTURE.md`: 현재 Node 구조와 미래 Go relay 설계
- `docs/IMPLEMENTATION_GUIDE.md`: 프로토콜, fanout, 부하 테스트 기록
- `docs/WINDOWS_INSTALL_GUIDE.md`: Demo 8 설치/삭제
- `docs/DESKTOP_DEMO_TEST_GUIDE.md`: 하드웨어 없는 2클라이언트 테스트
- `docs/HARDWARE_SESSION_CHECKLIST.md`: 실제 장비 합격 절차
- `docs/DEPLOYMENT.md`: hosted/Termux 배포
- `docs/TROUBLESHOOTING.md`: 오류 분류
- `C:\Users\user\AI_NOTES\RULES.md`: 폰 서버, T-Code, git 안전 규칙
- `C:\Users\user\AI_NOTES\logs\laptop.md`: 최신 데스크톱 조사 기록
