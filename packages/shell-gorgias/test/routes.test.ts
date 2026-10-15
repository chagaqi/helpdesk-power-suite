import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createServices, hmacSha256Hex, ruleInputSchema, type CoreApiDeps } from '@hps/core-api';
import { parseCsv } from '@hps/core-api/export';
import { ACCOUNT_TOKEN_HEADER, createGorgiasRoutes, GorgiasClient, gorgiasAccountToken, gorgiasCatalogFields, gorgiasFieldSchema, type GorgiasRouteDeps } from '../src/index.js';
import { fakeGorgiasFetch, gorgiasTickets, overlappingPages, ticketFieldsRaw } from './fixtures.js';

const SECRET = 'gorgias-widget-secret-0123456789';
const TENANT = 'gorgias:acme';

async function signedPost(app: Hono, path: string, body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body);
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-HPS-Signature': `sha256=${await hmacSha256Hex(secret, raw)}` },
    body: raw,
  });
}

let deps: CoreApiDeps;
let coreApp: Hono<never>;
let app: Hono;
let fetchStub: ReturnType<typeof fakeGorgiasFetch>;

function mount(extra: Partial<GorgiasRouteDeps> = {}) {
  const routes = createGorgiasRoutes({
    rules: deps.rules,
    entitlements: deps.entitlements,
    store: deps.store,
    signer: deps.signer,
    publicBaseUrl: deps.config.publicBaseUrl,
    widgetSecret: SECRET,
    clientFactory: (account) =>
      account === 'acme' ? new GorgiasClient({ account, email: 'ops@acme.com', apiKey: 'k', fetch: fetchStub.fetch, sleep: async () => undefined }) : null,
    ...extra,
  });
  // Gateway-style composition: companion routes + core (which serves the signed download).
  const root = new Hono();
  root.route('/', routes);
  root.route('/', coreApp as unknown as Hono);
  return root;
}

beforeEach(async () => {
  const s = createServices({ masterSecret: 'master-secret-for-tests-0123456789', config: { publicBaseUrl: 'https://hps.test' } });
  deps = s.deps;
  coreApp = s.app as unknown as Hono<never>;
  fetchStub = fakeGorgiasFetch({ pages: { '/api/tickets': overlappingPages(gorgiasTickets(400), 100, 5) } });
  app = mount();

  await deps.rules.syncCatalog(TENANT, { fields: gorgiasCatalogFields(gorgiasFieldSchema(ticketFieldsRaw())), groups: [{ id: '3', name: 'Tier 2' }] });
  await deps.rules.create(
    TENANT,
    ruleInputSchema.parse({ name: 'Hide refund reason from lite agents', conditions: { roles: ['light_agent'] }, actions: [{ type: 'hide', field: 'Refund Reason' }] }),
  );
  await deps.rules.create(
    TENANT,
    ruleInputSchema.parse({ name: 'VIP needs order value', conditions: { tags: { any: ['vip'] } }, actions: [{ type: 'require', field: 'Order Value' }, { type: 'disable', field: 'Refund Reason' }] }),
  );
});

describe('POST /gorgias/widget', () => {
  const body = {
    account: 'Acme',
    ticket: { id: 42, tags: [{ name: 'VIP' }], status: 'open', custom_fields: { '101': { id: 101, value: 'Late' } } },
    user: { id: 9, role: { name: 'lite-agent' }, team_ids: [3] },
  };

  it('rejects missing, malformed and wrong signatures with 401', async () => {
    const none = await app.request('/gorgias/widget', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ error: { code: 'unauthorized' } });

    const wrong = await signedPost(app, '/gorgias/widget', body, 'some-other-secret-0123456789');
    expect(wrong.status).toBe(401);

    // Valid signature over a different body (tampering).
    const raw = JSON.stringify(body);
    const sig = await hmacSha256Hex(SECRET, raw);
    const tampered = await app.request('/gorgias/widget', { method: 'POST', body: raw.replace('lite-agent', 'admin'), headers: { 'X-HPS-Signature': `sha256=${sig}` } });
    expect(tampered.status).toBe(401);
  });

  it('returns hints for rules created by field name', async () => {
    const res = await signedPost(app, '/gorgias/widget', body);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.tenant).toBe(TENANT);
    expect(json.hints).toEqual([
      { field: 'Order Value', fieldId: '102', hidden: false, disabled: false, required: true },
      { field: 'Refund Reason', fieldId: '101', hidden: true, disabled: true, required: false },
    ]);
    expect(json.requiredMissing).toEqual(['Order Value']);
    expect(json.warnings).toEqual([]);
  });

  it('maps admin role, accepts string tags and array custom fields, and clears required when filled', async () => {
    const res = await signedPost(app, '/gorgias/widget', {
      account: 'acme.gorgias.com',
      ticket: { id: '7', tags: 'vip, refund', custom_fields: [{ id: 102, value: 250 }] },
      user: { id: '1', role: { name: 'admin' } },
    });
    const json = (await res.json()) as { hints: { field: string; hidden: boolean }[]; requiredMissing: string[] };
    expect(json.requiredMissing).toEqual([]);
    expect(json.hints.find((h) => h.field === 'Refund Reason')?.hidden).toBe(false);
  });

  it('falls back to the ticket assignee when no agent is supplied', async () => {
    const res = await signedPost(app, '/gorgias/widget', { account: 'acme', ticket: { id: 1, tags: [], assignee_user: { id: 5, role: { name: 'observer-agent' } } } });
    const json = (await res.json()) as { hints: { field: string; hidden: boolean }[] };
    expect(json.hints).toEqual([{ field: 'Refund Reason', fieldId: '101', hidden: true, disabled: false, required: false }]);
  });

  it('accepts the static per-account token (Gorgias sends fixed headers) bound to the body account', async () => {
    const token = await gorgiasAccountToken(SECRET, 'acme');
    const post = (account: string, t = token) =>
      app.request('/gorgias/widget', { method: 'POST', headers: { 'Content-Type': 'application/json', [ACCOUNT_TOKEN_HEADER]: t }, body: JSON.stringify({ account, ticket: { id: 1, tags: ['vip'] } }) });
    expect((await post('acme')).status).toBe(200);
    expect((await post('globex')).status).toBe(401); // acme's token cannot act for another account
    expect((await post('acme', 'f'.repeat(64))).status).toBe(401);
  });

  it('validates the body after authenticating it', async () => {
    const res = await signedPost(app, '/gorgias/widget', { account: 'acme' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    const bad = await signedPost(app, '/gorgias/widget', { account: 'evil.com/x', ticket: { id: 1 } });
    expect(bad.status).toBe(400);
  });
});

