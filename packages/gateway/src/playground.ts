import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  ExportSession,
  HpsError,
  InMemoryUsageStore,
  EntitlementService,
  VisualFieldRuleEngine,
  XLSX_MIME,
  bytesToBase64Url,
  evaluateRules,
  randomId,
  ruleInputSchema,
  synthetic,
  zendeskFieldSchema,
  type Catalog,
  type CoreApiDeps,
  type FieldRule,
} from '@hps/core-api';
import { playgroundHtml } from './playgroundHtml.js';

/**
 * /playground — public, IP rate-limited interactive demo. Generates realistic Zendesk-shaped data
 * server-side (no customer data involved), runs it through the real export engine and rule
 * evaluator, and hands back signed download links.
 */

const userSchema = zendeskFieldSchema('user', synthetic.zendeskUserFieldsRaw());
const ticketSchema = zendeskFieldSchema('ticket', synthetic.zendeskTicketFieldsRaw());

export const DEMO_CATALOG: Catalog = {
  fields: [
    { id: 'priority', name: 'Priority', key: 'priority', type: 'system', system: true, options: ['low', 'normal', 'high', 'urgent'].map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) })) },
    { id: 'type', name: 'Type', key: 'type', type: 'system', system: true },
    ...ticketSchema.map((d) => ({ id: d.key, name: d.title, key: `custom_field_${d.key}`, type: d.type, options: d.options })),
  ],
  groups: [
    { id: '300', name: 'Tier 1 Support' },
    { id: '301', name: 'Tier 2 Escalations' },
    { id: '302', name: 'Billing' },
  ],
};

const exportSchema = z.object({
  entity: z.enum(['user', 'ticket']).default('user'),
  count: z.number().int().min(1).max(50_000).default(1500),
  pageSize: z.number().int().min(10).max(1000).default(100),
  simulateDuplicates: z.boolean().default(true),
  simulateTabSwitch: z.boolean().default(true),
  format: z.enum(['csv', 'xlsx']).default('csv'),
  columns: z.array(z.string().max(200)).max(100).optional(),
  filters: z
    .object({
      userState: z.enum(['all', 'active', 'suspended']).optional(),
      roles: z.array(z.enum(['admin', 'agent', 'light_agent', 'end_user'])).max(4).optional(),
      tags: z.object({ any: z.array(z.string().max(50)).max(20).optional(), none: z.array(z.string().max(50)).max(20).optional() }).optional(),
      includeArchived: z.boolean().optional(),
      statuses: z.array(z.string().max(30)).max(10).optional(),
    })
    .default({}),
});

const evaluateSchema = z.object({
  rules: z.array(ruleInputSchema).max(20),
  context: z.object({
    user: z.object({ role: z.string().max(40), groups: z.array(z.string().max(100)).max(10).default([]) }),
    ticket: z.object({ tags: z.array(z.string().max(50)).max(30).default([]), fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(), isNew: z.boolean().optional() }).default({ tags: [] }),
  }),
});

export interface PlaygroundOptions {
  rateLimit: number;
  rateWindowSec: number;
  maxRecords: number;
  downloadTtlSec: number;
}

