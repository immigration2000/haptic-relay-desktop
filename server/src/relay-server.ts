import { createServer } from 'node:http';
import { Server } from 'socket.io';
import type { MotionFrame, RoomSettings } from '../../src/shared/protocol.js';

type RoomState = RoomSettings & {
  hostSocketId: string;
  createdAt: number;
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

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: corsOrigin },
  transports: ['websocket']
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
      createdAt: Date.now()
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

    socket.to(room.roomName).emit('viewer:motion', {
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
  console.log(`Haptic Relay server listening on ws://localhost:${port}`);
});

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
