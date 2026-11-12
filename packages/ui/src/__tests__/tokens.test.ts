import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { disabledClass, disabledLook } from '../components/disabled';
import {
  TOKENS_CSS,
  UI_SRC,
  color,
  computedOnRoot,
  contrast,
  declaredProperties,
  luminance,
  parseRules,
  readProperties,
  sources,
  themeOf,
} from '../testing/tokenCss';

/**
 * V3 / V7 / V8 / V9 (2026-10-30): the colour tokens are checked by
 * arithmetic, not by eye. Each text pair must clear WCAG 4.5:1 and each
 * field edge 3:1, in every theme; every `var(--c-*)` the components
 * reference must exist; the status components must not hard-code colours
 * that ignore the dark theme.
 *
 * Review TEST4-14 (2026-11-10): only this package's sources are read
 * here. The checks of what apps/web uses are in its own tests
 * (apps/web/src/styles/__tests__/tokensInUse.test.ts), and the cascade
 * and colour arithmetic are in ../testing/tokenCss.ts for both.
 */

const css = TOKENS_CSS;
const light = themeOf({ 'data-theme': 'native' });
const dark = themeOf({ 'data-theme': 'dark' });
const nativeDark = themeOf({ 'data-theme': 'native', 'data-color-scheme': 'dark' });
const apple = themeOf({ 'data-theme': 'apple' });

const SURFACES = ['--c-bg', '--c-surface', '--c-surface-2'];
// Text colours that sit on any of the page surfaces.
const TEXT_ON_SURFACES = [
  '--c-fg',
  '--c-fg-muted',
  '--c-fg-subtle',
  '--c-action',
  '--c-danger',
  '--c-success',
  '--c-warning-fg',
];
const TEXT_PAIRS: Array<[fg: string, bg: string]> = [
  ['--c-action-fg', '--c-action'],
  ['--c-danger-fg', '--c-danger'],
  ['--c-fg-muted', '--c-surface-3'],
  ['--c-success-ink', '--c-success-bg'],
  ['--c-warn-ink', '--c-warn-bg'],
  ['--c-danger-ink', '--c-danger-bg'],
  ['--c-warning-fg', '--c-warn-bg'],
];

