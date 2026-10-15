import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  createServices,
  InMemoryUsageStore,
  RedisUsageStore,
  UpstashRestClient,
  zendeskSignedUrlVerifier,
  type CheckoutConfig,
  type IUsageStore,
} from '@hps/core-api';
import { createGorgiasRoutes, GorgiasClient } from '@hps/shell-gorgias';
import { createIntercomCanvasRoutes, IntercomClient } from '@hps/shell-intercom';
import { parseKeyMap, type GatewayConfig } from './config.js';
import { createPlayground } from './playground.js';
import { RespClient } from './redis/RespClient.js';

export interface GatewayOptions {
  store?: IUsageStore;
  fetch?: typeof fetch;
  logger?: Pick<Console, 'error' | 'warn' | 'info'>;
  /** Remote address of the TCP peer (node adapter); used when TRUST_PROXY is off. */
  remoteAddress?: (c: Context) => string | undefined;
}

function createStore(cfg: GatewayConfig): { store: IUsageStore; kind: string; close?: () => Promise<void> } {
  const e = cfg.env;
  if (e.UPSTASH_REDIS_REST_URL && e.UPSTASH_REDIS_REST_TOKEN) {
    return { store: new RedisUsageStore(new UpstashRestClient(e.UPSTASH_REDIS_REST_URL, e.UPSTASH_REDIS_REST_TOKEN), e.REDIS_PREFIX), kind: 'upstash' };
  }
  if (e.REDIS_URL) {
    const client = new RespClient(e.REDIS_URL);
    return { store: new RedisUsageStore(client, e.REDIS_PREFIX), kind: 'redis', close: () => client.quit() };
  }
  return { store: new InMemoryUsageStore(), kind: 'memory' };
}

function checkoutConfig(cfg: GatewayConfig): CheckoutConfig | undefined {
  const e = cfg.env;
  if (!e.BILLING_PROVIDER) return undefined;
  const successUrl = e.CHECKOUT_SUCCESS_URL ?? `${cfg.publicBaseUrl}/billing/success`;
  return e.BILLING_PROVIDER === 'polar'
    ? { provider: 'polar', polar: { accessToken: e.POLAR_ACCESS_TOKEN!, productId: e.POLAR_PRODUCT_ID!, apiBase: e.POLAR_API_BASE }, successUrl }
    : { provider: 'stripe', stripe: { secretKey: e.STRIPE_SECRET_KEY!, priceId: e.STRIPE_PRICE_ID! }, successUrl };
}

/** Composes the whole deployable server as one Hono app. */
export function createGateway(cfg: GatewayConfig, o: GatewayOptions = {}) {
  const e = cfg.env;
  const storeInfo = o.store ? { store: o.store, kind: 'custom' as string, close: undefined } : createStore(cfg);
  const getClientIp = (c: Context) => {
    if (e.TRUST_PROXY) {
      const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip');
      if (fwd) return fwd;
    }
    return o.remoteAddress?.(c) ?? 'unknown';
  };
  const { app: core, deps } = createServices({
    store: storeInfo.store,
    masterSecret: cfg.masterSecret,
    linkSecret: cfg.linkSecret,
    getClientIp,
    fetch: o.fetch,
    logger: o.logger,
    upgradeUrl: e.UPGRADE_URL,
    platformProofs: e.ZENDESK_APP_PUBLIC_KEY ? { zendesk: zendeskSignedUrlVerifier(e.ZENDESK_APP_PUBLIC_KEY.replace(/\\n/g, '\n')) } : undefined,
    config: {
      publicBaseUrl: cfg.publicBaseUrl,
      polarWebhookSecret: e.POLAR_WEBHOOK_SECRET,
      stripeWebhookSecret: e.STRIPE_WEBHOOK_SECRET,
      marketplaceWebhookSecret: e.MARKETPLACE_WEBHOOK_SECRET,
      checkout: checkoutConfig(cfg),
      downloadTtlSec: e.DOWNLOAD_TTL_SECONDS,
      maxExportBodyBytes: e.MAX_EXPORT_BODY_MB * 1024 * 1024,
      corsOrigins: e.CORS_ORIGINS ? e.CORS_ORIGINS.split(',').map((s) => s.trim()) : '*',
    },
  });

  const app = new Hono();
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (cfg.production) c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  });

  const mounted: string[] = ['core'];
  if (e.GORGIAS_WIDGET_SECRET) {
    const accounts = parseKeyMap(e.GORGIAS_ACCOUNTS); // acme=ops@acme.com:APIKEY
    app.route('/', createGorgiasRoutes({
      rules: deps.rules,
      entitlements: deps.entitlements,
      store: deps.store,
      signer: deps.signer,
      publicBaseUrl: cfg.publicBaseUrl,
      widgetSecret: e.GORGIAS_WIDGET_SECRET,
      downloadTtlSec: e.DOWNLOAD_TTL_SECONDS,
      logger: o.logger,
      clientFactory: (account) => {
        const cred = accounts.get(account.toLowerCase());
        const i = cred?.lastIndexOf(':') ?? -1;
        return cred && i > 0 ? new GorgiasClient({ account, email: cred.slice(0, i), apiKey: cred.slice(i + 1), fetch: o.fetch }) : null;
      },
    }));
    mounted.push('gorgias');
  }
  if (e.INTERCOM_CLIENT_SECRET) {
    const tokens = parseKeyMap(e.INTERCOM_ACCESS_TOKENS); // workspace_id=token
    app.route('/', createIntercomCanvasRoutes({
      rules: deps.rules,
      entitlements: deps.entitlements,
      store: deps.store,
      signer: deps.signer,
      publicBaseUrl: cfg.publicBaseUrl,
      clientSecret: e.INTERCOM_CLIENT_SECRET,
      downloadTtlSec: e.DOWNLOAD_TTL_SECONDS,
      logger: o.logger,
      clientFactory: (ws) => {
        const token = tokens.get(ws.toLowerCase());
        return token ? new IntercomClient({ token, fetch: o.fetch }) : null;
      },
    }));
    mounted.push('intercom');
  }
  if (e.PLAYGROUND_ENABLED) {
    app.route('/', createPlayground(deps, { rateLimit: e.PLAYGROUND_RATE_LIMIT, rateWindowSec: e.PLAYGROUND_RATE_WINDOW_SECONDS, maxRecords: e.PLAYGROUND_MAX_RECORDS, downloadTtlSec: e.DOWNLOAD_TTL_SECONDS }));
    app.get('/', (c) => c.redirect('/playground'));
    mounted.push('playground');
  }
  app.route('/', core);
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404));

  return { app, deps, storeKind: storeInfo.kind, mounted, close: async () => storeInfo.close?.() };
}
