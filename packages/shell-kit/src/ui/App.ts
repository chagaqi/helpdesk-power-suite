import { HpsApiClient, type MeResponse } from '../api.js';
import { ensureInstalled } from '../bootstrap.js';
import { clear, h, injectStyles } from '../dom.js';
import type { HostAdapter } from '../types.js';
import { RuleBuilderView } from './RuleBuilderView.js';
import { SearchView } from './SearchView.js';
import { KIT_CSS } from './styles.js';

export interface MountOptions {
  /** Extra CSS (e.g. platform theme tweaks). */
  css?: string;
  title?: string;
}

/** Mounts the full-page app (Advanced Search & Export + Field Rules) into `root`. */
export async function mountPowerSuite(root: HTMLElement, host: HostAdapter, opts: MountOptions = {}) {
  injectStyles(KIT_CSS + (opts.css ?? ''));
  root.classList.add('hps');
  clear(root);
  root.append(h('p', { class: 'hps-muted', 'data-testid': 'loading' }, 'Loading Helpdesk Power Suite…'));
  const api = new HpsApiClient(host);
  const user = await host.currentUser();
  const install = await ensureInstalled(host, api, user);
  clear(root);
  if (install.state === 'needs_admin') {
    root.append(h('div', { class: 'hps-alert', 'data-testid': 'needs-admin' }, 'Helpdesk Power Suite is not activated yet. Ask an admin to open this app once to finish setup.'));
    return;
  }
  if (install.state === 'error') {
    root.append(h('div', { class: 'hps-alert error', 'data-testid': 'install-error' }, `Could not connect to Helpdesk Power Suite: ${install.message}`));
    return;
  }
  const me: MeResponse = install.me;
  const tenant = me.tenant;
  const isAdmin = user.role === 'admin';
  const plan = me.entitlement.effectivePlan;

  const panels: Record<string, () => HTMLElement> = {
    search: () => new SearchView(host, api, me, tenant).el,
  };
  if (isAdmin) {
    panels.rules = () => {
      const v = new RuleBuilderView(host, api);
      void v.load();
      return v.el;
    };
  }
  const body = h('div', { 'data-testid': 'panel' });
  const tabs = Object.keys(panels).map((k) =>
    h('button', { class: 'hps-tab', role: 'tab', 'aria-selected': 'false', 'data-tab': k, onclick: () => select(k) }, k === 'search' ? 'Advanced Search & Export' : 'Field Rules'),
  );
  const cache = new Map<string, HTMLElement>();
  const select = (k: string) => {
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === k)));
    clear(body);
    if (!cache.has(k)) cache.set(k, panels[k]!());
    body.append(cache.get(k)!);
    host.storage.set(`hps:${tenant}:tab`, k);
  };
  root.append(
    h('div', { class: 'hps-row', style: 'justify-content:space-between' },
      h('h2', { style: 'margin:0' }, opts.title ?? 'Helpdesk Power Suite'),
      h('span', { class: `hps-badge ${plan === 'pro' ? 'pro' : ''}`, 'data-testid': 'plan' }, plan === 'pro' ? 'Pro' : 'Free plan')),
    h('div', { class: 'hps-tabs', role: 'tablist' }, tabs),
    body,
  );
  const last = host.storage.get(`hps:${tenant}:tab`);
  select(last && panels[last] ? last : 'search');
}
