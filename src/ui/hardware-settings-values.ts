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

export function updateMotionRange(
  current: MotionRangePercent,
  handle: 'min' | 'max',
  requested: number
): MotionRangePercent {
  const value = clampPercent(requested);
  const min = handle === 'min' ? Math.min(value, current.max - 1) : current.min;
  const max = handle === 'max' ? Math.max(value, current.min + 1) : current.max;
  return { min, max, stop: Math.max(min, Math.min(max, current.stop)) };
}
