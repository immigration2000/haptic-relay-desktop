import { app, BrowserWindow, clipboard, ipcMain, session } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IpcMainInvokeEvent } from 'electron';
import type { AppLogEntry, AppSettings, HardwareProfile, HardwareProtection, RoomSettings } from './protocol.js';
import { HardwareController } from './services/hardware-controller.js';
import { RelayClient } from './services/relay-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_SECURITY_POLICY = [
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
].join('; ');
const MAX_LOG_ENTRIES = 300;
const DEFAULT_HARDWARE_PROFILE: HardwareProfile = {
  baudRate: 115200,
  linearAxis: 'L0',
  vibrationAxis: undefined,
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
};
const DEFAULT_HARDWARE_PROTECTION: HardwareProtection = {
  intensityLimit: 1,
  positionMin: 0,
  positionMax: 1,
  paused: false
};
const DEFAULT_SETTINGS: AppSettings = {
  hardwareProfile: DEFAULT_HARDWARE_PROFILE,
  hardwareProtection: DEFAULT_HARDWARE_PROTECTION
};

let mainWindow: BrowserWindow | undefined;
let nextLogId = 1;
const logEntries: AppLogEntry[] = [];
const lastLogByKey = new Map<string, number>();

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
  mainWindow?.webContents.send('app:log', nextEntry);
}

const hardware = new HardwareController(entry => addLog(entry));
const relay = new RelayClient(frame => {
  const result = hardware.queueMotion(frame);
  if (result.queued === false && result.reason !== 'hardware-not-connected') {
    addLog({ level: 'warning', source: 'hardware', message: 'motion-not-queued', details: result.reason });
  }
}, request => {
  addLog({ level: 'info', source: 'room', message: 'approval-requested', details: `${request.displayName} / ${request.roomName}` });
  mainWindow?.webContents.send('room:approval-requested', request);
}, status => {
  addLog({ level: status.status === 'rejected' || status.status === 'removed' ? 'warning' : 'info', source: 'room', message: `viewer-${status.status}`, details: status.reason ?? status.roomName });
  mainWindow?.webContents.send('room:viewer-status', status);
}, viewers => {
  addLog({ level: 'info', source: 'room', message: 'viewer-list-updated', details: `${viewers.length}` });
  mainWindow?.webContents.send('room:viewers', viewers);
}, signal => {
  void hardware.emergencyStop();
  addLog({ level: 'warning', source: 'relay', message: 'room-stop-received', details: signal.roomName });
  mainWindow?.webContents.send('room:emergency-stop', signal);
}, status => {
  addLog({ level: status.status === 'error' ? 'error' : status.status === 'disconnected' || status.status === 'reconnecting' ? 'warning' : 'info', source: 'relay', message: `relay-${status.status}`, details: status.reason ?? status.roomName });
  mainWindow?.webContents.send('room:connection-status', status);
});

function configureSecurityPolicy() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY]
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
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    title: 'Haptic Relay',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
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
  return hardware.disconnect();
});
ipcMain.handle('hardware:emergency-stop', event => {
  assertTrustedSender(event);
  return hardware.emergencyStop();
});
ipcMain.handle('hardware:send', async (event, intensity: unknown, position: unknown) => {
  assertTrustedSender(event);
  const frame = { intensity: validateUnitInterval(intensity, 'intensity'), position: validateUnitInterval(position, 'position'), timestamp: Date.now() };
  const hardwareResult = hardware.queueMotion(frame);
  const relayResult = relay.publishMotion(frame);
  return { hardware: hardwareResult, relay: relayResult };
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
  addLog({ level: 'warning', source: 'room', message: 'emergency-stop-requested' });
  const hardwareResult = await hardware.emergencyStop();
  const relayResult = await relay.emergencyStop();
  return { hardware: hardwareResult, relay: relayResult };
});
ipcMain.handle('room:disconnect', event => {
  assertTrustedSender(event);
  addLog({ level: 'info', source: 'relay', message: 'relay-disconnect-requested' });
  return relay.disconnect();
});
ipcMain.handle('app:logs', event => {
  assertTrustedSender(event);
  return logEntries;
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
  return readSettings();
});
ipcMain.handle('app:save-settings', async (event, settings: unknown) => {
  assertTrustedSender(event);
  const nextSettings = validateAppSettings(settings);
  await writeSettings(nextSettings);
  addLog({ level: 'info', source: 'app', message: 'settings-saved' });
  return { settings: nextSettings };
});

function getDevServerUrl() {
  if (app.isPackaged || !process.env.VITE_DEV_SERVER_URL) return undefined;

  const parsed = new URL(process.env.VITE_DEV_SERVER_URL);
  if (parsed.protocol !== 'http:' || !isLocalhost(parsed.hostname)) {
    throw new Error('invalid-dev-server-url');
  }

  return parsed.toString();
}

function assertTrustedSender(event: IpcMainInvokeEvent) {
  if (event.sender !== mainWindow?.webContents) {
    throw new Error('untrusted-ipc-sender');
  }
}

function validateRelayUrl(value: unknown) {
  if (typeof value !== 'string') throw new Error('invalid-relay-url');

  const parsed = new URL(value);
  if (parsed.username || parsed.password) throw new Error('invalid-relay-url');

  const isLocalHttp = parsed.protocol === 'http:' && isLocalhost(parsed.hostname);
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

function validateHardwareProfile(value: unknown): HardwareProfile {
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

function validateHardwareProtection(value: unknown): HardwareProtection {
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

function validateAppSettings(value: unknown): AppSettings {
  if (!isRecord(value)) throw new Error('invalid-app-settings');
  return {
    hardwareProfile: validateHardwareProfile(value.hardwareProfile),
    hardwareProtection: validateHardwareProtection(value.hardwareProtection)
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

function validateUnitInterval(value: unknown, fieldName: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`invalid-${fieldName}`);
  }
  return value;
}

function validateSocketId(value: unknown) {
  return validateShortText(value, 'socketId', 1, 128);
}

function validateBoolean(value: unknown, fieldName: string) {
  if (typeof value !== 'boolean') throw new Error(`invalid-${fieldName}`);
  return value;
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

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown-error';
}

async function readSettings(): Promise<AppSettings> {
  try {
    const raw = await fs.readFile(getSettingsPath(), 'utf8');
    return validateAppSettings(JSON.parse(raw));
  } catch (error) {
    addLog({ level: 'warning', source: 'app', message: 'settings-defaulted', details: formatError(error) });
    return DEFAULT_SETTINGS;
  }
}

async function writeSettings(settings: AppSettings) {
  const settingsPath = getSettingsPath();
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
