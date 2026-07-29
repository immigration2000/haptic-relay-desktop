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
