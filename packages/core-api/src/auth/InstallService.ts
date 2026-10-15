import type { NamedRef } from '../rules/types.js';
import { getJson, setJson, type IUsageStore } from '../stores/IUsageStore.js';
import { PLATFORMS, USER_ROLES, type Platform } from '../types.js';
import { hmacSha256B64Url, randomId } from '../util/crypto.js';
import { HpsError } from '../util/errors.js';
import { decodeJwt, JwtError, signHs256, verifyHs256, verifyRs256, type JwtPayload } from './jwt.js';

/**
 * Anti-spoofing install registry.
 *
 * 1. First install of a tenant (`POST /v1/install`) mints a per-installation shared secret, returned
 *    exactly once. The shell stores it in a *secure* app setting (Zendesk `secure: true` parameter /
 *    Freshworks secure iparam) so agents' browsers never see it again.
 * 2. Every API call carries an HS256 JWT signed with that secret *by the platform proxy* (ZAF
 *    `client.request({ jwt, secure: true })`, FDK serverless). Tenant identity — and therefore the
 *    Pro entitlement — is taken from the verified token, never from the request body.
 * 3. Re-registering an existing tenant (e.g. a squatter claiming "zendesk:bigcorp" to borrow its
 *    Pro plan) requires a valid token of an existing installation or a platform-signed proof
 *    (Zendesk signed-URL RS256 JWT). Otherwise 409.
 * Secrets are derived (HMAC(master, tenant|installation|salt)) so a store leak alone yields nothing.
 */

export interface InstallationEntry {
  salt: string;
  createdAt: string;
  revokedAt: string | null;
  verifiedBy: 'first_install' | 'existing_token' | 'platform_proof';
  appVersion?: string;
}

export interface InstallRecord {
  tenant: string;
  platform: Platform;
  createdAt: string;
  installations: Record<string, InstallationEntry>;
}

export interface PrincipalUser {
  id: string;
  role: string;
  customRole?: string;
  name?: string;
  groups: NamedRef[];
}

export interface Principal {
  tenant: string;
  platform: Platform;
  installationId: string;
  user: PrincipalUser;
}

export type PlatformProofVerifier = (token: string, tenantSlug: string) => Promise<boolean>;

export interface InstallServiceOptions {
  masterSecret: string;
  audience?: string;
  maxTokenLifetimeSec?: number;
  platformProofs?: Partial<Record<Platform, PlatformProofVerifier>>;
  now?: () => number;
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PLATFORM_HOST: Partial<Record<Platform, string>> = {
  zendesk: '.zendesk.com',
  freshdesk: '.freshdesk.com',
  freshservice: '.freshservice.com',
  gorgias: '.gorgias.com',
};

export const AUDIENCE = 'helpdesk-power-suite';

/** "https://Acme.zendesk.com/agent" -> "acme"; custom Freshdesk domains are kept as full hosts. */
export function tenantSlug(platform: Platform, input: string): string {
  let host = input.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0] ?? '';
  host = host.replace(/:\d+$/, '');
  const suffix = PLATFORM_HOST[platform];
  if (suffix && host.endsWith(suffix)) host = host.slice(0, -suffix.length);
  if (!SLUG_RE.test(host)) throw new HpsError('invalid_request', `Invalid ${platform} tenant "${input}"`);
  return host;
}

export const tenantKey = (platform: Platform, input: string) => `${platform}:${tenantSlug(platform, input)}`;

const recKey = (tenant: string) => `install:${tenant}`;

export class InstallService {
  private readonly audience: string;
  constructor(
    private readonly store: IUsageStore,
    private readonly opts: InstallServiceOptions,
  ) {
    if (!opts.masterSecret || opts.masterSecret.length < 32) throw new Error('InstallService masterSecret must be >= 32 chars');
    this.audience = opts.audience ?? AUDIENCE;
  }

  private nowIso() {
    return new Date(this.opts.now?.() ?? Date.now()).toISOString();
  }

