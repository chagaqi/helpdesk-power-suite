import { describe, expect, it } from 'vitest';
import { InstallService, tenantKey, zendeskSignedUrlVerifier } from '../src/auth/InstallService.js';
import { decodeJwt, signHs256, verifyHs256, verifyRs256 } from '../src/auth/jwt.js';
import { InMemoryUsageStore } from '../src/stores/InMemoryUsageStore.js';
import { bytesToBase64, bytesToBase64Url, utf8 } from '../src/util/encoding.js';

const MASTER = 'm'.repeat(48);
const admin = { id: '1', role: 'admin', groups: [{ id: '300', name: 'Tier 1' }] };
const agentUser = { id: '2', role: 'agent', groups: [] };

describe('JWT', () => {
  it('signs and verifies HS256, rejects alg=none, tampering, expiry and long lifetimes', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tok = await signHs256({ sub: 'x', aud: 'hps', exp: nowSec + 60, iat: nowSec }, 'secret');
    expect((await verifyHs256(tok, 'secret', { audience: 'hps' })).sub).toBe('x');
    await expect(verifyHs256(tok, 'other')).rejects.toThrow(/signature/);
    await expect(verifyHs256(tok, 'secret', { audience: 'nope' })).rejects.toThrow(/audience/);
    const [h, p] = tok.split('.');
    const none = `${bytesToBase64Url(utf8(JSON.stringify({ alg: 'none' })))}.${p}.`;
    await expect(verifyHs256(none, 'secret')).rejects.toThrow();
    await expect(verifyHs256(`${h}.${bytesToBase64Url(utf8(JSON.stringify({ sub: 'admin', exp: nowSec + 60 })))}.${tok.split('.')[2]}`, 'secret')).rejects.toThrow(/signature/);
    await expect(verifyHs256(await signHs256({ exp: nowSec - 3600 }, 's'), 's')).rejects.toThrow(/expired/);
    await expect(verifyHs256(await signHs256({ iat: nowSec, exp: nowSec + 86400 * 30 }, 's'), 's', { maxLifetimeSec: 3600 })).rejects.toThrow(/lifetime/);
    await expect(verifyHs256(await signHs256({ sub: 'no-exp' }, 's'), 's')).rejects.toThrow(/exp/);
    expect(() => decodeJwt('not.a.jwt')).toThrow(/malformed/);
  });

  it('verifies RS256 (Zendesk signed URLs) with a PEM public key', async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
    const pem = `-----BEGIN PUBLIC KEY-----\n${bytesToBase64(spki).match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`;
    const nowSec = Math.floor(Date.now() / 1000);
    const enc = (o: unknown) => bytesToBase64Url(utf8(JSON.stringify(o)));
    const input = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: 'acme.zendesk.com', exp: nowSec + 60, iat: nowSec, context: { account: { subdomain: 'acme' } } })}`;
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new Uint8Array(utf8(input))));
    const token = `${input}.${bytesToBase64Url(sig)}`;
    expect((await verifyRs256(token, pem)).iss).toBe('acme.zendesk.com');
    const verifier = zendeskSignedUrlVerifier(pem);
    expect(await verifier(token, 'acme')).toBe(true);
    expect(await verifier(token, 'bigcorp')).toBe(false);
  });
});

describe('InstallService (anti-spoofing)', () => {
  it('normalizes tenants from URLs and hosts', () => {
    expect(tenantKey('zendesk', 'https://Acme.zendesk.com/agent/tickets/1')).toBe('zendesk:acme');
    expect(tenantKey('freshdesk', 'globex.freshdesk.com')).toBe('freshdesk:globex');
    expect(tenantKey('freshdesk', 'support.globex.io')).toBe('freshdesk:support.globex.io');
    expect(() => tenantKey('zendesk', 'bad tenant!')).toThrow(/Invalid/);
  });

  it('first install mints a secret; tokens signed with it authenticate; principal comes from the token', async () => {
    const svc = new InstallService(new InMemoryUsageStore(), { masterSecret: MASTER });
    const reg = await svc.register({ platform: 'zendesk', tenant: 'acme.zendesk.com', installationId: 'inst1' });
    expect(reg).toMatchObject({ tenant: 'zendesk:acme', installationId: 'inst1', created: true });
    expect(reg.sharedSecret.length).toBeGreaterThanOrEqual(40);
    const tok = await svc.issueToken(reg.sharedSecret, reg.tenant, reg.installationId, admin);
    const p = await svc.verify(tok);
    expect(p).toMatchObject({ tenant: 'zendesk:acme', platform: 'zendesk', user: { id: '1', role: 'admin', groups: [{ id: '300', name: 'Tier 1' }] } });
  });

  it('blocks tenant squatting: re-register needs an admin token or platform proof', async () => {
    const svc = new InstallService(new InMemoryUsageStore(), { masterSecret: MASTER, platformProofs: { zendesk: async (tok, slug) => tok === 'valid-proof' && slug === 'acme' } });
    const first = await svc.register({ platform: 'zendesk', tenant: 'acme' });
    await expect(svc.register({ platform: 'zendesk', tenant: 'acme' })).rejects.toMatchObject({ code: 'conflict', status: 409 });
    const agentTok = await svc.issueToken(first.sharedSecret, first.tenant, first.installationId, agentUser);
    await expect(svc.register({ platform: 'zendesk', tenant: 'acme' }, { bearerToken: agentTok })).rejects.toMatchObject({ code: 'conflict' });
    const adminTok = await svc.issueToken(first.sharedSecret, first.tenant, first.installationId, admin);
    expect((await svc.register({ platform: 'zendesk', tenant: 'acme', installationId: 'second' }, { bearerToken: adminTok })).verifiedBy).toBe('existing_token');
    expect((await svc.register({ platform: 'zendesk', tenant: 'acme' }, { platformToken: 'valid-proof' })).verifiedBy).toBe('platform_proof');
    await expect(svc.register({ platform: 'zendesk', tenant: 'acme' }, { platformToken: 'forged' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects forged tenants, cross-tenant secrets, revoked installs and replayed jti', async () => {
    const svc = new InstallService(new InMemoryUsageStore(), { masterSecret: MASTER });
    const a = await svc.register({ platform: 'zendesk', tenant: 'acme' });
    const b = await svc.register({ platform: 'zendesk', tenant: 'bigcorp' });
    // Tenant A tries to impersonate B by putting B in `sub` but signing with A's secret.
    const forged = await signHs256({ aud: 'helpdesk-power-suite', sub: b.tenant, iid: b.installationId, exp: Math.floor(Date.now() / 1000) + 60, usr: admin }, a.sharedSecret);
    await expect(svc.verify(forged)).rejects.toMatchObject({ code: 'unauthorized' });
    const unknown = await signHs256({ aud: 'helpdesk-power-suite', sub: 'zendesk:ghost', iid: 'x', exp: Math.floor(Date.now() / 1000) + 60 }, a.sharedSecret);
    await expect(svc.verify(unknown)).rejects.toThrow(/Unknown installation/);
    const tok = await svc.issueToken(a.sharedSecret, a.tenant, a.installationId, admin);
    await svc.verify(tok);
    await expect(svc.verify(tok)).rejects.toThrow(/replayed/);
    await svc.revoke(a.tenant, a.installationId);
    await expect(svc.verify(await svc.issueToken(a.sharedSecret, a.tenant, a.installationId, admin))).rejects.toThrow(/revoked/);
  });

  it('sanitizes user claims (unknown roles become agent)', async () => {
    const svc = new InstallService(new InMemoryUsageStore(), { masterSecret: MASTER });
    const a = await svc.register({ platform: 'freshdesk', tenant: 'globex' });
    const tok = await svc.issueToken(a.sharedSecret, a.tenant, a.installationId, { id: '9', role: 'Super-Root', groups: ['7', { name: 'Billing' }] as never });
    expect((await svc.verify(tok)).user).toMatchObject({ role: 'agent', groups: [{ id: '7', name: '7' }, { name: 'Billing' }] });
  });
});
