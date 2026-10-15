import { createHmac, randomBytes } from 'crypto';
import { listRecords, nextCursor, pageRequest, type Product } from '../freshdeskApi.js';
import type { EntityType } from '@hps/core-api/rules';

/**
 * FDK serverless logic (bundled into server/server.js). The shared secret lives only in the app's
 * server-side Key-Value store ($db) — never in a browser — and every HPS API call is signed here.
 * All platform globals are injected so the logic is unit-testable.
 */

export interface TemplateResponse {
  status: number;
  response: string;
  headers?: Record<string, string>;
}

export interface FdkServerEnv {
  $request: { invokeTemplate(name: string, opts: { context?: Record<string, unknown>; body?: string }): Promise<TemplateResponse> };
  $db: { get(key: string): Promise<any>; set(key: string, value: unknown): Promise<unknown>; delete?(key: string): Promise<unknown> };
}

interface InstallRecord {
  secret: string;
  installationId: string;
  tenant: string;
  product: Product;
}

const DB_KEY = 'hps_install_v1';
const AUDIENCE = 'helpdesk-power-suite';

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const input = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`;
  return `${input}.${b64url(createHmac('sha256', secret).update(input).digest())}`;
}

export const productOf = (domain: string): Product => (/\.freshservice\.com$/i.test(domain) ? 'freshservice' : 'freshdesk');

/** $request rejects non-2xx with the same shape; normalize both paths. */
async function invoke(env: FdkServerEnv, name: string, opts: { context?: Record<string, unknown>; body?: string }): Promise<{ status: number; data: any; headers: Record<string, string> }> {
  let r: TemplateResponse;
  try {
    r = await env.$request.invokeTemplate(name, opts);
  } catch (e) {
    const err = e as Partial<TemplateResponse>;
    if (typeof err?.status !== 'number') throw e;
    r = { status: err.status, response: err.response ?? '', headers: err.headers };
  }
  let data: any = null;
  try {
    data = r.response ? JSON.parse(r.response) : null;
  } catch {
    data = r.response;
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = String(v);
  return { status: r.status, data, headers };
}

interface CallerUser {
  id?: string | number;
  role?: string;
  customRole?: string;
  groups?: { id?: string; name: string }[];
}

function tokenFor(rec: InstallRecord, user: CallerUser): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    {
      iss: 'hps-shell-freshworks',
      aud: AUDIENCE,
      sub: rec.tenant,
      iid: rec.installationId,
      iat: now,
      exp: now + 120,
      jti: randomBytes(12).toString('hex'),
      usr: { id: String(user.id ?? 'serverless'), role: user.role ?? 'agent', customRole: user.customRole, groups: (user.groups ?? []).slice(0, 200) },
    },
    rec.secret,
  );
}

async function record(env: FdkServerEnv): Promise<InstallRecord> {
  const rec = (await env.$db.get(DB_KEY).catch(() => null)) as InstallRecord | null;
  if (!rec?.secret) throw new Error('Helpdesk Power Suite is not registered for this account. Reinstall the app.');
  return rec;
}

const METHOD_TEMPLATE: Record<string, string> = { GET: 'hpsGet', POST: 'hpsPost', PUT: 'hpsPut', DELETE: 'hpsDelete' };

export function createServerless(env: FdkServerEnv) {
  return {
    /** onAppInstall: registers the tenant and stores the per-install secret server-side. */
    async onAppInstall(payload: { domain?: string; iparams?: Record<string, string> }): Promise<{ ok: true } | { message: string }> {
      const domain = String(payload.domain ?? payload.iparams?.domain ?? '');
      const product = productOf(domain);
      const installationId = `fdk_${randomBytes(9).toString('hex')}`;
      const res = await invoke(env, 'hpsInstall', { body: JSON.stringify({ platform: product, tenant: domain, installationId, appVersion: '1.0.0' }) });
      if (res.status >= 300 || !res.data?.sharedSecret) return { message: res.data?.error?.message ?? `Registration failed (HTTP ${res.status})` };
      await env.$db.set(DB_KEY, { secret: res.data.sharedSecret, installationId: res.data.installationId, tenant: res.data.tenant, product } satisfies InstallRecord);
      return { ok: true };
    },

    /** onAppUninstall: revokes the installation so the account can be cleanly reinstalled later. */
    async onAppUninstall(): Promise<void> {
      const rec = await record(env).catch(() => null);
      if (!rec) return;
      await invoke(env, 'hpsPost', { context: { path: '/v1/uninstall', token: tokenFor(rec, { id: 'serverless', role: 'admin' }) }, body: '{}' }).catch(() => undefined);
      await env.$db.delete?.(DB_KEY).catch(() => undefined);
    },

    /** SMI: signed proxy to the HPS API. Only /v1/ paths; admin rights are only as good as FDK's loggedInUser. */
    async hpsCall(args: { method: string; path: string; body?: unknown; etag?: string; user?: CallerUser }) {
      const tpl = METHOD_TEMPLATE[String(args.method).toUpperCase()];
      if (!tpl) return { status: 400, data: { error: { code: 'invalid_request', message: 'Unsupported method' } } };
      if (!/^\/v1\/[A-Za-z0-9/_\-.]*$/.test(args.path) || args.path.includes('..')) {
        return { status: 400, data: { error: { code: 'invalid_request', message: 'Invalid path' } } };
      }
      const rec = await record(env);
      const res = await invoke(env, tpl, {
        context: { path: args.path, token: tokenFor(rec, args.user ?? {}), etag: args.etag ?? '' },
        ...(args.body !== undefined && tpl !== 'hpsGet' ? { body: JSON.stringify(args.body) } : {}),
      });
      return { status: res.status, data: res.data, headers: { etag: res.headers.etag ?? '' } };
    },

    /** SMI: one Freshdesk page (used by preview). */
    async fdPage(args: { entity: EntityType; cursor: string | null }) {
      const rec = await record(env);
      const { template, context } = pageRequest(rec.product, args.entity, args.cursor);
      const res = await invoke(env, template, { context });
      if (res.status >= 300) throw new Error(`Freshworks API ${template} failed (${res.status})`);
      const records = listRecords(res.data);
      return { records, nextCursor: nextCursor(args.entity, args.cursor, records) };
    },

    /**
     * SMI: export step — fetch one Freshdesk page and push it straight into the HPS export session,
     * server-to-server. Ticket data never round-trips through the agent's browser.
     */
    async exportStep(args: { sessionId: string; entity: EntityType; cursor: string | null; user?: CallerUser }) {
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(args.sessionId)) return { status: 400, data: { error: { code: 'invalid_request', message: 'Invalid session' } } };
      const page = await this.fdPage({ entity: args.entity, cursor: args.cursor });
      const rec = await record(env);
      const res = await invoke(env, 'hpsPost', {
        context: { path: `/v1/export/sessions/${args.sessionId}/batches`, token: tokenFor(rec, args.user ?? {}) },
        body: JSON.stringify({ cursor: args.cursor, nextCursor: page.nextCursor, records: page.records }),
      });
      return { status: res.status, data: res.data, nextCursor: page.nextCursor };
    },
  };
}

export type Serverless = ReturnType<typeof createServerless>;
