import { io, Socket } from 'socket.io-client';
import { performance } from 'node:perf_hooks';
import type { ApprovalRequest, MotionFrame, RoomDirectoryResponse, RoomSettings, ViewerSession } from '../protocol.js';
import { clamp01, maxHzToInterval, RELAY_MAX_HZ } from '../tuning.js';
import { decodeMotionPacket, encodeMotionPacket } from '../motion-packet.js';
import { MotionDelayBuffer } from './motion-delay-buffer.js';

export { MotionDelayBuffer } from './motion-delay-buffer.js';

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

export function normalizeOutgoingMotionFrame(frame: MotionFrame): MotionFrame {
  const normalized = {
    ...frame,
    intensity: clamp01(frame.intensity),
    position: clamp01(frame.position)
  };
  delete normalized.sequence;
  return normalized;
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
  private readonly incomingMotionDelayBuffer = new MotionDelayBuffer();
  private incomingMotionTimer: NodeJS.Timeout | undefined;
  private outgoingSequence = 0;
  private lifecycleGeneration = 0;
  private readonly lifecycleCancellationHandlers = new Set<() => void>();

  constructor(
    private readonly onMotion?: (frame: MotionFrame) => void,
    private readonly onApprovalRequest?: (request: ApprovalRequest) => void,
    private readonly onViewerStatus?: (status: ViewerStatus) => void,
    private readonly onViewerList?: (viewers: ViewerSession[]) => void,
    private readonly onEmergencyStop?: (signal: StopSignal) => void,
    private readonly onConnectionStatus?: (status: RelayConnectionStatus) => void
  ) {}

  async connect(relayUrl: string) {
    const generation = this.beginLifecycle();
    await this.connectForLifecycle(relayUrl, generation);
  }

  private async connectForLifecycle(relayUrl: string, generation: number) {
    this.assertLifecycleOwner(generation);

    this.relayUrl = relayUrl;
    const socket = io(relayUrl, {
      transports: ['websocket'],
      upgrade: false,
      reconnection: true,
      timeout: 5000
    });
    this.socket = socket;
    socket.on('connect', () => {
      if (this.socket !== socket) return;
      this.onConnectionStatus?.({ status: 'connected', role: this.session?.role, roomName: this.session?.roomName });
      if (this.session) void this.rejoinSession();
    });
    socket.io.on('reconnect_attempt', () => {
      if (this.socket !== socket) return;
      this.onConnectionStatus?.({ status: 'reconnecting', role: this.session?.role, roomName: this.session?.roomName });
    });
    socket.on('disconnect', reason => {
      if (this.socket !== socket) return;
      this.clearDelayedMotion();
      this.onConnectionStatus?.({ status: 'disconnected', role: this.session?.role, roomName: this.session?.roomName, reason });
    });
    socket.on('connect_error', error => {
      if (this.socket !== socket) return;
      this.onConnectionStatus?.({ status: 'error', role: this.session?.role, roomName: this.session?.roomName, reason: error.message });
    });
    socket.on('m', payload => {
      if (this.socket !== socket) return;
      try {
        const frame = decodeMotionPacket(payload);
        if (!this.incomingSequenceTracker.accept(frame)) return;
        for (const dueFrame of this.incomingMotionDelayBuffer.enqueue(frame, performance.now())) {
          this.onMotion?.(dueFrame);
        }
        this.scheduleDelayedMotion();
      } catch (error) {
        console.error('invalid relay motion packet', error);
      }
    });
    socket.on('viewer:approval-requested', request => {
      if (this.socket !== socket) return;
      this.onApprovalRequest?.(request);
    });
    socket.on('viewer:approved', response => {
      if (this.socket !== socket) return;
      if (this.session?.role === 'viewer') this.session.waitingForApproval = false;
      this.onViewerStatus?.({ roomName: response.roomName, status: 'approved' });
    });
    socket.on('viewer:rejected', response => {
      if (this.socket !== socket) return;
      this.clearDelayedMotion();
      this.session = undefined;
      this.roomName = '';
      this.incomingSequenceTracker.reset();
      this.onViewerStatus?.({ roomName: response.roomName, status: 'rejected', reason: response.reason });
    });
    socket.on('viewer:removed', response => {
      if (this.socket !== socket) return;
      this.clearDelayedMotion();
      this.roomName = '';
      this.session = undefined;
      this.incomingSequenceTracker.reset();
      this.onViewerStatus?.({ roomName: response.roomName, status: 'removed', reason: response.reason });
    });
    socket.on('room:viewers', viewers => {
      if (this.socket !== socket) return;
      this.onViewerList?.(viewers);
    });
    socket.on('room:stop', signal => {
      if (this.socket !== socket) return;
      this.clearBufferedMotion();
      this.incomingSequenceTracker.reset();
      this.outgoingSequence = 0;
      this.onEmergencyStop?.(signal);
    });

    await this.awaitLifecycle(new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    }), generation);
  }

  async createRoom(relayUrl: string, settings: RoomSettings) {
    const generation = this.beginLifecycle();
    const room = await this.awaitLifecycle(
      postJson<{ ok: true; roomName: string; relayUrl: string; hostToken: string; entryMode: string }>(`${relayUrl}/api/rooms`, settings),
      generation
    );
    await this.connectForLifecycle(room.relayUrl, generation);

    const response = await this.awaitLifecycle(this.emitWithAck('room:create', { token: room.hostToken }), generation);
    if (!response.ok) {
      throw new Error(response.reason ?? 'room-create-failed');
    }

    this.clearDelayedMotion();
    this.roomName = room.roomName;
    this.hostToken = room.hostToken;
    this.incomingSequenceTracker.reset();
    this.outgoingSequence = 0;
    this.session = {
      role: 'host',
      roomName: room.roomName,
      token: room.hostToken
    };
    void this.refreshViewers().catch(() => undefined);
    return {
      roomName: room.roomName,
      entryMode: room.entryMode,
      relayUrl: room.relayUrl
    };
  }

  async listRooms(relayUrl: string) {
    const directory = await getJson<RoomDirectoryResponse>(`${relayUrl}/api/rooms`);
    return directory.rooms;
  }

  async checkHealth(relayUrl: string) {
    const startedAt = Date.now();
    await getJson<{ ok: true }>(`${relayUrl}/healthz`, AbortSignal.timeout(4_000));
    return { online: true as const, latencyMs: Date.now() - startedAt };
  }

  async joinRoom(relayUrl: string, request: { displayName: string; roomName: string; password?: string }) {
    const generation = this.beginLifecycle();
    const encodedRoomName = encodeURIComponent(request.roomName);
    const join = await this.awaitLifecycle(
      postJson<{ ok: true; roomName: string; relayUrl: string; viewerToken: string }>(`${relayUrl}/api/rooms/${encodedRoomName}/join`, request),
      generation
    );
    await this.connectForLifecycle(join.relayUrl, generation);

    const response = await this.awaitLifecycle(this.emitWithAck('viewer:join', {
      displayName: request.displayName,
      token: join.viewerToken
    }), generation);
    if (!response.ok && response.reason !== 'approval-required') {
      throw new Error(response.reason ?? 'room-join-failed');
    }

    this.clearDelayedMotion();
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

    this.clearBufferedMotion();
    const response = await this.emitWithAck('room:stop', {});
    if (!response.ok) {
      return { sent: false, reason: response.reason ?? 'room-stop-failed' };
    }
    return { sent: true, roomName: response.roomName };
  }

  hasActiveRoom() {
    return Boolean(this.session && this.roomName);
  }

  publishMotion(frame: MotionFrame) {
    if (!this.socket?.connected || !this.roomName) {
      return { sent: false, reason: 'relay-not-connected' };
    }

    this.latestFrame = normalizeOutgoingMotionFrame(frame);
    this.scheduleFlush();
    return { queued: true };
  }

  getMotionSequenceStats() {
    return this.incomingSequenceTracker.snapshot();
  }

  setMotionDelay(delayMs: number) {
    const previousDelayMs = this.incomingMotionDelayBuffer.stats().motionDelayMs;
    const stats = this.incomingMotionDelayBuffer.setDelayMs(delayMs);
    if (stats.motionDelayMs !== previousDelayMs) this.clearDelayedMotionTimer();
    return stats;
  }

  getMotionDelayStats() {
    return this.incomingMotionDelayBuffer.stats();
  }

  clearBufferedMotion() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.clearDelayedMotion();
    this.latestFrame = undefined;
  }

  disconnect() {
    this.invalidateLifecycle();
    this.resetConnectionState();
    return { connected: false };
  }

  private async rejoinSession() {
    if (!this.socket?.connected || !this.session || this.rejoining) return;

    const socket = this.socket;
    const session = this.session;
    const generation = this.lifecycleGeneration;
    this.rejoining = true;
    try {
      if (session.role === 'host') {
        const response = await this.emitWithAck('room:create', { token: session.token });
        if (!this.ownsSession(generation, socket, session)) return;
        if (!response.ok) {
          this.endActiveRoom(session.roomName, response.reason ?? 'room-rejoin-failed');
          return;
        }

        this.clearDelayedMotion();
        this.roomName = session.roomName;
        this.hostToken = session.token;
        void this.refreshViewers().catch(() => undefined);
        this.onConnectionStatus?.({ status: 'rejoined', role: 'host', roomName: session.roomName });
        return;
      }

      const response = await this.emitWithAck('viewer:join', {
        displayName: session.displayName,
        token: session.token
      });
      if (!this.ownsSession(generation, socket, session)) return;
      if (!response.ok && response.reason !== 'approval-required') {
        this.endActiveRoom(session.roomName, response.reason ?? 'room-rejoin-failed');
        return;
      }

      this.clearDelayedMotion();
      this.roomName = session.roomName;
      session.waitingForApproval = response.reason === 'approval-required';
      this.onConnectionStatus?.({ status: 'rejoined', role: 'viewer', roomName: session.roomName, reason: response.reason });
    } catch (error) {
      if (!this.ownsSession(generation, socket, session)) return;
      this.onConnectionStatus?.({
        status: 'error',
        role: session.role,
        roomName: session.roomName,
        reason: error instanceof Error ? error.message : 'room-rejoin-failed'
      });
    } finally {
      if (generation === this.lifecycleGeneration && this.socket === socket) this.rejoining = false;
    }
  }

  private beginLifecycle() {
    this.invalidateLifecycle();
    this.resetConnectionState();
    return this.lifecycleGeneration;
  }

  private invalidateLifecycle() {
    this.lifecycleGeneration += 1;
    for (const cancel of this.lifecycleCancellationHandlers) cancel();
    this.lifecycleCancellationHandlers.clear();
  }

  private async awaitLifecycle<T>(operation: Promise<T>, generation: number) {
    this.assertLifecycleOwner(generation);
    let cancel: () => void = () => undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new Error('relay-lifecycle-cancelled'));
      this.lifecycleCancellationHandlers.add(cancel);
    });
    try {
      const result = await Promise.race([operation, cancellation]);
      this.assertLifecycleOwner(generation);
      return result;
    } catch (error) {
      this.assertLifecycleOwner(generation);
      throw error;
    } finally {
      this.lifecycleCancellationHandlers.delete(cancel);
    }
  }

  private assertLifecycleOwner(generation: number) {
    if (generation !== this.lifecycleGeneration) throw new Error('relay-lifecycle-cancelled');
  }

  private ownsSession(generation: number, socket: Socket, session: RelaySession) {
    return generation === this.lifecycleGeneration && this.socket === socket && this.session === session;
  }

  private endActiveRoom(roomName: string, reason: string) {
    this.clearActiveRoomState();
    this.onViewerStatus?.({ roomName, status: 'removed', reason });
  }

  private clearActiveRoomState() {
    this.clearBufferedMotion();
    this.roomName = '';
    this.hostToken = '';
    this.session = undefined;
    this.incomingSequenceTracker.reset();
    this.outgoingSequence = 0;
  }

  private resetConnectionState() {
    const socket = this.socket;
    this.socket = undefined;
    socket?.disconnect();
    this.clearActiveRoomState();
    this.relayUrl = '';
    this.rejoining = false;
  }

  private scheduleFlush() {
    if (this.flushTimer) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushLatest();
    }, this.minIntervalMs);
  }

  private scheduleDelayedMotion() {
    if (this.incomingMotionTimer) return;
    const waitMs = this.incomingMotionDelayBuffer.nextWaitMs(performance.now());
    if (waitMs === undefined) return;

    const timer = setTimeout(() => {
      if (this.incomingMotionTimer !== timer) return;
      this.incomingMotionTimer = undefined;
      for (const dueFrame of this.incomingMotionDelayBuffer.drain(performance.now())) {
        this.onMotion?.(dueFrame);
      }
      this.scheduleDelayedMotion();
    }, waitMs);
    this.incomingMotionTimer = timer;
  }

  private clearDelayedMotion() {
    this.clearDelayedMotionTimer();
    this.incomingMotionDelayBuffer.clear();
  }

  private clearDelayedMotionTimer() {
    if (this.incomingMotionTimer) {
      clearTimeout(this.incomingMotionTimer);
      this.incomingMotionTimer = undefined;
    }
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

async function getJson<T>(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal });
  const payload = await response.json() as T & { ok?: boolean; reason?: string };
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.reason ?? `request-failed:${response.status}`);
  }
  return payload as T;
}
