import { describe, expect, it } from 'vitest';
import { EntitlementService } from '../src/billing/EntitlementService.js';
import { BillingWebhookHandler, verifyHmacHeader, verifyStandardWebhook, verifyStripeSignature } from '../src/billing/webhooks.js';
import { createCheckout } from '../src/billing/checkout.js';
import { InMemoryUsageStore } from '../src/stores/InMemoryUsageStore.js';
import { bytesToBase64, utf8 } from '../src/util/encoding.js';
import { hmacSha256, hmacSha256Hex } from '../src/util/crypto.js';

const now = Math.floor(Date.now() / 1000);

describe('EntitlementService', () => {
  it('defaults to free (250 rows / 2 rules) and unlocks Pro', async () => {
    const ent = new EntitlementService(new InMemoryUsageStore());
    expect(await ent.exportRowLimit('zendesk:a')).toBe(250);
    await ent.assertCanCreateRule('zendesk:a', 1);
    await expect(ent.assertCanCreateRule('zendesk:a', 2)).rejects.toMatchObject({ code: 'plan_limit' });
    await ent.grant('zendesk:a', { plan: 'pro', status: 'active', source: 'stripe', currentPeriodEnd: new Date(Date.now() + 86_400_000).toISOString() });
    expect(await ent.exportRowLimit('zendesk:a')).toBe(1_000_000);
    await ent.assertCanCreateRule('zendesk:a', 500);
  });

  it('expires Pro after period end + grace, honours cancel-at-period-end and ignores out-of-order events', async () => {
    let t = Date.parse('2025-01-10T00:00:00Z');
    const ent = new EntitlementService(new InMemoryUsageStore(), { now: () => new Date(t), graceDays: 3 });
    await ent.grant('x:y', { plan: 'pro', status: 'canceled', source: 'polar', currentPeriodEnd: '2025-01-20T00:00:00Z', eventAt: '2025-01-10T00:00:00Z' });
    expect((await ent.get('x:y')).effectivePlan).toBe('pro');
    t = Date.parse('2025-01-22T00:00:00Z');
    expect((await ent.get('x:y')).effectivePlan).toBe('pro'); // grace
    t = Date.parse('2025-01-24T00:00:00Z');
    expect((await ent.get('x:y')).effectivePlan).toBe('free');
    await ent.grant('x:y', { plan: 'pro', status: 'active', source: 'polar', currentPeriodEnd: '2025-02-24T00:00:00Z', eventAt: '2025-01-23T00:00:00Z' });
    await ent.grant('x:y', { plan: 'free', status: 'revoked', source: 'polar', eventAt: '2025-01-01T00:00:00Z' }); // stale
    expect((await ent.get('x:y')).effectivePlan).toBe('pro');
  });

  it('meters monthly export rows', async () => {
    const ent = new EntitlementService(new InMemoryUsageStore());
    await ent.recordExport('t:a', 100);
    await ent.recordExport('t:a', 50);
    expect(await ent.usageThisMonth('t:a')).toBe(150);
  });
});

describe('webhook signatures', () => {
  it('Standard Webhooks (Polar): valid, tampered, stale, whsec_ secrets', async () => {
    const body = JSON.stringify({ type: 'subscription.active' });
    const sign = async (key: Uint8Array, id: string, ts: number) => `v1,${bytesToBase64(await hmacSha256(key, `${id}.${ts}.${body}`))}`;
    const raw = 'polar_whs_secret_value';
    await verifyStandardWebhook(raw, { id: 'msg_1', timestamp: String(now), signature: `v1,bogus ${await sign(utf8(raw), 'msg_1', now)}` }, body);
    const b64 = bytesToBase64(utf8('0123456789abcdef0123456789abcdef'));
    await verifyStandardWebhook(`whsec_${b64}`, { id: 'm', timestamp: String(now), signature: await sign(utf8('0123456789abcdef0123456789abcdef'), 'm', now) }, body);
    await expect(verifyStandardWebhook(raw, { id: 'msg_1', timestamp: String(now), signature: await sign(utf8(raw), 'msg_1', now) }, body + ' ')).rejects.toThrow(/Invalid/);
    await expect(verifyStandardWebhook(raw, { id: 'msg_1', timestamp: String(now - 3600), signature: await sign(utf8(raw), 'msg_1', now - 3600) }, body)).rejects.toThrow(/tolerance/);
    await expect(verifyStandardWebhook(raw, { id: null, timestamp: null, signature: null }, body)).rejects.toThrow(/Missing/);
  });

  it('Stripe: t=,v1= scheme', async () => {
    const body = '{"id":"evt_1"}';
    const sig = await hmacSha256Hex('whsec_stripe', `${now}.${body}`);
    await verifyStripeSignature('whsec_stripe', `t=${now},v1=deadbeef,v1=${sig}`, body);
    await expect(verifyStripeSignature('whsec_stripe', `t=${now},v1=${sig}`, body.replace('1', '2'))).rejects.toThrow();
    await expect(verifyStripeSignature('whsec_stripe', `t=${now - 1000},v1=${await hmacSha256Hex('whsec_stripe', `${now - 1000}.${body}`)}`, body)).rejects.toThrow(/tolerance/);
  });

  it('Marketplace HMAC header', async () => {
    const body = '{"a":1}';
    await verifyHmacHeader('s3cret', `sha256=${await hmacSha256Hex('s3cret', body)}`, body);
    await expect(verifyHmacHeader('s3cret', 'sha256=00', body)).rejects.toThrow();
  });
});

