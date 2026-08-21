# Roadmap

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
- [ ] Physical OSR/T-Code end-to-end acceptance
- [ ] Viewer local motion interpolation (next Phase 1 task)
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
