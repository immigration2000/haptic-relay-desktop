import { io, Socket } from 'socket.io-client';
import type { MotionFrame, RoomSettings } from '../protocol.js';

export class RelayClient {
  private socket: Socket | undefined;
  private roomName = '';

  async connect(relayUrl: string) {
    if (this.socket?.connected) return;

    this.socket = io(relayUrl, {
      transports: ['websocket'],
      reconnection: true,
      timeout: 5000
    });

    await new Promise<void>((resolve, reject) => {
      this.socket?.once('connect', resolve);
      this.socket?.once('connect_error', reject);
    });
  }

  async createRoom(relayUrl: string, settings: RoomSettings) {
    await this.connect(relayUrl);

    const response = await this.emitWithAck('room:create', settings);
    if (!response.ok) {
      throw new Error(response.reason ?? 'room-create-failed');
    }

    this.roomName = settings.roomName;
    return {
      roomName: settings.roomName,
      entryMode: settings.entryMode,
      relayUrl
    };
  }

  async joinRoom(relayUrl: string, request: { displayName: string; roomName: string; password?: string }) {
    await this.connect(relayUrl);

    const response = await this.emitWithAck('viewer:join', request);
    if (!response.ok) {
      throw new Error(response.reason ?? 'room-join-failed');
    }

    this.roomName = request.roomName;
    return response;
  }

  publishMotion(frame: MotionFrame) {
    if (!this.socket?.connected || !this.roomName) {
      return { sent: false, reason: 'relay-not-connected' };
    }

    this.socket.emit('host:motion', {
      ...frame,
      roomName: this.roomName
    });
    return { sent: true };
  }

  disconnect() {
    this.socket?.disconnect();
    this.socket = undefined;
    this.roomName = '';
    return { connected: false };
  }

  private emitWithAck(eventName: string, payload: unknown) {
    return new Promise<{ ok: boolean; reason?: string; [key: string]: unknown }>((resolve, reject) => {
      this.socket?.timeout(5000).emit(eventName, payload, (error: Error | null, response: { ok: boolean; reason?: string }) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(response);
      });
    });
  }
}
