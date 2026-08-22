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
await delay(50);
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
await delay(50);
assert.equal(outputs.length, 1, 'failed writes do not report successful output');
assert.ok(logs.some(entry => entry.message === 'hardware-motion-write-failed'));

const outputsBeforeStall = outputs.length;
port.stallNextWrite = true;
controller.queueMotion({ position: 0.6, intensity: 0.25, timestamp: Date.now() });
await delay(50);
assert.ok(
  logs.some(entry => entry.message === 'hardware-motion-write-failed' && entry.details === 'hardware-write-timeout'),
  'a stalled motion write is rejected after the bounded timeout'
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
await delay(50);
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
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
});
await controller.emergencyStop();
assert.equal(outputs.at(-1).kind, 'stop');
assert.match(outputs.at(-1).command, /^DSTOP\nL00000I1$/);
assert.deepEqual(
  controller.getConnectionStatus(),
  { connected: true, path: 'COM9' },
  'a successful normal emergency stop keeps the healthy port connected'
);

await controller.disconnect();

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
await delay(50);
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
  invertPosition: false
});
assert.deepEqual(safeController.getConnectionStatus(), { connected: true, path: 'COM13' });

const safeResult = await safeController.disconnectSafely();
assert.deepEqual(safeResult, { connected: false, stop: { stopped: true } });
assert.match(safePort.writes.at(-1).trim(), /^DSTOP\nL00000I1$/);
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
const stalledDisconnect = await Promise.race([
  stalledController.disconnectSafely(),
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

console.log('hardware output tests passed');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
