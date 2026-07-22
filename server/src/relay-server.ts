import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { MotionFrame, RoomSettings } from '../../src/shared/protocol.js';
import { clamp01, DEFAULT_RELAY_MAX_HZ } from '../../src/shared/tuning.js';
import { decodeMotionPacket, encodeMotionPacket } from '../../src/shared/motion-packet.js';
import { signRelayToken, verifyRelayToken, type RelayTokenPayload } from './control-token.js';
import { InMemoryRoomRegistry, RelayDirectory, type RoomRecord } from './room-registry.js';

type JoinRequest = {
  displayName: string;
  roomName: string;
  password?: string;
  token?: string;
};

type HostMotionFrame = MotionFrame & {
  roomName: string;
};

type HostRoomRequest = {
  token: string;
};

const hostRoomsBySocket = new Map<string, string>();
const port = Number(process.env.HAPTIC_RELAY_PORT ?? 4174);
const corsOrigin = process.env.HAPTIC_RELAY_CORS_ORIGIN ?? '*';
const publicRelayUrl = process.env.HAPTIC_PUBLIC_RELAY_URL ?? `http://localhost:${port}`;
const tokenSecret = process.env.HAPTIC_CONTROL_TOKEN_SECRET ?? 'dev-only-change-me';
const tokenTtlMs = Number(process.env.HAPTIC_CONTROL_TOKEN_TTL_MS ?? 1000 * 60 * 60 * 6);
const maxViewersPerRoom = Number(process.env.HAPTIC_MAX_VIEWERS_PER_ROOM ?? 500);
const relayMaxHz = Number(process.env.HAPTIC_RELAY_MAX_HZ ?? DEFAULT_RELAY_MAX_HZ);
const burstFrames = Number(process.env.HAPTIC_RELAY_BURST_FRAMES ?? 2);
const relayDirectory = RelayDirectory.fromEnv(publicRelayUrl, maxViewersPerRoom);
const roomRegistry = new InMemoryRoomRegistry(relayDirectory, burstFrames);

const httpServer = createServer((request, response) => {
  void handleControlRequest(request, response).catch(error => {
    console.error('control request failed', error);
    if (!response.headersSent) sendJson(response, 400, { ok: false, reason: 'bad-request' });
  });
});
const io = new Server(httpServer, {
  cors: { origin: corsOrigin },
  transports: ['websocket'],
  allowUpgrades: false,
  perMessageDeflate: false,
  httpCompression: false,
  maxHttpBufferSize: 4096,
  pingInterval: 10000,
  pingTimeout: 5000
});

io.on('connection', socket => {
  socket.on('room:create', (request: HostRoomRequest, ack) => {
    const token = verifyRelayToken(request.token, tokenSecret);
    if (!token || token.role !== 'host') {
      ack?.({ ok: false, reason: 'invalid-host-token' });
      return;
    }

    const room = roomRegistry.attachHost(token.roomName, socket.id);
    if (!room) {
      ack?.({ ok: false, reason: 'room-not-found' });
      return;
    }

    hostRoomsBySocket.set(socket.id, token.roomName);
    socket.join(token.roomName);
    ack?.({ ok: true, roomName: token.roomName, entryMode: room.entryMode });
  });

  socket.on('viewer:join', (request: JoinRequest, ack) => {
    const token = request.token ? verifyRelayToken(request.token, tokenSecret) : undefined;
    if (!token || token.role !== 'viewer') {
      ack?.({ ok: false, reason: 'invalid-viewer-token' });
      return;
    }

    const room = roomRegistry.getRoom(token.roomName);
    if (!room) {
      ack?.({ ok: false, reason: 'room-not-found' });
      return;
    }

    const connected = getConnectedCount(room.roomName);
    if (connected.viewers >= getRoomCapacity(room)) {
      ack?.({ ok: false, reason: 'room-full' });
      return;
    }

    if (room.entryMode === 'request') {
      if (room.hostSocketId) io.to(room.hostSocketId).emit('viewer:approval-requested', {
        socketId: socket.id,
        displayName: token.displayName ?? request.displayName,
        roomName: token.roomName
      });
      ack?.({ ok: false, reason: 'approval-required' });
      return;
    }

    socket.join(room.roomName);
    ack?.({ ok: true, roomName: room.roomName });
  });

  socket.on('m', (payload: ArrayBuffer | Uint8Array | Buffer) => {
    const roomName = hostRoomsBySocket.get(socket.id);
    if (!roomName) return;

    let frame: MotionFrame;
    try {
      frame = decodeMotionPacket(payload);
    } catch {
      return;
    }

    forwardMotion(socket, roomName, frame);
  });

  socket.on('host:motion', (frame: HostMotionFrame) => {
    forwardMotion(socket, frame.roomName, frame);
  });

  socket.on('disconnect', () => {
    hostRoomsBySocket.delete(socket.id);
    roomRegistry.removeHostSocket(socket.id);
  });
});

