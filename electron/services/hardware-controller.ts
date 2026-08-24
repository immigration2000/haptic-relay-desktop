import { SerialPort } from 'serialport';
import type {
  HardwareConnectionStatus,
  HardwareOutputSnapshot,
  HardwareProfile,
  HardwareProtection,
  MotionFrame
} from '../protocol.js';
import {
  clamp01,
  HARDWARE_MAX_HZ,
  maxHzToInterval,
  TCODE_INTERVAL_MS,
  TCODE_LINEAR_AXIS,
  TCODE_VIBRATION_AXIS
} from '../tuning.js';
import { encodeTCodeMotion, encodeTCodeProbe, encodeTCodeStop, parseTCodeProbe } from './tcode-encoder.js';
import type { TCodeProbeResult } from './tcode-encoder.js';

const TCODE_PROBE_TIMEOUT_MS = 350;
const HARDWARE_WRITE_TIMEOUT_MS = 500;
const HARDWARE_LIFECYCLE_TIMEOUT_MS = 500;
const HARDWARE_TEST_STEP_DELAY_MS = 180;
const HARDWARE_TEST_POSITIONS = [0.2, 0.5, 0.8, 0.5];
const DEFAULT_HARDWARE_PROFILE: HardwareProfile = {
  baudRate: 115200,
  linearAxis: TCODE_LINEAR_AXIS,
  vibrationAxis: TCODE_VIBRATION_AXIS,
  strokeMin: 0,
  strokeMax: 1,
  stopPosition: 0,
  invertPosition: false
};
const DEFAULT_HARDWARE_PROTECTION: HardwareProtection = {
  intensityLimit: 1,
  positionMin: 0,
  positionMax: 1,
  paused: false
};

type HardwareLog = {
  level: 'info' | 'warning' | 'error';
  source: 'hardware' | 'protection';
  message: string;
  details?: string;
};

export type HardwareDiagnosticEvent = {
  timestamp: number;
  level: 'info' | 'warning' | 'error';
  source: 'hardware' | 'protection';
  event: string;
  data: Record<string, unknown>;
};

type PortIdentity = {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  locationId?: string;
  productId?: string;
  vendorId?: string;
};

type WriteOperation = 'probe' | 'test' | 'stop' | 'motion';

type HardwarePort = Pick<SerialPort, 'path' | 'isOpen' | 'open' | 'close' | 'write' | 'once' | 'on' | 'off'>;

type HardwareControllerOptions = {
  onLog?: (entry: HardwareLog) => void;
  onDiagnostic?: (event: HardwareDiagnosticEvent) => void;
  onOutput?: (snapshot: HardwareOutputSnapshot) => void;
  onConnectionStatus?: (status: HardwareConnectionStatus) => void;
  createPort?: (options: { path: string; baudRate: number; autoOpen: false }) => HardwarePort;
  listPorts?: () => Promise<PortIdentity[]>;
  now?: () => number;
  probeTimeoutMs?: number;
  writeTimeoutMs?: number;
  lifecycleTimeoutMs?: number;
};

type ActiveWrite = {
  port: HardwarePort;
  fail: (error: Error) => void;
};

type HardwareConnectResult = {
  connected: true;
  path: string;
  baudRate: number;
  profile: HardwareProfile;
  probe: TCodeProbeResult;
};

type LifecycleGate = {
  id: number;
  kind: 'disconnect' | 'room-exit';
};

type LifecycleBlockReason = 'hardware-disconnecting' | 'hardware-room-exit-stopping';

type ActiveTestPattern = {
  cancellationReason?: LifecycleBlockReason;
};

type PendingCloseRecord = {
  token: symbol;
  port: HardwarePort;
  role: 'owned' | 'failed' | 'stale';
  errorHandler: ((error: Error) => void) | undefined;
  closeHandler: (() => void) | undefined;
  timedOut: boolean;
  callbackSettled: boolean;
  physicalCloseObserved: boolean;
};

type StalePortRecord = {
  token: symbol;
  port: HardwarePort;
  errorSink: (error: Error) => void;
  cleanup: Promise<void> | undefined;
};

export class HardwareController {
  private port: HardwarePort | undefined;
  private failedPort: HardwarePort | undefined;
  private failedPortCleanup: Promise<void> | undefined;
  private readonly options: HardwareControllerOptions;
  private profile = DEFAULT_HARDWARE_PROFILE;
  private protection = DEFAULT_HARDWARE_PROTECTION;
  private latestFrame: MotionFrame | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private writing = false;
  private readonly portErrorHandlers = new Map<HardwarePort, (error: Error) => void>();
  private readonly portCloseHandlers = new Map<HardwarePort, () => void>();
  private readonly activeWrites = new Set<ActiveWrite>();
  private readonly pendingCloseRecords = new Map<symbol, PendingCloseRecord>();
  private readonly stalePorts = new Map<HardwarePort, StalePortRecord>();
  private readonly minIntervalMs = maxHzToInterval(HARDWARE_MAX_HZ);
  private readonly writeTimeoutMs: number;
  private readonly lifecycleTimeoutMs: number;
  private connectionStatus: HardwareConnectionStatus = { connected: false };
  private emergencyStopped = false;
  private lifecycleTransition: 'disconnect' | 'room-exit' | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private lifecycleRequestId = 0;
  private lastLifecycleRequestId = 0;
  private lifecycleGates: LifecycleGate[] = [];
  private readonly activeTestPatterns = new Set<ActiveTestPattern>();
  private connectOperation: { id: number; key: string; promise: Promise<HardwareConnectResult> } | undefined;
  private disconnectOperation: { id: number; promise: Promise<{ connected: false }> } | undefined;
  private roomExitOperation: { id: number; promise: Promise<{ stopped: boolean; reason?: string }> } | undefined;
  private operationGeneration = 0;

