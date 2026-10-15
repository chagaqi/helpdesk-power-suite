import { createServerless, type FdkServerEnv } from './serverless.js';

/**
 * FDK serverless entry. The build wraps this IIFE and appends the `exports = {...}` block the FDK
 * runtime expects, delegating to these handlers with the runtime globals ($request, $db, renderData).
 */
declare const $request: FdkServerEnv['$request'];
declare const $db: FdkServerEnv['$db'];
declare function renderData(err?: unknown, data?: unknown): void;

const svc = () => createServerless({ $request, $db });
const fail = (e: unknown) => renderData({ status: 500, message: e instanceof Error ? e.message : String(e) });

export const handlers = {
  onAppInstallHandler(payload: { domain?: string; iparams?: Record<string, string> }) {
    svc()
      .onAppInstall(payload)
      .then((r) => ('message' in r ? renderData({ message: r.message }) : renderData()), (e) => renderData({ message: (e as Error).message }));
  },
  onAppUninstallHandler() {
    svc().onAppUninstall().finally(() => renderData());
  },
  hpsCall(args: Parameters<ReturnType<typeof createServerless>['hpsCall']>[0]) {
    svc().hpsCall(args).then((r) => renderData(null, r), fail);
  },
  fdPage(args: Parameters<ReturnType<typeof createServerless>['fdPage']>[0]) {
    svc().fdPage(args).then((r) => renderData(null, r), fail);
  },
  exportStep(args: Parameters<ReturnType<typeof createServerless>['exportStep']>[0]) {
    const s = svc();
    s.exportStep.call(s, args).then((r) => renderData(null, r), fail);
  },
};
