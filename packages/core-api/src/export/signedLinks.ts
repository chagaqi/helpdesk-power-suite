import { hmacSha256B64Url, timingSafeEqual } from '../util/crypto.js';

/**
 * Signed, expiring download links: GET /v1/exports/:id?exp=<unix>&sig=<b64url(HMAC-SHA256(id.exp))>.
 * Links carry no bearer credentials, so they can be opened from a ZAF/FDK iframe via a plain <a>.
 */
export class LinkSigner {
  constructor(
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!secret || secret.length < 16) throw new Error('LinkSigner secret must be at least 16 characters');
  }

  async sign(id: string, ttlSeconds: number): Promise<{ exp: number; sig: string }> {
    const exp = Math.floor(this.now() / 1000) + ttlSeconds;
    return { exp, sig: await hmacSha256B64Url(this.secret, `export:${id}.${exp}`) };
  }

  async verify(id: string, exp: string | number | undefined, sig: string | undefined): Promise<'ok' | 'expired' | 'invalid'> {
    if (!sig || exp === undefined) return 'invalid';
    const expNum = typeof exp === 'number' ? exp : Number(exp);
    if (!Number.isInteger(expNum)) return 'invalid';
    const expected = await hmacSha256B64Url(this.secret, `export:${id}.${expNum}`);
    if (!timingSafeEqual(expected, sig)) return 'invalid';
    return expNum * 1000 < this.now() ? 'expired' : 'ok';
  }

  async url(baseUrl: string, id: string, ttlSeconds: number): Promise<{ url: string; expiresAt: string }> {
    const { exp, sig } = await this.sign(id, ttlSeconds);
    const u = `${baseUrl.replace(/\/$/, '')}/v1/exports/${encodeURIComponent(id)}?exp=${exp}&sig=${sig}`;
    return { url: u, expiresAt: new Date(exp * 1000).toISOString() };
  }
}
