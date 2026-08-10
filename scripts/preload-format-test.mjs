import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [mainSource, preloadSource, appSource] = await Promise.all([
  readFile(new URL('../dist-electron/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../dist-electron/preload.cjs', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
]);

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

const loadSettingsSource = sourceSection(appSource, '  async function loadSettings()', '  async function saveSettings()');
const saveSettingsSource = sourceSection(appSource, '  async function saveSettings()', '  async function applyMotionDelay()');
const hardwarePanelSource = sourceSection(appSource, '  const hardwarePanel = (', '  const protectionPanel = (');
const motionMonitorPanelSource = sourceSection(appSource, '  const motionMonitorPanel = (', '  const motionDelayPanel = (');
const motionDelayPanelSource = sourceSection(appSource, '  const motionDelayPanel = (', '  const logPanel = (');

assert.match(mainSource, /preload:\s*path\.join\(__dirname, ['"]preload\.cjs['"]\)/);
assert.match(preloadSource, /require\(['"]electron['"]\)/);
assert.doesNotMatch(preloadSource, /^\s*import\s/m);
assert.match(preloadSource, /setMotionDelay:\s*\(delayMs/);
assert.match(preloadSource, /ipcRenderer\.invoke\(['"]viewer:set-motion-delay['"],\s*delayMs\)/);
assert.match(mainSource, /webContents\.send\(['"]motion:received['"],\s*snapshot\)/);
assert.match(preloadSource, /onMotionReceived:\s*\(listener/);
assert.match(preloadSource, /ipcRenderer\.on\(['"]motion:received['"],\s*handler\)/);
assert.match(preloadSource, /removeListener\(['"]motion:received['"],\s*handler\)/);
assert.match(mainSource, /async function readSettingsInTransaction\(writeAtomically\)/);
assert.match(mainSource, /viewer:set-motion-delay[\s\S]*?getSettingsStore\(\)\.exclusive\(async \(?writeAtomically\)? => \{[\s\S]*?readSettingsInTransaction\(writeAtomically\)[\s\S]*?await writeAtomically\(settings\)/);
assert.match(loadSettingsSource, /const requestId = \+\+settingsLoadRequestId\.current/);
assert.match(loadSettingsSource, /setSettingsLoading\(true\)/);
assert.match(loadSettingsSource, /const settings = await window\.hapticRelay\.getSettings\(\);\s*if \(requestId !== settingsLoadRequestId\.current\) return;/);
assert.match(loadSettingsSource, /const protectionResult = await window\.hapticRelay\.setHardwareProtection\(settings\.hardwareProtection\);\s*if \(requestId !== settingsLoadRequestId\.current\) return;/);
assert.match(loadSettingsSource, /catch \(error\) \{\s*if \(requestId === settingsLoadRequestId\.current\) \{\s*setStatusMessage/);
assert.match(loadSettingsSource, /finally \{\s*if \(requestId === settingsLoadRequestId\.current\) \{\s*setSettingsLoading\(false\)/);
assert.match(saveSettingsSource, /playback: \{ motionDelayMs: appliedMotionDelayMs \}/);
assert.match(saveSettingsSource, /setAppliedMotionDelayMs\(result\.settings\.playback\.motionDelayMs\)/);
assert.match(saveSettingsSource, /setSavedSettings\(result\.settings\)/);
assert.doesNotMatch(saveSettingsSource, /setMotionDelayMs\(/);
assert.match(hardwarePanelSource, /<button disabled=\{isBusy \|\| settingsLoading \|\| !savedSettings\} onClick=\{saveSettings\}/);
assert.match(hardwarePanelSource, /<button disabled=\{isBusy \|\| settingsLoading \|\| !savedSettings\} onClick=\{loadSettings\}/);
assert.match(motionDelayPanelSource, /<section className="panel">/);
assert.match(motionDelayPanelSource, /<input className="range"[\s\S]*?disabled=\{isBusy \|\| settingsLoading \|\| !savedSettings\}/);
assert.match(appSource, /const hasPendingMotionDelay = motionDelayMs !== appliedMotionDelayMs;/);
assert.match(motionDelayPanelSource, /<button disabled=\{isBusy \|\| settingsLoading \|\| !savedSettings \|\| !hasPendingMotionDelay\} onClick=\{applyMotionDelay\}/);
assert.match(appSource, /const removeMotionReceived = window\.hapticRelay\.onMotionReceived/);
assert.match(appSource, /setMotionMonitorEntries\(current => \[snapshot, \.\.\.current\]\.slice\(0, 10\)\)/);
assert.match(appSource, /removeMotionReceived\(\)/);
assert.match(motionMonitorPanelSource, /관리자 수신 모니터/);
assert.match(appSource, /\{motionMonitorPanel\}\s*\{motionDelayPanel\}/);

console.log('sandbox preload format: commonjs');
