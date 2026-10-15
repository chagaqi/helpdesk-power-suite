import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { parseCsv } from '@hps/core-api/export';
import { buildAll, launchBrowser, polarUpgrade, ROOT, startServer, type RunningServer } from './helpers.js';

const POLAR = 'e2e-polar-secret';
const API = 'https://api.test';
const ASSETS = `${ROOT}packages/shell-zendesk/assets/`;
const FAKE_ZAF = readFileSync(new URL('./fakeZafBrowser.js', import.meta.url), 'utf8');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

let server: RunningServer;
let browser: Browser;
let ctx: BrowserContext;

/** Wires the context like Zendesk: app assets on an https origin, the ZAF SDK swapped for the fake, API via https. */
async function zendeskContext(): Promise<BrowserContext> {
  const c = await browser.newContext();
  await c.route('https://app.test/**', (route) => {
    const file = new URL(route.request().url()).pathname.slice(1) || 'nav.html';
    route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(ASSETS + file) });
  });
  await c.route('https://static.zdassets.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_ZAF }));
  await c.route(`${API}/**`, async (route) => {
    const u = new URL(route.request().url());
    const res = await route.fetch({ url: `${server.url}${u.pathname}${u.search}` });
    await route.fulfill({ response: res });
  });
  return c;
}

async function open(page: Page, file: string, fake: Record<string, unknown>) {
  await page.addInitScript((f) => ((window as unknown as { __FAKE_ZAF__: unknown }).__FAKE_ZAF__ = f), { apiBase: API, ...fake });
  await page.goto(`https://app.test/${file}`);
}

beforeAll(async () => {
  buildAll();
  server = await startServer({ PUBLIC_BASE_URL: API, POLAR_WEBHOOK_SECRET: POLAR, PLAYGROUND_ENABLED: '0' });
  browser = await launchBrowser();
  ctx = await zendeskContext();
});

afterAll(async () => {
  await browser?.close();
  server?.stop();
});

