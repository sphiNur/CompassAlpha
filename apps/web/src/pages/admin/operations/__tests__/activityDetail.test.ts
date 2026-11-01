import { describe, expect, test } from 'bun:test';
import { activityDetail } from '../activityDetail';

const fmt = {
  productName: (names: Record<string, string>) => names.en ?? '',
  qty: (v: string) => String(Number(v)),
  day: (d: string) => `<${d}>`,
  orderOf: (date: string) => `order of ${date}`,
  runLabel: (date: string, n: number) => `run ${date} #${n}`,
};
const empty = {
  storeName: null,
  orderDate: null,
  runDate: null,
  runIndex: null,
  skuNames: null,
  qty: null,
};

describe('activityDetail (DX-CAT-2)', () => {
  test('an order line change names the product, quantity, store and order', () => {
    expect(
      activityDetail(
        {
          ...empty,
          skuNames: { en: 'Tomato' },
          qty: '2.500',
          storeName: 'Store 1',
          orderDate: '2026-11-01',
        },
        fmt,
      ),
    ).toBe('Tomato 2.5 · Store 1 · order of <2026-11-01>');
  });

  test('a run event names the run with its 1-based number', () => {
    expect(activityDetail({ ...empty, runDate: '2026-10-31', runIndex: 0 }, fmt)).toBe(
      'run <2026-10-31> #1',
    );
  });

  test('nothing known, nothing shown', () => {
    expect(activityDetail(null, fmt)).toBe('');
    expect(activityDetail(empty, fmt)).toBe('');
  });
});
