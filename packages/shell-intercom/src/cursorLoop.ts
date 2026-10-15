import type { BatchResult, ExportSession } from '@hps/core-api/export';

/**
 * Drives a core ExportSession through a cursor-paginated API, server side.
 *
 * Termination is guaranteed by four independent guards, so a misbehaving API can never spin forever:
 *  - `nextCursor === null`                      → done (normal end);
 *  - a next cursor that was already requested    → 'cursor_loop';
 *  - N consecutive pages with no unseen IDs      → 'cursor_loop' (stagnant pages, e.g. a cursor that
 *                                                   keeps changing but replays the same records);
 *  - `maxPages`                                  → 'max_pages'.
 * It also stops as soon as the plan row limit is reached ('limit').
 */

export type StopReason = 'done' | 'limit' | 'cursor_loop' | 'max_pages';

export interface PageResult {
  records: unknown[];
  nextCursor: string | null;
}

export interface ExportProgress {
  page: number;
  received: number;
  rows: number;
  duplicatesDropped: number;
  filteredOut: number;
  nextCursor: string | null;
  batch: BatchResult;
}

export interface CursorLoopOptions {
  maxPages?: number;
  /** Consecutive pages contributing zero unseen record IDs before giving up. Default 3. */
  maxStagnantPages?: number;
  /**
   * Scroll-style APIs (Intercom `/companies/scroll`) legitimately return the SAME cursor for every page
   * and signal the end with an empty page. In this mode a repeated cursor is not a loop, and the
   * session receives a per-page cursor key (`<cursor>#<page>`) so core's replay protection stays correct.
   */
  repeatingCursor?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: ExportProgress) => void;
}

export interface CursorLoopResult {
  pages: number;
  stoppedBy: StopReason;
}

export const DEFAULT_MAX_PAGES = 20_000;

const recordId = (r: unknown): string | undefined => {
  if (!r || typeof r !== 'object') return undefined;
  const id = (r as Record<string, unknown>).id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
};

export async function runCursorLoop(
  session: ExportSession,
  fetchPage: (cursor: string | null, signal?: AbortSignal) => Promise<PageResult>,
  o: CursorLoopOptions = {},
): Promise<CursorLoopResult> {
  const maxPages = o.maxPages ?? DEFAULT_MAX_PAGES;
  const maxStagnant = o.maxStagnantPages ?? 3;
  const requested = new Set<string>();
  const seenIds = new Set<string>();
  let cursor: string | null = null;
  let stagnant = 0;

  for (let page = 1; ; page++) {
    o.signal?.throwIfAborted();
    const res = await fetchPage(cursor, o.signal);
    let fresh = 0;
    for (const r of res.records) {
      const id = recordId(r);
      if (id !== undefined && !seenIds.has(id)) {
        seenIds.add(id);
        fresh++;
      }
    }
    const loops = !o.repeatingCursor && res.nextCursor !== null && (res.nextCursor === cursor || requested.has(res.nextCursor));
    const key = (c: string | null, p: number) => (o.repeatingCursor && c !== null ? `${c}#${p}` : c);
    const batch = session.ingest({ cursor: key(cursor, page), nextCursor: key(res.nextCursor, page + 1), records: res.records, done: res.nextCursor === null || loops });
    const st = session.stats;
    o.onProgress?.({ page, received: st.received, rows: st.rows, duplicatesDropped: st.duplicatesDropped, filteredOut: st.filteredOut, nextCursor: res.nextCursor, batch });

    if (res.nextCursor === null) return { pages: page, stoppedBy: 'done' };
    if (loops) return { pages: page, stoppedBy: 'cursor_loop' };
    if (session.limitReached) return { pages: page, stoppedBy: 'limit' };
    stagnant = fresh === 0 ? stagnant + 1 : 0;
    if (stagnant >= maxStagnant) return { pages: page, stoppedBy: 'cursor_loop' };
    if (page >= maxPages) return { pages: page, stoppedBy: 'max_pages' };
    if (cursor !== null) requested.add(cursor);
    cursor = res.nextCursor;
  }
}
