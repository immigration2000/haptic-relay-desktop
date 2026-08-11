import type { MotionFrame } from '../protocol.js';

export const DEMO_MOTION_INTERVAL_MS = 1000 / 30;

type DemoMotion = Pick<MotionFrame, 'intensity' | 'position'>;
type PublishMotion = (frame: MotionFrame) => void;
type IntervalFactory = (callback: () => void, intervalMs: number) => unknown;
type IntervalClearer = (timer: unknown) => void;

export class DemoMotionStream {
  private timer: unknown;
  private latest: DemoMotion = { intensity: 0, position: 0.5 };

  constructor(
    private readonly publish: PublishMotion,
    private readonly createInterval: IntervalFactory = (callback, intervalMs) => setInterval(callback, intervalMs),
    private readonly clearIntervalHandle: IntervalClearer = timer => clearInterval(timer as NodeJS.Timeout),
    private readonly now: () => number = Date.now
  ) {}

  start(next: DemoMotion) {
    this.latest = next;
    this.publishLatest();
    if (this.timer === undefined) {
      this.timer = this.createInterval(() => this.publishLatest(), DEMO_MOTION_INTERVAL_MS);
    }
    return { streaming: true, intervalMs: DEMO_MOTION_INTERVAL_MS };
  }

  update(next: DemoMotion) {
    this.latest = next;
    return { streaming: this.timer !== undefined };
  }

  stop() {
    if (this.timer === undefined) return { streaming: false };

    this.clearIntervalHandle(this.timer);
    this.timer = undefined;
    this.publish({ intensity: 0, position: this.latest.position, timestamp: this.now() });
    return { streaming: false };
  }

  private publishLatest() {
    this.publish({ ...this.latest, timestamp: this.now() });
  }
}
