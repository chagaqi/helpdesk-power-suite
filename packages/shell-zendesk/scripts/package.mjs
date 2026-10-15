// Produces the uploadable Zendesk app zip: manifest.json, translations/, assets/ (built).
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { validateZendeskApp } from './validate.mjs';

const dir = fileURLToPath(new URL('..', import.meta.url));
const errors = validateZendeskApp(dir);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
const files = {};
const add = (p) => {
  for (const name of readdirSync(p)) {
    const full = join(p, name);
    if (statSync(full).isDirectory()) add(full);
    else if (!name.endsWith('.map') && name !== '.DS_Store') files[relative(dir, full).split('\\').join('/')] = readFileSync(full);
  }
};
files['manifest.json'] = readFileSync(join(dir, 'manifest.json'));
add(join(dir, 'translations'));
add(join(dir, 'assets'));
const version = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).version;
mkdirSync(join(dir, 'dist'), { recursive: true });
const out = join(dir, 'dist', `helpdesk-power-suite-zendesk-${version}.zip`);
writeFileSync(out, zipSync(files, { level: 9 }));
console.log(`shell-zendesk: packaged ${Object.keys(files).length} files -> ${relative(process.cwd(), out)}`);
