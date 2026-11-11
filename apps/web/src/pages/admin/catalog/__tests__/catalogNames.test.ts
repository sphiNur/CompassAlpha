/**
 * Review ADM2-11: the catalog editors' names, one copy for categories,
 * products and dishes.
 */
import { describe, expect, test } from 'bun:test';
import { CATALOG_LOCALES, cleanNames, hasAnyName, namesForEdit } from '../catalogNames';

describe('catalog names', () => {
  test('the fields show Uzbek first', () => {
    expect([...CATALOG_LOCALES]).toEqual(['uz', 'ru', 'en', 'zh']);
  });

  test('a saved map opens with every language, blank where there is none', () => {
    expect(namesForEdit({ ru: 'Говядина' })).toEqual({ uz: '', ru: 'Говядина', en: '', zh: '' });
    expect(namesForEdit(null)).toEqual({ uz: '', ru: '', en: '', zh: '' });
  });

  test('saving trims and leaves the empty languages out', () => {
    expect(cleanNames({ uz: '  Mol goʻshti ', ru: '', en: '   ', zh: '牛肉' })).toEqual({
      uz: 'Mol goʻshti',
      zh: '牛肉',
    });
  });

  test('only the four languages are saved', () => {
    expect(cleanNames({ en: 'Beef', fr: 'Bœuf' })).toEqual({ en: 'Beef' });
  });

  test('one name in any language is enough', () => {
    expect(hasAnyName({ uz: '', ru: '', en: '', zh: '' })).toBe(false);
    expect(hasAnyName({ uz: ' ', ru: '', en: '', zh: '' })).toBe(false);
    expect(hasAnyName({ uz: '', ru: '', en: '', zh: '蔬菜' })).toBe(true);
  });
});
