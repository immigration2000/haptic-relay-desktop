import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const { HardwareController } = await import('../dist-electron/services/hardware-controller.js');
const selectedRegression = process.argv[2];
const runRegression = name => selectedRegression === undefined || selectedRegression === name;

class FakePort extends EventEmitter {
  constructor(path) {
    super();
    this.path = path;
    this.isOpen = false;
    this.writes = [];
    this.failNextWrite = false;
    this.throwNextWrite = false;
    this.failNextClose = false;
    this.closeErrorAfterPhysicalClose = false;
    this.stallNextOpen = false;
    this.stallNextWrite = false;
    this.stallNextClose = false;
    this.activeWrite = undefined;
    this.pendingWrites = [];
    this.pendingOpen = undefined;
    this.pendingClose = undefined;
    this.closeErrorHadListener = undefined;
    this.signalSets = [];
    this.operations = [];
    this.failNextSet = false;
    this.stallNextSet = false;
    this.probeReply = 'TCode v0.3\nL0 V0\n';
  }

  open(callback) {
    if (this.stallNextOpen) {
      this.stallNextOpen = false;
      this.pendingOpen = callback;
      return;
    }
    this.isOpen = true;
    callback(null);
  }

  completeOpen(error = null) {
    const callback = this.pendingOpen;
    assert.ok(callback, 'no pending open');
    this.pendingOpen = undefined;
    if (!error) this.isOpen = true;
    callback(error);
  }

  close(callback) {
    if (this.stallNextClose) {
      this.stallNextClose = false;
      this.pendingClose = callback;
      return;
    }
    if (this.failNextClose) {
      this.failNextClose = false;
      callback(new Error('serial-close-failed'));
      return;
    }
    if (this.closeErrorAfterPhysicalClose) {
      this.closeErrorAfterPhysicalClose = false;
      this.isOpen = false;
      callback(new Error('serial-close-failed-after-close'));
      return;
    }
    this.isOpen = false;
    const error = new Error('serial-port-closed');
    if (this.activeWrite) {
      this.activeWrite.callback(error);
      this.activeWrite = undefined;
      this.closeErrorHadListener = this.listenerCount('error') > 0;
      this.emit('error', error);
    }
    for (const write of this.pendingWrites.splice(0)) write.callback(error);
    callback(null);
  }

  set(options, callback) {
    const copiedOptions = { ...options };
    this.signalSets.push(copiedOptions);
    this.operations.push({ type: 'set', options: copiedOptions });
    if (this.stallNextSet) {
      this.stallNextSet = false;
      return;
    }
    const error = this.failNextSet ? new Error('serial-set-failed') : null;
    this.failNextSet = false;
    queueMicrotask(() => callback(error));
  }

  completeClose() {
    const callback = this.pendingClose;
    assert.ok(callback, 'no pending close');
    this.pendingClose = undefined;
    this.close(callback);
  }

  completeWrite(error = null) {
    const write = this.activeWrite;
    assert.ok(write, 'no active write');
    this.activeWrite = undefined;
    write.callback(error);
    this.flushWrites();
  }

  write(payload, callback) {
    if (this.throwNextWrite) {
      this.throwNextWrite = false;
      throw new Error('serial-write-threw');
    }
    this.writes.push(payload);
    this.operations.push({ type: 'write', payload });
    const write = {
      callback,
      error: this.failNextWrite ? new Error('serial-write-failed') : null,
      stalled: this.stallNextWrite
    };
    this.failNextWrite = false;
    this.stallNextWrite = false;
    this.pendingWrites.push(write);
    this.flushWrites();
    if (this.probeReply && payload.includes('D1')) {
      const reply = this.probeReply;
      queueMicrotask(() => this.emit('data', Buffer.from(reply)));
    }
    return true;
  }

  flushWrites() {
    if (!this.isOpen || this.activeWrite) return;
    const write = this.pendingWrites.shift();
    if (!write) return;
    this.activeWrite = write;
    if (write.stalled) return;
    queueMicrotask(() => {
      if (this.activeWrite !== write) return;
      this.activeWrite = undefined;
      write.callback(write.error);
      this.flushWrites();
    });
  }
}

class RestartingTCodePort extends FakePort {
  constructor(path) {
    super(path);
    this.probeReply = undefined;
    this.probeAttempts = 0;
  }

  write(payload, callback) {
    const accepted = super.write(payload, callback);
    if (!payload.includes('D1')) return accepted;

    this.probeAttempts += 1;
    const reply = this.probeAttempts === 1
      ? 'rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)\nclk_drv:0x00\nentry 0x400805e4\n'
      : 'TCode v0.3\nL0 V0\n';
    queueMicrotask(() => this.emit('data', Buffer.from(reply)));
    return accepted;
  }
}

class SerialPortFaithfulFake extends FakePort {
  constructor(path) {
    super(path);
    this.physicalOpen = false;
    this.closing = false;
  }

  get isOpen() {
    return this.physicalOpen && !this.closing;
  }

  set isOpen(value) {
    this.physicalOpen = value;
    if (!value) this.closing = false;
  }

  open(callback) {
    this.physicalOpen = true;
    this.closing = false;
    callback(null);
  }

  close(callback) {
    this.closing = true;
    if (this.stallNextClose) {
      this.stallNextClose = false;
      this.pendingClose = callback;
      return;
    }
    if (this.failNextClose) {
      this.failNextClose = false;
      this.closing = false;
      callback(new Error('serial-close-failed'));
      return;
    }
    this.physicalOpen = false;
    this.closing = false;
    callback(null);
  }

  completeClose(error = null) {
    const callback = this.pendingClose;
    assert.ok(callback, 'no pending close');
    this.pendingClose = undefined;
    this.closing = false;
    if (!error) this.physicalOpen = false;
    callback(error);
  }
}

if (runRegression('hardware-readiness')) {
  const profile = {
    baudRate: 115200,
    linearAxis: 'L0',
    vibrationAxis: undefined,
    strokeMin: 0.2,
    strokeMax: 0.8,
    stopPosition: 0.35,
    invertPosition: false
  };
  const frame = { position: 0.5, intensity: 0.1, timestamp: 1_000 };

  const readyPort = new FakePort('COM3');
  const readyDiagnostics = [];
  const readyController = new HardwareController({
    createPort: () => readyPort,
    onDiagnostic: event => readyDiagnostics.push(event),
    probeTimeoutMs: 0,
    writeTimeoutMs: 20,
    lifecycleTimeoutMs: 20
  });
  const readyResult = await readyController.connect('COM3', profile);
  assert.deepEqual(readyPort.signalSets, [{ dtr: true, rts: true }]);
  assert.deepEqual(readyPort.operations.slice(0, 2).map(operation => operation.type), ['set', 'write']);
  assert.equal(readyResult.probe.version, 'v0.3');
  assert.deepEqual(readyController.getConnectionStatus(), { connected: true, path: 'COM3' });
  assert.equal(
    readyDiagnostics.some(event => event.event === 'hardware-control-signals-configured'
      && event.data.portPath === 'COM3'
      && event.data.dtr === true
      && event.data.rts === true),
    true
  );
  assert.equal(
    readyDiagnostics.some(event => event.event === 'hardware-ready'
      && event.data.portPath === 'COM3'
      && event.data.version === 'v0.3'),
    true
  );
  assert.deepEqual(readyController.queueMotion(frame), { queued: true });
  await readyController.disconnect();

  const restartingPort = new RestartingTCodePort('COM7');
  const restartingController = new HardwareController({
    createPort: () => restartingPort,
    probeTimeoutMs: 40,
    writeTimeoutMs: 20,
    lifecycleTimeoutMs: 20
  });
  const restartingResult = await restartingController.connect('COM7', profile);
  assert.equal(restartingPort.probeAttempts, 2, 'probe retries after the control-line reset boot output');
  assert.equal(restartingResult.probe.version, 'v0.3');
  await restartingController.disconnect();

  const setFailurePort = new FakePort('COM4');
  setFailurePort.failNextSet = true;
  const setFailureController = new HardwareController({
    createPort: () => setFailurePort,
    probeTimeoutMs: 0,
    writeTimeoutMs: 20,
    lifecycleTimeoutMs: 20
  });
  await assert.rejects(setFailureController.connect('COM4', profile), /serial-set-failed/);
  await waitFor(() => !setFailurePort.isOpen);
  assert.deepEqual(setFailureController.getConnectionStatus(), { connected: false });

  const setTimeoutPort = new FakePort('COM6');
  setTimeoutPort.stallNextSet = true;
  const setTimeoutController = new HardwareController({
    createPort: () => setTimeoutPort,
    probeTimeoutMs: 0,
    writeTimeoutMs: 20,
    lifecycleTimeoutMs: 10
  });
  await assert.rejects(
    setTimeoutController.connect('COM6', profile),
    /hardware-control-signals-timeout/
  );
  await waitFor(() => !setTimeoutPort.isOpen);

  const noReplyPort = new FakePort('COM5');
  noReplyPort.probeReply = undefined;
  const noReplyController = new HardwareController({
    createPort: () => noReplyPort,
    probeTimeoutMs: 30,
    writeTimeoutMs: 20,
    lifecycleTimeoutMs: 20
  });
  const noReplyConnect = noReplyController.connect('COM5', profile);
  await waitFor(() => noReplyPort.writes.some(payload => payload.includes('D1')));
  assert.deepEqual(
    noReplyController.queueMotion(frame),
    { queued: false, reason: 'hardware-not-ready' }
  );
  assert.deepEqual(
    await noReplyController.runTestPattern(),
    { tested: false, reason: 'hardware-not-ready' }
  );
  await assert.rejects(noReplyConnect, /hardware-tcode-not-ready/);
  await waitFor(() => !noReplyPort.isOpen);
  assert.deepEqual(noReplyController.getConnectionStatus(), { connected: false });
}

const cadenceOutputs = [];
const cadencePort = new FakePort('COM8');
const cadenceController = new HardwareController({
  onOutput: output => cadenceOutputs.push(output),
  createPort: () => cadencePort,
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});

