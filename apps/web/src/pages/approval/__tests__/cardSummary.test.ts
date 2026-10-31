import { describe, expect, test } from 'bun:test';
import { cardRequests, showPaymentSplit } from '../cardSummary';

describe('approval card header', () => {
  test('CMP-APR-6: no split when one side is zero ("0.00" is a truthy string)', () => {
    expect(showPaymentSplit('120000.00', '0.00')).toBe(false);
    expect(showPaymentSplit('0', '50000')).toBe(false);
    expect(showPaymentSplit(null, '50000')).toBe(false);
    expect(showPaymentSplit('120000.00', '50000.00')).toBe(true);
  });

  test('CMP-APR-7: other items and the note are counted apart', () => {
    expect(cardRequests('', [{ name: 'a' }, { name: 'b' }])).toEqual({ extras: 2, hasNote: false });
    expect(cardRequests('please call', [])).toEqual({ extras: 0, hasNote: true });
    expect(cardRequests('   ', null)).toEqual({ extras: 0, hasNote: false });
    expect(cardRequests('x', [{ name: 'a' }])).toEqual({ extras: 1, hasNote: true });
  });
});
