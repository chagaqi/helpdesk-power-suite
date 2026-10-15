import type { Primitive } from '@hps/core-api';
import { h } from '../dom.js';
import type { KeyValueStorage } from '../types.js';

export interface TableColumn {
  key: string;
  label: string;
}

/**
 * Data grid with drag-to-resize columns (fixes "cannot resize columns"). Widths persist per
 * `storageKey` so each agent's layout sticks across sessions. Double-click a handle to auto-fit.
 */
export class ResizableTable {
  readonly el: HTMLDivElement;
  private widths: Record<string, number>;

  constructor(
    private readonly columns: TableColumn[],
    private readonly rows: Primitive[][],
    private readonly storage: KeyValueStorage,
    private readonly storageKey: string,
  ) {
    this.widths = this.load();
    this.el = h('div', { class: 'hps-table-wrap', 'data-testid': 'results-table' });
    this.render();
  }

  private load(): Record<string, number> {
    try {
      return JSON.parse(this.storage.get(this.storageKey) ?? '{}') as Record<string, number>;
    } catch {
      return {};
    }
  }

  private save() {
    this.storage.set(this.storageKey, JSON.stringify(this.widths));
  }

  widthOf(key: string): number {
    return this.widths[key] ?? Math.min(320, Math.max(90, (this.columns.find((c) => c.key === key)?.label.length ?? 10) * 8 + 24));
  }

  /** Programmatic resize (also used by keyboard handlers and tests). */
  setWidth(key: string, px: number) {
    const w = Math.max(48, Math.min(1200, Math.round(px)));
    this.widths[key] = w;
    const col = this.el.querySelector<HTMLTableColElement>(`col[data-key="${CSS.escape(key)}"]`);
    if (col) col.style.width = `${w}px`;
    this.save();
  }

  private render() {
    const colgroup = h('colgroup', {}, this.columns.map((c) => {
      const col = h('col', { 'data-key': c.key });
      col.style.width = `${this.widthOf(c.key)}px`;
      return col;
    }));
    const head = h('tr', {}, this.columns.map((c) => {
      const handle = h('span', { class: 'hps-resize', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': `Resize ${c.label}`, tabindex: 0, 'data-resize': c.key });
      this.bindResize(handle, c.key);
      const th = h('th', { title: c.label, scope: 'col' }, c.label, handle);
      th.style.position = 'sticky';
      return th;
    }));
    const body = this.rows.map((r) =>
      h('tr', {}, this.columns.map((_c, i) => {
        const v = r[i];
        const text = v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
        return h('td', { title: text }, text);
      })),
    );
    this.el.appendChild(h('table', { class: 'hps-table' }, colgroup, h('thead', {}, head), h('tbody', {}, body)));
  }

  private bindResize(handle: HTMLElement, key: string) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      // Start from the rendered width: the table stretches columns to fill its container.
      const start = Math.round(handle.parentElement?.getBoundingClientRect().width || this.widthOf(key));
      handle.classList.add('active');
      handle.setPointerCapture?.(e.pointerId);
      const move = (ev: PointerEvent) => this.setWidth(key, start + ev.clientX - startX);
      const up = () => {
        handle.classList.remove('active');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('keydown', (e) => {
      const current = Math.round(handle.parentElement?.getBoundingClientRect().width || this.widthOf(key));
      if (e.key === 'ArrowRight') this.setWidth(key, current + 16);
      if (e.key === 'ArrowLeft') this.setWidth(key, current - 16);
    });
    handle.addEventListener('dblclick', () => {
      const i = this.columns.findIndex((c) => c.key === key);
      const longest = this.rows.reduce((m, r) => Math.max(m, String(r[i] ?? '').length), this.columns[i]!.label.length);
      this.setWidth(key, Math.min(600, longest * 7.5 + 28));
    });
  }
}
