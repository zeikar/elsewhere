// Asserts that the production build in dist/ does not contain the e2e test hook
// (window.__elsewhere, installed only in `vite build --mode e2e`), nor the e2e-only URL overrides it
// reads (`e2eEngineOptions`: `?encounterKind=planet|nebula|asteroid`, `?encounterInterval=`, …).
// Run after `npm run build`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKERS = ['__elsewhere', 'installE2EHook'];
// The overrides are read with `URLSearchParams.get('<name>')`; the engine options of the same names
// stay in production, but nothing there reads them from the URL.
const OVERRIDE_READ = /\.get\(\s*["'`](?:encounterInterval|encounterKind|starLayers|headingDrift|arrivalSpeed)["'`]\s*\)/;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');

function fail(message) {
  console.error(`check:hook failed: ${message}`);
  process.exit(1);
}

if (!existsSync(join(distDir, 'index.html'))) {
  fail(`${join(distDir, 'index.html')} not found; run \`npm run build\` first.`);
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const hits = [];
let scanned = 0;
for (const path of walk(distDir)) {
  if (!/\.(?:html|js|mjs|css|map)$/.test(path)) continue;
  scanned++;
  const text = readFileSync(path, 'utf8');
  for (const marker of MARKERS) {
    if (text.includes(marker)) hits.push(`${relative(root, path)} contains "${marker}"`);
  }
  const override = OVERRIDE_READ.exec(text);
  if (override !== null) hits.push(`${relative(root, path)} reads an e2e URL override: ${override[0]}`);
}

if (scanned === 0) fail('no files scanned in dist/.');
if (hits.length > 0) fail(`e2e hook found in the production build:\n  ${hits.join('\n  ')}`);

console.log(`check:hook ok: ${scanned} file(s) in dist/ contain no e2e hook or e2e URL override`);