  constructor(options: HardwareControllerOptions | HardwareControllerOptions['onLog'] = {}) {
    this.options = typeof options === 'function' ? { onLog: options } : options;
    this.writeTimeoutMs = normalizeWriteTimeoutMs(this.options.writeTimeoutMs);
    this.lifecycleTimeoutMs = normalizeLifecycleTimeoutMs(this.options.lifecycleTimeoutMs);
  }

  async listPorts() {
    return (this.options.listPorts ?? SerialPort.list)();
  }

  connect(pathName: string, profile: HardwareProfile = DEFAULT_HARDWARE_PROFILE): Promise<HardwareConnectResult> {
    const normalizedProfile = normalizeProfile(profile);
    const key = `${pathName}\0${JSON.stringify(normalizedProfile)}`;
    const activeOperation = this.connectOperation;
    if (
      activeOperation
      && activeOperation.id === this.lastLifecycleRequestId
      && activeOperation.key === key
    ) {
      return activeOperation.promise;
    }

    const precedingDisconnect = this.disconnectOperation?.id === this.lastLifecycleRequestId
      ? this.disconnectOperation.promise
      : undefined;
    const id = ++this.lifecycleRequestId;
    this.lastLifecycleRequestId = id;
    const operation = this.enqueueLifecycle(async () => {
      if (precedingDisconnect) await precedingDisconnect;
      return this.performConnect(pathName, normalizedProfile);
    });
    this.connectOperation = { id, key, promise: operation };
    operation.then(
      () => {
        if (this.connectOperation?.promise === operation) this.connectOperation = undefined;
      },
      () => {
        if (this.connectOperation?.promise === operation) this.connectOperation = undefined;
      }
    );
    return operation;
  }

  private async performConnect(pathName: string, profile: HardwareProfile): Promise<HardwareConnectResult> {
    await this.performDisconnect();
    this.profile = profile;
    this.emitDiagnostic('info', 'hardware', 'hardware-connect-requested', {
      portPath: pathName,
      baudRate: profile.baudRate,
      linearAxis: profile.linearAxis,
      vibrationAxis: profile.vibrationAxis,
      strokeMin: profile.strokeMin,
      strokeMax: profile.strokeMax,
      stopPosition: profile.stopPosition,
      invertPosition: profile.invertPosition
    });
    await this.reportPortIdentity(pathName);

    const createPort = this.options.createPort ?? (options => new SerialPort(options));
    const port = createPort({
      path: pathName,
      baudRate: this.profile.baudRate,
      autoOpen: false
    });
    this.port = port;
    this.attachPortErrorHandler(port);

    try {
      await this.openPort(port);
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error('hardware-open-failed');
      this.failPort(port, normalizedError, 'hardware-open-failed');
      throw normalizedError;
    }

    const probe = await this.probeTCodeCapabilities();
    this.reportConnectionStatus({ connected: true, path: pathName });
    this.options.onLog?.({ level: 'info', source: 'hardware', message: 'hardware-connected', details: `${pathName} @ ${this.profile.baudRate}` });
    return { connected: true as const, path: pathName, baudRate: this.profile.baudRate, profile: this.profile, probe };
  }

  getConnectionStatus(): HardwareConnectionStatus {
    return { ...this.connectionStatus };
  }

  getEmergencyStopState() {
    return { emergencyStopped: this.emergencyStopped };
  }

  async setProtection(protection: HardwareProtection) {
    this.protection = normalizeProtection(protection);
    if (this.protection.paused) {
      this.options.onLog?.({ level: 'warning', source: 'protection', message: 'receive-paused' });
    } else {
      this.options.onLog?.({ level: 'info', source: 'protection', message: 'protection-updated', details: `intensity<=${this.protection.intensityLimit.toFixed(2)}, position ${this.protection.positionMin.toFixed(2)}-${this.protection.positionMax.toFixed(2)}` });
    }

    return { protection: this.protection };
  }

  stopForRoomExit() {
    const activeOperation = this.roomExitOperation;
    if (activeOperation?.id === this.lastLifecycleRequestId) return activeOperation.promise;

    const id = ++this.lifecycleRequestId;
    this.lastLifecycleRequestId = id;
    this.lifecycleGates.push({ id, kind: 'room-exit' });
    this.interruptOutputForLifecycle();
    const operation = this.enqueueLifecycle(() => this.performRoomExitStop());
    this.roomExitOperation = { id, promise: operation };
    operation.then(
      () => {
        this.completeRoomExitOperation(id, operation);
      },
      () => {
        this.completeRoomExitOperation(id, operation);
      }
    );
    return operation;
  }

