import type { AppSettings, HardwareProfile, HardwareProtection } from './protocol.js';
import { validateMotionDelayMs } from './services/motion-delay-buffer.js';

export const CURRENT_SETTINGS_SCHEMA_VERSION = 2;
export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
  hardwareProfile: {
    baudRate: 115200,
    linearAxis: 'L0',
    vibrationAxis: undefined,
    strokeMin: 0,
    strokeMax: 1,
    invertPosition: false
  },
  hardwareProtection: {
    intensityLimit: 1,
    positionMin: 0,
    positionMax: 1,
    paused: false
  },
  playback: { motionDelayMs: 0 }
};

export function validateAppSettings(value: unknown): AppSettings {
  if (!isRecord(value)) throw new Error('invalid-app-settings');
  if (value.schemaVersion !== CURRENT_SETTINGS_SCHEMA_VERSION) throw new Error('unsupported-settings-version');
  if (!isRecord(value.playback)) throw new Error('invalid-playback-settings');
  return {
    schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    hardwareProfile: validateHardwareProfile(value.hardwareProfile),
    hardwareProtection: validateHardwareProtection(value.hardwareProtection),
    playback: { motionDelayMs: validateMotionDelayMs(value.playback.motionDelayMs as number) }
  };
}

export function migrateAppSettings(value: unknown): AppSettings {
  if (!isRecord(value)) throw new Error('invalid-app-settings');
  if (value.schemaVersion === CURRENT_SETTINGS_SCHEMA_VERSION) return validateAppSettings(value);
  if (value.schemaVersion === 1 || value.schemaVersion === undefined) {
    return validateAppSettings({
      schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
      hardwareProfile: value.hardwareProfile,
      hardwareProtection: value.hardwareProtection,
      playback: { motionDelayMs: 0 }
    });
  }
  throw new Error('unsupported-settings-version');
}

export function validateHardwareProfile(value: unknown): HardwareProfile {
  if (!isRecord(value)) throw new Error('invalid-hardware-profile');

  const strokeMin = validateUnitInterval(value.strokeMin, 'strokeMin');
  const strokeMax = validateUnitInterval(value.strokeMax, 'strokeMax');
  if (strokeMin >= strokeMax) throw new Error('invalid-stroke-range');

  const vibrationAxis = value.vibrationAxis === undefined || value.vibrationAxis === ''
    ? undefined
    : validateTCodeAxis(value.vibrationAxis, 'vibrationAxis');

  return {
    baudRate: validateBaudRate(value.baudRate),
    linearAxis: validateTCodeAxis(value.linearAxis, 'linearAxis'),
    vibrationAxis,
    strokeMin,
    strokeMax,
    invertPosition: validateBoolean(value.invertPosition, 'invertPosition')
  };
}

export function validateHardwareProtection(value: unknown): HardwareProtection {
  if (!isRecord(value)) throw new Error('invalid-hardware-protection');

  const positionMin = validateUnitInterval(value.positionMin, 'protectionPositionMin');
  const positionMax = validateUnitInterval(value.positionMax, 'protectionPositionMax');
  if (positionMin >= positionMax) throw new Error('invalid-protection-position-range');

  return {
    intensityLimit: validateUnitInterval(value.intensityLimit, 'protectionIntensityLimit'),
    positionMin,
    positionMax,
    paused: validateBoolean(value.paused, 'protectionPaused')
  };
}

function validateBaudRate(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1200 || value > 1000000) {
    throw new Error('invalid-baud-rate');
  }
  return value;
}

function validateTCodeAxis(value: unknown, fieldName: string) {
  if (typeof value !== 'string') throw new Error(`invalid-${fieldName}`);
  const axis = value.trim().toUpperCase();
  if (!/^[LRVA][0-9]$/.test(axis)) throw new Error(`invalid-${fieldName}`);
  return axis;
}

export function validateUnitInterval(value: unknown, fieldName: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`invalid-${fieldName}`);
  }
  return value;
}

export function validateBoolean(value: unknown, fieldName: string) {
  if (typeof value !== 'boolean') throw new Error(`invalid-${fieldName}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
