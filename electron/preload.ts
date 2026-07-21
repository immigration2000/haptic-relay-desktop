import { contextBridge, ipcRenderer } from 'electron';
import type { RoomSettings } from './protocol.js';

contextBridge.exposeInMainWorld('hapticRelay', {
  listPorts: () => ipcRenderer.invoke('hardware:list'),
  connectHardware: (pathName: string, baudRate: number) => ipcRenderer.invoke('hardware:connect', pathName, baudRate),
  disconnectHardware: () => ipcRenderer.invoke('hardware:disconnect'),
  sendMotion: (intensity: number, position: number) => ipcRenderer.invoke('hardware:send', intensity, position),
  startHostRoom: (relayUrl: string, settings: RoomSettings) => ipcRenderer.invoke('room:start-host', relayUrl, settings),
  joinRoom: (relayUrl: string, request: { displayName: string; roomName: string; password?: string }) => ipcRenderer.invoke('room:join', relayUrl, request),
  disconnectRoom: () => ipcRenderer.invoke('room:disconnect')
});
