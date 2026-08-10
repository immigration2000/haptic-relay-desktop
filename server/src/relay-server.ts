import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { MotionFrame, RoomSettings, ViewerSession } from '../../src/shared/protocol.js';
import { clamp01, DEFAULT_RELAY_MAX_HZ } from '../../src/shared/tuning.js';
import { decodeMotionPacket, encodeMotionPacket } from '../../src/shared/motion-packet.js';
import { signRelayToken, verifyRelayToken, type RelayTokenPayload } from './control-token.js';
import { createRoomRegistry, RelayDirectory, type RoomRecord, type RoomRegistry } from './room-registry.js';

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
const pendingApprovals = new Map<string, { roomName: string; displayName: string }>();
const viewerSessions = new Map<string, ViewerSession>();
const blockedViewersByRoom = new Map<string, Set<string>>();
const approvedViewersByRoom = new Map<string, Set<string>>();
const lastForwardedSequenceByRoom = new Map<string, number>();
const port = Number(process.env.HAPTIC_RELAY_PORT ?? 4174);
const corsOrigin = process.env.HAPTIC_RELAY_CORS_ORIGIN ?? '*';
const publicRelayUrl = process.env.HAPTIC_PUBLIC_RELAY_URL ?? `http://localhost:${port}`;
const tokenSecret = process.env.HAPTIC_CONTROL_TOKEN_SECRET ?? 'dev-only-change-me';
const tokenTtlMs = Number(process.env.HAPTIC_CONTROL_TOKEN_TTL_MS ?? 1000 * 60 * 60 * 6);
const maxViewersPerRoom = Number(process.env.HAPTIC_MAX_VIEWERS_PER_ROOM ?? 500);
const relayMaxHz = Number(process.env.HAPTIC_RELAY_MAX_HZ ?? DEFAULT_RELAY_MAX_HZ);
const burstFrames = Number(process.env.HAPTIC_RELAY_BURST_FRAMES ?? 2);
const hostReconnectGraceMs = Number(process.env.HAPTIC_HOST_RECONNECT_GRACE_MS ?? 15_000);
const relayHost = process.env.HAPTIC_RELAY_HOST ?? '0.0.0.0';
const relayDirectory = RelayDirectory.fromEnv(publicRelayUrl, maxViewersPerRoom);
let roomRegistry: RoomRegistry;
const activeRooms = new Map<string, RoomRecord>();
const hostCleanupTimers = new Map<string, NodeJS.Timeout>();
let shuttingDown = false;

validateRuntimeConfig();

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
    void handleHostRoomCreate(socket, request, ack);
  });

  socket.on('viewer:join', (request: JoinRequest, ack) => {
    void handleViewerJoin(socket, request, ack);
  });

  socket.on('viewer:approve', (request: { socketId: string; approved: boolean }, ack) => {
    handleViewerApproval(socket, request, ack);
  });

  socket.on('viewer:moderate', (request: { socketId: string; action: 'kick' | 'block' }, ack) => {
    handleViewerModeration(socket, request, ack);
  });

  socket.on('room:viewers', (_request, ack) => {
    const roomName = hostRoomsBySocket.get(socket.id);
    ack?.({ ok: true, viewers: roomName ? getRoomViewers(roomName) : [] });
  });

  socket.on('room:stop', (_request, ack) => {
    handleEmergencyStop(socket, ack);
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

    void forwardMotion(socket, roomName, frame);
  });

  socket.on('host:motion', (frame: HostMotionFrame) => {
    void forwardMotion(socket, frame.roomName, frame);
  });

  socket.on('disconnect', () => {
    const roomName = hostRoomsBySocket.get(socket.id);
    if (roomName) scheduleHostCleanup(roomName, socket.id);
    pendingApprovals.delete(socket.id);
    hostRoomsBySocket.delete(socket.id);
    removeViewerSession(socket.id);
  });
});

roomRegistry = await createRoomRegistry(relayDirectory, burstFrames);
export const relayServerReady = new Promise<void>((resolve, reject) => {
  httpServer.once('error', reject);
  httpServer.listen(port, relayHost, () => {
    console.log(`Haptic Relay server listening on ${relayHost}:${port} at ${relayMaxHz}Hz max`);
    resolve();
  });
});
await relayServerReady;

export async function closeRelayServer() {
  shuttingDown = true;
  for (const timer of hostCleanupTimers.values()) clearTimeout(timer);
  hostCleanupTimers.clear();
  io.disconnectSockets(true);
  await new Promise<void>(resolve => io.close(() => resolve()));
  await roomRegistry.close?.();
}

