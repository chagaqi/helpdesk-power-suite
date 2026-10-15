import type { EntitlementService } from '../billing/EntitlementService.js';
import { getJson, setJson, type IUsageStore } from '../stores/IUsageStore.js';
import { randomId } from '../util/crypto.js';
import { HpsError } from '../util/errors.js';
import { resolveField, resolveNamed, type RefInput } from './catalog.js';
import { compileRuleSet, evaluateRules, fnv1a, sortRules } from './evaluate.js';
import type { RuleInput } from './schemas.js';
import type { Catalog, CompiledRuleSet, EvalContext, Evaluation, FieldCondition, FieldRule, NamedRef, RuleAction, RuleConditions } from './types.js';

/**
 * Module B — Visual Field Rule & Permission Compiler.
 *
 * Admins reference fields, groups, forms and brands by human-readable NAME. Names are resolved
 * against the synced catalog at save time (ambiguous / unknown names are rejected with
 * suggestions) and stored as {id, name}, so renames on the helpdesk side never break rules.
 */

interface TenantRules {
  rules: FieldRule[];
  revision: number;
}

export interface RuleProblem {
  path: string;
  message: string;
  suggestions: string[];
}

const rulesKey = (t: string) => `rules:${t}`;
const catalogKey = (t: string) => `catalog:${t}`;

