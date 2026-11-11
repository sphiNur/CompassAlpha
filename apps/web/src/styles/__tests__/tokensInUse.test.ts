/**
 * What the web app uses from the design tokens (review TEST4-14,
 * 2026-11-10). These checks read apps/web's sources, so they live here;
 * they were in packages/ui's tokens test, which made the component
 * library's tests depend on the app's files. The cascade and colour
 * arithmetic come from `@compass/ui/testing/tokenCss`.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TOKENS_CSS,
  declaredProperties,
  readProperties,
  sources,
  themeOf,
} from '@compass/ui/testing/tokenCss';

const WEB_SRC = join(import.meta.dir, '..', '..');
const appFiles = () => sources(WEB_SRC).filter((f) => !f.includes('__tests__'));
const rel = (file: string) => file.slice(WEB_SRC.length + 1);
const light = themeOf({ 'data-theme': 'native' });

/**
 * Custom properties the app sets from JavaScript (no stylesheet declares
 * them; every reader has a fallback): the Telegram chrome insets
 * (hooks/useTelegramChromeInsets.ts) and the MainButton height
 * (lib/mainButtonInset.ts).
 */
const RUNTIME_VARS = [
  '--app-chrome-reserve',
  '--app-chrome-safe-top',
  '--app-chrome-pad-left',
  '--app-chrome-pad-right',
  '--app-main-btn-h',
];

describe('colour tokens in use', () => {
  test('every var(--c-*) referenced by the web app is defined', () => {
    const used = new Set<string>();
    for (const file of sources(WEB_SRC)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/var\((--c-[a-z0-9-]+)/g))
        used.add(m[1]!);
    }
    const missing = [...used].filter((name) => !(name in light));
    expect(missing).toEqual([]);
  });

  // N3 (2026-10-31): every custom property read anywhere — `var(--x)` or
  // Tailwind's `[--x]` — must be declared in a stylesheet (the tokens or
  // the app's own), or be one the app writes at run time.
  test('every custom property referenced by the web app is defined', () => {
    const declared = declaredProperties(TOKENS_CSS);
    for (const file of appFiles().filter((f) => f.endsWith('.css'))) {
      for (const name of declaredProperties(readFileSync(file, 'utf8'))) declared.add(name);
    }
    const missing = new Set<string>();
    for (const file of appFiles()) {
      for (const name of readProperties(readFileSync(file, 'utf8'))) {
        if (!declared.has(name) && !RUNTIME_VARS.includes(name))
          missing.add(`${name} (${rel(file)})`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  test('each run-time custom property is really written by the app', () => {
    const code = appFiles()
      .filter((f) => !f.endsWith('.css'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    for (const name of RUNTIME_VARS) {
      expect({ name, written: code.includes(`'${name}'`) }).toEqual({ name, written: true });
    }
  });
});

/** The text of a JSX className value: `"…"` or a balanced `{…}`. */
function classNameValue(after: string): string {
  if (after.startsWith('"')) return after.slice(1, after.indexOf('"', 1));
  if (!after.startsWith('{')) return '';
  let depth = 0;
  for (let i = 0; i < after.length; i++) {
    if (after[i] === '{') depth++;
    else if (after[i] === '}' && --depth === 0) return after.slice(1, i);
  }
  return after.slice(1);
}

describe('D18: text fields are 44px', () => {
  test('no raw <input>, <select> or <textarea> in the web app is shorter than 44px', () => {
    // TEST4-15: the scan read only `className="…"`; a `className={cn(…)}`
    // or a template string went unchecked, and so did `h-[36px]`.
    const SHORT =
      /(^|[\s'"`])(h-(?:[0-9]|10)|h-\[(?:[0-9]|[1-3][0-9]|4[0-3])px\]|py-1)(?=$|[\s'"`])/;
    const short: string[] = [];
    for (const file of sources(WEB_SRC)) {
      if (!file.endsWith('.tsx')) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<(input|select|textarea)\b/g)) {
        // The element's own attributes: up to its first className.
        const attrs = src.slice(m.index!, m.index! + 1200);
        const at = attrs.indexOf('className=');
        const type = /type="([a-z]+)"/.exec(at < 0 ? attrs : attrs.slice(0, at))?.[1];
        if (type && ['checkbox', 'radio', 'hidden', 'file'].includes(type)) continue;
        const cls = at < 0 ? '' : classNameValue(attrs.slice(at + 'className='.length));
        if (SHORT.test(cls)) short.push(`${rel(file)}: ${cls.replace(/\s+/g, ' ')}`);
      }
    }
    expect(short).toEqual([]);
  });

  test('the scan reads every way a className is written', () => {
    expect(classNameValue('"h-9 w-full" />')).toBe('h-9 w-full');
    expect(classNameValue("{cn('h-[36px] px-2', a && 'b')} />")).toBe(
      "cn('h-[36px] px-2', a && 'b')",
    );
    expect(classNameValue('{`h-10 ${x}`} />')).toBe('`h-10 ${x}`');
  });
});

describe('purchase row controls', () => {
  test('the row controls are at least 44 wide and grow with their label', () => {
    const src = readFileSync(join(WEB_SRC, 'pages/runs/views/RunViews.tsx'), 'utf8');
    const ctrl = /const ROW_CTRL =\s*([\s\S]*?);/.exec(src)![1]!;
    expect(ctrl).toContain('min-w-11');
    expect(ctrl).toContain('whitespace-nowrap');
    expect(ctrl).not.toMatch(/\bw-9\b/);
    expect(src).not.toContain('min-w-9');
  });
});

describe('CMP-INT-6: keyboard focus is visible', () => {
  const appCss = readFileSync(join(WEB_SRC, 'styles/index.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

  test('no global rule removes the focus outline', () => {
    expect(appCss).not.toMatch(/focus-visible\s*\{[^}]*outline:\s*none/);
  });

  test('a global :focus-visible ring drawn in the --c-ring token', () => {
    const rule = /(?:^|\n)\s*:focus-visible\s*\{([^}]*)\}/.exec(appCss)?.[1] ?? '';
    expect(rule).toContain('outline: 2px solid var(--c-ring)');
  });
});

describe('DX-XS-1: colour with an opacity modifier', () => {
  // Tailwind 3 cannot apply `/40` to an arbitrary colour variable: the class
  // is dropped and a ring falls back to Tailwind's default blue. Use
  // color-mix() instead.
  test('no `[var(--c-*)]/NN` utility in the web app', () => {
    const hits: string[] = [];
    for (const file of appFiles()) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\[var\(--c-[a-z0-9-]+\)\]\/\d+/g)) {
        hits.push(`${rel(file)}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
