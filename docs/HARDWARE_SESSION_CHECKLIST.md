# 하드웨어 작업자 현장 테스트

## 시연 시작과 종료

1. Demo 9 설치본이 설치되어 있는지 확인합니다.
2. 저장소의 `demo\PREFLIGHT-HARDWARE-DEMO.cmd`를 실행해 설치본, Node.js, 릴레이 빌드, 전용 포트 `4175`, 현재 COM 포트를 확인합니다.
3. `demo\START-HARDWARE-DEMO.cmd`를 실행합니다. 로컬 릴레이와 서로 다른 프로필을 쓰는 앱 두 창이 열립니다.
4. 두 창 모두 서버 URL로 `http://127.0.0.1:4175`를 사용합니다. 첫 번째 창은 스트리머, 두 번째 창은 시청자로 사용합니다.
5. 시연이 끝나면 `demo\STOP-HARDWARE-DEMO.cmd`를 실행합니다. 런처가 기록한 두 앱과 런처가 직접 시작한 로컬 릴레이 PID만 종료합니다.

앱 또는 서버 시작에 실패하면 `%TEMP%\HapticRelayHardwareDemo\logs`의 로그를 확인합니다. 기존 `4174` 서버, 휴대폰 릴레이와 PULSE 서버는 이 로컬 시연에서 사용하거나 변경하지 않습니다.

## 합격 목표

스트리머 수동 슬라이더와 삼각 반복 패턴이 릴레이를 거쳐 시청자 OSR/T-Code 장비를 움직이고, 긴급 정지가 즉시 동작해야 합니다.

## 안전 전제

- 장비를 무부하 상태로 두고 가동 범위를 비웁니다.
- 독립 전원 차단 수단을 손이 닿는 곳에 둡니다.
- 장비가 움직이는 동안 케이블을 일부러 분리하거나 write timeout을 만들지 않습니다.
- 실제 위치와 `직렬 출력 진단`의 명령·종류·완료 시각을 기록합니다. 출력 event 수는 아래 임시 DevTools counter로 측정합니다. 직렬 write 성공만으로 물리 위치 도달을 합격 처리하지 않습니다.

## 임시 DevTools 출력 진단

시청자 앱 DevTools Console에서 기존 listener가 있으면 먼저 정리하고, `onHardwareOutput(listener) => unsubscribe` API로 event 배열과 counter를 등록합니다. 반환된 cleanup 함수는 테스트가 끝날 때까지 보관합니다.

```js
window.hapticOutputUnsubscribe?.();
window.hapticOutputEvents = [];
window.hapticOutputCount = 0;
window.hapticOutputUnsubscribe = window.hapticRelay.onHardwareOutput(snapshot => {
  window.hapticOutputEvents.push(snapshot);
  window.hapticOutputCount += 1;
});
```

각 동작 직전에 시청자 Console에서 기준값을 저장하고, 동작 뒤 delta와 마지막 snapshot을 확인합니다.

```js
window.hapticOutputBefore = window.hapticOutputCount;
window.hapticOutputCount - window.hapticOutputBefore;
window.hapticOutputEvents.at(-1);
```

단일 frame이 필요한 지점에서는 스트리머 앱 DevTools Console에서 아래 명령을 지시된 횟수만 실행합니다. signature는 `sendMotion(intensity, position)`이므로 강도 `0.10`이 첫 번째이고 위치 `0.45`가 두 번째입니다.

```js
await window.hapticRelay.sendMotion(0.10, 0.45);
```

## 초기 장비 설정

- 시청자 앱에서 COM3를 선택합니다.
- Baudrate는 우선 `115200`, Stroke 축은 `L0`, 진동 축은 비워 둡니다.
- 최초 Stroke 범위는 `0.20-0.80`으로 제한합니다.
- 절대 긴급 정지 위치는 `0.35`처럼 사용자가 확인한 안전 위치로 설정하고 Stroke 범위 안에 있는지 확인합니다.
- 연결 후 `테스트`를 눌러 `0.2 -> 0.5 -> 0.8 -> 0.5` 이동과 마지막 위치 유지를 확인합니다.

## 방과 모션 준비

- 스트리머가 자유입장 방을 만들고 시청자가 같은 서버와 방에 입장합니다.
- 시청자에서 `수신 일시정지`가 꺼져 있고 **긴급 정지** 버튼이 보이는 초기 해제 상태인지 확인합니다.
- 스트리머 수동 시연은 위치 `0.40`, 강도 `0.10`으로 시작합니다.
- 자동 패턴은 `삼각`, 주기 `3.0초`, 범위 `0.35-0.45`, 강도 `0.10`으로 미리 설정합니다.
- 첫 검증 전에 실제 위치와 직렬 출력 진단 snapshot·완료 시각, `window.hapticOutputCount`를 기록합니다.