export class VisualFieldRuleEngine {
  constructor(
    private readonly store: IUsageStore,
    private readonly entitlements: EntitlementService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getCatalog(tenant: string): Promise<Catalog> {
    return (await getJson<Catalog>(this.store, catalogKey(tenant))) ?? { fields: [], groups: [] };
  }

  async syncCatalog(tenant: string, catalog: Omit<Catalog, 'updatedAt'>): Promise<Catalog> {
    const ids = new Set<string>();
    for (const f of catalog.fields) {
      if (ids.has(f.id)) throw new HpsError('invalid_request', `Duplicate field id ${f.id} in catalog`);
      ids.add(f.id);
    }
    const c: Catalog = { ...catalog, updatedAt: this.now().toISOString() };
    await setJson(this.store, catalogKey(tenant), c);
    return c;
  }

  private async load(tenant: string): Promise<TenantRules> {
    return (await getJson<TenantRules>(this.store, rulesKey(tenant))) ?? { rules: [], revision: 0 };
  }

  private async save(tenant: string, tr: TenantRules) {
    tr.revision++;
    await setJson(this.store, rulesKey(tenant), tr);
  }

  async list(tenant: string): Promise<FieldRule[]> {
    return sortRules((await this.load(tenant)).rules);
  }

  /** Resolves every name in a rule input. Returns problems instead of throwing so the UI can highlight them. */
  resolve(input: RuleInput, catalog: Catalog): { rule?: Pick<FieldRule, 'conditions' | 'actions'>; problems: RuleProblem[] } {
    const problems: RuleProblem[] = [];
    const field = (ref: RefInput, path: string) => {
      const r = resolveField(catalog, ref);
      if (!r.ok) {
        problems.push({ path, message: r.message, suggestions: r.suggestions });
        return null;
      }
      return { id: r.value.id, name: r.value.name, def: r.value.def };
    };
    const named = (list: NamedRef[] | undefined, refs: RefInput[] | undefined, what: string, path: string): NamedRef[] | undefined => {
      if (!refs) return undefined;
      const out: NamedRef[] = [];
      refs.forEach((ref, i) => {
        const r = resolveNamed(list, ref, what);
        if (r.ok) out.push(r.value);
        else problems.push({ path: `${path}[${i}]`, message: r.message, suggestions: r.suggestions });
      });
      return out;
    };

    const c = input.conditions ?? {};
    const conditions: RuleConditions = {};
    if (c.roles?.length) conditions.roles = c.roles;
    if (c.notRoles?.length) conditions.notRoles = c.notRoles;
    if (c.groups?.length) conditions.groups = named(catalog.groups, c.groups, 'group', 'conditions.groups');
    if (c.notGroups?.length) conditions.notGroups = named(catalog.groups, c.notGroups, 'group', 'conditions.notGroups');
    if (c.tags && ((c.tags.any?.length ?? 0) + (c.tags.all?.length ?? 0) + (c.tags.none?.length ?? 0) > 0)) conditions.tags = c.tags;
    if (c.forms?.length) conditions.forms = named(catalog.forms, c.forms, 'ticket form', 'conditions.forms');
    if (c.brands?.length) conditions.brands = named(catalog.brands, c.brands, 'brand', 'conditions.brands');
    if (c.isNewTicket !== undefined) conditions.isNewTicket = c.isNewTicket;
    if (c.fields?.length) {
      const fcs: FieldCondition[] = [];
      c.fields.forEach((fc, i) => {
        const f = field(fc.field, `conditions.fields[${i}].field`);
        if (f) fcs.push({ field: { id: f.id, name: f.name }, op: fc.op, ...(fc.value !== undefined ? { value: fc.value } : {}) });
      });
      conditions.fields = fcs;
    }

    const actions: RuleAction[] = [];
    input.actions.forEach((a, i) => {
      const f = field(a.field, `actions[${i}].field`);
      if (!f) return;
      if (a.type === 'set_value') {
        if (a.value === undefined) {
          problems.push({ path: `actions[${i}].value`, message: `set_value on "${f.name}" needs a value`, suggestions: [] });
          return;
        }
        // Accept option labels for dropdowns ("Gold") and store the platform value ("gold").
        const opts = f.def.options;
        if (opts?.length && typeof a.value === 'string') {
          const hit = opts.find((o) => o.value === a.value) ?? opts.find((o) => o.label.toLowerCase() === String(a.value).toLowerCase());
          if (!hit) {
            problems.push({ path: `actions[${i}].value`, message: `"${a.value}" is not an option of "${f.name}"`, suggestions: opts.slice(0, 10).map((o) => o.label) });
            return;
          }
          actions.push({ type: a.type, field: { id: f.id, name: f.name }, value: hit.value });
          return;
        }
      }
      if (f.def.system && f.def.id === 'subject' && (a.type === 'hide' || a.type === 'disable')) {
        problems.push({ path: `actions[${i}]`, message: 'The Subject field cannot be hidden or disabled', suggestions: [] });
        return;
      }
      actions.push({ type: a.type, field: { id: f.id, name: f.name }, ...(a.value !== undefined && a.type === 'set_value' ? { value: a.value } : {}) });
    });

    return problems.length ? { problems } : { rule: { conditions, actions }, problems };
  }

  private async resolveOrThrow(tenant: string, input: RuleInput) {
    const catalog = await this.getCatalog(tenant);
    if (!catalog.fields.length) {
      throw new HpsError('unresolved_reference', 'Field catalog is empty. Open the app as an admin once so ticket fields sync, then build rules by field name.');
    }
    const { rule, problems } = this.resolve(input, catalog);
    if (!rule) throw new HpsError('unresolved_reference', problems.map((p) => p.message).join('; '), { problems });
    return rule;
  }

  async create(tenant: string, input: RuleInput): Promise<FieldRule> {
    const tr = await this.load(tenant);
    await this.entitlements.assertCanCreateRule(tenant, tr.rules.length);
    const resolved = await this.resolveOrThrow(tenant, input);
    const ts = this.now().toISOString();
    const maxPriority = tr.rules.reduce((m, r) => Math.max(m, r.priority), 0);
    const rule: FieldRule = {
      id: `rule_${randomId(9)}`,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      enabled: input.enabled ?? true,
      priority: input.priority ?? maxPriority + 10,
      ...resolved,
      createdAt: ts,
      updatedAt: ts,
    };
    tr.rules.push(rule);
    await this.save(tenant, tr);
    return rule;
  }

  async update(tenant: string, id: string, input: RuleInput): Promise<FieldRule> {
    const tr = await this.load(tenant);
    const idx = tr.rules.findIndex((r) => r.id === id);
    if (idx < 0) throw new HpsError('not_found', `Rule ${id} not found`);
    const resolved = await this.resolveOrThrow(tenant, input);
    const prev = tr.rules[idx]!;
    const rule: FieldRule = {
      ...prev,
      name: input.name,
      description: input.description,
      enabled: input.enabled ?? prev.enabled,
      priority: input.priority ?? prev.priority,
      ...resolved,
      updatedAt: this.now().toISOString(),
    };
    tr.rules[idx] = rule;
    await this.save(tenant, tr);
    return rule;
  }

  async remove(tenant: string, id: string): Promise<void> {
    const tr = await this.load(tenant);
    const before = tr.rules.length;
    tr.rules = tr.rules.filter((r) => r.id !== id);
    if (tr.rules.length === before) throw new HpsError('not_found', `Rule ${id} not found`);
    await this.save(tenant, tr);
  }

  /** Re-numbers priorities (10, 20, ...) following the given id order (drag-and-drop in the UI). */
  async reorder(tenant: string, orderedIds: string[]): Promise<FieldRule[]> {
    const tr = await this.load(tenant);
    const known = new Set(tr.rules.map((r) => r.id));
    for (const id of orderedIds) if (!known.has(id)) throw new HpsError('not_found', `Rule ${id} not found`);
    const rest = sortRules(tr.rules.filter((r) => !orderedIds.includes(r.id)));
    const order = [...orderedIds.map((id) => tr.rules.find((r) => r.id === id)!), ...rest];
    order.forEach((r, i) => (r.priority = (i + 1) * 10));
    tr.rules = order;
    await this.save(tenant, tr);
    return sortRules(tr.rules);
  }

  /** Compiled rule set for local evaluation in sidebars (respects the plan's active-rule cap). */
  async compile(tenant: string): Promise<CompiledRuleSet> {
    const [tr, catalog, ent] = await Promise.all([this.load(tenant), this.getCatalog(tenant), this.entitlements.get(tenant)]);
    return compileRuleSet(tr.rules, catalog.fields, ent.limits.maxFieldRules, this.now);
  }

  async evaluate(tenant: string, ctx: EvalContext): Promise<Evaluation & { version: string; inactiveRuleIds: string[] }> {
    const set = await this.compile(tenant);
    return { ...evaluateRules(set.rules, ctx, set.fields), version: set.version, inactiveRuleIds: set.inactiveRuleIds };
  }

  async config(tenant: string) {
    const [rules, catalog, compiled, ent] = await Promise.all([this.list(tenant), this.getCatalog(tenant), this.compile(tenant), this.entitlements.get(tenant)]);
    return {
      version: fnv1a(JSON.stringify({ v: compiled.version, c: catalog.updatedAt ?? '', n: rules.length })),
      rules,
      catalog,
      compiled,
      limits: { maxFieldRules: ent.limits.maxFieldRules, plan: ent.effectivePlan, used: rules.length },
    };
  }
}
