export type MotionRangePercent = { min: number; max: number; stop: number };

export function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function normalizedToPercent(value: number) {
  return clampPercent(value * 100);
}

export function percentToNormalized(value: number) {
  return clampPercent(value) / 100;
}

export function normalizedSpeedToPercent(value: number) {
  return Math.round(value * 100);
}

export function percentSpeedToNormalized(value: number) {
  return value / 100;
}

export function formatTraversalSeconds(manualMaxPositionSpeed: number) {
  return (1 / manualMaxPositionSpeed).toFixed(2);
}

export function updateMotionRange(
  current: MotionRangePercent,
  handle: 'min' | 'max',
  requested: number
): MotionRangePercent {
  const value = clampPercent(requested);
  let min = clampPercent(current.min);
  let max = clampPercent(current.max);
  const stop = clampPercent(current.stop);

  if (min >= max) {
    if (min === 100) {
      min = 99;
      max = 100;
    } else {
      max = min + 1;
    }
  }

  min = handle === 'min' ? Math.min(value, max - 1) : min;
  max = handle === 'max' ? Math.max(value, min + 1) : max;
  return { min, max, stop: Math.max(min, Math.min(max, stop)) };
}
