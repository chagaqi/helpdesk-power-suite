import { ExportSession, XLSX_MIME, type ExportFilters } from '@hps/core-api/export';
import type { CustomFieldDef } from '@hps/core-api/types';
import { utf8 } from './encoding.js';
import { runCursorLoop, type ExportProgress, type StopReason } from './cursorLoop.js';
import type { GorgiasClient } from './GorgiasClient.js';

export type GorgiasExportEntity = 'ticket' | 'user';
/** Gorgias splits people into customers (end users) and users (agents/admins). */
export type GorgiasUserKind = 'customers' | 'agents';
export type ExportFormat = 'csv' | 'xlsx';

export interface GorgiasExportOptions {
  client: GorgiasClient;
  entity: GorgiasExportEntity;
  /** Only for entity 'user'. Default 'customers'. */
  userKind?: GorgiasUserKind;
  filters?: ExportFilters;
  /** Column preset: standard keys/labels or custom field titles. Default: everything. */
  columns?: string[];
  /** Entitlement row cap (unique rows). Undefined = unlimited. */
  rowLimit?: number;
  format: ExportFormat;
  /** Pre-fetched ticket field schema; fetched from /api/custom-fields when omitted. */
  fieldSchema?: CustomFieldDef[];
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

/** Pulls every cursor page from Gorgias through a core ExportSession and renders CSV (UTF-8 BOM) or XLSX. */
export async function exportGorgias(o: GorgiasExportOptions): Promise<ExportResult> {
  const kind: GorgiasUserKind = o.userKind ?? 'customers';
  const fieldSchema = o.fieldSchema ?? (o.entity === 'ticket' ? await o.client.listTicketCustomFields({ signal: o.signal }) : []);
  const session = new ExportSession({
    entity: o.entity,
    source: 'gorgias',
    fieldSchema,
    filters: o.filters,
    columns: o.columns,
    rowLimit: o.rowLimit,
  });

  const list =
    o.entity === 'ticket'
      ? o.client.listTickets.bind(o.client)
      : kind === 'agents'
        ? o.client.listUsers.bind(o.client)
        : o.client.listCustomers.bind(o.client);

  const { pages, stoppedBy } = await runCursorLoop(
    session,
    async (cursor, signal) => {
      const page = await list({ cursor, limit: o.pageSize, signal });
      return { records: page.data, nextCursor: page.nextCursor };
    },
    { maxPages: o.maxPages, signal: o.signal, onProgress: o.onProgress },
  );

  const what = o.entity === 'ticket' ? 'tickets' : kind;
  const date = (o.now?.() ?? new Date()).toISOString().slice(0, 10);
  const base = (o.filename ?? `gorgias-${what}-${date}`).replace(/\.(csv|xlsx)$/i, '');
  const isXlsx = o.format === 'xlsx';
  const bytes = isXlsx
    ? session.toXlsx({ sheetName: o.entity === 'ticket' ? 'Tickets' : kind === 'agents' ? 'Agents' : 'Customers', title: `Gorgias ${what} export`, now: o.now?.() })
    : utf8(session.toCsv());
  return { session, bytes, filename: `${base}.${isXlsx ? 'xlsx' : 'csv'}`, contentType: isXlsx ? XLSX_MIME : CSV_MIME, pages, stoppedBy };
}
