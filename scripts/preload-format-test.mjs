import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [mainSource, preloadSource, appSource, motionDemoPanelSource, roomSessionSource] = await Promise.all([
  readFile(new URL('../dist-electron/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../dist-electron/preload.cjs', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/ui/components/MotionDemoPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/ui/views/RoomSessionView.tsx', import.meta.url), 'utf8')
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
const createRoomSource = sourceSection(appSource, '  async function createRoom()', '  async function copyInvite()');
const joinRoomSource = sourceSection(appSource, '  async function joinRoom()', '  async function decideApproval(');
const motionDemoSource = sourceSection(appSource, '  async function toggleMotionDemo()', '  async function leaveRoom()');

assert.match(mainSource, /preload:\s*path\.join\(__dirname, ['"]preload\.cjs['"]\)/);
assert.match(preloadSource, /require\(['"]electron['"]\)/);
assert.doesNotMatch(preloadSource, /^\s*import\s/m);
assert.match(preloadSource, /setMotionDelay:\s*\(delayMs/);
assert.match(preloadSource, /ipcRenderer\.invoke\(['"]viewer:set-motion-delay['"],\s*delayMs\)/);
assert.match(preloadSource, /listRooms:\s*\(relayUrl\).*?ipcRenderer\.invoke\(['"]room:list['"],\s*relayUrl\)/);
assert.match(mainSource, /ipcMain\.handle\(['"]room:list['"][\s\S]*?assertTrustedSender\(event\)[\s\S]*?relay\.listRooms\(validateRelayUrl\(relayUrl\)\)/);
assert.match(preloadSource, /checkServer:\s*\(relayUrl\).*?ipcRenderer\.invoke\(['"]server:check['"],\s*relayUrl\)/);
assert.match(mainSource, /ipcMain\.handle\(['"]server:check['"][\s\S]*?assertTrustedSender\(event\)[\s\S]*?relay\.checkHealth\(validateRelayUrl\(relayUrl\)\)/);
assert.match(mainSource, /sendToRenderer\(mainWindow, ['"]motion:received['"], snapshot\)/);
assert.match(preloadSource, /startMotionDemo:\s*\(intensity, position\).*?ipcRenderer\.invoke\(['"]motion-demo:start['"], intensity, position\)/);
assert.match(preloadSource, /updateMotionDemo:\s*\(intensity, position\).*?ipcRenderer\.send\(['"]motion-demo:update['"], intensity, position\)/);
assert.match(preloadSource, /startMotionPattern:\s*\(config\).*?ipcRenderer\.invoke\(['"]motion-demo:start-pattern['"], config\)/);
assert.match(preloadSource, /updateMotionPattern:\s*\(config\).*?ipcRenderer\.send\(['"]motion-demo:update-pattern['"], config\)/);
assert.match(preloadSource, /stopMotionDemo:\s*\(\).*?ipcRenderer\.invoke\(['"]motion-demo:stop['"]\)/);
assert.match(mainSource, /ipcMain\.on\(['"]motion-demo:update['"][\s\S]*?try \{[\s\S]*?demoMotionStream\.update[\s\S]*?catch \(error\)[\s\S]*?motion-demo-update-rejected/);
assert.match(mainSource, /ipcMain\.handle\(['"]motion-demo:start-pattern['"][\s\S]*?assertTrustedSender\(event\)[\s\S]*?validated\s*=\s*validateMotionPatternConfig\(config\)[\s\S]*?message: ['"]motion-pattern-started['"], details: validated\.pattern[\s\S]*?demoMotionStream\.startPattern\(validated\)/);
assert.match(mainSource, /ipcMain\.on\(['"]motion-demo:update-pattern['"][\s\S]*?try \{[\s\S]*?assertTrustedSender\(event\)[\s\S]*?validated\s*=\s*validateMotionPatternConfig\(config\)[\s\S]*?demoMotionStream\.updatePattern\(validated\)[\s\S]*?catch \(error\)[\s\S]*?level: ['"]warning['"][\s\S]*?message: ['"]motion-pattern-update-rejected['"], details: formatError\(error\)/);
assert.match(mainSource, /publishMotion\(frame\);\s*const snapshot = \{ mode: demoMotionStream\.getMode\(\), frame \};\s*sendToRenderer\(mainWindow, ['"]motion-demo:frame['"], snapshot\)/);
assert.match(preloadSource, /onMotionDemoFrame:\s*\(listener\)/);
assert.match(preloadSource, /ipcRenderer\.on\(['"]motion-demo:frame['"],\s*handler\)/);
assert.match(preloadSource, /removeListener\(['"]motion-demo:frame['"],\s*handler\)/);
assert.match(preloadSource, /onMotionReceived:\s*\(listener/);
assert.match(preloadSource, /ipcRenderer\.on\(['"]motion:received['"],\s*handler\)/);
assert.match(preloadSource, /removeListener\(['"]motion:received['"],\s*handler\)/);
assert.match(preloadSource, /onHardwareOutput:\s*\(listener/);
assert.match(preloadSource, /ipcRenderer\.on\(['"]hardware:output['"],\s*handler\)/);
assert.match(preloadSource, /removeListener\(['"]hardware:output['"],\s*handler\)/);
assert.match(mainSource, /new HardwareController\(\{[\s\S]*?onOutput:[\s\S]*?hardware:output/);
assert.match(mainSource, /onConnectionStatus:\s*status\s*=>\s*sendToRenderer\(mainWindow, ['"]hardware:connection-status['"], status\)/);
assert.match(mainSource, /ipcMain\.handle\(['"]hardware:status['"][\s\S]*?assertTrustedSender\(event\)[\s\S]*?hardware\.getConnectionStatus\(\)/);
assert.match(mainSource, /ipcMain\.handle\(['"]hardware:disconnect['"][\s\S]*?assertTrustedSender\(event\)[\s\S]*?hardware\.disconnectSafely\(\)/);
assert.match(preloadSource, /getHardwareStatus:\s*\(\)\s*=>[^\n]*?ipcRenderer\.invoke\(['"]hardware:status['"]\)/);
assert.match(preloadSource, /onHardwareConnectionStatus:\s*\(listener\)/);
assert.match(preloadSource, /ipcRenderer\.on\(['"]hardware:connection-status['"],\s*handler\)/);
assert.match(preloadSource, /removeListener\(['"]hardware:connection-status['"],\s*handler\)/);
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
assert.match(appSource, /const \[hostPage, setHostPage\] = useState<HostPage>\(['"]setup['"]\)/);
assert.match(appSource, /const \[viewerPage, setViewerPage\] = useState<ViewerPage>\(['"]join['"]\)/);
assert.match(createRoomSource, /setHostPage\(['"]room['"]\)/);
assert.match(joinRoomSource, /setViewerPage\(['"]room['"]\)/);
assert.match(motionDemoSource, /window\.hapticRelay\.startMotionDemo\(intensity, position\)/);
assert.match(motionDemoSource, /window\.hapticRelay\.stopMotionDemo\(\)/);
assert.match(appSource, /window\.hapticRelay\.updateMotionDemo\(intensity, position\)/);
assert.match(roomSessionSource, /className="session-tabs"/);
assert.match(roomSessionSource, /className="session-content"/);
assert.match(motionDemoPanelSource, /className="motion-demo-controls"/);

console.log('sandbox preload format: commonjs');
