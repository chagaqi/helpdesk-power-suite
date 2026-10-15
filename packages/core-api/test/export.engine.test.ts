import { describe, expect, it } from 'vitest';
import { ExportSession, exportAll } from '../src/export/CursorExportEngine.js';
import { zendeskFieldSchema } from '../src/export/normalize/index.js';
import { parseCsv } from '../src/export/csv.js';
import { cursorPages, zendeskTicketFieldsRaw, zendeskTickets, zendeskUserFieldsRaw, zendeskUsers } from '../src/demo/synthetic.js';

const userSchema = zendeskFieldSchema('user', zendeskUserFieldsRaw());

describe('CursorExportEngine — >1,000 rows via cursor pagination', () => {
  it('exports 5,000 users across 50 cursor pages with zero duplicates (no 1,000-row wall)', () => {
    const users = zendeskUsers(5000);
    const pages = cursorPages(users, 100, 5); // 5-record overlap between pages, like shifting offset pagination
    const s = exportAll({ entity: 'user', source: 'zendesk', fieldSchema: userSchema }, pages);
    expect(s.stats.rows).toBe(5000);
    expect(s.stats.batches).toBe(50);
    expect(s.stats.duplicatesDropped).toBe(49 * 5);
    expect(s.stats.done).toBe(true);
    const csv = parseCsv(s.toCsv());
    expect(csv.length).toBe(5001);
    const ids = csv.slice(1).map((r) => r[0]);
    expect(new Set(ids).size).toBe(5000);
  });

  it('ignores replayed cursors (the tab-switching duplicate bug)', () => {
    const users = zendeskUsers(1200);
    const pages = cursorPages(users, 100);
    const s = new ExportSession({ entity: 'user', source: 'zendesk', fieldSchema: userSchema });
    s.ingest(pages[0]!);
    s.ingest(pages[1]!);
    // Agent switches tabs: the shell re-fetches page 1 and page 2.
    const replay1 = s.ingest(pages[0]!);
    const replay2 = s.ingest(pages[1]!);
    expect(replay1.replayed).toBe(true);
    expect(replay2.replayed).toBe(true);
    for (const p of pages.slice(2)) s.ingest(p);
    expect(s.stats.rows).toBe(1200);
    expect(s.stats.replayedBatches).toBe(2);
    expect(s.stats.duplicatesDropped).toBe(0);
  });

  it('dedupes the same ID re-sent under a new cursor and keeps the latest version', () => {
    const [u] = zendeskUsers(1);
    const s = new ExportSession({ entity: 'user', source: 'zendesk' });
    s.ingest({ cursor: null, nextCursor: 'a', records: [u] });
    const newer = { ...u!, name: 'Renamed', updated_at: '2030-01-01T00:00:00Z' };
    const older = { ...u!, name: 'Stale', updated_at: '2000-01-01T00:00:00Z' };
    const r = s.ingest({ cursor: 'a', nextCursor: 'b', records: [newer, older] });
    expect(r.duplicates).toBe(2);
    expect(r.updated).toBe(1);
    expect(s.stats.rows).toBe(1);
    const rows = [...s.rows()];
    const nameIdx = s.columns.findIndex((c) => c.key === 'name');
    expect(rows[0]![nameIdx]).toBe('Renamed');
  });

  it('drops a record whose newer version no longer matches the filter (suspended mid-export)', () => {
    const [u] = zendeskUsers(1, { suspendedEvery: 0 });
    const s = new ExportSession({ entity: 'user', source: 'zendesk', filters: { userState: 'active' } });
    s.ingest({ cursor: null, nextCursor: 'x', records: [u] });
    expect(s.size).toBe(1);
    s.ingest({ cursor: 'x', nextCursor: null, records: [{ ...u!, suspended: true, updated_at: '2031-01-01T00:00:00Z' }] });
    expect(s.size).toBe(0);
  });
});

describe('dedupe accounting', () => {
  it('counts re-sent copies of filtered-out records as duplicates, but admits a newer matching version', () => {
    const s = new ExportSession({ entity: 'user', source: 'zendesk', filters: { userState: 'active' } });
    const u = { id: 1, role: 'end-user', suspended: true, updated_at: '2024-01-01T00:00:00Z' };
    s.ingest({ cursor: null, nextCursor: 'a', records: [u] });
    const r = s.ingest({ cursor: 'a', nextCursor: 'b', records: [u] });
    expect(r).toMatchObject({ duplicates: 1, filteredOut: 0 });
    s.ingest({ cursor: 'b', nextCursor: null, records: [{ ...u, suspended: false, updated_at: '2024-02-01T00:00:00Z' }] });
    expect(s.stats).toMatchObject({ rows: 1, filteredOut: 1, duplicatesDropped: 2 });
  });
});