await cadenceController.connect('COM8', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});
cadenceController.queueMotion({
  position: 0.4,
  intensity: 0.1,
  timestamp: 1_000,
  sourceTimeMs: 1_000,
  durationMs: 1000 / 30
});
await waitFor(() => cadenceOutputs.length === 1);
assert.equal(
  cadenceOutputs[0].command,
  'L04000I33',
  'hardware interpolation follows the source frame cadence instead of forcing 60Hz motion'
);
cadenceController.queueMotion({
  position: 0.41,
  intensity: 0.1,
  timestamp: 1_100,
  sourceTimeMs: 1_100,
  durationMs: 1000 / 30
});
await waitFor(() => cadenceOutputs.length === 2);
assert.equal(
  cadenceOutputs[1].command,
  'L04100I100',
  'coalesced relay frames use their real source-time gap instead of sprinting to the next target'
);
cadenceController.queueMotion({
  position: 0.42,
  intensity: 0.1,
  timestamp: 1_101,
  sourceTimeMs: 1_101,
  durationMs: 1
});
await waitFor(() => cadenceOutputs.length === 3);
assert.equal(
  cadenceOutputs[2].command,
  'L04200I17',
  'source metadata cannot request motion faster than the hardware output limit'
);
cadenceController.queueMotion({
  position: 0.43,
  intensity: 0.1,
  timestamp: 27_101,
  sourceTimeMs: 27_101,
  durationMs: 1000 / 30
});
await waitFor(() => cadenceOutputs.length === 4);
assert.equal(
  cadenceOutputs[3].command,
  'L04300I2000',
  'a stale source-time gap cannot become an unbounded hardware interpolation interval'
);
await cadenceController.disconnect();

const outputs = [];
const logs = [];
let port;
const controller = new HardwareController({
  onLog: entry => logs.push(entry),
  onOutput: output => outputs.push(output),
  createPort: options => {
    port = new FakePort(options.path);
    return port;
  },
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});

await controller.connect('COM9', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});

controller.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() });
await waitFor(() => outputs.length === 1);
assert.equal(outputs.length, 1);
assert.deepEqual(outputs[0], {
  kind: 'motion',
  command: 'L05000I17',
  completedAt: outputs[0].completedAt,
  portPath: 'COM9',
  baudRate: 115200
});
assert.ok(Number.isFinite(outputs[0].completedAt));

port.failNextWrite = true;
controller.queueMotion({ position: 0.7, intensity: 0.25, timestamp: Date.now() });
await waitFor(() => !controller.getConnectionStatus().connected);
assert.equal(outputs.length, 1, 'failed writes do not report successful output');
assert.ok(logs.some(entry => entry.message === 'hardware-motion-write-failed'));
assert.deepEqual(
  controller.queueMotion({ position: 0.8, intensity: 0.25, timestamp: Date.now() }),
  { queued: false, reason: 'hardware-not-connected' },
  'a callback write error fails closed instead of accepting more motion'
);

await controller.connect('COM9', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});

const outputsBeforeStall = outputs.length;
port.stallNextWrite = true;
controller.queueMotion({ position: 0.6, intensity: 0.25, timestamp: Date.now() });
await waitFor(() => logs.some(entry => entry.message === 'hardware-motion-write-failed' && entry.details === 'hardware-write-timeout'));
assert.ok(
  logs.some(entry => entry.message === 'hardware-motion-write-failed' && entry.details === 'hardware-write-timeout'),
  `a stalled motion write is rejected after the bounded timeout: ${JSON.stringify(logs)}`
);
assert.equal(port.closeErrorHadListener, true, 'close-induced write errors retain an error listener');
assert.deepEqual(
  controller.queueMotion({ position: 0.8, intensity: 0.25, timestamp: Date.now() }),
  { queued: false, reason: 'hardware-not-connected' },
  'a timed-out port fails closed instead of buffering more writes behind the stall'
);

await controller.connect('COM9', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});
controller.queueMotion({ position: 0.8, intensity: 0.25, timestamp: Date.now() });
await waitFor(() => outputs.length === outputsBeforeStall + 1);
assert.equal(outputs.length, outputsBeforeStall + 1, 'motion output recovers after reconnecting the failed port');
assert.equal(outputs.at(-1).command, 'L08000I17');

port.stallNextWrite = true;
const stalledStopPromise = controller.latchEmergencyStop();
assert.deepEqual(
  controller.getEmergencyStopState(),
  { emergencyStopped: true },
  'the emergency latch is set before the stop write settles'
);
const stalledStopResult = await Promise.race([
  stalledStopPromise,
  delay(100).then(() => ({ timedOut: true }))
]);
assert.deepEqual(
  stalledStopResult,
  { stopped: false, reason: 'hardware-stop-write-failed', emergencyStopped: true },
  'emergency stop fails within the bounded write timeout instead of hanging'
);
assert.deepEqual(controller.getEmergencyStopState(), { emergencyStopped: true });
assert.ok(
  logs.some(entry => entry.message === 'hardware-stop-write-failed' && entry.details === 'hardware-write-timeout'),
  'a stalled emergency stop is logged'
);
controller.releaseEmergencyStop();

await controller.connect('COM9', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});
assert.doesNotThrow(
  () => port.emit('error', new Error('serial-port-fault')),
  'port errors are handled instead of terminating the Electron main process'
);
assert.ok(
  logs.some(entry => entry.message === 'hardware-port-error' && entry.details === 'serial-port-fault'),
  'port errors are logged'
);
assert.deepEqual(
  controller.queueMotion({ position: 0.4, intensity: 0.25, timestamp: Date.now() }),
  { queued: false, reason: 'hardware-not-connected' },
  'a port error transitions the controller to a disconnected state'
);

await controller.connect('COM9', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0.2,
  strokeMax: 0.8,
  stopPosition: 0.3,
  invertPosition: true
});
assert.deepEqual(await controller.latchEmergencyStop(), { stopped: true, emergencyStopped: true });
assert.equal(outputs.at(-1).kind, 'stop');
assert.equal(outputs.at(-1).command, 'DSTOP\nL03000I1');
assert.deepEqual(
  controller.getConnectionStatus(),
  { connected: true, path: 'COM9' },
  'a successful normal emergency stop keeps the healthy port connected'
);
controller.releaseEmergencyStop();

const latchOutputs = [];
let latchPort;
const latchController = new HardwareController({
  createPort: options => {
    latchPort = new FakePort(options.path);
    return latchPort;
  },
  onOutput: output => latchOutputs.push(output),
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
assert.deepEqual(latchController.getEmergencyStopState(), { emergencyStopped: false });
await latchController.connect('COM21', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0.2,
  strokeMax: 0.8,
  stopPosition: 0.35,
  invertPosition: false
});
assert.deepEqual(
  await latchController.latchEmergencyStop(),
  { stopped: true, emergencyStopped: true }
);
assert.equal(latchOutputs.at(-1).command, 'DSTOP\nL03500I1');
assert.deepEqual(
  latchController.queueMotion({ position: 0.8, intensity: 0.25, timestamp: Date.now() }),
  { queued: false, reason: 'hardware-emergency-stopped' }
);
assert.deepEqual(
  await latchController.runTestPattern(),
  { tested: false, reason: 'hardware-emergency-stopped' }
);
const writesBeforeRelease = latchPort.writes.length;
assert.deepEqual(latchController.releaseEmergencyStop(), { emergencyStopped: false });
assert.equal(latchPort.writes.length, writesBeforeRelease, 'release emits no serial payload');
assert.deepEqual(
  latchController.queueMotion({ position: 0.8, intensity: 0.25, timestamp: Date.now() }),
  { queued: true }
);
await waitFor(() => latchOutputs.at(-1)?.kind === 'motion');

const releasedDuringSuccessfulStopPort = new FakePort('COM31');
const releasedDuringSuccessfulStopController = new HardwareController({
  createPort: () => releasedDuringSuccessfulStopPort,
  probeTimeoutMs: 0,
  writeTimeoutMs: 100
});
await releasedDuringSuccessfulStopController.connect('COM31', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  stopPosition: 0.35,
  invertPosition: false
});
releasedDuringSuccessfulStopPort.stallNextWrite = true;
const releasedSuccessfulStop = releasedDuringSuccessfulStopController.latchEmergencyStop();
assert.deepEqual(releasedDuringSuccessfulStopController.getEmergencyStopState(), { emergencyStopped: true });
assert.deepEqual(releasedDuringSuccessfulStopController.releaseEmergencyStop(), { emergencyStopped: false });
assert.equal(
  releasedDuringSuccessfulStopController.queueMotion({ position: 0.6, intensity: 0.25, timestamp: Date.now() }).queued,
  true,
  'explicit release admits motion while the earlier stop write is pending'
);
releasedDuringSuccessfulStopPort.completeWrite();
assert.deepEqual(await releasedSuccessfulStop, { stopped: true, emergencyStopped: false });
assert.deepEqual(releasedDuringSuccessfulStopController.getEmergencyStopState(), { emergencyStopped: false });
await releasedDuringSuccessfulStopController.disconnect();

const releasedDuringFailedStopPort = new FakePort('COM32');
const releasedDuringFailedStopController = new HardwareController({
  createPort: () => releasedDuringFailedStopPort,
  probeTimeoutMs: 0,
  writeTimeoutMs: 100
});
await releasedDuringFailedStopController.connect('COM32', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  stopPosition: 0.35,
  invertPosition: false
});
releasedDuringFailedStopPort.stallNextWrite = true;
const releasedFailedStop = releasedDuringFailedStopController.latchEmergencyStop();
assert.deepEqual(releasedDuringFailedStopController.getEmergencyStopState(), { emergencyStopped: true });
releasedDuringFailedStopController.releaseEmergencyStop();
assert.equal(
  releasedDuringFailedStopController.queueMotion({ position: 0.6, intensity: 0.25, timestamp: Date.now() }).queued,
  true,
  'explicit release wins before a failed stop write settles'
);
releasedDuringFailedStopPort.completeWrite(new Error('stop-write-failed-after-release'));
assert.deepEqual(await releasedFailedStop, {
  stopped: false,
  reason: 'hardware-stop-write-failed',
  emergencyStopped: false
});
assert.deepEqual(releasedDuringFailedStopController.getEmergencyStopState(), { emergencyStopped: false });

assert.deepEqual(
  await latchController.latchEmergencyStop(),
  { stopped: true, emergencyStopped: true }
);
assert.deepEqual(await latchController.setProtection({
  intensityLimit: 1,
  positionMin: 0,
  positionMax: 1,
  paused: false
}), {
  protection: { intensityLimit: 1, positionMin: 0, positionMax: 1, paused: false }
});
assert.deepEqual(latchController.getEmergencyStopState(), { emergencyStopped: true });