  private deriveSecret(tenant: string, installationId: string, salt: string) {
    return hmacSha256B64Url(this.opts.masterSecret, `install-secret|${tenant}|${installationId}|${salt}`);
  }

  async getRecord(tenant: string) {
    return getJson<InstallRecord>(this.store, recKey(tenant));
  }

  async register(
    input: { platform: Platform; tenant: string; installationId?: string; appVersion?: string },
    proof: { bearerToken?: string; platformToken?: string } = {},
  ): Promise<{ tenant: string; installationId: string; sharedSecret: string; created: boolean; verifiedBy: InstallationEntry['verifiedBy'] }> {
    if (!PLATFORMS.includes(input.platform) || input.platform === 'generic') throw new HpsError('invalid_request', 'Unsupported platform');
    const slug = tenantSlug(input.platform, input.tenant);
    const tenant = `${input.platform}:${slug}`;
    const installationId = (input.installationId ?? randomId(9)).slice(0, 64);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(installationId)) throw new HpsError('invalid_request', 'Invalid installationId');

    const existing = await this.getRecord(tenant);
    let verifiedBy: InstallationEntry['verifiedBy'] = 'first_install';
    if (existing) {
      verifiedBy = await this.proveOwnership(existing, slug, proof);
    }
    const rec: InstallRecord = existing ?? { tenant, platform: input.platform, createdAt: this.nowIso(), installations: {} };
    const salt = randomId(16);
    rec.installations[installationId] = { salt, createdAt: this.nowIso(), revokedAt: null, verifiedBy, appVersion: input.appVersion };

    if (!existing) {
      // Race-safe first registration: only one concurrent caller may claim the tenant.
      const claimed = await this.store.setIfAbsent(`install-claim:${tenant}`, installationId);
      if (!claimed) throw new HpsError('conflict', 'Tenant is already registered. Re-install from an existing installation or contact support.');
    }
    await setJson(this.store, recKey(tenant), rec);
    return { tenant, installationId, sharedSecret: await this.deriveSecret(tenant, installationId, salt), created: !existing, verifiedBy };
  }

  private async proveOwnership(rec: InstallRecord, slug: string, proof: { bearerToken?: string; platformToken?: string }): Promise<InstallationEntry['verifiedBy']> {
    if (proof.bearerToken) {
      const p = await this.verify(proof.bearerToken).catch(() => null);
      if (p && p.tenant === rec.tenant && isAdmin(p.user.role)) return 'existing_token';
    }
    const verifier = this.opts.platformProofs?.[rec.platform];
    if (proof.platformToken && verifier && (await verifier(proof.platformToken, slug).catch(() => false))) return 'platform_proof';
    throw new HpsError(
      'conflict',
      'This helpdesk is already registered. Re-install from the existing app (admin) or provide a platform-signed proof.',
    );
  }

  /**
   * Uninstall: revokes the installation. When no active installation remains the tenant record and
   * claim are released so a later fresh install can register again. Entitlements are keyed by
   * tenant and survive (a Pro customer who reinstalls keeps Pro).
   */
  async uninstall(tenant: string, installationId: string): Promise<{ released: boolean }> {
    await this.revoke(tenant, installationId);
    const rec = await this.getRecord(tenant);
    const active = Object.values(rec?.installations ?? {}).some((i) => !i.revokedAt);
    if (!active) {
      await this.store.del(recKey(tenant));
      await this.store.del(`install-claim:${tenant}`);
    }
    return { released: !active };
  }

  async revoke(tenant: string, installationId: string): Promise<void> {
    const rec = await this.getRecord(tenant);
    const inst = rec?.installations[installationId];
    if (!rec || !inst) throw new HpsError('not_found', 'Installation not found');
    inst.revokedAt = this.nowIso();
    await setJson(this.store, recKey(tenant), rec);
  }

  /** Verifies a shell request token and returns the authenticated principal. */
  async verify(token: string): Promise<Principal> {
    let claims: JwtPayload;
    try {
      claims = decodeJwt(token).payload;
    } catch {
      throw new HpsError('unauthorized', 'Malformed token');
    }
    const tenant = typeof claims.sub === 'string' ? claims.sub : '';
    const iid = typeof claims.iid === 'string' ? claims.iid : '';
    const rec = tenant ? await this.getRecord(tenant) : null;
    const inst = rec?.installations[iid];
    if (!rec || !inst) throw new HpsError('unauthorized', 'Unknown installation');
    if (inst.revokedAt) throw new HpsError('unauthorized', 'Installation revoked');
    const secret = await this.deriveSecret(tenant, iid, inst.salt);
    let verified: JwtPayload;
    try {
      verified = await verifyHs256(token, secret, {
        audience: this.audience,
        maxLifetimeSec: this.opts.maxTokenLifetimeSec ?? 3600,
        nowSec: Math.floor((this.opts.now?.() ?? Date.now()) / 1000),
      });
    } catch (e) {
      throw new HpsError('unauthorized', `Invalid token: ${e instanceof JwtError ? e.message : 'verification failed'}`);
    }
    if (typeof verified.jti === 'string' && verified.jti) {
      const ttl = Math.max(60, (verified.exp ?? 0) - Math.floor((this.opts.now?.() ?? Date.now()) / 1000) + 120);
      const fresh = await this.store.setIfAbsent(`jti:${tenant}:${verified.jti}`, '1', { ttlSeconds: ttl });
      if (!fresh) throw new HpsError('unauthorized', 'Token replayed');
    }
    return { tenant, platform: rec.platform, installationId: iid, user: sanitizeUser(verified.usr) };
  }

  /** Mints a token the same way the platform proxies do (used by tests, CLI adapters and serverless shells). */
  async issueToken(sharedSecret: string, tenant: string, installationId: string, user: PrincipalUser, ttlSec = 300): Promise<string> {
    const now = Math.floor((this.opts.now?.() ?? Date.now()) / 1000);
    return signHs256({ iss: 'hps-shell', aud: this.audience, sub: tenant, iid: installationId, iat: now, exp: now + ttlSec, jti: randomId(12), usr: user }, sharedSecret);
  }
}