describe('filters', () => {
  const users = zendeskUsers(700);
  const run = (filters: ConstructorParameters<typeof ExportSession>[0]['filters']) =>
    exportAll({ entity: 'user', source: 'zendesk', fieldSchema: userSchema, filters }, cursorPages(users, 100));

  it('filters out suspended users', () => {
    const suspended = users.filter((u) => u.suspended).length;
    expect(suspended).toBeGreaterThan(50);
    const active = run({ userState: 'active' });
    expect(active.stats.rows).toBe(700 - suspended);
    const stateIdx = active.columns.findIndex((c) => c.key === 'state');
    expect([...active.rows()].every((r) => r[stateIdx] === 'Active')).toBe(true);
    expect(run({ userState: 'suspended' }).stats.rows).toBe(suspended);
  });

  it('filters by role (Agent / Admin / End-user)', () => {
    const admins = users.filter((u) => u.role === 'admin').length;
    const endUsers = users.filter((u) => u.role === 'end-user').length;
    expect(run({ roles: ['admin'] }).stats.rows).toBe(admins);
    expect(run({ roles: ['end_user'] }).stats.rows).toBe(endUsers);
    const agentsAll = users.filter((u) => u.role === 'agent').length;
    expect(run({ roles: ['agent', 'light_agent'] }).stats.rows).toBe(agentsAll);
  });

  it('filters by tag inclusion and exclusion', () => {
    const expected = users.filter((u) => u.tags.includes('vip') && !u.tags.includes('churn_risk')).length;
    expect(run({ tags: { any: ['VIP'], none: ['churn_risk'] } }).stats.rows).toBe(expected);
    const both = users.filter((u) => u.tags.includes('eu') && u.tags.includes('beta')).length;
    expect(run({ tags: { all: ['eu', 'beta'] } }).stats.rows).toBe(both);
  });

  it('filters by custom field using its human-readable title', () => {
    const gold = users.filter((u) => u.user_fields.plan === 'plan_gold').length;
    expect(run({ fieldFilters: [{ field: 'Customer Plan', op: 'eq', value: 'Gold' }] }).stats.rows).toBe(gold);
  });

  it('rejects unknown filter fields', () => {
    expect(() => run({ fieldFilters: [{ field: 'Nope', value: 'x' }] })).toThrow(/Unknown filter field/);
  });

  it('includes archived tickets by default and can exclude them', () => {
    const tickets = zendeskTickets(600, { archivedEvery: 1 });
    const archived = tickets.filter((t) => t.archived).length;
    expect(archived).toBeGreaterThan(0);
    const schema = zendeskFieldSchema('ticket', zendeskTicketFieldsRaw());
    const all = exportAll({ entity: 'ticket', source: 'zendesk', fieldSchema: schema }, cursorPages(tickets, 100));
    expect(all.stats.rows).toBe(600);
    const live = exportAll({ entity: 'ticket', source: 'zendesk', fieldSchema: schema, filters: { includeArchived: false } }, cursorPages(tickets, 100));
    expect(live.stats.rows).toBe(600 - archived);
    const closed = exportAll({ entity: 'ticket', source: 'zendesk', fieldSchema: schema, filters: { statuses: ['Closed'] } }, cursorPages(tickets, 100));
    expect(closed.stats.rows).toBe(tickets.filter((t) => t.status === 'closed').length);
  });
});

describe('custom field flattening by human-readable title', () => {
  it('uses field titles as headers and option labels as values', () => {
    const s = exportAll({ entity: 'user', source: 'zendesk', fieldSchema: userSchema }, cursorPages(zendeskUsers(60), 20));
    const labels = s.columns.map((c) => c.label);
    expect(labels).toEqual(expect.arrayContaining(['Customer Plan', 'Licensed Seats', 'Renewal Date', 'SSO Enabled']));
    expect(labels.some((l) => /^\d+$/.test(l))).toBe(false);
    const planIdx = s.columns.findIndex((c) => c.label === 'Customer Plan');
    expect(new Set([...s.rows()].map((r) => r[planIdx]))).toEqual(new Set(['Gold', 'Silver', 'Bronze']));
  });

  it('flattens ticket multiselects and tagger fields', () => {
    const schema = zendeskFieldSchema('ticket', zendeskTicketFieldsRaw());
    expect(schema.map((d) => d.title)).not.toContain('Subject');
    const s = exportAll({ entity: 'ticket', source: 'zendesk', fieldSchema: schema }, cursorPages(zendeskTickets(4), 10));
    const rows = [...s.rows()];
    const mods = s.columns.findIndex((c) => c.label === 'Affected Modules');
    const tier = s.columns.findIndex((c) => c.label === 'Customer Tier');
    expect(rows[0]![mods]).toBe('Billing; API');
    expect(rows[1]![mods]).toBeNull();
    expect(rows[0]![tier]).toBe('Enterprise');
  });

  it('supports sticky column presets by title and rejects unknown columns', () => {
    const s = new ExportSession({ entity: 'user', source: 'zendesk', fieldSchema: userSchema, columns: ['Email', 'Customer Plan', 'role', 'plan'] });
    expect(s.columns.map((c) => c.label)).toEqual(['Email', 'Customer Plan', 'Role']);
    expect(() => new ExportSession({ entity: 'user', source: 'zendesk', columns: ['Shoe Size'] })).toThrow(/Unknown export column/);
  });

  it('keeps custom fields missing from the schema under their raw key', () => {
    const s = new ExportSession({ entity: 'user', source: 'zendesk' });
    s.ingest({ records: [{ id: 1, name: 'x', role: 'end-user', user_fields: { mystery: 'v' } }], nextCursor: null });
    expect(s.columns.map((c) => c.label)).toContain('mystery');
  });
});

describe('row limits and bad input', () => {
  it('truncates at the plan row limit and reports it', () => {
    const s = exportAll({ entity: 'user', source: 'zendesk', rowLimit: 250 }, cursorPages(zendeskUsers(1000), 100));
    expect(s.stats.rows).toBe(250);
    expect(s.stats.truncated).toBe(750);
    expect(s.stats.limitReached).toBe(true);
  });

  it('rejects records without IDs without aborting the batch', () => {
    const s = new ExportSession({ entity: 'user', source: 'zendesk' });
    const r = s.ingest({ records: [{ name: 'no id' }, null, { id: 5, name: 'ok', role: 'end-user' }] });
    expect(r.rejected).toBe(2);
    expect(r.accepted).toBe(1);
    expect(r.errors[0]!.message).toMatch(/id/);
  });
});
