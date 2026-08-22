# Haptic Relay Desktop 구현 설명서

이 문서는 지금까지 구현한 데스크톱 앱, 릴레이 서버, 하드웨어 프로토콜, 운영 서버 구조를 설명합니다.

## 1. 제품 목적

Haptic Relay Desktop은 기존 사이트의 하드웨어 연동 기능을 독립 데스크톱 앱과 별도 릴레이 서버로 분리한 시스템입니다.

목표는 스트리머가 판다TV 같은 외부 방송 플랫폼에서 방송하더라도, 별도 앱을 통해 시청자 하드웨어와 움직임을 동기화할 수 있게 하는 것입니다.

```text
외부 방송 플랫폼 = 영상, 채팅, 방 홍보
Haptic Relay 앱 = 방 입장, 하드웨어 연결, 모션 연동
Haptic Relay 서버 = 방 생성, 입장 제어, 모션 fanout
```

사이트 내 하드웨어 연동 서버와 이 앱용 릴레이 서버는 의도적으로 분리합니다.

- 사이트 서버: 낮은 딜레이를 최우선으로 최적화
- 앱 서버: 외부 플랫폼 호환성, 방 관리, 확장성, 비용 제어를 우선

## 2. 전체 사용자 흐름

```text
1. 스트리머가 외부 방송 플랫폼에서 방송 시작
2. 스트리머가 Haptic Relay Desktop 실행
3. 앱에서 릴레이 서버 URL 입력
4. 방 이름, 비밀번호, 입장 방식 설정
5. Control API가 방 생성 후 host token 발급
6. 앱이 배정된 relay node에 WebSocket 연결
7. 스트리머가 방 이름/비밀번호를 방송에 노출
8. 시청자가 앱 설치 후 방 입장
9. Control API가 viewer token 발급
10. 신청입장 방이면 viewer socket이 승인 대기 상태가 됨
11. 스트리머 앱에서 입장 신청을 승인하거나 거절
12. 승인된 viewer 앱이 relay node room에 참여
13. 스트리머 하드웨어 모션을 V2 20바이트 packet으로 relay
14. viewer 앱이 `decode -> sequence filter -> local receipt-time delay queue -> hardware queue` 순서로 수신 frame을 처리
15. hardware queue가 연결된 하드웨어에 T-Code로 출력
```

## 3. 주요 컴포넌트

```text
src/App.tsx
  데스크톱 앱 UI. 스트리머/시청자 역할, 방 생성, 방 입장 정보 복사, 하드웨어 연결, 접속자 관리, 이벤트 로그 표시.

electron/main.ts
  Electron main process. Renderer와 native 기능 사이 IPC 연결, CSP, navigation/window-open 차단, IPC 입력값 검증, settings.json 저장/불러오기, 최근 이벤트 로그 버퍼, 로그 export.

electron/services/relay-client.ts
  Control API 호출, Socket.IO relay 연결, motion packet 송신/수신, sequence 검사, 시청자 지연 queue scheduling, 신청입장 승인 이벤트 처리.

electron/services/motion-delay-buffer.ts
  로컬 수신 시각을 기준으로 승인된 viewer motion frame을 보관하고 due frame을 FIFO로 반환하는 bounded queue.

electron/services/hardware-controller.ts
  SerialPort 연결, 하드웨어 프로필 적용, T-Code D1/D2 capability probe, 하드웨어 출력 queue, backpressure 처리, 로컬 테스트 패턴 출력.

electron/services/tcode-encoder.ts
  정규화된 motion frame을 OSR/SR6 호환 T-Code로 변환하고 probe 응답을 파싱.

server/src/relay-server.ts
  Control API, Socket.IO relay, motion fanout, metrics, healthcheck.

server/src/control-token.ts
  HMAC signed host/viewer token 발급 및 검증.

server/src/room-registry.ts
  방 metadata 저장, relay node 배정, memory/Redis registry 구현.

src/shared/motion-packet.ts
  네트워크용 V2 20바이트 binary motion packet encode/decode. 기존 V1 4바이트 packet 수신 호환 유지.

scripts/relay-load-test.mjs
  500명/1000명 시청자 fanout 부하 테스트.

scripts/redis-registry-test.mjs
  실제 Redis 서버를 사용해 RedisRoomRegistry create/get/attach/list/count/TTL/remove 동작 검증.
```

