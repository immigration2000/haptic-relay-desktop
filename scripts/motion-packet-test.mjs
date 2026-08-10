import assert from 'node:assert/strict';

const shared = await import('../dist-server/src/shared/motion-packet.js');
const electron = await import('../dist-electron/motion-packet.js');

for (const [label, module] of [['shared', shared], ['electron', electron]]) {
  runPacketTests(label, module);
}

console.log('motion-v2 packet tests passed');

function runPacketTests(label, module) {
  const sourceTimeMs = 1_785_846_123_456;
  const encoded = module.encodeMotionPacket({
    protocolVersion: 2,
    flags: 3,
    sequence: 42,
    sourceTimeMs,
    durationMs: 75,
    position: 0.25,
    intensity: 0.75,
    timestamp: sourceTimeMs
  });

  assert.equal(encoded.byteLength, 20, `${label}: V2 packet must be 20 bytes`);

  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  assert.equal(view.getUint8(0), 2, `${label}: V2 version byte`);
  assert.equal(view.getUint8(1), 3, `${label}: V2 flags byte`);
  assert.equal(view.getUint32(2, false), 42, `${label}: V2 sequence`);
  assert.equal(Number(view.getBigUint64(6, false)), sourceTimeMs, `${label}: V2 sourceTimeMs`);
  assert.equal(view.getUint16(14, false), 75, `${label}: V2 durationMs`);

  const decoded = module.decodeMotionPacket(encoded);
  assert.equal(decoded.protocolVersion, 2, `${label}: decoded V2 protocolVersion`);
  assert.equal(decoded.flags, 3, `${label}: decoded V2 flags`);
  assert.equal(decoded.sequence, 42, `${label}: decoded V2 sequence`);
  assert.equal(decoded.sourceTimeMs, sourceTimeMs, `${label}: decoded V2 sourceTimeMs`);
  assert.equal(decoded.timestamp, sourceTimeMs, `${label}: decoded V2 timestamp`);
  assert.equal(decoded.durationMs, 75, `${label}: decoded V2 durationMs`);
  assertAlmostEqual(decoded.position, 0.25, `${label}: decoded V2 position`);
  assertAlmostEqual(decoded.intensity, 0.75, `${label}: decoded V2 intensity`);

  const v1 = Uint8Array.from([0x80, 0x00, 0x40, 0x00]);
  const decodedV1 = module.decodeMotionPacket(v1);
  assert.equal(decodedV1.protocolVersion, 1, `${label}: decoded V1 protocolVersion`);
  assert.equal(decodedV1.sequence, undefined, `${label}: decoded V1 has no sequence`);
  assert.equal(decodedV1.durationMs, 0, `${label}: decoded V1 duration default`);
  assertAlmostEqual(decodedV1.position, 32768 / 65535, `${label}: decoded V1 position`);
  assertAlmostEqual(decodedV1.intensity, 16384 / 65535, `${label}: decoded V1 intensity`);

  assert.throws(
    () => module.decodeMotionPacket(Uint8Array.from([2, 0, 0])),
    /invalid-motion-packet-size:3/,
    `${label}: rejects invalid packet size`
  );

  const unsupportedVersion = encoded.slice();
  unsupportedVersion[0] = 3;
  assert.throws(
    () => module.decodeMotionPacket(unsupportedVersion),
    /invalid-motion-packet-version:3/,
    `${label}: rejects unsupported V2 packet version`
  );
}

function assertAlmostEqual(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 0.000_01, `${label}: expected ${expected}, got ${actual}`);
}
