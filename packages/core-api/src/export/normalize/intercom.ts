import type { CustomFieldDef, CustomFieldType, EntityType, NormalizedRecord, UserRole } from '../../types.js';
import { asRaw, idStr, isoDate, objectOrEmpty, requireId, str, tagList, type Raw } from './shared.js';

/** Intercom: contacts/admins (user), companies (organization), conversations/tickets (ticket). Timestamps are unix seconds. */
export function normalizeIntercom(entity: EntityType, input: unknown): NormalizedRecord {
  const r = asRaw(input, 'Intercom record');
  const id = requireId(r);
  const base = { id, entity, source: 'intercom' as const, createdAt: isoDate(r.created_at), updatedAt: isoDate(r.updated_at) };

  if (entity === 'ticket') {
    const src = objectOrEmpty(r.source);
    const author = objectOrEmpty(src.author);
    const state = str(r.ticket_state ?? r.state);
    return {
      ...base,
      status: state === null ? undefined : String(objectOrEmpty(r.ticket_state).category ?? state),
      archived: false,
      tags: tagList(r.tags),
      customFields: { ...objectOrEmpty(r.custom_attributes), ...objectOrEmpty(r.ticket_attributes) },
      fields: {
        subject: str(r.title ?? src.subject),
        priority: str(r.priority),
        type: str(r.type === 'ticket' ? objectOrEmpty(r.ticket_type).name ?? 'ticket' : 'conversation'),
        channel: str(src.type ?? src.delivered_as),
        requester_id: idStr(author.id),
        requester_email: str(author.email),
        assignee_id: idStr(r.admin_assignee_id),
        group_id: idStr(r.team_assignee_id),
        organization_id: null,
        brand_id: null,
        form_id: null,
      },
    };
  }

  if (entity === 'user') {
    const type = String(r.type ?? 'contact');
    const role: UserRole = type === 'admin' ? 'agent' : r.role === 'lead' ? 'lead' : 'end_user';
    const companies = objectOrEmpty(r.companies);
    const firstCompany = Array.isArray(companies.data) ? objectOrEmpty(companies.data[0]) : {};
    return {
      ...base,
      role,
      // Intercom has no suspension; archived contacts / deactivated teammates are the closest equivalent.
      suspended: r.archived === true || r.deactivated === true,
      tags: tagList(r.tags),
      customFields: { ...objectOrEmpty(r.custom_attributes) },
      fields: {
        name: str(r.name),
        email: str(r.email),
        verified: null,
        phone: str(r.phone),
        organization_id: idStr(firstCompany.id),
        external_id: str(r.external_id),
        time_zone: str(objectOrEmpty(r.location).timezone ?? null),
        last_login_at: isoDate(r.last_seen_at) ?? null,
      },
    };
  }

  return {
    ...base,
    tags: tagList(r.tags),
    customFields: { ...objectOrEmpty(r.custom_attributes) },
    fields: {
      name: str(r.name),
      domains: str(r.website),
      external_id: str(r.company_id),
      group_id: null,
      notes: str(objectOrEmpty(r.plan).name),
    },
  };
}

const IC_TYPE: Record<string, CustomFieldType> = {
  string: 'text',
  integer: 'number',
  float: 'decimal',
  boolean: 'checkbox',
  date: 'date',
  datetime: 'date',
};

/** Maps Intercom data_attributes (custom only) to export schema. */
export function intercomFieldSchema(attrs: unknown[]): CustomFieldDef[] {
  return (attrs as Raw[])
    .filter((a) => a && a.custom === true)
    .map((a) => ({
      key: String(a.name),
      title: String(a.label ?? a.name),
      type: IC_TYPE[String(a.data_type)] ?? 'text',
      options: Array.isArray(a.options) ? (a.options as unknown[]).map((o) => ({ value: String(o), label: String(o) })) : undefined,
      active: a.archived !== true,
    }));
}
