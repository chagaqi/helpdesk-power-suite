// Bundles the ZAF entry points into assets/*.js (IIFE, browser, minified).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const common = { bundle: true, format: 'iife', platform: 'browser', target: ['es2020', 'chrome100', 'safari15', 'firefox100'], minify: true, sourcemap: false, legalComments: 'none', absWorkingDir: root, logLevel: 'warning' };
await Promise.all([
  build({ ...common, entryPoints: ['src/nav.ts'], outfile: 'assets/nav.js' }),
  build({ ...common, entryPoints: ['src/sidebar.ts'], outfile: 'assets/sidebar.js' }),
]);
console.log('shell-zendesk: built assets/nav.js and assets/sidebar.js');
