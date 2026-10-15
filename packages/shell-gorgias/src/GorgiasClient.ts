import { HpsError, type CustomFieldDef, type CustomFieldType, type FieldOption } from '@hps/core-api';
import { bytesToBase64 } from './encoding.js';
import { fetchWithRetry, type RetryOptions } from './http.js';

/**
 * Gorgias REST client (https://{account}.gorgias.com/api) with HTTP Basic auth (`email:apiKey`).
 *
 * Every list endpoint is cursor paginated: `GET /api/<resource>?limit=100&cursor=...` returns
 * `{ data: [...], meta: { next_cursor, prev_cursor } }`. Raw objects are returned untouched so the core
 * Gorgias normalizer (packages/core-api/src/export/normalize/gorgias.ts) sees the native shape.
 */

export interface GorgiasClientOptions extends RetryOptions {
  /** Subdomain ("acme"), host ("acme.gorgias.com") or URL. */
  account: string;
  /** Email of the Gorgias user that owns the API key. */
  email: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** Override for tests / proxies. Defaults to https://{account}.gorgias.com/api */
  baseUrl?: string;
  userAgent?: string;
}

export interface CursorPage<T = unknown> {
  data: T[];
  nextCursor: string | null;
  prevCursor: string | null;
}

export interface ListOptions {
  cursor?: string | null;
  /** Page size, 1..100 (Gorgias maximum). Default 100. */
  limit?: number;
  signal?: AbortSignal;
}

export const GORGIAS_MAX_PAGE_SIZE = 100;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Normalizes "Acme", "acme.gorgias.com" or "https://acme.gorgias.com/app" to "acme". Rejects anything else (SSRF guard). */
export function gorgiasAccountSlug(input: string): string {
  let host = String(input ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0] ?? '';
  host = host.replace(/:\d+$/, '').replace(/\.gorgias\.com$/, '');
  if (!SLUG_RE.test(host)) throw new HpsError('invalid_request', `Invalid Gorgias account "${input}"`);
  return host;
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

export class GorgiasClient {
  readonly account: string;
  readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: GorgiasClientOptions) {
    this.account = gorgiasAccountSlug(opts.account);
    this.baseUrl = (opts.baseUrl ?? `https://${this.account}.gorgias.com/api`).replace(/\/+$/, '');
    if (!opts.email || !opts.apiKey) throw new HpsError('invalid_request', 'Gorgias email and API key are required');
    this.authHeader = `Basic ${bytesToBase64(new TextEncoder().encode(`${opts.email}:${opts.apiKey}`))}`;
    // Bind so a bare global fetch keeps its receiver.
    this.doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Tickets, oldest first so pages stay stable while new tickets arrive mid-export. */
  listTickets(o: ListOptions = {}): Promise<CursorPage> {
    return this.list('/tickets', o, { order_by: 'created_datetime:asc' });
  }

  /** Customers (end users). */
  listCustomers(o: ListOptions = {}): Promise<CursorPage> {
    return this.list('/customers', o, { order_by: 'created_datetime:asc' });
  }

  /** Users = agents/admins (objects carry a `role: { name }`). */
  listUsers(o: ListOptions = {}): Promise<CursorPage> {
    return this.list('/users', o);
  }

  /** Raw ticket custom field definitions (all pages). */
  async listTicketCustomFieldsRaw(o: { signal?: AbortSignal; maxPages?: number } = {}): Promise<Raw[]> {
    const out: Raw[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < (o.maxPages ?? 50); i++) {
      const page: CursorPage = await this.list('/custom-fields', { cursor, signal: o.signal }, { object_type: 'Ticket' });
      out.push(...(page.data as Raw[]));
      if (!page.nextCursor || seen.has(page.nextCursor)) break;
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return out;
  }

  /** Ticket custom fields mapped to the core export schema (key = String(id), title = label). */
  async listTicketCustomFields(o: { signal?: AbortSignal } = {}): Promise<CustomFieldDef[]> {
    return gorgiasFieldSchema(await this.listTicketCustomFieldsRaw(o));
  }

  /** GET helper for one cursor page. */
  async list(path: string, o: ListOptions = {}, extra: Record<string, string> = {}): Promise<CursorPage> {
    const limit = Math.min(GORGIAS_MAX_PAGE_SIZE, Math.max(1, Math.floor(o.limit ?? GORGIAS_MAX_PAGE_SIZE)));
    const q = new URLSearchParams({ limit: String(limit), ...extra });
    if (o.cursor) q.set('cursor', o.cursor);
    const body = obj(await this.getJson(`${path}?${q.toString()}`, o.signal));
    const meta = obj(body.meta);
    const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
    return {
      data: Array.isArray(body.data) ? body.data : [],
      nextCursor: str(meta.next_cursor),
      prevCursor: str(meta.prev_cursor),
    };
  }

  async getJson(pathAndQuery: string, signal?: AbortSignal): Promise<unknown> {
    const res = await fetchWithRetry(
      this.doFetch,
      'Gorgias',
      `${this.baseUrl}${pathAndQuery}`,
      {
        method: 'GET',
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json',
          ...(this.opts.userAgent ? { 'User-Agent': this.opts.userAgent } : {}),
        },
        signal,
      },
      this.opts,
    );
    return res.json();
  }
}

function fieldType(def: Raw): CustomFieldType {
  const input = String(obj(def.input_settings).input_type ?? '').toLowerCase();
  const data = String(def.data_type ?? '').toLowerCase();
  if (input === 'dropdown' || input === 'select') return 'dropdown';
  if (input === 'multiselect' || input === 'multi_select') return 'multiselect';
  if (input === 'textarea') return 'textarea';
  if (data === 'boolean' || input === 'checkbox') return 'checkbox';
  if (data === 'number' || input === 'input_number') return 'number';
  if (data === 'date' || data === 'datetime') return 'date';
  if (data === 'text' || input === 'input') return 'text';
  return 'unknown';
}

/** Maps Gorgias `/api/custom-fields` objects (best-effort across definition variants) to core CustomFieldDef. */
export function gorgiasFieldSchema(raw: unknown[]): CustomFieldDef[] {
  const out: CustomFieldDef[] = [];
  for (const item of raw) {
    const f = obj(item);
    if (f.id === undefined || f.id === null) continue;
    const def = obj(f.definition);
    const choices = obj(def.input_settings).choices;
    const options: FieldOption[] | undefined = Array.isArray(choices)
      ? choices
          .map((c): FieldOption | null => {
            if (c === null || c === undefined) return null;
            if (typeof c !== 'object') return { value: String(c), label: String(c) };
            const o = obj(c);
            const value = o.value ?? o.id ?? o.label;
            return value === undefined ? null : { value: String(value), label: String(o.label ?? o.name ?? value) };
          })
          .filter((x): x is FieldOption => x !== null)
      : undefined;
    out.push({
      key: String(f.id),
      title: String(f.label ?? f.name ?? f.id),
      type: fieldType(def),
      ...(options?.length ? { options } : {}),
      active: f.deactivated_datetime == null && f.archived !== true,
    });
  }
  return out;
}

/** Rule-builder catalog fields (id = Gorgias field id, name = label) for `VisualFieldRuleEngine.syncCatalog`. */
export const gorgiasCatalogFields = (defs: CustomFieldDef[]) =>
  defs.filter((d) => d.active !== false).map((d) => ({ id: d.key, name: d.title, type: d.type, ...(d.options ? { options: d.options } : {}) }));
