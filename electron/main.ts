import { app, BrowserWindow, clipboard, dialog, ipcMain, session } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  migrateAppSettings,
  validateAppSettings,
  validateBoolean,
  validateHardwareProfile,
  validateHardwareProtection,
  validateUnitInterval
} from './app-settings.js';
import { SettingsFileStore } from './settings-file-store.js';
import type { AppLogEntry, AppSettings, MotionDemoSnapshot, MotionFrame, MotionMonitorSnapshot, RoomSettings } from './protocol.js';
import { HardwareController } from './services/hardware-controller.js';
import { validateMotionPatternConfig } from './services/demo-motion-pattern.js';
import { DemoMotionStream } from './services/demo-motion-stream.js';
import { validateMotionDelayMs } from './services/motion-delay-buffer.js';
import { RelayClient } from './services/relay-client.js';
import { sendToRenderer } from './window-messenger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_SECURITY_POLICY_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
];
// The Vite dev server injects an inline react-refresh preamble and uses a blob:
// worker for HMR reconnects. Only the dev-server run relaxes those directives;
// the packaged app keeps the strict policy.
const DEV_CSP_OVERRIDES: Record<string, string> = {
  "script-src 'self'": "script-src 'self' 'unsafe-inline'",
  "default-src 'self'": "default-src 'self' blob:"
};
const MAX_LOG_ENTRIES = 300;

let mainWindow: BrowserWindow | undefined;
let nextLogId = 1;
let receivedMotionFrames = 0;
const logEntries: AppLogEntry[] = [];
const lastLogByKey = new Map<string, number>();
let settingsStore: SettingsFileStore | undefined;

function addLog(entry: Omit<AppLogEntry, 'id' | 'timestamp'>) {
  const now = Date.now();
  const key = `${entry.level}:${entry.source}:${entry.message}:${entry.details ?? ''}`;
  const lastTimestamp = lastLogByKey.get(key) ?? 0;
  if (now - lastTimestamp < 1000) return;
  lastLogByKey.set(key, now);

  const nextEntry: AppLogEntry = {
    id: nextLogId++,
    timestamp: now,
    ...entry
  };

  logEntries.push(nextEntry);
  if (logEntries.length > MAX_LOG_ENTRIES) logEntries.splice(0, logEntries.length - MAX_LOG_ENTRIES);
  sendToRenderer(mainWindow, 'app:log', nextEntry);
}

const hardware = new HardwareController({
  onLog: entry => addLog(entry),
  onOutput: snapshot => sendToRenderer(mainWindow, 'hardware:output', snapshot),
  onConnectionStatus: status => sendToRenderer(mainWindow, 'hardware:connection-status', status)
});
const relay = new RelayClient(frame => {
  const result = hardware.queueMotion(frame);
  const snapshot: MotionMonitorSnapshot = {
    frame,
    receivedAt: Date.now(),
    receivedFrames: ++receivedMotionFrames,
    hardware: result
  };
  sendToRenderer(mainWindow, 'motion:received', snapshot);
  if (result.queued === false && result.reason !== 'hardware-not-connected') {
    addLog({ level: 'warning', source: 'hardware', message: 'motion-not-queued', details: result.reason });
  }
}, request => {
  addLog({ level: 'info', source: 'room', message: 'approval-requested', details: `${request.displayName} / ${request.roomName}` });
  sendToRenderer(mainWindow, 'room:approval-requested', request);
}, status => {
  addLog({ level: status.status === 'rejected' || status.status === 'removed' ? 'warning' : 'info', source: 'room', message: `viewer-${status.status}`, details: status.reason ?? status.roomName });
  sendToRenderer(mainWindow, 'room:viewer-status', status);
}, viewers => {
  addLog({ level: 'info', source: 'room', message: 'viewer-list-updated', details: `${viewers.length}` });
  sendToRenderer(mainWindow, 'room:viewers', viewers);
}, signal => {
  void hardware.emergencyStop();
  addLog({ level: 'warning', source: 'relay', message: 'room-stop-received', details: signal.roomName });
  sendToRenderer(mainWindow, 'room:emergency-stop', signal);
}, status => {
  addLog({ level: status.status === 'error' ? 'error' : status.status === 'disconnected' || status.status === 'reconnecting' ? 'warning' : 'info', source: 'relay', message: `relay-${status.status}`, details: status.reason ?? status.roomName });
  sendToRenderer(mainWindow, 'room:connection-status', status);
});

function publishMotion(frame: MotionFrame) {
  return {
    hardware: hardware.queueMotion(frame),
    relay: relay.publishMotion(frame)
  };
}

