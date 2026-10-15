import type { NormalizedRecord, Primitive, UserRole } from '../types.js';
import type { FlatRow } from './flatten.js';

export interface FieldFilter {
  /** Column key, standard label, custom field title or custom field key. */
  field: string;
  op?: 'eq' | 'neq' | 'contains' | 'empty' | 'not_empty';
  value?: Primitive;
}

export interface ExportFilters {
  /** Users: active vs suspended (suspended includes deleted/deactivated/blocked). */
  userState?: 'all' | 'active' | 'suspended';
  roles?: UserRole[];
  tags?: { any?: string[]; all?: string[]; none?: string[] };
  /** Tickets: allowed statuses (case-insensitive). */
  statuses?: string[];
  /** Tickets: include archived tickets (default true — the incumbent cannot). */
  includeArchived?: boolean;
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  fieldFilters?: FieldFilter[];
  /** Case-insensitive substring match across every exported cell. */
  text?: string;
}

const lc = (s: string) => s.trim().toLowerCase();

export interface CompiledFilter {
  (rec: NormalizedRecord, row: FlatRow): boolean;
}

/**
 * Compiles filters into a predicate. `resolveField` maps a filter field reference to a FlatRow key.
 */
export function compileFilters(f: ExportFilters = {}, resolveField: (ref: string) => string | undefined): CompiledFilter {
  const tests: CompiledFilter[] = [];

  if (f.userState && f.userState !== 'all') {
    const wantSuspended = f.userState === 'suspended';
    tests.push((rec) => rec.entity !== 'user' || (rec.suspended === true) === wantSuspended);
  }
  if (f.roles?.length) {
    const roles = new Set(f.roles);
    tests.push((rec) => rec.entity !== 'user' || (rec.role !== undefined && roles.has(rec.role)));
  }
  if (f.tags) {
    const any = (f.tags.any ?? []).map(lc);
    const all = (f.tags.all ?? []).map(lc);
    const none = (f.tags.none ?? []).map(lc);
    if (any.length || all.length || none.length) {
      tests.push((rec) => {
        const tags = new Set(rec.tags.map(lc));
        if (any.length && !any.some((t) => tags.has(t))) return false;
        if (all.length && !all.every((t) => tags.has(t))) return false;
        if (none.length && none.some((t) => tags.has(t))) return false;
        return true;
      });
    }
  }
  if (f.statuses?.length) {
    const st = new Set(f.statuses.map(lc));
    tests.push((rec) => rec.entity !== 'ticket' || (rec.status !== undefined && st.has(lc(rec.status))));
  }
  if (f.includeArchived === false) tests.push((rec) => rec.archived !== true);

  const dateTest = (bound: string | undefined, pick: (r: NormalizedRecord) => string | undefined, cmp: (a: number, b: number) => boolean) => {
    if (!bound) return;
    const b = Date.parse(bound);
    if (Number.isNaN(b)) throw new RangeError(`Invalid date filter: ${bound}`);
    tests.push((rec) => {
      const v = pick(rec);
      return v !== undefined && cmp(Date.parse(v), b);
    });
  };
  dateTest(f.createdAfter, (r) => r.createdAt, (a, b) => a >= b);
  dateTest(f.createdBefore, (r) => r.createdAt, (a, b) => a < b);
  dateTest(f.updatedAfter, (r) => r.updatedAt, (a, b) => a >= b);

  for (const ff of f.fieldFilters ?? []) {
    const key = resolveField(ff.field);
    if (!key) throw new RangeError(`Unknown filter field "${ff.field}"`);
    const op = ff.op ?? 'eq';
    const want = ff.value === undefined || ff.value === null ? '' : lc(String(ff.value));
    tests.push((_rec, row) => {
      const v = row[key];
      const s = v === null || v === undefined ? '' : lc(String(v));
      switch (op) {
        case 'eq':
          return s === want;
        case 'neq':
          return s !== want;
        case 'contains':
          return s.includes(want);
        case 'empty':
          return s === '';
        case 'not_empty':
          return s !== '';
      }
    });
  }

  if (f.text?.trim()) {
    const needle = lc(f.text);
    tests.push((_rec, row) => Object.values(row).some((v) => v !== null && lc(String(v)).includes(needle)));
  }

  return (rec, row) => tests.every((t) => t(rec, row));
}
