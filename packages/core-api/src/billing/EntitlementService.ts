import { getJson, setJson, type IUsageStore } from '../stores/IUsageStore.js';
import { HpsError } from '../util/errors.js';
import { ABSOLUTE_MAX_EXPORT_ROWS, PLANS, type PlanId, type PlanLimits } from './plans.js';

export type BillingSource = 'polar' | 'stripe' | 'marketplace' | 'manual';
export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'revoked' | 'none';

export interface EntitlementRecord {
  plan: PlanId;
  status: SubscriptionStatus;
  source: BillingSource | null;
  /** ISO time the paid period ends (Pro stays effective until then, plus grace). */
  currentPeriodEnd: string | null;
  externalId: string | null;
  updatedAt: string;
  /** Monotonic event time used to ignore out-of-order webhooks. */
  eventAt?: string;
}

export interface Entitlement extends EntitlementRecord {
  tenant: string;
  effectivePlan: PlanId;
  limits: PlanLimits;
}

export interface GrantInput {
  plan: PlanId;
  status: SubscriptionStatus;
  source: BillingSource;
  currentPeriodEnd?: string | null;
  externalId?: string | null;
  eventAt?: string;
}

const key = (tenant: string) => `ent:${tenant}`;
const usageKey = (tenant: string, d: Date) => `usage:${tenant}:${d.toISOString().slice(0, 7)}`;

/**
 * Free: 250-row exports, 2 field rules. Pro ($19/mo via Polar.sh, Stripe or marketplace billing):
 * unlimited cursor exports (up to the 1M-row technical ceiling) and unlimited rules.
 */
export class EntitlementService {
  constructor(
    private readonly store: IUsageStore,
    private readonly opts: { graceDays?: number; now?: () => Date; upgradeUrl?: string } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  get upgradeUrl() {
    return this.opts.upgradeUrl ?? 'https://helpdeskpowersuite.com/pricing';
  }

  async get(tenant: string): Promise<Entitlement> {
    const rec = (await getJson<EntitlementRecord>(this.store, key(tenant))) ?? {
      plan: 'free',
      status: 'none',
      source: null,
      currentPeriodEnd: null,
      externalId: null,
      updatedAt: new Date(0).toISOString(),
    };
    const effectivePlan = this.effective(rec);
    return { ...rec, tenant, effectivePlan, limits: PLANS[effectivePlan].limits };
  }

  private effective(rec: EntitlementRecord): PlanId {
    if (rec.plan !== 'pro') return 'free';
    if (rec.status === 'revoked' || rec.status === 'none') return 'free';
    if (rec.currentPeriodEnd) {
      const graceMs = (this.opts.graceDays ?? 3) * 86_400_000;
      if (Date.parse(rec.currentPeriodEnd) + graceMs < this.now().getTime()) return 'free';
    } else if (rec.status === 'canceled') {
      return 'free';
    }
    return 'pro';
  }

  /** Applies a billing state change. Out-of-order events (older eventAt) are ignored. */
  async grant(tenant: string, input: GrantInput): Promise<Entitlement> {
    const prev = await getJson<EntitlementRecord>(this.store, key(tenant));
    if (prev?.eventAt && input.eventAt && Date.parse(input.eventAt) < Date.parse(prev.eventAt)) return this.get(tenant);
    const rec: EntitlementRecord = {
      plan: input.plan,
      status: input.status,
      source: input.source,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      externalId: input.externalId ?? prev?.externalId ?? null,
      updatedAt: this.now().toISOString(),
      eventAt: input.eventAt ?? this.now().toISOString(),
    };
    await setJson(this.store, key(tenant), rec);
    return this.get(tenant);
  }

  /** Max rows this tenant may export in one job. */
  async exportRowLimit(tenant: string): Promise<number> {
    const e = await this.get(tenant);
    return e.limits.maxExportRows ?? ABSOLUTE_MAX_EXPORT_ROWS;
  }

  async assertCanCreateRule(tenant: string, existingRules: number): Promise<void> {
    const e = await this.get(tenant);
    const cap = e.limits.maxFieldRules;
    if (cap !== null && existingRules >= cap) {
      throw new HpsError('plan_limit', `The ${PLANS[e.effectivePlan].name} plan includes ${cap} field rules. Upgrade to Pro for unlimited role/group rules.`, {
        limit: cap,
        plan: e.effectivePlan,
        upgradeUrl: this.upgradeUrl,
      });
    }
  }

  async assertSheets(tenant: string, sheets: number): Promise<void> {
    const e = await this.get(tenant);
    if (sheets > e.limits.maxWorkbookSheets) {
      throw new HpsError('plan_limit', `Multi-tab workbooks (${sheets} tabs) require Pro.`, { limit: e.limits.maxWorkbookSheets, upgradeUrl: this.upgradeUrl });
    }
  }

  async recordExport(tenant: string, rows: number): Promise<number> {
    return this.store.incr(usageKey(tenant, this.now()), rows, { ttlSeconds: 400 * 86_400 });
  }

  async usageThisMonth(tenant: string): Promise<number> {
    return Number((await this.store.get(usageKey(tenant, this.now()))) ?? 0);
  }
}
