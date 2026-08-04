import { io, Socket } from 'socket.io-client';
import type { ApprovalRequest, MotionFrame, RoomSettings, ViewerSession } from '../protocol.js';
import { clamp01, maxHzToInterval, RELAY_MAX_HZ } from '../tuning.js';
import { decodeMotionPacket, encodeMotionPacket } from '../motion-packet.js';

type ViewerStatus = {
  roomName: string;
  status: 'approved' | 'rejected' | 'removed';
  reason?: string;
};

type StopSignal = {
  roomName: string;
  timestamp: number;
};

type RelayConnectionStatus = {
  status: 'connected' | 'disconnected' | 'reconnecting' | 'rejoined' | 'error';
  role?: 'host' | 'viewer';
  roomName?: string;
  reason?: string;
};

type HostSession = {
  role: 'host';
  roomName: string;
  token: string;
};

type ViewerSessionState = {
  role: 'viewer';
  roomName: string;
  displayName: string;
  token: string;
  waitingForApproval: boolean;
};

type RelaySession = HostSession | ViewerSessionState;

export type MotionSequenceStats = {
  receivedFrames: number;
  acceptedFrames: number;
  duplicateFrames: number;
  outOfOrderFrames: number;
  lostFrames: number;
  lastSequence?: number;
};

export class MotionSequenceTracker {
  private stats: MotionSequenceStats = emptyMotionSequenceStats();

  accept(frame: MotionFrame) {
    this.stats.receivedFrames += 1;

    if (frame.protocolVersion !== 2 || frame.sequence === undefined) {
      this.stats.acceptedFrames += 1;
      return true;
    }

    const sequence = frame.sequence >>> 0;
    if (this.stats.lastSequence === undefined) {
      this.stats.lastSequence = sequence;
      this.stats.acceptedFrames += 1;
      return true;
    }

    const forwardDistance = (sequence - this.stats.lastSequence) >>> 0;
    if (forwardDistance === 0) {
      this.stats.duplicateFrames += 1;
      return false;
    }
    if (forwardDistance >= 0x8000_0000) {
      this.stats.outOfOrderFrames += 1;
      return false;
    }

    this.stats.lostFrames += forwardDistance - 1;
    this.stats.lastSequence = sequence;
    this.stats.acceptedFrames += 1;
    return true;
  }

  snapshot(): MotionSequenceStats {
    return { ...this.stats };
  }

  reset() {
    this.stats = emptyMotionSequenceStats();
  }
}

export function nextMotionSequence(sequence: number) {
  return (sequence + 1) >>> 0;
}

function emptyMotionSequenceStats(): MotionSequenceStats {
  return {
    receivedFrames: 0,
    acceptedFrames: 0,
    duplicateFrames: 0,
    outOfOrderFrames: 0,
    lostFrames: 0,
    lastSequence: undefined
  };
}

export class RelayClient {
  private socket: Socket | undefined;
  private roomName = '';
  private relayUrl = '';
  private hostToken = '';
  private session: RelaySession | undefined;
  private rejoining = false;
  private latestFrame: MotionFrame | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private readonly minIntervalMs = maxHzToInterval(RELAY_MAX_HZ);
  private readonly incomingSequenceTracker = new MotionSequenceTracker();
  private outgoingSequence = 0;

