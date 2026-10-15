/**
 * Deterministic synthetic Zendesk-shaped data for the playground, tests and demos.
 * Shapes mirror the real REST v2 payloads (users, ticket fields, tickets, cursor pagination).
 */

export function prng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Ada', 'Grace', 'Linus', 'Margaret', 'Alan', 'Katherine', 'Dennis', 'Barbara', 'Ken', 'Radia', 'José', 'Zoë', 'Søren', 'Chloé'];
const LAST = ['Lovelace', 'Hopper', 'Torvalds', 'Hamilton', 'Turing', 'Johnson', 'Ritchie', 'Liskov', 'Thompson', 'Perlman', 'Núñez', 'Ødegaard'];
const TAGS = ['vip', 'beta', 'churn_risk', 'enterprise', 'smb', 'eu', 'us', 'apac', 'newsletter'];
const PLANS = [
  { name: 'Gold', value: 'plan_gold' },
  { name: 'Silver', value: 'plan_silver' },
  { name: 'Bronze', value: 'plan_bronze' },
];

export const zendeskUserFieldsRaw = () => [
  { id: 9001, key: 'plan', title: 'Customer Plan', type: 'dropdown', active: true, custom_field_options: PLANS },
  { id: 9002, key: 'seats', title: 'Licensed Seats', type: 'integer', active: true },
  { id: 9003, key: 'renewal_date', title: 'Renewal Date', type: 'date', active: true },
  { id: 9004, key: 'sso_enabled', title: 'SSO Enabled', type: 'checkbox', active: true },
  { id: 9005, key: 'account_notes', title: 'Account Notes', type: 'textarea', active: true },
];

export const zendeskTicketFieldsRaw = () => [
  { id: 1, title: 'Subject', type: 'subject', active: true },
  { id: 2, title: 'Status', type: 'status', active: true },
  { id: 360001, title: 'Customer Tier', type: 'tagger', active: true, custom_field_options: [
    { name: 'Enterprise', value: 'tier_enterprise' }, { name: 'Business', value: 'tier_business' }, { name: 'Starter', value: 'tier_starter' },
  ] },
  { id: 360002, title: 'Refund Amount', type: 'decimal', active: true },
  { id: 360003, title: 'Affected Modules', type: 'multiselect', active: true, custom_field_options: [
    { name: 'Billing', value: 'mod_billing' }, { name: 'Reporting', value: 'mod_reporting' }, { name: 'API', value: 'mod_api' },
  ] },
  { id: 360004, title: 'Internal Escalation Notes', type: 'textarea', active: true },
  { id: 360005, title: 'Order Number', type: 'text', active: true },
];

