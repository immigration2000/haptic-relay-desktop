import type { ApprovalRequest, PortInfo, RoomSettings, ViewerSession } from './shared/protocol';

type ViewerStatus = {
  roomName: string;
  status: 'approved' | 'rejected' | 'removed';
  reason?: string;
};

type StopSignal = {
  roomName: string;
  timestamp: number;
};

declare global {
  interface Window {
    hapticRelay: {
      listPorts: () => Promise<PortInfo[]>;
      connectHardware: (pathName: string, baudRate: number) => Promise<unknown>;
      disconnectHardware: () => Promise<unknown>;
      stopHardware: () => Promise<unknown>;
      sendMotion: (intensity: number, position: number) => Promise<unknown>;
      startHostRoom: (relayUrl: string, settings: RoomSettings) => Promise<{ roomName: string; entryMode: string; relayUrl: string }>;
      joinRoom: (relayUrl: string, request: { displayName: string; roomName: string; password?: string }) => Promise<{ ok: boolean; reason?: string; roomName?: string }>;
      approveViewer: (socketId: string, approved: boolean) => Promise<unknown>;
      moderateViewer: (socketId: string, action: 'kick' | 'block') => Promise<unknown>;
      listViewers: () => Promise<ViewerSession[]>;
      emergencyStop: () => Promise<unknown>;
      onApprovalRequest: (listener: (request: ApprovalRequest) => void) => () => void;
      onViewerStatus: (listener: (status: ViewerStatus) => void) => () => void;
      onViewerList: (listener: (viewers: ViewerSession[]) => void) => () => void;
      onEmergencyStop: (listener: (signal: StopSignal) => void) => () => void;
      disconnectRoom: () => Promise<unknown>;
    };
  }
}

export {};
