import assert from 'node:assert/strict';

const {
  clampPercent,
  normalizedToPercent,
  percentToNormalized,
  updateMotionRange
} = await import('../src/ui/hardware-settings-values.ts');

assert.equal(clampPercent(-5), 0);
assert.equal(clampPercent(105), 100);
assert.equal(normalizedToPercent(0.3), 30);
assert.equal(normalizedToPercent(0.805), 81);
assert.equal(percentToNormalized(80), 0.8);
assert.equal(percentToNormalized(Number.NaN), 0);
assert.deepEqual(updateMotionRange({ min: 30, max: 80, stop: 50 }, 'min', 70), { min: 70, max: 80, stop: 70 });
assert.deepEqual(updateMotionRange({ min: 30, max: 80, stop: 50 }, 'max', 40), { min: 30, max: 40, stop: 40 });
assert.deepEqual(updateMotionRange({ min: 30, max: 80, stop: 50 }, 'min', 95), { min: 79, max: 80, stop: 79 });

console.log('hardware settings value tests passed');
