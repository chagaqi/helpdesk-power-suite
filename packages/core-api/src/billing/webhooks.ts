import type { IUsageStore } from '../stores/IUsageStore.js';
import { base64ToBytes, bytesToBase64, utf8 } from '../util/encoding.js';
import { hmacSha256, hmacSha256Hex, timingSafeEqual } from '../util/crypto.js';
import { HpsError } from '../util/errors.js';
import type { EntitlementService, GrantInput, SubscriptionStatus } from './EntitlementService.js';

const TOLERANCE_S = 300;

/**
 * Standard Webhooks verification (used by Polar.sh). Signed content: `${id}.${timestamp}.${body}`;
 * header `webhook-signature` holds space-separated `v1,<base64>` entries.
 * Secrets prefixed `whsec_` are base64; Polar's raw secrets are used as UTF-8 bytes (as its SDK does).
 */
export async function verifyStandardWebhook(
  secret: string,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null },
  body: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<void> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) throw new HpsError('unauthorized', 'Missing webhook signature headers');
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSec - ts) > TOLERANCE_S) throw new HpsError('unauthorized', 'Webhook timestamp outside tolerance');
  const key = secret.startsWith('whsec_') ? base64ToBytes(secret.slice(6)) : utf8(secret);
  const expected = bytesToBase64(await hmacSha256(key, `${id}.${timestamp}.${body}`));
  const ok = signature
    .split(' ')
    .map((p) => p.split(','))
    .some(([v, sig]) => v === 'v1' && !!sig && timingSafeEqual(sig, expected));
  if (!ok) throw new HpsError('unauthorized', 'Invalid webhook signature');
}

/** Stripe-Signature: `t=<unix>,v1=<hex>[,v1=...]`, HMAC-SHA256 over `${t}.${body}`. */
export async function verifyStripeSignature(secret: string, header: string | null | undefined, body: string, nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
  if (!header) throw new HpsError('unauthorized', 'Missing Stripe-Signature header');
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!t || !sigs.length) throw new HpsError('unauthorized', 'Malformed Stripe-Signature header');
  if (Math.abs(nowSec - Number(t)) > TOLERANCE_S) throw new HpsError('unauthorized', 'Stripe webhook timestamp outside tolerance');
  const expected = await hmacSha256Hex(secret, `${t}.${body}`);
  if (!sigs.some((s) => timingSafeEqual(s, expected))) throw new HpsError('unauthorized', 'Invalid Stripe signature');
}

/** Generic marketplace / internal webhook: `X-HPS-Signature: sha256=<hex>` over the raw body. */
export async function verifyHmacHeader(secret: string, header: string | null | undefined, body: string): Promise<void> {
  if (!header) throw new HpsError('unauthorized', 'Missing X-HPS-Signature header');
  const sig = header.startsWith('sha256=') ? header.slice(7) : header;
  if (!timingSafeEqual(sig, await hmacSha256Hex(secret, body))) throw new HpsError('unauthorized', 'Invalid signature');
}

type Json = Record<string, any>;

const TENANT_RE = /^(zendesk|freshdesk|freshservice|gorgias|intercom|generic):[a-z0-9][a-z0-9._-]{0,127}$/;
const validTenant = (t: unknown): string | null => (typeof t === 'string' && TENANT_RE.test(t) ? t : null);

const iso = (v: unknown): string | null => {
  if (typeof v === 'number') return new Date(v * 1000).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
};

export interface WebhookOutcome {
  handled: boolean;
  duplicate?: boolean;
  tenant?: string;
  plan?: string;
  reason?: string;
}

/** Translates verified Polar / Stripe / marketplace events into entitlement grants (idempotent). */
export class BillingWebhookHandler {
  constructor(
    private readonly store: IUsageStore,
    private readonly entitlements: EntitlementService,
  ) {}

  private async once(provider: string, eventId: string): Promise<boolean> {
    return this.store.setIfAbsent(`whk:${provider}:${eventId}`, '1', { ttlSeconds: 7 * 86_400 });
  }

