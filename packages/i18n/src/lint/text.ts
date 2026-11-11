/**
 * Rules 2 and 5 of ./rules.ts on one text, for text outside the four
 * catalogs. Review DB-09 (2026-11-11): the product catalog and the dev
 * seed in packages/db are shown to people as they are written, and broke
 * both rules (ASCII apostrophes in Uzbek, half-width punctuation in
 * Chinese) with nothing to catch it.
 */
import { CJK } from './icu';

/**
 * Every apostrophe-like mark in Uzbek text that is not ʻ (U+02BB, after
 * o / g) or the tutuq belgisi ʼ (U+02BC, everywhere else).
 */
export function uzbekApostropheErrors(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/['‘’`ʻʼ]/g)) {
    const want = /[oOgG]/.test(text[m.index - 1] ?? '') ? 'ʻ' : 'ʼ';
    if (m[0] !== want) {
      const at = text.slice(Math.max(0, m.index - 8), m.index + 6);
      found.push(`"${at}" uses ${JSON.stringify(m[0])}, want ${want}`);
    }
  }
  return found;
}

/**
 * Half-width punctuation in Chinese text: ，：？！；（）, quotes 「」, the
 * ideographic full stop, … and ——. Text with no Chinese in it passes.
 */
export function chinesePunctuationErrors(text: string): string[] {
  const found: string[] = [];
  if (!CJK.test(text)) return found;
  for (const m of text.matchAll(/[,:;!?]/g)) {
    const prev = text.slice(0, m.index).trimEnd().slice(-1);
    const next = text
      .slice(m.index + 1)
      .trimStart()
      .slice(0, 1);
    if (CJK.test(prev) || CJK.test(next) || /[」）]/.test(prev)) {
      found.push(`half-width "${m[0]}"`);
    }
  }
  for (const m of text.matchAll(/\(([^()]*)\)/g)) {
    if (CJK.test(m[1]!)) found.push('half-width parentheses');
  }
  if (/["“”]/.test(text)) found.push('use 「」 instead of "" / “”');
  // TEST4-10 (2026-11-10): a full stop, an ellipsis and a single quote
  // written the English way. A dot before a letter or digit is a file
  // name or a number ({month}.xlsx, 1.5), and three are the ellipsis.
  if (/[㐀-鿿]\.(?![A-Za-z0-9.])/u.test(text)) found.push('half-width "."');
  if (/\.{3}/.test(text)) found.push('use … instead of ...');
  if (/'/.test(text)) found.push("use 「」 instead of '");
  if (/—/.test(text.replace(/——/g, ''))) found.push('use —— instead of a single dash');
  return found;
}
