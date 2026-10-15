import type { Context } from 'hono';
import { InstallService, type PlatformProofVerifier } from './auth/InstallService.js';
import { EntitlementService } from './billing/EntitlementService.js';
import { BillingWebhookHandler } from './billing/webhooks.js';
import { ExportSessionManager } from './export/ExportSessionManager.js';
import { LinkSigner } from './export/signedLinks.js';
import { createCoreApi, type CoreApiConfig, type CoreApiDeps } from './http/app.js';
import { VisualFieldRuleEngine } from './rules/VisualFieldRuleEngine.js';
import type { IUsageStore } from './stores/IUsageStore.js';
import { InMemoryUsageStore } from './stores/InMemoryUsageStore.js';
import { RateLimiter } from './util/rateLimit.js';
import type { Platform } from './types.js';

export * from './types.js';
export * from './export/index.js';
export * from './rules/index.js';
export { VisualFieldRuleEngine } from './rules/VisualFieldRuleEngine.js';
export { ruleInputSchema, catalogInputSchema, evalContextSchema, type RuleInput } from './rules/schemas.js';
export { ExportSessionManager } from './export/ExportSessionManager.js';
export { EntitlementService, type Entitlement, type GrantInput } from './billing/EntitlementService.js';
export { PLANS, ABSOLUTE_MAX_EXPORT_ROWS, type PlanId } from './billing/plans.js';
export { BillingWebhookHandler, verifyStandardWebhook, verifyStripeSignature, verifyHmacHeader } from './billing/webhooks.js';
export { createCheckout, type CheckoutConfig } from './billing/checkout.js';
export { InstallService, tenantKey, tenantSlug, zendeskSignedUrlVerifier, AUDIENCE, type Principal, type PrincipalUser } from './auth/InstallService.js';
export { signHs256, verifyHs256, verifyRs256, decodeJwt, JwtError } from './auth/jwt.js';
export type { IUsageStore } from './stores/IUsageStore.js';
export { getJson, setJson } from './stores/IUsageStore.js';
export { InMemoryUsageStore } from './stores/InMemoryUsageStore.js';
export { RedisUsageStore, UpstashRestClient, type RedisCommander } from './stores/RedisUsageStore.js';
export { RateLimiter } from './util/rateLimit.js';
export { HpsError } from './util/errors.js';
export { hmacSha256Hex, hmacSha256B64Url, randomId, sha256Hex, timingSafeEqual } from './util/crypto.js';
export { createCoreApi, type CoreApiConfig, type CoreApiDeps, type AppEnv } from './http/app.js';
export * as synthetic from './demo/synthetic.js';

export interface ServiceOptions {
  store?: IUsageStore;
  masterSecret: string;
  linkSecret?: string;
  config: CoreApiConfig;
  getClientIp?: (c: Context) => string;
  platformProofs?: Partial<Record<Platform, PlatformProofVerifier>>;
  now?: () => Date;
  fetch?: typeof fetch;
  logger?: CoreApiDeps['logger'];
  upgradeUrl?: string;
}

/** Wires every service with sensible defaults. Returns the deps (for tests / extra routes) and the Hono app. */
export function createServices(o: ServiceOptions) {
  const now = o.now ?? (() => new Date());
  const store = o.store ?? new InMemoryUsageStore(() => now().getTime());
  const entitlements = new EntitlementService(store, { now, upgradeUrl: o.upgradeUrl });
  const deps: CoreApiDeps = {
    store,
    entitlements,
    installs: new InstallService(store, { masterSecret: o.masterSecret, platformProofs: o.platformProofs, now: () => now().getTime() }),
    rules: new VisualFieldRuleEngine(store, entitlements, now),
    exports: new ExportSessionManager({ now: () => now().getTime() }),
    signer: new LinkSigner(o.linkSecret ?? `${o.masterSecret}:links`, () => now().getTime()),
    webhooks: new BillingWebhookHandler(store, entitlements),
    rateLimiter: new RateLimiter(store, () => now().getTime()),
    config: o.config,
    getClientIp: o.getClientIp ?? ((c) => c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'),
    fetch: o.fetch,
    logger: o.logger,
  };
  return { deps, app: createCoreApi(deps) };
}
