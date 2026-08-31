import { performance } from 'node:perf_hooks';
import type { MotionDemoMode, MotionFrame, MotionPatternConfig } from '../protocol.js';
import { calculatePatternPosition } from './demo-motion-pattern.js';
import { DEFAULT_MANUAL_MAX_POSITION_SPEED, validateManualMaxPositionSpeed } from './manual-motion-safety.js';

export const DEMO_MOTION_INTERVAL_MS = 1000 / 30;
export const PATTERN_ENTRY_RAMP_MS = 300;

type DemoMotion = Pick<MotionFrame, 'intensity' | 'position'>;
type PublishMotion = (frame: MotionFrame) => void;
type IntervalFactory = (callback: () => void, intervalMs: number) => unknown;
type IntervalClearer = (timer: unknown) => void;

export class DemoMotionStream {
  private timer: unknown;
  private timerGeneration = 0;
  private latest: DemoMotion = { intensity: 0, position: 0.5 };
  private manualTarget: DemoMotion = { ...this.latest };
  private mode: MotionDemoMode = 'manual';
  private pattern: MotionPatternConfig | undefined;
  private patternStartedAt = 0;
  private patternRampFrom = 0.5;
  private manualMaxPositionSpeed = DEFAULT_MANUAL_MAX_POSITION_SPEED;

  constructor(
    private readonly publish: PublishMotion,
    private readonly createInterval: IntervalFactory = (callback, intervalMs) => setInterval(callback, intervalMs),
    private readonly clearIntervalHandle: IntervalClearer = timer => clearInterval(timer as NodeJS.Timeout),
    private readonly now: () => number = Date.now,
    private readonly monotonicNow: () => number = () => performance.now()
  ) {}

  start(next: DemoMotion) {
    const transitioned = this.safeTransition('manual');
    this.pattern = undefined;
    this.manualTarget = next;
    this.ensureTimer();
    if (!transitioned) this.publishManual();
    return { streaming: true, mode: 'manual' as const, intervalMs: DEMO_MOTION_INTERVAL_MS };
  }

  update(next: DemoMotion) {
    if (this.timer === undefined || this.mode !== 'manual') {
      return { streaming: false, accepted: false };
    }

    this.manualTarget = next;
    return { streaming: true, accepted: true };
  }

  startPattern(config: MotionPatternConfig) {
    const transitioned = this.safeTransition('pattern');
    this.pattern = config;
    this.patternStartedAt = this.monotonicNow();
    this.patternRampFrom = this.latest.position;
    this.latest = { intensity: config.intensity, position: this.patternRampFrom };
    this.ensureTimer();
    if (!transitioned) this.publishLatest();
    return { streaming: true, mode: 'pattern' as const, intervalMs: DEMO_MOTION_INTERVAL_MS };
  }

  updatePattern(config: MotionPatternConfig) {
    if (this.timer === undefined || this.mode !== 'pattern') {
      return { streaming: false, accepted: false };
    }

    this.pattern = config;
    this.patternStartedAt = this.monotonicNow();
    this.patternRampFrom = this.latest.position;
    return { streaming: true, accepted: true };
  }

  stop() {
    if (this.timer === undefined) return { streaming: false };

    this.clearTimer();
    this.pattern = undefined;
    this.publishSafeStop();
    return { streaming: false };
  }

  getMode(): MotionDemoMode {
    return this.mode;
  }

  setManualMaxPositionSpeed(value: unknown): number {
    this.manualMaxPositionSpeed = validateManualMaxPositionSpeed(value);
    return this.manualMaxPositionSpeed;
  }

  private safeTransition(nextMode: MotionDemoMode) {
    const transitioned = this.timer !== undefined && this.mode !== nextMode;
    if (transitioned) {
      this.clearTimer();
      this.publishSafeStop();
    }
    this.mode = nextMode;
    return transitioned;
  }

  private ensureTimer() {
    if (this.timer !== undefined) return;

    const generation = ++this.timerGeneration;
    this.timer = this.createInterval(() => {
      if (this.timer === undefined || this.timerGeneration !== generation) return;
      if (this.mode === 'pattern') this.publishPattern();
      else this.publishManual();
    }, DEMO_MOTION_INTERVAL_MS);
  }

  private clearTimer() {
    if (this.timer === undefined) return;

    const timer = this.timer;
    this.timerGeneration += 1;
    this.clearIntervalHandle(timer);
    this.timer = undefined;
  }

  private publishPattern() {
    if (this.pattern === undefined) return;

    const measuredElapsed = this.monotonicNow() - this.patternStartedAt;
    const elapsed = Number.isFinite(measuredElapsed) ? Math.max(0, measuredElapsed) : 0;
    const patternElapsed = Math.max(0, elapsed - PATTERN_ENTRY_RAMP_MS);
    const target = calculatePatternPosition(this.pattern, patternElapsed);
    const rampProgress = Math.min(1, Math.max(0, elapsed / PATTERN_ENTRY_RAMP_MS));
    const position = this.patternRampFrom + (target - this.patternRampFrom) * rampProgress;
    this.latest = { intensity: this.pattern.intensity, position };
    this.publishLatest();
  }

  private publishManual() {
    const maximumStep = this.manualMaxPositionSpeed * DEMO_MOTION_INTERVAL_MS / 1000;
    const delta = this.manualTarget.position - this.latest.position;
    const position = Math.abs(delta) <= maximumStep
      ? this.manualTarget.position
      : this.latest.position + Math.sign(delta) * maximumStep;
    this.latest = { intensity: this.manualTarget.intensity, position };
    this.publishLatest();
  }

  private publishLatest() {
    this.publish({ ...this.latest, timestamp: this.now(), durationMs: DEMO_MOTION_INTERVAL_MS });
  }

  private publishSafeStop() {
    this.publish({
      intensity: 0,
      position: this.latest.position,
      timestamp: this.now(),
      durationMs: DEMO_MOTION_INTERVAL_MS
    });
  }
}
