// Bundles the whole server (core-api, companions, playground, Hono, zod, fflate) into ONE file.
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  // Some deps reference require(); provide it in ESM.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __hpsCreateRequire } from 'node:module';\nconst require = __hpsCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});
const kb = Math.round(statSync(`${root}/dist/server.mjs`).size / 1024);
console.log(`gateway: bundled dist/server.mjs (${kb} KB, zero runtime dependencies)`);
