import type { MotionFrame } from '../protocol.js';
import { clamp01 } from '../tuning.js';

export type TCodeOptions = {
  linearAxis: string;
  vibrationAxis?: string;
  intervalMs?: number;
};

export type TCodeProbeResult = {
  detected: boolean;
  raw: string[];
  version?: string;
  axes: string[];
};

export function encodeTCodeMotion(frame: MotionFrame, options: TCodeOptions) {
  const commands = [
    encodeAxis(options.linearAxis, frame.position, options.intervalMs)
  ];

  if (options.vibrationAxis) {
    commands.push(encodeAxis(options.vibrationAxis, frame.intensity));
  }

  return `${commands.join(' ')}\n`;
}

export function encodeTCodeStop(options: TCodeOptions) {
  const fallback = encodeTCodeMotion({
    intensity: 0,
    position: 0,
    timestamp: Date.now()
  }, {
    ...options,
    intervalMs: 1
  }).trim();

  return `DSTOP\n${fallback}\n`;
}

export function encodeTCodeProbe() {
  return 'D1\nD2\n';
}

export function parseTCodeProbe(raw: string[]) {
  const text = raw.join('\n');
  const version = text.match(/(?:t-?code|version|v)\s*[:= ]\s*(v?\d+(?:\.\d+)?)/i)?.[1];
  const axes = [...new Set(text.match(/\b[LRVA][0-9]\b/gi)?.map(axis => axis.toUpperCase()) ?? [])].sort();

  return {
    detected: raw.length > 0,
    raw,
    version,
    axes
  } satisfies TCodeProbeResult;
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
