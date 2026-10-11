import { describe, expect, test } from 'bun:test';
import { estimateLines, type SkuPriceStat, type SkuUsualPayment } from '../priceStats';

const stat = (skuId: string, price: number): [string, SkuPriceStat] => [
  skuId,
  {
    skuId,
    lastPrice: price,
    lastObservedAt: null,
    avg7d: price,
    avg30d: price,
    observations30d: 1,
  },
];

describe('estimateLines', () => {
  const stats = new Map([stat('apple', 10), stat('beef', 100), stat('salt', 5)]);
  const lines = [
    { skuId: 'apple', qty: 2 },
    { skuId: 'beef', qty: 1 },
    { skuId: 'salt', qty: 4 },
    { skuId: 'never-priced', qty: 9 },
  ];

  test('splits the total by how each product was last paid', () => {
    const usual: SkuUsualPayment = {
      // This store pays for beef by transfer; another store paid cash.
      byStoreSku: new Map([['s1:beef', 'transfer']]),
      bySku: new Map([
        ['beef', 'cash'],
        ['apple', 'transfer'],
      ]),
    };
    const est = estimateLines(lines, stats, { usual, storeId: 's1' });
    expect(est.total).toBe(140);
    // beef by this store's habit, apple by anyone's, salt never bought: cash.
    expect(est.transfer).toBe(120);
    expect(est.cash).toBe(20);
    expect(est.cash + est.transfer).toBe(est.total);
    expect(est.known).toBe(3);
    expect(est.unknown).toBe(1);
  });

  test('is all cash when nothing is known about payment', () => {
    const est = estimateLines(lines, stats);
    expect(est.cash).toBe(140);
    expect(est.transfer).toBe(0);
  });
});
