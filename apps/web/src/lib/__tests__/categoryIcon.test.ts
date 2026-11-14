import { describe, expect, test } from 'bun:test';
import { categoryIconKind } from '../categoryIcon';

describe('categoryIconKind', () => {
  test('reads every language', () => {
    expect(categoryIconKind({ en: 'Meat', zh: '肉类' })).toBe('meat');
    expect(categoryIconKind({ ru: 'Мясо' })).toBe('meat');
    expect(categoryIconKind({ uz: 'Goʻsht' })).toBe('meat');
    expect(categoryIconKind({ zh: '蔬菜' })).toBe('vegetables');
    expect(categoryIconKind({ en: 'Fruit' })).toBe('fruit');
    expect(categoryIconKind({ en: 'Dairy', zh: '乳制品' })).toBe('dairy');
    expect(categoryIconKind({ en: 'Kitchen Tools', zh: '厨房工具' })).toBe('tools');
    expect(categoryIconKind({ en: 'Linen', zh: '布草' })).toBe('linen');
    expect(categoryIconKind({ ru: 'Рыба и морепродукты' })).toBe('fish');
  });

  test('fish before meat, an unknown name a box', () => {
    expect(categoryIconKind({ zh: '鱼肉' })).toBe('fish');
    expect(categoryIconKind({ en: 'Perf cat 1' })).toBe('other');
    expect(categoryIconKind({ en: '', zh: null })).toBe('other');
  });
});
