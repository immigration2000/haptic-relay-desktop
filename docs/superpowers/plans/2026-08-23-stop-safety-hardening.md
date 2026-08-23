# Stop Safety Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local, remote, disconnect, and application-shutdown stops block unsafe follow-up motion and accurately report stop confirmation.

**Architecture:** `HardwareController` owns atomic pause-before-stop and disconnect gates. `RelayClient` owns clearing delayed/outgoing motion, while `electron/main.ts` coordinates concurrent local and room-wide stop operations. The renderer mirrors returned protection state and keeps a string draft for the normalized stop-position input.

**Tech Stack:** TypeScript, Electron IPC, React, SerialPort, Socket.IO, Node assertion scripts, CDP UI smoke tests.

---

### Task 1: Atomic hardware stop latch and disconnect gate

**Files:**
- Modify: `scripts/hardware-output-test.mjs`
- Modify: `electron/services/hardware-controller.ts`

- [ ] **Step 1: Write failing controller tests**

Add real-controller assertions that `pauseAndStop()` returns paused protection and rejects a later frame, `setProtection({paused:true})` returns its stop result, and `queueMotion()` returns `hardware-disconnecting` while a delayed stop write is pending.

~~~js
const latched = await controller.pauseAndStop();
assert.equal(latched.protection.paused, true);
assert.deepEqual(controller.queueMotion(frame), { queued: false, reason: 'protection-paused' });

const disconnecting = safeController.disconnectSafely();
assert.deepEqual(safeController.queueMotion(frame), { queued: false, reason: 'hardware-disconnecting' });
await disconnecting;
~~~

- [ ] **Step 2: Verify RED**

Run: `npm.cmd run build:electron; node scripts/hardware-output-test.mjs`

Expected: failure because `pauseAndStop()` does not exist and disconnect accepts the frame.

- [ ] **Step 3: Implement minimal controller behavior**

~~~ts
async pauseAndStop() {
  this.protection = { ...this.protection, paused: true };
  const stop = await this.emergencyStop();
  return { ...stop, protection: this.protection };
}
~~~

Gate `queueMotion()` on `safeDisconnectInProgress` before its existing port/protection checks. Return `stop` from `setProtection()`.

- [ ] **Step 4: Verify GREEN**

Run: `npm.cmd run build:electron; node scripts/hardware-output-test.mjs`

Expected: `hardware output tests passed`.

- [ ] **Step 5: Commit**

~~~bash
git add electron/services/hardware-controller.ts scripts/hardware-output-test.mjs
git commit -m "fix(hardware): latch emergency stops"
~~~

### Task 2: Reliable and concurrent relay stop

**Files:**
- Modify: `electron/services/relay-client.ts`
- Modify: `electron/main.ts`
- Modify: `server/src/relay-server.ts`
- Modify: `scripts/relay-smoke-test.mjs`
- Modify: `scripts/preload-format-test.mjs`

- [ ] **Step 1: Write failing relay/source tests**

