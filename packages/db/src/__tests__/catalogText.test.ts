/**
 * Review DB-09 (2026-11-11): the product catalog (imported into
 * production by import-catalog) and the dev seed are shown to people as
 * written, so they follow the language rules the interface catalogs do:
 * Uzbek writes ʻ / ʼ, not ASCII apostrophes, and Chinese uses full-width
 * punctuation. Twenty-two Uzbek names and nineteen Chinese ones broke
 * them, with nothing to catch it.
 */
import { describe, expect, test } from 'bun:test';
import { chinesePunctuationErrors, uzbekApostropheErrors } from '@compass/i18n/lint/text';
import { CATEGORIES, SKUS } from '../catalog-uzbek';
import { DEV_CATEGORIES, DEV_SKUS } from '../seed-data';

type Lang = 'zh' | 'en' | 'ru' | 'uz';
type PerLang<T> = Partial<Record<Lang, T>>;
interface Row {
  code?: string;
  slug?: string;
  names: PerLang<string>;
  aliases?: PerLang<string[]>;
  description?: PerLang<string>;
}

/** Every text of one language in the rows, with where it is. */
function textsOf(source: string, rows: readonly Row[], lang: Lang): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const row of rows) {
    const where = `${source} ${row.code ?? row.slug}`;
    const name = row.names[lang];
    if (name) found.push([`${where} names`, name]);
    for (const alias of row.aliases?.[lang] ?? []) found.push([`${where} aliases`, alias]);
    const note = row.description?.[lang];
    if (note) found.push([`${where} description`, note]);
  }
  return found;
}

const SOURCES: Array<[string, readonly Row[]]> = [
  ['catalog category', CATEGORIES],
  ['catalog product', SKUS],
  ['dev seed category', DEV_CATEGORIES],
  ['dev seed product', DEV_SKUS],
];

function problems(lang: Lang, check: (text: string) => string[]): string[] {
  return SOURCES.flatMap(([source, rows]) =>
    textsOf(source, rows, lang).flatMap(([where, text]) =>
      check(text).map((problem) => `${where}: ${problem}`),
    ),
  );
}

describe('catalog and dev seed text', () => {
  test('there is text to check', () => {
    expect(textsOf('catalog product', SKUS, 'uz').length).toBeGreaterThan(100);
    expect(textsOf('catalog product', SKUS, 'zh').length).toBeGreaterThan(100);
    expect(textsOf('dev seed product', DEV_SKUS, 'uz').length).toBeGreaterThan(10);
  });

  test('Uzbek: oʻ / gʻ with U+02BB, the tutuq belgisi U+02BC elsewhere', () => {
    expect(uzbekApostropheErrors("Go'sht")).toHaveLength(1);
    expect(problems('uz', uzbekApostropheErrors)).toEqual([]);
  });

  test('Chinese: full-width punctuation', () => {
    expect(chinesePunctuationErrors('抓饭专用,比红萝卜甜')).toHaveLength(1);
    expect(problems('zh', chinesePunctuationErrors)).toEqual([]);
  });
});
