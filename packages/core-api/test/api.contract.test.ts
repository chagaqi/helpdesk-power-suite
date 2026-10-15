import { beforeEach, describe, expect, it } from 'vitest';
import { createServices } from '../src/index.js';
import { parseCsv, UTF8_BOM } from '../src/export/csv.js';
import { zendeskFieldSchema } from '../src/export/normalize/index.js';
import { cursorPages, zendeskTicketFieldsRaw, zendeskTickets, zendeskUserFieldsRaw, zendeskUsers } from '../src/demo/synthetic.js';
import { bytesToBase64, utf8 } from '../src/util/encoding.js';
import { hmacSha256 } from '../src/util/crypto.js';
import { readSheet, unzipXlsx } from './helpers.js';

const POLAR_SECRET = 'polar-test-secret';
const BASE = 'https://api.test';

function setup() {
  const { app, deps } = createServices({
    masterSecret: 'k'.repeat(64),
    config: { publicBaseUrl: BASE, polarWebhookSecret: POLAR_SECRET, installRateLimit: { limit: 5, windowSec: 3600 } },
    getClientIp: (c) => c.req.header('x-test-ip') ?? '127.0.0.1',
    logger: { error() {}, warn() {}, info() {} },
  });
  return { app, deps };
}

type Ctx = ReturnType<typeof setup> & { tenant: string; iid: string; secret: string };

const ADMIN = { id: '1', role: 'admin', groups: [{ id: '300', name: 'Tier 1 Support' }] };
const AGENT = { id: '2', role: 'agent', groups: [{ id: '300', name: 'Tier 1 Support' }] };

