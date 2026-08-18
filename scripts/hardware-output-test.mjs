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
  }

  open(callback) {
    this.isOpen = true;
    callback(null);
  }

  close(callback) {
    this.isOpen = false;
    callback(null);
  }

  write(payload, callback) {
    this.writes.push(payload);
    const error = this.failNextWrite ? new Error('serial-write-failed') : null;
    this.failNextWrite = false;
    queueMicrotask(() => callback(error));
    return true;
  }
}

const outputs = [];
const logs = [];
const port = new FakePort('COM9');
const controller = new HardwareController({
  onLog: entry => logs.push(entry),
  onOutput: output => outputs.push(output),
  createPort: () => port,
  probeTimeoutMs: 0
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

await controller.emergencyStop();
assert.equal(outputs.at(-1).kind, 'stop');
assert.match(outputs.at(-1).command, /^DSTOP\nL00000I1$/);

await controller.disconnect();
console.log('hardware output tests passed');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
