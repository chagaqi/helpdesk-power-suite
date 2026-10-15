import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createServices, hmacSha256Hex, ruleInputSchema, type CoreApiDeps } from '@hps/core-api';
import { parseCsv } from '@hps/core-api/export';
import { createIntercomCanvasRoutes, IntercomClient, type CanvasComponent, type CanvasResponse, type IntercomCanvasDeps } from '../src/index.js';
import { fakeIntercomFetch, intercomCompanies, intercomContacts, overlappingPages } from './fixtures.js';

const SECRET = 'intercom-client-secret-abc';
const WORKSPACE = 'ws9abc12';
const TENANT = `intercom:${WORKSPACE}`;

let deps: CoreApiDeps;
let coreApp: Hono;
let app: Hono;
let stub: ReturnType<typeof fakeIntercomFetch>;

function mount(extra: Partial<IntercomCanvasDeps> = {}) {
  const routes = createIntercomCanvasRoutes({
    rules: deps.rules,
    entitlements: deps.entitlements,
    store: deps.store,
    signer: deps.signer,
    publicBaseUrl: deps.config.publicBaseUrl,
    clientSecret: SECRET,
    clientFactory: (ws) => (ws === WORKSPACE ? new IntercomClient({ token: 'tok', fetch: stub.fetch, sleep: async () => undefined }) : null),
    ...extra,
  });
  const root = new Hono();
  root.route('/', routes);
  root.route('/', coreApp);
  return root;
}

async function post(path: string, body: unknown, secret = SECRET, target = app) {
  const raw = JSON.stringify(body);
  return target.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Body-Signature': await hmacSha256Hex(secret, raw) }, body: raw });
}

const baseRequest = (over: Record<string, unknown> = {}) => ({
  workspace_id: WORKSPACE,
  workspace_region: 'us',
  admin: { id: '814860', name: 'Ann Agent', email: 'ann@acme.com', team_ids: [] },
  contact: { id: 'ct_00001', type: 'user' },
  conversation: {
    id: '147',
    tags: { type: 'tag.list', tags: [{ type: 'tag', id: '11', name: 'VIP' }] },
    custom_attributes: { 'Escalation Reason': null, Region: 'EMEA' },
  },
  current_canvas: null,
  input_values: {},
  context: { location: 'conversation' },
  ...over,
});

/** Minimal structural validator for Canvas Kit components used by this app. */
function assertValidCanvas(res: unknown): CanvasComponent[] {
  const r = res as CanvasResponse;
  expect(Object.keys(r)).toEqual(['canvas']);
  const comps = r.canvas.content.components;
  expect(Array.isArray(comps)).toBe(true);
  const ids = new Set<string>();
  for (const c of comps) {
    expect(['text', 'button', 'list', 'divider', 'spacer']).toContain(c.type);
    if ('id' in c && c.id) {
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
    }
    if (c.type === 'text') {
      expect(c.text.length).toBeGreaterThan(0);
      if (c.style) expect(['header', 'paragraph', 'muted', 'error']).toContain(c.style);
    }
    if (c.type === 'button') {
      expect(typeof c.id).toBe('string');
      expect(c.label.length).toBeGreaterThan(0);
      expect(['submit', 'url']).toContain(c.action.type);
      if (c.action.type === 'url') expect(() => new URL((c.action as { url: string }).url)).not.toThrow();
    }
    if (c.type === 'list') {
      expect(c.items.length).toBeGreaterThan(0);
      for (const it of c.items) {
        expect(it.type).toBe('item');
        expect(typeof it.id).toBe('string');
        expect(it.title.length).toBeGreaterThan(0);
      }
    }
  }
  return comps;
}

beforeEach(async () => {
  const s = createServices({ masterSecret: 'master-secret-for-tests-0123456789', config: { publicBaseUrl: 'https://hps.test' } });
  deps = s.deps;
  coreApp = s.app as unknown as Hono;
  stub = fakeIntercomFetch({ contactPages: overlappingPages(intercomContacts(400), 150, 5), companyPages: overlappingPages(intercomCompanies(90), 50) });
  app = mount();
  await deps.rules.syncCatalog(TENANT, {
    fields: [
      { id: 'Escalation Reason', name: 'Escalation Reason', type: 'text' },
      { id: 'Region', name: 'Region', type: 'text' },
      { id: 'Internal Notes', name: 'Internal Notes', type: 'textarea' },
    ],
    groups: [],
  });
  await deps.rules.create(TENANT, ruleInputSchema.parse({ name: 'VIP escalations', conditions: { tags: { any: ['vip'] } }, actions: [{ type: 'require', field: 'Escalation Reason' }, { type: 'disable', field: 'Region' }] }));
  await deps.rules.create(TENANT, ruleInputSchema.parse({ name: 'Agents never see notes', conditions: { roles: ['agent'] }, actions: [{ type: 'hide', field: 'Internal Notes' }] }));
});

