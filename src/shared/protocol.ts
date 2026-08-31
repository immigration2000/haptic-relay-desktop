export type EntryMode = 'open' | 'request';

export type RoomSettings = {
  roomName: string;
  password?: string;
  entryMode: EntryMode;
};

export type RoomDirectoryEntry = {
  roomName: string;
  entryMode: EntryMode;
  passwordProtected: boolean;
  viewerCount: number;
  maxViewers: number;
  relayNodeId: string;
  createdAt: number;
};

export type RoomDirectoryResponse = {
  ok: true;
  rooms: RoomDirectoryEntry[];
};

export type MotionFrame = {
  intensity: number;
  position: number;
  timestamp: number;
  protocolVersion?: 1 | 2;
  flags?: number;
  sequence?: number;
  sourceTimeMs?: number;
  durationMs?: number;
};

export type MotionPattern = 'sine' | 'triangle' | 'pulse' | 'sawtooth';

export type MotionPatternConfig = {
  pattern: MotionPattern;
  periodMs: number;
  positionMin: number;
  positionMax: number;
  intensity: number;
};

export type MotionDemoMode = 'manual' | 'pattern';

export type MotionDemoSnapshot = {
  mode: MotionDemoMode;
  frame: MotionFrame;
};

export type MotionMonitorSnapshot = {
  frame: MotionFrame;
  receivedAt: number;
  receivedFrames: number;
  hardware: {
    queued: boolean;
    reason?: string;
  };
};

export type HardwareProfile = {
  baudRate: number;
  linearAxis: string;
  vibrationAxis?: string;
  strokeMin: number;
  strokeMax: number;
  stopPosition: number;
  invertPosition: boolean;
};

export type HardwareProtection = {
  intensityLimit: number;
  positionMin: number;
  positionMax: number;
  paused: boolean;
};

export type HardwareStopResult = {
  stopped: boolean;
  reason?: string;
};

export type HardwareEmergencyState = {
  emergencyStopped: boolean;
};

export type HardwareLatchedStopResult = HardwareStopResult & HardwareEmergencyState;

export type HardwareProtectionResult = {
  protection: HardwareProtection;
};

export type HardwareOutputSnapshot = {
  kind: 'motion' | 'test' | 'stop';
  command: string;
  completedAt: number;
  portPath: string;
  baudRate: number;
};

export type HardwareOutputLogRow = HardwareOutputSnapshot & {
  id: number;
};

export type HardwareOutputLogAppend = {
  sessionId: number;
  row: HardwareOutputLogRow;
  omittedRows: number;
};

export type HardwareOutputLogSession = {
  sessionId: number;
  startedAt?: number;
  portPath?: string;
  rows: HardwareOutputLogRow[];
  omittedRows: number;
};

export type HardwareConnectionStatus = {
  connected: boolean;
  path?: string;
  reason?: string;
  unexpected?: boolean;
  emergencyStopped?: boolean;
};

export type HardwareDisconnectResult = {
  connected: false;
};

export type RoomDisconnectResult = HardwareDisconnectResult & {
  stop: HardwareStopResult;
};

export type PlaybackSettings = {
  motionDelayMs: number;
};

export type AppLogEntry = {
  id: number;
  timestamp: number;
  level: 'info' | 'warning' | 'error';
  source: 'hardware' | 'relay' | 'room' | 'protection' | 'app';
  message: string;
  details?: string;
};

export type AppSettings = {
  schemaVersion: 3;
  hardwareProfile: HardwareProfile;
  hardwareProtection: HardwareProtection;
  playback: PlaybackSettings;
};

export type PortInfo = {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
};

export type ApprovalRequest = {
  socketId: string;
  displayName: string;
  roomName: string;
};

export type ViewerSession = {
  socketId: string;
  displayName: string;
  roomName: string;
};
