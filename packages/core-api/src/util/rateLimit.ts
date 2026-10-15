import type { IUsageStore } from '../stores/IUsageStore.js';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

/** Fixed-window limiter backed by IUsageStore.incr (atomic on Redis). */
export class RateLimiter {
  constructor(
    private readonly store: IUsageStore,
    private readonly now: () => number = Date.now,
  ) {}

  async hit(bucket: string, key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
    const t = this.now();
    const windowStart = Math.floor(t / 1000 / windowSec) * windowSec;
    const count = await this.store.incr(`rl:${bucket}:${key}:${windowStart}`, 1, { ttlSeconds: windowSec + 5 });
    return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), resetAt: (windowStart + windowSec) * 1000 };
  }
}
