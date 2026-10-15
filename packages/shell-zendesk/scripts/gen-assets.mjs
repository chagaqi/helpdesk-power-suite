// Regenerates marketplace logos/icons. Output is committed; run only when the mark changes.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LOGO_SVG, NAV_ICON_SVG, renderLogo } from '../../../scripts/png.mjs';

const assets = fileURLToPath(new URL('../assets/', import.meta.url));
writeFileSync(`${assets}logo.png`, renderLogo(320));
writeFileSync(`${assets}logo-small.png`, renderLogo(128));
writeFileSync(`${assets}logo.svg`, LOGO_SVG);
writeFileSync(`${assets}icon_nav_bar.svg`, NAV_ICON_SVG);
console.log('Zendesk logos written to', assets);
