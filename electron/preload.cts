import { contextBridge, ipcRenderer } from 'electron';
import type { AppLogEntry, AppSettings, ApprovalRequest, HardwareConnectionStatus, HardwareEmergencyState, HardwareLatchedStopResult, HardwareOutputSnapshot, HardwareProfile, HardwareProtection, MotionDemoSnapshot, MotionMonitorSnapshot, MotionPatternConfig, RoomDisconnectResult, RoomSettings, ViewerSession } from './protocol.js';

type ViewerStatus = {
  roomName: string;
  status: 'approved' | 'rejected' | 'removed';
  reason?: string;
};

type StopSignal = {
  roomName: string;
  timestamp: number;
  hardware: HardwareLatchedStopResult;
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
  getHardwareStatus: () => ipcRenderer.invoke('hardware:status'),
  getHardwareEmergencyState: (): Promise<HardwareEmergencyState> => ipcRenderer.invoke('hardware:emergency-state'),
  stopHardware: (): Promise<HardwareLatchedStopResult> => ipcRenderer.invoke('hardware:emergency-stop'),
  releaseHardwareStop: (): Promise<HardwareEmergencyState> => ipcRenderer.invoke('hardware:emergency-release'),
  testHardware: () => ipcRenderer.invoke('hardware:test'),
  sendMotion: (intensity: number, position: number) => ipcRenderer.invoke('hardware:send', intensity, position),
  openHardwareOutputLog: (): Promise<{ opened: true }> => ipcRenderer.invoke('hardware-output-log:open'),
  startMotionDemo: (intensity: number, position: number) => ipcRenderer.invoke('motion-demo:start', intensity, position),
  updateMotionDemo: (intensity: number, position: number) => ipcRenderer.send('motion-demo:update', intensity, position),
  startMotionPattern: (config: MotionPatternConfig) => ipcRenderer.invoke('motion-demo:start-pattern', config),
  updateMotionPattern: (config: MotionPatternConfig) => ipcRenderer.send('motion-demo:update-pattern', config),
  stopMotionDemo: () => ipcRenderer.invoke('motion-demo:stop'),
  setHardwareProtection: (protection: HardwareProtection) => ipcRenderer.invoke('hardware:set-protection', protection),
  startHostRoom: (relayUrl: string, settings: RoomSettings) => ipcRenderer.invoke('room:start-host', relayUrl, settings),
  listRooms: (relayUrl: string) => ipcRenderer.invoke('room:list', relayUrl),
  checkServer: (relayUrl: string) => ipcRenderer.invoke('server:check', relayUrl),
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
  onMotionDemoFrame: (listener: (snapshot: MotionDemoSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: MotionDemoSnapshot) => listener(snapshot);
    ipcRenderer.on('motion-demo:frame', handler);
    return () => ipcRenderer.removeListener('motion-demo:frame', handler);
  },
  onMotionReceived: (listener: (snapshot: MotionMonitorSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: MotionMonitorSnapshot) => listener(snapshot);
    ipcRenderer.on('motion:received', handler);
    return () => ipcRenderer.removeListener('motion:received', handler);
  },
  onHardwareOutput: (listener: (snapshot: HardwareOutputSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: HardwareOutputSnapshot) => listener(snapshot);
    ipcRenderer.on('hardware:output', handler);
    return () => ipcRenderer.removeListener('hardware:output', handler);
  },
  onHardwareConnectionStatus: (listener: (status: HardwareConnectionStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: HardwareConnectionStatus) => listener(status);
    ipcRenderer.on('hardware:connection-status', handler);
    return () => ipcRenderer.removeListener('hardware:connection-status', handler);
  },
  getLogs: () => ipcRenderer.invoke('app:logs'),
  exportLogs: () => ipcRenderer.invoke('app:export-logs'),
  copyText: (text: string) => ipcRenderer.invoke('app:copy-text', text),
  getSettings: () => ipcRenderer.invoke('app:get-settings'),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke('app:save-settings', settings),
  setMotionDelay: (delayMs: number) => ipcRenderer.invoke('viewer:set-motion-delay', delayMs),
  onLog: (listener: (entry: AppLogEntry) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: AppLogEntry) => listener(entry);
    ipcRenderer.on('app:log', handler);
    return () => ipcRenderer.removeListener('app:log', handler);
  },
  disconnectRoom: (): Promise<RoomDisconnectResult> => ipcRenderer.invoke('room:disconnect')
});
