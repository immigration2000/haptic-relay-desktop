import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const protocolSources = await Promise.all([
  readFile(new URL('../electron/protocol.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/shared/protocol.ts', import.meta.url), 'utf8')
]);
const defaultSources = await Promise.all([
  readFile(new URL('../electron/app-settings.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../electron/services/hardware-controller.ts', import.meta.url), 'utf8')
]);
for (const [name, source] of [
  ['Electron settings', defaultSources[0]],
  ['renderer fallback', defaultSources[1]],
  ['controller fallback', defaultSources[2]]
]) {
  assert.match(
    source,
    /strokeMin:\s*0\.3,[\s\S]*?strokeMax:\s*0\.8,[\s\S]*?stopPosition:\s*0\.5,/,
    `${name} must use the fresh 30-80% hardware defaults`
  );
}
for (const protocolSource of protocolSources) {
  assert.match(
    protocolSource,
    /export type PlaybackSettings = \{[\s\S]*?motionDelayMs:\s*number;[\s\S]*?\};/,
    'PlaybackSettings must require motionDelayMs'
  );
  assert.match(
    protocolSource,
    /export type HardwareProfile = \{[\s\S]*?stopPosition:\s*number;[\s\S]*?\};/,
    'HardwareProfile must require an absolute stopPosition'
  );
  assert.match(
    protocolSource,
    /export type AppSettings = \{[\s\S]*?schemaVersion:\s*3;[\s\S]*?playback:\s*PlaybackSettings;[\s\S]*?\};/,
    'AppSettings must use schema version 3 and require playback settings'
  );
}

const settingsModule = await import('../dist-electron/app-settings.js');

assert.deepEqual(settingsModule.DEFAULT_SETTINGS.hardwareProfile, {
  baudRate: 115200,
  linearAxis: 'L0',
  vibrationAxis: undefined,
  strokeMin: 0.3,
  strokeMax: 0.8,
  stopPosition: 0.5,
  invertPosition: false
});

const legacyHardwareProfile = {
  baudRate: 115200,
  linearAxis: 'L0',
  vibrationAxis: 'V0',
  strokeMin: 0.1,
  strokeMax: 0.9,
  invertPosition: true
};
const hardwareProfile = {
  ...legacyHardwareProfile,
  stopPosition: 0.4
};
const hardwareProtection = {
  intensityLimit: 0.8,
  positionMin: 0.1,
  positionMax: 0.9,
  paused: true
};

const migratedV2 = settingsModule.migrateAppSettings({
  schemaVersion: 2,
  hardwareProfile: legacyHardwareProfile,
  hardwareProtection,
  playback: { motionDelayMs: 700 }
});
assert.equal(migratedV2.schemaVersion, 3);
assert.equal(migratedV2.playback.motionDelayMs, 700);
assert.deepEqual(migratedV2.hardwareProfile, {
  ...legacyHardwareProfile,
  stopPosition: legacyHardwareProfile.strokeMin
});

const migratedV1 = settingsModule.migrateAppSettings({
  schemaVersion: 1,
  hardwareProfile: legacyHardwareProfile,
  hardwareProtection
});
assert.equal(migratedV1.schemaVersion, 3);
assert.equal(migratedV1.playback.motionDelayMs, 0);
assert.deepEqual(migratedV1.hardwareProfile, {
  ...legacyHardwareProfile,
  stopPosition: legacyHardwareProfile.strokeMin
});
assert.deepEqual(migratedV1.hardwareProtection, hardwareProtection);

const migratedLegacy = settingsModule.migrateAppSettings({
  hardwareProfile: legacyHardwareProfile,
  hardwareProtection
});
assert.equal(migratedLegacy.schemaVersion, 3);
assert.equal(migratedLegacy.playback.motionDelayMs, 0);
assert.deepEqual(migratedLegacy.hardwareProfile, {
  ...legacyHardwareProfile,
  stopPosition: legacyHardwareProfile.strokeMin
});
assert.deepEqual(migratedLegacy.hardwareProtection, hardwareProtection);

assert.throws(
  () => settingsModule.validateAppSettings(null),
  /invalid-app-settings/
);

const validated = settingsModule.validateAppSettings({
  schemaVersion: 3,
  hardwareProfile,
  hardwareProtection,
  playback: { motionDelayMs: 700 }
});
assert.equal(validated.playback.motionDelayMs, 700);
assert.deepEqual(validated.hardwareProfile, hardwareProfile);

for (const schemaVersion of [1, 2, 4, '3', undefined]) {
  assert.throws(
    () => settingsModule.validateAppSettings({
      schemaVersion,
      hardwareProfile,
      hardwareProtection,
      playback: { motionDelayMs: 0 }
    }),
    /unsupported-settings-version/
  );
}

for (const schemaVersion of [0, 4, '3']) {
  assert.throws(
    () => settingsModule.migrateAppSettings({
      schemaVersion,
      hardwareProfile,
      hardwareProtection
    }),
    /unsupported-settings-version/
  );
}

for (const motionDelayMs of [-100, 50, 10_100]) {
  assert.throws(
    () => settingsModule.validateAppSettings({
      schemaVersion: 3,
      hardwareProfile,
      hardwareProtection,
      playback: { motionDelayMs }
    }),
    /invalid-motion-delay/
  );
}

for (const stopPosition of [-0.1, 1.1, Number.NaN]) {
  assert.throws(
    () => settingsModule.validateHardwareProfile({ ...hardwareProfile, stopPosition }),
    /invalid-stop-position/
  );
}

for (const stopPosition of [0.05, 0.95]) {
  assert.throws(
    () => settingsModule.validateHardwareProfile({ ...hardwareProfile, stopPosition }),
    /invalid-stop-position/
  );
}

console.log('app settings v3 tests passed');
