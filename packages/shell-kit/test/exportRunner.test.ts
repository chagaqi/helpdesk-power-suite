import { describe, expect, it } from 'vitest';
import { parseCsv } from '@hps/core-api/export';
import { HpsApiClient } from '../src/api.js';
import { runCursorExport } from '../src/exportRunner.js';
import type { ExportProgress } from '../src/types.js';
import { localHost } from './localHost.js';

describe('runCursorExport (shell -> core API, in-process)', () => {
  it('streams 2,400 users across 24 cursor pages (with overlap) into one deduplicated CSV', async () => {
    const { host, app, users } = await localHost({ pro: true, overlap: 7, users: (await import('@hps/core-api')).synthetic.zendeskUsers(2400) });
    const progress: ExportProgress[] = [];
    const out = await runCursorExport(host, new HpsApiClient(host), { entity: 'user', query: {}, filters: { userState: 'active' }, format: 'csv' }, { onProgress: (p) => progress.push(p) });
    expect(out).not.toBeNull();
    const expected = users.filter((u) => !(u as { suspended: boolean }).suspended).length;
    expect(out!.stats).toMatchObject({ rows: expected, batches: 24 });
    expect(progress.at(-1)!.phase).toBe('done');
    const csv = parseCsv(await (await app.request(out!.downloadUrl.replace('https://api.test', ''))).text());
    expect(csv.length - 1).toBe(expected);
    expect(new Set(csv.slice(1).map((r) => r[0])).size).toBe(expected);
  });

  it('stops pulling pages once the Free plan row limit is reached', async () => {
    const { host, fetchCalls } = await localHost({ pro: false });
    const out = await runCursorExport(host, new HpsApiClient(host), { entity: 'user', query: {}, filters: {}, format: 'xlsx' });
    expect(out!.stats).toMatchObject({ rows: 250, limitReached: true });
    expect(out!.upgrade?.message).toMatch(/250/);
    expect(fetchCalls.length).toBeLessThanOrEqual(4); // 3 pages + at most one prefetch, not all 10
  });

  it('breaks cursor loops and honours abort signals', async () => {
    const { host } = await localHost({ pro: true });
    host.fetchPage = async () => ({ records: [{ id: 1, role: 'end-user' }], nextCursor: 'same' });
    const out = await runCursorExport(host, new HpsApiClient(host), { entity: 'user', query: {}, filters: {}, format: 'csv' });
    expect(out!.stats).toMatchObject({ rows: 1, batches: 2 });
    const ac = new AbortController();
    ac.abort();
    expect(await runCursorExport(host, new HpsApiClient(host), { entity: 'user', query: {}, filters: {}, format: 'csv' }, { signal: ac.signal })).toBeNull();
  });

  it('retries 429s and surfaces API errors with codes', async () => {
    let n = 0;
    const api = new HpsApiClient({ api: async () => ({ status: n++ < 2 ? 429 : 402, data: { error: { code: 'plan_limit', message: 'nope' } } }) as never }, { attempts: 3, baseMs: 1 });
    await expect(api.me()).rejects.toMatchObject({ status: 402, code: 'plan_limit' });
    expect(n).toBe(3);
  });
});
