import type { CustomFieldDef, EntityType, NormalizedRecord, Platform, Primitive } from '../types.js';
import { randomId } from '../util/crypto.js';
import { customColumnKey, resolveColumns, type ColumnSpec } from './columns.js';
import { csvChunks, type CsvOptions } from './csv.js';
import { compileFilters, type CompiledFilter, type ExportFilters } from './filters.js';
import { flattenRecord, type FlatRow } from './flatten.js';
import { normalizeRecord, NormalizationError } from './normalize/index.js';
import { buildWorkbook, type SheetInput } from './xlsx.js';

/**
 * Module A — Streaming Cursor Export Engine.
 *
 * Accepts cursor-paginated batches (any size, any number) of tickets / users / organizations and
 * produces a deduplicated, filtered, human-labelled table. Fixes, by construction:
 *  - the 1,000-row offset search wall: there is no offset — batches are appended by cursor;
 *  - duplicate rows on tab switching / page re-fetches: replayed cursors are ignored AND every row
 *    is keyed by record ID (re-sent IDs update in place, never duplicate);
 *  - missing custom fields: values are flattened by human-readable field title;
 *  - no suspended/role/tag filtering: see ExportFilters.
 */

export interface ExportSessionOptions {
  entity: EntityType;
  source: Platform;
  fieldSchema?: CustomFieldDef[];
  filters?: ExportFilters;
  /** Column preset: keys, standard labels, custom field titles or keys. Default: all standard + custom. */
  columns?: string[];
  /** When no column preset is given, include custom fields discovered in data even if absent from the schema. Default true. */
  includeUnknownCustomFields?: boolean;
  /** Entitlement-imposed max number of output rows (unique records). Undefined = unlimited. */
  rowLimit?: number;
  /** On duplicate IDs: keep the most recently updated version (default) or the first one seen. */
  dedupe?: 'keep_latest' | 'keep_first';
  id?: string;
}

export interface ExportBatch {
  /** Cursor used to fetch this page (null/undefined for the first page). */
  cursor?: string | null;
  /** Cursor for the next page as reported by the platform. */
  nextCursor?: string | null;
  /** True when the platform reports no further pages. */
  done?: boolean;
  records: unknown[];
  /** "raw" platform objects (default) or pre-normalized records. */
  format?: 'raw' | 'normalized';
}

export interface BatchResult {
  batchIndex: number;
  replayed: boolean;
  received: number;
  accepted: number;
  updated: number;
  duplicates: number;
  filteredOut: number;
  rejected: number;
  truncated: number;
  errors: { index: number; message: string }[];
  totalRows: number;
  nextCursor: string | null;
  done: boolean;
  limitReached: boolean;
}

export interface ExportStats {
  id: string;
  entity: EntityType;
  source: Platform;
  batches: number;
  replayedBatches: number;
  received: number;
  rows: number;
  duplicatesDropped: number;
  filteredOut: number;
  rejected: number;
  truncated: number;
  rowLimit: number | null;
  limitReached: boolean;
  done: boolean;
  nextCursor: string | null;
}

interface StoredRow {
  row: FlatRow;
  updatedAt: number;
}

const FIRST_PAGE = '\u0000first';

export class ExportSession {
  readonly id: string;
  readonly entity: EntityType;
  readonly source: Platform;
  private readonly schema: CustomFieldDef[];
  private readonly schemaByKey: Map<string, CustomFieldDef>;
  private readonly filter: CompiledFilter;
  private readonly rowsById = new Map<string, StoredRow>();
  /** IDs rejected by the filter (with their version time) so re-sent copies count as duplicates. */
  private readonly filteredIds = new Map<string, number>();
  private readonly seenCursors = new Set<string>();
  private readonly discoveredCustomKeys = new Set<string>();
  private readonly fixedColumns?: ColumnSpec[];
  private readonly opts: ExportSessionOptions;
  private s = { batches: 0, replayed: 0, received: 0, duplicates: 0, filteredOut: 0, rejected: 0, truncated: 0 };
  private lastNextCursor: string | null = null;
  private finished = false;

