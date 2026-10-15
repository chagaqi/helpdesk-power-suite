import type { CustomFieldDef, EntityType } from '../types.js';

export type ColumnKind = 'string' | 'number' | 'boolean' | 'date';

export interface ColumnSpec {
  /** Unique key: standard key ("email") or "cf:<fieldKey>" for custom fields. */
  key: string;
  /** Header label (human-readable). */
  label: string;
  kind: ColumnKind;
  origin: 'standard' | 'custom';
}

const s = (key: string, label: string, kind: ColumnKind = 'string'): ColumnSpec => ({ key, label, kind, origin: 'standard' });

export const STANDARD_COLUMNS: Record<EntityType, ColumnSpec[]> = {
  ticket: [
    s('id', 'Ticket ID'),
    s('subject', 'Subject'),
    s('status', 'Status'),
    s('priority', 'Priority'),
    s('type', 'Type'),
    s('channel', 'Channel'),
    s('requester_id', 'Requester ID'),
    s('requester_email', 'Requester Email'),
    s('assignee_id', 'Assignee ID'),
    s('group_id', 'Group ID'),
    s('organization_id', 'Organization ID'),
    s('brand_id', 'Brand ID'),
    s('form_id', 'Ticket Form ID'),
    s('tags', 'Tags'),
    s('archived', 'Archived', 'boolean'),
    s('created_at', 'Created At', 'date'),
    s('updated_at', 'Updated At', 'date'),
  ],
  user: [
    s('id', 'User ID'),
    s('name', 'Name'),
    s('email', 'Email'),
    s('role', 'Role'),
    s('state', 'State'),
    s('suspended', 'Suspended', 'boolean'),
    s('verified', 'Verified', 'boolean'),
    s('phone', 'Phone'),
    s('organization_id', 'Organization ID'),
    s('external_id', 'External ID'),
    s('tags', 'Tags'),
    s('time_zone', 'Time Zone'),
    s('created_at', 'Created At', 'date'),
    s('updated_at', 'Updated At', 'date'),
    s('last_login_at', 'Last Login At', 'date'),
  ],
  organization: [
    s('id', 'Organization ID'),
    s('name', 'Name'),
    s('domains', 'Domains'),
    s('external_id', 'External ID'),
    s('group_id', 'Group ID'),
    s('tags', 'Tags'),
    s('notes', 'Notes'),
    s('created_at', 'Created At', 'date'),
    s('updated_at', 'Updated At', 'date'),
  ],
};

export const customColumnKey = (fieldKey: string) => `cf:${fieldKey}`;

export function customColumn(def: CustomFieldDef): ColumnSpec {
  const kind: ColumnKind =
    def.type === 'number' || def.type === 'decimal'
      ? 'number'
      : def.type === 'checkbox'
        ? 'boolean'
        : def.type === 'date'
          ? 'date'
          : 'string';
  return { key: customColumnKey(def.key), label: def.title, kind, origin: 'custom' };
}

const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Builds the final column list. `selection` entries may be standard keys ("email"), standard labels
 * ("Last Login At"), custom field titles ("Customer Tier") or custom keys ("360001234" / "cf:360001234").
 * Titles shared by several custom fields are disambiguated with the field key so headers stay unique.
 */
export function resolveColumns(
  entity: EntityType,
  schema: CustomFieldDef[],
  selection?: string[],
  opts: { includeCustomFields?: boolean } = {},
): { columns: ColumnSpec[]; unknown: string[] } {
  const standard = STANDARD_COLUMNS[entity];
  const customs = schema.filter((d) => d.active !== false).map(customColumn);

  // Disambiguate duplicate labels across the whole set.
  const seen = new Map<string, number>();
  for (const c of [...standard, ...customs]) seen.set(norm(c.label), (seen.get(norm(c.label)) ?? 0) + 1);
  for (const c of customs) {
    if ((seen.get(norm(c.label)) ?? 0) > 1) c.label = `${c.label} (${c.key.slice(3)})`;
  }

  if (!selection || selection.length === 0) {
    return { columns: opts.includeCustomFields === false ? [...standard] : [...standard, ...customs], unknown: [] };
  }

  const all = [...standard, ...customs];
  const byKey = new Map(all.map((c) => [c.key, c]));
  const byLabel = new Map<string, ColumnSpec>();
  for (const c of all) if (!byLabel.has(norm(c.label))) byLabel.set(norm(c.label), c);
  // Also allow the original (non-disambiguated) custom title when unique.
  for (const d of schema) {
    const col = byKey.get(customColumnKey(d.key));
    if (col && !byLabel.has(norm(d.title))) byLabel.set(norm(d.title), col);
  }

  const out: ColumnSpec[] = [];
  const unknown: string[] = [];
  const used = new Set<string>();
  for (const raw of selection) {
    const col = byKey.get(raw) ?? byKey.get(customColumnKey(raw)) ?? byLabel.get(norm(raw));
    if (!col) {
      unknown.push(raw);
      continue;
    }
    if (!used.has(col.key)) {
      used.add(col.key);
      out.push(col);
    }
  }
  return { columns: out, unknown };
}
