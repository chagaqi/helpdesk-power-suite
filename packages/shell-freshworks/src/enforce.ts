import { HpsApiClient, RuleEnforcer } from '@hps/shell-kit';
import type { FdkClient } from './fdk.js';
import { FreshworksHost } from './fdkAdapter.js';

/** Starts the zero-flicker enforcer on a ticket page (used by ticket_background and new_ticket_background). */
export async function startEnforcer(client: FdkClient, host?: FreshworksHost) {
  const h = host ?? (await FreshworksHost.detect(client));
  const api = new HpsApiClient(h);
  const enforcer = new RuleEnforcer({
    ops: h.fieldOps(),
    storage: h.storage,
    user: await h.currentUser(),
    readTicket: (ids) => h.readTicket(ids),
    watch: (ids, cb) => h.watch(ids, cb),
    fetchRules: async (etag) => {
      const r = await api.rulesConfig(etag);
      return r ? { compiled: r.config.compiled, etag: r.etag } : null;
    },
  });
  // Block "Update" when a required field is empty (interceptable FDK event).
  client.events.on(
    'ticket.propertiesUpdated',
    (event: { helper: { done(): void; fail(msg: string): void } }) => {
      enforcer.validateSave().then(
        (problem) => (problem ? event.helper.fail(problem) : event.helper.done()),
        () => event.helper.done(),
      );
    },
    { intercept: true },
  );
  await enforcer.start();
  return enforcer;
}