await latchController.disconnect();
await latchController.connect('COM22', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0.2,
  strokeMax: 0.8,
  stopPosition: 0.35,
  invertPosition: false
});
assert.deepEqual(latchController.getEmergencyStopState(), { emergencyStopped: true });
assert.deepEqual(latchController.releaseEmergencyStop(), { emergencyStopped: false });

const writesBeforePause = latchPort.writes.length;
const pausedProtection = await latchController.setProtection({
  intensityLimit: 1,
  positionMin: 0,
  positionMax: 1,
  paused: true
});
assert.deepEqual(pausedProtection, {
  protection: { intensityLimit: 1, positionMin: 0, positionMax: 1, paused: true }
});
assert.equal(latchPort.writes.length, writesBeforePause, 'pausing receive emits no stop payload');
assert.deepEqual(latchController.releaseEmergencyStop(), { emergencyStopped: false });
assert.deepEqual(
  latchController.queueMotion({ position: 0.8, intensity: 0.25, timestamp: Date.now() }),
  { queued: false, reason: 'protection-paused' },
  'releasing an emergency stop does not unpause protection'
);
await latchController.setProtection({
  intensityLimit: 1,
  positionMin: 0,
  positionMax: 1,
  paused: false
});
const testOutputStart = latchOutputs.length;
assert.deepEqual(await latchController.runTestPattern(), { tested: true, steps: 4 });
assert.equal(
  latchOutputs.slice(testOutputStart).some(output => output.kind === 'stop'),
  false,
  'normal hardware test completion emits no stop output'
);
await latchController.disconnect();