  constructor(opts: ExportSessionOptions) {
    this.opts = opts;
    this.id = opts.id ?? randomId();
    this.entity = opts.entity;
    this.source = opts.source;
    this.schema = opts.fieldSchema ?? [];
    this.schemaByKey = new Map(this.schema.map((d) => [d.key, d]));
    if (opts.rowLimit !== undefined && (!Number.isInteger(opts.rowLimit) || opts.rowLimit < 0)) {
      throw new RangeError('rowLimit must be a non-negative integer');
    }

    if (opts.columns?.length) {
      const { columns, unknown } = resolveColumns(this.entity, this.schema, opts.columns);
      if (unknown.length) throw new RangeError(`Unknown export column(s): ${unknown.join(', ')}`);
      this.fixedColumns = columns;
    }

    const { columns: all } = resolveColumns(this.entity, this.schema);
    const byLabel = new Map(all.map((c) => [c.label.toLowerCase(), c.key]));
    for (const d of this.schema) byLabel.set(d.title.toLowerCase(), customColumnKey(d.key));
    const keys = new Set(all.map((c) => c.key));
    this.filter = compileFilters(opts.filters, (ref) => {
      if (keys.has(ref)) return ref;
      if (keys.has(customColumnKey(ref))) return customColumnKey(ref);
      return byLabel.get(ref.trim().toLowerCase()) ?? (ref.startsWith('cf:') ? ref : undefined);
    });
  }

  /** Ingests one page. Re-sending an already-processed cursor is a no-op (idempotent retries / tab switches). */
  ingest(batch: ExportBatch): BatchResult {
    const cursorKey = batch.cursor ?? FIRST_PAGE;
    const result: BatchResult = {
      batchIndex: this.s.batches,
      replayed: false,
      received: batch.records.length,
      accepted: 0,
      updated: 0,
      duplicates: 0,
      filteredOut: 0,
      rejected: 0,
      truncated: 0,
      errors: [],
      totalRows: this.rowsById.size,
      nextCursor: this.lastNextCursor,
      done: this.finished,
      limitReached: this.limitReached,
    };
    if (this.seenCursors.has(cursorKey)) {
      this.s.replayed++;
      result.replayed = true;
      result.received = 0;
      return result;
    }
    this.seenCursors.add(cursorKey);
    this.s.batches++;
    this.s.received += batch.records.length;

    const limit = this.opts.rowLimit;
    const keepLatest = (this.opts.dedupe ?? 'keep_latest') === 'keep_latest';

    batch.records.forEach((raw, index) => {
      let rec: NormalizedRecord;
      try {
        rec =
          batch.format === 'normalized'
            ? normalizeRecord('generic', this.entity, raw)
            : normalizeRecord(this.source, this.entity, raw);
      } catch (e) {
        result.rejected++;
        if (result.errors.length < 20) result.errors.push({ index, message: e instanceof NormalizationError || e instanceof Error ? e.message : String(e) });
        return;
      }
      const row = flattenRecord(rec, this.schemaByKey);
      const existing = this.rowsById.get(rec.id);
      const updatedAt = rec.updatedAt ? Date.parse(rec.updatedAt) : 0;
      const passes = this.filter(rec, row);

      if (existing) {
        result.duplicates++;
        if (!keepLatest || updatedAt < existing.updatedAt) return;
        if (!passes) {
          // Newer state no longer matches (e.g. user got suspended between pages): drop it.
          this.rowsById.delete(rec.id);
          this.filteredIds.set(rec.id, updatedAt);
          result.filteredOut++;
          return;
        }
        existing.row = row;
        existing.updatedAt = updatedAt;
        this.noteCustomKeys(rec);
        result.updated++;
        return;
      }
      const filteredAt = this.filteredIds.get(rec.id);
      if (filteredAt !== undefined) {
        // Already seen and filtered out: a re-sent copy is a duplicate unless a newer version now matches.
        result.duplicates++;
        if (!passes || !keepLatest || updatedAt < filteredAt) return;
        this.filteredIds.delete(rec.id);
      } else if (!passes) {
        this.filteredIds.set(rec.id, updatedAt);
        result.filteredOut++;
        return;
      }
      if (limit !== undefined && this.rowsById.size >= limit) {
        result.truncated++;
        return;
      }
      this.rowsById.set(rec.id, { row, updatedAt });
      this.noteCustomKeys(rec);
      result.accepted++;
    });

    this.s.duplicates += result.duplicates;
    this.s.filteredOut += result.filteredOut;
    this.s.rejected += result.rejected;
    this.s.truncated += result.truncated;
    this.lastNextCursor = batch.nextCursor ?? null;
    if (batch.done === true || (batch.nextCursor === null && batch.done !== false)) this.finished = true;

    result.totalRows = this.rowsById.size;
    result.nextCursor = this.lastNextCursor;
    result.done = this.finished;
    result.limitReached = this.limitReached;
    return result;
  }

