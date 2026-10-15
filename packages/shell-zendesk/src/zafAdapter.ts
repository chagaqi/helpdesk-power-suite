import type { Catalog, EntityType, EvalTicket, Primitive } from '@hps/core-api/rules';
import { browserStorage, type ApiResponse, type FieldOps, type HostAdapter, type HostUser, type KeyValueStorage, type PageResult, type SearchQuery } from '@hps/shell-kit';
import type { ZafClient, ZafCompleteResponse } from './zaf.js';
import { buildCatalog, canonicalRole, FIELD_ENDPOINT, pageUrl, parsePage, ticketChangeEvent, ticketValuePath, toExportSchema } from './zendeskApi.js';

export const DEFAULT_API_BASE = 'https://api.helpdeskpowersuite.com';
const AUDIENCE = 'helpdesk-power-suite';

type Json = Record<string, any>;
type InstallResult = { sharedSecret: string; installationId: string; tenant: string };

/** Catalog ids are numeric for custom fields ("360001") and the ZAF key for system fields ("priority"). */
export const keyForId = (id: string) => (/^\d+$/.test(id) ? `custom_field_${id}` : id);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

/** Normalizes ZAF request rejections (which carry {status, responseJSON}) into a response object. */
function asResponse<T>(r: ZafCompleteResponse): ApiResponse<T> {
  let data = r.responseJSON as T;
  if (data === undefined && r.responseText) {
    try {
      data = JSON.parse(r.responseText) as T;
    } catch {
      data = r.responseText as T;
    }
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = String(v);
  return { status: r.status, data, headers };
}

/** HostAdapter for Zendesk Support, built on the ZAF v2 client. */
export class ZendeskHost implements HostAdapter {
  readonly platform = 'zendesk' as const;
  readonly storage: KeyValueStorage;
  private meta?: Awaited<ReturnType<ZafClient['metadata']>>;
  private ctx?: Awaited<ReturnType<ZafClient['context']>>;
  private userCache?: HostUser;

  constructor(
    readonly client: ZafClient,
    storage?: KeyValueStorage,
    private readonly win: Pick<Window, 'open'> | undefined = globalThis.window,
  ) {
    this.storage = storage ?? browserStorage('hps-zd:');
  }

  private async metadata() {
    return (this.meta ??= await this.client.metadata());
  }
  private async context() {
    return (this.ctx ??= await this.client.context());
  }
  async apiBase() {
    return ((await this.metadata()).settings.api_base_url || DEFAULT_API_BASE).replace(/\/$/, '');
  }
  async tenant() {
    return (await this.context()).account.subdomain;
  }
  async installationId() {
    return String((await this.metadata()).installationId);
  }
  async location() {
    return (await this.context()).location;
  }

  /** Same-origin Zendesk REST call with 429 back-off. */
  async zd<T = Json>(url: string, init: { type?: string; data?: unknown } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.request<T>({ url, type: init.type ?? 'GET', contentType: 'application/json', ...(init.data !== undefined ? { data: JSON.stringify(init.data) } : {}) });
      } catch (e) {
        const err = e as ZafCompleteResponse & { getResponseHeader?: (h: string) => string | null };
        if (err?.status === 429 && attempt < 4) {
          const ra = Number(err.getResponseHeader?.('Retry-After') ?? err.headers?.['retry-after'] ?? 2);
          await sleep(Math.min(60, Math.max(1, ra)) * 1000);
          continue;
        }
        throw new Error(`Zendesk API ${url.split('?')[0]} failed (${err?.status ?? 'network'})`);
      }
    }
  }

  /** Follows cursor (links.next) or offset (next_page) pagination for small catalog lists. */
  private async listAll(url: string, key: string, max = 50): Promise<Json[]> {
    const out: Json[] = [];
    let next: string | null = url;
    for (let i = 0; next && i < max; i++) {
      const body: Json = await this.zd<Json>(next);
      out.push(...((body[key] as Json[]) ?? []));
      next = body.meta?.has_more ? (body.links?.next ?? null) : (body.next_page ?? null);
      if (next) next = next.replace(/^https:\/\/[^/]+/, '');
    }
    return out;
  }

  async currentUser(): Promise<HostUser> {
    if (this.userCache) return this.userCache;
    const { currentUser } = (await this.client.get('currentUser')) as { currentUser: Json };
    let customRoleName: string | undefined;
    const r = String(currentUser.role ?? '');
    if (r && !['admin', 'agent', 'end-user'].includes(r)) {
      // Custom roles are exposed as an id: resolve the human-readable name (Enterprise only).
      try {
        const roles = await this.listAll('/api/v2/custom_roles.json', 'custom_roles', 2);
        customRoleName = roles.find((x) => String(x.id) === r)?.name;
      } catch {
        /* not available on this plan */
      }
    }
    const role = canonicalRole(currentUser.role, customRoleName);
    this.userCache = {
      id: String(currentUser.id),
      name: currentUser.name,
      ...role,
      groups: ((currentUser.groups as Json[]) ?? []).map((g) => ({ id: String(g.id), name: String(g.name) })),
    };
    return this.userCache;
  }

  /** HPS API call through the Zendesk proxy: `secure: true` keeps the shared secret server-side, the proxy signs the JWT. */
  async api<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>> {
    const [base, tenant, iid, user] = await Promise.all([this.apiBase(), this.tenant(), this.installationId(), this.currentUser()]);
    try {
      const res = await this.client.request<ZafCompleteResponse>({
        url: `${base}${path}`,
        type: method,
        contentType: 'application/json',
        ...(body !== undefined ? { data: JSON.stringify(body) } : {}),
        headers,
        secure: true,
        cors: false,
        httpCompleteResponse: true,
        jwt: {
          algorithm: 'HS256',
          secret_key: '{{setting.shared_secret}}',
          expiry: 300,
          claims: { iss: 'hps-shell-zendesk', aud: AUDIENCE, sub: `zendesk:${tenant}`, iid, jti: rid(), usr: { id: user.id, role: user.role, customRole: user.customRole, groups: user.groups } },
        },
      });
      return asResponse<T>(res);
    } catch (e) {
      const err = e as ZafCompleteResponse;
      if (typeof err?.status === 'number') return asResponse<T>(err);
      throw e;
    }
  }

  async installRequest(body: unknown): Promise<ApiResponse<InstallResult>> {
    const base = await this.apiBase();
    try {
      return asResponse<InstallResult>(
        await this.client.request<ZafCompleteResponse>({ url: `${base}/v1/install`, type: 'POST', contentType: 'application/json', data: JSON.stringify(body), cors: false, httpCompleteResponse: true }),
      );
    } catch (e) {
      return asResponse<InstallResult>((e as ZafCompleteResponse) ?? { status: 0 });
    }
  }

  /** Stores the one-time secret in the installation's *secure* setting (admins only). */
  async saveSecret(secret: string, installationId: string) {
    await this.zd(`/api/v2/apps/installations/${encodeURIComponent(installationId)}.json`, { type: 'PUT', data: { settings: { shared_secret: secret } } });
  }

  async fetchPage(entity: EntityType, cursor: string | null, query: SearchQuery): Promise<PageResult> {
    return parsePage(entity, query, await this.zd(pageUrl(entity, cursor, query)));
  }

  async fieldSchema(entity: EntityType) {
    const ep = FIELD_ENDPOINT[entity];
    return toExportSchema(entity, await this.listAll(ep.url, ep.key));
  }

  async ruleCatalog(): Promise<Catalog> {
    const optional = (p: Promise<Json[]>) => p.catch(() => [] as Json[]);
    const [fields, groups, roles, forms, brands] = await Promise.all([
      this.listAll('/api/v2/ticket_fields.json', 'ticket_fields'),
      this.listAll('/api/v2/groups.json', 'groups'),
      optional(this.listAll('/api/v2/custom_roles.json', 'custom_roles', 2)),
      optional(this.listAll('/api/v2/ticket_forms.json', 'ticket_forms', 5)),
      optional(this.listAll('/api/v2/brands.json', 'brands', 5)),
    ]);
    return buildCatalog(fields, groups, roles, forms, brands);
  }

  openUrl(url: string) {
    this.win?.open(url, '_blank', 'noopener');
  }

  notify(message: string, kind: 'notice' | 'alert' | 'error' = 'notice') {
    void this.client.invoke('notify', message, kind);
  }

  // ------------------------------------------------------------------ ticket sidebar helpers
  fieldOps(): FieldOps {
    const inv = (key: string, action: string) => this.client.invoke(`ticketFields:${key}.${action}`).then(() => undefined, () => undefined);
    return {
      hide: (k) => inv(k, 'hide'),
      show: (k) => inv(k, 'show'),
      disable: (k) => inv(k, 'disable'),
      enable: (k) => inv(k, 'enable'),
      setValue: (k, v: Primitive | Primitive[]) => this.client.set(ticketValuePath(k), v).then(() => undefined, () => undefined),
    };
  }

  /** Reads tags, form, brand and the values (keyed by field id) of fields referenced by rule conditions. */
  async readTicket(fieldIds: string[]): Promise<EvalTicket> {
    const paths = ['ticket.tags', 'ticket.form', 'ticket.brand', ...fieldIds.map((id) => ticketValuePath(keyForId(id)))];
    let data: Json = {};
    try {
      data = await this.client.get(paths);
    } catch {
      /* new tickets may not expose every path */
    }
    const ref = (x: Json | undefined) => (x && (x.id !== undefined || x.name) ? { id: x.id !== undefined ? String(x.id) : undefined, name: String(x.name ?? x.id) } : null);
    const fields: Record<string, Primitive | Primitive[]> = {};
    fieldIds.forEach((id) => {
      const v = data[ticketValuePath(keyForId(id))];
      if (v !== undefined) fields[id] = v as Primitive;
    });
    return {
      tags: (data['ticket.tags'] as string[]) ?? [],
      form: ref(data['ticket.form'] as Json),
      brand: ref(data['ticket.brand'] as Json),
      fields,
      isNew: (await this.location()) === 'new_ticket_sidebar',
    };
  }

  watch(fieldIds: string[], onChange: () => void): () => void {
    const events = ['ticket.tags.changed', 'ticket.form.id.changed', 'ticket.brand.changed', ...fieldIds.map((id) => ticketChangeEvent(keyForId(id)))];
    for (const e of events) this.client.on(e, onChange);
    return () => events.forEach((e) => this.client.off(e, onChange));
  }
}
