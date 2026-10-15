import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';

export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
let built = false;

/** Builds every workspace once (shell bundles + dist/server.mjs). */
export function buildAll() {
  if (built || process.env.HPS_E2E_SKIP_BUILD) return;
  execSync('npm run build --workspaces --if-present', { cwd: ROOT, stdio: 'pipe' });
  built = true;
}

export const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

export interface RunningServer {
  url: string;
  proc: ChildProcess;
  logs: string[];
  stop(): void;
}

/** Spawns the single-file bundle exactly as deployed: `node dist/server.mjs`. */
export async function startServer(env: Record<string, string> = {}): Promise<RunningServer> {
  const port = await freePort();
  const logs: string[] = [];
  const proc = spawn(process.execPath, [`${ROOT}packages/gateway/dist/server.mjs`], {
    env: { PATH: process.env.PATH, NODE_ENV: 'production', HPS_MASTER_SECRET: 'e2e-master-secret-0123456789abcdef0123', PORT: String(port), HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', (d) => logs.push(String(d)));
  proc.stderr!.on('data', (d) => logs.push(String(d)));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) return { url, proc, logs, stop: () => proc.kill('SIGTERM') };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error(`server did not start:\n${logs.join('')}`);
}

export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ executablePath: process.env.HPS_CHROMIUM ?? '/opt/pw-browsers/chromium', headless: true, args: ['--no-sandbox'] });
}

/** Signs a Polar (Standard Webhooks) event the way Polar does. */
export async function polarUpgrade(serverUrl: string, secret: string, tenant: string) {
  const body = JSON.stringify({ type: 'subscription.active', data: { id: `sub_${tenant}`, status: 'active', current_period_end: '2999-01-01T00:00:00Z', metadata: { tenant_key: tenant } } });
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', secret).update(`${id}.${ts}.${body}`).digest('base64');
  const r = await fetch(`${serverUrl}/v1/webhooks/polar`, { method: 'POST', headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }, body });
  if (r.status !== 202) throw new Error(`polar webhook failed ${r.status}`);
}