  get limitReached(): boolean {
    return this.opts.rowLimit !== undefined && (this.rowsById.size >= this.opts.rowLimit || this.s.truncated > 0);
  }

  get size(): number {
    return this.rowsById.size;
  }

  get stats(): ExportStats {
    return {
      id: this.id,
      entity: this.entity,
      source: this.source,
      batches: this.s.batches,
      replayedBatches: this.s.replayed,
      received: this.s.received,
      rows: this.rowsById.size,
      duplicatesDropped: this.s.duplicates,
      filteredOut: this.s.filteredOut,
      rejected: this.s.rejected,
      truncated: this.s.truncated,
      rowLimit: this.opts.rowLimit ?? null,
      limitReached: this.limitReached,
      done: this.finished,
      nextCursor: this.lastNextCursor,
    };
  }

  private noteCustomKeys(rec: NormalizedRecord) {
    for (const k of Object.keys(rec.customFields)) this.discoveredCustomKeys.add(k);
  }

  /** Final column list (standard + schema custom fields + discovered unknown custom keys). */
  get columns(): ColumnSpec[] {
    if (this.fixedColumns) return this.fixedColumns;
    const { columns } = resolveColumns(this.entity, this.schema);
    if (this.opts.includeUnknownCustomFields !== false) {
      for (const k of this.discoveredCustomKeys) {
        if (!this.schemaByKey.has(k)) columns.push({ key: customColumnKey(k), label: k, kind: 'string', origin: 'custom' });
      }
    }
    return columns;
  }

  *rows(columns: ColumnSpec[] = this.columns): Generator<Primitive[]> {
    for (const { row } of this.rowsById.values()) yield columns.map((c) => row[c.key] ?? null);
  }

  csvChunks(options?: CsvOptions): Generator<string> {
    const cols = this.columns;
    return csvChunks(cols, this.rows(cols), options);
  }

  toCsv(options?: CsvOptions): string {
    return Array.from(this.csvChunks(options)).join('');
  }

  toSheet(name?: string): SheetInput {
    const cols = this.columns;
    return { name: name ?? defaultSheetName(this.entity), columns: cols, rows: this.rows(cols) };
  }

  toXlsx(opts: { sheetName?: string; title?: string; now?: Date } = {}): Uint8Array {
    return buildWorkbook([this.toSheet(opts.sheetName)], { title: opts.title, now: opts.now });
  }
}

export const defaultSheetName = (e: EntityType) => (e === 'ticket' ? 'Tickets' : e === 'user' ? 'Users' : 'Organizations');

/** Builds a multi-tab workbook (one tab per session) plus an "Export Summary" tab. */
export function buildMultiSheetWorkbook(sessions: { session: ExportSession; sheetName?: string }[], opts: { title?: string; now?: Date } = {}): Uint8Array {
  const sheets = sessions.map(({ session, sheetName }) => session.toSheet(sheetName));
  const summaryCols: ColumnSpec[] = [
    { key: 'sheet', label: 'Sheet', kind: 'string', origin: 'standard' },
    { key: 'source', label: 'Source', kind: 'string', origin: 'standard' },
    { key: 'rows', label: 'Rows', kind: 'number', origin: 'standard' },
    { key: 'dups', label: 'Duplicates Removed', kind: 'number', origin: 'standard' },
    { key: 'filtered', label: 'Filtered Out', kind: 'number', origin: 'standard' },
    { key: 'truncated', label: 'Truncated By Plan', kind: 'number', origin: 'standard' },
  ];
  const summaryRows: Primitive[][] = sessions.map(({ session }, i) => {
    const st = session.stats;
    return [sheets[i]!.name, st.source, st.rows, st.duplicatesDropped, st.filteredOut, st.truncated];
  });
  sheets.push({ name: 'Export Summary', columns: summaryCols, rows: summaryRows });
  return buildWorkbook(sheets, opts);
}

/** Convenience one-shot: run a full set of pages through a session. */
export function exportAll(opts: ExportSessionOptions, pages: ExportBatch[]): ExportSession {
  const s = new ExportSession(opts);
  for (const p of pages) s.ingest(p);
  return s;
}
