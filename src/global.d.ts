import type { AppLogEntry, AppSettings, ApprovalRequest, HardwareOutputSnapshot, HardwareProfile, HardwareProtection, MotionDemoSnapshot, MotionMonitorSnapshot, MotionPatternConfig, PortInfo, RoomDirectoryEntry, RoomSettings, ViewerSession } from './shared/protocol';

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

type TCodeProbeResult = {
  detected: boolean;
  raw: string[];
  version?: string;
  axes: string[];
};

type HardwareConnectResult = {
  connected: boolean;
  path: string;
  baudRate: number;
  profile: HardwareProfile;
  probe: TCodeProbeResult;
};

type MotionDelayBuffer = {
  motionDelayMs: number;
  bufferedFrames: number;
  overflowFrames: number;
};

declare global {
  interface Window {
    hapticRelay: {
      listPorts: () => Promise<PortInfo[]>;
      connectHardware: (pathName: string, profile: HardwareProfile) => Promise<HardwareConnectResult>;
      disconnectHardware: () => Promise<unknown>;
      stopHardware: () => Promise<unknown>;
      testHardware: () => Promise<{ tested: boolean; steps?: number; reason?: string }>;
      sendMotion: (intensity: number, position: number) => Promise<unknown>;
      startMotionDemo: (intensity: number, position: number) => Promise<{ streaming: boolean; intervalMs: number }>;
      updateMotionDemo: (intensity: number, position: number) => void;
      startMotionPattern: (config: MotionPatternConfig) => Promise<{ streaming: boolean; mode: 'pattern'; intervalMs: number }>;
      updateMotionPattern: (config: MotionPatternConfig) => void;
      stopMotionDemo: () => Promise<{ streaming: boolean }>;
      setHardwareProtection: (protection: HardwareProtection) => Promise<{ protection: HardwareProtection }>;
      startHostRoom: (relayUrl: string, settings: RoomSettings) => Promise<{ roomName: string; entryMode: string; relayUrl: string }>;
      listRooms: (relayUrl: string) => Promise<RoomDirectoryEntry[]>;
      checkServer: (relayUrl: string) => Promise<{ online: true; latencyMs: number }>;
      joinRoom: (relayUrl: string, request: { displayName: string; roomName: string; password?: string }) => Promise<{ ok: boolean; reason?: string; roomName?: string }>;
      approveViewer: (socketId: string, approved: boolean) => Promise<unknown>;
      moderateViewer: (socketId: string, action: 'kick' | 'block') => Promise<unknown>;
      listViewers: () => Promise<ViewerSession[]>;
      emergencyStop: () => Promise<unknown>;
      onApprovalRequest: (listener: (request: ApprovalRequest) => void) => () => void;
      onViewerStatus: (listener: (status: ViewerStatus) => void) => () => void;
      onViewerList: (listener: (viewers: ViewerSession[]) => void) => () => void;
      onEmergencyStop: (listener: (signal: StopSignal) => void) => () => void;
      onConnectionStatus: (listener: (status: RelayConnectionStatus) => void) => () => void;
      onMotionDemoFrame: (listener: (snapshot: MotionDemoSnapshot) => void) => () => void;
      onMotionReceived: (listener: (snapshot: MotionMonitorSnapshot) => void) => () => void;
      onHardwareOutput: (listener: (snapshot: HardwareOutputSnapshot) => void) => () => void;
      getLogs: () => Promise<AppLogEntry[]>;
      exportLogs: () => Promise<{ exported: boolean; canceled: boolean; path?: string; count: number }>;
      copyText: (text: string) => Promise<{ copied: boolean }>;
      getSettings: () => Promise<AppSettings>;
      saveSettings: (settings: AppSettings) => Promise<{ settings: AppSettings }>;
      setMotionDelay: (delayMs: number) => Promise<{ settings: AppSettings; buffer: MotionDelayBuffer }>;
      onLog: (listener: (entry: AppLogEntry) => void) => () => void;
      disconnectRoom: () => Promise<unknown>;
    };
  }
}

export {};
