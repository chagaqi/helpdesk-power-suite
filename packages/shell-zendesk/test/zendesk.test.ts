import { describe, expect, it } from 'vitest';
import { parseCsv } from '@hps/core-api/export';
import { ensureInstalled, HpsApiClient, memoryStorage, runCursorExport } from '@hps/shell-kit';
import { buildCatalog, canonicalRole, pageUrl, parsePage, ticketValuePath } from '../src/zendeskApi.js';
import { keyForId, ZendeskHost } from '../src/zafAdapter.js';
import { startEnforcer } from '../src/sidebar.js';
import { fakeZendesk } from './fakeZaf.js';
import { validateZendeskApp } from '../scripts/validate.mjs';
import { synthetic } from '@hps/core-api';

describe('Zendesk REST helpers', () => {
  it('uses cursor endpoints: search/export for queries, incremental cursor for archived tickets, list otherwise', () => {
    expect(pageUrl('ticket', null, { text: 'status:open priority:high' })).toBe('/api/v2/search/export.json?query=status%3Aopen+priority%3Ahigh&filter%5Btype%5D=ticket&page%5Bsize%5D=1000');
    expect(pageUrl('ticket', 'abc', { includeArchived: true })).toBe('/api/v2/incremental/tickets/cursor.json?cursor=abc');
    expect(pageUrl('ticket', null, { includeArchived: true })).toBe('/api/v2/incremental/tickets/cursor.json?start_time=0');
    expect(pageUrl('user', 'x', { roles: ['agent', 'light_agent', 'end_user'] })).toBe('/api/v2/users.json?page%5Bsize%5D=100&page%5Bafter%5D=x&role[]=agent&role[]=end-user');
    expect(parsePage('ticket', { includeArchived: true }, { tickets: [1], after_cursor: 'n', end_of_stream: false })).toEqual({ records: [1], nextCursor: 'n' });
    expect(parsePage('ticket', { includeArchived: true }, { tickets: [], after_cursor: 'n', end_of_stream: true }).nextCursor).toBeNull();
    expect(parsePage('user', { text: 'x' }, { results: [1, 2], meta: { has_more: true, after_cursor: 'c2' } })).toMatchObject({ records: [1, 2], nextCursor: 'c2' });
    expect(parsePage('organization', {}, { organizations: [], meta: { has_more: false, after_cursor: 'z' } }).nextCursor).toBeNull();
  });

  it('builds a name-based catalog with ZAF keys and maps roles', () => {
    const c = buildCatalog([...synthetic.zendeskTicketFieldsRaw(), { id: 3, title: 'Priority', type: 'priority' }, { id: 4, title: 'Type', type: 'tickettype' }], [{ id: 1, name: 'Billing' }]);
    expect(c.fields.find((f) => f.name === 'Customer Tier')).toMatchObject({ id: '360001', key: 'custom_field_360001', type: 'dropdown' });
    expect(c.fields.find((f) => f.id === 'type')).toMatchObject({ key: 'type', system: true });
    expect(c.groups).toEqual([{ id: '1', name: 'Billing' }]);
    expect(ticketValuePath('custom_field_1')).toBe('ticket.customField:custom_field_1');
    expect(ticketValuePath('priority')).toBe('ticket.priority');
    expect(keyForId('360001')).toBe('custom_field_360001');
    expect(canonicalRole('admin')).toEqual({ role: 'admin' });
    expect(canonicalRole('123', 'Light Agent')).toEqual({ role: 'light_agent', customRole: 'Light Agent' });
    expect(canonicalRole('456', 'Billing Specialist')).toEqual({ role: 'agent', customRole: 'Billing Specialist' });
  });

  it('manifest passes the offline ZAF v2 validator', () => {
    expect(validateZendeskApp(new URL('..', import.meta.url).pathname, { requireBuild: false })).toEqual([]);
  });
});

describe('ZendeskHost end-to-end against the core API (fake ZAF + proxy)', () => {
  it('admin first-run install stores the secret in the secure setting, then exports 1,500 users past the 1,000 wall', async () => {
    const z = fakeZendesk({ users: synthetic.zendeskUsers(1800) });
    const host = new ZendeskHost(z.client, memoryStorage(), { open: () => null });
    const api = new HpsApiClient(host);
    const state = await ensureInstalled(host, api, await host.currentUser());
    expect(state.state).toBe('ready');
    expect(z.settings.shared_secret!.length).toBeGreaterThan(30);
    expect(JSON.stringify(await z.client.metadata())).not.toContain(z.settings.shared_secret!);

    await z.deps.entitlements.grant('zendesk:acme', { plan: 'pro', status: 'active', source: 'manual', currentPeriodEnd: '2999-01-01T00:00:00Z' });
    const out = await runCursorExport(host, api, { entity: 'user', query: {}, filters: { userState: 'active', tags: { none: ['churn_risk'] } }, format: 'csv' });
    const expected = z.users.filter((u) => !u.suspended && !u.tags.includes('churn_risk')).length;
    expect(out!.stats).toMatchObject({ rows: expected, batches: 18 });
    expect(expected).toBeGreaterThan(1000);
    const csv = parseCsv(await (await z.app.request(out!.downloadUrl.replace('https://api.test', ''))).text());
    expect(csv.length - 1).toBe(expected);
    expect(csv[0]).toContain('Customer Plan');
  });

  it('agents cannot install; unregistered agents get needs_admin', async () => {
    const z = fakeZendesk({ role: 'agent' });
    const host = new ZendeskHost(z.client, memoryStorage());
    expect((await ensureInstalled(host, new HpsApiClient(host), await host.currentUser())).state).toBe('needs_admin');
  });

  it('sidebar enforces per-group rules via ticketFields invoke and blocks saves missing required fields', async () => {
    const z = fakeZendesk();
    const admin = new ZendeskHost(z.client, memoryStorage());
    const api = new HpsApiClient(admin);
    await ensureInstalled(admin, api, await admin.currentUser());
    await api.syncCatalog(await admin.ruleCatalog());
    await api.createRule({ name: 'Tier 1 hides escalation notes', conditions: { groups: ['Tier 1 Support'] }, actions: [{ type: 'hide', field: 'Internal Escalation Notes' }, { type: 'disable', field: 'Priority' }] });
    await api.createRule({ name: 'VIP needs tier', conditions: { tags: { any: ['vip'] } }, actions: [{ type: 'require', field: 'Customer Tier' }] });

    // Same account, an agent in Tier 1 opens a ticket (sidebar location).
    const agentZ = { ...z, client: { ...z.client, context: async () => ({ location: 'ticket_sidebar', account: { subdomain: 'acme' } }), get: async (p: string | string[]) => {
      const r = await z.client.get(p);
      if (r.currentUser) (r.currentUser as Record<string, unknown>).role = 'agent';
      return r;
    } } };
    const status = { textContent: '' } as HTMLElement;
    const enforcer = await startEnforcer(agentZ.client, status);
    expect(z.invokes).toEqual(expect.arrayContaining(['ticketFields:custom_field_360004.hide', 'ticketFields:priority.disable']));
    expect(status.textContent).toMatch(/3 fields adjusted/);
    const saveHandler = z.handlers.get('ticket.save')![0]!;
    await expect(saveHandler()).rejects.toMatch(/Customer Tier/);
    z.ticket['ticket.customField:custom_field_360001'] = 'tier_enterprise';
    await expect(saveHandler()).resolves.toBe(true);
    enforcer.stop();
  });
});
