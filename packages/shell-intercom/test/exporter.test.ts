import { describe, expect, it, vi } from 'vitest';
import { parseCsv } from '@hps/core-api/export';
import { exportIntercom, IntercomClient, nextStartingAfter, parseRateLimitReset, UpstreamError } from '../src/index.js';
import { fakeIntercomFetch, intercomCompanies, intercomContacts, overlappingPages } from './fixtures.js';

const client = (f: typeof fetch, extra: Partial<ConstructorParameters<typeof IntercomClient>[0]> = {}) =>
  new IntercomClient({ token: 'tok_123', fetch: f, sleep: async () => undefined, ...extra });

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe('IntercomClient', () => {
  it('sends bearer auth, Intercom-Version 2.11, Accept json and per_page=150', async () => {
    const f = fakeIntercomFetch({ contactPages: overlappingPages(intercomContacts(200), 150) });
    const c = client(f.fetch);
    const p1 = await c.listContacts();
    expect(p1.data).toHaveLength(150);
    expect(p1.nextCursor).toBe('ct_00150:1');
    const p2 = await c.listContacts({ startingAfter: p1.nextCursor });
    expect(p2.nextCursor).toBeNull();
    const h = f.calls[0]!.headers;
    expect(h.get('authorization')).toBe('Bearer tok_123');
    expect(h.get('intercom-version')).toBe('2.11');
    expect(h.get('accept')).toBe('application/json');
    expect(f.calls[0]!.url.href).toBe('https://api.intercom.io/contacts?per_page=150');
    expect(f.calls[1]!.url.searchParams.get('starting_after')).toBe('ct_00150:1');
  });

  it('posts search queries with pagination', async () => {
    const f = fakeIntercomFetch({ contactPages: [intercomContacts(3)] });
    const query = { field: 'role', operator: '=', value: 'user' };
    await client(f.fetch).searchContacts(query, { perPage: 50, startingAfter: 'abc:0' });
    expect(f.calls[0]!.method).toBe('POST');
    expect(f.calls[0]!.body).toEqual({ query, pagination: { per_page: 50, starting_after: 'abc:0' } });
    expect(f.calls[0]!.headers.get('content-type')).toBe('application/json');
  });

  it('maps custom data attributes with core intercomFieldSchema', async () => {
    const f = fakeIntercomFetch({});
    const schema = await client(f.fetch).fieldSchema('contact');
    expect(schema.map((d) => [d.key, d.title, d.type])).toEqual([
      ['plan_tier', 'Plan Tier', 'text'],
      ['seats', 'Seats', 'number'],
    ]);
    expect(f.calls[0]!.url.searchParams.get('model')).toBe('contact');
  });

  it('reads pages.next in object and legacy URL form', () => {
    expect(nextStartingAfter({ next: { page: 2, starting_after: 'WzE3MDAwMDAwMDBd' } })).toBe('WzE3MDAwMDAwMDBd');
    expect(nextStartingAfter({ next: 'https://api.intercom.io/contacts?per_page=150&starting_after=abc' })).toBe('abc');
    expect(nextStartingAfter({ next: null })).toBeNull();
    expect(nextStartingAfter(undefined)).toBeNull();
  });

  it('retries 429 using X-RateLimit-Reset when Retry-After is absent', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const now = 1_800_000_000_000;
    const f = fakeIntercomFetch({ admins: [{ type: 'admin', id: '1' }], failFirst: { count: 1, status: 429, headers: { 'X-RateLimit-Reset': String(now / 1000 + 4) } } });
    const admins = await client(f.fetch, { sleep, now: () => now }).listAdmins();
    expect(admins).toHaveLength(1);
    expect(sleep).toHaveBeenCalledWith(4000, undefined);
    expect(parseRateLimitReset('12')).toBeUndefined();
  });

  it('surfaces non-retryable errors as UpstreamError', async () => {
    const f = fakeIntercomFetch({ failFirst: { count: 1, status: 401 } });
    const err = await client(f.fetch).listAdmins().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBe(401);
  });
});

