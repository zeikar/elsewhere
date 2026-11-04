// The engine knows nothing about the DOM UI (docs/PLAN.md section 8): no module under src/engine/
// may import anything from src/ui/. Runs in `npm test`, and so in CI.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = dirname(fileURLToPath(import.meta.url));
const engineDir = join(srcDir, 'engine');
const uiDir = join(srcDir, 'ui');

/** Static imports and re-exports (`import … from '…'`, `import '…'`, `export … from '…'`) and dynamic `import('…')`. */
const SPECIFIER = /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

function importSpecifiers(source: string): string[] {
  return Array.from(source.matchAll(SPECIFIER), (m) => m[1] ?? m[2] ?? m[3] ?? '');
}

function engineSources(): string[] {
  return readdirSync(engineDir, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.(?:ts|tsx|js|mjs)$/.test(name))
    .map((name) => join(engineDir, name));
}

function importsUi(file: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return /(?:^|\/)src\/ui(?:\/|$)/.test(specifier);
  const target = resolve(dirname(file), specifier);
  return target === uiDir || target.startsWith(uiDir + sep);
}

describe('module boundaries', () => {
  it('the import scanner sees the usual import forms', () => {
    const source = [
      "import { a } from './a';",
      "import type { B } from '../b';",
      "import './side-effect';",
      "export { c } from './c';",
      "const d = await import('./d');",
      'import {\n  e,\n  f,\n} from "./ef";',
    ].join('\n');
    expect(importSpecifiers(source)).toEqual(['./a', '../b', './side-effect', './c', './d', './ef']);
  });

  it('src/engine imports nothing from src/ui', () => {
    const files = engineSources();
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (importsUi(file, specifier)) offenders.push(`${relative(srcDir, file)} imports '${specifier}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('flags an engine import that reaches into src/ui', () => {
    const file = join(engineDir, 'Engine.ts');
    expect(importsUi(file, '../ui/controls')).toBe(true);
    expect(importsUi(file, '../ui')).toBe(true);
    expect(importsUi(file, '../config')).toBe(false);
    expect(importsUi(file, './Ship')).toBe(false);
  });
});
