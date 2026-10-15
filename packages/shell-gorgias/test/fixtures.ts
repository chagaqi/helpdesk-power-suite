/** Deterministic Gorgias fixtures + an in-memory cursor-paginated fake of the Gorgias REST API. */

export interface FakeCall {
  url: URL;
  headers: Headers;
}

export const ticketFieldsRaw = () => [
  { id: 101, label: 'Refund Reason', definition: { data_type: 'text', input_settings: { input_type: 'dropdown', choices: ['Damaged', 'Late', 'Wrong item'] } } },
  { id: 102, label: 'Order Value', definition: { data_type: 'number', input_settings: { input_type: 'input_number' } } },
  { id: 103, label: 'Legacy Field', deactivated_datetime: '2024-01-01T00:00:00Z', definition: { data_type: 'text', input_settings: { input_type: 'input' } } },
];

export function gorgiasTickets(n: number, startId = 1) {
  return Array.from({ length: n }, (_, i) => {
    const id = startId + i;
    return {
      id,
      subject: `Order #${id} question`,
      status: id % 5 === 0 ? 'closed' : 'open',
      channel: id % 2 ? 'email' : 'chat',
      priority: 'normal',
      tags: [{ name: id % 3 === 0 ? 'vip' : 'standard' }],
      customer: { id: 9000 + id, email: `c${id}@example.com` },
      assignee_user: { id: 7 },
      assignee_team: { id: 3 },
      custom_fields: { '101': { id: 101, value: id % 2 ? 'Damaged' : 'Late' }, '102': { id: 102, value: id * 10 } },
      created_datetime: new Date(Date.UTC(2025, 0, 1) + id * 60_000).toISOString(),
      updated_datetime: new Date(Date.UTC(2025, 0, 2) + id * 60_000).toISOString(),
      trashed_datetime: id % 50 === 0 ? '2025-03-01T00:00:00Z' : null,
    };
  });
}

export function gorgiasCustomers(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const id = 500 + i;
    return {
      id,
      name: `Customer ${id}`,
      email: `cust${id}@example.com`,
      // every 4th customer is deactivated, every 7th deleted
      active: i % 4 !== 3,
      deleted_datetime: i % 7 === 6 ? '2025-02-02T00:00:00Z' : null,
      data: { plan: i % 2 ? 'gold' : 'silver' },
      created_datetime: '2025-01-01T00:00:00Z',
      updated_datetime: '2025-01-05T00:00:00Z',
    };
  });
}

/**
 * Splits records into pages of `size`, each page re-including the last `overlap` records of the previous
 * page (shifting-window pagination) and optionally one exact duplicate inside the page.
 */
export function overlappingPages<T>(records: T[], size: number, overlap = 0, intraDup = false): T[][] {
  const pages: T[][] = [];
  for (let start = 0; start < records.length; start += size) {
    const from = Math.max(0, start - overlap);
    const page = records.slice(from, start + size);
    if (intraDup && page.length) page.push(page[0]!);
    pages.push(page);
  }
  return pages;
}

export interface FakeGorgiasOptions {
  /** resource path ("/api/tickets") -> pages */
  pages: Record<string, unknown[][]>;
  /** Override next cursor for page index i (to simulate loops). */
  nextCursor?: (resource: string, pageIndex: number, total: number) => string | null;
  /** Fail the first N requests with this status (Retry-After header included). */
  failFirst?: { count: number; status: number; retryAfter?: string };
}

/** fetch() double that serves cursor pages: cursor "c<i>" points at page i. */
export function fakeGorgiasFetch(o: FakeGorgiasOptions) {
  const calls: FakeCall[] = [];
  let failures = 0;
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, headers: new Headers(init?.headers) });
    if (o.failFirst && failures < o.failFirst.count) {
      failures++;
      return new Response('{"error":"slow down"}', {
        status: o.failFirst.status,
        headers: o.failFirst.retryAfter ? { 'Retry-After': o.failFirst.retryAfter } : {},
      });
    }
    const resource = url.pathname;
    if (resource === '/api/custom-fields') {
      return Response.json({ data: ticketFieldsRaw(), meta: { next_cursor: null, prev_cursor: null } });
    }
    const pages = o.pages[resource];
    if (!pages) return new Response('not found', { status: 404 });
    const cursor = url.searchParams.get('cursor');
    const idx = cursor ? Number(cursor.slice(1)) : 0;
    const data = pages[idx] ?? [];
    const next = o.nextCursor ? o.nextCursor(resource, idx, pages.length) : idx + 1 < pages.length ? `c${idx + 1}` : null;
    return Response.json({ data, meta: { next_cursor: next, prev_cursor: idx > 0 ? `c${idx - 1}` : null } });
  };
  return { fetch: impl as typeof fetch, calls };
}
