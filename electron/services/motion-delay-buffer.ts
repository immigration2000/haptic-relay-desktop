import type { MotionFrame } from '../protocol.js';

export const MIN_MOTION_DELAY_MS = 0;
export const MAX_MOTION_DELAY_MS = 10_000;
export const MOTION_DELAY_STEP_MS = 100;
export const DEFAULT_MAX_DELAYED_FRAMES = 2_048;

type DelayedFrame = {
  frame: MotionFrame;
  dueAtMs: number;
};

export type MotionDelayStats = {
  motionDelayMs: number;
  bufferedFrames: number;
  overflowFrames: number;
};

export class MotionDelayBuffer {
  private motionDelayMs = 0;
  private entries: DelayedFrame[] = [];
  private overflowFrames = 0;
  private lastReceivedAtMs: number | undefined;

  constructor(private readonly maxFrames = DEFAULT_MAX_DELAYED_FRAMES) {
    if (!Number.isInteger(maxFrames) || maxFrames < 1) throw new Error('invalid-motion-buffer-capacity');
  }

  setDelayMs(value: number) {
    const nextDelayMs = validateMotionDelayMs(value);
    if (nextDelayMs === this.motionDelayMs) return this.stats();
    this.motionDelayMs = nextDelayMs;
    this.clear();
    return this.stats();
  }

  enqueue(frame: MotionFrame, receivedAtMs: number) {
    if (!Number.isFinite(receivedAtMs)) throw new Error('invalid-motion-received-time');
    if (this.motionDelayMs === 0) return [frame];
    if (this.lastReceivedAtMs !== undefined && receivedAtMs < this.lastReceivedAtMs) {
      throw new Error('invalid-motion-received-time');
    }

    this.entries.push({ frame, dueAtMs: receivedAtMs + this.motionDelayMs });
    this.lastReceivedAtMs = receivedAtMs;
    if (this.entries.length > this.maxFrames) {
      this.entries.shift();
      this.overflowFrames += 1;
    }
    return [];
  }

  drain(nowMs: number) {
    if (!Number.isFinite(nowMs)) throw new Error('invalid-motion-current-time');
    const due: MotionFrame[] = [];
    while (this.entries[0] && this.entries[0].dueAtMs <= nowMs) {
      due.push(this.entries.shift()!.frame);
    }
    if (this.entries.length === 0) this.lastReceivedAtMs = undefined;
    return due;
  }

  nextWaitMs(nowMs: number) {
    if (!Number.isFinite(nowMs)) throw new Error('invalid-motion-current-time');
    const next = this.entries[0];
    return next ? Math.max(0, next.dueAtMs - nowMs) : undefined;
  }

  clear() {
    this.entries = [];
    this.lastReceivedAtMs = undefined;
  }

  stats(): MotionDelayStats {
    return {
      motionDelayMs: this.motionDelayMs,
      bufferedFrames: this.entries.length,
      overflowFrames: this.overflowFrames
    };
  }
}

export function validateMotionDelayMs(value: number) {
  if (!Number.isInteger(value)
    || value < MIN_MOTION_DELAY_MS
    || value > MAX_MOTION_DELAY_MS
    || value % MOTION_DELAY_STEP_MS !== 0) {
    throw new Error('invalid-motion-delay');
  }
  return value;
}
