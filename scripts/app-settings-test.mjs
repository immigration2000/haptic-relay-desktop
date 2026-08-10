import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const protocolSources = await Promise.all([
  readFile(new URL('../electron/protocol.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/shared/protocol.ts', import.meta.url), 'utf8')
]);
for (const protocolSource of protocolSources) {
  assert.match(
    protocolSource,
    /export type PlaybackSettings = \{[\s\S]*?motionDelayMs:\s*number;[\s\S]*?\};/,
    'PlaybackSettings must require motionDelayMs'
  );
  assert.match(
    protocolSource,
    /export type AppSettings = \{[\s\S]*?schemaVersion:\s*2;[\s\S]*?playback:\s*PlaybackSettings;[\s\S]*?\};/,
    'AppSettings must use schema version 2 and require playback settings'
  );
}

const settingsModule = await import('../dist-electron/app-settings.js');

const hardwareProfile = {
  baudRate: 115200,
  linearAxis: 'L0',
  vibrationAxis: 'V0',
  strokeMin: 0.1,
  strokeMax: 0.9,
  invertPosition: true
};
const hardwareProtection = {
  intensityLimit: 0.8,
  positionMin: 0.1,
  positionMax: 0.9,
  paused: true
};

const migratedV1 = settingsModule.migrateAppSettings({
  schemaVersion: 1,
  hardwareProfile,
  hardwareProtection
});
assert.equal(migratedV1.schemaVersion, 2);
assert.equal(migratedV1.playback.motionDelayMs, 0);
assert.deepEqual(migratedV1.hardwareProfile, hardwareProfile);
assert.deepEqual(migratedV1.hardwareProtection, hardwareProtection);

const migratedLegacy = settingsModule.migrateAppSettings({ hardwareProfile, hardwareProtection });
assert.equal(migratedLegacy.schemaVersion, 2);
assert.equal(migratedLegacy.playback.motionDelayMs, 0);
assert.deepEqual(migratedLegacy.hardwareProfile, hardwareProfile);
assert.deepEqual(migratedLegacy.hardwareProtection, hardwareProtection);

assert.throws(
  () => settingsModule.validateAppSettings(null),
  /invalid-app-settings/
);

const validated = settingsModule.validateAppSettings({
  schemaVersion: 2,
  hardwareProfile,
  hardwareProtection,
  playback: { motionDelayMs: 700 }
});
assert.equal(validated.playback.motionDelayMs, 700);

for (const schemaVersion of [1, 3, '2', undefined]) {
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

for (const schemaVersion of [0, 3, '2']) {
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
      schemaVersion: 2,
      hardwareProfile,
      hardwareProtection,
      playback: { motionDelayMs }
    }),
    /invalid-motion-delay/
  );
}

console.log('app settings v2 tests passed');