describe('POST /gorgias/export', () => {
  it('runs the cursor export, enforces the free row limit and returns a link that downloads via core', async () => {
    const res = await signedPost(app, '/gorgias/export', { account: 'acme', entity: 'ticket' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { downloadUrl: string; expiresAt: string; stats: { rows: number; limitReached: boolean }; plan: string; upgrade?: unknown; stoppedBy: string };
    expect(json.plan).toBe('free');
    expect(json.stats.rows).toBe(250);
    expect(json.stats.limitReached).toBe(true);
    expect(json.stoppedBy).toBe('limit');
    expect(json.upgrade).toBeDefined();
    expect(json.downloadUrl.startsWith('https://hps.test/v1/exports/')).toBe(true);
    expect(Date.parse(json.expiresAt)).toBeGreaterThan(Date.now());

    const u = new URL(json.downloadUrl);
    const dl = await app.request(u.pathname + u.search);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(dl.headers.get('content-disposition')).toMatch(/gorgias-tickets-\d{4}-\d{2}-\d{2}\.csv/);
    const csv = parseCsv(await dl.text());
    expect(csv.length).toBe(251);
    expect(new Set(csv.slice(1).map((r) => r[0])).size).toBe(250);

    // Also downloadable straight from the stand-alone core app, and a tampered signature is refused.
    expect((await coreApp.request(u.pathname + u.search)).status).toBe(200);
    expect((await coreApp.request(u.pathname + u.search.replace(/sig=./, 'sig=x'))).status).toBe(403);

    expect(await deps.entitlements.usageThisMonth(TENANT)).toBe(250);
  });

  it('exports all rows as XLSX on Pro', async () => {
    await deps.entitlements.grant(TENANT, { plan: 'pro', status: 'active', source: 'manual' });
    const res = await signedPost(app, '/gorgias/export', { account: 'acme', entity: 'ticket', format: 'xlsx', filters: { statuses: ['open'] } });
    const json = (await res.json()) as { downloadUrl: string; stats: { rows: number; duplicatesDropped: number }; plan: string };
    expect(json.plan).toBe('pro');
    expect(json.stats.rows).toBe(320);
    // 3 page overlaps × 5 records (re-sent copies of filtered-out tickets count as duplicates too).
    expect(json.stats.duplicatesDropped).toBe(15);
    const u = new URL(json.downloadUrl);
    const dl = await app.request(u.pathname + u.search);
    expect(dl.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(new Uint8Array(await dl.arrayBuffer())[0]).toBe(0x50);
  });

  it('404s when no client is configured, 401s unsigned, 400s bad filters', async () => {
    const missing = await signedPost(app, '/gorgias/export', { account: 'other', entity: 'ticket' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'not_found' } });

    const noFactory = mount({ clientFactory: undefined });
    expect((await signedPost(noFactory, '/gorgias/export', { account: 'acme', entity: 'ticket' })).status).toBe(404);

    const unsigned = await app.request('/gorgias/export', { method: 'POST', body: JSON.stringify({ account: 'acme', entity: 'ticket' }) });
    expect(unsigned.status).toBe(401);

    const bad = await signedPost(app, '/gorgias/export', { account: 'acme', entity: 'ticket', columns: ['Nope'] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: 'invalid_request', message: expect.stringContaining('Nope') } });
  });

  it('maps upstream API failures to 502 upstream_error', async () => {
    fetchStub = fakeGorgiasFetch({ pages: {}, failFirst: { count: 1, status: 401 } });
    const res = await signedPost(mount(), '/gorgias/export', { account: 'acme', entity: 'user' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: 'upstream_error', upstreamStatus: 401 } });
  });

  it('refuses a too-short widget secret at construction', () => {
    expect(() => createGorgiasRoutes({ ...deps, publicBaseUrl: 'https://x', widgetSecret: 'short' })).toThrow(/widgetSecret/);
  });
});
