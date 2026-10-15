import { bytesToBase64Url, bytesToHex, utf8 } from './encoding.js';

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto (crypto.subtle) is not available in this runtime');
  return s;
};

const toKeyBytes = (key: string | Uint8Array): Uint8Array => (typeof key === 'string' ? utf8(key) : key);

/** Copies into a fresh ArrayBuffer-backed view (WebCrypto rejects SharedArrayBuffer views in strict TS lib types). */
const buf = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);

export async function hmacSha256(key: string | Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', buf(toKeyBytes(key)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await subtle().sign('HMAC', k, buf(typeof data === 'string' ? utf8(data) : data));
  return new Uint8Array(sig);
}

export const hmacSha256Hex = async (key: string | Uint8Array, data: string | Uint8Array) =>
  bytesToHex(await hmacSha256(key, data));

export const hmacSha256B64Url = async (key: string | Uint8Array, data: string | Uint8Array) =>
  bytesToBase64Url(await hmacSha256(key, data));

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const d = await subtle().digest('SHA-256', buf(typeof data === 'string' ? utf8(data) : data));
  return bytesToHex(new Uint8Array(d));
}

/** Constant-time comparison (length leak only). */
export function timingSafeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const x = typeof a === 'string' ? utf8(a) : a;
  const y = typeof b === 'string' ? utf8(b) : b;
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** URL-safe random identifier with `bytes` of entropy (default 128 bits). */
export const randomId = (bytes = 16): string => bytesToBase64Url(randomBytes(bytes));

export async function importRsaPublicKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return subtle().importKey('spki', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

export async function rsaSha256Verify(key: CryptoKey, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  return subtle().verify('RSASSA-PKCS1-v1_5', key, buf(signature), buf(data));
}