## 3.1 초대 코드

방 생성 후 host UI는 일반 텍스트 입장 정보와 함께 `HRS1.` 초대 코드를 표시합니다. viewer UI는 초대 코드를 decode한 뒤 relay URL, room name, password, entry mode를 입력값에 반영합니다.

payload:

```json
{
  "v": 1,
  "relayUrl": "http://localhost:4174",
  "roomName": "studio-main",
  "password": "optional",
  "entryMode": "open"
}
```

코드 형식:

```text
HRS1.<base64url(utf8-json)>
```

host UI는 같은 `HRS1.` 문자열을 로컬 QR 이미지로 생성해 표시합니다. QR 생성은 외부 네트워크 호출 없이 renderer 내부에서 처리합니다.

패키징:

```text
npm.cmd run electron:pack
  build 후 electron-builder --dir 실행. 설치 파일 없이 unpacked 앱 디렉터리를 만들어 패키징 구조를 빠르게 확인.

npm.cmd run electron:build
  build 후 electron-builder --win nsis 실행. Windows 설치 파일 생성.

npm.cmd run release:check
  Electron 런타임, SerialPort native binding, app.asar, app.asar.unpacked, NSIS 산출물 존재 여부를 점검.
```

서버 배포:

```text
npm.cmd run build:server
npm.cmd run server:start
  dist-server/server/src/relay-server.js 실행.

Dockerfile.server
  Node 22 기반 서버 컨테이너 이미지. 자세한 rollout은 docs/DEPLOYMENT.md 참고.
```

패키징 설정:

- `asar: true`
- `asarUnpack`: SerialPort native binding `.node`와 prebuilds
- `npmRebuild: false`: 현재 SerialPort prebuild 사용을 전제로 native rebuild를 생략
- Windows target: `nsis`
- output directory: `release`

릴리스 빌드 환경에서는 Electron 런타임을 다운로드할 수 있어야 한다. Electron 43은 첫 CLI 실행 때 런타임을 내려받으므로 패키징 전에 `npm.cmd exec electron -- --version`으로 설치 상태를 확인한다.

## 4. 서버 구조

현재는 개발 편의를 위해 Control API와 Relay Node가 같은 Node 프로세스 안에 있습니다. 하지만 코드 경계는 나중에 분리할 수 있게 잡았습니다.

```text
Desktop App
  |
  | POST /api/rooms
  v
Control API
  - room metadata 생성
  - relay node 배정
  - host token 발급
  |
  | hostToken + relayUrl
  v
Relay Node
  - WebSocket only
  - signed token 검증
  - motion packet fanout
```

운영에서는 다음 구조로 분리하는 것이 목표입니다.

```text
Control API
  - auth
  - room create/join
  - password / approval
  - relay node assignment
  - room registry persistence

Relay Nodes
  - WebSocket relay
  - room-local fanout
  - hot path metrics
  - no DB read per motion frame

Redis
  - room metadata
  - relay node assignment
  - short TTL room state

Postgres, later
  - user accounts
  - billing
  - moderation
  - audit logs
```

## 5. Control API

### `POST /api/rooms`

방을 생성하고 host token을 발급합니다.

요청:

```json
{
  "roomName": "studio-main",
  "password": "1234",
  "entryMode": "open"
}
```

응답:

```json
{
  "ok": true,
  "roomName": "studio-main",
  "entryMode": "open",
  "relayNodeId": "local-1",
  "relayUrl": "http://localhost:4174",
  "hostToken": "..."
}
```

### `POST /api/rooms/:roomName/join`

시청자 입장을 검증하고 viewer token을 발급합니다.

요청:

```json
{
  "displayName": "viewer-01",
  "password": "1234"
}
```

응답:

```json
{
  "ok": true,
  "roomName": "studio-main",
  "relayNodeId": "local-1",
  "relayUrl": "http://localhost:4174",
  "viewerToken": "..."
}
```

### `GET /healthz`

서버 생존 확인용입니다.

### `GET /metrics`