async function handleHostRoomCreate(socket: Socket, request: HostRoomRequest, ack?: (response: unknown) => void) {
  const token = verifyRelayToken(request.token, tokenSecret);
  if (!token || token.role !== 'host') {
    ack?.({ ok: false, reason: 'invalid-host-token' });
    return;
  }

  const room = await roomRegistry.attachHost(token.roomName, socket.id);
  if (!room) {
    ack?.({ ok: false, reason: 'room-not-found' });
    return;
  }

  cancelHostCleanup(token.roomName);
  hostRoomsBySocket.set(socket.id, token.roomName);
  activeRooms.set(token.roomName, room);
  socket.join(token.roomName);
  for (const [socketId, pending] of pendingApprovals) {
    if (pending.roomName === token.roomName) {
      socket.emit('viewer:approval-requested', { socketId, ...pending });
    }
  }
  ack?.({ ok: true, roomName: token.roomName, entryMode: room.entryMode });
}

async function handleViewerJoin(socket: Socket, request: JoinRequest, ack?: (response: unknown) => void) {
  const token = request.token ? verifyRelayToken(request.token, tokenSecret) : undefined;
  if (!token || token.role !== 'viewer') {
    ack?.({ ok: false, reason: 'invalid-viewer-token' });
    return;
  }

  const room = await roomRegistry.getRoom(token.roomName);
  if (!room) {
    ack?.({ ok: false, reason: 'room-not-found' });
    return;
  }

  const connected = getConnectedCount(room.roomName);
  if (connected.viewers >= getRoomCapacity(room)) {
    ack?.({ ok: false, reason: 'room-full' });
    return;
  }

  const displayName = token.displayName ?? request.displayName;
  if (isViewerBlocked(token.roomName, displayName)) {
    ack?.({ ok: false, reason: 'blocked' });
    return;
  }

  if (room.entryMode === 'request') {
    if (isViewerApproved(token.roomName, displayName)) {
      attachViewerToRoom(socket, room.roomName, displayName);
      ack?.({ ok: true, roomName: room.roomName });
      return;
    }

    pendingApprovals.set(socket.id, {
      roomName: token.roomName,
      displayName
    });
    if (room.hostSocketId) io.to(room.hostSocketId).emit('viewer:approval-requested', {
      socketId: socket.id,
      displayName,
      roomName: token.roomName
    });
    ack?.({ ok: false, reason: 'approval-required', requestId: socket.id });
    return;
  }

  attachViewerToRoom(socket, room.roomName, displayName);
  ack?.({ ok: true, roomName: room.roomName });
}

function handleViewerApproval(socket: Socket, request: { socketId: string; approved: boolean }, ack?: (response: unknown) => void) {
  const roomName = hostRoomsBySocket.get(socket.id);
  const pending = pendingApprovals.get(request.socketId);
  if (!roomName || !pending || pending.roomName !== roomName) {
    ack?.({ ok: false, reason: 'approval-not-found' });
    return;
  }

  const viewerSocket = io.sockets.sockets.get(request.socketId);
  if (!viewerSocket) {
    pendingApprovals.delete(request.socketId);
    ack?.({ ok: false, reason: 'viewer-disconnected' });
    return;
  }

  pendingApprovals.delete(request.socketId);
  if (!request.approved) {
    viewerSocket.emit('viewer:rejected', { roomName });
    ack?.({ ok: true, approved: false });
    return;
  }

  const room = activeRooms.get(roomName);
  if (!room || getConnectedCount(roomName).viewers >= getRoomCapacity(room)) {
    viewerSocket.emit('viewer:rejected', { roomName, reason: 'room-full' });
    ack?.({ ok: false, reason: 'room-full' });
    return;
  }

  getApprovedViewers(roomName).add(normalizeViewerName(pending.displayName));
  attachViewerToRoom(viewerSocket, roomName, pending.displayName);
  viewerSocket.emit('viewer:approved', { roomName });
  ack?.({ ok: true, approved: true });
}

