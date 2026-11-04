// docs/VERIFICATION.md maps every docs/PLAN.md section 10 checklist item to the tests that cover it,
// or to a manual step. This keeps the mapping in step with the plan and the tests: every item is
// there, every cited file exists, and every cited test title is in its file. Runs in `npm test`,
// and so in CI.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const planPath = join(root, 'docs', 'PLAN.md');
const mappingPath = join(root, 'docs', 'VERIFICATION.md');

interface Ref {
  path: string;
  /** The cited test title, or null for a script or workflow cited as a whole. */
  title: string | null;
}

interface MappedItem {
  number: number;
  text: string;
  refs: Ref[];
  manualSteps: number;
  /** List lines that are neither a reference nor a manual step (most likely a typo). */
  unparsed: string[];
}

/** The checklist items of PLAN.md section 10, in order. */
function checklistItems(plan: string): string[] {
  const lines = plan.split('\n');
  const start = lines.findIndex((line) => /^## 10\. /.test(line));
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    const item = /^- \[[ xX]\] (.+)$/.exec(line);
    if (item?.[1]) items.push(item[1].trim());
  }
  return items;
}

const HEADING = /^## (\d+)\. (.+)$/;
/** "- `path`", optionally followed by " — `test title`" or by " (a note)", and nothing else. */
const REF = /^- `([^`]+)`(?: — `([^`]+)`| \(.+\))?$/;
/** Any bullet, in any form or indent, so a wrong form lands in `unparsed` instead of being skipped. */
const LIST_LINE = /^\s*[-*+] /;
const MANUAL = /^- Manual: \S/;

/** The numbered sections of VERIFICATION.md with their references and manual steps. */
function parseMapping(markdown: string): MappedItem[] {
  const items: MappedItem[] = [];
  let current: MappedItem | null = null;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      const heading = HEADING.exec(line);
      current = heading ? { number: Number(heading[1]), text: heading[2]!.trim(), refs: [], manualSteps: 0, unparsed: [] } : null;
      if (current) items.push(current);
      continue;
    }
    if (current === null || !LIST_LINE.test(line)) continue;
    const ref = REF.exec(line);
    if (ref) current.refs.push({ path: ref[1]!, title: ref[2] ?? null });
    else if (MANUAL.test(line)) current.manualSteps++;
    else current.unparsed.push(line);
  }
  return items;
}

/** Whether `title` appears in `source` as a whole string literal ('…', "…" or `…`). */
function hasTitle(source: string, title: string): boolean {
  return ["'", '"', '`'].some((quote) => source.includes(`${quote}${title}${quote}`));
}

describe('verification mapping parser', () => {
  it('reads the section 10 checklist, ticked or not, and stops at the next section', () => {
    const plan = ['## 9. Before', '- [ ] Not this', '## 10. Verification checklist', '', '- [ ] One.', '- [x] Two `code`.', '## 11. After', '- [ ] Nor this'].join('\n');
    expect(checklistItems(plan)).toEqual(['One.', 'Two `code`.']);
  });

  it('reads references, titles and manual steps per numbered section', () => {
    const markdown = [
      '# Verification',
      '- `ignored/intro.ts` — `before any item`',
      '## 1. First.',
      '- `src/a.test.ts` — `does a ($label)`',
      '- `scripts/b.mjs` (run by `npm run b`)',
      '- Manual: look at it.',
      '- a stray line',
      '## Notes',
      '- `ignored/after.ts`',
    ].join('\n');
    expect(parseMapping(markdown)).toEqual([
      {
        number: 1,
        text: 'First.',
        refs: [
          { path: 'src/a.test.ts', title: 'does a ($label)' },
          { path: 'scripts/b.mjs', title: null },
        ],
        manualSteps: 1,
        unparsed: ['- a stray line'],
      },
    ]);
  });

  it('puts a reference with a mistyped separator in unparsed instead of dropping its title', () => {
    const markdown = ['## 1. First.', '- `src/a.test.ts` - `no such test`', '- `src/a.test.ts` -- `no such test`', '- `src/a.test.ts` trailing text'].join('\n');
    expect(parseMapping(markdown)).toEqual([
      {
        number: 1,
        text: 'First.',
        refs: [],
        manualSteps: 0,
        unparsed: ['- `src/a.test.ts` - `no such test`', '- `src/a.test.ts` -- `no such test`', '- `src/a.test.ts` trailing text'],
      },
    ]);
  });

  it('puts other bullet forms and indented bullets in unparsed', () => {
    const markdown = ['## 1. First.', '* `src/a.test.ts` — `does a`', '+ Manual: look at it.', '  - `src/a.test.ts` — `does a`'].join('\n');
    expect(parseMapping(markdown)[0]?.unparsed).toEqual(['* `src/a.test.ts` — `does a`', '+ Manual: look at it.', '  - `src/a.test.ts` — `does a`']);
  });

  it('matches a title only as a whole string literal', () => {
    const source = "it('does a thing', () => {});\nit(`at ${dt} s`, () => {});";
    expect(hasTitle(source, 'does a thing')).toBe(true);
    expect(hasTitle(source, 'at ${dt} s')).toBe(true);
    expect(hasTitle(source, 'does a')).toBe(false);
    expect(hasTitle(source, 'does a thing, and more')).toBe(false);
  });
});

describe('docs/VERIFICATION.md', () => {
  const plan = readFileSync(planPath, 'utf8');
  const mapping = parseMapping(readFileSync(mappingPath, 'utf8'));

  it('lists every PLAN.md section 10 item, in order and with the same text', () => {
    const items = checklistItems(plan);
    expect(items).toHaveLength(13);
    expect(mapping.map((item) => item.text)).toEqual(items);
    expect(mapping.map((item) => item.number)).toEqual(items.map((_, i) => i + 1));
  });

  it('gives every item at least one check or manual step, and no unrecognised list lines', () => {
    for (const item of mapping) {
      expect(item.refs.length + item.manualSteps, `item ${item.number}`).toBeGreaterThan(0);
      expect(item.unparsed, `item ${item.number}`).toEqual([]);
    }
  });

  it('cites only files that exist in the repository', () => {
    const missing: string[] = [];
    for (const { number, refs } of mapping) {
      for (const { path } of refs) {
        const inside = !isAbsolute(path) && !normalize(path).startsWith('..');
        const file = join(root, path);
        if (!inside || !existsSync(file) || !statSync(file).isFile()) missing.push(`item ${number}: ${path}`);
      }
    }
    expect(mapping.flatMap((item) => item.refs).length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('cites only test titles that appear in the cited file', () => {
    const notFound: string[] = [];
    for (const { number, refs } of mapping) {
      for (const { path, title } of refs) {
        const file = join(root, path);
        if (title === null || !existsSync(file)) continue;
        if (!hasTitle(readFileSync(file, 'utf8'), title)) notFound.push(`item ${number}: ${path} — ${title}`);
      }
    }
    expect(notFound).toEqual([]);
  });
});
