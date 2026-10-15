import { base64UrlToBytes, bytesToBase64Url, fromUtf8, utf8 } from '../util/encoding.js';
import { hmacSha256, importRsaPublicKey, rsaSha256Verify, timingSafeEqual } from '../util/crypto.js';

export interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  [claim: string]: unknown;
}

export class JwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtError';
  }
}

const b64json = (o: unknown) => bytesToBase64Url(utf8(JSON.stringify(o)));

export function decodeJwt(token: string): { header: Record<string, unknown>; payload: JwtPayload; signingInput: string; signature: Uint8Array } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed token');
  try {
    const header = JSON.parse(fromUtf8(base64UrlToBytes(parts[0]!))) as Record<string, unknown>;
    const payload = JSON.parse(fromUtf8(base64UrlToBytes(parts[1]!))) as JwtPayload;
    if (!payload || typeof payload !== 'object') throw new Error();
    return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: base64UrlToBytes(parts[2]!) };
  } catch {
    throw new JwtError('malformed token');
  }
}

export async function signHs256(payload: JwtPayload, secret: string | Uint8Array): Promise<string> {
  const input = `${b64json({ alg: 'HS256', typ: 'JWT' })}.${b64json(payload)}`;
  return `${input}.${bytesToBase64Url(await hmacSha256(secret, input))}`;
}

export interface VerifyOptions {
  audience?: string;
  issuer?: string | string[];
  /** Reject tokens whose lifetime (exp - iat) exceeds this many seconds. */
  maxLifetimeSec?: number;
  clockSkewSec?: number;
  nowSec?: number;
  requireExp?: boolean;
}

function checkClaims(p: JwtPayload, o: VerifyOptions) {
  const now = o.nowSec ?? Math.floor(Date.now() / 1000);
  const skew = o.clockSkewSec ?? 60;
  if (o.requireExp !== false && typeof p.exp !== 'number') throw new JwtError('token has no exp');
  if (typeof p.exp === 'number' && p.exp + skew < now) throw new JwtError('token expired');
  if (typeof p.nbf === 'number' && p.nbf - skew > now) throw new JwtError('token not yet valid');
  if (typeof p.iat === 'number' && p.iat - skew > now) throw new JwtError('token issued in the future');
  if (o.maxLifetimeSec && typeof p.exp === 'number') {
    const start = typeof p.iat === 'number' ? p.iat : now;
    if (p.exp - start > o.maxLifetimeSec + skew) throw new JwtError('token lifetime too long');
  }
  if (o.audience) {
    const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (!aud.includes(o.audience)) throw new JwtError('wrong audience');
  }
  if (o.issuer) {
    const iss = Array.isArray(o.issuer) ? o.issuer : [o.issuer];
    if (!iss.includes(String(p.iss))) throw new JwtError('wrong issuer');
  }
}

/** Verifies an HS256 JWT. Any other alg (incl. "none") is rejected. */
export async function verifyHs256(token: string, secret: string | Uint8Array, o: VerifyOptions = {}): Promise<JwtPayload> {
  const { header, payload, signingInput, signature } = decodeJwt(token);
  if (header.alg !== 'HS256') throw new JwtError('unsupported alg');
  const expected = await hmacSha256(secret, signingInput);
  if (!timingSafeEqual(expected, signature)) throw new JwtError('bad signature');
  checkClaims(payload, o);
  return payload;
}

/** Verifies an RS256 JWT (e.g. Zendesk signed-URL tokens) against a PEM public key. */
export async function verifyRs256(token: string, publicKeyPem: string, o: VerifyOptions = {}): Promise<JwtPayload> {
  const { header, payload, signingInput, signature } = decodeJwt(token);
  if (header.alg !== 'RS256') throw new JwtError('unsupported alg');
  const key = await importRsaPublicKey(publicKeyPem);
  if (!(await rsaSha256Verify(key, utf8(signingInput), signature))) throw new JwtError('bad signature');
  checkClaims(payload, o);
  return payload;
}
