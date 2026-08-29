import assert from 'node:assert/strict';

const encoder = await import('../dist-electron/services/tcode-encoder.js');

const frame = (position, intensity) => ({ position, intensity, timestamp: 1_786_000_000_000 });

assert.equal(
  encoder.encodeTCodeMotion(frame(0.5, 0.25), { linearAxis: 'L0', intervalMs: 16 }),
  'L05000I16\n'
);
assert.equal(
  encoder.encodeTCodeMotion(frame(-1, 2), { linearAxis: 'l0', vibrationAxis: 'v0', intervalMs: 16.4 }),
  'L00000I16 V09999\n'
);
assert.equal(
  encoder.encodeTCodeMotion(frame(1, 0), { linearAxis: 'R2', intervalMs: 33.6 }),
  'R29999I34\n'
);
assert.equal(
  encoder.encodeTCodeStop({ linearAxis: 'L0', vibrationAxis: 'V0', stopPosition: 0.2 }),
  'DSTOP\nL02000I1 V00000\n'
);
assert.equal(
  encoder.encodeTCodeStop({ linearAxis: 'L0', stopPosition: 0.3 }),
  'DSTOP\nL03000I1\n'
);
assert.equal(encoder.encodeTCodeProbe(), 'D1\nD2\n');
assert.deepEqual(
  encoder.parseTCodeProbe(['T-Code: v0.3', 'axes L0 R1 V0']),
  { detected: true, raw: ['T-Code: v0.3', 'axes L0 R1 V0'], version: 'v0.3', axes: ['L0', 'R1', 'V0'] }
);
const esp32BootLog = [
  'ets Jul 29 2019 12:21:46',
  'rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)',
  'configsip: 0, SPIWP:0xee',
  'clk_drv:0x00,q_drv:0x00,d_drv:0x00,cs0_drv:0x00,hd_drv:0x00,wp_drv:0x00',
  'mode:DIO, clock div:1',
  'entry 0x400805e4'
];
assert.deepEqual(
  encoder.parseTCodeProbe(esp32BootLog),
  { detected: false, raw: esp32BootLog, version: undefined, axes: [] },
  'ESP32 boot diagnostics must not satisfy the T-Code readiness probe'
);
assert.throws(
  () => encoder.encodeTCodeMotion(frame(0.5, 0.5), { linearAxis: 'X0' }),
  /invalid-tcode-axis/
);

console.log('tcode encoder tests passed');
