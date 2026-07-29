import { SerialPort } from 'serialport';
import type { HardwareProfile, HardwareProtection, MotionFrame } from '../protocol.js';
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

export class HardwareController {
  private port: SerialPort | undefined;
  private profile = DEFAULT_HARDWARE_PROFILE;
  private protection = DEFAULT_HARDWARE_PROTECTION;
  private latestFrame: MotionFrame | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private safetyTimer: NodeJS.Timeout | undefined;
  private writing = false;
  private readonly minIntervalMs = maxHzToInterval(HARDWARE_MAX_HZ);
  private readonly safetyTimeoutMs = normalizeOptionalTimeoutMs(HARDWARE_SAFETY_TIMEOUT_MS);

  constructor(private readonly onLog?: (entry: HardwareLog) => void) {}

  async listPorts() {
    return SerialPort.list();
  }

  async connect(pathName: string, profile: HardwareProfile = DEFAULT_HARDWARE_PROFILE) {
    await this.disconnect();
    this.profile = normalizeProfile(profile);

    this.port = new SerialPort({
      path: pathName,
      baudRate: this.profile.baudRate,
      autoOpen: false
    });

    await new Promise<void>((resolve, reject) => {
      this.port?.open(error => (error ? reject(error) : resolve()));
    });

    const probe = await this.probeTCodeCapabilities();
    this.onLog?.({ level: 'info', source: 'hardware', message: 'hardware-connected', details: `${pathName} @ ${this.profile.baudRate}` });
    return { connected: true, path: pathName, baudRate: this.profile.baudRate, profile: this.profile, probe };
  }

  async setProtection(protection: HardwareProtection) {
    this.protection = normalizeProtection(protection);
    if (this.protection.paused) {
      await this.emergencyStop();
      this.onLog?.({ level: 'warning', source: 'protection', message: 'receive-paused' });
    } else {
      this.onLog?.({ level: 'info', source: 'protection', message: 'protection-updated', details: `intensity<=${this.protection.intensityLimit.toFixed(2)}, position ${this.protection.positionMin.toFixed(2)}-${this.protection.positionMax.toFixed(2)}` });
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

    if (!this.port?.isOpen) {
      this.port = undefined;
      return { connected: false };
    }

    await new Promise<void>((resolve, reject) => {
      this.port?.close(error => (error ? reject(error) : resolve()));
    });
    this.onLog?.({ level: 'info', source: 'hardware', message: 'hardware-disconnected' });
    this.port = undefined;
    return { connected: false };
  }

  queueMotion(frame: MotionFrame) {
    if (!this.port?.isOpen) {
      return { queued: false, reason: 'hardware-not-connected' };
    }

    const protectedFrame = applyProtection(frame, this.protection);
    if (!protectedFrame) {
      this.latestFrame = undefined;
      this.onLog?.({ level: 'warning', source: 'protection', message: 'motion-dropped-paused' });
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

    await this.writePayload(payload).catch(error => {
      console.error('hardware emergency stop failed', error);
      this.onLog?.({ level: 'error', source: 'hardware', message: 'hardware-stop-write-failed', details: formatError(error) });
    });

    this.onLog?.({ level: 'warning', source: 'hardware', message: 'hardware-stopped' });
    return { stopped: true };
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

    await this.writePayload(payload).catch(error => {
      console.error('hardware write failed', error);
      this.onLog?.({ level: 'error', source: 'hardware', message: 'hardware-motion-write-failed', details: formatError(error) });
    });

    this.writing = false;
    if (this.latestFrame) this.scheduleFlush();
  }

  private scheduleSafetyStop() {
    if (!this.safetyTimeoutMs) return;

    this.clearSafetyTimer();
    this.safetyTimer = setTimeout(() => {
      this.safetyTimer = undefined;
      void this.emergencyStop().then(result => {
        if (result.stopped) {
          console.warn('hardware safety timeout triggered');
          this.onLog?.({ level: 'warning', source: 'hardware', message: 'hardware-safety-timeout' });
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

    const chunks: string[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(chunk.toString('utf8'));
    };

    this.port.on('data', onData);
    try {
      await this.writePayload(encodeTCodeProbe());
      await new Promise(resolve => setTimeout(resolve, TCODE_PROBE_TIMEOUT_MS));
    } catch (error) {
      console.warn('hardware T-Code probe failed', error);
      this.onLog?.({ level: 'warning', source: 'hardware', message: 'hardware-probe-failed', details: formatError(error) });
    } finally {
      this.port?.off('data', onData);
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
      if (!this.port?.isOpen) {
        reject(new Error('hardware-not-connected'));
        return;
      }

      const accepted = this.port.write(payload, error => (error ? reject(error) : resolve()));
      if (accepted === false) {
        this.port.once('drain', resolve);
      }
    });
  }
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown-error';
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