httpServer.listen(port, () => {
  console.log(`Haptic Relay server listening on ws://localhost:${port} at ${relayMaxHz}Hz max`);
});

async function handleControlRequest(request: IncomingMessage, response: ServerResponse) {
  response.setHeader('Access-Control-Allow-Origin', corsOrigin);
  response.setHeader('Access-Control-Allow-Headers', 'content-type');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Cache-Control', 'no-store');

  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }

  const url = new URL(request.url ?? '/', publicRelayUrl);
  if (request.method === 'GET' && url.pathname === '/healthz') {
    sendJson(response, 200, { ok: true, rooms: roomRegistry.roomCount(), relayNodes: roomRegistry.listRelayNodes().length });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/metrics') {
    sendJson(response, 200, {
      relayNodes: roomRegistry.listRelayNodes(),
      rooms: roomRegistry.listRooms().map(room => ({
        roomName: room.roomName,
        entryMode: room.entryMode,
        relayNodeId: room.relayNodeId,
        relayUrl: room.relayUrl,
        connected: getConnectedCount(room.roomName),
        forwardedFrames: room.forwardedFrames,
        droppedFrames: room.droppedFrames,
        effectiveMaxHz: relayMaxHz
      }))
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/rooms') {
    const settings = await readJson<RoomSettings>(request);
    const roomName = settings.roomName?.trim();
    if (!roomName || roomName.length < 3) {
      sendJson(response, 400, { ok: false, reason: 'invalid-room-name' });
      return;
    }

    const room = roomRegistry.createRoom({ ...settings, roomName, entryMode: settings.entryMode ?? 'open' });
    sendJson(response, 201, {
      ok: true,
      roomName,
      entryMode: settings.entryMode,
      relayNodeId: room.relayNodeId,
      relayUrl: room.relayUrl,
      hostToken: createRelayToken({ role: 'host', roomName })
    });
    return;
  }

  const joinMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/join$/);
  if (request.method === 'POST' && joinMatch) {
    const roomName = decodeURIComponent(joinMatch[1]);
    const requestBody = await readJson<JoinRequest>(request);
    const room = roomRegistry.getRoom(roomName);
    if (!room) {
      sendJson(response, 404, { ok: false, reason: 'room-not-found' });
      return;
    }

    if (room.password && room.password !== requestBody.password) {
      sendJson(response, 403, { ok: false, reason: 'invalid-password' });
      return;
    }

    const connected = getConnectedCount(room.roomName);
    if (connected.viewers >= getRoomCapacity(room)) {
      sendJson(response, 409, { ok: false, reason: 'room-full' });
      return;
    }

    sendJson(response, 200, {
      ok: true,
      roomName,
      relayNodeId: room.relayNodeId,
      relayUrl: room.relayUrl,
      viewerToken: createRelayToken({
        role: 'viewer',
        roomName,
        displayName: requestBody.displayName?.trim() || 'viewer'
      })
    });
    return;
  }

  sendJson(response, 404, { ok: false, reason: 'not-found' });
}

function createRelayToken(payload: Omit<RelayTokenPayload, 'exp'>) {
  return signRelayToken({
    ...payload,
    exp: Date.now() + tokenTtlMs
  }, tokenSecret);
}

function forwardMotion(socket: Socket, roomName: string, frame: MotionFrame) {
  const room = roomRegistry.getRoom(roomName);
  if (!room || room.hostSocketId !== socket.id) return;

  refillMotionTokens(room);
  if (room.motionTokens < 1) {
    room.droppedFrames += 1;
    return;
  }

  room.motionTokens -= 1;
  room.forwardedFrames += 1;

  const now = Date.now();
  const safeFrame = {
    intensity: clamp01(frame.intensity),
    position: clamp01(frame.position),
    timestamp: now
  };

  socket.to(room.roomName).volatile.compress(false).emit('m', encodeMotionPacket(safeFrame));
}

function getConnectedCount(roomName: string) {
  const size = io.sockets.adapter.rooms.get(roomName)?.size ?? 0;
  const room = roomRegistry.getRoom(roomName);
  return {
    total: size,
    viewers: Math.max(0, size - (room?.hostSocketId ? 1 : 0))
  };
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readJson<T>(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T;
}

function getRoomCapacity(room: RoomRecord) {
  return roomRegistry.listRelayNodes().find(node => node.id === room.relayNodeId)?.maxViewers ?? maxViewersPerRoom;
}

function refillMotionTokens(room: RoomRecord) {
  const now = Date.now();
  const elapsedMs = now - room.lastTokenRefillAt;
  if (elapsedMs <= 0) return;

  const refill = elapsedMs * (relayMaxHz / 1000);
  room.motionTokens = Math.min(burstFrames, room.motionTokens + refill);
  room.lastTokenRefillAt = now;
}