async function call(ctx: Ctx, method: string, path: string, body?: unknown, user: object | null = ADMIN, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (user) h.authorization = `Bearer ${await ctx.deps.installs.issueToken(ctx.secret, ctx.tenant, ctx.iid, user as never)}`;
  return ctx.app.request(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function polar(ctx: Ctx, id: string, event: unknown) {
  const body = JSON.stringify(event);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = bytesToBase64(await hmacSha256(utf8(POLAR_SECRET), `${id}.${ts}.${body}`));
  return ctx.app.request('/v1/webhooks/polar', { method: 'POST', headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }, body });
}

const upgrade = (ctx: Ctx) =>
  polar(ctx, `msg_${Math.random()}`, { type: 'subscription.active', data: { id: 'sub', status: 'active', current_period_end: '2999-01-01T00:00:00Z', metadata: { tenant_key: ctx.tenant } } });

let ctx: Ctx;
beforeEach(async () => {
  const s = setup();
  const res = await s.app.request('/v1/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'zendesk', tenant: 'https://acme.zendesk.com', installationId: 'zaf_123' }) });
  expect(res.status).toBe(201);
  const j = (await res.json()) as { tenant: string; installationId: string; sharedSecret: string };
  ctx = { ...s, tenant: j.tenant, iid: j.installationId, secret: j.sharedSecret };
});

describe('identity & errors', () => {
  it('rejects unauthenticated, bad tokens and invalid bodies with a stable error envelope', async () => {
    const r1 = await ctx.app.request('/v1/me');
    expect(r1.status).toBe(401);
    expect(await r1.json()).toEqual({ error: { code: 'unauthorized', message: 'Missing bearer token' } });
    expect((await ctx.app.request('/v1/me', { headers: { authorization: 'Bearer abc.def.ghi' } })).status).toBe(401);
    const r3 = await call(ctx, 'POST', '/v1/export/sessions', { entity: 'spaceship', source: 'zendesk' });
    expect(r3.status).toBe(400);
    expect(((await r3.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
    const me = (await (await call(ctx, 'GET', '/v1/me')).json()) as { tenant: string; entitlement: { effectivePlan: string } };
    expect(me).toMatchObject({ tenant: 'zendesk:acme', entitlement: { effectivePlan: 'free' } });
  });

  it('second unauthenticated install of the same tenant is refused (409) and install is IP rate-limited', async () => {
    const again = await ctx.app.request('/v1/install', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-ip': '9.9.9.9' }, body: JSON.stringify({ platform: 'zendesk', tenant: 'acme' }) });
    expect(again.status).toBe(409);
    let last = 0;
    for (let i = 0; i < 6; i++) {
      last = (await ctx.app.request('/v1/install', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-ip': '6.6.6.6' }, body: JSON.stringify({ platform: 'zendesk', tenant: `t${i}` }) })).status;
    }
    expect(last).toBe(429);
  });
});

describe('Module B over HTTP', () => {
  const catalog = {
    fields: [
      { id: 'priority', name: 'Priority', key: 'priority', system: true },
      { id: 360001, name: 'Customer Tier', key: 'custom_field_360001', type: 'dropdown', options: [{ value: 'tier_enterprise', label: 'Enterprise' }] },
      { id: 360004, name: 'Internal Escalation Notes', key: 'custom_field_360004', type: 'textarea' },
    ],
    groups: [{ id: 300, name: 'Tier 1 Support' }, { id: 301, name: 'Tier 2 Escalations' }],
  };

  it('admin syncs catalog, builds rules by name, agents get compiled config, evaluation uses token identity', async () => {
    expect((await call(ctx, 'PUT', '/v1/rules/catalog', catalog, AGENT)).status).toBe(403);
    expect((await call(ctx, 'PUT', '/v1/rules/catalog', catalog)).status).toBe(200);

    const bad = await call(ctx, 'POST', '/v1/rules/validate', { name: 'x', actions: [{ type: 'hide', field: 'Internal Escalaton Notes' }] });
    expect(await bad.json()).toMatchObject({ ok: false, problems: [{ suggestions: ['Internal Escalation Notes'] }] });

    const r1 = await call(ctx, 'POST', '/v1/rules', { name: 'Tier 1 cannot see notes', conditions: { groups: ['Tier 1 Support'] }, actions: [{ type: 'hide', field: 'Internal Escalation Notes' }] });
    expect(r1.status).toBe(201);
    const r2 = await call(ctx, 'POST', '/v1/rules', { name: 'Lock priority', conditions: { roles: ['agent'] }, actions: [{ type: 'disable', field: 'priority' }] });
    expect(r2.status).toBe(201);
    const r3 = await call(ctx, 'POST', '/v1/rules', { name: 'Third', actions: [{ type: 'require', field: 'Customer Tier' }] });
    expect(r3.status).toBe(402);
    expect(await r3.json()).toMatchObject({ error: { code: 'plan_limit', details: { limit: 2 } } });
    expect((await call(ctx, 'POST', '/v1/rules', { name: 'x', actions: [{ type: 'hide', field: 'Priority' }] }, AGENT)).status).toBe(403);

    const cfgRes = await call(ctx, 'GET', '/v1/rules/config', undefined, AGENT);
    const etag = cfgRes.headers.get('etag')!;
    const cfg = (await cfgRes.json()) as Record<string, any>;
    expect(cfg.catalog).toBeUndefined();
    expect(cfg.compiled.rules).toHaveLength(2);
    expect(cfg.compiled.fields['360004']).toEqual({ id: '360004', name: 'Internal Escalation Notes', key: 'custom_field_360004' });
    expect((await call(ctx, 'GET', '/v1/rules/config', undefined, AGENT, { 'if-none-match': etag })).status).toBe(304);

    // Agent tries to spoof Tier 2 membership in the body: ignored, token identity wins.
    const ev = (await (await call(ctx, 'POST', '/v1/rules/evaluate', { user: { role: 'admin', groups: ['Tier 2 Escalations'] } }, AGENT)).json()) as Record<string, any>;
    expect(ev.fields['360004'].hidden).toBe(true);
    expect(ev.fields.priority.disabled).toBe(true);
    // Admin can preview as another agent.
    const preview = (await (await call(ctx, 'POST', '/v1/rules/evaluate', { user: { role: 'agent', groups: ['301'] } })).json()) as Record<string, any>;
    expect(preview.fields['360004']).toBeUndefined();

    await upgrade(ctx);
    expect((await call(ctx, 'POST', '/v1/rules', { name: 'Third', actions: [{ type: 'require', field: 'Customer Tier' }] })).status).toBe(201);
    const list = (await (await call(ctx, 'GET', '/v1/rules')).json()) as { rules: { id: string }[] };
    expect(list.rules).toHaveLength(3);
    expect((await call(ctx, 'DELETE', `/v1/rules/${list.rules[0]!.id}`)).status).toBe(204);
    const reordered = (await (await call(ctx, 'POST', '/v1/rules/reorder', { ids: [list.rules[2]!.id] })).json()) as { rules: { id: string; priority: number }[] };
    expect(reordered.rules[0]).toMatchObject({ id: list.rules[2]!.id, priority: 10 });
  });
});

describe('Module A over HTTP', () => {
  const userSchema = zendeskFieldSchema('user', zendeskUserFieldsRaw());

  async function runSession(pages: ReturnType<typeof cursorPages>, filters: object = {}) {
    const create = await call(ctx, 'POST', '/v1/export/sessions', { entity: 'user', source: 'zendesk', fieldSchema: userSchema, filters });
    expect(create.status).toBe(201);
    const { id } = (await create.json()) as { id: string };
    for (const p of pages) expect((await call(ctx, 'POST', `/v1/export/sessions/${id}/batches`, p)).status).toBe(200);
    return id;
  }

  it('free tier exports are capped at 250 rows with an upgrade hint', async () => {
    const id = await runSession(cursorPages(zendeskUsers(600), 100));
    const fin = (await (await call(ctx, 'POST', `/v1/export/sessions/${id}/finalize`, { format: 'csv' })).json()) as Record<string, any>;
    expect(fin.stats).toMatchObject({ rows: 250, truncated: 350, limitReached: true });
    expect(fin.upgrade.message).toMatch(/250 rows/);
    const csv = await (await ctx.app.request(fin.downloadUrl.replace(BASE, ''))).text();
    expect(parseCsv(csv).length).toBe(251);
  });

  it('Pro: 3,000 users over 30 cursor pages (+overlap, +replays) -> deduped, suspended filtered, signed XLSX download', async () => {
    await upgrade(ctx);
    const users = zendeskUsers(3000);
    const pages = cursorPages(users, 100, 10);
    const id = await runSession([...pages.slice(0, 5), pages[2]!, pages[3]!, ...pages.slice(5)], { userState: 'active' });
    const stats = ((await (await call(ctx, 'GET', `/v1/export/sessions/${id}`)).json()) as { stats: Record<string, number> }).stats;
    const expected = users.filter((u) => !u.suspended).length;
    expect(stats).toMatchObject({ rows: expected, replayedBatches: 2, done: true });

    const fin = (await (await call(ctx, 'POST', `/v1/export/sessions/${id}/finalize`, { format: 'xlsx', filename: 'Active users!' })).json()) as Record<string, any>;
    expect(fin.filename).toBe('Active_users_.xlsx');
    expect(fin.upgrade).toBeUndefined();
    const path = fin.downloadUrl.replace(BASE, '');
    const dl = await ctx.app.request(path);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toContain('spreadsheetml');
    expect(dl.headers.get('content-disposition')).toContain('Active_users_.xlsx');
    const rows = readSheet(unzipXlsx(new Uint8Array(await dl.arrayBuffer())));
    expect(rows.length).toBe(expected + 1);
    expect(new Set(rows.slice(1).map((r) => r[0])).size).toBe(expected);
    expect(rows[0]).toContain('Customer Plan');

    expect((await ctx.app.request(path.replace(/sig=[^&]+/, 'sig=AAAA'))).status).toBe(403);
    expect((await ctx.app.request(path.replace(/exp=\d+/, 'exp=1'))).status).toBe(403);
    const me = (await (await call(ctx, 'GET', '/v1/me')).json()) as { usage: { exportRowsThisMonth: number } };
    expect(me.usage.exportRowsThisMonth).toBe(expected);
  });

  it('sessions are tenant-scoped', async () => {
    const id = await runSession(cursorPages(zendeskUsers(10), 10));
    const other = await ctx.deps.installs.register({ platform: 'freshdesk', tenant: 'globex' });
    const tok = await ctx.deps.installs.issueToken(other.sharedSecret, other.tenant, other.installationId, ADMIN as never);
    expect((await ctx.app.request(`/v1/export/sessions/${id}`, { headers: { authorization: `Bearer ${tok}` } })).status).toBe(404);
  });

  it('POST /v1/export/stream streams a UTF-8 BOM CSV with stats headers', async () => {
    await upgrade(ctx);
    const users = zendeskUsers(1500);
    // light agents (role_type 1) are their own canonical role and are excluded by roles: [admin, agent]
    const wanted = (u: (typeof users)[number]) => u.role === 'admin' || (u.role === 'agent' && u.role_type !== 1);
    const res = await call(ctx, 'POST', '/v1/export/stream', { entity: 'user', source: 'zendesk', fieldSchema: userSchema, filters: { roles: ['admin', 'agent'] }, records: [...users, ...users.slice(0, 200)], columns: ['Email', 'Role', 'Customer Plan', 'Suspended'] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('x-hps-duplicates-removed')).toBe(String(users.slice(0, 200).filter(wanted).length));
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
    expect(text.startsWith(UTF8_BOM)).toBe(true);
    const rows = parseCsv(text);
    expect(rows[0]).toEqual(['Email', 'Role', 'Customer Plan', 'Suspended']);
    expect(rows.length - 1).toBe(users.filter(wanted).length);
    expect(Number(res.headers.get('x-hps-rows'))).toBe(rows.length - 1);
  });

  it('POST /v1/export/xlsx: multi-tab requires Pro, then returns a workbook', async () => {
    const tickets = zendeskTickets(1200);
    const body = {
      sheets: [
        { entity: 'user', source: 'zendesk', fieldSchema: userSchema, records: zendeskUsers(1100) },
        { entity: 'ticket', source: 'zendesk', fieldSchema: zendeskFieldSchema('ticket', zendeskTicketFieldsRaw()), records: tickets, sheetName: 'All Tickets' },
      ],
    };
    expect((await call(ctx, 'POST', '/v1/export/xlsx', body)).status).toBe(402);
    await upgrade(ctx);
    const res = await call(ctx, 'POST', '/v1/export/xlsx', body);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-hps-rows')).toBe('2300');
    const parts = unzipXlsx(new Uint8Array(await res.arrayBuffer()));
    expect(parts['xl/workbook.xml']).toContain('name="All Tickets"');
    expect(readSheet(parts, 2).length).toBe(1201);
  });
});

describe('billing webhooks over HTTP', () => {
  it('rejects unsigned Polar webhooks and deduplicates by webhook-id', async () => {
    expect((await ctx.app.request('/v1/webhooks/polar', { method: 'POST', body: '{}' })).status).toBe(401);
    const ev = { type: 'subscription.active', data: { status: 'active', current_period_end: '2999-01-01T00:00:00Z', metadata: { tenant_key: ctx.tenant } } };
    expect(await (await polar(ctx, 'dup', ev)).json()).toMatchObject({ handled: true, plan: 'pro' });
    expect(await (await polar(ctx, 'dup', ev)).json()).toMatchObject({ duplicate: true });
    expect((await ctx.app.request('/v1/webhooks/stripe', { method: 'POST', body: '{}' })).status).toBe(404);
  });
});
