import { contextBridge, ipcRenderer } from 'electron';
import type { HardwareOutputLogAppend, HardwareOutputLogSession } from './protocol.js';

contextBridge.exposeInMainWorld('hapticOutputLog', {
  getSession: (): Promise<HardwareOutputLogSession> => ipcRenderer.invoke('hardware-output-log:get'),
  onReset: (listener: (session: HardwareOutputLogSession) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, session: HardwareOutputLogSession) => listener(session);
    ipcRenderer.on('hardware-output-log:reset', handler);
    return () => ipcRenderer.removeListener('hardware-output-log:reset', handler);
  },
  onAppend: (listener: (payload: HardwareOutputLogAppend) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: HardwareOutputLogAppend) => listener(payload);
    ipcRenderer.on('hardware-output-log:append', handler);
    return () => ipcRenderer.removeListener('hardware-output-log:append', handler);
  }
});
