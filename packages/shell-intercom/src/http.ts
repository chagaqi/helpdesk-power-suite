/**
 * Small, dependency-free HTTP helpers for the Intercom REST client: bounded retries on 429/5xx that
 * honor `Retry-After`, abortable sleeps, and a typed upstream error. Isomorphic (fetch + WebCrypto only).
 */

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface RetryOptions {
  /** Retries after the first attempt (default 4 → at most 5 requests). */
  maxRetries?: number;
  /** First backoff when the server sends no Retry-After (doubles each attempt). Default 500 ms. */
  baseDelayMs?: number;
  /** Upper bound for any single wait, including server-provided Retry-After. Default 30 s. */
  maxDelayMs?: number;
  /** Injectable for tests. */
  sleep?: Sleep;
  now?: () => number;
}

/** Non-2xx response (after retries) or network failure talking to the helpdesk API. */
export class UpstreamError extends Error {
  constructor(
    readonly platform: string,
    readonly status: number,
    message: string,
    readonly bodySnippet?: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export const abortableSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Parses `Retry-After` (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** `X-RateLimit-Reset` as sent by Intercom: unix epoch seconds when the window resets. */
export function parseRateLimitReset(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value || !/^\d{9,11}$/.test(value.trim())) return undefined;
  return Math.max(0, Number(value.trim()) * 1000 - now);
}

const isRetryableStatus = (s: number) => s === 429 || s === 408 || (s >= 500 && s !== 501 && s <= 599);
const isAbort = (e: unknown) => e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');

/**
 * fetch() with bounded retries. Retries 408/429/5xx (except 501) and network errors; never retries
 * aborts. Returns the first OK response or throws UpstreamError with a short body snippet.
 */
export async function fetchWithRetry(
  doFetch: typeof fetch,
  platform: string,
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const maxRetries = Math.max(0, opts.maxRetries ?? 4);
  const base = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  const sleep = opts.sleep ?? abortableSleep;
  const now = opts.now ?? Date.now;
  const signal = init.signal ?? undefined;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch (e) {
      if (isAbort(e) || signal?.aborted || attempt >= maxRetries) {
        if (isAbort(e) || signal?.aborted) throw e;
        throw new UpstreamError(platform, 0, `${platform} API unreachable: ${e instanceof Error ? e.message : String(e)}`);
      }
      await sleep(Math.min(maxDelay, base * 2 ** attempt), signal);
      continue;
    }
    if (res.ok) return res;
    if (isRetryableStatus(res.status) && attempt < maxRetries) {
      const hinted = parseRetryAfter(res.headers.get('retry-after'), now()) ?? parseRateLimitReset(res.headers.get('x-ratelimit-reset'), now());
      // Drain the body so keep-alive sockets are released before we wait.
      await res.body?.cancel().catch(() => undefined);
      await sleep(Math.min(maxDelay, hinted ?? base * 2 ** attempt), signal);
      continue;
    }
    const snippet = (await res.text().catch(() => '')).slice(0, 500);
    throw new UpstreamError(platform, res.status, `${platform} API responded ${res.status} for ${new URL(url).pathname}`, snippet);
  }
}
