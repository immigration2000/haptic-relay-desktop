import type { MotionFrame } from '../protocol.js';
import { clamp01 } from '../tuning.js';

export type TCodeOptions = {
  linearAxis: string;
  vibrationAxis?: string;
  intervalMs?: number;
};

export function encodeTCodeMotion(frame: MotionFrame, options: TCodeOptions) {
  const commands = [
    encodeAxis(options.linearAxis, frame.position, options.intervalMs)
  ];

  if (options.vibrationAxis) {
    commands.push(encodeAxis(options.vibrationAxis, frame.intensity));
  }

  return `${commands.join('')}\n`;
}

function encodeAxis(axis: string, value: number, intervalMs?: number) {
  const normalizedAxis = normalizeAxis(axis);
  const magnitude = Math.min(9999, Math.round(clamp01(value) * 10000)).toString().padStart(4, '0');
  const interval = intervalMs && intervalMs > 0 ? `I${Math.round(intervalMs)}` : '';
  return `${normalizedAxis}${magnitude}${interval}`;
}

function normalizeAxis(axis: string) {
  const normalized = axis.trim().toUpperCase();
  if (!/^[LRVA][0-9]$/.test(normalized)) {
    throw new Error(`invalid-tcode-axis:${axis}`);
  }
  return normalized;
}
