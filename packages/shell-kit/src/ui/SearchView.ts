import { ExportSession, resolveColumns, type CustomFieldDef, type EntityType, type ExportFilters, type UserRole } from '@hps/core-api/export';
import { HpsApiError, type HpsApiClient, type MeResponse } from '../api.js';
import { clear, fmt, h } from '../dom.js';
import { runCursorExport } from '../exportRunner.js';
import type { ExportProgress, HostAdapter } from '../types.js';
import { ResizableTable } from './ResizableTable.js';

const ENTITY_LABEL: Record<EntityType, string> = { ticket: 'Tickets', user: 'Users', organization: 'Organizations' };
const ROLE_LABEL: [UserRole, string][] = [['admin', 'Admin'], ['agent', 'Agent'], ['light_agent', 'Light agent'], ['end_user', 'End-user']];
const TICKET_STATUSES = ['new', 'open', 'pending', 'hold', 'solved', 'closed', 'resolved', 'deleted'];

interface Preset {
  name: string;
  columns: string[];
}

const csvList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** Advanced cursor search + preview + 1-click CSV/XLSX export with sticky custom-field presets. */
export class SearchView {
  readonly el = h('section', { class: 'hps-search', 'data-testid': 'search-view' });
  private entity: EntityType = 'ticket';
  private schemaCache = new Map<EntityType, CustomFieldDef[]>();
  private abort?: AbortController;
  private readonly ns: string;

  // controls
  private qInput = h('input', { type: 'search', placeholder: 'Search query (optional)', 'aria-label': 'Search query', 'data-testid': 'query', style: 'min-width:280px;flex:1' });
  private stateSel = h('select', { 'aria-label': 'User state', 'data-testid': 'user-state' },
    h('option', { value: 'all' }, 'All users'), h('option', { value: 'active' }, 'Active only'), h('option', { value: 'suspended' }, 'Suspended only'));
  private archived = h('input', { type: 'checkbox', 'data-testid': 'include-archived', checked: true });
  private tagsAny = h('input', { type: 'text', placeholder: 'vip, enterprise', 'data-testid': 'tags-any' });
  private tagsNone = h('input', { type: 'text', placeholder: 'spam, test', 'data-testid': 'tags-none' });
  private roleChips = new Map<UserRole, HTMLButtonElement>();
  private statusChips = new Map<string, HTMLButtonElement>();
  private columnsBox = h('div', { class: 'hps-chips', 'data-testid': 'columns' });
  private presetSel = h('select', { 'aria-label': 'Column preset', 'data-testid': 'preset' });
  private filtersBox = h('div');
  private status = h('div', { 'aria-live': 'polite', 'data-testid': 'status' });
  private progress = h('div', { class: 'hps-progress', hidden: true }, h('div', { style: 'width:0%' }));
  private results = h('div', { 'data-testid': 'results' });
  private cancelBtn = h('button', { class: 'hps-btn danger', hidden: true, onclick: () => this.abort?.abort() }, 'Cancel');
  private exportBtns: HTMLButtonElement[] = [];
  private selected = new Set<string>();

