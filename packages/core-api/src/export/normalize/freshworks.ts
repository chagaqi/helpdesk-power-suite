import type { CustomFieldDef, CustomFieldType, EntityType, NormalizedRecord, Platform, UserRole } from '../../types.js';
import { asRaw, idStr, isoDate, objectOrEmpty, requireId, str, tagList, type Raw } from './shared.js';

const STATUS: Record<number, string> = { 2: 'open', 3: 'pending', 4: 'resolved', 5: 'closed' };
const PRIORITY: Record<number, string> = { 1: 'low', 2: 'medium', 3: 'high', 4: 'urgent' };
const SOURCE: Record<number, string> = {
  1: 'email',
  2: 'portal',
  3: 'phone',
  7: 'chat',
  9: 'feedback_widget',
  10: 'outbound_email',
};

/** Freshdesk + Freshservice (same REST v2 conventions; Freshservice uses requesters/departments). */
export function normalizeFreshworks(source: Extract<Platform, 'freshdesk' | 'freshservice'>, entity: EntityType, input: unknown): NormalizedRecord {
  const r = asRaw(input, `${source} record`);
  const id = requireId(r);
  const base = { id, entity, source, createdAt: isoDate(r.created_at), updatedAt: isoDate(r.updated_at) };

  if (entity === 'ticket') {
    const statusNum = typeof r.status === 'number' ? r.status : Number(r.status);
    return {
      ...base,
      status: STATUS[statusNum] ?? (r.status === undefined ? undefined : String(r.status)),
      archived: r.archived === true || r.deleted === true,
      tags: tagList(r.tags),
      customFields: { ...objectOrEmpty(r.custom_fields) },
      fields: {
        subject: str(r.subject),
        priority: PRIORITY[Number(r.priority)] ?? str(r.priority),
        type: str(r.type),
        channel: SOURCE[Number(r.source)] ?? str(r.source),
        requester_id: idStr(r.requester_id),
        requester_email: str(objectOrEmpty(r.requester).email ?? r.email),
        assignee_id: idStr(r.responder_id),
        group_id: idStr(r.group_id),
        organization_id: idStr(r.company_id ?? r.department_id),
        brand_id: idStr(r.product_id),
        form_id: idStr(r.form_id),
      },
    };
  }

  if (entity === 'user') {
    const isAgent = r.contact !== undefined && (r.ticket_scope !== undefined || r.occasional !== undefined || r.role_ids !== undefined);
    const contact = isAgent ? objectOrEmpty(r.contact) : r;
    const name =
      str(contact.name) ??
      ([contact.first_name, contact.last_name].filter((x) => typeof x === 'string' && x).join(' ') || null);
    return {
      ...base,
      role: freshRole(r, isAgent),
      suspended: r.deleted === true || r.blocked === true || r.deactivated === true || (isAgent && r.active === false) ||
        (source === 'freshservice' && r.active === false),
      tags: tagList(contact.tags ?? r.tags),
      customFields: { ...objectOrEmpty(r.custom_fields ?? contact.custom_fields) },
      fields: {
        name,
        email: str(contact.email ?? contact.primary_email),
        verified: source === 'freshdesk' && typeof contact.active === 'boolean' ? contact.active : null,
        phone: str(contact.phone ?? contact.mobile ?? contact.work_phone_number),
        organization_id: idStr(r.company_id ?? (Array.isArray(r.department_ids) ? r.department_ids[0] : undefined)),
        external_id: str(contact.unique_external_id ?? contact.external_id),
        time_zone: str(contact.time_zone),
        last_login_at: isoDate(contact.last_login_at ?? r.last_login_at) ?? null,
      },
    };
  }

  return {
    ...base,
    tags: tagList(r.tags),
    customFields: { ...objectOrEmpty(r.custom_fields) },
    fields: {
      name: str(r.name),
      domains: Array.isArray(r.domains) ? (r.domains as unknown[]).join('; ') || null : str(r.domains),
      external_id: str(r.external_id),
      group_id: null,
      notes: str(r.note ?? r.description),
    },
  };
}

function freshRole(r: Raw, isAgent: boolean): UserRole {
  if (!isAgent) return 'end_user';
  const names = (Array.isArray(r.role_names) ? r.role_names : []).map((x) => String(x).toLowerCase());
  if (r.role === 'admin' || names.some((n) => n.includes('admin'))) return 'admin';
  if (r.occasional === true) return 'light_agent';
  return 'agent';
}

const FD_TYPE: Record<string, CustomFieldType> = {
  custom_text: 'text',
  custom_paragraph: 'textarea',
  custom_checkbox: 'checkbox',
  custom_number: 'number',
  custom_decimal: 'decimal',
  custom_date: 'date',
  custom_date_time: 'date',
  custom_dropdown: 'dropdown',
  nested_field: 'dropdown',
  custom_multi_select_dropdown: 'multiselect',
  custom_url: 'text',
  custom_phone_number: 'text',
  custom_lookup: 'lookup',
};

/** Maps Freshdesk ticket_fields / contact_fields / company_fields (custom only) to export schema. */
export function freshworksFieldSchema(fields: unknown[]): CustomFieldDef[] {
  const out: CustomFieldDef[] = [];
  for (const f of fields as Raw[]) {
    if (!f) continue;
    const type = FD_TYPE[String(f.type)];
    if (!type && f.default !== false) continue;
    const key = String(f.name ?? f.id);
    let options: CustomFieldDef['options'];
    if (Array.isArray(f.choices)) {
      options = (f.choices as unknown[]).map((c) =>
        typeof c === 'object' && c ? { value: String((c as Raw).value ?? (c as Raw).id), label: String((c as Raw).label ?? (c as Raw).value) } : { value: String(c), label: String(c) },
      );
    } else if (f.choices && typeof f.choices === 'object') {
      options = Object.keys(f.choices as Raw).map((k) => ({ value: k, label: k }));
    }
    out.push({ key, title: String(f.label ?? f.label_for_customers ?? key), type: type ?? 'unknown', options });
  }
  return out;
}