const roomExitOutputs = [];
const roomExitPort = new FakePort('COM24');
const roomExitController = new HardwareController({
  createPort: () => roomExitPort,
  onOutput: output => roomExitOutputs.push(output),
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await roomExitController.connect('COM24', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  stopPosition: 0.35,
  invertPosition: false
});
assert.deepEqual(await roomExitController.stopForRoomExit(), { stopped: true });
assert.equal(roomExitOutputs.at(-1).command, 'DSTOP\nL03500I1');
assert.deepEqual(
  roomExitController.getEmergencyStopState(),
  { emergencyStopped: false },
  'a room-exit stop does not create an emergency latch'
);
const roomExitWritesAfterStop = roomExitPort.writes.length;
assert.deepEqual(
  roomExitController.queueMotion({ position: 0.8, intensity: 0.25, timestamp: Date.now() }),
  { queued: true }
);
await waitFor(() => roomExitPort.writes.length === roomExitWritesAfterStop + 1);
assert.equal(roomExitOutputs.at(-1).kind, 'motion', 'motion resumes after a room-exit stop');
assert.deepEqual(
  await roomExitController.latchEmergencyStop(),
  { stopped: true, emergencyStopped: true }
);
assert.deepEqual(await roomExitController.stopForRoomExit(), { stopped: true });
assert.deepEqual(
  roomExitController.getEmergencyStopState(),
  { emergencyStopped: true },
  'a room-exit stop preserves an existing emergency latch'
);
await roomExitController.disconnect();

const newController = new HardwareController({ probeTimeoutMs: 0, writeTimeoutMs: 20 });
assert.deepEqual(newController.getEmergencyStopState(), { emergencyStopped: false });

await controller.disconnect();

const cancelledPatternOutputs = [];
const cancelledPatternPort = new FakePort('COM19');
const cancelledPatternController = new HardwareController({
  createPort: () => cancelledPatternPort,
  onOutput: output => cancelledPatternOutputs.push(output),
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await cancelledPatternController.connect('COM19', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0.2,
  strokeMax: 0.8,
  stopPosition: 0.3,
  invertPosition: false
});
const cancelledPattern = cancelledPatternController.runTestPattern();
await delay(40);
assert.deepEqual(
  await cancelledPatternController.latchEmergencyStop(),
  { stopped: true, emergencyStopped: true }
);
assert.deepEqual(await cancelledPattern, { tested: false, reason: 'hardware-test-cancelled' });
const cancellationStopIndex = cancelledPatternOutputs.findIndex(output => output.kind === 'stop');
assert.notEqual(cancellationStopIndex, -1, 'emergency stop output is recorded during the test pattern');
assert.equal(
  cancelledPatternOutputs.slice(cancellationStopIndex + 1).some(output => output.kind === 'test'),
  false,
  'no test motion is written after an emergency stop cancels the pattern'
);
await cancelledPatternController.disconnect();

const finalDelayOutputs = [];
const finalDelayPort = new FakePort('COM25');
const finalDelayController = new HardwareController({
  createPort: () => finalDelayPort,
  onOutput: output => finalDelayOutputs.push(output),
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await finalDelayController.connect('COM25', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0.2,
  strokeMax: 0.8,
  stopPosition: 0.3,
  invertPosition: false
});
const finalDelayPattern = finalDelayController.runTestPattern();
await waitFor(() => finalDelayOutputs.filter(output => output.kind === 'test').length === 4, 1000);
assert.deepEqual(
  await finalDelayController.latchEmergencyStop(),
  { stopped: true, emergencyStopped: true }
);
assert.deepEqual(
  await finalDelayPattern,
  { tested: false, reason: 'hardware-test-cancelled' },
  'an emergency during the final test delay cancels the pattern before success'
);
const finalDelayStopIndex = finalDelayOutputs.findIndex(output => output.kind === 'stop');
assert.notEqual(finalDelayStopIndex, -1, 'the final-delay emergency writes a stop payload');
assert.equal(
  finalDelayOutputs.slice(finalDelayStopIndex + 1).some(output => output.kind === 'test'),
  false,
  'no test output follows the final-delay emergency stop'
);
await finalDelayController.disconnect();

const inactivityOutputs = [];
const inactivityPort = new FakePort('COM23');
const inactivityController = new HardwareController({
  createPort: () => inactivityPort,
  onOutput: output => inactivityOutputs.push(output),
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await inactivityController.connect('COM23', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  stopPosition: 0.3,
  invertPosition: false
});
assert.deepEqual(
  inactivityController.queueMotion({ position: 0.7, intensity: 0.25, timestamp: 1_000 }),
  { queued: true }
);
await waitFor(() => inactivityOutputs.length === 1);
assert.deepEqual(
  inactivityController.queueMotion({ position: 0.7, intensity: 0.25, timestamp: 1_017 }),
  { queued: true }
);
await waitFor(() => inactivityOutputs.length === 2);
assert.deepEqual(inactivityOutputs.map(output => output.command), ['L07000I17', 'L07000I17']);
await delay(1100);
assert.equal(inactivityOutputs.length, 2, 'inactivity emits no additional hardware output');
assert.equal(
  inactivityOutputs.every(output => output.kind === 'motion'),
  true,
  'inactivity output remains motion-only'
);
assert.equal(
  inactivityPort.writes.some(payload => payload.includes('DSTOP')),
  false,
  'inactivity emits no DSTOP serial payload'
);
await inactivityController.disconnect();

const probePort = new FakePort();
probePort.probeReply = undefined;
const probeController = new HardwareController({
  createPort: () => probePort,
  probeTimeoutMs: 50,
  writeTimeoutMs: 20
});
const probeConnect = probeController.connect('COM10', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});
setTimeout(() => probePort.emit('error', new Error('probe-port-fault')), 10);
await assert.rejects(
  probeConnect,
  /hardware-connection-lost/,
  'a port error while waiting for the probe response rejects connect'
);

const closedProbePort = new FakePort('COM11');
closedProbePort.probeReply = undefined;
const closedProbeController = new HardwareController({
  createPort: () => closedProbePort,
  probeTimeoutMs: 50,
  writeTimeoutMs: 20
});
const closedProbeConnect = closedProbeController.connect('COM11', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});
setTimeout(() => {
  closedProbePort.isOpen = false;
  closedProbePort.emit('close');
}, 10);
await assert.rejects(
  closedProbeConnect,
  /hardware-connection-lost/,
  'a close-only event while waiting for the probe response rejects connect'
);

const closeFailurePort = new FakePort('COM12');
const closeFailureController = new HardwareController({
  createPort: () => closeFailurePort,
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await closeFailureController.connect('COM12', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});
closeFailurePort.failNextClose = true;
await assert.rejects(closeFailureController.disconnect(), /serial-close-failed/);
assert.equal(closeFailurePort.isOpen, true, 'a failed close leaves the physical port open');
assert.equal(
closeFailureController.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() }).queued,
  true,
  'a failed disconnect restores the open port so it can be controlled or disconnected again'
);
await waitFor(() => closeFailurePort.writes.some(payload => payload.trim() === 'L05000I17'));
await closeFailureController.disconnect();

const safeDisconnectOutputs = [];
const safeDisconnectStatuses = [];
const safeDisconnectPort = new FakePort('COM13');
const safeDisconnectController = new HardwareController({
  createPort: () => safeDisconnectPort,
  onOutput: output => safeDisconnectOutputs.push(output),
  onConnectionStatus: status => safeDisconnectStatuses.push(status),
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await safeDisconnectController.connect('COM13', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  stopPosition: 0.6,
  invertPosition: false
});
assert.deepEqual(safeDisconnectController.getConnectionStatus(), { connected: true, path: 'COM13' });
safeDisconnectPort.stallNextClose = true;
const writesBeforeSafeDisconnect = safeDisconnectPort.writes.length;
const outputsBeforeSafeDisconnect = safeDisconnectOutputs.length;
const safeDisconnectPromise = safeDisconnectController.disconnect();
assert.deepEqual(
  safeDisconnectController.queueMotion({ position: 0.8, intensity: 0.25, timestamp: Date.now() }),
  { queued: false, reason: 'hardware-disconnecting' },
  'safe disconnect rejects motion while the stop and serial close are pending'
);
await waitFor(() => safeDisconnectPort.writes.length === writesBeforeSafeDisconnect + 1);
assert.equal(safeDisconnectPort.writes.at(-1).trim(), 'DSTOP\nL06000I1');
assert.equal(safeDisconnectOutputs.length, outputsBeforeSafeDisconnect + 1);
assert.equal(safeDisconnectOutputs.at(-1).kind, 'stop');
await waitFor(() => safeDisconnectPort.pendingClose !== undefined);
safeDisconnectPort.completeClose();
assert.deepEqual(await safeDisconnectPromise, { connected: false });
assert.deepEqual(safeDisconnectStatuses, [
  { connected: true, path: 'COM13' },
  { connected: false, reason: 'hardware-disconnected', unexpected: false }
]);

const boundedDisconnectPort = new FakePort('COM60');
const boundedDisconnectController = new HardwareController({
  createPort: () => boundedDisconnectPort,
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await boundedDisconnectController.connect('COM60', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0.3,
  strokeMax: 0.8,
  stopPosition: 0.5,
  invertPosition: false
});
boundedDisconnectPort.stallNextWrite = true;
const boundedDisconnectStartedAt = Date.now();
const boundedDisconnectPromise = boundedDisconnectController.disconnect();
await waitFor(() => boundedDisconnectPort.writes.at(-1)?.includes('DSTOP'));
assert.equal(boundedDisconnectPort.isOpen, true, 'the port remains open while the bounded stop write is pending');
assert.deepEqual(await boundedDisconnectPromise, { connected: false });
assert.equal(boundedDisconnectPort.isOpen, false, 'the port closes after the stop write timeout');
assert.equal(Date.now() - boundedDisconnectStartedAt < 500, true, 'a stalled stop cannot block disconnect beyond 500ms');

if (runRegression('simultaneous-connect')) {
  const simultaneousConnectPorts = [];
  const simultaneousConnectStatuses = [];
  const simultaneousConnectController = new HardwareController({
    createPort: options => {
      const createdPort = new FakePort(options.path);
      simultaneousConnectPorts.push(createdPort);
      return createdPort;
    },
    onConnectionStatus: status => simultaneousConnectStatuses.push(status),
    probeTimeoutMs: 0,
    writeTimeoutMs: 20
  });
  const simultaneousProfile = {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  };
  const firstConnect = simultaneousConnectController.connect('COM39', simultaneousProfile);
  const secondConnect = simultaneousConnectController.connect('COM39', simultaneousProfile);
  assert.strictEqual(secondConnect, firstConnect, 'identical simultaneous connect calls share one promise');
  assert.equal((await firstConnect).path, 'COM39');
  assert.equal(simultaneousConnectPorts.length, 1, 'simultaneous connect creates one physical port');
  assert.equal(simultaneousConnectPorts[0].isOpen, true);
  assert.equal(simultaneousConnectPorts[0].listenerCount('error'), 1);
  assert.equal(simultaneousConnectPorts[0].listenerCount('close'), 1);
  assert.deepEqual(simultaneousConnectStatuses, [{ connected: true, path: 'COM39' }]);
  await simultaneousConnectController.disconnect();
  await delay(0);
  assert.equal(simultaneousConnectPorts[0].listenerCount('error'), 0);
  assert.equal(simultaneousConnectPorts[0].listenerCount('close'), 0);
}

if (runRegression('disconnect-during-open')) {
  const pendingOpenPorts = [];
  const pendingOpenStatuses = [];
  const pendingOpenController = new HardwareController({
    createPort: options => {
      const createdPort = new FakePort(options.path);
      createdPort.stallNextOpen = true;
      pendingOpenPorts.push(createdPort);
      return createdPort;
    },
    onConnectionStatus: status => pendingOpenStatuses.push(status),
    probeTimeoutMs: 0,
    writeTimeoutMs: 20
  });
  const pendingConnect = pendingOpenController.connect('COM40', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  await waitFor(() => pendingOpenPorts.length === 1 && pendingOpenPorts[0].pendingOpen !== undefined);
  const pendingPort = pendingOpenPorts[0];
  let pendingDisconnectSettled = false;
  const pendingDisconnect = pendingOpenController.disconnect();
  pendingDisconnect.then(
    () => { pendingDisconnectSettled = true; },
    () => { pendingDisconnectSettled = true; }
  );
  await delay(0);
  assert.equal(pendingDisconnectSettled, false, 'disconnect waits for the owned pending open');
  pendingPort.completeOpen();
  assert.equal((await pendingConnect).path, 'COM40');
  assert.deepEqual(await pendingDisconnect, { connected: false });
  await delay(0);
  assert.equal(pendingOpenPorts.length, 1);
  assert.equal(pendingPort.isOpen, false, 'the newly opened port is closed before disconnect settles');
  assert.equal(pendingPort.listenerCount('error'), 0);
  assert.equal(pendingPort.listenerCount('close'), 0);
  assert.deepEqual(pendingOpenStatuses, [
    { connected: true, path: 'COM40' },
    { connected: false, reason: 'hardware-disconnected', unexpected: false }
  ]);
  assert.deepEqual(pendingOpenController.getConnectionStatus(), {
    connected: false,
    reason: 'hardware-disconnected',
    unexpected: false
  });
  assert.deepEqual(
    pendingOpenController.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() }),
    { queued: false, reason: 'hardware-not-connected' }
  );
}

if (runRegression('connect-disconnect-room-exit')) {
  let orderedLifecyclePort;
  const orderedLifecycleController = new HardwareController({
    createPort: options => {
      orderedLifecyclePort = new FakePort(options.path);
      orderedLifecyclePort.stallNextOpen = true;
      return orderedLifecyclePort;
    },
    probeTimeoutMs: 0,
    writeTimeoutMs: 20
  });
  const orderedConnect = orderedLifecycleController.connect('COM41', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  await waitFor(() => orderedLifecyclePort?.pendingOpen !== undefined);
  const orderedDisconnect = orderedLifecycleController.disconnect();
  const orderedRoomExit = orderedLifecycleController.stopForRoomExit();
  orderedLifecyclePort.completeOpen();
  const orderedResult = await Promise.race([
    Promise.all([orderedConnect, orderedDisconnect, orderedRoomExit]),
    delay(100).then(() => ({ timedOut: true }))
  ]);
  assert.deepEqual(orderedResult, [
    {
      connected: true,
      path: 'COM41',
      baudRate: 115200,
      profile: {
        baudRate: 115200,
        linearAxis: 'L0',
        vibrationAxis: undefined,
        strokeMin: 0,
        strokeMax: 1,
        stopPosition: 0,
        invertPosition: false
      },
      probe: { detected: true, raw: ['TCode v0.3', 'L0 V0'], version: 'v0.3', axes: ['L0', 'V0'] }
    },
    { connected: false },
    { stopped: false, reason: 'hardware-not-connected' }
  ], 'connect, disconnect, and later room-exit settle without a dependency cycle');
  assert.equal(orderedLifecyclePort.isOpen, false);
}

if (runRegression('queued-connect-then-disconnect')) {
  const queuedConnectPorts = [];
  const queuedConnectStatuses = [];
  const queuedConnectController = new HardwareController({
    createPort: options => {
      const createdPort = new FakePort(options.path);
      if (queuedConnectPorts.length === 0) createdPort.stallNextOpen = true;
      queuedConnectPorts.push(createdPort);
      return createdPort;
    },
    onConnectionStatus: status => queuedConnectStatuses.push(status),
    probeTimeoutMs: 0,
    writeTimeoutMs: 20
  });
  const queuedConnectA = queuedConnectController.connect('COM42', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  await waitFor(() => queuedConnectPorts[0]?.pendingOpen !== undefined);
  const queuedConnectB = queuedConnectController.connect('COM43', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  const disconnectAfterQueuedConnects = queuedConnectController.disconnect();
  queuedConnectPorts[0].completeOpen();
  const queuedOrderingResult = await Promise.race([
    Promise.all([queuedConnectA, queuedConnectB, disconnectAfterQueuedConnects]),
    delay(250).then(() => ({ timedOut: true }))
  ]);
  assert.equal(Array.isArray(queuedOrderingResult), true, 'queued connect ordering settles without deadlock');
  assert.equal(queuedOrderingResult[0].path, 'COM42');
  assert.equal(queuedOrderingResult[1].path, 'COM43');
  assert.deepEqual(queuedOrderingResult[2], { connected: false });
  await delay(0);
  assert.equal(queuedConnectPorts.length, 2);
  assert.equal(queuedConnectPorts.every(candidate => !candidate.isOpen), true, 'last disconnect closes all prior connect ports');
  assert.equal(queuedConnectPorts.every(candidate => candidate.listenerCount('error') === 0), true);
  assert.equal(queuedConnectPorts.every(candidate => candidate.listenerCount('close') === 0), true);
  assert.deepEqual(queuedConnectStatuses.at(-1), {
    connected: false,
    reason: 'hardware-disconnected',
    unexpected: false
  });
  assert.deepEqual(queuedConnectController.getConnectionStatus(), {
    connected: false,
    reason: 'hardware-disconnected',
    unexpected: false
  });
  assert.deepEqual(
    queuedConnectController.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() }),
    { queued: false, reason: 'hardware-not-connected' }
  );
}

if (runRegression('connect-disconnect-connect-room-exit')) {
  const orderedStopPorts = [];
  const orderedStopOutputs = [];
  const orderedStopStatuses = [];
  const orderedStopController = new HardwareController({
    createPort: options => {
      const createdPort = new FakePort(options.path);
      if (orderedStopPorts.length === 0) createdPort.stallNextOpen = true;
      orderedStopPorts.push(createdPort);
      return createdPort;
    },
    onOutput: output => orderedStopOutputs.push(output),
    onConnectionStatus: status => orderedStopStatuses.push(status),
    probeTimeoutMs: 0,
    writeTimeoutMs: 20
  });
  const orderedStopConnectA = orderedStopController.connect('COM44', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    stopPosition: 0.2,
    invertPosition: false
  });
  await waitFor(() => orderedStopPorts[0]?.pendingOpen !== undefined);
  const orderedStopDisconnect = orderedStopController.disconnect();
  const orderedStopConnectB = orderedStopController.connect('COM45', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    stopPosition: 0.45,
    invertPosition: false
  });
  const orderedRoomExit = orderedStopController.stopForRoomExit();
  assert.deepEqual(
    orderedStopController.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() }),
    { queued: false, reason: 'hardware-room-exit-stopping' },
    'the last room-exit request gates motion synchronously while earlier lifecycle work is pending'
  );
  orderedStopPorts[0].completeOpen();
  const orderedStopResult = await Promise.race([
    Promise.all([orderedStopConnectA, orderedStopDisconnect, orderedStopConnectB, orderedRoomExit]),
    delay(300).then(() => ({ timedOut: true }))
  ]);
  assert.equal(Array.isArray(orderedStopResult), true, 'ordered lifecycle requests settle without deadlock');
  assert.equal(orderedStopResult[0].path, 'COM44');
  assert.deepEqual(orderedStopResult[1], { connected: false });
  assert.equal(orderedStopResult[2].path, 'COM45');
  assert.deepEqual(orderedStopResult[3], { stopped: true });
  assert.equal(orderedStopPorts.length, 2);
  assert.equal(orderedStopPorts[0].isOpen, false);
  assert.equal(orderedStopPorts[0].listenerCount('error'), 0);
  assert.equal(orderedStopPorts[0].listenerCount('close'), 0);
  assert.equal(orderedStopPorts[1].isOpen, true);
  assert.equal(orderedStopPorts[1].listenerCount('error'), 1);
  assert.equal(orderedStopPorts[1].listenerCount('close'), 1);
  assert.equal(orderedStopPorts[1].writes.at(-1).trim(), 'DSTOP\nL04500I1');
  assert.equal(orderedStopOutputs.at(-1).kind, 'stop');
  assert.equal(orderedStopOutputs.at(-1).portPath, 'COM45');
  assert.deepEqual(orderedStopController.getConnectionStatus(), { connected: true, path: 'COM45' });
  assert.deepEqual(orderedStopController.getEmergencyStopState(), { emergencyStopped: false });
  await orderedStopController.disconnect();
}

