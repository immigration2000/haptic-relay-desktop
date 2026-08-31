export const DEFAULT_MANUAL_MAX_POSITION_SPEED = 2;
export const MIN_MANUAL_MAX_POSITION_SPEED = 0.5;
export const MAX_MANUAL_MAX_POSITION_SPEED = 4;
export const MANUAL_MAX_POSITION_SPEED_STEP = 0.25;

export function validateManualMaxPositionSpeed(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('invalid-manual-motion-speed');
  if (value < MIN_MANUAL_MAX_POSITION_SPEED || value > MAX_MANUAL_MAX_POSITION_SPEED) throw new Error('invalid-manual-motion-speed');
  const steps = value / MANUAL_MAX_POSITION_SPEED_STEP;
  if (Math.abs(steps - Math.round(steps)) > Number.EPSILON * 16) throw new Error('invalid-manual-motion-speed');
  return value;
}
