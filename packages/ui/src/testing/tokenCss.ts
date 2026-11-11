/**
 * tokens.css read the way a browser reads it, for tests (review TEST4-14,
 * 2026-11-10). Exported as `@compass/ui/testing/tokenCss`, so a host's
 * tests can check what they use against the tokens without reaching into
 * this package's folders; this package's own tests no longer read the
 * host's sources.
 *
 * Node and Bun only (it reads files); never imported by app code.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** packages/ui/src. */
export const UI_SRC = join(import.meta.dir, '..');

/** The text of packages/ui/src/tokens.css. */
export const TOKENS_CSS: string = readFileSync(join(UI_SRC, 'tokens.css'), 'utf8');

/** Every .ts, .tsx and .css file under `dir`, node_modules left out. */
export function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : sources(p);
    return /\.(tsx?|css)$/.test(name) ? [p] : [];
  });
}

/** Every custom property a stylesheet declares (`--name:`). */
export function declaredProperties(cssText: string): Set<string> {
  return new Set([...cssText.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
}

/**
 * Every custom property a source reads, `var(--x)` or Tailwind's `[--x]`.
 * A name followed by `-` or `*` is a prose pattern (`--app-chrome-pad-*`).
 */
export function readProperties(source: string): string[] {
  return [...source.matchAll(/(?:var\(\s*|\[)(--[a-z0-9-]*[a-z0-9])(?![a-z0-9*-])/g)].map(
    (m) => m[1]!,
  );
}

/**
 * DX-VIS-4 / DX-IX-1 (2026-11-01): a small cascade over tokens.css for the
 * <html> element. It computes which declaration of a custom property wins
 * (media query, selector specificity, source order), the way the browser
 * does, so a selector that loses to `:root[data-theme='native']` fails
 * a test instead of silently in production.
 */
export type Rule = {
  selectors: string[];
  media: string | null;
  decls: Record<string, string>;
  order: number;
};

export function parseRules(source: string): Rule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let order = 0;
  const walk = (chunk: string, media: string | null) => {
    let i = 0;
    while (i < chunk.length) {
      const open = chunk.indexOf('{', i);
      if (open < 0) break;
      const prelude = chunk.slice(i, open).trim();
      // Find the matching close brace.
      let depth = 1;
      let j = open + 1;
      while (j < chunk.length && depth > 0) {
        if (chunk[j] === '{') depth++;
        else if (chunk[j] === '}') depth--;
        j++;
      }
      const body = chunk.slice(open + 1, j - 1);
      if (prelude.startsWith('@media')) walk(body, prelude.slice('@media'.length).trim());
      else if (!prelude.startsWith('@')) {
        const decls: Record<string, string> = {};
        for (const m of body.matchAll(/([a-z-]+|--[a-z0-9-]+)\s*:\s*([^;]+);/g))
          decls[m[1]!] = m[2]!.trim();
        rules.push({
          selectors: prelude.split(',').map((s) => s.trim()),
          media,
          decls,
          order: order++,
        });
      }
      i = j;
    }
  };
  walk(text, null);
  return rules;
}

/** Specificity of `:root` / `.class:pseudo` + attribute selectors on one element, as a single number. */
function specificity(selector: string): number {
  const classes = (selector.match(/\[[^\]]*\]|:[a-z-]+|\.[a-z0-9-]+/g) ?? []).length;
  return classes * 1000;
}

function matchesRoot(selector: string, attrs: Record<string, string>): boolean {
  const m = /^:root((?:\[[^\]]+\])*)$/.exec(selector);
  if (!m) return false;
  for (const a of m[1]!.matchAll(/\[([a-z-]+)(?:='([^']*)')?\]/g)) {
    const have = attrs[a[1]!];
    if (have === undefined) return false;
    if (a[2] !== undefined && have !== a[2]) return false;
  }
  return true;
}

/** The value of custom property `name` on <html> with `attrs`, or undefined. */
export function computedOnRoot(
  name: string,
  attrs: Record<string, string>,
  media: { reducedMotion: boolean },
  source: string = TOKENS_CSS,
): string | undefined {
  let best: { spec: number; order: number; value: string } | undefined;
  for (const rule of parseRules(source)) {
    if (rule.media && rule.media.includes('prefers-reduced-motion: reduce') && !media.reducedMotion)
      continue;
    if (rule.media && !rule.media.includes('prefers-reduced-motion')) continue;
    if (!(name in rule.decls)) continue;
    for (const sel of rule.selectors) {
      if (!matchesRoot(sel, attrs)) continue;
      const spec = specificity(sel);
      if (!best || spec > best.spec || (spec === best.spec && rule.order > best.order)) {
        best = { spec, order: rule.order, value: rule.decls[name]! };
      }
    }
  }
  return best?.value;
}

/**
 * Every custom property on <html> for one set of attributes, through the
 * cascade above. Review TEST4-15: this used to cut the light and dark
 * blocks out of the file by string offsets, so merging two selectors
 * threw "no block", and the apple theme was never measured.
 */
export function themeOf(
  attrs: Record<string, string>,
  source: string = TOKENS_CSS,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of parseRules(source)) {
    for (const name of Object.keys(rule.decls)) {
      if (!name.startsWith('--') || name in out) continue;
      const value = computedOnRoot(name, attrs, { reducedMotion: false }, source);
      if (value !== undefined) out[name] = value;
    }
  }
  return out;
}

export type Rgba = [number, number, number, number];

/** CSS Color 4 oklch() → sRGB 0–255, out-of-gamut channels clipped. */
export function oklch(value: string): Rgba {
  const m = /^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(value);
  if (!m) throw new Error(`not an oklch() colour: ${value}`);
  const L = Number(m[1]) / 100;
  const C = Number(m[2]);
  // eslint-disable-next-line no-restricted-syntax -- degrees to radians, not money
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

/** A colour token of `theme`, following `var(--other)` references. */
export function color(theme: Record<string, string>, name: string): Rgba {
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

/** WCAG relative luminance. */
export function luminance(c: Rgba): number {
  const f = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

/** WCAG contrast of token `fg` drawn over token `bg` in `theme`. */
export function contrast(theme: Record<string, string>, fg: string, bg: string): number {
  const back = color(theme, bg);
  const a = luminance(over(color(theme, fg), back));
  const b = luminance(back);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
