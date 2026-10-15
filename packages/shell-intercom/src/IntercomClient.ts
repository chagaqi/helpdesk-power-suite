import { HpsError, intercomFieldSchema, type CustomFieldDef } from '@hps/core-api';
import { fetchWithRetry, type RetryOptions } from './http.js';

/**
 * Intercom REST client (https://api.intercom.io, `Intercom-Version: 2.11`) with bearer auth.
 *
 * Pagination styles handled here:
 *  - `starting_after` cursors (contacts list/search, conversations): `pages.next.starting_after`;
 *  - the companies scroll API: `scroll_param` stays valid for the whole scroll, an empty page ends it.
 * Raw objects are returned untouched for core's Intercom normalizer.
 */

export interface IntercomClientOptions extends RetryOptions {
  /** Access token (OAuth or private app). */
  token: string;
  fetch?: typeof fetch;
  /** Regional hosts: https://api.eu.intercom.io, https://api.au.intercom.io. Default https://api.intercom.io */
  baseUrl?: string;
  /** API version header. Default 2.11. */
  version?: string;
}

export interface CursorPage<T = unknown> {
  data: T[];
  /** `starting_after` value for the next page, or null at the end. */
  nextCursor: string | null;
}

export interface ScrollPage<T = unknown> {
  data: T[];
  scrollParam: string | null;
}

export interface PageOptions {
  startingAfter?: string | null;
  /** 1..150 (Intercom maximum). Default 150. */
  perPage?: number;
  signal?: AbortSignal;
}

export type DataAttributeModel = 'contact' | 'company' | 'conversation';

export const INTERCOM_MAX_PAGE_SIZE = 150;
export const INTERCOM_API_VERSION = '2.11';

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});
const perPage = (n?: number) => Math.min(INTERCOM_MAX_PAGE_SIZE, Math.max(1, Math.floor(n ?? INTERCOM_MAX_PAGE_SIZE)));

/** Extracts the next `starting_after` from `pages.next` (object form, or legacy URL string). */
export function nextStartingAfter(pages: unknown): string | null {
  const next = obj(pages).next;
  if (typeof next === 'string' && next) {
    try {
      return new URL(next).searchParams.get('starting_after');
    } catch {
      return null;
    }
  }
  const sa = obj(next).starting_after;
  return typeof sa === 'string' && sa ? sa : null;
}

export class IntercomClient {
  readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: IntercomClientOptions) {
    if (!opts.token) throw new HpsError('invalid_request', 'Intercom access token is required');
    this.baseUrl = (opts.baseUrl ?? 'https://api.intercom.io').replace(/\/+$/, '');
    this.doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async listContacts(o: PageOptions = {}): Promise<CursorPage> {
    const q = new URLSearchParams({ per_page: String(perPage(o.perPage)) });
    if (o.startingAfter) q.set('starting_after', o.startingAfter);
    const body = obj(await this.request('GET', `/contacts?${q}`, undefined, o.signal));
    return { data: Array.isArray(body.data) ? body.data : [], nextCursor: nextStartingAfter(body.pages) };
  }

  /** POST /contacts/search with an Intercom search `query` object. */
  async searchContacts(query: unknown, o: PageOptions = {}): Promise<CursorPage> {
    const pagination: Raw = { per_page: perPage(o.perPage) };
    if (o.startingAfter) pagination.starting_after = o.startingAfter;
    const body = obj(await this.request('POST', '/contacts/search', { query, pagination }, o.signal));
    return { data: Array.isArray(body.data) ? body.data : [], nextCursor: nextStartingAfter(body.pages) };
  }

  /** One page of the companies scroll. Pass the previous `scrollParam`; an empty `data` ends the scroll. */
  async scrollCompanies(o: { scrollParam?: string | null; signal?: AbortSignal } = {}): Promise<ScrollPage> {
    const q = o.scrollParam ? `?${new URLSearchParams({ scroll_param: o.scrollParam })}` : '';
    const body = obj(await this.request('GET', `/companies/scroll${q}`, undefined, o.signal));
    const sp = body.scroll_param;
    return { data: Array.isArray(body.data) ? body.data : [], scrollParam: typeof sp === 'string' && sp ? sp : null };
  }

  async listConversations(o: PageOptions = {}): Promise<CursorPage> {
    const q = new URLSearchParams({ per_page: String(perPage(o.perPage)) });
    if (o.startingAfter) q.set('starting_after', o.startingAfter);
    const body = obj(await this.request('GET', `/conversations?${q}`, undefined, o.signal));
    const list = Array.isArray(body.conversations) ? body.conversations : Array.isArray(body.data) ? body.data : [];
    return { data: list, nextCursor: nextStartingAfter(body.pages) };
  }

  /** Teammates (single page: `{ type: 'admin.list', admins: [...] }`). */
  async listAdmins(o: { signal?: AbortSignal } = {}): Promise<unknown[]> {
    const body = obj(await this.request('GET', '/admins', undefined, o.signal));
    return Array.isArray(body.admins) ? body.admins : Array.isArray(body.data) ? body.data : [];
  }

  /** All workspace tags (`{ id, name }`), used to label contact tag references that only carry ids. */
  async listTags(o: { signal?: AbortSignal } = {}): Promise<{ id: string; name: string }[]> {
    const body = obj(await this.request('GET', '/tags', undefined, o.signal));
    const list = Array.isArray(body.data) ? body.data : [];
    return list.map(obj).filter((t) => t.id !== undefined && typeof t.name === 'string').map((t) => ({ id: String(t.id), name: String(t.name) }));
  }

  async listDataAttributes(model: DataAttributeModel, o: { signal?: AbortSignal } = {}): Promise<unknown[]> {
    const body = obj(await this.request('GET', `/data_attributes?${new URLSearchParams({ model })}`, undefined, o.signal));
    return Array.isArray(body.data) ? body.data : [];
  }

  /** Custom data attributes of a model mapped to the core export schema (via core `intercomFieldSchema`). */
  async fieldSchema(model: DataAttributeModel, o: { signal?: AbortSignal } = {}): Promise<CustomFieldDef[]> {
    return intercomFieldSchema(await this.listDataAttributes(model, o));
  }

  async request(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const res = await fetchWithRetry(
      this.doFetch,
      'Intercom',
      `${this.baseUrl}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          'Intercom-Version': this.opts.version ?? INTERCOM_API_VERSION,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      },
      this.opts,
    );
    return res.json();
  }
}
