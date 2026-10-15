import type { Catalog, FieldDef, FieldRule, RuleActionType } from '@hps/core-api/rules';
import { HpsApiError, type HpsApiClient, type RulesConfig } from '../api.js';
import { clear, h } from '../dom.js';
import type { HostAdapter } from '../types.js';

const ACTIONS: [RuleActionType, string][] = [
  ['hide', 'Hide'],
  ['show', 'Show (override)'],
  ['disable', 'Make read-only'],
  ['enable', 'Make editable (override)'],
  ['require', 'Require'],
  ['optional', 'Make optional (override)'],
  ['set_value', 'Set value'],
];
const ROLES: [string, string][] = [['admin', 'Admins'], ['agent', 'Agents'], ['light_agent', 'Light agents']];
const VERB: Record<RuleActionType, string> = { hide: 'hide', show: 'show', disable: 'lock', enable: 'unlock', require: 'require', optional: 'un-require', set_value: 'set' };

const csvList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export function describeRule(r: FieldRule): string {
  const who: string[] = [];
  const c = r.conditions;
  if (c.roles?.length) who.push(`role is ${c.roles.join(' or ')}`);
  if (c.groups?.length) who.push(`agent in ${c.groups.map((g) => g.name).join(' or ')}`);
  if (c.notGroups?.length) who.push(`agent not in ${c.notGroups.map((g) => g.name).join(', ')}`);
  if (c.tags?.any?.length) who.push(`ticket tagged ${c.tags.any.join(' or ')}`);
  if (c.tags?.none?.length) who.push(`ticket not tagged ${c.tags.none.join(', ')}`);
  if (c.fields?.length) who.push(c.fields.map((f) => `${f.field.name} ${f.op} ${Array.isArray(f.value) ? f.value.join('/') : (f.value ?? '')}`).join(' and '));
  if (c.isNewTicket !== undefined) who.push(c.isNewTicket ? 'new tickets' : 'existing tickets');
  const what = r.actions.map((a) => `${VERB[a.type]} ${a.field.name}${a.type === 'set_value' ? ` = ${String(a.value)}` : ''}`).join(', ');
  return `${who.length ? `When ${who.join(', ')}` : 'Always'} → ${what}`;
}

/** Visual rule builder: every picker shows human-readable field / group names; IDs never appear. */
export class RuleBuilderView {
  readonly el = h('section', { class: 'hps-rules', 'data-testid': 'rules-view' });
  private cfg: RulesConfig | null = null;
  private catalog: Catalog = { fields: [], groups: [] };
  private listEl = h('div', { 'data-testid': 'rule-list' });
  private formEl = h('div', { class: 'hps-card', 'data-testid': 'rule-form' });
  private msg = h('div', { 'aria-live': 'polite', 'data-testid': 'rules-status' });
  private usage = h('div', { class: 'hps-muted', 'data-testid': 'rule-usage' });
  private editing: FieldRule | null = null;
  private previewOut = h('div', { 'data-testid': 'preview-out' });

  constructor(
    private readonly host: HostAdapter,
    private readonly api: HpsApiClient,
  ) {
    this.el.append(
      h('div', { class: 'hps-row' }, h('h2', { style: 'margin:0;flex:1' }, 'Field rules'), this.usage,
        h('button', { class: 'hps-btn', 'data-testid': 'sync-fields', onclick: () => void this.syncCatalog(true) }, 'Re-sync fields')),
      this.msg, this.listEl, this.formEl, h('div', { class: 'hps-card' }, h('h3', { style: 'margin-top:0' }, 'Preview as agent'), this.previewForm(), this.previewOut));
  }

  private say(text: string, kind: '' | 'error' | 'ok' = '') {
    clear(this.msg);
    if (text) this.msg.appendChild(h('div', { class: `hps-alert ${kind}` }, text));
  }

  async load() {
    try {
      await this.syncCatalog(false);
      await this.refresh();
    } catch (e) {
      this.say(`Could not load rules: ${(e as Error).message}`, 'error');
    }
  }

  /** Pulls ticket fields, groups, roles, forms and brands from the helpdesk and pushes them as the name catalog. */
  async syncCatalog(announce: boolean) {
    const catalog = await this.host.ruleCatalog();
    this.catalog = await this.api.syncCatalog(catalog);
    if (announce) this.say(`Synced ${this.catalog.fields.length} fields and ${this.catalog.groups.length} groups.`, 'ok');
  }

