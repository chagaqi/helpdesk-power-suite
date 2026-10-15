import { RuleEnforcer, HpsApiClient } from '@hps/shell-kit';
import { ZendeskHost } from './zafAdapter.js';
import type { ZafClient } from './zaf.js';

/**
 * ticket_sidebar / new_ticket_sidebar: zero-flicker field rule enforcer.
 * Cached compiled rules are applied the moment the ticket opens (no API round-trip), then
 * revalidated with an ETag. Required fields are enforced on `ticket.save`.
 */
export async function startEnforcer(client: ZafClient, statusEl?: HTMLElement | null) {
  const host = new ZendeskHost(client);
  const api = new HpsApiClient(host);
  const user = await host.currentUser();
  const enforcer = new RuleEnforcer({
    ops: host.fieldOps(),
    storage: host.storage,
    user,
    readTicket: (ids) => host.readTicket(ids),
    watch: (ids, cb) => host.watch(ids, cb),
    fetchRules: async (etag) => {
      const r = await api.rulesConfig(etag);
      return r ? { compiled: r.config.compiled, etag: r.etag } : null;
    },
    onError: () => statusEl && (statusEl.textContent = 'Using cached field rules (service unreachable).'),
  });
  client.on('ticket.save', async () => {
    const problem = await enforcer.validateSave();
    if (problem) return Promise.reject(problem);
    return true;
  });
  await enforcer.start();
  if (statusEl) {
    const n = Object.keys(enforcer.evaluation?.fields ?? {}).length;
    statusEl.textContent = n ? `Field rules active: ${n} field${n === 1 ? '' : 's'} adjusted for you.` : 'No field rules apply to this ticket.';
  }
  void client.invoke('resize', { width: '100%', height: '40px' });
  return enforcer;
}

const client = typeof window !== 'undefined' ? window.ZAFClient?.init() : undefined;
if (client) void startEnforcer(client, document.getElementById('status'));
