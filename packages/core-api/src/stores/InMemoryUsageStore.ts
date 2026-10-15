import type { IUsageStore } from './IUsageStore.js';

interface Entry {
  value: string;
  expiresAt: number | null;
}

/** Process-local store with TTL support. Suitable for tests, the playground and single-instance deploys. */
export class InMemoryUsageStore implements IUsageStore {
  private readonly data = new Map<string, Entry>();
  private ops = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 100_000,
  ) {}

  private live(key: string): Entry | undefined {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  private sweep() {
    if (++this.ops % 1000 !== 0 && this.data.size < this.maxEntries) return;
    const t = this.now();
    for (const [k, e] of this.data) if (e.expiresAt !== null && e.expiresAt <= t) this.data.delete(k);
    // Hard cap: evict oldest insertions (Map preserves insertion order).
    while (this.data.size > this.maxEntries) this.data.delete(this.data.keys().next().value!);
  }

  private exp(ttl?: number) {
    return ttl && ttl > 0 ? this.now() + ttl * 1000 : null;
  }

  async get(key: string) {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, opts?: { ttlSeconds?: number }) {
    this.data.set(key, { value, expiresAt: this.exp(opts?.ttlSeconds) });
    this.sweep();
  }

  async setIfAbsent(key: string, value: string, opts?: { ttlSeconds?: number }) {
    if (this.live(key)) return false;
    await this.set(key, value, opts);
    return true;
  }

  async del(key: string) {
    this.data.delete(key);
  }

  async incr(key: string, by = 1, opts?: { ttlSeconds?: number }) {
    const e = this.live(key);
    const next = (e ? Number(e.value) || 0 : 0) + by;
    this.data.set(key, { value: String(next), expiresAt: e ? e.expiresAt : this.exp(opts?.ttlSeconds) });
    this.sweep();
    return next;
  }

  /** Test helper. */
  get size() {
    return this.data.size;
  }
}
