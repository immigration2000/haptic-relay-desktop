# Roadmap

## Current Priority

- [x] Restore AWS relay server access and verify SSH, local `/healthz`, and external HTTPS in that order
- [x] Deploy the AWS staging relay behind Cloudflare Tunnel at `https://aws-relay.syncra.uk`
- [x] Make `https://aws-relay.syncra.uk` the desktop app's main/default relay
- [x] Keep `https://relay.syncra.uk` in the built-in list as the manually selected phone backup
- [ ] Decide whether the legacy `relay.syncra.uk` DNS name should eventually move to AWS; no automatic failover is implemented

## Phase 1: Desktop MVP

- Host room creation
- Viewer room join
- Hardware port discovery
- Motion send and receive
- Viewer hardware output from received motion
- [x] Motion Packet V2
- [x] Viewer sequence filtering
- [x] Viewer local receipt-time motion delay
- [x] Hardware-free automatic motion patterns (sine, triangle, pulse, sawtooth)
- [x] Serial write timeout, fail-closed disconnect, and bounded emergency-stop failure (P0)
- [x] runtime emergency latch, local release, room-exit stop, and bounded stop-before-close hardware disconnect.
- [ ] Physical COM3 OSR/T-Code end-to-end acceptance (deferred: last-position hold, local/room-wide emergency latch and release, bounded disconnect stop, room-exit stop)
- [x] Viewer local motion interpolation (`100ms+` delay, `30Hz`, max `250ms` source gap, no extrapolation)
- [ ] Motion pattern recording and playback
- [ ] Network diagnostics dashboard
- Manual emergency stop
- Standalone relay server for development

## Phase 2: Production Relay

- Hosted relay service deployment shape
- Website low-latency backend remains separate from app relay
- Authenticated streamer accounts
- Room password hashing
- Approval queue
- Viewer kick and ban
- Per-room rate limits

## Phase 3: Hardware SDK Split

- `@haptic-relay/protocol`
- `@haptic-relay/hardware-serial`
- `@haptic-relay/desktop`
- Hardware simulator for QA
- Device certification fixtures

## Phase 4: Distribution

- Windows installer
- macOS notarized build
- Auto-update channel
- Crash reporting
- Consent and safety onboarding
