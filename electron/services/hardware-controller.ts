import { SerialPort } from 'serialport';
import type { MotionFrame } from '../protocol.js';
import { clamp01, HARDWARE_MAX_HZ, maxHzToInterval, TCODE_INTERVAL_MS, TCODE_LINEAR_AXIS, TCODE_VIBRATION_AXIS } from '../tuning.js';
import { encodeTCodeMotion, encodeTCodeProbe, encodeTCodeStop, parseTCodeProbe } from './tcode-encoder.js';

const TCODE_PROBE_TIMEOUT_MS = 350;

export class HardwareController {
  private port: SerialPort | undefined;
  private latestFrame: MotionFrame | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private writing = false;
  private readonly minIntervalMs = maxHzToInterval(HARDWARE_MAX_HZ);

  async listPorts() {
    return SerialPort.list();
  }

  async connect(pathName: string, baudRate = 115200) {
    await this.disconnect();

    this.port = new SerialPort({
      path: pathName,
      baudRate,
      autoOpen: false
    });

    await new Promise<void>((resolve, reject) => {
      this.port?.open(error => (error ? reject(error) : resolve()));
    });

    const probe = await this.probeTCodeCapabilities();
    return { connected: true, path: pathName, baudRate, probe };
  }

  async disconnect() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.latestFrame = undefined;

    if (!this.port?.isOpen) {
      this.port = undefined;
      return { connected: false };
    }

    await new Promise<void>((resolve, reject) => {
      this.port?.close(error => (error ? reject(error) : resolve()));
    });
    this.port = undefined;
    return { connected: false };
  }

  queueMotion(frame: MotionFrame) {
    if (!this.port?.isOpen) {
      return { queued: false, reason: 'hardware-not-connected' };
    }

    this.latestFrame = {
      intensity: clamp01(frame.intensity),
      position: clamp01(frame.position),
      timestamp: frame.timestamp
    };
    this.scheduleFlush();
    return { queued: true };
  }

  async emergencyStop() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.latestFrame = undefined;

    if (!this.port?.isOpen) {
      return { stopped: false, reason: 'hardware-not-connected' };
    }

    const payload = encodeTCodeStop({
      linearAxis: TCODE_LINEAR_AXIS,
      vibrationAxis: TCODE_VIBRATION_AXIS
    });

    await this.writePayload(payload).catch(error => {
      console.error('hardware emergency stop failed', error);
    });

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

    const payload = encodeTCodeMotion(frame, {
      linearAxis: TCODE_LINEAR_AXIS,
      vibrationAxis: TCODE_VIBRATION_AXIS,
      intervalMs: TCODE_INTERVAL_MS
    });

    await this.writePayload(payload).catch(error => {
      console.error('hardware write failed', error);
    });

    this.writing = false;
    if (this.latestFrame) this.scheduleFlush();
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
