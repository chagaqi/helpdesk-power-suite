import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  evaluateCompiled,
  HpsError,
  hmacSha256Hex,
  tenantKey,
  timingSafeEqual,
  type EntitlementService,
  type EvalContext,
  type Evaluation,
  type IUsageStore,
  type LinkSigner,
  type NamedRef,
  type Primitive,
  type UserRole,
  type VisualFieldRuleEngine,
} from '@hps/core-api';
import { exportGorgias } from './exporter.js';
import { gorgiasAccountSlug, type GorgiasClient } from './GorgiasClient.js';
import { exportFiltersSchema, installErrorHandler, readSignedJson, storeDownload } from './serverUtils.js';

/**
 * Gorgias companion routes, mounted next to core-api by the gateway:
 *   POST /gorgias/widget  — HTTP-integration callback → field-rule hints for the sidebar widget
 *   POST /gorgias/export  — server-side cursor export → signed download link served by core
 *
 * Both are authenticated with `X-HPS-Signature: sha256=<hex HMAC-SHA256(widgetSecret, rawBody)>`.
 */

export interface GorgiasRouteDeps {
  rules: VisualFieldRuleEngine;
  entitlements: EntitlementService;
  store: IUsageStore;
  signer: LinkSigner;
  /** Public origin of the gateway (where core's GET /v1/exports/:id is reachable). */
  publicBaseUrl: string;
  /** Shared HMAC secret configured in the Gorgias HTTP integration (>= 16 chars). */
  widgetSecret: string;
  /** Returns an authenticated client for a Gorgias account slug, or null when none is configured. */
  clientFactory?: (account: string) => GorgiasClient | null | Promise<GorgiasClient | null>;
  /** Signed download link lifetime. Default 900 s (same as core). */
  downloadTtlSec?: number;
  /** Max accepted request body. Default 1 MB. */
  maxBodyBytes?: number;
  logger?: Pick<Console, 'error'>;
}

export const SIGNATURE_HEADER = 'X-HPS-Signature';
/** Static per-account header for Gorgias HTTP integrations, which can only send fixed headers. */
export const ACCOUNT_TOKEN_HEADER = 'X-HPS-Account-Token';

/** Per-account static token = hex HMAC-SHA256(widgetSecret, "gorgias-account:<slug>"). Paste it as a fixed header. */
export const gorgiasAccountToken = (widgetSecret: string, account: string) =>
  hmacSha256Hex(widgetSecret, `gorgias-account:${gorgiasAccountSlug(account)}`);

/**
 * Accepts either a per-request body HMAC (signing relay) or the static per-account token, which is
 * bound to the `account` in the body so one account's token cannot act for another.
 */
async function readAuthenticated(c: Context, secret: string): Promise<unknown> {
  const token = c.req.header(ACCOUNT_TOKEN_HEADER)?.trim().toLowerCase();
  if (!token) return readSignedJson(c, secret, SIGNATURE_HEADER);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HpsError('invalid_request', 'Request body must be valid JSON');
  }
  const account = (body as { account?: unknown })?.account;
  if (typeof account !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw new HpsError('unauthorized', 'Invalid account token');
  const expected = await gorgiasAccountToken(secret, account).catch(() => '');
  if (!timingSafeEqual(expected, token)) throw new HpsError('unauthorized', 'Invalid account token');
  return body;
}

const idSchema = z.union([z.string().max(100), z.number()]).transform(String);
const roleSchema = z.union([z.string().max(100), z.object({ name: z.string().max(100) }).passthrough()]);
const tagsSchema = z.union([z.array(z.union([z.string().max(200), z.object({ name: z.string().max(200) }).passthrough()])).max(1000), z.string().max(20_000)]);

const widgetSchema = z.object({
  account: z.string().min(1).max(200),
  ticket: z
    .object({
      id: idSchema,
      tags: tagsSchema.nullish(),
      status: z.string().max(60).nullish(),
      // Object keyed by field id, array of {id, value}, or a JSON string when rendered by a template.
      custom_fields: z.unknown().optional(),
      assignee_user: z.object({ id: idSchema.optional(), role: roleSchema.nullish() }).passthrough().nullish(),
      assignee_team: z.object({ id: idSchema.optional(), name: z.string().max(300).optional() }).passthrough().nullish(),
    })
    .passthrough(),
  user: z
    .object({
      id: idSchema.optional(),
      role: roleSchema.nullish(),
      team_ids: z.array(idSchema).max(500).optional(),
    })
    .passthrough()
    .nullish(),
});

