import { HpsError } from '../util/errors.js';

export interface CheckoutConfig {
  provider: 'polar' | 'stripe';
  polar?: { accessToken: string; productId: string; apiBase?: string };
  stripe?: { secretKey: string; priceId: string };
  successUrl: string;
  cancelUrl?: string;
}

/** Creates a hosted checkout whose subscription carries `tenant_key` metadata (read back by webhooks). */
export async function createCheckout(cfg: CheckoutConfig, tenant: string, fetchImpl: typeof fetch = fetch): Promise<{ url: string; provider: string }> {
  if (cfg.provider === 'polar') {
    if (!cfg.polar) throw new HpsError('internal', 'Polar checkout is not configured');
    const res = await fetchImpl(`${cfg.polar.apiBase ?? 'https://api.polar.sh'}/v1/checkouts/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.polar.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        products: [cfg.polar.productId],
        metadata: { tenant_key: tenant },
        customer_metadata: { tenant_key: tenant },
        success_url: cfg.successUrl,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { url?: string; detail?: unknown };
    if (!res.ok || !body.url) throw new HpsError('internal', `Polar checkout failed (${res.status})`, body.detail);
    return { url: body.url, provider: 'polar' };
  }
  if (!cfg.stripe) throw new HpsError('internal', 'Stripe checkout is not configured');
  const form = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': cfg.stripe.priceId,
    'line_items[0][quantity]': '1',
    success_url: cfg.successUrl,
    cancel_url: cfg.cancelUrl ?? cfg.successUrl,
    'metadata[tenant_key]': tenant,
    'subscription_data[metadata][tenant_key]': tenant,
  });
  const res = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.stripe.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: { message?: string } };
  if (!res.ok || !body.url) throw new HpsError('internal', `Stripe checkout failed (${res.status}): ${body.error?.message ?? 'unknown'}`);
  return { url: body.url, provider: 'stripe' };
}
