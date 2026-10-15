import { describe, expect, it, vi } from 'vitest';
import { parseCsv, UTF8_BOM } from '@hps/core-api/export';
import { exportGorgias, GorgiasClient, gorgiasAccountSlug, gorgiasFieldSchema, parseRetryAfter, UpstreamError } from '../src/index.js';
import { fakeGorgiasFetch, gorgiasCustomers, gorgiasTickets, overlappingPages, ticketFieldsRaw } from './fixtures.js';

const noSleep = vi.fn(async (_ms: number) => undefined);

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof GorgiasClient>[0]> = {}) {
  return new GorgiasClient({ account: 'acme', email: 'ops@acme.com', apiKey: 'k3y', fetch: fetchImpl, sleep: noSleep, ...extra });
}

describe('GorgiasClient', () => {
  it('normalizes account slugs and rejects hostile hosts', () => {
    expect(gorgiasAccountSlug('Acme')).toBe('acme');
    expect(gorgiasAccountSlug('https://acme.gorgias.com/app/tickets')).toBe('acme');
    expect(() => gorgiasAccountSlug('evil.com/x')).toThrow(/Invalid Gorgias account/);
    expect(() => gorgiasAccountSlug('a@b')).toThrow();
  });

  it('sends Basic auth, limit=100, cursor and created_datetime ordering', async () => {
    const f = fakeGorgiasFetch({ pages: { '/api/tickets': [gorgiasTickets(3), gorgiasTickets(2, 4)] } });
    const c = client(f.fetch);
    const p1 = await c.listTickets();
    const p2 = await c.listTickets({ cursor: p1.nextCursor });
    expect(p1.data).toHaveLength(3);
    expect(p1.nextCursor).toBe('c1');
    expect(p2.nextCursor).toBeNull();
    const first = f.calls[0]!;
    expect(first.url.origin).toBe('https://acme.gorgias.com');
    expect(first.url.searchParams.get('limit')).toBe('100');
    expect(first.url.searchParams.get('order_by')).toBe('created_datetime:asc');
    expect(first.url.searchParams.has('cursor')).toBe(false);
    expect(f.calls[1]!.url.searchParams.get('cursor')).toBe('c1');
    expect(first.headers.get('authorization')).toBe(`Basic ${btoa('ops@acme.com:k3y')}`);
  });

  it('maps ticket custom fields to the core schema by label', async () => {
    const defs = gorgiasFieldSchema(ticketFieldsRaw());
    expect(defs[0]).toEqual({ key: '101', title: 'Refund Reason', type: 'dropdown', options: [
      { value: 'Damaged', label: 'Damaged' },
      { value: 'Late', label: 'Late' },
      { value: 'Wrong item', label: 'Wrong item' },
    ], active: true });
    expect(defs[1]).toMatchObject({ key: '102', title: 'Order Value', type: 'number', active: true });
    expect(defs[2]).toMatchObject({ key: '103', active: false });
    const f = fakeGorgiasFetch({ pages: {} });
    expect(await client(f.fetch).listTicketCustomFields()).toEqual(defs);
    expect(f.calls[0]!.url.searchParams.get('object_type')).toBe('Ticket');
  });

  it('retries 429 honoring Retry-After, then succeeds', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const f = fakeGorgiasFetch({ pages: { '/api/users': [[{ id: 1, name: 'A', role: { name: 'admin' } }]] }, failFirst: { count: 2, status: 429, retryAfter: '3' } });
    const page = await client(f.fetch, { sleep }).listUsers();
    expect(page.data).toHaveLength(1);
    expect(f.calls).toHaveLength(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([3000, 3000]);
  });

  it('caps Retry-After at maxDelayMs and gives up after maxRetries on persistent 5xx', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const f = fakeGorgiasFetch({ pages: { '/api/users': [[]] }, failFirst: { count: 10, status: 503, retryAfter: '600' } });
    const err = await client(f.fetch, { sleep, maxRetries: 2, maxDelayMs: 5000 }).listUsers().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBe(503);
    expect(f.calls).toHaveLength(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5000, 5000]);
  });

  it('does not retry 4xx client errors', async () => {
    const f = fakeGorgiasFetch({ pages: { '/api/users': [[]] }, failFirst: { count: 1, status: 401 } });
    await expect(client(f.fetch).listUsers()).rejects.toMatchObject({ status: 401 });
    expect(f.calls).toHaveLength(1);
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter('garbage')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('exportGorgias', () => {
  it('exports 2,345 tickets across overlapping cursor pages with zero duplicate IDs', async () => {
    const tickets = gorgiasTickets(2345);
    const pages = overlappingPages(tickets, 100, 7, true);
    const f = fakeGorgiasFetch({ pages: { '/api/tickets': pages } });
    const progress: number[] = [];
    const res = await exportGorgias({ client: client(f.fetch), entity: 'ticket', filters: {}, format: 'csv', onProgress: (p) => progress.push(p.rows), now: () => new Date('2025-06-01T00:00:00Z') });

    expect(res.stoppedBy).toBe('done');
    expect(res.pages).toBe(24);
    expect(progress.at(-1)).toBe(2345);
    expect(res.filename).toBe('gorgias-tickets-2025-06-01.csv');
    expect(res.contentType).toBe('text/csv; charset=utf-8');

    // TextDecoder strips the BOM by default; keep it to prove Excel gets UTF-8 BOM CSV.
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(res.bytes);
    expect(text.startsWith(UTF8_BOM)).toBe(true);
    expect(Array.from(res.bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const csv = parseCsv(text);
    const header = csv[0]!;
    expect(header).toContain('Refund Reason');
    expect(header).toContain('Order Value');
    expect(header).not.toContain('Legacy Field');
    const ids = csv.slice(1).map((r) => r[0]);
    expect(ids).toHaveLength(2345);
    expect(new Set(ids).size).toBe(2345);
    // 23 overlapping pages × 7 + 24 intra-page duplicates
    expect(res.session.stats.duplicatesDropped).toBe(23 * 7 + 24);

    const row = csv.find((r) => r[0] === '4')!;
    expect(row[header.indexOf('Refund Reason')]).toBe('Late');
    expect(row[header.indexOf('Order Value')]).toBe('40');
  });

  it('filters by status and excludes trashed tickets, honoring the row limit', async () => {
    const f = fakeGorgiasFetch({ pages: { '/api/tickets': overlappingPages(gorgiasTickets(400), 100) } });
    const res = await exportGorgias({ client: client(f.fetch), entity: 'ticket', filters: { statuses: ['closed'], includeArchived: false }, format: 'csv' });
    // ids divisible by 5 are closed (80); those divisible by 50 are trashed (8)
    expect(res.session.size).toBe(72);

    const limited = await exportGorgias({ client: client(fakeGorgiasFetch({ pages: { '/api/tickets': overlappingPages(gorgiasTickets(400), 100) } }).fetch), entity: 'ticket', rowLimit: 250, format: 'csv' });
    expect(limited.session.size).toBe(250);
    expect(limited.stoppedBy).toBe('limit');
    expect(limited.pages).toBe(3);
  });

  it('exports customers with deactivated/deleted ones filtered out', async () => {
    const customers = gorgiasCustomers(300);
    const f = fakeGorgiasFetch({ pages: { '/api/customers': overlappingPages(customers, 100, 3) } });
    const res = await exportGorgias({ client: client(f.fetch), entity: 'user', userKind: 'customers', filters: { userState: 'active' }, format: 'csv' });
    const expected = customers.filter((c) => c.active && c.deleted_datetime === null).length;
    expect(res.session.size).toBe(expected);
    expect(res.filename).toMatch(/^gorgias-customers-/);
    const csv = parseCsv(new TextDecoder().decode(res.bytes));
    const h = csv[0]!;
    expect(h).toContain('plan'); // customer `data` attributes become columns
    expect(new Set(csv.slice(1).map((r) => r[h.indexOf('State')]))).toEqual(new Set(['Active']));
    expect(new Set(csv.slice(1).map((r) => r[h.indexOf('Role')]))).toEqual(new Set(['end_user']));

    const suspended = await exportGorgias({
      client: client(fakeGorgiasFetch({ pages: { '/api/customers': overlappingPages(customers, 100) } }).fetch),
      entity: 'user',
      filters: { userState: 'suspended' },
      format: 'csv',
    });
    expect(suspended.session.size).toBe(customers.length - expected);
  });

  it('exports agents from /api/users with role mapping', async () => {
    const agents = [
      { id: 1, name: 'Ann', email: 'ann@acme.com', role: { name: 'admin' } },
      { id: 2, name: 'Bob', email: 'bob@acme.com', role: { name: 'lite-agent' } },
      { id: 3, name: 'Cy', email: 'cy@acme.com', role: { name: 'basic-agent' } },
    ];
    const f = fakeGorgiasFetch({ pages: { '/api/users': [agents] } });
    const res = await exportGorgias({ client: client(f.fetch), entity: 'user', userKind: 'agents', filters: { roles: ['admin', 'light_agent'] }, format: 'xlsx' });
    expect(res.session.size).toBe(2);
    expect(res.filename).toMatch(/^gorgias-agents-.*\.xlsx$/);
    expect(res.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.bytes[0]).toBe(0x50); // PK zip header
    expect(f.calls[0]!.url.pathname).toBe('/api/users');
  });

  it('stops on a cursor loop instead of paginating forever', async () => {
    const pages = overlappingPages(gorgiasTickets(500), 100);
    // page 3 points back at page 1
    const f = fakeGorgiasFetch({ pages: { '/api/tickets': pages }, nextCursor: (_r, i) => (i === 3 ? 'c1' : `c${i + 1}`) });
    const res = await exportGorgias({ client: client(f.fetch), entity: 'ticket', format: 'csv' });
    expect(res.stoppedBy).toBe('cursor_loop');
    expect(res.pages).toBe(4);
    expect(res.session.size).toBe(400);
    expect(f.calls.filter((c) => c.url.pathname === '/api/tickets')).toHaveLength(4);
  });

  it('stops when fresh cursors keep replaying the same records', async () => {
    const same = gorgiasTickets(10);
    let n = 0;
    const f = fakeGorgiasFetch({ pages: { '/api/tickets': [same] }, nextCursor: () => `c0?${n++}` });
    // Every request returns page 0 with a brand-new cursor string.
    const res = await exportGorgias({ client: client(f.fetch), entity: 'ticket', format: 'csv' });
    expect(res.stoppedBy).toBe('cursor_loop');
    expect(res.pages).toBe(4); // 1 productive page + 3 stagnant pages
    expect(res.session.size).toBe(10);
  });

  it('honors maxPages and abort signals', async () => {
    const f = fakeGorgiasFetch({ pages: { '/api/tickets': overlappingPages(gorgiasTickets(1000), 100) } });
    const res = await exportGorgias({ client: client(f.fetch), entity: 'ticket', format: 'csv', maxPages: 2 });
    expect(res.stoppedBy).toBe('max_pages');
    expect(res.session.size).toBe(200);

    const ac = new AbortController();
    const f2 = fakeGorgiasFetch({ pages: { '/api/tickets': overlappingPages(gorgiasTickets(1000), 100) } });
    const p = exportGorgias({ client: client(f2.fetch), entity: 'ticket', format: 'csv', signal: ac.signal, onProgress: (pr) => pr.page === 2 && ac.abort() });
    await expect(p).rejects.toThrow();
  });
});
