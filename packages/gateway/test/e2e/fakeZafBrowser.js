// In-browser stand-in for https://static.zdassets.com/zendesk_app_framework_sdk/2.0/zaf_sdk.min.js.
// Emulates: ZAF client API, Zendesk REST (cursor pagination), installation settings persistence,
// and the request proxy (`secure: true` + `jwt` => secret substituted and JWT signed outside the app).
(() => {
  const cfg = window.__FAKE_ZAF__ || {};
  const log = (window.__zafLog = window.__zafLog || []);
  const t0 = performance.now();
  const handlers = {};
  const enc = new TextEncoder();
  const SETTINGS_KEY = '__fake_zd_installation_settings';
  const settings = () => JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  async function signJwt(payload, secret) {
    const h = b64u(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const p = b64u(enc.encode(JSON.stringify(payload)));
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return `${h}.${p}.${b64u(await crypto.subtle.sign('HMAC', key, enc.encode(`${h}.${p}`)))}`;
  }
  const N = cfg.users || 1800;
  const users = Array.from({ length: N }, (_, i) => ({
    id: 10000 + i,
    name: `User ${i}`,
    email: `user${i}@example.com`,
    role: i % 10 === 0 ? 'admin' : i % 5 === 0 ? 'agent' : 'end-user',
    suspended: i % 7 === 3,
    active: true,
    tags: i % 4 === 0 ? ['vip'] : [],
    user_fields: { plan: ['plan_gold', 'plan_silver'][i % 2], seats: i % 50 },
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-06-01T00:00:00Z',
  }));
  const REST = {
    '/api/v2/user_fields.json': { user_fields: [
      { key: 'plan', title: 'Customer Plan', type: 'dropdown', custom_field_options: [{ name: 'Gold', value: 'plan_gold' }, { name: 'Silver', value: 'plan_silver' }] },
      { key: 'seats', title: 'Licensed Seats', type: 'integer' }], next_page: null },
    '/api/v2/ticket_fields.json': { ticket_fields: [
      { id: 1, title: 'Subject', type: 'subject' }, { id: 3, title: 'Priority', type: 'priority' },
      { id: 360001, title: 'Customer Tier', type: 'tagger', custom_field_options: [{ name: 'Enterprise', value: 'tier_enterprise' }] },
      { id: 360004, title: 'Internal Escalation Notes', type: 'textarea' }], next_page: null },
    '/api/v2/organization_fields.json': { organization_fields: [], next_page: null },
    '/api/v2/groups.json': { groups: [{ id: 300, name: 'Tier 1 Support' }, { id: 301, name: 'Tier 2 Escalations' }], next_page: null },
    '/api/v2/ticket_forms.json': { ticket_forms: [{ id: 77, name: 'Default' }] },
    '/api/v2/brands.json': { brands: [{ id: 1, name: 'Acme' }] },
  };
  function zendesk(url, type, data) {
    const u = new URL(url, 'https://acme.zendesk.com');
    if (u.pathname === '/api/v2/users.json') {
      const size = Number(u.searchParams.get('page[size]') || 100);
      const after = Number(u.searchParams.get('page[after]') || 0);
      return { users: users.slice(after, after + size), meta: { has_more: after + size < N, after_cursor: String(after + size) } };
    }
    if (u.pathname === '/api/v2/apps/installations/42.json' && type === 'PUT') {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings(), ...JSON.parse(data).settings }));
      return { id: 42 };
    }
    if (REST[u.pathname]) return REST[u.pathname];
    throw { status: 403, responseJSON: { error: 'Forbidden' } };
  }
  const client = {
    async get(paths) {
      const out = {};
      for (const p of [].concat(paths)) {
        if (p === 'currentUser') out.currentUser = { id: 7, name: 'Agent', role: cfg.role || 'admin', groups: cfg.groups || [{ id: 300, name: 'Tier 1 Support' }] };
        else if (cfg.ticket && p in cfg.ticket) out[p] = cfg.ticket[p];
      }
      return out;
    },
    async set(path, value) { log.push({ t: performance.now() - t0, op: `set:${path}`, value }); return {}; },
    async invoke(name) { log.push({ t: performance.now() - t0, op: name }); return {}; },
    on(e, h) { (handlers[e] = handlers[e] || []).push(h); },
    off(e, h) { handlers[e] = (handlers[e] || []).filter((x) => x !== h); },
    async metadata() { return { appId: 1, installationId: 42, settings: { api_base_url: cfg.apiBase } }; },
    async context() { return { location: cfg.location || 'nav_bar', account: { subdomain: 'acme' } }; },
    async request(o) {
      const req = typeof o === 'string' ? { url: o } : o;
      if (!req.url.startsWith(cfg.apiBase)) return zendesk(req.url, req.type || 'GET', req.data);
      const headers = { ...(req.headers || {}), 'content-type': req.contentType || 'application/json' };
      for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
      if (req.jwt) {
        const secret = settings().shared_secret || req.jwt.secret_key; // unset secure setting stays a placeholder
        const now = Math.floor(Date.now() / 1000);
        headers.authorization = `Bearer ${await signJwt({ ...req.jwt.claims, iat: now, exp: now + (req.jwt.expiry || 300) }, secret)}`;
      }
      const isRules = req.url.includes('/v1/rules/config');
      if (isRules && cfg.delayRulesMs) await new Promise((r) => setTimeout(r, cfg.delayRulesMs));
      const res = await fetch(req.url, { method: req.type || 'GET', headers, body: req.data });
      if (isRules) log.push({ t: performance.now() - t0, op: 'rules-config-response' });
      const text = await res.text();
      const shaped = { status: res.status, responseText: text, responseJSON: text ? JSON.parse(text) : undefined, headers: Object.fromEntries(res.headers) };
      if (res.status >= 400) throw shaped;
      return req.httpCompleteResponse ? shaped : shaped.responseJSON;
    },
  };
  window.__zafFire = (e, ...a) => Promise.all((handlers[e] || []).map((h) => h(...a)));
  window.ZAFClient = { init: () => client };
})();
