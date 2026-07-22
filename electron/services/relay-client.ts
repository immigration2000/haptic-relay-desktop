import { io, Socket } from 'socket.io-client';
import type { MotionFrame, RoomSettings } from '../protocol.js';
import { clamp01, maxHzToInterval, RELAY_MAX_HZ } from '../tuning.js';
import { decodeMotionPacket, encodeMotionPacket } from '../motion-packet.js';

export class RelayClient {
  private socket: Socket | undefined;
  private roomName = '';
  private relayUrl = '';
  private hostToken = '';
  private latestFrame: MotionFrame | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private readonly minIntervalMs = maxHzToInterval(RELAY_MAX_HZ);

  constructor(private readonly onMotion?: (frame: MotionFrame) => void) {}

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
    this.socket.on('m', payload => {
      try {
        this.onMotion?.(decodeMotionPacket(payload));
      } catch (error) {
        console.error('invalid relay motion packet', error);
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.socket?.once('connect', resolve);
      this.socket?.once('connect_error', reject);
    });
  }

  async createRoom(relayUrl: string, settings: RoomSettings) {
    const room = await postJson<{ ok: true; roomName: string; relayUrl: string; hostToken: string; entryMode: string }>(`${relayUrl}/api/rooms`, settings);
    await this.connect(room.relayUrl);

    const response = await this.emitWithAck('room:create', { token: room.hostToken });
    if (!response.ok) {
      throw new Error(response.reason ?? 'room-create-failed');
    }

    this.roomName = room.roomName;
    this.hostToken = room.hostToken;
    return {
      roomName: room.roomName,
      entryMode: room.entryMode,
      relayUrl: room.relayUrl
    };
  }

  async joinRoom(relayUrl: string, request: { displayName: string; roomName: string; password?: string }) {
    const encodedRoomName = encodeURIComponent(request.roomName);
    const join = await postJson<{ ok: true; roomName: string; relayUrl: string; viewerToken: string }>(`${relayUrl}/api/rooms/${encodedRoomName}/join`, request);
    await this.connect(join.relayUrl);

    const response = await this.emitWithAck('viewer:join', {
      displayName: request.displayName,
      token: join.viewerToken
    });
    if (!response.ok) {
      throw new Error(response.reason ?? 'room-join-failed');
    }

    this.roomName = join.roomName;
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
    this.hostToken = '';
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
    this.socket.volatile.compress(false).emit('m', encodeMotionPacket(frame));
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

async function postJson<T>(url: string, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json() as T & { ok?: boolean; reason?: string };
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.reason ?? `request-failed:${response.status}`);
  }
  return payload as T;
}
