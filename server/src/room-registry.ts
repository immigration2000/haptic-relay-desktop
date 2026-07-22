import type { RoomSettings } from '../../src/shared/protocol.js';
import { createClient, type RedisClientType } from 'redis';

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

export class InMemoryRoomRegistry implements RoomRegistry {
  private readonly rooms = new Map<string, RoomRecord>();

  constructor(
    private readonly relayDirectory: RelayDirectory,
    private readonly burstFrames: number
  ) {}

  async createRoom(settings: RoomSettings) {
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

  async getRoom(roomName: string) {
    return this.rooms.get(roomName);
  }

  async attachHost(roomName: string, socketId: string) {
    const room = this.rooms.get(roomName);
    if (!room) return undefined;
    room.hostSocketId = socketId;
    return room;
  }

  async removeHostSocket(socketId: string) {
    for (const [roomName, room] of this.rooms) {
      if (room.hostSocketId === socketId) {
        this.rooms.delete(roomName);
      }
    }
  }

  async listRooms() {
    return [...this.rooms.values()];
  }

  async roomCount() {
    return this.rooms.size;
  }

  listRelayNodes() {
    return this.relayDirectory.listNodes();
  }

  async saveRoom(room: RoomRecord) {
    this.rooms.set(room.roomName, room);
  }
}

export interface RoomRegistry {
  createRoom(settings: RoomSettings): Promise<RoomRecord>;
  getRoom(roomName: string): Promise<RoomRecord | undefined>;
  attachHost(roomName: string, socketId: string): Promise<RoomRecord | undefined>;
  removeHostSocket(socketId: string): Promise<void>;
  listRooms(): Promise<RoomRecord[]>;
  roomCount(): Promise<number>;
  listRelayNodes(): RelayNode[];
  saveRoom(room: RoomRecord): Promise<void>;
}

export async function createRoomRegistry(relayDirectory: RelayDirectory, burstFrames: number): Promise<RoomRegistry> {
  if (process.env.HAPTIC_ROOM_REGISTRY_DRIVER === 'redis') {
    const registry = new RedisRoomRegistry(relayDirectory, burstFrames, process.env.HAPTIC_REDIS_URL ?? 'redis://localhost:6379');
    await registry.connect();
    return registry;
  }

  return new InMemoryRoomRegistry(relayDirectory, burstFrames);
}

export class RedisRoomRegistry implements RoomRegistry {
  private client: RedisClientType | undefined;

  constructor(
    private readonly relayDirectory: RelayDirectory,
    private readonly burstFrames: number,
    private readonly redisUrl: string
  ) {}

  async connect() {
    this.client = createClient({ url: this.redisUrl });
    this.client.on('error', error => console.error('redis room registry error', error));
    await this.client.connect();
  }

  async createRoom(settings: RoomSettings) {
    const relayNode = this.relayDirectory.chooseNode(await this.listRooms());
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

    await this.saveRoom(room);
    return room;
  }

  async getRoom(roomName: string) {
    const serialized = await this.requiredClient().get(roomKey(roomName));
    return serialized ? JSON.parse(serialized) as RoomRecord : undefined;
  }

  async attachHost(roomName: string, socketId: string) {
    const room = await this.getRoom(roomName);
    if (!room) return undefined;
    room.hostSocketId = socketId;
    await this.saveRoom(room);
    return room;
  }

  async removeHostSocket(socketId: string) {
    const rooms = await this.listRooms();
    await Promise.all(rooms
      .filter(room => room.hostSocketId === socketId)
      .map(room => this.deleteRoom(room.roomName)));
  }

  async listRooms() {
    const roomNames = await this.requiredClient().sMembers(roomIndexKey());
    if (roomNames.length === 0) return [];

    const values = await this.requiredClient().mGet(roomNames.map(roomKey));
    return values
      .filter((value): value is string => Boolean(value))
      .map(value => JSON.parse(value) as RoomRecord);
  }

  async roomCount() {
    return this.requiredClient().sCard(roomIndexKey());
  }

  listRelayNodes() {
    return this.relayDirectory.listNodes();
  }

  async saveRoom(room: RoomRecord) {
    await Promise.all([
      this.requiredClient().set(roomKey(room.roomName), JSON.stringify(room), {
        EX: Number(process.env.HAPTIC_ROOM_TTL_SECONDS ?? 60 * 60 * 8)
      }),
      this.requiredClient().sAdd(roomIndexKey(), room.roomName)
    ]);
  }

  private async deleteRoom(roomName: string) {
    await Promise.all([
      this.requiredClient().del(roomKey(roomName)),
      this.requiredClient().sRem(roomIndexKey(), roomName)
    ]);
  }

  private requiredClient() {
    if (!this.client?.isReady) throw new Error('redis-room-registry-not-ready');
    return this.client;
  }
}

function roomKey(roomName: string) {
  return `haptic:room:${roomName}`;
}

function roomIndexKey() {
  return 'haptic:rooms';
}
