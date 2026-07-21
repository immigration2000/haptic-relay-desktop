import { SerialPort } from 'serialport';
import type { MotionFrame } from '../protocol.js';

export class HardwareController {
  private port: SerialPort | undefined;

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

  async sendMotion(frame: MotionFrame) {
    if (!this.port?.isOpen) {
      return { sent: false, reason: 'hardware-not-connected' };
    }

    const payload = JSON.stringify({
      type: 'motion',
      intensity: clamp01(frame.intensity),
      position: clamp01(frame.position),
      timestamp: frame.timestamp
    });

    await new Promise<void>((resolve, reject) => {
      this.port?.write(`${payload}\n`, error => (error ? reject(error) : resolve()));
    });

    return { sent: true };
  }
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
