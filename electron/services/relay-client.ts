import { io, Socket } from 'socket.io-client';
import type { MotionFrame, RoomSettings } from '../protocol.js';
import { clamp01, maxHzToInterval, RELAY_MAX_HZ } from '../tuning.js';

export class RelayClient {
  private socket: Socket | undefined;
  private roomName = '';
  private relayUrl = '';
  private latestFrame: MotionFrame | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private readonly minIntervalMs = maxHzToInterval(RELAY_MAX_HZ);

  async connect(relayUrl: string) {
    if (this.socket?.connected && this.relayUrl === relayUrl) return;
    this.disconnect();

    this.relayUrl = relayUrl;
    this.socket = io(relayUrl, {
      transports: ['websocket'],
      upgrade: false,
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

    this.latestFrame = {
      intensity: clamp01(frame.intensity),
      position: clamp01(frame.position),
      timestamp: frame.timestamp
    };
    this.scheduleFlush();
    return { queued: true };
  }

  disconnect() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.socket?.disconnect();
    this.socket = undefined;
    this.roomName = '';
    this.relayUrl = '';
    this.latestFrame = undefined;
    return { connected: false };
  }

  private scheduleFlush() {
    if (this.flushTimer) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushLatest();
    }, this.minIntervalMs);
  }

  private flushLatest() {
    if (!this.socket?.connected || !this.roomName || !this.latestFrame) return;

    const frame = this.latestFrame;
    this.latestFrame = undefined;
    this.socket.volatile.compress(false).emit('host:motion', {
      ...frame,
      roomName: this.roomName
    });
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
