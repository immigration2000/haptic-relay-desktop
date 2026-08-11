# Android Termux 전송 가이드

## 1. PC에서 배포 파일 생성

프로젝트 폴더에서 실행합니다.

```powershell
npm.cmd run package:termux
```

`release` 폴더에 다음 파일이 생성됩니다.

```text
haptic-relay-termux-server-<version>.tar.gz
haptic-relay-termux-server-<version>.tar.gz.sha256
```

두 파일을 항상 함께 전송합니다. `.env`는 압축에 포함되지 않으며 핸드폰에서 새로 만듭니다.

## 2A. ADB로 전송

핸드폰의 개발자 옵션과 USB 디버깅을 활성화하고 USB로 PC에 연결합니다.

```powershell
adb devices
adb push release/haptic-relay-termux-server-0.1.0.tar.gz /sdcard/Download/
adb push release/haptic-relay-termux-server-0.1.0.tar.gz.sha256 /sdcard/Download/
```

`adb devices`에서 핸드폰이 `unauthorized`로 나오면 핸드폰 화면의 디버깅 허용 창을 승인합니다.

## 2B. 직접 전송

ADB를 사용하지 않을 경우 USB 파일 전송, 클라우드 드라이브 또는 메신저로 두 파일을 핸드폰의 `Download` 폴더에 저장합니다. 메신저가 압축파일 이름이나 내용을 변경하는 경우 체크섬 검증이 실패할 수 있습니다.

## 3. Termux에서 검증 및 압축 해제

Termux에서 실행합니다.

```bash
pkg update
pkg install nodejs curl openssh termux-api coreutils
termux-setup-storage
cd ~/storage/downloads
sha256sum -c haptic-relay-termux-server-0.1.0.tar.gz.sha256
tar -xzf haptic-relay-termux-server-0.1.0.tar.gz -C ~
cd ~/termux-server
```

체크섬 결과가 `OK`가 아니면 압축을 풀거나 실행하지 말고 두 파일을 다시 전송합니다.

## 4. 서버 설치 준비

```bash
npm ci --omit=dev --ignore-scripts
chmod +x prepare-env.sh start.sh stop.sh restart.sh start-quick-tunnel.sh stop-quick-tunnel.sh health-check.sh
./prepare-env.sh
```

Quick Tunnel과 릴레이를 함께 시작합니다.

```bash
pkg install cloudflared
./start-quick-tunnel.sh
./health-check.sh
cat quick-tunnel-url.txt
```

`start-quick-tunnel.sh`는 기존 `~/.cloudflared/config.yml`을 변경하지 않고 Quick Tunnel 실행 시에만 무시합니다. 종료할 때는 `./stop-quick-tunnel.sh`를 사용합니다.

## 업데이트

기존 서버를 `./stop.sh`로 중지한 다음 새 압축을 별도 위치에 풀고 기존 `.env`만 옮깁니다. `node_modules`, 로그, PID 파일은 이전 폴더에서 복사하지 않습니다.