  async refresh() {
    const res = await this.api.rulesConfig();
    this.cfg = res?.config ?? this.cfg;
    if (this.cfg?.catalog?.fields.length) this.catalog = this.cfg.catalog;
    this.renderList();
    this.renderForm(this.editing);
  }

  private renderList() {
    clear(this.listEl);
    const rules = this.cfg?.rules ?? [];
    const lim = this.cfg?.limits;
    clear(this.usage);
    if (lim) this.usage.append(`${rules.length} / ${lim.maxFieldRules ?? '∞'} rules · `, h('span', { class: `hps-badge ${lim.plan === 'pro' ? 'pro' : ''}` }, lim.plan === 'pro' ? 'Pro' : 'Free'));
    if (!rules.length) {
      this.listEl.append(h('p', { class: 'hps-muted' }, 'No rules yet. Rules run top to bottom; the first rule that decides a field wins.'));
      return;
    }
    const inactive = new Set(this.cfg?.compiled.inactiveRuleIds ?? []);
    rules.forEach((r, i) => {
      this.listEl.append(h('div', { class: `hps-rule ${r.enabled && !inactive.has(r.id) ? '' : 'disabled'}`, 'data-rule': r.name },
        h('div', { class: 'hps-row', style: 'flex-direction:column;margin:0' },
          h('button', { class: 'hps-btn small', 'aria-label': `Move ${r.name} up`, disabled: i === 0, onclick: () => void this.move(i, -1) }, '↑'),
          h('button', { class: 'hps-btn small', 'aria-label': `Move ${r.name} down`, disabled: i === rules.length - 1, onclick: () => void this.move(i, 1) }, '↓')),
        h('div', { class: 'hps-rule-main' }, h('strong', {}, `${i + 1}. ${r.name}`), inactive.has(r.id) ? h('span', { class: 'hps-badge', style: 'margin-left:6px' }, 'Inactive on Free plan') : null,
          h('div', { class: 'hps-muted' }, describeRule(r))),
        h('button', { class: 'hps-btn small', onclick: () => this.renderForm(r) }, 'Edit'),
        h('button', { class: 'hps-btn small danger', onclick: () => void this.remove(r) }, 'Delete')));
    });
  }

  private async move(index: number, dir: -1 | 1) {
    const ids = (this.cfg?.rules ?? []).map((r) => r.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + dir, 0, id!);
    await this.api.reorderRules(ids);
    await this.refresh();
  }

  private async remove(r: FieldRule) {
    if (globalThis.confirm && !globalThis.confirm(`Delete rule "${r.name}"?`)) return;
    await this.api.deleteRule(r.id);
    await this.refresh();
  }

  private fieldSelect(selected?: string, testid?: string) {
    const fields = [...this.catalog.fields].sort((a, b) => a.name.localeCompare(b.name));
    // Duplicate names are labelled with their type so admins can tell them apart — still no raw IDs.
    const counts = new Map<string, number>();
    for (const f of fields) counts.set(f.name.toLowerCase(), (counts.get(f.name.toLowerCase()) ?? 0) + 1);
    return h('select', { 'aria-label': 'Field', 'data-testid': testid },
      h('option', { value: '' }, 'Choose a field…'),
      fields.map((f) => h('option', { value: f.id, selected: f.id === selected }, (counts.get(f.name.toLowerCase()) ?? 0) > 1 ? `${f.name} (${f.type ?? 'field'})` : f.name)));
  }

