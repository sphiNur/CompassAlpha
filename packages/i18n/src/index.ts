/**
 * Tiny ICU-aware i18n runtime.
 *
 * Catalogs are static objects — at build time we tree-shake unused locales.
 * Lookup falls back en → ru → zh → uz so missing translations degrade gracefully.
 *
 * For production-grade plural/select we'd swap the body of `format()` to
 * @formatjs/intl-messageformat, but for now we keep it dependency-free
 * with a simple `{name}` interpolation and `{n, plural, ...}` cases.
 */
import { catalogs, type Locale, type CatalogKey } from './catalogs/index';

export type { Locale, CatalogKey } from './catalogs/index';

const FALLBACK: Locale[] = ['en', 'ru', 'zh', 'uz'];

export function detectLocale(input: string | undefined | null): Locale {
  if (!input) return 'en';
  const lower = input.toLowerCase();
  if (lower.startsWith('zh')) return 'zh';
  if (lower.startsWith('ru')) return 'ru';
  if (lower.startsWith('uz')) return 'uz';
  if (lower.startsWith('en')) return 'en';
  return 'en';
}

export function lookup(key: CatalogKey, locale: Locale): string | undefined {
  const tried = new Set<Locale>();
  for (const l of [locale, ...FALLBACK]) {
    if (tried.has(l)) continue;
    tried.add(l);
    const v = (catalogs as Record<Locale, Record<string, string>>)[l]?.[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

export interface FormatVars {
  [key: string]: string | number | undefined;
}

export function format(key: CatalogKey, locale: Locale, vars: FormatVars = {}): string {
  void locale;
  let template = lookup(key, locale) ?? key;
  // M1 parser handles only simple `{name}` interpolation. The earlier
  // attempt at ICU plural (`{n, plural, one {…} other {…}}`) had a regex
  // that couldn't track nested braces and rendered garbage like
  // `0 0 other {# items}`. Until we swap in @formatjs/intl-messageformat
  // (M2), call sites must branch on count themselves and pass a final
  // string. As a safety net, strip any plural wrapper here so the user
  // never sees the raw template if it sneaks back in.
  template = stripPluralWrappers(template, vars);
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => String(vars[name] ?? ''));
}

/** Find each `{name, plural, …}` block (matching nested braces) and
 *  replace it with the raw count value. */
function stripPluralWrappers(input: string, vars: FormatVars): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    if (input[i] !== '{') {
      out += input[i++];
      continue;
    }
    // Walk to the matching close brace, counting nesting.
    const start = i;
    let depth = 0;
    let j = i;
    while (j < input.length) {
      const c = input[j]!;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
      j++;
    }
    if (depth !== 0) {
      // Unmatched — emit as-is and bail.
      out += input.slice(start);
      return out;
    }
    const block = input.slice(start, j);
    const m = block.match(/^\{\s*(\w+)\s*,\s*plural\s*,/);
    if (m) {
      out += String(vars[m[1]!] ?? '');
    } else {
      out += block;
    }
    i = j;
  }
  return out;
}

export interface I18n {
  locale: Locale;
  t: (key: CatalogKey, vars?: FormatVars) => string;
}

export function createI18n(locale: Locale): I18n {
  return {
    locale,
    t: (key, vars) => format(key, locale, vars),
  };
}
