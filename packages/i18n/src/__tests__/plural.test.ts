/**
 * Plural-selection tests (2026-07-30).
 *
 * These exist because the bug they cover was invisible for months. `format()`
 * used to find each `{n, plural, ...}` block and replace the WHOLE block with
 * the bare count — a "safety net" from an earlier regex attempt that rendered
 * garbage. 24 keys in en, 20 in ru and 8 in uz were authored in ICU plural
 * form anyway, so every one of them silently lost its noun:
 *
 *     approval.contributorsCount  n=3  ->  "3"   (not "3 contributors")
 *     run.label.itemsHint         n=7  ->  "7 · x"
 *
 * zh has zero plural blocks — Chinese doesn't inflect for number — which is
 * precisely why nobody noticed: the primary locale looked perfect while the
 * English and Russian UI dropped plural nouns everywhere.
 *
 * So: assert on real catalog keys, in every locale we ship, including
 * Russian's three-way one/few/other split. A regression here means user-facing
 * copy degrades silently again.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import { createI18n, loadCatalog, format } from '../index';
import type { CatalogKey } from '../index';

beforeAll(async () => {
  await Promise.all([
    loadCatalog('en'),
    loadCatalog('zh'),
    loadCatalog('ru'),
    loadCatalog('uz'),
  ]);
});

describe('plural selection — English', () => {
  const t = (key: string, n: number) =>
    createI18n('en').t(key as CatalogKey, { n });

  test('picks singular for 1 and plural otherwise', () => {
    expect(t('approval.contributorsCount', 1)).toBe('1 contributor');
    expect(t('approval.contributorsCount', 2)).toBe('2 contributors');
    expect(t('approval.contributorsCount', 11)).toBe('11 contributors');
  });

  test('keeps surrounding text and other placeholders intact', () => {
    expect(
      createI18n('en').t('run.label.skuCountAndQty' as CatalogKey, {
        n: 1,
        qty: '3 kg',
      }),
    ).toBe('1 product · 3 kg');
    expect(
      createI18n('en').t('run.label.skuCountAndQty' as CatalogKey, {
        n: 7,
        qty: '3 kg',
      }),
    ).toBe('7 products · 3 kg');
  });

  test('a plural block mid-sentence leaves the rest of the sentence alone', () => {
    const one = createI18n('en').t('ops.purge.cascadeBody' as CatalogKey, { n: 1 });
    const many = createI18n('en').t('ops.purge.cascadeBody' as CatalogKey, { n: 3 });
    expect(one).toContain('its 1 attached order.');
    expect(many).toContain('its 3 attached orders.');
    // The tail after the plural block must survive in both.
    expect(one).toContain('use the per-order purge');
    expect(many).toContain('use the per-order purge');
  });
});

describe('plural selection — Russian three-way split', () => {
  const t = (key: string, n: number) =>
    createI18n('ru').t(key as CatalogKey, { n });

  test('one / few / many / other are selected per CLDR', () => {
    // одна роль (one) / две роли (few) / пять ролей (many)
    expect(t('people.toastRolesRevoked', 1)).toBe('отозвана 1 роль');
    expect(t('people.toastRolesRevoked', 2)).toBe('отозвано 2 роли');
    expect(t('people.toastRolesRevoked', 7)).toBe('отозвано 7 ролей');
  });

  test('21 takes the `one` form, 5 and 11 take `many`', () => {
    // Russian: 21 ends in 1 (but not 11) -> one; 5 and 11 -> many.
    expect(t('approval.contributorsCount', 21)).toBe('21 автор заказа');
    expect(t('approval.contributorsCount', 5)).toBe('5 авторов заказа');
    expect(t('approval.contributorsCount', 11)).toBe('11 авторов заказа');
  });

  test('a fraction takes `other`, which reads like `few`', () => {
    // 1.5 позиции, not 1.5 позиций: CLDR puts fractions in `other`.
    expect(t('run.label.itemsCount', 1.5)).toBe('1.5 позиции');
    expect(t('run.label.itemsCount', 5)).toBe('5 позиций');
  });

  test('a count in the middle of a sentence agrees with its noun', () => {
    expect(t('run.sessions.meta', 2)).toBe('2 заказа');
    expect(t('run.sessions.meta', 5)).toBe('5 заказов');
    expect(t('run.history.lastDays', 1)).toBe('Последний 1 день');
    expect(t('run.history.lastDays', 3)).toBe('Последние 3 дня');
  });
});

describe('plural selection — locales without number inflection', () => {
  test('zh renders the same noun for every count', () => {
    const t = (n: number) =>
      createI18n('zh').t('approval.contributorsCount' as CatalogKey, { n });
    expect(t(1)).toBe('1 位提交人');
    expect(t(9)).toBe('9 位提交人');
  });

  test('uz selects its two authored forms', () => {
    const t = (n: number) =>
      createI18n('uz').t('approval.contributorsCount' as CatalogKey, { n });
    expect(t(1)).toBe('1 yuboruvchi');
    expect(t(4)).toBe('4 ta yuboruvchi');
  });
});

describe('plural parser edge cases', () => {
  // These go through `format` with a synthetic template rather than a catalog
  // key, so they document the parser contract independently of the copy.
  const fmt = (tpl: string, vars: Record<string, string | number>) => {
    // `format` looks the key up first; an unknown key falls back to the key
    // itself, which lets us feed a raw template through the same code path.
    return format(tpl as CatalogKey, 'en', vars);
  };

  test('exact =N wins over the category form', () => {
    const tpl = '{n, plural, =0 {nothing} =1 {just one} other {# things}}';
    expect(fmt(tpl, { n: 0 })).toBe('nothing');
    expect(fmt(tpl, { n: 1 })).toBe('just one');
    expect(fmt(tpl, { n: 4 })).toBe('4 things');
  });

  test('# is replaced with the count inside the chosen case only', () => {
    expect(fmt('{n, plural, one {# item} other {# items}}', { n: 3 })).toBe('3 items');
  });

  test('nested {var} inside a case body still interpolates', () => {
    const tpl = '{n, plural, one {1 of {total}} other {# of {total}}}';
    expect(fmt(tpl, { n: 1, total: 9 })).toBe('1 of 9');
    expect(fmt(tpl, { n: 5, total: 9 })).toBe('5 of 9');
  });

  test('missing `other` renders empty rather than throwing', () => {
    expect(fmt('{n, plural, =1 {one}}', { n: 3 })).toBe('');
  });

  test('an unmatched brace does not hang or throw', () => {
    // The walker bails and emits the remainder verbatim.
    expect(() => fmt('{n, plural, one {x} other {y}', { n: 1 })).not.toThrow();
  });

  test('a plain placeholder is untouched by the plural pass', () => {
    expect(fmt('hello {name}', { name: 'world' })).toBe('hello world');
  });

  test('a missing count variable is treated as 0', () => {
    expect(fmt('{n, plural, =0 {none} other {# x}}', {})).toBe('none');
  });
});

describe('label: value pairs', () => {
  // RE-COPY-7: code used to glue `${label}: ${value}`, so Chinese read
  // 「支付方式: 现金」 with a half-width colon.
  test('each language brings its own colon', () => {
    const vars = { label: 'X', value: 'Y' };
    expect(createI18n('zh').t('common.labelValue' as CatalogKey, vars)).toBe('X：Y');
    expect(createI18n('en').t('common.labelValue' as CatalogKey, vars)).toBe('X: Y');
    expect(createI18n('ru').t('common.labelValue' as CatalogKey, vars)).toBe('X: Y');
  });
});
