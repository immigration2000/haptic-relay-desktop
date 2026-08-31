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

const malformedRanges = [
  { min: 0, max: 100, stop: 0 },
  { min: 0, max: 100, stop: 100 },
  { min: 0, max: 0, stop: 0 },
  { min: 90, max: 10, stop: 50 },
  { min: -20, max: 140, stop: 200 },
  { min: Number.NaN, max: Number.POSITIVE_INFINITY, stop: Number.NEGATIVE_INFINITY }
];
for (const current of malformedRanges) {
  for (const handle of ['min', 'max']) {
    const result = updateMotionRange(current, handle, 50);
    assert.ok(Number.isInteger(result.min) && Number.isFinite(result.min));
    assert.ok(Number.isInteger(result.max) && Number.isFinite(result.max));
    assert.ok(Number.isInteger(result.stop) && Number.isFinite(result.stop));
    assert.ok(0 <= result.min && result.min < result.max && result.max <= 100);
    assert.ok(result.min <= result.stop && result.stop <= result.max);
  }
}

console.log('hardware settings value tests passed');