describe.each([
  ['light', light],
  ['dark', dark],
  ['Telegram dark', nativeDark],
  ['apple', apple],
] as const)('%s theme contrast', (_name, theme) => {
  for (const fg of TEXT_ON_SURFACES) {
    for (const bg of SURFACES) {
      test(`${fg} on ${bg} ≥ 4.5`, () => {
        expect(contrast(theme, fg, bg)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  for (const [fg, bg] of TEXT_PAIRS) {
    test(`${fg} on ${bg} ≥ 4.5`, () => {
      expect(contrast(theme, fg, bg)).toBeGreaterThanOrEqual(4.5);
    });
  }
  for (const bg of SURFACES) {
    test(`--c-field-border against ${bg} ≥ 3`, () => {
      expect(contrast(theme, '--c-field-border', bg)).toBeGreaterThanOrEqual(3);
    });
  }
  for (const bg of [...SURFACES, '--c-surface-3']) {
    // CMP-INT-6: the global :focus-visible outline is drawn in --c-ring.
    test(`--c-ring against ${bg} ≥ 3`, () => {
      expect(contrast(theme, '--c-ring', bg)).toBeGreaterThanOrEqual(3);
    });
  }
  test('subtle stays lighter-weight than muted', () => {
    // The three inks keep their order (fg > muted > subtle) after the tuning.
    expect(contrast(theme, '--c-fg-muted', '--c-surface')).toBeGreaterThan(
      contrast(theme, '--c-fg-subtle', '--c-surface'),
    );
  });
});

/**
 * Custom properties the host app sets at run time, which the components
 * read with a fallback: the MainButton height (Toast keeps clear of it).
 */
const HOST_VARS = ['--app-main-btn-h'];

/** Set by a component on its own element while it runs: a pulled sheet (UI-25). */
const RUNTIME_VARS = ['--sheet-drag'];

/** The package's own sources: not its tests or their helpers in src/testing. */
const componentFiles = () =>
  sources(UI_SRC).filter((f) => !f.includes('__tests__') && !f.includes('/src/testing/'));

describe('colour tokens in use', () => {
  test('every var(--c-*) referenced by the UI kit is defined', () => {
    const used = new Set<string>();
    for (const file of sources(UI_SRC)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/var\((--c-[a-z0-9-]+)/g)) used.add(m[1]!);
    }
    const missing = [...used].filter((name) => !(name in light));
    expect(missing).toEqual([]);
  });

  // N3 (2026-10-31): only `--c-*` was checked, so `--r-input` (never
  // defined) left one select square in an all-pill screen. Now every
  // custom property read anywhere — `var(--x)` or Tailwind's `[--x]` —
  // must be declared in tokens.css, or be one the host sets at run time.
  test('every custom property referenced by the UI kit is defined', () => {
    const declared = declaredProperties(css);
    const missing: string[] = [];
    for (const file of componentFiles()) {
      for (const name of readProperties(readFileSync(file, 'utf8'))) {
        if (!declared.has(name) && !HOST_VARS.includes(name) && !RUNTIME_VARS.includes(name)) {
          missing.push(`${name} (${file.slice(file.indexOf('/src/') + 1)})`);
        }
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  test('status components take their colours from tokens', () => {
    for (const name of ['Banner.tsx', 'Badge.tsx', 'Toast.tsx', 'Sheet.tsx']) {
      const src = readFileSync(join(UI_SRC, 'components', name), 'utf8');
      expect({ name, literal: /oklch\(|#[0-9a-f]{6}\b/i.test(src) }).toEqual({ name, literal: false });
    }
  });
});

describe('tap areas', () => {
  const read = (name: string) => readFileSync(join(UI_SRC, 'components', name), 'utf8');

  test('Button, pills, segments and the qty keys carry hit-44', () => {
    for (const name of ['Button.tsx', 'pill.ts', 'Segmented.tsx', 'QtyControl.tsx']) {
      expect({ name, hit: read(name).includes('hit-44') }).toEqual({ name, hit: true });
    }
  });

  test('Button does not clip its own tap area', () => {
    // An overflow-hidden button clips the hit-44 ::after, and clipped
    // areas take no taps.
    const base = /const button = cva\(\s*\[([\s\S]*?)\]/.exec(read('Button.tsx'))![1]!;
    expect(base).not.toContain('overflow-hidden');
  });

  test('Segmented does not clip its own tap area (review UI-06)', () => {
    // `truncate` is overflow:hidden. On the segment button it cut the
    // hit-44 area back to the visible 28/36px; the label span truncates.
    const segment = /<button[\s\S]*?className=\{cn\(([\s\S]*?)\)\}/.exec(read('Segmented.tsx'))![1]!;
    expect(segment).toContain('hit-44');
    expect(segment).not.toMatch(/\btruncate\b|overflow-hidden|overflow-clip/);
  });

  test('hit-44 is at least 44px in both directions', () => {
    const rule = /\.hit-44::after\s*\{([^}]*)\}/.exec(css)![1]!;
    expect(rule).toContain('width: max(100%, 44px)');
    expect(rule).toContain('height: max(100%, 44px)');
  });
});

describe('D18: text fields are 44px', () => {
  const read = (name: string) => readFileSync(join(UI_SRC, 'components', name), 'utf8');

  test('--control-h is 44px', () => {
    expect(light['--control-h']).toBe('44px');
  });

  test('every text field and the md Button take their height from --control-h', () => {
    for (const name of ['Input.tsx', 'SearchInput.tsx', 'Select.tsx']) {
      const src = read(name);
      expect({ name, height: src.includes('h-[var(--control-h)]') }).toEqual({ name, height: true });
      expect({ name, compact: /h-\[var\(--control-h-sm\)\]|'h-8'|\bh-9\b|\bh-10\b/.test(src) }).toEqual({
        name,
        compact: false,
      });
    }
    expect(read('Button.tsx')).toContain("md: 'h-[var(--control-h)]");
    expect(read('Textarea.tsx')).toContain('min-h-11');
  });
});

describe('V18: the sheet keeps its lift', () => {
  test('the sheet draws its shadow and hairline in one box-shadow', () => {
    const sheet = readFileSync(join(UI_SRC, 'components', 'Sheet.tsx'), 'utf8');
    // shadow-[…] and ring-hairline both set box-shadow; the later one wins.
    expect(sheet).toContain('shadow-sheet');
    expect(sheet).not.toMatch(/shadow-\[var\(--shadow-product\)\][^'\n]*ring-hairline/);
    const rule = /\.shadow-sheet\s*\{([^}]*)\}/.exec(css)![1]!;
    expect(rule).toContain('var(--shadow-product)');
    expect(rule).toContain('inset 0 0 0 1px var(--c-divider)');
  });
});

describe('DX-VIS-4: reduced motion reaches the transition tokens', () => {
  const themes: Array<Record<string, string>> = [
    {},
    { 'data-theme': 'native' },
    { 'data-theme': 'native', 'data-color-scheme': 'dark' },
    { 'data-theme': 'dark' },
    { 'data-theme': 'apple' },
  ];
  for (const attrs of themes) {
    const label = JSON.stringify(attrs);
    test(`--t-base / --t-quick / --t-snap are 0ms under reduce on ${label}`, () => {
      for (const name of ['--t-base', '--t-quick', '--t-snap']) {
        expect({ name, value: computedOnRoot(name, attrs, { reducedMotion: true }) }).toEqual({
          name,
          value: '0ms',
        });
      }
    });
  }
  test('without reduce the native theme keeps its durations', () => {
    expect(computedOnRoot('--t-base', { 'data-theme': 'native' }, { reducedMotion: false })).toBe('240ms');
    expect(computedOnRoot('--t-snap', { 'data-theme': 'native' }, { reducedMotion: false })).toBe('100ms');
  });
  test('the press shrink is switched off under reduce, after the rule that sets it', () => {
    const rules = parseRules(css).filter((r) => r.selectors.includes('.press:active'));
    const shrink = rules.find((r) => !r.media)!;
    const off = rules.find((r) => r.media?.includes('reduce'))!;
    expect(off.decls.transform).toBe('none');
    expect(off.order).toBeGreaterThan(shrink.order);
  });
});

describe('DX-VIS-14: dark elevation order', () => {
  test('surface-elevated is lighter than surface-2 in the dark theme', () => {
    expect(luminance(color(dark, '--c-surface-elevated'))).toBeGreaterThan(
      luminance(color(dark, '--c-surface-2')),
    );
  });
  test('the dark background keeps its tone (owner decision)', () => {
    expect(dark['--c-bg']).toBe('oklch(15% 0.01 240)');
  });
});

describe('DX-XS-1: colour with an opacity modifier', () => {
  // Tailwind 3 cannot apply `/40` to an arbitrary colour variable: the class
  // is dropped and a ring falls back to Tailwind's default blue (the
  // danger-ghost Button border). Use color-mix() instead.
  test('no `[var(--c-*)]/NN` utility in the UI kit', () => {
    const hits: string[] = [];
    for (const file of componentFiles()) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\[var\(--c-[a-z0-9-]+\)\]\/\d+/g)) {
        hits.push(`${file.slice(file.indexOf('/src/') + 1)}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe('DX-VIS-8: wrapped tap areas do not overlap', () => {
  test('the qty preset rows are at least 18px apart (26px chips, 44px taps)', () => {
    const src = readFileSync(join(UI_SRC, 'components', 'QtyControl.tsx'), 'utf8');
    const gap = /Preset chips[\s\S]*?gap-y-\[(\d+)px\]/.exec(src);
    expect(Number(gap?.[1] ?? 0)).toBeGreaterThanOrEqual((44 - 26) / 2 * 2);
  });
});

describe('UI-10: checkbox and switch show their edge and state', () => {
  const read = (name: string) => readFileSync(join(UI_SRC, 'components', name), 'utf8');

  test('the unchecked box and the off track use the 3:1 field edge, not the hairline', () => {
    // --c-field-border clears 3:1 on every surface (above); --c-divider is
    // a 1.2–1.4:1 hairline.
    for (const name of ['Checkbox.tsx', 'Switch.tsx']) {
      const src = read(name);
      expect({
        name,
        field: src.includes('ring-field'),
        hairline: src.includes('ring-hairline'),
      }).toEqual({ name, field: true, hairline: false });
    }
  });

  test('the switch thumb is the field border when off and the action text colour when on', () => {
    // Both pairs are measured above: --c-field-border on --c-surface-2 ≥ 3,
    // --c-action-fg on --c-action ≥ 4.5.
    const src = read('Switch.tsx');
    expect(src).toMatch(/h-4 w-4 rounded-full bg-\[var\(--c-field-border\)\]/);
    expect(src).toContain('peer-checked:[&>span]:bg-[var(--c-action-fg)]');
  });
});

describe('UI-11: one disabled look', () => {
  const read = (name: string) => readFileSync(join(UI_SRC, 'components', name), 'utf8');

  test('the kit controls take the shared disabled classes, not their own opacity', () => {
    for (const name of ['Input.tsx', 'Textarea.tsx', 'Select.tsx', 'Button.tsx', 'pill.ts']) {
      const src = read(name);
      expect({
        name,
        shared: src.includes('disabledClass'),
        own: /disabled:opacity-|disabled \? 'opacity-/.test(src),
      }).toEqual({ name, shared: true, own: false });
    }
    // A labelled checkbox or switch dims once, on the label; the bare box
    // or track dims itself.
    for (const name of ['Checkbox.tsx', 'Switch.tsx']) {
      const src = read(name);
      expect({
        name,
        label: src.includes('disabled && disabledLook'),
        bare: src.includes("label === undefined && 'peer-disabled:opacity-50'"),
      }).toEqual({ name, label: true, bare: true });
    }
  });

  test('the element and the wrapper look are the same', () => {
    expect(disabledClass.replace(/disabled:/g, '')).toBe(disabledLook);
  });
});
