import type { CustomFieldDef, CustomFieldType, EntityType, NormalizedRecord, UserRole } from '../../types.js';
import { asRaw, idStr, isoDate, objectOrEmpty, requireId, str, tagList, type Raw } from './shared.js';

export function normalizeZendesk(entity: EntityType, input: unknown): NormalizedRecord {
  const r = asRaw(input, 'Zendesk record');
  const id = requireId(r);
  const base = { id, entity, source: 'zendesk' as const, createdAt: isoDate(r.created_at), updatedAt: isoDate(r.updated_at) };

  if (entity === 'ticket') {
    const custom: Record<string, unknown> = {};
    const cf = Array.isArray(r.custom_fields) ? r.custom_fields : Array.isArray(r.fields) ? r.fields : [];
    for (const f of cf as Raw[]) if (f && f.id !== undefined) custom[String(f.id)] = f.value;
    const via = objectOrEmpty(r.via);
    return {
      ...base,
      status: typeof r.status === 'string' ? r.status : undefined,
      archived: r.archived === true || r.is_archived === true,
      tags: tagList(r.tags),
      customFields: custom,
      fields: {
        subject: str(r.subject ?? r.raw_subject),
        priority: str(r.priority),
        type: str(r.type),
        channel: str(via.channel),
        requester_id: idStr(r.requester_id),
        requester_email: str(objectOrEmpty(r.requester).email),
        assignee_id: idStr(r.assignee_id),
        group_id: idStr(r.group_id),
        organization_id: idStr(r.organization_id),
        brand_id: idStr(r.brand_id),
        form_id: idStr(r.ticket_form_id),
      },
    };
  }

  if (entity === 'user') {
    return {
      ...base,
      role: zendeskRole(r),
      // Zendesk "active: false" means the user was deleted; treat it like suspended for filtering.
      suspended: r.suspended === true || r.active === false,
      tags: tagList(r.tags),
      customFields: { ...objectOrEmpty(r.user_fields) },
      fields: {
        name: str(r.name),
        email: str(r.email),
        verified: typeof r.verified === 'boolean' ? r.verified : null,
        phone: str(r.phone),
        organization_id: idStr(r.organization_id),
        external_id: str(r.external_id),
        time_zone: str(r.time_zone ?? r.iana_time_zone),
        last_login_at: isoDate(r.last_login_at) ?? null,
      },
    };
  }

  return {
    ...base,
    tags: tagList(r.tags),
    customFields: { ...objectOrEmpty(r.organization_fields) },
    fields: {
      name: str(r.name),
      domains: Array.isArray(r.domain_names) ? (r.domain_names as unknown[]).join('; ') || null : str(r.domain_names),
      external_id: str(r.external_id),
      group_id: idStr(r.group_id),
      notes: str(r.notes ?? r.details),
    },
  };
}

function zendeskRole(r: Raw): UserRole {
  const role = String(r.role ?? '').toLowerCase();
  if (role === 'admin') return 'admin';
  if (role === 'agent') return r.role_type === 1 ? 'light_agent' : 'agent';
  return 'end_user';
}

const ZD_TYPE: Record<string, CustomFieldType> = {
  text: 'text',
  textarea: 'textarea',
  checkbox: 'checkbox',
  date: 'date',
  integer: 'number',
  decimal: 'decimal',
  regexp: 'regexp',
  partialcreditcard: 'text',
  multiselect: 'multiselect',
  tagger: 'dropdown',
  dropdown: 'dropdown',
  lookup: 'lookup',
};

/** Maps Zendesk ticket_fields / user_fields / organization_fields to export schema (custom fields only). */
export function zendeskFieldSchema(entity: EntityType, fields: unknown[]): CustomFieldDef[] {
  const out: CustomFieldDef[] = [];
  for (const f of fields as Raw[]) {
    if (!f) continue;
    const type = ZD_TYPE[String(f.type)];
    if (!type) continue; // system fields: subject, status, priority, group, assignee...
    const key = entity === 'ticket' ? String(f.id) : String(f.key ?? f.id);
    const options = Array.isArray(f.custom_field_options)
      ? (f.custom_field_options as Raw[]).map((o) => ({ value: String(o.value), label: String(o.name ?? o.value) }))
      : undefined;
    out.push({ key, title: String(f.title ?? f.raw_title ?? key), type, options, active: f.active !== false });
  }
  return out;
}
