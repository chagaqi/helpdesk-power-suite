import type { Catalog, FieldDef, FieldRef, NamedRef } from './types.js';

export const normName = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

export function suggest(name: string, candidates: string[], max = 3): string[] {
  const n = normName(name);
  return candidates
    .map((c) => ({ c, d: normName(c).includes(n) || n.includes(normName(c)) ? 0.5 : levenshtein(n, normName(c)) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(n.length / 3)))
    .sort((x, y) => x.d - y.d)
    .slice(0, max)
    .map((x) => x.c);
}

export type RefInput = string | { id?: string | number; name?: string };

export type Resolution<T> = { ok: true; value: T } | { ok: false; message: string; suggestions: string[] };

/** Resolves a field by human-readable name (preferred) or id. Never requires admins to know IDs. */
export function resolveField(catalog: Catalog, ref: RefInput): Resolution<FieldRef & { def: FieldDef }> {
  const id = typeof ref === 'object' && ref.id !== undefined ? String(ref.id) : undefined;
  const name = typeof ref === 'string' ? ref : ref.name;
  if (id !== undefined) {
    const def = catalog.fields.find((f) => f.id === id || f.key === id);
    if (def) return { ok: true, value: { id: def.id, name: def.name, def } };
    return { ok: false, message: `No ticket field with id "${id}"`, suggestions: [] };
  }
  if (!name || !name.trim()) return { ok: false, message: 'Field name is required', suggestions: [] };
  const matches = catalog.fields.filter((f) => normName(f.name) === normName(name));
  if (matches.length === 1) {
    const def = matches[0]!;
    return { ok: true, value: { id: def.id, name: def.name, def } };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message: `Field name "${name}" is ambiguous (${matches.length} fields share it). Pick one: ${matches.map((m) => `${m.name} [${m.type ?? 'field'} ${m.id}]`).join(', ')}`,
      suggestions: matches.map((m) => m.id),
    };
  }
  // Allow system keys typed by name ("priority").
  const byKey = catalog.fields.find((f) => (f.key ?? f.id).toLowerCase() === name.trim().toLowerCase());
  if (byKey) return { ok: true, value: { id: byKey.id, name: byKey.name, def: byKey } };
  const suggestions = suggest(name, catalog.fields.map((f) => f.name));
  return {
    ok: false,
    message: `No ticket field named "${name}"${suggestions.length ? `. Did you mean: ${suggestions.map((s) => `"${s}"`).join(', ')}?` : ''}`,
    suggestions,
  };
}

/** Resolves a group / form / brand / custom role by name or id against an (optional) catalog list. */
export function resolveNamed(list: NamedRef[] | undefined, ref: RefInput, what: string): Resolution<NamedRef> {
  const id = typeof ref === 'object' && ref.id !== undefined ? String(ref.id) : undefined;
  const name = typeof ref === 'string' ? ref : ref.name;
  if (!list || list.length === 0) {
    // Catalog not synced yet: keep the name; matching falls back to case-insensitive names.
    if (!name && !id) return { ok: false, message: `${what} name is required`, suggestions: [] };
    return { ok: true, value: id !== undefined ? { id, name: name ?? id } : { name: name! } };
  }
  if (id !== undefined) {
    const hit = list.find((g) => g.id === id);
    return hit ? { ok: true, value: { ...hit } } : { ok: false, message: `No ${what} with id "${id}"`, suggestions: [] };
  }
  const hits = list.filter((g) => normName(g.name) === normName(name ?? ''));
  if (hits.length === 1) return { ok: true, value: { ...hits[0]! } };
  if (hits.length > 1) return { ok: false, message: `${what} name "${name}" is ambiguous`, suggestions: hits.map((h) => h.id ?? h.name) };
  const suggestions = suggest(name ?? '', list.map((g) => g.name));
  return {
    ok: false,
    message: `No ${what} named "${name}"${suggestions.length ? `. Did you mean: ${suggestions.map((s) => `"${s}"`).join(', ')}?` : ''}`,
    suggestions,
  };
}

/** Matches two named refs: by id when both carry one, otherwise by normalized name. */
export function refMatches(a: NamedRef | string, b: NamedRef | string): boolean {
  const ra = typeof a === 'string' ? { name: a, id: a } : a;
  const rb = typeof b === 'string' ? { name: b, id: b } : b;
  if (ra.id !== undefined && rb.id !== undefined && ra.id === rb.id) return true;
  return normName(ra.name) === normName(rb.name);
}

/** Default shell key for a field when the catalog omits one. */
export const fieldKey = (f: Pick<FieldDef, 'id' | 'key'>): string => f.key ?? f.id;
