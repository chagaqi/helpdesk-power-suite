import { describeRule, HpsApiClient } from '@hps/shell-kit';
import { evaluateCompiled } from '@hps/core-api/rules';
import { FreshworksHost } from './fdkAdapter.js';

/** ticket_sidebar: shows which field rules apply to the current agent on this ticket (enforcement runs in background). */
async function main() {
  const out = document.getElementById('rules')!;
  if (!globalThis.app) return;
  const client = await globalThis.app.initialized();
  const host = await FreshworksHost.detect(client);
  const api = new HpsApiClient(host);
  const [cfg, user] = await Promise.all([api.rulesConfig(), host.currentUser()]);
  if (!cfg) return;
  const fieldIds = Object.keys(cfg.config.compiled.fields);
  const ev = evaluateCompiled(cfg.config.compiled, { user, ticket: await host.readTicket(fieldIds) });
  const applied = cfg.config.compiled.rules.filter((r) => ev.matchedRuleIds.includes(r.id));
  out.textContent = '';
  if (!applied.length) {
    out.textContent = 'No field rules apply to you on this ticket.';
  } else {
    for (const r of applied) {
      const li = document.createElement('li');
      li.textContent = `${r.name}: ${describeRule(r)}`;
      out.appendChild(li);
    }
  }
  client.instance?.resize({ height: `${Math.min(400, 60 + applied.length * 40)}px` });
}

main().catch((e) => {
  const out = document.getElementById('rules');
  if (out) out.textContent = `Field rules unavailable: ${(e as Error).message}`;
});
