import { describe, expect, test } from 'bun:test';
import { hasStorePermission } from '../storePermission';

describe('hasStorePermission (CONF-14)', () => {
  // Cashier at A; at B a store-level override denies sales.record.
  const session = {
    permissions: ['sales.record', 'settlement.record'],
    storePermissions: { a: ['sales.record', 'settlement.record'], b: ['settlement.record'] },
  };

  test('follows the store, not the union', () => {
    expect(hasStorePermission(session, 'a', 'sales.record')).toBe(true);
    expect(hasStorePermission(session, 'b', 'sales.record')).toBe(false);
  });

  test('a store missing from the map, no store, or an older session read the union', () => {
    expect(hasStorePermission(session, 'c', 'sales.record')).toBe(true);
    expect(hasStorePermission(session, null, 'sales.record')).toBe(true);
    expect(hasStorePermission({ permissions: ['sales.record'] }, 'b', 'sales.record')).toBe(true);
  });

  test('no session, no permission', () => {
    expect(hasStorePermission(null, 'a', 'sales.record')).toBe(false);
  });
});