## 릴레이 테스트

1. 스트리머 값을 고정하고 2초 이상 기다려 장비가 마지막 위치를 유지하는지 확인합니다.
   - 시청자 Console에서 `window.hapticOutputBefore = window.hapticOutputCount`를 실행합니다.
   - 수동 시연을 위치 `0.40`, 강도 `0.10`으로 2초 이상 실행합니다. 이 구간은 같은 값의 frame이 30Hz로 반복되는 상태입니다.
   - 실제 위치가 유지되고 새 event가 모두 `kind: "motion"`이며 `DSTOP` 또는 절대 정지 위치 출력이 추가되지 않는지 기록합니다.
   - `시연 중지`를 누른 뒤 2초 이상 기다립니다. 이 구간은 실제 packet silence입니다.
   - 중지 직전에 `window.hapticOutputBefore`를 현재 counter로 다시 저장합니다. 2초 뒤 counter delta가 `0`이고 직렬 출력 명령·완료 시각과 실제 위치도 그대로인지 확인합니다.
2. 시청자 로컬 긴급정지 후 장비가 절대 정지 위치로 이동하는지 확인합니다.
   - 수동 시연을 위치 `0.45`, 강도 `0.10`으로 다시 시작합니다.
   - 시청자 Console에 새 기준 counter를 저장한 뒤 **긴급 정지**를 누릅니다. counter가 증가하고 마지막 event에 `DSTOP`과 설정한 절대 위치가 기록되는지, 실제 장비가 안전 위치로 이동하는지 각각 확인합니다.
   - 스트리머 전송은 다음 항목을 위해 계속 둡니다.
3. 스트리머가 계속 값을 보내도 로컬 해제 전에는 장비 출력이 재개되지 않는지 확인합니다.
   - 새 기준 counter를 저장하고 수동 frame이 계속 들어오는 동안 기다립니다. counter delta가 `0`이고 직렬 출력 snapshot과 완료 시각이 바뀌지 않아야 합니다.
   - 수동 시연을 멈추고 새 기준 counter를 저장한 뒤 준비한 저강도 삼각 패턴을 6초 동안 실행하고 중지합니다. emergency latch가 유지되고 counter delta가 `0`이어야 합니다.
   - 장비가 이미 절대 정지 위치에 있는 상태에서 시청자 하드웨어 포트를 닫았다가 COM3에 다시 연결합니다. 새 기준 counter를 저장하고 스트리머 Console에서 `await window.hapticRelay.sendMotion(0.10, 0.45)`를 정확히 한 번 실행합니다. emergency latch가 유지되고 counter delta가 `0`이어야 합니다.
   - 시청자가 방에서 나갔다가 같은 방에 다시 입장합니다. room-exit stop은 같은 안전 위치를 다시 대상으로 합니다. 재입장 뒤 새 기준 counter를 저장하고 스트리머 Console에서 같은 단일-frame 명령을 정확히 한 번 실행합니다. emergency latch가 유지되고 counter delta가 `0`이어야 합니다.
   - `수신 일시정지`를 켭니다. receive pause가 별도 상태로 표시되고 emergency latch는 그대로 유지되어야 합니다.
4. 긴급정지 해제 순간에는 움직이지 않고 다음 새 프레임부터 움직이는지 확인합니다.
   - 스트리머 시연이 완전히 중지된 packet-silence 상태인지 먼저 확인합니다.
   - 해제 직전 직렬 출력 명령·종류·완료 시각을 기록하고 새 기준 counter를 저장합니다.
   - 시청자에서 **긴급정지 해제**를 누르고 2초 이상 기다립니다. 실제 움직임이 없고 counter delta가 `0`이어야 하며, `수신 일시정지`는 계속 켜져 있어야 합니다.
   - emergency latch가 해제되고 receive pause가 계속 켜진 상태에서 새 기준 counter를 저장합니다. 스트리머 Console에서 `await window.hapticRelay.sendMotion(0.10, 0.45)`를 정확히 한 번 실행하고 counter delta가 `0`인지 확인합니다.
   - `수신 일시정지`를 끕니다. 이 동작 자체의 counter delta도 `0`이어야 하고 emergency latch는 해제 상태를 유지해야 합니다.
   - 새 기준 counter를 저장하고 스트리머 Console에서 같은 단일-frame 명령을 정확히 한 번 실행합니다. counter delta가 정확히 `1`이고 마지막 event가 `kind: "motion"`이며 장비가 제한된 새 위치로 움직이는지 확인합니다.
   - DevTools 단일-frame 진단을 사용할 수 없으면 30Hz 시연으로 대체하지 말고 이 항목을 미합격으로 기록합니다.
