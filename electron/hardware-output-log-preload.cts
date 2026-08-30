import { contextBridge, ipcRenderer } from 'electron';
import type { HardwareOutputLogRow, HardwareOutputLogSession } from './protocol.js';

type AppendPayload = { row: HardwareOutputLogRow; omittedRows: number };

contextBridge.exposeInMainWorld('hapticOutputLog', {
  getSession: (): Promise<HardwareOutputLogSession> => ipcRenderer.invoke('hardware-output-log:get'),
  onReset: (listener: (session: HardwareOutputLogSession) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, session: HardwareOutputLogSession) => listener(session);
    ipcRenderer.on('hardware-output-log:reset', handler);
    return () => ipcRenderer.removeListener('hardware-output-log:reset', handler);
  },
  onAppend: (listener: (payload: AppendPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AppendPayload) => listener(payload);
    ipcRenderer.on('hardware-output-log:append', handler);
    return () => ipcRenderer.removeListener('hardware-output-log:append', handler);
  }
});
