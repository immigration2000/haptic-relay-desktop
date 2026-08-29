import type { MotionFrame } from '../protocol.js';
import { clamp01 } from '../tuning.js';

export const MIN_MOTION_DELAY_MS = 0;
export const MAX_MOTION_DELAY_MS = 10_000;
export const MOTION_DELAY_STEP_MS = 100;
export const DEFAULT_MAX_DELAYED_FRAMES = 2_048;
export const MOTION_PLAYBACK_INTERVAL_MS = 33;
export const MIN_INTERPOLATION_DELAY_MS = 100;
export const MAX_INTERPOLATION_GAP_MS = 250;

type DelayedFrame = {
  frame: MotionFrame;
  receivedAtMs: number;
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
  private lastSampleTargetMs: number | undefined;
  private lastEmittedRealReceiptMs: number | undefined;

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

    this.entries.push({ frame, receivedAtMs, dueAtMs: receivedAtMs + this.motionDelayMs });
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

  nextSampleWaitMs(nowMs: number) {
    if (!Number.isFinite(nowMs)) throw new Error('invalid-motion-current-time');
    if (this.motionDelayMs < MIN_INTERPOLATION_DELAY_MS || this.entries.length === 0) return undefined;

    const targetReceivedAtMs = nowMs - this.motionDelayMs;
    const first = this.entries[0];
    const newest = this.entries[this.entries.length - 1];
    if (targetReceivedAtMs < first.receivedAtMs) {
      return first.receivedAtMs - targetReceivedAtMs;
    }
    if (targetReceivedAtMs < newest.receivedAtMs) return MOTION_PLAYBACK_INTERVAL_MS;
    if (this.lastEmittedRealReceiptMs !== newest.receivedAtMs) return 0;
    return undefined;
  }

  sample(nowMs: number) {
    if (!Number.isFinite(nowMs)) throw new Error('invalid-motion-current-time');
    if (this.motionDelayMs < MIN_INTERPOLATION_DELAY_MS || this.entries.length === 0) return undefined;

    const targetReceivedAtMs = nowMs - this.motionDelayMs;
    if (this.lastSampleTargetMs !== undefined && targetReceivedAtMs <= this.lastSampleTargetMs) {
      return undefined;
    }
    this.lastSampleTargetMs = targetReceivedAtMs;

    let before: DelayedFrame | undefined;
    let after: DelayedFrame | undefined;
    let beforeIndex = -1;
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (entry.receivedAtMs <= targetReceivedAtMs) {
        before = entry;
        beforeIndex = index;
      }
      if (entry.receivedAtMs >= targetReceivedAtMs) {
        after = entry;
        break;
      }
    }

    if (!before) return undefined;
    if (beforeIndex > 0) this.entries.splice(0, beforeIndex);
    if (!after || before.receivedAtMs === after.receivedAtMs) {
      if (this.lastEmittedRealReceiptMs === before.receivedAtMs) return undefined;
      this.lastEmittedRealReceiptMs = before.receivedAtMs;
      return before.frame;
    }

    return interpolateMotionFrame(
      before.frame,
      after.frame,
      before.receivedAtMs,
      after.receivedAtMs,
      targetReceivedAtMs
    );
  }

  clear() {
    this.entries = [];
    this.lastReceivedAtMs = undefined;
    this.lastSampleTargetMs = undefined;
    this.lastEmittedRealReceiptMs = undefined;
  }

  stats(): MotionDelayStats {
    return {
      motionDelayMs: this.motionDelayMs,
      bufferedFrames: this.entries.length,
      overflowFrames: this.overflowFrames
    };
  }
}

export function interpolateMotionFrame(
  previous: MotionFrame,
  next: MotionFrame,
  previousReceivedAtMs: number,
  nextReceivedAtMs: number,
  targetReceivedAtMs: number
): MotionFrame | undefined {
  const gapMs = nextReceivedAtMs - previousReceivedAtMs;
  if (!Number.isFinite(gapMs)
    || !Number.isFinite(targetReceivedAtMs)
    || gapMs <= 0
    || gapMs > MAX_INTERPOLATION_GAP_MS
    || targetReceivedAtMs < previousReceivedAtMs
    || targetReceivedAtMs > nextReceivedAtMs) {
    return undefined;
  }

  const ratio = (targetReceivedAtMs - previousReceivedAtMs) / gapMs;
  const result: MotionFrame = {
    ...next,
    position: clamp01(lerp(previous.position, next.position, ratio)),
    intensity: clamp01(lerp(previous.intensity, next.intensity, ratio)),
    durationMs: MOTION_PLAYBACK_INTERVAL_MS
  };

  if (Number.isFinite(previous.timestamp) && Number.isFinite(next.timestamp)) {
    result.timestamp = lerp(previous.timestamp, next.timestamp, ratio);
  }
  if (Number.isFinite(previous.sourceTimeMs) && Number.isFinite(next.sourceTimeMs)) {
    result.sourceTimeMs = lerp(previous.sourceTimeMs!, next.sourceTimeMs!, ratio);
  }
  return result;
}

function lerp(start: number, end: number, ratio: number) {
  return start + ((end - start) * ratio);
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