if (runRegression('queued-connect-after-open-failure')) {
  const openFailureQueuePorts = [];
  const openFailureQueueController = new HardwareController({
    createPort: options => {
      const createdPort = new FakePort(options.path);
      if (openFailureQueuePorts.length === 0) createdPort.stallNextOpen = true;
      openFailureQueuePorts.push(createdPort);
      return createdPort;
    },
    probeTimeoutMs: 0,
    writeTimeoutMs: 20
  });
  const failedConnectA = openFailureQueueController.connect('COM46', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  await waitFor(() => openFailureQueuePorts[0]?.pendingOpen !== undefined);
  const queuedConnectAfterFailure = openFailureQueueController.connect('COM47', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  const queuedConnectAfterFailureResult = queuedConnectAfterFailure.then(
    value => ({ value }),
    error => ({ error })
  );
  const failedConnectAssertion = assert.rejects(failedConnectA, /serial-open-failed/);
  openFailureQueuePorts[0].completeOpen(new Error('serial-open-failed'));
  await failedConnectAssertion;
  const observedQueuedConnect = await queuedConnectAfterFailureResult;
  assert.equal(observedQueuedConnect.value?.path, 'COM47', 'later connect runs after predecessor rejection');
  assert.equal(openFailureQueuePorts.length, 2);
  assert.equal(openFailureQueuePorts[0].isOpen, false);
  assert.equal(openFailureQueuePorts[0].listenerCount('error'), 0);
  assert.equal(openFailureQueuePorts[0].listenerCount('close'), 0);
  assert.equal(openFailureQueuePorts[1].isOpen, true);
  assert.deepEqual(openFailureQueueController.getConnectionStatus(), { connected: true, path: 'COM47' });
  await openFailureQueueController.disconnect();
}

if (runRegression('room-exit-cancels-pending-motion')) {
  const pendingMotionPorts = [];
  const pendingMotionOutputs = [];
  const pendingMotionController = new HardwareController({
    createPort: options => {
      const createdPort = new FakePort(options.path);
      pendingMotionPorts.push(createdPort);
      return createdPort;
    },
    onOutput: output => pendingMotionOutputs.push(output),
    probeTimeoutMs: 0,
    writeTimeoutMs: 200
  });
  const pendingMotionConnect = pendingMotionController.connect('COM48', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    stopPosition: 0.48,
    invertPosition: false
  });
  await pendingMotionConnect;
  const pendingMotionPort = pendingMotionPorts[0];
  assert.deepEqual(
    pendingMotionController.queueMotion({ position: 0.6, intensity: 0.25, timestamp: Date.now() }),
    { queued: true }
  );
  const pendingMotionRoomExit = pendingMotionController.stopForRoomExit();
  await delay(60);
  assert.equal(
    pendingMotionPort.writes.length,
    2,
    'room-exit admission clears timer-pending motion before writing only the stop payload'
  );
  assert.equal(
    pendingMotionPort.writes.some(payload => payload.trim() === 'L06000I17'),
    false,
    'no queued motion reaches the serial port before the room-exit stop'
  );
  assert.deepEqual(await pendingMotionRoomExit, { stopped: true });
  assert.equal(pendingMotionOutputs.some(output => output.kind === 'motion'), false);
  assert.equal(pendingMotionOutputs.at(-1).kind, 'stop');
  await pendingMotionController.disconnect();
}

if (runRegression('test-during-room-exit-gate')) {
  const gatedPatternOutputs = [];
  const gatedPatternPort = new FakePort('COM49');
  const gatedPatternController = new HardwareController({
    createPort: () => gatedPatternPort,
    onOutput: output => gatedPatternOutputs.push(output),
    probeTimeoutMs: 0,
    writeTimeoutMs: 100
  });
  await gatedPatternController.connect('COM49', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    stopPosition: 0.49,
    invertPosition: false
  });
  const gatedPatternRoomExit = gatedPatternController.stopForRoomExit();
  assert.deepEqual(
    await gatedPatternController.runTestPattern(),
    { tested: false, reason: 'hardware-room-exit-stopping' },
    'a room-exit gate rejects a newly requested test pattern'
  );
  assert.deepEqual(await gatedPatternRoomExit, { stopped: true });
  assert.equal(
    gatedPatternOutputs.some(output => output.kind === 'test'),
    false,
    'a test requested behind the room-exit gate emits no test output'
  );
  await gatedPatternController.disconnect();
}

if (runRegression('disconnect-cancels-test-pattern')) {
  const gatedTestPorts = [];
  const gatedTestOutputs = [];
  const gatedTestController = new HardwareController({
    createPort: options => {
      const createdPort = new FakePort(options.path);
      gatedTestPorts.push(createdPort);
      return createdPort;
    },
    onOutput: output => gatedTestOutputs.push(output),
    probeTimeoutMs: 500,
    writeTimeoutMs: 100
  });
  const gatedTestConnect = gatedTestController.connect('COM50', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  await gatedTestConnect;
  const gatedTestPattern = gatedTestController.runTestPattern();
  await waitFor(() => gatedTestOutputs.filter(output => output.kind === 'test').length === 1);
  const gatedTestDisconnect = gatedTestController.disconnect();
  assert.deepEqual(
    await gatedTestPattern,
    { tested: false, reason: 'hardware-disconnecting' },
    'a disconnect gate installed mid-pattern owns the cancellation reason'
  );
  await delay(220);
  assert.equal(
    gatedTestOutputs.filter(output => output.kind === 'test').length,
    1,
    'a queued disconnect prevents every later test-pattern write'
  );
  assert.deepEqual(await gatedTestDisconnect, { connected: false });
}

if (runRegression('open-timeout-late-success')) {
  const openTimeoutPorts = [];
  const openTimeoutController = new HardwareController({
    createPort: options => {
      const createdPort = new FakePort(options.path);
      if (openTimeoutPorts.length === 0) createdPort.stallNextOpen = true;
      openTimeoutPorts.push(createdPort);
      return createdPort;
    },
    probeTimeoutMs: 0,
    writeTimeoutMs: 100,
    lifecycleTimeoutMs: 30
  });
  const timedOutConnect = openTimeoutController.connect('COM51', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  const timedOutConnectAssertion = assert.rejects(timedOutConnect, /hardware-open-timeout/);
  await waitFor(() => openTimeoutPorts[0]?.pendingOpen !== undefined);
  const roomExitAfterOpenTimeout = openTimeoutController.stopForRoomExit();
  await Promise.race([
    timedOutConnectAssertion,
    delay(150).then(() => assert.fail('open timeout did not settle'))
  ]);
  assert.deepEqual(
    await Promise.race([
      roomExitAfterOpenTimeout,
      delay(150).then(() => assert.fail('room exit remained blocked behind open timeout'))
    ]),
    { stopped: false, reason: 'hardware-not-connected' }
  );
  assert.deepEqual(
    openTimeoutController.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() }),
    { queued: false, reason: 'hardware-not-connected' },
    'the timed-out open and queued room-exit gates are cleaned'
  );
  assert.equal(openTimeoutPorts[0].listenerCount('error'), 0);
  assert.equal(openTimeoutPorts[0].listenerCount('close'), 0);

  const replacementConnect = await openTimeoutController.connect('COM52', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  assert.equal(replacementConnect.path, 'COM52');
  openTimeoutPorts[0].completeOpen();
  await waitFor(() => !openTimeoutPorts[0].isOpen);
  await delay(0);
  assert.equal(openTimeoutPorts[0].listenerCount('error'), 0, 'late-open cleanup leaves no error handler');
  assert.equal(openTimeoutPorts[0].listenerCount('close'), 0, 'late-open cleanup leaves no close handler');
  assert.equal(openTimeoutPorts[1].isOpen, true, 'late open completion does not close the replacement port');
  assert.deepEqual(openTimeoutController.getConnectionStatus(), { connected: true, path: 'COM52' });
  await openTimeoutController.disconnect();
}

if (runRegression('close-timeout-late-completion')) {
  const closeTimeoutPorts = [];
  const closeTimeoutController = new HardwareController({
    createPort: options => {
      const createdPort = new FakePort(options.path);
      closeTimeoutPorts.push(createdPort);
      return createdPort;
    },
    probeTimeoutMs: 0,
    writeTimeoutMs: 100,
    lifecycleTimeoutMs: 30
  });
  await closeTimeoutController.connect('COM53', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    stopPosition: 0.53,
    invertPosition: false
  });
  const timedOutClosePort = closeTimeoutPorts[0];
  timedOutClosePort.stallNextClose = true;
  const timedOutDisconnect = closeTimeoutController.disconnect();
  const timedOutDisconnectAssertion = assert.rejects(timedOutDisconnect, /hardware-close-timeout/);
  const roomExitAfterCloseTimeout = closeTimeoutController.stopForRoomExit();
  await Promise.race([
    timedOutDisconnectAssertion,
    delay(150).then(() => assert.fail('close timeout did not settle'))
  ]);
  assert.deepEqual(closeTimeoutController.getConnectionStatus(), { connected: true, path: 'COM53' });
  assert.equal(timedOutClosePort.isOpen, true, 'a timed-out close restores the still-open port');
  assert.deepEqual(
    await Promise.race([
      roomExitAfterCloseTimeout,
      delay(150).then(() => assert.fail('room exit remained blocked behind close timeout'))
    ]),
    { stopped: true }
  );
  assert.deepEqual(
    closeTimeoutController.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() }),
    { queued: true },
    'close-timeout and room-exit gates clear after settlement'
  );
  assert.deepEqual(await closeTimeoutController.disconnect(), { connected: false });
  await closeTimeoutController.connect('COM54', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  timedOutClosePort.completeClose();
  await delay(0);
  assert.equal(timedOutClosePort.isOpen, false);
  assert.equal(timedOutClosePort.listenerCount('error'), 0);
  assert.equal(timedOutClosePort.listenerCount('close'), 0);
  assert.equal(closeTimeoutPorts[1].isOpen, true, 'late close completion does not affect the replacement port');
  assert.deepEqual(closeTimeoutController.getConnectionStatus(), { connected: true, path: 'COM54' });
  await closeTimeoutController.disconnect();
}

