import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisUsageStore, hmacSha256Hex } from '@hps/core-api';
import { parseCsv } from '@hps/core-api/export';
import { createGateway } from '../src/app.js';
import { loadConfig, parseKeyMap } from '../src/config.js';
import { parseReply, RespClient } from '../src/redis/RespClient.js';

const quiet = { error() {}, warn() {}, info() {} };
const gw = (env: Record<string, string> = {}) => createGateway(loadConfig({ HPS_MASTER_SECRET: 'g'.repeat(40), PUBLIC_BASE_URL: 'https://gw.test', ...env }), { logger: quiet });
const post = (app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('config', () => {
  it('requires secrets in production and validates billing combos', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/HPS_MASTER_SECRET/);
    expect(() => loadConfig({ HPS_MASTER_SECRET: 'short' })).toThrow(/at least 32/);
    expect(() => loadConfig({ BILLING_PROVIDER: 'polar' })).toThrow(/POLAR_ACCESS_TOKEN/);
    expect(() => loadConfig({ UPSTASH_REDIS_REST_URL: 'https://x.upstash.io' })).toThrow(/TOKEN/);
    const dev = loadConfig({});
    expect(dev.warnings[0]).toMatch(/ephemeral/);
    expect(dev.publicBaseUrl).toBe('http://localhost:8787');
    expect(parseKeyMap('Acme=ops@acme.com:KEY, globex = t2')).toEqual(new Map([['acme', 'ops@acme.com:KEY'], ['globex', 't2']]));
  });
});

