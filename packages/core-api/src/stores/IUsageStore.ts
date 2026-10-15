/**
 * Minimal key-value contract for counters, entitlements, rules, install records and ephemeral
 * export blobs. Implemented in-memory (dev/tests/single node) and on Redis (Upstash REST or RESP).
 */
export interface IUsageStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
  /** SET NX: returns true only when the key did not exist (idempotency / replay protection). */
  setIfAbsent(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Atomic increment. `ttlSeconds` is applied when the counter is created. */
  incr(key: string, by?: number, opts?: { ttlSeconds?: number }): Promise<number>;
}

export async function getJson<T>(store: IUsageStore, key: string): Promise<T | null> {
  const raw = await store.get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const setJson = (store: IUsageStore, key: string, value: unknown, opts?: { ttlSeconds?: number }) =>
  store.set(key, JSON.stringify(value), opts);