if (runRegression('disconnect-cancels-stalled-test-write')) {
  const stalledPatternLogs = [];
  const stalledPatternPort = new FakePort('COM55');
  const stalledPatternController = new HardwareController({
    createPort: () => stalledPatternPort,
    onLog: entry => stalledPatternLogs.push(entry),
    probeTimeoutMs: 0,
    writeTimeoutMs: 100
  });
  await stalledPatternController.connect('COM55', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  stalledPatternPort.stallNextWrite = true;
  const stalledPattern = stalledPatternController.runTestPattern();
  await waitFor(() => stalledPatternPort.activeWrite !== undefined);
  const disconnectStalledPattern = stalledPatternController.disconnect();
  assert.deepEqual(
    await stalledPattern,
    { tested: false, reason: 'hardware-disconnecting' },
    'disconnect cancellation wins over the stalled write rejection'
  );
  assert.equal(
    stalledPatternLogs.some(entry => entry.message === 'hardware-test-failed'),
    false,
    'an expected lifecycle cancellation is not logged as a test failure'
  );
  assert.deepEqual(await disconnectStalledPattern, { connected: false });
}

if (runRegression('serialport-close-timeout-late-failure')) {
  const faithfulCloseStatuses = [];
  const faithfulClosePort = new SerialPortFaithfulFake('COM56');
  const faithfulCloseController = new HardwareController({
    createPort: () => faithfulClosePort,
    onConnectionStatus: status => faithfulCloseStatuses.push(status),
    probeTimeoutMs: 0,
    writeTimeoutMs: 100,
    lifecycleTimeoutMs: 30
  });
  await faithfulCloseController.connect('COM56', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  faithfulClosePort.stallNextClose = true;
  const faithfulTimedOutClose = faithfulCloseController.disconnect();
  await waitFor(() => faithfulClosePort.pendingClose !== undefined);
  assert.equal(faithfulClosePort.physicalOpen, true);
  assert.equal(faithfulClosePort.closing, true);
  assert.equal(faithfulClosePort.isOpen, false, 'SerialPort reports false while a close is pending');
  await assert.rejects(faithfulTimedOutClose, /hardware-close-timeout/);
  assert.deepEqual(faithfulCloseController.getConnectionStatus(), { connected: true, path: 'COM56' });
  assert.equal(faithfulClosePort.listenerCount('error'), 1, 'timed-out close retains its owned error handler');
  assert.equal(faithfulClosePort.listenerCount('close'), 1, 'timed-out close retains its owned close handler');

  faithfulClosePort.completeClose(new Error('serial-late-close-failed'));
  assert.equal(faithfulClosePort.isOpen, true, 'late close failure exposes the still-open physical port');
  assert.deepEqual(faithfulCloseController.getConnectionStatus(), { connected: true, path: 'COM56' });
  assert.deepEqual(
    faithfulCloseController.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() }),
    { queued: true },
    'late close failure restores usable ownership when no replacement exists'
  );
  assert.deepEqual(await faithfulCloseController.disconnect(), { connected: false });
  assert.equal(faithfulClosePort.physicalOpen, false);
  await delay(0);
  assert.equal(faithfulClosePort.listenerCount('error'), 0);
  assert.equal(faithfulClosePort.listenerCount('close'), 0);
  assert.deepEqual(faithfulCloseStatuses.at(-1), {
    connected: false,
    reason: 'hardware-disconnected',
    unexpected: false
  });
}

if (runRegression('close-timeout-error-before-late-failure')) {
  const restoredHandlerStatuses = [];
  const restoredHandlerPort = new SerialPortFaithfulFake('COM61');
  const restoredHandlerController = new HardwareController({
    createPort: () => restoredHandlerPort,
    onConnectionStatus: status => restoredHandlerStatuses.push(status),
    probeTimeoutMs: 0,
    writeTimeoutMs: 100,
    lifecycleTimeoutMs: 30
  });
  await restoredHandlerController.connect('COM61', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  restoredHandlerPort.stallNextClose = true;
  const restoredHandlerDisconnect = restoredHandlerController.disconnect();
  await waitFor(() => restoredHandlerPort.pendingClose !== undefined);
  await assert.rejects(restoredHandlerDisconnect, /hardware-close-timeout/);
  assert.equal(restoredHandlerPort.isOpen, false);
  assert.equal(restoredHandlerPort.closing, true);

  restoredHandlerPort.emit('error', new Error('serial-error-during-close'));
  restoredHandlerPort.completeClose(new Error('serial-late-close-failed'));
  assert.equal(restoredHandlerPort.physicalOpen, true);
  assert.equal(restoredHandlerPort.isOpen, true);
  assert.deepEqual(restoredHandlerController.getConnectionStatus(), { connected: true, path: 'COM61' });
  assert.equal(restoredHandlerPort.listenerCount('error'), 1, 'restored ownership has exactly one error handler');
  assert.equal(restoredHandlerPort.listenerCount('close'), 1, 'restored ownership has exactly one close handler');
  assert.deepEqual(
    restoredHandlerController.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() }),
    { queued: true },
    'motion is admitted only after the physical port reopens with owned handlers'
  );

  restoredHandlerPort.failNextClose = true;
  restoredHandlerPort.emit('error', new Error('serial-error-after-restore'));
  await waitFor(() => !restoredHandlerPort.failNextClose && !restoredHandlerController.getConnectionStatus().connected);
  assert.equal(restoredHandlerPort.physicalOpen, true, 'failed error cleanup retains the handle for retry');
  assert.deepEqual(await restoredHandlerController.disconnect(), { connected: false });
  assert.equal(restoredHandlerPort.physicalOpen, false);
  await delay(0);
  assert.equal(restoredHandlerPort.listenerCount('error'), 0);
  assert.equal(restoredHandlerPort.listenerCount('close'), 0);
  assert.equal(restoredHandlerStatuses.at(-1).connected, false);
}

