export const HARDWARE_MAX_HZ = Number(process.env.HAPTIC_HARDWARE_MAX_HZ ?? 60);
export const RELAY_MAX_HZ = Number(process.env.HAPTIC_RELAY_CLIENT_MAX_HZ ?? 60);
export const TCODE_LINEAR_AXIS = process.env.HAPTIC_TCODE_LINEAR_AXIS ?? 'L0';
export const TCODE_VIBRATION_AXIS = process.env.HAPTIC_TCODE_VIBRATION_AXIS || undefined;
export const TCODE_INTERVAL_MS = Number(process.env.HAPTIC_TCODE_INTERVAL_MS ?? Math.round(1000 / HARDWARE_MAX_HZ));

export function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function maxHzToInterval(maxHz: number) {
  const normalizedHz = Number.isFinite(maxHz) && maxHz > 0 ? maxHz : 60;
  return 1000 / normalizedHz;
}