describe('gateway composition', () => {
  it('serves core, playground and security headers; companions only when configured', async () => {
    const g = gw();
    expect(g.mounted).toEqual(['core', 'playground']);
    const h = await g.app.request('/healthz');
    expect(h.headers.get('x-content-type-options')).toBe('nosniff');
    const pg = await g.app.request('/playground');
    expect(pg.status).toBe(200);
    const csp = pg.headers.get('content-security-policy')!;
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    expect(await pg.text()).toContain(`<script nonce="${nonce}">`);
    expect((await g.app.request('/')).headers.get('location')).toBe('/playground');
    expect((await g.app.request('/nope')).status).toBe(404);
    expect(gw({ PLAYGROUND_ENABLED: '0' }).mounted).toEqual(['core']);
    expect(gw({ GORGIAS_WIDGET_SECRET: 'w'.repeat(32), INTERCOM_CLIENT_SECRET: 'ic-secret' }).mounted).toEqual(['core', 'gorgias', 'intercom', 'playground']);
  });

  it('playground export: 2,000 users, overlapping + replayed pages -> unique rows and a signed download', async () => {
    const g = gw();
    const r = await post(g.app, '/playground/api/export', { entity: 'user', count: 2000, filters: { userState: 'active' } });
    const j = (await r.json()) as { downloadUrl: string; stats: Record<string, number>; preview: unknown[][] };
    expect(j.stats).toMatchObject({ replayedBatches: 2 });
    expect(j.stats.duplicatesDropped).toBeGreaterThan(0);
    expect(j.preview).toHaveLength(25);
    const csv = parseCsv(await (await g.app.request(j.downloadUrl)).text());
    expect(csv.length - 1).toBe(j.stats.rows);
    expect(new Set(csv.slice(1).map((x) => x[0])).size).toBe(j.stats.rows);
    expect(csv.slice(1).every((x) => x[csv[0]!.indexOf('State')] === 'Active')).toBe(true);
    expect((await post(g.app, '/playground/api/export', { count: 999_999 })).status).toBe(400);
  });

  it('playground rules evaluate by field name with priority overrides and report bad names', async () => {
    const g = gw();
    const rules = [
      { name: 'Tier 2 override', conditions: { groups: ['Tier 2 Escalations'] }, actions: [{ type: 'show', field: 'Internal Escalation Notes' }] },
      { name: 'Hide notes', actions: [{ type: 'hide', field: 'internal escalation notes' }] },
      { name: 'Typo', actions: [{ type: 'hide', field: 'Refnd Amount' }] },
    ];
    const ev = async (groups: string[]) => (await (await post(g.app, '/playground/api/evaluate', { rules, context: { user: { role: 'agent', groups }, ticket: { tags: [] } } })).json()) as any;
    const t1 = await ev(['Tier 1 Support']);
    expect(t1.evaluation.fields['360004'].hidden).toBe(true);
    expect(t1.problems[0]).toMatchObject({ rule: 2, suggestions: ['Refund Amount'] });
    expect((await ev(['Tier 2 Escalations'])).evaluation.fields['360004'].hidden).toBe(false);
  });

  it('playground is IP rate limited (trusting X-Forwarded-For only when TRUST_PROXY)', async () => {
    const g = gw({ PLAYGROUND_RATE_LIMIT: '2', TRUST_PROXY: '1' });
    const hit = (ip: string) => post(g.app, '/playground/api/evaluate', { rules: [], context: { user: { role: 'agent' } } }, { 'x-forwarded-for': ip });
    expect((await hit('1.1.1.1')).status).toBe(200);
    expect((await hit('1.1.1.1')).status).toBe(200);
    const blocked = await hit('1.1.1.1');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect((await hit('2.2.2.2')).status).toBe(200);
    expect((await g.app.request('/playground/api/catalog')).status).toBe(200); // metadata is not limited
  });

  it('end-to-end install -> rules -> Polar upgrade through the composed gateway', async () => {
    const g = gw({ POLAR_WEBHOOK_SECRET: 'polar-secret' });
    const inst = (await (await post(g.app, '/v1/install', { platform: 'zendesk', tenant: 'acme', installationId: 'i1' })).json()) as { sharedSecret: string };
    const tok = () => g.deps.installs.issueToken(inst.sharedSecret, 'zendesk:acme', 'i1', { id: '1', role: 'admin', groups: [] });
    const me = async () => (await (await g.app.request('/v1/me', { headers: { authorization: `Bearer ${await tok()}` } })).json()) as any;
    expect((await me()).entitlement.effectivePlan).toBe('free');
    const body = JSON.stringify({ type: 'subscription.active', data: { status: 'active', current_period_end: '2999-01-01T00:00:00Z', metadata: { tenant_key: 'zendesk:acme' } } });
    const ts = String(Math.floor(Date.now() / 1000));
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', 'polar-secret').update(`m1.${ts}.${body}`).digest('base64');
    expect((await g.app.request('/v1/webhooks/polar', { method: 'POST', headers: { 'webhook-id': 'm1', 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }, body })).status).toBe(202);
    expect((await me()).entitlement.effectivePlan).toBe('pro');
  });

  it('mounts Gorgias routes behind the widget secret', async () => {
    const secret = 'w'.repeat(32);
    const g = gw({ GORGIAS_WIDGET_SECRET: secret });
    const raw = JSON.stringify({ account: 'acme', ticket: { id: 1, tags: [] } });
    const ok = await g.app.request('/gorgias/widget', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hps-signature': `sha256=${await hmacSha256Hex(secret, raw)}` }, body: raw });
    expect(ok.status).toBe(200);
    expect((await g.app.request('/gorgias/widget', { method: 'POST', body: raw })).status).toBe(401);
  });
});

describe('RESP parser', () => {
  it('parses all RESP2 types and partial buffers', () => {
    const b = (s: string) => Buffer.from(s);
    expect(parseReply(b('+OK\r\n'), 0)).toEqual({ value: 'OK', end: 5 });
    expect(parseReply(b(':42\r\n'), 0)!.value).toBe(42);
    expect(parseReply(b('$4\r\nhé!\r\n'), 0)!.value).toBe('hé!'); // byte length, not chars
    expect(parseReply(b('$-1\r\n'), 0)!.value).toBeNull();
    expect(parseReply(b('*2\r\n$1\r\na\r\n:1\r\n'), 0)!.value).toEqual(['a', 1]);
    expect(parseReply(b('$10\r\nabc'), 0)).toBeNull();
    expect((parseReply(b('-ERR nope\r\n'), 0)!.value as Error).message).toBe('ERR nope');
  });
});

const hasRedis = (() => {
  try {
    execSync('command -v redis-server', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasRedis)('RespClient against a real redis-server', () => {
  let proc: ChildProcess;
  let port = 0;
  beforeAll(async () => {
    port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    proc = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no', '--requirepass', 'pw'], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try {
        await new RespClient(`redis://:pw@127.0.0.1:${port}`).command(['PING']);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('redis-server did not start');
  });
  afterAll(() => {
    proc?.kill();
  });

  it('implements the IUsageStore contract over RESP (auth, NX, EX, INCRBY, pipelining)', async () => {
    const client = new RespClient(`redis://:pw@127.0.0.1:${port}/2`);
    const store = new RedisUsageStore(client, 'test:');
    await store.set('k', 'vä', { ttlSeconds: 60 });
    expect(await store.get('k')).toBe('vä');
    expect(await store.setIfAbsent('k', 'x')).toBe(false);
    expect(await store.setIfAbsent('fresh', 'x', { ttlSeconds: 5 })).toBe(true);
    const counts = await Promise.all(Array.from({ length: 50 }, () => store.incr('ctr', 1, { ttlSeconds: 30 })));
    expect(Math.max(...counts)).toBe(50);
    expect(new Set(counts).size).toBe(50); // atomic
    expect(Number(await client.command(['TTL', 'test:ctr']))).toBeGreaterThan(0);
    const big = 'x'.repeat(200_000);
    await store.set('big', big);
    expect(await store.get('big')).toBe(big);
    await store.del('k');
    expect(await store.get('k')).toBeNull();
    await expect(client.command(['NOPE'])).rejects.toThrow(/unknown command/i);
    await client.quit();
    await expect(new RespClient(`redis://:wrong@127.0.0.1:${port}`).command(['PING'])).rejects.toThrow(/WRONGPASS|invalid/i);
  });
});
