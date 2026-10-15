import { mountPowerSuite } from '@hps/shell-kit';
import { FreshworksHost } from './fdkAdapter.js';

/** full_page_app: Advanced Search & Export + Visual Rule Builder, framed in Crayons. */
async function main() {
  const root = document.getElementById('app')!;
  if (!globalThis.app) {
    root.textContent = 'This page must be opened inside Freshdesk or Freshservice.';
    return;
  }
  const client = await globalThis.app.initialized();
  const host = await FreshworksHost.detect(client);
  await mountPowerSuite(root, host, {
    title: 'Power Search, Export & Field Rules',
    // Align with Crayons tokens.
    css: ':root{--hps-accent:#2c5cc5;--hps-fg:#12344d;--hps-border:#cfd7df}.hps{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
  });
}

main().catch((e) => {
  const root = document.getElementById('app');
  if (root) root.textContent = `Helpdesk Power Suite failed to start: ${(e as Error).message}`;
});
