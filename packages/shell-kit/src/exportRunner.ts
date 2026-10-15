import type { HpsApiClient } from './api.js';
import type { ExportOutcome, ExportProgress, ExportRequest, HostAdapter } from './types.js';

export interface RunOptions {
  onProgress?: (p: ExportProgress) => void;
  signal?: AbortSignal;
  /** Safety valve against platforms that keep returning the same cursor. */
  maxPages?: number;
}

/**
 * Pulls cursor pages from the helpdesk (through the host adapter) and streams them to an HPS export
 * session. The next page is prefetched while the current one uploads. Stops on the last page, on the
 * plan row limit, or when aborted. Cursor loops are detected and broken.
 */
export async function runCursorExport(host: HostAdapter, api: HpsApiClient, req: ExportRequest, o: RunOptions = {}): Promise<ExportOutcome | null> {
  if (host.runExport) return host.runExport(api, req, o);
  const fieldSchema = await host.fieldSchema(req.entity);
  const session = await api.createExportSession({ entity: req.entity, source: host.platform, fieldSchema, filters: req.filters, columns: req.columns });
  const p: ExportProgress = { pages: 0, received: 0, rows: 0, duplicates: 0, filteredOut: 0, limitReached: false, phase: 'fetching' };
  const emit = () => o.onProgress?.({ ...p });
  emit();

  const seen = new Set<string>();
  let cursor: string | null = null;
  let pending = host.fetchPage(req.entity, cursor, req.query);
  const maxPages = o.maxPages ?? 10_000;

  while (true) {
    if (o.signal?.aborted) {
      pending.catch(() => undefined);
      p.phase = 'cancelled';
      emit();
      return null;
    }
    const page = await pending;
    let next = page.nextCursor;
    if (next !== null && (seen.has(next) || next === cursor)) next = null; // cursor loop guard
    if (next !== null) seen.add(next);
    // Prefetch the following page while this one uploads.
    if (next !== null && p.pages + 1 < maxPages) pending = host.fetchPage(req.entity, next, req.query);
    const r = await api.sendBatch(session.id, { cursor, nextCursor: next, records: page.records });
    p.pages++;
    p.received += r.received;
    p.rows = r.totalRows;
    p.duplicates += r.duplicates;
    p.filteredOut += r.filteredOut;
    p.limitReached = r.limitReached;
    emit();
    if (next === null || r.limitReached || p.pages >= maxPages) break;
    cursor = next;
  }

  pending.catch(() => undefined); // a prefetch made redundant by the row limit must not surface as unhandled
  p.phase = 'finalizing';
  emit();
  const out = await api.finalize(session.id, { format: req.format, filename: req.filename });
  p.phase = 'done';
  emit();
  return out;
}
