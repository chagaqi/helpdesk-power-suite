// Offline ZAF v2 app validator (mirrors the checks `zcli apps:validate` / the Marketplace run).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ZD_LOCATIONS = ['nav_bar', 'ticket_sidebar', 'new_ticket_sidebar', 'top_bar', 'user_sidebar', 'organization_sidebar', 'background', 'modal', 'ticket_editor'];
const PARAM_TYPES = ['text', 'password', 'checkbox', 'url', 'number', 'multiline', 'hidden', 'oauth'];

function pngSize(file) {
  const b = readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/** Returns a list of problems (empty = valid). `requireBuild` also checks bundled JS exists. */
export function validateZendeskApp(dir, { requireBuild = true } = {}) {
  const errors = [];
  const req = (cond, msg) => (cond ? undefined : errors.push(msg));
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const t = JSON.parse(readFileSync(join(dir, 'translations', `${m.defaultLocale ?? 'en'}.json`), 'utf8'));
  req(typeof m.name === 'string' && m.name.length > 0, 'manifest.name required');
  req(m.author?.name && /@/.test(m.author?.email ?? ''), 'manifest.author.name and author.email required');
  req(m.frameworkVersion === '2.0', 'frameworkVersion must be "2.0"');
  req(/^\d+\.\d+\.\d+$/.test(m.version ?? ''), 'version must be semver');
  req(m.defaultLocale, 'defaultLocale required');
  const locs = m.location?.support ?? {};
  req(Object.keys(locs).length > 0, 'at least one support location required');
  for (const [name, loc] of Object.entries(locs)) {
    req(ZD_LOCATIONS.includes(name), `unknown location ${name}`);
    const url = typeof loc === 'string' ? loc : loc.url;
    req(typeof url === 'string', `location ${name} needs a url`);
    if (url && !/^https?:/.test(url)) {
      req(existsSync(join(dir, url)), `location ${name}: ${url} missing`);
      if (requireBuild && existsSync(join(dir, url))) {
        for (const src of readFileSync(join(dir, url), 'utf8').matchAll(/<script src="([^"]+)"/g)) {
          if (!/^https?:/.test(src[1])) req(existsSync(join(dir, 'assets', src[1])), `${url} references missing ${src[1]} (run build)`);
        }
      }
    }
  }
  if (locs.nav_bar) req(existsSync(join(dir, 'assets', 'icon_nav_bar.svg')), 'nav_bar requires assets/icon_nav_bar.svg');
  for (const [f, size] of [['logo.png', 320], ['logo-small.png', 128]]) {
    const p = join(dir, 'assets', f);
    req(existsSync(p), `assets/${f} required`);
    if (existsSync(p)) {
      const { w, h } = pngSize(p);
      req(w === size && h === size, `assets/${f} must be ${size}x${size} (got ${w}x${h})`);
    }
  }
  const secure = [];
  for (const p of m.parameters ?? []) {
    req(/^[a-z][a-z0-9_]*$/.test(p.name), `parameter name ${p.name} invalid`);
    req(PARAM_TYPES.includes(p.type), `parameter ${p.name} has invalid type ${p.type}`);
    req(t.app?.parameters?.[p.name]?.label, `translations missing app.parameters.${p.name}.label`);
    if (p.secure) secure.push(p.name);
    if (p.type === 'url' && p.default) {
      const host = new URL(p.default).host;
      req((m.domainWhitelist ?? []).includes(host), `default ${p.name} host ${host} must be in domainWhitelist (secure requests)`);
    }
  }
  if (secure.length) req((m.domainWhitelist ?? []).length > 0, 'secure parameters require domainWhitelist');
  if (!m.private) {
    for (const k of ['name', 'short_description', 'long_description', 'installation_instructions']) req(t.app?.[k], `public apps need translations app.${k}`);
    req((t.app?.short_description ?? '').length <= 200, 'short_description must be <= 200 chars');
  }
  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = fileURLToPath(new URL('..', import.meta.url));
  const errors = validateZendeskApp(dir, { requireBuild: !process.argv.includes('--no-build') });
  if (errors.length) {
    console.error(`shell-zendesk: ${errors.length} problem(s)\n - ${errors.join('\n - ')}`);
    process.exit(1);
  }
  console.log('shell-zendesk: manifest, translations, locations and assets are valid (ZAF v2).');
}
