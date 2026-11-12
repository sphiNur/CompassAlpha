/**
 * Review TEST3-08 (2026-11-10): the name every product row shows had no
 * test; only nameLang, one helper of it, did.
 */
import { describe, expect, test } from 'bun:test';
import {
  isNames,
  pickName,
  productName,
  productNameParts,
  productNamePartsOf,
  rowName,
  vendorLocale,
} from '../productName';

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

describe('productNamePartsOf (RUNWEB1-07/09)', () => {
  test('the same item gives the same object, so a memo()d row does not draw again', () => {
    const namer = productNamePartsOf('en', 'ru');
    const beef = { names: BEEF };
    const first = namer(beef);
    expect(first).toEqual({ primary: 'Beef', secondary: 'Говядина', secondaryLang: 'ru' });
    expect(namer(beef)).toBe(first);
  });

  test('another item with the same names is named on its own', () => {
    const namer = productNamePartsOf('en', 'ru');
    const a = namer({ names: BEEF });
    const b = namer({ names: BEEF });
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
  });

  test('a namer for other languages names the item in them', () => {
    const beef = { names: BEEF };
    expect(productNamePartsOf('en', 'ru')(beef).secondary).toBe('Говядина');
    expect(productNamePartsOf('en', 'uz')(beef).secondary).toBe('Mol goʻshti');
    expect(productNamePartsOf('en', null)(beef)).toEqual({ primary: 'Beef', secondary: null });
  });
});

describe('vendorLocale', () => {
  test('the second language when the user set one, else the interface language', () => {
    expect(vendorLocale('zh', 'uz')).toBe('uz');
    expect(vendorLocale('zh', null)).toBe('zh');
    expect(vendorLocale('zh', 'zh')).toBe('zh');
  });
});

// Review RUNWEB1-09: a row's name, two lines (UI-4), the same object each
// time so a memo()'d row holds (RUNWEB1-07). Moved with rowName from the
// runs page (COREWEB2-18).
describe('rowName', () => {
  const UNKNOWN = 'Unknown product';

  test("a known product: its name, the stall's language on a second line", () => {
    const parts = productNamePartsOf('en', 'ru');
    const beef = { names: { en: 'Beef', ru: 'Говядина' } };
    const name = rowName(parts, beef, UNKNOWN);
    expect(name).toEqual({ primary: 'Beef', secondary: 'Говядина', secondaryLang: 'ru' });
    expect(rowName(parts, beef, UNKNOWN)).toBe(name);
  });

  test('a product the catalog has not loaded: "unknown product", the same object each time', () => {
    // RUNWEB1-38: not the start of its id.
    const parts = productNamePartsOf('en', 'ru');
    const name = rowName(parts, undefined, UNKNOWN);
    expect(name).toEqual({ primary: UNKNOWN, secondary: null });
    expect(rowName(parts, null, UNKNOWN)).toBe(name);
  });
});

describe('isNames', () => {
  test('an object of texts, an empty one included', () => {
    expect(isNames(BEEF)).toBe(true);
    expect(isNames({})).toBe(true);
  });

  test('not a list, not null, not an object holding anything but text', () => {
    expect(isNames(null)).toBe(false);
    expect(isNames(undefined)).toBe(false);
    expect(isNames('Beef')).toBe(false);
    expect(isNames(['Beef'])).toBe(false);
    expect(isNames({ en: 'Beef', ru: null })).toBe(false);
    expect(isNames({ en: { text: 'Beef' } })).toBe(false);
  });
});
