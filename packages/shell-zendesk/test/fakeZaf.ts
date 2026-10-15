import { createServices, signHs256, synthetic } from '@hps/core-api';
import type { ZafClient, ZafRequestOptions } from '../src/zaf.js';

type Json = Record<string, any>;

/**
 * Simulates the ZAF client + Zendesk REST + the Zendesk request proxy:
 *  - `secure: true` requests get `{{setting.shared_secret}}` substituted server-side and the JWT
 *    signed by the "proxy" (the iframe code never sees the secret);
 *  - non-2xx responses reject (ZAF behaviour) with {status, responseJSON}.
 */
export function fakeZendesk(opts: { role?: string; groups?: Json[]; location?: string; users?: Json[]; ticket?: Json } = {}) {
  const { app, deps } = createServices({ masterSecret: 'q'.repeat(64), config: { publicBaseUrl: 'https://api.test' }, logger: { error() {}, warn() {}, info() {} } });
  const settings: Record<string, string> = { api_base_url: 'https://api.test', shared_secret: '' };
  const users = opts.users ?? synthetic.zendeskUsers(1500);
  const invokes: string[] = [];
  const sets: [string, unknown][] = [];
  const handlers = new Map<string, ((...a: unknown[]) => unknown)[]>();
  const ticket: Json = opts.ticket ?? { 'ticket.tags': ['vip'], 'ticket.form': { id: 77, name: 'Default' }, 'ticket.brand': { id: 1, name: 'Acme' } };

  const zendeskApi = (url: string, type: string, data?: string): Json => {
    const u = new URL(url, 'https://acme.zendesk.com');
    if (u.pathname === '/api/v2/users.json') {
      const size = Number(u.searchParams.get('page[size]') ?? 100);
      const after = Number(u.searchParams.get('page[after]') ?? 0);
      const slice = users.slice(after, after + size);
      return { users: slice, meta: { has_more: after + size < users.length, after_cursor: String(after + size) } };
    }
    if (u.pathname === '/api/v2/user_fields.json') return { user_fields: synthetic.zendeskUserFieldsRaw(), next_page: null };
    if (u.pathname === '/api/v2/ticket_fields.json') return { ticket_fields: [...synthetic.zendeskTicketFieldsRaw(), { id: 3, title: 'Priority', type: 'priority', active: true }], next_page: null };
    if (u.pathname === '/api/v2/groups.json') return { groups: [{ id: 300, name: 'Tier 1 Support' }, { id: 301, name: 'Tier 2 Escalations' }], next_page: null };
    if (u.pathname === '/api/v2/custom_roles.json') throw { status: 403, responseJSON: { error: 'Forbidden' } };
    if (u.pathname === '/api/v2/ticket_forms.json') return { ticket_forms: [{ id: 77, name: 'Default' }] };
    if (u.pathname === '/api/v2/brands.json') return { brands: [{ id: 1, name: 'Acme' }] };
    if (u.pathname === '/api/v2/apps/installations/42.json' && type === 'PUT') {
      Object.assign(settings, JSON.parse(data!).settings);
      return { id: 42 };
    }
    throw { status: 404, responseJSON: { error: 'NotFound' } };
  };

  const client: ZafClient = {
    async get(paths) {
      const list = Array.isArray(paths) ? paths : [paths];
      const out: Json = {};
      for (const p of list) {
        if (p === 'currentUser') out.currentUser = { id: 7, name: 'Agent Seven', role: opts.role ?? 'admin', groups: opts.groups ?? [{ id: 300, name: 'Tier 1 Support' }] };
        else if (p in ticket) out[p] = ticket[p];
      }
      return out;
    },
    async set(path, value) {
      sets.push([path, value]);
      ticket[path] = value;
      return {};
    },
    async invoke(name) {
      invokes.push(name);
      return {};
    },
    on(e, h) {
      handlers.set(e, [...(handlers.get(e) ?? []), h]);
    },
    off(e, h) {
      handlers.set(e, (handlers.get(e) ?? []).filter((x) => x !== h));
    },
    async metadata() {
      // Secure settings are never exposed to the iframe.
      return { appId: 1, installationId: 42, settings: { api_base_url: settings.api_base_url } };
    },
    async context() {
      return { location: opts.location ?? 'nav_bar', account: { subdomain: 'acme' } };
    },
    async request<T>(o: ZafRequestOptions | string): Promise<T> {
      const req = typeof o === 'string' ? { url: o } : o;
      if (req.url.startsWith('https://api.test')) {
        const headers: Record<string, string> = { ...(req.headers ?? {}), 'content-type': req.contentType ?? 'application/json' };
        if (req.jwt) {
          if (!req.secure) throw new Error('jwt requires secure: true');
          // An unset secure setting leaves the placeholder unsubstituted (the API then rejects the token).
          const secret = settings.shared_secret ? req.jwt.secret_key.replace('{{setting.shared_secret}}', settings.shared_secret) : req.jwt.secret_key;
          const now = Math.floor(Date.now() / 1000);
          headers.authorization = `Bearer ${await signHs256({ ...req.jwt.claims, iat: now, exp: now + (req.jwt.expiry ?? 300) }, secret)}`;
        }
        const res = await app.request(req.url.replace('https://api.test', ''), { method: req.type ?? 'GET', headers, body: req.data });
        const text = await res.text();
        const shaped = { status: res.status, responseJSON: text ? JSON.parse(text) : undefined, responseText: text, headers: Object.fromEntries(res.headers) };
        if (res.status >= 400) throw shaped;
        return (req.httpCompleteResponse ? shaped : shaped.responseJSON) as T;
      }
      return zendeskApi(req.url, req.type ?? 'GET', req.data) as T;
    },
  };
  const fire = async (event: string) => Promise.all((handlers.get(event) ?? []).map((h) => h()));
  return { client, app, deps, settings, invokes, sets, handlers, ticket, fire, users };
}
