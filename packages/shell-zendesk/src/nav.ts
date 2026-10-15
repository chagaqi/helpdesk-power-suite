import { mountPowerSuite } from '@hps/shell-kit';
import { ZendeskHost } from './zafAdapter.js';

/** nav_bar location: Advanced Cursor Search & Export + Visual Field Rule Admin. */
async function main() {
  const root = document.getElementById('app')!;
  const client = window.ZAFClient?.init();
  if (!client) {
    root.textContent = 'This page must be opened inside Zendesk Support.';
    return;
  }
  const host = new ZendeskHost(client);
  await mountPowerSuite(root, host, { title: 'Power Search, Export & Field Rules' });
}

main().catch((e) => {
  const root = document.getElementById('app');
  if (root) root.textContent = `Helpdesk Power Suite failed to start: ${(e as Error).message}`;
});
