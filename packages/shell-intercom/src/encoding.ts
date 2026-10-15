/** Isomorphic base64 (no Buffer) — mirrors core-api's internal util, which is not exported from its root. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
