import { ExportSession, XLSX_MIME, type ExportFilters } from '@hps/core-api/export';
import type { CustomFieldDef } from '@hps/core-api/types';
import { runCursorLoop, type ExportProgress, type PageResult, type StopReason } from './cursorLoop.js';
import { utf8 } from './encoding.js';
import { UpstreamError } from './http.js';
import type { DataAttributeModel, IntercomClient } from './IntercomClient.js';

/** user = contacts (or teammates), organization = companies, ticket = conversations. */
export type IntercomExportEntity = 'user' | 'organization' | 'ticket';
export type IntercomUserKind = 'contacts' | 'admins';
export type ExportFormat = 'csv' | 'xlsx';

export interface IntercomExportOptions {
  client: IntercomClient;
  entity: IntercomExportEntity;
  /** Only for entity 'user'. Default 'contacts'. */
  userKind?: IntercomUserKind;
  /** Contacts only: Intercom search query object; switches to POST /contacts/search. */
  query?: unknown;
  filters?: ExportFilters;
  columns?: string[];
  rowLimit?: number;
  format: ExportFormat;
  /** Pre-fetched custom attribute schema; fetched from /data_attributes when omitted. */
  fieldSchema?: CustomFieldDef[];
  /** Replace contact tag ids with tag names via GET /tags (default true). */
  resolveTagNames?: boolean;
  pageSize?: number;
  maxPages?: number;
  filename?: string;
  onProgress?: (p: ExportProgress) => void;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface ExportResult {
  session: ExportSession;
  bytes: Uint8Array;
  filename: string;
  contentType: string;
  pages: number;
  stoppedBy: StopReason;
}

export const CSV_MIME = 'text/csv; charset=utf-8';

const MODEL: Record<IntercomExportEntity, DataAttributeModel> = { user: 'contact', organization: 'company', ticket: 'conversation' };

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

/** Missing read scope for data attributes should not block the export: fall back to raw attribute keys. */
async function schemaOrEmpty(client: IntercomClient, model: DataAttributeModel, signal?: AbortSignal): Promise<CustomFieldDef[]> {
  try {
    return await client.fieldSchema(model, { signal });
  } catch (e) {
    if (e instanceof UpstreamError && (e.status === 403 || e.status === 404)) return [];
    throw e;
  }
}

/**
 * Contact objects reference tags as `{ type: 'tag', id }` only (no name). Rewrites them with names
 * from GET /tags, fetched lazily once. Note: contacts list at most 10 tag refs inline (`has_more`).
 */
function tagNamer(client: IntercomClient, signal?: AbortSignal) {
  let names: Promise<Map<string, string>> | undefined;
  const load = () =>
    (names ??= client
      .listTags({ signal })
      .then((tags) => new Map(tags.map((t) => [t.id, t.name])))
      .catch((e: unknown) => {
        if (e instanceof UpstreamError && (e.status === 403 || e.status === 404)) return new Map<string, string>();
        throw e;
      }));
  return async (records: unknown[]): Promise<unknown[]> => {
    const needs = records.some((r) => {
      const list = obj(obj(r).tags).data;
      return Array.isArray(list) && list.some((t) => obj(t).name === undefined && obj(t).id !== undefined);
    });
    if (!needs) return records;
    const map = await load();
    return records.map((r) => {
      const rec = obj(r);
      const tags = obj(rec.tags);
      if (!Array.isArray(tags.data)) return r;
      const data = tags.data.map((t) => {
        const o = obj(t);
        const name = o.name ?? (o.id !== undefined ? map.get(String(o.id)) : undefined);
        return name === undefined ? t : { ...o, name };
      });
      return { ...rec, tags: { ...tags, data } };
    });
  };
}

/** Runs every Intercom page through a core ExportSession (source 'intercom') and renders CSV or XLSX. */
export async function exportIntercom(o: IntercomExportOptions): Promise<ExportResult> {
  const { client, signal } = o;
  const kind: IntercomUserKind = o.userKind ?? 'contacts';
  const admins = o.entity === 'user' && kind === 'admins';
  const fieldSchema = o.fieldSchema ?? (admins ? [] : await schemaOrEmpty(client, MODEL[o.entity], signal));
  const session = new ExportSession({ entity: o.entity, source: 'intercom', fieldSchema, filters: o.filters, columns: o.columns, rowLimit: o.rowLimit });

  let fetchPage: (cursor: string | null, signal?: AbortSignal) => Promise<PageResult>;
  let repeatingCursor = false;
  if (admins) {
    fetchPage = async (_c, s) => ({ records: await client.listAdmins({ signal: s }), nextCursor: null });
  } else if (o.entity === 'user') {
    const name = o.resolveTagNames === false ? async (r: unknown[]) => r : tagNamer(client, signal);
    fetchPage = async (cursor, s) => {
      const opts = { startingAfter: cursor, perPage: o.pageSize, signal: s };
      const page = o.query !== undefined ? await client.searchContacts(o.query, opts) : await client.listContacts(opts);
      return { records: await name(page.data), nextCursor: page.nextCursor };
    };
  } else if (o.entity === 'organization') {
    // Scroll API: the same scroll_param is returned for every page; an empty page means the end.
    repeatingCursor = true;
    fetchPage = async (cursor, s) => {
      const page = await client.scrollCompanies({ scrollParam: cursor, signal: s });
      return { records: page.data, nextCursor: page.data.length ? page.scrollParam : null };
    };
  } else {
    fetchPage = async (cursor, s) => {
      const page = await client.listConversations({ startingAfter: cursor, perPage: o.pageSize, signal: s });
      return { records: page.data, nextCursor: page.nextCursor };
    };
  }

  const { pages, stoppedBy } = await runCursorLoop(session, fetchPage, { maxPages: o.maxPages, signal, onProgress: o.onProgress, repeatingCursor });

  const what = o.entity === 'user' ? kind : o.entity === 'organization' ? 'companies' : 'conversations';
  const sheet = o.entity === 'user' ? (admins ? 'Teammates' : 'Contacts') : o.entity === 'organization' ? 'Companies' : 'Conversations';
  const date = (o.now?.() ?? new Date()).toISOString().slice(0, 10);
  const base = (o.filename ?? `intercom-${what}-${date}`).replace(/\.(csv|xlsx)$/i, '');
  const isXlsx = o.format === 'xlsx';
  const bytes = isXlsx ? session.toXlsx({ sheetName: sheet, title: `Intercom ${what} export`, now: o.now?.() }) : utf8(session.toCsv());
  return { session, bytes, filename: `${base}.${isXlsx ? 'xlsx' : 'csv'}`, contentType: isXlsx ? XLSX_MIME : CSV_MIME, pages, stoppedBy };
}
