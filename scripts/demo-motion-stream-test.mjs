import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const { DemoMotionStream, DEMO_MOTION_INTERVAL_MS } = await import('../dist-electron/services/demo-motion-stream.js');
const { DEFAULT_MANUAL_MAX_POSITION_SPEED } = await import('../dist-electron/services/manual-motion-safety.js');
const MANUAL_MAX_POSITION_STEP = DEFAULT_MANUAL_MAX_POSITION_SPEED * DEMO_MOTION_INTERVAL_MS / 1000;

function createHarness(onPublish) {
  const published = [];
  const intervals = [];
  const cleared = [];
  let wallNow = 1_000;
  let monotonicNow = 0;
  const stream = new DemoMotionStream(
    frame => {
      published.push(frame);
      onPublish?.(frame);
    },
    (callback, intervalMs) => {
      const timer = { callback, intervalMs };
      intervals.push(timer);
      return timer;
    },
    timer => cleared.push(timer),
    () => wallNow,
    () => monotonicNow
  );

  return {
    stream,
    published,
    intervals,
    cleared,
    setTime(wall, monotonic) {
      wallNow = wall;
      monotonicNow = monotonic;
    }
  };
}

const pattern = {
  pattern: 'triangle',
  periodMs: 1_000,
  positionMin: 0.2,
  positionMax: 0.8,
  intensity: 0.7
};

assert.equal(DEMO_MOTION_INTERVAL_MS, 1000 / 30);

const manual = createHarness();
assert.equal(manual.stream.getMode(), 'manual');
assert.deepEqual(manual.stream.update({ intensity: 0.1, position: 0.1 }), {
  streaming: false,
  accepted: false
});
assert.deepEqual(manual.stream.start({ intensity: 0.4, position: 0.2 }), {
  streaming: true,
  mode: 'manual',
  intervalMs: DEMO_MOTION_INTERVAL_MS
});
assert.deepEqual(manual.published, [{
  intensity: 0.4,
  position: 0.5 - MANUAL_MAX_POSITION_STEP,
  timestamp: 1_000,
  durationMs: DEMO_MOTION_INTERVAL_MS
}], 'manual start limits the first position change');
assert.equal(manual.intervals.length, 1, 'manual start creates one interval');
assert.equal(manual.intervals[0].intervalMs, DEMO_MOTION_INTERVAL_MS);

assert.deepEqual(manual.stream.update({ intensity: 0.8, position: 0.7 }), {
  streaming: true,
  accepted: true
});
assert.equal(manual.published.length, 1, 'manual update waits for the next tick');
manual.setTime(1_033, 33);
manual.intervals[0].callback();
assert.deepEqual(manual.published.at(-1), {
  intensity: 0.8,
  position: 0.5,
  timestamp: 1_033,
  durationMs: DEMO_MOTION_INTERVAL_MS
}, 'manual tick advances toward the latest controls at the safe slew rate');

const rapidManual = createHarness();
rapidManual.stream.start({ intensity: 0.5, position: 1 });
for (let tick = 1; tick <= 8; tick += 1) {
  rapidManual.stream.update({ intensity: 0.5, position: tick % 2 === 0 ? 1 : 0 });
  rapidManual.setTime(2_000 + tick * DEMO_MOTION_INTERVAL_MS, tick * DEMO_MOTION_INTERVAL_MS);
  rapidManual.intervals[0].callback();
}
for (let index = 1; index < rapidManual.published.length; index += 1) {
  const delta = Math.abs(rapidManual.published[index].position - rapidManual.published[index - 1].position);
  assert.ok(
    delta <= MANUAL_MAX_POSITION_STEP + Number.EPSILON,
    `rapid manual reversal limits adjacent position delta, got ${delta}`
  );
}

const configurable = createHarness();
configurable.stream.start({ intensity: 0.5, position: 1 });
const publishedBeforeLimitChange = configurable.published.length;
const intervalsBeforeLimitChange = configurable.intervals.length;
assert.equal(configurable.stream.setManualMaxPositionSpeed(4), 4);
assert.equal(configurable.published.length, publishedBeforeLimitChange, 'changing speed publishes no frame');
assert.equal(configurable.intervals.length, intervalsBeforeLimitChange, 'changing speed does not restart the timer');
configurable.setTime(1_033, DEMO_MOTION_INTERVAL_MS);
configurable.intervals[0].callback();
assert.equal(
  configurable.published.at(-1).position,
  0.5 + DEFAULT_MANUAL_MAX_POSITION_SPEED * DEMO_MOTION_INTERVAL_MS / 1000 + 4 * DEMO_MOTION_INTERVAL_MS / 1000,
  'the next tick uses the new 400%/s limit'
);
assert.equal(configurable.stream.setManualMaxPositionSpeed(0.5), 0.5);
configurable.stream.update({ intensity: 0.5, position: 0 });
configurable.setTime(1_066, DEMO_MOTION_INTERVAL_MS * 2);
configurable.intervals[0].callback();
assert.equal(
  configurable.published.at(-1).position,
  0.5 + DEFAULT_MANUAL_MAX_POSITION_SPEED * DEMO_MOTION_INTERVAL_MS / 1000 + 4 * DEMO_MOTION_INTERVAL_MS / 1000 - 0.5 * DEMO_MOTION_INTERVAL_MS / 1000,
  'the next tick uses the new 50%/s limit'
);
for (const invalid of [0, 0.6, 4.25, Number.NaN]) {
  assert.throws(() => configurable.stream.setManualMaxPositionSpeed(invalid), /invalid-manual-motion-speed/);
}