방별 연결 수, forwarded frame, dropped frame, relay node 정보를 확인합니다.
신청입장 방은 `pendingApprovals`로 승인 대기 viewer 수도 확인할 수 있습니다.
세션 차단 수는 `blockedViewers`로 확인할 수 있습니다.

## 6. Relay Socket 흐름

Relay socket은 token 없이 방 생성 또는 입장을 허용하지 않습니다.

```text
Host:
  Control API에서 hostToken 받음
  Socket.IO connect
  room:create { token: hostToken }
  reconnect 후 같은 hostToken으로 room:create 재전송
  motion packet emit: "m"
  긴급 정지 시 room:stop 송신

Viewer:
  Control API에서 viewerToken 받음
  Socket.IO connect
  viewer:join { token: viewerToken }
  reconnect 후 같은 viewerToken으로 viewer:join 재전송
  request mode면 viewer:approval-requested가 host 앱으로 전달됨
  host가 viewer:approve { socketId, approved } 송신
  승인된 viewer만 room join 완료
  이미 승인된 표시 이름은 현재 방 세션 안에서 재연결 시 재승인을 요구하지 않음
  host가 viewer:moderate { socketId, action } 송신 가능
  kick은 즉시 room에서 제거, block은 제거 후 같은 표시 이름의 현재 방 재입장을 차단
  room:stop 수신 시 motion queue 삭제 후 하드웨어에 0 T-Code 출력
  motion packet receive: "m"
  decode -> sequence filter -> local receipt-time delay queue -> hardware queue
  T-Code serial output
```

모션 이벤트 이름은 트래픽 절감을 위해 `"m"`을 사용합니다.

## 6.1 Electron 보안 경계

renderer는 `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`로 실행합니다. preload는 필요한 함수만 `window.hapticRelay`에 노출하고, main process는 모든 IPC 요청에서 sender가 현재 main window인지 확인합니다.

적용된 제한:

- Content-Security-Policy 적용
- permission request 기본 거부
- renderer navigation 차단
- renderer의 새 window 생성 차단
- IPC 입력값 타입/길이/range 검증
- 패키지 앱에서 relay URL은 `https` 또는 localhost 개발 URL만 허용

이 앱은 방송 플랫폼 웹페이지를 renderer 안에 로드하지 않습니다. 외부 플랫폼은 방송/홍보 채널이고, 앱 renderer는 패키지된 UI만 실행하는 구조를 유지합니다.

## 7. Token 설계

`server/src/control-token.ts`는 HMAC-SHA256 signed token을 사용합니다.

Payload:

```json
{
  "role": "host",
  "roomName": "studio-main",
  "exp": 1784630400000
}
```

viewer token은 `displayName`도 포함할 수 있습니다.

운영에서는 `HAPTIC_CONTROL_TOKEN_SECRET`을 반드시 긴 랜덤 값으로 설정해야 합니다.

```text
HAPTIC_CONTROL_TOKEN_SECRET=long-random-secret
```

## 8. Room Registry

`server/src/room-registry.ts`는 두 가지 registry driver를 지원합니다.

### Memory Registry

기본값입니다.

```text
HAPTIC_ROOM_REGISTRY_DRIVER=memory
```

장점:

- 로컬 개발이 단순함
- Redis 없이 바로 실행 가능
- 부하 테스트가 쉬움

단점:

- 서버 프로세스가 죽으면 방 metadata가 사라짐
- 여러 Control API/Relay Node 사이 공유 불가

### Redis Registry

운영 준비용입니다.

```text
HAPTIC_ROOM_REGISTRY_DRIVER=redis
HAPTIC_REDIS_URL=redis://localhost:6379
HAPTIC_ROOM_TTL_SECONDS=28800
```

Redis에는 room metadata와 relay node assignment만 저장합니다.

중요한 원칙:

```text
Redis를 motion frame 전송에 쓰지 않는다.
```

고주파 motion fanout은 relay node의 `activeRooms` cache에서 처리합니다. Redis를 매 프레임 읽고 쓰면 500명 방송에서 지연과 비용이 같이 커집니다.

## 9. Relay Node Assignment

`RelayDirectory`가 relay node 목록을 관리하고, 방 생성 시 node를 배정합니다.

단일 node 설정:

```text
HAPTIC_RELAY_NODE_ID=local-1
HAPTIC_PUBLIC_RELAY_URL=http://localhost:4174
```

