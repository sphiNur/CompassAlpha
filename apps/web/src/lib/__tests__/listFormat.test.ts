import { describe, expect, test } from 'bun:test';
import { formatList } from '../listFormat';

describe('formatList (COREWEB1-19)', () => {
  test('a list reads the way the language writes one', () => {
    expect(formatList(['店长', '员工'], 'zh')).toBe('店长和员工');
    expect(formatList(['店长', '员工', '收银员'], 'zh')).toBe('店长、员工和收银员');
    expect(formatList(['Manager', 'Staff', 'Cashier'], 'en')).toBe('Manager, Staff, and Cashier');
    expect(formatList(['Менеджер', 'Кассир'], 'ru')).toBe('Менеджер и Кассир');
  });

  test('one item is the item, and no items is nothing', () => {
    expect(formatList(['Manager'], 'en')).toBe('Manager');
    expect(formatList([], 'zh')).toBe('');
  });

  test('a WebView without Intl.ListFormat gets the language’s separator', () => {
    const intl = Intl as unknown as Record<string, unknown>;
    const saved = intl.ListFormat;
    intl.ListFormat = undefined;
    try {
      expect(formatList(['店长', '员工'], 'zh')).toBe('店长、员工');
      expect(formatList(['Менеджер', 'Кассир'], 'ru')).toBe('Менеджер, Кассир');
    } finally {
      intl.ListFormat = saved;
    }
  });
});
