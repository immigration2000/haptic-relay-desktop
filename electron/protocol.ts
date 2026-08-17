export type EntryMode = 'open' | 'request';

export type RoomSettings = {
  roomName: string;
  password?: string;
  entryMode: EntryMode;
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
  invertPosition: boolean;
};

export type HardwareProtection = {
  intensityLimit: number;
  positionMin: number;
  positionMax: number;
  paused: boolean;
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
  schemaVersion: 2;
  hardwareProfile: HardwareProfile;
  hardwareProtection: HardwareProtection;
  playback: PlaybackSettings;
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
