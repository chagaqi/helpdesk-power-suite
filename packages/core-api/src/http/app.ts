import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import type { InstallService, Principal } from '../auth/InstallService.js';
import { createCheckout, type CheckoutConfig } from '../billing/checkout.js';
import type { EntitlementService } from '../billing/EntitlementService.js';
import { verifyHmacHeader, verifyStandardWebhook, verifyStripeSignature, type BillingWebhookHandler } from '../billing/webhooks.js';
import { buildMultiSheetWorkbook, defaultSheetName, ExportSession, type ExportStats } from '../export/CursorExportEngine.js';
import type { ExportSessionManager } from '../export/ExportSessionManager.js';
import { XLSX_MIME } from '../export/xlsx.js';
import type { LinkSigner } from '../export/signedLinks.js';
import type { VisualFieldRuleEngine } from '../rules/VisualFieldRuleEngine.js';
import { catalogInputSchema, evalContextSchema, ruleInputSchema } from '../rules/schemas.js';
import type { EvalContext } from '../rules/types.js';
import type { IUsageStore } from '../stores/IUsageStore.js';
import { base64ToBytes, bytesToBase64, utf8 } from '../util/encoding.js';
import { randomId } from '../util/crypto.js';
import { HpsError } from '../util/errors.js';
import type { RateLimiter } from '../util/rateLimit.js';
import { batchSchema, finalizeSchema, installSchema, oneShotSchema, reorderSchema, sessionCreateSchema, xlsxSchema } from './schemas.js';

export interface CoreApiConfig {
  publicBaseUrl: string;
  polarWebhookSecret?: string;
  stripeWebhookSecret?: string;
  marketplaceWebhookSecret?: string;
  checkout?: CheckoutConfig;
  /** Signed download link lifetime. Default 15 minutes. */
  downloadTtlSec?: number;
  /** Max JSON body for export endpoints. Default 25 MB. */
  maxExportBodyBytes?: number;
  installRateLimit?: { limit: number; windowSec: number };
  apiRateLimit?: { limit: number; windowSec: number };
  corsOrigins?: string[] | '*';
}

export interface CoreApiDeps {
  store: IUsageStore;
  installs: InstallService;
  entitlements: EntitlementService;
  rules: VisualFieldRuleEngine;
  exports: ExportSessionManager;
  signer: LinkSigner;
  webhooks: BillingWebhookHandler;
  rateLimiter: RateLimiter;
  config: CoreApiConfig;
  getClientIp: (c: Context) => string;
  fetch?: typeof fetch;
  logger?: Pick<Console, 'error' | 'warn' | 'info'>;
}

export type AppEnv = { Variables: { principal: Principal; requestId: string } };

async function parse<S extends ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HpsError('invalid_request', 'Request body must be valid JSON');
  }
  return schema.parse(body);
}

const safeFilename = (name: string, ext: string) => {
  const base = name.replace(/\.(csv|xlsx)$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 100) || 'export';
  return `${base}.${ext}`;
};

const statsHeaders = (st: ExportStats): Record<string, string> => ({
  'X-HPS-Rows': String(st.rows),
  'X-HPS-Duplicates-Removed': String(st.duplicatesDropped),
  'X-HPS-Filtered-Out': String(st.filteredOut),
  'X-HPS-Truncated': String(st.truncated),
  'X-HPS-Limit-Reached': String(st.limitReached),
});

