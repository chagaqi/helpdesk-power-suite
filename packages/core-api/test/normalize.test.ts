import { describe, expect, it } from 'vitest';
import { freshworksFieldSchema, intercomFieldSchema, normalizeRecord, zendeskFieldSchema } from '../src/export/normalize/index.js';
import { exportAll } from '../src/export/CursorExportEngine.js';

describe('platform normalizers', () => {
  it('Zendesk users: roles, light agents, suspended and deleted', () => {
    expect(normalizeRecord('zendesk', 'user', { id: 1, role: 'admin' }).role).toBe('admin');
    expect(normalizeRecord('zendesk', 'user', { id: 2, role: 'agent', role_type: 1 }).role).toBe('light_agent');
    expect(normalizeRecord('zendesk', 'user', { id: 3, role: 'end-user', suspended: true }).suspended).toBe(true);
    expect(normalizeRecord('zendesk', 'user', { id: 4, role: 'end-user', active: false }).suspended).toBe(true);
    const u = normalizeRecord('zendesk', 'user', { id: 5, role: 'end-user', user_fields: { plan: 'gold' }, tags: ['a', 'a', 'b'] });
    expect(u.customFields).toEqual({ plan: 'gold' });
    expect(u.tags).toEqual(['a', 'b']);
  });

  it('Zendesk tickets & organizations', () => {
    const t = normalizeRecord('zendesk', 'ticket', { id: 9, status: 'closed', custom_fields: [{ id: 1, value: 'x' }], via: { channel: 'email' } });
    expect(t).toMatchObject({ id: '9', status: 'closed', customFields: { '1': 'x' }, fields: { channel: 'email' } });
    const o = normalizeRecord('zendesk', 'organization', { id: 3, name: 'Acme', domain_names: ['a.com', 'b.com'], organization_fields: { tier: 'gold' } });
    expect(o.fields.domains).toBe('a.com; b.com');
    expect(zendeskFieldSchema('user', [{ key: 'tier', title: 'Tier', type: 'dropdown', custom_field_options: [{ name: 'Gold', value: 'g' }] }])[0]).toMatchObject({ key: 'tier', title: 'Tier', type: 'dropdown' });
  });

  it('Freshdesk tickets: numeric status/priority/source mapping', () => {
    const t = normalizeRecord('freshdesk', 'ticket', { id: 1, status: 4, priority: 4, source: 3, custom_fields: { cf_tier: 'Gold' }, tags: ['x'] });
    expect(t.status).toBe('resolved');
    expect(t.fields.priority).toBe('urgent');
    expect(t.fields.channel).toBe('phone');
    expect(t.customFields).toEqual({ cf_tier: 'Gold' });
  });

  it('Freshdesk contacts vs agents; deleted/blocked/deactivated are suspended', () => {
    expect(normalizeRecord('freshdesk', 'user', { id: 1, name: 'C', active: false }).suspended).toBe(false); // unverified, not suspended
    expect(normalizeRecord('freshdesk', 'user', { id: 1, name: 'C', deleted: true }).suspended).toBe(true);
    const agent = normalizeRecord('freshdesk', 'user', { id: 2, occasional: true, ticket_scope: 1, contact: { name: 'A', email: 'a@x.com' } });
    expect(agent.role).toBe('light_agent');
    expect(agent.fields.email).toBe('a@x.com');
    expect(normalizeRecord('freshdesk', 'user', { id: 3, ticket_scope: 1, role_names: ['Account Administrator'], contact: {} }).role).toBe('admin');
    expect(normalizeRecord('freshservice', 'user', { id: 4, first_name: 'F', last_name: 'S', primary_email: 'f@s.io', active: false }).suspended).toBe(true);
    expect(freshworksFieldSchema([{ name: 'cf_tier', label: 'Tier', type: 'custom_dropdown', choices: ['Gold', 'Silver'] }, { name: 'status', label: 'Status', type: 'default_status', default: true }])).toEqual([
      { key: 'cf_tier', title: 'Tier', type: 'dropdown', options: [{ value: 'Gold', label: 'Gold' }, { value: 'Silver', label: 'Silver' }] },
    ]);
  });

  it('Gorgias tickets, customers and users', () => {
    const t = normalizeRecord('gorgias', 'ticket', { id: 1, status: 'open', tags: [{ name: 'vip' }], customer: { id: 7, email: 'c@x.com' }, created_datetime: '2024-01-01T00:00:00Z' });
    expect(t).toMatchObject({ tags: ['vip'], fields: { requester_email: 'c@x.com' }, createdAt: '2024-01-01T00:00:00.000Z' });
    expect(normalizeRecord('gorgias', 'user', { id: 2, email: 'c@x.com' }).role).toBe('end_user');
    expect(normalizeRecord('gorgias', 'user', { id: 3, role: { name: 'admin' }, active: false })).toMatchObject({ role: 'admin', suspended: true });
    expect(() => normalizeRecord('gorgias', 'organization', { id: 1 })).toThrow(/no organization/);
  });

  it('Intercom contacts (unix timestamps), companies and conversations', () => {
    const c = normalizeRecord('intercom', 'user', { type: 'contact', id: 'abc', role: 'lead', created_at: 1700000000, tags: { data: [{ id: '1', name: 'trial' }] }, custom_attributes: { plan: 'pro' } });
    expect(c).toMatchObject({ id: 'abc', role: 'lead', tags: ['trial'], customFields: { plan: 'pro' }, createdAt: '2023-11-14T22:13:20.000Z' });
    expect(normalizeRecord('intercom', 'user', { type: 'admin', id: 'x' }).role).toBe('agent');
    expect(normalizeRecord('intercom', 'organization', { type: 'company', id: 'co', name: 'Acme', tags: { tags: [{ name: 'big' }] } }).tags).toEqual(['big']);
    expect(normalizeRecord('intercom', 'ticket', { type: 'conversation', id: 'cv', state: 'open', title: 'Help' }).fields.subject).toBe('Help');
    expect(intercomFieldSchema([{ name: 'plan', label: 'Plan', data_type: 'string', custom: true }, { name: 'email', custom: false }])).toHaveLength(1);
  });

  it('generic accepts pre-normalized records and validates entity', () => {
    const r = normalizeRecord('generic', 'user', { id: 1, fields: { email: 'a@b.c', nested: { x: 1 } }, suspended: true, role: 'agent' });
    expect(r.fields).toEqual({ email: 'a@b.c', nested: '{"x":1}' });
    expect(() => normalizeRecord('generic', 'user', { id: 1, entity: 'ticket' })).toThrow(/expected "user"/);
  });

  it('every platform export flows through the same engine', () => {
    const s = exportAll({ entity: 'user', source: 'freshdesk', filters: { userState: 'active' } }, [
      { cursor: null, nextCursor: 'p2', records: [{ id: 1, name: 'A' }, { id: 2, name: 'B', deleted: true }] },
      { cursor: 'p2', nextCursor: null, records: [{ id: 1, name: 'A' }, { id: 3, name: 'C' }] },
    ]);
    expect(s.stats).toMatchObject({ rows: 2, duplicatesDropped: 1, filteredOut: 1 });
  });
});
