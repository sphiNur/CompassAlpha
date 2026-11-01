import { describe, expect, test } from 'bun:test';
import { amendAddedFor, receivedTotal } from '../receivedLine';

describe('receiving line with a correction (DX-DLV-01)', () => {
  const corrections = [
    { kind: 'amendAdded', skuId: 'onion', storeId: 'CK', qty: '2' },
    { kind: 'priceAfterReceipt', skuId: 'onion', storeId: null },
    { kind: 'amendAdded', skuId: 'onion', storeId: 'RH', qty: '1' },
  ];

  test('finds the quantity added for this store and product', () => {
    expect(amendAddedFor(corrections, 'onion', 'CK')).toBe('2');
    expect(amendAddedFor(corrections, 'onion', 'RH')).toBe('1');
    expect(amendAddedFor(corrections, 'garlic', 'CK')).toBeNull();
  });

  test('adds exactly', () => {
    expect(receivedTotal('5', '2')).toBe('7');
    expect(receivedTotal('0.1', '0.2')).toBe('0.3');
  });
});