if (runRegression('late-open-cleanup-error-retry')) {
  const lateOpenErrorPorts = [];
  const lateOpenErrorController = new HardwareController({
    createPort: options => {
      const createdPort = new FakePort(options.path);
      if (lateOpenErrorPorts.length === 0) createdPort.stallNextOpen = true;
      lateOpenErrorPorts.push(createdPort);
      return createdPort;
    },
    probeTimeoutMs: 0,
    writeTimeoutMs: 100,
    lifecycleTimeoutMs: 30
  });
  const staleErrorConnect = lateOpenErrorController.connect('COM57', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  await assert.rejects(staleErrorConnect, /hardware-open-timeout/);
  await lateOpenErrorController.connect('COM58', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  lateOpenErrorPorts[0].failNextClose = true;
  lateOpenErrorPorts[0].completeOpen();
  await delay(0);
  assert.equal(lateOpenErrorPorts[0].isOpen, true, 'failed late-open cleanup remains physically open');
  assert.equal(lateOpenErrorPorts[0].listenerCount('error'), 1, 'failed stale cleanup retains an error sink');
  assert.equal(lateOpenErrorPorts[1].isOpen, true);
  assert.deepEqual(lateOpenErrorController.getConnectionStatus(), { connected: true, path: 'COM58' });
  assert.deepEqual(await lateOpenErrorController.disconnect(), { connected: false });
  assert.equal(lateOpenErrorPorts[0].isOpen, false, 'later lifecycle cleanup retries the stale port');
  assert.equal(lateOpenErrorPorts[0].listenerCount('error'), 0);
  assert.equal(lateOpenErrorPorts[0].listenerCount('close'), 0);
  assert.equal(lateOpenErrorPorts[1].isOpen, false);
}

if (runRegression('late-open-cleanup-timeout-retry')) {
  const lateOpenTimeoutPorts = [];
  const lateOpenTimeoutController = new HardwareController({
    createPort: options => {
      const createdPort = new FakePort(options.path);
      if (lateOpenTimeoutPorts.length === 0) createdPort.stallNextOpen = true;
      lateOpenTimeoutPorts.push(createdPort);
      return createdPort;
    },
    probeTimeoutMs: 0,
    writeTimeoutMs: 100,
    lifecycleTimeoutMs: 30
  });
  const staleTimeoutConnect = lateOpenTimeoutController.connect('COM59', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  await assert.rejects(staleTimeoutConnect, /hardware-open-timeout/);
  await lateOpenTimeoutController.connect('COM60', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  lateOpenTimeoutPorts[0].stallNextClose = true;
  lateOpenTimeoutPorts[0].completeOpen();
  await waitFor(() => lateOpenTimeoutPorts[0].pendingClose !== undefined);
  await delay(40);
  assert.equal(lateOpenTimeoutPorts[0].isOpen, true, 'timed-out stale cleanup retains the physical handle');
  assert.equal(lateOpenTimeoutPorts[0].listenerCount('error'), 1, 'timed-out stale cleanup retains an error sink');
  assert.equal(lateOpenTimeoutPorts[1].isOpen, true);
  assert.deepEqual(await lateOpenTimeoutController.disconnect(), { connected: false });
  assert.equal(lateOpenTimeoutPorts[0].isOpen, false, 'later lifecycle cleanup retries a timed-out stale close');
  lateOpenTimeoutPorts[0].completeClose();
  await delay(0);
  assert.equal(lateOpenTimeoutPorts[0].listenerCount('error'), 0);
  assert.equal(lateOpenTimeoutPorts[0].listenerCount('close'), 0);
  assert.equal(lateOpenTimeoutPorts[1].isOpen, false);
}

if (runRegression('duplicate-disconnect')) {
  const duplicateDisconnectPort = new FakePort('COM30');
  const duplicateDisconnectController = new HardwareController({
    createPort: () => duplicateDisconnectPort,
    probeTimeoutMs: 0,
    writeTimeoutMs: 20
  });
  await duplicateDisconnectController.connect('COM30', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  duplicateDisconnectPort.stallNextClose = true;
  const firstDisconnect = duplicateDisconnectController.disconnect();
  const secondDisconnect = duplicateDisconnectController.disconnect();
  assert.strictEqual(secondDisconnect, firstDisconnect, 'overlapping disconnect calls share one promise');
  await waitFor(() => duplicateDisconnectPort.pendingClose !== undefined);
  duplicateDisconnectPort.completeClose();
  assert.deepEqual(await firstDisconnect, { connected: false });
}

if (runRegression('connect-during-disconnect')) {
  const connectDuringDisconnectPorts = [];
  const connectDuringDisconnectController = new HardwareController({
    createPort: options => {
      const createdPort = new FakePort(options.path);
      connectDuringDisconnectPorts.push(createdPort);
      return createdPort;
    },
    probeTimeoutMs: 0,
    writeTimeoutMs: 20
  });
  await connectDuringDisconnectController.connect('COM31', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  const disconnectingPort = connectDuringDisconnectPorts[0];
  disconnectingPort.stallNextClose = true;
  const pendingDisconnect = connectDuringDisconnectController.disconnect();
  const pendingConnect = connectDuringDisconnectController.connect('COM32', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  await delay(0);
  assert.equal(connectDuringDisconnectPorts.length, 1, 'connect waits without creating a replacement port');
  await waitFor(() => disconnectingPort.pendingClose !== undefined);
  disconnectingPort.completeClose();
  assert.deepEqual(await pendingDisconnect, { connected: false });
  assert.equal((await pendingConnect).path, 'COM32');
  assert.equal(connectDuringDisconnectPorts.length, 2);
  await connectDuringDisconnectController.disconnect();
}

if (runRegression('connect-after-close-failure')) {
  const closeFailureRacePorts = [];
  const closeFailureRaceController = new HardwareController({
    createPort: options => {
      const createdPort = new FakePort(options.path);
      closeFailureRacePorts.push(createdPort);
      return createdPort;
    },
    probeTimeoutMs: 0,
    writeTimeoutMs: 20
  });
  await closeFailureRaceController.connect('COM33', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  const originalPort = closeFailureRacePorts[0];
  originalPort.stallNextClose = true;
  const failedDisconnect = closeFailureRaceController.disconnect();
  const waitingConnect = closeFailureRaceController.connect('COM34', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  const disconnectRejected = assert.rejects(failedDisconnect, /serial-close-failed/);
  const connectRejected = assert.rejects(waitingConnect, /serial-close-failed/);
  await waitFor(() => originalPort.pendingClose !== undefined);
  originalPort.failNextClose = true;
  originalPort.completeClose();
  await disconnectRejected;
  await connectRejected;
  assert.equal(closeFailureRacePorts.length, 1, 'failed prior close creates no replacement port');
  assert.equal(closeFailureRacePorts.filter(candidate => candidate.isOpen).length, 1, 'one physical port remains open');
  assert.deepEqual(closeFailureRaceController.getConnectionStatus(), { connected: true, path: 'COM33' });
  assert.deepEqual(
    closeFailureRaceController.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() }),
    { queued: true }
  );
  await waitFor(() => originalPort.writes.some(payload => payload.trim() === 'L05000I17'));
  await closeFailureRaceController.disconnect();
}

if (runRegression('close-error-after-closure')) {
  const closedErrorStatuses = [];
  const closedErrorPort = new FakePort('COM35');
  const closedErrorController = new HardwareController({
    createPort: () => closedErrorPort,
    onConnectionStatus: status => closedErrorStatuses.push(status),
    probeTimeoutMs: 0,
    writeTimeoutMs: 20
  });
  await closedErrorController.connect('COM35', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  });
  closedErrorPort.closeErrorAfterPhysicalClose = true;
  assert.deepEqual(await closedErrorController.disconnect(), { connected: false });
  assert.deepEqual(closedErrorStatuses.at(-1), {
    connected: false,
    reason: 'hardware-disconnected',
    unexpected: false
  });
  assert.deepEqual(
    closedErrorController.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() }),
    { queued: false, reason: 'hardware-not-connected' }
  );
}

if (runRegression('coalesced-room-exit')) {
  const coalescedRoomExitPort = new FakePort('COM36');
  const coalescedRoomExitController = new HardwareController({
    createPort: () => coalescedRoomExitPort,
    probeTimeoutMs: 0,
    writeTimeoutMs: 100
  });
  await coalescedRoomExitController.connect('COM36', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    stopPosition: 0.4,
    invertPosition: false
  });
  coalescedRoomExitPort.stallNextWrite = true;
  const writesBeforeRoomExit = coalescedRoomExitPort.writes.length;
  const firstRoomExit = coalescedRoomExitController.stopForRoomExit();
  const secondRoomExit = coalescedRoomExitController.stopForRoomExit();
  assert.strictEqual(secondRoomExit, firstRoomExit, 'overlapping room-exit calls share one promise');
  await waitFor(() => coalescedRoomExitPort.activeWrite !== undefined);
  assert.equal(coalescedRoomExitPort.writes.length, writesBeforeRoomExit + 1, 'room-exit calls share one stop write');
  assert.deepEqual(
    coalescedRoomExitController.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() }),
    { queued: false, reason: 'hardware-room-exit-stopping' }
  );
  coalescedRoomExitPort.completeWrite();
  assert.deepEqual(await firstRoomExit, { stopped: true });
  assert.deepEqual(await secondRoomExit, { stopped: true });
  assert.deepEqual(
    coalescedRoomExitController.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() }),
    { queued: true },
    'motion resumes only after the shared room-exit operation settles'
  );
  await waitFor(() => coalescedRoomExitPort.writes.length === writesBeforeRoomExit + 2);
  await coalescedRoomExitController.disconnect();
}

if (runRegression('room-exit-disconnect-settlement')) {
  const settlementPort = new FakePort('COM38');
  const settlementController = new HardwareController({
    createPort: () => settlementPort,
    probeTimeoutMs: 0,
    writeTimeoutMs: 100
  });
  await settlementController.connect('COM38', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    stopPosition: 0.4,
    invertPosition: false
  });
  settlementPort.stallNextWrite = true;
  const settlingRoomExit = settlementController.stopForRoomExit();
  const settlementAdmission = settlingRoomExit.then(() => (
    settlementController.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() })
  ));
  const settlementDisconnect = settlementController.disconnect();
  await waitFor(() => settlementPort.activeWrite !== undefined);
  settlementPort.completeWrite();
  assert.deepEqual(await settlingRoomExit, { stopped: true });
  assert.deepEqual(await settlementAdmission, {
    queued: false,
    reason: 'hardware-disconnecting'
  }, 'the waiting disconnect owns queue admission at the room-exit settlement boundary');
  assert.deepEqual(await settlementDisconnect, { connected: false });
}

if (runRegression('room-exit-then-disconnect')) {
  const roomExitDisconnectStatuses = [];
  const roomExitDisconnectPort = new FakePort('COM37');
  const roomExitDisconnectController = new HardwareController({
    createPort: () => roomExitDisconnectPort,
    onConnectionStatus: status => roomExitDisconnectStatuses.push(status),
    probeTimeoutMs: 0,
    writeTimeoutMs: 20
  });
  await roomExitDisconnectController.connect('COM37', {
    baudRate: 115200,
    linearAxis: 'L0',
    strokeMin: 0,
    strokeMax: 1,
    stopPosition: 0.4,
    invertPosition: false
  });
  roomExitDisconnectPort.stallNextWrite = true;
  const pendingRoomExit = roomExitDisconnectController.stopForRoomExit();
  const disconnectAfterRoomExit = roomExitDisconnectController.disconnect();
  assert.deepEqual(
    roomExitDisconnectController.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() }),
    { queued: false, reason: 'hardware-room-exit-stopping' },
    'disconnect does not overwrite the pending room-exit gate'
  );
  assert.equal(roomExitDisconnectPort.isOpen, true, 'disconnect waits for the bounded room-exit stop');
  assert.deepEqual(await pendingRoomExit, { stopped: false, reason: 'hardware-stop-write-failed' });
  assert.deepEqual(await disconnectAfterRoomExit, { connected: false });
  assert.equal(roomExitDisconnectPort.isOpen, false, 'port closes after the room-exit stop settles');
  assert.deepEqual(roomExitDisconnectStatuses.at(-1), {
    connected: false,
    reason: 'hardware-room-exit-stop-failed',
    unexpected: false
  });
}

