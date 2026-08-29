import assert from 'node:assert/strict';

const motionModule = await import('../dist-electron/services/motion-delay-buffer.js');

assert.equal(
  typeof motionModule.interpolateMotionFrame,
  'function',
  'delayed playback must expose a pure motion interpolation calculator'
);

const frame = (sequence, receivedOffsetMs, position, intensity = position) => ({
  protocolVersion: 2,
  sequence,
  sourceTimeMs: 10_000 + receivedOffsetMs,
  timestamp: 10_000 + receivedOffsetMs,
  durationMs: 33,
  position,
  intensity
});

const start = frame(1, 0, 0.2, 0.1);
const end = frame(2, 100, 0.8, 0.9);
assert.deepEqual(
  motionModule.interpolateMotionFrame(start, end, 1_000, 1_100, 1_050),
  {
    ...end,
    sourceTimeMs: 10_050,
    timestamp: 10_050,
    durationMs: 33,
    position: 0.5,
    intensity: 0.5
  },
  'midpoint playback uses both future endpoints instead of replaying an already elapsed interval'
);
assert.equal(
  motionModule.interpolateMotionFrame(start, end, 1_000, 1_251, 1_125),
  undefined,
  'gaps above the safety interpolation limit are not synthesized'
);

const timeline = new motionModule.MotionDelayBuffer();
timeline.setDelayMs(100);
timeline.enqueue(start, 1_000);
timeline.enqueue(end, 1_100);
assert.equal(typeof timeline.sample, 'function', 'delayed frames are sampled on a playback timeline');
assert.equal(timeline.sample(1_099), undefined, 'playback does not start before the configured delay');
assert.deepEqual(timeline.sample(1_100), start, 'the first real frame is emitted at the delayed origin');
assert.equal(timeline.sample(1_150)?.position, 0.5, 'a 30Hz playback loop can request an in-between target');
assert.deepEqual(timeline.sample(1_200), end, 'the newer real frame is emitted at its delayed time');
assert.equal(timeline.sample(1_233), undefined, 'the newest frame is not extrapolated or repeated');
assert.equal(timeline.stats().bufferedFrames, 1, 'played history is pruned before it can cause false overflow');

const longGapTimeline = new motionModule.MotionDelayBuffer();
longGapTimeline.setDelayMs(500);
const longGapEnd = frame(3, 251, 0.9);
longGapTimeline.enqueue(start, 2_000);
longGapTimeline.enqueue(longGapEnd, 2_251);
assert.deepEqual(longGapTimeline.sample(2_500), start);
assert.equal(longGapTimeline.sample(2_625), undefined, 'a long gap does not keep stale motion alive');
assert.deepEqual(longGapTimeline.sample(2_751), longGapEnd);

console.log('motion interpolation tests passed');
