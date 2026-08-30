import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [mainSource, preloadSource, appSource, motionDemoPanelSource, roomSessionSource, demoDataSource, stylesSource, relayClientSource, relayServerSource, hardwareOutputMonitorSource] = await Promise.all([
  readFile(new URL('../dist-electron/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../dist-electron/preload.cjs', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/ui/components/MotionDemoPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/ui/views/RoomSessionView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/ui/demo-data.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../electron/services/relay-client.ts', import.meta.url), 'utf8'),
  readFile(new URL('../server/src/relay-server.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/ui/components/HardwareOutputMonitor.tsx', import.meta.url), 'utf8')
]);

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function evaluateSourceFunction(source, start, end) {
  const functionSource = sourceSection(source, start, end)
    .replace(/:\s*number/g, '')
    .replace(/:\s*HardwareEmergencyState/g, '');
  return Function(`"use strict"; return (${functionSource.trim()});`)();
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
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
const applyHardwareProtectionSource = sourceSection(appSource, '  async function applyHardwareProtection()', '  async function refreshPorts(');
const refreshPortsSource = sourceSection(appSource, '  async function refreshPorts(', '  async function connectHardware()');
const disconnectHardwareSource = sourceSection(appSource, '  async function disconnectHardware()', '  async function testHardware()');
const leaveRoomSource = sourceSection(appSource, '  async function leaveRoom()', '  async function localEmergencyStop()');
const localEmergencyStopSource = sourceSection(appSource, '  async function localEmergencyStop()', '  async function emergencyStop()');
const releaseEmergencyStopSource = sourceSection(appSource, '  async function releaseEmergencyStop()', '  async function exportLogs()');
const viewerStatusSource = sourceSection(appSource, '    const removeViewerStatus = window.hapticRelay.onViewerStatus', '    const removeViewerList = window.hapticRelay.onViewerList');
const receivedEmergencyStopSource = sourceSection(appSource, '    const removeEmergencyStop = window.hapticRelay.onEmergencyStop', '    let emergencyStateActive = true;');
const windowAllClosedSource = sourceSection(mainSource, "app.on('window-all-closed'", "app.on('before-quit'");
const receivedRoomStopSource = sourceSection(mainSource, '}, signal => {', '}, status => {');
const hardwareEmergencyStateSource = sourceSection(mainSource, "ipcMain.handle('hardware:emergency-state'", "ipcMain.handle('hardware:emergency-stop'");
const hardwareEmergencyStopSource = sourceSection(mainSource, "ipcMain.handle('hardware:emergency-stop'", "ipcMain.handle('hardware:emergency-release'");
const formatLogMessageSource = sourceSection(appSource, 'function formatLogMessage(message: string)', 'function formatReason(reason: string)');
const formatReasonSource = sourceSection(appSource, 'function formatReason(reason: string)', '  return messages[reason] ?? reason;');
const createEmergencyStateRevision = evaluateSourceFunction(appSource, 'function createEmergencyStateRevision()', 'function shouldApplyReceivedEmergencyState');
const shouldApplyReceivedEmergencyState = evaluateSourceFunction(appSource, 'function shouldApplyReceivedEmergencyState', 'function mapDirectoryRoom');

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
assert.match(hardwareOutputMonitorSource, /output \? ['"]직렬 전송 완료['"]/);
assert.doesNotMatch(hardwareOutputMonitorSource, /출력 성공/);
assert.match(mainSource, /new HardwareController\(\{[\s\S]*?onDiagnostic:\s*routeHardwareDiagnostic/);
assert.match(mainSource, /onConnectionStatus:\s*status\s*=>\s*sendToRenderer\(mainWindow, ['"]hardware:connection-status['"], status\)/);
assert.match(mainSource, /ipcMain\.handle\(['"]hardware:status['"][\s\S]*?assertTrustedSender\(event\)[\s\S]*?hardware\.getConnectionStatus\(\)/);
assert.match(mainSource, /ipcMain\.handle\(['"]hardware:disconnect['"][\s\S]*?assertTrustedSender\(event\)[\s\S]*?hardware\.disconnect\(\)/);
assert.match(preloadSource, /getHardwareStatus:\s*\(\)\s*=>[^\n]*?ipcRenderer\.invoke\(['"]hardware:status['"]\)/);
assert.match(preloadSource, /getHardwareEmergencyState:\s*\(\)\s*=>\s*[\w.]*ipcRenderer\.invoke\(['"]hardware:emergency-state['"]\)/);
assert.match(preloadSource, /releaseHardwareStop:\s*\(\)\s*=>\s*[\w.]*ipcRenderer\.invoke\(['"]hardware:emergency-release['"]\)/);
assert.match(preloadSource, /onHardwareConnectionStatus:\s*\(listener\)/);
assert.match(preloadSource, /ipcRenderer\.on\(['"]hardware:connection-status['"],\s*handler\)/);
assert.match(preloadSource, /removeListener\(['"]hardware:connection-status['"],\s*handler\)/);
assert.match(appSource, /async function disconnectHardware\(\)/);
assert.match(disconnectHardwareSource, /하드웨어 연결 해제 중[\s\S]*?window\.hapticRelay\.disconnectHardware\(\)[\s\S]*?setHardwareConnected\(result\.connected\)[\s\S]*?하드웨어 연결 해제됨/);
assert.doesNotMatch(disconnectHardwareSource, /정지 명령|stop\./);
assert.match(appSource, /window\.hapticRelay\.getHardwareStatus\(\)/);
assert.match(appSource, /window\.hapticRelay\.onHardwareConnectionStatus\(nextStatus\s*=>/);
assert.match(
  appSource,
  /applyHardwareStatus[\s\S]*?nextStatus\.emergencyStopped !== undefined[\s\S]*?applyEmergencyState\(\{ emergencyStopped: nextStatus\.emergencyStopped \}\)/,
  'unexpected hardware disconnect state synchronizes the local emergency latch in the UI'
);
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
assert.match(viewerStatusSource, /if \(nextStatus\.status === ['"]removed['"]\)[\s\S]*?if \(roleRef\.current === ['"]host['"]\)[\s\S]*?setHostPage\(['"]setup['"]\)[\s\S]*?setHostTab\(['"]overview['"]\)[\s\S]*?else[\s\S]*?setViewerPage\(['"]join['"]\)[\s\S]*?setViewerTab\(['"]receive['"]\)/);
for (const cleanup of ['setHostRoomInvite(undefined)', 'setApprovalRequests([])', 'setViewerSessions([])', 'setMotionDemoActive(false)', "setScreen('browser')"]) {
  assert.ok(viewerStatusSource.includes(cleanup), `terminal room removal performs cleanup: ${cleanup}`);
}
assert.match(viewerStatusSource, /void window\.hapticRelay\.stopMotionDemo\(\)\.catch\(\(\) => undefined\)/);
assert.match(viewerStatusSource, /formatReason\(nextStatus\.reason \?\? ['"]room-rejoin-failed['"]\)/);
assert.doesNotMatch(viewerStatusSource, /nextStatus\.reason === ['"]block['"] \? ['"]차단['"] : ['"]강퇴['"]/);
assert.match(receivedEmergencyStopSource, /if \(!shouldApplyReceivedEmergencyState\(signal\.hardware\)\) return;[\s\S]*?applyEmergencyState\(signal\.hardware\)/);
assert.equal(shouldApplyReceivedEmergencyState({ emergencyStopped: false, stopped: true }), false, 'successful pending room stop completed after release stays released');
assert.equal(shouldApplyReceivedEmergencyState({ emergencyStopped: false, stopped: false, reason: 'hardware-stop-write-failed' }), false, 'failed pending room stop completed after release stays released');
assert.equal(shouldApplyReceivedEmergencyState({ emergencyStopped: true, stopped: true }), true, 'current received room stop applies the latch');
assert.match(appSource, /useState\(false\)[\s\S]*?getHardwareEmergencyState\(\)/);
assert.match(appSource, /async function releaseEmergencyStop\(\)[\s\S]*?releaseHardwareStop\(\)/);
assert.match(appSource, /viewerTab === ['"]safety['"][\s\S]*?emergencyStopPanel/);
assert.match(appSource, /긴급정지 해제/);
assert.doesNotMatch(appSource, /async function leaveRoom\(\)[\s\S]*?setEmergencyStopped\(false\)[\s\S]*?async function localEmergencyStop/);
assert.match(localEmergencyStopSource, /emergencyStateRevisionRef\.current\.invalidate\(\)[\s\S]*?await window\.hapticRelay\.stopHardware\(\)/);
assert.match(emergencyStopSource, /emergencyStateRevisionRef\.current\.invalidate\(\)[\s\S]*?await window\.hapticRelay\.emergencyStop\(\)/);
assert.match(releaseEmergencyStopSource, /emergencyStateRevisionRef\.current\.invalidate\(\)[\s\S]*?await window\.hapticRelay\.releaseHardwareStop\(\)/);
assert.match(appSource, /function applyEmergencyState\(state: HardwareEmergencyState\)[\s\S]*?emergencyStateRevisionRef\.current\.invalidate\(\)[\s\S]*?setEmergencyStopped\(state\.emergencyStopped\)/);
assert.match(appSource, /onEmergencyStop\(signal =>[\s\S]*?applyEmergencyState\(signal\.hardware\)[\s\S]*?const requestedRevision = emergencyStateRevisionRef\.current\.capture\(\);[\s\S]*?getHardwareEmergencyState\(\)[\s\S]*?emergencyStateRevisionRef\.current\.isCurrent\(requestedRevision\)[\s\S]*?applyEmergencyState\(result\)/);
assert.match(appSource, /\.catch\(error => \{\s*if \(emergencyStateActive && emergencyStateRevisionRef\.current\.isCurrent\(requestedRevision\)\) setStatusMessage\(['"]error['"], formatError\(error\)\)/);
assert.match(localEmergencyStopSource, /applyEmergencyState\(result\)/);
assert.match(emergencyStopSource, /applyEmergencyState\(result\.hardware\)/);
assert.doesNotMatch(applyHardwareProtectionSource, /result\.stop|stopHardware|applyEmergencyState/);
assert.match(releaseEmergencyStopSource, /const actionGeneration = \+\+actionGenerationRef\.current[\s\S]*?releaseHardwareStop\(\)[\s\S]*?applyEmergencyState\(result\)[\s\S]*?if \(actionGeneration === actionGenerationRef\.current\) setBusyAction\(undefined\)/);
assert.match(leaveRoomSource, /const result = await window\.hapticRelay\.disconnectRoom\(\)[\s\S]*?const stopFailed = !result\.stop\.stopped && result\.stop\.reason !== ['"]hardware-not-connected['"]/);
assert.match(appSource, /const emergencyStopPanel = \([\s\S]*?data-emergency-stopped=\{emergencyStopped\}[\s\S]*?emergencyStopped \? releaseEmergencyStop : roomWideStop \? emergencyStop : localEmergencyStop/);
assert.match(appSource, /hostTab === ['"]safety['"][\s\S]*?emergencyStopPanel/);
assert.match(appSource, /screen === ['"]safety['"][\s\S]*?emergencyStopPanel/);

for (const completion of ['success', 'rejection']) {
  const revision = createEmergencyStateRevision();
  const requestedRevision = revision.capture();
  const deferred = createDeferred();
  let emergencyStopped = false;
  let statusMessage = '초기 조회 중';
  const query = deferred.promise.then(result => {
    if (!revision.isCurrent(requestedRevision)) return;
    emergencyStopped = result.emergencyStopped;
    statusMessage = '초기 조회 완료';
  }).catch(error => {
    if (!revision.isCurrent(requestedRevision)) return;
    statusMessage = error.message;
  });

  revision.invalidate();
  statusMessage = '긴급 정지 처리 중';
  if (completion === 'success') deferred.resolve({ emergencyStopped: true });
  else deferred.reject(new Error('stale-initial-query'));
  await query;

  assert.equal(emergencyStopped, false, `stale startup query ${completion} does not overwrite emergency state`);
  assert.equal(statusMessage, '긴급 정지 처리 중', `stale startup query ${completion} does not overwrite mutation status`);
}
assert.match(hardwareEmergencyStateSource, /ipcMain\.handle\(['"]hardware:emergency-state['"][\s\S]*?assertTrustedSender\(event\)[\s\S]*?hardware\.getEmergencyStopState\(\)/);
assert.match(hardwareEmergencyStopSource, /ipcMain\.handle\(['"]hardware:emergency-stop['"][\s\S]*?assertTrustedSender\(event\)[\s\S]*?demoMotionStream\.stop\(\)[\s\S]*?relay\.clearBufferedMotion\(\)[\s\S]*?hardware\.latchEmergencyStop\(\)/);
assert.match(mainSource, /ipcMain\.handle\(['"]hardware:emergency-release['"][\s\S]*?assertTrustedSender\(event\)[\s\S]*?hardware\.releaseEmergencyStop\(\)/);
assert.match(receivedRoomStopSource, /const hardwareResult = await hardware\.latchEmergencyStop\(\)/);
assert.match(mainSource, /ipcMain\.handle\(['"]room:emergency-stop['"][\s\S]*?const relayStop = relay\.emergencyStop\(\)[\s\S]*?const hardwareStop = hardware\.latchEmergencyStop\(\)[\s\S]*?Promise\.all\(\[hardwareStop, relayStop\]\)/);
assert.match(mainSource, /const relayStop = relay\.emergencyStop\(\)\.catch\([\s\S]*?sent: false[\s\S]*?reason: ['"]room-stop-failed['"]/);
assert.match(mainSource, /ipcMain\.handle\(['"]room:disconnect['"][\s\S]*?hardware\.stopForRoomExit\(\)[\s\S]*?relay\.disconnect\(\)[\s\S]*?stop/);
assert.match(mainSource, /status\.status === ['"]removed['"][\s\S]*?hardware\.stopForRoomExit\(\)/);
assert.match(relayClientSource, /clearBufferedMotion\(\)[\s\S]*?clearDelayedMotion\(\)[\s\S]*?latestFrame = undefined/);
assert.match(relayClientSource, /lifecycleGeneration[\s\S]*?relay-lifecycle-cancelled/);
assert.match(relayClientSource, /private async rejoinSession\(\)[\s\S]*?response\.ok[\s\S]*?clearActiveRoomState\(\)[\s\S]*?status: ['"]removed['"]/);
assert.match(mainSource, /status\.status === ['"]removed['"][\s\S]*?hardware\.stopForRoomExit\(\)[\s\S]*?sendToRenderer\(mainWindow, ['"]room:viewer-status['"], status\)/);
assert.doesNotMatch(relayServerSource, /handleEmergencyStop[\s\S]*?\.volatile[\s\S]*?emit\(['"]room:stop/);
assert.match(mainSource, /app\.on\(['"]before-quit['"][\s\S]*?event\.preventDefault\(\)[\s\S]*?shutdownApplication\(\)\.finally[\s\S]*?app\.quit\(\)/);
assert.match(mainSource, /function shutdownApplication\(\)[\s\S]*?relay\.hasActiveRoom\(\)[\s\S]*?hardware\.stopForRoomExit\(\)[\s\S]*?relay\.disconnect\(\)[\s\S]*?hardware\.disconnect\(\)/);
assert.match(mainSource, /app\.whenReady\(\)\.then\([\s\S]*?path\.join\(app\.getPath\(['"]userData['"]\), ['"]logs['"]\)[\s\S]*?session-started/);
assert.match(mainSource, /function routeHardwareDiagnostic\([\s\S]*?hardware-motion-sample[\s\S]*?recordMotion\([\s\S]*?diagnosticLogStore\.record\(/);
assert.match(mainSource, /DIAGNOSTIC_DATA_FIELDS\s*=\s*\[[\s\S]*?['"]dtr['"][\s\S]*?['"]rts['"]/);
assert.match(mainSource, /function routeHardwareDiagnostic\([\s\S]*?recordBoundary\(/);
assert.match(mainSource, /function reportPersistentLogFailure\([\s\S]*?persistent-log-disabled/);
const persistentFailureSource = sourceSection(mainSource, 'function reportPersistentLogFailure(', 'function routeHardwareDiagnostic(');
assert.doesNotMatch(persistentFailureSource, /diagnosticLogStore\?\.record|diagnosticLogStore\.record/);
assert.match(mainSource, /function shutdownApplication\(\)[\s\S]*?await hardware\.disconnect\(\)[\s\S]*?flushDiagnosticsForShutdown\(\)/);
assert.match(mainSource, /function flushDiagnosticsForShutdown\([\s\S]*?recordBoundary\([\s\S]*?event:\s*['"]session-ended['"][\s\S]*?diagnosticLogStore\?\.flush\(\)[\s\S]*?Promise\.race\(/);
assert.match(mainSource, /app:export-logs[\s\S]*?buildLogExportPayload\(/);
assert.doesNotMatch(mainSource, /pauseAndStop|disconnectSafely/);
assert.doesNotMatch(windowAllClosedSource, /hardware\.disconnect\(\)/);
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
const selectedPortUpdaterMatch = refreshPortsSource.match(/setSelectedPort\(current => ([\s\S]*?)\);/);
assert.ok(selectedPortUpdaterMatch, 'port refresh uses the current selection and the latest port list');
const updateSelectedPort = Function('nextPorts', `return current => (${selectedPortUpdaterMatch[1]});`);
assert.equal(updateSelectedPort([{ path: 'COM3' }])('COM6'), 'COM3', 'a missing selected port falls back to the first available port');
assert.equal(updateSelectedPort([{ path: 'COM3' }])('COM3'), 'COM3', 'an available selected port remains selected');
assert.equal(updateSelectedPort([])('COM6'), '', 'the selected port clears when no ports remain');
assert.match(stylesSource, /\.hardware-row\s*\{[^}]*grid-template-columns:\s*minmax\(160px, 1fr\) repeat\(4, auto\)/);
for (const reason of [
  'hardware-write-timeout',
  'hardware-write-failed',
  'hardware-port-error',
  'hardware-port-closed',
  'hardware-not-ready',
  'hardware-tcode-not-ready',
  'hardware-control-signals-failed',
  'hardware-disconnected-stop-failed',
  'hardware-test-cancelled',
  'invalid-stop-position'
]) {
  assert.match(appSource, new RegExp(`['"]${reason}['"]\\s*:`), `missing Korean reason mapping: ${reason}`);
}
for (const [reason, message] of [
  ['hardware-emergency-stopped', '하드웨어 긴급정지가 활성화되어 있습니다'],
  ['hardware-room-exit-stopping', '방 종료 안전 위치로 이동 중입니다'],
  ['hardware-room-exit-stop-failed', '방 종료 안전 위치 이동에 실패했습니다']
]) {
  assert.match(formatReasonSource, new RegExp(`['"]${reason}['"]\\s*:\\s*['"]${message}['"]`), `missing bounded Korean reason mapping: ${reason}`);
}
for (const reason of ['kick', 'block']) {
  assert.match(formatReasonSource, new RegExp(`['"]${reason}['"]\\s*:`), `missing terminal viewer reason mapping: ${reason}`);
}
assert.match(formatLogMessageSource, /['"]hardware-emergency-released['"]\s*:\s*['"]하드웨어 긴급정지 해제['"]/);
assert.match(formatLogMessageSource, /['"]hardware-readiness-failed['"]\s*:\s*['"]T-Code 준비 확인 실패['"]/);
assert.match(formatLogMessageSource, /['"]hardware-ready['"]\s*:\s*['"]T-Code 통신 준비 완료['"]/);
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
