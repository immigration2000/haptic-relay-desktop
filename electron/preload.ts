import { contextBridge, ipcRenderer } from 'electron';
import type { AppLogEntry, ApprovalRequest, HardwareProfile, HardwareProtection, RoomSettings, ViewerSession } from './protocol.js';

type ViewerStatus = {
  roomName: string;
  status: 'approved' | 'rejected' | 'removed';
  reason?: string;
};

type StopSignal = {
  roomName: string;
  timestamp: number;
};

type RelayConnectionStatus = {
  status: 'connected' | 'disconnected' | 'reconnecting' | 'rejoined' | 'error';
  role?: 'host' | 'viewer';
  roomName?: string;
  reason?: string;
};

contextBridge.exposeInMainWorld('hapticRelay', {
  listPorts: () => ipcRenderer.invoke('hardware:list'),
  connectHardware: (pathName: string, profile: HardwareProfile) => ipcRenderer.invoke('hardware:connect', pathName, profile),
  disconnectHardware: () => ipcRenderer.invoke('hardware:disconnect'),
  stopHardware: () => ipcRenderer.invoke('hardware:emergency-stop'),
  sendMotion: (intensity: number, position: number) => ipcRenderer.invoke('hardware:send', intensity, position),
  setHardwareProtection: (protection: HardwareProtection) => ipcRenderer.invoke('hardware:set-protection', protection),
  startHostRoom: (relayUrl: string, settings: RoomSettings) => ipcRenderer.invoke('room:start-host', relayUrl, settings),
  joinRoom: (relayUrl: string, request: { displayName: string; roomName: string; password?: string }) => ipcRenderer.invoke('room:join', relayUrl, request),
  approveViewer: (socketId: string, approved: boolean) => ipcRenderer.invoke('room:approve', socketId, approved),
  moderateViewer: (socketId: string, action: 'kick' | 'block') => ipcRenderer.invoke('room:moderate-viewer', socketId, action),
  listViewers: () => ipcRenderer.invoke('room:list-viewers'),
  emergencyStop: () => ipcRenderer.invoke('room:emergency-stop'),
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
  onViewerList: (listener: (viewers: ViewerSession[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, viewers: ViewerSession[]) => listener(viewers);
    ipcRenderer.on('room:viewers', handler);
    return () => ipcRenderer.removeListener('room:viewers', handler);
  },
  onEmergencyStop: (listener: (signal: StopSignal) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, signal: StopSignal) => listener(signal);
    ipcRenderer.on('room:emergency-stop', handler);
    return () => ipcRenderer.removeListener('room:emergency-stop', handler);
  },
  onConnectionStatus: (listener: (status: RelayConnectionStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: RelayConnectionStatus) => listener(status);
    ipcRenderer.on('room:connection-status', handler);
    return () => ipcRenderer.removeListener('room:connection-status', handler);
  },
  getLogs: () => ipcRenderer.invoke('app:logs'),
  copyText: (text: string) => ipcRenderer.invoke('app:copy-text', text),
  onLog: (listener: (entry: AppLogEntry) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: AppLogEntry) => listener(entry);
    ipcRenderer.on('app:log', handler);
    return () => ipcRenderer.removeListener('app:log', handler);
  },
  disconnectRoom: () => ipcRenderer.invoke('room:disconnect')
});
