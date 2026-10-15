import { freshworksFieldSchema } from '@hps/core-api/export';
import type { Catalog, CustomFieldDef, EntityType, FieldDef, NamedRef } from '@hps/core-api/rules';

/**
 * Pure Freshdesk / Freshservice REST helpers shared by the browser app and the serverless bundle.
 *
 * Freshdesk list endpoints are page-based and cap at page 300, and /tickets only returns tickets
 * created in the last 30 days unless `updated_since` is given. We turn them into a keyset cursor:
 * `updated_since` starts at the epoch (all history), pages advance 1..300, and at the cap we restart
 * from the last record's `updated_at`. Overlap at the seam is removed by the engine's ID dedupe.
 */
export type Product = 'freshdesk' | 'freshservice';

export interface FdCursor {
  since: string;
  page: number;
}

export const EPOCH = '1970-01-01T00:00:00Z';
export const PER_PAGE = 100;
export const MAX_PAGE = 300;

export const encodeCursor = (c: FdCursor) => `${c.since}|${c.page}`;
export function decodeCursor(s: string | null): FdCursor {
  if (!s) return { since: EPOCH, page: 1 };
  const [since, page] = s.split('|');
  const p = Number(page);
  if (!since || Number.isNaN(Date.parse(since)) || !Number.isInteger(p) || p < 1 || p > MAX_PAGE) throw new Error('Invalid Freshdesk cursor');
  return { since, page: p };
}

/** Request template + context for one page. Templates are declared in config/requests.json. */
export function pageRequest(product: Product, entity: EntityType, cursor: string | null): { template: string; context: Record<string, string> } {
  const c = decodeCursor(cursor);
  const page = String(c.page);
  if (entity === 'ticket') return { template: 'fdTickets', context: { page, updated_since: c.since } };
  if (entity === 'user') return product === 'freshservice' ? { template: 'fsRequesters', context: { page } } : { template: 'fdContacts', context: { page } };
  return product === 'freshservice' ? { template: 'fsDepartments', context: { page } } : { template: 'fdCompanies', context: { page } };
}

/** Computes the next cursor from a page of records. */
export function nextCursor(entity: EntityType, cursor: string | null, records: Record<string, unknown>[]): string | null {
  if (records.length < PER_PAGE) return null;
  const c = decodeCursor(cursor);
  if (c.page < MAX_PAGE) return encodeCursor({ since: c.since, page: c.page + 1 });
  if (entity !== 'ticket') return null; // non-ticket lists have no keyset; 30,000 is their API ceiling
  const last = records[records.length - 1]?.updated_at;
  if (typeof last !== 'string' || last <= c.since) return null; // cannot advance safely
  return encodeCursor({ since: last, page: 1 });
}

/** Unwraps list responses (Freshservice wraps lists in {tickets:[]}, {requesters:[]}, ...). */
export function listRecords(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === 'object') {
    const arr = Object.values(body as Record<string, unknown>).find(Array.isArray);
    if (arr) return arr as Record<string, unknown>[];
  }
  return [];
}

export const FIELD_PATHS: Record<EntityType, string> = {
  ticket: '/api/v2/ticket_fields',
  user: '/api/v2/contact_fields',
  organization: '/api/v2/company_fields',
};

export const toExportSchema = (raw: unknown[]): CustomFieldDef[] => freshworksFieldSchema(raw);

/** Ticket-details property ids addressable via client.interface.trigger('hide', { id }). */
const SYSTEM_IDS = new Set(['priority', 'status', 'ticket_type', 'group', 'agent', 'product', 'source', 'company']);

export function buildCatalog(ticketFields: Record<string, any>[], groups: Record<string, any>[], roles: Record<string, any>[] = [], products: Record<string, any>[] = []): Catalog {
  const custom = new Map(freshworksFieldSchema(ticketFields).map((d) => [d.key, d]));
  const fields: FieldDef[] = [];
  for (const f of ticketFields) {
    const name = String(f.name ?? '');
    const c = custom.get(name);
    if (c) fields.push({ id: name, name: c.title, key: name, type: c.type, options: c.options });
    else if (SYSTEM_IDS.has(name)) fields.push({ id: name, name: String(f.label ?? name), key: name, type: 'system', system: true, options: choiceOptions(f.choices) });
  }
  const named = (list: Record<string, any>[]): NamedRef[] => list.filter((x) => x?.name).map((x) => ({ id: String(x.id), name: String(x.name) }));
  return { fields, groups: named(groups), customRoles: named(roles), brands: named(products) };
}

function choiceOptions(choices: unknown) {
  if (!choices || typeof choices !== 'object') return undefined;
  if (Array.isArray(choices)) return choices.map((c) => ({ value: String(c), label: String(c) }));
  // Freshdesk default fields: { "Low": 1, "Medium": 2 } or { "2": ["Open", "Being Processed"] }
  return Object.entries(choices as Record<string, unknown>).map(([k, v]) =>
    Array.isArray(v) ? { value: k, label: String(v[0]) } : { value: String(v), label: k },
  );
}

/** Canonical role from the FDK loggedInUser + role catalog. */
export function canonicalRole(user: Record<string, any>, roles: NamedRef[]): { role: string; customRole?: string } {
  const ids = ((user.role_ids ?? user.roles ?? []) as unknown[]).map(String);
  const names = roles.filter((r) => r.id !== undefined && ids.includes(r.id)).map((r) => r.name);
  if (names.some((n) => /administrator/i.test(n))) return { role: 'admin', customRole: names[0] };
  if (user.occasional === true) return { role: 'light_agent', customRole: names[0] };
  return { role: 'agent', ...(names[0] ? { customRole: names[0] } : {}) };
}

/** Flattens an FDK `ticket` data object into field-id -> value (system + cf_*). */
export function ticketValues(t: Record<string, any>): Record<string, unknown> {
  return {
    priority: t.priority,
    status: t.status,
    ticket_type: t.type,
    group: t.group_id,
    agent: t.responder_id,
    product: t.product_id,
    source: t.source,
    company: t.company_id,
    ...(t.custom_fields ?? {}),
  };
}
