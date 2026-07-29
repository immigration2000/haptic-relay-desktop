# Haptic Relay Desktop

방송 플랫폼과 분리된 하드웨어 릴레이 시스템입니다. 데스크톱 앱은 하드웨어 연결과 방 UI를 담당하고, 별도 릴레이 서버가 방 생성/입장/모션 중계를 담당합니다.

## 핵심 워크플로우

1. 스트리머가 외부 방송 플랫폼에서 방송을 시작합니다.
2. 스트리머가 Haptic Relay Desktop에서 릴레이 서버에 연결하고 방 이름, 비밀번호, 입장 방식을 설정합니다.
3. 스트리머가 방송 화면이나 채팅으로 방 이름과 비밀번호를 안내합니다.
4. 시청자는 앱을 설치하고 방에 입장합니다.
5. 스트리머가 하드웨어를 연결하고 움직이면 모션 프레임이 방의 시청자에게 릴레이됩니다.
6. 시청자 앱은 수신한 모션 프레임을 각자의 하드웨어 제어 프로토콜로 변환합니다.

## 현재 포함된 범위

- Electron + React + TypeScript 데스크톱 앱 골격
- 스트리머/시청자 역할 전환 UI
- 방 생성 설정: 방 이름, 비밀번호, 자유입장/신청입장
- 신청입장 승인/거절 대기 큐
- 스트리머용 접속자 목록, 강퇴, 세션 차단
- 로컬/방 전체 긴급 정지
- 릴레이 재연결 후 자동 방 재입장
- SerialPort 기반 하드웨어 포트 검색, 연결, T-Code 프로토콜 송신
- 하드웨어 연결 시 T-Code `D1`/`D2` capability probe
- baudrate, T-Code 축, stroke 범위, 방향 반전 하드웨어 프로필 설정
- 시청자 강도 상한, 위치 범위 제한, 수신 일시정지 보호 옵션
- relay, room, hardware, protection 최근 이벤트 로그
- Socket.IO 기반 독립 릴레이 서버 골격
- Control API 기반 방 생성/입장 토큰 발급
- 시청자 수신 motion packet을 하드웨어 T-Code 출력으로 연결
- MVP 프로토콜 타입 정의

## 실행

릴레이 서버:

```bash
npm install
npm run server:dev
```

데스크톱 앱:

```bash
npm install
npm run electron:dev
```

PowerShell에서 `npm.ps1` 실행 정책 문제가 있으면 Windows의 `npm.cmd`를 사용합니다.

```powershell
npm.cmd install
npm.cmd run server:dev
npm.cmd run electron:dev
```

## 릴레이 부하 테스트

릴레이 서버를 실행한 뒤 500명 시청자 조건을 시뮬레이션할 수 있습니다.

```bash
npm run server:dev
VIEWERS=500 HZ=30 DURATION_MS=30000 npm run load:relay
```

Windows PowerShell:

```powershell
$env:VIEWERS=500; $env:HZ=30; $env:DURATION_MS=30000; npm.cmd run load:relay
```

## 운영 서버 구조

현재 서버 프로세스는 Control API와 Relay Node를 함께 실행합니다. 운영에서는 같은 API 계약을 유지한 채 Control API를 별도 서비스로 분리할 수 있습니다.

```text
Desktop App -> Control API -> signed room token -> Relay Node -> Viewers
```

- `POST /api/rooms`: 방을 만들고 host token을 발급합니다.
- `POST /api/rooms/:roomName/join`: 비밀번호와 정원을 확인하고 viewer token을 발급합니다.
- Control API 응답에는 `relayNodeId`, `relayUrl`이 포함됩니다.
- Relay socket은 token 없이 `room:create` 또는 `viewer:join`을 허용하지 않습니다.
- 신청입장 방에서는 viewer socket이 승인 대기 상태가 되고, 스트리머 앱의 승인 후에만 방 fanout에 참여합니다.
- 스트리머는 접속자 목록에서 viewer를 강퇴하거나 표시 이름 기준으로 현재 방 세션에서 차단할 수 있습니다.
- 스트리머의 긴급 정지는 local hardware stop과 room-wide stop event를 동시에 실행합니다.
- 데스크톱 앱은 relay socket 재연결 후 마지막 host/viewer token으로 방 바인딩을 다시 수행합니다.
- `GET /healthz`: 서버 생존 확인
- `GET /metrics`: 방별 연결 수, forwarded/dropped frame 확인
- 패키지 앱에서 원격 relay URL은 `https`만 허용합니다. `http`는 로컬 개발용 `localhost`/`127.0.0.1`만 허용합니다.

운영 필수 환경변수:

```text
HAPTIC_PUBLIC_RELAY_URL=https://relay.example.com
HAPTIC_RELAY_NODE_ID=relay-seoul-1
HAPTIC_CONTROL_TOKEN_SECRET=long-random-secret
HAPTIC_MAX_VIEWERS_PER_ROOM=500
```

여러 relay node를 Control API에서 배정하려면:

```text
HAPTIC_RELAY_NODES=[{"id":"relay-seoul-1","url":"https://relay-seoul-1.example.com","maxViewers":500},{"id":"relay-seoul-2","url":"https://relay-seoul-2.example.com","maxViewers":500}]
```

room registry driver:

```text
HAPTIC_ROOM_REGISTRY_DRIVER=memory
```

Redis-backed registry:

```text
HAPTIC_ROOM_REGISTRY_DRIVER=redis
HAPTIC_REDIS_URL=redis://localhost:6379
HAPTIC_ROOM_TTL_SECONDS=28800
```

