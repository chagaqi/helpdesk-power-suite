import { zendeskFieldSchema } from '@hps/core-api/export';
import type { Catalog, CustomFieldDef, EntityType, FieldDef, NamedRef } from '@hps/core-api/rules';
import type { PageResult, SearchQuery } from '@hps/shell-kit';

/**
 * Pure Zendesk REST helpers (no ZAF dependency, unit-testable).
 * Uses cursor-based endpoints only, so exports never hit the 1,000-result offset search wall:
 *  - query text      -> /api/v2/search/export (cursor, unlimited results)
 *  - archived tickets -> /api/v2/incremental/tickets/cursor (includes archived + deleted tickets)
 *  - otherwise       -> /api/v2/{tickets|users|organizations} with page[size]/page[after]
 */
export type PageMode = 'search_export' | 'incremental' | 'list';

const LIST_KEY: Record<EntityType, string> = { ticket: 'tickets', user: 'users', organization: 'organizations' };
const ZD_ROLE: Record<string, string> = { admin: 'admin', agent: 'agent', light_agent: 'agent', end_user: 'end-user' };

export function pageMode(entity: EntityType, q: SearchQuery): PageMode {
  if (q.text) return 'search_export';
  if (entity === 'ticket' && q.includeArchived) return 'incremental';
  return 'list';
}

export function pageUrl(entity: EntityType, cursor: string | null, q: SearchQuery, pageSize = 100): string {
  const mode = pageMode(entity, q);
  if (mode === 'search_export') {
    const p = new URLSearchParams({ query: q.text!, 'filter[type]': entity, 'page[size]': String(Math.min(1000, pageSize * 10)) });
    if (cursor) p.set('page[after]', cursor);
    return `/api/v2/search/export.json?${p}`;
  }
  if (mode === 'incremental') {
    return cursor ? `/api/v2/incremental/tickets/cursor.json?cursor=${encodeURIComponent(cursor)}` : '/api/v2/incremental/tickets/cursor.json?start_time=0';
  }
  const p = new URLSearchParams({ 'page[size]': String(pageSize) });
  if (cursor) p.set('page[after]', cursor);
  let url = `/api/v2/${LIST_KEY[entity]}.json?${p}`;
  if (entity === 'user' && q.roles?.length) {
    for (const r of new Set(q.roles.map((x) => ZD_ROLE[x] ?? x))) url += `&role[]=${encodeURIComponent(r)}`;
  }
  return url;
}

type Json = Record<string, any>;

export function parsePage(entity: EntityType, q: SearchQuery, body: Json): PageResult {
  const mode = pageMode(entity, q);
  if (mode === 'incremental') {
    const records = (body.tickets ?? []) as unknown[];
    return { records, nextCursor: body.end_of_stream || !body.after_cursor ? null : String(body.after_cursor) };
  }
  const records = (mode === 'search_export' ? body.results : body[LIST_KEY[entity]]) ?? [];
  const more = body.meta?.has_more === true && body.meta?.after_cursor;
  return { records, nextCursor: more ? String(body.meta.after_cursor) : null, total: typeof body.count === 'number' ? body.count : undefined };
}

export const FIELD_ENDPOINT: Record<EntityType, { url: string; key: string }> = {
  ticket: { url: '/api/v2/ticket_fields.json', key: 'ticket_fields' },
  user: { url: '/api/v2/user_fields.json', key: 'user_fields' },
  organization: { url: '/api/v2/organization_fields.json', key: 'organization_fields' },
};

export const toExportSchema = (entity: EntityType, raw: unknown[]): CustomFieldDef[] => zendeskFieldSchema(entity, raw);

/** System ticket fields addressable through ZAF `ticketFields:<key>`. */
const SYSTEM_FIELDS: Record<string, { key: string; name?: string }> = {
  subject: { key: 'subject' },
  status: { key: 'status' },
  custom_status: { key: 'status' },
  priority: { key: 'priority' },
  basic_priority: { key: 'priority' },
  tickettype: { key: 'type' },
  group: { key: 'assignee', name: 'Group / Assignee' },
  assignee: { key: 'assignee' },
};

/** Builds the human-readable rule catalog (fields, groups, custom roles, forms, brands). */
export function buildCatalog(ticketFields: Json[], groups: Json[], customRoles: Json[] = [], forms: Json[] = [], brands: Json[] = []): Catalog {
  const fields: FieldDef[] = [];
  const seenSystemKeys = new Set<string>();
  const custom = new Map(zendeskFieldSchema('ticket', ticketFields).map((d) => [d.key, d]));
  for (const f of ticketFields) {
    if (!f || f.active === false) continue;
    const id = String(f.id);
    const c = custom.get(id);
    if (c) {
      fields.push({ id, name: c.title, key: `custom_field_${id}`, type: c.type, options: c.options });
      continue;
    }
    const sys = SYSTEM_FIELDS[String(f.type)];
    if (sys && !seenSystemKeys.has(sys.key)) {
      seenSystemKeys.add(sys.key);
      fields.push({ id: sys.key, name: sys.name ?? String(f.title ?? sys.key), key: sys.key, type: 'system', system: true });
    }
  }
  const named = (list: Json[]): NamedRef[] => list.filter((x) => x && x.name).map((x) => ({ id: String(x.id), name: String(x.name) }));
  return { fields, groups: named(groups), customRoles: named(customRoles), forms: named(forms), brands: named(brands) };
}

/** ZAF path used with client.get/client.set for a field key. */
export const ticketValuePath = (key: string) => (key.startsWith('custom_field_') ? `ticket.customField:${key}` : `ticket.${key}`);

/** ZAF change event for a field key. */
export const ticketChangeEvent = (key: string) => `ticket.${key}.changed`;

/** Maps the ZAF currentUser.role to the canonical role vocabulary. */
export function canonicalRole(role: unknown, customRoleName?: string): { role: string; customRole?: string } {
  const r = String(role ?? '').toLowerCase();
  if (r === 'admin') return { role: 'admin' };
  if (r === 'end-user' || r === 'end_user') return { role: 'end_user' };
  if (customRoleName && /light\s*agent/i.test(customRoleName)) return { role: 'light_agent', customRole: customRoleName };
  if (r === 'agent') return { role: 'agent', ...(customRoleName ? { customRole: customRoleName } : {}) };
  // Custom roles surface as their id/name: still an agent, matched by custom role name in rules.
  return { role: 'agent', customRole: customRoleName ?? String(role) };
}