function handleViewerModeration(socket: Socket, request: { socketId: string; action: 'kick' | 'block' }, ack?: (response: unknown) => void) {
  const roomName = hostRoomsBySocket.get(socket.id);
  const session = viewerSessions.get(request.socketId);
  if (!roomName || !session || session.roomName !== roomName) {
    ack?.({ ok: false, reason: 'viewer-not-found' });
    return;
  }

  if (request.action === 'block') {
    getBlockedViewers(roomName).add(normalizeViewerName(session.displayName));
    approvedViewersByRoom.get(roomName)?.delete(normalizeViewerName(session.displayName));
  }

  const viewerSocket = io.sockets.sockets.get(request.socketId);
  viewerSocket?.leave(roomName);
  viewerSocket?.emit('viewer:removed', { roomName, reason: request.action });
  removeViewerSession(request.socketId);
  ack?.({ ok: true, action: request.action });
}

function handleEmergencyStop(socket: Socket, ack?: (response: unknown) => void) {
  const roomName = hostRoomsBySocket.get(socket.id);
  if (!roomName) {
    ack?.({ ok: false, reason: 'invalid-host-room' });
    return;
  }

  socket.to(roomName).volatile.compress(false).emit('room:stop', { roomName, timestamp: Date.now() });
  ack?.({ ok: true, roomName });
}

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
    sendJson(response, 200, { ok: true, rooms: await roomRegistry.roomCount(), relayNodes: roomRegistry.listRelayNodes().length });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/metrics') {
    sendJson(response, 200, {
      relayNodes: roomRegistry.listRelayNodes(),
      rooms: (await roomRegistry.listRooms()).map(room => {
        const activeRoom = activeRooms.get(room.roomName) ?? room;
        return {
          roomName: room.roomName,
          entryMode: room.entryMode,
          relayNodeId: room.relayNodeId,
          relayUrl: room.relayUrl,
          connected: getConnectedCount(room.roomName),
          pendingApprovals: [...pendingApprovals.values()].filter(request => request.roomName === room.roomName).length,
          blockedViewers: blockedViewersByRoom.get(room.roomName)?.size ?? 0,
          forwardedFrames: activeRoom.forwardedFrames,
          droppedFrames: activeRoom.droppedFrames,
          effectiveMaxHz: relayMaxHz
        };
      })
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

    const room = await roomRegistry.createRoom({ ...settings, roomName, entryMode: settings.entryMode ?? 'open' });
    sendJson(response, 201, {
      ok: true,
      roomName,
      entryMode: room.entryMode,
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
    const room = await roomRegistry.getRoom(roomName);
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

async function forwardMotion(socket: Socket, roomName: string, frame: MotionFrame) {
  const room = activeRooms.get(roomName);
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
    timestamp: frame.sourceTimeMs ?? frame.timestamp ?? now,
    protocolVersion: frame.protocolVersion,
    flags: frame.flags,
    sequence: resolveForwardedSequence(roomName, frame.sequence),
    sourceTimeMs: frame.sourceTimeMs ?? frame.timestamp ?? now,
    durationMs: frame.durationMs ?? 0
  };

  socket.to(room.roomName).volatile.compress(false).emit('m', encodeMotionPacket(safeFrame));
}

function getConnectedCount(roomName: string) {
  const size = io.sockets.adapter.rooms.get(roomName)?.size ?? 0;
  const room = activeRooms.get(roomName);
  return {
    total: size,
    viewers: Math.max(0, size - (room?.hostSocketId ? 1 : 0))
  };
}

function attachViewerToRoom(socket: Socket, roomName: string, displayName: string) {
  const session = { socketId: socket.id, displayName, roomName };
  viewerSessions.set(socket.id, session);
  socket.join(roomName);
  emitViewerList(roomName);
}

function removeViewerSession(socketId: string) {
  const session = viewerSessions.get(socketId);
  if (!session) return;

  viewerSessions.delete(socketId);
  emitViewerList(session.roomName);
}

function scheduleHostCleanup(roomName: string, socketId: string) {
  activeRooms.delete(roomName);
  if (shuttingDown) return;

  cancelHostCleanup(roomName);
  const timer = setTimeout(() => {
    void finalizeHostCleanup(roomName, socketId, timer);
  }, hostReconnectGraceMs);
  timer.unref();
  hostCleanupTimers.set(roomName, timer);
}

function cancelHostCleanup(roomName: string) {
  const timer = hostCleanupTimers.get(roomName);
  if (!timer) return;
  clearTimeout(timer);
  hostCleanupTimers.delete(roomName);
}

async function finalizeHostCleanup(roomName: string, socketId: string, timer: NodeJS.Timeout) {
  try {
    const room = await roomRegistry.getRoom(roomName);
    if (!room || room.hostSocketId !== socketId) return;

    closeViewerSessions(roomName);
    await roomRegistry.removeHostSocket(socketId);
  } catch (error) {
    console.error('host room cleanup failed', error);
  } finally {
    if (hostCleanupTimers.get(roomName) === timer) hostCleanupTimers.delete(roomName);
  }
}

function closeViewerSessions(roomName: string) {
  for (const [socketId, pending] of pendingApprovals) {
    if (pending.roomName === roomName) pendingApprovals.delete(socketId);
  }

  for (const [socketId, session] of viewerSessions) {
    if (session.roomName !== roomName) continue;
    const viewerSocket = io.sockets.sockets.get(socketId);
    viewerSocket?.leave(roomName);
    viewerSocket?.emit('viewer:removed', { roomName, reason: 'host-disconnected' });
    viewerSessions.delete(socketId);
  }

  blockedViewersByRoom.delete(roomName);
  approvedViewersByRoom.delete(roomName);
  lastForwardedSequenceByRoom.delete(roomName);
}

function getRoomViewers(roomName: string) {
  return [...viewerSessions.values()].filter(session => session.roomName === roomName);
}

function emitViewerList(roomName: string) {
  const room = activeRooms.get(roomName);
  if (!room?.hostSocketId) return;
  io.to(room.hostSocketId).emit('room:viewers', getRoomViewers(roomName));
}

function getBlockedViewers(roomName: string) {
  let blocked = blockedViewersByRoom.get(roomName);
  if (!blocked) {
    blocked = new Set<string>();
    blockedViewersByRoom.set(roomName, blocked);
  }
  return blocked;
}

function isViewerBlocked(roomName: string, displayName: string) {
  return getBlockedViewers(roomName).has(normalizeViewerName(displayName));
}

function getApprovedViewers(roomName: string) {
  let approved = approvedViewersByRoom.get(roomName);
  if (!approved) {
    approved = new Set<string>();
    approvedViewersByRoom.set(roomName, approved);
  }
  return approved;
}

function isViewerApproved(roomName: string, displayName: string) {
  return getApprovedViewers(roomName).has(normalizeViewerName(displayName));
}

function normalizeViewerName(displayName: string) {
  return displayName.trim().toLowerCase();
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

function resolveForwardedSequence(roomName: string, suppliedSequence?: number) {
  const previousSequence = lastForwardedSequenceByRoom.get(roomName);
  if (suppliedSequence === undefined) {
    const nextSequence = previousSequence === undefined ? 0 : (previousSequence + 1) >>> 0;
    lastForwardedSequenceByRoom.set(roomName, nextSequence);
    return nextSequence;
  }

  const sequence = suppliedSequence >>> 0;
  if (previousSequence === undefined) {
    lastForwardedSequenceByRoom.set(roomName, sequence);
    return sequence;
  }

  const forwardDistance = (sequence - previousSequence) >>> 0;
  if (forwardDistance > 0 && forwardDistance < 0x8000_0000) {
    lastForwardedSequenceByRoom.set(roomName, sequence);
  }
  return sequence;
}

function validateRuntimeConfig() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('invalid-relay-port');
  }
  if (!Number.isFinite(tokenTtlMs) || tokenTtlMs <= 0) {
    throw new Error('invalid-token-ttl');
  }
  if (!Number.isFinite(maxViewersPerRoom) || maxViewersPerRoom < 1) {
    throw new Error('invalid-max-viewers');
  }
  if (!Number.isFinite(relayMaxHz) || relayMaxHz < 1 || relayMaxHz > 240) {
    throw new Error('invalid-relay-max-hz');
  }
  if (!Number.isFinite(burstFrames) || burstFrames < 1 || burstFrames > 10) {
    throw new Error('invalid-relay-burst-frames');
  }
  if (!Number.isFinite(hostReconnectGraceMs) || hostReconnectGraceMs < 0 || hostReconnectGraceMs > 300_000) {
    throw new Error('invalid-host-reconnect-grace');
  }

  if (process.env.NODE_ENV === 'production') {
    if (tokenSecret === 'dev-only-change-me' || tokenSecret === 'change-me-before-production' || tokenSecret.length < 32) {
      throw new Error('insecure-production-token-secret');
    }
    if (publicRelayUrl.startsWith('http://localhost') || publicRelayUrl.startsWith('http://127.0.0.1')) {
      throw new Error('invalid-production-public-relay-url');
    }
  }
}
