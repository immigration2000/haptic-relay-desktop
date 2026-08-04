import assert from 'node:assert/strict';

const relayModule = await import('../dist-electron/services/relay-client.js');

assert.equal(
  typeof relayModule.MotionDelayBuffer,
  'function',
  'relay client module must export MotionDelayBuffer'
);

const frame = sequence => ({
  protocolVersion: 2,
  sequence,
  sourceTimeMs: 1_785_847_000_000 + sequence,
  timestamp: 1_785_847_000_000 + sequence,
  durationMs: 20,
  position: sequence / 10,
  intensity: 0.5
});

const buffer = new relayModule.MotionDelayBuffer();
assert.deepEqual(buffer.enqueue(frame(1), 1000), [frame(1)], '0ms is immediate');

buffer.setDelayMs(500);
assert.deepEqual(buffer.enqueue(frame(2), 2000), [], 'delayed frame is queued');
assert.deepEqual(buffer.drain(2499), [], 'frame is not early');
assert.deepEqual(buffer.drain(2500), [frame(2)], 'frame is due at target time');

buffer.enqueue(frame(3), 3000);
buffer.enqueue(frame(4), 3010);
assert.deepEqual(buffer.drain(3510), [frame(3), frame(4)], 'due frames retain FIFO order');

const orderedReceiptBuffer = new relayModule.MotionDelayBuffer();
orderedReceiptBuffer.setDelayMs(500);
orderedReceiptBuffer.enqueue(frame(6), 2000);
assert.throws(
  () => orderedReceiptBuffer.enqueue(frame(7), 1999),
  /invalid-motion-received-time/,
  'decreasing receipt time is rejected while frames are queued'
);
orderedReceiptBuffer.enqueue(frame(7), 2000);
assert.deepEqual(
  orderedReceiptBuffer.drain(2500),
  [frame(6), frame(7)],
  'nondecreasing receipt times retain FIFO order'
);

const receiptTimeBuffer = new relayModule.MotionDelayBuffer();
for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  assert.throws(
    () => receiptTimeBuffer.enqueue(frame(8), invalid),
    /invalid-motion-received-time/,
    'immediate delivery rejects non-finite receipt time'
  );
}
receiptTimeBuffer.setDelayMs(500);
for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  assert.throws(
    () => receiptTimeBuffer.enqueue(frame(8), invalid),
    /invalid-motion-received-time/,
    'queued delivery rejects non-finite receipt time'
  );
}
assert.equal(receiptTimeBuffer.stats().bufferedFrames, 0, 'invalid receipt time cannot poison the queue');

const clearedOriginBuffer = new relayModule.MotionDelayBuffer();
clearedOriginBuffer.setDelayMs(500);
clearedOriginBuffer.enqueue(frame(9), 2000);
clearedOriginBuffer.clear();
assert.doesNotThrow(
  () => clearedOriginBuffer.enqueue(frame(10), 100),
  'cleared queue accepts a new finite clock origin'
);
assert.deepEqual(clearedOriginBuffer.drain(600), [frame(10)]);

const drainedOriginBuffer = new relayModule.MotionDelayBuffer();
drainedOriginBuffer.setDelayMs(500);
drainedOriginBuffer.enqueue(frame(11), 2000);
assert.deepEqual(drainedOriginBuffer.drain(2500), [frame(11)]);
assert.doesNotThrow(
  () => drainedOriginBuffer.enqueue(frame(12), 100),
  'fully drained queue accepts a new finite clock origin'
);
assert.deepEqual(drainedOriginBuffer.drain(600), [frame(12)]);

const currentTimeBuffer = new relayModule.MotionDelayBuffer();
currentTimeBuffer.setDelayMs(500);
currentTimeBuffer.enqueue(frame(13), 1000);
for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  assert.throws(
    () => currentTimeBuffer.drain(invalid),
    /invalid-motion-current-time/,
    'drain rejects non-finite current time'
  );
}
assert.equal(currentTimeBuffer.stats().bufferedFrames, 1, 'invalid drain time leaves the queue unchanged');
for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  assert.throws(
    () => currentTimeBuffer.nextWaitMs(invalid),
    /invalid-motion-current-time/,
    'next wait rejects non-finite current time'
  );
}
assert.equal(currentTimeBuffer.nextWaitMs(1000), 500, 'finite current time returns the next wait');
assert.deepEqual(currentTimeBuffer.drain(1500), [frame(13)]);

buffer.enqueue(frame(5), 4000);
const unchangedDelayStats = buffer.stats();
assert.deepEqual(
  buffer.setDelayMs(500),
  unchangedDelayStats,
  'reapplying the current delay leaves buffered frames unchanged'
);
assert.deepEqual(buffer.drain(4500), [frame(5)], 'idempotent delay update retains queued output');
buffer.enqueue(frame(14), 5000);
buffer.setDelayMs(1000);
assert.equal(buffer.stats().bufferedFrames, 0, 'changing delay clears queued frames');

for (const invalid of [-100, 50, 10_100, 100.5, Number.NaN]) {
  assert.throws(() => buffer.setDelayMs(invalid), /invalid-motion-delay/);
}

const bounded = new relayModule.MotionDelayBuffer(3);
bounded.setDelayMs(1000);
for (let sequence = 1; sequence <= 4; sequence += 1) bounded.enqueue(frame(sequence), sequence);
assert.deepEqual(bounded.drain(2000).map(item => item.sequence), [2, 3, 4]);
assert.equal(bounded.stats().overflowFrames, 1, 'overflow drops the oldest frame');

console.log('motion delay buffer tests passed');
