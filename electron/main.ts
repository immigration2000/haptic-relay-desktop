import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HardwareController } from './services/hardware-controller.js';
import { RelayClient } from './services/relay-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | undefined;
const hardware = new HardwareController();
const relay = new RelayClient();

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
      nodeIntegration: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  void hardware.disconnect();
  relay.disconnect();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('hardware:list', () => hardware.listPorts());
ipcMain.handle('hardware:connect', (_event, pathName: string, baudRate: number) => hardware.connect(pathName, baudRate));
ipcMain.handle('hardware:disconnect', () => hardware.disconnect());
ipcMain.handle('hardware:send', async (_event, intensity: number, position: number) => {
  const frame = { intensity, position, timestamp: Date.now() };
  const hardwareResult = hardware.queueMotion(frame);
  const relayResult = relay.publishMotion(frame);
  return { hardware: hardwareResult, relay: relayResult };
});

ipcMain.handle('room:start-host', (_event, relayUrl: string, settings) => relay.createRoom(relayUrl, settings));
ipcMain.handle('room:join', (_event, relayUrl: string, request) => relay.joinRoom(relayUrl, request));
ipcMain.handle('room:disconnect', () => relay.disconnect());
