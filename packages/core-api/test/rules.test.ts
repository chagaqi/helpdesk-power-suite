import { describe, expect, it } from 'vitest';
import { EntitlementService } from '../src/billing/EntitlementService.js';
import { diffEnforcement, evaluateRules, missingRequired, resolveField, type Catalog, type EvalContext } from '../src/rules/index.js';
import { ruleInputSchema } from '../src/rules/schemas.js';
import { VisualFieldRuleEngine } from '../src/rules/VisualFieldRuleEngine.js';
import { InMemoryUsageStore } from '../src/stores/InMemoryUsageStore.js';
import { HpsError } from '../src/util/errors.js';

const catalog: Catalog = {
  fields: [
    { id: 'priority', name: 'Priority', key: 'priority', system: true, type: 'system' },
    { id: 'subject', name: 'Subject', key: 'subject', system: true, type: 'system' },
    { id: '360001', name: 'Customer Tier', key: 'custom_field_360001', type: 'dropdown', options: [{ value: 'tier_enterprise', label: 'Enterprise' }, { value: 'tier_starter', label: 'Starter' }] },
    { id: '360002', name: 'Refund Amount', key: 'custom_field_360002', type: 'decimal' },
    { id: '360004', name: 'Internal Escalation Notes', key: 'custom_field_360004', type: 'textarea' },
    { id: '360006', name: 'Region', key: 'custom_field_360006', type: 'text' },
    { id: '360007', name: 'Region', key: 'custom_field_360007', type: 'text' },
  ],
  groups: [{ id: '300', name: 'Tier 1 Support' }, { id: '301', name: 'Tier 2 Escalations' }, { id: '302', name: 'Billing' }],
};

async function setup(plan: 'free' | 'pro' = 'pro') {
  const store = new InMemoryUsageStore();
  const ent = new EntitlementService(store);
  if (plan === 'pro') await ent.grant('zendesk:acme', { plan: 'pro', status: 'active', source: 'manual', currentPeriodEnd: '2999-01-01T00:00:00Z' });
  const engine = new VisualFieldRuleEngine(store, ent);
  await engine.syncCatalog('zendesk:acme', catalog);
  return engine;
}

const input = (o: unknown) => ruleInputSchema.parse(o);
const agent = (role: string, groups: string[] = [], ticket: EvalContext['ticket'] = {}): EvalContext => ({ user: { role, groups }, ticket });

describe('field resolution by human-readable name (never numeric IDs)', () => {
  it('resolves case/whitespace-insensitively and suggests close matches', () => {
    expect(resolveField(catalog, '  customer   TIER ')).toMatchObject({ ok: true, value: { id: '360001', name: 'Customer Tier' } });
    const miss = resolveField(catalog, 'Custmer Tier');
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.suggestions).toContain('Customer Tier');
  });
  it('flags ambiguous names instead of guessing', () => {
    const r = resolveField(catalog, 'Region');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/ambiguous/);
    expect(resolveField(catalog, { id: '360007' })).toMatchObject({ ok: true });
  });
});

