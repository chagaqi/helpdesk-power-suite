import { describe, expect, it } from 'vitest';
import { ruleInputSchema } from '@hps/core-api';
import type { CompiledRuleSet } from '@hps/core-api/rules';
import { HpsApiClient } from '../src/api.js';
import { RuleEnforcer, type FieldOps } from '../src/enforcer.js';
import { memoryStorage } from '../src/storage.js';
import { localHost } from './localHost.js';

function recorder() {
  const log: string[] = [];
  const ops: FieldOps = {
    hide: (k) => void log.push(`hide:${k}`),
    show: (k) => void log.push(`show:${k}`),
    disable: (k) => void log.push(`disable:${k}`),
    enable: (k) => void log.push(`enable:${k}`),
    setValue: (k, v) => void log.push(`set:${k}=${JSON.stringify(v)}`),
  };
  return { log, ops };
}

async function seed() {
  const ctx = await localHost({ pro: true });
  const t = ctx.reg.tenant;
  await ctx.deps.rules.syncCatalog(t, await ctx.host.ruleCatalog());
  await ctx.deps.rules.create(t, ruleInputSchema.parse({ name: 'Tier 1: hide refunds', conditions: { groups: ['Tier 1 Support'] }, actions: [{ type: 'hide', field: 'Refund Amount' }, { type: 'disable', field: 'Priority' }] }));
  await ctx.deps.rules.create(t, ruleInputSchema.parse({ name: 'Enterprise requires refund', conditions: { fields: [{ field: 'Customer Tier', op: 'eq', value: 'tier_enterprise' }] }, actions: [{ type: 'show', field: 'Refund Amount' }, { type: 'require', field: 'Refund Amount' }] }));
  return ctx;
}

describe('RuleEnforcer', () => {
  it('applies cached rules synchronously BEFORE the network revalidation resolves (zero flicker)', async () => {
    const ctx = await seed();
    const api = new HpsApiClient(ctx.host);
    const fresh = await api.rulesConfig();
    const storage = memoryStorage();
    storage.set('hps.rules.compiled.v1', JSON.stringify({ etag: fresh!.etag, compiled: fresh!.config.compiled }));
    const { log, ops } = recorder();
    let releaseFetch!: () => void;
    const gate = new Promise<void>((r) => (releaseFetch = r));
    const timeline: string[] = [];
    const enf = new RuleEnforcer({
      ops: { ...ops, hide: (k) => void (timeline.push('hide'), ops.hide(k)) },
      storage,
      user: { id: '7', role: 'agent', groups: [{ id: '300', name: 'Tier 1 Support' }] },
      readTicket: async () => ({ tags: [], fields: {} }),
      fetchRules: async (etag) => {
        await gate;
        timeline.push('fetched');
        const r = await api.rulesConfig(etag);
        return r ? { compiled: r.config.compiled, etag: r.etag } : null;
      },
    });
    const started = enf.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(log).toEqual(['hide:custom_field_360002', 'disable:priority']);
    releaseFetch();
    await started;
    expect(timeline).toEqual(['hide', 'fetched']); // 304: nothing re-applied
    expect(log).toHaveLength(2);
  });

  it('re-evaluates on field changes, restores fields, and blocks saving with missing required fields', async () => {
    const ctx = await seed();
    const api = new HpsApiClient(ctx.host);
    const { log, ops } = recorder();
    const values: Record<string, unknown> = {};
    let onChange: (() => void) | undefined;
    const enf = new RuleEnforcer({
      ops,
      storage: memoryStorage(),
      user: { id: '7', role: 'agent', groups: [{ id: '300', name: 'Tier 1 Support' }] },
      readTicket: async () => ({ tags: [], fields: { ...(values as Record<string, string>) } }),
      fetchRules: async (etag) => {
        const r = await api.rulesConfig(etag);
        return r ? { compiled: r.config.compiled as CompiledRuleSet, etag: r.etag } : null;
      },
      watch: (ids, cb) => {
        expect(ids).toEqual(['360001']);
        onChange = cb;
        return () => undefined;
      },
    });
    await enf.start();
    expect(log).toEqual(['hide:custom_field_360002', 'disable:priority']);
    expect(await enf.validateSave()).toBeNull();

    values['360001'] = 'tier_enterprise';
    onChange!();
    await new Promise((r) => setTimeout(r, 10));
    // Rule priority: Tier-1 hide (first) still wins visibility; requirement comes from rule 2.
    expect(enf.evaluation!.fields['360002']).toMatchObject({ hidden: true });
    // Reorder so the enterprise rule wins -> field is shown again and required.
    const rules = await ctx.deps.rules.list(ctx.reg.tenant);
    await ctx.deps.rules.reorder(ctx.reg.tenant, [rules[1]!.id]);
    await enf.start();
    expect(log).toContain('show:custom_field_360002');
    expect(await enf.validateSave()).toMatch(/Refund Amount/);
    values['360002'] = '12.50';
    expect(await enf.validateSave()).toBeNull();
  });

  it('keeps enforcing cached rules when the API is unreachable', async () => {
    const ctx = await seed();
    const compiled = (await new HpsApiClient(ctx.host).rulesConfig())!.config.compiled;
    const storage = memoryStorage();
    storage.set('hps.rules.compiled.v1', JSON.stringify({ compiled }));
    const { log, ops } = recorder();
    const errors: unknown[] = [];
    await new RuleEnforcer({ ops, storage, user: { id: '1', role: 'agent', groups: ['300'] as never }, readTicket: async () => ({}), fetchRules: async () => { throw new Error('offline'); }, onError: (e) => errors.push(e) }).start();
    expect(log).toContain('hide:custom_field_360002');
    expect(errors).toHaveLength(1);
  });
});
