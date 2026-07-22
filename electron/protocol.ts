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

export type ApprovalRequest = {
  socketId: string;
  displayName: string;
  roomName: string;
};
