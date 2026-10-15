import { startEnforcer } from './enforce.js';

/** ticket_background / new_ticket_background: invisible, loads with the ticket page → no flicker. */
if (globalThis.app) {
  void globalThis.app.initialized().then((client) => startEnforcer(client));
}
