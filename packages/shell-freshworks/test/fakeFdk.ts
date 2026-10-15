import { createServices } from '@hps/core-api';
import { createServerless, type FdkServerEnv, type TemplateResponse } from '../src/server/serverless.js';
import type { FdkClient } from '../src/fdk.js';

type Json = Record<string, any>;

export function makeTickets(n: number) {
  const base = Date.UTC(2021, 0, 1);
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    subject: `Ticket ${i + 1}`,
    status: [2, 3, 4, 5][i % 4],
    priority: (i % 4) + 1,
    source: 1,
    tags: i % 5 === 0 ? ['vip'] : [],
    group_id: 9000 + (i % 3),
    custom_fields: { cf_customer_tier: ['Gold', 'Silver'][i % 2], cf_refund_amount: i % 7 === 0 ? 10.5 : null },
    created_at: new Date(base + i * 3_600_000).toISOString(),
    updated_at: new Date(base + i * 3_600_000).toISOString().replace('.000', ''),
  }));
}

/** Freshdesk + Power Suite API behind FDK request templates, plus the serverless runtime ($db). */
export function fakeFreshworks(opts: { tickets?: Json[]; domain?: string } = {}) {
  const { app, deps } = createServices({ masterSecret: 'f'.repeat(64), config: { publicBaseUrl: 'https://api.test' }, logger: { error() {}, warn() {}, info() {} } });
  const tickets = opts.tickets ?? makeTickets(2500);
  const db = new Map<string, unknown>();
  const templateCalls: string[] = [];
  const meta: Record<string, Json[]> = {
    '/api/v2/ticket_fields': [
      { id: 1, name: 'priority', label: 'Priority', type: 'default_priority', default: true, choices: { Low: 1, Medium: 2, High: 3, Urgent: 4 } },
      { id: 2, name: 'status', label: 'Status', type: 'default_status', default: true },
      { id: 3, name: 'cf_customer_tier', label: 'Customer Tier', type: 'custom_dropdown', default: false, choices: ['Gold', 'Silver'] },
      { id: 4, name: 'cf_refund_amount', label: 'Refund Amount', type: 'custom_decimal', default: false },
    ],
    '/api/v2/contact_fields': [{ name: 'cf_plan', label: 'Plan', type: 'custom_text', default: false }],
    '/api/v2/company_fields': [],
    '/api/v2/groups': [{ id: 9000, name: 'L1 Support' }, { id: 9001, name: 'L2 Escalations' }],
    '/api/v2/roles': [{ id: 1, name: 'Account Administrator' }, { id: 2, name: 'Agent' }],
    '/api/v2/products': [],
  };

  const freshdesk = (name: string, ctx: Json): TemplateResponse => {
    if (name === 'fdMeta') return { status: 200, response: JSON.stringify(meta[ctx.path] ?? []) };
    if (name === 'fdTickets') {
      if (Number(ctx.page) > 300) return { status: 400, response: '{"description":"page > 300"}' };
      const since = Date.parse(ctx.updated_since);
      const sorted = tickets.filter((t) => Date.parse(t.updated_at) >= since);
      const page = Number(ctx.page);
      return { status: 200, response: JSON.stringify(sorted.slice((page - 1) * 100, page * 100)) };
    }
    return { status: 200, response: '[]' };
  };

  const env: FdkServerEnv = {
    $db: { get: async (k) => (db.has(k) ? db.get(k) : Promise.reject({ status: 404 })), set: async (k, v) => db.set(k, v), delete: async (k) => db.delete(k) },
    $request: {
      async invokeTemplate(name, { context = {}, body }) {
        templateCalls.push(name);
        if (!name.startsWith('hps')) return freshdesk(name, context);
        const method = name === 'hpsGet' ? 'GET' : name === 'hpsPut' ? 'PUT' : name === 'hpsDelete' ? 'DELETE' : 'POST';
        const path = name === 'hpsInstall' ? '/v1/install' : String(context.path);
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (context.token) headers.authorization = `Bearer ${context.token}`;
        if (context.etag) headers['if-none-match'] = String(context.etag);
        const res = await app.request(path, { method, headers, body });
        const out = { status: res.status, response: await res.text(), headers: Object.fromEntries(res.headers) };
        if (res.status >= 400) throw out; // FDK rejects non-2xx
        return out;
      },
    },
  };
  const serverless = createServerless(env);

  const triggers: [string, Json][] = [];
  const intercepts = new Map<string, (e: any) => void>();
  const ticket: Json = { id: 1, tags: ['vip'], priority: 1, status: 2, group_id: 9000, custom_fields: { cf_customer_tier: null } };
  const client: FdkClient = {
    data: {
      async get(name) {
        if (name === 'domainName') return { domainName: opts.domain ?? 'globex.freshdesk.com' };
        if (name === 'loggedInUser') return { loggedInUser: { id: 55, contact: { name: 'Lee' }, group_ids: [9000], role_ids: [2] } };
        if (name === 'ticket') return { ticket };
        throw new Error(name);
      },
    },
    iparams: { get: async () => ({}) },
    request: {
      async invoke(fn, args) {
        const s = serverless as unknown as Record<string, (a: unknown) => Promise<unknown>>;
        return { response: await s[fn]!.call(serverless, args) };
      },
      async invokeTemplate(name, o) {
        const r = freshdesk(name, o.context ?? {});
        return r;
      },
    },
    interface: {
      async trigger(action, o) {
        triggers.push([action, o]);
        return {};
      },
    },
    events: {
      on(event, cb, o) {
        if (o?.intercept) intercepts.set(event, cb);
      },
    },
  };
  return { app, deps, env, serverless, db, client, triggers, intercepts, ticket, templateCalls, tickets };
}