  private async performRoomExitStop() {
    this.lifecycleTransition = 'room-exit';
    try {
      const result = await this.writeStopPayload();
      this.emitDiagnostic(result.stopped ? 'info' : 'error', 'hardware', 'room-exit-stop', { ...result });
      return result;
    } finally {
      if (this.lifecycleTransition === 'room-exit') this.lifecycleTransition = undefined;
    }
  }

  disconnect() {
    const activeOperation = this.disconnectOperation;
    if (activeOperation?.id === this.lastLifecycleRequestId) return activeOperation.promise;

    const id = ++this.lifecycleRequestId;
    this.lastLifecycleRequestId = id;
    this.lifecycleGates.push({ id, kind: 'disconnect' });
    this.interruptOutputForLifecycle();
    const operation = this.enqueueLifecycle(() => this.performDisconnect());
    this.disconnectOperation = { id, promise: operation };
    operation.then(
      () => {
        this.completeDisconnectOperation(id, operation);
      },
      () => {
        this.completeDisconnectOperation(id, operation);
      }
    );
    return operation;
  }

  private async performDisconnect() {
    this.lifecycleTransition = 'disconnect';
    const hadConnection = Boolean(this.port || this.failedPort || this.connectionStatus.connected);
    try {
      this.operationGeneration += 1;
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
      }
      this.latestFrame = undefined;

      const port = this.port;
      if (!port?.isOpen) {
        if (port) {
          if (this.findPendingClose(port)) throw new Error('hardware-close-timeout');
          this.detachPortErrorHandler(port);
          this.detachPortCloseHandler(port);
        }
        this.port = undefined;
        await this.retryFailedPortCleanup();
        await this.cleanupStalePorts();
        this.reportConnectionStatus({ connected: false, reason: 'hardware-disconnected', unexpected: false });
        if (hadConnection) {
          this.emitDiagnostic('info', 'hardware', 'hardware-disconnected', { unexpected: false });
        }
        return { connected: false as const };
      }

      this.port = undefined;
      this.failActiveWrites(port, new Error('hardware-disconnected'));
      const errorHandler = this.portErrorHandlers.get(port);
      const closeHandler = this.portCloseHandlers.get(port);
      try {
        await this.closePort(port, 'owned');
      } catch (error) {
        if (isLifecycleCloseTimeout(error)) {
          this.ensurePortHandlers(port, errorHandler, closeHandler);
          if (!this.port) this.port = port;
          throw error;
        }
        if (port.isOpen) {
          if (!this.port) this.port = port;
          throw error;
        }
      }
      this.schedulePortHandlersDetach(port, errorHandler, closeHandler);
      this.reportConnectionStatus({ connected: false, reason: 'hardware-disconnected', unexpected: false });
      await this.retryFailedPortCleanup();
      await this.cleanupStalePorts();
      this.options.onLog?.({ level: 'info', source: 'hardware', message: 'hardware-disconnected' });
      this.emitDiagnostic('info', 'hardware', 'hardware-disconnected', { unexpected: false });
      return { connected: false as const };
    } finally {
      if (this.lifecycleTransition === 'disconnect') this.lifecycleTransition = undefined;
    }
  }

  private enqueueLifecycle<T>(run: () => Promise<T>) {
    const operation = this.lifecycleTail.then(run, run);
    this.lifecycleTail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private completeDisconnectOperation(id: number, operation: Promise<{ connected: false }>) {
    if (this.disconnectOperation?.promise === operation) this.disconnectOperation = undefined;
    this.lifecycleGates = this.lifecycleGates.filter(gate => gate.id !== id);
  }

  private completeRoomExitOperation(
    id: number,
    operation: Promise<{ stopped: boolean; reason?: string }>
  ) {
    if (this.roomExitOperation?.promise === operation) this.roomExitOperation = undefined;
    this.lifecycleGates = this.lifecycleGates.filter(gate => gate.id !== id);
  }

  private interruptOutputForLifecycle() {
    this.operationGeneration += 1;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.latestFrame = undefined;

    const reason = this.getLifecycleBlockReason();
    if (!reason) return;
    for (const pattern of this.activeTestPatterns) pattern.cancellationReason = reason;
  }

  private getLifecycleBlockReason(): LifecycleBlockReason | undefined {
    if (
      this.lifecycleTransition === 'room-exit'
      || this.lifecycleGates.some(gate => gate.kind === 'room-exit')
    ) {
      return 'hardware-room-exit-stopping';
    }
    if (
      this.lifecycleTransition === 'disconnect'
      || this.lifecycleGates.some(gate => gate.kind === 'disconnect')
    ) {
      return 'hardware-disconnecting';
    }
    return undefined;
  }

  queueMotion(frame: MotionFrame) {
    const lifecycleBlockReason = this.getLifecycleBlockReason();
    if (lifecycleBlockReason) {
      this.reportDroppedMotion(frame, lifecycleBlockReason);
      return { queued: false, reason: lifecycleBlockReason };
    }
    if (this.emergencyStopped) {
      this.reportDroppedMotion(frame, 'hardware-emergency-stopped');
      return { queued: false, reason: 'hardware-emergency-stopped' };
    }

    if (!this.port?.isOpen) {
      this.reportDroppedMotion(frame, 'hardware-not-connected');
      return { queued: false, reason: 'hardware-not-connected' };
    }

    const protectedFrame = applyProtection(frame, this.protection);
    if (!protectedFrame) {
      this.latestFrame = undefined;
      this.options.onLog?.({ level: 'warning', source: 'protection', message: 'motion-dropped-paused' });
      this.reportDroppedMotion(frame, 'protection-paused');
      return { queued: false, reason: 'protection-paused' };
    }

    this.operationGeneration += 1;
    this.latestFrame = protectedFrame;
    this.scheduleFlush();
    return { queued: true };
  }

  async latchEmergencyStop() {
    this.emergencyStopped = true;
    this.emitDiagnostic('warning', 'hardware', 'emergency-latched', { emergencyStopped: true });
    const result = await this.writeStopPayload();
    return { ...result, emergencyStopped: this.emergencyStopped };
  }

  releaseEmergencyStop() {
    this.emergencyStopped = false;
    this.options.onLog?.({ level: 'info', source: 'hardware', message: 'hardware-emergency-released' });
    this.emitDiagnostic('info', 'hardware', 'emergency-released', { emergencyStopped: false });
    return { emergencyStopped: false };
  }

  private async writeStopPayload() {
    this.operationGeneration += 1;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.latestFrame = undefined;

    if (!this.port?.isOpen) {
      return { stopped: false, reason: 'hardware-not-connected' };
    }

    const payload = encodeTCodeStop({
      linearAxis: this.profile.linearAxis,
      vibrationAxis: this.profile.vibrationAxis,
      stopPosition: this.profile.stopPosition
    });

    const writeError = await this.writePayload(payload, 'stop').then(() => {
      this.reportOutput('stop', payload);
      return undefined;
    }).catch(error => {
      console.error('hardware stop failed', error);
      this.options.onLog?.({ level: 'error', source: 'hardware', message: 'hardware-stop-write-failed', details: formatError(error) });
      return error;
    });

    if (writeError) {
      return { stopped: false, reason: 'hardware-stop-write-failed' };
    }

    this.options.onLog?.({ level: 'warning', source: 'hardware', message: 'hardware-stopped' });
    return { stopped: true };
  }

  async runTestPattern() {
    const lifecycleBlockReason = this.getLifecycleBlockReason();
    if (lifecycleBlockReason) {
      return { tested: false, reason: lifecycleBlockReason };
    }
    if (this.emergencyStopped) {
      return { tested: false, reason: 'hardware-emergency-stopped' };
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.latestFrame = undefined;

    if (!this.port?.isOpen) {
      return { tested: false, reason: 'hardware-not-connected' };
    }

    const activePattern: ActiveTestPattern = {};
    this.activeTestPatterns.add(activePattern);
    const operationGeneration = ++this.operationGeneration;
    const cancellationResult = () => {
      if (activePattern.cancellationReason) {
        return { tested: false as const, reason: activePattern.cancellationReason };
      }
      if (operationGeneration !== this.operationGeneration) {
        return { tested: false as const, reason: 'hardware-test-cancelled' };
      }
      return undefined;
    };
    this.options.onLog?.({ level: 'info', source: 'hardware', message: 'hardware-test-started' });

    try {
      for (const position of HARDWARE_TEST_POSITIONS) {
        const cancellationBeforeWrite = cancellationResult();
        if (cancellationBeforeWrite) return cancellationBeforeWrite;
        const protectedFrame = applyProtection({
          intensity: 0.25,
          position,
          timestamp: Date.now()
        }, this.protection);

        if (!protectedFrame) {
          return { tested: false, reason: 'protection-paused' };
        }

        const profiledFrame = applyProfile(protectedFrame, this.profile);
        const payload = encodeTCodeMotion(profiledFrame, {
          linearAxis: this.profile.linearAxis,
          vibrationAxis: this.profile.vibrationAxis,
          intervalMs: HARDWARE_TEST_STEP_DELAY_MS
        });
        await this.writePayload(payload, 'test', profiledFrame);
        const cancellationAfterWrite = cancellationResult();
        if (cancellationAfterWrite) return cancellationAfterWrite;
        this.reportOutput('test', payload);
        await delay(HARDWARE_TEST_STEP_DELAY_MS);
        const cancellationAfterDelay = cancellationResult();
        if (cancellationAfterDelay) return cancellationAfterDelay;
      }

      return { tested: true, steps: HARDWARE_TEST_POSITIONS.length };
    } catch (error) {
      const cancellation = cancellationResult();
      if (cancellation) return cancellation;
      console.error('hardware test pattern failed', error);
      this.options.onLog?.({ level: 'error', source: 'hardware', message: 'hardware-test-failed', details: formatError(error) });
      throw error;
    } finally {
      this.activeTestPatterns.delete(activePattern);
      this.options.onLog?.({ level: 'info', source: 'hardware', message: 'hardware-test-finished' });
    }
  }

  private scheduleFlush() {
    if (this.flushTimer || this.writing) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushLatest();
    }, this.minIntervalMs);
  }

  private async flushLatest() {
    if (!this.port?.isOpen || !this.latestFrame) return;

    this.writing = true;
    const frame = this.latestFrame;
    this.latestFrame = undefined;

    const profiledFrame = applyProfile(frame, this.profile);
    const payload = encodeTCodeMotion(profiledFrame, {
      linearAxis: this.profile.linearAxis,
      vibrationAxis: this.profile.vibrationAxis,
      intervalMs: TCODE_INTERVAL_MS
    });

    try {
      await this.writePayload(payload, 'motion', profiledFrame);
      this.reportOutput('motion', payload);
    } catch (error) {
      console.error('hardware write failed', error);
      this.options.onLog?.({ level: 'error', source: 'hardware', message: 'hardware-motion-write-failed', details: formatError(error) });
    } finally {
      this.writing = false;
      if (this.latestFrame) this.scheduleFlush();
    }
  }

  private async probeTCodeCapabilities() {
    if (!this.port?.isOpen) return parseTCodeProbe([]);

    const port = this.port;
    const startedAt = this.now();
    const probePayload = encodeTCodeProbe();
    const chunks: string[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(chunk.toString('utf8'));
    };

    port.on('data', onData);
    try {
      await this.writePayload(probePayload, 'probe');
      await new Promise(resolve => setTimeout(resolve, this.options.probeTimeoutMs ?? TCODE_PROBE_TIMEOUT_MS));
      if (this.port !== port || !port.isOpen) throw new Error('hardware-connection-lost');
    } catch (error) {
      console.warn('hardware T-Code probe failed', error);
      this.options.onLog?.({ level: 'warning', source: 'hardware', message: 'hardware-probe-failed', details: formatError(error) });
      if (this.port !== port || !port.isOpen) throw error;
    } finally {
      port.off('data', onData);
    }

    const raw = chunks
      .join('')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    const result = parseTCodeProbe(raw);
    this.emitDiagnostic('info', 'hardware', 'hardware-probe-completed', {
      command: boundedText(probePayload.trim()),
      raw: boundedText(raw.join('\n')),
      responseReceived: raw.length > 0,
      detected: result.detected,
      version: result.version,
      axes: result.axes,
      durationMs: Math.max(0, this.now() - startedAt)
    });
    return result;
  }

  private writePayload(
    payload: string,
    operation: WriteOperation,
    frame?: Pick<MotionFrame, 'position' | 'intensity'>
  ) {
    return new Promise<void>((resolve, reject) => {
      const port = this.port;
      if (!port?.isOpen) {
        reject(new Error('hardware-not-connected'));
        return;
      }

      const startedAt = this.now();
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let activeWrite: ActiveWrite | undefined;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (activeWrite) this.activeWrites.delete(activeWrite);
        if (!error) {
          this.reportCompletedWrite(port, payload, operation, startedAt, frame);
          resolve();
          return;
        }
        this.reportFailedWrite(port, payload, operation, startedAt, error, frame);
        if (this.port === port) this.failPort(port, error, 'hardware-write-failed');
        reject(error);
      };

      activeWrite = { port, fail: finish };
      this.activeWrites.add(activeWrite);
      timeout = setTimeout(() => this.failPort(port, new Error('hardware-write-timeout'), 'hardware-write-timeout'), this.writeTimeoutMs);
      try {
        port.write(payload, finish);
      } catch (error) {
        finish(error instanceof Error ? error : new Error('hardware-write-failed'));
      }
    });
  }

  private async reportPortIdentity(pathName: string) {
    try {
      const ports = await this.listPorts();
      const identity = ports.find(port => port.path.toLowerCase() === pathName.toLowerCase());
      if (!identity) return;

      const data: Record<string, unknown> = { path: identity.path };
      for (const key of ['vendorId', 'productId', 'serialNumber', 'manufacturer', 'pnpId', 'locationId'] as const) {
        if (identity[key] !== undefined) data[key] = identity[key];
      }
      this.emitDiagnostic('info', 'hardware', 'hardware-port-identified', data);
    } catch (error) {
      this.emitDiagnostic('warning', 'hardware', 'hardware-port-identification-failed', normalizedErrorData(error));
    }
  }

  private reportCompletedWrite(
    port: HardwarePort,
    payload: string,
    operation: WriteOperation,
    startedAt: number,
    frame?: Pick<MotionFrame, 'position' | 'intensity'>
  ) {
    const durationMs = Math.max(0, this.now() - startedAt);
    const command = boundedText(payload.trim());
    if (operation === 'motion') {
      this.emitDiagnostic('info', 'hardware', 'hardware-motion-sample', {
        outcome: 'completed',
        command,
        position: frame?.position,
        intensity: frame?.intensity,
        durationMs
      });
      return;
    }

    this.emitDiagnostic('info', 'hardware', 'hardware-write-completed', {
      operation,
      command,
      portPath: port.path,
      baudRate: this.profile.baudRate,
      durationMs,
      deviceAcknowledged: false
    });
  }

  private reportFailedWrite(
    port: HardwarePort,
    payload: string,
    operation: WriteOperation,
    startedAt: number,
    error: Error,
    frame?: Pick<MotionFrame, 'position' | 'intensity'>
  ) {
    const durationMs = Math.max(0, this.now() - startedAt);
    const normalized = normalizedErrorData(error);
    if (operation === 'motion') {
      this.emitDiagnostic('error', 'hardware', 'hardware-motion-sample', {
        outcome: 'failed',
        command: boundedText(payload.trim()),
        position: frame?.position,
        intensity: frame?.intensity,
        durationMs,
        reason: normalized.message,
        timeout: normalized.timeout
      });
      return;
    }

    this.emitDiagnostic('error', 'hardware', 'hardware-write-failed', {
      operation,
      command: boundedText(payload.trim()),
      portPath: port.path,
      baudRate: this.profile.baudRate,
      durationMs,
      ...normalized
    });
  }

  private reportDroppedMotion(frame: MotionFrame, reason: string) {
    this.emitDiagnostic('warning', 'hardware', 'hardware-motion-sample', {
      outcome: 'dropped',
      position: frame.position,
      intensity: frame.intensity,
      reason: boundedText(reason)
    });
  }

  private emitDiagnostic(
    level: HardwareDiagnosticEvent['level'],
    source: HardwareDiagnosticEvent['source'],
    event: string,
    data: Record<string, unknown>
  ) {
    try {
      this.options.onDiagnostic?.({
        timestamp: this.now(),
        level,
        source,
        event,
        data
      });
    } catch {
      // Diagnostics are observational and must never interrupt hardware work.
    }
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private handlePortError(port: HardwarePort, error: Error) {
    if (this.port !== port) return;
    this.options.onLog?.({ level: 'error', source: 'hardware', message: 'hardware-port-error', details: formatError(error) });
    this.emitDiagnostic('error', 'hardware', 'hardware-port-error', normalizedErrorData(error));
    this.failPort(port, error, 'hardware-port-error');
  }

  private handlePortClose(port: HardwarePort) {
    const pendingClose = this.findPendingClose(port);
    if (pendingClose) {
      pendingClose.physicalCloseObserved = true;
      this.finalizeClosedPort(pendingClose);
      return;
    }
    if (this.port !== port) return;
    const error = new Error('hardware-port-closed');
    this.options.onLog?.({ level: 'error', source: 'hardware', message: 'hardware-port-closed' });
    this.emitDiagnostic('error', 'hardware', 'hardware-port-closed', { unexpected: true });
    this.failPort(port, error, 'hardware-port-closed');
  }

  private failPort(port: HardwarePort, error: Error, reason: string) {
    if (this.port !== port) return;
    if (this.findPendingClose(port)) {
      this.operationGeneration += 1;
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
      }
      this.latestFrame = undefined;
      this.failActiveWrites(port, error);
      return;
    }
    this.port = undefined;
    this.operationGeneration += 1;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.latestFrame = undefined;
    this.failActiveWrites(port, error);
    const expectedTransition = this.lifecycleTransition !== undefined;
    this.reportConnectionStatus({
      connected: false,
      reason: this.lifecycleTransition === 'room-exit' ? 'hardware-room-exit-stop-failed' : reason,
      unexpected: !expectedTransition
    });

    const errorHandler = this.portErrorHandlers.get(port);
    const closeHandler = this.portCloseHandlers.get(port);
    if (!port.isOpen) {
      if (this.failedPort === port) this.failedPort = undefined;
      this.detachPortErrorHandler(port, errorHandler);
      this.detachPortCloseHandler(port, closeHandler);
      return;
    }
    this.failedPort = port;
    const cleanup = this.closeFailedPort(port, errorHandler, closeHandler).catch(() => undefined);
    this.failedPortCleanup = cleanup;
    void cleanup.finally(() => {
      if (this.failedPortCleanup === cleanup) this.failedPortCleanup = undefined;
    });
  }

  private async retryFailedPortCleanup() {
    if (this.failedPortCleanup) await this.failedPortCleanup;
    const port = this.failedPort;
    if (!port) return;
    const errorHandler = this.portErrorHandlers.get(port);
    const closeHandler = this.portCloseHandlers.get(port);
    if (!port.isOpen) {
      if (this.findPendingClose(port)) throw new Error('hardware-close-timeout');
      this.failedPort = undefined;
      this.detachPortErrorHandler(port, errorHandler);
      this.detachPortCloseHandler(port, closeHandler);
      return;
    }
    await this.closeFailedPort(port, errorHandler, closeHandler);
  }

  private async closeFailedPort(
    port: HardwarePort,
    errorHandler: ((error: Error) => void) | undefined,
    closeHandler: (() => void) | undefined
  ) {
    try {
      await this.closePort(port, 'failed');
      if (this.failedPort === port) this.failedPort = undefined;
      this.schedulePortHandlersDetach(port, errorHandler, closeHandler);
    } catch (error) {
      this.options.onLog?.({ level: 'error', source: 'hardware', message: 'hardware-port-close-failed', details: formatError(error) });
      throw error;
    }
  }

  private failActiveWrites(port: HardwarePort, error: Error) {
    for (const write of [...this.activeWrites]) {
      if (write.port === port) write.fail(error);
    }
  }

  private openPort(port: HardwarePort) {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('hardware-open-timeout'));
      }, this.lifecycleTimeoutMs);

      try {
        port.open(error => {
          if (settled) {
            if (!error && port.isOpen) this.closeLateOpenedPort(port);
            return;
          }
          settled = true;
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error('hardware-open-failed'));
      }
    });
  }

  private closePort(port: HardwarePort, role: PendingCloseRecord['role']) {
    return new Promise<void>((resolve, reject) => {
      const record: PendingCloseRecord = {
        token: Symbol('hardware-close'),
        port,
        role,
        errorHandler: this.portErrorHandlers.get(port),
        closeHandler: this.portCloseHandlers.get(port),
        timedOut: false,
        callbackSettled: false,
        physicalCloseObserved: false
      };
      this.pendingCloseRecords.set(record.token, record);
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        record.timedOut = true;
        reject(new Error('hardware-close-timeout'));
      }, this.lifecycleTimeoutMs);

      try {
        port.close(error => {
          record.callbackSettled = true;
          this.pendingCloseRecords.delete(record.token);
          if (settled) {
            if (record.timedOut) this.reconcileLateClose(record, error);
            return;
          }
          settled = true;
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        record.callbackSettled = true;
        this.pendingCloseRecords.delete(record.token);
        reject(error instanceof Error ? error : new Error('hardware-close-failed'));
      }
    });
  }

  private closeLateOpenedPort(port: HardwarePort) {
    if (this.port === port || !port.isOpen) return;
    const record = this.trackStalePort(port);
    void this.cleanupStalePort(record).catch(() => undefined);
  }

  private reconcileLateClose(record: PendingCloseRecord, error?: Error | null) {
    const { port } = record;
    if (!error || !port.isOpen || record.physicalCloseObserved) {
      this.finalizeClosedPort(record);
      return;
    }

    if (record.role !== 'owned') return;
    if (!this.port || this.port === port) {
      this.ensurePortHandlers(port, record.errorHandler, record.closeHandler);
      this.port = port;
      this.reportConnectionStatus({ connected: true, path: port.path });
      return;
    }
    if (this.port !== port) this.trackStalePort(port);
  }

  private finalizeClosedPort(record: PendingCloseRecord) {
    const { port } = record;
    if (this.failedPort === port) this.failedPort = undefined;
    const staleRecord = this.stalePorts.get(port);
    if (staleRecord) this.releaseStalePort(staleRecord);
    if (this.port === port) {
      this.port = undefined;
      this.operationGeneration += 1;
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
      }
      this.latestFrame = undefined;
      this.failActiveWrites(port, new Error('hardware-disconnected'));
      this.reportConnectionStatus({ connected: false, reason: 'hardware-disconnected', unexpected: false });
    }
    this.detachPortErrorHandler(port, record.errorHandler);
    this.detachPortCloseHandler(port, record.closeHandler);
  }

  private findPendingClose(port: HardwarePort) {
    for (const record of this.pendingCloseRecords.values()) {
      if (record.port === port && !record.callbackSettled) return record;
    }
    return undefined;
  }

  private trackStalePort(port: HardwarePort) {
    const existing = this.stalePorts.get(port);
    if (existing) return existing;

    const errorSink = () => undefined;
    port.on('error', errorSink);
    this.detachPortErrorHandler(port);
    this.detachPortCloseHandler(port);
    const record: StalePortRecord = {
      token: Symbol('stale-hardware-port'),
      port,
      errorSink,
      cleanup: undefined
    };
    this.stalePorts.set(port, record);
    return record;
  }

  private async cleanupStalePorts() {
    for (const record of [...this.stalePorts.values()]) await this.cleanupStalePort(record);
  }

  private async cleanupStalePort(record: StalePortRecord) {
    if (this.stalePorts.get(record.port)?.token !== record.token) return;
    if (record.cleanup) return record.cleanup;

    const cleanup = (async () => {
      if (!record.port.isOpen) {
        if (this.findPendingClose(record.port)) throw new Error('hardware-close-timeout');
        this.releaseStalePort(record);
        return;
      }
      try {
        await this.closePort(record.port, 'stale');
      } catch (error) {
        if (!record.port.isOpen && !this.findPendingClose(record.port)) {
          this.releaseStalePort(record);
          return;
        }
        throw error;
      }
      this.releaseStalePort(record);
    })();
    record.cleanup = cleanup;
    try {
      await cleanup;
    } finally {
      if (this.stalePorts.get(record.port)?.token === record.token && record.cleanup === cleanup) {
        record.cleanup = undefined;
      }
    }
  }

  private releaseStalePort(record: StalePortRecord) {
    if (this.stalePorts.get(record.port)?.token !== record.token) return;
    if (record.port.isOpen) return;
    this.stalePorts.delete(record.port);
    record.port.off('error', record.errorSink);
    this.detachPortErrorHandler(record.port);
    this.detachPortCloseHandler(record.port);
  }

  private attachPortErrorHandler(port: HardwarePort) {
    this.detachPortErrorHandler(port);
    this.detachPortCloseHandler(port);
    const errorHandler = (error: Error) => this.handlePortError(port, error);
    const closeHandler = () => this.handlePortClose(port);
    this.portErrorHandlers.set(port, errorHandler);
    this.portCloseHandlers.set(port, closeHandler);
    port.on('error', errorHandler);
    port.on('close', closeHandler);
  }

  private ensurePortHandlers(
    port: HardwarePort,
    expectedErrorHandler?: (error: Error) => void,
    expectedCloseHandler?: () => void
  ) {
    if (!this.portErrorHandlers.has(port)) {
      const errorHandler = expectedErrorHandler ?? ((error: Error) => this.handlePortError(port, error));
      this.portErrorHandlers.set(port, errorHandler);
      port.on('error', errorHandler);
    }
    if (!this.portCloseHandlers.has(port)) {
      const closeHandler = expectedCloseHandler ?? (() => this.handlePortClose(port));
      this.portCloseHandlers.set(port, closeHandler);
      port.on('close', closeHandler);
    }
  }

  private schedulePortHandlersDetach(
    port: HardwarePort,
    errorHandler: ((error: Error) => void) | undefined,
    closeHandler: (() => void) | undefined
  ) {
    setImmediate(() => {
      if (!port.isOpen) {
        this.detachPortErrorHandler(port, errorHandler);
        this.detachPortCloseHandler(port, closeHandler);
      }
    });
  }

  private detachPortErrorHandler(port: HardwarePort, expectedHandler?: (error: Error) => void) {
    const errorHandler = this.portErrorHandlers.get(port);
    if (!errorHandler || (expectedHandler && errorHandler !== expectedHandler)) return;
    port.off('error', errorHandler);
    this.portErrorHandlers.delete(port);
  }

  private detachPortCloseHandler(port: HardwarePort, expectedHandler?: () => void) {
    const closeHandler = this.portCloseHandlers.get(port);
    if (!closeHandler || (expectedHandler && closeHandler !== expectedHandler)) return;
    port.off('close', closeHandler);
    this.portCloseHandlers.delete(port);
  }

  private reportConnectionStatus(status: HardwareConnectionStatus) {
    if (
      this.connectionStatus.connected === status.connected
      && this.connectionStatus.path === status.path
    ) return;

    this.connectionStatus = { ...status };
    this.options.onConnectionStatus?.({ ...status });
  }

  private reportOutput(kind: HardwareOutputSnapshot['kind'], payload: string) {
    if (!this.port) return;
    this.options.onOutput?.({
      kind,
      command: payload.trim(),
      completedAt: Date.now(),
      portPath: this.port.path,
      baudRate: this.profile.baudRate
    });
  }
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown-error';
}