5. 하드웨어 연결 해제 시 정지 명령을 시도한 뒤 포트가 닫히는지 확인합니다.
   - 장비가 `0.45` 근처의 non-stop 위치에 있고 모든 스트리머 시연이 중지됐는지 확인합니다.
   - 직렬 출력 진단을 기록하고 새 기준 counter를 저장한 뒤 `연결 해제`를 누릅니다.
   - 새 `kind=stop` event에 `DSTOP`과 설정한 절대 위치가 기록되고 장비가 안전 위치로 이동한 뒤 포트가 닫히는지 확인합니다.
   - 정지 write를 의도적으로 지연시키는 회귀에서는 `500ms` 안에 포트 닫기가 계속 진행되는지 확인합니다.
   - 다음 항목 전에 COM3를 명시적으로 다시 연결합니다. 새 motion은 보내지 않습니다.
6. 방 나가기 시 절대 정지 위치로 이동하는지 확인합니다.
   - COM3 연결과 non-stop 위치를 다시 확인하고 새 기준 counter를 저장한 뒤 시청자 앱에서 방을 나갑니다.
   - counter가 증가하고 마지막 event에 `DSTOP`과 설정한 절대 위치가 기록되며 실제 장비가 안전 위치로 이동하는지 각각 확인합니다.
   - 다음 항목 전에 하드웨어 포트를 한 번 닫고 COM3에 다시 연결한 뒤, 같은 방에 명시적으로 재입장합니다.
7. 스트리머 방 전체 정지 후 각 참여자가 자기 버튼으로만 해제되는지 확인합니다.
   - 스트리머와 시청자가 같은 방에 있고 COM3가 연결됐으며, `수신 일시정지`와 양쪽 emergency latch가 모두 해제 상태인지 확인합니다.
   - 준비한 저강도 삼각 패턴을 시작하고 스트리머가 방 전체 **긴급 정지**를 누릅니다.
   - 스트리머와 시청자 앱이 각각 로컬 latch 상태가 되고 시청자 장비가 절대 정지 위치로 이동하는지 확인합니다.
   - 스트리머 쪽만 해제했을 때 시청자 latch가 유지되는지 확인한 뒤, 시청자도 자기 버튼으로 해제합니다.
   - 각 해제 직전에 기준 counter를 새로 저장하고 해제 뒤 delta가 `0`인지 확인해, 해제 자체가 motion이나 stop payload를 보내지 않는지 확인합니다.

## 실패 위치 판별

- 수신 모니터가 멈춤: 서버 URL, 방 입장, 릴레이 연결을 확인합니다.
- 수신값은 변하지만 출력 진단이 없음: COM 포트, 연결 상태, 보호 일시정지를 확인합니다.
- 출력 진단은 변하지만 장비가 멈춤: baudrate, 축, 펌웨어 T-Code 버전, 케이블과 전원을 확인합니다.
- 반대 방향으로 움직임: `방향 반전`을 적용합니다.
- 범위가 너무 큼: Stroke 최소·최대와 시청자 보호 범위를 더 좁힙니다.

## 테스트 후 진단 자료 보관

1. 각 앱의 Electron `userData/logs/haptic-relay.jsonl` 경로를 기록합니다. 같은 폴더의 `.1.jsonl`부터 `.4.jsonl`까지 포함해 파일당 2 MiB, 전체 약 10 MiB가 자동 보관됩니다.
2. 앱의 **로그** 화면에서 **저장**을 눌러 현재 메모리 이벤트와 세션·진단 파일 메타데이터가 포함된 JSON도 내보냅니다.
3. JSONL에서 연결 프로필, probe 응답 또는 명시적 no-response, test/stop write duration, port error를 확인합니다. 30Hz motion은 1초 단위 summary여야 합니다.
4. `직렬 전송 완료`는 OS write callback 완료일 뿐 device acknowledgement나 장비의 실제 동작 증거가 아닙니다. 실제 위치 판정과 진단 파일 판정을 별도로 기록합니다.

자동 및 수동 로그는 로컬에만 저장되고 자격 증명은 제외됩니다. 공유 전에도 파일 내용을 검토합니다.

## 기록할 값

장비 모델, 펌웨어, COM 포트, baudrate, 선형 축, 진동 축, 방향 반전, 안전 Stroke 범위, 절대 정지 위치, 성공한 T-Code 예시를 기록합니다.

## 임시 진단 정리

시연을 종료하기 전에 시청자 앱 DevTools Console에서 보관한 unsubscribe를 호출하고 임시 값을 제거합니다.

```js
window.hapticOutputUnsubscribe?.();
delete window.hapticOutputUnsubscribe;
delete window.hapticOutputEvents;
delete window.hapticOutputCount;
delete window.hapticOutputBefore;
```