const unexpectedStatuses = [];
const unexpectedPort = new FakePort('COM15');
const unexpectedController = new HardwareController({
  createPort: () => unexpectedPort,
  onConnectionStatus: status => unexpectedStatuses.push(status),
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await unexpectedController.connect('COM15', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});
unexpectedPort.emit('error', new Error('serial-port-fault'));
assert.deepEqual(unexpectedStatuses.at(-1), {
  connected: false,
  reason: 'hardware-port-error',
  unexpected: true
});

const closeOnlyStatuses = [];
const closeOnlyPort = new FakePort('COM17');
const closeOnlyController = new HardwareController({
  createPort: () => closeOnlyPort,
  onConnectionStatus: status => closeOnlyStatuses.push(status),
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await closeOnlyController.connect('COM17', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});
closeOnlyPort.isOpen = false;
closeOnlyPort.emit('close');
assert.deepEqual(closeOnlyStatuses.at(-1), {
  connected: false,
  reason: 'hardware-port-closed',
  unexpected: true
});
assert.deepEqual(
  closeOnlyController.queueMotion({ position: 0.4, intensity: 0.25, timestamp: Date.now() }),
  { queued: false, reason: 'hardware-not-connected' },
  'a close-only port loss invalidates the connected controller'
);

const safeCloseFailureStatuses = [];
const safeCloseFailurePort = new FakePort('COM16');
const safeCloseFailureController = new HardwareController({
  createPort: () => safeCloseFailurePort,
  onConnectionStatus: status => safeCloseFailureStatuses.push(status),
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await safeCloseFailureController.connect('COM16', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});
safeCloseFailurePort.failNextClose = true;
await assert.rejects(safeCloseFailureController.disconnect(), /serial-close-failed/);
assert.deepEqual(safeCloseFailureController.getConnectionStatus(), { connected: true, path: 'COM16' });
assert.deepEqual(safeCloseFailureStatuses, [{ connected: true, path: 'COM16' }]);
await safeCloseFailureController.disconnect();

const absoluteStopPort = new FakePort('COM18');
const absoluteStopController = new HardwareController({
  createPort: () => absoluteStopPort,
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await absoluteStopController.connect('COM18', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0.25,
  strokeMax: 0.75,
  invertPosition: false
});
assert.deepEqual(
  await absoluteStopController.latchEmergencyStop(),
  { stopped: true, emergencyStopped: true }
);
assert.match(absoluteStopPort.writes.at(-1).trim(), /^DSTOP\nL02500I1$/);
await absoluteStopController.disconnect();

const thrownWritePort = new FakePort('COM20');
const thrownWriteController = new HardwareController({
  createPort: () => thrownWritePort,
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await thrownWriteController.connect('COM20', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});
thrownWritePort.throwNextWrite = true;
thrownWriteController.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() });
await waitFor(() => !thrownWriteController.getConnectionStatus().connected);
assert.deepEqual(
  thrownWriteController.queueMotion({ position: 0.6, intensity: 0.25, timestamp: Date.now() }),
  { queued: false, reason: 'hardware-not-connected' },
  'a synchronous write exception fails closed'
);

const failedCleanupPort = new FakePort('COM21');
const failedCleanupController = new HardwareController({
  createPort: () => failedCleanupPort,
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await failedCleanupController.connect('COM21', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});
failedCleanupPort.stallNextWrite = true;
failedCleanupPort.failNextClose = true;
failedCleanupController.queueMotion({ position: 0.5, intensity: 0.25, timestamp: Date.now() });
await waitFor(() => !failedCleanupPort.failNextClose && !failedCleanupController.getConnectionStatus().connected);
assert.equal(failedCleanupPort.isOpen, true, 'failed fail-closed cleanup retains an open OS port');
await failedCleanupController.disconnect();
assert.equal(failedCleanupPort.isOpen, false, 'explicit disconnect retries closing a failed port cleanup');

if (runRegression('diagnostics')) {
  let clock = 10_000;
  const now = () => {
    clock += 5;
    return clock;
  };
  const diagnostics = [];
  const diagnosticPort = new FakePort('COM3');
  const diagnosticController = new HardwareController({
    createPort: () => diagnosticPort,
    listPorts: async () => [{
      path: 'COM3',
      vendorId: '10C4',
      productId: 'EA64',
      serialNumber: '0693C90A',
      manufacturer: 'Silicon Labs',
      pnpId: 'USB\\VID_10C4&PID_EA64',
      locationId: 'Port_#0002.Hub_#0001'
    }],
    onDiagnostic: event => diagnostics.push(event),
    now,
    probeTimeoutMs: 0,
    writeTimeoutMs: 20
  });

  const diagnosticProfile = {
    baudRate: 115200,
    linearAxis: 'L0',
    vibrationAxis: undefined,
    strokeMin: 0.2,
    strokeMax: 0.8,
    stopPosition: 0.35,
    invertPosition: false
  };
  const connectResult = await diagnosticController.connect('COM3', diagnosticProfile);
  assert.deepEqual(connectResult.probe, {
    detected: true,
    raw: ['TCode v0.3', 'L0 V0'],
    version: 'v0.3',
    axes: ['L0', 'V0']
  });
  assert.deepEqual(
    diagnostics.find(item => item.event === 'hardware-connect-requested')?.data,
    {
      portPath: 'COM3',
      baudRate: 115200,
      linearAxis: 'L0',
      vibrationAxis: undefined,
      strokeMin: 0.2,
      strokeMax: 0.8,
      stopPosition: 0.35,
      invertPosition: false
    }
  );
  assert.deepEqual(
    diagnostics.find(item => item.event === 'hardware-port-identified')?.data,
    {
      path: 'COM3',
      vendorId: '10C4',
      productId: 'EA64',
      serialNumber: '0693C90A',
      manufacturer: 'Silicon Labs',
      pnpId: 'USB\\VID_10C4&PID_EA64',
      locationId: 'Port_#0002.Hub_#0001'
    }
  );
  const probeDiagnostic = diagnostics.find(item => item.event === 'hardware-probe-completed');
  assert.deepEqual(probeDiagnostic?.data, {
    command: 'D1\nD2',
    raw: 'TCode v0.3\nL0 V0',
    responseReceived: true,
    detected: true,
    version: 'v0.3',
    axes: ['L0', 'V0'],
    durationMs: probeDiagnostic?.data.durationMs
  });
  assert.equal(Number.isFinite(probeDiagnostic?.data.durationMs), true);
  assert.equal(probeDiagnostic.data.durationMs >= 0, true);

  await diagnosticController.runTestPattern();
  const testWrites = diagnostics.filter(item => item.event === 'hardware-write-completed' && item.data.operation === 'test');
  assert.equal(testWrites.length, 4);
  assert.equal(testWrites.every(item => item.data.deviceAcknowledged === false), true);
  assert.equal(testWrites.every(item => Number.isFinite(item.data.durationMs) && item.data.durationMs >= 0), true);
  assert.equal(testWrites.every(item => typeof item.data.command === 'string' && item.data.command.startsWith('L0')), true);

  assert.deepEqual(await diagnosticController.latchEmergencyStop(), { stopped: true, emergencyStopped: true });
  assert.equal(diagnostics.some(item => item.event === 'emergency-latched' && item.data.emergencyStopped === true), true);
  assert.deepEqual(
    diagnosticController.queueMotion({ position: 0.4, intensity: 0.1, timestamp: 11_000 }),
    { queued: false, reason: 'hardware-emergency-stopped' }
  );
  assert.equal(
    diagnostics.some(item => item.event === 'hardware-motion-sample' && item.data.outcome === 'dropped' && item.data.reason === 'hardware-emergency-stopped'),
    true
  );
  diagnosticController.releaseEmergencyStop();
  assert.equal(diagnostics.some(item => item.event === 'emergency-released' && item.data.emergencyStopped === false), true);

  diagnosticController.setProtection({ intensityLimit: 1, positionMin: 0, positionMax: 1, paused: true });
  assert.deepEqual(
    diagnosticController.queueMotion({ position: 0.4, intensity: 0.1, timestamp: 11_100 }),
    { queued: false, reason: 'protection-paused' }
  );
  assert.equal(
    diagnostics.some(item => item.event === 'hardware-motion-sample' && item.data.outcome === 'dropped' && item.data.reason === 'protection-paused'),
    true
  );
  diagnosticController.setProtection({ intensityLimit: 1, positionMin: 0, positionMax: 1, paused: false });

  assert.deepEqual(await diagnosticController.stopForRoomExit(), { stopped: true });
  assert.equal(diagnostics.some(item => item.event === 'room-exit-stop' && item.data.stopped === true), true);
  assert.deepEqual(await diagnosticController.disconnect(), { connected: false });
  assert.equal(diagnostics.some(item => item.event === 'hardware-disconnected' && item.data.unexpected === false), true);
  assert.deepEqual(
    diagnosticController.queueMotion({ position: 0.4, intensity: 0.1, timestamp: 11_200 }),
    { queued: false, reason: 'hardware-not-connected' }
  );

  const noResponseDiagnostics = [];
  const noResponsePort = new FakePort('COM4');
  noResponsePort.probeReply = undefined;
  const noResponseController = new HardwareController({
    createPort: () => noResponsePort,
    listPorts: async () => [],
    onDiagnostic: event => noResponseDiagnostics.push(event),
    now,
    probeTimeoutMs: 0,
    writeTimeoutMs: 20
  });
  await assert.rejects(
    noResponseController.connect('COM4', diagnosticProfile),
    /hardware-tcode-not-ready/
  );
  assert.equal(
    noResponseDiagnostics.some(item => item.event === 'hardware-probe-completed'
      && item.data.responseReceived === false
      && item.data.detected === false
      && item.data.raw === ''),
    true
  );
  assert.equal(
    noResponseDiagnostics.some(item => item.event === 'hardware-readiness-failed'
      && item.data.portPath === 'COM4'),
    true
  );
  await noResponseController.disconnect();

  const timeoutDiagnostics = [];
  const timeoutPort = new FakePort('COM5');
  const timeoutController = new HardwareController({
    createPort: () => timeoutPort,
    listPorts: async () => [],
    onDiagnostic: event => timeoutDiagnostics.push(event),
    now,
    probeTimeoutMs: 0,
    writeTimeoutMs: 10
  });
  await timeoutController.connect('COM5', diagnosticProfile);
  timeoutPort.stallNextWrite = true;
  timeoutController.queueMotion({ position: 0.5, intensity: 0.1, timestamp: 12_000 });
  await waitFor(() => timeoutDiagnostics.some(item => item.event === 'hardware-motion-sample' && item.data.outcome === 'failed'));
  const failedMotion = timeoutDiagnostics.find(item => item.event === 'hardware-motion-sample' && item.data.outcome === 'failed');
  assert.equal(failedMotion.data.reason, 'hardware-write-timeout');
  assert.equal(failedMotion.data.timeout, true);
  assert.equal('stack' in failedMotion.data, false);

  const closeDiagnostics = [];
  const unexpectedClosePort = new FakePort('COM6');
  const unexpectedCloseController = new HardwareController({
    createPort: () => unexpectedClosePort,
    listPorts: async () => [],
    onDiagnostic: event => closeDiagnostics.push(event),
    now,
    probeTimeoutMs: 0,
    writeTimeoutMs: 20
  });
  await unexpectedCloseController.connect('COM6', diagnosticProfile);
  unexpectedClosePort.isOpen = false;
  unexpectedClosePort.emit('close');
  assert.equal(closeDiagnostics.some(item => item.event === 'hardware-port-closed' && item.data.unexpected === true), true);
}

console.log('hardware output tests passed');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition-wait-timeout');
    await delay(5);
  }
}