export function createPlayground(deps: CoreApiDeps, o: PlaygroundOptions) {
  const app = new Hono();
  // Resolution only (no persistence): a private engine on a throwaway store.
  const resolver = new VisualFieldRuleEngine(new InMemoryUsageStore(), new EntitlementService(new InMemoryUsageStore()));

  app.get('/playground', (c) => {
    const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    c.header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    c.header('X-Frame-Options', 'DENY');
    c.header('Cache-Control', 'no-store');
    return c.html(playgroundHtml(nonce, { maxRecords: o.maxRecords, rateLimit: o.rateLimit }));
  });

  // Registered before the limiter: static metadata loaded on every page view.
  app.get('/playground/api/catalog', (c) => c.json({ catalog: DEMO_CATALOG, userFields: userSchema.map((d) => d.title), ticketFields: ticketSchema.map((d) => d.title) }));

  app.use('/playground/api/*', async (c, next) => {
    const r = await deps.rateLimiter.hit('playground', deps.getClientIp(c), o.rateLimit, o.rateWindowSec);
    c.header('X-RateLimit-Limit', String(r.limit));
    c.header('X-RateLimit-Remaining', String(r.remaining));
    if (!r.allowed) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((r.resetAt - Date.now()) / 1000))));
      throw new HpsError('rate_limited', `Playground limit reached (${o.rateLimit} requests per ${Math.round(o.rateWindowSec / 60)} min). Install the app for unlimited use.`);
    }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof HpsError) return c.json(err.toJSON(), err.status as 400);
    if (err instanceof z.ZodError) return c.json({ error: { code: 'invalid_request', message: 'Invalid playground request', details: err.issues.slice(0, 10) } }, 400);
    if (err instanceof RangeError) return c.json({ error: { code: 'invalid_request', message: err.message } }, 400);
    deps.logger?.error?.(err);
    return c.json({ error: { code: 'internal', message: 'Internal error' } }, 500);
  });


  app.post('/playground/api/export', async (c: Context) => {
    const body = exportSchema.parse(await c.req.json().catch(() => ({})));
    if (body.count > o.maxRecords) throw new HpsError('invalid_request', `The playground generates at most ${o.maxRecords} records`);
    const records = body.entity === 'user' ? synthetic.zendeskUsers(body.count) : synthetic.zendeskTickets(body.count, { archivedEvery: 3 });
    const pages = synthetic.cursorPages<unknown>(records, body.pageSize, body.simulateDuplicates ? Math.min(10, Math.floor(body.pageSize / 10)) : 0);
    const session = new ExportSession({
      entity: body.entity,
      source: 'zendesk',
      fieldSchema: body.entity === 'user' ? userSchema : ticketSchema,
      filters: body.filters,
      columns: body.columns,
      rowLimit: o.maxRecords,
    });
    pages.forEach((p, i) => {
      session.ingest(p);
      // Simulate an agent switching tabs mid-export: the first two pages are re-sent.
      if (body.simulateTabSwitch && i === 3) {
        session.ingest(pages[0]!);
        session.ingest(pages[1]!);
      }
    });
    const xlsx = body.format === 'xlsx';
    const bytes = xlsx ? session.toXlsx({ title: 'Helpdesk Power Suite — Playground export' }) : new TextEncoder().encode(session.toCsv());
    const id = randomId(18);
    const filename = `playground-${body.entity}s.${xlsx ? 'xlsx' : 'csv'}`;
    await deps.store.set(`export:blob:${id}`, Buffer.from(bytes).toString('base64'), { ttlSeconds: o.downloadTtlSec });
    await deps.store.set(`export:meta:${id}`, JSON.stringify({ filename, contentType: xlsx ? XLSX_MIME : 'text/csv; charset=utf-8', size: bytes.length, tenant: 'playground', rows: session.size }), { ttlSeconds: o.downloadTtlSec });
    const link = await deps.signer.url(deps.config.publicBaseUrl, id, o.downloadTtlSec);
    const cols = session.columns;
    return c.json({
      downloadUrl: new URL(link.url).pathname + new URL(link.url).search,
      expiresAt: link.expiresAt,
      filename,
      bytes: bytes.length,
      generated: records.length,
      pagesSent: pages.length + (body.simulateTabSwitch && pages.length > 3 ? 2 : 0),
      stats: session.stats,
      columns: cols.map((x) => x.label),
      preview: [...session.rows(cols)].slice(0, 25),
    });
  });

  app.post('/playground/api/evaluate', async (c) => {
    const body = evaluateSchema.parse(await c.req.json().catch(() => ({})));
    const problems: { rule: number; path: string; message: string; suggestions: string[] }[] = [];
    const rules: FieldRule[] = [];
    body.rules.forEach((input, i) => {
      const res = resolver.resolve(input, DEMO_CATALOG);
      if (!res.rule) {
        for (const p of res.problems) problems.push({ rule: i, ...p });
        return;
      }
      rules.push({ id: `r${i + 1}`, name: input.name, enabled: input.enabled ?? true, priority: input.priority ?? (i + 1) * 10, ...res.rule, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' });
    });
    const fieldKeys = Object.fromEntries(DEMO_CATALOG.fields.map((f) => [f.id, { key: f.key ?? f.id, name: f.name }]));
    const ev = evaluateRules(rules, { user: { role: body.context.user.role, groups: body.context.user.groups }, ticket: body.context.ticket }, fieldKeys);
    return c.json({ problems, rules, evaluation: ev });
  });

  return app;
}
