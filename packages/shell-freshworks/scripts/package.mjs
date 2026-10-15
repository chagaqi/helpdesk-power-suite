// Produces an upload-ready archive with the same layout as `fdk pack` (dist/<name>.zip).
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { validateFreshworksApp } from './validate.mjs';

const dir = fileURLToPath(new URL('..', import.meta.url));
const errors = validateFreshworksApp(dir);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
const files = {};
const add = (p) => {
  for (const name of readdirSync(p)) {
    const full = join(p, name);
    if (statSync(full).isDirectory()) add(full);
    else if (!name.endsWith('.map')) files[relative(dir, full).split('\\').join('/')] = readFileSync(full);
  }
};
for (const f of ['manifest.json', 'README.md']) files[f] = readFileSync(join(dir, f));
add(join(dir, 'app'));
add(join(dir, 'config'));
files['server/server.js'] = readFileSync(join(dir, 'server/server.js'));
const version = JSON.parse(readFileSync(join(dir, '..', '..', 'package.json'), 'utf8')).version;
mkdirSync(join(dir, 'dist'), { recursive: true });
const out = join(dir, 'dist', `helpdesk-power-suite-freshworks-${version}.zip`);
writeFileSync(out, zipSync(files, { level: 9 }));
console.log(`shell-freshworks: packaged ${Object.keys(files).length} files -> ${relative(process.cwd(), out)}`);