describe('exportIntercom', () => {
  it('exports 1,620 contacts across starting_after pages with duplicates → unique rows, tag names and attribute titles', async () => {
    const contacts = intercomContacts(1620);
    const pages = overlappingPages(contacts, 150, 10);
    // A page re-sent with one extra stale copy of an earlier contact.
    pages[4]!.push({ ...contacts[3]!, name: 'Stale copy', updated_at: 1 });
    const f = fakeIntercomFetch({ contactPages: pages });
    const res = await exportIntercom({ client: client(f.fetch), entity: 'user', format: 'csv', now: () => new Date('2025-07-01T00:00:00Z') });

    expect(res.stoppedBy).toBe('done');
    expect(res.pages).toBe(11);
    expect(res.filename).toBe('intercom-contacts-2025-07-01.csv');
    expect(res.session.stats.duplicatesDropped).toBe(10 * 10 + 1);
    const csv = parseCsv(decode(res.bytes));
    const h = csv[0]!;
    const ids = csv.slice(1).map((r) => r[0]);
    expect(ids).toHaveLength(1620);
    expect(new Set(ids).size).toBe(1620);
    expect(h).toEqual(expect.arrayContaining(['Plan Tier', 'Seats', 'Tags', 'State']));

    const row4 = csv.find((r) => r[0] === 'ct_00004')!;
    expect(row4[h.indexOf('Name')]).toBe('Contact 4'); // stale copy (older updated_at) ignored
    expect(row4[h.indexOf('Tags')]).toBe('VIP');
    expect(csv.find((r) => r[0] === 'ct_00002')![h.indexOf('Tags')]).toBe('Churn Risk');
    // /tags is fetched once, lazily.
    expect(f.calls.filter((c) => c.url.pathname === '/tags')).toHaveLength(1);
  });

  it('filters archived contacts and tags; keeps archived ones visible as "Suspended" when unfiltered', async () => {
    const contacts = intercomContacts(300);
    const pages = overlappingPages(contacts, 150);
    const active = await exportIntercom({ client: client(fakeIntercomFetch({ contactPages: pages }).fetch), entity: 'user', filters: { userState: 'active', tags: { any: ['vip'] } }, format: 'csv' });
    const expected = contacts.filter((c, i) => !c.archived && i % 3 === 0).length;
    expect(active.session.size).toBe(expected);

    const all = await exportIntercom({ client: client(fakeIntercomFetch({ contactPages: pages }).fetch), entity: 'user', format: 'csv' });
    const csv = parseCsv(decode(all.bytes));
    const h = csv[0]!;
    const archived = csv.slice(1).filter((r) => r[h.indexOf('State')] === 'Suspended');
    expect(archived).toHaveLength(contacts.filter((c) => c.archived).length);

    const leads = await exportIntercom({ client: client(fakeIntercomFetch({ contactPages: pages }).fetch), entity: 'user', filters: { roles: ['lead'] }, format: 'csv' });
    expect(leads.session.size).toBe(30);
  });

  it('uses /contacts/search when a query is given', async () => {
    const f = fakeIntercomFetch({ contactPages: overlappingPages(intercomContacts(400), 150) });
    const res = await exportIntercom({ client: client(f.fetch), entity: 'user', query: { field: 'role', operator: '=', value: 'user' }, format: 'csv' });
    expect(res.session.size).toBe(400);
    expect(f.calls.filter((c) => c.url.pathname === '/contacts/search')).toHaveLength(3);
  });

  it('walks the companies scroll (same scroll_param every page) and stops on the empty page', async () => {
    const companies = intercomCompanies(130);
    const f = fakeIntercomFetch({ companyPages: overlappingPages(companies, 50) });
    const res = await exportIntercom({ client: client(f.fetch), entity: 'organization', format: 'xlsx' });
    expect(res.stoppedBy).toBe('done');
    expect(res.session.size).toBe(130);
    expect(res.session.stats.replayedBatches).toBe(0); // repeated scroll_param is NOT treated as a replay
    const scrolls = f.calls.filter((c) => c.url.pathname === '/companies/scroll');
    expect(scrolls).toHaveLength(4); // 3 pages + terminating empty page
    expect(scrolls[0]!.url.searchParams.has('scroll_param')).toBe(false);
    expect(scrolls.slice(1).every((c) => c.url.searchParams.get('scroll_param') === 'scroll-abc')).toBe(true);
    expect(res.filename).toMatch(/^intercom-companies-.*\.xlsx$/);
    expect(res.bytes[0]).toBe(0x50);
  });

  it('terminates a scroll that never ends by detecting stagnant pages', async () => {
    const f = fakeIntercomFetch({ companyPages: overlappingPages(intercomCompanies(100), 50), endlessScroll: true });
    const res = await exportIntercom({ client: client(f.fetch), entity: 'organization', format: 'csv' });
    expect(res.stoppedBy).toBe('cursor_loop');
    expect(res.session.size).toBe(100);
    expect(f.calls.filter((c) => c.url.pathname === '/companies/scroll')).toHaveLength(5); // 2 productive + 3 stagnant
  });

  it('exports companies with tag names, plan and custom attribute titles', async () => {
    const f = fakeIntercomFetch({ companyPages: [intercomCompanies(8)] });
    const res = await exportIntercom({ client: client(f.fetch), entity: 'organization', format: 'csv', filters: { tags: { any: ['VIP'] } } });
    const csv = parseCsv(decode(res.bytes));
    const h = csv[0]!;
    expect(csv.slice(1).map((r) => r[0])).toEqual(['co_1', 'co_5']);
    expect(csv[1]![h.indexOf('Region')]).toBe('NA');
    expect(csv[1]![h.indexOf('Notes')]).toBe('Starter');
  });

  it('exports conversations and teammates', async () => {
    const convs = Array.from({ length: 160 }, (_, i) => ({
      type: 'conversation',
      id: String(1000 + i),
      title: `Conv ${i}`,
      state: i % 2 ? 'open' : 'closed',
      tags: { type: 'tag.list', tags: [{ type: 'tag', id: '11', name: 'VIP' }] },
      custom_attributes: { 'Escalation Reason': i % 3 ? null : 'Bug' },
      source: { type: 'email', author: { id: `ct_${i}`, email: `a${i}@x.com` } },
      created_at: 1_700_000_000 + i,
      updated_at: 1_700_000_500 + i,
    }));
    const f = fakeIntercomFetch({ conversations: overlappingPages(convs, 150, 3), admins: [{ type: 'admin', id: '1', name: 'Ann', email: 'ann@x.com' }, { type: 'admin', id: '2', name: 'Bo', email: 'bo@x.com' }] });
    const conv = await exportIntercom({ client: client(f.fetch), entity: 'ticket', filters: { statuses: ['open'] }, format: 'csv' });
    expect(conv.session.size).toBe(80);
    expect(parseCsv(decode(conv.bytes))[0]).toContain('Escalation Reason');

    const admins = await exportIntercom({ client: client(f.fetch), entity: 'user', userKind: 'admins', format: 'csv' });
    expect(admins.session.size).toBe(2);
    expect(admins.filename).toMatch(/^intercom-admins-/);
    const csv = parseCsv(decode(admins.bytes));
    expect(csv[1]![csv[0]!.indexOf('Role')]).toBe('agent');
  });

  it('continues without a schema when data attributes are forbidden (missing scope)', async () => {
    const f = fakeIntercomFetch({ contactPages: [intercomContacts(5)], dataAttributesStatus: 403 });
    const res = await exportIntercom({ client: client(f.fetch), entity: 'user', format: 'csv' });
    expect(res.session.size).toBe(5);
    expect(parseCsv(decode(res.bytes))[0]).toContain('plan_tier');
  });

  it('respects the entitlement row limit and stops paginating', async () => {
    const f = fakeIntercomFetch({ contactPages: overlappingPages(intercomContacts(1500), 150) });
    const res = await exportIntercom({ client: client(f.fetch), entity: 'user', rowLimit: 250, format: 'csv' });
    expect(res.session.size).toBe(250);
    expect(res.stoppedBy).toBe('limit');
    expect(f.calls.filter((c) => c.url.pathname === '/contacts')).toHaveLength(2);
  });
});