manual.stream.start({ intensity: 0.6, position: 0.5 });
assert.equal(manual.intervals.length, 1, 'manual restart reuses the interval');
manual.setTime(1_040, 40);
assert.deepEqual(manual.stream.stop(), { streaming: false });
assert.equal(manual.cleared.length, 1, 'manual stop clears the interval');
assert.deepEqual(manual.published.at(-1), {
  intensity: 0,
  position: 0.5,
  timestamp: 1_040,
  durationMs: DEMO_MOTION_INTERVAL_MS
}, 'manual stop sends one safe frame at the latest position');
const manualPublishedAfterStop = manual.published.length;
assert.deepEqual(manual.stream.stop(), { streaming: false }, 'repeated stop is harmless');
assert.equal(manual.published.length, manualPublishedAfterStop, 'repeated stop publishes nothing');
assert.deepEqual(manual.stream.updatePattern(pattern), {
  streaming: false,
  accepted: false
}, 'pattern updates are rejected while inactive');

let queuedLatest;
let clearedBeforeSafeZero;
const automatic = createHarness(frame => {
  queuedLatest = frame;
  if (frame.intensity === 0) clearedBeforeSafeZero = automatic.cleared.length;
});
automatic.stream.start({ intensity: 0.3, position: 0.5 });
const oldManualTimer = automatic.intervals[0];
automatic.setTime(1_032, 32);
const publishedBeforeModeSwitch = automatic.published.length;
assert.deepEqual(automatic.stream.startPattern(pattern), {
  streaming: true,
  mode: 'pattern',
  intervalMs: DEMO_MOTION_INTERVAL_MS
});
assert.equal(automatic.stream.getMode(), 'pattern');
assert.equal(automatic.cleared.length, 1, 'manual to pattern switch clears the old interval');
assert.equal(automatic.cleared[0], oldManualTimer);
assert.equal(clearedBeforeSafeZero, 1, 'old interval is cleared before safe zero is published');
assert.equal(automatic.intervals.length, 2, 'manual to pattern switch creates a fresh interval');
const patternTimer = automatic.intervals[1];
assert.equal(
  automatic.published.length,
  publishedBeforeModeSwitch + 1,
  'manual to pattern switch publishes exactly one frame synchronously'
);
assert.deepEqual(automatic.published.at(-1), {
  intensity: 0,
  position: 0.5,
  timestamp: 1_032,
  durationMs: DEMO_MOTION_INTERVAL_MS
}, 'manual to pattern switch sends safe zero intensity');
assert.deepEqual(queuedLatest, automatic.published.at(-1), 'coalesced latest frame remains zero after the switch call');
const publishedAfterModeSwitch = automatic.published.length;
oldManualTimer.callback();
assert.equal(automatic.published.length, publishedAfterModeSwitch, 'stale callback from the cleared timer publishes nothing');
assert.equal(queuedLatest.intensity, 0, 'safe zero remains latest after the stale callback');
assert.deepEqual(automatic.stream.update({ intensity: 1, position: 1 }), {
  streaming: false,
  accepted: false
}, 'manual updates are rejected while pattern mode is active');

automatic.setTime(1_065, 65);
patternTimer.callback();
assert.equal(queuedLatest.intensity, 0.7, 'next interval tick replaces the queued zero with the pattern frame');
assert.deepEqual(queuedLatest, automatic.published.at(-1), 'coalesced latest tracks the regular pattern tick');

automatic.setTime(10_182, 182);
patternTimer.callback();
assert.deepEqual(automatic.published.at(-1), {
  intensity: 0.7,
  position: 0.35,
  timestamp: 10_182,
  durationMs: DEMO_MOTION_INTERVAL_MS
}, '150ms ramp is halfway from 0.5 to 0.2');
automatic.setTime(10_332, 332);
patternTimer.callback();
assert.equal(automatic.published.at(-1).position, 0.2, '300ms ramp reaches the phase-zero position');
automatic.setTime(10_582, 582);
patternTimer.callback();
assert.equal(automatic.published.at(-1).position, 0.5, 'triangle reaches 0.5 after 250ms pattern elapsed');

const publishedBeforePatternUpdate = automatic.published.length;
assert.deepEqual(automatic.stream.updatePattern({
  ...pattern,
  positionMin: 0.4,
  positionMax: 0.9,
  intensity: 0.9
}), {
  streaming: true,
  accepted: true
});
assert.equal(automatic.published.length, publishedBeforePatternUpdate, 'pattern update waits for the next tick');
assert.equal(automatic.intervals.length, 2, 'live pattern update reuses the fresh pattern interval');
automatic.setTime(10_732, 732);
patternTimer.callback();
assert.deepEqual(automatic.published.at(-1), {
  intensity: 0.9,
  position: 0.45,
  timestamp: 10_732,
  durationMs: DEMO_MOTION_INTERVAL_MS
}, 'updated pattern ramps halfway from the live 0.5 position to 0.4');

