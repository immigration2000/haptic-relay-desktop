import { createServer, Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { MotionFrame, RoomSettings } from '../protocol.js';

type JoinRequest = {
  displayName: string;
  roomName: string;
  password?: string;
};

export class RoomHost {
  private httpServer: HttpServer | undefined;
  private io: Server | undefined;

  constructor(private readonly settings: RoomSettings) {}

  async start() {
    await this.stop();

    this.httpServer = createServer();
    this.io = new Server(this.httpServer, {
      cors: { origin: '*' }
    });

    this.io.on('connection', socket => {
      socket.on('viewer:join', (request: JoinRequest, ack) => {
        const allowed = this.canJoin(request);
        if (!allowed.ok) {
          ack?.(allowed);
          return;
        }

        socket.join(this.settings.roomName);
        ack?.({ ok: true, mode: this.settings.entryMode });
      });

      socket.on('host:motion', (frame: MotionFrame) => {
        socket.to(this.settings.roomName).emit('viewer:motion', {
          ...frame,
          timestamp: Date.now()
        });
      });
    });

    const port = Number(process.env.HAPTIC_ROOM_SERVER_PORT ?? 4174);
    await new Promise<void>(resolve => this.httpServer?.listen(port, resolve));

    return {
      roomName: this.settings.roomName,
      entryMode: this.settings.entryMode,
      relayUrl: `http://localhost:${port}`
    };
  }

  async stop() {
    this.io?.close();

    if (this.httpServer?.listening) {
      await new Promise<void>(resolve => this.httpServer?.close(() => resolve()));
    }

    this.io = undefined;
    this.httpServer = undefined;
    return { stopped: true };
  }

  private canJoin(request: JoinRequest) {
    if (request.roomName !== this.settings.roomName) {
      return { ok: false, reason: 'room-not-found' };
    }

    if (this.settings.password && request.password !== this.settings.password) {
      return { ok: false, reason: 'invalid-password' };
    }

    if (this.settings.entryMode === 'request') {
      return { ok: false, reason: 'approval-required' };
    }

    return { ok: true };
  }
}
