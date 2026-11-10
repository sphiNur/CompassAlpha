import { describe, expect, test } from 'bun:test';
import { sumMoney } from '@compass/contracts';
import { estimateLines, type SkuPriceStat, type SkuUsualPayment } from '../priceStats';

const stat = (skuId: string, price: string): [string, SkuPriceStat] => [
  skuId,
  {
    skuId,
    lastPrice: price,
    lastObservedAt: null,
    avg7d: Number(price),
    avg30d: Number(price),
    observations30d: 1,
  },
];

describe('estimateLines', () => {
  test('goes by the last price paid, not the average of the week', () => {
    const moved = new Map<string, SkuPriceStat>([
      [
        'tomato',
        {
          skuId: 'tomato',
          lastPrice: '9.00',
          lastObservedAt: null,
          avg7d: 14,
          avg30d: 15,
          observations30d: 6,
        },
      ],
    ]);
    expect(estimateLines([{ skuId: 'tomato', qty: '10' }], moved).total).toBe('90.00');
  });

  test('rounds each line to cents, as the web does (ORD-01)', () => {
    // 0.5 × 2.01 = 1.005: the float product and toFixed said 1.00.
    const prices = new Map([stat('herb', '2.01')]);
    expect(estimateLines([{ skuId: 'herb', qty: '0.5' }], prices).total).toBe('1.01');
  });

  const stats = new Map([stat('apple', '10.00'), stat('beef', '100.00'), stat('salt', '5.00')]);
  const lines = [
    { skuId: 'apple', qty: '2' },
    { skuId: 'beef', qty: '1' },
    { skuId: 'salt', qty: '4' },
    { skuId: 'never-priced', qty: '9' },
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
    expect(est.total).toBe('140.00');
    // beef by this store's habit, apple by anyone's, salt never bought: cash.
    expect(est.transfer).toBe('120.00');
    expect(est.cash).toBe('20.00');
    expect(sumMoney([est.cash, est.transfer])).toBe(est.total);
    expect(est.known).toBe(3);
    expect(est.unknown).toBe(1);
  });

  test('is all cash when nothing is known about payment', () => {
    const est = estimateLines(lines, stats);
    expect(est.cash).toBe('140.00');
    expect(est.transfer).toBe('0.00');
  });
});
