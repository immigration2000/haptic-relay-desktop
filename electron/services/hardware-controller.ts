import { SerialPort } from 'serialport';
import type { HardwareOutputSnapshot, HardwareProfile, HardwareProtection, MotionFrame } from '../protocol.js';
import {
  clamp01,
  HARDWARE_MAX_HZ,
  HARDWARE_SAFETY_TIMEOUT_MS,
  maxHzToInterval,
  normalizeOptionalTimeoutMs,
  TCODE_INTERVAL_MS,
  TCODE_LINEAR_AXIS,
  TCODE_VIBRATION_AXIS
} from '../tuning.js';
import { encodeTCodeMotion, encodeTCodeProbe, encodeTCodeStop, parseTCodeProbe } from './tcode-encoder.js';

const TCODE_PROBE_TIMEOUT_MS = 350;
const HARDWARE_WRITE_TIMEOUT_MS = 500;
const HARDWARE_TEST_STEP_DELAY_MS = 180;
const HARDWARE_TEST_POSITIONS = [0.2, 0.5, 0.8, 0.5];
const DEFAULT_HARDWARE_PROFILE: HardwareProfile = {
  baudRate: 115200,
  linearAxis: TCODE_LINEAR_AXIS,
  vibrationAxis: TCODE_VIBRATION_AXIS,
  strokeMin: 0,
  strokeMax: 1,
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

type HardwarePort = Pick<SerialPort, 'path' | 'isOpen' | 'open' | 'close' | 'write' | 'once' | 'on' | 'off'>;

type HardwareControllerOptions = {
  onLog?: (entry: HardwareLog) => void;
  onOutput?: (snapshot: HardwareOutputSnapshot) => void;
  createPort?: (options: { path: string; baudRate: number; autoOpen: false }) => HardwarePort;
  probeTimeoutMs?: number;
  writeTimeoutMs?: number;
};

type ActiveWrite = {
  port: HardwarePort;
  fail: (error: Error) => void;
};

export class HardwareController {
  private port: HardwarePort | undefined;
  private readonly options: HardwareControllerOptions;
  private profile = DEFAULT_HARDWARE_PROFILE;
  private protection = DEFAULT_HARDWARE_PROTECTION;
  private latestFrame: MotionFrame | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private safetyTimer: NodeJS.Timeout | undefined;
  private writing = false;
  private readonly portErrorHandlers = new Map<HardwarePort, (error: Error) => void>();
  private readonly activeWrites = new Set<ActiveWrite>();
  private readonly minIntervalMs = maxHzToInterval(HARDWARE_MAX_HZ);
  private readonly safetyTimeoutMs = normalizeOptionalTimeoutMs(HARDWARE_SAFETY_TIMEOUT_MS);
  private readonly writeTimeoutMs: number;

  constructor(options: HardwareControllerOptions | HardwareControllerOptions['onLog'] = {}) {
    this.options = typeof options === 'function' ? { onLog: options } : options;
    this.writeTimeoutMs = normalizeWriteTimeoutMs(this.options.writeTimeoutMs);
  }

  async listPorts() {
    return SerialPort.list();
  }

  async connect(pathName: string, profile: HardwareProfile = DEFAULT_HARDWARE_PROFILE) {
    await this.disconnect();
    this.profile = normalizeProfile(profile);

    const createPort = this.options.createPort ?? (options => new SerialPort(options));
    const port = createPort({
      path: pathName,
      baudRate: this.profile.baudRate,
      autoOpen: false
    });
    this.port = port;
    this.attachPortErrorHandler(port);

    try {
      await new Promise<void>((resolve, reject) => {
        port.open(error => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      this.failPort(port, error instanceof Error ? error : new Error('hardware-open-failed'));
      throw error;
    }

    const probe = await this.probeTCodeCapabilities();
    this.options.onLog?.({ level: 'info', source: 'hardware', message: 'hardware-connected', details: `${pathName} @ ${this.profile.baudRate}` });
    return { connected: true, path: pathName, baudRate: this.profile.baudRate, profile: this.profile, probe };
  }

  async setProtection(protection: HardwareProtection) {
    this.protection = normalizeProtection(protection);
    if (this.protection.paused) {
      await this.emergencyStop();
      this.options.onLog?.({ level: 'warning', source: 'protection', message: 'receive-paused' });
    } else {
      this.options.onLog?.({ level: 'info', source: 'protection', message: 'protection-updated', details: `intensity<=${this.protection.intensityLimit.toFixed(2)}, position ${this.protection.positionMin.toFixed(2)}-${this.protection.positionMax.toFixed(2)}` });
    }

    return { protection: this.protection };
  }

  async disconnect() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.clearSafetyTimer();
    this.latestFrame = undefined;

    const port = this.port;
    if (!port?.isOpen) {
      if (port) this.detachPortErrorHandler(port);
      this.port = undefined;
      return { connected: false };
    }

    this.port = undefined;
    this.failActiveWrites(port, new Error('hardware-disconnected'));
    const errorHandler = this.portErrorHandlers.get(port);
    try {
      await new Promise<void>((resolve, reject) => {
        port.close(error => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      if (!this.port && port.isOpen) this.port = port;
      throw error;
    } finally {
      this.schedulePortErrorHandlerDetach(port, errorHandler);
    }
    this.options.onLog?.({ level: 'info', source: 'hardware', message: 'hardware-disconnected' });
    return { connected: false };
  }

  queueMotion(frame: MotionFrame) {
    if (!this.port?.isOpen) {
      return { queued: false, reason: 'hardware-not-connected' };
    }

    const protectedFrame = applyProtection(frame, this.protection);
    if (!protectedFrame) {
      this.latestFrame = undefined;
      this.options.onLog?.({ level: 'warning', source: 'protection', message: 'motion-dropped-paused' });
      return { queued: false, reason: 'protection-paused' };
    }

    this.latestFrame = protectedFrame;
    this.scheduleSafetyStop();
    this.scheduleFlush();
    return { queued: true };
  }

  async emergencyStop() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.clearSafetyTimer();
    this.latestFrame = undefined;

    if (!this.port?.isOpen) {
      return { stopped: false, reason: 'hardware-not-connected' };
    }

    const payload = encodeTCodeStop({
      linearAxis: this.profile.linearAxis,
      vibrationAxis: this.profile.vibrationAxis,
      stopPosition: this.profile.strokeMin
    });

    const writeError = await this.writePayload(payload).then(() => {
      this.reportOutput('stop', payload);
      return undefined;
    }).catch(error => {
      console.error('hardware emergency stop failed', error);
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
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.clearSafetyTimer();
    this.latestFrame = undefined;

    if (!this.port?.isOpen) {
      return { tested: false, reason: 'hardware-not-connected' };
    }

    this.options.onLog?.({ level: 'info', source: 'hardware', message: 'hardware-test-started' });

    try {
      for (const position of HARDWARE_TEST_POSITIONS) {
        const protectedFrame = applyProtection({
          intensity: 0.25,
          position,
          timestamp: Date.now()
        }, this.protection);

        if (!protectedFrame) {
          return { tested: false, reason: 'protection-paused' };
        }

        const payload = encodeTCodeMotion(applyProfile(protectedFrame, this.profile), {
          linearAxis: this.profile.linearAxis,
          vibrationAxis: this.profile.vibrationAxis,
          intervalMs: HARDWARE_TEST_STEP_DELAY_MS
        });
        await this.writePayload(payload);
        this.reportOutput('test', payload);
        await delay(HARDWARE_TEST_STEP_DELAY_MS);
      }

      return { tested: true, steps: HARDWARE_TEST_POSITIONS.length };
    } catch (error) {
      console.error('hardware test pattern failed', error);
      this.options.onLog?.({ level: 'error', source: 'hardware', message: 'hardware-test-failed', details: formatError(error) });
      throw error;
    } finally {
      await this.emergencyStop();
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

    const payload = encodeTCodeMotion(applyProfile(frame, this.profile), {
      linearAxis: this.profile.linearAxis,
      vibrationAxis: this.profile.vibrationAxis,
      intervalMs: TCODE_INTERVAL_MS
    });

    try {
      await this.writePayload(payload);
      this.reportOutput('motion', payload);
    } catch (error) {
      console.error('hardware write failed', error);
      this.options.onLog?.({ level: 'error', source: 'hardware', message: 'hardware-motion-write-failed', details: formatError(error) });
    } finally {
      this.writing = false;
      if (this.latestFrame) this.scheduleFlush();
    }
  }

  private scheduleSafetyStop() {
    if (!this.safetyTimeoutMs) return;

    this.clearSafetyTimer();
    this.safetyTimer = setTimeout(() => {
      this.safetyTimer = undefined;
      void this.emergencyStop().then(result => {
        if (result.stopped) {
          console.warn('hardware safety timeout triggered');
          this.options.onLog?.({ level: 'warning', source: 'hardware', message: 'hardware-safety-timeout' });
        }
      });
    }, this.safetyTimeoutMs);
  }

  private clearSafetyTimer() {
    if (!this.safetyTimer) return;
    clearTimeout(this.safetyTimer);
    this.safetyTimer = undefined;
  }

  private async probeTCodeCapabilities() {
    if (!this.port?.isOpen) return parseTCodeProbe([]);

    const port = this.port;
    const chunks: string[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(chunk.toString('utf8'));
    };

    port.on('data', onData);
    try {
      await this.writePayload(encodeTCodeProbe());
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

    return parseTCodeProbe(raw);
  }

  private writePayload(payload: string) {
    return new Promise<void>((resolve, reject) => {
      const port = this.port;
      if (!port?.isOpen) {
        reject(new Error('hardware-not-connected'));
        return;
      }

      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let activeWrite: ActiveWrite | undefined;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (activeWrite) this.activeWrites.delete(activeWrite);
        if (error) reject(error);
        else resolve();
      };

      activeWrite = { port, fail: finish };
      this.activeWrites.add(activeWrite);
      timeout = setTimeout(() => this.failPort(port, new Error('hardware-write-timeout')), this.writeTimeoutMs);
      try {
        port.write(payload, finish);
      } catch (error) {
        finish(error instanceof Error ? error : new Error('hardware-write-failed'));
      }
    });
  }

  private handlePortError(port: HardwarePort, error: Error) {
    if (this.port !== port) return;
    this.options.onLog?.({ level: 'error', source: 'hardware', message: 'hardware-port-error', details: formatError(error) });
    this.failPort(port, error);
  }

  private failPort(port: HardwarePort, error: Error) {
    if (this.port !== port) return;
    this.port = undefined;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.clearSafetyTimer();
    this.latestFrame = undefined;
    this.failActiveWrites(port, error);

    const errorHandler = this.portErrorHandlers.get(port);
    if (!port.isOpen) {
      this.detachPortErrorHandler(port, errorHandler);
      return;
    }
    try {
      port.close(closeError => {
        if (closeError) {
          this.options.onLog?.({ level: 'error', source: 'hardware', message: 'hardware-port-close-failed', details: formatError(closeError) });
        }
        this.schedulePortErrorHandlerDetach(port, errorHandler);
      });
    } catch (closeError) {
      this.options.onLog?.({ level: 'error', source: 'hardware', message: 'hardware-port-close-failed', details: formatError(closeError) });
      this.schedulePortErrorHandlerDetach(port, errorHandler);
    }
  }

  private failActiveWrites(port: HardwarePort, error: Error) {
    for (const write of [...this.activeWrites]) {
      if (write.port === port) write.fail(error);
    }
  }

  private attachPortErrorHandler(port: HardwarePort) {
    this.detachPortErrorHandler(port);
    const errorHandler = (error: Error) => this.handlePortError(port, error);
    this.portErrorHandlers.set(port, errorHandler);
    port.on('error', errorHandler);
  }

  private schedulePortErrorHandlerDetach(port: HardwarePort, errorHandler: ((error: Error) => void) | undefined) {
    setImmediate(() => {
      if (!port.isOpen) this.detachPortErrorHandler(port, errorHandler);
    });
  }

  private detachPortErrorHandler(port: HardwarePort, expectedHandler?: (error: Error) => void) {
    const errorHandler = this.portErrorHandlers.get(port);
    if (!errorHandler || (expectedHandler && errorHandler !== expectedHandler)) return;
    port.off('error', errorHandler);
    this.portErrorHandlers.delete(port);
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

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeWriteTimeoutMs(value: number | undefined) {
  if (value === undefined) return HARDWARE_WRITE_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) throw new Error('invalid-hardware-write-timeout');
  return value;
}

function normalizeProfile(profile: HardwareProfile): HardwareProfile {
  return {
    baudRate: profile.baudRate,
    linearAxis: profile.linearAxis.trim().toUpperCase(),
    vibrationAxis: profile.vibrationAxis?.trim().toUpperCase() || undefined,
    strokeMin: clamp01(profile.strokeMin),
    strokeMax: clamp01(profile.strokeMax),
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
