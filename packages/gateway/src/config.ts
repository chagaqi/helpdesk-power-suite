import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === '1' || v === 'true' || v === 'yes');
const int = (def: number) => z.coerce.number().int().positive().default(def);

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: int(8787),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_BASE_URL: z.string().url().optional(),
  HPS_MASTER_SECRET: z.string().min(32, 'HPS_MASTER_SECRET must be at least 32 characters').optional(),
  HPS_LINK_SECRET: z.string().min(32).optional(),
  REDIS_URL: z.string().optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  REDIS_PREFIX: z.string().default('hps:'),
  POLAR_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  MARKETPLACE_WEBHOOK_SECRET: z.string().optional(),
  BILLING_PROVIDER: z.enum(['polar', 'stripe']).optional(),
  POLAR_ACCESS_TOKEN: z.string().optional(),
  POLAR_PRODUCT_ID: z.string().optional(),
  POLAR_API_BASE: z.string().url().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PRICE_ID: z.string().optional(),
  CHECKOUT_SUCCESS_URL: z.string().url().optional(),
  UPGRADE_URL: z.string().url().optional(),
  ZENDESK_APP_PUBLIC_KEY: z.string().optional(),
  TRUST_PROXY: bool,
  CORS_ORIGINS: z.string().optional(),
  DOWNLOAD_TTL_SECONDS: int(900),
  MAX_EXPORT_BODY_MB: int(25),
  PLAYGROUND_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== '0' && v !== 'false'),
  PLAYGROUND_RATE_LIMIT: int(30),
  PLAYGROUND_RATE_WINDOW_SECONDS: int(3600),
  PLAYGROUND_MAX_RECORDS: int(5000),
  GORGIAS_WIDGET_SECRET: z.string().optional(),
  GORGIAS_ACCOUNTS: z.string().optional(),
  INTERCOM_CLIENT_SECRET: z.string().optional(),
  INTERCOM_ACCESS_TOKENS: z.string().optional(),
});

export type GatewayEnv = z.infer<typeof envSchema>;

export interface GatewayConfig {
  env: GatewayEnv;
  production: boolean;
  publicBaseUrl: string;
  masterSecret: string;
  linkSecret: string;
  warnings: string[];
}

/** Parses and validates process env. In production the secrets are mandatory. */
export function loadConfig(raw: Record<string, string | undefined> = process.env): GatewayConfig {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => ` - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const env = parsed.data;
  const production = env.NODE_ENV === 'production';
  const warnings: string[] = [];
  if (production && !env.HPS_MASTER_SECRET) throw new Error('HPS_MASTER_SECRET is required in production (derives every install secret).');
  if (production && !env.REDIS_URL && !env.UPSTASH_REDIS_REST_URL) warnings.push('No REDIS_URL / UPSTASH_REDIS_REST_URL: using the in-memory store (state is lost on restart).');
  if (env.UPSTASH_REDIS_REST_URL && !env.UPSTASH_REDIS_REST_TOKEN) throw new Error('UPSTASH_REDIS_REST_TOKEN is required with UPSTASH_REDIS_REST_URL');
  if (env.BILLING_PROVIDER === 'polar' && !(env.POLAR_ACCESS_TOKEN && env.POLAR_PRODUCT_ID)) throw new Error('BILLING_PROVIDER=polar needs POLAR_ACCESS_TOKEN and POLAR_PRODUCT_ID');
  if (env.BILLING_PROVIDER === 'stripe' && !(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID)) throw new Error('BILLING_PROVIDER=stripe needs STRIPE_SECRET_KEY and STRIPE_PRICE_ID');
  const masterSecret = env.HPS_MASTER_SECRET ?? randomBytes(32).toString('base64url');
  if (!env.HPS_MASTER_SECRET) warnings.push('HPS_MASTER_SECRET not set: generated an ephemeral one (installs will not survive a restart).');
  return {
    env,
    production,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`).replace(/\/$/, ''),
    masterSecret,
    linkSecret: env.HPS_LINK_SECRET ?? `${masterSecret}:download-links`,
    warnings,
  };
}

/** "acme=apikey@me.com:KEY,globex=..." style maps for companion adapters. */
export function parseKeyMap(v: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i > 0) m.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  return m;
}