  constructor(
    private readonly onMotion?: (frame: MotionFrame) => void,
    private readonly onApprovalRequest?: (request: ApprovalRequest) => void,
    private readonly onViewerStatus?: (status: ViewerStatus) => void,
    private readonly onViewerList?: (viewers: ViewerSession[]) => void,
    private readonly onEmergencyStop?: (signal: StopSignal) => void,
    private readonly onConnectionStatus?: (status: RelayConnectionStatus) => void
  ) {}

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
    this.socket.on('connect', () => {
      this.onConnectionStatus?.({ status: 'connected', role: this.session?.role, roomName: this.session?.roomName });
      if (this.session) void this.rejoinSession();
    });
    this.socket.io.on('reconnect_attempt', () => {
      this.onConnectionStatus?.({ status: 'reconnecting', role: this.session?.role, roomName: this.session?.roomName });
    });
    this.socket.on('disconnect', reason => {
      this.onConnectionStatus?.({ status: 'disconnected', role: this.session?.role, roomName: this.session?.roomName, reason });
    });
    this.socket.on('connect_error', error => {
      this.onConnectionStatus?.({ status: 'error', role: this.session?.role, roomName: this.session?.roomName, reason: error.message });
    });
    this.socket.on('m', payload => {
      try {
        const frame = decodeMotionPacket(payload);
        if (this.incomingSequenceTracker.accept(frame)) this.onMotion?.(frame);
      } catch (error) {
        console.error('invalid relay motion packet', error);
      }
    });
    this.socket.on('viewer:approval-requested', request => {
      this.onApprovalRequest?.(request);
    });
    this.socket.on('viewer:approved', response => {
      if (this.session?.role === 'viewer') this.session.waitingForApproval = false;
      this.onViewerStatus?.({ roomName: response.roomName, status: 'approved' });
    });
    this.socket.on('viewer:rejected', response => {
      this.session = undefined;
      this.roomName = '';
      this.incomingSequenceTracker.reset();
      this.onViewerStatus?.({ roomName: response.roomName, status: 'rejected', reason: response.reason });
    });
    this.socket.on('viewer:removed', response => {
      this.roomName = '';
      this.session = undefined;
      this.incomingSequenceTracker.reset();
      this.onViewerStatus?.({ roomName: response.roomName, status: 'removed', reason: response.reason });
    });
    this.socket.on('room:viewers', viewers => {
      this.onViewerList?.(viewers);
    });
    this.socket.on('room:stop', signal => {
      this.latestFrame = undefined;
      this.incomingSequenceTracker.reset();
      this.outgoingSequence = 0;
      this.onEmergencyStop?.(signal);
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
    this.incomingSequenceTracker.reset();
    this.outgoingSequence = 0;
    this.session = {
      role: 'host',
      roomName: room.roomName,
      token: room.hostToken
    };
    void this.refreshViewers();
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
    if (!response.ok && response.reason !== 'approval-required') {
      throw new Error(response.reason ?? 'room-join-failed');
    }

    this.roomName = join.roomName;
    this.incomingSequenceTracker.reset();
    this.session = {
      role: 'viewer',
      roomName: join.roomName,
      displayName: request.displayName,
      token: join.viewerToken,
      waitingForApproval: response.reason === 'approval-required'
    };
    return response;
  }

  async approveViewer(socketId: string, approved: boolean) {
    const response = await this.emitWithAck('viewer:approve', { socketId, approved });
    if (!response.ok) {
      throw new Error(response.reason ?? 'viewer-approval-failed');
    }
    return response;
  }

  async moderateViewer(socketId: string, action: 'kick' | 'block') {
    const response = await this.emitWithAck('viewer:moderate', { socketId, action });
    if (!response.ok) {
      throw new Error(response.reason ?? 'viewer-moderation-failed');
    }
    return response;
  }

  async refreshViewers() {
    if (!this.socket?.connected) return [];
    const response = await this.emitWithAck('room:viewers', {});
    if (!response.ok) {
      throw new Error(response.reason ?? 'viewer-list-failed');
    }
    const viewers = Array.isArray(response.viewers) ? response.viewers as ViewerSession[] : [];
    this.onViewerList?.(viewers);
    return viewers;
  }

  async emergencyStop() {
    if (!this.socket?.connected || !this.roomName) {
      return { sent: false, reason: 'relay-not-connected' };
    }

    const response = await this.emitWithAck('room:stop', {});
    if (!response.ok) {
      return { sent: false, reason: response.reason ?? 'room-stop-failed' };
    }
    this.latestFrame = undefined;
    return { sent: true, roomName: response.roomName };
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

  getMotionSequenceStats() {
    return this.incomingSequenceTracker.snapshot();
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
    this.session = undefined;
    this.rejoining = false;
    this.latestFrame = undefined;
    this.incomingSequenceTracker.reset();
    this.outgoingSequence = 0;
    return { connected: false };
  }

  private async rejoinSession() {
    if (!this.socket?.connected || !this.session || this.rejoining) return;

    this.rejoining = true;
    try {
      if (this.session.role === 'host') {
        const response = await this.emitWithAck('room:create', { token: this.session.token });
        if (!response.ok) throw new Error(response.reason ?? 'room-rejoin-failed');

        this.roomName = this.session.roomName;
        this.hostToken = this.session.token;
        void this.refreshViewers();
        this.onConnectionStatus?.({ status: 'rejoined', role: 'host', roomName: this.session.roomName });
        return;
      }

      const response = await this.emitWithAck('viewer:join', {
        displayName: this.session.displayName,
        token: this.session.token
      });
      if (!response.ok && response.reason !== 'approval-required') throw new Error(response.reason ?? 'room-rejoin-failed');

      this.roomName = this.session.roomName;
      this.session.waitingForApproval = response.reason === 'approval-required';
      this.onConnectionStatus?.({ status: 'rejoined', role: 'viewer', roomName: this.session.roomName, reason: response.reason });
    } catch (error) {
      this.onConnectionStatus?.({
        status: 'error',
        role: this.session.role,
        roomName: this.session.roomName,
        reason: error instanceof Error ? error.message : 'room-rejoin-failed'
      });
    } finally {
      this.rejoining = false;
    }
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
    this.socket.volatile.compress(false).emit('m', encodeMotionPacket({
      ...frame,
      protocolVersion: 2,
      sequence: this.outgoingSequence,
      sourceTimeMs: frame.sourceTimeMs ?? frame.timestamp,
      durationMs: frame.durationMs ?? this.minIntervalMs
    }));
    this.outgoingSequence = nextMotionSequence(this.outgoingSequence);
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