  constructor(
    private readonly host: HostAdapter,
    private readonly api: HpsApiClient,
    private readonly me: MeResponse | null,
    tenant: string,
  ) {
    this.ns = `hps:${tenant}`;
    const entities = (['ticket', 'user', 'organization'] as EntityType[]).filter((e) => host.supportsEntity?.(e) ?? true);
    this.entity = (host.storage.get(`${this.ns}:entity`) as EntityType) ?? entities[0]!;
    if (!entities.includes(this.entity)) this.entity = entities[0]!;
    const entitySel = h('select', { 'aria-label': 'Record type', 'data-testid': 'entity', onchange: (e: Event) => this.switchEntity((e.target as HTMLSelectElement).value as EntityType) },
      entities.map((e) => h('option', { value: e, selected: e === this.entity }, ENTITY_LABEL[e])));
    entitySel.value = this.entity;
    for (const [role, label] of ROLE_LABEL) this.roleChips.set(role, this.chip(label));
    for (const st of TICKET_STATUSES) this.statusChips.set(st, this.chip(st));

    const btn = (label: string, fmt_: 'csv' | 'xlsx', testid: string) => {
      const b = h('button', { class: 'hps-btn primary', 'data-testid': testid, onclick: () => void this.exportAll(fmt_) }, label);
      this.exportBtns.push(b);
      return b;
    };
    const limit = me?.entitlement.limits.maxExportRows;
    this.el.append(
      h('div', { class: 'hps-row' }, entitySel, this.qInput, h('button', { class: 'hps-btn', 'data-testid': 'preview', onclick: () => void this.preview() }, 'Preview')),
      this.filtersBox,
      h('details', { class: 'hps-card' },
        h('summary', {}, 'Columns & presets'),
        h('div', { class: 'hps-row', style: 'margin-top:8px' }, this.presetSel,
          h('button', { class: 'hps-btn small', 'data-testid': 'save-preset', onclick: () => this.savePreset() }, 'Save as preset'),
          h('button', { class: 'hps-btn small', onclick: () => this.setAllColumns(true) }, 'All'),
          h('button', { class: 'hps-btn small', onclick: () => this.setAllColumns(false) }, 'None')),
        this.columnsBox),
      h('div', { class: 'hps-row' }, btn('Export CSV', 'csv', 'export-csv'), btn('Export Excel (.xlsx)', 'xlsx', 'export-xlsx'), this.cancelBtn,
        h('span', { class: 'hps-muted' }, limit === null || limit === undefined ? 'Unlimited rows (Pro) — cursor pagination, no 1,000-row cap' : `Free plan: up to ${fmt(limit)} rows per export`)),
      this.progress,
      this.status,
      this.results,
    );
    this.presetSel.addEventListener('change', () => this.applyPreset());
    void this.switchEntity(this.entity);
  }