const iso = (base: number, offsetDays: number) => new Date(base + offsetDays * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

export interface SyntheticUserOptions {
  seed?: number;
  /** Every Nth user is suspended (default 7). */
  suspendedEvery?: number;
  startId?: number;
}

export function zendeskUsers(n: number, o: SyntheticUserOptions = {}) {
  const rnd = prng(o.seed ?? 42);
  const base = Date.UTC(2023, 0, 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = (o.startId ?? 10_000) + i;
    const first = FIRST[Math.floor(rnd() * FIRST.length)]!;
    const last = LAST[Math.floor(rnd() * LAST.length)]!;
    const roleRoll = rnd();
    const role = roleRoll < 0.06 ? 'admin' : roleRoll < 0.2 ? 'agent' : 'end-user';
    const tags = TAGS.filter(() => rnd() < 0.2);
    const plan = PLANS[Math.floor(rnd() * PLANS.length)]!;
    out.push({
      id,
      url: `https://acme.zendesk.com/api/v2/users/${id}.json`,
      name: `${first} ${last}`,
      email: `${first}.${last}.${id}@example.com`.toLowerCase(),
      role,
      role_type: role === 'agent' && rnd() < 0.3 ? 1 : null,
      active: true,
      verified: rnd() > 0.1,
      suspended: (o.suspendedEvery ?? 7) > 0 && i % (o.suspendedEvery ?? 7) === 3,
      tags,
      organization_id: 500 + Math.floor(rnd() * 40),
      phone: rnd() < 0.5 ? `+1-555-${String(1000 + i).slice(-4)}` : null,
      time_zone: 'Eastern Time (US & Canada)',
      created_at: iso(base, i % 600),
      updated_at: iso(base, 600 + (i % 30)),
      last_login_at: rnd() < 0.7 ? iso(base, 640 + (i % 20)) : null,
      user_fields: {
        plan: plan.value,
        seats: Math.floor(rnd() * 500),
        renewal_date: iso(base, 700 + (i % 90)).slice(0, 10),
        sso_enabled: rnd() < 0.4,
        account_notes: i % 11 === 0 ? '=HYPERLINK("http://evil.example","click")' : i % 13 === 0 ? 'Multi-line\nnote, with "quotes"' : null,
      },
    });
  }
  return out;
}

export function zendeskTickets(n: number, o: { seed?: number; startId?: number; archivedEvery?: number } = {}) {
  const rnd = prng(o.seed ?? 7);
  const base = Date.UTC(2022, 5, 1);
  const statuses = ['new', 'open', 'pending', 'hold', 'solved', 'closed'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = (o.startId ?? 1) + i;
    const status = statuses[Math.floor(rnd() * statuses.length)]!;
    out.push({
      id,
      subject: `Issue #${id}: ${['Login fails', 'Refund request', 'API 500 errors', 'Invoice question', 'Feature request'][i % 5]}`,
      status,
      priority: ['low', 'normal', 'high', 'urgent'][Math.floor(rnd() * 4)],
      type: ['question', 'incident', 'problem', 'task'][Math.floor(rnd() * 4)],
      requester_id: 10_000 + Math.floor(rnd() * 1000),
      assignee_id: 20_000 + Math.floor(rnd() * 20),
      group_id: 300 + Math.floor(rnd() * 5),
      organization_id: 500 + Math.floor(rnd() * 40),
      brand_id: 1,
      ticket_form_id: 77,
      tags: TAGS.filter(() => rnd() < 0.25),
      via: { channel: ['email', 'web', 'api', 'chat'][i % 4] },
      archived: (o.archivedEvery ?? 0) > 0 && status === 'closed' && i % (o.archivedEvery ?? 1) === 0,
      created_at: iso(base, i % 700),
      updated_at: iso(base, 700 + (i % 50)),
      custom_fields: [
        { id: 360001, value: ['tier_enterprise', 'tier_business', 'tier_starter'][i % 3] },
        { id: 360002, value: i % 4 === 0 ? (rnd() * 300).toFixed(2) : null },
        { id: 360003, value: i % 2 === 0 ? ['mod_billing', 'mod_api'] : [] },
        { id: 360004, value: null },
        { id: 360005, value: `ORD-${100000 + i}` },
      ],
    });
  }
  return out;
}

export interface CursorPage<T> {
  cursor: string | null;
  nextCursor: string | null;
  records: T[];
}

/**
 * Splits records into cursor pages. `overlap` re-includes the last N records of the previous page
 * at the start of the next one — exactly what offset pagination does when data shifts mid-export.
 */
export function cursorPages<T>(records: T[], pageSize: number, overlap = 0): CursorPage<T>[] {
  const pages: CursorPage<T>[] = [];
  let cursor: string | null = null;
  for (let start = 0; start < records.length; start += pageSize) {
    const from = Math.max(0, start - (start > 0 ? overlap : 0));
    const end = Math.min(records.length, start + pageSize);
    const next: string | null = end < records.length ? `c_${end}` : null;
    pages.push({ cursor, nextCursor: next, records: records.slice(from, end) });
    cursor = next;
  }
  return pages;
}
