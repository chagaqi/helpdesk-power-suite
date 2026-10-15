import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { strFromU8, unzipSync } from 'fflate';
import { parseCsv } from '@hps/core-api/export';
import { buildAll, launchBrowser, startServer, type RunningServer } from './helpers.js';

let server: RunningServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  buildAll();
  server = await startServer({ PLAYGROUND_RATE_LIMIT: '200' });
  browser = await launchBrowser();
  page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await page.goto(`${server.url}/playground`);
});

afterAll(async () => {
  await browser?.close();
  server?.stop();
});

describe('playground (headless Chromium against dist/server.mjs)', () => {
  it('exports 3,000 users past the 1,000-row wall with zero duplicates and suspended users filtered', async () => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.fill('[data-testid=pg-count]', '3000');
    await page.selectOption('[data-testid=pg-state]', 'active');
    await page.click('[data-testid=pg-export-csv]');
    await page.waitForSelector('[data-testid=pg-rows]');
    const rows = Number((await page.textContent('[data-testid=pg-rows]'))!.replace(/,/g, ''));
    expect(rows).toBeGreaterThan(2000);
    expect(Number((await page.textContent('[data-testid=pg-dups]'))!.replace(/,/g, ''))).toBeGreaterThan(0);
    expect(await page.textContent('[data-testid=pg-replayed]')).toBe('2');

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=pg-download]')]);
    const text = readFileSync((await download.path())!, 'utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM
    const csv = parseCsv(text);
    expect(csv.length - 1).toBe(rows);
    expect(new Set(csv.slice(1).map((r) => r[0])).size).toBe(rows);
    const state = csv[0]!.indexOf('State');
    expect(csv.slice(1).every((r) => r[state] === 'Active')).toBe(true);
    expect(csv[0]).toEqual(expect.arrayContaining(['Customer Plan', 'Licensed Seats', 'Renewal Date']));
    expect(errors).toEqual([]);
  });

  it('downloads a valid styled .xlsx and lets users resize preview columns', async () => {
    await page.selectOption('[data-testid=pg-entity]', 'ticket');
    await page.fill('[data-testid=pg-count]', '1200');
    await page.click('[data-testid=pg-export-xlsx]');
    await page.waitForSelector('[data-testid=pg-preview]');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=pg-download]')]);
    const bytes = new Uint8Array(readFileSync((await download.path())!));
    const parts = unzipSync(bytes);
    const sheet = strFromU8(parts['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<row r="1201">');
    expect(strFromU8(parts['xl/workbook.xml']!)).toContain('name="Tickets"');

    const th = page.locator('[data-testid=pg-preview] th').first();
    const before = (await th.boundingBox())!.width;
    const grip = (await page.locator('[data-testid=pg-grip]').first().boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + 150, grip.y + grip.height / 2, { steps: 5 });
    await page.mouse.up();
    expect((await th.boundingBox())!.width).toBeGreaterThan(before + 100);
  });

  it('evaluates name-based field rules per group/tag with priority overrides', async () => {
    await page.click('[data-testid=pg-evaluate]');
    await page.waitForSelector('[data-field="Internal Escalation Notes"]');
    expect(await page.textContent('[data-field="Internal Escalation Notes"]')).toContain('hidden');
    expect(await page.textContent('[data-field="Customer Tier"]')).toContain('required');
    await page.selectOption('[data-testid=pg-ctx-group]', 'Tier 2 Escalations');
    await page.click('[data-testid=pg-evaluate]');
    await page.waitForFunction(() => document.querySelector('[data-field="Internal Escalation Notes"]')?.textContent?.includes('shown'));
  });
});
