import type { PortInfo, RoomSettings } from './shared/protocol';

declare global {
  interface Window {
    hapticRelay: {
      listPorts: () => Promise<PortInfo[]>;
      connectHardware: (pathName: string, baudRate: number) => Promise<unknown>;
      disconnectHardware: () => Promise<unknown>;
      sendMotion: (intensity: number, position: number) => Promise<unknown>;
      startHostRoom: (relayUrl: string, settings: RoomSettings) => Promise<{ roomName: string; entryMode: string; relayUrl: string }>;
      joinRoom: (relayUrl: string, request: { displayName: string; roomName: string; password?: string }) => Promise<unknown>;
      disconnectRoom: () => Promise<unknown>;
    };
  }
}

export {};
