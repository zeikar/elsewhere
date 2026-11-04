// Asserts that the built dist/index.html loads its JS and CSS from the /elsewhere/ base path
// (the site is served from https://zeikar.dev/elsewhere/). Run after `npm run build`.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = '/elsewhere/';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const indexPath = join(distDir, 'index.html');

function fail(message) {
  console.error(`check:base failed: ${message}`);
  process.exit(1);
}

if (!existsSync(indexPath)) {
  fail(`${indexPath} not found; run \`npm run build\` first.`);
}

const html = readFileSync(indexPath, 'utf8');

// Every local asset reference made by <script src> and <link href> tags.
const refs = [];
for (const tag of html.match(/<(script|link)\b[^>]*>/gi) ?? []) {
  const attr = /\b(?:src|href)\s*=\s*["']([^"']+)["']/i.exec(tag);
  if (attr?.[1] && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(attr[1])) {
    refs.push(attr[1]);
  }
}

const js = refs.filter((ref) => ref.endsWith('.js'));
const css = refs.filter((ref) => ref.endsWith('.css'));
if (js.length === 0) fail('no JS asset referenced from dist/index.html.');
if (css.length === 0) fail('no CSS asset referenced from dist/index.html.');

const wrongBase = refs.filter((ref) => !ref.startsWith(BASE));
if (wrongBase.length > 0) {
  fail(`asset paths not under ${BASE}: ${wrongBase.join(', ')}`);
}

const missing = refs.filter((ref) => !existsSync(join(distDir, ref.slice(BASE.length))));
if (missing.length > 0) {
  fail(`referenced assets missing from dist/: ${missing.join(', ')}`);
}

console.log(`check:base ok: ${refs.length} asset(s) under ${BASE}`);
for (const ref of refs) console.log(`  ${ref}`);
