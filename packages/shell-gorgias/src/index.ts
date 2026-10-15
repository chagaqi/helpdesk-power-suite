/** @hps/shell-gorgias — Gorgias companion: REST client, cursor exporter and HTTP-integration routes. */
export {
  GorgiasClient,
  GORGIAS_MAX_PAGE_SIZE,
  gorgiasAccountSlug,
  gorgiasCatalogFields,
  gorgiasFieldSchema,
  type CursorPage,
  type GorgiasClientOptions,
  type ListOptions,
} from './GorgiasClient.js';
export { exportGorgias, CSV_MIME, type ExportFormat, type ExportResult, type GorgiasExportEntity, type GorgiasExportOptions, type GorgiasUserKind } from './exporter.js';
export { runCursorLoop, DEFAULT_MAX_PAGES, type CursorLoopOptions, type CursorLoopResult, type ExportProgress, type PageResult, type StopReason } from './cursorLoop.js';
export {
  createGorgiasRoutes,
  gorgiasCustomFieldValues,
  mapGorgiasRole,
  toHints,
  SIGNATURE_HEADER,
  ACCOUNT_TOKEN_HEADER,
  gorgiasAccountToken,
  type FieldHint,
  type GorgiasExportRequest,
  type GorgiasRouteDeps,
  type GorgiasWidgetRequest,
} from './routes.js';
export { fetchWithRetry, parseRetryAfter, parseRateLimitReset, abortableSleep, UpstreamError, type RetryOptions, type Sleep } from './http.js';
export { readSignedJson, storeDownload, exportFiltersSchema, type DownloadDeps, type StoredDownload } from './serverUtils.js';
