import type { EntityType, NormalizedRecord, UserRole } from '../../types.js';
import { asRaw, idStr, isoDate, NormalizationError, objectOrEmpty, requireId, str, tagList, type Raw } from './shared.js';

export function normalizeGorgias(entity: EntityType, input: unknown): NormalizedRecord {
  const r = asRaw(input, 'Gorgias record');
  const id = requireId(r);
  const base = {
    id,
    entity,
    source: 'gorgias' as const,
    createdAt: isoDate(r.created_datetime ?? r.created_at),
    updatedAt: isoDate(r.updated_datetime ?? r.updated_at),
  };

  if (entity === 'ticket') {
    const customer = objectOrEmpty(r.customer);
    const assignee = objectOrEmpty(r.assignee_user);
    const custom: Record<string, unknown> = {};
    const cf = r.custom_fields;
    if (Array.isArray(cf)) for (const f of cf as Raw[]) custom[String(f.id ?? f.field_id)] = f.value;
    else if (cf && typeof cf === 'object') for (const [k, v] of Object.entries(cf as Raw)) custom[k] = v && typeof v === 'object' && 'value' in (v as Raw) ? (v as Raw).value : v;
    return {
      ...base,
      status: str(r.status) === null ? undefined : String(r.status),
      archived: r.trashed_datetime != null,
      tags: tagList(r.tags),
      customFields: custom,
      fields: {
        subject: str(r.subject),
        priority: str(r.priority),
        type: null,
        channel: str(r.channel),
        requester_id: idStr(customer.id),
        requester_email: str(customer.email),
        assignee_id: idStr(assignee.id),
        group_id: idStr(objectOrEmpty(r.assignee_team).id),
        organization_id: null,
        brand_id: null,
        form_id: null,
      },
    };
  }

  if (entity === 'user') {
    // Gorgias has customers (end users) and users (agents with a role object).
    const roleObj = objectOrEmpty(r.role);
    const isAgent = typeof roleObj.name === 'string';
    const roleName = String(roleObj.name ?? '').toLowerCase();
    const role: UserRole = !isAgent
      ? 'end_user'
      : roleName === 'admin'
        ? 'admin'
        : roleName.includes('lite') || roleName.includes('observer')
          ? 'light_agent'
          : 'agent';
    const data = objectOrEmpty(r.data);
    const name = str(r.name) ?? ([r.firstname, r.lastname].filter((x) => typeof x === 'string' && x).join(' ') || null);
    return {
      ...base,
      role,
      suspended: r.active === false || r.deleted_datetime != null,
      tags: tagList(r.tags ?? data.tags),
      // Scalar attributes only: nested `data`/`meta` entries are integration payloads (Shopify, etc.), not fields.
      customFields: Object.fromEntries(
        Object.entries({ ...objectOrEmpty(r.meta), ...data }).filter(([, v]) => v === null || typeof v !== 'object'),
      ),
      fields: {
        name,
        email: str(r.email),
        verified: null,
        phone: null,
        organization_id: null,
        external_id: str(r.external_id),
        time_zone: str(r.timezone),
        last_login_at: null,
      },
    };
  }

  throw new NormalizationError('Gorgias has no organization entity; export customers (user) or tickets instead');
}