describe('Zendesk ZAF app (real bundles in Chromium, fake ZAF + proxy, real gateway)', () => {
  it('nav_bar: admin first run installs, previews with resizable sticky columns and exports 1,500+ users via cursor', async () => {
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await open(page, 'nav.html', { role: 'admin', location: 'nav_bar' });
    await page.waitForSelector('[data-testid=plan]');
    expect(await page.textContent('[data-testid=plan]')).toBe('Free plan');
    const secret = await page.evaluate(() => JSON.parse(localStorage.getItem('__fake_zd_installation_settings') || '{}').shared_secret);
    expect(secret?.length).toBeGreaterThan(30);

    await polarUpgrade(server.url, POLAR, 'zendesk:acme');
    await page.reload();
    await page.waitForSelector('[data-testid=plan]');
    expect(await page.textContent('[data-testid=plan]')).toBe('Pro');

    await page.selectOption('[data-testid=entity]', 'user');
    await page.waitForSelector('[data-col="Customer Plan"]', { state: 'attached' }); // inside the collapsed presets panel
    await page.click('[data-testid=preview]');
    await page.waitForSelector('[data-testid=results-table] tbody tr');
    expect(await page.locator('[data-testid=results-table] tbody tr').count()).toBe(100);
    expect(await page.locator('[data-testid=results-table] th').allTextContents()).toContain('Customer Plan');

    const th = page.locator('[data-testid=results-table] th').nth(2);
    const before = (await th.boundingBox())!.width;
    const handle = (await page.locator('[data-resize]').nth(2).boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 200, handle.y + handle.height / 2, { steps: 6 });
    await page.mouse.up();
    const after = (await th.boundingBox())!.width;
    expect(after).toBeGreaterThan(before + 150);
    expect(after).toBeLessThan(before + 250); // follows the pointer, no jump
    const saved = await page.evaluate(() => Object.keys(localStorage).find((k) => k.includes(':widths:user')));
    expect(saved).toBeTruthy();
    // Sticky: the width survives a reload.
    await page.reload();
    await page.waitForSelector('[data-col="Customer Plan"]', { state: 'attached' });
    await page.click('[data-testid=preview]');
    await page.waitForSelector('[data-testid=results-table] tbody tr');
    expect(Math.abs((await page.locator('[data-testid=results-table] th').nth(2).boundingBox())!.width - after)).toBeLessThan(3);

    await page.selectOption('[data-testid=user-state]', 'active');
    await page.click('[data-testid=export-csv]');
    const link = await page.waitForSelector('[data-testid=download-link]', { timeout: 60_000 });
    const href = (await link.getAttribute('href'))!;
    const csv = parseCsv(await (await fetch(href.replace(API, server.url))).text());
    const expected = Array.from({ length: 1800 }, (_, i) => i).filter((i) => i % 7 !== 3).length;
    expect(csv.length - 1).toBe(expected);
    expect(new Set(csv.slice(1).map((r) => r[0])).size).toBe(expected);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('nav_bar Field Rules: admin builds a rule by picking the field by name', async () => {
    const page = await ctx.newPage();
    await open(page, 'nav.html', { role: 'admin', location: 'nav_bar' });
    await page.click('[data-tab=rules]');
    await page.waitForSelector('[data-testid=rule-form] [data-testid=action-field] option:has-text("Internal Escalation Notes")', { state: 'attached' });
    const fieldLabels = await page.locator('[data-testid=action-field] option').allTextContents();
    expect(fieldLabels.some((l) => /^\d+$/.test(l))).toBe(false); // never raw IDs
    await page.fill('[data-testid=rule-name]', 'Tier 1 cannot see escalation notes');
    await page.selectOption('[data-testid=rule-groups]', ['Tier 1 Support']);
    await page.selectOption('[data-testid=action-type]', 'hide');
    await page.selectOption('[data-testid=action-field]', { label: 'Internal Escalation Notes' });
    await page.click('[data-testid=save-rule]');
    await page.waitForSelector('[data-rule="Tier 1 cannot see escalation notes"]');
    expect(await page.textContent('[data-rule="Tier 1 cannot see escalation notes"]')).toContain('When agent in Tier 1 Support → hide Internal Escalation Notes');

    await page.fill('[data-testid=preview-groups]', 'Tier 1 Support');
    await page.click('[data-testid=run-preview]');
    await page.waitForSelector('[data-preview-field="Internal Escalation Notes"]');
    expect(await page.textContent('[data-preview-field="Internal Escalation Notes"]')).toContain('hidden');
    await page.close();
  });

  it('ticket_sidebar: enforces the rule, then hides from cache BEFORE the rules request returns (zero flicker)', async () => {
    const agent = { role: 'agent', location: 'ticket_sidebar', groups: [{ id: 300, name: 'Tier 1 Support' }], ticket: { 'ticket.tags': [] } };
    const first = await ctx.newPage();
    await open(first, 'sidebar.html', agent);
    await first.waitForFunction(() => (window as any).__zafLog?.some((e: { op: string }) => e.op === 'ticketFields:custom_field_360004.hide'));
    await first.waitForFunction(() => /Field rules active/.test(document.getElementById('status')?.textContent ?? ''));
    await first.close();

    const second = await ctx.newPage();
    await open(second, 'sidebar.html', { ...agent, delayRulesMs: 1500 });
    await second.waitForFunction(() => (window as any).__zafLog?.some((e: { op: string }) => e.op === 'rules-config-response'), undefined, { timeout: 10_000 });
    const log = (await second.evaluate(() => (window as any).__zafLog)) as { t: number; op: string }[];
    const hide = log.find((e) => e.op === 'ticketFields:custom_field_360004.hide')!;
    const fetched = log.find((e) => e.op === 'rules-config-response')!;
    expect(hide.t).toBeLessThan(fetched.t); // applied from the local cache, no network wait
    expect(fetched.t - hide.t).toBeGreaterThan(1000);
    expect(log.filter((e) => e.op === 'ticketFields:custom_field_360004.hide')).toHaveLength(1); // 304: no re-apply
    await second.close();

    // Tier 2 agents are unaffected.
    const tier2 = await ctx.newPage();
    await open(tier2, 'sidebar.html', { ...agent, groups: [{ id: 301, name: 'Tier 2 Escalations' }] });
    await tier2.waitForFunction(() => /No field rules apply/.test(document.getElementById('status')?.textContent ?? ''));
    // The cached Tier-1 state is per-evaluation, so nothing was hidden for this agent.
    expect(((await tier2.evaluate(() => (window as any).__zafLog)) as { op: string }[]).some((e) => e.op.endsWith('.hide'))).toBe(false);
  });
});