describe('signature verification', () => {
  it('rejects unsigned, wrongly signed and tampered requests with 401', async () => {
    const raw = JSON.stringify(baseRequest());
    for (const path of ['/intercom/canvas/initialize', '/intercom/canvas/submit']) {
      const none = await app.request(path, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json' } });
      expect(none.status).toBe(401);
      expect(await none.json()).toMatchObject({ error: { code: 'unauthorized' } });
      expect((await post(path, baseRequest(), 'not-the-secret')).status).toBe(401);
    }
    const sig = await hmacSha256Hex(SECRET, raw);
    const tampered = await app.request('/intercom/canvas/initialize', { method: 'POST', body: raw.replace(WORKSPACE, 'otherws1'), headers: { 'X-Body-Signature': sig } });
    expect(tampered.status).toBe(401);
  });

  it('400s a signed request without workspace_id', async () => {
    const res = await post('/intercom/canvas/initialize', { admin: { id: '1' } });
    expect(res.status).toBe(400);
  });
});

describe('POST /intercom/canvas/initialize', () => {
  it('returns a valid canvas with rule hints for the conversation and export buttons', async () => {
    const res = await post('/intercom/canvas/initialize', baseRequest());
    expect(res.status).toBe(200);
    const comps = assertValidCanvas(await res.json());
    expect(comps[0]).toEqual({ type: 'text', id: 'title', text: 'Helpdesk Power Suite', style: 'header' });

    const list = comps.find((c) => c.type === 'list');
    expect(list && list.type === 'list' && list.items).toEqual([
      { type: 'item', id: 'field_rule_0', title: 'Escalation Reason', subtitle: 'Required', tertiary_text: 'Missing value' },
      { type: 'item', id: 'field_rule_1', title: 'Internal Notes', subtitle: 'Hidden' },
      { type: 'item', id: 'field_rule_2', title: 'Region', subtitle: 'Read-only' },
    ]);
    expect(comps).toContainEqual({ type: 'text', id: 'required_missing', text: 'Required before closing: Escalation Reason', style: 'error' });
    expect(comps).toContainEqual({ type: 'button', id: 'export_contacts', label: 'Export contacts (CSV)', style: 'primary', action: { type: 'submit' } });
    expect(comps).toContainEqual({ type: 'button', id: 'export_companies_xlsx', label: 'Export companies (XLSX)', style: 'secondary', action: { type: 'submit' } });
    expect(comps).toContainEqual({ type: 'text', id: 'plan_note', text: 'Free plan: exports include up to 250 rows.', style: 'muted' });
  });

  it('only applies tag rules when the conversation carries the tag, and clears missing once filled', async () => {
    const res = await post('/intercom/canvas/initialize', baseRequest({ conversation: { id: '1', tags: { type: 'tag.list', tags: [] }, custom_attributes: {} } }));
    const comps = assertValidCanvas(await res.json());
    const list = comps.find((c) => c.type === 'list');
    expect(list && list.type === 'list' && list.items.map((i) => i.title)).toEqual(['Internal Notes']);

    const filled = await post('/intercom/canvas/initialize', baseRequest({ conversation: { id: '1', tags: { tags: [{ name: 'vip' }] }, custom_attributes: { 'escalation reason': 'Outage' } } }));
    const c2 = assertValidCanvas(await filled.json());
    expect(c2.find((c) => c.id === 'required_missing')).toBeUndefined();
  });

  it('renders a "no rules" canvas for a workspace without rules', async () => {
    const res = await post('/intercom/canvas/initialize', baseRequest({ workspace_id: 'emptyws1', conversation: null }));
    const comps = assertValidCanvas(await res.json());
    expect(comps).toContainEqual({ type: 'text', id: 'rules_intro', text: 'No field rules apply to this conversation.', style: 'muted' });
    expect(comps.find((c) => c.type === 'list')).toBeUndefined();
  });
});

describe('POST /intercom/canvas/submit', () => {
  it('exports contacts and returns a URL button whose link downloads the CSV through core', async () => {
    const res = await post('/intercom/canvas/submit', baseRequest({ component_id: 'export_contacts' }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as CanvasResponse;
    const comps = assertValidCanvas(json);
    expect(comps[0]).toMatchObject({ type: 'text', text: 'Contacts export ready' });
    // Page 2 re-sends the 5 overlapping contacts of page 1 before the 250-row Free cap is reached.
    expect(comps).toContainEqual({ type: 'text', id: 'summary', text: '250 rows · 5 duplicates removed', style: 'paragraph' });
    expect(comps.find((c) => c.id === 'upgrade')).toMatchObject({ type: 'button', action: { type: 'url', url: 'https://helpdeskpowersuite.com/pricing' } });

    const btn = comps.find((c) => c.id === 'download_export');
    expect(btn).toMatchObject({ type: 'button', label: 'Download CSV', action: { type: 'url' } });
    const url = new URL((btn as { action: { url: string } }).action.url);
    expect(url.origin).toBe('https://hps.test');
    expect(url.pathname.startsWith('/v1/exports/')).toBe(true);

    const dl = await coreApp.request(url.pathname + url.search);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    const csv = parseCsv(await dl.text());
    expect(csv).toHaveLength(251);
    expect(new Set(csv.slice(1).map((r) => r[0])).size).toBe(250);
    expect(csv[0]).toEqual(expect.arrayContaining(['User ID', 'Email', 'Plan Tier', 'Tags']));
    expect(await deps.entitlements.usageThisMonth(TENANT)).toBe(250);
    expect(json.canvas.stored_data).toMatchObject({ rows: 250 });
  });

  it('exports everything on Pro, reporting duplicates removed', async () => {
    await deps.entitlements.grant(TENANT, { plan: 'pro', status: 'active', source: 'manual' });
    const comps = assertValidCanvas(await (await post('/intercom/canvas/submit', baseRequest({ component_id: 'export_contacts' }))).json());
    expect(comps).toContainEqual({ type: 'text', id: 'summary', text: '400 rows · 10 duplicates removed', style: 'paragraph' });
    expect(comps.find((c) => c.id === 'upgrade')).toBeUndefined();
    const btn = comps.find((c) => c.id === 'download_export') as { action: { url: string } };
    const url = new URL(btn.action.url);
    expect(parseCsv(await (await app.request(url.pathname + url.search)).text())).toHaveLength(401);
  });

  it('exports companies as XLSX via the scroll API', async () => {
    const comps = assertValidCanvas(await (await post('/intercom/canvas/submit', baseRequest({ component_id: 'export_companies_xlsx' }))).json());
    expect(comps[0]).toMatchObject({ text: 'Companies export ready' });
    expect(comps).toContainEqual({ type: 'text', id: 'summary', text: '90 rows · 0 duplicates removed', style: 'paragraph' });
    const btn = comps.find((c) => c.id === 'download_export') as { label: string; action: { url: string } };
    expect(btn.label).toBe('Download XLSX');
    const url = new URL(btn.action.url);
    const dl = await coreApp.request(url.pathname + url.search);
    expect(dl.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(dl.headers.get('content-disposition')).toMatch(/intercom-companies-.*\.xlsx/);
  });

  it('re-renders the initialize canvas for unknown components (e.g. Back)', async () => {
    const comps = assertValidCanvas(await (await post('/intercom/canvas/submit', baseRequest({ component_id: 'back' }))).json());
    expect(comps.find((c) => c.id === 'export_contacts')).toBeDefined();
    expect(comps.find((c) => c.type === 'list')).toBeDefined();
  });

  it('explains when no access token is configured for the workspace', async () => {
    for (const target of [mount({ clientFactory: undefined }), app]) {
      const res = await post('/intercom/canvas/submit', baseRequest({ workspace_id: 'unknown1', component_id: 'export_contacts' }), SECRET, target);
      expect(res.status).toBe(200);
      const comps = assertValidCanvas(await res.json());
      expect(comps.find((c) => c.id === 'not_configured')).toMatchObject({ type: 'text', text: expect.stringContaining('access token is not configured') });
    }
  });

  it('turns Intercom API failures into an error canvas', async () => {
    stub = fakeIntercomFetch({ failFirst: { count: 1, status: 401 } });
    const comps = assertValidCanvas(await (await post('/intercom/canvas/submit', baseRequest({ component_id: 'export_contacts' }), SECRET, mount())).json());
    expect(comps.find((c) => c.id === 'error')).toMatchObject({ style: 'error', text: expect.stringContaining('(401)') });
    expect(comps.find((c) => c.id === 'back')).toBeDefined();
  });
});
