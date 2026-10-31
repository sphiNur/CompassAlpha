import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * V3 / V7 / V8 / V9 (2026-10-30): the colour tokens are checked by
 * arithmetic, not by eye. Each text pair must clear WCAG 4.5:1 and each
 * field edge 3:1, in the light and the dark theme; every `var(--c-*)`
 * the app references must exist; the status components must not
 * hard-code colours that ignore the dark theme.
 */

const UI_SRC = join(import.meta.dir, '..');
const WEB_SRC = join(UI_SRC, '../../../apps/web/src');
const css = readFileSync(join(UI_SRC, 'tokens.css'), 'utf8');

function block(selectorStart: string): Record<string, string> {
  const at = css.indexOf(selectorStart);
  if (at < 0) throw new Error(`no block ${selectorStart}`);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('\n}', at));
  const out: Record<string, string> = {};
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    out[m[1]!] = m[2]!.trim();
  }
  return out;
}

const light = block(':root,\n:root[data-theme=');
const dark = { ...light, ...block(":root[data-theme='dark'],") };

type Rgba = [number, number, number, number];

/** CSS Color 4 oklch() → sRGB 0–255, out-of-gamut channels clipped. */
function oklch(value: string): Rgba {
  const m = /^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(value);
  if (!m) throw new Error(`not an oklch() colour: ${value}`);
  const L = Number(m[1]) / 100;
  const C = Number(m[2]);
  const h = (Number(m[3]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ];
  const enc = (x: number) => {
    const c = Math.min(1, Math.max(0, x));
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  };
  return [enc(lin[0]!), enc(lin[1]!), enc(lin[2]!), m[4] ? Number(m[4]) : 1];
}

function color(theme: Record<string, string>, name: string): Rgba {
  const v = theme[name];
  if (!v) throw new Error(`${name} is not defined`);
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(v);
  return ref ? color(theme, ref[1]!) : oklch(v);
}

const over = (top: Rgba, under: Rgba): Rgba => [
  top[0] * top[3] + under[0] * (1 - top[3]),
  top[1] * top[3] + under[1] * (1 - top[3]),
  top[2] * top[3] + under[2] * (1 - top[3]),
  1,
];

function luminance(c: Rgba): number {
  const f = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

function contrast(theme: Record<string, string>, fg: string, bg: string): number {
  const back = color(theme, bg);
  const a = luminance(over(color(theme, fg), back));
  const b = luminance(back);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

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
  test('subtle stays lighter-weight than muted', () => {
    // The three inks keep their order (fg > muted > subtle) after the tuning.
    expect(contrast(theme, '--c-fg-muted', '--c-surface')).toBeGreaterThan(
      contrast(theme, '--c-fg-subtle', '--c-surface'),
    );
  });
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : sources(p);
    return /\.(tsx?|css)$/.test(name) ? [p] : [];
  });
}

/**
 * Custom properties the app sets from JavaScript (no stylesheet declares
 * them; every reader has a fallback): the Telegram chrome insets measured
 * in Shell.tsx and the MainButton height (lib/mainButtonInset.ts).
 */
const RUNTIME_VARS = [
  '--app-chrome-reserve',
  '--app-chrome-safe-top',
  '--app-chrome-pad-left',
  '--app-chrome-pad-right',
  '--app-main-btn-h',
];

describe('colour tokens in use', () => {
  test('every var(--c-*) referenced by the web app and the UI kit is defined', () => {
    const used = new Set<string>();
    for (const file of [...sources(UI_SRC), ...sources(WEB_SRC)]) {
      for (const m of readFileSync(file, 'utf8').matchAll(/var\((--c-[a-z0-9-]+)/g)) used.add(m[1]!);
    }
    const missing = [...used].filter((name) => !(name in light));
    expect(missing).toEqual([]);
  });

  // N3 (2026-10-31): only `--c-*` was checked, so `--r-input` (never
  // defined) left one select square in an all-pill screen. Now every
  // custom property read anywhere — `var(--x)` or Tailwind's `[--x]` —
  // must be declared in a stylesheet, or be one the app writes at run time.
  test('every custom property referenced by the web app and the UI kit is defined', () => {
    const files = [...sources(UI_SRC), ...sources(WEB_SRC)].filter((f) => !f.includes('__tests__'));
    const declared = new Set<string>();
    const used = new Map<string, string>();
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      if (file.endsWith('.css')) {
        for (const m of src.matchAll(/(--[a-z0-9-]+)\s*:/g)) declared.add(m[1]!);
      }
      // A name followed by `-` or `*` is a prose pattern (`--app-chrome-pad-*`).
      for (const m of src.matchAll(/(?:var\(\s*|\[)(--[a-z0-9-]*[a-z0-9])(?![a-z0-9*-])/g)) {
        if (!used.has(m[1]!)) used.set(m[1]!, file.slice(file.indexOf('/src/') + 1));
      }
    }
    const missing = [...used]
      .filter(([name]) => !declared.has(name) && !RUNTIME_VARS.includes(name))
      .map(([name, file]) => `${name} (${file})`);
    expect(missing).toEqual([]);
  });

  test('each run-time custom property is really written by the app', () => {
    const code = [...sources(UI_SRC), ...sources(WEB_SRC)]
      .filter((f) => !f.includes('__tests__') && !f.endsWith('.css'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    for (const name of RUNTIME_VARS) {
      expect({ name, written: code.includes(`'${name}'`) }).toEqual({ name, written: true });
    }
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
    for (const name of ['Input.tsx', 'SearchInput.tsx', 'Select.tsx', 'NumberInput.tsx']) {
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

  test('no raw <input>, <select> or <textarea> in the web app is shorter than 44px', () => {
    const short: string[] = [];
    for (const file of sources(WEB_SRC)) {
      if (!file.endsWith('.tsx')) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<(input|select|textarea)\b/g)) {
        // The element's own attributes: up to its first className.
        const attrs = src.slice(m.index!, m.index! + 1200);
        const cls = /className="([^"]*)"/.exec(attrs)?.[1] ?? '';
        const type = /type="([a-z]+)"/.exec(attrs.slice(0, attrs.indexOf('className=')))?.[1];
        if (type && ['checkbox', 'radio', 'hidden', 'file'].includes(type)) continue;
        if (/(^|\s)(h-([0-9]|10)|py-1)(\s|$)/.test(cls)) {
          short.push(`${file.slice(WEB_SRC.length)}: ${cls}`);
        }
      }
    }
    expect(short).toEqual([]);
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
