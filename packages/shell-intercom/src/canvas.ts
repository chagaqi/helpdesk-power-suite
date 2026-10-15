import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  evaluateCompiled,
  HpsError,
  tenantKey,
  type EntitlementService,
  type EvalContext,
  type Evaluation,
  type IUsageStore,
  type LinkSigner,
  type Primitive,
  type VisualFieldRuleEngine,
} from '@hps/core-api';
import type { ExportFilters } from '@hps/core-api/export';
import { exportIntercom, type ExportFormat, type IntercomExportEntity, type IntercomUserKind } from './exporter.js';
import { UpstreamError } from './http.js';
import type { IntercomClient } from './IntercomClient.js';
import { installErrorHandler, readSignedJson, storeDownload } from './serverUtils.js';

/**
 * Intercom Canvas Kit inbox app (Messenger/Inbox "app" with initialize + submit webhooks):
 *   POST /intercom/canvas/initialize — field-rule hints for the open conversation + export buttons
 *   POST /intercom/canvas/submit     — runs the export for the clicked button, answers with a URL button
 *
 * Intercom signs each request: `X-Body-Signature: hex(HMAC-SHA256(clientSecret, rawBody))`.
 */

export interface IntercomCanvasDeps {
  rules: VisualFieldRuleEngine;
  entitlements: EntitlementService;
  store: IUsageStore;
  signer: LinkSigner;
  /** Public origin of the gateway (where core's GET /v1/exports/:id is reachable). */
  publicBaseUrl: string;
  /** The Intercom app's client secret (Developer Hub → Basic information). */
  clientSecret: string;
  /** Returns an API client for the workspace's stored access token, or null when none is configured. */
  clientFactory?: (workspaceId: string) => IntercomClient | null | Promise<IntercomClient | null>;
  /** Filters applied to contact exports started from the inbox. Default: all contacts (archived ones are labelled in the State column). */
  contactFilters?: ExportFilters;
  downloadTtlSec?: number;
  maxBodyBytes?: number;
  logger?: Pick<Console, 'error'>;
}

export const CANVAS_SIGNATURE_HEADER = 'X-Body-Signature';

// ---------------------------------------------------------------------------------------- Canvas Kit types

export type CanvasAction = { type: 'submit' } | { type: 'url'; url: string };

export type CanvasComponent =
  | { type: 'text'; id?: string; text: string; style?: 'header' | 'paragraph' | 'muted' | 'error'; align?: 'left' | 'center' | 'right' }
  | { type: 'button'; id: string; label: string; style?: 'primary' | 'secondary' | 'link'; disabled?: boolean; action: CanvasAction }
  | { type: 'list'; id?: string; items: CanvasListItem[]; disabled?: boolean }
  | { type: 'divider'; id?: string }
  | { type: 'spacer'; id?: string; size?: 'xs' | 's' | 'm' | 'l' | 'xl' };

export interface CanvasListItem {
  type: 'item';
  id: string;
  title: string;
  subtitle?: string;
  tertiary_text?: string;
  disabled?: boolean;
}

export interface CanvasResponse {
  canvas: { content: { components: CanvasComponent[] }; stored_data?: Record<string, unknown> };
}

/** Export buttons rendered by initialize and handled by submit. */
export const CANVAS_EXPORTS: Record<string, { entity: IntercomExportEntity; userKind?: IntercomUserKind; format: ExportFormat; label: string; noun: string }> = {
  export_contacts: { entity: 'user', userKind: 'contacts', format: 'csv', label: 'Export contacts (CSV)', noun: 'Contacts' },
  export_companies_xlsx: { entity: 'organization', format: 'xlsx', label: 'Export companies (XLSX)', noun: 'Companies' },
};

// ---------------------------------------------------------------------------------------- request parsing

const idSchema = z.union([z.string().max(100), z.number()]).transform(String);

