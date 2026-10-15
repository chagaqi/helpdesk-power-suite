import type { Catalog, CustomFieldDef, EntityType, ExportFilters, NamedRef, Platform } from '@hps/core-api';

export interface HostUser {
  id: string;
  name?: string;
  /** Canonical role: admin | agent | light_agent | end_user. */
  role: string;
  customRole?: string;
  groups: NamedRef[];
}

export interface ApiResponse<T> {
  status: number;
  data: T;
  headers?: Record<string, string>;
}

export interface SearchQuery {
  /** Free-text / platform query string (e.g. Zendesk search syntax). Empty = list everything. */
  text?: string;
  /** Tickets: include archived tickets (Zendesk: switches to the incremental cursor export). */
  includeArchived?: boolean;
  /** Users: pre-filter on the platform side where supported. */
  roles?: string[];
}

export interface PageResult {
  records: unknown[];
  nextCursor: string | null;
  /** Platform-reported total, if known. */
  total?: number;
}

export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Everything a helpdesk shell must provide; the kit does the rest. */
export interface HostAdapter {
  platform: Platform;
  tenant(): Promise<string>;
  currentUser(): Promise<HostUser>;
  /** Calls the HPS API via the platform's secure proxy (which attaches the signed JWT). */
  api<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>>;
  /** Unauthenticated call used once for POST /v1/install. */
  installRequest?(body: unknown): Promise<ApiResponse<{ sharedSecret: string; installationId: string; tenant: string }>>;
  /** Persists the shared secret into the platform's secure settings (admin only). */
  saveSecret?(secret: string, installationId: string): Promise<void>;
  installationId?(): Promise<string>;
  fetchPage(entity: EntityType, cursor: string | null, query: SearchQuery): Promise<PageResult>;
  fieldSchema(entity: EntityType): Promise<CustomFieldDef[]>;
  ruleCatalog(): Promise<Catalog>;
  storage: KeyValueStorage;
  openUrl(url: string): void;
  notify?(message: string, kind?: 'notice' | 'alert' | 'error'): void;
  supportsEntity?(entity: EntityType): boolean;
}

export interface ExportRequest {
  entity: EntityType;
  query: SearchQuery;
  filters: ExportFilters;
  columns?: string[];
  format: 'csv' | 'xlsx';
  filename?: string;
}

export interface ExportProgress {
  pages: number;
  received: number;
  rows: number;
  duplicates: number;
  filteredOut: number;
  limitReached: boolean;
  phase: 'fetching' | 'finalizing' | 'done' | 'cancelled' | 'error';
}

export interface ExportOutcome {
  downloadUrl: string;
  expiresAt: string;
  filename: string;
  stats: Record<string, unknown>;
  upgrade?: { message: string; url: string };
}
