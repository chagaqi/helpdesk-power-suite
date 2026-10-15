import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createGateway } from './app.js';
import { loadConfig } from './config.js';

/** Entry point bundled into dist/server.mjs. */
async function main() {
  const cfg = loadConfig();
  const log = console;
  const gw = createGateway(cfg, {
    logger: log,
    remoteAddress: (c) => {
      try {
        return getConnInfo(c).remote.address;
      } catch {
        return undefined;
      }
    },
  });
  for (const w of cfg.warnings) log.warn(`[hps] warning: ${w}`);
  const server = serve({ fetch: gw.app.fetch, port: cfg.env.PORT, hostname: cfg.env.HOST }, (info) => {
    log.info(`[hps] Helpdesk Power Suite gateway listening on http://${info.address}:${info.port} (public ${cfg.publicBaseUrl}) store=${gw.storeKind} modules=${gw.mounted.join(',')}`);
  });
  const shutdown = (sig: string) => {
    log.info(`[hps] ${sig} received, shutting down`);
    server.close(() => {
      void gw.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error(`[hps] fatal: ${(e as Error).message}`);
  process.exit(1);
});