describe('VisualFieldRuleEngine', () => {
  it('stores rules by name, resolves IDs, and keeps working after the field is renamed', async () => {
    const e = await setup();
    const rule = await e.create('zendesk:acme', input({ name: 'Hide notes from Tier 1', conditions: { groups: ['tier 1 support'] }, actions: [{ type: 'hide', field: 'Internal Escalation Notes' }] }));
    expect(rule.actions[0]!.field).toEqual({ id: '360004', name: 'Internal Escalation Notes' });
    expect(rule.conditions.groups).toEqual([{ id: '300', name: 'Tier 1 Support' }]);
    await e.syncCatalog('zendesk:acme', { ...catalog, fields: catalog.fields.map((f) => (f.id === '360004' ? { ...f, name: 'Escalation Notes (internal)' } : f)) });
    const ev = await e.evaluate('zendesk:acme', agent('agent', ['300']));
    expect(ev.fields['360004']).toMatchObject({ hidden: true, name: 'Escalation Notes (internal)', key: 'custom_field_360004' });
  });

  it('rejects unknown/ambiguous names with actionable problems', async () => {
    const e = await setup();
    await expect(e.create('zendesk:acme', input({ name: 'x', actions: [{ type: 'hide', field: 'Refnd Amount' }, { type: 'hide', field: 'Region' }], conditions: { groups: ['Tier 3'] } }))).rejects.toMatchObject({
      code: 'unresolved_reference',
      details: { problems: expect.arrayContaining([expect.objectContaining({ path: 'actions[0].field', suggestions: ['Refund Amount'] }), expect.objectContaining({ path: 'actions[1].field' }), expect.objectContaining({ path: 'conditions.groups[0]' })]) },
    });
  });

  it('per-group, per-role and per-tag rules with priority ordering (first match wins per dimension)', async () => {
    const e = await setup();
    const t = 'zendesk:acme';
    await e.create(t, input({ name: 'Tier 2 sees refunds', priority: 1, conditions: { groups: ['Tier 2 Escalations'] }, actions: [{ type: 'show', field: 'Refund Amount' }, { type: 'enable', field: 'Refund Amount' }] }));
    await e.create(t, input({ name: 'Hide refunds from everyone', priority: 10, actions: [{ type: 'hide', field: 'Refund Amount' }, { type: 'disable', field: 'Refund Amount' }] }));
    await e.create(t, input({ name: 'Light agents cannot touch priority', priority: 20, conditions: { roles: ['light_agent'] }, actions: [{ type: 'disable', field: 'Priority' }] }));
    await e.create(t, input({ name: 'VIP needs tier', priority: 30, conditions: { tags: { any: ['vip'] } }, actions: [{ type: 'require', field: 'Customer Tier' }, { type: 'set_value', field: 'Customer Tier', value: 'Enterprise' }] }));

    const tier1 = await e.evaluate(t, agent('agent', ['300']));
    expect(tier1.fields['360002']).toMatchObject({ hidden: true, disabled: true });
    const tier2 = await e.evaluate(t, agent('agent', ['301']));
    expect(tier2.fields['360002']).toMatchObject({ hidden: false, disabled: false });
    expect(tier2.fields['360002']!.decidedBy.visibility).toBe(tier2.matchedRuleIds[0]);

    expect((await e.evaluate(t, agent('light_agent'))).fields['priority']).toMatchObject({ disabled: true });
    expect((await e.evaluate(t, agent('agent'))).fields['priority']).toBeUndefined();

    const vip = await e.evaluate(t, agent('agent', [], { tags: ['VIP'] }));
    expect(vip.fields['360001']).toMatchObject({ required: true, setValue: true, value: 'tier_enterprise' });
    expect(missingRequired(vip, {}).map((f) => f.name)).toEqual(['Customer Tier']);
    expect(missingRequired(vip, { '360001': 'tier_starter' })).toEqual([]);

    // Reorder: put the global hide first -> Tier 2 now loses the field too.
    const rules = await e.list(t);
    await e.reorder(t, [rules[1]!.id]);
    expect((await e.evaluate(t, agent('agent', ['301']))).fields['360002']).toMatchObject({ hidden: true });
  });

  it('field-value conditions and new-ticket scoping', async () => {
    const e = await setup();
    const t = 'zendesk:acme';
    await e.create(t, input({ name: 'Refund needs amount', conditions: { fields: [{ field: 'Customer Tier', op: 'in', value: ['tier_starter'] }], isNewTicket: false }, actions: [{ type: 'require', field: 'Refund Amount' }] }));
    const ev = await e.evaluate(t, agent('agent', [], { fields: { '360001': 'tier_starter' } }));
    expect(ev.fields['360002']?.required).toBe(true);
    expect(ev.watchFieldIds).toEqual(['360001']);
    expect((await e.evaluate(t, agent('agent', [], { fields: { '360001': 'tier_enterprise' } }))).fields['360002']).toBeUndefined();
    expect((await e.evaluate(t, agent('agent', [], { isNew: true, fields: { '360001': 'tier_starter' } }))).fields['360002']).toBeUndefined();
  });

  it('validates set_value against dropdown options and protects Subject', async () => {
    const e = await setup();
    await expect(e.create('zendesk:acme', input({ name: 'x', actions: [{ type: 'set_value', field: 'Customer Tier', value: 'Platinum' }] }))).rejects.toThrow(/not an option/);
    await expect(e.create('zendesk:acme', input({ name: 'x', actions: [{ type: 'hide', field: 'Subject' }] }))).rejects.toThrow(/Subject/);
  });

  it('drops "required" on hidden fields with a warning', () => {
    const ev = evaluateRules(
      [
        { id: 'a', name: 'a', enabled: true, priority: 1, conditions: {}, actions: [{ type: 'hide', field: { id: 'f', name: 'F' } }, { type: 'require', field: { id: 'f', name: 'F' } }], createdAt: '1', updatedAt: '1' },
      ],
      agent('agent'),
    );
    expect(ev.fields.f).toMatchObject({ hidden: true, required: false });
    expect(ev.warnings[0]).toMatch(/hidden and required/);
  });
});