const demoMotionStream = new DemoMotionStream(frame => {
  publishMotion(frame);
  const snapshot: MotionDemoSnapshot = { mode: demoMotionStream.getMode(), frame };
  sendToRenderer(mainWindow, 'motion-demo:frame', snapshot);
});

function contentSecurityPolicy() {
  const relaxForDevServer = getDevServerUrl() !== undefined;
  return CONTENT_SECURITY_POLICY_DIRECTIVES
    .map(directive => (relaxForDevServer ? DEV_CSP_OVERRIDES[directive] ?? directive : directive))
    .join('; ');
}

function configureSecurityPolicy() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy()]
      }
    });
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, navigationUrl) => {
      if (!isAllowedAppNavigation(navigationUrl)) event.preventDefault();
    });
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    title: 'Haptic Relay',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  });
  mainWindow = window;
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
  });

  const devServerUrl = getDevServerUrl();
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  configureSecurityPolicy();
  createWindow();
});

app.on('window-all-closed', () => {
  demoMotionStream.stop();
  void hardware.disconnect();
  relay.disconnect();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('hardware:list', event => {
  assertTrustedSender(event);
  return hardware.listPorts();
});
ipcMain.handle('hardware:status', event => {
  assertTrustedSender(event);
  return hardware.getConnectionStatus();
});
ipcMain.handle('hardware:connect', async (event, pathName: unknown, profile: unknown) => {
  assertTrustedSender(event);
  try {
    return await hardware.connect(validatePortPath(pathName), validateHardwareProfile(profile));
  } catch (error) {
    addLog({ level: 'error', source: 'hardware', message: 'hardware-connect-failed', details: formatError(error) });
    throw error;
  }
});
ipcMain.handle('hardware:disconnect', event => {
  assertTrustedSender(event);
  return hardware.disconnectSafely();
});
ipcMain.handle('hardware:emergency-stop', event => {
  assertTrustedSender(event);
  return hardware.emergencyStop();
});
ipcMain.handle('hardware:test', event => {
  assertTrustedSender(event);
  return hardware.runTestPattern();
});
ipcMain.handle('hardware:send', async (event, intensity: unknown, position: unknown) => {
  assertTrustedSender(event);
  const frame: MotionFrame = {
    intensity: validateUnitInterval(intensity, 'intensity'),
    position: validateUnitInterval(position, 'position'),
    timestamp: Date.now()
  };
  return publishMotion(frame);
});
ipcMain.handle('motion-demo:start', (event, intensity: unknown, position: unknown) => {
  assertTrustedSender(event);
  addLog({ level: 'info', source: 'room', message: 'motion-demo-started' });
  return demoMotionStream.start({
    intensity: validateUnitInterval(intensity, 'intensity'),
    position: validateUnitInterval(position, 'position')
  });
});
ipcMain.on('motion-demo:update', (event, intensity: unknown, position: unknown) => {
  try {
    assertTrustedSender(event);
    demoMotionStream.update({
      intensity: validateUnitInterval(intensity, 'intensity'),
      position: validateUnitInterval(position, 'position')
    });
  } catch (error) {
    addLog({ level: 'warning', source: 'room', message: 'motion-demo-update-rejected', details: formatError(error) });
  }
});
ipcMain.handle('motion-demo:start-pattern', (event, config: unknown) => {
  assertTrustedSender(event);
  const validated = validateMotionPatternConfig(config);
  addLog({ level: 'info', source: 'room', message: 'motion-pattern-started', details: validated.pattern });
  return demoMotionStream.startPattern(validated);
});
ipcMain.on('motion-demo:update-pattern', (event, config: unknown) => {
  try {
    assertTrustedSender(event);
    const validated = validateMotionPatternConfig(config);
    demoMotionStream.updatePattern(validated);
  } catch (error) {
    addLog({ level: 'warning', source: 'room', message: 'motion-pattern-update-rejected', details: formatError(error) });
  }
});
ipcMain.handle('motion-demo:stop', event => {
  assertTrustedSender(event);
  addLog({ level: 'info', source: 'room', message: 'motion-demo-stopped' });
  return demoMotionStream.stop();
});
ipcMain.handle('hardware:set-protection', (event, protection: unknown) => {
  assertTrustedSender(event);
  return hardware.setProtection(validateHardwareProtection(protection));
});

ipcMain.handle('room:start-host', (event, relayUrl: unknown, settings: unknown) => {
  assertTrustedSender(event);
  addLog({ level: 'info', source: 'room', message: 'room-create-requested' });
  return relay.createRoom(validateRelayUrl(relayUrl), validateRoomSettings(settings));
});
ipcMain.handle('room:list', (event, relayUrl: unknown) => {
  assertTrustedSender(event);
  return relay.listRooms(validateRelayUrl(relayUrl));
});
ipcMain.handle('server:check', (event, relayUrl: unknown) => {
  assertTrustedSender(event);
  return relay.checkHealth(validateRelayUrl(relayUrl));
});
ipcMain.handle('room:join', (event, relayUrl: unknown, request: unknown) => {
  assertTrustedSender(event);
  const joinRequest = validateJoinRequest(request);
  addLog({ level: 'info', source: 'room', message: 'room-join-requested', details: joinRequest.roomName });
  return relay.joinRoom(validateRelayUrl(relayUrl), joinRequest);
});
ipcMain.handle('room:approve', (event, socketId: unknown, approved: unknown) => {
  assertTrustedSender(event);
  return relay.approveViewer(validateSocketId(socketId), validateBoolean(approved, 'approved'));
});
ipcMain.handle('room:moderate-viewer', (event, socketId: unknown, action: unknown) => {
  assertTrustedSender(event);
  return relay.moderateViewer(validateSocketId(socketId), validateModerationAction(action));
});
ipcMain.handle('room:list-viewers', event => {
  assertTrustedSender(event);
  return relay.refreshViewers();
});
ipcMain.handle('room:emergency-stop', async event => {
  assertTrustedSender(event);
  demoMotionStream.stop();
  addLog({ level: 'warning', source: 'room', message: 'emergency-stop-requested' });
  const hardwareResult = await hardware.emergencyStop();
  const relayResult = await relay.emergencyStop();
  return { hardware: hardwareResult, relay: relayResult };
});
ipcMain.handle('room:disconnect', event => {
  assertTrustedSender(event);
  demoMotionStream.stop();
  addLog({ level: 'info', source: 'relay', message: 'relay-disconnect-requested' });
  return relay.disconnect();
});
ipcMain.handle('app:logs', event => {
  assertTrustedSender(event);
  return logEntries;
});
ipcMain.handle('app:export-logs', async event => {
  assertTrustedSender(event);
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('window-not-ready');

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Haptic Relay Logs',
    defaultPath: `haptic-relay-logs-${formatFileTimestamp(new Date())}.json`,
    filters: [
      { name: 'JSON', extensions: ['json'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return { exported: false, canceled: true, count: logEntries.length };
  }

  const payload = {
    app: 'Haptic Relay',
    version: app.getVersion(),
    exportedAt: new Date().toISOString(),
    entries: logEntries
  };

  await fs.writeFile(result.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  addLog({ level: 'info', source: 'app', message: 'logs-exported', details: `${logEntries.length}` });
  return { exported: true, canceled: false, path: result.filePath, count: logEntries.length };
});
ipcMain.handle('app:copy-text', (event, text: unknown) => {
  assertTrustedSender(event);
  const value = validateShortText(text, 'clipboardText', 1, 1000);
  clipboard.writeText(value);
  addLog({ level: 'info', source: 'app', message: 'clipboard-copied' });
  return { copied: true };
});
ipcMain.handle('app:get-settings', async event => {
  assertTrustedSender(event);
  const settings = await readSettings();
  relay.setMotionDelay(settings.playback.motionDelayMs);
  return settings;
});
ipcMain.handle('app:save-settings', async (event, settings: unknown) => {
  assertTrustedSender(event);
  const nextSettings = validateAppSettings(settings);
  await writeSettings(nextSettings);
  relay.setMotionDelay(nextSettings.playback.motionDelayMs);
  addLog({ level: 'info', source: 'app', message: 'settings-saved' });
  return { settings: nextSettings };
});
ipcMain.handle('viewer:set-motion-delay', async (event, delayMs: unknown) => {
  assertTrustedSender(event);
  const motionDelayMs = validateMotionDelayMs(delayMs as number);
  return getSettingsStore().exclusive(async writeAtomically => {
    const currentSettings = await readSettingsInTransaction(writeAtomically);
    const settings: AppSettings = {
      schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
      hardwareProfile: currentSettings.hardwareProfile,
      hardwareProtection: currentSettings.hardwareProtection,
      playback: { motionDelayMs }
    };
    await writeAtomically(settings);
    const buffer = relay.setMotionDelay(motionDelayMs);
    addLog({ level: 'info', source: 'app', message: 'motion-delay-applied', details: `${motionDelayMs}ms` });
    return { settings, buffer };
  });
});

function getDevServerUrl() {
  if (app.isPackaged || !process.env.VITE_DEV_SERVER_URL) return undefined;

  const parsed = new URL(process.env.VITE_DEV_SERVER_URL);
  if (parsed.protocol !== 'http:' || !isLocalhost(parsed.hostname)) {
    throw new Error('invalid-dev-server-url');
  }

  return parsed.toString();
}

function assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent) {
  if (event.sender !== mainWindow?.webContents) {
    throw new Error('untrusted-ipc-sender');
  }
}

function validateRelayUrl(value: unknown) {
  if (typeof value !== 'string') throw new Error('invalid-relay-url');

  const parsed = new URL(value);
  if (parsed.username || parsed.password) throw new Error('invalid-relay-url');

  const isLocalHttp = parsed.protocol === 'http:' && isLocalNetworkHost(parsed.hostname);
  if (parsed.protocol !== 'https:' && !isLocalHttp) throw new Error('invalid-relay-url');

  return parsed.toString().replace(/\/$/, '');
}

function isAllowedAppNavigation(navigationUrl: string) {
  const parsed = new URL(navigationUrl);
  if (parsed.protocol === 'file:') return true;
  return !app.isPackaged && parsed.protocol === 'http:' && isLocalhost(parsed.hostname);
}

function validateRoomSettings(value: unknown): RoomSettings {
  if (!isRecord(value)) throw new Error('invalid-room-settings');
  const roomName = validateShortText(value.roomName, 'roomName', 3, 64);
  const password = value.password === undefined ? undefined : validateShortText(value.password, 'password', 1, 128);
  const entryMode = value.entryMode;
  if (entryMode !== 'open' && entryMode !== 'request') throw new Error('invalid-entry-mode');
  return { roomName, password, entryMode };
}

function validateJoinRequest(value: unknown) {
  if (!isRecord(value)) throw new Error('invalid-join-request');
  return {
    displayName: validateShortText(value.displayName, 'displayName', 1, 64),
    roomName: validateShortText(value.roomName, 'roomName', 3, 64),
    password: value.password === undefined ? undefined : validateShortText(value.password, 'password', 1, 128)
  };
}

function validatePortPath(value: unknown) {
  return validateShortText(value, 'pathName', 1, 260);
}

function validateSocketId(value: unknown) {
  return validateShortText(value, 'socketId', 1, 128);
}

function validateModerationAction(value: unknown) {
  if (value !== 'kick' && value !== 'block') throw new Error('invalid-moderation-action');
  return value;
}

function validateShortText(value: unknown, fieldName: string, minLength: number, maxLength: number) {
  if (typeof value !== 'string') throw new Error(`invalid-${fieldName}`);
  const trimmed = value.trim();
  if (trimmed.length < minLength || trimmed.length > maxLength) throw new Error(`invalid-${fieldName}`);
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocalhost(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function isLocalNetworkHost(hostname: string) {
  if (isLocalhost(hostname)) return true;

  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 169 && octets[1] === 254);
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown-error';
}

function formatFileTimestamp(date: Date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function readSettings(): Promise<AppSettings> {
  return getSettingsStore().exclusive(readSettingsInTransaction);
}

async function readSettingsInTransaction(writeAtomically: (settings: unknown) => Promise<void>): Promise<AppSettings> {
  let raw: string;
  try {
    raw = await fs.readFile(getSettingsPath(), 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      addLog({ level: 'warning', source: 'app', message: 'settings-defaulted', details: formatError(error) });
      return DEFAULT_SETTINGS;
    }
    addLog({ level: 'error', source: 'app', message: 'settings-read-failed', details: formatError(error) });
    throw error;
  }

  let parsed: { schemaVersion?: unknown };
  let settings: AppSettings;
  try {
    parsed = JSON.parse(raw) as { schemaVersion?: unknown };
    settings = migrateAppSettings(parsed);
  } catch (error) {
    addLog({ level: 'warning', source: 'app', message: 'settings-invalid', details: formatError(error) });
    throw error;
  }

  if (parsed.schemaVersion !== CURRENT_SETTINGS_SCHEMA_VERSION) {
    try {
      await writeAtomically(settings);
      addLog({ level: 'info', source: 'app', message: 'settings-migrated', details: `v${settings.schemaVersion}` });
    } catch (error) {
      addLog({ level: 'error', source: 'app', message: 'settings-migration-persist-failed', details: formatError(error) });
    }
  }

  return settings;
}

async function writeSettings(settings: AppSettings) {
  await getSettingsStore().write(settings);
}

function getSettingsStore() {
  return settingsStore ??= new SettingsFileStore(getSettingsPath());
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function isMissingFileError(error: unknown) {
  return isRecord(error) && error.code === 'ENOENT';
}
