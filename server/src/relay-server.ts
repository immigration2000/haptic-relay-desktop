import { createServer } from 'node:http';
import { Server } from 'socket.io';
import type { MotionFrame, RoomSettings } from '../../src/shared/protocol.js';
import { clamp01, DEFAULT_RELAY_MAX_HZ, maxHzToInterval } from '../../src/shared/tuning.js';

type RoomState = RoomSettings & {
  hostSocketId: string;
  createdAt: number;
  lastMotionAt: number;
  forwardedFrames: number;
  droppedFrames: number;
};

type JoinRequest = {
  displayName: string;
  roomName: string;
  password?: string;
};

type HostMotionFrame = MotionFrame & {
  roomName: string;
};

const rooms = new Map<string, RoomState>();
const port = Number(process.env.HAPTIC_RELAY_PORT ?? 4174);
const corsOrigin = process.env.HAPTIC_RELAY_CORS_ORIGIN ?? '*';
const relayMaxHz = Number(process.env.HAPTIC_RELAY_MAX_HZ ?? DEFAULT_RELAY_MAX_HZ);
const minMotionIntervalMs = maxHzToInterval(relayMaxHz);

const httpServer = createServer();
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
  socket.on('room:create', (settings: RoomSettings, ack) => {
    const roomName = settings.roomName.trim();
    if (roomName.length < 3) {
      ack?.({ ok: false, reason: 'invalid-room-name' });
      return;
    }

    rooms.set(roomName, {
      ...settings,
      roomName,
      password: settings.password?.trim() || undefined,
      hostSocketId: socket.id,
      createdAt: Date.now(),
      lastMotionAt: 0,
      forwardedFrames: 0,
      droppedFrames: 0
    });
    socket.join(roomName);
    ack?.({ ok: true, roomName, entryMode: settings.entryMode });
  });

  socket.on('viewer:join', (request: JoinRequest, ack) => {
    const room = rooms.get(request.roomName);
    if (!room) {
      ack?.({ ok: false, reason: 'room-not-found' });
      return;
    }

    if (room.password && room.password !== request.password) {
      ack?.({ ok: false, reason: 'invalid-password' });
      return;
    }

    if (room.entryMode === 'request') {
      io.to(room.hostSocketId).emit('viewer:approval-requested', {
        socketId: socket.id,
        displayName: request.displayName,
        roomName: request.roomName
      });
      ack?.({ ok: false, reason: 'approval-required' });
      return;
    }

    socket.join(room.roomName);
    ack?.({ ok: true, roomName: room.roomName });
  });

  socket.on('host:motion', (frame: HostMotionFrame) => {
    const room = rooms.get(frame.roomName);
    if (!room || room.hostSocketId !== socket.id) return;

    const now = Date.now();
    if (now - room.lastMotionAt < minMotionIntervalMs) {
      room.droppedFrames += 1;
      return;
    }

    room.lastMotionAt = now;
    room.forwardedFrames += 1;

    socket.to(room.roomName).volatile.compress(false).emit('viewer:motion', {
      intensity: clamp01(frame.intensity),
      position: clamp01(frame.position),
      timestamp: Date.now()
    });
  });

  socket.on('disconnect', () => {
    for (const [roomName, room] of rooms) {
      if (room.hostSocketId === socket.id) rooms.delete(roomName);
    }
  });
});

httpServer.listen(port, () => {
  console.log(`Haptic Relay server listening on ws://localhost:${port} at ${relayMaxHz}Hz max`);
});
