import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [mainSource, preloadSource, appSource, motionDemoPanelSource, roomSessionSource, demoDataSource, stylesSource, relayClientSource, relayServerSource] = await Promise.all([
  readFile(new URL('../dist-electron/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../dist-electron/preload.cjs', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/ui/components/MotionDemoPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/ui/views/RoomSessionView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/ui/demo-data.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../electron/services/relay-client.ts', import.meta.url), 'utf8'),
  readFile(new URL('../server/src/relay-server.ts', import.meta.url), 'utf8')
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
const runActionSource = sourceSection(appSource, '  async function runAction(', '  function updateHardwareProfile(');
const testHardwareSource = sourceSection(appSource, '  async function testHardware()', '  async function createRoom()');
const emergencyStopSource = sourceSection(appSource, '  async function emergencyStop()', '  async function exportLogs()');

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
assert.match(appSource, /async function disconnectHardware\(\)/);
assert.match(appSource, /async function disconnectHardware\(\)[\s\S]*?window\.hapticRelay\.disconnectHardware\(\)[\s\S]*?setHardwareConnected\(result\.connected\)[\s\S]*?장비 전원을 직접 차단하세요[\s\S]*?async function testHardware\(\)/);
assert.match(appSource, /window\.hapticRelay\.getHardwareStatus\(\)/);
assert.match(appSource, /window\.hapticRelay\.onHardwareConnectionStatus\(nextStatus\s*=>/);
assert.match(appSource, /removeHardwareConnectionStatus\(\)/);
assert.match(appSource, /const actionGenerationRef = useRef\(0\)/);
assert.match(runActionSource, /const actionGeneration = \+\+actionGenerationRef\.current/);
assert.match(runActionSource, /if \(actionGeneration === actionGenerationRef\.current\) setBusyAction\(undefined\)/);
assert.match(testHardwareSource, /runAction\(['"]hardware['"], ['"]하드웨어 테스트 중['"], async setActionStatus =>/);
assert.match(testHardwareSource, /setActionStatus\(['"]warning['"], formatReason\(result\.reason \?\? ['"]hardware-test-failed['"]\)\)/);
assert.doesNotMatch(testHardwareSource, /setStatusMessage\(/);
assert.match(emergencyStopSource, /const actionGeneration = \+\+actionGenerationRef\.current/);
assert.match(emergencyStopSource, /if \(actionGeneration === actionGenerationRef\.current\) setBusyAction\(undefined\)/);
assert.match(appSource, /async function localEmergencyStop\(\)[\s\S]*?window\.hapticRelay\.stopHardware\(\)[\s\S]*?async function emergencyStop\(\)/);
assert.match(appSource, /async function localEmergencyStop\(\)[\s\S]*?setHardwareProtection\(result\.protection\)[\s\S]*?async function emergencyStop\(\)/);
assert.match(appSource, /async function applyHardwareProtection\(\)[\s\S]*?result\.stop[\s\S]*?장비 전원을 직접 차단하세요/);
assert.match(appSource, /onEmergencyStop\(signal =>[\s\S]*?setHardwareProtection\(signal\.hardware\.protection\)[\s\S]*?hardware-stop-write-failed[\s\S]*?장비 전원을 직접 차단하세요/);
assert.match(emergencyStopSource, /setHardwareProtection\(result\.hardware\.protection\)/);
assert.match(appSource, /screen === ['"]safety['"][\s\S]*?로컬 긴급 정지[\s\S]*?onClick=\{localEmergencyStop\}/);
assert.match(mainSource, /ipcMain\.handle\(['"]hardware:emergency-stop['"][\s\S]*?assertTrustedSender\(event\)[\s\S]*?demoMotionStream\.stop\(\)[\s\S]*?relay\.clearBufferedMotion\(\)[\s\S]*?hardware\.pauseAndStop\(\)/);
assert.match(mainSource, /room:emergency-stop[\s\S]*?hardware\.pauseAndStop\(\)[\s\S]*?hardwareResult/);
assert.match(mainSource, /ipcMain\.handle\(['"]room:emergency-stop['"][\s\S]*?const relayStop = relay\.emergencyStop\(\)[\s\S]*?const hardwareStop = hardware\.pauseAndStop\(\)[\s\S]*?Promise\.all\(\[hardwareStop, relayStop\]\)/);
assert.match(relayClientSource, /clearBufferedMotion\(\)[\s\S]*?clearDelayedMotion\(\)[\s\S]*?latestFrame = undefined/);
assert.doesNotMatch(relayServerSource, /handleEmergencyStop[\s\S]*?\.volatile[\s\S]*?emit\(['"]room:stop/);
assert.match(mainSource, /app\.on\(['"]before-quit['"][\s\S]*?event\.preventDefault\(\)[\s\S]*?shutdownApplication\(\)\.finally[\s\S]*?app\.quit\(\)/);
assert.match(mainSource, /function shutdownApplication\(\)[\s\S]*?relay\.disconnect\(\)[\s\S]*?hardware\.disconnectSafely\(\)/);
assert.doesNotMatch(mainSource, /app\.on\(['"]window-all-closed['"][\s\S]*?hardware\.disconnect\(\)/);
assert.match(hardwarePanelSource, /disabled=\{isBusy \|\| hardwareConnected \|\| !selectedPort\}[\s\S]*?>연결<\/button>/);
assert.match(hardwarePanelSource, /disabled=\{isBusy \|\| !hardwareConnected\}[\s\S]*?onClick=\{disconnectHardware\}>연결 해제<\/button>/);
assert.match(hardwarePanelSource, /disabled=\{isBusy \|\| !hardwareConnected\}[\s\S]*?onClick=\{testHardware\}>테스트<\/button>/);
assert.match(appSource, /const CURRENT_SETTINGS_SCHEMA_VERSION = 3;/);
assert.match(hardwarePanelSource, /긴급 정지 위치/);
assert.match(hardwarePanelSource, /min=\{hardwareProfile\.strokeMin\}/);
assert.match(hardwarePanelSource, /max=\{hardwareProfile\.strokeMax\}/);
assert.match(hardwarePanelSource, /value=\{hardwareProfile\.stopPosition\}/);
assert.match(hardwarePanelSource, /disabled=\{hardwareConnected \|\| isBusy\}/);
assert.match(hardwarePanelSource, /updateHardwareProfile\(\{ stopPosition: Number\(event\.target\.value\) \}\)/);
assert.match(appSource, /stopPosition:\s*Math\.min\(high, Math\.max\(low, next\.stopPosition\)\)/);
assert.match(hardwarePanelSource, /Baudrate[\s\S]*?<select[^>]*disabled=\{hardwareConnected \|\| isBusy\}/);
assert.match(hardwarePanelSource, /최소 위치[\s\S]*?<input[^>]*disabled=\{hardwareConnected \|\| isBusy\}/);
assert.match(hardwarePanelSource, /최대 위치[\s\S]*?<input[^>]*disabled=\{hardwareConnected \|\| isBusy\}/);
assert.match(hardwarePanelSource, /disabled=\{isBusy \|\| settingsLoading \|\| !savedSettings \|\| hardwareConnected\} onClick=\{loadSettings\}>설정 불러오기/);
assert.match(demoDataSource, /\[\s*\{ id: ['"]aws-main['"], name: ['"]AWS 메인 릴레이['"], url: ['"]https:\/\/aws-relay\.syncra\.uk['"]/);
assert.match(demoDataSource, /\{ id: ['"]phone-backup['"], name: ['"]휴대폰 예비 릴레이['"], url: ['"]https:\/\/relay\.syncra\.uk['"]/);
assert.doesNotMatch(demoDataSource, /example\.com/);
assert.match(appSource, /useState\(import\.meta\.env\.VITE_RELAY_URL \?\? RELAY_SERVERS\[0\]\.url\)/);
assert.match(stylesSource, /\.hardware-row\s*\{[^}]*grid-template-columns:\s*minmax\(160px, 1fr\) repeat\(4, auto\)/);
for (const reason of [
  'hardware-write-timeout',
  'hardware-write-failed',
  'hardware-port-error',
  'hardware-port-closed',
  'hardware-disconnected-stop-failed',
  'hardware-test-cancelled',
  'invalid-stop-position'
]) {
  assert.match(appSource, new RegExp(`['"]${reason}['"]\\s*:`), `missing Korean reason mapping: ${reason}`);
}
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
assert.match(hardwarePanelSource, /<button disabled=\{isBusy \|\| settingsLoading \|\| !savedSettings \|\| hardwareConnected\} onClick=\{loadSettings\}/);
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