export function createCoreApi(deps: CoreApiDeps) {
  const { config } = deps;
  const app = new Hono<AppEnv>();
  const log = deps.logger ?? console;
  const downloadTtl = config.downloadTtlSec ?? 900;

  app.use('*', async (c, next) => {
    const id = c.req.header('x-request-id')?.slice(0, 64) || randomId(8);
    c.set('requestId', id);
    await next();
    c.header('X-Request-Id', id);
  });
  app.use(
    '/v1/*',
    cors({
      origin: config.corsOrigins === undefined || config.corsOrigins === '*' ? '*' : config.corsOrigins,
      allowHeaders: ['Authorization', 'Content-Type', 'If-None-Match', 'X-Request-Id'],
      exposeHeaders: ['ETag', 'X-HPS-Rows', 'X-HPS-Duplicates-Removed', 'X-HPS-Filtered-Out', 'X-HPS-Truncated', 'X-HPS-Limit-Reached', 'Retry-After'],
      maxAge: 600,
    }),
  );

  app.onError((err, c) => {
    if (err instanceof HpsError) return c.json(err.toJSON(), err.status as 400);
    if (err instanceof ZodError) {
      return c.json({ error: { code: 'invalid_request', message: 'Request validation failed', details: err.issues.slice(0, 50) } }, 400);
    }
    if (err instanceof RangeError) return c.json({ error: { code: 'invalid_request', message: err.message } }, 400);
    log.error(`[${c.get('requestId')}]`, err);
    return c.json({ error: { code: 'internal', message: 'Internal error', requestId: c.get('requestId') } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404));

  const rateLimit = (bucket: string, limit: number, windowSec: number, key: (c: Context<AppEnv>) => string): MiddlewareHandler<AppEnv> =>
    async (c, next) => {
      const r = await deps.rateLimiter.hit(bucket, key(c), limit, windowSec);
      c.header('X-RateLimit-Limit', String(r.limit));
      c.header('X-RateLimit-Remaining', String(r.remaining));
      if (!r.allowed) {
        c.header('Retry-After', String(Math.max(1, Math.ceil((r.resetAt - Date.now()) / 1000))));
        throw new HpsError('rate_limited', 'Too many requests');
      }
      await next();
    };

  const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
    const h = c.req.header('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) throw new HpsError('unauthorized', 'Missing bearer token');
    c.set('principal', await deps.installs.verify(m[1]!.trim()));
    await next();
  };
  const adminOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.get('principal').user.role !== 'admin') throw new HpsError('forbidden', 'Admin role required');
    await next();
  };
  const apiLimit = config.apiRateLimit ?? { limit: 600, windowSec: 60 };
  const tenantLimiter = rateLimit('api', apiLimit.limit, apiLimit.windowSec, (c) => c.get('principal').tenant);
  const exportBody = bodyLimit({
    maxSize: config.maxExportBodyBytes ?? 25 * 1024 * 1024,
    onError: () => {
      throw new HpsError('payload_too_large', 'Batch too large: send smaller cursor pages');
    },
  });

  app.get('/healthz', (c) => c.json({ ok: true, service: 'helpdesk-power-suite', time: new Date().toISOString() }));

  // ---------------------------------------------------------------- install / identity
  const il = config.installRateLimit ?? { limit: 20, windowSec: 3600 };
  app.post('/v1/install', rateLimit('install', il.limit, il.windowSec, (c) => deps.getClientIp(c)), async (c) => {
    const body = await parse(c, installSchema);
    const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    const res = await deps.installs.register(body, { bearerToken: bearer, platformToken: body.platformToken });
    c.header('Cache-Control', 'no-store');
    return c.json(
      { tenant: res.tenant, installationId: res.installationId, sharedSecret: res.sharedSecret, created: res.created, verifiedBy: res.verifiedBy, audience: 'helpdesk-power-suite' },
      res.created ? 201 : 200,
    );
  });

  app.use('/v1/uninstall', auth, adminOnly);
  app.post('/v1/uninstall', async (c) => {
    const p = c.get('principal');
    return c.json(await deps.installs.uninstall(p.tenant, p.installationId));
  });

  app.use('/v1/me', auth);
  app.get('/v1/me', async (c) => {
    const p = c.get('principal');
    const ent = await deps.entitlements.get(p.tenant);
    return c.json({ tenant: p.tenant, platform: p.platform, installationId: p.installationId, user: p.user, entitlement: ent, usage: { exportRowsThisMonth: await deps.entitlements.usageThisMonth(p.tenant) } });
  });

  app.use('/v1/billing/*', auth, adminOnly);
  app.post('/v1/billing/checkout', async (c) => {
    if (!config.checkout) throw new HpsError('not_found', 'Self-serve checkout is not configured; upgrade via the marketplace listing.');
    const p = c.get('principal');
    return c.json(await createCheckout(config.checkout, p.tenant, deps.fetch));
  });

  // ---------------------------------------------------------------- Module A: export
  app.use('/v1/export/*', auth, tenantLimiter);

  const newSession = async (tenant: string, body: z.infer<typeof sessionCreateSchema>, register: boolean) => {
    const rowLimit = await deps.entitlements.exportRowLimit(tenant);
    const opts = { entity: body.entity, source: body.source, fieldSchema: body.fieldSchema, filters: body.filters, columns: body.columns, dedupe: body.dedupe, rowLimit };
    return register ? deps.exports.create(tenant, opts) : new ExportSession(opts);
  };

  app.post('/v1/export/stream', exportBody, async (c) => {
    const p = c.get('principal');
    const body = await parse(c, oneShotSchema);
    const session = await newSession(p.tenant, body, false);
    session.ingest({ records: body.records, format: body.format, done: true });
    await deps.entitlements.recordExport(p.tenant, session.size);
    const chunks = session.csvChunks({ delimiter: body.delimiter });
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(utf8(next.value));
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeFilename(body.filename ?? defaultSheetName(body.entity).toLowerCase(), 'csv')}"`,
        'Cache-Control': 'no-store',
        ...statsHeaders(session.stats),
      },
    });
  });

  app.post('/v1/export/xlsx', exportBody, async (c) => {
    const p = c.get('principal');
    const body = await parse(c, xlsxSchema);
    await deps.entitlements.assertSheets(p.tenant, body.sheets.length);
    const sessions = [];
    for (const s of body.sheets) {
      const session = await newSession(p.tenant, s, false);
      session.ingest({ records: s.records, format: s.format, done: true });
      sessions.push({ session, sheetName: s.sheetName });
    }
    const bytes = buildMultiSheetWorkbook(sessions, { title: body.title });
    const rows = sessions.reduce((n, s) => n + s.session.size, 0);
    await deps.entitlements.recordExport(p.tenant, rows);
    return new Response(bytes as Uint8Array<ArrayBuffer>, {
      headers: {
        'Content-Type': XLSX_MIME,
        'Content-Disposition': `attachment; filename="${safeFilename(body.filename ?? 'helpdesk-export', 'xlsx')}"`,
        'Cache-Control': 'no-store',
        'X-HPS-Rows': String(rows),
        'X-HPS-Truncated': String(sessions.reduce((n, s) => n + s.session.stats.truncated, 0)),
      },
    });
  });

  app.post('/v1/export/sessions', async (c) => {
    const p = c.get('principal');
    const body = await parse(c, sessionCreateSchema);
    const session = await newSession(p.tenant, body, true);
    return c.json({ id: session.id, columns: session.columns.map((col) => col.label), stats: session.stats }, 201);
  });

  app.get('/v1/export/sessions/:id', (c) => {
    const s = deps.exports.get(c.get('principal').tenant, c.req.param('id'));
    return c.json({ id: s.id, stats: s.stats });
  });

  app.post('/v1/export/sessions/:id/batches', exportBody, async (c) => {
    const s = deps.exports.get(c.get('principal').tenant, c.req.param('id'));
    const batch = await parse(c, batchSchema);
    return c.json(s.ingest(batch));
  });

  app.post('/v1/export/sessions/:id/finalize', async (c) => {
    const p = c.get('principal');
    const s = deps.exports.get(p.tenant, c.req.param('id'));
    const body = await parse(c, finalizeSchema);
    const isXlsx = body.format === 'xlsx';
    const bytes = isXlsx ? s.toXlsx({ sheetName: body.sheetName }) : utf8(s.toCsv({ delimiter: body.delimiter }));
    const fileId = randomId(18);
    const filename = safeFilename(body.filename ?? `${defaultSheetName(s.entity).toLowerCase()}-${new Date().toISOString().slice(0, 10)}`, isXlsx ? 'xlsx' : 'csv');
    const meta = { filename, contentType: isXlsx ? XLSX_MIME : 'text/csv; charset=utf-8', size: bytes.length, tenant: p.tenant, rows: s.size };
    await deps.store.set(`export:blob:${fileId}`, bytesToBase64(bytes), { ttlSeconds: downloadTtl });
    await deps.store.set(`export:meta:${fileId}`, JSON.stringify(meta), { ttlSeconds: downloadTtl });
    await deps.entitlements.recordExport(p.tenant, s.size);
    const link = await deps.signer.url(config.publicBaseUrl, fileId, downloadTtl);
    const ent = await deps.entitlements.get(p.tenant);
    return c.json({
      downloadUrl: link.url,
      expiresAt: link.expiresAt,
      filename,
      bytes: bytes.length,
      stats: s.stats,
      plan: ent.effectivePlan,
      ...(s.stats.limitReached && ent.effectivePlan === 'free' ? { upgrade: { message: `Free plan exports are limited to ${ent.limits.maxExportRows} rows.`, url: deps.entitlements.upgradeUrl } } : {}),
    });
  });

  app.delete('/v1/export/sessions/:id', (c) => {
    deps.exports.delete(c.get('principal').tenant, c.req.param('id'));
    return c.body(null, 204);
  });

  // Signed ephemeral download (no bearer: opened directly by the browser).
  app.get('/v1/exports/:id', async (c) => {
    const id = c.req.param('id');
    const verdict = await deps.signer.verify(id, c.req.query('exp'), c.req.query('sig'));
    if (verdict === 'invalid') throw new HpsError('forbidden', 'Invalid download signature');
    if (verdict === 'expired') throw new HpsError('gone', 'Download link expired; export again');
    const [b64, metaRaw] = await Promise.all([deps.store.get(`export:blob:${id}`), deps.store.get(`export:meta:${id}`)]);
    if (!b64 || !metaRaw) throw new HpsError('gone', 'Export file expired; export again');
    const meta = JSON.parse(metaRaw) as { filename: string; contentType: string };
    return new Response(base64ToBytes(b64) as Uint8Array<ArrayBuffer>, {
      headers: {
        'Content-Type': meta.contentType,
        'Content-Disposition': `attachment; filename="${meta.filename}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    });
  });

  // ---------------------------------------------------------------- Module B: rules
  // NB: '/v1/rules/*' also matches '/v1/rules' in Hono — register auth once.
  app.use('/v1/rules/*', auth, tenantLimiter);

  app.get('/v1/rules/config', async (c) => {
    const p = c.get('principal');
    const cfg = await deps.rules.config(p.tenant);
    const etag = `"${cfg.version}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', 'private, max-age=0, must-revalidate');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    if (p.user.role === 'admin') return c.json(cfg);
    return c.json({ version: cfg.version, compiled: cfg.compiled, limits: cfg.limits });
  });

  app.get('/v1/rules', async (c) => c.json({ rules: await deps.rules.list(c.get('principal').tenant) }));

  app.put('/v1/rules/catalog', adminOnly, async (c) => {
    const body = await parse(c, catalogInputSchema);
    return c.json(await deps.rules.syncCatalog(c.get('principal').tenant, body));
  });

  app.post('/v1/rules/validate', adminOnly, async (c) => {
    const body = await parse(c, ruleInputSchema);
    const res = deps.rules.resolve(body, await deps.rules.getCatalog(c.get('principal').tenant));
    return c.json({ ok: res.problems.length === 0, problems: res.problems, resolved: res.rule ?? null });
  });

  app.post('/v1/rules/reorder', adminOnly, async (c) => {
    const body = await parse(c, reorderSchema);
    return c.json({ rules: await deps.rules.reorder(c.get('principal').tenant, body.ids) });
  });

  app.post('/v1/rules/evaluate', async (c) => {
    const p = c.get('principal');
    const body = await parse(c, evalContextSchema);
    // Anti-spoofing: the agent's role/groups come from the verified token. Admins may preview as someone else.
    const user = p.user.role === 'admin' && body.user ? body.user : { id: p.user.id, role: p.user.role, customRole: p.user.customRole, groups: p.user.groups };
    const ctx: EvalContext = { user: { ...user, groups: user.groups ?? [] }, ticket: body.ticket };
    return c.json(await deps.rules.evaluate(p.tenant, ctx));
  });

  app.post('/v1/rules', adminOnly, async (c) => {
    const body = await parse(c, ruleInputSchema);
    return c.json(await deps.rules.create(c.get('principal').tenant, body), 201);
  });

  app.put('/v1/rules/:id', adminOnly, async (c) => {
    const body = await parse(c, ruleInputSchema);
    return c.json(await deps.rules.update(c.get('principal').tenant, c.req.param('id'), body));
  });

  app.delete('/v1/rules/:id', adminOnly, async (c) => {
    await deps.rules.remove(c.get('principal').tenant, c.req.param('id'));
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------- billing webhooks
  app.post('/v1/webhooks/polar', async (c) => {
    if (!config.polarWebhookSecret) throw new HpsError('not_found', 'Polar webhooks not configured');
    const raw = await c.req.text();
    await verifyStandardWebhook(config.polarWebhookSecret, { id: c.req.header('webhook-id'), timestamp: c.req.header('webhook-timestamp'), signature: c.req.header('webhook-signature') }, raw);
    const out = await deps.webhooks.handlePolar(c.req.header('webhook-id')!, JSON.parse(raw));
    return c.json(out, 202);
  });

  app.post('/v1/webhooks/stripe', async (c) => {
    if (!config.stripeWebhookSecret) throw new HpsError('not_found', 'Stripe webhooks not configured');
    const raw = await c.req.text();
    await verifyStripeSignature(config.stripeWebhookSecret, c.req.header('stripe-signature'), raw);
    return c.json(await deps.webhooks.handleStripe(JSON.parse(raw)), 202);
  });

  app.post('/v1/webhooks/marketplace', async (c) => {
    if (!config.marketplaceWebhookSecret) throw new HpsError('not_found', 'Marketplace webhooks not configured');
    const raw = await c.req.text();
    await verifyHmacHeader(config.marketplaceWebhookSecret, c.req.header('x-hps-signature'), raw);
    return c.json(await deps.webhooks.handleMarketplace(JSON.parse(raw)), 202);
  });

  return app;
}
