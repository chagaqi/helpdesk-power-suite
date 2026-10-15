/** Deterministic Intercom fixtures + an in-memory fake of the Intercom REST API (no network). */

export interface FakeCall {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

export const TAGS = [
  { type: 'tag', id: '11', name: 'VIP' },
  { type: 'tag', id: '12', name: 'Churn Risk' },
];

export function intercomContacts(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const id = `ct_${String(i + 1).padStart(5, '0')}`;
    return {
      type: 'contact',
      id,
      role: i % 10 === 9 ? 'lead' : 'user',
      name: `Contact ${i + 1}`,
      email: `contact${i + 1}@example.com`,
      phone: null,
      external_id: `ext-${i + 1}`,
      archived: i % 25 === 24,
      // Contacts only reference tags by id (names come from GET /tags).
      tags: { type: 'list', data: i % 3 === 0 ? [{ type: 'tag', id: '11', url: '/tags/11' }] : i % 3 === 1 ? [{ type: 'tag', id: '12', url: '/tags/12' }] : [], has_more: false },
      custom_attributes: { plan_tier: i % 2 ? 'gold' : 'silver', seats: i },
      companies: { type: 'list', data: [{ type: 'company', id: `co_${(i % 40) + 1}` }] },
      created_at: 1_700_000_000 + i,
      updated_at: 1_700_100_000 + i,
      last_seen_at: 1_700_200_000 + i,
    };
  });
}

export function intercomCompanies(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    type: 'company',
    id: `co_${i + 1}`,
    company_id: `acct-${i + 1}`,
    name: `Company ${i + 1}`,
    website: `https://c${i + 1}.example.com`,
    plan: { type: 'plan', id: '1', name: i % 2 ? 'Enterprise' : 'Starter' },
    tags: { type: 'tag.list', tags: i % 4 === 0 ? [{ type: 'tag', id: '11', name: 'VIP' }] : [] },
    custom_attributes: { region: i % 2 ? 'EMEA' : 'NA' },
    created_at: 1_690_000_000 + i,
    updated_at: 1_695_000_000 + i,
  }));
}

export const dataAttributes = (model: string) => {
  if (model === 'contact') {
    return [
      { type: 'data_attribute', name: 'email', label: 'Email', data_type: 'string', custom: false },
      { type: 'data_attribute', name: 'plan_tier', label: 'Plan Tier', data_type: 'string', custom: true, options: ['gold', 'silver'] },
      { type: 'data_attribute', name: 'seats', label: 'Seats', data_type: 'integer', custom: true },
    ];
  }
  if (model === 'company') return [{ type: 'data_attribute', name: 'region', label: 'Region', data_type: 'string', custom: true }];
  return [{ type: 'data_attribute', name: 'Escalation Reason', label: 'Escalation Reason', data_type: 'string', custom: true }];
};

/** Pages of `size`; each page re-includes the previous `overlap` records. */
export function overlappingPages<T>(records: T[], size: number, overlap = 0): T[][] {
  const pages: T[][] = [];
  for (let start = 0; start < records.length; start += size) pages.push(records.slice(Math.max(0, start - overlap), start + size));
  return pages;
}

export interface FakeIntercomOptions {
  contactPages?: unknown[][];
  companyPages?: unknown[][];
  /** Keep returning the last company page forever (broken scroll). */
  endlessScroll?: boolean;
  conversations?: unknown[][];
  admins?: unknown[];
  failFirst?: { count: number; status: number; headers?: Record<string, string> };
  /** Status to return for /data_attributes (e.g. 403 missing scope). */
  dataAttributesStatus?: number;
}

export function fakeIntercomFetch(o: FakeIntercomOptions) {
  const calls: FakeCall[] = [];
  let failures = 0;
  const pageResponse = (pages: unknown[][], startingAfter: string | null, key = 'data') => {
    // Cursor = id of the last record of the previous page (Intercom semantics), encoded with the page index.
    const idx = startingAfter ? Number(startingAfter.split(':')[1]) : 0;
    const data = pages[idx] ?? [];
    const last = data.at(-1) as { id?: string } | undefined;
    const next = idx + 1 < pages.length ? { page: idx + 2, starting_after: `${last?.id ?? 'x'}:${idx + 1}` } : null;
    return Response.json({ type: 'list', [key]: data, pages: { type: 'pages', page: idx + 1, per_page: 150, total_pages: pages.length, next } });
  };

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method ?? 'GET', url, headers: new Headers(init?.headers), body });
    if (o.failFirst && failures < o.failFirst.count) {
      failures++;
      return new Response('{"type":"error.list"}', { status: o.failFirst.status, headers: o.failFirst.headers ?? {} });
    }
    switch (url.pathname) {
      case '/contacts':
        return pageResponse(o.contactPages ?? [[]], url.searchParams.get('starting_after'));
      case '/contacts/search':
        return pageResponse(o.contactPages ?? [[]], (body as { pagination?: { starting_after?: string } })?.pagination?.starting_after ?? null);
      case '/conversations':
        return pageResponse(o.conversations ?? [[]], url.searchParams.get('starting_after'), 'conversations');
      case '/companies/scroll': {
        const pages = o.companyPages ?? [];
        const sp = url.searchParams.get('scroll_param');
        // Intercom keeps the same scroll_param for the whole scroll; we count requests server-side.
        const served = calls.filter((c) => c.url.pathname === '/companies/scroll').length - 1;
        const data = served < pages.length ? pages[served]! : o.endlessScroll ? pages.at(-1)! : [];
        return Response.json({ type: 'list', data, scroll_param: sp ?? 'scroll-abc', pages: null });
      }
      case '/admins':
        return Response.json({ type: 'admin.list', admins: o.admins ?? [] });
      case '/tags':
        return Response.json({ type: 'list', data: TAGS });
      case '/data_attributes':
        if (o.dataAttributesStatus) return new Response('{}', { status: o.dataAttributesStatus });
        return Response.json({ type: 'list', data: dataAttributes(url.searchParams.get('model') ?? '') });
      default:
        return new Response('not found', { status: 404 });
    }
  };
  return { fetch: impl as typeof fetch, calls };
}
