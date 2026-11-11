/**
 * Review TEST3-08 (2026-11-10): the name every product row shows had no
 * test; only nameLang, one helper of it, did.
 */
import { describe, expect, test } from 'bun:test';
import { pickName, productName, productNameParts, vendorLocale } from '../productName';

const BEEF = { zh: '牛肉', ru: 'Говядина', uz: 'Mol goʻshti', en: 'Beef' };

describe('pickName', () => {
  test('the name in the asked language', () => {
    expect(pickName(BEEF, 'uz')).toBe('Mol goʻshti');
    expect(pickName(BEEF, 'zh')).toBe('牛肉');
  });

  test('else English, Russian, Chinese, Uzbek, in that order', () => {
    expect(pickName({ ru: 'Говядина', en: 'Beef' }, 'uz')).toBe('Beef');
    expect(pickName({ zh: '牛肉', ru: 'Говядина' }, 'uz')).toBe('Говядина');
    expect(pickName({ uz: 'Mol goʻshti', zh: '牛肉' }, 'ru')).toBe('牛肉');
    expect(pickName({ uz: 'Mol goʻshti' }, 'en')).toBe('Mol goʻshti');
  });

  test('else a name in any other language, else a dash', () => {
    expect(pickName({ kk: 'Сиыр еті' }, 'zh')).toBe('Сиыр еті');
    expect(pickName({}, 'zh')).toBe('—');
    expect(pickName(null, 'zh')).toBe('—');
    expect(pickName(undefined, 'zh')).toBe('—');
  });
});

describe('productName', () => {
  test('one name without a second language', () => {
    expect(productName(BEEF, 'zh', null)).toBe('牛肉');
  });

  test('"Primary (Secondary)" with one', () => {
    expect(productName(BEEF, 'zh', 'uz')).toBe('牛肉 (Mol goʻshti)');
  });

  test('one name when the second language is the interface language', () => {
    expect(productName(BEEF, 'uz', 'uz')).toBe('Mol goʻshti');
  });

  test('one name when the product reads the same in both', () => {
    // Typed in English only: both languages fall back to the same name.
    expect(productName({ en: 'Lemon' }, 'zh', 'uz')).toBe('Lemon');
  });
});

describe('productNameParts', () => {
  test('the two names apart, so a row can put the second on its own line', () => {
    expect(productNameParts(BEEF, 'zh', 'uz')).toEqual({
      primary: '牛肉',
      secondary: 'Mol goʻshti',
      primaryLang: undefined,
      secondaryLang: 'uz',
    });
  });

  test('no second part where productName shows one name', () => {
    for (const [names, locale, secondary] of [
      [BEEF, 'zh', null],
      [BEEF, 'uz', 'uz'],
      [{ en: 'Lemon' }, 'zh', 'uz'],
    ] as const) {
      expect(productNameParts(names, locale, secondary).secondary).toBeNull();
    }
  });

  test('marks a name that is not in the interface language (A11Y-3)', () => {
    // A Chinese interface showing the English fallback says the name is en.
    expect(productNameParts({ en: 'Beef', ru: 'Говядина' }, 'zh', null)).toEqual({
      primary: 'Beef',
      secondary: null,
      primaryLang: 'en',
    });
    // The second name is marked against the interface, not against itself.
    expect(productNameParts({ zh: '牛肉', en: 'Beef' }, 'zh', 'uz').secondaryLang).toBe('en');
  });

  test('productName is the parts joined', () => {
    for (const secondary of [null, 'zh', 'uz', 'ru'] as const) {
      const parts = productNameParts(BEEF, 'en', secondary);
      const joined = parts.secondary ? `${parts.primary} (${parts.secondary})` : parts.primary;
      expect(productName(BEEF, 'en', secondary)).toBe(joined);
    }
  });
});

describe('vendorLocale', () => {
  test('the second language when the user set one, else the interface language', () => {
    expect(vendorLocale('zh', 'uz')).toBe('uz');
    expect(vendorLocale('zh', null)).toBe('zh');
    expect(vendorLocale('zh', 'zh')).toBe('zh');
  });
});
