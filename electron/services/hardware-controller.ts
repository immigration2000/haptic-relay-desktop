import { SerialPort } from 'serialport';
import type { MotionFrame } from '../protocol.js';
import { clamp01, HARDWARE_MAX_HZ, maxHzToInterval, TCODE_INTERVAL_MS, TCODE_LINEAR_AXIS, TCODE_VIBRATION_AXIS } from '../tuning.js';
import { encodeTCodeMotion } from './tcode-encoder.js';

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

    return { connected: true, path: pathName, baudRate };
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

    await new Promise<void>((resolve, reject) => {
      const accepted = this.port?.write(payload, error => (error ? reject(error) : resolve()));
      if (accepted === false) {
        this.port?.once('drain', resolve);
      }
    }).catch(error => {
      console.error('hardware write failed', error);
    });

    this.writing = false;
    if (this.latestFrame) this.scheduleFlush();
  }
}
