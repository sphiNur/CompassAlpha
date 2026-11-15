import { describe, expect, test } from 'bun:test';
import { closeMetricCents, metricChange, numberToCents } from '../closeCompare';

const close = {
  onlineRevenue: '1000.10',
  invoicedCashRevenue: '200.20',
  operatingExpenses: '50',
  wagesPaid: '25.5',
};

describe('closeCompare', () => {
  test('sums the filed figures in cents', () => {
    expect(closeMetricCents(close, 'totalRevenue')).toBe(120030n);
    expect(closeMetricCents(close, 'paidOutflows')).toBe(7550n);
    expect(closeMetricCents({ ...close, wagesPaid: 'x' }, 'paidOutflows')).toBeNull();
  });

  test('draft numbers become cents without float drift', () => {
    expect(numberToCents(0.1 + 0.2)).toBe(30n);
    expect(numberToCents(null)).toBeNull();
  });

  test('percent change and the unusual mark', () => {
    expect(metricChange(11000n, 10000n)).toEqual({
      percent: 10,
      deltaCents: 1000n,
      unusual: false,
    });
    expect(metricChange(6500n, 10000n)).toEqual({
      percent: -35,
      deltaCents: -3500n,
      unusual: true,
    });
    expect(metricChange(13000n, 10000n)?.unusual).toBe(true);
    expect(metricChange(12950n, 10000n)?.percent).toBe(30);
    expect(metricChange(10049n, 10000n)?.percent).toBe(0);
  });

  test('an earlier zero has no percent; both zero says nothing', () => {
    expect(metricChange(500n, 0n)).toEqual({ percent: null, deltaCents: 500n, unusual: true });
    expect(metricChange(0n, 0n)).toBeNull();
    expect(metricChange(null, 10n)).toBeNull();
  });
});
