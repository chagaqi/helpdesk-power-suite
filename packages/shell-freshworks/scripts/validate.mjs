// Offline FDK v9 / platform 3.0 validator (mirrors the structural checks of `fdk validate`).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_LOCATIONS = {
  common: ['full_page_app', 'cti_global_sidebar'],
  support_ticket: ['ticket_sidebar', 'ticket_background', 'new_ticket_background', 'ticket_conversation_editor', 'ticket_requester_info', 'ticket_top_navigation', 'new_ticket_requester_info'],
  service_ticket: ['ticket_sidebar', 'ticket_background', 'new_ticket_background', 'ticket_top_navigation'],
  support_contact: ['contact_sidebar'],
  support_company: ['company_sidebar'],
};
const ICON_REQUIRED = new Set(['full_page_app', 'ticket_sidebar', 'contact_sidebar', 'company_sidebar', 'cti_global_sidebar']);
const IPARAM_TYPES = ['text', 'paragraph', 'dropdown', 'multiselect', 'number', 'phone_number', 'email', 'url', 'radio', 'checkbox', 'date', 'domain', 'api_key'];

export function validateFreshworksApp(dir, { requireBuild = true } = {}) {
  const errors = [];
  const req = (c, m) => (c ? undefined : errors.push(m));
  const json = (p) => JSON.parse(readFileSync(join(dir, p), 'utf8'));
  const m = json('manifest.json');
  req(m['platform-version'] === '3.0', 'platform-version must be "3.0" (FDK 9)');
  req(/^9\./.test(m.engines?.fdk ?? ''), 'engines.fdk must be 9.x');
  req(/^18\./.test(m.engines?.node ?? ''), 'engines.node must be 18.x');
  const requests = existsSync(join(dir, 'config/requests.json')) ? json('config/requests.json') : {};
  const iparams = json('config/iparams.json');
  const declaredRequests = new Set();
  const functions = new Set();
  const handlers = new Set();
  for (const [mod, def] of Object.entries(m.modules ?? {})) {
    req(MODULE_LOCATIONS[mod], `unknown module ${mod}`);
    for (const [loc, l] of Object.entries(def.location ?? {})) {
      req((MODULE_LOCATIONS[mod] ?? []).includes(loc), `location ${loc} not allowed in module ${mod}`);
      req(typeof l.url === 'string' && existsSync(join(dir, 'app', l.url)), `${mod}.${loc}: app/${l.url} missing`);
      if (ICON_REQUIRED.has(loc)) req(l.icon && existsSync(join(dir, 'app', l.icon)) && l.icon.endsWith('.svg'), `${mod}.${loc}: SVG icon required`);
      if (l.url && existsSync(join(dir, 'app', l.url))) {
        const html = readFileSync(join(dir, 'app', l.url), 'utf8');
        req(html.includes('{{{appclient}}}'), `app/${l.url} must load the FDK client via {{{appclient}}}`);
        if (requireBuild) for (const s of html.matchAll(/<script src="(scripts\/[^"]+)"/g)) req(existsSync(join(dir, 'app', s[1])), `app/${l.url} references missing ${s[1]} (run build)`);
      }
    }
    for (const r of Object.keys(def.requests ?? {})) declaredRequests.add(r);
    for (const f of Object.keys(def.functions ?? {})) functions.add(f);
    for (const e of Object.values(def.events ?? {})) handlers.add(e.handler);
  }
  for (const r of declaredRequests) req(requests[r]?.schema, `request template ${r} missing in config/requests.json`);
  for (const [name, t] of Object.entries(requests)) {
    req(declaredRequests.has(name), `request template ${name} not declared in manifest`);
    req(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(t.schema?.method), `${name}: invalid method`);
    req(typeof t.schema?.host === 'string' && !/^https?:/.test(t.schema.host), `${name}: host must not include protocol`);
    req(typeof t.schema?.path === 'string' && t.schema.path.startsWith('/') || /^<%=/.test(t.schema?.path ?? ''), `${name}: path must start with /`);
    for (const ip of (JSON.stringify(t).match(/iparam\.(\w+)/g) ?? []).map((x) => x.slice(7))) req(iparams[ip], `${name} references unknown iparam ${ip}`);
  }
  for (const [k, p] of Object.entries(iparams)) {
    req(p.display_name && IPARAM_TYPES.includes(p.type), `iparam ${k}: display_name and valid type required`);
    if (p.type === 'api_key') req(p.secure === true, `iparam ${k}: api keys must be secure`);
  }
  if (requireBuild) {
    const server = join(dir, 'server/server.js');
    req(existsSync(server), 'server/server.js missing (run build)');
    if (existsSync(server)) {
      const src = readFileSync(server, 'utf8');
      req(/\nexports = \{/.test(src), 'server.js must assign exports = {...}');
      for (const f of [...functions, ...handlers]) req(new RegExp(`\\b${f}: function`).test(src), `server.js does not export ${f}`);
    }
  }
  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = fileURLToPath(new URL('..', import.meta.url));
  const errors = validateFreshworksApp(dir, { requireBuild: !process.argv.includes('--no-build') });
  if (errors.length) {
    console.error(`shell-freshworks: ${errors.length} problem(s)\n - ${errors.join('\n - ')}`);
    process.exit(1);
  }
  console.log('shell-freshworks: manifest, locations, request templates, iparams and serverless exports are valid (FDK 9 / platform 3.0).');
}
