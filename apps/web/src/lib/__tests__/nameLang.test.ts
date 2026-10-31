import { describe, expect, test } from 'bun:test';
import { nameLang, otherLang } from '../nameLang';

describe('nameLang (A11Y-3)', () => {
  test('the asked locale when the product has a name in it', () => {
    expect(nameLang({ zh: '牛肉', ru: 'Говядина' }, 'ru')).toBe('ru');
  });

  test('the fallback that pickName uses when it has not', () => {
    expect(nameLang({ en: 'Beef', ru: 'Говядина' }, 'uz')).toBe('en');
    expect(nameLang({ ru: 'Говядина', zh: '牛肉' }, 'uz')).toBe('ru');
  });

  test('nothing for a product without names', () => {
    expect(nameLang(null, 'zh')).toBeUndefined();
    expect(nameLang({}, 'zh')).toBeUndefined();
  });

  test('otherLang marks only a language that differs from the page', () => {
    expect(otherLang('zh', 'zh')).toBeUndefined();
    expect(otherLang('ru', 'zh')).toBe('ru');
    expect(otherLang(undefined, 'zh')).toBeUndefined();
  });
});