여러 node 설정:

```text
HAPTIC_RELAY_NODES=[
  {"id":"relay-seoul-1","url":"https://relay-seoul-1.example.com","maxViewers":500},
  {"id":"relay-seoul-2","url":"https://relay-seoul-2.example.com","maxViewers":500}
]
```

현재 배정 정책은 least-room-count입니다. 방 개수가 가장 적은 relay node에 새 방을 배정합니다.

향후 개선:

- node별 현재 연결 수
- CPU/event loop lag
- 지역, 예: Seoul/Tokyo
- room 예상 규모
- streamer 위치

## 10. 네트워크 모션 프로토콜

앱과 서버 사이 motion payload는 JSON이 아닙니다.

기본은 V2 20바이트 binary packet입니다. 기존 V1 4바이트 packet은 수신 호환만 유지합니다.

```text
byte 0:    version = 2
byte 1:    flags
byte 2-5:  sequence uint32, big-endian
byte 6-13: sourceTimeMs uint64, big-endian
byte 14-15: durationMs uint16, big-endian
byte 16-17: position uint16, big-endian, 0-65535
byte 18-19: intensity uint16, big-endian, 0-65535
```

예:

```text
position = 0.42
intensity = 0.8

packet = [
  2, 0,
  sequence 4 bytes,
  sourceTimeMs 8 bytes,
  durationMs 2 bytes,
  position 2 bytes,
  intensity 2 bytes
]
```

이렇게 한 이유:

- JSON field name 제거
- sourceTimeMs/durationMs/sequence를 고정 폭 binary field로 압축
- roomName 제거
- float 문자열 제거
- viewer 수만큼 곱해지는 outbound traffic 감소

기존 JSON 방식은 매 프레임 수십~100바이트급이 될 수 있습니다. 현재 V2 packet payload는 20바이트입니다.

### Sequence 처리

- 송신 앱은 latest-frame 병합 이후 실제 Socket.IO 전송 시점에만 `sequence`를 1 증가시킵니다.
- 시청자 앱은 하드웨어 출력 전에 중복 및 역순 V2 패킷을 제거합니다.
- 순번 간격은 누락 프레임 수로 누적하며 `receivedFrames`, `acceptedFrames`, `duplicateFrames`, `outOfOrderFrames`, `lostFrames`를 조회할 수 있습니다.
- uint32 순환을 지원하므로 `4294967295` 다음 순번은 `0`입니다.
- V1 패킷에는 순번이 없으므로 릴레이 서버가 전달 순서에 맞춰 V2 순번을 부여합니다.

### 시청자 모션 지연

승인된 frame은 송신자 wall clock이 아니라 viewer의 로컬 monotonic 수신 시각을 기준으로 지연합니다.

```text
decode -> sequence filter -> local receipt-time delay queue -> hardware queue
```

- 허용 범위는 `0-10000ms`입니다.
- 조정 단위는 `100ms`입니다.
- 기본값과 `schemaVersion`이 없거나 v1인 설정의 마이그레이션 값은 `0ms`입니다.
- 지연값 변경과 연결 해제, 방 입장/재입장, 시청자 제거 같은 세션 이벤트는 queued frame을 삭제합니다.
- 방 전체 정지와 긴급 정지 같은 안전 이벤트도 queued frame을 삭제합니다.
- 로컬 보간은 다음 독립적인 Phase 1 작업으로 남아 있습니다.

## 11. 하드웨어 출력 프로토콜

네트워크 packet과 실제 하드웨어 명령은 다릅니다.

Relay protocol:

```text
V2 20-byte binary packet
```

Hardware protocol:

```text
T-Code ASCII over SerialPort
```

연결 직후 앱은 `D1`/`D2`를 보내 장비의 T-Code 버전과 지원 axis를 best-effort로 확인합니다. OSR/SR6 펌웨어별 응답 형식이 다를 수 있으므로 probe 응답이 없어도 연결은 유지하고, UI에는 응답 없음 상태를 표시합니다.

긴급 정지는 일반 motion queue와 진행 중인 하드웨어 테스트보다 우선합니다. 앱은 pending frame을 삭제하고 테스트의 후속 출력을 취소한 뒤 `DSTOP`과 프로필에 저장된 절대 정지 위치 fallback T-Code를 씁니다.

