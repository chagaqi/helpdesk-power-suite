import { createServices, synthetic, zendeskFieldSchema, type Catalog, type EntityType } from '@hps/core-api';
import { memoryStorage } from '../src/storage.js';
import type { HostAdapter, HostUser, PageResult } from '../src/types.js';

/** A HostAdapter wired to an in-process core API (tokens minted exactly like the platform proxies do). */
export async function localHost(opts: { user?: HostUser; users?: unknown[]; pageSize?: number; overlap?: number; pro?: boolean } = {}) {
  const { app, deps } = createServices({ masterSecret: 'z'.repeat(64), config: { publicBaseUrl: 'https://api.test' }, logger: { error() {}, warn() {}, info() {} } });
  const reg = await deps.installs.register({ platform: 'zendesk', tenant: 'acme', installationId: 'inst' });
  if (opts.pro) await deps.entitlements.grant(reg.tenant, { plan: 'pro', status: 'active', source: 'manual', currentPeriodEnd: '2999-01-01T00:00:00Z' });
  const user: HostUser = opts.user ?? { id: '1', role: 'admin', groups: [{ id: '300', name: 'Tier 1 Support' }] };
  const users = opts.users ?? synthetic.zendeskUsers(1000);
  const pages = synthetic.cursorPages(users, opts.pageSize ?? 100, opts.overlap ?? 0);
  const fetchCalls: (string | null)[] = [];
  const host: HostAdapter = {
    platform: 'zendesk',
    tenant: async () => 'acme',
    currentUser: async () => user,
    async api(method, path, body, headers) {
      const token = await deps.installs.issueToken(reg.sharedSecret, reg.tenant, reg.installationId, user as never);
      const res = await app.request(path, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(headers ?? {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, data: text ? JSON.parse(text) : null, headers: Object.fromEntries(res.headers) };
    },
    async fetchPage(_entity: EntityType, cursor): Promise<PageResult> {
      fetchCalls.push(cursor);
      const p = pages.find((x) => x.cursor === cursor);
      if (!p) throw new Error(`unknown cursor ${cursor}`);
      return { records: p.records, nextCursor: p.nextCursor, total: users.length };
    },
    fieldSchema: async () => zendeskFieldSchema('user', synthetic.zendeskUserFieldsRaw()),
    ruleCatalog: async (): Promise<Catalog> => ({
      fields: [
        { id: 'priority', name: 'Priority', key: 'priority', system: true },
        { id: '360001', name: 'Customer Tier', key: 'custom_field_360001', type: 'dropdown', options: [{ value: 'tier_enterprise', label: 'Enterprise' }] },
        { id: '360002', name: 'Refund Amount', key: 'custom_field_360002', type: 'decimal' },
      ],
      groups: [{ id: '300', name: 'Tier 1 Support' }, { id: '301', name: 'Tier 2 Escalations' }],
    }),
    storage: memoryStorage(),
    openUrl: () => undefined,
  };
  return { host, app, deps, reg, fetchCalls, users };
}