Redis는 room metadata와 relay node assignment 저장에만 사용합니다. 고주파 motion fanout은 relay node의 active room cache에서 처리해서 Redis를 매 프레임 치지 않습니다.

## 릴레이 모션 프로토콜

앱 내부에서는 정규화된 `MotionFrame`을 사용하지만, 네트워크 전송은 4바이트 바이너리 motion packet을 기본으로 사용합니다.

```text
byte 0-1: position uint16, big-endian, 0-65535
byte 2-3: intensity uint16, big-endian, 0-65535
```

- `intensity`: 0.0-1.0 강도
- `position`: 0.0-1.0 정규화 위치
- `timestamp`: 네트워크 payload에서는 제거하고 수신 시각으로 계산

## 하드웨어 출력 프로토콜

SerialPort로 장비에 쓰는 데이터는 OSR/SR6 계열 T-Code ASCII 라인입니다. 기본 출력은 L0 스트로크 축입니다.

```text
D1
D2
L04200I16
L04200I16 V08000
DSTOP
```

- 연결 직후 `D1`/`D2`를 보내 T-Code 장비 정보와 지원 축을 best-effort로 확인합니다.
- probe 응답이 없어도 연결 실패로 처리하지 않고, UI에 `TCode 응답 없음`으로 표시합니다.
- `L0`: 기본 linear stroke axis
- `4200`: 정규화 위치 `0.42`를 0-9999 범위로 변환한 값
- `I16`: 해당 위치까지 이동할 interval ms
- 여러 T-Code channel은 한 줄 안에서 공백으로 구분합니다.
- 긴급 정지는 `DSTOP`을 먼저 보내고 0 위치 fallback 명령을 이어서 보냅니다.
- `HAPTIC_TCODE_LINEAR_AXIS`: 기본 `L0`
- `HAPTIC_TCODE_VIBRATION_AXIS`: 선택값, 예: `V0`
- `HAPTIC_TCODE_INTERVAL_MS`: 기본 `16`
- `HAPTIC_HARDWARE_SAFETY_TIMEOUT_MS`: 기본 `1000`, 새 motion frame이 없을 때 자동 정지까지 대기할 시간. `0` 이하로 설정하면 비활성화합니다.

앱 UI에서 연결 시점의 하드웨어 프로필을 조정할 수 있습니다.

- `Baudrate`: SerialPort 연결 속도
- `Stroke 축`: 기본 `L0`
- `진동 축`: 선택값, 예: `V0`
- `최소/최대 위치`: 수신 position `0.0-1.0`을 실제 출력 범위로 매핑
- `방향 반전`: position `0.0`과 `1.0` 방향을 반대로 매핑

시청자 보호 옵션은 로컬 하드웨어 출력 전에 적용됩니다.

- `강도 상한`: 수신 intensity를 지정한 상한 이하로 제한
- `최소/최대 위치`: 수신 position을 시청자가 허용한 범위 안으로 재매핑
- `수신 일시정지`: 새 motion frame을 하드웨어에 출력하지 않고 즉시 로컬 정지

## 제품 원칙

- 방송 플랫폼 API에 의존하지 않습니다.
- 방 입장 정보는 스트리머가 원하는 플랫폼에서 자유롭게 공유합니다.
- 하드웨어 제어는 앱 내부 프로토콜로 격리합니다.
- 사이트용 저지연 서버와 앱용 범용 릴레이 서버를 분리해 지연 시간, QoS, 비용 정책을 다르게 운영합니다.
- 모든 실시간 연동은 명시적 입장, 비밀번호, 중지 제어, 로그 확인을 전제로 설계합니다.
- Relay socket은 Control API가 발급한 짧은 수명의 signed token만 신뢰합니다.
- Electron renderer는 sandbox/context isolation 상태로 실행하고, CSP, navigation 차단, 새 window 차단, IPC 입력값 검증을 적용합니다.

## 앱 릴레이 최적화

- 릴레이 서버와 앱 클라이언트는 WebSocket 전용으로 연결합니다.
- 모션 이벤트는 ack를 기다리지 않고 최신 프레임 위주로 전송합니다.
- 모션 payload는 JSON 대신 4바이트 바이너리 packet으로 전송합니다.
- 느린 네트워크나 클라이언트에는 오래된 모션 프레임을 쌓지 않도록 volatile 이벤트를 사용합니다.
- 서버, 앱 릴레이, 하드웨어 출력은 각각 최대 Hz를 환경변수로 제한합니다.
- 서버 rate limit은 token bucket으로 처리해 60Hz 근처의 타이머 지터를 과도하게 드롭하지 않습니다.
- SerialPort 출력은 backpressure를 고려해 최신 프레임만 큐에 남깁니다.
- 하드웨어는 새 motion frame이 일정 시간 없으면 자동으로 `DSTOP`과 0 위치 fallback을 출력합니다.
- 앱은 최근 300개 이벤트를 main process 메모리 로그로 보관하고 UI에는 최근 80개를 표시합니다.

## 이벤트 로그

앱 UI의 이벤트 로그는 다음 이벤트를 추적합니다.

- 하드웨어 연결/해제/연결 실패
- SerialPort motion/stop write 실패
- relay 연결, 끊김, 재연결, 오류
- 방 생성/입장 요청, 승인 요청, 접속자 목록 갱신
- room-wide stop 수신
- safety timeout, protection pause, protection update

## 다음 구현 순서

1. 앱용 공용 릴레이 서버 배포
2. 영구 차단/세션 로그 저장소
3. 하드웨어별 어댑터 분리
4. 속도 제한, 연령/동의 확인
