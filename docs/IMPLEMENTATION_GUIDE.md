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
13. 스트리머 하드웨어 모션을 4바이트 packet으로 relay
14. viewer 앱이 packet을 decode
15. viewer 앱이 수신 motion frame을 연결된 하드웨어에 T-Code로 출력
```

## 3. 주요 컴포넌트

```text
src/App.tsx
  데스크톱 앱 UI. 스트리머/시청자 역할, 방 생성, 방 입장, 하드웨어 연결, 접속자 관리.

electron/main.ts
  Electron main process. Renderer와 native 기능 사이 IPC 연결.

electron/services/relay-client.ts
  Control API 호출, Socket.IO relay 연결, motion packet 송신/수신, 신청입장 승인 이벤트 처리.

electron/services/hardware-controller.ts
  SerialPort 연결, T-Code D1/D2 capability probe, 하드웨어 출력 queue, backpressure 처리.

electron/services/tcode-encoder.ts
  정규화된 motion frame을 OSR/SR6 호환 T-Code로 변환하고 probe 응답을 파싱.

server/src/relay-server.ts
  Control API, Socket.IO relay, motion fanout, metrics, healthcheck.

server/src/control-token.ts
  HMAC signed host/viewer token 발급 및 검증.

server/src/room-registry.ts
  방 metadata 저장, relay node 배정, memory/Redis registry 구현.

src/shared/motion-packet.ts
  네트워크용 4바이트 binary motion packet encode/decode.

scripts/relay-load-test.mjs
  500명/1000명 시청자 fanout 부하 테스트.
```

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
  packet decode
  HardwareController.queueMotion()
  T-Code serial output
```

모션 이벤트 이름은 트래픽 절감을 위해 `"m"`을 사용합니다.

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

4바이트 binary packet입니다.

```text
byte 0-1: position uint16, big-endian, 0-65535
byte 2-3: intensity uint16, big-endian, 0-65535
```

예:

```text
position = 0.42
intensity = 0.8

packet = [107, 133, 204, 204]
```

이렇게 한 이유:

- JSON field name 제거
- timestamp 제거
- roomName 제거
- float 문자열 제거
- viewer 수만큼 곱해지는 outbound traffic 감소

기존 JSON 방식은 매 프레임 수십~100바이트급이 될 수 있습니다. 현재 packet payload는 4바이트입니다.

## 11. 하드웨어 출력 프로토콜

네트워크 packet과 실제 하드웨어 명령은 다릅니다.

Relay protocol:

```text
4-byte binary packet
```

Hardware protocol:

```text
T-Code ASCII over SerialPort
```

연결 직후 앱은 `D1`/`D2`를 보내 장비의 T-Code 버전과 지원 axis를 best-effort로 확인합니다. OSR/SR6 펌웨어별 응답 형식이 다를 수 있으므로 probe 응답이 없어도 연결은 유지하고, UI에는 응답 없음 상태를 표시합니다.

긴급 정지는 일반 motion queue보다 우선합니다. 앱은 pending frame을 삭제하고 `DSTOP`을 먼저 쓴 뒤 0 위치/0 강도 fallback T-Code를 씁니다.

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
```

`HAPTIC_TCODE_VIBRATION_AXIS`는 선택값입니다. 장비가 지원할 때만 켭니다.

## 12. 지연 최적화

적용된 최적화:

- WebSocket only
- Socket.IO long polling upgrade 비활성화
- compression 비활성화
- motion event ack 없음
- `volatile` event 사용
- 최신 frame 중심 coalescing
- 4바이트 binary packet
- token bucket rate limit
- SerialPort backpressure 처리

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
  SerialPort 연결, T-Code capability probe, latest frame queue, write drain 처리.

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
2. Redis live integration test
3. Dockerfile / production deployment
4. TLS termination / reverse proxy 설정
5. Prometheus metrics 또는 structured logging
6. Control API를 별도 서비스로 분리
7. Postgres user/account/billing/moderation schema
8. 영구 차단/세션 로그 저장소

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
