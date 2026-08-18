# Live Room Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show active relay rooms in the desktop room browser and let a second computer select and join them.

**Architecture:** Add a redacted Control API endpoint, call it from the existing Electron main-process relay service, and map the typed response into the existing room cards. Poll only while the room browser is visible and retain the existing direct invite flow.

**Tech Stack:** Node.js HTTP, Socket.IO, Electron IPC/preload, React 19, TypeScript, existing Node smoke scripts.

---

### Task 1: Public Room Directory API

**Files:**
- Modify: `scripts/relay-smoke-test.mjs`
- Modify: `server/src/relay-server.ts`
- Modify: `src/shared/protocol.ts`

- [ ] Add an assertion after host room creation that `GET /api/rooms` returns the room name, entry mode, password flag, viewer count, capacity, node ID, and creation time.
- [ ] Assert the serialized response contains neither the password value nor token/socket fields.
- [ ] Run `npm.cmd run test:smoke` and confirm the new assertion fails with HTTP 404.
- [ ] Implement the typed directory entry and `GET /api/rooms` handler using `roomRegistry.listRooms()` and `getConnectedCount()`.
- [ ] Run `npm.cmd run test:smoke` and confirm every assertion passes.
- [ ] Commit as `feat(server): expose redacted room directory` with required trailers.

### Task 2: Electron Room Listing Boundary

**Files:**
- Modify: `electron/services/relay-client.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.cts`
- Modify: `src/global.d.ts`
- Modify: `scripts/preload-format-test.mjs`

- [ ] Add a preload contract assertion for `listRooms` and run `npm.cmd run test:electron` to confirm it fails.
- [ ] Implement `RelayClient.listRooms`, trusted IPC validation, preload exposure, and renderer typing.
- [ ] Run `npm.cmd run test:electron` and confirm it passes.
- [ ] Commit as `feat(electron): bridge room directory queries` with required trailers.

### Task 3: Live Room Browser

**Files:**
- Modify: `scripts/electron-ui-smoke-test.mjs`
- Modify: `src/App.tsx`
- Modify: `src/ui/views/RoomBrowserView.tsx`
- Modify: `src/ui/demo-data.ts`
- Modify: `src/styles.css`

- [ ] Seed a room through the test relay and assert the browser renders that room instead of the three mock cards, then assert selecting it opens the real join dialog.
- [ ] Run `npm.cmd run test:ui` and confirm the room assertion fails.
- [ ] Add live-room state, request sequencing, immediate/manual/3000 ms refresh, loading/error/empty rendering, and room-card join selection.
- [ ] Remove `DEMO_ROOMS` from the browser data flow while retaining relay server choices.
- [ ] Run `npm.cmd run test:ui` and confirm all desktop viewport assertions pass.
- [ ] Commit as `feat(ui): show live relay rooms` with required trailers.

### Task 4: Packaged Discovery And Join

**Files:**
- Modify: `scripts/packaged-two-client-test.mjs`
- Modify: `README.md`
- Modify: `docs/DESKTOP_DEMO_TEST_GUIDE.md`

- [ ] Change the packaged test so the viewer discovers the host room card and opens it before submitting the join request.
- [ ] Run `npm.cmd run test:two-client` against the unpacked build and confirm discovery, join, manual motion, and automatic motion pass.
- [ ] Document that both computers must use the same LAN/external URL and that `localhost` is machine-local.
- [ ] Commit as `test(demo): verify packaged room discovery` with required trailers.

### Task 5: Demo 6 Release

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docs/WINDOWS_INSTALL_GUIDE.md`
- Modify: `docs/HARDWARE_SESSION_CHECKLIST.md`

- [ ] Set version `0.1.1-demo.6` and update current install links.
- [ ] Run `test:motion`, `test:smoke`, `test:electron`, `test:security`, `test:ui`, and `test:demo-prep`.
- [ ] Run `npm.cmd run electron:build` and `npm.cmd run release:check`.
- [ ] Install the generated NSIS EXE silently and run `test:two-client` against the installed executable.
- [ ] Generate the renamed GitHub asset and SHA-256 file.
- [ ] Commit as `chore(release): prepare demo 6 installer` with required trailers.
- [ ] Push the branch and annotated `v0.1.1-demo.6` tag, then create the GitHub Release.