automatic.setTime(10_733, 733);
assert.deepEqual(automatic.stream.stop(), { streaming: false });
assert.equal(automatic.cleared.length, 2, 'pattern stop clears the fresh pattern interval');
assert.deepEqual(automatic.published.at(-1), {
  intensity: 0,
  position: 0.45,
  timestamp: 10_733,
  durationMs: DEMO_MOTION_INTERVAL_MS
}, 'pattern stop sends one safe frame at the latest live position');
assert.ok(
  automatic.published.every(frame => frame.durationMs === DEMO_MOTION_INTERVAL_MS),
  'every pattern lifecycle frame includes its duration'
);

const backToManual = createHarness();
backToManual.stream.startPattern(pattern);
backToManual.setTime(1_150, 150);
backToManual.intervals[0].callback();
const patternPosition = backToManual.published.at(-1).position;
const oldPatternTimer = backToManual.intervals[0];
backToManual.setTime(1_151, 151);
const publishedBeforeManualSwitch = backToManual.published.length;
assert.deepEqual(backToManual.stream.start({ intensity: 0.5, position: 0.8 }), {
  streaming: true,
  mode: 'manual',
  intervalMs: DEMO_MOTION_INTERVAL_MS
});
assert.equal(backToManual.published.length, publishedBeforeManualSwitch + 1);
assert.equal(backToManual.cleared[0], oldPatternTimer, 'pattern to manual switch clears the old interval');
assert.equal(backToManual.intervals.length, 2, 'pattern to manual switch creates a fresh interval');
assert.deepEqual(backToManual.published.at(-1), {
  intensity: 0,
  position: patternPosition,
  timestamp: 1_151,
  durationMs: DEMO_MOTION_INTERVAL_MS
}, 'pattern to manual switch sends safe zero intensity');
const publishedAfterManualSwitch = backToManual.published.length;
oldPatternTimer.callback();
assert.equal(backToManual.published.length, publishedAfterManualSwitch, 'stale pattern callback publishes nothing');
backToManual.setTime(1_184, 184);
backToManual.intervals[1].callback();
assert.deepEqual(backToManual.published.at(-1), {
  intensity: 0.5,
  position: Math.min(0.8, patternPosition + MANUAL_MAX_POSITION_STEP),
  timestamp: 1_184,
  durationMs: DEMO_MOTION_INTERVAL_MS
}, 'manual controls slew from the live pattern position after the safe transition');

const invalidClock = createHarness();
invalidClock.stream.startPattern(pattern);
for (const [label, monotonic] of [
  ['NaN', Number.NaN],
  ['positive infinity', Number.POSITIVE_INFINITY],
  ['negative infinity', Number.NEGATIVE_INFINITY],
  ['finite rollback', -100]
]) {
  invalidClock.setTime(2_000, monotonic);
  invalidClock.intervals[0].callback();
  assert.equal(invalidClock.published.at(-1).position, 0.5, `${label} elapsed stays at the ramp origin`);
}

for (const [label, start] of [
  ['manual', stream => stream.start({ intensity: 0.5, position: 0.25 })],
  ['pattern', stream => stream.startPattern(pattern)]
]) {
  const published = [];
  const stream = new DemoMotionStream(
    frame => published.push(frame),
    () => {
      throw new Error('interval-factory-failed');
    },
    () => assert.fail('failed interval creation must not create a clearable timer'),
    () => 3_000,
    () => 0
  );

  assert.throws(() => start(stream), /interval-factory-failed/, `${label} start surfaces interval creation failure`);
  assert.deepEqual(published, [], `${label} start publishes nothing when interval creation fails`);
  assert.deepEqual(stream.stop(), { streaming: false }, `${label} failed start leaves stop inert`);
  assert.deepEqual(published, [], `${label} stop remains publish-free after failed start`);
}

const mainSource = await fs.readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
assert.match(
  mainSource,
  /function publishMotion\(frame: MotionFrame\) \{[\s\S]*?hardware: hardware\.queueMotion\(frame\),[\s\S]*?relay: relay\.publishMotion\(frame\)[\s\S]*?\n\}/,
  'main process passes one complete motion frame unchanged to hardware and relay'
);
assert.match(
  mainSource,
  /new DemoMotionStream\(frame => \{\s*publishMotion\(frame\);\s*const snapshot: MotionDemoSnapshot = \{ mode: demoMotionStream\.getMode\(\), frame \};\s*sendToRenderer\(mainWindow, ['"]motion-demo:frame['"], snapshot\);\s*\}\)/,
  'demo stream retains frame metadata and publishes a renderer snapshot through the main process'
);

console.log('demo motion stream tests passed');