const exportSchema = z.object({
  account: z.string().min(1).max(200),
  entity: z.enum(['ticket', 'user']),
  userKind: z.enum(['customers', 'agents']).optional(),
  filters: exportFiltersSchema.default({}),
  columns: z.array(z.string().min(1).max(300)).max(2000).optional(),
  format: z.enum(['csv', 'xlsx']).default('csv'),
  filename: z.string().max(120).optional(),
});

export type GorgiasWidgetRequest = z.input<typeof widgetSchema>;
export type GorgiasExportRequest = z.input<typeof exportSchema>;

export interface FieldHint {
  field: string;
  fieldId: string;
  hidden: boolean;
  disabled: boolean;
  required: boolean;
  value?: Primitive | Primitive[];
}

/** Gorgias role → canonical role: admin → admin, lite/observer agents → light_agent, everyone else → agent. */
export function mapGorgiasRole(role: unknown): UserRole {
  const name = (typeof role === 'string' ? role : role && typeof role === 'object' ? String((role as { name?: unknown }).name ?? '') : '').toLowerCase();
  if (name === 'admin') return 'admin';
  if (name.includes('lite') || name.includes('observer')) return 'light_agent';
  return 'agent';
}

function tagNames(v: z.infer<typeof tagsSchema> | null | undefined): string[] {
  if (!v) return [];
  const list = typeof v === 'string' ? v.split(/[\s,]+/) : v.map((t) => (typeof t === 'string' ? t : t.name));
  return Array.from(new Set(list.map((t) => t.trim()).filter(Boolean)));
}

const toPrimitive = (v: unknown): Primitive | Primitive[] | undefined => {
  if (v === undefined) return undefined;
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((x) => (x === null || ['string', 'number', 'boolean'].includes(typeof x) ? (x as Primitive) : JSON.stringify(x)));
  return JSON.stringify(v);
};

/** Extracts `{ fieldId: value }` from Gorgias' ticket.custom_fields in any of its observed shapes. */
export function gorgiasCustomFieldValues(cf: unknown): Record<string, Primitive | Primitive[] | undefined> {
  let src = cf;
  if (typeof src === 'string') {
    try {
      src = JSON.parse(src);
    } catch {
      return {};
    }
  }
  const out: Record<string, Primitive | Primitive[] | undefined> = {};
  if (Array.isArray(src)) {
    for (const f of src) {
      if (!f || typeof f !== 'object') continue;
      const o = f as Record<string, unknown>;
      const id = o.id ?? o.field_id;
      if (id !== undefined && id !== null) out[String(id)] = toPrimitive(o.value);
    }
  } else if (src && typeof src === 'object') {
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      out[k] = toPrimitive(v && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? (v as { value: unknown }).value : v);
    }
  }
  return out;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Turns an Evaluation into widget hints and the names of required-but-empty fields. */
export function toHints(ev: Evaluation, values: Record<string, unknown>): { hints: FieldHint[]; requiredMissing: string[] } {
  const byName = new Map(Object.entries(values).map(([k, v]) => [norm(k), v]));
  const hints: FieldHint[] = [];
  const requiredMissing: string[] = [];
  for (const st of Object.values(ev.fields)) {
    const hint: FieldHint = { field: st.name, fieldId: st.fieldId, hidden: st.hidden === true, disabled: st.disabled === true, required: st.required === true };
    if (st.setValue) hint.value = st.value ?? null;
    hints.push(hint);
    if (hint.required && !hint.hidden) {
      const v = values[st.fieldId] ?? values[st.key] ?? byName.get(norm(st.name));
      if (isEmpty(v)) requiredMissing.push(st.name);
    }
  }
  hints.sort((a, b) => a.field.localeCompare(b.field));
  return { hints, requiredMissing };
}

