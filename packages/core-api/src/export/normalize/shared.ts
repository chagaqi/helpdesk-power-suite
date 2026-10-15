import type { Primitive } from '../../types.js';

export type Raw = Record<string, unknown>;

export class NormalizationError extends Error {
  constructor(message: string, readonly index?: number) {
    super(message);
    this.name = 'NormalizationError';
  }
}

export const asRaw = (v: unknown, what: string): Raw => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new NormalizationError(`${what} must be an object`);
  return v as Raw;
};

export function requireId(r: Raw, key = 'id'): string {
  const id = r[key];
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  if (typeof id === 'string' && id.trim() !== '') return id.trim();
  throw new NormalizationError(`record is missing a usable "${key}"`);
}

export const str = (v: unknown): Primitive => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
};

export const idStr = (v: unknown): Primitive => (v === undefined || v === null || v === '' ? null : String(v));

/** Accepts ISO strings or unix seconds/milliseconds and returns ISO-8601 (UTC) or undefined. */
export function isoDate(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  return undefined;
}

/** Normalizes tag lists that arrive as strings, {name} objects or Intercom {data|tags:[...]} envelopes. */
export function tagList(v: unknown): string[] {
  let list: unknown[] = [];
  if (Array.isArray(v)) list = v;
  else if (v && typeof v === 'object') {
    const o = v as Raw;
    if (Array.isArray(o.data)) list = o.data;
    else if (Array.isArray(o.tags)) list = o.tags;
  } else if (typeof v === 'string') list = v.split(/[\s,]+/);
  const out: string[] = [];
  for (const t of list) {
    const name = typeof t === 'string' ? t : t && typeof t === 'object' ? ((t as Raw).name ?? (t as Raw).id) : undefined;
    if (typeof name === 'string' && name.trim()) out.push(name.trim());
    else if (typeof name === 'number') out.push(String(name));
  }
  return Array.from(new Set(out));
}

export const objectOrEmpty = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
