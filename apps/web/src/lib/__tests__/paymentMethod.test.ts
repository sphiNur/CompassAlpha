import { describe, expect, test } from 'bun:test';
import { paymentMethodOrCash } from '../paymentMethod';

describe('paymentMethodOrCash', () => {
  test('a recorded method is kept', () => {
    expect(paymentMethodOrCash('cash')).toBe('cash');
    expect(paymentMethodOrCash('transfer')).toBe('transfer');
  });

  test('a row from before methods were recorded is cash', () => {
    expect(paymentMethodOrCash(null)).toBe('cash');
    expect(paymentMethodOrCash(undefined)).toBe('cash');
    expect(paymentMethodOrCash('')).toBe('cash');
  });
});