const canvasRequestSchema = z
  .object({
    workspace_id: z.string().min(1).max(100),
    admin: z
      .object({ id: idSchema, name: z.string().max(300).nullish(), email: z.string().max(300).nullish(), team_ids: z.array(idSchema).max(500).nullish() })
      .passthrough()
      .nullish(),
    contact: z.unknown().optional(),
    conversation: z
      .object({ id: idSchema.optional(), tags: z.unknown().optional(), custom_attributes: z.record(z.string(), z.unknown()).nullish() })
      .passthrough()
      .nullish(),
    component_id: z.string().max(200).nullish(),
    current_canvas: z.unknown().optional(),
    input_values: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

export type CanvasRequest = z.infer<typeof canvasRequestSchema>;

/** Conversation tags arrive as `{ type: 'tag.list', tags: [{ id, name }] }`; arrays / `{ data }` are accepted too. */
export function conversationTags(v: unknown): string[] {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const list: unknown[] = Array.isArray(v) ? v : Array.isArray(o.tags) ? o.tags : Array.isArray(o.data) ? o.data : [];
  const out = list
    .map((t) => (typeof t === 'string' ? t : t && typeof t === 'object' ? (t as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
    .map((n) => n.trim());
  return Array.from(new Set(out));
}

const toPrimitive = (v: unknown): Primitive | Primitive[] => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((x) => (x === null || ['string', 'number', 'boolean'].includes(typeof x) ? (x as Primitive) : JSON.stringify(x)));
  return JSON.stringify(v);
};

// ---------------------------------------------------------------------------------------- rule hints

export interface FieldHint {
  field: string;
  fieldId: string;
  hidden: boolean;
  disabled: boolean;
  required: boolean;
  missing: boolean;
  value?: Primitive | Primitive[];
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Evaluation → hints. Intercom attributes are keyed by name, so values are matched by id, key, then name. */
export function toHints(ev: Evaluation, values: Record<string, unknown>): FieldHint[] {
  const byName = new Map(Object.entries(values).map(([k, v]) => [norm(k), v]));
  return Object.values(ev.fields)
    .map((st) => {
      const required = st.required === true;
      const hidden = st.hidden === true;
      const v = values[st.fieldId] ?? values[st.key] ?? byName.get(norm(st.name));
      const hint: FieldHint = { field: st.name, fieldId: st.fieldId, hidden, disabled: st.disabled === true, required, missing: required && !hidden && isEmpty(v) };
      if (st.setValue) hint.value = st.value ?? null;
      return hint;
    })
    .sort((a, b) => a.field.localeCompare(b.field));
}

// ---------------------------------------------------------------------------------------- canvases

const fmt = (n: number) => n.toLocaleString('en-US');
const canvas = (components: CanvasComponent[], stored?: Record<string, unknown>): CanvasResponse => ({
  canvas: { content: { components }, ...(stored ? { stored_data: stored } : {}) },
});

function hintSubtitle(h: FieldHint): string {
  const parts: string[] = [];
  if (h.hidden) parts.push('Hidden');
  if (h.disabled) parts.push('Read-only');
  if (h.required) parts.push('Required');
  if (h.value !== undefined) parts.push(`Set to ${Array.isArray(h.value) ? h.value.join(', ') : String(h.value)}`);
  return parts.join(' · ') || 'Visible';
}

export function initializeCanvas(input: { hints: FieldHint[]; warnings: string[]; plan: string; maxExportRows: number | null }): CanvasResponse {
  const { hints } = input;
  const components: CanvasComponent[] = [{ type: 'text', id: 'title', text: 'Helpdesk Power Suite', style: 'header' }];
  if (hints.length) {
    components.push({ type: 'text', id: 'rules_intro', text: 'Field rules for this conversation', style: 'muted' });
    components.push({
      type: 'list',
      id: 'field_rules',
      items: hints.map((h, i) => ({
        type: 'item',
        id: `field_rule_${i}`,
        title: h.field,
        subtitle: hintSubtitle(h),
        ...(h.missing ? { tertiary_text: 'Missing value' } : {}),
      })),
    });
    const missing = hints.filter((h) => h.missing).map((h) => h.field);
    if (missing.length) components.push({ type: 'text', id: 'required_missing', text: `Required before closing: ${missing.join(', ')}`, style: 'error' });
  } else {
    components.push({ type: 'text', id: 'rules_intro', text: 'No field rules apply to this conversation.', style: 'muted' });
  }
  input.warnings.forEach((w, i) => components.push({ type: 'text', id: `warning_${i}`, text: w, style: 'muted' }));
  components.push({ type: 'divider', id: 'export_divider' });
  for (const [id, e] of Object.entries(CANVAS_EXPORTS)) {
    components.push({ type: 'button', id, label: e.label, style: id === 'export_contacts' ? 'primary' : 'secondary', action: { type: 'submit' } });
  }
  if (input.maxExportRows !== null) {
    components.push({ type: 'text', id: 'plan_note', text: `${input.plan === 'free' ? 'Free' : input.plan} plan: exports include up to ${fmt(input.maxExportRows)} rows.`, style: 'muted' });
  }
  return canvas(components);
}

const backButton: CanvasComponent = { type: 'button', id: 'back', label: 'Back', style: 'link', action: { type: 'submit' } };

export const notConfiguredCanvas = (): CanvasResponse =>
  canvas([
    { type: 'text', id: 'title', text: 'Export unavailable', style: 'header' },
    {
      type: 'text',
      id: 'not_configured',
      text: 'An Intercom access token is not configured for this workspace yet. Ask an admin to connect Helpdesk Power Suite to Intercom, then try again.',
      style: 'paragraph',
    },
    backButton,
  ]);

// ---------------------------------------------------------------------------------------- routes

export function createIntercomCanvasRoutes(deps: IntercomCanvasDeps): Hono {
  if (!deps.clientSecret) throw new Error('createIntercomCanvasRoutes: clientSecret is required');
  const app = new Hono();
  const ttl = deps.downloadTtlSec ?? 900;
  installErrorHandler(app, deps.logger);
  app.use(
    '/intercom/*',
    bodyLimit({
      maxSize: deps.maxBodyBytes ?? 1024 * 1024,
      onError: () => {
        throw new HpsError('payload_too_large', 'Request body too large');
      },
    }),
  );

  const readRequest = async (c: Parameters<typeof readSignedJson>[0]) =>
    canvasRequestSchema.parse(await readSignedJson(c, deps.clientSecret, CANVAS_SIGNATURE_HEADER));

  const renderInitialize = async (req: CanvasRequest): Promise<CanvasResponse> => {
    const tenant = tenantKey('intercom', req.workspace_id);
    const attrs = req.conversation?.custom_attributes ?? {};
    const fields: Record<string, Primitive | Primitive[]> = {};
    for (const [k, v] of Object.entries(attrs)) fields[k] = toPrimitive(v);
    // Intercom teammates are agents for rule purposes; their team membership maps to rule groups.
    const ctx: EvalContext = {
      user: { id: req.admin?.id, role: 'agent', groups: req.admin?.team_ids ?? [] },
      ticket: { tags: conversationTags(req.conversation?.tags), fields, isNew: false },
    };
    const [set, ent] = await Promise.all([deps.rules.compile(tenant), deps.entitlements.get(tenant)]);
    const ev = evaluateCompiled(set, ctx);
    const warnings = [...ev.warnings];
    if (set.inactiveRuleIds.length) warnings.push(`${set.inactiveRuleIds.length} rule(s) are inactive on the Free plan.`);
    return initializeCanvas({ hints: toHints(ev, fields), warnings, plan: ent.effectivePlan, maxExportRows: ent.limits.maxExportRows });
  };

  app.post('/intercom/canvas/initialize', async (c) => c.json(await renderInitialize(await readRequest(c))));

  app.post('/intercom/canvas/submit', async (c) => {
    const req = await readRequest(c);
    const spec = req.component_id ? CANVAS_EXPORTS[req.component_id] : undefined;
    if (!spec) return c.json(await renderInitialize(req));

    const tenant = tenantKey('intercom', req.workspace_id);
    const client = deps.clientFactory ? await deps.clientFactory(req.workspace_id) : null;
    if (!client) return c.json(notConfiguredCanvas());

    const rowLimit = await deps.entitlements.exportRowLimit(tenant);
    let result;
    try {
      result = await exportIntercom({
        client,
        entity: spec.entity,
        userKind: spec.userKind,
        filters: spec.entity === 'user' ? deps.contactFilters : undefined,
        rowLimit,
        format: spec.format,
        signal: c.req.raw.signal,
      });
    } catch (e) {
      if (!(e instanceof UpstreamError)) throw e;
      // Answer with a canvas (Intercom shows a generic failure for non-2xx canvas responses).
      const hint = e.status === 401 || e.status === 403 ? ' The stored access token was rejected; reconnect the app.' : ' Please try again in a minute.';
      return c.json(
        canvas([
          { type: 'text', id: 'title', text: 'Export failed', style: 'header' },
          { type: 'text', id: 'error', text: `Intercom API error${e.status ? ` (${e.status})` : ''}.${hint}`, style: 'error' },
          backButton,
        ]),
      );
    }

    const rows = result.session.size;
    const link = await storeDownload(deps, { bytes: result.bytes, filename: result.filename, contentType: result.contentType, tenant, rows }, ttl);
    await deps.entitlements.recordExport(tenant, rows);
    const ent = await deps.entitlements.get(tenant);
    const st = result.session.stats;

    const summary = [`${fmt(st.rows)} ${st.rows === 1 ? 'row' : 'rows'}`, `${fmt(st.duplicatesDropped)} duplicates removed`];
    if (st.filteredOut) summary.push(`${fmt(st.filteredOut)} filtered out`);
    const components: CanvasComponent[] = [
      { type: 'text', id: 'title', text: `${spec.noun} export ready`, style: 'header' },
      { type: 'text', id: 'summary', text: summary.join(' · '), style: 'paragraph' },
      { type: 'button', id: 'download_export', label: `Download ${spec.format.toUpperCase()}`, style: 'primary', action: { type: 'url', url: link.downloadUrl } },
      { type: 'text', id: 'expires', text: `Link expires ${link.expiresAt.replace('T', ' ').slice(0, 16)} UTC.`, style: 'muted' },
    ];
    if (st.limitReached && ent.effectivePlan === 'free') {
      components.push({ type: 'text', id: 'limit', text: `Free plan exports are limited to ${fmt(ent.limits.maxExportRows ?? rows)} rows.`, style: 'muted' });
      components.push({ type: 'button', id: 'upgrade', label: 'Upgrade to Pro', style: 'secondary', action: { type: 'url', url: deps.entitlements.upgradeUrl } });
    }
    components.push(backButton);
    return c.json(canvas(components, { exportId: link.id, rows }));
  });

  return app;
}
