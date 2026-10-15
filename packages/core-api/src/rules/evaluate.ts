import type { Primitive } from '../types.js';
import { fieldKey, normName, refMatches } from './catalog.js';
import {
  ACTION_DIMENSION,
  type CompiledRuleSet,
  type Dimension,
  type EvalContext,
  type Evaluation,
  type FieldCondition,
  type FieldRule,
  type FieldState,
  type RuleConditions,
} from './types.js';

/** Deterministic rule order: priority asc, then creation time, then id. */
export function sortRules(rules: FieldRule[]): FieldRule[] {
  return [...rules].sort(
    (a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

const lc = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim().toLowerCase());

function fieldValue(ctx: EvalContext, c: FieldCondition): Primitive | Primitive[] | undefined {
  const values = ctx.ticket?.fields ?? {};
  if (c.field.id in values) return values[c.field.id];
  // Fallback: shells may key by name.
  const byName = Object.keys(values).find((k) => normName(k) === normName(c.field.name));
  return byName === undefined ? undefined : values[byName];
}

function conditionHolds(ctx: EvalContext, c: FieldCondition): boolean {
  const v = fieldValue(ctx, c);
  const actual = Array.isArray(v) ? v.map(lc) : [lc(v)].filter((x) => x !== '');
  const wanted = (Array.isArray(c.value) ? c.value : [c.value]).map(lc);
  switch (c.op) {
    case 'empty':
      return actual.length === 0;
    case 'not_empty':
      return actual.length > 0;
    case 'eq':
      return actual.length > 0 && wanted.length > 0 && (Array.isArray(v) ? actual.includes(wanted[0]!) : actual[0] === wanted[0]);
    case 'neq':
      return !(actual.length > 0 && (Array.isArray(v) ? actual.includes(wanted[0]!) : actual[0] === wanted[0]));
    case 'in':
      return actual.some((a) => wanted.includes(a));
    case 'contains':
      return actual.some((a) => wanted.some((w) => w !== '' && a.includes(w)));
  }
}

export function conditionsMatch(cond: RuleConditions, ctx: EvalContext): boolean {
  const user = ctx.user;
  const roleTokens = [user.role, user.customRole].filter((x): x is string => !!x).map(normName);
  if (cond.roles?.length && !cond.roles.some((r) => roleTokens.includes(normName(r)))) return false;
  if (cond.notRoles?.length && cond.notRoles.some((r) => roleTokens.includes(normName(r)))) return false;

  if (cond.groups?.length && !cond.groups.some((g) => user.groups.some((ug) => refMatches(g, ug)))) return false;
  if (cond.notGroups?.length && cond.notGroups.some((g) => user.groups.some((ug) => refMatches(g, ug)))) return false;

  if (cond.tags) {
    const tags = new Set((ctx.ticket?.tags ?? []).map(lc));
    const { any = [], all = [], none = [] } = cond.tags;
    if (any.length && !any.some((t) => tags.has(lc(t)))) return false;
    if (all.length && !all.every((t) => tags.has(lc(t)))) return false;
    if (none.length && none.some((t) => tags.has(lc(t)))) return false;
  }
  if (cond.forms?.length) {
    const f = ctx.ticket?.form;
    if (!f || !cond.forms.some((x) => refMatches(x, f))) return false;
  }
  if (cond.brands?.length) {
    const b = ctx.ticket?.brand;
    if (!b || !cond.brands.some((x) => refMatches(x, b))) return false;
  }
  if (cond.isNewTicket !== undefined && (ctx.ticket?.isNew ?? false) !== cond.isNewTicket) return false;
  for (const fc of cond.fields ?? []) if (!conditionHolds(ctx, fc)) return false;
  return true;
}

/**
 * Evaluates rules for one agent + ticket. For each field, each dimension (visibility, editability,
 * requirement, value) is decided by the FIRST matching rule in priority order — so "show for Tier 2"
 * at priority 1 overrides "hide for everyone" at priority 10, exactly as admins read the list.
 */
export function evaluateRules(
  rules: FieldRule[],
  ctx: EvalContext,
  fieldKeys: Record<string, { key: string; name: string }> = {},
): Evaluation {
  const fields: Record<string, FieldState> = {};
  const matched: string[] = [];
  const watch = new Set<string>();
  const warnings: string[] = [];

  for (const rule of sortRules(rules)) {
    if (!rule.enabled) continue;
    for (const fc of rule.conditions.fields ?? []) watch.add(fc.field.id);
    if (!conditionsMatch(rule.conditions, ctx)) continue;
    matched.push(rule.id);
    for (const action of rule.actions) {
      const id = action.field.id;
      const meta = fieldKeys[id];
      const st = (fields[id] ??= { fieldId: id, name: meta?.name ?? action.field.name, key: meta?.key ?? id, decidedBy: {} });
      const dim: Dimension = ACTION_DIMENSION[action.type];
      if (st.decidedBy[dim]) continue; // a higher-priority rule already decided this dimension
      st.decidedBy[dim] = rule.id;
      switch (action.type) {
        case 'hide':
          st.hidden = true;
          break;
        case 'show':
          st.hidden = false;
          break;
        case 'disable':
          st.disabled = true;
          break;
        case 'enable':
          st.disabled = false;
          break;
        case 'require':
          st.required = true;
          break;
        case 'optional':
          st.required = false;
          break;
        case 'set_value':
          st.setValue = true;
          st.value = action.value ?? null;
          break;
      }
    }
  }

  for (const st of Object.values(fields)) {
    if (st.hidden && st.required) {
      // A hidden required field would make the ticket unsaveable.
      st.required = false;
      warnings.push(`"${st.name}" is both hidden and required for this agent; requirement dropped so the ticket can be saved.`);
    }
  }
  return { fields, matchedRuleIds: matched, watchFieldIds: [...watch], warnings };
}

export const evaluateCompiled = (set: CompiledRuleSet, ctx: EvalContext): Evaluation => evaluateRules(set.rules, ctx, set.fields);

/** Returns names of required fields that are empty in the given values. */
export function missingRequired(ev: Evaluation, values: Record<string, unknown>): FieldState[] {
  return Object.values(ev.fields).filter((st) => {
    if (!st.required || st.hidden) return false;
    const v = values[st.fieldId] ?? values[st.key];
    return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  });
}

/** Small sync FNV-1a hash used for rule-set versions / ETags (not security sensitive). */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function compileRuleSet(
  rules: FieldRule[],
  catalogFields: { id: string; name: string; key?: string }[],
  activeCap: number | null,
  now: () => Date = () => new Date(),
): CompiledRuleSet {
  const sorted = sortRules(rules).filter((r) => r.enabled);
  const active = activeCap === null ? sorted : sorted.slice(0, activeCap);
  const inactive = activeCap === null ? [] : sorted.slice(activeCap).map((r) => r.id);
  const fields: CompiledRuleSet['fields'] = {};
  const byId = new Map(catalogFields.map((f) => [f.id, f]));
  for (const r of active) {
    const refs = [...r.actions.map((a) => a.field), ...(r.conditions.fields ?? []).map((c) => c.field)];
    for (const ref of refs) {
      const def = byId.get(ref.id);
      fields[ref.id] = { id: ref.id, name: def?.name ?? ref.name, key: def ? fieldKey(def) : ref.id };
    }
  }
  const version = fnv1a(JSON.stringify({ active, fields }));
  return { version, generatedAt: now().toISOString(), rules: active, fields, inactiveRuleIds: inactive };
}
