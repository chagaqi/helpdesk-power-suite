import { HpsError } from '../util/errors.js';
import { ExportSession, type ExportSessionOptions } from './CursorExportEngine.js';

interface Entry {
  session: ExportSession;
  tenant: string;
  lastTouched: number;
}

/**
 * Holds in-flight cursor export sessions in memory. Sessions are tenant-scoped, idle-expire and are
 * capped per tenant and globally. (Single-instance gateway; use sticky routing when scaling out.)
 */
export class ExportSessionManager {
  private readonly sessions = new Map<string, Entry>();

  constructor(
    private readonly opts: { idleTtlMs?: number; maxPerTenant?: number; maxTotal?: number; now?: () => number } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private sweep() {
    const ttl = this.opts.idleTtlMs ?? 30 * 60_000;
    const t = this.now();
    for (const [id, e] of this.sessions) if (t - e.lastTouched > ttl) this.sessions.delete(id);
  }

  create(tenant: string, opts: ExportSessionOptions): ExportSession {
    this.sweep();
    const mine = [...this.sessions.values()].filter((e) => e.tenant === tenant);
    if (mine.length >= (this.opts.maxPerTenant ?? 5)) {
      // Evict this tenant's least recently used session rather than failing the new export.
      const oldest = mine.sort((a, b) => a.lastTouched - b.lastTouched)[0]!;
      this.sessions.delete(oldest.session.id);
    }
    if (this.sessions.size >= (this.opts.maxTotal ?? 500)) throw new HpsError('rate_limited', 'Export capacity reached, retry shortly');
    const session = new ExportSession(opts);
    this.sessions.set(session.id, { session, tenant, lastTouched: this.now() });
    return session;
  }

  get(tenant: string, id: string): ExportSession {
    this.sweep();
    const e = this.sessions.get(id);
    if (!e || e.tenant !== tenant) throw new HpsError('not_found', 'Export session not found or expired');
    e.lastTouched = this.now();
    return e.session;
  }

  delete(tenant: string, id: string) {
    const e = this.sessions.get(id);
    if (e && e.tenant === tenant) this.sessions.delete(id);
  }

  get size() {
    return this.sessions.size;
  }
}
