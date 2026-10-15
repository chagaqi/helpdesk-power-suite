import type { IUsageStore } from './IUsageStore.js';

/** Anything that can execute a Redis command array and return the RESP-decoded reply. */
export interface RedisCommander {
  command(args: (string | number)[]): Promise<unknown>;
}

/** IUsageStore over Redis (works with Upstash REST, a RESP TCP client, or any ioredis-like adapter). */
export class RedisUsageStore implements IUsageStore {
  constructor(
    private readonly redis: RedisCommander,
    private readonly prefix = 'hps:',
  ) {}

  private k(key: string) {
    return this.prefix + key;
  }

  async get(key: string) {
    const v = await this.redis.command(['GET', this.k(key)]);
    return v === null || v === undefined ? null : String(v);
  }

  async set(key: string, value: string, opts?: { ttlSeconds?: number }) {
    const args: (string | number)[] = ['SET', this.k(key), value];
    if (opts?.ttlSeconds && opts.ttlSeconds > 0) args.push('EX', Math.ceil(opts.ttlSeconds));
    await this.redis.command(args);
  }

  async setIfAbsent(key: string, value: string, opts?: { ttlSeconds?: number }) {
    const args: (string | number)[] = ['SET', this.k(key), value, 'NX'];
    if (opts?.ttlSeconds && opts.ttlSeconds > 0) args.push('EX', Math.ceil(opts.ttlSeconds));
    const r = await this.redis.command(args);
    return r === 'OK';
  }

  async del(key: string) {
    await this.redis.command(['DEL', this.k(key)]);
  }

  async incr(key: string, by = 1, opts?: { ttlSeconds?: number }) {
    // Create the counter with its window TTL first (no-op if it already exists), then increment.
    if (opts?.ttlSeconds && opts.ttlSeconds > 0) {
      await this.redis.command(['SET', this.k(key), 0, 'NX', 'EX', Math.ceil(opts.ttlSeconds)]);
    }
    return Number(await this.redis.command(['INCRBY', this.k(key), by]));
  }
}

/** Upstash Redis REST client (fetch-based; works on Node, Workers, Vercel Edge). */
export class UpstashRestClient implements RedisCommander {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    if (!url || !token) throw new Error('UpstashRestClient requires url and token');
  }

  async command(args: (string | number)[]): Promise<unknown> {
    const res = await this.fetchImpl(this.url.replace(/\/$/, ''), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args.map(String)),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!res.ok || body.error) throw new Error(`Upstash error (${res.status}): ${body.error ?? 'unknown'}`);
    return body.result ?? null;
  }
}
