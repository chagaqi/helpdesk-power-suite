import type { Context, Hono } from 'hono';
import { ZodError, z } from 'zod';
import { HpsError, hmacSha256Hex, randomId, timingSafeEqual, USER_ROLES, type IUsageStore, type LinkSigner } from '@hps/core-api';
import { bytesToBase64 } from './encoding.js';
import { UpstreamError } from './http.js';

/** Shared server-side plumbing for the companion routes: signed bodies, signed downloads, errors. */

/**
 * Reads the raw request body and verifies `header` = hex HMAC-SHA256(secret, rawBody), optionally
 * prefixed with "sha256=". The MAC is computed over the exact bytes received (no re-serialization).
 */
export async function readSignedJson(c: Context, secret: string, header: string): Promise<unknown> {
  const raw = new Uint8Array(await c.req.arrayBuffer());
  const provided = (c.req.header(header) ?? '').trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) throw new HpsError('unauthorized', `Missing or malformed ${header} header`);
  const expected = await hmacSha256Hex(secret, raw);
  if (!timingSafeEqual(expected, provided)) throw new HpsError('unauthorized', 'Invalid request signature');
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new HpsError('invalid_request', 'Request body must be valid JSON');
  }
}

export interface DownloadDeps {
  store: IUsageStore;
  signer: LinkSigner;
  publicBaseUrl: string;
}

export interface StoredDownload {
  id: string;
  downloadUrl: string;
  expiresAt: string;
}

/**
 * Persists an export with core-api's exact convention (`export:blob:<id>` base64 + `export:meta:<id>`
 * JSON) so the signed link is served by core's `GET /v1/exports/:id?exp=&sig=` route.
 */
export async function storeDownload(
  deps: DownloadDeps,
  file: { bytes: Uint8Array; filename: string; contentType: string; tenant: string; rows: number },
  ttlSeconds: number,
): Promise<StoredDownload> {
  const id = randomId(18);
  const meta = { filename: file.filename, contentType: file.contentType, size: file.bytes.length, tenant: file.tenant, rows: file.rows };
  await deps.store.set(`export:blob:${id}`, bytesToBase64(file.bytes), { ttlSeconds });
  await deps.store.set(`export:meta:${id}`, JSON.stringify(meta), { ttlSeconds });
  const link = await deps.signer.url(deps.publicBaseUrl, id, ttlSeconds);
  return { id, downloadUrl: link.url, expiresAt: link.expiresAt };
}

const isoish = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO date');
const tagList = z.array(z.string().min(1).max(200)).max(500);

/** Mirrors core's (unexported) exportFiltersSchema. */
export const exportFiltersSchema = z.object({
  userState: z.enum(['all', 'active', 'suspended']).optional(),
  roles: z.array(z.enum(USER_ROLES)).max(10).optional(),
  tags: z.object({ any: tagList.optional(), all: tagList.optional(), none: tagList.optional() }).optional(),
  statuses: z.array(z.string().max(60)).max(50).optional(),
  includeArchived: z.boolean().optional(),
  createdAfter: isoish.optional(),
  createdBefore: isoish.optional(),
  updatedAfter: isoish.optional(),
  fieldFilters: z
    .array(
      z.object({
        field: z.string().min(1).max(300),
        op: z.enum(['eq', 'neq', 'contains', 'empty', 'not_empty']).optional(),
        value: z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]).optional(),
      }),
    )
    .max(50)
    .optional(),
  text: z.string().max(500).optional(),
});

/** Maps domain/validation/upstream errors to `{ error: { code, message } }` with matching statuses. */
export function installErrorHandler(app: Hono, log: Pick<Console, 'error'> = console) {
  app.onError((err, c) => {
    if (err instanceof HpsError) return c.json(err.toJSON(), err.status as 400);
    if (err instanceof ZodError) {
      return c.json({ error: { code: 'invalid_request', message: 'Request validation failed', details: err.issues.slice(0, 50) } }, 400);
    }
    if (err instanceof RangeError) return c.json({ error: { code: 'invalid_request', message: err.message } }, 400);
    if (err instanceof UpstreamError) {
      // 401/403 from the helpdesk means our stored credentials are wrong — surface it, but as a 502 (not the caller's auth).
      return c.json({ error: { code: 'upstream_error', message: err.message, upstreamStatus: err.status } }, 502);
    }
    log.error('[shell route]', err);
    return c.json({ error: { code: 'internal', message: 'Internal error' } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404));
}
