import process from 'node:process';
import { createClient } from 'redis';
import { createRoomRegistry, RelayDirectory } from '../dist-server/server/src/room-registry.js';

const redisUrl = process.env.HAPTIC_REDIS_URL ?? 'redis://localhost:6379';
const ttlSeconds = Number(process.env.HAPTIC_ROOM_TTL_SECONDS ?? 60);
const roomName = `redis-live-${Date.now()}`;
const hostSocketId = `host-${Date.now()}`;

process.env.HAPTIC_ROOM_REGISTRY_DRIVER = 'redis';
process.env.HAPTIC_REDIS_URL = redisUrl;
process.env.HAPTIC_ROOM_TTL_SECONDS = String(ttlSeconds);

const relayDirectory = new RelayDirectory([
  { id: 'redis-test-1', url: 'https://relay-test-1.example.com', maxViewers: 500 },
  { id: 'redis-test-2', url: 'https://relay-test-2.example.com', maxViewers: 500 }
]);

const cleanupClient = createClient({
  url: redisUrl,
  socket: {
    connectTimeout: 2_000,
    reconnectStrategy: false
  }
});
cleanupClient.on('error', error => {
  console.error('redis cleanup client error', formatError(error));
});

let registry;

try {
  await cleanupClient.connect();
  await cleanupClient.del(`haptic:room:${roomName}`);
  await cleanupClient.sRem('haptic:rooms', roomName);

  registry = await createRoomRegistry(relayDirectory, 2);

  const created = await registry.createRoom({
    roomName,
    password: 'secret',
    entryMode: 'request'
  });
  assertEqual(created.roomName, roomName, 'created roomName');
  assertEqual(created.entryMode, 'request', 'created entryMode');
  assertEqual(created.password, 'secret', 'created password');

  const fetched = await registry.getRoom(roomName);
  assert(fetched, 'room should be readable from Redis');
  assertEqual(fetched.relayNodeId, created.relayNodeId, 'relay node persisted');

  const attached = await registry.attachHost(roomName, hostSocketId);
  assert(attached, 'host attach should return room');
  assertEqual(attached.hostSocketId, hostSocketId, 'host socket persisted');

  const countAfterCreate = await registry.roomCount();
  assert(countAfterCreate >= 1, 'room count should include test room');

  const rooms = await registry.listRooms();
  assert(rooms.some(room => room.roomName === roomName), 'listRooms should include test room');

  const ttl = await cleanupClient.ttl(`haptic:room:${roomName}`);
  assert(ttl > 0 && ttl <= ttlSeconds, `room TTL should be within configured range, got ${ttl}`);

  await registry.removeHostSocket(hostSocketId);
  const removed = await registry.getRoom(roomName);
  assert(!removed, 'removeHostSocket should delete hosted room');

  console.log('Redis registry live test passed');
  console.log(JSON.stringify({
    redisUrl,
    ttlSeconds,
    roomName,
    relayNodeId: created.relayNodeId
  }, null, 2));
} catch (error) {
  console.error('Redis registry live test failed');
  console.error(formatError(error));
  process.exitCode = 1;
} finally {
  await registry?.close?.().catch(error => console.error('registry close failed', error.message));
  if (cleanupClient.isOpen) {
    await cleanupClient.del(`haptic:room:${roomName}`).catch(() => undefined);
    await cleanupClient.sRem('haptic:rooms', roomName).catch(() => undefined);
    await cleanupClient.quit().catch(() => undefined);
  }
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function formatError(error) {
  if (error instanceof AggregateError) {
    return error.errors.map(formatError).join('; ');
  }
  if (error instanceof Error) {
    const code = typeof error.code === 'string' ? ` (${error.code})` : '';
    return `${error.name}${error.message ? `: ${error.message}` : ''}${code}`;
  }
  return String(error);
}
