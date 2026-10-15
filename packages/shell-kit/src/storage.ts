import type { KeyValueStorage } from './types.js';

/** localStorage with an in-memory fallback (Safari ITP / sandboxed iframes can throw). */
export function browserStorage(namespace = ''): KeyValueStorage {
  const mem = new Map<string, string>();
  return {
    get(key) {
      try {
        return globalThis.localStorage?.getItem(namespace + key) ?? mem.get(key) ?? null;
      } catch {
        return mem.get(key) ?? null;
      }
    },
    set(key, value) {
      mem.set(key, value);
      try {
        globalThis.localStorage?.setItem(namespace + key, value);
      } catch {
        /* quota / disabled storage: memory only */
      }
    },
  };
}

export function memoryStorage(): KeyValueStorage {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
}
