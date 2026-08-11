import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

type FixedWindowRateLimiterOptions = {
  maxRequests: number;
  windowMs: number;
  maxEntries?: number;
  now?: () => number;
};

type ClientAddressRequest = {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string };
};

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: FixedWindowRateLimiterOptions) {
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  consume(key: string): RateLimitResult {
    const now = this.now();
    let bucket = this.buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      this.makeRoomForNewKey(key, now);
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    if (bucket.count >= this.maxRequests) {
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    bucket.count += 1;
    return {
      allowed: true,
      remaining: this.maxRequests - bucket.count,
      retryAfterSeconds
    };
  }

  private makeRoomForNewKey(key: string, now: number) {
    if (this.buckets.has(key) || this.buckets.size < this.maxEntries) return;

    for (const [bucketKey, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(bucketKey);
    }

    if (this.buckets.size < this.maxEntries) return;
    const oldestKey = this.buckets.keys().next().value as string | undefined;
    if (oldestKey) this.buckets.delete(oldestKey);
  }
}

export function getClientAddress(request: ClientAddressRequest, trustCloudflareAddress: boolean) {
  if (trustCloudflareAddress) {
    const header = request.headers['cf-connecting-ip'];
    const candidate = (Array.isArray(header) ? header[0] : header)?.trim();
    if (candidate && isIP(candidate)) return candidate;
  }

  return request.socket.remoteAddress ?? 'unknown';
}

export function getMetricsAccess(
  configuredToken: string | undefined,
  authorizationHeader: string | undefined
): 'disabled' | 'unauthorized' | 'authorized' {
  if (!configuredToken) return 'disabled';
  if (!authorizationHeader?.startsWith('Bearer ')) return 'unauthorized';

  const suppliedToken = authorizationHeader.slice('Bearer '.length);
  const expected = Buffer.from(configuredToken);
  const supplied = Buffer.from(suppliedToken);
  if (expected.length !== supplied.length) return 'unauthorized';

  return timingSafeEqual(expected, supplied) ? 'authorized' : 'unauthorized';
}