  private chip(label: string) {
    const b = h('button', { class: 'hps-chip', type: 'button', 'aria-pressed': 'false', 'data-chip': label }, label);
    b.addEventListener('click', () => b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'));
    return b;
  }

  private pressed(map: Map<string, HTMLButtonElement>) {
    return [...map].filter(([, b]) => b.getAttribute('aria-pressed') === 'true').map(([k]) => k);
  }

  private say(msg: string, kind: '' | 'error' | 'ok' = '') {
    clear(this.status);
    if (msg) this.status.appendChild(h('div', { class: `hps-alert ${kind}` }, msg));
  }

  private async schema(entity: EntityType) {
    if (!this.schemaCache.has(entity)) this.schemaCache.set(entity, await this.host.fieldSchema(entity));
    return this.schemaCache.get(entity)!;
  }

  private async switchEntity(entity: EntityType) {
    this.entity = entity;
    this.host.storage.set(`${this.ns}:entity`, entity);
    clear(this.filtersBox);
    clear(this.results);
    const tags = h('div', { class: 'hps-row' },
      h('label', { class: 'hps-field' }, h('span', {}, 'Has any tag'), this.tagsAny),
      h('label', { class: 'hps-field' }, h('span', {}, 'Exclude tags'), this.tagsNone));
    if (entity === 'user') {
      this.filtersBox.append(h('div', { class: 'hps-row' },
        h('label', { class: 'hps-field' }, h('span', {}, 'State'), this.stateSel),
        h('div', { class: 'hps-field' }, h('span', {}, 'Roles'), h('div', { class: 'hps-chips', 'data-testid': 'roles' }, [...this.roleChips.values()]))), tags);
    } else if (entity === 'ticket') {
      this.filtersBox.append(h('div', { class: 'hps-row' },
        h('label', { class: 'hps-row', style: 'margin:0' }, this.archived, 'Include archived tickets'),
        h('div', { class: 'hps-field' }, h('span', {}, 'Statuses'), h('div', { class: 'hps-chips', 'data-testid': 'statuses' }, [...this.statusChips.values()]))), tags);
    } else this.filtersBox.append(tags);
    await this.renderColumns();
  }

  private async renderColumns() {
    clear(this.columnsBox);
    let schema: CustomFieldDef[] = [];
    try {
      schema = await this.schema(this.entity);
    } catch (e) {
      this.say(`Could not load custom fields: ${(e as Error).message}`, 'error');
    }
    const { columns } = resolveColumns(this.entity, schema);
    const sticky = this.host.storage.get(`${this.ns}:cols:${this.entity}`);
    this.selected = new Set(sticky ? (JSON.parse(sticky) as string[]) : columns.map((c) => c.label));
    for (const c of columns) {
      const b = h('button', { class: 'hps-chip', type: 'button', 'aria-pressed': String(this.selected.has(c.label)), 'data-col': c.label, title: c.origin === 'custom' ? 'Custom field' : 'Standard field' },
        c.origin === 'custom' ? `★ ${c.label}` : c.label);
      b.addEventListener('click', () => {
        if (this.selected.has(c.label)) this.selected.delete(c.label);
        else this.selected.add(c.label);
        b.setAttribute('aria-pressed', String(this.selected.has(c.label)));
        this.persistColumns();
      });
      this.columnsBox.appendChild(b);
    }
    this.renderPresets();
  }

  private persistColumns() {
    this.host.storage.set(`${this.ns}:cols:${this.entity}`, JSON.stringify(this.orderedSelection()));
  }

  private orderedSelection(): string[] {
    return [...this.columnsBox.querySelectorAll<HTMLElement>('[data-col]')].map((b) => b.dataset.col!).filter((l) => this.selected.has(l));
  }

  private setAllColumns(on: boolean) {
    for (const b of this.columnsBox.querySelectorAll<HTMLElement>('[data-col]')) {
      if (on) this.selected.add(b.dataset.col!);
      else this.selected.delete(b.dataset.col!);
      b.setAttribute('aria-pressed', String(on));
    }
    this.persistColumns();
  }

  private presets(): Preset[] {
    try {
      return JSON.parse(this.host.storage.get(`${this.ns}:presets:${this.entity}`) ?? '[]') as Preset[];
    } catch {
      return [];
    }
  }

  private renderPresets() {
    clear(this.presetSel);
    this.presetSel.append(h('option', { value: '' }, 'Column preset…'), ...this.presets().map((p) => h('option', { value: p.name }, p.name)));
  }

  private savePreset() {
    const name = (globalThis.prompt?.('Preset name') ?? '').trim() || `Preset ${this.presets().length + 1}`;
    const list = this.presets().filter((p) => p.name !== name);
    list.push({ name, columns: this.orderedSelection() });
    this.host.storage.set(`${this.ns}:presets:${this.entity}`, JSON.stringify(list));
    this.renderPresets();
    this.presetSel.value = name;
  }

  private applyPreset() {
    const p = this.presets().find((x) => x.name === this.presetSel.value);
    if (!p) return;
    this.selected = new Set(p.columns);
    for (const b of this.columnsBox.querySelectorAll<HTMLElement>('[data-col]')) b.setAttribute('aria-pressed', String(this.selected.has(b.dataset.col!)));
    this.persistColumns();
  }

  filters(): ExportFilters {
    const f: ExportFilters = {};
    const any = csvList(this.tagsAny.value);
    const none = csvList(this.tagsNone.value);
    if (any.length || none.length) f.tags = { ...(any.length ? { any } : {}), ...(none.length ? { none } : {}) };
    if (this.entity === 'user') {
      f.userState = this.stateSel.value as ExportFilters['userState'];
      const roles = this.pressed(this.roleChips as Map<string, HTMLButtonElement>) as UserRole[];
      if (roles.length) f.roles = roles;
    }
    if (this.entity === 'ticket') {
      f.includeArchived = this.archived.checked;
      const st = this.pressed(this.statusChips);
      if (st.length) f.statuses = st;
    }
    return f;
  }

  private query() {
    return { text: this.qInput.value.trim(), includeArchived: this.entity === 'ticket' ? this.archived.checked : undefined };
  }

  /** Fetches the first page and renders it locally with the exact export pipeline (no upload). */
  async preview() {
    this.say('Loading preview…');
    clear(this.results);
    try {
      const schema = await this.schema(this.entity);
      const page = await this.host.fetchPage(this.entity, null, this.query());
      const s = new ExportSession({ entity: this.entity, source: this.host.platform, fieldSchema: schema, filters: this.filters(), columns: this.orderedSelection() });
      s.ingest({ cursor: null, nextCursor: page.nextCursor, records: page.records });
      const cols = s.columns;
      const table = new ResizableTable(cols.map((c) => ({ key: c.key, label: c.label })), [...s.rows(cols)].slice(0, 500), this.host.storage, `${this.ns}:widths:${this.entity}`);
      this.results.appendChild(table.el);
      const more = page.nextCursor ? ' More pages available — export streams them all via cursor pagination.' : '';
      this.say(`Preview: ${fmt(s.size)} matching of ${fmt(page.records.length)} records on the first page${page.total !== undefined ? ` (≈${fmt(page.total)} total)` : ''}.${more}`, 'ok');
    } catch (e) {
      this.say(`Preview failed: ${(e as Error).message}`, 'error');
    }
  }

  async exportAll(format: 'csv' | 'xlsx') {
    this.abort = new AbortController();
    this.exportBtns.forEach((b) => (b.disabled = true));
    this.cancelBtn.hidden = false;
    this.progress.hidden = false;
    const bar = this.progress.firstElementChild as HTMLDivElement;
    const limit = this.me?.entitlement.limits.maxExportRows ?? null;
    const onProgress = (p: ExportProgress) => {
      bar.style.width = p.phase === 'done' ? '100%' : `${Math.min(95, limit ? (p.rows / limit) * 100 : 5 + (p.pages % 20) * 4.5)}%`;
      this.say(`${p.phase === 'finalizing' ? 'Building file' : 'Exporting'}… ${fmt(p.pages)} pages · ${fmt(p.rows)} rows · ${fmt(p.duplicates)} duplicates removed · ${fmt(p.filteredOut)} filtered out`);
    };
    try {
      const out = await runCursorExport(this.host, this.api, { entity: this.entity, query: this.query(), filters: this.filters(), columns: this.orderedSelection(), format }, { onProgress, signal: this.abort.signal });
      if (!out) {
        this.say('Export cancelled.');
        return;
      }
      clear(this.status);
      const link = h('a', { href: out.downloadUrl, target: '_blank', rel: 'noopener', 'data-testid': 'download-link', download: out.filename }, `Download ${out.filename}`);
      const stats = out.stats as { rows: number; duplicatesDropped: number; filteredOut: number };
      this.status.append(h('div', { class: 'hps-alert ok' }, `Export ready: ${fmt(stats.rows)} rows (${fmt(stats.duplicatesDropped)} duplicates removed, ${fmt(stats.filteredOut)} filtered out). `, link,
        h('span', { class: 'hps-muted' }, ` Link expires ${new Date(out.expiresAt).toLocaleTimeString()}.`)));
      if (out.upgrade) this.status.append(h('div', { class: 'hps-alert', 'data-testid': 'upgrade' }, `${out.upgrade.message} `, h('a', { href: out.upgrade.url, target: '_blank', rel: 'noopener' }, 'Upgrade to Pro ($19/mo)')));
      this.host.openUrl(out.downloadUrl);
    } catch (e) {
      const msg = e instanceof HpsApiError ? e.message : (e as Error).message;
      this.say(`Export failed: ${msg}`, 'error');
    } finally {
      this.exportBtns.forEach((b) => (b.disabled = false));
      this.cancelBtn.hidden = true;
      this.progress.hidden = true;
    }
  }
}