const isAdmin = (role: string) => role === 'admin';

function sanitizeUser(raw: unknown): PrincipalUser {
  const u = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const roleRaw = String(u.role ?? 'agent').toLowerCase().replace(/[-\s]/g, '_');
  const role = (USER_ROLES as readonly string[]).includes(roleRaw) ? roleRaw : 'agent';
  const groups = Array.isArray(u.groups)
    ? (u.groups as unknown[]).slice(0, 500).flatMap((g): NamedRef[] => {
        if (typeof g === 'string' || typeof g === 'number') return [{ id: String(g), name: String(g) }];
        if (g && typeof g === 'object') {
          const o = g as Record<string, unknown>;
          const name = o.name ?? o.id;
          if (name === undefined) return [];
          return [{ ...(o.id !== undefined ? { id: String(o.id) } : {}), name: String(name).slice(0, 200) }];
        }
        return [];
      })
    : [];
  return {
    id: String(u.id ?? 'unknown').slice(0, 100),
    role,
    customRole: typeof u.customRole === 'string' ? u.customRole.slice(0, 200) : undefined,
    name: typeof u.name === 'string' ? u.name.slice(0, 200) : undefined,
    groups,
  };
}

/**
 * Zendesk signed-URL proof: Zendesk POSTs an RS256 JWT (signed with the app's private key) when a
 * location uses `signedUrls: true`. We check the signature against the app public key and that the
 * token was issued for the claimed subdomain.
 */
export function zendeskSignedUrlVerifier(publicKeyPem: string): PlatformProofVerifier {
  return async (token, slug) => {
    const p = await verifyRs256(token, publicKeyPem, { maxLifetimeSec: 86_400 });
    const iss = String(p.iss ?? '').toLowerCase();
    const ctx = (p.context ?? {}) as Record<string, any>;
    const sub = String(ctx.account?.subdomain ?? '').toLowerCase();
    return sub === slug || iss === `${slug}.zendesk.com` || iss === `https://${slug}.zendesk.com`;
  };
}
