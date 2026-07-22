import { contextBridge, ipcRenderer } from 'electron';
import type { ApprovalRequest, RoomSettings } from './protocol.js';

type ViewerStatus = {
  roomName: string;
  status: 'approved' | 'rejected';
  reason?: string;
};

contextBridge.exposeInMainWorld('hapticRelay', {
  listPorts: () => ipcRenderer.invoke('hardware:list'),
  connectHardware: (pathName: string, baudRate: number) => ipcRenderer.invoke('hardware:connect', pathName, baudRate),
  disconnectHardware: () => ipcRenderer.invoke('hardware:disconnect'),
  sendMotion: (intensity: number, position: number) => ipcRenderer.invoke('hardware:send', intensity, position),
  startHostRoom: (relayUrl: string, settings: RoomSettings) => ipcRenderer.invoke('room:start-host', relayUrl, settings),
  joinRoom: (relayUrl: string, request: { displayName: string; roomName: string; password?: string }) => ipcRenderer.invoke('room:join', relayUrl, request),
  approveViewer: (socketId: string, approved: boolean) => ipcRenderer.invoke('room:approve', socketId, approved),
  onApprovalRequest: (listener: (request: ApprovalRequest) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, request: ApprovalRequest) => listener(request);
    ipcRenderer.on('room:approval-requested', handler);
    return () => ipcRenderer.removeListener('room:approval-requested', handler);
  },
  onViewerStatus: (listener: (status: ViewerStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: ViewerStatus) => listener(status);
    ipcRenderer.on('room:viewer-status', handler);
    return () => ipcRenderer.removeListener('room:viewer-status', handler);
  },
  disconnectRoom: () => ipcRenderer.invoke('room:disconnect')
});
