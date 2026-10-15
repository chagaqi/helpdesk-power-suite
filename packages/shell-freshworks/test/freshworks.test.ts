import { describe, expect, it } from 'vitest';
import { parseCsv } from '@hps/core-api/export';
import { HpsApiClient, memoryStorage, runCursorExport } from '@hps/shell-kit';
import { buildCatalog, canonicalRole, decodeCursor, encodeCursor, nextCursor, pageRequest, ticketValues } from '../src/freshdeskApi.js';
import { FreshworksHost } from '../src/fdkAdapter.js';
import { startEnforcer } from '../src/enforce.js';
import { signJwt } from '../src/server/serverless.js';
import { verifyHs256 } from '@hps/core-api';
import { fakeFreshworks } from './fakeFdk.js';
import { validateFreshworksApp } from '../scripts/validate.mjs';

describe('Freshdesk keyset cursor', () => {
  it('starts at the epoch (beats the 30-day default), pages to 300, then restarts from the last updated_at', () => {
    expect(pageRequest('freshdesk', 'ticket', null)).toEqual({ template: 'fdTickets', context: { page: '1', updated_since: '1970-01-01T00:00:00Z' } });
    expect(pageRequest('freshservice', 'user', 'x|2'.replace('x', '2020-01-01T00:00:00Z'))).toEqual({ template: 'fsRequesters', context: { page: '2' } });
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i, updated_at: `2022-01-01T00:00:${String(i % 60).padStart(2, '0')}Z` }));
    expect(nextCursor('ticket', null, full)).toBe('1970-01-01T00:00:00Z|2');
    expect(nextCursor('ticket', encodeCursor({ since: '1970-01-01T00:00:00Z', page: 300 }), full)).toBe(`${full[99]!.updated_at}|1`);
    expect(nextCursor('user', encodeCursor({ since: '1970-01-01T00:00:00Z', page: 300 }), full)).toBeNull();
    expect(nextCursor('ticket', null, full.slice(0, 40))).toBeNull();
    expect(() => decodeCursor('garbage|9999')).toThrow();
  });

  it('catalog, roles and ticket values use Freshdesk interface ids', () => {
    const c = buildCatalog([{ name: 'priority', label: 'Priority', choices: { Low: 1, High: 3 } }, { name: 'cf_tier', label: 'Tier', type: 'custom_dropdown', default: false, choices: ['A'] }], [{ id: 1, name: 'L1' }]);
    expect(c.fields).toEqual([
      { id: 'priority', name: 'Priority', key: 'priority', type: 'system', system: true, options: [{ value: '1', label: 'Low' }, { value: '3', label: 'High' }] },
      { id: 'cf_tier', name: 'Tier', key: 'cf_tier', type: 'dropdown', options: [{ value: 'A', label: 'A' }] },
    ]);
    expect(canonicalRole({ role_ids: [1] }, [{ id: '1', name: 'Account Administrator' }]).role).toBe('admin');
    expect(canonicalRole({ role_ids: [2], occasional: true }, [{ id: '2', name: 'Agent' }]).role).toBe('light_agent');
    expect(ticketValues({ type: 'Question', group_id: 3, custom_fields: { cf_x: 1 } })).toMatchObject({ ticket_type: 'Question', group: 3, cf_x: 1 });
  });

  it('serverless JWTs verify with the core verifier', async () => {
    const tok = signJwt({ sub: 'a', aud: 'helpdesk-power-suite', exp: Math.floor(Date.now() / 1000) + 60 }, 'sekret');
    expect((await verifyHs256(tok, 'sekret', { audience: 'helpdesk-power-suite' })).sub).toBe('a');
  });

  it('app passes the offline FDK 9 validator', () => {
    expect(validateFreshworksApp(new URL('..', import.meta.url).pathname, { requireBuild: false })).toEqual([]);
  });
});