describe('BillingWebhookHandler', () => {
  const setup = () => {
    const store = new InMemoryUsageStore();
    const ent = new EntitlementService(store);
    return { ent, h: new BillingWebhookHandler(store, ent) };
  };
  const future = Math.floor(Date.now() / 1000) + 30 * 86400;

  it('Polar subscription lifecycle (active -> revoked) and idempotency', async () => {
    const { ent, h } = setup();
    const ev = { type: 'subscription.active', data: { id: 'sub_1', status: 'active', current_period_end: new Date(future * 1000).toISOString(), metadata: { tenant_key: 'zendesk:acme' } } };
    expect(await h.handlePolar('msg_1', ev)).toMatchObject({ handled: true, tenant: 'zendesk:acme', plan: 'pro' });
    expect(await h.handlePolar('msg_1', ev)).toMatchObject({ duplicate: true });
    expect((await ent.get('zendesk:acme')).limits.maxExportRows).toBeNull();
    await h.handlePolar('msg_2', { type: 'subscription.revoked', data: { ...ev.data, status: 'revoked' } });
    expect((await ent.get('zendesk:acme')).effectivePlan).toBe('free');
    expect(await h.handlePolar('msg_3', { type: 'subscription.active', data: { status: 'active', metadata: { tenant_key: 'evil tenant!' } } })).toMatchObject({ handled: false });
  });

  it('Stripe checkout -> subscription mapping -> deletion', async () => {
    const { ent, h } = setup();
    await h.handleStripe({ id: 'evt_1', type: 'checkout.session.completed', created: now, data: { object: { subscription: 'sub_9', payment_status: 'paid', metadata: { tenant_key: 'freshdesk:globex' } } } });
    expect((await ent.get('freshdesk:globex')).effectivePlan).toBe('pro');
    await h.handleStripe({ id: 'evt_2', type: 'customer.subscription.updated', created: now + 1, data: { object: { id: 'sub_9', status: 'active', items: { data: [{ current_period_end: future }] } } } });
    expect((await ent.get('freshdesk:globex')).currentPeriodEnd).toBe(new Date(future * 1000).toISOString());
    await h.handleStripe({ id: 'evt_3', type: 'customer.subscription.deleted', created: now + 2, data: { object: { id: 'sub_9', status: 'canceled' } } });
    expect((await ent.get('freshdesk:globex')).effectivePlan).toBe('free');
  });

  it('marketplace relay', async () => {
    const { ent, h } = setup();
    await h.handleMarketplace({ id: 'm1', tenant_key: 'zendesk:initech', plan: 'pro', status: 'active', current_period_end: new Date(future * 1000).toISOString() });
    expect((await ent.get('zendesk:initech')).source).toBe('marketplace');
  });
});

describe('checkout', () => {
  it('creates Polar and Stripe checkouts carrying tenant_key metadata', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ url: 'https://checkout.example/x' }), { status: 200 });
    }) as unknown as typeof fetch;
    await createCheckout({ provider: 'polar', polar: { accessToken: 't', productId: 'p' }, successUrl: 'https://s' }, 'zendesk:acme', fetchMock);
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ products: ['p'], metadata: { tenant_key: 'zendesk:acme' } });
    await createCheckout({ provider: 'stripe', stripe: { secretKey: 'sk', priceId: 'price_1' }, successUrl: 'https://s' }, 'zendesk:acme', fetchMock);
    expect(String(calls[1]!.init.body)).toContain('subscription_data%5Bmetadata%5D%5Btenant_key%5D=zendesk%3Aacme');
  });
});
