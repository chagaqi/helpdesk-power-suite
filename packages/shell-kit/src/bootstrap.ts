import { HpsApiClient, HpsApiError, type MeResponse } from './api.js';
import type { HostAdapter, HostUser } from './types.js';

export type InstallState = { state: 'ready'; me: MeResponse } | { state: 'needs_admin' } | { state: 'error'; message: string };

/**
 * Ensures this helpdesk is registered with HPS. The first admin to open the app registers the
 * tenant and stores the one-time shared secret in the platform's secure settings; agents opened
 * before that see a friendly "ask your admin" message.
 */
export async function ensureInstalled(host: HostAdapter, api: HpsApiClient, user: HostUser): Promise<InstallState> {
  try {
    return { state: 'ready', me: await api.me() };
  } catch (e) {
    if (!(e instanceof HpsApiError) || e.status !== 401) return { state: 'error', message: (e as Error).message };
  }
  if (user.role !== 'admin' || !host.installRequest || !host.saveSecret) return { state: 'needs_admin' };
  try {
    const tenant = await host.tenant();
    const installationId = await host.installationId?.();
    const res = await host.installRequest({ platform: host.platform, tenant, installationId });
    if (res.status >= 400) {
      const err = (res.data as unknown as { error?: { message?: string } }).error;
      return { state: 'error', message: err?.message ?? `Install failed (HTTP ${res.status})` };
    }
    await host.saveSecret(res.data.sharedSecret, res.data.installationId);
    return { state: 'ready', me: await api.me() };
  } catch (e) {
    return { state: 'error', message: (e as Error).message };
  }
}
