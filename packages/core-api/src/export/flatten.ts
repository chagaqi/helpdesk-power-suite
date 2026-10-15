import type { CustomFieldDef, NormalizedRecord, Primitive } from '../types.js';
import { customColumnKey } from './columns.js';

export type FlatRow = Record<string, Primitive>;

const optionLabel = (def: CustomFieldDef | undefined, v: unknown): string => {
  const sv = String(v);
  return def?.options?.find((o) => o.value === sv)?.label ?? sv;
};

/** Converts any raw custom-field value into a single spreadsheet-safe primitive. */
export function flattenValue(def: CustomFieldDef | undefined, value: unknown): Primitive {
  if (value === undefined || value === null || value === '') return null;
  const type = def?.type;
  if (Array.isArray(value)) {
    const parts = value
      .filter((v) => v !== null && v !== undefined && v !== '')
      .map((v) => (typeof v === 'object' ? (pickLabel(v) ?? JSON.stringify(v)) : optionLabel(def, v)));
    return parts.length ? parts.join('; ') : null;
  }
  if (type === 'checkbox') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
  }
  if ((type === 'number' || type === 'decimal') && typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  if (type === 'dropdown' || type === 'multiselect') return optionLabel(def, value);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'object') return pickLabel(value) ?? JSON.stringify(value);
  return String(value);
}

function pickLabel(v: unknown): string | undefined {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['name', 'label', 'title', 'value', 'email', 'id']) {
      const x = o[k];
      if (typeof x === 'string' || typeof x === 'number') return String(x);
    }
  }
  return undefined;
}

/**
 * Flattens a normalized record into `columnKey -> primitive`, resolving custom field values by the
 * schema (dropdown values -> option labels, multiselect arrays -> "a; b", checkbox -> boolean).
 * Custom fields absent from the schema are kept under their raw key so nothing is silently dropped.
 */
export function flattenRecord(rec: NormalizedRecord, schemaByKey: Map<string, CustomFieldDef>): FlatRow {
  const row: FlatRow = { ...rec.fields };
  row.id = rec.id;
  row.tags = rec.tags.length ? rec.tags.join(' ') : null;
  if (rec.entity === 'user') {
    row.suspended = rec.suspended === true;
    row.state = rec.suspended ? 'Suspended' : 'Active';
    if (rec.role) row.role = rec.role;
  }
  if (rec.entity === 'ticket') {
    row.archived = rec.archived === true;
    if (rec.status !== undefined) row.status = rec.status;
  }
  if (rec.createdAt) row.created_at = rec.createdAt;
  if (rec.updatedAt) row.updated_at = rec.updatedAt;
  for (const [key, value] of Object.entries(rec.customFields)) {
    row[customColumnKey(key)] = flattenValue(schemaByKey.get(key), value);
  }
  return row;
}
