export const DEFAULT_RELAY_MAX_HZ = 60;
export const DEFAULT_HARDWARE_MAX_HZ = 60;
export const MIN_MOTION_INTERVAL_MS = 1000 / DEFAULT_RELAY_MAX_HZ;

export function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function maxHzToInterval(maxHz: number) {
  const normalizedHz = Number.isFinite(maxHz) && maxHz > 0 ? maxHz : DEFAULT_RELAY_MAX_HZ;
  return 1000 / normalizedHz;
}
