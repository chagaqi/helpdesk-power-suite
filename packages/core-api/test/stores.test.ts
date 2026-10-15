import { describe, expect, it } from 'vitest';
import { InMemoryUsageStore } from '../src/stores/InMemoryUsageStore.js';
import { RedisUsageStore, UpstashRestClient, type RedisCommander } from '../src/stores/RedisUsageStore.js';
import { RateLimiter } from '../src/util/rateLimit.js';
import { LinkSigner } from '../src/export/signedLinks.js';
import type { IUsageStore } from '../src/stores/IUsageStore.js';

/** Minimal Redis semantics for SET/GET/DEL/INCRBY/EXPIRE with NX/EX. */
class FakeRedis implements RedisCommander {
  data = new Map<string, { v: string; exp: number | null }>();
  constructor(public now: () => number) {}
  async command(args: (string | number)[]) {
    const [cmd, key, ...rest] = args.map(String);
    const live = () => {
      const e = this.data.get(key!);
      if (e && e.exp !== null && e.exp <= this.now()) this.data.delete(key!);
      return this.data.get(key!);
    };
    switch (cmd) {
      case 'GET':
        return live()?.v ?? null;
      case 'SET': {
        const nx = rest.includes('NX');
        const exIdx = rest.indexOf('EX');
        if (nx && live()) return null;
        this.data.set(key!, { v: rest[0]!, exp: exIdx >= 0 ? this.now() + Number(rest[exIdx + 1]) * 1000 : null });
        return 'OK';
      }
      case 'DEL':
        return this.data.delete(key!) ? 1 : 0;
      case 'INCRBY': {
        const e = live();
        const n = Number(e?.v ?? 0) + Number(rest[0]);
        this.data.set(key!, { v: String(n), exp: e?.exp ?? null });
        return n;
      }
      default:
        throw new Error(`unsupported ${cmd}`);
    }
  }
}

function contract(name: string, make: (now: () => number) => IUsageStore) {
  describe(`IUsageStore contract: ${name}`, () => {
    it('get/set/del, TTL expiry, SET NX, atomic incr with window TTL', async () => {
      let t = 1_000_000;
      const s = make(() => t);
      expect(await s.get('k')).toBeNull();
      await s.set('k', 'v', { ttlSeconds: 10 });
      expect(await s.get('k')).toBe('v');
      t += 11_000;
      expect(await s.get('k')).toBeNull();
      expect(await s.setIfAbsent('n', '1', { ttlSeconds: 5 })).toBe(true);
      expect(await s.setIfAbsent('n', '2')).toBe(false);
      expect(await s.incr('c', 1, { ttlSeconds: 60 })).toBe(1);
      expect(await s.incr('c', 4, { ttlSeconds: 60 })).toBe(5);
      t += 61_000;
      expect(await s.incr('c', 1, { ttlSeconds: 60 })).toBe(1);
      await s.del('c');
      expect(await s.get('c')).toBeNull();
    });
  });
}

contract('InMemoryUsageStore', (now) => new InMemoryUsageStore(now));
contract('RedisUsageStore', (now) => new RedisUsageStore(new FakeRedis(now)));

describe('UpstashRestClient', () => {
  it('POSTs command arrays with bearer auth and surfaces errors', async () => {
    const seen: unknown[] = [];
    const ok = (async (_u: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
      return new Response(JSON.stringify({ result: 'OK' }));
    }) as unknown as typeof fetch;
    const store = new RedisUsageStore(new UpstashRestClient('https://x.upstash.io', 'tok', ok), 'p:');
    await store.set('a', 'b', { ttlSeconds: 3 });
    expect(seen[0]).toEqual(['SET', 'p:a', 'b', 'EX', '3']);
    const bad = (async () => new Response(JSON.stringify({ error: 'WRONGPASS' }), { status: 401 })) as unknown as typeof fetch;
    await expect(new UpstashRestClient('https://x', 't', bad).command(['GET', 'a'])).rejects.toThrow(/WRONGPASS/);
  });
});

describe('RateLimiter', () => {
  it('allows N hits per window per key', async () => {
    let t = 0;
    const rl = new RateLimiter(new InMemoryUsageStore(() => t), () => t);
    for (let i = 0; i < 3; i++) expect((await rl.hit('pg', '1.2.3.4', 3, 60)).allowed).toBe(true);
    expect((await rl.hit('pg', '1.2.3.4', 3, 60)).allowed).toBe(false);
    expect((await rl.hit('pg', '5.6.7.8', 3, 60)).allowed).toBe(true);
    t += 60_000;
    expect((await rl.hit('pg', '1.2.3.4', 3, 60)).allowed).toBe(true);
  });
});

describe('LinkSigner', () => {
  it('signs ephemeral download links and rejects tampering/expiry', async () => {
    let t = 1_700_000_000_000;
    const s = new LinkSigner('x'.repeat(32), () => t);
    const { url } = await s.url('https://api.example.com/', 'file1', 900);
    const u = new URL(url);
    expect(u.pathname).toBe('/v1/exports/file1');
    const exp = u.searchParams.get('exp')!;
    const sig = u.searchParams.get('sig')!;
    expect(await s.verify('file1', exp, sig)).toBe('ok');
    expect(await s.verify('file2', exp, sig)).toBe('invalid');
    expect(await s.verify('file1', String(Number(exp) + 1000), sig)).toBe('invalid');
    t += 901_000;
    expect(await s.verify('file1', exp, sig)).toBe('expired');
    expect(() => new LinkSigner('short')).toThrow();
  });
});
