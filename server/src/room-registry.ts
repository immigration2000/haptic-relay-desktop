import type { RoomSettings } from '../../src/shared/protocol.js';

export type RelayNode = {
  id: string;
  url: string;
  maxViewers: number;
};

export type RoomRecord = RoomSettings & {
  relayNodeId: string;
  relayUrl: string;
  hostSocketId?: string;
  createdAt: number;
  motionTokens: number;
  lastTokenRefillAt: number;
  forwardedFrames: number;
  droppedFrames: number;
};

export class RelayDirectory {
  constructor(private readonly nodes: RelayNode[]) {
    if (nodes.length === 0) throw new Error('relay-directory-empty');
  }

  static fromEnv(fallbackUrl: string, fallbackMaxViewers: number) {
    const configured = process.env.HAPTIC_RELAY_NODES;
    if (configured) {
      return new RelayDirectory(JSON.parse(configured) as RelayNode[]);
    }

    return new RelayDirectory([{
      id: process.env.HAPTIC_RELAY_NODE_ID ?? 'local-1',
      url: fallbackUrl,
      maxViewers: fallbackMaxViewers
    }]);
  }

  chooseNode(rooms: Iterable<RoomRecord>) {
    const roomCounts = new Map(this.nodes.map(node => [node.id, 0]));
    for (const room of rooms) {
      roomCounts.set(room.relayNodeId, (roomCounts.get(room.relayNodeId) ?? 0) + 1);
    }

    return [...this.nodes].sort((left, right) => {
      const leftRooms = roomCounts.get(left.id) ?? 0;
      const rightRooms = roomCounts.get(right.id) ?? 0;
      return leftRooms - rightRooms;
    })[0];
  }

  listNodes() {
    return this.nodes;
  }
}

export class InMemoryRoomRegistry {
  private readonly rooms = new Map<string, RoomRecord>();

  constructor(
    private readonly relayDirectory: RelayDirectory,
    private readonly burstFrames: number
  ) {}

  createRoom(settings: RoomSettings) {
    const relayNode = this.relayDirectory.chooseNode(this.rooms.values());
    const room: RoomRecord = {
      ...settings,
      password: settings.password?.trim() || undefined,
      entryMode: settings.entryMode ?? 'open',
      relayNodeId: relayNode.id,
      relayUrl: relayNode.url,
      createdAt: Date.now(),
      motionTokens: this.burstFrames,
      lastTokenRefillAt: Date.now(),
      forwardedFrames: 0,
      droppedFrames: 0
    };

    this.rooms.set(room.roomName, room);
    return room;
  }

  getRoom(roomName: string) {
    return this.rooms.get(roomName);
  }

  attachHost(roomName: string, socketId: string) {
    const room = this.rooms.get(roomName);
    if (!room) return undefined;
    room.hostSocketId = socketId;
    return room;
  }

  removeHostSocket(socketId: string) {
    for (const [roomName, room] of this.rooms) {
      if (room.hostSocketId === socketId) {
        this.rooms.delete(roomName);
      }
    }
  }

  listRooms() {
    return [...this.rooms.values()];
  }

  roomCount() {
    return this.rooms.size;
  }

  listRelayNodes() {
    return this.relayDirectory.listNodes();
  }
}
