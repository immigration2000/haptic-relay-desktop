import assert from 'node:assert/strict';

const { calculatePatternPosition, validateMotionPatternConfig } = await import(
  '../dist-electron/services/demo-motion-pattern.js'
);

const config = (pattern, overrides = {}) => ({
  pattern,
  periodMs: 1_000,
  positionMin: 0.2,
  positionMax: 0.8,
  intensity: 0.6,
  ...overrides
});

const assertClose = (actual, expected, message) => {
  assert.ok(Math.abs(actual - expected) < 0.000_001, `${message}: expected ${expected}, got ${actual}`);
};

const without = (value, key) => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};

const assertValidationError = (value, expectedCode, message) => {
  assert.throws(
    () => validateMotionPatternConfig(value),
    error => error instanceof Error && error.message === expectedCode,
    message
  );
};

const triangle = config('triangle');
for (const [elapsedMs, expected] of [
  [0, 0.2],
  [250, 0.5],
  [500, 0.8],
  [750, 0.5],
  [1_000, 0.2]
]) {
  assertClose(calculatePatternPosition(triangle, elapsedMs), expected, `triangle at ${elapsedMs}ms`);
}
assertClose(calculatePatternPosition(triangle, -250), 0.5, 'triangle uses positive modulo');

for (const pattern of ['sine', 'triangle', 'pulse', 'sawtooth']) {
  const patternConfig = config(pattern);
  for (const elapsedMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assertClose(
      calculatePatternPosition(patternConfig, elapsedMs),
      patternConfig.positionMin,
      `${pattern} fails closed for ${String(elapsedMs)}`
    );
  }
}

const sine = config('sine');
assertClose(calculatePatternPosition(sine, 0), 0.2, 'sine starts at the minimum');
assertClose(calculatePatternPosition(sine, 500), 0.8, 'sine reaches the maximum at half period');
assertClose(calculatePatternPosition(sine, 1_000), 0.2, 'sine returns to the minimum');

assertClose(calculatePatternPosition(config('sawtooth'), 500), 0.5, 'sawtooth midpoint');

const pulse = config('pulse');
for (const [elapsedMs, expected, label] of [
  [0, 0.2, 'starts at the minimum'],
  [25, 0.5, 'ramps up'],
  [50, 0.8, 'finishes the upward ramp'],
  [250, 0.8, 'holds at the maximum'],
  [500, 0.8, 'starts the downward ramp'],
  [525, 0.5, 'ramps down'],
  [550, 0.2, 'finishes the downward ramp'],
  [750, 0.2, 'holds at the minimum']
]) {
  assertClose(calculatePatternPosition(pulse, elapsedMs), expected, `pulse ${label}`);
}

const validConfig = config('sine');
assert.deepEqual(validateMotionPatternConfig(validConfig), validConfig, 'valid config is returned');

for (const [label, value, expectedCode] of [
  ['non-record null', null, 'invalid-motion-pattern'],
  ['non-record array', [], 'invalid-motion-pattern'],
  ['non-record string', 'sine', 'invalid-motion-pattern'],
  ['missing pattern', without(config('sine'), 'pattern'), 'invalid-motion-pattern'],
  ['wrong-type pattern', config(42), 'invalid-motion-pattern'],
  ['unknown pattern', config('unknown'), 'invalid-motion-pattern'],
  ['missing period', without(config('sine'), 'periodMs'), 'invalid-pattern-period'],
  ['wrong-type period', config('sine', { periodMs: '1000' }), 'invalid-pattern-period'],
  ['period below minimum', config('sine', { periodMs: 499 }), 'invalid-pattern-period'],
  ['period above maximum', config('sine', { periodMs: 5_001 }), 'invalid-pattern-period'],
  ['period NaN', config('sine', { periodMs: Number.NaN }), 'invalid-pattern-period'],
  ['period positive infinity', config('sine', { periodMs: Number.POSITIVE_INFINITY }), 'invalid-pattern-period'],
  ['period negative infinity', config('sine', { periodMs: Number.NEGATIVE_INFINITY }), 'invalid-pattern-period'],
  ['missing minimum', without(config('sine'), 'positionMin'), 'invalid-pattern-range'],
  ['wrong-type minimum', config('sine', { positionMin: '0.2' }), 'invalid-pattern-range'],
  ['minimum below zero', config('sine', { positionMin: -0.1 }), 'invalid-pattern-range'],
  ['minimum NaN', config('sine', { positionMin: Number.NaN }), 'invalid-pattern-range'],
  ['minimum positive infinity', config('sine', { positionMin: Number.POSITIVE_INFINITY }), 'invalid-pattern-range'],
  ['minimum negative infinity', config('sine', { positionMin: Number.NEGATIVE_INFINITY }), 'invalid-pattern-range'],
  ['missing maximum', without(config('sine'), 'positionMax'), 'invalid-pattern-range'],
  ['wrong-type maximum', config('sine', { positionMax: '0.8' }), 'invalid-pattern-range'],
  ['maximum above one', config('sine', { positionMax: 1.1 }), 'invalid-pattern-range'],
  ['maximum NaN', config('sine', { positionMax: Number.NaN }), 'invalid-pattern-range'],
  ['maximum positive infinity', config('sine', { positionMax: Number.POSITIVE_INFINITY }), 'invalid-pattern-range'],
  ['maximum negative infinity', config('sine', { positionMax: Number.NEGATIVE_INFINITY }), 'invalid-pattern-range'],
  ['inverted range', config('sine', { positionMin: 0.8, positionMax: 0.2 }), 'invalid-pattern-range'],
  ['missing intensity', without(config('sine'), 'intensity'), 'invalid-pattern-intensity'],
  ['wrong-type intensity', config('sine', { intensity: '0.6' }), 'invalid-pattern-intensity'],
  ['intensity below zero', config('sine', { intensity: -0.1 }), 'invalid-pattern-intensity'],
  ['intensity above one', config('sine', { intensity: 1.1 }), 'invalid-pattern-intensity'],
  ['intensity NaN', config('sine', { intensity: Number.NaN }), 'invalid-pattern-intensity'],
  ['intensity positive infinity', config('sine', { intensity: Number.POSITIVE_INFINITY }), 'invalid-pattern-intensity'],
  ['intensity negative infinity', config('sine', { intensity: Number.NEGATIVE_INFINITY }), 'invalid-pattern-intensity']
]) {
  assertValidationError(value, expectedCode, label);
}

for (const [label, value] of [
  ['minimum period', config('sine', { periodMs: 500 })],
  ['maximum period', config('sine', { periodMs: 5_000 })],
  ['zero minimum and intensity', config('sine', { positionMin: 0, intensity: 0 })],
  ['one maximum and intensity', config('sine', { positionMax: 1, intensity: 1 })],
  ['equal minimum and maximum', config('sine', { positionMin: 0.4, positionMax: 0.4 })]
]) {
  assert.deepEqual(validateMotionPatternConfig(value), value, label);
}

console.log('demo motion pattern tests passed');
