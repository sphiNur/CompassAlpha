import { describe, expect, test } from 'bun:test';
import { canSeePricesIn } from '../pricesVisible';

describe('canSeePricesIn (D6 / RE-SHL-3)', () => {
  const mixed = {
    // Staff at A, manager at B: the flat union holds prices.view.
    permissions: ['order.draft', 'prices.view'],
    storePermissions: { a: ['order.draft'], b: ['order.draft', 'prices.view'] },
  };

  test('follows the selected store, not the union', () => {
    expect(canSeePricesIn(mixed, 'a')).toBe(false);
    expect(canSeePricesIn(mixed, 'b')).toBe(true);
  });

  test('cross-store pages and older sessions fall back to the union', () => {
    expect(canSeePricesIn(mixed, null)).toBe(true);
    expect(canSeePricesIn({ permissions: ['prices.view'] }, 'a')).toBe(true);
    expect(canSeePricesIn({ permissions: ['order.draft'] }, 'a')).toBe(false);
    expect(canSeePricesIn(null, 'a')).toBe(false);
  });
});