기본 출력:

```text
D1
D2
L04200I16
L04200I16 V08000
DSTOP
```

의미:

```text
L0    = OSR/SR6 linear stroke axis
4200  = position 0.42를 0-9999로 변환
I16   = 16ms interval
V08000 = vibration axis V0를 0.8로 설정
DSTOP = TCode device stop command
```

여러 T-Code channel은 같은 line에서 공백으로 구분합니다.

환경변수:

```text
HAPTIC_TCODE_LINEAR_AXIS=L0
HAPTIC_TCODE_VIBRATION_AXIS=V0
HAPTIC_TCODE_INTERVAL_MS=16
HAPTIC_HARDWARE_SAFETY_TIMEOUT_MS=1000
```

`HAPTIC_TCODE_VIBRATION_AXIS`는 선택값입니다. 장비가 지원할 때만 켭니다.
`HAPTIC_HARDWARE_SAFETY_TIMEOUT_MS`는 새 motion frame이 들어오지 않을 때 자동 정지를 실행하기까지의 시간입니다. `0` 이하로 설정하면 safety timeout을 비활성화합니다.

앱 UI의 하드웨어 프로필은 연결 시점에 main process로 전달되고 IPC에서 검증됩니다.

프로필 항목:

- baudrate
- linear stroke axis
- optional vibration axis
- stroke min/max range
- absolute emergency stop position within the stroke range
- invert position

연결 중에는 renderer의 프로필 입력과 설정 불러오기를 잠가 연결 시 main process에 전달한 활성 프로필과 화면 표시가 일치하도록 합니다. 연결 해제는 같은 긴급 정지 payload를 최대 500ms 시도한 뒤 포트를 닫습니다.

수신 motion frame은 네트워크 프로토콜에서는 항상 `0.0-1.0` 정규화 값을 유지합니다. 하드웨어 프로필은 SerialPort 출력 직전에만 적용합니다.

시청자 보호 옵션도 SerialPort 출력 전에 적용합니다.

보호 항목:

- intensity limit
- position min/max range
- receive pause

`receive pause`가 켜지면 앱은 즉시 로컬 `DSTOP`을 실행하고, 이후 수신 motion frame을 하드웨어 queue에 넣지 않습니다. relay room 참여 상태는 유지되므로 시청자는 일시정지를 해제한 뒤 다시 수신할 수 있습니다.

## 11.1 실제 하드웨어 테스트

앱 UI의 하드웨어 `테스트` 버튼은 릴레이 서버와 무관하게 로컬 SerialPort에만 T-Code를 씁니다.

테스트 패턴:

```text
position 0.2
position 0.5
position 0.8
position 0.5
DSTOP
fallback stop position
```

동작 원칙:

- 연결된 SerialPort가 없으면 `hardware-not-connected`로 실패
- `receive pause`가 켜져 있으면 `protection-paused`로 실패
- 하드웨어 프로필의 stroke min/max, invert, axis 설정을 적용
- 시청자 보호 옵션의 intensity limit, position min/max를 적용
- 테스트 종료 또는 실패 후 항상 긴급 정지를 실행
- relay room에는 테스트 motion을 publish하지 않음

실제 장비 연결 확인 순서:

1. 포트 새로고침
2. OSR/SR6 장비 포트 선택
3. baudrate와 T-Code 축 확인
4. 연결 실행
5. probe 결과 또는 `TCode 응답 없음` 상태 확인
6. stroke 범위를 좁게 잡은 뒤 테스트 실행
7. 방향이 반대면 `방향 반전` 적용 후 재연결
8. 이벤트 로그에서 테스트 시작/종료/실패 확인

## 11.2 설정 저장

하드웨어 프로필, 보호 옵션, 시청자 재생 설정은 Electron `userData` 경로의 `settings.json`에 저장합니다.

저장 대상:

- schema version
- hardware profile
- hardware protection
- playback motion delay

renderer는 시작 시 `app:get-settings` IPC로 설정을 읽고, `app:save-settings` IPC로 현재 값을 저장합니다. 시청자 지연은 `viewer:set-motion-delay` IPC로 별도 적용하고 같은 설정 파일에 저장합니다. main process는 저장 전 schema version, `HardwareProfile`, `HardwareProtection`, `PlaybackSettings`를 다시 검증합니다. 설정 파일이 없으면 기본값을 사용하고, 유효하지 않은 설정은 거부합니다.