function normalizedErrorData(error: unknown) {
  const normalized = error instanceof Error ? error : new Error(formatError(error));
  return {
    name: normalized.name,
    message: boundedText(normalized.message),
    timeout: normalized.message.includes('timeout')
  };
}

function boundedText(value: string) {
  return value.slice(0, 4096);
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeWriteTimeoutMs(value: number | undefined) {
  if (value === undefined) return HARDWARE_WRITE_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) throw new Error('invalid-hardware-write-timeout');
  return value;
}

function normalizeLifecycleTimeoutMs(value: number | undefined) {
  if (value === undefined) return HARDWARE_LIFECYCLE_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) throw new Error('invalid-hardware-lifecycle-timeout');
  return value;
}

function isLifecycleCloseTimeout(error: unknown) {
  return error instanceof Error && error.message === 'hardware-close-timeout';
}

function normalizeProfile(profile: HardwareProfile): HardwareProfile {
  const strokeMin = clamp01(profile.strokeMin);
  const strokeMax = clamp01(profile.strokeMax);
  const low = Math.min(strokeMin, strokeMax);
  const high = Math.max(strokeMin, strokeMax);
  const requestedStopPosition = clamp01(profile.stopPosition ?? strokeMin);

  return {
    baudRate: profile.baudRate,
    linearAxis: profile.linearAxis.trim().toUpperCase(),
    vibrationAxis: profile.vibrationAxis?.trim().toUpperCase() || undefined,
    strokeMin,
    strokeMax,
    stopPosition: Math.min(high, Math.max(low, requestedStopPosition)),
    invertPosition: profile.invertPosition
  };
}

function applyProfile(frame: MotionFrame, profile: HardwareProfile): MotionFrame {
  const low = Math.min(profile.strokeMin, profile.strokeMax);
  const high = Math.max(profile.strokeMin, profile.strokeMax);
  const normalizedPosition = profile.invertPosition ? 1 - frame.position : frame.position;

  return {
    ...frame,
    position: low + clamp01(normalizedPosition) * (high - low)
  };
}

function normalizeProtection(protection: HardwareProtection): HardwareProtection {
  return {
    intensityLimit: clamp01(protection.intensityLimit),
    positionMin: clamp01(protection.positionMin),
    positionMax: clamp01(protection.positionMax),
    paused: protection.paused
  };
}

function applyProtection(frame: MotionFrame, protection: HardwareProtection): MotionFrame | undefined {
  if (protection.paused) return undefined;

  const low = Math.min(protection.positionMin, protection.positionMax);
  const high = Math.max(protection.positionMin, protection.positionMax);

  return {
    intensity: Math.min(clamp01(frame.intensity), protection.intensityLimit),
    position: low + clamp01(frame.position) * (high - low),
    timestamp: frame.timestamp
  };
}