describe('entitlement gating for rules', () => {
  it('free tier allows 2 rules then returns plan_limit; compiled set caps active rules after downgrade', async () => {
    const store = new InMemoryUsageStore();
    const ent = new EntitlementService(store);
    const e = new VisualFieldRuleEngine(store, ent);
    await e.syncCatalog('zendesk:free', catalog);
    await e.create('zendesk:free', input({ name: 'r1', actions: [{ type: 'hide', field: 'Priority' }] }));
    await e.create('zendesk:free', input({ name: 'r2', actions: [{ type: 'hide', field: 'Refund Amount' }] }));
    const err = await e.create('zendesk:free', input({ name: 'r3', actions: [{ type: 'hide', field: 'Customer Tier' }] })).catch((x) => x);
    expect(err).toBeInstanceOf(HpsError);
    expect(err.code).toBe('plan_limit');
    expect(err.status).toBe(402);

    await ent.grant('zendesk:free', { plan: 'pro', status: 'active', source: 'polar', currentPeriodEnd: '2999-01-01T00:00:00Z' });
    await e.create('zendesk:free', input({ name: 'r3', actions: [{ type: 'hide', field: 'Customer Tier' }] }));
    expect((await e.compile('zendesk:free')).rules).toHaveLength(3);
    await ent.grant('zendesk:free', { plan: 'free', status: 'revoked', source: 'polar' });
    const compiled = await e.compile('zendesk:free');
    expect(compiled.rules).toHaveLength(2);
    expect(compiled.inactiveRuleIds).toHaveLength(1);
  });
});

describe('diffEnforcement (zero-flicker incremental UI ops)', () => {
  it('emits only changes and restores fields no longer targeted', () => {
    const f = (id: string, extra: object) => ({ fieldId: id, name: id, key: `custom_field_${id}`, decidedBy: {}, ...extra });
    const first = diffEnforcement({ fields: { a: f('a', { hidden: true }), b: f('b', { disabled: true }), c: f('c', { setValue: true, value: 'x' }) }, matchedRuleIds: [], watchFieldIds: [], warnings: [] });
    expect(first.ops).toEqual([
      { op: 'hide', fieldId: 'a', key: 'custom_field_a' },
      { op: 'disable', fieldId: 'b', key: 'custom_field_b' },
      { op: 'set', fieldId: 'c', key: 'custom_field_c', value: 'x' },
    ]);
    const second = diffEnforcement({ fields: { a: f('a', { hidden: true }), c: f('c', { setValue: true, value: 'x' }) }, matchedRuleIds: [], watchFieldIds: [], warnings: [] }, first.applied);
    expect(second.ops).toEqual([{ op: 'enable', fieldId: 'b', key: 'custom_field_b' }]);
  });
});
