import type { MotionPattern, MotionPatternConfig } from '../protocol.js';

export function calculatePatternPosition(config: MotionPatternConfig, elapsedMs: number) {
  const finiteElapsedMs = Number.isFinite(elapsedMs) ? elapsedMs : 0;
  const phase = positiveModulo(finiteElapsedMs, config.periodMs) / config.periodMs;
  const unitPosition = calculateUnitPosition(config.pattern, phase);
  return config.positionMin + unitPosition * (config.positionMax - config.positionMin);
}

export function validateMotionPatternConfig(value: unknown): MotionPatternConfig {
  if (!isRecord(value) || !isMotionPattern(value.pattern)) {
    throw new Error('invalid-motion-pattern');
  }
  if (typeof value.periodMs !== 'number'
    || !Number.isFinite(value.periodMs)
    || value.periodMs < 500
    || value.periodMs > 5_000) {
    throw new Error('invalid-pattern-period');
  }
  if (!isUnitInterval(value.positionMin)
    || !isUnitInterval(value.positionMax)
    || value.positionMin > value.positionMax) {
    throw new Error('invalid-pattern-range');
  }
  if (!isUnitInterval(value.intensity)) {
    throw new Error('invalid-pattern-intensity');
  }

  return {
    pattern: value.pattern,
    periodMs: value.periodMs,
    positionMin: value.positionMin,
    positionMax: value.positionMax,
    intensity: value.intensity
  };
}

function calculateUnitPosition(pattern: MotionPattern, phase: number) {
  switch (pattern) {
    case 'sine':
      return (1 - Math.cos(2 * Math.PI * phase)) / 2;
    case 'triangle':
      return phase < 0.5 ? phase * 2 : (1 - phase) * 2;
    case 'sawtooth':
      return phase;
    case 'pulse':
      if (phase < 0.05) return phase / 0.05;
      if (phase < 0.5) return 1;
      if (phase < 0.55) return 1 - (phase - 0.5) / 0.05;
      return 0;
  }
}

function positiveModulo(value: number, modulus: number) {
  return ((value % modulus) + modulus) % modulus;
}

function isMotionPattern(value: unknown): value is MotionPattern {
  return value === 'sine' || value === 'triangle' || value === 'pulse' || value === 'sawtooth';
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