  async handlePolar(eventId: string, event: Json): Promise<WebhookOutcome> {
    if (!(await this.once('polar', eventId))) return { handled: false, duplicate: true };
    const type: string = event.type ?? '';
    if (!type.startsWith('subscription.')) return { handled: false, reason: `ignored ${type}` };
    const sub: Json = event.data ?? {};
    const tenant = validTenant(sub.metadata?.tenant_key ?? sub.customer?.external_id ?? sub.customer?.metadata?.tenant_key);
    if (!tenant) return { handled: false, reason: 'missing tenant_key metadata' };
    const periodEnd = iso(sub.current_period_end ?? sub.ends_at);
    let status: SubscriptionStatus;
    if (type === 'subscription.revoked' || sub.status === 'revoked') status = 'revoked';
    else if (sub.status === 'active' || sub.status === 'trialing') status = sub.cancel_at_period_end ? 'canceled' : (sub.status as SubscriptionStatus);
    else if (sub.status === 'canceled') status = 'canceled';
    else if (sub.status === 'past_due') status = 'past_due';
    else status = 'revoked'; // incomplete / unpaid / incomplete_expired
    const grant: GrantInput = {
      plan: status === 'revoked' ? 'free' : 'pro',
      status,
      source: 'polar',
      currentPeriodEnd: periodEnd,
      externalId: sub.id ?? null,
      eventAt: iso(sub.modified_at ?? event.timestamp) ?? undefined,
    };
    const ent = await this.entitlements.grant(tenant, grant);
    return { handled: true, tenant, plan: ent.effectivePlan };
  }

  async handleStripe(event: Json): Promise<WebhookOutcome> {
    if (!event.id || !(await this.once('stripe', event.id))) return { handled: false, duplicate: true };
    const type: string = event.type ?? '';
    const obj: Json = event.data?.object ?? {};
    const eventAt = iso(event.created) ?? undefined;

    if (type === 'checkout.session.completed') {
      const tenant = validTenant(obj.metadata?.tenant_key ?? obj.client_reference_id);
      if (!tenant) return { handled: false, reason: 'missing tenant_key metadata' };
      if (obj.subscription) await this.store.set(`stripe:sub:${obj.subscription}`, tenant);
      if (obj.payment_status && obj.payment_status !== 'paid' && obj.payment_status !== 'no_payment_required') {
        return { handled: false, tenant, reason: 'payment pending' };
      }
      // Period end arrives with customer.subscription.*; provisional 35-day window until then.
      const provisional = new Date(Date.parse(eventAt ?? new Date().toISOString()) + 35 * 86_400_000).toISOString();
      const ent = await this.entitlements.grant(tenant, { plan: 'pro', status: 'active', source: 'stripe', currentPeriodEnd: provisional, externalId: obj.subscription ?? null, eventAt });
      return { handled: true, tenant, plan: ent.effectivePlan };
    }

    if (type.startsWith('customer.subscription.')) {
      const tenant = validTenant(obj.metadata?.tenant_key) ?? validTenant(await this.store.get(`stripe:sub:${obj.id}`));
      if (!tenant) return { handled: false, reason: 'unknown subscription' };
      const periodEnd = iso(obj.current_period_end ?? obj.items?.data?.[0]?.current_period_end);
      let status: SubscriptionStatus;
      if (type === 'customer.subscription.deleted' || obj.status === 'canceled') status = 'revoked';
      else if (obj.status === 'active' || obj.status === 'trialing') status = obj.cancel_at_period_end ? 'canceled' : obj.status;
      else if (obj.status === 'past_due') status = 'past_due';
      else status = 'revoked';
      const ent = await this.entitlements.grant(tenant, {
        plan: status === 'revoked' ? 'free' : 'pro',
        status,
        source: 'stripe',
        currentPeriodEnd: periodEnd,
        externalId: obj.id ?? null,
        eventAt,
      });
      return { handled: true, tenant, plan: ent.effectivePlan };
    }
    return { handled: false, reason: `ignored ${type}` };
  }

  /** Native marketplace billing relay (Zendesk / Freshworks app events forwarded by our relay). */
  async handleMarketplace(event: Json): Promise<WebhookOutcome> {
    if (!event.id || !(await this.once('marketplace', String(event.id)))) return { handled: false, duplicate: true };
    const tenant = validTenant(event.tenant_key);
    if (!tenant) return { handled: false, reason: 'invalid tenant_key' };
    const active = event.status === 'active' || event.status === 'trialing';
    const ent = await this.entitlements.grant(tenant, {
      plan: active && event.plan === 'pro' ? 'pro' : 'free',
      status: active ? event.status : 'revoked',
      source: 'marketplace',
      currentPeriodEnd: iso(event.current_period_end),
      externalId: event.subscription_id ?? null,
      eventAt: iso(event.occurred_at) ?? undefined,
    });
    return { handled: true, tenant, plan: ent.effectivePlan };
  }
}