현재 schema:

```json
{
  "schemaVersion": 3,
  "hardwareProfile": {
    "stopPosition": 0
  },
  "hardwareProtection": {},
  "playback": {
    "motionDelayMs": 0
  }
}
```

마이그레이션 규칙:

- `schemaVersion`이 없거나 `schemaVersion: 1`이면 `playback.motionDelayMs: 0`과 `hardwareProfile.stopPosition: strokeMin`을 추가해 v3로 다시 저장
- `schemaVersion: 2`이면 기존 playback을 유지하고 `hardwareProfile.stopPosition: strokeMin`을 추가해 v3로 다시 저장
- `schemaVersion: 3`이면 절대 정지 위치를 포함한 전체 설정을 검증
- 지원하지 않는 version이면 설정 읽기를 거부하고 이벤트 로그에 이유를 남김

## 11.3 이벤트 로그

main process는 최근 300개 이벤트를 메모리 버퍼로 보관합니다. renderer는 시작 시 `app:logs` IPC로 현재 버퍼를 읽고, 이후 `app:log` push event를 받아 UI에 최근 80개를 표시합니다.

로그 source:

- `hardware`
- `relay`
- `room`
- `protection`
- `app`

현재 추적 이벤트:

- hardware connect/disconnect/connect failure
- hardware test start/finish/failure
- SerialPort motion/stop write failure
- relay connected/disconnected/reconnecting/rejoined/error
- room create/join request
- approval request/status
- viewer list update
- room-wide stop received
- hardware safety timeout
- protection update/pause/motion dropped while paused
- clipboard copy
- logs exported

사용자가 이벤트 로그의 `저장` 버튼을 누르면 renderer는 `app:export-logs` IPC를 호출합니다. 파일 경로 선택과 파일 쓰기는 main process의 save dialog에서 처리합니다.

export JSON:

```json
{
  "app": "Haptic Relay",
  "version": "0.1.0",
  "exportedAt": "2026-07-31T00:00:00.000Z",
  "entries": []
}
```

## 12. 지연 최적화

적용된 최적화:

- WebSocket only
- Socket.IO long polling upgrade 비활성화
- compression 비활성화
- motion event ack 없음
- `volatile` event 사용
- 최신 frame 중심 coalescing
- V2 20바이트 binary packet
- token bucket rate limit
- SerialPort backpressure 처리
- 하드웨어 safety timeout
- 시청자 로컬 보호 옵션

핵심 판단:

```text
모션은 상태값이다.
오래된 frame을 늦게 받는 것보다 버리고 최신 frame을 받는 게 낫다.
```

그래서 느린 viewer에게 오래된 frame backlog를 쌓지 않습니다.

## 13. Rate Limit

서버 rate limit은 token bucket 방식입니다.

환경변수:

```text
HAPTIC_RELAY_MAX_HZ=60
HAPTIC_RELAY_BURST_FRAMES=2
```

고정 millisecond interval 방식은 60Hz 근처에서 `Date.now()` 정밀도 문제로 과도한 drop이 발생했습니다. token bucket으로 바꾼 뒤 500명/60Hz 테스트에서 수신률이 크게 개선됐습니다.

## 14. 부하 테스트 결과

로컬 테스트 결과:

```text
50명 / 30Hz / 5초     = 100% 수신
500명 / 30Hz / 10초   = 100% 수신
500명 / 60Hz / 10초   = 99.33% 수신
1000명 / 30Hz / 10초  = 100% 수신
```

최근 registry/Control API 변경 후 확인:

```text
500명 / 30Hz / 10초 = 100% 수신
```

주의:

이 수치는 로컬 짧은 테스트 기준입니다. 운영에서는 TLS, 실제 인터넷 RTT, 클라우드 CPU, NIC, 지역 분산, 모바일 네트워크 품질을 따로 측정해야 합니다.

## 15. 부하 테스트 실행

서버 실행:

```bash
npm run server:dev
```

500명, 30Hz:

```powershell
$env:VIEWERS=500
$env:HZ=30
$env:DURATION_MS=30000
npm.cmd run load:relay
```

500명, 60Hz:

```powershell
$env:VIEWERS=500
$env:HZ=60
$env:DURATION_MS=30000
npm.cmd run load:relay
```

Redis registry live test:

```powershell
$env:HAPTIC_REDIS_URL="redis://localhost:6379"
$env:HAPTIC_ROOM_TTL_SECONDS="60"
npm.cmd run test:redis
```

실제 Redis 서버가 필요합니다. Redis가 없으면 연결 오류로 실패합니다.

결과 예:

```json
{
  "viewers": 500,
  "hz": 30,
  "sentFrames": 300,
  "expectedViewerFrames": 150000,
  "receivedViewerFrames": 150000,
  "receiveRate": 1
}
```

## 16. 운영 권장값

기본값:

```text
HAPTIC_RELAY_MAX_HZ=30
HAPTIC_RELAY_CLIENT_MAX_HZ=30
HAPTIC_HARDWARE_MAX_HZ=60
HAPTIC_MAX_VIEWERS_PER_ROOM=500
```

고품질 모드:

```text
HAPTIC_RELAY_MAX_HZ=60
HAPTIC_RELAY_CLIENT_MAX_HZ=60
HAPTIC_MAX_VIEWERS_PER_ROOM=500
```

권장 운영 판단:

```text
안정권: 500명 x 30Hz
가능권: 500명 x 60Hz
상한권: 1000명 x 30Hz
위험권: 1000명 x 60Hz 이상
```

1000명 x 60Hz 이상은 단일 relay node보다 방 단위 샤딩 또는 여러 relay node 분산이 맞습니다.

## 17. 파일별 역할

```text
server/src/relay-server.ts
  HTTP Control API와 Socket.IO relay server.

server/src/room-registry.ts
  RoomRegistry interface, InMemoryRoomRegistry, RedisRoomRegistry, RelayDirectory.

server/src/control-token.ts
  HMAC signed relay token.

src/shared/motion-packet.ts
  서버용 binary packet encoder/decoder.

electron/motion-packet.ts
  Electron main process용 binary packet encoder.

electron/services/relay-client.ts
  Control API 호출 후 배정된 relayUrl로 Socket.IO 연결, viewer motion packet 수신, 신청입장 승인 이벤트, 접속자 관리 이벤트 처리.

electron/services/hardware-controller.ts
  SerialPort 연결, 하드웨어 프로필 적용, T-Code capability probe, latest frame queue, write drain 처리.

electron/services/tcode-encoder.ts
  MotionFrame -> T-Code 변환, probe command 생성, probe 응답 파싱.

scripts/relay-load-test.mjs
  relay fanout 부하 테스트.
```

## 18. 현재까지 커밋 히스토리

```text
5b67d98 feat: scaffold haptic relay desktop app
0e02b70 feat: split relay server from desktop app
41e1065 perf: coalesce motion relay frames
f55fda5 fix: emit t-code for serial hardware
50bf3bc perf: encode relay motion as binary packets
47b0d5e perf: add relay load test and token bucket
1ad1d68 feat: add control api relay tokens
b82b897 feat: add relay node room assignment
7327fe2 feat: add redis room registry
74d1788 docs: add implementation guide
dd0a0f7 feat: route viewer motion to hardware
```

## 19. 아직 남은 작업

1. adaptive Hz 자동 조절
2. TLS termination / reverse proxy 설정
3. Prometheus metrics 또는 structured logging
4. Control API를 별도 서비스로 분리
5. Postgres user/account/billing/moderation schema
6. 영구 차단/세션 로그 저장소

## 20. 중요한 설계 원칙

```text
1. Motion hot path는 짧고 로컬이어야 한다.
2. Redis/Postgres는 control plane에만 둔다.
3. 방은 하나의 relay node에 고정한다.
4. 느린 viewer 때문에 전체 방 지연이 늘어나면 안 된다.
5. 오래된 motion frame은 가치가 낮다.
6. 하드웨어 출력은 T-Code로 확실히 변환한다.
7. 사이트 저지연 서버와 앱 범용 relay 서버는 분리 운영한다.
```

이게 현재 구현의 핵심입니다.
