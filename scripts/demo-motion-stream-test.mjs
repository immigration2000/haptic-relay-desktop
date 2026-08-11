import assert from 'node:assert/strict';

const { DemoMotionStream, DEMO_MOTION_INTERVAL_MS } = await import('../dist-electron/services/demo-motion-stream.js');

const published = [];
const intervals = [];
const cleared = [];
let now = 1_000;
const stream = new DemoMotionStream(
  frame => published.push(frame),
  (callback, intervalMs) => {
    const timer = { callback, intervalMs };
    intervals.push(timer);
    return timer;
  },
  timer => cleared.push(timer),
  () => now
);

assert.equal(DEMO_MOTION_INTERVAL_MS, 1000 / 30);
assert.deepEqual(stream.start({ intensity: 0.4, position: 0.2 }), {
  streaming: true,
  intervalMs: DEMO_MOTION_INTERVAL_MS
});
assert.deepEqual(published, [{ intensity: 0.4, position: 0.2, timestamp: 1_000 }], 'start sends immediately');
assert.equal(intervals.length, 1, 'start creates one interval');
assert.equal(intervals[0].intervalMs, DEMO_MOTION_INTERVAL_MS);

stream.update({ intensity: 0.8, position: 0.7 });
now = 1_033;
intervals[0].callback();
assert.deepEqual(published.at(-1), { intensity: 0.8, position: 0.7, timestamp: 1_033 }, 'tick sends latest controls');

stream.start({ intensity: 0.6, position: 0.5 });
assert.equal(intervals.length, 1, 'restarting does not create overlapping intervals');

now = 1_040;
assert.deepEqual(stream.stop(), { streaming: false });
assert.equal(cleared.length, 1, 'stop clears the interval');
assert.deepEqual(published.at(-1), { intensity: 0, position: 0.5, timestamp: 1_040 }, 'stop sends a safe zero-intensity frame');
assert.deepEqual(stream.stop(), { streaming: false }, 'repeated stop is harmless');
assert.equal(published.length, 4, 'repeated stop does not publish another frame');

console.log('demo motion stream tests passed');
