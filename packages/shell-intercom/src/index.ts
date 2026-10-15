/** @hps/shell-intercom — Intercom companion: REST client, cursor/scroll exporter and Canvas Kit inbox app. */
export {
  IntercomClient,
  INTERCOM_API_VERSION,
  INTERCOM_MAX_PAGE_SIZE,
  nextStartingAfter,
  type CursorPage,
  type DataAttributeModel,
  type IntercomClientOptions,
  type PageOptions,
  type ScrollPage,
} from './IntercomClient.js';
export { exportIntercom, CSV_MIME, type ExportFormat, type ExportResult, type IntercomExportEntity, type IntercomExportOptions, type IntercomUserKind } from './exporter.js';
export {
  createIntercomCanvasRoutes,
  initializeCanvas,
  notConfiguredCanvas,
  conversationTags,
  toHints,
  CANVAS_EXPORTS,
  CANVAS_SIGNATURE_HEADER,
  type CanvasAction,
  type CanvasComponent,
  type CanvasListItem,
  type CanvasRequest,
  type CanvasResponse,
  type FieldHint,
  type IntercomCanvasDeps,
} from './canvas.js';
export { runCursorLoop, DEFAULT_MAX_PAGES, type CursorLoopOptions, type CursorLoopResult, type ExportProgress, type PageResult, type StopReason } from './cursorLoop.js';
export { fetchWithRetry, parseRetryAfter, parseRateLimitReset, abortableSleep, UpstreamError, type RetryOptions, type Sleep } from './http.js';
export { readSignedJson, storeDownload, exportFiltersSchema, type DownloadDeps, type StoredDownload } from './serverUtils.js';
