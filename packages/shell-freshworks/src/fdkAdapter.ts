import type { Catalog, EntityType, EvalTicket, NamedRef, Primitive } from '@hps/core-api/rules';
import {
  browserStorage,
  HpsApiError,
  type ApiResponse,
  type ExportOutcome,
  type ExportProgress,
  type ExportRequest,
  type FieldOps,
  type HostAdapter,
  type HostUser,
  type HpsApiClient,
  type KeyValueStorage,
  type PageResult,
} from '@hps/shell-kit';
import type { FdkClient } from './fdk.js';
import { buildCatalog, canonicalRole, FIELD_PATHS, listRecords, ticketValues, toExportSchema, type Product } from './freshdeskApi.js';

type Json = Record<string, any>;

/** HostAdapter for Freshdesk / Freshservice on FDK v9 (platform 3.0). */
export class FreshworksHost implements HostAdapter {
  readonly platform: 'freshdesk' | 'freshservice';
  readonly storage: KeyValueStorage;
  readonly localTextSearch = true; // Freshdesk search caps at 300 results; filter locally instead.
  private userCache?: HostUser;
  private rolesCache?: NamedRef[];

  constructor(
    readonly client: FdkClient,
    product: Product = 'freshdesk',
    storage?: KeyValueStorage,
    private readonly win: Pick<Window, 'open'> | undefined = globalThis.window,
  ) {
    this.platform = product;
    this.storage = storage ?? browserStorage('hps-fw:');
  }

  static async detect(client: FdkClient, storage?: KeyValueStorage) {
    const { domainName } = await client.data.get('domainName');
    return new FreshworksHost(client, /freshservice\.com$/i.test(String(domainName)) ? 'freshservice' : 'freshdesk', storage);
  }

  supportsEntity(_e: EntityType) {
    return true;
  }

  async tenant() {
    return String((await this.client.data.get('domainName')).domainName);
  }

  /** Read-only Freshdesk metadata (fields, groups, roles) via the fdMeta request template. */
  async meta(path: string): Promise<Json[]> {
    const r = await this.client.request.invokeTemplate('fdMeta', { context: { path } });
    return listRecords(JSON.parse(r.response || '[]'));
  }

  private async roles(): Promise<NamedRef[]> {
    if (!this.rolesCache) {
      this.rolesCache = (await this.meta('/api/v2/roles').catch(() => [])).map((r) => ({ id: String(r.id), name: String(r.name) }));
    }
    return this.rolesCache;
  }

  async currentUser(): Promise<HostUser> {
    if (this.userCache) return this.userCache;
    const { loggedInUser: u } = await this.client.data.get('loggedInUser');
    const [roles, groups] = await Promise.all([this.roles(), this.meta('/api/v2/groups').catch(() => [] as Json[])]);
    const groupIds = ((u.group_ids ?? []) as unknown[]).map(String);
    this.userCache = {
      id: String(u.id),
      name: u.contact?.name ?? u.name,
      ...canonicalRole(u, roles),
      groups: groupIds.map((id) => ({ id, name: String(groups.find((g) => String(g.id) === id)?.name ?? id) })),
    };
    return this.userCache;
  }

  /** HPS API via the `hpsCall` serverless function (which holds the secret and signs the JWT). */
  async api<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>> {
    const user = await this.currentUser();
    const { response } = await this.client.request.invoke('hpsCall', { method, path, body, etag: headers?.['If-None-Match'] ?? '', user });
    return { status: response.status, data: response.data as T, headers: response.headers ?? {} };
  }

  async fetchPage(entity: EntityType, cursor: string | null): Promise<PageResult> {
    const { response } = await this.client.request.invoke('fdPage', { entity, cursor });
    return response as PageResult;
  }

