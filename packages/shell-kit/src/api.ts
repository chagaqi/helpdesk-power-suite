import type { Catalog, CompiledRuleSet, Evaluation, ExportFilters, FieldRule, CustomFieldDef, EntityType, Platform } from '@hps/core-api';
import type { ApiResponse, ExportOutcome, HostAdapter } from './types.js';

export class HpsApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HpsApiError';
  }
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RulesConfig {
  version: string;
  compiled: CompiledRuleSet;
  limits: { maxFieldRules: number | null; plan: string; used: number };
  rules?: FieldRule[];
  catalog?: Catalog;
}

export interface MeResponse {
  tenant: string;
  platform: Platform;
  user: { id: string; role: string; groups: { id?: string; name: string }[] };
  entitlement: { effectivePlan: 'free' | 'pro'; limits: { maxExportRows: number | null; maxFieldRules: number | null } };
  usage: { exportRowsThisMonth: number };
}

/** Typed HPS API client over a HostAdapter transport, with bounded retries for 429/5xx. */
export class HpsApiClient {
  constructor(
    private readonly host: Pick<HostAdapter, 'api'>,
    private readonly retry = { attempts: 3, baseMs: 400 },
  ) {}

  async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>> {
    let last: ApiResponse<T> | undefined;
    for (let i = 0; i < this.retry.attempts; i++) {
      last = await this.host.api<T>(method, path, body, headers);
      if (!RETRYABLE.has(last.status)) break;
      await sleep(this.retry.baseMs * 2 ** i);
    }
    const res = last!;
    if (res.status >= 400) {
      const err = (res.data as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
      throw new HpsApiError(res.status, err?.code ?? 'http_error', err?.message ?? `HTTP ${res.status}`, err?.details);
    }
    return res;
  }

  me() {
    return this.call<MeResponse>('GET', '/v1/me').then((r) => r.data);
  }

  /** Returns null when unchanged (304) for cheap revalidation of the cached rule set. */
  async rulesConfig(etag?: string): Promise<{ config: RulesConfig; etag?: string } | null> {
    const r = await this.call<RulesConfig>('GET', '/v1/rules/config', undefined, etag ? { 'If-None-Match': etag } : undefined);
    if (r.status === 304) return null;
    return { config: r.data, etag: r.headers?.etag ?? r.headers?.ETag ?? `"${r.data.version}"` };
  }

  syncCatalog(catalog: Catalog) {
    return this.call<Catalog>('PUT', '/v1/rules/catalog', catalog).then((r) => r.data);
  }
  validateRule(input: unknown) {
    return this.call<{ ok: boolean; problems: { path: string; message: string; suggestions: string[] }[] }>('POST', '/v1/rules/validate', input).then((r) => r.data);
  }
  createRule(input: unknown) {
    return this.call<FieldRule>('POST', '/v1/rules', input).then((r) => r.data);
  }
  updateRule(id: string, input: unknown) {
    return this.call<FieldRule>('PUT', `/v1/rules/${encodeURIComponent(id)}`, input).then((r) => r.data);
  }
  deleteRule(id: string) {
    return this.call<null>('DELETE', `/v1/rules/${encodeURIComponent(id)}`);
  }
  reorderRules(ids: string[]) {
    return this.call<{ rules: FieldRule[] }>('POST', '/v1/rules/reorder', { ids }).then((r) => r.data.rules);
  }
  evaluate(ctx: unknown) {
    return this.call<Evaluation>('POST', '/v1/rules/evaluate', ctx).then((r) => r.data);
  }

  createExportSession(body: { entity: EntityType; source: Platform; fieldSchema: CustomFieldDef[]; filters: ExportFilters; columns?: string[] }) {
    return this.call<{ id: string; columns: string[] }>('POST', '/v1/export/sessions', body).then((r) => r.data);
  }
  sendBatch(id: string, batch: { cursor: string | null; nextCursor: string | null; records: unknown[] }) {
    return this.call<{ totalRows: number; duplicates: number; filteredOut: number; limitReached: boolean; replayed: boolean; received: number }>('POST', `/v1/export/sessions/${encodeURIComponent(id)}/batches`, batch).then((r) => r.data);
  }
  finalize(id: string, body: { format: 'csv' | 'xlsx'; filename?: string }) {
    return this.call<ExportOutcome>('POST', `/v1/export/sessions/${encodeURIComponent(id)}/finalize`, body).then((r) => r.data);
  }
  checkout() {
    return this.call<{ url: string }>('POST', '/v1/billing/checkout', {}).then((r) => r.data);
  }
}