~~~js
assert.doesNotMatch(serverSource, /handleEmergencyStop[\s\S]*?\.volatile[\s\S]*?emit\(['"]room:stop/);
assert.match(mainSource, /const relayStop = relay\.emergencyStop\(\)[\s\S]*?const hardwareStop = hardware\.pauseAndStop\(\)[\s\S]*?Promise\.all/);
~~~

Also assert local stop clears delayed relay motion before the atomic hardware pause and received room stop reports the hardware result.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd run build:server; npm.cmd run build:electron; node scripts/relay-smoke-test.mjs; node scripts/preload-format-test.mjs`

Expected: failures for volatile control delivery, sequential awaits, and missing pause operation.

- [ ] **Step 3: Implement minimal relay behavior**

Expose `RelayClient.clearBufferedMotion()`, clear outgoing motion before awaiting the room-stop acknowledgement, and change the server control event to:

~~~ts
socket.to(roomName).compress(false).emit('room:stop', signal);
~~~

Start local and relay stop operations before awaiting either:

~~~ts
const relayStop = relay.emergencyStop();
const hardwareStop = hardware.pauseAndStop();
const [relayResult, hardwareResult] = await Promise.all([relayStop, hardwareStop]);
~~~

For received stops, await `pauseAndStop()` and include its result in the renderer event.

- [ ] **Step 4: Verify GREEN**

Run: `npm.cmd run test:smoke; npm.cmd run test:electron`

Expected: relay smoke and Electron suites pass.

- [ ] **Step 5: Commit**

~~~bash
git add electron/main.ts electron/services/relay-client.ts server/src/relay-server.ts scripts/relay-smoke-test.mjs scripts/preload-format-test.mjs
git commit -m "fix(relay): deliver emergency stops reliably"
~~~

### Task 3: Bounded safe shutdown

**Files:**
- Modify: `electron/main.ts`
- Modify: `scripts/preload-format-test.mjs`

- [ ] **Step 1: Write failing lifecycle test**

~~~js
assert.match(mainSource, /app\.on\(['"]before-quit['"][\s\S]*?hardware\.disconnectSafely\(\)[\s\S]*?app\.quit\(\)/);
assert.doesNotMatch(mainSource, /window-all-closed[\s\S]*?hardware\.disconnect\(\)/);
~~~

- [ ] **Step 2: Verify RED**

Run: `npm.cmd run build:electron; node scripts/preload-format-test.mjs`

Expected: failure because window close directly calls `hardware.disconnect()`.

- [ ] **Step 3: Implement guarded async quit**

Use `shutdownStarted` and `shutdownComplete` guards. Prevent the first quit, stop demo and relay input, await bounded `disconnectSafely()`, then mark complete and invoke `app.quit()` again. Log a stop failure without hanging quit.

- [ ] **Step 4: Verify GREEN**

Run: `npm.cmd run test:electron; npm.cmd run test:ui`

Expected: both pass and Electron exits without destroyed-object errors.

- [ ] **Step 5: Commit**

~~~bash
git add electron/main.ts scripts/preload-format-test.mjs
git commit -m "fix(app): stop hardware before quit"
~~~

### Task 4: Accurate status and decimal stop-position input

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/global.d.ts`
- Modify: `electron/protocol.ts`
- Modify: `scripts/preload-format-test.mjs`
- Modify: `scripts/electron-ui-smoke-test.mjs`

- [ ] **Step 1: Write failing renderer/UI tests**

~~~js
assert.match(appSource, /localEmergencyStop[\s\S]*?setHardwareProtection\(result\.protection\)/);
assert.match(appSource, /applyHardwareProtection[\s\S]*?result\.stop[\s\S]*?장비 전원을 직접 차단하세요/);
~~~

Use CDP to focus the labeled stop-position field, replace its text with `0.35`, blur it, and assert the DOM still reports `0.35`.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd run test:electron; npm.cmd run test:ui`

Expected: missing result handling and decimal-draft UI failures.

- [ ] **Step 3: Implement draft-preserving input and result types**

Create a small local React number-input component with string draft state. Preserve empty/trailing-decimal drafts, update the profile only for finite values, and restore the canonical value on blur. Extend stop IPC/event result types with `protection` and `stop`, then prioritize direct-power-cut guidance over success messages.

- [ ] **Step 4: Verify GREEN**

Run: `npm.cmd run test:electron; npm.cmd run test:ui`

Expected: all tests pass, including decimal typing and failure messages.

- [ ] **Step 5: Commit**

~~~bash
git add src/App.tsx src/global.d.ts electron/protocol.ts scripts/preload-format-test.mjs scripts/electron-ui-smoke-test.mjs
git commit -m "fix(ui): preserve stop position decimals"
~~~

### Task 5: Full verification

- [ ] **Step 1: Run scoped suites**

~~~bash
npm.cmd run lint
npm.cmd run test:electron
npm.cmd run test:smoke
npm.cmd run test:ui
npm.cmd run build
~~~

Expected: every command exits zero.

- [ ] **Step 2: Run repository checks**

~~~bash
git diff --check origin/main...HEAD
git status --short
~~~

Expected: no whitespace errors and a clean worktree.

- [ ] **Step 3: Review release scope**

Confirm the final diff contains only stop-safety implementation, tests, and the approved design/plan documents. Do not publish a release until verification is green.