  /** Server-side export: each step is fetched AND uploaded by the serverless function. */
  async runExport(api: HpsApiClient, req: ExportRequest, o: { onProgress?: (p: ExportProgress) => void; signal?: AbortSignal } = {}): Promise<ExportOutcome | null> {
    const fieldSchema = await this.fieldSchema(req.entity);
    const filters = req.query.text ? { ...req.filters, text: req.query.text } : req.filters;
    const session = await api.createExportSession({ entity: req.entity, source: this.platform, fieldSchema, filters, columns: req.columns });
    const user = await this.currentUser();
    const p: ExportProgress = { pages: 0, received: 0, rows: 0, duplicates: 0, filteredOut: 0, limitReached: false, phase: 'fetching' };
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (;;) {
      if (o.signal?.aborted) {
        o.onProgress?.({ ...p, phase: 'cancelled' });
        return null;
      }
      const { response } = await this.client.request.invoke('exportStep', { sessionId: session.id, entity: req.entity, cursor, user });
      if (response.status >= 400) throw new HpsApiError(response.status, response.data?.error?.code ?? 'http_error', response.data?.error?.message ?? 'Export step failed');
      const r = response.data as { totalRows: number; duplicates: number; filteredOut: number; limitReached: boolean; received: number };
      p.pages++;
      p.received += r.received;
      p.rows = r.totalRows;
      p.duplicates += r.duplicates;
      p.filteredOut += r.filteredOut;
      p.limitReached = r.limitReached;
      o.onProgress?.({ ...p });
      const next: string | null = response.nextCursor;
      if (!next || r.limitReached || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
    o.onProgress?.({ ...p, phase: 'finalizing' });
    const out = await api.finalize(session.id, { format: req.format, filename: req.filename });
    o.onProgress?.({ ...p, phase: 'done' });
    return out;
  }

  async fieldSchema(entity: EntityType) {
    return toExportSchema(await this.meta(FIELD_PATHS[entity]));
  }

  async ruleCatalog(): Promise<Catalog> {
    const [fields, groups, roles, products] = await Promise.all([
      this.meta('/api/v2/ticket_fields'),
      this.meta('/api/v2/groups'),
      this.meta('/api/v2/roles').catch(() => []),
      this.meta('/api/v2/products').catch(() => []),
    ]);
    return buildCatalog(fields, groups, roles, products);
  }

  openUrl(url: string) {
    this.win?.open(url, '_blank', 'noopener');
  }

  notify(message: string, kind: 'notice' | 'alert' | 'error' = 'notice') {
    void this.client.interface.trigger('showNotify', { type: kind === 'notice' ? 'success' : kind === 'alert' ? 'warning' : 'danger', message }).catch(() => undefined);
  }

  // ------------------------------------------------------------------ ticket page helpers
  fieldOps(): FieldOps {
    const t = (action: string, opts: Json) => this.client.interface.trigger(action, opts).then(() => undefined, () => undefined);
    return {
      hide: (id) => t('hide', { id }),
      show: (id) => t('show', { id }),
      disable: (id) => t('disable', { id }),
      enable: (id) => t('enable', { id }),
      setValue: (id, value: Primitive | Primitive[]) => t('setValue', { id, value }),
    };
  }

  async readTicket(fieldIds: string[]): Promise<EvalTicket> {
    let ticket: Json | null = null;
    try {
      ticket = (await this.client.data.get('ticket')).ticket;
    } catch {
      ticket = null; // new-ticket page has no ticket object yet
    }
    if (!ticket) return { tags: [], fields: {}, isNew: true };
    const values = ticketValues(ticket);
    const fields: Record<string, Primitive> = {};
    for (const id of fieldIds) if (values[id] !== undefined) fields[id] = values[id] as Primitive;
    return { tags: (ticket.tags as string[]) ?? [], brand: ticket.product_id ? { id: String(ticket.product_id), name: String(ticket.product_id) } : null, fields, isNew: false };
  }

  watch(_fieldIds: string[], onChange: () => void): () => void {
    let active = true;
    const cb = () => active && onChange();
    for (const e of ['ticket.priorityChanged', 'ticket.statusChanged', 'ticket.groupChanged', 'ticket.typeChanged', 'ticket.agentChanged', 'ticket.propertiesLoaded']) {
      this.client.events.on(e, cb);
    }
    return () => (active = false);
  }
}