const safeFilename = (name: string) => name.replace(/\.(csv|xlsx)$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 100) || 'export';

export function createGorgiasRoutes(deps: GorgiasRouteDeps): Hono {
  if (!deps.widgetSecret || deps.widgetSecret.length < 16) throw new Error('createGorgiasRoutes: widgetSecret must be at least 16 characters');
  const app = new Hono();
  const ttl = deps.downloadTtlSec ?? 900;
  installErrorHandler(app, deps.logger);
  app.use(
    '/gorgias/*',
    bodyLimit({
      maxSize: deps.maxBodyBytes ?? 1024 * 1024,
      onError: () => {
        throw new HpsError('payload_too_large', 'Request body too large');
      },
    }),
  );

  const tenantOf = (account: string) => tenantKey('gorgias', gorgiasAccountSlug(account));

  app.post('/gorgias/widget', async (c) => {
    const body = widgetSchema.parse(await readAuthenticated(c, deps.widgetSecret));
    const tenant = tenantOf(body.account);
    const t = body.ticket;

    // HTTP integrations fire on ticket events, not per viewing agent: when no agent is supplied, the
    // ticket's assignee (and assigned team) is the audience the hints are computed for.
    const groups: (NamedRef | string)[] = body.user
      ? (body.user.team_ids ?? [])
      : t.assignee_team?.id
        ? [{ id: t.assignee_team.id, name: t.assignee_team.name ?? t.assignee_team.id }]
        : [];
    const ctx: EvalContext = {
      user: {
        id: body.user?.id ?? t.assignee_user?.id,
        role: mapGorgiasRole(body.user ? body.user.role : t.assignee_user?.role),
        groups,
      },
      ticket: { tags: tagNames(t.tags), fields: gorgiasCustomFieldValues(t.custom_fields), isNew: false },
    };

    const set = await deps.rules.compile(tenant);
    const ev = evaluateCompiled(set, ctx);
    const { hints, requiredMissing } = toHints(ev, ctx.ticket?.fields ?? {});
    const warnings = [...ev.warnings];
    if (set.inactiveRuleIds.length) warnings.push(`${set.inactiveRuleIds.length} rule(s) are inactive on the Free plan. Upgrade to Pro for unlimited field rules.`);
    c.header('Cache-Control', 'no-store');
    return c.json({ tenant, ticketId: t.id, version: set.version, hints, requiredMissing, matchedRuleIds: ev.matchedRuleIds, warnings });
  });

  app.post('/gorgias/export', async (c) => {
    const body = exportSchema.parse(await readAuthenticated(c, deps.widgetSecret));
    const account = gorgiasAccountSlug(body.account);
    const tenant = tenantKey('gorgias', account);
    const client = deps.clientFactory ? await deps.clientFactory(account) : null;
    if (!client) throw new HpsError('not_found', `No Gorgias API credentials are configured for "${account}"`);

    const rowLimit = await deps.entitlements.exportRowLimit(tenant);
    const result = await exportGorgias({
      client,
      entity: body.entity,
      userKind: body.userKind,
      filters: body.filters,
      columns: body.columns,
      rowLimit,
      format: body.format,
      filename: body.filename ? safeFilename(body.filename) : undefined,
      signal: c.req.raw.signal,
    });
    const rows = result.session.size;
    const link = await storeDownload(deps, { bytes: result.bytes, filename: result.filename, contentType: result.contentType, tenant, rows }, ttl);
    await deps.entitlements.recordExport(tenant, rows);
    const ent = await deps.entitlements.get(tenant);
    const stats = result.session.stats;
    c.header('Cache-Control', 'no-store');
    return c.json({
      downloadUrl: link.downloadUrl,
      expiresAt: link.expiresAt,
      filename: result.filename,
      bytes: result.bytes.length,
      pages: result.pages,
      stoppedBy: result.stoppedBy,
      stats,
      plan: ent.effectivePlan,
      ...(stats.limitReached && ent.effectivePlan === 'free'
        ? { upgrade: { message: `Free plan exports are limited to ${ent.limits.maxExportRows} rows.`, url: deps.entitlements.upgradeUrl } }
        : {}),
    });
  });

  return app;
}