  private valueInput(field: FieldDef | undefined, value?: unknown) {
    if (field?.options?.length) {
      return h('select', { 'aria-label': 'Value' }, field.options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
    }
    return h('input', { type: 'text', 'aria-label': 'Value', placeholder: 'Value', value: value === undefined || value === null ? '' : String(value) });
  }

  private renderForm(rule: FieldRule | null) {
    this.editing = rule;
    clear(this.formEl);
    const name = h('input', { type: 'text', placeholder: 'e.g. Hide refund fields from Tier 1', value: rule?.name ?? '', 'data-testid': 'rule-name', style: 'flex:1' });
    const roleChips = ROLES.map(([v, l]) => {
      const on = rule?.conditions.roles?.includes(v) ?? false;
      const b = h('button', { class: 'hps-chip', type: 'button', 'aria-pressed': String(on), 'data-role': v }, l);
      b.addEventListener('click', () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')));
      return b;
    });
    const groupSel = (selected: { id?: string; name: string }[] | undefined, testid: string) =>
      h('select', { multiple: true, 'aria-label': 'Groups', 'data-testid': testid },
        this.catalog.groups.map((g) => h('option', { value: g.name, selected: selected?.some((s) => s.name === g.name) ?? false }, g.name)));
    const groups = groupSel(rule?.conditions.groups, 'rule-groups');
    const notGroups = groupSel(rule?.conditions.notGroups, 'rule-not-groups');
    const tagsAny = h('input', { type: 'text', placeholder: 'vip, enterprise', value: rule?.conditions.tags?.any?.join(', ') ?? '', 'data-testid': 'rule-tags-any' });
    const tagsNone = h('input', { type: 'text', placeholder: 'internal', value: rule?.conditions.tags?.none?.join(', ') ?? '' });
    const scope = h('select', { 'aria-label': 'Ticket scope' }, h('option', { value: '' }, 'All tickets'), h('option', { value: 'new', selected: rule?.conditions.isNewTicket === true }, 'New tickets only'), h('option', { value: 'existing', selected: rule?.conditions.isNewTicket === false }, 'Existing tickets only'));

    const actionsBox = h('div', { 'data-testid': 'rule-actions' });
    const addAction = (type: RuleActionType = 'hide', fieldId?: string, value?: unknown) => {
      const typeSel = h('select', { 'aria-label': 'Action', 'data-testid': 'action-type' }, ACTIONS.map(([v, l]) => h('option', { value: v, selected: v === type }, l)));
      const fieldSel = this.fieldSelect(fieldId, 'action-field');
      const valueBox = h('div', { class: 'hps-value' });
      const row = h('div', { class: 'hps-action-row' }, typeSel, fieldSel, valueBox, h('button', { class: 'hps-btn small danger', 'aria-label': 'Remove action', onclick: () => row.remove() }, '×'));
      const syncValue = () => {
        clear(valueBox);
        if (typeSel.value === 'set_value') valueBox.append(this.valueInput(this.catalog.fields.find((f) => f.id === fieldSel.value), value));
      };
      typeSel.addEventListener('change', syncValue);
      fieldSel.addEventListener('change', syncValue);
      syncValue();
      actionsBox.append(row);
    };
    if (rule) for (const a of rule.actions) addAction(a.type, a.field.id, a.value);
    else addAction();

    const problems = h('div', { 'data-testid': 'rule-problems' });
    const collect = () => {
      const roles = roleChips.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.role!);
      const sel = (s: HTMLSelectElement) => [...s.selectedOptions].map((o) => o.value);
      const any = csvList(tagsAny.value);
      const none = csvList(tagsNone.value);
      const actions = [...actionsBox.querySelectorAll('.hps-action-row')].map((row) => {
        const [t, f] = row.querySelectorAll<HTMLSelectElement>(':scope > select');
        const v = row.querySelector<HTMLInputElement | HTMLSelectElement>('.hps-value select, .hps-value input');
        const fieldName = this.catalog.fields.find((x) => x.id === f!.value);
        return { type: t!.value, field: fieldName ? { id: fieldName.id, name: fieldName.name } : '', ...(t!.value === 'set_value' ? { value: v?.value ?? '' } : {}) };
      });
      return {
        name: name.value.trim(),
        enabled: rule?.enabled ?? true,
        ...(rule ? { priority: rule.priority } : {}),
        conditions: {
          ...(roles.length ? { roles } : {}),
          ...(sel(groups).length ? { groups: sel(groups) } : {}),
          ...(sel(notGroups).length ? { notGroups: sel(notGroups) } : {}),
          ...(any.length || none.length ? { tags: { ...(any.length ? { any } : {}), ...(none.length ? { none } : {}) } } : {}),
          ...(scope.value ? { isNewTicket: scope.value === 'new' } : {}),
        },
        actions,
      };
    };
    const save = async () => {
      clear(problems);
      const body = collect();
      if (!body.name) return problems.append(h('div', { class: 'hps-problem' }, 'Give the rule a name.'));
      if (body.actions.some((a) => !a.field)) return problems.append(h('div', { class: 'hps-problem' }, 'Pick a field for every action.'));
      try {
        if (rule) await this.api.updateRule(rule.id, body);
        else await this.api.createRule(body);
        this.say(`Rule "${body.name}" saved. Sidebars pick it up on the next ticket load.`, 'ok');
        this.editing = null;
        await this.refresh();
      } catch (e) {
        if (e instanceof HpsApiError && e.code === 'plan_limit') {
          problems.append(h('div', { class: 'hps-alert', 'data-testid': 'rule-upgrade' }, `${e.message} `, h('button', { class: 'hps-btn small primary', onclick: () => void this.upgrade() }, 'Upgrade')));
        } else if (e instanceof HpsApiError && e.details && typeof e.details === 'object' && 'problems' in e.details) {
          for (const p of (e.details as { problems: { message: string }[] }).problems) problems.append(h('div', { class: 'hps-problem' }, p.message));
        } else problems.append(h('div', { class: 'hps-problem' }, (e as Error).message));
      }
    };

    this.formEl.append(
      h('h3', { style: 'margin-top:0' }, rule ? `Edit rule` : 'New rule'),
      h('div', { class: 'hps-row' }, name),
      h('div', { class: 'hps-row', style: 'align-items:flex-start' },
        h('div', { class: 'hps-field' }, h('span', {}, 'Agent role is any of'), h('div', { class: 'hps-chips', 'data-testid': 'rule-roles' }, roleChips)),
        h('label', { class: 'hps-field' }, h('span', {}, 'Agent is in any group'), groups),
        h('label', { class: 'hps-field' }, h('span', {}, 'Agent is NOT in groups'), notGroups),
        h('label', { class: 'hps-field' }, h('span', {}, 'Ticket has any tag'), tagsAny),
        h('label', { class: 'hps-field' }, h('span', {}, 'Ticket has none of tags'), tagsNone),
        h('label', { class: 'hps-field' }, h('span', {}, 'Applies to'), scope)),
      h('div', { class: 'hps-field' }, h('span', {}, 'Then')),
      actionsBox,
      h('div', { class: 'hps-row' },
        h('button', { class: 'hps-btn small', type: 'button', onclick: () => addAction() }, '+ Add action'),
        h('span', { style: 'flex:1' }),
        rule ? h('button', { class: 'hps-btn', onclick: () => this.renderForm(null) }, 'Cancel') : null,
        h('button', { class: 'hps-btn primary', 'data-testid': 'save-rule', onclick: () => void save() }, rule ? 'Update rule' : 'Save rule')),
      problems,
    );
  }

  private previewForm() {
    const role = h('select', { 'aria-label': 'Preview role', 'data-testid': 'preview-role' }, ROLES.map(([v, l]) => h('option', { value: v, selected: v === 'agent' }, l.replace(/s$/, ''))));
    const group = h('input', { type: 'text', placeholder: 'Group names, comma separated', 'data-testid': 'preview-groups' });
    const tags = h('input', { type: 'text', placeholder: 'Ticket tags', 'data-testid': 'preview-tags' });
    const run = async () => {
      clear(this.previewOut);
      try {
        const ev = await this.api.evaluate({ user: { role: role.value, groups: csvList(group.value) }, ticket: { tags: csvList(tags.value) } });
        const items = Object.values(ev.fields);
        if (!items.length) this.previewOut.append(h('p', { class: 'hps-muted' }, 'No field changes for this agent.'));
        for (const f of items) {
          const fx = [f.hidden ? 'hidden' : f.hidden === false ? 'shown' : '', f.disabled ? 'read-only' : '', f.required ? 'required' : '', f.setValue ? `set to ${JSON.stringify(f.value)}` : ''].filter(Boolean).join(', ');
          this.previewOut.append(h('div', { 'data-preview-field': f.name }, h('strong', {}, f.name), `: ${fx}`));
        }
        for (const w of ev.warnings) this.previewOut.append(h('div', { class: 'hps-alert' }, w));
      } catch (e) {
        this.previewOut.append(h('div', { class: 'hps-problem' }, (e as Error).message));
      }
    };
    return h('div', { class: 'hps-row' }, role, group, tags, h('button', { class: 'hps-btn', 'data-testid': 'run-preview', onclick: () => void run() }, 'Preview'));
  }

  private async upgrade() {
    try {
      const { url } = await this.api.checkout();
      this.host.openUrl(url);
    } catch (e) {
      this.say((e as Error).message, 'error');
    }
  }
}
