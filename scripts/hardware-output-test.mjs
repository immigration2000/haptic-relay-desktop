import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const { HardwareController } = await import('../dist-electron/services/hardware-controller.js');

class FakePort extends EventEmitter {
  constructor(path) {
    super();
    this.path = path;
    this.isOpen = false;
    this.writes = [];
    this.failNextWrite = false;
    this.throwNextWrite = false;
    this.failNextClose = false;
    this.stallNextWrite = false;
    this.activeWrite = undefined;
    this.pendingWrites = [];
    this.closeErrorHadListener = undefined;
  }

  open(callback) {
    this.isOpen = true;
    callback(null);
  }

  close(callback) {
    if (this.failNextClose) {
      this.failNextClose = false;
      callback(new Error('serial-close-failed'));
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

  write(payload, callback) {
    if (this.throwNextWrite) {
      this.throwNextWrite = false;
      throw new Error('serial-write-threw');
    }
    this.writes.push(payload);
    const write = {
      callback,
      error: this.failNextWrite ? new Error('serial-write-failed') : null,
      stalled: this.stallNextWrite
    };
    this.failNextWrite = false;
    this.stallNextWrite = false;
    this.pendingWrites.push(write);
    this.flushWrites();
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
const stalledStopResult = await Promise.race([
  controller.emergencyStop(),
  delay(100).then(() => ({ timedOut: true }))
]);
assert.deepEqual(
  stalledStopResult,
  { stopped: false, reason: 'hardware-stop-write-failed' },
  'emergency stop fails within the bounded write timeout instead of hanging'
);
assert.ok(
  logs.some(entry => entry.message === 'hardware-stop-write-failed' && entry.details === 'hardware-write-timeout'),
  'a stalled emergency stop is logged'
);

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
await controller.emergencyStop();
assert.equal(outputs.at(-1).kind, 'stop');
assert.equal(outputs.at(-1).command, 'DSTOP\nL03000I1');
assert.deepEqual(
  controller.getConnectionStatus(),
  { connected: true, path: 'COM9' },
  'a successful normal emergency stop keeps the healthy port connected'
);

const latchedStop = await controller.pauseAndStop();
assert.equal(latchedStop.stopped, true);
assert.equal(latchedStop.protection.paused, true);
assert.deepEqual(
  controller.queueMotion({ position: 0.8, intensity: 0.25, timestamp: Date.now() }),
  { queued: false, reason: 'protection-paused' },
  'an explicit local stop blocks later motion until the user resumes'
);
await controller.setProtection({
  intensityLimit: 1,
  positionMin: 0,
  positionMax: 1,
  paused: false
});
const pausedProtection = await controller.setProtection({
  intensityLimit: 1,
  positionMin: 0,
  positionMax: 1,
  paused: true
});
assert.deepEqual(pausedProtection.stop, { stopped: true });
assert.equal(pausedProtection.protection.paused, true);

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
assert.deepEqual(await cancelledPatternController.emergencyStop(), { stopped: true });
assert.deepEqual(await cancelledPattern, { tested: false, reason: 'hardware-test-cancelled' });
const cancellationStopIndex = cancelledPatternOutputs.findIndex(output => output.kind === 'stop');
assert.notEqual(cancellationStopIndex, -1, 'emergency stop output is recorded during the test pattern');
assert.equal(
  cancelledPatternOutputs.slice(cancellationStopIndex + 1).some(output => output.kind === 'test'),
  false,
  'no test motion is written after an emergency stop cancels the pattern'
);
await cancelledPatternController.disconnect();

const probePort = new FakePort();
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

const safeStatuses = [];
const safePort = new FakePort('COM13');
const safeController = new HardwareController({
  createPort: () => safePort,
  onConnectionStatus: status => safeStatuses.push(status),
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await safeController.connect('COM13', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  stopPosition: 0.6,
  invertPosition: false
});
assert.deepEqual(safeController.getConnectionStatus(), { connected: true, path: 'COM13' });

const safeResult = await safeController.disconnectSafely();
assert.deepEqual(safeResult, { connected: false, stop: { stopped: true } });
assert.match(safePort.writes.at(-1).trim(), /^DSTOP\nL06000I1$/);
assert.deepEqual(safeStatuses, [
  { connected: true, path: 'COM13' },
  { connected: false, reason: 'hardware-disconnected', unexpected: false }
]);

const stalledStatuses = [];
const stalledPort = new FakePort('COM14');
const stalledController = new HardwareController({
  createPort: () => stalledPort,
  onConnectionStatus: status => stalledStatuses.push(status),
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await stalledController.connect('COM14', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});
stalledPort.stallNextWrite = true;
const stalledDisconnectPromise = stalledController.disconnectSafely();
assert.deepEqual(
  stalledController.queueMotion({ position: 0.8, intensity: 0.25, timestamp: Date.now() }),
  { queued: false, reason: 'hardware-disconnecting' },
  'safe disconnect rejects motion while the bounded stop write is pending'
);
const stalledDisconnect = await Promise.race([
  stalledDisconnectPromise,
  delay(100).then(() => ({ timedOut: true }))
]);
assert.deepEqual(stalledDisconnect, {
  connected: false,
  stop: { stopped: false, reason: 'hardware-stop-write-failed' }
});
assert.deepEqual(stalledStatuses.at(-1), {
  connected: false,
  reason: 'hardware-disconnected-stop-failed',
  unexpected: false
});

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
await assert.rejects(safeCloseFailureController.disconnectSafely(), /serial-close-failed/);
assert.deepEqual(safeCloseFailureController.getConnectionStatus(), { connected: true, path: 'COM16' });
assert.deepEqual(safeCloseFailureStatuses, [{ connected: true, path: 'COM16' }]);
await safeCloseFailureController.disconnect();

const legacyStopPort = new FakePort('COM18');
const legacyStopController = new HardwareController({
  createPort: () => legacyStopPort,
  probeTimeoutMs: 0,
  writeTimeoutMs: 20
});
await legacyStopController.connect('COM18', {
  baudRate: 115200,
  linearAxis: 'L0',
  strokeMin: 0.25,
  strokeMax: 0.75,
  invertPosition: false
});
await legacyStopController.emergencyStop();
assert.match(legacyStopPort.writes.at(-1).trim(), /^DSTOP\nL02500I1$/);
await legacyStopController.disconnect();

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