describe('FDK serverless + front end against the core API', () => {
  it('onAppInstall stores the secret server-side only; reinstall without uninstall is refused; uninstall releases', async () => {
    const f = fakeFreshworks();
    expect(await f.serverless.onAppInstall({ domain: 'globex.freshdesk.com' })).toEqual({ ok: true });
    const rec = f.db.get('hps_install_v1') as { secret: string; tenant: string };
    expect(rec.tenant).toBe('freshdesk:globex');
    expect(await f.serverless.onAppInstall({ domain: 'globex.freshdesk.com' })).toMatchObject({ message: expect.stringMatching(/already registered/) });
    expect((await f.serverless.hpsCall({ method: 'GET', path: '/v1/../admin' })).status).toBe(400);
    const me = await f.serverless.hpsCall({ method: 'GET', path: '/v1/me', user: { id: 1, role: 'admin' } });
    expect(me).toMatchObject({ status: 200, data: { tenant: 'freshdesk:globex' } });
    await f.serverless.onAppUninstall();
    expect(f.db.has('hps_install_v1')).toBe(false);
    expect(await f.serverless.onAppInstall({ domain: 'globex.freshdesk.com' })).toEqual({ ok: true });
  });

  it('server-side export of 2,500 tickets (all history, not just 30 days) with the Free cap and then Pro', async () => {
    const f = fakeFreshworks();
    await f.serverless.onAppInstall({ domain: 'globex.freshdesk.com' });
    const host = await FreshworksHost.detect(f.client, memoryStorage());
    const api = new HpsApiClient(host);
    const free = await runCursorExport(host, api, { entity: 'ticket', query: {}, filters: {}, format: 'csv' });
    expect(free!.stats).toMatchObject({ rows: 250, limitReached: true });

    await f.deps.entitlements.grant('freshdesk:globex', { plan: 'pro', status: 'active', source: 'manual', currentPeriodEnd: '2999-01-01T00:00:00Z' });
    const out = await runCursorExport(host, api, { entity: 'ticket', query: { text: 'gold' }, filters: { statuses: ['open', 'pending'] }, format: 'csv' });
    const expected = f.tickets.filter((t) => (t.status === 2 || t.status === 3) && t.custom_fields.cf_customer_tier === 'Gold').length;
    expect(out!.stats).toMatchObject({ rows: expected, batches: 26 }); // 25 full pages + 1 empty page signalling the end
    const csv = parseCsv(await (await f.app.request(out!.downloadUrl.replace('https://api.test', ''))).text());
    expect(csv[0]).toEqual(expect.arrayContaining(['Customer Tier', 'Refund Amount']));
    expect(csv.length - 1).toBe(expected);
    // Data flowed server-to-server: the browser never invoked a Freshdesk ticket template itself.
    expect(f.templateCalls.filter((t) => t === 'fdTickets').length).toBeGreaterThanOrEqual(26);
  });

  it('background enforcer hides/disables by group via interface.trigger and intercepts Update for required fields', async () => {
    const f = fakeFreshworks();
    await f.serverless.onAppInstall({ domain: 'globex.freshdesk.com' });
    const adminHost = new FreshworksHost(f.client, 'freshdesk', memoryStorage());
    const admin = new HpsApiClient({ api: (m, p, b, h) => f.serverless.hpsCall({ method: m, path: p, body: b, etag: h?.['If-None-Match'], user: { id: 1, role: 'admin' } }) as never });
    await admin.syncCatalog(await adminHost.ruleCatalog());
    await admin.createRule({ name: 'L1 cannot refund', conditions: { groups: ['L1 Support'] }, actions: [{ type: 'hide', field: 'Refund Amount' }, { type: 'disable', field: 'Priority' }] });
    await admin.createRule({ name: 'VIP tier required', conditions: { tags: { any: ['vip'] } }, actions: [{ type: 'require', field: 'Customer Tier' }] });

    const enforcer = await startEnforcer(f.client, new FreshworksHost(f.client, 'freshdesk', memoryStorage()));
    expect(f.triggers).toEqual(expect.arrayContaining([['hide', { id: 'cf_refund_amount' }], ['disable', { id: 'priority' }]]));
    const intercept = f.intercepts.get('ticket.propertiesUpdated')!;
    const outcome = await new Promise<string>((resolve) => intercept({ helper: { done: () => resolve('done'), fail: (m: string) => resolve(`fail:${m}`) } }));
    expect(outcome).toMatch(/fail:.*Customer Tier/);
    f.ticket.custom_fields.cf_customer_tier = 'Gold';
    const ok = await new Promise<string>((resolve) => intercept({ helper: { done: () => resolve('done'), fail: (m: string) => resolve(`fail:${m}`) } }));
    expect(ok).toBe('done');
    enforcer.stop();
  });
});
