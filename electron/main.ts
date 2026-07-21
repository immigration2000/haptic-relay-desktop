import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HardwareController } from './services/hardware-controller.js';
import { RoomHost } from './services/room-host.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | undefined;
const hardware = new HardwareController();
let roomHost: RoomHost | undefined;

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
  void roomHost?.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('hardware:list', () => hardware.listPorts());
ipcMain.handle('hardware:connect', (_event, pathName: string, baudRate: number) => hardware.connect(pathName, baudRate));
ipcMain.handle('hardware:disconnect', () => hardware.disconnect());
ipcMain.handle('hardware:send', (_event, intensity: number, position: number) => hardware.sendMotion({ intensity, position, timestamp: Date.now() }));

ipcMain.handle('room:start-host', async (_event, settings) => {
  roomHost = new RoomHost(settings);
  return roomHost.start();
});

ipcMain.handle('room:stop-host', () => roomHost?.stop());
